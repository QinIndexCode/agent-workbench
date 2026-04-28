import { ParsedTurn } from '../contracts/types';
import { AcceptanceCorrectionContext, ParsedTurnAcceptanceResult, ValidationIssue } from './types';
import { acceptParsedTurn } from './response-acceptance-policy';
import { acceptStageTurn, StageTurnAcceptanceResult } from './accept-stage-turn';
import { ToolBatchExecutionResult } from '../../foundation/repository';
import { validateStageSemanticContract } from './validate-stage-semantic-contract';

export interface ConsolidationTurnOutput {
  ok: boolean;
  pendingCorrection: ParsedTurnAcceptanceResult['pendingCorrection'];
  acceptance: ParsedTurnAcceptanceResult;
  stageAcceptance?: StageTurnAcceptanceResult;
  issues: ValidationIssue[];
  blockingReason: 'CONTRACT_BLOCKED' | 'BATCH_BLOCKED' | 'CONSOLIDATION_BLOCKED' | null;
  result: 'COMPLETED' | 'CORRECTION_REQUIRED';
}

export function consolidateStageTurn(params: {
  currentUnitId?: string;
  stageUnits?: Array<{
    unitId: string;
    outputContract?: string;
    exitCondition?: string;
    trackerPolicy?: {
      allowEarlyTerminate?: boolean;
      requireToolEvidence?: boolean;
      emittedToolEvidenceCount?: number;
    };
    correctionContext?: AcceptanceCorrectionContext;
  }>;
  parsed: ParsedTurn;
  outputContract?: string;
  exitCondition?: string;
  batchExecutionResults: ToolBatchExecutionResult[];
  trackerPolicy?: {
    allowEarlyTerminate?: boolean;
    requireToolEvidence?: boolean;
    emittedToolEvidenceCount?: number;
  };
}): ConsolidationTurnOutput {
  const stageAcceptance = params.stageUnits && params.stageUnits.length > 0
    ? acceptStageTurn({
      parsed: params.parsed,
      units: params.stageUnits
    })
    : null;
  const acceptance = stageAcceptance
    ? (stageAcceptance.unitResults.find((result) => result.unitId === params.currentUnitId)?.acceptance
      ?? stageAcceptance.unitResults[0]?.acceptance
      ?? acceptParsedTurn({
        currentUnitId: params.currentUnitId ?? 'UNKNOWN',
      parsed: params.parsed,
      outputContract: params.outputContract,
      exitCondition: params.exitCondition,
      trackerPolicy: params.trackerPolicy,
      correctionContext: params.stageUnits?.find((unit) => unit.unitId === params.currentUnitId)?.correctionContext
    }))
    : acceptParsedTurn({
      currentUnitId: params.currentUnitId ?? 'UNKNOWN',
      parsed: params.parsed,
      outputContract: params.outputContract,
      exitCondition: params.exitCondition,
      trackerPolicy: params.trackerPolicy,
      correctionContext: params.stageUnits?.find((unit) => unit.unitId === params.currentUnitId)?.correctionContext
      });
  const semanticValidation = validateStageSemanticContract({
    acceptance,
    stageAcceptance,
    batchExecutionResults: params.batchExecutionResults
  });
  if (!semanticValidation.ok) {
    return {
      ok: false,
      pendingCorrection: semanticValidation.pendingCorrection,
      acceptance,
      stageAcceptance: stageAcceptance ?? undefined,
      issues: [...semanticValidation.issues],
      blockingReason: semanticValidation.blockingReason,
      result: 'CORRECTION_REQUIRED'
    };
  }

  return {
    ok: true,
    pendingCorrection: 'NONE',
    acceptance,
    stageAcceptance: stageAcceptance ?? undefined,
    issues: [],
    blockingReason: null,
    result: 'COMPLETED'
  };
}
