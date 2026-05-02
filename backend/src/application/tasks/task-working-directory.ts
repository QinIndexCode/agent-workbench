import path from 'node:path';
import type { TaskDefinition } from '../../domain/contracts/types';

export const TASK_WORKING_DIRECTORY_STATUSES = ['explicit', 'default', 'missing'] as const;
export type TaskWorkingDirectoryStatus = typeof TASK_WORKING_DIRECTORY_STATUSES[number];

export const TASK_WORKING_DIRECTORY_SOURCES = ['operator', 'runtime_default', 'metadata', 'missing'] as const;
export type TaskWorkingDirectorySource = typeof TASK_WORKING_DIRECTORY_SOURCES[number];

export interface TaskWorkingDirectorySettings {
  status: TaskWorkingDirectoryStatus;
  workingDirectory: string | null;
  source: TaskWorkingDirectorySource;
  requiresSelection: boolean;
  guidance: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/../')) {
    return null;
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    return path.normalize(normalized);
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeStatus(value: unknown, hasDirectory: boolean): TaskWorkingDirectoryStatus {
  if (hasDirectory && value === 'default') {
    return 'default';
  }
  if (hasDirectory) {
    return 'explicit';
  }
  return 'missing';
}

function normalizeSource(value: unknown, hasDirectory: boolean, fallback: TaskWorkingDirectorySource): TaskWorkingDirectorySource {
  if (!hasDirectory) {
    return 'missing';
  }
  return TASK_WORKING_DIRECTORY_SOURCES.includes(value as TaskWorkingDirectorySource)
    ? value as TaskWorkingDirectorySource
    : fallback;
}

export function normalizeTaskWorkingDirectory(input: {
  workingDirectory?: unknown;
  metadata?: Record<string, unknown> | undefined;
}): TaskWorkingDirectorySettings {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const workspace = isRecord(metadata.agentWorkspace) ? metadata.agentWorkspace : {};
  const explicitDirectory = normalizePathText(input.workingDirectory);
  const metadataDirectory = normalizePathText(workspace.workingDirectory ?? metadata.workingDirectory);
  const workingDirectory = explicitDirectory ?? metadataDirectory;
  const hasDirectory = Boolean(workingDirectory);
  const source = normalizeSource(
    workspace.source ?? metadata.workingDirectorySource,
    hasDirectory,
    explicitDirectory ? 'operator' : 'metadata'
  );
  const status = normalizeStatus(workspace.status, hasDirectory);
  const requiresSelection = !workingDirectory;
  return {
    status,
    workingDirectory,
    source,
    requiresSelection,
    guidance: requiresSelection
      ? 'No project working directory was selected. Use the isolated task workspace for sandboxed artifacts, and ask the operator before reading project files or running project-local commands.'
      : `Use ${workingDirectory} as the operator-selected project working directory for project-local commands when tool policy allows it.`
  };
}

export function withTaskWorkingDirectoryMetadata(input: {
  workingDirectory?: unknown;
  metadata?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const metadata = { ...(input.metadata ?? {}) };
  const existingWorkspace = isRecord(metadata.agentWorkspace) ? metadata.agentWorkspace : {};
  const settings = normalizeTaskWorkingDirectory(input);
  return {
    ...metadata,
    agentWorkspace: {
      ...existingWorkspace,
      workingDirectory: settings.workingDirectory,
      status: settings.status,
      source: settings.source,
      requiresSelection: settings.requiresSelection,
      guidance: settings.guidance
    }
  };
}

export function getTaskWorkingDirectorySettings(definition: TaskDefinition): TaskWorkingDirectorySettings {
  return normalizeTaskWorkingDirectory({
    metadata: definition.metadata
  });
}
