import { ExtensionRegistry } from '../extensions/registry';
import { McpServerDefinition } from '../extensions/types';
import { McpClientRegistry } from './client-registry';
import { McpClientCapability } from './types';

export interface McpCatalogEntry {
  server: McpServerDefinition;
  capability: McpClientCapability | null;
  hasClient: boolean;
}

export function createMcpCatalogView(
  extensions: ExtensionRegistry,
  clients: McpClientRegistry
): McpCatalogEntry[] {
  return extensions.snapshot().mcpServers.map(server => ({
    server,
    capability: clients.resolveCapability(server),
    hasClient: !!clients.resolve(server)
  }));
}
