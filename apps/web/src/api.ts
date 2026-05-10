import type {
  ApprovalDecision,
  GlobalPermissionGrant,
  IntegrationProviderConfig,
  IntegrationProviderCreateRequest,
  IntegrationProviderPatchRequest,
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
  McpServerConfig,
  McpServerCreateRequest,
  McpServerPatchRequest,
  McpServerStatus,
  McpToolSummary,
  ModelProviderCreateRequest,
  ModelProviderPatchRequest,
  ModelProviderRecord,
  MemoryDocument,
  MemoryDocumentCompactResult,
  MemoryDocumentPatch,
  PatternRecord,
  PreferencesPatch,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ProjectMemoryPatchRequest,
  ReflectionSession,
  RiskCategory,
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SkillBulkDeleteRequest,
  SkillCorrectionRequest,
  SkillConflict,
  SkillCuratorItem,
  SkillCreateRequest,
  SkillDuplicateGroup,
  SkillMergeRequest,
  SkillRecord,
  SkillStatusPatch,
  SkillUpdateRequest,
  TaskDeleteRequest,
  TaskDeleteResult,
  TaskDetail,
  TaskTurn,
  TaskTurnEditRequest,
  TaskTurnRevertResult,
  TaskAttachment,
  TaskAttachmentUploadRequest,
  TaskCheckpoint,
  TaskRollbackPreview,
  TaskFolderClearRequest,
  TaskFolderClearResult,
  TaskFolderDeleteRequest,
  TaskFolderDeleteResult,
  TaskFolderCreateRequest,
  TaskFolderPatchRequest,
  TaskFolderRecord,
  TaskPatchRequest,
  TaskRollbackRequest,
  TaskRollbackResult,
  TaskTitleResponse,
  TaskTranscriptItem,
  TaskMemory,
  UserPreferences,
  ConversationSummary,
  PromptCacheStats,
  WebSearchProviderConfig,
  WebSearchProviderCreateRequest,
  WebSearchProviderPatchRequest
} from "@scc/shared";

const apiBase = import.meta.env["VITE_API_BASE"] ?? "";
const REQUEST_TIMEOUT_MS = 30000;
const TASK_EVENT_WINDOW = 600;

export interface RequestMeta {
  startTime: number;
  endTime?: number;
  duration?: number;
  path: string;
  status?: number;
}

let lastRequestMeta: RequestMeta | null = null;

export function getLastRequestMeta(): RequestMeta | null {
  return lastRequestMeta;
}

const friendlyErrorMessages: Record<number, string> = {
  400: "请求参数有误，请检查输入后重试。",
  401: "未授权，请检查登录状态。",
  403: "无权访问此资源。",
  404: "请求的资源不存在。",
  409: "资源冲突，请刷新后重试。",
  422: "请求数据验证失败，请检查输入。",
  429: "请求过于频繁，请稍后再试。",
  500: "服务器内部错误，请稍后重试。",
  502: "网关错误，服务可能暂时不可用。",
  503: "服务暂时不可用，请稍后重试。"
};

function getFriendlyErrorMessage(response: Response, bodyText: string): string {
  const status = response.status;
  const backendMessage = parseBackendError(bodyText);
  if (backendMessage) {
    if (/connection error|failed to fetch|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(backendMessage)) {
      return "模型服务连接失败。请检查模型配置、Base URL、API Key 或网络状态，然后重试。";
    }
    if (/no model provider|no provider|not configured/i.test(backendMessage)) {
      return "尚未配置可用模型。请先连接或添加模型配置。";
    }
    if (status >= 500 || /model provider|title|provider|connection/i.test(backendMessage)) return backendMessage;
  }
  if (friendlyErrorMessages[status]) return friendlyErrorMessages[status];
  if (bodyText && bodyText.length < 200) return bodyText;
  return `请求失败 (${status})。`;
}

