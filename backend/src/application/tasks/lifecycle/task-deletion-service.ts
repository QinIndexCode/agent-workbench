import path from 'node:path';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { QueueItemRecord } from '../../../foundation/repository';
import { TaskDeleteResponse } from '../types';

const DELETABLE_LIFECYCLE_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const ACTIVE_QUEUE_STATES = new Set(['QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAITING']);

class TaskDeletionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'TaskDeletionError';
  }
}

export class TaskDeletionService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async deleteTask(taskId: string): Promise<TaskDeleteResponse> {
    const runtimeRecord = await this.foundation.taskRuntimes.get(taskId);
    if (!runtimeRecord) {
      return {
        ok: true,
        taskId,
        deleted: false
      };
    }

    if (!DELETABLE_LIFECYCLE_STATUSES.has(runtimeRecord.runtime.lifecycleStatus)) {
      throw new TaskDeletionError(
        `backend_new task error: task "${taskId}" must be terminal before deletion.`,
        409
      );
    }

    const queueRecord = await this.foundation.queue?.get(taskId) ?? null;
    if (queueRecord && ACTIVE_QUEUE_STATES.has(queueRecord.state)) {
      throw new TaskDeletionError(
        `backend_new task error: task "${taskId}" is still active in queue state "${queueRecord.state}".`,
        409
      );
    }

    if (this.foundation.config.storage.driver === 'postgres') {
      await this.deletePostgresTask(taskId);
    } else {
      await this.deleteFileTask(taskId);
    }

    return {
      ok: true,
      taskId,
      deleted: true
    };
  }

  private async deleteFileTask(taskId: string): Promise<void> {
    const layout = this.foundation.layout.forTask(taskId);
    const outputs = await this.listOutputPaths(taskId);
    const sessionPaths = await this.listSessionPaths(taskId);
    const taskPaths = [
      layout.taskRecordPath,
      layout.taskRuntimePath,
      layout.taskMetadataPath,
      layout.projectionPath,
      layout.eventLogPath,
      layout.commandLogPath,
      layout.operatorMessageLogPath,
      layout.interruptLogPath,
      layout.toolInvocationLogPath,
      layout.approvalLogPath,
      layout.conversationLogPath,
      layout.traceLogPath,
      layout.checkpointPath,
      ...outputs,
      ...sessionPaths
    ];

    await Promise.all(taskPaths.map((targetPath) => this.foundation.storage.deleteFile(targetPath)));
    await this.foundation.storage.deleteDir(layout.workspaceDir);
  }

  private async listOutputPaths(taskId: string): Promise<string[]> {
    const prefix = `${taskId}__`;
    const names = await this.foundation.storage.listFiles(this.foundation.config.paths.outputsDir);
    return names
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(this.foundation.config.paths.outputsDir, name));
  }

  private async listSessionPaths(taskId: string): Promise<string[]> {
    const names = await this.foundation.storage.listFiles(this.foundation.config.paths.sessionsDir);
    const matches = await Promise.all(
      names.map(async (name) => {
        const fullPath = path.join(this.foundation.config.paths.sessionsDir, name);
        try {
          const session = await this.foundation.storage.readJson<{ taskId?: unknown }>(fullPath);
          return session.taskId === taskId ? fullPath : null;
        } catch {
          return null;
        }
      })
    );
    return matches.filter((entry): entry is string => entry !== null);
  }

  private async deletePostgresTask(taskId: string): Promise<void> {
    const database = this.foundation.database;
    if (!database) {
      throw new TaskDeletionError('backend_new task error: postgres deletion requires database adapter.', 500);
    }

    const schema = `"${this.foundation.config.database.schema}"`;
    const deleteStatements = [
      `${schema}."queue_items"`,
      `${schema}."validated_outputs"`,
      `${schema}."tool_approvals"`,
      `${schema}."tool_invocations"`,
      `${schema}."operator_messages"`,
      `${schema}."operator_commands"`,
      `${schema}."interrupt_requests"`,
      `${schema}."conversations"`,
      `${schema}."runtime_events"`,
      `${schema}."task_projections"`,
      `${schema}."execution_sessions"`,
      `${schema}."task_metadata"`,
      `${schema}."checkpoints"`,
      `${schema}."task_runtimes"`,
      `${schema}."tasks"`
    ];

    await database.query('BEGIN');
    try {
      for (const tableName of deleteStatements) {
        await database.query(`DELETE FROM ${tableName} WHERE task_id = $1`, [taskId]);
      }
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
  }
}

export function isTaskDeletionError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && typeof (error as Error & { statusCode?: number }).statusCode === 'number';
}
