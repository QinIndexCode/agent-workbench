import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { WebSocketClient, type RealtimeTransportStatus } from '../api/websocket';
import { Badge, lifecycleBadgeVariant } from '../components/ui/badge';
import type { BadgeVariant } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ExpandableRow } from '../components/ui/expandable-row';
import {
  ArchiveIcon,
  ClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CapabilityIcon,
  DashboardIcon,
  FileIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  PlayIcon,
  QueueIcon,
  RefreshIcon,
  ResumeIcon,
  RetryIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  StateIcon,
  TimelineAgentIcon,
  TimelineArtifactIcon,
  TimelineDecisionIcon,
  TimelineDelegationIcon,
  TimelineResultIcon,
  TimelineRuntimeIcon,
  TimelineUserIcon,
  ThreadsIcon,
  WarningIcon,
  TasksIcon,
} from '../components/ui/icons';
import { useTaskDetail, useTasks } from '../hooks/useTasks';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';
import { buildThreadPreview } from '../lib/workbench';
import type {
  AgentUnit,
  PendingApprovalItem,
  QualityProfileId,
  RuntimeEvent,
  TaskDebugResponse,
  TaskDetail,
  TaskPathPolicy,
  TaskVisibleOutputSummary,
  ToolApproval,
  VisibleToolActivity
} from '../types';

type DetailTab =
  | 'summary'
  | 'acceptance'
  | 'quality'
  | 'experience'
  | 'approvals'
  | 'diagnostics'
  | 'artifacts'
  | 'events'
  | 'raw';
type ComposerMode = 'action' | 'continue' | 'follow_up' | 'observe' | 'blocked';
type ComposerButtonTone = 'accent' | 'warning' | 'danger' | 'muted';
type ComposerButtonIcon = 'play' | 'resume' | 'send' | 'retry' | 'wait' | 'lock' | 'warning';
type ComposerSubmitKind = 'start' | 'resume' | 'restart' | 'continue' | null;
type TaskFamilyId =
  | 'analyze'
  | 'implement'
  | 'verify'
  | 'multi_agent_delegation';
