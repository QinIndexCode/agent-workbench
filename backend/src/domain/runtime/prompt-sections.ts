import { ToolApprovalRecord, ToolInvocationRecord, ValidatedOutputRecord } from '../../foundation/repository';
import { ProviderPromptPolicy, ProviderTransport, ProviderVendor } from '../../foundation/providers';
import { extractContractKeys } from '../parser/contract-shape';
import { summarizePromptList, summarizeStructuredValue } from './prompt-budgeter';
import { ContextCompressionPolicyResult } from './context-compression-policy';
import {
  AcceptanceFailureCategory,
  CorrectionPromptMode,
  CapabilitySelectionSummaryState,
  AgentUnit,
  RetrievalSelectionSummaryState,
  SchedulerUnitState,
  StageMemorySummaryState,
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile
} from '../contracts/types';

export const CANONICAL_JSON_TOOL_NAMES = [
  'read_file',
  'inspect_file',
  'write_file',
  'create_folder',
  'list_files',
  'search_files',
  'run_command',
  'request_working_directory',
  'delegate_subtask'
] as const;

export const CANONICAL_JSON_TOOL_NAMES_LINE =
  `Accepted canonical tool names: ${CANONICAL_JSON_TOOL_NAMES.join(', ')}.`;

export interface PromptProviderSummary {
  id: string;
  vendor: ProviderVendor;
  transport: ProviderTransport;
  model: string;
  label: string;
}

export interface PromptToolCapabilitySummary {
  name: string;
  effect: string;
  riskLevel: string;
  supportsApprovalResume: boolean;
  maxExecutionMs: number | null;
}

export interface PromptSkillCapabilitySummary {
  name: string;
  kind?: 'runtime-skill' | 'instruction-skill';
  instructionOnly?: boolean;
  supportsStreaming: boolean;
  supportsWorkspaceWrite: boolean;
  supportsNetworkAccess: boolean;
}

export interface PromptMcpCapabilitySummary {
  name: string;
  transport: string;
  supportsTools: boolean;
  supportsPrompts: boolean;
  supportsResources: boolean;
}

export interface PromptExtensionCapabilitySummary {
  tools: PromptToolCapabilitySummary[];
  skills: PromptSkillCapabilitySummary[];
  mcpServers: PromptMcpCapabilitySummary[];
}

export interface PromptWorkspaceDocSummary {
  title: string;
  content: string;
  sourcePath: string;
}

export interface PromptArtifactRoutingSummary {
  artifactPathState: 'unresolved' | 'sandbox_only' | 'ready_to_apply' | 'applied';
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  lastArtifactApplyStatus: 'APPLIED' | 'CONFLICT' | 'FAILED' | null;
  lastArtifactApplyMessage: string | null;
}

export interface PromptWorkingDirectorySummary {
  status: 'explicit' | 'default' | 'missing';
  workingDirectory: string | null;
  source: 'operator' | 'runtime_default' | 'metadata' | 'missing';
  requiresSelection: boolean;
  guidance: string;
}

function summarizeRoutingPaths(paths: string[], params: {
  maxItems: number;
  charLimit: number;
  emptyText: string;
}): string {
  if (paths.length === 0) {
    return params.emptyText;
  }
  const summary = summarizePromptList({
    items: paths,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: params.emptyText,
    render: (item) => `- ${item}`
  });
  return summary.text.replace(/\s+/g, ' ').trim();
}

export function getCurrentUnitId(unit: AgentUnit | SchedulerUnitState): string {
  return 'id' in unit ? unit.id : unit.unitId;
}

export function buildTaskContractSection(params: {
  definition: TaskDefinition;
  currentUnit: AgentUnit | SchedulerUnitState;
}): string[] {
  return [
    'TASK',
    `Task: ${params.definition.title}`,
    `Intent: ${params.definition.intent}`,
    '',
    'UNIT',
    `Current unit: ${getCurrentUnitId(params.currentUnit)}`,
    `Role: ${params.currentUnit.role}`,
    `Goal: ${params.currentUnit.goal}`,
    `Task scope: ${'taskScope' in params.currentUnit && params.currentUnit.taskScope ? params.currentUnit.taskScope : 'not declared'}`,
    `Permission level: ${'permissionLevel' in params.currentUnit ? params.currentUnit.permissionLevel : 'DEPENDENCY'}`,
    `Dependencies: ${(params.currentUnit.dependencies ?? []).join(', ') || 'none'}`,
    '',
    'INPUT_CONTRACT',
    ('inputContract' in params.currentUnit && params.currentUnit.inputContract?.trim()) || 'No explicit input contract.',
    '',
    'OUTPUT_CONTRACT',
    params.currentUnit.outputContract?.trim() || 'No explicit output contract.',
    '',
    'EXIT_CONDITION',
    ('exitCondition' in params.currentUnit && params.currentUnit.exitCondition?.trim()) || 'Exit when explicit output and tracker are both valid.'
  ];
}

