import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function normalizeRemoteAddress(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.startsWith('::ffff:')) {
    return value.slice('::ffff:'.length);
  }
  return value;
}

function parseRequestHost(request: IncomingMessage): string | null {
  const host = request.headers.host?.trim();
  if (!host) {
    return null;
  }
  if (host.startsWith('[')) {
    const closingIndex = host.indexOf(']');
    return closingIndex >= 0 ? host.slice(1, closingIndex) : null;
  }
  const [hostname] = host.split(':');
  return hostname?.trim() || null;
}

function isLoopbackHost(hostname: string | null): boolean {
  if (!hostname) {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  return isLoopbackHost(normalizeRemoteAddress(request.socket.remoteAddress));
}

export function isTrustedBrowserOrigin(
  request: IncomingMessage,
  origin: string | undefined | null
): boolean {
  if (!origin?.trim()) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }

  return isLoopbackHost(parsed.hostname) || parsed.hostname === parseRequestHost(request);
}

export function isControlPlaneRequestAuthorized(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const controlPlaneToken = env.BACKEND_NEW_CONTROL_API_TOKEN?.trim();
  const authorization = request.headers.authorization?.trim();

  if (controlPlaneToken && authorization === `Bearer ${controlPlaneToken}`) {
    return true;
  }

  if (!isLoopbackRequest(request)) {
    return false;
  }

  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }

  return isTrustedBrowserOrigin(request, origin);
}

export function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (isTrustedBrowserOrigin(request, origin)) {
    response.setHeader('access-control-allow-origin', origin as string);
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
  response.setHeader('access-control-expose-headers', 'Content-Type');
  response.setHeader('vary', 'Origin');
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) {
    return {} as T;
  }
  return JSON.parse(body) as T;
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
