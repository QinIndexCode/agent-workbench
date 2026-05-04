import {
  AgentUnit,
  ContextAccessPolicy,
  PendingCorrectionKind,
  PermissionLevel,
  ProgressTracker,
  SchedulerUnitState,
  TaskDefinition,
  TaskRuntimeState,
  TaskLifecycleStatus,
  UnitStatus,
  requiresToolEvidenceForExecutionProfile
} from '../contracts/types';
import { UnitContract } from '../contracts/unit-contract';
import {
  collectDownstreamUnitIdsFromTopology,
  createTopologyGraph,
  selectContractScopedUnitIds
} from './topology-graph';
import {
  canExecuteUnitInPlan,
  createExecutionPlan,
  createPlannerDiagnosticsSummary,
  selectNextReadyUnitInPlan
} from './execution-plan';
import { createEmptyPromptSectionAttribution } from './prompt-budgeter';

const MAX_PROGRESS_HISTORY_ENTRIES = 100;

function cloneRuntime(runtime: TaskRuntimeState): TaskRuntimeState {
  return structuredClone(runtime);
}

function trimProgressHistory(runtime: TaskRuntimeState): void {
  if (runtime.progressHistory.length > MAX_PROGRESS_HISTORY_ENTRIES) {
    runtime.progressHistory = runtime.progressHistory.slice(-MAX_PROGRESS_HISTORY_ENTRIES);
  }
}

function toSchedulerUnitState(unit: AgentUnit, contract: UnitContract): SchedulerUnitState {
  const permissionLevel: PermissionLevel = contract.permissionLevel;
  const contextPolicy: ContextAccessPolicy = {
    permissionLevel,
    includeDependencyOutputs: permissionLevel !== 'PRIVATE',
    includeRetrievedContext: true,
    scopedUnitIds: contract.referencedInputUnitIds.length > 0 ? [...contract.referencedInputUnitIds] : null,
    scopedOutputKeysByUnitId: Object.keys(contract.inputScope.outputKeysByUnitId).length > 0
      ? structuredClone(contract.inputScope.outputKeysByUnitId)
      : undefined
  };
  return {
    unitId: unit.id,
    role: unit.role,
    goal: unit.goal,
    taskScope: contract.taskScope,
    inputContract: contract.inputContract,
    outputContract: contract.outputContract,
    exitCondition: contract.exitCondition,
    permissionLevel,
    contract,
    contextPolicy,
    dependencies: [...unit.dependencies],
    status: 'PENDING',
    invalidOutputErrors: []
  };
}

function collectUnitsByStatus(
  units: Record<string, SchedulerUnitState>,
  target: UnitStatus
): string[] {
  return Object.values(units)
    .filter(unit => unit.status === target)
    .map(unit => unit.unitId)
    .sort();
}

function buildMemorySelectorSummary(contract: UnitContract | undefined): {
  unitIds: string[] | null;
  memoryKinds: Array<'MILESTONE' | 'DECISION'>;
  includeGlobalMemory: boolean;
} | undefined {
  if (!contract) {
    return undefined;
  }
  return {
    unitIds: contract.inputScope.memoryUnitIds.length > 0
      ? [...contract.inputScope.memoryUnitIds]
      : null,
    memoryKinds: [...contract.inputScope.memoryKinds],
    includeGlobalMemory: contract.inputScope.includeGlobalMemory
  };
}

function buildRetrievalScopeSummary(params: {
  topology: ReturnType<typeof createTopologyGraph>;
  contract: UnitContract | undefined;
  scopedUnitIds: Set<string> | null;
}): {
  visibleUnitCount: number | 'ALL';
  outputSelectorUnitCount: number;
  memorySelectorUnitCount: number | 'ALL';
} | undefined {
  if (!params.contract) {
    return undefined;
  }
  return {
    visibleUnitCount: params.scopedUnitIds === null ? 'ALL' : params.scopedUnitIds.size,
    outputSelectorUnitCount: Object.keys(params.contract.inputScope.outputKeysByUnitId).length,
    memorySelectorUnitCount: params.contract.inputScope.memoryUnitIds.length > 0
      ? params.contract.inputScope.memoryUnitIds.length
      : (params.scopedUnitIds === null ? 'ALL' : params.scopedUnitIds.size)
  };
}