export function buildRuntimeStateSection(params: {
  runtime: TaskRuntimeState;
  correctionDirective: string;
  provider: PromptProviderSummary;
  charLimit: number;
  artifactRouting?: PromptArtifactRoutingSummary | null;
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
  const lines = [
    'RUNTIME_STATE',
    `Lifecycle: ${params.runtime.lifecycleStatus}`,
    `Engine: ${params.runtime.engineStatus}`,
    `Pending correction: ${params.runtime.pendingCorrection}`,
    `Correction directive: ${params.correctionDirective}`,
    `Current provider: ${params.provider.label} (${params.provider.vendor}/${params.provider.transport}, ${params.provider.model})`,
    `Latest checkpoint: ${params.runtime.latestCheckpointId ?? 'none'}`,
    `LLM context ref: ${params.runtime.llmContextSnapshotRef?.turnId ?? 'none'}`,
    `Conversation ref: ${params.runtime.conversationSnapshotRef?.turnId ?? 'none'}`,
    `Pending operator inputs: ${pendingOperatorInputs.length}`,
    `Safe point: ${safePoint.stage} (interruptible=${safePoint.interruptible})`,
    `Execution lease: ${executionLease.phase}`,
    `Last error: ${params.runtime.lastError ? summarizeStructuredValue(params.runtime.lastError, params.charLimit) : 'none'}`
  ];
  if (
    params.artifactRouting
    && (
      params.artifactRouting.artifactPaths.length > 0
      || params.artifactRouting.artifactDestinationPaths.length > 0
      || params.artifactRouting.selectedArtifactDir
      || params.artifactRouting.recommendedArtifactDir
    )
  ) {
    lines.push(
      '',
      'ARTIFACT_ROUTING',
      `Artifact path state: ${params.artifactRouting.artifactPathState}`,
      `Sandbox/source artifacts: ${summarizeRoutingPaths(params.artifactRouting.artifactPaths, {
        maxItems: 4,
        charLimit: Math.max(96, Math.floor(params.charLimit * 0.45)),
        emptyText: 'none'
      })}`,
      `Selected destination: ${params.artifactRouting.selectedArtifactDir ?? 'none'}`,
      `Recommended destination: ${params.artifactRouting.recommendedArtifactDir ?? 'none'}`,
      `Applied destination paths: ${summarizeRoutingPaths(params.artifactRouting.artifactDestinationPaths, {
        maxItems: 4,
        charLimit: Math.max(96, Math.floor(params.charLimit * 0.45)),
        emptyText: 'none'
      })}`,
      `Last artifact apply: ${params.artifactRouting.lastArtifactApplyStatus ?? 'none'}${params.artifactRouting.lastArtifactApplyMessage ? ` (${summarizeStructuredValue(params.artifactRouting.lastArtifactApplyMessage, Math.max(120, Math.floor(params.charLimit * 0.5)))})` : ''}`
    );
  }
  return lines;
}

export function buildBaseRuntimeSection(params: {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  currentUnit: AgentUnit | SchedulerUnitState;
  correctionDirective: string;
  provider: PromptProviderSummary;
  charLimit: number;
  artifactRouting?: PromptArtifactRoutingSummary | null;
}): string[] {
  return [
    ...buildTaskContractSection({
      definition: params.definition,
      currentUnit: params.currentUnit
    }),
    '',
    ...buildRuntimeStateSection({
      runtime: params.runtime,
      correctionDirective: params.correctionDirective,
      provider: params.provider,
      charLimit: params.charLimit,
      artifactRouting: params.artifactRouting
    })
  ];
}

export function buildWorkspaceInstructionSection(params: {
  projectInstructionsSummary: string | null;
  ruleInstructionsSummary?: string | null;
  instructionSkillInstructionsSummary?: string | null;
  approvedExperienceInstructionsSummary?: string | null;
  commandInstructionsSummary: string | null;
  agentInstructionsSummary?: string | null;
  importedDocs?: PromptWorkspaceDocSummary[];
  workingDirectory?: PromptWorkingDirectorySummary | null;
}): string[] {
  const lines = ['WORKSPACE_WORKFLOW'];
  if (params.workingDirectory) {
    lines.push(
      'WORKING_DIRECTORY',
      `Status: ${params.workingDirectory.status}`,
      `Selected directory: ${params.workingDirectory.workingDirectory ?? 'none'}`,
      `Source: ${params.workingDirectory.source}`,
      `Requires selection: ${params.workingDirectory.requiresSelection}`,
      params.workingDirectory.guidance
    );
  } else {
    lines.push(
      'WORKING_DIRECTORY',
      'Status: missing',
      'Selected directory: none',
      'Source: missing',
      'Requires selection: true',
      'No project working directory was selected. Use the isolated task workspace for sandboxed artifacts, and ask the operator before reading project files or running project-local commands.'
    );
  }
  if (params.projectInstructionsSummary) {
    lines.push(`Project instructions: ${params.projectInstructionsSummary}`);
  } else {
    lines.push('Project instructions: none');
  }
  if (params.ruleInstructionsSummary) {
    lines.push(`Workspace rules: ${params.ruleInstructionsSummary}`);
  } else {
    lines.push('Workspace rules: none');
  }
  if (params.instructionSkillInstructionsSummary) {
    lines.push(`Instruction skills: ${params.instructionSkillInstructionsSummary}`);
  } else {
    lines.push('Instruction skills: none');
  }
  if (params.approvedExperienceInstructionsSummary) {
    lines.push(`Approved experiences: ${params.approvedExperienceInstructionsSummary}`);
  } else {
    lines.push('Approved experiences: none');
  }
  if (params.commandInstructionsSummary) {
    lines.push(`Task/command instructions: ${params.commandInstructionsSummary}`);
  } else {
    lines.push('Task/command instructions: none');
  }
  if (params.agentInstructionsSummary) {
    lines.push(`Workspace agent: ${params.agentInstructionsSummary}`);
  } else {
    lines.push('Workspace agent: none');
  }
  const docs = params.importedDocs ?? [];
  if (docs.length === 0) {
    lines.push('Imported docs in scope: none');
    return lines;
  }
  lines.push('Imported docs in scope:');
  for (const doc of docs) {
    lines.push(`- ${doc.sourcePath}: ${summarizeStructuredValue(`${doc.title} ${doc.content}`, 220)}`);
  }
  return lines;
}

export function buildTaskMemorySection(params: {
  runtime: Pick<TaskRuntimeState, 'memory'>;
  memory?: TaskRuntimeState['memory'] | null;
  memorySummary?: StageMemorySummaryState | null;
  maxItems: number;
  charLimit: number;
  compressionPolicy?: ContextCompressionPolicyResult;
}): {
  lines: string[];
  truncatedCount: number;
} {
  const memory = params.memory ?? params.runtime.memory ?? {
    latestUserIntent: null,
    lastUserMessageAt: null,
    keyMilestones: [],
    importantDecisions: [],
    userPreferenceSnapshot: []
  };
  const preservedMemoryUnitIds = new Set(params.compressionPolicy?.preservedMemoryUnitIds ?? []);
  const preservedMilestones = memory.keyMilestones.filter((item) => {
    const match = item.match(/^([A-Za-z0-9_-]+):/);
    return !!match && preservedMemoryUnitIds.has(match[1]);
  });
  const summarizedMilestones = memory.keyMilestones.filter((item) => !preservedMilestones.includes(item));
  const preservedDecisions = memory.importantDecisions.filter((item) => {
    const match = item.match(/^([A-Za-z0-9_-]+):/);
    return !!match && preservedMemoryUnitIds.has(match[1]);
  });
  const summarizedDecisions = memory.importantDecisions.filter((item) => !preservedDecisions.includes(item));
  const milestoneSummary = summarizePromptList({
    items: summarizedMilestones,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No key milestones have been captured yet.',
    render: (item) => `- ${item}`
  });
  const decisionSummary = summarizePromptList({
    items: summarizedDecisions,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No important decisions have been captured yet.',
    render: (item) => `- ${item}`
  });
  return {
    lines: [
      'TASK_MEMORY',
      `Latest user intent: ${memory.latestUserIntent ?? 'none'}`,
      ...(params.compressionPolicy
        ? [`Compression policy: ${params.compressionPolicy.mode}${params.compressionPolicy.compressionDowngraded ? ' (conservative)' : ''}`]
        : []),
      ...(params.memorySummary
        ? [
          `Selection status: shared=${params.memorySummary.sharedItemCount}, private=${params.memorySummary.privateItemCount}, protected=${params.memorySummary.protectedItemCount}, global-selected=${params.memorySummary.globalItemCount}.`,
          `Stage memory virtualization: raw=${params.memorySummary.rawMilestoneCount + params.memorySummary.rawDecisionCount}, summarized=${params.memorySummary.summarizedMilestoneCount + params.memorySummary.summarizedDecisionCount}.`,
          `Memory notes: ${params.memorySummary.reasons.join(', ')}.`
        ]
        : ['Selection status: provider-facing task memory may include raw and compact summary entries; non-selected memory is not included in this prompt.']),
      '',
      'KEY_MILESTONES',
      ...(preservedMilestones.length > 0
        ? ['Preserved raw milestones:', ...preservedMilestones.map((item) => `- ${item}`), '']
        : []),
      milestoneSummary.text,
      '',
      'IMPORTANT_DECISIONS',
      ...(preservedDecisions.length > 0
        ? ['Preserved raw decisions:', ...preservedDecisions.map((item) => `- ${item}`), '']
        : []),
      decisionSummary.text
    ],
    truncatedCount: milestoneSummary.truncatedCount + decisionSummary.truncatedCount
  };
}

export function buildUserPreferenceSection(params: {
  profile: UserPreferenceProfile | null;
  runtime: TaskRuntimeState;
  maxItems: number;
  charLimit: number;
  snapshotItemsOverride?: string[];
  suppressEmptySnapshotText?: boolean;
  fullProfileOmitted?: boolean;
}): {
  lines: string[];
  truncatedCount: number;
} {
  const memory = params.runtime.memory ?? {
    latestUserIntent: null,
    lastUserMessageAt: null,
    keyMilestones: [],
    importantDecisions: [],
    userPreferenceSnapshot: []
  };
  const snapshotItems = params.snapshotItemsOverride ?? memory.userPreferenceSnapshot;
  const preferenceSummary = summarizePromptList({
    items: snapshotItems,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No durable user preferences are known yet.',
    render: (item) => `- ${item}`
  });
  const detailLines = params.suppressEmptySnapshotText && snapshotItems.length === 0
    ? []
    : [preferenceSummary.text];
  return {
    lines: [
      'USER_PREFERENCES',
      `Preferred language: ${params.profile?.preferredLanguage ?? 'unknown'}`,
      `Response style: ${params.profile?.responseStyle ?? 'unknown'}`,
      `Model preference: ${params.profile?.modelPreference ?? 'unknown'}`,
      ...(params.fullProfileOmitted !== false
        ? ['Preference status: minimal stable preference card included; full profile not included in this provider-facing context.']
        : []),
      ...detailLines
    ],
    truncatedCount: preferenceSummary.truncatedCount
  };
}

export function buildResponsePolicySection(params: {
  policy: ProviderPromptPolicy;
  currentUnitId: string;
  outputContract?: string;
  requiresToolEvidence?: boolean;
  pendingCorrection?: TaskRuntimeState['pendingCorrection'];
  correctionPromptMode?: CorrectionPromptMode;
  acceptanceFailureCategory?: AcceptanceFailureCategory | null;
  acceptanceIssueMessages?: string[];
  invalidOutputErrors?: string[];
  pendingApprovals?: number;
}): string[] {
  const outputKeys = params.outputContract ? extractContractKeys(params.outputContract) : [];
  const outputExampleRecord: Record<string, unknown> = {};
  for (const key of outputKeys) {
    if (key === 'issues') {
      outputExampleRecord[key] = [];
    } else if (key === 'artifact') {
      outputExampleRecord[key] = 'artifact/path.txt';
    } else if (key === 'report') {
      outputExampleRecord[key] = 'concise report';
    } else if (key === 'summary') {
      outputExampleRecord[key] = 'brief summary';
    } else {
      outputExampleRecord[key] = 'value';
    }
  }
  if (Object.keys(outputExampleRecord).length === 0) {
    outputExampleRecord.summary = 'brief summary';
    outputExampleRecord.issues = [];
  }
  const requiresExplicitOutputAfterToolAction = correctionStillNeedsExplicitOutput({
    acceptanceIssueMessages: params.acceptanceIssueMessages ?? [],
    invalidOutputErrors: params.invalidOutputErrors ?? []
  });
  const correctionLines = buildCorrectionFocusSection({
    currentUnitId: params.currentUnitId,
    pendingCorrection: params.pendingCorrection ?? 'NONE',
    correctionPromptMode: params.correctionPromptMode ?? 'FULL_PROTOCOL',
    acceptanceFailureCategory: params.acceptanceFailureCategory ?? null,
    acceptanceIssueMessages: params.acceptanceIssueMessages ?? [],
    invalidOutputErrors: params.invalidOutputErrors ?? [],
    pendingApprovals: params.pendingApprovals ?? 0,
    outputKeys
  });
  const responseOrderLines = buildResponseOrderLines({
    currentUnitId: params.currentUnitId,
    pendingCorrection: params.pendingCorrection ?? 'NONE',
    correctionPromptMode: params.correctionPromptMode ?? 'FULL_PROTOCOL',
    requiresExplicitOutputAfterToolAction
  });
  const providerGuidanceLines = filterProviderGuidanceLines({
    pendingCorrection: params.pendingCorrection ?? 'NONE',
    guidanceLines: params.policy.guidanceLines
  });
  return [
    'RESPONSE_POLICY',
    `Provider prompt policy: ${params.policy.vendorLabel}`,
    `Preferred explicit output wrappers: ${params.policy.preferredOutputWrappers.join(', ')}`,
    `Tracker format: ${params.policy.trackerFormat}`,
    `Tool call format: ${params.policy.toolCallFormat}`,
    `Tracker current_unit must equal "${params.currentUnitId}".`,
    ...responseOrderLines,
    ...(shouldRenderExplicitOutputExample(params.pendingCorrection ?? 'NONE', requiresExplicitOutputAfterToolAction)
      ? [
        'Use this exact explicit output wrapper pattern:',
        `[${params.currentUnitId}_OUTPUT]`,
        JSON.stringify(outputExampleRecord),
        `[/${params.currentUnitId}_OUTPUT]`
      ]
      : []),
    'Use this exact tracker JSON shape:',
    buildTrackerExample({
      currentUnitId: params.currentUnitId,
      pendingCorrection: params.pendingCorrection ?? 'NONE'
    }),
    ...(params.pendingCorrection === 'AWAITING_TOOL_ACTION' || params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION'
      ? ['If required tool actions, missing evidence, or explicit-output corrections still remain, do not use status COMPLETE in this turn.']
      : []),
    ...(shouldRenderExplicitOutputExample(params.pendingCorrection ?? 'NONE', requiresExplicitOutputAfterToolAction)
      ? ['Do not wrap the explicit output block or tracker JSON in Markdown fences.']
      : ['Do not wrap the tracker JSON or tool blocks in Markdown fences.']),
    ...(params.policy.toolCallFormat === 'json'
      ? [
        'Tool calls must be JSON objects only.',
        CANONICAL_JSON_TOOL_NAMES_LINE,
        'Do not use XML wrappers such as <tool>, <tool_call>, <tool_invocation>, or <invoke>.',
        'Canonical JSON tool object example:',
        '{"tool":"write_file","arguments":{"path":"relative/path.txt","content":"file content"}}',
        'For HTML, CSS, JS, Markdown, or any content with quotes/backslashes/newlines, write_file must use arguments.content_lines as an array of lines instead of one giant escaped content string.',
        'For JSON manifests, write_file may use arguments.content_json as an object and the runtime will pretty-print it before writing.'
      ]
      : []),
    ...(shouldRenderGenericToolGuidance(params.pendingCorrection ?? 'NONE')
      ? [params.policy.toolCallFormat === 'json'
        ? 'If tool calls are needed, emit them as separate JSON objects using the canonical tool names above.'
        : 'If tool calls are needed, emit them as separate machine-readable blocks.']
      : []),
    ...(shouldRenderGenericToolGuidance(params.pendingCorrection ?? 'NONE')
      ? ['If you emit tool blocks, still finish with exactly one tracker JSON block for the current unit.']
      : []),
    ...(params.requiresToolEvidence
      ? [
        'This unit requires real tool evidence before COMPLETE can be accepted.',
        'Do not return COMPLETE unless this unit has produced at least one real machine-readable tool action in its execution path.',
        'If the required evidence comes from read/search/list/run verification tools, do not finalize the explicit output in the same turn as the verification tool call.',
        'For verification-style tool evidence, emit the tool JSON first, end with a non-COMPLETE tracker if needed, and wait for the follow-up turn to summarize the actual tool result.'
      ]
      : []),
    'If any tool invocation is PLANNED or WAITING_APPROVAL, do not return only a tracker.',
    'Only use EARLY_TERMINATE when all required work is already complete and no downstream unit still needs to run.',
    'Never claim files_created unless they come from actual tool results.',
    'Treat successful tool results and validated outputs as authoritative facts. Treat plans, examples, requested paths, and prior prose as unconfirmed until verified by tool evidence.',
    'Before importing, referencing, or claiming a local file/API that was not just confirmed by successful tool evidence, use inspect_file/read_file/list_files/search_files or a real compile/test/run command to verify it.',
    ...correctionLines,
    ...providerGuidanceLines
  ];
}

function shouldRenderExplicitOutputExample(
  pendingCorrection: TaskRuntimeState['pendingCorrection'],
  requiresExplicitOutputAfterToolAction = false
): boolean {
  return pendingCorrection !== 'AWAITING_TRACKER'
    && (pendingCorrection !== 'AWAITING_TOOL_ACTION' || requiresExplicitOutputAfterToolAction);
}

function shouldRenderGenericToolGuidance(pendingCorrection: TaskRuntimeState['pendingCorrection']): boolean {
  return pendingCorrection !== 'AWAITING_TRACKER' && pendingCorrection !== 'AWAITING_OUTPUT_CORRECTION';
}

function filterProviderGuidanceLines(params: {
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
  guidanceLines: string[];
}): string[] {
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    return params.guidanceLines.filter((line) => !/tool|explicit output|tracker json/i.test(line));
  }
  if (params.pendingCorrection === 'AWAITING_TOOL_ACTION') {
    return params.guidanceLines.filter((line) => !/explicit output.*tool|tool calls?.*tracker|response ordered|return explicit output first|keep explicit output, tool calls, and tracker as separate machine-readable blocks/i.test(line));
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return params.guidanceLines.filter((line) => !/tool calls?|any needed tool blocks|response ordered|explicit output, any needed tool blocks/i.test(line));
  }
  return params.guidanceLines;
}

