import type { ConversationSummary, KnowledgeItem, ModelProviderRecord, SkillRecord, TaskAttachment, TaskDetail, TaskEvent, ToolCall, UserPreferences } from "@agent-workbench/shared";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createId, nowIso } from "./ids.js";
import type { WorkbenchStore } from "./store.js";
import {
  buildTaskGraphSystemLayer,
  taskGraphEvidenceRefs,
  taskGraphFromEvents,
  type AttentionPacket
} from "./task-graph.js";
import { defaultTaskWorkRoot, findWorkspaceRoot } from "./workspace-root.js";

const DEFAULT_MAX_RESERVED_RESPONSE_TOKENS = 16000;
const RESPONSE_TOKEN_RATIO = 0.15;
const FILE_LAYER_BUDGET_RATIO = 0.2;
const MIN_HISTORY_TOKENS = 160;
const MIN_INPUT_TOKENS = 120;
const MAX_SKILL_LOADS = 3;
const SKILL_CONTENT_TRUNCATE = 1200;
const MAX_PROJECT_MEMORIES = 5;
const PROJECT_MEMORY_TRUNCATE = 1000;
const MAX_KNOWLEDGE_BRIEF_SUMMARY = 220;
const MAX_KNOWLEDGE_BRIEF_QUERY_EVENTS = 3;
const MAX_KNOWLEDGE_BRIEF_SCORE_TEXT = 4000;
const MAX_MCP_SERVERS_DISPLAY = 12;
const MAX_INTEGRATIONS_DISPLAY = 12;
const MAX_USER_SUMMARY_TRUNCATE = 2200;
const MAX_PLAN_SUMMARY_TRUNCATE = 1000;
const MAX_FILE_TRACKER_FILES = 8;
const MAX_FILE_CONTENT_LENGTH = 48000;
const SUMMARY_HIGH_PRESSURE_RATIO = 0.9;
const LOW_BUDGET_THRESHOLD = 3000;
const LOW_BUDGET_EVENT_THRESHOLD = 60;
const SUMMARY_FORCE_RECENT = 6;
const SUMMARY_HIGH_PRESSURE_RECENT = 12;
const SUMMARY_NORMAL_RECENT = 18;
const SUMMARY_MIN_EVENTS = 12;
const SUMMARY_FORCE_MIN_EVENTS = 1;
const MAX_RETAINED_FACTS = 24;
const MAX_RECENT_USER_MESSAGES = 2;
const MAX_RECENT_USER_TRUNCATE = 4000;
const COMPACT_HISTORY_LIMIT = 24;
const COMPACT_LINE_TRUNCATE = 700;
const MAX_LARGE_STRING_NORMAL = 180;
const MAX_LARGE_STRING_HEAD = 140;
const MAX_LARGE_STRING_TAIL = 40;
const MAX_JSON_VALUE = 220;
const MAX_TOOL_OUTPUT = 4000;
const MAX_TOOL_OUTPUT_HEAD = 2000;
const MAX_TOOL_OUTPUT_TAIL = 2000;
const MAX_READ_FILE_CONTENT = 64000;
const MAX_READ_FILE_HEAD = 16000;
const MAX_READ_FILE_TAIL = 6000;
const MAX_READ_FILE_FULL_LINES = 900;
const MAX_READ_FILE_ROLE_INLINE_CONTENT = 2000;
const TRACKED_FILE_HEAD_LINES = 140;
const TRACKED_FILE_TAIL_LINES = 80;
const MAX_ATTACHMENT_PREVIEW = 1200;
const PROTECTED_BUDGET_RATIO = 0.5;
const MIN_PROTECTED_BUDGET = 96;
const MIN_PROTECTED_BLOCK_BUDGET = 24;
const CONTENT_HEAD_RATIO = 0.25;
const MIN_CONTENT_HEAD = 10;
const MIN_CONTENT_TAIL = 10;
const WORD_BREAK_BUFFER = 96;
const EXTRA_TOKEN_BUFFER = 8;

const MEMORY_LIMITS_COMPACT = { user: 3000, global: 5000, project: 5000 };
const MEMORY_LIMITS_NORMAL = { user: 6000, global: 12000, project: 12000 };

const AGENT_WORKFLOW_HEURISTICS = [
  "## Agent Workflow Heuristics",
  "Use these as decision heuristics, not a hard checklist. Preserve autonomy while making important work traceable, verifiable, and aligned.",
  "- Do not force tools, plans, tests, screenshots, live flows, or long reports for trivial chat, low-risk answers, or narrow user requests.",
  "- For non-trivial work, preserve acceptance criteria, inspect current mutable evidence when cheap, and choose the lightest responsible workflow.",
  "- Prefer real product surfaces when practical; avoid hidden fixture state when a real flow is available.",
  "- Escalate verification with risk and blast radius. A green command is evidence only when it covers the criteria.",
  "- Never hardcode behavior to satisfy a particular test prompt, fixture, route, date, or expected string. Implement the general business rule.",
  "- If ideal verification is unavailable or disproportionate, use the strongest practical proof and state residual risk.",
  "- For UI/CLI/API, verify rendered state, human output, and --json/raw structured output through real paths when practical.",
  "- Complete when current evidence supports the preserved acceptance criteria at a level proportional to risk; continue gathering evidence when proof is too weak."
].join("\n");

export interface TokenBudget {
  maxTotal: number;
  reservedForResponse: number;
}

export interface AssembledContext {
  systemPrompt: string;
  input: string;
  messages: CanonicalModelMessage[];
  attentionPacket: Omit<AttentionPacket, "messages"> & { messages: CanonicalModelMessage[] };
  usedTokens: number;
}

export type CanonicalModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; eventId?: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[]; reasoningContent?: string; eventId?: string }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; reasoningContent?: string; eventId?: string };

export interface LoadedSkillSession {
  loadedSkills: Set<string>;
  unavailableSkills: Map<string, string>;
  loadedSkillBodies: SkillRecord[];
  pendingLoadedSkills: SkillRecord[];
  pendingSkippedSkills: Array<{ requested: string; reason: string; skill?: SkillRecord | undefined }>;
  loadCount: number;
}

export class ContextAssembler {
  private readonly trackers = new Map<string, FileStateTracker>();
  private readonly skillSessions = new Map<string, LoadedSkillSession>();
  private readonly pendingSummaries = new Map<string, ConversationSummary[]>();

  constructor(private readonly store: WorkbenchStore) {}

  async assemble(task: TaskDetail, budget?: Partial<TokenBudget>): Promise<AssembledContext> {
    const preferences = await this.store.getPreferences();
    const maxTotal = budget?.maxTotal ?? preferences.maxTokensPerRequest;
    const reservedForResponse = budget?.reservedForResponse ?? Math.min(16000, Math.round(maxTotal * 0.15));
    const tokenBudget = { maxTotal, reservedForResponse };
    const systemLayers: string[] = [];
    const inputLayers: string[] = [];
    let usedTokens = 0;

    const systemLayer = this.buildSystemLayer(preferences);
    systemLayers.push(systemLayer);
    usedTokens += estimateTokens(systemLayer);

    systemLayers.push(AGENT_WORKFLOW_HEURISTICS);
    usedTokens += estimateTokens(AGENT_WORKFLOW_HEURISTICS);

    const memoryFileLayer = await this.buildMemoryFileLayer(task, { compact: false });
    if (memoryFileLayer) {
      systemLayers.push(memoryFileLayer);
      usedTokens += estimateTokens(memoryFileLayer);
    }

    const runtimeLayer = await this.buildRuntimeMetadataLayer(preferences);
    if (runtimeLayer) {
      systemLayers.push(runtimeLayer);
      usedTokens += estimateTokens(runtimeLayer);
    }

    const workingFolderLayer = this.buildWorkingFolderLayer(task);
    systemLayers.push(workingFolderLayer);
    usedTokens += estimateTokens(workingFolderLayer);

    const currentTurnLayer = this.buildCurrentTurnLayer(task);
    if (currentTurnLayer) {
      inputLayers.push(currentTurnLayer);
      usedTokens += estimateTokens(currentTurnLayer);
    }

    const skillLayer = await this.buildSkillMetaLayer(preferences);
    if (skillLayer) {
      systemLayers.push(skillLayer);
      usedTokens += estimateTokens(skillLayer);
    }

    const projectLayer = await this.buildProjectLayer(task);
    if (projectLayer) {
      systemLayers.push(projectLayer);
      usedTokens += estimateTokens(projectLayer);
    }

    const knowledgeBriefLayer = await this.buildKnowledgeBriefLayer(task, preferences);
    if (knowledgeBriefLayer) {
      systemLayers.push(knowledgeBriefLayer);
      usedTokens += estimateTokens(knowledgeBriefLayer);
    }

    const loadedSkills = this.loadedSkillPrompt(task.id);
    if (loadedSkills) {
      systemLayers.push(loadedSkills);
      usedTokens += estimateTokens(loadedSkills);
    }

    const targetModeLayer = this.buildTargetModeLayer(task);
    if (targetModeLayer) {
      systemLayers.push(targetModeLayer);
      usedTokens += estimateTokens(targetModeLayer);
    }

    const taskGraph = taskGraphFromEvents(task);
    const taskGraphLayer = buildTaskGraphSystemLayer(taskGraph);
    if (taskGraphLayer) {
      systemLayers.push(taskGraphLayer);
      usedTokens += estimateTokens(taskGraphLayer);
    }

    const continuityLayer = this.buildTaskContinuityLayer(task);
    systemLayers.push(continuityLayer);
    usedTokens += estimateTokens(continuityLayer);

    const attachmentLayer = await this.buildAttachmentLayer(task.id);
    if (attachmentLayer) {
      systemLayers.push(attachmentLayer);
      usedTokens += estimateTokens(attachmentLayer);
    }

    const tracker = this.getFileStateTracker(task.id);
    const fileLayer = tracker.buildFileStateTable();
    const fileTokens = estimateTokens(fileLayer);
    let fileLayerIncluded = false;
    if (fileLayer && usedTokens + fileTokens < tokenBudget.maxTotal * 0.2) {
      usedTokens += fileTokens;
      fileLayerIncluded = true;
    }

    const latestContextControlEvent = [...task.events]
      .reverse()
      .find((event) => event.type === "context_overflow_recovered" || event.type === "conversation_summary_created");
    const forceSummary = latestContextControlEvent?.type === "context_overflow_recovered";
    const summary = await this.ensureConversationSummary(task, {
      force: forceSummary,
      tokenBudget,
      usedBefore: usedTokens
    });
    if (summary) {
      const summaryLayer = `## Conversation Summary\n${summary.summary}`;
      systemLayers.push(summaryLayer);
      usedTokens += estimateTokens(summaryLayer);
    }
    if (fileLayerIncluded) systemLayers.push(fileLayer);

    const remaining = tokenBudget.maxTotal - usedTokens - tokenBudget.reservedForResponse;
    const historyLayer = buildHistoryLayer(task, Math.max(160, remaining), fileLayerIncluded ? tracker : undefined, summary?.rangeEndEventId);
    if (historyLayer) inputLayers.push(historyLayer);

    const systemPrompt = systemLayers.filter((layer) => layer.trim().length > 0).join("\n\n");
    const rawInput = inputLayers.filter((layer) => layer.trim().length > 0).join("\n\n");
    const inputBudget = Math.max(120, tokenBudget.maxTotal - tokenBudget.reservedForResponse - estimateTokens(systemPrompt));
    const protectedLayers = [
      currentTurnLayer,
      buildRecentUserContextLayer(task, summary?.rangeEndEventId),
    ].filter(Boolean);
    const input = trimMiddleToTokenBudget(rawInput, inputBudget, protectedLayers);
    const messages = buildCanonicalModelMessages(task, systemPrompt, {
      afterEventId: summary?.rangeEndEventId,
      maxTokens: inputBudget,
      tracker: fileLayerIncluded ? tracker : undefined
    });
    const activeNode = taskGraph?.nodes.find((node) => node.id === taskGraph.activeNodeId);
    const messageTokens = estimateCanonicalMessages(messages);
    return {
      systemPrompt,
      input,
      messages,
      attentionPacket: {
        system: systemPrompt,
        messages,
        ...(activeNode ? { activeNode } : {}),
        evidenceRefs: taskGraphEvidenceRefs(task),
        tokenBudget: {
          maxTotal: tokenBudget.maxTotal,
          reservedForResponse: tokenBudget.reservedForResponse,
          usedTokens: messageTokens
        }
      },
      usedTokens: messageTokens
    };
  }

