import { SkillRecordSchema, type ExperienceRecord, type PatternRecord, type ReflectionSession, type SkillConflict, type SkillDuplicateGroup, type SkillRecord, type TaskDetail, type TaskMemory } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export function createTaskMemory(task: TaskDetail): TaskMemory {
  const userGoal = latestMeaningfulUserGoal(task) ?? "Untitled task";
  const assistantResult = [...task.events].reverse().find((event) => event.type === "assistant_message")?.summary ?? "";
  const toolEvents = task.events.filter((event) => event.type === "tool_requested");
  const resultEvents = task.events.filter((event) => event.type === "tool_result");
  const toolsUsed = toolEvents.map((event) => {
    const toolCallId = String(event.payload["toolCallId"] ?? "");
    const result = resultEvents.find((item) => item.payload["toolCallId"] === toolCallId);
    return {
      toolName: String(event.payload["toolName"] ?? event.summary),
      args: asRecord(event.payload["args"]),
      result: String(result?.payload["output"] ?? ""),
      riskCategory: riskOf(event)
    };
  });
  const domains = inferDomains(toolsUsed.map((tool) => tool.toolName).join(" "), userGoal);
  const created = new Date(task.createdAt).getTime();
  const updated = new Date(task.updatedAt).getTime();

  return {
    id: createId("memory"),
    taskId: task.id,
    title: taskMemoryTitle(userGoal),
    goal: sanitizeSensitiveText(userGoal),
    toolsUsed,
    result: sanitizeSensitiveText(assistantResult),
    assessment: {
      goalAchieved: task.status === "completed",
      confidence: task.status === "completed" ? 0.8 : 0.35,
      issues: task.status === "completed" ? [] : [`Task ended as ${task.status}`],
      learnings: toolsUsed.length > 0 ? [`Used ${toolsUsed.map((tool) => tool.toolName).join(", ")} as evidence.`] : [],
      suggestedPatterns: domains
    },
    meta: {
      outcome: task.status === "completed" ? "success" : task.status === "failed" || task.status === "cancelled" ? "failure" : "partial",
      complexity: toolsUsed.length <= 2 ? "simple" : toolsUsed.length <= 5 ? "medium" : "complex",
      domains,
      tools: [...new Set(toolsUsed.map((tool) => tool.toolName))],
      hasSideEffects: toolsUsed.some((tool) => tool.riskCategory === "workspace_write" || tool.riskCategory === "destructive"),
      duration: Math.max(0, Math.round((updated - created) / 1000))
    },
    reflectionCount: 0,
    reflectionStatus: "pending",
    createdAt: nowIso()
  };
}

function latestMeaningfulUserGoal(task: TaskDetail): string | undefined {
  return [...task.events]
    .reverse()
    .filter((event) => (event.type === "user_message" || event.type === "guidance_consumed" || event.type === "guidance_pending") && !event.reverted)
    .map((event) => event.summary.trim())
    .find(Boolean);
}

