import { BackendNewConfig } from '../../foundation/config/types';
import { ToolApprovalRecord, ToolInvocationRecord, ValidatedOutputRecord } from '../../foundation/repository';
import { ProviderPromptPolicy, resolveProviderPromptPolicy } from '../../foundation/providers';
import { createContextCompressionPolicy } from './context-compression-policy';
import { selectTaskMemoryForPrompt } from './context-selection';
import { getCorrectionModeDescription } from './state-machine';
import {
  buildExtensionCapabilitySection,
  buildRuntimeStateSection,
  buildTaskContractSection,
  getCurrentUnitId,
  buildResponsePolicySection,
  buildTaskMemorySection,
  buildToolApprovalSection,
  buildUserPreferenceSection,
  buildValidatedOutputsSection,
  buildWorkspaceInstructionSection,
  PromptArtifactRoutingSummary,
  PromptExtensionCapabilitySummary,
  PromptProviderSummary,
  PromptWorkingDirectorySummary,
  PromptWorkspaceDocSummary
} from './prompt-sections';
import { getQualityProfilePromptSection } from '../quality/task-quality';
import { createPromptBudgetMetadata, createPromptSectionAttribution } from './prompt-budgeter';
import {
  AgentUnit,
  SchedulerUnitState,
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile,
  requiresToolEvidenceForExecutionProfile
} from '../contracts/types';

export interface BuildPromptInput {
  config: BackendNewConfig;
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  currentUnit: AgentUnit | SchedulerUnitState;
  validatedOutputs: ValidatedOutputRecord[];
  pendingInvocations: ToolInvocationRecord[];
  pendingApprovals: ToolApprovalRecord[];
  provider: PromptProviderSummary;
  capabilities: PromptExtensionCapabilitySummary;
  userProfile: UserPreferenceProfile | null;
  artifactRouting?: PromptArtifactRoutingSummary | null;
  workingDirectory?: PromptWorkingDirectorySummary | null;
  workspaceProjectInstructions?: string | null;
  workspaceRuleInstructions?: string | null;
  workspaceInstructionSkillInstructions?: string | null;
  workspaceApprovedExperienceInstructions?: string | null;
  workspaceCommandInstructions?: string | null;
  workspaceAgentInstructions?: string | null;
  importedWorkspaceDocs?: PromptWorkspaceDocSummary[];
  delegationRequirement?: {
    required: boolean;
    satisfied: boolean;
    reason: string | null;
    contract?: {
      title: string;
      role: string;
      goal: string;
      taskScope: string | null;
      outputContract: string;
      allowedToolIds: string[];
      successCriteria: string | null;
    } | null;
  } | null;
}

export interface BuiltPromptResult {
  prompt: string;
  policy: ProviderPromptPolicy;
  budget: ReturnType<typeof createPromptBudgetMetadata>;
}

function truncateCompactPromptText(value: string | null | undefined, limit: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'none';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function summarizeCompactPromptItems(items: string[], params: {
  maxItems: number;
  itemLimit: number;
  emptyText: string;
}): string {
  if (items.length === 0) {
    return params.emptyText;
  }
  const selected = items
    .slice(0, params.maxItems)
    .map((item) => truncateCompactPromptText(item, params.itemLimit));
  if (items.length > selected.length) {
    selected.push(`... ${items.length - selected.length} more omitted`);
  }
  return selected.join(' | ');
}

function summarizeCompactValidatedOutputRecord(parsed: unknown, charLimit: number): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncateCompactPromptText(JSON.stringify(parsed), charLimit);
  }
  const record = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.summary === 'string') {
    parts.push(`summary=${truncateCompactPromptText(record.summary, Math.max(36, Math.floor(charLimit * 0.34)))}`);
  }
  if (typeof record.report === 'string') {
    parts.push(`report=${truncateCompactPromptText(record.report, Math.max(36, Math.floor(charLimit * 0.34)))}`);
  }
  if (typeof record.artifact === 'string') {
    parts.push(`artifact=${truncateCompactPromptText(record.artifact, Math.max(20, Math.floor(charLimit * 0.16)))}`);
  }
  if (Array.isArray(record.issues)) {
    parts.push(`issues=${record.issues.length}`);
  }
  return parts.length > 0
    ? parts.join('; ')
    : truncateCompactPromptText(JSON.stringify(parsed), charLimit);
}

