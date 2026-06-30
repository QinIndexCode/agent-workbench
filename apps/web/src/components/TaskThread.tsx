import type { ApprovalDecision, TaskAttachment, TaskChildSummary, TaskDetail, TaskEvent, TaskTranscriptItem, UserPreferences } from "@agent-workbench/shared";
import { AlertCircle, FileClock, Flag, Menu, PanelRightClose, PanelRightOpen, ShieldAlert, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { Composer, type ComposerMode, type ComposerPermissionMode, type PermissionPreset } from "./Composer.js";
import type { EngineStatus } from "./TaskList.js";
import type { ConversationSummary, TaskRollbackPreview, TaskRollbackRequest, TaskRollbackResult } from "@agent-workbench/shared";
import { describeSkillSource, describeSkillStatus, summarizeTaskSkills } from "./skillUx.js";

const PLAN_PANEL_COLLAPSED_KEY = "agent-workbench.planPanel.collapsed";
const LEGACY_PLAN_PANEL_COLLAPSED_KEY = "scc.planPanel.collapsed";
const Timeline = lazy(() => import("./Timeline.js").then((module) => ({ default: module.Timeline })));

export function TaskThread({
  task,
  parentTask,
  delegatedChildren = [],
  transcriptEvents,
  busy,
  busySince,
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
  permissionBusy,
  permissionError,
  onModelChange,
  onFilesSelected,
  onRemoveAttachment,
  onFolderChange,
  onOpenConnect,
  onOpenCustomPermissions,
  onRestoreCustomPermissions,
  hasCustomSnapshot,
  onPermissionPresetChange,
  onOpenTasks,
  onSubmit,
  onStop,
  onCancelBusy,
  onPreviewRollback,
  onRollback,
  onLoadStreamText,
  onRevertTurn,
  onAnswerUserInput,
  onLoadContextSummaries,
  titleIssue,
  onRetryTitle,
  onUseLocalTitle,
  onApprovalDecision,
  onOpenDelegatedTask,
  onReturnToParent
}: {
  task: TaskDetail | null;
  parentTask?: TaskDetail | null | undefined;
  delegatedChildren?: TaskChildSummary[] | undefined;
  transcriptEvents?: TaskTranscriptItem[] | undefined;
  busy: boolean;
  busySince?: number | null;
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
  permissionBusy?: boolean;
  permissionError?: string | null;
  onModelChange: (modelId: string) => void;
  onFilesSelected: (files: File[]) => Promise<void> | void;
  onRemoveAttachment: (attachmentId: string) => Promise<void> | void;
  onFolderChange?: ((folderId: string) => void) | undefined;
  onOpenConnect: () => void;
  onOpenCustomPermissions: () => void;
  onRestoreCustomPermissions: () => void;
  hasCustomSnapshot: boolean;
  onPermissionPresetChange: (preset: PermissionPreset) => void;
  onOpenTasks: () => void;
  onSubmit: (mode: ComposerMode, text: string) => void;
  onStop: () => void;
  onCancelBusy?: () => void;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
  onLoadStreamText?: ((taskId: string, streamId: string, type: "assistant_delta" | "thinking_delta") => Promise<string>) | undefined;
  onRevertTurn?: ((turnId: string) => Promise<string>) | undefined;
  onAnswerUserInput?: ((answer: string) => Promise<void> | void) | undefined;
  onLoadContextSummaries?: (() => Promise<ConversationSummary[]>) | undefined;
  titleIssue?: { goal: string; error: string } | null;
  onRetryTitle: () => void;
  onUseLocalTitle: () => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onOpenDelegatedTask?: ((taskId: string) => void) | undefined;
  onReturnToParent?: (() => void) | undefined;
}) {
  const running = task?.status === "running" || task?.status === "waiting_approval" || task?.status === "waiting_for_user";
  const mode = getComposerMode(task);
  const text = getUiCopy(language);
  const [draft, setDraft] = useState("");
  const [focusedTimelineEventId, setFocusedTimelineEventId] = useState<string | null>(null);
  const threadMainRef = useRef<HTMLDivElement | null>(null);
  const timelineTask = useMemo(() => {
    if (!task) return null;
    return transcriptEvents ? { ...task, events: transcriptEvents } : task;
  }, [task, transcriptEvents]);
  const revertTurnWithConfirmation = useCallback(async (turnId: string) => {
    if (!onRevertTurn) return;
    const confirmed = window.confirm(language === "zh-CN" ? "撤回这一轮，并同时回退该轮之后的文件变更？" : "Revert this turn and roll back file changes made after it?");
    if (!confirmed) return;
    const revertedDraft = await onRevertTurn(turnId);
    if (revertedDraft) setDraft(revertedDraft);
  }, [language, onRevertTurn]);

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
          {task?.kind === "subagent" && parentTask ? (
            <button className="threadBreadcrumb" type="button" onClick={onReturnToParent}>
              <span>{parentTask.title}</span>
              <span>/</span>
              <strong>{task.title}</strong>
            </button>
          ) : null}
          <h1>{task?.title ?? text.thread.newTask}</h1>
          <span>{getThreadMeta(task, mode, language)}</span>
        </div>
        <button className={`engineButton ${engineStatus}`} onClick={onOpenConnect} type="button">
          <span className="engineDot" />
          {text.thread.connect}
        </button>
      </header>

      {error || titleIssue || (busy && onCancelBusy) ? (
        <div className="threadAlerts">
          {error ? (
            <div className="errorLine" role="status">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{formatUserFacingError(error, language)}</span>
            </div>
          ) : null}
          {busy && onCancelBusy ? <BusyCancelButton busySince={busySince} language={language ?? null} onCancel={onCancelBusy} /> : null}
          {titleIssue ? (
            <div className="titleIssue" role="status">
              <AlertCircle size={16} aria-hidden="true" />
              <span>
                <strong>{text.thread.titleGenerationFailed}</strong>
                <small>{formatUserFacingError(titleIssue.error, language)}</small>
              </span>
              <div>
                <button type="button" onClick={onRetryTitle}>{text.thread.retryTitle}</button>
                <button type="button" onClick={onUseLocalTitle}>{text.thread.useLocalTitle}</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {task?.runMode === "target" ? (
        <GoalModeStatusBar
          language={language ?? null}
          onPause={onStop}
          permissionScopeLabel={permissionScopeLabel}
          preferences={preferences}
          running={running}
          task={task}
        />
      ) : null}
      <div className={task ? "threadWorkspace" : "threadWorkspace newTaskWorkspace"}>
        <div className="threadContentRail">
          {task ? (
            <div className="threadMain" ref={threadMainRef}>
              {task.kind !== "subagent" && delegatedChildren.length > 0 ? (
                <section className="delegatedWorkPanel" aria-label={language === "zh-CN" ? "委派工作" : "Delegated work"}>
                  <div className="delegatedWorkHeader">
                    <h2>{language === "zh-CN" ? "委派工作" : "Delegated Work"}</h2>
                    <span>{delegatedChildren.length}</span>
                  </div>
                  <div className="delegatedWorkList">
                    {delegatedChildren.map((child) => (
                      <button
                        className={`delegatedWorkCard status_${child.status}`}
                        key={child.id}
                        type="button"
                        onClick={() => onOpenDelegatedTask?.(child.id)}
                      >
                        <div className="delegatedWorkCardTop">
                          <strong>{child.title}</strong>
                          <span>{formatDelegatedStatus(child.status, language)}</span>
                        </div>
                        <p>{child.statusText || child.goal}</p>
                        <div className="delegatedWorkMeta">
                          <span>{child.activeToolName || child.goal}</span>
                          <time dateTime={child.updatedAt}>{formatDelegatedUpdatedAt(child.updatedAt, language)}</time>
                        </div>
                        {child.lastAssistantSummary ? <small>{child.lastAssistantSummary}</small> : null}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <Suspense fallback={<TimelineFallback language={language ?? null} />}>
                <Timeline
                  language={language ?? null}
                  showThinking={preferences?.showThinking ?? true}
                  task={timelineTask}
                  scrollContainerRef={threadMainRef}
                  focusEventId={focusedTimelineEventId}
                  onLoadStreamText={onLoadStreamText}
                  onPreviewRollback={onPreviewRollback}
                  onRollback={onRollback}
                  onApprovalDecision={onApprovalDecision}
                  onAnswerUserInput={onAnswerUserInput}
                  onRevertTurn={revertTurnWithConfirmation}
                />
              </Suspense>
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
            permissionBusy={Boolean(permissionBusy)}
            permissionError={permissionError ?? null}
            running={running}
            mode={mode}
            onDraftChange={setDraft}
            onFilesSelected={onFilesSelected}
            onRemoveAttachment={onRemoveAttachment}
            onFolderChange={onFolderChange}
            onModelChange={onModelChange}
            onOpenCustomPermissions={onOpenCustomPermissions}
            onRestoreCustomPermissions={onRestoreCustomPermissions}
            hasCustomSnapshot={hasCustomSnapshot}
            onPermissionPresetChange={onPermissionPresetChange}
            onSubmit={(content) => onSubmit(mode, content)}
            onStop={onStop}
          />
        </div>
        {task ? (
          <TaskPlanPanel
            language={language ?? null}
            task={timelineTask ?? task}
            onLoadContextSummaries={onLoadContextSummaries}
            onFocusTimelineEvent={setFocusedTimelineEventId}
          />
        ) : null}
      </div>
    </section>
  );
}

function TimelineFallback({ language }: { language?: string | null }) {
  return (
    <div className="timelineLoading" role="status">
      {language === "zh-CN" ? "正在加载时间线..." : "Loading timeline..."}
    </div>
  );
}

function GoalModeStatusBar({
  language,
  onPause,
  permissionScopeLabel,
  preferences,
  running,
  task
}: {
  language?: string | null;
  onPause: () => void;
  permissionScopeLabel: string;
  preferences: UserPreferences | null;
  running: boolean;
  task: TaskDetail;
}) {
  const zh = language === "zh-CN";
  const limits = task.targetLimits;
  const toolResults = task.events.filter((event) => event.type === "tool_result" && !event.reverted).length;
  const permissionLabel = goalPermissionLabel(preferences, permissionScopeLabel, language);
  const timeLimitMinutes = limits ? Math.round(limits.maxWallTimeMs / 60000) : null;
  return (
    <section className="goalModeStatusBar" aria-label={zh ? "目标完成模式状态" : "Goal mode status"}>
      <div className="goalModeBadge">
        <Flag size={15} aria-hidden="true" />
        <span>{zh ? "目标完成模式" : "Goal mode"}</span>
      </div>
      <div className="goalModeMeta">
        <span>{zh ? "状态" : "Status"}: {formatDelegatedStatus(task.status, language)}</span>
        <span>{zh ? "权限" : "Permission"}: {permissionLabel}</span>
        {limits ? <span>{zh ? "工具" : "Tools"}: {toolResults}/{limits.maxToolCalls}</span> : null}
        {limits ? <span>{zh ? "模型轮次上限" : "Turn cap"}: {limits.maxModelTurns}</span> : null}
        {timeLimitMinutes ? <span>{zh ? "时间上限" : "Time cap"}: {timeLimitMinutes} min</span> : null}
      </div>
      <div className="goalModeActions">
        <ShieldAlert size={15} aria-hidden="true" />
        <span>{zh ? "该模式会持续推进直到完成、暂停或达到上限。" : "This mode keeps pushing until completion, pause, or limits."}</span>
        {running ? (
          <button type="button" onClick={onPause}>
            {zh ? "暂停" : "Pause"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function goalPermissionLabel(preferences: UserPreferences | null, fallback: string, language?: string | null): string {
  const zh = language === "zh-CN";
  if (preferences?.permissionMode === "full_access") return zh ? "Full risk" : "Full risk";
  if (preferences?.permissionMode === "auto_approval") {
    const selected = new Set(preferences.autoApproveRiskCategories ?? []);
    const allSafe = ["host_observation", "workspace_read", "workspace_write", "shell", "network"].every((risk) => selected.has(risk as UserPreferences["autoApproveRiskCategories"][number]));
    if (allSafe) return "Non-destructive max";
    return zh ? "自动审批" : "Auto approval";
  }
  return fallback;
}

function formatDelegatedStatus(status: TaskDetail["status"], language?: string | null): string {
  const zh = language === "zh-CN";
  switch (status) {
    case "running":
      return zh ? "运行中" : "Running";
    case "paused":
      return zh ? "已暂停" : "Paused";
    case "waiting_approval":
      return zh ? "等待审批" : "Waiting approval";
    case "waiting_for_user":
      return zh ? "等待用户" : "Waiting for user";
    case "completed":
      return zh ? "已完成" : "Completed";
    case "failed":
      return zh ? "失败" : "Failed";
    case "cancelled":
      return zh ? "已取消" : "Cancelled";
    default:
      return status;
  }
}

function formatDelegatedUpdatedAt(value: string, language?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const BusyCancelButton = memo(function BusyCancelButton({
  busySince,
  language,
  onCancel
}: {
  busySince?: number | null | undefined;
  language?: string | null | undefined;
  onCancel: () => void;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!busySince) {
      setElapsedMs(0);
      return;
    }
    const tick = () => setElapsedMs(Math.round(performance.now() - busySince));
    tick();
    const interval = window.setInterval(tick, 200);
    return () => window.clearInterval(interval);
  }, [busySince]);

  if (!busySince || elapsedMs <= 5000) return null;
  return (
    <button className="cancelBusyButton" type="button" onClick={onCancel} title={language === "zh-CN" ? "隐藏等待状态" : "Hide waiting state"}>
      <X size={14} />
      {formatElapsed(elapsedMs)}
    </button>
  );
});

function TaskPlanPanel({
  language,
  task,
  onLoadContextSummaries,
  onFocusTimelineEvent
}: {
  language?: string | null;
  task: TaskDetail;
  onLoadContextSummaries?: (() => Promise<ConversationSummary[]>) | undefined;
  onFocusTimelineEvent?: ((eventId: string) => void) | undefined;
}) {
  const zh = language === "zh-CN";
  const taskEvents = useMemo(() => (Array.isArray(task.events) ? task.events : []), [task.events]);
  const steps = derivePlanSteps(task);
  const rollbackPoints = useMemo(() => deriveRollbackTimelinePoints(taskEvents, language), [language, taskEvents]);
  const hasAudit = taskEvents.some((event) => event.type === "conversation_summary_created" || event.type === "context_overflow_recovered" || event.type === "provider_fallback" || event.type === "token_usage_recorded");
  const skillAudit = summarizeTaskSkills(task);
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const storage = safeBrowserLocalStorage();
      const stored = storage?.getItem(PLAN_PANEL_COLLAPSED_KEY) ?? storage?.getItem(LEGACY_PLAN_PANEL_COLLAPSED_KEY);
      if (stored === "1") return true;
      if (stored === "0") return false;
      return window.matchMedia?.("(max-width: 760px)").matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      safeBrowserLocalStorage()?.setItem(PLAN_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Ignore storage failures; the panel remains usable for the current session.
    }
  }, [collapsed]);
  if (steps.length === 0 && rollbackPoints.length === 0 && !hasAudit && skillAudit.loaded.length === 0 && skillAudit.skipped.length === 0) return null;

  return (
    <>
    <button
      className={collapsed ? "planPanelToggle collapsed" : "planPanelToggle"}
      type="button"
      aria-expanded={!collapsed}
      onClick={() => setCollapsed((current) => !current)}
      title={collapsed ? (zh ? "展开侧栏" : "Expand panel") : (zh ? "收起侧栏" : "Collapse panel")}
    >
      {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
    </button>
    <aside className={collapsed ? "taskPlanPanel collapsed" : "taskPlanPanel"} aria-label={zh ? "计划与进度" : "Plan and progress"}>
      <header className="planPanelHeader">
        <div>
          <strong>{zh ? "计划与进度" : "Plan / Progress"}</strong>
          <small>{task.workRoot}</small>
        </div>
      </header>
      {!collapsed ? (
        <>
          {steps.length > 0 ? (
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
          ) : null}
          {rollbackPoints.length > 0 ? (
            <RollbackTimelineView
              activeCheckpointId={activeCheckpointId}
              language={language ?? null}
              points={rollbackPoints}
              onSelect={(point) => {
                setActiveCheckpointId(point.checkpointId);
                onFocusTimelineEvent?.(point.eventId);
                setCollapsed(true);
              }}
            />
          ) : null}
          <div className="planPanelActions">
            {hasAudit || onLoadContextSummaries ? (
              <button className="rollbackButton" type="button" onClick={() => void toggleAudit()}>
                {auditOpen ? (zh ? "收起上下文审计" : "Hide context audit") : (zh ? "上下文审计" : "Context audit")}
              </button>
            ) : null}
          </div>
          {skillAudit.loaded.length > 0 || skillAudit.skipped.length > 0 ? <TaskSkillAuditView language={language ?? null} task={task} /> : null}
          {auditOpen ? <ContextAuditView language={language ?? null} summaries={summaries} task={task} /> : null}
        </>
      ) : null}
    </aside>
    </>
  );

  async function toggleAudit() {
    const nextOpen = !auditOpen;
    setAuditOpen(nextOpen);
    if (!nextOpen) return;
    const nextSummaries = await (onLoadContextSummaries?.() ?? Promise.resolve([]));
    setSummaries(nextSummaries);
  }
}

type RollbackTimelinePoint = {
  checkpointId: string;
  eventId: string;
  toolName: string;
  fileLabel: string;
  fileCount: number;
  createdAt: string;
  sequence: number;
  rolledBack: boolean;
};

function RollbackTimelineView({
  activeCheckpointId,
  language,
  points,
  onSelect
}: {
  activeCheckpointId: string | null;
  language?: string | null;
  points: RollbackTimelinePoint[];
  onSelect: (point: RollbackTimelinePoint) => void;
}) {
  const zh = language === "zh-CN";
  return (
    <section className="rollbackTimelinePanel" aria-label={zh ? "文件回滚时间线" : "File rollback timeline"}>
      <div className="rollbackTimelineHeader">
        <div>
          <strong>{zh ? "文件回滚时间线" : "File rollback timeline"}</strong>
          <small>{zh ? "点击任一回滚点，跳到聊天流中的检查位置。" : "Click a rollback point to inspect it in the chat timeline."}</small>
        </div>
        <FileClock size={16} aria-hidden="true" />
      </div>
      <div className="rollbackCheckpointList">
        {points.map((point) => {
          const active = activeCheckpointId === point.checkpointId;
          return (
            <article className={active ? "rollbackCheckpointCard active" : "rollbackCheckpointCard"} key={point.checkpointId}>
              <button className="rollbackCheckpointMain" type="button" onClick={() => onSelect(point)}>
                <span className={point.rolledBack ? "rollbackCheckpointDot rolledBack" : "rollbackCheckpointDot"} />
                <span>
                  <strong>{point.fileLabel}</strong>
                  <small>{formatRollbackPointMeta(point, language)}</small>
                </span>
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function TaskSkillAuditView({ language, task }: { language?: string | null; task: TaskDetail }) {
  const zh = language === "zh-CN";
  const skillAudit = summarizeTaskSkills(task);
  return (
    <section className="contextAuditPanel" aria-label={zh ? "本任务 Skill" : "Skills in this task"}>
      <details open>
        <summary>{zh ? "本任务 Skill" : "Skills in this task"}</summary>
        {skillAudit.loaded.length === 0 ? (
          <p className="muted">{zh ? "当前没有已加载的 Skill。" : "No skill was loaded for this task yet."}</p>
        ) : (
          <div className="compactList">
            {skillAudit.loaded.map((skill) => (
              <article className="providerRow" key={skill.eventId}>
                <div>
                  <strong>{skill.title}</strong>
                  <small>{describeSkillStatus(skill.status, language)} · {describeSkillSource(skill.source, language)}</small>
                  <small>{skill.matchReason}</small>
                  {skill.matchedSignals.length > 0 ? <small>{zh ? "命中信号" : "Matched signals"}: {skill.matchedSignals.join(", ")}</small> : null}
                  {skill.requiredTools.length > 0 ? <small>{zh ? "工具序列" : "Tool sequence"}: {skill.requiredTools.join(", ")}</small> : null}
                  {skill.requiredContext.length > 0 ? <small>{zh ? "需要上下文" : "Required context"}: {skill.requiredContext.join(", ")}</small> : null}
                  {skill.readOnlySuggestion ? <small>{zh ? "仅提供只读建议，不要求写入。": "Loaded as a read-only suggestion, not a forced write flow."}</small> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </details>
      {skillAudit.skipped.length > 0 ? (
        <details>
          <summary>{zh ? "未加载的候选" : "Skipped candidates"}</summary>
          <div className="compactList">
            {skillAudit.skipped.map((skill) => (
              <article className="providerRow" key={skill.eventId}>
                <div>
                  <strong>{skill.title ?? skill.requested}</strong>
                  <small>{skill.reason}</small>
                  {skill.status ? <small>{describeSkillStatus(skill.status, language)}</small> : null}
                  {skill.source ? <small>{describeSkillSource(skill.source, language)}</small> : null}
                  {skill.matchedSignals.length > 0 ? <small>{zh ? "相关信号" : "Related signals"}: {skill.matchedSignals.join(", ")}</small> : null}
                </div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function safeBrowserLocalStorage(): Storage | null {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ContextAuditView({ language, summaries, task }: { language?: string | null; summaries: ConversationSummary[]; task: TaskDetail }) {
  const zh = language === "zh-CN";
  const safeSummaries = Array.isArray(summaries) ? summaries : [];
  const safeEvents = Array.isArray(task?.events) ? task.events : [];
  const latestSummary = [...safeSummaries].sort((a, b) => {
    try { return b.createdAt.localeCompare(a.createdAt); } catch { return 0; }
  })[0];
  const fallbackEvents = safeEvents.filter((event) => event?.type === "provider_fallback");
  const tokenEvents = safeEvents.filter((event) => event?.type === "token_usage_recorded");
  return (
    <section className="contextAuditPanel" aria-label={zh ? "上下文审计" : "Context audit"}>
      {latestSummary ? (
        <details open>
          <summary>{zh ? "压缩摘要" : "Compaction summary"}</summary>
          <p>{latestSummary.summary ?? ""}</p>
          <div className="auditMeta">
            <span>{zh ? "保留事实" : "Retained"}: {Array.isArray(latestSummary.retainedFacts) ? latestSummary.retainedFacts.length : 0}</span>
            <span>{zh ? "丢弃范围" : "Dropped"}: {Array.isArray(latestSummary.droppedRanges) ? latestSummary.droppedRanges.length : 0}</span>
            {latestSummary.tokenBudget ? <span>{zh ? "预算" : "Budget"}: {latestSummary.tokenBudget.maxTotal}</span> : null}
          </div>
        </details>
      ) : (
        <p className="muted">{zh ? "暂无压缩记录。" : "No compaction records yet."}</p>
      )}
      {fallbackEvents.length > 0 ? (
        <details>
          <summary>{zh ? "模型故障转移" : "Provider fallback"}</summary>
          {fallbackEvents.slice(-3).map((event) => (
            <p key={event.id}>{String(event?.payload?.["fromModel"] ?? "primary")} → {String(event?.payload?.["toModel"] ?? "fallback")} · {String(event?.payload?.["category"] ?? "")}</p>
          ))}
        </details>
      ) : null}
      {tokenEvents.length > 0 ? (
        <details open>
          <summary>{zh ? "Token 与缓存" : "Token usage and cache"}</summary>
          <div className="cacheUsageList">
            {tokenEvents.slice(-5).map((event) => (
              <article className={`cacheUsageRow ${tokenUsageCacheStatus(event)}`} key={event.id}>
                <div>
                  <strong>{formatTokenUsageTitle(event, language)}</strong>
                  <small>{formatTokenUsageDetail(event, language)}</small>
                  <small>{formatTokenUsageTarget(event, language)}</small>
                  <small className="cacheUsageAdvice">{formatTokenUsageAdvice(event, language)}</small>
                </div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function formatTokenUsageTitle(event: TaskEvent, language?: string | null): string {
  const zh = language === "zh-CN";
  const total = numericPayload(event, "totalTokens");
  const input = numericPayload(event, "inputTokens");
  const output = numericPayload(event, "outputTokens");
  if (total !== undefined) return zh ? `总消耗 ${formatInteger(total)} tokens` : `${formatInteger(total)} total tokens`;
  if (input !== undefined || output !== undefined) {
    return zh
      ? `输入 ${formatInteger(input ?? 0)} / 输出 ${formatInteger(output ?? 0)} tokens`
      : `${formatInteger(input ?? 0)} input / ${formatInteger(output ?? 0)} output tokens`;
  }
  return event.summary || (zh ? "Token 用量记录" : "Token usage recorded");
}

function tokenUsageCacheStatus(event: TaskEvent): "met" | "below" | "warming" {
  const met = event.payload["cacheTargetMet"];
  if (met === true) return "met";
  if (met === false) return "below";
  return "warming";
}

function formatTokenUsageDetail(event: TaskEvent, language?: string | null): string {
  const zh = language === "zh-CN";
  const cached = numericPayload(event, "cachedTokens") ?? 0;
  const hit = numericPayload(event, "cacheHitRatio");
  const rolling = numericPayload(event, "rollingCacheHitRatio");
  const parts = [
    zh ? `命中缓存 ${formatInteger(cached)} tokens` : `cached ${formatInteger(cached)} tokens`,
    hit === undefined ? null : (zh ? `本次 ${formatPercent(hit)}` : `turn ${formatPercent(hit)}`),
    rolling === undefined ? null : (zh ? `滚动 ${formatPercent(rolling)}` : `rolling ${formatPercent(rolling)}`)
  ].filter((item): item is string => Boolean(item));
  return parts.join(" · ");
}

function formatTokenUsageTarget(event: TaskEvent, language?: string | null): string {
  const zh = language === "zh-CN";
  const target = numericPayload(event, "cacheTargetHitRatio") ?? 0.9;
  const met = event.payload["cacheTargetMet"];
  if (met === true) return zh ? `已达到 ${formatPercent(target)} 缓存命中目标` : `${formatPercent(target)} cache target met`;
  if (met === false) return zh ? `低于 ${formatPercent(target)} 缓存命中目标` : `below ${formatPercent(target)} cache target`;
  return zh ? `正在预热 ${formatPercent(target)} 缓存命中目标` : `warming ${formatPercent(target)} cache target`;
}

function formatTokenUsageAdvice(event: TaskEvent, language?: string | null): string {
  const zh = language === "zh-CN";
  const source = String(event.payload["source"] ?? "");
  const cached = numericPayload(event, "cachedTokens") ?? 0;
  const hit = numericPayload(event, "cacheHitRatio");
  const met = event.payload["cacheTargetMet"];
  if (source === "local_response") {
    return zh
      ? "本地响应缓存已复用最终回复；保持相同模型、API Base 与工具结果可继续降低重复请求。"
      : "Local response cache reused the final answer; keep the same model, API base, and tool evidence to reduce repeat calls.";
  }
  if (met === true) {
    return zh
      ? "缓存表现达标；继续减少模型、Base URL 与工具集合切换，避免无谓打散上下文。"
      : "Cache performance is on target; avoid needless model, base URL, and tool-set churn.";
  }
  if (cached === 0) {
    return zh
      ? "未看到 provider 缓存命中；检查当前厂商是否支持 prompt cache，并保持长前缀稳定。"
      : "No provider cache hit yet; confirm this provider supports prompt cache and keep long prefixes stable.";
  }
  if (met === false || (hit !== undefined && hit < 0.9)) {
    return zh
      ? "命中率偏低；优先稳定系统提示、知识摘要、模型与工具集合，不要削减完成任务所需上下文。"
      : "Hit rate is low; stabilize system prompts, knowledge summaries, model, and tools without removing needed context.";
  }
  return zh
    ? "缓存仍在预热；相同任务形态重复运行后会更接近真实命中率。"
    : "Cache is still warming; repeated similar task shapes will make the hit rate more representative.";
}

function numericPayload(event: TaskEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function deriveRollbackTimelinePoints(events: TaskEvent[], language?: string | null): RollbackTimelinePoint[] {
  const points: RollbackTimelinePoint[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.type !== "task_checkpoint_created") continue;
    const checkpointId = String(event.payload["checkpointId"] ?? "").trim();
    if (!checkpointId) continue;
    const toolCallId = String(event.payload["toolCallId"] ?? "").trim();
    const toolRequest = toolCallId ? findToolRequest(events, toolCallId) : undefined;
    const fileLabel = rollbackFileLabel(event, toolRequest, language);
    points.push({
      checkpointId,
      eventId: event.id,
      toolName: String(event.payload["toolName"] ?? toolRequest?.payload["toolName"] ?? "tool"),
      fileLabel,
      fileCount: Math.max(0, Number(event.payload["fileCount"] ?? 0)),
      createdAt: event.createdAt,
      sequence: points.length + 1,
      rolledBack: events.some((candidate) => candidate.type === "task_rollback_completed" && String(candidate.payload["checkpointId"] ?? "") === checkpointId && !candidate.reverted)
    });
  }
  return points;
}

function findToolRequest(events: TaskEvent[], toolCallId: string): TaskEvent | undefined {
  return events.find((event) => event.type === "tool_requested" && String(event.payload["toolCallId"] ?? "") === toolCallId);
}

function rollbackFileLabel(checkpointEvent: TaskEvent, toolRequest: TaskEvent | undefined, language?: string | null): string {
  const args = toolRequest?.payload["args"] && typeof toolRequest.payload["args"] === "object"
    ? (toolRequest.payload["args"] as Record<string, unknown>)
    : {};
  const directPath = String(args["path"] ?? args["file"] ?? "").trim();
  if (directPath) return compactPath(directPath);
  const count = Math.max(0, Number(checkpointEvent.payload["fileCount"] ?? 0));
  if (count > 0) return language === "zh-CN" ? `${count} 个文件快照` : `${count} file snapshots`;
  return String(checkpointEvent.payload["toolName"] ?? toolRequest?.payload["toolName"] ?? "workspace change");
}

function formatRollbackPointMeta(point: RollbackTimelinePoint, language?: string | null): string {
  const zh = language === "zh-CN";
  const parts = [
    `${zh ? "回滚点" : "Checkpoint"} ${point.sequence}`,
    formatClock(point.createdAt, language),
    point.toolName,
    point.rolledBack ? (zh ? "已回滚过" : "rolled back") : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function compactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : normalized;
}

function formatClock(value: string, language?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(language === "zh-CN" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
}

function derivePlanSteps(task: TaskDetail): Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> {
  const safeEvents = Array.isArray(task?.events) ? task.events : [];
  const revised = [...safeEvents].reverse().find((event) => event?.type === "plan_revised" && Array.isArray(event?.payload?.["steps"]));
  const initial = revised ?? safeEvents.find((event) => event?.type === "plan_created");
  const rawSteps = Array.isArray(initial?.payload?.["steps"]) ? initial.payload["steps"] : [];
  if (initial?.payload?.["status"] === "empty") return [];
  const steps: Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> = rawSteps
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item["id"] ?? item["title"] ?? Math.random()),
      title: String(item["title"] ?? "Step"),
      status: normalizeStepStatus(item["status"]),
      ...(typeof item["detail"] === "string" ? { detail: item["detail"] } : {})
    }));
  for (const event of safeEvents) {
    if (!event?.type?.startsWith("plan_step_")) continue;
    const toolCallId = String(event?.payload?.["toolCallId"] ?? event.id);
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
  if (task.status === "running" || task.status === "waiting_approval" || task.status === "waiting_for_user") return "guidance";
  return "continue";
}

function getThreadMeta(task: TaskDetail | null, mode: ComposerMode, language?: string | null): string {
  const text = getUiCopy(language).thread;
  if (!task) return text.ready;
  const status = String(task.status ?? "unknown").replace("_", " ");
  if (mode === "guidance") return text.runningGuidance;
  return text.continueTask(status);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatUserFacingError(error: string, language?: string | null): string {
  const zh = language === "zh-CN";
  const normalized = error.replace(/\s+/g, " ").trim();
  if (/connection error|failed to fetch|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(normalized)) {
    return zh
      ? "模型服务连接失败。请检查模型配置、Base URL、API Key 或网络状态，然后重试。"
      : "The model service could not be reached. Check the model configuration, Base URL, API key, or network, then retry.";
  }
  if (/no model provider|no provider|not configured/i.test(normalized)) {
    return zh
      ? "尚未配置可用模型。请先连接或添加模型配置。"
      : "No usable model is configured. Connect or add a model configuration first.";
  }
  if (/请求参数有误|request data validation|invalid/i.test(normalized)) {
    return zh
      ? "请求内容未通过校验。请检查输入、附件或模型配置后重试。"
      : "The request did not pass validation. Check the input, attachments, or model configuration, then retry.";
  }
  return normalized;
}

function NewTaskHero({
  language
}: {
  language?: string | null;
}) {
  const text = getUiCopy(language).thread;
  const heroTitleVariants = (text as unknown as { heroTitleVariants?: readonly string[] }).heroTitleVariants;
  const heroSubtitleVariants = (text as unknown as { heroSubtitleVariants?: readonly string[] }).heroSubtitleVariants;
  const title = Array.isArray(heroTitleVariants) && heroTitleVariants[0] ? heroTitleVariants[0] : text.heroTitle;
  const subtitle = Array.isArray(heroSubtitleVariants) && heroSubtitleVariants[0] ? heroSubtitleVariants[0] : text.heroSubtitle;

  return (
    <div className="newTaskHero">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}
