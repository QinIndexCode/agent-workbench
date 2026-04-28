import { BackendNewConfig } from '../config/types';
import { TaskSnapshotHub } from '../projection/event-hub';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  CheckpointRecord,
  CheckpointRepository,
  TaskRuntimeRecord,
  TaskRuntimeRepository,
  TaskRepository,
  TaskSnapshotRecord
} from './types';

export class FileTaskRepository implements TaskRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: TaskSnapshotRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.writeJson(taskLayout.taskRecordPath, record, this.config.storage.jsonSpacing);
  }

  async get(taskId: string): Promise<TaskSnapshotRecord | null> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.taskRecordPath)) {
      return null;
    }
    return this.storage.readJson<TaskSnapshotRecord>(
      taskLayout.taskRecordPath,
      this.config.storage.encoding
    );
  }

  async list(): Promise<TaskSnapshotRecord[]> {
    const files = await this.storage.listFiles(this.layout.paths.tasksDir);
    const taskFiles = files.filter(filePath => filePath.endsWith('.json') && !filePath.endsWith('.metadata.json') && !filePath.endsWith('.runtime.json'));
    const records = await Promise.all(taskFiles.map(async filePath => (
      this.storage.readJson<TaskSnapshotRecord>(filePath, this.config.storage.encoding)
    )));
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }
}

export class FileTaskRuntimeRepository implements TaskRuntimeRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async save(record: TaskRuntimeRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.writeJson(taskLayout.taskRuntimePath, record, this.config.storage.jsonSpacing);
    this.snapshotHub?.publish(record.taskId);
  }

  async get(taskId: string): Promise<TaskRuntimeRecord | null> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.taskRuntimePath)) {
      return null;
    }
    return this.storage.readJson<TaskRuntimeRecord>(
      taskLayout.taskRuntimePath,
      this.config.storage.encoding
    );
  }

  async list(): Promise<TaskRuntimeRecord[]> {
    const files = await this.storage.listFiles(this.layout.paths.tasksDir);
    const runtimeFiles = files.filter(filePath => filePath.endsWith('.runtime.json'));
    const records = await Promise.all(runtimeFiles.map(async filePath => (
      this.storage.readJson<TaskRuntimeRecord>(filePath, this.config.storage.encoding)
    )));
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }
}

export class FileCheckpointRepository implements CheckpointRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: CheckpointRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.writeJson(taskLayout.checkpointPath, record, this.config.storage.jsonSpacing);
  }

  async get(taskId: string): Promise<CheckpointRecord | null> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.checkpointPath)) {
      return null;
    }
    return this.storage.readJson<CheckpointRecord>(
      taskLayout.checkpointPath,
      this.config.storage.encoding
    );
  }
}