type ComposerModel = {
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
  buttonTestId: 'task-action-start' | 'task-action-resume' | 'task-action-continue' | 'task-action-restart';
  actionLane: 'control' | 'guidance' | 'follow_up' | 'observe';
};
type TimelineResultSummary = Omit<TaskVisibleOutputSummary, 'source'> & {
  source: TaskVisibleOutputSummary['source'] | 'completion_summary';
};
type TimelineEntry =
  | {
    id: string;
    kind: 'user' | 'operator' | 'runtime' | 'assistant-note';
    content: string;
    timestamp: number;
    label: string;
    displayKind?: string | null;
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

type ImportantContextCard = {
  label: string;
  title: string;
  detail: string;
};

type TaskInspectorSnapshot = {
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

type KnownArtifactState = {
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskVisibleOutputSummary['artifactApplyStatus'];
};

const TASK_FAMILY_UNITS: Record<TaskFamilyId, AgentUnit[]> = {
  analyze: [
    {
      id: 'AGENT-001',
      role: 'Analyst',
      goal: 'Analyze the request, gather evidence, and return grounded findings.',
      executionProfileId: 'analyze',
      outputContract: '{"summary":"string","findings":["string"],"evidence":["string"],"issues":[]}',
      dependencies: [],
    },
  ],
  implement: [
    {
      id: 'AGENT-001',
      role: 'Implementer',
      goal: 'Implement the requested change and provide verification evidence.',
      executionProfileId: 'implement',
      outputContract: '{"summary":"string","changedFiles":["string"],"verification":["string"],"issues":[]}',
      dependencies: [],
    },
  ],
  verify: [
    {
      id: 'AGENT-001',
      role: 'Verifier',
      goal: 'Run checks, classify failures, and report exact pass/fail evidence.',
      executionProfileId: 'verify',
      outputContract: '{"summary":"string","checks":[{"name":"string","status":"passed|failed|blocked","evidence":"string"}],"issues":[]}',
      dependencies: [],
    },
  ],
  multi_agent_delegation: [
    {
      id: 'AGENT-001',
      role: 'Coordinator',
      goal: 'Plan the parent thread, delegate bounded subtasks when useful, and synthesize the final result.',
      executionProfileId: 'implement',
      outputContract: '{"summary":"string","delegations":["string"],"integration":"string","issues":[]}',
      delegationRequired: true,
      delegationContract: {
        title: 'Scoped child task',
        goal: 'Handle one bounded subtask and return evidence to the parent thread.',
      },
      dependencies: [],
    },
  ],
};

const DEFAULT_UNITS: AgentUnit[] = TASK_FAMILY_UNITS.analyze;

function formatUnitsTemplate(taskFamily: TaskFamilyId): string {
  return JSON.stringify(TASK_FAMILY_UNITS[taskFamily], null, 2);
}

function validateComposerInput(input: {
  title: string;
  intent: string;
  providerId: string;
  unitsText: string;
  pathPolicy: TaskPathPolicy;
  outputDir: string;
}): { units: AgentUnit[] | null; errors: string[] } {
  const errors: string[] = [];
  if (!input.title.trim()) {
    errors.push('Add a title so the thread is identifiable.');
  }
  if (!input.intent.trim()) {
    errors.push('Describe the intent before creating the task.');
  }
  if (!input.providerId.trim()) {
    errors.push('Choose a provider id, or configure a runtime default in Connections first.');
  }
  if (input.pathPolicy === 'project_relative' && !input.outputDir.trim()) {
    errors.push('Project-relative artifact delivery needs an output directory.');
  }
  try {
    const parsed = JSON.parse(input.unitsText) as AgentUnit[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      errors.push('Units JSON must be a non-empty array.');
      return { units: null, errors };
    }
    return { units: parsed, errors };
  } catch {
    errors.push('Units JSON is invalid. Fix the contract before creating the task.');
    return { units: null, errors };
  }
}

const TASK_FAMILY_OPTIONS: Array<{ value: TaskFamilyId; label: string; description: string }> = [
  { value: 'analyze', label: 'Analyze', description: 'Read context and return grounded findings.' },
  { value: 'implement', label: 'Implement', description: 'Create or modify artifacts with verification evidence.' },
  { value: 'verify', label: 'Verify', description: 'Run checks and report exact pass/fail evidence.' },
  {
    value: 'multi_agent_delegation',
    label: 'Multi-agent delegation',
    description: 'Coordinate a parent thread with bounded child-task contracts.',
  },
];

const TASK_COMPOSER_FIELD_CLASS = 'w-full rounded-lg border border-border-subtle bg-surface-elevated/70 px-3.5 py-2.5 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/25';

function formatTime(value?: number | null): string {
  if (!value) {
    return 'just now';
  }
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAcceptanceConfidence(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${Math.round(value * 100)}%`;
}

function getAcceptanceVerdictTone(verdict: TaskDebugResponse['executionSummary']['acceptance']['deterministic']['contract']['verdict']): string {
  switch (verdict) {
    case 'passed':
      return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-50';
    case 'failed':
      return 'border-rose-300/30 bg-rose-400/10 text-rose-50';
    default:
      return 'border-white/10 bg-surface text-text-secondary';
  }
}

function getAcceptanceReviewTone(status: TaskDebugResponse['executionSummary']['acceptance']['semanticReview']['status']): string {
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

function getVerdictDotClass(verdict: string | null | undefined): string {
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

function summarizeChecks(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }
  if (items.length === 1) {
    return items[0];
  }
  return `${items[0]} +${items.length - 1}`;
}

function CompactCheckList({
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

function RawJsonDetails({ label = 'Raw', value }: { label?: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-border-subtle bg-black/10">
      <summary className="cursor-pointer list-none px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted">
        {label}
      </summary>
      <pre className="workbench-raw rounded-t-none border-x-0 border-b-0">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function isMachineCorrectionText(content: string): boolean {
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

function summarizeTimelineInstruction(content: string): string {
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

function normalizeDiscussionText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getAssistantSummaryDisplayKind(message: TaskDetail['conversations'][number]): string | null {
  const displayKind = message.metadata?.displayKind;
  return typeof displayKind === 'string' && displayKind.trim() ? displayKind.trim() : null;
}

function isAssistantSummaryMessage(message: TaskDetail['conversations'][number]): boolean {
  return message.role === 'assistant' && message.metadata?.source === 'assistant_summary';
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))];
}

function isDuplicateAssistantDiscussion(message: string, visibleOutput: TaskVisibleOutputSummary | null): boolean {
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

function shouldKeepAssistantSummary(params: {
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

function getAssistantSummaryBadgeLabel(displayKind: string | null | undefined): string {
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

function getKnownArtifactState(params: {
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

function buildTimelineResultSummary(task: TaskDetail): TimelineResultSummary | null {
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

function summarizeRuntimeEvent(event: RuntimeEvent): string {
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

function getToolActivityTone(status: VisibleToolActivity['status']) {
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

function getToolActivityStatusLabel(status: VisibleToolActivity['status']) {
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

function renderToolActivityIcon(activity: VisibleToolActivity) {
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

type TimelineNodeKind =
  | 'user'
  | 'runtime'
  | 'tool'
  | 'agent'
  | 'artifact'
  | 'decision'
  | 'delegation'
  | 'result';

type TimelineNodeFrameProps = {
  kind: TimelineNodeKind;
  children: ReactNode;
  activity?: VisibleToolActivity | null;
  className?: string;
};

function getTimelineGlyphTone(kind: TimelineNodeKind): string {
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

function renderTimelineGlyph(kind: TimelineNodeKind, activity?: VisibleToolActivity | null) {
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

function getTimelineIconTestId(kind: TimelineNodeKind): string | undefined {
  if (kind === 'agent' || kind === 'result') {
    return 'task-timeline-agent-icon';
  }
  if (kind === 'tool') {
    return 'task-timeline-tool-icon';
  }
  return undefined;
}

function TimelineNodeFrame({ kind, children, activity = null, className = '' }: TimelineNodeFrameProps) {
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

function truncateToolOutput(value: string, maxChars = 1200): string {
  if (!value) {
    return '';
  }
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

type ApprovalListEntry = {
  invocationId: string;
  toolName: string;
  requestedAt: number;
  argumentsSummary: string | null;
  availableActions: Array<'APPROVED' | 'REJECTED'>;
};

function summarizeApprovalArguments(approval: ToolApproval | null): string | null {
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

function getPendingApprovalEntries(task: TaskDetail | null): ApprovalListEntry[] {
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
      availableActions: approval.availableActions,
    }));
  }
  const legacyPendingApprovals = task.pendingApprovals ?? [];
  return legacyPendingApprovals.map((approval) => ({
    invocationId: approval.invocationId,
    toolName: approval.toolName,
    requestedAt: approval.createdAt,
    argumentsSummary: summarizeApprovalArguments(approval),
    availableActions: ['APPROVED', 'REJECTED'],
  }));
}

function getFinalDestinationLabel(task: TaskDetail | null, debug: TaskDebugResponse | null): string | null {
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

function hasDeliveredArtifacts(task: TaskDetail | null, debug: TaskDebugResponse | null): boolean {
  return Boolean(
    (
      task?.completionSummary?.artifactApplyStatus === 'APPLIED'
      || task?.latestVisibleOutput?.artifactApplyStatus === 'APPLIED'
      || debug?.executionSummary.artifactPathState === 'applied'
    )
    && getFinalDestinationLabel(task, debug)
  );
}

function hasPendingApprovals(task: TaskDetail | null): boolean {
  return getPendingApprovalEntries(task).length > 0;
}

function requiresArtifactSelection(task: TaskDetail | null): boolean {
  return task?.primaryAction.kind === 'use_recommended_path' || task?.primaryAction.kind === 'choose_custom_path';
}

function getDisplayLifecycleBadge(
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

function getVisibleIssueSummary(task: TaskDetail | null, debug: TaskDebugResponse | null): string | null {
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

function buildTimeline(task: TaskDetail | null, events: RuntimeEvent[], debug: TaskDebugResponse | null): TimelineEntry[] {
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
  const operatorItems: TimelineEntry[] = task.operatorMessages.map((message) => ({
    id: `operator_${message.messageId}`,
    kind: 'operator',
    content: message.content,
    timestamp: message.createdAt,
    label: 'Operator',
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
    .filter((event) => ['TASK_STARTED', 'TASK_PAUSED', 'TASK_RESUMED', 'TASK_COMPLETED', 'TASK_FAILED', 'TASK_ARTIFACTS_APPLIED'].includes(event.type))
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

function getWorkspaceGuidanceNotice(debug: TaskDebugResponse | null, task: TaskDetail | null) {
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

function isTerminalLifecycle(status: TaskDetail['runtime']['lifecycleStatus'] | undefined) {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function shouldAutoOpenContextRail(task: TaskDetail | null, debug: TaskDebugResponse | null) {
  return Boolean(
    getPendingApprovalEntries(task).length
    || debug?.executionSummary.artifactPathState === 'unresolved'
    || getVisibleIssueSummary(task, debug)
    || task?.diagnostics.lastError
    || debug?.executionSummary.recovery.recoveryReason
  );
}

function getBlockingStripLabel(task: TaskDetail | null, debug: TaskDebugResponse | null) {
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

function TaskAcceptancePanel({ debug }: { debug: TaskDebugResponse | null }) {
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
  const qualitySummary = acceptance.quality.profileId
    ? acceptance.quality.failedChecks[0]
      ?? (acceptance.quality.passedChecks[0] ?? 'Quality profile evaluated.')
    : 'No quality profile is attached to this task.';
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

      <div data-testid="task-acceptance-quality-review" className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Quality</p>
            <p className="mt-1 text-sm text-text-secondary">{qualitySummary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className={`inline-flex items-center gap-2 uppercase tracking-[0.16em] ${getVerdictDotClass(acceptance.quality.verdict)}`}>
              <span className="status-dot" />
              {acceptance.quality.verdict}
            </span>
            <span>{acceptance.quality.profileId ?? 'none'}</span>
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <CompactCheckList label="Failed" items={acceptance.quality.failedChecks} emptyText="none" tone={acceptance.quality.failedChecks.length ? 'error' : 'neutral'} />
          <CompactCheckList label="Next" items={acceptance.quality.requiredNextEvidence} emptyText="none" tone={acceptance.quality.requiredNextEvidence.length ? 'warning' : 'neutral'} />
          <CompactCheckList label="Passed" items={acceptance.quality.passedChecks} emptyText="none" tone="success" />
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

function DetailKeyValue({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{label}</p>
      <p className="mt-1 break-words text-sm text-text-primary">{value ?? 'n/a'}</p>
    </div>
  );
}

function TaskQualityPanel({ debug }: { debug: TaskDebugResponse | null }) {
  const quality = debug?.executionSummary.acceptance.quality ?? null;
  if (!quality) {
    return (
      <div
        data-testid="task-inspector-section-quality"
        className="rounded-lg border border-border-subtle bg-black/10 px-4 py-4 text-sm text-text-secondary"
      >
        Quality truth is not available yet.
      </div>
    );
  }

  const summary = quality.profileId
    ? quality.failedChecks[0]
      ?? quality.requiredNextEvidence[0]
      ?? quality.passedChecks[0]
      ?? 'Quality profile evaluated.'
    : 'No quality profile is attached to this task.';

  return (
    <div data-testid="task-inspector-section-quality" className="space-y-3">
      <div className="rounded-lg border border-border-subtle bg-black/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="workbench-section-title">Quality</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">{summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className={`inline-flex items-center gap-2 uppercase tracking-[0.16em] ${getVerdictDotClass(quality.verdict)}`}>
              <span className="status-dot" />
              {quality.verdict}
            </span>
            <span>{quality.profileId ?? 'none'}</span>
          </div>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <CompactCheckList label="Failed" items={quality.failedChecks} emptyText="none" tone={quality.failedChecks.length ? 'error' : 'neutral'} />
        <CompactCheckList label="Next" items={quality.requiredNextEvidence} emptyText="none" tone={quality.requiredNextEvidence.length ? 'warning' : 'neutral'} />
        <CompactCheckList label="Passed" items={quality.passedChecks} emptyText="none" tone="success" />
        <DetailKeyValue label="Last evaluated" value={quality.lastEvaluatedAt ? formatTime(quality.lastEvaluatedAt) : 'not evaluated'} />
      </div>
      <RawJsonDetails label="Raw quality" value={quality} />
    </div>
  );
}

function TaskExperiencePanel({ debug }: { debug: TaskDebugResponse | null }) {
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
          Approved experience remains advisory. Task completion is still controlled by acceptance and quality gates.
        </p>
      )}
      <RawJsonDetails label="Raw experience" value={experienceSummary} />
    </div>
  );
}

function buildCredibilitySummary(task: TaskDetail | null, execution: TaskDebugResponse['executionSummary'] | null) {
  if (!task || !execution) {
    return {
      verdict: 'Waiting for task truth',
      detail: 'Runtime, acceptance, artifact, and quality evidence are not loaded yet.',
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
  const qualityVerdict = execution.acceptance.quality?.verdict ?? 'not_applicable';
  const gaps: string[] = [];
  if (deterministicVerdict === 'failed') {
    gaps.push('acceptance contract');
  }
  if (qualityVerdict === 'failed') {
    gaps.push('quality contract');
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
      detail: 'Acceptance, evidence, artifact state, and quality contract do not report blockers.',
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

function TaskDetailTabPanel({
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
  const quality = execution?.acceptance?.quality ?? null;
  if (activeTab === 'quality') {
    return <TaskQualityPanel debug={debug} />;
  }

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
          <DetailKeyValue label="Quality" value={quality?.profileId ? `${quality.profileId}: ${quality.verdict}` : 'none'} />
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

function buildInspectorSnapshot(params: {
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

function mergeInspectorSnapshot(
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

function getPrimaryStatusSummary(task: TaskDetail | null, debug: TaskDebugResponse | null, realtimeStatus: RealtimeTransportStatus) {
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

function getRealtimeStatusLabel(status: RealtimeTransportStatus): string {
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

function getComposerButtonClass(tone: ComposerButtonTone) {
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

function renderComposerButtonIcon(icon: ComposerButtonIcon) {
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

function runtimeClearlyRequestsGuidance(task: TaskDetail, debug: TaskDebugResponse | null): boolean {
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

function getComposerModel(task: TaskDetail | null, debug: TaskDebugResponse | null): ComposerModel {
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

  if (task.primaryAction.kind === 'start_task' || task.primaryAction.kind === 'resume_task' || task.primaryAction.kind === 'restart_task') {
    const isResume = task.primaryAction.kind === 'resume_task';
    const isRestart = task.primaryAction.kind === 'restart_task';
    return {
      mode: 'action',
      title: task.statusSummary.label,
      description: task.primaryAction.description,
      placeholder: `${task.primaryAction.label} before sending a message...`,
      buttonLabel: task.primaryAction.label,
      disabled: false,
      submitKind: isResume ? 'resume' : isRestart ? 'restart' : 'start',
      buttonTone: isResume ? 'warning' : task.runtime.lifecycleStatus === 'FAILED' ? 'danger' : 'accent',
      buttonIcon: isResume ? 'resume' : isRestart ? 'retry' : 'play',
      requiresMessage: false,
      collapsibleFollowUp: false,
      buttonTestId: isResume ? 'task-action-resume' : isRestart ? 'task-action-restart' : 'task-action-start',
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
        description: 'Inspect diagnostics first, then send a concrete repair instruction if restart is not the right next step.',
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

export function TasksPage() {
  const location = useLocation();
  const [showArchived, setShowArchived] = useState(false);
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
    applyTaskSnapshot: applyTaskSummarySnapshot,
  } = useTasks({ includeArchived: showArchived });
  const { tasks: allTasks, applyTaskSnapshot: applyAllTaskSummarySnapshot } = useTasks({ includeArchived: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const {
    task: loadedTask,
    events,
    loading: taskLoading,
    error: taskError,
    reload: reloadTask,
    appendEvent,
    applySnapshot,
  } = useTaskDetail(selectedTaskId);
  const [debug, setDebug] = useState<TaskDebugResponse | null>(null);
  const debugCacheRef = useRef<Map<string, TaskDebugResponse>>(new Map());
  const debugRequestSequence = useRef(0);
  const inspectorSnapshotCacheRef = useRef<Map<string, TaskInspectorSnapshot>>(new Map());
  const [detailsOpen, setDetailsOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true));
  const [latchedAutoOpenTaskId, setLatchedAutoOpenTaskId] = useState<string | null>(null);
  const [dismissedAutoOpenTaskId, setDismissedAutoOpenTaskId] = useState<string | null>(null);
  const [threadsCollapsed, setThreadsCollapsed] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 1024 : false));
  const [mobileThreadRailOpen, setMobileThreadRailOpen] = useState(false);
  const [shallowVerticalViewport, setShallowVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 760 : false));
  const [compactVerticalViewport, setCompactVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 640 : false));
  const [ultraCompactVerticalViewport, setUltraCompactVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 560 : false));
  const [activeTab, setActiveTab] = useState<DetailTab>('summary');
  const [composerOpen, setComposerOpen] = useState(false);
  const [continueMessage, setContinueMessage] = useState('');
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [latchedComposerModel, setLatchedComposerModel] = useState<ComposerModel | null>(null);
  const [artifactDir, setArtifactDir] = useState('');
  const [customArtifactMode, setCustomArtifactMode] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeTransportStatus>({
    connected: false,
    mode: 'reconnecting',
    reason: 'Realtime transport has not connected yet.',
    latestEventId: null,
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null);
  const [taskDeleteRequested, setTaskDeleteRequested] = useState(false);
  const [wideContextViewport, setWideContextViewport] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true));

  const ws = useMemo(() => new WebSocketClient({
    fetchEvents: (taskId, afterEventId) => api.getTaskEvents(taskId, afterEventId),
  }), []);
  const requestedTaskId = searchParams.get('task');
  const explicitNoSelection = requestedTaskId === 'none';
  const task = loadedTask && selectedTaskId && loadedTask.definition.taskId === selectedTaskId ? loadedTask : null;
  const shouldShowTaskLoadingShell = Boolean(selectedTaskId && !task && !taskError);

  function commitDebugSnapshot(taskId: string, snapshot: TaskDebugResponse) {
    debugCacheRef.current.set(taskId, snapshot);
    setDebug(snapshot);
  }

  useEffect(() => () => ws.disconnect(), [ws]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleResize = () => {
      setWideContextViewport(window.innerWidth >= 1024);
      setShallowVerticalViewport(window.innerHeight < 760);
      setCompactVerticalViewport(window.innerHeight < 640);
      setUltraCompactVerticalViewport(window.innerHeight < 560);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (wideContextViewport) {
      setMobileThreadRailOpen(false);
    }
  }, [wideContextViewport]);

  useEffect(() => {
    if (explicitNoSelection) {
      if (selectedTaskId !== null) {
        setSelectedTaskId(null);
      }
      return;
    }

    if (requestedTaskId) {
      if (requestedTaskId !== selectedTaskId) {
        setSelectedTaskId(requestedTaskId);
        return;
      }

      const requestedTaskKnown = tasks.some((entry) => entry.taskId === requestedTaskId)
        || allTasks.some((entry) => entry.taskId === requestedTaskId);
      if (!taskLoading && taskError && !requestedTaskKnown && tasks.length > 0) {
        const fallbackTaskId = tasks[0].taskId;
        setSelectedTaskId(fallbackTaskId);
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set('task', fallbackTaskId);
        setSearchParams(nextParams, { replace: true });
      }
      return;
    }

    if (!selectedTaskId && tasks.length > 0) {
      const fallbackTaskId = tasks[0].taskId;
      setSelectedTaskId(fallbackTaskId);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('task', fallbackTaskId);
      setSearchParams(nextParams, { replace: true });
    }
  }, [allTasks, explicitNoSelection, requestedTaskId, searchParams, selectedTaskId, setSearchParams, taskError, taskLoading, tasks]);

  useEffect(() => {
    if (!selectedTaskId) {
      debugRequestSequence.current += 1;
      setDebug(null);
      setTaskDeleteRequested(false);
      return;
    }

    const cachedDebug = debugCacheRef.current.get(selectedTaskId) ?? null;
    setDebug(cachedDebug);
    const currentRequest = debugRequestSequence.current + 1;
    debugRequestSequence.current = currentRequest;

    void api.getTaskDebug(selectedTaskId)
      .then((value) => {
        if (debugRequestSequence.current !== currentRequest) {
          return;
        }
        commitDebugSnapshot(selectedTaskId, value);
        setArtifactDir((current) => {
          const selectedDir = value.executionSummary.selectedArtifactDir ?? '';
          const recommendedDir = value.executionSummary.recommendedArtifactDir ?? '';
          if (selectedDir) {
            return selectedDir;
          }
          if (current.trim()) {
            return current;
          }
          return recommendedDir;
        });
        setCustomArtifactMode((current) => {
          const selectedDir = value.executionSummary.selectedArtifactDir ?? '';
          const recommendedDir = value.executionSummary.recommendedArtifactDir ?? '';
          if (value.executionSummary.artifactPathState === 'applied') {
            return false;
          }
          if (selectedDir && selectedDir !== recommendedDir) {
            return true;
          }
          if (value.executionSummary.artifactPathState === 'unresolved' && !selectedDir) {
            return current;
          }
          return false;
        });
      })
      .catch(() => {
        if (debugRequestSequence.current !== currentRequest) {
          return;
        }
        setDebug((current) => current ?? cachedDebug);
      });
  }, [selectedTaskId, task?.runtime.lifecycleStatus, task?.pendingApprovals?.length, task?.pendingApprovalItems?.length]);

  useEffect(() => {
    if (!task?.canDelete) {
      setTaskDeleteRequested(false);
    }
  }, [task?.canDelete, task?.definition.taskId]);

  useEffect(() => {
    const unsubscribeEvent = ws.onEvent((event) => {
      appendEvent(event);
      if (event.taskId === selectedTaskId) {
        void api.getTaskDebug(event.taskId).then((value) => {
          if (event.taskId === selectedTaskId) {
            commitDebugSnapshot(event.taskId, value);
          }
        }).catch(() => undefined);
      }
      void reloadTasks();
    });
    const unsubscribeSnapshot = ws.onSnapshot((snapshot) => {
      applyTaskSummarySnapshot(snapshot.task);
      applyAllTaskSummarySnapshot(snapshot.task);
      if (snapshot.taskId && snapshot.taskId === selectedTaskId) {
        applySnapshot(snapshot.task);
      }
    });
    const unsubscribeStatus = ws.onStatusChange((status) => setRealtimeStatus(status));
    return () => {
      unsubscribeEvent();
      unsubscribeSnapshot();
      unsubscribeStatus();
    };
  }, [appendEvent, applyAllTaskSummarySnapshot, applySnapshot, applyTaskSummarySnapshot, reloadTasks, selectedTaskId, ws]);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    ws.subscribe(selectedTaskId);
    return () => ws.unsubscribe(selectedTaskId);
  }, [selectedTaskId, ws]);

  const timeline = buildTimeline(task, events, debug);
  const primarySummary = getPrimaryStatusSummary(task, debug, realtimeStatus);
  const primaryLifecycleBadge = getDisplayLifecycleBadge(task, debug, primarySummary.lifecycle);
  const liveComposerModel = getComposerModel(task, debug);
  const keepLatchedComposerModel = Boolean(
    latchedComposerModel
    && latchedComposerModel.requiresMessage
    && (composerFocused || continueMessage.trim().length > 0)
  );
  const composerModel = keepLatchedComposerModel ? latchedComposerModel! : liveComposerModel;
  const hasComposerDraft = continueMessage.trim().length > 0;
  const composerModelChangedWhileEditing = Boolean(
    hasComposerDraft
    && (
      !composerModel.requiresMessage
      || (
        keepLatchedComposerModel
        && (
          liveComposerModel.mode !== latchedComposerModel!.mode
          || liveComposerModel.submitKind !== latchedComposerModel!.submitKind
          || liveComposerModel.buttonLabel !== latchedComposerModel!.buttonLabel
          || liveComposerModel.description !== latchedComposerModel!.description
        )
      )
    )
  );
  const workspaceGuidance = getWorkspaceGuidanceNotice(debug, task);
  const autoOpenContext = shouldAutoOpenContextRail(task, debug);
  const effectiveDetailsOpen = Boolean(
    detailsOpen
    || (
      wideContextViewport
      && latchedAutoOpenTaskId
      && selectedTaskId
      && latchedAutoOpenTaskId === selectedTaskId
      && dismissedAutoOpenTaskId !== selectedTaskId
    )
  );
  const contextRailPresence = useAnimatedPresence(effectiveDetailsOpen, 160);
  const composerPresence = useAnimatedPresence(composerOpen, 160);
  const detailsToggleLabel = effectiveDetailsOpen ? 'Hide details' : 'Show details';

  useEffect(() => {
    setCustomArtifactMode(false);
    setContinueMessage('');
    setComposerFocused(false);
    setLatchedComposerModel(null);
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId || (!composerFocused && continueMessage.trim().length === 0)) {
      setLatchedComposerModel(null);
    }
  }, [composerFocused, continueMessage, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDismissedAutoOpenTaskId(null);
      setLatchedAutoOpenTaskId(null);
      setDetailsOpen(false);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setLatchedAutoOpenTaskId(null);
      return;
    }
    if (dismissedAutoOpenTaskId === selectedTaskId) {
      setLatchedAutoOpenTaskId((current) => (current === selectedTaskId ? null : current));
      return;
    }
    if (autoOpenContext) {
      setLatchedAutoOpenTaskId(selectedTaskId);
      return;
    }
    setLatchedAutoOpenTaskId((current) => (current === selectedTaskId ? null : current));
  }, [autoOpenContext, dismissedAutoOpenTaskId, selectedTaskId]);

  async function refreshSelectedTask() {
    await Promise.allSettled([
      reloadTasks(),
      reloadTask(),
      selectedTaskId ? api.getTaskDebug(selectedTaskId).then((value) => commitDebugSnapshot(selectedTaskId, value)) : Promise.resolve(),
    ]);
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    try {
      setBusyAction(label);
      setActionError(null);
      await action();
      await refreshSelectedTask();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Task action failed.');
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveApproval(approval: ApprovalListEntry, status: 'APPROVED' | 'REJECTED') {
    await runAction(status, async () => {
      await api.resolveApproval(selectedTaskId!, approval.invocationId, status);
    });
  }

  async function submitContinue() {
    await runAction('continue', async () => {
      await api.continueTask(selectedTaskId!, continueMessage || undefined, { autoRun: true });
      setContinueMessage('');
      setComposerFocused(false);
      setLatchedComposerModel(null);
      setComposerExpanded(false);
    });
  }

  async function triggerComposerPrimaryAction() {
    if (!selectedTaskId || composerModel.disabled || busyAction !== null) {
      return;
    }

    if (composerModel.submitKind === 'continue') {
      await submitContinue();
      return;
    }

    if (composerModel.submitKind === 'start') {
      await runAction('start', async () => {
        await api.startTask(selectedTaskId, undefined, { autoRun: true });
      });
      return;
    }

    if (composerModel.submitKind === 'resume') {
      await runAction('resume', async () => {
        await api.resumeTask(selectedTaskId, undefined, { autoRun: true });
      });
      return;
    }

    if (composerModel.submitKind === 'restart') {
      await runAction('restart', async () => {
        await api.restartTask(selectedTaskId, undefined, { autoRun: true });
      });
    }
  }

  async function applyArtifacts(destinationDir?: string) {
    await runAction('apply', async () => {
      await api.applyArtifacts(selectedTaskId!, destinationDir);
      setCustomArtifactMode(false);
    });
  }

  async function useRecommendedArtifactPath() {
    await applyArtifacts();
  }

  function openCustomArtifactPath() {
    const recommendedDir = debug?.executionSummary.recommendedArtifactDir ?? '';
    setArtifactDir((current) => (current.trim() === recommendedDir ? '' : current));
    setCustomArtifactMode(true);
    setDismissedAutoOpenTaskId(null);
    setDetailsOpen(true);
  }

  async function applyCustomArtifactPath() {
    await applyArtifacts(artifactDir.trim() || undefined);
  }

  async function archiveSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    if (!task.canArchive) {
      setActionError('Only terminal tasks can be archived.');
      return;
    }
    await runAction('archive', async () => {
      await api.archiveTask(selectedTaskId);
    });
  }

  async function unarchiveSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    await runAction('unarchive', async () => {
      await api.unarchiveTask(selectedTaskId);
    });
  }

  function requestDeleteSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    if (!task.canDelete) {
      setActionError('Only terminal tasks can be deleted permanently.');
      return;
    }
    setTaskDeleteRequested(true);
  }

  async function deleteSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    const previousTaskId = selectedTaskId;
    const previousParams = new URLSearchParams(searchParams);
    try {
      setBusyAction('delete');
      setActionError(null);
      setTaskDeleteRequested(false);
      const pendingParams = new URLSearchParams(searchParams);
      pendingParams.set('task', 'none');
      setSelectedTaskId(null);
      setSearchParams(pendingParams, { replace: true });
      setDebug(null);
      await api.deleteTask(selectedTaskId);
      const nextTasks = await api.getTasks(showArchived);
      setContinueMessage('');
      setComposerFocused(false);
      setLatchedComposerModel(null);
      setComposerExpanded(false);
      const nextParams = new URLSearchParams(searchParams);
      if (nextTasks.length > 0) {
        setSelectedTaskId(nextTasks[0].taskId);
        nextParams.set('task', nextTasks[0].taskId);
      } else {
        setSelectedTaskId(null);
        nextParams.set('task', 'none');
      }
      setSearchParams(nextParams, { replace: true });
      await reloadTasks();
    } catch (error) {
      setSelectedTaskId(previousTaskId);
      setSearchParams(previousParams, { replace: true });
      setActionError(error instanceof Error ? error.message : 'Task action failed.');
    } finally {
      setBusyAction(null);
    }
  }

  function selectTask(taskId: string | null) {
    setSelectedTaskId(taskId);
    setMobileThreadRailOpen(false);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('task', taskId ?? 'none');
    setSearchParams(nextParams, { replace: true });
  }

  const showPause = task?.runtime.lifecycleStatus === 'RUNNING';
  const showRefresh = Boolean(selectedTaskId);
  const reducedSummaryViewport = shallowVerticalViewport || compactVerticalViewport;
  const compactThreadRail = wideContextViewport && threadsCollapsed;
  const showThreadRail = wideContextViewport || mobileThreadRailOpen;
  const archivedTaskCount = allTasks.filter((entry) => entry.isArchived).length;
  const taskNavItems = useMemo(() => ([
    {
      key: 'tasks',
      to: '/tasks',
      label: 'Tasks',
      icon: TasksIcon,
      count: tasks.length || null,
      active: location.pathname.startsWith('/tasks'),
    },
    {
      key: 'dashboard',
      to: '/dashboard',
      label: 'Dashboard',
      icon: DashboardIcon,
      count: null,
      active: location.pathname.startsWith('/dashboard'),
    },
    {
      key: 'queue',
      to: '/queue',
      label: 'Queue',
      icon: QueueIcon,
      count: tasks.filter((entry) => !entry.isArchived && entry.lifecycleStatus !== 'COMPLETED').length || null,
      active: location.pathname.startsWith('/queue'),
    },
    {
      key: 'ecosystem',
      to: '/settings/ecosystem',
      label: 'Ecosystem',
      icon: CapabilityIcon,
      count: null,
      active: location.pathname.startsWith('/settings/ecosystem'),
    },
    {
      key: 'settings',
      to: '/settings/general',
      label: 'Settings',
      icon: SettingsIcon,
      count: null,
      active: location.pathname.startsWith('/settings') && !location.pathname.startsWith('/settings/ecosystem'),
    },
  ]), [archivedTaskCount, location.pathname, tasks]);
  const showCollapsedFollowUp = false;
  const showFooterActionRow = Boolean(
    showPause
    || showRefresh
    || task?.isArchived
    || task?.canArchive
    || task?.canDelete
  );
  const timelineBottomPaddingClass = showFooterActionRow ? 'pb-40 sm:pb-48' : 'pb-28 sm:pb-32';
  const pendingApprovalEntries = getPendingApprovalEntries(task);
  const primaryApproval = pendingApprovalEntries[0] ?? null;
  const primaryApprovalArgumentSummary = primaryApproval?.argumentsSummary ?? null;
  const artifactSelectionRequired = requiresArtifactSelection(task);
  const visibleIssueSummary = getVisibleIssueSummary(task, debug);
  const hasRecoveryBlocker = Boolean(
    task
    && (
      task.runtime.lifecycleStatus === 'FAILED'
      || task.runtime.lifecycleStatus === 'CANCELLED'
      || task.primaryAction.kind === 'restart_task'
    )
    && (
      task.diagnostics.lastError
      || debug?.executionSummary.recovery.recoveryReason
      || visibleIssueSummary
    )
  );
  const hasRuntimeBlocker = Boolean(
    task
    && !isTerminalLifecycle(task.runtime.lifecycleStatus)
    && task.primaryAction.kind === 'wait'
    && visibleIssueSummary
  );
  const shouldShowStatusStrip = Boolean(
    task
    && (
      primaryApproval
      || artifactSelectionRequired
      || Boolean(task.delegationSummary.activeChildTask)
      || hasRecoveryBlocker
      || hasRuntimeBlocker
    )
  );
  const recommendedArtifactDir = artifactSelectionRequired
    ? (
      task?.primaryAction.kind === 'use_recommended_path'
        ? task.primaryAction.destinationDir
        : debug?.executionSummary.recommendedArtifactDir ?? null
      )
      : null;
  const blockingStripLabel = getBlockingStripLabel(task, debug);
  const importantContextCards = (() => {
    if (!task) {
      return [];
    }
    const cards: Array<{ label: string; title: string; detail: string }> = [];
    if (primaryApproval) {
      cards.push({
        label: 'Approval summary',
        title: primaryApproval.toolName,
        detail: primaryApproval.argumentsSummary ?? 'An operator decision is required before the thread can continue.',
      });
    }
    if (artifactSelectionRequired) {
      cards.push({
        label: 'Artifact destination',
        title: recommendedArtifactDir ?? task.primaryAction.destinationDir ?? 'Select a delivery path',
        detail: task.nextActionSummary.reason || 'Choose a project-relative destination before the artifact can be applied.',
      });
    }
    if (task.delegationSummary.activeChildTask) {
      cards.push({
        label: 'Delegation',
        title: task.delegationSummary.activeChildTask.title || 'Delegated child task active',
        detail: task.delegationSummary.activeChildTask.goal || task.nextActionSummary.reason || 'Wait for the bounded child task to finish.',
      });
    }
    if (hasRecoveryBlocker) {
      cards.push({
        label: 'Recovery',
        title: task.primaryAction.label || task.statusSummary.label,
        detail: task.diagnostics.lastError || debug?.executionSummary.recovery.recoveryReason || visibleIssueSummary || task.statusSummary.detail || 'Review the last failure before continuing.',
      });
    }
    if (hasRuntimeBlocker) {
      cards.push({
        label: 'Runtime blocker',
        title: task.statusSummary.label,
        detail: visibleIssueSummary ?? 'The runtime is waiting on a blocker before it can continue.',
      });
    }
    return cards;
  })();
  const cachedInspectorSnapshot = selectedTaskId
    ? inspectorSnapshotCacheRef.current.get(selectedTaskId) ?? null
    : null;
  const inspectorSnapshotCandidate = task ? buildInspectorSnapshot({
    task,
    debug,
    importantCards: importantContextCards,
    pendingApprovalEntries,
    artifactSelectionRequired,
  }) : null;
  const activeInspectorSnapshot = task
    ? mergeInspectorSnapshot(inspectorSnapshotCandidate, cachedInspectorSnapshot)
    : cachedInspectorSnapshot;
  const approvalEntriesForInspector = activeInspectorSnapshot?.pendingApprovalEntries ?? pendingApprovalEntries;
  const artifactContextForInspector = activeInspectorSnapshot?.artifactContext ?? null;
  const inspectorLoading = Boolean(selectedTaskId && !activeInspectorSnapshot && (taskLoading || (!task && !taskError)));
  const showHeaderFollowUpAction = ultraCompactVerticalViewport && task?.runtime.lifecycleStatus === 'COMPLETED' && showCollapsedFollowUp;
  const showHeaderLifecycleActions = ultraCompactVerticalViewport && Boolean(task?.isArchived || task?.canArchive || task?.canDelete);
  const hasCompactHeaderActions = Boolean(
    primaryApproval
    || artifactSelectionRequired
    || showHeaderFollowUpAction
    || showHeaderLifecycleActions
  );

  useEffect(() => {
    if (pendingApprovalEntries.length === 0) {
      setExpandedApprovalId(null);
      return;
    }
    if (!expandedApprovalId || !pendingApprovalEntries.some((approval) => approval.invocationId === expandedApprovalId)) {
      setExpandedApprovalId(pendingApprovalEntries[0]?.invocationId ?? null);
    }
  }, [expandedApprovalId, pendingApprovalEntries]);

  useEffect(() => {
    if (!selectedTaskId) {
      inspectorSnapshotCacheRef.current.clear();
      return;
    }
    const mergedSnapshot = mergeInspectorSnapshot(
      inspectorSnapshotCandidate,
      inspectorSnapshotCacheRef.current.get(selectedTaskId) ?? null
    );
    if (mergedSnapshot) {
      inspectorSnapshotCacheRef.current.set(selectedTaskId, mergedSnapshot);
    }
  }, [inspectorSnapshotCandidate, selectedTaskId]);

  const shouldShowCustomArtifactInput = Boolean(
    task
    && artifactSelectionRequired
    && (customArtifactMode || task.primaryAction.kind === 'choose_custom_path' || !recommendedArtifactDir)
  );
  const expandedThreadRailWidthClass = wideContextViewport
    ? ultraCompactVerticalViewport
      ? 'w-[15.5rem] xl:w-[16.5rem]'
      : compactVerticalViewport
        ? 'w-64 xl:w-[17rem]'
        : 'w-72 xl:w-[19rem]'
    : '';
  const composerProviderLabel = [debug?.executionSummary.providerSummary.providerId, debug?.executionSummary.providerSummary.modelId]
    .filter(Boolean)
    .join(' / ') || task?.definition.preferredProviderId || 'No provider selected';
  const composerDestinationLabel = debug?.executionSummary.selectedArtifactDir
    ?? debug?.executionSummary.recommendedArtifactDir
    ?? task?.primaryAction.destinationDir
    ?? 'workspace';
  const composerTruthLabel = debug?.executionSummary.acceptance?.deterministic?.contract?.verdict
    ? `Acceptance ${debug.executionSummary.acceptance.deterministic.contract.verdict}`
    : 'Acceptance pending';
  const executionTruth = debug?.executionSummary ?? null;
  const credibilitySummary = buildCredibilitySummary(task, executionTruth);
  const confidenceScore = !task || !executionTruth
    ? 24
    : credibilitySummary.gaps.length === 0 && task.runtime.lifecycleStatus === 'COMPLETED'
      ? 92
      : Math.max(36, 78 - credibilitySummary.gaps.length * 14);
  const acceptanceVerdict = executionTruth?.acceptance?.deterministic?.contract?.verdict ?? 'pending';
  const qualityVerdict = executionTruth?.acceptance?.quality?.verdict ?? 'not_applicable';
  const issuePlaneLabel = executionTruth?.issuePlane ?? 'none';
  const issueSummaryLabel = executionTruth?.issueSummary ?? task?.diagnostics.lastError ?? 'No blocking issues detected.';
  const suggestedActionLabel = executionTruth?.suggestedAction?.label ?? task?.primaryAction.label ?? 'Review task truth';
  const suggestedActionReason = executionTruth?.suggestedAction?.reason ?? task?.nextActionSummary.reason ?? task?.primaryAction.description ?? 'Select a thread or create a task.';
  const artifactPathStateLabel = executionTruth?.artifactPathState ?? 'sandbox_only';
  const deliveredArtifactCount = executionTruth?.artifactDestinationPaths.length ?? 0;
  const createdArtifactCount = executionTruth?.artifactPaths.length ?? 0;

  useEffect(() => {
    setComposerExpanded(false);
  }, [selectedTaskId, composerModel.mode]);

  function toggleContextPanel() {
    if (!task || !selectedTaskId) {
      setDetailsOpen((value) => !value);
      return;
    }
    if (effectiveDetailsOpen) {
      setDetailsOpen(false);
      if (autoOpenContext && wideContextViewport) {
        setDismissedAutoOpenTaskId(selectedTaskId);
      }
      return;
    }
    setDismissedAutoOpenTaskId(null);
    setDetailsOpen(true);
  }

  function focusThreadComposer() {
    setComposerExpanded(true);
    window.setTimeout(() => {
      const node = document.querySelector('[data-testid="task-continue-message"]');
      if (node instanceof HTMLTextAreaElement) {
        node.focus();
      }
    }, 0);
  }

  return (
    <div className="relative flex h-full max-h-full min-h-0 min-w-0 overflow-hidden bg-[radial-gradient(circle_at_30%_0%,rgba(59,130,246,0.12),transparent_28rem),radial-gradient(circle_at_72%_12%,rgba(139,92,246,0.10),transparent_30rem),linear-gradient(180deg,#0b0b0d_0%,#080809_100%)]" data-testid="tasks-page">
      {!wideContextViewport && mobileThreadRailOpen ? (
        <button
          type="button"
          aria-label="Close threads drawer"
          className="absolute inset-0 z-30 bg-black/45 backdrop-blur-[1px]"
          onClick={() => setMobileThreadRailOpen(false)}
        />
      ) : null}

      <aside
        className={`${
          wideContextViewport
            ? `${threadsCollapsed ? 'w-16' : expandedThreadRailWidthClass} relative`
            : `${showThreadRail ? 'translate-x-0' : '-translate-x-full'} absolute inset-y-0 left-0 z-40 w-[min(21rem,calc(100%-1.25rem))] max-w-[21rem] shadow-2xl`
        } flex h-full min-h-0 flex-shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-[linear-gradient(180deg,rgba(17,17,20,0.98),rgba(11,11,13,0.98))] transition-all duration-normal lg:pb-10`}
        data-testid="tasks-explorer-scroll"
      >
        <div data-testid="task-thread-rail" className="flex h-full min-h-0 flex-col overflow-hidden">
        {wideContextViewport && threadsCollapsed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="task-threads-collapse-toggle"
            aria-label={threadsCollapsed ? 'Expand thread rail' : 'Collapse thread rail'}
            title={threadsCollapsed ? 'Expand thread rail' : 'Collapse thread rail'}
            className="absolute right-2 top-3 z-10 h-10 w-10 rounded-full p-0"
            onClick={() => setThreadsCollapsed((value) => !value)}
          >
            {threadsCollapsed ? <ChevronRightIcon className="h-4 w-4" /> : <ChevronLeftIcon className="h-4 w-4" />}
          </Button>
        ) : null}
        <div className={`flex-shrink-0 ${compactThreadRail ? 'px-2 pb-4 pt-14' : ultraCompactVerticalViewport ? 'px-3 py-3.5' : 'px-4 py-4'}`}>
          {!compactThreadRail ? (
            <div className={`flex flex-col ${ultraCompactVerticalViewport ? 'gap-2' : 'gap-3'}`}>
              <div className="flex items-center gap-3 px-1">
                <img
                  src="/logo.png"
                  alt="SCC Batch"
                  data-testid="app-brand-logo"
                  className="h-10 w-10 rounded-lg border border-white/10 object-cover shadow-[0_0_24px_rgba(99,102,241,0.34)]"
                />
                <div className="min-w-0">
                  <p className="truncate text-[1.05rem] font-semibold leading-tight text-text-primary">SCC Batch</p>
                  <p className="mt-0.5 text-[11px] leading-none text-text-muted">Agent Console</p>
                </div>
              </div>
              <nav className="space-y-1 border-b border-border-subtle pb-3" aria-label="Primary task console navigation">
                {taskNavItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.key}
                      to={item.to}
                      data-testid={`task-rail-nav-${item.key}`}
                      data-active={item.active ? 'true' : 'false'}
                      className={() =>
                        `flex h-10 items-center justify-between rounded-md border px-3 text-sm transition duration-fast ${
                          item.active
                            ? 'border-border-default bg-surface-elevated text-text-primary shadow-[inset_3px_0_0_rgba(99,102,241,0.86)]'
                            : 'border-transparent text-text-secondary hover:border-border-subtle hover:bg-surface-hover hover:text-text-primary'
                        }`
                      }
                    >
                      <span className="inline-flex min-w-0 items-center gap-3">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.count ? (
                        <span className="rounded-md border border-border-default bg-black/20 px-1.5 py-0.5 text-[11px] leading-none text-text-secondary">
                          {item.count}
                        </span>
                      ) : null}
                    </NavLink>
                  );
                })}
              </nav>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-text-muted">Threads</p>
                  <h1 className={`${ultraCompactVerticalViewport ? 'text-sm' : 'text-base'} font-semibold text-text-primary`}>Today</h1>
                </div>
                {wideContextViewport ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="task-threads-collapse-toggle"
                    aria-label="Collapse thread rail"
                    title="Collapse thread rail"
                    className="h-10 w-10 flex-shrink-0 rounded-full p-0"
                    onClick={() => setThreadsCollapsed(true)}
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              <div className={`grid grid-cols-2 ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-2'}`}>
                <Button
                  data-testid="task-toggle-show-archived"
                  variant={showArchived ? 'secondary' : 'ghost'}
                  size="sm"
                  className={`min-w-0 justify-center ${ultraCompactVerticalViewport ? 'px-2.5 text-xs' : ''}`}
                  disabled={!showArchived && archivedTaskCount === 0}
                  onClick={() => setShowArchived((current) => !current)}
                  title={
                    archivedTaskCount === 0
                      ? 'There are no archived threads to show right now.'
                      : showArchived
                        ? 'Hide archived threads from this rail.'
                        : 'Show archived threads in this rail.'
                  }
                >
                  <ArchiveIcon className="h-4 w-4" />
                  {archivedTaskCount === 0
                    ? 'Archived'
                    : showArchived
                      ? `Hide (${archivedTaskCount})`
                      : `Archived (${archivedTaskCount})`}
                </Button>
                <Button
                  data-testid="task-create-thread-inline"
                  size="sm"
                  className={`min-w-0 justify-center bg-gradient-to-r from-accent to-violet-500 text-white hover:from-accent-hover hover:to-violet-600 ${ultraCompactVerticalViewport ? 'px-2.5 text-xs' : ''}`}
                  onClick={() => setComposerOpen(true)}
                >
                  <PlusIcon className="h-4 w-4" />
                  Create task
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-text-muted">Threads</p>
              <Button
                data-testid="task-toggle-show-archived"
                variant={showArchived ? 'secondary' : 'ghost'}
                size="sm"
                className="h-10 w-10 rounded-full p-0"
                disabled={!showArchived && archivedTaskCount === 0}
                aria-label={showArchived ? 'Hide archived threads' : 'Show archived threads'}
                title={showArchived ? 'Hide archived threads' : 'Show archived threads'}
                onClick={() => setShowArchived((current) => !current)}
              >
                <ArchiveIcon className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-10 w-10 rounded-full p-0"
                aria-label="Create task"
                title="Create task"
                onClick={() => setComposerOpen(true)}
              >
                <PlusIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
          {!wideContextViewport ? (
            <div className="mt-3 flex items-center gap-2">
              <Button data-testid="task-close-threads" variant="ghost" size="sm" onClick={() => setMobileThreadRailOpen(false)}>
                Close
              </Button>
              <Button size="sm" onClick={() => setComposerOpen(true)}>
                <PlusIcon className="h-4 w-4" />
                Create task
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-2 px-3 pb-4" data-testid="tasks-explorer-viewport">
          {tasksError ? (
            <p className="rounded-2xl border border-error/30 bg-error-muted/20 px-3 py-3 text-sm text-error">{tasksError}</p>
          ) : null}
          {showArchived ? (
            <p className="px-2 text-xs text-text-muted">Archived threads are visible in this filtered view.</p>
          ) : null}
          {tasks.map((entry) => (
            (() => {
              const preview = buildThreadPreview(entry);
              const isSelected = selectedTaskId === entry.taskId;
              const displayBadge: { label: string; variant: BadgeVariant } = isSelected
                ? getDisplayLifecycleBadge(task, debug, preview.lifecycleLabel)
                : { label: preview.lifecycleLabel, variant: preview.lifecycleVariant };
              return (
                <button
                  key={entry.taskId}
                  type="button"
                  data-testid="task-list-item"
                  onClick={() => selectTask(entry.taskId)}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition duration-fast ${isSelected ? 'border-accent/40 bg-accent-muted/80' : 'border-border-subtle bg-surface-elevated/72 hover:border-border-default hover:bg-surface-hover'}`}
                >
                  {!compactThreadRail ? (
                    <>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={displayBadge.variant}>{displayBadge.label}</Badge>
                          {entry.isArchived ? <Badge variant="outline">Archived</Badge> : null}
                        </div>
                        <span className="text-xs text-text-muted">{preview.updatedLabel}</span>
                      </div>
                      <p className="line-clamp-1 text-sm font-semibold text-text-primary">{preview.title}</p>
                    </>
                  ) : (
                    <div className="flex items-center justify-center">
                      <Badge variant={displayBadge.variant}>{displayBadge.label.slice(0, 1)}</Badge>
                    </div>
                  )}
                </button>
              );
            })()
          ))}
          {!tasksLoading && tasks.length === 0 && (
            <p className="px-2 text-sm text-text-muted">
              {showArchived ? 'No archived task threads yet.' : 'No task threads yet.'}
            </p>
          )}
        </div>
        <div className={`${compactThreadRail ? 'hidden' : 'mx-3 mb-3 rounded-lg border border-violet-400/20 bg-violet-500/10 p-3'}`}>
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="" className="h-9 w-9 rounded-lg border border-white/10 object-cover" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">New agent task</p>
              <p className="mt-0.5 text-xs leading-5 text-text-secondary">Create a grounded task from scratch.</p>
            </div>
          </div>
          <Button
            data-testid="task-create-thread-brand"
            size="sm"
            className="mt-3 w-full justify-center bg-gradient-to-r from-accent to-violet-500 text-white hover:from-accent-hover hover:to-violet-600"
            onClick={() => setComposerOpen(true)}
          >
            <PlusIcon className="h-4 w-4" />
            New task
          </Button>
        </div>
        </div>
      </aside>

      <main className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden lg:pt-10" data-testid="tasks-agent-shell">
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="task-detail-pane">
          <div
            className={`sticky top-0 z-40 border-b border-border-subtle bg-surface/92 backdrop-blur-sm flex-shrink-0 ${
              ultraCompactVerticalViewport
                ? 'px-4 py-0.5 sm:px-5 sm:py-0.5'
                : reducedSummaryViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                : compactVerticalViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                  : 'px-4 py-2.5 sm:px-5 sm:py-2.5'
            }`}
            data-testid="tasks-operator-summary"
          >
            <div className={`flex flex-wrap items-center justify-between ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-3'}`}>
              <div className="min-w-0">
                <p className={`${ultraCompactVerticalViewport ? 'text-[10px] tracking-[0.24em]' : 'text-[11px] tracking-[0.28em]'} uppercase text-text-muted font-medium`}>Current thread</p>
                <h2 className={`mt-0.5 font-semibold leading-tight text-text-primary ${
                  ultraCompactVerticalViewport
                    ? 'line-clamp-1 text-[0.76rem] sm:text-[0.82rem]'
                    : reducedSummaryViewport
                      ? 'line-clamp-1 text-[0.95rem] sm:text-[1.02rem]'
                    : compactVerticalViewport
                      ? 'text-[0.92rem] sm:text-[0.96rem]'
                      : 'text-[1.08rem] sm:text-[1.22rem]'
                }`}>
                  {task?.definition.title ?? 'Select a thread'}
                </h2>
                {!reducedSummaryViewport && task ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5 text-text-muted">
                    <span>Task ID: {task.definition.taskId.slice(0, 12)}</span>
                    <span>Updated {formatTime(task.runtime.updatedAt)}</span>
                    <span>{primarySummary.providerLabel ?? 'Provider pending'}</span>
                  </div>
                ) : !reducedSummaryViewport && !effectiveDetailsOpen ? (
                  <p className="mt-1 max-w-3xl line-clamp-2 text-sm leading-5 text-text-secondary lg:line-clamp-1">
                    Choose a thread on the left or create a new one to start working.
                  </p>
                ) : null}
              </div>
              <div className={`flex flex-wrap items-center ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-2'}`}>
                <Badge
                  variant={primaryLifecycleBadge.variant}
                  className={ultraCompactVerticalViewport ? 'px-2 py-0.5 text-[10px] opacity-80' : 'opacity-80'}
                >
                  {primaryLifecycleBadge.label}
                </Badge>
                <Badge
                  variant={realtimeStatus.mode === 'live' ? 'success' : realtimeStatus.mode === 'blocked' ? 'error' : 'warning'}
                  className={ultraCompactVerticalViewport ? 'px-2 py-0.5 text-[10px] opacity-75' : 'opacity-75'}
                >
                  <span data-testid="task-realtime-mode" title={realtimeStatus.reason ?? primarySummary.realtimeLabel}>
                    {primarySummary.realtimeLabel}
                  </span>
                </Badge>
                {task ? (
                  <span
                    data-testid="task-action-model-pill"
                    className="hidden rounded-md border border-border-subtle bg-surface/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-text-secondary sm:inline-flex"
                  >
                    <span data-testid="task-action-model">{composerModel.actionLane}</span>
                  </span>
                ) : null}
                {task ? (
                  <div className="hidden items-center gap-2 xl:flex">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!showPause || !selectedTaskId || busyAction !== null}
                      onClick={() => void runAction('pause', async () => { await api.pauseTask(selectedTaskId!); })}
                    >
                      Pause
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={focusThreadComposer}
                    >
                      Continue
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void runAction('restart', async () => { await api.restartTask(selectedTaskId!, undefined, { autoRun: true }); })}
                    >
                      Restart
                    </Button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={toggleContextPanel}
                  data-testid="task-context-toggle"
                  aria-expanded={effectiveDetailsOpen}
                  title={detailsToggleLabel}
                  className={`inline-flex min-w-[5.75rem] shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface px-3 text-xs leading-none text-text-secondary transition duration-fast hover:bg-surface-hover hover:text-text-primary ${
                    ultraCompactVerticalViewport ? 'h-7' : 'h-9'
                  } ${
                    effectiveDetailsOpen
                      ? 'border-accent bg-accent/15 text-accent'
                      : ''
                  }`}
                >
                  {detailsToggleLabel}
                </button>
              </div>
            </div>
            {!wideContextViewport ? (
              <div className={`${ultraCompactVerticalViewport ? 'mt-1.5' : compactVerticalViewport ? 'mt-2' : 'mt-2.5'} flex items-center gap-2 lg:hidden`}>
                <Button data-testid="task-open-threads" variant="secondary" size="sm" onClick={() => setMobileThreadRailOpen(true)}>
                  <ThreadsIcon className="h-4 w-4" />
                  Threads
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setComposerOpen(true)}>New task</Button>
              </div>
            ) : null}
            {shouldShowStatusStrip ? (
              <div className={`border border-border-subtle bg-surface/50 ${
                ultraCompactVerticalViewport
                  ? 'mt-1 rounded-lg px-2 py-0.5 sm:px-2.5 sm:py-0.5'
                  : reducedSummaryViewport
                    ? 'mt-1 rounded-lg px-3 py-1 sm:px-3.5 sm:py-1'
                  : compactVerticalViewport
                    ? 'mt-1 px-3 py-1 sm:px-4'
                    : 'mt-2 px-3 py-2 sm:px-4'
              }`} data-testid="task-status-strip">
              {reducedSummaryViewport ? (
                <div className={`flex items-center ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-3'}`}>
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">{blockingStripLabel}</p>
                    <p className={`${ultraCompactVerticalViewport ? 'text-[11px]' : 'text-[12px]'} font-medium leading-4 text-text-primary`}>
                      {primarySummary.blocker}
                    </p>
                    {!ultraCompactVerticalViewport ? (
                      <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-text-secondary">{primarySummary.nextAction}</p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">{blockingStripLabel}</p>
                    <p className="text-xs leading-5 text-text-secondary sm:line-clamp-2 sm:text-sm">{primarySummary.blocker}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm text-text-primary">{primarySummary.nextAction}</p>
                  </div>
                </div>
              )}
              </div>
            ) : null}
            {task && (!ultraCompactVerticalViewport || hasCompactHeaderActions) ? (
              <div className={`flex flex-wrap items-center gap-2 ${ultraCompactVerticalViewport ? 'mt-1' : 'mt-2'}`}>
                {primaryApproval ? (
                  <>
                    <Button
                      data-testid="task-primary-approve"
                      size="sm"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'APPROVED')}
                    >
                      Approve
                    </Button>
                    <Button
                      data-testid="task-primary-reject"
                      size="sm"
                      variant="secondary"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'REJECTED')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {artifactSelectionRequired ? (
                  <>
                    {recommendedArtifactDir ? (
                      <Button
                        data-testid="task-action-use-recommended-path"
                        size="sm"
                        disabled={!selectedTaskId || busyAction !== null}
                        onClick={() => void useRecommendedArtifactPath()}
                      >
                        Use recommended path
                      </Button>
                    ) : null}
                    <Button
                      data-testid="task-action-choose-custom-path"
                      size="sm"
                      variant={recommendedArtifactDir ? 'secondary' : undefined}
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={openCustomArtifactPath}
                    >
                      Choose custom path
                    </Button>
                  </>
                ) : null}
                {showHeaderFollowUpAction ? (
                  <Button
                    data-testid="task-compact-action-open-follow-up"
                    size="sm"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => setComposerExpanded(true)}
                  >
                    Continue
                  </Button>
                ) : null}
                {showHeaderLifecycleActions && task.isArchived ? (
                  <Button
                    data-testid="task-compact-action-unarchive"
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => void unarchiveSelectedTask()}
                  >
                    Restore
                  </Button>
                ) : showHeaderLifecycleActions && task.canArchive ? (
                  <Button
                    data-testid="task-compact-action-archive"
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => void archiveSelectedTask()}
                  >
                    Archive
                  </Button>
                ) : null}
                {showHeaderLifecycleActions && task.canDelete ? (
                    <Button
                      data-testid="task-compact-action-delete"
                      size="sm"
                      variant="ghost"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={requestDeleteSelectedTask}
                    >
                      Delete
                    </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className={`flex-1 min-h-0 overflow-y-auto px-4 py-4 scrollbar-thin sm:px-5 ${timelineBottomPaddingClass}`} data-testid="task-timeline-scroll">
            {taskError ? (
              <div className="mb-4 rounded-2xl border border-error/30 bg-error-muted/20 px-4 py-3 text-sm text-error">
                {taskError}
              </div>
            ) : null}
            {task?.isArchived ? (
              <div className="mb-4 max-w-3xl rounded-lg border border-border-subtle bg-surface/26 px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.26em] text-text-muted">Archived</p>
                <p className="mt-2 text-sm font-medium text-text-primary">
                  This thread is archived and hidden from the default work queue.
                </p>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  Keep it archived to store the outcome quietly, or unarchive it when you want this thread back in the active workspace.
                </p>
              </div>
            ) : null}
            {primaryApproval ? (
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
                      Approve or reject this tool request before the thread can continue.
                    </p>
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
                    <Button
                      data-testid="task-banner-approve"
                      size="sm"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'APPROVED')}
                    >
                      Approve
                    </Button>
                    <Button
                      data-testid="task-banner-reject"
                      size="sm"
                      variant="secondary"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'REJECTED')}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            {shouldShowTaskLoadingShell ? (
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
            ) : !task ? (
              <div
                data-testid="task-empty-state"
                className="mx-auto max-w-3xl rounded-lg border border-dashed border-violet-300/24 bg-surface/42 px-6 py-6 shadow-[0_18px_48px_-36px_rgba(99,102,241,0.48)]"
              >
                <div data-testid="task-empty-agent-state" className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <img
                    src="/logo.png"
                    alt="SCC Batch"
                    className="h-16 w-16 rounded-xl border border-white/10 object-cover shadow-[0_0_34px_rgba(99,102,241,0.26)]"
                  />
                  <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.3em] text-text-muted">Agent workspace</p>
                <h3 className="mt-3 text-xl font-semibold text-text-primary">Start with a conversation, finish with evidence</h3>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
                  The task workspace is ready. Connect a provider, check ecosystem readiness, or create a generic Agent task to start the main path.
                </p>
                <div data-testid="task-empty-glyph-row" className="mt-4 grid gap-2 sm:grid-cols-3">
                  <span className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/18 bg-cyan-400/8 px-3 py-2 text-xs text-cyan-100/86">
                    <span data-testid="task-empty-glyph-agent" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-cyan-300/22 bg-cyan-400/10">
                      <TimelineAgentIcon className="h-3.5 w-3.5" />
                    </span>
                    Agent thread
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/18 bg-emerald-400/8 px-3 py-2 text-xs text-emerald-100/86">
                    <span data-testid="task-empty-glyph-runtime" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-300/22 bg-emerald-400/10">
                      <TimelineRuntimeIcon className="h-3.5 w-3.5" />
                    </span>
                    Runtime truth
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-lg border border-sky-300/18 bg-sky-400/8 px-3 py-2 text-xs text-sky-100/86">
                    <span data-testid="task-empty-glyph-artifact" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-sky-300/22 bg-sky-400/10">
                      <TimelineArtifactIcon className="h-3.5 w-3.5" />
                    </span>
                    Evidence result
                  </span>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button data-testid="task-empty-create" size="sm" onClick={() => setComposerOpen(true)}>
                    <PlusIcon className="h-4 w-4" />
                    Create Agent task
                  </Button>
                  <a
                    data-testid="task-empty-connections"
                    href="/settings/connections"
                    className="inline-flex h-8 items-center rounded-md border border-border-default bg-surface-elevated px-3 text-sm text-text-primary transition duration-fast hover:bg-surface-hover"
                  >
                    Connections
                  </a>
                  <a
                    data-testid="task-empty-ecosystem"
                    href="/settings/ecosystem"
                    className="inline-flex h-8 items-center rounded-md border border-border-default bg-surface-elevated px-3 text-sm text-text-primary transition duration-fast hover:bg-surface-hover"
                  >
                    Ecosystem readiness
                  </a>
                </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="agent-conversation space-y-3" data-testid="task-conversation">
                {timeline.map((entry) => {
                if (entry.kind === 'delegation') {
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

                if (entry.kind === 'tool-activity') {
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
                              <span className="font-semibold text-text-primary">{entry.activity.toolId.replaceAll('_', ' ')}</span>
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
                            <p className={`mt-1.5 text-sm ${tone.text}`}>{entry.activity.summary}</p>
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

                if (entry.kind === 'result' || entry.kind === 'assistant-update') {
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
                          shell: 'border-rose-400/24 bg-rose-950/18 shadow-[0_14px_32px_-24px_rgba(244,63,94,0.42)]',
                          label: 'border border-rose-300/18 bg-rose-400/10 text-rose-100/92',
                          summary: 'text-rose-50',
                          details: 'text-rose-100/78',
                          section: 'border-rose-400/16 bg-black/10',
                          chip: 'border-rose-300/24 bg-black/10 text-rose-50/95',
                          meta: 'text-rose-100/58'
                        }
                        : {
                          shell: 'border-emerald-400/22 bg-emerald-950/18 shadow-[0_14px_32px_-24px_rgba(16,185,129,0.45)]',
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
                            {entry.kind === 'result' ? (isFailureResult ? 'Failure' : 'Result') : 'Progress'}
                          </span>
                          <span className="font-semibold text-text-primary">Assistant</span>
                          <span className="font-semibold">{entry.label}</span>
                        </div>
                        <span>{formatTime(entry.timestamp)}</span>
                      </div>
                      <div className="space-y-3.5">
                        <div className="space-y-1">
                          <p className={`text-base font-semibold ${cardTone.summary}`}>
                            {entry.result.summary}
                          </p>
                          {entry.result.details && (
                            <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 ${cardTone.details}`}>
                              {entry.result.details}
                            </p>
                          )}
                        </div>
                        {entry.result.issues.length > 0 && (
                          <div>
                            <p className={`text-xs uppercase tracking-[0.24em] ${cardTone.meta}`}>Issues</p>
                            <ul className={`mt-2 list-disc space-y-1 pl-5 text-sm ${cardTone.details}`}>
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
                                className={`rounded-2xl border px-4 py-3 ${cardTone.section}`}
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
                              <div>
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
                          <div
                            data-testid={entry.kind === 'result' ? 'task-result-technical-summary' : 'task-assistant-update-technical-summary'}
                            className="space-y-2 border-t border-white/5 pt-1"
                          >
                            <p className={`text-[11px] uppercase tracking-[0.24em] ${cardTone.meta}`}>
                              {entry.kind === 'result' ? 'Technical summary' : 'Runtime summary'}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {technicalSummary.map((item) => (
                                <span key={item} className={`rounded-md border px-3 py-1 text-[11px] ${cardTone.chip}`}>
                                  {item}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    </TimelineNodeFrame>
                  );
                }

                if (entry.kind === 'result-missing') {
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

                if (entry.kind === 'proposal') {
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
                            Quality: {entry.proposal.qualityScore.toFixed(2)} · Archive eligible
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

                if (entry.kind === 'proposal-note') {
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

                const timelineTone = entry.kind === 'assistant-note'
                  ? {
                    shell: 'border-sky-400/16 bg-surface/38',
                    text: 'text-text-primary',
                    meta: 'text-text-muted'
                  }
                  : entry.kind === 'user' || entry.kind === 'operator'
                    ? {
                      shell: 'border-accent/18 bg-surface/34',
                      text: 'text-text-primary',
                      meta: 'text-text-muted'
                    }
                  : entry.kind === 'runtime'
                    ? {
                      shell: 'border-border-subtle bg-surface/30',
                      text: 'text-text-secondary',
                      meta: 'text-text-muted'
                    }
                    : {
                      shell: 'ml-auto border-accent/24 bg-accent-muted/85',
                      text: 'text-text-primary',
                      meta: 'text-text-muted'
                    };
                const isOperatorCorrection = entry.kind === 'operator' && isMachineCorrectionText(entry.content);
                const genericNodeKind: TimelineNodeKind = entry.kind === 'runtime'
                  ? 'runtime'
                  : entry.kind === 'assistant-note'
                    ? requiresArtifactSelection(task)
                      ? 'decision'
                      : 'agent'
                    : isOperatorCorrection
                      ? 'decision'
                      : 'user';

                return (
                  <TimelineNodeFrame key={entry.id} kind={genericNodeKind}>
                  <div
                    data-testid={`task-timeline-entry-${entry.kind}`}
                    className={`max-w-[52rem] rounded-lg border px-3.5 py-3 ${timelineTone.shell}`}
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
                        <span>{entry.label}</span>
                        {entry.kind === 'assistant-note' ? (
                          <span className="rounded-md border border-sky-300/24 bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-sky-100/80">
                            {getAssistantSummaryBadgeLabel(entry.displayKind)}
                          </span>
                        ) : null}
                        {isOperatorCorrection ? (
                          <span className="rounded-md border border-warning/24 bg-warning-muted/12 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-warning">
                            correction summary
                          </span>
                        ) : null}
                        {entry.kind === 'assistant-note' && requiresArtifactSelection(task) ? (
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
                        entry.kind === 'runtime'
                          ? 'task-runtime-summary'
                          : entry.kind === 'assistant-note'
                            ? 'task-assistant-note'
                            : undefined
                      }
                      className={`whitespace-pre-wrap text-sm leading-6 ${timelineTone.text}`}
                    >
                      {isOperatorCorrection ? summarizeTimelineInstruction(entry.content) : entry.content}
                    </p>
                    {isOperatorCorrection ? (
                      <p className="mt-2 text-xs leading-5 text-text-muted">
                        Full machine instruction is kept in diagnostics, not the public timeline.
                      </p>
                    ) : null}
                  </div>
                  </TimelineNodeFrame>
                );
                })}
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
            )}
          </div>

          <div
            className={`sticky bottom-0 z-10 border-t border-border-subtle bg-surface/95 backdrop-blur-sm flex-shrink-0 lg:bottom-10 ${
              ultraCompactVerticalViewport
                ? 'px-4 py-0.5 sm:px-5 sm:py-0.5'
                : compactVerticalViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                  : 'px-4 py-2.5 sm:px-5'
            }`}
            data-testid="task-bottom-action-bar"
          >
            {actionError && <p className="mb-3 text-sm text-error">{actionError}</p>}
            {showFooterActionRow ? (
              <div className={`flex flex-wrap items-center justify-between ${
                ultraCompactVerticalViewport
                  ? 'mb-0.5 gap-1'
                  : compactVerticalViewport
                    ? 'mb-1 gap-1'
                    : 'mb-2 gap-2'
              }`}>
                <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">Thread controls</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {showPause && <Button data-testid="task-action-pause" size="sm" variant="secondary" disabled={!selectedTaskId || busyAction !== null} onClick={() => void runAction('pause', async () => { await api.pauseTask(selectedTaskId!); })}>Pause</Button>}
                  {selectedTaskId ? <Button data-testid="task-action-restart" size="sm" variant="ghost" disabled={busyAction !== null} onClick={() => void runAction('restart', async () => { await api.restartTask(selectedTaskId, undefined, { autoRun: true }); })}>Restart</Button> : null}
                  {task?.isArchived ? <Button data-testid="task-action-unarchive" size="sm" variant="secondary" disabled={!selectedTaskId || busyAction !== null} onClick={() => void unarchiveSelectedTask()}>Unarchive</Button> : null}
                  {!task?.isArchived && task?.canArchive ? <Button data-testid="task-action-archive" size="sm" variant="secondary" disabled={!selectedTaskId || busyAction !== null} onClick={() => void archiveSelectedTask()}>Archive</Button> : null}
                  {task?.canDelete ? <Button data-testid="task-action-delete" size="sm" variant="ghost" disabled={!selectedTaskId || busyAction !== null} onClick={requestDeleteSelectedTask}>Delete</Button> : null}
                  {showRefresh ? (
                    <Button
                      data-testid="task-action-refresh"
                      size="sm"
                      variant="ghost"
                      disabled={!selectedTaskId}
                      onClick={() => void refreshSelectedTask()}
                    >
                      <RefreshIcon className="h-4 w-4" />
                      Refresh
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div data-testid="task-composer" className="mx-auto w-full max-w-[56rem]">
            <div className={`rounded-lg border border-violet-300/28 bg-background/78 shadow-[0_0_0_1px_rgba(99,102,241,0.12),0_18px_52px_-36px_rgba(99,102,241,0.58)] ${
              ultraCompactVerticalViewport
                ? 'px-3 py-1.5'
                : compactVerticalViewport
                  ? 'px-3 py-2'
                  : 'px-4 py-3'
            }`} data-testid="task-composer-card">
              {showCollapsedFollowUp ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p data-testid="task-composer-mode" className="text-[11px] uppercase tracking-[0.28em] text-violet-200/70">follow_up</p>
                    <p className="mt-1 text-sm font-medium text-text-primary">Keep working in this thread from the delivered result when you are ready.</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Provider: {composerProviderLabel}</span>
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Destination: {composerDestinationLabel}</span>
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">{composerTruthLabel}</span>
                    </div>
                  </div>
                  <Button
                    data-testid="task-action-expand-follow-up"
                    className="w-full sm:w-auto"
                    onClick={() => setComposerExpanded(true)}
                  >
                    <SendIcon className="h-4 w-4" />
                    Continue thread
                  </Button>
                </div>
              ) : composerModel.requiresMessage || hasComposerDraft ? (
                <>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p data-testid="task-composer-mode" className="text-[11px] uppercase tracking-[0.28em] text-violet-200/70">{composerModel.actionLane}</p>
                      <p className="mt-1 text-sm font-medium text-text-primary">{composerModel.title}</p>
                      <p className="mt-1 text-sm text-text-secondary">{composerModel.description}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                        <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Provider: {composerProviderLabel}</span>
                        <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Destination: {composerDestinationLabel}</span>
                        <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">{composerTruthLabel}</span>
                      </div>
                    </div>
                  </div>
                  {composerModelChangedWhileEditing ? (
                    <div
                      data-testid="task-composer-draft-lock-notice"
                      className="mb-3 rounded-lg border border-warning/30 bg-warning-muted/12 px-3 py-2.5 text-sm text-warning"
                    >
                      Thread actions changed while you were editing. The draft stays in place so the composer does not jump; latest runtime guidance now recommends {liveComposerModel.buttonLabel.toLowerCase()}.
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <textarea
                      data-testid="task-continue-message"
                      value={continueMessage}
                      onFocus={() => {
                        setComposerFocused(true);
                        if (composerModel.requiresMessage) {
                          setLatchedComposerModel((current) => current ?? composerModel);
                        }
                      }}
                      onBlur={() => setComposerFocused(false)}
                      onChange={(event) => {
                        if (composerModel.requiresMessage) {
                          setLatchedComposerModel((current) => current ?? composerModel);
                        }
                        setContinueMessage(event.target.value);
                      }}
                      placeholder={composerModel.placeholder}
                      className="min-h-[48px] w-full flex-1 resize-none rounded-lg border border-border-default bg-black/35 px-3.5 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition duration-fast focus:border-violet-300 focus:ring-1 focus:ring-violet-300/30 sm:min-h-[56px]"
                    />
                    <div className="flex w-full flex-col gap-2 sm:w-auto">
                      <Button
                        data-testid={composerModel.buttonTestId}
                        className={`w-full sm:w-auto ${getComposerButtonClass(composerModel.buttonTone)}`}
                        disabled={
                          !selectedTaskId
                          || busyAction !== null
                          || composerModel.disabled
                          || (composerModel.mode === 'follow_up' && !continueMessage.trim())
                        }
                        onClick={() => void triggerComposerPrimaryAction()}
                      >
                        {renderComposerButtonIcon(composerModel.buttonIcon)}
                        {busyAction === 'continue'
                          ? 'Continuing...'
                          : composerModel.buttonLabel}
                      </Button>
                      {composerModel.mode === 'follow_up' && composerExpanded ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="w-full sm:w-auto"
                          onClick={() => {
                            setComposerExpanded(false);
                            setContinueMessage('');
                            setComposerFocused(false);
                            setLatchedComposerModel(null);
                          }}
                        >
                          Collapse
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${compactVerticalViewport ? '' : ''}`} data-testid="task-composer-blocked">
                  <div>
                    <p data-testid="task-composer-mode" className="text-[11px] uppercase tracking-[0.26em] text-violet-200/70">{composerModel.actionLane}</p>
                    <p className="mt-1 text-sm font-medium text-text-primary">{composerModel.title}</p>
                    <p className="mt-1 text-sm leading-6 text-text-secondary">{composerModel.description}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Provider: {composerProviderLabel}</span>
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">Destination: {composerDestinationLabel}</span>
                      <span className="rounded-md border border-border-subtle bg-black/20 px-2 py-1">{composerTruthLabel}</span>
                    </div>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    {autoOpenContext && !effectiveDetailsOpen ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => {
                        setDismissedAutoOpenTaskId(null);
                        setDetailsOpen(true);
                      }}>
                        Open context
                      </Button>
                    ) : null}
                    <Button
                      data-testid={composerModel.buttonTestId}
                      className={`w-full sm:w-auto ${getComposerButtonClass(composerModel.buttonTone)}`}
                      disabled={!selectedTaskId || busyAction !== null || composerModel.disabled}
                      onClick={() => void triggerComposerPrimaryAction()}
                    >
                      {renderComposerButtonIcon(composerModel.buttonIcon)}
                      {busyAction === composerModel.submitKind
                        ? `${composerModel.buttonLabel}...`
                        : composerModel.buttonLabel}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            </div>
          </div>
        </section>

        {contextRailPresence.mounted ? (
        <aside
          className={`motion-fade fixed inset-x-4 bottom-4 top-24 z-30 flex w-auto min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface/95 shadow-2xl transition-[opacity,transform] duration-normal ease-[var(--ease-out)] lg:static lg:inset-auto lg:z-auto lg:h-full lg:min-h-0 lg:w-[21rem] lg:rounded-none lg:border-y-0 lg:border-r-0 lg:border-l lg:shadow-none xl:w-[22rem] ${
            contextRailPresence.state === 'open'
              ? 'motion-rail-open opacity-100 translate-x-0'
              : 'motion-rail-closed pointer-events-none opacity-0 translate-x-4 lg:translate-x-2'
          }`}
          data-testid="task-inspector"
        >
          <div data-testid="task-truth-inspector" className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex items-start justify-between px-4 py-4 flex-shrink-0">
              {effectiveDetailsOpen && (
                <div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="border-b border-violet-300 pb-1 font-semibold text-text-primary">Task truth</span>
                    <span className="pb-1 text-text-muted">Events</span>
                  </div>
                  <h3 className="mt-2 text-base font-semibold text-text-primary">Evidence inspector</h3>
                </div>
              )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-[6.5rem] justify-center"
                  aria-expanded={effectiveDetailsOpen}
                  title={detailsToggleLabel}
                  onClick={toggleContextPanel}
                >
                  {detailsToggleLabel}
                </Button>
            </div>
          {effectiveDetailsOpen && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto scrollbar-thin px-4 pb-4" data-testid="task-inspector-scroll">
              {activeInspectorSnapshot?.importantCards.length ? activeInspectorSnapshot.importantCards.map((card) => (
                <Card key={`${card.label}-${card.title}`} className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">{card.label}</p>
                    <p className="text-sm font-medium text-text-primary">{card.title}</p>
                    <p className="text-text-secondary">{card.detail}</p>
                  </CardContent>
                </Card>
              )) : inspectorLoading ? (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Context</p>
                    <p className="text-sm font-medium text-text-primary">Loading task context</p>
                    <p className="text-text-secondary">Keeping the inspector stable while the latest task truth loads.</p>
                  </CardContent>
                </Card>
              ) : (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Context</p>
                    <p className="text-sm font-medium text-text-primary">No urgent blockers</p>
                    <p className="text-text-secondary">
                      {workspaceGuidance?.body ?? 'Use Show details when you want the full task truth without inflating the main timeline.'}
                    </p>
                  </CardContent>
                </Card>
              )}
              <div className="space-y-3" data-testid="task-truth-summary-cards">
                <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text-primary">Confidence & acceptance</p>
                    <span className="text-sm font-semibold text-success">{confidenceScore}%</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                    <div
                      className={`h-full rounded-full ${
                        credibilitySummary.gaps.length === 0 ? 'bg-success' : 'bg-warning'
                      }`}
                      style={{ width: `${confidenceScore}%` }}
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-text-muted">Acceptance</p>
                      <p className="mt-1 font-medium text-text-primary">{acceptanceVerdict}</p>
                    </div>
                    <div>
                      <p className="text-text-muted">Quality</p>
                      <p className="mt-1 font-medium text-text-primary">{qualityVerdict}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text-primary">Failure plane</p>
                    <span className={issuePlaneLabel === 'none' ? 'text-sm font-semibold text-success' : 'text-sm font-semibold text-warning'}>
                      {issuePlaneLabel}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{issueSummaryLabel}</p>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text-primary">Provider readiness</p>
                    <span className="text-sm font-semibold text-success">{composerProviderLabel === 'No provider selected' ? 'not selected' : 'ready'}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-text-secondary">{composerProviderLabel}</p>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text-primary">Artifact state</p>
                    <span className={artifactPathStateLabel === 'unresolved' ? 'text-sm font-semibold text-warning' : 'text-sm font-semibold text-success'}>
                      {artifactPathStateLabel}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-text-muted">Created</p>
                      <p className="mt-1 font-medium text-text-primary">{createdArtifactCount}</p>
                    </div>
                    <div>
                      <p className="text-text-muted">Delivered</p>
                      <p className="mt-1 font-medium text-text-primary">{deliveredArtifactCount}</p>
                    </div>
                    <div>
                      <p className="text-text-muted">Destination</p>
                      <p className="mt-1 truncate font-medium text-text-primary">{composerDestinationLabel}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-violet-300/35 bg-violet-950/18 px-3 py-3 shadow-[0_0_0_1px_rgba(139,92,246,0.10)]">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-violet-100">Suggested action</p>
                    <Badge variant={credibilitySummary.gaps.length ? 'warning' : 'success'}>
                      {credibilitySummary.gaps.length ? `${credibilitySummary.gaps.length} gap` : 'clear'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm font-medium text-text-primary">{suggestedActionLabel}</p>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">{suggestedActionReason}</p>
                </div>
                {credibilitySummary.gaps.length > 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">Evidence gaps</p>
                      <span className="text-sm font-semibold text-warning">{credibilitySummary.gaps.length}</span>
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {credibilitySummary.gaps.map((gap) => (
                        <p key={gap} className="text-sm leading-5 text-text-secondary">{gap}</p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
                {approvalEntriesForInspector.length ? (
                  <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                    <CardContent className="space-y-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Approvals</p>
                          <p className="mt-1 text-sm text-text-secondary">Review the request summary first, then expand only the approval you want to inspect.</p>
                        </div>
                        <Badge variant="warning">{approvalEntriesForInspector.length} waiting</Badge>
                      </div>
                      <div className="space-y-2">
                        {approvalEntriesForInspector.map((approval) => (
                          <ExpandableRow
                            key={approval.invocationId}
                            testId="task-approval-card"
                            summaryTestId={`task-approval-toggle-${approval.invocationId}`}
                            open={expandedApprovalId === approval.invocationId}
                            onToggle={() => setExpandedApprovalId((current) => (
                              current === approval.invocationId ? null : approval.invocationId
                            ))}
                            summary={(
                              <div className="flex min-w-0 items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-semibold text-text-primary">{approval.toolName}</p>
                                    <Badge variant="warning">pending</Badge>
                                  </div>
                                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">
                                    {approval.argumentsSummary ?? 'No argument summary was projected for this approval.'}
                                  </p>
                                </div>
                                <span className="shrink-0 text-[11px] text-text-muted">{formatTime(approval.requestedAt)}</span>
                              </div>
                            )}
                            details={(
                              <div className="space-y-3">
                                <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Invocation</p>
                                  <p className="mt-2 break-all text-sm text-text-primary">{approval.invocationId}</p>
                                </div>
                                {approval.argumentsSummary ? (
                                  <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
                                    <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Argument summary</p>
                                    <p className="mt-2 text-sm leading-6 text-text-secondary">{approval.argumentsSummary}</p>
                                  </div>
                                ) : null}
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    data-testid="task-approval-approve"
                                    size="sm"
                                    disabled={!task || !approval.availableActions.includes('APPROVED') || busyAction !== null}
                                    onClick={() => void resolveApproval(approval, 'APPROVED')}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    data-testid="task-approval-reject"
                                    size="sm"
                                    variant="secondary"
                                    disabled={!task || !approval.availableActions.includes('REJECTED') || busyAction !== null}
                                    onClick={() => void resolveApproval(approval, 'REJECTED')}
                                  >
                                    Reject
                                  </Button>
                                </div>
                              </div>
                            )}
                          />
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              {artifactContextForInspector ? (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-3 text-sm">
                    <div>
                      <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Artifact path</p>
                      <p className="mt-1 text-text-primary">{artifactContextForInspector.artifactPathState}</p>
                    </div>
                    {artifactContextForInspector.recommendedArtifactDir ? (
                      <div data-testid="task-artifact-recommended">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Recommended destination</p>
                        <p className="mt-1 text-text-secondary">{artifactContextForInspector.recommendedArtifactDir}</p>
                      </div>
                    ) : null}
                    {artifactContextForInspector.selectedArtifactDir ? (
                      <div data-testid="task-artifact-selected">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Selected destination</p>
                        <p className="mt-1 text-text-secondary">{artifactContextForInspector.selectedArtifactDir}</p>
                      </div>
                    ) : null}
                    {artifactContextForInspector.artifactDestinationPaths.length ? (
                      <div data-testid="task-artifact-delivered">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Delivered to</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {artifactContextForInspector.artifactDestinationPaths.map((artifactPath) => (
                            <span key={artifactPath} className="rounded-md border border-border-default bg-surface px-2.5 py-1 text-xs text-text-primary">
                              {artifactPath}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {artifactContextForInspector.artifactPathState !== 'applied' ? (
                      <>
                        {task && artifactContextForInspector.canChoosePath && recommendedArtifactDir ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              data-testid="task-context-use-recommended-path"
                              size="sm"
                              disabled={!selectedTaskId || busyAction !== null}
                              onClick={() => void useRecommendedArtifactPath()}
                            >
                              Use recommended path
                            </Button>
                            <Button
                              data-testid="task-context-choose-custom-path"
                              size="sm"
                              variant="secondary"
                              disabled={!selectedTaskId || busyAction !== null}
                              onClick={openCustomArtifactPath}
                            >
                              Choose custom path
                            </Button>
                          </div>
                        ) : null}
                        {shouldShowCustomArtifactInput ? (
                          <>
                            <input
                              data-testid="task-artifact-dir"
                              value={artifactDir}
                              onChange={(event) => setArtifactDir(event.target.value)}
                              placeholder={debug?.executionSummary.recommendedArtifactDir ?? 'project-relative destination'}
                              className="w-full rounded-xl border border-border-default bg-surface px-3 py-2 text-sm text-text-primary outline-none transition duration-fast focus:border-accent focus:ring-1 focus:ring-accent/30"
                            />
                            <Button
                              data-testid="task-action-apply-artifacts"
                              size="sm"
                              disabled={!selectedTaskId || busyAction !== null || !artifactDir.trim()}
                              onClick={() => void applyCustomArtifactPath()}
                            >
                              Apply custom path
                            </Button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
              <div>
                <details className="rounded-lg border border-border-subtle bg-surface-elevated/58" data-testid="task-advanced-summary">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">Inspector details</summary>
                  <div className="px-4 pb-3 pt-1">
                    <div className="mb-3 flex flex-wrap gap-1.5 border-b border-border-subtle pb-2">
                      {(['summary', 'acceptance', 'quality', 'experience', 'approvals', 'diagnostics', 'artifacts', 'events', 'raw'] as DetailTab[]).map((tab) => <button key={tab} type="button" data-testid={`task-tab-${tab}`} onClick={() => setActiveTab(tab)} className={`rounded-md px-2.5 py-1.5 text-xs transition duration-fast ${activeTab === tab ? 'bg-surface-hover text-text-primary ring-1 ring-border-default' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}>{tab}</button>)}
                    </div>
                    <TaskDetailTabPanel
                      activeTab={activeTab}
                      task={task}
                      debug={debug}
                      events={events}
                      pendingApprovalEntries={pendingApprovalEntries}
                    />
                  </div>
                </details>
              </div>
            </div>
          )}
          </div>
        </aside>
        ) : null}
      </main>

      <ConfirmDialog
        open={taskDeleteRequested && Boolean(task?.canDelete && selectedTaskId)}
        title={task ? `Delete thread "${task.definition.title}" permanently?` : 'Delete thread permanently?'}
        description="Deleting removes the thread from the workspace. This action cannot be undone."
        details={[
          'Only terminal tasks can be deleted.',
          'Artifacts already delivered remain on disk, but the thread record and workspace state are removed.',
        ]}
        confirmLabel="Delete permanently"
        cancelLabel="Keep thread"
        tone="danger"
        busy={busyAction === 'delete'}
        testId="task-delete-dialog"
        confirmTestId="task-delete-confirm"
        cancelTestId="task-delete-cancel"
        onCancel={() => setTaskDeleteRequested(false)}
        onConfirm={() => void deleteSelectedTask()}
      />

      <div data-testid="task-global-footer" className="hidden border-t border-border-subtle bg-background/92 backdrop-blur-md lg:fixed lg:inset-x-0 lg:bottom-0 lg:z-50 lg:flex lg:h-10 lg:items-center lg:justify-between">
        <div className="flex h-full w-72 items-center gap-3 border-r border-border-subtle px-3 xl:w-[19rem]">
          <span className="text-xs text-text-secondary">Workspace</span>
          <span className="rounded-md border border-border-default bg-black/20 px-2.5 py-1 text-xs text-text-primary">scc-batch</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs text-text-muted">
          <span className="truncate">D:\MyCode\myApp_\Scc_batch_web</span>
          <span className="status-dot text-success" />
        </div>
        <div className="flex h-full items-center gap-2 border-l border-border-subtle px-3">
          <span className="rounded-md border border-border-default bg-surface-elevated px-2.5 py-1 text-xs text-text-primary">Backend healthy</span>
          <span className="rounded-md border border-warning/30 bg-warning-muted/15 px-2.5 py-1 text-xs text-warning">Provider gated</span>
          <span className="rounded-md border border-success/25 bg-success-muted/15 px-2.5 py-1 text-xs text-success">WS live</span>
        </div>
      </div>

      {composerPresence.mounted ? (
        <TaskComposer
          state={composerPresence.state}
          onClose={() => setComposerOpen(false)}
          onCreated={(taskId) => {
            setComposerOpen(false);
            selectTask(taskId);
            void Promise.allSettled([
              reloadTasks(),
              api.getTaskDebug(taskId).then((value) => commitDebugSnapshot(taskId, value)),
            ]);
          }}
        />
      ) : null}
    </div>
  );
}

function TaskComposer({
  state,
  onClose,
  onCreated,
}: {
  state: 'open' | 'closed';
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [taskFamily, setTaskFamily] = useState<TaskFamilyId>('analyze');
  const [providerId, setProviderId] = useState('');
  const [qualityProfileId, setQualityProfileId] = useState<'' | QualityProfileId>('');
  const [pathPolicy, setPathPolicy] = useState<TaskPathPolicy>('task_workspace');
  const [outputDir, setOutputDir] = useState('');
  const [unitsText, setUnitsText] = useState(JSON.stringify(DEFAULT_UNITS, null, 2));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      setError(null);
      const preflight = validateComposerInput({
        title,
        intent,
        providerId,
        unitsText,
        pathPolicy,
        outputDir,
      });
      if (preflight.errors.length > 0 || !preflight.units) {
        setError(preflight.errors.join('\n'));
        return;
      }
      const response = await api.submitTask({
        title,
        intent,
        units: preflight.units,
        defaultQualityProfileId: qualityProfileId || undefined,
        preferredProviderId: providerId || null,
        pathPolicy,
        preferredArtifactDir: outputDir || null
      });
      onCreated(response.command.taskId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to create task.');
    }
  }

  const selectedFamily = TASK_FAMILY_OPTIONS.find((option) => option.value === taskFamily) ?? TASK_FAMILY_OPTIONS[0];
  const errorMessages = error?.split('\n').filter(Boolean) ?? [];

  function handleTaskFamilyChange(value: TaskFamilyId) {
    setTaskFamily(value);
    setUnitsText(formatUnitsTemplate(value));
  }

  return (
    <div className={`motion-fade fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 ${state === 'open' ? 'motion-overlay-open bg-black/70 backdrop-blur-sm' : 'motion-overlay-closed bg-black/0 backdrop-blur-none'}`}>
      <form
        onSubmit={handleSubmit}
        className={`motion-fade grid max-h-[92vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-2xl ${state === 'open' ? 'motion-modal-open' : 'motion-modal-closed'}`}
        data-testid="task-composer-dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-text-muted">New thread</p>
            <h2 className="mt-1.5 text-xl font-semibold text-text-primary">Create a task</h2>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-5 scrollbar-thin">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <div className="space-y-4">
              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Title</span>
                <input
                  data-testid="task-composer-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short task name"
                  className={TASK_COMPOSER_FIELD_CLASS}
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Task type</span>
                  <select
                    data-testid="task-composer-task-type"
                    value={taskFamily}
                    onChange={(event) => handleTaskFamilyChange(event.target.value as TaskFamilyId)}
                    className={TASK_COMPOSER_FIELD_CLASS}
                  >
                  {TASK_FAMILY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="block text-xs text-text-muted">{selectedFamily.description}</span>
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Goal</span>
                <textarea
                  data-testid="task-composer-intent"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="Describe what should be done. Add paths or constraints when they matter."
                  className={`${TASK_COMPOSER_FIELD_CLASS} min-h-[160px] resize-none leading-6`}
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-text-secondary">Work path</span>
                  <select
                    data-testid="task-composer-path-policy"
                    value={pathPolicy}
                    onChange={(event) => setPathPolicy(event.target.value as TaskPathPolicy)}
                    className={TASK_COMPOSER_FIELD_CLASS}
                  >
                    <option value="task_workspace">Use task workspace</option>
                    <option value="ask_if_unclear">Ask if path is unclear</option>
                    <option value="project_relative">Project-relative path</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="text-text-secondary">Output directory</span>
                  <input
                    data-testid="task-composer-output-dir"
                    value={outputDir}
                    onChange={(event) => setOutputDir(event.target.value)}
                    placeholder="Optional path"
                    className={TASK_COMPOSER_FIELD_CLASS}
                  />
                </label>
              </div>
            </div>

            <aside className="space-y-3 rounded-lg border border-border-subtle bg-surface-elevated/35 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-text-muted">Run settings</p>
              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Provider / model</span>
                <input
                  data-testid="task-composer-provider"
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  placeholder="Default routing"
                  className={TASK_COMPOSER_FIELD_CLASS}
                />
              </label>
              <details
                className="rounded-lg border border-border-subtle bg-black/10"
                open={advancedOpen}
                onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
              >
                <summary className="cursor-pointer px-3 py-2.5 text-sm text-text-primary">Advanced contract</summary>
                <div className="space-y-3 px-3 pb-3">
                  <label className="space-y-2 text-sm">
                    <span className="text-text-secondary">Quality contract id</span>
                    <input
                      data-testid="task-composer-quality-profile"
                      value={qualityProfileId}
                      onChange={(event) => setQualityProfileId(event.target.value as '' | QualityProfileId)}
                      placeholder="Optional generic contract id"
                      className={TASK_COMPOSER_FIELD_CLASS}
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-text-secondary">Units JSON</span>
                    <textarea
                      data-testid="task-composer-units"
                      value={unitsText}
                      onChange={(event) => setUnitsText(event.target.value)}
                      className={`${TASK_COMPOSER_FIELD_CLASS} min-h-[220px] resize-none font-mono text-xs leading-5`}
                    />
                  </label>
                </div>
              </details>
              <p className="text-xs leading-5 text-text-muted">
                Specialized scenario quality gates are available to harness packs and CLI submits; the default user path stays generic.
              </p>
            </aside>
          </div>
        </div>

        {errorMessages.length ? (
          <div className="border-t border-border-subtle px-5 pt-3 text-sm text-error" data-testid="task-composer-preflight">
            <p className="font-medium">Fix these before creating the task:</p>
            <ul className="mt-2 space-y-1">
              {errorMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            {errorMessages.some((message) => /provider|Connections/i.test(message)) ? (
              <a className="mt-2 inline-flex text-xs text-accent hover:underline" href="/settings/connections">
                Open Connections
              </a>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-border-subtle px-5 py-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button data-testid="task-composer-submit" type="submit">Create task</Button>
        </div>
      </form>
    </div>
  );
}
