import { ToolExecutionPolicyResult } from './execution-policy';
import { ToolResultEnvelope } from './types';

export function createToolExecutionAuditDetails(params: {
  taskId: string;
  unitId: string;
  toolName: string;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string | null;
  policy: ToolExecutionPolicyResult;
  result?: ToolResultEnvelope;
}): Record<string, unknown> {
  return {
    taskId: params.taskId,
    unitId: params.unitId,
    toolName: params.toolName,
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    turnId: params.turnId,
    checkpointId: params.checkpointId,
    decision: params.policy.decision,
    reason: params.policy.reason,
    resultOk: params.result ? params.result.ok : null,
    resultKind: params.result ? params.result.kind : null,
    resultMessage: params.result ? params.result.message : null
  };
}