function buildTrackerExample(params: {
  currentUnitId: string;
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
}): string {
  if (params.pendingCorrection === 'AWAITING_TOOL_ACTION') {
    return `{"current_unit":"${params.currentUnitId}","status":"IN_PROGRESS","progress_percent":60,"decision":"CONTINUE","reason":"Required tool action is still pending; the next turn must continue with real tool evidence.","next_unit":null,"files_created":[]}`;
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return `{"current_unit":"${params.currentUnitId}","status":"IN_PROGRESS","progress_percent":60,"decision":"CONTINUE","reason":"The explicit output still needs correction before the unit can finish.","next_unit":null,"files_created":[]}`;
  }
  return `{"current_unit":"${params.currentUnitId}","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"brief reason","next_unit":null,"files_created":[]}`;
}

function correctionStillNeedsExplicitOutput(params: {
  acceptanceIssueMessages: string[];
  invalidOutputErrors: string[];
}): boolean {
  const combined = [...params.acceptanceIssueMessages, ...params.invalidOutputErrors].join(' | ');
  return /missing[_ ]explicit[_ ]output/i.test(combined);
}

function buildResponseOrderLines(params: {
  currentUnitId: string;
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
  correctionPromptMode: CorrectionPromptMode;
  requiresExplicitOutputAfterToolAction?: boolean;
}): string[] {
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    return [
      'This correction is tracker-only.',
      `Return exactly one valid tracker JSON block for ${params.currentUnitId}.`,
      'Do not repeat explicit output, do not emit tool blocks, and do not add explanatory prose.'
    ];
  }
  if (params.pendingCorrection === 'AWAITING_TOOL_ACTION') {
    if (params.requiresExplicitOutputAfterToolAction) {
      return [
        'This correction is tool-action-first and still requires a valid explicit output.',
        'Emit the required machine-readable tool block(s) first.',
        `After the tool block(s), return exactly one explicit output block for ${params.currentUnitId}.`,
        `Finish with exactly one valid tracker JSON block for ${params.currentUnitId}.`,
        'Do not close the unit with tracker-only text before both the required tool action and explicit output are emitted.'
      ];
    }
    return [
      'This correction is tool-action-first.',
      'Emit the required machine-readable tool block(s) first.',
      `After the tool block(s), finish with exactly one valid tracker JSON block for ${params.currentUnitId}.`,
      'Do not close the unit with tracker-only text before the required tool action is emitted.'
    ];
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return [
      'This correction is explicit-output-first.',
      `Return exactly one corrected explicit output block for ${params.currentUnitId}, then exactly one valid tracker JSON block.`,
      'Do not emit tool blocks unless the current correction explicitly requires a new tool action.'
    ];
  }
  return [
    'Return explicit output first, then any needed tool blocks, and finish with exactly one valid tracker JSON.'
  ];
}

