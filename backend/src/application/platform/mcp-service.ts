import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { McpServerDefinition } from '../../foundation/extensions/types';
import { PlatformActionResult, McpCatalogEntry, McpTestResult } from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';
import { createAllMcpCatalogEntries, createMcpCatalogEntry } from './capability-hub';

async function persistMcpRegistry(
  foundation: BackendNewFoundation,
  servers: McpServerDefinition[]
): Promise<void> {
  await foundation.storage.writeJson(
    foundation.config.mcp.registryFile,
    { servers },
    foundation.config.storage.jsonSpacing
  );
}

export class McpService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<McpCatalogEntry[]> {
    return createAllMcpCatalogEntries(this.foundation);
  }

  async get(serverId: string): Promise<McpCatalogEntry | null> {
    return createMcpCatalogEntry({
      foundation: this.foundation,
      serverId
    });
  }

  async upsert(input: McpServerDefinition): Promise<PlatformActionResult<McpServerDefinition>> {
    const definition: McpServerDefinition = {
      ...input,
      id: input.id.trim(),
      name: input.name.trim()
    };
    const command = await this.recorder.recordCommand({
      resourceType: 'MCP',
      resourceId: definition.id,
      action: 'UPSERT',
      input: definition as unknown as Record<string, unknown>
    });
    try {
      const snapshot = this.foundation.extensions.snapshot();
      const next = snapshot.mcpServers.filter((server) => server.id !== definition.id);
      next.push(definition);
      this.foundation.extensions.registerMcpServer(definition);
      await persistMcpRegistry(this.foundation, next);
      return await this.recorder.recordApplied(command, definition, {
        count: next.length
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(serverId: string): Promise<PlatformActionResult<{ ok: true; serverId: string }>> {
    const command = await this.recorder.recordCommand({
      resourceType: 'MCP',
      resourceId: serverId,
      action: 'DELETE'
    });
    try {
      const snapshot = this.foundation.extensions.snapshot();
      const next = snapshot.mcpServers.filter((server) => server.id !== serverId);
      if (next.length === snapshot.mcpServers.length) {
        throw new Error(`backend_new mcp error: server "${serverId}" was not found.`);
      }
      this.foundation.extensions.replaceMcpServers?.(next);
      await persistMcpRegistry(this.foundation, next);
      return await this.recorder.recordApplied(command, { ok: true as const, serverId }, {
        count: next.length
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async test(serverId: string): Promise<McpTestResult> {
    const server = this.foundation.extensions.findMcpServer(serverId);
    if (!server) {
      return {
        ok: false,
        serverId,
        message: `backend_new mcp error: server "${serverId}" was not found.`,
        capability: null
      };
    }
    const client = this.foundation.mcpClients.resolve(server);
    const capability = this.foundation.mcpClients.resolveCapability(server);
    if (!client) {
      return {
        ok: false,
        serverId,
        message: `backend_new mcp error: no client registered for "${server.id}".`,
        capability
      };
    }
    try {
      if (typeof client.discoverCapabilities === 'function') {
        const discovered = await client.discoverCapabilities({
          server,
          context: {
            taskId: 'platform_mcp_test',
            sessionId: 'sess_platform_mcp_test',
            correlationId: 'corr_platform_mcp_test',
            turnId: 'turn_platform_mcp_test'
          }
        });
        return {
          ok: true,
          serverId: server.id,
          message: 'Capabilities discovered.',
          capability: discovered.capability
        };
      }
      await client.connect({
        server,
        context: {
          taskId: 'platform_mcp_test',
          sessionId: 'sess_platform_mcp_test',
          correlationId: 'corr_platform_mcp_test',
          turnId: 'turn_platform_mcp_test'
        }
      });
      return {
        ok: true,
        serverId: server.id,
        message: 'MCP server is reachable.',
        capability
      };
    } catch (error) {
      return {
        ok: false,
        serverId: server.id,
        message: error instanceof Error ? error.message : String(error),
        capability
      };
    }
  }
}
