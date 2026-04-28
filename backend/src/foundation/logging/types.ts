export type AuditSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface AuditLogEntry {
  timestamp: number;
  severity: AuditSeverity;
  event: string;
  taskId: string | null;
  unitId?: string | null;
  correlationId?: string | null;
  turnId?: string | null;
  checkpointId?: string | null;
  details: Record<string, unknown>;
}

export interface RuntimeTraceEntry {
  timestamp: number;
  taskId: string;
  unitId: string | null;
  correlationId: string;
  turnId: string;
  action: string;
  details: Record<string, unknown>;
}

export interface CheckpointEnvelope {
  timestamp: number;
  checkpointId: string;
  correlationId: string;
  turnId: string;
  taskId: string;
  unitId: string | null;
  state: Record<string, unknown>;
}

export interface LoggedEnvelope<T> {
  writerSessionId: string;
  sequence: number;
  payload: T;
}
