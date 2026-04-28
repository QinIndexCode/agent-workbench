import crypto from 'node:crypto';
import { ConversationMessageRecord } from './types';

export function createConversationMessage(params: {
  taskId: string;
  sessionId?: string | null;
  correlationId?: string | null;
  role: ConversationMessageRecord['role'];
  visibility?: ConversationMessageRecord['visibility'];
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}): ConversationMessageRecord {
  const createdAt = params.createdAt ?? Date.now();
  return {
    messageId: `msg_${createdAt}_${crypto.randomBytes(4).toString('hex')}`,
    taskId: params.taskId,
    sessionId: params.sessionId ?? null,
    correlationId: params.correlationId ?? null,
    role: params.role,
    visibility: params.visibility ?? 'public',
    createdAt,
    content: params.content,
    metadata: params.metadata ?? {}
  };
}
