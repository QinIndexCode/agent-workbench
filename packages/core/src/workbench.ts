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
  TaskTurn,
  TaskTurnRevertResult,
  TaskTurnEditRequest,
  TaskPatchRequest,
  TaskCheckpoint,
  TaskRollbackFileChange,
  TaskRollbackPreview,
  TaskRollbackRequest,
  TaskRollbackResult,
  TaskTitleRequest,
  TaskTitleResponse,
  TaskAttachment,
  TaskAttachmentKind,
  TaskAttachmentUploadRequest,
  SkillCreateRequest,
  SkillCuratorItem,
  SkillDuplicateGroup,
  SkillMergeRequest,
  SkillRecord,
  SkillUpdateRequest,
  TaskDeleteRequest,
  TaskDeleteResult,
  TaskDetail,
  TaskEvent,
  MemoryDocument,
  MemoryDocumentPatch,
  MemoryDocumentCompactResult,
  ToolApproval,
  ToolCall,
  ToolResult,
  UserPreferences,
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
import { LocalSecretBox, maskSecret, sanitizeSensitiveText, sanitizeSensitiveValue } from "./secrets.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { ShellToolExecutor, type ToolExecutor } from "./tools.js";
import { createWebSearchApiKeyRef } from "./web-search.js";
import { defaultTaskWorkRoot, findWorkspaceRoot } from "./workspace-root.js";

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

interface PreparedToolCall {
  call: ToolCall;
  assessment: RiskAssessment;
}