function buildCorrectionFocusSection(params: {
  currentUnitId: string;
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
  correctionPromptMode: CorrectionPromptMode;
  acceptanceFailureCategory: AcceptanceFailureCategory | null;
  acceptanceIssueMessages: string[];
  invalidOutputErrors: string[];
  pendingApprovals: number;
  outputKeys: string[];
}): string[] {
  const lines = [
    'CORRECTION_FOCUS',
    `Correction mode: ${params.correctionPromptMode}`,
    `Pending correction kind: ${params.pendingCorrection}`,
    `Last acceptance failure: ${params.acceptanceFailureCategory ?? 'none'}`
  ];
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    lines.push('Your previous turn already supplied a valid explicit output. Return one valid tracker JSON block for the current unit.');
    lines.push('Do not repeat the explicit output unless you are intentionally replacing it.');
    lines.push('Do not emit any new tool blocks in this correction. Return only the tracker JSON block.');
    if (params.acceptanceIssueMessages.length > 0) {
      lines.push(`Current correction issue: ${params.acceptanceIssueMessages.join(' | ')}`);
    }
    return lines;
  }
  if (params.pendingCorrection === 'AWAITING_TOOL_ACTION') {
    lines.push('This turn is blocked on missing required tool action or approval-backed execution, not on prose-only correction.');
    lines.push('If this unit has not produced the required real tool action yet, start with the machine-readable tool block that directly addresses the missing artifact or verification evidence.');
    if (correctionStillNeedsExplicitOutput({
      acceptanceIssueMessages: params.acceptanceIssueMessages,
      invalidOutputErrors: params.invalidOutputErrors
    })) {
      lines.push(`This correction still lacks a valid explicit output block for ${params.currentUnitId}.`);
      lines.push(`After the tool block, emit exactly one explicit output block for ${params.currentUnitId}, then exactly one final tracker JSON block.`);
      if (params.outputKeys.length > 0) {
        lines.push(`That explicit output must satisfy these keys: ${params.outputKeys.join(', ')}.`);
      }
    } else {
      lines.push('After the tool block, emit exactly one final tracker JSON block for the current unit.');
    }
    lines.push('Do not try to close the unit with prose alone. Return COMPLETE only after the tool evidence for this unit is real.');
    if (params.acceptanceFailureCategory === 'artifact_write_required_but_not_emitted') {
      lines.push('This correction requires persistent write evidence for the declared artifact path, not a read-only inspection step.');
      lines.push('Use a real write-capable tool action such as write_file, create_folder plus write_file, or artifact apply for the declared artifact path.');
      lines.push('Do not substitute list_files, read_file, or search_files for the missing write evidence.');
      lines.push('A create_folder-only step does not satisfy this correction when the missing deliverable is a file artifact.');
      lines.push('If you inspect with read_file first, that same response must still include the required write_file block(s). Do not spend another turn on read-only inspection.');
    }
    if (params.acceptanceIssueMessages.length > 0) {
      lines.push(`Current missing execution evidence: ${params.acceptanceIssueMessages.join(' | ')}`);
    }
    if (params.pendingApprovals > 0) {
      lines.push(`Pending approvals currently visible: ${params.pendingApprovals}. Do not pretend the tool already ran.`);
    }
    return lines;
  }
  if (params.pendingCorrection === 'AWAITING_BLOCKER_EXPLANATION') {
    lines.push('Do not continue ambiguously. Explain the blocker clearly and end with a tracker that marks the blocker state truthfully.');
    return lines;
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    lines.push(`Start with exactly one corrected explicit output block for ${params.currentUnitId}, then emit one valid tracker JSON block.`);
    lines.push('Do not respond with tool blocks alone. Tool blocks do not satisfy an output-correction request.');
    lines.push('Assume prior accepted tool evidence remains valid unless this correction explicitly re-opens tool action requirements.');
    lines.push('If your previous turn already executed the needed tools, do not re-run them here. Only repair the explicit output and tracker.');
    lines.push('For this correction, do not emit any new tool blocks unless the system explicitly says the required tool evidence is still missing.');
    lines.push('Do not add Markdown fences, bullet lists, or explanatory prose before the corrected explicit output block.');
    if (params.acceptanceIssueMessages.length > 0) {
      lines.push(`Current correction issue: ${params.acceptanceIssueMessages.join(' | ')}`);
    }
    if (params.outputKeys.length > 0) {
      lines.push(`Required output keys: ${params.outputKeys.join(', ')}.`);
    }
    if (params.invalidOutputErrors.length > 0) {
      lines.push(`Current output errors: ${params.invalidOutputErrors.join(' | ')}`);
    }
    return lines;
  }
    lines.push('Follow the full protocol: explicit output first, then any needed tool blocks, then one final tracker.');
    return lines;
  }

