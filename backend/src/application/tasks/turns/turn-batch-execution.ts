import { ParsedTurn } from '../../../domain/contracts/types';
import { ToolBatchExecutorService, ToolBatchPlanAndExecutionResult } from '../tools/tool-batch-executor-service';

export class TurnBatchExecution {
  constructor(private readonly batchExecutor: ToolBatchExecutorService) {}

  execute(params: {
    taskId: string;
    currentUnitId: string;
    runtime: import('../../../domain/contracts/types').TaskRuntimeState;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    activeStage: {
      stageIndex: number;
      unitIds: string[];
    } | null;
    toolCallFormat: 'json-or-xml' | 'json';
    allowedToolIdsByUnitId: Record<string, string[] | null>;
    plannedToolBatches: Array<{
      batchId: string;
      stageIndex: number;
      unitIds: string[];
      hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
    }>;
    parsed: ParsedTurn;
  }): Promise<ToolBatchPlanAndExecutionResult> {
    return this.batchExecutor.planAndExecute({
      taskId: params.taskId,
      currentUnitId: params.currentUnitId,
      runtime: params.runtime,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      activeStage: params.activeStage,
      toolCallFormat: params.toolCallFormat,
      allowedToolIdsByUnitId: params.allowedToolIdsByUnitId,
      plannedBatches: params.plannedToolBatches,
      parsedToolCalls: params.parsed.toolCalls
    });
  }
}
