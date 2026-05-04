import { existsSync, readFileSync } from 'node:fs';
import { createTopologyGraph } from '../../domain/runtime/topology-graph';
import { getExecutionProfile } from '../runtime/execution-profiles';
import { TaskObservationHookPoint } from '../runtime/task-observation-hooks';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import {
  TaskExecutionStageDuration,
  TaskExecutionSummary,
  TaskExecutionUnitDuration,
  TaskQueryResponse
} from './types';
import {
  ApprovedExperienceRecord,
  CapabilityWarning
} from '../platform/types';
import {
  createAllMcpCatalogEntries,
  createProviderProfileView
} from '../platform/capability-hub';
import {
  collectInvocationEvidencePaths,
  deriveTaskArtifactRoutingSummary,
  isArtifactWriteEvidenceTool,
  TaskArtifactRoutingSummary
} from './artifact-routing';
import { getTaskWorkingDirectorySettings } from './task-working-directory';
import type { ToolInvocationRecord } from '../../foundation/repository/types';
import { shouldMarkInvocationAsVerification } from './tools/tool-verification';
import { parseTurn } from '../../domain/parser/unit-output-parser';
import { validateExplicitOutput } from '../../domain/validation/validate-explicit-output';

const UNIT_END_EVENT_TYPES = new Set([
  'TURN_ANALYZED',
  'TASK_PAUSED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED'
]);

