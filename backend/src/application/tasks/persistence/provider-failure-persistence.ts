import { TaskRuntimeState } from '../../../domain/contracts/types';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { TaskTurnRuntimeControl } from '../control/task-turn-runtime-control';
import { TaskProjectionPersistence } from './task-projection-persistence';
import { ProviderFailurePersistenceInput } from './turn-persistence-types';
import { RuntimeCheckpointPersistence } from './runtime-checkpoint-persistence';
import { runWorkspaceHooks } from '../../runtime/workspace-hook-runner';

export class ProviderFailurePersistence {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly runtimeControl: TaskTurnRuntimeControl,
    private readonly projectionPersistence: TaskProjectionPersistence,
    private readonly checkpointPersistence: RuntimeCheckpointPersistence
  ) {}

  async persist(params: ProviderFailurePersistenceInput): Promise<void> {
    const failedRuntime: TaskRuntimeState = {
      ...params.runtime,
      lifecycleStatus: 'FAILED',
      engineStatus: 'FAILED',
      currentUnitId: params.currentUnitId,
      pendingCorrection: 'AWAITING_BLOCKER_EXPLANATION',
      lastError: params.error.message,
      latestSessionId: params.sessionId,
      latestCorrelationId: params.correlationId,
      latestTurnId: params.turnId,
      latestCheckpointId: params.checkpointId,
      selectedProviderId: params.providerId,
      updatedAt: Date.now()
    };

    await this.foundation.logs.recordTrace({
      timestamp: Date.now(),
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      action: 'provider_failed',
      details: {
        providerId: params.providerId,
        error: params.error.message,
        providerFailureKind: params.error.kind,
        providerFailureCategory: params.error.category,
        providerFailureStatusCode: params.error.statusCode,
        providerFailureRetryable: params.error.retryable,
        providerFailureTimeoutOrigin: params.error.timeoutOrigin,
        providerFailureElapsedMs: params.error.elapsedMs,
        providerFailureRequestTimeoutMs: params.error.requestTimeoutMs,
        providerFailureRetryAttempt: params.error.retryAttempt,
        providerRequestRawContextMessageCount: params.requestContext?.rawContextMessageCount ?? null,
        providerRequestRetainedContextMessageCount: params.requestContext?.retainedContextMessageCount ?? null,
        providerRequestToolMessageCount: params.requestContext?.toolMessageCount ?? null,
        providerRequestGatedContextCharacters: params.requestContext?.gatedContextCharacters ?? null,
        providerRequestMessageCount: params.requestContext?.providerMessageCount ?? null,
        providerRequestEstimatedPromptCharacters: params.requestContext?.estimatedPromptCharacters ?? null
      }
    });
    await this.foundation.logs.recordAudit({
      timestamp: Date.now(),
      severity: 'ERROR',
      event: 'provider_failed',
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      details: {
        providerId: params.providerId,
        error: params.error.message,
        kind: params.error.kind,
        category: params.error.category,
        statusCode: params.error.statusCode,
        retryable: params.error.retryable,
        timeoutOrigin: params.error.timeoutOrigin,
        elapsedMs: params.error.elapsedMs,
        requestTimeoutMs: params.error.requestTimeoutMs,
        retryAttempt: params.error.retryAttempt,
        requestContext: params.requestContext ?? null
      }
    });
    await this.checkpointPersistence.persist({
      taskId: params.taskId,
      definition: params.definition,
      runtime: failedRuntime,
      activeProviderId: params.providerId,
      correlationId: params.correlationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      unitId: params.currentUnitId
    });
    await this.projectionPersistence.persistProviderFailureProjection({
      ...params,
      runtime: failedRuntime
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'TASK_FAILED',
        payload: {
          taskId: params.taskId,
          error: params.error.message,
          kind: params.error.kind,
          category: params.error.category,
          statusCode: params.error.statusCode,
          retryable: params.error.retryable,
          providerId: params.providerId,
          timeoutOrigin: params.error.timeoutOrigin,
          elapsedMs: params.error.elapsedMs,
          requestTimeoutMs: params.error.requestTimeoutMs,
          retryAttempt: params.error.retryAttempt,
          requestContext: params.requestContext ?? null
        }
      })
    );
    await runWorkspaceHooks({
      foundation: this.foundation,
      event: 'provider.failure',
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      metadata: {
        providerId: params.providerId,
        providerFailureCategory: params.error.category,
        providerFailureKind: params.error.kind
      }
    });
    await runWorkspaceHooks({
      foundation: this.foundation,
      event: 'turn.stop',
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      metadata: {
        lifecycleStatus: 'FAILED',
        providerId: params.providerId
      }
    });
  }
}