function shouldUseCompactSingleUnitPrompt(currentUnit: AgentUnit | SchedulerUnitState): boolean {
  return 'executionProfileId' in currentUnit && currentUnit.executionProfileId === 'verify';
}

function buildCompactSingleUnitRuntimeSection(params: {
  definition: TaskDefinition;
  currentUnit: AgentUnit | SchedulerUnitState;
}): string[] {
  return [
    'TASK',
    `Task: ${truncateCompactPromptText(params.definition.title, 72)}`,
    `Intent: ${truncateCompactPromptText(params.definition.intent, 108)}`,
    '',
    'UNIT',
    `Current unit=${getCurrentUnitId(params.currentUnit)}; role=${truncateCompactPromptText(params.currentUnit.role, 24)}; goal=${truncateCompactPromptText(params.currentUnit.goal, 56)}; deps=${(params.currentUnit.dependencies ?? []).join(', ') || 'none'}`,
    `Scope=${truncateCompactPromptText('taskScope' in params.currentUnit && params.currentUnit.taskScope ? params.currentUnit.taskScope : 'not declared', 48)}; permission=${'permissionLevel' in params.currentUnit ? params.currentUnit.permissionLevel : 'DEPENDENCY'}`,
    `Contracts=input:${('inputContract' in params.currentUnit && params.currentUnit.inputContract?.trim()) ? 'declared' : 'none'}; output:${params.currentUnit.outputContract?.trim() ? 'declared' : 'none'}; exit:${('exitCondition' in params.currentUnit && params.currentUnit.exitCondition?.trim()) ? 'declared' : 'default'}`
  ];
}

function buildCompactSingleUnitRuntimeStateSection(params: {
  runtime: TaskRuntimeState;
  correctionDirective: string;
  provider: PromptProviderSummary;
}): string[] {
  const pendingOperatorInputs = params.runtime.pendingOperatorInputs ?? [];
  const safePoint = params.runtime.safePoint ?? {
    stage: 'NONE',
    reachedAt: null,
    interruptible: true
  };
  const executionLease = params.runtime.executionLease ?? {
    active: false,
    phase: 'IDLE',
    leaseId: null,
    startedAt: null,
    replayable: true
  };
  return [
    'RUNTIME_STATE',
    `Lifecycle=${params.runtime.lifecycleStatus}; engine=${params.runtime.engineStatus}; correction=${params.runtime.pendingCorrection}; directive=${truncateCompactPromptText(params.correctionDirective, 48)}`,
    `Provider=${params.provider.label} (${params.provider.vendor}/${params.provider.transport}/${params.provider.model}); checkpoint=${params.runtime.latestCheckpointId ?? 'none'}; operatorInputs=${pendingOperatorInputs.length}`,
    `SafePoint=${safePoint.stage}; lease=${executionLease.phase}; lastError=${params.runtime.lastError ? truncateCompactPromptText(params.runtime.lastError, 72) : 'none'}`
  ];
}

function buildCompactSingleUnitMemorySection(params: {
  runtime: Pick<TaskRuntimeState, 'memory'>;
  memory?: TaskRuntimeState['memory'] | null;
}): { lines: string[]; truncatedCount: number } {
  const memory = params.memory ?? params.runtime.memory ?? {
    latestUserIntent: null,
    lastUserMessageAt: null,
    keyMilestones: [],
    importantDecisions: [],
    userPreferenceSnapshot: []
  };
  return {
    lines: [
      'TASK_MEMORY',
      `Latest user intent: ${truncateCompactPromptText(memory.latestUserIntent, 88)}`,
      `Milestones: ${summarizeCompactPromptItems(memory.keyMilestones, { maxItems: 1, itemLimit: 72, emptyText: 'none' })}`,
      `Decisions: ${summarizeCompactPromptItems(memory.importantDecisions, { maxItems: 1, itemLimit: 72, emptyText: 'none' })}`
    ],
    truncatedCount: Math.max(0, memory.keyMilestones.length - 1) + Math.max(0, memory.importantDecisions.length - 1)
  };
}

