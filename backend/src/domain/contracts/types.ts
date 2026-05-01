import type { UnitContract } from './unit-contract';

export type EngineStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export type TaskLifecycleStatus =
  | 'SUBMITTED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type QueueItemState =
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'RETRY_WAITING'
  | 'DEAD_LETTER'
  | 'COMPLETED';

export type UnitStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PARTIAL'
  | 'COMPLETE'
  | 'FAILED'
  | 'SKIPPED';

export type Decision =
  | 'CONTINUE'
  | 'PRUNE_REMAINING'
  | 'EARLY_TERMINATE';

export type PendingCorrectionKind =
  | 'NONE'
  | 'AWAITING_TRACKER'
  | 'AWAITING_OUTPUT_CORRECTION'
  | 'AWAITING_TOOL_ACTION'
  | 'AWAITING_BLOCKER_EXPLANATION';

export type AcceptanceFailureCategory =
  | 'response_shape_mismatch'
  | 'tracker_missing_after_valid_output'
  | 'output_contract_mismatch'
  | 'exit_condition_mismatch'
  | 'tool_action_required_but_not_emitted'
  | 'artifact_write_required_but_not_emitted'
  | 'required_delegation_missing'
  | 'provider_style_incompatibility'
  | 'quality_gate_failed';

export type CorrectionPromptMode =
  | 'FULL_PROTOCOL'
  | 'TARGETED_OUTPUT'
  | 'TARGETED_TRACKER'
  | 'TARGETED_TOOL_ACTION'
  | 'TARGETED_BLOCKER_EXPLANATION';

export type PermissionLevel =
  | 'GLOBAL'
  | 'DEPENDENCY'
  | 'PRIVATE';

export type ExecutionProfileId =
  | 'analyze'
  | 'implement'
  | 'verify';

export const TASK_QUALITY_PROFILE_IDS = [
  'web_experience',
  'docs_normalize',
  'docs_synthesize',
  'system_audit',
  'desktop_observation'
] as const;

export type QualityProfileId = typeof TASK_QUALITY_PROFILE_IDS[number];

export type OperatorCommandType =
  | 'START_TASK'
  | 'CONTINUE_TASK'
  | 'PAUSE_TASK'
  | 'RESUME_TASK'
  | 'RESTART_TASK'
  | 'APPLY_ARTIFACTS'
  | 'SEND_OPERATOR_MESSAGE'
  | 'RESOLVE_APPROVAL'
  | 'INTERRUPT_TASK'
  | 'CANCEL_TASK';

export type SafePointStage =
  | 'IDLE'
  | 'BEFORE_PROVIDER'
  | 'AFTER_PROVIDER'
  | 'AFTER_TRACKER'
  | 'BEFORE_TOOL_DISPATCH'
  | 'AFTER_TOOL_DISPATCH';

export type ExecutionLeasePhase =
  | 'IDLE'
  | 'ACTIVE'
  | 'WAITING_SAFE_POINT'
  | 'PAUSED'
  | 'INTERRUPTED'
  | 'COMPLETED';

export interface ContextAccessPolicy {
  permissionLevel: PermissionLevel;
  includeDependencyOutputs: boolean;
  includeRetrievedContext: boolean;
  scopedUnitIds: string[] | null;
  scopedOutputKeysByUnitId?: Record<string, string[]>;
}

export interface PendingOperatorInput {
  messageId: string;
  commandId: string | null;
  content: string;
  createdAt: number;
}

export interface InterruptState {
  pauseRequested: boolean;
  interruptRequested: boolean;
  cancelRequested: boolean;
  requestedAt: number | null;
  reason: string | null;
}

export interface ExecutionLeaseState {
  active: boolean;
  phase: ExecutionLeasePhase;
  leaseId: string | null;
  startedAt: number | null;
  replayable: boolean;
}

export interface SafePointState {
  stage: SafePointStage;
  reachedAt: number | null;
  interruptible: boolean;
}

export interface AgentUnit {
  id: string;
  role: string;
  goal: string;
  taskScope?: string;
  inputContract?: string;
  outputContract?: string;
  exitCondition?: string;
  permissionLevel?: PermissionLevel;
  executionProfileId?: ExecutionProfileId;
  qualityProfileId?: QualityProfileId;
  delegationRequired?: boolean;
  delegationContract?: {
    title?: string;
    role?: string;
    goal?: string;
    taskScope?: string;
    outputContract?: string;
    allowedToolIds?: string[];
    successCriteria?: string;
  };
  dependencies: string[];
}

