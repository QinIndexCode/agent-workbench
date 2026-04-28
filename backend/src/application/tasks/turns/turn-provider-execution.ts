import { buildProviderCompletionRequest, ProviderClient, ProviderCompletionResponse, ResolvedProviderProfile } from '../../../foundation/providers';

export interface TurnProviderExecutionResult {
  response: ProviderCompletionResponse;
}

export async function executeTurnProvider(params: {
  providerClient: ProviderClient;
  resolvedProvider: ResolvedProviderProfile;
  prompt: string;
  contextMessages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  taskId: string;
  currentUnitId: string;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  abortSignal?: AbortSignal;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}): Promise<TurnProviderExecutionResult> {
  const response = await params.providerClient.complete(
    buildProviderCompletionRequest({
      profile: params.resolvedProvider,
      context: {
        taskId: params.taskId,
        unitId: params.currentUnitId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId
      },
      messages: [
        { role: 'system', content: params.prompt },
        ...params.contextMessages
      ],
      abortSignal: params.abortSignal,
      temperature: 0,
      metadata: {
        taskId: params.taskId,
        unitId: params.currentUnitId,
        timeoutMs: params.requestTimeoutMs,
        maxRetries: params.maxRetries,
        retryBackoffMs: params.retryBackoffMs
      }
    })
  );

  return { response };
}
