import { BackendNewConfig } from '../../../foundation/config/types';
import {
  ContextGatingSummaryState,
  ExecutionProfileId,
  LlmContextMessage
} from '../../../domain/contracts/types';
import {
  appendAndCompressLlmContext,
  createEmptyContextGatingSummary,
  createLlmContextMessage
} from '../../../domain/runtime/context-manager';
import { getExecutionProfile } from '../../runtime/execution-profiles';

interface ContextMessageClassification {
  unitIds: string[];
  stageScoped: boolean;
  contractScoped: boolean;
  dependencyScoped: boolean;
  operatorScoped: boolean;
  toolScoped: boolean;
}

interface ResolvedHistoryPolicy {
  mode: ContextGatingSummaryState['mode'];
  recentConversationCount: number;
  recentOperatorCount: number;
  recentToolCount: number;
  recentAssistantCount: number;
  retainDependencyMessages: boolean;
  reasons: string[];
}

interface IndexedClassifiedMessage {
  index: number;
  message: LlmContextMessage;
  scope: ContextMessageClassification;
}

export interface RequestContextGatingResult {
  contextMessages: ReturnType<typeof appendAndCompressLlmContext>;
  summary: ContextGatingSummaryState;
}

function estimateRequestMessageCharacters(messages: Array<{ content: string }>): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function isToolPayloadAssistantMessage(message: LlmContextMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) {
    return false;
  }
  return /\{"tool"\s*:\s*"[^"]+"/i.test(content)
    || /<tool_invocation>/i.test(content)
    || /\[AGENT-[^\]]+_OUTPUT\][\s\S]*\{"tool"\s*:\s*"[^"]+"/i.test(content);
}

function collectMessageUnitIds(message: LlmContextMessage): string[] {
  const collected = new Set<string>();
  if (typeof message.metadata?.unitId === 'string' && message.metadata.unitId.trim()) {
    collected.add(message.metadata.unitId.trim());
  }
  if (Array.isArray(message.metadata?.unitIds)) {
    for (const value of message.metadata.unitIds) {
      if (typeof value === 'string' && value.trim()) {
        collected.add(value.trim());
      }
    }
  }
  return [...collected];
}

function unitIdsOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const rightSet = new Set(right);
  return left.some((unitId) => rightSet.has(unitId));
}

function hasNewerRelevantOperatorMessage(params: {
  index: number;
  scope: ContextMessageClassification;
  operatorEntries: IndexedClassifiedMessage[];
}): boolean {
  return params.operatorEntries.some(({ index, scope }) => {
    if (index <= params.index) {
      return false;
    }
    if (params.scope.unitIds.length === 0 || scope.unitIds.length === 0) {
      return true;
    }
    return unitIdsOverlap(params.scope.unitIds, scope.unitIds);
  });
}

function classifyMessage(params: {
  message: LlmContextMessage;
  stageUnitIds: Set<string>;
  contractUnitIds: Set<string>;
  dependencyUnitIds: Set<string>;
}): ContextMessageClassification {
  const unitIds = collectMessageUnitIds(params.message);
  return {
    unitIds,
    stageScoped: unitIds.some((unitId) => params.stageUnitIds.has(unitId)),
    contractScoped: unitIds.some((unitId) => params.contractUnitIds.has(unitId)),
    dependencyScoped: unitIds.some((unitId) => params.dependencyUnitIds.has(unitId)),
    operatorScoped: params.message.role === 'user' || params.message.metadata?.source === 'operator_message',
    toolScoped: params.message.role === 'tool'
      || params.message.metadata?.source === 'tool_result'
      || params.message.metadata?.source === 'tool_call'
  };
}

