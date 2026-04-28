import { AgentToolDefinition } from '../extensions/types';
import { ToolExecutorRequest } from './executor-types';
import { ToolFailureResultEnvelope, ToolResultEnvelope } from './types';
import { ToolExecutorRegistry } from './executor-registry';

export async function dispatchToolExecutor(params: {
  registry: ToolExecutorRegistry;
  tool: AgentToolDefinition;
  request: ToolExecutorRequest;
}): Promise<ToolResultEnvelope> {
  const entry = params.registry.resolveEntry(params.tool);
  if (!entry) {
    const failure: ToolFailureResultEnvelope = {
      ok: false,
      kind: 'NOT_FOUND',
      output: null,
      message: `No executor registered for tool "${params.tool.id}".`,
      metadata: {
        toolId: params.tool.id,
        toolName: params.tool.name
      }
    };
    return failure;
  }

  return entry.executor.execute(params.request);
}
