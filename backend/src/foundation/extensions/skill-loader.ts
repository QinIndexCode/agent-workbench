import fs from 'node:fs/promises';
import path from 'node:path';
import { BackendNewConfig } from '../config/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { ExtensionRegistry } from './registry';
import {
  InstructionSkillAssetSummary,
  InstructionSkillSource,
  SkillDefinition,
  SkillKind,
  SkillRegistrationSource
} from './types';

interface SkillManifestStore {
  skills: SkillDefinition[];
}

interface ParsedSkillMarkdown {
  name: string | null;
  description: string | null;
  metadata: Record<string, string>;
}

const MODULE_ENTRY_CANDIDATES = ['index.js', 'index.cjs', 'index.mjs'];
const TEMPLATE_FILE_PATTERN = /\.(html?|mdx?|txt|json|ya?ml|toml|csv|xml)$/i;
const SCRIPT_FILE_PATTERN = /\.(cjs|mjs|js|ts|py|sh|ps1|bat)$/i;

function parseFrontMatter(markdown: string): ParsedSkillMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      name: null,
      description: null,
      metadata: {}
    };
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    return {
      name: null,
      description: null,
      metadata: {}
    };
  }
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, closingIndex).split('\n')) {
    const match = line.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+?)\s*$/i);
    if (match) {
      fields[match[1].trim().toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return {
    name: fields.name ?? null,
    description: fields.description ?? null,
    metadata: fields
  };
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimeEntryFile(rootDir: string, entryFile?: string): Promise<string | undefined> {
  if (entryFile?.trim()) {
    return entryFile.trim();
  }
  for (const candidate of MODULE_ENTRY_CANDIDATES) {
    if (await fileExists(path.join(rootDir, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function readInstructionSkillMetadata(rootDir: string): Promise<{
  markdown: ParsedSkillMarkdown | null;
  instructionSource: InstructionSkillSource | null;
}> {
  const skillFile = path.join(rootDir, 'SKILL.md');
  if (!await fileExists(skillFile)) {
    return {
      markdown: null,
      instructionSource: null
    };
  }
  const content = await fs.readFile(skillFile, 'utf8');
  return {
    markdown: parseFrontMatter(content),
    instructionSource: {
      format: 'claude-style-skill',
      skillFile
    }
  };
}

async function collectInstructionAssetSummary(rootDir: string): Promise<InstructionSkillAssetSummary> {
  const summary: InstructionSkillAssetSummary = {
    totalFiles: 0,
    markdownFiles: 0,
    scriptFiles: 0,
    templateFiles: 0,
    assetFiles: 0,
    samplePaths: []
  };

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      summary.totalFiles += 1;
      if (/\.md$/i.test(entry.name)) {
        summary.markdownFiles += 1;
      } else if (SCRIPT_FILE_PATTERN.test(entry.name)) {
        summary.scriptFiles += 1;
      } else if (TEMPLATE_FILE_PATTERN.test(entry.name)) {
        summary.templateFiles += 1;
      } else {
        summary.assetFiles += 1;
      }
      if (summary.samplePaths.length < 6) {
        summary.samplePaths.push(relativePath);
      }
    }
  }

  await walk(rootDir);
  return summary;
}

export async function loadSkillPlaceholders(
  config: BackendNewConfig,
  storage: StorageAdapter,
  registry: ExtensionRegistry,
  layout = new StorageLayout(config)
): Promise<void> {
  if (!config.skills.enabled) {
    registry.replaceSkills([]);
    return;
  }

  const reconciled = new Map<string, SkillDefinition>();
  const preserved = registry.snapshot().skills.filter((skill) => (
    skill.registrationSource !== 'CONFIG_ROOT'
    && skill.registrationSource !== 'IMPORT_MANIFEST'
  ));

  for (const rootDir of config.skills.roots) {
    await registerDeclaredSkill(storage, reconciled, {
      id: rootDir,
      name: path.basename(rootDir),
      rootDir,
      registrationSource: 'CONFIG_ROOT'
    });
  }

  const manifest = await readSkillManifest(storage, config, layout);
  for (const definition of manifest.skills) {
    await registerDeclaredSkill(storage, reconciled, definition);
  }

  for (const skill of preserved) {
    if (!reconciled.has(skill.id)) {
      reconciled.set(skill.id, skill);
    }
  }

  const next = Array.from(reconciled.values()).sort((left, right) => left.name.localeCompare(right.name));
  registry.replaceSkills(next);
}

export async function readSkillManifest(
  storage: StorageAdapter,
  config: BackendNewConfig,
  layout = new StorageLayout(config)
): Promise<SkillManifestStore> {
  if (!await storage.exists(layout.skillManifestPath)) {
    return { skills: [] };
  }
  const manifest = await storage.readJson<SkillManifestStore>(layout.skillManifestPath, config.storage.encoding);
  return {
    skills: Array.isArray(manifest.skills) ? manifest.skills : []
  };
}

export async function writeSkillManifest(
  storage: StorageAdapter,
  config: BackendNewConfig,
  manifest: SkillManifestStore,
  layout = new StorageLayout(config)
): Promise<void> {
  await storage.ensureDir(layout.platformDirPath);
  await storage.writeJson(layout.skillManifestPath, manifest, config.storage.jsonSpacing);
}

async function registerDeclaredSkill(
  storage: StorageAdapter,
  target: Map<string, SkillDefinition>,
  definition: SkillDefinition
): Promise<void> {
  const rootDir = path.resolve(definition.rootDir);
  if (!await storage.exists(rootDir)) {
    return;
  }
  const [resolvedEntryFile, instructionMetadata] = await Promise.all([
    resolveRuntimeEntryFile(rootDir, definition.entryFile),
    readInstructionSkillMetadata(rootDir)
  ]);
  const kind: SkillKind = definition.kind
    ?? (instructionMetadata.markdown ? 'instruction-skill' : 'runtime-skill');
  const skill: SkillDefinition = {
    id: definition.id?.trim() || rootDir,
    name: definition.name?.trim()
      || instructionMetadata.markdown?.name?.trim()
      || path.basename(rootDir),
    rootDir,
    description: definition.description?.trim() || instructionMetadata.markdown?.description?.trim(),
    entryFile: kind === 'runtime-skill' ? resolvedEntryFile : undefined,
    kind,
    assetSummary: kind === 'instruction-skill'
      ? await collectInstructionAssetSummary(rootDir)
      : definition.assetSummary,
    instructionSource: kind === 'instruction-skill'
      ? {
        ...(instructionMetadata.instructionSource ?? {
          format: 'claude-style-skill' as const,
          skillFile: path.join(rootDir, 'SKILL.md')
        }),
        marketplaceFile: definition.instructionSource?.marketplaceFile ?? null,
        pluginName: definition.instructionSource?.pluginName ?? null
      }
      : undefined,
    metadata: kind === 'instruction-skill'
      ? {
        ...(definition.metadata ?? {}),
        ...(instructionMetadata.markdown?.metadata ?? {})
      }
      : definition.metadata,
    registrationSource: normalizeRegistrationSource(definition.registrationSource)
  };
  target.set(skill.id, skill);
}

function normalizeRegistrationSource(value: SkillRegistrationSource | undefined): SkillRegistrationSource {
  return value === 'IMPORT_MANIFEST' ? 'IMPORT_MANIFEST' : 'CONFIG_ROOT';
}
