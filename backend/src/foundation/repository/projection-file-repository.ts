import { BackendNewConfig } from '../config/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { RuntimeEventHub, TaskSnapshotHub } from '../projection/event-hub';
import {
  RuntimeEventRecord,
  RuntimeEventRepository,
  TaskProjectionRecordStore,
  TaskProjectionRepository
} from './types';

export class FileTaskProjectionRepository implements TaskProjectionRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async save(record: TaskProjectionRecordStore): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.writeJson(taskLayout.projectionPath, record, this.config.storage.jsonSpacing);
    this.snapshotHub?.publish(record.taskId);
  }

  async get(taskId: string): Promise<TaskProjectionRecordStore | null> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.projectionPath)) {
      return null;
    }
    return this.storage.readJson<TaskProjectionRecordStore>(
      taskLayout.projectionPath,
      this.config.storage.encoding
    );
  }
}

export class FileRuntimeEventRepository implements RuntimeEventRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly hub?: RuntimeEventHub
  ) {}

  async append(record: RuntimeEventRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.eventLogPath, record);
    this.hub?.publish(record);
  }

  async list(taskId: string): Promise<RuntimeEventRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.eventLogPath)) {
      return [];
    }

    const content = await this.storage.readText(taskLayout.eventLogPath, this.config.storage.encoding);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as RuntimeEventRecord);
  }

  async listAfter(taskId: string, afterEventId: string): Promise<RuntimeEventRecord[]> {
    const events = await this.list(taskId);
    const index = events.findIndex(event => event.eventId === afterEventId);
    if (index < 0) {
      return events;
    }
    return events.slice(index + 1);
  }
}
