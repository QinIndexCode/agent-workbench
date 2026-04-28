import crypto from 'node:crypto';
import { RuntimeEventEnvelope, RuntimeEventType } from './types';

export function createRuntimeEventEnvelope(params: {
  correlationId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  unitId: string | null;
  checkpointId?: string | null;
  type: RuntimeEventType;
  payload: Record<string, unknown>;
  timestamp?: number;
}): RuntimeEventEnvelope {
  const timestamp = params.timestamp ?? Date.now();
  return {
    eventId: `evt_${timestamp}_${crypto.randomBytes(4).toString('hex')}`,
    correlationId: params.correlationId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    taskId: params.taskId,
    unitId: params.unitId,
    checkpointId: params.checkpointId ?? null,
    type: params.type,
    timestamp,
    payload: params.payload
  };
}