function taskMemoryTitle(goal: string): string {
  const title = sanitizeSensitiveText(goal.split(/\r?\n/, 1)[0]?.trim() || "Untitled task");
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

export function createExperience(task: TaskDetail): ExperienceRecord {
  const memory = createTaskMemory(task);
  const canBecomeReadOnlySkill = !memory.meta.hasSideEffects && memory.toolsUsed.length > 0 && memory.assessment.goalAchieved;
  return {
    ...memory,
    body: [
      `Goal: ${memory.goal}`,
      memory.toolsUsed.length > 0 ? `Tools: ${memory.toolsUsed.map((tool) => tool.toolName).join(", ")}` : "Tools: none",
      `Result: ${memory.result}`
    ].join("\n"),
    readOnly: canBecomeReadOnlySkill
  };
}

export function reflectMemories(memories: TaskMemory[], existingPatterns: PatternRecord[] = []): {
  session: ReflectionSession;
  patterns: PatternRecord[];
  promotedSkills: SkillRecord[];
} {
  const started = nowIso();
  const pending = memories.filter((memory) => memory.reflectionStatus === "pending");
  const session: ReflectionSession = {
    id: createId("reflection"),
    status: "completed",
    progress: { phase: "meta", completedDomains: [], nextStep: "wait_for_more_task_memories" },
    tokenUsed: 0,
    budget: 16000,
    createdAt: started,
    completedAt: nowIso()
  };

  if (memories.length < 5) {
    return { session, patterns: [], promotedSkills: [] };
  }

  const domains = groupByDomain(pending.length > 0 ? pending : memories);
  session.progress.completedDomains = [...domains.keys()].slice(0, 2);
  if (memories.length < 10) {
    session.progress.phase = "meta";
    return { session, patterns: [], promotedSkills: [] };
  }

  session.progress.phase = "domain";
  const patterns: PatternRecord[] = [];
  for (const [domain, group] of domains) {
    if (group.length < 3) continue;
    const pattern = createPattern(domain, group);
    const existing = existingPatterns.find((item) => item.title === pattern.title);
    patterns.push(existing ? mergePattern(existing, pattern) : pattern);
  }

  session.progress.phase = "skill";
  const promotedSkills = patterns.filter(shouldPromoteToSkill).map(promotePatternToSkill);
  session.progress.nextStep = promotedSkills.length > 0 ? "skills_promoted" : "observe_more_tasks";
  return { session, patterns, promotedSkills };
}

export function shouldPromoteToSkill(pattern: PatternRecord): boolean {
  const total = pattern.successCount + pattern.failureCount;
  if (pattern.sourceTaskCount < 5) return false;
  if (total < 5) return false;
  if (pattern.successCount / total < 0.75) return false;
  if (pattern.status !== "stable") return false;
  if (pattern.content.toolSequence.length < 2) return false;
  return pattern.confidence >= 0.8;
}

export function promotePatternToSkill(pattern: PatternRecord): SkillRecord {
  const now = nowIso();
  return {
    id: createId("skill"),
    sourcePatternId: pattern.id,
    sourceMemoryIds: [],
    title: pattern.title,
    body: [
      `# ${pattern.title}`,
      "",
      "## When to use",
      pattern.description,
      "",
      "## Approach",
      pattern.content.approach,
      "",
      "## Tool sequence",
      pattern.content.toolSequence.map((tool, index) => `${index + 1}. ${tool}`).join("\n"),
      "",
      "## Cautions",
      pattern.content.cautions.map((caution) => `- ${caution}`).join("\n")
    ].join("\n"),
    applicability: {
      description: pattern.description,
      requiredTools: pattern.trigger.requiredTools,
      requiredContext: pattern.trigger.domainHints,
      exclusions: ["Do not use when the task goal conflicts with this pattern."],
      minConfidence: pattern.confidence,
      keywords: pattern.trigger.keywords
    },
    stats: {
      totalUses: 0,
      successUses: 0,
      failureUses: 0,
      successRate: pattern.successCount / Math.max(1, pattern.successCount + pattern.failureCount),
      consecutiveFailures: 0
    },
    version: 1,
    corrections: [],
    status: "candidate",
    relatedPatterns: [pattern.id],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  };
}

export function promoteExperience(experience: ExperienceRecord): SkillRecord {
  const now = nowIso();
  return {
    id: createId("skill"),
    sourceMemoryIds: [experience.id],
    title: experience.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Recorded workflow",
    body: [
      `# ${experience.title}`,
      "",
      "## When to use",
      "Use this only when a future task clearly matches the goal, evidence type, and tool constraints below.",
      "",
      "## Reusable approach",
      "- Restate the current user goal before choosing tools.",
      experience.meta.tools.length > 0
        ? `- Prefer fresh evidence from: ${experience.meta.tools.join(", ")}.`
        : "- Choose the minimum tools needed for fresh evidence.",
      "- Run the tools against the current task state; never reuse historical outputs.",
      "- Summarize only the new evidence observed in the current run.",
      "",
      "## Tool constraints",
      experience.readOnly
        ? "- The source pattern was read-only; keep it read-only unless the user explicitly asks for changes."
        : "- The source pattern involved side effects; keep this skill as candidate until a user reviews it.",
      "",
      "## Exclusions",
      "- Do not apply this skill to a task that only shares superficial keywords.",
      "- Do not include one-off command output, machine state, or prior task results in the answer."
    ].join("\n"),
    applicability: {
      description: `Tasks similar to: ${experience.title}`,
      requiredTools: experience.meta.tools,
      requiredContext: experience.meta.domains,
      exclusions: ["Do not apply if the user goal differs materially from the recorded workflow."],
      minConfidence: experience.assessment.confidence,
      keywords: tokenize(experience.title)
    },
    stats: {
      totalUses: 0,
      successUses: 0,
      failureUses: 0,
      successRate: experience.assessment.goalAchieved ? 1 : 0,
      consecutiveFailures: 0
    },
    version: 1,
    corrections: [],
    status: "candidate",
    relatedPatterns: [],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  };
}

export function normalizeSkillRecord(input: unknown): SkillRecord {
  const parsed = SkillRecordSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const raw = asRecord(input);
  const now = nowIso();
  const title = stringValue(raw["title"], "Recorded workflow").replace(/\s+/g, " ").trim().slice(0, 120) || "Recorded workflow";
  const body = stringValue(raw["body"], [`# ${title}`, "", "Legacy skill record normalized for the SCC workbench."].join("\n"));
  const applicability = asRecord(raw["applicability"]);
  const stats = asRecord(raw["stats"]);
  const keywords = normalizeKeywordList(stringArray(applicability["keywords"], stringArray(raw["keywords"], tokenize(title))), title);
  const requiredTools = stringArray(applicability["requiredTools"], stringArray(raw["requiredTools"], []));
  const requiredContext = stringArray(applicability["requiredContext"], stringArray(raw["requiredContext"], []));
  const status = normalizeSkillStatus(raw["status"]);
  const createdAt = stringValue(raw["createdAt"], now);
  const updatedAt = stringValue(raw["updatedAt"], createdAt);
  const totalUses = numberValue(stats["totalUses"], 0);
  const successUses = numberValue(stats["successUses"], 0);
  const failureUses = numberValue(stats["failureUses"], 0);

  return {
    id: stringValue(raw["id"], createId("skill")),
    ...(typeof raw["sourcePatternId"] === "string" ? { sourcePatternId: raw["sourcePatternId"] } : {}),
    sourceMemoryIds: stringArray(raw["sourceMemoryIds"], []),
    title,
    body,
    applicability: {
      description: stringValue(applicability["description"], `Tasks similar to: ${title}`),
      requiredTools,
      requiredContext,
      exclusions: stringArray(applicability["exclusions"], ["Do not apply if the current task goal materially differs."]),
      minConfidence: clamp(numberValue(applicability["minConfidence"], 0.5), 0, 1),
      keywords
    },
    stats: {
      totalUses,
      successUses,
      failureUses,
      successRate: clamp(numberValue(stats["successRate"], totalUses > 0 ? successUses / Math.max(1, totalUses) : 0), 0, 1),
      ...(typeof stats["lastFailureAt"] === "string" ? { lastFailureAt: stats["lastFailureAt"] } : {}),
      consecutiveFailures: Math.max(0, Math.round(numberValue(stats["consecutiveFailures"], 0)))
    },
    version: Math.max(1, Math.round(numberValue(raw["version"], 1))),
    corrections: Array.isArray(raw["corrections"]) ? raw["corrections"].filter((item) => typeof item === "object") as SkillRecord["corrections"] : [],
    status,
    relatedPatterns: stringArray(raw["relatedPatterns"], []),
    createdAt,
    lastUsedAt: stringValue(raw["lastUsedAt"], updatedAt),
    updatedAt
  };
}

export function shouldPromoteExperienceToSkill(experience: ExperienceRecord): boolean {
  if (!experience.readOnly) return false;
  if (!experience.assessment.goalAchieved || experience.assessment.confidence < 0.85) return false;
  if (experience.toolsUsed.length < 2) return false;
  if (experience.meta.complexity === "simple") return false;
  if (experience.assessment.suggestedPatterns.length === 0) return false;
  if (experience.meta.outcome !== "success") return false;
  if (isLowValueSkillResult(experience.result) || isLowValueSkillResult(experience.body)) return false;
  if (isOneOffLikeText(experience.goal) || isOneOffLikeText(experience.result) || isOneOffLikeText(experience.body)) return false;
  return true;
}

export function skillFingerprint(skill: SkillRecord): string {
  const normalized = normalizeSkillRecord(skill);
  const titleTokens = tokenize(normalized.title).filter((token) => token.length > 1 || /[\u4e00-\u9fa5]/.test(token));
  const keywords = normalized.applicability.keywords
    .flatMap(tokenize)
    .filter((token) => token.length > 1 || /[\u4e00-\u9fa5]/.test(token));
  const requiredTools = stableTokens(normalized.applicability.requiredTools.flatMap(tokenize)).slice(0, 12);
  const requiredContext = stableTokens(normalized.applicability.requiredContext.flatMap(tokenize)).slice(0, 12);
  const exclusions = stableTokens(normalized.applicability.exclusions.flatMap(tokenize)).slice(0, 12);
  return JSON.stringify({
    title: stableTokens(titleTokens).slice(0, 18),
    keywords: stableTokens(keywords).slice(0, 24),
    requiredTools,
    requiredContext,
    exclusions,
    bodyShape: normalizedBodyShape(normalized.body)
  });
}

export function listSkillDuplicateGroups(skills: SkillRecord[]): SkillDuplicateGroup[] {
  const groups = new Map<string, SkillRecord[]>();
  for (const skill of skills.map(normalizeSkillRecord)) {
    const fingerprint = skillFingerprint(skill);
    const group = groups.get(fingerprint) ?? [];
    group.push(skill);
    groups.set(fingerprint, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fingerprint, group]) => {
      const sorted = [...group].sort(compareCanonicalSkill);
      return {
        fingerprint,
        canonicalSkillId: sorted[0]!.id,
        reason: "Same normalized goal, tool sequence, required context, exclusions, and body structure.",
        skills: sorted
      };
    });
}

