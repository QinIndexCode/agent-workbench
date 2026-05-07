import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  KnowledgeSearchToolExecutor,
  McpRegistry,
  WebSearchToolExecutor,
  type ModelClient,
  type ModelStreamHandlers,
  type ModelTurn,
  PermissionEngine,
  buildHistoryLayer,
  detectSkillConflicts,
  createExperience,
  createId,
  loadOpenAiConfig,
  loadOpenAiProviderConfig,
  nowIso,
  promoteExperience,
  shouldPromoteExperienceToSkill
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

  it("keeps the latest user message when a long history is truncated", () => {
    const task: TaskDetail = {
      id: "task_long_history",
      title: "Long history",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_old",
          taskId: "task_long_history",
          type: "assistant_message",
          createdAt: nowIso(),
          summary: "old context ".repeat(200),
          payload: {}
        },
        {
          id: "event_latest",
          taskId: "task_long_history",
          type: "user_message",
          createdAt: nowIso(),
          summary: "LATEST_USER_MARKER " + "important current request ".repeat(120),
          payload: {}
        }
      ]
    };

    const history = buildHistoryLayer(task, 80);

    expect(history).toContain("LATEST_USER_MARKER");
    expect(history).toContain("latest event truncated");
    expect(history).toContain("earlier events omitted");
  });

  it("creates an auditable summary pack instead of only dropping old context", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      id: "task_summary",
      title: "Long task",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: Array.from({ length: 36 }, (_, index) => ({
        id: `event_${index}`,
        taskId: "task_summary",
        type: (index % 3 === 0 ? "tool_result" : index % 3 === 1 ? "assistant_message" : "user_message") as const,
        createdAt: nowIso(),
        summary: index === 35 ? "LATEST_DECISION_MARKER keep this detail" : `older event ${index}`,
        payload: index % 3 === 0 ? { toolName: "read_file", ok: true } : {}
      }))
    };

    const context = await assembler.assemble(task);
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summary).toContain("older event");
    expect(context.input).toContain("Conversation Summary");
    expect(context.input).toContain("LATEST_DECISION_MARKER");
  });

  it("keeps assembled context inside a strict low token budget", async () => {
    const store = new InMemoryWorkbenchStore();
    const preferences = await store.getPreferences();
    await store.savePreferences({ ...preferences, maxTokensPerRequest: 900, updatedAt: nowIso() });
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      id: "task_budget",
      title: "Budget task",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: Array.from({ length: 48 }, (_, index) => ({
        id: `event_budget_${index}`,
        taskId: "task_budget",
        type: (index % 2 === 0 ? "tool_result" : "assistant_message") as const,
        createdAt: nowIso(),
        summary: index === 47 ? "LATEST_BUDGET_MARKER" : `large event ${index} ${"payload ".repeat(220)}`,
        payload: index % 2 === 0 ? { toolName: "read_file", ok: true, output: "file content ".repeat(300) } : {}
      }))
    };

    const context = await assembler.assemble(task);

    expect(context.usedTokens).toBeLessThanOrEqual(900);
    expect(context.input).toContain("Context Budget Notice");
    expect(context.input).toContain("LATEST_BUDGET_MARKER");
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

class UsageModel implements ModelClient {
  async next(): Promise<ModelTurn> {
    return {
      kind: "final",
      message: "Provider usage recorded.",
      usage: {
        inputTokens: 1000,
        outputTokens: 80,
        cachedTokens: 400,
        raw: { prompt_tokens: 1000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 400 } }
      }
    };
  }
}

class CancellableStreamingModel implements ModelClient {
  aborted = false;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    await stream?.onAssistantDelta("started");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      stream?.signal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    if (stream?.signal?.aborted) return { kind: "final", message: "This final message should not be recorded." };
    await stream?.onAssistantDelta("late");
    return { kind: "final", message: "late final" };
  }
}

class OverflowOnceModel implements ModelClient {
  calls = 0;

  async next(): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("400 context length exceeded: too many tokens in the prompt");
    return { kind: "final", message: "Recovered after compaction." };
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
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

  it("compacts and retries once after a model context overflow", async () => {
    const model = new OverflowOnceModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });

    const completed = await workbench.createTask("continue a very long conversation");

