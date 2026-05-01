import fs from 'node:fs';
import {
  HealthResponse,
  QueueActiveResponse,
  QueueDeadLetterResponse,
  QueueRecoverExpiredResponse,
  QueueRequeueResponse,
  ReadinessResponse,
  RuntimeEventStreamEnvelope,
  TaskDebugApiResponse,
  RuntimeWebSocketClientMessage,
  RuntimeWebSocketEnvelope,
  TaskCommandRequest,
  TaskCommandsQueryResponse,
  TaskEventsQueryResponse,
  TaskListApiResponse,
  TaskOperatorMessagesQueryResponse,
  TaskQueryApiResponse,
  TaskSubmitRequest
} from '../http/types';

export type FetchLike = typeof fetch;

type TaskDebugResponse = TaskDebugApiResponse;

export interface CliIo {
  stdout: {
    write(chunk: string): void;
  };
  stderr: {
    write(chunk: string): void;
  };
}

export interface CliWebSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export type CreateWebSocket = (url: string) => CliWebSocketLike;

export interface RunBackendNewCliOptions {
  argv: string[];
  fetchImpl?: FetchLike;
  io?: CliIo;
  stdin?: NodeJS.ReadableStream;
  createWebSocket?: CreateWebSocket;
  sleep?: (ms: number) => Promise<void>;
}

export interface ParsedCliArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

export interface CliEventEnvelope {
  kind: 'runtime_event' | 'task_snapshot' | 'heartbeat' | 'ready' | 'subscribed' | 'unsubscribed' | 'error';
  source: 'ws' | 'sse' | 'poll';
  taskId?: string;
  event?: string;
  data?: unknown;
  task?: TaskQueryApiResponse | null;
  taskSummary?: Record<string, unknown> | null;
  error?: string;
  code?: string;
  latestEventId?: string | null;
  timestamp?: number;
  summary?: TaskProgressSummary | null;
}

export interface CliRuntimeContext {
  args: ParsedCliArgs;
  fetchImpl: FetchLike;
  io: CliIo;
  stdin: NodeJS.ReadableStream;
  createWebSocket: CreateWebSocket;
  sleep: (ms: number) => Promise<void>;
  serverUrl: string;
}

export interface CliCommandModule {
  group: string;
  aliases?: string[];
  handle(action: string | undefined, rest: string[], context: CliRuntimeContext): Promise<number | null>;
  usage: string[];
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3011';
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
const TERMINAL_EVENTS = new Set(['TASK_COMPLETED', 'TASK_CANCELLED', 'TASK_FAILED']);

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      command.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { command, flags };
}

