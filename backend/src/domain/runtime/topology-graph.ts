import { AgentUnit, SchedulerUnitState, TaskDefinition, TaskRuntimeState } from '../contracts/types';
import { UnitContract, createUnitContract, validateUnitContract } from '../contracts/unit-contract';

type TopologyScopedUnit = AgentUnit | SchedulerUnitState | UnitContract;

export interface TopologyValidationIssue {
  code: string;
  message: string;
  unitId?: string;
}

export interface TopologyValidationResult {
  ok: boolean;
  issues: TopologyValidationIssue[];
}

export interface TopologyGraph {
  unitIds: string[];
  rootUnitIds: string[];
  dependenciesByUnitId: Record<string, string[]>;
  dependencyKindsByUnitId: Record<string, Array<{ unitId: string; kind: 'HARD' | 'SOFT' }>>;
  dependentsByUnitId: Record<string, string[]>;
  contractsByUnitId: Record<string, UnitContract>;
  stages: TopologyStageMetadata[];
  stageIndexByUnitId: Record<string, number>;
}

export interface TopologyStageMetadata {
  stageIndex: number;
  unitIds: string[];
  batchHint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
  entryUnitIds: string[];
  exitUnitIds: string[];
}

function getUnitId(unit: TopologyScopedUnit): string {
  if ('unitId' in unit) {
    return unit.unitId;
  }
  return unit.id;
}

export function createTopologyGraph(definition: TaskDefinition): TopologyGraph {
  const unitIds = definition.units.map((unit) => unit.id);
  const dependenciesByUnitId: Record<string, string[]> = {};
  const dependencyKindsByUnitId: Record<string, Array<{ unitId: string; kind: 'HARD' | 'SOFT' }>> = {};
  const dependentsByUnitId: Record<string, string[]> = {};
  const contractsByUnitId: Record<string, UnitContract> = {};

  for (const unit of definition.units) {
    dependenciesByUnitId[unit.id] = [...unit.dependencies];
    dependencyKindsByUnitId[unit.id] = unit.dependencies.map((dependencyId) => ({
      unitId: dependencyId,
      kind: 'HARD'
    }));
    contractsByUnitId[unit.id] = createUnitContract(unit, unitIds);
    if (!dependentsByUnitId[unit.id]) {
      dependentsByUnitId[unit.id] = [];
    }
  }

  for (const unit of definition.units) {
    for (const dependencyId of unit.dependencies) {
      if (!dependentsByUnitId[dependencyId]) {
        dependentsByUnitId[dependencyId] = [];
      }
      dependentsByUnitId[dependencyId].push(unit.id);
    }
  }

  const rootUnitIds = unitIds.filter((unitId) => (dependenciesByUnitId[unitId] ?? []).length === 0);
  const { stages, stageIndexByUnitId } = buildTopologyStages(unitIds, dependenciesByUnitId);

  return {
    unitIds,
    rootUnitIds,
    dependenciesByUnitId,
    dependencyKindsByUnitId,
    dependentsByUnitId,
    contractsByUnitId,
    stages,
    stageIndexByUnitId
  };
}

function buildTopologyStages(
  unitIds: string[],
  dependenciesByUnitId: Record<string, string[]>
): {
  stages: TopologyStageMetadata[];
  stageIndexByUnitId: Record<string, number>;
} {
  const stageIndexByUnitId: Record<string, number> = {};

  const resolveStageIndex = (unitId: string, visited = new Set<string>()): number => {
    if (typeof stageIndexByUnitId[unitId] === 'number') {
      return stageIndexByUnitId[unitId];
    }
    if (visited.has(unitId)) {
      return 0;
    }
    visited.add(unitId);
    const dependencies = dependenciesByUnitId[unitId] ?? [];
    const stageIndex = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependencyId) => resolveStageIndex(dependencyId, visited))) + 1;
    visited.delete(unitId);
    stageIndexByUnitId[unitId] = stageIndex;
    return stageIndex;
  };

  for (const unitId of unitIds) {
    resolveStageIndex(unitId);
  }

  const unitsByStage = new Map<number, string[]>();
  for (const unitId of unitIds) {
    const stageIndex = stageIndexByUnitId[unitId] ?? 0;
    const existing = unitsByStage.get(stageIndex) ?? [];
    existing.push(unitId);
    unitsByStage.set(stageIndex, existing);
  }

  const stages = Array.from(unitsByStage.entries())
    .sort(([left], [right]) => left - right)
    .map(([stageIndex, stageUnitIds]): TopologyStageMetadata => ({
      stageIndex,
      unitIds: stageUnitIds,
      batchHint: stageUnitIds.length > 1 ? 'PARALLEL_CANDIDATE' : 'SERIAL_READY',
      entryUnitIds: [...stageUnitIds],
      exitUnitIds: [...stageUnitIds]
    }));

  return {
    stages,
    stageIndexByUnitId
  };
}

