import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentWorkbench, ConfiguredToolModelClient, InMemoryWorkbenchStore, McpRegistry, type ModelClient, type ModelTurn } from "@agent-workbench/core";
import type { TaskDetail, TaskEvent, ToolCall, ToolResult } from "@agent-workbench/shared";
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
    expect(JSON.stringify(transcript)).toContain("I will inspect the code and then improve the styles.");
    expect(JSON.stringify(transcript)).toContain("Payload-only assistant body.");
    expect(JSON.stringify(transcript)).toContain("Top entries");
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
    expect(folder.rootPath).toBe(resolve(localRoot));
    expect(folder.exists).toBe(true);

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { goal: "check running processes", title: "Process check", folderId: folder.id }
      })
    ).json();
    expect(created.folderId).toBe(folder.id);
    expect(created.workRoot).toBe(resolve(localRoot));

    const renamed = (
      await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { title: "Process check renamed", folderId: "default" }
      })
    ).json();
    expect(renamed.title).toBe("Process check renamed");
    expect(renamed.folderId).toBe("default");
    expect(renamed.workRoot).toBe(resolve(localRoot));

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
    expect(skills.length).toBe(0);

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

    expect((await app.inject("/api/task-memories")).json().length).toBeGreaterThan(0);
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
    expect(providerPatch.json().enabled).toBe(false);
    expect(providerPatch.json().label).toBe("Mimo updated");

    const grantResponse = await app.inject({
      method: "POST",
      url: "/api/permissions/global",
      payload: { riskCategory: "host_observation", reason: "test" }
    });
    expect(grantResponse.statusCode).toBe(201);
    expect((await app.inject("/api/permissions/global")).json()[0].riskCategory).toBe("host_observation");

    const reflectionResponse = await app.inject({ method: "POST", url: "/api/reflections" });
    expect(reflectionResponse.statusCode).toBe(201);
    const reflection = reflectionResponse.json();
    expect((await app.inject("/api/reflections")).json().some((item: { id: string }) => item.id === reflection.id)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/reflections/${reflection.id}` })).statusCode).toBe(204);
    expect((await app.inject("/api/reflections")).json().some((item: { id: string }) => item.id === reflection.id)).toBe(false);

    const scheduledTasks = (await app.inject("/api/scheduled-tasks")).json();
    expect(scheduledTasks.some((task: { id: string; type: string }) => task.id === "schedule_agent_reflection" && task.type === "reflection")).toBe(true);
    const deleteReflection = await app.inject({ method: "DELETE", url: "/api/scheduled-tasks/schedule_agent_reflection" });
    expect(deleteReflection.statusCode).toBe(400);

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
    await app.close();
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
        env: {},
        enabled: false,
        toolRiskOverrides: {}
      }
    });
    expect(createResponse.statusCode).toBe(201);
    expect((await app.inject("/api/mcp/servers")).json()[0].id).toBe("mock");
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
    const app = await createTestApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
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
    expect((await app.inject({ method: "DELETE", url: `/api/web-search/providers/${webSearch.id}` })).statusCode).toBe(204);

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
      expect(taskRow).toContain("__sccEncrypted");
      expect(knowledgeRow).toContain("__sccEncrypted");
      expect(preferencesRow).toContain("\"encryptStorage\":true");

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
