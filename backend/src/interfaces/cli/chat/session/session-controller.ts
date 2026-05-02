import fs from 'node:fs';
import {
  CliRuntimeContext,
  getFlagString,
  ParsedCliArgs,
  requestTaskDebug,
  requestJson,
  resolveTaskSubmitPayload,
  submitTaskPayload,
  TaskCommandRequest,
  TaskDebugResponse,
  TaskEventsQueryResponse,
  TaskListApiResponse,
  TaskQueryApiResponse
} from '../../shared';
import {
  ChatOutputFormat,
  CliRecentTaskItem,
  CliViewMode,
  CliTranscriptEntry,
  WorkspaceChatEnvelope,
  WorkspaceChatSessionState,
  formatEventLine
} from '../protocol/chat-envelopes';
import {
  buildInspectorSnapshot,
  projectPendingApprovals,
  projectTaskDiagnostics,
  projectTaskSummary
} from '../protocol/diagnostics-projection';
import { ExecutionProfileId } from '../../../../domain/contracts/types';

interface CliChatSessionControllerOptions {
  mode: 'workspace' | 'task';
  context: CliRuntimeContext;
  args: ParsedCliArgs;
  outputFormat: ChatOutputFormat;
  onEnvelope?: (envelope: WorkspaceChatEnvelope) => void;
}

type HandleInputResult = 'continue' | 'exit';

interface CliWorkspaceCommandDefinition {
  name: string;
  description: string | null;
  args: string | null;
  when: string | null;
  template?: string;
}

interface CliWorkspaceWorkflowStatus {
  workspaceRoot: string | null;
  projectInstructionsPresent: boolean;
  projectInstructionsSummary?: string | null;
  commands: CliWorkspaceCommandDefinition[];
  rules: Array<{ name: string; pathScope?: string | null }>;
  hooks: Array<{ event: string; command: string }>;
  agents: Array<{ name: string; description?: string | null }>;
  docsSources: Array<{ path: string }>;
  docsImportSummary: {
    trackedSourceCount: number;
    importedMemoryCount: number;
  };
  ruleSummary?: {
    total: number;
    pathScoped: number;
    alwaysOn: number;
  };
  hookSummary?: {
    total: number;
    events: string[];
  };
}

const RESERVED_WORKSPACE_COMMANDS = new Set([
  'help',
  'tasks',
  'switch',
  'new',
  'focus',
  'raw',
  'clear',
  'task',
  'status',
  'events',
  'diagnostics',
  'start',
  'continue',
  'pause',
  'resume',
  'restart',
  'message',
  'send',
  'approve',
  'reject',
  'interrupt',
  'cancel',
  'commands',
  'provider',
  'model',
  'permissions',
  'skills',
  'mcp',
  'agent',
  'improvements',
  'proposal',
  'path',
  'artifacts',
  'apply',
  'compact',
  'cost',
  'exit',
  'quit'
]);

