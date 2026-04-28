import { TaskDefinition, TaskRuntimeState } from '../contracts/types';
import { TopologyGraph, createTopologyGraph } from './topology-graph';

export type DependencyKind = 'HARD' | 'SOFT';

export type BatchGroupingHint = 'SERIAL_READY' | 'PARALLEL_CANDIDATE';

export interface DependencyEdge {
  fromUnitId: string;
  toUnitId: string;
  kind: DependencyKind;
}

export interface PlannedUnit {
  unitId: string;
  stageIndex: number;
  batchHint: BatchGroupingHint;
}

export interface PlannedBatch {
  batchId: string;
  stageIndex: number;
  hint: BatchGroupingHint;
  unitIds: string[];
}

export interface PlanStage {
  stageIndex: number;
  unitIds: string[];
  entryUnitIds: string[];
  exitUnitIds: string[];
  batchGroupingHint: BatchGroupingHint;
  batches: PlannedBatch[];
}

export interface ExecutionPlan {
  planVersion: string;
  unitIds: string[];
  stages: PlanStage[];
  plannedUnits: Record<string, PlannedUnit>;
  dependencyEdges: DependencyEdge[];
}

export interface PlanValidationIssue {
  code: 'invalid_stage_hard_dependency' | 'invalid_batch_hint' | 'invalid_execution_plan';
  message: string;
  unitId?: string;
}

export interface PlanValidationResult {
  ok: boolean;
  issues: PlanValidationIssue[];
}