export function createTaskRuntimeState(definition: TaskDefinition, now = Date.now()): TaskRuntimeState {
  const topology = createTopologyGraph(definition);
  const plan = createExecutionPlan(definition, topology);
  const schedulerUnits = Object.fromEntries(
    definition.units.map(unit => {
      const schedulerUnit = toSchedulerUnitState(unit, topology.contractsByUnitId[unit.id]);
      const scopedUnitIds = selectContractScopedUnitIds(topology, unit.id);
      schedulerUnit.contextPolicy.scopedUnitIds = scopedUnitIds ? Array.from(scopedUnitIds) : null;
      return [unit.id, schedulerUnit];
    })
  );
  const initialCurrentUnitId = plan.stages[0]?.unitIds[0] ?? null;
  const planner = createPlannerDiagnosticsSummary(definition, {
    taskId: definition.taskId,
    lifecycleStatus: 'SUBMITTED',
    engineStatus: 'IDLE',
    currentUnitId: initialCurrentUnitId,
    pendingCorrection: 'NONE',
    schedulerUnits,
    invalidOutputUnits: {},
    awaitingToolDispatch: [],
    awaitingApprovalInvocations: [],
    completedUnits: [],
    failedUnits: [],
    skippedUnits: [],
    progressHistory: [],
    latestSessionId: null,
    latestCorrelationId: null,
    latestTurnId: null,
    latestCheckpointId: null,
    selectedProviderId: definition.preferredProviderId,
    llmContextMessages: [],
    llmContextSnapshotRef: null,
    conversationSnapshotRef: null,
    memory: {
      latestUserIntent: definition.intent,
      lastUserMessageAt: null,
      keyMilestones: [],
      importantDecisions: [],
      userPreferenceSnapshot: []
    },
    promptBudget: {
      maxContextMessages: 0,
      retainedContextMessages: 0,
      sectionCharacterLimit: 0,
      maxSummaryItems: 0,
      lastTruncatedItemCount: 0,
      lastCapabilityItemCount: 0,
      lastValidatedOutputCount: 0,
      estimatedPromptCharacters: 0,
      estimatedPromptTokens: 0,
      estimatedBaselineCharacters: 0,
      estimatedBaselineTokens: 0,
      estimatedReductionRatio: 0,
      rawContextCharacters: 0,
      gatedContextCharacters: 0,
      rawContextTokens: 0,
      gatedContextTokens: 0,
      estimatedHistoryReductionRatio: 0,
      estimatedSectionReductionRatio: 0,
      cacheablePrefixChars: 0,
      stablePrefixChars: 0,
      volatileSuffixChars: 0,
      stablePrefixRatio: 0,
      retrievedContextCount: 0,
      policyFilteredOutputCount: 0,
      operatorInputCount: 0,
      sectionPromptChars: createEmptyPromptSectionAttribution(),
      sectionPromptRatios: createEmptyPromptSectionAttribution()
    },
    contractDiagnostics: undefined,
    planner: undefined,
    activeStage: null,
    pendingToolBatches: [],
    consolidationState: {
      status: 'IDLE',
      stageIndex: null,
      lastCompletedAt: null,
      lastResult: null,
      lastIssueCodes: []
    },
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
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    },
    safePoint: {
      stage: 'IDLE',
      reachedAt: now,
      interruptible: true
    },
    promptSectionAttribution: createEmptyPromptSectionAttribution(),
    stageMemorySummary: {
      strategy: 'STAGE_VIRTUALIZED',
      milestoneCount: 0,
      decisionCount: 0,
      rawMilestoneCount: 0,
      summarizedMilestoneCount: 0,
      rawDecisionCount: 0,
      summarizedDecisionCount: 0,
      globalItemCount: 0,
      protectedItemCount: 0,
      sharedItemCount: 0,
      privateItemCount: 0,
      reasons: ['initial_empty_state']
    },
    capabilitySelectionSummary: {
      mode: 'FULL',
      toolCount: 0,
      skillCount: 0,
      mcpCount: 0,
      omittedToolCount: 0,
      omittedSkillCount: 0,
      omittedMcpCount: 0,
      selectedToolNames: [],
      reasons: []
    },
    retrievalSelectionSummary: {
      mode: 'CONTRACT_ONLY',
      visibleRecordCount: 0,
      retainedRecordCount: 0,
      filteredOutCount: 0,
      rawRecordCount: 0,
      summarizedRecordCount: 0,
      directDependencyCount: 0,
      protectedRecordCount: 0,
      referencedRecordCount: 0,
      usedCompatibilityFallback: false,
      reasons: ['initial_empty_state']
    },
    contextCompressionCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now
  }, topology, plan);

  return {
    taskId: definition.taskId,
    lifecycleStatus: 'SUBMITTED',
    engineStatus: 'IDLE',
    currentUnitId: initialCurrentUnitId,
    pendingCorrection: 'NONE',
    schedulerUnits,
    invalidOutputUnits: {},
    awaitingToolDispatch: [],
    awaitingApprovalInvocations: [],
    completedUnits: [],
    failedUnits: [],
    skippedUnits: [],
    progressHistory: [],
    latestSessionId: null,
    latestCorrelationId: null,
    latestTurnId: null,
    latestCheckpointId: null,
    selectedProviderId: definition.preferredProviderId,
    llmContextMessages: [],
    llmContextSnapshotRef: null,
    conversationSnapshotRef: null,
    memory: {
      latestUserIntent: definition.intent,
      lastUserMessageAt: null,
      keyMilestones: [],
      importantDecisions: [],
      userPreferenceSnapshot: []
    },
    promptBudget: {
      maxContextMessages: 0,
      retainedContextMessages: 0,
      sectionCharacterLimit: 0,
      maxSummaryItems: 0,
      lastTruncatedItemCount: 0,
      lastCapabilityItemCount: 0,
      lastValidatedOutputCount: 0,
      estimatedPromptCharacters: 0,
      estimatedPromptTokens: 0,
      estimatedBaselineCharacters: 0,
      estimatedBaselineTokens: 0,
      estimatedReductionRatio: 0,
      rawContextCharacters: 0,
      gatedContextCharacters: 0,
      rawContextTokens: 0,
      gatedContextTokens: 0,
      estimatedHistoryReductionRatio: 0,
      estimatedSectionReductionRatio: 0,
      cacheablePrefixChars: 0,
      stablePrefixChars: 0,
      volatileSuffixChars: 0,
      stablePrefixRatio: 0,
      retrievedContextCount: 0,
      policyFilteredOutputCount: 0,
      operatorInputCount: 0,
      sectionPromptChars: createEmptyPromptSectionAttribution(),
      sectionPromptRatios: createEmptyPromptSectionAttribution()
    },
    planner,
    activeStage: initialCurrentUnitId
      ? {
        stageIndex: topology.stageIndexByUnitId[initialCurrentUnitId] ?? 0,
        unitIds: [...(topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.unitIds ?? [initialCurrentUnitId])],
        entryUnitIds: [...(topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.entryUnitIds ?? [])],
        exitUnitIds: [...(topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.exitUnitIds ?? [])],
        batchGroupingHint: topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.batchHint ?? 'SERIAL_READY'
      }
      : null,
    pendingToolBatches: [],
    consolidationState: {
      status: 'IDLE',
      stageIndex: null,
      lastCompletedAt: null,
      lastResult: null,
      lastIssueCodes: []
    },
    contractDiagnostics: {
      compatibilityFallbackCount: 0,
      topology: {
        rootUnitIds: [...topology.rootUnitIds],
        issueCount: 0,
        stageCount: topology.stages.length,
        currentStageIndex: initialCurrentUnitId ? (topology.stageIndexByUnitId[initialCurrentUnitId] ?? null) : null,
        batchGroupingHint: initialCurrentUnitId
          ? (topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.batchHint ?? null)
          : null,
        entryUnitIds: initialCurrentUnitId
          ? [...(topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.entryUnitIds ?? [])]
          : [],
        exitUnitIds: initialCurrentUnitId
          ? [...(topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[initialCurrentUnitId])?.exitUnitIds ?? [])]
          : []
      },
      currentUnit: {
        unitId: initialCurrentUnitId,
        permissionLevel: initialCurrentUnitId ? (topology.contractsByUnitId[initialCurrentUnitId]?.permissionLevel ?? null) : null,
        requiresToolEvidence: initialCurrentUnitId
          ? requiresToolEvidenceForExecutionProfile(definition.units.find((unit) => unit.id === initialCurrentUnitId)?.executionProfileId)
          : false,
        contractSource: initialCurrentUnitId ? (topology.contractsByUnitId[initialCurrentUnitId]?.contractSource ?? 'NORMALIZED') : undefined,
        usedCompatibilityFallback: initialCurrentUnitId ? (topology.contractsByUnitId[initialCurrentUnitId]?.inputScope.usedCompatibilityFallback ?? false) : undefined,
        scopedUnitIds: initialCurrentUnitId ? (selectContractScopedUnitIds(topology, initialCurrentUnitId) ? Array.from(selectContractScopedUnitIds(topology, initialCurrentUnitId)!) : null) : null,
        scopedOutputKeysByUnitId: initialCurrentUnitId
          ? (Object.keys(topology.contractsByUnitId[initialCurrentUnitId]?.inputScope.outputKeysByUnitId ?? {}).length > 0
            ? structuredClone(topology.contractsByUnitId[initialCurrentUnitId].inputScope.outputKeysByUnitId)
            : undefined)
          : undefined,
        memorySelector: initialCurrentUnitId
          ? buildMemorySelectorSummary(topology.contractsByUnitId[initialCurrentUnitId])
          : undefined,
        memorySelectionSource: initialCurrentUnitId
          ? (topology.contractsByUnitId[initialCurrentUnitId]?.inputScope.memoryUnitIds.length
            ? 'STRUCTURED'
            : (topology.contractsByUnitId[initialCurrentUnitId]?.inputScope.usedCompatibilityFallback ? 'COMPAT_FALLBACK' : 'DEFAULT'))
          : undefined,
        retrievalScopeSummary: initialCurrentUnitId
          ? buildRetrievalScopeSummary({
            topology,
            contract: topology.contractsByUnitId[initialCurrentUnitId],
            scopedUnitIds: selectContractScopedUnitIds(topology, initialCurrentUnitId)
          })
          : undefined
      },
      lastExitCondition: null,
      lastAcceptanceFailureCategory: null,
      lastAcceptanceIssueCodes: [],
      lastAcceptanceIssueMessages: [],
      lastPendingCorrectionKind: null,
      lastCorrectionPromptMode: 'FULL_PROTOCOL',
      correctionLoopNonConvergent: false
    },
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
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    },
    safePoint: {
      stage: 'IDLE',
      reachedAt: now,
      interruptible: true
    },
    contextCompressionCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
}

