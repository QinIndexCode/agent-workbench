import type { ApprovalDecision, ExperienceRecord, SkillRecord, TaskDetail } from "@scc/shared";

const apiBase = import.meta.env["VITE_API_BASE"] ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
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
    return request(`/api/tasks/${taskId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision })
    });
  },
  listExperiences(): Promise<ExperienceRecord[]> {
    return request("/api/experiences");
  },
  listSkills(): Promise<SkillRecord[]> {
    return request("/api/skills");
  }
};
