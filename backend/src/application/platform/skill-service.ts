import fs from 'node:fs/promises';
import path from 'node:path';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import {
  loadSkillPlaceholders,
  readSkillManifest,
  writeSkillManifest
} from '../../foundation/extensions/skill-loader';
import { SkillDefinition, SkillKind } from '../../foundation/extensions/types';
import {
  BulkDeleteResult,
  GovernanceExportBundle,
  PlatformActionResult,
  SkillCatalogEntry,
  SkillDuplicateInput,
  SkillImportInput,
  SkillUpsertInput
} from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';
import { createAllSkillCatalogEntries } from './capability-hub';

interface SkillMarketplacePluginManifest {
  name?: string;
  source?: string;
  skills?: string[];
}

interface SkillMarketplaceFile {
  plugins?: SkillMarketplacePluginManifest[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function normalizeImportedSkillKind(rootDir: string, explicitKind?: SkillKind): Promise<SkillKind> {
  if (explicitKind) {
    return explicitKind;
  }
  try {
    await fs.access(path.join(rootDir, 'SKILL.md'));
    return 'instruction-skill';
  } catch {
    return 'runtime-skill';
  }
}

function normalizeDefinitionName(rootDir: string, providedName?: string | null): string {
  return providedName?.trim() || path.basename(rootDir);
}

function normalizeManagedSkillId(value: string, fallback = 'skill'): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function stripMarkdownFrontMatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized.trim();
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    return normalized.trim();
  }
  return normalized.slice(closingIndex + 5).trim();
}

function buildInstructionSkillMarkdown(input: {
  name: string;
  description?: string;
  content: string;
}): string {
  const body = stripMarkdownFrontMatter(input.content);
  const frontMatter = [
    '---',
    `name: ${input.name}`,
    ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
    '---',
    '',
    body || 'Describe the reusable instruction workflow here.'
  ];
  return `${frontMatter.join('\n').trim()}\n`;
}

function buildRuntimeSkillModule(input: {
  name: string;
  description?: string;
  content: string;
}): string {
  const body = input.content.trim();
  if (body) {
    return `${body}\n`;
  }
  return [
    '/**',
    ` * ${input.name}`,
    ...(input.description?.trim() ? [` * ${input.description.trim()}`] : []),
    ' */',
    'module.exports = {',
    '  async invoke({ input }) {',
    '    return {',
    '      ok: true,',
    '      summary: `Runtime skill executed with ${Object.keys(input ?? {}).length} input field(s).`',
    '    };',
    '  }',
    '};',
    ''
  ].join('\n');
}

function getSkillContentFilePath(skill: SkillDefinition): string {
  if (skill.kind === 'instruction-skill') {
    return skill.instructionSource?.skillFile ?? path.join(skill.rootDir, 'SKILL.md');
  }
  return path.join(skill.rootDir, skill.entryFile ?? 'index.js');
}

function buildSkillExportMarkdown(records: SkillCatalogEntry[]): string {
  const sections = records.map((entry) => [
    `# ${entry.skill.name}`,
    '',
    `- ID: ${entry.skill.id}`,
    `- Kind: ${entry.kind}`,
    `- Source: ${entry.source}`,
    `- Readiness: ${entry.readiness}`,
    `- Editable: ${entry.editable ? 'yes' : 'no'}`,
    `- Root: ${entry.skill.rootDir}`,
    '',
    '## Description',
    entry.skill.description ?? 'No description.',
    '',
    '## Content',
    '```',
    entry.content ?? '',
    '```'
  ].join('\n'));
  return `${sections.join('\n\n---\n\n')}\n`;
}

