import { ValidatedOutputRecord } from '../../foundation/repository';
import { AgentUnit, RuntimeTaskMemoryState, SchedulerUnitState, TaskDefinition } from '../contracts/types';
import {
  selectMemoryForContext,
  selectValidatedOutputsForContext
} from './context-policy';

type ContextScopedUnit = AgentUnit | SchedulerUnitState;

export function selectTaskMemoryForPrompt(params: {
  definition: TaskDefinition;
  currentUnit: ContextScopedUnit;
  memory: RuntimeTaskMemoryState | null;
}): RuntimeTaskMemoryState | null {
  return selectMemoryForContext(params).memory;
}

export function selectValidatedOutputsForPrompt(params: {
  definition: TaskDefinition;
  currentUnit: ContextScopedUnit;
  records: ValidatedOutputRecord[];
  retrievalLimit?: number;
}): {
  records: ValidatedOutputRecord[];
  retrievedContextCount: number;
  policyFilteredOutputCount: number;
} {
  const result = selectValidatedOutputsForContext({
    definition: params.definition,
    currentUnit: params.currentUnit,
    records: params.records
  });

  return {
    records: result.records,
    retrievedContextCount: 0,
    policyFilteredOutputCount: Math.max(0, params.records.length - result.records.length)
  };
}
