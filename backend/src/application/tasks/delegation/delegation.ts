import { BackendNewConfig } from '../../../foundation/config/types';
import { TaskRuntimeRecord } from '../../../foundation/repository/types';
import { AgentUnit, TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { deriveTaskArtifactRoutingSummary } from '../artifact-routing';

export const DELEGATE_SUBTASK_TOOL_ID = 'delegate-subtask';
export const DELEGATE_SUBTASK_TOOL_NAME = 'delegate_subtask';

export interface TaskDelegationConfig {
  enabled: boolean;
  maxDepth: number;
  maxActiveChildrenPerTask: number;
}

export interface TaskDelegationMetadata {
  parentTaskId: string;
  parentUnitId: string | null;
  depth: number;
  allowedToolIds: string[];
  inheritedProviderId: string | null;
  artifactPolicy: 'workspace_only';
  title: string;
  role: string;
  goal: string;
  taskScope: string | null;
  successCriteria: string | null;
}

export interface TaskDelegationEligibility {
  depth: number;
  delegationEnabled: boolean;
  canDelegate: boolean;
  reason: string;
}

export interface RequiredDelegationContract {
  title: string;
  role: string;
  goal: string;
  taskScope: string | null;
  outputContract: string;
  allowedToolIds: string[];
  successCriteria: string | null;
}

export function isDelegationRequiredForUnit(params: {
  definition: TaskDefinition;
  unitId: string | null;
}): boolean {
  if (!params.unitId) {
    return false;
  }
  return params.definition.units.some((unit) => unit.id === params.unitId && unit.delegationRequired === true);
}

export function hasMissingRequiredDelegation(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
}): boolean {
  const currentUnitId = params.runtime.currentUnitId;
  if (!isDelegationRequiredForUnit({
    definition: params.definition,
    unitId: currentUnitId
  })) {
    return false;
  }
  return params.runtime.contractDiagnostics?.lastAcceptanceFailureCategory === 'required_delegation_missing'
    || params.runtime.contractDiagnostics?.lastAcceptanceIssueCodes.includes('required_delegation_missing')
    || params.runtime.contractDiagnostics?.lastPendingCorrectionKind === 'AWAITING_TOOL_ACTION'
      && params.runtime.contractDiagnostics?.lastAcceptanceIssueMessages.some((message) => /delegate_subtask|required delegation/i.test(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function toSingleLineJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '{"summary":"string"}';
  }
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

export function getDelegationConfig(config: BackendNewConfig): TaskDelegationConfig {
  return {
    enabled: config.runtime.delegation.enabled,
    maxDepth: config.runtime.delegation.maxDepth,
    maxActiveChildrenPerTask: config.runtime.delegation.maxActiveChildrenPerTask
  };
}

export function extractDelegationMetadata(definition: Pick<TaskDefinition, 'metadata'>): TaskDelegationMetadata | null {
  const metadata = isRecord(definition.metadata) ? definition.metadata : null;
  const delegation = metadata && isRecord(metadata.delegation) ? metadata.delegation : null;
  if (!delegation) {
    return null;
  }

  const parentTaskId = toTrimmedString(delegation.parentTaskId);
  if (!parentTaskId) {
    return null;
  }

  const depth = typeof delegation.depth === 'number' && Number.isFinite(delegation.depth)
    ? Math.max(0, Math.trunc(delegation.depth))
    : 1;

  return {
    parentTaskId,
    parentUnitId: toTrimmedString(delegation.parentUnitId),
    depth,
    allowedToolIds: toStringArray(delegation.allowedToolIds),
    inheritedProviderId: toTrimmedString(delegation.inheritedProviderId),
    artifactPolicy: 'workspace_only',
    title: toTrimmedString(delegation.title) ?? 'Delegated subtask',
    role: toTrimmedString(delegation.role) ?? 'SubSccAgent',
    goal: toTrimmedString(delegation.goal) ?? 'Complete the delegated subtask.',
    taskScope: toTrimmedString(delegation.taskScope),
    successCriteria: toTrimmedString(delegation.successCriteria)
  };
}

export function isDelegatedChildDefinition(definition: Pick<TaskDefinition, 'metadata'>): boolean {
  return Boolean(extractDelegationMetadata(definition));
}

export function getDelegatedChildrenForParent(
  runtimes: TaskRuntimeRecord[],
  parentTaskId: string
): TaskRuntimeRecord[] {
  return runtimes
    .filter((record) => extractDelegationMetadata(record.definition)?.parentTaskId === parentTaskId)
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

export function getActiveDelegatedChildrenForParent(
  runtimes: TaskRuntimeRecord[],
  parentTaskId: string
): TaskRuntimeRecord[] {
  return getDelegatedChildrenForParent(runtimes, parentTaskId)
    .filter((record) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.runtime.lifecycleStatus));
}

export function shouldHideDelegatedChildFromTopLevel(definition: Pick<TaskDefinition, 'metadata'>): boolean {
  return isDelegatedChildDefinition(definition);
}

export function buildDelegationEligibility(params: {
  config: BackendNewConfig;
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  pendingApprovalCount: number;
  hasArtifactDestinationBlocker: boolean;
  hasCorrectionLoopBlocker: boolean;
  hasRecoveryBlocker: boolean;
  activeChildCount: number;
}): TaskDelegationEligibility {
  const delegationConfig = getDelegationConfig(params.config);
  const currentUnit = params.runtime.currentUnitId
    ? params.definition.units.find((unit) => unit.id === params.runtime.currentUnitId) ?? null
    : null;
  const delegationMetadata = extractDelegationMetadata(params.definition);
  const depth = delegationMetadata?.depth ?? 0;

  if (!delegationConfig.enabled) {
    return {
      depth,
      delegationEnabled: false,
      canDelegate: false,
      reason: 'Delegated sub-agents are disabled in runtime settings.'
    };
  }

  if (depth >= delegationConfig.maxDepth || delegationMetadata) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'This task is already a delegated child and cannot delegate again.'
    };
  }

  if (params.runtime.lifecycleStatus !== 'RUNNING') {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: `Delegation is only available while the parent task is running, not ${params.runtime.lifecycleStatus.toLowerCase()}.`
    };
  }

  if (!currentUnit || currentUnit.executionProfileId !== 'implement') {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'Delegation is only available for implement-profile units.'
    };
  }

  if (params.pendingApprovalCount > 0) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'Resolve pending approvals before delegating additional work.'
    };
  }

  if (params.hasArtifactDestinationBlocker) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'Choose or apply the current artifact destination before delegating more work.'
    };
  }

  if (params.hasCorrectionLoopBlocker) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'The task is in a non-convergent correction loop and needs operator guidance first.'
    };
  }

  if (params.hasRecoveryBlocker) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'The parent task is already in a recovery or failure state.'
    };
  }

  if (params.activeChildCount >= delegationConfig.maxActiveChildrenPerTask) {
    return {
      depth,
      delegationEnabled: true,
      canDelegate: false,
      reason: 'An active delegated child task is already running for this thread.'
    };
  }

  return {
    depth,
    delegationEnabled: true,
    canDelegate: true,
    reason: 'Delegation is available for this implement step.'
  };
}

