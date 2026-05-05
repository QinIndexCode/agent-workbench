import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentWorkbench, ConfiguredToolModelClient, InMemoryWorkbenchStore, McpRegistry } from "@scc/core";
import type { ToolCall, ToolResult } from "@scc/shared";
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
      payload: { goal: "check running processes" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("waiting_approval");
    expect(body.approvals[0].riskCategory).toBe("host_observation");
    await app.close();
  });

  it("rejects unknown request fields through strict schemas", async () => {
    const app = await createApp({
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "hello", unexpected: true }
    });

    expect(response.statusCode).toBe(400);
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
      payload: { goal: "check running processes" }
    });
    const created = createResponse.json();

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
    expect(skills.length).toBeGreaterThan(0);
    expect((await app.inject(`/api/skills/${skills[0].id}`)).json().id).toBe(skills[0].id);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/skills/${skills[0].id}`,
      payload: { status: "candidate" }
    });
    expect(patchResponse.json().status).toBe("candidate");

    const promoteResponse = await app.inject({
      method: "POST",
      url: `/api/experiences/${experiences[0].id}/promote`
    });
    expect(promoteResponse.statusCode).toBe(201);

    expect((await app.inject("/api/task-memories")).json().length).toBeGreaterThan(0);
    expect((await app.inject("/api/patterns")).statusCode).toBe(200);
    expect((await app.inject("/api/skill-conflicts")).statusCode).toBe(200);
    expect((await app.inject("/api/preferences")).json().language).toBe("zh-CN");

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
    expect((await app.inject({ method: "POST", url: "/api/mcp/server", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).statusCode).toBeLessThan(500);
    await app.close();
  });
});

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
