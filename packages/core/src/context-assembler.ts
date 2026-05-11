import type { ConversationSummary, KnowledgeItem, ModelProviderRecord, SkillRecord, TaskAttachment, TaskDetail, TaskEvent, ToolCall, UserPreferences } from "@scc/shared";
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
const MAX_READ_FILE_CONTENT = 24000;
const MAX_READ_FILE_HEAD = 16000;
const MAX_READ_FILE_TAIL = 6000;
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
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[]; eventId?: string }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; eventId?: string };

export interface LoadedSkillSession {
  loadedSkills: Set<string>;
  unavailableSkills: Set<string>;
  loadedSkillBodies: SkillRecord[];
  pendingLoadedSkills: SkillRecord[];
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

    const loadedSkills = this.loadedSkillPrompt(task.id);
    if (loadedSkills) {
      systemLayers.push(loadedSkills);
      usedTokens += estimateTokens(loadedSkills);
    }

    const workingFolderLayer = this.buildWorkingFolderLayer(task);
    systemLayers.push(workingFolderLayer);
    usedTokens += estimateTokens(workingFolderLayer);

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

    const currentTurnLayer = this.buildCurrentTurnLayer(task);
    if (currentTurnLayer) {
      inputLayers.push(currentTurnLayer);
      usedTokens += estimateTokens(currentTurnLayer);
    }

