import { CliChatSessionController } from '../../interfaces/cli/chat/session/session-controller';
import { runBackendNewCli } from '../../interfaces/cli/runner';

export type CliInteractionTranscriptFamily =
  | 'capability-commands'
  | 'artifact-routing-commands'
  | 'approval-recovery-guidance'
  | 'watch-tail-stream-consistency';

export interface CliInteractionTranscriptScenarioResult {
  scenario: string;
  family: CliInteractionTranscriptFamily;
  passed: boolean;
  summary: string;
  findings: string[];
  transcriptExcerpt: string[];
}

export interface CliInteractionTranscriptSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: CliInteractionTranscriptScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactEvidencePassRate: number;
    byFamily: Record<CliInteractionTranscriptFamily, number>;
    byFailureCategory: Record<string, number>;
  };
}

interface MockIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  readStdout(): string;
  readStderr(): string;
}

function createResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

function createMockIo(): MockIo {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      }
    },
    readStdout() {
      return stdout;
    },
    readStderr() {
      return stderr;
    }
  };
}

class ScriptedWebSocket {
  private listeners = new Map<string, Array<(value: unknown) => void>>();
  private closed = false;

  constructor(private readonly messages: Array<unknown | (() => unknown)>) {
    queueMicrotask(() => this.emit('open'));
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: (value?: unknown) => void): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener as (value: unknown) => void);
    this.listeners.set(event, current);
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as { type?: string };
    if (parsed.type !== 'subscribe') {
      return;
    }
    let index = 0;
    const step = () => {
      if (this.closed) {
        return;
      }
      const next = this.messages[index];
      const message = typeof next === 'function' ? next() : next;
      if (!message) {
        return;
      }
      index += 1;
      this.emit('message', JSON.stringify(message));
      queueMicrotask(step);
    };
    queueMicrotask(step);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close');
  }

  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }
}

