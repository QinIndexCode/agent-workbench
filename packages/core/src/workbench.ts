import type {
  ApprovalDecision,
  ExperienceRecord,
  GlobalPermissionGrant,
  PatternRecord,
  PreferencesPatch,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ReflectionSession,
  RiskCategory,
  SkillRecord,
  TaskDetail,
  TaskEvent,
  ToolApproval,
  ToolCall
} from "@scc/shared";
import { ContextAssembler } from "./context-assembler.js";
import { createExperience, createTaskMemory, promoteExperience, reflectMemories } from "./experience.js";
import { FallbackModelClient, type ModelClient } from "./fallback-model.js";
import { createId, nowIso } from "./ids.js";
import { PermissionEngine, type PermissionState } from "./permission-engine.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { ShellToolExecutor, type ToolExecutor } from "./tools.js";

export interface AgentWorkbenchOptions {
  store?: WorkbenchStore;
  model?: ModelClient;
  tools?: ToolExecutor;
  contextAssembler?: ContextAssembler;
}

export class AgentWorkbench {
  private readonly store: WorkbenchStore;
  private readonly model: ModelClient;
  private readonly tools: ToolExecutor;
  private readonly contextAssembler: ContextAssembler;
  private readonly permissions = new PermissionEngine();
  private readonly permissionState = new Map<string, PermissionState>();

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(this.store);
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
    if (decision === "allow_globally") {
      await this.store.saveGlobalPermission(this.createGlobalGrant(approval.riskCategory, approval.reason));
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
      toolName: approval.toolCall.toolName,
      args: approval.toolCall.args,
      ok: result.ok,
      output: result.output
    });
    this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(task.events[task.events.length - 1]!);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return this.step(task.id);
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return this.store.listExperiences();
  }

  async listTaskMemories() {
    return this.store.listTaskMemories();
  }

  async listPatterns(): Promise<PatternRecord[]> {
    return this.store.listPatterns();
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

  async correctSkill(skillId: string, input: { reason: string; revisedBody: string }): Promise<SkillRecord> {
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    const updated: SkillRecord = {
      ...skill,
      body: input.revisedBody,
      version: skill.version + 1,
      updatedAt: nowIso(),
      corrections: [
        ...skill.corrections.slice(-9),
        {
          id: createId("correction"),
          type: "user",
          reason: input.reason,
          originalBody: skill.body,
          revisedBody: input.revisedBody,
          createdAt: nowIso()
        }
      ]
    };
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

  async listGlobalPermissions(): Promise<GlobalPermissionGrant[]> {
    return this.store.listGlobalPermissions();
  }

  async grantGlobalPermission(riskCategory: RiskCategory, reason?: string): Promise<GlobalPermissionGrant> {
    const grant = this.createGlobalGrant(riskCategory, reason);
    await this.store.saveGlobalPermission(grant);
    return grant;
  }

  async revokeGlobalPermission(riskCategory: RiskCategory): Promise<void> {
    await this.store.deleteGlobalPermission(riskCategory);
  }

  async getPreferences() {
    return this.store.getPreferences();
  }

  async updatePreferences(patch: PreferencesPatch) {
    const current = await this.store.getPreferences();
    const next = { ...current, updatedAt: nowIso() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    await this.store.savePreferences(next);
    return next;
  }

  async runReflection(): Promise<ReflectionSession> {
    const result = reflectMemories(await this.store.listTaskMemories(), await this.store.listPatterns());
    await this.store.saveReflectionSession(result.session);
    for (const pattern of result.patterns) await this.store.savePattern(pattern);
    for (const skill of result.promotedSkills) await this.store.saveSkill(skill);
    return result.session;
  }

  async listReflectionSessions(): Promise<ReflectionSession[]> {
    return this.store.listReflectionSessions();
  }

  async listProjectMemories(projectId?: string): Promise<ProjectMemory[]> {
    return this.store.listProjectMemories(projectId);
  }

  async createProjectMemory(input: ProjectMemoryCreateRequest): Promise<ProjectMemory> {
    const now = nowIso();
    const memory: ProjectMemory = {
      id: createId("project_memory"),
      projectId: input.projectId,
      title: input.title,
      content: input.content,
      category: input.category,
      tags: input.tags,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveProjectMemory(memory);
    return memory;
  }

  async deleteProjectMemory(id: string): Promise<void> {
    await this.store.deleteProjectMemory(id);
  }

  private async step(taskId: string): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    if (task.status !== "running") return task;

    this.consumePendingGuidance(task);
    const turn = await this.safeModelNext(task);
    if (!turn) return task;
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

      const globalGrants = await this.store.listGlobalPermissions();
      if (this.permissions.isGloballyAllowed(assessment.category, globalGrants)) {
        this.addEvent(task, "approval_auto_granted", `${assessment.category}: global permission`, {
          toolCallId: call.id,
          toolName: call.toolName,
          riskCategory: assessment.category
        });
      } else if (this.permissions.needsApproval(assessment.category, this.stateFor(task.id))) {
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
        toolName: call.toolName,
        args: call.args,
        ok: result.ok,
        output: result.output
      });
      this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(task.events[task.events.length - 1]!);
    }

    await this.store.saveTask(task);
    return this.step(task.id);
  }

  private async recordExperience(task: TaskDetail): Promise<void> {
    const experience = createExperience(task);
    const memory = createTaskMemory(task);
    const skill = promoteExperience(experience);
    await this.store.saveExperience(experience);
    await this.store.saveTaskMemory(memory);
    await this.store.saveSkill(skill);
    this.addEvent(task, "task_memory_created", memory.title, { memoryId: memory.id });
    this.addEvent(task, "skill_promoted", skill.title, { skillId: skill.id, status: skill.status });
    if ((await this.store.getPreferences()).reflectionEnabled) {
      const reflection = reflectMemories(await this.store.listTaskMemories(), await this.store.listPatterns());
      await this.store.saveReflectionSession(reflection.session);
      for (const pattern of reflection.patterns) {
        await this.store.savePattern(pattern);
        this.addEvent(task, "pattern_discovered", pattern.title, { patternId: pattern.id, status: pattern.status });
      }
      for (const promoted of reflection.promotedSkills) await this.store.saveSkill(promoted);
      this.addEvent(task, "reflection_completed", reflection.session.progress.phase, { sessionId: reflection.session.id });
    }
    this.contextAssembler.cleanupTask(task.id);
  }

  private async safeModelNext(task: TaskDetail): Promise<Awaited<ReturnType<ModelClient["next"]>> | null> {
    try {
      return await this.model.next(task);
    } catch (error) {
      const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
      this.addEvent(task, "assistant_message", `Model provider failed: ${message}`);
      this.setStatus(task, "failed");
      await this.store.saveTask(task);
      return null;
    }
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

  private createGlobalGrant(riskCategory: RiskCategory, reason?: string): GlobalPermissionGrant {
    return {
      id: createId("global_permission"),
      riskCategory,
      grantedAt: nowIso(),
      grantedBy: "user",
      ...(reason ? { reason } : {})
    };
  }
}

function sanitizeProviderError(input: string): string {
  return input.replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]");
}
