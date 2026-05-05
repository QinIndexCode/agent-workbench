import type {
  ApprovalDecision,
  ExperienceRecord,
  GlobalPermissionGrant,
  KnowledgeCreateRequest,
  KnowledgeItem,
  KnowledgePatchRequest,
  KnowledgeUploadRequest,
  ModelProviderCreateRequest,
  ModelProviderPatchRequest,
  ModelProviderRecord,
  PatternRecord,
  PreferencesPatch,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ReflectionSession,
  RiskCategory,
  SkillCreateRequest,
  SkillDuplicateGroup,
  SkillMergeRequest,
  SkillRecord,
  SkillUpdateRequest,
  TaskDeleteRequest,
  TaskDeleteResult,
  TaskDetail,
  TaskEvent,
  ToolApproval,
  ToolCall,
  ToolResult
} from "@scc/shared";
import { ContextAssembler } from "./context-assembler.js";
import {
  createExperience,
  createTaskMemory,
  detectSkillConflicts,
  exportSkill,
  findDuplicateSkill,
  listSkillDuplicateGroups,
  mergeSkillRecords,
  normalizeSkillRecord,
  reflectMemories
} from "./experience.js";
import { FallbackModelClient, type ModelClient } from "./fallback-model.js";
import { createId, nowIso } from "./ids.js";
import { PermissionEngine, type PermissionState, type RiskAssessment } from "./permission-engine.js";
import { LocalSecretBox, maskSecret } from "./secrets.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { ShellToolExecutor, type ToolExecutor } from "./tools.js";

export interface ToolRiskProvider {
  assessTool(call: ToolCall): Promise<RiskAssessment | undefined>;
  describeToolCall?(call: ToolCall): Promise<Record<string, unknown> | undefined>;
}

export interface AgentWorkbenchOptions {
  store?: WorkbenchStore;
  model?: ModelClient;
  tools?: ToolExecutor;
  contextAssembler?: ContextAssembler;
  toolRiskProvider?: ToolRiskProvider;
  onEvent?: (event: TaskEvent) => void;
}

