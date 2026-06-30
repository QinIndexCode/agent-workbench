import type { PromptCacheStats, TaskDetail, TaskEvent, TaskTranscriptItem } from "@agent-workbench/shared";

export function renderValue(value: unknown, json: boolean): string {
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  if (Array.isArray(value)) return renderArray(value);
  if (isTaskDetail(value)) return renderTask(value);
  if (isRecord(value)) return `${renderRecord(value)}\n`;
  return `${String(value ?? "")}\n`;
}

export function renderTask(task: TaskDetail): string {
  const lines = [
    `${task.title}`,
    `id: ${task.id}`,
    `status: ${task.status}`,
    `folder: ${task.folderId ?? "default"}`
  ];
  const pending = task.approvals.filter((approval) => approval.status === "pending");
  if (pending.length > 0) {
    lines.push("");
    lines.push("pending approvals:");
    for (const approval of pending) {
      lines.push(`- ${approval.id} ${approval.riskCategory}: aw task approve ${task.id} ${approval.id} allow-once`);
    }
  }
  const final = latestAssistantMessage(task.events);
  if (final) {
    lines.push("");
    lines.push(final);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTranscript(items: TaskTranscriptItem[], json: boolean): string {
  if (json) return renderValue(items, true);
  return `${items.map((item) => `${item.type}: ${transcriptText(item)}`).join("\n")}\n`;
}

export function renderWatchEvent(event: TaskEvent): string {
  const text = typeof event.payload["text"] === "string" ? event.payload["text"] : "";
  const approvalId = typeof event.payload["approvalId"] === "string" ? event.payload["approvalId"] : "";
  if (event.type === "approval_pending" && approvalId) return `approval pending: ${approvalId}`;
  if (event.type === "token_usage_recorded") return renderTokenUsageEvent(event);
  if (text) return `${event.type}: ${text}`;
  return event.type;
}

function renderArray(values: unknown[]): string {
  if (values.length === 0) return "No records.\n";
  if (!values.every(isRecord)) return `${values.map((item) => String(item)).join("\n")}\n`;
  if (values.every(isPromptCacheStats)) return renderPromptCacheStats(values);
  const columns = ["id", "title", "name", "label", "kind", "riskCategory", "status", "enabled", "updatedAt"].filter((column) =>
    values.some((item) => isScalar(item[column]))
  );
  if (columns.length === 0) return `${values.map((item) => renderRecord(item)).join("\n\n")}\n`;
  const widths = columns.map((column) => Math.max(column.length, ...values.map((item) => printable(item[column]).length)));
  const header = columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
  const rows = values.map((item) => columns.map((column, index) => printable(item[column]).padEnd(widths[index] ?? column.length)).join("  "));
  return `${[header, ...rows].join("\n")}\n`;
}

function renderPromptCacheStats(values: PromptCacheStats[]): string {
  const columns = ["createdAt", "model", "source", "input", "cached", "hit", "rolling", "target"];
  const rows = values.map((item) => ({
    createdAt: shortDateTime(item.createdAt),
    model: item.model,
    source: item.source,
    input: String(item.inputTokens),
    cached: String(item.cachedTokens),
    hit: formatPercent(item.cacheHitRatio),
    rolling: item.rollingCacheHitRatio === undefined ? "" : formatPercent(item.rollingCacheHitRatio),
    target: item.cacheTargetMet === undefined ? "warmup" : item.cacheTargetMet ? "met" : "below"
  }));
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((item) => item[column as keyof typeof item].length)));
  const header = columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
  const renderedRows = rows.map((item) => columns.map((column, index) => item[column as keyof typeof item].padEnd(widths[index] ?? column.length)).join("  "));
  const guidance = values.map((item) =>
    `- ${shortDateTime(item.createdAt)} ${item.model}: ${promptCacheAdvice(item.source, item.cachedTokens, item.cacheHitRatio, item.cacheTargetMet)}`
  );
  return `${[header, ...renderedRows].join("\n")}\n\ncache guidance:\n${guidance.join("\n")}\n`;
}

function renderTokenUsageEvent(event: TaskEvent): string {
  const input = numericPayload(event, "inputTokens");
  const cached = numericPayload(event, "cachedTokens");
  const hit = numericPayload(event, "cacheHitRatio");
  const rolling = numericPayload(event, "rollingCacheHitRatio");
  const target = typeof event.payload["cacheTargetMet"] === "boolean" ? (event.payload["cacheTargetMet"] ? "met" : "below") : "warmup";
  const parts = [
    input === undefined ? undefined : `input=${input}`,
    cached === undefined ? undefined : `cached=${cached}`,
    hit === undefined ? undefined : `hit=${formatPercent(hit)}`,
    rolling === undefined ? undefined : `rolling=${formatPercent(rolling)}`,
    `target=${target}`,
    `next="${promptCacheAdvice(String(event.payload["source"] ?? ""), cached, hit, event.payload["cacheTargetMet"])}"`
  ].filter(Boolean);
  return parts.length > 0 ? `token usage: ${parts.join(" ")}` : `token usage: ${event.summary}`;
}

function promptCacheAdvice(source: string, cachedTokens: number | undefined, hitRatio: number | undefined, targetMet: unknown): string {
  if (source === "local_response") {
    return "local response cache reused the final answer; keep the same model, API base, and tool evidence stable";
  }
  if (targetMet === true) {
    return "cache target met; avoid unnecessary model, API base, and tool-set changes";
  }
  if ((cachedTokens ?? 0) === 0) {
    return "no provider cache hit yet; confirm provider support and keep long prompt prefixes stable";
  }
  if (targetMet === false || (hitRatio !== undefined && hitRatio < 0.9)) {
    return "hit rate is low; stabilize system prompts, knowledge summaries, model, and tools without dropping needed context";
  }
  return "cache is warming; repeated similar task shapes will make the hit rate more representative";
}

function renderRecord(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, item]) => isScalar(item))
    .map(([key, item]) => `${key}: ${printable(item)}`)
    .join("\n");
}

function latestAssistantMessage(events: TaskEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.type !== "assistant_message") continue;
    const text = typeof event.payload["text"] === "string" ? event.payload["text"].trim() : "";
    if (text) return text;
  }
  return null;
}

function transcriptText(item: TaskTranscriptItem): string {
  const text = item.payload["text"];
  if (typeof text === "string") return text;
  const content = item.payload["content"];
  if (typeof content === "string") return content;
  return "";
}

function printable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortDateTime(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function numericPayload(event: TaskEvent, key: string): number | undefined {
  const value = event.payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function isPromptCacheStats(value: Record<string, unknown>): value is PromptCacheStats {
  return typeof value["model"] === "string" &&
    typeof value["source"] === "string" &&
    typeof value["inputTokens"] === "number" &&
    typeof value["cachedTokens"] === "number" &&
    typeof value["cacheHitRatio"] === "number";
}

function isScalar(value: unknown): boolean {
  return value === undefined || value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isTaskDetail(value: unknown): value is TaskDetail {
  return isRecord(value) && typeof value["id"] === "string" && Array.isArray(value["events"]) && Array.isArray(value["approvals"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
