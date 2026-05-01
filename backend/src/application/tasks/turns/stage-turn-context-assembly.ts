import {
  createLlmContextMessage
} from '../../../domain/runtime/context-manager';
import { evolveUserPreferenceProfile } from '../../../domain/runtime/memory';
import { selectTaskMemoryForPrompt, selectValidatedOutputsForPrompt } from '../../../domain/runtime/context-selection';
import {
  createStageMemoryVirtualization,
  selectStageRelevantValidatedOutputs
} from '../../../domain/runtime/stage-context-virtualization';
import { buildStageTurnPrompt, BuiltStagePromptResult } from '../../../domain/runtime/stage-prompt-builder';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { resolveProviderProfile } from '../../../foundation/providers/resolver';
import { selectProviderProfile } from '../../../foundation/providers/selection-policy';
import { ProviderClient, ProviderProfile, ResolvedProviderProfile } from '../../../foundation/providers';
import { TaskRuntimeRecord } from '../../../foundation/repository/types';
import { SchedulerUnitState, UserPreferenceProfile } from '../../../domain/contracts/types';
import { createStagePromptCapabilitySummary } from '../../runtime/prompt-capability-summary';
import { loadUserPreferenceProfile } from '../../runtime/memory-store';
import { loadWorkspaceWorkflowPromptContext } from '../../runtime/workspace-workflow-context';
import { filterAllowedToolIdsForDelegation, getActiveDelegatedChildrenForParent } from '../delegation/delegation';
import { getExecutionProfile } from '../../runtime/execution-profiles';
import { gateProviderRequestContext } from './request-context-gating';
import { protectOperatorGuidanceForCorrection } from './operator-guidance';

function normalizeRuntimeCollections(
  runtime: TaskRuntimeRecord['runtime'],
): TaskRuntimeRecord['runtime'] {
  const memory = runtime.memory;
  return {
    ...runtime,
    llmContextMessages: runtime.llmContextMessages ?? [],
    pendingOperatorInputs: runtime.pendingOperatorInputs ?? [],
    memory: {
      latestUserIntent: memory?.latestUserIntent ?? null,
      lastUserMessageAt: memory?.lastUserMessageAt ?? null,
      keyMilestones: memory?.keyMilestones ?? [],
      importantDecisions: memory?.importantDecisions ?? [],
      userPreferenceSnapshot: memory?.userPreferenceSnapshot ?? [],
    },
  };
}

function deriveContextGatingGuardrailReasons(runtime: TaskRuntimeRecord['runtime']): string[] {
  const reasons: string[] = [];
  if ((runtime.planner?.fallbackReasons.length ?? 0) > 0) {
    reasons.push('guardrail:planner_fallback');
  }
  if (runtime.consolidationState?.status === 'CORRECTION_REQUIRED') {
    reasons.push('guardrail:consolidation_correction');
  }
  if ((runtime.pendingToolBatches ?? []).some((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED')) {
    reasons.push('guardrail:approval_blocked');
  }
  if (runtime.lifecycleStatus === 'FAILED' || runtime.engineStatus === 'FAILED') {
    reasons.push('guardrail:task_failed');
  } else if (runtime.lastError) {
    reasons.push('guardrail:provider_failure');
  }
  return reasons;
}

function mergeUniqueByUnit<T extends { unitId: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.unitId)) {
      return false;
    }
    seen.add(record.unitId);
    return true;
  });
}

export interface StageTurnContextAssemblyResult {
  selectedProvider: ProviderProfile;
  resolvedProvider: ResolvedProviderProfile;
  providerClient: ProviderClient;
  selectedValidatedOutputs: {
    records: ReturnType<typeof selectValidatedOutputsForPrompt>['records'];
    retrievedContextCount: number;
    policyFilteredOutputCount: number;
  };
  pendingOperatorInputs: TaskRuntimeRecord['runtime']['pendingOperatorInputs'];
  existingConversations: Awaited<ReturnType<BackendNewFoundation['conversations']['list']>>;
  latestOperatorMessages: Awaited<ReturnType<BackendNewFoundation['operatorMessages']['listLatest']>>;
  userProfile: UserPreferenceProfile | null;
  stageMemorySummary: NonNullable<TaskRuntimeRecord['runtime']['stageMemorySummary']>;
  capabilitySelectionSummary: NonNullable<TaskRuntimeRecord['runtime']['capabilitySelectionSummary']>;
  retrievalSelectionSummary: NonNullable<TaskRuntimeRecord['runtime']['retrievalSelectionSummary']>;
  prompt: string;
  promptResult: BuiltStagePromptResult;
  contextMessages: ReturnType<typeof gateProviderRequestContext>['contextMessages'];
  contextGatingSummary: ReturnType<typeof gateProviderRequestContext>['summary'];
  estimatedPromptCharacters: number;
  estimatedBaselineCharacters: number;
  estimatedReductionRatio: number;
}

