import { ProviderCompletionRequest } from '../../../foundation/providers/client-types';

export type ProviderTimeoutOrigin =
  | 'upstream_http_408'
  | 'local_abort'
  | 'request_abort'
  | null;

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly kind: 'TIMEOUT' | 'RATE_LIMIT' | 'AUTH' | 'UPSTREAM' | 'NETWORK' | 'UNKNOWN',
    readonly statusCode: number | null = null,
    readonly retryable = false,
    public timeoutOrigin: ProviderTimeoutOrigin = null,
    public elapsedMs: number | null = null,
    public requestTimeoutMs: number | null = null,
    public retryAttempt: number | null = null
  ) {
    super(message);
  }
}

export const PROVIDER_FAILURE_CATEGORIES = [
  'timeout',
  'rate_limited',
  'auth_failed',
  'network_retryable',
  'network_non_retryable',
  'provider_contract_error',
  'provider_unavailable'
] as const;

export type ProviderFailureCategory = typeof PROVIDER_FAILURE_CATEGORIES[number];

export interface NormalizedProviderFailure {
  message: string;
  kind: ProviderHttpError['kind'];
  category: ProviderFailureCategory;
  statusCode: number | null;
  retryable: boolean;
  timeoutOrigin: ProviderTimeoutOrigin;
  elapsedMs: number | null;
  requestTimeoutMs: number | null;
  retryAttempt: number | null;
}

export interface ProviderClientPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export function resolveProviderClientPolicy(request: ProviderCompletionRequest): ProviderClientPolicy {
  const metadata = request.metadata ?? {};
  return {
    timeoutMs: Number(metadata.timeoutMs ?? 30_000),
    maxRetries: Number(metadata.maxRetries ?? 2),
    retryBackoffMs: Number(metadata.retryBackoffMs ?? 750)
  };
}

export function redactProviderRequest(request: ProviderCompletionRequest): Record<string, unknown> {
  return {
    providerId: request.profile.id,
    transport: request.profile.transport,
    model: request.profile.model,
    messageCount: request.messages.length,
    stopCount: request.stop?.length ?? 0,
    timeoutMs: request.metadata?.timeoutMs ?? null,
    maxRetries: request.metadata?.maxRetries ?? null
  };
}

export function buildProviderAuthHeaders(request: ProviderCompletionRequest): Record<string, string> {
  const headers: Record<string, string> = {
    ...(request.profile.headers ?? {})
  };
  const auth = request.profile.auth;
  if (!auth || auth.scheme === 'none' || !request.profile.apiKey?.trim()) {
    return headers;
  }

  const headerName = auth.headerName
    ?? (auth.scheme === 'x-api-key' ? 'x-api-key' : 'authorization');
  if (auth.scheme === 'bearer') {
    headers[headerName] = `${auth.prefix ?? 'Bearer'} ${request.profile.apiKey}`;
  } else {
    headers[headerName] = `${auth.prefix ?? ''}${request.profile.apiKey}`;
  }
  return headers;
}

export function redactProviderResponse(response: {
  responseId: string;
  model: string;
  finishReason: string | null;
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    responseId: response.responseId,
    model: response.model,
    finishReason: response.finishReason,
    usage: response.usage,
    metadata: response.metadata
  };
}