function detectCycle(definition: TaskDefinition): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const trail: string[] = [];
  const unitsById = new Map(definition.units.map((unit) => [unit.id, unit]));

  function visit(unitId: string): string[] | null {
    if (visiting.has(unitId)) {
      const cycleStart = trail.indexOf(unitId);
      return cycleStart >= 0 ? [...trail.slice(cycleStart), unitId] : [unitId, unitId];
    }
    if (visited.has(unitId)) {
      return null;
    }
    visiting.add(unitId);
    trail.push(unitId);
    const unit = unitsById.get(unitId);
    for (const dependencyId of unit?.dependencies ?? []) {
      const cycle = visit(dependencyId);
      if (cycle) {
        return cycle;
      }
    }
    trail.pop();
    visiting.delete(unitId);
    visited.add(unitId);
    return null;
  }

  for (const unit of definition.units) {
    const cycle = visit(unit.id);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

export function validateTaskDefinitionPreflight(definition: TaskDefinition): TopologyValidationResult {
  const issues: TopologyValidationIssue[] = [];
  const unitIds = definition.units.map((unit) => unit.id);
  const seen = new Set<string>();

  for (const unit of definition.units) {
    if (seen.has(unit.id)) {
      issues.push({
        code: 'duplicate_unit_id',
        message: `Task definition contains duplicate unit id "${unit.id}".`,
        unitId: unit.id
      });
    }
    seen.add(unit.id);

    const unitContractValidation = validateUnitContract(unit, unitIds);
    for (const issue of unitContractValidation.issues) {
      issues.push(issue);
    }

    for (const dependencyId of unit.dependencies) {
      if (dependencyId === unit.id) {
        issues.push({
          code: 'self_dependency',
          message: `Unit "${unit.id}" must not depend on itself.`,
          unitId: unit.id
        });
      } else if (!unitIds.includes(dependencyId)) {
        issues.push({
          code: 'missing_dependency',
          message: `Unit "${unit.id}" depends on missing unit "${dependencyId}".`,
          unitId: unit.id
        });
      }
    }
  }

  const cycle = detectCycle(definition);
  if (cycle) {
    issues.push({
      code: 'cyclic_dependency',
      message: `Task definition contains a dependency cycle: ${cycle.join(' -> ')}.`
    });
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export function collectDependencyClosure(graph: TopologyGraph, unitId: string): Set<string> {
  const visited = new Set<string>();
  const queue = [...(graph.dependenciesByUnitId[unitId] ?? [])];

  while (queue.length > 0) {
    const dependencyId = queue.shift()!;
    if (visited.has(dependencyId)) {
      continue;
    }
    visited.add(dependencyId);
    queue.push(...(graph.dependenciesByUnitId[dependencyId] ?? []));
  }

  return visited;
}

export function selectAccessibleUnitIds(graph: TopologyGraph, unit: TopologyScopedUnit): Set<string> | null {
  const unitId = getUnitId(unit);
  const permissionLevel = graph.contractsByUnitId[unitId]?.permissionLevel
    ?? ('permissionLevel' in unit && unit.permissionLevel ? unit.permissionLevel : 'DEPENDENCY');

  if (permissionLevel === 'GLOBAL') {
    return null;
  }
  if (permissionLevel === 'PRIVATE') {
    return new Set<string>();
  }
  return collectDependencyClosure(graph, unitId);
}

export function selectContractScopedUnitIds(graph: TopologyGraph, unitId: string): Set<string> | null {
  const contract = graph.contractsByUnitId[unitId];
  const accessibleUnitIds = selectAccessibleUnitIds(graph, contract);

  if (!contract || contract.referencedInputUnitIds.length === 0) {
    return accessibleUnitIds;
  }
  if (accessibleUnitIds === null) {
    return new Set(contract.referencedInputUnitIds);
  }
  return new Set(contract.referencedInputUnitIds.filter((referencedUnitId) => accessibleUnitIds.has(referencedUnitId)));
}

function allDependenciesSatisfied(runtime: TaskRuntimeState, unitId: string, graph: TopologyGraph): boolean {
  return (graph.dependenciesByUnitId[unitId] ?? []).every((dependencyId) => {
    const dependency = runtime.schedulerUnits[dependencyId];
    return !!dependency && dependency.status === 'COMPLETE';
  });
}

export function selectNextReadyUnitFromTopology(
  graph: TopologyGraph,
  runtime: TaskRuntimeState
): string | null {
  for (const unitId of graph.unitIds) {
    const state = runtime.schedulerUnits[unitId];
    if (!state) {
      continue;
    }
    if (state.status === 'COMPLETE' || state.status === 'FAILED' || state.status === 'SKIPPED') {
      continue;
    }
    if (allDependenciesSatisfied(runtime, unitId, graph)) {
      return unitId;
    }
  }
  return null;
}

export function collectDownstreamUnitIdsFromTopology(graph: TopologyGraph, startUnitId: string): string[] {
  const visited = new Set<string>();
  const queue = [...(graph.dependentsByUnitId[startUnitId] ?? [])];

  while (queue.length > 0) {
    const unitId = queue.shift()!;
    if (visited.has(unitId)) {
      continue;
    }
    visited.add(unitId);
    queue.push(...(graph.dependentsByUnitId[unitId] ?? []));
  }

  return Array.from(visited);
}
