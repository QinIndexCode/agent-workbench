import { SkillDefinition } from '../extensions/types';

export interface SkillInvocationContext {
  taskId: string;
  unitId: string | null;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string | null;
}

export interface SkillInvocationRequest {
  skill: SkillDefinition;
  context: SkillInvocationContext;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SkillInvocationResult {
  ok: boolean;
  output: Record<string, unknown> | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface SkillRuntimeCapability {
  supportsStreaming: boolean;
  supportsWorkspaceWrite: boolean;
  supportsNetworkAccess: boolean;
}

export interface SkillRuntime {
  invoke(request: SkillInvocationRequest): Promise<SkillInvocationResult>;
}
