import path from 'node:path';
import type { TaskDefinition } from '../../domain/contracts/types';
import type { ToolInvocationRecord, OperatorCommandRecord } from '../../foundation/repository/types';

export const TASK_ARTIFACT_PATH_POLICIES = ['task_workspace', 'project_relative', 'ask_if_unclear'] as const;
export type TaskArtifactPathPolicy = typeof TASK_ARTIFACT_PATH_POLICIES[number];

export const TASK_ARTIFACT_PATH_STATES = ['unresolved', 'sandbox_only', 'ready_to_apply', 'applied'] as const;
export type TaskArtifactPathState = typeof TASK_ARTIFACT_PATH_STATES[number];

export interface TaskArtifactRoutingSettings {
  pathPolicy: TaskArtifactPathPolicy;
  preferredArtifactDir: string | null;
  artifactApplyMode: 'sandbox_then_apply';
}

export interface TaskArtifactApplyResult {
  status: 'APPLIED' | 'CONFLICT' | 'FAILED';
  message: string;
  destinationDir: string | null;
  appliedCount: number;
  conflictCount: number;
  failedCount: number;
}

export interface TaskArtifactRoutingSummary {
  artifactPathState: TaskArtifactPathState;
  pendingArtifactCount: number;
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  lastArtifactApplyAt: number | null;
  lastArtifactApplyResult: TaskArtifactApplyResult | null;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  needsExplicitDestination: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
}

function normalizeAbsolutePath(value: unknown): string | null {
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
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  return null;
}

function normalizeArtifactEvidencePath(value: unknown): string | null {
  return normalizeAbsolutePath(value) ?? normalizeRelativePath(value);
}

function isAbsoluteArtifactPath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('/');
}

function normalizePathPolicy(value: unknown): TaskArtifactPathPolicy {
  return TASK_ARTIFACT_PATH_POLICIES.includes(value as TaskArtifactPathPolicy)
    ? value as TaskArtifactPathPolicy
    : 'ask_if_unclear';
}

export function normalizeArtifactDir(value: unknown): string | null {
  return normalizeRelativePath(value);
}

