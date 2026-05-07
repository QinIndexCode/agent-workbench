import type {
  ApprovalDecision,
  ConversationSummary,
  ExperienceRecord,
  GlobalPermissionGrant,
  DiscordInteractionRequest,
  FeishuEventRequest,
  IntegrationKind,
  IntegrationMessage,
  IntegrationProviderConfig,
  IntegrationProviderCreateRequest,
  IntegrationProviderPatchRequest,
  IntegrationTaskLink,
  KnowledgeCreateRequest,
  KnowledgeItem,
  KnowledgePatchRequest,
  KnowledgeReindexResult,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  KnowledgeUploadRequest,
  ModelProviderCreateRequest,
  ModelProviderPatchRequest,
  ModelProviderRecord,
  PatternRecord,
  PreferencesPatch,
  PromptCacheStats,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ReflectionSession,
  RiskCategory,
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  TaskFolderClearRequest,
  TaskFolderClearResult,
  TaskFolderDeleteRequest,
  TaskFolderDeleteResult,
  TaskFolderCreateRequest,
  TaskFolderPatchRequest,
  TaskFolderRecord,
  TaskPatchRequest,
  TaskCheckpoint,
  TaskRollbackRequest,
  TaskRollbackResult,
  TaskTitleRequest,
  TaskTitleResponse,
  TaskAttachment,
  TaskAttachmentKind,
  TaskAttachmentUploadRequest,
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
  ToolResult,
  WebSearchProviderConfig,
  WebSearchProviderCreateRequest,
  WebSearchProviderPatchRequest
} from "@scc/shared";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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
import { FallbackModelClient, type ModelClient, type ModelUsage } from "./fallback-model.js";
import { createId, nowIso } from "./ids.js";
import { indexKnowledgeItem, searchKnowledge } from "./knowledge-rag.js";
import type { ResolvedModelProviderConfig } from "./openai-model.js";
import { PermissionEngine, type PermissionState, type RiskAssessment } from "./permission-engine.js";
import { LocalSecretBox, maskSecret } from "./secrets.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { ShellToolExecutor, type ToolExecutor } from "./tools.js";
import { createWebSearchApiKeyRef } from "./web-search.js";
import { findWorkspaceRoot } from "./workspace-root.js";

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
  private readonly runningModelControllers = new Map<string, AbortController>();
  private readonly runningToolControllers = new Map<string, AbortController>();

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(this.store);
    this.toolRiskProvider = options.toolRiskProvider;
    this.onEvent = options.onEvent;
  }

  async createTask(goal: string, title = createLocalTaskTitle(goal), folderId = "default", attachmentIds: string[] = []): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, title, folderId, attachmentIds);
    return this.runTaskExclusive(task.id, () => this.step(task.id));
  }

  async startTask(goal: string, title = createLocalTaskTitle(goal), folderId = "default", attachmentIds: string[] = []): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, title, folderId, attachmentIds);
    void this.runTaskExclusive(task.id, () => this.step(task.id)).catch((error) => {
      void this.failBackgroundRun(task.id, error);
    });
    return task;
  }

  private async initializeTask(goal: string, title: string, folderId: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    const folder = await this.resolveTaskFolder(folderId);
    const task = this.emptyTask(title);
    task.folderId = folder.id;
    task.workRoot = folder.rootPath;
    this.addEvent(task, "task_created", "Task created");
    this.addEvent(task, "user_message", goal);
    this.addEvent(task, "plan_created", "Initial plan created", {
      steps: [
        { id: createId("plan_step"), title: "Understand the request", status: "completed" },
        { id: createId("plan_step"), title: "Choose evidence or tools", status: "pending" },
        { id: createId("plan_step"), title: "Return a visible result", status: "pending" }
      ]
    });
    await this.attachUploadedFiles(task, attachmentIds);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return task;
  }

  async listTasks(): Promise<TaskDetail[]> {
    return this.store.listTasks();
  }

  async generateTaskTitle(input: TaskTitleRequest): Promise<TaskTitleResponse> {
    if (input.useLocalFallback) return { title: createLocalTaskTitle(input.goal, input.language), source: "local_fallback" };
    const provider = await this.resolveModelProviderConfig();
    if (!provider) throw new Error("No model provider is configured for title generation.");
    const title = normalizeGeneratedTaskTitle(await generateTaskTitleWithProvider(provider, input.goal, input.language), input.goal, input.language);
    return { title, source: "model" };
  }

  async listPromptCacheStats(taskId?: string): Promise<PromptCacheStats[]> {
    return this.store.listPromptCacheStats(taskId);
  }

  async listTaskFolders(): Promise<TaskFolderRecord[]> {
    const folders = [defaultTaskFolder(), ...(await this.store.listTaskFolders()).filter((folder) => folder.id !== "default")];
    return Promise.all(folders.map((folder) => this.refreshFolderStatus(folder)));
  }

  async createTaskFolder(input: TaskFolderCreateRequest): Promise<TaskFolderRecord> {
    const existing = await this.store.listTaskFolders();
    const now = nowIso();
    const rootPath = await this.validateFolderRoot(input.rootPath);
    const folder: TaskFolderRecord = {
      id: createId("folder"),
      name: input.name.trim(),
      rootPath,
      isDefault: false,
      exists: true,
      lastValidatedAt: now,
      sortOrder: existing.length + 1,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveTaskFolder(folder);
    return folder;
  }

  async updateTaskFolder(folderId: string, input: TaskFolderPatchRequest): Promise<TaskFolderRecord> {
    if (folderId === "default") throw new Error("Default folder cannot be edited.");
    const folder = await this.store.getTaskFolder(folderId);
    if (!folder) throw new Error(`Task folder not found: ${folderId}`);
    const updated: TaskFolderRecord = {
      ...folder,
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.rootPath ? { rootPath: await this.validateFolderRoot(input.rootPath), exists: true, lastValidatedAt: nowIso() } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: nowIso()
    };
    await this.store.saveTaskFolder(updated);
    return updated;
  }

  async deleteTaskFolder(
    folderId: string,
    input: TaskFolderDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }
  ): Promise<TaskFolderDeleteResult> {
    if (folderId === "default") throw new Error("Default folder cannot be deleted.");
    const folder = await this.store.getTaskFolder(folderId);
    if (!folder) throw new Error(`Task folder not found: ${folderId}`);
    const cleared = await this.clearTaskFolder(folderId, input);
    await this.store.deleteTaskFolder(folderId);
    return {
      ...cleared,
      deletedFolder: true
    };
  }

  async clearTaskFolder(folderId: string, input: TaskFolderClearRequest): Promise<TaskFolderClearResult> {
    const id = folderId || "default";
    if (id !== "default" && !(await this.store.getTaskFolder(id))) {
      throw new Error(`Task folder not found: ${id}`);
    }
    const tasks = (await this.store.listTasks()).filter((task) => (task.folderId || "default") === id);
    const result: TaskFolderClearResult = {
      folderId: id,
      deletedTasks: 0,
      deletedExperiences: 0,
      deletedTaskMemories: 0,
      deletedSkills: 0,
      updatedSkills: 0
    };
    for (const task of tasks) {
      const deleted = await this.deleteTask(task.id, input);
      result.deletedTasks += deleted.deletedTask ? 1 : 0;
      result.deletedExperiences += deleted.deletedExperiences;
      result.deletedTaskMemories += deleted.deletedTaskMemories;
      result.deletedSkills += deleted.deletedSkills;
      result.updatedSkills += deleted.updatedSkills;
    }
    return result;
  }

  private async resolveTaskFolder(folderId: string | undefined): Promise<TaskFolderRecord> {
    const id = !folderId || folderId === "all" ? "default" : folderId;
    const folder = id === "default" ? defaultTaskFolder() : await this.store.getTaskFolder(id);
    if (!folder) throw new Error(`Task folder not found: ${id}`);
    const refreshed = await this.refreshFolderStatus(folder);
    if (!refreshed.exists) throw new Error(`Task folder path does not exist: ${refreshed.rootPath}`);
    return refreshed;
  }

  private async validateFolderRoot(rootPath?: string): Promise<string> {
    const full = resolve(rootPath?.trim() || findWorkspaceRoot());
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Folder path must exist and be a directory: ${full}`);
    return full;
  }

  private async refreshFolderStatus(folder: TaskFolderRecord): Promise<TaskFolderRecord> {
    const rootPath = resolve(folder.rootPath?.trim() || findWorkspaceRoot());
    const exists = Boolean((await stat(rootPath).catch(() => null))?.isDirectory());
    return {
      ...folder,
      rootPath,
      exists,
      isDefault: folder.id === "default" || Boolean(folder.isDefault),
      lastValidatedAt: nowIso()
    };
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    return this.store.getTask(taskId);
  }

  async updateTask(taskId: string, input: TaskPatchRequest): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      let folderId = task.folderId || "default";
      if (input.folderId !== undefined) {
        const folder = await this.resolveTaskFolder(input.folderId);
        folderId = folder.id;
      }
      const title = input.title?.trim();
      const updated: TaskDetail = {
        ...task,
        ...(title ? { title } : {}),
        folderId,
        updatedAt: nowIso()
      };
      await this.store.saveTask(updated);
      return updated;
    });
  }

  async deleteTask(taskId: string, options: TaskDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }): Promise<TaskDeleteResult> {
    this.cancelRunningTask(taskId);
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      await this.store.deleteTask(taskId);
      for (const attachment of await this.store.listTaskAttachments(taskId)) {
        await this.deleteTaskAttachment(attachment.id);
      }
      for (const checkpoint of await this.store.listTaskCheckpoints(taskId)) {
        await this.deleteTaskCheckpointArtifacts(checkpoint);
        await this.store.deleteTaskCheckpoint(checkpoint.id);
      }
      for (const summary of await this.store.listConversationSummaries(taskId)) {
        await this.store.deleteConversationSummary(summary.id);
      }
      this.contextAssembler.cleanupTask(taskId);
      this.permissionState.delete(taskId);
      this.runningModelControllers.delete(taskId);
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

  async listTaskCheckpoints(taskId?: string): Promise<TaskCheckpoint[]> {
    return this.store.listTaskCheckpoints(taskId);
  }

  async rollbackTask(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackResult> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      const checkpoint = input.checkpointId
        ? await this.store.getTaskCheckpoint(input.checkpointId)
        : this.buildTaskRollbackCheckpoint(task, await this.store.listTaskCheckpoints(taskId));
      if (!checkpoint || checkpoint.taskId !== taskId) throw new Error("No checkpoint is available for this task.");
      try {
        const result = await this.restoreCheckpointFiles(task, checkpoint);
        this.addEvent(task, "task_rollback_completed", `Rolled back ${result.restoredFiles + result.deletedFiles} file changes.`, {
          checkpointId: checkpoint.id,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          skippedFiles: result.skippedFiles,
          workRoot: checkpoint.workRoot
        });
        await this.store.saveTask(task);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.addEvent(task, "task_rollback_failed", message, { checkpointId: checkpoint.id, workRoot: checkpoint.workRoot });
        await this.store.saveTask(task);
        throw error;
      }
    });
  }

  private buildTaskRollbackCheckpoint(task: TaskDetail, checkpoints: TaskCheckpoint[]): TaskCheckpoint | undefined {
    if (checkpoints.length === 0) return undefined;
    const ordered = [...checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const earliestByPath = new Map<string, TaskCheckpoint["files"][number]>();
    for (const checkpoint of ordered) {
      const root = resolve(checkpoint.workRoot || task.workRoot || findWorkspaceRoot());
      for (const file of checkpoint.files) {
        const resolvedPath = resolveTaskPath(root, file.path);
        const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
        if (!earliestByPath.has(key)) earliestByPath.set(key, file);
      }
    }
    const first = ordered[0]!;
    return {
      ...first,
      reason: "rollback all task file changes",
      files: [...earliestByPath.values()],
      truncated: ordered.some((checkpoint) => checkpoint.truncated)
    };
  }

  async uploadTaskAttachment(input: TaskAttachmentUploadRequest): Promise<TaskAttachment> {
    const limits = taskAttachmentLimits();
    if (input.size > limits.maxFileBytes) throw new Error(`Attachment exceeds ${Math.round(limits.maxFileBytes / 1024 / 1024)}MB limit.`);
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength !== input.size) throw new Error("Attachment size does not match uploaded data.");
    const now = nowIso();
    const id = createId("attachment");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const kind = classifyAttachment(input.fileName, input.mimeType);
    const storagePath = resolve(findWorkspaceRoot(), "data", "attachments", `${id}-${sanitizeFileName(input.fileName)}`);
    await mkdir(dirname(storagePath), { recursive: true });
    await writeFile(storagePath, bytes);
    const textPreview = await buildAttachmentTextPreview(storagePath, kind, input.mimeType);
    const attachment: TaskAttachment = {
      id,
      fileName: input.fileName,
      mimeType: input.mimeType || "application/octet-stream",
      size: input.size,
      kind,
      storagePath,
      contentHash,
      ...(textPreview ? { textPreview } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveTaskAttachment(attachment);
    return attachment;
  }

  async listTaskAttachments(taskId?: string): Promise<TaskAttachment[]> {
    return this.store.listTaskAttachments(taskId);
  }

  async deleteTaskAttachment(attachmentId: string): Promise<void> {
    const attachment = await this.store.getTaskAttachment(attachmentId);
    if (!attachment) return;
    await this.store.deleteTaskAttachment(attachmentId);
    await rm(attachment.storagePath, { force: true }).catch(() => undefined);
  }

  async listConversationSummaries(taskId?: string): Promise<ConversationSummary[]> {
    return this.store.listConversationSummaries(taskId);
  }

  async appendMessage(taskId: string, content: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      await this.attachUploadedFiles(task, attachmentIds);
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

    this.cancelRunningTask(taskId);
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
        this.addEvent(task, "tool_result", "Tool denied by user", {
          toolCallId: approval.toolCall.id,
          toolName: approval.toolCall.toolName,
          args: approval.toolCall.args,
          ok: false,
          output: "Tool request denied by user. Explain the limitation, ask for a different approval, or choose a non-denied path."
        });
        this.setStatus(task, "running");
        await this.store.saveTask(task);
        return this.step(task.id);
      }

      this.setStatus(task, "running");
      await this.createCheckpointForTool(task, approval.toolCall, {
        category: approval.riskCategory,
        reason: approval.reason
      });
      await this.store.saveTask(task);
      const result = await this.executeTool(task.id, approval.toolCall);
      const latest = await this.requiredTask(task.id);
      this.addToolResultEvent(latest, approval.toolCall, result);
      this.addEvent(latest, result.ok ? "plan_step_completed" : "plan_step_blocked", `${approval.toolCall.toolName}: ${result.ok ? "completed" : "blocked"}`, {
        toolCallId: approval.toolCall.id,
        toolName: approval.toolCall.toolName,
        ok: result.ok
      });
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
    await this.normalizeModelContextPreferences(next);
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
    const preferences = await this.store.getPreferences();
    if (input.makeActive || preferences.activeModelProviderId === providerId) await this.setActiveProvider(updated);
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

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    await this.ensureDefaultScheduledTasks();
    return this.store.listScheduledTasks();
  }

  async ensureDefaultScheduledTasks(): Promise<ScheduledTask[]> {
    const existing = await this.store.listScheduledTasks();
    const hasReflection = existing.some((task) => task.id === "schedule_agent_reflection" || task.type === "reflection");
    if (hasReflection) return existing;
    const now = nowIso();
    const schedule: ScheduledTask["schedule"] = {
      kind: "calendar",
      frequency: "daily",
      timeOfDay: "02:00"
    };
    const reflection: ScheduledTask = {
      id: "schedule_agent_reflection",
      type: "reflection",
      title: "Agent self-reflection",
      prompt: "Review recent task memories and extract reusable patterns, candidate skills, and risks that need user review.",
      permissionPreset: "ask",
      schedule,
      status: "active",
      nextRunAt: computeNextRunAt(schedule),
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveScheduledTask(reflection);
    return this.store.listScheduledTasks();
  }

  async createScheduledTask(input: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
    if (input.folderId) await this.resolveTaskFolder(input.folderId);
    const now = nowIso();
    const schedule = createScheduleFromInput(input);
    const scheduled: ScheduledTask = {
      id: createId("schedule"),
      type: "prompt",
      title: input.title,
      prompt: input.prompt,
      ...(input.folderId ? { folderId: input.folderId } : {}),
      permissionPreset: "ask",
      schedule,
      status: "active",
      nextRunAt: computeNextRunAt(schedule),
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveScheduledTask(scheduled);
    return scheduled;
  }

  async updateScheduledTask(taskId: string, input: ScheduledTaskPatchRequest): Promise<ScheduledTask> {
    const current = await this.store.getScheduledTask(taskId);
    if (!current) throw new Error(`Scheduled task not found: ${taskId}`);
    if (input.folderId) await this.resolveTaskFolder(input.folderId);
    const scheduleChanged =
      input.scheduleKind !== undefined ||
      input.frequency !== undefined ||
      input.timeOfDay !== undefined ||
      input.intervalHours !== undefined ||
      input.intervalMinutes !== undefined;
    const schedule = scheduleChanged ? createScheduleFromInput(input, current.schedule) : current.schedule;
    const updated: ScheduledTask = {
      ...current,
      ...(input.title ? { title: input.title } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.folderId !== undefined ? (input.folderId ? { folderId: input.folderId } : { folderId: undefined }) : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(scheduleChanged
        ? {
            schedule,
            nextRunAt: computeNextRunAt(schedule)
          }
        : {}),
      updatedAt: nowIso()
    };
    await this.store.saveScheduledTask(updated);
    return updated;
  }

  async deleteScheduledTask(taskId: string): Promise<void> {
    const current = await this.store.getScheduledTask(taskId);
    if (!current) return;
    if (isDefaultReflectionSchedule(current)) {
      throw new Error("Agent self-reflection is a default automation and can only be paused, not deleted.");
    }
    await this.store.deleteScheduledTask(taskId);
  }

  async runDueScheduledTasks(now = new Date()): Promise<ScheduledTask[]> {
    const changed: ScheduledTask[] = [];
    for (const scheduled of await this.store.listScheduledTasks()) {
      if (scheduled.status !== "active" || new Date(scheduled.nextRunAt).getTime() > now.getTime()) continue;
      let next: ScheduledTask;
      try {
        if (scheduled.type === "reflection") {
          const session = await this.runReflection();
          next = advanceScheduledTask(scheduled, undefined, now, `Reflection ${session.status}: ${session.progress.phase}`);
        } else if (scheduled.type === "knowledge_reindex") {
          const items = await this.store.listKnowledgeItems();
          const results = await Promise.all(items.map((item) => this.reindexKnowledgeItem(item.id)));
          next = advanceScheduledTask(scheduled, undefined, now, `Reindexed ${results.reduce((sum, item) => sum + item.chunks, 0)} chunks from ${results.length} items.`);
        } else {
          const scheduledPrompt = scheduled.folderId
            ? scheduled.prompt
            : `${scheduled.prompt}\n\nNo work folder was selected for this automation. Do not write files unless the user explicitly assigns a work folder.`;
          const task = await this.initializeTask(scheduledPrompt, scheduled.title, scheduled.folderId ?? "default");
          this.addEvent(task, "scheduled_task_created", scheduled.title, { scheduledTaskId: scheduled.id });
          await this.store.saveTask(task);
          void this.runTaskExclusive(task.id, () => this.step(task.id)).catch((error) => {
            void this.failBackgroundRun(task.id, error);
          });
          next = advanceScheduledTask(scheduled, task.id, now, `Created task ${task.id}`);
        }
      } catch (error) {
        next = {
          ...scheduled,
          lastRunAt: now.toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: nowIso()
        };
      }
      await this.store.saveScheduledTask(next);
      changed.push(next);
    }
    return changed;
  }

  async listWebSearchProviders(): Promise<WebSearchProviderConfig[]> {
    return this.store.listWebSearchProviders();
  }

  async createWebSearchProvider(input: WebSearchProviderCreateRequest): Promise<WebSearchProviderConfig> {
    const now = nowIso();
    const id = createId("web_search_provider");
    const secret = input.apiKey ? this.secretBox.encrypt(input.apiKey) : undefined;
    if (secret) await this.store.saveWebSearchProviderSecret(id, secret);
    const provider: WebSearchProviderConfig = {
      id,
      label: input.label,
      kind: input.kind,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(secret ? { apiKeyRef: createWebSearchApiKeyRef(id, input.apiKey!, secret) } : {}),
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveWebSearchProvider(provider);
    return provider;
  }

  async updateWebSearchProvider(providerId: string, input: WebSearchProviderPatchRequest): Promise<WebSearchProviderConfig> {
    const current = await this.store.getWebSearchProvider(providerId);
    if (!current) throw new Error(`Web search provider not found: ${providerId}`);
    let apiKeyRef = current.apiKeyRef;
    if (input.clearApiKey) {
      await this.store.deleteWebSearchProviderSecret(providerId);
      apiKeyRef = undefined;
    }
    if (input.apiKey) {
      const secret = this.secretBox.encrypt(input.apiKey);
      await this.store.saveWebSearchProviderSecret(providerId, secret);
      apiKeyRef = createWebSearchApiKeyRef(providerId, input.apiKey, secret);
    }
    const updated: WebSearchProviderConfig = {
      ...current,
      ...(input.label ? { label: input.label } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      ...(apiKeyRef ? { apiKeyRef } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: nowIso()
    };
    if (!apiKeyRef) delete updated.apiKeyRef;
    await this.store.saveWebSearchProvider(updated);
    return updated;
  }

  async deleteWebSearchProvider(providerId: string): Promise<void> {
    await this.store.deleteWebSearchProvider(providerId);
    await this.store.deleteWebSearchProviderSecret(providerId);
  }

  async listIntegrationProviders(): Promise<IntegrationProviderConfig[]> {
    return this.store.listIntegrationProviders();
  }

  async createIntegrationProvider(input: IntegrationProviderCreateRequest): Promise<IntegrationProviderConfig> {
    await this.resolveTaskFolder(input.defaultFolderId);
    const now = nowIso();
    const id = createId("integration");
    const provider: IntegrationProviderConfig = {
      id,
      kind: input.kind,
      label: input.label,
      status: input.enabled ? initialIntegrationStatus(input.kind, input.callbackUrl) : "disabled",
      enabled: input.enabled,
      ...(input.botToken ? { botTokenRef: await this.saveIntegrationSecretRef(id, "botToken", input.botToken) } : {}),
      ...(input.signingSecret ? { signingSecretRef: await this.saveIntegrationSecretRef(id, "signingSecret", input.signingSecret) } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.appSecret ? { appSecretRef: await this.saveIntegrationSecretRef(id, "appSecret", input.appSecret) } : {}),
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      defaultFolderId: input.defaultFolderId,
      defaultPermissionPreset: input.defaultPermissionPreset,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveIntegrationProvider(provider);
    return provider;
  }

  async updateIntegrationProvider(integrationId: string, input: IntegrationProviderPatchRequest): Promise<IntegrationProviderConfig> {
    const current = await this.store.getIntegrationProvider(integrationId);
    if (!current) throw new Error(`Integration provider not found: ${integrationId}`);
    if (input.defaultFolderId) await this.resolveTaskFolder(input.defaultFolderId);
    let botTokenRef = current.botTokenRef;
    let signingSecretRef = current.signingSecretRef;
    let appSecretRef = current.appSecretRef;
    if (input.clearBotToken) {
      await this.store.deleteIntegrationSecret(integrationId, "botToken");
      botTokenRef = undefined;
    }
    if (input.clearSigningSecret) {
      await this.store.deleteIntegrationSecret(integrationId, "signingSecret");
      signingSecretRef = undefined;
    }
    if (input.clearAppSecret) {
      await this.store.deleteIntegrationSecret(integrationId, "appSecret");
      appSecretRef = undefined;
    }
    if (input.botToken) botTokenRef = await this.saveIntegrationSecretRef(integrationId, "botToken", input.botToken);
    if (input.signingSecret) signingSecretRef = await this.saveIntegrationSecretRef(integrationId, "signingSecret", input.signingSecret);
    if (input.appSecret) appSecretRef = await this.saveIntegrationSecretRef(integrationId, "appSecret", input.appSecret);
    const enabled = input.enabled ?? current.enabled;
    const callbackUrl = input.callbackUrl !== undefined ? input.callbackUrl : current.callbackUrl;
    const kind = input.kind ?? current.kind;
    const updated: IntegrationProviderConfig = {
      ...current,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(botTokenRef ? { botTokenRef } : {}),
      ...(signingSecretRef ? { signingSecretRef } : {}),
      ...(input.appId !== undefined ? { appId: input.appId } : {}),
      ...(appSecretRef ? { appSecretRef } : {}),
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(input.defaultFolderId ? { defaultFolderId: input.defaultFolderId } : {}),
      ...(input.defaultPermissionPreset ? { defaultPermissionPreset: input.defaultPermissionPreset } : {}),
      enabled,
      status: enabled ? initialIntegrationStatus(kind, callbackUrl) : "disabled",
      updatedAt: nowIso()
    };
    if (!botTokenRef) delete updated.botTokenRef;
    if (!signingSecretRef) delete updated.signingSecretRef;
    if (!appSecretRef) delete updated.appSecretRef;
    if (!callbackUrl) delete updated.callbackUrl;
    await this.store.saveIntegrationProvider(updated);
    return updated;
  }

  async deleteIntegrationProvider(integrationId: string): Promise<void> {
    await this.store.deleteIntegrationProvider(integrationId);
  }

  async connectIntegrationProvider(integrationId: string): Promise<IntegrationProviderConfig> {
    const current = await this.store.getIntegrationProvider(integrationId);
    if (!current) throw new Error(`Integration provider not found: ${integrationId}`);
    const updated: IntegrationProviderConfig = {
      ...current,
      enabled: true,
      status: initialIntegrationStatus(current.kind, current.callbackUrl) === "setup_pending" ? "setup_pending" : "connected",
      connectedAt: nowIso(),
      lastError: undefined,
      updatedAt: nowIso()
    };
    await this.store.saveIntegrationProvider(updated);
    return updated;
  }

  async disconnectIntegrationProvider(integrationId: string): Promise<IntegrationProviderConfig> {
    const current = await this.store.getIntegrationProvider(integrationId);
    if (!current) throw new Error(`Integration provider not found: ${integrationId}`);
    const updated: IntegrationProviderConfig = { ...current, enabled: false, status: "disabled", updatedAt: nowIso() };
    await this.store.saveIntegrationProvider(updated);
    return updated;
  }

  async handleDiscordInteraction(input: DiscordInteractionRequest): Promise<TaskDetail> {
    const provider = await this.resolveIntegrationForMessage("discord", input.integrationId);
    return this.createTaskFromIntegration(provider, input.text, input.channelId, input.messageId, input.userId);
  }

  async handleFeishuEvent(input: FeishuEventRequest): Promise<TaskDetail | null> {
    const message = input.event?.message;
    const text = parseFeishuMessageText(message?.content);
    const channelId = message?.chat_id ?? "";
    if (!text || !channelId) return null;
    const provider = await this.resolveIntegrationForMessage("feishu", input.integrationId);
    return this.createTaskFromIntegration(provider, text, channelId, message?.message_id ?? createId("feishu_message"));
  }

  private async saveIntegrationSecretRef(integrationId: string, name: string, value: string) {
    const secret = this.secretBox.encrypt(value);
    await this.store.saveIntegrationSecret(integrationId, name, secret);
    return {
      secretId: `${integrationId}:${name}`,
      ...maskSecret(value),
      updatedAt: secret.updatedAt
    };
  }

  private async resolveIntegrationForMessage(kind: IntegrationKind, preferredId?: string): Promise<IntegrationProviderConfig> {
    const providers = await this.store.listIntegrationProviders();
    const provider = preferredId
      ? providers.find((item) => item.id === preferredId && item.kind === kind)
      : providers.find((item) => item.kind === kind && item.enabled);
    if (!provider) throw new Error(`No ${kind} integration is configured.`);
    if (!provider.enabled || provider.status === "disabled") throw new Error(`${provider.label} is disabled.`);
    if (provider.status === "setup_pending") throw new Error(`${provider.label} needs callback setup before it can receive messages.`);
    return provider;
  }

  private async createTaskFromIntegration(
    provider: IntegrationProviderConfig,
    text: string,
    channelId: string,
    externalMessageId: string,
    senderId?: string
  ): Promise<TaskDetail> {
    const now = nowIso();
    const message: IntegrationMessage = {
      id: createId("integration_message"),
      integrationId: provider.id,
      externalMessageId,
      externalChannelId: channelId,
      ...(senderId ? { senderId } : {}),
      text,
      createdAt: now
    };
    await this.store.saveIntegrationMessage(message);
    const task = await this.initializeTask(text, createLocalTaskTitle(text), provider.defaultFolderId || "default");
    const linkedMessage: IntegrationMessage = { ...message, taskId: task.id };
    await this.store.saveIntegrationMessage(linkedMessage);
    const link: IntegrationTaskLink = {
      id: createId("integration_task_link"),
      integrationId: provider.id,
      taskId: task.id,
      externalChannelId: channelId,
      externalThreadId: externalMessageId,
      createdAt: now
    };
    await this.store.saveIntegrationTaskLink(link);
    this.addEvent(task, "integration_message_received", `${provider.label}: ${channelId}`, {
      integrationId: provider.id,
      provider: provider.kind,
      channelId,
      externalMessageId,
      senderId
    });
    await this.store.saveTask(task);
    return this.runTaskExclusive(task.id, () => this.step(task.id));
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
      projectId: input.projectId ?? "default",
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: cleanTags(input.tags),
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      indexStatus: "pending",
      chunkCount: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveKnowledgeItem(item);
    await this.reindexKnowledgeItem(item.id);
    return (await this.store.getKnowledgeItem(item.id)) ?? item;
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
      indexStatus: "pending",
      updatedAt: nowIso()
    };
    await this.store.saveKnowledgeItem(updated);
    await this.reindexKnowledgeItem(id);
    return (await this.store.getKnowledgeItem(id)) ?? updated;
  }

  async deleteKnowledgeItem(id: string): Promise<void> {
    await this.store.deleteKnowledgeItem(id);
  }

  async reindexKnowledgeItem(id: string): Promise<KnowledgeReindexResult> {
    const item = await this.store.getKnowledgeItem(id);
    if (!item) throw new Error(`Knowledge item not found: ${id}`);
    return indexKnowledgeItem(this.store, item);
  }

  async searchKnowledge(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult[]> {
    return searchKnowledge(this.store, input);
  }

  private async setActiveProvider(provider: ModelProviderRecord): Promise<void> {
    await this.updatePreferences({
      activeModelProviderId: provider.id,
      defaultModel: provider.defaultModelId,
      providerBaseUrl: provider.baseUrl,
      maxTokensPerRequest: provider.models.find((model) => model.id === provider.defaultModelId)?.contextWindow
    });
  }

  private async normalizeModelContextPreferences(preferences: PreferencesPatch & Record<string, unknown>): Promise<void> {
    const providers = await this.store.listModelProviders();
    const provider = providers.find((item) => item.id === preferences["activeModelProviderId"]);
    const model = provider?.models.find((item) => item.id === preferences["defaultModel"]) ?? provider?.models[0];
    const contextWindow = model?.contextWindow;
    if (!contextWindow) return;
    if (preferences["contextMode"] === "auto") {
      preferences["maxTokensPerRequest"] = contextWindow;
      return;
    }
    const requested = Number(preferences["maxTokensPerRequest"] ?? contextWindow);
    preferences["maxTokensPerRequest"] = Math.min(Math.max(1, Number.isFinite(requested) ? Math.round(requested) : contextWindow), contextWindow);
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
    await this.store.saveTask(task);
    const turn = await this.safeModelNext(task);
    this.addLoadedSkillEvents(task);
    if (!turn) return task;
    const stoppedAfterModel = await this.stoppedTask(task.id);
    if (stoppedAfterModel) return stoppedAfterModel;
    if (turn.kind === "final") {
      this.addEvent(task, "plan_step_completed", "Return a visible result", { status: "completed" });
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
      const metadata = await this.describeToolCall(task, call, assessment);
      this.addEvent(task, "plan_step_started", `Use ${call.toolName}`, {
        toolCallId: call.id,
        toolName: call.toolName,
        riskCategory: assessment.category
      });
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

      await this.createCheckpointForTool(task, call, assessment);
      await this.store.saveTask(task);
      const result = await this.executeTool(task.id, call);
      const latest = await this.requiredTask(task.id);
      this.addToolResultEvent(latest, call, result);
      this.addEvent(latest, result.ok ? "plan_step_completed" : "plan_step_blocked", `${call.toolName}: ${result.ok ? "completed" : "blocked"}`, {
        toolCallId: call.id,
        toolName: call.toolName,
        ok: result.ok
      });
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
    this.contextAssembler.cleanupTask(task.id);
  }

  private async recordPromptCacheStats(task: TaskDetail, usage?: ModelUsage): Promise<void> {
    const preferences = await this.store.getPreferences();
    const provider = await this.resolveModelProviderConfig();
    const previous = await this.store.listPromptCacheStats(task.id);
    const transcript = task.events
      .filter((event) => event.type !== "assistant_delta" && event.type !== "thinking_delta")
      .map((event) => `${event.type}: ${event.summary}`)
      .join("\n");
    const estimatedInputTokens = Math.max(1, approximateTokenCount(transcript) + 600);
    const inputTokens = usage?.inputTokens ?? estimatedInputTokens;
    const stablePrefixTokens = Math.min(inputTokens, approximateTokenCount([
      preferences.agentRole,
      preferences.agentTone,
      preferences.responseDetail,
      preferences.language,
      task.workRoot,
      task.folderId
    ].filter(Boolean).join("\n")) + 450);
    const cachedTokens = usage?.cachedTokens ?? (previous.length > 0 ? Math.min(stablePrefixTokens, inputTokens) : 0);
    const stats: PromptCacheStats = {
      id: createId("prompt_cache_stats"),
      taskId: task.id,
      providerId: provider?.providerId,
      model: provider?.model ?? "local-fallback",
      policy: "auto_savings",
      source: usage?.raw ? "provider" : "estimated",
      inputTokens,
      cachedTokens,
      cacheHitRatio: cachedTokens / Math.max(1, inputTokens),
      estimatedSavings: cachedTokens * 0.00000025,
      ...(usage?.raw ? { providerUsage: usage.raw } : {}),
      createdAt: nowIso()
    };
    await this.store.savePromptCacheStats(stats);
    this.addEvent(task, "prompt_cache_stats", cachedTokens > 0 ? `Prompt cache estimated ${Math.round(stats.cacheHitRatio * 100)}% reusable prefix.` : "Prompt cache baseline recorded.", {
      statsId: stats.id,
      providerId: stats.providerId,
      model: stats.model,
      inputTokens: stats.inputTokens,
      cachedTokens: stats.cachedTokens,
      cacheHitRatio: stats.cacheHitRatio,
      estimatedSavings: stats.estimatedSavings
    });
  }

  private async safeModelNext(task: TaskDetail): Promise<Awaited<ReturnType<ModelClient["next"]>> | null> {
    let retriedAfterOverflow = false;
    while (true) {
      const streamId = createId("model_stream");
      const controller = new AbortController();
      this.runningModelControllers.set(task.id, controller);
      try {
        const turn = await this.model.next(task, {
          streamId,
          signal: controller.signal,
          onAssistantDelta: async (delta) => {
            await this.addStreamingDelta(task, "assistant_delta", delta, streamId, controller.signal);
          },
          onThinkingDelta: async (delta) => {
            await this.addStreamingDelta(task, "thinking_delta", delta, streamId, controller.signal);
          }
        });
        await this.recordPromptCacheStats(task, turn.usage);
        this.addConversationSummaryEvents(task);
        return turn;
      } catch (error) {
        if (controller.signal.aborted) return null;
        const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
        if (!retriedAfterOverflow && isContextOverflowError(message)) {
          retriedAfterOverflow = true;
          this.addEvent(task, "context_overflow_recovered", "Context exceeded the active model window; older context was compacted and the request was retried once.", {
            reason: message
          });
          await this.store.saveTask(task);
          continue;
        }
        this.addConversationSummaryEvents(task);
        this.addEvent(task, "assistant_message", `Model provider failed: ${message}`);
        this.setStatus(task, "failed");
        await this.updateLoadedSkillStats(task, false);
        await this.store.saveTask(task);
        return null;
      } finally {
        if (this.runningModelControllers.get(task.id) === controller) {
          this.runningModelControllers.delete(task.id);
        }
      }
    }
  }

  private async addStreamingDelta(
    task: TaskDetail,
    type: "assistant_delta" | "thinking_delta",
    delta: string,
    streamId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return;
    const current = await this.store.getTask(task.id);
    if (!current || current.status !== "running" || signal.aborted) return;
    this.addEvent(current, type, delta, { streamId, delta });
    if (signal.aborted) return;
    await this.store.saveTask(current);
    Object.assign(task, current);
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
      folderId: "default",
      workRoot: findWorkspaceRoot(),
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
    const task = await this.requiredTask(taskId);
    const controller = new AbortController();
    this.runningToolControllers.set(taskId, controller);
    try {
      return await this.tools.execute(call, { signal: controller.signal, workRoot: task.workRoot });
    } finally {
      if (this.runningToolControllers.get(taskId) === controller) {
        this.runningToolControllers.delete(taskId);
      }
    }
  }

  private async createCheckpointForTool(task: TaskDetail, call: ToolCall, assessment: RiskAssessment): Promise<TaskCheckpoint | undefined> {
    if (assessment.category !== "workspace_write" && assessment.category !== "destructive") return undefined;
    const now = nowIso();
    const checkpointId = createId("checkpoint");
    const files =
      call.toolName === "edit_file"
        ? await this.snapshotExplicitToolFile(checkpointId, task, String(call.args["path"] ?? ""))
        : await this.snapshotWorkRootTextFiles(checkpointId, task);
    const checkpoint: TaskCheckpoint = {
      id: checkpointId,
      taskId: task.id,
      workRoot: task.workRoot || findWorkspaceRoot(),
      toolCallId: call.id,
      toolName: call.toolName,
      reason: `${assessment.category}: ${call.toolName}`,
      files: files.files,
      truncated: files.truncated,
      createdAt: now
    };
    await this.store.saveTaskCheckpoint(checkpoint);
    this.addEvent(task, "task_checkpoint_created", `Checkpoint created before ${call.toolName}.`, {
      checkpointId,
      toolCallId: call.id,
      toolName: call.toolName,
      workRoot: checkpoint.workRoot,
      fileCount: checkpoint.files.length,
      truncated: checkpoint.truncated
    });
    return checkpoint;
  }

  private async snapshotExplicitToolFile(
    checkpointId: string,
    task: TaskDetail,
    inputPath: string
  ): Promise<{ files: TaskCheckpoint["files"]; truncated: boolean }> {
    if (!inputPath.trim()) return { files: [], truncated: false };
    const fullPath = resolveTaskPath(task.workRoot || findWorkspaceRoot(), inputPath);
    return { files: [await this.snapshotPath(checkpointId, task.workRoot || findWorkspaceRoot(), fullPath, 0)], truncated: false };
  }

  private async snapshotWorkRootTextFiles(
    checkpointId: string,
    task: TaskDetail
  ): Promise<{ files: TaskCheckpoint["files"]; truncated: boolean }> {
    const root = resolve(task.workRoot || findWorkspaceRoot());
    const candidates = await collectCheckpointCandidates(root, 80, 2_000_000);
    const files = [];
    for (let index = 0; index < candidates.files.length; index += 1) {
      files.push(await this.snapshotPath(checkpointId, root, candidates.files[index]!, index));
    }
    return { files, truncated: candidates.truncated };
  }

  private async snapshotPath(checkpointId: string, workRoot: string, fullPath: string, index: number): Promise<TaskCheckpoint["files"][number]> {
    const root = resolve(workRoot || findWorkspaceRoot());
    const normalized = resolveTaskPath(root, fullPath);
    const relativePath = relative(root, normalized) || basename(normalized);
    const info = await stat(normalized).catch(() => null);
    if (!info?.isFile()) {
      return { path: normalized, relativePath, existed: false, size: 0 };
    }
    const before = await readFile(normalized);
    const snapshotPath = resolve(findWorkspaceRoot(), "data", "checkpoints", checkpointId, `${String(index).padStart(3, "0")}-${sanitizeFileName(relativePath)}`);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, before);
    return {
      path: normalized,
      relativePath,
      existed: true,
      beforeHash: createHash("sha256").update(before).digest("hex").slice(0, 16),
      size: before.byteLength,
      snapshotPath
    };
  }

  private async restoreCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint): Promise<TaskRollbackResult> {
    let restoredFiles = 0;
    let deletedFiles = 0;
    let skippedFiles = 0;
    for (const file of checkpoint.files) {
      const target = resolveTaskPath(checkpoint.workRoot || task.workRoot || findWorkspaceRoot(), file.path);
      if (file.existed && file.snapshotPath) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file.snapshotPath, target);
        restoredFiles += 1;
      } else if (!file.existed) {
        const exists = await stat(target).catch(() => null);
        if (exists?.isFile()) {
          await unlink(target);
          deletedFiles += 1;
        } else {
          skippedFiles += 1;
        }
      } else {
        skippedFiles += 1;
      }
    }
    return { taskId: task.id, checkpointId: checkpoint.id, restoredFiles, deletedFiles, skippedFiles, createdAt: nowIso() };
  }

  private async deleteTaskCheckpointArtifacts(checkpoint: TaskCheckpoint): Promise<void> {
    const root = resolve(findWorkspaceRoot(), "data", "checkpoints", checkpoint.id);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  private cancelRunningTool(taskId: string): void {
    this.runningToolControllers.get(taskId)?.abort();
  }

  private cancelRunningTask(taskId: string): void {
    this.runningModelControllers.get(taskId)?.abort();
    this.cancelRunningTool(taskId);
  }

  private async describeToolCall(task: TaskDetail, call: ToolCall, assessment: RiskAssessment): Promise<Record<string, unknown>> {
    const providerMetadata = (await this.toolRiskProvider?.describeToolCall?.(call)) ?? {};
    return {
      riskCategory: assessment.category,
      argsPreview: previewArgs(call.args),
      workRoot: task.workRoot,
      resolvedCwd: resolve(task.workRoot || findWorkspaceRoot(), String(call.args["cwd"] ?? ".")),
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
    const toolEvent = task.events[task.events.length - 1]!;
    if (call.toolName === "web_search") {
      this.addEvent(task, "web_search_result", result.ok ? "Search evidence returned" : "Search failed", {
        toolCallId: result.toolCallId,
        ok: result.ok,
        output: result.output
      });
    }
    this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(toolEvent);
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

  private addConversationSummaryEvents(task: TaskDetail): void {
    for (const summary of this.contextAssembler.drainConversationSummaryEvents(task.id)) {
      this.addEvent(task, "conversation_summary_created", "Earlier context was compacted into an auditable summary.", {
        summaryId: summary.id,
        rangeStartEventId: summary.rangeStartEventId,
        rangeEndEventId: summary.rangeEndEventId,
        tokenEstimate: summary.tokenEstimate,
        reason: summary.reason,
        retainedFacts: summary.retainedFacts,
        droppedRanges: summary.droppedRanges,
        tokenBudget: summary.tokenBudget
      });
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

  private async resolveModelProviderConfig(): Promise<ResolvedModelProviderConfig | null> {
    const preferences = await this.store.getPreferences();
    const providers = (await this.store.listModelProviders()).filter((provider) => provider.enabled);
    const provider =
      providers.find((item) => item.id === preferences.activeModelProviderId) ??
      providers.find((item) => item.apiKeyRef) ??
      null;
    if (!provider?.apiKeyRef) return null;
    const encrypted = await this.store.getModelProviderSecret(provider.id);
    if (!encrypted) return null;
    return {
      providerId: provider.id,
      protocol: provider.protocol,
      apiKey: this.secretBox.decrypt(encrypted),
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      model: provider.defaultModelId
    };
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

  private async attachUploadedFiles(task: TaskDetail, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const existingBytes = (await this.store.listTaskAttachments(task.id)).reduce((sum, attachment) => sum + attachment.size, 0);
    let nextBytes = existingBytes;
    for (const attachmentId of [...new Set(attachmentIds)]) {
      const attachment = await this.store.getTaskAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      if (attachment.taskId && attachment.taskId !== task.id) throw new Error(`Attachment already belongs to another task: ${attachmentId}`);
      nextBytes += attachment.size;
      if (nextBytes > taskAttachmentLimits().maxTaskBytes) {
        throw new Error(`Task attachments exceed ${Math.round(taskAttachmentLimits().maxTaskBytes / 1024 / 1024)}MB limit.`);
      }
      const updated: TaskAttachment = { ...attachment, taskId: task.id, updatedAt: nowIso() };
      await this.store.saveTaskAttachment(updated);
      this.addEvent(task, "attachment_added", updated.fileName, {
        attachmentId: updated.id,
        fileName: updated.fileName,
        mimeType: updated.mimeType,
        size: updated.size,
        kind: updated.kind,
        contentHash: updated.contentHash,
        textPreview: updated.textPreview
      });
    }
  }
}

function initialIntegrationStatus(kind: IntegrationKind, callbackUrl?: string): IntegrationProviderConfig["status"] {
  if (kind === "feishu" && !callbackUrl) return "setup_pending";
  return "connected";
}

function parseFeishuMessageText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const text = parsed["text"] ?? parsed["content"];
    return typeof text === "string" ? text.trim() : content.trim();
  } catch {
    return content.trim();
  }
}

function approximateTokenCount(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 4);
}

function sanitizeProviderError(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\btp-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]");
}

function isContextOverflowError(input: string): boolean {
  return /context( window| length)?|maximum context|too many tokens|token limit|exceed(?:ed|s)?[^.]{0,80}token|prompt[^.]{0,40}too long|reduce[^.]{0,40}tokens/i.test(input);
}

async function fetchWithTimeout(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function generateTaskTitleWithProvider(provider: ResolvedModelProviderConfig, goal: string, language?: string): Promise<string> {
  const isChinese = prefersChinese(language, goal);
  const instruction = isChinese
    ? "为用户任务生成一个简短中文标题。只输出标题，8到18个汉字，不要引号、编号、Markdown 或解释。"
    : "Generate a short task title. Output only the title, 3 to 6 words, no quotes, numbering, Markdown, or explanation.";
  if (provider.protocol === "anthropic_messages") {
    const response = await fetchWithTimeout(`${provider.baseURL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 48,
        system: instruction,
        messages: [{ role: "user", content: goal }]
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json()) as Record<string, unknown>;
    const parts = Array.isArray(payload["content"]) ? payload["content"] : [];
    return parts.map((part) => (typeof part === "object" && part ? String((part as Record<string, unknown>)["text"] ?? "") : "")).join(" ");
  }
  if (provider.protocol === "gemini") {
    const base = provider.baseURL || "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetchWithTimeout(`${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: goal }] }]
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json()) as Record<string, unknown>;
    const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
    const first = candidates[0] as Record<string, unknown> | undefined;
    const content = first?.["content"] as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.["parts"]) ? content.parts : [];
    return parts.map((part) => (typeof part === "object" && part ? String((part as Record<string, unknown>)["text"] ?? "") : "")).join(" ");
  }
  const base = provider.baseURL || "https://api.openai.com/v1";
  const response = await fetchWithTimeout(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 48,
      temperature: 0.2,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: goal }
      ]
    })
  });
  if (!response.ok) throw new Error(await response.text());
  const payload = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.["message"] as Record<string, unknown> | undefined;
  return String(message?.["content"] ?? "");
}

