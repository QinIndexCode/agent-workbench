import { QueueItemState, TaskDefinition, TaskRuntimeState, WorkerClaimRecord } from '../../domain/contracts/types';

export interface TaskSnapshotRecord {
  taskId: string;
  status: string;
  currentUnitId: string | null;
  updatedAt: number;
  payload: Record<string, unknown>;
}

export interface TaskRuntimeRecord {
  taskId: string;
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  activeProviderId: string | null;
  latestCheckpointId: string | null;
  updatedAt: number;
}

export interface CheckpointRecord {
  taskId: string;
  timestamp: number;
  state: Record<string, unknown>;
}

export interface ApiKeySecretRecord {
  id: string;
  provider: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  cipherText: string;
  metadata: Record<string, unknown>;
}

export interface ApiKeySecretValue {
  id: string;
  provider: string;
  label: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export type ExecutionSessionStatus =
  | 'CREATED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface TaskMetadataRecord {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  latestSessionId: string | null;
  selectedProviderId: string | null;
  labels: string[];
  metadata: Record<string, unknown>;
}

export interface ExecutionSessionRecord {
  sessionId: string;
  correlationId: string;
  taskId: string;
  unitId: string | null;
  providerId: string | null;
  status: ExecutionSessionStatus;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  metadata: Record<string, unknown>;
}