export function selectNextReadyUnit(
  definition: TaskDefinition,
  runtime: TaskRuntimeState
): string | null {
  const topology = createTopologyGraph(definition);
  const plan = createExecutionPlan(definition, topology);
  return selectNextReadyUnitInPlan(plan, topology, runtime);
}

function finalizeDerivedCollections(runtime: TaskRuntimeState): void {
  runtime.completedUnits = collectUnitsByStatus(runtime.schedulerUnits, 'COMPLETE');
  runtime.failedUnits = collectUnitsByStatus(runtime.schedulerUnits, 'FAILED');
  runtime.skippedUnits = collectUnitsByStatus(runtime.schedulerUnits, 'SKIPPED');
}

function updateContractDiagnostics(definition: TaskDefinition, runtime: TaskRuntimeState): void {
  const topology = createTopologyGraph(definition);
  const plan = createExecutionPlan(definition, topology);
  const currentUnitId = runtime.currentUnitId;
  const scopedUnitIds = currentUnitId ? selectContractScopedUnitIds(topology, currentUnitId) : null;
  const currentStage = currentUnitId
    ? topology.stages.find((stage) => stage.stageIndex === topology.stageIndexByUnitId[currentUnitId])
    : null;
  const currentContract = currentUnitId ? topology.contractsByUnitId[currentUnitId] : undefined;
  runtime.contractDiagnostics = {
    compatibilityFallbackCount: runtime.contractDiagnostics?.compatibilityFallbackCount ?? 0,
    topology: {
      rootUnitIds: [...topology.rootUnitIds],
      issueCount: runtime.contractDiagnostics?.topology.issueCount ?? 0,
      stageCount: topology.stages.length,
      currentStageIndex: currentUnitId ? (topology.stageIndexByUnitId[currentUnitId] ?? null) : null,
      batchGroupingHint: currentStage?.batchHint ?? null,
      entryUnitIds: [...(currentStage?.entryUnitIds ?? [])],
      exitUnitIds: [...(currentStage?.exitUnitIds ?? [])]
    },
      currentUnit: {
        unitId: currentUnitId,
        permissionLevel: currentUnitId ? (currentContract?.permissionLevel ?? null) : null,
        requiresToolEvidence: currentUnitId
          ? requiresToolEvidenceForExecutionProfile(definition.units.find((unit) => unit.id === currentUnitId)?.executionProfileId)
          : false,
        contractSource: currentUnitId ? (currentContract?.contractSource ?? 'NORMALIZED') : undefined,
      usedCompatibilityFallback: currentUnitId ? (currentContract?.inputScope.usedCompatibilityFallback ?? false) : undefined,
      scopedUnitIds: scopedUnitIds ? Array.from(scopedUnitIds) : null,
      scopedOutputKeysByUnitId: currentUnitId
        ? (Object.keys(currentContract?.inputScope.outputKeysByUnitId ?? {}).length > 0
          ? structuredClone(currentContract!.inputScope.outputKeysByUnitId)
          : undefined)
        : undefined,
      memorySelector: currentUnitId
        ? buildMemorySelectorSummary(currentContract)
        : undefined,
      memorySelectionSource: currentUnitId
        ? (currentContract?.inputScope.memoryUnitIds.length
          ? 'STRUCTURED'
          : (currentContract?.inputScope.usedCompatibilityFallback ? 'COMPAT_FALLBACK' : 'DEFAULT'))
        : undefined,
      retrievalScopeSummary: currentUnitId
        ? buildRetrievalScopeSummary({
          topology,
          contract: currentContract,
          scopedUnitIds
        })
        : undefined
    },
    lastExitCondition: runtime.contractDiagnostics?.lastExitCondition ?? null,
    lastAcceptanceFailureCategory: runtime.contractDiagnostics?.lastAcceptanceFailureCategory ?? null,
    lastAcceptanceIssueCodes: runtime.contractDiagnostics?.lastAcceptanceIssueCodes ?? [],
    lastAcceptanceIssueMessages: runtime.contractDiagnostics?.lastAcceptanceIssueMessages ?? [],
    lastPendingCorrectionKind: runtime.contractDiagnostics?.lastPendingCorrectionKind ?? null,
    lastCorrectionPromptMode: runtime.contractDiagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
    correctionLoopNonConvergent: runtime.contractDiagnostics?.correctionLoopNonConvergent ?? false
  };
  runtime.planner = createPlannerDiagnosticsSummary(definition, runtime, topology, plan);
}

