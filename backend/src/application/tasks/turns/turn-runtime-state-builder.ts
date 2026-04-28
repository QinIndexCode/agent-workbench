import {
  AcceptanceFailureCategory,
  CorrectionPromptMode,
  LlmContextMessage,
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile
} from '../../../domain/contracts/types';
import { createContextCompressionPolicy } from '../../../domain/runtime/context-compression-policy';
import {
  appendAndCompressLlmContext,
  createContextSnapshotRef,
  createLlmContextMessage
} from '../../../domain/runtime/context-manager';
import { evolveTaskMemory, evolveUserPreferenceProfile } from '../../../domain/runtime/memory';
import {
  applyCorrectionState,
  applyTrackerState,
  applyTrackerStates
} from '../../../domain/runtime/state-transition-applier';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { ToolInvocationRecord } from '../../../foundation/repository/types';
import { evaluateTaskQuality } from '../../../domain/quality/task-quality';
import { TaskPlannerService } from '../planning/task-planner-service';
import { TurnContextAssemblyResult } from './turn-context-assembly';
import { TurnPhaseOutcome } from './turn-phase-types';

export interface TurnRuntimeStateBuildResult {
  nextRuntime: TaskRuntimeState;
  updatedUserProfile: UserPreferenceProfile;
}

