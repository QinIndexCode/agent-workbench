import {
  createLlmContextMessage
} from '../../../domain/runtime/context-manager';
import { evolveUserPreferenceProfile } from '../../../domain/runtime/memory';
import { createUnitContract } from '../../../domain/contracts/unit-contract';
import { selectValidatedOutputsForPrompt } from '../../../domain/runtime/context-selection';
import { buildTurnPrompt, BuiltPromptResult } from '../../../domain/runtime/prompt-builder';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { resolveProviderProfile } from '../../../foundation/providers/resolver';
import { selectProviderProfile } from '../../../foundation/providers/selection-policy';
import { ProviderClient, ProviderProfile, ResolvedProviderProfile } from '../../../foundation/providers';
import { TaskRuntimeRecord } from '../../../foundation/repository/types';
import { AgentUnit, UserPreferenceProfile } from '../../../domain/contracts/types';
import { createPromptCapabilitySummary } from '../../runtime/prompt-capability-summary';
import { loadUserPreferenceProfile } from '../../runtime/memory-store';
import { loadWorkspaceWorkflowPromptContext } from '../../runtime/workspace-workflow-context';
import { deriveTaskArtifactRoutingSummary } from '../artifact-routing';
import {
  buildRequiredDelegationContract,
  filterAllowedToolIdsForDelegation,
  getActiveDelegatedChildrenForParent,
  isDelegationRequiredForUnit
} from '../delegation/delegation';
import { getExecutionProfile } from '../../runtime/execution-profiles';
import { gateProviderRequestContext } from './request-context-gating';

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

export interface TurnContextAssemblyResult {
  selectedProvider: ProviderProfile;
  resolvedProvider: ResolvedProviderProfile;
  providerClient: ProviderClient;
  selectedValidatedOutputs: ReturnType<typeof selectValidatedOutputsForPrompt>;
  pendingOperatorInputs: TaskRuntimeRecord['runtime']['pendingOperatorInputs'];
  existingConversations: Awaited<ReturnType<BackendNewFoundation['conversations']['list']>>;
  latestOperatorMessages: Awaited<ReturnType<BackendNewFoundation['operatorMessages']['listLatest']>>;
  userProfile: UserPreferenceProfile | null;
  stageMemorySummary: NonNullable<TaskRuntimeRecord['runtime']['stageMemorySummary']>;
  capabilitySelectionSummary: NonNullable<TaskRuntimeRecord['runtime']['capabilitySelectionSummary']>;
  retrievalSelectionSummary: NonNullable<TaskRuntimeRecord['runtime']['retrievalSelectionSummary']>;
  prompt: string;
  promptResult: BuiltPromptResult;
  contextMessages: ReturnType<typeof gateProviderRequestContext>['contextMessages'];
  contextGatingSummary: ReturnType<typeof gateProviderRequestContext>['summary'];
  estimatedPromptCharacters: number;
  estimatedBaselineCharacters: number;
  estimatedReductionRatio: number;
}

