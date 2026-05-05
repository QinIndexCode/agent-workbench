import type {
  ApprovalDecision,
  GlobalPermissionGrant,
  PatternRecord,
  PreferencesPatch,
  ProjectMemory,
  ProjectMemoryCreateRequest,
  ReflectionSession,
  RiskCategory,
  SkillCorrectionRequest,
  SkillRecord,
  SkillStatusPatch,
  TaskDetail,
  TaskMemory,
  UserPreferences
} from "@scc/shared";

const apiBase = import.meta.env["VITE_API_BASE"] ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  createTask(goal: string): Promise<TaskDetail> {
    return request("/api/tasks", { method: "POST", body: JSON.stringify({ goal }) });
  },
  listTasks(): Promise<TaskDetail[]> {
    return request("/api/tasks");
  },
  getTask(taskId: string): Promise<TaskDetail> {
    return request(`/api/tasks/${taskId}`);
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
  patchSkill(skillId: string, patch: SkillStatusPatch): Promise<SkillRecord> {
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
  }
};