export function buildValidatedOutputsSection(params: {
  records: ValidatedOutputRecord[];
  retrievalSummary?: RetrievalSelectionSummaryState | null;
  maxItems: number;
  charLimit: number;
  compressionPolicy?: ContextCompressionPolicyResult;
}): {
  lines: string[];
  truncatedCount: number;
} {
  const preservedUnitIds = new Set(params.compressionPolicy?.preservedValidatedOutputUnitIds ?? []);
  const preservedRecords = params.records.filter((record) => preservedUnitIds.has(record.unitId));
  const summarizedRecords = params.records.filter((record) => !preservedUnitIds.has(record.unitId));
  const summary = summarizePromptList({
    items: summarizedRecords,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No prior validated outputs are available.',
    render: (record) => `- ${record.unitId}: ${summarizeValidatedOutputRecord(record.parsed, params.charLimit)}`
  });
  const preservedCharLimit = Math.max(160, Math.floor(params.charLimit * 1.5));
  return {
    lines: [
      'VALIDATED_OUTPUTS',
      ...(params.retrievalSummary
        ? [
          `Selection status: visible=${params.retrievalSummary.visibleRecordCount}, retained=${params.retrievalSummary.retainedRecordCount}, omitted=${params.retrievalSummary.filteredOutCount}, raw=${params.retrievalSummary.rawRecordCount}, compact=${params.retrievalSummary.summarizedRecordCount}.`,
          `Retrieval notes: ${params.retrievalSummary.reasons.join(', ')}.`
        ]
        : ['Selection status: only records selected for the current provider-facing context are shown below.']),
      ...(preservedRecords.length > 0
        ? [
          'Preserved raw validated outputs:',
          ...preservedRecords.map((record) => `- ${record.unitId}: ${summarizePreservedValidatedOutputRecord(record.parsed, preservedCharLimit)}`),
          ''
        ]
        : []),
      summary.text
    ],
    truncatedCount: summary.truncatedCount
  };
}

