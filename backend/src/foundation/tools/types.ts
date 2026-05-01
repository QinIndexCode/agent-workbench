import { AgentToolDefinition } from '../extensions/types';

export interface ToolInvocationRequest {
  taskId: string;
  unitId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type ToolErrorKind =
  | 'VALIDATION'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'EXECUTION'
  | 'UNKNOWN';

export interface ToolSuccessResultEnvelope {
  ok: true;
  kind: null;
  output: Record<string, unknown>;
  message: string | null;
  metadata: Record<string, unknown>;
}

export interface ToolFailureResultEnvelope {
  ok: false;
  kind: ToolErrorKind;
  output: Record<string, unknown> | null;
  message: string;
  metadata: Record<string, unknown>;
}

export type ToolResultEnvelope =
  | ToolSuccessResultEnvelope
  | ToolFailureResultEnvelope;

export interface ToolInvocationValidationSuccess {
  ok: true;
  tool: AgentToolDefinition;
  normalizedArguments: Record<string, unknown>;
}

export interface ToolInvocationValidationFailure {
  ok: false;
  errors: string[];
}

export type ToolInvocationValidationResult =
  | ToolInvocationValidationSuccess
  | ToolInvocationValidationFailure;
