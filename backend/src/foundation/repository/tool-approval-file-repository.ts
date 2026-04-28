import { BackendNewConfig } from '../config/types';
import { TaskSnapshotHub } from '../projection/event-hub';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { ToolApprovalRecord, ToolApprovalRepository } from './types';

export class FileToolApprovalRepository implements ToolApprovalRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly snapshotHub?: TaskSnapshotHub
  ) {}

  async append(record: ToolApprovalRecord): Promise<void> {
    const taskLayout = this.layout.forTask(record.taskId);
    await this.storage.appendJsonLine(taskLayout.approvalLogPath, record);
    this.snapshotHub?.publish(record.taskId);
  }

  async list(taskId: string): Promise<ToolApprovalRecord[]> {
    const taskLayout = this.layout.forTask(taskId);
    if (!await this.storage.exists(taskLayout.approvalLogPath)) {
      return [];
    }
    const content = await this.storage.readText(taskLayout.approvalLogPath, this.config.storage.encoding);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as ToolApprovalRecord);
  }

  async listLatest(taskId: string): Promise<ToolApprovalRecord[]> {
    const records = await this.list(taskId);
    const latest = new Map<string, ToolApprovalRecord>();
    for (const record of records) {
      latest.set(record.invocationId, record);
    }
    return Array.from(latest.values());
  }
}
