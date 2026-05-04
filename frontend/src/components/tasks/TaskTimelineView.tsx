import { Badge, lifecycleBadgeVariant } from '../ui/badge';
import {
  TimelineAgentIcon,
  TimelineArtifactIcon,
  TimelineDecisionIcon,
  TimelineDelegationIcon,
  TimelineRuntimeIcon,
  TimelineUserIcon,
} from '../ui/icons';
import type {
  RuntimeEvent,
  TaskDebugResponse,
  TaskDetail,
  VisibleToolActivity,
} from '../../types';
import {
  formatTime,
  getAssistantSummaryBadgeLabel,
  getKnownArtifactState,
  getToolActivityDisplayName,
  getToolActivityStatusLabel,
  getToolActivityTone,
  isMachineCorrectionText,
  renderToolActivityIcon,
  requiresArtifactSelection,
  stripLeadingRepeatedToolName,
  summarizeTimelineInstruction,
  TimelineNodeFrame,
  truncateToolOutput,
  type ApprovalListEntry,
  type TimelineEntry,
} from './taskPageModel';
import { TaskThinkingProcess } from './TaskThinkingProcess';

interface TaskTimelineViewProps {
  task: TaskDetail | null;
  debug: TaskDebugResponse | null;
  events: RuntimeEvent[];
  timeline: TimelineEntry[];
  taskError: string | null;
  taskLoading: boolean;
  selectedTaskId: string | null;
  busyAction: string | null;
  primaryApproval: ApprovalListEntry | null;
  primaryApprovalArgumentSummary: string | null;
  shouldShowTaskLoadingShell: boolean;
  onResolveApproval: (approval: ApprovalListEntry, status: 'APPROVED' | 'APPROVED_ONCE' | 'REJECTED') => void;
}

