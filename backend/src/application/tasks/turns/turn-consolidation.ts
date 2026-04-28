import { ParsedTurn } from '../../../domain/contracts/types';
import { ConsolidationTurnOutput, consolidateStageTurn } from '../../../domain/validation';
import { ToolBatchExecutionResult } from '../../../foundation/repository';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';

export class TurnConsolidation {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async execute(params: {
    taskId: string;
    currentUnitId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    stageIndex: number | null;
    parsed: ParsedTurn;
    outputContract?: string;
    exitCondition?: string;
    stageUnits?: Array<{
      unitId: string;
      outputContract?: string;
      exitCondition?: string;
      trackerPolicy?: {
        allowEarlyTerminate?: boolean;
        requireToolEvidence?: boolean;
        emittedToolEvidenceCount?: number;
      };
      correctionContext?: import('../../../domain/validation').AcceptanceCorrectionContext;
    }>;
    batchExecutionResults: ToolBatchExecutionResult[];
    trackerPolicy?: {
      allowEarlyTerminate?: boolean;
      requireToolEvidence?: boolean;
      emittedToolEvidenceCount?: number;
    };
  }): Promise<ConsolidationTurnOutput> {
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'CONSOLIDATION_STARTED',
        payload: {
          stageIndex: params.stageIndex
        }
      })
    );

    const result = consolidateStageTurn({
      currentUnitId: params.currentUnitId,
      stageUnits: params.stageUnits,
      parsed: params.parsed,
      outputContract: params.outputContract,
      exitCondition: params.exitCondition,
      batchExecutionResults: params.batchExecutionResults,
      trackerPolicy: params.trackerPolicy
    });

    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'CONSOLIDATION_COMPLETED',
        payload: {
          stageIndex: params.stageIndex,
          ok: result.ok,
          blockingReason: result.blockingReason,
          pendingCorrection: result.pendingCorrection,
          issueCodes: result.issues.map((issue) => issue.code)
        }
      })
    );

    return result;
  }
}