export function findDuplicateSkill(skill: SkillRecord, existingSkills: SkillRecord[]): SkillRecord | undefined {
  const fingerprint = skillFingerprint(skill);
  return existingSkills.map(normalizeSkillRecord).find((existing) => existing.id !== skill.id && skillFingerprint(existing) === fingerprint);
}

export function mergeSkillRecords(target: SkillRecord, source: SkillRecord): SkillRecord {
  const left = normalizeSkillRecord(target);
  const right = normalizeSkillRecord(source);
  const totalUses = left.stats.totalUses + right.stats.totalUses;
  const successUses = left.stats.successUses + right.stats.successUses;
  const failureUses = left.stats.failureUses + right.stats.failureUses;
  const successRate = totalUses > 0 ? successUses / Math.max(1, totalUses) : Math.max(left.stats.successRate, right.stats.successRate);
  const now = nowIso();
  return {
    ...left,
    title: chooseLonger(left.title, right.title).slice(0, 120),
    body: chooseLongerMeaningful(left.body, right.body),
    applicability: {
      description: chooseLonger(left.applicability.description, right.applicability.description),
      requiredTools: uniqueStrings([...left.applicability.requiredTools, ...right.applicability.requiredTools]),
      requiredContext: uniqueStrings([...left.applicability.requiredContext, ...right.applicability.requiredContext]),
      exclusions: uniqueStrings([...left.applicability.exclusions, ...right.applicability.exclusions]),
      minConfidence: Math.max(left.applicability.minConfidence, right.applicability.minConfidence),
      keywords: normalizeKeywordList([...left.applicability.keywords, ...right.applicability.keywords], left.title)
    },
    stats: {
      ...left.stats,
      totalUses,
      successUses,
      failureUses,
      successRate,
      consecutiveFailures: Math.max(left.stats.consecutiveFailures, right.stats.consecutiveFailures),
      ...(left.stats.lastFailureAt || right.stats.lastFailureAt
        ? { lastFailureAt: [left.stats.lastFailureAt, right.stats.lastFailureAt].filter(Boolean).sort().at(-1)! }
        : {})
    },
    sourceMemoryIds: uniqueStrings([...left.sourceMemoryIds, ...right.sourceMemoryIds]),
    relatedPatterns: uniqueStrings([...left.relatedPatterns, ...right.relatedPatterns]),
    corrections: [...left.corrections, ...right.corrections].slice(-20),
    status: chooseSkillStatus(left.status, right.status),
    version: Math.max(left.version, right.version) + 1,
    lastUsedAt: [left.lastUsedAt, right.lastUsedAt].sort().at(-1) ?? now,
    updatedAt: now
  };
}

