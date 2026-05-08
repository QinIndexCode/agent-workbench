import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentWorkbench, ConfiguredToolModelClient, InMemoryWorkbenchStore, McpRegistry } from "@scc/core";
import type { TaskDetail, TaskEvent, ToolCall, ToolResult } from "@scc/shared";
import { createApp } from "../src/server.js";
import { SqliteWorkbenchStore } from "../src/sqlite-store.js";

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

describe("server API", () => {
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
    const app = await createApp({ workbench: new AgentWorkbench({ store }) });

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
            "[UI preview truncated: 999 characters omitted. Full evidence is retained by SCC.]"
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
    const app = await createApp({ workbench: new AgentWorkbench({ store }) });

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
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_attachment");
    expect(transcript.map((event: TaskEvent) => event.id)).toContain("event_agent_0");
    expect(transcript.at(-1)?.id).toBe("event_agent_999");
    expect(transcript.map((event: TaskEvent) => event.id)).not.toContain("event_context_summary");
    expect(JSON.stringify(transcript)).not.toContain("UI preview truncated");
    expect(JSON.stringify(transcript)).not.toContain("Original goal");
    expect(JSON.stringify(transcript)).not.toContain("Tool evidence returned");
    expect(JSON.stringify(transcript)).toContain("Top entries");
    await app.close();
  });

  it("creates a task and exposes an approval", async () => {
    const app = await createApp({
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
    const app = await createApp({
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

  it("generates local fallback titles and manages task folders", async () => {
    const app = await createApp({
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
    const app = await createApp({
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
    expect(approvalResponse.json().status).toBe("completed");

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

  it("deletes tasks with optional learning cleanup", async () => {
    const app = await createApp({
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
    const app = await createApp({
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

  it("bootstraps a Mimo model provider from the local API key document without exposing the key", async () => {
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

      const app = await createApp();
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

  it("serves SCC tools through a real MCP streamable HTTP client", async () => {
    const app = await createApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ConfiguredToolModelClient("Get-Process") })
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const client = new Client({ name: "scc-server-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/api/mcp/server`));

    try {
      await client.connect(transport as never);
      const tools = await client.listTools();
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

async function waitForTask(app: Awaited<ReturnType<typeof createApp>>, taskId: string, predicate: (task: TaskDetail) => boolean): Promise<TaskDetail> {
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