export function TaskTimelineView({
  task,
  debug,
  events,
  timeline,
  taskError,
  shouldShowTaskLoadingShell,
  selectedTaskId,
  busyAction,
  primaryApproval,
  primaryApprovalArgumentSummary,
  onResolveApproval,
}: TaskTimelineViewProps) {
  if (taskError) {
    return (
      <div className="mb-4 rounded-2xl border border-error/30 bg-error-muted/20 px-4 py-3 text-sm text-error">
        {taskError}
      </div>
    );
  }

  if (task?.isArchived) {
    return (
      <div data-testid="task-archive-banner" className="mb-4 max-w-3xl rounded-lg border border-border-subtle bg-surface/26 px-4 py-4">
        <p className="text-[11px] uppercase tracking-[0.26em] text-text-muted">Archived</p>
        <p className="mt-2 text-sm font-medium text-text-primary">
          This thread is archived and hidden from the default work queue.
        </p>
        <p className="mt-1 text-sm leading-6 text-text-secondary">
          Keep it archived to store the outcome quietly, or unarchive it when you want this thread back in the active workspace.
        </p>
      </div>
    );
  }

  if (primaryApproval) {
    return (
      <div
        data-testid="task-approval-banner"
        className="mb-4 max-w-3xl rounded-lg border border-warning/24 bg-warning-muted/12 px-4 py-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] uppercase tracking-[0.26em] text-text-muted">Approval required</p>
              <Badge variant="warning">{primaryApproval.toolName}</Badge>
            </div>
            <p className="mt-2 text-sm font-medium text-text-primary">
              Choose how this tool request should run before the thread continues.
            </p>
            {primaryApproval.riskCategory ? (
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Risk: {primaryApproval.riskCategory.replace(/_/g, ' ')}
              </p>
            ) : null}
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              Invocation {primaryApproval.invocationId}
            </p>
            {primaryApprovalArgumentSummary ? (
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Request: {primaryApprovalArgumentSummary}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              data-testid="task-banner-approve"
              type="button"
              disabled={!selectedTaskId || busyAction !== null}
              onClick={() => onResolveApproval(primaryApproval, 'APPROVED')}
              className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              Allow similar
            </button>
            <button
              data-testid="task-banner-approve-once"
              type="button"
              disabled={!selectedTaskId || busyAction !== null}
              onClick={() => onResolveApproval(primaryApproval, 'APPROVED_ONCE')}
              className="inline-flex h-8 items-center rounded-md border border-border-default bg-surface-elevated px-3 text-sm text-text-primary transition hover:bg-surface-hover disabled:opacity-50"
            >
              Allow once
            </button>
            <button
              data-testid="task-banner-reject"
              type="button"
              disabled={!selectedTaskId || busyAction !== null}
              onClick={() => onResolveApproval(primaryApproval, 'REJECTED')}
              className="inline-flex h-8 items-center rounded-md border border-border-default bg-surface-elevated px-3 text-sm text-text-primary transition hover:bg-surface-hover disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (shouldShowTaskLoadingShell) {
    return (
      <div
        data-testid="task-loading-shell"
        className="max-w-3xl rounded-lg border border-border-subtle bg-surface/42 px-6 py-6"
      >
        <p className="text-xs uppercase tracking-[0.3em] text-text-muted">Loading thread</p>
        <h3 className="mt-3 text-xl font-semibold text-text-primary">Pulling the latest task truth</h3>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          We are loading the selected thread before rendering the timeline so the workspace stays stable during navigation and refresh.
        </p>
      </div>
    );
  }

  if (!task) {
    return (
      <div
        data-testid="task-empty-state"
        className="mx-auto max-w-3xl rounded-lg border border-dashed border-violet-300/24 bg-surface/42 px-6 py-6"
      >
        <div data-testid="task-empty-agent-state" className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <img
            src="/logo.png"
            alt="SCC Batch"
            className="h-16 w-16 rounded-xl border border-white/10 object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.3em] text-text-muted">Agent workspace</p>
            <h3 className="mt-3 text-xl font-semibold text-text-primary">Start with a conversation, finish with evidence</h3>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
              The task workspace is ready. Connect a provider, check ecosystem readiness, or create a generic Agent task to start the main path.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-conversation space-y-3" data-testid="task-conversation">
      {timeline.map((entry) => renderTimelineEntry(entry, task, debug, events, selectedTaskId, busyAction, onResolveApproval))}
      {timeline.length === 0 && (
        <div data-testid="task-empty-timeline" className="w-full max-w-2xl rounded-lg border border-border-subtle bg-surface/26 px-4 py-4 sm:px-5">
          <p className="text-[11px] uppercase tracking-[0.26em] text-text-muted">Timeline</p>
          <p data-testid="task-empty-timeline-copy" className="mt-2 max-w-2xl text-sm font-medium leading-6 text-text-primary">
            The conversation will appear here as soon as the thread starts exchanging messages.
          </p>
          <p data-testid="task-empty-timeline-support" className="mt-1 max-w-2xl text-sm leading-6 text-text-secondary">
            Use the action bar below to start, resume, or continue this thread when it is ready.
          </p>
        </div>
      )}
    </div>
  );
}

function renderTimelineEntry(
  entry: TimelineEntry,
  task: TaskDetail,
  debug: TaskDebugResponse | null,
  events: RuntimeEvent[],
  selectedTaskId: string | null,
  busyAction: string | null,
  onResolveApproval: (approval: ApprovalListEntry, status: 'APPROVED' | 'APPROVED_ONCE' | 'REJECTED') => void,
): React.ReactElement {
  if (entry.kind === 'delegation') {
    return renderDelegationEntry(entry);
  }

  if (entry.kind === 'tool-activity') {
    return renderToolActivityEntry(entry);
  }

  if (entry.kind === 'result' || entry.kind === 'assistant-update') {
    return renderResultEntry(entry, task, debug);
  }

  if (entry.kind === 'result-missing') {
    return renderResultMissingEntry(entry, task, debug);
  }

  if (entry.kind === 'proposal') {
    return renderProposalEntry(entry);
  }

  if (entry.kind === 'proposal-note') {
    return renderProposalNoteEntry(entry);
  }

  return renderGenericEntry(entry, task);
}

function renderDelegationEntry(entry: TimelineEntry & { kind: 'delegation' }) {
  const badgeVariant = lifecycleBadgeVariant(entry.childStatus) ?? (entry.active ? 'info' : 'outline');
  return (
    <TimelineNodeFrame key={entry.id} kind="delegation">
      <div
        key={entry.id}
        data-testid="task-delegation-card"
        className={`max-w-3xl rounded-lg border px-4 py-3 ${entry.active ? 'border-violet-400/20 bg-violet-950/14' : 'border-border-subtle bg-surface/30'}`}
      >
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span data-testid="task-timeline-glyph-delegation-inline" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-violet-300/24 bg-violet-400/10 text-violet-100">
              <TimelineDelegationIcon className="h-3.5 w-3.5" />
            </span>
            <span>{entry.label}</span>
            <Badge variant={badgeVariant}>{entry.active ? 'subtask running' : entry.childStatus.toLowerCase()}</Badge>
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-text-primary">
            {entry.active
              ? `Delegated "${entry.childTitle}" to a SubSccAgent.`
              : `Delegated subtask "${entry.childTitle}" returned.`}
          </p>
          {entry.childGoal ? (
            <p className="text-sm leading-6 text-text-secondary">
              Scope: {entry.childGoal}
            </p>
          ) : null}
          {entry.childSummary ? (
            <p data-testid="task-delegation-summary" className="text-sm leading-6 text-text-secondary">
              {entry.childSummary}
            </p>
          ) : (
            <p data-testid="task-delegation-summary" className="text-sm leading-6 text-text-secondary">
              {entry.active
                ? 'The child task is still running within the parent thread boundary.'
                : 'The child task finished and returned a scoped result to this thread.'}
            </p>
          )}
        </div>
      </div>
    </TimelineNodeFrame>
  );
}

function renderToolActivityEntry(entry: TimelineEntry & { kind: 'tool-activity' }) {
  const tone = getToolActivityTone(entry.activity.status);
  const evidenceLabel = entry.activity.evidencePaths.length === 1
    ? entry.activity.evidencePaths[0]
    : entry.activity.evidencePaths.length > 1
      ? `${entry.activity.evidencePaths[0]} +${entry.activity.evidencePaths.length - 1} more`
      : null;
  return (
    <TimelineNodeFrame key={entry.id} kind="tool" activity={entry.activity}>
      <details
        data-testid="task-tool-activity"
        className={`max-w-[52rem] rounded-lg border px-3.5 py-2.5 ${tone.shell}`}
      >
        <summary
          data-testid="task-tool-activity-summary"
          className="flex cursor-pointer list-none items-center justify-between gap-3"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span
              data-testid="task-tool-activity-icon"
              className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/8 bg-black/15 ${tone.meta}`}
            >
              <span data-testid="task-timeline-tool-icon" className="inline-flex">
                {renderToolActivityIcon(entry.activity)}
              </span>
            </span>
            <div className="min-w-0">
              <div className={`flex flex-wrap items-center gap-2 text-xs ${tone.meta}`}>
                <span className={`inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] ${tone.meta}`}>
                  <span className="status-dot" />
                  {getToolActivityStatusLabel(entry.activity.status)}
                </span>
                <span className="font-semibold text-text-primary">{getToolActivityDisplayName(entry.activity)}</span>
                {entry.activity.execution?.durationMs !== null && entry.activity.execution?.durationMs !== undefined ? (
                  <span className="uppercase tracking-[0.18em] text-text-muted/85">
                    {entry.activity.execution.durationMs}ms
                  </span>
                ) : null}
                {entry.activity.approvalStatus ? (
                  <span className="uppercase tracking-[0.18em] text-text-muted/85">
                    approval {entry.activity.approvalStatus.toLowerCase()}
                  </span>
                ) : null}
              </div>
              <p className={`mt-1.5 text-sm ${tone.text}`}>{stripLeadingRepeatedToolName(entry.activity)}</p>
            </div>
          </div>
          <div className={`shrink-0 text-[11px] ${tone.meta}`}>{formatTime(entry.timestamp)}</div>
        </summary>
        <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
          {entry.activity.detail ? (
            <p className="text-sm leading-6 text-text-secondary">{entry.activity.detail}</p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            {entry.activity.argumentsSummary ? (
              <div className="rounded-lg border border-border-subtle bg-black/8 px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Input</p>
                <p className="mt-2 text-sm text-text-primary">{entry.activity.argumentsSummary}</p>
              </div>
            ) : null}
            {entry.activity.resultSummary ? (
              <div className="rounded-lg border border-border-subtle bg-black/8 px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Result</p>
                <p className="mt-2 text-sm text-text-primary">{entry.activity.resultSummary}</p>
              </div>
            ) : null}
          </div>
          {entry.activity.execution ? (
            <div data-testid="task-tool-activity-execution" className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Execution result</p>
                <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
                  <span>exit {entry.activity.execution.exitCode ?? 'unknown'}</span>
                  {entry.activity.execution.durationMs !== null ? <span>{entry.activity.execution.durationMs}ms</span> : null}
                  {entry.activity.execution.cwd ? <span className="break-all">cwd {entry.activity.execution.cwd}</span> : null}
                </div>
              </div>
              {entry.activity.execution.effectiveCommand || entry.activity.execution.command ? (
                <pre className="mt-2 overflow-x-auto rounded-md border border-white/5 bg-black/20 px-3 py-2 text-xs leading-5 text-text-primary">
                  {entry.activity.execution.effectiveCommand ?? entry.activity.execution.command}
                </pre>
              ) : null}
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">stdout</p>
                  <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-black/20 px-3 py-2 text-xs leading-5 text-text-secondary">
                    {truncateToolOutput(entry.activity.execution.stdout) || '(empty)'}
                  </pre>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">stderr</p>
                  <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-black/20 px-3 py-2 text-xs leading-5 text-text-secondary">
                    {truncateToolOutput(entry.activity.execution.stderr) || '(empty)'}
                  </pre>
                </div>
              </div>
            </div>
          ) : null}
          {entry.activity.evidencePaths.length > 0 && (
            <div data-testid="task-tool-activity-evidence" className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Evidence</p>
              <div className="flex flex-wrap gap-2">
                {entry.activity.evidencePaths.map((item) => (
                  <span
                    key={item}
                    className="rounded-md border border-border-default bg-surface-elevated/75 px-2.5 py-1 text-xs text-text-primary"
                  >
                    {item}
                  </span>
                ))}
              </div>
              {evidenceLabel ? (
                <p className="text-xs text-text-secondary">Touched {evidenceLabel}.</p>
              ) : null}
            </div>
          )}
        </div>
      </details>
    </TimelineNodeFrame>
  );
}

function renderResultEntry(
  entry: TimelineEntry & { kind: 'result' | 'assistant-update' },
  task: TaskDetail,
  debug: TaskDebugResponse | null,
) {
  const providerLabel = [debug?.executionSummary.providerSummary.providerId, debug?.executionSummary.providerSummary.modelId]
    .filter(Boolean)
    .join(' / ');
  const artifactState = getKnownArtifactState({ result: entry.result });
  const technicalSummary = [
    entry.result.unitId ? `Unit ${entry.result.unitId}` : null,
    artifactState.artifactApplyStatus ? `Apply ${artifactState.artifactApplyStatus.toLowerCase()}` : null,
    artifactState.artifactDestinationDir ? `Destination ${artifactState.artifactDestinationDir}` : null,
    providerLabel || null,
  ].filter(Boolean);
  const resultLifecycle = task.runtime.lifecycleStatus;
  const isFailureResult = entry.kind === 'result'
    && (resultLifecycle === 'FAILED' || resultLifecycle === 'CANCELLED' || entry.result.source === 'failure_fallback');

  const cardTone = entry.kind === 'result'
    ? (
      isFailureResult
        ? {
          shell: 'border-rose-400/24 bg-rose-950/18',
          label: 'border border-rose-300/18 bg-rose-400/10 text-rose-100/92',
          summary: 'text-rose-50',
          details: 'text-rose-100/78',
          section: 'border-rose-400/16 bg-black/10',
          chip: 'border-rose-300/24 bg-black/10 text-rose-50/95',
          meta: 'text-rose-100/58'
        }
        : {
          shell: 'border-emerald-400/22 bg-emerald-950/18',
          label: 'border border-emerald-300/18 bg-emerald-400/10 text-emerald-100/92',
          summary: 'text-emerald-50',
          details: 'text-emerald-100/76',
          section: 'border-emerald-400/16 bg-black/10',
          chip: 'border-emerald-300/24 bg-black/10 text-emerald-50/95',
          meta: 'text-emerald-100/58'
        }
    )
    : {
      shell: 'border-sky-400/12 bg-surface/38 shadow-none',
      label: 'border border-sky-300/18 bg-sky-400/10 text-sky-100/85',
      summary: 'text-text-primary',
      details: 'text-text-secondary',
      section: 'border-border-subtle bg-surface/55',
      chip: 'border-border-default bg-surface-elevated/75 text-text-primary',
      meta: 'text-text-muted'
    };

  return (
    <TimelineNodeFrame key={entry.id} kind={entry.kind === 'result' ? 'result' : 'agent'}>
      <div
        data-testid={entry.kind === 'result' ? 'task-result-card' : 'task-assistant-update'}
        className={`max-w-3xl rounded-lg border px-5 py-4 ${cardTone.shell}`}
      >
        <div className={`mb-3 flex items-center justify-between gap-3 text-xs ${cardTone.meta}`}>
          <div className="flex items-center gap-2">
            <span
              data-testid="task-timeline-agent-icon"
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-black/10 ${
                entry.kind === 'result'
                  ? isFailureResult
                    ? 'border-rose-300/20 text-rose-100'
                    : 'border-emerald-300/24 text-emerald-100'
                  : 'border-cyan-300/24 text-cyan-100'
              }`}
            >
              <TimelineAgentIcon className="h-4 w-4" />
            </span>
            <span className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] ${cardTone.label}`}>
              Assistant · {entry.kind === 'result' ? (isFailureResult ? 'Failure' : 'Result') : 'Progress'}
            </span>
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <div className="space-y-3.5">
          <div className="space-y-1">
            <p className={`text-base font-semibold ${cardTone.summary}`}>
              {entry.result.summary}
            </p>
            {entry.kind === 'assistant-update' && entry.result.details && (
              <TaskThinkingProcess
                content={entry.result.details}
                timestamp={entry.timestamp}
                isStreaming={task.runtime.lifecycleStatus === 'RUNNING'}
              />
            )}
            {entry.kind === 'result' && entry.result.details && (
              <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 ${cardTone.details}`}>
                {entry.result.details}
              </p>
            )}
          </div>
          {entry.result.issues.length > 0 && (
            <div className="rounded-lg border border-white/8 bg-black/10 px-3.5 py-3">
              <p className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${cardTone.meta}`}>Issues</p>
              <ul className={`mt-2 list-disc space-y-1.5 pl-4 text-sm ${cardTone.details}`}>
                {entry.result.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {(artifactState.artifactDestinationPaths.length > 0 || artifactState.artifactDestinationDir || artifactState.artifactPaths.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {(artifactState.artifactDestinationPaths.length > 0 || artifactState.artifactDestinationDir) && (
                <div
                  data-testid={entry.kind === 'result' ? 'task-result-destination-section' : undefined}
                  className={`rounded-xl border px-4 py-3 ${cardTone.section}`}
                >
                  <div className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] ${cardTone.meta}`}>
                    <span data-testid="task-timeline-glyph-artifact" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-sky-300/22 bg-sky-400/10 text-sky-100">
                      <TimelineArtifactIcon className="h-3.5 w-3.5" />
                    </span>
                    <span>{artifactState.artifactDestinationPaths.length > 0 ? 'Delivered to' : 'Destination folder'}</span>
                  </div>
                  {artifactState.artifactDestinationPaths.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {artifactState.artifactDestinationPaths.map((artifactPath) => (
                        <span
                          key={artifactPath}
                          data-testid={entry.kind === 'result' ? 'task-result-destination-path' : undefined}
                          className={`rounded-md border px-3 py-1 text-xs ${cardTone.chip}`}
                        >
                          {artifactPath}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p
                      data-testid={entry.kind === 'result' ? 'task-result-destination-folder' : undefined}
                      className={`mt-2 text-sm ${cardTone.details}`}
                    >
                      {artifactState.artifactDestinationDir}
                    </p>
                  )}
                </div>
              )}
              {artifactState.artifactPaths.length > 0 && (
                <div className={`rounded-xl border px-4 py-3 ${cardTone.section}`}>
                  <div className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] ${cardTone.meta}`}>
                    <span data-testid="task-timeline-glyph-artifact" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-sky-300/22 bg-sky-400/10 text-sky-100">
                      <TimelineArtifactIcon className="h-3.5 w-3.5" />
                    </span>
                    <span>Artifacts created</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {artifactState.artifactPaths.map((artifactPath) => (
                      <span
                        key={artifactPath}
                        data-testid={entry.kind === 'result' ? 'task-result-artifact-path' : undefined}
                        className={`rounded-md border px-3 py-1 text-xs ${cardTone.chip}`}
                      >
                        {artifactPath}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {technicalSummary.length > 0 && (
            <details
              data-testid={entry.kind === 'result' ? 'task-result-technical-summary' : 'task-assistant-update-technical-summary'}
              className="group"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-text-muted transition hover:text-text-secondary">
                <span className="inline-block h-px w-3 bg-text-muted/40 transition group-hover:bg-text-muted/60" />
                <span>{entry.kind === 'result' ? 'Technical summary' : 'Runtime summary'}</span>
                <span className="inline-block h-px flex-1 bg-white/5" />
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {technicalSummary.map((item) => (
                  <span key={item} className={`rounded-md border px-3 py-1 text-[11px] ${cardTone.chip}`}>
                    {item}
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </TimelineNodeFrame>
  );
}

function renderResultMissingEntry(
  entry: TimelineEntry & { kind: 'result-missing' },
  task: TaskDetail,
  debug: TaskDebugResponse | null,
) {
  const artifactState = getKnownArtifactState({ completionSummary: task.completionSummary });
  const providerLabel = [debug?.executionSummary.providerSummary.providerId, debug?.executionSummary.providerSummary.modelId]
    .filter(Boolean)
    .join(' / ');
  const isFailureLifecycle = task.runtime.lifecycleStatus === 'FAILED';
  const isCancelledLifecycle = task.runtime.lifecycleStatus === 'CANCELLED';
  const technicalSummary = [
    debug?.executionSummary.lastArtifactApplyResult?.status
      ? `Apply ${debug.executionSummary.lastArtifactApplyResult.status.toLowerCase()}`
      : null,
    artifactState.artifactDestinationDir ? `Destination ${artifactState.artifactDestinationDir}` : null,
    providerLabel || null,
  ].filter(Boolean);

  return (
    <TimelineNodeFrame key={entry.id} kind="decision">
      <div key={entry.id} data-testid="task-result-missing" className={`max-w-3xl rounded-lg border px-5 py-4 ${
        isFailureLifecycle
          ? 'border-rose-400/24 bg-rose-950/18'
          : isCancelledLifecycle
            ? 'border-slate-400/22 bg-slate-950/18'
            : 'border-amber-400/24 bg-amber-950/16'
      }`}>
        <div className={`mb-2 flex items-center justify-between gap-3 text-xs ${
          isFailureLifecycle
            ? 'text-rose-100/62'
            : isCancelledLifecycle
              ? 'text-slate-100/62'
              : 'text-amber-100/62'
        }`}>
          <div className="flex items-center gap-2">
            <span data-testid="task-timeline-glyph-decision-inline" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-300/24 bg-amber-400/10 text-amber-100">
              <TimelineDecisionIcon className="h-3.5 w-3.5" />
            </span>
            <span className="font-semibold">{entry.label}</span>
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <p className={`text-sm font-medium ${
          isFailureLifecycle ? 'text-rose-50' : isCancelledLifecycle ? 'text-slate-50' : 'text-amber-50'
        }`}>
          {isFailureLifecycle
            ? 'Failed without a visible summary'
            : isCancelledLifecycle
              ? 'Cancelled without a visible summary'
              : 'Completed without a visible summary'}
        </p>
        <p className={`mt-1 text-sm ${
          isFailureLifecycle ? 'text-rose-100/78' : isCancelledLifecycle ? 'text-slate-100/78' : 'text-amber-100/78'
        }`}>
          {isFailureLifecycle
            ? 'The task failed before it published a user-facing summary. The latest known failure and artifact details are still shown here so you can see what completed before the stop.'
            : isCancelledLifecycle
              ? 'The task was cancelled before it published a user-facing summary.'
              : 'The task finished, but it did not publish a user-facing summary. The known delivery details are still shown here so you can confirm what landed where.'}
        </p>
        {isFailureLifecycle && task.diagnostics.lastError && (
          <p className="mt-3 rounded-2xl border border-rose-400/20 bg-black/10 px-4 py-3 text-sm text-rose-100/80">
            {task.diagnostics.lastError}
          </p>
        )}
        {(artifactState.artifactDestinationPaths.length > 0 || artifactState.artifactDestinationDir || artifactState.artifactPaths.length > 0) && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {(artifactState.artifactDestinationPaths.length > 0 || artifactState.artifactDestinationDir) && (
              <div className={`rounded-2xl border bg-black/10 px-4 py-3 ${
                isFailureLifecycle ? 'border-rose-400/20' : isCancelledLifecycle ? 'border-slate-400/20' : 'border-amber-400/20'
              }`} data-testid="task-result-missing-destination-section">
                <div className={`flex items-center gap-2 text-xs uppercase tracking-[0.24em] ${
                  isFailureLifecycle ? 'text-rose-100/60' : isCancelledLifecycle ? 'text-slate-100/60' : 'text-amber-100/60'
                }`}>
                  <span data-testid="task-timeline-glyph-artifact" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-sky-300/22 bg-sky-400/10 text-sky-100">
                    <TimelineArtifactIcon className="h-3.5 w-3.5" />
                  </span>
                  <span>{artifactState.artifactDestinationPaths.length > 0 ? 'Delivered to' : 'Destination folder'}</span>
                </div>
                {artifactState.artifactDestinationPaths.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {artifactState.artifactDestinationPaths.map((artifactPath) => (
                      <span key={artifactPath} data-testid="task-result-missing-destination-path" className={`rounded-md border bg-black/15 px-3 py-1 text-xs ${
                        isFailureLifecycle
                          ? 'border-rose-300/28 text-rose-50'
                          : isCancelledLifecycle
                            ? 'border-slate-300/28 text-slate-50'
                            : 'border-amber-300/28 text-amber-50'
                      }`}>
                        {artifactPath}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p data-testid="task-result-missing-destination-folder" className={`mt-2 text-sm ${
                    isFailureLifecycle ? 'text-rose-100/78' : isCancelledLifecycle ? 'text-slate-100/78' : 'text-amber-100/78'
                  }`}>{artifactState.artifactDestinationDir}</p>
                )}
              </div>
            )}
            {artifactState.artifactPaths.length > 0 && (
              <div>
                <div className={`flex items-center gap-2 text-xs uppercase tracking-[0.24em] ${
                  isFailureLifecycle ? 'text-rose-100/60' : isCancelledLifecycle ? 'text-slate-100/60' : 'text-amber-100/60'
                }`}>
                  <span data-testid="task-timeline-glyph-artifact" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-sky-300/22 bg-sky-400/10 text-sky-100">
                    <TimelineArtifactIcon className="h-3.5 w-3.5" />
                  </span>
                  <span>Artifacts created</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {artifactState.artifactPaths.map((artifactPath) => (
                    <span key={artifactPath} data-testid="task-result-missing-artifact-path" className={`rounded-md border bg-black/15 px-3 py-1 text-xs ${
                      isFailureLifecycle
                        ? 'border-rose-300/28 text-rose-50'
                        : isCancelledLifecycle
                          ? 'border-slate-300/28 text-slate-50'
                          : 'border-amber-300/28 text-amber-50'
                    }`}>
                      {artifactPath}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {technicalSummary.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className={`text-[11px] uppercase tracking-[0.24em] ${
              isFailureLifecycle ? 'text-rose-100/60' : isCancelledLifecycle ? 'text-slate-100/60' : 'text-amber-100/60'
            }`}>Technical summary</p>
            <div className="flex flex-wrap gap-2">
              {technicalSummary.map((item) => (
                <span key={item} className={`rounded-md border bg-black/15 px-3 py-1 text-[11px] ${
                  isFailureLifecycle
                    ? 'border-rose-300/35 text-rose-50'
                    : isCancelledLifecycle
                      ? 'border-slate-300/35 text-slate-50'
                      : 'border-amber-300/35 text-amber-50'
                }`}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </TimelineNodeFrame>
  );
}

function renderProposalEntry(entry: TimelineEntry & { kind: 'proposal' }) {
  const tone = entry.proposal.kind === 'experience'
    ? 'border-cyan-400/18 bg-cyan-950/12'
    : entry.proposal.kind === 'instruction_skill'
    ? 'border-fuchsia-400/18 bg-fuchsia-950/12'
    : entry.proposal.kind === 'optimization'
      ? 'border-amber-400/20 bg-amber-950/12'
      : 'border-emerald-400/18 bg-emerald-950/12';
  const badgeTone = entry.proposal.status === 'APPROVED'
    ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
    : entry.proposal.status === 'REJECTED'
      ? 'border-border-default bg-surface-elevated/70 text-text-primary'
      : 'border-sky-300/24 bg-sky-400/10 text-sky-100/82';
  const proposalDetail = entry.proposal.kind === 'lesson'
    ? entry.proposal.lessonProposal?.triggerPattern
    : entry.proposal.kind === 'experience'
      ? entry.proposal.experienceProposal?.referenceSummary
    : entry.proposal.kind === 'instruction_skill'
      ? entry.proposal.instructionSkillProposal?.validationSummary
      : entry.proposal.optimizationRecommendation?.category;

  return (
    <TimelineNodeFrame key={entry.id} kind="decision">
      <div key={entry.id} className={`max-w-3xl rounded-lg border px-4 py-4 ${tone}`} data-testid={`task-proposal-${entry.proposal.kind}`}>
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="task-timeline-glyph-decision-inline" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-300/24 bg-amber-400/10 text-amber-100">
              <TimelineDecisionIcon className="h-3.5 w-3.5" />
            </span>
            <span>{entry.label}</span>
            <span className={`rounded-md border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] ${badgeTone}`}>
              {entry.proposal.kind.replace('_', ' ')} · {entry.proposal.status.toLowerCase()}
            </span>
            {entry.proposal.conflictsWithProposalIds.length > 0 ? (
              <span className="rounded-md border border-amber-300/35 bg-amber-400/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-50">
                conflicting lesson
              </span>
            ) : null}
            {entry.proposal.duplicateOfProposalId ? (
              <span className="rounded-md border border-amber-300/35 bg-amber-400/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-50">
                duplicate proposal
              </span>
            ) : null}
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <p className="text-sm font-semibold text-text-primary">{entry.proposal.title}</p>
        <p className="mt-1 text-sm leading-6 text-text-secondary">{entry.proposal.summary}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Evidence</p>
            <p className="mt-2 text-sm text-text-primary">{entry.proposal.evidenceTaskIds.join(', ')}</p>
            <p className="mt-1 text-sm text-text-secondary">
              Outcome: {entry.proposal.experienceReport.outcome} · Truth: {entry.proposal.experienceReport.truthCompleteness}
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              Review score: {entry.proposal.reviewScore.toFixed(2)} · Archive eligible
            </p>
          </div>
          <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Next review</p>
            <p className="mt-2 text-sm text-text-primary">{proposalDetail ?? 'Review this proposal in Settings > Improvements.'}</p>
            <p className="mt-1 text-sm text-text-secondary">
              Evidence-linked proposal generated after the terminal task finished.
            </p>
            {entry.proposal.conflictsWithProposalIds.length > 0 ? (
              <p className="mt-1 text-sm text-text-secondary">
                Conflicts: {entry.proposal.conflictsWithProposalIds.join(', ')}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </TimelineNodeFrame>
  );
}

function renderProposalNoteEntry(entry: TimelineEntry & { kind: 'proposal-note' }) {
  return (
    <TimelineNodeFrame key={entry.id} kind="decision">
      <div
        key={entry.id}
        data-testid="task-proposal-note"
        className="max-w-3xl rounded-lg border border-border-subtle bg-surface/26 px-4 py-3"
      >
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span data-testid="task-timeline-glyph-decision-inline" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-300/24 bg-amber-400/10 text-amber-100">
              <TimelineDecisionIcon className="h-3.5 w-3.5" />
            </span>
            <span>{entry.label}</span>
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <p className="text-sm text-text-secondary">{entry.content}</p>
      </div>
    </TimelineNodeFrame>
  );
}

function renderGenericEntry(entry: TimelineEntry, task: TaskDetail) {
  const isRuntime = entry.kind === 'runtime';
  const isUser = entry.kind === 'user' || entry.kind === 'operator';
  const isAssistantNote = entry.kind === 'assistant-note';
  const isOperatorCorrection = entry.kind === 'operator' && isMachineCorrectionText(entry.content);

  const timelineTone = isAssistantNote
    ? {
      shell: 'border-sky-400/16 bg-surface/38',
      text: 'text-text-primary',
      meta: 'text-text-muted'
    }
    : isUser
      ? {
        shell: 'border-accent/18 bg-surface/34',
        text: 'text-text-primary',
        meta: 'text-text-muted'
      }
    : isRuntime
      ? {
        shell: 'border-border-subtle bg-surface/20',
        text: 'text-text-secondary',
        meta: 'text-text-muted/70'
      }
      : {
        shell: 'ml-auto border-accent/24 bg-accent-muted/85',
        text: 'text-text-primary',
        meta: 'text-text-muted'
      };

  const genericNodeKind: import('./taskPageModel').TimelineNodeKind = isRuntime
    ? 'runtime'
    : isAssistantNote
      ? requiresArtifactSelection(task)
        ? 'decision'
        : 'agent'
      : isOperatorCorrection
        ? 'decision'
        : 'user';

  const displayContent = isAssistantNote
    && entry.displayKind === 'artifact_ready'
    && requiresArtifactSelection(task)
      ? 'Artifact output is available in the task workspace. Use the composer delivery action below when you are ready to apply it.'
      : 'content' in entry ? entry.content : '';

  return (
    <TimelineNodeFrame key={entry.id} kind={genericNodeKind}>
      <div
        data-testid={`task-timeline-entry-${entry.kind}`}
        className={`max-w-[52rem] rounded-lg border px-3.5 py-3 ${timelineTone.shell} ${isRuntime ? 'opacity-80' : ''}`}
      >
        <div className={`mb-2 flex items-center justify-between gap-3 text-xs ${timelineTone.meta}`}>
          <div className="flex items-center gap-2">
            <span
              data-testid={
                genericNodeKind === 'agent'
                  ? 'task-timeline-agent-icon'
                  : genericNodeKind === 'decision'
                    ? 'task-timeline-glyph-decision-inline'
                    : undefined
              }
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-black/10 ${
                genericNodeKind === 'runtime'
                  ? 'border-emerald-300/20 text-emerald-100'
                  : genericNodeKind === 'agent'
                    ? 'border-cyan-300/20 text-cyan-100'
                    : genericNodeKind === 'decision'
                      ? 'border-amber-300/24 text-amber-100'
                      : 'border-accent/22 text-blue-100'
              }`}
            >
              {renderTimelineGlyph(genericNodeKind)}
            </span>
            <span className={isRuntime ? 'font-medium' : ''}>{entry.label}</span>
            {isAssistantNote ? (
              <span className="rounded-md border border-sky-300/24 bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-sky-100/80">
                {getAssistantSummaryBadgeLabel(entry.displayKind)}
              </span>
            ) : null}
            {isOperatorCorrection ? (
              <span className="rounded-md border border-warning/24 bg-warning-muted/12 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-warning">
                correction summary
              </span>
            ) : null}
            {entry.kind === 'operator' && entry.guidanceStatus === 'PENDING' ? (
              <span data-testid="task-pending-guidance" className="rounded-md border border-accent/24 bg-accent-muted/12 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-accent">
                pending
              </span>
            ) : null}
            {isAssistantNote && requiresArtifactSelection(task) ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-300/24 bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-sky-100/80">
                <span data-testid="task-timeline-glyph-artifact" className="inline-flex">
                  <TimelineArtifactIcon className="h-3.5 w-3.5" />
                </span>
                artifact destination
              </span>
            ) : null}
          </div>
          <span>{formatTime(entry.timestamp)}</span>
        </div>
        <p
          data-testid={
            isRuntime
              ? 'task-runtime-summary'
              : isAssistantNote
                ? 'task-assistant-note'
                : undefined
          }
          className={`whitespace-pre-wrap text-sm leading-6 ${timelineTone.text}`}
        >
          {isOperatorCorrection ? summarizeTimelineInstruction(displayContent) : displayContent}
        </p>
        {isOperatorCorrection ? (
          <p className="mt-2 text-xs leading-5 text-text-muted">
            Full machine instruction is kept in diagnostics, not the public timeline.
          </p>
        ) : null}
      </div>
    </TimelineNodeFrame>
  );
}

function renderTimelineGlyph(kind: import('./taskPageModel').TimelineNodeKind) {
  const className = 'h-4 w-4';
  switch (kind) {
    case 'user':
      return <TimelineUserIcon className={className} />;
    case 'runtime':
      return <TimelineRuntimeIcon className={className} />;
    case 'agent':
      return <TimelineAgentIcon className={className} />;
    case 'decision':
      return <TimelineDecisionIcon className={className} />;
    default:
      return <TimelineAgentIcon className={className} />;
  }
}