function buildCompactSingleUnitPreferenceSection(profile: UserPreferenceProfile | null): { lines: string[]; truncatedCount: number } {
  return {
    lines: [
      'USER_PREFERENCES',
      `Preferred language: ${profile?.preferredLanguage ?? 'unknown'}`,
      `Response style: ${profile?.responseStyle ?? 'unknown'}`,
      `Model preference: ${profile?.modelPreference ?? 'unknown'}`,
      'Preference status: minimal stable preference card included; full profile not included in this provider-facing context.'
    ],
    truncatedCount: 0
  };
}

function buildCompactSingleUnitValidatedOutputsSection(params: {
  records: ValidatedOutputRecord[];
}): { lines: string[]; truncatedCount: number } {
  if (params.records.length === 0) {
    return {
      lines: [
        'VALIDATED_OUTPUTS',
        'Selection status: validation-focused compact cards only.',
        '- none'
      ],
      truncatedCount: 0
    };
  }
  const selected = params.records.slice(0, 2).map((record) => (
    `- ${record.unitId}: ${summarizeCompactValidatedOutputRecord(record.parsed, 112)}`
  ));
  if (params.records.length > selected.length) {
    selected.push(`- ... ${params.records.length - selected.length} more record(s) omitted`);
  }
  return {
    lines: [
      'VALIDATED_OUTPUTS',
      'Selection status: validation-focused compact cards only.',
      ...selected
    ],
    truncatedCount: Math.max(0, params.records.length - 2)
  };
}

function buildCompactSingleUnitToolApprovalSection(params: {
  permissionMode: string;
  pendingInvocations: ToolInvocationRecord[];
  pendingApprovals: ToolApprovalRecord[];
}): { lines: string[]; truncatedCount: number } {
  return {
    lines: [
      'TOOL_AND_APPROVAL_POLICY',
      `Tool permission mode: ${params.permissionMode}`,
      `Pending tool invocations: ${params.pendingInvocations.length}`,
      `Pending approvals: ${params.pendingApprovals.length}`,
      'Respect permission mode exactly. Ask-mode requires approval for gated actions; read-only forbids write/network side effects.'
    ],
    truncatedCount: 0
  };
}

function buildCompactSingleUnitExtensionSection(params: {
  capabilities: PromptExtensionCapabilitySummary;
}): { lines: string[]; displayedCount: number; truncatedCount: number } {
  return {
    lines: [
      'EXTENSION_CAPABILITIES',
      `Tools in scope: ${summarizeCompactPromptItems(params.capabilities.tools.map((tool) => tool.name), { maxItems: 4, itemLimit: 18, emptyText: 'none' })}`,
      `Skills in scope: ${summarizeCompactPromptItems(params.capabilities.skills.map((skill) => skill.name), { maxItems: 2, itemLimit: 18, emptyText: 'none' })}`,
      `MCP in scope: ${summarizeCompactPromptItems(params.capabilities.mcpServers.map((server) => server.name), { maxItems: 2, itemLimit: 18, emptyText: 'none' })}`
    ],
    displayedCount: params.capabilities.tools.length + params.capabilities.skills.length + params.capabilities.mcpServers.length,
    truncatedCount:
      Math.max(0, params.capabilities.tools.length - 4)
      + Math.max(0, params.capabilities.skills.length - 2)
      + Math.max(0, params.capabilities.mcpServers.length - 2)
  };
}

function buildCapabilityBaselineSection(params: {
  capabilities: PromptExtensionCapabilitySummary;
}): string[] {
  return [
    'CAPABILITY_BASELINE',
    `Tool count: ${params.capabilities.tools.length}; primary tools: ${summarizeCompactPromptItems(params.capabilities.tools.map((tool) => tool.name), { maxItems: 4, itemLimit: 18, emptyText: 'none' })}`,
    `Skill count: ${params.capabilities.skills.length}; primary skills: ${summarizeCompactPromptItems(params.capabilities.skills.map((skill) => skill.name), { maxItems: 2, itemLimit: 18, emptyText: 'none' })}`,
    `MCP count: ${params.capabilities.mcpServers.length}; primary MCP: ${summarizeCompactPromptItems(params.capabilities.mcpServers.map((server) => server.name), { maxItems: 2, itemLimit: 18, emptyText: 'none' })}`
  ];
}