  getFileStateTracker(taskId: string): FileStateTracker {
    const existing = this.trackers.get(taskId);
    if (existing) return existing;
    const created = new FileStateTracker();
    this.trackers.set(taskId, created);
    return created;
  }

  cleanupTask(taskId: string): void {
    this.trackers.delete(taskId);
    this.skillSessions.delete(taskId);
    this.pendingSummaries.delete(taskId);
  }

  async loadSkill(taskId: string, skillId: string): Promise<SkillRecord | undefined> {
    const session = this.sessionFor(taskId);
    if (session.loadedSkills.has(skillId)) {
      this.recordSkippedSkill(session, skillId, "This skill was already loaded earlier in the current task.");
      return undefined;
    }
    if (session.loadCount >= 3) {
      this.recordSkippedSkill(session, skillId, "Skill load limit reached for this task. Use direct tools or current evidence instead.");
      return undefined;
    }
    const skill = await this.resolveSkillReference(skillId);
    if (!skill || skill.status !== "active") {
      const reason = !skill
        ? "No active skill matched the requested ID or title."
        : `The matched skill is ${skill.status} and cannot be loaded into a task automatically.`;
      this.recordSkippedSkill(session, skillId, reason, skill);
      session.loadCount += 1;
      return undefined;
    }
    session.loadedSkills.add(skill.id);
    session.loadedSkillBodies.push(skill);
    session.pendingLoadedSkills.push(skill);
    session.loadCount += 1;
    return skill;
  }

  getLoadedSkillIds(taskId: string): string[] {
    const session = this.skillSessions.get(taskId);
    return session ? [...session.loadedSkills] : [];
  }

  drainLoadedSkillEvents(taskId: string): SkillRecord[] {
    const session = this.skillSessions.get(taskId);
    if (!session) return [];
    const pending = [...session.pendingLoadedSkills];
    session.pendingLoadedSkills = [];
    return pending;
  }

  drainSkippedSkillEvents(taskId: string): Array<{ requested: string; reason: string; skill?: SkillRecord | undefined }> {
    const session = this.skillSessions.get(taskId);
    if (!session) return [];
    const pending = [...session.pendingSkippedSkills];
    session.pendingSkippedSkills = [];
    return pending;
  }

  drainConversationSummaryEvents(taskId: string): ConversationSummary[] {
    const summaries = this.pendingSummaries.get(taskId) ?? [];
    this.pendingSummaries.delete(taskId);
    return summaries;
  }

  loadedSkillPrompt(taskId: string): string {
    const session = this.skillSessions.get(taskId);
    if (!session || (session.loadedSkillBodies.length === 0 && session.unavailableSkills.size === 0)) return "";
    const loaded = session.loadedSkillBodies.length > 0 ? [
      "## Loaded Skills",
      ...session.loadedSkillBodies.map((skill) =>
        [`### ${skill.title}`, `Skill ID: ${skill.id}`, skill.body.slice(0, 1200)].join("\n")
      )
    ].join("\n\n") : "";
    const unavailable =
      session.unavailableSkills.size > 0
        ? [
            "## Unavailable Skills",
            "Do not call use_skill for these IDs again in this task; choose direct tools or answer from evidence instead.",
            ...[...session.unavailableSkills.entries()].map(([skillId, reason]) => `- ${skillId}: ${reason}`)
          ].join("\n")
        : "";
    return [loaded, unavailable].filter(Boolean).join("\n\n");
  }

  private async buildSkillMetaLayer(preferences: UserPreferences): Promise<string> {
    if (!preferences.skillAutoInject) return "";
    const catalog = (await this.store.listSkills()).sort(compareSkillCatalogEntries);
    const activeSkills = catalog
      .filter((skill) => skill.status === "active")
      .slice(0, preferences.maxInjectedSkills);
    const candidateSkills = catalog
      .filter((skill) => skill.status === "candidate")
      .slice(0, Math.max(2, Math.min(8, preferences.maxInjectedSkills)));
    if (activeSkills.length === 0 && candidateSkills.length === 0) return "";
    const activeLayer = activeSkills.length > 0
      ? activeSkills.map((skill) => {
          const success = Math.round(skill.stats.successRate * 100);
          return [
            `- ${skill.id}: ${skill.title} (${skill.status}, ${success}% success)`,
            `  applicability: ${skill.applicability.description}`,
            skill.applicability.requiredTools.length > 0 ? `  tools: ${skill.applicability.requiredTools.join(", ")}` : ""
          ].filter(Boolean).join("\n");
        })
      : ["- No active skills are currently available for use_skill."];
    const candidateLayer = candidateSkills.length > 0
      ? [
          "",
          "Candidate skills below are shown for awareness only. Do not call use_skill for them until the user or Curator activates them.",
          ...candidateSkills.map((skill) => [
            `- ${skill.title} (${skill.status})`,
            `  applicability: ${skill.applicability.description}`,
            skill.applicability.requiredTools.length > 0 ? `  tools: ${skill.applicability.requiredTools.join(", ")}` : ""
          ].filter(Boolean).join("\n"))
        ]
      : [];
    return [
      "## Available Skills",
      "This is a bounded catalog of active skills. It is not selected from the latest user text. Call use_skill with name set to the skill ID or exact title only when you decide the full guidance is needed.",
      ...activeLayer,
      ...candidateLayer
    ].join("\n");
  }

