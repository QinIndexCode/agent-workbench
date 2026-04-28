import { ToolApprovalRecord, ToolInvocationRecord } from '../repository';
import { ToolExecutorCapability } from './executor-capability';
import { applyToolInvocationTransition } from './invocation-state';
import {
  evaluateToolInvocationResumePolicy,
  ToolInvocationResumeDecision
} from './invocation-resume-policy';

export interface ToolDispatchPlanEntry {
  invocation: ToolInvocationRecord;
  latestApproval: ToolApprovalRecord | null;
  capability: ToolExecutorCapability | null;
  decision: ToolInvocationResumeDecision;
  reason: string;
  nextInvocation: ToolInvocationRecord;
}

export function planToolInvocationDispatch(params: {
  invocation: ToolInvocationRecord;
  approval: ToolApprovalRecord | null;
  capability: ToolExecutorCapability | null;
}): ToolDispatchPlanEntry {
  const { invocation, approval, capability } = params;
  const evaluation = evaluateToolInvocationResumePolicy({
    invocation,
    approval,
    capability
  });

  if (evaluation.decision === 'DISPATCH') {
    if (invocation.status === 'WAITING_APPROVAL') {
      return {
        invocation,
        latestApproval: approval,
        capability,
        decision: evaluation.decision,
        reason: evaluation.reason,
        nextInvocation: {
          ...invocation,
          status: 'PLANNED',
          metadata: {
            ...invocation.metadata,
            resumedFromApproval: true,
            latestApprovalId: approval?.approvalId ?? null,
            latestApprovalStatus: approval?.status ?? null,
            latestApprovalResolvedAt: approval?.resolvedAt ?? null
          }
        }
      };
    }

    return {
      invocation,
      latestApproval: approval,
      capability,
      decision: evaluation.decision,
      reason: evaluation.reason,
      nextInvocation: invocation
    };
  }

  if (evaluation.decision === 'DENY') {
    return {
      invocation,
      latestApproval: approval,
      capability,
      decision: evaluation.decision,
      reason: evaluation.reason,
      nextInvocation: applyToolInvocationTransition(invocation, {
        type: 'DENY',
        timestamp: approval?.resolvedAt ?? Date.now(),
        reason: evaluation.reason,
        metadata: {
          latestApprovalId: approval?.approvalId ?? null,
          latestApprovalStatus: approval?.status ?? null
        }
      })
    };
  }

  return {
    invocation,
    latestApproval: approval,
    capability,
    decision: evaluation.decision,
    reason: evaluation.reason,
    nextInvocation: invocation
  };
}
