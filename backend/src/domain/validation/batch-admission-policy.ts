import { TaskRuntimeState } from '../contracts/types';

export type BatchAdmissionRejectionReason =
  | 'BATCH_REJECTED_DEPENDENCY_RISK'
  | 'BATCH_REJECTED_SIDE_EFFECT_RISK'
  | 'BATCH_REJECTED_CONTEXT_RISK'
  | 'BATCH_REJECTED_APPROVAL_BACKLOG_RISK';

export interface BatchAdmissionCandidate {
  invocationKey: string;
  batchId: string;
  stageIndex: number;
  unitId: string;
  unitIdsInBatch: string[];
  toolName: string;
  sideEffectKey: string | null;
  argumentText: string;
}

export interface BatchAdmissionDecision {
  batchId: string;
  stageIndex: number;
  status: 'ADMITTED' | 'PARTIAL' | 'REJECTED';
  admittedInvocationKeys: string[];
  rejectedInvocationKeys: string[];
  rejectionReasons: BatchAdmissionRejectionReason[];
}

export interface BatchGuardrailState {
  batchAdmissionRestricted: boolean;
  reasons: string[];
}

function createDecision(batchId: string, stageIndex: number): BatchAdmissionDecision {
  return {
    batchId,
    stageIndex,
    status: 'ADMITTED',
    admittedInvocationKeys: [],
    rejectedInvocationKeys: [],
    rejectionReasons: []
  };
}

function pushRejection(decision: BatchAdmissionDecision, invocationKey: string, reason: BatchAdmissionRejectionReason): void {
  if (!decision.rejectionReasons.includes(reason)) {
    decision.rejectionReasons.push(reason);
  }
  if (!decision.rejectedInvocationKeys.includes(invocationKey)) {
    decision.rejectedInvocationKeys.push(invocationKey);
  }
}

function createGuardrail(runtime: TaskRuntimeState): BatchGuardrailState {
  const reasons: string[] = [];
  if ((runtime.pendingToolBatches ?? []).filter((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED').length >= 1) {
    reasons.push('approval_blocked_batch_present');
  }
  if ((runtime.planner?.fallbackReasons?.length ?? 0) > 0) {
    reasons.push('planner_fallback_present');
  }
  return {
    batchAdmissionRestricted: reasons.length > 0,
    reasons
  };
}

export function evaluateBatchAdmission(params: {
  runtime: TaskRuntimeState;
  candidates: BatchAdmissionCandidate[];
}): {
  decisions: BatchAdmissionDecision[];
  guardrail: BatchGuardrailState;
} {
  const grouped = new Map<string, BatchAdmissionDecision>();
  const sideEffects = new Map<string, string>();
  const guardrail = createGuardrail(params.runtime);

  for (const candidate of params.candidates) {
    const decision = grouped.get(candidate.batchId) ?? createDecision(candidate.batchId, candidate.stageIndex);
    grouped.set(candidate.batchId, decision);
    const otherUnitIds = candidate.unitIdsInBatch.filter((unitId) => unitId !== candidate.unitId);

    if (guardrail.batchAdmissionRestricted && candidate.unitIdsInBatch.length > 1) {
      pushRejection(
        decision,
        candidate.invocationKey,
        guardrail.reasons.includes('approval_blocked_batch_present')
          ? 'BATCH_REJECTED_APPROVAL_BACKLOG_RISK'
          : 'BATCH_REJECTED_DEPENDENCY_RISK'
      );
      continue;
    }

    if (candidate.sideEffectKey) {
      const priorInvocation = sideEffects.get(candidate.sideEffectKey);
      if (priorInvocation && priorInvocation !== candidate.invocationKey) {
        pushRejection(decision, candidate.invocationKey, 'BATCH_REJECTED_SIDE_EFFECT_RISK');
        continue;
      }
      sideEffects.set(candidate.sideEffectKey, candidate.invocationKey);
    }

    if (otherUnitIds.some((unitId) => candidate.argumentText.includes(unitId))) {
      pushRejection(decision, candidate.invocationKey, 'BATCH_REJECTED_CONTEXT_RISK');
      continue;
    }

    decision.admittedInvocationKeys.push(candidate.invocationKey);
  }

  const decisions = [...grouped.values()].map((decision): BatchAdmissionDecision => {
    const status: BatchAdmissionDecision['status'] = decision.rejectedInvocationKeys.length === 0
      ? 'ADMITTED'
      : (decision.admittedInvocationKeys.length === 0 ? 'REJECTED' : 'PARTIAL');
    return {
      ...decision,
      status
    };
  });

  return {
    decisions,
    guardrail
  };
}
