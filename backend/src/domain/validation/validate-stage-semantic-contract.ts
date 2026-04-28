import { ToolBatchExecutionResult } from '../../foundation/repository';
import { ParsedTurnAcceptanceResult, ValidationIssue } from './types';
import { StageTurnAcceptanceResult } from './accept-stage-turn';

export interface StageSemanticValidationResult {
  ok: boolean;
  pendingCorrection: ParsedTurnAcceptanceResult['pendingCorrection'];
  blockingReason: 'CONTRACT_BLOCKED' | 'BATCH_BLOCKED' | 'CONSOLIDATION_BLOCKED' | null;
  issues: ValidationIssue[];
  contractIssueCodes: string[];
  batchIssueCodes: string[];
}

function createBatchIssues(batchExecutionResults: ToolBatchExecutionResult[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const batch of batchExecutionResults) {
    if (batch.status === 'PARTIAL_APPROVAL_BLOCKED') {
      issues.push({
        code: 'tool_batch_partial_approval_blocked',
        message: `Tool batch "${batch.batchId}" is waiting on approval or contains blocked items.`
      });
    } else if (batch.status === 'DENIED') {
      issues.push({
        code: 'tool_batch_denied',
        message: `Tool batch "${batch.batchId}" was denied by policy.`
      });
    } else if (batch.status === 'FAILED') {
      issues.push({
        code: 'tool_batch_failed',
        message: `Tool batch "${batch.batchId}" failed during execution.`
      });
    }
  }
  return issues;
}

export function validateStageSemanticContract(params: {
  acceptance: ParsedTurnAcceptanceResult;
  stageAcceptance?: StageTurnAcceptanceResult | null;
  batchExecutionResults: ToolBatchExecutionResult[];
}): StageSemanticValidationResult {
  const batchIssues = createBatchIssues(params.batchExecutionResults);
  if (batchIssues.length > 0) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      blockingReason: 'BATCH_BLOCKED',
      issues: [...params.acceptance.issues, ...batchIssues],
      contractIssueCodes: params.acceptance.issues.map((issue) => issue.code),
      batchIssueCodes: batchIssues.map((issue) => issue.code)
    };
  }

  if ((params.stageAcceptance && !params.stageAcceptance.ok) || !params.acceptance.ok) {
    const issues = [...(params.stageAcceptance?.issues ?? params.acceptance.issues)];
    const pendingCorrection = params.stageAcceptance?.pendingCorrection ?? params.acceptance.pendingCorrection;
    return {
      ok: false,
      pendingCorrection,
      blockingReason: 'CONSOLIDATION_BLOCKED',
      issues,
      contractIssueCodes: issues.map((issue) => issue.code),
      batchIssueCodes: []
    };
  }

  return {
    ok: true,
    pendingCorrection: 'NONE',
    blockingReason: null,
    issues: [],
    contractIssueCodes: [],
    batchIssueCodes: []
  };
}
