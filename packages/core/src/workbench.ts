import type {
  ApprovalDecision,
  ConversationSummary,
  ExperienceRecord,
  EncryptedSecretRef,
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
  KnowledgeModelDownloadRequest,
  KnowledgeModelDownloadResult,
  KnowledgeModelStatus,
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
  ProjectMemoryPatchRequest,
  ReflectionSession,
  RiskCategory,
  SlackEventRequest,
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
  TaskChildSummary,
  TaskDelegationExpectedOutput,
  TaskDelegationMeta,
  TaskKind,
  TaskMemory,
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
  TelegramUpdateRequest,
  MemoryDocument,
  MemoryDocumentPatch,
  MemoryDocumentCompactResult,
  ToolApproval,
  ToolCall,
  ToolResult,
  UserPreferences,
  WecomCallbackRequest,
  WebSearchProviderConfig,
  WebSearchProviderCreateRequest,
  WebSearchProviderPatchRequest
} from "@agent-workbench/shared";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
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
import { FallbackModelClient, type ModelClient, type ModelTraceEvent, type ModelUsage } from "./fallback-model.js";
import { createId, nowIso } from "./ids.js";
import {
  decryptWecomPayload,
  describeIntegrationSource,
  ensureFeishuVerificationToken,
  extractDiscordUserId,
  extractFeishuSenderId,
  extractSlackUserId,
  extractTelegramUserId,
  extractWecomSenderId,
  initialIntegrationStatus,
  looksReadOnlySkillBody,
  parseDiscordInteractionText,
  parseFeishuMessageText,
  parseSlackEventText,
  parseTelegramMessageText,
  parseWecomCallbackXml,
  parseWecomMessageText,
  verifyDiscordRequestSignature,
  verifySlackRequestSignature,
  verifyTelegramSecretToken,
  verifyWecomSignature
} from "./integrations.js";
import { indexKnowledgeItem, searchKnowledge } from "./knowledge-rag.js";
import { downloadKnowledgeModelAsset, getKnowledgeModelStatus } from "./knowledge-models.js";
import { assessReadOnlyNoProgress } from "./no-progress-guard.js";
import type { ResolvedModelProviderConfig } from "./openai-model.js";
import { PermissionEngine, type PermissionState, type RiskAssessment } from "./permission-engine.js";
import { canonicalizeExistingDirectory, resolveWorkspacePathStrict } from "./path-guards.js";
import { LocalSecretBox, maskSecret, sanitizeSensitiveText, sanitizeSensitiveValue } from "./secrets.js";
import { InMemoryWorkbenchStore, type WorkbenchStore } from "./store.js";
import { completionBlocker, taskGraphFromEvents, verificationResultFromToolEvent } from "./task-graph.js";
import { hasUserTurn, latestUserText } from "./task-events.js";
import { ShellToolExecutor, type ToolExecutor, type ToolProgressUpdate } from "./tools.js";
import { compactToolProgressUpdate, summarizeEventForTrace, summarizeToolProgressForTrace, TaskTraceRecorder } from "./trace-recorder.js";
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
  traceRoot?: string;
}

interface PreparedToolCall {
  call: ToolCall;
  assessment: RiskAssessment;
}

const MAX_MODEL_TURNS_PER_TASK = 24;
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_STATE_ONLY_TOOL_TURNS = 2;
const MAX_PARALLEL_READ_ONLY_TOOLS = 4;
const AUTO_RENAME_ASSISTANT_CHARS = 240;
const TRACE_PROGRESS_MIN_INTERVAL_MS = 1_500;
const TRACE_PROGRESS_BYTES_STEP = 16 * 1024;
const TRACE_PROGRESS_LINE_STEP = 40;
const TRACE_PROGRESS_ITEM_STEP = 1;
const SUBAGENT_MAX_CHILDREN_PER_PARENT = 6;
const SUBAGENT_MAX_CONCURRENT_CHILDREN = 2;
const SUBAGENT_ALLOWED_RISKS: RiskCategory[] = ["host_observation", "workspace_read", "network"];
const SUBAGENT_TARGET_LIMITS = {
  maxModelTurns: 16,
  maxToolCalls: 40,
  maxWallTimeMs: 900_000
};
const DEFAULT_TARGET_LIMITS = {
  maxModelTurns: 160,
  maxToolCalls: 500,
  maxWallTimeMs: 14_400_000
};

type TaskTitleSource = "explicit" | "model" | "local_fallback";

interface TaskTitleResolution {
  title: string;
  source: TaskTitleSource;
}

interface TaskRunOptions {
  runMode?: "normal" | "target";
  targetLimits?: {
    maxModelTurns?: number | undefined;
    maxToolCalls?: number | undefined;
    maxWallTimeMs?: number | undefined;
  };
  kind?: TaskKind;
  parentTaskId?: string;
  delegation?: TaskDelegationMeta;
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
  private readonly deltaLocks = new Map<string, Promise<void>>();
  private readonly runningModelControllers = new Map<string, AbortController>();
  private readonly runningToolControllers = new Map<string, Set<AbortController>>();
  private readonly traceRecorder: TaskTraceRecorder;

  constructor(options: AgentWorkbenchOptions = {}) {
    this.store = options.store ?? new InMemoryWorkbenchStore();
    this.model = options.model ?? new FallbackModelClient();
    this.tools = options.tools ?? new ShellToolExecutor();
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(this.store);
    this.toolRiskProvider = options.toolRiskProvider;
    this.onEvent = options.onEvent;
    this.traceRecorder = new TaskTraceRecorder(options.traceRoot);
  }