function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function stringifyContextValue(value: unknown, maxChars: number): string {
  const rendered = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? null);
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(0, maxChars - 3))}...`;
}

function stringifyContextMetadataValue(value: unknown, maxChars: number): string {
  if (typeof value === 'string') {
    return stringifyContextValue(value, maxChars);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return stringifyContextValue(value, maxChars);
}

function mergedInvocationResultAndMetadata(invocation: ToolInvocationRecord): Record<string, unknown> {
  const result = invocation.result && typeof invocation.result === 'object' && !Array.isArray(invocation.result)
    ? invocation.result
    : {};
  const metadata = invocation.metadata && typeof invocation.metadata === 'object'
    ? invocation.metadata
    : {};
  return { ...metadata, ...result };
}

function buildRunCommandResultContext(invocation: ToolInvocationRecord, maxContentChars: number): string {
  const metadata = mergedInvocationResultAndMetadata(invocation);
  const command = stringifyContextMetadataValue(
    metadata.effectiveCommand ?? metadata.command ?? invocation.arguments.command ?? invocation.arguments.cmd,
    800
  );
  const originalCommand = stringifyContextMetadataValue(
    metadata.originalCommand ?? metadata.requestedCommand ?? invocation.arguments.command ?? invocation.arguments.cmd,
    800
  );
  const cwd = stringifyContextMetadataValue(metadata.cwd, 600);
  const exitCode = metadata.exitCode === undefined ? 'unknown' : String(metadata.exitCode);
  const timeoutMs = metadata.timeoutMs === undefined ? null : String(metadata.timeoutMs);
  const durationMs = metadata.durationMs === undefined ? null : String(metadata.durationMs);
  const stdout = stringifyContextMetadataValue(metadata.stdout, Math.max(400, Math.floor(maxContentChars / 2)));
  const stderr = stringifyContextMetadataValue(metadata.stderr, Math.max(400, Math.floor(maxContentChars / 2)));
  const didSucceed = invocation.status === 'SUCCEEDED';
  const lines = [
    didSucceed
      ? `Tool run_command succeeded with exit code ${exitCode}.`
      : `Tool run_command failed: ${invocation.error ?? 'unknown error'}`,
    `Exit code: ${exitCode}.`,
    ...(metadata.timedOut === true ? [`Timed out: true${timeoutMs ? ` after ${timeoutMs}ms` : ''}.`] : []),
    ...(durationMs ? [`DurationMs: ${durationMs}.`] : []),
    ...(originalCommand ? [`Requested command: ${originalCommand}`] : []),
    ...(command && command !== originalCommand ? [`Executed command: ${command}`] : []),
    ...(cwd ? [`cwd: ${cwd}`] : []),
    'stdout:',
    stdout || '(empty)',
    'stderr:',
    stderr || '(empty)'
  ];
  return lines.join('\n');
}

function buildToolContextMessageContent(invocation: ToolInvocationRecord, maxContentChars: number): string {
  const normalizedToolId = normalizeToolId(invocation.toolId);
  if (invocation.status === 'SUCCEEDED' && normalizedToolId === 'read_file') {
    const output = invocation.result && typeof invocation.result === 'object' && !Array.isArray(invocation.result)
      ? invocation.result as Record<string, unknown>
      : null;
    const content = typeof output?.content === 'string' ? output.content : '';
    const path = normalizeWorkspaceRelativePath(output?.path)
      ?? normalizeWorkspaceRelativePath(invocation.arguments.path)
      ?? invocation.toolId;
    const selection = output?.selection && typeof output.selection === 'object' && !Array.isArray(output.selection)
      ? output.selection as Record<string, unknown>
      : null;
    const startLine = typeof selection?.startLine === 'number' ? selection.startLine : 1;
    const endLine = typeof selection?.endLine === 'number' ? selection.endLine : null;
    const totalLines = typeof selection?.totalLines === 'number' ? selection.totalLines : null;
    const selectedChars = typeof output?.selectedChars === 'number' ? output.selectedChars : content.length;
    const totalChars = typeof output?.totalChars === 'number' ? output.totalChars : content.length;
    const truncated = output?.truncated === true;
    const excerpt = stringifyContextValue(content, maxContentChars);
    return [
      `Tool read_file succeeded for ${path}.`,
      `Selection: lines ${startLine}-${endLine ?? startLine}${totalLines ? ` of ${totalLines}` : ''}; chars ${selectedChars}/${totalChars}${truncated ? ' (truncated)' : ''}.`,
      'Selected file content:',
      excerpt
    ].join('\n');
  }
  if (invocation.status === 'SUCCEEDED' && normalizedToolId === 'run_command') {
    return buildRunCommandResultContext(invocation, maxContentChars);
  }
  if (invocation.status === 'SUCCEEDED') {
    return [
      `Tool ${normalizedToolId} succeeded.`,
      `Result: ${stringifyContextValue(invocation.result ?? null, maxContentChars)}`
    ].join('\n');
  }
  if (invocation.status === 'FAILED' && normalizedToolId === 'run_command') {
    return buildRunCommandResultContext(invocation, maxContentChars);
  }
  return [
    `Tool ${normalizedToolId} ${invocation.status.toLowerCase()}: ${invocation.error ?? 'unknown error'}`,
    `Arguments: ${stringifyContextValue(invocation.arguments ?? null, Math.max(400, Math.floor(maxContentChars / 2)))}`,
    `Metadata: ${stringifyContextValue(invocation.metadata ?? null, Math.max(400, Math.floor(maxContentChars / 2)))}`
  ].join('\n');
}

export function buildCurrentTurnToolContextMessages(params: {
  invocations: ToolInvocationRecord[];
  currentUnitId: string;
  turnId: string;
  maxContentChars: number;
  maxMessages?: number;
}): LlmContextMessage[] {
  const selectedInvocations = params.invocations
    .filter((invocation) => (
      invocation.unitId === params.currentUnitId
      && invocation.turnId === params.turnId
      && (invocation.status === 'SUCCEEDED' || invocation.status === 'FAILED' || invocation.status === 'DENIED')
    ))
    .sort((left, right) => {
      const leftTimestamp = left.endedAt ?? left.startedAt ?? 0;
      const rightTimestamp = right.endedAt ?? right.startedAt ?? 0;
      return leftTimestamp - rightTimestamp;
    })
    .slice(-(params.maxMessages ?? 4));
  return selectedInvocations.map((invocation) => createLlmContextMessage({
    role: 'tool',
    content: buildToolContextMessageContent(invocation, params.maxContentChars),
    metadata: {
      unitId: invocation.unitId,
      source: 'tool_result',
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      status: invocation.status,
      turnId: invocation.turnId
    }
  }));
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isMaterializingWriteTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'run_command';
}

function isVerificationEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'read_file'
    || normalized === 'search_files'
    || normalized === 'list_files'
    || normalized === 'run_command';
}

function collectInvocationEvidencePaths(invocation: Pick<ToolInvocationRecord, 'arguments' | 'result'>): string[] {
  const candidates = [
    invocation.result?.path,
    invocation.result?.file,
    invocation.result?.output_path,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).path
      : undefined,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).file
      : undefined,
    invocation.arguments.path,
    invocation.arguments.file,
    invocation.arguments.file_path,
    invocation.arguments.output
  ];
  return candidates
    .map((value) => normalizeWorkspaceRelativePath(value))
    .filter((value): value is string => !!value);
}

function collectTrackerArtifactPaths(trackers: Array<{ filesCreated?: string[] }>): string[] {
  const evidence = new Set<string>();
  for (const tracker of trackers) {
    for (const filePath of tracker.filesCreated ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath);
      if (normalized) {
        evidence.add(normalized);
      }
    }
  }
  return [...evidence];
}

function summarizeUnitToolEvidence(invocations: ToolInvocationRecord[], unitId: string) {
  let successfulMaterializingToolCount = 0;
  let successfulVerificationToolCount = 0;
  const successfulWriteEvidencePaths = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.unitId !== unitId || invocation.status !== 'SUCCEEDED') {
      continue;
    }
    if (isMaterializingWriteTool(invocation.toolId)) {
      successfulMaterializingToolCount += 1;
      for (const path of collectInvocationEvidencePaths(invocation)) {
        successfulWriteEvidencePaths.add(path);
      }
    }
    if (isVerificationEvidenceTool(invocation.toolId)) {
      successfulVerificationToolCount += 1;
    }
  }
  return {
    successfulMaterializingToolCount,
    successfulVerificationToolCount,
    successfulWriteEvidencePaths: [...successfulWriteEvidencePaths]
  };
}

function deriveEffectiveAcceptanceState(params: {
  currentUnit: TaskDefinition['units'][number] | null;
  diagnosticsAcceptance: TurnPhaseOutcome['orchestrated']['acceptance'];
  latestToolInvocations: ToolInvocationRecord[];
  acceptedTrackers: TurnPhaseOutcome['acceptedTrackers'];
  qualityGateFailed: boolean;
}) {
  if (!params.currentUnit || params.qualityGateFailed) {
    return {
      pendingCorrection: params.diagnosticsAcceptance.ok ? 'NONE' as const : params.diagnosticsAcceptance.pendingCorrection,
      failureCategory: params.diagnosticsAcceptance.ok
        ? null
        : (
          params.diagnosticsAcceptance.failureCategory
          ?? (params.diagnosticsAcceptance.pendingCorrection === 'AWAITING_TOOL_ACTION'
            ? 'tool_action_required_but_not_emitted'
            : null)
        ),
      issueCodes: params.diagnosticsAcceptance.issues.map((issue) => issue.code),
      issueMessages: params.diagnosticsAcceptance.issues.map((issue) => issue.message)
    };
  }

  const issueCodes = params.diagnosticsAcceptance.issues.map((issue) => issue.code);
  const issueMessages = params.diagnosticsAcceptance.issues.map((issue) => issue.message);
  const executionProfileId = params.currentUnit.executionProfileId ?? 'analyze';
  const unitEvidence = summarizeUnitToolEvidence(params.latestToolInvocations, params.currentUnit.id);
  const declaredArtifactPaths = collectTrackerArtifactPaths(params.acceptedTrackers.filter((tracker) => tracker.currentUnit === params.currentUnit?.id));
  const hasMatchingArtifactWrite = declaredArtifactPaths.length > 0
    && declaredArtifactPaths.some((artifactPath) => unitEvidence.successfulWriteEvidencePaths.includes(artifactPath));

  if (executionProfileId === 'implement' && unitEvidence.successfulMaterializingToolCount === 0) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'artifact_write_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_persistent_write_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" did not produce a persistent write for implement completion.`
      ]
    };
  }

  if (
    executionProfileId === 'implement'
    && (issueCodes.includes('missing_persistent_effect_evidence') || (declaredArtifactPaths.length > 0 && !hasMatchingArtifactWrite))
  ) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'artifact_write_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_persistent_write_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" still lacks persistent write evidence for required artifact delivery.`
      ]
    };
  }

  if (
    executionProfileId === 'verify'
    && (unitEvidence.successfulVerificationToolCount === 0 || issueCodes.includes('missing_verification_evidence'))
  ) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'tool_action_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_verification_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" still lacks successful verification evidence.`
      ]
    };
  }

  return {
    pendingCorrection: params.diagnosticsAcceptance.pendingCorrection,
    failureCategory: params.diagnosticsAcceptance.failureCategory
      ?? (params.diagnosticsAcceptance.pendingCorrection === 'AWAITING_TOOL_ACTION'
        ? 'tool_action_required_but_not_emitted'
        : null),
    issueCodes,
    issueMessages
  };
}

