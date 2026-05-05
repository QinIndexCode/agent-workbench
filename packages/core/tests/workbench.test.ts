import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResult } from "@scc/shared";
import { ShellToolExecutor } from "../src/tools.js";
import {
  AgentWorkbench,
  CompositeToolExecutor,
  ConfiguredToolModelClient,
  InMemoryWorkbenchStore,
  McpRegistry,
  type ModelClient,
  type ModelTurn,
  PermissionEngine,
  detectSkillConflicts,
  createExperience,
  createId,
  loadOpenAiConfig,
  nowIso,
  promoteExperience
} from "../src/index.js";

const hostObservationModel = new ConfiguredToolModelClient("Get-Process | Sort-Object CPU");

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

  it("records read-only experience as an enabled skill", async () => {
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
    expect(skills[0]?.status).toBe("active");
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
      applicability: { ...first.applicability, keywords: ["host", "process", "audit"], requiredTools: ["mcp__mock__echo"] }
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