const MAX_MODEL_TURNS_PER_TASK = 24;
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_STATE_ONLY_TOOL_TURNS = 2;
const MAX_PARALLEL_READ_ONLY_TOOLS = 4;

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
  private readonly deltaLocks = new Map<string, Promise<void>>();
  private readonly runningModelControllers = new Map<string, AbortController>();
  private readonly runningToolControllers = new Map<string, Set<AbortController>>();

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(this.store);
    this.toolRiskProvider = options.toolRiskProvider;
    this.onEvent = options.onEvent;
  }

  async createTask(goal: string, title?: string, folderId = "default", attachmentIds: string[] = []): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, await this.resolveTaskTitle(goal, title), folderId, attachmentIds);
    return this.runTaskExclusive(task.id, () => this.step(task.id));
  }

  async startTask(goal: string, title?: string, folderId = "default", attachmentIds: string[] = []): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, await this.resolveTaskTitle(goal, title), folderId, attachmentIds);
    void this.runTaskExclusive(task.id, () => this.step(task.id)).catch((error) => {
      this.safeBackgroundCatch(task.id, error);
    });
    return task;
  }

  private async resolveTaskTitle(goal: string, title?: string, language?: string): Promise<string> {
    const explicit = title?.trim();
    if (explicit) return explicit;
    try {
      return (await this.generateTaskTitle({ goal, useLocalFallback: false, ...(language ? { language } : {}) })).title;
    } catch {
      return createLocalTaskTitle(goal, language);
    }
  }

  private async initializeTask(goal: string, title: string, folderId: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    const folder = await this.resolveTaskFolder(folderId);
    const task = this.emptyTask(title);
    task.folderId = folder.id;
    task.workRoot = folder.rootPath;
    this.addEvent(task, "task_created", "Task created");
    await this.beginTaskTurn(task, goal, "user_message");
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
    const provider = await this.resolveModelProviderConfig("title_generation");
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
    const full = resolve(rootPath?.trim() || defaultTaskWorkRoot());
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Folder path must exist and be a directory: ${full}`);
    return full;
  }

  private async refreshFolderStatus(folder: TaskFolderRecord): Promise<TaskFolderRecord> {
    const rootPath = resolve(folder.rootPath?.trim() || defaultTaskWorkRoot());
    const exists = Boolean((await stat(rootPath).catch(() => null))?.isDirectory());
    return {
      ...folder,
      rootPath,
      exists,
      isDefault: folder.id === "default" || Boolean(folder.isDefault),
      lastValidatedAt: nowIso()
    };
  }

  private async readMemoryDocument(scope: "user", folder?: TaskFolderRecord): Promise<MemoryDocument>;
  private async readMemoryDocument(scope: "project", folder: TaskFolderRecord): Promise<MemoryDocument>;
  private async readMemoryDocument(scope: "user" | "project", folder?: TaskFolderRecord): Promise<MemoryDocument> {
    const descriptor = memoryDescriptor(scope, folder);
    const content = await readFile(descriptor.path, "utf8").catch(() => defaultMemoryContent(scope, folder));
    return {
      scope,
      ...(folder ? { folderId: folder.id, workRoot: folder.rootPath } : {}),
      path: descriptor.path,
      fileName: descriptor.fileName,
      content: limitMemoryContent(content, descriptor.charLimit, descriptor.entryCharLimit),
      charLimit: descriptor.charLimit,
      entryCharLimit: descriptor.entryCharLimit,
      updatedAt: nowIso()
    };
  }

  private async writeMemoryDocument(scope: "user", content: string, folder?: TaskFolderRecord): Promise<MemoryDocument>;
  private async writeMemoryDocument(scope: "project", content: string, folder: TaskFolderRecord): Promise<MemoryDocument>;
  private async writeMemoryDocument(scope: "user" | "project", content: string, folder?: TaskFolderRecord): Promise<MemoryDocument> {
    const descriptor = memoryDescriptor(scope, folder);
    const limited = limitMemoryContent(content, descriptor.charLimit, descriptor.entryCharLimit);
    await mkdir(dirname(descriptor.path), { recursive: true });
    await writeFile(descriptor.path, limited, "utf8");
    return {
      scope,
      ...(folder ? { folderId: folder.id, workRoot: folder.rootPath } : {}),
      path: descriptor.path,
      fileName: descriptor.fileName,
      content: limited,
      charLimit: descriptor.charLimit,
      entryCharLimit: descriptor.entryCharLimit,
      updatedAt: nowIso()
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
      for (const turn of await this.store.listTaskTurns(taskId)) {
        await this.store.deleteTaskTurn(turn.id);
      }
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
      this.cleanupToolOutputs(task);

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

  async previewTaskRollback(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackPreview> {
    const task = await this.requiredTask(taskId);
    const checkpoint = await this.resolveRollbackCheckpoint(task, input.checkpointId);
    const files = await this.previewCheckpointFiles(task, checkpoint, input.filePaths);
    return {
      taskId,
      checkpointId: checkpoint.id,
      workRoot: checkpoint.workRoot,
      files,
      restorableFiles: files.filter((file) => file.canRollback && (file.status === "modified" || file.status === "deleted")).length,
      deletableFiles: files.filter((file) => file.canRollback && file.status === "created").length,
      skippedFiles: files.filter((file) => !file.canRollback || file.status === "unchanged" || file.status === "skipped").length,
      createdAt: nowIso()
    };
  }

  async rollbackTask(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackResult> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      const checkpoint = await this.resolveRollbackCheckpoint(task, input.checkpointId);
      try {
        const result = await this.restoreCheckpointFiles(task, checkpoint, input.filePaths);
        this.addEvent(task, "task_rollback_completed", `Rolled back ${result.restoredFiles + result.deletedFiles} file changes.`, {
          checkpointId: checkpoint.id,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          skippedFiles: result.skippedFiles,
          workRoot: checkpoint.workRoot,
          files: result.files
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

  private async resolveRollbackCheckpoint(task: TaskDetail, checkpointId?: string): Promise<TaskCheckpoint> {
    const checkpoint = checkpointId
      ? await this.store.getTaskCheckpoint(checkpointId)
      : this.buildTaskRollbackCheckpoint(task, await this.store.listTaskCheckpoints(task.id));
    if (!checkpoint || checkpoint.taskId !== task.id) throw new Error("No checkpoint is available for this task.");
    return checkpoint;
  }

  private buildTaskRollbackCheckpoint(task: TaskDetail, checkpoints: TaskCheckpoint[]): TaskCheckpoint | undefined {
    if (checkpoints.length === 0) return undefined;
    const ordered = [...checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const earliestByPath = new Map<string, TaskCheckpoint["files"][number]>();
    for (const checkpoint of ordered) {
      const root = resolve(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot());
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

  async getUserProfileDocument(): Promise<MemoryDocument> {
    return this.readMemoryDocument("user");
  }

  async updateUserProfileDocument(input: MemoryDocumentPatch): Promise<MemoryDocument> {
    return this.writeMemoryDocument("user", input.content);
  }

  async getProjectMemoryDocument(folderId = "default"): Promise<MemoryDocument> {
    const folder = await this.resolveTaskFolder(folderId);
    return this.readMemoryDocument("project", folder);
  }

  async updateProjectMemoryDocument(folderId: string, input: MemoryDocumentPatch): Promise<MemoryDocument> {
    const folder = await this.resolveTaskFolder(folderId);
    return this.writeMemoryDocument("project", input.content, folder);
  }

  async compactProjectMemoryDocument(folderId = "default"): Promise<MemoryDocumentCompactResult> {
    const folder = await this.resolveTaskFolder(folderId);
    const before = await this.readMemoryDocument("project", folder);
    const compacted = compactMemoryMarkdown(before.content, before.charLimit, before.entryCharLimit);
    const after = await this.writeMemoryDocument("project", compacted.content, folder);
    return {
      document: after,
      beforeChars: before.content.length,
      afterChars: after.content.length,
      removedLines: compacted.removedLines
    };
  }

  async listTaskTurns(taskId: string): Promise<TaskTurn[]> {
    const task = await this.requiredTask(taskId);
    return this.withComputedTurnEnds(task, await this.store.listTaskTurns(taskId));
  }

  async appendMessage(taskId: string, content: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      await this.attachUploadedFiles(task, attachmentIds);
      if (task.status === "running" || task.status === "waiting_approval") {
        await this.beginTaskTurn(task, content, "guidance_pending", { status: "pending" });
        await this.store.saveTask(task);
        return task;
      }
      await this.beginTaskTurn(task, content, "user_message");
      this.setStatus(task, "running");
      await this.store.saveTask(task);
      return this.step(task.id);
    });
  }

  async revertTaskTurn(taskId: string, turnId: string): Promise<TaskTurnRevertResult> {
    return this.runTaskExclusive(taskId, async () => this.revertTaskTurnUnlocked(taskId, turnId));
  }

  async editTaskTurn(taskId: string, turnId: string, input: TaskTurnEditRequest): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      await this.revertTaskTurnUnlocked(taskId, turnId);
      const task = await this.requiredTask(taskId);
      await this.attachUploadedFiles(task, input.attachmentIds ?? []);
      await this.beginTaskTurn(task, input.content, "user_message");
      this.addEvent(task, "turn_edit_submitted", "Edited user turn submitted", { previousTurnId: turnId });
      this.setStatus(task, "running");
      await this.store.saveTask(task);
      return this.step(task.id);
    });
  }

  private async beginTaskTurn(
    task: TaskDetail,
    content: string,
    eventType: "user_message" | "guidance_pending",
    payload: Record<string, unknown> = {}
  ): Promise<TaskTurn> {
    const now = nowIso();
    const turnId = createId("turn");
    const startEvent = this.addEvent(task, "turn_started", "User turn started", { turnId });
    const userEvent = this.addEvent(task, eventType, content, { ...payload, turnId });
    const turn: TaskTurn = {
      id: turnId,
      taskId: task.id,
      startEventId: startEvent.id,
      userEventId: userEvent.id,
      originalContent: content,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveTaskTurn(turn);
    return turn;
  }

  private async revertTaskTurnUnlocked(taskId: string, turnId: string): Promise<TaskTurnRevertResult> {
    const task = await this.requiredTask(taskId);
    const turns = this.withComputedTurnEnds(task, await this.store.listTaskTurns(taskId));
    const turn = turns.find((item) => item.id === turnId);
    if (!turn) throw new Error(`Task turn not found: ${turnId}`);
    if (turn.status === "reverted") {
      const hasLaterActiveTurn = turns.some((item) => item.status === "active" && item.createdAt.localeCompare(turn.createdAt) > 0);
      if (hasLaterActiveTurn) throw new Error("Only the latest active user turn can be reverted.");
      return {
        task,
        turn,
        draft: turn.originalContent,
        revertedEventCount: 0,
        irreversibleEventCount: 0
      };
    }
    const latestActive = [...turns].reverse().find((item) => item.status === "active");
    if (latestActive?.id !== turn.id) throw new Error("Only the latest active user turn can be reverted.");

    if (task.status === "running" || task.status === "waiting_approval") {
      this.cancelRunningTask(task.id);
      this.setStatus(task, "paused");
    }

    const range = this.turnEventRange(task, turn);
    const checkpointIds = new Set(
      range
        .filter((event) => event.type === "task_checkpoint_created")
        .map((event) => String(event.payload["checkpointId"] ?? ""))
        .filter(Boolean)
    );
    const rollback = await this.rollbackTurnCheckpoints(task, [...checkpointIds]);
    const irreversibleEventCount = range.filter(isIrreversibleTurnEvent).length;
    const now = nowIso();
    const revertedTurn: TaskTurn = {
      ...turn,
      status: "reverted",
      revertedAt: now,
      updatedAt: now
    };
    for (const event of range) event.reverted = true;
    this.addEvent(task, "turn_reverted", "Latest user turn was reverted for editing.", {
      turnId: turn.id,
      revertedEventCount: range.length,
      irreversibleEventCount,
      ...(rollback ? { rollback } : {})
    });
    if (rollback && rollback.skippedFiles > 0) {
      this.addEvent(task, "rollback_partial", "Some files or side effects could not be fully reverted.", {
        turnId: turn.id,
        skippedFiles: rollback.skippedFiles,
        irreversibleEventCount
      });
    }
    await this.store.saveTaskTurn(revertedTurn);
    await this.store.saveTask(task);
    return {
      task,
      turn: revertedTurn,
      draft: turn.originalContent,
      revertedEventCount: range.length,
      irreversibleEventCount,
      ...(rollback ? { rollback } : {})
    };
  }

  private withComputedTurnEnds(task: TaskDetail, turns: TaskTurn[]): TaskTurn[] {
    const ordered = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ordered.map((turn, index) => {
      const next = ordered[index + 1];
      if (!next) return { ...turn, endEventId: task.events.at(-1)?.id ?? turn.userEventId };
      const nextStartIndex = task.events.findIndex((event) => event.id === next.startEventId);
      const endEvent = nextStartIndex > 0 ? task.events[nextStartIndex - 1] : undefined;
      return { ...turn, endEventId: endEvent?.id ?? turn.userEventId };
    });
  }

  private turnEventRange(task: TaskDetail, turn: TaskTurn): TaskEvent[] {
    const startIndex = task.events.findIndex((event) => event.id === turn.startEventId);
    if (startIndex < 0) return [];
    const endIndex = turn.endEventId ? task.events.findIndex((event) => event.id === turn.endEventId) : task.events.length - 1;
    return task.events.slice(startIndex, endIndex >= startIndex ? endIndex + 1 : task.events.length);
  }

  private async rollbackTurnCheckpoints(task: TaskDetail, checkpointIds: string[]): Promise<TaskRollbackResult | undefined> {
    const checkpoints = (await Promise.all(checkpointIds.map((id) => this.store.getTaskCheckpoint(id)))).filter((item): item is TaskCheckpoint => Boolean(item));
    if (checkpoints.length === 0) return undefined;
    const checkpoint = this.buildTaskRollbackCheckpoint(task, checkpoints);
    if (!checkpoint) return undefined;
    const result = await this.restoreCheckpointFiles(task, checkpoint);
    this.addEvent(task, "task_rollback_completed", `Rolled back ${result.restoredFiles + result.deletedFiles} file changes for reverted turn.`, {
      checkpointId: checkpoint.id,
      restoredFiles: result.restoredFiles,
      deletedFiles: result.deletedFiles,
      skippedFiles: result.skippedFiles,
      workRoot: checkpoint.workRoot,
      files: result.files
    });
    return result;
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
        const preferences = await this.store.getPreferences();
        this.addEvent(task, "tool_result", "Tool denied by user", {
          toolCallId: approval.toolCall.id,
          toolName: approval.toolCall.toolName,
          args: this.sanitizeForPreferences(approval.toolCall.args, preferences),
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
      await this.addToolResultEvent(latest, approval.toolCall, result);
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

  async listSkillCuratorItems(): Promise<SkillCuratorItem[]> {
    const now = nowIso();
    const [skills, duplicates, conflicts, memories] = await Promise.all([
      this.listSkills(),
      this.listSkillDuplicates(),
      this.listSkillConflicts(),
      this.listTaskMemories()
    ]);
    const items: SkillCuratorItem[] = [];

    for (const skill of skills) {
      const oneOffSignals = /current machine|当前机器|single run|one-off|一次性|prior task result/i.test(skill.body);
      const reason =
        skill.status === "candidate"
          ? "Candidate skills require user review before they influence future tasks."
          : skill.status === "active"
            ? "Active skills are available for matching when relevant."
            : skill.status === "suspended"
              ? "Suspended skills are retained but not injected."
              : "Retired skills are kept for audit only.";
      items.push({
        id: `skill_${skill.id}`,
        kind: skill.status === "active" ? "active" : "candidate",
        title: skill.title,
        status: oneOffSignals ? "needs_review" : skill.status,
        reason: oneOffSignals ? "The body looks like it may contain one-off task output or machine state." : reason,
        recommendation:
          skill.status === "candidate"
            ? "Review applicability, remove one-off result text, then activate if it describes a reusable method."
            : oneOffSignals
              ? "Edit the body into reusable steps before keeping this skill active."
              : "Keep monitoring success rate and consecutive failures.",
        skillIds: [skill.id],
        memoryIds: skill.sourceMemoryIds,
        confidence: skill.applicability.minConfidence,
        createdAt: skill.createdAt || now
      });
    }

    for (const group of duplicates) {
      items.push({
        id: `duplicate_${group.fingerprint}`,
        kind: "duplicate",
        title: group.skills[0]?.title ?? "Duplicate skill group",
        status: "needs_review",
        reason: group.reason,
        recommendation: "Merge duplicate skills into the canonical record so future matching stays predictable.",
        skillIds: group.skills.map((skill) => skill.id),
        memoryIds: [],
        createdAt: now
      });
    }

    for (const conflict of conflicts.filter((item) => item.status === "open")) {
      items.push({
        id: `conflict_${conflict.id}`,
        kind: "conflict",
        title: "Skill conflict",
        status: "needs_review",
        reason: conflict.reason,
        recommendation: "Resolve by editing, suspending, or merging the conflicting skills. SCC will not auto-merge conflicts.",
        skillIds: conflict.skillIds,
        memoryIds: [],
        createdAt: conflict.createdAt
      });
    }

    for (const memory of memories.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 16)) {
      const reusable =
        memory.assessment.goalAchieved &&
        memory.assessment.confidence >= 0.75 &&
        memory.toolsUsed.length > 0 &&
        memory.meta.complexity !== "simple" &&
        memory.meta.outcome === "success";
      if (reusable) continue;
      items.push({
        id: `memory_${memory.id}`,
        kind: "low_value_memory",
        title: memory.title,
        status: "not_promoted",
        reason: memory.assessment.goalAchieved
          ? "This memory is useful as history, but it is too simple or too task-specific to become a skill."
          : "The task did not complete cleanly, so it is kept as memory rather than promoted.",
        recommendation: "Keep as task memory unless the pattern repeats across several successful tasks.",
        skillIds: [],
        memoryIds: [memory.id],
        confidence: memory.assessment.confidence,
        createdAt: memory.createdAt
      });
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
            this.safeBackgroundCatch(task.id, error);
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
    const task = await this.initializeTask(text, await this.resolveTaskTitle(text), provider.defaultFolderId || "default");
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
    let modelTurns = 0;
    let stateOnlyTurns = 0;

    while (task.status === "running") {
      if (modelTurns >= MAX_MODEL_TURNS_PER_TASK) {
        await this.pauseTaskForLoop(task, `Paused after ${MAX_MODEL_TURNS_PER_TASK} model turns in one task run. Ask for guidance or continue with a narrower step.`);
        return task;
      }

      this.consumePendingGuidance(task);
      await this.store.saveTask(task);
      const modelTurn = await this.safeModelNext(task);
      this.addLoadedSkillEvents(task);
      if (!modelTurn) return task;
      modelTurns += 1;

      const stoppedAfterModel = await this.stoppedTask(task.id);
      if (stoppedAfterModel) return stoppedAfterModel;
      const turn = this.normalizeInlineToolMarkupTurn(task, modelTurn);
      if (turn.kind === "final") {
        this.addEvent(task, "assistant_message", turn.message, turn.streamId ? { streamId: turn.streamId } : {});
        this.setStatus(task, "completed");
        await this.recordExperience(task);
        await this.store.saveTask(task);
        return task;
      }

      const { executable, skipped } = limitToolCallsPerTurn(turn.calls);
      for (const skippedCall of skipped) {
        await this.addToolResultEvent(task, skippedCall, failedToolResult(skippedCall, `Tool not executed: exceeded the per-turn limit of ${MAX_TOOL_CALLS_PER_TURN} tool calls.`));
      }
      if (skipped.length > 0) await this.store.saveTask(task);

      const stateOnlyBatch = executable.length > 0 && executable.every((call) => isManagedStateTool(call.toolName));
      stateOnlyTurns = stateOnlyBatch ? stateOnlyTurns + 1 : 0;
      if (stateOnlyTurns > MAX_STATE_ONLY_TOOL_TURNS) {
        await this.pauseTaskForLoop(task, `Paused after ${MAX_STATE_ONLY_TOOL_TURNS} repeated state-only tool turns to avoid a no-progress loop.`);
        return task;
      }

      const latest = await this.processToolCalls(task, executable);
      if (!latest) return task;
      Object.assign(task, latest);
    }

    return task;
  }

  private normalizeInlineToolMarkupTurn(task: TaskDetail, turn: Awaited<ReturnType<ModelClient["next"]>>): Awaited<ReturnType<ModelClient["next"]>> {
    if (turn.kind !== "final") return turn;
    const calls = extractInlineToolCallsFromMessage(turn.message);
    if (calls.length === 0) return turn;
    if (turn.streamId) this.hideAssistantStreamDeltas(task, turn.streamId);
    return {
      kind: "tool_calls",
      calls,
      ...(turn.streamId ? { streamId: turn.streamId } : {}),
      ...(turn.usage ? { usage: turn.usage } : {})
    };
  }

  private hideAssistantStreamDeltas(task: TaskDetail, streamId: string): void {
    for (const event of task.events) {
      if (event.type !== "assistant_delta") continue;
      if (String(event.payload["streamId"] ?? "") !== streamId) continue;
      event.payload = { ...event.payload, uiHidden: true };
    }
  }

  private async processToolCalls(task: TaskDetail, calls: ToolCall[]): Promise<TaskDetail | null> {
    if (calls.length === 0) return task;
    const preferences = await this.store.getPreferences();
    const globalGrants = await this.store.listGlobalPermissions();
    const prepared: PreparedToolCall[] = [];

    for (const call of calls) {
      const stoppedBeforeTool = await this.stoppedTask(task.id);
      if (stoppedBeforeTool) return stoppedBeforeTool;

      if (call.toolName === "plan_update") {
        const result = await this.executeTool(task.id, call);
        const latest = await this.requiredTask(task.id);
        await this.addToolResultEvent(latest, call, result);
        await this.store.saveTask(latest);
        Object.assign(task, latest);
        continue;
      }

      const assessment = (await this.toolRiskProvider?.assessTool(call)) ?? this.permissions.assess(call.toolName, call.args);
      const metadata = await this.describeToolCall(task, call, assessment);
      const eventArgs = this.sanitizeForPreferences(call.args, preferences);
      const eventMetadata = this.sanitizeForPreferences(metadata, preferences);
      this.addEvent(task, "tool_requested", call.toolName, {
        toolCallId: call.id,
        toolName: call.toolName,
        args: eventArgs,
        riskCategory: assessment.category,
        ...eventMetadata
      });

      if (this.permissions.isGloballyAllowed(assessment.category, globalGrants)) {
        this.addEvent(task, "approval_auto_granted", `${assessment.category}: global permission`, {
          toolCallId: call.id,
          toolName: call.toolName,
          riskCategory: assessment.category,
          ...eventMetadata
        });
      } else {
        const preferenceGrant = this.preferenceAutoApproval(call, assessment.category, preferences);
        if (preferenceGrant.allowed) {
          this.addEvent(task, "approval_auto_granted", `${assessment.category}: ${preferenceGrant.reason}`, {
            toolCallId: call.id,
            toolName: call.toolName,
            riskCategory: assessment.category,
            approvalSource: preferenceGrant.source,
            ...eventMetadata
          });
        } else if (
          preferenceGrant.forceApproval ||
          this.permissions.needsApproval(assessment.category, this.stateFor(task.id, task))
        ) {
          const approval = this.permissions.createApproval({ taskId: task.id, toolCall: call, assessment, metadata: eventMetadata });
          task.approvals.push(approval);
          await this.addApprovalPendingEvent(task, approval);
          this.setStatus(task, "waiting_approval");
          await this.store.saveTask(task);
          return task;
        }
      }

      prepared.push({ call, assessment });
    }

    await this.store.saveTask(task);
    const canRunInParallel =
      prepared.length > 1 &&
      prepared.every(({ call, assessment }) => isParallelSafeToolCall(call, assessment.category));

    if (canRunInParallel) {
      const results = await runWithConcurrency(prepared, MAX_PARALLEL_READ_ONLY_TOOLS, async ({ call }) => this.executeTool(task.id, call));
      for (const [index, result] of results.entries()) {
        const latest = await this.requiredTask(task.id);
        const item = prepared[index];
        if (!item) continue;
        await this.addToolResultEvent(latest, item.call, result);
        await this.store.saveTask(latest);
        if (latest.status !== "running") return latest;
      }
      return this.requiredTask(task.id);
    }

    for (const item of prepared) {
      await this.createCheckpointForTool(task, item.call, item.assessment);
      await this.store.saveTask(task);
      const result = await this.executeTool(task.id, item.call);
      const latest = await this.requiredTask(task.id);
      await this.addToolResultEvent(latest, item.call, result);
      await this.store.saveTask(latest);
      if (latest.status !== "running") return latest;
      Object.assign(task, latest);
    }

    return task;
  }

  private async pauseTaskForLoop(task: TaskDetail, message: string): Promise<void> {
    this.addEvent(task, "assistant_message", message);
    this.setStatus(task, "paused");
    await this.store.saveTask(task);
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
          },
          onProviderFallback: async (event) => {
            const current = (await this.store.getTask(task.id)) ?? task;
            this.addEvent(current, "provider_fallback", `Fallback to ${event.toModel}`, {
              streamId,
              ...event
            });
            await this.store.saveTask(current);
            Object.assign(task, current);
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
        this.addEvent(task, "assistant_message", formatProviderFailureMessage(message, await this.store.getPreferences()), {
          errorKind: "model_provider_failed",
          rawMessage: message
        });
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
    const previous = this.deltaLocks.get(task.id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.deltaLocks.set(task.id, queued);
    await previous.catch(() => undefined);
    try {
      if (signal.aborted) return;
      const current = await this.store.getTask(task.id);
      if (!current || current.status !== "running" || signal.aborted) return;
      this.addEvent(current, type, delta, { streamId, delta });
      if (signal.aborted) return;
      await this.store.saveTask(current);
      Object.assign(task, current);
    } finally {
      release();
      if (this.deltaLocks.get(task.id) === queued) this.deltaLocks.delete(task.id);
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

  private safeBackgroundCatch(taskId: string, error: unknown): void {
    void this.failBackgroundRun(taskId, error).catch(() => undefined);
  }

  private async failBackgroundRun(taskId: string, error: unknown): Promise<void> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task || task.status !== "running") return;
      const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
      this.addEvent(task, "assistant_message", `Runtime failed: ${message}`);
      this.setStatus(task, "failed");
      try { await this.updateLoadedSkillStats(task, false); } catch { /* best-effort */ }
      try { await this.store.saveTask(task); } catch { /* best-effort */ }
    } catch {
      // final safety net — never let an error here become unhandled
    }
  }

  private emptyTask(title: string): TaskDetail {
    const id = createId("task");
    const now = nowIso();
    return {
      id,
      title,
      folderId: "default",
      workRoot: defaultTaskWorkRoot(),
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
    const controllers = this.runningToolControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.runningToolControllers.set(taskId, controllers);
    try {
      const managed = await this.executeManagedTool(task, call);
      if (managed) {
        await this.store.saveTask(task);
        return managed;
      }
      return await this.tools.execute(call, { signal: controller.signal, workRoot: task.workRoot });
    } catch (error) {
      const preferences = await this.store.getPreferences().catch(() => undefined);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const prefix = controller.signal.aborted ? "Tool execution cancelled" : "Tool execution failed";
      const message = `${prefix}: ${rawMessage || "Unknown error."}`;
      return failedToolResult(call, preferences?.sanitizeSensitiveData === false ? message : sanitizeSensitiveText(message));
    } finally {
      const current = this.runningToolControllers.get(taskId);
      if (current) {
        current.delete(controller);
        if (current.size === 0) {
          this.runningToolControllers.delete(taskId);
        }
      }
    }
  }

  private async executeManagedTool(task: TaskDetail, call: ToolCall): Promise<ToolResult | undefined> {
    if (!isManagedStateTool(call.toolName)) return undefined;
    try {
      switch (call.toolName) {
        case "use_skill":
          return await this.executeUseSkillTool(task, call);
        case "user_memory_add":
          return await this.executeMemoryAddTool(call, "user");
        case "user_memory_edit":
          return await this.executeMemoryEditTool(call, "user");
        case "user_memory_delete":
          return await this.executeMemoryDeleteTool(call, "user");
        case "project_memory_add":
          return await this.executeMemoryAddTool(call, "project", await this.folderForMemoryTool(task, call));
        case "project_memory_edit":
          return await this.executeMemoryEditTool(call, "project", await this.folderForMemoryTool(task, call));
        case "project_memory_delete":
          return await this.executeMemoryDeleteTool(call, "project", await this.folderForMemoryTool(task, call));
        case "skill_create":
          return await this.executeSkillCreateTool(call);
        case "skill_edit":
          return await this.executeSkillEditTool(call);
        case "skill_delete":
          return await this.executeSkillDeleteTool(call);
        case "plan_update":
          return this.executePlanUpdateTool(task, call);
        default:
          return undefined;
      }
    } catch (error) {
      return managedToolResult(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async executeUseSkillTool(task: TaskDetail, call: ToolCall): Promise<ToolResult> {
    const skillId = String(call.args["skillId"] ?? call.args["name"] ?? call.args["title"] ?? "").trim();
    if (!skillId) throw new Error("skillId or name is required.");
    const skill = await this.contextAssembler.loadSkill(task.id, skillId);
    this.addLoadedSkillEvents(task);
    if (!skill) return managedToolResult(call, false, `Skill not found or unavailable: ${skillId}`);
    return managedToolResult(
      call,
      true,
      JSON.stringify({
        skillId: skill.id,
        title: skill.title,
        status: skill.status,
        body: skill.body.slice(0, 2400)
      })
    );
  }

  private async executeMemoryAddTool(
    call: ToolCall,
    scope: "user" | "project",
    folder?: TaskFolderRecord
  ): Promise<ToolResult> {
    const content = normalizeMemoryEntry(String(call.args["content"] ?? ""));
    if (!content) throw new Error("content is required.");
    const section = typeof call.args["section"] === "string" ? call.args["section"] : undefined;
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    const updatedContent = appendMemoryEntry(before.content, content, section);
    const after =
      scope === "project"
        ? await this.writeMemoryDocument("project", updatedContent, requiredFolder(folder))
        : await this.writeMemoryDocument("user", updatedContent);
    return managedToolResult(call, true, JSON.stringify(memoryToolOutput("added", after, content)));
  }

  private async executeMemoryEditTool(
    call: ToolCall,
    scope: "user" | "project",
    folder?: TaskFolderRecord
  ): Promise<ToolResult> {
    const match = String(call.args["match"] ?? "").trim();
    const replacement = normalizeMemoryEntry(String(call.args["replacement"] ?? ""));
    if (!match) throw new Error("match is required.");
    if (!replacement) throw new Error("replacement is required.");
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    const updatedContent = replaceMemoryEntry(before.content, match, replacement);
    const after =
      scope === "project"
        ? await this.writeMemoryDocument("project", updatedContent, requiredFolder(folder))
        : await this.writeMemoryDocument("user", updatedContent);
    return managedToolResult(call, true, JSON.stringify(memoryToolOutput("edited", after, replacement)));
  }

  private async executeMemoryDeleteTool(
    call: ToolCall,
    scope: "user" | "project",
    folder?: TaskFolderRecord
  ): Promise<ToolResult> {
    const match = String(call.args["match"] ?? "").trim();
    if (!match) throw new Error("match is required.");
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    const updatedContent = deleteMemoryEntry(before.content, match);
    const after =
      scope === "project"
        ? await this.writeMemoryDocument("project", updatedContent, requiredFolder(folder))
        : await this.writeMemoryDocument("user", updatedContent);
    return managedToolResult(call, true, JSON.stringify(memoryToolOutput("deleted", after, match)));
  }

  private async executeSkillCreateTool(call: ToolCall): Promise<ToolResult> {
    const title = String(call.args["title"] ?? "").trim();
    const body = String(call.args["body"] ?? "").trim();
    if (!title) throw new Error("title is required.");
    if (!body) throw new Error("body is required.");
    const status = parseSkillStatus(call.args["status"]);
    const skill = await this.createSkill({
      title,
      body,
      status: status ?? "candidate",
      applicability: {
        description: String(call.args["description"] ?? `Tasks similar to: ${title}`),
        requiredTools: stringsFromUnknown(call.args["requiredTools"]),
        requiredContext: stringsFromUnknown(call.args["requiredContext"]),
        exclusions: stringsFromUnknown(call.args["exclusions"]),
        keywords: stringsFromUnknown(call.args["keywords"])
      },
      sourceMemoryIds: [],
      relatedPatterns: []
    });
    return managedToolResult(call, true, JSON.stringify({ action: "created", skillId: skill.id, title: skill.title, status: skill.status }));
  }

  private async executeSkillDeleteTool(call: ToolCall): Promise<ToolResult> {
    const skillId = String(call.args["skillId"] ?? "").trim();
    const title = String(call.args["title"] ?? "").trim();
    const skill = skillId ? await this.store.getSkill(skillId) : await this.findSkillByTitle(title);
    if (!skill) throw new Error(skillId ? `Skill not found: ${skillId}` : `Skill not found by title: ${title}`);
    await this.deleteSkill(skill.id);
    return managedToolResult(call, true, JSON.stringify({ action: "deleted", skillId: skill.id, title: skill.title }));
  }

  private async executeSkillEditTool(call: ToolCall): Promise<ToolResult> {
    const skillId = String(call.args["skillId"] ?? "").trim();
    const title = String(call.args["title"] ?? "").trim();
    const skill = skillId ? await this.store.getSkill(skillId) : await this.findSkillByTitle(title);
    if (!skill) throw new Error(skillId ? `Skill not found: ${skillId}` : `Skill not found by title: ${title}`);
    const status = parseSkillStatus(call.args["status"]);
    const applicabilityPatch = {
      ...(typeof call.args["description"] === "string" ? { description: String(call.args["description"]) } : {}),
      ...(Array.isArray(call.args["requiredTools"]) ? { requiredTools: stringsFromUnknown(call.args["requiredTools"]) } : {}),
      ...(Array.isArray(call.args["requiredContext"]) ? { requiredContext: stringsFromUnknown(call.args["requiredContext"]) } : {}),
      ...(Array.isArray(call.args["exclusions"]) ? { exclusions: stringsFromUnknown(call.args["exclusions"]) } : {}),
      ...(Array.isArray(call.args["keywords"]) ? { keywords: stringsFromUnknown(call.args["keywords"]) } : {})
    };
    const updated = await this.updateSkill(skill.id, {
      ...(typeof call.args["newTitle"] === "string" ? { title: String(call.args["newTitle"]).trim() } : {}),
      ...(typeof call.args["body"] === "string" ? { body: String(call.args["body"]).trim() } : {}),
      ...(status ? { status } : {}),
      ...(Object.keys(applicabilityPatch).length > 0 ? { applicability: applicabilityPatch } : {})
    });
    return managedToolResult(call, true, JSON.stringify({ action: "edited", skillId: updated.id, title: updated.title, status: updated.status }));
  }

  private executePlanUpdateTool(task: TaskDetail, call: ToolCall): ToolResult {
    const status = parsePlanStatus(call.args["status"]);
    const context = typeof call.args["context"] === "string" ? String(call.args["context"]).trim() : "";
    const steps = planStepsFromUnknown(call.args["steps"]);
    this.addEvent(task, "plan_revised", context || (status === "empty" || steps.length === 0 ? "Plan cleared" : "Plan updated"), {
      status: status ?? (steps.length > 0 ? "running" : "empty"),
      context,
      steps
    });
    return managedToolResult(call, true, JSON.stringify({ action: "plan_updated", status: status ?? "running", stepCount: steps.length }));
  }

  private async findSkillByTitle(title: string): Promise<SkillRecord | undefined> {
    if (!title.trim()) return undefined;
    const normalized = title.trim().toLowerCase();
    const skills = await this.store.listSkills();
    return (
      skills.find((skill) => skill.title.trim().toLowerCase() === normalized) ??
      skills.find((skill) => skill.title.trim().toLowerCase().includes(normalized))
    );
  }

  private async folderForMemoryTool(task: TaskDetail, call: ToolCall): Promise<TaskFolderRecord> {
    const folderId = String(call.args["folderId"] ?? task.folderId ?? "default").trim() || "default";
    return this.resolveTaskFolder(folderId);
  }

  private async createCheckpointForTool(task: TaskDetail, call: ToolCall, assessment: RiskAssessment): Promise<TaskCheckpoint | undefined> {
    if (assessment.category !== "workspace_write" && assessment.category !== "destructive") return undefined;
    if (isManagedStateTool(call.toolName)) return undefined;
    const now = nowIso();
    const checkpointId = createId("checkpoint");
    const files =
      call.toolName === "edit_file" || call.toolName === "write_file"
        ? await this.snapshotExplicitToolFile(checkpointId, task, String(call.args["path"] ?? ""))
        : await this.snapshotWorkRootTextFiles(checkpointId, task);
    const checkpoint: TaskCheckpoint = {
      id: checkpointId,
      taskId: task.id,
      workRoot: task.workRoot || defaultTaskWorkRoot(),
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
    const fullPath = resolveTaskPath(task.workRoot || defaultTaskWorkRoot(), inputPath);
    return { files: [await this.snapshotPath(checkpointId, task.workRoot || defaultTaskWorkRoot(), fullPath, 0)], truncated: false };
  }

  private async snapshotWorkRootTextFiles(
    checkpointId: string,
    task: TaskDetail
  ): Promise<{ files: TaskCheckpoint["files"]; truncated: boolean }> {
    const root = resolve(task.workRoot || defaultTaskWorkRoot());
    const candidates = await collectCheckpointCandidates(root, 80, 2_000_000);
    const files = [];
    for (let index = 0; index < candidates.files.length; index += 1) {
      files.push(await this.snapshotPath(checkpointId, root, candidates.files[index]!, index));
    }
    return { files, truncated: candidates.truncated };
  }

  private async snapshotPath(checkpointId: string, workRoot: string, fullPath: string, index: number): Promise<TaskCheckpoint["files"][number]> {
    const root = resolve(workRoot || defaultTaskWorkRoot());
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

  private async restoreCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint, filePaths?: string[]): Promise<TaskRollbackResult> {
    let restoredFiles = 0;
    let deletedFiles = 0;
    let skippedFiles = 0;
    const files = await this.previewCheckpointFiles(task, checkpoint, filePaths);
    const selected = this.filterCheckpointFiles(task, checkpoint, filePaths);
    for (const file of selected) {
      const target = resolveTaskPath(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot(), file.path);
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
    return {
      taskId: task.id,
      checkpointId: checkpoint.id,
      workRoot: checkpoint.workRoot,
      files,
      restoredFiles,
      deletedFiles,
      skippedFiles,
      createdAt: nowIso()
    };
  }

  private filterCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint, filePaths?: string[]): TaskCheckpoint["files"] {
    if (!filePaths || filePaths.length === 0) return checkpoint.files;
    const root = resolve(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot());
    const requested = new Set(
      filePaths.map((filePath) => {
        const normalized = resolveTaskPath(root, filePath);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      })
    );
    return checkpoint.files.filter((file) => {
      const target = resolveTaskPath(root, file.path);
      const key = process.platform === "win32" ? target.toLowerCase() : target;
      return requested.has(key);
    });
  }

  private async previewCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint, filePaths?: string[]): Promise<TaskRollbackFileChange[]> {
    const root = resolve(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot());
    const selected = this.filterCheckpointFiles(task, checkpoint, filePaths);
    const changes: TaskRollbackFileChange[] = [];
    for (const file of selected) {
      const target = resolveTaskPath(root, file.path);
      const relativePath = relative(root, target) || basename(target);
      const info = await stat(target).catch(() => null);
      const existsNow = Boolean(info?.isFile());
      const current = existsNow ? await readFile(target).catch(() => null) : null;
      const currentHash = current ? createHash("sha256").update(current).digest("hex").slice(0, 16) : undefined;
      const sizeNow = current?.byteLength ?? 0;
      let status: TaskRollbackFileChange["status"] = "skipped";
      let canRollback = false;
      let reason: string | undefined;

      if (file.existed) {
        if (!file.snapshotPath) {
          status = "skipped";
          reason = "The checkpoint does not have a snapshot for this file.";
        } else if (!existsNow) {
          status = "deleted";
          canRollback = true;
        } else if (file.beforeHash && currentHash === file.beforeHash) {
          status = "unchanged";
          reason = "The current file already matches the checkpoint snapshot.";
        } else {
          status = "modified";
          canRollback = true;
        }
      } else if (existsNow) {
        status = "created";
        canRollback = true;
      } else {
        status = "unchanged";
        reason = "The file did not exist at checkpoint time and does not exist now.";
      }

      changes.push({
        path: target,
        relativePath,
        status,
        existedBefore: file.existed,
        existsNow,
        canRollback,
        ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
        ...(currentHash ? { currentHash } : {}),
        sizeBefore: file.size,
        sizeNow,
        ...(reason ? { reason } : {})
      });
    }
    return changes;
  }

  private async deleteTaskCheckpointArtifacts(checkpoint: TaskCheckpoint): Promise<void> {
    const root = resolve(findWorkspaceRoot(), "data", "checkpoints", checkpoint.id);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  private cleanupToolOutputs(task: TaskDetail): void {
    const dir = resolve(task.workRoot || defaultTaskWorkRoot(), "data", "tool-output");
    const resultIds = new Set<string>();
    for (const event of task.events) {
      if (event.type === "tool_result" && typeof event.payload["id"] === "string") {
        resultIds.add(event.payload["id"]);
      }
    }
    for (const id of resultIds) {
      void rm(resolve(dir, `${id}.txt`), { force: true }).catch(() => undefined);
    }
  }

  private cancelRunningTool(taskId: string): void {
    const controllers = this.runningToolControllers.get(taskId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    this.runningToolControllers.delete(taskId);
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
      resolvedCwd: resolve(task.workRoot || defaultTaskWorkRoot(), String(call.args["cwd"] ?? ".")),
      ...inferBuiltInToolMetadata(call),
      ...providerMetadata
    };
  }

  private async addToolResultEvent(task: TaskDetail, call: ToolCall, result: ToolResult): Promise<void> {
    const preferences = await this.store.getPreferences();
    const output = this.sanitizeForPreferences(result.output, preferences);
    const args = this.sanitizeForPreferences(call.args, preferences);
    this.addEvent(task, "tool_result", result.ok ? "Tool completed" : "Tool failed", {
      id: result.id,
      toolCallId: result.toolCallId,
      toolName: call.toolName,
      args,
      ok: result.ok,
      output,
      ...(call.toolName === "plan_update" ? { uiHidden: true } : {})
    });
    const toolEvent = task.events[task.events.length - 1]!;
    if (call.toolName === "web_search") {
      this.addEvent(task, "web_search_result", result.ok ? "Search evidence returned" : "Search failed", {
        toolCallId: result.toolCallId,
        ok: result.ok,
        output
      });
    }
    this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(toolEvent);
  }

  private async addApprovalPendingEvent(task: TaskDetail, approval: ToolApproval): Promise<void> {
    const preferences = await this.store.getPreferences();
    const safeApproval = this.sanitizeForPreferences(approval, preferences);
    this.addEvent(task, "approval_pending", `${approval.riskCategory}: ${approval.toolCall.toolName}`, {
      approvalId: approval.id,
      approval: safeApproval,
      toolName: approval.toolCall.toolName,
      args: this.sanitizeForPreferences(approval.toolCall.args, preferences),
      riskCategory: approval.riskCategory,
      reason: approval.reason,
      ...this.sanitizeForPreferences(approval.metadata ?? {}, preferences)
    });
  }

  private sanitizeForPreferences<T>(value: T, preferences: UserPreferences): T {
    return preferences.sanitizeSensitiveData ? sanitizeSensitiveValue(value) : value;
  }

  private preferenceAutoApproval(
    call: ToolCall,
    category: RiskCategory,
    preferences: UserPreferences
  ): { allowed: boolean; forceApproval: boolean; reason?: string; source?: "mcpApprovalMode" | "autoApprove" } {
    if (category === "destructive") return { allowed: false, forceApproval: false };
    if (isMcpToolName(call.toolName)) {
      if (preferences.mcpApprovalMode === "confirm_each") {
        return { allowed: false, forceApproval: true };
      }
      if (preferences.mcpApprovalMode === "auto") {
        return {
          allowed: true,
          forceApproval: false,
          reason: "MCP preference auto-approve",
          source: "mcpApprovalMode"
        };
      }
      if (category === "host_observation" || category === "workspace_read") {
        return {
          allowed: true,
          forceApproval: false,
          reason: "MCP read-only preference",
          source: "mcpApprovalMode"
        };
      }
      return { allowed: false, forceApproval: false };
    }
    if (autoApproveAllows(preferences.autoApprove, category)) {
      return {
        allowed: true,
        forceApproval: false,
        reason: "preference auto-approve",
        source: "autoApprove"
      };
    }
    return { allowed: false, forceApproval: false };
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
  ): TaskEvent {
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
    return event;
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
        summary: summary.summary,
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

  private async resolveModelProviderConfig(purpose?: "title_generation"): Promise<ResolvedModelProviderConfig | null> {
    const preferences = await this.store.getPreferences();
    const providers = (await this.store.listModelProviders()).filter((provider) => provider.enabled);
    const route = preferences.modelRoute;
    const preferredIds = [
      purpose === "title_generation" ? route.titleGenerationProviderId : undefined,
      route.mainProviderId,
      preferences.activeModelProviderId
    ].filter((id): id is string => Boolean(id));
    const candidates = [
      ...preferredIds.map((id) => providers.find((item) => item.id === id)).filter((item): item is ModelProviderRecord => Boolean(item)),
      ...providers.filter((item) => item.apiKeyRef)
    ];
    const seen = new Set<string>();
    let main: ModelProviderRecord | undefined;
    let resolved: ResolvedModelProviderConfig | null = null;
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      resolved = await this.resolveStoredProvider(candidate);
      if (resolved) {
        main = candidate;
        break;
      }
    }
    if (!main || !resolved) return null;
    const fallbackIds = [...new Set(route.fallbackProviderIds.filter((id) => id !== main.id))];
    const fallbacks = (
      await Promise.all(
        fallbackIds
          .map((id) => providers.find((provider) => provider.id === id))
          .filter((provider): provider is ModelProviderRecord => Boolean(provider))
          .map((provider) => this.resolveStoredProvider(provider))
      )
    ).filter((provider): provider is ResolvedModelProviderConfig => Boolean(provider));
    return fallbacks.length > 0 ? { ...resolved, fallbacks } : resolved;
  }

  private async resolveStoredProvider(provider: ModelProviderRecord): Promise<ResolvedModelProviderConfig | null> {
    if (!provider.apiKeyRef) return null;
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

function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function autoApproveAllows(level: UserPreferences["autoApprove"], category: RiskCategory): boolean {
  if (category === "destructive") return false;
  if (level === "none") return false;
  if (level === "low") return category === "host_observation" || category === "workspace_read";
  if (level === "medium") return category === "host_observation" || category === "workspace_read" || category === "network";
  return category === "host_observation" || category === "workspace_read" || category === "workspace_write" || category === "shell" || category === "network";
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
  return sanitizeSensitiveText(input);
}

function formatProviderFailureMessage(message: string, preferences: UserPreferences): string {
  const zh = preferences.language === "zh-CN";
  if (/connection error|failed to fetch|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(message)) {
    return zh
      ? `模型服务连接失败（Model provider failed: ${message}）。请检查模型配置、Base URL、API Key 或网络状态，然后重试。`
      : `Model service connection failed (Model provider failed: ${message}). Check the model configuration, Base URL, API key, or network, then retry.`;
  }
  if (/no model provider|no provider|not configured/i.test(message)) {
    return zh
      ? `尚未配置可用模型（Model provider failed: ${message}）。请先添加或连接模型配置。`
      : `No usable model is configured (Model provider failed: ${message}). Add or connect a model configuration first.`;
  }
  return zh
    ? `模型服务请求失败（Model provider failed: ${message}）。请检查模型配置或稍后重试。`
    : `Model provider failed: ${message}`;
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
  const style = resolveTitleStyle(language, goal);
  const instruction = titleInstruction(style);
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
  const style = resolveTitleStyle(language, compact);
  if (style.kind === "zh") {
    const cleaned = cleanCjkTitle(firstTitleClause(compact));
    return truncateCjkTitle(cleaned, 22) || "新任务";
  }
  if (style.kind === "ja") {
    const cleaned = cleanCjkTitle(firstTitleClause(compact));
    return truncateCjkTitle(cleaned, 26) || "新しいタスク";
  }
  if (style.kind === "ko") {
    const cleaned = cleanCjkTitle(firstTitleClause(compact));
    return truncateCjkTitle(cleaned, 28) || "새 작업";
  }
  const words = compact.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 7);
  return words.length > 0 ? words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") : "New Task";
}

function normalizeGeneratedTaskTitle(raw: string, goal: string, language?: string): string {
  const style = resolveTitleStyle(language, goal);
  const candidate = raw
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
    .find(Boolean) ?? "";
  const stripped = candidate.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  if (!stripped) return createLocalTaskTitle(goal, language);
  if (style.kind === "zh") {
    const cleaned = cleanCjkTitle(stripped);
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 22);
  }
  if (style.kind === "ja") {
    const cleaned = cleanCjkTitle(stripped);
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 26);
  }
  if (style.kind === "ko") {
    const cleaned = cleanCjkTitle(stripped);
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 28);
  }
  return stripped.split(/\s+/).slice(0, 7).join(" ") || createLocalTaskTitle(goal, language);
}

type TitleStyle = { kind: "zh" | "ja" | "ko" | "latin"; languageName: string };

function resolveTitleStyle(language: string | undefined, text: string): TitleStyle {
  const normalized = language?.toLowerCase() ?? "";
  if (normalized.startsWith("zh")) return { kind: "zh", languageName: "Chinese" };
  if (normalized.startsWith("ja")) return { kind: "ja", languageName: "Japanese" };
  if (normalized.startsWith("ko")) return { kind: "ko", languageName: "Korean" };
  if (normalized && !normalized.startsWith("und")) return { kind: "latin", languageName: normalized };

  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
  const han = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []).length;
  if (kana > 0) return { kind: "ja", languageName: "Japanese" };
  if (hangul > 0) return { kind: "ko", languageName: "Korean" };
  if (han >= Math.max(2, latin)) return { kind: "zh", languageName: "Chinese" };
  return { kind: "latin", languageName: "the user's language" };
}

function titleInstruction(style: TitleStyle): string {
  switch (style.kind) {
    case "zh":
      return "为用户任务生成一个自然、简短的中文任务标题。只输出标题，通常 6 到 18 个汉字；保留必要英文技术名词如 API、MCP、RAG、MiMo；不要引号、编号、Markdown 或解释。";
    case "ja":
      return "ユーザーの依頼に合う自然で短い日本語のタスク名を作成してください。タイトルだけを出力し、通常 8〜24 文字程度にしてください。API、MCP、RAG など必要な技術語は保持し、引用符、番号、Markdown、説明は不要です。";
    case "ko":
      return "사용자 요청에 맞는 자연스럽고 짧은 한국어 작업 제목을 만드세요. 제목만 출력하고 보통 2~6어절로 작성하세요. API, MCP, RAG 같은 기술 용어는 유지하고 따옴표, 번호, Markdown, 설명은 쓰지 마세요.";
    case "latin":
      return `Generate a natural short task title in ${style.languageName}. Output only the title, usually 3 to 7 words. Preserve technical acronyms such as API, MCP, RAG, and MiMo. Do not use quotes, numbering, Markdown, or explanation.`;
  }
}

function firstTitleClause(text: string): string {
  return text.split(/[。！？；\n.!?;]/).map((part) => part.trim()).find(Boolean) ?? text;
}

function cleanCjkTitle(text: string): string {
  return text
    .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’`~@#$%^&*_+=|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCjkTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chars = [...text];
  return chars.slice(0, maxChars).join("").trim();
}

