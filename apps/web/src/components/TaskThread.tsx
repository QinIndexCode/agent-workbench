import type { ApprovalDecision, TaskAttachment, TaskDetail, UserPreferences } from "@scc/shared";
import { Menu, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { Composer, type ComposerMode, type ComposerPermissionMode, type PermissionPreset } from "./Composer.js";
import type { EngineStatus } from "./TaskList.js";
import { Timeline } from "./Timeline.js";

export function TaskThread({
  task,
  busy,
  attachments,
  attachmentBusy,
  attachmentError,
  error,
  language,
  engineStatus,
  folderOptions,
  folderValue,
  preferences,
  modelLabel,
  modelOptions,
  permissionPreset,
  permissionScopeLabel,
  onModelChange,
  onFilesSelected,
  onRemoveAttachment,
  onFolderChange,
  onOpenConnect,
  onOpenPermissionSettings,
  onOpenCustomPermissions,
  onRestoreCustomPermissions,
  hasCustomSnapshot,
  onPermissionPresetChange,
  onOpenTasks,
  onSubmit,
  onStop,
  titleIssue,
  onRetryTitle,
  onUseLocalTitle,
  onApprovalDecision
}: {
  task: TaskDetail | null;
  busy: boolean;
  attachments: TaskAttachment[];
  attachmentBusy: boolean;
  attachmentError: string | null;
  error: string | null;
  language?: string | null;
  engineStatus: EngineStatus;
  folderOptions?: Array<{ description?: string; label: string; value: string }> | undefined;
  folderValue?: string | undefined;
  preferences: UserPreferences | null;
  modelLabel: string;
  modelOptions: Array<{ label: string; value: string }>;
  permissionPreset: ComposerPermissionMode;
  permissionScopeLabel: string;
  onModelChange: (modelId: string) => void;
  onFilesSelected: (files: File[]) => Promise<void> | void;
  onRemoveAttachment: (attachmentId: string) => Promise<void> | void;
  onFolderChange?: ((folderId: string) => void) | undefined;
  onOpenConnect: () => void;
  onOpenPermissionSettings: () => void;
  onOpenCustomPermissions: () => void;
  onRestoreCustomPermissions: () => void;
  hasCustomSnapshot: boolean;
  onPermissionPresetChange: (preset: PermissionPreset) => void;
  onOpenTasks: () => void;
  onSubmit: (mode: ComposerMode, text: string) => void;
  onStop: () => void;
  titleIssue?: { goal: string; error: string } | null;
  onRetryTitle: () => void;
  onUseLocalTitle: () => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const running = task?.status === "running" || task?.status === "waiting_approval";
  const mode = getComposerMode(task);
  const text = getUiCopy(language);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft("");
  }, [task?.id]);

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
        <button className={`engineButton ${engineStatus}`} onClick={onOpenConnect} type="button">
          <span className="engineDot" />
          {text.thread.connect}
        </button>
      </header>

      <div className={error ? "errorLine" : "errorLine emptyError"}>{error}</div>
      {titleIssue ? (
        <div className="titleIssue">
          <span>{text.thread.titleGenerationFailed}</span>
          <button type="button" onClick={onRetryTitle}>{text.thread.retryTitle}</button>
          <button type="button" onClick={onUseLocalTitle}>{text.thread.useLocalTitle}</button>
        </div>
      ) : null}
      {task ? (
        <div className="threadMain">
          <Timeline language={language ?? null} task={task} onApprovalDecision={onApprovalDecision} />
          <TaskPlanPanel language={language ?? null} task={task} />
        </div>
      ) : (
        <NewTaskHero language={language ?? null} />
      )}
      <Composer
        busy={busy}
        attachments={attachments}
        attachmentBusy={attachmentBusy}
        attachmentError={attachmentError}
        draft={draft}
        folderOptions={folderOptions}
        folderValue={folderValue}
        language={language ?? null}
        modelLabel={modelLabel}
        modelOptions={modelOptions}
        modelValue={preferences?.defaultModel ?? ""}
        permissionPreset={permissionPreset}
        permissionScopeLabel={permissionScopeLabel}
        running={running}
        mode={mode}
        onDraftChange={setDraft}
        onFilesSelected={onFilesSelected}
        onRemoveAttachment={onRemoveAttachment}
        onFolderChange={onFolderChange}
        onModelChange={onModelChange}
        onOpenPermissionSettings={onOpenPermissionSettings}
        onOpenCustomPermissions={onOpenCustomPermissions}
        onRestoreCustomPermissions={onRestoreCustomPermissions}
        hasCustomSnapshot={hasCustomSnapshot}
        onPermissionPresetChange={onPermissionPresetChange}
        onSubmit={(content) => onSubmit(mode, content)}
        onStop={onStop}
      />
    </section>
  );
}

