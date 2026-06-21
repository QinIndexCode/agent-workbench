import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentWorkbench,
  ConfiguredToolModelClient,
  DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_TITLE,
  DEFAULT_OFFICE_VISUAL_QA_SKILL_TITLE,
  InMemoryWorkbenchStore,
  McpRegistry,
  defaultPreferences,
  normalizeSkillRecord,
  type ModelClient,
  type ModelTurn
} from "@agent-workbench/core";
import type { SkillRecord, TaskDetail, TaskEvent, ToolApproval, ToolCall, ToolResult } from "@agent-workbench/shared";
import { createApp } from "../src/server.js";
import { SqliteWorkbenchStore } from "../src/sqlite-store.js";

const SESSION_HEADER = "x-agent-workbench-session";
const LEGACY_SESSION_HEADER = "x-scc-session";

type TestApp = Awaited<ReturnType<typeof createApp>> & {
  injectRaw: Awaited<ReturnType<typeof createApp>>["inject"];
};

async function createTestApp(options: Parameters<typeof createApp>[0] = {}): Promise<TestApp> {
  const app = (await createApp({ logger: false, ...options })) as TestApp;
  const injectRaw = app.inject.bind(app);
  let sessionToken: string | null = null;

  async function getSessionToken(): Promise<string> {
    if (sessionToken) return sessionToken;
    const response = await injectRaw({ method: "GET", url: "/api/session/bootstrap" });
    sessionToken = String(response.json<{ sessionToken: string }>().sessionToken);
    return sessionToken;
  }

  app.injectRaw = injectRaw;
  app.inject = (async (optionsOrUrl: Parameters<TestApp["injectRaw"]>[0]) => {
    const request = typeof optionsOrUrl === "string" ? { method: "GET", url: optionsOrUrl } : { ...optionsOrUrl };
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const headers = new Headers(request.headers as HeadersInit | undefined);
    if (isPublicTestPath(pathname) || headers.has(SESSION_HEADER)) {
      return injectRaw(optionsOrUrl);
    }
    headers.set(SESSION_HEADER, await getSessionToken());
    return injectRaw({ ...request, headers: Object.fromEntries(headers.entries()) });
  }) as TestApp["inject"];
  return app;
}

function isPublicTestPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/api/session/bootstrap" ||
    pathname === "/api/integrations/discord/interactions" ||
    pathname === "/api/integrations/feishu/events" ||
    pathname === "/api/integrations/slack/events" ||
    pathname === "/api/integrations/telegram/updates" ||
    pathname === "/api/integrations/wecom/callback"
  );
}

function comparablePath(path: string): string {
  const resolved = resolve(path.trim());
  const real = realpathSync.native(resolved);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function expectSamePath(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(comparablePath(actual ?? "")).toBe(comparablePath(expected));
}

function isDefaultSkillTitle(title: string): boolean {
  return title === DEFAULT_OFFICE_VISUAL_QA_SKILL_TITLE || title === DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_TITLE;
}

class StubToolExecutor {
  async execute(call: ToolCall): Promise<ToolResult> {
    return {
      id: "tool_result_1",
      toolCallId: call.id,
      ok: true,
      createdAt: new Date().toISOString(),
      output: JSON.stringify([{ ProcessName: "node", Id: 1, CPU: 2, WorkingSet64: 1024 }])
    };
  }
}

class SlowFinalModelClient implements ModelClient {
  async next(): Promise<ModelTurn> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { kind: "final", message: "Background continuation completed." };
  }
}

class StaticFinalModelClient implements ModelClient {
  async next(): Promise<ModelTurn> {
    return { kind: "final", message: "Accepted." };
  }
}

class DelegationServerModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.kind === "subagent") {
      if (task.events.some((event) => event.type === "tool_result")) {
        return { kind: "final", message: "Delegated comparison finished with the renderer evidence." };
      }
      return {
        kind: "tool_calls",
        calls: [{ id: "tool_call_read_child", toolName: "read_file", args: { path: "index.html" } }]
      };
    }
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "spawn_subagent")) {
      return { kind: "final", message: "Parent task continued after delegation." };
    }
    return {
      kind: "tool_calls",
      calls: [{
        id: "tool_call_spawn_child",
        toolName: "spawn_subagent",
        args: {
          goal: "Read the project code and compare the current renderer path.",
          context: "Focus on the main renderer and summarize the bottleneck.",
          fileHints: ["index.html"],
          expectedOutput: "comparison"
        }
      }]
    };
  }
}