export function normalizeTaskArtifactRouting(input: {
  pathPolicy?: unknown;
  preferredArtifactDir?: unknown;
  metadata?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const metadata = { ...(input.metadata ?? {}) };
  const existingRouting = isRecord(metadata.artifactRouting) ? metadata.artifactRouting : {};
  const pathPolicy = normalizePathPolicy(input.pathPolicy ?? existingRouting.pathPolicy);
  const preferredArtifactDir = normalizeArtifactDir(input.preferredArtifactDir ?? existingRouting.preferredArtifactDir);
  return {
    ...metadata,
    artifactRouting: {
      ...existingRouting,
      pathPolicy,
      preferredArtifactDir,
      artifactApplyMode: 'sandbox_then_apply'
    }
  };
}

export function getTaskArtifactRoutingSettings(definition: TaskDefinition): TaskArtifactRoutingSettings {
  const metadata = isRecord(definition.metadata) ? definition.metadata : {};
  const artifactRouting = isRecord(metadata.artifactRouting) ? metadata.artifactRouting : {};
  return {
    pathPolicy: normalizePathPolicy(artifactRouting.pathPolicy),
    preferredArtifactDir: normalizeArtifactDir(artifactRouting.preferredArtifactDir),
    artifactApplyMode: 'sandbox_then_apply'
  };
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isWriteEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'run_command';
}

export function isArtifactWriteEvidenceTool(toolId: string): boolean {
  return isWriteEvidenceTool(toolId);
}

export function collectInvocationEvidencePaths(invocation: Pick<ToolInvocationRecord, 'arguments' | 'result'>): string[] {
  const outputRecord = isRecord(invocation.result?.output) ? invocation.result.output : null;
  const candidates = [
    invocation.result?.path,
    invocation.result?.file,
    invocation.result?.output_path,
    outputRecord?.path,
    outputRecord?.file,
    invocation.arguments.path,
    invocation.arguments.file,
    invocation.arguments.file_path,
    invocation.arguments.output
  ];
  return candidates
    .map((candidate) => normalizeArtifactEvidencePath(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

export function collectTaskArtifactPaths(invocations: ToolInvocationRecord[]): string[] {
  const paths = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.status !== 'SUCCEEDED' || !isWriteEvidenceTool(invocation.toolId)) {
      continue;
    }
    for (const artifactPath of collectInvocationEvidencePaths(invocation)) {
      paths.add(artifactPath);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function recommendArtifactDirectory(params: {
  definition: TaskDefinition;
  artifactPaths: string[];
}): { directory: string | null; reason: string | null } {
  void params;
  return {
    directory: null,
    reason: null
  };
}

function parseArtifactApplyResult(command: OperatorCommandRecord): TaskArtifactApplyResult | null {
  const metadata = isRecord(command.metadata) ? command.metadata : {};
  const status = typeof metadata.artifactApplyStatus === 'string' ? metadata.artifactApplyStatus : null;
  if (status !== 'APPLIED' && status !== 'CONFLICT' && status !== 'FAILED') {
    return null;
  }
  return {
    status,
    message: typeof metadata.artifactApplyMessage === 'string' ? metadata.artifactApplyMessage : 'artifact apply status recorded',
    destinationDir: normalizeArtifactDir(metadata.destinationDir),
    appliedCount: typeof metadata.appliedCount === 'number' ? metadata.appliedCount : 0,
    conflictCount: typeof metadata.conflictCount === 'number' ? metadata.conflictCount : 0,
    failedCount: typeof metadata.failedCount === 'number' ? metadata.failedCount : 0
  };
}

function buildArtifactDestinationPaths(params: {
  artifactPaths: string[];
  lastArtifactApplyResult: TaskArtifactApplyResult | null;
}): string[] {
  if (params.lastArtifactApplyResult?.status !== 'APPLIED' || !params.lastArtifactApplyResult.destinationDir) {
    return [];
  }
  const destinationDir = normalizeArtifactDir(params.lastArtifactApplyResult.destinationDir);
  if (!destinationDir) {
    return [];
  }
  const resolvedPaths = params.artifactPaths
    .map((artifactPath) => {
      try {
        return resolveProjectRelativeDestination({
          workspaceRelativePath: artifactPath,
          destinationDir
        });
      } catch {
        return null;
      }
    })
    .filter((artifactPath): artifactPath is string => Boolean(artifactPath));
  return [...new Set(resolvedPaths)];
}

export function deriveTaskArtifactRoutingSummary(params: {
  definition: TaskDefinition;
  invocations: ToolInvocationRecord[];
  commands: OperatorCommandRecord[];
}): TaskArtifactRoutingSummary {
  const settings = getTaskArtifactRoutingSettings(params.definition);
  const artifactPaths = collectTaskArtifactPaths(params.invocations);
  const externalArtifactPaths = artifactPaths.filter((entry) => isAbsoluteArtifactPath(entry));
  const recommendation = externalArtifactPaths.length > 0
    ? { directory: null, reason: 'artifact paths were delivered directly to an explicit absolute local destination' }
    : recommendArtifactDirectory({
      definition: params.definition,
      artifactPaths
    });
  const latestApplyCommand = [...params.commands]
    .reverse()
    .find((command) => command.type === 'APPLY_ARTIFACTS');
  const lastArtifactApplyResult = latestApplyCommand ? parseArtifactApplyResult(latestApplyCommand) : null;
  const artifactDestinationPaths = externalArtifactPaths.length > 0
    ? [...externalArtifactPaths]
    : buildArtifactDestinationPaths({
      artifactPaths,
      lastArtifactApplyResult
    });
  const selectedArtifactDir = externalArtifactPaths.length > 0
    ? null
    : normalizeArtifactDir(
      lastArtifactApplyResult?.destinationDir
      ?? settings.preferredArtifactDir
      ?? null
    );
  const recommendedArtifactDir = recommendation.directory;
  const hasArtifacts = artifactPaths.length > 0;
  const needsExplicitDestination = hasArtifacts
    && externalArtifactPaths.length === 0
    && settings.pathPolicy === 'ask_if_unclear'
    && !selectedArtifactDir;

  let artifactPathState: TaskArtifactPathState = 'sandbox_only';
  if (externalArtifactPaths.length > 0) {
    artifactPathState = 'applied';
  } else if (lastArtifactApplyResult?.status === 'APPLIED') {
    artifactPathState = 'applied';
  } else if (settings.pathPolicy === 'task_workspace') {
    artifactPathState = 'sandbox_only';
  } else if (needsExplicitDestination) {
    artifactPathState = 'unresolved';
  } else if (selectedArtifactDir || (settings.pathPolicy === 'project_relative' && recommendedArtifactDir)) {
    artifactPathState = hasArtifacts ? 'ready_to_apply' : 'sandbox_only';
  }

  return {
    artifactPathState,
    pendingArtifactCount: artifactPathState === 'applied' ? 0 : artifactPaths.length,
    selectedArtifactDir,
    recommendedArtifactDir,
    lastArtifactApplyAt: latestApplyCommand?.appliedAt ?? latestApplyCommand?.updatedAt ?? null,
    lastArtifactApplyResult,
    artifactPaths,
    artifactDestinationPaths,
    needsExplicitDestination
  };
}

export function resolveProjectRelativeDestination(params: {
  workspaceRelativePath: string;
  destinationDir: string;
}): string {
  const sourceRelativePath = normalizeRelativePath(params.workspaceRelativePath);
  const destinationDir = normalizeArtifactDir(params.destinationDir);
  if (!sourceRelativePath || !destinationDir) {
    throw new Error('backend_new artifact routing error: source artifact path and destination directory must both be project-relative.');
  }
  if (sourceRelativePath === destinationDir || sourceRelativePath.startsWith(`${destinationDir}/`)) {
    return sourceRelativePath;
  }
  return normalizeRelativePath(path.posix.join(destinationDir, sourceRelativePath)) ?? sourceRelativePath;
}