function defaultTaskFolder(): TaskFolderRecord {
  const now = nowIso();
  const rootPath = defaultTaskWorkRoot();
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
  const resolvedRoot = resolve(workRoot || defaultTaskWorkRoot());
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

function isIrreversibleTurnEvent(event: TaskEvent): boolean {
  const risk = String(event.payload["riskCategory"] ?? "");
  const toolName = String(event.payload["toolName"] ?? "");
  return (
    risk === "network" ||
    risk === "destructive" ||
    event.type === "integration_message_received" ||
    toolName.startsWith("mcp__")
  );
}

function memoryDescriptor(scope: "user" | "project", folder?: TaskFolderRecord): { path: string; fileName: string; charLimit: number; entryCharLimit: number } {
  const baseDir = memoryBaseDir();
  if (scope === "user") {
    return {
      path: resolve(baseDir, "USER.md"),
      fileName: "USER.md",
      charLimit: 6000,
      entryCharLimit: 280
    };
  }
  const root = folder?.rootPath || findWorkspaceRoot();
  return {
    path: resolve(baseDir, "projects", memoryPathHash(root), "MEMORY.md"),
    fileName: "MEMORY.md",
    charLimit: 12000,
    entryCharLimit: 280
  };
}

function memoryBaseDir(): string {
  return resolve(process.env["SCC_MEMORY_DIR"]?.trim() || resolve(findWorkspaceRoot(), "data", "memory"));
}

function memoryPathHash(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 20);
}