describe("server API", () => {
  it("bootstraps a local session token and rejects missing or cross-origin protected requests", async () => {
    const app = await createApp({ logger: false, workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() }) });
    const bootstrap = await app.inject({ method: "GET", url: "/api/session/bootstrap" });
    const sessionToken = String(bootstrap.json<{ sessionToken: string }>().sessionToken);

    expect(bootstrap.statusCode).toBe(200);
    expect(sessionToken.length).toBeGreaterThan(20);
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tasks",
          headers: { [SESSION_HEADER]: sessionToken, origin: "https://evil.example.com" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tasks",
          headers: { [SESSION_HEADER]: sessionToken, origin: "http://127.0.0.1:5173" }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tasks",
          headers: { [SESSION_HEADER]: sessionToken, origin: "http://127.0.0.1:5175" }
        })
      ).statusCode
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { [SESSION_HEADER]: sessionToken } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { [LEGACY_SESSION_HEADER]: sessionToken } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/session/bootstrap", headers: { origin: "http://localhost:9999" } })).statusCode).toBe(403);

    await app.close();
  });

  it("exposes a lightweight public health endpoint", async () => {
    const app = await createApp({ logger: false, workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() }) });
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json<{ ok: boolean; uptimeMs: number; version: string; timestamp: string }>();

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe("0.1.0");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);

    await app.close();
  });

  it("tests model provider configuration through the protected API without exposing secrets", async () => {
    const app = await createTestApp({ workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() }) });
    const create = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        vendor: "mimo",
        label: "Missing key provider",
        protocol: "openai_compatible",
        baseUrl: "https://mimo.example/v1",
        models: [{ id: "mimo-v2.5", label: "Mimo v2.5", contextWindow: 128000, supportsTools: true, supportsThinking: false }],
        defaultModelId: "mimo-v2.5",
        enabled: true,
        makeActive: true
      }
    });
    const providerId = create.json<{ id: string }>().id;
    const response = await app.inject({ method: "POST", url: `/api/model-providers/${providerId}/test` });
    const body = response.json<{ ok: boolean; failureClass: string; error: string }>();

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.failureClass).toBe("provider_configuration");
    expect(body.error).toContain("missing a decryptable API key");
    expect(JSON.stringify(body)).not.toContain("apiKey");
    await app.close();
  });

  it("hides subagent tasks from the default task list and exposes direct children explicitly", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    await store.saveTask({
      kind: "primary",
      id: "task_parent",
      title: "Parent task",
      folderId: "default",
      workRoot: process.cwd(),
      status: "running",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: [{ id: "event_parent", taskId: "task_parent", type: "user_message", createdAt: now, summary: "Parent request", payload: {} }]
    });
    await store.saveTask({
      kind: "subagent",
      id: "task_child",
      title: "Child research",
      parentTaskId: "task_parent",
      delegation: {
        sourceTaskId: "task_parent",
        sourceToolCallId: "tool_spawn_child",
        goal: "Read the code and compare implementations",
        contextSummary: "Focus on the shared renderer path.",
        networkEnabled: true,
        expectedOutput: "comparison"
      },
      folderId: "default",
      workRoot: process.cwd(),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_child_user", taskId: "task_child", type: "user_message", createdAt: now, summary: "delegated handoff", payload: {} },
        { id: "event_child_done", taskId: "task_child", type: "assistant_message", createdAt: now, summary: "Compared both implementations and found one shared bottleneck.", payload: {} }
      ]
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const defaultList = (await app.inject("/api/tasks")).json() as TaskDetail[];
    expect(defaultList.map((task) => task.id)).toEqual(["task_parent"]);

    const fullList = (await app.inject("/api/tasks?includeChildren=true")).json() as TaskDetail[];
    expect(fullList.map((task) => task.id)).toEqual(["task_parent", "task_child"]);

    const children = (await app.inject("/api/tasks/task_parent/children")).json() as Array<Record<string, unknown>>;
    expect(children).toHaveLength(1);
    expect(children[0]?.["id"]).toBe("task_child");
    expect(children[0]?.["parentTaskId"]).toBe("task_parent");
    expect(children[0]?.["sourceToolCallId"]).toBe("tool_spawn_child");
    expect(children[0]?.["lastAssistantSummary"]).toBe("Compared both implementations and found one shared bottleneck.");

    await app.close();
  });

  it("redacts sensitive approval arguments before sending task details to the UI", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    const approval: ToolApproval = {
      id: "approval_secret",
      taskId: "task_secret_approval",
      riskCategory: "shell",
      reason: "Run a diagnostic command.",
      status: "pending",
      createdAt: now,
      toolCall: {
        id: "tool_secret",
        toolName: "run_command",
        args: {
          command: "echo api_key=sk-live-secret-1234567890 && echo done",
          authorization: "Bearer secret-token-1234567890"
        }
      },
      metadata: {
        command: "echo api_key=sk-live-secret-1234567890",
        secretToken: "telegram-secret-token"
      }
    };
    await store.saveTask({
      id: "task_secret_approval",
      title: "Secret approval",
      folderId: "default",
      workRoot: process.cwd(),
      status: "waiting_approval",
      createdAt: now,
      updatedAt: now,
      approvals: [approval],
      pendingGuidance: [],
      events: [
        {
          id: "event_secret_approval",
          taskId: "task_secret_approval",
          type: "approval_pending",
          createdAt: now,
          summary: "shell: run_command",
          payload: { approvalId: approval.id, riskCategory: "shell" }
        }
      ]
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const detailText = (await app.inject("/api/tasks/task_secret_approval")).body;
    const detail = JSON.parse(detailText) as TaskDetail;

    expect(detail.approvals).toHaveLength(1);
    expect(detailText).not.toContain("sk-live-secret-1234567890");
    expect(detailText).not.toContain("secret-token-1234567890");
    expect(detailText).not.toContain("telegram-secret-token");
    expect(JSON.stringify(detail.approvals[0]?.toolCall.args)).toContain("[redacted");
    expect(JSON.stringify(detail.approvals[0]?.metadata)).toContain("[redacted-secret]");

    await app.close();
  });

  it("runs delegated child tasks through the HTTP task API while keeping parent and child flows separated", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-workbench-server-subagent-"));
    writeFileSync(join(root, "index.html"), "<html><body>delegated evidence</body></html>", "utf8");
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new DelegationServerModel() });
    const folder = await workbench.createTaskFolder({ name: "delegation-http-root", rootPath: root });
    await workbench.grantGlobalPermission("network", "allow delegated child spawn");
    const app = await createTestApp({ workbench });

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          goal: "Review the current implementation and delegate a focused comparison.",
          folderId: folder.id
        }
      });
      expect(createResponse.statusCode).toBe(201);

      const started = createResponse.json() as TaskDetail;
      let parent = started;
      let children: Array<Record<string, unknown>> = [];
      let childDetail: TaskDetail | null = null;

      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        parent = (await app.inject(`/api/tasks/${started.id}?eventLimit=200`)).json() as TaskDetail;
        children = (await app.inject(`/api/tasks/${started.id}/children`)).json() as Array<Record<string, unknown>>;
        const childId = typeof children[0]?.["id"] === "string" ? String(children[0]?.["id"]) : "";
        if (childId) {
          childDetail = (await app.inject(`/api/tasks/${childId}?eventLimit=200`)).json() as TaskDetail;
        }
        if (
          children[0]?.["status"] === "completed" &&
          parent.events.some((event) => event.type === "subagent_completed") &&
          childDetail?.status === "completed"
        ) {
          break;
        }
      }

      const defaultList = (await app.inject("/api/tasks")).json() as TaskDetail[];
      const fullList = (await app.inject("/api/tasks?includeChildren=true")).json() as TaskDetail[];

      expect(children).toHaveLength(1);
      expect(children[0]?.["goal"]).toBe("Read the project code and compare the current renderer path.");
      expect(children[0]?.["status"]).toBe("completed");
      expect(children[0]?.["lastAssistantSummary"]).toBe("Delegated comparison finished with the renderer evidence.");
      expect(defaultList.map((task) => task.id)).toEqual([started.id]);
      expect(fullList.map((task) => task.id)).toContain(started.id);
      expect(fullList.some((task) => task.kind === "subagent")).toBe(true);
      expect(parent.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")).toBe(false);
      expect(parent.events.some((event) => event.type === "subagent_completed")).toBe(true);

      expect(childDetail?.kind).toBe("subagent");
      expect(childDetail?.parentTaskId).toBe(started.id);
      expect(childDetail?.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")).toBe(true);
      expect(childDetail?.events.some((event) => event.type === "assistant_message" && event.summary === "Delegated comparison finished with the renderer evidence.")).toBe(true);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps task list and task snapshots lightweight for large streamed histories", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    const events: TaskEvent[] = Array.from({ length: 8 }, (_, index) => ({
      id: `event_${index}`,
      taskId: "task_large",
      type: "tool_result",
      createdAt: now,
      summary: `Tool result ${index}`,
      payload: {
        toolName: "run_command",
        ok: true,
        output: "x".repeat(index === 7 ? 15000 : 32)
      }
    }));
    await store.saveTask({
      id: "task_large",
      title: "Large stream",
      folderId: "default",
      workRoot: process.cwd(),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const listTask = (await app.inject("/api/tasks")).json()[0];
    expect(listTask.events).toHaveLength(0);

    const detail = (await app.inject("/api/tasks/task_large?eventLimit=2")).json();
    expect(detail.events.map((event: TaskEvent) => event.id)).toEqual(["event_6", "event_7"]);
    expect(String(detail.events[1].payload.output)).toContain("UI preview truncated");

    await app.close();
  });

  it("keeps audit events windowed while transcript remains complete and user-facing", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    const largeRequestedContent = `${"generated line\n".repeat(700)}UNRENDERED_REQUEST_TAIL`;
    const events: TaskEvent[] = [
      {
        id: "event_task_created",
        taskId: "task_windowed",
        type: "task_created",
        createdAt: now,
        summary: "Task created",
        payload: {}
      },
      {
        id: "event_user_goal",
        taskId: "task_windowed",
        type: "user_message",
        createdAt: now,
        summary: "Build the actual requested artifact",
        payload: {}
      },
      {
        id: "event_early_agent",
        taskId: "task_windowed",
        type: "assistant_message",
        createdAt: now,
        summary: "I will build the artifact and keep the page verifiable.",
        payload: {}
      },
      {
        id: "event_agent_tool_boilerplate",
        taskId: "task_windowed",
        type: "assistant_message",
        createdAt: now,
        summary: "Tool evidence returned.\n\nTop entries:\n- node.exe",
        payload: { message: "Tool evidence returned.\n\nTop entries:\n- node.exe" }
      },
      {
        id: "event_thinking_before_markup_final",
        taskId: "task_windowed",
        type: "thinking_delta",
        createdAt: now,
        summary: "Need to inspect the code structure first.",
        payload: { streamId: "stream_markup_final", delta: "Need to inspect the code structure first." }
      },
      {
        id: "event_delta_before_markup_final",
        taskId: "task_windowed",
        type: "assistant_delta",
        createdAt: now,
        summary: "I will inspect the code and then improve the styles.",
        payload: { streamId: "stream_markup_final", delta: "I will inspect the code and then improve the styles." }
      },
      {
        id: "event_agent_markup_final",
        taskId: "task_windowed",
        type: "assistant_message",
        createdAt: now,
        summary:
          'I will inspect the code and then improve the styles.\n\n<function_calls><invoke name="read_file"><parameter name="path">index.html</parameter></invoke></function_calls>',
        payload: { streamId: "stream_markup_final" }
      },
      {
        id: "event_agent_payload_only",
        taskId: "task_windowed",
        type: "assistant_message",
        createdAt: now,
        summary: "Tool evidence returned.",
        payload: { message: "Tool evidence returned.\n\nPayload-only assistant body." }
      },
      {
        id: "event_agent_empty_boilerplate",
        taskId: "task_windowed",
        type: "assistant_message",
        createdAt: now,
        summary: "Tool evidence returned.",
        payload: {}
      },
      {
        id: "event_attachment",
        taskId: "task_windowed",
        type: "attachment_added",
        createdAt: now,
        summary: "logo.png",
        payload: { fileName: "logo.png", kind: "image", size: 1024 }
      },
      {
        id: "event_tool_requested_write",
        taskId: "task_windowed",
        type: "tool_requested",
        createdAt: now,
        summary: "write_file",
        payload: {
          toolCallId: "tool_call_write",
          toolName: "write_file",
          args: { path: "src/generated.md", expectedHash: "__new__", content: largeRequestedContent },
          riskCategory: "workspace_write"
        }
      },
      {
        id: "event_context_summary",
        taskId: "task_windowed",
        type: "conversation_summary_created",
        createdAt: now,
        summary: "Earlier context was compacted",
        payload: {
          summary: [
            "Earlier conversation was compacted to keep the task within the model context window.",
            "- **Tool Call**: edit_file({ very large payload })",
            "[UI preview truncated: 999 characters omitted. Full evidence is retained by Agent Workbench.]"
          ].join("\n"),
          retainedFacts: ["Original goal: Build the actual requested artifact"]
        }
      },
      {
        id: "event_model_empty_response",
        taskId: "task_windowed",
        type: "model_empty_response",
        createdAt: now,
        summary: "Model returned no displayable content; retrying once.",
        payload: { status: "retrying", reason: "empty completion" }
      },
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `event_agent_${index}`,
        taskId: "task_windowed",
        type: "assistant_message" as const,
        createdAt: now,
        summary: `assistant item ${index}`,
        payload: {}
      }))
    ];
    await store.saveTask({
      id: "task_windowed",
      title: "Windowed history",
      folderId: "default",
      workRoot: process.cwd(),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const detail = (await app.inject("/api/tasks/task_windowed?eventLimit=50")).json();
    const eventWindow = (await app.inject("/api/tasks/task_windowed/events?eventLimit=50")).json();
    const transcript = (await app.inject("/api/tasks/task_windowed/transcript?eventLimit=50")).json();

    expect(detail.events.map((event: TaskEvent) => event.id)).toContain("event_user_goal");
    expect(detail.events.at(-1)?.id).toBe("event_agent_999");
    expect(eventWindow.map((event: TaskEvent) => event.id)).toContain("event_user_goal");
    expect(eventWindow.at(-1)?.id).toBe("event_agent_999");
    expect(eventWindow.length).toBeLessThan(transcript.length);
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_user_goal");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_early_agent");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_agent_tool_boilerplate");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_agent_markup_final");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_agent_payload_only");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_thinking_before_markup_final");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_model_empty_response");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_tool_requested_write");
    expect(transcript.map((event: TaskEvent) => event.id)).not.toContain("event_agent_empty_boilerplate");
    expect(transcript.map((event: TaskEvent) => event.id)).not.toContain("event_delta_before_markup_final");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_attachment");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_agent_0");
    expect(transcript.at(-1)?.id).toBe("event_agent_999");
    expect(transcript.map((event: TaskEvent) => event.id)).not.toContain("event_context_summary");
    expect(JSON.stringify(transcript)).not.toContain("UI preview truncated");
    expect(JSON.stringify(transcript)).not.toContain("Original goal");
    expect(JSON.stringify(transcript)).not.toContain("Tool evidence returned");
    expect(JSON.stringify(transcript)).not.toContain("function_calls");
    expect(JSON.stringify(transcript)).toContain("content preview truncated");
    expect(JSON.stringify(transcript)).not.toContain("UNRENDERED_REQUEST_TAIL");
    expect(JSON.stringify(transcript)).toContain("Need to inspect the code structure first.");
    expect(JSON.stringify(transcript)).toContain("I will inspect the code and then improve the styles.");
    expect(JSON.stringify(transcript)).toContain("Payload-only assistant body.");
    expect(JSON.stringify(transcript)).toContain("Top entries");
    await app.close();
  });

  it("coalesces repeated transcript stream deltas before sending them to the client", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    await store.saveTask({
      id: "task_transcript_streams",
      title: "Transcript streams",
      folderId: "default",
      workRoot: process.cwd(),
      status: "running",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_transcript_streams",
          type: "user_message",
          createdAt: now,
          summary: "Review the current project and explain the next steps.",
          payload: {}
        },
        {
          id: "event_thinking_1",
          taskId: "task_transcript_streams",
          type: "thinking_delta",
          createdAt: "2026-01-01T00:00:00.000Z",
          summary: "Inspecting the first area.",
          payload: { streamId: "stream_thinking", delta: "Inspecting the first area." }
        },
        {
          id: "event_thinking_2",
          taskId: "task_transcript_streams",
          type: "thinking_delta",
          createdAt: "2026-01-01T00:00:00.010Z",
          summary: "Inspecting the second area.",
          payload: { streamId: "stream_thinking", delta: "Inspecting the second area." }
        },
        {
          id: "event_delta_1",
          taskId: "task_transcript_streams",
          type: "assistant_delta",
          createdAt: "2026-01-01T00:00:00.020Z",
          summary: "I will inspect the code now.",
          payload: { streamId: "stream_assistant", delta: "I will inspect the code now." }
        },
        {
          id: "event_delta_2",
          taskId: "task_transcript_streams",
          type: "assistant_delta",
          createdAt: "2026-01-01T00:00:00.030Z",
          summary: "Then I will improve the styles.",
          payload: { streamId: "stream_assistant", delta: "Then I will improve the styles." }
        }
      ]
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const transcript = (await app.inject("/api/tasks/task_transcript_streams/transcript")).json();
    const thinking = transcript.filter((event: TaskEvent) => event.type === "thinking_delta");
    const assistant = transcript.filter((event: TaskEvent) => event.type === "assistant_delta");

    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.id).toBe("event_thinking_1");
    expect(thinking[0]?.payload["delta"]).toBe("Inspecting the first area. Inspecting the second area.");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.id).toBe("event_delta_1");
    expect(assistant[0]?.payload["delta"]).toBe("I will inspect the code now. Then I will improve the styles.");

    await app.close();
  });

  it("ships large thinking transcript bodies as lazy previews and exposes the full stream on demand", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    const largeThinking = Array.from({ length: 220 }, (_, index) => `Step ${index + 1}: inspect another part of the workspace.`).join("\n");
    await store.saveTask({
      id: "task_large_thinking_preview",
      title: "Large thinking preview",
      folderId: "default",
      workRoot: process.cwd(),
      status: "running",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_large_thinking",
          taskId: "task_large_thinking_preview",
          type: "thinking_delta",
          createdAt: now,
          summary: largeThinking,
          payload: { streamId: "stream_large_thinking", delta: largeThinking }
        }
      ]
    });
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });

    const transcript = (await app.inject("/api/tasks/task_large_thinking_preview/transcript")).json();
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.type).toBe("thinking_delta");
    expect(transcript[0]?.payload["lazyBody"]).toBe(true);
    expect(Number(transcript[0]?.payload["fullContentChars"] ?? 0)).toBe(largeThinking.length);
    expect(String(transcript[0]?.payload["delta"]).length).toBeLessThan(largeThinking.length);

    const fullStream = (
      await app.inject("/api/tasks/task_large_thinking_preview/stream-text?streamId=stream_large_thinking&type=thinking_delta")
    ).json();
    expect(fullStream).toMatchObject({
      streamId: "stream_large_thinking",
      type: "thinking_delta",
      text: largeThinking
    });

    await app.close();
  });

  it("creates a task and exposes an approval", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new ConfiguredToolModelClient("Get-Process")
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "check running processes", title: "Process check" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("running");
    const pending = await waitForTask(app, body.id, (task) => task.status === "waiting_approval");
    expect(pending.approvals[0].riskCategory).toBe("host_observation");
    await app.close();
  });

  it("rejects unknown request fields through strict schemas", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ConfiguredToolModelClient("Get-Process") })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "hello", title: "Hello", unexpected: true }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lets the backend create a task title when the client omits one", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ConfiguredToolModelClient("Get-Process") })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "请检查新任务后端自动命名" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toContain("检查");
    await app.close();
  });

  it("returns immediately for message continuations while the model resumes in the background", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = new Date().toISOString();
    await store.saveTask({
      id: "task_background",
      title: "Background continuation",
      folderId: "default",
      workRoot: process.cwd(),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: []
    });
    const app = await createTestApp({
      workbench: new AgentWorkbench({
        store,
        model: new SlowFinalModelClient()
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task_background/messages",
      payload: { content: "continue this" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("running");
    const completed = await waitForTask(app, "task_background", (task) => task.status === "completed");
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary === "Background continuation completed.")).toBe(true);
    await app.close();
  });

  it("generates local fallback titles and manages task folders", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ConfiguredToolModelClient("Get-Process") })
    });

    const titleResponse = await app.inject({
      method: "POST",
      url: "/api/tasks/title",
      payload: { goal: "请帮我深入检查当前项目结构并给出下一步优化建议", language: "zh-CN", useLocalFallback: true }
    });
    expect(titleResponse.statusCode).toBe(200);
    expect(titleResponse.json()).toMatchObject({ source: "local_fallback" });
    expect(titleResponse.json().title.length).toBeLessThanOrEqual(22);

    expect((await app.inject("/api/task-folders")).json().map((folder: { id: string }) => folder.id)).toContain("default");
    const localRoot = mkdtempSync(join(tmpdir(), "scc-server-folder-"));
    const folderResponse = await app.inject({
      method: "POST",
      url: "/api/task-folders",
      payload: { name: "System checks", rootPath: localRoot }
    });
    expect(folderResponse.statusCode).toBe(201);
    const folder = folderResponse.json();
    expect(folder.name).toBe("System checks");
    expectSamePath(folder.rootPath, localRoot);
    expect(folder.exists).toBe(true);

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { goal: "check running processes", title: "Process check", folderId: folder.id }
      })
    ).json();
    expect(created.folderId).toBe(folder.id);
    expectSamePath(created.workRoot, localRoot);

    const renamed = (
      await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { title: "Process check renamed", folderId: "default" }
      })
    ).json();
    expect(renamed.title).toBe("Process check renamed");
    expect(renamed.folderId).toBe("default");
    expectSamePath(renamed.workRoot, localRoot);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/${created.id}`,
          payload: { unexpected: true }
        })
      ).statusCode
    ).toBe(400);

    const patched = (
      await app.inject({
        method: "PATCH",
        url: `/api/task-folders/${folder.id}`,
        payload: { name: "Host checks", rootPath: localRoot }
      })
    ).json();
    expect(patched.name).toBe("Host checks");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/task-folders",
      payload: { name: "Missing path", rootPath: join(localRoot, "missing") }
    });
    expect(invalid.statusCode).toBe(400);

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { goal: "delete with folder", title: "Folder delete check", folderId: folder.id }
      })
    ).json();
    const deleted = (
      await app.inject({
        method: "DELETE",
        url: `/api/task-folders/${folder.id}`,
        payload: { deleteLearningData: false, deleteDerivedSkills: false }
      })
    ).json();
    expect(deleted.deletedFolder).toBe(true);
    expect(deleted.deletedTasks).toBe(1);
    expect((await app.inject(`/api/tasks/${created.id}`)).statusCode).toBe(200);
    expect((await app.inject(`/api/tasks/${second.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/task-folders/default" })).statusCode).toBe(400);
    rmSync(localRoot, { recursive: true, force: true });
    await app.close();
  });

  it("serves task, approval, guidance, and learning endpoints", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools: new StubToolExecutor(),
        model: new ConfiguredToolModelClient("Get-Process")
      })
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "check running processes", title: "Process check" }
    });
    const initial = createResponse.json();
    const created = await waitForTask(app, initial.id, (task) => task.approvals.length > 0);

    expect((await app.inject("/api/tasks")).json()).toHaveLength(1);
    expect((await app.inject(`/api/tasks/${created.id}`)).json().id).toBe(created.id);
    expect((await app.inject(`/api/tasks/${created.id}/events`)).json().length).toBeGreaterThan(0);

    const guidanceResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/messages`,
      payload: { content: "include memory" }
    });
    expect(guidanceResponse.json().pendingGuidance[0].summary).toBe("include memory");

    const approval = created.approvals[0];
    const approvalResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/approvals/${approval.id}`,
      payload: { decision: "allow_for_task" }
    });
    expect(approvalResponse.json().status).toBe("running");
    await waitForTask(app, created.id, (task) => task.status === "completed");

    const experiences = (await app.inject("/api/experiences")).json();
    const skills = (await app.inject("/api/skills")).json();
    expect(experiences.length).toBeGreaterThan(0);
    expect(skills.filter((item: SkillRecord) => !isDefaultSkillTitle(item.title))).toHaveLength(0);

    const manualSkill = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        title: "Host process review",
        body: "# Host process review\nUse host observation evidence and summarize CPU and memory usage.",
        status: "candidate",
        applicability: {
          keywords: ["process", "运行软件"],
          requiredTools: ["run_command"],
          requiredContext: ["host_observation"]
        }
      }
    });
    expect(manualSkill.statusCode).toBe(201);
    const skill = manualSkill.json();
    expect((await app.inject(`/api/skills/${skill.id}`)).json().id).toBe(skill.id);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}`,
      payload: { title: "Host process review updated", status: "active", applicability: { keywords: ["process", "software"] } }
    });
    expect(patchResponse.json().status).toBe("active");
    expect(patchResponse.json().title).toBe("Host process review updated");
    expect((await app.inject("/api/skills/duplicates")).statusCode).toBe(200);
    expect((await app.inject("/api/skill-curator")).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/skills/bulk-delete", payload: { skillIds: [skill.id] } })).json().deleted).toBe(1);

    const promoteResponse = await app.inject({
      method: "POST",
      url: `/api/experiences/${experiences[0].id}/promote`
    });
    expect(promoteResponse.statusCode).toBe(400);
    expect(promoteResponse.json().error).toContain("not eligible");

    const taskMemories = (await app.inject("/api/task-memories")).json();
    expect(taskMemories.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "DELETE", url: `/api/task-memories/${taskMemories[0].id}` })).statusCode).toBe(204);
    expect((await app.inject("/api/task-memories")).json().some((memory: { id: string }) => memory.id === taskMemories[0].id)).toBe(false);
    expect((await app.inject("/api/patterns")).statusCode).toBe(200);
    expect((await app.inject("/api/skill-conflicts")).statusCode).toBe(200);
    expect((await app.inject("/api/preferences")).json().language).toBe("zh-CN");

    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        vendor: "mimo",
        label: "Mimo",
        protocol: "openai_compatible",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        apiKey: "test-key-local-1234",
        models: [{ id: "mimo-v2.5", label: "mimo-v2.5", contextWindow: 128000, supportsTools: true, supportsThinking: true }],
        defaultModelId: "mimo-v2.5",
        enabled: true,
        makeActive: true
      }
    });
    expect(providerResponse.statusCode).toBe(201);
    const provider = providerResponse.json();
    expect(provider.apiKeyRef.last4).toBe("1234");
    expect(JSON.stringify(provider)).not.toContain("test-key-local");
    expect((await app.inject("/api/model-providers")).json()[0].defaultModelId).toBe("mimo-v2.5");

    const providerPatch = await app.inject({
      method: "PATCH",
      url: `/api/model-providers/${provider.id}`,
      payload: { label: "Mimo updated", enabled: false }
    });
    expect(providerPatch.statusCode).toBe(200);
    expect(providerPatch.json().enabled).toBe(false);
    expect(providerPatch.json().label).toBe("Mimo updated");
    expect((await app.inject("/api/preferences")).json().activeModelProviderId).toBe("");

    const invalidProviderPatch = await app.inject({
      method: "PATCH",
      url: `/api/model-providers/${provider.id}`,
      payload: { defaultModelId: "missing-model" }
    });
    expect(invalidProviderPatch.statusCode).toBe(400);
    expect(invalidProviderPatch.json().error).toContain("defaultModelId");

    const grantResponse = await app.inject({
      method: "POST",
      url: "/api/permissions/global",
      payload: { riskCategory: "host_observation", reason: "test" }
    });
    expect(grantResponse.statusCode).toBe(201);
    expect((await app.inject("/api/permissions/global")).json()[0].riskCategory).toBe("host_observation");

    const curatorRunResponse = await app.inject({ method: "POST", url: "/api/curator/runs" });
    expect(curatorRunResponse.statusCode).toBe(201);
    const curatorRuns = (await app.inject("/api/curator/runs")).json();
    expect(Array.isArray(curatorRuns)).toBe(true);
    expect((await app.inject("/api/reflections")).json()).toEqual(curatorRuns);
    expect((await app.inject({ method: "DELETE", url: "/api/curator/runs" })).statusCode).toBe(204);

    const scheduledTasks = (await app.inject("/api/scheduled-tasks")).json();
    expect(scheduledTasks.some((task: { id: string; type: string }) => task.id === "schedule_agent_reflection" && task.type === "reflection")).toBe(true);
    const deleteCuratorMaintenance = await app.inject({ method: "DELETE", url: "/api/scheduled-tasks/schedule_agent_reflection" });
    expect(deleteCuratorMaintenance.statusCode).toBe(400);

    const memoryResponse = await app.inject({
      method: "POST",
      url: "/api/project-memories",
      payload: { title: "Convention", content: "Use TypeScript.", category: "convention", tags: [] }
    });
    expect(memoryResponse.statusCode).toBe(201);
    expect((await app.inject("/api/project-memories")).json()[0].title).toBe("Convention");

    const knowledgeResponse = await app.inject({
      method: "POST",
      url: "/api/knowledge",
      payload: { projectId: "default", kind: "memory", title: "Runtime note", content: "Use approvals.", tags: ["runtime"] }
    });
    expect(knowledgeResponse.statusCode).toBe(201);
    const knowledge = knowledgeResponse.json();
    expect((await app.inject("/api/knowledge")).json()[0].title).toBe("Runtime note");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/knowledge/${knowledge.id}`,
          payload: { tags: ["runtime", "permissions"] }
        })
      ).json().tags
    ).toContain("permissions");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/knowledge/upload",
          payload: { projectId: "default", title: "notes.md", fileName: "notes.md", mimeType: "text/markdown", size: 8, content: "# Notes", tags: [] }
        })
      ).statusCode
    ).toBe(201);
    const knowledgeSearchResponse = await app.inject({
      method: "POST",
      url: "/api/knowledge/search",
      payload: { query: "approvals runtime", projectId: "default", limit: 2 }
    });
    expect(knowledgeSearchResponse.statusCode).toBe(200);
    expect(knowledgeSearchResponse.json()[0]?.item.id).toBe(knowledge.id);
    expect(knowledgeSearchResponse.json()[0]?.matchedFields).toContain("content");
    await app.close();
  });

  it("serves task attachment upload and cleanup endpoints without leaking plaintext storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-attachments-api-"));
    const previousWorkspaceRoot = process.env["SCC_WORKSPACE_ROOT"];
    process.env["SCC_WORKSPACE_ROOT"] = root;
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StaticFinalModelClient() })
    });
    const content = "# Incident note\napi_key=sk-test-server-attachment-secret123456";

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/task-attachments",
        payload: {
          fileName: "incident.md",
          mimeType: "text/markdown",
          size: Buffer.byteLength(content),
          dataBase64: Buffer.from(content).toString("base64")
        }
      });
      const attachment = upload.json();
      const stored = readFileSync(attachment.storagePath, "utf8");

      expect(upload.statusCode).toBe(201);
      expect(attachment.fileName).toBe("incident.md");
      expect(attachment.kind).toBe("markdown");
      expect(attachment.textPreview).toContain("[redacted-secret]");
      expect(attachment.textPreview).not.toContain("sk-test-server-attachment-secret");
      expect(existsSync(attachment.storagePath)).toBe(true);
      expect(stored).toContain("__agentWorkbenchEncryptedFile");
      expect(stored).not.toContain("Incident note");

      const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      const imageBytes = Buffer.from(imageBase64, "base64");
      const imageUpload = await app.inject({
        method: "POST",
        url: "/api/task-attachments",
        payload: {
          fileName: "agent-screenshot.png",
          mimeType: "image/png",
          size: imageBytes.byteLength,
          dataBase64: imageBase64
        }
      });
      const imageAttachment = imageUpload.json();
      const createdTask = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          goal: "Inspect uploaded screenshot",
          attachmentIds: [imageAttachment.id]
        }
      });
      const task = createdTask.json() as TaskDetail;
      const imageContent = await app.inject({
        method: "GET",
        url: `/api/tasks/${task.id}/attachments/${imageAttachment.id}/content`
      });
      const crossTaskContent = await app.inject({
        method: "GET",
        url: `/api/tasks/task_other/attachments/${imageAttachment.id}/content`
      });

      expect(imageUpload.statusCode).toBe(201);
      expect(imageAttachment.kind).toBe("image");
      expect(createdTask.statusCode).toBe(201);
      expect(imageContent.statusCode).toBe(200);
      expect(imageContent.headers["content-type"]).toContain("image/png");
      expect(Buffer.compare(imageContent.rawPayload, imageBytes)).toBe(0);
      expect(crossTaskContent.statusCode).toBe(404);

      const badSize = await app.inject({
        method: "POST",
        url: "/api/task-attachments",
        payload: {
          fileName: "bad.txt",
          mimeType: "text/plain",
          size: 999,
          dataBase64: Buffer.from("bad").toString("base64")
        }
      });
      expect(badSize.statusCode).toBe(400);
      expect(badSize.json().error).toContain("size");

      const deleteResponse = await app.inject({ method: "DELETE", url: `/api/task-attachments/${attachment.id}` });
      expect(deleteResponse.statusCode).toBe(204);
      expect(existsSync(attachment.storagePath)).toBe(false);
    } finally {
      await app.close();
      if (previousWorkspaceRoot === undefined) delete process.env["SCC_WORKSPACE_ROOT"];
      else process.env["SCC_WORKSPACE_ROOT"] = previousWorkspaceRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves duplicate skill cleanup through the API using canonical merge rules", async () => {
    const store = new InMemoryWorkbenchStore();
    const app = await createTestApp({ workbench: new AgentWorkbench({ store }) });
    const base = normalizeSkillRecord({
      id: "skill_duplicate_canonical",
      title: "Reusable review checklist",
      body: "# Reusable review checklist\nVerify behavior, evidence, and regression coverage before closing.",
      status: "candidate",
      sourceMemoryIds: ["memory_canonical"],
      applicability: {
        keywords: ["review", "checklist"],
        requiredTools: ["read_file"],
        requiredContext: ["repo"]
      }
    }) as SkillRecord;
    const duplicate = normalizeSkillRecord({
      ...base,
      id: "skill_duplicate_source",
      createdAt: new Date(Date.parse(base.createdAt) + 1_000).toISOString(),
      updatedAt: new Date(Date.parse(base.updatedAt) + 1_000).toISOString(),
      lastUsedAt: new Date(Date.parse(base.lastUsedAt) + 1_000).toISOString(),
      sourceMemoryIds: ["memory_duplicate"]
    }) as SkillRecord;

    await store.saveSkill(base);
    await store.saveSkill(duplicate);

    const before = await app.inject("/api/skills/duplicates");
    const cleanup = await app.inject({ method: "POST", url: "/api/skills/cleanup-duplicates" });
    const after = await app.inject("/api/skills/duplicates");
    const skills = (await app.inject("/api/skills")).json() as SkillRecord[];

    expect(before.json()).toHaveLength(1);
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json()).toMatchObject({ merged: 1, deleted: 1 });
    expect(after.json()).toHaveLength(0);
    const mergedSkill = skills.find((item) => item.id === "skill_duplicate_canonical");
    expect(mergedSkill).toBeTruthy();
    expect(skills.filter((item) => !isDefaultSkillTitle(item.title))).toHaveLength(1);
    expect(mergedSkill?.sourceMemoryIds).toEqual(expect.arrayContaining(["memory_canonical", "memory_duplicate"]));
    await app.close();
  });

  it("exposes built-in skills on startup", async () => {
    const app = await createTestApp({ workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() }) });
    try {
      const skills = (await app.inject("/api/skills")).json() as SkillRecord[];
      const officeSkill = skills.find((item) => item.title === DEFAULT_OFFICE_VISUAL_QA_SKILL_TITLE);
      const computerControlSkill = skills.find((item) => item.title === DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_TITLE);
      expect(officeSkill?.status).toBe("active");
      expect(officeSkill?.body).toContain("Visual QA gate");
      expect(officeSkill?.applicability.keywords).toEqual(expect.arrayContaining(["docx", "pptx"]));
      expect(officeSkill?.applicability.requiredTools).toContain("attach_task_file");
      expect(computerControlSkill?.status).toBe("active");
      expect(computerControlSkill?.body).toContain("Do not fake GUI capability");
      expect(computerControlSkill?.applicability.keywords).toEqual(expect.arrayContaining(["browser", "keyboard", "mouse"]));
      expect(computerControlSkill?.applicability.requiredTools).toContain("attach_task_file");
    } finally {
      await app.close();
    }
  });

  it("downloads knowledge model assets through the API and auto-updates preferences", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-model-api-"));
    const previousWorkspaceRoot = process.env["SCC_WORKSPACE_ROOT"];
    const previousFetch = globalThis.fetch;
    process.env["SCC_WORKSPACE_ROOT"] = root;
    globalThis.fetch = async () =>
      new Response("2 2\ncar 1 0\nautomobile 1 0\n", {
        status: 200,
        headers: { "content-length": "30" }
      });
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
    });
    try {
      const initial = (await app.inject("/api/knowledge/models")).json();
      expect(initial.assets.find((asset: { kind: string }) => asset.kind === "fasttext_vectors")?.exists).toBe(false);

      const download = await app.inject({
        method: "POST",
        url: "/api/knowledge/models/download",
        payload: { kind: "fasttext_vectors", url: "https://example.test/mini.vec" }
      });
      const body = download.json();
      const preferences = (await app.inject("/api/preferences")).json();

      expect(download.statusCode).toBe(201);
      expect(body.asset.exists).toBe(true);
      expect(body.asset.path).toContain("mini.vec");
      expect(preferences.knowledgeFastTextVectorPath).toBe(body.asset.path);
    } finally {
      await app.close();
      globalThis.fetch = previousFetch;
      if (previousWorkspaceRoot === undefined) delete process.env["SCC_WORKSPACE_ROOT"];
      else process.env["SCC_WORKSPACE_ROOT"] = previousWorkspaceRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes tasks with optional learning cleanup", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools: new StubToolExecutor(),
        model: new ConfiguredToolModelClient("Get-Process")
      })
    });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { goal: "check running processes", title: "Process check" }
      })
    ).json();
    const pending = await waitForTask(app, created.id, (task) => task.approvals.length > 0);
    const approval = pending.approvals[0];
    await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/approvals/${approval.id}`,
      payload: { decision: "allow_for_task" }
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${created.id}`,
      payload: { deleteLearningData: true, deleteDerivedSkills: false }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deletedTask: true, deletedExperiences: 1, deletedTaskMemories: 1 });
    expect((await app.inject(`/api/tasks/${created.id}`)).statusCode).toBe(404);
    expect((await app.inject("/api/experiences")).json()).toHaveLength(0);
    expect((await app.inject("/api/task-memories")).json()).toHaveLength(0);
    await app.close();
  });

  it("serves MCP management endpoints", async () => {
    const store = new InMemoryWorkbenchStore();
    const mcpRegistry = new McpRegistry(store);
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store }),
      mcpRegistry
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "mock",
        label: "Mock MCP",
        transport: "stdio",
        command: process.execPath,
        args: ["--version"],
        env: { API_KEY: "sk-mcp-secret-1234567890" },
        enabled: false,
        toolRiskOverrides: {}
      }
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.body).not.toContain("sk-mcp-secret");
    const servers = (await app.inject("/api/mcp/servers")).json();
    expect(servers[0].id).toBe("mock");
    expect(JSON.stringify(servers)).not.toContain("sk-mcp-secret");
    expect((await store.getMcpServer("mock"))?.env["API_KEY"]).toBe("sk-mcp-secret-1234567890");
    const invalidMcp = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "bad_http",
        label: "Bad HTTP MCP",
        transport: "streamable_http",
        url: "file:///tmp/mcp",
        args: [],
        env: {},
        enabled: true,
        toolRiskOverrides: {}
      }
    });
    expect(invalidMcp.statusCode).toBe(400);
    expect(invalidMcp.json().error).toContain("http or https");
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: "/api/mcp/servers/mock",
      payload: { transport: "streamable_http" }
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json().error).toContain("require url");
    expect((await app.inject("/api/mcp/tools")).statusCode).toBe(200);
    await app.close();
  });

  it("serves document and structured project memory endpoints", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "scc-memory-api-"));
    const previousMemoryDir = process.env.SCC_MEMORY_DIR;
    process.env.SCC_MEMORY_DIR = memoryRoot;
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
    });

    try {
      const userProfile = await app.inject("/api/user-profile");
      expect(userProfile.statusCode).toBe(200);
      expect(userProfile.json().fileName).toBe("USER.md");

      const savedProfile = await app.inject({
        method: "PATCH",
        url: "/api/user-profile",
        payload: { content: "# USER.md\n- Keep answers concrete." }
      });
      expect(savedProfile.statusCode).toBe(200);
      expect(savedProfile.json().content).toContain("Keep answers concrete");

      const projectMemory = await app.inject("/api/project-memory?folderId=default");
      expect(projectMemory.statusCode).toBe(200);
      expect(projectMemory.json()).toMatchObject({ fileName: "MEMORY.md", folderId: "default" });

      const savedProjectMemory = await app.inject({
        method: "PATCH",
        url: "/api/project-memory?folderId=default",
        payload: { content: "# MEMORY.md\n- Keep route tests current.\n- Keep route tests current.\n- Preserve trace evidence." }
      });
      expect(savedProjectMemory.statusCode).toBe(200);
      expect(savedProjectMemory.json().content).toContain("Preserve trace evidence");

      const compacted = await app.inject({ method: "POST", url: "/api/project-memory/compact?folderId=default" });
      expect(compacted.statusCode).toBe(200);
      expect(compacted.json().removedLines).toBeGreaterThanOrEqual(1);

      const created = await app.inject({
        method: "POST",
        url: "/api/project-memories",
        payload: {
          projectId: "default",
          title: "Architecture fact",
          content: "Memory documents are Library data, not current user input.",
          category: "architecture",
          tags: ["memory", "ui"]
        }
      });
      expect(created.statusCode).toBe(201);
      const createdMemory = created.json();
      expect(createdMemory).toMatchObject({ projectId: "default", title: "Architecture fact", category: "architecture" });

      const listed = (await app.inject("/api/project-memories")).json();
      expect(listed.some((memory: { id: string; title: string }) => memory.id === createdMemory.id && memory.title === "Architecture fact")).toBe(true);
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/project-memories/${createdMemory.id}`,
        payload: { title: "Updated architecture fact", tags: ["memory", "edited"] }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ id: createdMemory.id, title: "Updated architecture fact", tags: ["memory", "edited"] });
      expect((await app.inject({ method: "DELETE", url: `/api/project-memories/${createdMemory.id}` })).statusCode).toBe(204);
    } finally {
      await app.close();
      if (previousMemoryDir === undefined) {
        delete process.env.SCC_MEMORY_DIR;
      } else {
        process.env.SCC_MEMORY_DIR = previousMemoryDir;
      }
      rmSync(memoryRoot, { recursive: true, force: true });
    }
  });

  it("serves scheduled, web search, and integration management endpoints", async () => {
    const store = new InMemoryWorkbenchStore();
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store })
    });

    const scheduledResponse = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        title: "Weekly cleanup",
        prompt: "Review stale tasks.",
        scheduleKind: "calendar",
        frequency: "weekly",
        timeOfDay: "09:30"
      }
    });
    expect(scheduledResponse.statusCode).toBe(201);
    const scheduled = scheduledResponse.json();
    expect((await app.inject({ method: "PATCH", url: `/api/scheduled-tasks/${scheduled.id}`, payload: { status: "paused" } })).json().status).toBe("paused");
    const invalidIntervalPatch = await app.inject({
      method: "PATCH",
      url: `/api/scheduled-tasks/${scheduled.id}`,
      payload: { scheduleKind: "interval", intervalHours: 0, intervalMinutes: 0 }
    });
    expect(invalidIntervalPatch.statusCode).toBe(400);
    expect(invalidIntervalPatch.json().error).toMatch(/invalid request|greater than 0/i);
    expect((await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${scheduled.id}` })).statusCode).toBe(204);

    const webSearchResponse = await app.inject({
      method: "POST",
      url: "/api/web-search/providers",
      payload: { label: "Brave", kind: "brave", apiKey: "search-secret-1234", enabled: true }
    });
    expect(webSearchResponse.statusCode).toBe(201);
    const webSearch = webSearchResponse.json();
    expect(webSearch.apiKeyRef.last4).toBe("1234");
    expect(JSON.stringify(webSearch)).not.toContain("search-secret");
    const webSearchPatch = await app.inject({
      method: "PATCH",
      url: `/api/web-search/providers/${webSearch.id}`,
      payload: { label: "Brave paused", clearApiKey: true, enabled: false }
    });
    expect(webSearchPatch.json().enabled).toBe(false);
    expect(webSearchPatch.json().apiKeyRef).toBeUndefined();
    const invalidCustomSearch = await app.inject({
      method: "POST",
      url: "/api/web-search/providers",
      payload: { label: "Broken custom", kind: "custom", enabled: true }
    });
    expect(invalidCustomSearch.statusCode).toBe(400);
    expect(invalidCustomSearch.json().error).toMatch(/requires an endpoint/i);
    const invalidSearchPatch = await app.inject({
      method: "PATCH",
      url: `/api/web-search/providers/${webSearch.id}`,
      payload: { kind: "custom", endpoint: "https://example.test/search" }
    });
    expect(invalidSearchPatch.statusCode).toBe(400);
    expect(invalidSearchPatch.json().error).toMatch(/\{query\}/i);
    expect((await app.inject({ method: "DELETE", url: `/api/web-search/providers/${webSearch.id}` })).statusCode).toBe(204);

    const invalidIntegration = await app.inject({
      method: "POST",
      url: "/api/integrations",
      payload: {
        kind: "discord",
        label: "Discord Bad Callback",
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        callbackUrl: "file:///tmp/callback",
        defaultFolderId: "default",
        defaultPermissionPreset: "ask",
        enabled: false
      }
    });
    expect(invalidIntegration.statusCode).toBe(400);
    expect(invalidIntegration.json().error).toMatch(/http or https/i);

    const integrationResponse = await app.inject({
      method: "POST",
      url: "/api/integrations",
      payload: {
        kind: "discord",
        label: "Discord Ops",
        botToken: "discord-secret-9876",
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        callbackUrl: "https://discord.example.test/interactions",
        defaultFolderId: "default",
        defaultPermissionPreset: "ask",
        enabled: false
      }
    });
    expect(integrationResponse.statusCode).toBe(201);
    const integration = integrationResponse.json();
    expect(integration.botTokenRef.last4).toBe("9876");
    expect(JSON.stringify(integration)).not.toContain("discord-secret");
    expect((await app.inject({ method: "POST", url: `/api/integrations/${integration.id}/connect` })).json().status).toBe("connected");
    const integrationPatch = await app.inject({
      method: "PATCH",
      url: `/api/integrations/${integration.id}`,
      payload: { label: "Discord Support", clearBotToken: true }
    });
    expect(integrationPatch.json().label).toBe("Discord Support");
    expect(integrationPatch.json().botTokenRef).toBeUndefined();
    const integrationKindPatch = await app.inject({
      method: "PATCH",
      url: `/api/integrations/${integration.id}`,
      payload: {
        kind: "slack",
        label: "Slack Support",
        signingSecret: "slack-signing-secret",
        callbackUrl: "https://slack.example.test/events",
        enabled: true
      }
    });
    expect(integrationKindPatch.statusCode).toBe(200);
    expect(integrationKindPatch.json().kind).toBe("slack");
    expect(integrationKindPatch.json().signingSecretRef.last4).toBe("cret");
    expect(integrationKindPatch.json().publicKey).toBeUndefined();
    expect(integrationKindPatch.json().botTokenRef).toBeUndefined();
    expect(await store.getIntegrationSecret(integration.id, "botToken")).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/integrations/${integration.id}/disconnect` })).json().status).toBe("disabled");
    expect((await app.inject({ method: "DELETE", url: `/api/integrations/${integration.id}` })).statusCode).toBe(204);

    await app.close();
  });

  it("verifies Discord webhook signatures and handles ping plus supported interactions", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyHex = Buffer.from(publicKeyDer).subarray(-32).toString("hex");
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new StaticFinalModelClient()
    });
    const integration = await workbench.createIntegrationProvider({
      kind: "discord",
      label: "Discord Ops",
      publicKey: publicKeyHex,
      callbackUrl: "https://discord.example.test/interactions",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });
    const app = await createTestApp({ workbench });

    const pingPayload = { id: "ping_1", integrationId: integration.id, type: 1, channel_id: "channel_1" };
    const pingBody = JSON.stringify(pingPayload);
    const pingTimestamp = String(Date.now());
    const pingSignature = sign(null, Buffer.from(`${pingTimestamp}${pingBody}`, "utf8"), privateKey).toString("hex");

    const ping = await app.inject({
      method: "POST",
      url: "/api/integrations/discord/interactions",
      payload: pingPayload,
      headers: {
        "x-signature-ed25519": pingSignature,
        "x-signature-timestamp": pingTimestamp
      }
    });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ type: 1 });

    const bad = await app.inject({
      method: "POST",
      url: "/api/integrations/discord/interactions",
      payload: pingPayload,
      headers: {
        "x-signature-ed25519": "00",
        "x-signature-timestamp": pingTimestamp
      }
    });
    expect(bad.statusCode).toBe(401);

    const interactionPayload = {
      id: "interaction_1",
      integrationId: integration.id,
      type: 2,
      channel_id: "channel_1",
      data: {
        name: "task",
        options: [{ name: "prompt", value: "Summarize this Discord task" }]
      },
      user: { id: "user_1" }
    };
    const interactionBody = JSON.stringify(interactionPayload);
    const interactionTimestamp = String(Date.now() + 1);
    const interactionSignature = sign(null, Buffer.from(`${interactionTimestamp}${interactionBody}`, "utf8"), privateKey).toString("hex");
    const interaction = await app.inject({
      method: "POST",
      url: "/api/integrations/discord/interactions",
      payload: interactionPayload,
      headers: {
        "x-signature-ed25519": interactionSignature,
        "x-signature-timestamp": interactionTimestamp
      }
    });
    expect(interaction.statusCode).toBe(200);
    expect(interaction.json<{ type: number; taskId?: string }>().type).toBe(4);
    expect(interaction.json<{ type: number; taskId?: string }>().taskId).toBeTruthy();

    await app.close();
  });

  it("verifies Feishu events and returns challenge or task acknowledgements", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new StaticFinalModelClient()
    });
    const integration = await workbench.createIntegrationProvider({
      kind: "feishu",
      label: "Feishu Ops",
      verificationToken: "feishu-verify-token",
      callbackUrl: "https://feishu.example.test/events",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });
    const app = await createTestApp({ workbench });

    const challenge = await app.inject({
      method: "POST",
      url: "/api/integrations/feishu/events",
      payload: {
        integrationId: integration.id,
        challenge: "challenge-token",
        type: "url_verification",
        token: "feishu-verify-token"
      }
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: "challenge-token" });

    const bad = await app.inject({
      method: "POST",
      url: "/api/integrations/feishu/events",
      payload: {
        integrationId: integration.id,
        type: "event_callback",
        token: "wrong-token",
        event: {
          message: { message_id: "msg_1", chat_id: "chat_1", content: JSON.stringify({ text: "hello" }) }
        }
      }
    });
    expect(bad.statusCode).toBe(401);

    const message = await app.inject({
      method: "POST",
      url: "/api/integrations/feishu/events",
      payload: {
        integrationId: integration.id,
        type: "event_callback",
        token: "feishu-verify-token",
        event: {
          message: {
            message_id: "msg_2",
            chat_id: "chat_2",
            message_type: "text",
            content: JSON.stringify({ text: "Create a Feishu task" })
          },
          sender: {
            sender_id: { open_id: "open_user_1" }
          }
        }
      }
    });
    expect(message.statusCode).toBe(200);
    expect(message.json<{ ok: boolean; taskId?: string }>().ok).toBe(true);
    expect(message.json<{ ok: boolean; taskId?: string }>().taskId).toBeTruthy();

    await app.close();
  });

  it("verifies Slack events and Telegram updates before creating tasks", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new StaticFinalModelClient()
    });
    const slack = await workbench.createIntegrationProvider({
      kind: "slack",
      label: "Slack Ops",
      signingSecret: "slack-secret-123",
      callbackUrl: "https://slack.example.test/events",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });
    const telegram = await workbench.createIntegrationProvider({
      kind: "telegram",
      label: "Telegram Ops",
      botToken: "telegram-bot-123",
      secretToken: "telegram-secret-456",
      callbackUrl: "https://telegram.example.test/updates",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });
    const app = await createTestApp({ workbench });

    const challengePayload = {
      integrationId: slack.id,
      type: "url_verification",
      challenge: "challenge-slack",
      event: { channel: "C1" }
    };
    const challengeBody = JSON.stringify(challengePayload);
    const challengeTimestamp = String(Date.now());
    const challengeSignature = slackSignature("slack-secret-123", challengeTimestamp, challengeBody);

    const challenge = await app.injectRaw({
      method: "POST",
      url: "/api/integrations/slack/events",
      payload: challengePayload,
      headers: {
        "x-slack-signature": challengeSignature,
        "x-slack-request-timestamp": challengeTimestamp
      }
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: "challenge-slack" });

    const badSlack = await app.injectRaw({
      method: "POST",
      url: "/api/integrations/slack/events",
      payload: challengePayload,
      headers: {
        "x-slack-signature": "v0=bad",
        "x-slack-request-timestamp": challengeTimestamp
      }
    });
    expect(badSlack.statusCode).toBe(401);

    const slackMessagePayload = {
      integrationId: slack.id,
      type: "event_callback",
      event_id: "slack_event_1",
      event: {
        type: "message",
        user: "user_1",
        text: "Create a Slack task",
        channel: "channel_1",
        ts: "1711111111.100"
      }
    };
    const slackMessageBody = JSON.stringify(slackMessagePayload);
    const slackMessageTimestamp = String(Date.now() + 1);
    const slackMessageSignature = slackSignature("slack-secret-123", slackMessageTimestamp, slackMessageBody);
    const slackMessage = await app.injectRaw({
      method: "POST",
      url: "/api/integrations/slack/events",
      payload: slackMessagePayload,
      headers: {
        "x-slack-signature": slackMessageSignature,
        "x-slack-request-timestamp": slackMessageTimestamp
      }
    });
    expect(slackMessage.statusCode).toBe(200);
    expect(slackMessage.json<{ ok: boolean; taskId?: string }>().ok).toBe(true);
    expect(slackMessage.json<{ ok: boolean; taskId?: string }>().taskId).toBeTruthy();

    const telegramMessage = await app.injectRaw({
      method: "POST",
      url: "/api/integrations/telegram/updates",
      payload: {
        integrationId: telegram.id,
        update_id: 12,
        message: {
          message_id: 34,
          text: "Create a Telegram task",
          chat: { id: "chat_1", type: "private" },
          from: { id: "sender_1", first_name: "Test" }
        }
      },
      headers: {
        "x-telegram-bot-api-secret-token": "telegram-secret-456"
      }
    });
    expect(telegramMessage.statusCode).toBe(200);
    expect(telegramMessage.json<{ ok: boolean; taskId?: string }>().ok).toBe(true);
    expect(telegramMessage.json<{ ok: boolean; taskId?: string }>().taskId).toBeTruthy();

    const badTelegram = await app.injectRaw({
      method: "POST",
      url: "/api/integrations/telegram/updates",
      payload: {
        integrationId: telegram.id,
        update_id: 13,
        message: { message_id: 35, text: "ignored", chat: { id: "chat_2" } }
      },
      headers: {
        "x-telegram-bot-api-secret-token": "wrong-secret"
      }
    });
    expect(badTelegram.statusCode).toBe(401);

    await app.close();
  });

  it("verifies the WeCom callback handshake before accepting inbound callbacks", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new StaticFinalModelClient()
    });
    const integration = await workbench.createIntegrationProvider({
      kind: "wecom",
      label: "WeCom Ops",
      wecomToken: "wecom-token-123",
      wecomEncodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      callbackUrl: "https://wecom.example.test/callback",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });
    const app = await createTestApp({ workbench });

    const timestamp = String(Date.now());
    const nonce = "nonce-1";
    const echostr = encryptWecomEcho("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "<xml>ok</xml>", "corp-test");
    const signature = wecomSignature("wecom-token-123", timestamp, nonce, echostr);

    const handshake = await app.injectRaw({
      method: "GET",
      url: `/api/integrations/wecom/callback?integrationId=${integration.id}&msg_signature=${encodeURIComponent(signature)}&timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}&echostr=${encodeURIComponent(echostr)}`
    });
    expect(handshake.statusCode).toBe(200);
    expect(handshake.body).toBe("<xml>ok</xml>");

    const badHandshake = await app.injectRaw({
      method: "GET",
      url: `/api/integrations/wecom/callback?integrationId=${integration.id}&msg_signature=bad&timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}&echostr=${encodeURIComponent(echostr)}`
    });
    expect(badHandshake.statusCode).toBe(401);

    await app.close();
  });

  it("bootstraps a Mimo model provider from an explicit API key document without exposing the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-server-bootstrap-"));
    const previous = {
      dbPath: process.env["SCC_DB_PATH"],
      apiKeyFile: process.env["SCC_API_KEY_FILE"],
      provider: process.env["SCC_API_PROVIDER"],
      openAiProvider: process.env["OPENAI_PROVIDER"]
    };

    try {
      const apiKeyFile = join(dir, "dont_touch_(APIKEY).md");
      writeFileSync(
        apiKeyFile,
        [
          "xiaomi mimo",
          "apiKey: test-mimo-secret-6789",
          "baseUrl: https://token-plan-cn.xiaomimimo.com/v1",
          "canonicalLiveModel: mimo-v2.5"
        ].join("\n")
      );
      process.env["SCC_DB_PATH"] = join(dir, "workbench.sqlite");
      process.env["SCC_API_KEY_FILE"] = apiKeyFile;
      delete process.env["SCC_API_PROVIDER"];
      delete process.env["OPENAI_PROVIDER"];

      const app = await createTestApp();
      const providers = (await app.inject("/api/model-providers")).json();
      const preferences = (await app.inject("/api/preferences")).json();

      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        vendor: "mimo",
        label: "Mimo",
        protocol: "openai_compatible",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        defaultModelId: "mimo-v2.5"
      });
      expect(providers[0].apiKeyRef.last4).toBe("6789");
      expect(JSON.stringify(providers)).not.toContain("test-mimo-secret");
      expect(preferences.activeModelProviderId).toBe(providers[0].id);
      expect(preferences.defaultModel).toBe("mimo-v2.5");
      await app.close();
    } finally {
      restoreEnv("SCC_DB_PATH", previous.dbPath);
      restoreEnv("SCC_API_KEY_FILE", previous.apiKeyFile);
      restoreEnv("SCC_API_PROVIDER", previous.provider);
      restoreEnv("OPENAI_PROVIDER", previous.openAiProvider);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves Agent Workbench tools through a real MCP streamable HTTP client", async () => {
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ConfiguredToolModelClient("Get-Process") })
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const client = new Client({ name: "scc-server-test", version: "1.0.0" }, { capabilities: {} });
    const bootstrap = await fetch(`${address}/api/session/bootstrap`).then(async (response) => response.json() as Promise<{ sessionToken: string }>);
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/api/mcp/server`), {
      requestInit: { headers: { [SESSION_HEADER]: bootstrap.sessionToken } }
    });

    try {
      await client.connect(transport as never);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("agent_workbench.list_tasks");
      expect(tools.tools.map((tool) => tool.name)).toContain("scc.list_tasks");

      const listResult = await client.callTool({ name: "scc.list_tasks", arguments: {} });
      expect(JSON.stringify(listResult.content)).toContain("[]");

      const createResult = await client.callTool({ name: "scc.create_task", arguments: { goal: "check running processes" } });
      expect(JSON.stringify(createResult.content)).toContain("waiting_approval");
    } finally {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      await app.close();
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return `v0=${digest}`;
}

