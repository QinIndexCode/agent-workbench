import blessed from 'blessed';
import { CliChatSessionController } from '../session/session-controller';
import { CliRecentTaskItem, WorkspaceChatEnvelope } from '../protocol/chat-envelopes';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatKeyValueBlock(record: Record<string, unknown> | null, fallback: string): string {
  if (!record) return fallback;
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getStringArray(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function summarizeApprovalArguments(record: Record<string, unknown> | null): string | null {
  const raw = record?.arguments;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw)
    .filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) {
    return null;
  }
  const compact = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' | ');
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function formatSummary(record: Record<string, unknown> | null): string {
  if (!record) {
    return 'No active task.\n\nNext action: Enter a prompt or use /switch <taskId>.';
  }
  const title = typeof record.title === 'string' ? record.title : 'Untitled task';
  const taskId = typeof record.taskId === 'string' ? record.taskId : 'unknown';
  const statusSummary = record.statusSummary && typeof record.statusSummary === 'object'
    ? record.statusSummary as Record<string, unknown>
    : null;
  const stageLabel = typeof record.stageLabel === 'string' ? record.stageLabel : 'Stage not started';
  const currentUnitId = typeof record.currentUnitId === 'string' ? record.currentUnitId : '-';
  const blockingReason = typeof statusSummary?.detail === 'string'
    ? statusSummary.detail
    : 'Task query is missing statusSummary.';
  const primaryAction = record.primaryAction && typeof record.primaryAction === 'object'
    ? record.primaryAction as Record<string, unknown>
    : null;
  const nextAction = record.nextActionSummary && typeof record.nextActionSummary === 'object'
    ? record.nextActionSummary as Record<string, unknown>
    : null;
  const completionSummary = record.completionSummary && typeof record.completionSummary === 'object'
    ? record.completionSummary as Record<string, unknown>
    : null;
  const toolActivities = Array.isArray(record.visibleToolActivities)
    ? record.visibleToolActivities.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const pendingApprovals = Array.isArray(record.pendingApprovals)
    ? record.pendingApprovals.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const approvalActions = record.approvalActions && typeof record.approvalActions === 'object'
    ? record.approvalActions as Record<string, unknown>
    : null;
  const isSafeRecentResult = (value: string): boolean => {
    const text = value.trim();
    return Boolean(text)
      && !text.includes('[/')
      && !/\[(?:[A-Z0-9_-]+)_OUTPUT\]/.test(text)
      && !/"tool(?:_name)?"\s*:/.test(text)
      && !/"current_unit"\s*:/.test(text)
      && !/"arguments"\s*:/.test(text);
  };
  const lines = [
    'Task truth',
    `${title}`,
    `taskId: ${taskId}`,
    `status: ${typeof statusSummary?.label === 'string' ? statusSummary.label : 'Task truth unavailable'}`,
    `stage: ${stageLabel}`,
    `unit: ${currentUnitId}`,
    '',
    `Suggested action: ${typeof primaryAction?.label === 'string' ? primaryAction.label : typeof nextAction?.label === 'string' ? nextAction.label : 'Task truth unavailable'}`,
    `Why: ${blockingReason}`,
    `Next action detail: ${typeof primaryAction?.description === 'string' ? primaryAction.description : typeof nextAction?.reason === 'string' ? nextAction.reason : 'Task query is missing nextActionSummary.'}`,
    `Primary action: ${typeof primaryAction?.label === 'string' ? primaryAction.label : typeof nextAction?.label === 'string' ? nextAction.label : 'Task truth unavailable'}`,
    '',
    `Artifact state: ${String(record.artifactPathState ?? 'sandbox_only')}`
  ];
  if (typeof completionSummary?.summary === 'string' && isSafeRecentResult(completionSummary.summary)) {
    lines.push(`Recent result: ${completionSummary.summary}`);
  }
  if (Array.isArray(completionSummary?.artifactDestinationPaths) && completionSummary.artifactDestinationPaths.length > 0) {
    lines.push(`Delivered to: ${completionSummary.artifactDestinationPaths.join(', ')}`);
  } else if (typeof completionSummary?.artifactDestinationDir === 'string' && completionSummary.artifactDestinationDir.trim()) {
    lines.push(`Destination folder: ${completionSummary.artifactDestinationDir}`);
  }
  if (toolActivities.length > 0) {
    lines.push('');
    for (const activity of toolActivities.slice(-2)) {
      lines.push(`tool: ${String(activity.toolId ?? 'tool')} [${String(activity.status ?? 'unknown')}] ${String(activity.summary ?? '')}`);
    }
  }
  if (pendingApprovals.length > 0) {
    const firstApproval = pendingApprovals[0];
    const toolName = getString(firstApproval, 'toolName') ?? getString(firstApproval, 'toolId') ?? 'tool';
    const invocationId = getString(firstApproval, 'invocationId') ?? 'unknown';
    lines.push('');
    lines.push(`Approval required: ${toolName} (${invocationId})`);
    const argsSummary = summarizeApprovalArguments(firstApproval);
    if (argsSummary) {
      lines.push(`Scope: ${argsSummary}`);
    }
    lines.push(`How to resolve: press 4 for approvals, then use a=approve or r=reject`);
    const guidance = getString(approvalActions, 'guidance');
    if (guidance) {
      lines.push(`Approval guidance: ${guidance}`);
    }
  }
  return lines.join('\n');
}