function resolveHistoryPolicy(params: {
  executionProfileIds: Array<ExecutionProfileId | null | undefined>;
  conservative: boolean;
  guardrailReasons?: string[];
}): ResolvedHistoryPolicy {
  const profiles = params.executionProfileIds
    .map((profileId) => getExecutionProfile(profileId))
    .filter((profile): profile is NonNullable<typeof profile> => !!profile);
  const mode: ContextGatingSummaryState['mode'] = params.conservative ? 'CONSERVATIVE' : 'STANDARD';
  const reasons = new Set<string>();
  const workspaceFocused = profiles.some((profile) => profile.historyScope === 'workspace_recent');
  const validatedOutputFocused = profiles.some((profile) => profile.historyScope === 'validated_output_focus');
  const guardrailReasons = (params.guardrailReasons ?? []).filter(Boolean);
  const correctionFocused = guardrailReasons.some((reason) => reason.includes('consolidation_correction'));

  if (profiles.length === 0) {
    reasons.add('default_history_scope');
  }
  for (const profile of profiles) {
    reasons.add(`profile:${profile.id}`);
    reasons.add(`history_scope:${profile.historyScope}`);
  }
  if (params.conservative) {
    if (guardrailReasons.length > 0) {
      for (const reason of guardrailReasons) {
        reasons.add(reason);
      }
    } else {
      reasons.add('guardrail:unspecified');
    }
  }

  return {
    mode,
    recentConversationCount: params.conservative
      ? (correctionFocused ? 2 : 5)
      : (workspaceFocused ? 1 : 0),
    recentOperatorCount: params.conservative
      ? (correctionFocused ? 1 : 4)
      : 2,
    recentToolCount: params.conservative ? 6 : (validatedOutputFocused ? 1 : (profiles.some((profile) => profile.retainRecentToolTurns) ? 3 : 1)),
    recentAssistantCount: params.conservative
      ? (correctionFocused ? 1 : 2)
      : (validatedOutputFocused ? 1 : (workspaceFocused ? 2 : 1)),
    retainDependencyMessages: params.conservative || profiles.some((profile) => profile.retainDependencyMessages),
    reasons: [...reasons]
  };
}

function createGatingSummaryMessage(params: {
  omittedMessages: LlmContextMessage[];
  mode: ContextGatingSummaryState['mode'];
  stageUnitIds: string[];
  dependencyUnitIds: string[];
}): LlmContextMessage {
  const summarizedLines = params.omittedMessages
    .slice(-4)
    .map((message, index) => {
      const scope = collectMessageUnitIds(message).join(',') || 'global';
      const normalized = message.content.replace(/\s+/g, ' ').trim();
      const snippet = normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
      return `- ${index + 1}. ${message.role} scope=${scope}: ${snippet}`;
    });

  return createLlmContextMessage({
    role: 'system',
    compressed: true,
    content: [
      'Context gating summary for provider request.',
      `Mode: ${params.mode}`,
      `Stage units: ${params.stageUnitIds.join(', ') || 'none'}`,
      `Dependency units: ${params.dependencyUnitIds.join(', ') || 'none'}`,
      `Filtered historical messages: ${params.omittedMessages.length}`,
      ...summarizedLines
    ].join('\n'),
    metadata: {
      source: 'context_gating_summary',
      filteredMessageCount: params.omittedMessages.length
    }
  });
}