export function detectSkillConflicts(skill: SkillRecord, existingSkills: SkillRecord[]): SkillConflict[] {
  const conflicts: SkillConflict[] = [];
  const normalizedSkill = normalizeSkillRecord(skill);
  for (const candidate of existingSkills) {
    const existing = normalizeSkillRecord(candidate);
    if (existing.id === normalizedSkill.id || existing.status === "retired") continue;
    if (skillFingerprint(existing) === skillFingerprint(normalizedSkill)) continue;
    const sharedKeywords = intersection(new Set(normalizedSkill.applicability.keywords), new Set(existing.applicability.keywords));
    const toolMismatch =
      normalizedSkill.applicability.requiredTools.length > 0 &&
      existing.applicability.requiredTools.length > 0 &&
      intersection(new Set(normalizedSkill.applicability.requiredTools), new Set(existing.applicability.requiredTools)).length === 0;
    if (sharedKeywords.length < 2 || !toolMismatch) continue;
    const now = nowIso();
    conflicts.push({
      id: createId("skill_conflict"),
      skillIds: [existing.id, normalizedSkill.id],
      reason: `Similar triggers (${sharedKeywords.slice(0, 5).join(", ")}) use different tool sequences.`,
      severity: sharedKeywords.length >= 4 ? "high" : "medium",
      status: "open",
      createdAt: now,
      updatedAt: now
    });
  }
  return conflicts;
}