function buildTaskDebug(overrides: Record<string, unknown> = {}): any {
  return {
    task: {
      definition: {
        taskId: 'task-1',
        title: 'Task 1',
        intent: 'Inspect operator flow.'
      },
      runtime: {
        lifecycleStatus: 'RUNNING',
        engineStatus: 'RUNNING',
        currentUnitId: 'AGENT-001',
        updatedAt: Date.now(),
        pendingCorrection: 'NONE',
        pendingOperatorInputs: []
      },
      projection: null,
      queue: null,
      pendingApprovals: [],
      diagnostics: {
        lastError: null,
        providerFailure: null
      },
      statusSummary: {
        label: 'Running',
        detail: 'Runtime is actively progressing through the current unit.',
        tone: 'running'
      },
      primaryAction: {
        kind: 'continue_thread',
        label: 'Continue current thread',
        description: 'Task is running with no active correction requirement.',
        destinationDir: null
      },
      nextActionSummary: {
        label: 'Continue current thread',
        reason: 'Task is running with no active correction requirement.'
      },
      completionSummary: null,
      delegationSummary: {
        depth: 0,
        delegationEnabled: false,
        canDelegate: false,
        required: false,
        missingRequiredDelegation: false,
        reason: 'Delegation is disabled.',
        activeChildTask: null,
        recentChildren: []
      },
      latestVisibleOutput: null,
      visibleToolActivities: [],
      events: [],
      commands: [],
      operatorMessages: [],
      interrupts: [],
      toolInvocations: [],
      conversations: []
    },
    executionSummary: {
      issueCategory: null,
      issueSummary: null,
      eventCounts: {},
      turnCount: 2,
      correctionDepth: 0,
      stageDurations: [{ stageIndex: 0, unitIds: ['AGENT-001'], startedAt: Date.now() - 500, endedAt: null, durationMs: 500 }],
      unitDurations: [{ unitId: 'AGENT-001', stageIndex: 0, startedAt: Date.now() - 500, endedAt: null, durationMs: 500, turnCount: 2 }],
      plannerFallbackReasons: [],
      approvalBlockedBatchCount: 0,
      batchExecution: {
        plannedProviderBatchCount: 1,
        plannedToolBatchCount: 1,
        executedToolBatchCount: 1,
        toolInvocationCount: 1,
        averageToolInvocationsPerBatch: 1
      },
      observedHooks: [],
      ruleSummary: { configuredCount: 1, matchedRuleNames: ['task-route'], pathMatchedRuleNames: [] },
      hookSummary: { configuredCount: 1, executedCount: 0, failedCount: 0, recent: [] },
      agentSummary: { configuredCount: 1, selectedAgent: 'review', selectedBy: 'workspace_agent' },
      instructionSkillSummary: { configuredCount: 1, selectedCount: 1, selected: [] },
      providerSummary: {
        providerId: 'provider-main',
        modelId: 'gpt-5.4',
        variantId: 'reasoning',
        selectedBy: 'config_default',
        transport: 'openai-compatible',
        readiness: 'ready',
        authSource: 'secret-store',
        recentStatus: 'selected',
        lastMessage: null
      },
      skillSummary: { configuredCount: 1, availableCount: 1, invokedCount: 0, failureStreak: 0, recent: [] },
      mcpSummary: {
        configuredCount: 1,
        availableCount: 1,
        invokedCount: 0,
        failureStreak: 0,
        selectedServerIds: ['docs'],
        selectedTools: ['search_docs'],
        selectedResources: ['docs://runbook'],
        selectedPrompts: ['triage'],
        readinessSummary: { ready: ['docs'], missingClient: [], metadataOnly: [] },
        recent: []
      },
      permissionSummary: { mode: 'ask', approvalRequiredCount: 1, deniedCount: 0, recent: [] },
      providerFailureStreak: 0,
      skillFailureStreak: 0,
      mcpFailureStreak: 0,
      artifactPathState: 'sandbox_only',
      pendingArtifactCount: 0,
      selectedArtifactDir: null,
      recommendedArtifactDir: null,
      artifactPaths: [],
      lastArtifactApplyAt: null,
      lastArtifactApplyResult: null,
      lastSafeCheckpointAt: null,
      lastRecoverySource: null,
      conservativeModeReason: null,
      capabilityWarnings: [],
      queueRuntimeAlignment: {
        consistent: true,
        queueState: null,
        lifecycleStatus: 'RUNNING',
        summary: 'aligned'
      },
      recovery: {
        recoveredAfterRestart: false,
        recoveryReason: null,
        recoveredBy: null,
        recoveredFromLifecycleStatus: null,
        previousQueueState: null,
        queueLastError: null
      },
      contextGating: {
        mode: 'standard',
        promptMaxSummaryItems: 4,
        promptMaxHistoryMessages: 6,
        promptEstimatedChars: 1200,
        baselineEstimatedChars: 1800,
        retrievedContextCount: 2,
        reductionRatio: 0.3333,
        plannerFallbackCount: 0
      },
      executionProfiles: [],
      turnContract: {
        currentUnitId: 'AGENT-001',
        pendingCorrection: 'NONE',
        requiresToolEvidence: false,
        lastAcceptanceFailureCategory: null,
        lastPendingCorrectionKind: null,
        lastCorrectionPromptMode: 'none',
        correctionLoopNonConvergent: false,
        conservativeMode: false,
        continueAllowed: true,
        continueReason: 'Task is running with no active correction requirement.'
      },
      ...overrides
    }
  };
}

function buildWorkspaceWorkflow() {
  return {
    workspaceRoot: 'D:/workspace',
    projectInstructionsPresent: true,
    projectInstructionsSummary: 'Follow workspace constraints.',
    commands: [],
    rules: [{ name: 'task-route', pathScope: 'backend/src' }],
    hooks: [{ event: 'mcp.failure', command: 'node scripts/hook.js' }],
    agents: [{ name: 'review', description: 'Review regressions' }],
    docsSources: [],
    docsImportSummary: {
      trackedSourceCount: 0,
      importedMemoryCount: 0
    }
  };
}

