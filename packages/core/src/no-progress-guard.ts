import type { TaskDetail, TaskEvent } from "@agent-workbench/shared";

const READ_ONLY_NO_PROGRESS_RESULT_LIMIT = 16;
const READ_ONLY_NO_PROGRESS_REPEAT_LIMIT = 8;

export interface ReadOnlyNoProgressAssessment {
  readOnlyToolCount: number;
  repeatedTargetCount: number;
  lastToolNames: string[];
  repeatedTarget: string;
}

export function assessReadOnlyNoProgress(task: TaskDetail): ReadOnlyNoProgressAssessment | null {
  const turnStartIndex = findLatestTurnStartIndex(task.events);
  const events = task.events.slice(turnStartIndex);
  if (events.some((event) => event.type === "assistant_message" && !event.reverted)) return null;
  const toolResults = events.filter((event) => event.type === "tool_result" && !event.reverted);
  if (toolResults.length < READ_ONLY_NO_PROGRESS_RESULT_LIMIT) return null;
  const readOnlyResults = toolResults.filter(isReadOnlyExplorationResult);
  if (readOnlyResults.length < READ_ONLY_NO_PROGRESS_RESULT_LIMIT) return null;
  if (readOnlyResults.length !== toolResults.length) return null;

  const counts = new Map<string, number>();
  for (const event of readOnlyResults) {
    const signature = readOnlyExplorationSignature(event);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!repeated || repeated[1] < READ_ONLY_NO_PROGRESS_REPEAT_LIMIT) return null;
  return {
    readOnlyToolCount: readOnlyResults.length,
    repeatedTargetCount: repeated[1],
    lastToolNames: [...new Set(readOnlyResults.slice(-8).map((event) => String(event.payload["toolName"] ?? "tool")))],
    repeatedTarget: repeated[0]
  };
}

function findLatestTurnStartIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type === "user_message" || event.type === "guidance_consumed" || event.type === "guidance_pending") return index;
  }
  return 0;
}

function isReadOnlyExplorationResult(event: TaskEvent): boolean {
  const toolName = String(event.payload["toolName"] ?? "");
  return toolName === "read_file" || toolName === "search_files" || toolName === "list_files";
}

function readOnlyExplorationSignature(event: TaskEvent): string {
  const toolName = String(event.payload["toolName"] ?? "tool");
  const args = event.payload["args"] && typeof event.payload["args"] === "object"
    ? (event.payload["args"] as Record<string, unknown>)
    : {};
  if (toolName === "read_file") return `read_file:${normalizeToolTarget(args["path"])}`;
  if (toolName === "list_files") return `list_files:${normalizeToolTarget(args["path"] ?? ".")}`;
  if (toolName === "search_files") return `search_files:${normalizeToolTarget(args["path"] ?? ".")}:${String(args["query"] ?? "").trim().toLowerCase()}`;
  return `${toolName}:${stableStringify(args)}`;
}

function normalizeToolTarget(value: unknown): string {
  return String(value ?? ".").replace(/\\/g, "/").trim().toLowerCase() || ".";
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (nested === undefined ? undefined : nested), 2);
}
