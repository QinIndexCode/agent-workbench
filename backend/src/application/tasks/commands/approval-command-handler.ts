import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { resolveToolApprovalRecord } from '../../../foundation/tools/approval-resolution';
import { ResolveApprovalInput, TaskActionResponse } from '../types';
import { TaskApprovalCommandHandler, TaskCommandHandlerServices } from './command-handler-types';

export class ApprovalCommandHandler implements TaskApprovalCommandHandler {
  constructor(private readonly services: TaskCommandHandlerServices) {}

  async resolveToolApproval(input: ResolveApprovalInput): Promise<TaskActionResponse> {
    const runtimeRecord = await this.services.records.loadRuntimeRecord(input.taskId);
    const approvals = await this.services.foundation.approvals.list(input.taskId);
    const existing = approvals
      .filter(record => record.invocationId === input.invocationId)
      .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt))[0];
    if (!existing) {
      throw new Error(`backend_new task error: approval for invocation "${input.invocationId}" was not found.`);
    }

    const resolved = resolveToolApprovalRecord(existing, {
      status: input.status,
      grantedBy: input.grantedBy,
      reason: input.reason,
      metadata: input.metadata
    });
    await this.services.foundation.approvals.append(resolved);
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: resolved.correlationId,
        sessionId: resolved.sessionId,
        turnId: resolved.turnId,
        taskId: resolved.taskId,
        unitId: resolved.unitId,
        checkpointId: resolved.checkpointId,
        type: 'TOOL_APPROVAL_RESOLVED',
        payload: {
          invocationId: resolved.invocationId,
          approvalId: resolved.approvalId,
          status: resolved.status
        }
      })
    );
    const dispatch = await this.services.toolDispatch.dispatchReadyInvocations({
      taskId: input.taskId,
      sessionId: runtimeRecord.runtime.latestSessionId ?? resolved.sessionId,
      correlationId: runtimeRecord.runtime.latestCorrelationId ?? resolved.correlationId,
      turnId: runtimeRecord.runtime.latestTurnId ?? resolved.turnId,
      checkpointId: runtimeRecord.runtime.latestCheckpointId ?? resolved.checkpointId
    });
    const [latestInvocations, latestApprovals] = await Promise.all([
      this.services.foundation.toolInvocations.listLatest(input.taskId),
      this.services.foundation.approvals.listLatest(input.taskId)
    ]);
    const reconciledRuntime = this.services.records.reconcileRuntimeToolingState({
      runtime: runtimeRecord.runtime,
      invocations: latestInvocations,
      approvals: latestApprovals
    });
    let nextRuntime = this.services.records.reconcileRuntimeCorrectionState({
      definition: runtimeRecord.definition,
      runtime: reconciledRuntime,
      invocations: latestInvocations,
      approvals: latestApprovals
    });
    nextRuntime = await this.services.records.reconcileResolvedApprovalTurn({
      taskId: input.taskId,
      definition: runtimeRecord.definition,
      runtime: nextRuntime,
      activeProviderId: runtimeRecord.activeProviderId,
      invocations: latestInvocations,
      approvals: latestApprovals
    });
    if (nextRuntime !== runtimeRecord.runtime) {
      await this.services.records.saveTaskRuntimeRecord({
        definition: runtimeRecord.definition,
        runtime: nextRuntime,
        activeProviderId: runtimeRecord.activeProviderId
      });
    }
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: runtimeRecord.runtime.latestCorrelationId ?? resolved.correlationId,
        sessionId: runtimeRecord.runtime.latestSessionId ?? resolved.sessionId,
        turnId: runtimeRecord.runtime.latestTurnId ?? resolved.turnId,
        taskId: input.taskId,
        unitId: runtimeRecord.runtime.currentUnitId,
        checkpointId: runtimeRecord.runtime.latestCheckpointId,
        type: 'TOOL_DISPATCH_REVIEWED',
        payload: dispatch
      })
    );

    return {
      command: this.services.records.createCommandResult(
        input.taskId,
        nextRuntime.lifecycleStatus,
        'Tool approval resolved.'
      ),
      task: await this.services.queries.getTask(input.taskId)
    };
  }
}
