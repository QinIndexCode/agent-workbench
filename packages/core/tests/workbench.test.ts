import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { describe, expect, it } from "vitest";
import type { RiskCategory, TaskDetail, ToolCall, ToolResult } from "@scc/shared";
import { ShellToolExecutor } from "../src/tools.js";
import {
  AgentWorkbench,
  CompositeToolExecutor,
  ConfiguredToolModelClient,
  ContextAssembler,
  InMemoryWorkbenchStore,
  KnowledgeSearchToolExecutor,
  McpRegistry,
  OpenAIModelClient,
  WebSearchToolExecutor,
  type ModelClient,
  type ModelStreamHandlers,
  type ModelTurn,
  PermissionEngine,
  buildHistoryLayer,
  createLocalTaskTitle,
  detectSkillConflicts,
  createExperience,
  createId,
  loadOpenAiConfig,
  loadOpenAiProviderConfig,
  nowIso,
  promoteExperience,
  selectModelToolsForTask,
  compileTaskGraph,
  taskGraphFromEvents,
  shouldPromoteExperienceToSkill
} from "../src/index.js";
import { defaultTaskWorkRoot } from "../src/workspace-root.js";

const hostObservationModel = new ConfiguredToolModelClient("Get-Process | Sort-Object CPU");

function attachCompiledTaskGraph(task: TaskDetail): ReturnType<typeof compileTaskGraph> {
  const graph = compileTaskGraph(task);
  if (!graph) return null;
  const activeNode = graph.nodes.find((node) => node.id === graph.activeNodeId);
  task.events.push({
    id: createId("event"),
    taskId: task.id,
    type: "task_graph_created",
    createdAt: nowIso(),
    summary: "Task graph created",
    payload: { graph }
  });
  if (activeNode) {
    task.events.push({
      id: createId("event"),
      taskId: task.id,
      type: "task_graph_node_started",
      createdAt: nowIso(),
      summary: `${activeNode.role}: ${activeNode.objective}`,
      payload: { nodeId: activeNode.id, role: activeNode.role, objective: activeNode.objective }
    });
  }
  return graph;
}

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

  it("does not keep a trivial greeting as the original goal after a later real request", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      id: "task_greeting_followup",
      title: "Greeting follow-up",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_hello", taskId: "task_greeting_followup", type: "user_message", createdAt: nowIso(), summary: "你好", payload: {} },
        { id: "event_agent", taskId: "task_greeting_followup", type: "assistant_message", createdAt: nowIso(), summary: "你好！有什么可以帮你的？", payload: {} },
        { id: "event_request", taskId: "task_greeting_followup", type: "user_message", createdAt: nowIso(), summary: "测试所有你能调用的工具", payload: {} }
      ]
    };

    const context = await assembler.assemble(task);

    expect(context.input).toContain("## Current Turn");
    expect(context.input).toContain("测试所有你能调用的工具");
    expect(context.input).not.toContain("Original user goal: 你好");
    expect(`${context.systemPrompt}\n${context.input}`).not.toContain("Task title:");
    expect(context.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    const latest = context.messages.at(-1);
    expect(latest?.role).toBe("user");
    expect(latest && "content" in latest ? latest.content : "").toContain("测试所有你能调用的工具");
  });

  it("adds the active task graph node as an attention packet without using the task title as context", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      id: "task_attention_graph",
      title: "你好",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_hello", taskId: "task_attention_graph", type: "user_message", createdAt: nowIso(), summary: "你好", payload: {} },
        { id: "event_agent", taskId: "task_attention_graph", type: "assistant_message", createdAt: nowIso(), summary: "你好！有什么可以帮你的？", payload: {} },
        {
          id: "event_request",
          taskId: "task_attention_graph",
          type: "user_message",
          createdAt: nowIso(),
          summary: "帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑",
          payload: {}
        }
      ]
    };
    const graph = attachCompiledTaskGraph(task);

    const context = await assembler.assemble(task);
    const latest = context.messages.at(-1);

    expect(graph?.nodes.some((node) => node.role === "implement")).toBe(true);
    expect(context.systemPrompt).toContain("## Task Graph");
    expect(`${context.systemPrompt}\n${context.input}`).not.toContain("Task title: 你好");
    expect(context.attentionPacket.activeNode?.role).toBe("implement");
    expect(latest?.role).toBe("user");
    expect(latest && "content" in latest ? latest.content : "").toContain("## Active Node");
    expect(latest && "content" in latest ? latest.content : "").toContain("编写一个完整的博客页面");
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

  it("does not compact short conversations just because internal planning changed", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      id: "task_short_context",
      title: "Short task",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user", taskId: "task_short_context", type: "user_message", createdAt: nowIso(), summary: "Check the current context injection.", payload: {} },
        ...Array.from({ length: 18 }, (_, index) => ({
          id: `event_plan_${index}`,
          taskId: "task_short_context",
          type: "plan_revised" as const,
          createdAt: nowIso(),
          summary: `Plan refresh ${index}`,
          payload: { status: "running", steps: [{ title: "test", status: "running" }] }
        }))
      ]
    };

    const context = await assembler.assemble(task);
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(0);
    expect(context.input).not.toContain("Conversation Summary");
  });

  it("keeps UI-hidden tool results in model history while hiding visible plan events", () => {
    const task: TaskDetail = {
      id: "task_plan_context",
      title: "Plan context",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user", taskId: "task_plan_context", type: "user_message", createdAt: nowIso(), summary: "继续优化任务界面", payload: {} },
        {
          id: "event_plan_tool",
          taskId: "task_plan_context",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Plan updated",
          payload: { toolName: "plan_update", uiHidden: true, output: JSON.stringify({ action: "plan_updated", stepCount: 4 }) }
        },
        {
          id: "event_hidden_tool",
          taskId: "task_plan_context",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Hidden utility completed",
          payload: { toolName: "hidden_utility", uiHidden: true, output: "hidden utility evidence" }
        },
        {
          id: "event_plan_revised",
          taskId: "task_plan_context",
          type: "plan_revised",
          createdAt: nowIso(),
          summary: "侧边栏计划已更新",
          payload: { status: "running", steps: [{ title: "检查", status: "running" }] }
        },
        { id: "event_answer", taskId: "task_plan_context", type: "assistant_message", createdAt: nowIso(), summary: "我会继续检查。", payload: {} }
      ]
    };

    const history = buildHistoryLayer(task, 2000);

    expect(history).toContain("继续优化任务界面");
    expect(history).toContain("我会继续检查");
    expect(history).toContain("Tool Result plan_update");
    expect(history).toContain("plan_updated");
    expect(history).toContain("Tool Result hidden_utility");
    expect(history).toContain("hidden utility evidence");
    expect(history).not.toContain("侧边栏计划已更新");
    expect(history).not.toContain("Plan Panel");
  });

  it("keeps read_file content in Known Files instead of duplicating it in history", () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const content = "UNIQUE_READ_FILE_CONTENT";
    const task: TaskDetail = {
      id: "task_file_dedupe",
      title: "File dedupe",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_read",
          taskId: "task_file_dedupe",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "read_file",
            ok: true,
            output: JSON.stringify({ path: "src/example.ts", content, hash: "hash_1", partial: false })
          }
        }
      ]
    };
    const tracker = assembler.getFileStateTracker(task.id);
    tracker.updateFromToolResult(task.events[0]!);

    const history = buildHistoryLayer(task, 4000, tracker);
    const knownFiles = tracker.buildFileStateTable();
    const combined = `${knownFiles}\n${history}`;

    expect(knownFiles).toContain(content);
    expect(history).toContain("content recorded in Known Files");
    expect(history).not.toContain(content);
    expect(combined.match(/UNIQUE_READ_FILE_CONTENT/g)).toHaveLength(1);
  });

  it("rebuilds tool calls and results as role messages for the next model turn", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      id: "task_tool_roles",
      title: "你好",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user", taskId: "task_tool_roles", type: "user_message", createdAt: nowIso(), summary: "检查并修复上下文", payload: {} },
        {
          id: "event_request_1",
          taskId: "task_tool_roles",
          type: "tool_requested",
          createdAt: nowIso(),
          summary: "list_files",
          payload: { toolCallId: "call_1", toolName: "list_files", args: { path: "." } }
        },
        {
          id: "event_request_2",
          taskId: "task_tool_roles",
          type: "tool_requested",
          createdAt: nowIso(),
          summary: "read_file",
          payload: { toolCallId: "call_2", toolName: "read_file", args: { path: "src/a.ts" } }
        },
        {
          id: "event_result_1",
          taskId: "task_tool_roles",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: { toolCallId: "call_1", toolName: "list_files", args: { path: "." }, ok: true, output: "[]" }
        },
        {
          id: "event_result_2",
          taskId: "task_tool_roles",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool failed",
          payload: { toolCallId: "call_2", toolName: "read_file", args: { path: "src/a.ts" }, ok: false, output: "Tool request denied by user." }
        },
        {
          id: "event_plan_result",
          taskId: "task_tool_roles",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Plan updated",
          payload: { toolCallId: "call_plan", toolName: "plan_update", args: { status: "running" }, ok: true, uiHidden: true, output: "{\"action\":\"plan_updated\"}" }
        }
      ]
    };

    const context = await assembler.assemble(task);
    const roleMessages = context.messages.filter((message) => message.role !== "system");

    expect(roleMessages[0]?.role).toBe("user");
    expect(roleMessages[1]?.role).toBe("assistant");
    expect(roleMessages[1]?.role === "assistant" ? roleMessages[1].toolCalls?.map((call) => call.id) : []).toEqual(["call_1", "call_2"]);
    expect(roleMessages[2]?.role).toBe("tool");
    expect(roleMessages[3]?.role).toBe("tool");
    expect(roleMessages[3]?.role === "tool" ? roleMessages[3].content : "").toContain("\"status\":\"denied\"");
    expect(roleMessages[4]?.role).toBe("assistant");
    expect(roleMessages[4]?.role === "assistant" ? roleMessages[4].toolCalls?.[0]?.toolName : "").toBe("plan_update");
    expect(roleMessages[5]?.role).toBe("tool");
    expect(roleMessages[5]?.role === "tool" ? roleMessages[5].content : "").toContain("plan_updated");
  });

  it("keeps read_file role results compact when file content is already in Known Files", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const content = "ROLE_READ_FILE_CONTENT";
    const task: TaskDetail = {
      id: "task_file_role_dedupe",
      title: "File role dedupe",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_read",
          taskId: "task_file_role_dedupe",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolCallId: "call_read",
            toolName: "read_file",
            args: { path: "src/example.ts" },
            ok: true,
            output: JSON.stringify({ path: "src/example.ts", content, hash: "hash_1", partial: false })
          }
        }
      ]
    };
    assembler.getFileStateTracker(task.id).updateFromToolResult(task.events[0]!);

    const context = await assembler.assemble(task);
    const toolMessage = context.messages.find((message) => message.role === "tool");

    expect(context.systemPrompt).toContain(content);
    expect(toolMessage?.role).toBe("tool");
    expect(toolMessage?.role === "tool" ? toolMessage.content : "").toContain("Known Files");
    expect(toolMessage?.role === "tool" ? toolMessage.content : "").not.toContain(content);
  });

  it("does not compact ordinary small messages by event count alone", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      id: "task_many_small_events",
      title: "Many small turns",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: Array.from({ length: 90 }, (_, index) => ({
        id: `event_small_${index}`,
        taskId: "task_many_small_events",
        type: (index % 2 === 0 ? "user_message" : "assistant_message") as const,
        createdAt: nowIso(),
        summary: `small message ${index}`,
        payload: {}
      }))
    };

    const context = await assembler.assemble(task);
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(0);
    expect(context.input).not.toContain("Conversation Summary");
    expect(context.input).toContain("small message 89");
  });

  it("creates an auditable summary pack instead of only dropping old context", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const longConstraint = "persist the user goal, current file decisions, latest plan state, and tool evidence references. ".repeat(8);
    const task: TaskDetail = {
      id: "task_summary",
      title: "Long task",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: Array.from({ length: 180 }, (_, index) => ({
        id: `event_${index}`,
        taskId: "task_summary",
        type: (index % 3 === 0 ? "tool_result" : index % 3 === 1 ? "assistant_message" : "user_message") as const,
        createdAt: nowIso(),
        summary: index === 179 ? "LATEST_DECISION_MARKER keep this detail" : `older event ${index} ${longConstraint}`,
        payload: index % 3 === 0 ? { toolName: "read_file", ok: true, args: { path: `src/file-${index}.ts` } } : {}
      }))
    };

    const context = await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summary).toContain("older event");
    expect(context.systemPrompt).toContain("Conversation Summary");
    expect(context.systemPrompt).toContain("Active Task Continuity");
    expect(context.input).toContain("## Current Turn");
    expect(context.input).not.toContain("Original user goal");
    expect(context.input).toContain("LATEST_DECISION_MARKER");
  });

  it("summarizes large tool payloads as references instead of copying raw edit output", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const hugePatch = "UI preview truncated should never be copied into model summary. ".repeat(420);
    const task: TaskDetail = {
      id: "task_large_tool_summary",
      title: "Large tool summary",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_goal",
          taskId: "task_large_tool_summary",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Maintain the generated blog page without losing the theme requirement.",
          payload: {}
        },
        ...Array.from({ length: 70 }, (_, index) => ({
          id: `event_tool_${index}`,
          taskId: "task_large_tool_summary",
          type: "tool_result" as const,
          createdAt: nowIso(),
          summary: `edit_file result ${index}`,
          payload: {
            toolName: "edit_file",
            ok: true,
            args: { path: "styles.css", edits: [{ startLine: 1, endLine: 1, newText: hugePatch }] },
            output: JSON.stringify({ path: "styles.css", summary: "File edited", diff: hugePatch })
          }
        })),
        {
          id: "event_latest_user",
          taskId: "task_large_tool_summary",
          type: "user_message",
          createdAt: nowIso(),
          summary: "LATEST_THEME_REQUIREMENT verify the dark/light theme switch before final summary.",
          payload: {}
        }
      ]
    };

    const context = await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summary).not.toContain("UI preview truncated");
    expect(summaries[0]?.summary).not.toContain(hugePatch.slice(0, 200));
    expect(summaries[0]?.retainedFacts.join("\n")).toContain("Earlier tool evidence refs");
    expect(context.input).toContain("LATEST_THEME_REQUIREMENT");
  });

  it("keeps assembled context inside a strict low token budget", async () => {
    const store = new InMemoryWorkbenchStore();
    const preferences = await store.getPreferences();
    await store.savePreferences({ ...preferences, maxTokensPerRequest: 10000, updatedAt: nowIso() });
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

    expect(context.usedTokens).toBeLessThanOrEqual(10000);
    expect(context.input).toContain("LATEST_BUDGET_MARKER");
  });

  it("injects full global and project memory files before task history", async () => {
    const previousMemoryDir = process.env["SCC_MEMORY_DIR"];
    const memoryDir = mkdtempSync(join(tmpdir(), "scc-context-memory-"));
    const workRoot = mkdtempSync(join(tmpdir(), "scc-context-work-root-"));
    process.env["SCC_MEMORY_DIR"] = memoryDir;
    try {
      const projectHash = createHash("sha256").update(resolve(workRoot)).digest("hex").slice(0, 20);
      mkdirSync(join(memoryDir, "projects", projectHash), { recursive: true });
      writeFileSync(join(memoryDir, "USER.md"), "# USER.md\n\n- Prefer concise Chinese engineering updates.\n");
      writeFileSync(join(memoryDir, "MEMORY.md"), "# MEMORY.md\n\n- Global memory marker for all SCC tasks.\n");
      writeFileSync(join(memoryDir, "projects", projectHash, "MEMORY.md"), "# MEMORY.md\n\n- Project scoped memory marker.\n");

      const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
      const task: TaskDetail = {
        id: "task_memory_injection",
        title: "Memory injection",
        status: "running",
        workRoot,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: []
      };

      const context = await assembler.assemble(task);

      expect(context.systemPrompt).toContain("### Global USER.md");
      expect(context.systemPrompt).toContain("Prefer concise Chinese engineering updates.");
      expect(context.systemPrompt).toContain("### Global MEMORY.md");
      expect(context.systemPrompt).toContain("Global memory marker for all SCC tasks.");
      expect(context.systemPrompt).toContain("### Project MEMORY.md");
      expect(context.systemPrompt).toContain("Project scoped memory marker.");
      expect(context.input).not.toContain("### Global USER.md");
    } finally {
      if (previousMemoryDir === undefined) delete process.env["SCC_MEMORY_DIR"];
      else process.env["SCC_MEMORY_DIR"] = previousMemoryDir;
      rmSync(memoryDir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("injects runtime metadata without exposing approval state to the agent", async () => {
    const store = new InMemoryWorkbenchStore();
    const now = nowIso();
    await store.saveModelProvider({
      id: "provider_mimo",
      vendor: "mimo",
      label: "Mimo",
      protocol: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      apiKeyRef: { secretId: "provider_mimo", last4: "1234", updatedAt: now },
      models: [{ id: "mimo-v2.5", label: "MiMo-V2.5", contextWindow: 1048576, supportsTools: true, supportsThinking: true }],
      defaultModelId: "mimo-v2.5",
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
    await store.saveMcpServer({
      id: "mock_mcp",
      label: "Mock MCP",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      enabled: true,
      toolRiskOverrides: {},
      createdAt: now,
      updatedAt: now
    });
    await store.saveIntegrationProvider({
      id: "integration_discord",
      kind: "discord",
      label: "Discord",
      status: "setup_pending",
      enabled: false,
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      createdAt: now,
      updatedAt: now
    });
    const preferences = await store.getPreferences();
    await store.savePreferences({ ...preferences, activeModelProviderId: "provider_mimo", updatedAt: now });

    const assembler = new ContextAssembler(store);
    const context = await assembler.assemble({
      id: "task_runtime_metadata",
      title: "Runtime metadata",
      status: "running",
      createdAt: now,
      updatedAt: now,
      approvals: [],
      pendingGuidance: [],
      events: []
    });

    expect(context.systemPrompt).toContain("## Runtime Metadata");
    expect(context.systemPrompt).toContain("Active model: Mimo / mimo-v2.5");
    expect(context.systemPrompt).toContain("Web search: built-in DuckDuckGo fallback is available");
    expect(context.systemPrompt).toContain("mock_mcp: Mock MCP");
    expect(context.systemPrompt).toContain("integration_discord: Discord");
    expect(context.systemPrompt).not.toContain("Auto approval preference");
    expect(context.input).not.toContain("Auto approval preference");
  });
});

describe("Task title generation", () => {
  it("formats local fallback titles according to language habits", () => {
    expect(createLocalTaskTitle("请帮我检查 MCP 网络权限配置是否正确", "zh-CN")).toContain("MCP");
    expect(createLocalTaskTitle("Please debug the failing payment webhook tests", "en-US")).toBe("Please Debug The Failing Payment Webhook Tests");
    expect(createLocalTaskTitle("現在のプロジェクト構造を確認して改善案を出して", "ja-JP")).toContain("プロジェクト");
    expect(createLocalTaskTitle("현재 프로젝트 구조를 점검하고 개선안을 정리해줘", "ko-KR")).toContain("프로젝트");
  });

  it("uses the configured model provider when a new task omits the title", async () => {
    const titleServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "后端智能命名检查" } }] }));
    });
    await new Promise<void>((resolve) => titleServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = titleServer.address() as AddressInfo;
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
      await workbench.createModelProvider({
        vendor: "custom",
        label: "Title provider",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-title-key",
        models: [{ id: "title-model", label: "title-model", contextWindow: 128000, supportsTools: true, supportsThinking: false }],
        defaultModelId: "title-model",
        enabled: true,
        makeActive: true
      });

      const task = await workbench.createTask("请检查新任务建立后的后端自动命名流程");

      expect(task.title).toBe("后端智能命名检查");
      expect(task.status).toBe("completed");
    } finally {
      await new Promise<void>((resolve) => titleServer.close(() => resolve()));
    }
  });
});

