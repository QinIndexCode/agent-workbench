import { randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformMemoryRecord } from '../../foundation/repository';
import { MemoryUpsertInput, PlatformActionResult } from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new Error(`backend_new platform error: ${field} must not be empty.`);
  }
  return normalized;
}

export class MemoryService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<PlatformMemoryRecord[]> {
    return this.foundation.memories.list();
  }

  async get(memoryId: string): Promise<PlatformMemoryRecord | null> {
    return this.foundation.memories.get(memoryId);
  }

  async search(query: string): Promise<PlatformMemoryRecord[]> {
    return this.foundation.memories.search(query);
  }

  async upsert(input: MemoryUpsertInput): Promise<PlatformActionResult<PlatformMemoryRecord>> {
    const now = Date.now();
    const existing = input.memoryId ? await this.get(input.memoryId) : null;
    const record: PlatformMemoryRecord = {
      memoryId: input.memoryId?.trim() || `memory_${randomUUID().slice(0, 8)}`,
      title: requireNonEmpty(input.title, 'memory.title'),
      content: requireNonEmpty(input.content, 'memory.content'),
      scope: input.scope,
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {})
      }
    };
    const command = await this.recorder.recordCommand({
      resourceType: 'MEMORY',
      resourceId: record.memoryId,
      action: 'UPSERT',
      input: {
        memoryId: record.memoryId,
        title: record.title,
        scope: record.scope,
        tags: record.tags
      }
    });
    try {
      await this.foundation.memories.save(record);
      return await this.recorder.recordApplied(command, record);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(memoryId: string): Promise<PlatformActionResult<{ ok: true; memoryId: string }>> {
    if (!await this.foundation.memories.get(memoryId)) {
      throw new Error(`backend_new platform error: unknown memory "${memoryId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'MEMORY',
      resourceId: memoryId,
      action: 'DELETE',
    });
    try {
      await this.foundation.memories.delete(memoryId);
      return await this.recorder.recordApplied(command, {
        ok: true,
        memoryId
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }
}
