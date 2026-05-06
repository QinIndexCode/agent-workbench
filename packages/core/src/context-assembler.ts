import type { SkillRecord, TaskDetail, TaskEvent, ToolCall, UserPreferences } from "@scc/shared";
import { findRelevantSkills } from "./experience.js";
import type { WorkbenchStore } from "./store.js";

export interface TokenBudget {
  maxTotal: number;
  reservedForResponse: number;
}

export interface AssembledContext {
  systemPrompt: string;
  input: string;
  usedTokens: number;
}

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

  constructor(private readonly store: WorkbenchStore) {}

  async assemble(task: TaskDetail, budget?: Partial<TokenBudget>): Promise<AssembledContext> {
    const preferences = await this.store.getPreferences();
    const maxTotal = budget?.maxTotal ?? preferences.maxTokensPerRequest;
    const reservedForResponse = budget?.reservedForResponse ?? Math.min(16000, Math.round(maxTotal * 0.15));
    const tokenBudget = { maxTotal, reservedForResponse };
    const layers: string[] = [];
    let usedTokens = 0;

    const systemLayer = this.buildSystemLayer(preferences);
    layers.push(systemLayer);
    usedTokens += estimateTokens(systemLayer);

    const loadedSkills = this.loadedSkillPrompt(task.id);
    if (loadedSkills) {
      layers.push(loadedSkills);
      usedTokens += estimateTokens(loadedSkills);
    }

    const workingFolderLayer = this.buildWorkingFolderLayer(task);
    layers.push(workingFolderLayer);
    usedTokens += estimateTokens(workingFolderLayer);

    const skillLayer = await this.buildSkillMetaLayer(task, preferences);
    if (skillLayer) {
      layers.push(skillLayer);
      usedTokens += estimateTokens(skillLayer);
    }

    const projectLayer = await this.buildProjectLayer();
    if (projectLayer) {
      layers.push(projectLayer);
      usedTokens += estimateTokens(projectLayer);
    }

    const tracker = this.getFileStateTracker(task.id);
    const fileLayer = tracker.buildFileStateTable();
    const fileTokens = estimateTokens(fileLayer);
    if (fileLayer && usedTokens + fileTokens < tokenBudget.maxTotal * 0.3) {
      layers.push(fileLayer);
      usedTokens += fileTokens;
    }

    const remaining = tokenBudget.maxTotal - usedTokens - tokenBudget.reservedForResponse;
    layers.push(buildHistoryLayer(task, Math.max(1000, remaining), tracker));

    const nonEmpty = layers.filter((layer) => layer.trim().length > 0);
    return {
      systemPrompt: nonEmpty.slice(0, 2).join("\n\n"),
      input: nonEmpty.slice(2).join("\n\n"),
      usedTokens: estimateTokens(nonEmpty.join("\n\n"))
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
  }

  async loadSkill(taskId: string, skillId: string): Promise<SkillRecord | undefined> {
    const session = this.sessionFor(taskId);
    if (session.loadedSkills.has(skillId) || session.loadCount >= 3) return undefined;
    const skill = await this.store.getSkill(skillId);
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

  private async buildSkillMetaLayer(task: TaskDetail, preferences: UserPreferences): Promise<string> {
    if (!preferences.skillAutoInject) return "";
    const skills = findRelevantSkills(task.title, await this.store.listSkills(), preferences.maxInjectedSkills);
    if (skills.length === 0) return "";
    return [
      "## Available Skills",
      "Call use_skill(skillId) only when the skill is directly relevant and you need its full guidance.",
      ...skills.map((skill) => {
        const success = Math.round(skill.stats.successRate * 100);
        return `- ${skill.id}: ${skill.title} (${success}% success)`;
      })
    ].join("\n");
  }

  private buildSystemLayer(preferences: UserPreferences): string {
    const lines = [
      "You are the SCC workbench agent.",
      "Choose the next action yourself based on the user's goal, available tools, permissions, and evidence.",
      "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
      "Scripts, builds, tests, and command output are tool evidence for you to interpret; they are never task-completion judges.",
      "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless the user explicitly asks.",
      "When the user asks what you can do, answer directly from your general capabilities; do not inspect files first.",
      "Do not claim the project name, stack, files, or runtime state until you have verified them with tool evidence.",
      "If you need a file but are unsure it exists, list or search first instead of guessing paths such as README.md.",
      "Keep normal answers concise, calm, and product-like. Avoid decorative emoji, hype, and marketing-style introductions unless the user asks for that tone.",
      "Use Markdown for readable structure when helpful: short headings, bullets, tables, and code blocks are supported."
    ];
    if (preferences.language === "zh-CN") lines.push("Respond in Chinese unless the user asks otherwise.");
    lines.push(`User language preference: ${preferences.language}`);
    lines.push(`Auto approval preference: ${preferences.autoApprove}`);
    return lines.join("\n");
  }

  private buildWorkingFolderLayer(task: TaskDetail): string {
    return [
      "## Current Working Folder",
      `Task folder ID: ${task.folderId || "default"}`,
      `Tool root: ${task.workRoot || "(default workbench root)"}`,
      "Relative file paths and command cwd values are resolved inside this root. Do not assume files outside it are visible."
    ].join("\n");
  }

  private async buildProjectLayer(): Promise<string> {
    const memories = await this.store.listProjectMemories("default");
    if (memories.length === 0) return "";
    return [
      "## Project Context",
      ...memories.slice(0, 5).map((memory) => `### ${memory.title} [${memory.category}]\n${memory.content.slice(0, 1000)}`)
    ].join("\n\n");
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
}

export class FileStateTracker {
  private states = new Map<string, FileState>();
  private readonly maxFiles = 20;
  private readonly maxContentLength = 2000;

  updateFromToolResult(event: TaskEvent): void {
    if (event.type !== "tool_result") return;
    const output = String(event.payload["output"] ?? "");
    if (!output || looksLikeBinary(output)) return;

    const toolName = this.findToolName(event);
    if (toolName === "read_file") {
      const parsed = parseJson(output);
      const path = String(parsed["path"] ?? "");
      const content = String(parsed["content"] ?? "");
      if (path && content) this.set(path, content, event.createdAt, Boolean(parsed["partial"]));
      return;
    }

    if (toolName === "edit_file") {
      const parsed = parseJson(output);
      const path = String(parsed["path"] ?? "");
      if (path) this.set(path, "File edited; read_file for current content before further edits.", event.createdAt, true);
      return;
    }

    const inferred = inferFilePathFromOutput(output);
    if (inferred && looksLikeFileContent(output, inferred)) this.set(inferred, output, event.createdAt, output.length > this.maxContentLength);
  }

  hasFile(path: string): boolean {
    return this.states.has(path);
  }

  buildFileStateTable(): string {
    if (this.states.size === 0) return "";
    const lines = ["## Known Files (do not guess content)"];
    for (const state of this.states.values()) {
      lines.push(`\n### ${state.path}`);
      if (state.isPartial) lines.push("(partial content)");
      lines.push("```");
      lines.push(state.content);
      lines.push("```");
    }
    return lines.join("\n");
  }

  private set(path: string, content: string, lastModified: string, isPartial: boolean): void {
    this.states.set(path, {
      path,
      content: content.slice(0, this.maxContentLength),
      contentHash: hash(content),
      lastModified,
      isPartial: isPartial || content.length > this.maxContentLength
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

export function buildHistoryLayer(task: TaskDetail, maxTokens: number, tracker?: FileStateTracker): string {
  const events = task.events.filter(
    (event) =>
      !["status_changed", "task_created", "task_memory_created", "pattern_discovered", "reflection_completed"].includes(event.type)
  );
  const formatted: string[] = [];
  let usedTokens = 0;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event) continue;
    const text = formatEvent(event, tracker);
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (usedTokens + tokens > maxTokens) {
      formatted.unshift("... (earlier events omitted)");
      break;
    }
    formatted.unshift(text);
    usedTokens += tokens;
  }
  return formatted.join("\n\n");
}

export function formatEvent(event: TaskEvent, tracker?: FileStateTracker): string {
  switch (event.type) {
    case "user_message":
      return `**User**: ${event.summary}`;
    case "assistant_delta":
    case "thinking_delta":
      return "";
    case "assistant_message":
      return `**Agent**: ${event.summary}`;
    case "tool_requested":
      return `**Tool Call**: ${event.payload["toolName"]}(${JSON.stringify(event.payload["args"] ?? {})})`;
    case "tool_result":
      if (tracker && isFileContentInTracker(event, tracker)) {
        return `**Tool Result**: File content recorded in Known Files.`;
      }
      return `**Tool Result**:\n${formatToolOutput(String(event.payload["output"] ?? ""))}`;
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
    default:
      return `**${event.type}**: ${event.summary}`;
  }
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

function isFileContentInTracker(event: TaskEvent, tracker: FileStateTracker): boolean {
  const output = String(event.payload["output"] ?? "");
  const parsed = parseJson(output);
  const path = String(parsed["path"] ?? "");
  return Boolean(path && tracker.hasFile(path));
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

function inferFilePathFromOutput(output: string): string | null {
  for (const line of output.split("\n").slice(0, 20)) {
    const match = line.match(/[\w\-./\\]+\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|md|json|yaml|yml|txt|html|css|scss)[\s:"']/i);
    if (match?.[0]) return match[0].replace(/[\s:"']$/, "");
  }
  return null;
}

function looksLikeFileContent(output: string, inferredPath: string): boolean {
  const extension = inferredPath.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "ts", "jsx", "tsx", "py", "md", "json", "yaml", "yml", "txt", "html", "css"].includes(extension)) return true;
  const printable = [...output].filter((char) => {
    const code = char.charCodeAt(0);
    return (code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13;
  }).length;
  return output.length > 0 && printable > output.length * 0.85;
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
