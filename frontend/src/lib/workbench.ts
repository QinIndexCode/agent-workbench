import type { BadgeVariant } from '../components/ui/badge';
import type { PlatformOverviewData } from '../hooks/usePlatformOverview';
import type { TaskSummary } from '../types';

export interface SummaryStripItem {
  label: string;
  value: string | number;
  note: string;
  variant?: BadgeVariant;
  testId?: string;
}

export interface ThreadPreview {
  taskId: string;
  href: string;
  title: string;
  preview: string;
  lifecycleLabel: string;
  lifecycleVariant: BadgeVariant;
  updatedLabel: string;
  meta: string[];
  attention: string | null;
}

export interface TaskWorkspaceCollections {
  total: number;
  completionRate: number;
  attention: ThreadPreview[];
  recent: ThreadPreview[];
  running: ThreadPreview[];
  queued: ThreadPreview[];
  waiting: ThreadPreview[];
  recovery: ThreadPreview[];
  completed: ThreadPreview[];
}

export interface PlatformReadinessItem {
  key: string;
  label: string;
  count: number;
  statusLabel: string;
  variant: BadgeVariant;
  detail: string;
}

export interface PlatformReadinessModel {
  summaryItems: SummaryStripItem[];
  readinessItems: PlatformReadinessItem[];
  providers: number;
  skills: number;
  mcpServers: number;
  workflowAssets: number;
  warnings: number;
  configIssues: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function countNested(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return 0;
}

export function formatRelativeTime(value: number | null | undefined) {
  if (!value) {
    return 'just now';
  }

  const diffMs = Date.now() - value;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

export function buildThreadHref(taskId: string) {
  return `/tasks?task=${encodeURIComponent(taskId)}`;
}

export function summarizeTaskAttention(task: TaskSummary): string | null {
  if (task.pendingApprovalCount > 0) {
    return `${task.pendingApprovalCount} approval${task.pendingApprovalCount === 1 ? '' : 's'} waiting`;
  }
  if (task.lastError) {
    return task.lastError;
  }
  if (task.lifecycleStatus === 'PAUSED') {
    return 'Paused and waiting for an operator decision.';
  }
  if (task.lifecycleStatus === 'FAILED') {
    return 'Failed and needs recovery.';
  }
  if (task.queueState && task.lifecycleStatus !== 'COMPLETED') {
    return `Queue ${task.queueState.toLowerCase()}`;
  }
  return null;
}

function lifecycleVariant(status: TaskSummary['lifecycleStatus']): BadgeVariant {
  switch (status) {
    case 'RUNNING':
      return 'success';
    case 'PAUSED':
      return 'warning';
    case 'FAILED':
      return 'error';
    case 'SUBMITTED':
      return 'info';
    default:
      return 'default';
  }
}

export function buildThreadPreview(task: TaskSummary): ThreadPreview {
  const meta = [];
  if (task.queueState) {
    meta.push(`Queue ${task.queueState.toLowerCase()}`);
  }
  if (task.pendingApprovalCount > 0) {
    meta.push(`${task.pendingApprovalCount} approval${task.pendingApprovalCount === 1 ? '' : 's'}`);
  }

  return {
    taskId: task.taskId,
    href: buildThreadHref(task.taskId),
    title: task.title,
    preview: task.intent,
    lifecycleLabel: task.lifecycleStatus,
    lifecycleVariant: lifecycleVariant(task.lifecycleStatus),
    updatedLabel: formatRelativeTime(task.updatedAt),
    meta,
    attention: summarizeTaskAttention(task),
  };
}

export function buildTaskWorkspaceCollections(tasks: TaskSummary[]): TaskWorkspaceCollections {
  const sorted = [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
  const attentionSource = tasks.filter((task) =>
    task.pendingApprovalCount > 0
    || Boolean(task.lastError)
    || task.lifecycleStatus === 'FAILED'
    || task.lifecycleStatus === 'PAUSED',
  );
  const running = tasks.filter((task) => task.lifecycleStatus === 'RUNNING');
  const queued = tasks.filter((task) => task.queueState && task.queueState !== 'COMPLETED');
  const waiting = tasks.filter((task) => task.lifecycleStatus === 'PAUSED' || task.pendingApprovalCount > 0);
  const recovery = tasks.filter((task) => task.lifecycleStatus === 'FAILED' || Boolean(task.lastError));
  const completed = tasks
    .filter((task) => task.lifecycleStatus === 'COMPLETED')
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const completionRate = tasks.length > 0
    ? Math.round((completed.length / tasks.length) * 100)
    : 0;

  return {
    total: tasks.length,
    completionRate,
    attention: attentionSource
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 6)
      .map(buildThreadPreview),
    recent: sorted.slice(0, 6).map(buildThreadPreview),
    running: running.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 6).map(buildThreadPreview),
    queued: queued.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 8).map(buildThreadPreview),
    waiting: waiting.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 8).map(buildThreadPreview),
    recovery: recovery.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 8).map(buildThreadPreview),
    completed: completed.slice(0, 6).map(buildThreadPreview),
  };
}

