import crypto from 'node:crypto';
import { ExecutionProfileId, TaskDefinition } from '../../domain/contracts/types';
import { createTopologyGraph, validateTaskDefinitionPreflight } from '../../domain/runtime/topology-graph';
import { normalizeTaskArtifactRouting } from './artifact-routing';
import { withTaskWorkingDirectoryMetadata } from './task-working-directory';
import { SubmitTaskInput } from './types';

function createTaskId(): string {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureUnits(units: TaskDefinition['units']): void {
  if (units.length === 0) {
    throw new Error('backend_new task error: at least one unit is required.');
  }
}

function inferExecutionProfileId(params: {
  definition: TaskDefinition;
  unitId: string;
}): ExecutionProfileId {
  const unit = params.definition.units.find((entry) => entry.id === params.unitId);
  if (!unit) {
    return 'analyze';
  }
  const topology = createTopologyGraph(params.definition);
  const unitText = [unit.role, unit.goal, unit.taskScope]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
  const dependentCount = topology.dependentsByUnitId[unit.id]?.length ?? 0;
  const hasDependencies = unit.dependencies.length > 0;
  const isRoot = unit.dependencies.length === 0;
  const isLeaf = dependentCount === 0;
  const verifyHints = /(verify|validation|validate|validator|check|confirm|audit|review|test|qa|consolidat|merge|final)/;
  const implementHints = /(implement|build|write|create|fix|execute|execution|refactor|change|artifact|patch|apply|generate)/;
  const analyzeHints = /(analy|requirement|risk|research|discovery|plan|planner|design|scope|assess|brief)/;

  if (isLeaf && (verifyHints.test(unitText) || hasDependencies)) {
    return 'verify';
  }
  if (implementHints.test(unitText)) {
    return 'implement';
  }
  if (hasDependencies && !isLeaf) {
    return 'implement';
  }
  if (analyzeHints.test(unitText) || isRoot) {
    return 'analyze';
  }
  return isLeaf ? 'verify' : 'analyze';
}

function normalizeTaskDefinitionProfiles(definition: TaskDefinition): TaskDefinition {
  const normalizedDefinition: TaskDefinition = {
    ...definition,
    units: definition.units.map((unit) => ({
      ...unit,
      delegationContract: unit.delegationContract
        ? {
          ...unit.delegationContract,
          allowedToolIds: unit.delegationContract.allowedToolIds
            ? [...unit.delegationContract.allowedToolIds]
            : undefined
        }
        : undefined,
      dependencies: [...unit.dependencies]
    }))
  };

  normalizedDefinition.units = normalizedDefinition.units.map((unit) => ({
    ...unit,
    executionProfileId: unit.executionProfileId ?? inferExecutionProfileId({
      definition: normalizedDefinition,
      unitId: unit.id
    })
  }));

  return normalizedDefinition;
}

export function createTaskDefinition(input: SubmitTaskInput): TaskDefinition {
  ensureUnits(input.units);
  const taskId = input.taskId?.trim() || createTaskId();
  if (!input.title.trim()) {
    throw new Error('backend_new task error: title must not be empty.');
  }
  if (!input.intent.trim()) {
    throw new Error('backend_new task error: intent must not be empty.');
  }
  const definition = normalizeTaskDefinitionProfiles({
    taskId,
    title: input.title.trim(),
    intent: input.intent.trim(),
    units: input.units.map(unit => ({
      ...unit,
      qualityProfileId: unit.qualityProfileId ?? input.defaultQualityProfileId,
      delegationContract: unit.delegationContract
        ? {
          ...unit.delegationContract,
          allowedToolIds: unit.delegationContract.allowedToolIds
            ? [...unit.delegationContract.allowedToolIds]
            : undefined
        }
        : undefined,
      dependencies: [...unit.dependencies]
    })),
    preferredProviderId: input.preferredProviderId ?? null,
    createdAt: Date.now(),
    metadata: normalizeTaskArtifactRouting({
      pathPolicy: input.pathPolicy,
      preferredArtifactDir: input.preferredArtifactDir,
      metadata: withTaskWorkingDirectoryMetadata({
        workingDirectory: input.workingDirectory,
        metadata: input.metadata
      })
    })
  });
  const validation = validateTaskDefinitionPreflight(definition);
  if (!validation.ok) {
    throw new Error(`backend_new task error: invalid topology or unit contract. ${validation.issues.map((issue) => issue.message).join(' ')}`);
  }
  return definition;
}
