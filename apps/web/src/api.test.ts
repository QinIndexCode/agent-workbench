import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("api client", () => {
  it("sends task and approval requests", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "task_1", status: "completed" })
    });

    await expect(api.createTask("hello")).resolves.toMatchObject({ id: "task_1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ goal: "hello" }) })
    );

    await api.decideApproval("task_1", "approval_1", "allow_once");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task_1/approvals/approval_1",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "allow_once" }) })
    );

    await api.deleteTask("task_1", { deleteLearningData: true, deleteDerivedSkills: false });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task_1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ deleteLearningData: true, deleteDerivedSkills: false })
      })
    );

    await api.grantGlobalPermission("host_observation", "ok");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/permissions/global",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ riskCategory: "host_observation", reason: "ok" }) })
    );

    await api.createMcpServer({
      label: "Mock MCP",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      enabled: true,
      toolRiskOverrides: {}
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/mcp/servers",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("Mock MCP") })
    );

    await api.connectMcpServer("mock");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/mcp/servers/mock/connect", expect.objectContaining({ method: "POST" }));

    await api.createModelProvider({
      vendor: "mimo",
      label: "Mimo",
      protocol: "openai_compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "secret",
      models: [{ id: "mimo-v2.5", label: "mimo-v2.5", contextWindow: 128000, supportsTools: true, supportsThinking: true }],
      defaultModelId: "mimo-v2.5",
      enabled: true,
      makeActive: true
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/model-providers",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("mimo-v2.5") })
    );

    await api.patchModelProvider("provider_1", { enabled: false });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/model-providers/provider_1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) })
    );

    await api.createKnowledgeItem({ projectId: "default", kind: "memory", title: "Note", content: "Body", tags: ["runtime"] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/knowledge",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("runtime") })
    );

    await api.uploadKnowledgeFile({ projectId: "default", title: "notes.md", fileName: "notes.md", mimeType: "text/markdown", size: 4, content: "Body", tags: [] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/knowledge/upload",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("notes.md") })
    );

    await api.revokeGlobalPermission("host_observation");
    const revokeInit = fetchMock.mock.lastCall?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenLastCalledWith("/api/permissions/global/host_observation", expect.objectContaining({ method: "DELETE" }));
    expect(revokeInit.headers).toBeInstanceOf(Headers);
    expect((revokeInit.headers as Headers).has("content-type")).toBe(false);
  });

  it("raises failed responses", async () => {
    fetchMock.mockResolvedValue({ ok: false, text: async () => "bad request" });
    await expect(api.listTasks()).rejects.toThrow("bad request");
  });
});