function TaskPlanPanel({ language, task }: { language?: string | null; task: TaskDetail }) {
  const zh = language === "zh-CN";
  const steps = derivePlanSteps(task);
  if (steps.length === 0) return null;
  return (
    <aside className="taskPlanPanel" aria-label={zh ? "计划与进度" : "Plan and progress"}>
      <header>
        <strong>{zh ? "计划与进度" : "Plan / Progress"}</strong>
        <small>{task.workRoot}</small>
      </header>
      <ol>
        {steps.map((step) => (
          <li className={`planStep ${step.status}`} key={step.id}>
            <span />
            <div>
              <strong>{step.title}</strong>
              {step.detail ? <small>{step.detail}</small> : null}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function derivePlanSteps(task: TaskDetail): Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> {
  const initial = task.events.find((event) => event.type === "plan_created");
  const rawSteps = Array.isArray(initial?.payload["steps"]) ? initial.payload["steps"] : [];
  const steps: Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> = rawSteps
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item["id"] ?? item["title"] ?? Math.random()),
      title: String(item["title"] ?? "Step"),
      status: normalizeStepStatus(item["status"]),
      ...(typeof item["detail"] === "string" ? { detail: item["detail"] } : {})
    }));
  for (const event of task.events) {
    if (!event.type.startsWith("plan_step_")) continue;
    const toolCallId = String(event.payload["toolCallId"] ?? event.id);
    const existing = steps.find((step) => step.id === toolCallId);
    const status = event.type === "plan_step_completed" ? "completed" : event.type === "plan_step_blocked" ? "blocked" : "running";
    if (existing) {
      existing.status = status;
      existing.detail = event.summary;
    } else {
      steps.push({ id: toolCallId, title: event.summary, status, detail: event.summary });
    }
  }
  return steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: step.status,
    ...(step.detail ? { detail: step.detail } : {})
  }));
}

function normalizeStepStatus(value: unknown): "pending" | "running" | "completed" | "blocked" {
  return value === "running" || value === "completed" || value === "blocked" ? value : "pending";
}

function getComposerMode(task: TaskDetail | null): ComposerMode {
  if (!task) return "new_task";
  if (task.status === "running" || task.status === "waiting_approval") return "guidance";
  return "continue";
}

function getThreadMeta(task: TaskDetail | null, mode: ComposerMode, language?: string | null): string {
  const text = getUiCopy(language).thread;
  if (!task) return text.ready;
  const status = task.status.replace("_", " ");
  if (mode === "guidance") return text.runningGuidance;
  return text.continueTask(status);
}

function NewTaskHero({
  language
}: {
  language?: string | null;
}) {
  const text = getUiCopy(language).thread;
  const [displayTitle, setDisplayTitle] = useState("");
  const [displaySubtitle, setDisplaySubtitle] = useState("");
  const [isTypingTitle, setIsTypingTitle] = useState(true);
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const title = text.heroTitle;
    const subtitleVariants = (text as unknown as { heroSubtitleVariants?: readonly string[] }).heroSubtitleVariants;
    const variants = Array.isArray(subtitleVariants) && subtitleVariants.length > 0 ? [...subtitleVariants] : [text.heroSubtitle];
    const subtitle = variants[Math.floor(Math.random() * variants.length)] ?? text.heroSubtitle;
    let titleIndex = 0;
    let subtitleIndex = 0;

    const titleInterval = setInterval(() => {
      if (titleIndex < title.length) {
        titleIndex++;
        setDisplayTitle(title.slice(0, titleIndex));
      } else {
        clearInterval(titleInterval);
        setIsTypingTitle(false);
      }
    }, 60);

    const subtitleInterval = setInterval(() => {
      if (subtitleIndex < subtitle.length) {
        subtitleIndex++;
        setDisplaySubtitle(subtitle.slice(0, subtitleIndex));
      } else {
        clearInterval(subtitleInterval);
        setShowCursor(false);
      }
    }, 30);

    return () => {
      clearInterval(titleInterval);
      clearInterval(subtitleInterval);
    };
  }, [text.heroTitle, text.heroSubtitle]);

  return (
    <div className="newTaskHero">
      <h2>{displayTitle}</h2>
      <p>
        {displaySubtitle}
        {showCursor && <span className="typeCursor" />}
      </p>
    </div>
  );
}
