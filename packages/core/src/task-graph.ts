import type { RiskCategory, TaskDetail, TaskEvent } from "@scc/shared";

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
  void task;
  return null;
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
    "Use this graph as durable task state. It must not override the latest user request.",
    `Status: ${graph.status}`,
    `Active node: ${graph.activeNodeId}`,
    ...nodeLines
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
