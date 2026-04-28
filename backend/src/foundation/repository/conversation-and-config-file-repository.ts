import { ConversationMessageRecord } from '../conversation/types';
import { BackendNewConfig } from '../config/types';
import { TaskSnapshotHub } from '../projection/event-hub';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  ConfigSnapshotRecordStore,
  ConfigSnapshotRepository,
  ConversationRepository,
  InterruptRequestRecord,
  InterruptRequestRepository,
  OperatorCommandRecord,
  OperatorCommandRepository,
  OperatorMessageRecord,
  OperatorMessageRepository
} from './types';

export class FileConversationRepository implements ConversationRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async append(record: ConversationMessageRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.conversationLogPath, record);
    this.snapshotHub?.publish(record.taskId);
  }

  async list(taskId: string): Promise<ConversationMessageRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.conversationLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.conversationLogPath, this.config.storage.encoding);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as ConversationMessageRecord);
  }
}

export class FileConfigSnapshotRepository implements ConfigSnapshotRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: ConfigSnapshotRecordStore): Promise<void> {
    await this.storage.writeJson(
      this.layout.configSnapshotPath,
      record,
      this.config.storage.jsonSpacing
    );
  }

  async getActive(): Promise<ConfigSnapshotRecordStore | null> {
    if (!await this.storage.exists(this.layout.configSnapshotPath)) {
      return null;
    }
    return this.storage.readJson<ConfigSnapshotRecordStore>(
      this.layout.configSnapshotPath,
      this.config.storage.encoding
    );
  }
}

function parseJsonLines<T>(content: string): T[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

export class FileOperatorCommandRepository implements OperatorCommandRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async append(record: OperatorCommandRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.commandLogPath, record);
    this.snapshotHub?.publish(record.taskId);
  }

  async list(taskId: string): Promise<OperatorCommandRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.commandLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.commandLogPath, this.config.storage.encoding);
    return parseJsonLines<OperatorCommandRecord>(content);
  }

  async listLatest(taskId: string): Promise<OperatorCommandRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, OperatorCommandRecord>();
    for (const record of records) {
      latest.set(record.commandId, record);
    }
    return Array.from(latest.values());
  }
}

export class FileOperatorMessageRepository implements OperatorMessageRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async append(record: OperatorMessageRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.operatorMessageLogPath, record);
    this.snapshotHub?.publish(record.taskId);
  }

  async list(taskId: string): Promise<OperatorMessageRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.operatorMessageLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.operatorMessageLogPath, this.config.storage.encoding);
    return parseJsonLines<OperatorMessageRecord>(content);
  }

  async listLatest(taskId: string): Promise<OperatorMessageRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, OperatorMessageRecord>();
    for (const record of records) {
      latest.set(record.messageId, record);
    }
    return Array.from(latest.values());
  }
}

export class FileInterruptRequestRepository implements InterruptRequestRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async append(record: InterruptRequestRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.interruptLogPath, record);
  }

  async list(taskId: string): Promise<InterruptRequestRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.interruptLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.interruptLogPath, this.config.storage.encoding);
    return parseJsonLines<InterruptRequestRecord>(content);
  }

  async listLatest(taskId: string): Promise<InterruptRequestRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, InterruptRequestRecord>();
    for (const record of records) {
      latest.set(record.interruptId, record);
    }
    return Array.from(latest.values());
  }
}