describe("Tool surface selection", () => {
  it("keeps greetings tool-free, tool inventory requests read-only, and build requests writable", () => {
    const directTask: TaskDetail = {
      id: "task_direct_chat",
      title: "你好",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [{ id: "event_direct", taskId: "task_direct_chat", type: "user_message", createdAt: nowIso(), summary: "你好", payload: {} }]
    };
    const inventoryTask: TaskDetail = {
      id: "task_tool_inventory",
      title: "测试工具",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [{ id: "event_inventory", taskId: "task_tool_inventory", type: "user_message", createdAt: nowIso(), summary: "测试所有你能调用的工具", payload: {} }]
    };
    const buildTask: TaskDetail = {
      id: "task_build_blog",
      title: "构建博客页面",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [{
        id: "event_build",
        taskId: "task_build_blog",
        type: "user_message",
        createdAt: nowIso(),
        summary: "帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑",
        payload: {}
      }]
    };

    expect(selectModelToolsForTask(directTask)).toHaveLength(0);
    const toolNames = selectModelToolsForTask(inventoryTask).map((tool) => tool.function.name);
    expect(toolNames).toEqual(["read_file", "search_files", "list_files", "web_search", "knowledge_search"]);
    expect(selectModelToolsForTask(buildTask).some((tool) => tool.function.name === "write_file")).toBe(true);
    expect(selectModelToolsForTask(buildTask).some((tool) => tool.function.name === "edit_file")).toBe(true);
  });

  it("uses the task graph role policy to keep capability checks read-only and code tasks out of memory tools", () => {
    const inventoryTask: TaskDetail = {
      id: "task_tool_inventory_graph",
      title: "测试工具",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [{ id: "event_inventory", taskId: "task_tool_inventory_graph", type: "user_message", createdAt: nowIso(), summary: "测试所有你能调用的工具", payload: {} }]
    };
    const buildTask: TaskDetail = {
      id: "task_build_blog_graph",
      title: "构建博客页面",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [{
        id: "event_build",
        taskId: "task_build_blog_graph",
        type: "user_message",
        createdAt: nowIso(),
        summary: "帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑",
        payload: {}
      }]
    };
    attachCompiledTaskGraph(inventoryTask);
    attachCompiledTaskGraph(buildTask);

    const inventoryNames = selectModelToolsForTask(inventoryTask).map((tool) => tool.function.name);
    const buildNames = selectModelToolsForTask(buildTask).map((tool) => tool.function.name);

    expect(inventoryNames).toEqual(["read_file", "search_files", "list_files", "web_search", "knowledge_search"]);
    expect(buildNames).toContain("write_file");
    expect(buildNames).toContain("run_command");
    expect(buildNames).toContain("plan_update");
    expect(buildNames).not.toContain("user_memory_add");
    expect(buildNames).not.toContain("skill_create");
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

class FailingVerificationExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: false,
      createdAt: nowIso(),
      output: "npm ERR! build failed"
    };
  }
}

class ThrowingToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    throw new Error("simulated tool crash with sk-testsecret123456");
  }
}

