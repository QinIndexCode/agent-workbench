import {
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolRiskLevel,
  ExtensionCatalogSnapshot,
  McpServerDefinition,
  SkillDefinition
} from './types';

function assertUniqueIds<T extends { id: string }>(items: T[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`backend_new extension error: duplicate ${kind} id "${item.id}".`);
    }
    seen.add(item.id);
  }
}

export class ExtensionRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly mcpServers = new Map<string, McpServerDefinition>();
  private readonly tools = new Map<string, AgentToolDefinition>();

  registerSkill(definition: SkillDefinition): void {
    this.register(this.skills, definition, 'skill');
  }

  replaceSkills(definitions: SkillDefinition[]): void {
    this.skills.clear();
    for (const definition of definitions) {
      this.registerSkill(definition);
    }
  }

  replaceMcpServers(definitions: McpServerDefinition[]): void {
    this.mcpServers.clear();
    for (const definition of definitions) {
      this.registerMcpServer(definition);
    }
  }

  registerMcpServer(definition: McpServerDefinition): void {
    this.register(this.mcpServers, definition, 'mcp server');
  }

  registerTool(definition: AgentToolDefinition): void {
    assertValidToolDefinition(definition);
    this.register(this.tools, definition, 'tool');
  }

  findSkill(skillIdOrName: string): SkillDefinition | null {
    if (!skillIdOrName.trim()) {
      return null;
    }
    for (const skill of this.skills.values()) {
      if (skill.id === skillIdOrName || skill.name === skillIdOrName) {
        return skill;
      }
    }
    return null;
  }

  findMcpServer(serverIdOrName: string): McpServerDefinition | null {
    if (!serverIdOrName.trim()) {
      return null;
    }
    for (const server of this.mcpServers.values()) {
      if (server.id === serverIdOrName || server.name === serverIdOrName) {
        return server;
      }
    }
    return null;
  }

  findTool(toolIdOrName: string): AgentToolDefinition | null {
    if (!toolIdOrName.trim()) {
      return null;
    }
    for (const tool of this.tools.values()) {
      if (tool.id === toolIdOrName || tool.name === toolIdOrName) {
        return tool;
      }
    }
    return null;
  }

  snapshot(): ExtensionCatalogSnapshot {
    const snapshot: ExtensionCatalogSnapshot = {
      skills: Array.from(this.skills.values()),
      mcpServers: Array.from(this.mcpServers.values()),
      tools: Array.from(this.tools.values())
    };
    assertUniqueIds(snapshot.skills, 'skill');
    assertUniqueIds(snapshot.mcpServers, 'mcp server');
    assertUniqueIds(snapshot.tools, 'tool');
    return snapshot;
  }

  private register<T extends { id: string }>(
    target: Map<string, T>,
    definition: T,
    kind: string
  ): void {
    if (!definition.id.trim()) {
      throw new Error(`backend_new extension error: ${kind} id must not be empty.`);
    }
    target.set(definition.id, definition);
  }
}

function assertValidToolDefinition(definition: AgentToolDefinition): void {
  const allowedEffects: AgentToolEffect[] = ['READ', 'WRITE', 'PROCESS', 'NETWORK'];
  const allowedRiskLevels: AgentToolRiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

  if (!definition.name.trim()) {
    throw new Error('backend_new extension error: tool name must not be empty.');
  }
  if (!definition.description.trim()) {
    throw new Error('backend_new extension error: tool description must not be empty.');
  }
  if (!allowedEffects.includes(definition.effect)) {
    throw new Error(`backend_new extension error: unsupported tool effect "${definition.effect}".`);
  }
  if (!allowedRiskLevels.includes(definition.riskLevel)) {
    throw new Error(`backend_new extension error: unsupported tool risk level "${definition.riskLevel}".`);
  }
  if (!Array.isArray(definition.inputSchema)) {
    throw new Error('backend_new extension error: tool inputSchema must be an array.');
  }
}
