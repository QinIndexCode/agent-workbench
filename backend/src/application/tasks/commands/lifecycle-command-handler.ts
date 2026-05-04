import crypto from 'node:crypto';
import { applyLifecycleTransition, createTaskRuntimeState } from '../../../domain/runtime/state-transition-applier';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { QueueItemRecord } from '../../../foundation/repository/types';
import { TaskActionInput, TaskActionResponse } from '../types';
import { TaskCommandHandlerServices, TaskLifecycleCommandHandler } from './command-handler-types';
import { deriveTaskArtifactRoutingSummary } from '../artifact-routing';

const DEFAULT_DIRECT_AUTO_RUN_MAX_TURNS = 6;
const MAX_DIRECT_AUTO_RUN_MAX_TURNS = 12;
const ACTIVE_QUEUE_STATES = new Set(['QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAITING']);

function now(): number {
  return Date.now();
}

function normalizeAutoRunMaxTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DIRECT_AUTO_RUN_MAX_TURNS;
  }
  return Math.max(1, Math.min(MAX_DIRECT_AUTO_RUN_MAX_TURNS, Math.floor(value)));
}

function createLifecycleCorrelationPrefix(eventType: string, taskId: string): string {
  return `${eventType.toLowerCase()}_${taskId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export class LifecycleCommandHandler implements TaskLifecycleCommandHandler {
  constructor(private readonly services: TaskCommandHandlerServices) {}

  private async enqueueTask(taskId: string, state: QueueItemRecord['state'] = 'QUEUED'): Promise<void> {
    if (!this.services.foundation.queue) {
      return;
    }
    const existing = await this.services.foundation.queue.get(taskId);
    const record = {
      taskId,
      state,
      runAfter: now(),
      priority: 0,
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: existing?.attemptCount ?? 0,
      maxRetries: this.services.foundation.config.queue.maxRetries,
      lastError: null,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now()
    };
    await this.services.foundation.queue.enqueue(record);
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_task_queued_${taskId}`,
        sessionId: `sess_task_queued_${taskId}`,
        turnId: `turn_task_queued_${taskId}`,
        taskId,
        unitId: null,
        checkpointId: null,
        type: 'TASK_QUEUED',
        payload: {
          state: record.state,
          runAfter: record.runAfter
        }
      })
      );
  }

  private getDirectAutoRunBlocker(response: TaskActionResponse): string | null {
    const task = response.task;
    const runtime = task.runtime;

    if (runtime.lifecycleStatus !== 'RUNNING') {
      return `lifecycle:${runtime.lifecycleStatus}`;
    }
    if (runtime.executionLease?.active) {
      return 'execution_lease_active';
    }
    if (task.queue?.state && ACTIVE_QUEUE_STATES.has(task.queue.state)) {
      return `queue:${task.queue.state}`;
    }
    if (task.pendingApprovals.length > 0 || runtime.awaitingApprovalInvocations.length > 0) {
      return 'approval_required';
    }
    if (runtime.awaitingToolDispatch.length > 0) {
      return 'tool_dispatch_pending';
    }
    if (runtime.pendingOperatorInputs.length > 0) {
      return 'operator_input_pending';
    }
    if (
      runtime.interrupt.pauseRequested
      || runtime.interrupt.interruptRequested
      || runtime.interrupt.cancelRequested
    ) {
      return 'interrupt_pending';
    }
    if (runtime.contractDiagnostics?.correctionLoopNonConvergent) {
      return 'correction_loop_non_convergent';
    }

    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: task.definition,
      invocations: task.toolInvocations,
      commands: task.commands
    });
    if (artifactRouting.needsExplicitDestination) {
      return 'artifact_destination_required';
    }
    if (task.delegationSummary?.activeChildTask) {
      return 'delegated_child_active';
    }
    if (task.primaryAction.kind !== 'continue_thread') {
      return `primary_action:${task.primaryAction.kind}`;
    }

    return null;
  }

  private async runDirectTurn(input: TaskActionInput, userMessage: string | undefined): Promise<TaskActionResponse> {
    let response = await this.services.turns.runTurn(input.taskId, userMessage);
    if (!input.autoRun) {
      return response;
    }

    const maxTurns = normalizeAutoRunMaxTurns(input.maxTurns);
    let turnsRun = 1;
    let blocker = this.getDirectAutoRunBlocker(response);
    while (!blocker && turnsRun < maxTurns) {
      turnsRun += 1;
      await this.services.foundation.logs.recordAudit({
        timestamp: now(),
        severity: 'INFO',
        event: 'direct_auto_run_continue',
        taskId: input.taskId,
        details: {
          turnIndex: turnsRun,
          maxTurns
        }
      });
      response = await this.services.turns.runTurn(input.taskId, undefined);
      blocker = this.getDirectAutoRunBlocker(response);
    }

    if (!blocker) {
      blocker = 'max_turns_reached';
      await this.services.foundation.logs.recordAudit({
        timestamp: now(),
        severity: 'WARN',
        event: 'direct_auto_run_stopped',
        taskId: input.taskId,
        details: {
          reason: blocker,
          turnsRun,
          maxTurns
        }
      });
    } else if (turnsRun > 1) {
      await this.services.foundation.logs.recordAudit({
        timestamp: now(),
        severity: 'INFO',
        event: 'direct_auto_run_stopped',
        taskId: input.taskId,
        details: {
          reason: blocker,
          turnsRun,
          maxTurns
        }
      });
    }

    return response;
  }

  private async startLike(
    input: TaskActionInput,
    allowed: Array<'SUBMITTED' | 'RUNNING' | 'PAUSED' | 'FAILED' | 'COMPLETED' | 'CANCELLED'>,
    nextLifecycle: 'RUNNING',
    eventType: 'TASK_STARTED' | 'TASK_RESUMED' | 'TASK_RESTARTED' | 'TASK_CONTINUE_QUEUED',
    restart = false
  ): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, allowed, eventType.toLowerCase());
    const runtime = restart
      ? applyLifecycleTransition(createTaskRuntimeState(record.definition, record.runtime.createdAt), nextLifecycle)
      : applyLifecycleTransition(record.runtime, nextLifecycle);
    await this.services.records.saveTaskRuntimeRecord({
      definition: record.definition,
      runtime,
      activeProviderId: restart ? record.definition.preferredProviderId : record.activeProviderId
    });
    const lifecycleEventKey = createLifecycleCorrelationPrefix(eventType, input.taskId);
    await this.services.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${lifecycleEventKey}`,
        sessionId: `sess_${lifecycleEventKey}`,
        turnId: `turn_${lifecycleEventKey}`,
        taskId: input.taskId,
        unitId: runtime.currentUnitId,
        checkpointId: runtime.latestCheckpointId,
        type: eventType,
        payload: {}
      })
    );

    if (this.services.foundation.queue && !input.userMessage?.trim()) {
      await this.enqueueTask(input.taskId);
      return {
        command: this.services.records.createCommandResult(input.taskId, runtime.lifecycleStatus, 'Task queued for worker execution.'),
        task: await this.services.queries.getTask(input.taskId)
      };
    }

    return this.runDirectTurn(input, input.userMessage);
  }

  async startTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.startLike(input, ['SUBMITTED'], 'RUNNING', 'TASK_STARTED');
  }

  async continueTask(input: TaskActionInput): Promise<TaskActionResponse> {
    let record = await this.services.records.loadRuntimeRecord(input.taskId);
    const trimmedMessage = input.userMessage?.trim() ?? '';
    const continuingCompletedThread = record.runtime.lifecycleStatus === 'COMPLETED' && trimmedMessage.length > 0;

    if (record.runtime.lifecycleStatus === 'COMPLETED' && trimmedMessage.length === 0) {
      throw new Error(
        'backend_new task error: continue task requires an explicit follow-up message after the thread is completed.'
      );
    }

    if (continuingCompletedThread) {
      const resumedRuntime = applyLifecycleTransition(
        createTaskRuntimeState(record.definition, record.runtime.createdAt),
        'RUNNING'
      );
      await this.services.records.saveTaskRuntimeRecord({
        definition: record.definition,
        runtime: resumedRuntime,
        activeProviderId: record.activeProviderId
      });
      await this.services.foundation.tasks.save({
        taskId: input.taskId,
        status: resumedRuntime.lifecycleStatus,
        currentUnitId: resumedRuntime.currentUnitId,
        updatedAt: resumedRuntime.updatedAt,
        payload: {
          title: record.definition.title,
          intent: record.definition.intent
        }
      });
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_task_thread_continued',
          sessionId: 'sess_task_thread_continued',
          turnId: 'turn_task_thread_continued',
          taskId: input.taskId,
          unitId: resumedRuntime.currentUnitId,
          checkpointId: resumedRuntime.latestCheckpointId,
          type: 'TASK_RESUMED',
          payload: {
            sourceLifecycleStatus: 'COMPLETED',
            continuationMode: 'same_thread'
          }
        })
      );
      record = {
        ...record,
        runtime: resumedRuntime
      };
    } else {
      this.services.records.assertLifecycleAllowed(record.runtime, ['RUNNING'], 'continue task');
    }

    const [toolInvocations, commands] = await Promise.all([
      this.services.foundation.toolInvocations.listLatest(input.taskId),
      this.services.foundation.commands.listLatest(input.taskId)
    ]);
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: record.definition,
      invocations: toolInvocations,
      commands
    });
    const correctiveFollowUpAllowed = trimmedMessage.length > 0
      && (
        record.runtime.pendingCorrection !== 'NONE'
        || !!record.runtime.contractDiagnostics?.lastPendingCorrectionKind
        || record.runtime.contractDiagnostics?.correctionLoopNonConvergent === true
      );
    if (artifactRouting.needsExplicitDestination && !correctiveFollowUpAllowed) {
      const recommended = artifactRouting.recommendedArtifactDir
        ? ` Recommended directory: ${artifactRouting.recommendedArtifactDir}.`
        : '';
      throw new Error(
        `backend_new task error: continue task requires a project-relative destination before proceeding because generated artifacts are still only in the task workspace.${recommended}`
      );
    }
    if (record.runtime.contractDiagnostics?.correctionLoopNonConvergent && trimmedMessage.length === 0) {
      throw new Error(
        'backend_new task error: continue task requires explicit operator guidance because the task is in a non-convergent correction loop.'
      );
    }
    if (this.services.foundation.queue && trimmedMessage.length === 0) {
      await this.enqueueTask(input.taskId);
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_task_continue_queued',
          sessionId: 'sess_task_continue_queued',
          turnId: 'turn_task_continue_queued',
          taskId: input.taskId,
          unitId: record.runtime.currentUnitId,
          checkpointId: record.runtime.latestCheckpointId,
          type: 'TASK_CONTINUE_QUEUED',
          payload: {}
        })
      );
      return {
        command: this.services.records.createCommandResult(input.taskId, record.runtime.lifecycleStatus, 'Task queued for next turn.'),
        task: await this.services.queries.getTask(input.taskId)
      };
    }
    return this.runDirectTurn(input, trimmedMessage || undefined);
  }

  async pauseTask(input: TaskActionInput, commandId: string | null): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, ['RUNNING'], 'pause task');
    const executionLease = record.runtime.executionLease ?? {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    };
    const active = executionLease.active;
    const paused = active
      ? {
        ...record.runtime,
        interrupt: {
          ...record.runtime.interrupt,
          pauseRequested: true,
          requestedAt: Date.now(),
          reason: input.reason ?? 'pause requested'
        },
        executionLease: {
          ...executionLease,
          phase: 'WAITING_SAFE_POINT' as const
        },
        updatedAt: Date.now()
      }
      : applyLifecycleTransition(record.runtime, 'PAUSED');
    await this.services.records.saveTaskRuntimeRecord({
      definition: record.definition,
      runtime: paused,
      activeProviderId: record.activeProviderId
    });
    await this.services.foundation.tasks.save({
      taskId: input.taskId,
      status: paused.lifecycleStatus,
      currentUnitId: paused.currentUnitId,
      updatedAt: paused.updatedAt,
      payload: {
        title: record.definition.title,
        intent: record.definition.intent
      }
    });
    if (active) {
      const interruptRecord = this.services.commands.createInterruptRequest({
        taskId: input.taskId,
        commandId,
        reason: input.reason ?? 'pause requested',
        requestedBy: input.actor ?? null,
        metadata: {
          kind: 'pause'
        }
      });
      await this.services.foundation.interrupts.append(interruptRecord);
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_interrupt_requested',
          sessionId: 'sess_interrupt_requested',
          turnId: 'turn_interrupt_requested',
          taskId: input.taskId,
          unitId: paused.currentUnitId,
          checkpointId: paused.latestCheckpointId,
          type: 'INTERRUPT_REQUESTED',
          payload: {
            kind: 'pause',
            pauseRequested: true
          }
        })
      );
    } else {
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_task_paused',
          sessionId: 'sess_task_paused',
          turnId: 'turn_task_paused',
          taskId: input.taskId,
          unitId: paused.currentUnitId,
          checkpointId: paused.latestCheckpointId,
          type: 'TASK_PAUSED',
          payload: {}
        })
      );
    }
    return {
      command: this.services.records.createCommandResult(input.taskId, paused.lifecycleStatus, active ? 'Pause requested.' : 'Task paused.'),
      task: await this.services.queries.getTask(input.taskId)
    };
  }

  async resumeTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.startLike(input, ['PAUSED'], 'RUNNING', 'TASK_RESUMED');
  }

  async restartTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.startLike(input, ['RUNNING', 'PAUSED', 'FAILED', 'COMPLETED', 'CANCELLED'], 'RUNNING', 'TASK_RESTARTED', true);
  }

  async cancelTask(input: import('../types').SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse> {
    const record = await this.services.records.loadRuntimeRecord(input.taskId);
    this.services.records.assertLifecycleAllowed(record.runtime, ['SUBMITTED', 'RUNNING', 'PAUSED'], 'cancel task');
    const timestamp = Date.now();
    const reason = input.reason ?? input.message ?? 'cancel requested';
    const executionLease = record.runtime.executionLease ?? {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    };
    const active = executionLease.active;
    const nextRuntime = active
      ? {
        ...record.runtime,
        interrupt: {
          ...record.runtime.interrupt,
          cancelRequested: true,
          interruptRequested: true,
          requestedAt: timestamp,
          reason
        },
        executionLease: {
          ...executionLease,
          phase: 'WAITING_SAFE_POINT' as const
        },
        updatedAt: timestamp
      }
      : {
        ...applyLifecycleTransition(record.runtime, 'CANCELLED', timestamp),
        currentUnitId: null,
        interrupt: {
          pauseRequested: false,
          interruptRequested: false,
          cancelRequested: false,
          requestedAt: null,
          reason
        }
      };
    await this.services.records.saveTaskRuntimeRecord({
      definition: record.definition,
      runtime: nextRuntime,
      activeProviderId: record.activeProviderId
    });
    this.services.interrupts.requestInterrupt(input.taskId);
    const interruptRecord = this.services.commands.createInterruptRequest({
      taskId: input.taskId,
      commandId,
      reason,
      requestedBy: input.actor ?? null,
      metadata: {
        kind: 'cancel'
      }
    });
    await this.services.foundation.interrupts.append(interruptRecord);
    if (active) {
      this.services.interrupts.requestInterrupt(input.taskId);
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_interrupt_requested_cancel',
          sessionId: 'sess_interrupt_requested_cancel',
          turnId: 'turn_interrupt_requested_cancel',
          taskId: input.taskId,
          unitId: nextRuntime.currentUnitId,
          checkpointId: nextRuntime.latestCheckpointId,
          type: 'INTERRUPT_REQUESTED',
          payload: {
            kind: 'cancel',
            cancelRequested: true
          }
        })
      );
    } else {
      await this.services.foundation.tasks.save({
        taskId: input.taskId,
        status: nextRuntime.lifecycleStatus,
        currentUnitId: nextRuntime.currentUnitId,
        updatedAt: nextRuntime.updatedAt,
        payload: {
          title: record.definition.title,
          intent: record.definition.intent
        }
      });
      await this.services.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: 'corr_task_cancelled',
          sessionId: 'sess_task_cancelled',
          turnId: 'turn_task_cancelled',
          taskId: input.taskId,
          unitId: nextRuntime.currentUnitId,
          checkpointId: nextRuntime.latestCheckpointId,
          type: 'TASK_CANCELLED',
          payload: {
            reason
          }
        })
      );
    }
    return {
      command: this.services.records.createCommandResult(
        input.taskId,
        nextRuntime.lifecycleStatus,
        active ? 'Cancellation requested.' : 'Task cancelled.'
      ),
      task: await this.services.queries.getTask(input.taskId)
    };
  }
}
