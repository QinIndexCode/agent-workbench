export type ConversationMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'runtime'
  | 'tool';

export type ConversationVisibility =
  | 'public'
  | 'internal';

export interface ConversationMessageRecord {
  messageId: string;
  taskId: string;
  sessionId: string | null;
  correlationId: string | null;
  role: ConversationMessageRole;
  visibility: ConversationVisibility;
  createdAt: number;
  content: string;
  metadata: Record<string, unknown>;
}
