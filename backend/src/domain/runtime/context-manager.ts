import { BackendNewConfig } from '../../foundation/config/types';
import { ContextGatingSummaryState, LlmContextMessage, RuntimeContextSnapshotRef } from '../contracts/types';
import { estimateTokenCount } from './prompt-budgeter';

export function createLlmContextMessage(params: {
  role: LlmContextMessage['role'];
  content: string;
  compressed?: boolean;
  metadata?: Record<string, unknown>;
}): LlmContextMessage {
  return {
    role: params.role,
    content: params.content,
    compressed: params.compressed ?? false,
    metadata: params.metadata ?? {}
  };
}

export function createEmptyContextGatingSummary(): ContextGatingSummaryState {
  return {
    mode: 'STANDARD',
    rawContextMessageCount: 0,
    retainedContextMessageCount: 0,
    summarizedContextMessageCount: 0,
    filteredContextMessageCount: 0,
    stageScopedMessageCount: 0,
    contractScopedMessageCount: 0,
    dependencyScopedMessageCount: 0,
    operatorMessageCount: 0,
    toolMessageCount: 0,
    rawContextCharacters: 0,
    gatedContextCharacters: 0,
    estimatedContextReductionRatio: 0,
    reasons: ['initial_empty_state']
  };
}

export function appendAndCompressLlmContext(params: {
  config: BackendNewConfig;
  current: LlmContextMessage[];
  additions: LlmContextMessage[];
  conservative?: boolean;
}): {
  messages: LlmContextMessage[];
  compressed: boolean;
  truncatedCount: number;
} {
  const next = [...params.current, ...params.additions];
  if (next.length <= params.config.runtime.maxContextMessages) {
    return {
      messages: next,
      compressed: false,
      truncatedCount: 0
    };
  }

  const retain = params.conservative
    ? Math.min(next.length, Math.max(params.config.runtime.retainedContextMessages, Math.floor(params.config.runtime.maxContextMessages * 0.75)))
    : params.config.runtime.retainedContextMessages;
  const preservedTail = next.slice(-retain);
  const compressedHead = next.slice(0, Math.max(0, next.length - retain));
  const charLimit = params.conservative
    ? Math.max(480, Math.floor(params.config.runtime.promptSectionCharacterLimit * 0.9))
    : Math.max(240, Math.floor(params.config.runtime.promptSectionCharacterLimit * 0.6));
  const maxSummaryItems = params.conservative
    ? Math.max(6, params.config.runtime.promptMaxSummaryItems * 3)
    : Math.max(4, params.config.runtime.promptMaxSummaryItems * 2);
  const summaryLines = compressedHead
    .slice(-maxSummaryItems)
    .map((message, index) => {
      const unitId = typeof message.metadata?.unitId === 'string' ? ` unit=${message.metadata.unitId}` : '';
      const normalizedContent = message.content.replace(/\s+/g, ' ').trim();
      const summarizedContent = normalizedContent.length <= charLimit
        ? normalizedContent
        : `${normalizedContent.slice(0, Math.max(0, charLimit - 3))}...`;
      return `- ${index + 1}. ${message.role}${unitId}: ${summarizedContent}`;
    });
  const omittedCount = Math.max(0, compressedHead.length - summaryLines.length);
  if (omittedCount > 0) {
    summaryLines.unshift(`- ${omittedCount} earlier message(s) collapsed into this summary.`);
  }
  const rawCharacterCount = compressedHead.reduce((total, message) => total + message.content.length, 0);

  return {
    messages: [
      createLlmContextMessage({
        role: 'system',
        compressed: true,
        content: [
          'Compressed prior context for token efficiency.',
          `Source messages: ${compressedHead.length}`,
          `Approx raw tokens: ${Math.ceil(rawCharacterCount / 4)}`,
          `Approx compressed tokens: ${estimateTokenCount(summaryLines.join('\n'))}`,
          `Compression mode: ${params.conservative ? 'CONSERVATIVE' : 'STANDARD'}`,
          ...summaryLines
        ].join('\n'),
        metadata: {
          compressedMessageCount: compressedHead.length,
          rawCharacterCount
        }
      }),
      ...preservedTail
    ],
    compressed: true,
    truncatedCount: compressedHead.length
  };
}

export function createContextSnapshotRef(params: {
  kind: RuntimeContextSnapshotRef['kind'];
  sessionId: string | null;
  turnId: string | null;
  checkpointId: string | null;
  messageCount: number;
}): RuntimeContextSnapshotRef {
  return {
    kind: params.kind,
    sessionId: params.sessionId,
    turnId: params.turnId,
    checkpointId: params.checkpointId,
    messageCount: params.messageCount
  };
}