function formatTaskList(items: CliRecentTaskItem[], activeTaskId: string | null): string {
  if (items.length === 0) {
    return 'No tasks loaded yet.';
  }
  return items.map((task, index) => {
    const marker = task.taskId === activeTaskId ? '*' : task.isRecent ? '+' : ' ';
    return `${marker} ${index + 1}. ${task.taskId}\n  ${task.title}\n  status=${task.lifecycleStatus} unit=${task.currentUnitId ?? '-'} approvals=${task.pendingApprovalCount}`;
  }).join('\n\n');
}

function formatApprovals(snapshot: ReturnType<CliChatSessionController['getInspectorSnapshot']>): string {
  if (snapshot.approvals.length === 0) {
    return 'No pending approvals.';
  }
  return snapshot.approvals.map((approval, index) => {
    const marker = index === snapshot.selectedApprovalIndex ? '>' : ' ';
    const invocationId = typeof approval.invocationId === 'string' ? approval.invocationId : 'unknown';
    const toolId = typeof approval.toolId === 'string' ? approval.toolId : 'unknown';
    const toolName = typeof approval.toolName === 'string' ? approval.toolName : toolId;
    const unitId = typeof approval.unitId === 'string' ? approval.unitId : '-';
    const status = typeof approval.status === 'string' ? approval.status : '-';
    const createdAt = typeof approval.createdAt === 'number' ? new Date(approval.createdAt).toLocaleString() : '-';
    const argsSummary = summarizeApprovalArguments(approval);
    return `${marker} ${toolName} (${invocationId})\n  tool=${toolId} unit=${unitId} status=${status}\n  createdAt=${createdAt}${argsSummary ? `\n  scope=${argsSummary}` : ''}\n  keys: a=approve | r=reject`;
  }).join('\n\n');
}

function formatEvents(controller: CliChatSessionController): string {
  if (controller.state.recentEvents.length === 0) {
    return 'No recent events.';
  }
  return controller.state.recentEvents.slice(-20).map((event) => {
    const payload = event.payload ?? {};
    const stageIndex = typeof payload.stageIndex === 'number' ? ` stage=${payload.stageIndex}` : '';
    const message = typeof payload.message === 'string' ? ` ${payload.message}` : '';
    return `${event.type}${stageIndex}\n  eventId=${event.eventId}${message}`;
  }).join('\n\n');
}

