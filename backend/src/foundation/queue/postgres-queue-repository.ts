import crypto from 'node:crypto';
import { BackendNewConfig } from '../config/types';
import { DatabaseAdapter } from '../database/types';
import { QueueItemRecord, QueueRepository } from '../repository/types';
import { WorkerClaimRecord } from '../../domain/contracts/types';

interface QueueRow {
  task_id: string;
  state: QueueItemRecord['state'];
  run_after: number;
  priority: number;
  lease_owner: string | null;
  claim_token: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  max_retries: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function mapQueueRow(row: QueueRow): QueueItemRecord {
  return {
    taskId: row.task_id,
    state: row.state,
    runAfter: Number(row.run_after),
    priority: Number(row.priority),
    leaseOwner: row.lease_owner,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    attemptCount: Number(row.attempt_count),
    maxRetries: Number(row.max_retries),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class PostgresQueueRepository implements QueueRepository {
  private readonly tableName: string;

  constructor(
    private readonly config: BackendNewConfig,
    private readonly database: DatabaseAdapter
  ) {
    this.tableName = `"${config.database.schema}"."queue_items"`;
  }

  async enqueue(record: QueueItemRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO ${this.tableName} (
        task_id, state, run_after, priority, lease_owner, claim_token, lease_expires_at,
        attempt_count, max_retries, last_error, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (task_id) DO UPDATE SET
        state = EXCLUDED.state,
        run_after = EXCLUDED.run_after,
        priority = EXCLUDED.priority,
        lease_owner = EXCLUDED.lease_owner,
        claim_token = EXCLUDED.claim_token,
        lease_expires_at = EXCLUDED.lease_expires_at,
        attempt_count = EXCLUDED.attempt_count,
        max_retries = EXCLUDED.max_retries,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at`,
      [
        record.taskId,
        record.state,
        record.runAfter,
        record.priority,
        record.leaseOwner,
        record.claimToken,
        record.leaseExpiresAt,
        record.attemptCount,
        record.maxRetries,
        record.lastError,
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  async get(taskId: string): Promise<QueueItemRecord | null> {
    const result = await this.database.query<QueueRow>(
      `SELECT * FROM ${this.tableName} WHERE task_id = $1`,
      [taskId]
    );
    return result.rows[0] ? mapQueueRow(result.rows[0]) : null;
  }

  async claimNext(params: {
    workerId: string;
    now: number;
    leaseMs: number;
  }): Promise<WorkerClaimRecord | null> {
    const claimToken = crypto.randomUUID();
    const leaseExpiresAt = params.now + params.leaseMs;
    const result = await this.database.query<QueueRow>(
      `WITH candidate AS (
        SELECT task_id
        FROM ${this.tableName}
        WHERE (
          (state IN ('QUEUED', 'RETRY_WAITING') AND run_after <= $1)
          OR (state IN ('CLAIMED', 'RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1)
        )
        ORDER BY priority DESC, run_after ASC, updated_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${this.tableName} q
      SET state = 'CLAIMED',
          lease_owner = $2,
          claim_token = $3,
          lease_expires_at = $4,
          attempt_count = CASE WHEN q.state IN ('CLAIMED', 'RUNNING') THEN q.attempt_count ELSE q.attempt_count + 1 END,
          updated_at = $1
      FROM candidate
      WHERE q.task_id = candidate.task_id
      RETURNING q.*`,
      [params.now, params.workerId, claimToken, leaseExpiresAt]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      taskId: row.task_id,
      workerId: params.workerId,
      claimToken,
      claimedAt: params.now,
      leaseExpiresAt,
      attempt: Number(row.attempt_count)
    };
  }

  async heartbeat(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    leaseMs: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE ${this.tableName}
       SET lease_expires_at = $4,
           updated_at = $1
       WHERE task_id = $2 AND lease_owner = $3 AND claim_token = $5`,
      [params.now, params.taskId, params.workerId, params.now + params.leaseMs, params.claimToken]
    );
    return result.rowCount > 0;
  }

  async markRunning(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE ${this.tableName}
       SET state = 'RUNNING',
           updated_at = $1
       WHERE task_id = $2 AND lease_owner = $3 AND claim_token = $4`,
      [params.now, params.taskId, params.workerId, params.claimToken]
    );
    return result.rowCount > 0;
  }

  async complete(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE ${this.tableName}
       SET state = 'COMPLETED',
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = $1
       WHERE task_id = $2 AND lease_owner = $3 AND claim_token = $4`,
      [params.now, params.taskId, params.workerId, params.claimToken]
    );
    return result.rowCount > 0;
  }

  async fail(params: {
    taskId: string;
    workerId: string;
    claimToken: string;
    now: number;
    retryDelayMs: number;
    maxRetries: number;
    error: string;
  }): Promise<QueueItemRecord | null> {
    const nextRunAfter = params.now + params.retryDelayMs;
    const result = await this.database.query<QueueRow>(
      `UPDATE ${this.tableName}
       SET state = CASE WHEN attempt_count >= $5 THEN 'DEAD_LETTER' ELSE 'RETRY_WAITING' END,
           run_after = CASE WHEN attempt_count >= $5 THEN run_after ELSE $6 END,
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL,
           max_retries = $5,
           last_error = $7,
           updated_at = $1
       WHERE task_id = $2 AND lease_owner = $3 AND claim_token = $4
       RETURNING *`,
      [params.now, params.taskId, params.workerId, params.claimToken, params.maxRetries, nextRunAfter, params.error]
    );
    return result.rows[0] ? mapQueueRow(result.rows[0]) : null;
  }

  async releaseExpired(now: number): Promise<number> {
    const nextRunAfter = now + this.config.queue.retryDelayMs;
    const result = await this.database.query(
      `UPDATE ${this.tableName}
       SET state = 'RETRY_WAITING',
           run_after = $2,
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = $1
       WHERE state IN ('CLAIMED', 'RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1`,
      [now, nextRunAfter]
    );
    return result.rowCount;
  }

  async listActive(): Promise<QueueItemRecord[]> {
    const result = await this.database.query<QueueRow>(
      `SELECT * FROM ${this.tableName} WHERE state NOT IN ('COMPLETED') ORDER BY updated_at DESC`
    );
    return result.rows.map(mapQueueRow);
  }
}
