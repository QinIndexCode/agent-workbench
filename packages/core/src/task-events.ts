import type { TaskDetail, TaskEvent } from "@scc/shared";

export function latestUserEvent(task: Pick<TaskDetail, "events">): TaskEvent | undefined {
  return [...task.events].reverse().find((event) => isCurrentUserEvent(event));
}

export function latestUserText(task: Pick<TaskDetail, "events">): string {
  return latestUserEvent(task)?.summary ?? "";
}

export function hasUserTurn(task: Pick<TaskDetail, "events">): boolean {
  return Boolean(latestUserEvent(task));
}

function isCurrentUserEvent(event: TaskEvent): boolean {
  return (
    (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") &&
    !event.reverted
  );
}