export function exportSkill(skill: SkillRecord): { markdown: string; manifest: Record<string, unknown> } {
  return {
    markdown: skill.body,
    manifest: {
      id: skill.id,
      title: skill.title,
      status: skill.status,
      version: skill.version,
      applicability: skill.applicability,
      stats: skill.stats,
      sourceMemoryIds: skill.sourceMemoryIds,
      sourcePatternId: skill.sourcePatternId,
      exportedAt: nowIso()
    }
  };
}

export function tokenize(text: string): string[] {
  const words = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1) words.add(word);
  }
  const chars = text.match(/[\u4e00-\u9fa5]/g) ?? [];
  if (chars.length > 1 && chars.length <= 8) words.add(chars.join(""));
  for (let index = 0; index < chars.length - 1; index++) {
    const first = chars[index];
    const second = chars[index + 1];
    if (first && second) words.add(first + second);
  }
  for (let index = 0; index < chars.length - 2; index++) {
    const first = chars[index];
    const second = chars[index + 1];
    const third = chars[index + 2];
    if (first && second && third) words.add(first + second + third);
  }
  return [...words];
}

function createPattern(domain: string, memories: TaskMemory[]): PatternRecord {
  const now = nowIso();
  const successCount = memories.filter((memory) => memory.meta.outcome === "success").length;
  const failureCount = memories.filter((memory) => memory.meta.outcome === "failure").length;
  const tools = mostCommon(memories.flatMap((memory) => memory.meta.tools));
  const status = memories.length >= 3 && successCount / Math.max(1, memories.length) >= 0.6 ? "stable" : "forming";
  return {
    id: createId("pattern"),
    title: `${domain} workflow pattern`,
    description: `Observed repeatable workflow for ${domain} tasks.`,
    trigger: {
      keywords: [...new Set(memories.flatMap((memory) => tokenize(memory.title)).slice(0, 20))],
      requiredTools: tools,
      domainHints: [domain]
    },
    content: {
      approach: `Start from the user goal, choose the minimum evidence-gathering tools, then answer from observed results.`,
      toolSequence: tools,
      cautions: ["Do not invent environment, file, or command results.", "Ask for approval when a risk category is not already allowed."],
      commonMistakes: ["Applying the pattern when the goal only shares superficial keywords."]
    },
    sourceTaskCount: memories.length,
    successCount,
    failureCount,
    status,
    confidence: Math.min(0.95, 0.45 + memories.length * 0.06 + successCount * 0.04),
    relatedSkills: [],
    createdAt: now,
    lastValidatedAt: now
  };
}

function mergePattern(existing: PatternRecord, next: PatternRecord): PatternRecord {
  return {
    ...next,
    id: existing.id,
    relatedSkills: existing.relatedSkills,
    createdAt: existing.createdAt,
    sourceTaskCount: Math.max(existing.sourceTaskCount, next.sourceTaskCount),
    successCount: Math.max(existing.successCount, next.successCount),
    failureCount: Math.max(existing.failureCount, next.failureCount)
  };
}

function groupByDomain(memories: TaskMemory[]): Map<string, TaskMemory[]> {
  const groups = new Map<string, TaskMemory[]>();
  for (const memory of memories) {
    const domain = memory.meta.domains[0] ?? "general";
    const group = groups.get(domain) ?? [];
    group.push(memory);
    groups.set(domain, group);
  }
  return groups;
}

function mostCommon(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value]) => value);
}

function normalizeSkillStatus(value: unknown): SkillRecord["status"] {
  if (value === "active" || value === "candidate" || value === "suspended" || value === "retired") return value;
  if (value === "enabled") return "active";
  if (value === "disabled") return "suspended";
  return "candidate";
}

