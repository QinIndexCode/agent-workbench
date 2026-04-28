import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { AcceptedOutputPersistenceInput } from './turn-persistence-types';

export class ValidatedOutputPersistence {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async persistAcceptedOutputs(params: {
    taskId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    currentUnitId: string;
    acceptedOutputs: AcceptedOutputPersistenceInput[];
  }): Promise<void> {
    for (const acceptedOutput of params.acceptedOutputs) {
      await this.foundation.validatedOutputs.save({
        taskId: params.taskId,
        unitId: acceptedOutput.unitId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        contractKeys: acceptedOutput.contractKeys,
        wrapper: acceptedOutput.wrapper,
        raw: acceptedOutput.raw,
        parsed: acceptedOutput.parsedJson,
        validatedAt: Date.now(),
        metadata: {
          currentUnitId: params.currentUnitId
        }
      });
    }
  }
}