export function classifyHttpError(
  status: number,
  message: string,
  providerKind: string,
  metadata: {
    timeoutOrigin?: ProviderTimeoutOrigin;
    elapsedMs?: number | null;
    requestTimeoutMs?: number | null;
    retryAttempt?: number | null;
  } = {}
): ProviderHttpError {
  if (status === 401 || status === 403) {
    return new ProviderHttpError(
      `backend_new provider error: ${providerKind} authentication failed (${status}): ${message}`,
      'AUTH',
      status,
      false,
      metadata.timeoutOrigin ?? null,
      metadata.elapsedMs ?? null,
      metadata.requestTimeoutMs ?? null,
      metadata.retryAttempt ?? null
    );
  }

  if (status === 408 || status === 429) {
    return new ProviderHttpError(
      `backend_new provider error: ${providerKind} rate-limited or timed out upstream (${status}): ${message}`,
      status === 429 ? 'RATE_LIMIT' : 'TIMEOUT',
      status,
      true,
      status === 408 ? (metadata.timeoutOrigin ?? 'upstream_http_408') : (metadata.timeoutOrigin ?? null),
      metadata.elapsedMs ?? null,
      metadata.requestTimeoutMs ?? null,
      metadata.retryAttempt ?? null
    );
  }

  if (status >= 500) {
    return new ProviderHttpError(
      `backend_new provider error: ${providerKind} upstream failed (${status}): ${message}`,
      'UPSTREAM',
      status,
      true,
      metadata.timeoutOrigin ?? null,
      metadata.elapsedMs ?? null,
      metadata.requestTimeoutMs ?? null,
      metadata.retryAttempt ?? null
    );
  }

  return new ProviderHttpError(
    `backend_new provider error: ${providerKind} request failed (${status}): ${message}`,
    'UNKNOWN',
    status,
    false,
    metadata.timeoutOrigin ?? null,
    metadata.elapsedMs ?? null,
    metadata.requestTimeoutMs ?? null,
    metadata.retryAttempt ?? null
  );
}

function classifyProviderFailureCategory(error: {
  kind: ProviderHttpError['kind'];
  statusCode: number | null;
  retryable: boolean;
}): ProviderFailureCategory {
  switch (error.kind) {
    case 'TIMEOUT':
      return 'timeout';
    case 'RATE_LIMIT':
      return 'rate_limited';
    case 'AUTH':
      return 'auth_failed';
    case 'NETWORK':
      return error.retryable ? 'network_retryable' : 'network_non_retryable';
    case 'UPSTREAM':
      return 'provider_unavailable';
    case 'UNKNOWN':
    default:
      if (typeof error.statusCode === 'number') {
        if (error.statusCode >= 500) {
          return 'provider_unavailable';
        }
        if (error.statusCode >= 400) {
          return 'provider_contract_error';
        }
      }
      return 'provider_unavailable';
  }
}

export function normalizeProviderFailure(error: unknown): NormalizedProviderFailure {
  if (error instanceof ProviderHttpError) {
    return {
      message: error.message,
      kind: error.kind,
      category: classifyProviderFailureCategory(error),
      statusCode: error.statusCode,
      retryable: error.retryable,
      timeoutOrigin: error.timeoutOrigin ?? null,
      elapsedMs: error.elapsedMs ?? null,
      requestTimeoutMs: error.requestTimeoutMs ?? null,
      retryAttempt: error.retryAttempt ?? null
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      kind: 'UNKNOWN',
      category: 'provider_unavailable',
      statusCode: null,
      retryable: false,
      timeoutOrigin: null,
      elapsedMs: null,
      requestTimeoutMs: null,
      retryAttempt: null
    };
  }
  return {
    message: 'Unknown provider failure.',
    kind: 'UNKNOWN',
    category: 'provider_unavailable',
    statusCode: null,
    retryable: false,
    timeoutOrigin: null,
    elapsedMs: null,
    requestTimeoutMs: null,
    retryAttempt: null
  };
}

export async function withRetry<T>(
  operation: (attemptIndex: number) => Promise<T>,
  policy: ProviderClientPolicy,
  isRetryable: (error: unknown) => boolean
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= policy.maxRetries) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        error.retryAttempt = attempt + 1;
        if (error.requestTimeoutMs === null) {
          error.requestTimeoutMs = policy.timeoutMs;
        }
      }
      lastError = error;
      if (attempt >= policy.maxRetries || !isRetryable(error)) {
        throw error;
      }
      attempt += 1;
      await new Promise(resolve => setTimeout(resolve, policy.retryBackoffMs * attempt));
    }
  }
  throw lastError;
}
