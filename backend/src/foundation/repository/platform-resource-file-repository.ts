import { BackendNewConfig } from '../config/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  PlatformActionType,
  PlatformAuditRecord,
  PlatformAuditRepository,
  PlatformChannelRecord,
  PlatformChannelRepository,
  PlatformCommandRecord,
  PlatformCommandRepository,
  PlatformMemoryRecord,
  PlatformMemoryRepository,
  PlatformResourceType,
  PlatformScheduleRecord,
  PlatformScheduleRepository
} from './types';

async function readCollection<T>(
  storage: StorageAdapter,
  config: BackendNewConfig,
  filePath: string
): Promise<T[]> {
  if (!await storage.exists(filePath)) {
    return [];
  }
  return storage.readJson<T[]>(filePath, config.storage.encoding);
}

async function writeCollection<T>(
  storage: StorageAdapter,
  config: BackendNewConfig,
  layout: StorageLayout,
  filePath: string,
  records: T[]
): Promise<void> {
  await storage.ensureDir(layout.platformDirPath);
  await storage.writeJson(filePath, records, config.storage.jsonSpacing);
}

async function readLog<T>(
  storage: StorageAdapter,
  config: BackendNewConfig,
  filePath: string
): Promise<T[]> {
  if (!await storage.exists(filePath)) {
    return [];
  }
  const content = await storage.readText(filePath, config.storage.encoding);
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

async function appendLog<T>(
  storage: StorageAdapter,
  layout: StorageLayout,
  filePath: string,
  record: T
): Promise<void> {
  await storage.ensureDir(layout.platformDirPath);
  await storage.appendJsonLine(filePath, record);
}

export class FilePlatformChannelRepository implements PlatformChannelRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: PlatformChannelRecord): Promise<void> {
    const records = await readCollection<PlatformChannelRecord>(this.storage, this.config, this.layout.channelsPath);
    const next = records.filter(item => item.channelId !== record.channelId);
    next.push(record);
    next.sort((left, right) => left.name.localeCompare(right.name));
    await writeCollection(this.storage, this.config, this.layout, this.layout.channelsPath, next);
  }

  async get(channelId: string): Promise<PlatformChannelRecord | null> {
    const records = await this.list();
    return records.find(record => record.channelId === channelId) ?? null;
  }

  async list(): Promise<PlatformChannelRecord[]> {
    return readCollection<PlatformChannelRecord>(this.storage, this.config, this.layout.channelsPath);
  }

  async delete(channelId: string): Promise<boolean> {
    const records = await this.list();
    const next = records.filter(item => item.channelId !== channelId);
    if (next.length === records.length) {
      return false;
    }
    await writeCollection(this.storage, this.config, this.layout, this.layout.channelsPath, next);
    return true;
  }
}

export class FilePlatformScheduleRepository implements PlatformScheduleRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: PlatformScheduleRecord): Promise<void> {
    const records = await readCollection<PlatformScheduleRecord>(this.storage, this.config, this.layout.schedulesPath);
    const next = records.filter(item => item.scheduleId !== record.scheduleId);
    next.push(record);
    next.sort((left, right) => left.name.localeCompare(right.name));
    await writeCollection(this.storage, this.config, this.layout, this.layout.schedulesPath, next);
  }

  async get(scheduleId: string): Promise<PlatformScheduleRecord | null> {
    const records = await this.list();
    return records.find(record => record.scheduleId === scheduleId) ?? null;
  }

  async list(): Promise<PlatformScheduleRecord[]> {
    return readCollection<PlatformScheduleRecord>(this.storage, this.config, this.layout.schedulesPath);
  }

  async delete(scheduleId: string): Promise<boolean> {
    const records = await this.list();
    const next = records.filter(item => item.scheduleId !== scheduleId);
    if (next.length === records.length) {
      return false;
    }
    await writeCollection(this.storage, this.config, this.layout, this.layout.schedulesPath, next);
    return true;
  }
}

export class FilePlatformMemoryRepository implements PlatformMemoryRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async save(record: PlatformMemoryRecord): Promise<void> {
    const records = await readCollection<PlatformMemoryRecord>(this.storage, this.config, this.layout.memoriesPath);
    const next = records.filter(item => item.memoryId !== record.memoryId);
    next.push(record);
    next.sort((left, right) => right.updatedAt - left.updatedAt);
    await writeCollection(this.storage, this.config, this.layout, this.layout.memoriesPath, next);
  }

  async get(memoryId: string): Promise<PlatformMemoryRecord | null> {
    const records = await this.list();
    return records.find(record => record.memoryId === memoryId) ?? null;
  }

  async list(): Promise<PlatformMemoryRecord[]> {
    return readCollection<PlatformMemoryRecord>(this.storage, this.config, this.layout.memoriesPath);
  }

  async delete(memoryId: string): Promise<boolean> {
    const records = await this.list();
    const next = records.filter(item => item.memoryId !== memoryId);
    if (next.length === records.length) {
      return false;
    }
    await writeCollection(this.storage, this.config, this.layout, this.layout.memoriesPath, next);
    return true;
  }

  async search(query: string): Promise<PlatformMemoryRecord[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.list();
    }
    const records = await this.list();
    return records.filter(record =>
      record.title.toLowerCase().includes(normalized)
      || record.content.toLowerCase().includes(normalized)
      || record.tags.some(tag => tag.toLowerCase().includes(normalized))
    );
  }
}

export class FilePlatformCommandRepository implements PlatformCommandRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async append(record: PlatformCommandRecord): Promise<void> {
    await appendLog(this.storage, this.layout, this.layout.platformCommandLogPath, record);
  }

  async list(): Promise<PlatformCommandRecord[]> {
    return readLog<PlatformCommandRecord>(this.storage, this.config, this.layout.platformCommandLogPath);
  }

  async listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformCommandRecord[]> {
    const records = await this.list();
    return records.filter(record => record.resourceType === resourceType && record.resourceId === resourceId);
  }
}

export class FilePlatformAuditRepository implements PlatformAuditRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout
  ) {}

  async append(record: PlatformAuditRecord): Promise<void> {
    await appendLog(this.storage, this.layout, this.layout.platformAuditLogPath, record);
  }

  async list(): Promise<PlatformAuditRecord[]> {
    return readLog<PlatformAuditRecord>(this.storage, this.config, this.layout.platformAuditLogPath);
  }

  async listByResource(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformAuditRecord[]> {
    const records = await this.list();
    return records.filter(record => record.resourceType === resourceType && record.resourceId === resourceId);
  }
}