export function createLocalTaskTitle(goal: string, language?: string): string {
  const compact = goal.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (prefersChinese(language, compact)) {
    const cleaned = compact.replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’`~@#$%^&*_+=|\\/<>-]/g, "").trim();
    return cleaned.slice(0, 18) || "新任务";
  }
  const words = compact.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.length > 0 ? words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") : "New Task";
}

function normalizeGeneratedTaskTitle(raw: string, goal: string, language?: string): string {
  const candidate = raw
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
    .find(Boolean) ?? "";
  const stripped = candidate.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  if (!stripped) return createLocalTaskTitle(goal, language);
  if (prefersChinese(language, `${stripped} ${goal}`)) {
    const cleaned = stripped.replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’`~@#$%^&*_+=|\\/<>-]/g, "").replace(/\s+/g, "");
    return (cleaned || createLocalTaskTitle(goal, language)).slice(0, 18);
  }
  return stripped.split(/\s+/).slice(0, 6).join(" ") || createLocalTaskTitle(goal, language);
}

function prefersChinese(language: string | undefined, text: string): boolean {
  return language?.toLowerCase().startsWith("zh") || /[\u4e00-\u9fa5]/.test(text);
}

function defaultTaskFolder(): TaskFolderRecord {
  const now = nowIso();
  const rootPath = findWorkspaceRoot();
  return {
    id: "default",
    name: "Default",
    rootPath,
    isDefault: true,
    exists: true,
    lastValidatedAt: now,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };
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

function taskAttachmentLimits(): { maxFileBytes: number; maxTaskBytes: number } {
  return {
    maxFileBytes: Number(process.env["SCC_ATTACHMENT_MAX_FILE_BYTES"] ?? 20 * 1024 * 1024),
    maxTaskBytes: Number(process.env["SCC_ATTACHMENT_MAX_TASK_BYTES"] ?? 100 * 1024 * 1024)
  };
}

function classifyAttachment(fileName: string, mimeType: string): TaskAttachmentKind {
  const ext = extname(fileName).toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("pdf") || ext === ".pdf") return "pdf";
  if (/word|excel|powerpoint|officedocument/i.test(mimeType) || [".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(ext)) return "office";
  if (mimeType.includes("json") || [".json", ".csv", ".tsv"].includes(ext)) return "data";
  if (mimeType.includes("markdown") || ext === ".md") return "markdown";
  if (mimeType.startsWith("text/") || [".txt", ".log"].includes(ext)) return "text";
  if ([".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".yaml", ".yml", ".toml"].includes(ext)) return "code";
  return "binary";
}

function sanitizeFileName(fileName: string): string {
  return basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180) || "attachment.bin";
}

function resolveTaskPath(workRoot: string, input: string): string {
  if (!input.trim()) throw new Error("Missing path.");
  const resolvedRoot = resolve(workRoot || findWorkspaceRoot());
  const full = resolve(resolvedRoot, input);
  const compareRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const compareFull = process.platform === "win32" ? full.toLowerCase() : full;
  if (compareFull !== compareRoot && !compareFull.startsWith(compareRoot + sep)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  return full;
}

async function collectCheckpointCandidates(
  workRoot: string,
  maxFiles: number,
  maxBytes: number
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  async function visit(dir: string): Promise<void> {
    if (files.length >= maxFiles || totalBytes >= maxBytes) {
      truncated = true;
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= maxBytes) {
        truncated = true;
        return;
      }
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage" || entry.name === "data" || entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !isCheckpointTextFile(full)) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > 256_000) continue;
      totalBytes += info.size;
      files.push(full);
    }
  }
  await visit(resolve(workRoot));
  return { files, truncated };
}

function isCheckpointTextFile(path: string): boolean {
  return /\.(cjs|css|html|js|json|jsx|md|mjs|ts|tsx|txt|yml|yaml|xml|csv)$/i.test(path);
}

async function buildAttachmentTextPreview(storagePath: string, kind: TaskAttachmentKind, mimeType: string): Promise<string | undefined> {
  if (!["text", "markdown", "code", "data"].includes(kind) && !mimeType.startsWith("text/")) return undefined;
  const content = await readFile(storagePath, "utf8").catch(() => "");
  if (!content) return undefined;
  return content.slice(0, 6000);
}

function createScheduleFromInput(
  input: {
    scheduleKind?: "calendar" | "interval" | undefined;
    frequency?: "daily" | "weekly" | "monthly" | undefined;
    timeOfDay?: string | undefined;
    intervalHours?: number | undefined;
    intervalMinutes?: number | undefined;
  },
  fallback?: ScheduledTask["schedule"]
): ScheduledTask["schedule"] {
  const kind = input.scheduleKind ?? (fallback?.kind === "interval" ? "interval" : "calendar");
  if (kind === "interval") {
    const intervalMinutes =
      input.intervalMinutes !== undefined || input.intervalHours !== undefined
        ? (input.intervalHours ?? 0) * 60 + (input.intervalMinutes ?? 0)
        : fallback?.intervalMinutes ?? 60;
    return {
      kind: "interval",
      intervalMinutes: Math.min(720, Math.max(1, intervalMinutes))
    };
  }
  return {
    kind: "calendar",
    frequency: input.frequency ?? fallback?.frequency ?? "daily",
    timeOfDay: input.timeOfDay ?? fallback?.timeOfDay ?? "09:00"
  };
}

function computeNextRunAt(schedule: ScheduledTask["schedule"], from = new Date()): string {
  if (schedule.kind === "once" && schedule.runAt) return new Date(schedule.runAt).toISOString();
  if (schedule.kind === "interval" && schedule.intervalMinutes) {
    return new Date(from.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  const [hour, minute] = parseTimeOfDay(schedule.timeOfDay ?? "09:00");
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    if (schedule.frequency === "monthly") next.setMonth(next.getMonth() + 1);
    else if (schedule.frequency === "weekly") next.setDate(next.getDate() + 7);
    else next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function parseTimeOfDay(value: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return [9, 0];
  return [Number(match[1]), Number(match[2])];
}

function advanceScheduledTask(task: ScheduledTask, lastTaskId: string | undefined, now: Date, lastRunSummary?: string): ScheduledTask {
  const updatedAt = nowIso();
  if (task.schedule.kind === "interval" && task.schedule.intervalMinutes) {
    return {
      ...task,
      ...(lastTaskId ? { lastTaskId } : {}),
      lastRunAt: now.toISOString(),
      ...(lastRunSummary ? { lastRunSummary } : {}),
      lastError: undefined,
      nextRunAt: new Date(now.getTime() + task.schedule.intervalMinutes * 60_000).toISOString(),
      updatedAt
    };
  }
  if (task.schedule.kind === "calendar") {
    return {
      ...task,
      ...(lastTaskId ? { lastTaskId } : {}),
      lastRunAt: now.toISOString(),
      ...(lastRunSummary ? { lastRunSummary } : {}),
      lastError: undefined,
      nextRunAt: computeNextRunAt(task.schedule, now),
      updatedAt
    };
  }
  return {
    ...task,
    status: "completed",
    ...(lastTaskId ? { lastTaskId } : {}),
    lastRunAt: now.toISOString(),
    ...(lastRunSummary ? { lastRunSummary } : {}),
    lastError: undefined,
    nextRunAt: now.toISOString(),
    updatedAt
  };
}

function isDefaultReflectionSchedule(task: ScheduledTask): boolean {
  return task.id === "schedule_agent_reflection" || task.type === "reflection";
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 32);
}