function summarizeStringField(value: string, charLimit: number): string {
  if (value.length <= charLimit) {
    return JSON.stringify(value);
  }
  const truncated = value.slice(0, Math.max(0, charLimit - 3));
  return `${JSON.stringify(`${truncated}...`)} (len=${value.length})`;
}

function summarizeRecordValue(value: unknown, charLimit: number): string {
  if (typeof value === 'string') {
    return summarizeStringField(value, charLimit);
  }
  return summarizeStructuredValue(value, charLimit);
}

function summarizeValidatedOutputRecordFields(record: Record<string, unknown>, params: {
  summaryLimit: number;
  reportLimit: number;
  artifactLimit: number;
  extraValueLimit: number;
  compact: boolean;
}): string[] {
  const parts: string[] = [];
  if (typeof record.summary === 'string') {
    parts.push(`summary=${summarizeStringField(record.summary, params.summaryLimit)}`);
  }
  if (typeof record.report === 'string') {
    parts.push(`report=${summarizeStringField(record.report, params.reportLimit)}`);
  }
  if (typeof record.artifact === 'string') {
    parts.push(`artifact=${summarizeStringField(record.artifact, params.artifactLimit)}`);
  }
  if (Array.isArray(record.issues)) {
    parts.push(params.compact ? `issues=${record.issues.length}` : `issuesCount=${record.issues.length}`);
  }
  const extraKeys = Object.keys(record).filter((key) => !['summary', 'report', 'artifact', 'issues'].includes(key));
  for (const key of extraKeys) {
    const rendered = summarizeRecordValue(record[key], params.extraValueLimit);
    parts.push(params.compact ? `${key}=${rendered}` : `${key}: ${rendered}`);
  }
  return parts;
}

