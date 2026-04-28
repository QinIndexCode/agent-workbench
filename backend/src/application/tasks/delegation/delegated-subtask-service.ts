import { TaskLifecycleService } from '../lifecycle/task-lifecycle-service';
import { TaskRecordService } from '../task-record-service';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createToolFailureResult, createToolSuccessResult } from '../../../foundation/tools/result-envelope';
import { ToolResultEnvelope } from '../../../foundation/tools/types';
import { evaluateToolExecutionPolicy } from '../../../foundation/tools/execution-policy';
import { deriveTaskArtifactRoutingSummary } from '../artifact-routing';
import {
  buildRequiredDelegationContract,
  buildDelegationEligibility,
  DELEGATE_SUBTASK_TOOL_ID,
  filterAllowedToolIdsForDelegation,
  getActiveDelegatedChildrenForParent
} from './delegation';
import { getExecutionProfile } from '../../runtime/execution-profiles';

interface DelegateSubtaskInput {
  title: string;
  role: string;
  goal: string;
  taskScope?: string | null;
  outputContract: string | Record<string, unknown>;
  allowedToolIds: string[];
  successCriteria?: string | null;
}

interface DelegateSubtaskDefaults {
  title?: string;
  role?: string;
  goal?: string;
  taskScope?: string | null;
  outputContract?: string;
  allowedToolIds?: string[];
  successCriteria?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`delegate_subtask requires a non-empty "${field}".`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAllowedToolIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('delegate_subtask requires "allowedToolIds" to be a non-empty array.');
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('delegate_subtask requires at least one allowed tool id.');
  }
  if (normalized.includes(DELEGATE_SUBTASK_TOOL_ID)) {
    throw new Error('delegate_subtask cannot grant delegate_subtask to a child task.');
  }
  return [...new Set(normalized)];
}

function normalizeOutputContract(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  throw new Error('delegate_subtask requires a non-empty "outputContract".');
}

function extractSummary(task: Awaited<ReturnType<TaskLifecycleService['continueTask']>>['task']): {
  summary: string | null;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
} {
  return {
    summary: task.completionSummary?.summary ?? task.latestVisibleOutput?.summary ?? task.diagnostics.lastError ?? null,
    artifactPaths: task.completionSummary?.artifactPaths ?? task.latestVisibleOutput?.artifactPaths ?? [],
    artifactDestinationPaths: task.completionSummary?.artifactDestinationPaths ?? task.latestVisibleOutput?.artifactDestinationPaths ?? [],
    artifactDestinationDir: task.completionSummary?.artifactDestinationDir ?? task.latestVisibleOutput?.artifactDestinationDir ?? null
  };
}

function shouldAutoContinue(task: Awaited<ReturnType<TaskLifecycleService['continueTask']>>['task']): boolean {
  if (task.runtime.lifecycleStatus !== 'RUNNING') {
    return false;
  }
  if (task.pendingApprovals.length > 0) {
    return false;
  }
  if (task.primaryAction?.kind === 'use_recommended_path' || task.primaryAction?.kind === 'choose_custom_path') {
    return false;
  }
  return task.primaryAction?.kind === 'continue_thread' || task.primaryAction?.kind === 'wait';
}

function findPermissionBlockedToolIds(params: {
  foundation: BackendNewFoundation;
  allowedToolIds: string[];
}): Array<{ toolId: string; reason: string }> {
  const blocked: Array<{ toolId: string; reason: string }> = [];
  for (const toolId of params.allowedToolIds) {
    const tool = params.foundation.extensions.findTool(toolId);
    if (!tool) {
      blocked.push({
        toolId,
        reason: `Tool "${toolId}" is not registered in the current extension catalog.`
      });
      continue;
    }
    const policy = evaluateToolExecutionPolicy({
      config: params.foundation.config,
      tool
    });
    if (policy.decision !== 'ALLOW') {
      blocked.push({
        toolId,
        reason: policy.reason
      });
    }
  }
  return blocked;
}

