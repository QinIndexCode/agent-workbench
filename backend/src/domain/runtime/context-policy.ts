import { ValidatedOutputRecord } from '../../foundation/repository';
import { InputContractScope, UnitContract } from '../contracts/unit-contract';
import { AgentUnit, RuntimeTaskMemoryState, SchedulerUnitState, TaskDefinition } from '../contracts/types';
import { createTopologyGraph, selectContractScopedUnitIds, TopologyGraph } from './topology-graph';

type ContextScopedUnit = AgentUnit | SchedulerUnitState;
type MemoryKind = 'MILESTONE' | 'DECISION';

export interface MemorySelectionResult {
  allowedUnitIds: Set<string> | null;
  allowedKinds: MemoryKind[];
  includeGlobalMemory: boolean;
  source: 'STRUCTURED' | 'DEFAULT' | 'COMPAT_FALLBACK';
}

export interface ContextSelectionResult {
  graph: TopologyGraph;
  contract: UnitContract;
  scopedUnitIds: Set<string> | null;
  outputKeysByUnitId: Record<string, string[]>;
  memory: MemorySelectionResult;
  usedCompatibilityFallback: boolean;
}

function getUnitId(unit: ContextScopedUnit): string {
  return 'unitId' in unit ? unit.unitId : unit.id;
}

function defaultMemorySelection(scope: InputContractScope, scopedUnitIds: Set<string> | null): MemorySelectionResult {
  const allowedUnitIds = scope.memoryUnitIds.length > 0 ? new Set(scope.memoryUnitIds) : scopedUnitIds;
  const source = scope.memoryUnitIds.length > 0
    ? 'STRUCTURED'
    : (scope.usedCompatibilityFallback ? 'COMPAT_FALLBACK' : 'DEFAULT');
  return {
    allowedUnitIds,
    allowedKinds: scope.memoryKinds,
    includeGlobalMemory: scope.includeGlobalMemory,
    source
  };
}

export function resolveContextSelection(params: {
  definition: TaskDefinition;
  currentUnit: ContextScopedUnit;
}): ContextSelectionResult {
  const graph = createTopologyGraph(params.definition);
  const unitId = getUnitId(params.currentUnit);
  const contract = graph.contractsByUnitId[unitId];
  const scopedUnitIds = selectContractScopedUnitIds(graph, unitId);

  return {
    graph,
    contract,
    scopedUnitIds,
    outputKeysByUnitId: structuredClone(contract?.inputScope.outputKeysByUnitId ?? {}),
    memory: defaultMemorySelection(contract?.inputScope ?? {
      unitIds: [],
      outputKeysByUnitId: {},
      memoryUnitIds: [],
      memoryKinds: [],
      includeGlobalMemory: true,
      structured: false,
      usedCompatibilityFallback: false,
      source: 'NORMALIZED'
    }, scopedUnitIds)
    ,
    usedCompatibilityFallback: contract?.inputScope.usedCompatibilityFallback ?? false
  };
}

function filterScopedMemoryItems(items: string[], allowedUnitIds: Set<string> | null, includeGlobalMemory: boolean): string[] {
  if (allowedUnitIds === null) {
    return items;
  }
  return items.filter((item) => {
    const match = item.match(/^([A-Za-z0-9_-]+):/);
    if (!match) {
      return includeGlobalMemory;
    }
    return allowedUnitIds.has(match[1]);
  });
}

function filterMemoryKinds(params: {
  memory: RuntimeTaskMemoryState;
  allowedKinds: MemoryKind[];
}): RuntimeTaskMemoryState {
  if (params.allowedKinds.length === 0) {
    return params.memory;
  }
  return {
    ...params.memory,
    keyMilestones: params.allowedKinds.includes('MILESTONE') ? params.memory.keyMilestones : [],
    importantDecisions: params.allowedKinds.includes('DECISION') ? params.memory.importantDecisions : []
  };
}

export function selectMemoryForContext(params: {
  definition: TaskDefinition;
  currentUnit: ContextScopedUnit;
  memory: RuntimeTaskMemoryState | null;
}): {
  memory: RuntimeTaskMemoryState | null;
  selection: ContextSelectionResult;
} {
  const selection = resolveContextSelection({
    definition: params.definition,
    currentUnit: params.currentUnit
  });

  if (!params.memory) {
    return {
      memory: null,
      selection
    };
  }

  const scopedMemory = filterMemoryKinds({
    memory: params.memory,
    allowedKinds: selection.memory.allowedKinds
  });

  return {
    selection,
    memory: {
      ...scopedMemory,
      keyMilestones: filterScopedMemoryItems(
        scopedMemory.keyMilestones,
        selection.memory.allowedUnitIds,
        selection.memory.includeGlobalMemory
      ),
      importantDecisions: filterScopedMemoryItems(
        scopedMemory.importantDecisions,
        selection.memory.allowedUnitIds,
        selection.memory.includeGlobalMemory
      )
    }
  };
}

function filterParsedOutputKeys(parsed: unknown, allowedKeys: string[] | undefined): unknown {
  if (!allowedKeys || allowedKeys.length === 0) {
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const source = parsed as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => allowedKeys.includes(key))
  );
}

export function selectValidatedOutputsForContext(params: {
  definition: TaskDefinition;
  currentUnit: ContextScopedUnit;
  records: ValidatedOutputRecord[];
}): {
  records: ValidatedOutputRecord[];
  selection: ContextSelectionResult;
} {
  const selection = resolveContextSelection({
    definition: params.definition,
    currentUnit: params.currentUnit
  });
  const selected = selection.scopedUnitIds === null
    ? [...params.records]
    : params.records.filter((record) => selection.scopedUnitIds?.has(record.unitId));

  return {
    selection,
    records: selected.map((record) => ({
      ...record,
      parsed: filterParsedOutputKeys(record.parsed, selection.outputKeysByUnitId[record.unitId])
    }))
  };
}
