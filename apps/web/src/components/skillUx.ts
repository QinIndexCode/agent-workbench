import type { ReflectionSession, SkillCuratorItem, TaskDetail, TaskEvent } from "@agent-workbench/shared";

export type LoadedSkillEvent = {
  eventId: string;
  title: string;
  skillId: string;
  status: string;
  source: string;
  matchReason: string;
  matchedSignals: string[];
  requiredTools: string[];
  requiredContext: string[];
  readOnlySuggestion: boolean;
};

export type SkippedSkillEvent = {
  eventId: string;
  requested: string;
  reason: string;
  title?: string;
  status?: string;
  source?: string;
  matchedSignals: string[];
};

export function parseLoadedSkillEvent(event: TaskEvent): LoadedSkillEvent | null {
  if (event.type !== "skill_loaded") return null;
  return {
    eventId: event.id,
    title: stringOrFallback(event.payload["title"], "Untitled skill"),
    skillId: stringOrFallback(event.payload["skillId"], event.id),
    status: stringOrFallback(event.payload["status"], "candidate"),
    source: stringOrFallback(event.payload["source"], "manual"),
    matchReason: stringOrFallback(event.payload["matchReason"], "Matched runtime context."),
    matchedSignals: toStringArray(event.payload["matchedSignals"]),
    requiredTools: toStringArray(event.payload["requiredTools"]),
    requiredContext: toStringArray(event.payload["requiredContext"]),
    readOnlySuggestion: event.payload["readOnlySuggestion"] === true
  };
}

export function parseSkippedSkillEvent(event: TaskEvent): SkippedSkillEvent | null {
  if (event.type !== "skill_load_skipped") return null;
  return {
    eventId: event.id,
    requested: stringOrFallback(event.payload["requested"], "Skill"),
    reason: stringOrFallback(event.payload["reason"], "Not loaded for this turn."),
    ...(typeof event.payload["title"] === "string" ? { title: event.payload["title"] } : {}),
    ...(typeof event.payload["status"] === "string" ? { status: event.payload["status"] } : {}),
    ...(typeof event.payload["source"] === "string" ? { source: event.payload["source"] } : {}),
    matchedSignals: toStringArray(event.payload["matchedSignals"])
  };
}

export function summarizeTaskSkills(task: TaskDetail | null): {
  loaded: LoadedSkillEvent[];
  skipped: SkippedSkillEvent[];
} {
  const events = Array.isArray(task?.events) ? task.events : [];
  return {
    loaded: events.map(parseLoadedSkillEvent).filter((item): item is LoadedSkillEvent => Boolean(item)),
    skipped: events.map(parseSkippedSkillEvent).filter((item): item is SkippedSkillEvent => Boolean(item))
  };
}

export function describeSkillStatus(status: string, language?: string | null): string {
  const zh = language === "zh-CN";
  switch (status) {
    case "active":
      return zh ? "已启用" : "Active";
    case "candidate":
      return zh ? "候选" : "Candidate";
    case "suspended":
      return zh ? "已暂停" : "Suspended";
    case "retired":
      return zh ? "已退役" : "Retired";
    case "needs_review":
      return zh ? "待复核" : "Needs review";
    case "not_promoted":
      return zh ? "未晋升" : "Not promoted";
    default:
      return status;
  }
}

export function describeSkillSource(source: string, language?: string | null): string {
  const zh = language === "zh-CN";
  switch (source) {
    case "reflection_pattern":
      return zh ? "来自稳定反思模式" : "From a reflected stable pattern";
    case "task_memory":
      return zh ? "来自成功任务记忆" : "From successful task memory";
    case "manual":
      return zh ? "手工创建" : "Manually created";
    default:
      return source;
  }
}

export function describeReflectionPhase(phase: string, language?: string | null): string {
  const zh = language === "zh-CN";
  const normalized = phase.trim().toLowerCase();
  if (normalized.includes("meta")) return zh ? "整理输入与运行边界" : "Collecting input and runtime boundaries";
  if (normalized.includes("skill") && normalized.includes("promot")) return zh ? "评估是否适合晋升为 Skill" : "Evaluating whether a stable skill should be promoted";
  if (normalized.includes("skill")) return zh ? "提取可复用 Skill 候选" : "Extracting reusable skill candidates";
  if (normalized.includes("memory")) return zh ? "整理任务记忆" : "Structuring task memories";
  if (normalized.includes("wait")) return zh ? "等待更多成功样本" : "Waiting for more successful examples";
  if (normalized.includes("duplicate")) return zh ? "检测重复与冲突" : "Detecting duplicates and conflicts";
  if (normalized.includes("curat")) return zh ? "准备人工复核建议" : "Preparing curator review guidance";
  return phase;
}

export function describeReflectionStatus(status: string, language?: string | null): string {
  const zh = language === "zh-CN";
  switch (status.trim().toLowerCase()) {
    case "running":
      return zh ? "运行中" : "Running";
    case "completed":
      return zh ? "已完成" : "Completed";
    case "partial":
      return zh ? "部分完成" : "Partially completed";
    case "failed":
      return zh ? "失败" : "Failed";
    default:
      return status;
  }
}

export function describeReflectionNextStep(nextStep: string, language?: string | null): string {
  const zh = language === "zh-CN";
  const normalized = nextStep.trim().toLowerCase();
  if (!normalized) return nextStep;
  if (normalized === "skills_promoted") {
    return zh ? "候选 Skill 已生成，接下来去 Curator 里复核或激活。" : "Candidate skills were generated. Review or activate them in Curator next.";
  }
  if (normalized === "wait_for_more_task_memories") {
    return zh ? "还需要更多成功任务样本，暂时不能形成稳定可复用流程。" : "More successful task examples are still needed before this becomes a stable reusable workflow.";
  }
  if (normalized === "observe_more_tasks") {
    return zh ? "继续观察更多成功任务，再判断是否值得晋升。" : "Observe more successful tasks before deciding whether this is worth promoting.";
  }
  if (normalized.includes("duplicate")) {
    return zh ? "先核对是否与现有 Skill 重复或冲突，再决定是否合并。" : "Check for duplicate or conflicting skills before deciding whether to merge.";
  }
  if (normalized.includes("curat")) {
    return zh ? "需要人工复核建议后再决定是否启用。" : "A curator review is needed before deciding whether to enable it.";
  }
  if (normalized.includes("promot")) {
    return zh ? "候选已经形成，接下来确认它是否真的值得晋升。" : "A candidate has formed; the next step is deciding whether it is truly worth promotion.";
  }
  return nextStep;
}

export function summarizeCuratorEvidence(item: SkillCuratorItem, language?: string | null): string[] {
  const zh = language === "zh-CN";
  const lines = [...(Array.isArray(item.evidence) ? item.evidence : [])];
  if (typeof item.sourceTaskCount === "number") {
    lines.unshift(zh ? `来源任务数：${item.sourceTaskCount}` : `Source tasks: ${item.sourceTaskCount}`);
  }
  if (typeof item.successRate === "number") {
    lines.unshift(zh ? `成功率：${Math.round(item.successRate * 100)}%` : `Success rate: ${Math.round(item.successRate * 100)}%`);
  }
  return lines;
}

export function summarizeReflectionSession(reflection: ReflectionSession, language?: string | null): string {
  const phase = describeReflectionPhase(reflection.progress.phase, language);
  const nextStep = reflection.progress.nextStep?.trim();
  if (!nextStep) return phase;
  const describedNextStep = describeReflectionNextStep(nextStep, language);
  return describedNextStep === phase ? phase : `${phase} · ${describedNextStep}`;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean) : [];
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
