import fs from 'node:fs/promises';
import path from 'node:path';
import { createConversationMessage } from '../../../foundation/conversation/create-message';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { applyLifecycleTransition, selectNextReadyUnit } from '../../../domain/runtime/state-transition-applier';
import { ToolInvocationRecord } from '../../../foundation/repository/types';
import { SubmitTaskCommandInput, TaskActionResponse } from '../types';
import { TaskCommandHandlerServices, TaskOperatorInteractionHandler } from './command-handler-types';
import {
  deriveTaskArtifactRoutingSummary,
  getTaskArtifactRoutingSettings,
  normalizeArtifactDir,
  normalizeTaskArtifactRouting,
  resolveProjectRelativeDestination
} from '../artifact-routing';
import { getActiveDelegatedChildrenForParent, hasMissingRequiredDelegation } from '../delegation/delegation';

export class OperatorCommandHandler implements TaskOperatorInteractionHandler {
  constructor(private readonly services: TaskCommandHandlerServices) {}

  private collectCompletedUnitIds(runtime: TaskRuntimeState): string[] {
    const completed = new Set(runtime.completedUnits);
    for (const unit of Object.values(runtime.schedulerUnits)) {
      if (unit.status === 'COMPLETE') {
        completed.add(unit.unitId);
      }
    }
    return [...completed];
  }

  private hasSuccessfulWriteEvidenceForUnit(
    invocations: ToolInvocationRecord[],
    unitId: string | null
  ): boolean {
    if (!unitId) {
      return false;
    }
    return invocations.some((invocation) => (
      invocation.unitId === unitId
      && invocation.status === 'SUCCEEDED'
      && ['write_file', 'create_folder', 'run_command'].includes(invocation.toolId.trim().toLowerCase().replace(/-/g, '_'))
    ));
  }

  private resolveProjectPath(relativePath: string): string {
    const normalized = normalizeArtifactDir(relativePath);
    if (!normalized) {
      throw new Error('backend_new artifact routing error: destination must be a safe project-relative path.');
    }
    const resolved = path.resolve(this.services.foundation.cwd, normalized);
    const projectRoot = path.resolve(this.services.foundation.cwd);
    const prefix = `${projectRoot}${path.sep}`;
    if (resolved !== projectRoot && !resolved.startsWith(prefix)) {
      throw new Error(`backend_new artifact routing error: destination escapes project root: ${relativePath}`);
    }
    return resolved;
  }

