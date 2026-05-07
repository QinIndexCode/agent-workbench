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
  onRollbackLatest,
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
  onRollbackLatest?: (() => void) | undefined;
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
          <TaskPlanPanel language={language ?? null} task={task} onRollbackLatest={onRollbackLatest} />
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

function TaskPlanPanel({ language, task, onRollbackLatest }: { language?: string | null; task: TaskDetail; onRollbackLatest?: (() => void) | undefined }) {
  const zh = language === "zh-CN";
  const steps = derivePlanSteps(task);
  const checkpointCount = task.events.filter((event) => event.type === "task_checkpoint_created").length;
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
      {checkpointCount > 0 && onRollbackLatest ? (
        <button className="rollbackButton" type="button" onClick={onRollbackLatest}>
          {zh ? "回滚最近改动" : "Rollback latest changes"}
        </button>
      ) : null}
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
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const heroTitleVariants = (text as unknown as { heroTitleVariants?: readonly string[] }).heroTitleVariants;
    const titlePool = Array.isArray(heroTitleVariants) && heroTitleVariants.length > 0 ? [...heroTitleVariants] : [text.heroTitle];
    const subtitleVariants = (text as unknown as { heroSubtitleVariants?: readonly string[] }).heroSubtitleVariants;
    const subtitlePool = Array.isArray(subtitleVariants) && subtitleVariants.length > 0 ? [...subtitleVariants] : [text.heroSubtitle];

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (fn: () => void, ms: number) => {
      if (!cancelled) timers.push(setTimeout(fn, ms));
    };
    const delay = (ms: number) => new Promise<void>((resolve) => {
      schedule(resolve, ms);
    });

    const pickRandom = (arr: readonly string[]) => arr[Math.floor(Math.random() * arr.length)]!;

    const runCycle = async () => {
      while (!cancelled) {
        const title = pickRandom(titlePool);
        const subtitle = pickRandom(subtitlePool);

        setDisplayTitle("");
        setDisplaySubtitle("");
        setShowCursor(true);

        for (let i = 1; i <= title.length; i++) {
          if (cancelled) return;
          setDisplayTitle(title.slice(0, i));
          await delay(60);
        }

        for (let i = 1; i <= subtitle.length; i++) {
          if (cancelled) return;
          setDisplaySubtitle(subtitle.slice(0, i));
          await delay(30);
        }

        await delay(18000);
        if (cancelled) return;

        setShowCursor(false);
        const maxLen = Math.max(title.length, subtitle.length);

        for (let i = maxLen; i >= 0; i--) {
          if (cancelled) return;
          setDisplayTitle(title.slice(0, i));
          setDisplaySubtitle(subtitle.slice(0, i));
          await delay(30);
        }
      }
    };

    runCycle();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [text.heroTitle, text.heroSubtitle]);

  const cursorInTitle = showCursor && displaySubtitle.length === 0;

  return (
    <div className="newTaskHero">
      <h2>
        {displayTitle}
        {cursorInTitle && <span className="typeCursor" />}
      </h2>
      <p>
        {displaySubtitle}
        {showCursor && !cursorInTitle && <span className="typeCursor" />}
      </p>
    </div>
  );
}