export function requiresToolEvidenceForExecutionProfile(profileId: ExecutionProfileId | null | undefined): boolean {
  return profileId === 'implement' || profileId === 'verify';
}

export interface SchedulerUnitState {
  unitId: string;
  role: string;
  goal: string;
  taskScope?: string;
  inputContract?: string;
  outputContract?: string;
  exitCondition?: string;
  permissionLevel: PermissionLevel;
  contract: UnitContract;
  contextPolicy: ContextAccessPolicy;
  dependencies: string[];
  status: UnitStatus;
  invalidOutputErrors: string[];
}

export interface RuntimeContractDiagnosticsState {
  compatibilityFallbackCount: number;
  topology: {
    rootUnitIds: string[];
    stageCount: number;
    currentStageIndex: number | null;
    issueCount: number;
    batchGroupingHint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE' | null;
    entryUnitIds: string[];
    exitUnitIds: string[];
  };
  currentUnit: {
    unitId: string | null;
    permissionLevel: PermissionLevel | null;
    requiresToolEvidence: boolean;
    contractSource?: 'STRUCTURED' | 'NORMALIZED' | 'COMPAT_FALLBACK';
    usedCompatibilityFallback?: boolean;
    scopedUnitIds: string[] | null;
    scopedOutputKeysByUnitId?: Record<string, string[]>;
    memorySelector?: {
      unitIds: string[] | null;
      memoryKinds: Array<'MILESTONE' | 'DECISION'>;
      includeGlobalMemory: boolean;
    };
    memorySelectionSource?: 'STRUCTURED' | 'DEFAULT' | 'COMPAT_FALLBACK';
    retrievalScopeSummary?: {
      visibleUnitCount: number | 'ALL';
      outputSelectorUnitCount: number;
      memorySelectorUnitCount: number | 'ALL';
    };
  };
  lastExitCondition: {
    unitId: string | null;
    ok: boolean;
    issueCodes: string[];
    failureCategory: 'OUTPUT' | 'TRACKER' | null;
    evaluatedAt: number | null;
  } | null;
  lastAcceptanceFailureCategory: AcceptanceFailureCategory | null;
  lastAcceptanceIssueCodes: string[];
  lastAcceptanceIssueMessages: string[];
  lastPendingCorrectionKind: PendingCorrectionKind | null;
  lastCorrectionPromptMode: CorrectionPromptMode;
  correctionLoopNonConvergent: boolean;
}

export interface RuntimePlannerState {
  planVersion: string;
  executionPhase: 'IDLE' | 'PLANNING' | 'BATCH_EXECUTION' | 'CONSOLIDATING' | 'FALLBACK_SINGLE_ACTIVE';
  stageCount: number;
  currentStageIndex: number | null;
  currentStageUnitIds: string[];
  readyStageUnitIds: string[];
  providerBatchCount: number;
  toolBatchCount: number;
  providerBatchHints: Array<{
    stageIndex: number;
    batchId: string;
    hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
    unitIds: string[];
  }>;
  toolBatchHints: Array<{
    stageIndex: number;
    batchId: string;
    hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
    unitIds: string[];
  }>;
  batchGroupingHints: Array<{
    stageIndex: number;
    hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
    unitIds: string[];
  }>;
  dependencySummary: {
    hardEdgeCount: number;
    softEdgeCount: number;
    entryUnitIds: string[];
    exitUnitIds: string[];
  };
  contractBlockingReasons: string[];
  fallbackReasons: string[];
  blockingReason:
    | 'TOPOLOGY_BLOCKED'
    | 'CONTRACT_BLOCKED'
    | 'EXIT_CONDITION_BLOCKED'
    | 'PLANNER_STAGE_NOT_READY'
    | 'PLANNER_BLOCKED'
    | 'BATCH_BLOCKED'
    | 'CONSOLIDATION_BLOCKED'
    | null;
}

export interface ActiveStageState {
  stageIndex: number;
  unitIds: string[];
  entryUnitIds: string[];
  exitUnitIds: string[];
  batchGroupingHint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
}

export interface RuntimePendingToolBatchState {
  batchId: string;
  stageIndex: number;
  unitIds: string[];
  invocationIds: string[];
  status: 'PLANNED' | 'SUCCEEDED' | 'PARTIAL_APPROVAL_BLOCKED' | 'FAILED' | 'DENIED';
  createdAt: number;
  executedAt: number | null;
  approvalBlockedCount: number;
  failedCount: number;
}

