import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { TaskRecordService } from './task-record-service';
import { TaskTurnRuntimeControl } from './control/task-turn-runtime-control';
import { ToolDispatchOrchestrator } from './tools/tool-dispatch-orchestrator';
import { OperatorCommandService } from './control/operator-command-service';
import { ProviderFailurePersistence } from './persistence/provider-failure-persistence';
import { SuccessfulTurnPersistence } from './persistence/successful-turn-persistence';
import {
  ProviderFailurePersistenceInput,
  SuccessfulTurnPersistenceInput,
  TurnPersistenceResult
} from './persistence/turn-persistence-types';
import { TaskProjectionPersistence } from './persistence/task-projection-persistence';
import { ValidatedOutputPersistence } from './persistence/validated-output-persistence';
import { RuntimeCheckpointPersistence } from './persistence/runtime-checkpoint-persistence';

export type {
  ProviderFailurePersistenceInput,
  SuccessfulTurnPersistenceInput,
  TurnPersistenceResult
} from './persistence/turn-persistence-types';

export class TurnResultPersistence {
  private readonly providerFailurePersistence: ProviderFailurePersistence;
  private readonly successfulTurnPersistence: SuccessfulTurnPersistence;

  constructor(
    foundation: BackendNewFoundation,
    records: TaskRecordService,
    runtimeControl: TaskTurnRuntimeControl,
    toolDispatch: ToolDispatchOrchestrator,
    commandService: OperatorCommandService
  ) {
    const projectionPersistence = new TaskProjectionPersistence(foundation);
    const outputPersistence = new ValidatedOutputPersistence(foundation);
    const checkpointPersistence = new RuntimeCheckpointPersistence(foundation, records);
    this.providerFailurePersistence = new ProviderFailurePersistence(
      foundation,
      runtimeControl,
      projectionPersistence,
      checkpointPersistence
    );
    this.successfulTurnPersistence = new SuccessfulTurnPersistence(
      foundation,
      records,
      toolDispatch,
      commandService,
      outputPersistence,
      projectionPersistence,
      checkpointPersistence
    );
  }

  async persistProviderFailure(params: ProviderFailurePersistenceInput): Promise<void> {
    await this.providerFailurePersistence.persist(params);
  }

  async persistSuccessfulTurn(params: SuccessfulTurnPersistenceInput): Promise<TurnPersistenceResult> {
    return this.successfulTurnPersistence.persist(params);
  }
}