function summarizeValidatedOutputRecord(parsed: unknown, charLimit: number): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return summarizeStructuredValue(parsed, charLimit);
  }
  const record = parsed as Record<string, unknown>;
  const parts = summarizeValidatedOutputRecordFields(record, {
    summaryLimit: Math.max(28, Math.floor(charLimit * 0.18)),
    reportLimit: Math.max(28, Math.floor(charLimit * 0.18)),
    artifactLimit: Math.max(20, Math.floor(charLimit * 0.1)),
    extraValueLimit: Math.max(20, Math.floor(charLimit * 0.08)),
    compact: true
  });
  if (parts.length === 0) {
    return summarizeStructuredValue(parsed, charLimit);
  }
  return parts.join('; ');
}

function summarizePreservedValidatedOutputRecord(parsed: unknown, charLimit: number): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return summarizeStructuredValue(parsed, charLimit);
  }
  const record = parsed as Record<string, unknown>;
  const parts = summarizeValidatedOutputRecordFields(record, {
    summaryLimit: Math.max(64, Math.floor(charLimit * 0.4)),
    reportLimit: Math.max(64, Math.floor(charLimit * 0.35)),
    artifactLimit: Math.max(32, Math.floor(charLimit * 0.15)),
    extraValueLimit: Math.max(24, Math.floor(charLimit * 0.12)),
    compact: false
  });
  if (parts.length === 0) {
    return summarizeStructuredValue(parsed, charLimit);
  }
  return `{ ${parts.join(', ')} }`;
}