export async function assembleStageTurnContext(params: {
  foundation: BackendNewFoundation;
  runtimeRecord: TaskRuntimeRecord;
  stageUnits: SchedulerUnitState[];
  stageUnitIds: string[];
  taskId: string;
  userMessage?: string;
}): Promise<StageTurnContextAssemblyResult> {
  const { foundation, runtimeRecord, stageUnits, stageUnitIds, taskId, userMessage } = params;
  const runtime = normalizeRuntimeCollections(runtimeRecord.runtime);
  const selectedProvider = selectProviderProfile(
    foundation.providers,
    foundation.config,
    {
      preferredProviderId: runtime.selectedProviderId ?? runtimeRecord.definition.preferredProviderId
    }
  );
  const resolvedProvider = await resolveProviderProfile(
    foundation.providers,
    foundation.apiKeys,
    selectedProvider.id
  );
  const providerClient = foundation.providerClients.resolve(selectedProvider);
  if (!providerClient) {
    throw new Error(`backend_new provider error: no provider client registered for "${selectedProvider.id}".`);
  }

  const [validatedOutputs, latestInvocations, latestApprovals, latestCommands, existingConversations, latestOperatorMessages, userProfile, workspaceWorkflow] = await Promise.all([
    foundation.validatedOutputs.list(taskId),
    foundation.toolInvocations.listLatest(taskId),
    foundation.approvals.listLatest(taskId),
    foundation.commands.listLatest(taskId),
    foundation.conversations.list(taskId),
    foundation.operatorMessages.listLatest(taskId),
    loadUserPreferenceProfile(foundation),
    loadWorkspaceWorkflowPromptContext({
      foundation,
      definition: runtimeRecord.definition,
      currentGoal: stageUnits.map((unit) => unit.goal).join(' '),
      taskId,
      currentUnitId: stageUnitIds[0] ?? null,
      currentExecutionProfileId: runtimeRecord.definition.units.find((unit) => unit.id === stageUnitIds[0])?.executionProfileId ?? null,
      correlationId: runtime.latestCorrelationId,
      sessionId: runtime.latestSessionId,
      turnId: runtime.latestTurnId,
      checkpointId: runtime.latestCheckpointId
    })
  ]);

  const selectedOutputResults = stageUnits.map((unit) => selectValidatedOutputsForPrompt({
      definition: runtimeRecord.definition,
      currentUnit: unit,
      records: validatedOutputs,
      retrievalLimit: foundation.config.runtime.promptMaxSummaryItems
    }));
  const stageRelevantOutputs = selectStageRelevantValidatedOutputs({
    selectedRecords: selectedOutputResults.flatMap((result) => result.records),
    stageUnits,
    runtime: runtimeRecord.runtime
  });
  const mergedOutputs = mergeUniqueByUnit(stageRelevantOutputs.records);
  const virtualizedMemory = createStageMemoryVirtualization({
    memories: stageUnits.map((unit) => selectTaskMemoryForPrompt({
      definition: runtimeRecord.definition,
      currentUnit: unit,
      memory: runtime.memory ?? null
    })),
    stageUnits,
    runtime
  });
  const capabilitySelection = createStagePromptCapabilitySummary({
    foundation,
    runtime,
    pendingInvocations: latestInvocations.filter((invocation) => invocation.status === 'PLANNED' || invocation.status === 'WAITING_APPROVAL'),
    pendingApprovals: latestApprovals.filter((record) => record.status === 'PENDING'),
    allowedToolIds: filterAllowedToolIdsForDelegation({
      definition: runtimeRecord.definition,
      runtime,
      config: foundation.config,
      pendingApprovalCount: latestApprovals.filter((approval) => approval.status === 'PENDING').length,
      hasRecoveryBlocker: runtime.lifecycleStatus === 'FAILED' || runtime.lifecycleStatus === 'CANCELLED' || Boolean(runtime.lastError),
      commands: latestCommands,
      invocations: latestInvocations,
      baseAllowedToolIds: Array.from(new Set(stageUnitIds.flatMap((unitId) => {
        const definitionUnit = runtimeRecord.definition.units.find((unit) => unit.id === unitId);
        return getExecutionProfile(definitionUnit?.executionProfileId)?.allowedToolIds ?? [];
      }))),
      activeChildCount: getActiveDelegatedChildrenForParent(await foundation.taskRuntimes.list(), taskId).length
    })
  });

  const pendingOperatorInputs = runtime.pendingOperatorInputs;
  const effectiveUserProfile = evolveUserPreferenceProfile({
    current: userProfile,
    userMessage,
    selectedProviderId: resolvedProvider.id
  });
  const queuedOperatorAdditions = pendingOperatorInputs.map((entry) => createLlmContextMessage({
    role: 'user',
    content: protectOperatorGuidanceForCorrection(entry.content, runtime.pendingCorrection),
    metadata: {
      unitIds: stageUnitIds,
      operatorMessageId: entry.messageId,
      source: 'operator_message'
    }
  }));
  const promptResult = buildStageTurnPrompt({
    config: foundation.config,
    definition: runtimeRecord.definition,
    runtime,
    stageUnits,
    validatedOutputs: mergedOutputs,
    pendingInvocations: latestInvocations.filter((invocation) => invocation.status === 'PLANNED' || invocation.status === 'WAITING_APPROVAL'),
    pendingApprovals: latestApprovals.filter((record) => record.status === 'PENDING'),
    provider: {
      id: resolvedProvider.id,
      vendor: resolvedProvider.vendor,
      transport: resolvedProvider.transport,
      model: resolvedProvider.model,
      label: resolvedProvider.label
    },
    capabilities: capabilitySelection.capabilities,
    capabilitySelectionSummary: capabilitySelection.summary,
    retrievalSelectionSummary: stageRelevantOutputs.summary,
    userProfile: effectiveUserProfile,
    stageMemory: virtualizedMemory.memory,
    stageMemorySummary: virtualizedMemory.summary,
    workspaceProjectInstructions: workspaceWorkflow.projectInstructionsSummary,
    workspaceRuleInstructions: workspaceWorkflow.ruleInstructionsSummary,
    workspaceInstructionSkillInstructions: workspaceWorkflow.instructionSkillInstructionsSummary,
    workspaceApprovedExperienceInstructions: workspaceWorkflow.approvedExperienceInstructionsSummary,
    workspaceCommandInstructions: workspaceWorkflow.commandInstructionsSummary,
    workspaceAgentInstructions: workspaceWorkflow.agentInstructionsSummary,
    importedWorkspaceDocs: workspaceWorkflow.importedDocs
  });
  const executionProfileIds = stageUnitIds.map((unitId) => (
    runtimeRecord.definition.units.find((unit) => unit.id === unitId)?.executionProfileId
  ));
  const contractUnitIds = Array.from(new Set(stageUnits.flatMap((unit) => unit.contract.inputScope.unitIds)));
  const dependencyUnitIds = Array.from(new Set(stageUnits.flatMap((unit) => unit.dependencies ?? [])));
  const guardrailReasons = deriveContextGatingGuardrailReasons(runtime);
  const contextMessages = gateProviderRequestContext({
    config: foundation.config,
    current: runtime.llmContextMessages,
    additions: [
      ...queuedOperatorAdditions,
      ...(userMessage?.trim()
        ? [
          createLlmContextMessage({
            role: 'user',
            content: protectOperatorGuidanceForCorrection(userMessage, runtime.pendingCorrection),
            metadata: {
              unitIds: stageUnitIds
            }
          })
        ]
        : [])
    ],
    stageUnitIds,
    contractUnitIds,
    dependencyUnitIds,
    executionProfileIds,
    conservative: (runtime.compressionDowngraded ?? false) || guardrailReasons.length > 0,
    guardrailReasons
  });
  const estimatedPromptCharacters = promptResult.budget.estimatedPromptCharacters
    + contextMessages.summary.gatedContextCharacters;
  const estimatedBaselineCharacters = promptResult.budget.estimatedBaselineCharacters
    + contextMessages.summary.rawContextCharacters;
  const estimatedReductionRatio = estimatedBaselineCharacters <= 0
    ? 0
    : Number(Math.max(0, 1 - (estimatedPromptCharacters / estimatedBaselineCharacters)).toFixed(4));

  return {
    selectedProvider,
    resolvedProvider,
    providerClient,
    selectedValidatedOutputs: {
      records: mergedOutputs,
      retrievedContextCount: 0,
      policyFilteredOutputCount: Math.max(0, validatedOutputs.length - mergedOutputs.length)
    },
    pendingOperatorInputs,
    existingConversations,
    latestOperatorMessages,
    userProfile,
    stageMemorySummary: virtualizedMemory.summary,
    capabilitySelectionSummary: capabilitySelection.summary,
    retrievalSelectionSummary: stageRelevantOutputs.summary,
    prompt: promptResult.prompt,
    promptResult,
    contextMessages: contextMessages.contextMessages,
    contextGatingSummary: contextMessages.summary,
    estimatedPromptCharacters,
    estimatedBaselineCharacters,
    estimatedReductionRatio
  };
}
