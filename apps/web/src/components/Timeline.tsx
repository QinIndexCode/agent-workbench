import { useMemo } from "react";
import type { ApprovalDecision, TaskDetail, TaskEvent, ToolApproval } from "@scc/shared";
import { ApprovalCard } from "./ApprovalCard.js";
import { MarkdownText } from "./MarkdownText.js";

const visibleEventTypes = new Set<TaskEvent["type"]>([
  "user_message",
  "assistant_delta",
  "assistant_message",
  "thinking_delta",
  "guidance_pending",
  "guidance_consumed",
  "approval_pending",
  "approval_resolved",
  "approval_auto_granted",
  "tool_result"
]);

export function Timeline({
  task,
  onApprovalDecision
}: {
  task: TaskDetail | null;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const items = useMemo(
    () =>
      buildTimelineItems(
        task?.events.filter((event) => {
        if (!visibleEventTypes.has(event.type)) return false;
        if (event.type !== "approval_pending") return true;
        const approvalId = String(event.payload["approvalId"] ?? "");
        return task.approvals.some((approval) => approval.id === approvalId && approval.status === "pending");
        }) ?? []
      ),
    [task]
  );

  if (!task) return <div className="empty">Start with a goal.</div>;

  return (
    <div className="timeline">
      {items.map((item) => (
        <TimelineEvent item={item} key={item.key} approvals={task.approvals} onApprovalDecision={onApprovalDecision} />
      ))}
    </div>
  );
}

type TimelineItem =
  | { key: string; kind: "event"; event: TaskEvent }
  | { key: string; kind: "stream"; type: "assistant_delta" | "thinking_delta"; streamId: string; summary: string };

function TimelineEvent({
  item,
  approvals,
  onApprovalDecision
}: {
  item: TimelineItem;
  approvals: ToolApproval[];
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  if (item.kind === "stream") {
    if (item.type === "thinking_delta") {
      return (
        <article className="event thinking_delta">
          <details>
            <summary>Thinking</summary>
            <MarkdownText content={item.summary} />
          </details>
        </article>
      );
    }
    return (
      <article className="event assistant_delta" aria-live="polite">
        <small>assistant streaming</small>
        <MarkdownText content={item.summary} />
      </article>
    );
  }

  const event = item.event;
  if (event.type === "approval_resolved" || event.type === "guidance_consumed" || event.type === "approval_auto_granted") {
    return (
      <article className={`event note ${event.type}`}>
        <span>{event.summary}</span>
      </article>
    );
  }

  if (event.type === "approval_pending") {
    const approvalId = String(event.payload["approvalId"] ?? "");
    const approval = approvals.find((item) => item.id === approvalId && item.status === "pending");
    if (!approval) return null;
    return (
      <article className="event approval_pending">
        <ApprovalCard approval={approval} onDecision={(decision) => onApprovalDecision(approval.id, decision)} />
      </article>
    );
  }

  if (event.type === "tool_result") {
    const output = String(event.payload["output"] ?? "");
    const parsed = parseToolOutput(output);
    const toolName = String(event.payload["toolName"] ?? "tool");
    const ok = Boolean(event.payload["ok"] ?? false);
    return (
      <article className="event tool_result">
        <small>{ok ? "tool result" : "tool error"} · {toolName}</small>
        <MarkdownText content={parsed.summary || event.summary} />
        {parsed.rawOutputRef ? <code className="rawRef">{parsed.rawOutputRef}</code> : null}
        <details className="toolOutput">
          <summary>View raw output</summary>
          <button className="copyOutputButton" onClick={() => void navigator.clipboard?.writeText(output)} type="button">
            Copy raw
          </button>
          <pre>{parsed.display.slice(0, 8000)}</pre>
        </details>
      </article>
    );
  }

  return (
    <article className={`event ${event.type}`}>
      <small>{event.type.replaceAll("_", " ")}</small>
      <MarkdownText content={event.summary} />
    </article>
  );
}

function buildTimelineItems(events: TaskEvent[]): TimelineItem[] {
  const finalStreamIds = new Set(
    events
      .filter((event) => event.type === "assistant_message")
      .map((event) => String(event.payload["streamId"] ?? ""))
      .filter(Boolean)
  );
  const items: TimelineItem[] = [];
  const streamItems = new Map<string, Extract<TimelineItem, { kind: "stream" }>>();
  for (const event of events) {
    if (event.type === "assistant_delta" || event.type === "thinking_delta") {
      const streamId = String(event.payload["streamId"] ?? event.id);
      if (event.type === "assistant_delta" && finalStreamIds.has(streamId)) continue;
      const key = `${event.type}:${streamId}`;
      let stream = streamItems.get(key);
      if (!stream) {
        stream = { key, kind: "stream", type: event.type, streamId, summary: "" };
        streamItems.set(key, stream);
        items.push(stream);
      }
      stream.summary = appendStreamDelta(stream.summary, String(event.payload["delta"] ?? event.summary), event.type);
      continue;
    }
    items.push({ key: event.id, kind: "event", event });
  }
  return items.filter((item) => item.kind === "event" || item.summary.trim().length > 0);
}

function appendStreamDelta(current: string, delta: string, type: "assistant_delta" | "thinking_delta"): string {
  if (!current || type === "assistant_delta") return current + delta;
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return current + delta;
  return `${current}\n${delta}`;
}

function parseToolOutput(output: string): { summary: string; display: string; rawOutputRef?: string } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const summary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    const rawOutputRef = typeof parsed["rawOutputRef"] === "string" ? parsed["rawOutputRef"] : undefined;
    const compact = summary || JSON.stringify(parsed, null, 2);
    return {
      summary: summary ? firstUsefulLine(summary) : "Tool evidence returned.",
      display: compact,
      ...(rawOutputRef ? { rawOutputRef } : {})
    };
  } catch {
    return {
      summary: firstUsefulLine(output),
      display: output
    };
  }
}

function firstUsefulLine(output: string): string {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return "Tool evidence returned.";
  return first.length > 220 ? `${first.slice(0, 220)}...` : first;
}
