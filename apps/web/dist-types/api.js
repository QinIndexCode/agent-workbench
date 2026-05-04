const apiBase = import.meta.env["VITE_API_BASE"] ?? "";
async function request(path, init) {
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
    return (await response.json());
}
export const api = {
    createTask(goal) {
        return request("/api/tasks", { method: "POST", body: JSON.stringify({ goal }) });
    },
    listTasks() {
        return request("/api/tasks");
    },
    getTask(taskId) {
        return request(`/api/tasks/${taskId}`);
    },
    sendMessage(taskId, content) {
        return request(`/api/tasks/${taskId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
    },
    control(taskId, action) {
        return request(`/api/tasks/${taskId}/control`, { method: "POST", body: JSON.stringify({ action }) });
    },
    decideApproval(taskId, approvalId, decision) {
        return request(`/api/tasks/${taskId}/approvals/${approvalId}`, {
            method: "POST",
            body: JSON.stringify({ decision })
        });
    },
    listExperiences() {
        return request("/api/experiences");
    },
    listSkills() {
        return request("/api/skills");
    }
};