export class DelegatedSubtaskService {
  private readonly lifecycle: TaskLifecycleService;
  private readonly records: TaskRecordService;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.lifecycle = new TaskLifecycleService(foundation);
    this.records = new TaskRecordService(foundation);
  }

  private parseInput(argumentsRecord: Record<string, unknown>, defaults: DelegateSubtaskDefaults = {}): DelegateSubtaskInput {
    const outputContractValue = argumentsRecord.outputContract ?? defaults.outputContract;
    if (!(typeof outputContractValue === 'string' || isRecord(outputContractValue))) {
      throw new Error('delegate_subtask requires "outputContract".');
    }
    return {
      title: normalizeString(argumentsRecord.title ?? defaults.title, 'title'),
      role: normalizeString(argumentsRecord.role ?? defaults.role, 'role'),
      goal: normalizeString(argumentsRecord.goal ?? defaults.goal, 'goal'),
      taskScope: normalizeOptionalString(argumentsRecord.taskScope ?? defaults.taskScope),
      outputContract: outputContractValue,
      allowedToolIds: normalizeAllowedToolIds(argumentsRecord.allowedToolIds ?? defaults.allowedToolIds),
      successCriteria: normalizeOptionalString(argumentsRecord.successCriteria ?? defaults.successCriteria)
    };
  }

  private async cancelChildTask(taskId: string, reason: string): Promise<void> {
    try {
      await this.lifecycle.submitCommand({
        taskId,
        type: 'CANCEL_TASK',
        reason,
        message: reason,
        metadata: {
          source: 'delegate_subtask'
        }
      });
    } catch {
      // Best-effort cleanup to avoid leaving inaccessible child tasks in top-level hidden state.
    }
  }

  async execute(params: {
    parentTaskId: string;
    parentUnitId: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolResultEnvelope> {
    try {
      const parentRecord = await this.records.loadRuntimeRecord(params.parentTaskId);
      const parentUnit = parentRecord.definition.units.find((unit) => unit.id === params.parentUnitId);
      if (!parentUnit) {
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: `delegate_subtask could not find parent unit "${params.parentUnitId}".`
        });
      }

      const [approvals, invocations, commands, runtimes] = await Promise.all([
        this.foundation.approvals.listLatest(params.parentTaskId),
        this.foundation.toolInvocations.listLatest(params.parentTaskId),
        this.foundation.commands.listLatest(params.parentTaskId),
        this.foundation.taskRuntimes.list()
      ]);
      const artifactRouting = deriveTaskArtifactRoutingSummary({
        definition: parentRecord.definition,
        invocations,
        commands
      });
      const eligibility = buildDelegationEligibility({
        config: this.foundation.config,
        definition: parentRecord.definition,
        runtime: parentRecord.runtime,
        pendingApprovalCount: approvals.filter((approval) => approval.status === 'PENDING').length,
        hasArtifactDestinationBlocker: artifactRouting.needsExplicitDestination,
        hasCorrectionLoopBlocker: parentRecord.runtime.contractDiagnostics?.correctionLoopNonConvergent ?? false,
        hasRecoveryBlocker: parentRecord.runtime.lifecycleStatus === 'FAILED'
          || parentRecord.runtime.lifecycleStatus === 'CANCELLED'
          || Boolean(parentRecord.runtime.lastError),
        activeChildCount: getActiveDelegatedChildrenForParent(runtimes, params.parentTaskId).length
      });

      if (!eligibility.canDelegate) {
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: eligibility.reason
        });
      }

      const allowedParentToolIds = filterAllowedToolIdsForDelegation({
        definition: parentRecord.definition,
        runtime: parentRecord.runtime,
        config: this.foundation.config,
        pendingApprovalCount: approvals.filter((approval) => approval.status === 'PENDING').length,
        hasRecoveryBlocker: parentRecord.runtime.lifecycleStatus === 'FAILED'
          || parentRecord.runtime.lifecycleStatus === 'CANCELLED'
          || Boolean(parentRecord.runtime.lastError),
        commands,
        invocations,
        baseAllowedToolIds: getExecutionProfile(parentUnit.executionProfileId)?.allowedToolIds ?? null,
        activeChildCount: getActiveDelegatedChildrenForParent(runtimes, params.parentTaskId).length
      }) ?? [];
      const defaultContract = buildRequiredDelegationContract({
        unit: parentUnit,
        allowedToolIds: allowedParentToolIds
      });
      const input = this.parseInput(params.arguments, defaultContract ?? {});

      if (!input.allowedToolIds.every((toolId) => allowedParentToolIds.includes(toolId))) {
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: 'delegate_subtask requested tools outside the parent unit boundary.'
        });
      }

      const permissionBlockedToolIds = findPermissionBlockedToolIds({
        foundation: this.foundation,
        allowedToolIds: input.allowedToolIds
      });
      if (permissionBlockedToolIds.length > 0) {
        const blockedTool = permissionBlockedToolIds[0];
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: `delegate_subtask cannot launch a child task with "${blockedTool.toolId}" under the current parent permission boundary. ${blockedTool.reason}`,
          metadata: {
            blockedToolIds: permissionBlockedToolIds.map((entry) => entry.toolId),
            permissionMode: this.foundation.config.tools.permissionMode
          }
        });
      }

      const childSubmit = await this.lifecycle.submitTask({
        title: input.title,
        intent: input.goal,
        preferredProviderId: parentRecord.activeProviderId ?? parentRecord.definition.preferredProviderId ?? null,
        pathPolicy: 'task_workspace',
        metadata: {
          delegation: {
            parentTaskId: parentRecord.taskId,
            parentUnitId: params.parentUnitId,
            depth: 1,
            allowedToolIds: input.allowedToolIds,
            inheritedProviderId: parentRecord.activeProviderId ?? parentRecord.definition.preferredProviderId ?? null,
            artifactPolicy: 'workspace_only',
            title: input.title,
            role: input.role,
            goal: input.goal,
            taskScope: input.taskScope,
            successCriteria: input.successCriteria
          }
        },
        units: [
          {
            id: 'SUBAGENT-001',
            role: input.role,
            goal: input.goal,
            taskScope: input.taskScope ?? undefined,
            outputContract: normalizeOutputContract(input.outputContract),
            exitCondition: input.successCriteria ?? undefined,
            executionProfileId: 'implement',
            dependencies: []
          }
        ]
      });

      const childTaskId = childSubmit.command.taskId;
      let childResult = await this.lifecycle.startTask({
        taskId: childTaskId,
        actor: 'SubSccAgent',
        userMessage: `Delegated subtask: ${input.goal}`
      });

      let guardIterations = 0;
      while (shouldAutoContinue(childResult.task) && guardIterations < 4) {
        guardIterations += 1;
        childResult = await this.lifecycle.continueTask({
          taskId: childTaskId,
          actor: 'SubSccAgent',
          userMessage: 'Continue the delegated subtask, stay within the scoped contract, and return the validated result.'
        });
      }

      if (childResult.task.runtime.lifecycleStatus !== 'COMPLETED') {
        await this.cancelChildTask(
          childTaskId,
          'Delegated child did not converge within the controlled SubSccAgent boundary.'
        );
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: 'Delegated child task did not converge within the controlled boundary.',
          metadata: {
            childTaskId,
            lifecycleStatus: childResult.task.runtime.lifecycleStatus
          }
        });
      }

      const summary = extractSummary(childResult.task);
      return createToolSuccessResult({
        output: {
          childTaskId,
          title: input.title,
          status: childResult.task.runtime.lifecycleStatus,
          summary: summary.summary,
          artifactPaths: summary.artifactPaths,
          artifactDestinationPaths: summary.artifactDestinationPaths,
          artifactDestinationDir: summary.artifactDestinationDir,
          workspaceOnly: true
        },
        message: summary.summary ?? `Delegated subtask "${input.title}" completed.`,
        metadata: {
          childTaskId,
          parentTaskId: params.parentTaskId,
          delegated: true
        }
      });
    } catch (error) {
      return createToolFailureResult({
        kind: 'EXECUTION',
        message: error instanceof Error ? error.message : 'Delegated subtask execution failed.'
      });
    }
  }
}
