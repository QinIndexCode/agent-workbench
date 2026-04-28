import { BackendNewRuntimeConfig } from '../../foundation/config/types';
import { PromptSectionAttributionState } from '../contracts/types';

export interface PromptBudgetSummaryResult {
  text: string;
  displayedCount: number;
  truncatedCount: number;
  summarizedCharacterCount: number;
  baselineCharacterCount: number;
}

export interface PromptBudgetMetadata {
  maxContextMessages: number;
  retainedContextMessages: number;
  sectionCharacterLimit: number;
  maxSummaryItems: number;
  lastTruncatedItemCount: number;
  lastCapabilityItemCount: number;
  lastValidatedOutputCount: number;
  estimatedPromptCharacters: number;
  estimatedPromptTokens: number;
  estimatedBaselineCharacters: number;
  estimatedBaselineTokens: number;
  estimatedReductionRatio: number;
  rawContextCharacters: number;
  gatedContextCharacters: number;
  rawContextTokens: number;
  gatedContextTokens: number;
  estimatedHistoryReductionRatio: number;
  estimatedSectionReductionRatio: number;
  cacheablePrefixChars: number;
  stablePrefixChars: number;
  volatileSuffixChars: number;
  stablePrefixRatio: number;
  retrievedContextCount: number;
  policyFilteredOutputCount: number;
  operatorInputCount: number;
  sectionPromptChars: PromptSectionAttributionState;
  sectionPromptRatios: PromptSectionAttributionState;
}

export function createEmptyPromptSectionAttribution(): PromptSectionAttributionState {
  return {
    taskMemoryChars: 0,
    preferenceChars: 0,
    validatedOutputChars: 0,
    toolPolicyChars: 0,
    capabilityChars: 0,
    stageRuntimeChars: 0,
    responsePolicyChars: 0
  };
}

export function createPromptSectionAttribution(params: {
  taskMemoryText?: string;
  preferenceText?: string;
  validatedOutputText?: string;
  toolPolicyText?: string;
  capabilityText?: string;
  stageRuntimeText?: string;
  responsePolicyText?: string;
}): PromptSectionAttributionState {
  return {
    taskMemoryChars: params.taskMemoryText?.length ?? 0,
    preferenceChars: params.preferenceText?.length ?? 0,
    validatedOutputChars: params.validatedOutputText?.length ?? 0,
    toolPolicyChars: params.toolPolicyText?.length ?? 0,
    capabilityChars: params.capabilityText?.length ?? 0,
    stageRuntimeChars: params.stageRuntimeText?.length ?? 0,
    responsePolicyChars: params.responsePolicyText?.length ?? 0
  };
}