function formatDiagnostics(snapshot: ReturnType<CliChatSessionController['getInspectorSnapshot']>): string {
  if (!snapshot.diagnostics) {
    return 'No diagnostics yet.';
  }
  const diagnostics = snapshot.diagnostics;
  const summary = diagnostics.summary && typeof diagnostics.summary === 'object'
    ? diagnostics.summary as Record<string, unknown>
    : null;
  const planner = diagnostics.planner && typeof diagnostics.planner === 'object' ? diagnostics.planner as Record<string, unknown> : null;
  const attribution = diagnostics.promptSectionAttribution && typeof diagnostics.promptSectionAttribution === 'object'
    ? diagnostics.promptSectionAttribution as Record<string, unknown>
    : null;
  const acceptance = diagnostics.acceptance && typeof diagnostics.acceptance === 'object'
    ? diagnostics.acceptance as Record<string, unknown>
    : null;
  const deterministic = acceptance?.deterministic && typeof acceptance.deterministic === 'object'
    ? acceptance.deterministic as Record<string, unknown>
    : null;
  const semanticReview = acceptance?.semanticReview && typeof acceptance.semanticReview === 'object'
    ? acceptance.semanticReview as Record<string, unknown>
    : null;
  const quality = acceptance?.quality && typeof acceptance.quality === 'object'
    ? acceptance.quality as Record<string, unknown>
    : null;
  const lines: string[] = [];
  lines.push('Task truth');
  lines.push(`taskId: ${String(diagnostics.taskId ?? '-')}`);
  lines.push(`lifecycleStatus: ${String(diagnostics.lifecycleStatus ?? '-')}`);
  lines.push(`failurePlane: ${String(diagnostics.issuePlane ?? 'none')} / ${String(diagnostics.issueCategory ?? 'none')}`);
  if (summary) {
    lines.push(`problem: ${String(summary.blockingReason ?? '-')}`);
    lines.push('');
    lines.push('Suggested action');
    lines.push(`${String(diagnostics.suggestedAction && typeof diagnostics.suggestedAction === 'object' ? (diagnostics.suggestedAction as Record<string, unknown>).label ?? summary.nextAction ?? '-' : summary.nextAction ?? '-')}`);
    lines.push(`reason: ${String(diagnostics.suggestedAction && typeof diagnostics.suggestedAction === 'object' ? (diagnostics.suggestedAction as Record<string, unknown>).reason ?? summary.nextActionReason ?? '-' : summary.nextActionReason ?? '-')}`);
    lines.push('');
  }
  lines.push('Artifact state');
  lines.push(`pathState: ${String(summary?.artifactPathState ?? 'sandbox_only')}`);
  lines.push(`pendingArtifacts: ${String(summary?.pendingArtifactCount ?? 0)}`);
  lines.push('');
  const workingDirectory = diagnostics.workingDirectory && typeof diagnostics.workingDirectory === 'object'
    ? diagnostics.workingDirectory as Record<string, unknown>
    : null;
  lines.push('Working directory');
  lines.push(`selected: ${String(workingDirectory?.workingDirectory ?? 'not selected')}`);
  lines.push(`status: ${String(workingDirectory?.status ?? 'missing')}`);
  if (workingDirectory?.requiresSelection === true) {
    lines.push('action: ask operator before project-local commands');
  }
  lines.push('');
  if (planner) {
    lines.push(`plannerPhase: ${String(planner.executionPhase ?? '-')}`);
    lines.push(`stageCount: ${String(planner.stageCount ?? '-')}`);
    lines.push(`currentStageIndex: ${String(planner.currentStageIndex ?? '-')}`);
    lines.push(`blockingReason: ${String(planner.blockingReason ?? diagnostics.blockingReason ?? '-')}`);
  }
  lines.push(`compressionPolicy: ${String(diagnostics.compressionPolicy ?? '-')}`);
  lines.push(`compressionDowngraded: ${String(diagnostics.compressionDowngraded ?? false)}`);
  lines.push(`plannerFallbackRate: ${String(diagnostics.plannerFallbackRate ?? 0)}`);
  lines.push(`unsafeBatchRejectedCount: ${String(diagnostics.unsafeBatchRejectedCount ?? 0)}`);
  if (deterministic) {
    lines.push(`acceptanceVerdict: ${String(deterministic.verdict ?? '-')}`);
    lines.push(`acceptanceProfile: ${String(deterministic.profileId ?? '-')}`);
  }
  if (quality) {
    lines.push(`qualityVerdict: ${String(quality.verdict ?? '-')}`);
    lines.push(`qualityProfile: ${String(quality.profileId ?? '-')}`);
  }
  if (semanticReview) {
    lines.push(`semanticReview: ${String(semanticReview.status ?? '-')}`);
    lines.push(`semanticConfidence: ${String(semanticReview.confidence ?? '-')}`);
  }
  const executionSummary = diagnostics.executionSummary && typeof diagnostics.executionSummary === 'object'
    ? diagnostics.executionSummary as Record<string, unknown>
    : null;
  const evidenceGaps = Array.isArray(executionSummary?.evidenceGaps)
    ? executionSummary.evidenceGaps.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (evidenceGaps.length > 0) {
    lines.push('');
    lines.push('Evidence gaps');
    for (const gap of evidenceGaps) {
      lines.push(`- ${gap}`);
    }
  }
  if (attribution) {
    lines.push('');
    lines.push('promptSectionAttribution:');
    for (const [key, value] of Object.entries(attribution)) {
      lines.push(`  ${key}: ${String(value)}`);
    }
  }
  const stageMemorySummary = diagnostics.stageMemorySummary && typeof diagnostics.stageMemorySummary === 'object'
    ? diagnostics.stageMemorySummary as Record<string, unknown>
    : null;
  if (stageMemorySummary) {
    lines.push('');
    lines.push('stageMemorySummary:');
    for (const [key, value] of Object.entries(stageMemorySummary)) {
      lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}

function formatCapabilities(snapshot: ReturnType<CliChatSessionController['getInspectorSnapshot']>): string {
  const payload = snapshot.lastViewPayload && typeof snapshot.lastViewPayload === 'object'
    ? snapshot.lastViewPayload as Record<string, unknown>
    : null;
  if (!payload) {
    return 'No capability payload loaded.';
  }
  const capabilityHub = payload.capabilityHub && typeof payload.capabilityHub === 'object'
    ? payload.capabilityHub as Record<string, unknown>
    : null;
  const hubSummary = capabilityHub?.summary && typeof capabilityHub.summary === 'object'
    ? capabilityHub.summary as Record<string, unknown>
    : null;
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const lines: string[] = [];
  lines.push(`taskId: ${String(payload.activeTaskId ?? 'none')}`);
  if (hubSummary) {
    lines.push(`ready=${String(hubSummary.ready ?? 0)} partial=${String(hubSummary.partial ?? 0)} blocked=${String(hubSummary.blocked ?? 0)} total=${String(hubSummary.total ?? 0)}`);
  }
  lines.push(`provider: ${formatKeyValueBlock(payload.providerSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`skills: ${formatKeyValueBlock(payload.skillSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`instructionSkills: ${formatKeyValueBlock(payload.instructionSkillSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`mcp: ${formatKeyValueBlock(payload.mcpSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`permissions: ${formatKeyValueBlock(payload.permissionSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`agent: ${formatKeyValueBlock(payload.agentSummary as Record<string, unknown> | null, 'n/a')}`);
  lines.push(`hooks: ${formatKeyValueBlock(payload.hookSummary as Record<string, unknown> | null, 'n/a')}`);
  if (warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const warning of warnings.slice(0, 6)) {
      const record = warning && typeof warning === 'object' ? warning as Record<string, unknown> : null;
      lines.push(`- ${String(record?.code ?? 'warning')}: ${String(record?.message ?? '')}`);
    }
  }
  return lines.join('\n');
}

function renderInspector(controller: CliChatSessionController): string {
  const snapshot = controller.getInspectorSnapshot();
  const lines: string[] = [];
  lines.push(`View: ${snapshot.viewMode}`);
  lines.push(`Active task: ${controller.state.activeTaskId ?? 'none'}`);
  lines.push(`Recent tasks: ${snapshot.recentTaskIds.length}`);
  lines.push('');

  if (snapshot.viewMode === 'summary') {
    lines.push(formatSummary(snapshot.activeTask));
  } else if (snapshot.viewMode === 'capabilities') {
    lines.push(formatCapabilities(snapshot));
  } else if (snapshot.viewMode === 'diagnostics') {
    lines.push(formatDiagnostics(snapshot));
  } else if (snapshot.viewMode === 'approvals') {
    lines.push(formatApprovals(snapshot));
  } else if (snapshot.viewMode === 'tasks') {
    const payload = snapshot.lastViewPayload && typeof snapshot.lastViewPayload === 'object' ? snapshot.lastViewPayload as { tasks?: CliRecentTaskItem[] } : null;
    lines.push(formatTaskList(payload?.tasks ?? controller.state.recentTasks, controller.state.activeTaskId));
  } else if (snapshot.viewMode === 'events') {
    lines.push(formatEvents(controller));
  } else {
    lines.push(formatJson(snapshot.lastViewPayload ?? {
      activeTask: snapshot.activeTask,
      diagnostics: snapshot.diagnostics,
      approvals: snapshot.approvals
    }));
  }
  return lines.join('\n');
}

function renderStatus(controller: CliChatSessionController, focusedPane: 'transcript' | 'inspector' | 'input'): string {
  const task = controller.state.latestTaskSummary;
  const statusSummary = task && task.statusSummary && typeof task.statusSummary === 'object'
    ? task.statusSummary as Record<string, unknown>
    : null;
  const progress = typeof statusSummary?.label === 'string'
    ? statusSummary.label
    : 'Task truth unavailable';
  const primaryAction = task && task.primaryAction && typeof task.primaryAction === 'object'
    ? task.primaryAction as Record<string, unknown>
    : null;
  const nextActionSummary = task && task.nextActionSummary && typeof task.nextActionSummary === 'object'
    ? task.nextActionSummary as Record<string, unknown>
    : null;
  const nextAction = primaryAction && typeof primaryAction.label === 'string'
    ? primaryAction.label
    : nextActionSummary && typeof nextActionSummary.label === 'string'
      ? nextActionSummary.label
      : 'Task truth unavailable';
  const pendingApprovals = Array.isArray(task?.pendingApprovals)
    ? task.pendingApprovals.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const firstApproval = pendingApprovals[0] ?? null;
  const base = ` task=${controller.state.activeTaskId ?? 'none'} | state=${progress} | next=${nextAction} | view=${controller.state.viewMode} | pane=${focusedPane} | 1=summary 2=capabilities 3=diagnostics 4=approvals 5=events 6=tasks | p=provider m=mcp k=skills g=agent o=permissions z=compact $=cost | tab=switch pane | esc=input | ctrl-r=refresh | q=exit `;
  if (controller.state.viewMode === 'approvals' && focusedPane === 'inspector') {
    return `${base}| [/] select approval | a=approve | r=reject `;
  }
  if (firstApproval) {
    const toolName = getString(firstApproval, 'toolName') ?? getString(firstApproval, 'toolId') ?? 'tool';
    return `${base}| approval=${toolName} | press 4, then a=approve or r=reject `;
  }
  return base;
}

function envelopeToTranscriptLine(envelope: WorkspaceChatEnvelope): string | null {
  switch (envelope.type) {
    case 'session':
      return `[session] ${envelope.message}${envelope.taskId ? ` (${envelope.taskId})` : ''}`;
    case 'info':
      return envelope.message;
    case 'event':
      return `[event] ${envelope.record.type} ${envelope.record.taskId}`;
    case 'task': {
      const statusSummary = envelope.task.statusSummary && typeof envelope.task.statusSummary === 'object'
        ? envelope.task.statusSummary as Record<string, unknown>
        : null;
      const primaryAction = envelope.task.primaryAction && typeof envelope.task.primaryAction === 'object'
        ? envelope.task.primaryAction as Record<string, unknown>
        : null;
      const nextActionSummary = envelope.task.nextActionSummary && typeof envelope.task.nextActionSummary === 'object'
        ? envelope.task.nextActionSummary as Record<string, unknown>
        : null;
      return `[summary] ${String(statusSummary?.label ?? 'Task truth unavailable')} -> ${String(primaryAction?.label ?? nextActionSummary?.label ?? 'Inspect diagnostics')}`;
    }
    case 'diagnostics':
      return `[diagnostics] refreshed for ${envelope.taskId}`;
    case 'approvals':
      if (envelope.count === 0) {
        return '[approvals] none pending';
      }
      if (Array.isArray(envelope.approvals) && envelope.approvals.length > 0) {
        const firstApproval = envelope.approvals[0] as Record<string, unknown>;
        const toolName = getString(firstApproval, 'toolName') ?? getString(firstApproval, 'toolId') ?? 'tool';
        const invocationId = getString(firstApproval, 'invocationId') ?? 'unknown';
        return `[approvals] pending=${envelope.count} ${toolName} (${invocationId})`;
      }
      return `[approvals] pending=${envelope.count}`;
    case 'view':
      return `[view] ${envelope.view}`;
    default:
      return null;
  }
}

export async function runBlessedWorkspaceChatUi(options: {
  controller: CliChatSessionController;
  initialize: () => Promise<void>;
  registerEnvelopeHandler: (handler: (envelope: WorkspaceChatEnvelope) => void) => void;
}): Promise<number> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'backend_new chat'
  });

  const transcript = blessed.log({
    parent: screen,
    label: ' Transcript ',
    top: 0,
    left: 0,
    width: '68%',
    height: '92%-1',
    border: 'line',
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    tags: false
  });

  const inspector = blessed.box({
    parent: screen,
    label: ' Inspector ',
    top: 0,
    left: '68%',
    width: '32%',
    height: '92%-1',
    border: 'line',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    content: ''
  });

  const input = blessed.textbox({
    parent: screen,
    label: ' Input ',
    bottom: 1,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    inputOnFocus: true,
    keys: true
  });

  const status = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: {
      inverse: true
    }
  });

  const panes = [
    { name: 'transcript' as const, node: transcript },
    { name: 'inspector' as const, node: inspector },
    { name: 'input' as const, node: input }
  ];
  let paneIndex = 2;
  let polling = false;
  let exitResolver: ((code: number) => void) | null = null;

  const renderAll = () => {
    inspector.setContent(renderInspector(options.controller));
    status.setContent(renderStatus(options.controller, panes[paneIndex].name));
    screen.render();
  };

  options.registerEnvelopeHandler((envelope) => {
    const line = envelopeToTranscriptLine(envelope);
    if (line) {
      transcript.log(line);
    }
    renderAll();
  });

  const cleanup = (code: number) => {
    if (exitResolver) {
      const resolve = exitResolver;
      exitResolver = null;
      screen.destroy();
      resolve(code);
    }
  };

  screen.key(['C-c', 'q'], () => cleanup(0));
  screen.key(['tab'], () => {
    paneIndex = (paneIndex + 1) % panes.length;
    panes[paneIndex].node.focus();
    renderAll();
  });
  screen.key(['C-r'], async () => {
    if (options.controller.state.activeTaskId) {
      await options.controller.refreshActiveTask();
    }
    renderAll();
  });
  screen.key(['1'], async () => {
    await options.controller.setViewMode('summary');
    renderAll();
  });
  screen.key(['2'], async () => {
    await options.controller.setViewMode('capabilities');
    renderAll();
  });
  screen.key(['3'], async () => {
    await options.controller.setViewMode('diagnostics');
    renderAll();
  });
  screen.key(['4'], async () => {
    await options.controller.setViewMode('approvals');
    renderAll();
  });
  screen.key(['5'], async () => {
    await options.controller.setViewMode('events');
    renderAll();
  });
  screen.key(['6'], async () => {
    await options.controller.setViewMode('tasks');
    renderAll();
  });
  screen.key(['p'], async () => {
    await options.controller.handleInput('/provider');
    renderAll();
  });
  screen.key(['m'], async () => {
    await options.controller.handleInput('/mcp');
    renderAll();
  });
  screen.key(['k'], async () => {
    await options.controller.handleInput('/skills');
    renderAll();
  });
  screen.key(['g'], async () => {
    await options.controller.handleInput('/agent');
    renderAll();
  });
  screen.key(['o'], async () => {
    await options.controller.handleInput('/permissions');
    renderAll();
  });
  screen.key(['z'], async () => {
    await options.controller.handleInput('/compact');
    renderAll();
  });
  screen.key(['$'], async () => {
    await options.controller.handleInput('/cost');
    renderAll();
  });
  screen.key(['escape'], () => {
    paneIndex = 2;
    input.focus();
    renderAll();
  });

  inspector.key(['['], () => {
    if (options.controller.state.viewMode !== 'approvals') return;
    options.controller.selectPreviousApproval();
    renderAll();
  });
  inspector.key([']'], () => {
    if (options.controller.state.viewMode !== 'approvals') return;
    options.controller.selectNextApproval();
    renderAll();
  });
  inspector.key(['a'], async () => {
    if (options.controller.state.viewMode !== 'approvals') return;
    const applied = await options.controller.resolveSelectedApproval('APPROVED');
    if (applied) {
      transcript.log('[approval] approved selected invocation');
    }
    renderAll();
  });
  inspector.key(['r'], async () => {
    if (options.controller.state.viewMode !== 'approvals') return;
    const applied = await options.controller.resolveSelectedApproval('REJECTED');
    if (applied) {
      transcript.log('[approval] rejected selected invocation');
    }
    renderAll();
  });

  input.on('submit', async (value) => {
    const line = value.trim();
    input.clearValue();
    if (!line) {
      renderAll();
      input.focus();
      return;
    }
    const result = await options.controller.handleInput(line);
    if (result === 'exit') {
      cleanup(0);
      return;
    }
    renderAll();
    input.focus();
  });

  const timer = setInterval(async () => {
    if (polling || !options.controller.state.activeTaskId) return;
    polling = true;
    try {
      await options.controller.pollActiveEvents(0);
      await options.controller.refreshActiveTask();
      renderAll();
    } finally {
      polling = false;
    }
  }, 800);

  try {
    await options.initialize();
    transcript.log('Workspace chat started. Use /help for commands.');
    renderAll();
    input.focus();
    return await new Promise<number>((resolve) => {
      exitResolver = resolve;
    });
  } finally {
    clearInterval(timer);
    screen.destroy();
  }
}