export class AgentWorkbench {
  private readonly store: WorkbenchStore;
  private readonly model: ModelClient;
  private readonly tools: ToolExecutor;
  private readonly contextAssembler: ContextAssembler;
  private readonly toolRiskProvider: ToolRiskProvider | undefined;
  private readonly onEvent: ((event: TaskEvent) => void) | undefined;
  private readonly permissions = new PermissionEngine();
  private readonly secretBox = new LocalSecretBox();
  private readonly permissionState = new Map<string, PermissionState>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly runningToolControllers = new Map<string, AbortController>();

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(this.store);
    this.toolRiskProvider = options.toolRiskProvider;
    this.onEvent = options.onEvent;
  }

  async createTask(goal: string, title = goal.slice(0, 72)): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, title);
    return this.runTaskExclusive(task.id, () => this.step(task.id));
  }

  async startTask(goal: string, title = goal.slice(0, 72)): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, title);
    void this.runTaskExclusive(task.id, () => this.step(task.id)).catch((error) => {
      void this.failBackgroundRun(task.id, error);
    });
    return task;
  }

  private async initializeTask(goal: string, title: string): Promise<TaskDetail> {
    const task = this.emptyTask(title);
    this.addEvent(task, "task_created", "Task created");
    this.addEvent(task, "user_message", goal);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return task;
  }

  async listTasks(): Promise<TaskDetail[]> {
    return this.store.listTasks();
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    return this.store.getTask(taskId);
  }

  async deleteTask(taskId: string, options: TaskDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }): Promise<TaskDeleteResult> {
    this.cancelRunningTool(taskId);
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      await this.store.deleteTask(taskId);
      this.contextAssembler.cleanupTask(taskId);
      this.permissionState.delete(taskId);
      this.runningToolControllers.delete(taskId);

      const result: TaskDeleteResult = {
        taskId,
        deletedTask: true,
        deletedExperiences: 0,
        deletedTaskMemories: 0,
        deletedSkills: 0,
        updatedSkills: 0,
        cancelledRun: task.status === "running" || task.status === "waiting_approval"
      };

      if (options.deleteLearningData) {
        const deletedSourceIds = new Set<string>();
        for (const experience of (await this.store.listExperiences()).filter((item) => item.taskId === taskId)) {
          await this.store.deleteExperience(experience.id);
          deletedSourceIds.add(experience.id);
          result.deletedExperiences += 1;
        }
        for (const memory of (await this.store.listTaskMemories()).filter((item) => item.taskId === taskId)) {
          await this.store.deleteTaskMemory(memory.id);
          deletedSourceIds.add(memory.id);
          result.deletedTaskMemories += 1;
        }
        const skillResult = await this.cleanupDeletedSkillSources(deletedSourceIds, Boolean(options.deleteDerivedSkills));
        result.deletedSkills = skillResult.deletedSkills;
        result.updatedSkills = skillResult.updatedSkills;
      }

      return result;
    });
  }

  async appendMessage(taskId: string, content: string): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
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
    });
  }

  async control(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail> {
    if (action === "resume") {
      return this.runTaskExclusive(taskId, async () => {
        const task = await this.requiredTask(taskId);
        this.setStatus(task, "running");
        await this.store.saveTask(task);
        return this.step(task.id);
      });
    }

    this.cancelRunningTool(taskId);
    const task = await this.requiredTask(taskId);
    if (action === "pause") this.setStatus(task, "paused");
    if (action === "cancel") this.setStatus(task, "cancelled");
    await this.store.saveTask(task);
    return task;
  }

  async decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      const approval = task.approvals.find((item) => item.id === approvalId);
      if (!approval) throw new Error(`Pending approval not found: ${approvalId}`);
      if (approval.status !== "pending") return task;

      approval.status = decision === "deny" ? "denied" : "approved";
      approval.decision = decision;
      approval.decidedAt = nowIso();
      if (decision === "allow_for_task") {
        this.stateFor(task.id, task).allowedForTask.add(approval.riskCategory);
      }
      if (decision === "allow_globally") {
        await this.store.saveGlobalPermission(this.createGlobalGrant(approval.riskCategory, approval.reason));
      }
      this.addEvent(task, "approval_resolved", `${approval.toolCall.toolName}: ${decision}`, {
        approvalId,
        decision,
        riskCategory: approval.riskCategory,
        ...(approval.metadata ?? {})
      });

      if (decision === "deny") {
        this.setStatus(task, "running");
        await this.store.saveTask(task);
        return this.step(task.id);
      }

      this.setStatus(task, "running");
      await this.store.saveTask(task);
      const result = await this.executeTool(task.id, approval.toolCall);
      const latest = await this.requiredTask(task.id);
      this.addToolResultEvent(latest, approval.toolCall, result);
      await this.store.saveTask(latest);
      if (latest.status !== "running") return latest;
      return this.step(latest.id);
    });
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
    return (await this.store.listSkills()).map(normalizeSkillRecord);
  }

  async listSkillConflicts() {
    return this.store.listSkillConflicts();
  }

  async listSkillDuplicates(): Promise<SkillDuplicateGroup[]> {
    return listSkillDuplicateGroups(await this.listSkills());
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    return this.store.getSkill(skillId);
  }

  async createSkill(input: SkillCreateRequest): Promise<SkillRecord> {
    const now = nowIso();
    const skill = normalizeSkillRecord({
      id: createId("skill"),
      sourceMemoryIds: input.sourceMemoryIds,
      title: input.title,
      body: input.body,
      applicability: {
        description: input.applicability.description ?? `Tasks similar to: ${input.title}`,
        requiredTools: input.applicability.requiredTools ?? [],
        requiredContext: input.applicability.requiredContext ?? [],
        exclusions: input.applicability.exclusions ?? ["Do not apply if the current task goal materially differs."],
        minConfidence: input.applicability.minConfidence ?? 0.7,
        keywords: input.applicability.keywords ?? []
      },
      stats: {
        totalUses: 0,
        successUses: 0,
        failureUses: 0,
        successRate: 0,
        consecutiveFailures: 0
      },
      version: 1,
      corrections: [],
      status: input.status,
      relatedPatterns: input.relatedPatterns,
      createdAt: now,
      lastUsedAt: now,
      updatedAt: now
    });
    return this.saveSkillWithConflicts(skill);
  }

  async updateSkill(skillId: string, input: SkillUpdateRequest): Promise<SkillRecord> {
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    const normalized = normalizeSkillRecord(skill);
    const updated = normalizeSkillRecord({
      ...normalized,
      ...("title" in input ? { title: input.title } : {}),
      ...("body" in input ? { body: input.body, version: normalized.version + 1 } : {}),
      ...("status" in input ? { status: input.status } : {}),
      ...("sourceMemoryIds" in input ? { sourceMemoryIds: input.sourceMemoryIds } : {}),
      ...("relatedPatterns" in input ? { relatedPatterns: input.relatedPatterns } : {}),
      applicability: {
        ...normalized.applicability,
        ...(input.applicability ?? {})
      },
      updatedAt: nowIso()
    });
    await this.store.saveSkill(updated);
    return updated;
  }

  async updateSkillStatus(skillId: string, status: SkillRecord["status"]): Promise<SkillRecord> {
    return this.updateSkill(skillId, { status });
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

  async exportSkill(skillId: string): Promise<{ markdown: string; manifest: Record<string, unknown> }> {
    const skill = await this.store.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    return exportSkill(skill);
  }

  async promoteExperience(experienceId: string): Promise<SkillRecord> {
    const experience = (await this.store.listExperiences()).find((item) => item.id === experienceId);
    if (!experience) throw new Error(`Experience not found: ${experienceId}`);
    throw new Error("Experience is not eligible for direct Skill promotion. Run reflection to promote stable reusable patterns.");
  }

  async deleteSkill(skillId: string): Promise<void> {
    await this.store.deleteSkill(skillId);
  }

  async bulkDeleteSkills(skillIds: string[]): Promise<{ deleted: number }> {
    const uniqueIds = [...new Set(skillIds)];
    for (const skillId of uniqueIds) await this.store.deleteSkill(skillId);
    return { deleted: uniqueIds.length };
  }

  async mergeSkills(input: SkillMergeRequest): Promise<SkillRecord> {
    const uniqueSourceIds = [...new Set(input.sourceSkillIds)];
    const allIds = [...new Set([...(input.targetSkillId ? [input.targetSkillId] : []), ...uniqueSourceIds])];
    const skills = (await Promise.all(allIds.map((id) => this.store.getSkill(id)))).filter((skill): skill is SkillRecord => Boolean(skill));
    if (skills.length === 0) throw new Error("No skills found to merge.");
    const target =
      (input.targetSkillId ? skills.find((skill) => skill.id === input.targetSkillId) : undefined) ??
      [...skills].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    const merged = skills.filter((skill) => skill.id !== target.id).reduce((current, next) => mergeSkillRecords(current, next), target);
    await this.store.saveSkill(merged);
    if (input.deleteSources) {
      for (const skill of skills) {
        if (skill.id !== merged.id) await this.store.deleteSkill(skill.id);
      }
    }
    return merged;
  }

  async cleanupDuplicateSkills(): Promise<{ merged: number; deleted: number; groups: SkillDuplicateGroup[] }> {
    const groups = await this.listSkillDuplicates();
    let deleted = 0;
    for (const group of groups) {
      const sourceSkillIds = group.skills.filter((skill) => skill.id !== group.canonicalSkillId).map((skill) => skill.id);
      if (sourceSkillIds.length === 0) continue;
      await this.mergeSkills({ targetSkillId: group.canonicalSkillId, sourceSkillIds, deleteSources: true });
      deleted += sourceSkillIds.length;
    }
    return { merged: groups.length, deleted, groups };
  }

  private async cleanupDeletedSkillSources(
    deletedSourceIds: Set<string>,
    deleteDerivedSkills: boolean
  ): Promise<{ deletedSkills: number; updatedSkills: number }> {
    if (deletedSourceIds.size === 0) return { deletedSkills: 0, updatedSkills: 0 };
    let deletedSkills = 0;
    let updatedSkills = 0;

    for (const rawSkill of await this.store.listSkills()) {
      const skill = normalizeSkillRecord(rawSkill);
      const linkedSources = skill.sourceMemoryIds.filter((id) => deletedSourceIds.has(id));
      if (linkedSources.length === 0) continue;

      const remainingSources = skill.sourceMemoryIds.filter((id) => !deletedSourceIds.has(id));
      const onlyDeletedSources = remainingSources.length === 0 && skill.sourceMemoryIds.length === linkedSources.length;
      const safeToDeleteDerivedSkill =
        deleteDerivedSkills && onlyDeletedSources && !skill.sourcePatternId && skill.relatedPatterns.length === 0;

      if (safeToDeleteDerivedSkill) {
        await this.store.deleteSkill(skill.id);
        deletedSkills += 1;
        continue;
      }

      await this.store.saveSkill({
        ...skill,
        sourceMemoryIds: remainingSources,
        updatedAt: nowIso()
      });
      updatedSkills += 1;
    }

    return { deletedSkills, updatedSkills };
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

  async listModelProviders(): Promise<ModelProviderRecord[]> {
    return this.store.listModelProviders();
  }

  async createModelProvider(input: ModelProviderCreateRequest): Promise<ModelProviderRecord> {
    const now = nowIso();
    const id = createId("provider");
    const secret = input.apiKey ? this.secretBox.encrypt(input.apiKey) : undefined;
    if (secret) await this.store.saveModelProviderSecret(id, secret);
    const provider: ModelProviderRecord = {
      id,
      vendor: input.vendor,
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      ...(secret ? { apiKeyRef: { secretId: id, ...maskSecret(input.apiKey!), updatedAt: secret.updatedAt } } : {}),
      models: input.models,
      defaultModelId: input.defaultModelId,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveModelProvider(provider);
    if (input.makeActive) await this.setActiveProvider(provider);
    return provider;
  }

  async updateModelProvider(providerId: string, input: ModelProviderPatchRequest): Promise<ModelProviderRecord> {
    const current = await this.store.getModelProvider(providerId);
    if (!current) throw new Error(`Model provider not found: ${providerId}`);
    const models = input.models ?? current.models;
    const defaultModelId = input.defaultModelId ?? current.defaultModelId;
    if (!models.some((model) => model.id === defaultModelId)) throw new Error("defaultModelId must match a configured model.");
    let apiKeyRef = current.apiKeyRef;
    if (input.clearApiKey) {
      await this.store.deleteModelProviderSecret(providerId);
      apiKeyRef = undefined;
    }
    if (input.apiKey) {
      const secret = this.secretBox.encrypt(input.apiKey);
      await this.store.saveModelProviderSecret(providerId, secret);
      apiKeyRef = { secretId: providerId, ...maskSecret(input.apiKey), updatedAt: secret.updatedAt };
    }
    const updated: ModelProviderRecord = {
      ...current,
      ...(input.vendor ? { vendor: input.vendor } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.protocol ? { protocol: input.protocol } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(apiKeyRef ? { apiKeyRef } : {}),
      models,
      defaultModelId,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: nowIso()
    };
    if (!apiKeyRef) delete updated.apiKeyRef;
    await this.store.saveModelProvider(updated);
    if (input.makeActive) await this.setActiveProvider(updated);
    return updated;
  }

  async deleteModelProvider(providerId: string): Promise<void> {
    await this.store.deleteModelProvider(providerId);
    await this.store.deleteModelProviderSecret(providerId);
    const preferences = await this.store.getPreferences();
    if (preferences.activeModelProviderId === providerId) {
      await this.updatePreferences({ activeModelProviderId: "" });
    }
  }

  async runReflection(): Promise<ReflectionSession> {
    const result = reflectMemories(await this.store.listTaskMemories(), await this.store.listPatterns());
    await this.store.saveReflectionSession(result.session);
    for (const pattern of result.patterns) await this.store.savePattern(pattern);
    for (const skill of result.promotedSkills) await this.saveSkillWithConflicts(skill);
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

  async listKnowledgeItems(projectId?: string): Promise<KnowledgeItem[]> {
    return this.store.listKnowledgeItems(projectId);
  }

  async createKnowledgeItem(input: KnowledgeCreateRequest): Promise<KnowledgeItem> {
    const now = nowIso();
    const item: KnowledgeItem = {
      id: createId("knowledge"),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: cleanTags(input.tags),
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveKnowledgeItem(item);
    return item;
  }

  async uploadKnowledgeFile(input: KnowledgeUploadRequest): Promise<KnowledgeItem> {
    return this.createKnowledgeItem({
      projectId: input.projectId,
      kind: "file",
      title: input.title ?? input.fileName,
      content: input.content,
      tags: input.tags,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size
    });
  }

  async updateKnowledgeItem(id: string, input: KnowledgePatchRequest): Promise<KnowledgeItem> {
    const current = await this.store.getKnowledgeItem(id);
    if (!current) throw new Error(`Knowledge item not found: ${id}`);
    const updated: KnowledgeItem = {
      ...current,
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.tags ? { tags: cleanTags(input.tags) } : {}),
      ...(input.sourceUri !== undefined ? { sourceUri: input.sourceUri } : {}),
      updatedAt: nowIso()
    };
    await this.store.saveKnowledgeItem(updated);
    return updated;
  }

  async deleteKnowledgeItem(id: string): Promise<void> {
    await this.store.deleteKnowledgeItem(id);
  }

  private async setActiveProvider(provider: ModelProviderRecord): Promise<void> {
    await this.updatePreferences({
      activeModelProviderId: provider.id,
      defaultModel: provider.defaultModelId,
      providerBaseUrl: provider.baseUrl,
      maxTokensPerRequest: provider.models.find((model) => model.id === provider.defaultModelId)?.contextWindow
    });
  }

  async recoverInterruptedTasks(): Promise<void> {
    for (const task of await this.store.listTasks()) {
      if (task.status === "running") {
        this.setStatus(task, "paused");
        this.addEvent(task, "status_changed", "Recovered paused task", { recoverable: true });
        await this.store.saveTask(task);
      }
    }
  }

  private async step(taskId: string): Promise<TaskDetail> {
    const task = await this.requiredTask(taskId);
    if (task.status !== "running") return task;

    this.consumePendingGuidance(task);
    const turn = await this.safeModelNext(task);
    this.addLoadedSkillEvents(task);
    if (!turn) return task;
    const stoppedAfterModel = await this.stoppedTask(task.id);
    if (stoppedAfterModel) return stoppedAfterModel;
    if (turn.kind === "final") {
      this.addEvent(task, "assistant_message", turn.message, turn.streamId ? { streamId: turn.streamId } : {});
      this.setStatus(task, "completed");
      await this.recordExperience(task);
      await this.store.saveTask(task);
      return task;
    }

    for (const call of turn.calls) {
      const stoppedBeforeTool = await this.stoppedTask(task.id);
      if (stoppedBeforeTool) return stoppedBeforeTool;

      const assessment = (await this.toolRiskProvider?.assessTool(call)) ?? this.permissions.assess(call.toolName, call.args);
      const metadata = await this.describeToolCall(call, assessment);
      this.addEvent(task, "tool_requested", call.toolName, {
        toolCallId: call.id,
        toolName: call.toolName,
        args: call.args,
        riskCategory: assessment.category,
        ...metadata
      });

      const globalGrants = await this.store.listGlobalPermissions();
      if (this.permissions.isGloballyAllowed(assessment.category, globalGrants)) {
        this.addEvent(task, "approval_auto_granted", `${assessment.category}: global permission`, {
          toolCallId: call.id,
          toolName: call.toolName,
          riskCategory: assessment.category,
          ...metadata
        });
      } else if (this.permissions.needsApproval(assessment.category, this.stateFor(task.id, task))) {
        const approval = this.permissions.createApproval({ taskId: task.id, toolCall: call, assessment, metadata });
        task.approvals.push(approval);
        this.addApprovalPendingEvent(task, approval);
        this.setStatus(task, "waiting_approval");
        await this.store.saveTask(task);
        return task;
      }

      await this.store.saveTask(task);
      const result = await this.executeTool(task.id, call);
      const latest = await this.requiredTask(task.id);
      this.addToolResultEvent(latest, call, result);
      await this.store.saveTask(latest);
      if (latest.status !== "running") return latest;
      Object.assign(task, latest);
    }

    await this.store.saveTask(task);
    return this.step(task.id);
  }

  private async recordExperience(task: TaskDetail): Promise<void> {
    await this.updateLoadedSkillStats(task, true);
    const experience = createExperience(task);
    const memory = createTaskMemory(task);
    await this.store.saveExperience(experience);
    await this.store.saveTaskMemory(memory);
    this.addEvent(task, "task_memory_created", memory.title, { memoryId: memory.id });
    if ((await this.store.getPreferences()).reflectionEnabled) {
      const reflection = reflectMemories(await this.store.listTaskMemories(), await this.store.listPatterns());
      await this.store.saveReflectionSession(reflection.session);
      for (const pattern of reflection.patterns) {
        await this.store.savePattern(pattern);
        this.addEvent(task, "pattern_discovered", pattern.title, { patternId: pattern.id, status: pattern.status });
      }
      for (const promoted of reflection.promotedSkills) {
        const skill = await this.saveSkillWithConflicts(promoted);
        this.addEvent(task, "skill_promoted", skill.title, { skillId: skill.id, status: skill.status });
      }
      this.addEvent(task, "reflection_completed", reflection.session.progress.phase, { sessionId: reflection.session.id });
    }
    this.contextAssembler.cleanupTask(task.id);
  }

  private async safeModelNext(task: TaskDetail): Promise<Awaited<ReturnType<ModelClient["next"]>> | null> {
    const streamId = createId("model_stream");
    try {
      return await this.model.next(task, {
        streamId,
        onAssistantDelta: async (delta) => {
          this.addEvent(task, "assistant_delta", delta, { streamId, delta });
          await this.store.saveTask(task);
        },
        onThinkingDelta: async (delta) => {
          this.addEvent(task, "thinking_delta", delta, { streamId, delta });
          await this.store.saveTask(task);
        }
      });
    } catch (error) {
      const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
      this.addEvent(task, "assistant_message", `Model provider failed: ${message}`);
      this.setStatus(task, "failed");
      await this.updateLoadedSkillStats(task, false);
      await this.store.saveTask(task);
      return null;
    }
  }

  private async saveSkillWithConflicts(skill: SkillRecord): Promise<SkillRecord> {
    const normalized = normalizeSkillRecord(skill);
    const existing = await this.store.listSkills();
    const duplicate = findDuplicateSkill(normalized, existing);
    const saved = duplicate ? mergeSkillRecords(duplicate, normalized) : normalized;
    await this.store.saveSkill(saved);
    for (const conflict of detectSkillConflicts(saved, existing)) {
      await this.store.saveSkillConflict(conflict);
    }
    return saved;
  }

  private async failBackgroundRun(taskId: string, error: unknown): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.status !== "running") return;
    const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
    this.addEvent(task, "assistant_message", `Runtime failed: ${message}`);
    this.setStatus(task, "failed");
    await this.updateLoadedSkillStats(task, false);
    await this.store.saveTask(task);
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

  private async runTaskExclusive<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.taskQueues.set(taskId, queued);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.taskQueues.get(taskId) === queued) this.taskQueues.delete(taskId);
    }
  }

  private async executeTool(taskId: string, call: ToolCall): Promise<ToolResult> {
    const controller = new AbortController();
    this.runningToolControllers.set(taskId, controller);
    try {
      return await this.tools.execute(call, { signal: controller.signal });
    } finally {
      if (this.runningToolControllers.get(taskId) === controller) {
        this.runningToolControllers.delete(taskId);
      }
    }
  }

  private cancelRunningTool(taskId: string): void {
    this.runningToolControllers.get(taskId)?.abort();
  }

  private async describeToolCall(call: ToolCall, assessment: RiskAssessment): Promise<Record<string, unknown>> {
    const providerMetadata = (await this.toolRiskProvider?.describeToolCall?.(call)) ?? {};
    return {
      riskCategory: assessment.category,
      argsPreview: previewArgs(call.args),
      ...inferBuiltInToolMetadata(call),
      ...providerMetadata
    };
  }

  private addToolResultEvent(task: TaskDetail, call: ToolCall, result: ToolResult): void {
    this.addEvent(task, "tool_result", result.ok ? "Tool completed" : "Tool failed", {
      toolCallId: result.toolCallId,
      toolName: call.toolName,
      args: call.args,
      ok: result.ok,
      output: result.output
    });
    this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(task.events[task.events.length - 1]!);
  }

  private addApprovalPendingEvent(task: TaskDetail, approval: ToolApproval): void {
    this.addEvent(task, "approval_pending", `${approval.riskCategory}: ${approval.toolCall.toolName}`, {
      approvalId: approval.id,
      approval,
      toolName: approval.toolCall.toolName,
      args: approval.toolCall.args,
      riskCategory: approval.riskCategory,
      reason: approval.reason,
      ...(approval.metadata ?? {})
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
    const event: TaskEvent = {
      id: createId("event"),
      taskId: task.id,
      type,
      summary,
      payload,
      createdAt: nowIso()
    };
    task.events.push(event);
    task.updatedAt = nowIso();
    task.pendingGuidance = task.events.filter(
      (event) => event.type === "guidance_pending" && event.payload["status"] === "pending"
    );
    this.onEvent?.(event);
  }

  private addLoadedSkillEvents(task: TaskDetail): void {
    for (const skill of this.contextAssembler.drainLoadedSkillEvents(task.id)) {
      this.addEvent(task, "skill_loaded", skill.title, { skillId: skill.id });
    }
  }

  private async updateLoadedSkillStats(task: TaskDetail, success: boolean): Promise<void> {
    for (const skillId of this.contextAssembler.getLoadedSkillIds(task.id)) {
      const skill = await this.store.getSkill(skillId);
      if (!skill) continue;
      const totalUses = skill.stats.totalUses + 1;
      const successUses = skill.stats.successUses + (success ? 1 : 0);
      const failureUses = skill.stats.failureUses + (success ? 0 : 1);
      const updated: SkillRecord = {
        ...skill,
        stats: {
          ...skill.stats,
          totalUses,
          successUses,
          failureUses,
          successRate: successUses / Math.max(1, totalUses),
          consecutiveFailures: success ? 0 : skill.stats.consecutiveFailures + 1,
          ...(success ? {} : { lastFailureAt: nowIso() })
        },
        lastUsedAt: nowIso(),
        updatedAt: nowIso()
      };
      await this.store.saveSkill(updated);
    }
  }

  private async stoppedTask(taskId: string): Promise<TaskDetail | null> {
    const current = await this.store.getTask(taskId);
    if (!current || current.status === "running") return null;
    return current;
  }

  private async requiredTask(taskId: string): Promise<TaskDetail> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private stateFor(taskId: string, task?: TaskDetail): PermissionState {
    const existing = this.permissionState.get(taskId);
    if (existing) return existing;
    const allowedForTask = new Set<RiskCategory>();
    if (task) {
      for (const approval of task.approvals) {
        if (approval.status === "approved" && approval.decision === "allow_for_task") {
          allowedForTask.add(approval.riskCategory);
        }
      }
    }
    const created: PermissionState = { allowedForTask };
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

function inferBuiltInToolMetadata(call: ToolCall): Record<string, unknown> {
  if (call.toolName === "run_command") {
    return {
      command: String(call.args["command"] ?? ""),
      cwd: String(call.args["cwd"] ?? ".")
    };
  }
  if (call.toolName === "read_file" || call.toolName === "edit_file" || call.toolName === "search_files" || call.toolName === "list_files") {
    return {
      path: String(call.args["path"] ?? ".")
    };
  }
  return {};
}

function previewArgs(args: Record<string, unknown>): string {
  const raw = JSON.stringify(args, null, 2);
  if (raw.length <= 1600) return raw;
  return `${raw.slice(0, 1600)}\n... args truncated ...`;
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 32);
}