function createPromptSectionRatios(
  sectionPromptChars: PromptSectionAttributionState,
  totalPromptChars: number
): PromptSectionAttributionState {
  if (totalPromptChars <= 0) {
    return createEmptyPromptSectionAttribution();
  }
  return {
    taskMemoryChars: Number((sectionPromptChars.taskMemoryChars / totalPromptChars).toFixed(4)),
    preferenceChars: Number((sectionPromptChars.preferenceChars / totalPromptChars).toFixed(4)),
    validatedOutputChars: Number((sectionPromptChars.validatedOutputChars / totalPromptChars).toFixed(4)),
    toolPolicyChars: Number((sectionPromptChars.toolPolicyChars / totalPromptChars).toFixed(4)),
    capabilityChars: Number((sectionPromptChars.capabilityChars / totalPromptChars).toFixed(4)),
    stageRuntimeChars: Number((sectionPromptChars.stageRuntimeChars / totalPromptChars).toFixed(4)),
    responsePolicyChars: Number((sectionPromptChars.responsePolicyChars / totalPromptChars).toFixed(4))
  };
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createPromptBudgetMetadata(params: {
  config: BackendNewRuntimeConfig;
  truncatedItemCount: number;
  capabilityItemCount: number;
  validatedOutputCount: number;
  promptText: string;
  baselinePromptText: string;
  stablePrefixChars?: number;
  volatileSuffixChars?: number;
  sectionPromptChars?: PromptSectionAttributionState;
}): PromptBudgetMetadata {
  const estimatedPromptCharacters = params.promptText.length;
  const estimatedBaselineCharacters = params.baselinePromptText.length;
  const estimatedPromptTokens = estimateTokenCount(params.promptText);
  const estimatedBaselineTokens = estimateTokenCount(params.baselinePromptText);
  const stablePrefixChars = Math.max(
    0,
    Math.min(estimatedPromptCharacters, params.stablePrefixChars ?? estimatedPromptCharacters)
  );
  const volatileSuffixChars = Math.max(
    0,
    Math.min(estimatedPromptCharacters, params.volatileSuffixChars ?? Math.max(0, estimatedPromptCharacters - stablePrefixChars))
  );
  const sectionPromptChars = params.sectionPromptChars ?? createEmptyPromptSectionAttribution();
  const estimatedReductionRatio = estimatedBaselineCharacters <= 0
    ? 0
    : Number(Math.max(0, 1 - (estimatedPromptCharacters / estimatedBaselineCharacters)).toFixed(4));
  return {
    maxContextMessages: params.config.maxContextMessages,
    retainedContextMessages: params.config.retainedContextMessages,
    sectionCharacterLimit: params.config.promptSectionCharacterLimit,
    maxSummaryItems: params.config.promptMaxSummaryItems,
    lastTruncatedItemCount: params.truncatedItemCount,
    lastCapabilityItemCount: params.capabilityItemCount,
    lastValidatedOutputCount: params.validatedOutputCount,
    estimatedPromptCharacters,
    estimatedPromptTokens,
    estimatedBaselineCharacters,
    estimatedBaselineTokens,
    estimatedReductionRatio,
    rawContextCharacters: 0,
    gatedContextCharacters: 0,
    rawContextTokens: 0,
    gatedContextTokens: 0,
    estimatedHistoryReductionRatio: 0,
    estimatedSectionReductionRatio: Number(Math.max(0, 1 - (estimatedPromptCharacters / Math.max(1, estimatedBaselineCharacters))).toFixed(4)),
    cacheablePrefixChars: stablePrefixChars,
    stablePrefixChars,
    volatileSuffixChars,
    stablePrefixRatio: Number((stablePrefixChars / Math.max(1, estimatedPromptCharacters)).toFixed(4)),
    retrievedContextCount: 0,
    policyFilteredOutputCount: 0,
    operatorInputCount: 0,
    sectionPromptChars,
    sectionPromptRatios: createPromptSectionRatios(sectionPromptChars, estimatedPromptCharacters)
  };
}

export function summarizePromptList<T>(params: {
  items: T[];
  maxItems: number;
  charLimit: number;
  emptyText: string;
  render: (item: T) => string;
}): PromptBudgetSummaryResult {
  if (params.items.length === 0) {
    return {
      text: params.emptyText,
      displayedCount: 0,
      truncatedCount: 0,
      summarizedCharacterCount: params.emptyText.length,
      baselineCharacterCount: 0
    };
  }

  const renderedItems = params.items.map(item => params.render(item));
  const lines: string[] = [];
  let remainingBudget = Math.max(48, params.charLimit);
  const candidateItems = renderedItems.slice(0, params.maxItems);

  for (const [index, item] of candidateItems.entries()) {
    const remainingSlots = Math.max(1, candidateItems.length - index);
    const perItemLimit = Math.max(48, Math.floor(remainingBudget / remainingSlots));
    const rendered = truncateText(item, Math.min(params.charLimit, perItemLimit));
    if (rendered.length > remainingBudget && lines.length > 0) {
      break;
    }
    lines.push(rendered);
    remainingBudget = Math.max(0, remainingBudget - rendered.length - 1);
  }

  const hiddenCount = Math.max(0, params.items.length - lines.length);
  if (hiddenCount > 0) {
    const omittedLine = `- ... ${hiddenCount} additional item(s) omitted for prompt budget`;
    if (remainingBudget >= omittedLine.length || lines.length === 0) {
      lines.push(truncateText(omittedLine, Math.max(48, remainingBudget || omittedLine.length)));
    } else if (lines.length > 0) {
      lines[lines.length - 1] = truncateText(omittedLine, Math.max(48, lines[lines.length - 1].length));
    }
  }
  const text = lines.join('\n');
  return {
    text,
    displayedCount: lines.length,
    truncatedCount: hiddenCount,
    summarizedCharacterCount: text.length,
    baselineCharacterCount: renderedItems.join('\n').length
  };
}

export function summarizeStructuredValue(value: unknown, charLimit: number): string {
  return truncateText(JSON.stringify(value), charLimit);
}
