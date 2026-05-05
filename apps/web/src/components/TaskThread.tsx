import type { ApprovalDecision, TaskDetail } from "@scc/shared";
import { Menu } from "lucide-react";
import { Composer, type ComposerMode } from "./Composer.js";
import { Timeline } from "./Timeline.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const continueStatuses = new Set(["idle", "paused"]);

export function TaskThread({
  task,
  busy,
  error,
  onOpenTasks,
  onSubmit,
  onStop,
  onApprovalDecision
}: {
  task: TaskDetail | null;
  busy: boolean;
  error: string | null;
  onOpenTasks: () => void;
  onSubmit: (mode: ComposerMode, text: string) => void;
  onStop: () => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const running = task?.status === "running" || task?.status === "waiting_approval";
  const mode = getComposerMode(task);

  return (
    <section className={task ? "thread" : "thread newTaskThread"} aria-label="Task thread">
      <header className="threadHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          Tasks
        </button>
        <div className="threadTitleBlock">
          <h1>{task?.title ?? "New task"}</h1>
          <span>{getThreadMeta(task, mode)}</span>
        </div>
      </header>

      <div className={error ? "errorLine" : "errorLine emptyError"}>{error}</div>
      <Timeline task={task} onApprovalDecision={onApprovalDecision} />
      <Composer busy={busy} running={running} mode={mode} onSubmit={(text) => onSubmit(mode, text)} onStop={onStop} />
    </section>
  );
}

function getComposerMode(task: TaskDetail | null): ComposerMode {
  if (!task) return "new_task";
  if (task.status === "running" || task.status === "waiting_approval") return "guidance";
  if (continueStatuses.has(task.status)) return "continue";
  if (terminalStatuses.has(task.status)) return "new_task";
  return "new_task";
}

function getThreadMeta(task: TaskDetail | null, mode: ComposerMode): string {
  if (!task) return "Ready for a new task";
  if (mode === "guidance") return "Running · input becomes pending guidance";
  if (mode === "continue") return `${task.status.replace("_", " ")} · input continues this task`;
  return `${task.status.replace("_", " ")} · input starts a new task`;
}
