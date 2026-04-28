import { ExtensionRegistry } from '../extensions/registry';
import { SkillDefinition } from '../extensions/types';
import { SkillRuntimeRegistry } from './runtime-registry';
import { SkillRuntimeCapability } from './types';

export interface SkillCatalogEntry {
  skill: SkillDefinition;
  capability: SkillRuntimeCapability | null;
  hasRuntime: boolean;
  kind: NonNullable<SkillDefinition['kind']>;
  readiness: 'ready' | 'metadata-only' | 'missing-runtime';
  assetSummary: SkillDefinition['assetSummary'] | null;
  instructionSource: SkillDefinition['instructionSource'] | null;
}

export function createSkillCatalogView(
  extensions: ExtensionRegistry,
  runtimes: SkillRuntimeRegistry
): SkillCatalogEntry[] {
  return extensions.snapshot().skills.map((skill) => {
    const capability = runtimes.resolveCapability(skill);
    const hasRuntime = !!runtimes.resolve(skill);
    const kind = skill.kind ?? 'runtime-skill';
    const readiness = hasRuntime
      ? 'ready'
      : kind === 'instruction-skill'
        ? 'metadata-only'
        : 'missing-runtime';
    return {
      skill,
      capability,
      hasRuntime,
      kind,
      readiness,
      assetSummary: skill.assetSummary ?? null,
      instructionSource: skill.instructionSource ?? null
    };
  });
}
