import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { applyLifecycleTransition } from '../../../domain/runtime/state-transition-applier';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { TaskActionResponse } from '../types';
import { TaskRecordService } from '../task-record-service';

export class TaskTurnRuntimeControl {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly records: TaskRecordService
  ) {}

  async saveRuntimeState(params: {
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
  }): Promise<void> {
    await this.records.saveTaskRuntimeRecord({
      definition: params.definition,
      runtime: params.runtime,
      activeProviderId: params.activeProviderId
    });
  }

  async recordSafePoint(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
    stage: TaskRuntimeState['safePoint']['stage'];
    interruptible: boolean;
    correlationId: string;
    sessionId: string;
    turnId: string;
    checkpointId: string;
  }): Promise<TaskRuntimeState> {
    const nextRuntime: TaskRuntimeState = {
      ...params.runtime,
      safePoint: {
        stage: params.stage,
        reachedAt: Date.now(),
        interruptible: params.interruptible
      },
      updatedAt: Date.now()
    };
    await this.saveRuntimeState({
      definition: params.definition,
      runtime: nextRuntime,
      activeProviderId: params.activeProviderId
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: nextRuntime.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'SAFE_POINT_REACHED',
        payload: {
          stage: params.stage,
          interruptible: params.interruptible
        }
      })
    );
    return nextRuntime;
  }

  async resolveInterruptAtSafePoint(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
    message: string;
  }): Promise<TaskActionResponse | null> {
    if (params.runtime.interrupt.cancelRequested) {
      const cancelled: TaskRuntimeState = {
        ...applyLifecycleTransition(params.runtime, 'CANCELLED'),
        currentUnitId: null,
        interrupt: {
          pauseRequested: false,
          interruptRequested: false,
          cancelRequested: false,
          requestedAt: null,
          reason: params.runtime.interrupt.reason
        },
        safePoint: {
          ...params.runtime.safePoint,
          interruptible: true
        },
        updatedAt: Date.now()
      };
      await this.saveRuntimeState({
        definition: params.definition,
        runtime: cancelled,
        activeProviderId: params.activeProviderId
      });
      await this.foundation.tasks.save({
        taskId: params.taskId,
        status: cancelled.lifecycleStatus,
        currentUnitId: cancelled.currentUnitId,
        updatedAt: cancelled.updatedAt,
        payload: {
          title: params.definition.title,
          intent: params.definition.intent
        }
      });
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: `corr_interrupt_cancelled_${params.taskId}`,
          sessionId: `sess_interrupt_cancelled_${params.taskId}`,
          turnId: `turn_interrupt_cancelled_${params.taskId}`,
          taskId: params.taskId,
          unitId: cancelled.currentUnitId,
          checkpointId: cancelled.latestCheckpointId,
          type: 'TASK_CANCELLED',
          payload: {
            reason: params.runtime.interrupt.reason ?? 'cancel applied at safe point'
          }
        })
      );
      return {
        command: this.records.createCommandResult(params.taskId, cancelled.lifecycleStatus, params.message),
        task: await this.records.buildTaskQuery(params.taskId)
      };
    }

    if (params.runtime.interrupt.pauseRequested || params.runtime.interrupt.interruptRequested) {
      const paused: TaskRuntimeState = {
        ...params.runtime,
        lifecycleStatus: 'PAUSED',
        engineStatus: 'PAUSED',
        executionLease: {
          ...params.runtime.executionLease,
          active: false,
          phase: 'PAUSED'
        },
        interrupt: {
          pauseRequested: false,
          interruptRequested: false,
          cancelRequested: false,
          requestedAt: null,
          reason: params.runtime.interrupt.reason
        },
        updatedAt: Date.now()
      };
      await this.saveRuntimeState({
        definition: params.definition,
        runtime: paused,
        activeProviderId: params.activeProviderId
      });
      await this.foundation.tasks.save({
        taskId: params.taskId,
        status: paused.lifecycleStatus,
        currentUnitId: paused.currentUnitId,
        updatedAt: paused.updatedAt,
        payload: {
          title: params.definition.title,
          intent: params.definition.intent
        }
      });
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: `corr_interrupt_applied_${params.taskId}`,
          sessionId: `sess_interrupt_applied_${params.taskId}`,
          turnId: `turn_interrupt_applied_${params.taskId}`,
          taskId: params.taskId,
          unitId: paused.currentUnitId,
          checkpointId: paused.latestCheckpointId,
          type: 'TASK_PAUSED',
          payload: {
            reason: params.runtime.interrupt.reason ?? 'interrupt applied at safe point'
          }
        })
      );
      return {
        command: this.records.createCommandResult(params.taskId, paused.lifecycleStatus, params.message),
        task: await this.records.buildTaskQuery(params.taskId)
      };
    }

    return null;
  }
}
