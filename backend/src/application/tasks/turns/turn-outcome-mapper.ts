import { ConsolidationTurnOutput } from '../../../domain/validation';
import { applyRejectedToolCallsToAcceptance, orchestrateTurn } from '../../../domain/runtime/turn-orchestrator';
import { ToolBatchPlanAndExecutionResult } from '../tools/tool-batch-executor-service';
import { TurnPhaseOutcome } from './turn-phase-types';
import { TurnPlannerExecutionResult } from './turn-planner-execution';
import { AcceptanceCorrectionContext, TrackerSemanticPolicy } from '../../../domain/validation';

export function mapPlannerStageOutcome(params: {
  currentUnitId: string;
  plannerTurn: TurnPlannerExecutionResult;
  batchExecution: ToolBatchPlanAndExecutionResult;
  consolidation: ConsolidationTurnOutput;
  parsed: ReturnType<typeof orchestrateTurn>['parsed'];
}): TurnPhaseOutcome {
  const failedStageUnit = params.consolidation.stageAcceptance?.unitResults.find((result) => !result.acceptance.ok);
  const primaryStageResult = params.consolidation.stageAcceptance?.unitResults.find((result) => result.unitId === params.currentUnitId)
    ?? failedStageUnit
    ?? params.consolidation.stageAcceptance?.unitResults[0]
    ?? null;
  const primaryAcceptance = applyRejectedToolCallsToAcceptance({
    acceptance: primaryStageResult?.acceptance ?? params.consolidation.acceptance,
    rejectedToolCalls: params.batchExecution.rejected
  });

  return {
    plannedTools: {
      accepted: params.batchExecution.acceptedInvocationIds.length + params.batchExecution.approvalInvocationIds.length,
      approvalRequired: params.batchExecution.approvalInvocationIds.length,
      rejected: params.batchExecution.rejected,
      acceptedInvocationIds: params.batchExecution.acceptedInvocationIds,
      approvalInvocationIds: params.batchExecution.approvalInvocationIds
    },
    orchestrated: {
      parsed: params.parsed,
      acceptance: params.consolidation.ok
        ? primaryAcceptance
        : {
          ...primaryAcceptance,
          ok: false,
          pendingCorrection: primaryAcceptance.pendingCorrection === 'NONE'
            ? params.consolidation.pendingCorrection
            : primaryAcceptance.pendingCorrection,
          issues: [...params.consolidation.issues, ...primaryAcceptance.issues]
        },
      plannedTools: {
        acceptedInvocationIds: params.batchExecution.acceptedInvocationIds,
        approvalInvocationIds: params.batchExecution.approvalInvocationIds,
        rejectedToolCalls: params.batchExecution.rejected
      }
    },
    diagnosticsAcceptance: primaryAcceptance,
    acceptedOutputs: params.consolidation.stageAcceptance?.unitResults
      .flatMap((result) => {
        const acceptedOutput = result.acceptance.acceptedOutput;
        if (!acceptedOutput || acceptedOutput.parsedJson === null) {
          return [];
        }
        return [{
          unitId: result.unitId,
          wrapper: acceptedOutput.wrapper,
          raw: acceptedOutput.raw,
          parsedJson: acceptedOutput.parsedJson,
          contractKeys: result.acceptance.contractKeys
        }];
      }),
    acceptedTrackers: (params.consolidation.stageAcceptance?.unitResults ?? [])
      .map((result) => result.acceptance.acceptedTracker)
      .filter((tracker): tracker is NonNullable<ReturnType<typeof orchestrateTurn>['acceptance']['acceptedTracker']> => !!tracker),
    correctionUnitId: failedStageUnit?.unitId ?? params.currentUnitId,
    precomputedToolDispatch: params.batchExecution.dispatch,
    pendingToolBatches: params.batchExecution.batchExecutionResults.map((result) => ({
      batchId: result.batchId,
      stageIndex: result.stageIndex,
      unitIds: params.plannerTurn.activeStage?.unitIds ?? [],
      invocationIds: [
        ...result.dispatchedInvocationIds,
        ...result.approvalBlockedInvocationIds,
        ...result.deniedInvocationIds,
        ...result.failedInvocationIds
      ],
      status: result.status,
      createdAt: Date.now(),
      executedAt: Date.now(),
      approvalBlockedCount: result.approvalBlockedInvocationIds.length,
      failedCount: result.failedInvocationIds.length
    })),
    batchAdmissionDecisions: params.batchExecution.admissionDecisions,
    batchGuardrail: params.batchExecution.guardrail,
    consolidationState: {
      status: params.consolidation.ok ? 'COMPLETED' : 'CORRECTION_REQUIRED',
      stageIndex: params.plannerTurn.activeStage?.stageIndex ?? null,
      lastCompletedAt: Date.now(),
      lastResult: params.consolidation.ok ? 'COMPLETED' : 'CORRECTION_REQUIRED',
      lastIssueCodes: params.consolidation.issues.map((issue) => issue.code)
    }
  };
}

export function mapFallbackTurnOutcome(params: {
  currentUnitId: string;
  parsed: ReturnType<typeof orchestrateTurn>['parsed'];
  outputContract?: string | null;
  exitCondition?: string | null;
  trackerPolicy?: TrackerSemanticPolicy;
  correctionContext?: AcceptanceCorrectionContext;
  plannedTools: {
    acceptedInvocationIds: string[];
    approvalInvocationIds: string[];
    rejected: string[];
  };
  runtime: {
    pendingToolBatches: TurnPhaseOutcome['pendingToolBatches'];
    consolidationState: TurnPhaseOutcome['consolidationState'];
  };
}): TurnPhaseOutcome {
  const orchestrated = orchestrateTurn({
    currentUnitId: params.currentUnitId,
    parsed: params.parsed,
      outputContract: params.outputContract ?? undefined,
      exitCondition: params.exitCondition ?? undefined,
      trackerPolicy: {
        ...params.trackerPolicy,
        emittedToolEvidenceCount:
          (params.trackerPolicy?.emittedToolEvidenceCount ?? 0)
          + params.plannedTools.acceptedInvocationIds.length
          + params.plannedTools.approvalInvocationIds.length
      },
      correctionContext: params.correctionContext,
      plannedTools: {
      acceptedInvocationIds: params.plannedTools.acceptedInvocationIds,
      approvalInvocationIds: params.plannedTools.approvalInvocationIds,
      rejectedToolCalls: params.plannedTools.rejected
    }
  });

  return {
    plannedTools: {
      accepted: params.plannedTools.acceptedInvocationIds.length + params.plannedTools.approvalInvocationIds.length,
      approvalRequired: params.plannedTools.approvalInvocationIds.length,
      rejected: params.plannedTools.rejected,
      acceptedInvocationIds: params.plannedTools.acceptedInvocationIds,
      approvalInvocationIds: params.plannedTools.approvalInvocationIds
    },
    orchestrated,
    diagnosticsAcceptance: orchestrated.acceptance,
    acceptedTrackers: orchestrated.acceptance.acceptedTracker ? [orchestrated.acceptance.acceptedTracker] : [],
    correctionUnitId: params.currentUnitId,
    batchAdmissionDecisions: [],
    batchGuardrail: {
      batchAdmissionRestricted: false,
      reasons: []
    },
    pendingToolBatches: params.runtime.pendingToolBatches,
    consolidationState: params.runtime.consolidationState
  };
}