function defaultMemoryContent(scope: "user" | "project", folder?: TaskFolderRecord): string {
  if (scope === "user") {
    return [
      "# USER.md",
      "",
      "Stable user preferences for SCC. Keep entries short, durable, and broadly useful.",
      "",
      "## Preferences",
      "- Language: zh-CN unless the user asks otherwise.",
      "- Style: direct, careful, evidence-backed.",
      "",
      "## Long-term Constraints",
      "- Do not use scripted task quality gates or fixed report protocols to control ordinary agent work."
    ].join("\n");
  }
  return [
    "# MEMORY.md",
    "",
    `Project memory for ${folder?.name || "Default"}.`,
    folder?.rootPath ? `Work root: ${folder.rootPath}` : "",
    "",
    "## Key Facts",
    "- Keep only stable project facts, constraints, paths, and unresolved risks.",
    "",
    "## Open Risks",
    "- Add risks only when they remain relevant across future tasks."
  ].filter(Boolean).join("\n");
}

function limitMemoryContent(content: string, charLimit: number, entryCharLimit: number): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const limitedLines = lines.map((line) => {
    if (!/^\s*[-*]\s+/.test(line)) return line;
    return line.length <= entryCharLimit ? line : `${line.slice(0, Math.max(0, entryCharLimit - 3))}...`;
  });
  const limited = limitedLines.join("\n").trim();
  if (limited.length <= charLimit) return `${limited}\n`;
  return `${limited.slice(0, Math.max(0, charLimit - 80)).trim()}\n\n... (memory compacted to fit ${charLimit} characters)\n`;
}