function isLowValueSkillResult(value: string): boolean {
  return /could not be loaded|model provider failed|no provider is configured|tool failed|command failed|unable to check|missing capability|i can help|let me know|done\b|completed\b/i.test(value);
}

function isOneOffLikeText(value: string): boolean {
  return /current machine|当前机器|single run|one-off|一次性|prior task result|临时|temp|tmp|session token|localhost|127\.0\.0\.1|created scc task/i.test(value);
}

function normalizedBodyShape(value: string): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return `heading:${line.replace(/^#{1,6}\s*/, "").toLowerCase()}`;
      if (/^\d+\.\s/.test(line)) return "ordered-step";
      if (/^-\s/.test(line)) return "bullet-step";
      return tokenize(line).slice(0, 4).join("_");
    });
  return stableTokens(lines);
}

function compareCanonicalSkill(left: SkillRecord, right: SkillRecord): number {
  const statusRank: Record<SkillRecord["status"], number> = { active: 0, candidate: 1, suspended: 2, retired: 3 };
  const status = statusRank[left.status] - statusRank[right.status];
  if (status !== 0) return status;
  const leftCompleteness = left.body.length + left.applicability.keywords.length * 10 + left.applicability.requiredTools.length * 20;
  const rightCompleteness = right.body.length + right.applicability.keywords.length * 10 + right.applicability.requiredTools.length * 20;
  if (leftCompleteness !== rightCompleteness) return rightCompleteness - leftCompleteness;
  return left.createdAt.localeCompare(right.createdAt);
}

function chooseSkillStatus(left: SkillRecord["status"], right: SkillRecord["status"]): SkillRecord["status"] {
  const rank: Record<SkillRecord["status"], number> = { active: 4, candidate: 3, suspended: 2, retired: 1 };
  return rank[left] >= rank[right] ? left : right;
}

function chooseLonger(left: string, right: string): string {
  return right.length > left.length ? right : left;
}

function chooseLongerMeaningful(left: string, right: string): string {
  if (isLowValueSkillResult(left) && !isLowValueSkillResult(right)) return right;
  if (isLowValueSkillResult(right) && !isLowValueSkillResult(left)) return left;
  return chooseLonger(left, right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeKeywordList(values: string[], fallbackText: string): string[] {
  const expanded = values.flatMap((value) => tokenize(value));
  const cleaned = expanded.filter((value) => value.length > 1 || /^[a-z0-9_-]{2,}$/i.test(value));
  const fallback = tokenize(fallbackText).filter((value) => value.length > 1);
  return uniqueStrings(cleaned.length > 0 ? cleaned : fallback).slice(0, 32);
}

function stableTokens(values: string[]): string[] {
  return uniqueStrings(values.map((value) => value.toLowerCase())).sort();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const next = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return next.length > 0 ? uniqueStrings(next) : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intersection<T>(left: Set<T>, right: Set<T>): T[] {
  return [...left].filter((value) => right.has(value));
}

function inferDomains(toolText: string, goal: string): string[] {
  const text = `${toolText} ${goal}`.toLowerCase();
  const domains: string[] = [];
  if (/git|merge|commit|branch/.test(text)) domains.push("git");
  if (/test|vitest|jest|playwright|coverage/.test(text)) domains.push("testing");
  if (/process|cpu|memory|进程|性能|占用|软件/.test(text)) domains.push("host_observation");
  if (/file|read|edit|search|文件|代码/.test(text)) domains.push("workspace");
  return domains.length > 0 ? [...new Set(domains)] : ["general"];
}

function riskOf(event: { payload: Record<string, unknown> }): TaskMemory["toolsUsed"][number]["riskCategory"] {
  const value = String(event.payload["riskCategory"] ?? "shell");
  if (["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"].includes(value)) {
    return value as TaskMemory["toolsUsed"][number]["riskCategory"];
  }
  return "shell";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function sanitizeSensitiveText(input: string): string {
  return input
    .replace(/(password|pwd|secret|token|key)\s*[=:]\s*\S+/gi, "$1=***")
    .replace(/\b(sk|ak)-[a-zA-Z0-9_-]{10,}\b/g, "***")
    .replace(/C:\\Users\\[^\\\s]+/g, "C:\\Users\\$USER")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "***@***.***");
}
