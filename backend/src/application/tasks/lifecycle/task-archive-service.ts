import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { TaskMetadataRecord } from '../../../foundation/repository/types';
import { TaskArchiveResponse } from '../types';

const TERMINAL_LIFECYCLE_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

class TaskArchiveError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'TaskArchiveError';
  }
}

function isArchivedMetadata(record: TaskMetadataRecord | null): boolean {
  return record?.metadata?.taskArchived === true;
}

export class TaskArchiveService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async archiveTask(taskId: string): Promise<TaskArchiveResponse> {
    return this.setArchiveState(taskId, true);
  }

  async unarchiveTask(taskId: string): Promise<TaskArchiveResponse> {
    return this.setArchiveState(taskId, false);
  }

  private async setArchiveState(taskId: string, isArchived: boolean): Promise<TaskArchiveResponse> {
    const runtimeRecord = await this.foundation.taskRuntimes.get(taskId);
    if (!runtimeRecord) {
      throw new TaskArchiveError(`backend_new task error: task "${taskId}" was not found.`, 404);
    }

    if (!TERMINAL_LIFECYCLE_STATUSES.has(runtimeRecord.runtime.lifecycleStatus)) {
      throw new TaskArchiveError(
        `backend_new task error: task "${taskId}" must be terminal before archive changes are allowed.`,
        409
      );
    }

    const existingMetadata = await this.foundation.taskMetadata.get(taskId);
    const currentArchived = isArchivedMetadata(existingMetadata);
    if (currentArchived === isArchived) {
      return {
        ok: true,
        taskId,
        isArchived
      };
    }

    const now = Date.now();
    await this.foundation.taskMetadata.save({
      taskId,
      createdAt: existingMetadata?.createdAt ?? now,
      updatedAt: now,
      latestSessionId: existingMetadata?.latestSessionId ?? runtimeRecord.runtime.latestSessionId ?? null,
      selectedProviderId: existingMetadata?.selectedProviderId ?? runtimeRecord.activeProviderId ?? runtimeRecord.definition.preferredProviderId ?? null,
      labels: existingMetadata?.labels ?? [],
      metadata: {
        ...(existingMetadata?.metadata ?? {}),
        taskArchived: isArchived,
        taskArchivedAt: isArchived ? now : null
      }
    });

    return {
      ok: true,
      taskId,
      isArchived
    };
  }
}

export function isTaskArchiveError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && typeof (error as Error & { statusCode?: number }).statusCode === 'number';
}