function compactMemoryMarkdown(content: string, charLimit: number, entryCharLimit: number): { content: string; removedLines: number } {
  const seen = new Set<string>();
  let removedLines = 0;
  const lines = content.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [line];
    const normalized = trimmed.toLowerCase();
    if (/^\s*[-*]\s+/.test(line)) {
      const compacted = line.length <= entryCharLimit ? line : `${line.slice(0, Math.max(0, entryCharLimit - 3))}...`;
      const key = compacted.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) {
        removedLines += 1;
        return [];
      }
      seen.add(key);
      return [compacted];
    }
    if (seen.has(normalized) && !trimmed.startsWith("#")) {
      removedLines += 1;
      return [];
    }
    seen.add(normalized);
    return [line];
  });
  return { content: limitMemoryContent(lines.join("\n"), charLimit, entryCharLimit), removedLines };
}

function isManagedStateTool(toolName: string): boolean {
  return (
    toolName === "use_skill" ||
    toolName === "user_memory_add" ||
    toolName === "user_memory_edit" ||
    toolName === "user_memory_delete" ||
    toolName === "project_memory_add" ||
    toolName === "project_memory_edit" ||
    toolName === "project_memory_delete" ||
    toolName === "skill_create" ||
    toolName === "skill_edit" ||
    toolName === "skill_delete" ||
    toolName === "plan_update"
  );
}

