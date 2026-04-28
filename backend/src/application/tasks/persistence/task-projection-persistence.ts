import { buildTaskProjection } from '../../../foundation/projection/projection-builder';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { NormalizedProviderFailure } from '../../adapters/providers/provider-client-helpers';

export class TaskProjectionPersistence {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async persistProviderFailureProjection(params: {
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    taskId: string;
    currentUnitId: string;
    correlationId: string;
    sessionId: string;
    turnId: string;
    checkpointId: string;
    providerId: string | null;
    error: NormalizedProviderFailure;
    requestContext?: {
      rawContextMessageCount: number;
      retainedContextMessageCount: number;
      toolMessageCount: number;
      gatedContextCharacters: number;
      providerMessageCount: number;
      estimatedPromptCharacters: number;
    } | null;
  }): Promise<void> {
    const projection = buildTaskProjection({
      taskId: params.taskId,
      status: params.runtime.lifecycleStatus,
      currentUnitId: params.runtime.currentUnitId,
      latestSessionId: params.runtime.latestSessionId,
      latestCorrelationId: params.runtime.latestCorrelationId,
      latestTurnId: params.runtime.latestTurnId,
      latestCheckpointId: params.runtime.latestCheckpointId,
      explicitOutputCount: 0,
      trackerCount: params.runtime.progressHistory.length,
      toolCallCount: 0,
      pendingCorrection: params.runtime.pendingCorrection,
      metadata: {
        providerId: params.providerId,
        providerFailure: params.error.message,
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
    await this.foundation.projections.save(projection);
    await this.foundation.tasks.save({
      taskId: params.taskId,
      status: params.runtime.lifecycleStatus,
      currentUnitId: params.runtime.currentUnitId,
      updatedAt: params.runtime.updatedAt,
      payload: {
        title: params.definition.title,
        intent: params.definition.intent,
        error: params.error
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'PROJECTION_UPDATED',
        payload: {
          projection
        }
      })
    );
  }

  async persistSuccessfulTurnProjection(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    currentUnitId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    explicitOutputCount: number;
    trackerCount: number;
    toolCallCount: number;
    selectedProviderId: string;
  }): Promise<void> {
    const projection = buildTaskProjection({
      taskId: params.taskId,
      status: params.runtime.lifecycleStatus,
      currentUnitId: params.runtime.currentUnitId,
      latestSessionId: params.sessionId,
      latestCorrelationId: params.correlationId,
      latestTurnId: params.turnId,
      latestCheckpointId: params.checkpointId,
      explicitOutputCount: params.explicitOutputCount,
      trackerCount: params.trackerCount,
      toolCallCount: params.toolCallCount,
      pendingCorrection: params.runtime.pendingCorrection,
      metadata: {
        latestUnitId: params.currentUnitId,
        selectedProviderId: params.selectedProviderId
      }
    });
    await this.foundation.projections.save(projection);
    await this.foundation.tasks.save({
      taskId: params.taskId,
      status: params.runtime.lifecycleStatus,
      currentUnitId: params.runtime.currentUnitId,
      updatedAt: params.runtime.updatedAt,
      payload: {
        title: params.definition.title,
        intent: params.definition.intent,
        pendingCorrection: params.runtime.pendingCorrection,
        latestTurnId: params.runtime.latestTurnId,
        latestCheckpointId: params.runtime.latestCheckpointId,
        contextCompressionCount: params.runtime.contextCompressionCount
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'PROJECTION_UPDATED',
        payload: {
          projection
        }
      })
    );
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'TURN_ANALYZED',
        payload: {
          lifecycleStatus: params.runtime.lifecycleStatus,
          currentUnitId: params.runtime.currentUnitId,
          pendingCorrection: params.runtime.pendingCorrection
        }
      })
    );
  }
}
