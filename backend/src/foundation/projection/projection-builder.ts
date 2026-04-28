import { TaskProjectionRecord } from './types';

export function buildTaskProjection(params: {
  taskId: string;
  status: string;
  currentUnitId: string | null;
  latestSessionId: string | null;
  latestCorrelationId: string | null;
  latestTurnId: string | null;
  latestCheckpointId: string | null;
  explicitOutputCount: number;
  trackerCount: number;
  toolCallCount: number;
  pendingCorrection: string;
  metadata?: Record<string, unknown>;
  updatedAt?: number;
}): TaskProjectionRecord {
  return {
    taskId: params.taskId,
    status: params.status,
    currentUnitId: params.currentUnitId,
    latestSessionId: params.latestSessionId,
    latestCorrelationId: params.latestCorrelationId,
    latestTurnId: params.latestTurnId,
    latestCheckpointId: params.latestCheckpointId,
    updatedAt: params.updatedAt ?? Date.now(),
    summary: {
      explicitOutputCount: params.explicitOutputCount,
      trackerCount: params.trackerCount,
      toolCallCount: params.toolCallCount,
      pendingCorrection: params.pendingCorrection
    },
    metadata: params.metadata ?? {}
  };
}
