import { BackendNewConfig } from '../config/types';
import { TaskSnapshotHub } from '../projection/event-hub';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  ExecutionSessionRecord,
  ExecutionSessionRepository,
  TaskMetadataRecord,
  TaskMetadataRepository
} from './types';

export class FileTaskMetadataRepository implements TaskMetadataRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async save(record: TaskMetadataRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.writeJson(taskLayout.taskMetadataPath, record, this.config.storage.jsonSpacing);
    this.snapshotHub?.publish(record.taskId);
  }

  async get(taskId: string): Promise<TaskMetadataRecord | null> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.taskMetadataPath)) {
      return null;
    }
    return this.storage.readJson<TaskMetadataRecord>(
      taskLayout.taskMetadataPath,
      this.config.storage.encoding
    );
  }
}

export class FileExecutionSessionRepository implements ExecutionSessionRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: ExecutionSessionRecord): Promise<void> {
    await this.storage.writeJson(
      this.layout.sessionRecordPath(record.sessionId),
      record,
      this.config.storage.jsonSpacing
    );
  }

  async get(sessionId: string): Promise<ExecutionSessionRecord | null> {
    const filePath = this.layout.sessionRecordPath(sessionId);
    if (!await this.storage.exists(filePath)) {
      return null;
    }
    return this.storage.readJson<ExecutionSessionRecord>(filePath, this.config.storage.encoding);
  }
}
