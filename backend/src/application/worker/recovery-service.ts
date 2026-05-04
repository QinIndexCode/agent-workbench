import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import { buildTaskProjection } from '../../foundation/projection/projection-builder';
import { QueueItemRecord, TaskRuntimeRecord } from '../../foundation/repository';
import { applyLifecycleTransition } from '../../domain/runtime/state-transition-applier';

export class RecoveryService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  private isMissingRelation(error: unknown): boolean {
    return Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === '42P01'
    );
  }

  private createRecoveredRuntime(
    runtimeRecord: TaskRuntimeRecord,
    nextLifecycle: 'PAUSED' | 'FAILED',
    now: number,
    queueItem: QueueItemRecord | null
  ): TaskRuntimeRecord['runtime'] {
    const next = applyLifecycleTransition(runtimeRecord.runtime, nextLifecycle, now);
    return {
      ...next,
      interrupt: nextLifecycle === 'PAUSED'
        ? {
          pauseRequested: false,
          interruptRequested: false,
          cancelRequested: false,
          requestedAt: null,
          reason: 'Recovered after process restart.'
        }
        : next.interrupt,
      executionLease: {
        ...next.executionLease,
        active: false,
        phase: nextLifecycle === 'FAILED' ? 'INTERRUPTED' as const : 'PAUSED' as const,
        leaseId: null,
        startedAt: null,
        replayable: true
      },
      safePoint: {
        ...next.safePoint,
        reachedAt: now,
        interruptible: true
      },
      lastError: nextLifecycle === 'FAILED'
        ? (queueItem?.lastError ?? runtimeRecord.runtime.lastError ?? 'Task moved to failed state after restart recovery.')
        : runtimeRecord.runtime.lastError,
      updatedAt: now
    };
  }

  private async persistRecoveredTaskState(params: {
    runtimeRecord: TaskRuntimeRecord;
    nextRuntime: TaskRuntimeRecord['runtime'];
    queueItem: QueueItemRecord | null;
    now: number;
  }): Promise<void> {
    const { runtimeRecord, nextRuntime, queueItem, now } = params;
    const existingProjection = await this.foundation.projections.get(runtimeRecord.taskId);
    const projectionMetadata = {
      ...(existingProjection?.metadata ?? {}),
      recoveryReason: 'process_restart',
      recoveredFromLifecycleStatus: runtimeRecord.runtime.lifecycleStatus,
      previousQueueState: queueItem?.state ?? null,
      recoveredAt: now,
      ...(queueItem?.lastError ? { queueLastError: queueItem.lastError } : {})
    };
    const projection = existingProjection
      ? {
        ...existingProjection,
        status: nextRuntime.lifecycleStatus,
        currentUnitId: nextRuntime.currentUnitId,
        updatedAt: now,
        metadata: projectionMetadata
      }
      : buildTaskProjection({
        taskId: runtimeRecord.taskId,
        status: nextRuntime.lifecycleStatus,
        currentUnitId: nextRuntime.currentUnitId,
        latestSessionId: nextRuntime.latestSessionId,
        latestCorrelationId: nextRuntime.latestCorrelationId,
        latestTurnId: nextRuntime.latestTurnId,
        latestCheckpointId: nextRuntime.latestCheckpointId,
        explicitOutputCount: 0,
        trackerCount: nextRuntime.progressHistory.length,
        toolCallCount: 0,
        pendingCorrection: nextRuntime.pendingCorrection,
        metadata: projectionMetadata,
        updatedAt: now
      });

    await this.foundation.taskRuntimes.save({
      ...runtimeRecord,
      runtime: nextRuntime,
      latestCheckpointId: nextRuntime.latestCheckpointId,
      updatedAt: now
    });
    await this.foundation.tasks.save({
      taskId: runtimeRecord.taskId,
      status: nextRuntime.lifecycleStatus,
      currentUnitId: nextRuntime.currentUnitId,
      updatedAt: now,
      payload: {
        title: runtimeRecord.definition.title,
        intent: runtimeRecord.definition.intent,
        recoveryReason: 'process_restart',
        previousQueueState: queueItem?.state ?? null
      }
    });
    await this.foundation.projections.save(projection);
  }

  private async clearStaleQueueItem(queueItem: QueueItemRecord | null, now: number): Promise<void> {
    if (!this.foundation.queue || !queueItem || queueItem.state === 'DEAD_LETTER' || queueItem.state === 'COMPLETED') {
      return;
    }
    await this.foundation.queue.enqueue({
      ...queueItem,
      state: 'COMPLETED',
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: now
    });
  }

  async listActiveQueueItems(): Promise<QueueItemRecord[]> {
    if (!this.foundation.queue) {
      return [];
    }
    try {
      return await this.foundation.queue.listActive();
    } catch (error) {
      if (this.isMissingRelation(error)) {
        return [];
      }
      throw error;
    }
  }

  async recoverExpiredQueueLeases(now = Date.now()): Promise<number> {
    if (!this.foundation.queue) {
      return 0;
    }
    const recovered = await this.foundation.queue.releaseExpired(now);
    if (recovered > 0) {
      await this.foundation.logs.recordAudit({
        timestamp: now,
        severity: 'WARN',
        event: 'queue_leases_recovered',
        taskId: null,
        details: {
          recovered
        }
      });
    }
    return recovered;
  }

  async recoverInterruptedTasks(now = Date.now()): Promise<number> {
    let runtimes: TaskRuntimeRecord[] = [];
    try {
      runtimes = await this.foundation.taskRuntimes.list();
    } catch (error) {
      if (!this.isMissingRelation(error)) {
        throw error;
      }
    }
    const activeQueueItems = await this.listActiveQueueItems();
    const queueByTaskId = new Map(activeQueueItems.map(item => [item.taskId, item]));
    let recovered = 0;

    for (const runtimeRecord of runtimes) {
      const hasActiveExecutionLease = runtimeRecord.runtime.executionLease?.active === true;
      if (runtimeRecord.runtime.lifecycleStatus !== 'RUNNING' && !hasActiveExecutionLease) {
        continue;
      }
      const queueItem = queueByTaskId.get(runtimeRecord.taskId) ?? null;
      const nextLifecycle = queueItem?.state === 'DEAD_LETTER' ? 'FAILED' : 'PAUSED';
      const nextRuntime = this.createRecoveredRuntime(runtimeRecord, nextLifecycle, now, queueItem);

      await this.persistRecoveredTaskState({
        runtimeRecord,
        nextRuntime,
        queueItem,
        now
      });
      await this.clearStaleQueueItem(queueItem, now);
      await this.foundation.logs.recordAudit({
        timestamp: now,
        severity: nextLifecycle === 'FAILED' ? 'ERROR' : 'WARN',
        event: nextLifecycle === 'FAILED' ? 'task_failed_after_restart_recovery' : 'task_paused_after_restart_recovery',
        taskId: runtimeRecord.taskId,
        details: {
          previousLifecycleStatus: runtimeRecord.runtime.lifecycleStatus,
          previousQueueState: queueItem?.state ?? null
        }
      });
      if (queueItem && queueItem.state !== 'DEAD_LETTER' && queueItem.state !== 'COMPLETED') {
        await this.foundation.events.append(
          createRuntimeEventEnvelope({
            correlationId: `corr_queue_recovered_${runtimeRecord.taskId}`,
            sessionId: `sess_queue_recovered_${runtimeRecord.taskId}`,
            turnId: `turn_queue_recovered_${runtimeRecord.taskId}`,
            taskId: runtimeRecord.taskId,
            unitId: nextRuntime.currentUnitId,
            checkpointId: nextRuntime.latestCheckpointId,
            type: 'QUEUE_LEASE_RECOVERED',
            payload: {
              previousQueueState: queueItem.state,
              recoveredBy: 'startup'
            },
            timestamp: now
          })
        );
      }
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: `corr_restart_recovery_${runtimeRecord.taskId}`,
          sessionId: `sess_restart_recovery_${runtimeRecord.taskId}`,
          turnId: `turn_restart_recovery_${runtimeRecord.taskId}`,
          taskId: runtimeRecord.taskId,
          unitId: nextRuntime.currentUnitId,
          checkpointId: nextRuntime.latestCheckpointId,
          type: nextLifecycle === 'FAILED' ? 'TASK_FAILED' : 'TASK_PAUSED',
          payload: {
            recovery: 'PROCESS_RESTART',
            reason: 'Recovered after process restart.',
            previousLifecycleStatus: runtimeRecord.runtime.lifecycleStatus,
            previousQueueState: queueItem?.state ?? null,
            recoveredBy: 'startup'
          },
          timestamp: now
        })
      );
      recovered += 1;
    }

    return recovered;
  }

  async listDeadLetters(): Promise<QueueItemRecord[]> {
    if (!this.foundation.queue) {
      return [];
    }
    const active = await this.foundation.queue.listActive();
    return active.filter(record => record.state === 'DEAD_LETTER');
  }

  async requeueDeadLetter(taskId: string): Promise<boolean> {
    if (!this.foundation.queue) {
      return false;
    }
    const record = await this.foundation.queue.get(taskId);
    if (!record || record.state !== 'DEAD_LETTER') {
      return false;
    }
    await this.foundation.queue.enqueue({
      ...record,
      state: 'QUEUED',
      runAfter: Date.now(),
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: Date.now()
    });
    await this.foundation.logs.recordAudit({
      timestamp: Date.now(),
      severity: 'INFO',
      event: 'dead_letter_requeued',
      taskId,
      details: {
        previousError: record.lastError
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_dead_letter_requeued_${taskId}`,
        sessionId: `sess_dead_letter_requeued_${taskId}`,
        turnId: `turn_dead_letter_requeued_${taskId}`,
        taskId,
        unitId: null,
        checkpointId: null,
        type: 'TASK_DEAD_LETTER_REQUEUED',
        payload: {
          previousError: record.lastError
        }
      })
    );
    return true;
  }
}
