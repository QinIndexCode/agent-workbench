import { ValidatedOutputRecord } from '../../foundation/repository';
import {
  RetrievalSelectionSummaryState,
  RuntimeTaskMemoryState,
  SchedulerUnitState,
  StageMemorySummaryState,
  TaskRuntimeState
} from '../contracts/types';

function isProtectedRuntime(runtime: Pick<TaskRuntimeState, 'consolidationState' | 'planner' | 'pendingToolBatches'>): boolean {
  return runtime.consolidationState?.status === 'CORRECTION_REQUIRED'
    || (runtime.planner?.fallbackReasons?.length ?? 0) > 0
    || (runtime.pendingToolBatches ?? []).some((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED');
}

function summarizeMemoryItem(item: string, charLimit = 96): string {
  if (item.length <= charLimit) {
    return item;
  }
  const prefixMatch = item.match(/^([A-Za-z0-9_-]+: )/);
  if (!prefixMatch) {
    return `${item.slice(0, Math.max(0, charLimit - 3))}...`;
  }
  const prefix = prefixMatch[1];
  const remainder = item.slice(prefix.length);
  const remainingChars = Math.max(16, charLimit - prefix.length - 3);
  return `${prefix}${remainder.slice(0, remainingChars)}...`;
}

function buildVirtualizedMemoryItems(params: {
  items: string[];
  protectedMode: boolean;
  stageUnitIds: Set<string>;
}): {
  items: string[];
  rawCount: number;
  summarizedCount: number;
  globalItemCount: number;
  protectedItemCount: number;
  sharedItemCount: number;
  privateItemCount: number;
} {
  const counts = new Map<string, number>();
  for (const item of params.items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }

  const virtualized: string[] = [];
  let rawCount = 0;
  let summarizedCount = 0;
  let globalItemCount = 0;
  let protectedItemCount = 0;
  let sharedItemCount = 0;
  let privateItemCount = 0;

  for (const item of counts.keys()) {
    const match = item.match(/^([A-Za-z0-9_-]+):/);
    const scopedUnitId = match?.[1] ?? null;
    const globalItem = scopedUnitId === null;
    const preserveRaw = params.protectedMode
      || (counts.get(item) ?? 0) > 1
      || (scopedUnitId !== null && params.stageUnitIds.has(scopedUnitId));
    const isShared = (counts.get(item) ?? 0) > 1;

    if (isShared) {
      sharedItemCount += 1;
    } else {
      privateItemCount += 1;
    }

    if (globalItem) {
      globalItemCount += 1;
    }
    if (preserveRaw) {
      rawCount += 1;
      if (params.protectedMode || (scopedUnitId !== null && params.stageUnitIds.has(scopedUnitId))) {
        protectedItemCount += 1;
      }
      virtualized.push(item);
      continue;
    }
    summarizedCount += 1;
    virtualized.push(summarizeMemoryItem(item));
  }

  return {
    items: virtualized,
    rawCount,
    summarizedCount,
    globalItemCount,
    protectedItemCount,
    sharedItemCount,
    privateItemCount
  };
}

export interface StageMemoryVirtualizationResult {
  memory: RuntimeTaskMemoryState | null;
  summary: StageMemorySummaryState;
}

export function createStageMemoryVirtualization(params: {
  memories: Array<RuntimeTaskMemoryState | null>;
  stageUnits: SchedulerUnitState[];
  runtime: Pick<TaskRuntimeState, 'consolidationState' | 'planner' | 'pendingToolBatches'>;
}): StageMemoryVirtualizationResult {
  const selectedMemories = params.memories.filter((memory): memory is RuntimeTaskMemoryState => !!memory);
  if (selectedMemories.length === 0) {
    return {
      memory: null,
      summary: {
        strategy: 'STAGE_VIRTUALIZED',
        milestoneCount: 0,
        decisionCount: 0,
        rawMilestoneCount: 0,
        summarizedMilestoneCount: 0,
        rawDecisionCount: 0,
        summarizedDecisionCount: 0,
        globalItemCount: 0,
        protectedItemCount: 0,
        sharedItemCount: 0,
        privateItemCount: 0,
        reasons: ['empty_stage_memory']
      }
    };
  }

  const protectedMode = isProtectedRuntime(params.runtime);
  const stageUnitIds = new Set(params.stageUnits.map((unit) => unit.unitId));
  const milestoneResult = buildVirtualizedMemoryItems({
    items: selectedMemories.flatMap((memory) => memory.keyMilestones),
    protectedMode,
    stageUnitIds
  });
  const decisionResult = buildVirtualizedMemoryItems({
    items: selectedMemories.flatMap((memory) => memory.importantDecisions),
    protectedMode,
    stageUnitIds
  });
  const latestUserIntent = selectedMemories.find((memory) => memory.latestUserIntent)?.latestUserIntent ?? null;
  const lastUserMessageAt = selectedMemories.reduce<number | null>((latest, memory) => {
    if (typeof memory.lastUserMessageAt !== 'number') {
      return latest;
    }
    return latest === null ? memory.lastUserMessageAt : Math.max(latest, memory.lastUserMessageAt);
  }, null);

  return {
    memory: {
      latestUserIntent,
      lastUserMessageAt,
      keyMilestones: milestoneResult.items,
      importantDecisions: decisionResult.items,
      userPreferenceSnapshot: Array.from(new Set(selectedMemories.flatMap((memory) => memory.userPreferenceSnapshot))).slice(0, 2)
    },
    summary: {
      strategy: 'STAGE_VIRTUALIZED',
      milestoneCount: milestoneResult.items.length,
      decisionCount: decisionResult.items.length,
      rawMilestoneCount: milestoneResult.rawCount,
      summarizedMilestoneCount: milestoneResult.summarizedCount,
      rawDecisionCount: decisionResult.rawCount,
      summarizedDecisionCount: decisionResult.summarizedCount,
      globalItemCount: milestoneResult.globalItemCount + decisionResult.globalItemCount,
      protectedItemCount: milestoneResult.protectedItemCount + decisionResult.protectedItemCount,
      sharedItemCount: milestoneResult.sharedItemCount + decisionResult.sharedItemCount,
      privateItemCount: milestoneResult.privateItemCount + decisionResult.privateItemCount,
      reasons: [
        'deduplicated_stage_memory',
        ...(protectedMode ? ['protected_context_preserved_raw'] : []),
        ...(milestoneResult.summarizedCount + decisionResult.summarizedCount > 0 ? ['single_unit_memory_summarized'] : []),
        ...(milestoneResult.globalItemCount + decisionResult.globalItemCount > 0 ? ['global_memory_scope_trimmed_to_selected_items'] : [])
      ]
    }
  };
}

export interface StageRelevanceSelectionResult {
  records: ValidatedOutputRecord[];
  summary: RetrievalSelectionSummaryState;
}

export function selectStageRelevantValidatedOutputs(params: {
  selectedRecords: ValidatedOutputRecord[];
  stageUnits: SchedulerUnitState[];
  runtime: Pick<TaskRuntimeState, 'consolidationState' | 'planner' | 'pendingToolBatches'>;
}): StageRelevanceSelectionResult {
  const stageDirectDependencies = new Set(params.stageUnits.flatMap((unit) => unit.dependencies ?? []));
  const stageReferencedUnitIds = new Set(params.stageUnits.flatMap((unit) => unit.contract.referencedInputUnitIds));
  const protectedMode = isProtectedRuntime(params.runtime);
  const occurrenceCount = new Map<string, number>();
  for (const record of params.selectedRecords) {
    occurrenceCount.set(record.unitId, (occurrenceCount.get(record.unitId) ?? 0) + 1);
  }

  const uniqueRecords = Array.from(
    params.selectedRecords.reduce((map, record) => map.set(record.unitId, map.get(record.unitId) ?? record), new Map<string, ValidatedOutputRecord>()).values()
  );

  const retained = uniqueRecords.filter((record) => {
    if (protectedMode) {
      return true;
    }
    if ((occurrenceCount.get(record.unitId) ?? 0) > 1) {
      return true;
    }
    if (stageDirectDependencies.has(record.unitId)) {
      return true;
    }
    if (stageReferencedUnitIds.has(record.unitId)) {
      return true;
    }
    return false;
  });

  return {
    records: retained,
    summary: {
      mode: protectedMode ? 'CONTRACT_ONLY' : 'CONTRACT_AND_STAGE_RELEVANCE',
      visibleRecordCount: uniqueRecords.length,
      retainedRecordCount: retained.length,
      filteredOutCount: Math.max(0, uniqueRecords.length - retained.length),
      rawRecordCount: protectedMode
        ? retained.length
        : retained.filter((record) => stageDirectDependencies.has(record.unitId) || (occurrenceCount.get(record.unitId) ?? 0) > 1).length,
      summarizedRecordCount: protectedMode
        ? 0
        : retained.filter((record) => !stageDirectDependencies.has(record.unitId) && (occurrenceCount.get(record.unitId) ?? 0) <= 1).length,
      directDependencyCount: retained.filter((record) => stageDirectDependencies.has(record.unitId)).length,
      protectedRecordCount: protectedMode ? retained.length : 0,
      referencedRecordCount: retained.filter((record) => stageReferencedUnitIds.has(record.unitId)).length,
      usedCompatibilityFallback: params.stageUnits.some((unit) => unit.contract.inputScope.usedCompatibilityFallback),
      reasons: [
        protectedMode ? 'protected_runtime_keeps_visible_records' : 'stage_relevance_filtered_visible_records',
        ...(stageDirectDependencies.size > 0 ? ['direct_dependencies_prioritized'] : []),
        ...(stageReferencedUnitIds.size > 0 ? ['contract_referenced_units_retained'] : []),
        ...(params.stageUnits.some((unit) => unit.contract.inputScope.usedCompatibilityFallback) ? ['compatibility_fallback_used'] : [])
      ]
    }
  };
}
