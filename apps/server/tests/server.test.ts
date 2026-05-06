import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentWorkbench, ConfiguredToolModelClient, InMemoryWorkbenchStore, McpRegistry } from "@scc/core";
import type { TaskDetail, ToolCall, ToolResult } from "@scc/shared";
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
    expect(titleResponse.json().title.length).toBeLessThanOrEqual(18);

    expect((await app.inject("/api/task-folders")).json().map((folder: { id: string }) => folder.id)).toContain("default");
    const folder = (
      await app.inject({
        method: "POST",
        url: "/api/task-folders",
        payload: { name: "System checks" }
      })
    ).json();
    expect(folder.name).toBe("System checks");

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { goal: "check running processes", title: "Process check", folderId: folder.id }
      })
    ).json();
    expect(created.folderId).toBe(folder.id);

    const patched = (
      await app.inject({
        method: "PATCH",
        url: `/api/task-folders/${folder.id}`,
        payload: { name: "Host checks" }
      })
    ).json();
    expect(patched.name).toBe("Host checks");

    const cleared = (
      await app.inject({
        method: "POST",
        url: `/api/task-folders/${folder.id}/clear`,
        payload: { deleteLearningData: false, deleteDerivedSkills: false }
      })
    ).json();
    expect(cleared.deletedTasks).toBe(1);
    expect((await app.inject(`/api/tasks/${created.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/task-folders/${folder.id}` })).statusCode).toBe(204);
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
});
