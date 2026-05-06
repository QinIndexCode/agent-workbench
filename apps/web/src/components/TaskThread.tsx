import type { ApprovalDecision, TaskDetail, UserPreferences } from "@scc/shared";
import { BookOpen, Code2, Cpu, Menu, Settings, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
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
  preferences,
  modelLabel,
  modelOptions,
  permissionPreset,
  permissionScopeLabel,
  onModelChange,
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
  preferences: UserPreferences | null;
  modelLabel: string;
  modelOptions: Array<{ label: string; value: string }>;
  permissionPreset: ComposerPermissionMode;
  permissionScopeLabel: string;
  onModelChange: (modelId: string) => void;
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
        <NewTaskHero language={language ?? null} onUseSuggestion={(prompt) => setDraft(prompt)} />
      )}
      <Composer
        busy={busy}
        draft={draft}
        language={language ?? null}
        modelLabel={modelLabel}
        modelOptions={modelOptions}
        modelValue={preferences?.defaultModel ?? ""}
        permissionPreset={permissionPreset}
        permissionScopeLabel={permissionScopeLabel}
        running={running}
        mode={mode}
        onDraftChange={setDraft}
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
  language,
  onUseSuggestion
}: {
  language?: string | null;
  onUseSuggestion: (prompt: string) => void;
}) {
  const text = getUiCopy(language).thread;
  const icons = [Cpu, Code2, BookOpen] as const;
  return (
    <div className="newTaskHero">
      <div className="newTaskHeroIcon" aria-hidden="true">
        <Terminal size={26} />
      </div>
      <h2>{text.heroTitle}</h2>
      <p>{text.heroSubtitle}</p>
      <div className="suggestionGrid">
        {text.suggestions.map((suggestion, index) => {
          const Icon = icons[index] ?? Settings;
          return (
            <button className="suggestionCard" key={suggestion.title} onClick={() => onUseSuggestion(suggestion.prompt)} type="button">
              <Icon size={21} />
              <strong>{suggestion.title}</strong>
              <span>{suggestion.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
