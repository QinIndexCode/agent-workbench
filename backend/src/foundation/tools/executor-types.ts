import { BackendNewConfig } from '../config/types';
import { AgentToolDefinition } from '../extensions/types';
import { ToolInvocationRequest, ToolResultEnvelope } from './types';

export interface ToolExecutionContext {
  config: BackendNewConfig;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string | null;
}

export interface ToolExecutorRequest {
  tool: AgentToolDefinition;
  invocation: ToolInvocationRequest;
  context: ToolExecutionContext;
}

export interface ToolExecutor {
  execute(request: ToolExecutorRequest): Promise<ToolResultEnvelope>;
}