export interface TaskProjectionRecordStore {
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

export interface RuntimeEventRecord {
  eventId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  unitId: string | null;
  checkpointId: string | null;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface ValidatedOutputRecord {
  taskId: string;
  unitId: string;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  contractKeys: string[];
  wrapper: 'square' | 'angle' | 'xml';
  raw: string;
  parsed: unknown;
  validatedAt: number;
  metadata: Record<string, unknown>;
}

export type ToolApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

export type ToolInvocationStatus =
  | 'PLANNED'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED';

export interface ToolInvocationRecord {
  invocationId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  unitId: string;
  checkpointId: string | null;
  toolId: string;
  arguments: Record<string, unknown>;
  status: ToolInvocationStatus;
  startedAt: number;
  endedAt: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface ToolApprovalRecord {
  approvalId: string;
  invocationId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  unitId: string;
  checkpointId: string | null;
  toolId: string;
  status: ToolApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  grantedBy: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
}

export interface ToolBatchItem {
  invocationId: string;
  unitId: string;
  toolId: string;
  status: 'PLANNED' | 'WAITING_APPROVAL' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DENIED';
}

export interface ToolBatchRecord {
  batchId: string;
  taskId: string;
  stageIndex: number;
  unitIds: string[];
  status: 'PLANNED' | 'SUCCEEDED' | 'PARTIAL_APPROVAL_BLOCKED' | 'FAILED' | 'DENIED';
  createdAt: number;
  executedAt: number | null;
  items: ToolBatchItem[];
  metadata: Record<string, unknown>;
}

export interface ToolBatchExecutionResult {
  batchId: string;
  stageIndex: number;
  status: 'SUCCEEDED' | 'PARTIAL_APPROVAL_BLOCKED' | 'FAILED' | 'DENIED';
  dispatchedInvocationIds: string[];
  approvalBlockedInvocationIds: string[];
  deniedInvocationIds: string[];
  failedInvocationIds: string[];
}

export interface ConfigSnapshotRecordStore {
  version: string;
  fingerprint: string;
  createdAt: number;
  config: unknown;
}

export interface QueueItemRecord {
  taskId: string;
  state: QueueItemState;
  runAfter: number;
  priority: number;
  leaseOwner: string | null;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type OperatorCommandStatus =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'APPLIED';

export interface OperatorCommandRecord {
  commandId: string;
  taskId: string;
  type: import('../../domain/contracts/types').OperatorCommandType;
  status: OperatorCommandStatus;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
  actor: string | null;
  reason: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
}

export type OperatorMessageStatus =
  | 'PENDING'
  | 'CONSUMED';

export interface OperatorMessageRecord {
  messageId: string;
  taskId: string;
  commandId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  status: OperatorMessageStatus;
  content: string;
  createdAt: number;
  consumedAt: number | null;
  metadata: Record<string, unknown>;
}

export type InterruptRequestStatus =
  | 'REQUESTED'
  | 'ACKNOWLEDGED'
  | 'APPLIED'
  | 'CLEARED';

export interface InterruptRequestRecord {
  interruptId: string;
  taskId: string;
  commandId: string | null;
  status: InterruptRequestStatus;
  requestedBy: string | null;
  createdAt: number;
  updatedAt: number;
  reason: string | null;
  metadata: Record<string, unknown>;
}

export interface PlatformChannelRecord {
  channelId: string;
  name: string;
  kind: string;
  status: 'ACTIVE' | 'DISABLED';
  endpoint: string | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface PlatformScheduleRecord {
  scheduleId: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  cadence: string;
  taskTemplate: Record<string, unknown>;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface PlatformMemoryRecord {
  memoryId: string;
  title: string;
  content: string;
  scope: 'GLOBAL' | 'TASK' | 'USER';
  tags: string[];
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export type PlatformResourceType =
  | 'CHANNEL'
  | 'SCHEDULE'
  | 'MEMORY'
  | 'PROVIDER'
  | 'CONFIG'
  | 'SKILL'
  | 'MCP'
  | 'WORKSPACE'
  | 'IMPROVEMENT';

export type PlatformActionType =
  | 'UPSERT'
  | 'DELETE'
  | 'PAUSE'
  | 'RESUME'
  | 'SET_DEFAULT'
  | 'SET_SECRET'
  | 'UPDATE'
  | 'RELOAD'
  | 'REFRESH'
  | 'IMPORT'
  | 'APPROVE'
  | 'REJECT';

export interface PlatformCommandRecord {
  commandId: string;
  resourceType: PlatformResourceType;
  resourceId: string;
  action: PlatformActionType;
  createdAt: number;
  actor: string | null;
  reason: string | null;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export type PlatformAuditStatus =
  | 'APPLIED'
  | 'REJECTED';

export interface PlatformAuditRecord {
  auditId: string;
  commandId: string;
  resourceType: PlatformResourceType;
  resourceId: string;
  action: PlatformActionType;
  status: PlatformAuditStatus;
  createdAt: number;
  error: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface TaskRepository {
  save(record: TaskSnapshotRecord): Promise<void>;
  get(taskId: string): Promise<TaskSnapshotRecord | null>;
  list(): Promise<TaskSnapshotRecord[]>;
}

export interface TaskRuntimeRepository {
  save(record: TaskRuntimeRecord): Promise<void>;
  get(taskId: string): Promise<TaskRuntimeRecord | null>;
  list(): Promise<TaskRuntimeRecord[]>;
}

export interface CheckpointRepository {
  save(record: CheckpointRecord): Promise<void>;
  get(taskId: string): Promise<CheckpointRecord | null>;
}

export interface ApiKeySecretRepository {
  save(record: ApiKeySecretValue): Promise<void>;
  get(secretId: string): Promise<ApiKeySecretValue | null>;
  list(): Promise<ApiKeySecretValue[]>;
}

export interface TaskMetadataRepository {
  save(record: TaskMetadataRecord): Promise<void>;
  get(taskId: string): Promise<TaskMetadataRecord | null>;
}

export interface ExecutionSessionRepository {
  save(record: ExecutionSessionRecord): Promise<void>;
  get(sessionId: string): Promise<ExecutionSessionRecord | null>;
}

export interface TaskProjectionRepository {
  save(record: TaskProjectionRecordStore): Promise<void>;
  get(taskId: string): Promise<TaskProjectionRecordStore | null>;
}

export interface RuntimeEventRepository {
  append(record: RuntimeEventRecord): Promise<void>;
  list(taskId: string): Promise<RuntimeEventRecord[]>;
  listAfter(taskId: string, afterEventId: string): Promise<RuntimeEventRecord[]>;
}

export interface ValidatedOutputRepository {
  save(record: ValidatedOutputRecord): Promise<void>;
  get(taskId: string, unitId: string): Promise<ValidatedOutputRecord | null>;
  list(taskId: string): Promise<ValidatedOutputRecord[]>;
}

export interface ToolInvocationRepository {
  append(record: ToolInvocationRecord): Promise<void>;
  list(taskId: string): Promise<ToolInvocationRecord[]>;
  listLatest(taskId: string): Promise<ToolInvocationRecord[]>;
}

export interface ToolApprovalRepository {
  append(record: ToolApprovalRecord): Promise<void>;
  list(taskId: string): Promise<ToolApprovalRecord[]>;
  listLatest(taskId: string): Promise<ToolApprovalRecord[]>;
}

export interface ConversationRepository {
  append(record: import('../conversation/types').ConversationMessageRecord): Promise<void>;
  list(taskId: string): Promise<import('../conversation/types').ConversationMessageRecord[]>;
}

export interface ConfigSnapshotRepository {
  save(record: ConfigSnapshotRecordStore): Promise<void>;
  getActive(): Promise<ConfigSnapshotRecordStore | null>;
}

export interface QueueRepository {
  enqueue(record: QueueItemRecord): Promise<void>;
  get(taskId: string): Promise<QueueItemRecord | null>;
  claimNext(params: {
    workerId: string;
    now: number;
    leaseMs: number;
  }): Promise<WorkerClaimRecord | null>;
  heartbeat(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    leaseMs: number;
    now: number;
  }): Promise<boolean>;
  markRunning(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
  }): Promise<boolean>;
  complete(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
  }): Promise<boolean>;
  fail(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
    retryDelayMs: number;
    maxRetries: number;
    error: string;
  }): Promise<QueueItemRecord | null>;
  releaseExpired(now: number): Promise<number>;
  listActive(): Promise<QueueItemRecord[]>;
}

export interface OperatorCommandRepository {
  append(record: OperatorCommandRecord): Promise<void>;
  list(taskId: string): Promise<OperatorCommandRecord[]>;
  listLatest(taskId: string): Promise<OperatorCommandRecord[]>;
}

export interface OperatorMessageRepository {
  append(record: OperatorMessageRecord): Promise<void>;
  list(taskId: string): Promise<OperatorMessageRecord[]>;
  listLatest(taskId: string): Promise<OperatorMessageRecord[]>;
}

export interface InterruptRequestRepository {
  append(record: InterruptRequestRecord): Promise<void>;
  list(taskId: string): Promise<InterruptRequestRecord[]>;
  listLatest(taskId: string): Promise<InterruptRequestRecord[]>;
}

export interface PlatformChannelRepository {
  save(record: PlatformChannelRecord): Promise<void>;
  get(channelId: string): Promise<PlatformChannelRecord | null>;
  list(): Promise<PlatformChannelRecord[]>;
  delete(channelId: string): Promise<boolean>;
}

export interface PlatformScheduleRepository {
  save(record: PlatformScheduleRecord): Promise<void>;
  get(scheduleId: string): Promise<PlatformScheduleRecord | null>;
  list(): Promise<PlatformScheduleRecord[]>;
  delete(scheduleId: string): Promise<boolean>;
}

export interface PlatformMemoryRepository {
  save(record: PlatformMemoryRecord): Promise<void>;
  get(memoryId: string): Promise<PlatformMemoryRecord | null>;
  list(): Promise<PlatformMemoryRecord[]>;
  delete(memoryId: string): Promise<boolean>;
  search(query: string): Promise<PlatformMemoryRecord[]>;
}

export interface PlatformCommandRepository {
  append(record: PlatformCommandRecord): Promise<void>;
  list(): Promise<PlatformCommandRecord[]>;
  listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformCommandRecord[]>;
}

export interface PlatformAuditRepository {
  append(record: PlatformAuditRecord): Promise<void>;
  list(): Promise<PlatformAuditRecord[]>;
  listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformAuditRecord[]>;
}
