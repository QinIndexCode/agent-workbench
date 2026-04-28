import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
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

interface OpenAiCompatibleChatCompletionChoice {
  message?: {
    content?: unknown;
  };
  text?: unknown;
  finish_reason?: string | null;
}

interface OpenAiCompatibleChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: OpenAiCompatibleChatCompletionChoice[];
  usage?: Record<string, unknown>;
}

function normalizeUsageValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function readNestedUsageValue(record: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return normalizeUsageValue(current);
}

function normalizeUsage(usage: OpenAiCompatibleChatCompletionResponse['usage']): ProviderCompletionResponse['usage'] {
  const usageRecord = usage && typeof usage === 'object' && !Array.isArray(usage)
    ? usage
    : null;
  const normalized = {
    promptTokens: normalizeUsageValue(usageRecord?.prompt_tokens),
    completionTokens: normalizeUsageValue(usageRecord?.completion_tokens),
    totalTokens: normalizeUsageValue(usageRecord?.total_tokens),
    cachedPromptTokens:
      readNestedUsageValue(usageRecord ?? {}, ['prompt_tokens_details', 'cached_tokens'])
      ?? readNestedUsageValue(usageRecord ?? {}, ['input_tokens_details', 'cached_tokens'])
      ?? readNestedUsageValue(usageRecord ?? {}, ['cache_read_input_tokens']),
    cacheWritePromptTokens:
      readNestedUsageValue(usageRecord ?? {}, ['prompt_tokens_details', 'cache_write_tokens'])
      ?? readNestedUsageValue(usageRecord ?? {}, ['input_tokens_details', 'cache_write_tokens'])
      ?? readNestedUsageValue(usageRecord ?? {}, ['cache_creation_input_tokens']),
    providerReportedUsage: usageRecord ? { ...usageRecord } : null
  };
  const values = [
    normalized.promptTokens,
    normalized.completionTokens,
    normalized.totalTokens,
    normalized.cachedPromptTokens,
    normalized.cacheWritePromptTokens
  ]
    .filter((value): value is number => typeof value === 'number');
  if (values.length > 0 && values.every((value) => value === 0)) {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedPromptTokens: null,
      cacheWritePromptTokens: null,
      providerReportedUsage: usageRecord ? { ...usageRecord } : null
    };
  }
  return normalized;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

interface HttpResponsePayload {
  ok: boolean;
  status: number;
  text: string;
}

function buildRequestMessages(
  request: ProviderCompletionRequest
): Array<{ role: string; content: string }> {
  const messages = request.messages.map(message => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: message.content
  }));

  const hasUserMessage = messages.some((message) => message.role === 'user' && message.content.trim().length > 0);
  if (hasUserMessage) {
    return messages;
  }

  return [
    ...messages,
    {
      role: 'user',
      content: 'Follow the system and prior context exactly, then produce the requested result.'
    }
  ];
}

function extractOutputText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }

  return '';
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

async function requestWithNodeTransport(params: {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<HttpResponsePayload> {
  const target = new URL(params.endpoint);
  const transport = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'POST',
      headers: params.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text
        });
      });
    });

    const timeout = setTimeout(() => {
      request.destroy(new Error('request timed out'));
    }, params.timeoutMs);

    const abortFromSignal = () => request.destroy(new DOMException('Aborted', 'AbortError'));
    params.abortSignal?.addEventListener('abort', abortFromSignal, { once: true });

    request.on('error', (error) => {
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener('abort', abortFromSignal);
      reject(error);
    });
    request.on('close', () => {
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener('abort', abortFromSignal);
    });

    request.write(params.body);
    request.end();
  });
}

async function postJsonWithFallback(params: {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<HttpResponsePayload> {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return requestWithNodeTransport({
      endpoint: params.endpoint,
      headers: params.headers,
      body: params.body,
      timeoutMs: params.timeoutMs,
      abortSignal: params.signal
    });
  }
  let response: Response | { ok?: boolean; status?: number; text?: () => Promise<string>; json?: () => Promise<unknown> };
  try {
    response = await fetchImpl(params.endpoint, {
      method: 'POST',
      headers: params.headers,
      signal: params.signal,
      body: params.body
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return requestWithNodeTransport({
      endpoint: params.endpoint,
      headers: params.headers,
      body: params.body,
      timeoutMs: params.timeoutMs,
      abortSignal: params.signal
    });
  }
  const text = typeof response.text === 'function'
    ? await response.text()
    : typeof response.json === 'function'
      ? JSON.stringify(await response.json())
      : '';
  const status = typeof response.status === 'number' ? response.status : 200;
  return {
    ok: response.ok === true,
    status,
    text
  };
}

function parseErrorMessageFromText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed?.error?.message?.trim()) {
      return parsed.error.message;
    }
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

export class OpenAiCompatibleProviderClient implements ProviderClient {
  protected providerKind = 'openai-compatible';

  protected buildHeaders(request: ProviderCompletionRequest): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...buildProviderAuthHeaders(request)
    };
  }

  protected buildEndpoint(request: ProviderCompletionRequest): string {
    if (!request.profile.baseUrl?.trim()) {
      throw new Error(`backend_new provider error: provider "${request.profile.id}" requires baseUrl.`);
    }
    return `${normalizeBaseUrl(request.profile.baseUrl)}${request.profile.endpoints?.chatCompletionsPath ?? '/chat/completions'}`;
  }

  async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
    const policy = resolveProviderClientPolicy(request);
    const endpoint = this.buildEndpoint(request);
    const headers = this.buildHeaders(request);

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
          const requestBody = JSON.stringify({
            model: request.profile.model,
            messages: buildRequestMessages(request),
            temperature: request.temperature ?? undefined,
            max_tokens: request.maxTokens ?? undefined,
            stop: request.stop && request.stop.length > 0 ? request.stop : undefined
          });
          const response = await postJsonWithFallback({
            endpoint,
            headers,
            signal: controller.signal,
            body: requestBody,
            timeoutMs: policy.timeoutMs
          });

          if (!response.ok) {
            const errorMessage = parseErrorMessageFromText(response.text);
            throw classifyHttpError(response.status, errorMessage, this.providerKind, {
              timeoutOrigin: response.status === 408 ? 'upstream_http_408' : null,
              elapsedMs: Date.now() - startedAt,
              requestTimeoutMs: policy.timeoutMs,
              retryAttempt: attemptIndex + 1
            });
          }

          const payload = JSON.parse(response.text) as OpenAiCompatibleChatCompletionResponse;
          const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
          const outputText = extractOutputText(choice?.message?.content ?? choice?.text ?? '');

          const result = {
            responseId: payload.id ?? `resp_${randomUUID()}`,
            providerId: request.profile.id,
            model: payload.model ?? request.profile.model,
            outputText,
            finishReason: choice?.finish_reason ?? null,
            usage: normalizeUsage(payload.usage),
            metadata: {
              transport: request.profile.transport,
              providerKind: this.providerKind,
              request: redactProviderRequest(request)
            }
          };
          return {
            ...result,
            metadata: {
              ...result.metadata,
              response: redactProviderResponse({
                ...result,
                usage: { ...result.usage }
              })
            }
          };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            const timeoutOrigin = abortOrigin ?? (request.abortSignal?.aborted ? 'request_abort' : 'local_abort');
            throw classifyHttpError(408, 'request timed out', this.providerKind, {
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
              `backend_new provider error: ${this.providerKind} network failure: ${error.message}`,
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
