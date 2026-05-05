import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { describe, expect, it } from "vitest";
import type { TaskDetail, ToolCall, ToolResult } from "@scc/shared";
import { ShellToolExecutor } from "../src/tools.js";
import {
  AgentWorkbench,
  CompositeToolExecutor,
  ConfiguredToolModelClient,
  ContextAssembler,
  InMemoryWorkbenchStore,
  McpRegistry,
  type ModelClient,
  type ModelStreamHandlers,
  type ModelTurn,
  PermissionEngine,
  detectSkillConflicts,
  createExperience,
  createId,
  loadOpenAiConfig,
  loadOpenAiProviderConfig,
  nowIso,
  promoteExperience
} from "../src/index.js";

const hostObservationModel = new ConfiguredToolModelClient("Get-Process | Sort-Object CPU");

describe("ContextAssembler", () => {
  it("keeps capability questions direct and evidence-grounded", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      id: "task_capabilities",
      title: "你可以帮我做些什么",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_capabilities",
          type: "user_message",
          createdAt: nowIso(),
          summary: "你可以帮我做些什么",
          payload: {}
        }
      ]
    };

    const context = await assembler.assemble(task);

    expect(context.systemPrompt).toContain("answer directly from your general capabilities");
    expect(context.systemPrompt).toContain("do not inspect files first");
    expect(context.systemPrompt).toContain("Do not claim the project name");
    expect(context.systemPrompt).toContain("Use Markdown for readable structure");
  });
});

class StubToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: JSON.stringify([{ ProcessName: "node", Id: 42, CPU: 100, WorkingSet64: 1024 * 1024 * 200 }])
    };
  }
}

class AbortableToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall, options?: { signal?: AbortSignal }): Promise<ToolResult> {
    this.calls.push(call);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: !options?.signal?.aborted,
      createdAt: nowIso(),
      output: options?.signal?.aborted ? "Command cancelled by user." : "done"
    };
  }
}

class SingleToolModel implements ModelClient {
  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown> = {}
  ) {}

  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result")) {
      return { kind: "final", message: "MCP evidence accepted." };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: this.toolName, args: this.args }]
    };
  }
}

class StreamingFinalModel implements ModelClient {
  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    await stream?.onThinkingDelta("Checking the request and available evidence.");
    await stream?.onAssistantDelta("Hello");
    await stream?.onAssistantDelta(" stream.");
    return { kind: "final", message: "Hello stream.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

describe("PermissionEngine", () => {
  it("classifies Get-Process as host observation", () => {
    const engine = new PermissionEngine();
    const risk = engine.assess("run_command", { command: "Get-Process | Sort-Object CPU" });
    expect(risk.category).toBe("host_observation");
  });

  it("classifies destructive process changes separately", () => {
    const engine = new PermissionEngine();
    const risk = engine.assess("run_command", { command: "Stop-Process -Id 100" });
    expect(risk.category).toBe("destructive");
  });

  it("does not treat PowerShell Format-Table as destructive formatting", () => {
    const engine = new PermissionEngine();
    const risk = engine.assess("run_command", {
      command:
        "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Name, Id, CPU, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize"
    });
    expect(risk.category).toBe("host_observation");
  });

  it("classifies workspace writes and network requests", () => {
    const engine = new PermissionEngine();
    expect(engine.assess("run_command", { command: "Set-Content note.txt hi" }).category).toBe("workspace_write");
    expect(engine.assess("run_command", { command: "npm install left-pad" }).category).toBe("network");
  });
});

describe("AgentWorkbench", () => {
  it("pauses host observation for approval, then resumes and records evidence", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools, model: hostObservationModel });

    const created = await workbench.createTask("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
    expect(created.status).toBe("waiting_approval");
    expect(created.approvals[0]?.riskCategory).toBe("host_observation");

    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    const completed = await workbench.decideApproval(created.id, approval.id, "allow_for_task");

    expect(completed.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
    expect(completed.events.some((event) => event.type === "tool_result")).toBe(true);
    expect(completed.events.some((event) => event.type === "assistant_message")).toBe(true);
  });

  it("records streaming thinking and assistant deltas before final response", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    const completed = await workbench.createTask("stream a response");
    const thinking = completed.events.filter((event) => event.type === "thinking_delta");
    const deltas = completed.events.filter((event) => event.type === "assistant_delta");
    const final = completed.events.find((event) => event.type === "assistant_message");

    expect(completed.status).toBe("completed");
    expect(thinking.length).toBeGreaterThan(0);
    expect(deltas.map((event) => event.summary).join("")).toBe("Hello stream.");
    expect(final?.summary).toBe("Hello stream.");
    expect(final?.payload["streamId"]).toBe(deltas[0]?.payload["streamId"]);
  });

  it("keeps running user input pending until the next safe point", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const guided = await workbench.appendMessage(created.id, "Focus on memory too");

    expect(guided.status).toBe("waiting_approval");
    expect(guided.pendingGuidance[0]?.summary).toBe("Focus on memory too");
  });

