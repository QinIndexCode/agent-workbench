import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { describe, expect, it } from "vitest";
import type { RiskCategory, TaskDetail, TaskMemory, ToolCall, ToolResult } from "@agent-workbench/shared";
import { ShellToolExecutor, type ToolExecutionOptions } from "../src/tools.js";
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
  verifySlackRequestSignature,
  buildHistoryLayer,
  createLocalTaskTitle,
  detectSkillConflicts,
  createExperience,
  createId,
  createTaskMemory,
  loadOpenAiConfig,
  loadOpenAiProviderConfig,
  nowIso,
  promoteExperience,
  reflectMemories,
  selectModelToolsForTask,
  shouldSendOpenAIPromptCacheKey,
  shouldSendOpenAIPromptCacheRetention,
  compileTaskGraph,
  taskGraphFromEvents,
  shouldPromoteExperienceToSkill,
  type TaskGraph,
  type TaskGraphNode
} from "../src/index.js";
import { defaultTaskWorkRoot } from "../src/workspace-root.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hostObservationModel = new ConfiguredToolModelClient("Get-Process | Sort-Object CPU");

function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function repoTestTempRoot(): string {
  const dir = resolve(repoRoot, "data", "test-tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
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

function attachExplicitTaskGraph(task: TaskDetail, overrides: Partial<TaskGraphNode> = {}): TaskGraph {
  const objective = [...task.events].reverse().find((event) => event.type === "user_message" && !event.reverted)?.summary ?? "Use recorded task state.";
  const node: TaskGraphNode = {
    id: createId("node"),
    role: "implement",
    objective,
    allowedToolClasses: ["workspace_read", "workspace_write", "shell", "network", "state"],
    contextHints: [`task:${task.id}`, "recent_tool_evidence"],
    acceptanceCriteria: ["Use the recorded objective and preserve tool evidence."],
    verification: {
      kind: "manual",
      method: "Record tool evidence or manual review before completion when required.",
      required: false,
      status: "not_applicable",
      evidenceRefs: []
    },
    risk: "workspace_write",
    status: "running",
    evidenceRefs: [],
    ...overrides
  };
  const graph: TaskGraph = {
    taskId: task.id,
    nodes: [node],
    activeNodeId: node.id,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
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

function testTaskMemory(index: number, input: { domain: string; title: string; tools: string[] }): TaskMemory {
  const now = nowIso();
  return {
    id: `memory_test_${index}`,
    taskId: `task_test_${index}`,
    title: input.title,
    goal: input.title,
    toolsUsed: input.tools.map((toolName) => ({
      toolName,
      args: {},
      result: `${toolName} completed`,
      riskCategory: toolName === "run_command" ? "host_observation" : "workspace_read"
    })),
    result: "Completed with reusable evidence.",
    assessment: {
      goalAchieved: true,
      confidence: 0.92,
      issues: [],
      learnings: ["The workflow completed with current evidence."],
      suggestedPatterns: [input.domain]
    },
    meta: {
      outcome: "success",
      complexity: "medium",
      domains: [input.domain],
      tools: input.tools,
      hasSideEffects: false,
      duration: 30
    },
    reflectionCount: 0,
    reflectionStatus: "pending",
    createdAt: now
  };
}

function attachReadOnlyTaskGraph(task: TaskDetail): TaskGraph {
  return attachExplicitTaskGraph(task, {
    role: "research",
    allowedToolClasses: ["workspace_read", "network"],
    risk: "workspace_read",
    acceptanceCriteria: ["Use only read-only tool evidence."],
    verification: {
      kind: "read_only",
      method: "Use read-only evidence when useful.",
      required: false,
      status: "not_applicable",
      evidenceRefs: []
    }
  });
}

function attachVerificationTaskGraph(task: TaskDetail): TaskGraph {
  const implement = attachExplicitTaskGraph(task, {
    role: "verify",
    allowedToolClasses: ["workspace_read", "shell", "network"],
    risk: "shell",
    verification: {
      kind: "tests",
      method: "Use command output as verification evidence.",
      required: true,
      status: "pending",
      evidenceRefs: [],
      commands: ["npm.cmd run build"]
    }
  });
  return implement;
}

describe("ContextAssembler", () => {
  it("keeps capability questions direct and evidence-grounded", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
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
    expect(context.systemPrompt).toContain("## Agent Workflow Heuristics");
    expect(context.systemPrompt).toContain("decision heuristics, not a hard checklist");
    expect(context.systemPrompt).toContain("Do not force tools, plans, tests");
    expect(context.systemPrompt).toContain("preserve acceptance criteria");
    expect(context.systemPrompt).toContain("Never hardcode behavior to satisfy a particular test prompt");
    expect(context.systemPrompt).toContain("strongest practical proof");
    expect(context.systemPrompt).toContain("do not call ask_user to ask how to interpret");
    expect(context.systemPrompt).toContain("Use Markdown for readable structure");
  });

  it("injects compiled task graph acceptance and verification guidance", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_compiled_graph_context",
      title: "Compiled graph context",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_compiled_graph_context",
          type: "user_message",
          createdAt: nowIso(),
          summary: "补齐 CLI 的 provider list 命令，修改后必须运行 npm.cmd run typecheck。",
          payload: {}
        }
      ]
    };
    const graph = compileTaskGraph(task);
    if (!graph) throw new Error("expected compiled graph");
    task.events.push({
      id: createId("event"),
      taskId: task.id,
      type: "task_graph_created",
      createdAt: nowIso(),
      summary: "Task graph created",
      payload: { graph }
    });

    const context = await assembler.assemble(task);

    expect(context.systemPrompt).toContain("## Task Graph");
    expect(context.systemPrompt).toContain("Active allowed tool classes: workspace_read, workspace_write, host_observation, shell, network, state");
    expect(context.systemPrompt).toContain("Active acceptance criteria:");
    expect(context.systemPrompt).toContain("Avoid hardcoded behavior that only satisfies one prompt");
    expect(context.systemPrompt).toContain("Active verification:");
    expect(context.systemPrompt).toContain("Run the user-named verification command(s): npm.cmd run typecheck");
  });

  it("does not keep a trivial greeting as the original goal after a later real request", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
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
    expect(`${context.systemPrompt}\n${context.input}`).not.toMatch(/task title/i);
    expect(context.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    const latest = context.messages.at(-1);
    expect(latest?.role).toBe("user");
    expect(latest && "content" in latest ? latest.content : "").toContain("测试所有你能调用的工具");
  });

  it("carries rollback completion into the next model turn history", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_rollback_history",
      title: "Rollback history",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user", taskId: "task_rollback_history", type: "user_message", createdAt: nowIso(), summary: "修复测试", payload: {} },
        {
          id: "event_rollback",
          taskId: "task_rollback_history",
          type: "task_rollback_completed",
          createdAt: nowIso(),
          summary: "Rolled back 2 file changes.",
          payload: { restoredFiles: 2, deletedFiles: 0, skippedFiles: 0, filePaths: ["src/math.mjs", "src/totals.mjs"] }
        },
        {
          id: "event_followup",
          taskId: "task_rollback_history",
          type: "user_message",
          createdAt: nowIso(),
          summary: "继续同一个任务，核对 rollback 后源码。",
          payload: {}
        }
      ]
    };

    const context = await assembler.assemble(task);
    const rollbackMessage = context.messages.find((message) => message.eventId === "event_rollback");

    expect(rollbackMessage?.role).toBe("user");
    expect(rollbackMessage && "content" in rollbackMessage ? rollbackMessage.content : "").toContain("Rolled back 2 file changes");
    expect(rollbackMessage && "content" in rollbackMessage ? rollbackMessage.content : "").toContain("restoredFiles=2");
  });

  it("carries retained thinking into canonical history through private continuity messages", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_reasoning_history",
      title: "Reasoning continuity",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user_reasoning", taskId: "task_reasoning_history", type: "user_message", createdAt: nowIso(), summary: "继续处理当前工作", payload: {} },
        {
          id: "event_final_reasoning",
          taskId: "task_reasoning_history",
          type: "assistant_message",
          createdAt: nowIso(),
          summary: "我已经检查完当前结构。",
          payload: {
            streamId: "stream_reasoning_history",
            reasoningContent: "先检查当前目录结构，再决定下一步读取哪个文件。"
          }
        }
      ]
    };

    const context = await assembler.assemble(task);

    expect(context.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "assistant"]);
    expect(context.messages[2]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Internal continuity note")
    });
    expect(context.messages[2] && "content" in context.messages[2] ? context.messages[2].content : "").toContain("Do not quote this note");
    expect(context.messages[2] && "content" in context.messages[2] ? context.messages[2].content : "").toContain("先检查当前目录结构");
    expect(context.messages[3]).toMatchObject({ role: "assistant", content: "我已经检查完当前结构。" });
  });

  it("keeps explicit task graph state in system context without impersonating the user", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
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
    const graph = attachExplicitTaskGraph(task);

    const context = await assembler.assemble(task);
    const latest = context.messages.at(-1);

    expect(graph?.nodes.some((node) => node.role === "implement")).toBe(true);
    expect(context.systemPrompt).toContain("## Task Graph");
    expect(`${context.systemPrompt}\n${context.input}`).not.toContain("Task title: 你好");
    expect(`${context.systemPrompt}\n${context.input}`).not.toMatch(/task title/i);
    expect(context.attentionPacket.activeNode?.role).toBe("implement");
    expect(latest?.role).toBe("user");
    expect(latest && "content" in latest ? latest.content : "").toContain("编写一个完整的博客页面");
    expect(latest && "content" in latest ? latest.content : "").not.toContain("## Active Node");
  });

  it("keeps task title update metadata out of model context", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_title_metadata",
      title: "Auto Rename Leaked Title",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_hello", taskId: "task_title_metadata", type: "user_message", createdAt: nowIso(), summary: "你好", payload: {} },
        {
          id: "event_title",
          taskId: "task_title_metadata",
          type: "task_title_updated",
          createdAt: nowIso(),
          summary: "Auto Rename Leaked Title",
          payload: { source: "auto", uiHidden: true }
        },
        { id: "event_current", taskId: "task_title_metadata", type: "user_message", createdAt: nowIso(), summary: "请基于现有内容继续回答", payload: {} }
      ]
    };

    const context = await assembler.assemble(task);
    const serialized = JSON.stringify(context.messages) + "\n" + context.systemPrompt + "\n" + context.input;

    expect(serialized).not.toContain("Auto Rename Leaked Title");
    expect(serialized).not.toContain("task_title_updated");
    expect(context.messages.at(-1)?.role).toBe("user");
  });

  it("injects a bounded active skill catalog without matching the latest user text", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    await workbench.updatePreferences({ skillAutoInject: true, maxInjectedSkills: 4 });
    const financeSkill = await workbench.createSkill({
      title: "Quarterly Finance Close",
      body: "Review ledgers and reconcile accruals before drafting the close note.",
      status: "active",
      applicability: {
        description: "Finance close checklist",
        requiredTools: ["read_file"],
        requiredContext: ["ledger"],
        exclusions: [],
        keywords: ["finance", "ledger", "close"]
      },
      sourceMemoryIds: [],
      relatedPatterns: []
    });
    const releaseSkill = await workbench.createSkill({
      title: "Release Checklist",
      body: "Check changelog, test results, and deployment notes before release.",
      status: "active",
      applicability: {
        description: "Release readiness",
        requiredTools: ["run_command"],
        requiredContext: ["release"],
        exclusions: [],
        keywords: ["release", "deploy"]
      },
      sourceMemoryIds: [],
      relatedPatterns: []
    });
    const candidate = await workbench.createSkill({
      title: "React Blog Candidate",
      body: "Candidate skill that should stay out of runtime catalog until activated.",
      status: "candidate",
      applicability: {
        description: "Candidate React blog guidance",
        requiredTools: ["edit_file"],
        requiredContext: ["react"],
        exclusions: [],
        keywords: ["react", "blog"]
      },
      sourceMemoryIds: [],
      relatedPatterns: []
    });
    const assembler = new ContextAssembler(store);
    const context = await assembler.assemble({
      id: "task_skill_catalog",
      title: "Skill catalog",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_skill_catalog",
          type: "user_message",
          createdAt: nowIso(),
          summary: "帮我写一个 React 博客页面",
          payload: {}
        }
      ]
    });

    expect(context.systemPrompt).toContain("not selected from the latest user text");
    expect(context.systemPrompt).toContain(financeSkill.id);
    expect(context.systemPrompt).toContain(releaseSkill.id);
    expect(context.systemPrompt).toContain("React Blog Candidate");
    expect(context.systemPrompt).toContain("shown for awareness only");
    expect(context.systemPrompt).not.toContain(candidate.id);
    expect(context.messages.at(-1)?.role).toBe("user");
  });

  it("injects only a compact knowledge brief as system background", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    await workbench.updatePreferences({ knowledgeActiveInjection: true, maxInjectedKnowledgeItems: 1 });
    const item = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Routing notes",
      content: `Agent Workbench routing notes describe stable background pointers for navigation. ${"brief filler ".repeat(30)}FULL_BODY_MARKER_SHOULD_NOT_APPEAR`,
      tags: ["routing", "ui"]
    });
    const assembler = new ContextAssembler(store);
    const context = await assembler.assemble({
      id: "task_knowledge_brief",
      title: "Knowledge brief",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_knowledge_brief",
          type: "user_message",
          createdAt: nowIso(),
          summary: "继续检查当前实现",
          payload: {}
        }
      ]
    });

    expect(context.systemPrompt).toContain("## Knowledge Brief");
    expect(context.systemPrompt).toContain(item.id);
    expect(context.systemPrompt).toContain("Routing notes");
    expect(context.systemPrompt).toContain("not the current user request");
    expect(context.systemPrompt).not.toContain("FULL_BODY_MARKER_SHOULD_NOT_APPEAR");
    expect(context.messages.at(-1)?.role).toBe("user");
    expect(context.messages.at(-1)?.role === "user" ? context.messages.at(-1)?.content : "").toContain("继续检查当前实现");
  });

  it("prioritizes current-turn relevant knowledge without hiding the knowledge_search path", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    await workbench.updatePreferences({ knowledgeActiveInjection: true, maxInjectedKnowledgeItems: 1 });
    const unrelated = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Provider key rotation runbook",
      content: "Operational steps for rotating OpenAI-compatible provider credentials and checking API base URLs.",
      tags: ["provider", "credentials"]
    });
    const relevant = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Docs search responsive sidebar",
      content: "The documentation search page should collapse navigation into a hamburger sidebar on narrow screens.",
      tags: ["docs", "search", "responsive", "sidebar"]
    });
    const assembler = new ContextAssembler(store);
    const context = await assembler.assemble({
      id: "task_relevant_knowledge_brief",
      title: "Docs responsive polish",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_old",
          taskId: "task_relevant_knowledge_brief",
          type: "user_message",
          createdAt: nowIso(),
          summary: "先检查 provider 配置",
          payload: {}
        },
        {
          id: "event_latest",
          taskId: "task_relevant_knowledge_brief",
          type: "user_message",
          createdAt: nowIso(),
          summary: "窄屏文档搜索页需要汉堡侧边栏，并完善搜索配置",
          payload: {}
        }
      ]
    });

    expect(context.systemPrompt).toContain("## Knowledge Brief");
    expect(context.systemPrompt).toContain("Relevant pointers are shown first");
    expect(context.systemPrompt).toContain(relevant.id);
    expect(context.systemPrompt).toContain("knowledge_search");
    expect(context.systemPrompt).not.toContain(unrelated.id);
  });

  it("keeps catalog fallback knowledge when the current turn has no specific match", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    await workbench.updatePreferences({ knowledgeActiveInjection: true, maxInjectedKnowledgeItems: 1 });
    const item = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Release evidence checklist",
      content: "Use release evidence only as background unless the user asks to inspect exact artifacts.",
      tags: ["release", "evidence"]
    });
    const assembler = new ContextAssembler(store);
    const context = await assembler.assemble({
      id: "task_generic_knowledge_brief",
      title: "Generic continuation",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_generic_knowledge_brief",
          type: "user_message",
          createdAt: nowIso(),
          summary: "继续",
          payload: {}
        }
      ]
    });

    expect(context.systemPrompt).toContain("## Knowledge Brief");
    expect(context.systemPrompt).toContain(item.id);
    expect(context.systemPrompt).toContain("otherwise catalog status/order is preserved");
  });

  it("keeps the latest user message when a long history is truncated", () => {
    const task: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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

  it("names explicit verification commands in goal mode and marks them pending after edits", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_target_verification_pending",
      title: "Target verification pending",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      runMode: "target",
      targetLimits: {
        maxModelTurns: 48,
        maxToolCalls: 120,
        maxWallTimeMs: 240_000
      },
      events: [
        {
          id: "event_user",
          taskId: "task_target_verification_pending",
          type: "user_message",
          createdAt: nowIso(),
          summary: "这是一个长任务验证。先运行 npm test，定位失败测试，读取相关源码，再只修改必要文件。必须重新运行 npm test，确认全部通过。",
          payload: {}
        },
        {
          id: "event_edit",
          taskId: "task_target_verification_pending",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "edit_file",
            ok: true,
            output: JSON.stringify({ path: "src/math.mjs" })
          }
        }
      ]
    };

    const context = await assembler.assemble(task);

    expect(context.systemPrompt).toContain("Explicit user-named verification commands: `npm test`.");
    expect(context.systemPrompt).toContain("rerun every listed verification command successfully after the latest recorded file change before completing");
    expect(context.systemPrompt).toContain("Recorded verification after the latest file change: none yet.");
  });

  it("uses stronger default limits and goal-mode prompt guidance", async () => {
    const task: TaskDetail = {
      kind: "primary",
      id: "task_goal_defaults",
      title: "Goal defaults",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      runMode: "target",
      targetLimits: {
        maxModelTurns: 160,
        maxToolCalls: 500,
        maxWallTimeMs: 14_400_000
      },
      events: [{ id: "event_user", taskId: "task_goal_defaults", type: "user_message", createdAt: nowIso(), summary: "修复并验证项目。", payload: {} }]
    };
    const context = await new ContextAssembler(new InMemoryWorkbenchStore()).assemble(task);

    expect(context.systemPrompt).toContain("## Goal Mode");
    expect(context.systemPrompt).toContain("explicitly started /goal");
    expect(context.systemPrompt).toContain("visible acceptance criteria");
    expect(context.systemPrompt).toContain("plan_update");
    expect(context.systemPrompt).toContain("Run limits: 160 model turns, 500 tool results, 240 minutes.");
  });

  it("treats equivalent npm verification commands as satisfied after the latest edit", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
      id: "task_target_verification_passed",
      title: "Target verification passed",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      runMode: "target",
      targetLimits: {
        maxModelTurns: 48,
        maxToolCalls: 120,
        maxWallTimeMs: 240_000
      },
      events: [
        {
          id: "event_user",
          taskId: "task_target_verification_passed",
          type: "user_message",
          createdAt: nowIso(),
          summary: "修完后必须重新运行 npm test，再给我结果。",
          payload: {}
        },
        {
          id: "event_edit",
          taskId: "task_target_verification_passed",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "edit_file",
            ok: true,
            output: JSON.stringify({ path: "src/totals.mjs" })
          }
        },
        {
          id: "event_verify",
          taskId: "task_target_verification_passed",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "run_command",
            ok: true,
            args: { command: "npm.cmd run test 2>&1" },
            output: "tests passed"
          }
        }
      ]
    };

    const context = await assembler.assemble(task);

    expect(context.systemPrompt).toContain("Explicit user-named verification commands: `npm test`.");
    expect(context.systemPrompt).toContain("Recorded verification after the latest file change: `npm test`.");
    expect(context.systemPrompt).not.toContain("Remaining required command(s)");
  });

  it("keeps UI-hidden tool results in model history while hiding visible plan events", () => {
    const task: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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
    expect(history).toContain("Known Files");
    expect(history).not.toContain(content);
    expect(combined.match(/UNIQUE_READ_FILE_CONTENT/g)).toHaveLength(1);
  });

  it("keeps modest read_file content complete in Known Files when it fits the file budget", () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const content = Array.from({ length: 280 }, (_, index) =>
      index === 220 ? `line ${index + 1}: TARGET_PERMISSION_COPY` : `line ${index + 1}: filler content`
    ).join("\n");
    const task: TaskDetail = {
      kind: "primary",
      id: "task_medium_file_context",
      title: "Medium file context",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_read_medium",
          taskId: "task_medium_file_context",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "read_file",
            ok: true,
            output: JSON.stringify({ path: "src/i18n.ts", content, hash: "hash_medium", partial: false, totalLines: 280, mode: "full" })
          }
        }
      ]
    };

    const tracker = assembler.getFileStateTracker(task.id);
    tracker.updateFromToolResult(task.events[0]!);
    const knownFiles = tracker.buildFileStateTable();

    expect(knownFiles).toContain("complete content");
    expect(knownFiles).toContain("280 lines");
    expect(knownFiles).toContain("TARGET_PERMISSION_COPY");
  });

  it("compacts long full-file reads before they enter Known Files", () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const content = Array.from({ length: 980 }, (_, index) =>
      index === 880 ? `line ${index + 1}: SHOULD_NOT_BE_FULLY_TRACKED` : `line ${index + 1}: filler content`
    ).join("\n");
    const task: TaskDetail = {
      kind: "primary",
      id: "task_large_file_context",
      title: "Large file context",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_read_large",
          taskId: "task_large_file_context",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolName: "read_file",
            ok: true,
            output: JSON.stringify({ path: "src/index.html", content, hash: "hash_large", partial: false, totalLines: 980, mode: "full" })
          }
        }
      ]
    };

    const tracker = assembler.getFileStateTracker(task.id);
    tracker.updateFromToolResult(task.events[0]!);
    const knownFiles = tracker.buildFileStateTable();

    expect(knownFiles).toContain("context excerpt");
    expect(knownFiles).toContain("980 lines");
    expect(knownFiles).toContain("Large full-file reads are compacted");
    expect(knownFiles).not.toContain("SHOULD_NOT_BE_FULLY_TRACKED");
  });

  it("rebuilds tool calls and results as role messages for the next model turn", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const task: TaskDetail = {
      kind: "primary",
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

  it("keeps web search evidence in the tool result without adding a summary-only assistant turn", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const marker = "AW-WEB-SEARCH-GOLDEN";
    const task: TaskDetail = {
      kind: "primary",
      id: "task_web_search_context",
      title: "Web search context",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        { id: "event_user", taskId: "task_web_search_context", type: "user_message", createdAt: nowIso(), summary: "Search for the live marker.", payload: {} },
        {
          id: "event_request",
          taskId: "task_web_search_context",
          type: "tool_requested",
          createdAt: nowIso(),
          summary: "web_search",
          payload: { toolCallId: "call_search", toolName: "web_search", args: { query: "Agent Workbench live search marker" } }
        },
        {
          id: "event_result",
          taskId: "task_web_search_context",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolCallId: "call_search",
            toolName: "web_search",
            args: { query: "Agent Workbench live search marker" },
            ok: true,
            output: JSON.stringify({ results: [{ title: "Marker", snippet: `The marker is ${marker}.` }] })
          }
        },
        {
          id: "event_web_summary",
          taskId: "task_web_search_context",
          type: "web_search_result",
          createdAt: nowIso(),
          summary: "Search evidence returned",
          payload: { toolCallId: "call_search", ok: true, output: marker }
        }
      ]
    };

    const context = await assembler.assemble(task);
    const history = buildHistoryLayer(task, 2000);
    const roleMessages = context.messages.filter((message) => message.role !== "system");

    expect(roleMessages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(roleMessages[2]?.role === "tool" ? roleMessages[2].content : "").toContain(marker);
    expect(JSON.stringify(context.messages)).not.toContain("Web search result: Search evidence returned");
    expect(history).toContain(marker);
    expect(history).not.toContain("Search evidence returned");
  });

  it("keeps small read_file content in tool role while Known Files also records it", async () => {
    const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
    const content = "ROLE_READ_FILE_CONTENT";
    const task: TaskDetail = {
      kind: "primary",
      id: "task_file_role_dedupe",
      title: "File role dedupe",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_file_role_dedupe",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Read src/example.ts",
          payload: {}
        },
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
    assembler.getFileStateTracker(task.id).updateFromToolResult(task.events.find((event) => event.type === "tool_result")!);

    const context = await assembler.assemble(task);
    const toolMessage = context.messages.find((message) => message.role === "tool");

    expect(context.systemPrompt).toContain(content);
    expect(toolMessage?.role).toBe("tool");
    const toolContent = toolMessage?.role === "tool" ? JSON.parse(toolMessage.content) : {};
    expect(toolContent.output).toContain("live file evidence");
    expect(toolContent.content).toBe(content);
  });

  it("does not compact ordinary small messages by event count alone", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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

  it("retains failed verification output in compacted context summaries", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      kind: "primary",
      id: "task_failed_verification_summary",
      title: "Failed verification summary",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_goal",
          taskId: "task_failed_verification_summary",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Fix the failing math test and preserve the exact failure evidence.",
          payload: {}
        },
        {
          id: "event_failed_test",
          taskId: "task_failed_verification_summary",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool failed",
          payload: {
            toolName: "run_command",
            ok: false,
            output: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n3 !== 10\n\nat tests/math.test.mjs:3:8"
          }
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `event_noise_${index}`,
          taskId: "task_failed_verification_summary",
          type: "assistant_message" as const,
          createdAt: nowIso(),
          summary: `noise ${index} ${"large context ".repeat(80)}`,
          payload: {}
        })),
        {
          id: "event_latest",
          taskId: "task_failed_verification_summary",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Continue from the earlier failed test evidence.",
          payload: {}
        }
      ]
    };

    const context = await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    const summaries = await store.listConversationSummaries(task.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.retainedFacts.join("\n")).toContain("3 !== 10");
    expect(summaries[0]?.retainedFacts.join("\n")).toContain("actual 3; expected 10");
    expect(context.systemPrompt).toContain("Earlier failed run_command evidence");
    expect(context.systemPrompt).toContain("3 !== 10");
  });

  it("carries retained failure facts across repeated context summaries", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const task: TaskDetail = {
      kind: "primary",
      id: "task_repeated_summary_failure_facts",
      title: "Repeated summary failure facts",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_goal",
          taskId: "task_repeated_summary_failure_facts",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Continue repairing from the original failed assertion.",
          payload: {}
        },
        {
          id: "event_failed_test",
          taskId: "task_repeated_summary_failure_facts",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool failed",
          payload: {
            toolName: "run_command",
            ok: false,
            output: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n3 !== 10\n\nat tests/math.test.mjs:3:8"
          }
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `event_initial_noise_${index}`,
          taskId: "task_repeated_summary_failure_facts",
          type: "assistant_message" as const,
          createdAt: nowIso(),
          summary: `initial noise ${index} ${"large context ".repeat(80)}`,
          payload: {}
        }))
      ]
    };

    await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    task.events.push(
      ...Array.from({ length: 90 }, (_, index) => ({
        id: `event_later_noise_${index}`,
        taskId: "task_repeated_summary_failure_facts",
        type: "assistant_message" as const,
        createdAt: nowIso(),
        summary: `later noise ${index} ${"additional context ".repeat(80)}`,
        payload: {}
      })),
      {
        id: "event_latest",
        taskId: "task_repeated_summary_failure_facts",
        type: "user_message",
        createdAt: nowIso(),
        summary: "Use the earlier failed assertion exactly.",
        payload: {}
      }
    );

    const context = await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    const summaries = await store.listConversationSummaries(task.id);
    const latestSummaryFacts = summaries.at(-1)?.retainedFacts.join("\n") ?? "";

    expect(summaries).toHaveLength(2);
    expect(latestSummaryFacts).toContain("actual 3; expected 10");
    expect(context.systemPrompt).toContain("actual 3; expected 10");
    expect(context.systemPrompt).toContain("3 !== 10");
  });

  it("summarizes large tool payloads as references instead of copying raw edit output", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const hugePatch = "UI preview truncated should never be copied into model summary. ".repeat(420);
    const task: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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
    const previousMemoryDir = process.env["AGENT_WORKBENCH_MEMORY_DIR"];
    const memoryDir = mkdtempSync(join(tmpdir(), "agent-workbench-context-memory-"));
    const workRoot = mkdtempSync(join(tmpdir(), "agent-workbench-context-work-root-"));
    process.env["AGENT_WORKBENCH_MEMORY_DIR"] = memoryDir;
    try {
      const projectHash = createHash("sha256").update(resolve(workRoot)).digest("hex").slice(0, 20);
      mkdirSync(join(memoryDir, "projects", projectHash), { recursive: true });
      writeFileSync(join(memoryDir, "USER.md"), "# USER.md\n\n- Prefer concise Chinese engineering updates.\n");
      writeFileSync(join(memoryDir, "MEMORY.md"), "# MEMORY.md\n\n- Global memory marker for all Agent Workbench tasks.\n");
      writeFileSync(join(memoryDir, "projects", projectHash, "MEMORY.md"), "# MEMORY.md\n\n- Project scoped memory marker.\n");

      const assembler = new ContextAssembler(new InMemoryWorkbenchStore());
      const task: TaskDetail = {
        kind: "primary",
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
      expect(context.systemPrompt).toContain("Global memory marker for all Agent Workbench tasks.");
      expect(context.systemPrompt).toContain("### Project MEMORY.md");
      expect(context.systemPrompt).toContain("Project scoped memory marker.");
      expect(context.input).not.toContain("### Global USER.md");
    } finally {
      if (previousMemoryDir === undefined) delete process.env["AGENT_WORKBENCH_MEMORY_DIR"];
      else process.env["AGENT_WORKBENCH_MEMORY_DIR"] = previousMemoryDir;
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
      events: [
        {
          id: "event_runtime_user",
          taskId: "task_runtime_metadata",
          type: "user_message",
          createdAt: now,
          summary: "Inspect runtime metadata",
          payload: {}
        }
      ]
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
    expect(createLocalTaskTitle("请帮我检查 MCP 网络权限配置是否正确", "zh-CN")).toBe("检查 MCP 网络权限配置是否正确");
    expect(createLocalTaskTitle("Please debug the failing payment webhook tests", "en-US")).toBe("Debug the failing payment webhook tests");
    expect(createLocalTaskTitle("現在のプロジェクト構造を確認して改善案を出して", "ja-JP")).toContain("プロジェクト");
    expect(createLocalTaskTitle("현재 프로젝트 구조를 점검하고 개선안을 정리해줘", "ko-KR")).toContain("프로젝트");
  });

  it("keeps local fallback titles natural for paths, acronyms, and connector-heavy prompts", () => {
    expect(createLocalTaskTitle("In the current work root create or update validation-probe-lines.txt with five lines", "en-US")).toBe("Create or update validation-probe-lines.txt with five lines");
    expect(createLocalTaskTitle("Could you review the MCP/RAG API fallback behavior and report risks", "en-US")).toBe("Review the MCP/RAG API fallback behavior");
    expect(createLocalTaskTitle("请帮我检查自动命名以及前端实时更新是否卡顿", "zh-CN")).toBe("检查自动命名以及前端实时更新是否卡顿");
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

  it("returns a local title immediately for background-started tasks", async () => {
    let titleRequests = 0;
    const titleServer = createServer((_request, response) => {
      titleRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "不应阻塞创建" } }] }));
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

      const task = await workbench.startTask("请检查新任务建立后的后端自动命名流程");

      expect(task.title).toBe(createLocalTaskTitle("请检查新任务建立后的后端自动命名流程"));
      expect(task.status).toBe("running");
      expect(titleRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => titleServer.close(() => resolve()));
    }
  });
});