class ParallelProbeToolExecutor {
  calls: ToolCall[] = [];
  active = 0;
  peakActive = 0;

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.active -= 1;
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: JSON.stringify({ toolName: call.toolName, ok: true })
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

class BrokenKnowledgeStore extends InMemoryWorkbenchStore {
  async listKnowledgeChunks(): Promise<Awaited<ReturnType<InMemoryWorkbenchStore["listKnowledgeChunks"]>>> {
    throw new Error("knowledge backend failed with Bearer secret-token-123456");
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

class ContextAwarePlanModel implements ModelClient {
  calls = 0;

  constructor(private readonly assembler: ContextAssembler) {}

  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    this.calls += 1;
    const context = await this.assembler.assemble(task);
    if (context.input.includes("Tool Result plan_update") && context.input.includes("plan_updated")) {
      return { kind: "final", message: "Saw the plan update result and continued." };
    }
    return {
      kind: "tool_calls",
      calls: [
        {
          id: createId("tool_call"),
          toolName: "plan_update",
          args: { context: "Planning visible progress.", status: "running", steps: [{ title: "Inspect continuity", status: "running" }] }
        }
      ]
    };
  }
}

class RepeatingPlanOnlyModel implements ModelClient {
  async next(): Promise<ModelTurn> {
    return {
      kind: "tool_calls",
      calls: [{
        id: createId("tool_call"),
        toolName: "plan_update",
        args: { context: "Still planning", status: "running", steps: [{ title: "Looping", status: "running" }] }
      }]
    };
  }
}

class MultiReadOnlyTurnModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length >= 3) return { kind: "final", message: "Read-only batch finished." };
    return {
      kind: "tool_calls",
      calls: [
        { id: createId("tool_call"), toolName: "list_files", args: { path: "." } },
        { id: createId("tool_call"), toolName: "search_files", args: { query: "package" } },
        { id: createId("tool_call"), toolName: "read_file", args: { path: "package.json" } }
      ]
    };
  }
}