function createCapabilityFetch(options: {
  debug?: ReturnType<typeof buildTaskDebug>;
  commandSink?: Array<Record<string, unknown>>;
  approvalSink?: Array<Record<string, unknown>>;
}) {
  const debug = options.debug ?? buildTaskDebug();
  const task = debug.task;
  return async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/workspace/workflow') {
      return createResponse(buildWorkspaceWorkflow());
    }
    if (parsed.pathname === '/providers') {
      return createResponse([
        {
          profile: { id: 'provider-main', label: 'Provider Main' },
          readiness: 'ready',
          authSource: 'secret-store',
          adapter: { vendor: 'openai-compatible', transport: 'openai-compatible' },
          model: { modelId: 'gpt-5.4' },
          variant: { variantId: 'reasoning' }
        }
      ]);
    }
    if (parsed.pathname === '/skills') {
      return createResponse([
        {
          skill: { id: 'review-skill', name: 'Review Skill' },
          kind: 'instruction-skill',
          readiness: 'metadata-only'
        }
      ]);
    }
    if (parsed.pathname === '/mcp') {
      return createResponse([
        {
          server: { id: 'docs', name: 'Docs MCP' },
          readiness: 'ready',
          availableTools: ['search_docs'],
          availableResources: ['docs://runbook'],
          availablePrompts: ['triage']
        }
      ]);
    }
    if (parsed.pathname === '/statistics') {
      return createResponse({
        taskCounts: { RUNNING: 1, COMPLETED: 3 },
        providers: 1,
        skills: 1
      });
    }
    if (parsed.pathname === '/capabilities') {
      return createResponse({
        summary: { total: 4, ready: 3, partial: 1, blocked: 0 },
        warnings: [],
        entries: [],
        workspace: { commands: [], agents: [], rules: [], hooks: [] }
      });
    }
    if (parsed.pathname === '/tasks/task-1/debug') {
      return createResponse(debug);
    }
    if (parsed.pathname === '/tasks/task-1') {
      return createResponse(task);
    }
    if (parsed.pathname === '/tasks/task-1/events') {
      return createResponse([]);
    }
    if (parsed.pathname === '/tasks/task-1/events/stream') {
      return new Response('', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        }
      });
    }
    if (parsed.pathname === '/tasks/task-1/commands' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      options.commandSink?.push(payload);
      return createResponse({
        command: { taskId: 'task-1', status: 'SUCCEEDED', type: payload.type ?? 'UNKNOWN' },
        task
      });
    }
    if (parsed.pathname === '/tasks/task-1/approvals/resolve' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      options.approvalSink?.push(payload);
      return createResponse({
        command: { taskId: 'task-1', status: 'SUCCEEDED', type: 'RESOLVE_APPROVAL' },
        task
      });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };
}

