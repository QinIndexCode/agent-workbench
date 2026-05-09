import type { RiskCategory, TaskDetail, TaskEvent } from "@scc/shared";
import { createId, nowIso } from "./ids.js";
import { classifyTaskIntent, latestUserText, type TaskIntent } from "./task-intent.js";

export type TaskGraphRole = "research" | "implement" | "verify" | "review" | "final";
export type TaskGraphStatus = "active" | "completed" | "blocked";
export type TaskGraphNodeStatus = "pending" | "running" | "completed" | "blocked";
export type TaskToolClass = RiskCategory | "memory" | "state";
export type VerificationStatus = "pending" | "passed" | "failed" | "not_applicable";
export type VerificationKind = "none" | "manual" | "read_only" | "tests" | "build" | "typecheck";

export interface TaskGraphVerification {
  kind: VerificationKind;
  method: string;
  required: boolean;
  status: VerificationStatus;
  evidenceRefs: string[];
  commands?: string[];
}

export interface TaskGraphNode {
  id: string;
  role: TaskGraphRole;
  objective: string;
  allowedToolClasses: TaskToolClass[];
  contextHints: string[];
  acceptanceCriteria: string[];
  verification: TaskGraphVerification;
  risk: RiskCategory | "none";
  status: TaskGraphNodeStatus;
  evidenceRefs: string[];
}

