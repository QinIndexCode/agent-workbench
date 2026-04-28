import { ActiveStageState, TaskDefinition, TaskRuntimeState } from '../contracts/types';
import {
  BatchGroupingHint,
  ExecutionPlan,
  PlanValidationResult,
  createExecutionPlan,
  getReadyStageUnitIds,
  getCurrentStageIndex,
  validateExecutionPlan
} from '../runtime/execution-plan';
import { TopologyGraph, createTopologyGraph } from '../runtime/topology-graph';

export interface PlannedStageExecution {
  stageIndex: number;
  unitIds: string[];
  entryUnitIds: string[];
  exitUnitIds: string[];
  batchGroupingHint: BatchGroupingHint;
}

export interface PlannedProviderBatch {
  batchId: string;
  stageIndex: number;
  unitIds: string[];
  hint: BatchGroupingHint;
}

export interface PlannedToolBatch {
  batchId: string;
  stageIndex: number;
  unitIds: string[];
  hint: BatchGroupingHint;
}

export interface ConsolidationRequirement {
  required: boolean;
  stageIndex: number | null;
  unitIds: string[];
  reason: 'STAGE_OUTPUTS' | 'TOOL_RESULTS' | 'NONE';
}

export interface PlannerValidationResult extends PlanValidationResult {
  plannerIssues: Array<{
    code: 'planner_output_invalid';
    message: string;
  }>;
}

export interface PlannerTurnOutput {
  planVersion: string;
  activeStage: PlannedStageExecution | null;
  readyStageUnitIds: string[];
  plannedProviderBatches: PlannedProviderBatch[];
  plannedToolBatches: PlannedToolBatch[];
  consolidation: ConsolidationRequirement;
  fallbackToSingleActive: boolean;
  fallbackReasons: string[];
  fallbackReason: string | null;
}

export interface PlannerTurnComputation {
  topology: TopologyGraph;
  plan: ExecutionPlan;
  validation: PlannerValidationResult;
  output: PlannerTurnOutput;
}

function toActiveStageState(stage: PlannedStageExecution | null): ActiveStageState | null {
  if (!stage) {
    return null;
  }
  return {
    stageIndex: stage.stageIndex,
    unitIds: [...stage.unitIds],
    entryUnitIds: [...stage.entryUnitIds],
    exitUnitIds: [...stage.exitUnitIds],
    batchGroupingHint: stage.batchGroupingHint
  };
}

export function createPlannerTurn(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
}): PlannerTurnComputation {
  const topology = createTopologyGraph(params.definition);
  const plan = createExecutionPlan(params.definition, topology);
  const planValidation = validateExecutionPlan(plan, topology);
  const currentStageIndex = getCurrentStageIndex(plan, params.runtime);
  const currentStage = currentStageIndex === null
    ? null
    : plan.stages.find((stage) => stage.stageIndex === currentStageIndex) ?? null;
  const readyStageUnitIds = getReadyStageUnitIds(plan, topology, params.runtime, currentStageIndex);
  const activeStage: PlannedStageExecution | null = currentStage
    ? {
      stageIndex: currentStage.stageIndex,
      unitIds: [...currentStage.unitIds],
      entryUnitIds: [...currentStage.entryUnitIds],
      exitUnitIds: [...currentStage.exitUnitIds],
      batchGroupingHint: currentStage.batchGroupingHint
    }
    : null;
  const forcedFallback = params.definition.metadata['benchmark.forceSingleActiveFallback'] === true;
  const plannedProviderBatches: PlannedProviderBatch[] = activeStage
    ? [{
      batchId: `stage_${activeStage.stageIndex}_provider_batch_0`,
      stageIndex: activeStage.stageIndex,
      unitIds: [...activeStage.unitIds],
      hint: activeStage.batchGroupingHint
    }]
    : [];
  const plannedToolBatches: PlannedToolBatch[] = activeStage
    ? currentStage!.batches.map((batch) => ({
      batchId: batch.batchId,
      stageIndex: batch.stageIndex,
      unitIds: [...batch.unitIds],
      hint: batch.hint
    }))
    : [];
  const fallbackReasons = [
    ...(forcedFallback ? ['benchmark_forced_single_active_fallback'] : []),
    ...(!activeStage && params.runtime.lifecycleStatus === 'RUNNING'
      ? ['planner_missing_active_stage']
      : []),
    ...(activeStage && readyStageUnitIds.length === 0 && params.runtime.lifecycleStatus === 'RUNNING'
      ? ['planner_stage_has_no_ready_units']
      : [])
  ];
  const fallbackReason = fallbackReasons[0] ?? null;
  const plannerIssues = !activeStage && params.runtime.lifecycleStatus === 'RUNNING'
    ? [{
      code: 'planner_output_invalid' as const,
      message: 'Planner did not produce an active stage for a running task.'
    }]
    : [];

  return {
    topology,
    plan,
    validation: {
      ok: planValidation.ok && plannerIssues.length === 0,
      issues: [...planValidation.issues],
      plannerIssues
    },
    output: {
      planVersion: plan.planVersion,
      activeStage,
      readyStageUnitIds,
      plannedProviderBatches,
      plannedToolBatches,
      consolidation: {
        required: activeStage !== null,
        stageIndex: activeStage?.stageIndex ?? null,
        unitIds: activeStage ? [...activeStage.unitIds] : [],
        reason: activeStage ? 'STAGE_OUTPUTS' : 'NONE'
      },
      fallbackToSingleActive: forcedFallback || (!activeStage && params.runtime.lifecycleStatus === 'RUNNING'),
      fallbackReasons,
      fallbackReason
    }
  };
}

export function toActiveStageDiagnostics(stage: PlannedStageExecution | null): ActiveStageState | null {
  return toActiveStageState(stage);
}
