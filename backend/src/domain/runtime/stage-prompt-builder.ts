import { BackendNewConfig } from '../../foundation/config/types';
import { ToolApprovalRecord, ToolInvocationRecord, ValidatedOutputRecord } from '../../foundation/repository';
import { ProviderPromptPolicy, resolveProviderPromptPolicy } from '../../foundation/providers';
import { createPromptBudgetMetadata, createPromptSectionAttribution } from './prompt-budgeter';
import { extractContractKeys } from '../parser/contract-shape';
import {
  CapabilitySelectionSummaryState,
  PromptSectionAttributionState,
  RetrievalSelectionSummaryState,
  RuntimeTaskMemoryState,
  SchedulerUnitState,
  StageMemorySummaryState,
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile
} from '../contracts/types';
import {
  buildWorkspaceInstructionSection,
  PromptExtensionCapabilitySummary,
  PromptProviderSummary,
  PromptWorkingDirectorySummary,
  PromptWorkspaceDocSummary
} from './prompt-sections';

export interface BuildStagePromptInput {
  config: BackendNewConfig;
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  stageUnits: SchedulerUnitState[];
  validatedOutputs: ValidatedOutputRecord[];
  pendingInvocations: ToolInvocationRecord[];
  pendingApprovals: ToolApprovalRecord[];
  provider: PromptProviderSummary;
  capabilities: PromptExtensionCapabilitySummary;
  capabilitySelectionSummary?: CapabilitySelectionSummaryState;
  retrievalSelectionSummary?: RetrievalSelectionSummaryState;
  userProfile: UserPreferenceProfile | null;
  stageMemory: RuntimeTaskMemoryState | null;
  stageMemorySummary?: StageMemorySummaryState | null;
  workspaceProjectInstructions?: string | null;
  workspaceRuleInstructions?: string | null;
  workspaceInstructionSkillInstructions?: string | null;
  workspaceApprovedExperienceInstructions?: string | null;
  workspaceCommandInstructions?: string | null;
  workspaceAgentInstructions?: string | null;
  importedWorkspaceDocs?: PromptWorkspaceDocSummary[];
  workingDirectory?: PromptWorkingDirectorySummary | null;
}

export interface BuiltStagePromptResult {
  prompt: string;
  policy: ProviderPromptPolicy;
  budget: ReturnType<typeof createPromptBudgetMetadata>;
}