  private buildSystemLayer(preferences: UserPreferences): string {
    const lines = [
      "You are the Agent Workbench agent.",
      `User preferred agent role: ${preferences.agentRole || "Pragmatic engineering assistant"}.`,
      `User preferred tone: ${preferences.agentTone || "balanced"}.`,
      `User preferred response detail: ${preferences.responseDetail || "normal"}.`,
      "Choose the next action yourself based on the user's goal, available tools, durable memory, skills, and evidence.",
      "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
      "When a tool needs user approval, the application will ask the user; do not assume the current authorization state.",
      "Scripts, builds, tests, and command output are tool evidence for you to interpret; they are never task-completion judges.",
      "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless the user explicitly asks.",
      "USER.md and MEMORY.md content below is already injected from Agent Workbench's internal memory store. Do not try to read USER.md or MEMORY.md from the workRoot; use the memory tools only when the user wants durable memory changed.",
      "Use USER.md and MEMORY.md tools only for durable memories the user wants kept; do not store transient task outputs, secrets, or speculative guesses.",
      "Use skill_create or skill_delete only when the user explicitly asks or when a reviewed reusable pattern is ready; normal task completion should create memory, not a skill.",
      "When using side-effect-free state tools such as plan_update or use_skill, do not narrate the tool mechanics, tool JSON, or success status to the user; continue with the actual task.",
      "Role-ordered assistant/tool history is Agent Workbench's own execution record. Treat prior tool results as the agent's evidence, not as user-provided examples.",
      "Internal continuity notes and retained thinking are private execution context. Never quote them verbatim, and never answer with a note that says you will continue instead of actually taking the next required action.",
      "When current tool evidence is enough to answer or explain the user's request, return the final answer directly; do not call ask_user to ask how to interpret, phrase, or confirm that evidence.",
      "For greetings, thanks, simple chat, and capability questions, answer directly without calling tools or loading more context.",
      "When asked to test or list tools, treat it as a safe capability check; do not create files, edit memory, edit skills, or run persistent side-effect tools unless the user explicitly authorizes that scope.",
      "When the user asks what you can do, answer directly from your general capabilities; do not inspect files first.",
      "Do not claim the project name, stack, files, or runtime state until you have verified them with tool evidence.",
      "If you need a file but are unsure it exists, list or search first instead of guessing paths such as README.md.",
      "When the user gives exact allowed tools, paths, commands, or counts, obey that scope literally; do not call tools with blank arguments, extra paths, or exploratory follow-up calls after the requested evidence is collected.",
      "Tool distinction: search_files searches the live workspace and returns path/line snippets only; read_file returns live file content; knowledge_search searches the saved Knowledge library and is not proof of current files.",
      "Do not use run_command for workspace file-body reads or code search when list_files, search_files, or read_file can answer the question more directly and with less context cost.",
      "When you quote or report source code, command output, JSON values, hashes, paths, or return expressions from tool evidence, copy the observed text exactly; do not rewrite it into an equivalent expression.",
      "When reporting a debug fix, base the root cause and final summary only on observed tool output and source code; do not speculate about code you did not see.",
      "After debugging or editing code, the final answer should include the observed failure, exact root cause expression or file location when known, changed files, and verification result.",
      "Keep normal answers concise, calm, and product-like.",
      "Match the user's tone and the task context; keep serious debugging and incident-style work plain unless the user asks for a warmer style.",
      "Avoid hype, decorative openings, and marketing-style introductions unless the user asks for that tone.",
      "Use Markdown for readable structure when helpful: short headings, bullets, tables, and code blocks are supported."
    ];
    if (preferences.language === "zh-CN") lines.push("Respond in Chinese unless the user asks otherwise.");
    if (preferences.responseDetail === "brief") lines.push("Prefer concise answers unless the task requires detail.");
    if (preferences.responseDetail === "detailed") lines.push("Provide enough detail for a careful user to audit the reasoning and result.");
    lines.push(`User language preference: ${preferences.language}`);
    return lines.join("\n");
  }

