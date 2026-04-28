import { ConversationMessageRecord } from '../conversation/types';
import { BackendNewConfig } from '../config/types';
import { DatabaseAdapter } from '../database/types';
import { RuntimeEventHub, TaskSnapshotHub } from '../projection/event-hub';
import {
  ApiKeySecretRecord,
  ApiKeySecretRepository,
  ApiKeySecretValue,
  CheckpointRecord,
  CheckpointRepository,
  ConfigSnapshotRecordStore,
  ConfigSnapshotRepository,
  ConversationRepository,
  ExecutionSessionRecord,
  ExecutionSessionRepository,
  InterruptRequestRecord,
  InterruptRequestRepository,
  OperatorCommandRecord,
  OperatorCommandRepository,
  OperatorMessageRecord,
  OperatorMessageRepository,
  PlatformAuditRecord,
  PlatformAuditRepository,
  PlatformChannelRecord,
  PlatformChannelRepository,
  PlatformCommandRecord,
  PlatformCommandRepository,
  PlatformMemoryRecord,
  PlatformMemoryRepository,
  PlatformResourceType,
  PlatformScheduleRecord,
  PlatformScheduleRepository,
  RuntimeEventRecord,
  RuntimeEventRepository,
  TaskMetadataRecord,
  TaskMetadataRepository,
  TaskProjectionRecordStore,
  TaskProjectionRepository,
  TaskRuntimeRecord,
  TaskRuntimeRepository,
  TaskSnapshotRecord,
  TaskRepository,
  ToolApprovalRecord,
  ToolApprovalRepository,
  ToolInvocationRecord,
  ToolInvocationRepository,
  ValidatedOutputRecord,
  ValidatedOutputRepository
} from './types';
import { SecretCipher } from '../security/types';

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export class PostgresTaskRepository implements TaskRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."tasks"`;
  }
  async save(record: TaskSnapshotRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,status,current_unit_id,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET status=EXCLUDED.status,current_unit_id=EXCLUDED.current_unit_id,updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload`,
      [record.taskId, record.status, record.currentUnitId, record.updatedAt, JSON.stringify(record.payload)]
    );
  }
  async get(taskId: string): Promise<TaskSnapshotRecord | null> {
    const result = await this.db.query<{ task_id: string; status: string; current_unit_id: string | null; updated_at: number; payload: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      status: row.status,
      currentUnitId: row.current_unit_id,
      updatedAt: Number(row.updated_at),
      payload: parseJson(row.payload, {})
    } : null;
  }
  async list(): Promise<TaskSnapshotRecord[]> {
    const result = await this.db.query<{ task_id: string; status: string; current_unit_id: string | null; updated_at: number; payload: unknown }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      taskId: row.task_id,
      status: row.status,
      currentUnitId: row.current_unit_id,
      updatedAt: Number(row.updated_at),
      payload: parseJson(row.payload, {})
    }));
  }
}

export class PostgresTaskRuntimeRepository implements TaskRuntimeRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."task_runtimes"`;
  }
  async save(record: TaskRuntimeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,definition,runtime,active_provider_id,latest_checkpoint_id,updated_at)
       VALUES ($1,$2::jsonb,$3::jsonb,$4,$5,$6)
       ON CONFLICT (task_id) DO UPDATE SET definition=EXCLUDED.definition,runtime=EXCLUDED.runtime,active_provider_id=EXCLUDED.active_provider_id,latest_checkpoint_id=EXCLUDED.latest_checkpoint_id,updated_at=EXCLUDED.updated_at`,
      [record.taskId, JSON.stringify(record.definition), JSON.stringify(record.runtime), record.activeProviderId, record.latestCheckpointId, record.updatedAt]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async get(taskId: string): Promise<TaskRuntimeRecord | null> {
    const result = await this.db.query<{ task_id: string; definition: unknown; runtime: unknown; active_provider_id: string | null; latest_checkpoint_id: string | null; updated_at: number }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      definition: parseJson(row.definition, null as never),
      runtime: parseJson(row.runtime, null as never),
      activeProviderId: row.active_provider_id,
      latestCheckpointId: row.latest_checkpoint_id,
      updatedAt: Number(row.updated_at)
    } : null;
  }
  async list(): Promise<TaskRuntimeRecord[]> {
    const result = await this.db.query<{ task_id: string; definition: unknown; runtime: unknown; active_provider_id: string | null; latest_checkpoint_id: string | null; updated_at: number }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      taskId: row.task_id,
      definition: parseJson(row.definition, null as never),
      runtime: parseJson(row.runtime, null as never),
      activeProviderId: row.active_provider_id,
      latestCheckpointId: row.latest_checkpoint_id,
      updatedAt: Number(row.updated_at)
    }));
  }
}

