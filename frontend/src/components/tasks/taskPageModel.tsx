import { type ReactNode } from 'react';
import { Badge, lifecycleBadgeVariant } from '../ui/badge';
import type { BadgeVariant } from '../ui/badge';
import { Card, CardContent } from '../ui/card';
import { ExpandableRow } from '../ui/expandable-row';
import {
  ClockIcon,
  FileIcon,
  FolderIcon,
  LockIcon,
  PlayIcon,
  ResumeIcon,
  RetryIcon,
  SearchIcon,
  SendIcon,
  StateIcon,
  TimelineAgentIcon,
  TimelineArtifactIcon,
  TimelineDecisionIcon,
  TimelineDelegationIcon,
  TimelineResultIcon,
  TimelineRuntimeIcon,
  TimelineUserIcon,
  WarningIcon,
} from '../ui/icons';
import type { RealtimeTransportStatus } from '../../api/websocket';
import type {
  PendingApprovalItem,
  RuntimeEvent,
  TaskDebugResponse,
  TaskDetail,
  TaskVisibleOutputSummary,
  ToolApproval,
  VisibleToolActivity,
} from '../../types';
export type DetailTab =
  | 'summary'
  | 'acceptance'
  | 'experience'
  | 'approvals'
  | 'diagnostics'
  | 'artifacts'
  | 'events'
  | 'raw';
export type ComposerMode = 'action' | 'continue' | 'follow_up' | 'observe' | 'blocked';
export type ComposerButtonTone = 'accent' | 'warning' | 'danger' | 'muted';
export type ComposerButtonIcon = 'play' | 'resume' | 'send' | 'retry' | 'wait' | 'lock' | 'warning';
export type ComposerSubmitKind = 'start' | 'resume' | 'continue' | null;
export type ComposerModel = {
  mode: ComposerMode;
  title: string;
  description: string;
  placeholder: string;
  buttonLabel: string;
  disabled: boolean;
  submitKind: ComposerSubmitKind;
  buttonTone: ComposerButtonTone;
  buttonIcon: ComposerButtonIcon;
  requiresMessage: boolean;
  collapsibleFollowUp: boolean;
  buttonTestId: 'task-action-start' | 'task-action-resume' | 'task-action-continue';
  actionLane: 'control' | 'guidance' | 'follow_up' | 'observe';
};
export type TimelineResultSummary = Omit<TaskVisibleOutputSummary, 'source'> & {
  source: TaskVisibleOutputSummary['source'] | 'completion_summary';
};
export type TimelineEntry =
  | {
    id: string;
    kind: 'user' | 'operator' | 'runtime' | 'assistant-note';
    content: string;
    timestamp: number;
    label: string;
    displayKind?: string | null;
    guidanceStatus?: TaskDetail['pendingGuidance'][number]['status'];
  }
  | {
    id: string;
    kind: 'tool-activity';
    activity: VisibleToolActivity;
    timestamp: number;
    label: string;
  }
  | {
    id: string;
    kind: 'delegation';
    childTitle: string;
    childGoal: string | null;
    childSummary: string | null;
    childStatus: TaskDetail['runtime']['lifecycleStatus'];
    timestamp: number;
    label: string;
    active: boolean;
  }
  | {
    id: string;
    kind: 'assistant-update';
    result: TimelineResultSummary;
    timestamp: number;
    label: string;
  }
  | {
    id: string;
    kind: 'result';
    result: TimelineResultSummary;
    timestamp: number;
    label: string;
  }
  | {
    id: string;
    kind: 'result-missing';
    timestamp: number;
    label: string;
  }
  | {
    id: string;
    kind: 'proposal';
    proposal: TaskDetail['improvementProposals'][number];
    timestamp: number;
    label: string;
  }
  | {
    id: string;
    kind: 'proposal-note';
    content: string;
    timestamp: number;
    label: string;
  };

export type ImportantContextCard = {
  label: string;
  title: string;
  detail: string;
};

export type TaskInspectorSnapshot = {
  taskId: string;
  importantCards: ImportantContextCard[];
  pendingApprovalEntries: ApprovalListEntry[];
  artifactContext: {
    artifactPathState: TaskDebugResponse['executionSummary']['artifactPathState'];
    recommendedArtifactDir: string | null;
    selectedArtifactDir: string | null;
    artifactDestinationPaths: string[];
    canChoosePath: boolean;
  } | null;
};

export type KnownArtifactState = {
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskVisibleOutputSummary['artifactApplyStatus'];
};

