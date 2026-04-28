import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { TaskRecordService } from '../task-record-service';

export class RuntimeCheckpointPersistence {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly records: TaskRecordService
  ) {}

  async persist(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
    skipTerminalImprovementRefresh?: boolean;
    correlationId: string;
    sessionId: string;
    turnId: string;
    checkpointId: string;
    unitId: string | null;
  }): Promise<void> {
    await this.foundation.logs.writeCheckpoint({
      timestamp: Date.now(),
      checkpointId: params.checkpointId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      taskId: params.taskId,
      unitId: params.unitId,
      state: {
        runtime: params.runtime
      }
    });
    await this.foundation.checkpoints.save({
      taskId: params.taskId,
      timestamp: Date.now(),
      state: {
        runtime: params.runtime
      }
    });
    await this.records.saveTaskRuntimeRecord({
      definition: params.definition,
      runtime: params.runtime,
      activeProviderId: params.activeProviderId,
      skipTerminalImprovementRefresh: params.skipTerminalImprovementRefresh
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.unitId,
        checkpointId: params.checkpointId,
        type: 'CHECKPOINT_WRITTEN',
        payload: {
          lifecycleStatus: params.runtime.lifecycleStatus,
          engineStatus: params.runtime.engineStatus
        }
      })
    );
  }
}
