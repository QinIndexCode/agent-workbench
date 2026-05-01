import {
  InterruptRequestRecord,
  OperatorCommandRecord,
  OperatorMessageRecord,
  RuntimeEventRecord,
  ToolApprovalRecord,
  ToolInvocationRecord
} from '../../foundation/repository';
import { ConversationMessageRecord } from '../../foundation/conversation/types';
import { QueueItemRecord } from '../../foundation/repository/types';
import { TaskProjectionRecord } from '../../foundation/projection/types';
import {
  AcceptanceFailureCategory,
  CorrectionPromptMode,
  AgentUnit,
  ContextGatingSummaryState,
  ExecutionProfileId,
  QualityProfileId,
  TaskCommandResult,
  TaskDefinition,
  TaskLifecycleStatus,
  TaskRuntimeState
} from '../../domain/contracts/types';
import { CapabilityReadiness, CapabilityWarning, ProviderAuthSource } from '../platform/types';
import { ImprovementProposal, RealTaskArchiveStatus } from '../platform/types';
import { ProviderTransport } from '../../foundation/providers/types';
import { TaskArtifactApplyResult, TaskArtifactPathPolicy, TaskArtifactPathState } from './artifact-routing';

export interface SubmitTaskInput {
  taskId?: string;
  title: string;
  intent: string;
  units: AgentUnit[];
  defaultQualityProfileId?: QualityProfileId;
  preferredProviderId?: string | null;
  pathPolicy?: TaskArtifactPathPolicy;
  preferredArtifactDir?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskActionInput {
  taskId: string;
  userMessage?: string;
  autoRun?: boolean;
  maxTurns?: number;
  actor?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SubmitTaskCommandInput {
  taskId: string;
  type: import('../../domain/contracts/types').OperatorCommandType;
  actor?: string | null;
  reason?: string | null;
  message?: string | null;
  autoRun?: boolean;
  maxTurns?: number;
  invocationId?: string | null;
  approvalStatus?: ResolveApprovalInput['status'];
  metadata?: Record<string, unknown>;
}

export interface ResolveApprovalInput {
  taskId: string;
  invocationId: string;
  status: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  grantedBy?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskQueryResponse {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  projection: TaskProjectionRecord | null;
  queue: QueueItemRecord | null;
  conversations: ConversationMessageRecord[];
  latestVisibleOutput: TaskVisibleOutputSummary | null;
  statusSummary: TaskStatusSummary;
  primaryAction: TaskPrimaryActionSummary;
  nextActionSummary: TaskNextActionSummary;
  completionSummary: TaskCompletionSummary | null;
  delegationSummary: TaskDelegationSummary;
  visibleToolActivities: TaskVisibleToolActivity[];
  improvementProposals: ImprovementProposal[];
  realTaskArchiveStatus: RealTaskArchiveStatus;
  commands: OperatorCommandRecord[];
  operatorMessages: OperatorMessageRecord[];
  interrupts: InterruptRequestRecord[];
  pendingApprovals: ToolApprovalRecord[];
  pendingApprovalItems: TaskPendingApprovalItem[];
  toolInvocations: ToolInvocationRecord[];
  events: RuntimeEventRecord[];
  diagnostics: {
    lastError: string | null;
    providerFailure: {
      message: string;
      kind: string | null;
      category: string | null;
      statusCode: number | null;
      retryable: boolean | null;
      providerId: string | null;
      timeoutOrigin?: string | null;
      elapsedMs?: number | null;
      requestTimeoutMs?: number | null;
      retryAttempt?: number | null;
      requestContext?: {
        rawContextMessageCount: number | null;
        retainedContextMessageCount: number | null;
        toolMessageCount: number | null;
        gatedContextCharacters: number | null;
        providerMessageCount: number | null;
        estimatedPromptCharacters: number | null;
      } | null;
    } | null;
  };
}

export interface TaskSummaryResponse {
  taskId: string;
  title: string;
  intent: string;
  lifecycleStatus: TaskLifecycleStatus;
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  currentUnitId: string | null;
  updatedAt: number;
  queueState: QueueItemRecord['state'] | null;
  pendingApprovalCount: number;
  lastError: string | null;
  isDelegatedChild: boolean;
}

export interface TaskDelegatedChildSummary {
  taskId: string;
  title: string;
  lifecycleStatus: TaskLifecycleStatus;
  summary: string | null;
  updatedAt: number;
  goal: string | null;
}

export interface TaskDelegationSummary {
  depth: number;
  delegationEnabled: boolean;
  canDelegate: boolean;
  required: boolean;
  missingRequiredDelegation: boolean;
  reason: string;
  activeChildTask: TaskDelegatedChildSummary | null;
  recentChildren: TaskDelegatedChildSummary[];
}

export interface TaskVisibleOutputSummary {
  source: 'validated_output' | 'assistant_fallback' | 'failure_fallback';
  unitId: string | null;
  validatedAt: number | null;
  summary: string;
  details: string | null;
  issues: string[];
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskArtifactApplyResult['status'] | null;
}

export interface TaskVisibleToolActivity {
  activityId: string;
  toolId: string;
  status: ToolInvocationRecord['status'];
  summary: string;
  detail: string | null;
  argumentsSummary: string | null;
  resultSummary: string | null;
  execution: {
    command: string | null;
    effectiveCommand: string | null;
    cwd: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number | null;
    timedOut: boolean | null;
    shell: string | null;
  } | null;
  evidencePaths: string[];
  approvalStatus: ToolApprovalRecord['status'] | null;
  startedAt: number;
  endedAt: number | null;
  unitId: string;
}

export interface TaskPendingApprovalItem {
  invocationId: string;
  toolId: string;
  toolName: string;
  requestedAt: number;
  argumentsSummary: string | null;
  status: ToolApprovalRecord['status'];
  availableActions: Array<'APPROVED' | 'REJECTED'>;
}

export type TaskStatusSummaryTone =
  | 'running'
  | 'waiting'
  | 'action_required'
  | 'blocked'
  | 'completed';

export interface TaskStatusSummary {
  label: string;
  detail: string;
  tone: TaskStatusSummaryTone;
}

export type TaskPrimaryActionKind =
  | 'approve'
  | 'reject'
  | 'use_recommended_path'
  | 'choose_custom_path'
  | 'continue_thread'
  | 'start_task'
  | 'resume_task'
  | 'restart_task'
  | 'wait';

export interface TaskPrimaryActionSummary {
  kind: TaskPrimaryActionKind;
  label: string;
  description: string;
  destinationDir: string | null;
}

export interface TaskNextActionSummary {
  label: string;
  reason: string;
}

export interface TaskCompletionSummary {
  summary: string | null;
  details: string | null;
  issues: string[];
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskArtifactApplyResult['status'] | null;
  continueAllowed: boolean;
}

export interface TaskDiscussionResponse {
  taskId: string;
  conversations: ConversationMessageRecord[];
  operatorMessages: OperatorMessageRecord[];
}

export interface TaskToolingResponse {
  taskId: string;
  pendingApprovals: ToolApprovalRecord[];
  toolInvocations: ToolInvocationRecord[];
}

export interface TaskTraceEnvelope {
  writerSessionId: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export const TASK_EXECUTION_ISSUE_CATEGORIES = [
  'provider_config_failure',
  'tool_execution_failure',
  'skill_runtime_unavailable',
  'skill_invocation_failed',
  'mcp_server_unavailable',
  'mcp_call_failed',
  'mcp_capability_mismatch',
  'artifact_destination_unresolved',
  'artifact_apply_conflict',
  'artifact_apply_failed',
  'artifact_policy_mismatch',
  'approval_deadlock',
  'required_delegation_missing',
  'quality_gate_failed',
  'queue_runtime_divergence',
  'context_overload_planner_fallback',
  'invalid_lifecycle_transition',
  'recovery_inconsistency'
] as const;

export type TaskExecutionIssueCategory = typeof TASK_EXECUTION_ISSUE_CATEGORIES[number];

export const TASK_EXECUTION_ISSUE_PLANES = [
  'core',
  'ecosystem',
  'harness',
  'ui',
  'provider',
  'external_blocker'
] as const;

export type TaskExecutionIssuePlane = typeof TASK_EXECUTION_ISSUE_PLANES[number];

export const TASK_EXECUTION_SUGGESTED_ACTION_TYPES = [
  'none',
  'start',
  'continue',
  'wait',
  'inspect_diagnostics',
  'configure_provider',
  'review_ecosystem',
  'resolve_approval',
  'select_artifact_destination',
  'resolve_artifact_conflict',
  'repair_quality_evidence',
  'resume',
  'restart',
  'open_runtime_state'
] as const;

export type TaskExecutionSuggestedActionType = typeof TASK_EXECUTION_SUGGESTED_ACTION_TYPES[number];

export interface TaskExecutionSuggestedAction {
  type: TaskExecutionSuggestedActionType;
  label: string;
  reason: string;
  command: string | null;
}

export const TASK_OBSERVATION_HOOK_IDS = [
  'pre-tool-dispatch',
  'post-tool-result',
  'approval-blocked',
  'task-resumed',
  'task-failed'
] as const;

export type TaskObservationHookId = typeof TASK_OBSERVATION_HOOK_IDS[number];

export interface TaskExecutionUnitDuration {
  unitId: string;
  stageIndex: number | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  turnCount: number;
}

export interface TaskExecutionStageDuration {
  stageIndex: number;
  unitIds: string[];
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
}

export const TASK_ACCEPTANCE_LAYER_VERDICTS = ['passed', 'failed', 'not_applicable'] as const;
export type TaskAcceptanceLayerVerdict = typeof TASK_ACCEPTANCE_LAYER_VERDICTS[number];

export const TASK_ACCEPTANCE_DETERMINISTIC_VERDICTS = ['passed', 'failed'] as const;
export type TaskAcceptanceDeterministicVerdict = typeof TASK_ACCEPTANCE_DETERMINISTIC_VERDICTS[number];

export const TASK_ACCEPTANCE_SEMANTIC_REVIEW_STATUSES = [
  'not_requested',
  'pending',
  'passed',
  'failed',
  'unavailable'
] as const;
export type TaskAcceptanceSemanticReviewStatus = typeof TASK_ACCEPTANCE_SEMANTIC_REVIEW_STATUSES[number];

export interface TaskAcceptanceLayer {
  verdict: TaskAcceptanceLayerVerdict;
  summary: string;
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
}

export interface TaskAcceptanceDeterministicSummary {
  verdict: TaskAcceptanceDeterministicVerdict;
  profileId: ExecutionProfileId | 'analyze';
  unitId: string | null;
  contract: TaskAcceptanceLayer;
  execution: TaskAcceptanceLayer;
  evidence: TaskAcceptanceLayer;
  outcome: TaskAcceptanceLayer;
}

export interface TaskAcceptanceExplicitOutputEvidence {
  present: boolean;
  source: TaskVisibleOutputSummary['source'] | 'missing';
  contractKeys: string[];
  missingContractKeys: string[];
  invalidJson: boolean;
  summary: string;
}

export interface TaskAcceptanceProgressTrackerEvidence {
  present: boolean;
  status: string | null;
  decision: string | null;
  issues: string[];
  summary: string;
}

export interface TaskAcceptanceToolEvidence {
  required: boolean;
  satisfied: boolean;
  invocationCount: number;
  successfulCount: number;
  verificationCount: number;
  pendingApprovalCount: number;
  toolIds: string[];
  summary: string;
}

export interface TaskAcceptanceArtifactEvidence {
  required: boolean;
  satisfied: boolean;
  artifactPathState: TaskArtifactPathState;
  artifactPaths: string[];
  summary: string;
}

export interface TaskAcceptanceDeliveryEvidence {
  required: boolean;
  delivered: boolean;
  artifactDestinationDir: string | null;
  artifactDestinationPaths: string[];
  summary: string;
}

export interface TaskAcceptanceGroundingEvidence {
  required: boolean;
  satisfied: boolean;
  referenceCount: number;
  pathReferences: string[];
  taskIdReferences: string[];
  eventTypeReferences: string[];
  artifactReferences: string[];
  summary: string;
}

export interface TaskAcceptanceEvidence {
  explicitOutput: TaskAcceptanceExplicitOutputEvidence;
  progressTracker: TaskAcceptanceProgressTrackerEvidence;
  toolEvidence: TaskAcceptanceToolEvidence;
  artifactEvidence: TaskAcceptanceArtifactEvidence;
  deliveryEvidence: TaskAcceptanceDeliveryEvidence;
  groundingEvidence: TaskAcceptanceGroundingEvidence;
}

export interface TaskAcceptanceSemanticReview {
  status: TaskAcceptanceSemanticReviewStatus;
  verdict: Extract<TaskAcceptanceLayerVerdict, 'passed' | 'failed'> | null;
  providerId: string | null;
  modelId: string | null;
  reviewedAt: number | null;
  confidence: number | null;
  summary: string | null;
  mismatches: string[];
  missingEvidence: string[];
  error: string | null;
}

export interface TaskAcceptanceQualitySummary {
  profileId: QualityProfileId | null;
  verdict: TaskAcceptanceLayerVerdict;
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
  lastEvaluatedAt: number | null;
}

export interface TaskAcceptanceSummary {
  deterministic: TaskAcceptanceDeterministicSummary;
  evidence: TaskAcceptanceEvidence;
  quality: TaskAcceptanceQualitySummary;
  semanticReview: TaskAcceptanceSemanticReview;
}

export interface TaskExecutionSummary {
  issuePlane: TaskExecutionIssuePlane | null;
  issueCategory: TaskExecutionIssueCategory | null;
  issueSummary: string | null;
  suggestedAction: TaskExecutionSuggestedAction;
  eventCounts: Record<string, number>;
  turnCount: number;
  correctionDepth: number;
  stageDurations: TaskExecutionStageDuration[];
  unitDurations: TaskExecutionUnitDuration[];
  plannerFallbackReasons: string[];
  approvalBlockedBatchCount: number;
  batchExecution: {
    plannedProviderBatchCount: number;
    plannedToolBatchCount: number;
    executedToolBatchCount: number;
    toolInvocationCount: number;
    averageToolInvocationsPerBatch: number;
  };
  observedHooks: TaskObservationHookId[];
  ruleSummary: {
    configuredCount: number;
    matchedRuleNames: string[];
    pathMatchedRuleNames: string[];
  };
  hookSummary: {
    configuredCount: number;
    executedCount: number;
    failedCount: number;
    recent: Array<{
      event: string;
      command: string;
      status: 'SUCCEEDED' | 'FAILED';
    }>;
  };
  agentSummary: {
    configuredCount: number;
    selectedAgent: string | null;
    selectedBy: string | null;
  };
  instructionSkillSummary: {
    configuredCount: number;
    selectedCount: number;
    selected: Array<{
      skillId: string;
      name: string;
      selectedBy: string;
      instructionOnly: true;
      assetPaths: string[];
      sourcePath: string | null;
      declaredMcpDependencies: string[];
      declaredMcpResources: string[];
      declaredMcpPrompts: string[];
      preferredProviderIds: string[];
    }>;
  };
  experienceSummary: {
    configuredCount: number;
    selectedCount: number;
    selected: Array<{
      proposalId: string;
      title: string;
      selectedBy: 'metadata' | 'heuristic';
      validationEligible: boolean;
      materializedPath: string;
      referenceSummary: string;
      limitations: string[];
      validationStatus: 'monitoring' | 'promotable' | 'conflicted';
    }>;
    validationCandidates: Array<{
      proposalId: string;
      validationStatus: 'monitoring' | 'promotable' | 'conflicted';
      successfulReuseTaskIds: string[];
      failedReuseTaskIds: string[];
    }>;
  };
  providerSummary: {
    providerId: string | null;
    modelId: string | null;
    variantId: string | null;
    selectedBy: 'runtime_selected' | 'task_preference' | 'config_default' | 'prefer_local' | 'first_available' | null;
    transport: ProviderTransport | null;
    readiness: CapabilityReadiness | null;
    authSource: ProviderAuthSource | null;
    recentStatus: 'ready' | 'missing-secret' | 'missing-client' | 'failed' | 'selected' | 'unknown';
    lastMessage: string | null;
  };
  skillSummary: {
    configuredCount: number;
    availableCount: number;
    invokedCount: number;
    failureStreak: number;
    recent: Array<{
      skillId: string;
      status: 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE';
      message: string | null;
    }>;
  };
  mcpSummary: {
    configuredCount: number;
    availableCount: number;
    invokedCount: number;
    failureStreak: number;
    selectedServerIds: string[];
    selectedTools: string[];
    selectedResources: string[];
    selectedPrompts: string[];
    readinessSummary: {
      ready: string[];
      missingClient: string[];
      metadataOnly: string[];
    };
    recent: Array<{
      serverId: string;
      toolName: string;
      status: 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE' | 'CAPABILITY_MISMATCH';
      message: string | null;
    }>;
  };
  permissionSummary: {
    mode: 'full' | 'read-only' | 'ask';
    approvalRequiredCount: number;
    deniedCount: number;
    recent: Array<{
      toolId: string;
      decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
      reason: string | null;
    }>;
  };
  providerFailureStreak: number;
  skillFailureStreak: number;
  mcpFailureStreak: number;
  artifactPathState: TaskArtifactPathState;
  pendingArtifactCount: number;
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  lastArtifactApplyAt: number | null;
  lastArtifactApplyResult: TaskArtifactApplyResult | null;
  lastSafeCheckpointAt: number | null;
  lastRecoverySource: string | null;
  conservativeModeReason: string | null;
  capabilityWarnings: CapabilityWarning[];
  queueRuntimeAlignment: {
    consistent: boolean;
    queueState: QueueItemRecord['state'] | null;
    lifecycleStatus: TaskLifecycleStatus;
    summary: string;
  };
  recovery: {
    recoveredAfterRestart: boolean;
    recoveryReason: string | null;
    recoveredBy: string | null;
    recoveredFromLifecycleStatus: TaskLifecycleStatus | null;
    previousQueueState: QueueItemRecord['state'] | null;
    queueLastError: string | null;
  };
  contextGating: ContextGatingSummaryState;
  executionProfiles: Array<{
    unitId: string;
    profileId: ExecutionProfileId | null;
    allowedToolIds: string[];
    contextMode: string | null;
    historyScope: string | null;
    retainRecentToolTurns: boolean;
    retainDependencyMessages: boolean;
    preferValidatedOutputs: boolean;
  }>;
  turnContract: {
    currentUnitId: string | null;
    pendingCorrection: TaskRuntimeState['pendingCorrection'];
    requiresToolEvidence: boolean;
    lastAcceptanceFailureCategory: AcceptanceFailureCategory | null;
    lastPendingCorrectionKind: TaskRuntimeState['pendingCorrection'] | null;
    lastCorrectionPromptMode: CorrectionPromptMode;
    correctionLoopNonConvergent: boolean;
    conservativeMode: boolean;
    continueAllowed: boolean;
    continueReason: string;
  };
  acceptance: TaskAcceptanceSummary;
}

export interface TaskDebugResponse {
  task: TaskQueryResponse;
  metadata: unknown;
  runtimeRecord: unknown;
  queue: QueueItemRecord | null;
  executionSummary: TaskExecutionSummary;
}

export interface TaskDiagnosticsSummary {
  totals: {
    tasks: number;
    submitted: number;
    running: number;
    paused: number;
    failed: number;
    completed: number;
    cancelled: number;
  };
  recoverableTaskIds: string[];
}

export interface TaskActionResponse {
  command: TaskCommandResult;
  task: TaskQueryResponse;
  commandMetadata?: Record<string, unknown>;
}

export interface TaskDeleteResponse {
  ok: true;
  taskId: string;
  deleted: boolean;
}

export interface TaskArchiveResponse {
  ok: true;
  taskId: string;
  isArchived: boolean;
}
