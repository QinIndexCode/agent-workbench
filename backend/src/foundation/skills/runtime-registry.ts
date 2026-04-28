import { SkillDefinition } from '../extensions/types';
import { SkillRuntime, SkillRuntimeCapability } from './types';

export interface SkillRuntimeRegistration {
  runtime: SkillRuntime;
  capability: SkillRuntimeCapability;
}

function createDefaultSkillRuntimeCapability(): SkillRuntimeCapability {
  return {
    supportsStreaming: false,
    supportsWorkspaceWrite: false,
    supportsNetworkAccess: false
  };
}

export class SkillRuntimeRegistry {
  private readonly runtimes = new Map<string, SkillRuntimeRegistration>();
  private defaultRuntime: SkillRuntimeRegistration | null = null;

  register(
    skillId: string,
    runtime: SkillRuntime,
    capability: Partial<SkillRuntimeCapability> = {}
  ): void {
    if (!skillId.trim()) {
      throw new Error('backend_new skill runtime error: skillId must not be empty.');
    }
    this.runtimes.set(skillId, {
      runtime,
      capability: {
        ...createDefaultSkillRuntimeCapability(),
        ...capability
      }
    });
  }

  resolve(skill: SkillDefinition): SkillRuntime | null {
    return this.resolveEntry(skill)?.runtime ?? null;
  }

  resolveCapability(skill: SkillDefinition): SkillRuntimeCapability | null {
    return this.resolveEntry(skill)?.capability ?? null;
  }

  resolveEntry(skill: SkillDefinition): SkillRuntimeRegistration | null {
    const direct = this.runtimes.get(skill.id) ?? this.runtimes.get(skill.name) ?? null;
    if (direct) {
      return direct;
    }
    if (skill.kind === 'instruction-skill') {
      return null;
    }
    return this.defaultRuntime;
  }

  setDefaultRuntime(
    runtime: SkillRuntime,
    capability: Partial<SkillRuntimeCapability> = {}
  ): void {
    this.defaultRuntime = {
      runtime,
      capability: {
        ...createDefaultSkillRuntimeCapability(),
        ...capability
      }
    };
  }

  hasDefaultRuntime(): boolean {
    return this.defaultRuntime !== null;
  }
}
