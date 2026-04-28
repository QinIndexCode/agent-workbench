import crypto from 'node:crypto';
import { ToolInvocationRecord } from '../repository';
import { ToolInvocationRequest } from './types';

export function createToolInvocationRecord(params: {
  correlationId: string;
  sessionId: string;
  turnId: string;
  checkpointId?: string | null;
  request: ToolInvocationRequest;
  status?: ToolInvocationRecord['status'];
  startedAt?: number;
  endedAt?: number | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): ToolInvocationRecord {
  const startedAt = params.startedAt ?? Date.now();
  return {
    invocationId: `tool_${startedAt}_${crypto.randomBytes(4).toString('hex')}`,
    correlationId: params.correlationId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    taskId: params.request.taskId,
    unitId: params.request.unitId,
    checkpointId: params.checkpointId ?? null,
    toolId: params.request.toolName,
    arguments: { ...params.request.arguments },
    status: params.status ?? 'PLANNED',
    startedAt,
    endedAt: params.endedAt ?? null,
    result: params.result ?? null,
    error: params.error ?? null,
    metadata: params.metadata ?? {}
  };
}