class SequenceToolModel implements ModelClient {
  constructor(private readonly calls: Array<{ toolName: string; args: Record<string, unknown> }>) {}

  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    const completedCalls = task.events.filter((event) => event.type === "tool_result").length;
    const nextCall = this.calls[completedCalls];
    if (!nextCall) return { kind: "final", message: "Sequence complete." };
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: nextCall.toolName, args: nextCall.args }]
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

class InlineToolMarkupModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result")) {
      await stream?.onAssistantDelta("Artifact verified.");
      return { kind: "final", message: "Artifact verified.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    const message = [
      "I need to inspect files.",
      "<function_calls>",
      "<invoke name=\"list_files\">",
      "<parameter name=\"path\">.</parameter>",
      "</invoke>",
      "</function_calls>"
    ].join("\n");
    await stream?.onAssistantDelta(message);
    return { kind: "final", message, ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class ProviderFallbackEventModel implements ModelClient {
  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    await stream?.onProviderFallback?.({
      fromProviderId: "provider_primary",
      toProviderId: "provider_backup",
      fromModel: "primary-model",
      toModel: "backup-model",
      category: "rate_limit",
      reason: "simulated rate limit"
    });
    return { kind: "final", message: "Fallback completed.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class TraceEmittingToolRoundTripModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const streamId = stream?.streamId ?? createId("model_stream");
    await stream?.onTrace?.({
      kind: "request",
      timestamp: nowIso(),
      streamId,
      provider: { protocol: "openai_compatible", model: "trace-test-model", baseURL: "http://trace.local" },
      payload: {
        request: {
          messages: [{ role: "user", content: task.title }],
          eventCount: task.events.length
        }
      }
    });
    if (!task.events.some((event) => event.type === "tool_result")) {
      const response: ModelTurn = {
        kind: "tool_calls",
        calls: [{ id: createId("tool_call"), toolName: "list_files", args: { path: "." } }],
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
      await stream?.onTrace?.({
        kind: "response",
        timestamp: nowIso(),
        streamId,
        provider: { protocol: "openai_compatible", model: "trace-test-model", baseURL: "http://trace.local" },
        payload: { response }
      });
      return response;
    }
    const response: ModelTurn = { kind: "final", message: "Trace complete.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    await stream?.onTrace?.({
      kind: "response",
      timestamp: nowIso(),
      streamId,
      provider: { protocol: "openai_compatible", model: "trace-test-model", baseURL: "http://trace.local" },
      payload: { response }
    });
    return response;
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

describe("Attention-first task graph runtime", () => {
  it("does not create a task graph for a greeting", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    const task = await workbench.createTask("你好");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "task_graph_created")).toBe(false);
  });

  it("pauses a React code-change task when the model tries to finish without verification evidence", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    const task = await workbench.createTask("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");

    expect(task.status).toBe("paused");
    expect(task.events.some((event) => event.type === "task_graph_created")).toBe(true);
    expect(task.events.some((event) => event.type === "task_memory_created")).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(true);
  });

  it("records verification command evidence and permits completion after it passes", async () => {
    const store = new InMemoryWorkbenchStore();
    await store.savePreferences({ ...(await store.getPreferences()), autoApprove: "all", updatedAt: nowIso() });
    const workbench = new AgentWorkbench({
      store,
      model: new SequenceToolModel([{ toolName: "run_command", args: { command: "npm.cmd run build" } }]),
      tools: new StubToolExecutor()
    });

    const task = await workbench.createTask("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");
    const graph = taskGraphFromEvents(task);

    expect(task.status).toBe("completed");
    expect(graph?.nodes.some((node) => node.role === "verify" && node.verification.status === "passed")).toBe(true);
    expect(task.events.some((event) => event.type === "verification_result_recorded" && event.payload["status"] === "passed")).toBe(true);
  });

  it("keeps a failed verification result as evidence instead of completing", async () => {
    const store = new InMemoryWorkbenchStore();
    await store.savePreferences({ ...(await store.getPreferences()), autoApprove: "all", updatedAt: nowIso() });
    const workbench = new AgentWorkbench({
      store,
      model: new SequenceToolModel([{ toolName: "run_command", args: { command: "npm.cmd run build" } }]),
      tools: new FailingVerificationExecutor()
    });

    const task = await workbench.createTask("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");

    expect(task.status).toBe("paused");
    expect(task.events.some((event) => event.type === "verification_result_recorded" && event.payload["status"] === "failed")).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(true);
  });
});

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

  it("waits for approval before executing every risky tool category", async () => {
    const cases: Array<{
      args: Record<string, unknown>;
      riskCategory: RiskCategory;
      toolName: string;
    }> = [
      { toolName: "run_command", args: { command: "Get-Process | Select-Object -First 5" }, riskCategory: "host_observation" },
      { toolName: "edit_file", args: { path: "note.txt", expectedHash: "abc", edits: [] }, riskCategory: "workspace_write" },
      { toolName: "write_file", args: { path: "note.txt", expectedHash: "__new__", content: "hello" }, riskCategory: "workspace_write" },
      { toolName: "web_search", args: { query: "SCC workbench" }, riskCategory: "network" },
      { toolName: "run_command", args: { command: "Stop-Process -Id 99999" }, riskCategory: "destructive" }
    ];

    for (const testCase of cases) {
      const tools = new StubToolExecutor();
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools,
        model: new SingleToolModel(testCase.toolName, testCase.args)
      });

      const created = await workbench.createTask(`approval check for ${testCase.riskCategory}`);
      const approvalIndex = created.events.findIndex((event) => event.type === "approval_pending");
      const toolResultIndex = created.events.findIndex((event) => event.type === "tool_result");

      expect(created.status).toBe("waiting_approval");
      expect(created.approvals[0]?.riskCategory).toBe(testCase.riskCategory);
      expect(tools.calls).toHaveLength(0);
      expect(approvalIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBe(-1);
    }
  });

  it("turns thrown tool errors into explicit failed tool_result events", async () => {
    const tools = new ThrowingToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new ConfiguredToolModelClient("Get-Process")
    });
    await workbench.grantGlobalPermission("host_observation", "throwing tool regression");

    const completed = await workbench.createTask("check running processes");
    const result = completed.events.find((event) => event.type === "tool_result");

    expect(completed.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
    expect(result?.payload["ok"]).toBe(false);
    expect(String(result?.payload["output"])).toContain("Tool execution failed");
    expect(String(result?.payload["output"])).not.toContain("sk-testsecret");
  });

  it("pauses repeated state-only tool turns before they spin forever", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new RepeatingPlanOnlyModel()
    });

    const paused = await workbench.createTask("keep updating the plan forever");
    const planResults = paused.events.filter((event) => event.type === "tool_result" && event.payload["toolName"] === "plan_update");

    expect(paused.status).toBe("paused");
    expect(planResults).toHaveLength(2);
    expect(paused.events.some((event) => event.type === "assistant_message" && event.summary.includes("no-progress loop"))).toBe(true);
  });

  it("executes fully read-only multi-tool turns concurrently", async () => {
    const tools = new ParallelProbeToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new MultiReadOnlyTurnModel()
    });
    await workbench.grantGlobalPermission("workspace_read", "parallel read batch");

    const completed = await workbench.createTask("inspect several read-only surfaces at once");

    expect(completed.status).toBe("completed");
    expect(tools.calls).toHaveLength(3);
    expect(tools.peakActive).toBeGreaterThan(1);
    expect(completed.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  });

  it("writes per-task model trace logs across model requests and tool results", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-model-trace-"));
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({
      store,
      tools: new StubToolExecutor(),
      model: new TraceEmittingToolRoundTripModel()
    });
    const folder = await workbench.createTaskFolder({ name: "trace-folder", rootPath: workRoot });
    await workbench.grantGlobalPermission("workspace_read", "trace logging");

    const completed = await workbench.createTask("trace the full request-response loop", undefined, folder.id);
    const tracePath = join(workRoot, "data", "logs", "model-traces", `${completed.id}.jsonl`);

    expect(existsSync(tracePath)).toBe(true);
    const entries = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const kinds = entries.map((entry) => String(entry["kind"] ?? ""));

    expect(kinds).toContain("model_turn_started");
    expect(kinds).toContain("model_request");
    expect(kinds).toContain("model_response");
    expect(kinds).toContain("tool_requested");
    expect(kinds).toContain("tool_result");
    expect(kinds.filter((kind) => kind === "model_turn_started")).toHaveLength(2);

    rmSync(workRoot, { recursive: true, force: true });
  });

  it("persists an attention trace fixture for manual audit", async () => {
    const outDir = resolve("data", "test-reports", "attention-first-trace");
    const workRoot = join(outDir, "workroot");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(join(workRoot, "README.md"), "# Trace Fixture\n", "utf8");
    const capturedRequests: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestCount += 1;
        capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requestCount === 1) {
          response.write(`data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_trace_list",
                  function: { name: "list_files", arguments: "{\"path\":\".\"}" }
                }]
              }
            }]
          })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 8 } })}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Trace audit completed from tool evidence." } }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 160, completion_tokens: 9 } })}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const model = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "attention-trace-fixture",
        contextAssembler: assembler
      });
      const workbench = new AgentWorkbench({
        store,
        contextAssembler: assembler,
        model,
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "attention-trace", rootPath: workRoot });
      await workbench.grantGlobalPermission("workspace_read", "manual trace fixture");

      const completed = await workbench.createTask("Trace the full request-response loop by listing files.", undefined, folder.id);
      const tracePath = join(workRoot, "data", "logs", "model-traces", `${completed.id}.jsonl`);
      const traceEntries = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const requestMessages = capturedRequests.map((item) => item["messages"] as Array<Record<string, unknown>>);

      expect(completed.status).toBe("completed");
      expect(capturedRequests).toHaveLength(2);
      expect(existsSync(tracePath)).toBe(true);
      expect(traceEntries.some((entry) => entry["kind"] === "model_request")).toBe(true);
      expect(requestMessages[0]?.at(-1)?.["role"]).toBe("user");
      expect(String(requestMessages[0]?.at(-1)?.["content"] ?? "")).toContain("Active Node");
      expect(requestMessages[1]?.some((message) => message["role"] === "tool")).toBe(true);
      expect(String(requestMessages[1]?.find((message) => message["role"] === "tool")?.["content"] ?? "")).toContain("README.md");
      expect(requestMessages[1]?.at(-1)?.["role"]).toBe("user");
      expect(String(requestMessages[1]?.at(-1)?.["content"] ?? "")).toContain("list_files:ok");

      writeFileSync(join(outDir, "captured-requests.json"), JSON.stringify(capturedRequests, null, 2), "utf8");
      writeFileSync(join(outDir, "task-events.json"), JSON.stringify(completed.events, null, 2), "utf8");
      writeFileSync(
        join(outDir, "audit-summary.md"),
        [
          "# Attention Trace Fixture",
          "",
          `Task: ${completed.id}`,
          `Status: ${completed.status}`,
          `Trace: ${tracePath}`,
          "",
          "- Request 1 ends with the active task node user message.",
          "- Request 2 includes the tool role result before the active task node.",
          "- Task events include task graph, tool request, tool result, and assistant final message."
        ].join("\n"),
        "utf8"
      );
    } finally {
      await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    }
  });

  it("auto-approves non-MCP tools according to autoApprove without bypassing destructive tools", async () => {
    const store = new InMemoryWorkbenchStore();
    const preferences = await store.getPreferences();
    await store.savePreferences({ ...preferences, autoApprove: "low", updatedAt: nowIso() });
    const tools = new StubToolExecutor();
    const readWorkbench = new AgentWorkbench({
      store,
      tools,
      model: new SingleToolModel("list_files", { path: "." })
    });

    const completed = await readWorkbench.createTask("list files");

    expect(completed.status).toBe("completed");
    expect(completed.approvals).toHaveLength(0);
    expect(completed.events.some((event) => event.type === "approval_auto_granted" && event.payload["approvalSource"] === "autoApprove")).toBe(true);
    expect(tools.calls).toHaveLength(1);

    await store.savePreferences({ ...(await store.getPreferences()), autoApprove: "all", updatedAt: nowIso() });
    const destructiveWorkbench = new AgentWorkbench({
      store,
      tools: new StubToolExecutor(),
      model: new SingleToolModel("run_command", { command: "Stop-Process -Id 99999" })
    });
    const pending = await destructiveWorkbench.createTask("try destructive command");

    expect(pending.status).toBe("waiting_approval");
    expect(pending.approvals[0]?.riskCategory).toBe("destructive");
  });

  it("applies mcpApprovalMode before general auto approval", async () => {
    const store = new InMemoryWorkbenchStore();
    const preferences = await store.getPreferences();
    await store.savePreferences({ ...preferences, autoApprove: "all", mcpApprovalMode: "confirm_each", updatedAt: nowIso() });
    const riskProvider = {
      async assessTool(call: ToolCall) {
        return call.toolName.startsWith("mcp__")
          ? { category: "workspace_read" as const, reason: "fixture MCP read." }
          : undefined;
      }
    };
    const confirmWorkbench = new AgentWorkbench({
      store,
      tools: new StubToolExecutor(),
      toolRiskProvider: riskProvider,
      model: new SingleToolModel("mcp__fixture__read", {})
    });

    const pending = await confirmWorkbench.createTask("read through MCP");
    expect(pending.status).toBe("waiting_approval");
    expect(pending.approvals[0]?.riskCategory).toBe("workspace_read");

    await store.savePreferences({ ...(await store.getPreferences()), mcpApprovalMode: "auto", updatedAt: nowIso() });
    const autoTools = new StubToolExecutor();
    const autoWorkbench = new AgentWorkbench({
      store,
      tools: autoTools,
      toolRiskProvider: riskProvider,
      model: new SingleToolModel("mcp__fixture__read", {})
    });
    const completed = await autoWorkbench.createTask("read through MCP automatically");

    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "approval_auto_granted" && event.payload["approvalSource"] === "mcpApprovalMode")).toBe(true);
    expect(autoTools.calls).toHaveLength(1);
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

  it("continues execution when a provider returns inline XML tool markup as text", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools, model: new InlineToolMarkupModel() });
    await workbench.grantGlobalPermission("workspace_read", "inline markup regression");

    const completed = await workbench.createTask("inspect files before answering");

    expect(completed.status).toBe("completed");
    expect(tools.calls.map((call) => call.toolName)).toEqual(["list_files"]);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("<function_calls>"))).toBe(false);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("Artifact verified"))).toBe(true);
    expect(completed.events.some((event) => event.type === "assistant_delta" && event.payload["uiHidden"] === true)).toBe(true);
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

  it("lets the agent add global USER.md memory through the permissioned tool path", async () => {
    const previousMemoryDir = process.env["SCC_MEMORY_DIR"];
    const memoryDir = mkdtempSync(join(tmpdir(), "scc-user-memory-"));
    process.env["SCC_MEMORY_DIR"] = memoryDir;
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SingleToolModel("user_memory_add", {
          content: "Prefers concise Chinese engineering summaries.",
          section: "Preferences"
        })
      });

      const created = await workbench.createTask("请记住我的回答偏好");
      expect(created.status).toBe("waiting_approval");
      expect(created.approvals[0]?.riskCategory).toBe("workspace_write");
      const completed = await workbench.decideApproval(created.id, created.approvals[0]!.id, "allow_for_task");
      const memory = await workbench.getUserProfileDocument();

      expect(completed.status).toBe("completed");
      expect(memory.content).toContain("Prefers concise Chinese engineering summaries.");
    } finally {
      if (previousMemoryDir === undefined) delete process.env["SCC_MEMORY_DIR"];
      else process.env["SCC_MEMORY_DIR"] = previousMemoryDir;
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it("lets the agent edit and delete project MEMORY.md through task-scoped tools", async () => {
    const previousMemoryDir = process.env["SCC_MEMORY_DIR"];
    const memoryDir = mkdtempSync(join(tmpdir(), "scc-project-memory-"));
    process.env["SCC_MEMORY_DIR"] = memoryDir;
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SequenceToolModel([
          { toolName: "project_memory_add", args: { content: "Fixture uses Vitest for core tests.", section: "Key Facts" } },
          { toolName: "project_memory_edit", args: { match: "Vitest", replacement: "Fixture uses Vitest and Playwright for validation." } },
          { toolName: "project_memory_delete", args: { match: "Playwright for validation" } }
        ])
      });

      const created = await workbench.createTask("维护项目记忆");
      expect(created.status).toBe("waiting_approval");
      const completed = await workbench.decideApproval(created.id, created.approvals[0]!.id, "allow_for_task");
      const memory = await workbench.getProjectMemoryDocument("default");

      expect(completed.status).toBe("completed");
      expect(memory.content).not.toContain("Fixture uses Vitest");
      expect(completed.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
    } finally {
      if (previousMemoryDir === undefined) delete process.env["SCC_MEMORY_DIR"];
      else process.env["SCC_MEMORY_DIR"] = previousMemoryDir;
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it("supports skill create, use, and delete as permissioned agent tools", async () => {
    const skillWorkbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new SequenceToolModel([
        {
          toolName: "skill_create",
          args: {
            title: "Fixture Debugging",
            body: "Use failing test output to identify the smallest source edit, then rerun the same test.",
            requiredTools: ["read_file", "edit_file", "run_command"],
            keywords: ["debug", "fixture"]
          }
        },
        { toolName: "skill_delete", args: { title: "Fixture Debugging" } }
      ])
    });
    const created = await skillWorkbench.createTask("创建再删除一个测试 Skill");
    const completed = await skillWorkbench.decideApproval(created.id, created.approvals[0]!.id, "allow_for_task");
    expect(completed.status).toBe("completed");
    expect(await skillWorkbench.listSkills()).toHaveLength(0);

    const store = new InMemoryWorkbenchStore();
    const useWorkbench = new AgentWorkbench({ store });
    const skill = await useWorkbench.createSkill({
      title: "Read Only Summary",
      body: "Summarize only after reading directly relevant files.",
      status: "active",
      applicability: { description: "File summary tasks", requiredTools: ["read_file"], requiredContext: [], exclusions: [], keywords: ["summary"] },
      sourceMemoryIds: [],
      relatedPatterns: []
    });
    const useTaskWorkbench = new AgentWorkbench({
      store,
      model: new SingleToolModel("use_skill", { skillId: skill.id })
    });
    const started = await useTaskWorkbench.createTask("调用已有 Skill");
    expect(started.approvals[0]?.riskCategory).toBe("workspace_read");
    const loaded = await useTaskWorkbench.decideApproval(started.id, started.approvals[0]!.id, "allow_for_task");
    expect(loaded.status).toBe("completed");
    expect(loaded.events.some((event) => event.type === "skill_loaded" && event.payload["skillId"] === skill.id)).toBe(true);
  });

  it("supports skill lookup by name and skill edits through agent tools", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    const skill = await workbench.createSkill({
      title: "Careful File Summary",
      body: "Read relevant files before summarizing.",
      status: "active",
      applicability: { description: "File summary tasks", requiredTools: ["read_file"], requiredContext: [], exclusions: [], keywords: ["summary"] },
      sourceMemoryIds: [],
      relatedPatterns: []
    });

    const useByNameWorkbench = new AgentWorkbench({
      store,
      model: new SingleToolModel("use_skill", { name: "Careful File Summary" })
    });
    const started = await useByNameWorkbench.createTask("按名称调用 Skill");
    const used = await useByNameWorkbench.decideApproval(started.id, started.approvals[0]!.id, "allow_for_task");
    expect(used.events.some((event) => event.type === "skill_loaded" && event.payload["skillId"] === skill.id)).toBe(true);

    const editWorkbench = new AgentWorkbench({
      store,
      model: new SingleToolModel("skill_edit", {
        title: "Careful File Summary",
        newTitle: "Careful Source Summary",
        body: "Read directly relevant source files, state evidence, then summarize reusable findings.",
        requiredTools: ["read_file", "search_files"]
      })
    });
    const editStarted = await editWorkbench.createTask("编辑 Skill");
    expect(editStarted.approvals[0]?.riskCategory).toBe("workspace_write");
    const editedTask = await editWorkbench.decideApproval(editStarted.id, editStarted.approvals[0]!.id, "allow_for_task");
    const updated = await store.getSkill(skill.id);

    expect(editedTask.status).toBe("completed");
    expect(updated?.title).toBe("Careful Source Summary");
    expect(updated?.body).toContain("state evidence");
    expect(updated?.applicability.requiredTools).toContain("search_files");
  });

  it("lets the agent update the plan without showing a tool card in the conversation stream", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new SingleToolModel("plan_update", {
        context: "Investigating a user-reported frontend layout issue.",
        status: "running",
        steps: [
          { title: "Reproduce the layout issue", status: "completed" },
          { title: "Patch the interaction", status: "running" }
        ]
      })
    });

    const completed = await workbench.createTask("更新计划");
    const planEvent = completed.events.find((event) => event.type === "plan_revised");
    const toolResult = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "plan_update");

    expect(completed.status).toBe("completed");
    expect(completed.approvals).toHaveLength(0);
    expect(planEvent?.payload["context"]).toBe("Investigating a user-reported frontend layout issue.");
    expect((planEvent?.payload["steps"] as Array<{ title: string }> | undefined)?.map((step) => step.title)).toContain("Patch the interaction");
    expect(toolResult?.payload["uiHidden"]).toBe(true);
  });

  it("keeps plan_update results visible to the next model turn even when hidden from UI", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const model = new ContextAwarePlanModel(assembler);
    const workbench = new AgentWorkbench({ store, contextAssembler: assembler, model });

    const completed = await workbench.createTask("更新计划后继续执行");
    const planResults = completed.events.filter((event) => event.type === "tool_result" && event.payload["toolName"] === "plan_update");

    expect(completed.status).toBe("completed");
    expect(model.calls).toBe(2);
    expect(planResults).toHaveLength(1);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary === "Saw the plan update result and continued.")).toBe(true);
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
    expect(context.systemPrompt).toContain("notes.md (markdown");
    expect(context.systemPrompt).toContain("Important fixture content");
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

  it("uses the built-in web search fallback when no provider is configured", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          RelatedTopics: [{ Text: "SCC - Built-in fallback result", FirstURL: "https://example.test/scc" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    try {
      const executor = new WebSearchToolExecutor(new InMemoryWorkbenchStore());
      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "web_search",
        args: { query: "scc", limit: 1 }
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("builtin_duckduckgo");
      expect(result.output).toContain("Built-in fallback result");
    } finally {
      globalThis.fetch = originalFetch;
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

  it("returns failed knowledge_search results when the knowledge store throws or is cancelled", async () => {
    const call: ToolCall = {
      id: createId("tool_call"),
      toolName: "knowledge_search",
      args: { query: "approval policy" }
    };
    const failed = await new KnowledgeSearchToolExecutor(new BrokenKnowledgeStore()).execute(call);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new KnowledgeSearchToolExecutor(new InMemoryWorkbenchStore()).execute(
      { ...call, id: createId("tool_call") },
      { signal: controller.signal }
    );

    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("Knowledge search failed");
    expect(failed.output).not.toContain("secret-token");
    expect(cancelled.ok).toBe(false);
    expect(cancelled.output).toContain("cancelled");
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

  it("rolls back a task to the earliest checkpoint for files edited multiple times", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-checkpoint-chain-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "note.txt");
      writeFileSync(filePath, "before\n", "utf8");
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SequenceToolModel([
          {
            toolName: "edit_file",
            args: {
              path: "src/note.txt",
              expectedHash: hash("before\n"),
              edits: [{ startLine: 1, endLine: 1, newText: "middle" }]
            }
          },
          {
            toolName: "edit_file",
            args: {
              path: "src/note.txt",
              expectedHash: hash("middle\n"),
              edits: [{ startLine: 1, endLine: 1, newText: "after" }]
            }
          }
        ]),
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "Checkpoint chain root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "checkpoint chain test");

      const completed = await workbench.createTask("edit note twice", "Edit note twice", folder.id);
      const checkpoints = await workbench.listTaskCheckpoints(completed.id);

      expect(checkpoints).toHaveLength(2);
      expect(readFileSync(filePath, "utf8")).toBe("after\n");

      const rolledBack = await workbench.rollbackTask(completed.id);
      expect(rolledBack.restoredFiles).toBe(1);
      expect(readFileSync(filePath, "utf8")).toBe("before\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews checkpoint diffs and rolls back only selected files", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-checkpoint-selective-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const leftPath = join(root, "src", "left.txt");
      const rightPath = join(root, "src", "right.txt");
      writeFileSync(leftPath, "left-before\n", "utf8");
      writeFileSync(rightPath, "right-before\n", "utf8");
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SequenceToolModel([
          {
            toolName: "edit_file",
            args: {
              path: "src/left.txt",
              expectedHash: hash("left-before\n"),
              edits: [{ startLine: 1, endLine: 1, newText: "left-after" }]
            }
          },
          {
            toolName: "edit_file",
            args: {
              path: "src/right.txt",
              expectedHash: hash("right-before\n"),
              edits: [{ startLine: 1, endLine: 1, newText: "right-after" }]
            }
          }
        ]),
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "Selective root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "selective rollback test");

      const completed = await workbench.createTask("edit two files", "Edit two files", folder.id);
      const preview = await workbench.previewTaskRollback(completed.id);

      expect(preview.files.map((file) => file.relativePath.replace(/\\/g, "/")).sort()).toEqual(["src/left.txt", "src/right.txt"]);
      expect(preview.files.every((file) => file.canRollback)).toBe(true);

      const result = await workbench.rollbackTask(completed.id, { filePaths: ["src/left.txt"] });
      expect(result.restoredFiles).toBe(1);
      expect(readFileSync(leftPath, "utf8")).toBe("left-before\n");
      expect(readFileSync(rightPath, "utf8")).toBe("right-after\n");
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

  it("keeps the default reflection automation present and prevents deletion", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });

    const tasks = await workbench.listScheduledTasks();
    const reflection = tasks.find((task) => task.id === "schedule_agent_reflection");

    expect(reflection?.type).toBe("reflection");
    await expect(workbench.deleteScheduledTask("schedule_agent_reflection")).rejects.toThrow(/default automation/i);
    await workbench.updateScheduledTask("schedule_agent_reflection", { status: "paused" });
    expect((await workbench.listScheduledTasks()).find((task) => task.id === "schedule_agent_reflection")?.status).toBe("paused");
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

  it("records provider fallback diagnostics in task events", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ProviderFallbackEventModel() });
    const task = await workbench.createTask("exercise provider fallback");
    const fallback = task.events.find((event) => event.type === "provider_fallback");

    expect(fallback?.payload["fromModel"]).toBe("primary-model");
    expect(fallback?.payload["toModel"]).toBe("backup-model");
    expect(task.status).toBe("completed");
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

  it("uses an isolated SCC workspace as the default task folder instead of the project root", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    const task = await workbench.createTask("默认工作目录检查");
    const defaultFolder = (await workbench.listTaskFolders()).find((folder) => folder.id === "default");

    expect(defaultFolder?.rootPath).toBe(defaultTaskWorkRoot());
    expect(task.workRoot).toBe(defaultTaskWorkRoot());
    expect(resolve(task.workRoot ?? "")).not.toBe(resolve(process.cwd()));
    expect(task.workRoot?.replace(/\\/g, "/")).toContain("/workspace/default");
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

  it("surfaces skill curator explanations for candidates and low-value memories", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    await workbench.createTask("brief answer only");
    await workbench.createSkill({
      title: "Reusable repository triage",
      body: "# Reusable repository triage\nUse current evidence and summarize reusable risks.",
      status: "candidate",
      applicability: { description: "Repository triage", requiredTools: ["read_file"], keywords: ["repo", "triage"] }
    });

    const items = await workbench.listSkillCuratorItems();

    expect(items.some((item) => item.kind === "candidate" && item.title === "Reusable repository triage")).toBe(true);
    expect(items.some((item) => item.kind === "low_value_memory" && item.status === "not_promoted")).toBe(true);
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

  it("only bypasses approval for globally granted risk categories", async () => {
    const store = new InMemoryWorkbenchStore();
    const readTools = new StubToolExecutor();
    const readWorkbench = new AgentWorkbench({
      store,
      tools: readTools,
      model: new SingleToolModel("list_files", { path: "." })
    });

    await readWorkbench.grantGlobalPermission("workspace_read", "read-only preset");
    const readTask = await readWorkbench.createTask("list project files");

    expect(readTask.status).toBe("completed");
    expect(readTask.approvals).toHaveLength(0);
    expect(readTask.events.some((event) => event.type === "approval_auto_granted" && event.payload["riskCategory"] === "workspace_read")).toBe(true);
    expect(readTools.calls).toHaveLength(1);

    const writeTools = new StubToolExecutor();
    const writeWorkbench = new AgentWorkbench({
      store,
      tools: writeTools,
      model: new SingleToolModel("edit_file", { path: "note.txt", expectedHash: "abc", edits: [] })
    });
    const writeTask = await writeWorkbench.createTask("edit project file");

    expect(writeTask.status).toBe("waiting_approval");
    expect(writeTask.approvals[0]?.riskCategory).toBe("workspace_write");
    expect(writeTools.calls).toHaveLength(0);
  });

  it("audits all-mode style global grants for destructive requests", async () => {
    const allRisks: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools,
      model: new SingleToolModel("run_command", { command: "Stop-Process -Id 99999" })
    });

    for (const risk of allRisks) await workbench.grantGlobalPermission(risk, "all preset");
    const completed = await workbench.createTask("destructive all-mode audit");

    expect(completed.status).toBe("completed");
    expect(completed.approvals).toHaveLength(0);
    expect(completed.events.some((event) => event.type === "approval_auto_granted" && event.payload["riskCategory"] === "destructive")).toBe(true);
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

describe("OpenAIModelClient", () => {
  it("serializes assembled context with native chat roles and tool results", async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 3 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "trace-role-model",
        contextAssembler: assembler
      });
      const traces: Array<Record<string, unknown>> = [];
      const task: TaskDetail = {
        id: "task_openai_roles",
        title: "你好",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [
          { id: "event_hello", taskId: "task_openai_roles", type: "user_message", createdAt: nowIso(), summary: "你好", payload: {} },
          { id: "event_answer", taskId: "task_openai_roles", type: "assistant_message", createdAt: nowIso(), summary: "你好！有什么可以帮你的？", payload: {} },
          {
            id: "event_request",
            taskId: "task_openai_roles",
            type: "user_message",
            createdAt: nowIso(),
            summary: "帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑",
            payload: {}
          },
          {
            id: "event_tool_requested",
            taskId: "task_openai_roles",
            type: "tool_requested",
            createdAt: nowIso(),
            summary: "list_files",
            payload: { toolCallId: "call_list", toolName: "list_files", args: { path: "." } }
          },
          {
            id: "event_tool_result",
            taskId: "task_openai_roles",
            type: "tool_result",
            createdAt: nowIso(),
            summary: "Tool completed",
            payload: { toolCallId: "call_list", toolName: "list_files", args: { path: "." }, ok: true, output: "[]" }
          }
        ]
      };
      attachCompiledTaskGraph(task);

      const turn = await client.next(task, {
        streamId: "stream_openai_roles",
        onAssistantDelta: async () => undefined,
        onTrace: async (event) => { traces.push(event as unknown as Record<string, unknown>); }
      });
      const request = capturedRequests[0];
      const messages = request?.["messages"] as Array<Record<string, unknown>>;
      const requestTrace = traces.find((event) => event["kind"] === "request");
      const attention = (requestTrace?.["payload"] as Record<string, unknown> | undefined)?.["attention"] as Record<string, unknown> | undefined;

      expect(turn.kind).toBe("final");
      expect(messages[0]?.["role"]).toBe("system");
      expect(String(messages[0]?.["content"] ?? "")).toContain("Stable Memory Files");
      expect(String(messages[0]?.["content"] ?? "")).not.toContain("Task title:");
      expect(messages.map((message) => message["role"])).toEqual(["system", "user", "assistant", "user", "assistant", "tool", "user"]);
      expect(messages[3]?.["content"]).toBe("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");
      expect(messages[4]?.["tool_calls"]).toEqual([
        { id: "call_list", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }
      ]);
      expect(messages[5]?.["tool_call_id"]).toBe("call_list");
      expect(String(messages[6]?.["content"] ?? "")).toContain("## Active Node");
      expect(String(messages[6]?.["content"] ?? "")).toContain("编写一个完整的博客页面");
      expect(String(messages[6]?.["content"] ?? "")).toContain("event_tool_result:list_files:ok");
      expect((attention?.["activeNode"] as Record<string, unknown> | undefined)?.["role"]).toBe("implement");
      expect(attention?.["evidenceRefs"]).toContain("event_tool_result:list_files:ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("McpRegistry", () => {
  it("discovers stdio MCP tools, routes execution through approval, and reuses global permission", async () => {
    const temp = mkdtempSync(join(process.cwd(), "tmp-scc-mcp-"));
    try {
      const script = join(temp, "mock-mcp.mjs");
      writeFileSync(script, mockMcpServerSource());
      const store = new InMemoryWorkbenchStore();
      await store.savePreferences({ ...(await store.getPreferences()), mcpApprovalMode: "confirm_each", updatedAt: nowIso() });
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

  it("reads complete small and medium files by default without manual line pagination", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-read-full-"));
    try {
      const lines = Array.from({ length: 320 }, (_, index) => `line-${index + 1}`);
      writeFileSync(join(temp, "long.txt"), lines.join("\n"), "utf8");
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "long.txt" }
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed["mode"]).toBe("full");
      expect(parsed["partial"]).toBe(false);
      expect(parsed["totalLines"]).toBe(320);
      expect(String(parsed["content"])).toContain("line-260");
      expect(String(parsed["content"])).toContain("line-320");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns a large file preview by default and supports targeted range reads", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-read-large-"));
    try {
      const lines = Array.from({ length: 6000 }, (_, index) => `line-${index + 1} ${"x".repeat(80)}`);
      writeFileSync(join(temp, "huge.txt"), lines.join("\n"), "utf8");
      const executor = new ShellToolExecutor(temp);

      const preview = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "huge.txt" }
      });
      expect(preview.ok).toBe(true);
      const previewJson = JSON.parse(preview.output) as Record<string, unknown>;
      expect(previewJson["mode"]).toBe("large_preview");
      expect(previewJson["partial"]).toBe(true);
      expect(String(previewJson["content"])).toContain("line-1");
      expect(String(previewJson["content"])).toContain("line-6000");
      expect(String(previewJson["content"])).not.toContain("line-3000");

      const range = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "huge.txt", offset: 3000, limit: 3 }
      });
      expect(range.ok).toBe(true);
      const rangeJson = JSON.parse(range.output) as Record<string, unknown>;
      expect(rangeJson["mode"]).toBe("range");
      expect(rangeJson["partial"]).toBe(true);
      expect(String(rangeJson["content"])).toContain("line-3000");
      expect(String(rangeJson["content"])).toContain("line-3002");
      expect(typeof rangeJson["hash"]).toBe("string");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("writes large whole-file content without exposing write chunking to the model", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-write-large-"));
    try {
      const content = Array.from({ length: 5000 }, (_, index) => `generated-${index + 1}`).join("\n");
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "write_file",
        args: { path: "generated.txt", expectedHash: "__new__", content }
      });

      expect(result.ok).toBe(true);
      expect(readFileSync(join(temp, "generated.txt"), "utf8")).toBe(content);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed["path"]).toContain("generated.txt");
      expect(parsed["changed"]).toBe(true);
      expect(result.output).not.toContain("chunk");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("requires expectedHash before editing existing files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-tools-"));
    try {
      const file = join(temp, "note.txt");
      writeFileSync(file, "before");
      const executor = new ShellToolExecutor(temp);
      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: "note.txt",
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