async function runCapabilityCommandsScenario(): Promise<CliInteractionTranscriptScenarioResult> {
  const envelopes: Array<{ type?: string; message?: string }> = [];
  const fetchImpl = createCapabilityFetch({});
  const controller = new CliChatSessionController({
    mode: 'workspace',
    context: {
      args: { command: [], flags: {} },
      fetchImpl: fetchImpl as typeof fetch,
      io: { stdout: { write() {} }, stderr: { write() {} } },
      stdin: process.stdin,
      createWebSocket: () => {
        throw new Error('websocket not needed');
      },
      sleep: async () => {},
      serverUrl: 'http://127.0.0.1:3011'
    },
    args: { command: [], flags: {} },
    outputFormat: 'human',
    onEnvelope: (envelope: any) => {
      envelopes.push({
        type: envelope.type,
        message: envelope.type === 'info' ? envelope.message : undefined
      });
    }
  });
  controller.state.activeTaskId = 'task-1';
  controller.state.latestTaskSummary = {
    taskId: 'task-1',
    title: 'Task 1',
    lifecycleStatus: 'RUNNING',
    statusSummary: {
      label: 'Running',
      detail: 'Runtime is actively progressing through the current unit.',
      tone: 'running'
    },
    primaryAction: {
      kind: 'continue_thread',
      label: 'Continue current thread',
      description: 'Task is running with no active correction requirement.',
      destinationDir: null
    },
    nextActionSummary: {
      label: 'Continue current thread',
      reason: 'Task is running with no active correction requirement.'
    },
    progressState: 'running',
    stageLabel: 'Stage 1 of 1',
    blockingReason: 'Runtime is actively progressing through the current unit.',
    nextAction: 'Continue current thread',
    nextActionReason: 'Task is running with no active correction requirement.',
    providerSummary: {
      providerId: 'provider-main',
      modelId: 'gpt-5.4',
      variantId: 'reasoning',
      selectedBy: 'config_default',
      readiness: 'ready',
      authSource: 'secret-store',
      recentStatus: 'selected'
    },
    skillSummary: { configuredCount: 1, availableCount: 1, invokedCount: 0 },
    instructionSkillSummary: { configuredCount: 1, selectedCount: 1 },
    mcpSummary: {
      selectedServerIds: ['docs'],
      selectedTools: ['search_docs'],
      selectedResources: ['docs://runbook'],
      selectedPrompts: ['triage'],
      readinessSummary: { ready: ['docs'], missingClient: [], metadataOnly: [] }
    },
    permissionSummary: { mode: 'ask', approvalRequiredCount: 1, deniedCount: 0 },
    agentSummary: { selectedAgent: 'review', selectedBy: 'workspace_agent' },
    hookSummary: { executedCount: 0, failedCount: 0 },
    capabilityWarnings: [],
    artifactPathState: 'sandbox_only',
    pendingArtifactCount: 0,
    selectedArtifactDir: null,
    recommendedArtifactDir: null,
    artifactPaths: [],
    lastArtifactApplyAt: null,
    lastArtifactApplyResult: null
  };

  await controller.handleInput('/provider');
  await controller.handleInput('/model');
  await controller.handleInput('/permissions');
  await controller.handleInput('/skills');
  await controller.handleInput('/mcp');
  await controller.handleInput('/agent');
  await controller.handleInput('/compact');
  await controller.handleInput('/cost');

  const transcript = envelopes
    .filter((entry) => entry.type === 'info' && entry.message)
    .map((entry) => entry.message as string)
    .join('\n\n');
  const findings = [
    /Current provider: provider-main/.test(transcript) ? null : 'missing provider summary',
    /Current model: gpt-5.4/.test(transcript) ? null : 'missing model summary',
    /Permission mode: ask/.test(transcript) ? null : 'missing permission guidance',
    /Skill catalog:/.test(transcript) ? null : 'missing skill catalog guidance',
    /Configured MCP servers:/.test(transcript) ? null : 'missing MCP guidance',
    /Selected agent: review/.test(transcript) ? null : 'missing agent selection guidance',
    /Reduction ratio:/.test(transcript) ? null : 'missing compact guidance',
    /Provider billing: unavailable in local default runtime/.test(transcript) ? null : 'missing cost guidance'
  ].filter((entry): entry is string => Boolean(entry));

  return {
    scenario: 'cli-capability-commands',
    family: 'capability-commands',
    passed: findings.length === 0,
    summary: findings.length === 0
      ? 'Capability slash commands expose summary-first provider, model, permission, skill, MCP, agent, compact, and cost guidance.'
      : 'Capability slash commands are missing required summary-first guidance.',
    findings,
    transcriptExcerpt: transcript.split('\n').slice(0, 24)
  };
}