export function gateProviderRequestContext(params: {
  config: BackendNewConfig;
  current: LlmContextMessage[];
  additions: LlmContextMessage[];
  stageUnitIds: string[];
  contractUnitIds: string[];
  dependencyUnitIds: string[];
  executionProfileIds: Array<ExecutionProfileId | null | undefined>;
  conservative: boolean;
  guardrailReasons?: string[];
}): RequestContextGatingResult {
  const rawMessages = [...params.current, ...params.additions];
  if (rawMessages.length === 0) {
    return {
      contextMessages: appendAndCompressLlmContext({
        config: params.config,
        current: [],
        additions: [],
        conservative: params.conservative
      }),
      summary: createEmptyContextGatingSummary()
    };
  }

  const historyPolicy = resolveHistoryPolicy({
    executionProfileIds: params.executionProfileIds,
    conservative: params.conservative,
    guardrailReasons: params.guardrailReasons
  });
  const stageUnitIds = new Set(params.stageUnitIds);
  const contractUnitIds = new Set(params.contractUnitIds.filter((unitId) => !stageUnitIds.has(unitId)));
  const dependencyUnitIds = new Set(params.dependencyUnitIds.filter((unitId) => !stageUnitIds.has(unitId)));
  const classified = rawMessages.map((message) => classifyMessage({
    message,
    stageUnitIds,
    contractUnitIds,
    dependencyUnitIds
  }));
  const operatorEntries = rawMessages
    .map((message, index) => ({ message, index, scope: classified[index] }))
    .filter(({ scope }) => scope.operatorScoped);
  const supersededStageMessageIndexes = new Set<number>(
    rawMessages
      .map((message, index) => ({ message, index, scope: classified[index] }))
      .filter(({ message, index, scope }) => (
        scope.stageScoped
        && (message.role === 'user' || message.role === 'assistant')
        && hasNewerRelevantOperatorMessage({
          index,
          scope,
          operatorEntries
        })
      ))
      .map(({ index }) => index)
  );
  const recentOperatorIndexes = rawMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' || message.metadata?.source === 'operator_message')
    .filter(({ index }) => !supersededStageMessageIndexes.has(index))
    .slice(-historyPolicy.recentOperatorCount)
    .map(({ index }) => index);
  const recentToolIndexes = rawMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'tool' || message.metadata?.source === 'tool_result')
    .slice(-historyPolicy.recentToolCount)
    .map(({ index }) => index);
  const recentAssistantIndexes = rawMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => (
      message.role === 'assistant'
      && !isToolPayloadAssistantMessage(message)
      && !supersededStageMessageIndexes.has(index)
    ))
    .slice(-historyPolicy.recentAssistantCount)
    .map(({ index }) => index);
  const recentConversationIndexes = rawMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => (
      message.role !== 'system'
      && !message.compressed
      && !isToolPayloadAssistantMessage(message)
      && !supersededStageMessageIndexes.has(index)
    ))
    .slice(-historyPolicy.recentConversationCount)
    .map(({ index }) => index);

  const retainedIndexes = new Set<number>();
  classified.forEach((scope, index) => {
    const message = rawMessages[index];
    const dropVerboseAssistantToolPayload = isToolPayloadAssistantMessage(message);
    if (scope.operatorScoped) {
      if (supersededStageMessageIndexes.has(index)) {
        return;
      }
      if (recentOperatorIndexes.includes(index)) {
        retainedIndexes.add(index);
      }
      return;
    }
    if (scope.stageScoped) {
      if (supersededStageMessageIndexes.has(index)) {
        return;
      }
      if (!dropVerboseAssistantToolPayload) {
        retainedIndexes.add(index);
      }
      return;
    }
    if (scope.contractScoped) {
      if (!dropVerboseAssistantToolPayload) {
        retainedIndexes.add(index);
      }
      return;
    }
    if (historyPolicy.retainDependencyMessages && scope.dependencyScoped) {
      if (!dropVerboseAssistantToolPayload) {
        retainedIndexes.add(index);
      }
      return;
    }
    if (scope.toolScoped && recentToolIndexes.includes(index)) {
      retainedIndexes.add(index);
      return;
    }
    if (recentAssistantIndexes.includes(index)) {
      retainedIndexes.add(index);
      return;
    }
    if (historyPolicy.recentConversationCount > 0 && recentConversationIndexes.includes(index)) {
      retainedIndexes.add(index);
      return;
    }
    if (params.conservative && rawMessages[index].compressed) {
      retainedIndexes.add(index);
    }
  });

  const retainedMessages = rawMessages.filter((_, index) => retainedIndexes.has(index));
  const omittedMessages = rawMessages.filter((_, index) => !retainedIndexes.has(index));
  const gatedMessages = omittedMessages.length > 0
    ? [
      createGatingSummaryMessage({
        omittedMessages,
        mode: historyPolicy.mode,
        stageUnitIds: params.stageUnitIds,
        dependencyUnitIds: [...dependencyUnitIds]
      }),
      ...retainedMessages
    ]
    : retainedMessages;
  const compressedContext = appendAndCompressLlmContext({
    config: params.config,
    current: gatedMessages,
    additions: [],
    conservative: params.conservative
  });
  const rawContextCharacters = estimateRequestMessageCharacters(rawMessages);
  const gatedContextCharacters = estimateRequestMessageCharacters(compressedContext.messages);

  return {
    contextMessages: compressedContext,
    summary: {
      mode: historyPolicy.mode,
      rawContextMessageCount: rawMessages.length,
      retainedContextMessageCount: retainedMessages.length,
      summarizedContextMessageCount: compressedContext.messages.filter((message) => message.compressed).length,
      filteredContextMessageCount: omittedMessages.length,
      stageScopedMessageCount: classified.filter((scope, index) => scope.stageScoped && retainedIndexes.has(index)).length,
      contractScopedMessageCount: classified.filter((scope, index) => scope.contractScoped && retainedIndexes.has(index)).length,
      dependencyScopedMessageCount: classified.filter((scope, index) => scope.dependencyScoped && retainedIndexes.has(index)).length,
      operatorMessageCount: classified.filter((scope, index) => scope.operatorScoped && retainedIndexes.has(index)).length,
      toolMessageCount: classified.filter((scope, index) => scope.toolScoped && retainedIndexes.has(index)).length,
      rawContextCharacters,
      gatedContextCharacters,
      estimatedContextReductionRatio: rawContextCharacters <= 0
        ? 0
        : Number(Math.max(0, 1 - (gatedContextCharacters / rawContextCharacters)).toFixed(4)),
      reasons: [
        ...historyPolicy.reasons,
        ...(supersededStageMessageIndexes.size > 0
          ? [`superseded_stage_messages_dropped:${supersededStageMessageIndexes.size}`]
          : []),
        ...(omittedMessages.length > 0 ? ['historical_messages_summarized_or_filtered'] : ['no_history_filter_needed'])
      ]
    }
  };
}