    expect(model.calls).toBe(2);
    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "context_overflow_recovered")).toBe(true);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("Recovered"))).toBe(true);
  });

  it("pauses an in-flight model stream without recording a final answer", async () => {
    const model = new CancellableStreamingModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const started = await workbench.startTask("stream until I stop it", "Streaming pause");
    await waitFor(async () => Boolean((await workbench.getTask(started.id))?.events.some((event) => event.type === "assistant_delta")));

    const paused = await workbench.control(started.id, "pause");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const persisted = await workbench.getTask(started.id);

    expect(model.aborted).toBe(true);
    expect(paused.status).toBe("paused");
    expect(persisted?.status).toBe("paused");
    expect(persisted?.events.some((event) => event.type === "assistant_message")).toBe(false);
    expect(persisted?.events.filter((event) => event.type === "assistant_delta").map((event) => event.summary).join("")).toBe("started");
  });

  it("copies uploaded attachments, links them to tasks, and exposes them to context as references", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const workbench = new AgentWorkbench({ store, contextAssembler: assembler, model: new StreamingFinalModel() });
    const uploaded = await workbench.uploadTaskAttachment({
      fileName: "notes.md",
      mimeType: "text/markdown",
      size: Buffer.byteLength("# Notes\nImportant fixture content."),
      dataBase64: Buffer.from("# Notes\nImportant fixture content.").toString("base64")
    });

    const task = await workbench.createTask("summarize attached notes", "Summarize notes", undefined, [uploaded.id]);
    const linked = await workbench.listTaskAttachments(task.id);
    const context = await assembler.assemble(task);

    expect(linked).toHaveLength(1);
    expect(linked[0]?.taskId).toBe(task.id);
    expect(existsSync(uploaded.storagePath)).toBe(true);
    expect(task.events.some((event) => event.type === "attachment_added")).toBe(true);
    expect(context.input).toContain("notes.md (markdown");
    expect(context.input).toContain("Important fixture content");
  });

  it("runs due scheduled tasks through the normal task pipeline", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
    const scheduled = await workbench.createScheduledTask({
      title: "Daily note",
      prompt: "summarize today's project state",
      folderId: "default",
      scheduleKind: "interval",
      intervalHours: 0,
      intervalMinutes: 1
    });
    await store.saveScheduledTask({ ...scheduled, nextRunAt: new Date(Date.now() - 60_000).toISOString() });

    const changed = await workbench.runDueScheduledTasks(new Date());
    const tasks = await workbench.listTasks();

    expect(changed[0]?.id).toBe(scheduled.id);
    expect(changed[0]?.status).toBe("active");
    expect(new Date(changed[0]?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(tasks.some((task) => task.title === "Daily note")).toBe(true);
    expect(tasks.find((task) => task.title === "Daily note")?.events.some((event) => event.type === "scheduled_task_created")).toBe(true);
  });

  it("executes web_search through permission grants and records search evidence", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            { title: "SCC docs", url: `http://example.test${request.url ?? ""}`, snippet: "Workbench documentation" },
            { title: "Agent tools", url: "http://example.test/tools", snippet: "Tool evidence model" }
          ]
        })
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({
        store,
        tools: new CompositeToolExecutor(new StubToolExecutor(), [new WebSearchToolExecutor(store)]),
        model: new SingleToolModel("web_search", { query: "scc workbench", limit: 2 })
      });
      await workbench.createWebSearchProvider({
        label: "Local search",
        kind: "custom",
        endpoint: `http://127.0.0.1:${port}/search?q={query}&limit={limit}`,
        enabled: true
      });
      await workbench.grantGlobalPermission("network", "search smoke");

      const completed = await workbench.createTask("search current docs");
      const searchEvent = completed.events.find((event) => event.type === "web_search_result");

      expect(completed.status).toBe("completed");
      expect(searchEvent?.summary).toBe("Search evidence returned");
      expect(JSON.stringify(searchEvent?.payload)).toContain("SCC docs");
      expect(completed.events.some((event) => event.type === "approval_auto_granted" && event.payload["riskCategory"] === "network")).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("indexes knowledge locally and exposes knowledge_search as workspace-read evidence", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({
      store,
      tools: new CompositeToolExecutor(new StubToolExecutor(), [new KnowledgeSearchToolExecutor(store)]),
      model: new SingleToolModel("knowledge_search", { query: "approval policy", limit: 2 })
    });
    const item = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Approval notes",
      content: "SCC should ask before risky tools and reuse task grants after approval.",
      tags: ["permissions"]
    });
    const search = await workbench.searchKnowledge({ query: "risky approval grants", projectId: "default", limit: 2 });
    await workbench.grantGlobalPermission("workspace_read", "knowledge search smoke");
    const completed = await workbench.createTask("search stored approval policy");

    expect(item.indexStatus).toBe("indexed");
    expect(item.chunkCount).toBeGreaterThan(0);
    expect(search[0]?.item.id).toBe(item.id);
    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "tool_result" && String(event.payload["output"] ?? "").includes("Approval notes"))).toBe(true);
    expect(search[0]?.citation?.title).toBe("Approval notes");
    expect(search[0]?.citation?.excerpt).toContain("ask before risky tools");
  });

  it("creates checkpoints before edits and can roll back task file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-checkpoint-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "note.txt");
      writeFileSync(filePath, "before\n", "utf8");
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SingleToolModel("edit_file", {
          path: "src/note.txt",
          expectedHash: "9160d4be34c8695b",
          edits: [{ startLine: 1, endLine: 1, newText: "after" }]
        }),
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "Checkpoint root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "checkpoint test");

      const completed = await workbench.createTask("edit note", "Edit note", folder.id);
      const checkpoints = await workbench.listTaskCheckpoints(completed.id);

      expect(completed.events.some((event) => event.type === "task_checkpoint_created")).toBe(true);
      expect(checkpoints).toHaveLength(1);
      expect(readFileSync(filePath, "utf8")).toBe("after\n");

      const rolledBack = await workbench.rollbackTask(completed.id);
      expect(rolledBack.restoredFiles).toBe(1);
      expect(readFileSync(filePath, "utf8")).toBe("before\n");
      expect((await workbench.getTask(completed.id))?.events.some((event) => event.type === "task_rollback_completed")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs scheduled reflection and records the result without creating a normal task", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
    await workbench.ensureDefaultScheduledTasks();
    const reflection = (await workbench.listScheduledTasks()).find((task) => task.type === "reflection");
    if (!reflection) throw new Error("expected default reflection schedule");
    await store.saveScheduledTask({ ...reflection, nextRunAt: new Date(Date.now() - 60_000).toISOString() });

    const changed = await workbench.runDueScheduledTasks(new Date());

    expect(changed[0]?.type).toBe("reflection");
    expect(changed[0]?.lastRunSummary).toContain("Reflection");
    expect(await workbench.listReflectionSessions()).toHaveLength(1);
    expect(await workbench.listTasks()).toHaveLength(0);
  });

  it("records integration messages as normal task events", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const integration = await workbench.createIntegrationProvider({
      kind: "discord",
      label: "Discord Test",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });

    const completed = await workbench.handleDiscordInteraction({
      integrationId: integration.id,
      channelId: "channel_1",
      messageId: "message_1",
      userId: "user_1",
      text: "Summarize this from Discord"
    });

    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "integration_message_received")).toBe(true);
    expect(await workbench.listIntegrationProviders()).toHaveLength(1);
  });

  it("records prompt cache statistics after model turns", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const first = await workbench.createTask("record cache baseline");
    const second = await workbench.appendMessage(first.id, "continue with another turn");
    const stats = await workbench.listPromptCacheStats(second.id);

    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(stats[0]?.inputTokens).toBeGreaterThan(0);
    expect(second.events.some((event) => event.type === "prompt_cache_stats")).toBe(true);
  });

  it("records provider sourced prompt cache usage when the model returns token metadata", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new UsageModel() });
    const task = await workbench.createTask("record provider cache usage");
    const stats = await workbench.listPromptCacheStats(task.id);

    expect(stats[0]?.source).toBe("provider");
    expect(stats[0]?.inputTokens).toBe(1000);
    expect(stats[0]?.cachedTokens).toBe(400);
    expect(stats[0]?.cacheHitRatio).toBe(0.4);
  });

  it("snapshots the selected local folder root when a task is created", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "scc-work-root-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "scc-work-root-b-"));
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
      const folder = await workbench.createTaskFolder({ name: "External project", rootPath: firstRoot });
      const task = await workbench.createTask("inspect this local folder", "Inspect folder", folder.id);

      expect(task.folderId).toBe(folder.id);
      expect(task.workRoot).toBe(resolve(firstRoot));

      await workbench.updateTaskFolder(folder.id, { rootPath: secondRoot });
      const persisted = await workbench.getTask(task.id);
      expect(persisted?.folderId).toBe(folder.id);
      expect(persisted?.workRoot).toBe(resolve(firstRoot));
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("edits task title and folder without changing the work root snapshot", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "scc-task-edit-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "scc-task-edit-b-"));
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
      const firstFolder = await workbench.createTaskFolder({ name: "Project A", rootPath: firstRoot });
      const secondFolder = await workbench.createTaskFolder({ name: "Project B", rootPath: secondRoot });
      const task = await workbench.createTask("inspect project", "Inspect project", firstFolder.id);

      const updated = await workbench.updateTask(task.id, { title: "Renamed inspection", folderId: secondFolder.id });

      expect(updated.title).toBe("Renamed inspection");
      expect(updated.folderId).toBe(secondFolder.id);
      expect(updated.workRoot).toBe(resolve(firstRoot));
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("deletes a task folder and its tasks without touching other folders", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "scc-folder-delete-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "scc-folder-delete-b-"));
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
      const firstFolder = await workbench.createTaskFolder({ name: "Delete me", rootPath: firstRoot });
      const secondFolder = await workbench.createTaskFolder({ name: "Keep me", rootPath: secondRoot });
      const deletedTask = await workbench.createTask("delete scoped task", "Delete scoped", firstFolder.id);
      const keptTask = await workbench.createTask("keep scoped task", "Keep scoped", secondFolder.id);

      const result = await workbench.deleteTaskFolder(firstFolder.id, { deleteLearningData: false, deleteDerivedSkills: false });

      expect(result.deletedFolder).toBe(true);
      expect(result.deletedTasks).toBe(1);
      expect(await workbench.getTask(deletedTask.id)).toBeUndefined();
      expect(await workbench.getTask(keptTask.id)).toBeDefined();
      expect((await workbench.listTaskFolders()).some((folder) => folder.id === firstFolder.id)).toBe(false);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("refuses to delete the default task folder", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    await expect(workbench.deleteTaskFolder("default")).rejects.toThrow("Default folder cannot be deleted");
  });

  it("continues a completed task instead of creating a separate context", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const completed = await workbench.createTask("first request");

    const continued = await workbench.appendMessage(completed.id, "follow up in the same task");

    expect(continued.id).toBe(completed.id);
    expect(continued.status).toBe("completed");
    expect(continued.events.filter((event) => event.type === "user_message").map((event) => event.summary)).toEqual([
      "first request",
      "follow up in the same task"
    ]);
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
    await workbench.createSkill({
      title: "Derived host process review",
      body: "# Derived host process review\nUse fresh host-observation evidence and summarize current CPU and memory usage.",
      status: "candidate",
      sourceMemoryIds: [experience.id],
      applicability: {
        keywords: ["process", "software"],
        requiredTools: ["run_command"],
        requiredContext: ["host_observation"]
      }
    });

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

  it("rejects one-off experience promotion and keeps generated skill bodies reusable", async () => {
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
    await store.saveExperience(first);

    await expect(workbench.promoteExperience(first.id)).rejects.toThrow(/not eligible/);
    expect(await workbench.listSkills()).toHaveLength(0);

    const generated = promoteExperience({
      ...first,
      assessment: { ...first.assessment, confidence: 0.95, suggestedPatterns: ["host_observation"] },
      toolsUsed: [
        ...first.toolsUsed,
        { toolName: "list_files", args: {}, result: "files", riskCategory: "workspace_read" }
      ],
      meta: { ...first.meta, complexity: "medium", tools: ["run_command", "list_files"] }
    });
    expect(generated.body).toContain("Reusable approach");
    expect(generated.body).toContain("Run the tools against the current task state");
    expect(generated.body).not.toContain("Top process: node");
    expect(generated.body).not.toContain("Result:");
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

  it("keeps side-effect experience promotions ineligible and candidate-only", () => {
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
    expect(shouldPromoteExperienceToSkill(experience)).toBe(false);
    expect(promoteExperience(experience).status).toBe("candidate");
    expect(promoteExperience(experience).body).not.toContain("done");
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

  it("executes file tools relative to the task work root and rejects path escapes", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-tool-work-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "scc-tool-outside-"));
    try {
      writeFileSync(join(workRoot, "inside.txt"), "inside");
      writeFileSync(join(outsideRoot, "outside.txt"), "outside");
      const executor = new ShellToolExecutor();

      const listed = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "list_files",
          args: { path: "." }
        },
        { workRoot }
      );
      expect(listed.ok).toBe(true);
      expect(listed.output).toContain("inside.txt");

      const read = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "read_file",
          args: { path: "inside.txt" }
        },
        { workRoot }
      );
      expect(read.ok).toBe(true);
      expect(read.output).toContain("inside");

      const escaped = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "read_file",
          args: { path: join(outsideRoot, "outside.txt") }
        },
        { workRoot }
      );
      expect(escaped.ok).toBe(false);
      expect(escaped.output).toContain("outside the workspace");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("runs commands in the task work root by default", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-command-work-root-"));
    try {
      const executor = new ShellToolExecutor();
      const result = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "run_command",
          args: { command: process.platform === "win32" ? "(Get-Location).Path" : "pwd" }
        },
        { workRoot }
      );

      expect(result.ok).toBe(true);
      expect(result.output.toLowerCase()).toContain(resolve(workRoot).toLowerCase());
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
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