async function runArtifactRoutingScenario(): Promise<CliInteractionTranscriptScenarioResult> {
  const envelopes: Array<{ type?: string; message?: string }> = [];
  const commandSink: Array<Record<string, unknown>> = [];
  const debug = buildTaskDebug({
    issueCategory: 'artifact_destination_unresolved',
    artifactPathState: 'unresolved',
    pendingArtifactCount: 1,
    recommendedArtifactDir: 'backend/docs',
    artifactPaths: ['output/manifest.json'],
    turnContract: {
      currentUnitId: 'AGENT-001',
      pendingCorrection: 'NONE',
      requiresToolEvidence: false,
      lastAcceptanceFailureCategory: null,
      lastPendingCorrectionKind: null,
      lastCorrectionPromptMode: 'none',
      correctionLoopNonConvergent: false,
      conservativeMode: false,
      continueAllowed: false,
      continueReason: 'The task produced or will produce files, but no project-relative destination is selected.'
    }
  });
  debug.task.statusSummary = {
    label: 'Use recommended path',
    detail: 'The task produced or will produce files, but no project-relative destination is selected.',
    tone: 'action_required'
  };
  debug.task.primaryAction = {
    kind: 'use_recommended_path',
    label: 'Use recommended path',
    description: 'Artifacts are ready in the task workspace. Use backend/docs or choose a custom destination.',
    destinationDir: 'backend/docs'
  };
  debug.task.nextActionSummary = {
    label: 'Use recommended path',
    reason: 'Artifacts are ready in the task workspace. Use backend/docs or choose a custom destination.'
  };
  const fetchImpl = createCapabilityFetch({ debug, commandSink });
  const controller = new CliChatSessionController({
    mode: 'workspace',
    context: {
      args: { command: [], flags: {} },
      fetchImpl: fetchImpl as typeof fetch,
      io: { stdout: { write() {} }, stderr: { write() {} } },
      stdin: process.stdin,
      createWebSocket: () => {
        throw new Error('websocket not needed');
      },
      sleep: async () => {},
      serverUrl: 'http://127.0.0.1:3011'
    },
    args: { command: [], flags: {} },
    outputFormat: 'human',
    onEnvelope: (envelope: any) => {
      envelopes.push({
        type: envelope.type,
        message: envelope.type === 'info' ? envelope.message : undefined
      });
    }
  });
  controller.state.activeTaskId = 'task-1';
  controller.state.latestTaskSummary = {
    taskId: 'task-1',
    title: 'Task 1',
    lifecycleStatus: 'RUNNING',
    statusSummary: {
      label: 'Use recommended path',
      detail: 'The task produced or will produce files, but no project-relative destination is selected.',
      tone: 'action_required'
    },
    primaryAction: {
      kind: 'use_recommended_path',
      label: 'Use recommended path',
      description: 'Artifacts are ready in the task workspace. Use backend/docs or choose a custom destination.',
      destinationDir: 'backend/docs'
    },
    nextActionSummary: {
      label: 'Use recommended path',
      reason: 'Artifacts are ready in the task workspace. Use backend/docs or choose a custom destination.'
    },
    progressState: 'awaiting_continue',
    stageLabel: 'Stage 1 of 1',
    blockingReason: 'The task produced or will produce files, but no project-relative destination is selected.',
    nextAction: 'Use recommended path',
    nextActionReason: 'The task produced or will produce files, but no project-relative destination is selected.',
    providerSummary: {
      providerId: 'provider-main',
      modelId: 'gpt-5.4',
      variantId: 'reasoning',
      selectedBy: 'config_default',
      readiness: 'ready',
      authSource: 'secret-store',
      recentStatus: 'selected'
    },
    skillSummary: { configuredCount: 1, availableCount: 1, invokedCount: 0 },
    instructionSkillSummary: { configuredCount: 1, selectedCount: 1 },
    mcpSummary: {
      selectedServerIds: ['docs'],
      selectedTools: ['search_docs'],
      selectedResources: ['docs://runbook'],
      selectedPrompts: ['triage'],
      readinessSummary: { ready: ['docs'], missingClient: [], metadataOnly: [] }
    },
    permissionSummary: { mode: 'full', approvalRequiredCount: 0, deniedCount: 0 },
    agentSummary: { selectedAgent: 'review', selectedBy: 'workspace_agent' },
    hookSummary: { executedCount: 0, failedCount: 0 },
    capabilityWarnings: [],
    artifactPathState: 'unresolved',
    pendingArtifactCount: 1,
    selectedArtifactDir: null,
    recommendedArtifactDir: 'backend/docs',
    artifactPaths: ['output/manifest.json'],
    lastArtifactApplyAt: null,
    lastArtifactApplyResult: null
  };

  await controller.handleInput('/path');
  await controller.handleInput('/artifacts');
  await controller.handleInput('/apply backend/docs');

  const transcript = envelopes
    .filter((entry) => entry.type === 'info' && entry.message)
    .map((entry) => entry.message as string)
    .join('\n\n');
  const applyPayload = commandSink.at(-1);
  const findings = [
    /Artifact path state: unresolved/.test(transcript) ? null : 'missing unresolved path guidance',
    /Recommended destination: backend\/docs/.test(transcript) ? null : 'missing recommended directory guidance',
    /Sandbox artifacts:/.test(transcript) ? null : 'missing artifact inventory output',
    applyPayload?.type === 'APPLY_ARTIFACTS' ? null : 'missing apply command dispatch',
    applyPayload?.metadata && (applyPayload.metadata as Record<string, unknown>).destinationDir === 'backend/docs'
      ? null
      : 'apply command did not preserve destinationDir'
  ].filter((entry): entry is string => Boolean(entry));

  return {
    scenario: 'cli-artifact-routing-commands',
    family: 'artifact-routing-commands',
    passed: findings.length === 0,
    summary: findings.length === 0
      ? 'Path and artifact slash commands explain unresolved destinations and dispatch explicit apply commands.'
      : 'Path and artifact slash commands are missing explicit routing guidance or apply dispatch.',
    findings,
    transcriptExcerpt: transcript.split('\n').slice(0, 24)
  };
}