describe("Model provider configuration", () => {
  const model = { id: "mimo-v2.5", label: "Mimo v2.5", contextWindow: 128000, supportsTools: true, supportsThinking: false };

  it("keeps disabled providers out of active preferences", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });

    const active = await workbench.createModelProvider({
      vendor: "mimo",
      label: "Active Mimo",
      protocol: "openai_compatible",
      baseUrl: "https://mimo.example/v1",
      apiKey: "active-secret",
      models: [model],
      defaultModelId: model.id,
      enabled: true,
      makeActive: true
    });
    expect((await workbench.getPreferences()).activeModelProviderId).toBe(active.id);

    const disabled = await workbench.createModelProvider({
      vendor: "mimo",
      label: "Disabled Mimo",
      protocol: "openai_compatible",
      baseUrl: "https://disabled.example/v1",
      apiKey: "disabled-secret",
      models: [model],
      defaultModelId: model.id,
      enabled: false,
      makeActive: true
    });
    expect(disabled.enabled).toBe(false);
    expect((await workbench.getPreferences()).activeModelProviderId).toBe(active.id);

    await workbench.updateModelProvider(active.id, { enabled: false });
    expect((await workbench.getPreferences()).activeModelProviderId).toBe("");
  });

  it("rejects model providers whose default model is not configured", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });

    await expect(
      workbench.createModelProvider({
        vendor: "mimo",
        label: "Broken Mimo",
        protocol: "openai_compatible",
        baseUrl: "https://mimo.example/v1",
        apiKey: "broken-secret",
        models: [model],
        defaultModelId: "missing-model",
        enabled: true,
        makeActive: true
      })
    ).rejects.toThrow("defaultModelId must match a configured model");
  });

  it("tests model providers without leaking API keys", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const provider = await workbench.createModelProvider({
      vendor: "mimo",
      label: "Mimo health",
      protocol: "openai_compatible",
      baseUrl: "https://mimo.example/v1",
      apiKey: "sk-health-secret-123456",
      models: [model],
      defaultModelId: model.id,
      enabled: true,
      makeActive: true
    });

    const result = await workbench.testModelProvider(provider.id, async (_input, init) => {
      expect(String(init?.headers && new Headers(init.headers).get("Authorization"))).toContain("sk-health-secret-123456");
      return new Response(JSON.stringify({ error: { message: "Invalid API Key sk-health-secret-123456" } }), { status: 401 });
    });

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("provider_configuration");
    expect(result.statusCode).toBe(401);
    expect(result.error).toContain("Invalid API Key");
    expect(result.error).not.toContain("sk-health-secret-123456");
  });
});

describe("Tool surface selection", () => {
  it("exposes the stable tool surface without classifying user language", () => {
    const directTask: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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
      kind: "primary",
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

    const directNames = selectModelToolsForTask(directTask).map((tool) => tool.function.name);
    const inventoryNames = selectModelToolsForTask(inventoryTask).map((tool) => tool.function.name);
    const buildNames = selectModelToolsForTask(buildTask).map((tool) => tool.function.name);

    expect(directNames).toContain("read_file");
    expect(directNames).toContain("write_file");
    expect(inventoryNames).toEqual(directNames);
    expect(buildNames).toEqual(directNames);
  });

  it("uses explicit task graph role policy to restrict tools without parsing user text", () => {
    const inventoryTask: TaskDetail = {
      kind: "primary",
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
      kind: "primary",
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
    attachReadOnlyTaskGraph(inventoryTask);
    attachExplicitTaskGraph(buildTask);

    const inventoryNames = selectModelToolsForTask(inventoryTask).map((tool) => tool.function.name);
    const buildNames = selectModelToolsForTask(buildTask).map((tool) => tool.function.name);

    expect(inventoryNames).toEqual(["read_file", "search_files", "list_files", "web_search", "knowledge_search"]);
    expect(buildNames).toContain("write_file");
    expect(buildNames).toContain("run_command");
    expect(buildNames).toContain("plan_update");
    expect(buildNames).not.toContain("user_memory_add");
    expect(buildNames).not.toContain("skill_create");
  });

  it("spawns read-only subagent tasks, keeps child flow isolated, and projects completion back to the parent", async () => {
    class SubagentDelegationModel implements ModelClient {
      async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
        if (task.kind === "subagent") {
          if (task.events.some((event) => event.type === "tool_result")) {
            return { kind: "final", message: "Delegated comparison finished with the renderer evidence." };
          }
          return {
            kind: "tool_calls",
            calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "index.html" } }]
          };
        }
        if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "spawn_subagent")) {
          return { kind: "final", message: "Parent task continued after delegation." };
        }
        return {
          kind: "tool_calls",
          calls: [{
            id: createId("tool_call"),
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

    const root = mkdtempSync(join(tmpdir(), "agent-workbench-subagent-"));
    try {
      writeFileSync(join(root, "index.html"), "<html><body>delegated evidence</body></html>", "utf8");
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new SubagentDelegationModel() });
      const folder = await workbench.createTaskFolder({ name: "subagent-root", rootPath: root });
      await workbench.grantGlobalPermission("network", "allow subagent spawn");
      const parent = await workbench.createTask("Review the current implementation and delegate a focused comparison.", undefined, folder.id);
      const children = await workbench.listChildTasks(parent.id);

      expect(children).toHaveLength(1);
      const child = children[0]!;
      expect(child.kind).toBe("subagent");
      expect(child.parentTaskId).toBe(parent.id);
      expect(child.delegation?.sourceToolCallId).toBeTruthy();
      expect(child.delegation?.expectedOutput).toBe("comparison");
      expect(parent.events.some((event) => event.type === "subagent_spawned")).toBe(true);
      expect(parent.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")).toBe(false);

      let completedChild = child;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        completedChild = (await workbench.getTask(child.id)) ?? completedChild;
        if (completedChild.status === "completed") break;
      }

      expect(completedChild.status).toBe("completed");
      expect(completedChild.approvals).toHaveLength(0);

      const refreshedParent = await workbench.getTask(parent.id);
      const completion = refreshedParent?.events.find((event) => event.type === "subagent_completed");
      expect(completion?.payload["lastAssistantSummary"]).toBe("Delegated comparison finished with the renderer evidence.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a child task that tries to write files instead of requesting nested approval", async () => {
    class SubagentWriteFailureModel implements ModelClient {
      async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
        if (task.kind === "subagent") {
          return {
            kind: "tool_calls",
            calls: [{ id: createId("tool_call"), toolName: "edit_file", args: { path: "index.html", expectedHash: "abc", edits: [] } }]
          };
        }
        if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "spawn_subagent")) {
          return { kind: "final", message: "Parent delegation request sent." };
        }
        return {
          kind: "tool_calls",
          calls: [{ id: createId("tool_call"), toolName: "spawn_subagent", args: { goal: "Inspect and patch the HTML file." } }]
        };
      }
    }

    const root = mkdtempSync(join(tmpdir(), "agent-workbench-subagent-write-"));
    try {
      writeFileSync(join(root, "index.html"), "<html></html>", "utf8");
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new SubagentWriteFailureModel() });
      const folder = await workbench.createTaskFolder({ name: "subagent-write-root", rootPath: root });
      await workbench.grantGlobalPermission("network", "allow subagent spawn");
      const parent = await workbench.createTask("Delegate a child patch attempt for validation.", undefined, folder.id);
      const child = (await workbench.listChildTasks(parent.id))[0];

      expect(child).toBeTruthy();
      let failedChild = child!;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        failedChild = (await workbench.getTask(child!.id)) ?? failedChild;
        if (failedChild.status === "failed") break;
      }

      expect(failedChild.status).toBe("failed");
      expect(failedChild.approvals).toHaveLength(0);
      expect(failedChild.events.some((event) => event.type === "approval_pending")).toBe(false);

      const refreshedParent = await workbench.getTask(parent.id);
      expect(refreshedParent?.events.some((event) => event.type === "subagent_failed")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

class SecretTraceToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: "Fetched with api_key=sk-trace-output1234567890 and Bearer trace-bearer-output-secret"
    };
  }
}

class PassingCommandExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: "math tests passed"
    };
  }
}

class AmbiguousCommandExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: "math tests passed\n1 test failed"
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

class FailingReadFileExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: false,
      createdAt: nowIso(),
      output: "Path is outside the workspace.",
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

class ChatteryProgressToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall, options?: ToolExecutionOptions): Promise<ToolResult> {
    this.calls.push(call);
    for (let index = 1; index <= 240; index++) {
      await options?.onProgress?.({
        status: "running",
        operation: "list",
        progress: { processed: index * 64, unit: "bytes" },
        tail: `progress chunk ${index}`
      });
    }
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: JSON.stringify({ ok: true, files: ["README.md"] })
    };
  }
}

class LlmApprovalDecisionModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.id.includes(":llm_approval:")) {
      return {
        kind: "final",
        message: JSON.stringify({ allow: true, reason: "Read-only evidence is safe for this task." }),
        usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20, cachedTokens: 0 }
      };
    }
    if (task.events.some((event) => event.type === "tool_result")) {
      return { kind: "final", message: "Read completed." };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "note.txt" } }]
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

class RepeatingReadOnlyModel implements ModelClient {
  async next(): Promise<ModelTurn> {
    return {
      kind: "tool_calls",
      calls: [{
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "index.html" }
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

class ChunkedThinkingFinalModel implements ModelClient {
  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    await stream?.onThinkingDelta("用户 ");
    await stream?.onThinkingDelta("打招呼 “ ");
    await stream?.onThinkingDelta("你好啊 ”。这是 ");
    await stream?.onThinkingDelta("一个 简单的 问候 。");
    return { kind: "final", message: "你好！有什么可以帮忙的吗？", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class StreamingToolCallModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "list_files")) {
      return { kind: "final", message: "Listed the files.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    await stream?.onAssistantDelta("Now");
    await stream?.onAssistantDelta(" reading files.");
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "list_files", args: { path: "." } }],
      ...(stream?.streamId ? { streamId: stream.streamId } : {})
    };
  }
}

class EmptyResponseModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    return {
      kind: "empty_response",
      reason: "fixture empty stream",
      ...(stream?.streamId ? { streamId: stream.streamId } : {}),
      usage: { inputTokens: 12, outputTokens: 0 }
    };
  }
}

class EmptyThenFinalModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) {
      return { kind: "empty_response", reason: "fixture first empty", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    return { kind: "final", message: "Recovered after empty model turn.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class InternalContinuationThenFinalModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        kind: "final",
        message: "Internal continuity note. Do not quote this note verbatim or use it as the final answer: I still need to create the requested file.",
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }
    return { kind: "final", message: "Completed after continuing instead of exposing an internal note.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class LegacyPriorThinkingThenFinalModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        kind: "final",
        message:
          "Prior thinking retained for continuity:\nNow let me update the plan and do the final verification. Let me check all the files are in order.",
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }
    return { kind: "final", message: "Completed after continuing from a legacy retained-thinking response.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class StreamingLegacyPriorThinkingThenFinalModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) {
      await stream?.onAssistantDelta("Prior thinking retained for continuity:\n");
      await stream?.onAssistantDelta("Now let me update the plan and do the final verification.");
      return {
        kind: "final",
        message:
          "Prior thinking retained for continuity:\nNow let me update the plan and do the final verification. Let me check all the files are in order.",
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }
    return { kind: "final", message: "Completed after hiding the leaked continuity stream.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class RepeatedInternalContinuationModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    return {
      kind: "final",
      message: "Internal continuity note. Do not quote this note verbatim or use it as the final answer: I still need another tool call.",
      ...(stream?.streamId ? { streamId: stream.streamId } : {})
    };
  }
}

class InternalContinuationSeparatedByToolProgressModel implements ModelClient {
  calls = 0;

  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1 || this.calls === 3) {
      return {
        kind: "final",
        message: "Internal continuity note. Do not quote this note verbatim or use it as the final answer: I still need another tool-backed step.",
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }
    if (this.calls === 2) {
      return {
        kind: "tool_calls",
        calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "src/math.mjs" } }],
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }
    return { kind: "final", message: "Completed after tool-backed progress.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class AskUserThenFinishModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    const answer = [...task.events].reverse().find(
      (event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user" && String(event.payload["output"] ?? "").includes("answered")
    );
    if (answer) return { kind: "final", message: "User answer received." };
    return {
      kind: "tool_calls",
      calls: [{
        id: createId("tool_call"),
        toolName: "ask_user",
        args: { question: "Which option should I use?", options: ["A", "B"], required: true }
      }]
    };
  }
}

