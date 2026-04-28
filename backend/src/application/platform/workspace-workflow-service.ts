import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformMemoryRecord } from '../../foundation/repository';
import { PlatformActionResult, WorkspaceDocsImportSummary, WorkspaceWorkflowView } from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';
import {
  WorkspaceDocsManifest,
  WorkspaceWorkflowLoader,
  WorkspaceWorkflowSnapshot
} from './workspace-workflow-loader';

function summarizeInstructions(value: string | null, limit = 320): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return null;
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeWorkspaceRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function createContentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createMemoryId(workspaceRoot: string, sourcePath: string): string {
  const hash = createContentHash(`${workspaceRoot}::${sourcePath}`).slice(0, 12);
  return `workspace_doc_${hash}`;
}

function createImportSummary(
  snapshot: WorkspaceWorkflowSnapshot,
  memories: PlatformMemoryRecord[],
  lastImportResult?: {
    imported: number;
    updated: number;
    skipped: number;
    importedMemoryIds: string[];
  }
): WorkspaceDocsImportSummary {
  const trackedSourcePaths = new Set(snapshot.docsManifest.sources.map((source) => source.path));
  const workspaceMemories = snapshot.workspaceRoot
    ? memories.filter((memory) => (
      memory.metadata?.sourceKind === 'workspace-doc'
      && memory.metadata?.workspaceRoot === snapshot.workspaceRoot
    ))
    : [];
  return {
    trackedSourceCount: trackedSourcePaths.size,
    importedMemoryCount: workspaceMemories.length,
    imported: lastImportResult?.imported ?? 0,
    updated: lastImportResult?.updated ?? 0,
    skipped: lastImportResult?.skipped ?? 0,
    importedMemoryIds: lastImportResult?.importedMemoryIds ?? [],
    lastImportedAt: workspaceMemories.reduce<number | null>((latest, memory) => {
      const timestamp = typeof memory.metadata?.importedAt === 'number' ? memory.metadata.importedAt : null;
      if (timestamp === null) {
        return latest;
      }
      return latest === null ? timestamp : Math.max(latest, timestamp);
    }, null)
  };
}

export class WorkspaceWorkflowService {
  private readonly loader: WorkspaceWorkflowLoader;
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.loader = new WorkspaceWorkflowLoader(foundation.cwd);
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async getView(): Promise<WorkspaceWorkflowView> {
    const snapshot = await this.loader.discover();
    const memories = await this.foundation.memories.list();
    return {
      workspaceRoot: snapshot.workspaceRoot,
      sccDir: snapshot.sccDir,
      projectInstructionsPresent: snapshot.projectInstructionsPresent,
      projectInstructionsSummary: summarizeInstructions(snapshot.projectInstructions),
      commands: snapshot.commands.map((command) => ({
        name: command.name,
        description: command.description,
        args: command.args,
        when: command.when,
        template: command.template
      })),
      rules: snapshot.rules.map((rule) => ({
        name: rule.name,
        summary: rule.summary ?? summarizeInstructions(rule.content, 180),
        paths: [...rule.paths]
      })),
      hooks: snapshot.hooks.map((hook) => ({
        event: hook.event,
        command: hook.command,
        description: hook.description,
        timeoutMs: hook.timeoutMs
      })),
      agents: snapshot.agents.map((agent) => ({
        name: agent.name,
        description: agent.description
      })),
      docsSources: snapshot.docsManifest.sources,
      docsImportSummary: createImportSummary(snapshot, memories),
      ruleSummary: {
        total: snapshot.rules.length,
        pathScoped: snapshot.rules.filter((rule) => rule.paths.length > 0).length,
        alwaysOn: snapshot.rules.filter((rule) => rule.paths.length === 0).length
      },
      hookSummary: {
        total: snapshot.hooks.length,
        events: Array.from(new Set(snapshot.hooks.map((hook) => hook.event))).sort()
      },
      agentSummary: {
        total: snapshot.agents.length,
        names: snapshot.agents.map((agent) => agent.name)
      }
    };
  }