async function runApprovalRecoveryScenario(): Promise<CliInteractionTranscriptScenarioResult> {
  const approvalSink: Array<Record<string, unknown>> = [];
  const debug = buildTaskDebug() as any;
  debug.task.pendingApprovals = [{
    invocationId: 'approval-1',
    taskId: 'task-1',
    toolId: 'write-file',
    status: 'PENDING',
    requestedAt: Date.now(),
    expiresAt: null,
    arguments: { path: 'report.md' }
  }];
  debug.task.statusSummary = {
    label: 'Approval required',
    detail: '1 tool approval(s) are blocking runtime progress.',
    tone: 'action_required'
  };
  debug.task.primaryAction = {
    kind: 'approve',
    label: 'Resolve approvals',
    description: 'Approve or reject the blocked tool invocation before sending any continue message.',
    destinationDir: null
  };
  debug.task.nextActionSummary = {
    label: 'Resolve approvals',
    reason: 'Approve or reject the blocked tool invocation before sending any continue message.'
  };
  const fetchImpl = createCapabilityFetch({ debug, approvalSink });

  const statusIo = createMockIo();
  await runBackendNewCli({
    argv: ['tasks', 'status', 'task-1'],
    fetchImpl: fetchImpl as typeof fetch,
    io: statusIo
  });
  const diagnosticsIo = createMockIo();
  await runBackendNewCli({
    argv: ['tasks', 'diagnostics', 'task-1'],
    fetchImpl: fetchImpl as typeof fetch,
    io: diagnosticsIo
  });
  await runBackendNewCli({
    argv: ['tasks', 'approve', 'task-1', 'approval-1', 'APPROVED', '--reason', 'ship it'],
    fetchImpl: fetchImpl as typeof fetch,
    io: createMockIo()
  });

  const statusText = statusIo.readStdout();
  const diagnosticsText = diagnosticsIo.readStdout();
  const findings = [
    /"blockingReason":\s*"1 tool approval\(s\) are blocking runtime progress\./.test(statusText)
      ? null
      : 'tasks status missing approval blocker guidance',
    /"nextAction":\s*"Resolve approvals"/.test(statusText)
      ? null
      : 'tasks status missing next action guidance',
    /"approvalCount":\s*1/.test(diagnosticsText) || /"pendingApprovals"/.test(diagnosticsText)
      ? null
      : 'tasks diagnostics missing approval visibility',
    approvalSink.at(-1)?.status === 'APPROVED' ? null : 'tasks approve did not dispatch approval resolution',
    approvalSink.at(-1)?.reason === 'ship it' ? null : 'tasks approve did not preserve reason'
  ].filter((entry): entry is string => Boolean(entry));

  return {
    scenario: 'cli-approval-recovery-guidance',
    family: 'approval-recovery-guidance',
    passed: findings.length === 0,
    summary: findings.length === 0
      ? 'CLI status, diagnostics, and approval commands preserve summary-first approval recovery guidance.'
      : 'CLI approval recovery transcript is missing blocker guidance or approval dispatch details.',
    findings,
    transcriptExcerpt: [...statusText.split('\n').slice(0, 12), ...diagnosticsText.split('\n').slice(0, 12)]
  };
}