class OptionalAskAfterVerificationModel implements ModelClient {
  calls = 0;

  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    this.calls += 1;
    const askResolution = [...task.events].reverse().find(
      (event) =>
        event.type === "tool_result" &&
        event.payload["toolName"] === "ask_user" &&
        String(event.payload["output"] ?? "").includes("optional_follow_up_after_verified_progress")
    );
    if (askResolution) return { kind: "final", message: "Final answer after verified progress." };
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "run_command")) {
      return {
        kind: "tool_calls",
        calls: [{
          id: createId("tool_call"),
          toolName: "ask_user",
          args: { question: "测试已经通过。还需要我继续处理其他内容吗？" }
        }]
      };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "run_command", args: { command: "node tests/math.test.mjs" } }]
    };
  }
}

class AskHowToExplainEvidenceModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    const askResolution = [...task.events].reverse().find(
      (event) =>
        event.type === "tool_result" &&
        event.payload["toolName"] === "ask_user" &&
        String(event.payload["output"] ?? "").includes("answer_from_current_tool_evidence")
    );
    if (askResolution) return { kind: "final", message: "Final answer from outside workspace rejection evidence." };
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")) {
      return {
        kind: "tool_calls",
        calls: [{
          id: createId("tool_call"),
          toolName: "ask_user",
          args: {
            question: "工具层已拒绝越界读取，我应该如何解释这个结果？",
            details: "工具返回 Path is outside the workspace，需要基于当前证据回答。"
          }
        }]
      };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "../outside.txt" } }]
    };
  }
}

class PlainFinalModel implements ModelClient {
  constructor(private readonly message = "Done.") {}

  async next(): Promise<ModelTurn> {
    return { kind: "final", message: this.message };
  }
}

class ClaimedSearchEvidenceThenToolModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "search_files")) {
      return { kind: "final", message: "search_files returned the requested marker." };
    }
    if (task.events.some((event) => event.type === "model_no_progress" && event.payload["reason"] === "claimed_tool_evidence_without_result")) {
      return {
        kind: "tool_calls",
        calls: [{ id: createId("tool_call"), toolName: "search_files", args: { query: "AW-LIVE-FILE-TOOLS" } }]
      };
    }
    return { kind: "final", message: "search_files returned AW-LIVE-FILE-TOOLS." };
  }
}

class RepeatedClaimedEvidenceThenCleanFinalModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    const retryCount = task.events.filter((event) => event.type === "model_no_progress" && event.payload["reason"] === "claimed_tool_evidence_without_result").length;
    if (retryCount < 2) return { kind: "final", message: "knowledge_search found the requested marker." };
    return { kind: "final", message: "No tool evidence was used because the requested tool path was unavailable." };
  }
}

class FailedReadFileBoundaryModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")) {
      return { kind: "final", message: "read_file returned an outside workspace rejection." };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "../outside.txt" } }]
    };
  }
}

class FailedReadFileCategoryBoundaryModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file")) {
      return {
        kind: "final",
        message: [
          "尝试读取 ../outside.txt 失败，read_file 返回 Path is outside the workspace。",
          "list_files、search_files 等文件类工具也遵循相同的工作区边界规则。"
        ].join("\n")
      };
    }
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "read_file", args: { path: "../outside.txt" } }]
    };
  }
}

class ShortFinalModel implements ModelClient {
  async next(): Promise<ModelTurn> {
    return { kind: "final", message: "简短结论：继续检查错误处理。" };
  }
}

class LongFinalModel implements ModelClient {
  async next(_task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const message = "基于当前任务，我会给出完整、可追踪、可验证的工程结论。".repeat(12);
    await stream?.onAssistantDelta(message);
    return { kind: "final", message, ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class ToolDespiteForbiddenModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0]): Promise<ModelTurn> {
    if (task.events.some((event) => event.type === "tool_result")) return { kind: "final", message: "Answered from existing evidence." };
    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "list_files", args: { path: "." } }]
    };
  }
}