function countEvents(task: TaskQueryResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of task.events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function deriveObservedHooks(task: TaskQueryResponse, eventCounts: Record<string, number>): TaskObservationHookPoint[] {
  const hooks: TaskObservationHookPoint[] = [];
  const hasApprovalBlockedBatch = task.runtime.pendingToolBatches.some((batch) => batch.approvalBlockedCount > 0)
    || task.events.some((event) => (
      event.type === 'TOOL_BATCH_EXECUTED'
      && event.payload
      && typeof event.payload === 'object'
      && (
        (((event.payload as { approvalBlockedInvocationIds?: unknown }).approvalBlockedInvocationIds) instanceof Array
          && (((event.payload as { approvalBlockedInvocationIds?: unknown[] }).approvalBlockedInvocationIds?.length) ?? 0) > 0)
        || (typeof (event.payload as { approvalBlockedCount?: unknown }).approvalBlockedCount === 'number'
          && (((event.payload as { approvalBlockedCount?: number }).approvalBlockedCount) ?? 0) > 0)
      )
    ));

  if ((eventCounts['TOOL_BATCH_PLANNED'] ?? 0) > 0 || (eventCounts['TOOL_EXECUTED'] ?? 0) > 0) {
    hooks.push('pre-tool-dispatch');
  }
  if ((eventCounts['TOOL_EXECUTED'] ?? 0) > 0) {
    hooks.push('post-tool-result');
  }
  if (hasApprovalBlockedBatch || task.pendingApprovals.length > 0) {
    hooks.push('approval-blocked');
  }
  if ((eventCounts['TASK_RESUMED'] ?? 0) > 0) {
    hooks.push('task-resumed');
  }
  if ((eventCounts['TASK_FAILED'] ?? 0) > 0 || (eventCounts['TASK_DEAD_LETTERED'] ?? 0) > 0) {
    hooks.push('task-failed');
  }
  return hooks;
}

function buildQueueRuntimeAlignment(task: TaskQueryResponse): TaskExecutionSummary['queueRuntimeAlignment'] {
  const queueState = task.queue?.state ?? null;
  const lifecycleStatus = task.runtime.lifecycleStatus;

  if (queueState === 'DEAD_LETTER' && lifecycleStatus !== 'FAILED') {
    return {
      consistent: false,
      queueState,
      lifecycleStatus,
      summary: 'Queue moved to dead letter while runtime is not failed.'
    };
  }

  if (queueState === 'COMPLETED' && !['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(lifecycleStatus)) {
    return {
      consistent: false,
      queueState,
      lifecycleStatus,
      summary: 'Queue completed while runtime lifecycle still expects active work.'
    };
  }

  if ((lifecycleStatus === 'COMPLETED' || lifecycleStatus === 'CANCELLED') && ['QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAITING'].includes(queueState ?? '')) {
    return {
      consistent: false,
      queueState,
      lifecycleStatus,
      summary: 'Runtime reached terminal lifecycle while queue item is still active.'
    };
  }

  return {
    consistent: true,
    queueState,
    lifecycleStatus,
    summary: 'Queue and runtime lifecycle are aligned.'
  };
}

function buildRecoverySummary(task: TaskQueryResponse): TaskExecutionSummary['recovery'] {
  const recoveryEvent = [...task.events]
    .reverse()
    .find((event) => (
      (event.type === 'TASK_PAUSED' || event.type === 'TASK_FAILED')
      && event.payload
      && typeof event.payload === 'object'
      && (event.payload as { recovery?: string }).recovery === 'PROCESS_RESTART'
    ));
  const lifecycleRecoveryEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'TASK_RESTARTED' || event.type === 'TASK_RESUMED');
  const queueRecoveryEvent = [...task.events]
    .reverse()
    .find((event) => (
      event.type === 'QUEUE_LEASE_RECOVERED'
      && event.payload
      && typeof event.payload === 'object'
    ));
  const projectionMetadata = task.projection?.metadata ?? {};
  const recoveryPayload = recoveryEvent?.payload && typeof recoveryEvent.payload === 'object'
    ? recoveryEvent.payload as {
      recoveredBy?: unknown;
      previousQueueState?: unknown;
    }
    : null;
  const queueRecoveryPayload = queueRecoveryEvent?.payload && typeof queueRecoveryEvent.payload === 'object'
    ? queueRecoveryEvent.payload as {
      recoveredBy?: unknown;
    }
    : null;
  const recoveryReason = typeof projectionMetadata['recoveryReason'] === 'string'
    ? projectionMetadata['recoveryReason']
    : (recoveryEvent
      ? 'process_restart'
      : (lifecycleRecoveryEvent?.type === 'TASK_RESTARTED'
        ? 'task_restart'
        : (lifecycleRecoveryEvent?.type === 'TASK_RESUMED'
          ? 'task_resume'
          : (queueRecoveryEvent ? 'queue_lease_recovered' : null))));

  return {
    recoveredAfterRestart:
      Boolean(recoveryEvent)
      || Boolean(lifecycleRecoveryEvent)
      || Boolean(queueRecoveryEvent)
      || typeof projectionMetadata['recoveryReason'] === 'string',
    recoveryReason,
    recoveredBy:
      typeof recoveryPayload?.recoveredBy === 'string'
        ? recoveryPayload.recoveredBy
        : (typeof queueRecoveryPayload?.recoveredBy === 'string'
          ? queueRecoveryPayload.recoveredBy
          : (lifecycleRecoveryEvent ? lifecycleRecoveryEvent.type.toLowerCase() : null)),
    recoveredFromLifecycleStatus:
      typeof projectionMetadata['recoveredFromLifecycleStatus'] === 'string'
        ? projectionMetadata['recoveredFromLifecycleStatus'] as TaskExecutionSummary['recovery']['recoveredFromLifecycleStatus']
        : null,
    previousQueueState:
      typeof recoveryPayload?.previousQueueState === 'string'
        ? recoveryPayload.previousQueueState as TaskExecutionSummary['recovery']['previousQueueState']
        : (
      typeof projectionMetadata['previousQueueState'] === 'string'
        ? projectionMetadata['previousQueueState'] as TaskExecutionSummary['recovery']['previousQueueState']
        : null
        ),
    queueLastError:
      typeof projectionMetadata['queueLastError'] === 'string'
        ? projectionMetadata['queueLastError']
        : null
  };
}

function buildTurnCount(unitDurations: TaskExecutionUnitDuration[]): number {
  return unitDurations.reduce((total, entry) => total + entry.turnCount, 0);
}

function buildCorrectionDepth(task: TaskQueryResponse, unitDurations: TaskExecutionUnitDuration[]): number {
  const analyzedCorrectionCount = task.events.filter((event) => {
    if (event.type !== 'TURN_ANALYZED' || !event.payload || typeof event.payload !== 'object') {
      return false;
    }
    const payload = event.payload as {
      projection?: {
        summary?: { pendingCorrection?: unknown };
        state?: { pendingCorrection?: unknown };
      };
    };
    const pendingCorrection = payload.projection?.summary?.pendingCorrection ?? payload.projection?.state?.pendingCorrection;
    return typeof pendingCorrection === 'string' && pendingCorrection !== 'NONE';
  }).length;
  const runtimeConversationCorrectionCount = task.conversations.filter((message) => {
    if (!message.metadata || typeof message.metadata !== 'object') {
      return false;
    }
    const pendingCorrection = (message.metadata as { pendingCorrection?: unknown }).pendingCorrection;
    return typeof pendingCorrection === 'string' && pendingCorrection !== 'NONE';
  }).length;
  const repeatedUnitTurnCount = unitDurations.reduce(
    (total, entry) => total + Math.max(0, entry.turnCount - 1),
    0
  );
  const guardrailDepth = task.runtime.guardrails?.correctionStreak;
  if (typeof guardrailDepth === 'number' && Number.isFinite(guardrailDepth)) {
    return Math.max(0, guardrailDepth, analyzedCorrectionCount, runtimeConversationCorrectionCount, repeatedUnitTurnCount);
  }
  if (analyzedCorrectionCount > 0) {
    return Math.max(analyzedCorrectionCount, runtimeConversationCorrectionCount, repeatedUnitTurnCount);
  }
  if (runtimeConversationCorrectionCount > 0) {
    return Math.max(runtimeConversationCorrectionCount, repeatedUnitTurnCount);
  }
  if (repeatedUnitTurnCount > 0) {
    return repeatedUnitTurnCount;
  }
  return task.runtime.contractDiagnostics?.lastPendingCorrectionKind
    && task.runtime.contractDiagnostics.lastPendingCorrectionKind !== 'NONE'
    ? 1
    : 0;
}

function buildProviderFailureStreak(task: TaskQueryResponse): number {
  let streak = 0;
  for (const event of [...task.events].reverse()) {
    if (event.type !== 'TASK_FAILED' || !event.payload || typeof event.payload !== 'object') {
      continue;
    }
    const payload = event.payload as { category?: unknown; providerId?: unknown };
    if (typeof payload.providerId === 'string' || typeof payload.category === 'string') {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

function buildExtensionFailureStreak<
  TStatus extends string
>(
  recent: Array<{ status: TStatus }>,
  failureStatuses: readonly TStatus[]
): number {
  let streak = 0;
  for (const entry of recent) {
    if (!failureStatuses.includes(entry.status)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function parseDelimitedValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function collectTaskExtensionItems(
  task: TaskQueryResponse,
  key: 'mcp' | 'mcpResources' | 'mcpPrompts'
): Array<Record<string, unknown>> {
  const metadata = task.definition.metadata;
  const extensions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).extensions
    : null;
  const extensionRecord = extensions && typeof extensions === 'object' && !Array.isArray(extensions)
    ? extensions as Record<string, unknown>
    : null;
  const value = extensionRecord?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
}

function buildLastSafeCheckpointAt(task: TaskQueryResponse): number | null {
  const latestCheckpointEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'CHECKPOINT_WRITTEN' || event.type === 'SAFE_POINT_REACHED');
  if (latestCheckpointEvent) {
    return latestCheckpointEvent.timestamp;
  }
  return task.runtime.safePoint?.reachedAt ?? null;
}

function buildLastRecoverySource(recovery: TaskExecutionSummary['recovery']): string | null {
  if (!recovery.recoveredAfterRestart) {
    return null;
  }
  const parts = [
    recovery.recoveryReason,
    recovery.recoveredBy ? `by ${recovery.recoveredBy}` : null,
    recovery.previousQueueState ? `from ${recovery.previousQueueState}` : null
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(', ') : 'process restart recovery';
}

function buildConservativeModeReason(params: {
  task: TaskQueryResponse;
  correctionDepth: number;
  providerFailureStreak: number;
  skillFailureStreak: number;
  mcpFailureStreak: number;
}): string | null {
  const { task, correctionDepth, providerFailureStreak, skillFailureStreak, mcpFailureStreak } = params;
  if (task.runtime.contractDiagnostics?.correctionLoopNonConvergent) {
    return 'repeated correction failures reached a non-convergent loop';
  }
  if (providerFailureStreak >= 2 && task.diagnostics.providerFailure) {
    const category = task.diagnostics.providerFailure.category ?? task.diagnostics.providerFailure.kind ?? 'provider_failure';
    return `provider failure streak=${providerFailureStreak} (${category})`;
  }
  if (skillFailureStreak >= 2) {
    return `skill failure streak=${skillFailureStreak}`;
  }
  if (mcpFailureStreak >= 2) {
    return `mcp failure streak=${mcpFailureStreak}`;
  }
  if (task.runtime.compressionDowngraded ?? task.runtime.guardrails?.compressionDowngraded) {
    const reasons = [
      ...(task.runtime.contextGating?.reasons ?? []),
      ...(task.runtime.compressionPolicy?.reasons ?? [])
    ].filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
    if (reasons.length > 0) {
      return reasons.join(', ');
    }
    return 'context pressure forced conservative compression';
  }
  if (correctionDepth > 1) {
    return `correction depth=${correctionDepth}`;
  }
  return null;
}

function buildUnitDurations(task: TaskQueryResponse): TaskExecutionUnitDuration[] {
  const graph = createTopologyGraph(task.definition);
  const sortedEvents = [...task.events].sort((left, right) => left.timestamp - right.timestamp);
  const openStarts = new Map<string, number>();
  const totals = new Map<string, TaskExecutionUnitDuration>();
  const lastTimestamp = sortedEvents.at(-1)?.timestamp ?? Date.now();

  for (const event of sortedEvents) {
    if (!event.unitId) {
      continue;
    }
    const unitId = event.unitId;
    const current = totals.get(unitId) ?? {
      unitId,
      stageIndex: graph.stageIndexByUnitId[unitId] ?? null,
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      turnCount: 0
    };

    if (event.type === 'TURN_STARTED') {
      if (!openStarts.has(unitId)) {
        openStarts.set(unitId, event.timestamp);
      }
      if (current.startedAt === null) {
        current.startedAt = event.timestamp;
      }
    }

    if (UNIT_END_EVENT_TYPES.has(event.type) && openStarts.has(unitId)) {
      const startedAt = openStarts.get(unitId)!;
      current.endedAt = event.timestamp;
      current.durationMs += Math.max(0, event.timestamp - startedAt);
      current.turnCount += 1;
      openStarts.delete(unitId);
    }

    totals.set(unitId, current);
  }

  for (const [unitId, startedAt] of openStarts.entries()) {
    const current = totals.get(unitId) ?? {
      unitId,
      stageIndex: graph.stageIndexByUnitId[unitId] ?? null,
      startedAt,
      endedAt: lastTimestamp,
      durationMs: 0,
      turnCount: 0
    };
    current.endedAt = lastTimestamp;
    current.durationMs += Math.max(0, lastTimestamp - startedAt);
    totals.set(unitId, current);
  }

  return [...totals.values()].sort((left, right) => {
    if ((left.stageIndex ?? 0) !== (right.stageIndex ?? 0)) {
      return (left.stageIndex ?? 0) - (right.stageIndex ?? 0);
    }
    return left.unitId.localeCompare(right.unitId);
  });
}

function buildStageDurations(task: TaskQueryResponse, unitDurations: TaskExecutionUnitDuration[]): TaskExecutionStageDuration[] {
  const graph = createTopologyGraph(task.definition);

  return graph.stages.map((stage) => {
    const stageUnits = unitDurations.filter((entry) => stage.unitIds.includes(entry.unitId));
    const startedAt = stageUnits.reduce<number | null>((current, entry) => {
      if (entry.startedAt === null) {
        return current;
      }
      return current === null ? entry.startedAt : Math.min(current, entry.startedAt);
    }, null);
    const endedAt = stageUnits.reduce<number | null>((current, entry) => {
      if (entry.endedAt === null) {
        return current;
      }
      return current === null ? entry.endedAt : Math.max(current, entry.endedAt);
    }, null);

    return {
      stageIndex: stage.stageIndex,
      unitIds: [...stage.unitIds],
      startedAt,
      endedAt,
      durationMs: stageUnits.reduce((total, entry) => total + entry.durationMs, 0)
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeReferencePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizeInvocationToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function collectInvocationReferencePaths(
  invocation: Pick<ToolInvocationRecord, 'arguments' | 'result'>
): string[] {
  const output = isRecord(invocation.result?.output) ? invocation.result.output : {};
  const values = [
    invocation.arguments.path,
    invocation.arguments.file,
    invocation.arguments.file_path,
    invocation.result?.path,
    invocation.result?.file,
    output.path,
    output.file
  ];
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeReferencePath(value))));
}

function isFailedToolResolvedByLaterSuccess(
  task: TaskQueryResponse,
  failedIndex: number,
  options: {
    requireVerificationSuccess?: boolean;
  } = {}
): boolean {
  const failed = task.toolInvocations[failedIndex];
  if (!failed || failed.status !== 'FAILED') {
    return false;
  }
  const failedToolId = normalizeInvocationToolId(failed.toolId);
  const failedPaths = collectInvocationReferencePaths(failed);
  return task.toolInvocations
    .map((invocation, index) => ({ invocation, index }))
    .some(({ invocation, index }) => {
      if (index <= failedIndex || invocation.status !== 'SUCCEEDED') {
        return false;
      }
      if (normalizeInvocationToolId(invocation.toolId) !== failedToolId) {
        return false;
      }
      if (options.requireVerificationSuccess && !isVerificationTool(invocation)) {
        return false;
      }
      if (failedPaths.length === 0) {
        return true;
      }
      const successPaths = collectInvocationReferencePaths(invocation);
      return failedPaths.some((entry) => successPaths.includes(entry));
    });
}

function findUnresolvedFailedTool(task: TaskQueryResponse): ToolInvocationRecord | null {
  const failedTools = task.toolInvocations
    .map((invocation, index) => ({ invocation, index }))
    .filter(({ invocation }) => invocation.status === 'FAILED');
  for (const { invocation, index } of failedTools) {
    if (isFailedToolResolvedByLaterSuccess(task, index)) {
      continue;
    }
    return invocation;
  }
  return null;
}

function classifyIssue(
  task: TaskQueryResponse,
  alignment: TaskExecutionSummary['queueRuntimeAlignment'],
  recovery: TaskExecutionSummary['recovery'],
  artifactRouting: TaskArtifactRoutingSummary
): Pick<TaskExecutionSummary, 'issueCategory' | 'issueSummary'> {
  if (task.delegationSummary?.missingRequiredDelegation) {
    return {
      issueCategory: 'required_delegation_missing',
      issueSummary: 'Delegation is required before parent delivery can continue, but no delegated child task was created.'
    };
  }

  if (artifactRouting.needsExplicitDestination) {
    return {
      issueCategory: 'artifact_destination_unresolved',
      issueSummary: artifactRouting.recommendedArtifactDir
        ? `Generated artifacts are still in the task workspace. Confirm or override the recommended destination "${artifactRouting.recommendedArtifactDir}" before continuing.`
        : 'Generated artifacts are still in the task workspace and require an explicit project-relative destination before continuing.'
    };
  }

  if (artifactRouting.lastArtifactApplyResult?.status === 'CONFLICT') {
    return {
      issueCategory: 'artifact_apply_conflict',
      issueSummary: artifactRouting.lastArtifactApplyResult.message
    };
  }

  if (artifactRouting.lastArtifactApplyResult?.status === 'FAILED') {
    return {
      issueCategory: 'artifact_apply_failed',
      issueSummary: artifactRouting.lastArtifactApplyResult.message
    };
  }

  if (task.diagnostics.providerFailure) {
    return {
      issueCategory: 'provider_config_failure',
      issueSummary: task.diagnostics.providerFailure.message
    };
  }

  if (task.pendingApprovals.length > 0 || task.runtime.pendingToolBatches.some((batch) => batch.approvalBlockedCount > 0)) {
    return {
      issueCategory: 'approval_deadlock',
      issueSummary: 'Task is blocked on tool approval.'
    };
  }

  const failedTool = findUnresolvedFailedTool(task);
  if (
    failedTool
    && (
      task.runtime.lifecycleStatus !== 'COMPLETED'
      || normalizeInvocationToolId(failedTool.toolId) === 'run_command'
    )
  ) {
    return {
      issueCategory: 'tool_execution_failure',
      issueSummary: failedTool.error ?? `Tool ${failedTool.toolId} failed.`
    };
  }

  const failedSkill = [...task.events].reverse().find((event) => (
    event.type === 'SKILL_EXECUTED'
    && event.payload
    && typeof event.payload === 'object'
    && ((event.payload as { status?: unknown }).status === 'FAILED'
      || (event.payload as { status?: unknown }).status === 'UNAVAILABLE')
  ));
  if (failedSkill) {
    const payload = failedSkill.payload as { status?: unknown; error?: unknown };
    return {
      issueCategory: payload.status === 'UNAVAILABLE' ? 'skill_runtime_unavailable' : 'skill_invocation_failed',
      issueSummary: typeof payload.error === 'string' ? payload.error : 'Skill execution failed.'
    };
  }

  const failedMcp = [...task.events].reverse().find((event) => (
    event.type === 'MCP_TOOL_EXECUTED'
    && event.payload
    && typeof event.payload === 'object'
    && (event.payload as { status?: unknown }).status !== 'SUCCEEDED'
  ));
  if (failedMcp) {
    const payload = failedMcp.payload as { status?: unknown; error?: unknown };
    return {
      issueCategory:
        payload.status === 'UNAVAILABLE'
          ? 'mcp_server_unavailable'
          : payload.status === 'CAPABILITY_MISMATCH'
            ? 'mcp_capability_mismatch'
            : 'mcp_call_failed',
      issueSummary: typeof payload.error === 'string' ? payload.error : 'MCP execution failed.'
    };
  }

  if (!alignment.consistent) {
    return {
      issueCategory: 'queue_runtime_divergence',
      issueSummary: alignment.summary
    };
  }

  if ((task.runtime.planner?.fallbackReasons.length ?? 0) > 0 || (task.runtime.contractDiagnostics?.compatibilityFallbackCount ?? 0) > 0) {
    return {
      issueCategory: 'context_overload_planner_fallback',
      issueSummary: task.runtime.planner?.fallbackReasons.join(', ') || 'Planner fell back due to context pressure.'
    };
  }

  const rejectedCommand = task.commands.find((command) => command.status === 'REJECTED');
  if (rejectedCommand) {
    return {
      issueCategory: 'invalid_lifecycle_transition',
      issueSummary: rejectedCommand.reason ?? rejectedCommand.message ?? `Command ${rejectedCommand.type} was rejected.`
    };
  }

  if (recovery.recoveredAfterRestart && task.runtime.lifecycleStatus === 'RUNNING' && task.queue?.state === 'DEAD_LETTER') {
    return {
      issueCategory: 'recovery_inconsistency',
      issueSummary: 'Restart recovery produced a running task with a dead-letter queue item.'
    };
  }

  return {
    issueCategory: null,
    issueSummary: null
  };
}

const PROVIDER_EXTERNAL_BLOCKER_PATTERN = /\b(rate[- ]?limit|quota|timeout|timed out|tls|certificate|network|dns|econnrefused|econnreset|enotfound|upstream|5\d\d|service unavailable|temporarily unavailable)\b/i;

function classifyIssuePlane(
  category: TaskExecutionSummary['issueCategory'],
  task: TaskQueryResponse
): TaskExecutionSummary['issuePlane'] {
  if (!category) {
    return null;
  }
  if (category === 'provider_config_failure') {
    const providerMessage = [
      task.diagnostics.providerFailure?.category,
      task.diagnostics.providerFailure?.kind,
      task.diagnostics.providerFailure?.message,
      task.diagnostics.lastError
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    return PROVIDER_EXTERNAL_BLOCKER_PATTERN.test(providerMessage)
      ? 'external_blocker'
      : 'provider';
  }
  switch (category) {
    case 'skill_runtime_unavailable':
    case 'skill_invocation_failed':
    case 'mcp_server_unavailable':
    case 'mcp_call_failed':
    case 'mcp_capability_mismatch':
    case 'tool_execution_failure':
      return 'ecosystem';
    case 'artifact_destination_unresolved':
    case 'artifact_apply_conflict':
    case 'artifact_apply_failed':
    case 'artifact_policy_mismatch':
    case 'approval_deadlock':
    case 'required_delegation_missing':
    case 'queue_runtime_divergence':
    case 'context_overload_planner_fallback':
    case 'invalid_lifecycle_transition':
    case 'recovery_inconsistency':
      return 'core';
    default:
      return 'core';
  }
}

function buildSuggestedAction(params: {
  task: TaskQueryResponse;
  issuePlane: TaskExecutionSummary['issuePlane'];
  issueCategory: TaskExecutionSummary['issueCategory'];
  issueSummary: string | null;
  turnContract: TaskExecutionSummary['turnContract'];
}): TaskExecutionSummary['suggestedAction'] {
  const { task, issuePlane, issueCategory, issueSummary, turnContract } = params;
  const reason = issueSummary ?? turnContract.continueReason;
  if (!issueCategory && task.runtime.lifecycleStatus === 'COMPLETED') {
    return {
      type: 'continue',
      label: 'Send follow-up',
      reason: 'The task is complete; send a new message to start follow-up work in this same thread.',
      command: 'tasks chat'
    };
  }
  switch (issueCategory) {
    case 'provider_config_failure':
      return issuePlane === 'external_blocker'
        ? {
          type: 'inspect_diagnostics',
          label: 'Check external provider environment',
          reason,
          command: 'platform providers test'
        }
        : {
          type: 'configure_provider',
          label: 'Open Connections',
          reason,
          command: 'settings/connections'
        };
    case 'skill_runtime_unavailable':
    case 'skill_invocation_failed':
    case 'mcp_server_unavailable':
    case 'mcp_call_failed':
    case 'mcp_capability_mismatch':
    case 'tool_execution_failure':
      return {
        type: 'review_ecosystem',
        label: 'Review ecosystem readiness',
        reason,
        command: 'settings/ecosystem'
      };
    case 'artifact_destination_unresolved':
      return {
        type: 'select_artifact_destination',
        label: 'Select artifact destination',
        reason,
        command: 'tasks artifacts apply'
      };
    case 'artifact_apply_conflict':
    case 'artifact_apply_failed':
    case 'artifact_policy_mismatch':
      return {
        type: 'resolve_artifact_conflict',
        label: 'Resolve artifact delivery',
        reason,
        command: 'tasks artifacts apply --destination <path>'
      };
    case 'approval_deadlock':
      return {
        type: 'resolve_approval',
        label: 'Resolve pending approval',
        reason,
        command: 'tasks approvals resolve'
      };
    case 'required_delegation_missing':
    case 'context_overload_planner_fallback':
      return {
        type: 'continue',
        label: 'Continue with focused guidance',
        reason,
        command: 'tasks continue'
      };
    case 'queue_runtime_divergence':
    case 'recovery_inconsistency':
      return {
        type: 'open_runtime_state',
        label: 'Open runtime state',
        reason,
        command: 'settings/state'
      };
    case 'invalid_lifecycle_transition':
      return {
        type: 'inspect_diagnostics',
        label: 'Refresh task diagnostics',
        reason,
        command: 'tasks inspect'
      };
    default:
      break;
  }

  if (task.runtime.lifecycleStatus === 'SUBMITTED') {
    return {
      type: 'start',
      label: 'Start task',
      reason: 'The task is submitted and ready for the first runtime turn.',
      command: 'tasks start'
    };
  }
  if (task.runtime.lifecycleStatus === 'PAUSED') {
    return {
      type: 'resume',
      label: 'Resume task',
      reason: 'The task is paused and waiting for an operator decision.',
      command: 'tasks resume'
    };
  }
  if (task.runtime.lifecycleStatus === 'FAILED') {
    return {
      type: 'restart',
      label: 'Restart task',
      reason: task.diagnostics.lastError ?? reason,
      command: 'tasks restart'
    };
  }
  if (turnContract.continueAllowed || task.runtime.lifecycleStatus === 'COMPLETED') {
    return {
      type: 'continue',
      label: 'Continue current thread',
      reason,
      command: 'tasks continue'
    };
  }
  return {
    type: 'wait',
    label: 'Wait for runtime update',
    reason,
    command: null
  };
}

function buildWorkspaceRuleSummary(task: TaskQueryResponse): TaskExecutionSummary['ruleSummary'] {
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  const payload = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? latestWorkspaceEvent.payload as {
      matchedRules?: unknown;
      pathMatchedRules?: unknown;
      configuredRuleCount?: unknown;
    }
    : null;
  const matchedRuleNames = Array.isArray(payload?.matchedRules)
    ? payload.matchedRules.filter((value): value is string => typeof value === 'string')
    : [];
  const pathMatchedRuleNames = Array.isArray(payload?.pathMatchedRules)
    ? payload.pathMatchedRules.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    configuredCount: typeof payload?.configuredRuleCount === 'number' ? payload.configuredRuleCount : matchedRuleNames.length,
    matchedRuleNames,
    pathMatchedRuleNames
  };
}

function buildWorkspaceHookSummary(task: TaskQueryResponse): TaskExecutionSummary['hookSummary'] {
  const hookEvents = task.events.filter((event) => (
    (event.type === 'WORKSPACE_HOOK_EXECUTED' || event.type === 'WORKSPACE_HOOK_FAILED')
    && event.payload
    && typeof event.payload === 'object'
  ));
  const recent = hookEvents
    .slice(-5)
    .map((event) => {
      const payload = event.payload as {
        event?: unknown;
        command?: unknown;
        status?: unknown;
      };
      return {
        event: typeof payload.event === 'string' ? payload.event : 'unknown',
        command: typeof payload.command === 'string' ? payload.command : 'unknown',
        status: event.type === 'WORKSPACE_HOOK_FAILED' ? 'FAILED' as const : 'SUCCEEDED' as const
      };
    });
  return {
    configuredCount: (() => {
      const latestWorkspaceEvent = [...task.events]
        .reverse()
        .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
      const payload = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
        ? latestWorkspaceEvent.payload as { configuredHookCount?: unknown }
        : null;
      return typeof payload?.configuredHookCount === 'number'
        ? payload.configuredHookCount
        : Array.from(new Set(recent.map((entry) => entry.event))).length;
    })(),
    executedCount: task.events.filter((event) => event.type === 'WORKSPACE_HOOK_EXECUTED').length,
    failedCount: task.events.filter((event) => event.type === 'WORKSPACE_HOOK_FAILED').length,
    recent
  };
}

function buildWorkspaceAgentSummary(task: TaskQueryResponse): TaskExecutionSummary['agentSummary'] {
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  const payload = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? latestWorkspaceEvent.payload as {
      selectedAgent?: unknown;
      selectedAgentReason?: unknown;
      configuredAgentCount?: unknown;
    }
    : null;
  return {
    configuredCount: typeof payload?.configuredAgentCount === 'number' ? payload.configuredAgentCount : 0,
    selectedAgent: typeof payload?.selectedAgent === 'string' ? payload.selectedAgent : null,
    selectedBy: typeof payload?.selectedAgentReason === 'string' ? payload.selectedAgentReason : null
  };
}

function buildInstructionSkillSummary(task: TaskQueryResponse): TaskExecutionSummary['instructionSkillSummary'] {
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  const payload = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? latestWorkspaceEvent.payload as {
      configuredInstructionSkillCount?: unknown;
      selectedInstructionSkills?: unknown;
    }
    : null;
  const selected = Array.isArray(payload?.selectedInstructionSkills)
    ? payload.selectedInstructionSkills
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => ({
        skillId: typeof entry.skillId === 'string' ? entry.skillId : 'unknown',
        name: typeof entry.name === 'string' ? entry.name : 'unknown',
        selectedBy: typeof entry.selectedBy === 'string' ? entry.selectedBy : 'heuristic',
        instructionOnly: true as const,
        assetPaths: Array.isArray(entry.assetPaths)
          ? entry.assetPaths.filter((value): value is string => typeof value === 'string')
          : [],
        sourcePath: typeof entry.sourcePath === 'string' ? entry.sourcePath : null,
        declaredMcpDependencies: Array.isArray(entry.declaredMcpDependencies)
          ? entry.declaredMcpDependencies.filter((value): value is string => typeof value === 'string')
          : [],
        declaredMcpResources: Array.isArray(entry.declaredMcpResources)
          ? entry.declaredMcpResources.filter((value): value is string => typeof value === 'string')
          : [],
        declaredMcpPrompts: Array.isArray(entry.declaredMcpPrompts)
          ? entry.declaredMcpPrompts.filter((value): value is string => typeof value === 'string')
          : [],
        preferredProviderIds: Array.isArray(entry.preferredProviderIds)
          ? entry.preferredProviderIds.filter((value): value is string => typeof value === 'string')
          : []
      }))
    : [];
  return {
    configuredCount: typeof payload?.configuredInstructionSkillCount === 'number'
      ? payload.configuredInstructionSkillCount
      : selected.length,
    selectedCount: selected.length,
    selected
  };
}

function readApprovedExperienceSnapshot(foundation?: BackendNewFoundation): Map<string, ApprovedExperienceRecord> {
  if (!foundation) {
    return new Map();
  }
  const filePath = foundation.layout.approvedExperiencesPath;
  if (!existsSync(filePath)) {
    return new Map();
  }
  try {
    const payload = JSON.parse(readFileSync(filePath, foundation.config.storage.encoding)) as unknown;
    const records = Array.isArray(payload)
      ? payload.filter((entry): entry is ApprovedExperienceRecord => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      : [];
    return new Map(records.map((record) => [record.proposalId, record]));
  } catch {
    return new Map();
  }
}

function buildExperienceSummary(
  task: TaskQueryResponse,
  foundation?: BackendNewFoundation
): TaskExecutionSummary['experienceSummary'] {
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  const payload = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? latestWorkspaceEvent.payload as {
      configuredApprovedExperienceCount?: unknown;
      selectedApprovedExperiences?: unknown;
    }
    : null;
  const approvedExperienceSnapshot = readApprovedExperienceSnapshot(foundation);
  const selected: Array<{
    proposalId: string;
    title: string;
    selectedBy: 'metadata' | 'heuristic';
    validationEligible: boolean;
    materializedPath: string;
    referenceSummary: string;
    limitations: string[];
    validationStatus: 'monitoring' | 'promotable' | 'conflicted';
    successfulReuseTaskIds: string[];
    failedReuseTaskIds: string[];
  }> = Array.isArray(payload?.selectedApprovedExperiences)
    ? payload.selectedApprovedExperiences
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => {
        const proposalId = typeof entry.proposalId === 'string' ? entry.proposalId : 'unknown';
        const snapshot = approvedExperienceSnapshot.get(proposalId) ?? null;
        return {
          proposalId,
          title: typeof entry.title === 'string'
            ? entry.title
            : snapshot?.title ?? 'unknown',
          selectedBy:
            entry.selectedBy === 'metadata' || entry.selectedBy === 'heuristic'
              ? entry.selectedBy
              : 'heuristic',
          validationEligible: entry.validationEligible === true,
          materializedPath: typeof entry.materializedPath === 'string' && entry.materializedPath.trim().length > 0
            ? entry.materializedPath
            : snapshot?.materializedPath ?? '',
          referenceSummary: typeof entry.referenceSummary === 'string'
            ? entry.referenceSummary
            : snapshot?.referenceSummary ?? '',
          limitations: Array.isArray(entry.limitations)
            ? entry.limitations.filter((value): value is string => typeof value === 'string')
            : snapshot?.limitations ?? [],
          validationStatus: snapshot?.validationStatus ?? (
            entry.validationStatus === 'promotable'
            || entry.validationStatus === 'conflicted'
            || entry.validationStatus === 'monitoring'
              ? entry.validationStatus
              : 'monitoring'
          ),
          successfulReuseTaskIds: snapshot?.successfulReuseTaskIds ?? (
            Array.isArray(entry.successfulReuseTaskIds)
              ? entry.successfulReuseTaskIds.filter((value): value is string => typeof value === 'string')
              : []
          ),
          failedReuseTaskIds: snapshot?.failedReuseTaskIds ?? (
            Array.isArray(entry.failedReuseTaskIds)
              ? entry.failedReuseTaskIds.filter((value): value is string => typeof value === 'string')
              : []
          )
        };
      })
    : [];
  return {
    configuredCount: typeof payload?.configuredApprovedExperienceCount === 'number'
      ? payload.configuredApprovedExperienceCount
      : selected.length,
    selectedCount: selected.length,
    selected: selected.map((entry) => ({
      proposalId: entry.proposalId,
      title: entry.title,
      selectedBy: entry.selectedBy,
      validationEligible: entry.validationEligible,
      materializedPath: entry.materializedPath,
      referenceSummary: entry.referenceSummary,
      limitations: entry.limitations,
      validationStatus: entry.validationStatus
    })),
    validationCandidates: selected
      .filter((entry) => entry.validationEligible)
      .map((entry) => ({
      proposalId: entry.proposalId,
      validationStatus: entry.validationStatus,
      successfulReuseTaskIds: entry.successfulReuseTaskIds,
      failedReuseTaskIds: entry.failedReuseTaskIds
      }))
  };
}

function buildConfiguredExtensionCounts(task: TaskQueryResponse): { skills: number; mcp: number } {
  const extensions = task.definition.metadata?.extensions;
  const record = extensions && typeof extensions === 'object' && !Array.isArray(extensions)
    ? extensions as Record<string, unknown>
    : null;
  return {
    skills: Array.isArray(record?.skills) ? record.skills.length : 0,
    mcp: Array.isArray(record?.mcp) ? record.mcp.length : 0
  };
}

function buildSkillSummary(task: TaskQueryResponse): TaskExecutionSummary['skillSummary'] {
  const configuredCount = buildConfiguredExtensionCounts(task).skills;
  const recent = task.events
    .filter((event) => event.type === 'SKILL_EXECUTED' && event.payload && typeof event.payload === 'object')
    .slice(-5)
    .reverse()
    .map((event) => {
      const payload = event.payload as { skillId?: unknown; status?: unknown; error?: unknown };
      return {
        skillId: typeof payload.skillId === 'string' ? payload.skillId : 'unknown',
        status: (
          payload.status === 'SUCCEEDED' || payload.status === 'FAILED' || payload.status === 'UNAVAILABLE'
            ? payload.status
            : 'FAILED'
        ) as 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE',
        message: typeof payload.error === 'string' ? payload.error : null
      };
    });
  return {
    configuredCount,
    availableCount: Math.max(0, configuredCount - recent.filter((entry) => entry.status === 'UNAVAILABLE').length),
    invokedCount: task.events.filter((event) => event.type === 'SKILL_EXECUTED').length,
    failureStreak: buildExtensionFailureStreak(recent, ['FAILED', 'UNAVAILABLE']),
    recent
  };
}

function buildMcpSummary(task: TaskQueryResponse): TaskExecutionSummary['mcpSummary'] {
  const configuredCount = buildConfiguredExtensionCounts(task).mcp;
  const explicitToolSelections = collectTaskExtensionItems(task, 'mcp')
    .map((entry) => {
      const serverId = typeof entry.serverId === 'string' ? entry.serverId : null;
      const toolName = typeof entry.toolName === 'string' ? entry.toolName : null;
      return serverId && toolName ? `${serverId}/${toolName}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  const explicitResourceSelections = collectTaskExtensionItems(task, 'mcpResources')
    .map((entry) => {
      const serverId = typeof entry.serverId === 'string' ? entry.serverId : null;
      const resourceName = typeof entry.resourceName === 'string'
        ? entry.resourceName
        : (typeof entry.resourceId === 'string' ? entry.resourceId : null);
      return serverId && resourceName ? `${serverId}/${resourceName}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  const explicitPromptSelections = collectTaskExtensionItems(task, 'mcpPrompts')
    .map((entry) => {
      const serverId = typeof entry.serverId === 'string' ? entry.serverId : null;
      const promptName = typeof entry.promptName === 'string'
        ? entry.promptName
        : (typeof entry.promptId === 'string' ? entry.promptId : null);
      return serverId && promptName ? `${serverId}/${promptName}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  const selectedInstructionSkills = latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? (latestWorkspaceEvent.payload as { selectedInstructionSkills?: unknown }).selectedInstructionSkills
    : null;
  const instructionSkillSelections = Array.isArray(selectedInstructionSkills)
    ? selectedInstructionSkills.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
  const recent = task.events
    .filter((event) => event.type === 'MCP_TOOL_EXECUTED' && event.payload && typeof event.payload === 'object')
    .slice(-5)
    .reverse()
    .map((event) => {
      const payload = event.payload as {
        serverId?: unknown;
        toolName?: unknown;
        status?: unknown;
        error?: unknown;
      };
      return {
        serverId: typeof payload.serverId === 'string' ? payload.serverId : 'unknown',
        toolName: typeof payload.toolName === 'string' ? payload.toolName : 'unknown',
        status: (
          payload.status === 'SUCCEEDED'
          || payload.status === 'FAILED'
          || payload.status === 'UNAVAILABLE'
          || payload.status === 'CAPABILITY_MISMATCH'
            ? payload.status
            : 'FAILED'
        ) as 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE' | 'CAPABILITY_MISMATCH',
        message: typeof payload.error === 'string' ? payload.error : null
      };
    });
  return {
    configuredCount,
    availableCount: Math.max(0, configuredCount - recent.filter((entry) => (
      entry.status === 'UNAVAILABLE' || entry.status === 'CAPABILITY_MISMATCH'
    )).length),
    invokedCount: task.events.filter((event) => event.type === 'MCP_TOOL_EXECUTED').length,
    failureStreak: buildExtensionFailureStreak(recent, ['FAILED', 'UNAVAILABLE', 'CAPABILITY_MISMATCH']),
    selectedServerIds: [...new Set([
      ...recent.map((entry) => entry.serverId),
      ...explicitToolSelections.map((entry) => entry.split('/')[0]),
      ...explicitResourceSelections.map((entry) => entry.split('/')[0]),
      ...explicitPromptSelections.map((entry) => entry.split('/')[0]),
      ...instructionSkillSelections.flatMap((entry) => parseDelimitedValues(entry.declaredMcpDependencies))
    ])],
    selectedTools: [...new Set([
      ...recent.map((entry) => `${entry.serverId}/${entry.toolName}`),
      ...explicitToolSelections
    ])],
    selectedResources: [...new Set([
      ...explicitResourceSelections,
      ...instructionSkillSelections.flatMap((entry) => parseDelimitedValues(entry.declaredMcpResources))
    ])],
    selectedPrompts: [...new Set([
      ...explicitPromptSelections,
      ...instructionSkillSelections.flatMap((entry) => parseDelimitedValues(entry.declaredMcpPrompts))
    ])],
    readinessSummary: {
      ready: [],
      missingClient: [],
      metadataOnly: []
    },
    recent
  };
}

function buildProviderSummary(
  task: TaskQueryResponse,
  foundation?: BackendNewFoundation
): TaskExecutionSummary['providerSummary'] {
  const providerId = typeof task.runtime.selectedProviderId === 'string' && task.runtime.selectedProviderId.trim()
    ? task.runtime.selectedProviderId
    : (task.definition.preferredProviderId ?? null);
  const selectedBy: TaskExecutionSummary['providerSummary']['selectedBy'] =
    task.runtime.selectedProviderId
      ? 'runtime_selected'
      : task.definition.preferredProviderId
        ? 'task_preference'
        : foundation?.config.providers.defaultProviderId
          ? 'config_default'
          : (foundation?.config.providers.preferLocalModels ? 'prefer_local' : 'first_available');
  if (!providerId) {
    return {
      providerId: null,
      modelId: null,
      variantId: null,
      selectedBy: null,
      transport: null,
      readiness: null,
      authSource: null,
      recentStatus: 'unknown',
      lastMessage: null
    };
  }
  const profile = foundation?.providers.get(providerId) ?? null;
  if (!foundation || !profile) {
    return {
      providerId,
      modelId: task.diagnostics.providerFailure?.providerId === providerId ? null : null,
      variantId: null,
      selectedBy,
      transport: null,
      readiness: null,
      authSource: null,
      recentStatus: task.diagnostics.providerFailure?.providerId === providerId ? 'failed' : 'selected',
      lastMessage: task.diagnostics.providerFailure?.providerId === providerId ? task.diagnostics.providerFailure.message : null
    };
  }
  const view = createProviderProfileView({
    foundation,
    profile,
    hasSecret: Boolean(profile.apiKeySecretId)
  });
  const metadata = profile.metadata && typeof profile.metadata === 'object'
    ? profile.metadata
    : {};
  const recentStatus: TaskExecutionSummary['providerSummary']['recentStatus'] = task.diagnostics.providerFailure?.providerId === providerId
    ? 'failed'
    : view.readiness === 'missing-secret'
      ? 'missing-secret'
      : view.readiness === 'missing-client'
        ? 'missing-client'
        : view.readiness === 'ready'
          ? 'ready'
          : 'selected';
  return {
    providerId,
    modelId: profile.model,
    variantId: typeof metadata.variantId === 'string' ? metadata.variantId : 'default',
    selectedBy,
    transport: view.adapter.transport,
    readiness: view.readiness,
    authSource: view.authSource,
    recentStatus,
    lastMessage: task.diagnostics.providerFailure?.providerId === providerId
      ? task.diagnostics.providerFailure.message
      : null
  };
}

function buildPermissionSummary(
  task: TaskQueryResponse,
  foundation?: BackendNewFoundation
): TaskExecutionSummary['permissionSummary'] {
  const mode = foundation?.config.tools.permissionMode ?? 'ask';
  type PermissionDecision = NonNullable<TaskExecutionSummary['permissionSummary']>['recent'][number]['decision'];
  const recent = task.toolInvocations
    .slice(-5)
    .reverse()
    .map((invocation) => {
      const metadata = invocation.metadata && typeof invocation.metadata === 'object'
        ? invocation.metadata as { permissionDecision?: unknown; permissionReason?: unknown }
        : {};
      const decision: PermissionDecision = metadata.permissionDecision === 'DENY'
        ? 'DENY'
        : metadata.permissionDecision === 'REQUIRE_APPROVAL'
          ? 'REQUIRE_APPROVAL'
          : 'ALLOW';
      return {
        toolId: invocation.toolId,
        decision,
        reason: typeof metadata.permissionReason === 'string' ? metadata.permissionReason : null
      };
    });
  return {
    mode,
    approvalRequiredCount: recent.filter((entry) => entry.decision === 'REQUIRE_APPROVAL').length + task.pendingApprovals.length,
    deniedCount: recent.filter((entry) => entry.decision === 'DENY').length,
    recent
  };
}

function buildCapabilityWarnings(params: {
  task: TaskQueryResponse;
  foundation?: BackendNewFoundation;
  providerSummary: TaskExecutionSummary['providerSummary'];
  instructionSkillSummary: TaskExecutionSummary['instructionSkillSummary'];
  skillSummary: TaskExecutionSummary['skillSummary'];
  mcpSummary: TaskExecutionSummary['mcpSummary'];
  permissionSummary: TaskExecutionSummary['permissionSummary'];
  hookSummary: TaskExecutionSummary['hookSummary'];
}): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];
  const {
    task,
    foundation,
    providerSummary,
    instructionSkillSummary,
    skillSummary,
    mcpSummary,
    permissionSummary,
    hookSummary
  } = params;
  if (providerSummary.providerId && providerSummary.readiness === 'missing-secret') {
    warnings.push({
      code: 'provider-missing-secret',
      capabilityKind: 'provider',
      capabilityId: providerSummary.providerId,
      message: `Provider "${providerSummary.providerId}" is selected but missing a secret.`,
      hardBlocker: true
    });
  }
  if (providerSummary.providerId && providerSummary.readiness === 'missing-client') {
    warnings.push({
      code: 'provider-unavailable',
      capabilityKind: 'provider',
      capabilityId: providerSummary.providerId,
      message: `Provider "${providerSummary.providerId}" is selected but no runtime client is registered.`,
      hardBlocker: true
    });
  }
  for (const recent of skillSummary.recent.filter((entry) => entry.status === 'UNAVAILABLE')) {
    warnings.push({
      code: 'runtime-skill-unavailable',
      capabilityKind: 'runtime-skill',
      capabilityId: recent.skillId,
      message: recent.message ?? `Runtime skill "${recent.skillId}" is unavailable for this task.`,
      hardBlocker: false
    });
  }

  const configuredMcpIds = new Set(foundation ? createAllMcpCatalogEntries(foundation).map((entry) => entry.server.id) : []);
  const readyMcpIds = new Set(foundation
    ? createAllMcpCatalogEntries(foundation)
      .filter((entry) => entry.readiness === 'ready')
      .map((entry) => entry.server.id)
    : []
  );
  for (const selected of instructionSkillSummary.selected) {
    for (const dependency of selected.declaredMcpDependencies) {
      if (!configuredMcpIds.has(dependency)) {
        warnings.push({
          code: 'instruction-skill-dependency-missing',
          capabilityKind: 'instruction-skill',
          capabilityId: selected.skillId,
          message: `Instruction skill "${selected.name}" declares MCP dependency "${dependency}", but that server is not configured.`,
          hardBlocker: false
        });
      } else if (!readyMcpIds.has(dependency)) {
        warnings.push({
          code: 'required-mcp-missing',
          capabilityKind: 'mcp-server',
          capabilityId: dependency,
          message: `MCP server "${dependency}" is declared by "${selected.name}" but is not ready.`,
          hardBlocker: false
        });
      }
    }
    for (const resource of selected.declaredMcpResources) {
      const dependency = resource.includes('/') ? resource.split('/')[0] : resource;
      if (!dependency) {
        continue;
      }
      if (!configuredMcpIds.has(dependency)) {
        warnings.push({
          code: 'instruction-skill-dependency-missing',
          capabilityKind: 'instruction-skill',
          capabilityId: selected.skillId,
          message: `Instruction skill "${selected.name}" declares MCP resource "${resource}", but server "${dependency}" is not configured.`,
          hardBlocker: false
        });
      }
    }
    for (const prompt of selected.declaredMcpPrompts) {
      const dependency = prompt.includes('/') ? prompt.split('/')[0] : prompt;
      if (!dependency) {
        continue;
      }
      if (!configuredMcpIds.has(dependency)) {
        warnings.push({
          code: 'instruction-skill-dependency-missing',
          capabilityKind: 'instruction-skill',
          capabilityId: selected.skillId,
          message: `Instruction skill "${selected.name}" declares MCP prompt "${prompt}", but server "${dependency}" is not configured.`,
          hardBlocker: false
        });
      }
    }
  }
  for (const dependency of instructionSkillSummary.selected.flatMap((entry) => entry.preferredProviderIds)) {
    const provider = dependency.trim();
    if (!provider) {
      continue;
    }
    if (!providerSummary.providerId || providerSummary.providerId !== provider) {
      warnings.push({
        code: 'provider-unavailable',
        capabilityKind: 'provider',
        capabilityId: provider,
        message: `Instruction skill dependency prefers provider "${provider}", but the task is using "${providerSummary.providerId ?? 'none'}".`,
        hardBlocker: false
      });
    }
  }
  for (const recent of mcpSummary.recent.filter((entry) => entry.status === 'UNAVAILABLE' || entry.status === 'CAPABILITY_MISMATCH')) {
    warnings.push({
      code: 'required-mcp-missing',
      capabilityKind: 'mcp-server',
      capabilityId: recent.serverId,
      message: recent.message ?? `MCP server "${recent.serverId}" is not ready for tool "${recent.toolName}".`,
      hardBlocker: false
    });
  }
  if (permissionSummary.deniedCount > 0) {
    const latestDenied = permissionSummary.recent.find((entry) => entry.decision === 'DENY');
    warnings.push({
      code: 'permission-denied',
      capabilityKind: 'workspace-command',
      capabilityId: latestDenied?.toolId ?? 'tool-permissions',
      message: latestDenied?.reason
        ? `Tool execution was denied by policy: ${latestDenied.reason}`
        : 'At least one tool invocation was denied by permission policy.',
      hardBlocker: true
    });
  }
  if (hookSummary.failedCount > 0) {
    const recentFailedHook = hookSummary.recent.find((entry) => entry.status === 'FAILED');
    warnings.push({
      code: 'hook-failed',
      capabilityKind: 'workspace-agent',
      capabilityId: recentFailedHook?.event ?? 'workspace-hook',
      message: recentFailedHook
        ? `Workspace hook "${recentFailedHook.event}" failed while running "${recentFailedHook.command}".`
        : 'One or more workspace hooks failed during task execution.',
      hardBlocker: false
    });
  }
  if (task.diagnostics.providerFailure?.providerId && providerSummary.providerId === task.diagnostics.providerFailure.providerId) {
    warnings.push({
      code: 'provider-unavailable',
      capabilityKind: 'provider',
      capabilityId: providerSummary.providerId,
      message: task.diagnostics.providerFailure.message,
      hardBlocker: true
    });
  }
  return warnings.filter((warning, index, items) => (
    items.findIndex((candidate) => (
      candidate.code === warning.code
      && candidate.capabilityId === warning.capabilityId
      && candidate.message === warning.message
    )) === index
  ));
}

function buildTurnContract(
  task: TaskQueryResponse,
  artifactRouting: TaskArtifactRoutingSummary
): TaskExecutionSummary['turnContract'] {
  const diagnostics = task.runtime.contractDiagnostics;
  const correctionLoopNonConvergent = diagnostics?.correctionLoopNonConvergent ?? false;
  const conservativeMode = Boolean(task.runtime.compressionDowngraded ?? task.runtime.guardrails?.compressionDowngraded);
  if (task.runtime.lifecycleStatus !== 'RUNNING') {
      return {
        currentUnitId: task.runtime.currentUnitId,
        pendingCorrection: task.runtime.pendingCorrection,
        requiresToolEvidence: diagnostics?.currentUnit.requiresToolEvidence ?? false,
        lastAcceptanceFailureCategory: diagnostics?.lastAcceptanceFailureCategory ?? null,
      lastPendingCorrectionKind: diagnostics?.lastPendingCorrectionKind ?? null,
      lastCorrectionPromptMode: diagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
      correctionLoopNonConvergent,
      conservativeMode,
      continueAllowed: false,
      continueReason: `Task lifecycle is ${task.runtime.lifecycleStatus}, so continue is not allowed.`
    };
  }
  if (correctionLoopNonConvergent) {
    return {
      currentUnitId: task.runtime.currentUnitId,
      pendingCorrection: task.runtime.pendingCorrection,
      requiresToolEvidence: diagnostics?.currentUnit.requiresToolEvidence ?? false,
      lastAcceptanceFailureCategory: diagnostics?.lastAcceptanceFailureCategory ?? null,
      lastPendingCorrectionKind: diagnostics?.lastPendingCorrectionKind ?? null,
      lastCorrectionPromptMode: diagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
      correctionLoopNonConvergent,
      conservativeMode,
      continueAllowed: false,
      continueReason: 'Repeated identical correction failures indicate a non-convergent loop; explicit operator guidance or restart is required.'
    };
  }
  if (artifactRouting.needsExplicitDestination) {
    return {
      currentUnitId: task.runtime.currentUnitId,
      pendingCorrection: task.runtime.pendingCorrection,
      requiresToolEvidence: diagnostics?.currentUnit.requiresToolEvidence ?? false,
      lastAcceptanceFailureCategory: diagnostics?.lastAcceptanceFailureCategory ?? null,
      lastPendingCorrectionKind: diagnostics?.lastPendingCorrectionKind ?? null,
      lastCorrectionPromptMode: diagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
      correctionLoopNonConvergent,
      conservativeMode,
      continueAllowed: false,
      continueReason: artifactRouting.recommendedArtifactDir
        ? `Select a project-relative destination before continuing. Recommended directory: ${artifactRouting.recommendedArtifactDir}.`
        : 'Select a project-relative destination before continuing because generated artifacts are still only in the task workspace.'
    };
  }
  return {
    currentUnitId: task.runtime.currentUnitId,
    pendingCorrection: task.runtime.pendingCorrection,
    requiresToolEvidence: diagnostics?.currentUnit.requiresToolEvidence ?? false,
    lastAcceptanceFailureCategory: diagnostics?.lastAcceptanceFailureCategory ?? null,
    lastPendingCorrectionKind: diagnostics?.lastPendingCorrectionKind ?? null,
    lastCorrectionPromptMode: diagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
    correctionLoopNonConvergent,
    conservativeMode,
    continueAllowed: true,
    continueReason: task.runtime.pendingCorrection === 'NONE'
      ? 'Task is running with no active correction requirement.'
      : `Task is running and awaiting ${task.runtime.pendingCorrection}.`
  };
}

function tryParseRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractOutputContractKeys(outputContract?: string | null): string[] {
  const parsed = tryParseRecord(outputContract);
  return parsed ? Object.keys(parsed) : [];
}

function findLatestExplicitOutputEnvelope(task: TaskQueryResponse, unitId: string | null) {
  if (!unitId) {
    return null;
  }
  const assistantMessages = task.conversations
    .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
    .reverse();
  for (const message of assistantMessages) {
    const parsed = parseTurn(message.content);
    const output = [...parsed.explicitOutputs]
      .reverse()
      .find((entry) => entry.unitId === unitId && isRecord(entry.parsedJson));
    if (output) {
      return output;
    }
  }
  return null;
}

function getAcceptanceUnit(task: TaskQueryResponse): {
  unitId: string | null;
  profileId: TaskExecutionSummary['acceptance']['deterministic']['profileId'];
  outputContract: string | null;
} {
  const preferredUnitId = task.latestVisibleOutput?.unitId
    ?? task.runtime.progressHistory.at(-1)?.currentUnit
    ?? task.runtime.currentUnitId
    ?? task.definition.units.at(-1)?.id
    ?? null;
  const unit = preferredUnitId
    ? task.definition.units.find((entry) => entry.id === preferredUnitId) ?? null
    : (task.definition.units.at(-1) ?? null);
  return {
    unitId: unit?.id ?? preferredUnitId ?? null,
    profileId: unit?.executionProfileId ?? 'analyze',
    outputContract: unit?.outputContract ?? null
  };
}

function createAcceptanceLayer(
  verdict: TaskExecutionSummary['acceptance']['deterministic']['contract']['verdict'],
  summary: string,
  passedChecks: string[],
  failedChecks: string[],
  requiredNextEvidence: string[]
): TaskExecutionSummary['acceptance']['deterministic']['contract'] {
  return {
    verdict,
    summary,
    passedChecks,
    failedChecks,
    requiredNextEvidence
  };
}

function createSemanticReviewDefault(params: {
  providerId: string | null;
  modelId: string | null;
  cached?: TaskExecutionSummary['acceptance']['semanticReview'] | null;
}): TaskExecutionSummary['acceptance']['semanticReview'] {
  const cached = params.cached ?? null;
  if (cached) {
    return {
      status: cached.status,
      verdict: cached.verdict ?? null,
      providerId: cached.providerId ?? params.providerId,
      modelId: cached.modelId ?? params.modelId,
      reviewedAt: cached.reviewedAt ?? null,
      confidence: cached.confidence ?? null,
      summary: cached.summary ?? null,
      mismatches: [...(cached.mismatches ?? [])],
      missingEvidence: [...(cached.missingEvidence ?? [])],
      error: cached.error ?? null
    };
  }
  return {
    status: 'not_requested',
    verdict: null,
    providerId: params.providerId,
    modelId: params.modelId,
    reviewedAt: null,
    confidence: null,
    summary: null,
    mismatches: [],
    missingEvidence: [],
    error: null
  };
}

function isVerificationTool(invocation: Pick<ToolInvocationRecord, 'toolId' | 'metadata' | 'arguments' | 'result'>): boolean {
  const metadata = isRecord(invocation.metadata) ? invocation.metadata : {};
  const normalized = invocation.toolId.trim().toLowerCase().replace(/-/g, '_');
  if (metadata.verification === true || metadata.validation === true) {
    return true;
  }
  return shouldMarkInvocationAsVerification({
    toolName: invocation.toolId,
    argumentsRecord: isRecord(invocation.arguments) ? invocation.arguments : {}
  });
}

function isFailedInspectionVerificationTool(invocation: Pick<ToolInvocationRecord, 'toolId' | 'status'>): boolean {
  if (invocation.status !== 'FAILED') {
    return false;
  }
  const normalized = invocation.toolId.trim().toLowerCase().replace(/-/g, '_');
  return normalized === 'read_file'
    || normalized === 'inspect_file'
    || normalized === 'search_files'
    || normalized === 'list_files';
}

function isAcknowledgedFailedInspectionEvidence(
  invocation: Pick<ToolInvocationRecord, 'toolId' | 'status' | 'arguments' | 'result'>,
  outputText: string
): boolean {
  if (!isFailedInspectionVerificationTool(invocation)) {
    return false;
  }
  const normalizedOutput = outputText.toLowerCase();
  if (!/\b(missing|not found|does not exist|enoent|absent|unavailable)\b/i.test(outputText)) {
    return false;
  }
  const evidencePaths = collectInvocationEvidencePaths(invocation)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean);
  return evidencePaths.length === 0 || evidencePaths.some((entry) => normalizedOutput.includes(entry));
}

function isBlockingVerificationFailure(
  invocation: Pick<ToolInvocationRecord, 'toolId' | 'metadata' | 'arguments' | 'result' | 'status'>,
  profileId: TaskExecutionSummary['acceptance']['deterministic']['profileId'],
  outputText = ''
): boolean {
  if (invocation.status !== 'FAILED' || !isVerificationTool(invocation)) {
    return false;
  }
  if (isAcknowledgedFailedInspectionEvidence(invocation, outputText)) {
    return false;
  }
  if (profileId === 'verify') {
    return true;
  }
  if (profileId !== 'implement') {
    return false;
  }
  const metadata = isRecord(invocation.metadata) ? invocation.metadata : {};
  if (metadata.validation === true) {
    return true;
  }
  const normalized = invocation.toolId.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'run_command') {
    return shouldMarkInvocationAsVerification({
      toolName: invocation.toolId,
      argumentsRecord: isRecord(invocation.arguments) ? invocation.arguments : {}
    });
  }
  return /(^|_)(verify|test|check|validate|validation|health)(_|$)/.test(normalized);
}

function hasFailedVerification(
  task: TaskQueryResponse,
  profileId: TaskExecutionSummary['acceptance']['deterministic']['profileId'],
  options: {
    unitId?: string | null;
    outputText?: string;
  } = {}
): boolean {
  const blockingFailures = task.toolInvocations
    .map((invocation, index) => ({ invocation, index }))
    .filter(({ invocation }) => {
      if (options.unitId && invocation.unitId !== options.unitId) {
        return false;
      }
      return isBlockingVerificationFailure(invocation, profileId, options.outputText ?? '');
    });
  if (blockingFailures.length === 0) {
    return false;
  }
  const unresolvedBlockingFailure = [...blockingFailures]
    .reverse()
    .find(({ index }) => !isFailedToolResolvedByLaterSuccess(task, index, {
      requireVerificationSuccess: true
    }));
  if (!unresolvedBlockingFailure) {
    return false;
  }
  return true;
}

function collectGroundingEvidence(params: {
  task: TaskQueryResponse;
  artifactRouting: TaskArtifactRoutingSummary;
  outputText: string;
  requireGrounding: boolean;
}): TaskExecutionSummary['acceptance']['evidence']['groundingEvidence'] {
  const normalizedOutput = params.outputText.toLowerCase();
  const knownPaths = [
    ...params.artifactRouting.artifactPaths,
    ...params.artifactRouting.artifactDestinationPaths
  ]
    .map((entry) => normalizeReferencePath(entry))
    .filter(Boolean);
  const pathReferences = knownPaths.filter((entry) => normalizedOutput.includes(entry.toLowerCase()));
  const taskIdReferences = Array.from(new Set((params.outputText.match(/\btask_[a-z0-9_]+\b/gi) ?? []).map((entry) => entry.trim())));
  const eventTypeReferences = Array.from(new Set(
    params.task.events
      .map((event) => event.type)
      .filter((eventType) => Boolean(eventType) && normalizedOutput.includes(eventType.toLowerCase()))
  ));
  const artifactReferences = Array.from(new Set(
    knownPaths.filter((entry) => entry.includes('.') && normalizedOutput.includes(entry.toLowerCase()))
  ));
  const referenceCount = pathReferences.length + taskIdReferences.length + eventTypeReferences.length + artifactReferences.length;
  const satisfied = !params.requireGrounding || referenceCount > 0;
  return {
    required: params.requireGrounding,
    satisfied,
    referenceCount,
    pathReferences,
    taskIdReferences,
    eventTypeReferences,
    artifactReferences,
    summary: !params.requireGrounding
      ? 'Grounding evidence is optional for this task.'
      : satisfied
        ? `Grounding evidence found (${referenceCount} reference(s)).`
        : 'Grounding evidence is missing from the delivered summary.'
  };
}

function buildAcceptanceSummary(
  task: TaskQueryResponse,
  foundation: BackendNewFoundation | undefined,
  artifactRouting: TaskArtifactRoutingSummary,
  turnContract: TaskExecutionSummary['turnContract']
): Omit<TaskExecutionSummary['acceptance'], 'semanticReview'> {
  const acceptanceUnit = getAcceptanceUnit(task);
  const outputContractKeys = extractOutputContractKeys(acceptanceUnit.outputContract);
  const latestOutput = task.latestVisibleOutput;
  const latestExplicitOutputEnvelope = findLatestExplicitOutputEnvelope(task, acceptanceUnit.unitId);
  const latestExplicitOutputRecord = isRecord(latestExplicitOutputEnvelope?.parsedJson)
    ? latestExplicitOutputEnvelope.parsedJson
    : null;
  const explicitOutputValidation = latestExplicitOutputEnvelope
    ? validateExplicitOutput({
      currentUnitId: acceptanceUnit.unitId ?? latestExplicitOutputEnvelope.unitId,
      explicitOutputs: [latestExplicitOutputEnvelope],
      outputContract: acceptanceUnit.outputContract ?? undefined
    })
    : null;
  const latestTracker = task.runtime.progressHistory.at(-1) ?? null;
  const diagnostics = task.runtime.contractDiagnostics ?? null;
  const acceptanceIssueCodes = [...(diagnostics?.lastAcceptanceIssueCodes ?? [])];
  const acceptanceIssueMessages = [...(diagnostics?.lastAcceptanceIssueMessages ?? [])];
  const outputText = [latestOutput?.summary, latestOutput?.details]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  const visibleOutputRecord = {
    summary: latestOutput?.summary ?? null,
    details: latestOutput?.details ?? null,
    report: latestOutput?.details ?? latestOutput?.summary ?? null,
    issues: latestOutput?.issues ?? [],
    artifact: latestOutput?.artifactPaths?.[0] ?? null,
    artifacts: latestOutput?.artifactPaths ?? [],
    files: latestOutput?.artifactPaths ?? [],
    files_created: latestOutput?.artifactPaths ?? [],
    producedFiles: latestOutput?.artifactPaths ?? [],
    artifactDestination: latestOutput?.artifactDestinationDir ?? null
  };
  const contractOutputRecord = latestExplicitOutputRecord ?? visibleOutputRecord;
  const missingContractKeys = outputContractKeys.filter((key) => !Object.prototype.hasOwnProperty.call(contractOutputRecord, key));
  const contractShapeIssues = explicitOutputValidation?.issues
    .filter((issue) => issue.code === 'contract_type_mismatch')
    .map((issue) => issue.message) ?? [];
  const explicitOutput = {
    present: latestOutput?.source === 'validated_output' || Boolean(latestExplicitOutputRecord),
    source: latestOutput?.source ?? (latestExplicitOutputRecord ? 'assistant_fallback' : 'missing'),
    contractKeys: outputContractKeys,
    missingContractKeys,
    invalidJson: !latestExplicitOutputRecord && latestOutput?.source !== 'validated_output' && outputContractKeys.length > 0,
    summary: latestOutput?.source === 'validated_output' || latestExplicitOutputRecord
      ? 'Validated explicit output is available.'
      : latestOutput
        ? `Visible output is coming from ${latestOutput.source}, not a validated explicit output envelope.`
        : 'No visible explicit output is available.'
  } satisfies TaskExecutionSummary['acceptance']['evidence']['explicitOutput'];
  const progressTracker = {
    present: Boolean(latestTracker),
    status: latestTracker?.status ?? null,
    decision: latestTracker?.decision ?? null,
    issues: [...acceptanceIssueCodes],
    summary: latestTracker
      ? `Latest tracker reports ${latestTracker.status} / ${latestTracker.decision}.`
      : 'No accepted progress tracker is available.'
  } satisfies TaskExecutionSummary['acceptance']['evidence']['progressTracker'];
  const successfulToolInvocations = task.toolInvocations.filter((invocation) => invocation.status === 'SUCCEEDED');
  const verificationInvocations = task.toolInvocations.filter((invocation) => (
    (invocation.status === 'SUCCEEDED' && isVerificationTool(invocation))
    || isFailedInspectionVerificationTool(invocation)
  ));
  const persistentWriteEvidenceCount = successfulToolInvocations.filter((invocation) => (
    isArtifactWriteEvidenceTool(invocation.toolId) && collectInvocationEvidencePaths(invocation).length > 0
  )).length;
  const toolEvidenceRequired = acceptanceUnit.profileId === 'verify';
  const artifactEvidenceRequired = acceptanceUnit.profileId === 'implement';
  const toolEvidence = {
    required: toolEvidenceRequired,
    satisfied: !toolEvidenceRequired || verificationInvocations.length > 0,
    invocationCount: task.toolInvocations.length,
    successfulCount: successfulToolInvocations.length,
    verificationCount: verificationInvocations.length,
    pendingApprovalCount: task.pendingApprovals.length,
    toolIds: Array.from(new Set(task.toolInvocations.map((invocation) => invocation.toolId))).sort((left, right) => left.localeCompare(right)),
    summary: toolEvidenceRequired
      ? (verificationInvocations.length > 0
        ? `Verification evidence found in ${verificationInvocations.length} tool invocation(s).`
        : 'No verification evidence was recorded.')
      : (task.toolInvocations.length > 0 ? `${task.toolInvocations.length} tool invocation(s) recorded.` : 'No tool evidence required for this task.')
  } satisfies TaskExecutionSummary['acceptance']['evidence']['toolEvidence'];
  const artifactEvidence = {
    required: artifactEvidenceRequired,
    satisfied: !artifactEvidenceRequired
      || artifactRouting.artifactPaths.length > 0
      || artifactRouting.artifactDestinationPaths.length > 0
      || persistentWriteEvidenceCount > 0,
    artifactPathState: artifactRouting.artifactPathState,
    artifactPaths: [...artifactRouting.artifactPaths],
    summary: artifactEvidenceRequired
      ? (
        artifactRouting.artifactPaths.length > 0
        || artifactRouting.artifactDestinationPaths.length > 0
        || persistentWriteEvidenceCount > 0
          ? 'Persistent artifact or write evidence is available.'
          : 'No persistent artifact or write evidence was recorded.'
      )
      : (artifactRouting.artifactPaths.length > 0 ? 'Artifact evidence was recorded.' : 'Artifact evidence is optional for this task.')
  } satisfies TaskExecutionSummary['acceptance']['evidence']['artifactEvidence'];
  const deliveryEvidence = {
    required: false,
    delivered: artifactRouting.artifactDestinationPaths.length > 0 || artifactRouting.lastArtifactApplyResult?.status === 'APPLIED',
    artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir ?? artifactRouting.selectedArtifactDir ?? null,
    artifactDestinationPaths: [...artifactRouting.artifactDestinationPaths],
    summary: artifactRouting.artifactDestinationPaths.length > 0 || artifactRouting.lastArtifactApplyResult?.status === 'APPLIED'
      ? 'Delivered artifact destination evidence is available.'
      : 'No delivered artifact destination has been recorded.'
  } satisfies TaskExecutionSummary['acceptance']['evidence']['deliveryEvidence'];
  const requireGrounding = acceptanceUnit.profileId === 'analyze'
    && (
      task.toolInvocations.length > 0
      || artifactRouting.artifactPaths.length > 0
      || artifactRouting.artifactDestinationPaths.length > 0
    );
  const groundingEvidence = collectGroundingEvidence({
    task,
    artifactRouting,
    outputText,
    requireGrounding
  });

  const contractPassedChecks: string[] = [];
  const contractFailedChecks: string[] = [];
  const contractRequiredNextEvidence: string[] = [];
  if (explicitOutput.present) {
    contractPassedChecks.push('validated_explicit_output_present');
  } else {
    contractFailedChecks.push('missing_validated_explicit_output');
    contractRequiredNextEvidence.push('emit_validated_explicit_output');
  }
  if (missingContractKeys.length === 0) {
    contractPassedChecks.push('output_contract_keys_satisfied');
  } else if (outputContractKeys.length > 0) {
    contractFailedChecks.push(`missing_contract_keys:${missingContractKeys.join(',')}`);
    contractRequiredNextEvidence.push(`include_contract_keys:${missingContractKeys.join(',')}`);
  }
  if (contractShapeIssues.length === 0) {
    if (explicitOutputValidation) {
      contractPassedChecks.push('output_contract_shape_satisfied');
    }
  } else {
    contractFailedChecks.push('contract_shape_mismatch');
    contractRequiredNextEvidence.push('satisfy_output_contract_shape');
  }
  const contract = createAcceptanceLayer(
    contractFailedChecks.length === 0 ? 'passed' : 'failed',
    contractFailedChecks.length === 0
      ? 'Explicit output and output contract requirements are satisfied.'
      : explicitOutput.summary,
    contractPassedChecks,
    contractFailedChecks,
    Array.from(new Set(contractRequiredNextEvidence))
  );

  const executionPassedChecks: string[] = [];
  const executionFailedChecks: string[] = [];
  const executionRequiredNextEvidence: string[] = [];
  if (progressTracker.present) {
    executionPassedChecks.push('progress_tracker_present');
  } else {
    executionFailedChecks.push('missing_progress_tracker');
    executionRequiredNextEvidence.push('emit_progress_tracker');
  }
  if (task.runtime.pendingCorrection === 'NONE') {
    executionPassedChecks.push('no_pending_correction');
  } else {
    executionFailedChecks.push(`pending_correction:${task.runtime.pendingCorrection.toLowerCase()}`);
    if (task.runtime.pendingCorrection === 'AWAITING_TRACKER') {
      executionRequiredNextEvidence.push('emit_progress_tracker');
    } else if (task.runtime.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
      executionRequiredNextEvidence.push('emit_structured_output');
    } else if (task.runtime.pendingCorrection === 'AWAITING_TOOL_ACTION') {
      executionRequiredNextEvidence.push('emit_real_tool_or_verification_evidence');
    } else if (task.runtime.pendingCorrection === 'AWAITING_BLOCKER_EXPLANATION') {
      executionRequiredNextEvidence.push('explain_blocker_and_next_step');
    }
  }
  if (turnContract.lastAcceptanceFailureCategory) {
    executionFailedChecks.push(`acceptance_failure:${turnContract.lastAcceptanceFailureCategory}`);
  }
  for (const issueCode of acceptanceIssueCodes) {
    const labeled = `issue:${issueCode}`;
    if (!executionFailedChecks.includes(labeled)) {
      executionFailedChecks.push(labeled);
    }
  }
  const execution = createAcceptanceLayer(
    executionFailedChecks.length === 0 ? 'passed' : 'failed',
    executionFailedChecks.length === 0
      ? 'Tracker state and correction loop are aligned.'
      : (acceptanceIssueMessages[0] ?? progressTracker.summary),
    executionPassedChecks,
    executionFailedChecks,
    Array.from(new Set(executionRequiredNextEvidence))
  );

  const evidencePassedChecks: string[] = [];
  const evidenceFailedChecks: string[] = [];
  const evidenceRequiredNextEvidence: string[] = [];
  if (artifactEvidence.required) {
    if (artifactEvidence.satisfied) {
      evidencePassedChecks.push('persistent_effect_evidence_present');
    } else {
      evidenceFailedChecks.push('missing_persistent_effect_evidence');
      evidenceRequiredNextEvidence.push('record_persistent_artifact_or_write_evidence');
    }
  } else {
    evidencePassedChecks.push('persistent_effect_evidence_not_required');
  }
  if (toolEvidence.required) {
    if (toolEvidence.satisfied) {
      evidencePassedChecks.push('verification_evidence_present');
    } else {
      evidenceFailedChecks.push('missing_verification_evidence');
      evidenceRequiredNextEvidence.push('run_successful_verification_action');
    }
  } else {
    evidencePassedChecks.push('verification_evidence_not_required');
  }
  if (task.delegationSummary.missingRequiredDelegation) {
    evidenceFailedChecks.push('required_delegation_missing');
    evidenceRequiredNextEvidence.push('create_required_child_task');
  }
  const blockingVerificationFailure = hasFailedVerification(task, acceptanceUnit.profileId, {
    unitId: acceptanceUnit.unitId,
    outputText
  });
  if (blockingVerificationFailure) {
    evidenceFailedChecks.push('known_verification_failure');
    evidenceRequiredNextEvidence.push('resolve_failed_verification');
  }
  const evidence = createAcceptanceLayer(
    evidenceFailedChecks.length === 0 ? 'passed' : 'failed',
    evidenceFailedChecks.length === 0
      ? 'Required runtime evidence is present.'
      : [
        artifactEvidence.required ? artifactEvidence.summary : null,
        toolEvidence.required ? toolEvidence.summary : null,
        blockingVerificationFailure ? 'A verification action failed.' : null
      ].filter((value): value is string => Boolean(value)).join(' ') || 'Required runtime evidence is missing.',
    evidencePassedChecks,
    evidenceFailedChecks,
    Array.from(new Set(evidenceRequiredNextEvidence))
  );

  const outcomePassedChecks: string[] = [];
  const outcomeFailedChecks: string[] = [];
  const outcomeRequiredNextEvidence: string[] = [];
  const preconditionsPassed = contract.verdict === 'passed' && execution.verdict === 'passed' && evidence.verdict === 'passed';
  const trackerStatus = typeof progressTracker.status === 'string'
    ? progressTracker.status.toUpperCase()
    : null;
  if (preconditionsPassed) {
    outcomePassedChecks.push('deterministic_preconditions_passed');
  } else {
    outcomeFailedChecks.push('deterministic_preconditions_failed');
  }
  if (progressTracker.present && trackerStatus !== 'COMPLETE') {
    outcomeFailedChecks.push(`tracker_not_complete:${trackerStatus?.toLowerCase() ?? 'unknown'}`);
    outcomeRequiredNextEvidence.push('emit_complete_progress_tracker_when_work_is_done');
  }
  if (groundingEvidence.required) {
    if (groundingEvidence.satisfied) {
      outcomePassedChecks.push('grounding_evidence_present');
    } else {
      outcomeFailedChecks.push('missing_grounding_evidence');
      outcomeRequiredNextEvidence.push('cite_real_paths_events_or_task_ids');
    }
  } else {
    outcomePassedChecks.push('grounding_evidence_not_required');
  }
  if (acceptanceUnit.profileId === 'verify' && verificationInvocations.length === 0) {
    outcomeFailedChecks.push('verification_outcome_not_demonstrated');
    outcomeRequiredNextEvidence.push('demonstrate_real_verification_result');
  }
  if (acceptanceUnit.profileId === 'implement' && !artifactEvidence.satisfied && !deliveryEvidence.delivered) {
    outcomeFailedChecks.push('implement_outcome_not_materialized');
    outcomeRequiredNextEvidence.push('leave_persistent_repo_or_artifact_evidence');
  }
  const outcome = createAcceptanceLayer(
    outcomeFailedChecks.length === 0 ? 'passed' : 'failed',
    outcomeFailedChecks.length === 0
      ? 'The observed evidence supports the claimed task outcome.'
      : groundingEvidence.required && !groundingEvidence.satisfied
        ? groundingEvidence.summary
        : 'The observed evidence does not yet prove the claimed task outcome.',
    outcomePassedChecks,
    outcomeFailedChecks,
    Array.from(new Set(outcomeRequiredNextEvidence))
  );
  const deterministicPassed = contract.verdict === 'passed'
    && execution.verdict === 'passed'
    && evidence.verdict === 'passed'
    && outcome.verdict === 'passed';

  return {
    deterministic: {
      verdict: deterministicPassed ? 'passed' : 'failed',
      profileId: acceptanceUnit.profileId,
      unitId: acceptanceUnit.unitId,
      contract,
      execution,
      evidence,
      outcome
    },
    evidence: {
      explicitOutput,
      progressTracker,
      toolEvidence,
      artifactEvidence,
      deliveryEvidence,
      groundingEvidence
    }
  };
}

export function buildTaskExecutionSummary(
  task: TaskQueryResponse,
  foundation?: BackendNewFoundation,
  options?: {
    semanticReview?: TaskExecutionSummary['acceptance']['semanticReview'] | null;
  }
): TaskExecutionSummary {
  const eventCounts = countEvents(task);
  const unitDurations = buildUnitDurations(task);
  const turnCount = buildTurnCount(unitDurations);
  const correctionDepth = buildCorrectionDepth(task, unitDurations);
  const stageDurations = buildStageDurations(task, unitDurations);
  const queueRuntimeAlignment = buildQueueRuntimeAlignment(task);
  const recovery = buildRecoverySummary(task);
  const artifactRouting = deriveTaskArtifactRoutingSummary({
    definition: task.definition,
    invocations: task.toolInvocations,
    commands: task.commands
  });
  const issue = classifyIssue(task, queueRuntimeAlignment, recovery, artifactRouting);
  const plannedToolBatchIds = new Set<string>();
  const plannedProviderBatchIds = new Set<string>();
  for (const event of task.events) {
    if (!event.payload || typeof event.payload !== 'object') {
      continue;
    }
    if (event.type === 'TOOL_BATCH_PLANNED') {
      const batchId = (event.payload as { batchId?: unknown }).batchId;
      if (typeof batchId === 'string' && batchId.trim()) {
        plannedToolBatchIds.add(batchId);
      }
    }
    if (event.type === 'PLAN_CREATED') {
      const payload = event.payload as {
        plannedProviderBatches?: Array<{ batchId?: unknown }>;
        plannedToolBatches?: Array<{ batchId?: unknown }>;
      };
      for (const batch of payload.plannedProviderBatches ?? []) {
        if (typeof batch.batchId === 'string' && batch.batchId.trim()) {
          plannedProviderBatchIds.add(batch.batchId);
        }
      }
      for (const batch of payload.plannedToolBatches ?? []) {
        if (typeof batch.batchId === 'string' && batch.batchId.trim()) {
          plannedToolBatchIds.add(batch.batchId);
        }
      }
    }
  }
  const plannedProviderBatchCount = task.runtime.planner?.providerBatchCount ?? 0;
  const plannedToolBatchCount = Math.max(
    task.runtime.planner?.toolBatchCount ?? 0,
    plannedToolBatchIds.size,
    eventCounts['TOOL_BATCH_PLANNED'] ?? 0
  );
  const executedToolBatchCount = eventCounts['TOOL_BATCH_EXECUTED'] ?? 0;
  const toolInvocationCount = task.toolInvocations.length;
  const ruleSummary = buildWorkspaceRuleSummary(task);
  const hookSummary = buildWorkspaceHookSummary(task);
  const agentSummary = buildWorkspaceAgentSummary(task);
  const instructionSkillSummary = buildInstructionSkillSummary(task);
  const experienceSummary = buildExperienceSummary(task, foundation);
  const skillSummary = buildSkillSummary(task);
  const mcpSummary = buildMcpSummary(task);
  const permissionSummary = buildPermissionSummary(task, foundation);
  if (foundation) {
    const mcpCatalog = createAllMcpCatalogEntries(foundation);
    mcpSummary.readinessSummary = {
      ready: mcpCatalog.filter((entry) => entry.readiness === 'ready').map((entry) => entry.server.id),
      missingClient: mcpCatalog.filter((entry) => entry.readiness === 'missing-client').map((entry) => entry.server.id),
      metadataOnly: mcpCatalog.filter((entry) => entry.readiness === 'partial' || entry.readiness === 'metadata-only').map((entry) => entry.server.id)
    };
  }
  const providerSummary = buildProviderSummary(task, foundation);
  const providerFailureStreak = buildProviderFailureStreak(task);
  const skillFailureStreak = skillSummary.failureStreak;
  const mcpFailureStreak = mcpSummary.failureStreak;
  const lastSafeCheckpointAt = buildLastSafeCheckpointAt(task);
  const lastRecoverySource = buildLastRecoverySource(recovery);
  const conservativeModeReason = buildConservativeModeReason({
    task,
    correctionDepth,
    providerFailureStreak,
    skillFailureStreak,
    mcpFailureStreak
  });
  const capabilityWarnings = buildCapabilityWarnings({
    task,
    foundation,
    providerSummary,
    instructionSkillSummary,
    skillSummary,
    mcpSummary,
    permissionSummary,
    hookSummary
  });

  const turnContract = buildTurnContract(task, artifactRouting);
  const acceptance = buildAcceptanceSummary(task, foundation, artifactRouting, turnContract);
  const resolvedIssue = issue;
  const issuePlane = classifyIssuePlane(resolvedIssue.issueCategory, task);
  const suggestedAction = buildSuggestedAction({
    task,
    issuePlane,
    issueCategory: resolvedIssue.issueCategory,
    issueSummary: resolvedIssue.issueSummary,
    turnContract
  });
  const workingDirectory = getTaskWorkingDirectorySettings(task.definition);
  return {
    issuePlane,
    issueCategory: resolvedIssue.issueCategory,
    issueSummary: resolvedIssue.issueSummary,
    suggestedAction,
    workingDirectory,
    eventCounts,
    turnCount,
    correctionDepth,
    stageDurations,
    unitDurations,
    plannerFallbackReasons: [...(task.runtime.planner?.fallbackReasons ?? [])],
    approvalBlockedBatchCount: task.runtime.pendingToolBatches.filter((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED').length,
    batchExecution: {
      plannedProviderBatchCount: Math.max(plannedProviderBatchCount, plannedProviderBatchIds.size),
      plannedToolBatchCount,
      executedToolBatchCount,
      toolInvocationCount,
      averageToolInvocationsPerBatch: Number(
        (toolInvocationCount / Math.max(1, executedToolBatchCount || plannedToolBatchCount)).toFixed(4)
      )
    },
    observedHooks: deriveObservedHooks(task, eventCounts),
    ruleSummary,
    hookSummary,
    agentSummary,
    instructionSkillSummary,
    experienceSummary,
    providerSummary,
    skillSummary,
    mcpSummary,
    permissionSummary,
    providerFailureStreak,
    skillFailureStreak,
    mcpFailureStreak,
    artifactPathState: artifactRouting.artifactPathState,
    pendingArtifactCount: artifactRouting.pendingArtifactCount,
    selectedArtifactDir: artifactRouting.selectedArtifactDir,
    recommendedArtifactDir: artifactRouting.recommendedArtifactDir,
    artifactPaths: artifactRouting.artifactPaths,
    artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
    lastArtifactApplyAt: artifactRouting.lastArtifactApplyAt,
    lastArtifactApplyResult: artifactRouting.lastArtifactApplyResult,
    lastSafeCheckpointAt,
    lastRecoverySource,
    conservativeModeReason,
    capabilityWarnings,
    queueRuntimeAlignment,
    recovery,
    contextGating: {
      ...(task.runtime.contextGating ?? {
        mode: 'STANDARD',
        rawContextMessageCount: 0,
        retainedContextMessageCount: 0,
        summarizedContextMessageCount: 0,
        filteredContextMessageCount: 0,
        stageScopedMessageCount: 0,
        contractScopedMessageCount: 0,
        dependencyScopedMessageCount: 0,
        operatorMessageCount: 0,
        toolMessageCount: 0,
        rawContextCharacters: 0,
        gatedContextCharacters: 0,
        estimatedContextReductionRatio: 0,
        reasons: ['missing_runtime_context_gating_summary']
      }),
      reasons: [...(task.runtime.contextGating?.reasons ?? ['missing_runtime_context_gating_summary'])]
    },
    executionProfiles: task.definition.units.map((unit) => {
      const profile = getExecutionProfile(unit.executionProfileId);
      return {
        unitId: unit.id,
        profileId: unit.executionProfileId ?? null,
        allowedToolIds: profile ? [...profile.allowedToolIds] : [],
        contextMode: profile?.contextMode ?? null,
        historyScope: profile?.historyScope ?? null,
        retainRecentToolTurns: profile?.retainRecentToolTurns ?? false,
        retainDependencyMessages: profile?.retainDependencyMessages ?? false,
        preferValidatedOutputs: profile?.preferValidatedOutputs ?? false
      };
    }),
    turnContract,
    acceptance: {
      ...acceptance,
      semanticReview: createSemanticReviewDefault({
        providerId: providerSummary.providerId,
        modelId: providerSummary.modelId,
        cached: options?.semanticReview ?? null
      })
    }
  };
}