export function buildToolApprovalSection(params: {
  permissionMode: string;
  pendingInvocations: ToolInvocationRecord[];
  pendingApprovals: ToolApprovalRecord[];
  maxItems: number;
  charLimit: number;
}): {
  lines: string[];
  truncatedCount: number;
} {
  const invocationSummary = summarizePromptList({
    items: params.pendingInvocations,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No pending tool invocations.',
    render: (record) => `- ${record.invocationId}: ${record.toolId} (${record.status})`
  });
  const approvalSummary = summarizePromptList({
    items: params.pendingApprovals,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No pending approvals.',
    render: (record) => `- ${record.approvalId}: ${record.toolId} (${record.status})`
  });
  return {
    lines: [
      'TOOL_AND_APPROVAL_POLICY',
      `Tool permission mode: ${params.permissionMode}`,
      'Respect permission mode exactly: full means allowed, ask means approval required for gated actions, read-only forbids write/network side effects.',
      '',
      'PENDING_TOOL_INVOCATIONS',
      invocationSummary.text,
      '',
      'PENDING_APPROVALS',
      approvalSummary.text
    ],
    truncatedCount: invocationSummary.truncatedCount + approvalSummary.truncatedCount
  };
}

export function buildExtensionCapabilitySection(params: {
  capabilities: PromptExtensionCapabilitySummary;
  maxItems: number;
  charLimit: number;
  selectionSummary?: CapabilitySelectionSummaryState;
}): {
  lines: string[];
  displayedCount: number;
  truncatedCount: number;
} {
  const tools = summarizePromptList({
    items: params.capabilities.tools,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No tool executors are currently available.',
    render: (tool) => `- tool ${tool.name}: ${tool.effect}/${tool.riskLevel}${tool.supportsApprovalResume ? ', resumable approval' : ''}`
  });
  const skills = summarizePromptList({
    items: params.capabilities.skills,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No skill runtimes are currently available.',
    render: (skill) => skill.instructionOnly
      ? `- skill ${skill.name} [instruction-only]: non-executable bundle injected as task guidance`
      : `- skill ${skill.name}${skill.kind ? ` [${skill.kind}]` : ''}: stream=${skill.supportsStreaming}, write=${skill.supportsWorkspaceWrite}, network=${skill.supportsNetworkAccess}`
  });
  const mcp = summarizePromptList({
    items: params.capabilities.mcpServers,
    maxItems: params.maxItems,
    charLimit: params.charLimit,
    emptyText: 'No MCP servers are currently available.',
    render: (server) => `- mcp ${server.name}: ${server.transport}, tools=${server.supportsTools}, prompts=${server.supportsPrompts}, resources=${server.supportsResources}`
  });
  return {
    lines: [
      'EXTENSION_CAPABILITIES',
      ...(params.selectionSummary
        ? [
          `Selection mode: ${params.selectionSummary.mode}; tools=${params.selectionSummary.toolCount}, skills=${params.selectionSummary.skillCount}, mcp=${params.selectionSummary.mcpCount}.`,
          `Capability notes: ${params.selectionSummary.reasons.join(', ')}.`
        ]
        : ['Selection mode: full capability snapshot included.']),
      tools.text,
      '',
      ...(params.selectionSummary && params.selectionSummary.omittedToolCount > 0
        ? [`Additional tools omitted from prompt body: ${params.selectionSummary.omittedToolCount} tool(s) available.`]
        : []),
      ...(params.selectionSummary && params.selectionSummary.omittedToolCount > 0 ? [''] : []),
      ...(params.selectionSummary && params.selectionSummary.omittedSkillCount > 0
        ? [`Skills omitted from prompt body for current stage: ${params.selectionSummary.omittedSkillCount} runtime(s) available.`]
        : [skills.text]),
      '',
      ...(params.selectionSummary && params.selectionSummary.omittedMcpCount > 0
        ? [`MCP servers omitted from prompt body for current stage: ${params.selectionSummary.omittedMcpCount} server(s) available.`]
        : [mcp.text])
    ],
    displayedCount: tools.displayedCount + skills.displayedCount + mcp.displayedCount,
    truncatedCount: tools.truncatedCount + skills.truncatedCount + mcp.truncatedCount
  };
}