  private buildTargetModeLayer(task: TaskDetail): string {
    if (task.runMode !== "target") return "";
    const limits = task.targetLimits;
    const verificationCommands = extractExplicitVerificationCommands(task);
    const verificationStatus = describeTargetVerificationStatus(task, verificationCommands);
    return [
      "## Goal Mode",
      "The user explicitly started /goal. Work aggressively toward complete verified goal satisfaction, not a merely plausible answer.",
      "First establish visible acceptance criteria if they are not already clear. Keep the plan current with plan_update so the UI shows the active step, evidence gathered, implementation work, and verification status.",
      "Continue with evidence-driven exploration, implementation, and verification until the criteria are met or the system pauses on limits, permissions, provider failure, no-progress recovery, or user interruption.",
      "If verification fails, treat the failure as evidence for the next repair step. Do not complete with a promise to continue, a retained-thinking note, or a progress-only summary.",
      "If blocked by permissions or ambiguity, ask the user with ask_user and make the blocker explicit.",
      "Do not call ask_user merely to offer optional follow-up work, ask whether to continue, or confirm completion after successful evidence; return a final answer instead.",
      verificationCommands.length > 0
        ? `Explicit user-named verification commands: ${verificationCommands.map((command) => `\`${command}\``).join(", ")}.`
        : "",
      verificationCommands.length > 0
        ? "If you edit or roll back files, rerun every listed verification command successfully after the latest recorded file change before completing. Do not substitute a narrower check unless the user explicitly allows it."
        : "",
      verificationStatus,
      limits ? `Run limits: ${limits.maxModelTurns} model turns, ${limits.maxToolCalls} tool results, ${Math.round(limits.maxWallTimeMs / 60000)} minutes.` : ""
    ].filter(Boolean).join("\n");
  }

  private async buildMemoryFileLayer(task: TaskDetail, options: { compact?: boolean } = {}): Promise<string> {
    const baseDir = memoryBaseDir();
    const limits = options.compact
      ? { user: 3000, global: 5000, project: 5000 }
      : { user: 6000, global: 12000, project: 12000 };
    const user = await readMemoryFile(resolve(baseDir, "USER.md"), limits.user, defaultUserMemoryContent());
    const globalMemory = await readMemoryFile(resolve(baseDir, "MEMORY.md"), limits.global, defaultGlobalMemoryContent());
    const project = await readMemoryFile(
      resolve(baseDir, "projects", memoryPathHash(task.workRoot || defaultTaskWorkRoot()), "MEMORY.md"),
      limits.project,
      defaultProjectMemoryContent(task.workRoot || defaultTaskWorkRoot())
    );
    return [
      "## Stable Memory Files",
      "These are durable, user-managed memory notes from Agent Workbench's internal memory store. Treat them as preferences and project context, not proof of current file contents. Do not read USER.md or MEMORY.md from the workRoot; the content below is the authoritative injected memory snapshot.",
      `### Global USER.md\n${user}`,
      `### Global MEMORY.md\n${globalMemory}`,
      `### Project MEMORY.md\n${project}`
    ].filter(Boolean).join("\n\n");
  }

  private async buildRuntimeMetadataLayer(preferences: UserPreferences): Promise<string> {
    const providers = await this.store.listModelProviders();
    const active = findActiveModelProvider(providers, preferences.activeModelProviderId);
    const mcpServers = await this.store.listMcpServers();
    const integrations = await this.store.listIntegrationProviders();
    const webSearchProviders = await this.store.listWebSearchProviders();
    const lines = ["## Runtime Metadata"];
    lines.push(
      active
        ? `Active model: ${active.label} / ${active.defaultModelId} (${active.vendor}, ${active.protocol}, context ${formatContextWindow(active)})`
        : `Active model: ${preferences.llmProvider || "not configured"} / ${preferences.defaultModel || "not configured"}`
    );
    const fallbackProviderIds = preferences.modelRoute?.fallbackProviderIds ?? [];
    if (fallbackProviderIds.length > 0) {
      lines.push(`Model fallbacks configured: ${fallbackProviderIds.join(", ")}`);
    }
    lines.push(
      webSearchProviders.some((provider) => provider.enabled)
        ? `Web search providers: ${webSearchProviders.filter((provider) => provider.enabled).map((provider) => `${provider.label} (${provider.kind})`).join(", ")}`
        : "Web search: built-in DuckDuckGo fallback is available; configured providers can improve quality."
    );
    if (mcpServers.length > 0) {
      lines.push("MCP servers:");
      for (const server of mcpServers.slice(0, 12)) lines.push(`- ${server.id}: ${server.label} (${server.transport}, ${server.enabled ? "enabled" : "disabled"})`);
    }
    if (integrations.length > 0) {
      lines.push("External integrations:");
      for (const integration of integrations.slice(0, 12)) lines.push(`- ${integration.id}: ${integration.label} (${integration.kind}, ${integration.status})`);
    }
    return lines.join("\n");
  }

  private async resolveSkillReference(reference: string): Promise<SkillRecord | undefined> {
    const value = reference.trim();
    if (!value) return undefined;
    const byId = await this.store.getSkill(value);
    if (byId) return byId;
    const lowered = value.toLowerCase();
    const skills = await this.store.listSkills();
    return (
      skills.find((skill) => skill.title.trim().toLowerCase() === lowered) ??
      skills.find((skill) => skill.title.trim().toLowerCase().includes(lowered))
    );
  }

  private buildWorkingFolderLayer(task: TaskDetail): string {
    return [
      "## Current Working Folder",
      `Tool root: ${task.workRoot || "(default workbench root)"}`,
      `Task folder ID: ${task.folderId || "default"}`,
      "Relative file paths and command cwd values are resolved inside this root. Do not assume files outside it are visible."
    ].join("\n");
  }

  private buildCurrentTurnLayer(task: TaskDetail): string {
    const latestUser = latestUserEvent(task);
    if (!latestUser) return "";
    return [
      "## Current Turn",
      `Latest user request: ${truncate(latestUser.summary, 2200)}`,
      "Treat this as the active objective. Earlier messages are background unless this request explicitly depends on them."
    ].filter(Boolean).join("\n");
  }

  private buildTaskContinuityLayer(task: TaskDetail): string {
    const latestPlan = [...task.events].reverse().find((event) => event.type.startsWith("plan_") && !event.reverted);
    return [
      "## Active Task Continuity",
      `Task ID: ${task.id}`,
      `Task status: ${task.status}`,
      latestPlan ? `Latest visible plan state: ${truncate(latestPlan.summary, 1000)}` : "",
      "Use the role-ordered conversation below for the active objective. The latest user request is authoritative."
    ].filter(Boolean).join("\n");
  }

  private async buildProjectLayer(task: TaskDetail): Promise<string> {
    const memories = await this.store.listProjectMemories(task.folderId || "default");
    if (memories.length === 0) return "";
    return [
      "## Project Context",
      ...memories.slice(0, 5).map((memory) => `### ${memory.title} [${memory.category}]\n${memory.content.slice(0, 1000)}`)
    ].join("\n\n");
  }

  private async buildKnowledgeBriefLayer(task: TaskDetail, preferences: UserPreferences): Promise<string> {
    if (!preferences.knowledgeActiveInjection || preferences.maxInjectedKnowledgeItems <= 0) return "";
    const projectId = task.folderId || "default";
    const projectItems = await this.store.listKnowledgeItems(projectId);
    const fallbackItems = projectId === "default" ? [] : await this.store.listKnowledgeItems("default");
    const byId = new Map<string, KnowledgeItem>();
    for (const item of [...projectItems, ...fallbackItems]) byId.set(item.id, item);
    const items = rankKnowledgeBriefItems([...byId.values()], task);
    if (items.length === 0) return "";
    const selected = items.slice(0, preferences.maxInjectedKnowledgeItems);
    return [
      "## Knowledge Brief",
      `Library knowledge available for this project scope: ${items.length} item(s).`,
      "These are compact candidate background pointers, not the current user request and not proof of live file state. Relevant pointers are shown first when current-task signals are available; otherwise catalog status/order is preserved. Use knowledge_search when full evidence or exact wording is needed.",
      ...selected.map(formatKnowledgeBriefItem)
    ].join("\n");
  }

  private async buildAttachmentLayer(taskId: string): Promise<string> {
    const attachments = await this.store.listTaskAttachments(taskId);
    if (attachments.length === 0) return "";
    return [
      "## Task Attachments",
      "Use attachment references as evidence. Large or binary files may require explicit read/analysis tools before claiming details.",
      ...attachments.map(formatAttachmentForContext)
    ].join("\n");
  }

  private async ensureConversationSummary(
    task: TaskDetail,
    options: { force?: boolean; tokenBudget?: TokenBudget; usedBefore?: number } = {}
  ): Promise<ConversationSummary | undefined> {
    const existing = await this.store.listConversationSummaries(task.id);
    const latest = existing.at(-1);
    const visibleEvents = task.events.filter(isSummarizableContextEvent);
    const maxPromptInput = options.tokenBudget
      ? Math.max(1, options.tokenBudget.maxTotal - options.tokenBudget.reservedForResponse)
      : Number.POSITIVE_INFINITY;
    const historyPressure = estimateEventsForSummary(visibleEvents) + (options.usedBefore ?? 0);
    const highPressure = historyPressure > maxPromptInput * 0.9;
    const lowBudgetPressure = Boolean(options.tokenBudget && options.tokenBudget.maxTotal <= 3000 && visibleEvents.length >= 60);
    if (!options.force && !highPressure && !lowBudgetPressure) return latest;
    const latestCoveredIndex = latest ? visibleEvents.findIndex((event) => event.id === latest.rangeEndEventId) : -1;
    if (!options.force && latest && !highPressure && !lowBudgetPressure && visibleEvents.length - latestCoveredIndex < 60) return latest;
    const startIndex = latestCoveredIndex >= 0 ? latestCoveredIndex + 1 : 0;
    const keepRecent = options.force ? 6 : highPressure || lowBudgetPressure ? 12 : 18;
    const endIndex = Math.max(startIndex, visibleEvents.length - keepRecent);
    const slice = visibleEvents.slice(startIndex, endIndex);
    if (slice.length < (options.force || highPressure || lowBudgetPressure ? 1 : 12)) return latest;
    const now = nowIso();
    const retainedFacts = mergeRetainedFacts([
      ...existing.flatMap((summary) => summary.retainedFacts ?? []),
      ...buildRetainedFacts(task, slice)
    ]);
    const summaryText = buildRollingConversationSummary(task, slice, retainedFacts);
    const summary: ConversationSummary = {
      id: createId("summary"),
      taskId: task.id,
      rangeStartEventId: slice[0]!.id,
      rangeEndEventId: slice.at(-1)!.id,
      summary: summaryText,
      tokenEstimate: estimateTokens(summaryText),
      reason: options.force ? "context_overflow_retry" : highPressure || lowBudgetPressure ? "token_pressure" : "event_window",
      retainedFacts,
      droppedRanges: [{ startEventId: slice[0]!.id, endEventId: slice.at(-1)!.id, eventCount: slice.length }],
      ...(options.tokenBudget
        ? {
            tokenBudget: {
              maxTotal: options.tokenBudget.maxTotal,
              reservedForResponse: options.tokenBudget.reservedForResponse,
              ...(options.usedBefore !== undefined ? { usedBefore: options.usedBefore } : {}),
              usedAfter: estimateTokens(summaryText)
            }
          }
        : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.store.saveConversationSummary(summary);
    this.pendingSummaries.set(task.id, [...(this.pendingSummaries.get(task.id) ?? []), summary]);
    return summary;
  }

  private sessionFor(taskId: string): LoadedSkillSession {
    const existing = this.skillSessions.get(taskId);
    if (existing) return existing;
    const created: LoadedSkillSession = {
      loadedSkills: new Set<string>(),
      unavailableSkills: new Map<string, string>(),
      loadedSkillBodies: [],
      pendingLoadedSkills: [],
      pendingSkippedSkills: [],
      loadCount: 0
    };
    this.skillSessions.set(taskId, created);
    return created;
  }

  private recordSkippedSkill(
    session: LoadedSkillSession,
    requested: string,
    reason: string,
    skill?: SkillRecord | undefined
  ): void {
    if (requested) session.unavailableSkills.set(requested, reason);
    session.pendingSkippedSkills.push({ requested, reason, ...(skill ? { skill } : {}) });
  }
}

export interface FileState {
  path: string;
  content: string;
  contentHash: string;
  lastModified: string;
  isPartial: boolean;
  totalChars?: number;
  totalLines?: number;
  mode?: string;
}

export class FileStateTracker {
  private states = new Map<string, FileState>();
  private readonly maxFiles = MAX_FILE_TRACKER_FILES;
  private readonly maxContentLength = MAX_FILE_CONTENT_LENGTH;

  updateFromToolResult(event: TaskEvent): void {
    if (event.type !== "tool_result") return;
    if (event.payload["ok"] === false) return;
    const output = String(event.payload["output"] ?? "");
    if (!output || looksLikeBinary(output)) return;

    const toolName = this.findToolName(event);
    if (toolName === "read_file") {
      const parsed = parseJson(output);
      const path = String(parsed["path"] ?? "");
      const content = String(parsed["content"] ?? "");
      if (path && content) {
        const totalLines = typeof parsed["totalLines"] === "number" ? parsed["totalLines"] : undefined;
        const mode = typeof parsed["mode"] === "string" ? parsed["mode"] : undefined;
        const normalized = normalizeTrackedReadFileContent(content, {
          partial: Boolean(parsed["partial"]),
          ...(totalLines !== undefined ? { totalLines } : {}),
          ...(mode ? { mode } : {})
        });
        const metadata: Partial<Pick<FileState, "totalChars" | "totalLines" | "mode">> = { totalChars: content.length };
        if (totalLines !== undefined) metadata.totalLines = totalLines;
        if (mode) metadata.mode = mode;
        this.set(path, normalized.content, event.createdAt, normalized.isPartial, {
          ...metadata
        });
      }
      return;
    }

    if (toolName === "edit_file" || toolName === "write_file") {
      const parsed = parseJson(output);
      const path = String(parsed["path"] ?? "");
      if (path) this.set(path, "File changed; read_file for current content before further edits.", event.createdAt, true);
      return;
    }

  }

  hasFile(path: string): boolean {
    return this.states.has(path);
  }

  buildFileStateTable(): string {
    if (this.states.size === 0) return "";
    const lines = ["## Known Files (current read_file evidence; overrides earlier summaries)"];
    for (const state of this.states.values()) {
      lines.push(`\n### ${state.path}`);
      const metadata = [
        state.isPartial ? "context excerpt" : "complete content",
        state.totalLines !== undefined ? `${state.totalLines} lines` : "",
        state.totalChars !== undefined ? `${state.totalChars} chars` : "",
        state.mode ? `read_file mode=${state.mode}` : ""
      ].filter(Boolean).join(", ");
      if (metadata) lines.push(`(${metadata})`);
      if (state.isPartial) lines.push("If exact omitted lines are needed, call search_files for line hits or read_file with offset/limit for the target range.");
      lines.push("```");
      lines.push(state.content);
      lines.push("```");
    }
    return lines.join("\n");
  }

  markFilesStale(paths: string[], reason: string, timestamp: string): void {
    for (const path of paths) {
      if (!path) continue;
      this.set(path, reason, timestamp, true, { mode: "stale" });
    }
  }

  private set(path: string, content: string, lastModified: string, isPartial: boolean, metadata: Partial<Pick<FileState, "totalChars" | "totalLines" | "mode">> = {}): void {
    this.states.set(path, {
      path,
      content: content.slice(0, this.maxContentLength),
      contentHash: hash(content),
      lastModified,
      isPartial: isPartial || content.length > this.maxContentLength,
      ...metadata
    });
    this.prune();
  }

  private prune(): void {
    if (this.states.size <= this.maxFiles) return;
    this.states = new Map(
      [...this.states.entries()]
        .sort((a, b) => new Date(b[1].lastModified).getTime() - new Date(a[1].lastModified).getTime())
        .slice(0, this.maxFiles)
    );
  }

  private findToolName(event: TaskEvent): string {
    return String(event.payload["toolName"] ?? "");
  }
}

export function buildHistoryLayer(task: TaskDetail, maxTokens: number, tracker?: FileStateTracker, afterEventId?: string): string {
  if (maxTokens <= 0) return "";
  const events = task.events.filter(isModelHistoryEvent);
  const startIndex = afterEventId ? events.findIndex((event) => event.id === afterEventId) + 1 : 0;
  const visibleEvents = startIndex > 0 ? events.slice(startIndex) : events;
  const formatted: string[] = [];
  let usedTokens = 0;
  for (let index = visibleEvents.length - 1; index >= 0; index--) {
    const event = visibleEvents[index];
    if (!event) continue;
    const text = formatEvent(event, tracker);
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (usedTokens + tokens > maxTokens) {
      if (formatted.length === 0) {
        formatted.unshift(truncateToTokenBudget(text, maxTokens));
      }
      formatted.unshift("... (earlier events omitted)");
      break;
    }
    formatted.unshift(text);
    usedTokens += tokens;
  }
  return formatted.join("\n\n");
}

function buildRecentUserContextLayer(task: TaskDetail, afterEventId?: string): string {
  const startIndex = afterEventId ? task.events.findIndex((event) => event.id === afterEventId) + 1 : 0;
  const visibleEvents = startIndex > 0 ? task.events.slice(startIndex) : task.events;
  const recent = [...visibleEvents]
    .reverse()
    .filter((event) => (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted)
    .slice(0, 2)
    .reverse();
  if (recent.length === 0) return "";
  return [
    "## Recent User Messages",
    ...recent.map((event) => `- ${event.type}: ${truncate(event.summary, 4000)}`)
  ].join("\n");
}

function buildCanonicalModelMessages(
  task: TaskDetail,
  systemPrompt: string,
  options: { afterEventId?: string | undefined; maxTokens: number; tracker?: FileStateTracker | undefined }
): CanonicalModelMessage[] {
  const messages: CanonicalModelMessage[] = [];
  if (systemPrompt.trim()) messages.push({ role: "system", content: systemPrompt });
  messages.push(...buildCanonicalHistoryMessages(task, options));
  if (messages.length === 1) {
    const latestUser = latestUserEvent(task);
    if (latestUser) messages.push({ role: "user", content: latestUser.summary, eventId: latestUser.id });
  }
  return messages;
}

function buildCanonicalHistoryMessages(
  task: TaskDetail,
  options: { afterEventId?: string | undefined; maxTokens: number; tracker?: FileStateTracker | undefined }
): CanonicalModelMessage[] {
  const events = task.events.filter(isModelHistoryEvent);
  const startIndex = options.afterEventId ? events.findIndex((event) => event.id === options.afterEventId) + 1 : 0;
  const visibleEvents = startIndex > 0 ? events.slice(startIndex) : events;
  const messages: CanonicalModelMessage[] = [];
  let pendingToolCalls: Array<{ call: ToolCall; reasoningContent?: string; eventId?: string }> = [];
  const emittedToolCallIds = new Set<string>();

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    const eventId = pendingToolCalls[0]?.eventId;
    const reasoningContent = pendingToolCalls.find((pending) => pending.reasoningContent)?.reasoningContent;
    if (reasoningContent) {
      messages.push({
        role: "assistant",
        content: formatReasoningHistoryText(reasoningContent),
        ...(eventId ? { eventId: `${eventId}:reasoning` } : {})
      });
    }
    messages.push({
      role: "assistant",
      toolCalls: pendingToolCalls.map((pending) => pending.call),
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(eventId ? { eventId } : {})
    });
    for (const pending of pendingToolCalls) emittedToolCallIds.add(pending.call.id);
    pendingToolCalls = [];
  };

  const discardPendingToolCalls = (): void => {
    pendingToolCalls = [];
  };

  for (const event of visibleEvents) {
    if (event.reverted) continue;
    switch (event.type) {
      case "user_message":
      case "guidance_pending":
      case "guidance_consumed":
        discardPendingToolCalls();
        messages.push({ role: "user", content: event.summary, eventId: event.id });
        break;
      case "assistant_message":
        discardPendingToolCalls();
        {
          const reasoningContent = reasoningContentFromEvent(event);
          if (reasoningContent) {
            messages.push({
              role: "assistant",
              content: formatReasoningHistoryText(reasoningContent),
              eventId: `${event.id}:reasoning`
            });
          }
          messages.push({
            role: "assistant",
            content: event.summary,
            ...(reasoningContent ? { reasoningContent } : {}),
            eventId: event.id
          });
        }
        break;
      case "tool_requested": {
        const call = toolCallFromRequestedEvent(event);
        const reasoningContent = reasoningContentFromEvent(event);
        if (call) pendingToolCalls.push({ call, ...(reasoningContent ? { reasoningContent } : {}), eventId: event.id });
        break;
      }
      case "tool_result": {
        const call = toolCallFromResultEvent(event);
        const reasoningContent = reasoningContentFromEvent(event);
        if (!emittedToolCallIds.has(call.id)) {
          const hasPendingCall = pendingToolCalls.some((pending) => pending.call.id === call.id);
          if (hasPendingCall) flushToolCalls();
          else {
            if (reasoningContent) {
              messages.push({
                role: "assistant",
                content: formatReasoningHistoryText(reasoningContent),
                eventId: `${event.id}:reasoning`
              });
            }
            messages.push({
              role: "assistant",
              toolCalls: [call],
              ...(reasoningContent ? { reasoningContent } : {}),
              eventId: event.id
            });
            emittedToolCallIds.add(call.id);
          }
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.toolName,
          content: toolResultContentForRole(event, options.tracker),
          ...(reasoningContent ? { reasoningContent } : {}),
          eventId: event.id
        });
        break;
      }
      case "attachment_added":
        discardPendingToolCalls();
        messages.push({ role: "user", content: `Attachment added: ${event.summary}`, eventId: event.id });
        break;
      case "web_search_result":
        discardPendingToolCalls();
        break;
      case "task_rollback_completed":
      case "task_rollback_failed":
      case "rollback_partial":
        discardPendingToolCalls();
        messages.push({ role: "user", content: formatOperationalEventForContext(event), eventId: event.id });
        break;
      default:
        break;
    }
  }

  return trimCanonicalHistoryMessages(messages, options.maxTokens);
}