export function formatTime(value?: number | null): string {
  if (!value) {
    return 'just now';
  }
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatAcceptanceConfidence(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${Math.round(value * 100)}%`;
}

export function getAcceptanceVerdictTone(verdict: TaskDebugResponse['executionSummary']['acceptance']['deterministic']['contract']['verdict']): string {
  switch (verdict) {
    case 'passed':
      return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-50';
    case 'failed':
      return 'border-rose-300/30 bg-rose-400/10 text-rose-50';
    default:
      return 'border-white/10 bg-surface text-text-secondary';
  }
}

export function getAcceptanceReviewTone(status: TaskDebugResponse['executionSummary']['acceptance']['semanticReview']['status']): string {
  switch (status) {
    case 'passed':
      return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-50';
    case 'failed':
      return 'border-amber-300/30 bg-amber-400/10 text-amber-50';
    case 'unavailable':
      return 'border-rose-300/30 bg-rose-400/10 text-rose-50';
    case 'pending':
      return 'border-sky-300/30 bg-sky-400/10 text-sky-50';
    default:
      return 'border-white/10 bg-surface text-text-secondary';
  }
}

export function getVerdictDotClass(verdict: string | null | undefined): string {
  switch (verdict) {
    case 'passed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'pending':
      return 'text-warning';
    default:
      return 'text-text-muted';
  }
}

export function summarizeChecks(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }
  if (items.length === 1) {
    return items[0];
  }
  return `${items[0]} +${items.length - 1}`;
}

export function CompactCheckList({
  label,
  items,
  emptyText,
  tone = 'neutral',
}: {
  label: string;
  items: string[];
  emptyText: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}) {
  const toneClass = {
    neutral: 'border-border-subtle bg-black/10 text-text-secondary',
    success: 'border-emerald-300/16 bg-emerald-400/8 text-emerald-50',
    warning: 'border-amber-300/16 bg-amber-400/8 text-amber-50',
    error: 'border-rose-300/16 bg-rose-400/8 text-rose-50',
  }[tone];

  return (
    <details className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <summary className="cursor-pointer list-none text-[11px] uppercase tracking-[0.18em] text-text-muted">
        {label}: <span className="normal-case tracking-normal text-text-secondary">{summarizeChecks(items, emptyText)}</span>
      </summary>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs leading-5">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function RawJsonDetails({ label = 'Raw', value }: { label?: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-border-subtle bg-black/10">
      <summary className="cursor-pointer list-none px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted">
        {label}
      </summary>
      <pre className="workbench-raw rounded-t-none border-x-0 border-b-0">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function isMachineCorrectionText(content: string): boolean {
  const normalized = content.toLowerCase();
  return content.length > 700
    || normalized.includes('machine-readable json')
    || normalized.includes('validated_outputs')
    || normalized.includes('tool_name')
    || normalized.includes('requirednextevidence')
    || normalized.includes('required next evidence')
    || normalized.includes('correction')
    || normalized.includes('repair prompt');
}

export function summarizeTimelineInstruction(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'No instruction body was recorded.';
  }
  const evidenceMatch = compact.match(/(?:required next evidence|requiredNextEvidence|missing evidence)[:\s-]+(.{20,220})/i);
  if (evidenceMatch?.[1]) {
    return evidenceMatch[1].replace(/[{}[\]"]/g, '').slice(0, 180);
  }
  return compact.slice(0, 180) + (compact.length > 180 ? '...' : '');
}

export function normalizeDiscussionText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function getAssistantSummaryDisplayKind(message: TaskDetail['conversations'][number]): string | null {
  const displayKind = message.metadata?.displayKind;
  return typeof displayKind === 'string' && displayKind.trim() ? displayKind.trim() : null;
}

export function isAssistantSummaryMessage(message: TaskDetail['conversations'][number]): boolean {
  return message.role === 'assistant' && message.metadata?.source === 'assistant_summary';
}

export function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))];
}

export function isDuplicateAssistantDiscussion(message: string, visibleOutput: TaskVisibleOutputSummary | null): boolean {
  if (!visibleOutput) {
    return false;
  }
  const normalizedMessage = normalizeDiscussionText(message);
  if (!normalizedMessage) {
    return false;
  }
  const candidates = [
    visibleOutput.summary,
    visibleOutput.details,
    [visibleOutput.summary, visibleOutput.details].filter(Boolean).join(' ')
  ]
    .map((entry) => normalizeDiscussionText(entry))
    .filter(Boolean);

  return candidates.some((candidate) => (
    normalizedMessage === candidate
    || normalizedMessage.includes(candidate)
    || candidate.includes(normalizedMessage)
  ));
}

export function shouldKeepAssistantSummary(params: {
  message: TaskDetail['conversations'][number];
  task: TaskDetail;
}): boolean {
  const displayKind = getAssistantSummaryDisplayKind(params.message);
  if (!displayKind) {
    return false;
  }
  if (!params.task.latestVisibleOutput) {
    return true;
  }
  if (['clarification', 'approval_waiting', 'artifact_ready', 'recovery', 'failure'].includes(displayKind)) {
    return true;
  }
  if (displayKind === 'artifact_applied' && isTerminalLifecycle(params.task.runtime.lifecycleStatus)) {
    return false;
  }
  return !isDuplicateAssistantDiscussion(params.message.content, params.task.latestVisibleOutput);
}

export function getAssistantSummaryBadgeLabel(displayKind: string | null | undefined): string {
  switch (displayKind) {
    case 'clarification':
      return 'Clarify';
    case 'approval_waiting':
      return 'Approval';
    case 'artifact_ready':
      return 'Action needed';
    case 'artifact_applied':
      return 'Delivered';
    case 'recovery':
      return 'Recovery';
    case 'failure':
      return 'Failure';
    default:
      return 'Update';
  }
}

export function getKnownArtifactState(params: {
  result?: TimelineResultSummary | null;
  completionSummary?: TaskDetail['completionSummary'] | null;
}): KnownArtifactState {
  const result = params.result ?? null;
  const completionSummary = params.completionSummary ?? null;
  return {
    artifactPaths: dedupePaths(result?.artifactPaths ?? completionSummary?.artifactPaths ?? []),
    artifactDestinationPaths: dedupePaths(result?.artifactDestinationPaths ?? completionSummary?.artifactDestinationPaths ?? []),
    artifactDestinationDir:
      result?.artifactDestinationDir
      ?? completionSummary?.artifactDestinationDir
      ?? null,
    artifactApplyStatus:
      result?.artifactApplyStatus
      ?? completionSummary?.artifactApplyStatus
      ?? null
  };
}
export function buildTimelineResultSummary(task: TaskDetail): TimelineResultSummary | null {
  if (task.latestVisibleOutput) {
    return task.latestVisibleOutput;
  }
  const completionSummary = task.completionSummary;
  const hasCompletionTruth = Boolean(
    completionSummary
    && (
      completionSummary.summary
      || completionSummary.details
      || completionSummary.issues.length > 0
      || completionSummary.artifactPaths.length > 0
      || completionSummary.artifactDestinationPaths.length > 0
      || completionSummary.artifactDestinationDir
      || completionSummary.artifactApplyStatus
    )
  );
  if (!completionSummary || !hasCompletionTruth) {
    if (task.runtime.lifecycleStatus === 'FAILED' && task.diagnostics.lastError) {
      return {
        source: 'failure_fallback',
        unitId: task.runtime.currentUnitId,
        validatedAt: task.runtime.updatedAt ?? null,
        summary: 'Task failed before producing a final result.',
        details: task.diagnostics.lastError,
        issues: [],
        artifactPaths: [],
        artifactDestinationPaths: [],
        artifactDestinationDir: null,
        artifactApplyStatus: null,
      };
    }
    return null;
  }
  return {
    source: 'completion_summary',
    unitId: task.runtime.currentUnitId,
    validatedAt: task.runtime.updatedAt ?? null,
    summary: completionSummary.summary ?? 'Task completed without a visible summary.',
    details: completionSummary.details,
    issues: completionSummary.issues,
    artifactPaths: completionSummary.artifactPaths,
    artifactDestinationPaths: completionSummary.artifactDestinationPaths,
    artifactDestinationDir: completionSummary.artifactDestinationDir,
    artifactApplyStatus: completionSummary.artifactApplyStatus,
  };
}

export function summarizeRuntimeEvent(event: RuntimeEvent): string {
  if (event.type === 'TASK_ARTIFACTS_APPLIED') {
    const destinationDir = typeof event.payload.destinationDir === 'string' ? event.payload.destinationDir : null;
    return destinationDir ? `Artifacts applied to ${destinationDir}.` : 'Artifacts applied.';
  }
  if (event.type === 'TASK_FAILED') {
    const error = typeof event.payload.error === 'string' ? event.payload.error : null;
    return error ? `Task failed: ${error}` : 'Task failed.';
  }
  return ({
    TASK_STARTED: 'Task started.',
    TASK_PAUSED: 'Task paused.',
    TASK_RESUMED: 'Task resumed.',
    TASK_COMPLETED: 'Task completed.'
  } satisfies Record<string, string>)[event.type] ?? event.type.replaceAll('_', ' ').toLowerCase();
}

export function getToolActivityTone(status: VisibleToolActivity['status']) {
  switch (status) {
    case 'FAILED':
      return {
        shell: 'border-error/25 bg-error-muted/12',
        pill: 'border-error/30 bg-error-muted/18 text-error',
        text: 'text-text-primary',
        meta: 'text-text-muted',
      };
    case 'WAITING_APPROVAL':
    case 'DENIED':
      return {
        shell: 'border-warning/24 bg-warning-muted/10',
        pill: 'border-warning/30 bg-warning-muted/18 text-warning',
        text: 'text-text-primary',
        meta: 'text-text-muted',
      };
    case 'RUNNING':
      return {
        shell: 'border-sky-400/18 bg-surface/34',
        pill: 'border-sky-300/24 bg-sky-400/10 text-sky-100/86',
        text: 'text-text-primary',
        meta: 'text-text-muted',
      };
    default:
      return {
        shell: 'border-border-subtle bg-surface/28',
        pill: 'border-border-default bg-surface-elevated/70 text-text-primary',
        text: 'text-text-primary',
        meta: 'text-text-muted',
      };
  }
}

export function getToolActivityStatusLabel(status: VisibleToolActivity['status']) {
  switch (status) {
    case 'WAITING_APPROVAL':
      return 'Waiting approval';
    case 'RUNNING':
      return 'Running';
    case 'FAILED':
      return 'Failed';
    case 'DENIED':
      return 'Denied';
    case 'SUCCEEDED':
      return 'Completed';
    default:
      return status.replaceAll('_', ' ').toLowerCase();
  }
}

export function getToolActivityDisplayName(activity: VisibleToolActivity): string {
  return activity.toolId.replaceAll('_', ' ');
}

export function stripLeadingRepeatedToolName(activity: VisibleToolActivity): string {
  const displayName = getToolActivityDisplayName(activity);
  const summary = activity.summary.trim();
  if (!summary) {
    return summary;
  }
  const normalizedSummary = summary.toLowerCase();
  const normalizedDisplayName = displayName.toLowerCase();
  if (!normalizedSummary.startsWith(`${normalizedDisplayName} `)) {
    return summary;
  }
  const stripped = summary.slice(displayName.length).trimStart();
  return stripped ? `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}` : summary;
}

export function renderToolActivityIcon(activity: VisibleToolActivity) {
  const normalizedToolId = activity.toolId.toLowerCase();
  const iconClassName = 'h-4 w-4';

  if (normalizedToolId.includes('search')) {
    return <SearchIcon className={iconClassName} />;
  }

  if (normalizedToolId.includes('folder') || normalizedToolId.includes('list')) {
    return <FolderIcon className={iconClassName} />;
  }

  if (
    normalizedToolId.includes('file')
    || normalizedToolId.includes('artifact')
    || normalizedToolId.includes('read')
    || normalizedToolId.includes('write')
  ) {
    return <FileIcon className={iconClassName} />;
  }

  return <StateIcon className={iconClassName} />;
}

export type TimelineNodeKind =
  | 'user'
  | 'runtime'
  | 'tool'
  | 'agent'
  | 'artifact'
  | 'decision'
  | 'delegation'
  | 'result';

export type TimelineNodeFrameProps = {
  kind: TimelineNodeKind;
  children: ReactNode;
  activity?: VisibleToolActivity | null;
  className?: string;
};

export function getTimelineGlyphTone(kind: TimelineNodeKind): string {
  switch (kind) {
    case 'user':
      return 'border-accent/36 bg-accent-muted/80 text-blue-100 shadow-[0_12px_28px_-18px_rgba(96,165,250,0.68)]';
    case 'runtime':
      return 'border-emerald-300/34 bg-emerald-400/10 text-emerald-100 shadow-[0_12px_28px_-18px_rgba(16,185,129,0.72)]';
    case 'tool':
      return 'border-violet-300/34 bg-violet-400/12 text-violet-100 shadow-[0_12px_28px_-18px_rgba(139,92,246,0.78)]';
    case 'agent':
      return 'border-cyan-300/36 bg-cyan-400/12 text-cyan-100 shadow-[0_12px_28px_-18px_rgba(34,211,238,0.72)]';
    case 'artifact':
      return 'border-sky-300/34 bg-sky-400/10 text-sky-100 shadow-[0_12px_28px_-18px_rgba(56,189,248,0.7)]';
    case 'decision':
      return 'border-amber-300/40 bg-amber-400/12 text-amber-100 shadow-[0_12px_28px_-18px_rgba(245,158,11,0.78)]';
    case 'delegation':
      return 'border-fuchsia-300/34 bg-fuchsia-400/12 text-fuchsia-100 shadow-[0_12px_28px_-18px_rgba(217,70,239,0.7)]';
    case 'result':
    default:
      return 'border-emerald-300/34 bg-emerald-400/12 text-emerald-100 shadow-[0_12px_28px_-18px_rgba(16,185,129,0.72)]';
  }
}

export function renderTimelineGlyph(kind: TimelineNodeKind, activity?: VisibleToolActivity | null) {
  const className = 'h-4 w-4';
  switch (kind) {
    case 'user':
      return <TimelineUserIcon className={className} />;
    case 'runtime':
      return <TimelineRuntimeIcon className={className} />;
    case 'tool':
      return activity ? renderToolActivityIcon(activity) : <StateIcon className={className} />;
    case 'agent':
      return <TimelineAgentIcon className={className} />;
    case 'artifact':
      return <TimelineArtifactIcon className={className} />;
    case 'decision':
      return <TimelineDecisionIcon className={className} />;
    case 'delegation':
      return <TimelineDelegationIcon className={className} />;
    case 'result':
    default:
      return <TimelineResultIcon className={className} />;
  }
}

export function getTimelineIconTestId(kind: TimelineNodeKind): string | undefined {
  if (kind === 'agent' || kind === 'result') {
    return 'task-timeline-agent-icon';
  }
  if (kind === 'tool') {
    return 'task-timeline-tool-icon';
  }
  return undefined;
}

export function TimelineNodeFrame({ kind, children, activity = null, className = '' }: TimelineNodeFrameProps) {
  const iconTestId = getTimelineIconTestId(kind);
  return (
    <div data-testid={`task-timeline-node-${kind}`} className={`timeline-node ${className}`}>
      <span
        data-testid={`task-timeline-glyph-${kind}`}
        className={`timeline-node-glyph ${getTimelineGlyphTone(kind)}`}
      >
        <span data-testid={iconTestId} className="inline-flex">
          {renderTimelineGlyph(kind, activity)}
        </span>
      </span>
      <div className="timeline-node-content">
        {children}
      </div>
    </div>
  );
}

export function truncateToolOutput(value: string, maxChars = 1200): string {
  if (!value) {
    return '';
  }
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

export type ApprovalListEntry = {
  invocationId: string;
  toolName: string;
  requestedAt: number;
  argumentsSummary: string | null;
  riskCategory?: string | null;
  reason?: string | null;
  availableActions: Array<'APPROVED' | 'APPROVED_ONCE' | 'REJECTED'>;
};

export function summarizeApprovalArguments(approval: ToolApproval | null): string | null {
  if (!approval) {
    return null;
  }
  const entries = Object.entries(approval.arguments ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) {
    return null;
  }
  const compact = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

export function getPendingApprovalEntries(task: TaskDetail | null): ApprovalListEntry[] {
  if (!task) {
    return [];
  }
  const pendingApprovalItems = task.pendingApprovalItems ?? [];
  if (pendingApprovalItems.length > 0) {
    return pendingApprovalItems.map((approval) => ({
      invocationId: approval.invocationId,
      toolName: approval.toolName,
      requestedAt: approval.requestedAt,
      argumentsSummary: approval.argumentsSummary,
      riskCategory: approval.riskCategory,
      reason: approval.reason,
      availableActions: approval.availableActions,
    }));
  }
  const legacyPendingApprovals = task.pendingApprovals ?? [];
  return legacyPendingApprovals.map((approval) => ({
    invocationId: approval.invocationId,
    toolName: approval.toolName,
    requestedAt: approval.createdAt,
    argumentsSummary: summarizeApprovalArguments(approval),
    riskCategory: typeof approval.metadata?.riskCategory === 'string' ? approval.metadata.riskCategory : null,
    reason: approval.reason,
    availableActions: ['APPROVED', 'APPROVED_ONCE', 'REJECTED'],
  }));
}

export function getFinalDestinationLabel(task: TaskDetail | null, debug: TaskDebugResponse | null): string | null {
  const destinationPaths = dedupePaths(
    task?.completionSummary?.artifactDestinationPaths
    ?? task?.latestVisibleOutput?.artifactDestinationPaths
    ?? debug?.executionSummary.artifactDestinationPaths
    ?? []
  );
  if (destinationPaths.length === 1) {
    return destinationPaths[0];
  }
  if (destinationPaths.length > 1) {
    return `${destinationPaths[0]} +${destinationPaths.length - 1} more`;
  }
  return (
    task?.completionSummary?.artifactDestinationDir
    ?? task?.latestVisibleOutput?.artifactDestinationDir
    ?? debug?.executionSummary.lastArtifactApplyResult?.destinationDir
    ?? debug?.executionSummary.selectedArtifactDir
    ?? null
  );
}

export function hasDeliveredArtifacts(task: TaskDetail | null, debug: TaskDebugResponse | null): boolean {
  return Boolean(
    (
      task?.completionSummary?.artifactApplyStatus === 'APPLIED'
      || task?.latestVisibleOutput?.artifactApplyStatus === 'APPLIED'
      || debug?.executionSummary.artifactPathState === 'applied'
    )
    && getFinalDestinationLabel(task, debug)
  );
}

export function hasPendingApprovals(task: TaskDetail | null): boolean {
  return getPendingApprovalEntries(task).length > 0;
}

export function requiresArtifactSelection(task: TaskDetail | null): boolean {
  return task?.primaryAction.kind === 'use_recommended_path' || task?.primaryAction.kind === 'choose_custom_path';
}

export function getDisplayLifecycleBadge(
  task: TaskDetail | null,
  debug: TaskDebugResponse | null,
  fallbackLabel: string,
): { label: string; variant: BadgeVariant } {
  if (!task) {
    return { label: fallbackLabel, variant: 'outline' };
  }
  if (task.primaryAction.kind === 'approve') {
    return { label: 'WAITING', variant: 'warning' };
  }
  if (task.primaryAction.kind === 'use_recommended_path' || task.primaryAction.kind === 'choose_custom_path') {
    return { label: 'ACTION NEEDED', variant: 'warning' };
  }
  if (task.runtime.lifecycleStatus === 'COMPLETED' && hasDeliveredArtifacts(task, debug)) {
    return { label: 'DELIVERED', variant: 'success' };
  }
  return {
    label: fallbackLabel,
    variant: lifecycleBadgeVariant(task.runtime.lifecycleStatus) ?? 'default',
  };
}

export function getVisibleIssueSummary(task: TaskDetail | null, debug: TaskDebugResponse | null): string | null {
  const issueSummary = debug?.executionSummary.issueSummary ?? null;
  if (!issueSummary) {
    return null;
  }
  if (task?.runtime.lifecycleStatus === 'COMPLETED' && hasDeliveredArtifacts(task, debug) && !task.diagnostics.lastError) {
    return null;
  }
  const plane = debug?.executionSummary.issuePlane;
  const category = debug?.executionSummary.issueCategory;
  return [plane ? plane.toUpperCase() : null, category, issueSummary]
    .filter(Boolean)
    .join(' / ');
}

export function buildTimeline(task: TaskDetail | null, events: RuntimeEvent[], debug: TaskDebugResponse | null): TimelineEntry[] {
  if (!task) {
    return [];
  }
  const visibleResult = buildTimelineResultSummary(task);
  const activeChild = task.delegationSummary?.activeChildTask ?? null;
  const recentChild = activeChild
    ? null
    : (task.delegationSummary?.recentChildren[0] ?? null);

  const conversationItems: TimelineEntry[] = task.conversations
    .flatMap((message): TimelineEntry[] => {
      if (message.metadata?.source === 'operator_message') {
        return [];
      }
      if (message.role === 'assistant') {
        if (!isAssistantSummaryMessage(message) || !shouldKeepAssistantSummary({ message, task })) {
          return [];
        }
        return [{
          id: message.messageId,
          kind: 'assistant-note' as const,
          content: message.content,
          timestamp: message.createdAt,
          label: 'Assistant',
          displayKind: getAssistantSummaryDisplayKind(message)
        }];
      }
      return [{
        id: message.messageId,
        kind: message.role === 'runtime' ? 'runtime' : 'user',
        content: message.content,
        timestamp: message.createdAt,
        label: message.role === 'runtime' ? 'Runtime' : 'Operator'
      }];
    });
  const guidanceRecords = task.pendingGuidance?.length
    ? task.pendingGuidance
    : task.operatorMessages.map((message) => ({
      guidanceId: message.messageId,
      taskId: task.definition.taskId,
      content: message.content,
      status: 'CONSUMED' as const,
      createdAt: message.createdAt,
      consumedAt: null,
      actor: message.metadata?.actor ?? null,
      metadata: {}
    }));
  const operatorItems: TimelineEntry[] = guidanceRecords.map((message) => ({
    id: `operator_${message.guidanceId}`,
    kind: 'operator',
    content: message.content,
    timestamp: message.createdAt,
    label: message.status === 'PENDING' ? 'Pending guidance' : 'Operator',
    guidanceStatus: message.status,
  }));
  const toolActivityItems: TimelineEntry[] = (task.visibleToolActivities ?? []).map((activity) => ({
    id: `tool_${activity.activityId}`,
    kind: 'tool-activity',
    activity,
    timestamp: activity.endedAt ?? activity.startedAt,
    label: 'Tools'
  }));
  const delegationItems: TimelineEntry[] = activeChild
    ? [{
      id: `delegation_active_${activeChild.taskId}`,
      kind: 'delegation',
      childTitle: activeChild.title,
      childGoal: activeChild.goal,
      childSummary: activeChild.summary,
      childStatus: activeChild.lifecycleStatus,
      timestamp: activeChild.updatedAt,
      label: 'Delegation',
      active: true
    }]
    : recentChild
      ? [{
        id: `delegation_recent_${recentChild.taskId}`,
        kind: 'delegation',
        childTitle: recentChild.title,
        childGoal: recentChild.goal,
        childSummary: recentChild.summary,
        childStatus: recentChild.lifecycleStatus,
        timestamp: recentChild.updatedAt,
        label: 'Delegation',
        active: false
      }]
      : [];
  const resultItems: TimelineEntry[] = visibleResult
    ? [{
      id: `result_${visibleResult.validatedAt ?? visibleResult.unitId ?? 'latest'}`,
      kind: isTerminalLifecycle(task.runtime.lifecycleStatus) ? 'result' : 'assistant-update',
      result: visibleResult,
      timestamp: visibleResult.validatedAt ?? task.runtime.updatedAt ?? Date.now(),
      label: 'Assistant'
    }]
    : isTerminalLifecycle(task.runtime.lifecycleStatus)
      ? [{
        id: `result_missing_${task.definition.taskId}`,
        kind: 'result-missing',
        timestamp: task.runtime.updatedAt ?? Date.now(),
        label: 'Assistant'
      }]
      : [];
  const durableProposals = (task.improvementProposals ?? []).filter((proposal) => proposal.archiveEligible);
  const proposalItems: TimelineEntry[] = isTerminalLifecycle(task.runtime.lifecycleStatus)
    ? durableProposals.map((proposal) => ({
      id: `proposal_${proposal.proposalId}`,
      kind: 'proposal' as const,
      proposal,
      timestamp: proposal.updatedAt,
      label: 'Improvement'
    }))
    : [];
  const proposalNoteItems: TimelineEntry[] = isTerminalLifecycle(task.runtime.lifecycleStatus)
    && durableProposals.length === 0
    && task.realTaskArchiveStatus
    && !task.realTaskArchiveStatus.eligible
    && task.realTaskArchiveStatus.reason === 'not_complex_enough'
    ? [{
      id: `proposal_note_${task.definition.taskId}`,
      kind: 'proposal-note' as const,
      content: 'No durable proposals generated for this simple terminal task.',
      timestamp: task.runtime.updatedAt ?? Date.now(),
      label: 'Improvement'
    }]
    : [];

  const eventItems: TimelineEntry[] = events
    .filter((event) => {
      if (!['TASK_STARTED', 'TASK_PAUSED', 'TASK_RESUMED', 'TASK_COMPLETED', 'TASK_FAILED', 'TASK_ARTIFACTS_APPLIED'].includes(event.type)) {
        return false;
      }
      if (visibleResult && (event.type === 'TASK_COMPLETED' || event.type === 'TASK_RESUMED')) {
        return false;
      }
      return true;
    })
    .map((event, index) => ({
      id: `${event.eventId}-${index}`,
      kind: 'runtime',
      content: summarizeRuntimeEvent(event),
      timestamp: event.timestamp,
      label: 'Runtime',
    }));

  const hasHumanIntent = conversationItems.some((entry) => entry.kind === 'user' || entry.kind === 'operator')
    || operatorItems.length > 0;
  const allTimestamps = [...conversationItems, ...operatorItems, ...delegationItems, ...toolActivityItems, ...eventItems, ...resultItems]
    .map((entry) => entry.timestamp)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const intentItems: TimelineEntry[] = !hasHumanIntent && task.definition.intent.trim()
    ? [{
      id: `intent_${task.definition.taskId}`,
      kind: 'user',
      content: task.definition.intent,
      timestamp: (allTimestamps.length ? Math.min(...allTimestamps) : Date.now()) - 1,
      label: 'You',
    }]
    : [];

  return [...intentItems, ...conversationItems, ...operatorItems, ...delegationItems, ...toolActivityItems, ...eventItems, ...resultItems, ...proposalItems, ...proposalNoteItems]
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function getWorkspaceGuidanceNotice(debug: TaskDebugResponse | null, task: TaskDetail | null) {
  if (hasPendingApprovals(task) || requiresArtifactSelection(task)) {
    return null;
  }
  const visibleIssueSummary = getVisibleIssueSummary(task, debug);
  if (visibleIssueSummary) {
    return {
      title: 'Runtime guidance',
      body: visibleIssueSummary
    };
  }
  if (task?.diagnostics.lastError) {
    return {
      title: 'Latest failure',
      body: task.diagnostics.lastError
    };
  }
  return null;
}

export function isTerminalLifecycle(status: TaskDetail['runtime']['lifecycleStatus'] | undefined) {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

export function shouldAutoOpenContextRail(task: TaskDetail | null, debug: TaskDebugResponse | null) {
  return Boolean(
    getPendingApprovalEntries(task).length
    || debug?.executionSummary.artifactPathState === 'unresolved'
    || getVisibleIssueSummary(task, debug)
    || task?.diagnostics.lastError
    || debug?.executionSummary.recovery.recoveryReason
  );
}

export function getBlockingStripLabel(task: TaskDetail | null, debug: TaskDebugResponse | null) {
  if (!task) {
    return 'BLOCKER';
  }
  if (getPendingApprovalEntries(task).length) {
    return 'APPROVAL';
  }
  if (requiresArtifactSelection(task)) {
    return 'ARTIFACT';
  }
  if (task.delegationSummary.activeChildTask) {
    return 'DELEGATION';
  }
  if (task.runtime.lifecycleStatus === 'FAILED' || task.runtime.lifecycleStatus === 'CANCELLED') {
    return 'RECOVERY';
  }
  if (task.diagnostics.lastError || debug?.executionSummary.recovery.recoveryReason) {
    return 'RECOVERY';
  }
  return 'RUNTIME';
}

export function TaskAcceptancePanel({ debug }: { debug: TaskDebugResponse | null }) {
  const acceptance = debug?.executionSummary.acceptance ?? null;
  if (!acceptance) {
    return (
      <div
        data-testid="task-acceptance-panel"
        className="rounded-lg border border-border-subtle bg-black/10 px-4 py-4 text-sm text-text-secondary"
      >
        Acceptance truth is not available yet.
      </div>
    );
  }

  const layers: Array<{
    key: 'contract' | 'execution' | 'evidence' | 'outcome';
    label: string;
    layer: TaskDebugResponse['executionSummary']['acceptance']['deterministic']['contract'];
  }> = [
    { key: 'contract', label: 'Contract', layer: acceptance.deterministic.contract },
    { key: 'execution', label: 'Execution', layer: acceptance.deterministic.execution },
    { key: 'evidence', label: 'Evidence', layer: acceptance.deterministic.evidence },
    { key: 'outcome', label: 'Outcome', layer: acceptance.deterministic.outcome },
  ];

  const evidenceSummary = [
    acceptance.evidence.explicitOutput.summary,
    acceptance.evidence.progressTracker.summary,
    acceptance.evidence.toolEvidence.summary,
    acceptance.evidence.artifactEvidence.summary,
    acceptance.evidence.deliveryEvidence.summary,
    acceptance.evidence.groundingEvidence.summary,
  ];
  const experienceSummary = debug?.executionSummary.experienceSummary ?? null;

  return (
    <div data-testid="task-acceptance-panel" className="space-y-3">
      <div className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3" data-testid="task-inspector-section-acceptance">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Acceptance</p>
            <p className="mt-1 text-sm text-text-secondary">
              Deterministic gate is authoritative; semantic review remains advisory.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className={`status-dot ${getVerdictDotClass(acceptance.deterministic.verdict)}`} />
            <span className="uppercase tracking-[0.18em] text-text-primary">{acceptance.deterministic.verdict}</span>
            <span>{acceptance.deterministic.profileId}</span>
            {acceptance.deterministic.unitId ? <span>{acceptance.deterministic.unitId}</span> : null}
          </div>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {layers.map(({ key, label, layer }) => (
          <div
            key={key}
            data-testid={`task-acceptance-layer-${key}`}
            className="rounded-lg border border-border-subtle bg-surface/26 px-3 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{label}</p>
              <span className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] ${getVerdictDotClass(layer.verdict)}`}>
                <span className="status-dot" />
                {layer.verdict}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-text-secondary">{layer.summary}</p>
            <div className="mt-3 space-y-2">
              <CompactCheckList label="Failed" items={layer.failedChecks} emptyText="none" tone={layer.failedChecks.length ? 'error' : 'neutral'} />
              <CompactCheckList label="Next" items={layer.requiredNextEvidence} emptyText="none" tone={layer.requiredNextEvidence.length ? 'warning' : 'neutral'} />
              <CompactCheckList label="Passed" items={layer.passedChecks} emptyText="none" tone="success" />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3" data-testid="task-inspector-section-evidence">
        <p className="workbench-section-title">Evidence package</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {evidenceSummary.map((item, index) => (
            <div key={`${item}-${index}`} className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-2 text-sm leading-6 text-text-secondary">
              {item}
            </div>
          ))}
        </div>
      </div>

      <div data-testid="task-experience-panel" className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Experience</p>
            <p className="mt-1 text-sm text-text-secondary">
              {experienceSummary && experienceSummary.selectedCount > 0
                ? `${experienceSummary.selectedCount} approved reference experience(s) were injected for this task.`
                : 'No approved experience was selected for this task.'}
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-text-muted">
            configured {experienceSummary?.configuredCount ?? 0} / selected {experienceSummary?.selectedCount ?? 0}
          </p>
        </div>
        {experienceSummary && experienceSummary.selected.length > 0 ? (
          <div className="mt-3 space-y-2">
            {experienceSummary.selected.map((entry) => {
              const validation = experienceSummary.validationCandidates.find((candidate) => candidate.proposalId === entry.proposalId) ?? null;
              return (
                <div key={entry.proposalId} className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-text-primary">{entry.title}</p>
                    <span className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] ${getVerdictDotClass(entry.validationStatus === 'conflicted' ? 'failed' : entry.validationStatus === 'promotable' ? 'passed' : null)}`}>
                      <span className="status-dot" />
                      {entry.selectedBy} / {entry.validationStatus}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{entry.referenceSummary}</p>
                  <p className="mt-2 break-all text-xs text-text-muted">{entry.materializedPath}</p>
                  {entry.limitations.length > 0 ? (
                    <CompactCheckList label="Limits" items={entry.limitations} emptyText="none" tone="warning" />
                  ) : null}
                  {validation ? (
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Successful reuse</p>
                        <p className="mt-2 text-sm text-text-primary">{validation.successfulReuseTaskIds.length}</p>
                      </div>
                      <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Failed reuse</p>
                        <p className="mt-2 text-sm text-text-primary">{validation.failedReuseTaskIds.length}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div data-testid="task-acceptance-semantic-review" className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Semantic review</p>
            <p className="mt-1 text-sm text-text-secondary">
              {acceptance.semanticReview.summary ?? 'No semantic review summary yet.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className={`inline-flex items-center gap-2 uppercase tracking-[0.16em] ${getAcceptanceReviewTone(acceptance.semanticReview.status)}`}>
              <span className="status-dot" />
              {acceptance.semanticReview.status}
            </span>
            <span>confidence {formatAcceptanceConfidence(acceptance.semanticReview.confidence)}</span>
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Reviewer</p>
            <p className="mt-2 text-sm text-text-primary">
              {[acceptance.semanticReview.providerId, acceptance.semanticReview.modelId].filter(Boolean).join(' / ') || 'Not requested'}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {acceptance.semanticReview.reviewedAt ? `Reviewed ${formatTime(acceptance.semanticReview.reviewedAt)}` : 'Not reviewed yet'}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Verdict</p>
            <p className="mt-2 text-sm text-text-primary">{acceptance.semanticReview.verdict ?? 'none'}</p>
            {acceptance.semanticReview.error ? (
              <p className="mt-2 text-xs leading-5 text-rose-200">{acceptance.semanticReview.error}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <CompactCheckList label="Mismatches" items={acceptance.semanticReview.mismatches} emptyText="none" tone="warning" />
          <CompactCheckList label="Missing evidence" items={acceptance.semanticReview.missingEvidence} emptyText="none" tone="warning" />
        </div>
      </div>
    </div>
  );
}

export function DetailKeyValue({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{label}</p>
      <p className="mt-1 break-words text-sm text-text-primary">{value ?? 'n/a'}</p>
    </div>
  );
}

export function TaskExperiencePanel({ debug }: { debug: TaskDebugResponse | null }) {
  const experienceSummary = debug?.executionSummary.experienceSummary ?? null;
  if (!experienceSummary) {
    return (
      <div
        data-testid="task-inspector-section-experience"
        className="rounded-lg border border-border-subtle bg-black/10 px-4 py-4 text-sm text-text-secondary"
      >
        Experience truth is not available yet.
      </div>
    );
  }

  return (
    <div data-testid="task-inspector-section-experience" className="space-y-3">
      <div className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Experience</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {experienceSummary.selectedCount > 0
                ? `${experienceSummary.selectedCount} approved reference experience(s) were injected into this task.`
                : 'No approved experience was selected for this task.'}
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-text-muted">
            configured {experienceSummary.configuredCount} / selected {experienceSummary.selectedCount}
          </p>
        </div>
      </div>
      {experienceSummary.selected.length > 0 ? (
        <div className="space-y-2">
          {experienceSummary.selected.map((entry) => {
            const validation = experienceSummary.validationCandidates.find((candidate) => candidate.proposalId === entry.proposalId) ?? null;
            return (
              <div key={entry.proposalId} className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">{entry.title}</p>
                  <span className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] ${getVerdictDotClass(entry.validationStatus === 'conflicted' ? 'failed' : entry.validationStatus === 'promotable' ? 'passed' : null)}`}>
                    <span className="status-dot" />
                    {entry.selectedBy} / {entry.validationStatus}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{entry.referenceSummary}</p>
                <p className="mt-2 break-all text-xs text-text-muted">{entry.materializedPath}</p>
                {entry.limitations.length > 0 ? (
                  <div className="mt-3">
                    <CompactCheckList label="Limits" items={entry.limitations} emptyText="none" tone="warning" />
                  </div>
                ) : null}
                {validation ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <DetailKeyValue label="Successful reuse" value={validation.successfulReuseTaskIds.length} />
                    <DetailKeyValue label="Failed reuse" value={validation.failedReuseTaskIds.length} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2 text-sm text-text-secondary">
          Approved experience remains advisory. Task completion is still judged by the user goal and visible evidence.
        </p>
      )}
      <RawJsonDetails label="Raw experience" value={experienceSummary} />
    </div>
  );
}

export function buildCredibilitySummary(task: TaskDetail | null, execution: TaskDebugResponse['executionSummary'] | null) {
  if (!task || !execution) {
    return {
      verdict: 'Waiting for task truth',
      detail: 'Runtime, acceptance, artifact, and tool evidence are not loaded yet.',
      toneClass: 'border-border-subtle bg-black/10 text-text-secondary',
      gaps: ['debug snapshot'],
    };
  }
  const suggestedAction = execution.suggestedAction ?? {
    label: task.nextActionSummary.label,
    reason: task.nextActionSummary.reason || task.primaryAction.description || 'Review runtime diagnostics before continuing.',
  };
  if (!execution.acceptance?.deterministic) {
    return {
      verdict: 'Contract truth pending',
      detail: suggestedAction.reason,
      toneClass: 'border-info/25 bg-info-muted/20 text-info',
      gaps: ['acceptance truth'],
    };
  }
  const deterministicVerdict = execution.acceptance.deterministic.contract.verdict;
  const gaps: string[] = [];
  if (deterministicVerdict === 'failed') {
    gaps.push('acceptance contract');
  }
  if (execution.artifactPathState === 'unresolved') {
    gaps.push('artifact destination');
  }
  if (execution.acceptance.evidence?.toolEvidence?.required && !execution.acceptance.evidence.toolEvidence.satisfied) {
    gaps.push('tool evidence');
  }
  if (task.runtime.lifecycleStatus === 'COMPLETED' && !task.completionSummary && !task.latestVisibleOutput) {
    gaps.push('result card');
  }
  if (gaps.length > 0) {
    return {
      verdict: 'Not yet credible',
      detail: `${suggestedAction.label}: ${suggestedAction.reason}`,
      toneClass: 'border-warning/25 bg-warning-muted/20 text-warning',
      gaps,
    };
  }
  if (task.runtime.lifecycleStatus === 'COMPLETED') {
    return {
      verdict: 'Credible result',
      detail: 'Acceptance, evidence, and artifact state do not report blockers.',
      toneClass: 'border-success/25 bg-success-muted/20 text-success',
      gaps,
    };
  }
  return {
    verdict: 'Evidence building',
    detail: suggestedAction.reason,
    toneClass: 'border-info/25 bg-info-muted/20 text-info',
    gaps,
  };
}

export function TaskDetailTabPanel({
  activeTab,
  task,
  debug,
  events,
  pendingApprovalEntries,
}: {
  activeTab: DetailTab;
  task: TaskDetail | null;
  debug: TaskDebugResponse | null;
  events: RuntimeEvent[];
  pendingApprovalEntries: ApprovalListEntry[];
}) {
  if (activeTab === 'acceptance') {
    return <TaskAcceptancePanel debug={debug} />;
  }

  const execution = debug?.executionSummary ?? null;
  if (activeTab === 'experience') {
    return <TaskExperiencePanel debug={debug} />;
  }

  if (activeTab === 'summary') {
    const credibility = buildCredibilitySummary(task, execution);
    return (
      <div className="space-y-3" data-testid="task-inspector-section-summary">
        <div className={`rounded-lg border px-3 py-3 ${credibility.toneClass}`} data-testid="task-credibility-bar">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold">{credibility.verdict}</p>
            <p className="text-xs uppercase tracking-[0.18em] opacity-80">
              {credibility.gaps.length ? `Missing ${credibility.gaps.join(', ')}` : 'Evidence complete'}
            </p>
          </div>
          <p className="mt-1 text-sm leading-5 opacity-90">{credibility.detail}</p>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <DetailKeyValue label="Task" value={task?.definition.taskId} />
          <DetailKeyValue label="Lifecycle" value={task?.runtime.lifecycleStatus} />
          <DetailKeyValue label="Primary action" value={task?.primaryAction.label} />
          <DetailKeyValue label="Next action" value={task?.nextActionSummary.reason || task?.primaryAction.description} />
          <DetailKeyValue label="Provider" value={[execution?.providerSummary.providerId, execution?.providerSummary.modelId].filter(Boolean).join(' / ') || task?.definition.preferredProviderId} />
          <DetailKeyValue label="Failure plane" value={execution?.issuePlane ?? 'none'} />
          <DetailKeyValue label="Suggested action" value={execution?.suggestedAction?.label} />
        </div>
        {execution?.issueSummary || task?.diagnostics.lastError ? (
          <div className="rounded-lg border border-error/24 bg-error-muted/10 px-3 py-2 text-sm leading-6 text-rose-100">
            {[execution?.issuePlane?.toUpperCase(), execution?.issueCategory, execution?.issueSummary ?? task?.diagnostics.lastError]
              .filter(Boolean)
              .join(' / ')}
          </div>
        ) : null}
        {execution?.suggestedAction ? (
          <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2 text-sm leading-6 text-text-secondary" data-testid="task-suggested-action">
            <span className="font-medium text-text-primary">{execution.suggestedAction.label}</span>
            <span className="ml-2">{execution.suggestedAction.reason}</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (activeTab === 'diagnostics') {
    const diagnosticsPayload = {
      executionSummary: execution ?? {},
      acceptance: execution?.acceptance ?? null,
      experienceSummary: execution?.experienceSummary ?? null,
      diagnostics: task?.diagnostics ?? {},
      provider: execution?.providerSummary.providerId ?? task?.definition.preferredProviderId ?? null,
      model: execution?.providerSummary.modelId ?? null,
      recovery: execution?.recovery.recoveryReason ?? task?.diagnostics.lastError ?? execution?.issueSummary ?? null,
    };
    return (
      <div className="space-y-3" data-testid="task-inspector-section-diagnostics">
        <div className="grid gap-2 md:grid-cols-2">
          <DetailKeyValue label="Provider" value={diagnosticsPayload.provider} />
          <DetailKeyValue label="Model" value={diagnosticsPayload.model} />
          <DetailKeyValue label="Failure plane" value={execution?.issuePlane ?? 'none'} />
          <DetailKeyValue label="Issue category" value={execution?.issueCategory ?? 'none'} />
          <DetailKeyValue label="Suggested action" value={execution?.suggestedAction?.label} />
          <DetailKeyValue label="Permission" value={execution?.permissionSummary.mode} />
          <DetailKeyValue label="Recovery" value={diagnosticsPayload.recovery} />
          <DetailKeyValue label="Turn contract" value={execution ? `${execution.turnContract.continueAllowed ? 'continue' : 'hold'}: ${execution.turnContract.continueReason}` : null} />
          <DetailKeyValue label="Last error" value={task?.diagnostics.lastError} />
        </div>
        <pre className="workbench-raw max-h-72 overflow-auto" data-testid="task-diagnostics-machine-truth">
          {JSON.stringify(diagnosticsPayload, null, 2)}
        </pre>
        <RawJsonDetails label="Raw diagnostics" value={diagnosticsPayload} />
      </div>
    );
  }

  if (activeTab === 'artifacts') {
    const artifactPayload = {
      artifactPathState: execution?.artifactPathState,
      pendingArtifactCount: execution?.pendingArtifactCount,
      selectedArtifactDir: execution?.selectedArtifactDir,
      recommendedArtifactDir: execution?.recommendedArtifactDir,
      lastArtifactApplyResult: execution?.lastArtifactApplyResult,
      artifactPaths: execution?.artifactPaths,
      artifactDestinationPaths: execution?.artifactDestinationPaths,
    };
    return (
      <div className="space-y-3" data-testid="task-inspector-section-artifacts">
        <div className="grid gap-2 md:grid-cols-2">
          <DetailKeyValue label="Path state" value={execution?.artifactPathState} />
          <DetailKeyValue label="Pending" value={execution?.pendingArtifactCount} />
          <DetailKeyValue label="Selected dir" value={execution?.selectedArtifactDir} />
          <DetailKeyValue label="Recommended dir" value={execution?.recommendedArtifactDir} />
        </div>
        {(execution?.artifactPaths ?? []).length > 0 ? (
          <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Artifacts</p>
            <div className="mt-2 space-y-1 text-xs text-text-secondary">
              {execution?.artifactPaths.map((artifactPath) => <p key={artifactPath} className="break-all">{artifactPath}</p>)}
            </div>
          </div>
        ) : null}
        <pre className="workbench-raw">{JSON.stringify(artifactPayload, null, 2)}</pre>
      </div>
    );
  }

  if (activeTab === 'approvals') {
    return (
      <div className="space-y-3" data-testid="task-inspector-section-approvals">
        {pendingApprovalEntries.length > 0 ? pendingApprovalEntries.map((approval) => (
          <div key={approval.invocationId} className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text-primary">{approval.toolName}</p>
              <span className="text-xs text-text-muted">{formatTime(approval.requestedAt)}</span>
            </div>
            <p className="mt-1 text-sm leading-6 text-text-secondary">{approval.argumentsSummary ?? 'No projected argument summary.'}</p>
          </div>
        )) : (
          <p className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2 text-sm text-text-secondary">No pending approvals.</p>
        )}
        <RawJsonDetails label="Raw approvals" value={pendingApprovalEntries} />
      </div>
    );
  }

  if (activeTab === 'raw') {
    const rawPayload = {
      task,
      debug,
      events,
      visibleToolActivities: task?.visibleToolActivities ?? [],
    };
    return (
      <div className="space-y-3" data-testid="task-inspector-section-raw">
        <div className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
          <p className="workbench-section-title">Raw truth</p>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            Machine-readable task, debug, event, and visible tool payloads. This mirrors the diagnostics truth rather than restating it in prose.
          </p>
        </div>
        <pre className="workbench-raw">{JSON.stringify(rawPayload, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="task-inspector-section-events">
      <div className="space-y-2">
        {events.length > 0 ? events.slice(-10).map((event) => (
          <div key={`${event.eventId}-${event.timestamp}`} className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-primary">{event.type}</p>
              <span className="text-xs text-text-muted">{formatTime(event.timestamp)}</span>
            </div>
            <p className="mt-1 text-sm leading-6 text-text-secondary">{summarizeRuntimeEvent(event)}</p>
          </div>
        )) : (
          <p className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2 text-sm text-text-secondary">No runtime events recorded yet.</p>
        )}
      </div>
      <pre className="workbench-raw">{JSON.stringify(events, null, 2)}</pre>
    </div>
  );
}

export function buildInspectorSnapshot(params: {
  task: TaskDetail;
  debug: TaskDebugResponse | null;
  importantCards: ImportantContextCard[];
  pendingApprovalEntries: ApprovalListEntry[];
  artifactSelectionRequired: boolean;
}): TaskInspectorSnapshot {
  const { task, debug, importantCards, pendingApprovalEntries, artifactSelectionRequired } = params;
  const hasArtifactTruth = Boolean(
    debug
    && (
      debug.executionSummary.artifactPathState !== 'sandbox_only'
      || debug.executionSummary.recommendedArtifactDir
      || debug.executionSummary.selectedArtifactDir
      || debug.executionSummary.artifactDestinationPaths.length > 0
    )
  );

  return {
    taskId: task.definition.taskId,
    importantCards,
    pendingApprovalEntries,
    artifactContext: hasArtifactTruth && debug ? {
      artifactPathState: debug.executionSummary.artifactPathState,
      recommendedArtifactDir: debug.executionSummary.recommendedArtifactDir,
      selectedArtifactDir: debug.executionSummary.selectedArtifactDir,
      artifactDestinationPaths: debug.executionSummary.artifactDestinationPaths,
      canChoosePath: artifactSelectionRequired,
    } : null,
  };
}

export function mergeInspectorSnapshot(
  nextSnapshot: TaskInspectorSnapshot | null,
  previousSnapshot: TaskInspectorSnapshot | null
): TaskInspectorSnapshot | null {
  if (!nextSnapshot) {
    return previousSnapshot;
  }
  if (!previousSnapshot || previousSnapshot.taskId !== nextSnapshot.taskId) {
    return nextSnapshot;
  }
  return {
    taskId: nextSnapshot.taskId,
    importantCards:
      nextSnapshot.importantCards.length > 0
        ? nextSnapshot.importantCards
        : previousSnapshot.importantCards,
    pendingApprovalEntries:
      nextSnapshot.pendingApprovalEntries.length > 0
        ? nextSnapshot.pendingApprovalEntries
        : previousSnapshot.pendingApprovalEntries,
    artifactContext: nextSnapshot.artifactContext ?? previousSnapshot.artifactContext,
  };
}

export function getPrimaryStatusSummary(task: TaskDetail | null, debug: TaskDebugResponse | null, realtimeStatus: RealtimeTransportStatus) {
  const providerLabel = [debug?.executionSummary.providerSummary.providerId, debug?.executionSummary.providerSummary.modelId]
    .filter(Boolean)
    .join(' / ') || task?.definition.preferredProviderId || null;
  const lifecycle = task?.runtime.lifecycleStatus ?? 'IDLE';

  if (!task) {
    return {
      lifecycle,
      headline: 'Select a thread',
      blocker: 'Nothing is active yet.',
      nextAction: 'Pick a thread or create a new one.',
      providerLabel,
      realtimeLabel: getRealtimeStatusLabel(realtimeStatus),
    };
  }

  const nextAction = task.nextActionSummary.reason?.trim()
    || task.primaryAction.description?.trim()
    || 'Task query is missing nextActionSummary.';
  return {
    lifecycle,
    headline: task.statusSummary.label,
    blocker: task.statusSummary.detail?.trim() || 'Task query is missing statusSummary.',
    nextAction,
    providerLabel,
    realtimeLabel: getRealtimeStatusLabel(realtimeStatus),
  };
}

export function getRealtimeStatusLabel(status: RealtimeTransportStatus): string {
  switch (status.mode) {
    case 'live':
      return 'Realtime live';
    case 'polling':
      return 'Realtime polling';
    case 'reconnecting':
      return 'Realtime reconnecting';
    case 'blocked':
      return 'Realtime blocked';
    default:
      return status.connected ? 'Realtime live' : 'Realtime degraded';
  }
}

export function getComposerButtonClass(tone: ComposerButtonTone) {
  switch (tone) {
    case 'warning':
      return 'border border-warning/40 bg-warning-muted/80 text-warning hover:bg-warning-muted';
    case 'danger':
      return 'border border-error/40 bg-error-muted/80 text-error hover:bg-error-muted';
    case 'muted':
      return 'border border-border-default bg-surface-elevated text-text-muted hover:bg-surface-hover';
    default:
      return 'bg-accent text-white hover:bg-accent-hover';
  }
}

export function renderComposerButtonIcon(icon: ComposerButtonIcon) {
  switch (icon) {
    case 'play':
      return <PlayIcon className="h-4 w-4" />;
    case 'resume':
      return <ResumeIcon className="h-4 w-4" />;
    case 'retry':
      return <RetryIcon className="h-4 w-4" />;
    case 'wait':
      return <ClockIcon className="h-4 w-4" />;
    case 'lock':
      return <LockIcon className="h-4 w-4" />;
    case 'warning':
      return <WarningIcon className="h-4 w-4" />;
    default:
      return <SendIcon className="h-4 w-4" />;
  }
}

export function runtimeClearlyRequestsGuidance(task: TaskDetail, debug: TaskDebugResponse | null): boolean {
  if (task.runtime.lifecycleStatus !== 'RUNNING') {
    return true;
  }
  const combined = [
    task.statusSummary.label,
    task.statusSummary.detail,
    task.primaryAction.description,
    task.nextActionSummary.reason,
    debug?.executionSummary.issueSummary,
    debug?.executionSummary.turnContract.continueReason,
    debug?.executionSummary.turnContract.conservativeMode ? 'conservative mode' : null,
    task.diagnostics.lastError,
    task.diagnostics.providerFailure?.message,
    ...(task.visibleToolActivities ?? []).slice(-3).flatMap((activity) => [
      activity.status,
      activity.summary,
      activity.detail,
      activity.resultSummary,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!combined) {
    return false;
  }
  return /(need more context|needs? context|ask for|operator guidance|required|blocked|clarify|missing|failed|failure|quality|evidence|non[- ]?convergent|cannot|destination|approval|correction|repair|provider)/i.test(combined);
}

export function getComposerModel(task: TaskDetail | null, debug: TaskDebugResponse | null): ComposerModel {
  if (!task) {
    return {
      mode: 'blocked',
      title: 'Operator guidance',
      description: 'Pick or create a thread to continue.',
      placeholder: 'Select a thread first...',
      buttonLabel: 'Waiting',
      disabled: true,
      submitKind: null,
      buttonTone: 'muted',
      buttonIcon: 'lock',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'observe',
    };
  }

  if (task.primaryAction.kind === 'approve') {
    const primaryApproval = getPendingApprovalEntries(task)[0] ?? null;
    return {
      mode: 'blocked',
      title: 'Approval required',
      description: primaryApproval
          ? `Approve or reject ${primaryApproval.toolName} before this thread can continue.`
          : task.primaryAction.description,
      placeholder: 'Use the approval actions first, then continue the thread if needed...',
      buttonLabel: 'Waiting approval',
      disabled: true,
      submitKind: null,
      buttonTone: 'warning',
      buttonIcon: 'warning',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'control',
    };
  }

  if (task.primaryAction.kind === 'wait') {
    const waitingOnChild = Boolean(task.delegationSummary.activeChildTask);
    return {
      mode: 'blocked',
      title: waitingOnChild ? 'Delegated subtask running' : 'Waiting on runtime',
      description: task.nextActionSummary.reason,
      placeholder: waitingOnChild ? 'Wait for the delegated child task to finish...' : 'Wait for the current step to finish...',
      buttonLabel: waitingOnChild ? 'Waiting child task' : 'Waiting runtime',
      disabled: true,
      submitKind: null,
      buttonTone: 'muted',
      buttonIcon: 'wait',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'observe',
    };
  }

  if (task.primaryAction.kind === 'use_recommended_path' || task.primaryAction.kind === 'choose_custom_path') {
    return {
      mode: 'blocked',
      title: task.statusSummary.label,
      description: task.nextActionSummary.reason,
      placeholder: 'Choose a destination and apply the artifact first...',
      buttonLabel: 'Choose path',
      disabled: true,
      submitKind: null,
      buttonTone: 'warning',
      buttonIcon: 'warning',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'control',
    };
  }

  if (task.primaryAction.kind === 'send_guidance') {
    return {
      mode: 'continue',
      title: 'Repair guidance',
      description: 'Review diagnostics, then send a concrete repair instruction for this thread.',
      placeholder: 'Describe the exact repair evidence or next action to try...',
      buttonLabel: 'Send repair guidance',
      disabled: false,
      submitKind: 'continue',
      buttonTone: 'danger',
      buttonIcon: 'retry',
      requiresMessage: true,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'guidance',
    };
  }

  if (task.primaryAction.kind === 'start_task' || task.primaryAction.kind === 'resume_task') {
    const isResume = task.primaryAction.kind === 'resume_task';
    return {
      mode: 'action',
      title: task.statusSummary.label,
      description: task.primaryAction.description,
      placeholder: `${task.primaryAction.label} before sending a message...`,
      buttonLabel: task.primaryAction.label,
      disabled: false,
      submitKind: isResume ? 'resume' : 'start',
      buttonTone: isResume ? 'warning' : task.runtime.lifecycleStatus === 'FAILED' ? 'danger' : 'accent',
      buttonIcon: isResume ? 'resume' : 'play',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: isResume ? 'task-action-resume' : 'task-action-start',
      actionLane: 'control',
    };
  }

  if (task.primaryAction.kind === 'continue_thread' && task.runtime.lifecycleStatus === 'COMPLETED') {
    return {
      mode: 'follow_up',
      title: 'Follow-up',
      description: task.primaryAction.description,
      placeholder: 'Describe the next change, clarification, or follow-up for this thread...',
      buttonLabel: 'Continue thread',
      disabled: false,
      submitKind: 'continue',
      buttonTone: 'accent',
      buttonIcon: 'send',
      requiresMessage: true,
      collapsibleFollowUp: true,
      buttonTestId: 'task-action-continue',
      actionLane: 'follow_up',
    };
  }

  if (task.primaryAction.kind === 'continue_thread') {
    if (task.runtime.lifecycleStatus === 'RUNNING' && !runtimeClearlyRequestsGuidance(task, debug)) {
      return {
        mode: 'observe',
        title: 'Runtime working',
        description: 'The thread is active. Send guidance only when you need to redirect or unblock it.',
        placeholder: 'Runtime is working; no message is required right now...',
        buttonLabel: 'Observe',
        disabled: true,
        submitKind: null,
        buttonTone: 'muted',
        buttonIcon: 'wait',
        requiresMessage: false,
        collapsibleFollowUp: false,
        buttonTestId: 'task-action-continue',
        actionLane: 'observe',
      };
    }
    if (task.runtime.lifecycleStatus === 'FAILED') {
      return {
        mode: 'continue',
        title: 'Repair guidance',
        description: 'Inspect diagnostics first, then send a concrete repair instruction for the next product-runtime turn.',
        placeholder: 'Describe the exact repair evidence or next action to try...',
        buttonLabel: 'Send repair guidance',
        disabled: false,
        submitKind: 'continue',
        buttonTone: 'danger',
        buttonIcon: 'retry',
        requiresMessage: true,
        collapsibleFollowUp: false,
        buttonTestId: 'task-action-continue',
        actionLane: 'guidance',
      };
    }
    return {
      mode: 'continue',
      title: task.runtime.lifecycleStatus === 'RUNNING' ? 'Guidance requested' : 'Operator guidance',
      description: task.runtime.lifecycleStatus === 'RUNNING'
        ? task.nextActionSummary.reason || task.primaryAction.description
        : task.primaryAction.description,
      placeholder: task.runtime.lifecycleStatus === 'RUNNING'
        ? 'Add the missing context or correction instruction for this running thread...'
        : 'Add operator guidance for the current thread...',
      buttonLabel: task.runtime.lifecycleStatus === 'RUNNING' ? 'Send guidance' : task.primaryAction.label,
      disabled: false,
      submitKind: 'continue',
      buttonTone: 'accent',
      buttonIcon: 'send',
      requiresMessage: true,
      collapsibleFollowUp: false,
      buttonTestId: 'task-action-continue',
      actionLane: 'guidance',
    };
  }

  return {
    mode: 'blocked',
    title: task.statusSummary.label,
    description: task.nextActionSummary.reason,
    placeholder: 'This thread is waiting on a blocker before it can continue...',
    buttonLabel: task.primaryAction.label || 'Waiting',
    disabled: true,
    submitKind: null,
    buttonTone: task.runtime.lifecycleStatus === 'FAILED' ? 'danger' : 'muted',
    buttonIcon: task.runtime.lifecycleStatus === 'FAILED' ? 'warning' : 'lock',
    requiresMessage: false,
    collapsibleFollowUp: false,
    buttonTestId: 'task-action-continue',
    actionLane: 'observe',
  };
}