  async initWorkspace(): Promise<PlatformActionResult<WorkspaceWorkflowView>> {
    const workspaceRoot = path.resolve(this.foundation.cwd);
    const sccDir = path.join(workspaceRoot, '.scc');
    const commandsDir = path.join(sccDir, 'commands');
    const command = await this.recorder.recordCommand({
      resourceType: 'WORKSPACE',
      resourceId: workspaceRoot,
      action: 'UPSERT',
      input: {
        workspaceRoot,
        sccDir
      }
    });

    try {
      await fs.mkdir(commandsDir, { recursive: true });
      await fs.mkdir(path.join(sccDir, 'rules'), { recursive: true });
      await fs.mkdir(path.join(sccDir, 'agents'), { recursive: true });
      await this.writeIfMissing(path.join(sccDir, 'project.md'), '# Project Instructions\n\nDescribe repository goals, coding rules, and operator expectations here.\n');
      await this.writeIfMissing(path.join(sccDir, 'docs.json'), '{\n  "sources": []\n}\n');
      await this.writeIfMissing(path.join(sccDir, 'hooks.json'), '{\n  "hooks": []\n}\n');
      const view = await this.getView();
      return await this.recorder.recordApplied(command, view);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async importDocs(): Promise<PlatformActionResult<WorkspaceDocsImportSummary>> {
    const snapshot = await this.loader.discover();
    if (!snapshot.workspaceRoot || !snapshot.sccDir) {
      throw new Error('backend_new workspace error: no .scc directory found in the current workspace.');
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'WORKSPACE',
      resourceId: snapshot.workspaceRoot,
      action: 'IMPORT',
      input: {
        workspaceRoot: snapshot.workspaceRoot,
        sourceCount: snapshot.docsManifest.sources.length
      }
    });

    try {
      const result = await this.performDocsImport(snapshot);
      return await this.recorder.recordApplied(command, result);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  private async performDocsImport(snapshot: WorkspaceWorkflowSnapshot): Promise<WorkspaceDocsImportSummary> {
    const existingMemories = await this.foundation.memories.list();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const importedMemoryIds: string[] = [];
    for (const source of snapshot.docsManifest.sources) {
      const absolutePath = path.resolve(snapshot.workspaceRoot!, source.path);
      const normalizedSourcePath = normalizeWorkspaceRelativePath(source.path);
      const content = await fs.readFile(absolutePath, 'utf8');
      const contentHash = createContentHash(content);
      const title = source.title ?? path.basename(normalizedSourcePath);
      const existing = existingMemories.find((memory) => (
        memory.metadata?.sourceKind === 'workspace-doc'
        && memory.metadata?.workspaceRoot === snapshot.workspaceRoot
        && memory.metadata?.sourcePath === normalizedSourcePath
      )) ?? null;
      if (existing && existing.metadata?.contentHash === contentHash) {
        skipped += 1;
        importedMemoryIds.push(existing.memoryId);
        continue;
      }
      const memoryId = existing?.memoryId ?? createMemoryId(snapshot.workspaceRoot!, normalizedSourcePath);
      const now = Date.now();
      await this.foundation.memories.save({
        memoryId,
        title,
        content,
        scope: 'GLOBAL',
        tags: [...new Set(['workspace-doc', ...source.tags])],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: {
          ...(existing?.metadata ?? {}),
          workspaceRoot: snapshot.workspaceRoot,
          sourcePath: normalizedSourcePath,
          sourceKind: 'workspace-doc',
          contentHash,
          importedAt: now
        }
      });
      importedMemoryIds.push(memoryId);
      if (existing) {
        updated += 1;
      } else {
        imported += 1;
      }
    }
    const memories = await this.foundation.memories.list();
    return createImportSummary(snapshot, memories, {
      imported,
      updated,
      skipped,
      importedMemoryIds
    });
  }

  private async writeIfMissing(targetPath: string, content: string): Promise<void> {
    try {
      await fs.access(targetPath);
    } catch {
      await fs.writeFile(targetPath, content, 'utf8');
    }
  }
}