export function getFlagString(args: ParsedCliArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function getServerUrl(args: ParsedCliArgs): string {
  return getFlagString(args, 'server') ?? process.env.BACKEND_NEW_SERVER_URL ?? DEFAULT_SERVER_URL;
}

export function getWebSocketUrl(serverUrl: string, args: ParsedCliArgs): string {
  const wsPath = getFlagString(args, 'ws-path') ?? process.env.BACKEND_NEW_WEBSOCKET_PATH ?? '/ws';
  const parsed = new URL(serverUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = wsPath;
  parsed.search = '';
  return parsed.toString();
}

export function getAfterEventId(args: ParsedCliArgs): string | undefined {
  return getFlagString(args, 'after-event-id');
}

export function hasFlag(args: ParsedCliArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function parseCsvFlag(args: ParsedCliArgs, name: string): string[] {
  const value = getFlagString(args, name);
  if (!value) {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function buildTaskPayloadFromFlags(args: ParsedCliArgs): TaskSubmitRequest {
  const title = getFlagString(args, 'title')?.trim();
  const intent = getFlagString(args, 'intent')?.trim();
  const executionProfileId = getFlagString(args, 'execution-profile');
  if (!title) {
    throw new Error('backend_new CLI error: --title is required when no task JSON file is provided.');
  }
  if (!intent) {
    throw new Error('backend_new CLI error: --intent is required when no task JSON file is provided.');
  }
  const metadataFile = getFlagString(args, 'metadata-file');
  const metadata = metadataFile ? readJsonFile(metadataFile) as Record<string, unknown> : undefined;
  return {
    taskId: getFlagString(args, 'task-id'),
    title,
    intent,
    defaultQualityProfileId: (getFlagString(args, 'quality-profile') as TaskSubmitRequest['defaultQualityProfileId']) ?? undefined,
    preferredProviderId: getFlagString(args, 'provider') ?? null,
    pathPolicy: (getFlagString(args, 'path-policy') as TaskSubmitRequest['pathPolicy']) ?? undefined,
    preferredArtifactDir: getFlagString(args, 'output-dir') ?? null,
    metadata,
    units: [
      {
        id: getFlagString(args, 'unit-id') ?? 'AGENT-001',
        role: getFlagString(args, 'role') ?? 'Operator',
        goal: getFlagString(args, 'goal') ?? intent,
        outputContract: getFlagString(args, 'output-contract') ?? '{"summary":"string","details":"string"}',
        executionProfileId:
          executionProfileId === 'analyze'
          || executionProfileId === 'implement'
          || executionProfileId === 'verify'
            ? executionProfileId
            : undefined,
        dependencies: parseCsvFlag(args, 'depends-on')
      }
    ]
  };
}

export function resolveTaskSubmitPayload(rest: string[], args: ParsedCliArgs): TaskSubmitRequest {
  const [jsonFile] = rest;
  if (jsonFile) {
    return readJsonFile(jsonFile) as TaskSubmitRequest;
  }
  return buildTaskPayloadFromFlags(args);
}

export async function requestJson<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed with status ${response.status}.`);
    (error as Error & { statusCode?: number; payload?: unknown }).statusCode = response.status;
    (error as Error & { statusCode?: number; payload?: unknown }).payload = payload;
    throw error;
  }
  return payload as T;
}

export async function submitTaskPayload(fetchImpl: FetchLike, serverUrl: string, payload: TaskSubmitRequest): Promise<{ command: { taskId: string } }> {
  return requestJson(fetchImpl, `${serverUrl}/tasks`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeText(io: CliIo, value: string): void {
  io.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function getRecordValue(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getRecordString(record: Record<string, unknown> | null | undefined, key: string, fallback: string): string {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function getRecordNumber(record: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getRecordArray(record: Record<string, unknown> | null | undefined, key: string): Array<Record<string, unknown>> {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function getStringArray(record: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function formatOptionalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'none';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function formatHumanAcceptance(summary: Record<string, unknown>): string[] {
  const acceptance = getRecordValue(summary, 'acceptance');
  const deterministic = getRecordValue(acceptance, 'deterministic');
  const semanticReview = getRecordValue(acceptance, 'semanticReview');
  const quality = getRecordValue(acceptance, 'quality') ?? getRecordValue(summary, 'quality');
  const lines: string[] = [];
  if (deterministic) {
    lines.push(
      `Acceptance: ${getRecordString(deterministic, 'verdict', 'unknown')} (${getRecordString(deterministic, 'profileId', 'contract')})`
    );
  } else {
    lines.push('Acceptance: inspect diagnostics for contract truth');
  }
  if (quality) {
    lines.push(`Quality: ${getRecordString(quality, 'verdict', 'not_applicable')} (${getRecordString(quality, 'profileId', 'none')})`);
  }
  if (semanticReview) {
    lines.push(
      `Semantic review: ${getRecordString(semanticReview, 'status', 'not_requested')} confidence=${formatOptionalJson(semanticReview.confidence)}`
    );
  }
  return lines;
}

function formatHumanArtifactState(summary: Record<string, unknown>): string[] {
  const completionSummary = getRecordValue(summary, 'completionSummary');
  const artifactPathState = getRecordString(summary, 'artifactPathState', 'sandbox_only');
  const pendingArtifactCount = getRecordNumber(summary, 'pendingArtifactCount', 0);
  const selectedArtifactDir = getRecordString(summary, 'selectedArtifactDir', '');
  const recommendedArtifactDir = getRecordString(summary, 'recommendedArtifactDir', '');
  const lastApplyResult = getRecordValue(summary, 'lastArtifactApplyResult');
  const destinationPaths = [
    ...getStringArray(completionSummary, 'artifactDestinationPaths'),
    ...getStringArray(summary, 'artifactDestinationPaths')
  ];
  const artifactPaths = [
    ...getStringArray(completionSummary, 'artifactPaths'),
    ...getStringArray(summary, 'artifactPaths')
  ];
  const lines = [
    `Artifact state: ${artifactPathState} (${pendingArtifactCount} pending)`
  ];
  if (destinationPaths.length > 0) {
    lines.push(`Delivered to: ${destinationPaths.join(', ')}`);
  } else if (selectedArtifactDir) {
    lines.push(`Selected destination: ${selectedArtifactDir}`);
  } else if (recommendedArtifactDir) {
    lines.push(`Recommended destination: ${recommendedArtifactDir}`);
  }
  if (artifactPaths.length > 0) {
    lines.push(`Artifacts: ${artifactPaths.join(', ')}`);
  }
  if (lastApplyResult) {
    lines.push(`Last apply: ${getRecordString(lastApplyResult, 'status', 'unknown')} ${getRecordString(lastApplyResult, 'destinationDir', '')}`.trim());
  }
  return lines;
}

export function formatTaskSummaryHuman(summary: Record<string, unknown>, options: { source?: 'status' | 'inspect' | 'chat' } = {}): string {
  const statusSummary = getRecordValue(summary, 'statusSummary');
  const primaryAction = getRecordValue(summary, 'primaryAction');
  const nextActionSummary = getRecordValue(summary, 'nextActionSummary');
  const suggestedAction = getRecordValue(summary, 'suggestedAction');
  const providerSummary = getRecordValue(summary, 'providerSummary');
  const completionSummary = getRecordValue(summary, 'completionSummary');
  const latestVisibleOutput = getRecordValue(summary, 'latestVisibleOutput');
  const visibleToolActivities = getRecordArray(summary, 'visibleToolActivities');
  const pendingApprovals = getRecordArray(summary, 'pendingApprovals');
  const issuePlane = getRecordString(summary, 'issuePlane', 'none');
  const issueCategory = getRecordString(summary, 'issueCategory', 'none');
  const title = getRecordString(summary, 'title', 'Untitled task');
  const taskId = getRecordString(summary, 'taskId', 'unknown');
  const actionLabel = getRecordString(
    suggestedAction,
    'label',
    getRecordString(primaryAction, 'label', getRecordString(nextActionSummary, 'label', 'Inspect diagnostics'))
  );
  const actionReason = getRecordString(
    suggestedAction,
    'reason',
    getRecordString(primaryAction, 'description', getRecordString(nextActionSummary, 'reason', 'Review task truth.'))
  );
  const lines = [
    'SCC Batch Agent Console',
    `Task: ${title}`,
    `Task id: ${taskId}`,
    `Current status: ${getRecordString(statusSummary, 'label', getRecordString(summary, 'lifecycleStatus', 'unknown'))}`,
    `Stage: ${getRecordString(summary, 'stageLabel', 'Stage not started')}`,
    `Failure plane: ${issuePlane} / ${issueCategory}`,
    `Reason: ${getRecordString(statusSummary, 'detail', getRecordString(summary, 'blockingReason', 'Task truth is not available.'))}`,
    '',
    'Task truth',
    `Primary action: ${getRecordString(primaryAction, 'label', getRecordString(nextActionSummary, 'label', actionLabel))}`,
    `Suggested action: ${actionLabel}`,
    `Action detail: ${actionReason}`,
    `Next command: scc-batch tasks chat ${taskId} --format human`
  ];
  if (providerSummary) {
    lines.push(
      `Provider: ${getRecordString(providerSummary, 'providerId', 'unknown')} / ${getRecordString(providerSummary, 'readiness', 'unknown')}`
    );
  }
  const resultSummary = getRecordString(completionSummary, 'summary', getRecordString(latestVisibleOutput, 'summary', ''));
  if (resultSummary) {
    lines.push(`Recent result: ${resultSummary}`);
  }
  lines.push('', 'Evidence');
  lines.push(...formatHumanAcceptance(summary));
  lines.push(...formatHumanArtifactState(summary));
  if (visibleToolActivities.length > 0) {
    for (const activity of visibleToolActivities.slice(-2)) {
      lines.push(
        `Tool evidence: ${getRecordString(activity, 'toolId', 'tool')} [${getRecordString(activity, 'status', 'unknown')}] ${getRecordString(activity, 'summary', 'No summary')}`
      );
    }
  }
  if (pendingApprovals.length > 0) {
    const approval = pendingApprovals[0];
    const invocationId = getRecordString(approval, 'invocationId', 'unknown');
    lines.push(`Approval required: ${getRecordString(approval, 'toolName', getRecordString(approval, 'toolId', 'tool'))} (${invocationId})`);
    lines.push(`Resolve: scc-batch tasks approve ${taskId} ${invocationId} APPROVED`);
  }
  const issueSummary = getRecordString(summary, 'issueSummary', '');
  if (issueSummary) {
    lines.push('', `Issue summary: ${issueSummary}`);
  }
  if (options.source === 'inspect') {
    lines.push('', 'Inspector: open REST /tasks/:id/debug for raw contract truth.');
  }
  return `${lines.join('\n')}\n`;
}

export function formatTaskDiagnosticsHuman(diagnostics: Record<string, unknown>): string {
  const summary = getRecordValue(diagnostics, 'summary');
  const statusSummary = getRecordValue(summary, 'statusSummary');
  const primaryAction = getRecordValue(diagnostics, 'primaryAction') ?? getRecordValue(summary, 'primaryAction');
  const nextActionSummary = getRecordValue(diagnostics, 'nextActionSummary') ?? getRecordValue(summary, 'nextActionSummary');
  const suggestedAction = getRecordValue(diagnostics, 'suggestedAction');
  const planner = getRecordValue(diagnostics, 'planner');
  const issuePlane = getRecordString(diagnostics, 'issuePlane', 'none');
  const issueCategory = getRecordString(diagnostics, 'issueCategory', 'none');
  const actionLabel = getRecordString(
    suggestedAction,
    'label',
    getRecordString(primaryAction, 'label', getRecordString(nextActionSummary, 'label', 'Inspect diagnostics'))
  );
  const actionReason = getRecordString(
    suggestedAction,
    'reason',
    getRecordString(primaryAction, 'description', getRecordString(nextActionSummary, 'reason', 'Review task truth.'))
  );
  const lines = [
    'SCC Batch Agent Console',
    'Task diagnostics',
    `Task id: ${getRecordString(diagnostics, 'taskId', 'unknown')}`,
    `Lifecycle: ${getRecordString(diagnostics, 'lifecycleStatus', 'unknown')}`,
    `Failure plane: ${issuePlane} / ${issueCategory}`,
    `Problem: ${getRecordString(statusSummary, 'label', getRecordString(summary, 'statusLabel', 'Task truth unavailable'))}`,
    `Cause: ${getRecordString(statusSummary, 'detail', getRecordString(summary, 'blockingReason', 'No clear blocking reason recorded.'))}`,
    `Suggested action: ${actionLabel}`,
    `Why: ${actionReason}`,
    '',
    'Acceptance and quality',
    ...formatHumanAcceptance(diagnostics),
    '',
    'Artifact state',
    ...formatHumanArtifactState({
      ...diagnostics,
      ...(summary ?? {})
    })
  ];
  if (planner) {
    lines.push(
      '',
      'Runtime',
      `Planner phase: ${getRecordString(planner, 'executionPhase', 'unknown')}`,
      `Stage count: ${formatOptionalJson(planner.stageCount)}`,
      `Current stage: ${formatOptionalJson(planner.currentStageIndex)}`
    );
  }
  const providerFailure = diagnostics.providerFailure;
  if (providerFailure) {
    lines.push('', `Provider failure: ${formatOptionalJson(providerFailure)}`);
  }
  const evidenceGaps = getStringArray(getRecordValue(diagnostics, 'executionSummary'), 'evidenceGaps');
  if (evidenceGaps.length > 0) {
    lines.push('', 'Evidence gaps', ...evidenceGaps.map((gap) => `- ${gap}`));
  }
  return `${lines.join('\n')}\n`;
}

export function writeError(io: CliIo, error: unknown): void {
  if (error instanceof Error) {
    io.stderr.write(`${JSON.stringify({
      error: error.message,
      statusCode: (error as Error & { statusCode?: number }).statusCode ?? null
    })}\n`);
    return;
  }
  io.stderr.write(`${JSON.stringify({ error: String(error) })}\n`);
}

function summarizePathList(paths: string[]): string {
  if (paths.length === 0) {
    return 'the generated artifact';
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return `${paths[0]} +${paths.length - 1} more`;
}

function getArtifactDestinationDir(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): string | null {
  return task.completionSummary?.artifactDestinationDir
    ?? task.latestVisibleOutput?.artifactDestinationDir
    ?? debug?.executionSummary.lastArtifactApplyResult?.destinationDir
    ?? debug?.executionSummary.selectedArtifactDir
    ?? null;
}

function getCompletionSummary(
  task: TaskQueryApiResponse,
): TaskQueryApiResponse['completionSummary'] {
  return task.completionSummary ?? null;
}

function buildTruthGapPrimaryAction(
  task: TaskQueryApiResponse,
  debug: TaskDebugResponse | null,
): TaskQueryApiResponse['primaryAction'] {
  return {
    kind: 'wait',
    label: 'Task truth unavailable',
    description: `Task query is missing a primary action for lifecycle ${task.runtime.lifecycleStatus}. Refresh the task or inspect diagnostics before continuing.`,
    destinationDir: getArtifactDestinationDir(task, debug)
  };
}

function getPrimaryAction(
  task: TaskQueryApiResponse,
  debug: TaskDebugResponse | null
): TaskQueryApiResponse['primaryAction'] {
  return task.primaryAction ?? buildTruthGapPrimaryAction(task, debug);
}

function getNextActionSummary(
  task: TaskQueryApiResponse,
  primaryAction: TaskQueryApiResponse['primaryAction']
): TaskQueryApiResponse['nextActionSummary'] {
  if (task.nextActionSummary) {
    return task.nextActionSummary;
  }
  return {
    label: primaryAction.label,
    reason: primaryAction.description
  };
}

function getStatusSummary(task: TaskQueryApiResponse): TaskQueryApiResponse['statusSummary'] {
  return task.statusSummary ?? {
    label: 'Task truth unavailable',
    detail: `Task query is missing statusSummary for lifecycle ${task.runtime.lifecycleStatus}.`,
    tone: 'blocked'
  };
}

function buildApprovalActions(task: TaskQueryApiResponse): Record<string, unknown> | null {
  const pendingApprovalItems = getPendingApprovalItems(task);
  if (pendingApprovalItems.length === 0) {
    return null;
  }
  const firstApproval = pendingApprovalItems[0] ?? null;
  return {
    required: true,
    pendingCount: pendingApprovalItems.length,
    defaultInvocationId: typeof firstApproval?.invocationId === 'string' ? firstApproval.invocationId : null,
    resolutionOptions: ['APPROVED', 'REJECTED'],
    guidance: 'Resolve the pending approval before continuing the thread.',
  };
}

function getPendingApprovalItems(task: TaskQueryApiResponse): Array<Record<string, unknown>> {
  if (Array.isArray(task.pendingApprovalItems) && task.pendingApprovalItems.length > 0) {
    return task.pendingApprovalItems.map((approval) => ({
      invocationId: approval.invocationId,
      toolId: approval.toolId,
      toolName: approval.toolName,
      requestedAt: approval.requestedAt,
      argumentsSummary: approval.argumentsSummary,
      status: approval.status,
      availableActions: approval.availableActions,
    }));
  }
  return task.pendingApprovals.map((approval) => buildPendingApprovalProjection(task, approval));
}

function buildArchiveActions(task: TaskQueryApiResponse): Record<string, unknown> {
  const available = [
    ...(task.canArchive ? ['archive'] : []),
    ...(task.isArchived ? ['unarchive'] : []),
    ...(task.canDelete ? ['delete'] : [])
  ];
  return {
    available,
    terminalOnly: true,
    requiresExplicitFilterWhenArchived: task.isArchived
  };
}

function buildPendingApprovalProjection(
  task: TaskQueryApiResponse,
  approval: TaskQueryApiResponse['pendingApprovals'][number]
): Record<string, unknown> {
  const matchingInvocation = task.toolInvocations.find((invocation) => invocation.invocationId === approval.invocationId) ?? null;
  return {
    invocationId: approval.invocationId,
    toolId: approval.toolId,
    toolName: approval.toolId,
    status: approval.status,
    createdAt: approval.createdAt,
    arguments:
      (matchingInvocation?.arguments && typeof matchingInvocation.arguments === 'object' && !Array.isArray(matchingInvocation.arguments))
        ? matchingInvocation.arguments
        : null,
  };
}

export function summarizeTask(task: TaskQueryApiResponse, debug: TaskDebugResponse | null = null): Record<string, unknown> {
  const progress = deriveTaskProgressSummary(task, debug);
  const primaryAction = getPrimaryAction(task, debug);
  const nextActionSummary = getNextActionSummary(task, primaryAction);
  const completionSummary = getCompletionSummary(task);
  const statusSummary = getStatusSummary(task);
  const pendingApprovalItems = getPendingApprovalItems(task);
  const pendingApprovals = task.pendingApprovals.map((approval) => buildPendingApprovalProjection(task, approval));
  return {
    taskId: task.definition.taskId,
    title: task.definition.title,
    intent: task.definition.intent,
    lifecycleStatus: task.runtime.lifecycleStatus,
    engineStatus: task.runtime.engineStatus,
    currentUnitId: task.runtime.currentUnitId,
    updatedAt: task.runtime.updatedAt ?? task.definition.createdAt ?? null,
    queueState: task.queue?.state ?? null,
    isArchived: task.isArchived ?? false,
    canArchive: task.canArchive ?? false,
    canDelete: task.canDelete ?? false,
    pendingApprovalCount: pendingApprovalItems.length,
    pendingApprovals,
    pendingApprovalItems,
    approvalActions: buildApprovalActions(task),
    archiveActions: buildArchiveActions(task),
    lastError: task.diagnostics.lastError,
    providerFailure: task.diagnostics.providerFailure,
    progressState: progress.progressState,
    stageLabel: progress.stageLabel,
    statusSummary,
    blockingReason: progress.blockingReason,
    nextAction: nextActionSummary.label,
    nextActionReason: nextActionSummary.reason,
    primaryAction,
    nextActionSummary,
    completionSummary,
    delegationSummary: task.delegationSummary ?? null,
    improvementProposals: task.improvementProposals ?? [],
    realTaskArchiveStatus: task.realTaskArchiveStatus ?? null,
    latestVisibleOutput: task.latestVisibleOutput ?? null,
    visibleToolActivities: task.visibleToolActivities ?? [],
    approvalCount: progress.approvalCount,
    failureSummary: progress.failureSummary,
    recoverySummary: progress.recoverySummary,
    correctionDepth: progress.correctionDepth,
    providerFailureStreak: progress.providerFailureStreak,
    skillFailureStreak: progress.skillFailureStreak,
    mcpFailureStreak: progress.mcpFailureStreak,
    issuePlane: debug?.executionSummary.issuePlane ?? null,
    issueCategory: debug?.executionSummary.issueCategory ?? null,
    issueSummary: debug?.executionSummary.issueSummary ?? null,
    suggestedAction: debug?.executionSummary.suggestedAction ?? null,
    acceptance: debug?.executionSummary.acceptance ?? null,
    quality: debug?.executionSummary.acceptance?.quality ?? null,
    lastSafeCheckpointAt: progress.lastSafeCheckpointAt,
    lastRecoverySource: progress.lastRecoverySource,
    conservativeModeReason: progress.conservativeModeReason,
    ruleSummary: debug?.executionSummary.ruleSummary ?? null,
    hookSummary: debug?.executionSummary.hookSummary ?? null,
    agentSummary: debug?.executionSummary.agentSummary ?? null,
    providerSummary: debug?.executionSummary.providerSummary ?? null,
    instructionSkillSummary: debug?.executionSummary.instructionSkillSummary ?? null,
    experienceSummary: debug?.executionSummary.experienceSummary ?? null,
    skillSummary: debug?.executionSummary.skillSummary ?? null,
    mcpSummary: debug?.executionSummary.mcpSummary ?? null,
    permissionSummary: debug?.executionSummary.permissionSummary ?? null,
    capabilityWarnings: debug?.executionSummary.capabilityWarnings ?? []
    ,
    artifactPathState: debug?.executionSummary.artifactPathState ?? 'sandbox_only',
    pendingArtifactCount: debug?.executionSummary.pendingArtifactCount ?? 0,
    selectedArtifactDir: debug?.executionSummary.selectedArtifactDir ?? null,
    recommendedArtifactDir: debug?.executionSummary.recommendedArtifactDir ?? null,
    artifactPaths: debug?.executionSummary.artifactPaths ?? [],
    artifactDestinationPaths: debug?.executionSummary.artifactDestinationPaths ?? [],
    lastArtifactApplyAt: debug?.executionSummary.lastArtifactApplyAt ?? null,
    lastArtifactApplyResult: debug?.executionSummary.lastArtifactApplyResult ?? null
  };
}

export type TaskProgressState =
  | 'ready_to_start'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_continue'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'non_convergent';

export interface TaskProgressSummary {
  progressState: TaskProgressState;
  statusLabel: string;
  stageLabel: string;
  currentUnitId: string | null;
  blockingReason: string;
  nextAction: string;
  nextActionReason: string;
  approvalCount: number;
  failureSummary: string | null;
  recoverySummary: string | null;
  artifactPathState: TaskDebugResponse['executionSummary']['artifactPathState'] | 'sandbox_only';
  pendingArtifactCount: number;
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  artifactPaths: string[];
  lastArtifactApplyAt: number | null;
  lastArtifactApplyResult: TaskDebugResponse['executionSummary']['lastArtifactApplyResult'] | null;
  correctionDepth: number;
  providerFailureStreak: number;
  skillFailureStreak: number;
  mcpFailureStreak: number;
  issuePlane: TaskDebugResponse['executionSummary']['issuePlane'] | null;
  issueCategory: TaskDebugResponse['executionSummary']['issueCategory'] | null;
  issueSummary: string | null;
  suggestedAction: TaskDebugResponse['executionSummary']['suggestedAction'] | null;
  lastSafeCheckpointAt: number | null;
  lastRecoverySource: string | null;
  conservativeModeReason: string | null;
  providerSummary?: TaskDebugResponse['executionSummary']['providerSummary'] | null;
  instructionSkillSummary?: TaskDebugResponse['executionSummary']['instructionSkillSummary'] | null;
  experienceSummary?: TaskDebugResponse['executionSummary']['experienceSummary'] | null;
  skillSummary?: TaskDebugResponse['executionSummary']['skillSummary'] | null;
  mcpSummary?: TaskDebugResponse['executionSummary']['mcpSummary'] | null;
  permissionSummary?: TaskDebugResponse['executionSummary']['permissionSummary'] | null;
  capabilityWarnings?: TaskDebugResponse['executionSummary']['capabilityWarnings'] | null;
}

function getActiveStageIndex(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): number | null {
  if (!debug) {
    return null;
  }
  const currentUnitId = task.runtime.currentUnitId;
  if (currentUnitId) {
    const unitDuration = debug.executionSummary.unitDurations.find((entry) => entry.unitId === currentUnitId);
    if (unitDuration?.stageIndex !== null && unitDuration?.stageIndex !== undefined) {
      return unitDuration.stageIndex;
    }
    const stage = debug.executionSummary.stageDurations.find((entry) => entry.unitIds.includes(currentUnitId));
    if (stage) {
      return stage.stageIndex;
    }
  }

  if (task.runtime.lifecycleStatus === 'COMPLETED' && debug.executionSummary.stageDurations.length > 0) {
    return debug.executionSummary.stageDurations.length - 1;
  }

  return null;
}

function getStageLabel(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): string {
  const totalStages = debug?.executionSummary.stageDurations.length ?? 0;
  const activeStageIndex = getActiveStageIndex(task, debug);
  if (totalStages > 0 && activeStageIndex !== null) {
    return `Stage ${activeStageIndex + 1} of ${totalStages}`;
  }
  if (totalStages > 0) {
    return `${totalStages} stage${totalStages === 1 ? '' : 's'} planned`;
  }
  if (task.runtime.currentUnitId) {
    return 'Stage in progress';
  }
  return 'Stage not started';
}

function getProgressState(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): TaskProgressState {
  if (task.pendingApprovals.length > 0) {
    return 'awaiting_approval';
  }
  if (debug?.executionSummary.artifactPathState === 'unresolved') {
    return 'awaiting_continue';
  }
  if (debug?.executionSummary.turnContract.correctionLoopNonConvergent) {
    return 'non_convergent';
  }
  switch (task.runtime.lifecycleStatus) {
    case 'SUBMITTED':
      return 'ready_to_start';
    case 'PAUSED':
      return 'paused';
    case 'FAILED':
      return 'failed';
    case 'COMPLETED':
      return 'completed';
    default:
      return debug?.executionSummary.turnContract.pendingCorrection
        && debug.executionSummary.turnContract.pendingCorrection !== 'NONE'
        ? 'awaiting_continue'
        : 'running';
  }
}

function getStatusLabel(progressState: TaskProgressState): string {
  switch (progressState) {
    case 'ready_to_start':
      return 'Ready to start';
    case 'running':
      return 'Running';
    case 'awaiting_approval':
      return 'Approval required';
    case 'awaiting_continue':
      return 'Needs continue guidance';
    case 'paused':
      return 'Paused';
    case 'failed':
      return 'Failed';
    case 'completed':
      return 'Completed';
    case 'non_convergent':
      return 'Needs manual intervention';
    default:
      return 'Task';
  }
}

function sanitizeContinueReasonForDisplay(
  lifecycle: TaskQueryApiResponse['runtime']['lifecycleStatus'],
  continueReason: string | null | undefined
): string | null {
  if (!continueReason) {
    return null;
  }
  const normalized = continueReason.replace(/\s+/g, ' ').trim().toLowerCase();
  if (
    lifecycle === 'RUNNING'
    && (normalized.includes('completed')
      || normalized.includes('not allowed')
      || normalized.includes('cannot continue'))
  ) {
    return 'The runtime is settling the current step before the next operator action becomes available.';
  }
  return continueReason;
}

function buildBlockingReason(
  task: TaskQueryApiResponse,
  debug: TaskDebugResponse | null,
  progressState: TaskProgressState
): string {
  if (task.delegationSummary?.missingRequiredDelegation) {
    return 'Delegation required before parent delivery. The runtime must launch a delegated child task before the parent can continue.';
  }
  if (task.delegationSummary?.activeChildTask) {
    return `Waiting for delegated subtask "${task.delegationSummary.activeChildTask.title}" to finish and return its scoped result.`;
  }
  if (progressState === 'awaiting_approval') {
    return `${task.pendingApprovals.length} tool approval(s) are blocking runtime progress.`;
  }
  if (debug?.executionSummary.artifactPathState === 'unresolved') {
    const suggested = debug.executionSummary.recommendedArtifactDir
      ? ` Recommended directory: ${debug.executionSummary.recommendedArtifactDir}.`
      : '';
    return `The task produced or will produce files, but no project-relative destination is selected.${suggested}`;
  }
  if (progressState === 'non_convergent') {
    return 'Repeated correction failures indicate the current loop is not converging.';
  }
  if ((debug?.executionSummary.capabilityWarnings.length ?? 0) > 0) {
    return debug?.executionSummary.capabilityWarnings[0]?.message ?? 'A side capability is not ready for this task.';
  }
  if (task.diagnostics.providerFailure?.message) {
    return debug?.executionSummary.conservativeModeReason
      ? `${task.diagnostics.providerFailure.message} Conservative mode: ${debug.executionSummary.conservativeModeReason}.`
      : task.diagnostics.providerFailure.message;
  }
  if (progressState === 'failed') {
    return task.diagnostics.lastError ?? debug?.executionSummary.issueSummary ?? 'The last task turn failed.';
  }
  if (progressState === 'paused') {
    return 'Execution is paused and waiting for an operator decision.';
  }
  if (progressState === 'ready_to_start') {
    return 'The task has been submitted but no turn has started yet.';
  }
  if (progressState === 'completed') {
    const deliveredTo = getArtifactDestinationDir(task, debug);
    if (deliveredTo) {
      return `The task is complete and artifacts were delivered to ${deliveredTo}.`;
    }
    return 'The task reached a terminal completed state.';
  }
  if (progressState === 'awaiting_continue') {
    const continueReason = sanitizeContinueReasonForDisplay(
      task.runtime.lifecycleStatus,
      debug?.executionSummary.turnContract.continueReason
    );
    if (debug?.executionSummary.conservativeModeReason) {
      return `Continue is available with caution. Conservative mode is active because ${debug.executionSummary.conservativeModeReason}.`;
    }
    return continueReason ?? 'The runtime is waiting for the next guided continue step.';
  }
  if (debug && !debug.executionSummary.queueRuntimeAlignment.consistent) {
    return debug.executionSummary.queueRuntimeAlignment.summary;
  }
  if (debug?.executionSummary.conservativeModeReason) {
    return `Runtime is progressing in conservative mode because ${debug.executionSummary.conservativeModeReason}.`;
  }
  return 'Runtime is actively progressing through the current unit.';
}

function buildNextAction(
  task: TaskQueryApiResponse,
  debug: TaskDebugResponse | null,
  progressState: TaskProgressState
): Pick<TaskProgressSummary, 'nextAction' | 'nextActionReason'> {
  const lifecycle = task.runtime.lifecycleStatus;
  const continueReason = sanitizeContinueReasonForDisplay(
    lifecycle,
    debug?.executionSummary.turnContract.continueReason
  )
    ?? (lifecycle === 'RUNNING'
      ? 'Task is running with no active correction requirement.'
      : `Task lifecycle is ${lifecycle}, so continue is not allowed.`);

  if (task.delegationSummary?.missingRequiredDelegation) {
    return {
      nextAction: 'Continue current thread',
      nextActionReason: 'Delegation is required before parent delivery can continue. Continue the current thread so the runtime can create the bounded child task.'
    };
  }

  if (task.delegationSummary?.activeChildTask) {
    return {
      nextAction: 'Wait',
      nextActionReason: `SubSccAgent is still working on "${task.delegationSummary.activeChildTask.title}" within the parent thread boundary.`
    };
  }

  if (progressState === 'awaiting_approval') {
    return {
      nextAction: 'Resolve approvals',
      nextActionReason: 'Approve or reject the blocked tool invocation before sending any continue message.'
    };
  }
  if (debug?.executionSummary.artifactPathState === 'unresolved') {
    return {
      nextAction: debug.executionSummary.recommendedArtifactDir ? 'Use recommended path' : 'Choose custom path',
      nextActionReason: debug.executionSummary.recommendedArtifactDir
        ? `Artifacts are ready in the task workspace. Use ${debug.executionSummary.recommendedArtifactDir} or choose a custom destination.`
        : 'Artifacts are ready in the task workspace, but a project-relative destination is still required.'
    };
  }
  if (progressState === 'non_convergent') {
    return {
      nextAction: lifecycle !== 'SUBMITTED' ? 'Restart task' : 'Inspect diagnostics',
      nextActionReason: 'Do not keep sending continue blindly. Inspect the correction failure category, then restart if runtime context should be rebuilt.'
    };
  }
  if (progressState === 'completed') {
    return {
      nextAction: 'Continue current thread',
      nextActionReason: 'The next message will keep working from the completed result in this same thread.'
    };
  }
  const capabilityWarning = debug?.executionSummary.capabilityWarnings.find((warning) => warning.hardBlocker)
    ?? debug?.executionSummary.capabilityWarnings[0];
  if (capabilityWarning) {
    if (capabilityWarning.code === 'provider-missing-secret') {
      return {
        nextAction: 'Configure provider secret',
        nextActionReason: capabilityWarning.message
      };
    }
    if (capabilityWarning.code === 'provider-unavailable') {
      return {
        nextAction: 'Repair provider runtime',
        nextActionReason: capabilityWarning.message
      };
    }
    if (capabilityWarning.code === 'required-mcp-missing' || capabilityWarning.code === 'instruction-skill-dependency-missing') {
      return {
        nextAction: 'Review MCP dependencies',
        nextActionReason: capabilityWarning.message
      };
    }
    if (capabilityWarning.code === 'runtime-skill-unavailable') {
      return {
        nextAction: 'Review skill runtime',
        nextActionReason: capabilityWarning.message
      };
    }
    if (capabilityWarning.code === 'permission-denied') {
      return {
        nextAction: 'Adjust permission policy',
        nextActionReason: capabilityWarning.message
      };
    }
    if (capabilityWarning.code === 'hook-failed') {
      return {
        nextAction: 'Inspect workspace hooks',
        nextActionReason: capabilityWarning.message
      };
    }
  }
  if (task.diagnostics.providerFailure) {
    return {
      nextAction: lifecycle === 'RUNNING' ? 'Continue current thread' : 'Restart task',
      nextActionReason: debug?.executionSummary.conservativeModeReason
        ? `${continueReason} Review the conservative mode reason before resuming normal iteration.`
        : continueReason
    };
  }
  if (progressState === 'paused') {
    return {
      nextAction: 'Resume task',
      nextActionReason: 'Resume continues from the current paused runtime state.'
    };
  }
  if (progressState === 'ready_to_start') {
    return {
      nextAction: 'Start task',
      nextActionReason: 'Ready to launch the first turn.'
    };
  }
  if (progressState === 'failed') {
    return {
      nextAction: 'Restart task',
      nextActionReason: 'Restart rebuilds execution from the current task definition.'
    };
  }
  if (debug?.executionSummary.turnContract.continueAllowed) {
    return {
      nextAction: 'Continue current thread',
      nextActionReason: continueReason
    };
  }
  return {
    nextAction: 'Wait',
    nextActionReason: debug?.executionSummary.issueSummary ?? 'Wait for the next runtime update, or open diagnostics if the thread appears stalled.'
  };
}

function buildFailureSummary(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): string | null {
  return task.diagnostics.providerFailure?.message
    ?? task.diagnostics.lastError
    ?? debug?.executionSummary.issueSummary
    ?? null;
}

function buildRecoverySummary(debug: TaskDebugResponse | null): string | null {
  if (!debug?.executionSummary.recovery.recoveredAfterRestart) {
    return null;
  }
  const recovery = debug.executionSummary.recovery;
  const parts = [
    recovery.recoveryReason ? `Recovered via ${recovery.recoveryReason}` : 'Recovered after restart',
    recovery.previousQueueState ? `from queue ${recovery.previousQueueState}` : null,
    recovery.recoveredBy ? `by ${recovery.recoveredBy}` : null
  ].filter((value): value is string => Boolean(value));
  return parts.join(', ');
}

export function deriveTaskProgressSummary(task: TaskQueryApiResponse, debug: TaskDebugResponse | null): TaskProgressSummary {
  const progressState = getProgressState(task, debug);
  const nextAction = buildNextAction(task, debug, progressState);
  const statusSummary = getStatusSummary(task);
  const primaryAction = getPrimaryAction(task, debug);
  const nextActionSummary = getNextActionSummary(task, primaryAction);

  return {
    progressState,
    statusLabel: statusSummary.label ?? getStatusLabel(progressState),
    stageLabel: getStageLabel(task, debug),
    currentUnitId: task.runtime.currentUnitId,
    blockingReason: statusSummary.detail ?? buildBlockingReason(task, debug, progressState),
    nextAction: nextActionSummary.label,
    nextActionReason: nextActionSummary.reason ?? nextAction.nextActionReason,
    approvalCount: task.pendingApprovals.length,
    failureSummary: buildFailureSummary(task, debug),
    recoverySummary: buildRecoverySummary(debug),
    artifactPathState: debug?.executionSummary.artifactPathState ?? 'sandbox_only',
    pendingArtifactCount: debug?.executionSummary.pendingArtifactCount ?? 0,
    selectedArtifactDir: debug?.executionSummary.selectedArtifactDir ?? null,
    recommendedArtifactDir: debug?.executionSummary.recommendedArtifactDir ?? null,
    artifactPaths: debug?.executionSummary.artifactPaths ?? [],
    lastArtifactApplyAt: debug?.executionSummary.lastArtifactApplyAt ?? null,
    lastArtifactApplyResult: debug?.executionSummary.lastArtifactApplyResult ?? null,
    correctionDepth: debug?.executionSummary.correctionDepth ?? 0,
    providerFailureStreak: debug?.executionSummary.providerFailureStreak ?? 0,
    skillFailureStreak: debug?.executionSummary.skillFailureStreak ?? 0,
    mcpFailureStreak: debug?.executionSummary.mcpFailureStreak ?? 0,
    issuePlane: debug?.executionSummary.issuePlane ?? null,
    issueCategory: debug?.executionSummary.issueCategory ?? null,
    issueSummary: debug?.executionSummary.issueSummary ?? null,
    suggestedAction: debug?.executionSummary.suggestedAction ?? null,
    lastSafeCheckpointAt: debug?.executionSummary.lastSafeCheckpointAt ?? null,
    lastRecoverySource: debug?.executionSummary.lastRecoverySource ?? null,
    conservativeModeReason: debug?.executionSummary.conservativeModeReason ?? null,
    providerSummary: debug?.executionSummary.providerSummary ?? null,
    instructionSkillSummary: debug?.executionSummary.instructionSkillSummary ?? null,
    experienceSummary: debug?.executionSummary.experienceSummary ?? null,
    skillSummary: debug?.executionSummary.skillSummary ?? null,
    mcpSummary: debug?.executionSummary.mcpSummary ?? null,
    permissionSummary: debug?.executionSummary.permissionSummary ?? null,
    capabilityWarnings: debug?.executionSummary.capabilityWarnings ?? null
  };
}

export async function requestTaskDebug(fetchImpl: FetchLike, serverUrl: string, taskId: string): Promise<TaskDebugResponse> {
  return requestJson<TaskDebugResponse>(fetchImpl, `${serverUrl}/tasks/${taskId}/debug`, { method: 'GET', headers: {} });
}

export function formatTailLine(envelope: CliEventEnvelope): string {
  const summaryRecord = envelope.taskSummary && typeof envelope.taskSummary === 'object' && !Array.isArray(envelope.taskSummary)
    ? envelope.taskSummary as Record<string, unknown>
    : null;
  const pendingApprovalItems = Array.isArray(summaryRecord?.pendingApprovalItems)
    ? summaryRecord.pendingApprovalItems.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const visibleToolActivities = Array.isArray(summaryRecord?.visibleToolActivities)
    ? summaryRecord.visibleToolActivities.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const completionSummary = summaryRecord?.completionSummary && typeof summaryRecord.completionSummary === 'object' && !Array.isArray(summaryRecord.completionSummary)
    ? summaryRecord.completionSummary as Record<string, unknown>
    : null;
  const deliveredPaths = Array.isArray(completionSummary?.artifactDestinationPaths)
    ? completionSummary.artifactDestinationPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  if (envelope.summary) {
    const summary = envelope.summary;
    const taskFragment = envelope.taskId ?? summary.currentUnitId ?? '';
    const statusFragment = summary.statusLabel ? `status=${summary.statusLabel}` : `state=${summary.progressState}`;
    if (envelope.kind === 'task_snapshot') {
      const approvalFragment = pendingApprovalItems[0]
        ? (() => {
          const toolName = typeof pendingApprovalItems[0].toolName === 'string' ? pendingApprovalItems[0].toolName : 'tool';
          const invocationId = typeof pendingApprovalItems[0].invocationId === 'string' ? pendingApprovalItems[0].invocationId : 'unknown';
          return `approval=${toolName}(${invocationId})`;
        })()
        : null;
      const toolFragment = !approvalFragment && visibleToolActivities[0]
        ? (() => {
          const activity = visibleToolActivities[0];
          const toolId = typeof activity.toolId === 'string' ? activity.toolId : 'tool';
          const toolStatus = typeof activity.status === 'string' ? activity.status : 'unknown';
          return `tool=${toolId}[${toolStatus}]`;
        })()
        : null;
      const deliveryFragment = !approvalFragment && !toolFragment && deliveredPaths[0]
        ? `delivered=${deliveredPaths[0]}`
        : null;
      const liveFragment = approvalFragment ?? toolFragment ?? deliveryFragment;
      return `[${envelope.source}] task_snapshot${taskFragment ? ` ${taskFragment}` : ''} | ${statusFragment} | ${summary.blockingReason} | next=${summary.nextAction}${liveFragment ? ` | ${liveFragment}` : ''}`;
    }
    if (envelope.kind === 'runtime_event') {
      const record = envelope.data as { type?: string; taskId?: string } | undefined;
      return `[${envelope.source}] ${record?.type ?? envelope.event ?? 'runtime_event'}${taskFragment ? ` ${taskFragment}` : ''} | ${statusFragment} | ${summary.blockingReason} | next=${summary.nextAction}`;
    }
    if (envelope.kind === 'ready' || envelope.kind === 'subscribed' || envelope.kind === 'unsubscribed') {
      return `[${envelope.source}] ${envelope.kind}${envelope.taskId ? ` ${envelope.taskId}` : ''} | ${statusFragment} | next=${summary.nextAction}`;
    }
  }
  if (envelope.kind === 'error') {
    return `[${envelope.source}] error ${envelope.code ?? 'unknown'}: ${envelope.error ?? 'Unknown error'}`;
  }
  if (envelope.kind === 'heartbeat') {
    return `[${envelope.source}] heartbeat ${envelope.timestamp ?? ''}`.trim();
  }
  if (envelope.kind === 'ready' || envelope.kind === 'subscribed' || envelope.kind === 'unsubscribed') {
    return `[${envelope.source}] ${envelope.kind}${envelope.taskId ? ` ${envelope.taskId}` : ''}`;
  }
  const record = envelope.data as { type?: string; taskId?: string } | undefined;
  return `[${envelope.source}] ${record?.type ?? envelope.event ?? 'runtime_event'}${record?.taskId ? ` ${record.taskId}` : ''}`;
}

function isTerminalEvent(record: { type?: string } | undefined | null): boolean {
  return Boolean(record?.type && TERMINAL_EVENTS.has(record.type));
}

function toStreamEnvelope(source: CliEventEnvelope['source'], envelope: RuntimeWebSocketEnvelope): CliEventEnvelope {
  return {
    kind: envelope.kind,
    source,
    taskId: envelope.taskId,
    event: envelope.event,
    data: envelope.data,
    task: envelope.task ?? null,
    error: envelope.error,
    code: envelope.code,
    latestEventId: envelope.latestEventId ?? null,
    timestamp: envelope.timestamp
  };
}

function toCliEventFromRecord(source: CliEventEnvelope['source'], record: RuntimeEventStreamEnvelope | TaskEventsQueryResponse[number]): CliEventEnvelope {
  const runtimeEvent = 'data' in record ? record.data : record;
  return {
    kind: 'runtime_event',
    source,
    taskId: runtimeEvent.taskId,
    event: runtimeEvent.type,
    data: runtimeEvent,
    latestEventId: runtimeEvent.eventId
  };
}

function summarizeSnapshotTask(task: TaskQueryApiResponse): TaskProgressSummary {
  return deriveTaskProgressSummary(task, null);
}

async function consumeViaWebSocket(options: {
  taskId: string;
  wsUrl: string;
  afterEventId?: string;
  fetchImpl: FetchLike;
  serverUrl: string;
  io: CliIo;
  mode: 'watch' | 'stream' | 'tail';
  createWebSocket: CreateWebSocket;
}): Promise<string | null> {
  const { taskId, wsUrl, afterEventId, fetchImpl, serverUrl, io, mode, createWebSocket } = options;
  return new Promise((resolve, reject) => {
    let latestEventId = afterEventId ?? null;
    let terminalSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const clearTerminalSnapshotTimer = () => {
      if (terminalSnapshotTimer) {
        clearTimeout(terminalSnapshotTimer);
        terminalSnapshotTimer = null;
      }
    };
    const closeAndResolve = (value: string | null) => {
      if (settled) return;
      clearTerminalSnapshotTimer();
      settled = true;
      resolve(value);
    };
    const closeAndReject = (error: Error) => {
      if (settled) return;
      clearTerminalSnapshotTimer();
      settled = true;
      reject(error);
    };
    const socket = createWebSocket(wsUrl);
    socket.on('open', () => {
      const message: RuntimeWebSocketClientMessage = { type: 'subscribe', taskId, replay: true, afterEventId };
      socket.send(JSON.stringify(message));
    });
    socket.on('message', (raw) => {
      void (async () => {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const envelope = JSON.parse(text) as RuntimeWebSocketEnvelope;
      const streamEnvelope = toStreamEnvelope('ws', envelope);
      if (streamEnvelope.latestEventId) {
        latestEventId = streamEnvelope.latestEventId;
      }
      if (streamEnvelope.kind === 'task_snapshot' && streamEnvelope.task) {
        streamEnvelope.summary = summarizeSnapshotTask(streamEnvelope.task);
        streamEnvelope.taskSummary = summarizeTask(streamEnvelope.task);
        const lifecycleStatus = streamEnvelope.task.runtime?.lifecycleStatus;
        if (lifecycleStatus === 'COMPLETED' || lifecycleStatus === 'FAILED' || lifecycleStatus === 'CANCELLED') {
          if (mode === 'stream') {
            writeJsonLine(io, streamEnvelope);
          } else {
            io.stdout.write(`${formatTailLine(streamEnvelope)}\n`);
          }
          socket.close();
          closeAndResolve(latestEventId);
          return;
        }
      } else if (streamEnvelope.taskId && (streamEnvelope.kind === 'runtime_event' || streamEnvelope.kind === 'subscribed' || streamEnvelope.kind === 'ready')) {
        streamEnvelope.summary = await attachTaskSummary(fetchImpl, serverUrl, streamEnvelope.taskId);
      }
      if (mode === 'stream') {
        writeJsonLine(io, streamEnvelope);
      } else if (mode === 'tail') {
        io.stdout.write(`${formatTailLine(streamEnvelope)}\n`);
      } else if (mode === 'watch') {
        if (streamEnvelope.kind === 'runtime_event' || streamEnvelope.kind === 'task_snapshot') {
          io.stdout.write(`${formatTailLine(streamEnvelope)}\n`);
        } else if (streamEnvelope.kind === 'error') {
          io.stderr.write(`${formatTailLine(streamEnvelope)}\n`);
        }
      }
      if (streamEnvelope.kind === 'error') {
        socket.close();
        closeAndReject(new Error(streamEnvelope.error ?? 'WebSocket stream failed.'));
        return;
      }
      if (streamEnvelope.kind === 'runtime_event' && isTerminalEvent(streamEnvelope.data as { type?: string })) {
        clearTerminalSnapshotTimer();
        terminalSnapshotTimer = setTimeout(() => {
          socket.close();
          closeAndResolve(latestEventId);
        }, 250);
      }
      })().catch((error) => {
        socket.close();
        closeAndReject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    socket.on('close', () => closeAndResolve(latestEventId));
    socket.on('error', closeAndReject);
  });
}

async function consumeViaSse(options: {
  taskId: string;
  fetchImpl: FetchLike;
  serverUrl: string;
  afterEventId?: string;
  io: CliIo;
  mode: 'watch' | 'stream' | 'tail';
}): Promise<string | null> {
  const { taskId, fetchImpl, serverUrl, afterEventId, io, mode } = options;
  const url = new URL(`/tasks/${taskId}/events/stream`, serverUrl);
  if (afterEventId) {
    url.searchParams.set('afterEventId', afterEventId);
  }
  const response = await fetchImpl(url.toString());
  if (!response.ok || !response.body) {
    throw new Error(`SSE fallback failed with status ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latestEventId = afterEventId ?? null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const chunk = buffer.slice(0, separatorIndex).trim();
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf('\n\n');
      if (!chunk) continue;
      const lines = chunk.split('\n');
      let id = '';
      let event = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data) as TaskEventsQueryResponse[number];
      latestEventId = id || parsed.eventId;
      const envelope = toCliEventFromRecord('sse', parsed);
      envelope.event = event || envelope.event;
      envelope.latestEventId = latestEventId;
      envelope.summary = await attachTaskSummary(fetchImpl, serverUrl, taskId);
      if (mode === 'stream') {
        writeJsonLine(io, envelope);
      } else {
        io.stdout.write(`${formatTailLine(envelope)}\n`);
      }
      if (isTerminalEvent(parsed)) {
        return latestEventId;
      }
    }
  }
  return latestEventId;
}

async function consumeViaPolling(options: {
  taskId: string;
  fetchImpl: FetchLike;
  serverUrl: string;
  afterEventId?: string;
  io: CliIo;
  mode: 'watch' | 'stream' | 'tail';
  sleep: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const { taskId, fetchImpl, serverUrl, afterEventId, io, mode, sleep } = options;
  let latestEventId = afterEventId ?? null;
  while (true) {
    const url = new URL(`/tasks/${taskId}/events`, serverUrl);
    if (latestEventId) {
      url.searchParams.set('afterEventId', latestEventId);
    }
    const events = await requestJson<TaskEventsQueryResponse>(fetchImpl, url.toString(), { method: 'GET', headers: {} });
    for (const record of events) {
      latestEventId = record.eventId;
      const envelope = toCliEventFromRecord('poll', record);
      envelope.summary = await attachTaskSummary(fetchImpl, serverUrl, taskId);
      if (mode === 'stream') {
        writeJsonLine(io, envelope);
      } else {
        io.stdout.write(`${formatTailLine(envelope)}\n`);
      }
      if (isTerminalEvent(record)) {
        return latestEventId;
      }
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
}

async function attachTaskSummary(
  fetchImpl: FetchLike,
  serverUrl: string,
  taskId: string
): Promise<TaskProgressSummary | null> {
  try {
    const debug = await requestTaskDebug(fetchImpl, serverUrl, taskId);
    return deriveTaskProgressSummary(debug.task, debug);
  } catch {
    try {
      const task = await requestJson<TaskQueryApiResponse>(fetchImpl, `${serverUrl}/tasks/${taskId}`, { method: 'GET', headers: {} });
      return deriveTaskProgressSummary(task, null);
    } catch {
      return null;
    }
  }
}

export async function runTaskFlowStream(options: {
  taskId: string;
  context: CliRuntimeContext;
  mode: 'watch' | 'stream' | 'tail';
}): Promise<void> {
  const { taskId, context, mode } = options;
  let afterEventId = getAfterEventId(context.args);
  if (mode === 'watch') {
    const task = await requestJson<TaskQueryApiResponse>(context.fetchImpl, `${context.serverUrl}/tasks/${taskId}`, { method: 'GET', headers: {} });
    let debug: TaskDebugResponse | null = null;
    try {
      debug = await requestTaskDebug(context.fetchImpl, context.serverUrl, taskId);
    } catch {
      debug = null;
    }
    context.io.stdout.write(`${JSON.stringify(summarizeTask(task, debug), null, 2)}\n`);
    const latestEvent = task.events.at(-1);
    if (!afterEventId && latestEvent?.eventId) {
      afterEventId = latestEvent.eventId;
    }
  }

  try {
    await consumeViaWebSocket({
      taskId,
      wsUrl: `${getWebSocketUrl(context.serverUrl, context.args)}?taskId=${encodeURIComponent(taskId)}&replay=true${afterEventId ? `&afterEventId=${encodeURIComponent(afterEventId)}` : ''}`,
      afterEventId,
      fetchImpl: context.fetchImpl,
      serverUrl: context.serverUrl,
      io: context.io,
      mode,
      createWebSocket: context.createWebSocket
    });
    return;
  } catch (error) {
    context.io.stderr.write(`${JSON.stringify({ transport: 'ws', error: error instanceof Error ? error.message : String(error) })}\n`);
  }

  try {
    await consumeViaSse({
      taskId,
      fetchImpl: context.fetchImpl,
      serverUrl: context.serverUrl,
      afterEventId,
      io: context.io,
      mode
    });
    return;
  } catch (error) {
    context.io.stderr.write(`${JSON.stringify({ transport: 'sse', error: error instanceof Error ? error.message : String(error) })}\n`);
  }

  await consumeViaPolling({
    taskId,
    fetchImpl: context.fetchImpl,
    serverUrl: context.serverUrl,
    afterEventId,
    io: context.io,
    mode,
    sleep: context.sleep
  });
}

export function baseUsage(): string[] {
  return [
    'health [--server <url>]',
    'ready [--server <url>]',
    'memory profile [--server <url>]'
  ];
}

export type {
  HealthResponse,
  QueueActiveResponse,
  QueueDeadLetterResponse,
  QueueRecoverExpiredResponse,
  QueueRequeueResponse,
  ReadinessResponse,
  TaskCommandRequest,
  TaskCommandsQueryResponse,
  TaskDebugResponse,
  TaskEventsQueryResponse,
  TaskListApiResponse,
  TaskOperatorMessagesQueryResponse,
  TaskQueryApiResponse
};
