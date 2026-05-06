import type { ApprovalDecision, TaskDetail, UserPreferences } from "@scc/shared";
import { Menu, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { Composer, type ComposerMode, type ComposerPermissionMode, type PermissionPreset } from "./Composer.js";
import type { EngineStatus } from "./TaskList.js";
import { Timeline } from "./Timeline.js";

export function TaskThread({
  task,
  busy,
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
  onFolderChange,
  onOpenConnect,
  onOpenPermissionSettings,
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
  onFolderChange?: ((folderId: string) => void) | undefined;
  onOpenConnect: () => void;
  onOpenPermissionSettings: () => void;
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
        <Timeline language={language ?? null} task={task} onApprovalDecision={onApprovalDecision} />
      ) : (
        <NewTaskHero language={language ?? null} />
      )}
      <Composer
        busy={busy}
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
        onFolderChange={onFolderChange}
        onModelChange={onModelChange}
        onOpenPermissionSettings={onOpenPermissionSettings}
        onPermissionPresetChange={onPermissionPresetChange}
        onSubmit={(content) => onSubmit(mode, content)}
        onStop={onStop}
      />
    </section>
  );
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