  async createTask(goal: string, title?: string, folderId = "default", attachmentIds: string[] = [], options: TaskRunOptions = {}): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, await this.resolveTaskTitle(goal, title), folderId, attachmentIds, options);
    return this.runTaskExclusive(task.id, () => this.step(task.id));
  }

  async startTask(goal: string, title?: string, folderId = "default", attachmentIds: string[] = [], options: TaskRunOptions = {}): Promise<TaskDetail> {
    const task = await this.initializeTask(goal, this.resolveImmediateTaskTitle(goal, title), folderId, attachmentIds, options);
    void this.runTaskExclusive(task.id, () => this.step(task.id)).catch((error) => {
      this.safeBackgroundCatch(task.id, error);
    });
    return task;
  }

  private resolveImmediateTaskTitle(goal: string, title?: string, language?: string): TaskTitleResolution {
    const explicit = title?.trim();
    if (explicit) return { title: explicit, source: "explicit" };
    return { title: createLocalTaskTitle(goal, language), source: "local_fallback" };
  }

  private async resolveTaskTitle(goal: string, title?: string, language?: string): Promise<TaskTitleResolution> {
    const explicit = title?.trim();
    if (explicit) return { title: explicit, source: "explicit" };
    try {
      const result = await this.generateTaskTitle({ goal, useLocalFallback: false, ...(language ? { language } : {}) });
      return { title: result.title, source: result.source };
    } catch {
      return { title: createLocalTaskTitle(goal, language), source: "local_fallback" };
    }
  }

  private async initializeTask(goal: string, titleResolution: TaskTitleResolution, folderId: string, attachmentIds: string[] = [], options: TaskRunOptions = {}): Promise<TaskDetail> {
    const folder = await this.resolveTaskFolder(folderId);
    const task = this.emptyTask(titleResolution.title);
    task.kind = options.kind ?? "primary";
    if (options.parentTaskId) task.parentTaskId = options.parentTaskId;
    if (options.delegation) task.delegation = options.delegation;
    task.folderId = folder.id;
    task.workRoot = folder.rootPath;
    task.runMode = options.runMode === "target" ? "target" : "normal";
    if (task.runMode === "target") {
      task.targetLimits = normalizeTargetLimits(options.targetLimits);
    }
    this.addEvent(task, "task_created", "Task created", {
      titleSource: titleResolution.source,
      initialTitle: titleResolution.title,
      kind: task.kind,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      runMode: task.runMode,
      ...(task.targetLimits ? { targetLimits: task.targetLimits } : {})
    });
    await this.beginTaskTurn(task, goal, "user_message");
    if (task.kind === "subagent") this.attachSubagentTaskGraph(task, goal);
    await this.attachUploadedFiles(task, attachmentIds);
    this.setStatus(task, "running");
    await this.store.saveTask(task);
    return task;
  }

  async listTasks(options: { includeChildren?: boolean } = {}): Promise<TaskDetail[]> {
    const tasks = await this.store.listTasks();
    if (options.includeChildren === false) return tasks.filter((task) => task.kind !== "subagent");
    return tasks;
  }

  async listChildTasks(parentTaskId: string): Promise<TaskDetail[]> {
    return this.store.listChildTasks(parentTaskId);
  }

  async listTaskChildren(parentTaskId: string): Promise<TaskChildSummary[]> {
    const tasks = await this.store.listChildTasks(parentTaskId);
    return tasks.map((task) => this.buildTaskChildSummary(task));
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
    return canonicalizeExistingDirectory(rootPath?.trim() || defaultTaskWorkRoot());
  }

  private async refreshFolderStatus(folder: TaskFolderRecord): Promise<TaskFolderRecord> {
    const fallbackRoot = resolve(folder.rootPath?.trim() || defaultTaskWorkRoot());
    const rootPath = await realpath(fallbackRoot).catch(() => fallbackRoot);
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
      if (title && title !== task.title) {
        this.addEvent(updated, "task_title_updated", title, {
          source: "manual",
          previousTitle: task.title,
          newTitle: title,
          uiHidden: true
        });
      }
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
        cancelledRun: task.status === "running" || task.status === "waiting_approval" || task.status === "waiting_for_user"
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
        this.markRollbackFilesStale(task.id, result);
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
      for (const file of checkpoint.files) {
        const resolvedPath = resolve(file.path);
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
    return this.appendMessageInternal(taskId, content, attachmentIds, "inline");
  }

  async appendMessageInBackground(taskId: string, content: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    return this.appendMessageInternal(taskId, content, attachmentIds, "background");
  }

  private async appendMessageInternal(
    taskId: string,
    content: string,
    attachmentIds: string[],
    continuation: "inline" | "background"
  ): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      const task = await this.requiredTask(taskId);
      await this.attachUploadedFiles(task, attachmentIds);
      if (task.status === "waiting_for_user") {
        const answered = await this.answerPendingUserInput(task, content);
        if (answered) {
          this.setStatus(task, "running");
          await this.store.saveTask(task);
          if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
          if (continuation === "background") {
            this.scheduleTaskStep(task.id);
            return task;
          }
          return this.step(task.id);
        }
      }
      if (task.status === "running" || task.status === "waiting_approval") {
        await this.beginTaskTurn(task, content, "guidance_pending", { status: "pending" });
        await this.store.saveTask(task);
        return task;
      }
      await this.beginTaskTurn(task, content, "user_message");
      this.setStatus(task, "running");
      await this.store.saveTask(task);
      if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
      if (continuation === "background") {
        this.scheduleTaskStep(task.id);
        return task;
      }
      return this.step(task.id);
    });
  }

  async revertTaskTurn(taskId: string, turnId: string): Promise<TaskTurnRevertResult> {
    return this.runTaskExclusive(taskId, async () => this.revertTaskTurnUnlocked(taskId, turnId, { rollbackFiles: true, rollbackProjectMemory: true }));
  }

  async editTaskTurn(taskId: string, turnId: string, input: TaskTurnEditRequest): Promise<TaskDetail> {
    return this.runTaskExclusive(taskId, async () => {
      await this.revertTaskTurnUnlocked(taskId, turnId, {
        rollbackFiles: input.rollbackFiles !== false,
        rollbackProjectMemory: input.rollbackProjectMemory !== false
      });
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

  private async answerPendingUserInput(task: TaskDetail, content: string): Promise<boolean> {
    const request = [...task.events].reverse().find(
      (event) => event.type === "user_input_requested" && event.payload["status"] !== "answered" && !event.reverted
    );
    if (!request) return false;
    const toolCallId = String(request.payload["toolCallId"] ?? "");
    if (!toolCallId) return false;
    const answerEvent = this.addEvent(task, "user_input_answered", content, {
      requestEventId: request.id,
      toolCallId,
      toolName: "ask_user"
    });
    request.payload = { ...request.payload, status: "answered", answerEventId: answerEvent.id };
    await this.addToolResultEvent(
      task,
      { id: toolCallId, toolName: "ask_user", args: recordFromUnknown(request.payload["args"]) },
      managedToolResult(
        { id: toolCallId, toolName: "ask_user", args: recordFromUnknown(request.payload["args"]) },
        true,
        JSON.stringify({ status: "answered", answer: content })
      )
    );
    return true;
  }

  private async revertTaskTurnUnlocked(
    taskId: string,
    turnId: string,
    options: { rollbackFiles: boolean; rollbackProjectMemory: boolean }
  ): Promise<TaskTurnRevertResult> {
    const task = await this.requiredTask(taskId);
    const turns = this.withComputedTurnEnds(task, await this.store.listTaskTurns(taskId));
    const turn = turns.find((item) => item.id === turnId);
    if (!turn) throw new Error(`Task turn not found: ${turnId}`);
    if (turn.status === "reverted") {
      return {
        task,
        turn,
        draft: turn.originalContent,
        revertedEventCount: 0,
        irreversibleEventCount: 0
      };
    }

    if (task.status === "running" || task.status === "waiting_approval" || task.status === "waiting_for_user") {
      this.cancelRunningTask(task.id);
      this.setStatus(task, "paused");
    }

    const range = this.eventsFromTurn(task, turn);
    const checkpointIds = new Set(
      range
        .filter((event) => event.type === "task_checkpoint_created")
        .map((event) => String(event.payload["checkpointId"] ?? ""))
        .filter(Boolean)
    );
    const rollback = options.rollbackFiles ? await this.rollbackTurnCheckpoints(task, [...checkpointIds]) : undefined;
    const projectMemoryRollback = options.rollbackProjectMemory ? await this.restoreProjectMemoryVersions(task, range) : undefined;
    const irreversibleEventCount = range.filter(isIrreversibleTurnEvent).length;
    const now = nowIso();
    const affectedTurns = turns.filter((item) => item.status === "active" && item.createdAt.localeCompare(turn.createdAt) >= 0);
    const revertedTurn: TaskTurn = { ...turn, status: "reverted", revertedAt: now, updatedAt: now };
    for (const event of range) event.reverted = true;
    this.addEvent(task, "turn_reverted", "User turn and later task history were reverted for editing.", {
      turnId: turn.id,
      revertedTurnIds: affectedTurns.map((item) => item.id),
      revertedEventCount: range.length,
      irreversibleEventCount,
      rollbackFiles: options.rollbackFiles,
      rollbackProjectMemory: options.rollbackProjectMemory,
      ...(rollback ? { rollback } : {}),
      ...(projectMemoryRollback ? { projectMemoryRollback } : {})
    });
    if (rollback && rollback.skippedFiles > 0) {
      this.addEvent(task, "rollback_partial", "Some files or side effects could not be fully reverted.", {
        turnId: turn.id,
        skippedFiles: rollback.skippedFiles,
        irreversibleEventCount
      });
    }
    for (const item of affectedTurns) {
      await this.store.saveTaskTurn({ ...item, status: "reverted", revertedAt: now, updatedAt: now });
    }
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

  private eventsFromTurn(task: TaskDetail, turn: TaskTurn): TaskEvent[] {
    const startIndex = task.events.findIndex((event) => event.id === turn.startEventId);
    if (startIndex < 0) return [];
    return task.events.slice(startIndex).filter((event) => !event.reverted);
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
    this.markRollbackFilesStale(task.id, result);
    return result;
  }

  private markRollbackFilesStale(taskId: string, result: TaskRollbackResult): void {
    const affectedPaths = result.files
      .filter((file) => file.canRollback && (file.status === "modified" || file.status === "created" || file.status === "deleted"))
      .map((file) => file.path);
    this.contextAssembler.getFileStateTracker(taskId).markFilesStale(
      affectedPaths,
      "File was rolled back; call read_file for current content before relying on earlier file evidence.",
      result.createdAt
    );
  }

  private async restoreProjectMemoryVersions(task: TaskDetail, events: TaskEvent[]): Promise<{ restored: number; folderIds: string[] } | undefined> {
    const snapshots = events
      .filter((event) => event.type === "project_memory_version_created")
      .filter((event) => typeof event.payload["folderId"] === "string" && typeof event.payload["content"] === "string");
    if (snapshots.length === 0) return undefined;
    const latestByFolder = new Map<string, TaskEvent>();
    for (const event of snapshots) latestByFolder.set(String(event.payload["folderId"]), event);
    const restoredFolderIds: string[] = [];
    for (const [folderId, event] of latestByFolder) {
      const folder = await this.resolveTaskFolder(folderId);
      await this.writeMemoryDocument("project", String(event.payload["content"] ?? ""), folder);
      restoredFolderIds.push(folder.id);
    }
    this.addEvent(task, "project_memory_rollback_completed", `Rolled back project memory for ${restoredFolderIds.length} folder(s).`, {
      folderIds: restoredFolderIds,
      restored: restoredFolderIds.length
    });
    return { restored: restoredFolderIds.length, folderIds: restoredFolderIds };
  }

  async control(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail> {
    return this.controlInternal(taskId, action, "inline");
  }

  async controlInBackground(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail> {
    return this.controlInternal(taskId, action, "background");
  }

  private async controlInternal(taskId: string, action: "pause" | "resume" | "cancel", continuation: "inline" | "background"): Promise<TaskDetail> {
    if (action === "resume") {
      return this.runTaskExclusive(taskId, async () => {
        const task = await this.requiredTask(taskId);
        this.setStatus(task, "running");
        await this.store.saveTask(task);
        if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
        if (continuation === "background") {
          this.scheduleTaskStep(task.id);
          return task;
        }
        return this.step(task.id);
      });
    }

    this.cancelRunningTask(taskId);
    const task = await this.requiredTask(taskId);
    if (action === "pause") this.setStatus(task, "paused");
    if (action === "cancel") this.setStatus(task, "cancelled");
    await this.store.saveTask(task);
    if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
    return task;
  }

  async decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail> {
    return this.decideApprovalInternal(taskId, approvalId, decision, "inline");
  }

  async decideApprovalInBackground(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail> {
    return this.decideApprovalInternal(taskId, approvalId, decision, "background");
  }

  private async decideApprovalInternal(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
    continuation: "inline" | "background"
  ): Promise<TaskDetail> {
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
        if (continuation === "background") {
          this.scheduleTaskStep(task.id);
          return task;
        }
        return this.step(task.id);
      }

      this.setStatus(task, "running");
      await this.createCheckpointForTool(task, approval.toolCall, {
        category: approval.riskCategory,
        reason: approval.reason
      });
      await this.store.saveTask(task);
      if (continuation === "background") {
        this.scheduleApprovedToolContinuation(task.id, approval.toolCall);
        return task;
      }
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

  async deleteTaskMemory(memoryId: string): Promise<void> {
    await this.store.deleteTaskMemory(memoryId);
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
      const oneOffSignals = /current machine|当前机器|single run|one-off|一次性|prior task result|localhost|127\.0\.0\.1|临时/i.test(skill.body);
      const sourceTaskCount = Math.max(skill.sourceMemoryIds.length, skill.relatedPatterns.length > 0 ? 5 : 0);
      const successRate = Number(skill.stats.successRate ?? 0);
      const evidence = [
        sourceTaskCount > 0 ? `${sourceTaskCount} linked source task${sourceTaskCount === 1 ? "" : "s"}` : "",
        skill.applicability.requiredTools.length > 0 ? `Required tools: ${skill.applicability.requiredTools.join(", ")}` : "",
        skill.applicability.requiredContext.length > 0 ? `Context: ${skill.applicability.requiredContext.join(", ")}` : "",
        skill.relatedPatterns.length > 0 ? `Derived from ${skill.relatedPatterns.length} reflection pattern(s)` : ""
      ].filter(Boolean);
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
        ...(sourceTaskCount > 0 ? { sourceTaskCount } : {}),
        ...(Number.isFinite(successRate) ? { successRate } : {}),
        evidence,
        blockedReasons: oneOffSignals ? ["Looks tied to one-off machine or prior task output."] : [],
        dedupBasis: [],
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
        blockedReasons: [],
        dedupBasis: [
          "normalized goal/title tokens",
          "required tools",
          "required context",
          "exclusions",
          "body structure"
        ],
        evidence: group.skills.map((skill) => `${skill.title} (${skill.status})`).slice(0, 6),
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
        recommendation: "Resolve by editing, suspending, or merging the conflicting skills. Agent Workbench will not auto-merge conflicts.",
        skillIds: conflict.skillIds,
        memoryIds: [],
        evidence: [`Severity: ${conflict.severity}`],
        blockedReasons: [],
        dedupBasis: [],
        createdAt: conflict.createdAt
      });
    }

    const lowValueCandidates = memories.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((memory) => {
      const reusable =
        memory.assessment.goalAchieved &&
        memory.assessment.confidence >= 0.75 &&
        memory.toolsUsed.length > 0 &&
        memory.meta.complexity !== "simple" &&
        memory.meta.outcome === "success";
      return !reusable;
    });
    const lowValueCounts = new Map<string, number>();
    for (const memory of lowValueCandidates) {
      const key = lowValueMemoryKey(memory);
      lowValueCounts.set(key, (lowValueCounts.get(key) ?? 0) + 1);
    }
    const seenLowValue = new Set<string>();
    for (const memory of lowValueCandidates.slice(0, 32)) {
      const key = lowValueMemoryKey(memory);
      if (seenLowValue.has(key)) continue;
      seenLowValue.add(key);
      if (seenLowValue.size > 16) break;
      const collapsedCount = Math.max(0, (lowValueCounts.get(key) ?? 1) - 1);
      const blockedReasons = [
        !memory.assessment.goalAchieved ? "Task did not finish successfully." : "",
        memory.meta.complexity === "simple" ? "Too simple to become a reusable skill." : "",
        memory.toolsUsed.length < 2 ? "Did not establish a stable multi-step tool sequence." : "",
        memory.meta.hasSideEffects ? "Includes side effects and needs broader repeat evidence first." : ""
      ].filter(Boolean);
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
        sourceTaskCount: 1,
        evidence: [
          memory.toolsUsed.length > 0 ? `Tools used: ${memory.toolsUsed.map((tool) => tool.toolName).join(", ")}` : "No tool evidence was captured.",
          `Outcome: ${memory.meta.outcome}`,
          `Complexity: ${memory.meta.complexity}`,
          collapsedCount > 0 ? `${collapsedCount} similar low-value task memor${collapsedCount === 1 ? "y was" : "ies were"} collapsed.` : ""
        ].filter(Boolean),
        blockedReasons,
        dedupBasis: [],
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
    throw new Error("Experience is not eligible for direct Skill promotion. Run curator extraction to promote stable reusable patterns.");
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
    normalizeAutoApprovePreferences(next, patch);
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
      title: "Skill Curator maintenance",
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
      throw new Error("Skill Curator maintenance is a default automation and can only be paused, not deleted.");
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
          const task = await this.initializeTask(scheduledPrompt, { title: scheduled.title, source: "explicit" }, scheduled.folderId ?? "default");
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
      status: input.enabled ? initialIntegrationStatus(buildIntegrationStatusSnapshot({
        kind: input.kind,
        callbackUrl: input.callbackUrl,
        publicKey: input.publicKey,
        botTokenConfigured: Boolean(input.botToken),
        verificationTokenConfigured: Boolean(input.verificationToken),
        signingSecretConfigured: Boolean(input.signingSecret),
        secretTokenConfigured: Boolean(input.secretToken),
        wecomTokenConfigured: Boolean(input.wecomToken),
        wecomEncodingAesKeyConfigured: Boolean(input.wecomEncodingAesKey)
      })) : "disabled",
      enabled: input.enabled,
      ...(input.botToken ? { botTokenRef: await this.saveIntegrationSecretRef(id, "botToken", input.botToken) } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.appSecret ? { appSecretRef: await this.saveIntegrationSecretRef(id, "appSecret", input.appSecret) } : {}),
      ...(input.publicKey ? { publicKey: input.publicKey.trim() } : {}),
      ...(input.verificationToken ? { verificationTokenRef: await this.saveIntegrationSecretRef(id, "verificationToken", input.verificationToken) } : {}),
      ...(input.encryptKey ? { encryptKeyRef: await this.saveIntegrationSecretRef(id, "encryptKey", input.encryptKey) } : {}),
      ...(input.signingSecret ? { signingSecretRef: await this.saveIntegrationSecretRef(id, "signingSecret", input.signingSecret) } : {}),
      ...(input.secretToken ? { secretTokenRef: await this.saveIntegrationSecretRef(id, "secretToken", input.secretToken) } : {}),
      ...(input.wecomToken ? { wecomTokenRef: await this.saveIntegrationSecretRef(id, "wecomToken", input.wecomToken) } : {}),
      ...(input.wecomEncodingAesKey ? { wecomEncodingAesKeyRef: await this.saveIntegrationSecretRef(id, "wecomEncodingAesKey", input.wecomEncodingAesKey) } : {}),
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
    let appSecretRef = current.appSecretRef;
    let verificationTokenRef = current.verificationTokenRef;
    let encryptKeyRef = current.encryptKeyRef;
    let signingSecretRef = current.signingSecretRef;
    let secretTokenRef = current.secretTokenRef;
    let wecomTokenRef = current.wecomTokenRef;
    let wecomEncodingAesKeyRef = current.wecomEncodingAesKeyRef;
    if (input.clearBotToken) {
      await this.store.deleteIntegrationSecret(integrationId, "botToken");
      botTokenRef = undefined;
    }
    if (input.clearAppSecret) {
      await this.store.deleteIntegrationSecret(integrationId, "appSecret");
      appSecretRef = undefined;
    }
    if (input.clearVerificationToken) {
      await this.store.deleteIntegrationSecret(integrationId, "verificationToken");
      verificationTokenRef = undefined;
    }
    if (input.clearEncryptKey) {
      await this.store.deleteIntegrationSecret(integrationId, "encryptKey");
      encryptKeyRef = undefined;
    }
    if (input.clearSigningSecret) {
      await this.store.deleteIntegrationSecret(integrationId, "signingSecret");
      signingSecretRef = undefined;
    }
    if (input.clearSecretToken) {
      await this.store.deleteIntegrationSecret(integrationId, "secretToken");
      secretTokenRef = undefined;
    }
    if (input.clearWecomToken) {
      await this.store.deleteIntegrationSecret(integrationId, "wecomToken");
      wecomTokenRef = undefined;
    }
    if (input.clearWecomEncodingAesKey) {
      await this.store.deleteIntegrationSecret(integrationId, "wecomEncodingAesKey");
      wecomEncodingAesKeyRef = undefined;
    }
    if (input.botToken) botTokenRef = await this.saveIntegrationSecretRef(integrationId, "botToken", input.botToken);
    if (input.appSecret) appSecretRef = await this.saveIntegrationSecretRef(integrationId, "appSecret", input.appSecret);
    if (input.verificationToken) verificationTokenRef = await this.saveIntegrationSecretRef(integrationId, "verificationToken", input.verificationToken);
    if (input.encryptKey) encryptKeyRef = await this.saveIntegrationSecretRef(integrationId, "encryptKey", input.encryptKey);
    if (input.signingSecret) signingSecretRef = await this.saveIntegrationSecretRef(integrationId, "signingSecret", input.signingSecret);
    if (input.secretToken) secretTokenRef = await this.saveIntegrationSecretRef(integrationId, "secretToken", input.secretToken);
    if (input.wecomToken) wecomTokenRef = await this.saveIntegrationSecretRef(integrationId, "wecomToken", input.wecomToken);
    if (input.wecomEncodingAesKey) wecomEncodingAesKeyRef = await this.saveIntegrationSecretRef(integrationId, "wecomEncodingAesKey", input.wecomEncodingAesKey);
    const enabled = input.enabled ?? current.enabled;
    const callbackUrl = input.callbackUrl !== undefined ? input.callbackUrl : current.callbackUrl;
    const kind = input.kind ?? current.kind;
    const updated: IntegrationProviderConfig = {
      ...current,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(botTokenRef ? { botTokenRef } : {}),
      ...(input.appId !== undefined ? { appId: input.appId } : {}),
      ...(appSecretRef ? { appSecretRef } : {}),
      ...(input.publicKey !== undefined ? { publicKey: input.publicKey.trim() || undefined } : {}),
      ...(verificationTokenRef ? { verificationTokenRef } : {}),
      ...(encryptKeyRef ? { encryptKeyRef } : {}),
      ...(signingSecretRef ? { signingSecretRef } : {}),
      ...(secretTokenRef ? { secretTokenRef } : {}),
      ...(wecomTokenRef ? { wecomTokenRef } : {}),
      ...(wecomEncodingAesKeyRef ? { wecomEncodingAesKeyRef } : {}),
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(input.defaultFolderId ? { defaultFolderId: input.defaultFolderId } : {}),
      ...(input.defaultPermissionPreset ? { defaultPermissionPreset: input.defaultPermissionPreset } : {}),
      enabled,
      status: enabled ? initialIntegrationStatus(buildIntegrationStatusSnapshot({
        kind,
        callbackUrl,
        publicKey: input.publicKey !== undefined ? input.publicKey.trim() : current.publicKey,
        botTokenConfigured: Boolean(botTokenRef),
        verificationTokenConfigured: Boolean(verificationTokenRef),
        signingSecretConfigured: Boolean(signingSecretRef),
        secretTokenConfigured: Boolean(secretTokenRef),
        wecomTokenConfigured: Boolean(wecomTokenRef),
        wecomEncodingAesKeyConfigured: Boolean(wecomEncodingAesKeyRef)
      })) : "disabled",
      updatedAt: nowIso()
    };
    if (!botTokenRef) delete updated.botTokenRef;
    if (!appSecretRef) delete updated.appSecretRef;
    if (!verificationTokenRef) delete updated.verificationTokenRef;
    if (!encryptKeyRef) delete updated.encryptKeyRef;
    if (!signingSecretRef) delete updated.signingSecretRef;
    if (!secretTokenRef) delete updated.secretTokenRef;
    if (!wecomTokenRef) delete updated.wecomTokenRef;
    if (!wecomEncodingAesKeyRef) delete updated.wecomEncodingAesKeyRef;
    if (!updated.publicKey) delete updated.publicKey;
    if (!callbackUrl) delete updated.callbackUrl;
    await this.store.saveIntegrationProvider(updated);
    return updated;
  }

  async deleteIntegrationProvider(integrationId: string): Promise<void> {
    for (const secretName of ["botToken", "appSecret", "verificationToken", "encryptKey", "signingSecret", "secretToken", "wecomToken", "wecomEncodingAesKey"] as const) {
      await this.store.deleteIntegrationSecret(integrationId, secretName);
    }
    await this.store.deleteIntegrationProvider(integrationId);
  }

  async connectIntegrationProvider(integrationId: string): Promise<IntegrationProviderConfig> {
    const current = await this.store.getIntegrationProvider(integrationId);
    if (!current) throw new Error(`Integration provider not found: ${integrationId}`);
    const updated: IntegrationProviderConfig = {
      ...current,
      enabled: true,
      status: initialIntegrationStatus(buildIntegrationStatusSnapshot({
        kind: current.kind,
        callbackUrl: current.callbackUrl,
        publicKey: current.publicKey,
        botTokenConfigured: Boolean(current.botTokenRef),
        verificationTokenConfigured: Boolean(current.verificationTokenRef),
        signingSecretConfigured: Boolean(current.signingSecretRef),
        secretTokenConfigured: Boolean(current.secretTokenRef),
        wecomTokenConfigured: Boolean(current.wecomTokenRef),
        wecomEncodingAesKeyConfigured: Boolean(current.wecomEncodingAesKeyRef)
      })) === "setup_pending" ? "setup_pending" : "connected",
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

  async handleDiscordInteraction(
    input: DiscordInteractionRequest,
    envelope: { rawBody: string; signature: string; timestamp: string }
  ): Promise<TaskDetail | null> {
    const provider = await this.resolveIntegrationForMessage("discord", input.integrationId);
    verifyDiscordRequestSignature(provider.publicKey, envelope.signature, envelope.timestamp, envelope.rawBody);
    const text = parseDiscordInteractionText(input);
    const channelId = input.channel_id ?? "";
    const externalMessageId = input.id ?? createId("discord_message");
    const senderId = extractDiscordUserId(input);
    if (!text || !channelId) return null;
    return this.createTaskFromIntegration(provider, text, channelId, externalMessageId, senderId);
  }

  async handleFeishuEvent(input: FeishuEventRequest): Promise<TaskDetail | null> {
    const provider = await this.resolveIntegrationForMessage("feishu", input.integrationId);
    const verificationToken = await this.readIntegrationSecretValue(provider.verificationTokenRef, "verificationToken");
    ensureFeishuVerificationToken(input, verificationToken);
    const message = input.event?.message;
    const text = parseFeishuMessageText(message?.content);
    const channelId = message?.chat_id ?? "";
    if (!text || !channelId) return null;
    const senderId = extractFeishuSenderId(input);
    return this.createTaskFromIntegration(provider, text, channelId, message?.message_id ?? createId("feishu_message"), senderId);
  }

  async handleSlackEvent(
    input: SlackEventRequest,
    envelope: { rawBody: string; signature: string; timestamp: string }
  ): Promise<TaskDetail | null> {
    const provider = await this.resolveIntegrationForMessage("slack", input.integrationId);
    const signingSecret = await this.readIntegrationSecretValue(provider.signingSecretRef, "signingSecret");
    verifySlackRequestSignature(signingSecret, envelope.signature, envelope.timestamp, envelope.rawBody);
    const text = parseSlackEventText(input);
    const channelId = String(input.event?.channel ?? "").trim();
    if (!text || !channelId) return null;
    return this.createTaskFromIntegration(
      provider,
      text,
      channelId,
      String(input.event_id ?? input.event?.ts ?? createId("slack_message")),
      extractSlackUserId(input)
    );
  }

  async handleTelegramUpdate(
    input: TelegramUpdateRequest,
    envelope: { secretToken: string }
  ): Promise<TaskDetail | null> {
    const provider = await this.resolveIntegrationForMessage("telegram", input.integrationId);
    const expectedSecret = await this.readIntegrationSecretValue(provider.secretTokenRef, "secretToken");
    verifyTelegramSecretToken(expectedSecret, envelope.secretToken);
    const text = parseTelegramMessageText(input);
    const chat = recordFromUnknown(input.message)["chat"];
    const channelId = String(recordFromUnknown(chat)["id"] ?? "").trim();
    if (!text || !channelId) return null;
    return this.createTaskFromIntegration(
      provider,
      text,
      channelId,
      String(recordFromUnknown(input.message)["message_id"] ?? input.update_id ?? createId("telegram_message")),
      extractTelegramUserId(input)
    );
  }

  async handleWecomCallback(
    input: WecomCallbackRequest,
    envelope: { msgSignature: string; timestamp: string; nonce: string; echostr?: string | undefined; rawBody?: string | undefined }
  ): Promise<TaskDetail | null> {
    const provider = await this.resolveIntegrationForMessage("wecom", input.integrationId);
    const token = await this.readIntegrationSecretValue(provider.wecomTokenRef, "wecomToken");
    const aesKey = await this.readIntegrationSecretValue(provider.wecomEncodingAesKeyRef, "wecomEncodingAesKey");
    const encryptedValue = input.encrypt ?? envelope.echostr ?? "";
    verifyWecomSignature(token, envelope.msgSignature, envelope.timestamp, envelope.nonce, encryptedValue);
    const xml = input.encrypt ? decryptWecomPayload(aesKey, input.encrypt) : (envelope.rawBody ?? "");
    const parsed = input.encrypt ? parseWecomCallbackXml(xml) : input;
    const text = parseWecomMessageText(parsed);
    const channelId = String(parsed.toUserName ?? parsed.agentID ?? "wecom").trim();
    if (!text || !channelId) return null;
    return this.createTaskFromIntegration(
      provider,
      text,
      channelId,
      String(parsed.msgId ?? envelope.timestamp ?? createId("wecom_message")),
      extractWecomSenderId(parsed)
    );
  }

  async verifyWecomCallback(
    preferredId: string | undefined,
    envelope: { msgSignature: string; timestamp: string; nonce: string; echostr: string }
  ): Promise<string> {
    const provider = await this.resolveIntegrationForMessage("wecom", preferredId);
    const token = await this.readIntegrationSecretValue(provider.wecomTokenRef, "wecomToken");
    const aesKey = await this.readIntegrationSecretValue(provider.wecomEncodingAesKeyRef, "wecomEncodingAesKey");
    verifyWecomSignature(token, envelope.msgSignature, envelope.timestamp, envelope.nonce, envelope.echostr);
    return decryptWecomPayload(aesKey, envelope.echostr);
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

  private async readIntegrationSecretValue(secretRef: EncryptedSecretRef | undefined, name: string): Promise<string | undefined> {
    if (!secretRef) return undefined;
    const [integrationId] = secretRef.secretId.split(":", 1);
    if (!integrationId) return undefined;
    const encrypted = await this.store.getIntegrationSecret(integrationId, name);
    return encrypted ? this.secretBox.decrypt(encrypted) : undefined;
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
    const memories = await this.store.listTaskMemories();
    const pendingMemories = memories.filter((item) => item.reflectionStatus === "pending");
    const result = reflectMemories(memories, await this.store.listPatterns());
    for (const pattern of result.patterns) await this.store.savePattern(pattern);
    const knownSkills = await this.listSkills();
    const newlyPromotedSkills: SkillRecord[] = [];
    for (const skill of result.promotedSkills) {
      if (findDuplicateSkill(skill, [...knownSkills, ...newlyPromotedSkills])) continue;
      const saved = await this.saveSkillWithConflicts(skill);
      newlyPromotedSkills.push(saved);
    }
    if (result.promotedSkills.length > 0 && newlyPromotedSkills.length === 0) {
      result.session.progress.nextStep = "duplicate_review_needed";
    }
    const shouldPersistSession = pendingMemories.length >= 10 || result.patterns.length > 0 || result.promotedSkills.length > 0;
    if (shouldPersistSession) await this.store.saveReflectionSession(result.session);
    if (result.session.progress.phase === "skill") {
      for (const memory of pendingMemories) {
        await this.store.saveTaskMemory({
          ...memory,
          reflectionCount: memory.reflectionCount + 1,
          reflectionStatus: "reflected"
        });
      }
    }
    return result.session;
  }

  async listReflectionSessions(): Promise<ReflectionSession[]> {
    return this.store.listReflectionSessions();
  }

  async deleteReflectionSession(sessionId: string): Promise<void> {
    await this.store.deleteReflectionSession(sessionId);
  }

  async clearReflectionSessions(): Promise<void> {
    await this.store.clearReflectionSessions();
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

  async updateProjectMemory(id: string, input: ProjectMemoryPatchRequest): Promise<ProjectMemory> {
    const current = (await this.store.listProjectMemories()).find((memory) => memory.id === id);
    if (!current) throw new Error(`Project memory not found: ${id}`);
    const updated: ProjectMemory = {
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      updatedAt: nowIso()
    };
    await this.store.saveProjectMemory(updated);
    return updated;
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

  async getKnowledgeModelStatus(): Promise<KnowledgeModelStatus> {
    return getKnowledgeModelStatus(this.store);
  }

  async downloadKnowledgeModel(input: KnowledgeModelDownloadRequest): Promise<KnowledgeModelDownloadResult> {
    return downloadKnowledgeModelAsset(this.store, input);
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
    let emptyResponseRetries = 0;
    let internalContinuationRetries = 0;
    const startedAt = Date.now();

    while (task.status === "running") {
      const modelTurnLimit = task.runMode === "target" ? normalizeTargetLimits(task.targetLimits).maxModelTurns : MAX_MODEL_TURNS_PER_TASK;
      if (modelTurns >= modelTurnLimit) {
        await this.pauseTaskForLoop(task, `Paused after ${modelTurnLimit} model turns in one task run. Ask for guidance or continue with a narrower step.`);
        return task;
      }
      const targetLimitReason = targetLimitReached(task, modelTurns, countToolResultEvents(task), startedAt);
      if (targetLimitReason) {
        await this.pauseTaskForLoop(task, targetLimitReason);
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
      if (turn.kind === "empty_response") {
        const shouldRetry = emptyResponseRetries < 1;
        emptyResponseRetries += 1;
        await this.handleEmptyModelResponse(task, turn, shouldRetry);
        if (shouldRetry) continue;
        return task;
      }
      emptyResponseRetries = 0;
      const turnReasoning = turn.reasoningContent ?? (turn.streamId ? collectThinkingForStream(task, turn.streamId) : undefined);
      if (turn.kind === "final") {
        if (isInternalContinuationFinal(turn.message)) {
          if (turn.streamId) this.hideAssistantStreamDeltas(task, turn.streamId, true);
          const shouldRetry = internalContinuationRetries < 1;
          internalContinuationRetries += 1;
          this.addEvent(
            task,
            "model_no_progress",
            shouldRetry
              ? "Model returned an internal continuation note instead of a final answer; retrying once."
              : "Model returned an internal continuation note twice; paused for retry or narrower guidance.",
            {
              status: shouldRetry ? "retrying" : "paused",
              ...(turn.streamId ? { streamId: turn.streamId } : {}),
              ...(turnReasoning ? { reasoningContent: turnReasoning } : {})
            }
          );
          await this.safeAppendTaskTrace(task, {
            kind: "model_no_progress",
            timestamp: nowIso(),
            reason: "internal_continuation_final",
            status: shouldRetry ? "retrying" : "paused",
            message: turn.message,
            ...(turn.streamId ? { streamId: turn.streamId } : {})
          });
          if (shouldRetry) {
            await this.store.saveTask(task);
            continue;
          }
          this.setStatus(task, "paused");
          await this.store.saveTask(task);
          if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
          return task;
        }
        internalContinuationRetries = 0;
        await this.maybeAutoRenameTask(task, { reason: "assistant_output", text: turn.message });
        const blocker = completionBlocker(task);
        if (blocker) {
          this.addEvent(task, "assistant_message", blocker, {
            ...(turn.streamId ? { streamId: turn.streamId } : {}),
            completionBlocked: true,
            blockedFinalMessage: turn.message,
            ...(turnReasoning ? { reasoningContent: turnReasoning } : {})
          });
          this.setStatus(task, "paused");
          await this.store.saveTask(task);
          if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
          return task;
        }
        this.addEvent(task, "assistant_message", turn.message, {
          ...(turn.streamId ? { streamId: turn.streamId } : {}),
          ...(turnReasoning ? { reasoningContent: turnReasoning } : {})
        });
        this.setStatus(task, "completed");
        await this.recordExperience(task);
        await this.store.saveTask(task);
        if (task.kind === "subagent") await this.projectSubagentCompletionToParent(task, "completed");
        return task;
      }
      if (turn.streamId) this.hideAssistantStreamDeltas(task, turn.streamId);

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

      const latest = await this.processToolCalls(task, executable, turnReasoning);
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
      ...(turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : {}),
      ...(turn.usage ? { usage: turn.usage } : {})
    };
  }

  private async handleEmptyModelResponse(
    task: TaskDetail,
    turn: Extract<Awaited<ReturnType<ModelClient["next"]>>, { kind: "empty_response" }>,
    shouldRetry: boolean
  ): Promise<void> {
    const summary = shouldRetry
      ? "Model returned no displayable content; retrying once."
      : "Model returned no displayable content twice; paused for retry or provider inspection.";
    this.addEvent(task, "model_empty_response", summary, {
      status: shouldRetry ? "retrying" : "paused",
      reason: turn.reason,
      ...(turn.streamId ? { streamId: turn.streamId } : {}),
      ...(turn.usage ? { usage: turn.usage } : {})
    });
    await this.safeAppendTaskTrace(task, {
      kind: "model_empty_response",
      timestamp: nowIso(),
      status: shouldRetry ? "retrying" : "paused",
      reason: turn.reason,
      ...(turn.streamId ? { streamId: turn.streamId } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.rawPayload ? { rawPayload: turn.rawPayload } : {})
    });
    if (!shouldRetry) {
      this.setStatus(task, "paused");
      if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
    }
    await this.store.saveTask(task);
  }

  private hideAssistantStreamDeltas(task: TaskDetail, streamId: string, force = false): void {
    for (const event of task.events) {
      if (event.type !== "assistant_delta") continue;
      if (String(event.payload["streamId"] ?? "") !== streamId) continue;
      if (!force && isReadableAssistantPreamble(event)) continue;
      event.payload = { ...event.payload, uiHidden: true };
    }
  }

  private async processToolCalls(task: TaskDetail, calls: ToolCall[], reasoningContent?: string): Promise<TaskDetail | null> {
    if (calls.length === 0) return task;
    const preferences = await this.store.getPreferences();
    const globalGrants = await this.store.listGlobalPermissions();
    const prepared: PreparedToolCall[] = [];

    for (const call of calls) {
      const stoppedBeforeTool = await this.stoppedTask(task.id);
      if (stoppedBeforeTool) return stoppedBeforeTool;

      if (task.kind === "subagent" && call.toolName === "spawn_subagent") {
        return this.failSubagentTask(task, "Nested subagent delegation is not supported in V1.", {
          toolCallId: call.id,
          toolName: call.toolName
        });
      }

      if (call.toolName === "ask_user") {
        if (task.kind === "subagent") {
          return this.failSubagentTask(task, `Subagent delegation cannot pause for user input. Child task requested ask_user: ${call.id}.`, {
            toolCallId: call.id,
            toolName: call.toolName
          });
        }
        const eventArgs = this.sanitizeForPreferences(call.args, preferences);
        this.addEvent(task, "tool_requested", call.toolName, {
          toolCallId: call.id,
          toolName: call.toolName,
          args: eventArgs,
          riskCategory: "none",
          ...(reasoningContent ? { reasoningContent } : {})
        });
        this.addEvent(task, "user_input_requested", String(call.args["question"] ?? "User input required."), {
          toolCallId: call.id,
          toolName: call.toolName,
          args: eventArgs,
          status: "pending",
          options: Array.isArray(call.args["options"]) ? call.args["options"] : [],
          required: call.args["required"] !== false,
          ...(typeof call.args["details"] === "string" ? { details: String(call.args["details"]) } : {})
        });
        await this.safeAppendTaskTrace(task, {
          kind: "tool_requested",
          timestamp: nowIso(),
          toolCallId: call.id,
          toolName: call.toolName,
          args: call.args,
          riskCategory: "none",
          waitingForUser: true
        });
        this.setStatus(task, "waiting_for_user");
        await this.store.saveTask(task);
        return task;
      }

      if (isApprovalBypassedStateTool(call.toolName)) {
        this.addEvent(task, "tool_requested", call.toolName, {
          toolCallId: call.id,
          toolName: call.toolName,
          args: this.sanitizeForPreferences(call.args, preferences),
          riskCategory: "none",
          ...(reasoningContent ? { reasoningContent } : {}),
          uiHidden: true
        });
        await this.safeAppendTaskTrace(task, {
          kind: "tool_requested",
          timestamp: nowIso(),
          toolCallId: call.id,
          toolName: call.toolName,
          args: call.args,
          riskCategory: "none",
          uiHidden: true
        });
        await this.store.saveTask(task);
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
        ...(reasoningContent ? { reasoningContent } : {}),
        ...eventMetadata
      });
      await this.safeAppendTaskTrace(task, {
        kind: "tool_requested",
        timestamp: nowIso(),
        toolCallId: call.id,
        toolName: call.toolName,
        args: call.args,
        riskCategory: assessment.category,
        metadata
      });

      if (this.subagentAutoApproval(task, call, assessment)) {
        this.addEvent(task, "approval_auto_granted", `${assessment.category}: delegated subagent scope`, {
          toolCallId: call.id,
          toolName: call.toolName,
          riskCategory: assessment.category,
          approvalSource: "subagentDelegation",
          ...eventMetadata
        });
        await this.safeAppendTaskTrace(task, {
          kind: "approval_auto_granted",
          timestamp: nowIso(),
          toolCallId: call.id,
          toolName: call.toolName,
          source: "subagentDelegation",
          riskCategory: assessment.category
        });
      } else if (task.kind === "subagent") {
        return this.failSubagentTask(
          task,
          `Subagent delegation blocked ${call.toolName} because it requires unsupported risk ${assessment.category}. V1 subagents are limited to host observation, workspace reads, and network access.`,
          {
            toolCallId: call.id,
            toolName: call.toolName,
            riskCategory: assessment.category
          }
        );
      } else if (this.permissions.isGloballyAllowed(assessment.category, globalGrants)) {
        this.addEvent(task, "approval_auto_granted", `${assessment.category}: global permission`, {
          toolCallId: call.id,
          toolName: call.toolName,
          riskCategory: assessment.category,
          ...eventMetadata
        });
        await this.safeAppendTaskTrace(task, {
          kind: "approval_auto_granted",
          timestamp: nowIso(),
          toolCallId: call.id,
          toolName: call.toolName,
          source: "global_permission",
          riskCategory: assessment.category
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
          await this.safeAppendTaskTrace(task, {
            kind: "approval_auto_granted",
            timestamp: nowIso(),
            toolCallId: call.id,
            toolName: call.toolName,
            source: preferenceGrant.source,
            reason: preferenceGrant.reason,
            riskCategory: assessment.category
          });
        } else if (
          preferenceGrant.forceApproval ||
          this.permissions.needsApproval(assessment.category, this.stateFor(task.id, task))
        ) {
          const llmApproval = await this.maybeApproveWithLlm(task, call, assessment, metadata, preferences);
          if (llmApproval.allowed) {
            this.addEvent(task, "approval_auto_granted", `${assessment.category}: ${llmApproval.reason}`, {
              toolCallId: call.id,
              toolName: call.toolName,
              riskCategory: assessment.category,
              approvalSource: "llmApproval",
              llmApproval,
              ...eventMetadata
            });
            await this.safeAppendTaskTrace(task, {
              kind: "approval_auto_granted",
              timestamp: nowIso(),
              toolCallId: call.id,
              toolName: call.toolName,
              source: "llmApproval",
              riskCategory: assessment.category,
              llmApproval
            });
            prepared.push({ call, assessment });
            continue;
          }
          const approval = this.permissions.createApproval({ taskId: task.id, toolCall: call, assessment, metadata: eventMetadata });
          if (llmApproval.evaluated) {
            approval.metadata = {
              ...(approval.metadata ?? {}),
              llmApproval
            };
          }
          task.approvals.push(approval);
          await this.addApprovalPendingEvent(task, approval);
          await this.safeAppendTaskTrace(task, {
            kind: "approval_pending",
            timestamp: nowIso(),
            toolCallId: call.id,
            toolName: call.toolName,
            approvalId: approval.id,
            riskCategory: assessment.category
          });
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
        if (await this.maybePauseForReadOnlyNoProgress(latest)) {
          await this.store.saveTask(latest);
          return latest;
        }
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
      if (await this.maybePauseForReadOnlyNoProgress(latest)) {
        await this.store.saveTask(latest);
        return latest;
      }
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
    if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
  }

  private async maybePauseForReadOnlyNoProgress(task: TaskDetail): Promise<boolean> {
    if (task.status !== "running") return false;
    const assessment = assessReadOnlyNoProgress(task);
    if (!assessment) return false;
    const message = `Paused because the agent repeated read-only exploration without producing new progress. Latest repeated target: ${assessment.repeatedTarget}. Review the current evidence or narrow the next instruction before continuing.`;
    this.addEvent(task, "model_no_progress", message, {
      reason: "repeated_read_only_tools",
      readOnlyToolCount: assessment.readOnlyToolCount,
      repeatedTargetCount: assessment.repeatedTargetCount,
      lastToolNames: assessment.lastToolNames
    });
    await this.safeAppendTaskTrace(task, {
      kind: "model_no_progress",
      timestamp: nowIso(),
      reason: "repeated_read_only_tools",
      readOnlyToolCount: assessment.readOnlyToolCount,
      repeatedTargetCount: assessment.repeatedTargetCount,
      lastToolNames: assessment.lastToolNames,
      repeatedTarget: assessment.repeatedTarget
    });
    this.setStatus(task, "paused");
    await this.store.saveTask(task);
    if (task.kind === "subagent") await this.projectSubagentStatusToParent(task);
    return true;
  }

  private async recordExperience(task: TaskDetail): Promise<void> {
    await this.updateLoadedSkillStats(task, true);
    if (!this.shouldRecordExperience(task)) {
      this.contextAssembler.cleanupTask(task.id);
      return;
    }
    const experience = createExperience(task);
    const memory = createTaskMemory(task);
    await this.store.saveExperience(experience);
    await this.store.saveTaskMemory(memory);
    this.addEvent(task, "task_memory_created", memory.title, { memoryId: memory.id });
    this.contextAssembler.cleanupTask(task.id);
  }

  private shouldRecordExperience(task: TaskDetail): boolean {
    if (!hasUserTurn(task)) return false;
    const events = task.events.filter((event) => !event.reverted);
    const lastMemoryIndex = findLastEventIndexByType(events, "task_memory_created");
    const afterLastMemory = lastMemoryIndex >= 0 ? events.slice(lastMemoryIndex + 1) : events;
    const hasNewEvidence = afterLastMemory.some((event) =>
      event.type === "tool_result" ||
      event.type === "verification_result_recorded" ||
      event.type === "task_checkpoint_created"
    );
    const hasSubstantiveAssistantOutput = afterLastMemory.some((event) =>
      event.type === "assistant_message" && event.summary.trim().length >= 40
    );
    const latestGoal = [...afterLastMemory]
      .reverse()
      .find((event) => (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted)
      ?.summary ?? "";
    const hasNonTrivialAnsweredTurn =
      nonWhitespaceLength(latestGoal) >= 8 &&
      afterLastMemory.some((event) => event.type === "assistant_message" && nonWhitespaceLength(event.summary) >= 8);
    return hasNewEvidence || hasSubstantiveAssistantOutput || hasNonTrivialAnsweredTurn;
  }

  private async recordPromptCacheStats(task: TaskDetail, usage?: ModelUsage): Promise<void> {
    if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) return;
    const provider = await this.resolveModelProviderConfig();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const stats: PromptCacheStats = {
      id: createId("prompt_cache_stats"),
      taskId: task.id,
      providerId: provider?.providerId,
      model: provider?.model ?? "local-fallback",
      policy: "auto_savings",
      source: "provider",
      inputTokens,
      outputTokens,
      totalTokens,
      cachedTokens,
      cacheHitRatio: cachedTokens / Math.max(1, inputTokens),
      estimatedSavings: 0,
      ...(usage?.raw ? { providerUsage: usage.raw } : {}),
      createdAt: nowIso()
    };
    await this.store.savePromptCacheStats(stats);
    this.addEvent(task, "token_usage_recorded", `Provider token usage recorded: ${totalTokens} total.`, {
      statsId: stats.id,
      providerId: stats.providerId,
      model: stats.model,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      totalTokens: stats.totalTokens,
      cachedTokens: stats.cachedTokens,
      source: stats.source
    });
  }

  private async safeModelNext(task: TaskDetail): Promise<Awaited<ReturnType<ModelClient["next"]>> | null> {
    let retriedAfterOverflow = false;
    while (true) {
      const streamId = createId("model_stream");
      const controller = new AbortController();
      this.runningModelControllers.set(task.id, controller);
      try {
        await this.safeAppendTaskTrace(task, {
          kind: "model_turn_started",
          timestamp: nowIso(),
          streamId,
          modelClient: this.model.constructor.name,
          taskStatus: task.status,
          eventCount: task.events.length,
          latestEvent: summarizeEventForTrace(task.events.at(-1))
        });
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
            await this.safeAppendTaskTrace(current, {
              kind: "provider_fallback",
              timestamp: nowIso(),
              streamId,
              ...event
            });
          },
          onTrace: async (event) => {
            const current = (await this.store.getTask(task.id)) ?? task;
            await this.safeAppendModelTrace(current, event);
          }
        });
        await this.recordPromptCacheStats(task, turn.usage);
        this.addConversationSummaryEvents(task);
        await this.safeAppendTaskTrace(task, {
          kind: "model_turn_completed",
          timestamp: nowIso(),
          streamId,
          resultKind: turn.kind,
          ...(turn.kind === "final"
            ? { message: turn.message }
            : turn.kind === "tool_calls"
              ? { toolCalls: turn.calls }
              : { reason: turn.reason }),
          ...(turn.usage ? { usage: turn.usage } : {})
        });
        return turn;
      } catch (error) {
        if (controller.signal.aborted) return null;
        const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
        await this.safeAppendTaskTrace(task, {
          kind: "model_turn_failed",
          timestamp: nowIso(),
          streamId,
          error: message
        });
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
        if (task.kind === "subagent") await this.projectSubagentCompletionToParent(task, "failed");
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

  private scheduleTaskStep(taskId: string): void {
    void this.runTaskExclusive(taskId, () => this.step(taskId)).catch((error) => {
      this.safeBackgroundCatch(taskId, error);
    });
  }

  private scheduleApprovedToolContinuation(taskId: string, call: ToolCall): void {
    void this.runTaskExclusive(taskId, async () => {
      const result = await this.executeTool(taskId, call);
      const latest = await this.requiredTask(taskId);
      await this.addToolResultEvent(latest, call, result);
      if (await this.maybePauseForReadOnlyNoProgress(latest)) {
        await this.store.saveTask(latest);
        return latest;
      }
      await this.store.saveTask(latest);
      if (latest.status !== "running") return latest;
      return this.step(latest.id);
    }).catch((error) => {
      this.safeBackgroundCatch(taskId, error);
    });
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
      if (task.kind === "subagent") await this.projectSubagentCompletionToParent(task, "failed");
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
      kind: "primary",
      folderId: "default",
      workRoot: defaultTaskWorkRoot(),
      status: "idle",
      runMode: "normal",
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
    const preferences = await this.store.getPreferences().catch(() => undefined);
    this.addEvent(task, "tool_started", call.toolName, {
      toolCallId: call.id,
      toolName: call.toolName,
      args: preferences ? this.sanitizeForPreferences(call.args, preferences) : call.args,
      status: "running",
      ...(call.toolName === "plan_update" ? { uiHidden: true } : {})
    });
    await this.store.saveTask(task);
    await this.safeAppendTaskTrace(task, {
      kind: "tool_started",
      timestamp: nowIso(),
      toolCallId: call.id,
      toolName: call.toolName,
      args: call.args
    });
    const progress = this.createToolProgressSink(taskId, call);
    try {
      const managed = await this.executeManagedTool(task, call);
      if (managed) {
        await this.store.saveTask(task);
        return managed;
      }
      return await this.tools.execute(call, { signal: controller.signal, workRoot: task.workRoot, onProgress: progress });
    } catch (error) {
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

  private createToolProgressSink(taskId: string, call: ToolCall): (progress: ToolProgressUpdate) => Promise<void> {
    let lastAt = 0;
    let lastStatus = "";
    let lastSignature = "";
    let lastProcessed = Number.NaN;
    let lastTotal = Number.NaN;
    return async (incoming) => {
      const progress = compactToolProgressUpdate(incoming);
      const now = Date.now();
      const signature = JSON.stringify({
        status: progress.status,
        operation: progress.operation,
        targetPath: progress.targetPath,
        message: progress.message,
        changes: progress.changes,
        total: progress.progress?.total,
        unit: progress.progress?.unit,
        displayMode: progress.displayMode
      });
      const processed = toFiniteNumber(progress.progress?.processed);
      const total = toFiniteNumber(progress.progress?.total);
      const status = progress.status ?? "running";
      const shouldEmit =
        lastAt === 0 ||
        status !== lastStatus ||
        signature !== lastSignature ||
        progressAdvancedEnough(progress.progress?.unit, processed, lastProcessed, total, lastTotal) ||
        now - lastAt >= TRACE_PROGRESS_MIN_INTERVAL_MS;
      if (!shouldEmit) return;
      lastAt = now;
      lastStatus = status;
      lastSignature = signature;
      lastProcessed = processed;
      lastTotal = total;
      await this.addToolProgressEvent(taskId, call, progress);
    };
  }

  private async addToolProgressEvent(taskId: string, call: ToolCall, progress: ToolProgressUpdate): Promise<void> {
    const task = await this.requiredTask(taskId);
    const preferences = await this.store.getPreferences().catch(() => undefined);
    const normalized = compactToolProgressUpdate(progress);
    const payload = preferences ? this.sanitizeForPreferences(normalized, preferences) : normalized;
    this.addEvent(task, "tool_progress", normalized.message ?? call.toolName, {
      toolCallId: call.id,
      toolName: call.toolName,
      status: normalized.status ?? "running",
      ...payload,
      ...(call.toolName === "plan_update" ? { uiHidden: true } : {})
    });
    await this.store.saveTask(task);
    await this.safeAppendTaskTrace(task, {
      kind: "tool_progress",
      timestamp: nowIso(),
      toolCallId: call.id,
      toolName: call.toolName,
      progress: summarizeToolProgressForTrace(normalized)
    });
  }

  private async addManagedToolProgressEvent(task: TaskDetail, call: ToolCall, progress: ToolProgressUpdate): Promise<void> {
    const preferences = await this.store.getPreferences().catch(() => undefined);
    const normalized = compactToolProgressUpdate(progress);
    const payload = preferences ? this.sanitizeForPreferences(normalized, preferences) : normalized;
    this.addEvent(task, "tool_progress", normalized.message ?? call.toolName, {
      toolCallId: call.id,
      toolName: call.toolName,
      status: normalized.status ?? "running",
      ...payload,
      ...(call.toolName === "plan_update" ? { uiHidden: true } : {})
    });
    await this.safeAppendTaskTrace(task, {
      kind: "tool_progress",
      timestamp: nowIso(),
      toolCallId: call.id,
      toolName: call.toolName,
      progress: summarizeToolProgressForTrace(normalized)
    });
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
          return await this.executeMemoryAddTool(call, "project", await this.folderForMemoryTool(task, call), task);
        case "project_memory_edit":
          return await this.executeMemoryEditTool(call, "project", await this.folderForMemoryTool(task, call), task);
        case "project_memory_delete":
          return await this.executeMemoryDeleteTool(call, "project", await this.folderForMemoryTool(task, call), task);
        case "skill_create":
          return await this.executeSkillCreateTool(call);
        case "skill_edit":
          return await this.executeSkillEditTool(call);
        case "skill_delete":
          return await this.executeSkillDeleteTool(call);
        case "plan_update":
          return this.executePlanUpdateTool(task, call);
        case "spawn_subagent":
          return await this.executeSpawnSubagentTool(task, call);
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
    await this.addManagedToolProgressEvent(task, call, {
      status: "running",
      operation: "use_skill",
      message: `Loading skill guidance for "${skillId}".`,
      progress: { processed: 0, total: 1, unit: "items" }
    });
    const skill = await this.contextAssembler.loadSkill(task.id, skillId);
    this.addLoadedSkillEvents(task);
    if (!skill) {
      await this.addManagedToolProgressEvent(task, call, {
        status: "failed",
        operation: "use_skill",
        message: `Skill not found or unavailable: ${skillId}.`,
        progress: { processed: 0, total: 1, unit: "items" }
      });
      return managedToolResult(call, false, `Skill not found or unavailable: ${skillId}`);
    }
    await this.addManagedToolProgressEvent(task, call, {
      status: "completed",
      operation: "use_skill",
      message: `Loaded skill guidance: ${skill.title}.`,
      progress: { processed: 1, total: 1, unit: "items" }
    });
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
    folder?: TaskFolderRecord,
    task?: TaskDetail
  ): Promise<ToolResult> {
    const content = normalizeMemoryEntry(String(call.args["content"] ?? ""));
    if (!content) throw new Error("content is required.");
    const section = typeof call.args["section"] === "string" ? call.args["section"] : undefined;
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    if (scope === "project" && task && folder) this.addProjectMemoryVersionEvent(task, folder, before.content, "add", call.id);
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
    folder?: TaskFolderRecord,
    task?: TaskDetail
  ): Promise<ToolResult> {
    const match = String(call.args["match"] ?? "").trim();
    const replacement = normalizeMemoryEntry(String(call.args["replacement"] ?? ""));
    if (!match) throw new Error("match is required.");
    if (!replacement) throw new Error("replacement is required.");
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    if (scope === "project" && task && folder) this.addProjectMemoryVersionEvent(task, folder, before.content, "edit", call.id);
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
    folder?: TaskFolderRecord,
    task?: TaskDetail
  ): Promise<ToolResult> {
    const match = String(call.args["match"] ?? "").trim();
    if (!match) throw new Error("match is required.");
    const before = scope === "project" ? await this.readMemoryDocument("project", requiredFolder(folder)) : await this.readMemoryDocument("user");
    if (scope === "project" && task && folder) this.addProjectMemoryVersionEvent(task, folder, before.content, "delete", call.id);
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

  private addProjectMemoryVersionEvent(
    task: TaskDetail,
    folder: TaskFolderRecord,
    content: string,
    operation: "add" | "edit" | "delete",
    toolCallId?: string
  ): void {
    this.addEvent(task, "project_memory_version_created", `Project memory snapshot before ${operation}.`, {
      folderId: folder.id,
      workRoot: folder.rootPath,
      operation,
      content,
      ...(toolCallId ? { toolCallId } : {}),
      uiHidden: true
    });
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

  private async executeSpawnSubagentTool(task: TaskDetail, call: ToolCall): Promise<ToolResult> {
    if (task.kind === "subagent") {
      return managedToolResult(call, false, "Nested subagent delegation is not supported in V1.");
    }
    const goal = String(call.args["goal"] ?? "").trim();
    if (!goal) throw new Error("goal is required.");
    const children = await this.store.listChildTasks(task.id);
    if (children.length >= SUBAGENT_MAX_CHILDREN_PER_PARENT) {
      return managedToolResult(call, false, `This task already has ${SUBAGENT_MAX_CHILDREN_PER_PARENT} delegated child tasks. Wait for one to finish before spawning another.`);
    }
    const activeChildren = children.filter((child) => isSubagentActiveStatus(child.status));
    if (activeChildren.length >= SUBAGENT_MAX_CONCURRENT_CHILDREN) {
      return managedToolResult(call, false, `This task already has ${SUBAGENT_MAX_CONCURRENT_CHILDREN} running child agents. Wait for one to finish before spawning another.`);
    }
    const context = typeof call.args["context"] === "string" ? String(call.args["context"]).trim() : "";
    const fileHints = stringsFromUnknown(call.args["fileHints"]).slice(0, 12);
    const expectedOutput = parseSubagentExpectedOutput(call.args["expectedOutput"]);
    const title = String(call.args["title"] ?? "").trim();
    const contextSummary = this.buildSubagentContextSummary(task, context, fileHints, expectedOutput);
    const delegation: TaskDelegationMeta = {
      sourceTaskId: task.id,
      sourceToolCallId: call.id,
      goal,
      contextSummary,
      networkEnabled: true,
      expectedOutput
    };
    const handoff = this.buildSubagentHandoffPrompt(task, delegation, fileHints);
    const child = await this.initializeTask(
      handoff,
      this.resolveImmediateTaskTitle(goal, title || `${task.title} / delegated research`),
      task.folderId || "default",
      [],
      {
        kind: "subagent",
        parentTaskId: task.id,
        delegation,
        runMode: "target",
        targetLimits: SUBAGENT_TARGET_LIMITS
      }
    );
    await this.projectSubagentSpawnToParent(task, child);
    void this.runTaskExclusive(child.id, () => this.step(child.id)).catch((error) => {
      this.safeBackgroundCatch(child.id, error);
    });
    return managedToolResult(
      call,
      true,
      JSON.stringify({
        action: "spawned",
        childTaskId: child.id,
        title: child.title,
        status: child.status,
        goal,
        expectedOutput
      })
    );
  }

  private attachSubagentTaskGraph(task: TaskDetail, goal: string): void {
    const nodeId = createId("node");
    const graph = {
      taskId: task.id,
      nodes: [
        {
          id: nodeId,
          role: "research",
          objective: goal,
          allowedToolClasses: [...SUBAGENT_ALLOWED_RISKS],
          contextHints: ["delegated_research", "recent_tool_evidence", "file_hints"],
          acceptanceCriteria: [
            "Collect concrete evidence for the delegated question.",
            "Return a concise final summary aligned with the requested output shape."
          ],
          verification: {
            kind: "read_only",
            method: "Use read-only evidence from files, host observation, or network lookups.",
            required: false,
            status: "not_applicable",
            evidenceRefs: []
          },
          risk: "workspace_read",
          status: "running",
          evidenceRefs: []
        }
      ],
      activeNodeId: nodeId,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.addEvent(task, "task_graph_created", "Task graph created", { graph, uiHidden: true });
    this.addEvent(task, "task_graph_node_started", `research: ${goal}`, {
      nodeId,
      role: "research",
      objective: goal,
      uiHidden: true
    });
  }

  private buildSubagentContextSummary(
    task: TaskDetail,
    explicitContext: string,
    fileHints: string[],
    expectedOutput: TaskDelegationExpectedOutput
  ): string {
    const latestGoal = latestUserText(task);
    const graph = taskGraphFromEvents(task);
    const activeNode = graph?.nodes.find((node) => node.id === graph.activeNodeId);
    const sections = [
      latestGoal ? `Latest user goal: ${latestGoal}` : "",
      explicitContext ? `Delegation context: ${explicitContext}` : "",
      activeNode ? `Active task node: ${activeNode.role} - ${activeNode.objective}` : "",
      fileHints.length > 0 ? `File hints: ${fileHints.join(", ")}` : "",
      `Expected output: ${expectedOutput}.`,
      this.summarizeRecentToolEvidence(task)
    ].filter(Boolean);
    return sections.join("\n").slice(0, 2400);
  }

  private buildSubagentHandoffPrompt(task: TaskDetail, delegation: TaskDelegationMeta, fileHints: string[]): string {
    const latestGoal = latestUserText(task);
    const graph = taskGraphFromEvents(task);
    const activeNode = graph?.nodes.find((node) => node.id === graph.activeNodeId);
    const expectedOutput = describeSubagentExpectedOutput(delegation.expectedOutput);
    const lines = [
      `Parent task: ${task.title}`,
      latestGoal ? `Latest user goal: ${latestGoal}` : "",
      `Delegated goal: ${delegation.goal}`,
      delegation.contextSummary ? `Context summary:\n${delegation.contextSummary}` : "",
      activeNode ? `Active task graph node: ${activeNode.role} - ${activeNode.objective}` : "",
      fileHints.length > 0 ? `File hints:\n- ${fileHints.join("\n- ")}` : "",
      this.summarizeRecentToolEvidence(task),
      `Expected final output: ${expectedOutput}`,
      "Constraints: you are a delegated child research agent. You may inspect local files, host state, and network resources. Do not edit files, do not run destructive or mutating commands, do not ask the user questions, and do not spawn another subagent."
    ].filter(Boolean);
    return lines.join("\n\n");
  }

  private summarizeRecentToolEvidence(task: TaskDetail): string {
    const evidence = task.events
      .filter((event) => !event.reverted && (event.type === "tool_result" || event.type === "web_search_result"))
      .slice(-6)
      .map((event) => {
        const toolName = String(event.payload["toolName"] ?? event.type);
        const label = compactSubagentEvidenceLabel(event);
        return `- ${toolName}: ${label}`;
      });
    return evidence.length > 0 ? `Recent tool evidence:\n${evidence.join("\n")}` : "";
  }

  private buildTaskChildSummary(task: TaskDetail): TaskChildSummary {
    const statusText = latestSubagentStatusText(task);
    const lastAssistantSummary = latestVisibleAssistantSummary(task) || undefined;
    const activeToolName = latestActiveToolName(task);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      parentTaskId: task.parentTaskId ?? "",
      sourceToolCallId: task.delegation?.sourceToolCallId ?? "",
      goal: task.delegation?.goal ?? "",
      statusText,
      ...(lastAssistantSummary ? { lastAssistantSummary } : {}),
      ...(activeToolName ? { activeToolName } : {})
    };
  }

  private async projectSubagentSpawnToParent(parentTask: TaskDetail, childTask: TaskDetail): Promise<void> {
    this.addEvent(parentTask, "subagent_spawned", `Delegated work started: ${childTask.title}`, {
      ...this.buildTaskChildSummary(childTask)
    });
    await this.store.saveTask(parentTask);
  }

  private async projectSubagentStatusToParent(task: TaskDetail): Promise<void> {
    if (task.kind !== "subagent" || !task.parentTaskId) return;
    await this.runTaskExclusive(task.parentTaskId, async () => {
      const parent = await this.store.getTask(task.parentTaskId!);
      if (!parent) return;
      this.addEvent(parent, "subagent_status_changed", `Delegated work ${formatSubagentStatus(task.status)}: ${task.title}`, {
        ...this.buildTaskChildSummary(task)
      });
      await this.store.saveTask(parent);
    });
  }

  private async projectSubagentCompletionToParent(task: TaskDetail, outcome: "completed" | "failed"): Promise<void> {
    if (task.kind !== "subagent" || !task.parentTaskId) return;
    const eventType = outcome === "completed" ? "subagent_completed" : "subagent_failed";
    const summary = outcome === "completed" ? `Delegated work completed: ${task.title}` : `Delegated work failed: ${task.title}`;
    await this.runTaskExclusive(task.parentTaskId, async () => {
      const parent = await this.store.getTask(task.parentTaskId!);
      if (!parent) return;
      this.addEvent(parent, eventType, summary, {
        ...this.buildTaskChildSummary(task)
      });
      await this.store.saveTask(parent);
    });
  }

  private subagentAutoApproval(task: TaskDetail, call: ToolCall, assessment: RiskAssessment): boolean {
    if (task.kind !== "subagent") return false;
    if (call.toolName === "spawn_subagent") return false;
    return SUBAGENT_ALLOWED_RISKS.includes(assessment.category);
  }

  private async failSubagentTask(task: TaskDetail, message: string, payload: Record<string, unknown> = {}): Promise<TaskDetail> {
    this.addEvent(task, "assistant_message", message, payload);
    this.setStatus(task, "failed");
    await this.updateLoadedSkillStats(task, false).catch(() => undefined);
    await this.store.saveTask(task);
    await this.projectSubagentCompletionToParent(task, "failed");
    return task;
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
    const fullPath = await resolveTaskPath(task.workRoot || defaultTaskWorkRoot(), inputPath);
    return { files: [await this.snapshotPath(checkpointId, task.workRoot || defaultTaskWorkRoot(), fullPath, 0)], truncated: false };
  }

  private async snapshotWorkRootTextFiles(
    checkpointId: string,
    task: TaskDetail
  ): Promise<{ files: TaskCheckpoint["files"]; truncated: boolean }> {
    const root = await canonicalizeExistingDirectory(task.workRoot || defaultTaskWorkRoot());
    const candidates = await collectCheckpointCandidates(root, 80, 2_000_000);
    const files = [];
    for (let index = 0; index < candidates.files.length; index += 1) {
      files.push(await this.snapshotPath(checkpointId, root, candidates.files[index]!, index));
    }
    return { files, truncated: candidates.truncated };
  }

  private async snapshotPath(checkpointId: string, workRoot: string, fullPath: string, index: number): Promise<TaskCheckpoint["files"][number]> {
    const root = await canonicalizeExistingDirectory(workRoot || defaultTaskWorkRoot());
    const normalized = await resolveTaskPath(root, fullPath);
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
    const selected = await this.filterCheckpointFiles(task, checkpoint, filePaths);
    for (const file of selected) {
      const target = await resolveTaskPath(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot(), file.path);
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

  private async filterCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint, filePaths?: string[]): Promise<TaskCheckpoint["files"]> {
    if (!filePaths || filePaths.length === 0) return checkpoint.files;
    const root = await canonicalizeExistingDirectory(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot());
    const requested = new Set(
      await Promise.all(
        filePaths.map(async (filePath) => {
          const normalized = await resolveTaskPath(root, filePath);
          return process.platform === "win32" ? normalized.toLowerCase() : normalized;
        })
      )
    );
    return checkpoint.files.filter((file) => {
      const target = resolve(file.path);
      const key = process.platform === "win32" ? target.toLowerCase() : target;
      return requested.has(key);
    });
  }

  private async previewCheckpointFiles(task: TaskDetail, checkpoint: TaskCheckpoint, filePaths?: string[]): Promise<TaskRollbackFileChange[]> {
    const root = await canonicalizeExistingDirectory(checkpoint.workRoot || task.workRoot || defaultTaskWorkRoot());
    const selected = await this.filterCheckpointFiles(task, checkpoint, filePaths);
    const changes: TaskRollbackFileChange[] = [];
    for (const file of selected) {
      const target = await resolveTaskPath(root, file.path);
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
    const reasoningContent = findReasoningContentForToolCall(task, result.toolCallId);
    this.addEvent(task, "tool_result", result.ok ? "Tool completed" : "Tool failed", {
      id: result.id,
      toolCallId: result.toolCallId,
      toolName: call.toolName,
      args,
      ok: result.ok,
      output,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(call.toolName === "plan_update" ? { uiHidden: true } : {})
    });
    await this.safeAppendTaskTrace(task, {
      kind: "tool_result",
      timestamp: nowIso(),
      toolCallId: result.toolCallId,
      toolName: call.toolName,
      args: call.args,
      ok: result.ok,
      output: result.output,
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
    const verification = verificationResultFromToolEvent(task, toolEvent);
    if (verification) {
      this.addEvent(task, "verification_result_recorded", verification.summary, {
        nodeId: verification.nodeId,
        status: verification.status,
        evidenceRef: verification.evidenceRef,
        toolName: verification.toolName
      });
    }
    this.contextAssembler.getFileStateTracker(task.id).updateFromToolResult(toolEvent);
    await this.maybeAutoRenameTask(task, { reason: "tool_result", toolName: call.toolName });
  }

  private async safeAppendModelTrace(task: TaskDetail, event: ModelTraceEvent): Promise<void> {
    await this.traceRecorder.safeAppendModel(task, event);
  }

  private async maybeAutoRenameTask(
    task: TaskDetail,
    trigger: { reason: "assistant_output"; text: string } | { reason: "tool_result"; toolName: string }
  ): Promise<void> {
    const goal = latestUserText(task);
    if (!shouldAutoRenameTask(task, goal, trigger)) return;
    const previousTitle = task.title;
    let result: TaskTitleResponse;
    try {
      result = await this.generateTaskTitle({ goal, useLocalFallback: false });
    } catch {
      result = { title: createLocalTaskTitle(goal), source: "local_fallback" };
    }
    const nextTitle = result.title.trim() || createLocalTaskTitle(goal);
    const changed = normalizeTitleKey(nextTitle) !== normalizeTitleKey(previousTitle);
    if (changed) task.title = nextTitle;
    this.addEvent(task, "task_title_updated", changed ? nextTitle : previousTitle, {
      source: "auto",
      titleSource: result.source,
      trigger,
      previousTitle,
      newTitle: changed ? nextTitle : previousTitle,
      changed,
      uiHidden: true
    });
    await this.safeAppendTaskTrace(task, {
      kind: "task_title_updated",
      timestamp: nowIso(),
      source: "auto",
      titleSource: result.source,
      trigger,
      previousTitle,
      newTitle: changed ? nextTitle : previousTitle,
      changed
    });
  }

  private async safeAppendTaskTrace(task: TaskDetail, entry: Record<string, unknown>): Promise<void> {
    await this.traceRecorder.safeAppendTask(task, entry);
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
    // Destructive operations are never auto-approved, always require explicit approval
    if (category === "destructive") {
      return { allowed: false, forceApproval: true };
    }
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
    if (autoApproveAllows(preferences, category)) {
      return {
        allowed: true,
        forceApproval: false,
        reason: "rule auto-approve",
        source: "autoApprove"
      };
    }
    return { allowed: false, forceApproval: false };
  }

  private async maybeApproveWithLlm(
    task: TaskDetail,
    call: ToolCall,
    assessment: RiskAssessment,
    metadata: Record<string, unknown>,
    preferences: UserPreferences
  ): Promise<{ evaluated: boolean; allowed: boolean; reason: string; tokenUsage?: ModelUsage }> {
    if (preferences.permissionMode !== "auto_approval") return { evaluated: false, allowed: false, reason: "LLM approval is only active in auto approval mode." };
    if (preferences.llmApprovalMode !== "non_destructive") return { evaluated: false, allowed: false, reason: "LLM approval disabled." };
    if (assessment.category === "destructive") return { evaluated: true, allowed: false, reason: "Destructive tools cannot be approved by LLM policy." };

    const prompt = [
      "Decide whether this tool call can be auto-approved without asking the user.",
      "Return only compact JSON: {\"allow\": boolean, \"reason\": string}.",
      "Allow only if the risk, arguments, and task context are clear and non-destructive.",
      "Deny when the action is ambiguous, destructive, credential-sensitive, or broader than the recorded task need.",
      "",
      stableStringify({
        taskId: task.id,
        taskStatus: task.status,
        workRoot: task.workRoot,
        toolName: call.toolName,
        riskCategory: assessment.category,
        riskReason: assessment.reason,
        args: this.sanitizeForPreferences(call.args, preferences),
        metadata: this.sanitizeForPreferences(metadata, preferences)
      })
    ].join("\n");
    const approvalTask: TaskDetail = {
      id: `${task.id}:llm_approval:${call.id}`,
      title: "LLM tool approval review",
      kind: "primary",
      folderId: task.folderId,
      workRoot: task.workRoot,
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: createId("event"),
          taskId: `${task.id}:llm_approval:${call.id}`,
          type: "user_message",
          createdAt: nowIso(),
          summary: prompt,
          payload: {}
        }
      ]
    };
    try {
      const turn = await this.model.next(approvalTask, {
        streamId: createId("approval_stream"),
        onAssistantDelta: async () => undefined,
        onThinkingDelta: async () => undefined,
        onTrace: async (event) => {
          await this.safeAppendModelTrace(task, {
            ...event,
            payload: {
              ...event.payload,
              approvalReviewForToolCallId: call.id
            }
          });
        }
      });
      await this.recordPromptCacheStats(task, turn.usage);
      if (turn.kind !== "final") {
        return { evaluated: true, allowed: false, reason: "LLM approval review did not return a final decision.", ...(turn.usage ? { tokenUsage: turn.usage } : {}) };
      }
      const parsed = parseApprovalDecision(turn.message);
      return {
        evaluated: true,
        allowed: parsed.allow,
        reason: parsed.reason,
        ...(turn.usage ? { tokenUsage: turn.usage } : {})
      };
    } catch (error) {
      return {
        evaluated: true,
        allowed: false,
        reason: `LLM approval review failed: ${sanitizeSensitiveText(error instanceof Error ? error.message : String(error))}.`
      };
    }
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
      this.addEvent(task, "skill_loaded", skill.title, {
        skillId: skill.id,
        title: skill.title,
        status: skill.status,
        source: describeIntegrationSource(skill),
        matchReason: "The agent explicitly loaded this active skill from the bounded catalog for the current task.",
        matchedSignals: skill.applicability.keywords.slice(0, 8),
        requiredTools: skill.applicability.requiredTools,
        requiredContext: skill.applicability.requiredContext,
        readOnlySuggestion: looksReadOnlySkillBody(skill.body, skill.applicability.requiredTools)
      });
    }
    for (const skipped of this.contextAssembler.drainSkippedSkillEvents(task.id)) {
      this.addEvent(task, "skill_load_skipped", skipped.skill?.title ?? skipped.requested ?? "Skill skipped", {
        requested: skipped.requested,
        reason: skipped.reason,
        ...(skipped.skill
          ? {
              skillId: skipped.skill.id,
              title: skipped.skill.title,
              status: skipped.skill.status,
              source: describeIntegrationSource(skipped.skill),
              matchedSignals: skipped.skill.applicability.keywords.slice(0, 8)
            }
          : {})
      });
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

function shouldAutoRenameTask(
  task: TaskDetail,
  goal: string,
  trigger: { reason: "assistant_output"; text: string } | { reason: "tool_result"; toolName: string }
): boolean {
  if (!goal.trim()) return false;
  if (task.events.some((event) => event.type === "task_title_updated" && !event.reverted)) return false;
  const created = task.events.find((event) => event.type === "task_created" && !event.reverted);
  if (created?.payload["titleSource"] === "explicit") return false;
  if (trigger.reason === "assistant_output" && trigger.text.trim().length < AUTO_RENAME_ASSISTANT_CHARS) return false;
  return created?.payload["titleSource"] === "local_fallback";
}

function normalizeTitleKey(value: string): string {
  return value.replace(/[\s"'“”‘’`.,，。!！?？:：;；\-_/\\()[\]{}]+/gu, "").trim().toLowerCase();
}

function lowValueMemoryKey(memory: TaskMemory): string {
  const toolKey = [...new Set(memory.toolsUsed.map((tool) => tool.toolName.toLowerCase()))].sort().join(",");
  return [
    normalizeTitleKey(memory.title || memory.goal).slice(0, 80),
    memory.meta.outcome,
    memory.meta.complexity,
    toolKey
  ].join("|");
}

type RuleAutoApproveRisk = UserPreferences["autoApproveRiskCategories"][number];
type PermissionMode = UserPreferences["permissionMode"];

const ruleAutoApproveMap: Record<UserPreferences["autoApproveStrategy"], RuleAutoApproveRisk[]> = {
  ask: [],
  read_only: ["host_observation", "workspace_read"],
  balanced: ["host_observation", "workspace_read", "network"],
  custom: [],
  all_safe: ["host_observation", "workspace_read", "workspace_write", "shell", "network"]
};

const legacyAutoApproveMap: Record<UserPreferences["autoApprove"], UserPreferences["autoApproveStrategy"]> = {
  none: "ask",
  low: "read_only",
  medium: "balanced",
  all: "all_safe"
};

function normalizeAutoApprovePreferences(preferences: PreferencesPatch & Record<string, unknown>, patch: PreferencesPatch): void {
  const hasPermissionMode = Object.prototype.hasOwnProperty.call(patch, "permissionMode");
  const hasNewStrategy = Object.prototype.hasOwnProperty.call(patch, "autoApproveStrategy");
  const hasNewCategories = Object.prototype.hasOwnProperty.call(patch, "autoApproveRiskCategories");
  const hasLegacy = Object.prototype.hasOwnProperty.call(patch, "autoApprove");

  if (hasPermissionMode) {
    const mode = normalizePermissionMode(preferences["permissionMode"]);
    preferences["permissionMode"] = mode;
    if (mode === "auto_approval") {
      const strategy = hasNewStrategy
        ? ((preferences["autoApproveStrategy"] as UserPreferences["autoApproveStrategy"]) ?? "custom")
        : "custom";
      const categories = autoApproveCategoriesForStrategy(strategy, preferences["autoApproveRiskCategories"]);
      const selected = hasNewCategories ? categories : categories.length > 0 ? categories : ruleAutoApproveMap.balanced;
      preferences["autoApproveStrategy"] = "custom";
      preferences["autoApproveRiskCategories"] = selected;
      preferences["autoApprove"] = legacyAutoApproveForCategories(selected);
    } else {
      preferences["autoApproveStrategy"] = "ask";
      preferences["autoApproveRiskCategories"] = [];
      preferences["autoApprove"] = "none";
    }
    return;
  }

  if (hasLegacy && !hasNewStrategy && !hasNewCategories) {
    preferences["autoApproveStrategy"] = legacyAutoApproveMap[(preferences["autoApprove"] as UserPreferences["autoApprove"]) ?? "none"] ?? "ask";
  }

  const strategy = (preferences["autoApproveStrategy"] as UserPreferences["autoApproveStrategy"]) ?? legacyAutoApproveMap[(preferences["autoApprove"] as UserPreferences["autoApprove"]) ?? "none"] ?? "ask";
  preferences["autoApproveStrategy"] = strategy;
  const categories = autoApproveCategoriesForStrategy(strategy, preferences["autoApproveRiskCategories"]);
  preferences["autoApproveRiskCategories"] = categories;
  preferences["autoApprove"] = legacyAutoApproveForStrategy(strategy);
  preferences["permissionMode"] = strategy === "ask" && categories.length === 0 ? "ask" : "auto_approval";
}

function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "read_only" || value === "full_access" || value === "custom" || value === "auto_approval" ? value : "ask";
}

function autoApproveCategoriesForStrategy(strategy: UserPreferences["autoApproveStrategy"], current: unknown): RuleAutoApproveRisk[] {
  if (strategy !== "custom") return ruleAutoApproveMap[strategy];
  const values = Array.isArray(current) ? current : [];
  return values.filter((item): item is RuleAutoApproveRisk => isRuleAutoApproveRisk(item));
}

function legacyAutoApproveForStrategy(strategy: UserPreferences["autoApproveStrategy"]): UserPreferences["autoApprove"] {
  if (strategy === "all_safe") return "all";
  if (strategy === "balanced") return "medium";
  if (strategy === "read_only") return "low";
  return "none";
}

function legacyAutoApproveForCategories(categories: RuleAutoApproveRisk[]): UserPreferences["autoApprove"] {
  const selected = new Set(categories);
  if (ruleAutoApproveMap.all_safe.every((risk) => selected.has(risk))) return "all";
  if (ruleAutoApproveMap.balanced.every((risk) => selected.has(risk)) && selected.size === ruleAutoApproveMap.balanced.length) return "medium";
  if (ruleAutoApproveMap.read_only.every((risk) => selected.has(risk)) && selected.size === ruleAutoApproveMap.read_only.length) return "low";
  return "none";
}

function isRuleAutoApproveRisk(value: unknown): value is RuleAutoApproveRisk {
  return value === "host_observation" || value === "workspace_read" || value === "workspace_write" || value === "shell" || value === "network";
}

function autoApproveAllows(preferences: UserPreferences, category: RiskCategory): boolean {
  if (category === "destructive") return false;
  const legacyAutoApproval =
    preferences.permissionMode === "ask" &&
    (preferences.autoApprove !== "none" || preferences.autoApproveStrategy !== "ask" || (preferences.autoApproveRiskCategories?.length ?? 0) > 0);
  if (preferences.permissionMode !== "auto_approval" && !legacyAutoApproval) return false;
  const strategy =
    preferences.autoApproveStrategy === "ask" && preferences.autoApprove !== "none" && (preferences.autoApproveRiskCategories?.length ?? 0) === 0
      ? legacyAutoApproveMap[preferences.autoApprove]
      : preferences.autoApproveStrategy ?? legacyAutoApproveMap[preferences.autoApprove] ?? "ask";
  const allowed = autoApproveCategoriesForStrategy(strategy, preferences.autoApproveRiskCategories);
  return allowed.includes(category as RuleAutoApproveRisk);
}

function parseApprovalDecision(message: string): { allow: boolean; reason: string } {
  const parsed = parseFirstJsonObject(message);
  if (!parsed) return { allow: false, reason: "LLM approval review returned non-JSON output." };
  const allow = parsed["allow"] === true;
  const reason = typeof parsed["reason"] === "string" && parsed["reason"].trim()
    ? parsed["reason"].trim().slice(0, 600)
    : allow
      ? "LLM approval review allowed the non-destructive tool."
      : "LLM approval review denied the tool.";
  return { allow, reason };
}

function parseFirstJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidates = [trimmed, start >= 0 && end >= start ? trimmed.slice(start, end + 1) : ""].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (nested === undefined ? undefined : nested), 2);
}

function normalizeTargetLimits(input: TaskRunOptions["targetLimits"] | undefined): typeof DEFAULT_TARGET_LIMITS {
  return {
    maxModelTurns: positiveInt(input?.maxModelTurns, DEFAULT_TARGET_LIMITS.maxModelTurns),
    maxToolCalls: positiveInt(input?.maxToolCalls, DEFAULT_TARGET_LIMITS.maxToolCalls),
    maxWallTimeMs: positiveInt(input?.maxWallTimeMs, DEFAULT_TARGET_LIMITS.maxWallTimeMs)
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function targetLimitReached(task: TaskDetail, modelTurnsInRun: number, toolResultsInTask: number, startedAt: number): string | null {
  if (task.runMode !== "target") return null;
  const limits = normalizeTargetLimits(task.targetLimits);
  if (modelTurnsInRun >= limits.maxModelTurns) {
    return `Goal mode paused after ${limits.maxModelTurns} model turns. Review evidence, adjust the goal, or resume explicitly.`;
  }
  if (toolResultsInTask >= limits.maxToolCalls) {
    return `Goal mode paused after ${limits.maxToolCalls} tool results. Review evidence, adjust permissions or scope, then resume explicitly.`;
  }
  if (Date.now() - startedAt >= limits.maxWallTimeMs) {
    return `Goal mode paused after ${Math.round(limits.maxWallTimeMs / 60000)} minutes. Review evidence before continuing.`;
  }
  return null;
}

function countToolResultEvents(task: TaskDetail): number {
  return task.events.filter((event) => event.type === "tool_result" && !event.reverted).length;
}

function isReadableAssistantPreamble(event: TaskEvent): boolean {
  const text = [
    event.summary,
    typeof event.payload["delta"] === "string" ? event.payload["delta"] : "",
    typeof event.payload["message"] === "string" ? event.payload["message"] : "",
    typeof event.payload["text"] === "string" ? event.payload["text"] : ""
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return false;
  if (/<function_calls\b|<invoke\s+name=/i.test(text)) return false;
  if (/^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(text)) return false;
  return /[A-Za-z\u4e00-\u9fff]/u.test(text);
}

function buildIntegrationStatusSnapshot(input: {
  kind: IntegrationKind;
  callbackUrl: string | undefined;
  publicKey?: string | undefined;
  verificationTokenConfigured?: boolean | undefined;
  signingSecretConfigured?: boolean | undefined;
  secretTokenConfigured?: boolean | undefined;
  wecomTokenConfigured?: boolean | undefined;
  wecomEncodingAesKeyConfigured?: boolean | undefined;
  botTokenConfigured?: boolean | undefined;
}) {
  return input;
}

function progressAdvancedEnough(
  unit: ToolProgressUpdate["progress"] extends { unit?: infer U } ? U : string | undefined,
  processed: number,
  previousProcessed: number,
  total: number,
  previousTotal: number
): boolean {
  if (!Number.isFinite(processed)) return false;
  if (!Number.isFinite(previousProcessed) || processed < previousProcessed) return true;
  if (Number.isFinite(total) && total !== previousTotal && total > 0) return true;
  const threshold =
    unit === "bytes"
      ? TRACE_PROGRESS_BYTES_STEP
      : unit === "lines"
        ? TRACE_PROGRESS_LINE_STEP
        : unit === "files" || unit === "items"
          ? TRACE_PROGRESS_ITEM_STEP
          : 8;
  return processed - previousProcessed >= threshold;
}

function toFiniteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").trim().length;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const compact = prepareTitleSource(goal);
  const style = resolveTitleStyle(language, compact);
  if (style.kind === "zh") {
    return createCjkLocalTitle(compact, 22, "新任务");
  }
  if (style.kind === "ja") {
    return createCjkLocalTitle(compact, 26, "新しいタスク");
  }
  if (style.kind === "ko") {
    return createCjkLocalTitle(compact, 28, "새 작업");
  }
  return createLatinLocalTitle(compact) || "New Task";
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
    const cleaned = cleanCjkTitle(stripCjkRequestPrefix(firstTitleClause(stripped)));
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 22);
  }
  if (style.kind === "ja") {
    const cleaned = cleanCjkTitle(stripCjkRequestPrefix(firstTitleClause(stripped)));
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 26);
  }
  if (style.kind === "ko") {
    const cleaned = cleanCjkTitle(stripCjkRequestPrefix(firstTitleClause(stripped)));
    return truncateCjkTitle(cleaned || createLocalTaskTitle(goal, language), 28);
  }
  return createLatinLocalTitle(stripped) || createLocalTaskTitle(goal, language);
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
  return text.split(/[。！？；\n!?;]/).map((part) => part.trim()).find(Boolean) ?? text;
}

function prepareTitleSource(goal: string): string {
  return goal
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function createCjkLocalTitle(text: string, maxChars: number, fallback: string): string {
  const cleaned = cleanCjkTitle(stripCjkRequestPrefix(firstTitleClause(text)));
  return truncateCjkTitle(cleaned, maxChars) || fallback;
}

function cleanCjkTitle(text: string): string {
  return text
    .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’`~@#$%^&*_+=|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCjkRequestPrefix(text: string): string {
  let current = text.trim();
  for (let index = 0; index < 5; index += 1) {
    const next = current
      .replace(/^(?:请(?:你)?|请帮我|帮我|帮忙|麻烦(?:你)?|能否|能不能|可以(?:帮我|请你)?|麻烦帮我)\s*/u, "")
      .replace(/^(?:我(?:想|需要|希望)(?:你)?|需要)\s*/u, "")
      .replace(/^(?:在)?(?:当前|这个|此)(?:工作区|项目|仓库|目录|文件夹)(?:中|里|下)?\s*/u, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function truncateCjkTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return trimTrailingCjkConnector(text);
  const chars = [...text];
  return trimTrailingCjkConnector(chars.slice(0, maxChars).join("").trim());
}

function trimTrailingCjkConnector(text: string): string {
  return text.replace(/(?:以及|并且|而且|或者|还是|然后|并|和|与|或|的|了|吗|呢|吧|请)\s*$/u, "").trim();
}

function createLatinLocalTitle(text: string): string {
  const cleaned = stripLatinRequestNoise(firstTitleClause(text));
  const tokens = tokenizeLatinTitle(cleaned);
  if (tokens.length === 0) return "";
  const selected = selectLatinTitleTokens(tokens);
  return selected.map((token, index) => formatLatinTitleToken(token, index)).join(" ").replace(/\s+/g, " ").trim();
}

function stripLatinRequestNoise(text: string): string {
  let current = text
    .replace(/^["'“”‘’`]+|["'“”‘’`.,:;]+$/g, "")
    .replace(/\b(?:please|thanks|thank you)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 6; index += 1) {
    const next = current
      .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
      .replace(/^(?:help\s+me|help|assist\s+me)\s+(?:to\s+)?/i, "")
      .replace(/^(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)/i, "")
      .replace(/^(?:(?:in|within|under)\s+(?:the\s+)?(?:current\s+)?(?:work\s*root|workspace|repo(?:sitory)?|project|folder|directory)\s+)/i, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current.replace(/\s+/g, " ").trim();
}

function tokenizeLatinTitle(text: string): string[] {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}._/#:@-]*/gu) ?? [])
    .map((token) => token.replace(/^[-_.:/#@]+|[-_.:/#@]+$/g, ""))
    .filter(Boolean);
}

function selectLatinTitleTokens(tokens: string[]): string[] {
  const withoutLeadingNoise = [...tokens];
  while (withoutLeadingNoise.length > 1 && isLeadingLatinFiller(withoutLeadingNoise[0]!)) {
    withoutLeadingNoise.shift();
  }
  const selected = withoutLeadingNoise.slice(0, 7);
  while (selected.length > 1 && isTrailingLatinConnector(selected[selected.length - 1]!)) {
    selected.pop();
  }
  let cursor = selected.length;
  while (selected.length < Math.min(3, withoutLeadingNoise.length) && cursor < withoutLeadingNoise.length) {
    selected.push(withoutLeadingNoise[cursor]!);
    cursor += 1;
  }
  while (selected.length > 1 && isTrailingLatinConnector(selected[selected.length - 1]!)) {
    selected.pop();
  }
  return selected;
}

function isLeadingLatinFiller(token: string): boolean {
  return /^(?:the|a|an|this|that|current)$/i.test(token);
}

function isTrailingLatinConnector(token: string): boolean {
  return /^(?:and|or|to|from|with|for|of|in|on|at|by|about|then|the|a|an)$/i.test(token);
}

function formatLatinTitleToken(token: string, index: number): string {
  if (shouldPreserveLatinToken(token)) return token;
  const lower = token.toLocaleLowerCase("en-US");
  return index === 0 ? `${lower.charAt(0).toLocaleUpperCase("en-US")}${lower.slice(1)}` : lower;
}

function shouldPreserveLatinToken(token: string): boolean {
  return /[._/#:@-]/.test(token) || /^[A-Z0-9]{2,}$/.test(token) || /[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(token);
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
    maxFileBytes: Number(process.env["AGENT_WORKBENCH_ATTACHMENT_MAX_FILE_BYTES"] ?? process.env["SCC_ATTACHMENT_MAX_FILE_BYTES"] ?? 20 * 1024 * 1024),
    maxTaskBytes: Number(process.env["AGENT_WORKBENCH_ATTACHMENT_MAX_TASK_BYTES"] ?? process.env["SCC_ATTACHMENT_MAX_TASK_BYTES"] ?? 100 * 1024 * 1024)
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
  const base = basename(fileName);
  let sanitized = "";
  for (const char of base) {
    const code = char.charCodeAt(0);
    sanitized += code < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char;
  }
  return sanitized.slice(0, 180) || "attachment.bin";
}

async function resolveTaskPath(workRoot: string, input: string): Promise<string> {
  return resolveWorkspacePathStrict(workRoot || defaultTaskWorkRoot(), input);
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
      if (entry.isSymbolicLink()) continue;
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

function findLastEventIndexByType(events: TaskEvent[], type: TaskEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return index;
  }
  return -1;
}

function findReasoningContentForToolCall(task: Pick<TaskDetail, "events">, toolCallId: string): string | undefined {
  for (let index = task.events.length - 1; index >= 0; index -= 1) {
    const event = task.events[index];
    if (!event || String(event.payload["toolCallId"] ?? "") !== toolCallId) continue;
    const reasoningContent = event.payload["reasoningContent"];
    if (typeof reasoningContent === "string" && reasoningContent.length > 0) return reasoningContent;
  }
  return undefined;
}

function collectThinkingForStream(task: Pick<TaskDetail, "events">, streamId: string): string | undefined {
  const normalized = streamId.trim();
  if (!normalized) return undefined;
  let combined = "";
  for (const event of task.events) {
    if (event.type !== "thinking_delta") continue;
    if (String(event.payload["streamId"] ?? "").trim() !== normalized) continue;
    const delta = typeof event.payload["delta"] === "string" ? event.payload["delta"] : event.summary;
    if (!delta) continue;
    combined = appendThinkingDeltaText(combined, delta);
  }
  const trimmed = combined.trim();
  return trimmed || undefined;
}

function appendThinkingDeltaText(current: string, delta: string): string {
  if (!current) return current + delta;
  return `${current}${thinkingDeltaSeparator(current, delta)}${delta}`;
}

function thinkingDeltaSeparator(current: string, delta: string): string {
  if (!current || !delta) return "";
  if (/\s$/.test(current) || /^\s/.test(delta)) return "";
  if (/^[,.;:!?，。！？；：、)\]}>"'”’]/.test(delta)) return "";
  if (/[([{"'“‘]$/.test(current)) return "";
  if (/[\u3400-\u9fff]$/.test(current) || /^[\u3400-\u9fff]/.test(delta)) return "";
  return " ";
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
  return resolve(
    process.env["AGENT_WORKBENCH_MEMORY_DIR"]?.trim() ||
      process.env["SCC_MEMORY_DIR"]?.trim() ||
      resolve(findWorkspaceRoot(), "data", "memory")
  );
}

function memoryPathHash(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 20);
}

function defaultMemoryContent(scope: "user" | "project", folder?: TaskFolderRecord): string {
  if (scope === "user") {
    return [
      "# USER.md",
      "",
      "Stable user preferences for Agent Workbench. Keep entries short, durable, and broadly useful.",
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

function parseSubagentExpectedOutput(value: unknown): TaskDelegationExpectedOutput {
  return value === "checklist" || value === "comparison" ? value : "summary";
}

function describeSubagentExpectedOutput(value: TaskDelegationExpectedOutput): string {
  if (value === "checklist") return "A concise checklist with concrete findings and open issues.";
  if (value === "comparison") return "A concise comparison that contrasts the relevant options with evidence.";
  return "A concise summary with the key findings and evidence.";
}

function isSubagentActiveStatus(status: TaskDetail["status"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_for_user";
}

function latestVisibleAssistantSummary(task: TaskDetail): string {
  const event = [...task.events]
    .reverse()
    .find((item) => item.type === "assistant_message" && !item.reverted && String(item.summary ?? "").trim());
  return String(event?.summary ?? "").trim();
}

function latestActiveToolName(task: TaskDetail): string {
  const completed = new Set(
    task.events
      .filter((event) => event.type === "tool_result" && !event.reverted)
      .map((event) => String(event.payload["toolCallId"] ?? ""))
      .filter(Boolean)
  );
  const event = [...task.events].reverse().find((item) => {
    if (item.reverted) return false;
    if (item.type !== "tool_started" && item.type !== "tool_progress") return false;
    const toolCallId = String(item.payload["toolCallId"] ?? "");
    return !toolCallId || !completed.has(toolCallId);
  });
  return String(event?.payload["toolName"] ?? "").trim();
}

function latestSubagentStatusText(task: TaskDetail): string {
  const assistant = latestVisibleAssistantSummary(task);
  if (assistant) return assistant;
  const activeTool = latestActiveToolName(task);
  if (activeTool && task.status === "running") return `Running ${activeTool}`;
  const event = [...task.events]
    .reverse()
    .find((item) =>
      !item.reverted &&
      (item.type === "status_changed" ||
        item.type === "model_no_progress" ||
        item.type === "tool_started" ||
        item.type === "tool_progress" ||
        item.type === "approval_pending")
    );
  return String(event?.summary ?? formatSubagentStatus(task.status)).trim();
}

function formatSubagentStatus(status: TaskDetail["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "waiting_for_user":
      return "waiting for user";
    case "waiting_approval":
      return "waiting approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

function compactSubagentEvidenceLabel(event: TaskEvent): string {
  const output = String(event.payload["output"] ?? "").trim();
  if (output) return output.replace(/\s+/g, " ").slice(0, 180);
  const summary = String(event.payload["summary"] ?? event.summary ?? "").trim();
  if (summary) return summary.replace(/\s+/g, " ").slice(0, 180);
  const args = recordFromUnknown(event.payload["args"]);
  for (const key of ["path", "targetPath", "query", "command", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 180);
  }
  return event.summary.trim().slice(0, 180) || "Recorded evidence";
}

function isManagedStateTool(toolName: string): boolean {
  return (
    toolName === "ask_user" ||
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
    toolName === "plan_update" ||
    toolName === "spawn_subagent"
  );
}

function isApprovalBypassedStateTool(toolName: string): boolean {
  return toolName === "plan_update";
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

function isInternalContinuationFinal(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return (
    /^Internal continuity note\b/i.test(text) ||
    /^Prior\s+(?:thinking|reasoning)\s+retained\s+for\s+continuity\b/i.test(text) ||
    /Do not quote this note verbatim/i.test(text)
  );
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
