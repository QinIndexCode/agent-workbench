import { ToolInvocationRecord } from '../repository';
import { ToolResultEnvelope } from './types';

export type ToolInvocationTransition =
  | {
    type: 'START';
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }
  | {
    type: 'SUCCEED';
    result: ToolResultEnvelope;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }
  | {
    type: 'FAIL';
    result: ToolResultEnvelope;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }
  | {
    type: 'DENY';
    reason: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };

export function applyToolInvocationTransition(
  record: ToolInvocationRecord,
  transition: ToolInvocationTransition
): ToolInvocationRecord {
  const timestamp = transition.timestamp ?? Date.now();
  switch (transition.type) {
    case 'START':
      return {
        ...record,
        status: 'RUNNING',
        startedAt: timestamp,
        endedAt: null,
        metadata: {
          ...record.metadata,
          ...(transition.metadata ?? {})
        }
      };
    case 'SUCCEED':
      if (!transition.result.ok) {
        throw new Error('backend_new tool invocation error: SUCCEED transition requires a success result.');
      }
      return {
        ...record,
        status: 'SUCCEEDED',
        endedAt: timestamp,
        result: transition.result.output,
        error: null,
        metadata: {
          ...record.metadata,
          resultMessage: transition.result.message,
          ...transition.result.metadata,
          ...(transition.metadata ?? {})
        }
      };
    case 'FAIL':
      if (transition.result.ok) {
        throw new Error('backend_new tool invocation error: FAIL transition requires a failure result.');
      }
      return {
        ...record,
        status: 'FAILED',
        endedAt: timestamp,
        result: transition.result.output,
        error: transition.result.message,
        metadata: {
          ...record.metadata,
          errorKind: transition.result.kind,
          ...transition.result.metadata,
          ...(transition.metadata ?? {})
        }
      };
    case 'DENY':
      return {
        ...record,
        status: 'DENIED',
        endedAt: timestamp,
        result: null,
        error: transition.reason,
        metadata: {
          ...record.metadata,
          denialReason: transition.reason,
          ...(transition.metadata ?? {})
        }
      };
    default:
      return record;
  }
}