  it("records read-only experience without immediately solidifying a skill", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");

    await workbench.decideApproval(created.id, approval.id, "allow_for_task");

    const experiences = await workbench.listExperiences();
    const skills = await workbench.listSkills();
    expect(experiences[0]?.readOnly).toBe(true);
    expect(skills).toHaveLength(0);
  });

  it("deletes a task and can clean linked learning records and derived skills", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    const completed = await workbench.decideApproval(created.id, approval.id, "allow_for_task");
    const experience = (await workbench.listExperiences())[0];
    if (!experience) throw new Error("expected experience");
    await workbench.promoteExperience(experience.id);

    const result = await workbench.deleteTask(completed.id, { deleteLearningData: true, deleteDerivedSkills: true });

    expect(result).toMatchObject({
      taskId: completed.id,
      deletedTask: true,
      deletedExperiences: 1,
      deletedTaskMemories: 1,
      deletedSkills: 1,
      updatedSkills: 0
    });
    expect(await workbench.getTask(completed.id)).toBeUndefined();
    expect(await workbench.listExperiences()).toHaveLength(0);
    expect(await workbench.listTaskMemories()).toHaveLength(0);
    expect(await workbench.listSkills()).toHaveLength(0);
  });

  it("manual experience promotion merges duplicate skills instead of creating repeated rows", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    const task = {
      id: "task_1",
      title: "帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些",
      status: "completed" as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_1",
          taskId: "task_1",
          type: "user_message" as const,
          createdAt: nowIso(),
          summary: "帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些",
          payload: {}
        },
        {
          id: "event_2",
          taskId: "task_1",
          type: "tool_requested" as const,
          createdAt: nowIso(),
          summary: "run_command",
          payload: { toolName: "run_command", riskCategory: "host_observation" }
        },
        {
          id: "event_3",
          taskId: "task_1",
          type: "tool_result" as const,
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: { output: "node 42" }
        },
        {
          id: "event_4",
          taskId: "task_1",
          type: "assistant_message" as const,
          createdAt: nowIso(),
          summary: "Top process: node",
          payload: {}
        }
      ]
    };
    const first = createExperience(task);
    const second = { ...createExperience({ ...task, id: "task_2" }), id: "experience_2", taskId: "task_2" };
    await store.saveExperience(first);
    await store.saveExperience(second);

    await workbench.promoteExperience(first.id);
    await workbench.promoteExperience(second.id);

    const skills = await workbench.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.sourceMemoryIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await workbench.listSkillDuplicates()).toHaveLength(0);
  });

  it("uses global risk grants before showing approval UI", async () => {
    const store = new InMemoryWorkbenchStore();
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({
      store,
      tools,
      model: new ConfiguredToolModelClient("Get-Process")
    });

    await workbench.grantGlobalPermission("host_observation", "test grant");
    const created = await workbench.createTask("check running processes");

    expect(created.status).toBe("completed");
    expect(created.approvals).toHaveLength(0);
    expect(created.events.some((event) => event.type === "approval_auto_granted")).toBe(true);
    expect(tools.calls).toHaveLength(1);
  });

  it("rehydrates task-scoped approval grants from stored task approvals", async () => {
    const store = new InMemoryWorkbenchStore();
    const firstTools = new StubToolExecutor();
    const firstWorkbench = new AgentWorkbench({
      store,
      tools: firstTools,
      model: new ConfiguredToolModelClient("Get-Process")
    });

    const created = await firstWorkbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    await firstWorkbench.decideApproval(created.id, approval.id, "allow_for_task");

    const secondTools = new StubToolExecutor();
    const reloadedWorkbench = new AgentWorkbench({
      store,
      tools: secondTools,
      model: new ConfiguredToolModelClient("Get-Process")
    });

    const continued = await reloadedWorkbench.appendMessage(created.id, "check again");

    expect(continued.status).toBe("completed");
    expect(continued.approvals.filter((item) => item.status === "pending")).toHaveLength(0);
    expect(secondTools.calls).toHaveLength(1);
  });

  it("revokes global grants so approvals appear again", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ConfiguredToolModelClient("Get-Process")
    });

    await workbench.grantGlobalPermission("host_observation", "test grant");
    await workbench.revokeGlobalPermission("host_observation");
    const created = await workbench.createTask("check running processes");

    expect(created.status).toBe("waiting_approval");
    expect(created.approvals[0]?.riskCategory).toBe("host_observation");
  });

  it("serializes duplicate approval decisions so one tool call executes once", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");

    const [first, second] = await Promise.all([
      workbench.decideApproval(created.id, approval.id, "allow_once"),
      workbench.decideApproval(created.id, approval.id, "allow_once")
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
  });

  it("cancels a running tool when the task is paused", async () => {
    const tools = new AbortableToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");

    const resumed = workbench.decideApproval(created.id, approval.id, "allow_once");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paused = await workbench.control(created.id, "pause");
    const final = await resumed;

    expect(paused.status).toBe("paused");
    expect(final.status).toBe("paused");
    expect(final.events.some((event) => String(event.payload["output"] ?? "").includes("cancelled"))).toBe(true);
  });

  it("marks side-effect experience promotions as drafts", () => {
    const base = {
      id: "task_1",
      title: "write file",
      status: "completed" as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pendingGuidance: [],
      approvals: [],
      events: [
        {
          id: "event_1",
          taskId: "task_1",
          type: "user_message" as const,
          createdAt: nowIso(),
          summary: "write a file",
          payload: {}
        },
        {
          id: "event_2",
          taskId: "task_1",
          type: "tool_requested" as const,
          createdAt: nowIso(),
          summary: "run_command",
          payload: { toolName: "run_command", riskCategory: "workspace_write" }
        },
        {
          id: "event_3",
          taskId: "task_1",
          type: "assistant_message" as const,
          createdAt: nowIso(),
          summary: "done",
          payload: {}
        }
      ]
    };
    const experience = createExperience(base);
    expect(promoteExperience(experience).status).toBe("candidate");
  });

  it("records skill load events and updates skill stats after successful use", async () => {
    const store = new InMemoryWorkbenchStore();
    const source = promoteExperience({
      id: "experience_1",
      taskId: "task_seed",
      title: "process check",
      goal: "check process",
      body: "Use host observation evidence.",
      readOnly: true,
      toolsUsed: [],
      result: "ok",
      assessment: { goalAchieved: true, confidence: 0.9, issues: [], learnings: [], suggestedPatterns: ["host_observation"] },
      meta: {
        outcome: "success",
        complexity: "simple",
        domains: ["host_observation"],
        tools: ["run_command"],
        hasSideEffects: false,
        duration: 1
      },
      reflectionCount: 0,
      reflectionStatus: "pending",
      createdAt: nowIso()
    });
    await store.saveSkill({ ...source, id: "skill_process", status: "active", applicability: { ...source.applicability, keywords: ["process"] } });
    const contextAssembler = new (await import("../src/context-assembler.js")).ContextAssembler(store);
    const workbench = new AgentWorkbench({
      store,
      contextAssembler,
      model: {
        async next(task) {
          if (!task.events.some((event) => event.type === "skill_loaded")) {
            await contextAssembler.loadSkill(task.id, "skill_process");
            return { kind: "final", message: "used skill" };
          }
          return { kind: "final", message: "done" };
        }
      }
    });

    const completed = await workbench.createTask("process check");
    const skill = await workbench.getSkill("skill_process");

    expect(completed.events.some((event) => event.type === "skill_loaded")).toBe(true);
    expect(skill?.stats.totalUses).toBe(1);
    expect(skill?.stats.successUses).toBe(1);
  });
});

