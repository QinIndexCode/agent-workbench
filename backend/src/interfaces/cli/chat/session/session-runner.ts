import readline from 'node:readline';
import { CliIo, CliRuntimeContext, ParsedCliArgs, writeJsonLine } from '../../shared';
import {
  ChatOutputFormat,
  WorkspaceChatEnvelope
} from '../protocol/chat-envelopes';
import { CliChatSessionController, normalizeSeedArg, resolveChatFormat } from './session-controller';
import { runBlessedWorkspaceChatUi } from '../tui/blessed-chat-ui';

function getRecordString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getRecordBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getRecordValue(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getStringArrayValue(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function getRecordArrayValue(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function formatHumanTaskSummary(task: Record<string, unknown>): string {
  const title = getRecordString(task, 'title', 'Untitled task');
  const taskId = getRecordString(task, 'taskId', 'unknown');
  const statusSummary = getRecordValue(task, 'statusSummary');
  const status = getRecordString(statusSummary ?? {}, 'label', 'Task truth unavailable');
  const stageLabel = getRecordString(task, 'stageLabel', 'Stage not started');
  const currentUnitId = getRecordString(task, 'currentUnitId', '-');
  const blockingReason = getRecordString(
    statusSummary ?? {},
    'detail',
    'Task query is missing statusSummary.'
  );
  const primaryAction = getRecordValue(task, 'primaryAction');
  const nextAction = getRecordValue(task, 'nextActionSummary');
  const completionSummary = getRecordValue(task, 'completionSummary');
  const delegationSummary = getRecordValue(task, 'delegationSummary');
  const visibleToolActivities = getRecordArrayValue(task, 'visibleToolActivities');
  const pendingApprovals = getRecordArrayValue(task, 'pendingApprovals');
  const approvalActions = getRecordValue(task, 'approvalActions');
  const improvementProposals = getRecordArrayValue(task, 'improvementProposals');
  const lines = [
    `[task] ${title} (${taskId})`,
    `Current status: ${status}`,
    `Stage: ${stageLabel}`,
    `Current unit: ${currentUnitId}`,
    `Why: ${blockingReason}`,
    `Primary action: ${getRecordString(primaryAction ?? {}, 'label', getRecordString(nextAction ?? {}, 'label', 'Wait'))}`,
    `Action detail: ${getRecordString(primaryAction ?? {}, 'description', getRecordString(nextAction ?? {}, 'reason', 'Task query is missing nextActionSummary.'))}`
  ];
  const activeChild = getRecordValue(delegationSummary ?? {}, 'activeChildTask');
  if (activeChild) {
    lines.push(`Delegation: Waiting on delegated subtask "${getRecordString(activeChild, 'title', 'SubSccAgent')}"`);
  } else if (delegationSummary && delegationSummary.missingRequiredDelegation === true) {
    lines.push('Delegation: Delegation required before parent delivery');
  }
  const resultSummary = getRecordString(completionSummary ?? {}, 'summary', '');
  if (resultSummary) {
    lines.push(`Recent result: ${resultSummary}`);
  }
  const destinationPaths = getStringArrayValue(completionSummary, 'artifactDestinationPaths');
  if (destinationPaths.length > 0) {
    lines.push(`Delivered to: ${destinationPaths.join(', ')}`);
  } else {
    const destinationDir = getRecordString(completionSummary ?? {}, 'artifactDestinationDir', '');
    if (destinationDir) {
      lines.push(`Destination folder: ${destinationDir}`);
    }
  }
  const artifactPaths = getStringArrayValue(completionSummary, 'artifactPaths');
  if (artifactPaths.length > 0) {
    lines.push(`Artifacts created: ${artifactPaths.join(', ')}`);
  }
  if (visibleToolActivities.length > 0) {
    for (const activity of visibleToolActivities.slice(-2)) {
      const toolId = getRecordString(activity, 'toolId', 'tool');
      const toolStatus = getRecordString(activity, 'status', 'unknown');
      const toolSummary = getRecordString(activity, 'summary', 'No summary');
      const evidencePaths = Array.isArray(activity.evidencePaths)
        ? activity.evidencePaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      lines.push(`Tool: ${toolId} [${toolStatus}] ${toolSummary}${evidencePaths[0] ? ` (${evidencePaths[0]})` : ''}`);
    }
  }
  if (pendingApprovals.length > 0) {
    const firstApproval = pendingApprovals[0];
    const invocationId = getRecordString(firstApproval, 'invocationId', 'unknown');
    const toolName = getRecordString(firstApproval, 'toolName', getRecordString(firstApproval, 'toolId', 'tool'));
    lines.push(`Approval required: ${toolName} (${invocationId})`);
    lines.push(`How to resolve: /approve ${invocationId} or /reject ${invocationId}`);
    if (approvalActions) {
      lines.push(`Approval guidance: ${getRecordString(approvalActions, 'guidance', 'Resolve the pending approval before continuing the thread.')}`);
    }
  }
  if (improvementProposals.length > 0) {
    const proposalSummary = improvementProposals
      .slice(0, 3)
      .map((proposal) => {
        const title = getRecordString(proposal, 'title', 'Proposal');
        const kind = getRecordString(proposal, 'kind', 'proposal');
        const status = getRecordString(proposal, 'status', 'PENDING');
        const archiveEligible = getRecordBoolean(proposal, 'archiveEligible', false);
        const duplicateOfProposalId = getRecordString(proposal, 'duplicateOfProposalId', '');
        const conflictsWith = getStringArrayValue(proposal, 'conflictsWithProposalIds');
        const flags = [
          archiveEligible ? 'archive eligible' : '',
          duplicateOfProposalId ? 'duplicate proposal' : '',
          conflictsWith.length > 0 ? 'conflicting lesson' : ''
        ].filter(Boolean);
        return `${kind}:${status.toLowerCase()} ${title}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`;
      });
    lines.push(`Improvements: ${proposalSummary.join(' | ')}`);
  }
  const approvalCount = task.approvalCount;
  if (typeof approvalCount === 'number') {
    lines.push(`Approvals: ${approvalCount}`);
  }
  const failureSummary = task.failureSummary;
  if (typeof failureSummary === 'string' && failureSummary.trim()) {
    lines.push(`Failure: ${failureSummary}`);
  }
  const recoverySummary = task.recoverySummary;
  if (typeof recoverySummary === 'string' && recoverySummary.trim()) {
    lines.push(`Recovery: ${recoverySummary}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatHumanDiagnostics(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return `[diagnostics] ${JSON.stringify(data, null, 2)}\n`;
  }
  const record = data as Record<string, unknown>;
  const summary = record.summary && typeof record.summary === 'object'
    ? record.summary as Record<string, unknown>
    : null;
  const statusSummary = summary ? getRecordValue(summary, 'statusSummary') : null;
  const primaryAction = summary ? getRecordValue(summary, 'primaryAction') : null;
  const nextAction = summary ? getRecordValue(summary, 'nextActionSummary') : null;
  const problem = getRecordString(statusSummary ?? {}, 'label', getRecordString(record, 'lifecycleStatus', 'Task'));
  const cause = getRecordString(statusSummary ?? {}, 'detail', getRecordString(record, 'providerFailure', 'No clear blocking reason recorded.'));
  const suggestedAction = getRecordString(primaryAction ?? {}, 'label', getRecordString(nextAction ?? {}, 'label', 'Inspect diagnostics'));
  const nextActionReason = getRecordString(primaryAction ?? {}, 'description', getRecordString(nextAction ?? {}, 'reason', 'Review technical evidence below.'));
  const acceptance = record.acceptance && typeof record.acceptance === 'object'
    ? record.acceptance as Record<string, unknown>
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
  const experienceSummary = record.experienceSummary && typeof record.experienceSummary === 'object'
    ? record.experienceSummary as Record<string, unknown>
    : null;
  const selectedExperiences = Array.isArray(experienceSummary?.selected)
    ? experienceSummary.selected.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const lines = [
    '[diagnostics]',
    `Problem: ${problem}`,
    `Cause: ${cause}`,
    `Suggested action: ${suggestedAction}`,
    `Why: ${nextActionReason}`
  ];
  if (record.providerFailure) {
    lines.push(`Provider failure: ${JSON.stringify(record.providerFailure)}`);
  }
  if (record.contractDiagnostics) {
    lines.push(`Contract diagnostics: ${JSON.stringify(record.contractDiagnostics)}`);
  }
  if (deterministic) {
    lines.push(`Acceptance: ${String(deterministic.verdict ?? 'unknown')} (${String(deterministic.profileId ?? 'analyze')})`);
  }
  if (quality) {
    lines.push(`Quality: ${String(quality.verdict ?? 'not_applicable')} (${String(quality.profileId ?? 'none')})`);
  }
  if (experienceSummary) {
    lines.push(
      `Experience: selected=${String(experienceSummary.selectedCount ?? selectedExperiences.length)} configured=${String(experienceSummary.configuredCount ?? 0)}`
    );
    for (const entry of selectedExperiences.slice(0, 2)) {
      lines.push(
        `- ${getRecordString(entry, 'title', getRecordString(entry, 'proposalId', 'experience'))} `
        + `[${getRecordString(entry, 'selectedBy', 'heuristic')}] `
        + `${getRecordString(entry, 'validationStatus', 'monitoring')}`
      );
    }
  }
  if (semanticReview) {
    lines.push(`Semantic review: ${String(semanticReview.status ?? 'not_requested')} confidence=${String(semanticReview.confidence ?? 'n/a')}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeHumanEnvelope(io: CliIo, payload: WorkspaceChatEnvelope): void {
  switch (payload.type) {
    case 'session':
      io.stdout.write(`[session] ${payload.message}${payload.taskId ? ` (${payload.taskId})` : ''}\n`);
      break;
    case 'task':
      io.stdout.write(formatHumanTaskSummary(payload.task));
      break;
    case 'event':
      io.stdout.write(`[event] ${payload.record.type} ${payload.record.taskId}\n`);
      break;
    case 'info':
      io.stdout.write(`${payload.message}\n`);
      break;
    case 'prompt':
      io.stdout.write(payload.prompt);
      break;
    case 'diagnostics':
      io.stdout.write(formatHumanDiagnostics(payload.data));
      break;
    case 'approvals':
      if (payload.count > 0) {
        const approvals = Array.isArray(payload.approvals) ? payload.approvals as Array<Record<string, unknown>> : [];
        const lines = [`[approvals] pending=${payload.count}`];
        for (const approval of approvals) {
          const invocationId = getRecordString(approval, 'invocationId', 'unknown');
          const toolName = getRecordString(approval, 'toolName', getRecordString(approval, 'toolId', 'tool'));
          lines.push(`- ${toolName} (${invocationId})`);
          lines.push(`  resolve with /approve ${invocationId} or /reject ${invocationId}`);
        }
        io.stdout.write(`${lines.join('\n')}\n`);
      }
      break;
    case 'view':
      io.stdout.write(`[view:${payload.view}] ${JSON.stringify(payload.data, null, 2)}\n`);
      break;
  }
}

function emitEnvelope(io: CliIo, format: ChatOutputFormat, payload: WorkspaceChatEnvelope): void {
  if (format === 'ndjson') {
    writeJsonLine(io, payload);
    return;
  }
  writeHumanEnvelope(io, payload);
}

function shouldUseBlessedUi(stdin: NodeJS.ReadableStream, format: ChatOutputFormat, mode: 'workspace' | 'task'): boolean {
  return format === 'human' && mode === 'workspace' && Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) && Boolean(process.stdout.isTTY);
}

export async function runCliChatSession(options: {
  mode: 'workspace' | 'task';
  context: CliRuntimeContext;
  args: ParsedCliArgs;
  rest: string[];
  stdin: NodeJS.ReadableStream;
}): Promise<number> {
  const format = resolveChatFormat(options.args, options.stdin, options.mode);
  const useTui = shouldUseBlessedUi(options.stdin, format, options.mode);
  const seed = normalizeSeedArg(options.rest[0]);
  let tuiEnvelopeHandler: ((payload: WorkspaceChatEnvelope) => void) | null = null;
  const controller = new CliChatSessionController({
    mode: options.mode,
    context: options.context,
    args: options.args,
    outputFormat: format,
    onEnvelope: (payload) => {
      if (useTui) {
        tuiEnvelopeHandler?.(payload);
        return;
      }
      emitEnvelope(options.context.io, format, payload);
    }
  });

  if (useTui) {
    return runBlessedWorkspaceChatUi({
      controller,
      initialize: () => controller.initialize({
        taskId: seed?.kind === 'taskId' ? seed.value : null,
        filePath: seed?.kind === 'file' ? seed.value : null
      }),
      registerEnvelopeHandler: (handler) => {
        tuiEnvelopeHandler = handler;
      }
    });
  }

  await controller.initialize({
    taskId: seed?.kind === 'taskId' ? seed.value : null,
    filePath: seed?.kind === 'file' ? seed.value : null
  });

  const lineReader = readline.createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });

  for await (const rawLine of lineReader) {
    const line = rawLine.trim();
    controller.state.inputDraft = line;
    if (!line) {
      if (format === 'human') {
        emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });
      }
      continue;
    }
    const result = await controller.handleInput(line);
    if (result === 'exit') {
      lineReader.close();
      return 0;
    }
    if (format === 'human') {
      emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });
    }
  }

  emitEnvelope(options.context.io, format, {
    type: 'session',
    action: 'closed',
    taskId: controller.state.activeTaskId,
    message: 'Interactive session closed'
  });
  return 0;
}