function wecomSignature(token: string, timestamp: string, nonce: string, encryptedValue: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encryptedValue].sort().join("")).digest("hex");
}

function encryptWecomEcho(encodingAesKey: string, plainText: string, corpId: string): string {
  const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
  const random = Buffer.from("1234567890abcdef", "utf8");
  const message = Buffer.from(plainText, "utf8");
  const corp = Buffer.from(corpId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);
  const raw = Buffer.concat([random, length, message, corp]);
  const padded = pkcs7Pad(raw, 32);
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function pkcs7Pad(buffer: Buffer, blockSize: number): Buffer {
  const remainder = buffer.length % blockSize;
  const padding = remainder === 0 ? blockSize : blockSize - remainder;
  return Buffer.concat([buffer, Buffer.alloc(padding, padding)]);
}

async function waitForTask(app: TestApp, taskId: string, predicate: (task: TaskDetail) => boolean): Promise<TaskDetail> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const task = (await app.inject(`/api/tasks/${taskId}`)).json() as TaskDetail;
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

function readSqliteFileFamily(file: string): Buffer {
  return Buffer.concat(
    [file, `${file}-wal`, `${file}-shm`]
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => readFileSync(candidate))
  );
}

function expectSqliteFileFamilyNotToContain(file: string, needles: string[]): void {
  const bytes = readSqliteFileFamily(file);
  for (const needle of needles) {
    expect(bytes.includes(Buffer.from(needle, "utf8")), `SQLite files should not contain ${needle}`).toBe(false);
  }
}