function formatOperationalEventForContext(event: TaskEvent): string {
  const payload = event.payload ?? {};
  const details = Object.entries(payload)
    .filter(([key, value]) =>
      ["checkpointId", "workRoot", "restoredFiles", "deletedFiles", "skippedFiles", "filePaths"].includes(key) &&
      value !== undefined &&
      value !== null
    )
    .map(([key, value]) => `${key}=${formatCompactContextValue(value)}`)
    .join(", ");
  return details ? `Workbench event: ${event.summary} (${details})` : `Workbench event: ${event.summary}`;
}

function formatCompactContextValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => formatCompactContextValue(item)).join(", ")}]`;
  if (typeof value === "string") return value.length > 220 ? `${value.slice(0, 217)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function toolCallFromRequestedEvent(event: TaskEvent): ToolCall | null {
  const toolCallId = String(event.payload["toolCallId"] ?? event.payload["id"] ?? "").trim();
  const toolName = String(event.payload["toolName"] ?? "").trim();
  if (!toolCallId || !toolName) return null;
  return { id: toolCallId, toolName, args: recordFromUnknown(event.payload["args"]) };
}

function toolCallFromResultEvent(event: TaskEvent): ToolCall {
  const toolCallId = String(event.payload["toolCallId"] ?? event.payload["id"] ?? createId("tool_call")).trim();
  const toolName = String(event.payload["toolName"] ?? "tool").trim() || "tool";
  return { id: toolCallId || createId("tool_call"), toolName, args: recordFromUnknown(event.payload["args"]) };
}

function reasoningContentFromEvent(event: TaskEvent): string | undefined {
  const value = event.payload["reasoningContent"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatReasoningHistoryText(value: string): string {
  return `Internal continuity note. Do not quote this note verbatim or use it as the final answer:\n${truncate(value, 1600)}`;
}

function toolResultContentForRole(event: TaskEvent, tracker?: FileStateTracker): string {
  const toolName = String(event.payload["toolName"] ?? "tool").trim() || "tool";
  const ok = event.payload["ok"] !== false;
  const output = String(event.payload["output"] ?? "");
  const status = ok ? "completed" : inferToolFailureStatus(output);
  if (tracker && isFileContentInTracker(event, tracker)) {
    return trackedReadFileRoleContent(event, ok, status, toolName);
  }
  return stableJson({
    ok,
    status,
    toolName,
    output: formatToolOutput(output)
  });
}

function trackedReadFileRoleContent(event: TaskEvent, ok: boolean, status: string, toolName: string): string {
  const parsed = parseJson(String(event.payload["output"] ?? ""));
  const content = typeof parsed["content"] === "string" ? parsed["content"] : "";
  const includeContent =
    content.length > 0 &&
    content.length <= MAX_READ_FILE_ROLE_INLINE_CONTENT &&
    parsed["partial"] !== true;
  return stableJson({
    ok,
    status,
    toolName,
    path: parsed["path"],
    hash: parsed["hash"],
    partial: Boolean(parsed["partial"]),
    mode: parsed["mode"],
    totalLines: parsed["totalLines"],
    output: includeContent
      ? "Current read_file content is included below and also recorded in Known Files. Treat this as live file evidence."
      : "read_file content is recorded in Known Files when context budget allows. If the visible Known Files excerpt does not include the exact lines needed, call search_files for line hits or read_file with offset/limit for the target range.",
    ...(includeContent ? { content } : {})
  });
}

function inferToolFailureStatus(output: string): "denied" | "cancelled" | "failed" {
  if (/denied by user|request denied|approval denied/i.test(output)) return "denied";
  if (/cancelled|canceled|aborted/i.test(output)) return "cancelled";
  return "failed";
}

function trimCanonicalHistoryMessages(messages: CanonicalModelMessage[], maxTokens: number): CanonicalModelMessage[] {
  if (maxTokens <= 0) return messages.slice(-1);
  const kept = [...messages];
  while (kept.length > 1 && estimateCanonicalMessages(kept) > maxTokens) {
    kept.shift();
  }
  return repairOrphanToolMessages(kept);
}

function repairOrphanToolMessages(messages: CanonicalModelMessage[]): CanonicalModelMessage[] {
  const repaired: CanonicalModelMessage[] = [];
  const knownToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) knownToolCalls.add(call.id);
      repaired.push(message);
      continue;
    }
    if (message.role === "tool" && !knownToolCalls.has(message.toolCallId)) {
      const call = { id: message.toolCallId, toolName: message.toolName, args: {} };
      repaired.push({
        role: "assistant",
        toolCalls: [call],
        ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
        ...(message.eventId ? { eventId: message.eventId } : {})
      });
      knownToolCalls.add(message.toolCallId);
    }
    repaired.push(message);
  }
  return repaired;
}