export async function assembleTurnContext(params: {
  foundation: BackendNewFoundation;
  runtimeRecord: TaskRuntimeRecord;
  currentUnit: AgentUnit;
  currentUnitId: string;
  taskId: string;
  userMessage?: string;
}): Promise<TurnContextAssemblyResult> {
  const { foundation, runtimeRecord, currentUnit, currentUnitId, taskId, userMessage } = params;
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
      currentGoal: currentUnit.goal,
      taskId,
      currentUnitId,
      currentExecutionProfileId: currentUnit.executionProfileId ?? null,
      correlationId: runtime.latestCorrelationId,
      sessionId: runtime.latestSessionId,
      turnId: runtime.latestTurnId,
      checkpointId: runtime.latestCheckpointId
    })
  ]);
  const selectedValidatedOutputs = selectValidatedOutputsForPrompt({
    definition: runtimeRecord.definition,
    currentUnit,
    records: validatedOutputs,
    retrievalLimit: foundation.config.runtime.promptMaxSummaryItems
  });
  const artifactRouting = deriveTaskArtifactRoutingSummary({
    definition: runtimeRecord.definition,
    invocations: latestInvocations,
    commands: latestCommands
  });
  const allRuntimes = await foundation.taskRuntimes.list();
  const activeChildCount = getActiveDelegatedChildrenForParent(allRuntimes, taskId).length;
  const delegationRequired = isDelegationRequiredForUnit({
    definition: runtimeRecord.definition,
    unitId: currentUnitId
  });
  const allowedToolIds = filterAllowedToolIdsForDelegation({
    definition: runtimeRecord.definition,
    runtime,
    config: foundation.config,
    pendingApprovalCount: latestApprovals.filter((approval) => approval.status === 'PENDING').length,
    hasRecoveryBlocker: runtime.lifecycleStatus === 'FAILED' || runtime.lifecycleStatus === 'CANCELLED' || Boolean(runtime.lastError),
    commands: latestCommands,
    invocations: latestInvocations,
    baseAllowedToolIds: getExecutionProfile(currentUnit.executionProfileId)?.allowedToolIds ?? null,
    activeChildCount
  });
  const capabilitySelectionSummary = {
    mode: 'FULL' as const,
    toolCount: allowedToolIds?.length ?? foundation.extensions.snapshot().tools.length,
    skillCount: 0,
    mcpCount: 0,
    omittedToolCount: Math.max(0, foundation.extensions.snapshot().tools.length - (allowedToolIds?.length ?? foundation.extensions.snapshot().tools.length)),
    omittedSkillCount: 0,
    omittedMcpCount: 0,
    selectedToolNames: foundation.extensions.snapshot().tools
      .filter((tool) => !allowedToolIds || allowedToolIds.includes(tool.id))
      .map((tool) => tool.name),
    reasons: ['single_unit_prompt_full_tools', ...(allowedToolIds ? ['delegation_tool_filter_applied'] : [])]
  };

  const pendingOperatorInputs = runtime.pendingOperatorInputs;
  const effectiveUserProfile = evolveUserPreferenceProfile({
    current: userProfile,
    userMessage,
    selectedProviderId: resolvedProvider.id
  });
  const currentUnitContract = createUnitContract(currentUnit, runtimeRecord.definition.units.map((unit) => unit.id));
  const guardrailReasons = deriveContextGatingGuardrailReasons(runtime);
  const queuedOperatorAdditions = pendingOperatorInputs.map((entry) => createLlmContextMessage({
    role: 'user',
    content: entry.content,
    metadata: {
      unitId: currentUnitId,
      operatorMessageId: entry.messageId,
      source: 'operator_message'
    }
  }));
  const promptResult = buildTurnPrompt({
    config: foundation.config,
    definition: runtimeRecord.definition,
    runtime,
    currentUnit,
    validatedOutputs: selectedValidatedOutputs.records,
    pendingInvocations: latestInvocations.filter(invocation => invocation.status === 'PLANNED' || invocation.status === 'WAITING_APPROVAL'),
    pendingApprovals: latestApprovals.filter(record => record.status === 'PENDING'),
    provider: {
      id: resolvedProvider.id,
      vendor: resolvedProvider.vendor,
      transport: resolvedProvider.transport,
      model: resolvedProvider.model,
      label: resolvedProvider.label
    },
    capabilities: createPromptCapabilitySummary(foundation, { allowedToolIds }),
    userProfile: effectiveUserProfile,
    artifactRouting: {
      artifactPathState: artifactRouting.artifactPathState,
      artifactPaths: artifactRouting.artifactPaths,
      artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
      selectedArtifactDir: artifactRouting.selectedArtifactDir,
      recommendedArtifactDir: artifactRouting.recommendedArtifactDir,
      lastArtifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null,
      lastArtifactApplyMessage: artifactRouting.lastArtifactApplyResult?.message ?? null
    },
    workspaceProjectInstructions: workspaceWorkflow.projectInstructionsSummary,
    workspaceRuleInstructions: workspaceWorkflow.ruleInstructionsSummary,
    workspaceInstructionSkillInstructions: workspaceWorkflow.instructionSkillInstructionsSummary,
    workspaceApprovedExperienceInstructions: workspaceWorkflow.approvedExperienceInstructionsSummary,
    workspaceCommandInstructions: workspaceWorkflow.commandInstructionsSummary,
    workspaceAgentInstructions: workspaceWorkflow.agentInstructionsSummary,
    importedWorkspaceDocs: workspaceWorkflow.importedDocs,
    delegationRequirement: delegationRequired
      ? {
        required: true,
        satisfied: activeChildCount > 0,
        reason: currentUnit.taskScope ?? currentUnit.goal,
        contract: buildRequiredDelegationContract({
          unit: currentUnit,
          allowedToolIds
        })
      }
      : null
  });

  const contextMessages = gateProviderRequestContext({
    config: foundation.config,
    current: runtime.llmContextMessages,
    additions: [
      ...queuedOperatorAdditions,
      ...(userMessage?.trim()
        ? [
          createLlmContextMessage({
            role: 'user',
            content: userMessage.trim(),
            metadata: {
              unitId: currentUnitId
            }
          })
        ]
        : [])
    ],
    stageUnitIds: [currentUnitId],
    contractUnitIds: [...currentUnitContract.inputScope.unitIds],
    dependencyUnitIds: [...currentUnit.dependencies],
    executionProfileIds: [currentUnit.executionProfileId],
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
    selectedValidatedOutputs,
    pendingOperatorInputs,
    existingConversations,
    latestOperatorMessages,
    userProfile,
    stageMemorySummary: {
      strategy: 'STAGE_VIRTUALIZED',
      milestoneCount: runtime.memory.keyMilestones.length,
      decisionCount: runtime.memory.importantDecisions.length,
      rawMilestoneCount: runtime.memory.keyMilestones.length,
      summarizedMilestoneCount: 0,
      rawDecisionCount: runtime.memory.importantDecisions.length,
      summarizedDecisionCount: 0,
      globalItemCount: [
        ...runtime.memory.keyMilestones,
        ...runtime.memory.importantDecisions
      ].filter((item) => !/^[A-Za-z0-9_-]+:/.test(item)).length,
      protectedItemCount: 0,
      sharedItemCount: 0,
      privateItemCount: runtime.memory.keyMilestones.length + runtime.memory.importantDecisions.length,
      reasons: ['single_unit_memory_snapshot']
    },
    capabilitySelectionSummary,
    retrievalSelectionSummary: {
      mode: 'CONTRACT_ONLY',
      visibleRecordCount: selectedValidatedOutputs.records.length,
      retainedRecordCount: selectedValidatedOutputs.records.length,
      filteredOutCount: 0,
      rawRecordCount: selectedValidatedOutputs.records.length,
      summarizedRecordCount: 0,
      directDependencyCount: selectedValidatedOutputs.records.filter((record) => currentUnit.dependencies.includes(record.unitId)).length,
      protectedRecordCount: 0,
      referencedRecordCount: selectedValidatedOutputs.records.length,
      usedCompatibilityFallback: runtime.contractDiagnostics?.currentUnit.usedCompatibilityFallback ?? false,
      reasons: ['single_unit_contract_scope']
    },
    prompt: promptResult.prompt,
    promptResult,
    contextMessages: contextMessages.contextMessages,
    contextGatingSummary: contextMessages.summary,
    estimatedPromptCharacters,
    estimatedBaselineCharacters,
    estimatedReductionRatio
  };
}