export interface TaskGraph {
  taskId: string;
  nodes: TaskGraphNode[];
  activeNodeId: string;
  status: TaskGraphStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AttentionPacket {
  system: string;
  messages: unknown[];
  activeNode?: TaskGraphNode;
  evidenceRefs: string[];
  tokenBudget: {
    maxTotal: number;
    reservedForResponse: number;
    usedTokens: number;
  };
}

export interface VerificationResultRecord {
  nodeId: string;
  status: "passed" | "failed";
  evidenceRef: string;
  toolName: string;
  summary: string;
}

export function compileTaskGraph(task: TaskDetail): TaskGraph | null {
  const intent = classifyTaskIntent(task);
  if (intent === "direct_chat") return null;
  const objective = latestUserText(task) || task.title;
  if (!objective.trim()) return null;
  const now = nowIso();
  const nodes = nodesForIntent(intent, task.id, objective.trim());
  const active = nodes.find((node) => node.status === "running") ?? nodes[0];
  if (!active) return null;
  return {
    taskId: task.id,
    nodes,
    activeNodeId: active.id,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

export function taskGraphFromEvents(task: TaskDetail): TaskGraph | null {
  const created = [...task.events].reverse().find((event) => event.type === "task_graph_created" && !event.reverted);
  const graph = graphFromPayload(created?.payload["graph"]);
  if (!graph) return null;
  const activeNodeId = latestActiveNodeId(task) ?? graph.activeNodeId;
  const evidenceRefs = collectEvidenceRefs(task);
  const verification = latestVerificationStatus(task);
  const nodes = graph.nodes.map((node) => {
    const nodeEvidence = evidenceRefs.filter((ref) => ref.includes(`node:${node.id}`) || !ref.includes("node:"));
    const isActive = node.id === activeNodeId;
    const verified =
      verification && verification.nodeId === node.id
        ? {
            ...node.verification,
            status: verification.status,
            evidenceRefs: uniqueStrings([...node.verification.evidenceRefs, verification.evidenceRef])
          }
        : node.verification;
    return {
      ...node,
      status: isActive ? "running" as const : node.status === "running" ? "pending" as const : node.status,
      evidenceRefs: uniqueStrings([...node.evidenceRefs, ...nodeEvidence]),
      verification: verified
    };
  });
  return {
    ...graph,
    activeNodeId,
    status: verification?.status === "failed" ? "blocked" : graph.status,
    nodes,
    updatedAt: task.updatedAt
  };
}

export function activeTaskGraphNode(task: TaskDetail): TaskGraphNode | undefined {
  const graph = taskGraphFromEvents(task);
  return graph?.nodes.find((node) => node.id === graph.activeNodeId);
}

export function buildTaskGraphSystemLayer(graph: TaskGraph | null): string {
  if (!graph) return "";
  const nodeLines = graph.nodes.map((node) => {
    const marker = node.id === graph.activeNodeId ? "active" : node.status;
    return `- ${node.id} [${marker}/${node.role}]: ${truncate(node.objective, 180)}`;
  });
  return [
    "## Task Graph",
    "Use this graph as durable task state. It is not a conversation title and must not override the latest user request.",
    `Status: ${graph.status}`,
    `Active node: ${graph.activeNodeId}`,
    ...nodeLines
  ].join("\n");
}

export function buildActiveNodeUserMessage(graph: TaskGraph | null): string {
  if (!graph) return "";
  const node = graph.nodes.find((item) => item.id === graph.activeNodeId);
  if (!node) return "";
  return [
    "## Active Node",
    `Role: ${node.role}`,
    `Objective: ${node.objective}`,
    `Allowed tool classes: ${node.allowedToolClasses.join(", ") || "none"}`,
    `Risk: ${node.risk}`,
    "Acceptance criteria:",
    ...node.acceptanceCriteria.map((item) => `- ${item}`),
    `Verification: ${node.verification.method}`,
    `Verification required: ${node.verification.required ? "yes" : "no"}`,
    `Verification status: ${node.verification.status}`,
    `Evidence refs: ${node.evidenceRefs.length > 0 ? node.evidenceRefs.join(", ") : "none"}`,
    "Continue from this active node. Treat previous task titles or greetings as history, not as the current goal."
  ].join("\n");
}

export function taskGraphEvidenceRefs(task: TaskDetail): string[] {
  return collectEvidenceRefs(task);
}

export function toolAllowedByTaskGraph(task: TaskDetail, toolName: string, description = ""): boolean {
  const node = activeTaskGraphNode(task);
  if (!node) return true;
  if (node.role === "final") return false;
  const classes = toolClassesForName(toolName, description);
  if (classes.length === 0) return node.role === "implement" || node.role === "verify";
  return classes.some((toolClass) => node.allowedToolClasses.includes(toolClass));
}

export function verificationResultFromToolEvent(task: TaskDetail, event: TaskEvent): VerificationResultRecord | null {
  if (event.type !== "tool_result" || event.reverted) return null;
  const graph = taskGraphFromEvents(task);
  if (!graph) return null;
  const verifyNode = graph.nodes.find((node) => node.role === "verify" && node.verification.required);
  if (!verifyNode) return null;
  const toolName = String(event.payload["toolName"] ?? "");
  if (!isVerificationToolResult(event, toolName)) return null;
  const ok = event.payload["ok"] !== false;
  return {
    nodeId: verifyNode.id,
    status: ok ? "passed" : "failed",
    evidenceRef: event.id,
    toolName,
    summary: `${toolName} ${ok ? "passed" : "failed"}`
  };
}

export function completionBlocker(task: TaskDetail): string | null {
  const graph = taskGraphFromEvents(task);
  if (!graph) return null;
  const required = graph.nodes.filter((node) => node.verification.required);
  if (required.length === 0) return null;
  const hasPassed = task.events.some((event) =>
    event.type === "verification_result_recorded" &&
    !event.reverted &&
    event.payload["status"] === "passed"
  );
  if (hasPassed) return null;
  const failed = [...task.events].reverse().find((event) =>
    event.type === "verification_result_recorded" &&
    !event.reverted &&
    event.payload["status"] === "failed"
  );
  if (failed) return "Verification failed; review the recorded evidence before completing the task.";
  const commands = uniqueStrings(required.flatMap((node) => node.verification.commands ?? []));
  const commandText = commands.length > 0 ? ` Expected verification: ${commands.join(" && ")}.` : "";
  return `Verification evidence is required before this task can be marked completed.${commandText}`;
}

function nodesForIntent(intent: TaskIntent, taskId: string, objective: string): TaskGraphNode[] {
  if (intent === "tool_inventory") {
    return [
      node(taskId, "research", objective, ["workspace_read", "network"], [
        "Explain callable capabilities from the available safe tool surface.",
        "Do not create files, edit memory, edit skills, or run persistent side-effect tools."
      ], {
        kind: "read_only",
        method: "Use only read-only evidence or answer directly if no evidence is needed.",
        required: false
      }, "workspace_read", "running"),
      node(taskId, "final", "Report the safe capability check outcome.", [], [
        "Mention that write, memory, and skill mutation require explicit user authorization."
      ], { kind: "none", method: "No external verification required.", required: false }, "none")
    ];
  }
  if (intent === "code_change") {
    const runtimeVerification = needsRuntimeVerification(objective);
    return [
      node(taskId, "implement", objective, ["workspace_read", "workspace_write", "shell", "network", "state"], [
        "Read only the files needed for the active change.",
        "Make scoped edits and keep every tool result as evidence."
      ], {
        kind: runtimeVerification ? "build" : "manual",
        method: runtimeVerification
          ? "Run the relevant typecheck, test, build, or smoke command before final completion."
          : "Record file changes and any manual verification or explicit unverified item.",
        required: runtimeVerification,
        ...(runtimeVerification ? { commands: ["npm.cmd run typecheck", "npm.cmd test", "npm.cmd run build"] } : {})
      }, "workspace_write", "running"),
      node(taskId, "verify", `Verify: ${objective}`, ["workspace_read", "shell", "network"], [
        "Run the narrowest meaningful command first, then broader gates when the change touches shared behavior.",
        "If verification fails, record the failure and return to implementation with evidence."
      ], {
        kind: runtimeVerification ? "tests" : "manual",
        method: runtimeVerification ? "Use command output as verification evidence." : "Manual verification may be enough for tiny text-only edits.",
        required: runtimeVerification,
        ...(runtimeVerification ? { commands: ["npm.cmd run typecheck", "npm.cmd test", "npm.cmd run build"] } : {})
      }, "shell"),
      node(taskId, "review", `Review diff and evidence for: ${objective}`, ["workspace_read", "shell"], [
        "Check changed-file scope, evidence, and remaining risk before final response."
      ], { kind: "manual", method: "Review diff and evidence pack.", required: false }, "workspace_read"),
      node(taskId, "final", `Summarize outcome for: ${objective}`, [], [
        "Final answer includes changed files, verification evidence, and any unverified items."
      ], { kind: "none", method: "No tool use in final node.", required: false }, "none")
    ];
  }
  if (intent === "memory_skill_admin") {
    return [
      node(taskId, "implement", objective, ["workspace_read", "memory", "state"], [
        "Only mutate memory or skills when the user explicitly requested that mutation.",
        "Keep outputs compact and auditable."
      ], { kind: "manual", method: "Confirm the memory or skill mutation result event.", required: false }, "workspace_write", "running"),
      node(taskId, "final", `Report memory or skill admin outcome for: ${objective}`, [], [
        "State exactly what changed or why no mutation was made."
      ], { kind: "none", method: "No external verification required.", required: false }, "none")
    ];
  }
  return [
    node(taskId, "research", objective, ["workspace_read", "network"], [
      "Gather only evidence needed for the current question.",
      "Prefer source and local project evidence over stale summaries."
    ], { kind: "read_only", method: "Use read-only tool evidence where needed.", required: false }, "workspace_read", "running"),
    node(taskId, "final", `Answer from evidence: ${objective}`, [], [
      "Answer with evidence and call out uncertainty."
    ], { kind: "none", method: "No external verification required.", required: false }, "none")
  ];
}

function node(
  taskId: string,
  role: TaskGraphRole,
  objective: string,
  allowedToolClasses: TaskToolClass[],
  acceptanceCriteria: string[],
  verification: Omit<TaskGraphVerification, "status" | "evidenceRefs">,
  risk: RiskCategory | "none",
  status: TaskGraphNodeStatus = "pending"
): TaskGraphNode {
  return {
    id: createId(`node_${role}`),
    role,
    objective,
    allowedToolClasses,
    contextHints: contextHintsForRole(role, taskId),
    acceptanceCriteria,
    verification: {
      ...verification,
      status: verification.required ? "pending" : "not_applicable",
      evidenceRefs: []
    },
    risk,
    status,
    evidenceRefs: []
  };
}

function contextHintsForRole(role: TaskGraphRole, taskId: string): string[] {
  if (role === "implement") return [`task:${taskId}`, "recent_file_state", "recent_tool_evidence"];
  if (role === "verify") return [`task:${taskId}`, "verification_commands", "recent_tool_evidence"];
  if (role === "review") return [`task:${taskId}`, "diff_summary", "evidence_pack"];
  if (role === "research") return [`task:${taskId}`, "recent_role_history", "read_only_evidence"];
  return [`task:${taskId}`, "evidence_pack"];
}

function needsRuntimeVerification(objective: string): boolean {
  return /(react|vite|next|前端|页面|博客|网站|应用|组件|界面|修复|实现|优化|重构|测试|构建|build|test|typecheck|typescript|javascript|frontend|backend|ui)/iu.test(objective);
}

function latestActiveNodeId(task: TaskDetail): string | undefined {
  const event = [...task.events].reverse().find((item) => item.type === "task_graph_node_started" && !item.reverted);
  const value = event?.payload["nodeId"];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function latestVerificationStatus(task: TaskDetail): { nodeId: string; status: VerificationStatus; evidenceRef: string } | null {
  const event = [...task.events].reverse().find((item) => item.type === "verification_result_recorded" && !item.reverted);
  if (!event) return null;
  const nodeId = String(event.payload["nodeId"] ?? "").trim();
  const status = event.payload["status"];
  const evidenceRef = String(event.payload["evidenceRef"] ?? event.id);
  if (!nodeId || (status !== "passed" && status !== "failed" && status !== "pending" && status !== "not_applicable")) return null;
  return { nodeId, status, evidenceRef };
}

function collectEvidenceRefs(task: TaskDetail): string[] {
  return task.events
    .filter((event) => !event.reverted && (event.type === "tool_result" || event.type === "verification_result_recorded"))
    .slice(-12)
    .map((event) => {
      if (event.type === "tool_result") {
        const toolName = String(event.payload["toolName"] ?? "tool");
        const ok = event.payload["ok"] !== false ? "ok" : "failed";
        return `${event.id}:${toolName}:${ok}`;
      }
      const nodeId = String(event.payload["nodeId"] ?? "unknown");
      const status = String(event.payload["status"] ?? "recorded");
      return `${event.id}:verification:${status}:node:${nodeId}`;
    });
}

function isVerificationToolResult(event: TaskEvent, toolName: string): boolean {
  if (toolName !== "run_command") return false;
  const command = String(event.payload["args"] && typeof event.payload["args"] === "object"
    ? (event.payload["args"] as Record<string, unknown>)["command"] ?? ""
    : "");
  const output = String(event.payload["output"] ?? "");
  return /(npm(\.cmd)?\s+(run\s+)?(test|build|typecheck|check|lint)|vitest|jest|tsc|playwright|pytest|cargo\s+test|go\s+test|pnpm\s+(test|build)|yarn\s+(test|build)|(node|deno|bun)\s+[^\n]*(test|spec)\.[cm]?[jt]s|tests?\s+(now\s+)?pass(ed)?)/iu.test(`${command}\n${output}`);
}

function toolClassesForName(toolName: string, description: string): TaskToolClass[] {
  const dynamicRisk = riskFromDescription(description);
  if (dynamicRisk) return [dynamicRisk];
  if (toolName === "run_command") return ["shell", "host_observation"];
  if (toolName === "read_file" || toolName === "search_files" || toolName === "list_files" || toolName === "knowledge_search") return ["workspace_read"];
  if (toolName === "web_search") return ["network"];
  if (toolName === "edit_file" || toolName === "write_file") return ["workspace_write"];
  if (toolName === "plan_update" || toolName === "use_skill") return ["state"];
  if (/(memory|skill_(create|edit|delete))/i.test(toolName)) return ["memory"];
  return [];
}

function riskFromDescription(description: string): RiskCategory | undefined {
  const match = description.match(/Risk:\s*(host_observation|workspace_read|workspace_write|shell|network|destructive)/i);
  return match?.[1] as RiskCategory | undefined;
}

function graphFromPayload(value: unknown): TaskGraph | null {
  if (!isRecord(value)) return null;
  if (typeof value["taskId"] !== "string" || typeof value["activeNodeId"] !== "string") return null;
  if (!Array.isArray(value["nodes"]) || value["nodes"].length === 0) return null;
  const graph = value as unknown as TaskGraph;
  return graph.nodes.some((node) => node.id === graph.activeNodeId) ? graph : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
