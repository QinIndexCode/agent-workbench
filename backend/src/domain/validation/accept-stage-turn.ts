import { ParsedTurnAcceptanceResult, ValidationIssue } from './types';
import { acceptParsedTurn } from './response-acceptance-policy';
import { ParsedTurn } from '../contracts/types';

export interface AcceptedStageUnitResult {
  unitId: string;
  acceptance: ParsedTurnAcceptanceResult;
}

export interface StageTurnAcceptanceResult {
  ok: boolean;
  pendingCorrection: ParsedTurnAcceptanceResult['pendingCorrection'];
  unitResults: AcceptedStageUnitResult[];
  issues: ValidationIssue[];
}

export function acceptStageTurn(params: {
  parsed: ParsedTurn;
  units: Array<{
    unitId: string;
    outputContract?: string;
    exitCondition?: string;
    trackerPolicy?: {
      allowEarlyTerminate?: boolean;
      requireToolEvidence?: boolean;
      emittedToolEvidenceCount?: number;
    };
    correctionContext?: import('./types').AcceptanceCorrectionContext;
  }>;
}): StageTurnAcceptanceResult {
  const unitResults = params.units.map((unit) => ({
    unitId: unit.unitId,
    acceptance: acceptParsedTurn({
      currentUnitId: unit.unitId,
      parsed: params.parsed,
      outputContract: unit.outputContract,
      exitCondition: unit.exitCondition,
      trackerPolicy: unit.trackerPolicy,
      correctionContext: unit.correctionContext
    })
  }));
  const failures = unitResults.filter((result) => !result.acceptance.ok);
  if (failures.length === 0) {
    return {
      ok: true,
      pendingCorrection: 'NONE',
      unitResults,
      issues: []
    };
  }
  const firstFailure = failures[0];
  return {
    ok: false,
    pendingCorrection: firstFailure.acceptance.pendingCorrection,
    unitResults,
    issues: failures.flatMap((result) => result.acceptance.issues.map((issue) => ({
      ...issue,
      message: `[${result.unitId}] ${issue.message}`
    })))
  };
}
