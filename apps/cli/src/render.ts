import type { TaskDetail, TaskEvent, TaskTranscriptItem } from "@agent-workbench/shared";

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
  if (text) return `${event.type}: ${text}`;
  return event.type;
}

function renderArray(values: unknown[]): string {
  if (values.length === 0) return "No records.\n";
  if (!values.every(isRecord)) return `${values.map((item) => String(item)).join("\n")}\n`;
  const columns = ["id", "title", "name", "label", "kind", "riskCategory", "status", "enabled", "updatedAt"].filter((column) =>
    values.some((item) => isScalar(item[column]))
  );
  if (columns.length === 0) return `${values.map((item) => renderRecord(item)).join("\n\n")}\n`;
  const widths = columns.map((column) => Math.max(column.length, ...values.map((item) => printable(item[column]).length)));
  const header = columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
  const rows = values.map((item) => columns.map((column, index) => printable(item[column]).padEnd(widths[index] ?? column.length)).join("  "));
  return `${[header, ...rows].join("\n")}\n`;
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

function isScalar(value: unknown): boolean {
  return value === undefined || value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isTaskDetail(value: unknown): value is TaskDetail {
  return isRecord(value) && typeof value["id"] === "string" && Array.isArray(value["events"]) && Array.isArray(value["approvals"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