export interface RuntimeConsolidationState {
  status: 'IDLE' | 'REQUIRED' | 'RUNNING' | 'COMPLETED' | 'CORRECTION_REQUIRED';
  stageIndex: number | null;
  lastCompletedAt: number | null;
  lastResult: 'COMPLETED' | 'CORRECTION_REQUIRED' | 'FAILED' | null;
  lastIssueCodes: string[];
}

export interface RuntimeCompressionPolicyState {
  mode: 'STANDARD' | 'CONSERVATIVE';
  preservedValidatedOutputUnitIds: string[];
  preservedMemoryUnitIds: string[] | null;
  reasons: string[];
}

export interface ContextGatingSummaryState {
  mode: 'STANDARD' | 'CONSERVATIVE';
  rawContextMessageCount: number;
  retainedContextMessageCount: number;
  summarizedContextMessageCount: number;
  filteredContextMessageCount: number;
  stageScopedMessageCount: number;
  contractScopedMessageCount: number;
  dependencyScopedMessageCount: number;
  operatorMessageCount: number;
  toolMessageCount: number;
  rawContextCharacters: number;
  gatedContextCharacters: number;
  estimatedContextReductionRatio: number;
  reasons: string[];
}

export interface RuntimeBatchAdmissionDecisionState {
  batchId: string;
  stageIndex: number;
  status: 'ADMITTED' | 'PARTIAL' | 'REJECTED';
  admittedInvocationCount: number;
  rejectedInvocationCount: number;
  rejectionReasons: string[];
}

export interface RuntimeGuardrailState {
  correctionStreak: number;
  fallbackStreak: number;
  approvalBlockedBatchStreak: number;
  compressionDowngraded: boolean;
  batchAdmissionRestricted: boolean;
  plannerFallbackRate: number;
}

export interface TaskDefinition {
  taskId: string;
  title: string;
  intent: string;
  units: AgentUnit[];
  preferredProviderId: string | null;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface LlmContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  compressed: boolean;
  metadata: Record<string, unknown>;
}

export interface RuntimeContextSnapshotRef {
  kind: 'llm' | 'conversation';
  sessionId: string | null;
  turnId: string | null;
  checkpointId: string | null;
  messageCount: number;
}

export interface RuntimePromptBudgetState {
  maxContextMessages: number;
  retainedContextMessages: number;
  sectionCharacterLimit: number;
  maxSummaryItems: number;
  lastTruncatedItemCount: number;
  lastCapabilityItemCount: number;
  lastValidatedOutputCount: number;
  estimatedPromptCharacters: number;
  estimatedPromptTokens: number;
  estimatedBaselineCharacters: number;
  estimatedBaselineTokens: number;
  estimatedReductionRatio: number;
  rawContextCharacters: number;
  gatedContextCharacters: number;
  rawContextTokens: number;
  gatedContextTokens: number;
  estimatedHistoryReductionRatio: number;
  estimatedSectionReductionRatio: number;
  cacheablePrefixChars: number;
  stablePrefixChars: number;
  volatileSuffixChars: number;
  stablePrefixRatio: number;
  retrievedContextCount: number;
  policyFilteredOutputCount: number;
  operatorInputCount: number;
  sectionPromptChars: PromptSectionAttributionState;
  sectionPromptRatios: PromptSectionAttributionState;
}

export interface PromptSectionAttributionState {
  taskMemoryChars: number;
  preferenceChars: number;
  validatedOutputChars: number;
  toolPolicyChars: number;
  capabilityChars: number;
  stageRuntimeChars: number;
  responsePolicyChars: number;
}

export interface StageMemorySummaryState {
  strategy: 'STAGE_VIRTUALIZED';
  milestoneCount: number;
  decisionCount: number;
  rawMilestoneCount: number;
  summarizedMilestoneCount: number;
  rawDecisionCount: number;
  summarizedDecisionCount: number;
  globalItemCount: number;
  protectedItemCount: number;
  sharedItemCount: number;
  privateItemCount: number;
  reasons: string[];
}

export interface CapabilitySelectionSummaryState {
  mode: 'FULL' | 'STAGE_RELEVANT';
  toolCount: number;
  skillCount: number;
  mcpCount: number;
  omittedToolCount: number;
  omittedSkillCount: number;
  omittedMcpCount: number;
  selectedToolNames: string[];
  reasons: string[];
}

