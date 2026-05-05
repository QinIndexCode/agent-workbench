import { useMemo } from "react";
import type { TaskDetail, TaskEvent } from "@scc/shared";

const visibleEventTypes = new Set<TaskEvent["type"]>([
  "user_message",
  "assistant_message",
  "guidance_pending",
  "guidance_consumed",
  "approval_pending",
  "approval_resolved",
  "approval_auto_granted",
  "tool_result"
]);

export function Timeline({ task }: { task: TaskDetail | null }) {
  const events = useMemo(() => task?.events.filter((event) => visibleEventTypes.has(event.type)) ?? [], [task]);

  if (!task) return <div className="empty">Start with a goal.</div>;

  return (
    <div className="timeline">
      {events.map((event) => (
        <TimelineEvent event={event} key={event.id} />
      ))}
    </div>
  );
}

function TimelineEvent({ event }: { event: TaskEvent }) {
  if (event.type === "approval_resolved" || event.type === "guidance_consumed" || event.type === "approval_auto_granted") {
    return (
      <article className={`event note ${event.type}`}>
        <span>{event.summary}</span>
      </article>
    );
  }

  if (event.type === "tool_result") {
    const output = String(event.payload["output"] ?? "");
    return (
      <article className="event tool_result">
        <small>tool result</small>
        <p>{event.summary}</p>
        <details className="toolOutput">
          <summary>View raw output</summary>
          <button className="copyOutputButton" onClick={() => void navigator.clipboard?.writeText(output)} type="button">
            Copy raw
          </button>
          <pre>{output.slice(0, 5000)}</pre>
        </details>
      </article>
    );
  }

  return (
    <article className={`event ${event.type}`}>
      <small>{event.type.replaceAll("_", " ")}</small>
      <p>{formatSummary(event.summary)}</p>
    </article>
  );
}

function formatSummary(summary: string): string {
  return summary
    .replaceAll(" --- ", "\n\n---\n")
    .replaceAll(" ## ", "\n\n## ")
    .replaceAll(" ### ", "\n\n### ")
    .replace(/\s+\|\s*(?=\d+\s*\|)/g, "\n| ")
    .replace(/\s+-\s+/g, "\n- ");
}
