import { ResolvedProviderProfile } from './types';

export interface ProviderInvocationContext {
  taskId: string;
  unitId: string | null;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string | null;
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderCompletionRequest {
  profile: ResolvedProviderProfile;
  context: ProviderInvocationContext;
  messages: ProviderMessage[];
  abortSignal?: AbortSignal;
  temperature?: number | null;
  maxTokens?: number | null;
  stop?: string[];
  responseFormat?: 'json_object' | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderCompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedPromptTokens?: number | null;
  cacheWritePromptTokens?: number | null;
  providerReportedUsage?: Record<string, unknown> | null;
}

export interface ProviderCompletionResponse {
  responseId: string;
  providerId: string;
  model: string;
  outputText: string;
  finishReason: string | null;
  usage: ProviderCompletionUsage;
  metadata: Record<string, unknown>;
}

export interface ProviderClient {
  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse>;
}
