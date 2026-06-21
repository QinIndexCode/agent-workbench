import type { TaskDetail, TaskEvent } from "@agent-workbench/shared";

const READ_ONLY_NO_PROGRESS_RESULT_LIMIT = 4;
const READ_FILE_NO_PROGRESS_REPEAT_LIMIT = 2;
const OTHER_READ_ONLY_NO_PROGRESS_RESULT_LIMIT = 6;
const OTHER_READ_ONLY_NO_PROGRESS_REPEAT_LIMIT = 3;

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
  const readOnlyResults = trailingReadOnlyExplorationResults(events);
  if (readOnlyResults.length < READ_ONLY_NO_PROGRESS_RESULT_LIMIT) return null;

  const counts = new Map<string, number>();
  for (const event of readOnlyResults) {
    const signature = readOnlyExplorationSignature(event);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!repeated) return null;
  const repeatedTarget = repeated[0];
  const repeatedTargetCount = repeated[1];
  const repeatLimit = repeatedTarget.startsWith("read_file:")
    ? READ_FILE_NO_PROGRESS_REPEAT_LIMIT
    : OTHER_READ_ONLY_NO_PROGRESS_REPEAT_LIMIT;
  const resultLimit = repeatedTarget.startsWith("read_file:")
    ? READ_ONLY_NO_PROGRESS_RESULT_LIMIT
    : OTHER_READ_ONLY_NO_PROGRESS_RESULT_LIMIT;
  if (readOnlyResults.length < resultLimit || repeatedTargetCount < repeatLimit) return null;
  return {
    readOnlyToolCount: readOnlyResults.length,
    repeatedTargetCount,
    lastToolNames: [...new Set(readOnlyResults.slice(-8).map((event) => String(event.payload["toolName"] ?? "tool")))],
    repeatedTarget
  };
}

function trailingReadOnlyExplorationResults(events: TaskEvent[]): TaskEvent[] {
  const trailing: TaskEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted || event.type !== "tool_result") continue;
    if (!isReadOnlyExplorationResult(event)) break;
    trailing.push(event);
  }
  return trailing.reverse();
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
  if (toolName === "read_file") return `read_file:${normalizeToolTarget(args["path"])}:${normalizeOptionalLineArg(args["offset"])}:${normalizeOptionalLineArg(args["limit"])}`;
  if (toolName === "list_files") return `list_files:${normalizeToolTarget(args["path"] ?? ".")}`;
  if (toolName === "search_files") return `search_files:${normalizeToolTarget(args["path"] ?? ".")}:${String(args["query"] ?? "").trim().toLowerCase()}`;
  return `${toolName}:${stableStringify(args)}`;
}

function normalizeOptionalLineArg(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(Math.round(number)) : "";
}

function normalizeToolTarget(value: unknown): string {
  return String(value ?? ".").replace(/\\/g, "/").trim().toLowerCase() || ".";
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (nested === undefined ? undefined : nested), 2);
}