function deriveInteractiveTitle(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Interactive Task';
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

function isExecutionProfileId(value: string | undefined): value is ExecutionProfileId {
  return value === 'analyze' || value === 'implement' || value === 'verify';
}

function inferInteractiveExecutionProfileId(params: {
  args: ParsedCliArgs;
}): ExecutionProfileId {
  const explicit = getFlagString(params.args, 'execution-profile');
  if (isExecutionProfileId(explicit)) {
    return explicit;
  }
  return 'analyze';
}

function buildInteractivePayload(message: string, args: ParsedCliArgs, metadata?: Record<string, unknown>) {
  const intent = getFlagString(args, 'intent')?.trim() || message.trim();
  const title = getFlagString(args, 'title')?.trim() || deriveInteractiveTitle(intent);
  const preferredProviderId = getFlagString(args, 'provider') ?? null;
  const goal = getFlagString(args, 'goal') ?? intent;
  return {
    taskId: getFlagString(args, 'task-id'),
    title,
    intent,
    preferredProviderId,
    pathPolicy: (getFlagString(args, 'path-policy') as 'task_workspace' | 'project_relative' | 'ask_if_unclear' | undefined) ?? undefined,
    preferredArtifactDir: getFlagString(args, 'output-dir') ?? null,
    workingDirectory: getFlagString(args, 'working-dir') ?? getFlagString(args, 'workdir') ?? null,
    metadata,
    units: [
      {
        id: getFlagString(args, 'unit-id') ?? 'AGENT-001',
        role: getFlagString(args, 'role') ?? 'Operator',
        goal,
        outputContract: getFlagString(args, 'output-contract') ?? '{"summary":"string","details":"string"}',
        executionProfileId: inferInteractiveExecutionProfileId({
          args
        }),
        dependencies: []
      }
    ]
  };
}

function toRecentTaskItemFromTask(task: TaskQueryApiResponse, activeTaskId: string | null, recentTaskIds: string[]): CliRecentTaskItem {
  const summary = projectTaskSummary(task);
  const taskId = String(summary.taskId ?? task.definition.taskId);
  return {
    taskId,
    title: String(summary.title ?? task.definition.title ?? taskId),
    lifecycleStatus: String(summary.lifecycleStatus ?? task.runtime.lifecycleStatus),
    currentUnitId: typeof summary.currentUnitId === 'string' ? summary.currentUnitId : task.runtime.currentUnitId ?? null,
    updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : task.runtime.updatedAt ?? task.definition.createdAt ?? Date.now(),
    pendingApprovalCount: typeof summary.pendingApprovalCount === 'number' ? summary.pendingApprovalCount : task.pendingApprovals.length,
    isActive: taskId === activeTaskId,
    isRecent: recentTaskIds.includes(taskId)
  };
}

function toRecentTaskItemFromSummary(summary: TaskListApiResponse[number], activeTaskId: string | null, recentTaskIds: string[]): CliRecentTaskItem {
  return {
    taskId: summary.taskId,
    title: summary.title,
    lifecycleStatus: summary.lifecycleStatus,
    currentUnitId: summary.currentUnitId,
    updatedAt: summary.updatedAt,
    pendingApprovalCount: summary.pendingApprovalCount,
    isActive: summary.taskId === activeTaskId,
    isRecent: recentTaskIds.includes(summary.taskId)
  };
}

function sortRecentTaskItems(items: CliRecentTaskItem[], activeTaskId: string | null, recentTaskIds: string[]): CliRecentTaskItem[] {
  const recentOrder = new Map(recentTaskIds.map((taskId, index) => [taskId, index]));
  return [...items].sort((left, right) => {
    const leftActive = left.taskId === activeTaskId ? 1 : 0;
    const rightActive = right.taskId === activeTaskId ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    const leftRecent = recentOrder.has(left.taskId);
    const rightRecent = recentOrder.has(right.taskId);
    if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;
    if (leftRecent && rightRecent) {
      return (recentOrder.get(left.taskId) ?? 0) - (recentOrder.get(right.taskId) ?? 0);
    }
    return right.updatedAt - left.updatedAt;
  });
}

function summarizeMemorySelection(summary: Record<string, unknown> | null | undefined): string[] {
  if (!summary || typeof summary !== 'object') return [];
  const shared = typeof summary.sharedCount === 'number' ? summary.sharedCount : null;
  const privateCount = typeof summary.privateCount === 'number' ? summary.privateCount : null;
  const protectedCount = typeof summary.protectedCount === 'number' ? summary.protectedCount : null;
  const summarizedCount = typeof summary.summarizedCount === 'number' ? summary.summarizedCount : null;
  const omittedCount = typeof summary.omittedCount === 'number' ? summary.omittedCount : null;
  return [
    shared !== null ? `shared=${shared}` : null,
    privateCount !== null ? `private=${privateCount}` : null,
    protectedCount !== null ? `protected=${protectedCount}` : null,
    summarizedCount !== null ? `summarized=${summarizedCount}` : null,
    omittedCount !== null ? `omitted=${omittedCount}` : null
  ].filter((value): value is string => Boolean(value));
}

function isHumanDisplaySafeSummary(value: string | null): value is string {
  const text = value?.trim() ?? '';
  if (!text) {
    return false;
  }
  return !(
    text.includes('[/')
    || /\[(?:[A-Z0-9_-]+)_OUTPUT\]/.test(text)
    || /"tool(?:_name)?"\s*:/.test(text)
    || /"current_unit"\s*:/.test(text)
    || /"arguments"\s*:/.test(text)
  );
}

function buildSummaryHintLines(summary: Record<string, unknown> | null): string[] {
  if (!summary) {
    return ['Current status: no task attached', 'Suggested action: Enter a prompt or use /switch <taskId>.'];
  }
  const statusSummary = getRecord(summary.statusSummary);
  const stageLabel = typeof summary.stageLabel === 'string' ? summary.stageLabel : 'Stage not started';
  const primaryAction = getRecord(summary.primaryAction);
  const nextAction = getRecord(summary.nextActionSummary);
  const completionSummary = getRecord(summary.completionSummary);
  const resultSummary = getString(completionSummary?.summary);
  const artifactDestinationPaths = getStringArray(completionSummary?.artifactDestinationPaths);
  const artifactDestinationDir = getString(completionSummary?.artifactDestinationDir);
  const visibleToolActivities = getRecordArray(summary.visibleToolActivities);
  const lines = [
    `Current status: ${getString(statusSummary?.label) ?? 'Task truth unavailable'} (${stageLabel})`,
    `Archive state: ${summary.isArchived === true ? 'archived task' : 'active task'}`,
    `Blocking reason: ${getString(statusSummary?.detail) ?? 'Task query is missing statusSummary.'}`,
    `Primary action: ${getString(primaryAction?.label) ?? getString(nextAction?.label) ?? 'Task truth unavailable'} - ${getString(primaryAction?.description) ?? getString(nextAction?.reason) ?? 'Task query is missing nextActionSummary.'}`
  ];
  if (isHumanDisplaySafeSummary(resultSummary)) {
    lines.push(`Recent result: ${resultSummary}`);
  }
  if (artifactDestinationPaths.length > 0) {
    lines.push(`Delivered to: ${artifactDestinationPaths.join(', ')}`);
  } else if (artifactDestinationDir) {
    lines.push(`Destination folder: ${artifactDestinationDir}`);
  }
  if (visibleToolActivities.length > 0) {
    const recent = visibleToolActivities.slice(-2).map((activity) => {
      const toolId = getString(activity.toolId) ?? 'tool';
      const status = getString(activity.status) ?? 'unknown';
      const toolSummary = getString(activity.summary) ?? 'No summary';
      return `${toolId} [${status}] ${toolSummary}`;
    });
    lines.push(`Recent tools: ${recent.join(' | ')}`);
  }
  const archiveActions = getRecord(summary.archiveActions);
  const availableArchiveActions = getStringArray(archiveActions?.available);
  if (availableArchiveActions.length > 0) {
    lines.push(`Task actions: ${availableArchiveActions.join(', ')} (terminal tasks only)`);
  }
  return lines;
}

function buildArtifactHintLines(summary: Record<string, unknown> | null): string[] {
  if (!summary) {
    return ['Artifact path state: no task attached', 'Suggested action: Attach a task before inspecting artifact routing.'];
  }
  const artifactPathState = getString(summary.artifactPathState) ?? 'sandbox_only';
  const selectedArtifactDir = getString(summary.selectedArtifactDir);
  const recommendedArtifactDir = getString(summary.recommendedArtifactDir);
  const pendingArtifactCount = getNumber(summary.pendingArtifactCount) ?? 0;
  const lastArtifactApplyResult = getRecord(summary.lastArtifactApplyResult);
  const lastArtifactApplyStatus = getString(lastArtifactApplyResult?.status) ?? 'none';
  const lastArtifactApplyMessage = getString(lastArtifactApplyResult?.message);
  const completionSummary = getRecord(summary.completionSummary);
  const deliveredPaths = getStringArray(completionSummary?.artifactDestinationPaths);
  const primaryAction = getRecord(summary.primaryAction);
  const deliveredSummary = deliveredPaths.join(', ') || getString(completionSummary?.artifactDestinationDir) || 'not delivered yet';
  return [
    `Artifact path state: ${artifactPathState}`,
    `Pending artifacts: ${pendingArtifactCount}`,
    `Selected destination: ${selectedArtifactDir ?? 'not selected'}`,
    `Recommended destination: ${recommendedArtifactDir ?? 'none'}`,
    `Delivered to: ${deliveredSummary}`,
    `Primary action: ${getString(primaryAction?.label) ?? 'Task truth unavailable'}`,
    `Last apply result: ${lastArtifactApplyStatus}${lastArtifactApplyMessage ? ` - ${lastArtifactApplyMessage}` : ''}`
  ];
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function getRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

export function resolveChatFormat(args: ParsedCliArgs, stdin: NodeJS.ReadableStream, mode: 'workspace' | 'task'): ChatOutputFormat {
  const explicit = getFlagString(args, 'format');
  if (explicit === 'ndjson') return 'ndjson';
  if (explicit === 'human') return 'human';
  if ((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY && mode === 'workspace') {
    return 'human';
  }
  return (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY ? 'human' : 'ndjson';
}

export function normalizeSeedArg(seed: string | undefined): { kind: 'taskId'; value: string } | { kind: 'file'; value: string } | null {
  if (!seed) return null;
  if (fs.existsSync(seed)) {
    return { kind: 'file', value: seed };
  }
  return { kind: 'taskId', value: seed };
}

export class CliChatSessionController {
  readonly state: WorkspaceChatSessionState;

  private readonly mode: 'workspace' | 'task';
  private readonly context: CliRuntimeContext;
  private readonly args: ParsedCliArgs;
  private readonly outputFormat: ChatOutputFormat;
  private readonly onEnvelope?: (envelope: WorkspaceChatEnvelope) => void;

  constructor(options: CliChatSessionControllerOptions) {
    this.mode = options.mode;
    this.context = options.context;
    this.args = options.args;
    this.outputFormat = options.outputFormat;
    this.onEnvelope = options.onEnvelope;
    this.state = {
      mode: options.mode,
      activeTaskId: null,
      recentTaskIds: [],
      recentTasks: [],
      inputDraft: '',
      viewMode: 'summary',
      eventCursorByTaskId: {},
      recentEvents: [],
      latestTaskSummary: null,
      latestDiagnostics: null,
      latestApprovals: [],
      selectedApprovalIndex: 0,
      transcript: [],
      lastViewPayload: null
    };
  }

  getInspectorSnapshot() {
    return buildInspectorSnapshot(this.state);
  }

  getPrompt(): string {
    return this.state.activeTaskId ? `backend_new(${this.state.activeTaskId})> ` : 'backend_new> ';
  }

  async initialize(seed: { taskId?: string | null; filePath?: string | null } = {}): Promise<void> {
    const explicitTask = getFlagString(this.args, 'task');
    const taskId = explicitTask ?? seed.taskId ?? null;
    const filePath = seed.filePath ?? null;

    if (taskId) {
      await this.attachTask(taskId, 'Attached to existing task');
      return;
    }

    if (filePath || getFlagString(this.args, 'title') || getFlagString(this.args, 'intent')) {
      const payload = resolveTaskSubmitPayload(filePath ? [filePath] : [], this.args);
      const submitted = await submitTaskPayload(this.context.fetchImpl, this.context.serverUrl, payload);
      await this.attachTask(submitted.command.taskId, 'Interactive task created from submitted definition', 'created');
      return;
    }

    this.updateRawViewPayload();
    this.emitInfo('Enter a prompt to create a task, or use /switch <taskId>. Use /help for commands.');
  }

  async refreshActiveTask(): Promise<void> {
    if (!this.state.activeTaskId) {
      this.updateRawViewPayload();
      return;
    }
    const debug = await this.fetchTaskDebug(this.state.activeTaskId);
    const task = debug.task;
    this.updateTaskState(task, debug);
    this.emit({
      type: 'task',
      task: this.state.latestTaskSummary ?? projectTaskSummary(task, debug)
    });
    this.emit({
      type: 'approvals',
      taskId: task.definition.taskId,
      count: task.pendingApprovals.length,
      approvals: this.state.latestApprovals
    });
  }

  async pollActiveEvents(quietRounds = 1): Promise<void> {
    const taskId = this.state.activeTaskId;
    if (!taskId) return;
    let idleRounds = 0;
    while (idleRounds <= quietRounds) {
      const url = new URL(`/tasks/${taskId}/events`, this.context.serverUrl);
      const cursor = this.state.eventCursorByTaskId[taskId];
      if (cursor) {
        url.searchParams.set('afterEventId', cursor);
      }
      const events = await requestJson<TaskEventsQueryResponse>(this.context.fetchImpl, url.toString(), { method: 'GET', headers: {} });
      if (events.length === 0) {
        idleRounds += 1;
        if (idleRounds <= quietRounds) {
          await this.context.sleep(150);
        }
        continue;
      }
      idleRounds = 0;
      for (const event of events) {
        this.state.eventCursorByTaskId[taskId] = event.eventId;
        this.state.recentEvents = [...this.state.recentEvents, event].slice(-50);
        this.pushTranscript('event', formatEventLine(event));
        this.emit({ type: 'event', record: event });
      }
      const debug = await this.fetchTaskDebug(taskId);
      this.updateTaskState(debug.task, debug);
      if (debug.task.runtime.lifecycleStatus !== 'RUNNING') {
        break;
      }
    }
  }

  async handleInput(line: string): Promise<HandleInputResult> {
    this.state.inputDraft = '';
    if (line.startsWith('/')) {
      return this.handleSlashCommand(line);
    }
    await this.handlePlainMessage(line);
    return 'continue';
  }

  async setViewMode(mode: CliViewMode): Promise<void> {
    this.state.viewMode = mode;
    if (mode === 'tasks') {
      await this.emitTaskListView();
      return;
    }
    if (mode === 'capabilities') {
      const hub = await this.fetchCapabilityHub();
      const activeTask = getRecord(this.state.latestTaskSummary);
      this.state.lastViewPayload = {
        mode: 'capabilities',
        activeTaskId: this.state.activeTaskId,
        providerSummary: getRecord(activeTask?.providerSummary),
        skillSummary: getRecord(activeTask?.skillSummary),
        instructionSkillSummary: getRecord(activeTask?.instructionSkillSummary),
        mcpSummary: getRecord(activeTask?.mcpSummary),
        permissionSummary: getRecord(activeTask?.permissionSummary),
        agentSummary: getRecord(activeTask?.agentSummary),
        hookSummary: getRecord(activeTask?.hookSummary),
        warnings: Array.isArray(activeTask?.capabilityWarnings) ? activeTask.capabilityWarnings : [],
        capabilityHub: hub
      };
      this.emit({
        type: 'view',
        view: 'capabilities',
        data: this.state.lastViewPayload
      });
      return;
    }
    if (mode === 'raw') {
      this.updateRawViewPayload();
      this.emit({
        type: 'view',
        view: 'raw',
        data: this.state.lastViewPayload
      });
      return;
    }
    this.state.lastViewPayload = { mode };
    this.emit({
      type: 'view',
      view: 'focus',
      data: { mode }
    });
  }

  clearTranscript(): void {
    this.state.transcript = [];
    this.state.recentEvents = [];
    this.state.lastViewPayload = { cleared: true };
    this.emit({
      type: 'view',
      view: 'clear',
      data: { cleared: true }
    });
  }

  selectNextApproval(): void {
    if (this.state.latestApprovals.length === 0) {
      this.state.selectedApprovalIndex = 0;
      return;
    }
    this.state.selectedApprovalIndex = (this.state.selectedApprovalIndex + 1) % this.state.latestApprovals.length;
    this.updateRawViewPayload();
  }

  selectPreviousApproval(): void {
    if (this.state.latestApprovals.length === 0) {
      this.state.selectedApprovalIndex = 0;
      return;
    }
    const count = this.state.latestApprovals.length;
    this.state.selectedApprovalIndex = (this.state.selectedApprovalIndex - 1 + count) % count;
    this.updateRawViewPayload();
  }

  getSelectedApproval(): Record<string, unknown> | null {
    if (this.state.latestApprovals.length === 0) return null;
    return this.state.latestApprovals[this.state.selectedApprovalIndex] ?? null;
  }

  async resolveSelectedApproval(status: 'APPROVED' | 'REJECTED', reason: string | null = null): Promise<boolean> {
    const approval = this.getSelectedApproval();
    const invocationId = typeof approval?.invocationId === 'string' ? approval.invocationId : null;
    if (!this.state.activeTaskId || !invocationId) return false;
    await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${this.state.activeTaskId}/approvals/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        invocationId,
        status,
        reason
      })
    });
    await this.pollActiveEvents(1);
    await this.refreshActiveTask();
    return true;
  }

  private pushTranscript(kind: CliTranscriptEntry['kind'], text: string): void {
    this.state.transcript.push({
      kind,
      text,
      timestamp: Date.now()
    });
  }

  private emit(envelope: WorkspaceChatEnvelope): void {
    if (envelope.type === 'info') {
      this.pushTranscript('system', envelope.message);
    } else if (envelope.type === 'session') {
      this.pushTranscript('system', `${envelope.message}${envelope.taskId ? ` (${envelope.taskId})` : ''}`);
    }
    this.onEnvelope?.(envelope);
  }

  private emitInfo(message: string): void {
    this.emit({ type: 'info', message });
  }

  private async fetchTask(taskId: string): Promise<TaskQueryApiResponse> {
    return requestJson<TaskQueryApiResponse>(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${taskId}`, { method: 'GET', headers: {} });
  }

  private async fetchTaskDebug(taskId: string): Promise<TaskDebugResponse> {
    return requestTaskDebug(this.context.fetchImpl, this.context.serverUrl, taskId);
  }

  private async fetchTaskList(): Promise<TaskListApiResponse> {
    return requestJson<TaskListApiResponse>(this.context.fetchImpl, `${this.context.serverUrl}/tasks`, { method: 'GET', headers: {} });
  }

  private async fetchDiagnostics(taskId: string): Promise<Record<string, unknown>> {
    const debug = await this.fetchTaskDebug(taskId);
    return projectTaskDiagnostics(debug.task, debug);
  }

  private async fetchWorkspaceWorkflow(): Promise<CliWorkspaceWorkflowStatus> {
    return requestJson<CliWorkspaceWorkflowStatus>(this.context.fetchImpl, `${this.context.serverUrl}/workspace/workflow`, {
      method: 'GET',
      headers: {}
    });
  }

  private async fetchCapabilityHub(): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(this.context.fetchImpl, `${this.context.serverUrl}/capabilities`, {
      method: 'GET',
      headers: {}
    });
  }

  private async fetchProviders(): Promise<Array<Record<string, unknown>>> {
    return requestJson<Array<Record<string, unknown>>>(this.context.fetchImpl, `${this.context.serverUrl}/providers`, {
      method: 'GET',
      headers: {}
    });
  }

  private async fetchSkillsCatalog(): Promise<Array<Record<string, unknown>>> {
    return requestJson<Array<Record<string, unknown>>>(this.context.fetchImpl, `${this.context.serverUrl}/skills`, {
      method: 'GET',
      headers: {}
    });
  }

  private async fetchMcpCatalog(): Promise<Array<Record<string, unknown>>> {
    return requestJson<Array<Record<string, unknown>>>(this.context.fetchImpl, `${this.context.serverUrl}/mcp`, {
      method: 'GET',
      headers: {}
    });
  }

  private async fetchStatistics(): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(this.context.fetchImpl, `${this.context.serverUrl}/statistics`, {
      method: 'GET',
      headers: {}
    });
  }

  private async emitProviderStatus(): Promise<void> {
    const providers = await this.fetchProviders();
    const activeTask = getRecord(this.state.latestTaskSummary);
    const providerSummary = getRecord(activeTask?.providerSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Current provider: ${getString(providerSummary?.providerId) ?? 'not selected'}`,
      `Current model: ${getString(providerSummary?.modelId) ?? 'not resolved'}${getString(providerSummary?.variantId) ? ` / ${getString(providerSummary?.variantId)}` : ''}`,
      `Selection source: ${getString(providerSummary?.selectedBy) ?? 'not resolved'}`,
      `Readiness: ${getString(providerSummary?.readiness) ?? 'unknown'} / auth=${getString(providerSummary?.authSource) ?? 'unknown'} / status=${getString(providerSummary?.recentStatus) ?? 'unknown'}`,
      ''
    ];
    if (providers.length === 0) {
      lines.push('Configured providers: none');
    } else {
      lines.push('Configured providers:');
      for (const entry of providers) {
        const profile = getRecord(entry.profile);
        const adapter = getRecord(entry.adapter);
        const model = getRecord(entry.model);
        const variant = getRecord(entry.variant);
        lines.push(`- ${getString(profile?.label) ?? getString(profile?.id) ?? 'provider'}: ${getString(entry.readiness) ?? 'unknown'} / ${getString(adapter?.vendor) ?? 'vendor'} / ${getString(adapter?.transport) ?? 'transport'} / ${getString(model?.modelId) ?? 'model'}${getString(variant?.variantId) ? ` / ${getString(variant?.variantId)}` : ''}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitModelStatus(): Promise<void> {
    const providers = await this.fetchProviders();
    const activeTask = getRecord(this.state.latestTaskSummary);
    const providerSummary = getRecord(activeTask?.providerSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Active model: ${getString(providerSummary?.modelId) ?? 'not resolved'}${getString(providerSummary?.variantId) ? ` / ${getString(providerSummary?.variantId)}` : ''}`,
      `Provider: ${getString(providerSummary?.providerId) ?? 'not selected'}`,
      ''
    ];
    if (providers.length === 0) {
      lines.push('Available model presets: none');
    } else {
      lines.push('Available model presets:');
      for (const entry of providers) {
        const profile = getRecord(entry.profile);
        const model = getRecord(entry.model);
        const variant = getRecord(entry.variant);
        lines.push(`- ${getString(profile?.label) ?? getString(profile?.id) ?? 'provider'} => ${getString(model?.modelId) ?? 'model'}${getString(variant?.variantId) ? ` / ${getString(variant?.variantId)}` : ''} [${getString(entry.readiness) ?? 'unknown'}]`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitPermissionStatus(): Promise<void> {
    const activeTask = getRecord(this.state.latestTaskSummary);
    const permissionSummary = getRecord(activeTask?.permissionSummary);
    const hookSummary = getRecord(activeTask?.hookSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Permission mode: ${getString(permissionSummary?.mode) ?? 'ask'}`,
      `Approval required count: ${getNumber(permissionSummary?.approvalRequiredCount) ?? 0}`,
      `Denied count: ${getNumber(permissionSummary?.deniedCount) ?? 0}`,
      `Recent hooks: ${getNumber(hookSummary?.executedCount) ?? 0} executed / ${getNumber(hookSummary?.failedCount) ?? 0} failed`,
    ];
    const warnings = Array.isArray(activeTask?.capabilityWarnings)
      ? activeTask.capabilityWarnings.filter((warning) => getString(getRecord(warning)?.code) === 'permission-denied' || getString(getRecord(warning)?.code) === 'hook-failed')
      : [];
    if (warnings.length > 0) {
      lines.push('');
      lines.push('Active blockers:');
      for (const warning of warnings) {
        const record = getRecord(warning);
        lines.push(`- ${getString(record?.code) ?? 'warning'}: ${getString(record?.message) ?? 'No message'}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitSkillStatus(): Promise<void> {
    const skills = await this.fetchSkillsCatalog();
    const activeTask = getRecord(this.state.latestTaskSummary);
    const skillSummary = getRecord(activeTask?.skillSummary);
    const instructionSkillSummary = getRecord(activeTask?.instructionSkillSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Runtime skills: invoked=${getNumber(skillSummary?.invokedCount) ?? 0} / available=${getNumber(skillSummary?.availableCount) ?? 0} / configured=${getNumber(skillSummary?.configuredCount) ?? 0}`,
      `Instruction skills: selected=${getNumber(instructionSkillSummary?.selectedCount) ?? 0} / configured=${getNumber(instructionSkillSummary?.configuredCount) ?? 0}`,
      ''
    ];
    if (skills.length === 0) {
      lines.push('Skill catalog: none');
    } else {
      lines.push('Skill catalog:');
      for (const entry of skills) {
        const skill = getRecord(entry.skill);
        lines.push(`- ${getString(skill?.name) ?? getString(skill?.id) ?? 'skill'} [${getString(entry.kind) ?? 'unknown'}] readiness=${getString(entry.readiness) ?? 'unknown'}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitMcpStatus(): Promise<void> {
    const servers = await this.fetchMcpCatalog();
    const activeTask = getRecord(this.state.latestTaskSummary);
    const mcpSummary = getRecord(activeTask?.mcpSummary);
    const readinessSummary = getRecord(mcpSummary?.readinessSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `MCP selection: servers=${getStringArray(mcpSummary?.selectedServerIds).join(', ') || 'none'}`,
      `Tools: ${getStringArray(mcpSummary?.selectedTools).join(', ') || 'none'}`,
      `Resources: ${getStringArray(mcpSummary?.selectedResources).join(', ') || 'none'}`,
      `Prompts: ${getStringArray(mcpSummary?.selectedPrompts).join(', ') || 'none'}`,
      `Readiness: ready=${getStringArray(readinessSummary?.ready).join(', ') || 'none'} / missing-client=${getStringArray(readinessSummary?.missingClient).join(', ') || 'none'} / metadata-only=${getStringArray(readinessSummary?.metadataOnly).join(', ') || 'none'}`,
      ''
    ];
    if (servers.length === 0) {
      lines.push('Configured MCP servers: none');
    } else {
      lines.push('Configured MCP servers:');
      for (const entry of servers) {
        const server = getRecord(entry.server);
        lines.push(`- ${getString(server?.name) ?? getString(server?.id) ?? 'server'}: ${getString(entry.readiness) ?? 'unknown'} / tools=${getStringArray(entry.availableTools).length} / resources=${getStringArray(entry.availableResources).length} / prompts=${getStringArray(entry.availablePrompts).length}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitAgentStatus(): Promise<void> {
    const workflow = await this.fetchWorkspaceWorkflow();
    const activeTask = getRecord(this.state.latestTaskSummary);
    const agentSummary = getRecord(activeTask?.agentSummary);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Selected agent: ${getString(agentSummary?.selectedAgent) ?? 'none'}`,
      `Selected by: ${getString(agentSummary?.selectedBy) ?? 'base runtime'}`,
      ''
    ];
    if (workflow.agents.length === 0) {
      lines.push('Workspace agents: none');
    } else {
      lines.push('Workspace agents:');
      for (const entry of workflow.agents) {
        lines.push(`- ${entry.name}${entry.description ? ` - ${entry.description}` : ''}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitCompressionStatus(): Promise<void> {
    const taskId = this.state.activeTaskId;
    if (!taskId) {
      this.emitInfo([...buildSummaryHintLines(this.state.latestTaskSummary), '', 'Compression detail: no active task attached.'].join('\n'));
      return;
    }
    const diagnostics = await this.fetchDiagnostics(taskId);
    const promptBudget = getRecord(diagnostics.promptBudget);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Compression policy: ${getString(diagnostics.compressionPolicy) ?? 'unknown'}`,
      `Compression downgraded: ${String(diagnostics.compressionDowngraded ?? false)}`,
      `Planner fallback rate: ${String(diagnostics.plannerFallbackRate ?? 0)}`,
      `Prompt chars: ${getNumber(promptBudget?.estimatedPromptCharacters) ?? 0}`,
      `Baseline chars: ${getNumber(promptBudget?.estimatedBaselineCharacters) ?? 0}`,
      `Reduction ratio: ${String(promptBudget?.estimatedReductionRatio ?? 0)}`,
      `Retrieved records: ${getNumber(promptBudget?.retrievedContextCount) ?? 0}`,
    ];
    this.emitInfo(lines.join('\n'));
  }

  private async emitCostStatus(): Promise<void> {
    const taskId = this.state.activeTaskId;
    const stats = await this.fetchStatistics();
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      `Provider billing: unavailable in local default runtime`,
      `Active tasks: ${getNumber(getRecord(stats.taskCounts)?.RUNNING) ?? 0}`,
      `Completed tasks: ${getNumber(getRecord(stats.taskCounts)?.COMPLETED) ?? 0}`,
      `Providers configured: ${getNumber(stats.providers) ?? 0}`,
      `Skills configured: ${getNumber(stats.skills) ?? 0}`,
    ];
    if (taskId) {
      const diagnostics = await this.fetchDiagnostics(taskId);
      const promptBudget = getRecord(diagnostics.promptBudget);
      lines.push(`Estimated prompt chars: ${getNumber(promptBudget?.estimatedPromptCharacters) ?? 0}`);
      lines.push(`Estimated reduction ratio: ${String(promptBudget?.estimatedReductionRatio ?? 0)}`);
    } else {
      lines.push('No active task prompt budget is available yet.');
    }
    this.emitInfo(lines.join('\n'));
  }

  private async emitPathStatus(): Promise<void> {
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      ...buildArtifactHintLines(this.state.latestTaskSummary)
    ];
    this.emitInfo(lines.join('\n'));
  }

  private async emitArtifactStatus(): Promise<void> {
    const activeTask = getRecord(this.state.latestTaskSummary);
    const artifactPaths = getStringArray(activeTask?.artifactPaths);
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      ...buildArtifactHintLines(this.state.latestTaskSummary),
      '',
      'Sandbox artifacts:'
    ];
    if (artifactPaths.length === 0) {
      lines.push('none');
    } else {
      for (const artifactPath of artifactPaths) {
        lines.push(`- ${artifactPath}`);
      }
    }
    this.emitInfo(lines.join('\n'));
  }

  private renderWorkspaceCommandTemplate(template: string, args: string[]): string {
    return template.replace(/\$\{args\}/g, args.join(' ').trim()).trim();
  }

  private async tryHandleWorkspaceCommand(command: string, args: string[]): Promise<boolean> {
    if (RESERVED_WORKSPACE_COMMANDS.has(command)) {
      return false;
    }
    const workflow = await this.fetchWorkspaceWorkflow();
    const workspaceCommand = workflow.commands.find((entry) => entry.name === command) as (CliWorkspaceCommandDefinition & { template?: string }) | undefined;
    if (!workspaceCommand) {
      return false;
    }
    const rendered = this.renderWorkspaceCommandTemplate(workspaceCommand.template ?? '', args);
    if (!rendered) {
      this.emitInfo(`Workspace command "/${command}" has an empty template.`);
      return true;
    }
    if (!this.state.activeTaskId || (this.mode === 'workspace' && this.state.latestTaskSummary && ['FAILED', 'COMPLETED', 'CANCELLED'].includes(String(this.state.latestTaskSummary.lifecycleStatus)))) {
      const taskId = await this.createAdHocTask(rendered, {
        workspaceCommand: {
          name: workspaceCommand.name,
          description: workspaceCommand.description,
          template: workspaceCommand.template ?? ''
        }
      });
      await this.invokeTaskAction(taskId, 'start', rendered);
      await this.pollActiveEvents(2);
      await this.refreshActiveTask();
      return true;
    }
    await this.handlePlainMessage(rendered);
    return true;
  }

  private rememberTask(taskId: string): void {
    this.state.recentTaskIds = [taskId, ...this.state.recentTaskIds.filter((item) => item !== taskId)].slice(0, 10);
  }

  private upsertRecentTask(item: CliRecentTaskItem): void {
    const normalized: CliRecentTaskItem = {
      ...item,
      isActive: item.taskId === this.state.activeTaskId,
      isRecent: this.state.recentTaskIds.includes(item.taskId)
    };
    const withoutCurrent = this.state.recentTasks.filter((entry) => entry.taskId !== item.taskId);
    this.state.recentTasks = sortRecentTaskItems(
      [normalized, ...withoutCurrent].slice(0, 20),
      this.state.activeTaskId,
      this.state.recentTaskIds
    );
  }

  private updateTaskState(task: TaskQueryApiResponse, debug: TaskDebugResponse | null = null): void {
    this.state.latestTaskSummary = projectTaskSummary(task, debug);
    this.state.latestDiagnostics = projectTaskDiagnostics(task, debug);
    this.state.latestApprovals = projectPendingApprovals(task);
    this.state.selectedApprovalIndex = Math.min(this.state.selectedApprovalIndex, Math.max(this.state.latestApprovals.length - 1, 0));
    this.state.eventCursorByTaskId[task.definition.taskId] ??= task.events.at(-1)?.eventId ?? null;
    this.upsertRecentTask(toRecentTaskItemFromTask(task, this.state.activeTaskId, this.state.recentTaskIds));
    this.updateRawViewPayload();
  }

  private updateRawViewPayload(): void {
    const diagnostics = this.state.latestDiagnostics;
    this.state.lastViewPayload = {
      activeTaskId: this.state.activeTaskId,
      activeTask: this.state.latestTaskSummary,
      diagnostics,
      approvals: this.state.latestApprovals,
      selectedApprovalIndex: this.state.selectedApprovalIndex,
      recentTaskIds: this.state.recentTaskIds,
      recentTasks: this.state.recentTasks,
      recentEvents: this.state.recentEvents.slice(-20),
      viewMode: this.state.viewMode,
      stageMemorySummary: diagnostics && typeof diagnostics === 'object' && diagnostics.stageMemorySummary && typeof diagnostics.stageMemorySummary === 'object'
        ? {
          ...(diagnostics.stageMemorySummary as Record<string, unknown>),
          summaryFragments: summarizeMemorySelection(diagnostics.stageMemorySummary as Record<string, unknown>)
        }
        : null
    };
  }

  private async attachTask(taskId: string, message: string, action: 'attached' | 'created' = 'attached'): Promise<void> {
    this.state.activeTaskId = taskId;
    this.rememberTask(taskId);
    const debug = await this.fetchTaskDebug(taskId);
    const task = debug.task;
    this.updateTaskState(task, debug);
    this.emit({
      type: 'session',
      action,
      taskId,
      message
    });
    this.emit({
      type: 'task',
      task: this.state.latestTaskSummary ?? projectTaskSummary(task, debug)
    });
    this.emit({
      type: 'approvals',
      taskId,
      count: task.pendingApprovals.length,
      approvals: this.state.latestApprovals
    });
  }

  private async createAdHocTask(message: string, metadata?: Record<string, unknown>): Promise<string> {
    const payload = buildInteractivePayload(message, this.args, metadata);
    const submitted = await submitTaskPayload(this.context.fetchImpl, this.context.serverUrl, payload);
    await this.attachTask(submitted.command.taskId, 'Interactive task created', 'created');
    return submitted.command.taskId;
  }

  private async invokeTaskAction(taskId: string, action: 'start' | 'continue' | 'pause' | 'resume' | 'restart', userMessage?: string): Promise<void> {
    await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${taskId}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ userMessage })
    });
  }

  private async invokeCommand(taskId: string, command: Omit<TaskCommandRequest, 'taskId'>): Promise<void> {
    await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${taskId}/commands`, {
      method: 'POST',
      body: JSON.stringify(command)
    });
  }

  private async handlePlainMessage(message: string): Promise<void> {
    this.pushTranscript('user', message);
    let taskId = this.state.activeTaskId;
    let task = taskId ? await this.fetchTask(taskId) : null;

    if (!taskId) {
      taskId = await this.createAdHocTask(message);
      task = await this.fetchTask(taskId);
    } else if (this.mode === 'workspace' && task && ['FAILED', 'CANCELLED'].includes(task.runtime.lifecycleStatus)) {
      taskId = await this.createAdHocTask(message);
      task = await this.fetchTask(taskId);
    }

    if (!taskId || !task) return;

    if (task.runtime.lifecycleStatus === 'SUBMITTED') {
      await this.invokeTaskAction(taskId, 'start', message);
    } else if (task.runtime.lifecycleStatus === 'PAUSED') {
      await this.invokeTaskAction(taskId, 'resume', message);
    } else if (task.runtime.lifecycleStatus === 'COMPLETED') {
      await this.invokeTaskAction(taskId, 'continue', message);
    } else if (this.mode === 'task' && ['FAILED', 'CANCELLED'].includes(task.runtime.lifecycleStatus)) {
      await this.invokeTaskAction(taskId, 'restart', message);
    } else if (task.runtime.pendingCorrection !== 'NONE' || task.runtime.pendingOperatorInputs.length > 0) {
      await this.invokeTaskAction(taskId, 'continue', message);
    } else {
      await this.invokeCommand(taskId, {
        type: 'SEND_OPERATOR_MESSAGE',
        message
      });
    }

    await this.pollActiveEvents(2);
    await this.refreshActiveTask();
  }

  private async emitTaskListView(): Promise<void> {
    const tasks = await this.fetchTaskList();
    const merged = new Map<string, CliRecentTaskItem>();
    for (const record of tasks) {
      merged.set(record.taskId, toRecentTaskItemFromSummary(record, this.state.activeTaskId, this.state.recentTaskIds));
    }
    for (const record of this.state.recentTasks) {
      if (!merged.has(record.taskId)) {
        merged.set(record.taskId, {
          ...record,
          isActive: record.taskId === this.state.activeTaskId,
          isRecent: this.state.recentTaskIds.includes(record.taskId)
        });
      }
    }
    const taskItems = sortRecentTaskItems([...merged.values()].slice(0, 20), this.state.activeTaskId, this.state.recentTaskIds);
    this.state.recentTasks = taskItems;
    this.state.viewMode = 'tasks';
    const payload = {
      activeTaskId: this.state.activeTaskId,
      recentTaskIds: this.state.recentTaskIds,
      tasks: taskItems
    };
    this.state.lastViewPayload = payload;
    this.emit({
      type: 'view',
      view: 'tasks',
      data: payload
    });
  }

  private async handleSlashCommand(line: string): Promise<HandleInputResult> {
    const trimmed = line.slice(1).trim();
    if (!trimmed) {
      this.emitHelp();
      return 'continue';
    }
    const [command, ...rest] = trimmed.split(/\s+/);
    const joined = rest.join(' ').trim();

    if (command === 'help') {
      this.emitHelp();
      return 'continue';
    }
    if (command === 'commands') {
      const workflow = await this.fetchWorkspaceWorkflow();
      const lines = [
        ...buildSummaryHintLines(this.state.latestTaskSummary),
        '',
        `Workspace root: ${workflow.workspaceRoot ?? 'not initialized'}`,
        `Project instructions: ${workflow.projectInstructionsPresent ? 'present' : 'missing'}`,
        `Imported docs: ${workflow.docsImportSummary.importedMemoryCount}/${workflow.docsImportSummary.trackedSourceCount}`
      ];
      const visibleWorkspaceCommands = workflow.commands.filter((entry) => !RESERVED_WORKSPACE_COMMANDS.has(entry.name.trim().toLowerCase()));
      if (visibleWorkspaceCommands.length > 0) {
        lines.push('Workspace commands:');
        for (const entry of visibleWorkspaceCommands) {
          const metadata = [
            entry.description ? `desc=${entry.description}` : null,
            entry.args ? `args=${entry.args}` : null,
            entry.when ? `when=${entry.when}` : null
          ].filter((value): value is string => Boolean(value));
          lines.push(`/${entry.name}${metadata.length > 0 ? ` - ${metadata.join('; ')}` : ''}`);
        }
      } else {
        lines.push('Workspace commands: none');
      }
      this.emitInfo(lines.join('\n'));
      return 'continue';
    }
    if (command === 'provider') {
      await this.emitProviderStatus();
      return 'continue';
    }
    if (command === 'model') {
      await this.emitModelStatus();
      return 'continue';
    }
    if (command === 'permissions') {
      await this.emitPermissionStatus();
      return 'continue';
    }
    if (command === 'skills') {
      await this.emitSkillStatus();
      return 'continue';
    }
    if (command === 'mcp') {
      await this.emitMcpStatus();
      return 'continue';
    }
    if (command === 'agent') {
      await this.emitAgentStatus();
      return 'continue';
    }
    if (command === 'compact') {
      await this.emitCompressionStatus();
      return 'continue';
    }
    if (command === 'cost') {
      await this.emitCostStatus();
      return 'continue';
    }
    if (command === 'path') {
      await this.emitPathStatus();
      return 'continue';
    }
    if (command === 'artifacts') {
      await this.emitArtifactStatus();
      return 'continue';
    }
    if (command === 'improvements') {
      const proposals = await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/improvements/proposals`, {
        method: 'GET',
        headers: {}
      });
      this.state.lastViewPayload = proposals;
      const lines = ['Improvements'];
      const typedProposals = Array.isArray(proposals) ? proposals as Array<Record<string, unknown>> : [];
      if (typedProposals.length === 0) {
        lines.push('No proposals available.');
      } else {
        for (const proposal of typedProposals.slice(0, 12)) {
          const title = typeof proposal.title === 'string' ? proposal.title : 'Proposal';
          const kind = typeof proposal.kind === 'string' ? proposal.kind : 'proposal';
          const status = typeof proposal.status === 'string' ? proposal.status.toLowerCase() : 'pending';
          const archiveEligible = proposal.archiveEligible === true;
          const duplicateOfProposalId = typeof proposal.duplicateOfProposalId === 'string' ? proposal.duplicateOfProposalId : '';
          const conflictsWithProposalIds = Array.isArray(proposal.conflictsWithProposalIds)
            ? proposal.conflictsWithProposalIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            : [];
          const flags = [
            archiveEligible ? 'archive eligible' : '',
            duplicateOfProposalId ? 'duplicate proposal' : '',
            conflictsWithProposalIds.length > 0 ? 'conflicting lesson' : ''
          ].filter(Boolean);
          lines.push(`- ${kind}:${status} ${title}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`);
        }
      }
      this.emitInfo(lines.join('\n'));
      return 'continue';
    }
    if (command === 'proposal') {
      const action = (rest[0] ?? '').toLowerCase();
      const proposalId = rest[1];
      if (!['accept', 'reject'].includes(action) || !proposalId) {
        this.emitInfo('Usage: /proposal <accept|reject> <proposalId>');
        return 'continue';
      }
      const endpoint = action === 'accept' ? 'approve' : 'reject';
      let result;
      try {
        result = await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/improvements/proposals/${proposalId}/${endpoint}`, {
          method: 'POST',
          body: JSON.stringify({})
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitInfo(
          action === 'accept'
            ? `Proposal approval blocked: ${message}`
            : `Proposal rejection failed: ${message}`
        );
        return 'continue';
      }
      this.state.lastViewPayload = result;
      this.emitInfo(
        action === 'accept'
          ? 'Proposal approved to lesson memory or materialized instruction skill.'
          : 'Proposal rejected.'
      );
      if (this.state.activeTaskId) {
        await this.refreshActiveTask();
      }
      return 'continue';
    }
    if (command === 'exit' || command === 'quit') {
      this.emit({
        type: 'session',
        action: 'closed',
        taskId: this.state.activeTaskId,
        message: 'Interactive session closed'
      });
      return 'exit';
    }

    if (this.mode === 'workspace') {
      if (command === 'tasks') {
        await this.emitTaskListView();
        return 'continue';
      }
      if (command === 'new') {
        if (joined) {
          await this.createAdHocTask(joined);
          await this.invokeTaskAction(this.state.activeTaskId!, 'start', joined);
          await this.pollActiveEvents(2);
          await this.refreshActiveTask();
          return 'continue';
        }
        this.state.activeTaskId = null;
        this.state.latestTaskSummary = null;
        this.state.latestDiagnostics = null;
        this.state.latestApprovals = [];
        this.state.selectedApprovalIndex = 0;
        this.updateRawViewPayload();
        this.emit({
          type: 'session',
          action: 'detached',
          taskId: null,
          message: 'Detached from active task; next message will create a new task'
        });
        return 'continue';
      }
      if (command === 'focus' || command === 'raw') {
        const view = command === 'raw' ? 'raw' : (rest[0] ?? '').toLowerCase();
        if (!['summary', 'capabilities', 'diagnostics', 'events', 'approvals', 'raw', 'tasks'].includes(view)) {
          this.emitInfo('Usage: /focus <summary|capabilities|diagnostics|events|approvals|raw|tasks>');
          return 'continue';
        }
        await this.setViewMode(view as CliViewMode);
        return 'continue';
      }
      if (command === 'clear') {
        this.clearTranscript();
        return 'continue';
      }
    }

    if (command === 'switch') {
      if (!rest[0]) {
        this.emitInfo('Usage: /switch <taskId>');
        return 'continue';
      }
      await this.attachTask(rest[0], 'Attached to task');
      return 'continue';
    }

    if (!this.state.activeTaskId) {
      this.emitInfo('No task is attached yet. Enter a prompt to create one, or use /switch <taskId>.');
      return 'continue';
    }

    switch (command) {
      case 'task': {
        const subaction = (rest[0] ?? '').toLowerCase();
        if ((subaction === 'archive' || subaction === 'unarchive' || subaction === 'delete') && !this.state.activeTaskId) {
          this.emitInfo('No active task selected. Use /switch <taskId> first.');
          return 'continue';
        }
        if (subaction === 'archive' || subaction === 'unarchive') {
          await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${this.state.activeTaskId}/${subaction}`, {
            method: 'POST',
            body: JSON.stringify({})
          });
          await this.refreshActiveTask();
          this.emitInfo(subaction === 'archive'
            ? 'Task archived. Archived tasks stay out of the default list until you unarchive them.'
            : 'Task unarchived.');
          return 'continue';
        }
        if (subaction === 'delete') {
          await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${this.state.activeTaskId}`, {
            method: 'DELETE',
            headers: {}
          });
          const deletedTaskId = this.state.activeTaskId;
          this.state.activeTaskId = null;
          this.state.latestTaskSummary = null;
          this.state.latestDiagnostics = null;
          this.state.latestApprovals = [];
          this.state.recentTasks = this.state.recentTasks.filter((item) => item.taskId !== deletedTaskId);
          this.state.recentTaskIds = this.state.recentTaskIds.filter((item) => item !== deletedTaskId);
          this.state.selectedApprovalIndex = 0;
          this.updateRawViewPayload();
          this.emitInfo('Task deleted permanently. Only terminal tasks can be removed this way.');
          return 'continue';
        }
        await this.refreshActiveTask();
        return 'continue';
      }
      case 'status':
        await this.refreshActiveTask();
        return 'continue';
      case 'events':
        await this.pollActiveEvents(0);
        return 'continue';
      case 'diagnostics': {
        const data = await this.fetchDiagnostics(this.state.activeTaskId);
        this.state.lastViewPayload = data;
        this.emit({
          type: 'diagnostics',
          taskId: this.state.activeTaskId,
          data
        });
        return 'continue';
      }
      case 'start':
      case 'continue':
      case 'pause':
      case 'resume':
      case 'restart':
        await this.invokeTaskAction(this.state.activeTaskId, command, joined || undefined);
        await this.pollActiveEvents(2);
        await this.refreshActiveTask();
        return 'continue';
      case 'message':
      case 'send':
        if (!joined) {
          this.emitInfo('Usage: /message <text>');
          return 'continue';
        }
        await this.invokeCommand(this.state.activeTaskId, {
          type: 'SEND_OPERATOR_MESSAGE',
          message: joined
        });
        await this.refreshActiveTask();
        return 'continue';
      case 'interrupt':
      case 'cancel':
        await this.invokeCommand(this.state.activeTaskId, {
          type: command === 'interrupt' ? 'INTERRUPT_TASK' : 'CANCEL_TASK',
          reason: joined || null,
          message: joined || null
        });
        await this.refreshActiveTask();
        return 'continue';
      case 'apply':
        await this.invokeCommand(this.state.activeTaskId, {
          type: 'APPLY_ARTIFACTS',
          message: joined || null,
          metadata: {
            destinationDir: joined || null
          }
        });
        await this.pollActiveEvents(1);
        await this.refreshActiveTask();
        return 'continue';
      case 'approve':
      case 'reject': {
        const invocationId = rest[0];
        const reason = rest.slice(1).join(' ').trim() || null;
        if (!invocationId) {
          this.emitInfo(`Usage: /${command} <invocationId> [reason]`);
          return 'continue';
        }
        await requestJson(this.context.fetchImpl, `${this.context.serverUrl}/tasks/${this.state.activeTaskId}/approvals/resolve`, {
          method: 'POST',
          body: JSON.stringify({
            invocationId,
            status: command === 'approve' ? 'APPROVED' : 'REJECTED',
            reason
          })
        });
        await this.pollActiveEvents(1);
        await this.refreshActiveTask();
        return 'continue';
      }
      default:
        if (await this.tryHandleWorkspaceCommand(command, rest)) {
          return 'continue';
        }
        this.emitInfo(`Unknown command "/${command}". Use /help.`);
        return 'continue';
    }
  }

  private emitHelp(): void {
    const commandLines = this.mode === 'workspace'
      ? [
        'Workspace chat commands:',
        '/help',
        '/tasks',
        '/commands',
        '/provider',
        '/model',
        '/permissions',
        '/skills',
        '/mcp',
        '/agent',
        '/path',
        '/artifacts',
        '/improvements',
        '/proposal <accept|reject> <proposalId>',
        '/apply [project-relative-dir] (omit to use recommended path)',
        '/compact',
        '/cost',
        '/switch <taskId>',
        '/new [prompt]',
        '/focus <summary|capabilities|diagnostics|events|approvals|raw|tasks>',
        '/raw',
        '/clear',
        '/task',
        '/task archive',
        '/task unarchive',
        '/task delete',
        '/status',
        '/events',
        '/diagnostics',
        '/start [message]',
        '/continue [message]',
        '/pause',
        '/resume [message]',
        '/restart [message]',
        '/message <text>',
        '/approve <invocationId> [reason]',
        '/reject <invocationId> [reason]',
        '/interrupt [reason]',
        '/cancel [reason]',
        '/exit'
      ]
      : [
        'Interactive task session commands:',
        '/help',
        '/commands',
        '/provider',
        '/model',
        '/permissions',
        '/skills',
        '/mcp',
        '/agent',
        '/path',
        '/artifacts',
        '/improvements',
        '/proposal <accept|reject> <proposalId>',
        '/apply [project-relative-dir] (omit to use recommended path)',
        '/compact',
        '/cost',
        '/task',
        '/task archive',
        '/task unarchive',
        '/task delete',
        '/status',
        '/events',
        '/diagnostics',
        '/start [message]',
        '/continue [message]',
        '/pause',
        '/resume [message]',
        '/restart [message]',
        '/message <text>',
        '/approve <invocationId> [reason]',
        '/reject <invocationId> [reason]',
        '/interrupt [reason]',
        '/cancel [reason]',
        '/switch <taskId>',
        '/exit'
      ];
    const lines = [
      ...buildSummaryHintLines(this.state.latestTaskSummary),
      '',
      ...commandLines
    ];
    this.emitInfo(lines.join('\n'));
  }
}