function joinPromptSections(sections: string[][]): string {
  return sections
    .filter((section) => section.length > 0)
    .map((section) => section.join('\n'))
    .join('\n\n');
}

function buildResponseRequirementsSection(params: {
  currentUnitId: string;
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
}): string[] {
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    return [
      'RESPONSE_REQUIREMENTS',
      `Return exactly one valid tracker JSON block for ${params.currentUnitId}.`,
      'Do not emit explicit output, tool blocks, or explanatory prose in this correction.'
    ];
  }
  if (params.pendingCorrection === 'AWAITING_TOOL_ACTION') {
    return [
      'RESPONSE_REQUIREMENTS',
      'Emit the required machine-readable tool block(s) first.',
      `Then finish with exactly one valid tracker JSON block for ${params.currentUnitId}.`,
      'Do not attempt tracker-only completion before the required tool action is emitted.'
    ];
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return [
      'RESPONSE_REQUIREMENTS',
      `Return exactly one corrected explicit output block for ${params.currentUnitId}, then one valid tracker JSON block.`,
      'Do not respond with tool blocks alone in this correction.'
    ];
  }
  return [
    'RESPONSE_REQUIREMENTS',
    'Return explicit output using the declared wrapper, then a valid progress tracker JSON.',
    'Keep explicit output, tool calls, and tracker as distinct machine-readable blocks.',
    'Do not emit prose that changes the machine-readable meaning of the response.'
  ];
}

function buildDelegationRequirementSection(params: {
  requirement: BuildPromptInput['delegationRequirement'];
}): string[] {
  if (!params.requirement?.required) {
    return [];
  }
  if (params.requirement.satisfied) {
    return [
      'DELEGATION_CONTRACT',
      'This unit already satisfied its required child delegation contract.',
      'Continue parent work only within the scoped result returned from the delegated child task.'
    ];
  }
  return [
    'DELEGATION_CONTRACT',
    'This unit must call delegate_subtask before parent delivery can continue.',
    'Do not proceed with parent-only artifact creation, apply, or completion until the delegated child task exists.',
    params.requirement.reason?.trim()
      ? `Contract detail: ${params.requirement.reason.trim()}`
      : 'Contract detail: create one bounded child task and continue only after it returns a scoped result.',
    ...(params.requirement.contract
      ? [
        'Required child task contract:',
        `- title: ${params.requirement.contract.title}`,
        `- role: ${params.requirement.contract.role}`,
        `- goal: ${params.requirement.contract.goal}`,
        `- taskScope: ${params.requirement.contract.taskScope ?? 'not declared'}`,
        `- outputContract: ${params.requirement.contract.outputContract}`,
        `- allowedToolIds: ${params.requirement.contract.allowedToolIds.join(', ') || 'none'}`,
        `- successCriteria: ${params.requirement.contract.successCriteria ?? 'not declared'}`,
        'Call delegate_subtask exactly once using this bounded child contract before parent delivery continues.'
      ]
      : [])
  ];
}