async function runWatchTailStreamScenario(): Promise<CliInteractionTranscriptScenarioResult> {
  let currentPhase: 'running' | 'completed' = 'running';
  const running = buildTaskDebug() as any;
  const completed = buildTaskDebug({
    issueSummary: 'The task reached a terminal completed state.',
    turnContract: {
      currentUnitId: null,
      pendingCorrection: 'NONE',
      requiresToolEvidence: false,
      lastAcceptanceFailureCategory: null,
      lastPendingCorrectionKind: null,
      lastCorrectionPromptMode: 'none',
      correctionLoopNonConvergent: false,
      conservativeMode: false,
      continueAllowed: false,
      continueReason: 'Task lifecycle is COMPLETED, so continue is not allowed.'
    }
  }) as any;
  completed.task.runtime.lifecycleStatus = 'COMPLETED';
  completed.task.runtime.engineStatus = 'IDLE';
  completed.task.runtime.currentUnitId = null;

  const fetchImpl = async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/tasks/task-1') {
      return createResponse(currentPhase === 'completed' ? completed.task : running.task);
    }
    if (parsed.pathname === '/tasks/task-1/debug') {
      return createResponse(currentPhase === 'completed' ? completed : running);
    }
    if (parsed.pathname === '/tasks/task-1/events') {
      return createResponse([]);
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };
  const wsMessages = [
    { kind: 'ready', taskId: 'task-1', latestEventId: 'evt-0' },
    { kind: 'subscribed', taskId: 'task-1', latestEventId: 'evt-0' },
    { kind: 'runtime_event', taskId: 'task-1', event: 'TASK_STARTED', data: { type: 'TASK_STARTED', eventId: 'evt-1', taskId: 'task-1' }, latestEventId: 'evt-1' },
    () => {
      currentPhase = 'completed';
      return {
        kind: 'runtime_event',
        taskId: 'task-1',
        event: 'TASK_COMPLETED',
        data: { type: 'TASK_COMPLETED', eventId: 'evt-2', taskId: 'task-1' },
        latestEventId: 'evt-2'
      };
    }
  ];

  async function runMode(mode: 'watch' | 'tail' | 'stream') {
    currentPhase = 'running';
    const io = createMockIo();
    await runBackendNewCli({
      argv: ['tasks', mode, 'task-1'],
      fetchImpl: fetchImpl as typeof fetch,
      io,
      createWebSocket: () => new ScriptedWebSocket(wsMessages) as never
    });
    return {
      stdout: io.readStdout(),
      stderr: io.readStderr()
    };
  }

  const watch = await runMode('watch');
  const tail = await runMode('tail');
  const stream = await runMode('stream');

  const findings = [
    /TASK_STARTED/.test(watch.stdout) && /next=Continue current thread/.test(watch.stdout)
      ? null
      : 'watch output missing running summary guidance',
    /TASK_COMPLETED/.test(tail.stdout) && /next=Continue current thread/.test(tail.stdout)
      ? null
      : 'tail output missing completed summary guidance',
    /"kind":"runtime_event"/.test(stream.stdout) && /"progressState":"completed"/.test(stream.stdout)
      ? null
      : 'stream output missing structured completed summary',
    watch.stderr.trim().length === 0 && tail.stderr.trim().length === 0 && stream.stderr.trim().length === 0
      ? null
      : 'watch/tail/stream emitted unexpected transport errors'
  ].filter((entry): entry is string => Boolean(entry));

  return {
    scenario: 'cli-watch-tail-stream-consistency',
    family: 'watch-tail-stream-consistency',
    passed: findings.length === 0,
    summary: findings.length === 0
      ? 'Watch, tail, and stream preserve consistent task status and next-action guidance across output modes.'
      : 'Watch, tail, and stream diverged on task status or next-action guidance.',
    findings,
    transcriptExcerpt: [...watch.stdout.split('\n').slice(0, 8), ...tail.stdout.split('\n').slice(0, 8), ...stream.stdout.split('\n').slice(0, 8)]
  };
}

export async function runCliInteractionTranscriptSuite(): Promise<CliInteractionTranscriptSuiteResult> {
  const scenarios = await Promise.all([
    runCapabilityCommandsScenario(),
    runArtifactRoutingScenario(),
    runApprovalRecoveryScenario(),
    runWatchTailStreamScenario()
  ]);

  let passed = 0;
  let failed = 0;
  const byFamily: Record<CliInteractionTranscriptFamily, number> = {
    'capability-commands': 0,
    'artifact-routing-commands': 0,
    'approval-recovery-guidance': 0,
    'watch-tail-stream-consistency': 0
  };
  const byFailureCategory: Record<string, number> = {};

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
      for (const finding of scenario.findings) {
        byFailureCategory[finding] = (byFailureCategory[finding] ?? 0) + 1;
      }
    }
  }

  return {
    generatedAt: Date.now(),
    status: failed === 0 ? 'achieved' : 'open_gap',
    scenarios,
    totals: {
      total: scenarios.length,
      passed,
      failed,
      successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      artifactEvidencePassRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      byFamily,
      byFailureCategory
    }
  };
}
