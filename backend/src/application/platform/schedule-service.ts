import { randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformScheduleRecord } from '../../foundation/repository';
import { PlatformActionResult, ScheduleUpsertInput } from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new Error(`backend_new platform error: ${field} must not be empty.`);
  }
  return normalized;
}

export class ScheduleService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<PlatformScheduleRecord[]> {
    return this.foundation.schedules.list();
  }

  async get(scheduleId: string): Promise<PlatformScheduleRecord | null> {
    return this.foundation.schedules.get(scheduleId);
  }

  async upsert(input: ScheduleUpsertInput): Promise<PlatformActionResult<PlatformScheduleRecord>> {
    return this.saveRecord(input, 'UPSERT');
  }

  private async saveRecord(
    input: ScheduleUpsertInput,
    action: PlatformActionResult<PlatformScheduleRecord>['action']
  ): Promise<PlatformActionResult<PlatformScheduleRecord>> {
    const now = Date.now();
    const existing = input.scheduleId ? await this.get(input.scheduleId) : null;
    const record: PlatformScheduleRecord = {
      scheduleId: input.scheduleId?.trim() || `schedule_${randomUUID().slice(0, 8)}`,
      name: requireNonEmpty(input.name, 'schedule.name'),
      status: input.status,
      cadence: requireNonEmpty(input.cadence, 'schedule.cadence'),
      taskTemplate: { ...(existing?.taskTemplate ?? {}), ...(input.taskTemplate ?? {}) },
      lastRunAt: input.lastRunAt ?? existing?.lastRunAt ?? null,
      nextRunAt: input.nextRunAt ?? existing?.nextRunAt ?? null,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {})
      }
    };
    const command = await this.recorder.recordCommand({
      resourceType: 'SCHEDULE',
      resourceId: record.scheduleId,
      action,
      input: {
        scheduleId: record.scheduleId,
        name: record.name,
        status: record.status,
        cadence: record.cadence
      }
    });
    try {
      await this.foundation.schedules.save(record);
      return await this.recorder.recordApplied(command, record);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(scheduleId: string): Promise<PlatformActionResult<{ ok: true; scheduleId: string }>> {
    if (!await this.foundation.schedules.get(scheduleId)) {
      throw new Error(`backend_new platform error: unknown schedule "${scheduleId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'SCHEDULE',
      resourceId: scheduleId,
      action: 'DELETE',
    });
    try {
      await this.foundation.schedules.delete(scheduleId);
      return await this.recorder.recordApplied(command, {
        ok: true,
        scheduleId
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async pause(scheduleId: string): Promise<PlatformActionResult<PlatformScheduleRecord>> {
    const existing = await this.get(scheduleId);
    if (!existing) {
      throw new Error(`backend_new platform error: unknown schedule "${scheduleId}".`);
    }
    return this.saveRecord({ ...existing, status: 'PAUSED' }, 'PAUSE');
  }

  async resume(scheduleId: string): Promise<PlatformActionResult<PlatformScheduleRecord>> {
    const existing = await this.get(scheduleId);
    if (!existing) {
      throw new Error(`backend_new platform error: unknown schedule "${scheduleId}".`);
    }
    return this.saveRecord({ ...existing, status: 'ACTIVE' }, 'RESUME');
  }
}