export function filterAllowedToolIdsForDelegation(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  config: BackendNewConfig;
  pendingApprovalCount: number;
  hasRecoveryBlocker: boolean;
  commands: import('../../../foundation/repository/types').OperatorCommandRecord[];
  invocations: import('../../../foundation/repository/types').ToolInvocationRecord[];
  baseAllowedToolIds: string[] | null;
  activeChildCount?: number;
}): string[] | null {
  if (!params.baseAllowedToolIds) {
    return params.baseAllowedToolIds;
  }
  const delegationMetadata = extractDelegationMetadata(params.definition);
  const scopedAllowedToolIds = delegationMetadata?.allowedToolIds.length
    ? params.baseAllowedToolIds.filter((toolId) => delegationMetadata.allowedToolIds.includes(toolId))
    : [...params.baseAllowedToolIds];

  const artifactRouting = deriveTaskArtifactRoutingSummary({
    definition: params.definition,
    commands: params.commands,
    invocations: params.invocations
  });
  const eligibility = buildDelegationEligibility({
    config: params.config,
    definition: params.definition,
    runtime: params.runtime,
    pendingApprovalCount: params.pendingApprovalCount,
    hasArtifactDestinationBlocker: artifactRouting.needsExplicitDestination,
    hasCorrectionLoopBlocker: params.runtime.contractDiagnostics?.correctionLoopNonConvergent ?? false,
    hasRecoveryBlocker: params.hasRecoveryBlocker,
    activeChildCount: params.activeChildCount ?? 0
  });

  if (eligibility.canDelegate) {
    return delegationMetadata
      ? scopedAllowedToolIds.filter((toolId) => toolId !== DELEGATE_SUBTASK_TOOL_ID)
      : scopedAllowedToolIds;
  }

  return scopedAllowedToolIds.filter((toolId) => toolId !== DELEGATE_SUBTASK_TOOL_ID);
}

export function buildRequiredDelegationContract(params: {
  unit: AgentUnit | null;
  allowedToolIds: string[] | null;
}): RequiredDelegationContract | null {
  const unit = params.unit;
  if (!unit) {
    return null;
  }
  const contract = unit.delegationContract ?? {};
  const allowedToolIds = (contract.allowedToolIds?.length
    ? contract.allowedToolIds
    : params.allowedToolIds ?? [])
    .filter((toolId) => toolId !== DELEGATE_SUBTASK_TOOL_ID);
  return {
    title: toTrimmedString(contract.title) ?? 'Delegated subtask',
    role: toTrimmedString(contract.role) ?? 'SubSccAgent',
    goal: toTrimmedString(contract.goal) ?? unit.goal,
    taskScope: toTrimmedString(contract.taskScope) ?? toTrimmedString(unit.taskScope),
    outputContract: toSingleLineJson(toTrimmedString(contract.outputContract) ?? unit.outputContract?.trim() ?? '{"summary":"string"}'),
    allowedToolIds: [...new Set(allowedToolIds)],
    successCriteria: toTrimmedString(contract.successCriteria) ?? toTrimmedString(unit.exitCondition)
  };
}
