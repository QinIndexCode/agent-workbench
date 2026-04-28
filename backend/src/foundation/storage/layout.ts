import path from 'node:path';
import { BackendNewConfig } from '../config/types';

export interface TaskStorageLayout {
  taskRecordPath: string;
  taskRuntimePath: string;
  taskMetadataPath: string;
  projectionPath: string;
  eventLogPath: string;
  commandLogPath: string;
  operatorMessageLogPath: string;
  interruptLogPath: string;
  toolInvocationLogPath: string;
  approvalLogPath: string;
  conversationLogPath: string;
  traceLogPath: string;
  checkpointPath: string;
  workspaceDir: string;
}

export class StorageLayout {
  constructor(private readonly config: BackendNewConfig) {}

  get paths(): BackendNewConfig['paths'] {
    return this.config.paths;
  }

  get auditLogPath(): string {
    return path.join(this.config.paths.logsDir, this.config.logging.auditFileName);
  }

  get secretsIndexPath(): string {
    return path.join(this.config.paths.secretsDir, 'secrets.index.json');
  }

  get configSnapshotPath(): string {
    return path.join(this.config.paths.configSnapshotsDir, 'active-config.json');
  }

  get userProfilePath(): string {
    return path.join(this.config.paths.rootDir, 'user-preferences.json');
  }

  get platformDirPath(): string {
    return path.join(this.config.paths.rootDir, 'platform');
  }

  get improvementsDirPath(): string {
    return path.join(this.platformDirPath, 'improvements');
  }

  get improvementProposalsPath(): string {
    return path.join(this.improvementsDirPath, 'proposals.json');
  }

  get taskImprovementStatesPath(): string {
    return path.join(this.improvementsDirPath, 'task-states.json');
  }

  get realTaskArchivePath(): string {
    return path.join(this.improvementsDirPath, 'real-task-archive.json');
  }

  get approvedExperiencesPath(): string {
    return path.join(this.improvementsDirPath, 'approved-experiences.json');
  }

  get generatedSkillsDirPath(): string {
    return path.join(this.platformDirPath, 'generated-skills');
  }

  get generatedExperiencesDirPath(): string {
    return path.join(this.platformDirPath, 'generated-experiences');
  }

  get channelsPath(): string {
    return path.join(this.platformDirPath, 'channels.json');
  }

  get platformCommandLogPath(): string {
    return path.join(this.platformDirPath, 'commands.jsonl');
  }

  get platformAuditLogPath(): string {
    return path.join(this.platformDirPath, 'audits.jsonl');
  }

  get skillManifestPath(): string {
    return path.join(this.platformDirPath, 'skills.manifest.json');
  }

  get schedulesPath(): string {
    return path.join(this.platformDirPath, 'schedules.json');
  }

  get memoriesPath(): string {
    return path.join(this.platformDirPath, 'memories.json');
  }

  sessionRecordPath(sessionId: string): string {
    const safeSessionId = normalizeStorageId(sessionId, 'sessionId');
    return path.join(this.config.paths.sessionsDir, `${safeSessionId}.json`);
  }

  forTask(taskId: string): TaskStorageLayout {
    const safeTaskId = normalizeTaskId(taskId);
    return {
      taskRecordPath: path.join(this.config.paths.tasksDir, `${safeTaskId}.json`),
      taskRuntimePath: path.join(this.config.paths.tasksDir, `${safeTaskId}.runtime.json`),
      taskMetadataPath: path.join(this.config.paths.tasksDir, `${safeTaskId}.metadata.json`),
      projectionPath: path.join(this.config.paths.projectionsDir, `${safeTaskId}.projection.json`),
      eventLogPath: path.join(this.config.paths.eventsDir, `${safeTaskId}.events.jsonl`),
      commandLogPath: path.join(this.config.paths.eventsDir, `${safeTaskId}.commands.jsonl`),
      operatorMessageLogPath: path.join(this.config.paths.conversationsDir, `${safeTaskId}.operator-messages.jsonl`),
      interruptLogPath: path.join(this.config.paths.eventsDir, `${safeTaskId}.interrupts.jsonl`),
      toolInvocationLogPath: path.join(this.config.paths.toolInvocationsDir, `${safeTaskId}.jsonl`),
      approvalLogPath: path.join(this.config.paths.approvalsDir, `${safeTaskId}.jsonl`),
      conversationLogPath: path.join(this.config.paths.conversationsDir, `${safeTaskId}.jsonl`),
      traceLogPath: path.join(this.config.paths.tracesDir, `${safeTaskId}.jsonl`),
      checkpointPath: path.join(this.config.paths.checkpointsDir, `${safeTaskId}.json`),
      workspaceDir: path.join(this.config.paths.workspaceDir, safeTaskId)
    };
  }

  resolveWorkspacePath(taskId: string, relativePath: string): string {
    const taskLayout = this.forTask(taskId);
    const resolved = path.resolve(taskLayout.workspaceDir, relativePath);
    const workspaceRoot = `${path.resolve(taskLayout.workspaceDir)}${path.sep}`;
    if (resolved !== path.resolve(taskLayout.workspaceDir) && !resolved.startsWith(workspaceRoot)) {
      throw new Error(`backend_new storage error: workspace path escapes task workspace: ${relativePath}`);
    }
    return resolved;
  }

  secretRecordPath(secretId: string): string {
    const safeSecretId = normalizeStorageId(secretId, 'secretId');
    return path.join(this.config.paths.secretsDir, `${safeSecretId}.json`);
  }

  validatedOutputPath(taskId: string, unitId: string): string {
    const safeTaskId = normalizeTaskId(taskId);
    const safeUnitId = normalizeStorageId(unitId, 'unitId');
    return path.join(this.config.paths.outputsDir, `${safeTaskId}__${safeUnitId}.json`);
  }
}

function normalizeStorageId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`backend_new storage error: ${label} must not be empty.`);
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error(`backend_new storage error: ${label} contains unsafe characters: ${value}`);
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`backend_new storage error: ${label} is not allowed: ${value}`);
  }

  return trimmed;
}

function normalizeTaskId(taskId: string): string {
  return normalizeStorageId(taskId, 'taskId');
}