function estimateCanonicalMessages(messages: CanonicalModelMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return sum + estimateTokens(JSON.stringify(message.toolCalls));
    }
    const content = "content" in message && typeof message.content === "string" ? message.content : "";
    return sum + estimateTokens(content);
  }, 0);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, nested) => (nested === undefined ? undefined : nested));
}

export function formatEvent(event: TaskEvent, tracker?: FileStateTracker): string {
  const withReasoning = (body: string): string => {
    const reasoning = reasoningContentFromEvent(event);
    if (!reasoning) return body;
    return `**Prior Thinking**: ${truncate(reasoning, 1600)}\n${body}`;
  };
  switch (event.type) {
    case "user_message":
      return `**User**: ${event.summary}`;
    case "attachment_added":
      return `**Attachment Added**: ${event.summary}`;
    case "assistant_delta":
    case "thinking_delta":
      return "";
    case "assistant_message":
      return withReasoning(`**Agent**: ${event.summary}`);
    case "tool_requested":
      return withReasoning(`**Tool Call**: ${event.payload["toolName"]}(${formatToolArgsForContext(event.payload["args"] ?? {})})`);
    case "tool_result": {
      if (tracker && isFileContentInTracker(event, tracker)) return formatTrackedReadFileResult(event);
      const fileResult = formatFileToolResult(event);
      if (fileResult) return withReasoning(fileResult);
      return withReasoning(`${formatToolResultHeading(event)}:\n${formatToolOutput(String(event.payload["output"] ?? ""))}`);
    }
    case "approval_pending":
      return `**Approval Required**: ${event.payload["toolName"]} [${event.payload["riskCategory"]}]`;
    case "approval_auto_granted":
      return `**Approval Auto Granted**: ${event.payload["riskCategory"]}`;
    case "approval_resolved":
      return `**Approval Resolved**: ${event.payload["decision"]}`;
    case "guidance_consumed":
      return `**Guidance**: ${event.summary}`;
    case "guidance_pending":
      return `**Pending Guidance**: ${event.summary}`;
    case "conversation_summary_created":
      return "";
    case "context_overflow_recovered":
      return "";
    case "plan_created":
    case "plan_step_started":
    case "plan_step_completed":
    case "plan_step_blocked":
    case "plan_revised":
      return `**Plan**: ${event.summary}`;
    case "web_search_result":
      return `**Web Search**: ${event.summary}`;
    case "verification_result_recorded":
      return `**Verification**: ${event.summary}`;
    default:
      return `**${event.type}**: ${event.summary}`;
  }
}

function isModelHistoryEvent(event: TaskEvent): boolean {
  if (["status_changed", "task_created", "task_memory_created", "task_title_updated", "task_graph_created", "task_graph_node_started", "pattern_discovered", "reflection_completed", "tool_started", "tool_progress", "model_empty_response"].includes(event.type)) return false;
  if (event.type === "web_search_result") return false;
  if (event.type.startsWith("plan_")) return false;
  if (["prompt_cache_stats", "token_usage_recorded", "conversation_summary_created", "context_overflow_recovered", "project_memory_version_created", "project_memory_rollback_completed"].includes(event.type)) return false;
  if (event.payload["uiHidden"] === true && event.type !== "tool_result") return false;
  return true;
}

function isSummarizableContextEvent(event: TaskEvent): boolean {
  if (["assistant_delta", "thinking_delta", "conversation_summary_created", "context_overflow_recovered", "prompt_cache_stats", "token_usage_recorded", "project_memory_version_created", "task_title_updated", "task_graph_created", "task_graph_node_started", "tool_started", "tool_progress", "model_empty_response"].includes(event.type)) return false;
  if (event.type === "web_search_result") return false;
  if (event.type.startsWith("plan_")) return false;
  if (event.payload["uiHidden"] === true && event.type !== "tool_result") return false;
  return true;
}

function estimateEventsForSummary(events: TaskEvent[]): number {
  return events.reduce((sum, event) => sum + estimateTokens(formatEvent(event)), 0);
}

function formatAttachmentForContext(attachment: TaskAttachment): string {
  const preview = attachment.textPreview ? `\nPreview:\n${attachment.textPreview.slice(0, 1200)}` : "";
  return `- ${attachment.id}: ${attachment.fileName} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes, hash ${attachment.contentHash})${preview}`;
}

function buildRollingConversationSummary(task: TaskDetail, events: TaskEvent[], retainedFacts: string[] = []): string {
  const latestUser = latestUserEvent(task);
  const lines = events
    .map((event) => formatEvent(event))
    .filter(Boolean)
    .filter((line) => !line.includes("UI preview truncated"))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const compact = lines.slice(-24).map((line) => `- ${line.slice(0, 700)}`).join("\n");
  return [
    "Auditable model context summary. This is for model continuity only; it is not the user-visible transcript.",
    latestUser ? `Current objective: ${truncate(latestUser.summary, 1000)}` : "",
    "Retain decisions, constraints, file-state conclusions, and tool evidence references. Prefer fresh tool evidence when exact file contents or host state matter.",
    retainedFacts.length > 0 ? ["Retained facts:", ...retainedFacts.map((fact) => `- ${fact}`)].join("\n") : "",
    "Earlier event digest:",
    compact
  ].filter(Boolean).join("\n");
}

function buildRetainedFacts(task: TaskDetail, summarizedEvents: TaskEvent[]): string[] {
  const facts = new Set<string>();
  const latestUser = latestUserEvent(task);
  if (latestUser) facts.add(`Current user request: ${truncate(latestUser.summary, 600)}`);
  if (task.workRoot) facts.add(`Work root: ${task.workRoot}`);
  const latestGuidance = [...task.events].reverse().find((event) => event.type === "guidance_pending" || event.type === "guidance_consumed");
  if (latestGuidance) facts.add(`Latest guidance: ${truncate(latestGuidance.summary, 300)}`);
  const latestPlan = [...task.events].reverse().find((event) => event.type.startsWith("plan_") && !event.reverted);
  if (latestPlan) facts.add(`Latest plan state: ${truncate(latestPlan.summary, 300)}`);
  const tools = summarizedEvents
    .filter((event) => event.type === "tool_result")
    .map((event) => String(event.payload["toolName"] ?? "tool"))
    .filter(Boolean);
  if (tools.length > 0) facts.add(`Earlier tool evidence refs: ${[...new Set(tools)].slice(0, 8).join(", ")}`);
  for (const fact of extractFailedToolEvidenceFacts(summarizedEvents)) facts.add(fact);
  const blocked = [...task.events].reverse().find((event) => event.type === "plan_step_blocked");
  if (blocked) facts.add(`Latest blocked step: ${truncate(blocked.summary, 160)}`);
  return [...facts];
}

function mergeRetainedFacts(facts: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const normalized = fact.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged.slice(-MAX_RETAINED_FACTS);
}

function extractFailedToolEvidenceFacts(events: TaskEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool_result")
    .filter((event) => event.payload["ok"] === false || /assert|expected|actual|fail|error|exception|!==/i.test(String(event.payload["output"] ?? "")))
    .slice(-3)
    .flatMap((event) => {
      const toolName = String(event.payload["toolName"] ?? "tool");
      const output = String(event.payload["output"] ?? event.summary ?? "");
      return [
        ...extractStrictEqualityAssertionFacts(output).map((fact) => `Earlier failed ${toolName} assertion: ${fact}`),
        `Earlier failed ${toolName} evidence: ${truncate(formatToolOutput(output), 1200)}`
      ];
    });
}

function extractStrictEqualityAssertionFacts(output: string): string[] {
  const facts: string[] = [];
  const ansiEscape = String.fromCharCode(27);
  const clean = output.replace(new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const inline = line.match(/^(.+?)\s*!==\s*(.+)$/);
    if (!inline) continue;
    facts.push(`strict equality mismatch actual ${normalizeAssertionValue(inline[1] ?? "")}; expected ${normalizeAssertionValue(inline[2] ?? "")}.`);
    if (facts.length >= 4) return facts;
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\+ actual - expected$/i.test(lines[index] ?? "")) continue;
    let actual = "";
    let expected = "";
    for (const line of lines.slice(index + 1, index + 9)) {
      if (!actual && /^\+\s+/.test(line) && !/^\+\+\+/.test(line)) actual = line.replace(/^\+\s+/, "");
      if (!expected && /^-\s+/.test(line) && !/^---/.test(line)) expected = line.replace(/^-\s+/, "");
      if (actual && expected) break;
    }
    if (actual && expected) {
      facts.push(`strict equality mismatch actual ${normalizeAssertionValue(actual)}; expected ${normalizeAssertionValue(expected)}.`);
      if (facts.length >= 4) return facts;
    }
  }
  return facts;
}

function normalizeAssertionValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function latestUserEvent(task: TaskDetail): TaskEvent | undefined {
  return [...task.events].reverse().find((event) =>
    (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted
  );
}

function extractExplicitVerificationCommands(task: TaskDetail): string[] {
  const commands = new Set<string>();
  for (const event of task.events) {
    if (event.reverted) continue;
    if (event.type !== "user_message" && event.type !== "guidance_pending" && event.type !== "guidance_consumed") continue;
    for (const command of extractCommandsFromText(event.summary)) {
      commands.add(command);
      if (commands.size >= 4) return [...commands];
    }
  }
  return [...commands];
}

function extractCommandsFromText(text: string): string[] {
  const commands = new Set<string>();
  const patterns = [
    /\b(?:npm(?:\.cmd)?(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:pnpm(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:yarn(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:npx\s+[a-z0-9:_-]+(?:\s+[a-z0-9:_./-]+){0,3})\b/giu,
    /\b(?:node|deno|bun|python(?:3)?)\s+[^\s`"'，。；：,;:]+(?:\s+[^\s`"'，。；：,;:]+){0,3}/giu,
    /\b(?:vitest|jest|pytest|playwright(?:\s+test)?|tsc|cargo\s+test|go\s+test)\b/giu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeExtractedCommand(match[0] ?? "");
      if (!value) continue;
      commands.add(value);
    }
  }
  return [...commands];
}

function normalizeExtractedCommand(value: string): string {
  return value
    .replace(/^[`"'([{]+/u, "")
    .replace(/[`"')\]}.,;:，。；：]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function describeTargetVerificationStatus(task: TaskDetail, commands: string[]): string {
  if (commands.length === 0) return "";
  const lastRecordedChangeIndex = findLastRecordedFileChangeIndex(task.events);
  if (lastRecordedChangeIndex < 0) {
    return "Recorded verification status: no file edits or rollbacks have been recorded yet. Keep the listed command(s) in scope if changes become necessary.";
  }
  const recentEvents = task.events.slice(lastRecordedChangeIndex + 1);
  const satisfied = commands.filter((command) => hasSuccessfulVerificationCommand(recentEvents, command));
  if (satisfied.length === commands.length) {
    return `Recorded verification after the latest file change: ${satisfied.map((command) => `\`${command}\``).join(", ")}.`;
  }
  return satisfied.length > 0
    ? `Recorded verification after the latest file change: ${satisfied.map((command) => `\`${command}\``).join(", ")}. Remaining required command(s): ${commands.filter((command) => !satisfied.includes(command)).map((command) => `\`${command}\``).join(", ")}.`
    : `Recorded verification after the latest file change: none yet. Remaining required command(s): ${commands.map((command) => `\`${command}\``).join(", ")}.`;
}

function findLastRecordedFileChangeIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || event.reverted) continue;
    if (event.type === "task_rollback_completed") return index;
    if (event.type !== "tool_result" || event.payload["ok"] === false) continue;
    const toolName = String(event.payload["toolName"] ?? "");
    if (toolName === "edit_file" || toolName === "write_file") return index;
  }
  return -1;
}

function hasSuccessfulVerificationCommand(events: TaskEvent[], expectedCommand: string): boolean {
  return events.some((event) => {
    if (event.reverted || event.type !== "tool_result" || event.payload["ok"] === false) return false;
    if (String(event.payload["toolName"] ?? "") !== "run_command") return false;
    const args = event.payload["args"];
    const command = args && typeof args === "object" ? String((args as Record<string, unknown>)["command"] ?? "") : "";
    return commandsEquivalent(command, expectedCommand);
  });
}

function commandsEquivalent(actualCommand: string, expectedCommand: string): boolean {
  return canonicalizeCommandForComparison(actualCommand) === canonicalizeCommandForComparison(expectedCommand);
}

function canonicalizeCommandForComparison(command: string): string {
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

function formatToolArgsForContext(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "{}";
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === "edits" && Array.isArray(value)) {
      compact[key] = `[${value.length} edits; content omitted]`;
      continue;
    }
    if (key === "content" || key === "newText" || key === "text") {
      compact[key] = typeof value === "string" ? summarizeLargeString(value) : "[content omitted]";
      continue;
    }
    if (typeof value === "string") {
      compact[key] = summarizeLargeString(value);
      continue;
    }
    if (Array.isArray(value)) {
      compact[key] = value.length > 8 ? `[${value.length} items]` : value.map((item) => (typeof item === "string" ? summarizeLargeString(item) : summarizeJsonValue(item)));
      continue;
    }
    compact[key] = summarizeJsonValue(value);
  }
  return JSON.stringify(compact);
}

function summarizeLargeString(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 140)}... (${normalized.length - 180} chars omitted) ...${normalized.slice(-40)}`;
}

function summarizeJsonValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = JSON.stringify(value);
  if (raw.length <= 220) return value;
  return `[object ${raw.length} chars omitted]`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) tokens += 1;
    else if (/[a-zA-Z0-9]/.test(char)) tokens += 0.25;
    else tokens += 0.5;
  }
  return Math.ceil(tokens);
}

function formatToolOutput(output: string): string {
  if (output.length <= 4000) return output;
  if (/error|exception|failed|stack trace/i.test(output)) return extractErrorSummary(output);
  if (/passing|failing|test suite|✓|✗/i.test(output)) return extractTestSummary(output);
  return `${output.slice(0, 2000)}\n\n... (${output.length - 4000} chars omitted) ...\n\n${output.slice(-2000)}`;
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const budget = Math.max(1, maxTokens);
  let used = 0;
  let index = 0;
  for (; index < text.length; index++) {
    const token = estimateTokens(text[index] ?? "");
    if (used + token > budget) break;
    used += token;
  }
  if (index >= text.length) return text;
  return `${text.slice(0, index)}\n... (latest event truncated to fit context)`;
}

function trimMiddleToTokenBudget(text: string, maxTokens: number, protectedBlocks: string[] = []): string {
  if (!text || estimateTokens(text) <= maxTokens) return text;
  const notice = [
    "## Context Budget Notice",
    "Older context was compacted or trimmed to fit the active model window. Prefer fresh tool evidence when exact details matter.",
    ""
  ].join("\n");
  const usefulProtected = protectedBlocks
    .map((block) => block.trim())
    .filter((block, index, all) => block && all.indexOf(block) === index);
  let remainingText = text;
  for (const block of usefulProtected) {
    remainingText = remainingText.replace(block, "");
  }
  const protectedBudget = usefulProtected.length > 0 ? Math.max(96, Math.floor(maxTokens * 0.5)) : 0;
  const protectedBlockBudget = usefulProtected.length > 0 ? Math.max(24, Math.floor(protectedBudget / usefulProtected.length)) : 0;
  const protectedText = usefulProtected.map((block) => {
    if (block.includes("Tool root:")) return block;
    if (block.startsWith("## Recent User Messages")) return truncateToTokenBudget(block, Math.max(80, protectedBlockBudget));
    return truncateToTokenBudget(block, protectedBlockBudget);
  }).join("\n\n");
  const contentBudget = Math.max(20, maxTokens - estimateTokens(notice) - estimateTokens(protectedText));
  const headBudget = Math.max(10, Math.floor(contentBudget * 0.25));
  const tailBudget = Math.max(10, contentBudget - headBudget);
  const head = trimHeadToTokenBudget(remainingText.trim(), headBudget);
  const tail = trimTailToTokenBudget(remainingText.trim(), tailBudget);
  return [
    notice,
    head,
    protectedText,
    "... (middle context compacted to fit model budget) ...",
    tail
  ].filter((part) => part.trim().length > 0).join("\n\n");
}

function trimHeadToTokenBudget(text: string, maxTokens: number): string {
  const budget = Math.max(1, maxTokens);
  let used = 0;
  let index = 0;
  for (; index < text.length; index++) {
    const token = estimateTokens(text[index] ?? "");
    if (used + token > budget) break;
    used += token;
  }
  return text.slice(0, index);
}

function trimTailToTokenBudget(text: string, maxTokens: number): string {
  const budget = Math.max(1, maxTokens);
  let used = 0;
  let index = text.length - 1;
  for (; index >= 0; index--) {
    const token = estimateTokens(text[index] ?? "");
    if (used + token > budget) break;
    used += token;
  }
  const start = index + 1;
  let adjustedStart = start;
  while (adjustedStart > 0 && start - adjustedStart < 96 && /\S/.test(text[adjustedStart - 1] ?? "")) {
    adjustedStart -= 1;
  }
  if (adjustedStart !== start) {
    const candidate = text.slice(adjustedStart);
    if (estimateTokens(candidate) <= budget + 8) return candidate;
  }
  return text.slice(start);
}

function isFileContentInTracker(event: TaskEvent, tracker: FileStateTracker): boolean {
  if (event.payload["ok"] === false) return false;
  if (String(event.payload["toolName"] ?? "") !== "read_file") return false;
  const output = String(event.payload["output"] ?? "");
  const parsed = parseJson(output);
  const path = String(parsed["path"] ?? "");
  return Boolean(path && typeof parsed["content"] === "string" && tracker.hasFile(path));
}

function formatTrackedReadFileResult(event: TaskEvent): string {
  const parsed = parseJson(String(event.payload["output"] ?? ""));
  const path = typeof parsed["path"] === "string" ? parsed["path"] : "unknown file";
  const partial = parsed["partial"] ? " partial" : "";
  const hashValue = typeof parsed["hash"] === "string" ? ` hash=${parsed["hash"]}` : "";
  return `**Tool Result read_file**: ${path}${partial}${hashValue} (content recorded in Known Files)`;
}

function formatToolResultHeading(event: TaskEvent): string {
  const toolName = String(event.payload["toolName"] ?? "").trim();
  const suffix = event.payload["uiHidden"] === true ? " (hidden from UI)" : "";
  return toolName ? `**Tool Result ${toolName}${suffix}**` : `**Tool Result${suffix}**`;
}

function formatFileToolResult(event: TaskEvent): string | null {
  const output = String(event.payload["output"] ?? "");
  const parsed = parseJson(output);
  const path = typeof parsed["path"] === "string" ? parsed["path"] : "";
  if (!path) return null;

  if (typeof parsed["content"] === "string") {
    const content = parsed["content"];
    const partial = parsed["partial"] ? " partial" : "";
    const hashValue = typeof parsed["hash"] === "string" ? ` hash=${parsed["hash"]}` : "";
    const maxContentChars = 24000;
    return [
      `**Tool Result read_file**: ${path}${partial}${hashValue}`,
      "```",
      content.length > maxContentChars
        ? `${content.slice(0, 16000)}\n... (file content budget-limited; use targeted read_file if exact omitted lines are needed) ...\n${content.slice(-6000)}`
        : content,
      "```"
    ].join("\n");
  }

  if (typeof parsed["changed"] === "boolean") {
    const hashValue = typeof parsed["hash"] === "string" ? ` hash=${parsed["hash"]}` : "";
    const toolName = String(event.payload["toolName"] ?? "edit_file");
    return `**Tool Result ${toolName}**: ${path} changed=${parsed["changed"]}${hashValue}`;
  }

  return null;
}

function extractErrorSummary(output: string): string {
  const lines = output.split("\n");
  const errorLines = lines.filter((line) => /error|exception|failed/i.test(line)).slice(0, 10);
  return [...errorLines, "...", ...lines.slice(-20)].join("\n");
}

function extractTestSummary(output: string): string {
  const lines = output.split("\n");
  const summary = lines.find((line) => /test suite|passing|failing/i.test(line)) ?? "";
  const failures = lines.filter((line) => /fail|✗|error/i.test(line)).slice(0, 10);
  return [summary, "", ...failures, "... (omitted)"].join("\n");
}

function looksLikeBinary(output: string): boolean {
  const nonPrintable = [...output].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  }).length;
  return output.length > 0 && nonPrintable > output.length * 0.1;
}

