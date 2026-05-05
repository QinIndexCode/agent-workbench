import type { ApprovalDecision, TaskDetail } from "@scc/shared";
import { Menu } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { Composer, type ComposerMode } from "./Composer.js";
import { Timeline } from "./Timeline.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const continueStatuses = new Set(["idle", "paused"]);

export function TaskThread({
  task,
  busy,
  error,
  language,
  onOpenTasks,
  onSubmit,
  onStop,
  onApprovalDecision
}: {
  task: TaskDetail | null;
  busy: boolean;
  error: string | null;
  language?: string | null;
  onOpenTasks: () => void;
  onSubmit: (mode: ComposerMode, text: string) => void;
  onStop: () => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const running = task?.status === "running" || task?.status === "waiting_approval";
  const mode = getComposerMode(task);
  const text = getUiCopy(language);

  return (
    <section className={task ? "thread" : "thread newTaskThread"} aria-label="Task thread">
      <header className="threadHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {text.shell.tasks}
        </button>
        <div className="threadTitleBlock">
          <h1>{task?.title ?? text.thread.newTask}</h1>
          <span>{getThreadMeta(task, mode, language)}</span>
        </div>
      </header>

      <div className={error ? "errorLine" : "errorLine emptyError"}>{error}</div>
      <Timeline language={language ?? null} task={task} onApprovalDecision={onApprovalDecision} />
      <Composer busy={busy} language={language ?? null} running={running} mode={mode} onSubmit={(content) => onSubmit(mode, content)} onStop={onStop} />
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

function getThreadMeta(task: TaskDetail | null, mode: ComposerMode, language?: string | null): string {
  const text = getUiCopy(language).thread;
  if (!task) return text.ready;
  const status = task.status.replace("_", " ");
  if (mode === "guidance") return text.runningGuidance;
  if (mode === "continue") return text.continueTask(status);
  return text.startsNewTask(status);
}
