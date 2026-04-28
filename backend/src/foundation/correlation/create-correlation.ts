import crypto from 'node:crypto';
import { ExecutionCorrelation } from './types';

function sanitizeIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function createExecutionCorrelation(taskId: string, unitId?: string): ExecutionCorrelation {
  const task = sanitizeIdPart(taskId);
  const unit = sanitizeIdPart(unitId ?? 'global');
  const nonce = crypto.randomBytes(4).toString('hex');
  const timestamp = Date.now();
  return {
    sessionId: `sess_${task}_${unit}_${timestamp}_${nonce}`,
    correlationId: `corr_${task}_${timestamp}_${nonce}`,
    turnId: `turn_${task}_${unit}_${timestamp}_${nonce}`
  };
}

export function createCheckpointId(turnId: string, timestamp = Date.now()): string {
  const turn = sanitizeIdPart(turnId);
  return `chk_${turn}_${timestamp}`;
}
