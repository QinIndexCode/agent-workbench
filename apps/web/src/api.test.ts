import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const sessionToken = "session-token-test";

let api: typeof import("./api.js")["api"];

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value
  } as Response;
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  ({ api } = await import("./api.js"));
});

describe("api client", () => {
  it("sends task and approval requests", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken });
      return jsonResponse({ id: "task_1", status: "completed" });
    });

    await expect(api.createTask("hello", "Greeting")).resolves.toMatchObject({ id: "task_1" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/session/bootstrap");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ goal: "hello", title: "Greeting" }),
        headers: expect.any(Headers)
      })
    );
    expect(((fetchMock.mock.lastCall?.[1] as RequestInit).headers as Headers).get("x-agent-workbench-session")).toBe(sessionToken);

    await api.createTask("hello");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ goal: "hello" }) })
    );

    await api.generateTaskTitle("hello", "en-US");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/title",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ goal: "hello", language: "en-US", useLocalFallback: false }) })
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
    expect((revokeInit.headers as Headers).get("x-agent-workbench-session")).toBe(sessionToken);

    await api.runCuratorExtraction();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/curator/runs", expect.objectContaining({ method: "POST" }));

    await api.deleteCuratorRun("curator_run_1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/curator/runs/curator_run_1", expect.objectContaining({ method: "DELETE" }));
  });

  it("raises failed responses", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken });
      return {
        ok: false,
        status: 400,
        text: async () => "bad request"
      } as Response;
    });
    await expect(api.listTasks()).rejects.toThrow("请求参数有误，请检查输入后重试。");
  });

  it("adds the session token to websocket task URLs", async () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5173" } } as unknown as Window & typeof globalThis);
    fetchMock.mockImplementation(async () => jsonResponse({ sessionToken }));

    const url = await api.taskEventsWebSocketUrl("task_42");
    expect(url).toContain("/api/tasks/task_42/events/ws");
    expect(url).toContain("session=session-token-test");
    expect(url).toContain("eventLimit=240");
  });

  it("loads the full text for a lazily transported transcript stream", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken });
      return jsonResponse({
        streamId: "stream_lazy",
        type: "thinking_delta",
        text: "Full thinking body"
      });
    });

    await expect(api.getTaskStreamText("task_1", "stream_lazy", "thinking_delta")).resolves.toEqual({
      streamId: "stream_lazy",
      type: "thinking_delta",
      text: "Full thinking body"
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task_1/stream-text?streamId=stream_lazy&type=thinking_delta",
      expect.objectContaining({ headers: expect.any(Headers) })
    );
  });

  it("loads delegated child summaries for a task", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken });
      return jsonResponse([{ id: "task_child", title: "Child", status: "running" }]);
    });

    await expect(api.listTaskChildren("task_parent")).resolves.toEqual([{ id: "task_child", title: "Child", status: "running" }]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task_parent/children",
      expect.objectContaining({ headers: expect.any(Headers) })
    );
  });
});
