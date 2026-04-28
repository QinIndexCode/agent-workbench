import { randomUUID } from 'node:crypto';
import { ProviderClient, ProviderCompletionRequest, ProviderCompletionResponse } from '../../../foundation/providers/client-types';
import {
  buildProviderAuthHeaders,
  classifyHttpError,
  ProviderHttpError,
  redactProviderRequest,
  redactProviderResponse,
  resolveProviderClientPolicy,
  withRetry
} from './provider-client-helpers';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function extractTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  return content
    .map(block => {
      if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = await response.json() as { error?: { message?: string } };
    if (parsed?.error?.message?.trim()) {
      return parsed.error.message;
    }
    return JSON.stringify(parsed);
  } catch {
    return await response.text();
  }
}

export class AnthropicCompatibleProviderClient implements ProviderClient {
  async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
    if (!request.profile.baseUrl?.trim()) {
      throw new Error(`backend_new provider error: provider "${request.profile.id}" requires baseUrl.`);
    }
    const policy = resolveProviderClientPolicy(request);
    const endpoint = `${normalizeBaseUrl(request.profile.baseUrl)}${request.profile.endpoints?.messagesPath ?? '/messages'}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...buildProviderAuthHeaders(request)
    };
    if (request.profile.apiVersion) {
      headers['anthropic-version'] = request.profile.apiVersion;
    }

    const system = request.messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n\n')
      .trim();
    const messages = request.messages
      .filter(message => message.role !== 'system')
      .map(message => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content
      }));

    return withRetry(
      async (attemptIndex) => {
        const controller = new AbortController();
        let abortOrigin: 'local_abort' | 'request_abort' | null = null;
        const abortFromRequest = () => {
          abortOrigin = 'request_abort';
          controller.abort(request.abortSignal?.reason);
        };
        request.abortSignal?.addEventListener('abort', abortFromRequest, { once: true });
        const timeout = setTimeout(() => {
          abortOrigin = 'local_abort';
          controller.abort();
        }, policy.timeoutMs);
        const startedAt = Date.now();
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              model: request.profile.model,
              system: system || undefined,
              messages,
              max_tokens: request.maxTokens ?? 1024,
              temperature: request.temperature ?? undefined,
              stop_sequences: request.stop && request.stop.length > 0 ? request.stop : undefined
            })
          });
          if (!response.ok) {
            throw classifyHttpError(response.status, await readErrorMessage(response), 'anthropic-compatible', {
              timeoutOrigin: response.status === 408 ? 'upstream_http_408' : null,
              elapsedMs: Date.now() - startedAt,
              requestTimeoutMs: policy.timeoutMs,
              retryAttempt: attemptIndex + 1
            });
          }
          const payload = await response.json() as {
            id?: string;
            model?: string;
            content?: unknown;
            stop_reason?: string | null;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
            };
          };
          const result = {
            responseId: payload.id ?? `resp_${randomUUID()}`,
            providerId: request.profile.id,
            model: payload.model ?? request.profile.model,
            outputText: extractTextBlocks(payload.content),
            finishReason: payload.stop_reason ?? null,
            usage: {
              promptTokens: payload.usage?.input_tokens ?? null,
              completionTokens: payload.usage?.output_tokens ?? null,
              totalTokens: payload.usage
                ? (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0)
                : null
            },
            metadata: {
              transport: request.profile.transport,
              providerKind: 'anthropic-compatible',
              request: redactProviderRequest(request)
            }
          };
          return {
            ...result,
            metadata: {
              ...result.metadata,
              response: redactProviderResponse(result)
            }
          };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            const timeoutOrigin = abortOrigin ?? (request.abortSignal?.aborted ? 'request_abort' : 'local_abort');
            throw classifyHttpError(408, 'request timed out', 'anthropic-compatible', {
              timeoutOrigin,
              elapsedMs: Date.now() - startedAt,
              requestTimeoutMs: policy.timeoutMs,
              retryAttempt: attemptIndex + 1
            });
          }
          if (error instanceof Error) {
            if ('retryable' in error) {
              throw error;
            }
            throw new ProviderHttpError(
              `backend_new provider error: anthropic-compatible network failure: ${error.message}`,
              'NETWORK',
              null,
              true,
              null,
              Date.now() - startedAt,
              policy.timeoutMs,
              attemptIndex + 1
            );
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          request.abortSignal?.removeEventListener('abort', abortFromRequest);
        }
      },
      policy,
      (error) => Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === true)
    );
  }
}