export function applyLifecycleTransition(
  runtime: TaskRuntimeState,
  lifecycleStatus: TaskLifecycleStatus,
  now = Date.now()
): TaskRuntimeState {
  const next = cloneRuntime(runtime);
  next.lifecycleStatus = lifecycleStatus;
  next.engineStatus = lifecycleStatus === 'PAUSED'
    ? 'PAUSED'
    : ((lifecycleStatus === 'FAILED' || lifecycleStatus === 'CANCELLED') ? 'FAILED' : next.engineStatus);
  
  if (!next.executionLease) {
    next.executionLease = {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    };
  }
  
  next.executionLease.phase = lifecycleStatus === 'PAUSED'
    ? 'PAUSED'
    : ((lifecycleStatus === 'FAILED' || lifecycleStatus === 'CANCELLED') ? 'INTERRUPTED' : next.executionLease.phase);
  next.executionLease.active = lifecycleStatus === 'RUNNING' ? next.executionLease.active : false;
  next.updatedAt = now;
  return next;
}

export function applyCorrectionState(params: {
  definition?: TaskDefinition;
  runtime: TaskRuntimeState;
  currentUnitId: string;
  kind: PendingCorrectionKind;
  errors: string[];
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  providerId: string | null;
  now?: number;
}): TaskRuntimeState {
  const next = cloneRuntime(params.runtime);
  const unit = next.schedulerUnits[params.currentUnitId];
  if (unit) {
    unit.status = 'PARTIAL';
    unit.invalidOutputErrors = [...params.errors];
  }
  next.invalidOutputUnits[params.currentUnitId] = [...params.errors];
  next.lifecycleStatus = 'RUNNING';
  next.engineStatus = 'RUNNING';
  next.currentUnitId = params.currentUnitId;
  next.pendingCorrection = params.kind;
  next.awaitingToolDispatch = [...params.acceptedInvocationIds];
  next.awaitingApprovalInvocations = [...params.approvalInvocationIds];
  
  if (!next.executionLease) {
    next.executionLease = {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    };
  }
  
  next.executionLease.phase = 'ACTIVE';
  next.safePoint = {
    stage: 'AFTER_TRACKER',
    reachedAt: next.updatedAt,
    interruptible: true
  };
  next.latestSessionId = params.sessionId;
  next.latestCorrelationId = params.correlationId;
  next.latestTurnId = params.turnId;
  next.latestCheckpointId = params.checkpointId;
  next.selectedProviderId = params.providerId;
  next.updatedAt = params.now ?? Date.now();
  finalizeDerivedCollections(next);
  if (params.definition) {
    updateContractDiagnostics(params.definition, next);
  }
  return next;
}

