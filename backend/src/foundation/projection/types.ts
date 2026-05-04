export type RuntimeEventType =
  | 'COMMAND_ACCEPTED'
  | 'COMMAND_APPLIED'
  | 'COMMAND_REJECTED'
  | 'OPERATOR_MESSAGE_QUEUED'
  | 'TASK_GUIDANCE_PENDING'
  | 'TASK_GUIDANCE_CONSUMED'
  | 'INTERRUPT_REQUESTED'
  | 'SAFE_POINT_REACHED'
  | 'TASK_ACCEPTED'
  | 'TASK_SUBMITTED'
  | 'TASK_QUEUED'
  | 'TASK_STARTED'
  | 'TASK_CONTINUE_QUEUED'
  | 'TASK_PAUSED'
  | 'TASK_RESUMED'
  | 'TASK_RESTARTED'
  | 'QUEUE_CLAIMED'
  | 'QUEUE_RETRY_SCHEDULED'
  | 'QUEUE_LEASE_RECOVERED'
  | 'TASK_DEAD_LETTERED'
  | 'TASK_DEAD_LETTER_REQUEUED'
  | 'TURN_STARTED'
  | 'TURN_PROMPT_BUILT'
  | 'TURN_ANALYZED'
  | 'PLAN_CREATED'
  | 'PLAN_VALIDATED'
  | 'TOOL_BATCH_PLANNED'
  | 'TOOL_BATCH_EXECUTED'
  | 'CONSOLIDATION_STARTED'
  | 'CONSOLIDATION_COMPLETED'
  | 'TOOL_APPROVAL_RESOLVED'
  | 'TOOL_DISPATCH_REVIEWED'
  | 'TOOL_EXECUTED'
  | 'WORKSPACE_INSTRUCTIONS_LOADED'
  | 'WORKSPACE_HOOK_EXECUTED'
  | 'WORKSPACE_HOOK_FAILED'
  | 'SKILL_EXECUTED'
  | 'MCP_TOOL_EXECUTED'
  | 'TASK_ARTIFACTS_APPLIED'
  | 'TASK_ARTIFACTS_APPLY_FAILED'
  | 'CHECKPOINT_WRITTEN'
  | 'PROJECTION_UPDATED'
  | 'TASK_COMPLETED'
  | 'TASK_CANCELLED'
  | 'TASK_FAILED';

export interface RuntimeEventEnvelope {
  eventId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  unitId: string | null;
  checkpointId: string | null;
  type: RuntimeEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface TaskProjectionRecord {
  taskId: string;
  status: string;
  currentUnitId: string | null;
  latestSessionId: string | null;
  latestCorrelationId: string | null;
  latestTurnId: string | null;
  latestCheckpointId: string | null;
  updatedAt: number;
  summary: {
    explicitOutputCount: number;
    trackerCount: number;
    toolCallCount: number;
    pendingCorrection: string;
  };
  metadata: Record<string, unknown>;
}
