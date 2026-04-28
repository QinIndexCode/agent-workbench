import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { TaskPlannerService } from '../planning/task-planner-service';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';

export interface TurnPlannerExecutionResult {
  planVersion: string;
  activeStage: {
    stageIndex: number;
    unitIds: string[];
    entryUnitIds: string[];
    exitUnitIds: string[];
    batchGroupingHint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
  } | null;
  readyStageUnitIds: string[];
  plannedProviderBatches: Array<{
    batchId: string;
    stageIndex: number;
    unitIds: string[];
    hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
  }>;
  plannedToolBatches: Array<{
    batchId: string;
    stageIndex: number;
    unitIds: string[];
    hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
  }>;
  fallbackToSingleActive: boolean;
  fallbackReasons: string[];
  fallbackReason: string | null;
}

export class TurnPlannerExecution {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly planner: TaskPlannerService
  ) {}

  async execute(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    correlationId: string;
    sessionId: string;
    turnId: string;
    checkpointId: string;
  }): Promise<TurnPlannerExecutionResult> {
    const computation = this.planner.createTurn(params.definition, params.runtime);
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.runtime.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'PLAN_CREATED',
        payload: {
          planVersion: computation.output.planVersion,
          activeStage: computation.output.activeStage,
          readyStageUnitIds: computation.output.readyStageUnitIds,
          plannedProviderBatches: computation.output.plannedProviderBatches,
          plannedToolBatches: computation.output.plannedToolBatches,
          fallbackToSingleActive: computation.output.fallbackToSingleActive,
          fallbackReasons: computation.output.fallbackReasons,
          fallbackReason: computation.output.fallbackReason
        }
      })
    );
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.runtime.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'PLAN_VALIDATED',
        payload: {
          ok: computation.validation.ok,
          issues: computation.validation.issues,
          plannerIssues: computation.validation.plannerIssues
        }
      })
    );

    if (!computation.validation.ok) {
      throw new Error(
        `backend_new task error: PLANNER_OUTPUT_INVALID. ${[
          ...computation.validation.issues.map((issue) => issue.message),
          ...computation.validation.plannerIssues.map((issue) => issue.message)
        ].join(' ')}`
      );
    }

    return {
      planVersion: computation.output.planVersion,
      activeStage: computation.output.activeStage,
      readyStageUnitIds: [...computation.output.readyStageUnitIds],
      plannedProviderBatches: computation.output.plannedProviderBatches.map((batch) => ({
        batchId: batch.batchId,
        stageIndex: batch.stageIndex,
        unitIds: [...batch.unitIds],
        hint: batch.hint
      })),
      plannedToolBatches: computation.output.plannedToolBatches.map((batch) => ({
        batchId: batch.batchId,
        stageIndex: batch.stageIndex,
        unitIds: [...batch.unitIds],
        hint: batch.hint
      })),
      fallbackToSingleActive: computation.output.fallbackToSingleActive,
      fallbackReasons: [...computation.output.fallbackReasons],
      fallbackReason: computation.output.fallbackReason
    };
  }
}