function parseBackendError(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
    const value = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
    return value.trim() || null;
  } catch {
    return bodyText.length < 200 ? bodyText.trim() || null : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startTime = performance.now();

  lastRequestMeta = { startTime, path };

  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers,
      signal: controller.signal
    });
    globalThis.clearTimeout(timeoutId);
    const endTime = performance.now();
    const duration = Math.round(endTime - startTime);
    lastRequestMeta = { startTime, endTime, duration, path, status: response.status };

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(getFriendlyErrorMessage(response, bodyText));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    globalThis.clearTimeout(timeoutId);
    const endTime = performance.now();
    const duration = Math.round(endTime - startTime);
    const isAbort = error instanceof Error && error.name === "AbortError";
    lastRequestMeta = { startTime, endTime, duration, path };

    if (isAbort) {
      if (duration >= REQUEST_TIMEOUT_MS - 100) {
        throw new Error("后端响应超时。模型处理时间较长，请稍后重试或检查后端服务状态。");
      }
      throw new Error("请求被取消。");
    }
    throw error;
  }
}

export const api = {
  taskEventsWebSocketUrl(taskId: string): string {
    const url = new URL(`${apiBase}/api/tasks/${taskId}/events/ws`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("eventLimit", String(TASK_EVENT_WINDOW));
    return url.toString();
  },
  generateTaskTitle(goal: string, language?: string | null, useLocalFallback = false): Promise<TaskTitleResponse> {
    return request("/api/tasks/title", {
      method: "POST",
      body: JSON.stringify({ goal, ...(language ? { language } : {}), useLocalFallback })
    });
  },
  createTask(goal: string, title?: string, folderId?: string, attachmentIds: string[] = [], options: { runMode?: "normal" | "target"; targetLimits?: { maxModelTurns?: number; maxToolCalls?: number; maxWallTimeMs?: number } } = {}): Promise<TaskDetail> {
    return request("/api/tasks", { method: "POST", body: JSON.stringify({ goal, ...(title ? { title } : {}), ...(folderId ? { folderId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}), ...(options.runMode ? { runMode: options.runMode } : {}), ...(options.targetLimits ? { targetLimits: options.targetLimits } : {}) }) });
  },
  listTasks(): Promise<TaskDetail[]> {
    return request("/api/tasks");
  },
  listTaskFolders(): Promise<TaskFolderRecord[]> {
    return request("/api/task-folders");
  },
  createTaskFolder(input: TaskFolderCreateRequest): Promise<TaskFolderRecord> {
    return request("/api/task-folders", { method: "POST", body: JSON.stringify(input) });
  },
  patchTaskFolder(folderId: string, input: TaskFolderPatchRequest): Promise<TaskFolderRecord> {
    return request(`/api/task-folders/${folderId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteTaskFolder(folderId: string, input: TaskFolderDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }): Promise<TaskFolderDeleteResult> {
    return request(`/api/task-folders/${folderId}`, { method: "DELETE", body: JSON.stringify(input) });
  },
  clearTaskFolder(folderId: string, input: TaskFolderClearRequest): Promise<TaskFolderClearResult> {
    return request(`/api/task-folders/${folderId}/clear`, { method: "POST", body: JSON.stringify(input) });
  },
  getTask(taskId: string): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}?eventLimit=${TASK_EVENT_WINDOW}`);
  },
  listTaskTranscript(taskId: string): Promise<TaskTranscriptItem[]> {
    return request(`/api/tasks/${taskId}/transcript`);
  },
  patchTask(taskId: string, input: TaskPatchRequest): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteTask(taskId: string, input: TaskDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }): Promise<TaskDeleteResult> {
    return request(`/api/tasks/${taskId}`, { method: "DELETE", body: JSON.stringify(input) });
  },
  sendMessage(taskId: string, content: string, attachmentIds: string[] = []): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}/messages`, { method: "POST", body: JSON.stringify({ content, ...(attachmentIds.length ? { attachmentIds } : {}) }) });
  },
  uploadTaskAttachment(input: TaskAttachmentUploadRequest): Promise<TaskAttachment> {
    return request("/api/task-attachments", { method: "POST", body: JSON.stringify(input) });
  },
  deleteTaskAttachment(attachmentId: string): Promise<void> {
    return request(`/api/task-attachments/${attachmentId}`, { method: "DELETE" });
  },
  listTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
    return request(`/api/tasks/${taskId}/attachments`);
  },
  listConversationSummaries(taskId: string): Promise<ConversationSummary[]> {
    return request(`/api/tasks/${taskId}/summaries`);
  },
  listTaskCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    return request(`/api/tasks/${taskId}/checkpoints`);
  },
  rollbackTask(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackResult> {
    return request(`/api/tasks/${taskId}/rollback`, { method: "POST", body: JSON.stringify(input) });
  },
  previewTaskRollback(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackPreview> {
    return request(`/api/tasks/${taskId}/rollback/preview`, { method: "POST", body: JSON.stringify(input) });
  },
  listTaskTurns(taskId: string): Promise<TaskTurn[]> {
    return request(`/api/tasks/${taskId}/turns`);
  },
  revertTaskTurn(taskId: string, turnId: string): Promise<TaskTurnRevertResult> {
    return request(`/api/tasks/${taskId}/turns/${turnId}/revert`, { method: "POST" });
  },
  editTaskTurn(taskId: string, turnId: string, input: TaskTurnEditRequest): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}/turns/${turnId}/edit`, { method: "POST", body: JSON.stringify(input) });
  },
  control(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}/control`, { method: "POST", body: JSON.stringify({ action }) });
  },
  decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision }) });
  },
  listTaskMemories(): Promise<TaskMemory[]> {
    return request("/api/task-memories");
  },
  listPatterns(): Promise<PatternRecord[]> {
    return request("/api/patterns");
  },
  listSkills(): Promise<SkillRecord[]> {
    return request("/api/skills");
  },
  createSkill(input: SkillCreateRequest): Promise<SkillRecord> {
    return request("/api/skills", { method: "POST", body: JSON.stringify(input) });
  },
  getSkill(skillId: string): Promise<SkillRecord> {
    return request(`/api/skills/${skillId}`);
  },
  deleteSkill(skillId: string): Promise<void> {
    return request(`/api/skills/${skillId}`, { method: "DELETE" });
  },
  bulkDeleteSkills(input: SkillBulkDeleteRequest): Promise<{ deleted: number }> {
    return request("/api/skills/bulk-delete", { method: "POST", body: JSON.stringify(input) });
  },
  listSkillDuplicates(): Promise<SkillDuplicateGroup[]> {
    return request("/api/skills/duplicates");
  },
  mergeSkills(skillId: string, input: SkillMergeRequest): Promise<SkillRecord> {
    return request(`/api/skills/${skillId}/merge`, { method: "POST", body: JSON.stringify(input) });
  },
  cleanupSkillDuplicates(): Promise<{ merged: number; deleted: number; groups: SkillDuplicateGroup[] }> {
    return request("/api/skills/cleanup-duplicates", { method: "POST" });
  },
  listSkillConflicts(): Promise<SkillConflict[]> {
    return request("/api/skill-conflicts");
  },
  listSkillCurator(): Promise<SkillCuratorItem[]> {
    return request("/api/skill-curator");
  },
  exportSkill(skillId: string): Promise<{ markdown: string; manifest: Record<string, unknown> }> {
    return request(`/api/skills/${skillId}/export`);
  },
  patchSkill(skillId: string, patch: SkillStatusPatch | SkillUpdateRequest): Promise<SkillRecord> {
    return request(`/api/skills/${skillId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  correctSkill(skillId: string, input: SkillCorrectionRequest): Promise<SkillRecord> {
    return request(`/api/skills/${skillId}/corrections`, { method: "POST", body: JSON.stringify(input) });
  },
  listGlobalPermissions(): Promise<GlobalPermissionGrant[]> {
    return request("/api/permissions/global");
  },
  grantGlobalPermission(riskCategory: RiskCategory, reason?: string): Promise<GlobalPermissionGrant> {
    return request("/api/permissions/global", {
      method: "POST",
      body: JSON.stringify({ riskCategory, ...(reason ? { reason } : {}) })
    });
  },
  revokeGlobalPermission(riskCategory: RiskCategory): Promise<void> {
    return request(`/api/permissions/global/${riskCategory}`, { method: "DELETE" });
  },
  getPreferences(): Promise<UserPreferences> {
    return request("/api/preferences");
  },
  updatePreferences(patch: PreferencesPatch): Promise<UserPreferences> {
    return request("/api/preferences", { method: "PATCH", body: JSON.stringify(patch) });
  },
  getUserProfile(): Promise<MemoryDocument> {
    return request("/api/user-profile");
  },
  updateUserProfile(input: MemoryDocumentPatch): Promise<MemoryDocument> {
    return request("/api/user-profile", { method: "PATCH", body: JSON.stringify(input) });
  },
  getProjectMemory(folderId = "default"): Promise<MemoryDocument> {
    return request(`/api/project-memory?folderId=${encodeURIComponent(folderId)}`);
  },
  updateProjectMemory(folderId: string, input: MemoryDocumentPatch): Promise<MemoryDocument> {
    return request(`/api/project-memory?folderId=${encodeURIComponent(folderId)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  compactProjectMemory(folderId = "default"): Promise<MemoryDocumentCompactResult> {
    return request(`/api/project-memory/compact?folderId=${encodeURIComponent(folderId)}`, { method: "POST" });
  },
  listReflections(): Promise<ReflectionSession[]> {
    return request("/api/reflections");
  },
  runReflection(): Promise<ReflectionSession> {
    return request("/api/reflections", { method: "POST" });
  },
  deleteReflection(id: string): Promise<void> {
    return request(`/api/reflections/${id}`, { method: "DELETE" });
  },
  clearReflections(): Promise<void> {
    return request("/api/reflections", { method: "DELETE" });
  },
  listProjectMemories(): Promise<ProjectMemory[]> {
    return request("/api/project-memories");
  },
  createProjectMemory(input: ProjectMemoryCreateRequest): Promise<ProjectMemory> {
    return request("/api/project-memories", { method: "POST", body: JSON.stringify(input) });
  },
  patchProjectMemory(id: string, input: ProjectMemoryPatchRequest): Promise<ProjectMemory> {
    return request(`/api/project-memories/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteProjectMemory(id: string): Promise<void> {
    return request(`/api/project-memories/${id}`, { method: "DELETE" });
  },
  listMcpServers(): Promise<Array<McpServerConfig & { status: McpServerStatus }>> {
    return request("/api/mcp/servers");
  },
  createMcpServer(input: McpServerCreateRequest): Promise<McpServerConfig> {
    return request("/api/mcp/servers", { method: "POST", body: JSON.stringify(input) });
  },
  patchMcpServer(serverId: string, input: McpServerPatchRequest): Promise<McpServerConfig> {
    return request(`/api/mcp/servers/${serverId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteMcpServer(serverId: string): Promise<void> {
    return request(`/api/mcp/servers/${serverId}`, { method: "DELETE" });
  },
  connectMcpServer(serverId: string): Promise<McpServerStatus> {
    return request(`/api/mcp/servers/${serverId}/connect`, { method: "POST" });
  },
  disconnectMcpServer(serverId: string): Promise<McpServerStatus> {
    return request(`/api/mcp/servers/${serverId}/disconnect`, { method: "POST" });
  },
  listMcpTools(): Promise<McpToolSummary[]> {
    return request("/api/mcp/tools");
  },
  listModelProviders(): Promise<ModelProviderRecord[]> {
    return request("/api/model-providers");
  },
  createModelProvider(input: ModelProviderCreateRequest): Promise<ModelProviderRecord> {
    return request("/api/model-providers", { method: "POST", body: JSON.stringify(input) });
  },
  patchModelProvider(providerId: string, input: ModelProviderPatchRequest): Promise<ModelProviderRecord> {
    return request(`/api/model-providers/${providerId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteModelProvider(providerId: string): Promise<void> {
    return request(`/api/model-providers/${providerId}`, { method: "DELETE" });
  },
  listScheduledTasks(): Promise<ScheduledTask[]> {
    return request("/api/scheduled-tasks");
  },
  createScheduledTask(input: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
    return request("/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
  },
  patchScheduledTask(taskId: string, input: ScheduledTaskPatchRequest): Promise<ScheduledTask> {
    return request(`/api/scheduled-tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteScheduledTask(taskId: string): Promise<void> {
    return request(`/api/scheduled-tasks/${taskId}`, { method: "DELETE" });
  },
  listWebSearchProviders(): Promise<WebSearchProviderConfig[]> {
    return request("/api/web-search/providers");
  },
  createWebSearchProvider(input: WebSearchProviderCreateRequest): Promise<WebSearchProviderConfig> {
    return request("/api/web-search/providers", { method: "POST", body: JSON.stringify(input) });
  },
  patchWebSearchProvider(providerId: string, input: WebSearchProviderPatchRequest): Promise<WebSearchProviderConfig> {
    return request(`/api/web-search/providers/${providerId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteWebSearchProvider(providerId: string): Promise<void> {
    return request(`/api/web-search/providers/${providerId}`, { method: "DELETE" });
  },
  listKnowledgeItems(): Promise<KnowledgeItem[]> {
    return request("/api/knowledge");
  },
  createKnowledgeItem(input: KnowledgeCreateRequest): Promise<KnowledgeItem> {
    return request("/api/knowledge", { method: "POST", body: JSON.stringify(input) });
  },
  uploadKnowledgeFile(input: KnowledgeUploadRequest): Promise<KnowledgeItem> {
    return request("/api/knowledge/upload", { method: "POST", body: JSON.stringify(input) });
  },
  patchKnowledgeItem(id: string, input: KnowledgePatchRequest): Promise<KnowledgeItem> {
    return request(`/api/knowledge/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteKnowledgeItem(id: string): Promise<void> {
    return request(`/api/knowledge/${id}`, { method: "DELETE" });
  },
  reindexKnowledgeItem(id: string): Promise<KnowledgeReindexResult> {
    return request(`/api/knowledge/${id}/reindex`, { method: "POST" });
  },
  searchKnowledge(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult[]> {
    return request("/api/knowledge/search", { method: "POST", body: JSON.stringify(input) });
  },
  getKnowledgeModelStatus(): Promise<KnowledgeModelStatus> {
    return request("/api/knowledge/models");
  },
  downloadKnowledgeModel(input: KnowledgeModelDownloadRequest): Promise<KnowledgeModelDownloadResult> {
    return request("/api/knowledge/models/download", { method: "POST", body: JSON.stringify(input) });
  },
  listPromptCacheStats(taskId?: string): Promise<PromptCacheStats[]> {
    const suffix = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
    return request(`/api/prompt-cache-stats${suffix}`);
  },
  listIntegrations(): Promise<IntegrationProviderConfig[]> {
    return request("/api/integrations");
  },
  createIntegration(input: IntegrationProviderCreateRequest): Promise<IntegrationProviderConfig> {
    return request("/api/integrations", { method: "POST", body: JSON.stringify(input) });
  },
  patchIntegration(integrationId: string, input: IntegrationProviderPatchRequest): Promise<IntegrationProviderConfig> {
    return request(`/api/integrations/${integrationId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteIntegration(integrationId: string): Promise<void> {
    return request(`/api/integrations/${integrationId}`, { method: "DELETE" });
  },
  connectIntegration(integrationId: string): Promise<IntegrationProviderConfig> {
    return request(`/api/integrations/${integrationId}/connect`, { method: "POST" });
  },
  disconnectIntegration(integrationId: string): Promise<IntegrationProviderConfig> {
    return request(`/api/integrations/${integrationId}/disconnect`, { method: "POST" });
  },
  healthCheck(): Promise<{ ok: boolean }> {
    return request("/health");
  }
};