export function buildTaskOverviewSummary(collections: TaskWorkspaceCollections): SummaryStripItem[] {
  return [
    {
      label: 'Threads',
      value: collections.total,
      note: 'All active and recent threads.',
      variant: 'outline',
    },
    {
      label: 'Running',
      value: collections.running.length,
      note: 'Threads moving without a blocker.',
      variant: collections.running.length > 0 ? 'success' : 'outline',
    },
    {
      label: 'Attention',
      value: collections.attention.length,
      note: 'Approvals, pauses, failures, or drift.',
      variant: collections.attention.length > 0 ? 'warning' : 'success',
    },
    {
      label: 'Completed',
      value: `${collections.completed.length} / ${collections.completionRate}%`,
      note: 'Recently finished threads and completion rate.',
      variant: collections.completed.length > 0 ? 'default' : 'outline',
    },
  ];
}

export function buildQueueSummary(collections: TaskWorkspaceCollections): SummaryStripItem[] {
  return [
    {
      label: 'Recovery',
      value: collections.recovery.length,
      note: 'Failures or last-error signals.',
      variant: collections.recovery.length > 0 ? 'error' : 'success',
      testId: 'queue-recovery-summary',
    },
    {
      label: 'Waiting',
      value: collections.waiting.length,
      note: 'Paused or approval-bound work.',
      variant: collections.waiting.length > 0 ? 'warning' : 'outline',
    },
    {
      label: 'In flight',
      value: collections.running.length,
      note: 'Threads still executing.',
      variant: collections.running.length > 0 ? 'success' : 'outline',
    },
    {
      label: 'Backlog',
      value: collections.queued.length,
      note: 'Queued threads or active leases.',
      variant: collections.queued.length > 0 ? 'info' : 'outline',
    },
  ];
}

export function buildPlatformReadinessModel(data: PlatformOverviewData | null): PlatformReadinessModel {
  const workflow = asRecord(data?.workflow);
  const configHealth = asRecord(data?.configHealth);
  const capabilities = asRecord(data?.capabilities);

  const providers = data?.providers.length ?? 0;
  const skills = data?.skills.length ?? 0;
  const mcpServers = data?.mcpServers.length ?? 0;
  const workflowRules = countNested(workflow, ['rules']);
  const workflowCommands = countNested(workflow, ['commands', 'workspaceCommands']);
  const workflowDocs = countNested(workflow, ['importedDocs', 'docs']);
  const workflowAgents = countNested(workflow, ['agents', 'workspaceAgents']);
  const warnings = countNested(capabilities, ['warnings', 'capabilityWarnings']);
  const configIssues = countNested(configHealth, ['issues', 'warnings']);
  const workflowAssets = workflowRules + workflowCommands + workflowDocs + workflowAgents;

  const readinessItems: PlatformReadinessItem[] = [
    {
      key: 'providers',
      label: 'Providers',
      count: providers,
      statusLabel: providers > 0 ? 'ready' : 'missing',
      variant: providers > 0 ? 'success' : 'warning',
      detail: providers > 0
        ? 'Connection profiles are available to the runtime.'
        : 'No provider profile is visible yet.',
    },
    {
      key: 'skills',
      label: 'Skills',
      count: skills,
      statusLabel: skills > 0 ? 'ready' : 'quiet',
      variant: skills > 0 ? 'success' : 'outline',
      detail: skills > 0
        ? 'Runtime skills are available for import-aware flows.'
        : 'No skill runtime entries are currently exposed.',
    },
    {
      key: 'mcp',
      label: 'MCP',
      count: mcpServers,
      statusLabel: mcpServers > 0 ? 'ready' : 'quiet',
      variant: mcpServers > 0 ? 'success' : 'outline',
      detail: mcpServers > 0
        ? 'MCP servers are available to the workspace.'
        : 'No MCP servers are currently configured.',
    },
    {
      key: 'workflow',
      label: 'Workflow',
      count: workflowAssets,
      statusLabel: workflowAssets > 0 ? 'loaded' : 'quiet',
      variant: workflowAssets > 0 ? 'info' : 'outline',
      detail: workflowAssets > 0
        ? `${workflowRules} rules, ${workflowCommands} commands, ${workflowDocs} docs, ${workflowAgents} agents.`
        : 'No workspace workflow assets are currently surfaced.',
    },
    {
      key: 'config',
      label: 'Config health',
      count: warnings + configIssues,
      statusLabel: warnings + configIssues > 0 ? 'attention' : 'stable',
      variant: warnings + configIssues > 0 ? 'warning' : 'success',
      detail: warnings + configIssues > 0
        ? 'Capability or configuration warnings still need review.'
        : 'No capability or config warnings are exposed right now.',
    },
  ];

  return {
    summaryItems: [
      {
        label: 'Providers',
        value: providers,
        note: 'Configured connections.',
        variant: providers > 0 ? 'success' : 'warning',
      },
      {
        label: 'Skills',
        value: skills,
        note: 'Runtime skill entries.',
        variant: skills > 0 ? 'success' : 'outline',
      },
      {
        label: 'MCP',
        value: mcpServers,
        note: 'Connected MCP servers.',
        variant: mcpServers > 0 ? 'success' : 'outline',
      },
      {
        label: 'Workflow',
        value: workflowAssets,
        note: 'Rules, commands, docs, and agents.',
        variant: workflowAssets > 0 ? 'info' : 'outline',
      },
      {
        label: 'Warnings',
        value: warnings + configIssues,
        note: 'Items worth checking.',
        variant: warnings + configIssues > 0 ? 'warning' : 'success',
      },
    ],
    readinessItems,
    providers,
    skills,
    mcpServers,
    workflowAssets,
    warnings,
    configIssues,
  };
}
