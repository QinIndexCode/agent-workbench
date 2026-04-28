import { BackendNewConfig } from '../config/types';
import { StorageAdapter } from '../storage/types';
import { ExtensionRegistry } from './registry';
import { AgentToolDefinition, McpServerDefinition } from './types';

function ensureArray<T>(value: unknown, key: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`backend_new extension error: "${key}" must be an array.`);
  }
  return value as T[];
}

export async function loadExtensionManifests(
  config: BackendNewConfig,
  storage: StorageAdapter,
  registry: ExtensionRegistry
): Promise<void> {
  if (config.mcp.enabled && await storage.exists(config.mcp.registryFile)) {
    const parsed = await storage.readJson<{ servers?: McpServerDefinition[] }>(
      config.mcp.registryFile,
      config.storage.encoding
    );
    for (const server of ensureArray<McpServerDefinition>(parsed.servers ?? [], 'servers')) {
      registry.registerMcpServer(server);
    }
  }

  if (await storage.exists(config.tools.manifestFile)) {
    const parsed = await storage.readJson<{ tools?: AgentToolDefinition[] }>(
      config.tools.manifestFile,
      config.storage.encoding
    );
    for (const tool of ensureArray<AgentToolDefinition>(parsed.tools ?? [], 'tools')) {
      registry.registerTool(tool);
    }
  }
}