export function buildTurnPrompt(input: BuildPromptInput): BuiltPromptResult {
  const correctionDirective = getCorrectionModeDescription(input.runtime.pendingCorrection);
  const currentUnitId = getCurrentUnitId(input.currentUnit);
  const policy = resolveProviderPromptPolicy({
    vendor: input.provider.vendor,
    transport: input.provider.transport
  });
  const maxItems = input.config.runtime.promptMaxSummaryItems;
  const charLimit = input.config.runtime.promptSectionCharacterLimit;
  const scopedMemory = selectTaskMemoryForPrompt({
    definition: input.definition,
    currentUnit: input.currentUnit,
    memory: input.runtime.memory ?? null
  });
  const compressionPolicy = createContextCompressionPolicy({
    definition: input.definition,
    runtime: input.runtime,
    currentUnit: input.currentUnit,
    validatedOutputs: input.validatedOutputs,
    memory: scopedMemory
  });
  const compactSingleUnitPrompt = shouldUseCompactSingleUnitPrompt(input.currentUnit);
  const validatedOutputsSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitValidatedOutputsSection({
      records: input.validatedOutputs
    })
    : buildValidatedOutputsSection({
      records: input.validatedOutputs,
      maxItems,
      charLimit,
      compressionPolicy
    });
  const memorySection = compactSingleUnitPrompt
    ? buildCompactSingleUnitMemorySection({
      runtime: input.runtime,
      memory: scopedMemory
    })
    : buildTaskMemorySection({
      runtime: input.runtime,
      memory: scopedMemory,
      maxItems,
      charLimit,
      compressionPolicy
    });
  const preferenceSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitPreferenceSection(input.userProfile)
    : buildUserPreferenceSection({
      profile: input.userProfile,
      runtime: input.runtime,
      maxItems,
      charLimit,
      fullProfileOmitted: true
    });
  const toolApprovalSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitToolApprovalSection({
      permissionMode: input.config.tools.permissionMode,
      pendingInvocations: input.pendingInvocations,
      pendingApprovals: input.pendingApprovals
    })
    : buildToolApprovalSection({
      permissionMode: input.config.tools.permissionMode,
      pendingInvocations: input.pendingInvocations,
      pendingApprovals: input.pendingApprovals,
      maxItems,
      charLimit
    });
  const extensionSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitExtensionSection({
      capabilities: input.capabilities
    })
    : buildExtensionCapabilitySection({
      capabilities: input.capabilities,
      maxItems,
      charLimit
    });
  const taskContractSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitRuntimeSection({
      definition: input.definition,
      currentUnit: input.currentUnit
    })
    : buildTaskContractSection({
      definition: input.definition,
      currentUnit: input.currentUnit
    });
  const runtimeStateSection = compactSingleUnitPrompt
    ? buildCompactSingleUnitRuntimeStateSection({
      runtime: input.runtime,
      correctionDirective,
      provider: input.provider
    })
    : buildRuntimeStateSection({
      runtime: input.runtime,
      correctionDirective,
      provider: input.provider,
      charLimit,
      artifactRouting: input.artifactRouting
    });
  const delegationRequirementSection = buildDelegationRequirementSection({
    requirement: input.delegationRequirement ?? null
  });
  const qualityProfileSection = getQualityProfilePromptSection(
    'qualityProfileId' in input.currentUnit ? input.currentUnit.qualityProfileId ?? null : null
  );
  const capabilityBaselineSection = buildCapabilityBaselineSection({
    capabilities: input.capabilities
  });
  const responsePolicySection = buildResponsePolicySection({
    policy,
    currentUnitId,
    outputContract: input.currentUnit.outputContract,
      requiresToolEvidence: requiresToolEvidenceForExecutionProfile('executionProfileId' in input.currentUnit ? input.currentUnit.executionProfileId : undefined),
      pendingCorrection: input.runtime.pendingCorrection,
      correctionPromptMode: input.runtime.contractDiagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
      acceptanceFailureCategory: input.runtime.contractDiagnostics?.lastAcceptanceFailureCategory ?? null,
      acceptanceIssueMessages: input.runtime.contractDiagnostics?.lastAcceptanceIssueMessages ?? [],
      invalidOutputErrors: input.runtime.invalidOutputUnits?.[currentUnitId] ?? [],
      pendingApprovals: input.pendingApprovals.length
    });
  const responseRequirementsSection = buildResponseRequirementsSection({
    currentUnitId,
    pendingCorrection: input.runtime.pendingCorrection
  });
  const workspaceInstructionSection = buildWorkspaceInstructionSection({
    projectInstructionsSummary: input.workspaceProjectInstructions ?? null,
    ruleInstructionsSummary: input.workspaceRuleInstructions ?? null,
    instructionSkillInstructionsSummary: input.workspaceInstructionSkillInstructions ?? null,
    approvedExperienceInstructionsSummary: input.workspaceApprovedExperienceInstructions ?? null,
    commandInstructionsSummary: input.workspaceCommandInstructions ?? null,
    agentInstructionsSummary: input.workspaceAgentInstructions ?? null,
    workingDirectory: input.workingDirectory ?? null,
    importedDocs: input.importedWorkspaceDocs ?? []
  });
  const stableSections = [
    'SYSTEM',
    'You are operating inside SCC runtime.',
    'User-visible conversation must remain complete. Only provider-facing context may be compressed.'
  ];
  const stablePromptText = joinPromptSections([
    stableSections,
    workspaceInstructionSection,
    taskContractSection,
    ...(qualityProfileSection.length > 0 ? [qualityProfileSection] : []),
    capabilityBaselineSection
  ]);
  const volatilePromptText = joinPromptSections([
    runtimeStateSection,
    ...(delegationRequirementSection.length > 0 ? [delegationRequirementSection] : []),
    responsePolicySection,
    memorySection.lines,
    preferenceSection.lines,
    validatedOutputsSection.lines,
    toolApprovalSection.lines,
    extensionSection.lines,
    [
      'PROMPT_BUDGET',
      `Provider context budget: ${input.config.runtime.maxContextMessages} messages, retain ${input.config.runtime.retainedContextMessages}.`,
      `Prompt section budget: ${charLimit} chars per summarized section, ${maxItems} items per summary.`,
      'Use summaries when prior validated outputs, approvals, or capabilities exceed the prompt budget.'
    ],
    responseRequirementsSection
  ]);
  const promptSeparator = stablePromptText && volatilePromptText ? '\n\n' : '';
  const prompt = `${stablePromptText}${promptSeparator}${volatilePromptText}`;
  const sectionPromptChars = createPromptSectionAttribution({
    stageRuntimeText: [workspaceInstructionSection.join('\n'), taskContractSection.join('\n'), runtimeStateSection.join('\n'), qualityProfileSection.join('\n'), capabilityBaselineSection.join('\n')].filter(Boolean).join('\n\n'),
    responsePolicyText: responsePolicySection.join('\n'),
    taskMemoryText: memorySection.lines.join('\n'),
    preferenceText: preferenceSection.lines.join('\n'),
    validatedOutputText: validatedOutputsSection.lines.join('\n'),
    toolPolicyText: toolApprovalSection.lines.join('\n'),
    capabilityText: extensionSection.lines.join('\n')
  });

  const baselineSystemSection = [
    'SYSTEM',
    'You are operating inside SCC runtime.',
    'User-visible conversation must remain complete. Only provider-facing context may be compressed.'
  ];
  const baselineWorkspaceSection = buildWorkspaceInstructionSection({
      projectInstructionsSummary: input.workspaceProjectInstructions ?? null,
      ruleInstructionsSummary: input.workspaceRuleInstructions ?? null,
      instructionSkillInstructionsSummary: input.workspaceInstructionSkillInstructions ?? null,
      approvedExperienceInstructionsSummary: input.workspaceApprovedExperienceInstructions ?? null,
      commandInstructionsSummary: input.workspaceCommandInstructions ?? null,
      agentInstructionsSummary: input.workspaceAgentInstructions ?? null,
      workingDirectory: input.workingDirectory ?? null,
      importedDocs: input.importedWorkspaceDocs ?? []
    });
  const baselineTaskContractSection = buildTaskContractSection({
      definition: input.definition,
      currentUnit: input.currentUnit
    });
  const baselineRuntimeStateSection = buildRuntimeStateSection({
      runtime: input.runtime,
      correctionDirective,
      provider: input.provider,
      charLimit: Number.MAX_SAFE_INTEGER,
      artifactRouting: input.artifactRouting
    });
  const baselineResponsePolicySection = buildResponsePolicySection({
      policy,
      currentUnitId,
      outputContract: input.currentUnit.outputContract,
        requiresToolEvidence: requiresToolEvidenceForExecutionProfile('executionProfileId' in input.currentUnit ? input.currentUnit.executionProfileId : undefined),
        pendingCorrection: input.runtime.pendingCorrection,
        correctionPromptMode: input.runtime.contractDiagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
        acceptanceFailureCategory: input.runtime.contractDiagnostics?.lastAcceptanceFailureCategory ?? null,
        acceptanceIssueMessages: input.runtime.contractDiagnostics?.lastAcceptanceIssueMessages ?? [],
        invalidOutputErrors: input.runtime.invalidOutputUnits?.[currentUnitId] ?? [],
        pendingApprovals: input.pendingApprovals.length
      });
  const baselineMemorySection = buildTaskMemorySection({
      runtime: input.runtime,
      memory: scopedMemory,
      maxItems: Number.MAX_SAFE_INTEGER,
      charLimit: Number.MAX_SAFE_INTEGER,
      compressionPolicy
    }).lines;
  const baselinePreferenceSection = buildUserPreferenceSection({
      profile: input.userProfile,
      runtime: input.runtime,
      maxItems: Number.MAX_SAFE_INTEGER,
      charLimit: Number.MAX_SAFE_INTEGER
    }).lines;
  const baselineValidatedOutputsSection = buildValidatedOutputsSection({
      records: input.validatedOutputs,
      maxItems: Number.MAX_SAFE_INTEGER,
      charLimit: Number.MAX_SAFE_INTEGER,
      compressionPolicy
    }).lines;
  const baselineToolApprovalSection = buildToolApprovalSection({
      permissionMode: input.config.tools.permissionMode,
      pendingInvocations: input.pendingInvocations,
      pendingApprovals: input.pendingApprovals,
      maxItems: Number.MAX_SAFE_INTEGER,
      charLimit: Number.MAX_SAFE_INTEGER
    }).lines;
  const baselineExtensionSection = buildExtensionCapabilitySection({
      capabilities: input.capabilities,
      maxItems: Number.MAX_SAFE_INTEGER,
      charLimit: Number.MAX_SAFE_INTEGER
    }).lines;
  const baselineStableSections = joinPromptSections([
    baselineSystemSection,
    baselineWorkspaceSection,
    baselineTaskContractSection,
    ...(qualityProfileSection.length > 0 ? [qualityProfileSection] : []),
    capabilityBaselineSection
  ]);
  const baselineVolatileSections = joinPromptSections([
    baselineRuntimeStateSection,
    ...(delegationRequirementSection.length > 0 ? [delegationRequirementSection] : []),
    baselineResponsePolicySection,
    baselineMemorySection,
    baselinePreferenceSection,
    baselineValidatedOutputsSection,
    baselineToolApprovalSection,
    baselineExtensionSection,
    [
      'PROMPT_BUDGET',
      `Provider context budget: ${input.config.runtime.maxContextMessages} messages, retain ${input.config.runtime.retainedContextMessages}.`,
      `Prompt section budget: ${charLimit} chars per summarized section, ${maxItems} items per summary.`,
      'Use summaries when prior validated outputs, approvals, or capabilities exceed the prompt budget.'
    ],
    buildResponseRequirementsSection({
      currentUnitId,
      pendingCorrection: input.runtime.pendingCorrection
    })
  ]);
  const baselinePromptText = `${baselineStableSections}${baselineVolatileSections ? '\n\n' : ''}${baselineVolatileSections}`;

  return {
    prompt,
    policy,
    budget: createPromptBudgetMetadata({
      config: input.config.runtime,
      truncatedItemCount:
        memorySection.truncatedCount
        + preferenceSection.truncatedCount
        +
        validatedOutputsSection.truncatedCount
        + toolApprovalSection.truncatedCount
        + extensionSection.truncatedCount,
      capabilityItemCount: extensionSection.displayedCount,
      validatedOutputCount: input.validatedOutputs.length,
      promptText: prompt,
      baselinePromptText,
      stablePrefixChars: stablePromptText.length + promptSeparator.length,
      volatileSuffixChars: volatilePromptText.length,
      sectionPromptChars
    })
  };
}