describe("SqliteWorkbenchStore", () => {
  it("persists task records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-"));
    try {
      const file = join(dir, "state.sqlite");
      const firstStore = new SqliteWorkbenchStore(file);
      const workbench = new AgentWorkbench({ store: firstStore });
      const created = await workbench.createTask("check running processes");
      firstStore.close();

      const reloaded = new SqliteWorkbenchStore(file);
      const task = await reloaded.getTask(created.id);
      expect(task?.id).toBe(created.id);
      expect((await reloaded.listTasks()).length).toBe(1);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encrypts side capability secret-bearing records at rest even when full storage encryption is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-side-secrets-"));
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const workbench = new AgentWorkbench({ store });
      const mcp = new McpRegistry(store);

      await workbench.createModelProvider({
        vendor: "mimo",
        label: "Mimo",
        protocol: "openai_compatible",
        baseUrl: "https://mimo.example.test/v1",
        apiKey: "model-secret-123456",
        models: [{ id: "mimo-v1", label: "Mimo v1" }],
        defaultModelId: "mimo-v1",
        enabled: true
      });
      const search = await workbench.createWebSearchProvider({
        label: "Custom search",
        kind: "custom",
        endpoint: "https://search.example.test?q={query}&api_key={apiKey}",
        apiKey: "search-secret-123456",
        enabled: true
      });
      const integration = await workbench.createIntegrationProvider({
        kind: "slack",
        label: "Slack",
        signingSecret: "slack-secret-123456",
        callbackUrl: "https://slack.example.test/events",
        defaultFolderId: "default",
        defaultPermissionPreset: "ask",
        enabled: true
      });
      await workbench.createScheduledTask({
        title: "Secret scheduled task",
        prompt: "Run a scheduled check with scheduled-prompt-secret-123456",
        folderId: "default",
        scheduleKind: "interval",
        intervalHours: 0,
        intervalMinutes: 30
      });
      await store.saveIntegrationMessage({
        id: "integration_message_secret",
        integrationId: integration.id,
        externalMessageId: "external-secret-message",
        externalChannelId: "channel-secret",
        senderId: "sender-secret",
        text: "Please debug with api_key=integration-message-secret-123456 and Bearer integration-bearer-secret",
        createdAt: new Date().toISOString()
      });
      await mcp.createServer({
        id: "secret_mcp",
        label: "Secret MCP",
        transport: "streamable_http",
        url: "https://mcp.example.test/stream?api_key=mcp-secret-123456",
        env: { API_KEY: "sk-mcp-secret-123456" },
        enabled: true
      });
      store.close();

      const raw = new Database(file, { readonly: true });
      const rows = raw.prepare("SELECT namespace, value FROM records").all() as Array<{ namespace: string; value: string }>;
      raw.close();
      const joined = rows.map((row) => row.value).join("\n");
      const mcpRow = rows.find((row) => row.namespace === "mcp_servers")?.value ?? "";
      const webSearchProviderRow = rows.find((row) => row.namespace === "web_search_providers")?.value ?? "";
      const integrationProviderRow = rows.find((row) => row.namespace === "integration_providers")?.value ?? "";
      const scheduledTaskRow = rows.find((row) => row.namespace === "scheduled_tasks")?.value ?? "";

      expect(joined).not.toContain("model-secret-123456");
      expect(joined).not.toContain("search-secret-123456");
      expect(joined).not.toContain("slack-secret-123456");
      expect(joined).not.toContain("scheduled-prompt-secret-123456");
      expect(joined).not.toContain("integration-message-secret-123456");
      expect(joined).not.toContain("integration-bearer-secret");
      expect(joined).not.toContain("sk-mcp-secret-123456");
      expect(joined).not.toContain("mcp-secret-123456");
      expect(mcpRow).toContain("__sccEncrypted");
      expect(webSearchProviderRow).toContain("__sccEncrypted");
      expect(integrationProviderRow).toContain("__sccEncrypted");
      expect(scheduledTaskRow).toContain("__sccEncrypted");

      const reloaded = new SqliteWorkbenchStore(file);
      expect((await reloaded.getMcpServer("secret_mcp"))?.env?.["API_KEY"]).toBe("sk-mcp-secret-123456");
      expect((await reloaded.getMcpServer("secret_mcp"))?.url).toContain("mcp-secret-123456");
      expect((await reloaded.listIntegrationMessages(integration.id))[0]?.text).toContain("integration-message-secret-123456");
      expect((await reloaded.getWebSearchProviderSecret(search.id))).toBeDefined();
      const preferences = await reloaded.getPreferences();
      await reloaded.savePreferences({ ...preferences, encryptStorage: true, updatedAt: new Date().toISOString() });
      await reloaded.savePreferences({ ...preferences, encryptStorage: false, updatedAt: new Date().toISOString() });
      reloaded.close();

      const rewritten = new Database(file, { readonly: true });
      const rewrittenRows = rewritten.prepare("SELECT namespace, value FROM records").all() as Array<{ namespace: string; value: string }>;
      rewritten.close();
      const rewrittenJoined = rewrittenRows.map((row) => row.value).join("\n");
      const rewrittenMcpRow = rewrittenRows.find((row) => row.namespace === "mcp_servers")?.value ?? "";

      expect(rewrittenJoined).not.toContain("sk-mcp-secret-123456");
      expect(rewrittenJoined).not.toContain("mcp-secret-123456");
      expect(rewrittenJoined).not.toContain("integration-message-secret-123456");
      expect(rewrittenMcpRow).toContain("__sccEncrypted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy plaintext MCP server records to encrypted storage on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-mcp-migration-"));
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const raw = new Database(file);
      raw.prepare("CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))").run();
      raw.prepare("INSERT INTO records(namespace, key, value) VALUES (?, ?, ?)").run(
        "mcp_servers",
        "legacy_mcp",
        JSON.stringify({
          id: "legacy_mcp",
          label: "Legacy MCP",
          transport: "streamable_http",
          url: "https://mcp.example.test/stream?api_key=legacy-mcp-secret-123456",
          env: { API_KEY: "sk-legacy-mcp-secret-123456" },
          enabled: true,
          createdAt: now,
          updatedAt: now
        })
      );
      raw.close();

      const store = new SqliteWorkbenchStore(file);
      expect((await store.getMcpServer("legacy_mcp"))?.env?.["API_KEY"]).toBe("sk-legacy-mcp-secret-123456");
      store.close();

      const migrated = new Database(file, { readonly: true });
      const row = migrated.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("mcp_servers", "legacy_mcp") as { value: string };
      migrated.close();

      expect(row.value).toContain("__sccEncrypted");
      expect(row.value).not.toContain("sk-legacy-mcp-secret-123456");
      expect(row.value).not.toContain("legacy-mcp-secret-123456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy plaintext integration messages to encrypted storage on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-integration-message-migration-"));
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const raw = new Database(file);
      raw.prepare("CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))").run();
      raw.prepare("INSERT INTO records(namespace, key, value) VALUES (?, ?, ?)").run(
        "integration_messages",
        "legacy_integration_message",
        JSON.stringify({
          id: "legacy_integration_message",
          integrationId: "integration_legacy",
          externalMessageId: "legacy_external",
          externalChannelId: "legacy_channel",
          senderId: "legacy_sender",
          text: "Legacy inbound secret api_key=legacy-integration-message-secret-123456",
          createdAt: now
        })
      );
      raw.close();

      const store = new SqliteWorkbenchStore(file);
      expect((await store.listIntegrationMessages("integration_legacy"))[0]?.text).toContain("legacy-integration-message-secret-123456");
      store.close();

      const migrated = new Database(file, { readonly: true });
      const row = migrated.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("integration_messages", "legacy_integration_message") as { value: string };
      migrated.close();

      expect(row.value).toContain("__sccEncrypted");
      expect(row.value).not.toContain("legacy-integration-message-secret-123456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps raw inbound integration text encrypted while redacting task copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-integration-task-redaction-"));
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const workbench = new AgentWorkbench({ store, model: new StaticFinalModelClient() });
      const slack = await workbench.createIntegrationProvider({
        kind: "slack",
        label: "Slack Secure",
        signingSecret: "slack-secret-raw-task",
        callbackUrl: "https://slack.example.test/events",
        defaultFolderId: "default",
        defaultPermissionPreset: "ask",
        enabled: true
      });
      const app = await createTestApp({ workbench });
      const payload = {
        integrationId: slack.id,
        type: "event_callback",
        event_id: "slack_secret_event",
        event: {
          type: "message",
          user: "user_1",
          text: "Please debug with api_key=slack-inbound-task-secret-123456 and Bearer slack-inbound-bearer-secret",
          channel: "channel_secret",
          ts: "1711111111.200"
        }
      };
      const body = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const signature = slackSignature("slack-secret-raw-task", timestamp, body);

      const response = await app.injectRaw({
        method: "POST",
        url: "/api/integrations/slack/events",
        payload,
        headers: {
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp
        }
      });

      expect(response.statusCode).toBe(200);
      const task = (await store.listTasks())[0];
      const messages = await store.listIntegrationMessages(slack.id);
      expect(messages[0]?.text).toContain("slack-inbound-task-secret-123456");
      expect(JSON.stringify(task)).not.toContain("slack-inbound-task-secret-123456");
      expect(JSON.stringify(task)).not.toContain("slack-inbound-bearer-secret");
      expect(JSON.stringify(task)).toContain("[redacted-secret]");

      await app.close();
      store.close();

      const raw = new Database(file, { readonly: true });
      const joined = (raw.prepare("SELECT value FROM records").all() as Array<{ value: string }>).map((row) => row.value).join("\n");
      raw.close();

      expect(joined).not.toContain("slack-inbound-task-secret-123456");
      expect(joined).not.toContain("slack-inbound-bearer-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encrypts local task records by default even before preferences are initialized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-default-encrypted-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const now = new Date().toISOString();
      await store.saveTask({
        id: "task_default_secret",
        title: "Default encrypted task",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        approvals: [],
        pendingGuidance: [],
        events: [
          {
            id: "event_default_secret",
            taskId: "task_default_secret",
            type: "user_message",
            createdAt: now,
            summary: "DEFAULT_TASK_API_KEY_sk-default-secret-1234567890",
            payload: {}
          }
        ]
      });
      store.close();

      const raw = new Database(file, { readonly: true });
      const row = raw.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("tasks", "task_default_secret") as { value: string };
      raw.close();
      expect(row.value).toContain("__sccEncrypted");
      expect(row.value).not.toContain("sk-default-secret-1234567890");

      const reloaded = new SqliteWorkbenchStore(file);
      expect((await reloaded.getTask("task_default_secret"))?.events[0]?.summary).toContain("sk-default-secret-1234567890");
      reloaded.close();
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy plaintext user-content records even when full storage encryption is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-legacy-content-encrypted-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const raw = new Database(file);
      raw.prepare("CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))").run();
      raw.prepare("INSERT INTO records (namespace, key, value) VALUES (?, ?, ?)").run(
        "preferences",
        "default",
        JSON.stringify({ encryptStorage: false, sanitizeSensitiveData: true, updatedAt: now })
      );
      raw.prepare("INSERT INTO records (namespace, key, value) VALUES (?, ?, ?)").run(
        "tasks",
        "task_legacy_secret",
        JSON.stringify({
          id: "task_legacy_secret",
          title: "Legacy plaintext task",
          status: "completed",
          createdAt: now,
          updatedAt: now,
          approvals: [],
          pendingGuidance: [],
          events: [{
            id: "event_legacy_secret",
            taskId: "task_legacy_secret",
            type: "user_message",
            createdAt: now,
            summary: "LEGACY_TASK_API_KEY_sk-legacy-task-secret-1234567890",
            payload: {}
          }]
        })
      );
      raw.close();

      const store = new SqliteWorkbenchStore(file);
      expect((await store.getTask("task_legacy_secret"))?.events[0]?.summary).toContain("sk-legacy-task-secret-1234567890");
      expect((await store.getPreferences()).encryptStorage).toBe(false);
      store.close();

      const migrated = new Database(file, { readonly: true });
      const row = migrated.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("tasks", "task_legacy_secret") as { value: string };
      const preferencesRow = migrated.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("preferences", "default") as { value: string };
      migrated.close();
      expect(row.value).toContain("__sccEncrypted");
      expect(row.value).not.toContain("sk-legacy-task-secret-1234567890");
      expect(preferencesRow.value).toContain("__sccEncrypted");
      expect(preferencesRow.value).not.toContain("\"encryptStorage\":false");
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bulk-migrates legacy plaintext records and removes raw SQLite byte remnants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-bulk-migration-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const raw = new Database(file);
      raw.prepare("CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))").run();
      const insert = raw.prepare("INSERT INTO records (namespace, key, value) VALUES (?, ?, ?)");
      const needles: string[] = [
        "CHAOS_PREF_PROVIDER_BASE_URL_SECRET",
        "CHAOS_MCP_URL_SECRET",
        "CHAOS_WEB_SEARCH_SECRET",
        "CHAOS_SCHEDULED_PROMPT_SECRET",
        "CHAOS_INTEGRATION_MESSAGE_SECRET"
      ];

      insert.run("preferences", "default", JSON.stringify({
        ...defaultPreferences(),
        encryptStorage: false,
        updatedAt: now,
        providerBaseUrl: "https://CHAOS_PREF_PROVIDER_BASE_URL_SECRET.example.test/v1"
      }));
      insert.run("mcp_servers", "chaos_mcp", JSON.stringify({
        id: "chaos_mcp",
        label: "Chaos MCP",
        transport: "streamable_http",
        url: "https://mcp.example.test/stream?api_key=CHAOS_MCP_URL_SECRET",
        env: { API_KEY: "CHAOS_MCP_ENV_SECRET" },
        enabled: true,
        createdAt: now,
        updatedAt: now
      }));
      needles.push("CHAOS_MCP_ENV_SECRET");
      insert.run("web_search_providers", "chaos_search", JSON.stringify({
        id: "chaos_search",
        label: "Chaos Search",
        kind: "custom",
        endpoint: "https://search.example.test?q={query}&api_key=CHAOS_WEB_SEARCH_SECRET",
        enabled: true,
        createdAt: now,
        updatedAt: now
      }));
      insert.run("scheduled_tasks", "chaos_schedule", JSON.stringify({
        id: "chaos_schedule",
        title: "Chaos schedule",
        prompt: "Run with CHAOS_SCHEDULED_PROMPT_SECRET",
        folderId: "default",
        scheduleKind: "interval",
        intervalMinutes: 30,
        nextRunAt: now,
        enabled: true,
        createdAt: now,
        updatedAt: now
      }));
      insert.run("integration_messages", "chaos_integration_message", JSON.stringify({
        id: "chaos_integration_message",
        integrationId: "chaos_integration",
        externalMessageId: "external-chaos",
        externalChannelId: "channel-chaos",
        senderId: "sender-chaos",
        text: "Inbound message with CHAOS_INTEGRATION_MESSAGE_SECRET",
        createdAt: now
      }));
      for (let index = 0; index < 30; index += 1) {
        const taskSecret = `CHAOS_TASK_SECRET_${index.toString().padStart(2, "0")}`;
        const knowledgeSecret = `CHAOS_KNOWLEDGE_SECRET_${index.toString().padStart(2, "0")}`;
        needles.push(taskSecret, knowledgeSecret);
        insert.run("tasks", `chaos_task_${index}`, JSON.stringify({
          id: `chaos_task_${index}`,
          title: `Chaos task ${index}`,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          approvals: [],
          pendingGuidance: [],
          events: [{
            id: `chaos_event_${index}`,
            taskId: `chaos_task_${index}`,
            type: "user_message",
            createdAt: now,
            summary: `Task transcript ${taskSecret}`,
            payload: {}
          }]
        }));
        insert.run("knowledge_items", `chaos_knowledge_${index}`, JSON.stringify({
          id: `chaos_knowledge_${index}`,
          projectId: "default",
          kind: "memory",
          title: `Chaos knowledge ${index}`,
          content: `Knowledge content ${knowledgeSecret}`,
          tags: [],
          indexStatus: "pending",
          chunkCount: 0,
          createdAt: now,
          updatedAt: now
        }));
      }
      raw.close();

      const store = new SqliteWorkbenchStore(file);
      expect((await store.getPreferences()).providerBaseUrl).toContain("CHAOS_PREF_PROVIDER_BASE_URL_SECRET");
      expect((await store.listTasks())).toHaveLength(30);
      expect((await store.listKnowledgeItems("default"))).toHaveLength(30);
      expect((await store.getMcpServer("chaos_mcp"))?.url).toContain("CHAOS_MCP_URL_SECRET");
      expect((await store.getWebSearchProvider("chaos_search"))?.endpoint).toContain("CHAOS_WEB_SEARCH_SECRET");
      expect((await store.getScheduledTask("chaos_schedule"))?.prompt).toContain("CHAOS_SCHEDULED_PROMPT_SECRET");
      expect((await store.listIntegrationMessages("chaos_integration"))[0]?.text).toContain("CHAOS_INTEGRATION_MESSAGE_SECRET");
      store.close();

      const migrated = new Database(file, { readonly: true });
      const rows = migrated.prepare("SELECT namespace, value FROM records").all() as Array<{ namespace: string; value: string }>;
      migrated.close();

      expect(rows).toHaveLength(65);
      expect(rows.every((row) => row.value.includes("__sccEncrypted"))).toBe(true);
      expectSqliteFileFamilyNotToContain(file, needles);
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vacuums already-encrypted stores on open to remove stale plaintext page remnants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-open-vacuum-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const marker = "OPEN_VACUUM_RESIDUAL_SECRET";
      const store = new SqliteWorkbenchStore(file);
      const preferences = await store.getPreferences();
      await store.savePreferences({
        ...preferences,
        providerBaseUrl: `https://${marker.toLowerCase()}.example.test/v1`,
        updatedAt: new Date().toISOString()
      });
      store.close();

      const db = new Database(file);
      const encryptedRow = db.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("preferences", "default") as { value: string };
      const oversizedPlaintext = JSON.stringify({
        ...defaultPreferences(),
        encryptStorage: true,
        providerBaseUrl: `https://${marker}.example.test/v1`,
        notes: marker.repeat(500)
      });
      db.pragma("secure_delete = OFF");
      db.pragma("user_version = 0");
      db.prepare("UPDATE records SET value = ? WHERE namespace = ? AND key = ?").run(oversizedPlaintext, "preferences", "default");
      db.prepare("UPDATE records SET value = ? WHERE namespace = ? AND key = ?").run(encryptedRow.value, "preferences", "default");
      db.close();
      expect(readSqliteFileFamily(file).includes(Buffer.from(marker, "utf8")), "test setup should leave a stale plaintext page remnant").toBe(true);

      const reopened = new SqliteWorkbenchStore(file);
      expect((await reopened.getPreferences()).providerBaseUrl).toContain(marker.toLowerCase());
      reopened.close();

      const checked = new Database(file, { readonly: true });
      const userVersion = checked.pragma("user_version", { simple: true }) as number;
      checked.close();
      expect(userVersion).toBeGreaterThanOrEqual(20260526);
      expectSqliteFileFamilyNotToContain(file, [marker]);
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with a clear error when the local storage key is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-lost-key-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    const keyFile = join(dir, "local-secret.key");
    process.env["SCC_LOCAL_SECRET_FILE"] = keyFile;
    let reloaded: SqliteWorkbenchStore | undefined;
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const now = new Date().toISOString();
      await store.saveTask({
        id: "task_lost_key",
        title: "Lost key task",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        approvals: [],
        pendingGuidance: [],
        events: [{
          id: "event_lost_key",
          taskId: "task_lost_key",
          type: "user_message",
          createdAt: now,
          summary: "LOST_KEY_SECRET_TRANSCRIPT",
          payload: {}
        }]
      });
      store.close();
      rmSync(keyFile, { force: true });

      reloaded = new SqliteWorkbenchStore(file);
      await expect(reloaded.getTask("task_lost_key")).rejects.toThrow(/local secret key file may be missing, changed, or corrupted/i);
    } finally {
      reloaded?.close();
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not silently replace a corrupted local storage key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-bad-key-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    const keyFile = join(dir, "local-secret.key");
    process.env["SCC_LOCAL_SECRET_FILE"] = keyFile;
    let store: SqliteWorkbenchStore | undefined;
    try {
      writeFileSync(keyFile, "not-a-valid-32-byte-base64-key", "utf8");
      const file = join(dir, "state.sqlite");
      store = new SqliteWorkbenchStore(file);
      await expect(store.getPreferences()).rejects.toThrow(/invalid local secret key file/i);
      expect(readFileSync(keyFile, "utf8")).toBe("not-a-valid-32-byte-base64-key");
    } finally {
      store?.close();
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with contextual errors for malformed SQLite records", () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-malformed-row-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const raw = new Database(file);
      raw
        .prepare("CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))")
        .run();
      raw.prepare("INSERT INTO records(namespace, key, value) VALUES (?, ?, ?)").run("tasks", "bad_row", "{MALFORMED_ROW_SECRET");
      raw.close();

      let thrown: unknown;
      try {
        new SqliteWorkbenchStore(file);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toMatch(/tasks\/bad_row/i);
      expect(message).toMatch(/malformed|unreadable/i);
      expect(message).not.toContain("MALFORMED_ROW_SECRET");
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with contextual errors for corrupted encrypted SQLite rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-corrupt-row-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    let reloaded: SqliteWorkbenchStore | undefined;
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const now = new Date().toISOString();
      await store.saveTask({
        id: "task_corrupt_row",
        title: "Corrupt row task",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        approvals: [],
        pendingGuidance: [],
        events: [{
          id: "event_corrupt_row",
          taskId: "task_corrupt_row",
          type: "assistant_message",
          createdAt: now,
          summary: "CORRUPT_ROW_SECRET_TRANSCRIPT",
          payload: {}
        }]
      });
      store.close();

      const raw = new Database(file);
      const row = raw.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("tasks", "task_corrupt_row") as { value: string };
      const envelope = JSON.parse(row.value) as { payload: { value: string } };
      envelope.payload.value = Buffer.from("tampered ciphertext", "utf8").toString("base64");
      raw.prepare("UPDATE records SET value = ? WHERE namespace = ? AND key = ?").run(JSON.stringify(envelope), "tasks", "task_corrupt_row");
      raw.close();

      reloaded = new SqliteWorkbenchStore(file);
      await expect(reloaded.getTask("task_corrupt_row")).rejects.toThrow(/tasks\/task_corrupt_row.*local secret key|tasks\/task_corrupt_row.*decrypt/i);
      expect(readSqliteFileFamily(file).includes(Buffer.from("CORRUPT_ROW_SECRET_TRANSCRIPT", "utf8"))).toBe(false);
    } finally {
      reloaded?.close();
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives high-volume encrypted writes across repeated reopen cycles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-high-volume-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const secrets = ["HIGH_VOLUME_TASK_SECRET_000", "HIGH_VOLUME_KNOWLEDGE_SECRET_000", "HIGH_VOLUME_TASK_SECRET_599", "HIGH_VOLUME_KNOWLEDGE_SECRET_599"];

      let store = new SqliteWorkbenchStore(file);
      for (let index = 0; index < 600; index += 1) {
        await store.saveTask({
          id: `high_volume_task_${index}`,
          title: `High volume task ${index}`,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          approvals: [],
          pendingGuidance: [],
          events: [{
            id: `high_volume_event_${index}`,
            taskId: `high_volume_task_${index}`,
            type: "assistant_message",
            createdAt: now,
            summary: `HIGH_VOLUME_TASK_SECRET_${index.toString().padStart(3, "0")}`,
            payload: { ordinal: index }
          }]
        });
        await store.saveKnowledgeItem({
          id: `high_volume_knowledge_${index}`,
          projectId: "default",
          kind: "memory",
          title: `High volume knowledge ${index}`,
          content: `HIGH_VOLUME_KNOWLEDGE_SECRET_${index.toString().padStart(3, "0")}`,
          tags: ["stress"],
          indexStatus: "pending",
          chunkCount: 0,
          createdAt: now,
          updatedAt: now
        });
      }
      store.close();

      for (let cycle = 0; cycle < 5; cycle += 1) {
        store = new SqliteWorkbenchStore(file);
        expect(await store.listTasks()).toHaveLength(600);
        expect(await store.listKnowledgeItems("default")).toHaveLength(600);
        expect((await store.getTask(`high_volume_task_${cycle * 100}`))?.events[0]?.summary).toContain("HIGH_VOLUME_TASK_SECRET_");
        store.close();
      }

      expectSqliteFileFamilyNotToContain(file, secrets);
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("coordinates concurrent encrypted writes across multiple store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-concurrent-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    const stores: SqliteWorkbenchStore[] = [];
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const writerCount = 4;
      const writesPerWriter = 40;
      for (let writer = 0; writer < writerCount; writer += 1) stores.push(new SqliteWorkbenchStore(file));

      await Promise.all(stores.map(async (store, writer) => {
        for (let index = 0; index < writesPerWriter; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, (writer + index) % 3));
          await store.saveTask({
            id: `concurrent_task_${writer}_${index}`,
            title: `Concurrent task ${writer}-${index}`,
            status: "completed",
            createdAt: now,
            updatedAt: now,
            approvals: [],
            pendingGuidance: [],
            events: [{
              id: `concurrent_event_${writer}_${index}`,
              taskId: `concurrent_task_${writer}_${index}`,
              type: "assistant_message",
              createdAt: now,
              summary: `CONCURRENT_SQLITE_SECRET_${writer}_${index}`,
              payload: { writer, index }
            }]
          });
        }
      }));
      for (const store of stores.splice(0)) store.close();

      const reloaded = new SqliteWorkbenchStore(file);
      const tasks = await reloaded.listTasks();
      expect(tasks).toHaveLength(writerCount * writesPerWriter);
      expect((await reloaded.getTask("concurrent_task_0_0"))?.events[0]?.summary).toBe("CONCURRENT_SQLITE_SECRET_0_0");
      expect((await reloaded.getTask("concurrent_task_3_39"))?.events[0]?.summary).toBe("CONCURRENT_SQLITE_SECRET_3_39");
      reloaded.close();

      expectSqliteFileFamilyNotToContain(file, ["CONCURRENT_SQLITE_SECRET_0_0", "CONCURRENT_SQLITE_SECRET_3_39"]);
    } finally {
      for (const store of stores) store.close();
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("recovers encrypted records from an uncheckpointed WAL without exposing plaintext bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-wal-recovery-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    let writer: SqliteWorkbenchStore | undefined;
    let reader: SqliteWorkbenchStore | undefined;
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      writer = new SqliteWorkbenchStore(file);
      for (let index = 0; index < 120; index += 1) {
        await writer.saveTask({
          id: `wal_recovery_task_${index}`,
          title: `WAL recovery task ${index}`,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          approvals: [],
          pendingGuidance: [],
          events: [{
            id: `wal_recovery_event_${index}`,
            taskId: `wal_recovery_task_${index}`,
            type: "assistant_message",
            createdAt: now,
            summary: `WAL_RECOVERY_SECRET_${index}`,
            payload: { index, padding: "wal".repeat(64) }
          }]
        });
      }

      expect(existsSync(`${file}-wal`)).toBe(true);
      expectSqliteFileFamilyNotToContain(file, ["WAL_RECOVERY_SECRET_0", "WAL_RECOVERY_SECRET_119"]);

      reader = new SqliteWorkbenchStore(file);
      expect(await reader.listTasks()).toHaveLength(120);
      expect((await reader.getTask("wal_recovery_task_119"))?.events[0]?.summary).toBe("WAL_RECOVERY_SECRET_119");
      reader.close();
      reader = undefined;
      writer.close();
      writer = undefined;

      const reopened = new SqliteWorkbenchStore(file);
      expect((await reopened.getTask("wal_recovery_task_0"))?.events[0]?.summary).toBe("WAL_RECOVERY_SECRET_0");
      reopened.close();
      expectSqliteFileFamilyNotToContain(file, ["WAL_RECOVERY_SECRET_0", "WAL_RECOVERY_SECRET_119"]);
    } finally {
      if (reader) reader.close();
      if (writer) writer.close();
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("opens large encrypted stores with bounded secure-vacuum startup cost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-large-open-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const now = new Date().toISOString();
      const rowCount = 1500;
      let store = new SqliteWorkbenchStore(file);
      for (let index = 0; index < rowCount; index += 1) {
        await store.saveTask({
          id: `large_open_task_${index}`,
          title: `Large open task ${index}`,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          approvals: [],
          pendingGuidance: [],
          events: [{
            id: `large_open_event_${index}`,
            taskId: `large_open_task_${index}`,
            type: "user_message",
            createdAt: now,
            summary: `LARGE_OPEN_SQLITE_SECRET_${index}`,
            payload: { index, padding: "x".repeat(256) }
          }]
        });
      }
      store.close();

      const raw = new Database(file);
      raw.pragma("user_version = 0");
      raw.close();

      const startedAt = Date.now();
      store = new SqliteWorkbenchStore(file);
      const openDurationMs = Date.now() - startedAt;
      expect(await store.listTasks()).toHaveLength(rowCount);
      store.close();

      const checked = new Database(file, { readonly: true });
      const userVersion = checked.pragma("user_version", { simple: true }) as number;
      checked.close();
      expect(userVersion).toBeGreaterThanOrEqual(20260526);
      expect(openDurationMs).toBeLessThan(10_000);
      expectSqliteFileFamilyNotToContain(file, ["LARGE_OPEN_SQLITE_SECRET_0", "LARGE_OPEN_SQLITE_SECRET_1499"]);
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("encrypts local records when encryptStorage is enabled while keeping them readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scc-store-encrypted-"));
    const previousSecretFile = process.env["SCC_LOCAL_SECRET_FILE"];
    process.env["SCC_LOCAL_SECRET_FILE"] = join(dir, "local-secret.key");
    try {
      const file = join(dir, "state.sqlite");
      const store = new SqliteWorkbenchStore(file);
      const preferences = await store.getPreferences();
      await store.savePreferences({ ...preferences, encryptStorage: true, updatedAt: new Date().toISOString() });
      const now = new Date().toISOString();
      await store.saveTask({
        id: "task_secret",
        title: "Encrypted task",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        approvals: [],
        pendingGuidance: [],
        events: [
          {
            id: "event_secret",
            taskId: "task_secret",
            type: "assistant_message",
            createdAt: now,
            summary: "SECRET_TASK_TRANSCRIPT",
            payload: {}
          }
        ]
      });
      await store.saveKnowledgeItem({
        id: "knowledge_secret",
        projectId: "default",
        kind: "memory",
        title: "Secret note",
        content: "PLAINTEXT_KNOWLEDGE_SECRET",
        tags: [],
        indexStatus: "pending",
        chunkCount: 0,
        createdAt: now,
        updatedAt: now
      });
      store.close();

      const raw = new Database(file, { readonly: true });
      const rows = raw.prepare("SELECT namespace, value FROM records").all() as Array<{ namespace: string; value: string }>;
      raw.close();
      const taskRow = rows.find((row) => row.namespace === "tasks")?.value ?? "";
      const knowledgeRow = rows.find((row) => row.namespace === "knowledge_items")?.value ?? "";
      const preferencesRow = rows.find((row) => row.namespace === "preferences")?.value ?? "";

      expect(taskRow).not.toContain("SECRET_TASK_TRANSCRIPT");
      expect(knowledgeRow).not.toContain("PLAINTEXT_KNOWLEDGE_SECRET");
      expect(preferencesRow).not.toContain("\"encryptStorage\":true");
      expect(taskRow).toContain("__sccEncrypted");
      expect(knowledgeRow).toContain("__sccEncrypted");
      expect(preferencesRow).toContain("__sccEncrypted");

      const reloaded = new SqliteWorkbenchStore(file);
      expect((await reloaded.getTask("task_secret"))?.events[0]?.summary).toBe("SECRET_TASK_TRANSCRIPT");
      expect((await reloaded.getKnowledgeItem("knowledge_secret"))?.content).toBe("PLAINTEXT_KNOWLEDGE_SECRET");
      reloaded.close();
    } finally {
      if (previousSecretFile === undefined) delete process.env["SCC_LOCAL_SECRET_FILE"];
      else process.env["SCC_LOCAL_SECRET_FILE"] = previousSecretFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
