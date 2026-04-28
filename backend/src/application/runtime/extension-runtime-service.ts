import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { McpToolCallResult } from '../../foundation/mcp/types';
import { SkillInvocationResult } from '../../foundation/skills/types';

export class ExtensionRuntimeService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async invokeSkill(params: {
    taskId: string;
    skillId: string;
    input: Record<string, unknown>;
    unitId?: string | null;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId?: string | null;
  }): Promise<SkillInvocationResult> {
    const skill = this.foundation.extensions.findSkill(params.skillId);
    if (!skill) {
      return {
        ok: false,
        output: null,
        error: `backend_new skill error: skill "${params.skillId}" was not found.`,
        metadata: {}
      };
    }
    const runtime = this.foundation.skillRuntimes.resolve(skill);
    if (!runtime) {
      return {
        ok: false,
        output: null,
        error: `backend_new skill error: no runtime registered for "${skill.id}".`,
        metadata: {}
      };
    }
    return runtime.invoke({
      skill,
      input: params.input,
      context: {
        taskId: params.taskId,
        unitId: params.unitId ?? null,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId ?? null
      }
    });
  }

  async callMcpTool(params: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    sessionId: string;
    correlationId: string;
    turnId: string;
  }): Promise<McpToolCallResult> {
    const server = this.foundation.extensions.findMcpServer(params.serverId);
    if (!server) {
      return {
        ok: false,
        output: null,
        error: `backend_new mcp error: server "${params.serverId}" was not found.`,
        metadata: {}
      };
    }
    const client = this.foundation.mcpClients.resolve(server);
    if (!client) {
      return {
        ok: false,
        output: null,
        error: `backend_new mcp error: no client registered for "${server.id}".`,
        metadata: {}
      };
    }
    return client.callTool({
      server,
      toolName: params.toolName,
      arguments: params.arguments,
      context: {
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId
      }
    });
  }
}