function isWithinDir(candidatePath: string, parentPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

export class SkillService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<SkillCatalogEntry[]> {
    return createAllSkillCatalogEntries(this.foundation);
  }

  async get(skillId: string): Promise<SkillCatalogEntry | null> {
    return (await this.list()).find((entry) => entry.skill.id === skillId || entry.skill.name === skillId) ?? null;
  }

  async refresh(): Promise<PlatformActionResult<SkillCatalogEntry[]>> {
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: 'catalog',
      action: 'REFRESH',
    });
    try {
      await loadSkillPlaceholders(
        this.foundation.config,
        this.foundation.storage,
        this.foundation.extensions,
        this.foundation.layout
      );
      const skills = await this.list();
      return await this.recorder.recordApplied(command, skills, {
        count: skills.length
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async importSkill(input: SkillImportInput): Promise<PlatformActionResult<SkillDefinition>> {
    if (!input.rootDir?.trim()) {
      throw new Error('backend_new skill error: import requires rootDir.');
    }
    const rootDir = path.resolve(input.rootDir);
    await this.foundation.storage.ensureDir(rootDir);
    const manifest = await readSkillManifest(this.foundation.storage, this.foundation.config, this.foundation.layout);
    const definition: SkillDefinition = {
      id: input.id?.trim() || rootDir,
      name: normalizeDefinitionName(rootDir, input.name),
      rootDir,
      description: input.description?.trim(),
      kind: await normalizeImportedSkillKind(rootDir, input.kind),
      registrationSource: 'IMPORT_MANIFEST'
    };
    const next = manifest.skills.filter(skill => skill.id !== definition.id && skill.rootDir !== definition.rootDir);
    next.push(definition);
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: definition.id,
      action: 'IMPORT',
      input: {
        id: definition.id,
        name: definition.name,
        rootDir: definition.rootDir
      }
    });
    try {
      await writeSkillManifest(
        this.foundation.storage,
        this.foundation.config,
        { skills: next },
        this.foundation.layout
      );
      await loadSkillPlaceholders(
        this.foundation.config,
        this.foundation.storage,
        this.foundation.extensions,
        this.foundation.layout
      );
      return await this.recorder.recordApplied(command, definition);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async create(input: SkillUpsertInput): Promise<PlatformActionResult<SkillCatalogEntry>> {
    const skillId = normalizeManagedSkillId(input.id, 'generated-skill');
    const rootDir = path.join(this.foundation.layout.generatedSkillsDirPath, skillId);
    const definition = await this.writeManagedSkill({
      skillId,
      rootDir,
      input,
      existing: null,
      registrationSource: 'IMPORT_MANIFEST'
    });
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: definition.id,
      action: 'UPSERT',
      input: {
        id: definition.id,
        name: input.name,
        kind: input.kind,
        rootDir
      }
    });
    try {
      await this.persistManifestDefinition(definition);
      await this.reloadSkillRegistry();
      const entry = await this.get(definition.id);
      if (!entry) {
        throw new Error(`backend_new skill error: failed to load created skill "${definition.id}".`);
      }
      return await this.recorder.recordApplied(command, entry);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async update(skillId: string, input: SkillUpsertInput): Promise<PlatformActionResult<SkillCatalogEntry>> {
    const existing = await this.getRequiredSkill(skillId);
    if (!existing.editable) {
      throw new Error(`backend_new skill error: skill "${skillId}" is read-only and must be duplicated before editing.`);
    }
    const definition = await this.writeManagedSkill({
      skillId: existing.skill.id,
      rootDir: existing.skill.rootDir,
      input,
      existing: existing.skill,
      registrationSource: existing.skill.registrationSource ?? 'IMPORT_MANIFEST'
    });
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: existing.skill.id,
      action: 'UPDATE',
      input: {
        id: existing.skill.id,
        name: input.name,
        kind: input.kind
      }
    });
    try {
      if (existing.source === 'generated' || existing.source === 'imported') {
        await this.persistManifestDefinition(definition);
      }
      await this.reloadSkillRegistry();
      const entry = await this.get(existing.skill.id);
      if (!entry) {
        throw new Error(`backend_new skill error: failed to load updated skill "${existing.skill.id}".`);
      }
      return await this.recorder.recordApplied(command, entry);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(skillId: string): Promise<PlatformActionResult<{ ok: true; skillId: string }>> {
    const existing = await this.getRequiredSkill(skillId);
    if (!existing.deletable) {
      throw new Error(`backend_new skill error: skill "${skillId}" cannot be deleted from this source.`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: existing.skill.id,
      action: 'DELETE'
    });
    try {
      await this.removeManifestDefinition(existing.skill.id);
      if (existing.source === 'generated' && isWithinDir(existing.skill.rootDir, this.foundation.layout.generatedSkillsDirPath)) {
        await this.foundation.storage.deleteDir(existing.skill.rootDir);
      }
      await this.reloadSkillRegistry();
      return await this.recorder.recordApplied(command, { ok: true as const, skillId: existing.skill.id });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async bulkRemove(skillIds: string[]): Promise<PlatformActionResult<BulkDeleteResult>> {
    const requestedIds = [...new Set(skillIds.map((id) => id.trim()).filter(Boolean))];
    const deletedIds: string[] = [];
    const failed: BulkDeleteResult['failed'] = [];
    for (const skillId of requestedIds) {
      try {
        await this.remove(skillId);
        deletedIds.push(skillId);
      } catch (error) {
        failed.push({ id: skillId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.recorder.applied({
      resourceType: 'SKILL',
      resourceId: 'skill-bulk-delete',
      action: 'DELETE',
      resource: { requestedIds, deletedIds, failed }
    });
  }

  async export(format: 'json' | 'markdown' = 'json'): Promise<GovernanceExportBundle<SkillCatalogEntry>> {
    const records = await this.list();
    const generatedAt = Date.now();
    const content = format === 'markdown'
      ? buildSkillExportMarkdown(records)
      : JSON.stringify({ generatedAt, records }, null, this.foundation.config.storage.jsonSpacing);
    return { generatedAt, format, records, content };
  }

  async duplicate(skillId: string, input: SkillDuplicateInput): Promise<PlatformActionResult<SkillCatalogEntry>> {
    const source = await this.getRequiredSkill(skillId);
    const duplicateId = normalizeManagedSkillId(
      input.id ?? `${source.skill.name}-copy`,
      `${normalizeManagedSkillId(source.skill.name)}-copy`
    );
    const definition = await this.writeManagedSkill({
      skillId: duplicateId,
      rootDir: path.join(this.foundation.layout.generatedSkillsDirPath, duplicateId),
      input: {
        id: duplicateId,
        name: input.name?.trim() || `${source.skill.name} copy`,
        description: source.skill.description,
        kind: source.kind,
        content: source.content ?? ''
      },
      existing: null,
      registrationSource: 'IMPORT_MANIFEST'
    });
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: definition.id,
      action: 'IMPORT',
      input: {
        sourceSkillId: source.skill.id,
        duplicateId: definition.id
      }
    });
    try {
      await this.persistManifestDefinition(definition);
      await this.reloadSkillRegistry();
      const entry = await this.get(definition.id);
      if (!entry) {
        throw new Error(`backend_new skill error: failed to load duplicated skill "${definition.id}".`);
      }
      return await this.recorder.recordApplied(command, entry);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async importMarketplace(input: {
    marketplaceFile: string;
    pluginName: string;
    skillPath?: string;
  }): Promise<PlatformActionResult<SkillDefinition[]>> {
    const marketplaceFile = path.resolve(input.marketplaceFile);
    const command = await this.recorder.recordCommand({
      resourceType: 'SKILL',
      resourceId: input.pluginName,
      action: 'IMPORT',
      input: {
        marketplaceFile,
        pluginName: input.pluginName,
        skillPath: input.skillPath ?? null
      }
    });
    try {
      const imported = await this.performMarketplaceImport({
        marketplaceFile,
        pluginName: input.pluginName,
        skillPath: input.skillPath
      });
      return await this.recorder.recordApplied(command, imported, {
        count: imported.length
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async invoke(input: {
    skillIdOrName: string;
    taskId: string;
    unitId?: string | null;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId?: string | null;
    payload: Record<string, unknown>;
  }) {
    const skill = this.foundation.extensions.findSkill(input.skillIdOrName);
    if (!skill) {
      throw new Error(`backend_new skill error: unknown skill "${input.skillIdOrName}".`);
    }
    const runtime = this.foundation.skillRuntimes.resolve(skill);
    if (!runtime) {
      throw new Error(`backend_new skill error: no runtime registered for "${skill.id}".`);
    }
    return runtime.invoke({
      skill,
      context: {
        taskId: input.taskId,
        unitId: input.unitId ?? null,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        turnId: input.turnId,
        checkpointId: input.checkpointId ?? null
      },
      input: input.payload
    });
  }

  private async performMarketplaceImport(input: {
    marketplaceFile: string;
    pluginName: string;
    skillPath?: string;
  }): Promise<SkillDefinition[]> {
    const manifest = JSON.parse(await fs.readFile(input.marketplaceFile, 'utf8')) as SkillMarketplaceFile;
    const plugin = (manifest.plugins ?? []).find((entry) => entry.name === input.pluginName);
    if (!plugin) {
      throw new Error(`backend_new skill error: plugin "${input.pluginName}" was not found in marketplace.`);
    }
    const marketplaceDir = path.dirname(input.marketplaceFile);
    const declaredSource = plugin.source ?? '.';
    const marketplaceScopedSourceRoot = path.resolve(marketplaceDir, declaredSource);
    const repositoryScopedSourceRoot = path.basename(marketplaceDir).toLowerCase() === '.claude-plugin'
      ? path.resolve(path.dirname(marketplaceDir), declaredSource)
      : null;
    const declaredSkillPaths = Array.isArray(plugin.skills) ? plugin.skills : [];
    const selectedSkillPaths = input.skillPath?.trim()
      ? declaredSkillPaths.filter((skillPath) => skillPath === input.skillPath || path.basename(skillPath) === input.skillPath)
      : declaredSkillPaths;
    if (selectedSkillPaths.length === 0) {
      throw new Error(`backend_new skill error: no skill entries matched plugin "${input.pluginName}".`);
    }

    const manifestStore = await readSkillManifest(this.foundation.storage, this.foundation.config, this.foundation.layout);
    const next = [...manifestStore.skills];
    const imported: SkillDefinition[] = [];

    for (const skillPath of selectedSkillPaths) {
      const prefersRepositoryRoot = Boolean(
        repositoryScopedSourceRoot
        && /^(?:\.\/)?skills[\\/]/i.test(skillPath)
      );
      const sourceRootCandidates = [
        ...(prefersRepositoryRoot && repositoryScopedSourceRoot ? [repositoryScopedSourceRoot] : []),
        marketplaceScopedSourceRoot,
        ...(!prefersRepositoryRoot && repositoryScopedSourceRoot ? [repositoryScopedSourceRoot] : [])
      ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
      const resolvedCandidates = sourceRootCandidates.map((sourceRoot) => path.resolve(sourceRoot, skillPath));
      let rootDir = resolvedCandidates[0];
      for (const candidate of resolvedCandidates) {
        if (await pathExists(candidate)) {
          rootDir = candidate;
          break;
        }
      }
      const definition: SkillDefinition = {
        id: rootDir,
        name: path.basename(rootDir),
        rootDir,
        kind: 'instruction-skill',
        registrationSource: 'IMPORT_MANIFEST',
        instructionSource: {
          format: 'claude-style-skill',
          skillFile: path.join(rootDir, 'SKILL.md'),
          marketplaceFile: input.marketplaceFile,
          pluginName: input.pluginName
        },
        metadata: {
          marketplacePlugin: input.pluginName,
          marketplaceSkillPath: skillPath
        }
      };
      const existingIndex = next.findIndex((skill) => skill.id === definition.id || skill.rootDir === definition.rootDir);
      if (existingIndex >= 0) {
        next.splice(existingIndex, 1, definition);
      } else {
        next.push(definition);
      }
      imported.push(definition);
    }

    await writeSkillManifest(
      this.foundation.storage,
      this.foundation.config,
      { skills: next },
      this.foundation.layout
    );
    await loadSkillPlaceholders(
      this.foundation.config,
      this.foundation.storage,
      this.foundation.extensions,
      this.foundation.layout
    );
    return imported;
  }

  private async getRequiredSkill(skillId: string): Promise<SkillCatalogEntry> {
    const skill = await this.get(skillId);
    if (!skill) {
      throw new Error(`backend_new skill error: skill "${skillId}" was not found.`);
    }
    return skill;
  }

  private async reloadSkillRegistry(): Promise<void> {
    await loadSkillPlaceholders(
      this.foundation.config,
      this.foundation.storage,
      this.foundation.extensions,
      this.foundation.layout
    );
  }

  private async persistManifestDefinition(definition: SkillDefinition): Promise<void> {
    const manifest = await readSkillManifest(this.foundation.storage, this.foundation.config, this.foundation.layout);
    const next = manifest.skills.filter((skill) => skill.id !== definition.id && skill.rootDir !== definition.rootDir);
    next.push(definition);
    await writeSkillManifest(
      this.foundation.storage,
      this.foundation.config,
      { skills: next },
      this.foundation.layout
    );
  }

  private async removeManifestDefinition(skillId: string): Promise<void> {
    const manifest = await readSkillManifest(this.foundation.storage, this.foundation.config, this.foundation.layout);
    const next = manifest.skills.filter((skill) => skill.id !== skillId);
    await writeSkillManifest(
      this.foundation.storage,
      this.foundation.config,
      { skills: next },
      this.foundation.layout
    );
  }

  private async writeManagedSkill(params: {
    skillId: string;
    rootDir: string;
    input: SkillUpsertInput;
    existing: SkillDefinition | null;
    registrationSource: SkillDefinition['registrationSource'];
  }): Promise<SkillDefinition> {
    const skillId = normalizeManagedSkillId(params.skillId, 'managed-skill');
    const rootDir = path.resolve(params.rootDir);
    await this.foundation.storage.ensureDir(rootDir);
    const name = params.input.name.trim();
    const description = params.input.description?.trim() || undefined;
    const kind = params.input.kind;
    if (!name) {
      throw new Error('backend_new skill error: skill name must not be empty.');
    }
    if (!params.input.content.trim() && kind === 'instruction-skill') {
      throw new Error('backend_new skill error: instruction skills require markdown content.');
    }

    if (kind === 'instruction-skill') {
      await this.foundation.storage.writeText(
        path.join(rootDir, 'SKILL.md'),
        buildInstructionSkillMarkdown({
          name,
          description,
          content: params.input.content
        }),
        this.foundation.config.storage.encoding
      );
      if (await this.foundation.storage.exists(path.join(rootDir, 'index.js'))) {
        await this.foundation.storage.deleteFile(path.join(rootDir, 'index.js'));
      }
    } else {
      await this.foundation.storage.writeText(
        path.join(rootDir, 'index.js'),
        buildRuntimeSkillModule({
          name,
          description,
          content: params.input.content
        }),
        this.foundation.config.storage.encoding
      );
      if (await this.foundation.storage.exists(path.join(rootDir, 'SKILL.md'))) {
        await this.foundation.storage.deleteFile(path.join(rootDir, 'SKILL.md'));
      }
    }

    const next: SkillDefinition = {
      id: params.existing?.id ?? skillId,
      name,
      rootDir,
      description,
      kind,
      entryFile: kind === 'runtime-skill' ? 'index.js' : undefined,
      registrationSource: params.registrationSource,
      metadata: {
        ...(params.existing?.metadata ?? {}),
        managedBy: 'settings-ui',
        lastEditedAt: Date.now()
      },
      instructionSource: kind === 'instruction-skill'
        ? {
          format: 'claude-style-skill',
          skillFile: path.join(rootDir, 'SKILL.md'),
          marketplaceFile: params.existing?.instructionSource?.marketplaceFile ?? null,
          pluginName: params.existing?.instructionSource?.pluginName ?? null
        }
        : undefined
    };

    if (kind === 'runtime-skill') {
      delete next.instructionSource;
    }

    return next;
  }
}
