import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { applyLifecycleTransition } from '../../domain/runtime/state-transition-applier';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import { buildTaskProjection } from '../../foundation/projection/projection-builder';
import { TaskTurnRunner } from '../tasks/task-turn-runner';
import { TaskRecordService } from '../tasks/task-record-service';
import { ToolDispatchOrchestrator } from '../tasks/tools/tool-dispatch-orchestrator';
import { InterruptController } from '../tasks/control/interrupt-controller';
import { OperatorCommandService } from '../tasks/control/operator-command-service';

export class QueueWorkerService {
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly turns: TaskTurnRunner;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly foundation: BackendNewFoundation, workerId = `worker_${process.pid}`) {
    this.workerId = workerId;
    this.turns = new TaskTurnRunner(
      foundation,
      new TaskRecordService(foundation),
      new ToolDispatchOrchestrator(
        foundation.config,
        foundation.extensions,
        foundation.toolExecutors,
        foundation.toolInvocations,
        foundation.approvals,
        foundation.events,
        foundation.logs
      ),
      new InterruptController(),
      new OperatorCommandService(foundation)
    );
  }

  start(): void {
    if (!this.foundation.queue || !this.foundation.config.worker.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.inFlight.size >= this.foundation.config.worker.concurrency) {
        return;
      }
      const run = this.tick().finally(() => {
        this.inFlight.delete(run);
      });
      this.inFlight.add(run);
    }, this.foundation.config.worker.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  async tick(): Promise<void> {
    if (!this.foundation.queue) {
      return;
    }
    const now = Date.now();
    await this.foundation.queue.releaseExpired(now);
    const claim = await this.foundation.queue.claimNext({
      workerId: this.workerId,
      now,
      leaseMs: this.foundation.config.queue.leaseMs
    });
    if (!claim) {
      return;
    }

    await this.foundation.queue.markRunning({
      taskId: claim.taskId,
      workerId: claim.workerId,
      claimToken: claim.claimToken,
      now
    });
    await this.foundation.logs.recordAudit({
      timestamp: now,
      severity: 'INFO',
      event: 'queue_claimed',
      taskId: claim.taskId,
      details: {
        workerId: claim.workerId,
        claimToken: claim.claimToken,
        attempt: claim.attempt
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_queue_claimed_${claim.taskId}`,
        sessionId: `sess_queue_claimed_${claim.taskId}`,
        turnId: `turn_queue_claimed_${claim.taskId}`,
        taskId: claim.taskId,
        unitId: null,
        checkpointId: null,
        type: 'QUEUE_CLAIMED',
        payload: {
          workerId: claim.workerId,
          claimToken: claim.claimToken,
          attempt: claim.attempt
        }
      })
    );

    const heartbeat = setInterval(() => {
      void this.foundation.queue?.heartbeat({
        taskId: claim.taskId,
        workerId: claim.workerId,
        claimToken: claim.claimToken,
        leaseMs: this.foundation.config.queue.leaseMs,
        now: Date.now()
      });
    }, this.foundation.config.worker.heartbeatMs);

    try {
      const result = await this.turns.runTurn(claim.taskId, undefined);
      if (result.task.runtime.lifecycleStatus === 'RUNNING') {
        await this.foundation.queue.enqueue({
          taskId: claim.taskId,
          state: 'QUEUED',
          runAfter: Date.now(),
          priority: 0,
          leaseOwner: null,
          claimToken: null,
          leaseExpiresAt: null,
          attemptCount: 0,
          maxRetries: this.foundation.config.queue.maxRetries,
          lastError: null,
          createdAt: now,
          updatedAt: Date.now()
        });
        await this.foundation.logs.recordAudit({
          timestamp: Date.now(),
          severity: 'INFO',
          event: 'queue_requeued_for_next_turn',
          taskId: claim.taskId,
          details: {
            workerId: claim.workerId
          }
        });
      } else {
        await this.foundation.queue.complete({
          taskId: claim.taskId,
          workerId: claim.workerId,
          claimToken: claim.claimToken,
          now: Date.now()
        });
      }
    } catch (error) {
      const failedAt = Date.now();
      const failedRecord = await this.foundation.queue.fail({
        taskId: claim.taskId,
        workerId: claim.workerId,
        claimToken: claim.claimToken,
        now: failedAt,
        retryDelayMs: this.foundation.config.queue.retryDelayMs,
        maxRetries: this.foundation.config.queue.maxRetries,
        error: error instanceof Error ? error.message : 'Unknown queue worker failure.'
      });
      if (failedRecord) {
        const runtimeRecord = await this.foundation.taskRuntimes.get(claim.taskId);
        const projectionRecord = await this.foundation.projections.get(claim.taskId);
        const projectionSummary = projectionRecord?.summary;
        const projectionMetadata = projectionRecord?.metadata ?? {};
        const failedRuntime = failedRecord.state === 'DEAD_LETTER' && runtimeRecord
          ? {
            ...applyLifecycleTransition(runtimeRecord.runtime, 'FAILED', failedAt),
            executionLease: {
              ...runtimeRecord.runtime.executionLease,
              active: false,
              phase: 'INTERRUPTED' as const,
              leaseId: null,
              startedAt: null,
              replayable: true
            },
            lastError: failedRecord.lastError ?? runtimeRecord.runtime.lastError,
            updatedAt: failedAt
          }
          : runtimeRecord?.runtime ?? null;

        if (runtimeRecord && failedRuntime && failedRecord.state === 'DEAD_LETTER') {
          await this.foundation.taskRuntimes.save({
            taskId: runtimeRecord.taskId,
            definition: runtimeRecord.definition,
            runtime: failedRuntime,
            activeProviderId: runtimeRecord.activeProviderId,
            latestCheckpointId: failedRuntime.latestCheckpointId,
            updatedAt: failedAt
          });
          await this.foundation.tasks.save({
            taskId: runtimeRecord.taskId,
            status: failedRuntime.lifecycleStatus,
            currentUnitId: failedRuntime.currentUnitId,
            updatedAt: failedAt,
            payload: {
              title: runtimeRecord.definition.title,
              intent: runtimeRecord.definition.intent,
              queueState: failedRecord.state,
              queueLastError: failedRecord.lastError
            }
          });
        }

        await this.foundation.logs.recordAudit({
          timestamp: failedAt,
          severity: failedRecord.state === 'DEAD_LETTER' ? 'ERROR' : 'WARN',
          event: failedRecord.state === 'DEAD_LETTER' ? 'task_dead_lettered' : 'queue_retry_scheduled',
          taskId: claim.taskId,
          details: {
            state: failedRecord.state,
            attemptCount: failedRecord.attemptCount,
            lastError: failedRecord.lastError
          }
        });
        await this.foundation.projections.save(
          projectionRecord
            ? {
              ...projectionRecord,
              status: failedRuntime?.lifecycleStatus ?? runtimeRecord?.runtime.lifecycleStatus ?? 'RUNNING',
              currentUnitId: failedRuntime?.currentUnitId ?? runtimeRecord?.runtime.currentUnitId ?? null,
              latestSessionId: failedRuntime?.latestSessionId ?? runtimeRecord?.runtime.latestSessionId ?? null,
              latestCorrelationId: failedRuntime?.latestCorrelationId ?? runtimeRecord?.runtime.latestCorrelationId ?? null,
              latestTurnId: failedRuntime?.latestTurnId ?? runtimeRecord?.runtime.latestTurnId ?? null,
              latestCheckpointId: failedRuntime?.latestCheckpointId ?? runtimeRecord?.runtime.latestCheckpointId ?? null,
              updatedAt: failedAt,
              metadata: {
                ...projectionMetadata,
                queueState: failedRecord.state,
                queueLastError: failedRecord.lastError
              }
            }
            : buildTaskProjection({
              taskId: claim.taskId,
              status: failedRuntime?.lifecycleStatus ?? runtimeRecord?.runtime.lifecycleStatus ?? 'RUNNING',
              currentUnitId: failedRuntime?.currentUnitId ?? runtimeRecord?.runtime.currentUnitId ?? null,
              latestSessionId: failedRuntime?.latestSessionId ?? runtimeRecord?.runtime.latestSessionId ?? null,
              latestCorrelationId: failedRuntime?.latestCorrelationId ?? runtimeRecord?.runtime.latestCorrelationId ?? null,
              latestTurnId: failedRuntime?.latestTurnId ?? runtimeRecord?.runtime.latestTurnId ?? null,
              latestCheckpointId: failedRuntime?.latestCheckpointId ?? runtimeRecord?.runtime.latestCheckpointId ?? null,
              explicitOutputCount: projectionSummary?.explicitOutputCount ?? 0,
              trackerCount: failedRuntime?.progressHistory.length ?? runtimeRecord?.runtime.progressHistory.length ?? 0,
              toolCallCount: projectionSummary?.toolCallCount ?? 0,
              pendingCorrection: failedRuntime?.pendingCorrection ?? runtimeRecord?.runtime.pendingCorrection ?? 'NONE',
              metadata: {
                ...projectionMetadata,
                queueState: failedRecord.state,
                queueLastError: failedRecord.lastError
              },
              updatedAt: failedAt
            })
        );
        await this.foundation.events.append(
          createRuntimeEventEnvelope({
            correlationId: failedRuntime?.latestCorrelationId ?? runtimeRecord?.runtime.latestCorrelationId ?? `corr_queue_fail_${claim.taskId}`,
            sessionId: failedRuntime?.latestSessionId ?? runtimeRecord?.runtime.latestSessionId ?? `sess_queue_fail_${claim.taskId}`,
            turnId: failedRuntime?.latestTurnId ?? runtimeRecord?.runtime.latestTurnId ?? `turn_queue_fail_${claim.taskId}`,
            taskId: claim.taskId,
            unitId: failedRuntime?.currentUnitId ?? runtimeRecord?.runtime.currentUnitId ?? null,
            checkpointId: failedRuntime?.latestCheckpointId ?? runtimeRecord?.runtime.latestCheckpointId ?? null,
            type: failedRecord.state === 'DEAD_LETTER' ? 'TASK_DEAD_LETTERED' : 'QUEUE_RETRY_SCHEDULED',
            payload: {
              state: failedRecord.state,
              attemptCount: failedRecord.attemptCount,
              lastError: failedRecord.lastError
            }
          })
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