function deriveCorrectionPromptMode(params: {
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
  failureCategory: AcceptanceFailureCategory | null;
}): CorrectionPromptMode {
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    return 'TARGETED_TRACKER';
  }
  if (
    params.pendingCorrection === 'AWAITING_TOOL_ACTION'
    || params.failureCategory === 'tool_action_required_but_not_emitted'
    || params.failureCategory === 'artifact_write_required_but_not_emitted'
    || params.failureCategory === 'required_delegation_missing'
  ) {
    return 'TARGETED_TOOL_ACTION';
  }
  if (params.pendingCorrection === 'AWAITING_BLOCKER_EXPLANATION') {
    return 'TARGETED_BLOCKER_EXPLANATION';
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return 'TARGETED_OUTPUT';
  }
  return 'FULL_PROTOCOL';
}

function computeGuardrails(params: {
  previousRuntime: TaskRuntimeState;
  fallbackTurn: boolean;
  phaseOutcome: TurnPhaseOutcome;
}): NonNullable<TaskRuntimeState['guardrails']> {
  const previous = params.previousRuntime.guardrails;
  const correctionTurn = params.phaseOutcome.consolidationState.status === 'CORRECTION_REQUIRED';
  const approvalBlockedTurn = params.phaseOutcome.pendingToolBatches.some((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED');
  const correctionStreak = correctionTurn ? ((previous?.correctionStreak ?? 0) + 1) : 0;
  const fallbackStreak = params.fallbackTurn ? ((previous?.fallbackStreak ?? 0) + 1) : 0;
  const approvalBlockedBatchStreak = approvalBlockedTurn ? ((previous?.approvalBlockedBatchStreak ?? 0) + 1) : 0;
  const compressionDowngraded = correctionStreak >= 1 || fallbackStreak >= 1 || approvalBlockedBatchStreak >= 1;
  const batchAdmissionRestricted = !!params.phaseOutcome.batchGuardrail?.batchAdmissionRestricted || fallbackStreak >= 2 || approvalBlockedBatchStreak >= 1;
  return {
    correctionStreak,
    fallbackStreak,
    approvalBlockedBatchStreak,
    compressionDowngraded,
    batchAdmissionRestricted,
    plannerFallbackRate: Number((params.fallbackTurn ? 1 : 0).toFixed(4))
  };
}

export function buildTurnRuntimeState(params: {
  foundation: BackendNewFoundation;
  plannerService: TaskPlannerService;
  definition: TaskDefinition;
  previousRuntime: TaskRuntimeState;
  assembled: Pick<
    TurnContextAssemblyResult,
    | 'userProfile'
    | 'selectedProvider'
    | 'prompt'
    | 'promptResult'
    | 'contextMessages'
    | 'contextGatingSummary'
    | 'existingConversations'
    | 'estimatedPromptCharacters'
    | 'estimatedBaselineCharacters'
    | 'estimatedReductionRatio'
    | 'selectedValidatedOutputs'
    | 'pendingOperatorInputs'
    | 'stageMemorySummary'
    | 'capabilitySelectionSummary'
    | 'retrievalSelectionSummary'
  >;
  userMessage: string | undefined;
  currentUnitId: string;
  checkpointId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  providerResponseText: string;
  plannerPreferred: boolean;
  phaseOutcome: TurnPhaseOutcome;
  latestRuntimeAfterProvider: TaskRuntimeState;
  latestToolInvocations: ToolInvocationRecord[];
}): TurnRuntimeStateBuildResult {
  const currentUnit = params.definition.units.find((unit) => unit.id === params.currentUnitId) ?? null;
  const latestAcceptedOutput = params.phaseOutcome.acceptedOutputs?.at(-1);
  const qualityEvaluation = currentUnit
    ? evaluateTaskQuality({
      taskId: params.definition.taskId,
      title: params.definition.title,
      intent: params.definition.intent,
      unitId: currentUnit.id,
      executionProfileId: currentUnit.executionProfileId ?? 'analyze',
      qualityProfileId: currentUnit.qualityProfileId ?? null,
      workspaceDir: params.foundation.layout.forTask(params.definition.taskId).workspaceDir,
      artifactPaths: [],
      artifactDestinationPaths: [],
      artifactDestinationDir: null,
      latestVisibleOutput: latestAcceptedOutput
        ? {
          summary: typeof latestAcceptedOutput.parsedJson === 'object' && latestAcceptedOutput.parsedJson && 'summary' in latestAcceptedOutput.parsedJson
            ? String((latestAcceptedOutput.parsedJson as Record<string, unknown>).summary ?? '')
            : '',
          details: typeof latestAcceptedOutput.parsedJson === 'object' && latestAcceptedOutput.parsedJson && 'details' in latestAcceptedOutput.parsedJson
            ? String((latestAcceptedOutput.parsedJson as Record<string, unknown>).details ?? '')
            : null,
          issues: Array.isArray((latestAcceptedOutput.parsedJson as Record<string, unknown> | null)?.issues)
            ? ((latestAcceptedOutput.parsedJson as Record<string, unknown>).issues as unknown[])
              .filter((issue): issue is string => typeof issue === 'string')
            : []
        }
        : null,
      completionSummary: null,
      toolInvocations: params.latestToolInvocations
    })
    : {
      profileId: null,
      verdict: 'not_applicable' as const,
      passedChecks: [],
      failedChecks: [],
      requiredNextEvidence: [],
      lastEvaluatedAt: null
    };
  const qualityGateFailed = qualityEvaluation.profileId !== null && qualityEvaluation.verdict === 'failed';
  const qualityFailureMessages = qualityEvaluation.failedChecks.map((issue) => `quality_gate_failed:${issue}`);
  const qualityRequiredEvidenceMessages = qualityEvaluation.requiredNextEvidence.map((item) => `quality_required_evidence:${item}`);
  const qualityCorrectionKind = qualityGateFailed
    ? (qualityEvaluation.requiredNextEvidence.length > 0 ? 'AWAITING_TOOL_ACTION' : 'AWAITING_OUTPUT_CORRECTION')
    : params.phaseOutcome.orchestrated.acceptance.pendingCorrection;
  const diagnosticsAcceptance = params.phaseOutcome.diagnosticsAcceptance ?? params.phaseOutcome.orchestrated.acceptance;
  const effectiveAcceptance = deriveEffectiveAcceptanceState({
    currentUnit,
    diagnosticsAcceptance,
    latestToolInvocations: params.latestToolInvocations,
    acceptedTrackers: params.phaseOutcome.acceptedTrackers,
    qualityGateFailed
  });
  const effectivePendingCorrection = qualityGateFailed
    ? qualityCorrectionKind
    : effectiveAcceptance.pendingCorrection;
  const runtimeWithAcceptedTrackers = params.phaseOutcome.acceptedTrackers.length === 0
    ? params.previousRuntime
    : (params.phaseOutcome.acceptedTrackers.length === 1
      ? applyTrackerState({
        definition: params.definition,
        runtime: params.previousRuntime,
        tracker: params.phaseOutcome.acceptedTrackers[0],
        acceptedInvocationIds: params.phaseOutcome.plannedTools.acceptedInvocationIds,
        approvalInvocationIds: params.phaseOutcome.plannedTools.approvalInvocationIds,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        providerId: params.assembled.selectedProvider.id
      })
      : applyTrackerStates({
        definition: params.definition,
        runtime: params.previousRuntime,
        trackers: params.phaseOutcome.acceptedTrackers,
        acceptedInvocationIds: params.phaseOutcome.plannedTools.acceptedInvocationIds,
        approvalInvocationIds: params.phaseOutcome.plannedTools.approvalInvocationIds,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        providerId: params.assembled.selectedProvider.id
      }));
  const nextRuntimeBase = params.phaseOutcome.orchestrated.acceptance.ok
    && params.phaseOutcome.acceptedTrackers.length > 0
    && !qualityGateFailed
    ? runtimeWithAcceptedTrackers
    : applyCorrectionState({
      definition: params.definition,
      runtime: runtimeWithAcceptedTrackers,
      currentUnitId: params.phaseOutcome.correctionUnitId,
      kind: effectivePendingCorrection,
      errors: qualityGateFailed
        ? [...qualityFailureMessages, ...qualityRequiredEvidenceMessages]
        : effectiveAcceptance.issueMessages,
      acceptedInvocationIds: params.phaseOutcome.plannedTools.acceptedInvocationIds,
      approvalInvocationIds: params.phaseOutcome.plannedTools.approvalInvocationIds,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      providerId: params.assembled.selectedProvider.id
    });

  const updatedUserProfile = evolveUserPreferenceProfile({
    current: params.assembled.userProfile,
    userMessage: params.userMessage,
    selectedProviderId: params.assembled.selectedProvider.id
  });
  const updatedTaskMemory = evolveTaskMemory({
    current: params.previousRuntime.memory ?? null,
    userMessage: params.userMessage,
    acceptedTracker: params.phaseOutcome.acceptedTrackers.at(-1) ?? null,
    acceptedOutput: latestAcceptedOutput
      ? {
        unitId: latestAcceptedOutput.unitId,
        wrapper: latestAcceptedOutput.wrapper,
        raw: latestAcceptedOutput.raw,
        parsedJson: latestAcceptedOutput.parsedJson
      }
      : params.phaseOutcome.orchestrated.acceptance.acceptedOutput,
    selectedProviderId: params.assembled.selectedProvider.id,
    userProfile: updatedUserProfile
  });
  const nextPlannerDiagnostics = params.plannerService.summarizeTurn(params.definition, nextRuntimeBase);
  const acceptanceFailureCategory = qualityGateFailed
    ? 'quality_gate_failed'
    : effectiveAcceptance.failureCategory;
  const fallbackTurn = !params.plannerPreferred;
  const nextGuardrails = computeGuardrails({
    previousRuntime: params.previousRuntime,
    fallbackTurn,
    phaseOutcome: params.phaseOutcome
  });
  const currentTurnToolContextMessages = buildCurrentTurnToolContextMessages({
    invocations: params.latestToolInvocations,
    currentUnitId: params.currentUnitId,
    turnId: params.turnId,
    maxContentChars: Math.max(1200, Math.floor(params.foundation.config.runtime.promptSectionCharacterLimit * 2.5))
  });
  const nextContext = appendAndCompressLlmContext({
    config: params.foundation.config,
    current: params.assembled.contextMessages.messages,
    conservative: nextGuardrails.compressionDowngraded,
    additions: [
      createLlmContextMessage({
        role: 'assistant',
        content: params.providerResponseText,
        metadata: {
          unitId: params.currentUnitId
        }
      }),
      ...currentTurnToolContextMessages
    ]
  });
  const compressionPolicy = createContextCompressionPolicy({
    definition: params.definition,
    runtime: {
      ...nextRuntimeBase,
      activeStage: nextPlannerDiagnostics.activeStage,
      pendingToolBatches: params.phaseOutcome.pendingToolBatches,
      consolidationState: params.phaseOutcome.consolidationState,
      planner: {
        ...nextPlannerDiagnostics.planner,
        executionPhase: params.plannerPreferred ? 'CONSOLIDATING' : 'FALLBACK_SINGLE_ACTIVE'
      }
    },
    currentUnit: params.definition.units.find((unit) => unit.id === params.currentUnitId) ?? params.definition.units[0],
    validatedOutputs: params.assembled.selectedValidatedOutputs.records,
    memory: updatedTaskMemory
  });
  const nextRuntime: TaskRuntimeState = {
    ...nextRuntimeBase,
    planner: {
      ...nextPlannerDiagnostics.planner,
      executionPhase: params.plannerPreferred
        ? (params.phaseOutcome.consolidationState.status === 'COMPLETED' ? 'IDLE' : 'CONSOLIDATING')
        : 'FALLBACK_SINGLE_ACTIVE',
      fallbackReasons: params.plannerPreferred
        ? [...nextPlannerDiagnostics.planner.fallbackReasons]
        : [
          ...(params.latestRuntimeAfterProvider.planner?.fallbackReasons ?? []),
          'single_active_runtime_path'
        ],
      blockingReason: params.plannerPreferred && params.phaseOutcome.consolidationState.status === 'CORRECTION_REQUIRED'
        ? (params.phaseOutcome.pendingToolBatches.some((batch) => batch.status === 'FAILED' || batch.status === 'PARTIAL_APPROVAL_BLOCKED' || batch.status === 'DENIED')
          ? 'BATCH_BLOCKED'
          : 'CONSOLIDATION_BLOCKED')
        : nextPlannerDiagnostics.planner.blockingReason
    },
    activeStage: nextPlannerDiagnostics.activeStage,
    pendingToolBatches: params.phaseOutcome.pendingToolBatches,
    consolidationState: params.phaseOutcome.consolidationState,
    compressionPolicy: {
      mode: compressionPolicy.mode,
      preservedValidatedOutputUnitIds: [...compressionPolicy.preservedValidatedOutputUnitIds],
      preservedMemoryUnitIds: compressionPolicy.preservedMemoryUnitIds ? [...compressionPolicy.preservedMemoryUnitIds] : null,
      reasons: [...compressionPolicy.reasons]
    },
    contextGating: {
      ...params.assembled.contextGatingSummary,
      reasons: [...params.assembled.contextGatingSummary.reasons]
    },
    compressionDowngraded: nextGuardrails.compressionDowngraded,
    batchAdmissionDecisions: [...(params.phaseOutcome.batchAdmissionDecisions ?? [])].map((decision) => ({
      batchId: decision.batchId,
      stageIndex: decision.stageIndex,
      status: decision.status,
      admittedInvocationCount: decision.admittedInvocationKeys.length,
      rejectedInvocationCount: decision.rejectedInvocationKeys.length,
      rejectionReasons: [...decision.rejectionReasons]
    })),
    unsafeBatchRejectedCount:
      (params.previousRuntime.unsafeBatchRejectedCount ?? 0)
      + (params.phaseOutcome.batchAdmissionDecisions ?? []).reduce((total, decision) => total + decision.rejectedInvocationKeys.length, 0),
    guardrails: nextGuardrails,
    plannerFallbackRate: nextGuardrails.plannerFallbackRate,
    llmContextMessages: nextContext.messages,
    llmContextSnapshotRef: createContextSnapshotRef({
      kind: 'llm',
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      messageCount: nextContext.messages.length
    }),
    conversationSnapshotRef: createContextSnapshotRef({
      kind: 'conversation',
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      messageCount: params.assembled.existingConversations.length + (params.userMessage?.trim() ? 3 : 2)
    }),
    pendingOperatorInputs: [],
    interrupt: {
      pauseRequested: false,
      interruptRequested: false,
      cancelRequested: false,
      requestedAt: null,
      reason: null
    },
    executionLease: {
      active: false,
      phase: nextRuntimeBase.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'IDLE',
      leaseId: null,
      startedAt: params.previousRuntime.executionLease?.startedAt ?? null,
      replayable: true
    },
    safePoint: {
      stage: 'AFTER_PROVIDER',
      reachedAt: Date.now(),
      interruptible: true
    },
    memory: updatedTaskMemory,
    promptBudget: params.assembled.promptResult.budget,
    promptSectionAttribution: params.assembled.promptResult.budget.sectionPromptChars,
    stageMemorySummary: params.assembled.stageMemorySummary,
    capabilitySelectionSummary: params.assembled.capabilitySelectionSummary,
    retrievalSelectionSummary: params.assembled.retrievalSelectionSummary,
    contractDiagnostics: {
      ...(nextRuntimeBase.contractDiagnostics ?? {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: [],
          issueCount: 0,
          stageCount: 0,
          currentStageIndex: null,
          batchGroupingHint: null,
          entryUnitIds: [],
          exitUnitIds: []
        },
        currentUnit: {
          unitId: nextRuntimeBase.currentUnitId,
          permissionLevel: null,
          requiresToolEvidence: false,
          contractSource: undefined,
          usedCompatibilityFallback: undefined,
          scopedUnitIds: null,
          memorySelectionSource: undefined,
          retrievalScopeSummary: undefined
          },
          lastExitCondition: null,
          lastAcceptanceFailureCategory: null,
          lastAcceptanceIssueCodes: [],
          lastAcceptanceIssueMessages: [],
          lastPendingCorrectionKind: null,
          lastCorrectionPromptMode: 'FULL_PROTOCOL',
          correctionLoopNonConvergent: false
        }),
      compatibilityFallbackCount: (params.previousRuntime.contractDiagnostics?.compatibilityFallbackCount ?? 0)
        + ((nextRuntimeBase.contractDiagnostics?.currentUnit.usedCompatibilityFallback ?? false) ? 1 : 0),
        lastExitCondition: {
          unitId: params.phaseOutcome.correctionUnitId,
          ok: diagnosticsAcceptance.exitCondition.ok,
          issueCodes: [...diagnosticsAcceptance.exitCondition.issueCodes],
          evaluatedAt: Date.now(),
          failureCategory: diagnosticsAcceptance.exitCondition.failureCategory
        },
        lastAcceptanceFailureCategory: acceptanceFailureCategory,
        lastAcceptanceIssueCodes: qualityGateFailed
          ? [
            ...qualityEvaluation.failedChecks.map((issue) => `quality:${issue}`),
            ...qualityEvaluation.requiredNextEvidence.map((item) => `quality_required:${item}`)
          ]
          : effectiveAcceptance.issueCodes,
        lastAcceptanceIssueMessages: qualityGateFailed
          ? [...qualityFailureMessages, ...qualityRequiredEvidenceMessages]
          : effectiveAcceptance.issueMessages,
        lastPendingCorrectionKind: qualityGateFailed ? qualityCorrectionKind : diagnosticsAcceptance.ok ? null : effectiveAcceptance.pendingCorrection,
        lastCorrectionPromptMode: deriveCorrectionPromptMode({
          pendingCorrection: qualityGateFailed ? qualityCorrectionKind : diagnosticsAcceptance.ok ? 'NONE' : effectiveAcceptance.pendingCorrection,
          failureCategory: acceptanceFailureCategory
      }),
      correctionLoopNonConvergent:
        (qualityGateFailed || !diagnosticsAcceptance.ok)
        && (nextGuardrails.correctionStreak >= 3)
        && (params.previousRuntime.contractDiagnostics?.lastPendingCorrectionKind === (qualityGateFailed ? qualityCorrectionKind : effectiveAcceptance.pendingCorrection))
        && (params.previousRuntime.contractDiagnostics?.lastAcceptanceFailureCategory === acceptanceFailureCategory)
    },
    contextCompressionCount: params.previousRuntime.contextCompressionCount
      + (params.assembled.contextMessages.compressed ? 1 : 0)
      + (nextContext.compressed ? 1 : 0)
  };
  if (
    !qualityGateFailed
    && effectiveAcceptance.pendingCorrection !== 'NONE'
    && nextRuntime.pendingCorrection === 'NONE'
    && nextRuntime.lifecycleStatus === 'RUNNING'
    && nextRuntime.currentUnitId === params.phaseOutcome.correctionUnitId
  ) {
    nextRuntime.pendingCorrection = effectiveAcceptance.pendingCorrection;
    const unit = nextRuntime.schedulerUnits[params.phaseOutcome.correctionUnitId];
    if (unit) {
      unit.invalidOutputErrors = effectiveAcceptance.issueMessages.length > 0
        ? [...effectiveAcceptance.issueMessages]
        : [...unit.invalidOutputErrors];
      nextRuntime.invalidOutputUnits[params.phaseOutcome.correctionUnitId] = [...unit.invalidOutputErrors];
    }
    if (nextRuntime.contractDiagnostics) {
      nextRuntime.contractDiagnostics.lastAcceptanceFailureCategory = acceptanceFailureCategory;
      nextRuntime.contractDiagnostics.lastAcceptanceIssueCodes = [...effectiveAcceptance.issueCodes];
      nextRuntime.contractDiagnostics.lastAcceptanceIssueMessages = [...effectiveAcceptance.issueMessages];
      nextRuntime.contractDiagnostics.lastPendingCorrectionKind = effectiveAcceptance.pendingCorrection;
      nextRuntime.contractDiagnostics.lastCorrectionPromptMode = deriveCorrectionPromptMode({
        pendingCorrection: effectiveAcceptance.pendingCorrection,
        failureCategory: acceptanceFailureCategory
      });
    }
  }
  nextRuntime.promptBudget = {
    ...nextRuntime.promptBudget,
    estimatedPromptCharacters: params.assembled.estimatedPromptCharacters,
    estimatedPromptTokens: Math.ceil(params.assembled.estimatedPromptCharacters / 4),
    estimatedBaselineCharacters: params.assembled.estimatedBaselineCharacters,
    estimatedBaselineTokens: Math.ceil(params.assembled.estimatedBaselineCharacters / 4),
    estimatedReductionRatio: params.assembled.estimatedReductionRatio,
    rawContextCharacters: params.assembled.contextGatingSummary.rawContextCharacters,
    gatedContextCharacters: params.assembled.contextGatingSummary.gatedContextCharacters,
    rawContextTokens: Math.ceil(params.assembled.contextGatingSummary.rawContextCharacters / 4),
    gatedContextTokens: Math.ceil(params.assembled.contextGatingSummary.gatedContextCharacters / 4),
    estimatedHistoryReductionRatio: params.assembled.contextGatingSummary.estimatedContextReductionRatio,
    estimatedSectionReductionRatio: params.assembled.promptResult.budget.estimatedSectionReductionRatio,
    cacheablePrefixChars: params.assembled.promptResult.budget.cacheablePrefixChars,
    stablePrefixChars: params.assembled.promptResult.budget.stablePrefixChars,
    volatileSuffixChars: params.assembled.promptResult.budget.volatileSuffixChars,
    stablePrefixRatio: params.assembled.promptResult.budget.stablePrefixRatio,
    retrievedContextCount: params.assembled.selectedValidatedOutputs.retrievedContextCount,
    policyFilteredOutputCount: params.assembled.selectedValidatedOutputs.policyFilteredOutputCount,
    operatorInputCount: params.assembled.pendingOperatorInputs.length
  };

  if (
    params.latestRuntimeAfterProvider.interrupt.cancelRequested
    || params.latestRuntimeAfterProvider.interrupt.interruptRequested
    || params.latestRuntimeAfterProvider.interrupt.pauseRequested
  ) {
    if (!nextRuntime.executionLease) {
      nextRuntime.executionLease = {
        active: false,
        phase: 'IDLE',
        leaseId: null,
        startedAt: null,
        replayable: true
      };
    }
    
    if (params.latestRuntimeAfterProvider.interrupt.cancelRequested) {
      nextRuntime.lifecycleStatus = 'CANCELLED';
      nextRuntime.engineStatus = 'FAILED';
      nextRuntime.currentUnitId = null;
      nextRuntime.executionLease.phase = 'INTERRUPTED';
    } else {
      nextRuntime.lifecycleStatus = 'PAUSED';
      nextRuntime.engineStatus = 'PAUSED';
      nextRuntime.executionLease.phase = 'PAUSED';
    }
    nextRuntime.executionLease.active = false;
    nextRuntime.interrupt = {
      pauseRequested: false,
      interruptRequested: false,
      cancelRequested: false,
      requestedAt: null,
      reason: params.latestRuntimeAfterProvider.interrupt.reason
    };
  }

  return {
    nextRuntime,
    updatedUserProfile
  };
}