function truncateStageText(value: string | null | undefined, limit: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'none';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function summarizeOptionalText(value: string | undefined, charLimit: number): string {
  const normalized = value?.trim();
  if (!normalized) {
    return 'not declared';
  }
  if (normalized.length <= charLimit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, charLimit - 3))}...`;
}

function summarizeInputContract(inputContract: string | undefined): string {
  const normalized = inputContract?.trim();
  if (!normalized) {
    return 'none';
  }
  if (!normalized.startsWith('{')) {
    return summarizeOptionalText(normalized, 72);
  }
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const units = Array.isArray(parsed.units)
      ? parsed.units.filter((item): item is string => typeof item === 'string')
      : [];
    const memoryUnits = Array.isArray(parsed.memoryUnits)
      ? parsed.memoryUnits.filter((item): item is string => typeof item === 'string')
      : [];
    const memoryKinds = Array.isArray(parsed.memoryKinds)
      ? parsed.memoryKinds.filter((item): item is string => typeof item === 'string')
      : [];
    const outputKeys = parsed.outputKeys && typeof parsed.outputKeys === 'object' && !Array.isArray(parsed.outputKeys)
      ? Object.keys(parsed.outputKeys as Record<string, unknown>)
      : [];
    const parts: string[] = [];
    if (units.length > 0) {
      parts.push(`units=${units.join(',')}`);
    }
    if (outputKeys.length > 0) {
      parts.push(`outputKeys=${outputKeys.join(',')}`);
    }
    if (memoryUnits.length > 0) {
      parts.push(`memoryUnits=${memoryUnits.join(',')}`);
    }
    if (memoryKinds.length > 0) {
      parts.push(`memoryKinds=${memoryKinds.join(',')}`);
    }
    if (typeof parsed.includeGlobalMemory === 'boolean') {
      parts.push(`includeGlobalMemory=${parsed.includeGlobalMemory}`);
    }
    return parts.length > 0 ? parts.join('; ') : 'structured(empty)';
  } catch {
    return summarizeOptionalText(normalized, 72);
  }
}

function summarizeOutputContract(outputContract: string | undefined): string {
  const normalized = outputContract?.trim();
  if (!normalized) {
    return 'none';
  }
  const keys = extractContractKeys(normalized);
  return keys.length > 0 ? `keys=${keys.join(',')}` : summarizeOptionalText(normalized, 72);
}

function summarizeExitCondition(exitCondition: string | undefined): string {
  const normalized = exitCondition?.trim();
  if (!normalized) {
    return 'default(explicit output + tracker)';
  }
  const keys = extractContractKeys(normalized);
  return keys.length > 0 ? `requires=${keys.join(',')}` : summarizeOptionalText(normalized, 72);
}

function summarizeStageMemoryItems(items: string[], maxItems: number, charLimit: number): string[] {
  if (items.length === 0) {
    return ['none'];
  }
  const selected = items.slice(0, maxItems).map((item) => truncateStageText(item, charLimit));
  if (items.length > selected.length) {
    selected.push(`... ${items.length - selected.length} more omitted`);
  }
  return selected;
}

function summarizeStageValidatedOutputRecord(record: ValidatedOutputRecord, charLimit: number): string {
  const parsed = record.parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncateStageText(JSON.stringify(parsed), charLimit);
  }
  const value = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof value.summary === 'string') {
    parts.push(`summary=${truncateStageText(value.summary, Math.max(48, Math.floor(charLimit * 0.32)))}`);
  }
  if (typeof value.report === 'string') {
    parts.push(`report=${truncateStageText(value.report, Math.max(48, Math.floor(charLimit * 0.32)))}`);
  }
  if (typeof value.artifact === 'string') {
    parts.push(`artifact=${truncateStageText(value.artifact, Math.max(24, Math.floor(charLimit * 0.12)))}`);
  }
  if (Array.isArray(value.issues)) {
    parts.push(`issues=${value.issues.length}`);
  }
  return parts.length > 0 ? parts.join('; ') : truncateStageText(JSON.stringify(parsed), charLimit);
}

function buildStageRuntimeSection(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  stageUnits: SchedulerUnitState[];
}): string[] {
  const unitLines = params.stageUnits.map((unit) => (
    `- ${unit.unitId}: role=${truncateStageText(unit.role, 24)}; goal=${truncateStageText(unit.goal, 42)}; deps=${unit.dependencies.join(', ') || 'none'}; scope=${summarizeOptionalText(unit.taskScope, 36)}; contracts: input=${summarizeInputContract(unit.inputContract)}; output=${summarizeOutputContract(unit.outputContract)}; exit=${summarizeExitCondition(unit.exitCondition)}`
  ));
  return [
    'TASK',
    `Task: ${truncateStageText(params.definition.title, 80)}`,
    `Intent: ${truncateStageText(params.definition.intent, 120)}`,
    '',
    'STAGE',
    `Stage index: ${params.runtime.activeStage?.stageIndex ?? 'unknown'}`,
    `Stage units: ${params.stageUnits.map((unit) => unit.unitId).join(', ')}`,
    ...unitLines
  ];
}

function buildStageExecutionStateSection(params: {
  runtime: TaskRuntimeState;
  provider: PromptProviderSummary;
}): string[] {
  return [
    'RUNTIME_STATE',
    `Lifecycle=${params.runtime.lifecycleStatus}; engine=${params.runtime.engineStatus}; correction=${params.runtime.pendingCorrection}; pendingOperatorInputs=${params.runtime.pendingOperatorInputs.length}; executionLease=${params.runtime.executionLease?.phase ?? 'IDLE'}`,
    `Provider=${params.provider.label} (${params.provider.vendor}/${params.provider.transport}/${params.provider.model}); checkpoint=${params.runtime.latestCheckpointId ?? 'none'}`
  ];
}

function buildStageCapabilityBaselineSection(params: {
  capabilities: PromptExtensionCapabilitySummary;
}): string[] {
  return [
    'CAPABILITY_BASELINE',
    `Tool count: ${params.capabilities.tools.length}; tool names: ${params.capabilities.tools.map((tool) => tool.name).join(', ') || 'none'}`,
    `Skill count: ${params.capabilities.skills.length}; skill names: ${params.capabilities.skills.map((skill) => skill.name).join(', ') || 'none'}`,
    `MCP count: ${params.capabilities.mcpServers.length}; MCP names: ${params.capabilities.mcpServers.map((server) => server.name).join(', ') || 'none'}`
  ];
}

function joinPromptSections(sections: string[][]): string {
  return sections
    .filter((section) => section.length > 0)
    .map((section) => section.join('\n'))
    .join('\n\n');
}

function buildStageResponsePolicy(params: {
  policy: ProviderPromptPolicy;
  stageUnits: SchedulerUnitState[];
}): string[] {
  const unitIds = params.stageUnits.map((unit) => unit.unitId);
  return [
    'RESPONSE_POLICY',
    `Provider prompt policy: ${params.policy.vendorLabel}`,
    `Tool call format: ${params.policy.toolCallFormat}`,
    `Stage units: ${unitIds.join(', ')}`,
    'Do not emit outputs or trackers for units outside the current stage.',
    params.policy.toolCallFormat === 'json'
      ? 'Emit tool calls only for current-stage units, using JSON objects only.'
      : 'Emit tool calls only for current-stage units.',
    ...(params.policy.toolCallFormat === 'json'
      ? [
        'Accepted canonical tool names: read_file, inspect_file, write_file, create_folder, list_files, search_files, run_command, delegate_subtask.',
        'Do not use XML wrappers such as <tool>, <tool_call>, <tool_invocation>, or <invoke>.',
        'Canonical JSON tool object example:',
        '{"tool":"write_file","arguments":{"path":"relative/path.txt","content":"file content"}}',
        'For HTML, CSS, JS, Markdown, or any content with quotes/backslashes/newlines, write_file must use arguments.content_lines as an array of lines instead of one giant escaped content string.',
        'For JSON manifests, write_file may use arguments.content_json as an object and the runtime will pretty-print it before writing.'
      ]
      : []),
    'Use this exact output/tracker template for each completed stage unit U:',
    '[U_OUTPUT]',
    '{"summary":"string","issues":[]}',
    '[/U_OUTPUT]',
    '{"current_unit":"U","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"brief reason","next_unit":null,"files_created":[]}',
    'Replace U with one of the valid stage unit ids.'
  ];
}

function buildCompactStageMemorySection(params: {
  stageMemory: RuntimeTaskMemoryState | null;
  stageMemorySummary?: StageMemorySummaryState | null;
}): string[] {
  const memory = params.stageMemory ?? {
    latestUserIntent: null,
    lastUserMessageAt: null,
    keyMilestones: [],
    importantDecisions: [],
    userPreferenceSnapshot: []
  };
  return [
    'TASK_MEMORY',
    `Latest user intent: ${truncateStageText(memory.latestUserIntent, 72)}`,
    ...(params.stageMemorySummary
      ? [
        `Memory status: shared=${params.stageMemorySummary.sharedItemCount}, private=${params.stageMemorySummary.privateItemCount}, protected=${params.stageMemorySummary.protectedItemCount}, global=${params.stageMemorySummary.globalItemCount}.`,
        `Memory notes: ${params.stageMemorySummary.reasons.join(', ') || 'none'}.`
      ]
      : ['Memory status: provider-facing stage memory only includes selected task memory.']),
    `Milestones: ${summarizeStageMemoryItems(memory.keyMilestones, 1, 64).join(' | ')}`,
    `Decisions: ${summarizeStageMemoryItems(memory.importantDecisions, 1, 64).join(' | ')}`
  ];
}

function buildCompactStagePreferenceSection(userProfile: UserPreferenceProfile | null): string[] {
  return [
    'USER_PREFERENCES',
    `Preferred language: ${userProfile?.preferredLanguage ?? 'unknown'}`,
    `Response style: ${userProfile?.responseStyle ?? 'unknown'}`,
    `Model preference: ${userProfile?.modelPreference ?? 'unknown'}`,
    'Preference status: minimal stable preference card included; full profile not included in this provider-facing context.'
  ];
}

function buildCompactStageValidatedOutputsSection(params: {
  validatedOutputs: ValidatedOutputRecord[];
  retrievalSelectionSummary?: RetrievalSelectionSummaryState | null;
}): string[] {
  const lines = [
    'VALIDATED_OUTPUTS',
    ...(params.retrievalSelectionSummary
      ? [
        `Selection status: visible=${params.retrievalSelectionSummary.visibleRecordCount}, retained=${params.retrievalSelectionSummary.retainedRecordCount}, omitted=${params.retrievalSelectionSummary.filteredOutCount}, raw=${params.retrievalSelectionSummary.rawRecordCount}, compact=${params.retrievalSelectionSummary.summarizedRecordCount}.`,
        `Retrieval notes: ${params.retrievalSelectionSummary.reasons.join(', ')}.`
      ]
      : ['Selection status: only records selected for the current stage are included.'])
  ];
  if (params.validatedOutputs.length === 0) {
    return [...lines, '- none'];
  }
  const selected = params.validatedOutputs.slice(0, 2).map((record) => `- ${record.unitId}: ${summarizeStageValidatedOutputRecord(record, 96)}`);
  if (params.validatedOutputs.length > selected.length) {
    selected.push(`- ... ${params.validatedOutputs.length - selected.length} more record(s) omitted`);
  }
  return [...lines, ...selected];
}

function buildCompactStageToolPolicySection(params: {
  permissionMode: string;
  pendingInvocations: ToolInvocationRecord[];
  pendingApprovals: ToolApprovalRecord[];
}): string[] {
  return [
    'TOOL_AND_APPROVAL_POLICY',
    `Tool permission mode: ${params.permissionMode}`,
    `Pending tool invocations: ${params.pendingInvocations.length}`,
    `Pending approvals: ${params.pendingApprovals.length}`,
    'Respect permission mode exactly. Ask-mode requires approval for gated actions; read-only forbids write/network side effects.'
  ];
}

function buildCompactStageCapabilitySection(params: {
  capabilities: PromptExtensionCapabilitySummary;
  selectionSummary?: CapabilitySelectionSummaryState;
}): string[] {
  return [
    'EXTENSION_CAPABILITIES',
    ...(params.selectionSummary
      ? [
        `Selection mode: ${params.selectionSummary.mode}; tools=${params.selectionSummary.toolCount}, skills=${params.selectionSummary.skillCount}, mcp=${params.selectionSummary.mcpCount}.`,
        `Capability notes: ${params.selectionSummary.reasons.join(', ')}.`
      ]
      : ['Selection mode: full capability snapshot included.']),
    `Tools in scope: ${params.capabilities.tools.map((tool) => tool.name).join(', ') || 'none'}`,
    `Skills in scope: ${params.capabilities.skills.map((skill) => skill.name).join(', ') || 'none'}`,
    `MCP in scope: ${params.capabilities.mcpServers.map((server) => server.name).join(', ') || 'none'}`
  ];
}

export function buildStageTurnPrompt(input: BuildStagePromptInput): BuiltStagePromptResult {
  const policy = resolveProviderPromptPolicy({
    vendor: input.provider.vendor,
    transport: input.provider.transport
  });

  const stageRuntimeSection = buildStageRuntimeSection({
    definition: input.definition,
    runtime: input.runtime,
    stageUnits: input.stageUnits
  });
  const stageExecutionStateSection = buildStageExecutionStateSection({
    runtime: input.runtime,
    provider: input.provider
  });
  const responsePolicySection = buildStageResponsePolicy({
    policy,
    stageUnits: input.stageUnits
  });
  const memorySection = buildCompactStageMemorySection({
    stageMemory: input.stageMemory,
    stageMemorySummary: input.stageMemorySummary
  });
  const preferenceSection = buildCompactStagePreferenceSection(input.userProfile);
  const validatedOutputsSection = buildCompactStageValidatedOutputsSection({
    validatedOutputs: input.validatedOutputs,
    retrievalSelectionSummary: input.retrievalSelectionSummary
  });
  const toolApprovalSection = buildCompactStageToolPolicySection({
    permissionMode: input.config.tools.permissionMode,
    pendingInvocations: input.pendingInvocations,
    pendingApprovals: input.pendingApprovals
  });
  const extensionSection = buildCompactStageCapabilitySection({
    capabilities: input.capabilities,
    selectionSummary: input.capabilitySelectionSummary
  });
  const capabilityBaselineSection = buildStageCapabilityBaselineSection({
    capabilities: input.capabilities
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
  const stablePromptText = joinPromptSections([
    [
      'SYSTEM',
      'You are operating inside SCC runtime planner stage execution.',
      'User-visible conversation must remain complete. Only provider-facing context may be compressed.'
    ],
    workspaceInstructionSection,
    stageRuntimeSection,
    capabilityBaselineSection
  ]);
  const volatilePromptText = joinPromptSections([
    stageExecutionStateSection,
    responsePolicySection,
    memorySection,
    preferenceSection,
    validatedOutputsSection,
    toolApprovalSection,
    extensionSection
  ]);
  const promptSeparator = stablePromptText && volatilePromptText ? '\n\n' : '';
  const prompt = `${stablePromptText}${promptSeparator}${volatilePromptText}`;

  const baselineSystemSection = [
    'SYSTEM',
    'You are operating inside SCC runtime planner stage execution.',
    'User-visible conversation must remain complete. Only provider-facing context may be compressed.'
  ];
  const baselinePromptText = `${joinPromptSections([
    baselineSystemSection
  ])}\n\n${joinPromptSections([
    workspaceInstructionSection,
    stageRuntimeSection,
    capabilityBaselineSection,
    stageExecutionStateSection,
    responsePolicySection,
    memorySection,
    preferenceSection,
    validatedOutputsSection,
    toolApprovalSection,
    extensionSection
  ])}`;

  const sectionPromptChars = createPromptSectionAttribution({
    stageRuntimeText: [workspaceInstructionSection.join('\n'), stageRuntimeSection.join('\n'), stageExecutionStateSection.join('\n'), capabilityBaselineSection.join('\n')].filter(Boolean).join('\n\n'),
    responsePolicyText: responsePolicySection.join('\n'),
    taskMemoryText: memorySection.join('\n'),
    preferenceText: preferenceSection.join('\n'),
    validatedOutputText: validatedOutputsSection.join('\n'),
    toolPolicyText: toolApprovalSection.join('\n'),
    capabilityText: extensionSection.join('\n')
  });

  return {
    prompt,
    policy,
    budget: createPromptBudgetMetadata({
      config: input.config.runtime,
      truncatedItemCount: 0,
      capabilityItemCount: input.capabilities.tools.length + input.capabilities.skills.length + input.capabilities.mcpServers.length,
      validatedOutputCount: input.validatedOutputs.length,
      promptText: prompt,
      baselinePromptText,
      stablePrefixChars: stablePromptText.length + promptSeparator.length,
      volatileSuffixChars: volatilePromptText.length,
      sectionPromptChars
    })
  };
}