function parseJson(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hash(content: string): string {
  let value = 0;
  for (let index = 0; index < content.length; index++) {
    value = (value << 5) - value + content.charCodeAt(index);
    value |= 0;
  }
  return value.toString(16);
}

function normalizeTrackedReadFileContent(
  content: string,
  options: { totalLines?: number; mode?: string; partial: boolean }
): { content: string; isPartial: boolean } {
  const totalLines = options.totalLines ?? countLines(content);
  if (
    options.partial ||
    options.mode === "range" ||
    (content.length <= MAX_READ_FILE_CONTENT && totalLines <= MAX_READ_FILE_FULL_LINES)
  ) {
    return { content, isPartial: options.partial };
  }

  const lines = content.split(/\r?\n/);
  const head = lines.slice(0, TRACKED_FILE_HEAD_LINES);
  const tail = lines.slice(-TRACKED_FILE_TAIL_LINES);
  const omittedLines = Math.max(0, totalLines - head.length - tail.length);
  const preview = [
    `[Known file excerpt: ${content.length} chars, ${totalLines} lines. Large full-file reads are compacted before they enter model context.]`,
    ...head,
    omittedLines > 0 ? `... (${omittedLines} lines omitted; use search_files for line hits or read_file with offset/limit for exact sections) ...` : "",
    ...tail
  ].filter(Boolean).join("\n");
  return { content: preview, isPartial: true };
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

async function readMemoryFile(path: string, maxChars: number, fallback = ""): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => fallback);
  return content.trim().slice(0, maxChars);
}

function defaultUserMemoryContent(): string {
  return [
    "# USER.md",
    "",
    "Stable user preferences for Agent Workbench. Keep entries short, durable, and broadly useful.",
    "",
    "## Preferences",
    "- Language: zh-CN unless the user asks otherwise.",
    "- Style: direct, careful, evidence-backed.",
    "",
    "## Long-term Constraints",
    "- Do not use scripted task quality gates or fixed report protocols to control ordinary agent work."
  ].join("\n");
}

function defaultGlobalMemoryContent(): string {
  return [
    "# MEMORY.md",
    "",
    "Global durable memory shared across projects.",
    "",
    "## Key Facts",
    "- Keep only stable facts that should apply across future Agent Workbench tasks.",
    "",
    "## Open Risks",
    "- Add only cross-project risks that remain important."
  ].join("\n");
}

function defaultProjectMemoryContent(workRoot: string): string {
  return [
    "# MEMORY.md",
    "",
    "Project durable memory scoped to the current task folder.",
    `Work root: ${workRoot}`,
    "",
    "## Key Facts",
    "- Keep only stable project facts, constraints, paths, and unresolved risks.",
    "",
    "## Open Risks",
    "- Add risks only when they remain relevant across future tasks."
  ].join("\n");
}

function rankKnowledgeBriefItems(items: KnowledgeItem[], task: TaskDetail): KnowledgeItem[] {
  const queryTokens = knowledgeBriefQueryTokens(task);
  if (queryTokens.size === 0) return [...items].sort(compareKnowledgeBriefItems);
  return [...items]
    .map((item) => ({ item, score: scoreKnowledgeBriefItem(item, queryTokens) }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return compareKnowledgeBriefItems(left.item, right.item);
    })
    .map(({ item }) => item);
}

function knowledgeBriefQueryTokens(task: TaskDetail): Set<string> {
  const recent = [...task.events]
    .reverse()
    .filter((event) =>
      (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted
    )
    .slice(0, MAX_KNOWLEDGE_BRIEF_QUERY_EVENTS)
    .map((event) => event.summary);
  return new Set(tokenizeKnowledgeBriefText([task.title, ...recent].join("\n")).filter((token) => !GENERIC_KNOWLEDGE_BRIEF_TOKENS.has(token)));
}

function scoreKnowledgeBriefItem(item: KnowledgeItem, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const titleTokens = tokenizeKnowledgeBriefText(item.title);
  const tagTokens = item.tags.flatMap(tokenizeKnowledgeBriefText);
  const sourceTokens = tokenizeKnowledgeBriefText([item.fileName, item.sourceUri, item.kind].filter(Boolean).join(" "));
  const contentTokens = tokenizeKnowledgeBriefText(item.content.slice(0, MAX_KNOWLEDGE_BRIEF_SCORE_TEXT));
  return (
    weightedTokenOverlap(queryTokens, titleTokens, 8) +
    weightedTokenOverlap(queryTokens, tagTokens, 7) +
    weightedTokenOverlap(queryTokens, sourceTokens, 5) +
    weightedTokenOverlap(queryTokens, contentTokens, 1)
  );
}

function weightedTokenOverlap(queryTokens: Set<string>, candidateTokens: string[], weight: number): number {
  let score = 0;
  const seen = new Set<string>();
  for (const token of candidateTokens) {
    if (seen.has(token) || !queryTokens.has(token)) continue;
    seen.add(token);
    score += weight;
  }
  return score;
}

function tokenizeKnowledgeBriefText(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9_]{2,}/gu)) {
    const token = match[0];
    if (!token) continue;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (const char of token) tokens.push(char);
      for (let index = 0; index < token.length - 1; index += 1) tokens.push(token.slice(index, index + 2));
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

const GENERIC_KNOWLEDGE_BRIEF_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "the",
  "this",
  "that",
  "with",
  "继续",
  "当前",
  "检查",
  "实现",
  "项目",
  "功能",
  "优化",
  "完善",
  "测试",
  "继",
  "续",
  "当",
  "前",
  "检",
  "查",
  "实",
  "现",
  "项",
  "目",
  "功",
  "能",
  "优",
  "化",
  "完",
  "善",
  "测",
  "试"
]);

function compareKnowledgeBriefItems(left: KnowledgeItem, right: KnowledgeItem): number {
  const statusDelta = knowledgeStatusRank(right) - knowledgeStatusRank(left);
  if (statusDelta !== 0) return statusDelta;
  const chunkDelta = right.chunkCount - left.chunkCount;
  if (chunkDelta !== 0) return chunkDelta;
  const indexedDelta = String(right.lastIndexedAt ?? "").localeCompare(String(left.lastIndexedAt ?? ""));
  if (indexedDelta !== 0) return indexedDelta;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function knowledgeStatusRank(item: KnowledgeItem): number {
  if (item.indexStatus === "indexed") return 3;
  if (item.indexStatus === "pending") return 2;
  if (item.indexStatus === "metadata_only") return 1;
  return 0;
}

function formatKnowledgeBriefItem(item: KnowledgeItem): string {
  const tags = item.tags.length > 0 ? item.tags.slice(0, 6).join(", ") : "none";
  const source = item.fileName ?? item.sourceUri ?? item.kind;
  const summary = truncate(item.content.replace(/\s+/g, " ").trim(), MAX_KNOWLEDGE_BRIEF_SUMMARY);
  return [
    `- ${item.id}: ${item.title}`,
    `  kind=${item.kind}; status=${item.indexStatus}; chunks=${item.chunkCount}; source=${source}; tags=${tags}`,
    summary ? `  summary=${summary}` : ""
  ].filter(Boolean).join("\n");
}

function compareSkillCatalogEntries(left: SkillRecord, right: SkillRecord): number {
  const successDelta = right.stats.successRate - left.stats.successRate;
  if (Math.abs(successDelta) > 0.001) return successDelta;
  const lastUsedDelta = String(right.lastUsedAt ?? "").localeCompare(String(left.lastUsedAt ?? ""));
  if (lastUsedDelta !== 0) return lastUsedDelta;
  const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;
  return left.id.localeCompare(right.id);
}

function findActiveModelProvider(providers: ModelProviderRecord[], activeId?: string): ModelProviderRecord | undefined {
  return (
    providers.find((provider) => provider.id === activeId && provider.enabled) ??
    providers.find((provider) => provider.enabled && Boolean(provider.apiKeyRef)) ??
    providers.find((provider) => provider.enabled)
  );
}

function formatContextWindow(provider: ModelProviderRecord): string {
  const model = provider.models.find((item) => item.id === provider.defaultModelId) ?? provider.models[0];
  if (!model) return "unknown";
  if (model.contextWindow >= 1_000_000) return `${Math.round(model.contextWindow / 10_000) / 100}M`;
  if (model.contextWindow >= 1000) return `${Math.round(model.contextWindow / 1000)}K`;
  return String(model.contextWindow);
}

function memoryPathHash(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 20);
}

function memoryBaseDir(): string {
  return resolve(
    process.env["AGENT_WORKBENCH_MEMORY_DIR"]?.trim() ||
      process.env["SCC_MEMORY_DIR"]?.trim() ||
      resolve(findWorkspaceRoot(), "data", "memory")
  );
}