export class PostgresCheckpointRepository implements CheckpointRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."checkpoints"`;
  }
  async save(record: CheckpointRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,timestamp,state)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET timestamp=EXCLUDED.timestamp,state=EXCLUDED.state`,
      [record.taskId, record.timestamp, JSON.stringify(record.state)]
    );
  }
  async get(taskId: string): Promise<CheckpointRecord | null> {
    const result = await this.db.query<{ task_id: string; timestamp: number; state: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? { taskId: row.task_id, timestamp: Number(row.timestamp), state: parseJson(row.state, {}) } : null;
  }
}

export class PostgresTaskMetadataRepository implements TaskMetadataRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."task_metadata"`;
  }
  async save(record: TaskMetadataRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,created_at,updated_at,latest_session_id,selected_provider_id,labels,metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,latest_session_id=EXCLUDED.latest_session_id,selected_provider_id=EXCLUDED.selected_provider_id,labels=EXCLUDED.labels,metadata=EXCLUDED.metadata`,
      [record.taskId, record.createdAt, record.updatedAt, record.latestSessionId, record.selectedProviderId, JSON.stringify(record.labels), JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async get(taskId: string): Promise<TaskMetadataRecord | null> {
    const result = await this.db.query<{ task_id: string; created_at: number; updated_at: number; latest_session_id: string | null; selected_provider_id: string | null; labels: unknown; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      latestSessionId: row.latest_session_id,
      selectedProviderId: row.selected_provider_id,
      labels: parseJson(row.labels, []),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
}

export class PostgresExecutionSessionRepository implements ExecutionSessionRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."execution_sessions"`;
  }
  async save(record: ExecutionSessionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (session_id,correlation_id,task_id,unit_id,provider_id,status,created_at,updated_at,ended_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET correlation_id=EXCLUDED.correlation_id,task_id=EXCLUDED.task_id,unit_id=EXCLUDED.unit_id,provider_id=EXCLUDED.provider_id,status=EXCLUDED.status,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,ended_at=EXCLUDED.ended_at,metadata=EXCLUDED.metadata`,
      [record.sessionId, record.correlationId, record.taskId, record.unitId, record.providerId, record.status, record.createdAt, record.updatedAt, record.endedAt, JSON.stringify(record.metadata)]
    );
  }
  async get(sessionId: string): Promise<ExecutionSessionRecord | null> {
    const result = await this.db.query<{ session_id: string; correlation_id: string; task_id: string; unit_id: string | null; provider_id: string | null; status: ExecutionSessionRecord['status']; created_at: number; updated_at: number; ended_at: number | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE session_id = $1`,
      [sessionId]
    );
    const row = result.rows[0];
    return row ? {
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      providerId: row.provider_id,
      status: row.status,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
}

export class PostgresTaskProjectionRepository implements TaskProjectionRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."task_projections"`;
  }
  async save(record: TaskProjectionRecordStore): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,status,current_unit_id,latest_session_id,latest_correlation_id,latest_turn_id,latest_checkpoint_id,updated_at,summary,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET status=EXCLUDED.status,current_unit_id=EXCLUDED.current_unit_id,latest_session_id=EXCLUDED.latest_session_id,latest_correlation_id=EXCLUDED.latest_correlation_id,latest_turn_id=EXCLUDED.latest_turn_id,latest_checkpoint_id=EXCLUDED.latest_checkpoint_id,updated_at=EXCLUDED.updated_at,summary=EXCLUDED.summary,metadata=EXCLUDED.metadata`,
      [record.taskId, record.status, record.currentUnitId, record.latestSessionId, record.latestCorrelationId, record.latestTurnId, record.latestCheckpointId, record.updatedAt, JSON.stringify(record.summary), JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async get(taskId: string): Promise<TaskProjectionRecordStore | null> {
    const result = await this.db.query<{ task_id: string; status: string; current_unit_id: string | null; latest_session_id: string | null; latest_correlation_id: string | null; latest_turn_id: string | null; latest_checkpoint_id: string | null; updated_at: number; summary: unknown; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      status: row.status,
      currentUnitId: row.current_unit_id,
      latestSessionId: row.latest_session_id,
      latestCorrelationId: row.latest_correlation_id,
      latestTurnId: row.latest_turn_id,
      latestCheckpointId: row.latest_checkpoint_id,
      updatedAt: Number(row.updated_at),
      summary: parseJson(row.summary, { explicitOutputCount: 0, trackerCount: 0, toolCallCount: 0, pendingCorrection: 'NONE' }),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
}

export class PostgresRuntimeEventRepository implements RuntimeEventRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter, private readonly hub?: RuntimeEventHub) {
    this.tableName = `"${config.database.schema}"."runtime_events"`;
  }
  async append(record: RuntimeEventRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (event_id,correlation_id,session_id,turn_id,task_id,unit_id,checkpoint_id,type,timestamp,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [record.eventId, record.correlationId, record.sessionId, record.turnId, record.taskId, record.unitId, record.checkpointId, record.type, record.timestamp, JSON.stringify(record.payload)]
    );
    this.hub?.publish(record);
  }
  async list(taskId: string): Promise<RuntimeEventRecord[]> {
    const result = await this.db.query<{ event_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string | null; checkpoint_id: string | null; type: string; timestamp: number; payload: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY row_id ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      eventId: row.event_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      type: row.type,
      timestamp: Number(row.timestamp),
      payload: parseJson(row.payload, {})
    }));
  }

  async listAfter(taskId: string, afterEventId: string): Promise<RuntimeEventRecord[]> {
    const anchor = await this.db.query<{ row_id: number }>(
      `SELECT row_id FROM ${this.tableName} WHERE task_id = $1 AND event_id = $2`,
      [taskId, afterEventId]
    );
    const anchorRowId = anchor.rows[0]?.row_id;
    if (anchorRowId === undefined) {
      return this.list(taskId);
    }
    const result = await this.db.query<{ event_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string | null; checkpoint_id: string | null; type: string; timestamp: number; payload: unknown }>(
      `SELECT * FROM ${this.tableName}
       WHERE task_id = $1 AND row_id > $2
       ORDER BY row_id ASC`,
      [taskId, anchorRowId]
    );
    return result.rows.map(row => ({
      eventId: row.event_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      type: row.type,
      timestamp: Number(row.timestamp),
      payload: parseJson(row.payload, {})
    }));
  }
}

export class PostgresValidatedOutputRepository implements ValidatedOutputRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."validated_outputs"`;
  }
  async save(record: ValidatedOutputRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (task_id,unit_id,session_id,correlation_id,turn_id,checkpoint_id,contract_keys,wrapper,raw,parsed,validated_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12::jsonb)
       ON CONFLICT (task_id, unit_id) DO UPDATE SET session_id=EXCLUDED.session_id,correlation_id=EXCLUDED.correlation_id,turn_id=EXCLUDED.turn_id,checkpoint_id=EXCLUDED.checkpoint_id,contract_keys=EXCLUDED.contract_keys,wrapper=EXCLUDED.wrapper,raw=EXCLUDED.raw,parsed=EXCLUDED.parsed,validated_at=EXCLUDED.validated_at,metadata=EXCLUDED.metadata`,
      [record.taskId, record.unitId, record.sessionId, record.correlationId, record.turnId, record.checkpointId, JSON.stringify(record.contractKeys), record.wrapper, record.raw, JSON.stringify(record.parsed), record.validatedAt, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async get(taskId: string, unitId: string): Promise<ValidatedOutputRecord | null> {
    const result = await this.db.query<{ task_id: string; unit_id: string; session_id: string; correlation_id: string; turn_id: string; checkpoint_id: string; contract_keys: unknown; wrapper: ValidatedOutputRecord['wrapper']; raw: string; parsed: unknown; validated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 AND unit_id = $2`,
      [taskId, unitId]
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      unitId: row.unit_id,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      turnId: row.turn_id,
      checkpointId: row.checkpoint_id,
      contractKeys: parseJson(row.contract_keys, []),
      wrapper: row.wrapper,
      raw: row.raw,
      parsed: parseJson(row.parsed, null),
      validatedAt: Number(row.validated_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
  async list(taskId: string): Promise<ValidatedOutputRecord[]> {
    const result = await this.db.query<{ task_id: string; unit_id: string; session_id: string; correlation_id: string; turn_id: string; checkpoint_id: string; contract_keys: unknown; wrapper: ValidatedOutputRecord['wrapper']; raw: string; parsed: unknown; validated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY validated_at ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      taskId: row.task_id,
      unitId: row.unit_id,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      turnId: row.turn_id,
      checkpointId: row.checkpoint_id,
      contractKeys: parseJson(row.contract_keys, []),
      wrapper: row.wrapper,
      raw: row.raw,
      parsed: parseJson(row.parsed, null),
      validatedAt: Number(row.validated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresToolInvocationRepository implements ToolInvocationRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."tool_invocations"`;
  }
  async append(record: ToolInvocationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (invocation_id,correlation_id,session_id,turn_id,task_id,unit_id,checkpoint_id,tool_id,arguments,status,started_at,ended_at,result,error,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$15::jsonb)`,
      [record.invocationId, record.correlationId, record.sessionId, record.turnId, record.taskId, record.unitId, record.checkpointId, record.toolId, JSON.stringify(record.arguments), record.status, record.startedAt, record.endedAt, JSON.stringify(record.result), record.error, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async list(taskId: string): Promise<ToolInvocationRecord[]> {
    const result = await this.db.query<{ invocation_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string; checkpoint_id: string | null; tool_id: string; arguments: unknown; status: ToolInvocationRecord['status']; started_at: number; ended_at: number | null; result: unknown; error: string | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY row_id ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      invocationId: row.invocation_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      toolId: row.tool_id,
      arguments: parseJson(row.arguments, {}),
      status: row.status,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      result: parseJson(row.result, null),
      error: row.error,
      metadata: parseJson(row.metadata, {})
    }));
  }
  async listLatest(taskId: string): Promise<ToolInvocationRecord[]> {
    const result = await this.db.query<{ invocation_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string; checkpoint_id: string | null; tool_id: string; arguments: unknown; status: ToolInvocationRecord['status']; started_at: number; ended_at: number | null; result: unknown; error: string | null; metadata: unknown }>(
      `SELECT DISTINCT ON (invocation_id) * FROM ${this.tableName} WHERE task_id = $1 ORDER BY invocation_id, row_id DESC`,
      [taskId]
    );
    return result.rows.map(row => ({
      invocationId: row.invocation_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      toolId: row.tool_id,
      arguments: parseJson(row.arguments, {}),
      status: row.status,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      result: parseJson(row.result, null),
      error: row.error,
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresToolApprovalRepository implements ToolApprovalRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."tool_approvals"`;
  }
  async append(record: ToolApprovalRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (approval_id,invocation_id,correlation_id,session_id,turn_id,task_id,unit_id,checkpoint_id,tool_id,status,created_at,resolved_at,granted_by,reason,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [record.approvalId, record.invocationId, record.correlationId, record.sessionId, record.turnId, record.taskId, record.unitId, record.checkpointId, record.toolId, record.status, record.createdAt, record.resolvedAt, record.grantedBy, record.reason, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async list(taskId: string): Promise<ToolApprovalRecord[]> {
    const result = await this.db.query<{ approval_id: string; invocation_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string; checkpoint_id: string | null; tool_id: string; status: ToolApprovalRecord['status']; created_at: number; resolved_at: number | null; granted_by: string | null; reason: string | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY row_id ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      approvalId: row.approval_id,
      invocationId: row.invocation_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      toolId: row.tool_id,
      status: row.status,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      grantedBy: row.granted_by,
      reason: row.reason,
      metadata: parseJson(row.metadata, {})
    }));
  }
  async listLatest(taskId: string): Promise<ToolApprovalRecord[]> {
    const result = await this.db.query<{ approval_id: string; invocation_id: string; correlation_id: string; session_id: string; turn_id: string; task_id: string; unit_id: string; checkpoint_id: string | null; tool_id: string; status: ToolApprovalRecord['status']; created_at: number; resolved_at: number | null; granted_by: string | null; reason: string | null; metadata: unknown }>(
      `SELECT DISTINCT ON (invocation_id) * FROM ${this.tableName} WHERE task_id = $1 ORDER BY invocation_id, row_id DESC`,
      [taskId]
    );
    return result.rows.map(row => ({
      approvalId: row.approval_id,
      invocationId: row.invocation_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      taskId: row.task_id,
      unitId: row.unit_id,
      checkpointId: row.checkpoint_id,
      toolId: row.tool_id,
      status: row.status,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      grantedBy: row.granted_by,
      reason: row.reason,
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."conversations"`;
  }
  async append(record: ConversationMessageRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (message_id,task_id,session_id,correlation_id,role,visibility,created_at,content,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [record.messageId, record.taskId, record.sessionId, record.correlationId, record.role, record.visibility, record.createdAt, record.content, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async list(taskId: string): Promise<ConversationMessageRecord[]> {
    const result = await this.db.query<{ message_id: string; task_id: string; session_id: string | null; correlation_id: string | null; role: ConversationMessageRecord['role']; visibility: ConversationMessageRecord['visibility']; created_at: number; content: string; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      messageId: row.message_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      role: row.role,
      visibility: row.visibility,
      createdAt: Number(row.created_at),
      content: row.content,
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresOperatorCommandRepository implements OperatorCommandRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."operator_commands"`;
  }
  async append(record: OperatorCommandRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (command_id,task_id,type,status,created_at,updated_at,applied_at,actor,reason,message,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [record.commandId, record.taskId, record.type, record.status, record.createdAt, record.updatedAt, record.appliedAt, record.actor, record.reason, record.message, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async list(taskId: string): Promise<OperatorCommandRecord[]> {
    const result = await this.db.query<{ command_id: string; task_id: string; type: OperatorCommandRecord['type']; status: OperatorCommandRecord['status']; created_at: number; updated_at: number; applied_at: number | null; actor: string | null; reason: string | null; message: string | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      commandId: row.command_id,
      taskId: row.task_id,
      type: row.type,
      status: row.status,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      appliedAt: row.applied_at === null ? null : Number(row.applied_at),
      actor: row.actor,
      reason: row.reason,
      message: row.message,
      metadata: parseJson(row.metadata, {})
    }));
  }
  async listLatest(taskId: string): Promise<OperatorCommandRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, OperatorCommandRecord>();
    for (const record of records) {
      latest.set(record.commandId, record);
    }
    return Array.from(latest.values());
  }
}

export class PostgresOperatorMessageRepository implements OperatorMessageRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {
    this.tableName = `"${config.database.schema}"."operator_messages"`;
  }
  async append(record: OperatorMessageRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (message_id,task_id,command_id,session_id,correlation_id,status,content,created_at,consumed_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [record.messageId, record.taskId, record.commandId, record.sessionId, record.correlationId, record.status, record.content, record.createdAt, record.consumedAt, JSON.stringify(record.metadata)]
    );
    this.snapshotHub?.publish(record.taskId);
  }
  async list(taskId: string): Promise<OperatorMessageRecord[]> {
    const result = await this.db.query<{ message_id: string; task_id: string; command_id: string | null; session_id: string | null; correlation_id: string | null; status: OperatorMessageRecord['status']; content: string; created_at: number; consumed_at: number | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      messageId: row.message_id,
      taskId: row.task_id,
      commandId: row.command_id,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      status: row.status,
      content: row.content,
      createdAt: Number(row.created_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
  async listLatest(taskId: string): Promise<OperatorMessageRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, OperatorMessageRecord>();
    for (const record of records) {
      latest.set(record.messageId, record);
    }
    return Array.from(latest.values());
  }
}

export class PostgresInterruptRequestRepository implements InterruptRequestRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."interrupt_requests"`;
  }
  async append(record: InterruptRequestRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (interrupt_id,task_id,command_id,status,requested_by,created_at,updated_at,reason,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [record.interruptId, record.taskId, record.commandId, record.status, record.requestedBy, record.createdAt, record.updatedAt, record.reason, JSON.stringify(record.metadata)]
    );
  }
  async list(taskId: string): Promise<InterruptRequestRecord[]> {
    const result = await this.db.query<{ interrupt_id: string; task_id: string; command_id: string | null; status: InterruptRequestRecord['status']; requested_by: string | null; created_at: number; updated_at: number; reason: string | null; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(row => ({
      interruptId: row.interrupt_id,
      taskId: row.task_id,
      commandId: row.command_id,
      status: row.status,
      requestedBy: row.requested_by,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      reason: row.reason,
      metadata: parseJson(row.metadata, {})
    }));
  }
  async listLatest(taskId: string): Promise<InterruptRequestRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, InterruptRequestRecord>();
    for (const record of records) {
      latest.set(record.interruptId, record);
    }
    return Array.from(latest.values());
  }
}

export class PostgresConfigSnapshotRepository implements ConfigSnapshotRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."config_snapshots"`;
  }
  async save(record: ConfigSnapshotRecordStore): Promise<void> {
    await this.db.query(
      `UPDATE ${this.tableName}
       SET is_active = FALSE
       WHERE is_active = TRUE AND version <> $1`,
      [record.version]
    );
    await this.db.query(
      `INSERT INTO ${this.tableName} (version,fingerprint,created_at,config,is_active)
       VALUES ($1,$2,$3,$4::jsonb,TRUE)
       ON CONFLICT (version) DO UPDATE
       SET fingerprint=EXCLUDED.fingerprint,
           created_at=EXCLUDED.created_at,
           config=EXCLUDED.config,
           is_active=TRUE`,
      [record.version, record.fingerprint, record.createdAt, JSON.stringify(record.config)]
    );
  }
  async getActive(): Promise<ConfigSnapshotRecordStore | null> {
    const result = await this.db.query<{ version: string; fingerprint: string; created_at: number; config: unknown }>(
      `SELECT version,fingerprint,created_at,config FROM ${this.tableName} WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`
    );
    const row = result.rows[0];
    return row ? {
      version: row.version,
      fingerprint: row.fingerprint,
      createdAt: Number(row.created_at),
      config: parseJson(row.config, {})
    } : null;
  }
}

export class PostgresApiKeySecretRepository implements ApiKeySecretRepository {
  private readonly tableName: string;
  constructor(
    private readonly config: BackendNewConfig,
    private readonly db: DatabaseAdapter,
    private readonly cipher: SecretCipher
  ) {
    this.tableName = `"${config.database.schema}"."provider_secrets"`;
  }
  async save(record: ApiKeySecretValue): Promise<void> {
    const payload: ApiKeySecretRecord = {
      id: record.id,
      provider: record.provider,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cipherText: this.cipher.encrypt(record.apiKey),
      metadata: record.metadata
    };
    await this.db.query(
      `INSERT INTO ${this.tableName} (id,provider,label,created_at,updated_at,cipher_text,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider,label=EXCLUDED.label,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,cipher_text=EXCLUDED.cipher_text,metadata=EXCLUDED.metadata`,
      [payload.id, payload.provider, payload.label, payload.createdAt, payload.updatedAt, payload.cipherText, JSON.stringify(payload.metadata)]
    );
  }
  async get(secretId: string): Promise<ApiKeySecretValue | null> {
    const result = await this.db.query<{ id: string; provider: string; label: string; created_at: number; updated_at: number; cipher_text: string; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [secretId]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      provider: row.provider,
      label: row.label,
      apiKey: this.cipher.decrypt(row.cipher_text),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }

  async list(): Promise<ApiKeySecretValue[]> {
    const result = await this.db.query<{ id: string; provider: string; label: string; created_at: number; updated_at: number; cipher_text: string; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      id: row.id,
      provider: row.provider,
      label: row.label,
      apiKey: this.cipher.decrypt(row.cipher_text),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresPlatformChannelRepository implements PlatformChannelRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."platform_channels"`;
  }
  async save(record: PlatformChannelRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (channel_id,name,kind,status,endpoint,created_at,updated_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (channel_id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,status=EXCLUDED.status,endpoint=EXCLUDED.endpoint,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,metadata=EXCLUDED.metadata`,
      [record.channelId, record.name, record.kind, record.status, record.endpoint, record.createdAt, record.updatedAt, JSON.stringify(record.metadata)]
    );
  }
  async get(channelId: string): Promise<PlatformChannelRecord | null> {
    const result = await this.db.query<{ channel_id: string; name: string; kind: string; status: PlatformChannelRecord['status']; endpoint: string | null; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE channel_id = $1`,
      [channelId]
    );
    const row = result.rows[0];
    return row ? {
      channelId: row.channel_id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      endpoint: row.endpoint,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
  async list(): Promise<PlatformChannelRecord[]> {
    const result = await this.db.query<{ channel_id: string; name: string; kind: string; status: PlatformChannelRecord['status']; endpoint: string | null; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      channelId: row.channel_id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      endpoint: row.endpoint,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
  async delete(channelId: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM ${this.tableName} WHERE channel_id = $1`, [channelId]);
    return (result.rowCount ?? 0) > 0;
  }
}

export class PostgresPlatformScheduleRepository implements PlatformScheduleRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."platform_schedules"`;
  }
  async save(record: PlatformScheduleRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (schedule_id,name,status,cadence,task_template,last_run_at,next_run_at,created_at,updated_at,metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (schedule_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,cadence=EXCLUDED.cadence,task_template=EXCLUDED.task_template,last_run_at=EXCLUDED.last_run_at,next_run_at=EXCLUDED.next_run_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,metadata=EXCLUDED.metadata`,
      [record.scheduleId, record.name, record.status, record.cadence, JSON.stringify(record.taskTemplate), record.lastRunAt, record.nextRunAt, record.createdAt, record.updatedAt, JSON.stringify(record.metadata)]
    );
  }
  async get(scheduleId: string): Promise<PlatformScheduleRecord | null> {
    const result = await this.db.query<{ schedule_id: string; name: string; status: PlatformScheduleRecord['status']; cadence: string; task_template: unknown; last_run_at: number | null; next_run_at: number | null; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE schedule_id = $1`,
      [scheduleId]
    );
    const row = result.rows[0];
    return row ? {
      scheduleId: row.schedule_id,
      name: row.name,
      status: row.status,
      cadence: row.cadence,
      taskTemplate: parseJson(row.task_template, {}),
      lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
      nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
  async list(): Promise<PlatformScheduleRecord[]> {
    const result = await this.db.query<{ schedule_id: string; name: string; status: PlatformScheduleRecord['status']; cadence: string; task_template: unknown; last_run_at: number | null; next_run_at: number | null; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      scheduleId: row.schedule_id,
      name: row.name,
      status: row.status,
      cadence: row.cadence,
      taskTemplate: parseJson(row.task_template, {}),
      lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
      nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
  async delete(scheduleId: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM ${this.tableName} WHERE schedule_id = $1`, [scheduleId]);
    return (result.rowCount ?? 0) > 0;
  }
}

export class PostgresPlatformMemoryRepository implements PlatformMemoryRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."platform_memories"`;
  }
  async save(record: PlatformMemoryRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (memory_id,title,content,scope,tags,created_at,updated_at,metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)
       ON CONFLICT (memory_id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,scope=EXCLUDED.scope,tags=EXCLUDED.tags,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,metadata=EXCLUDED.metadata`,
      [record.memoryId, record.title, record.content, record.scope, JSON.stringify(record.tags), record.createdAt, record.updatedAt, JSON.stringify(record.metadata)]
    );
  }
  async get(memoryId: string): Promise<PlatformMemoryRecord | null> {
    const result = await this.db.query<{ memory_id: string; title: string; content: string; scope: PlatformMemoryRecord['scope']; tags: unknown; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} WHERE memory_id = $1`,
      [memoryId]
    );
    const row = result.rows[0];
    return row ? {
      memoryId: row.memory_id,
      title: row.title,
      content: row.content,
      scope: row.scope,
      tags: parseJson(row.tags, []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    } : null;
  }
  async list(): Promise<PlatformMemoryRecord[]> {
    const result = await this.db.query<{ memory_id: string; title: string; content: string; scope: PlatformMemoryRecord['scope']; tags: unknown; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`
    );
    return result.rows.map(row => ({
      memoryId: row.memory_id,
      title: row.title,
      content: row.content,
      scope: row.scope,
      tags: parseJson(row.tags, []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
  async delete(memoryId: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM ${this.tableName} WHERE memory_id = $1`, [memoryId]);
    return (result.rowCount ?? 0) > 0;
  }
  async search(query: string): Promise<PlatformMemoryRecord[]> {
    const normalized = `%${query.trim().toLowerCase()}%`;
    if (normalized === '%%') {
      return this.list();
    }
    const result = await this.db.query<{ memory_id: string; title: string; content: string; scope: PlatformMemoryRecord['scope']; tags: unknown; created_at: number; updated_at: number; metadata: unknown }>(
      `SELECT * FROM ${this.tableName}
       WHERE LOWER(title) LIKE $1 OR LOWER(content) LIKE $1
       ORDER BY updated_at DESC`,
      [normalized]
    );
    return result.rows.map(row => ({
      memoryId: row.memory_id,
      title: row.title,
      content: row.content,
      scope: row.scope,
      tags: parseJson(row.tags, []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresPlatformCommandRepository implements PlatformCommandRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."platform_commands"`;
  }

  async append(record: PlatformCommandRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (row_id,command_id,resource_type,resource_id,action,created_at,actor,reason,input,metadata)
       VALUES (DEFAULT,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [
        record.commandId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.createdAt,
        record.actor,
        record.reason,
        JSON.stringify(record.input),
        JSON.stringify(record.metadata)
      ]
    );
  }

  async list(): Promise<PlatformCommandRecord[]> {
    const result = await this.db.query<{
      command_id: string;
      resource_type: PlatformResourceType;
      resource_id: string;
      action: PlatformCommandRecord['action'];
      created_at: number;
      actor: string | null;
      reason: string | null;
      input: unknown;
      metadata: unknown;
    }>(`SELECT * FROM ${this.tableName} ORDER BY created_at ASC, row_id ASC`);
    return result.rows.map(row => ({
      commandId: row.command_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      createdAt: Number(row.created_at),
      actor: row.actor,
      reason: row.reason,
      input: parseJson(row.input, {}),
      metadata: parseJson(row.metadata, {})
    }));
  }

  async listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformCommandRecord[]> {
    const result = await this.db.query<{
      command_id: string;
      resource_type: PlatformResourceType;
      resource_id: string;
      action: PlatformCommandRecord['action'];
      created_at: number;
      actor: string | null;
      reason: string | null;
      input: unknown;
      metadata: unknown;
    }>(
      `SELECT * FROM ${this.tableName}
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at ASC, row_id ASC`,
      [resourceType, resourceId]
    );
    return result.rows.map(row => ({
      commandId: row.command_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      createdAt: Number(row.created_at),
      actor: row.actor,
      reason: row.reason,
      input: parseJson(row.input, {}),
      metadata: parseJson(row.metadata, {})
    }));
  }
}

export class PostgresPlatformAuditRepository implements PlatformAuditRepository {
  private readonly tableName: string;
  constructor(private readonly config: BackendNewConfig, private readonly db: DatabaseAdapter) {
    this.tableName = `"${config.database.schema}"."platform_audits"`;
  }

  async append(record: PlatformAuditRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.tableName} (row_id,audit_id,command_id,resource_type,resource_id,action,status,created_at,error,result,metadata)
       VALUES (DEFAULT,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
      [
        record.auditId,
        record.commandId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.status,
        record.createdAt,
        record.error,
        JSON.stringify(record.result),
        JSON.stringify(record.metadata)
      ]
    );
  }

  async list(): Promise<PlatformAuditRecord[]> {
    const result = await this.db.query<{
      audit_id: string;
      command_id: string;
      resource_type: PlatformResourceType;
      resource_id: string;
      action: PlatformAuditRecord['action'];
      status: PlatformAuditRecord['status'];
      created_at: number;
      error: string | null;
      result: unknown;
      metadata: unknown;
    }>(`SELECT * FROM ${this.tableName} ORDER BY created_at ASC, row_id ASC`);
    return result.rows.map(row => ({
      auditId: row.audit_id,
      commandId: row.command_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      status: row.status,
      createdAt: Number(row.created_at),
      error: row.error,
      result: parseJson(row.result, {}),
      metadata: parseJson(row.metadata, {})
    }));
  }

  async listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformAuditRecord[]> {
    const result = await this.db.query<{
      audit_id: string;
      command_id: string;
      resource_type: PlatformResourceType;
      resource_id: string;
      action: PlatformAuditRecord['action'];
      status: PlatformAuditRecord['status'];
      created_at: number;
      error: string | null;
      result: unknown;
      metadata: unknown;
    }>(
      `SELECT * FROM ${this.tableName}
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at ASC, row_id ASC`,
      [resourceType, resourceId]
    );
    return result.rows.map(row => ({
      auditId: row.audit_id,
      commandId: row.command_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      status: row.status,
      createdAt: Number(row.created_at),
      error: row.error,
      result: parseJson(row.result, {}),
      metadata: parseJson(row.metadata, {})
    }));
  }
}
