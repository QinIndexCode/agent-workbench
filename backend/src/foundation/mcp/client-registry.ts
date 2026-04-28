import { McpServerDefinition } from '../extensions/types';
import { McpClientAdapter, McpClientCapability } from './types';

export interface McpClientRegistration {
  client: McpClientAdapter;
  capability: McpClientCapability;
}

function createDefaultMcpClientCapability(): McpClientCapability {
  return {
    supportsTools: true,
    supportsPrompts: false,
    supportsResources: false,
    supportsStreaming: false
  };
}

export class McpClientRegistry {
  private readonly clients = new Map<string, McpClientRegistration>();
  private readonly transports = new Map<McpServerDefinition['transport'], McpClientRegistration>();

  register(
    serverId: string,
    client: McpClientAdapter,
    capability: Partial<McpClientCapability> = {}
  ): void {
    if (!serverId.trim()) {
      throw new Error('backend_new mcp error: serverId must not be empty.');
    }
    this.clients.set(serverId, {
      client,
      capability: {
        ...createDefaultMcpClientCapability(),
        ...capability
      }
    });
  }

  resolve(server: McpServerDefinition): McpClientAdapter | null {
    return this.resolveEntry(server)?.client ?? null;
  }

  resolveCapability(server: McpServerDefinition): McpClientCapability | null {
    return this.resolveEntry(server)?.capability ?? null;
  }

  resolveEntry(server: McpServerDefinition): McpClientRegistration | null {
    return this.clients.get(server.id)
      ?? this.runtimesByName(server.name)
      ?? this.transports.get(server.transport)
      ?? null;
  }

  registerTransport(
    transport: McpServerDefinition['transport'],
    client: McpClientAdapter,
    capability: Partial<McpClientCapability> = {}
  ): void {
    this.transports.set(transport, {
      client,
      capability: {
        ...createDefaultMcpClientCapability(),
        ...capability
      }
    });
  }

  hasTransport(transport: McpServerDefinition['transport']): boolean {
    return this.transports.has(transport);
  }

  private runtimesByName(name: string): McpClientRegistration | null {
    for (const [key, value] of this.clients.entries()) {
      if (key === name) {
        return value;
      }
    }
    return null;
  }
}
