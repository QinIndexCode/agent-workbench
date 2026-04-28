import { randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import {
  PlatformActionType,
  PlatformAuditRecord,
  PlatformCommandRecord,
  PlatformResourceType
} from '../../foundation/repository';
import { PlatformActionResult } from './types';

export class PlatformMutationRecorder {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async recordCommand(params: {
    resourceType: PlatformResourceType;
    resourceId: string;
    action: PlatformActionType;
    actor?: string | null;
    reason?: string | null;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<PlatformCommandRecord> {
    const createdAt = Date.now();
    const commandId = `pcmd_${randomUUID().slice(0, 8)}`;
    const command: PlatformCommandRecord = {
      commandId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      action: params.action,
      createdAt,
      actor: params.actor ?? null,
      reason: params.reason ?? null,
      input: params.input ?? {},
      metadata: params.metadata ?? {}
    };
    await this.foundation.platformCommands.append(command);
    return command;
  }

  async recordApplied<T>(
    command: PlatformCommandRecord,
    resource: T,
    metadata?: Record<string, unknown>
  ): Promise<PlatformActionResult<T>> {
    const auditId = `paud_${randomUUID().slice(0, 8)}`;
    const audit: PlatformAuditRecord = {
      auditId,
      commandId: command.commandId,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      action: command.action,
      status: 'APPLIED',
      createdAt: Date.now(),
      error: null,
      result: toAuditResult(resource),
      metadata: metadata ?? command.metadata ?? {}
    };
    await this.foundation.platformAudits.append(audit);
    return {
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      action: command.action,
      commandId: command.commandId,
      auditId,
      appliedAt: audit.createdAt,
      resource
    };
  }

  async recordRejected(
    command: PlatformCommandRecord,
    error: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const audit: PlatformAuditRecord = {
      auditId: `paud_${randomUUID().slice(0, 8)}`,
      commandId: command.commandId,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      action: command.action,
      status: 'REJECTED',
      createdAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      result: {},
      metadata: metadata ?? command.metadata ?? {}
    };
    await this.foundation.platformAudits.append(audit);
  }

  async applied<T>(params: {
    resourceType: PlatformResourceType;
    resourceId: string;
    action: PlatformActionType;
    resource: T;
    actor?: string | null;
    reason?: string | null;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<PlatformActionResult<T>> {
    const command = await this.recordCommand(params);
    return this.recordApplied(command, params.resource, params.metadata);
  }
}

function toAuditResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
