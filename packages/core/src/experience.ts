import type { ExperienceRecord, PatternRecord, ReflectionSession, SkillConflict, SkillRecord, TaskDetail, TaskMemory } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export function createTaskMemory(task: TaskDetail): TaskMemory {
  const userGoal = task.events.find((event) => event.type === "user_message")?.summary ?? task.title;
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
    title: task.title,
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
    status: "active",
    relatedPatterns: [pattern.id],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  };
}

export function promoteExperience(experience: ExperienceRecord): SkillRecord {
  const now = nowIso();
  const canAutoActivate =
    experience.readOnly &&
    experience.assessment.goalAchieved &&
    experience.toolsUsed.length > 0 &&
    !/could not be loaded|model provider failed|no provider is configured/i.test(experience.result);
  return {
    id: createId("skill"),
    sourceMemoryIds: [experience.id],
    title: experience.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Recorded workflow",
    body: [
      `# ${experience.title}`,
      "",
      "## When to use",
      "Use this only when a future task clearly matches this recorded workflow.",
      "",
      "## Experience",
      experience.body,
      "",
      "## Safety",
      experience.readOnly
        ? "This skill can be active because the source task only used read-only evidence."
        : "This skill remains candidate because the source task involved side effects."
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
    status: canAutoActivate ? "active" : "candidate",
    relatedPatterns: [],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  };
}

export function findRelevantSkills(taskTitle: string, skills: SkillRecord[], limit = 3): SkillRecord[] {
  return skills
    .filter(
      (skill) =>
        skill.status === "active" &&
        skill.stats.successRate >= 0.6 &&
        skill.body.length > 20 &&
        !/could not be loaded|model provider failed|no provider is configured/i.test(skill.body)
    )
    .map((skill) => ({ skill, relevance: calculateRelevance(taskTitle, skill) }))
    .filter((item) => item.relevance > 0.3)
    .sort((a, b) => compositeScore(b.skill, b.relevance) - compositeScore(a.skill, a.relevance))
    .slice(0, limit)
    .map((item) => item.skill);
}

export function detectSkillConflicts(skill: SkillRecord, existingSkills: SkillRecord[]): SkillConflict[] {
  const conflicts: SkillConflict[] = [];
  for (const existing of existingSkills) {
    if (existing.id === skill.id || existing.status === "retired") continue;
    const sharedKeywords = intersection(new Set(skill.applicability.keywords), new Set(existing.applicability.keywords));
    const toolMismatch =
      skill.applicability.requiredTools.length > 0 &&
      existing.applicability.requiredTools.length > 0 &&
      intersection(new Set(skill.applicability.requiredTools), new Set(existing.applicability.requiredTools)).length === 0;
    if (sharedKeywords.length < 2 || !toolMismatch) continue;
    const now = nowIso();
    conflicts.push({
      id: createId("skill_conflict"),
      skillIds: [existing.id, skill.id],
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

export function calculateRelevance(taskTitle: string, skill: SkillRecord): number {
  const titleWords = new Set(tokenize(taskTitle));
  const keywordWords = new Set(skill.applicability.keywords.flatMap(tokenize));
  const intersection = [...titleWords].filter((word) => keywordWords.has(word)).length;
  const union = new Set([...titleWords, ...keywordWords]).size;
  const keywordScore = union > 0 ? intersection / union : 0;
  const title = taskTitle.toLowerCase();
  const domainScore = skill.applicability.requiredContext.some((context) => title.includes(context.toLowerCase())) ? 0.3 : 0;
  const toolScore = skill.applicability.requiredTools.some((tool) => title.includes(tool.toLowerCase())) ? 0.2 : 0;
  const exactScore = skill.applicability.keywords.some((keyword) => title.includes(keyword.toLowerCase())) ? 0.2 : 0;
  return Math.min(1, keywordScore + domainScore + toolScore + exactScore);
}

export function tokenize(text: string): string[] {
  const words = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) words.add(word);
  const chars = text.match(/[\u4e00-\u9fa5]/g) ?? [];
  for (const char of chars) words.add(char);
  for (let index = 0; index < chars.length - 1; index++) {
    const first = chars[index];
    const second = chars[index + 1];
    if (first && second) words.add(first + second);
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

function compositeScore(skill: SkillRecord, relevance: number): number {
  const daysSinceUse = (Date.now() - new Date(skill.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.max(0.5, 1 - daysSinceUse / 60);
  return relevance * (0.4 + 0.4 * skill.stats.successRate + 0.2 * recency);
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
    .replace(/\b(sk|ak)-[a-zA-Z0-9_\-]{10,}\b/g, "***")
    .replace(/C:\\Users\\[^\\\s]+/g, "C:\\Users\\$USER")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "***@***.***");
}