    const continuityLayer = this.buildTaskContinuityLayer(task);
    systemLayers.push(continuityLayer);
    usedTokens += estimateTokens(continuityLayer);

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
      systemLayers.push(fileLayer);
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
    if (session.loadedSkills.has(skillId) || session.loadCount >= 3) return undefined;
    const skill = await this.resolveSkillReference(skillId);
    if (!skill || skill.status !== "active") {
      if (skillId) session.unavailableSkills.add(skillId);
      session.loadCount += 1;
      return undefined;
    }
    session.loadedSkills.add(skillId);
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
        ? `## Unavailable Skills\nDo not call use_skill for these IDs again in this task; choose direct tools or answer from evidence instead.\n${[...session.unavailableSkills].join(", ")}`
        : "";
    return [loaded, unavailable].filter(Boolean).join("\n\n");
  }

  private async buildSkillMetaLayer(preferences: UserPreferences): Promise<string> {
    if (!preferences.skillAutoInject) return "";
    const skills = (await this.store.listSkills())
      .filter((skill) => skill.status === "active")
      .sort(compareSkillCatalogEntries)
      .slice(0, preferences.maxInjectedSkills);
    if (skills.length === 0) return "";
    return [
      "## Available Skills",
      "This is a bounded catalog of active skills. It is not selected from the latest user text. Call use_skill with name set to the skill ID or exact title only when you decide the full guidance is needed.",
      ...skills.map((skill) => {
        const success = Math.round(skill.stats.successRate * 100);
        return [
          `- ${skill.id}: ${skill.title} (${skill.status}, ${success}% success)`,
          `  applicability: ${skill.applicability.description}`,
          skill.applicability.requiredTools.length > 0 ? `  tools: ${skill.applicability.requiredTools.join(", ")}` : ""
        ].filter(Boolean).join("\n");
      })
    ].join("\n");
  }

  private buildSystemLayer(preferences: UserPreferences): string {
    const lines = [
      "You are the SCC workbench agent.",
      `User preferred agent role: ${preferences.agentRole || "Pragmatic engineering assistant"}.`,
      `User preferred tone: ${preferences.agentTone || "balanced"}.`,
      `User preferred response detail: ${preferences.responseDetail || "normal"}.`,
      "Choose the next action yourself based on the user's goal, available tools, durable memory, skills, and evidence.",
      "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
      "When a tool needs user approval, the application will ask the user; do not assume the current authorization state.",
      "Scripts, builds, tests, and command output are tool evidence for you to interpret; they are never task-completion judges.",
      "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless the user explicitly asks.",
      "USER.md and MEMORY.md content below is already injected from SCC's internal memory store. Do not try to read USER.md or MEMORY.md from the workRoot; use the memory tools only when the user wants durable memory changed.",
      "Use USER.md and MEMORY.md tools only for durable memories the user wants kept; do not store transient task outputs, secrets, or speculative guesses.",
      "Use skill_create or skill_delete only when the user explicitly asks or when a reviewed reusable pattern is ready; normal task completion should create memory, not a skill.",
      "When using side-effect-free state tools such as plan_update or use_skill, do not narrate the tool mechanics, tool JSON, or success status to the user; continue with the actual task.",
      "Role-ordered assistant/tool history is SCC's own execution record. Treat prior tool results as the agent's evidence, not as user-provided examples.",
      "For greetings, thanks, simple chat, and capability questions, answer directly without calling tools or loading more context.",
      "When asked to test or list tools, treat it as a safe capability check; do not create files, edit memory, edit skills, or run persistent side-effect tools unless the user explicitly authorizes that scope.",
      "When the user asks what you can do, answer directly from your general capabilities; do not inspect files first.",
      "Do not claim the project name, stack, files, or runtime state until you have verified them with tool evidence.",
      "If you need a file but are unsure it exists, list or search first instead of guessing paths such as README.md.",
      "Tool distinction: search_files searches the live workspace and returns path/line snippets only; read_file returns live file content; knowledge_search searches the saved Knowledge library and is not proof of current files.",
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
    return [
      "## Target Mode",
      "The user explicitly started /target. Work toward complete verified goal satisfaction, not a merely plausible answer.",
      "First establish acceptance criteria if they are not already clear. Continue with evidence-driven exploration, implementation, and verification until the criteria are met or the system pauses on limits or user interruption.",
      "If verification fails, use the failure as evidence for the next step. If blocked by permissions or ambiguity, ask the user with ask_user.",
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
      "These are durable, user-managed memory notes from SCC's internal memory store. Treat them as preferences and project context, not proof of current file contents. Do not read USER.md or MEMORY.md from the workRoot; the content below is the authoritative injected memory snapshot.",
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
    const items = [...byId.values()].sort(compareKnowledgeBriefItems);
    if (items.length === 0) return "";
    const selected = items.slice(0, preferences.maxInjectedKnowledgeItems);
    return [
      "## Knowledge Brief",
      `Library knowledge available for this project scope: ${items.length} item(s).`,
      "These are compact candidate background pointers, not the current user request and not proof of live file state. Use knowledge_search when full evidence or exact wording is needed.",
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
    const summaryText = buildRollingConversationSummary(task, slice);
    const now = nowIso();
    const retainedFacts = buildRetainedFacts(task, slice);
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
      unavailableSkills: new Set<string>(),
      loadedSkillBodies: [],
      pendingLoadedSkills: [],
      loadCount: 0
    };
    this.skillSessions.set(taskId, created);
    return created;
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
        const metadata: Partial<Pick<FileState, "totalChars" | "totalLines" | "mode">> = { totalChars: content.length };
        if (typeof parsed["totalLines"] === "number") metadata.totalLines = parsed["totalLines"];
        if (typeof parsed["mode"] === "string") metadata.mode = parsed["mode"];
        this.set(path, content, event.createdAt, Boolean(parsed["partial"]), {
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
    const lines = ["## Known Files (do not guess content)"];
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
  let pendingToolCalls: ToolCall[] = [];
  const emittedToolCallIds = new Set<string>();

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    const eventId = pendingToolCalls[0]?.id;
    messages.push({ role: "assistant", toolCalls: pendingToolCalls, ...(eventId ? { eventId } : {}) });
    for (const call of pendingToolCalls) emittedToolCallIds.add(call.id);
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
        messages.push({ role: "assistant", content: event.summary, eventId: event.id });
        break;
      case "tool_requested": {
        const call = toolCallFromRequestedEvent(event);
        if (call) pendingToolCalls.push(call);
        break;
      }
      case "tool_result": {
        const call = toolCallFromResultEvent(event);
        if (!emittedToolCallIds.has(call.id)) {
          const hasPendingCall = pendingToolCalls.some((pending) => pending.id === call.id);
          if (hasPendingCall) flushToolCalls();
          else {
            messages.push({ role: "assistant", toolCalls: [call], eventId: event.id });
            emittedToolCallIds.add(call.id);
          }
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.toolName,
          content: toolResultContentForRole(event, options.tracker),
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
        messages.push({ role: "assistant", content: `Web search result: ${event.summary}`, eventId: event.id });
        break;
      default:
        break;
    }
  }

  return trimCanonicalHistoryMessages(messages, options.maxTokens);
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

function toolResultContentForRole(event: TaskEvent, tracker?: FileStateTracker): string {
  const toolName = String(event.payload["toolName"] ?? "tool").trim() || "tool";
  const ok = event.payload["ok"] !== false;
  const output = String(event.payload["output"] ?? "");
  const status = ok ? "completed" : inferToolFailureStatus(output);
  if (tracker && isFileContentInTracker(event, tracker)) {
    const parsed = parseJson(output);
    return stableJson({
      ok,
      status,
      toolName,
      path: parsed["path"],
      hash: parsed["hash"],
      partial: Boolean(parsed["partial"]),
      mode: parsed["mode"],
      totalLines: parsed["totalLines"],
      output: "read_file content is recorded in Known Files when context budget allows. If the visible Known Files excerpt does not include the exact lines needed, call search_files for line hits or read_file with offset/limit for the target range."
    });
  }
  return stableJson({
    ok,
    status,
    toolName,
    output: formatToolOutput(output)
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
      repaired.push({ role: "assistant", toolCalls: [call], ...(message.eventId ? { eventId: message.eventId } : {}) });
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
  switch (event.type) {
    case "user_message":
      return `**User**: ${event.summary}`;
    case "attachment_added":
      return `**Attachment Added**: ${event.summary}`;
    case "assistant_delta":
    case "thinking_delta":
      return "";
    case "assistant_message":
      return `**Agent**: ${event.summary}`;
    case "tool_requested":
      return `**Tool Call**: ${event.payload["toolName"]}(${formatToolArgsForContext(event.payload["args"] ?? {})})`;
    case "tool_result": {
      if (tracker && isFileContentInTracker(event, tracker)) return formatTrackedReadFileResult(event);
      const fileResult = formatFileToolResult(event);
      if (fileResult) return fileResult;
      return `${formatToolResultHeading(event)}:\n${formatToolOutput(String(event.payload["output"] ?? ""))}`;
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
  if (event.type.startsWith("plan_")) return false;
  if (["prompt_cache_stats", "token_usage_recorded", "conversation_summary_created", "context_overflow_recovered", "project_memory_version_created", "project_memory_rollback_completed"].includes(event.type)) return false;
  if (event.payload["uiHidden"] === true && event.type !== "tool_result") return false;
  return true;
}

function isSummarizableContextEvent(event: TaskEvent): boolean {
  if (["assistant_delta", "thinking_delta", "conversation_summary_created", "context_overflow_recovered", "prompt_cache_stats", "token_usage_recorded", "project_memory_version_created", "task_title_updated", "task_graph_created", "task_graph_node_started", "tool_started", "tool_progress", "model_empty_response"].includes(event.type)) return false;
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

function buildRollingConversationSummary(task: TaskDetail, events: TaskEvent[]): string {
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
  const blocked = [...task.events].reverse().find((event) => event.type === "plan_step_blocked");
  if (blocked) facts.add(`Latest blocked step: ${truncate(blocked.summary, 160)}`);
  return [...facts];
}

function latestUserEvent(task: TaskDetail): TaskEvent | undefined {
  return [...task.events].reverse().find((event) =>
    (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted
  );
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

async function readMemoryFile(path: string, maxChars: number, fallback = ""): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => fallback);
  return content.trim().slice(0, maxChars);
}

function defaultUserMemoryContent(): string {
  return [
    "# USER.md",
    "",
    "Stable user preferences for SCC. Keep entries short, durable, and broadly useful.",
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
    "- Keep only stable facts that should apply across future SCC tasks.",
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
  return resolve(process.env["SCC_MEMORY_DIR"]?.trim() || resolve(findWorkspaceRoot(), "data", "memory"));
}
