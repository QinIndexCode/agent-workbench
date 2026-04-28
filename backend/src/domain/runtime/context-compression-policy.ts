import { ValidatedOutputRecord } from '../../foundation/repository';
import { RuntimeTaskMemoryState } from '../contracts/types';
import { AgentUnit, SchedulerUnitState, TaskDefinition, TaskRuntimeState } from '../contracts/types';

type CompressionScopedUnit = AgentUnit | SchedulerUnitState;

export interface ContextCompressionPolicyResult {
  mode: 'STANDARD' | 'CONSERVATIVE';
  compressionDowngraded: boolean;
  preservedValidatedOutputUnitIds: string[];
  preservedMemoryUnitIds: string[] | null;
  reasons: string[];
}

function getUnitId(unit: CompressionScopedUnit): string {
  return 'id' in unit ? unit.id : unit.unitId;
}

function getDependencies(unit: CompressionScopedUnit): string[] {
  return [...(unit.dependencies ?? [])];
}

function getStageUnitIds(runtime: TaskRuntimeState): string[] {
  return [...(runtime.activeStage?.unitIds ?? [])];
}

function createReasonedSet(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function shouldDowngradeCompression(runtime: TaskRuntimeState): {
  downgraded: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (runtime.consolidationState?.status === 'CORRECTION_REQUIRED') {
    reasons.push('recent_consolidation_correction');
  }
  if ((runtime.pendingToolBatches ?? []).some((batch) => (
    batch.status === 'PARTIAL_APPROVAL_BLOCKED'
    || batch.status === 'FAILED'
    || batch.status === 'DENIED'
  ))) {
    reasons.push('approval_or_batch_blocking');
  }
  if ((runtime.planner?.fallbackReasons?.length ?? 0) > 0) {
    reasons.push('planner_fallback_present');
  }
  return {
    downgraded: reasons.length > 0,
    reasons
  };
}

function collectPreservedOutputUnitIds(params: {
  runtime: TaskRuntimeState;
  currentUnit: CompressionScopedUnit;
  records: ValidatedOutputRecord[];
}): string[] {
  const currentUnitId = getUnitId(params.currentUnit);
  const dependencies = getDependencies(params.currentUnit);
  const stageUnitIds = getStageUnitIds(params.runtime);
  const preserved = new Set<string>([currentUnitId, ...dependencies]);

  for (const record of params.records) {
    if ((record.contractKeys?.length ?? 0) > 0 && (dependencies.includes(record.unitId) || stageUnitIds.includes(record.unitId))) {
      preserved.add(record.unitId);
    }
  }

  if (params.runtime.consolidationState?.status === 'CORRECTION_REQUIRED') {
    for (const unitId of stageUnitIds) {
      preserved.add(unitId);
    }
  }

  if ((params.runtime.pendingToolBatches ?? []).some((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED')) {
    for (const unitId of stageUnitIds) {
      preserved.add(unitId);
    }
  }

  return [...preserved].filter((unitId) => params.records.some((record) => record.unitId === unitId));
}

function collectPreservedMemoryUnitIds(params: {
  runtime: TaskRuntimeState;
  currentUnit: CompressionScopedUnit;
  memory: RuntimeTaskMemoryState | null;
}): string[] | null {
  if (!params.memory) {
    return null;
  }
  const currentUnitId = getUnitId(params.currentUnit);
  const dependencies = getDependencies(params.currentUnit);
  const stageUnitIds = getStageUnitIds(params.runtime);
  const unitIds = new Set<string>([currentUnitId, ...dependencies]);

  if (params.runtime.consolidationState?.status === 'CORRECTION_REQUIRED') {
    for (const unitId of stageUnitIds) {
      unitIds.add(unitId);
    }
  }
  if ((params.runtime.planner?.fallbackReasons?.length ?? 0) > 0) {
    for (const unitId of stageUnitIds) {
      unitIds.add(unitId);
    }
  }

  return unitIds.size > 0 ? [...unitIds] : null;
}

export function createContextCompressionPolicy(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  currentUnit: CompressionScopedUnit;
  validatedOutputs: ValidatedOutputRecord[];
  memory: RuntimeTaskMemoryState | null;
}): ContextCompressionPolicyResult {
  const guardrail = shouldDowngradeCompression(params.runtime);
  const reasons = createReasonedSet([
    'direct_dependency_outputs_preserved',
    ...guardrail.reasons
  ]);

  return {
    mode: guardrail.downgraded ? 'CONSERVATIVE' : 'STANDARD',
    compressionDowngraded: guardrail.downgraded,
    preservedValidatedOutputUnitIds: collectPreservedOutputUnitIds({
      runtime: params.runtime,
      currentUnit: params.currentUnit,
      records: params.validatedOutputs
    }),
    preservedMemoryUnitIds: collectPreservedMemoryUnitIds({
      runtime: params.runtime,
      currentUnit: params.currentUnit,
      memory: params.memory
    }),
    reasons
  };
}
