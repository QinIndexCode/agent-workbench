import crypto from 'node:crypto';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import {
  InterruptRequestRecord,
  OperatorCommandRecord,
  OperatorMessageRecord
} from '../../../foundation/repository';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { SubmitTaskCommandInput } from '../types';

export class OperatorCommandService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  createAcceptedRecord(input: SubmitTaskCommandInput): OperatorCommandRecord {
    const now = Date.now();
    return {
      commandId: `cmd_${now}_${crypto.randomBytes(4).toString('hex')}`,
      taskId: input.taskId,
      type: input.type,
      status: 'ACCEPTED',
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      actor: input.actor ?? null,
      reason: input.reason ?? null,
      message: input.message ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        invocationId: input.invocationId ?? null,
        approvalStatus: input.approvalStatus ?? null
      }
    };
  }

  withStatus(
    record: OperatorCommandRecord,
    status: OperatorCommandRecord['status'],
    metadata?: Record<string, unknown>
  ): OperatorCommandRecord {
    const now = Date.now();
    return {
      ...record,
      status,
      updatedAt: now,
      appliedAt: status === 'APPLIED' ? now : record.appliedAt,
      metadata: {
        ...record.metadata,
        ...(metadata ?? {})
      }
    };
  }

  createOperatorMessage(params: {
    taskId: string;
    commandId: string | null;
    sessionId?: string | null;
    correlationId?: string | null;
    content: string;
    status?: OperatorMessageRecord['status'];
    consumedAt?: number | null;
    metadata?: Record<string, unknown>;
  }): OperatorMessageRecord {
    const now = Date.now();
    return {
      messageId: `opmsg_${now}_${crypto.randomBytes(4).toString('hex')}`,
      taskId: params.taskId,
      commandId: params.commandId,
      sessionId: params.sessionId ?? null,
      correlationId: params.correlationId ?? null,
      status: params.status ?? 'PENDING',
      content: params.content,
      createdAt: now,
      consumedAt: params.consumedAt ?? null,
      metadata: params.metadata ?? {}
    };
  }

  createConsumedOperatorMessage(
    record: OperatorMessageRecord,
    metadata?: Record<string, unknown>
  ): OperatorMessageRecord {
    return {
      ...record,
      status: 'CONSUMED',
      consumedAt: Date.now(),
      metadata: {
        ...record.metadata,
        ...(metadata ?? {})
      }
    };
  }

  createInterruptRequest(params: {
    taskId: string;
    commandId: string | null;
    reason?: string | null;
    requestedBy?: string | null;
    status?: InterruptRequestRecord['status'];
    metadata?: Record<string, unknown>;
  }): InterruptRequestRecord {
    const now = Date.now();
    return {
      interruptId: `intr_${now}_${crypto.randomBytes(4).toString('hex')}`,
      taskId: params.taskId,
      commandId: params.commandId,
      status: params.status ?? 'REQUESTED',
      requestedBy: params.requestedBy ?? null,
      createdAt: now,
      updatedAt: now,
      reason: params.reason ?? null,
      metadata: params.metadata ?? {}
    };
  }

  withInterruptStatus(
    record: InterruptRequestRecord,
    status: InterruptRequestRecord['status'],
    metadata?: Record<string, unknown>
  ): InterruptRequestRecord {
    return {
      ...record,
      status,
      updatedAt: Date.now(),
      metadata: {
        ...record.metadata,
        ...(metadata ?? {})
      }
    };
  }

  async appendAccepted(record: OperatorCommandRecord): Promise<void> {
    await this.foundation.commands.append(record);
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${record.commandId}`,
        sessionId: `sess_${record.commandId}`,
        turnId: `turn_${record.commandId}`,
        taskId: record.taskId,
        unitId: null,
        checkpointId: null,
        type: 'COMMAND_ACCEPTED',
        payload: {
          commandId: record.commandId,
          commandType: record.type,
          actor: record.actor,
          message: record.message
        }
      })
    );
  }

  async appendApplied(record: OperatorCommandRecord, metadata?: Record<string, unknown>): Promise<void> {
    const applied = this.withStatus(record, 'APPLIED', metadata);
    await this.foundation.commands.append(applied);
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${applied.commandId}`,
        sessionId: `sess_${applied.commandId}`,
        turnId: `turn_${applied.commandId}`,
        taskId: applied.taskId,
        unitId: null,
        checkpointId: null,
        type: 'COMMAND_APPLIED',
        payload: {
          commandId: applied.commandId,
          commandType: applied.type,
          status: applied.status
        }
      })
    );
  }

  async appendRejected(record: OperatorCommandRecord, error: string): Promise<void> {
    const rejected = this.withStatus(record, 'REJECTED', {
      error
    });
    await this.foundation.commands.append(rejected);
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: `corr_${rejected.commandId}`,
        sessionId: `sess_${rejected.commandId}`,
        turnId: `turn_${rejected.commandId}`,
        taskId: rejected.taskId,
        unitId: null,
        checkpointId: null,
        type: 'COMMAND_REJECTED',
        payload: {
          commandId: rejected.commandId,
          commandType: rejected.type,
          error
        }
      })
    );
  }
}
