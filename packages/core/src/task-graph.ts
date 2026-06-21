import type { RiskCategory, TaskDetail, TaskEvent } from "@agent-workbench/shared";
import { createId, nowIso } from "./ids.js";

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
  if (task.kind === "subagent") return null;
  if (taskGraphFromEvents(task)) return null;
  const goal = latestUserGoal(task);
  if (!goal || isDirectAnswerGoal(goal)) return null;

  const commands = extractVerificationCommands(goal);
  const readOnlyIntent = hasReadOnlyIntent(goal);
  const implementation = !readOnlyIntent && (hasImplementationIntent(goal) || task.runMode === "target");
  const verificationRequired = implementation && (task.runMode === "target" || commands.length > 0 || (hasHighBlastRadius(goal) && !isDocumentationAuthoringGoal(goal)));
  const now = nowIso();
  const nodes: TaskGraphNode[] = [];

  if (!implementation) {
    const node = createNode({
      role: "research",
      objective: goal,
      allowedToolClasses: ["workspace_read", "host_observation", "network", "state"],
      contextHints: ["current_evidence", "read_only_diagnosis", "preserve_scope"],
      acceptanceCriteria: [
        "Answer from current evidence when mutable state matters.",
        "Separate verified facts from residual uncertainty."
      ],
      verification: {
        kind: "read_only",
        method: "Use read-only evidence when the answer depends on current files, runtime state, or external facts.",
        required: false,
        status: "not_applicable",
        evidenceRefs: []
      },
      risk: "workspace_read",
      status: "running"
    });
    return {
      taskId: task.id,
      nodes: [node],
      activeNodeId: node.id,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
  }

  const implementNode = createNode({
    role: "implement",
    objective: goal,
    allowedToolClasses: ["workspace_read", "workspace_write", "host_observation", "shell", "network", "state"],
    contextHints: ["preserve_user_scope", "use_product_boundaries", "avoid_test_specific_hardcoding"],
    acceptanceCriteria: [
      "Preserve the user's real objective instead of narrowing to an easy fixture.",
      "Implement through existing product boundaries and current code patterns.",
      "Avoid hardcoded behavior that only satisfies one prompt, route, fixture, date, or expected string."
    ],
    verification: {
      kind: verificationKindForGoal(goal, commands),
      method: verificationMethodForGoal(goal, commands, verificationRequired),
      required: verificationRequired,
      status: verificationRequired ? "pending" : "not_applicable",
      evidenceRefs: [],
      ...(commands.length > 0 ? { commands } : {})
    },
    risk: "workspace_write",
    status: "running"
  });
  nodes.push(implementNode);

  if (verificationRequired) {
    nodes.push(createNode({
      role: "verify",
      objective: "Prove the implementation satisfies the preserved acceptance criteria.",
      allowedToolClasses: ["workspace_read", "host_observation", "shell", "network", "state"],
      contextHints: ["verification_after_latest_change", "current_fingerprint", "real_product_surface_when_practical"],
      acceptanceCriteria: [
        "Use verification whose scope matches the changed behavior and blast radius.",
        "Treat failures as evidence for repair instead of completing with a progress-only answer."
      ],
      verification: {
        kind: verificationKindForGoal(goal, commands),
        method: verificationMethodForGoal(goal, commands, true),
        required: true,
        status: "pending",
        evidenceRefs: [],
        ...(commands.length > 0 ? { commands } : {})
      },
      risk: "shell",
      status: "pending"
    }));
  }

  return {
    taskId: task.id,
    nodes,
    activeNodeId: implementNode.id,
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
  const active = graph.nodes.find((node) => node.id === graph.activeNodeId);
  const nodeLines = graph.nodes.map((node) => {
    const marker = node.id === graph.activeNodeId ? "active" : node.status;
    return `- ${node.id} [${marker}/${node.role}]: ${truncate(node.objective, 180)}`;
  });
  return [
    "## Task Graph",
    "Use this graph as durable task state. It must not override the latest user request.",
    `Status: ${graph.status}`,
    `Active node: ${graph.activeNodeId}`,
    ...nodeLines,
    active ? "" : "",
    active ? `Active role: ${active.role}` : "",
    active ? `Active allowed tool classes: ${active.allowedToolClasses.join(", ")}` : "",
    active && active.acceptanceCriteria.length > 0 ? `Active acceptance criteria:\n${active.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
    active
      ? [
          "Active verification:",
          `- kind: ${active.verification.kind}`,
          `- required: ${active.verification.required ? "yes" : "no"}`,
          `- status: ${active.verification.status}`,
          `- method: ${active.verification.method}`,
          active.verification.commands?.length ? `- commands: ${active.verification.commands.join(", ")}` : ""
        ].filter(Boolean).join("\n")
      : ""
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
  const requiredCommands = verifyNode.verification.commands ?? [];
  const actualCommand = commandFromToolEvent(event);
  if (requiredCommands.length > 0 && !requiredCommands.some((command) => commandsEquivalent(actualCommand, command))) return null;
  const ok = event.payload["ok"] !== false;
  return {
    nodeId: verifyNode.id,
    status: ok ? "passed" : "failed",
    evidenceRef: event.id,
    toolName,
    summary: `${toolName} ${ok ? "passed" : "failed"}`
  };
}

export function completionBlocker(task: TaskDetail, finalMessage = ""): string | null {
  const claimedToolBlocker = claimedToolEvidenceBlocker(task, finalMessage);
  if (claimedToolBlocker) return claimedToolBlocker;
  const graph = taskGraphFromEvents(task);
  if (!graph) return null;
  const required = graph.nodes.filter((node) => node.verification.required);
  if (required.length === 0) return null;
  const latestFileChangeIndex = findLastFileChangeIndex(task.events);
  const relevantEvents = task.events.slice(latestFileChangeIndex + 1);
  const commands = uniqueStrings(required.flatMap((node) => node.verification.commands ?? []));
  if (commands.length > 0) {
    const missing = commands.filter((command) => !hasSuccessfulCommandEvidence(relevantEvents, command));
    if (missing.length === 0) return null;
    const failed = [...relevantEvents].reverse().find((event) =>
      event.type === "verification_result_recorded" &&
      !event.reverted &&
      event.payload["status"] === "failed"
    );
    if (failed) return "Verification failed; review the recorded evidence before completing the task.";
    return `Verification evidence is required before this task can be marked completed. Remaining required command(s): ${missing.join(" && ")}.`;
  }
  const hasPassed = relevantEvents.some((event) =>
    event.type === "verification_result_recorded" &&
    !event.reverted &&
    event.payload["status"] === "passed"
  );
  if (hasPassed) return null;
  const failed = [...relevantEvents].reverse().find((event) =>
    event.type === "verification_result_recorded" &&
    !event.reverted &&
    event.payload["status"] === "failed"
  );
  if (failed) return "Verification failed; review the recorded evidence before completing the task.";
  return "Verification evidence is required before this task can be marked completed.";
}

function claimedToolEvidenceBlocker(task: TaskDetail, finalMessage: string): string | null {
  if (!finalMessage.trim()) return null;
  const claimed = claimedEvidenceToolNames(finalMessage);
  if (claimed.length === 0) return null;
  const actual = new Set(
    task.events
      .filter((event) => event.type === "tool_result" && !event.reverted)
      .map((event) => String(event.payload["toolName"] ?? "").trim())
      .filter(Boolean)
  );
  for (const toolName of claimed) {
    const aliases = toolEvidenceAliases(toolName);
    if (!aliases.some((alias) => actual.has(alias))) {
      return `The final answer claimed ${toolName} evidence, but no matching tool result exists. Run the tool or answer without claiming tool evidence.`;
    }
  }
  return null;
}

function claimedEvidenceToolNames(message: string): string[] {
  const names = ["knowledge_search", "web_search", "use_skill", "list_files", "search_files", "read_file", "write_file", "edit_file", "run_command"];
  return names.filter((toolName) => claimsToolEvidence(message, toolName));
}

function claimsToolEvidence(message: string, toolName: string): boolean {
  const escaped = escapeRegExp(toolName);
  const mention = new RegExp(`\\b${escaped}\\b`, "iu");
  if (!mention.test(message)) return false;
  const negated = new RegExp(`(?:did\\s+not|didn't|not|no|without|未|没有|無|无需|不需要)\\s*(?:call|use|run|调用|使用|执行)?\\s*\\b${escaped}\\b`, "iu");
  if (negated.test(message)) return false;
  const modalAlternative = new RegExp(`(?:can|could|may|might|would|可以|可|能够|能|如需|如果需要|是否需要)[\\s\\S]{0,24}(?:call|use|run|调用|使用|执行|用)[\\s\\S]{0,40}\\b${escaped}\\b`, "iu");
  if (modalAlternative.test(message)) return false;
  const alternativeCapability = new RegExp(
    `(?:still\\s+can|available|alternative|instead|可以|还可以|仍然可以|能够|能|如果你愿意|需要我|替代|替代方案|可用)[\\s\\S]{0,64}(?:call|use|run|调用|使用|执行|用)?[\\s\\S]{0,24}\\b${escaped}\\b`,
    "iu"
  );
  if (alternativeCapability.test(message)) return false;
  const listedCapability = new RegExp(
    `(?:still\\s+can|available|alternative|instead|options?|可以|还可以|仍然可以|能够|能|如果你愿意|需要我|替代|替代方案|可用|后续|方案|方式)[\\s\\S]{0,180}(?:^|[\\n\\r])\\s*(?:[-*]|\\d+[.)、])?\\s*(?:\\*\\*)?\\b${escaped}\\b(?:\\*\\*)?\\s*[-:：]`,
    "imu"
  );
  if (listedCapability.test(message)) return false;
  const sameClause = "[^\\n。；;.!?]{0,80}";
  const toolBeforeClaim = new RegExp(`\\b${escaped}\\b${sameClause}(?:returned|found|retrieved|loaded|searched|queried|called|返回|找到|检索|查询|搜索|调用|加载|命中|用到)`, "iu");
  const claimBeforeTool = new RegExp(`(?:returned|found|retrieved|loaded|searched|queried|called|返回|找到|检索|查询|搜索|调用|加载|命中|用到)${sameClause}\\b${escaped}\\b`, "iu");
  return toolBeforeClaim.test(message) || claimBeforeTool.test(message);
}

function toolEvidenceAliases(toolName: string): string[] {
  if (toolName === "web_search") return ["web_search", "web_search_result"];
  if (toolName === "use_skill") return ["use_skill", "skill_loaded"];
  return [toolName];
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

function hasSuccessfulCommandEvidence(events: TaskEvent[], expectedCommand: string): boolean {
  return events.some((event) => {
    if (event.reverted || event.type !== "tool_result" || event.payload["ok"] === false) return false;
    if (String(event.payload["toolName"] ?? "") !== "run_command") return false;
    return commandsEquivalent(commandFromToolEvent(event), expectedCommand);
  });
}

function commandFromToolEvent(event: TaskEvent): string {
  const args = event.payload["args"];
  return String(args && typeof args === "object" ? (args as Record<string, unknown>)["command"] ?? "" : "");
}

function findLastFileChangeIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted) continue;
    if (event.type === "task_rollback_completed") return index;
    if (event.type !== "tool_result" || event.payload["ok"] === false) continue;
    const toolName = String(event.payload["toolName"] ?? "");
    if (toolName === "edit_file" || toolName === "write_file") return index;
  }
  return -1;
}

function commandsEquivalent(actualCommand: string, expectedCommand: string): boolean {
  return canonicalizeCommand(actualCommand) === canonicalizeCommand(expectedCommand);
}

function canonicalizeCommand(command: string): string {
  const normalized = command
    .toLowerCase()
    .replace(/\.cmd\b/gu, "")
    .replace(/(?:\s+(?:\d*>\s*&\s*\d+|\d*>>?\s*(?:"[^"]*"|'[^']*'|\S+)|\d*<<?\s*(?:"[^"]*"|'[^']*'|\S+)))+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "";
  const npmRun = normalized.match(/^npm\s+run\s+([a-z0-9:_-]+)$/u);
  if (npmRun) return `npm ${npmRun[1]}`;
  const pnpmRun = normalized.match(/^pnpm\s+run\s+([a-z0-9:_-]+)$/u);
  if (pnpmRun) return `pnpm ${pnpmRun[1]}`;
  const yarnRun = normalized.match(/^yarn\s+run\s+([a-z0-9:_-]+)$/u);
  if (yarnRun) return `yarn ${yarnRun[1]}`;
  return normalized;
}

function createNode(input: Omit<TaskGraphNode, "id" | "evidenceRefs"> & { evidenceRefs?: string[] }): TaskGraphNode {
  return {
    id: createId("node"),
    evidenceRefs: [],
    ...input
  };
}

function latestUserGoal(task: TaskDetail): string {
  return String([...task.events].reverse().find((event) => event.type === "user_message" && !event.reverted)?.summary ?? "").trim();
}

export function isDirectAnswerGoal(goal: string): boolean {
  const normalized = goal.trim().toLowerCase();
  if (!normalized) return true;
  if (/^(hi|hello|hey|thanks?|thank you|你好|您好|谢谢|感谢|早上好|晚上好)[.!！。?\s]*$/iu.test(normalized)) return true;
  if (/^(你是谁|你能做什么|你可以做什么|你可以帮我做什么|what can you do|what could you do|how can you help|who are you|introduce yourself|please introduce yourself)[?？.!！。\s]*$/iu.test(normalized)) return true;
  if (/^(你|您)[\s\S]{0,8}(能|可以)[\s\S]{0,8}(做|帮我)[\s\S]{0,8}什么[?？.!！。\s]*$/iu.test(normalized)) return true;
  if (/^(你|您)[\s\S]{0,12}(能|可以)[\s\S]{0,12}(做|帮我)[\s\S]{0,12}什么[\s\S]{0,120}(请直接回答|不要读取|不要运行|不要检查|不用读取|不用运行|不用检查)/iu.test(normalized)) return true;
  if (/^(what can you do|what could you do|how can you help)[\s\S]{0,120}(answer directly|do not read|do not run|do not inspect|no tools)/iu.test(normalized)) return true;
  if (/^(介绍一下你自己|自我介绍|请介绍一下你自己)[?？.!！。\s]*$/iu.test(normalized)) return true;
  if (/(不要|不用|不需要|请勿).{0,10}(使用|调用)?工具|no tools?|without tools?|do not use tools?|don't use tools?/iu.test(normalized) &&
    /(一句话|只用|只需|只补充|简短|直接回答|answer directly|one sentence|briefly)/iu.test(normalized)) return true;
  return normalized.length <= 18 && !/(继续|处理|修|改|写|查|审|测|验|debug|fix|test|build|review|audit|check|inspect|run|file|api|ui|cli)/iu.test(normalized);
}

function hasImplementationIntent(goal: string): boolean {
  if (/(implement|create|add|update|change|modify|fix|repair|build|write|edit|refactor|optimi[sz]e|实现|新增|添加|修改|修复|修好|修正|纠正|改正|恢复|优化|重构|编写|开发|调整|迁移|接入|清理|删除)/iu.test(goal)) {
    return true;
  }
  if (/(跑不起来|不能运行|无法运行|报错|失败|定位并修|不要只给建议)/iu.test(goal)) return true;
  return /(完善|补齐|打磨)[\s\S]{0,32}(feature|command|workflow|verification|test|code|file|page|component|route|功能|命令|工作流|验证|测试|代码|文件|页面|组件|路由|接口|能力|设施|cli|api|ui|web|agent)/iu.test(goal);
}

function hasReadOnlyIntent(goal: string): boolean {
  return /(read[-\s]?only|no changes?|do not (?:change|modify|edit|write)|diagnose only|analysis only|只读|不要改|不改代码|不用改|别改|仅诊断|只诊断|仅分析|只分析|先看|暂时不用改)/iu.test(goal);
}

function hasHighBlastRadius(goal: string): boolean {
  return /(app|application|project|repo|monorepo|server|api|cli|ui|web|frontend|backend|database|sqlite|auth|permission|security|完整|项目|仓库|服务|接口|前端|后端|数据库|权限|安全|旗舰|生产|全量|端到端|压力|覆盖|门禁|大模型|agent)/iu.test(goal);
}

function isDocumentationAuthoringGoal(goal: string): boolean {
  return /(document|documentation|docs?|readme|guide|manual|runbook|changelog|文档|说明|指南|手册|变更日志)/iu.test(goal)
    && !/(implement|fix|repair|refactor|migrate|debug|test|build|runtime|server|database|auth|permission|实现|修复|重构|迁移|调试|测试|构建|运行时|数据库|权限|认证)/iu.test(goal);
}

function extractVerificationCommands(goal: string): string[] {
  const commands = new Set<string>();
  const patterns = [
    /\b(?:npm(?:\.cmd)?|pnpm|yarn)\s+(?:run\s+)?[a-z0-9:_-]+(?:\s+--\s+[^\n。；;]+)?/giu,
    /\b(?:vitest|jest|pytest|playwright|tsc|cargo\s+test|go\s+test)\b[^\n。；;]*/giu
  ];
  for (const pattern of patterns) {
    for (const match of goal.matchAll(pattern)) {
      const command = match[0]?.trim().replace(/[，,。.;；:：]+$/u, "");
      if (command) commands.add(command);
    }
  }
  return [...commands].slice(0, 6);
}

function verificationKindForGoal(goal: string, commands: string[]): VerificationKind {
  const text = `${goal}\n${commands.join("\n")}`;
  if (/(typecheck|tsc|类型)/iu.test(text)) return "typecheck";
  if (/(build|构建|打包)/iu.test(text)) return "build";
  if (/(test|vitest|jest|pytest|playwright|测试|e2e|端到端)/iu.test(text)) return "tests";
  if (commands.length > 0) return "manual";
  return "tests";
}

function verificationMethodForGoal(goal: string, commands: string[], required: boolean): string {
  if (commands.length > 0) return `Run the user-named verification command(s): ${commands.join(" && ")}.`;
  if (!required) return "Use focused checks when practical and explain any unverified residual risk.";
  if (/(ui|frontend|web|页面|前端|界面|响应式|浏览器)/iu.test(goal)) {
    return "Run focused tests plus rendered UI or browser checks when practical.";
  }
  if (/(cli|api|server|backend|数据库|sqlite|接口|服务)/iu.test(goal)) {
    return "Run focused unit or integration checks through public CLI/API/server boundaries when practical.";
  }
  return "Run focused tests, typecheck, or build checks that cover the changed behavior.";
}

function toolClassesForName(toolName: string, description: string): TaskToolClass[] {
  const dynamicRisk = riskFromDescription(description);
  if (dynamicRisk) return [dynamicRisk];
  if (toolName === "run_command") return ["shell", "host_observation"];
  if (toolName === "read_file" || toolName === "search_files" || toolName === "list_files" || toolName === "knowledge_search") return ["workspace_read"];
  if (toolName === "web_search") return ["network"];
  if (toolName === "edit_file" || toolName === "write_file") return ["workspace_write"];
  if (toolName === "plan_update" || toolName === "use_skill" || toolName === "ask_user" || toolName === "spawn_subagent" || toolName === "attach_task_file") return ["state"];
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