export interface PlannerDiagnosticsSummary {
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
    hint: BatchGroupingHint;
    unitIds: string[];
  }>;
  toolBatchHints: Array<{
    stageIndex: number;
    batchId: string;
    hint: BatchGroupingHint;
    unitIds: string[];
  }>;
  batchGroupingHints: Array<{
    stageIndex: number;
    hint: BatchGroupingHint;
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

const PLAN_VERSION = 'planner-v1';

export function createExecutionPlan(definition: TaskDefinition, topology = createTopologyGraph(definition)): ExecutionPlan {
  const plannedUnits: Record<string, PlannedUnit> = {};
  const dependencyEdges: DependencyEdge[] = [];
  const stages: PlanStage[] = topology.stages.map((stage) => {
    for (const unitId of stage.unitIds) {
      plannedUnits[unitId] = {
        unitId,
        stageIndex: stage.stageIndex,
        batchHint: stage.batchHint
      };
      for (const dependency of topology.dependencyKindsByUnitId[unitId] ?? []) {
        dependencyEdges.push({
          fromUnitId: dependency.unitId,
          toUnitId: unitId,
          kind: dependency.kind
        });
      }
    }
    return {
      stageIndex: stage.stageIndex,
      unitIds: [...stage.unitIds],
      entryUnitIds: [...stage.entryUnitIds],
      exitUnitIds: [...stage.exitUnitIds],
      batchGroupingHint: stage.batchHint,
      batches: [
        {
          batchId: `stage_${stage.stageIndex}_batch_0`,
          stageIndex: stage.stageIndex,
          hint: stage.batchHint,
          unitIds: [...stage.unitIds]
        }
      ]
    };
  });

  return {
    planVersion: PLAN_VERSION,
    unitIds: [...topology.unitIds],
    stages,
    plannedUnits,
    dependencyEdges
  };
}

export function validateExecutionPlan(plan: ExecutionPlan, topology: TopologyGraph): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];

  for (const edge of plan.dependencyEdges) {
    if (edge.kind !== 'HARD') {
      continue;
    }
    const fromStage = topology.stageIndexByUnitId[edge.fromUnitId];
    const toStage = topology.stageIndexByUnitId[edge.toUnitId];
    if (typeof fromStage !== 'number' || typeof toStage !== 'number') {
      issues.push({
        code: 'invalid_execution_plan',
        message: `Execution plan references unknown unit in dependency edge ${edge.fromUnitId} -> ${edge.toUnitId}.`,
        unitId: edge.toUnitId
      });
      continue;
    }
    if (fromStage >= toStage) {
      issues.push({
        code: 'invalid_stage_hard_dependency',
        message: `Execution plan places hard dependency "${edge.fromUnitId}" for unit "${edge.toUnitId}" in a non-prior stage.`,
        unitId: edge.toUnitId
      });
    }
  }

  for (const stage of plan.stages) {
    if (stage.batchGroupingHint === 'PARALLEL_CANDIDATE' && stage.unitIds.length <= 1) {
      issues.push({
        code: 'invalid_batch_hint',
        message: `Execution plan marks stage ${stage.stageIndex} as PARALLEL_CANDIDATE without multiple units.`
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function isUnitFinished(runtime: TaskRuntimeState, unitId: string): boolean {
  const state = runtime.schedulerUnits[unitId];
  return !!state && (state.status === 'COMPLETE' || state.status === 'FAILED' || state.status === 'SKIPPED');
}

export function canEarlyTerminateCurrentUnit(runtime: TaskRuntimeState, currentUnitId: string): boolean {
  return Object.entries(runtime.schedulerUnits).every(([unitId, unit]) => {
    if (unitId === currentUnitId) {
      return true;
    }
    return unit.status === 'COMPLETE' || unit.status === 'FAILED' || unit.status === 'SKIPPED';
  });
}

function areDependenciesSatisfied(runtime: TaskRuntimeState, topology: TopologyGraph, unitId: string): boolean {
  return (topology.dependenciesByUnitId[unitId] ?? []).every((dependencyId) => {
    const dependency = runtime.schedulerUnits[dependencyId];
    return !!dependency && dependency.status === 'COMPLETE';
  });
}

export function getCurrentStageIndex(plan: ExecutionPlan, runtime: TaskRuntimeState): number | null {
  if (runtime.currentUnitId) {
    const currentStageIndex = plan.plannedUnits[runtime.currentUnitId]?.stageIndex ?? null;
    if (currentStageIndex !== null) {
      const currentStage = plan.stages.find((stage) => stage.stageIndex === currentStageIndex) ?? null;
      if (currentStage && currentStage.unitIds.some((unitId) => !isUnitFinished(runtime, unitId))) {
        return currentStageIndex;
      }
    }
  }
  for (const stage of plan.stages) {
    if (stage.unitIds.some((unitId) => !isUnitFinished(runtime, unitId))) {
      return stage.stageIndex;
    }
  }
  return null;
}

export function getReadyStageUnitIds(
  plan: ExecutionPlan,
  topology: TopologyGraph,
  runtime: TaskRuntimeState,
  stageIndex: number | null
): string[] {
  if (stageIndex === null) {
    return [];
  }
  const stage = plan.stages.find((candidate) => candidate.stageIndex === stageIndex);
  if (!stage) {
    return [];
  }
  return stage.unitIds.filter((unitId) => {
    const state = runtime.schedulerUnits[unitId];
    if (!state || isUnitFinished(runtime, unitId)) {
      return false;
    }
    return areDependenciesSatisfied(runtime, topology, unitId);
  });
}

export function canExecuteUnitInPlan(
  plan: ExecutionPlan,
  topology: TopologyGraph,
  runtime: TaskRuntimeState,
  unitId: string
): boolean {
  const planned = plan.plannedUnits[unitId];
  if (!planned) {
    return false;
  }
  const currentStageIndex = getCurrentStageIndex(plan, runtime);
  if (currentStageIndex === null) {
    return false;
  }
  if (planned.stageIndex !== currentStageIndex) {
    return false;
  }
  return areDependenciesSatisfied(runtime, topology, unitId);
}

export function selectNextReadyUnitInPlan(
  plan: ExecutionPlan,
  topology: TopologyGraph,
  runtime: TaskRuntimeState
): string | null {
  const currentStageIndex = getCurrentStageIndex(plan, runtime);
  const readyStageUnitIds = getReadyStageUnitIds(plan, topology, runtime, currentStageIndex);
  return readyStageUnitIds[0] ?? null;
}

export function createPlannerDiagnosticsSummary(
  definition: TaskDefinition,
  runtime: TaskRuntimeState,
  topology = createTopologyGraph(definition),
  plan = createExecutionPlan(definition, topology),
  fallbackReasons: string[] = runtime.planner?.fallbackReasons ?? []
): PlannerDiagnosticsSummary {
  const currentStageIndex = getCurrentStageIndex(plan, runtime);
  const currentStage = currentStageIndex === null
    ? null
    : plan.stages.find((stage) => stage.stageIndex === currentStageIndex) ?? null;
  const readyStageUnitIds = getReadyStageUnitIds(plan, topology, runtime, currentStageIndex);
  const dependencySummary = {
    hardEdgeCount: plan.dependencyEdges.filter((edge) => edge.kind === 'HARD').length,
    softEdgeCount: plan.dependencyEdges.filter((edge) => edge.kind === 'SOFT').length,
    entryUnitIds: currentStage ? [...currentStage.entryUnitIds] : [],
    exitUnitIds: currentStage ? [...currentStage.exitUnitIds] : []
  };
  const exitIssues = runtime.contractDiagnostics?.lastExitCondition?.ok === false
    ? [...runtime.contractDiagnostics.lastExitCondition.issueCodes]
    : [];
  const contractIssues = runtime.currentUnitId ? [...(runtime.invalidOutputUnits[runtime.currentUnitId] ?? [])] : [];
  let blockingReason: PlannerDiagnosticsSummary['blockingReason'] = null;
  if (runtime.consolidationState?.status === 'CORRECTION_REQUIRED') {
    blockingReason = 'CONSOLIDATION_BLOCKED';
  } else if ((runtime.pendingToolBatches ?? []).some((batch) => batch.status === 'FAILED' || batch.status === 'PARTIAL_APPROVAL_BLOCKED' || batch.status === 'DENIED')) {
    blockingReason = 'BATCH_BLOCKED';
  } else if (exitIssues.length > 0) {
    blockingReason = 'EXIT_CONDITION_BLOCKED';
  } else if (runtime.pendingCorrection !== 'NONE' || contractIssues.length > 0) {
    blockingReason = 'CONTRACT_BLOCKED';
  } else if (currentStageIndex !== null && readyStageUnitIds.length === 0 && runtime.lifecycleStatus === 'RUNNING') {
    blockingReason = 'TOPOLOGY_BLOCKED';
  } else if (runtime.currentUnitId && !canExecuteUnitInPlan(plan, topology, runtime, runtime.currentUnitId)) {
    blockingReason = 'PLANNER_STAGE_NOT_READY';
  }

  return {
    planVersion: plan.planVersion,
    executionPhase: runtime.planner?.executionPhase ?? 'IDLE',
    stageCount: plan.stages.length,
    currentStageIndex,
    currentStageUnitIds: currentStage ? [...currentStage.unitIds] : [],
    readyStageUnitIds,
    providerBatchCount: currentStage ? 1 : 0,
    toolBatchCount: currentStage ? currentStage.batches.length : 0,
    providerBatchHints: currentStage
      ? [{
        stageIndex: currentStage.stageIndex,
        batchId: `stage_${currentStage.stageIndex}_provider_batch_0`,
        hint: currentStage.batchGroupingHint,
        unitIds: [...currentStage.unitIds]
      }]
      : [],
    toolBatchHints: currentStage
      ? currentStage.batches.map((batch) => ({
        stageIndex: batch.stageIndex,
        batchId: batch.batchId,
        hint: batch.hint,
        unitIds: [...batch.unitIds]
      }))
      : [],
    batchGroupingHints: plan.stages.map((stage) => ({
      stageIndex: stage.stageIndex,
      hint: stage.batchGroupingHint,
      unitIds: [...stage.unitIds]
    })),
    dependencySummary,
    contractBlockingReasons: exitIssues.length > 0 ? exitIssues : contractIssues,
    fallbackReasons: [...fallbackReasons],
    blockingReason
  };
}
