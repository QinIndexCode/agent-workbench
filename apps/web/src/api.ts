import type {
  ApprovalDecision,
  GlobalPermissionGrant,
  KnowledgeCreateRequest,
  KnowledgeItem,
  KnowledgePatchRequest,
  KnowledgeUploadRequest,
  McpServerConfig,
  McpServerCreateRequest,
  McpServerPatchRequest,
  McpServerStatus,
  McpToolSummary,
  ModelProviderCreateRequest,
  ModelProviderPatchRequest,
  ModelProviderRecord,
  PatternRecord,
  PreferencesPatch,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ReflectionSession,
  RiskCategory,
  SkillBulkDeleteRequest,
  SkillCorrectionRequest,
  SkillConflict,
  SkillCreateRequest,
  SkillDuplicateGroup,
  SkillMergeRequest,
  SkillRecord,
  SkillStatusPatch,
  SkillUpdateRequest,
  TaskDeleteRequest,
  TaskDeleteResult,
  TaskDetail,
  TaskFolderClearRequest,
  TaskFolderClearResult,
  TaskFolderDeleteRequest,
  TaskFolderDeleteResult,
  TaskFolderCreateRequest,
  TaskFolderPatchRequest,
  TaskFolderRecord,
  TaskPatchRequest,
  TaskTitleResponse,
  TaskMemory,
  UserPreferences
} from "@scc/shared";

const apiBase = import.meta.env["VITE_API_BASE"] ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  taskEventsWebSocketUrl(taskId: string): string {
    const url = new URL(`${apiBase}/api/tasks/${taskId}/events/ws`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  },
  generateTaskTitle(goal: string, language?: string | null, useLocalFallback = false): Promise<TaskTitleResponse> {
    return request("/api/tasks/title", {
      method: "POST",
      body: JSON.stringify({ goal, ...(language ? { language } : {}), useLocalFallback })
    });
  },
  createTask(goal: string, title: string, folderId?: string): Promise<TaskDetail> {
    return request("/api/tasks", { method: "POST", body: JSON.stringify({ goal, title, ...(folderId ? { folderId } : {}) }) });
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
    return request(`/api/tasks/${taskId}`);
  },
  patchTask(taskId: string, input: TaskPatchRequest): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteTask(taskId: string, input: TaskDeleteRequest = { deleteLearningData: false, deleteDerivedSkills: false }): Promise<TaskDeleteResult> {
    return request(`/api/tasks/${taskId}`, { method: "DELETE", body: JSON.stringify(input) });
  },
  sendMessage(taskId: string, content: string): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
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
  listReflections(): Promise<ReflectionSession[]> {
    return request("/api/reflections");
  },
  runReflection(): Promise<ReflectionSession> {
    return request("/api/reflections", { method: "POST" });
  },
  listProjectMemories(): Promise<ProjectMemory[]> {
    return request("/api/project-memories");
  },
  createProjectMemory(input: ProjectMemoryCreateRequest): Promise<ProjectMemory> {
    return request("/api/project-memories", { method: "POST", body: JSON.stringify(input) });
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
  }
};
