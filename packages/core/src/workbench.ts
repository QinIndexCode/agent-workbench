import type {
  ApprovalDecision,
  ExperienceRecord,
  SkillRecord,
  TaskDetail,
  TaskEvent,
  ToolApproval,
  ToolCall
} from "@scc/shared";
import { createExperience, promoteExperience } from "./experience.js";
import { FallbackModelClient, type ModelClient } from "./fallback-model.js";
import { createId, nowIso } from "./ids.js";
import { PermissionEngine, type PermissionState } from "./permission-engine.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { ShellToolExecutor, type ToolExecutor } from "./tools.js";

export interface AgentWorkbenchOptions {
  store?: WorkbenchStore;
  model?: ModelClient;
  tools?: ToolExecutor;
}

export class AgentWorkbench {
  private readonly store: WorkbenchStore;
  private readonly model: ModelClient;
  private readonly tools: ToolExecutor;
  private readonly permissions = new PermissionEngine();
  private readonly permissionState = new Map<string, PermissionState>();

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
  }

  async createTask(goal: string, title = goal.slice(0, 72)): Promise<TaskDetail> {
    const task = this.emptyTask(title);
    this.addEvent(task, "task_created", "Task created");
    this.addEvent(task, "user_message", goal);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return this.step(task.id);
  }

  async listTasks(): Promise<TaskDetail[]> {
    return this.store.listTasks();
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    return this.store.getTask(taskId);
  }

  async appendMessage(taskId: string, content: string): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    if (task.status === "running" || task.status === "waiting_approval") {
      this.addEvent(task, "guidance_pending", content, { status: "pending" });
      await this.store.saveTask(task);
      return task;
    }
    this.addEvent(task, "user_message", content);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return this.step(task.id);
  }

  async control(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    if (action === "pause") this.setStatus(task, "paused");
    if (action === "cancel") this.setStatus(task, "cancelled");
    if (action === "resume") this.setStatus(task, "running");
    await this.store.saveTask(task);
    return action === "resume" ? this.step(task.id) : task;
  }

  async decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    const approval = task.approvals.find((item) => item.id === approvalId && item.status === "pending");
    if (!approval) throw new Error(`Pending approval not found: ${approvalId}`);

    approval.status = decision === "deny" ? "denied" : "approved";
    approval.decidedAt = nowIso();
    if (decision === "allow_for_task") {
      this.stateFor(task.id).allowedForTask.add(approval.riskCategory);
    }
    this.addEvent(task, "approval_resolved", `${approval.toolCall.toolName}: ${decision}`, {
      approvalId,
      decision,
      riskCategory: approval.riskCategory
    });

    if (decision === "deny") {
      this.setStatus(task, "running");
      await this.store.saveTask(task);
      return this.step(task.id);
    }

    const result = await this.tools.execute(approval.toolCall);
    this.addEvent(task, "tool_result", result.ok ? "Tool completed" : "Tool failed", {
      toolCallId: result.toolCallId,
      ok: result.ok,
      output: result.output
    });
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return this.step(task.id);
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return this.store.listExperiences();
  }

  async listSkills(): Promise<SkillRecord[]> {
    return this.store.listSkills();
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    return this.store.getSkill(skillId);
  }

  async updateSkillStatus(skillId: string, status: SkillRecord["status"]): Promise<SkillRecord> {
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    const updated = { ...skill, status };
    await this.store.saveSkill(updated);
    return updated;
  }

  async promoteExperience(experienceId: string): Promise<SkillRecord> {
    const experience = (await this.store.listExperiences()).find((item) => item.id === experienceId);
    if (!experience) throw new Error(`Experience not found: ${experienceId}`);
    const skill = promoteExperience(experience);
    await this.store.saveSkill(skill);
    return skill;
  }

  private async step(taskId: string): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    if (task.status !== "running") return task;

    this.consumePendingGuidance(task);
    const turn = await this.model.next(task);
    if (turn.kind === "final") {
      this.addEvent(task, "assistant_message", turn.message);
      this.setStatus(task, "completed");
      await this.recordExperience(task);
      await this.store.saveTask(task);
      return task;
    }

    for (const call of turn.calls) {
      const assessment = this.permissions.assess(call.toolName, call.args);
      this.addEvent(task, "tool_requested", call.toolName, {
        toolCallId: call.id,
        toolName: call.toolName,
        args: call.args,
        riskCategory: assessment.category
      });

      if (this.permissions.needsApproval(assessment.category, this.stateFor(task.id))) {
        const approval = this.permissions.createApproval({ taskId: task.id, toolCall: call, assessment });
        task.approvals.push(approval);
        this.addApprovalPendingEvent(task, approval);
        this.setStatus(task, "waiting_approval");
        await this.store.saveTask(task);
        return task;
      }

      const result = await this.tools.execute(call);
      this.addEvent(task, "tool_result", result.ok ? "Tool completed" : "Tool failed", {
        toolCallId: result.toolCallId,
        ok: result.ok,
        output: result.output
      });
    }

    await this.store.saveTask(task);
    return this.step(task.id);
  }

  private async recordExperience(task: TaskDetail): Promise<void> {
    const experience = createExperience(task);
    const skill = promoteExperience(experience);
    await this.store.saveExperience(experience);
    await this.store.saveSkill(skill);
    this.addEvent(task, "experience_recorded", experience.title, { experienceId: experience.id });
    this.addEvent(task, "skill_promoted", skill.title, { skillId: skill.id, status: skill.status });
  }

  private emptyTask(title: string): TaskDetail {
    const id = createId("task");
    const now = nowIso();
    return {
      id,
      title,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      events: [],
      approvals: [],
      pendingGuidance: []
    };
  }

  private addApprovalPendingEvent(task: TaskDetail, approval: ToolApproval): void {
    this.addEvent(task, "approval_pending", `${approval.riskCategory}: ${approval.toolCall.toolName}`, {
      approvalId: approval.id,
      toolName: approval.toolCall.toolName,
      args: approval.toolCall.args,
      riskCategory: approval.riskCategory,
      reason: approval.reason
    });
  }

  private consumePendingGuidance(task: TaskDetail): void {
    for (const event of task.events) {
      if (event.type === "guidance_pending" && event.payload["status"] === "pending") {
        event.payload["status"] = "consumed";
        this.addEvent(task, "guidance_consumed", event.summary, { sourceEventId: event.id });
      }
    }
    task.pendingGuidance = task.events.filter(
      (event) => event.type === "guidance_pending" && event.payload["status"] === "pending"
    );
  }

  private setStatus(task: TaskDetail, status: TaskDetail["status"]): void {
    if (task.status !== status) {
      task.status = status;
      this.addEvent(task, "status_changed", status);
    }
  }

  private addEvent(
    task: TaskDetail,
    type: TaskEvent["type"],
    summary: string,
    payload: Record<string, unknown> = {}
  ): void {
    task.events.push({
      id: createId("event"),
      taskId: task.id,
      type,
      summary,
      payload,
      createdAt: nowIso()
    });
    task.updatedAt = nowIso();
    task.pendingGuidance = task.events.filter(
      (event) => event.type === "guidance_pending" && event.payload["status"] === "pending"
    );
  }

  private async requiredTask(taskId: string): Promise<TaskDetail> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private stateFor(taskId: string): PermissionState {
    const existing = this.permissionState.get(taskId);
    if (existing) return existing;
    const created: PermissionState = { allowedForTask: new Set() };
    this.permissionState.set(taskId, created);
    return created;
  }
}
