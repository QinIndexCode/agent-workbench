import { randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformChannelRecord } from '../../foundation/repository';
import { ChannelUpsertInput, PlatformActionResult } from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new Error(`backend_new platform error: ${field} must not be empty.`);
  }
  return normalized;
}

export class ChannelService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<PlatformChannelRecord[]> {
    return this.foundation.channels.list();
  }

  async get(channelId: string): Promise<PlatformChannelRecord | null> {
    return this.foundation.channels.get(channelId);
  }

  async upsert(input: ChannelUpsertInput): Promise<PlatformActionResult<PlatformChannelRecord>> {
    const now = Date.now();
    const existing = input.channelId ? await this.foundation.channels.get(input.channelId) : null;
    const record: PlatformChannelRecord = {
      channelId: input.channelId?.trim() || `channel_${randomUUID().slice(0, 8)}`,
      name: requireNonEmpty(input.name, 'channel.name'),
      kind: requireNonEmpty(input.kind, 'channel.kind'),
      status: input.status,
      endpoint: input.endpoint?.trim() || null,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {})
      }
    };
    const command = await this.recorder.recordCommand({
      resourceType: 'CHANNEL',
      resourceId: record.channelId,
      action: 'UPSERT',
      input: {
        channelId: record.channelId,
        name: record.name,
        kind: record.kind,
        status: record.status,
        endpoint: record.endpoint
      }
    });
    try {
      await this.foundation.channels.save(record);
      return await this.recorder.recordApplied(command, record);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(channelId: string): Promise<PlatformActionResult<{ ok: true; channelId: string }>> {
    if (!await this.foundation.channels.get(channelId)) {
      throw new Error(`backend_new platform error: unknown channel "${channelId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'CHANNEL',
      resourceId: channelId,
      action: 'DELETE',
    });
    try {
      await this.foundation.channels.delete(channelId);
      return await this.recorder.recordApplied(command, {
        ok: true,
        channelId
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async test(channelId: string): Promise<{ ok: boolean; channelId: string; endpoint: string | null }> {
    const record = await this.get(channelId);
    if (!record) {
      throw new Error(`backend_new platform error: unknown channel "${channelId}".`);
    }
    return {
      ok: Boolean(record.endpoint || record.kind),
      channelId: record.channelId,
      endpoint: record.endpoint
    };
  }
}
