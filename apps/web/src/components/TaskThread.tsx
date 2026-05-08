import type { ApprovalDecision, TaskAttachment, TaskDetail, UserPreferences } from "@scc/shared";
import { AlertCircle, Menu, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { Composer, type ComposerMode, type ComposerPermissionMode, type PermissionPreset } from "./Composer.js";
import type { EngineStatus } from "./TaskList.js";
import { Timeline } from "./Timeline.js";
import type { ConversationSummary, PromptCacheStats, TaskRollbackPreview, TaskRollbackRequest, TaskRollbackResult } from "@scc/shared";

export function TaskThread({
  task,
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
  onCancelBusy,
  onPreviewRollback,
  onRollback,
  onRevertLatestTurn,
  onLoadContextSummaries,
  onLoadPromptCacheStats,
  titleIssue,
  onRetryTitle,
  onUseLocalTitle,
  onApprovalDecision
}: {
  task: TaskDetail | null;
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
  onCancelBusy?: () => void;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
  onRevertLatestTurn?: (() => Promise<string>) | undefined;
  onLoadContextSummaries?: (() => Promise<ConversationSummary[]>) | undefined;
  onLoadPromptCacheStats?: (() => Promise<PromptCacheStats[]>) | undefined;
  titleIssue?: { goal: string; error: string } | null;
  onRetryTitle: () => void;
  onUseLocalTitle: () => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const running = task?.status === "running" || task?.status === "waiting_approval";
  const mode = getComposerMode(task);
  const text = getUiCopy(language);
  const [draft, setDraft] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setDraft("");
  }, [task?.id]);

  useEffect(() => {
    if (!busy || !busySince) {
      setElapsedMs(0);
      return;
    }
    const interval = window.setInterval(() => {
      setElapsedMs(Math.round(performance.now() - busySince));
    }, 200);
    return () => window.clearInterval(interval);
  }, [busy, busySince]);

  const showCancelButton = busy && elapsedMs > 5000;

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

      {error || titleIssue || showCancelButton ? (
        <div className="threadAlerts">
          {error ? (
            <div className="errorLine" role="status">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{formatUserFacingError(error, language)}</span>
            </div>
          ) : null}
          {showCancelButton && onCancelBusy ? (
            <button className="cancelBusyButton" type="button" onClick={onCancelBusy} title="取消当前请求">
              <X size={14} />
              {formatElapsed(elapsedMs)}
            </button>
          ) : null}
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
      <div className={task ? "threadWorkspace" : "threadWorkspace newTaskWorkspace"}>
        <div className="threadContentRail">
          {task ? (
            <div className="threadMain">
              <Timeline
                language={language ?? null}
                task={task}
                onApprovalDecision={onApprovalDecision}
                onRevertLatestTurn={async () => {
                  if (!onRevertLatestTurn) return;
                  const revertedDraft = await onRevertLatestTurn();
                  if (revertedDraft) setDraft(revertedDraft);
                }}
              />
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
        </div>
        {task ? (
          <TaskPlanPanel
            language={language ?? null}
            task={task}
            onPreviewRollback={onPreviewRollback}
            onRollback={onRollback}
            onLoadContextSummaries={onLoadContextSummaries}
            onLoadPromptCacheStats={onLoadPromptCacheStats}
          />
        ) : null}
      </div>
    </section>
  );
}

function TaskPlanPanel({
  language,
  task,
  onPreviewRollback,
  onRollback,
  onLoadContextSummaries,
  onLoadPromptCacheStats
}: {
  language?: string | null;
  task: TaskDetail;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
  onLoadContextSummaries?: (() => Promise<ConversationSummary[]>) | undefined;
  onLoadPromptCacheStats?: (() => Promise<PromptCacheStats[]>) | undefined;
}) {
  const zh = language === "zh-CN";
  const steps = derivePlanSteps(task);
  const checkpointCount = task.events.filter((event) => event.type === "task_checkpoint_created").length;
  const hasAudit = task.events.some((event) => event.type === "conversation_summary_created" || event.type === "context_overflow_recovered" || event.type === "prompt_cache_stats" || event.type === "provider_fallback");
  const [rollbackPreview, setRollbackPreview] = useState<TaskRollbackPreview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [rollbackResult, setRollbackResult] = useState<TaskRollbackResult | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [cacheStats, setCacheStats] = useState<PromptCacheStats[]>([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = window.localStorage.getItem("scc.planPanel.collapsed");
      if (stored === "1") return true;
      if (stored === "0") return false;
      return window.matchMedia?.("(max-width: 760px)").matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("scc.planPanel.collapsed", collapsed ? "1" : "0");
    } catch {
      // Ignore storage failures; the panel remains usable for the current session.
    }
  }, [collapsed]);
  if (steps.length === 0 && checkpointCount === 0 && !hasAudit) return null;

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
          <div className="planPanelActions">
            {checkpointCount > 0 && onPreviewRollback && onRollback ? (
              <button className="rollbackButton" type="button" onClick={() => void openRollbackPreview()}>
                {zh ? "检查回滚点" : "Review checkpoints"}
              </button>
            ) : null}
            {hasAudit || onLoadContextSummaries || onLoadPromptCacheStats ? (
              <button className="rollbackButton" type="button" onClick={() => void toggleAudit()}>
                {auditOpen ? (zh ? "收起上下文审计" : "Hide context audit") : (zh ? "上下文审计" : "Context audit")}
              </button>
            ) : null}
          </div>
          {rollbackError && !rollbackPreview ? <p className="formError">{rollbackError}</p> : null}
          {auditOpen ? <ContextAuditView language={language ?? null} summaries={summaries} cacheStats={cacheStats} task={task} /> : null}
          {rollbackPreview ? (
            <div className="rollbackModalBackdrop" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) closeRollback(); }}>
              <section className="rollbackModal" aria-label={zh ? "回滚预览" : "Rollback preview"}>
                <header>
                  <div>
                    <h3>{zh ? "回滚预览" : "Rollback preview"}</h3>
                    <p>{rollbackPreview.workRoot}</p>
                  </div>
                  <button type="button" onClick={closeRollback}>×</button>
                </header>
                <div className="rollbackSummary">
                  <span>{zh ? "可恢复" : "Restorable"}: {rollbackPreview.restorableFiles}</span>
                  <span>{zh ? "新增文件" : "New files"}: {rollbackPreview.deletableFiles}</span>
                  <span>{zh ? "跳过" : "Skipped"}: {rollbackPreview.skippedFiles}</span>
                </div>
                <div className="rollbackFileList">
                  {rollbackPreview.files.map((file) => (
                    <label className={file.canRollback ? "rollbackFileRow" : "rollbackFileRow disabled"} key={file.path}>
                      <input
                        checked={selectedFiles.has(file.path)}
                        disabled={!file.canRollback}
                        type="checkbox"
                        onChange={() => {
                          setSelectedFiles((current) => {
                            const next = new Set(current);
                            if (next.has(file.path)) next.delete(file.path);
                            else next.add(file.path);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <strong>{file.relativePath}</strong>
                        <small>{file.status}{file.reason ? ` · ${file.reason}` : ""}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {rollbackError ? <p className="formError">{rollbackError}</p> : null}
                {rollbackResult ? (
                  <div className="rollbackResult">
                    {zh ? "已完成" : "Completed"}: {rollbackResult.restoredFiles} restored, {rollbackResult.deletedFiles} deleted, {rollbackResult.skippedFiles} skipped.
                  </div>
                ) : null}
                <footer>
                  <button className="stdCancelBtn" type="button" onClick={closeRollback}>{zh ? "关闭" : "Close"}</button>
                  <button className="primaryInlineButton" disabled={rollbackBusy || selectedFiles.size === 0} type="button" onClick={() => void runRollback()}>
                    {rollbackBusy ? (zh ? "回滚中..." : "Rolling back...") : (zh ? "回滚所选文件" : "Rollback selected")}
                  </button>
                </footer>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
    </>
  );

  async function openRollbackPreview() {
    if (!onPreviewRollback) return;
    setRollbackBusy(true);
    setRollbackError(null);
    setRollbackResult(null);
    try {
      const preview = await onPreviewRollback();
      setRollbackPreview(preview);
      setSelectedFiles(new Set(preview.files.filter((file) => file.canRollback).map((file) => file.path)));
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackBusy(false);
    }
  }

  async function runRollback() {
    if (!onRollback || !rollbackPreview) return;
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const result = await onRollback({ checkpointId: rollbackPreview.checkpointId, filePaths: [...selectedFiles] });
      setRollbackResult(result);
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackBusy(false);
    }
  }

  async function toggleAudit() {
    const nextOpen = !auditOpen;
    setAuditOpen(nextOpen);
    if (!nextOpen) return;
    const [nextSummaries, nextStats] = await Promise.all([onLoadContextSummaries?.() ?? [], onLoadPromptCacheStats?.() ?? []]);
    setSummaries(nextSummaries);
    setCacheStats(nextStats);
  }

  function closeRollback() {
    setRollbackPreview(null);
    setRollbackError(null);
    setRollbackResult(null);
  }
}

function ContextAuditView({ language, summaries, cacheStats, task }: { language?: string | null; summaries: ConversationSummary[]; cacheStats: PromptCacheStats[]; task: TaskDetail }) {
  const zh = language === "zh-CN";
  const latestSummary = [...summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestCache = [...cacheStats].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const fallbackEvents = task.events.filter((event) => event.type === "provider_fallback");
  return (
    <section className="contextAuditPanel" aria-label={zh ? "上下文审计" : "Context audit"}>
      {latestSummary ? (
        <details open>
          <summary>{zh ? "压缩摘要" : "Compaction summary"}</summary>
          <p>{latestSummary.summary}</p>
          <div className="auditMeta">
            <span>{zh ? "保留事实" : "Retained"}: {latestSummary.retainedFacts.length}</span>
            <span>{zh ? "丢弃范围" : "Dropped"}: {latestSummary.droppedRanges.length}</span>
            {latestSummary.tokenBudget ? <span>{zh ? "预算" : "Budget"}: {latestSummary.tokenBudget.maxTotal}</span> : null}
          </div>
        </details>
      ) : (
        <p className="muted">{zh ? "暂无压缩记录。" : "No compaction records yet."}</p>
      )}
      {latestCache ? (
        <details>
          <summary>{zh ? "缓存成本" : "Prompt cache"}</summary>
          <div className="auditMeta">
            <span>{latestCache.model}</span>
            <span>{Math.round(latestCache.cacheHitRatio * 100)}% hit</span>
            <span>{latestCache.cachedTokens}/{latestCache.inputTokens} cached</span>
            <span>{latestCache.source}</span>
          </div>
        </details>
      ) : null}
      {fallbackEvents.length > 0 ? (
        <details>
          <summary>{zh ? "模型故障转移" : "Provider fallback"}</summary>
          {fallbackEvents.slice(-3).map((event) => (
            <p key={event.id}>{String(event.payload["fromModel"] ?? "primary")} → {String(event.payload["toModel"] ?? "fallback")} · {String(event.payload["category"] ?? "")}</p>
          ))}
        </details>
      ) : null}
    </section>
  );
}

function derivePlanSteps(task: TaskDetail): Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "blocked"; detail?: string }> {
  const revised = [...task.events].reverse().find((event) => event.type === "plan_revised" && Array.isArray(event.payload["steps"]));
  const initial = revised ?? task.events.find((event) => event.type === "plan_created");
  const rawSteps = Array.isArray(initial?.payload["steps"]) ? initial.payload["steps"] : [];
  if (initial?.payload["status"] === "empty") return [];
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