export function applyTrackerState(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  tracker: ProgressTracker;
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  providerId: string | null;
  now?: number;
}): TaskRuntimeState {
  const next = cloneRuntime(params.runtime);
  const topology = createTopologyGraph(params.definition);
  const plan = createExecutionPlan(params.definition, topology);
  const currentUnit = next.schedulerUnits[params.tracker.currentUnit];
  if (!currentUnit) {
    throw new Error(`backend_new runtime error: unknown tracker unit "${params.tracker.currentUnit}".`);
  }

  currentUnit.status = params.tracker.status;
  currentUnit.invalidOutputErrors = [];
  delete next.invalidOutputUnits[params.tracker.currentUnit];

  if (params.tracker.decision === 'PRUNE_REMAINING') {
    for (const downstreamId of collectDownstreamUnitIdsFromTopology(topology, params.tracker.currentUnit)) {
      const downstream = next.schedulerUnits[downstreamId];
      if (downstream && downstream.status === 'PENDING') {
        downstream.status = 'SKIPPED';
      }
    }
  }

  if (params.tracker.decision === 'EARLY_TERMINATE') {
    next.lifecycleStatus = params.tracker.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
    next.engineStatus = params.tracker.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
    next.currentUnitId = null;
  } else if (params.tracker.status === 'FAILED') {
    next.lifecycleStatus = 'FAILED';
    next.engineStatus = 'FAILED';
    next.currentUnitId = params.tracker.currentUnit;
  } else {
    next.lifecycleStatus = 'RUNNING';
    next.engineStatus = 'RUNNING';
    next.currentUnitId = params.tracker.nextUnit && canExecuteUnitInPlan(plan, topology, next, params.tracker.nextUnit)
      ? params.tracker.nextUnit
      : selectNextReadyUnitInPlan(plan, topology, next);
    if (next.currentUnitId && !canExecuteUnitInPlan(plan, topology, next, next.currentUnitId)) {
      next.currentUnitId = null;
    }
    if (!next.currentUnitId) {
      next.lifecycleStatus = 'COMPLETED';
      next.engineStatus = 'COMPLETED';
    }
  }

  next.pendingCorrection = params.tracker.status === 'FAILED'
    ? 'AWAITING_BLOCKER_EXPLANATION'
    : 'NONE';
  next.progressHistory.push(params.tracker);
  trimProgressHistory(next);
  next.awaitingToolDispatch = [...params.acceptedInvocationIds];
  next.awaitingApprovalInvocations = [...params.approvalInvocationIds];
  
  if (!next.executionLease) {
    next.executionLease = {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    };
  }
  
  next.executionLease.phase = next.lifecycleStatus === 'COMPLETED'
    ? 'COMPLETED'
    : (next.lifecycleStatus === 'FAILED' ? 'INTERRUPTED' : 'ACTIVE');
  next.executionLease.active = next.lifecycleStatus === 'RUNNING';
  next.safePoint = {
    stage: 'AFTER_TRACKER',
    reachedAt: params.now ?? Date.now(),
    interruptible: true
  };
  next.latestSessionId = params.sessionId;
  next.latestCorrelationId = params.correlationId;
  next.latestTurnId = params.turnId;
  next.latestCheckpointId = params.checkpointId;
  next.selectedProviderId = params.providerId;
  next.lastError = params.tracker.status === 'FAILED' ? params.tracker.reason : null;
  next.updatedAt = params.now ?? Date.now();
  finalizeDerivedCollections(next);
  updateContractDiagnostics(params.definition, next);
  return next;
}

export function applyTrackerStates(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  trackers: ProgressTracker[];
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  providerId: string | null;
  now?: number;
}): TaskRuntimeState {
  let next = cloneRuntime(params.runtime);
  const orderedTrackers = [...params.trackers];
  for (let index = 0; index < orderedTrackers.length; index += 1) {
    const tracker = orderedTrackers[index];
    next = applyTrackerState({
      definition: params.definition,
      runtime: next,
      tracker,
      acceptedInvocationIds: index === orderedTrackers.length - 1 ? params.acceptedInvocationIds : [],
      approvalInvocationIds: index === orderedTrackers.length - 1 ? params.approvalInvocationIds : [],
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      providerId: params.providerId,
      now: params.now
    });
  }
  return next;
}