class GraphInjectingModel implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly attachGraph: (task: TaskDetail) => TaskGraph
  ) {}

  async next(task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    if (!taskGraphFromEvents(task)) this.attachGraph(task);
    return this.inner.next(task, stream);
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

class SelfClosingToolInvocationMarkupModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    if (task.events.filter((event) => event.type === "tool_result").length >= 2) {
      await stream?.onAssistantDelta("Reads verified.");
      return { kind: "final", message: "Reads verified.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    const message = [
      "I need to inspect two files.",
      "<tool_invocation name=\"read_file\" arguments={\"path\":\"src/math.mjs\"} />",
      "<tool_invocation name=\"read_file\" arguments={\"path\":\"src/totals.mjs\"} />"
    ].join("\n");
    await stream?.onAssistantDelta(message);
    return { kind: "final", message, ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }
}

class ToolIntentOnlyFinalThenCallModel implements ModelClient {
  calls = 0;

  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "write_file")) {
      return { kind: "final", message: "File created after tool execution.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    if (this.calls === 1) {
      const message = "Now step 4: write_file to create docs/file-tool-coverage.md with expectedHash = __new__.";
      await stream?.onAssistantDelta(message);
      return { kind: "final", message, ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    }
    return {
      kind: "tool_calls",
      calls: [{
        id: createId("tool_call"),
        toolName: "write_file",
        args: { path: "docs/file-tool-coverage.md", expectedHash: "__new__", content: "created" }
      }],
      ...(stream?.streamId ? { streamId: stream.streamId } : {})
    };
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
          messages: [{ role: "user", content: task.events.find((event) => event.type === "user_message")?.summary ?? "" }],
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

class SecretTraceRoundTripModel implements ModelClient {
  async next(task: Parameters<ModelClient["next"]>[0], stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const streamId = stream?.streamId ?? createId("model_stream");
    await stream?.onTrace?.({
      kind: "request",
      timestamp: nowIso(),
      streamId,
      provider: {
        protocol: "openai_compatible",
        model: "trace-secret-model",
        baseURL: "https://trace.example.test/v1?api_key=sk-trace-provider1234567890"
      },
      payload: {
        request: {
          messages: [{
            role: "user",
            content: task.events.find((event) => event.type === "user_message")?.summary ?? ""
          }]
        }
      }
    });
    if (!task.events.some((event) => event.type === "tool_result")) {
      const response: ModelTurn = {
        kind: "tool_calls",
        calls: [{
          id: createId("tool_call"),
          toolName: "list_files",
          args: {
            path: ".",
            apiKey: "sk-trace-arg1234567890",
            authorization: "Bearer trace-token-secret-123456",
            nested: { password: "trace-password-secret" }
          }
        }],
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
      await stream?.onTrace?.({
        kind: "response",
        timestamp: nowIso(),
        streamId,
        provider: { protocol: "openai_compatible", model: "trace-secret-model", baseURL: "https://trace.example.test/v1" },
        payload: { response }
      });
      return response;
    }
    const response: ModelTurn = { kind: "final", message: "Trace redaction complete.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
    await stream?.onTrace?.({
      kind: "response",
      timestamp: nowIso(),
      streamId,
      provider: { protocol: "openai_compatible", model: "trace-secret-model", baseURL: "https://trace.example.test/v1" },
      payload: { response }
    });
    return response;
  }
}

class UsageModel implements ModelClient {
  private calls = 0;

  constructor(private readonly usages: ModelTurn["usage"][] = [{
    inputTokens: 1000,
    outputTokens: 80,
    cachedTokens: 400,
    raw: { prompt_tokens: 1000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 400 } }
  }]) {}

  async next(): Promise<ModelTurn> {
    const usage = this.usages[Math.min(this.calls, this.usages.length - 1)];
    this.calls += 1;
    return {
      kind: "final",
      message: "Provider usage recorded.",
      ...(usage ? { usage } : {})
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
    expect(task.events.some((event) => event.type === "task_memory_created")).toBe(false);
  });

  it("creates a compiled task graph for broad implementation work", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new PlainFinalModel() });

    const task = await workbench.createTask("帮我在本文件夹中编写一个完整的 React 页面，修改后必须运行 npm.cmd run build。");
    const graph = taskGraphFromEvents(task);

    expect(graph?.nodes.some((node) => node.role === "implement")).toBe(true);
    expect(graph?.nodes.some((node) => node.role === "verify" && node.verification.required)).toBe(true);
    expect(graph?.nodes.flatMap((node) => node.verification.commands ?? [])).toContain("npm.cmd run build");
    expect(task.status).toBe("paused");
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(true);
  });

  it("treats target-mode repair goals as implementation work even when phrased as diagnosis", async () => {
    const task: TaskDetail = {
      kind: "primary",
      id: "task_target_repair_graph",
      title: "Target repair fixture",
      status: "running",
      runMode: "target",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_target_repair_graph",
          type: "user_message",
          createdAt: nowIso(),
          summary: "这个小项目跑不起来，帮我定位并修好，最后给出证据。请按你认为合适的方式检查当前文件夹，不要只给建议。",
          payload: {}
        }
      ]
    };

    const graph = compileTaskGraph(task);

    expect(graph?.nodes.some((node) => node.role === "implement")).toBe(true);
    expect(graph?.nodes.some((node) => node.role === "verify" && node.verification.required)).toBe(true);
  });

  it("keeps target-mode read-only requests on the research path", async () => {
    const task: TaskDetail = {
      kind: "primary",
      id: "task_target_readonly_graph",
      title: "Target read-only fixture",
      status: "running",
      runMode: "target",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_target_readonly_graph",
          type: "user_message",
          createdAt: nowIso(),
          summary: "先看一下为什么测试失败，暂时不用改代码，只诊断并告诉我风险。",
          payload: {}
        }
      ]
    };

    const graph = compileTaskGraph(task);

    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.nodes[0]?.role).toBe("research");
    expect(graph?.nodes[0]?.verification.required).toBe(false);
  });

  it("does not force a shell verification gate for documentation-only authoring", async () => {
    const task: TaskDetail = {
      kind: "primary",
      id: "task_doc_authoring_graph",
      title: "Document fixture",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_doc_authoring_graph",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Write concise API documentation from the source.",
          payload: {}
        }
      ]
    };

    const graph = compileTaskGraph(task);

    expect(graph?.nodes.some((node) => node.role === "implement")).toBe(true);
    expect(graph?.nodes.some((node) => node.role === "verify" && node.verification.required)).toBe(false);
    expect(graph?.nodes[0]?.verification.required).toBe(false);
  });

  it("does not satisfy required verification with a narrower command", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new SequenceToolModel([{ toolName: "run_command", args: { command: "npm.cmd test -- one.spec.ts" } }]),
      tools: new StubToolExecutor()
    });
    await workbench.grantGlobalPermission("shell", "fixture verification");

    const task = await workbench.createTask("修复测试失败，完成后必须运行 npm.cmd test。");
    const blocker = task.events.find((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true);

    expect(task.status).toBe("paused");
    expect(task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "run_command")).toBe(true);
    expect(task.events.some((event) => event.type === "verification_result_recorded" && event.payload["status"] === "passed")).toBe(false);
    expect(String(blocker?.summary ?? "")).toContain("Remaining required command(s): npm.cmd test");
  });

  it("routes configured local tool attempts through permission instead of user-text filters", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new ConfiguredToolModelClient("Get-Process"),
      tools: new StubToolExecutor()
    });

    const task = await workbench.createTask("请直接回答当前对话内容");

    expect(task.status).toBe("waiting_approval");
    expect(task.events.some((event) => event.type === "tool_requested")).toBe(true);
    expect(task.events.some((event) => event.type === "tool_result")).toBe(false);
  });

  it("keeps follow-up tool execution governed by approval grants, not natural-language denial", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new ConfiguredToolModelClient("Get-Process"),
      tools: new StubToolExecutor()
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    const completed = await workbench.decideApproval(created.id, approval.id, "allow_for_task");
    const firstToolRequests = completed.events.filter((event) => event.type === "tool_requested").length;

    const followed = await workbench.appendMessage(completed.id, "基于刚才结果再整理一版。");
    const longFollowed = await workbench.appendMessage(completed.id, "再补充一版简短结论。");

    expect(followed.status).toBe("completed");
    expect(longFollowed.status).toBe("completed");
    expect(longFollowed.events.filter((event) => event.type === "tool_requested")).toHaveLength(firstToolRequests + 2);
    expect(longFollowed.events.filter((event) => event.type === "task_memory_created")).toHaveLength(3);
  });

  it("records task memory from the latest meaningful request instead of a greeting title", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new ConfiguredToolModelClient("Get-Process"),
      tools: new StubToolExecutor()
    });
    const greeting = await workbench.createTask("你好");
    const waiting = await workbench.appendMessage(greeting.id, "帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
    const approval = waiting.approvals[0];
    if (!approval) throw new Error("expected approval");

    const completed = await workbench.decideApproval(waiting.id, approval.id, "allow_for_task");
    const memories = await workbench.listTaskMemories();

    expect(completed.events.filter((event) => event.type === "task_memory_created")).toHaveLength(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.title).toContain("桌面运行的软件");
    expect(memories[0]?.goal).toContain("桌面运行的软件");
  });

  it("records short no-tool completions when the task itself is substantive", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new ShortFinalModel()
    });

    await workbench.createTask("请用一句话总结当前项目需要优先补齐的稳定性问题。");
    await workbench.createTask("请再用一句话补充一个不同的维护建议。");
    const memories = await workbench.listTaskMemories();

    expect(memories).toHaveLength(2);
    expect(memories[0]?.goal.length).toBeGreaterThanOrEqual(8);
    expect(memories[1]?.goal.length).toBeGreaterThanOrEqual(8);
  });

  it("auto-renames a local fallback title at most once after a long response", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new LongFinalModel()
    });
    const renamed = await workbench.createTask("帮我检查项目中的上下文问题并总结修复建议");
    const titleEvents = renamed.events.filter((event) => event.type === "task_title_updated");

    expect(renamed.title).toContain("检查项目中的上下文问题");
    expect(titleEvents).toHaveLength(1);
    expect(titleEvents[0]?.payload["source"]).toBe("auto");

    const repeated = await workbench.appendMessage(renamed.id, "继续补充说明");
    expect(repeated.events.filter((event) => event.type === "task_title_updated")).toHaveLength(1);
  });

  it("does not auto-rename a user-supplied title", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new LongFinalModel()
    });

    const completed = await workbench.createTask("帮我检查项目中的上下文问题并总结修复建议", "手动标题");

    expect(completed.title).toBe("手动标题");
    expect(completed.events.some((event) => event.type === "task_title_updated")).toBe(false);
  });

  it("sends direct-answer tool attempts into the normal permission path", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new ToolDespiteForbiddenModel(),
      tools
    });

    const pending = await workbench.createTask("直接根据当前对话回答就行");
    const approval = pending.approvals[0];
    if (!approval) throw new Error("expected approval");

    expect(pending.status).toBe("waiting_approval");
    expect(tools.calls).toHaveLength(0);
    expect(pending.events.some((event) => event.type === "tool_requested")).toBe(true);
    expect(pending.events.some((event) => event.type === "tool_result")).toBe(false);

    const completed = await workbench.decideApproval(pending.id, approval.id, "allow_once");
    expect(completed.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
    expect(completed.events.some((event) => event.type === "tool_result" && event.payload["ok"] === true)).toBe(true);
  });

  it("pauses a React code-change task when the model tries to finish without verification evidence", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new GraphInjectingModel(new PlainFinalModel(), attachVerificationTaskGraph) });

    const task = await workbench.createTask("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");

    expect(task.status).toBe("paused");
    expect(task.events.some((event) => event.type === "task_graph_created")).toBe(true);
    expect(task.events.some((event) => event.type === "task_memory_created")).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(true);
  });

  it("pauses when a final answer claims tool evidence without a matching tool result", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new PlainFinalModel("knowledge_search 查询到 COMBINED-KNOWLEDGE-MARKER，web_search 返回 AW-COMBINED-WEB-MARKER。")
    });

    const task = await workbench.createTask("Use knowledge and web search.");
    const blocker = task.events.find((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true);

    expect(task.status).toBe("paused");
    expect(String(blocker?.summary ?? "")).toMatch(/claimed knowledge_search evidence/i);
    expect(blocker?.payload["blockedFinalMessage"]).toContain("COMBINED-KNOWLEDGE-MARKER");
    expect(task.events.some((event) => event.type === "task_memory_created")).toBe(false);
  });

  it("pauses when a final answer claims file tool evidence without a matching tool result", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new PlainFinalModel("我已调用 search_files 搜索 AW-LIVE-FILE-TOOLS，并用 write_file 写入 docs/file-tool-coverage.md。")
    });

    const task = await workbench.createTask("Verify file tools.");
    const blocker = task.events.find((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true);

    expect(task.status).toBe("paused");
    expect(String(blocker?.summary ?? "")).toMatch(/claimed search_files evidence/i);
  });

  it("retries once when claimed tool evidence can be repaired by running the missing tool", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ClaimedSearchEvidenceThenToolModel()
    });
    await workbench.grantGlobalPermission("workspace_read", "fixture read");

    const task = await workbench.createTask("Find the marker with search_files.");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "model_no_progress" && event.payload["reason"] === "claimed_tool_evidence_without_result")).toBe(true);
    expect(task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "search_files")).toBe(true);
  });

  it("allows a second claimed-evidence retry before accepting a clean final answer", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new RepeatedClaimedEvidenceThenCleanFinalModel()
    });

    const task = await workbench.createTask("Answer after a denied or unavailable tool path.");
    const retries = task.events.filter((event) => event.type === "model_no_progress" && event.payload["reason"] === "claimed_tool_evidence_without_result");

    expect(task.status).toBe("completed");
    expect(retries).toHaveLength(2);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(false);
    expect(task.events.some((event) => event.type === "task_memory_created")).toBe(true);
  });

  it("does not block a final answer that explicitly says tool evidence was not used", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new PlainFinalModel("I did not call knowledge_search; no tool evidence was used.")
    });

    const task = await workbench.createTask("Answer without using tools.");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(false);
  });

  it("does not block final answers that mention tool names only as alternatives", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new PlainFinalModel(
        [
          "工具审批被拒绝，我无法执行 cd 命令。",
          "仍然可以做的事情：",
          "1. 用 list_files 查看当前工作区的文件列表。",
          "2. 用 search_files 在工作区中搜索文件路径或内容。",
          "3. 用 web_search / knowledge_search 搜索网络或本地知识库。",
          "如果你愿意，我可以直接用 list_files 作为替代方案。"
        ].join("\n")
      )
    });

    const task = await workbench.createTask("Explain the denied tool path.");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(false);
  });

  it("allows final answers to cite failed tool results as boundary evidence", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new FailingReadFileExecutor(),
      model: new FailedReadFileBoundaryModel()
    });
    await workbench.grantGlobalPermission("workspace_read", "fixture read");

    const task = await workbench.createTask("Check whether read_file can leave the work root.");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file" && event.payload["ok"] === false)).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(false);
  });

  it("does not require every file tool to run when explaining a shared boundary rule", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new FailingReadFileExecutor(),
      model: new FailedReadFileCategoryBoundaryModel()
    });
    await workbench.grantGlobalPermission("workspace_read", "fixture read");

    const task = await workbench.createTask("Check whether read_file can leave the work root.");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file" && event.payload["ok"] === false)).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.payload["completionBlocked"] === true)).toBe(false);
  });

  it("records verification command evidence and permits completion after it passes", async () => {
    const store = new InMemoryWorkbenchStore();
    await store.savePreferences({ ...(await store.getPreferences()), autoApprove: "all", updatedAt: nowIso() });
    const workbench = new AgentWorkbench({
      store,
      model: new GraphInjectingModel(new SequenceToolModel([{ toolName: "run_command", args: { command: "npm.cmd run build" } }]), attachVerificationTaskGraph),
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
      model: new GraphInjectingModel(new SequenceToolModel([{ toolName: "run_command", args: { command: "npm.cmd run build" } }]), attachVerificationTaskGraph),
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
    expect(engine.assess("run_command", { command: "npm test 2>&1" }).category).toBe("shell");
    expect(engine.assess("run_command", { command: "npm test > results.log 2>&1" }).category).toBe("workspace_write");
    expect(engine.assess("run_command", { command: "npm view left-pad version" }).category).toBe("network");
  });

  it("escalates commands that combine external access with mutation", () => {
    const engine = new PermissionEngine();
    expect(engine.assess("run_command", { command: "npm install left-pad" }).category).toBe("shell");
    expect(engine.assess("run_command", { command: "git push origin main" }).category).toBe("shell");
    expect(engine.assess("run_command", { command: "curl https://example.com > out.txt" }).category).toBe("shell");
  });

  it("keeps interpreter-wrapped deletions in the destructive category", () => {
    const engine = new PermissionEngine();
    expect(engine.assess("run_command", { command: "node -e \"require('fs').rmSync('x', { recursive: true, force: true })\"" }).category).toBe("destructive");
    expect(engine.assess("run_command", { command: "python -c \"import shutil; shutil.rmtree('x', ignore_errors=True)\"" }).category).toBe("destructive");
  });

  it("does not downgrade shell file-body reads to workspace_read", () => {
    const engine = new PermissionEngine();
    expect(engine.assess("run_command", { command: "Get-Content index.html | Select-Object -First 50" }).category).toBe("shell");
    expect(engine.assess("run_command", { command: "rg \"hero\" src" }).category).toBe("shell");
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
      { toolName: "web_search", args: { query: "Agent Workbench" }, riskCategory: "network" },
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

  it("records running progress before final file tool results", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-tool-progress-"));
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SingleToolModel("write_file", {
          path: "generated.txt",
          expectedHash: "__new__",
          content: Array.from({ length: 220 }, (_, index) => `line ${index}`).join("\n")
        })
      });
      const folder = await workbench.createTaskFolder({ name: "progress-root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "progress test");

      const completed = await workbench.createTask("create a generated note", "Create generated note", folder.id);
      const started = completed.events.find((event) => event.type === "tool_started");
      const progressEvents = completed.events.filter((event) => event.type === "tool_progress");
      const progress = progressEvents[0];
      const result = completed.events.find((event) => event.type === "tool_result");
      const output = JSON.parse(String(result?.payload["output"] ?? "{}")) as Record<string, unknown>;
      const changes = output["changes"] as Record<string, unknown>;

      expect(started?.payload["toolName"]).toBe("write_file");
      expect(String(progress?.payload["targetPath"] ?? "")).toMatch(/generated\.txt$/);
      expect(progressEvents.map((event) => event.payload["operation"])).toEqual(expect.arrayContaining(["hash_check", "diff", "create", "commit", "verify"]));
      expect(progressEvents.map((event) => event.payload["message"])).toEqual(expect.arrayContaining([
        "Confirmed new-file write intent.",
        "Computed create diff: +220 / -0 lines.",
        "Writing file content.",
        "File write committed; verifying written hash.",
        "Verified written file hash."
      ]));
      expect(result?.payload["ok"]).toBe(true);
      expect(changes["addedLines"]).toBeGreaterThan(200);
      expect(output["displayMode"]).toBe("summary_only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can use experimental LLM approval only for non-destructive tool approvals", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-llm-approval-"));
    try {
      writeFileSync(join(root, "note.txt"), "approval evidence\n", "utf8");
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({
        store,
        model: new LlmApprovalDecisionModel()
      });
      const folder = await workbench.createTaskFolder({ name: "approval-root", rootPath: root });
      await workbench.updatePreferences({
        permissionMode: "auto_approval",
        autoApproveRiskCategories: ["host_observation"],
        llmApprovalMode: "non_destructive"
      });

      const completed = await workbench.createTask("read the note file", "Read note", folder.id);
      const autoApproval = completed.events.find((event) => event.type === "approval_auto_granted");
      const result = completed.events.find((event) => event.type === "tool_result");

      expect(completed.status).toBe("completed");
      expect(autoApproval?.payload["approvalSource"]).toBe("llmApproval");
      expect(autoApproval?.payload["riskCategory"]).toBe("workspace_read");
      expect(result?.payload["ok"]).toBe(true);
      expect(completed.events.some((event) => event.type === "token_usage_recorded")).toBe(true);
      expect(completed.approvals).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let experimental LLM approval bypass destructive tools", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new SingleToolModel("run_command", { command: "Stop-Process -Id 99999" })
    });
    await workbench.updatePreferences({
      permissionMode: "auto_approval",
      autoApproveRiskCategories: ["host_observation", "workspace_read", "network"],
      llmApprovalMode: "non_destructive"
    });

    const pending = await workbench.createTask("attempt a dangerous command", "Dangerous command");

    expect(pending.status).toBe("waiting_approval");
    expect(pending.approvals[0]?.riskCategory).toBe("destructive");
    expect(pending.events.some((event) => event.type === "approval_auto_granted")).toBe(false);
    expect(pending.events.some((event) => event.type === "tool_result")).toBe(false);
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

  it("pauses repeated read-only exploration that stops producing progress", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new RepeatingReadOnlyModel()
    });
    await workbench.grantGlobalPermission("workspace_read", "loop guard");

    const paused = await workbench.createTask("inspect the same file until the loop guard fires");
    const noProgress = paused.events.find((event) => event.type === "model_no_progress");

    expect(paused.status).toBe("paused");
    expect(noProgress?.payload["reason"]).toBe("repeated_read_only_tools");
    expect(Number(noProgress?.payload["readOnlyToolCount"])).toBeGreaterThanOrEqual(16);
  });

  it("writes per-task model trace logs across model requests and tool results", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-model-trace-"));
    const traceRoot = mkdtempSync(join(tmpdir(), "agent-workbench-trace-"));
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({
      store,
      tools: new StubToolExecutor(),
      model: new TraceEmittingToolRoundTripModel(),
      traceRoot
    });
    const folder = await workbench.createTaskFolder({ name: "trace-folder", rootPath: workRoot });
    await workbench.grantGlobalPermission("workspace_read", "trace logging");

    const completed = await workbench.createTask("trace the full request-response loop", undefined, folder.id);
    const tracePath = join(traceRoot, completed.id, "trace.jsonl");

    expect(existsSync(tracePath)).toBe(true);
    expect(existsSync(join(workRoot, "data", "logs", "model-traces"))).toBe(false);
    const entries = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const kinds = entries.map((entry) => String(entry["kind"] ?? ""));
    const modelRequest = entries.find((entry) => entry["kind"] === "model_request");
    const modelResponse = entries.find((entry) => entry["kind"] === "model_response");

    expect(kinds).toContain("model_turn_started");
    expect(kinds).toContain("model_request");
    expect(kinds).toContain("model_response");
    expect(kinds).toContain("tool_requested");
    expect(kinds).toContain("tool_result");
    expect(kinds.filter((kind) => kind === "model_turn_started")).toHaveLength(2);
    expect(modelRequest?.["payload"]).toMatchObject({
      request: {
        messageSummary: {
          count: expect.any(Number),
          roleCounts: expect.any(Object)
        }
      }
    });
    expect(JSON.stringify(modelRequest?.["payload"] ?? {})).not.toContain("\"messages\":");
    expect(modelResponse?.["payload"]).toMatchObject({
      response: {
        kind: expect.any(String)
      }
    });

    rmSync(workRoot, { recursive: true, force: true });
    rmSync(traceRoot, { recursive: true, force: true });
  });

  it("redacts secrets from model trace requests, tool arguments, and tool results", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-model-trace-secret-"));
    const traceRoot = mkdtempSync(join(tmpdir(), "agent-workbench-secret-trace-"));
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools: new SecretTraceToolExecutor(),
        model: new SecretTraceRoundTripModel(),
        traceRoot
      });
      const folder = await workbench.createTaskFolder({ name: "trace-secret-folder", rootPath: workRoot });
      await workbench.grantGlobalPermission("workspace_read", "trace secret logging");

      const completed = await workbench.createTask(
        "trace redaction with api_key=sk-traceprompt1234567890 and Bearer trace-prompt-token-secret",
        undefined,
        folder.id
      );
      const traceText = readFileSync(join(traceRoot, completed.id, "trace.jsonl"), "utf8");

      expect(completed.status).toBe("completed");
      expect(traceText).toContain("model_request");
      expect(traceText).toContain("model_response");
      expect(traceText).toContain("tool_requested");
      expect(traceText).toContain("tool_result");
      expect(traceText).toContain("[redacted-secret]");
      expect(traceText).toContain("Bearer [redacted-token]");
      expect(traceText).not.toContain("sk-traceprompt1234567890");
      expect(traceText).not.toContain("trace-prompt-token-secret");
      expect(traceText).not.toContain("sk-trace-provider1234567890");
      expect(traceText).not.toContain("sk-trace-arg1234567890");
      expect(traceText).not.toContain("trace-token-secret-123456");
      expect(traceText).not.toContain("trace-password-secret");
      expect(traceText).not.toContain("sk-trace-output1234567890");
      expect(traceText).not.toContain("trace-bearer-output-secret");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(traceRoot, { recursive: true, force: true });
    }
  });

  it("coalesces noisy progress streams before persisting task events and trace", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-progress-trace-"));
    const traceRoot = mkdtempSync(join(tmpdir(), "agent-workbench-progress-trace-"));
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools: new ChatteryProgressToolExecutor(),
        model: new SingleToolModel("list_files", { path: "." }),
        traceRoot
      });
      const folder = await workbench.createTaskFolder({ name: "progress-trace", rootPath: workRoot });
      await workbench.grantGlobalPermission("workspace_read", "trace progress coalescing");

      const completed = await workbench.createTask("list files with very noisy progress", undefined, folder.id);
      const progressEvents = completed.events.filter((event) => event.type === "tool_progress");
      const traceEntries = readFileSync(join(traceRoot, completed.id, "trace.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const progressTraceEntries = traceEntries.filter((entry) => entry["kind"] === "tool_progress");

      expect(completed.status).toBe("completed");
      expect(progressEvents.length).toBeLessThanOrEqual(3);
      expect(progressTraceEntries.length).toBeLessThanOrEqual(3);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(traceRoot, { recursive: true, force: true });
    }
  });

  it("persists an attention trace fixture for manual audit", async () => {
    const outDir = resolve("data", "test-reports", "attention-first-trace");
    const workRoot = join(outDir, "workroot");
    const traceRoot = join(outDir, "traces");
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
                reasoning_content: "I should inspect the workspace before answering.",
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
        model: "mimo-v2.5",
        contextAssembler: assembler
      });
      const workbench = new AgentWorkbench({
        store,
        contextAssembler: assembler,
        model,
        tools: new ShellToolExecutor(),
        traceRoot
      });
      const folder = await workbench.createTaskFolder({ name: "attention-trace", rootPath: workRoot });
      await workbench.grantGlobalPermission("workspace_read", "manual trace fixture");

      const completed = await workbench.createTask("Trace the full request-response loop by listing files.", undefined, folder.id);
      const tracePath = join(traceRoot, completed.id, "trace.jsonl");
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
      expect(String(requestMessages[0]?.at(-1)?.["content"] ?? "")).toContain("Trace the full request-response loop");
      expect(String(requestMessages[0]?.at(-1)?.["content"] ?? "")).not.toContain("Active Node");
      expect(requestMessages[1]?.some((message) => message["role"] === "tool")).toBe(true);
      expect(requestMessages[0]?.some((message) => "reasoning_content" in message)).toBe(false);
      const replayedToolCallMessage = requestMessages[1]?.find((message) => Array.isArray(message["tool_calls"]));
      expect(replayedToolCallMessage?.["content"]).toBe("");
      expect(replayedToolCallMessage?.["reasoning_content"]).toBe("I should inspect the workspace before answering.");
      expect(String(requestMessages[1]?.find((message) => message["role"] === "tool")?.["content"] ?? "")).toContain("README.md");
      expect(String(requestMessages[1]?.[0]?.["content"] ?? "")).not.toContain("## Known Files");
      const lastUser = requestMessages[1]?.filter((message) => message["role"] === "user").at(-1);
      expect(String(lastUser?.["content"] ?? "")).toContain("Trace the full request-response loop");

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
          "- Request 1 ends with the real user message.",
          "- Request 2 includes the tool role result while keeping the last user message real.",
          "- Task events include tool request, tool result, and assistant final message."
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

  it("migrates rule auto-approval strategy preferences and applies custom risk coverage", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({
      store,
      tools: new StubToolExecutor(),
      model: new SingleToolModel("run_command", { command: "Write-Output ok" })
    });

    const migrated = await workbench.updatePreferences({ autoApprove: "medium" });
    expect(migrated.permissionMode).toBe("auto_approval");
    expect(migrated.autoApproveStrategy).toBe("balanced");
    expect(migrated.autoApproveRiskCategories).toEqual(["host_observation", "workspace_read", "network"]);

    await workbench.updatePreferences({ permissionMode: "auto_approval", autoApproveStrategy: "custom", autoApproveRiskCategories: ["shell"] });
    const completed = await workbench.createTask("run a harmless command with custom shell approval");
    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "approval_auto_granted" && event.payload["approvalSource"] === "autoApprove")).toBe(true);
    expect((await store.getPreferences()).autoApproveRiskCategories).toEqual(["shell"]);
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
    expect(thinking.every((event) => event.payload["uiHidden"] !== true)).toBe(true);
    expect(deltas.map((event) => event.summary).join("")).toBe("Hello stream.");
    expect(final?.summary).toBe("Hello stream.");
    expect(final?.payload["streamId"]).toBe(deltas[0]?.payload["streamId"]);
    expect(final?.payload["reasoningContent"]).toBe("Checking the request and available evidence.");
  });

  it("reconstructs chunked streaming thinking without artificial newlines for provider replay", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ChunkedThinkingFinalModel() });

    const completed = await workbench.createTask("你好啊");
    const thinking = completed.events.filter((event) => event.type === "thinking_delta");
    const final = completed.events.find((event) => event.type === "assistant_message");

    expect(completed.status).toBe("completed");
    expect(thinking).toHaveLength(4);
    expect(final?.payload["reasoningContent"]).toBe("用户 打招呼 “ 你好啊 ”。这是 一个 简单的 问候 。");
    expect(String(final?.payload["reasoningContent"] ?? "")).not.toContain("\n");
  });

  it("preserves readable streaming assistant preambles when the turn continues into tool calls", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingToolCallModel(), tools });
    await workbench.grantGlobalPermission("workspace_read", "tool turn preamble");

    const completed = await workbench.createTask("inspect the current folder");
    const preambleDeltas = completed.events.filter((event) => event.type === "assistant_delta");

    expect(completed.status).toBe("completed");
    expect(tools.calls.map((call) => call.toolName)).toEqual(["list_files"]);
    expect(preambleDeltas.map((event) => event.summary).join("")).toBe("Now reading files.");
    expect(preambleDeltas.every((event) => event.payload["uiHidden"] !== true)).toBe(true);
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

  it("continues execution when a provider returns self-closing tool invocation markup as text", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools, model: new SelfClosingToolInvocationMarkupModel() });
    await workbench.grantGlobalPermission("workspace_read", "inline markup regression");

    const completed = await workbench.createTask("read two files before answering");

    expect(completed.status).toBe("completed");
    expect(tools.calls.map((call) => call.toolName)).toEqual(["read_file", "read_file"]);
    expect(tools.calls.map((call) => call.args["path"])).toEqual(["src/math.mjs", "src/totals.mjs"]);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("<tool_invocation"))).toBe(false);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("Reads verified"))).toBe(true);
  });

  it("retries instead of completing on final answers that only announce a pending tool call", async () => {
    const tools = new StubToolExecutor();
    const model = new ToolIntentOnlyFinalThenCallModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools, model });
    await workbench.grantGlobalPermission("workspace_write", "fixture write");

    const completed = await workbench.createTask("create the requested file");

    expect(model.calls).toBe(3);
    expect(completed.status).toBe("completed");
    expect(tools.calls.map((call) => call.toolName)).toEqual(["write_file"]);
    expect(completed.events.some((event) => event.type === "model_no_progress" && event.payload["reason"] === "internal_continuation_final")).toBe(true);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.startsWith("Now step 4"))).toBe(false);
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary === "File created after tool execution.")).toBe(true);
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
    const attachmentContent = "# Notes\nImportant fixture content with api_key=sk-attachment-secret1234567890.";
    const uploaded = await workbench.uploadTaskAttachment({
      fileName: "notes.md",
      mimeType: "text/markdown",
      size: Buffer.byteLength(attachmentContent),
      dataBase64: Buffer.from(attachmentContent).toString("base64")
    });

    try {
      const task = await workbench.createTask("summarize attached notes", "Summarize notes", undefined, [uploaded.id]);
      const linked = await workbench.listTaskAttachments(task.id);
      const context = await assembler.assemble(task);
      const storedBytes = readFileSync(uploaded.storagePath, "utf8");

      expect(linked).toHaveLength(1);
      expect(linked[0]?.taskId).toBe(task.id);
      expect(existsSync(uploaded.storagePath)).toBe(true);
      expect(storedBytes).toContain("__agentWorkbenchEncryptedFile");
      expect(storedBytes).not.toContain("Important fixture content");
      expect(storedBytes).not.toContain("sk-attachment-secret1234567890");
      expect(task.events.some((event) => event.type === "attachment_added")).toBe(true);
      expect(context.systemPrompt).toContain("notes.md (markdown");
      expect(context.systemPrompt).toContain("Important fixture content");
      expect(context.systemPrompt).toContain("[redacted-secret]");
      expect(context.systemPrompt).not.toContain("sk-attachment-secret1234567890");
    } finally {
      await workbench.deleteTaskAttachment(uploaded.id);
    }
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

  it("rejects invalid scheduled task interval patches instead of silently coercing them", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
    const scheduled = await workbench.createScheduledTask({
      title: "Frequent note",
      prompt: "summarize the latest project state",
      folderId: "default",
      scheduleKind: "interval",
      intervalHours: 0,
      intervalMinutes: 5
    });

    await expect(workbench.updateScheduledTask(scheduled.id, { intervalHours: 0, intervalMinutes: 0 })).rejects.toThrow(
      /greater than 0/i
    );
    expect((await store.getScheduledTask(scheduled.id))?.schedule.intervalMinutes).toBe(5);
  });

  it("executes web_search through permission grants and records search evidence", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            { title: "Agent Workbench docs", url: `http://example.test${request.url ?? ""}`, snippet: "Workbench documentation" },
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
        model: new SingleToolModel("web_search", { query: "agent workbench", limit: 2 })
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
      expect(JSON.stringify(searchEvent?.payload)).toContain("Agent Workbench docs");
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
          RelatedTopics: [{ Text: "Agent Workbench - Built-in fallback result", FirstURL: "https://example.test/agent-workbench" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    try {
      const executor = new WebSearchToolExecutor(new InMemoryWorkbenchStore());
      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "web_search",
        args: { query: "agent workbench", limit: 1 }
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("builtin_duckduckgo");
      expect(result.output).toContain("Built-in fallback result");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps legacy custom web search endpoints usable without templates", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Legacy custom search",
              url: `https://example.test/search?q=${url.searchParams.get("q") ?? ""}`,
              snippet: `limit=${url.searchParams.get("limit") ?? ""}`
            }
          ]
        })
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      await store.saveWebSearchProvider({
        id: "legacy_custom_search",
        label: "Legacy custom search",
        kind: "custom",
        endpoint: `http://127.0.0.1:${port}/search`,
        enabled: true,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      const result = await new WebSearchToolExecutor(store).execute({
        id: createId("tool_call"),
        toolName: "web_search",
        args: { query: "agent workbench", limit: 2 }
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Legacy custom search");
      expect(result.output).toContain("agent workbench");
      expect(result.output).toContain("limit=2");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("clears stale web search endpoint and API key when switching provider kind", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    const provider = await workbench.createWebSearchProvider({
      label: "Custom search",
      kind: "custom",
      endpoint: "https://search.example.test?q={query}",
      apiKey: "custom-search-secret",
      enabled: true
    });

    const updated = await workbench.updateWebSearchProvider(provider.id, {
      kind: "duckduckgo",
      label: "DuckDuckGo",
      enabled: true
    });

    expect(updated.kind).toBe("duckduckgo");
    expect(updated.endpoint).toBeUndefined();
    expect(updated.apiKeyRef).toBeUndefined();
    expect(await store.getWebSearchProviderSecret(provider.id)).toBeUndefined();
  });

  it("uses stored custom web search API keys through placeholders without exposing endpoint secrets", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Authenticated custom search",
              url: "https://example.test/authenticated",
              snippet: `key=${url.searchParams.get("api_key") ?? ""}; query=${url.searchParams.get("q") ?? ""}`
            }
          ]
        })
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({ store });
      const provider = await workbench.createWebSearchProvider({
        label: "Authenticated custom search",
        kind: "custom",
        endpoint: `http://127.0.0.1:${port}/search?q={query}&api_key={apiKey}`,
        apiKey: "custom-placeholder-secret",
        enabled: true
      });

      expect(provider.endpoint).toContain("{apiKey}");
      expect(JSON.stringify(provider)).not.toContain("custom-placeholder-secret");

      const result = await new WebSearchToolExecutor(store).execute({
        id: createId("tool_call"),
        toolName: "web_search",
        args: { query: "agent workbench", limit: 1 }
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("custom-placeholder-secret");
      expect(result.output).toContain("agent workbench");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects incomplete side capability provider configuration before runtime", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore() });

    await expect(workbench.createWebSearchProvider({
      label: "Broken custom search",
      kind: "custom",
      enabled: true
    })).rejects.toThrow(/requires an endpoint/i);

    await expect(workbench.createWebSearchProvider({
      label: "Broken template",
      kind: "custom",
      endpoint: "https://example.test/search?limit={limit}",
      enabled: true
    })).rejects.toThrow(/\{query\}/i);

    await expect(workbench.createWebSearchProvider({
      label: "Broken protocol",
      kind: "duckduckgo",
      endpoint: "file:///tmp/search",
      enabled: true
    })).rejects.toThrow(/http or https/i);

    await expect(workbench.createWebSearchProvider({
      label: "Embedded secret",
      kind: "custom",
      endpoint: "https://example.test/search?q={query}&api_key=plain-secret-123456",
      enabled: true
    })).rejects.toThrow(/embedding secrets/i);

    await expect(workbench.createIntegrationProvider({
      kind: "discord",
      label: "Bad callback",
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      callbackUrl: "file:///tmp/callback",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: false
    })).rejects.toThrow(/http or https/i);
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
      content: "Agent Workbench should ask before risky tools and reuse task grants after approval.",
      tags: ["permissions"]
    });
    const search = await workbench.searchKnowledge({ query: "risky approval grants", projectId: "default", limit: 2 });
    const embeddings = await store.listKnowledgeEmbeddings();
    await workbench.grantGlobalPermission("workspace_read", "knowledge search smoke");
    const completed = await workbench.createTask("search stored approval policy");

    expect(item.indexStatus).toBe("indexed");
    expect(item.chunkCount).toBeGreaterThan(0);
    expect(embeddings).toHaveLength(0);
    expect(search[0]?.item.id).toBe(item.id);
    expect(search[0]?.matchedFields).toContain("content");
    expect(search[0]?.rankReason).toContain("Matched");
    expect(search[0]?.highlights?.some((highlight) => highlight.text.includes("risky tools"))).toBe(true);
    expect(search[0]?.rerankStatus).toBe("applied");
    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "tool_result" && String(event.payload["output"] ?? "").includes("Approval notes"))).toBe(true);
    expect(search[0]?.citation?.title).toBe("Approval notes");
    expect(search[0]?.citation?.excerpt).toContain("ask before risky tools");
  });

  it("defaults knowledge_search to the active task folder scope", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({
      store,
      tools: new CompositeToolExecutor(new StubToolExecutor(), [new KnowledgeSearchToolExecutor(store)]),
      model: new SingleToolModel("knowledge_search", { query: "folder scoped deploy note", limit: 2 })
    });
    const folder = await workbench.createTaskFolder({ name: "Project A", rootPath: defaultTaskWorkRoot() });
    await workbench.createKnowledgeItem({
      projectId: folder.id,
      kind: "memory",
      title: "Project A deploy note",
      content: "folder scoped deploy note requires reviewing release flags first.",
      tags: ["deploy"]
    });
    await workbench.createKnowledgeItem({
      projectId: "default",
      kind: "memory",
      title: "Default deploy note",
      content: "default scoped deploy note should not satisfy this project lookup.",
      tags: ["deploy"]
    });
    await workbench.grantGlobalPermission("workspace_read", "knowledge project scope smoke");

    const completed = await workbench.createTask("search folder scoped deploy note", undefined, folder.id);
    const output = String(completed.events.find((event) => event.type === "tool_result")?.payload["output"] ?? "");

    expect(completed.status).toBe("completed");
    expect(output).toContain(`"projectId": "${folder.id}"`);
    expect(output).toContain("Project A deploy note");
    expect(output).not.toContain("Default deploy note");
  });

  it("searches knowledge by title, tags, Chinese text, code, and file name without embeddings", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    const apiItem = await workbench.createKnowledgeItem({
      kind: "file",
      title: "API route examples",
      content: "export function loadKnowledgeIndex() { return 'browser style search'; }",
      tags: ["code", "routes"],
      fileName: "knowledge-api.ts",
      mimeType: "text/typescript"
    });
    const chineseItem = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "资料库中文说明",
      content: "资料库需要支持中文检索、标签命中和稳定排序。",
      tags: ["资料库", "搜索"]
    });

    expect(await store.listKnowledgeEmbeddings()).toHaveLength(0);
    expect((await workbench.searchKnowledge({ query: "API route", projectId: "default", limit: 3 }))[0]?.item.id).toBe(apiItem.id);
    expect((await workbench.searchKnowledge({ query: "knowledge-api.ts", projectId: "default", limit: 3 }))[0]?.matchedFields).toContain("fileName");
    expect((await workbench.searchKnowledge({ query: "loadKnowledgeIndex", projectId: "default", limit: 3 }))[0]?.item.id).toBe(apiItem.id);
    const chinese = await workbench.searchKnowledge({ query: "中文检索", projectId: "default", limit: 3 });
    expect(chinese[0]?.item.id).toBe(chineseItem.id);
    expect(chinese[0]?.highlights?.some((highlight) => highlight.text.includes("中文检索"))).toBe(true);
  });

  it("reindexes knowledge when a direct core patch clears indexed content", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    const item = await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Temporary runbook",
      content: "stale rollback instructions should disappear from search",
      tags: ["stale"],
      sourceUri: "memory://runbook"
    });

    expect(await workbench.searchKnowledge({ query: "rollback instructions", projectId: "default", limit: 3 })).toHaveLength(1);

    const updated = await workbench.updateKnowledgeItem(item.id, { content: "", tags: [], sourceUri: "" });

    expect(updated.indexStatus).toBe("metadata_only");
    expect(updated.chunkCount).toBe(0);
    expect(updated.tags).toEqual([]);
    expect(updated.sourceUri).toBe("");
    expect(await store.listKnowledgeChunks(item.id)).toHaveLength(0);
    expect(await store.listKnowledgeSearchIndexEntries()).toHaveLength(0);
    expect(await workbench.searchKnowledge({ query: "rollback instructions", projectId: "default", limit: 3 })).toHaveLength(0);
  });

  it("uses configured fastText vectors for semantic recall without requiring lexical overlap", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-fasttext-"));
    try {
      const vectorPath = join(root, "mini.vec");
      writeFileSync(vectorPath, ["4 3", "car 1 0 0", "automobile 1 0 0", "apple 0 1 0", "banana 0 1 0"].join("\n"), "utf8");
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({ store });
      await workbench.updatePreferences({ knowledgeFastTextVectorPath: vectorPath });
      const item = await workbench.createKnowledgeItem({
        kind: "memory",
        title: "Workshop manual",
        content: "Automobile repair diagnostics and maintenance steps.",
        tags: ["vehicles"]
      });

      const results = await workbench.searchKnowledge({ query: "car", projectId: "default", limit: 3 });

      expect(results[0]?.item.id).toBe(item.id);
      expect(results[0]?.semanticScore).toBeGreaterThan(0.9);
      expect(results[0]?.rankReason).toContain("fastText semantic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("downloads knowledge model assets and records paths in preferences", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-knowledge-models-"));
    const previousWorkspaceRoot = process.env["SCC_WORKSPACE_ROOT"];
    const previousFetch = globalThis.fetch;
    process.env["SCC_WORKSPACE_ROOT"] = root;
    globalThis.fetch = async () =>
      new Response("2 2\ncar 1 0\nautomobile 1 0\n", {
        status: 200,
        headers: { "content-length": "30" }
      });
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore() });
      const result = await workbench.downloadKnowledgeModel({
        kind: "fasttext_vectors",
        url: "https://example.test/mini.vec"
      });
      const preferences = await workbench.getPreferences();

      expect(result.asset.exists).toBe(true);
      expect(result.asset.path).toContain("mini.vec");
      expect(preferences.knowledgeFastTextVectorPath).toBe(result.asset.path);
      expect(existsSync(result.asset.path ?? "")).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWorkspaceRoot === undefined) delete process.env["SCC_WORKSPACE_ROOT"];
      else process.env["SCC_WORKSPACE_ROOT"] = previousWorkspaceRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local knowledge search usable when a configured tiny reranker fails to load", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-tiny-rerank-"));
    try {
      const modelPath = join(root, "broken.onnx");
      const vocabPath = join(root, "vocab.txt");
      writeFileSync(modelPath, "not an onnx model", "utf8");
      writeFileSync(vocabPath, ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "approval", "policy"].join("\n"), "utf8");
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore() });
      await workbench.updatePreferences({
        knowledgeTinyRerankerEnabled: true,
        knowledgeTinyRerankerModelPath: modelPath,
        knowledgeTinyRerankerVocabPath: vocabPath
      });
      await workbench.createKnowledgeItem({
        kind: "memory",
        title: "Approval policy",
        content: "Workspace writes require explicit approval.",
        tags: ["permissions"]
      });

      const results = await workbench.searchKnowledge({ query: "approval policy", projectId: "default", limit: 3 });

      expect(results[0]?.rerankStatus).toBe("failed");
      expect(results[0]?.rankReason).toContain("Tiny reranker failed");
      expect(results[0]?.item.title).toBe("Approval policy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      const store = new InMemoryWorkbenchStore();
      const contextAssembler = new ContextAssembler(store);
      const workbench = new AgentWorkbench({
        store,
        contextAssembler,
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
      contextAssembler.getFileStateTracker(completed.id).updateFromToolResult({
        id: "event_read_after_edit",
        taskId: completed.id,
        type: "tool_result",
        createdAt: nowIso(),
        summary: "Tool completed",
        payload: {
          ok: true,
          toolName: "read_file",
          output: JSON.stringify({ path: filePath, content: "after\n", hash: "fake_after", partial: false, mode: "full" })
        }
      });
      expect(contextAssembler.getFileStateTracker(completed.id).buildFileStateTable()).toContain("after");

      const rolledBack = await workbench.rollbackTask(completed.id);
      expect(rolledBack.restoredFiles).toBe(1);
      expect(readFileSync(filePath, "utf8")).toBe("before\n");
      expect((await workbench.getTask(completed.id))?.events.some((event) => event.type === "task_rollback_completed")).toBe(true);
      const knownFilesAfterRollback = contextAssembler.getFileStateTracker(completed.id).buildFileStateTable();
      expect(knownFilesAfterRollback).toContain("File was rolled back");
      expect(knownFilesAfterRollback).not.toContain("fake_after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("encrypts checkpoint snapshots on disk while preserving exact rollback content", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-encrypted-checkpoint-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      const filePath = join(root, ".env");
      const before = "API_KEY=sk-checkpoint-secret1234567890\n";
      writeFileSync(filePath, before, "utf8");
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        model: new SingleToolModel("write_file", {
          path: ".env",
          expectedHash: hash(before),
          content: "API_KEY=rotated\n"
        }),
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "Encrypted checkpoint root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "encrypted checkpoint test");

      const completed = await workbench.createTask("rotate env", "Rotate env", folder.id);
      const checkpoint = (await workbench.listTaskCheckpoints(completed.id))[0];
      const snapshotPath = checkpoint?.files[0]?.snapshotPath;
      if (!snapshotPath) throw new Error("expected snapshot path");
      const snapshotText = readFileSync(snapshotPath, "utf8");

      expect(readFileSync(filePath, "utf8")).toBe("API_KEY=rotated\n");
      expect(snapshotText).toContain("__agentWorkbenchEncryptedFile");
      expect(snapshotText).not.toContain("sk-checkpoint-secret1234567890");

      const rolledBack = await workbench.rollbackTask(completed.id);
      expect(rolledBack.restoredFiles).toBe(1);
      expect(readFileSync(filePath, "utf8")).toBe(before);
      await workbench.deleteTask(completed.id);
      expect(existsSync(snapshotPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails edit_file with a conflict when hash or expected text no longer matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-edit-conflict-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      const filePath = join(root, "note.txt");
      writeFileSync(filePath, "alpha\nbeta\n", "utf8");
      const tools = new ShellToolExecutor(root);
      const hashConflict = await tools.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: "note.txt",
          expectedHash: hash("alpha\n"),
          edits: [{ startLine: 1, endLine: 1, newText: "changed" }]
        }
      });
      const textConflict = await tools.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: "note.txt",
          expectedHash: hash("alpha\nbeta\n"),
          edits: [{ startLine: 2, endLine: 2, expectedText: "gamma", newText: "changed" }]
        }
      });

      expect(hashConflict.ok).toBe(false);
      expect(hashConflict.output).toContain("\"status\": \"conflict\"");
      expect(textConflict.ok).toBe(false);
      expect(textConflict.output).toContain("Expected text");
      expect(readFileSync(filePath, "utf8")).toBe("alpha\nbeta\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports line additions and removals for write_file results", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-line-delta-"));
    try {
      const tools = new ShellToolExecutor(root);
      const result = await tools.execute({
        id: createId("tool_call"),
        toolName: "write_file",
        args: {
          path: "new.txt",
          expectedHash: "__new__",
          content: "one\ntwo\nthree\n"
        }
      });
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      const changes = parsed["changes"] as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(changes["addedLines"]).toBe(3);
      expect(changes["removedLines"]).toBe(0);
      expect(changes["operation"]).toBe("create");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits expectedHash, diff, write, commit, and verify progress for direct file writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-file-observability-"));
    try {
      const tools = new ShellToolExecutor(root);
      const progress: Array<Record<string, unknown>> = [];
      const result = await tools.execute(
        {
          id: createId("tool_call"),
          toolName: "write_file",
          args: {
            path: "note.txt",
            expectedHash: "__new__",
            content: "alpha\nbeta\n"
          }
        },
        {
          onProgress: (update) => {
            progress.push(update as unknown as Record<string, unknown>);
          }
        }
      );

      expect(result.ok).toBe(true);
      expect(JSON.parse(result.output)["totalLines"]).toBe(2);
      expect(progress.map((event) => event["operation"])).toEqual(expect.arrayContaining(["hash_check", "diff", "create", "commit", "verify"]));
      expect(progress.map((event) => event["message"])).toEqual(expect.arrayContaining([
        "Confirmed new-file write intent.",
        "Computed create diff: +2 / -0 lines.",
        "Writing file content.",
        "File write committed; verifying written hash.",
        "Verified written file hash."
      ]));
      expect(progress.some((event) => event["status"] === "completed" && event["operation"] === "verify")).toBe(true);
      const diffEvent = progress.find((event) => event["operation"] === "diff");
      expect(diffEvent?.["changes"]).toMatchObject({ addedLines: 2, removedLines: 0, operation: "create" });
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

  it("rejects rollback preview requests that target a linked path outside the work root", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-checkpoint-linked-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "scc-checkpoint-linked-outside-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "left.txt"), "left-before\n", "utf8");
      writeFileSync(join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
      createDirectoryAlias(outsideRoot, join(root, "escape"));
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
          }
        ]),
        tools: new ShellToolExecutor()
      });
      const folder = await workbench.createTaskFolder({ name: "Linked preview root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "linked rollback preview");

      const completed = await workbench.createTask("edit one file", "Edit one file", folder.id);

      await expect(workbench.previewTaskRollback(completed.id, { filePaths: ["escape/secret.txt"] })).rejects.toThrow(/outside the workspace/i);
      await expect(workbench.rollbackTask(completed.id, { filePaths: ["escape/secret.txt"] })).rejects.toThrow(/outside the workspace/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("runs scheduled reflection without creating a normal task or no-op history row", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
    await workbench.ensureDefaultScheduledTasks();
    const reflection = (await workbench.listScheduledTasks()).find((task) => task.type === "reflection");
    if (!reflection) throw new Error("expected default reflection schedule");
    await store.saveScheduledTask({ ...reflection, nextRunAt: new Date(Date.now() - 60_000).toISOString() });

    const changed = await workbench.runDueScheduledTasks(new Date());

    expect(changed[0]?.type).toBe("reflection");
    expect(changed[0]?.lastRunSummary).toContain("Reflection");
    expect(await workbench.listReflectionSessions()).toHaveLength(0);
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
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyHex = Buffer.from(publicKeyDer).subarray(-32).toString("hex");
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const integration = await workbench.createIntegrationProvider({
      kind: "discord",
      label: "Discord Test",
      publicKey: publicKeyHex,
      callbackUrl: "https://discord.example.test/interactions",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });

    const payload = {
      id: "message_1",
      integrationId: integration.id,
      type: 2,
      channel_id: "channel_1",
      data: {
        name: "task",
        options: [{ name: "prompt", value: "Summarize this from Discord" }]
      },
      user: { id: "user_1" }
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = sign(null, Buffer.from(`${timestamp}${rawBody}`, "utf8"), privateKey).toString("hex");

    const completed = await workbench.handleDiscordInteraction(payload, {
      rawBody,
      signature,
      timestamp
    });

    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "integration_message_received")).toBe(true);
    expect(await workbench.listIntegrationProviders()).toHaveLength(1);
  });

  it("clears stale integration secrets and provider-specific fields when switching provider kind", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new StreamingFinalModel() });
    const integration = await workbench.createIntegrationProvider({
      kind: "telegram",
      label: "Telegram inbound",
      botToken: "telegram-bot-secret",
      secretToken: "telegram-secret-token",
      appId: "telegram-app",
      publicKey: "telegram-public-key",
      callbackUrl: "https://telegram.example.test/webhook",
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      enabled: true
    });

    const updated = await workbench.updateIntegrationProvider(integration.id, {
      kind: "slack",
      label: "Slack inbound",
      signingSecret: "slack-signing-secret",
      callbackUrl: "https://slack.example.test/events",
      enabled: true
    });
    const stored = await store.getIntegrationProvider(integration.id);

    expect(updated.kind).toBe("slack");
    expect(updated.status).toBe("connected");
    expect(updated.signingSecretRef?.last4).toBe("cret");
    expect(updated.botTokenRef).toBeUndefined();
    expect(updated.secretTokenRef).toBeUndefined();
    expect(updated.publicKey).toBeUndefined();
    expect(updated.appId).toBeUndefined();
    expect(await store.getIntegrationSecret(integration.id, "botToken")).toBeUndefined();
    expect(await store.getIntegrationSecret(integration.id, "secretToken")).toBeUndefined();
    expect(stored?.botTokenRef).toBeUndefined();
    expect(stored?.secretTokenRef).toBeUndefined();
  });

  it("rejects stale Slack request signatures before accepting replayable payloads", () => {
    const secret = "slack-secret";
    const rawBody = JSON.stringify({ type: "event_callback", event: { text: "hello" } });
    const freshTimestamp = String(Math.floor(Date.now() / 1000));
    const staleTimestamp = String(Math.floor((Date.now() - 10 * 60_000) / 1000));

    expect(() => verifySlackRequestSignature(secret, slackSignature(secret, freshTimestamp, rawBody), freshTimestamp, rawBody)).not.toThrow();
    expect(() => verifySlackRequestSignature(secret, slackSignature(secret, staleTimestamp, rawBody), staleTimestamp, rawBody)).toThrow(
      /replay window/i
    );
  });

  it("does not fabricate token usage when provider metadata is absent", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
    const first = await workbench.createTask("record cache baseline");
    const second = await workbench.appendMessage(first.id, "continue with another turn");
    const stats = await workbench.listPromptCacheStats(second.id);

    expect(stats).toHaveLength(0);
    expect(second.events.some((event) => event.type === "token_usage_recorded")).toBe(false);
  });

  it("records provider sourced prompt cache usage when the model returns token metadata", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new UsageModel() });
    const task = await workbench.createTask("record provider cache usage");
    const stats = await workbench.listPromptCacheStats(task.id);

    expect(stats[0]?.source).toBe("provider");
    expect(stats[0]?.inputTokens).toBe(1000);
    expect(stats[0]?.outputTokens).toBe(80);
    expect(stats[0]?.totalTokens).toBe(1080);
    expect(stats[0]?.cachedTokens).toBe(400);
    expect(stats[0]?.cacheTargetHitRatio).toBe(0.9);
    expect(stats[0]?.cacheTargetMet).toBeUndefined();
    expect(stats[0]?.rollingInputTokens).toBe(1000);
    expect(stats[0]?.rollingCachedTokens).toBe(400);
    expect(stats[0]?.rollingWindowSize).toBe(1);
    expect(task.events.some((event) => event.type === "token_usage_recorded")).toBe(true);
  });

  it("records rolling prompt cache hit progress against the 90 percent target", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      model: new UsageModel([
        { inputTokens: 1000, outputTokens: 80, cachedTokens: 800 },
        { inputTokens: 1000, outputTokens: 80, cachedTokens: 1000 }
      ])
    });
    const first = await workbench.createTask("warm prompt cache");
    const second = await workbench.appendMessage(first.id, "reuse prompt cache");
    const stats = await workbench.listPromptCacheStats(second.id);
    const latest = stats[0];

    expect(stats).toHaveLength(2);
    expect(latest?.cacheHitRatio).toBe(1);
    expect(latest?.rollingInputTokens).toBe(2000);
    expect(latest?.rollingCachedTokens).toBe(1800);
    expect(latest?.rollingCacheHitRatio).toBeCloseTo(0.9, 5);
    expect(latest?.rollingWindowSize).toBe(2);
    expect(latest?.cacheTargetMet).toBe(true);
    expect(second.events.some((event) =>
      event.type === "token_usage_recorded" &&
      event.summary.includes("rolling cache hit target met")
    )).toBe(true);
  });

  it("retries one empty model response without storing diagnostic text as an assistant answer", async () => {
    const model = new EmptyThenFinalModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("recover from an empty provider turn");

    expect(model.calls).toBe(2);
    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "model_empty_response" && event.payload["status"] === "retrying")).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && /I could not produce a result/i.test(event.summary))).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary === "Recovered after empty model turn.")).toBe(true);
  });

  it("retries when the model exposes an internal continuity note as a final answer", async () => {
    const model = new InternalContinuationThenFinalModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("continue instead of exposing internal execution notes");

    expect(model.calls).toBe(2);
    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "model_no_progress" && event.payload["status"] === "retrying")).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary.startsWith("Internal continuity note"))).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary === "Completed after continuing instead of exposing an internal note.")).toBe(true);
  });

  it("retries when a legacy retained-thinking preamble is exposed as a final answer", async () => {
    const model = new LegacyPriorThinkingThenFinalModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("continue after a legacy retained-thinking response");

    expect(model.calls).toBe(2);
    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "model_no_progress" && event.payload["status"] === "retrying")).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary.startsWith("Prior thinking retained"))).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary === "Completed after continuing from a legacy retained-thinking response.")).toBe(true);
  });

  it("hides streamed legacy retained-thinking text before retrying", async () => {
    const model = new StreamingLegacyPriorThinkingThenFinalModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("do not render leaked retained-thinking deltas");

    const leakedDeltas = task.events.filter((event) => event.type === "assistant_delta" && event.summary.includes("Prior thinking retained"));

    expect(model.calls).toBe(2);
    expect(task.status).toBe("completed");
    expect(leakedDeltas.length).toBeGreaterThan(0);
    expect(leakedDeltas.every((event) => event.payload["uiHidden"] === true)).toBe(true);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary.startsWith("Prior thinking retained"))).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary === "Completed after hiding the leaked continuity stream.")).toBe(true);
  });

  it("pauses instead of completing after repeated internal continuity final answers", async () => {
    const model = new RepeatedInternalContinuationModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("do not complete with an internal execution note");

    expect(model.calls).toBe(2);
    expect(task.status).toBe("paused");
    expect(task.events.filter((event) => event.type === "model_no_progress")).toHaveLength(2);
    expect(task.events.some((event) => event.type === "assistant_message")).toBe(false);
  });

  it("resets internal continuity retry tracking after real tool progress", async () => {
    const model = new InternalContinuationSeparatedByToolProgressModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools: new StubToolExecutor(), model });
    await workbench.grantGlobalPermission("workspace_read", "fixture read");

    const task = await workbench.createTask("continue after a leaked continuity note if a tool call made progress");

    expect(model.calls).toBe(4);
    expect(task.status).toBe("completed");
    expect(task.events.filter((event) => event.type === "model_no_progress")).toHaveLength(2);
    expect(task.events.filter((event) => event.type === "tool_requested" && event.payload["toolName"] === "read_file")).toHaveLength(1);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary.startsWith("Internal continuity note"))).toBe(false);
    expect(task.events.some((event) => event.type === "assistant_message" && event.summary === "Completed after tool-backed progress.")).toBe(true);
  });

  it("pauses after repeated empty model responses without producing assistant body text", async () => {
    const model = new EmptyResponseModel();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model });
    const task = await workbench.createTask("provider keeps returning an empty response");

    expect(model.calls).toBe(2);
    expect(task.status).toBe("paused");
    expect(task.events.filter((event) => event.type === "model_empty_response")).toHaveLength(2);
    expect(task.events.some((event) => event.type === "assistant_message")).toBe(false);
  });

  it("records provider fallback diagnostics in task events", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new ProviderFallbackEventModel() });
    const task = await workbench.createTask("exercise provider fallback");
    const fallback = task.events.find((event) => event.type === "provider_fallback");

    expect(fallback?.payload["fromModel"]).toBe("primary-model");
    expect(fallback?.payload["toModel"]).toBe("backup-model");
    expect(task.status).toBe("completed");
  });

  it("pauses for ask_user and resumes with the user answer as a tool result", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new AskUserThenFinishModel() });
    const waiting = await workbench.createTask("Need a user decision before continuing");

    expect(waiting.status).toBe("waiting_for_user");
    expect(waiting.events.some((event) => event.type === "user_input_requested")).toBe(true);
    expect(waiting.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user")).toBe(false);

    const completed = await workbench.appendMessage(waiting.id, "Use option B");
    const askResult = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user");

    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "user_input_answered")).toBe(true);
    expect(String(askResult?.payload["output"] ?? "")).toContain("Use option B");
  });

  it("continues through optional ask_user follow-up after verification evidence passed", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new PassingCommandExecutor(),
      model: new OptionalAskAfterVerificationModel()
    });
    await workbench.grantGlobalPermission("shell", "fixture verification");

    const completed = await workbench.createTask("Run the verification and summarize when it passes");
    const askResult = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user");

    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "user_input_requested")).toBe(false);
    expect(completed.events.some((event) => event.type === "tool_requested" && event.payload["toolName"] === "ask_user" && event.payload["autoResolved"] === true)).toBe(true);
    expect(String(askResult?.payload["output"] ?? "")).toContain("optional_follow_up_after_verified_progress");
    expect(completed.events.some((event) => event.type === "assistant_message" && event.summary === "Final answer after verified progress.")).toBe(true);
  });

  it("continues through ask_user that asks how to explain current tool evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-ask-evidence-"));
    try {
      const workbench = new AgentWorkbench({
        store: new InMemoryWorkbenchStore(),
        tools: new ShellToolExecutor(root),
        model: new AskHowToExplainEvidenceModel()
      });
      await workbench.grantGlobalPermission("workspace_read", "fixture boundary evidence");
      const folder = await workbench.createTaskFolder({ name: "Boundary fixture", rootPath: root });

      const completed = await workbench.createTask("Try to read ../outside.txt and explain the tool result", "Boundary ask", folder.id);
      const askResult = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user");

      expect(completed.status).toBe("completed");
      expect(completed.events.some((event) => event.type === "user_input_requested")).toBe(false);
      expect(completed.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "read_file" && event.payload["ok"] === false)).toBe(true);
      expect(completed.events.some((event) => event.type === "tool_requested" && event.payload["toolName"] === "ask_user" && event.payload["autoResolved"] === true)).toBe(true);
      expect(String(askResult?.payload["output"] ?? "")).toContain("answer_from_current_tool_evidence");
      expect(completed.events.some((event) => event.type === "assistant_message" && event.summary.includes("outside workspace rejection"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not auto-resolve optional ask_user after ambiguous verification output", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new AmbiguousCommandExecutor(),
      model: new OptionalAskAfterVerificationModel()
    });
    await workbench.grantGlobalPermission("shell", "fixture verification");

    const waiting = await workbench.createTask("Run the verification and summarize only if it cleanly passes");

    expect(waiting.status).toBe("waiting_for_user");
    expect(waiting.events.some((event) => event.type === "user_input_requested")).toBe(true);
    expect(waiting.events.some((event) => event.type === "tool_requested" && event.payload["toolName"] === "ask_user" && event.payload["autoResolved"] === true)).toBe(false);
  });

  it("snapshots the selected local folder root when a task is created", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "scc-work-root-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "scc-work-root-b-"));
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StreamingFinalModel() });
      const folder = await workbench.createTaskFolder({ name: "External project", rootPath: firstRoot });
      const task = await workbench.createTask("inspect this local folder", "Inspect folder", folder.id);

      expect(task.folderId).toBe(folder.id);
      expectSamePath(task.workRoot, firstRoot);

      await workbench.updateTaskFolder(folder.id, { rootPath: secondRoot });
      const persisted = await workbench.getTask(task.id);
      expect(persisted?.folderId).toBe(folder.id);
      expectSamePath(persisted?.workRoot, firstRoot);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("uses an isolated Agent Workbench workspace as the default task folder instead of the project root", async () => {
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
      expectSamePath(updated.workRoot, firstRoot);
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

  it("redacts tool arguments and outputs before storing reusable task memories", () => {
    const task: TaskDetail = {
      kind: "primary",
      id: "task_secret_memory",
      folderId: "default",
      workRoot: "",
      title: "Check provider configuration",
      status: "completed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: [
        {
          id: "event_user",
          taskId: "task_secret_memory",
          type: "user_message",
          createdAt: nowIso(),
          summary: "Check provider api_key=sk-testsecret1234567890 and email admin@example.com",
          payload: {}
        },
        {
          id: "event_tool",
          taskId: "task_secret_memory",
          type: "tool_requested",
          createdAt: nowIso(),
          summary: "call_provider",
          payload: {
            toolCallId: "call_secret",
            toolName: "call_provider",
            args: {
              endpoint: "https://example.test/search?api_key=sk-querysecret1234567890",
              authorization: "Bearer provider-secret-token",
              nested: {
                password: "plain-password",
                path: "C:\\Users\\Admin\\secret.txt",
                email: "owner@example.com"
              }
            }
          }
        },
        {
          id: "event_result",
          taskId: "task_secret_memory",
          type: "tool_result",
          createdAt: nowIso(),
          summary: "Tool completed",
          payload: {
            toolCallId: "call_secret",
            ok: true,
            output: "Fetched with api_key=sk-outputsecret1234567890 for owner@example.com from C:\\Users\\Admin\\secret.txt"
          }
        },
        {
          id: "event_assistant",
          taskId: "task_secret_memory",
          type: "assistant_message",
          createdAt: nowIso(),
          summary: "Done. token=sk-finalsecret1234567890",
          payload: {}
        }
      ]
    };

    const memory = createTaskMemory(task);
    const experience = createExperience(task);
    const serialized = JSON.stringify({ memory, experience });

    expect(serialized).not.toContain("sk-testsecret1234567890");
    expect(serialized).not.toContain("sk-querysecret1234567890");
    expect(serialized).not.toContain("sk-outputsecret1234567890");
    expect(serialized).not.toContain("sk-finalsecret1234567890");
    expect(serialized).not.toContain("Bearer provider-secret-token");
    expect(serialized).not.toContain("plain-password");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("admin@example.com");
    expect(serialized).not.toContain("C:\\Users\\Admin");
    expect(memory.toolsUsed[0]?.args["authorization"]).toBe("[redacted-secret]");
    expect(memory.toolsUsed[0]?.result).toContain("api_key=***");
  });

  it("surfaces skill curator explanations for candidates and low-value memories", async () => {
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ConfiguredToolModelClient("Get-Process")
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    await workbench.decideApproval(created.id, approval.id, "allow_once");
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

  it("deduplicates low-value curator memories and allows deleting task memory records", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    for (let index = 0; index < 4; index += 1) {
      const memory = testTaskMemory(index, {
        domain: "workspace",
        tools: ["list_files"],
        title: "Check current folder contents"
      });
      await store.saveTaskMemory({
        ...memory,
        id: `memory_low_value_${index}`,
        taskId: `task_low_value_${index}`,
        meta: { ...memory.meta, complexity: "simple" }
      });
    }

    const items = await workbench.listSkillCuratorItems();
    const lowValueItems = items.filter((item) => item.kind === "low_value_memory" && item.title === "Check current folder contents");

    expect(lowValueItems).toHaveLength(1);
    expect(lowValueItems[0]?.evidence.some((line) => line.includes("similar low-value task"))).toBe(true);

    await workbench.deleteTaskMemory("memory_low_value_0");

    expect((await workbench.listTaskMemories()).some((memory) => memory.id === "memory_low_value_0")).toBe(false);
  });

  it("deletes a task and can clean linked learning records and derived skills", async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), "aw-traces-"));
    const workbench = new AgentWorkbench({
      store: new InMemoryWorkbenchStore(),
      tools: new StubToolExecutor(),
      model: new ConfiguredToolModelClient("Get-Process"),
      traceRoot
    });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    const completed = await workbench.decideApproval(created.id, approval.id, "allow_for_task");
    const traceDir = join(traceRoot, completed.id);
    expect(existsSync(join(traceDir, "trace.jsonl"))).toBe(true);
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
    expect(existsSync(traceDir)).toBe(false);
    rmSync(traceRoot, { recursive: true, force: true });
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

  it("does not promote generic workspace or host-observation workflow patterns into skills", () => {
    const workspaceMemories = Array.from({ length: 10 }, (_, index) =>
      testTaskMemory(index, {
        domain: "workspace",
        tools: ["list_files", "read_file", "search_files", "edit_file", "write_file"],
        title: `Inspect project files ${index}`
      })
    );
    const hostMemories = Array.from({ length: 10 }, (_, index) =>
      testTaskMemory(index + 20, {
        domain: "host_observation",
        tools: ["run_command", "list_files", "read_file"],
        title: `Check current host state ${index}`
      })
    );

    expect(reflectMemories(workspaceMemories).promotedSkills).toHaveLength(0);
    expect(reflectMemories(hostMemories).promotedSkills).toHaveLength(0);
  });

  it("marks reflected memories so repeated reflection does not regenerate the same candidate skill", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    for (let index = 0; index < 10; index += 1) {
      await store.saveTaskMemory(testTaskMemory(index, {
        domain: "testing",
        tools: ["run_tests", "read_file"],
        title: `Validate release test workflow ${index}`
      }));
    }

    const first = await workbench.runReflection();
    expect(first.progress.nextStep).toBe("skills_promoted");
    expect(await workbench.listSkills()).toHaveLength(1);
    expect((await workbench.listTaskMemories()).every((memory) => memory.reflectionStatus === "reflected")).toBe(true);

    const second = await workbench.runReflection();
    expect(second.progress.nextStep).toBe("wait_for_more_task_memories");
    expect(await workbench.listReflectionSessions()).toHaveLength(1);
    expect(await workbench.listSkills()).toHaveLength(1);
  });

  it("does not persist no-op reflection sessions when there is not enough new evidence", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    for (let index = 0; index < 3; index += 1) {
      await store.saveTaskMemory(testTaskMemory(index, {
        domain: "testing",
        tools: ["read_file"],
        title: `Small evidence batch ${index}`
      }));
    }

    const session = await workbench.runReflection();

    expect(session.progress.nextStep).toBe("wait_for_more_task_memories");
    expect(await workbench.listReflectionSessions()).toHaveLength(0);
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
  it("sends prompt cache keys only for documented OpenAI-compatible hosts in auto mode", () => {
    expect(shouldSendOpenAIPromptCacheKey("auto", undefined)).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://api.openai.com/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://api.moonshot.cn/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://platform.kimi.com/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://token-plan-cn.xiaomimimo.com/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://api.xiaomimimo.com/v1")).toBe(false);
    expect(shouldSendOpenAIPromptCacheKey("auto", "https://openrouter.ai/api/v1")).toBe(false);
    expect(shouldSendOpenAIPromptCacheKey("always", "http://127.0.0.1:9999/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheKey("off", "https://api.openai.com/v1")).toBe(false);
    expect(shouldSendOpenAIPromptCacheRetention("auto", undefined)).toBe(true);
    expect(shouldSendOpenAIPromptCacheRetention("auto", "https://api.openai.com/v1")).toBe(true);
    expect(shouldSendOpenAIPromptCacheRetention("always", "https://api.moonshot.cn/v1")).toBe(false);
    expect(shouldSendOpenAIPromptCacheRetention("auto", "https://token-plan-cn.xiaomimimo.com/v1")).toBe(false);
    expect(shouldSendOpenAIPromptCacheRetention("off", "https://api.openai.com/v1")).toBe(false);
  });

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
        model: "mimo-v2.5",
        contextAssembler: assembler
      });
      const traces: Array<Record<string, unknown>> = [];
      const task: TaskDetail = {
        kind: "primary",
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
            payload: {
              toolCallId: "call_list",
              toolName: "list_files",
              args: { path: "." },
              reasoningContent: "I should inspect the workspace before writing the page."
            }
          },
          {
            id: "event_tool_result",
            taskId: "task_openai_roles",
            type: "tool_result",
            createdAt: nowIso(),
            summary: "Tool completed",
            payload: {
              toolCallId: "call_list",
              toolName: "list_files",
              args: { path: "." },
              ok: true,
              output: "[]",
              reasoningContent: "I should inspect the workspace before writing the page."
            }
          }
        ]
      };
      attachExplicitTaskGraph(task);

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
      expect(request?.["max_tokens"]).toBeUndefined();
      expect(request?.["max_completion_tokens"]).toBeUndefined();
      expect(request?.["prompt_cache_key"]).toBeUndefined();
      expect(messages[0]?.["role"]).toBe("system");
      expect(String(messages[0]?.["content"] ?? "")).toContain("Stable Memory Files");
      expect(String(messages[0]?.["content"] ?? "")).toContain("copy the observed text exactly");
      expect(String(messages[0]?.["content"] ?? "")).not.toContain("Task title:");
      expect(messages.map((message) => message["role"])).toEqual(["system", "user", "assistant", "user", "assistant", "assistant", "tool"]);
      expect(messages[3]?.["content"]).toBe("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");
      expect(String(messages[4]?.["content"] ?? "")).toContain("Internal continuity note");
      expect(String(messages[4]?.["content"] ?? "")).toContain("Do not quote this note");
      expect(String(messages[4]?.["content"] ?? "")).toContain("I should inspect the workspace before writing the page.");
      expect(messages[5]?.["tool_calls"]).toEqual([
        { id: "call_list", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }
      ]);
      expect(messages[5]?.["content"]).toBe("");
      expect(messages[5]?.["reasoning_content"]).toBe("I should inspect the workspace before writing the page.");
      expect(messages[6]?.["tool_call_id"]).toBe("call_list");
      const lastUser = messages.filter((message) => message["role"] === "user").at(-1);
      expect(lastUser?.["content"]).toBe("帮我在本文件夹中编写一个完整的博客页面，使用react编写，并且需要特别丰富，优雅，动画丝滑");
      expect(String(messages.map((message) => message["content"] ?? "").join("\n"))).not.toContain("## Active Node");
      expect((attention?.["activeNode"] as Record<string, unknown> | undefined)?.["role"]).toBe("implement");
      expect(attention?.["evidenceRefs"]).toContain("event_tool_result:list_files:ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses a stable scoped prompt cache key without leaking task or endpoint details", async () => {
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
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      let toolListCall = 0;
      let providerCall = 0;
      const client = new OpenAIModelClient({
        promptCacheMode: "always",
        providerResolver: async () => {
          providerCall += 1;
          return {
            providerId: `cache-provider-alias-${providerCall}`,
            protocol: "openai_compatible",
            apiKey: "cache-secret-key",
            baseURL: `http://127.0.0.1:${port}/v1/private-endpoint`,
            model: "cache-model"
          };
        },
        toolProvider: {
          listModelTools: async () => {
            toolListCall += 1;
            const properties = toolListCall % 2 === 0
              ? { beta: { type: "number" }, alpha: { type: "string" } }
              : { alpha: { type: "string" }, beta: { type: "number" } };
            return [{
              type: "function",
              function: {
                name: "cache_probe",
                description: "Probe deterministic tool schemas.",
                parameters: { type: "object", properties, required: ["alpha"] }
              }
            }];
          }
        }
      });
      const cacheWorkRoot = resolve("workspace", "CacheRoot");
      const equivalentCacheWorkRoot = process.platform === "win32" ? `${cacheWorkRoot.toUpperCase()}\\` : `${cacheWorkRoot}/`;
      const task = (id: string, folderId: string, workRoot = cacheWorkRoot): TaskDetail => ({
        kind: "primary",
        id,
        folderId,
        workRoot,
        title: "Cache probe",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [{ id: `event_${id}`, taskId: id, type: "user_message", createdAt: nowIso(), summary: "probe", payload: {} }]
      });

      await client.next(task("task_cache_one", "folder_shared"));
      await client.next(task("task_cache_two", "folder_shared", equivalentCacheWorkRoot));
      await client.next(task("task_cache_three", "folder_other", `${cacheWorkRoot}/`));

      const keys = capturedRequests.map((request) => String(request["prompt_cache_key"] ?? ""));
      expect(keys[0]).toMatch(/^aw-[a-f0-9]{40}$/);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).toBe(keys[0]);
      expect(keys.join(" ")).not.toContain("task_cache");
      expect(keys.join(" ")).not.toContain("cache-secret-key");
      expect(keys.join(" ")).not.toContain("cache-provider-alias");
      expect(keys.join(" ")).not.toContain("private-endpoint");
      expect(capturedRequests.map((request) => request["prompt_cache_retention"])).toEqual([undefined, undefined, undefined]);
      const toolNames = ((capturedRequests[0]?.["tools"] as Array<Record<string, unknown>>) ?? [])
        .map((tool) => String((tool["function"] as Record<string, unknown> | undefined)?.["name"] ?? ""));
      expect(toolNames).toEqual([...toolNames].sort((left, right) => left.localeCompare(right)));
      const dynamicTool = (capturedRequests[0]?.["tools"] as Array<Record<string, unknown>>)
        .find((tool) => (tool["function"] as Record<string, unknown> | undefined)?.["name"] === "cache_probe");
      const parameters = ((dynamicTool?.["function"] as Record<string, unknown>)["parameters"] as Record<string, unknown>);
      expect(Object.keys(parameters)).toEqual(["properties", "required", "type"]);
      expect(Object.keys(parameters["properties"] as Record<string, unknown>)).toEqual(["alpha", "beta"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("replays reasoning_content for hidden plan_update history on the next MiMo request", async () => {
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
                reasoning_content: "I should update the visible plan before editing files.",
                tool_calls: [{
                  index: 0,
                  id: "call_plan_hidden",
                  function: {
                    name: "plan_update",
                    arguments: JSON.stringify({
                      status: "running",
                      context: "Repair the remaining live-smoke regression.",
                      steps: [{ id: "1", title: "Fix the regression", status: "running" }]
                    })
                  }
                }]
              }
            }]
          })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 90, completion_tokens: 14 } })}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Plan updated and work continued." } }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 130, completion_tokens: 10 } })}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const model = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "mimo-v2.5",
        contextAssembler: assembler
      });
      const workbench = new AgentWorkbench({ store, contextAssembler: assembler, model });

      const completed = await workbench.createTask("先更新计划，再继续修复 live smoke");
      const secondRequest = capturedRequests[1];
      const messages = secondRequest?.["messages"] as Array<Record<string, unknown>>;
      const planMessage = messages?.find((message) => Array.isArray(message["tool_calls"]) && message["tool_calls"]?.[0]?.["function"]?.["name"] === "plan_update");
      const planResult = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "plan_update");

      expect(completed.status).toBe("completed");
      expect(requestCount).toBe(2);
      expect(planResult?.payload["reasoningContent"]).toBe("I should update the visible plan before editing files.");
      expect(planMessage?.["content"]).toBe("");
      expect(planMessage?.["reasoning_content"]).toBe("I should update the visible plan before editing files.");
      expect(messages.some((message) => "reasoning_content" in message)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps use_skill on the managed tool path instead of hidden model retries", async () => {
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
                  id: "call_use_audited_skill",
                  type: "function",
                  function: {
                    name: "use_skill",
                    arguments: JSON.stringify({ name: "Audited Skill" })
                  }
                }]
              }
            }]
          })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 8 } })}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Used audited skill guidance." } }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 140, completion_tokens: 6 } })}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const model = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "mimo-v2.5",
        contextAssembler: assembler
      });
      const workbench = new AgentWorkbench({ store, contextAssembler: assembler, model });
      const skill = await workbench.createSkill({
        title: "Audited Skill",
        body: "AUDITED-SKILL-GUIDANCE: use direct evidence before answering.",
        status: "active",
        applicability: { description: "Audited live tasks", requiredTools: ["read_file"], requiredContext: [], exclusions: [], keywords: ["audited"] },
        sourceMemoryIds: [],
        relatedPatterns: []
      });

      const started = await workbench.createTask("使用 Audited Skill 完成任务");

      expect(started.status).toBe("waiting_approval");
      expect(started.approvals[0]?.riskCategory).toBe("workspace_read");
      expect(assembler.getLoadedSkillIds(started.id)).toEqual([]);

      const completed = await workbench.decideApproval(started.id, started.approvals[0]!.id, "allow_for_task");
      const requested = completed.events.find((event) => event.type === "tool_requested" && event.payload["toolName"] === "use_skill");
      const progressEvents = completed.events.filter((event) => event.type === "tool_progress" && event.payload["toolName"] === "use_skill");
      const result = completed.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "use_skill");

      expect(completed.status).toBe("completed");
      expect(requestCount).toBe(2);
      expect(requested?.payload["args"]).toEqual({ name: "Audited Skill" });
      expect(progressEvents.map((event) => event.payload["operation"])).toEqual(["use_skill", "use_skill"]);
      expect(progressEvents.map((event) => event.payload["status"])).toEqual(["running", "completed"]);
      expect(progressEvents.map((event) => event.payload["message"])).toEqual([
        "Loading skill guidance for \"Audited Skill\".",
        "Loaded skill guidance: Audited Skill."
      ]);
      expect(result?.payload["ok"]).toBe(true);
      expect(completed.events.some((event) => event.type === "skill_loaded" && event.payload["skillId"] === skill.id)).toBe(true);
      expect(JSON.stringify(capturedRequests[1])).toContain("AUDITED-SKILL-GUIDANCE");
      expect(JSON.stringify(capturedRequests[1])).toContain("tool_call_id");
      expect(JSON.stringify(capturedRequests[1])).toContain("use_skill");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serializes Anthropic tool history without OpenAI null-content placeholders", async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 }
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const client = new OpenAIModelClient({
        apiKey: "unused",
        contextAssembler: assembler,
        providerResolver: async () => ({
          providerId: "provider_anthropic",
          protocol: "anthropic_messages",
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${port}`,
          model: "claude-test"
        })
      });
      const task: TaskDetail = {
        kind: "primary",
        id: "task_anthropic_tool_history",
        title: "Anthropic fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [
          { id: "event_anthropic_user", taskId: "task_anthropic_tool_history", type: "user_message", createdAt: nowIso(), summary: "inspect files", payload: {} },
          {
            id: "event_anthropic_tool_requested",
            taskId: "task_anthropic_tool_history",
            type: "tool_requested",
            createdAt: nowIso(),
            summary: "list_files",
            payload: { toolCallId: "call_anthropic_list", toolName: "list_files", args: { path: "." } }
          },
          {
            id: "event_anthropic_tool_result",
            taskId: "task_anthropic_tool_history",
            type: "tool_result",
            createdAt: nowIso(),
            summary: "Tool completed",
            payload: { toolCallId: "call_anthropic_list", toolName: "list_files", args: { path: "." }, ok: true, output: "[]" }
          }
        ]
      };

      const turn = await client.next(task);
      const request = capturedRequests[0];
      const messages = request?.["messages"] as Array<Record<string, unknown>>;
      const assistant = messages.find((message) => message["role"] === "assistant");
      const assistantContent = assistant?.["content"] as Array<Record<string, unknown>>;
      const toolResultUser = messages.find((message) => {
        const content = message["content"];
        return message["role"] === "user" && Array.isArray(content) && content.some((part) => part["type"] === "tool_result");
      });

      expect(turn.kind).toBe("final");
      expect(capturedRequests).toHaveLength(1);
      expect(request?.["max_tokens"]).toBe(16000);
      expect(request?.["cache_control"]).toEqual({ type: "ephemeral" });
      expect(turn.usage?.inputTokens).toBe(30);
      expect(turn.usage?.cachedTokens).toBe(7);
      expect(turn.usage?.raw?.["cache_creation_input_tokens"]).toBe(11);
      expect(JSON.stringify(request)).not.toContain(":null");
      expect(assistantContent).toContainEqual({ type: "tool_use", id: "call_anthropic_list", name: "list_files", input: { path: "." } });
      expect(toolResultUser).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serializes Gemini tool history without OpenAI null-content placeholders", async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "done" }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 }
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = new InMemoryWorkbenchStore();
      const assembler = new ContextAssembler(store);
      const client = new OpenAIModelClient({
        apiKey: "unused",
        contextAssembler: assembler,
        providerResolver: async () => ({
          providerId: "provider_gemini",
          protocol: "gemini",
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${port}/v1beta`,
          model: "gemini-test"
        })
      });
      const task: TaskDetail = {
        kind: "primary",
        id: "task_gemini_tool_history",
        title: "Gemini fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [
          { id: "event_gemini_user", taskId: "task_gemini_tool_history", type: "user_message", createdAt: nowIso(), summary: "inspect files", payload: {} },
          {
            id: "event_gemini_tool_requested",
            taskId: "task_gemini_tool_history",
            type: "tool_requested",
            createdAt: nowIso(),
            summary: "list_files",
            payload: { toolCallId: "call_gemini_list", toolName: "list_files", args: { path: "." } }
          },
          {
            id: "event_gemini_tool_result",
            taskId: "task_gemini_tool_history",
            type: "tool_result",
            createdAt: nowIso(),
            summary: "Tool completed",
            payload: { toolCallId: "call_gemini_list", toolName: "list_files", args: { path: "." }, ok: true, output: "[]" }
          }
        ]
      };

      const turn = await client.next(task);
      const request = capturedRequests[0];
      const contents = request?.["contents"] as Array<Record<string, unknown>>;
      const modelContent = contents.find((content) => content["role"] === "model");
      const modelParts = modelContent?.["parts"] as Array<Record<string, unknown>>;
      const toolResultUser = contents.find((content) => {
        const parts = content["parts"];
        return content["role"] === "user" && Array.isArray(parts) && parts.some((part) => "functionResponse" in part);
      });

      expect(turn.kind).toBe("final");
      expect(capturedRequests).toHaveLength(1);
      expect(JSON.stringify(request)).not.toContain(":null");
      expect(modelParts).toContainEqual({ functionCall: { name: "list_files", args: { path: "." } } });
      expect(toolResultUser).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty_response turn when an Anthropic Messages response has no text or tool use", async () => {
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          content: [],
          usage: { input_tokens: 21, output_tokens: 0 }
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new OpenAIModelClient({
        apiKey: "unused",
        providerResolver: async () => ({
          providerId: "provider_anthropic_empty",
          protocol: "anthropic_messages",
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${port}`,
          model: "claude-empty-test"
        })
      });
      const task: TaskDetail = {
        kind: "primary",
        id: "task_anthropic_empty",
        title: "Anthropic empty fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [{ id: "event_goal", taskId: "task_anthropic_empty", type: "user_message", createdAt: nowIso(), summary: "普通请求", payload: {} }]
      };

      const turn = await client.next(task);

      expect(turn.kind).toBe("empty_response");
      expect(turn.kind === "empty_response" ? turn.reason : "").toContain("Anthropic response contained no text or tool use");
      expect(turn.kind === "empty_response" ? turn.usage?.inputTokens : undefined).toBe(21);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty_response turn when a Gemini response has no text or function calls", async () => {
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          candidates: [{ content: { parts: [] } }],
          usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 0, totalTokenCount: 22 }
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new OpenAIModelClient({
        apiKey: "unused",
        providerResolver: async () => ({
          providerId: "provider_gemini_empty",
          protocol: "gemini",
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${port}/v1beta`,
          model: "gemini-empty-test"
        })
      });
      const task: TaskDetail = {
        kind: "primary",
        id: "task_gemini_empty",
        title: "Gemini empty fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [{ id: "event_goal", taskId: "task_gemini_empty", type: "user_message", createdAt: nowIso(), summary: "普通请求", payload: {} }]
      };

      const turn = await client.next(task);

      expect(turn.kind).toBe("empty_response");
      expect(turn.kind === "empty_response" ? turn.reason : "").toContain("Gemini response contained no text or function calls");
      expect(turn.kind === "empty_response" ? turn.usage?.inputTokens : undefined).toBe(22);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty_response turn when a streaming chat response has no content or tool calls", async () => {
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 0 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "empty-stream-model"
      });
      const traces: Array<Record<string, unknown>> = [];
      const task: TaskDetail = {
        kind: "primary",
        id: "task_openai_empty",
        title: "Empty fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [{ id: "event_goal", taskId: "task_openai_empty", type: "user_message", createdAt: nowIso(), summary: "普通请求", payload: {} }]
      };

      const turn = await client.next(task, {
        streamId: "stream_openai_empty",
        onAssistantDelta: async () => undefined,
        onThinkingDelta: async () => undefined,
        onTrace: async (event) => { traces.push(event as unknown as Record<string, unknown>); }
      });
      const responseTrace = traces.find((event) => event["kind"] === "response");
      const traceResponse = (responseTrace?.["payload"] as Record<string, unknown> | undefined)?.["response"] as Record<string, unknown> | undefined;

      expect(turn.kind).toBe("empty_response");
      expect(turn.usage?.inputTokens).toBe(9);
      expect(traceResponse?.["kind"]).toBe("empty_response");
      expect((traceResponse?.["rawPayload"] as Record<string, unknown> | undefined)?.["finishReasons"]).toEqual(["stop"]);
      expect(JSON.stringify(traceResponse)).not.toContain("I could not produce a result");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("parses legacy OpenAI-compatible streaming function_call chunks as tool calls", async () => {
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { function_call: { name: "read_file", arguments: "{\"path\":" } } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { function_call: { arguments: "\"package.json\"}" } }, finish_reason: "function_call" }], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "legacy-function-call-model"
      });
      const task: TaskDetail = {
        kind: "primary",
        id: "task_openai_legacy_function_call",
        title: "Legacy function call fixture",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvals: [],
        pendingGuidance: [],
        events: [{ id: "event_goal", taskId: "task_openai_legacy_function_call", type: "user_message", createdAt: nowIso(), summary: "读取 package", payload: {} }]
      };

      const turn = await client.next(task, {
        streamId: "stream_openai_legacy_function",
        onAssistantDelta: async () => undefined,
        onThinkingDelta: async () => undefined
      });

      expect(turn.kind).toBe("tool_calls");
      expect(turn.kind === "tool_calls" ? turn.calls[0] : undefined).toMatchObject({
        toolName: "read_file",
        args: { path: "package.json" }
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("McpRegistry", () => {
  it("redacts MCP server secrets from public configuration responses", async () => {
    const store = new InMemoryWorkbenchStore();
    const registry = new McpRegistry(store);

    const created = await registry.createServer({
      id: "secret_mcp",
      label: "Secret MCP",
      transport: "streamable_http",
      url: "https://mcp.example.test/stream?api_key=mcp-secret-1234567890",
      args: [],
      env: {
        API_KEY: "sk-mcp-secret-1234567890",
        SAFE_LABEL: "visible"
      },
      enabled: true,
      toolRiskOverrides: {}
    });
    const listed = await registry.listServers();
    const stored = await store.getMcpServer("secret_mcp");

    expect(JSON.stringify(created)).not.toContain("sk-mcp-secret");
    expect(JSON.stringify(created)).not.toContain("mcp-secret-1234567890");
    expect(JSON.stringify(listed)).not.toContain("sk-mcp-secret");
    expect(JSON.stringify(listed)).not.toContain("mcp-secret-1234567890");
    expect(stored?.env["API_KEY"]).toBe("sk-mcp-secret-1234567890");
    expect(stored?.url).toContain("mcp-secret-1234567890");
  });

  it("validates MCP endpoints before saving transport changes", async () => {
    const store = new InMemoryWorkbenchStore();
    const registry = new McpRegistry(store);

    await expect(
      registry.createServer({
        id: "bad_http",
        label: "Bad HTTP MCP",
        transport: "streamable_http",
        url: "file:///tmp/mcp",
        args: [],
        env: {},
        enabled: true,
        toolRiskOverrides: {}
      })
    ).rejects.toThrow(/http or https/i);

    await registry.createServer({
      id: "stdio_mcp",
      label: "Stdio MCP",
      transport: "stdio",
      command: process.execPath,
      args: ["--version"],
      env: {},
      enabled: true,
      toolRiskOverrides: {}
    });

    await expect(registry.patchServer("stdio_mcp", { transport: "streamable_http" })).rejects.toThrow(/require url/i);
    const switched = await registry.patchServer("stdio_mcp", { transport: "streamable_http", url: "http://127.0.0.1:59999/mcp" });
    expect(switched.transport).toBe("streamable_http");
    expect(switched.url).toBe("http://127.0.0.1:59999/mcp");
    expect(switched.command).toBeUndefined();
  });

  it("discovers stdio MCP tools, routes execution through approval, and reuses global permission", async () => {
    const temp = mkdtempSync(join(repoTestTempRoot(), "tmp-scc-mcp-"));
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

  it("redacts secrets before materializing long MCP output on disk", async () => {
    const temp = mkdtempSync(join(repoTestTempRoot(), "tmp-scc-mcp-secret-output-"));
    let rawOutputRef = "";
    try {
      const script = join(temp, "secret-output-mcp.mjs");
      writeFileSync(script, longSecretMcpServerSource());
      const store = new InMemoryWorkbenchStore();
      const registry = new McpRegistry(store);
      await registry.createServer({
        id: "secret_output",
        label: "Secret output MCP",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        env: {},
        enabled: true,
        toolRiskOverrides: { long_secret: "workspace_read" }
      });

      const status = await registry.connectServer("secret_output");
      expect(status.state).toBe("connected");
      const result = await registry.execute({
        id: createId("tool_call"),
        toolName: "mcp__secret_output__long_secret",
        args: {}
      });
      const parsed = JSON.parse(result.output) as { rawOutputRef: string; summary: string; sanitized?: boolean };
      rawOutputRef = parsed.rawOutputRef;
      const rawOutput = readFileSync(rawOutputRef, "utf8");

      expect(result.ok).toBe(true);
      expect(parsed.sanitized).toBe(true);
      expect(parsed.summary).toContain("[redacted-secret]");
      expect(parsed.summary).toContain("Bearer [redacted-token]");
      expect(rawOutput).toContain("[redacted-secret]");
      expect(rawOutput).toContain("Bearer [redacted-token]");
      expect(result.output).not.toContain("sk-mcp-output-secret1234567890");
      expect(result.output).not.toContain("mcp-output-bearer-secret123456");
      expect(rawOutput).not.toContain("sk-mcp-output-secret1234567890");
      expect(rawOutput).not.toContain("mcp-output-bearer-secret123456");
      await registry.disconnectServer("secret_output");
    } finally {
      if (rawOutputRef) rmSync(rawOutputRef, { force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

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

  it("reconciles stale skill conflicts after deleting a conflicting skill", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store });
    await workbench.createSkill({
      title: "Release deploy file review",
      body: "# Release deploy file review\nRead release files before deployment review.",
      status: "candidate",
      applicability: {
        description: "Release deployment review",
        keywords: ["release", "deploy", "review"],
        requiredTools: ["read_file"]
      }
    });
    const conflicting = await workbench.createSkill({
      title: "Release deploy shell review",
      body: "# Release deploy shell review\nRun release commands before deployment review.",
      status: "candidate",
      applicability: {
        description: "Release deployment review",
        keywords: ["release", "deploy", "review"],
        requiredTools: ["run_command"]
      }
    });

    expect(await workbench.listSkillConflicts()).toHaveLength(1);

    await workbench.deleteSkill(conflicting.id);

    expect(await workbench.listSkillConflicts()).toHaveLength(0);
    expect((await store.listSkillConflicts())[0]?.status).toBe("resolved");
    expect((await workbench.listSkillCuratorItems()).some((item) => item.kind === "conflict")).toBe(false);
  });

  it("detects conflicts introduced by skill edits without duplicating open conflict rows", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore() });
    await workbench.createSkill({
      title: "Release note file review",
      body: "# Release note file review\nRead release notes and summarize the risky change.",
      status: "candidate",
      applicability: {
        description: "Release note review",
        keywords: ["release", "notes", "review"],
        requiredTools: ["read_file"]
      }
    });
    const edited = await workbench.createSkill({
      title: "Draft note review",
      body: "# Draft note review\nReview a draft note.",
      status: "candidate",
      applicability: {
        description: "Draft note review",
        keywords: ["draft"],
        requiredTools: ["read_file"]
      }
    });

    expect(await workbench.listSkillConflicts()).toHaveLength(0);

    await workbench.updateSkill(edited.id, {
      applicability: {
        keywords: ["release", "notes", "review"],
        requiredTools: ["run_command"]
      }
    });
    await workbench.updateSkill(edited.id, { title: "Release note command review" });

    const conflicts = await workbench.listSkillConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.skillIds).toContain(edited.id);

    await workbench.updateSkill(edited.id, {
      applicability: {
        requiredTools: ["read_file"]
      }
    });

    expect(await workbench.listSkillConflicts()).toHaveLength(0);
  });
});

describe("ShellToolExecutor", { timeout: 15_000 }, () => {
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

  it("decodes Windows command output without corrupting Chinese text", async () => {
    if (process.platform !== "win32") return;
    const executor = new ShellToolExecutor();
    const result = await executor.execute({
      id: createId("tool_call"),
      toolName: "run_command",
      args: {
        command: "[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936); [Console]::Out.Write('权限审批')"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("权限审批");
    expect(result.output).not.toContain("�");
  });

  it("unwraps redundant PowerShell -Command wrappers before execution on Windows", async () => {
    if (process.platform !== "win32") return;
    const executor = new ShellToolExecutor();
    const result = await executor.execute({
      id: createId("tool_call"),
      toolName: "run_command",
      args: {
        command: "powershell -NoProfile -Command \"(1..3 | ForEach-Object { $_ * 2 }) -join ','\""
      }
    });

    expect(result.ok).toBe(true);
    expect(result.output.trim()).toContain("2,4,6");
  });

  it("searches workspace files with OR terms and returns snippets rather than full file content", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-search-files-"));
    try {
      mkdirSync(join(workRoot, "src"), { recursive: true });
      writeFileSync(join(workRoot, "src", "copy.ts"), "export const fullAccess = '完全访问';\nexport const auto = '自动审批';\n");
      const executor = new ShellToolExecutor();

      const result = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "search_files",
          args: { query: "仅非破坏性|自动审批|完全访问", path: "src" }
        },
        { workRoot }
      );
      const parsed = JSON.parse(result.output) as { kind: string; note: string; matches: Array<{ line?: number; text?: string; matchedTerm?: string }> };

      expect(result.ok).toBe(true);
      expect(parsed.kind).toBe("workspace_file_search");
      expect(parsed.note).toContain("read_file");
      expect(parsed.matches.map((match) => match.matchedTerm)).toContain("完全访问");
      expect(parsed.matches.map((match) => match.matchedTerm)).toContain("自动审批");
      expect(parsed.matches.every((match) => (match.text ?? "").length < 260)).toBe(true);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
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
      expectSamePath(result.output, workRoot);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("materializes long command output inside the task work root", async () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "scc-default-output-root-"));
    const workRoot = mkdtempSync(join(tmpdir(), "scc-command-output-root-"));
    try {
      const executor = new ShellToolExecutor(defaultRoot);
      const result = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "run_command",
          args: { command: "node -e \"console.log('x'.repeat(13050))\"" }
        },
        { workRoot }
      );

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output) as { truncated: boolean; rawOutputRef: string; totalChars: number };
      expect(parsed.truncated).toBe(true);
      expect(parsed.totalChars).toBeGreaterThan(12000);
      expect(existsSync(parsed.rawOutputRef)).toBe(true);

      const taskOutputRoot = resolve(workRoot, "data", "tool-output");
      const defaultOutputRoot = resolve(defaultRoot, "data", "tool-output");
      expect(relative(taskOutputRoot, resolve(parsed.rawOutputRef))).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(relative(defaultOutputRoot, resolve(parsed.rawOutputRef))).toMatch(/^\.\.(?:[\\/]|$)/);
    } finally {
      rmSync(defaultRoot, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("redacts secrets before materializing long command output on disk", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-command-output-secret-"));
    try {
      const executor = new ShellToolExecutor(workRoot);
      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "run_command",
        args: {
          command: "node -e \"console.log('api_key=sk-long-output-secret1234567890 ' + 'x'.repeat(13050) + ' Bearer long-output-bearer-secret123456')\""
        }
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output) as { rawOutputRef: string; summary: string; sanitized?: boolean };
      const rawOutput = readFileSync(parsed.rawOutputRef, "utf8");
      expect(parsed.sanitized).toBe(true);
      expect(parsed.summary).toContain("[redacted-secret]");
      expect(parsed.summary).toContain("Bearer [redacted-token]");
      expect(rawOutput).toContain("[redacted-secret]");
      expect(rawOutput).toContain("Bearer [redacted-token]");
      expect(result.output).not.toContain("sk-long-output-secret1234567890");
      expect(result.output).not.toContain("long-output-bearer-secret123456");
      expect(rawOutput).not.toContain("sk-long-output-secret1234567890");
      expect(rawOutput).not.toContain("long-output-bearer-secret123456");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 15_000);

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

  it("rejects read_file calls without a concrete path", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-read-missing-path-"));
    try {
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: {}
      });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Missing path");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns compact full content for moderate line-heavy files without inlining the UI body", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-read-line-heavy-"));
    try {
      const lines = Array.from({ length: 720 }, (_, index) => `line-${index + 1}`);
      writeFileSync(join(temp, "index.html"), lines.join("\n"), "utf8");
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "index.html" }
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed["mode"]).toBe("full_compact");
      expect(parsed["displayMode"]).toBe("summary_only");
      expect(parsed["partial"]).toBe(false);
      expect(String(parsed["content"])).toContain("line-1");
      expect(String(parsed["content"])).toContain("line-720");
      expect(String(parsed["content"])).toContain("line-360");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("excludes internal model trace folders from workspace read, search, and list tools", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-agent-workbench-trace-exclude-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      mkdirSync(join(temp, "data", "logs", "model-traces", "task_1"), { recursive: true });
      writeFileSync(join(temp, "src", "app.ts"), "export const visible = 'project code';\n", "utf8");
      writeFileSync(join(temp, "data", "logs", "model-traces", "task_1", "trace.jsonl"), "secret trace payload\n", "utf8");
      const executor = new ShellToolExecutor(temp);

      const read = await executor.execute({
        id: createId("tool_call"),
        toolName: "read_file",
        args: { path: "data/logs/model-traces/task_1/trace.jsonl" }
      });
      const search = await executor.execute({
        id: createId("tool_call"),
        toolName: "search_files",
        args: { path: ".", query: "secret trace payload" }
      });
      const list = await executor.execute({
        id: createId("tool_call"),
        toolName: "list_files",
        args: { path: ".", recursive: true }
      });

      expect(read.ok).toBe(false);
      expect(read.output).toContain("internal trace files are excluded");
      expect(search.ok).toBe(true);
      const searchJson = JSON.parse(search.output) as { matches?: unknown[] };
      expect(search.output).not.toContain("model-traces");
      expect(searchJson.matches).toEqual([]);
      expect(list.ok).toBe(true);
      expect(list.output).toContain("app.ts");
      expect(list.output).not.toContain("model-traces");
      expect(list.output).not.toContain("trace.jsonl");
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
      expect(readdirSync(temp).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("preserves existing file mode when atomically replacing file content", async () => {
    if (process.platform === "win32") return;
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-write-mode-"));
    try {
      const file = join(temp, "script.sh");
      const original = "#!/bin/sh\necho before\n";
      writeFileSync(file, original, "utf8");
      chmodSync(file, 0o755);
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "write_file",
        args: {
          path: "script.sh",
          expectedHash: createHash("sha256").update(original).digest("hex").slice(0, 16),
          content: "#!/bin/sh\necho after\n"
        }
      });

      expect(result.ok).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o755);
      expect(readdirSync(temp).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("includes bounded before-and-after snippets in edit_file results", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-edit-preview-"));
    try {
      const file = join(temp, "note.txt");
      const initial = "export function sum(numbers) {\n  return numbers.length;\n}\n";
      writeFileSync(file, initial, "utf8");
      const executor = new ShellToolExecutor(temp);

      const result = await executor.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: "note.txt",
          expectedHash: createHash("sha256").update(initial).digest("hex").slice(0, 16),
          edits: [{ startLine: 2, endLine: 2, newText: "  return numbers.reduce((acc, n) => acc + n, 0);" }]
        }
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      const applied = Array.isArray(parsed["editsApplied"]) ? parsed["editsApplied"] as Array<Record<string, unknown>> : [];
      expect(applied).toHaveLength(1);
      expect(applied[0]?.["beforeText"]).toContain("numbers.length");
      expect(applied[0]?.["afterText"]).toContain("numbers.reduce");
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

  it("rejects malformed file mutation arguments without changing disk state", async () => {
    const temp = mkdtempSync(join(tmpdir(), "tmp-scc-tool-fuzz-"));
    const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
    try {
      const file = join(temp, "note.txt");
      const original = "alpha\nbeta\ngamma\n";
      writeFileSync(file, original, "utf8");
      const executor = new ShellToolExecutor(temp);
      const attempts: Array<{ name: string; call: ToolCall; output: RegExp }> = [
        {
          name: "empty edit list",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash(original), edits: [] }
          },
          output: /No edits provided/
        },
        {
          name: "non integer edit range",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash(original), edits: [{ startLine: 1.5, endLine: 2, newText: "changed" }] }
          },
          output: /positive integers/
        },
        {
          name: "negative edit range",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash(original), edits: [{ startLine: 3, endLine: 1, newText: "changed" }] }
          },
          output: /Invalid edit range/
        },
        {
          name: "range past end",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash(original), edits: [{ startLine: 9, endLine: 9, newText: "changed" }] }
          },
          output: /no longer matches/
        },
        {
          name: "expected text mismatch",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash(original), edits: [{ startLine: 2, endLine: 2, expectedText: "delta", newText: "changed" }] }
          },
          output: /Expected text/
        },
        {
          name: "overlapping edit ranges",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: {
              path: "note.txt",
              expectedHash: hash(original),
              edits: [
                { startLine: 1, endLine: 2, newText: "first" },
                { startLine: 2, endLine: 3, newText: "second" }
              ]
            }
          },
          output: /must not overlap/
        },
        {
          name: "duplicate insertion anchors",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: {
              path: "note.txt",
              expectedHash: hash(original),
              edits: [
                { startLine: 2, endLine: 1, newText: "insert one" },
                { startLine: 2, endLine: 1, newText: "insert two" }
              ]
            }
          },
          output: /must not overlap/
        },
        {
          name: "expected hash mismatch",
          call: {
            id: createId("tool_call"),
            toolName: "edit_file",
            args: { path: "note.txt", expectedHash: hash("stale\n"), edits: [{ startLine: 1, endLine: 1, newText: "changed" }] }
          },
          output: /File changed before write/
        },
        {
          name: "write without hash",
          call: {
            id: createId("tool_call"),
            toolName: "write_file",
            args: { path: "created.txt", content: "created" }
          },
          output: /Missing expectedHash/
        },
        {
          name: "new file intent against existing file",
          call: {
            id: createId("tool_call"),
            toolName: "write_file",
            args: { path: "note.txt", expectedHash: "__new__", content: "replacement" }
          },
          output: /File changed before write/
        }
      ];

      for (const attempt of attempts) {
        const result = await executor.execute(attempt.call);
        expect(result.ok, attempt.name).toBe(false);
        expect(result.output, attempt.name).toMatch(attempt.output);
        expect(readFileSync(file, "utf8"), attempt.name).toBe(original);
        expect(existsSync(join(temp, "created.txt")), attempt.name).toBe(false);
      }

      const adjacent = await executor.execute({
        id: createId("tool_call"),
        toolName: "edit_file",
        args: {
          path: "note.txt",
          expectedHash: hash(original),
          edits: [
            { startLine: 1, endLine: 1, expectedText: "alpha", newText: "ALPHA" },
            { startLine: 3, endLine: 3, expectedText: "gamma", newText: "GAMMA" }
          ]
        }
      });
      expect(adjacent.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects linked directory escapes for read, write, and search operations", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-tools-linked-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "scc-tools-linked-outside-"));
    try {
      writeFileSync(join(outsideRoot, "secret.txt"), "outside secret", "utf8");
      createDirectoryAlias(outsideRoot, join(workRoot, "escape"));
      const executor = new ShellToolExecutor();

      const read = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "read_file",
          args: { path: "escape/secret.txt" }
        },
        { workRoot }
      );
      expect(read.ok).toBe(false);
      expect(read.output).toContain("outside the workspace");

      const write = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "write_file",
          args: { path: "escape/new.txt", expectedHash: "__new__", content: "should not escape" }
        },
        { workRoot }
      );
      expect(write.ok).toBe(false);
      expect(write.output).toContain("outside the workspace");

      const search = await executor.execute(
        {
          id: createId("tool_call"),
          toolName: "search_files",
          args: { query: "secret", path: "escape" }
        },
        { workRoot }
      );
      expect(search.ok).toBe(false);
      expect(search.output).toContain("outside the workspace");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects linked file escapes for read, write, edit, and search operations", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "scc-tools-linked-file-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "scc-tools-linked-file-outside-"));
    try {
      const outsideFile = join(outsideRoot, "secret.txt");
      writeFileSync(outsideFile, "outside file secret", "utf8");
      try {
        symlinkSync(outsideFile, join(workRoot, "linked-secret.txt"), "file");
      } catch {
        return;
      }
      const executor = new ShellToolExecutor(workRoot);
      const attempts: ToolCall[] = [
        { id: createId("tool_call"), toolName: "read_file", args: { path: "linked-secret.txt" } },
        { id: createId("tool_call"), toolName: "search_files", args: { path: "linked-secret.txt", query: "secret" } },
        { id: createId("tool_call"), toolName: "write_file", args: { path: "linked-secret.txt", expectedHash: "__new__", content: "overwrite" } },
        {
          id: createId("tool_call"),
          toolName: "edit_file",
          args: {
            path: "linked-secret.txt",
            expectedHash: createHash("sha256").update("outside file secret").digest("hex").slice(0, 16),
            edits: [{ startLine: 1, endLine: 1, newText: "overwrite" }]
          }
        }
      ];

      for (const call of attempts) {
        const result = await executor.execute(call);
        expect(result.ok, call.toolName).toBe(false);
        expect(result.output, call.toolName).toContain("outside the workspace");
      }
      expect(readFileSync(outsideFile, "utf8")).toBe("outside file secret");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects absolute, sibling-prefix, and linked-directory workspace escapes across file tools", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scc-tools-path-parent-"));
    const workRoot = join(parent, "workspace");
    const siblingRoot = join(parent, "workspace-evil");
    const outsideRoot = join(parent, "outside");
    mkdirSync(workRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    try {
      writeFileSync(join(workRoot, "inside.txt"), "inside", "utf8");
      writeFileSync(join(siblingRoot, "secret.txt"), "sibling secret", "utf8");
      writeFileSync(join(outsideRoot, "secret.txt"), "outside secret", "utf8");
      createDirectoryAlias(outsideRoot, join(workRoot, "escape"));
      const executor = new ShellToolExecutor(workRoot);
      const escapedWritePath = join(outsideRoot, "created.txt");

      const attempts: ToolCall[] = [
        { id: createId("tool_call"), toolName: "read_file", args: { path: join(siblingRoot, "secret.txt") } },
        { id: createId("tool_call"), toolName: "read_file", args: { path: join(outsideRoot, "secret.txt") } },
        { id: createId("tool_call"), toolName: "read_file", args: { path: "../workspace-evil/secret.txt" } },
        { id: createId("tool_call"), toolName: "read_file", args: { path: "escape/secret.txt" } },
        { id: createId("tool_call"), toolName: "list_files", args: { path: "escape" } },
        { id: createId("tool_call"), toolName: "search_files", args: { path: "escape", query: "secret" } },
        { id: createId("tool_call"), toolName: "write_file", args: { path: "escape/created.txt", expectedHash: "__new__", content: "escaped write" } },
        {
          id: createId("tool_call"),
          toolName: "edit_file",
          args: {
            path: "escape/created.txt",
            expectedHash: "__new__",
            edits: [{ startLine: 1, endLine: 1, newText: "escaped edit\n" }]
          }
        }
      ];

      for (const call of attempts) {
        const result = await executor.execute(call);
        expect(result.ok, `${call.toolName} should reject ${String(call.args["path"])}`).toBe(false);
        expect(result.output).toContain("outside the workspace");
      }
      expect(existsSync(escapedWritePath)).toBe(false);

      const inside = await executor.execute({ id: createId("tool_call"), toolName: "read_file", args: { path: "inside.txt" } });
      expect(inside.ok).toBe(true);
      expect(inside.output).toContain("inside");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function createDirectoryAlias(target: string, aliasPath: string): void {
  symlinkSync(target, aliasPath, process.platform === "win32" ? "junction" : "dir");
}

describe("OpenAI provider config", () => {
  it("does not implicitly load a local API key document unless SCC_API_KEY_FILE is set", () => {
    const previous = {
      apiKey: process.env["OPENAI_API_KEY"],
      agentApiKey: process.env["AGENT_WORKBENCH_OPENAI_API_KEY"],
      sccApiKey: process.env["SCC_OPENAI_API_KEY"],
      baseUrl: process.env["OPENAI_BASE_URL"],
      baseurl: process.env["OPENAI_BASEURL"],
      agentBaseUrl: process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"],
      sccBaseUrl: process.env["SCC_OPENAI_BASE_URL"],
      agentModel: process.env["AGENT_WORKBENCH_MODEL"],
      model: process.env["SCC_MODEL"],
      openAiModel: process.env["OPENAI_MODEL"],
      apiKeyFile: process.env["SCC_API_KEY_FILE"],
      provider: process.env["SCC_API_PROVIDER"],
      openAiProvider: process.env["OPENAI_PROVIDER"]
    };

    try {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["AGENT_WORKBENCH_OPENAI_API_KEY"];
      delete process.env["SCC_OPENAI_API_KEY"];
      delete process.env["OPENAI_BASE_URL"];
      delete process.env["OPENAI_BASEURL"];
      delete process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"];
      delete process.env["SCC_OPENAI_BASE_URL"];
      delete process.env["AGENT_WORKBENCH_MODEL"];
      delete process.env["SCC_MODEL"];
      delete process.env["OPENAI_MODEL"];
      delete process.env["SCC_API_KEY_FILE"];
      delete process.env["SCC_API_PROVIDER"];
      delete process.env["OPENAI_PROVIDER"];

      expect(loadOpenAiConfig()).toEqual({});
      expect(loadOpenAiProviderConfig()).toEqual({});
    } finally {
      restoreEnv("OPENAI_API_KEY", previous.apiKey);
      restoreEnv("AGENT_WORKBENCH_OPENAI_API_KEY", previous.agentApiKey);
      restoreEnv("SCC_OPENAI_API_KEY", previous.sccApiKey);
      restoreEnv("OPENAI_BASE_URL", previous.baseUrl);
      restoreEnv("OPENAI_BASEURL", previous.baseurl);
      restoreEnv("AGENT_WORKBENCH_OPENAI_BASE_URL", previous.agentBaseUrl);
      restoreEnv("SCC_OPENAI_BASE_URL", previous.sccBaseUrl);
      restoreEnv("AGENT_WORKBENCH_MODEL", previous.agentModel);
      restoreEnv("SCC_MODEL", previous.model);
      restoreEnv("OPENAI_MODEL", previous.openAiModel);
      restoreEnv("SCC_API_KEY_FILE", previous.apiKeyFile);
      restoreEnv("SCC_API_PROVIDER", previous.provider);
      restoreEnv("OPENAI_PROVIDER", previous.openAiProvider);
    }
  });

  it("loads apiKey and baseURL from the same API key document section", () => {
    const temp = mkdtempSync(join(tmpdir(), "scc-apikey-"));
    const filePath = join(temp, "dont_touch_(APIKEY).md");
    const previous = {
      apiKey: process.env["OPENAI_API_KEY"],
      agentApiKey: process.env["AGENT_WORKBENCH_OPENAI_API_KEY"],
      sccApiKey: process.env["SCC_OPENAI_API_KEY"],
      baseUrl: process.env["OPENAI_BASE_URL"],
      baseurl: process.env["OPENAI_BASEURL"],
      agentBaseUrl: process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"],
      sccBaseUrl: process.env["SCC_OPENAI_BASE_URL"],
      agentModel: process.env["AGENT_WORKBENCH_MODEL"],
      model: process.env["SCC_MODEL"],
      openAiModel: process.env["OPENAI_MODEL"],
      apiKeyFile: process.env["SCC_API_KEY_FILE"],
      provider: process.env["SCC_API_PROVIDER"],
      openAiProvider: process.env["OPENAI_PROVIDER"]
    };

    try {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["AGENT_WORKBENCH_OPENAI_API_KEY"];
      delete process.env["SCC_OPENAI_API_KEY"];
      delete process.env["OPENAI_BASE_URL"];
      delete process.env["OPENAI_BASEURL"];
      delete process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"];
      delete process.env["SCC_OPENAI_BASE_URL"];
      delete process.env["AGENT_WORKBENCH_MODEL"];
      delete process.env["SCC_MODEL"];
      delete process.env["OPENAI_MODEL"];
      process.env["SCC_API_KEY_FILE"] = filePath;
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
      restoreEnv("AGENT_WORKBENCH_OPENAI_API_KEY", previous.agentApiKey);
      restoreEnv("SCC_OPENAI_API_KEY", previous.sccApiKey);
      restoreEnv("OPENAI_BASE_URL", previous.baseUrl);
      restoreEnv("OPENAI_BASEURL", previous.baseurl);
      restoreEnv("AGENT_WORKBENCH_OPENAI_BASE_URL", previous.agentBaseUrl);
      restoreEnv("SCC_OPENAI_BASE_URL", previous.sccBaseUrl);
      restoreEnv("AGENT_WORKBENCH_MODEL", previous.agentModel);
      restoreEnv("SCC_MODEL", previous.model);
      restoreEnv("OPENAI_MODEL", previous.openAiModel);
      restoreEnv("SCC_API_KEY_FILE", previous.apiKeyFile);
      restoreEnv("SCC_API_PROVIDER", previous.provider);
      restoreEnv("OPENAI_PROVIDER", previous.openAiProvider);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("loads scoped Agent Workbench API key environment overrides", () => {
    const previous = {
      apiKey: process.env["OPENAI_API_KEY"],
      agentApiKey: process.env["AGENT_WORKBENCH_OPENAI_API_KEY"],
      sccApiKey: process.env["SCC_OPENAI_API_KEY"],
      baseUrl: process.env["OPENAI_BASE_URL"],
      baseurl: process.env["OPENAI_BASEURL"],
      agentBaseUrl: process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"],
      sccBaseUrl: process.env["SCC_OPENAI_BASE_URL"],
      model: process.env["AGENT_WORKBENCH_MODEL"],
      legacyModel: process.env["SCC_MODEL"],
      openAiModel: process.env["OPENAI_MODEL"],
      apiKeyFile: process.env["SCC_API_KEY_FILE"]
    };

    try {
      delete process.env["OPENAI_API_KEY"];
      process.env["AGENT_WORKBENCH_OPENAI_API_KEY"] = "agent-env-key";
      process.env["SCC_OPENAI_API_KEY"] = "legacy-env-key";
      delete process.env["OPENAI_BASE_URL"];
      delete process.env["OPENAI_BASEURL"];
      process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"] = "https://agent.example/v1";
      process.env["SCC_OPENAI_BASE_URL"] = "https://legacy.example/v1";
      process.env["AGENT_WORKBENCH_MODEL"] = "agent-model";
      process.env["SCC_MODEL"] = "legacy-model";
      delete process.env["OPENAI_MODEL"];
      delete process.env["SCC_API_KEY_FILE"];

      expect(loadOpenAiConfig()).toEqual({
        apiKey: "agent-env-key",
        baseURL: "https://agent.example/v1",
        model: "agent-model"
      });

      process.env["OPENAI_API_KEY"] = "openai-env-key";
      process.env["OPENAI_BASE_URL"] = "https://openai.example/v1";
      expect(loadOpenAiConfig()).toEqual({
        apiKey: "openai-env-key",
        baseURL: "https://openai.example/v1",
        model: "agent-model"
      });
    } finally {
      restoreEnv("OPENAI_API_KEY", previous.apiKey);
      restoreEnv("AGENT_WORKBENCH_OPENAI_API_KEY", previous.agentApiKey);
      restoreEnv("SCC_OPENAI_API_KEY", previous.sccApiKey);
      restoreEnv("OPENAI_BASE_URL", previous.baseUrl);
      restoreEnv("OPENAI_BASEURL", previous.baseurl);
      restoreEnv("AGENT_WORKBENCH_OPENAI_BASE_URL", previous.agentBaseUrl);
      restoreEnv("SCC_OPENAI_BASE_URL", previous.sccBaseUrl);
      restoreEnv("AGENT_WORKBENCH_MODEL", previous.model);
      restoreEnv("SCC_MODEL", previous.legacyModel);
      restoreEnv("OPENAI_MODEL", previous.openAiModel);
      restoreEnv("SCC_API_KEY_FILE", previous.apiKeyFile);
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

function longSecretMcpServerSource(): string {
  return `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "secret-output-mcp", version: "1.0.0" });
server.registerTool(
  "long_secret",
  {
    description: "Return long output containing secrets.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  async () => ({
    content: [{
      type: "text",
      text: "api_key=sk-mcp-output-secret1234567890 " + "x".repeat(13050) + " Bearer mcp-output-bearer-secret123456"
    }]
  })
);
await server.connect(new StdioServerTransport());
`;
}
