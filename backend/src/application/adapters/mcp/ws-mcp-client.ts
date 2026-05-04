import WebSocket from 'ws';
import {
  McpCapabilityDiscoveryResult,
  McpClientAdapter,
  McpConnectionRequest,
  McpToolCallRequest,
  McpToolCallResult
} from '../../../foundation/mcp/types';

interface PendingEntry<T = unknown> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function resolveWsUrl(rawUrl: string | undefined): string {
  if (!rawUrl?.trim()) {
    throw new Error('backend_new mcp error: ws transport requires url.');
  }
  return rawUrl;
}

export class WsMcpClientAdapter implements McpClientAdapter {
  private socket: WebSocket | null = null;
  private socketUrl: string | null = null;
  private readonly pending = new Map<string, PendingEntry<McpToolCallResult | McpCapabilityDiscoveryResult>>();
  private openPromise: Promise<void> | null = null;

  async connect(request: McpConnectionRequest): Promise<void> {
    const url = resolveWsUrl(request.server.url);
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.socketUrl === url) {
      return;
    }
    this.close();
    this.socketUrl = url;
    this.socket = new WebSocket(url);
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.socket?.once('open', () => resolve());
      this.socket?.once('error', reject);
    });
    this.socket.on('message', payload => {
      try {
        const data = JSON.parse(payload.toString('utf8')) as {
          id?: string;
          ok?: boolean;
          output?: Record<string, unknown> | null;
          error?: string | null;
          metadata?: Record<string, unknown>;
          capability?: Record<string, unknown>;
        };
        if (!data.id) {
          return;
        }
        const pending = this.pending.get(data.id);
        if (!pending) {
          return;
        }
        this.pending.delete(data.id);
        if (data.capability && data.ok !== false) {
          pending.resolve({
            capability: {
              supportsTools: data.capability.supportsTools !== false,
              supportsPrompts: Boolean(data.capability.supportsPrompts),
              supportsResources: Boolean(data.capability.supportsResources),
              supportsStreaming: Boolean(data.capability.supportsStreaming)
            },
            metadata: data.metadata ?? {}
          });
          return;
        }
        pending.resolve({
          ok: data.ok !== false,
          output: data.output ?? null,
          error: data.error ?? null,
          metadata: {
            transport: 'ws',
            ...(data.metadata ?? {})
          }
        });
      } catch {
        // ignore malformed ws payloads
      }
    });
    this.socket.on('close', () => {
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error(`backend_new mcp error: ws server "${url}" closed before responding.`));
        this.pending.delete(id);
      }
      this.socket = null;
      this.socketUrl = null;
      this.openPromise = null;
    });
    await this.openPromise;
  }

  async discoverCapabilities(request: McpConnectionRequest): Promise<McpCapabilityDiscoveryResult> {
    await this.connect(request);
    const response = await this.sendRequest<McpCapabilityDiscoveryResult>('discoverCapabilities', {
      context: request.context,
      metadata: request.metadata ?? {}
    });
    return response;
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    await this.connect({
      server: request.server,
      context: request.context,
      metadata: request.metadata
    });
    return this.sendRequest<McpToolCallResult>('callTool', {
      toolName: request.toolName,
      arguments: request.arguments,
      context: request.context,
      metadata: request.metadata ?? {}
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.socketUrl = null;
    this.openPromise = null;
  }

  private async sendRequest<T extends McpToolCallResult | McpCapabilityDiscoveryResult>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('backend_new mcp error: ws client is not connected.');
    }
    const id = `${method}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
}
