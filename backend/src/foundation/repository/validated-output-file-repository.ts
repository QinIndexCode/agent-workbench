import { BackendNewConfig } from '../config/types';
import { TaskSnapshotHub } from '../projection/event-hub';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  ToolInvocationRecord,
  ToolInvocationRepository,
  ValidatedOutputRecord,
  ValidatedOutputRepository
} from './types';

export class FileValidatedOutputRepository implements ValidatedOutputRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async save(record: ValidatedOutputRecord): Promise<void> {
    await this.storage.writeJson(
      this.layout.validatedOutputPath(record.taskId, record.unitId),
      record,
      this.config.storage.jsonSpacing
    );
    this.snapshotHub?.publish(record.taskId);
  }

  async get(taskId: string, unitId: string): Promise<ValidatedOutputRecord | null> {
    const filePath = this.layout.validatedOutputPath(taskId, unitId);
    if (!await this.storage.exists(filePath)) {
      return null;
    }
    return this.storage.readJson<ValidatedOutputRecord>(filePath, this.config.storage.encoding);
  }

  async list(taskId: string): Promise<ValidatedOutputRecord[]> {
    const prefix = `${taskId}__`;
    const files = await this.storage.listFiles(this.layout.paths.outputsDir);
    const matched = files.filter(filePath => filePath.endsWith('.json') && filePath.includes(prefix));
    const records = await Promise.all(matched.map(async filePath => (
      this.storage.readJson<ValidatedOutputRecord>(filePath, this.config.storage.encoding)
    )));
    return records.sort((left, right) => left.validatedAt - right.validatedAt);
  }
}

export class FileToolInvocationRepository implements ToolInvocationRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async append(record: ToolInvocationRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.toolInvocationLogPath, record);
    this.snapshotHub?.publish(record.taskId);
  }

  async list(taskId: string): Promise<ToolInvocationRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.toolInvocationLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.toolInvocationLogPath, this.config.storage.encoding);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as ToolInvocationRecord);
  }

  async listLatest(taskId: string): Promise<ToolInvocationRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, ToolInvocationRecord>();
    for (const record of records) {
      latest.set(record.invocationId, record);
    }
    return Array.from(latest.values());
  }
}
