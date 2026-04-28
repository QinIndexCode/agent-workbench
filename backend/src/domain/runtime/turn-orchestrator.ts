import { ParsedTurn } from '../contracts/types';
import { AcceptanceCorrectionContext, ParsedTurnAcceptanceResult, ValidationIssue, acceptParsedTurn } from '../validation';
import { parseTurn } from '../parser/unit-output-parser';

export interface PlannedToolSummary {
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  rejectedToolCalls: string[];
}

export interface OrchestratedTurn {
  parsed: ParsedTurn;
  acceptance: ParsedTurnAcceptanceResult;
  plannedTools: PlannedToolSummary;
}

function createRejectedToolIssues(rejectedToolCalls: string[]): ValidationIssue[] {
  return rejectedToolCalls.map((message) => ({
    code: /xml/i.test(message) ? 'invalid_tool_protocol' : 'invalid_tool_request',
    message
  }));
}

export function applyRejectedToolCallsToAcceptance(params: {
  acceptance: ParsedTurnAcceptanceResult;
  rejectedToolCalls: string[];
}): ParsedTurnAcceptanceResult {
  if (params.rejectedToolCalls.length === 0) {
    return params.acceptance;
  }
  const rejectedIssues = createRejectedToolIssues(params.rejectedToolCalls);
  if (!params.acceptance.ok) {
    return {
      ...params.acceptance,
      issues: [...params.acceptance.issues, ...rejectedIssues]
    };
  }
  return {
    ...params.acceptance,
    ok: false,
    pendingCorrection: 'AWAITING_TOOL_ACTION',
    failureCategory: 'tool_action_required_but_not_emitted',
    acceptedTracker: null,
    issues: rejectedIssues
  };
}

export function orchestrateTurn(params: {
  currentUnitId: string;
  llmResponse?: string;
  parsed?: ParsedTurn;
  outputContract?: string;
  exitCondition?: string;
  trackerPolicy?: {
    allowEarlyTerminate?: boolean;
    requireToolEvidence?: boolean;
    emittedToolEvidenceCount?: number;
  };
  correctionContext?: AcceptanceCorrectionContext;
  plannedTools: PlannedToolSummary;
}): OrchestratedTurn {
  const parsed = params.parsed ?? parseTurn(params.llmResponse ?? '');
  const acceptance = applyRejectedToolCallsToAcceptance({
    acceptance: acceptParsedTurn({
    currentUnitId: params.currentUnitId,
    parsed,
    outputContract: params.outputContract,
    exitCondition: params.exitCondition,
    trackerPolicy: params.trackerPolicy,
    correctionContext: params.correctionContext
    }),
    rejectedToolCalls: params.plannedTools.rejectedToolCalls
  });

  if (
    !acceptance.ok
    && acceptance.pendingCorrection === 'AWAITING_TRACKER'
    && (
      params.plannedTools.acceptedInvocationIds.length > 0
      || params.plannedTools.approvalInvocationIds.length > 0
    )
  ) {
    return {
      parsed,
      acceptance: {
        ...acceptance,
        issues: [
          ...acceptance.issues,
          {
            code: 'TRACKER_REQUIRED_AFTER_TOOL_PLANNING',
            message: 'Tool planning was accepted for this turn, but a valid progress tracker is still required.'
          }
        ]
      },
      plannedTools: params.plannedTools
    };
  }

  return {
    parsed,
    acceptance,
    plannedTools: params.plannedTools
  };
}