describe("McpRegistry", () => {
  it("discovers stdio MCP tools, routes execution through approval, and reuses global permission", async () => {
    const temp = mkdtempSync(join(process.cwd(), "tmp-scc-mcp-"));
    try {
      const script = join(temp, "mock-mcp.mjs");
      writeFileSync(script, mockMcpServerSource());
      const store = new InMemoryWorkbenchStore();
      const registry = new McpRegistry(store);
      await registry.createServer({
        id: "mock",
        label: "Mock MCP",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        env: {},
        enabled: true,
        toolRiskOverrides: { echo: "host_observation" }
      });

      const status = await registry.connectServer("mock");
      expect(status.state).toBe("connected");
      expect((await registry.listTools())[0]?.id).toBe("mcp__mock__echo");

      const workbench = new AgentWorkbench({
        store,
        model: new SingleToolModel("mcp__mock__echo", { text: "hello" }),
        tools: new CompositeToolExecutor(new ShellToolExecutor(), [registry]),
        toolRiskProvider: registry
      });
      const pending = await workbench.createTask("call mock MCP");
      expect(pending.status).toBe("waiting_approval");
      expect(pending.approvals[0]?.riskCategory).toBe("host_observation");
      expect(pending.approvals[0]?.metadata?.["serverId"]).toBe("mock");
      expect(pending.approvals[0]?.metadata?.["toolName"]).toBe("echo");

      const approval = pending.approvals[0];
      if (!approval) throw new Error("expected approval");
      const completed = await workbench.decideApproval(pending.id, approval.id, "allow_globally");
      expect(completed.status).toBe("completed");
      expect(completed.events.some((event) => String(event.payload["output"] ?? "").includes("echo:hello"))).toBe(true);

      const second = await workbench.createTask("call mock MCP again");
      expect(second.approvals).toHaveLength(0);
      expect(second.events.some((event) => event.type === "approval_auto_granted")).toBe(true);
      await registry.disconnectServer("mock");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("discovers and calls streamable HTTP MCP tools", async () => {
    const mock = await startMockHttpMcpServer();
    try {
      const store = new InMemoryWorkbenchStore();
      const registry = new McpRegistry(store);
      await registry.createServer({
        id: "http_mock",
        label: "HTTP MCP",
        transport: "streamable_http",
        url: mock.url,
        args: [],
        env: {},
        enabled: true,
        toolRiskOverrides: { echo: "network" }
      });

      const status = await registry.connectServer("http_mock");
      expect(status.state).toBe("connected");
      expect((await registry.listTools())[0]?.id).toBe("mcp__http_mock__echo");

      const workbench = new AgentWorkbench({
        store,
        model: new SingleToolModel("mcp__http_mock__echo", { text: "from-http" }),
        tools: new CompositeToolExecutor(new ShellToolExecutor(), [registry]),
        toolRiskProvider: registry
      });
      const pending = await workbench.createTask("call http MCP");
      expect(pending.approvals[0]?.riskCategory).toBe("network");

      const approval = pending.approvals[0];
      if (!approval) throw new Error("expected approval");
      const completed = await workbench.decideApproval(pending.id, approval.id, "allow_once");

      expect(completed.status).toBe("completed");
      expect(completed.events.some((event) => String(event.payload["output"] ?? "").includes("http:from-http"))).toBe(true);
      await registry.disconnectServer("http_mock");
    } finally {
      await mock.close();
    }
  });

  it("detects skill conflicts without auto-merging them", () => {
    const first = promoteExperience({
      id: "experience_a",
      taskId: "task_a",
      title: "host process audit",
      goal: "host process audit",
      body: "Use command evidence.",
      readOnly: true,
      toolsUsed: [],
      result: "ok",
      assessment: { goalAchieved: true, confidence: 0.9, issues: [], learnings: [], suggestedPatterns: [] },
      meta: { outcome: "success", complexity: "simple", domains: ["host"], tools: ["run_command"], hasSideEffects: false, duration: 1 },
      reflectionCount: 0,
      reflectionStatus: "pending",
      createdAt: nowIso()
    });
    const second = {
      ...first,
      id: "skill_b",
      title: "host process audit via MCP",
      applicability: { ...first.applicability, keywords: ["host", "process", "audit", "mcp"], requiredTools: ["mcp__mock__echo"] }
    };
    const conflicts = detectSkillConflicts(
      { ...first, id: "skill_a", applicability: { ...first.applicability, keywords: ["host", "process", "audit"], requiredTools: ["run_command"] } },
      [second]
    );
    expect(conflicts[0]?.status).toBe("open");
  });
});

describe("ShellToolExecutor", () => {
  it("runs a harmless command", async () => {
    const executor = new ShellToolExecutor();
    const result = await executor.execute({
      id: createId("tool_call"),
      toolName: "run_command",
      args: { command: "Write-Output ok" }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
  });

  it("requires expectedHash before editing existing files", async () => {
    const temp = mkdtempSync(join(process.cwd(), "tmp-scc-tools-"));
    try {
      const file = join(temp, "note.txt");
      writeFileSync(file, "before");
      const executor = new ShellToolExecutor();
      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: file,
          edits: [{ startLine: 1, endLine: 1, newText: "after" }]
        }
      });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Missing expectedHash");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("OpenAI provider config", () => {
  it("loads apiKey and baseURL from the same API key document section", () => {
    const temp = mkdtempSync(join(tmpdir(), "scc-apikey-"));
    const filePath = join(temp, "dont_touch_(APIKEY).md");
    const previous = {
      apiKey: process.env["OPENAI_API_KEY"],
      baseUrl: process.env["OPENAI_BASE_URL"],
      baseurl: process.env["OPENAI_BASEURL"],
      sccBaseUrl: process.env["SCC_OPENAI_BASE_URL"],
      model: process.env["SCC_MODEL"],
      openAiModel: process.env["OPENAI_MODEL"],
      provider: process.env["SCC_API_PROVIDER"],
      openAiProvider: process.env["OPENAI_PROVIDER"]
    };

    try {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["OPENAI_BASE_URL"];
      delete process.env["OPENAI_BASEURL"];
      delete process.env["SCC_OPENAI_BASE_URL"];
      delete process.env["SCC_MODEL"];
      delete process.env["OPENAI_MODEL"];
      delete process.env["SCC_API_PROVIDER"];
      delete process.env["OPENAI_PROVIDER"];

      writeFileSync(
        filePath,
        [
          "SCNet",
          "baseUrl: https://scnet.example/v1",
          "apiKey: sk-live-example=",
          "---",
          "xiaomi (mimo)",
          "apiKey: deleted-key （deleted）",
          "baseUrl: https://mimo.example/v1",
          "canonicalLiveModel: mimo-v2.5",
          "tokenPlanApiKey: tp-live-example",
          "baseUrl: https://token-plan.example/v1"
        ].join("\n")
      );

      expect(loadOpenAiConfig(filePath)).toEqual({
        apiKey: "tp-live-example",
        baseURL: "https://token-plan.example/v1",
        model: "mimo-v2.5"
      });
      expect(loadOpenAiProviderConfig(filePath)).toEqual({
        apiKey: "tp-live-example",
        baseURL: "https://token-plan.example/v1",
        model: "mimo-v2.5",
        providerName: "xiaomi (mimo)"
      });

      process.env["SCC_API_PROVIDER"] = "SCNet";
      expect(loadOpenAiConfig(filePath)).toEqual({
        apiKey: "sk-live-example=",
        baseURL: "https://scnet.example/v1"
      });
    } finally {
      restoreEnv("OPENAI_API_KEY", previous.apiKey);
      restoreEnv("OPENAI_BASE_URL", previous.baseUrl);
      restoreEnv("OPENAI_BASEURL", previous.baseurl);
      restoreEnv("SCC_OPENAI_BASE_URL", previous.sccBaseUrl);
      restoreEnv("SCC_MODEL", previous.model);
      restoreEnv("OPENAI_MODEL", previous.openAiModel);
      restoreEnv("SCC_API_PROVIDER", previous.provider);
      restoreEnv("OPENAI_PROVIDER", previous.openAiProvider);
      rmSync(temp, { recursive: true, force: true });
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

async function startMockHttpMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(async (request, response) => {
    const mcpServer = createMockHttpMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    await mcpServer.connect(transport as never);
    response.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}

function createMockHttpMcpServer(): McpServer {
  const mcpServer = new McpServer({ name: "mock-http-mcp", version: "1.0.0" });
  mcpServer.registerTool(
    "echo",
    {
      description: "Echo text over streamable HTTP.",
      inputSchema: { text: z.string().optional() },
      annotations: { openWorldHint: true }
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `http:${text ?? ""}` }]
    })
  );
  return mcpServer;
}

function mockMcpServerSource(): string {
  return `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "mock-mcp", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo input text.",
    inputSchema: { text: z.string().optional() },
    annotations: { readOnlyHint: true }
  },
  async ({ text }) => ({
    content: [{ type: "text", text: "echo:" + (text ?? "") }]
  })
);
await server.connect(new StdioServerTransport());
`;
}
