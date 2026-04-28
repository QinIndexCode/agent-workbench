import { BackendNewConfig } from '../config/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { sanitizeLogDetails } from './sanitizer';
import { AuditLogEntry, CheckpointEnvelope, LoggedEnvelope, RuntimeTraceEntry } from './types';

export class TaskLogWriter {
  private readonly writerSessionId = `bnw-${process.pid}-${Date.now()}`;
  private sequence = 0;
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = Promise.all([
        this.storage.ensureDir(this.layout.paths.rootDir),
        this.storage.ensureDir(this.layout.paths.tasksDir),
        this.storage.ensureDir(this.layout.paths.tracesDir),
        this.storage.ensureDir(this.layout.paths.workspaceDir),
        this.storage.ensureDir(this.layout.paths.checkpointsDir),
        this.storage.ensureDir(this.layout.paths.logsDir),
        this.storage.ensureDir(this.layout.paths.secretsDir),
        this.storage.ensureDir(this.layout.paths.sessionsDir),
        this.storage.ensureDir(this.layout.paths.projectionsDir),
        this.storage.ensureDir(this.layout.paths.eventsDir),
        this.storage.ensureDir(this.layout.paths.outputsDir),
        this.storage.ensureDir(this.layout.paths.toolInvocationsDir),
        this.storage.ensureDir(this.layout.paths.approvalsDir),
        this.storage.ensureDir(this.layout.paths.conversationsDir),
        this.storage.ensureDir(this.layout.paths.configSnapshotsDir)
      ]).then(async () => {
        if (this.config.logging.cleanupOnInitialize) {
          await this.pruneExpiredLogs();
        }
      });
    }

    await this.initializePromise;
  }

  async recordAudit(entry: AuditLogEntry): Promise<void> {
    await this.initialize();
    await this.storage.appendJsonLine(
      this.layout.auditLogPath,
      this.wrap({
        ...entry,
        details: sanitizeLogDetails(entry.details, this.config.logging)
      })
    );
  }

  async recordTrace(entry: RuntimeTraceEntry): Promise<void> {
    await this.initialize();
    if (!entry.taskId.trim()) {
      throw new Error('backend_new logging error: trace entry requires a non-empty taskId.');
    }
    const taskLayout = this.layout.forTask(entry.taskId);
    await this.storage.appendJsonLine(
      taskLayout.traceLogPath,
      this.wrap({
        ...entry,
        details: sanitizeLogDetails(entry.details, this.config.logging)
      })
    );
  }

  async writeCheckpoint(entry: CheckpointEnvelope): Promise<void> {
    await this.initialize();
    if (!entry.taskId.trim()) {
      throw new Error('backend_new logging error: checkpoint requires a non-empty taskId.');
    }
    const taskLayout = this.layout.forTask(entry.taskId);
    await this.storage.writeJson(
      taskLayout.checkpointPath,
      this.wrap({
        ...entry,
        state: sanitizeLogDetails(entry.state, this.config.logging)
      }),
      this.config.storage.jsonSpacing
    );
  }

  async pruneExpiredLogs(options: {
    now?: number;
  } = {}): Promise<string[]> {
    const now = options.now ?? Date.now();
    const cutoff = now - this.config.logging.retentionDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    const targets = [
      this.layout.paths.logsDir,
      this.layout.paths.tracesDir,
      this.layout.paths.eventsDir,
      this.layout.paths.toolInvocationsDir,
      this.layout.paths.approvalsDir,
      this.layout.paths.conversationsDir
    ];

    for (const dirPath of targets) {
      const files = await this.storage.listFiles(dirPath);
      for (const filePath of files) {
        const stat = await this.storage.stat(filePath);
        if (!stat.isFile) {
          continue;
        }
        if (stat.modifiedAt <= cutoff) {
          await this.storage.deleteFile(filePath);
          deleted.push(filePath);
        }
      }
    }

    return deleted;
  }

  private wrap<T>(payload: T): LoggedEnvelope<T> {
    this.sequence += 1;
    return {
      writerSessionId: this.writerSessionId,
      sequence: this.sequence,
      payload
    };
  }
}