export interface RetrievalSelectionSummaryState {
  mode: 'CONTRACT_AND_STAGE_RELEVANCE' | 'CONTRACT_ONLY';
  visibleRecordCount: number;
  retainedRecordCount: number;
  filteredOutCount: number;
  rawRecordCount: number;
  summarizedRecordCount: number;
  directDependencyCount: number;
  protectedRecordCount: number;
  referencedRecordCount: number;
  usedCompatibilityFallback: boolean;
  reasons: string[];
}

export interface RuntimeTaskMemoryState {
  latestUserIntent: string | null;
  lastUserMessageAt: number | null;
  keyMilestones: string[];
  importantDecisions: string[];
  userPreferenceSnapshot: string[];
}

export interface UserPreferenceProfile {
  profileId: string;
  preferredLanguage: string | null;
  responseStyle: string | null;
  modelPreference: string | null;
  workflowPreferences: string[];
  notableHabits: string[];
  lastUpdatedAt: number;
}

export interface ProgressTracker {
  currentUnit: string;
  status: UnitStatus;
  progressPercent: number;
  decision: Decision;
  reason: string;
  nextUnit: string | null;
  filesCreated: string[];
}

export interface ExplicitOutputEnvelope {
  unitId: string;
  raw: string;
  parsedJson: unknown | null;
  wrapper: 'square' | 'angle' | 'xml';
}

export interface ToolCallEnvelope {
  unitId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  source: 'json' | 'xml';
}

export interface ParsedTurn {
  rawText: string;
  explicitOutputs: ExplicitOutputEnvelope[];
  trackers: ProgressTracker[];
  toolCalls: ToolCallEnvelope[];
  warnings: string[];
}

export interface RuntimeUnitState {
  unitId: string;
  status: UnitStatus;
  invalidOutputErrors: string[];
}

export interface RuntimeState {
  taskId: string;
  status: EngineStatus;
  currentUnitId: string | null;
  pendingCorrection: PendingCorrectionKind;
  units: Record<string, RuntimeUnitState>;
  progressHistory: ProgressTracker[];
}

export interface TaskRuntimeState {
  taskId: string;
  lifecycleStatus: TaskLifecycleStatus;
  engineStatus: EngineStatus;
  currentUnitId: string | null;
  pendingCorrection: PendingCorrectionKind;
  schedulerUnits: Record<string, SchedulerUnitState>;
  invalidOutputUnits: Record<string, string[]>;
  awaitingToolDispatch: string[];
  awaitingApprovalInvocations: string[];
  completedUnits: string[];
  failedUnits: string[];
  skippedUnits: string[];
  progressHistory: ProgressTracker[];
  latestSessionId: string | null;
  latestCorrelationId: string | null;
  latestTurnId: string | null;
  latestCheckpointId: string | null;
  selectedProviderId: string | null;
  llmContextMessages: LlmContextMessage[];
  llmContextSnapshotRef: RuntimeContextSnapshotRef | null;
  conversationSnapshotRef: RuntimeContextSnapshotRef | null;
  pendingOperatorInputs: PendingOperatorInput[];
  interrupt: InterruptState;
  executionLease: ExecutionLeaseState;
  safePoint: SafePointState;
  memory: RuntimeTaskMemoryState;
  promptBudget: RuntimePromptBudgetState;
  contractDiagnostics?: RuntimeContractDiagnosticsState;
  planner?: RuntimePlannerState;
  activeStage: ActiveStageState | null;
  pendingToolBatches: RuntimePendingToolBatchState[];
  consolidationState: RuntimeConsolidationState;
  compressionPolicy?: RuntimeCompressionPolicyState;
  contextGating?: ContextGatingSummaryState;
  compressionDowngraded?: boolean;
  batchAdmissionDecisions?: RuntimeBatchAdmissionDecisionState[];
  unsafeBatchRejectedCount?: number;
  guardrails?: RuntimeGuardrailState;
  plannerFallbackRate?: number;
  promptSectionAttribution?: PromptSectionAttributionState;
  stageMemorySummary?: StageMemorySummaryState;
  capabilitySelectionSummary?: CapabilitySelectionSummaryState;
  retrievalSelectionSummary?: RetrievalSelectionSummaryState;
  contextCompressionCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskCommandResult {
  ok: boolean;
  taskId: string;
  lifecycleStatus: TaskLifecycleStatus;
  message: string;
}

export interface WorkerClaimRecord {
  workerId: string;
  taskId: string;
  claimToken: string;
  claimedAt: number;
  leaseExpiresAt: number;
  attempt: number;
}
