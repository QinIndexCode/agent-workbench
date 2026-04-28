import { ResolvedProviderProfile } from './types';
import {
  ProviderCompletionRequest,
  ProviderInvocationContext,
  ProviderMessage
} from './client-types';

export interface BuildProviderCompletionRequestInput {
  profile: ResolvedProviderProfile;
  context: ProviderInvocationContext;
  messages: ProviderMessage[];
  abortSignal?: AbortSignal;
  temperature?: number | null;
  maxTokens?: number | null;
  stop?: string[];
  metadata?: Record<string, unknown>;
}

export function buildProviderCompletionRequest(
  input: BuildProviderCompletionRequestInput
): ProviderCompletionRequest {
  if (input.messages.length === 0) {
    throw new Error('backend_new provider client error: completion request requires at least one message.');
  }

  return {
    profile: input.profile,
    context: input.context,
    messages: input.messages.map(message => ({
      role: message.role,
      content: message.content,
      metadata: {
        ...(message.metadata ?? {})
      }
    })),
    temperature: input.temperature ?? null,
    maxTokens: input.maxTokens ?? null,
    abortSignal: input.abortSignal,
    stop: input.stop ? [...input.stop] : [],
    metadata: {
      ...(input.metadata ?? {})
    }
  };
}
