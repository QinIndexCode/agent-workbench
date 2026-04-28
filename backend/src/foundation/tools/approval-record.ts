import crypto from 'node:crypto';
import { ToolApprovalRecord, ToolInvocationRecord } from '../repository';

export function createToolApprovalRecord(params: {
  invocation: ToolInvocationRecord;
  reason: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}): ToolApprovalRecord {
  const createdAt = params.createdAt ?? Date.now();
  return {
    approvalId: `approval_${createdAt}_${crypto.randomBytes(4).toString('hex')}`,
    invocationId: params.invocation.invocationId,
    correlationId: params.invocation.correlationId,
    sessionId: params.invocation.sessionId,
    turnId: params.invocation.turnId,
    taskId: params.invocation.taskId,
    unitId: params.invocation.unitId,
    checkpointId: params.invocation.checkpointId,
    toolId: params.invocation.toolId,
    status: 'PENDING',
    createdAt,
    resolvedAt: null,
    grantedBy: null,
    reason: params.reason,
    metadata: params.metadata ?? {}
  };
}