  private async copyArtifact(sourcePath: string, destinationPath: string): Promise<void> {
    const stats = await fs.stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`backend_new artifact routing error: source artifact is not a file: ${sourcePath}`);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }

  private canAutoCompleteAfterArtifactApply(params: {
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    invocations: ToolInvocationRecord[];
    resultStatus: 'APPLIED' | 'CONFLICT' | 'FAILED';
    pendingApprovalCount: number;
    hasActiveInvocation: boolean;
    activeChildCount: number;
  }): boolean {
    if (params.resultStatus !== 'APPLIED') {
      return false;
    }
    if (params.runtime.lifecycleStatus !== 'RUNNING') {
      return false;
    }
    if (params.pendingApprovalCount > 0 || params.hasActiveInvocation || params.activeChildCount > 0) {
      return false;
    }
    if (hasMissingRequiredDelegation({
      definition: params.definition,
      runtime: params.runtime
    })) {
      return false;
    }
    if (params.runtime.pendingCorrection !== 'NONE') {
      return false;
    }
    if ((params.runtime.contractDiagnostics?.correctionLoopNonConvergent ?? false) || params.runtime.lastError) {
      return false;
    }
    if (params.runtime.pendingOperatorInputs.length > 0) {
      return false;
    }
    if (params.runtime.awaitingToolDispatch.length > 0 || params.runtime.awaitingApprovalInvocations.length > 0) {
      return false;
    }
    const completedUnits = new Set(this.collectCompletedUnitIds(params.runtime));
    const totalUnitCount = params.definition.units.length;
    if (completedUnits.size >= totalUnitCount) {
      return true;
    }
    const currentUnitId = params.runtime.currentUnitId;
    if (!this.hasSuccessfulWriteEvidenceForUnit(params.invocations, currentUnitId)) {
      return false;
    }
    if (!currentUnitId || !params.runtime.schedulerUnits[currentUnitId]) {
      return false;
    }
    const simulatedRuntime: TaskRuntimeState = {
      ...params.runtime,
      schedulerUnits: {
        ...params.runtime.schedulerUnits,
        [currentUnitId]: {
          ...params.runtime.schedulerUnits[currentUnitId],
          status: 'COMPLETE',
          invalidOutputErrors: []
        }
      },
      invalidOutputUnits: {
        ...params.runtime.invalidOutputUnits,
        [currentUnitId]: []
      }
    };
    const nextReadyUnitId = selectNextReadyUnit(params.definition, simulatedRuntime);
    return !nextReadyUnitId;
  }

  private buildAutoCompletedRuntimeAfterArtifactApply(params: {
    runtime: TaskRuntimeState;
    now: number;
  }): TaskRuntimeState {
    const currentUnitId = params.runtime.currentUnitId;
    const schedulerUnits = { ...params.runtime.schedulerUnits };
    if (currentUnitId && schedulerUnits[currentUnitId]) {
      schedulerUnits[currentUnitId] = {
        ...schedulerUnits[currentUnitId],
        status: 'COMPLETE',
        invalidOutputErrors: []
      };
    }

    const invalidOutputUnits = { ...params.runtime.invalidOutputUnits };
    if (currentUnitId) {
      delete invalidOutputUnits[currentUnitId];
    }

    const completedUnits = this.collectCompletedUnitIds({
      ...params.runtime,
      schedulerUnits,
      currentUnitId
    });

    const contractDiagnostics = params.runtime.contractDiagnostics
      ? {
        ...params.runtime.contractDiagnostics,
        topology: {
          ...params.runtime.contractDiagnostics.topology,
          currentStageIndex: null,
          batchGroupingHint: null,
          entryUnitIds: [],
          exitUnitIds: []
        },
        currentUnit: {
          ...params.runtime.contractDiagnostics.currentUnit,
          unitId: null,
          permissionLevel: null,
          requiresToolEvidence: false
        },
        lastAcceptanceFailureCategory: null,
        lastAcceptanceIssueCodes: [],
        lastAcceptanceIssueMessages: [],
        lastPendingCorrectionKind: null,
        correctionLoopNonConvergent: false
      }
      : params.runtime.contractDiagnostics;

    const planner: TaskRuntimeState['planner'] = params.runtime.planner
      ? {
        ...params.runtime.planner,
        executionPhase: 'IDLE' as const,
        currentStageIndex: null,
        currentStageUnitIds: [],
        readyStageUnitIds: [],
        providerBatchCount: 0,
        toolBatchCount: 0,
        providerBatchHints: [],
        toolBatchHints: [],
        batchGroupingHints: [],
        contractBlockingReasons: [],
        fallbackReasons: [],
        blockingReason: null
      }
      : params.runtime.planner;

    const transitioned = applyLifecycleTransition({
      ...params.runtime,
      schedulerUnits,
      invalidOutputUnits,
      completedUnits,
      currentUnitId: null,
      pendingCorrection: 'NONE',
      awaitingToolDispatch: [],
      awaitingApprovalInvocations: [],
      activeStage: null,
      pendingOperatorInputs: [],
      contractDiagnostics,
      planner,
      consolidationState: {
        ...params.runtime.consolidationState,
        status: 'COMPLETED',
        lastCompletedAt: params.now,
        lastResult: 'COMPLETED'
      },
      executionLease: {
        ...params.runtime.executionLease,
        active: false,
        phase: 'COMPLETED'
      },
      safePoint: {
        stage: 'IDLE',
        reachedAt: params.now,
        interruptible: true
      },
      lastError: null,
      updatedAt: params.now
    }, 'COMPLETED', params.now);

    return {
      ...transitioned,
      engineStatus: 'COMPLETED',
      executionLease: {
        ...transitioned.executionLease,
        active: false,
        phase: 'COMPLETED'
      },
      safePoint: {
        stage: 'IDLE',
        reachedAt: params.now,
        interruptible: true
      }
    };
  }

  async sendOperatorMessage(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, ['SUBMITTED', 'RUNNING', 'PAUSED'], 'send operator message');
    const trimmed = input.message?.trim();
    if (!trimmed) {
      throw new Error('backend_new task error: operator message must not be empty.');
    }
    const operatorMessage = this.services.commands.createOperatorMessage({
      taskId: input.taskId,
      commandId,
      content: trimmed,
      metadata: {
        actor: input.actor ?? null
      }
    });
    await this.services.foundation.operatorMessages.append(operatorMessage);
    await this.services.foundation.conversations.append(
      createConversationMessage({
        taskId: input.taskId,
        role: 'user',
        content: trimmed,
        metadata: {
          source: 'operator_message',
          messageId: operatorMessage.messageId,
          actor: input.actor ?? null
        }
      })
    );
    const nextRuntime = {
      ...record.runtime,
      pendingOperatorInputs: [
        ...record.runtime.pendingOperatorInputs,
        {
          messageId: operatorMessage.messageId,
          commandId,
          content: trimmed,
          createdAt: operatorMessage.createdAt
        }
      ],
      updatedAt: Date.now()
    };
    await this.services.records.saveTaskRuntimeRecord({
      definition: record.definition,
      runtime: nextRuntime,
      activeProviderId: record.activeProviderId
    });
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${operatorMessage.messageId}`,
        sessionId: `sess_${operatorMessage.messageId}`,
        turnId: `turn_${operatorMessage.messageId}`,
        taskId: input.taskId,
        unitId: nextRuntime.currentUnitId,
        checkpointId: nextRuntime.latestCheckpointId,
        type: 'OPERATOR_MESSAGE_QUEUED',
        payload: {
          messageId: operatorMessage.messageId,
          guidanceId: operatorMessage.messageId,
          pendingOperatorInputCount: nextRuntime.pendingOperatorInputs.length
        }
      })
    );
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_guidance_${operatorMessage.messageId}`,
        sessionId: `sess_guidance_${operatorMessage.messageId}`,
        turnId: `turn_guidance_${operatorMessage.messageId}`,
        taskId: input.taskId,
        unitId: nextRuntime.currentUnitId,
        checkpointId: nextRuntime.latestCheckpointId,
        type: 'TASK_GUIDANCE_PENDING',
        payload: {
          guidanceId: operatorMessage.messageId,
          pendingGuidanceCount: nextRuntime.pendingOperatorInputs.length
        }
      })
    );
    return {
      command: this.services.records.createCommandResult(input.taskId, nextRuntime.lifecycleStatus, 'Operator message queued.'),
      task: await this.services.queries.getTask(input.taskId)
    };
  }

  async interruptTask(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, ['RUNNING', 'PAUSED'], 'interrupt task');
    const nextRuntime = {
      ...record.runtime,
      interrupt: {
        ...record.runtime.interrupt,
        interruptRequested: true,
        requestedAt: Date.now(),
        reason: input.reason ?? input.message ?? 'interrupt requested'
      },
      executionLease: {
        ...record.runtime.executionLease,
        phase: 'WAITING_SAFE_POINT' as const
      },
      updatedAt: Date.now()
    };
    await this.services.records.saveTaskRuntimeRecord({
      definition: record.definition,
      runtime: nextRuntime,
      activeProviderId: record.activeProviderId
    });
    const interruptRecord = this.services.commands.createInterruptRequest({
      taskId: input.taskId,
      commandId,
      reason: input.reason ?? input.message ?? 'interrupt requested',
      requestedBy: input.actor ?? null,
      metadata: {
        kind: 'interrupt'
      }
    });
    await this.services.foundation.interrupts.append(interruptRecord);
    const appliedImmediately = this.services.interrupts.requestInterrupt(input.taskId);
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${interruptRecord.interruptId}`,
        sessionId: `sess_${interruptRecord.interruptId}`,
        turnId: `turn_${interruptRecord.interruptId}`,
        taskId: input.taskId,
        unitId: nextRuntime.currentUnitId,
        checkpointId: nextRuntime.latestCheckpointId,
        type: 'INTERRUPT_REQUESTED',
        payload: {
          interruptId: interruptRecord.interruptId,
          appliedImmediately
        }
      })
    );
    return {
      command: this.services.records.createCommandResult(input.taskId, nextRuntime.lifecycleStatus, 'Interrupt requested.'),
      task: await this.services.queries.getTask(input.taskId)
    };
  }

  async applyArtifacts(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, ['RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'], 'apply artifacts');

    const [toolInvocations, commands, approvals, allRuntimes] = await Promise.all([
      this.services.foundation.toolInvocations.listLatest(input.taskId),
      this.services.foundation.commands.listLatest(input.taskId),
      this.services.foundation.approvals.listLatest(input.taskId),
      this.services.foundation.taskRuntimes.list()
    ]);
    const toolingReconciledRuntime = this.services.records.reconcileRuntimeToolingState({
      runtime: record.runtime,
      invocations: toolInvocations,
      approvals
    });
    const reconciledRuntime = this.services.records.reconcileRuntimeCorrectionState({
      definition: record.definition,
      runtime: toolingReconciledRuntime,
      invocations: toolInvocations,
      approvals
    });
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: record.definition,
      invocations: toolInvocations,
      commands
    });
    if (artifactRouting.artifactPaths.length === 0) {
      throw new Error('backend_new task error: no sandbox artifacts are available to apply.');
    }

    const requestedDir = normalizeArtifactDir(
      input.metadata?.destinationDir
      ?? input.metadata?.preferredArtifactDir
      ?? input.message
      ?? null
    );
    const settings = getTaskArtifactRoutingSettings(record.definition);
    const destinationDir = requestedDir
      ?? settings.preferredArtifactDir
      ?? artifactRouting.recommendedArtifactDir
      ?? null;
    if (!destinationDir) {
      throw new Error('backend_new task error: artifact apply requires a project-relative destination directory.');
    }

    const overwrite = input.metadata?.overwrite === true;
    const applied = [];
    const conflicts = [];
    const failed = [];
    for (const artifactPath of artifactRouting.artifactPaths) {
      try {
        const sourcePath = this.services.foundation.layout.resolveWorkspacePath(input.taskId, artifactPath);
        const destinationRelativePath = resolveProjectRelativeDestination({
          workspaceRelativePath: artifactPath,
          destinationDir
        });
        const destinationPath = this.resolveProjectPath(destinationRelativePath);
        const exists = await this.services.foundation.storage.exists(destinationPath);
        if (exists && !overwrite) {
          conflicts.push({
            source: artifactPath,
            destination: destinationRelativePath
          });
          continue;
        }
        await this.copyArtifact(sourcePath, destinationPath);
        applied.push({
          source: artifactPath,
          destination: destinationRelativePath
        });
      } catch (error) {
        failed.push({
          source: artifactPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const resultStatus = failed.length > 0
      ? 'FAILED'
      : conflicts.length > 0
        ? 'CONFLICT'
        : 'APPLIED';
    const resultMessage = resultStatus === 'APPLIED'
      ? `Applied ${applied.length} artifact(s) to ${destinationDir}.`
      : resultStatus === 'CONFLICT'
        ? `Applied ${applied.length} artifact(s) to ${destinationDir}, but ${conflicts.length} destination conflict(s) require operator review.`
        : `Artifact apply failed for ${failed.length} artifact(s) while targeting ${destinationDir}.`;

    const now = Date.now();
    const nextDefinition = {
      ...record.definition,
      metadata: normalizeTaskArtifactRouting({
        pathPolicy: 'project_relative',
        preferredArtifactDir: destinationDir,
        metadata: record.definition.metadata
      })
    };
    const pendingApprovalCount = approvals.filter((approval) => approval.status === 'PENDING').length;
    const hasActiveInvocation = toolInvocations.some((invocation) => (
      invocation.status === 'PLANNED'
      || invocation.status === 'RUNNING'
      || invocation.status === 'WAITING_APPROVAL'
    ));
    const activeChildCount = getActiveDelegatedChildrenForParent(allRuntimes, input.taskId).length;
    const autoFinished = this.canAutoCompleteAfterArtifactApply({
      definition: nextDefinition,
      runtime: reconciledRuntime,
      invocations: toolInvocations,
      resultStatus,
      pendingApprovalCount,
      hasActiveInvocation,
      activeChildCount
    });
    const nextRuntime = autoFinished
      ? this.buildAutoCompletedRuntimeAfterArtifactApply({
        runtime: reconciledRuntime,
        now
      })
      : {
        ...reconciledRuntime,
        updatedAt: now
      };
    await this.services.records.saveTaskRuntimeRecord({
      definition: nextDefinition,
      runtime: nextRuntime,
      activeProviderId: record.activeProviderId
    });
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_apply_artifacts_${commandId}`,
        sessionId: `sess_apply_artifacts_${commandId}`,
        turnId: `turn_apply_artifacts_${commandId}`,
        taskId: input.taskId,
        unitId: record.runtime.currentUnitId,
        checkpointId: record.runtime.latestCheckpointId,
        type: resultStatus === 'APPLIED' ? 'TASK_ARTIFACTS_APPLIED' : 'TASK_ARTIFACTS_APPLY_FAILED',
        payload: {
          destinationDir,
          applied,
          conflicts,
          failed,
          overwrite,
          actor: input.actor ?? null,
          autoFinished
        }
      })
    );
    if (autoFinished) {
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: `corr_apply_artifacts_complete_${commandId}`,
          sessionId: `sess_apply_artifacts_complete_${commandId}`,
          turnId: `turn_apply_artifacts_complete_${commandId}`,
          taskId: input.taskId,
          unitId: record.runtime.currentUnitId,
          checkpointId: record.runtime.latestCheckpointId,
          type: 'TASK_COMPLETED',
          payload: {
            taskId: input.taskId,
            autoFinished: true,
            reason: 'artifact_apply_safe_completion',
            destinationDir
          }
        })
      );
    }
    const commandLifecycleStatus = autoFinished ? nextRuntime.lifecycleStatus : record.runtime.lifecycleStatus;
    const commandMessage = autoFinished
      ? `${resultMessage} No further parent action was required, so the thread was completed automatically.`
      : resultMessage;
    return {
      command: this.services.records.createCommandResult(
        input.taskId,
        commandLifecycleStatus,
        commandMessage
      ),
      task: await this.services.queries.getTask(input.taskId),
      commandMetadata: {
        artifactApplyStatus: resultStatus,
        artifactApplyMessage: resultMessage,
        destinationDir,
        appliedCount: applied.length,
        conflictCount: conflicts.length,
        failedCount: failed.length,
        sourcePaths: artifactRouting.artifactPaths,
        appliedArtifacts: applied,
        conflicts,
        failures: failed,
        overwrite,
        autoFinished
      }
    };
  }
}
