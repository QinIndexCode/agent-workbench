import { ToolApprovalRecord, ToolInvocationRecord } from '../repository';
import { ToolExecutorCapability } from './executor-capability';

export type ToolInvocationResumeDecision =
  | 'DISPATCH'
  | 'WAIT_APPROVAL'
  | 'DENY';

export interface ToolInvocationResumePolicyResult {
  decision: ToolInvocationResumeDecision;
  reason: string;
}

export function evaluateToolInvocationResumePolicy(params: {
  invocation: ToolInvocationRecord;
  approval: ToolApprovalRecord | null;
  capability: ToolExecutorCapability | null;
}): ToolInvocationResumePolicyResult {
  const { invocation, approval, capability } = params;

  if (invocation.status === 'PLANNED') {
    if (!capability) {
      return {
        decision: 'DENY',
        reason: 'Invocation cannot dispatch because no executor capability is registered.'
      };
    }
    return {
      decision: 'DISPATCH',
      reason: 'Planned invocation can be dispatched immediately.'
    };
  }

  if (invocation.status === 'WAITING_APPROVAL') {
    if (!approval || approval.status === 'PENDING') {
      return {
        decision: 'WAIT_APPROVAL',
        reason: 'Invocation is waiting for approval.'
      };
    }
    if (approval.status === 'REJECTED' || approval.status === 'EXPIRED') {
      return {
        decision: 'DENY',
        reason: `Invocation cannot resume because approval status is ${approval.status}.`
      };
    }
    if (!capability) {
      return {
        decision: 'DENY',
        reason: 'Invocation cannot resume because no executor capability is registered.'
      };
    }
    if (!capability.supportsApprovalResume) {
      return {
        decision: 'DENY',
        reason: 'Executor does not support resuming after approval.'
      };
    }
    return {
      decision: 'DISPATCH',
      reason: 'Invocation can resume because approval was granted.'
    };
  }

  return {
    decision: 'DENY',
    reason: `Invocation cannot resume from status ${invocation.status}.`
  };
}
