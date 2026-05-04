import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  McpCapabilityDiscoveryResult,
  McpClientAdapter,
  McpConnectionRequest,
  McpToolCallRequest,
  McpToolCallResult
} from '../../../foundation/mcp/types';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export class StdioMcpClientAdapter implements McpClientAdapter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private currentServerId: string | null = null;

  async connect(request: McpConnectionRequest): Promise<void> {
    if (this.process && this.currentServerId === request.server.id) {
      return;
    }
    if (!request.server.command?.trim()) {
      throw new Error(`backend_new mcp error: stdio server "${request.server.id}" requires command.`);
    }
    this.process?.kill();
    this.process = spawn(request.server.command, request.server.args ?? [], {
      env: {
        ...process.env,
        ...(request.server.env ?? {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.currentServerId = request.server.id;
    const reader = createInterface({ input: this.process.stdout });
    reader.on('line', (line) => {
      try {
        const payload = JSON.parse(line) as {
          id?: string;
          ok?: boolean;
          output?: Record<string, unknown> | null;
          error?: string | null;
          metadata?: Record<string, unknown>;
          capability?: Record<string, unknown>;
        };
        const pending = payload.id ? this.pending.get(payload.id) : null;
        if (!pending || !payload.id) {
          return;
        }
        this.pending.delete(payload.id);
        if (payload.capability && payload.ok !== false) {
          pending.resolve({
            capability: {
              supportsTools: payload.capability.supportsTools !== false,
              supportsPrompts: Boolean(payload.capability.supportsPrompts),
              supportsResources: Boolean(payload.capability.supportsResources),
              supportsStreaming: Boolean(payload.capability.supportsStreaming)
            },
            metadata: payload.metadata ?? {}
          });
          return;
        }
        pending.resolve({
          ok: payload.ok !== false,
          output: payload.output ?? null,
          error: payload.error ?? null,
          metadata: payload.metadata ?? {}
        });
      } catch {
        // Ignore malformed lines from external process.
      }
    });
    this.process.once('exit', () => {
      setTimeout(() => {
        for (const [id, pending] of this.pending.entries()) {
          pending.reject(new Error(`backend_new mcp error: server "${request.server.id}" exited before responding.`));
          this.pending.delete(id);
        }
        this.process = null;
        this.currentServerId = null;
      }, 25);
    });
  }

  async discoverCapabilities(request: McpConnectionRequest): Promise<McpCapabilityDiscoveryResult> {
    await this.connect(request);
    if (!this.process) {
      return {
        capability: {
          supportsTools: true,
          supportsPrompts: false,
          supportsResources: false,
          supportsStreaming: false
        },
        metadata: {
          degraded: true
        }
      };
    }
    const id = `${request.context.turnId}:discover:${Date.now()}`;
    const response = new Promise<McpCapabilityDiscoveryResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as McpCapabilityDiscoveryResult),
        reject
      });
    });
    this.process.stdin.write(`${JSON.stringify({
      id,
      method: 'discoverCapabilities',
      params: {
        context: request.context,
        metadata: request.metadata ?? {}
      }
    })}\n`);
    try {
      return await response;
    } catch {
      return {
        capability: {
          supportsTools: true,
          supportsPrompts: false,
          supportsResources: false,
          supportsStreaming: false
        },
        metadata: {
          degraded: true
        }
      };
    }
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    await this.connect({
      server: request.server,
      context: request.context,
      metadata: request.metadata
    });
    if (!this.process) {
      return {
        ok: false,
        output: null,
        error: 'backend_new mcp error: stdio server is not connected.',
        metadata: {}
      };
    }
    // 头脑图标
    const id = `${request.context.turnId}:${request.toolName}:${Date.now()}`;
    const response = new Promise<McpToolCallResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as McpToolCallResult),
        reject
      });
    });
    this.process.stdin.write(`${JSON.stringify({
      id,
      method: 'callTool',
      params: {
        toolName: request.toolName,
        arguments: request.arguments,
        context: request.context,
        metadata: request.metadata ?? {}
      }
    })}\n`);
    try {
      return await response;
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : 'Unknown MCP tool failure.',
        metadata: {}
      };
    }
  }

  close(): void {
    this.process?.kill();
    this.process = null;
    this.currentServerId = null;
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(new Error('backend_new mcp error: client was closed.'));
      this.pending.delete(id);
    }
  }
}