function isParallelSafeToolCall(call: ToolCall, category: RiskCategory): boolean {
  if (isManagedStateTool(call.toolName)) return false;
  return category === "host_observation" || category === "workspace_read" || category === "network";
}

function limitToolCallsPerTurn(calls: ToolCall[]): { executable: ToolCall[]; skipped: ToolCall[] } {
  return {
    executable: calls.slice(0, MAX_TOOL_CALLS_PER_TURN),
    skipped: calls.slice(MAX_TOOL_CALLS_PER_TURN)
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  maxParallel: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    })
  );
  return results;
}

function extractInlineToolCallsFromMessage(message: string): ToolCall[] {
  if (!/<function_calls\b|<invoke\b/i.test(message)) return [];
  const calls: ToolCall[] = [];
  const invokePattern = /<invoke\s+name=(["'])(?<name>[^"']+)\1\s*>(?<body>[\s\S]*?)<\/invoke>/gi;
  for (const match of message.matchAll(invokePattern)) {
    const toolName = match.groups?.["name"]?.trim();
    if (!toolName) continue;
    const args: Record<string, unknown> = {};
    const body = match.groups?.["body"] ?? "";
    const parameterPattern = /<parameter\s+name=(["'])(?<name>[^"']+)\1\s*>(?<value>[\s\S]*?)<\/parameter>/gi;
    for (const parameter of body.matchAll(parameterPattern)) {
      const name = parameter.groups?.["name"]?.trim();
      if (!name) continue;
      args[name] = decodeXmlText((parameter.groups?.["value"] ?? "").trim());
    }
    calls.push({
      id: createId("tool_call"),
      toolName,
      args
    });
  }
  return calls;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function managedToolResult(call: ToolCall, ok: boolean, output: string): ToolResult {
  return {
    id: createId("tool_result"),
    toolCallId: call.id,
    ok,
    output,
    createdAt: nowIso()
  };
}

function failedToolResult(call: ToolCall, output: string): ToolResult {
  return managedToolResult(call, false, output);
}

function requiredFolder(folder?: TaskFolderRecord): TaskFolderRecord {
  if (!folder) throw new Error("A task folder is required for project memory tools.");
  return folder;
}

function normalizeMemoryEntry(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeMemorySection(section?: string): string {
  const cleaned = String(section ?? "").replace(/[#\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Agent Notes";
}

function appendMemoryEntry(content: string, entry: string, section?: string): string {
  const normalized = normalizeMemoryEntry(entry);
  if (!normalized) throw new Error("Memory entry is empty.");
  const bullet = `- ${normalized}`;
  if (content.toLowerCase().includes(bullet.toLowerCase())) return content;
  const heading = `## ${sanitizeMemorySection(section)}`;
  const lines = content.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (headingIndex < 0) {
    return `${lines.join("\n")}\n\n${heading}\n${bullet}\n`;
  }
  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") insertIndex += 1;
  lines.splice(insertIndex, 0, bullet);
  return `${lines.join("\n").trimEnd()}\n`;
}

function replaceMemoryEntry(content: string, match: string, replacement: string): string {
  const target = match.trim();
  const next = normalizeMemoryEntry(replacement);
  if (!target) throw new Error("match is required.");
  if (!next) throw new Error("replacement is empty.");
  if (content.includes(target)) return `${content.replace(target, next).trimEnd()}\n`;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.toLowerCase().includes(target.toLowerCase()));
  if (index < 0) throw new Error(`Memory entry not found: ${target}`);
  const prefix = /^\s*[-*]\s+/.test(lines[index] ?? "") ? "- " : "";
  lines[index] = `${prefix}${next}`;
  return `${lines.join("\n").trimEnd()}\n`;
}

function deleteMemoryEntry(content: string, match: string): string {
  const target = match.trim();
  if (!target) throw new Error("match is required.");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const filtered = lines.filter((line) => !line.toLowerCase().includes(target.toLowerCase()));
  if (filtered.length !== lines.length) return `${filtered.join("\n").trimEnd()}\n`;
  if (content.includes(target)) return `${content.replace(target, "").trimEnd()}\n`;
  throw new Error(`Memory entry not found: ${target}`);
}

function memoryToolOutput(action: "added" | "edited" | "deleted", document: MemoryDocument, subject: string): Record<string, unknown> {
  return {
    action,
    scope: document.scope,
    fileName: document.fileName,
    ...(document.folderId ? { folderId: document.folderId } : {}),
    ...(document.workRoot ? { workRoot: document.workRoot } : {}),
    subject,
    charLimit: document.charLimit,
    currentCharacters: document.content.length
  };
}

function stringsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 24);
}

function parseSkillStatus(value: unknown): SkillRecord["status"] | undefined {
  if (value === "candidate" || value === "active" || value === "suspended" || value === "retired") return value;
  return undefined;
}

function parsePlanStatus(value: unknown): "empty" | "planning" | "running" | "blocked" | "completed" | undefined {
  if (value === "empty" || value === "planning" || value === "running" || value === "blocked" || value === "completed") return value;
  return undefined;
}

function planStepsFromUnknown(value: unknown): Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, index) => {
      const status = parseStepStatus(item["status"]);
      const title = String(item["title"] ?? "").trim();
      if (!title) return null;
      const detail = typeof item["detail"] === "string" ? item["detail"].trim() : "";
      return {
        id: String(item["id"] ?? `plan_step_${index + 1}`),
        title,
        status,
        ...(detail ? { detail } : {})
      };
    })
    .filter((item): item is { id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string } => Boolean(item))
    .slice(0, 12);
}

function parseStepStatus(value: unknown): "pending" | "running" | "completed" | "blocked" {
  if (value === "running" || value === "completed" || value === "blocked") return value;
  return "pending";
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 32);
}
