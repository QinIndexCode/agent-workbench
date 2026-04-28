import { AgentToolDefinition } from '../extensions/types';
import { createDefaultToolExecutorCapability, ToolExecutorCapability } from './executor-capability';
import { ToolExecutor } from './executor-types';

export interface ToolExecutorRegistration {
  executor: ToolExecutor;
  capability: ToolExecutorCapability;
}

export class ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutorRegistration>();

  register(
    toolId: string,
    executor: ToolExecutor,
    capability: Partial<ToolExecutorCapability> = {}
  ): void {
    if (!toolId.trim()) {
      throw new Error('backend_new tool executor error: toolId must not be empty.');
    }
    this.executors.set(toolId, {
      executor,
      capability: {
        ...createDefaultToolExecutorCapability(),
        ...capability
      }
    });
  }

  has(toolId: string): boolean {
    return this.executors.has(toolId);
  }

  resolve(tool: AgentToolDefinition): ToolExecutor | null {
    return this.resolveEntry(tool)?.executor ?? null;
  }

  resolveCapability(tool: AgentToolDefinition): ToolExecutorCapability | null {
    return this.resolveEntry(tool)?.capability ?? null;
  }

  resolveEntry(tool: AgentToolDefinition): ToolExecutorRegistration | null {
    return this.executors.get(tool.id) ?? this.executors.get(tool.name) ?? null;
  }
}
