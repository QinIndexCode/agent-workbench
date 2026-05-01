import {
  ToolErrorKind,
  ToolFailureResultEnvelope,
  ToolResultEnvelope,
  ToolSuccessResultEnvelope
} from './types';

export function createToolSuccessResult(params: {
  output: Record<string, unknown>;
  message?: string | null;
  metadata?: Record<string, unknown>;
}): ToolSuccessResultEnvelope {
  return {
    ok: true,
    kind: null,
    output: { ...params.output },
    message: params.message ?? null,
    metadata: params.metadata ?? {}
  };
}

export function createToolFailureResult(params: {
  kind: ToolErrorKind;
  message: string;
  output?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}): ToolFailureResultEnvelope {
  return {
    ok: false,
    kind: params.kind,
    output: params.output ?? null,
    message: params.message,
    metadata: params.metadata ?? {}
  };
}

export function isToolFailureResult(result: ToolResultEnvelope): result is ToolFailureResultEnvelope {
  return result.ok === false;
}
