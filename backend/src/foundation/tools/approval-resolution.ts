import { ToolApprovalRecord } from '../repository';

export interface ToolApprovalResolutionInput {
  status: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  resolvedAt?: number;
  grantedBy?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export function resolveToolApprovalRecord(
  record: ToolApprovalRecord,
  resolution: ToolApprovalResolutionInput
): ToolApprovalRecord {
  const resolvedAt = resolution.resolvedAt ?? Date.now();
  return {
    ...record,
    status: resolution.status,
    resolvedAt,
    grantedBy: resolution.grantedBy ?? record.grantedBy,
    reason: resolution.reason ?? record.reason,
    metadata: {
      ...record.metadata,
      ...(resolution.metadata ?? {})
    }
  };
}

export function findLatestApprovalForInvocation(
  approvals: ToolApprovalRecord[],
  invocationId: string
): ToolApprovalRecord | null {
  return approvals
    .filter(record => record.invocationId === invocationId)
    .sort((left, right) => {
      const leftStamp = left.resolvedAt ?? left.createdAt;
      const rightStamp = right.resolvedAt ?? right.createdAt;
      return rightStamp - leftStamp;
    })[0] ?? null;
}
