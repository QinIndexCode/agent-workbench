import {
  TaskDefinition,
  TaskLifecycleStatus,
  TaskRuntimeState,
  requiresToolEvidenceForExecutionProfile
} from '../../domain/contracts/types';
import { applyTrackerState, createTaskRuntimeState } from '../../domain/runtime/state-transition-applier';
import { canEarlyTerminateCurrentUnit } from '../../domain/runtime/execution-plan';
import { parseTurn } from '../../domain/parser/unit-output-parser';
import { acceptParsedTurn } from '../../domain/validation';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import {
  OperatorCommandRecord,
  TaskMetadataRecord,
  TaskRuntimeRecord,
  ToolApprovalRecord,
  ToolInvocationRecord,
  ValidatedOutputRecord
} from '../../foundation/repository/types';
import { ConversationMessageRecord } from '../../foundation/conversation/types';
import { collectInvocationEvidencePaths, deriveTaskArtifactRoutingSummary } from './artifact-routing';
import {
  buildDelegationEligibility,
  extractDelegationMetadata,
  hasMissingRequiredDelegation,
  getActiveDelegatedChildrenForParent,
  getDelegatedChildrenForParent,
  isDelegatedChildDefinition,
  isDelegationRequiredForUnit
} from './delegation/delegation';
import {
  TaskDelegatedChildSummary,
  TaskDelegationSummary,
  TaskCompletionSummary,
  TaskNextActionSummary,
  TaskPendingApprovalItem,
  TaskPrimaryActionSummary,
  TaskQueryResponse,
  TaskStatusSummary,
  TaskSummaryResponse,
  TaskVisibleOutputSummary,
  TaskVisibleToolActivity
} from './types';
import { ImprovementService } from '../platform/improvement-service';
import { ImprovementProposal, RealTaskArchiveStatus } from '../platform/types';
import { shouldMarkInvocationAsVerification } from './tools/tool-verification';

const TERMINAL_TASK_LIFECYCLE_STATUSES = new Set<TaskLifecycleStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isWriteEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'create_folder' || normalized === 'run_command';
}

function isPersistentWriteEvidenceInvocation(invocation: ToolInvocationRecord): boolean {
  const normalized = normalizeToolId(invocation.toolId);
  if (normalized === 'write_file') {
    return true;
  }
  if (normalized !== 'run_command') {
    return false;
  }
  return collectInvocationEvidencePaths(invocation).length > 0;
}

function buildAcceptanceCorrectionContext(
  runtime: TaskRuntimeState,
  unitId: string,
  validatedOutputs: ValidatedOutputRecord[]
) {
  if (runtime.pendingCorrection !== 'AWAITING_TRACKER' && runtime.pendingCorrection !== 'AWAITING_TOOL_ACTION') {
    return undefined;
  }
  const latestValidatedOutput = validatedOutputs
    .filter((record) => record.unitId === unitId)
    .at(-1);
  if (!latestValidatedOutput) {
    return undefined;
  }
  return {
    pendingCorrection: runtime.pendingCorrection,
    priorAcceptedOutput: {
      unitId,
      wrapper: latestValidatedOutput.wrapper,
      raw: latestValidatedOutput.raw,
      parsedJson: latestValidatedOutput.parsed
    },
    priorContractKeys: [...latestValidatedOutput.contractKeys]
  };
}

function buildUnitToolEvidenceSummary(params: {
  invocations: ToolInvocationRecord[];
  unitId: string;
}): {
  toolEvidenceCount: number;
  verificationEvidenceCount: number;
  writeEvidencePaths: string[];
} {
  let toolEvidenceCount = 0;
  let verificationEvidenceCount = 0;
  const writeEvidencePaths = new Set<string>();

  for (const invocation of params.invocations) {
    if (invocation.unitId !== params.unitId) {
      continue;
    }
    if (invocation.status !== 'SUCCEEDED' && invocation.status !== 'FAILED') {
      continue;
    }
    toolEvidenceCount += 1;
    if (invocation.status === 'SUCCEEDED' && shouldMarkInvocationAsVerification({
      toolName: invocation.toolId,
      argumentsRecord: invocation.arguments
    })) {
      verificationEvidenceCount += 1;
    }
    if (invocation.status === 'SUCCEEDED' && isWriteEvidenceTool(invocation.toolId)) {
      for (const evidencePath of collectInvocationEvidencePaths(invocation)) {
        writeEvidencePaths.add(evidencePath);
      }
    }
  }

  return {
    toolEvidenceCount,
    verificationEvidenceCount,
    writeEvidencePaths: [...writeEvidencePaths]
  };
}

function isPendingApprovalForInvocation(
  invocation: ToolInvocationRecord,
  approvalsByInvocationId: Map<string, ToolApprovalRecord>
): boolean {
  if (invocation.status !== 'WAITING_APPROVAL') {
    return false;
  }
  const approval = approvalsByInvocationId.get(invocation.invocationId);
  return !approval || approval.status === 'PENDING';
}

function normalizeIssueList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function normalizeArtifactPaths(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[\r\n,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function findFirstStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function truncateText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function textLooksPreDelivery(value: string | null | undefined): boolean {
  const normalized = normalizeComparableText(value);
  if (!normalized) {
    return false;
  }
  return /(ready|needs? a destination|operator destination|waiting for a destination|ready for delivery|awaiting delivery|pending delivery|before delivery)/i.test(normalized);
}

function textLooksDelivered(value: string | null | undefined): boolean {
  const normalized = normalizeComparableText(value);
  if (!normalized) {
    return false;
  }
  if (textLooksPreDelivery(normalized)) {
    return false;
  }
  return /\b(delivered|applied|available in|shipped|copied to)\b/i.test(normalized);
}

function promoteAppliedDeliverySummary(output: TaskVisibleOutputSummary): TaskVisibleOutputSummary {
  if (output.artifactApplyStatus !== 'APPLIED' || output.artifactDestinationPaths.length === 0) {
    return output;
  }

  const combinedText = normalizeComparableText(`${output.summary} ${output.details ?? ''}`);
  const destinationMentions = [
    output.artifactDestinationDir,
    ...output.artifactDestinationPaths
  ]
    .map((value) => normalizeComparableText(value))
    .filter(Boolean);

  const alreadyMentionsDestination = destinationMentions.some((value) => combinedText.includes(value));
  const stillReadsAsPreApply = textLooksPreDelivery(`${output.summary} ${output.details ?? ''}`);

  if (alreadyMentionsDestination && !stillReadsAsPreApply && textLooksDelivered(`${output.summary} ${output.details ?? ''}`)) {
    return output;
  }

  const artifactLabel = output.artifactPaths.length === 1
    ? output.artifactPaths[0]
    : output.artifactPaths.length > 1
      ? `${output.artifactPaths.length} artifacts`
      : 'artifact output';
  const deliveredLabel = output.artifactDestinationPaths.length === 1
    ? output.artifactDestinationPaths[0]
    : `${output.artifactDestinationPaths[0]} +${output.artifactDestinationPaths.length - 1} more`;
  const deliveredDir = output.artifactDestinationDir ?? deliveredLabel;

  return {
    ...output,
    summary: `Delivered ${artifactLabel} to ${deliveredLabel}.`,
    details: `Artifacts were applied to ${deliveredDir}.`
  };
}

function looksLikeMachineReadableProtocol(content: string): boolean {
  return /\[[A-Z0-9_-]+_OUTPUT\]/.test(content)
    || /"current_unit"\s*:/.test(content)
    || /"tool_name"\s*:/.test(content)
    || /"files_created"\s*:/.test(content)
    || /Do not wrap the explicit output block/i.test(content)
    || /Use this exact explicit output wrapper pattern/i.test(content);
}

function buildVisibleOutputFromValidatedRecord(params: {
  record: ValidatedOutputRecord;
  fallbackArtifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskVisibleOutputSummary['artifactApplyStatus'];
}): TaskVisibleOutputSummary {
  const parsedRecord = isRecord(params.record.parsed) ? params.record.parsed : {};
  const parsedArtifactPaths = [
    ...normalizeArtifactPaths(parsedRecord.artifact),
    ...normalizeArtifactPaths(parsedRecord.artifacts),
    ...normalizeArtifactPaths(parsedRecord.files),
    ...normalizeArtifactPaths(parsedRecord.files_created),
    ...normalizeArtifactPaths(parsedRecord.producedFiles),
    ...normalizeArtifactPaths(parsedRecord.produced_files)
  ];
  const declaredArtifactDestination = findFirstStringField(parsedRecord, [
    'artifactDestination',
    'artifact_destination',
    'destinationDir',
    'destination',
    'artifactDestinationDir'
  ]);
  return promoteAppliedDeliverySummary({
    source: 'validated_output',
    unitId: params.record.unitId,
    validatedAt: params.record.validatedAt,
    summary: findFirstStringField(parsedRecord, ['summary', 'title', 'headline']) ?? truncateText(params.record.raw),
    details: findFirstStringField(parsedRecord, ['details', 'report', 'body', 'content', 'notes']),
    issues: normalizeIssueList(parsedRecord.issues),
    artifactPaths: parsedArtifactPaths.length > 0 ? parsedArtifactPaths : params.fallbackArtifactPaths,
    artifactDestinationPaths: params.artifactDestinationPaths,
    artifactDestinationDir: params.artifactDestinationDir ?? declaredArtifactDestination,
    artifactApplyStatus: params.artifactApplyStatus
  });
}

function buildVisibleOutputFromAssistantFallback(params: {
  message: ConversationMessageRecord;
  fallbackArtifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskVisibleOutputSummary['artifactApplyStatus'];
}): TaskVisibleOutputSummary {
  const normalized = params.message.content.trim();
  return promoteAppliedDeliverySummary({
    source: 'assistant_fallback',
    unitId: typeof params.message.metadata?.unitId === 'string' ? params.message.metadata.unitId : null,
    validatedAt: params.message.createdAt,
    summary: truncateText(normalized, 140),
    details: normalized,
    issues: [],
    artifactPaths: params.fallbackArtifactPaths,
    artifactDestinationPaths: params.artifactDestinationPaths,
    artifactDestinationDir: params.artifactDestinationDir,
    artifactApplyStatus: params.artifactApplyStatus
  });
}

function buildVisibleOutputFromFailureFallback(params: {
  runtime: TaskRuntimeState;
  providerFailureMessage: string | null;
  fallbackArtifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: TaskVisibleOutputSummary['artifactApplyStatus'];
}): TaskVisibleOutputSummary | null {
  if (params.runtime.lifecycleStatus !== 'FAILED') {
    return null;
  }

  const failureMessage = params.providerFailureMessage?.trim()
    || params.runtime.lastError?.trim()
    || 'The runtime stopped because the latest provider turn failed.';
  const artifactPaths = params.fallbackArtifactPaths;
  const artifactDestinationPaths = params.artifactDestinationPaths;

  const summary = artifactDestinationPaths.length > 0
    ? `Task failed after delivering ${summarizePathList(artifactPaths)} to ${summarizePathList(artifactDestinationPaths)}.`
    : artifactPaths.length > 0
      ? `Task failed after generating ${summarizePathList(artifactPaths)}.`
      : 'Task failed before producing a final result.';
  const details = params.artifactApplyStatus === 'APPLIED' && params.artifactDestinationDir
    ? `Artifacts already delivered remain available in ${params.artifactDestinationDir}. ${failureMessage}`
    : artifactPaths.length > 0
      ? `Generated artifacts remain available in the task workspace. ${failureMessage}`
      : failureMessage;

  return {
    source: 'failure_fallback',
    unitId: params.runtime.currentUnitId,
    validatedAt: params.runtime.updatedAt ?? null,
    summary,
    details,
    issues: [],
    artifactPaths,
    artifactDestinationPaths,
    artifactDestinationDir: params.artifactDestinationDir,
    artifactApplyStatus: params.artifactApplyStatus
  };
}

function isUserVisibleConversation(message: ConversationMessageRecord): boolean {
  if (message.visibility !== 'public') {
    return false;
  }
  if (message.role === 'system' || message.role === 'tool') {
    return false;
  }
  if (message.role === 'runtime') {
    return false;
  }
  if (message.role === 'assistant' && looksLikeMachineReadableProtocol(message.content)) {
    return false;
  }
  return true;
}

function summarizePathList(paths: string[]): string {
  if (paths.length === 0) {
    return 'the generated artifact';
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return `${paths[0]} +${paths.length - 1} more`;
}

function getTaskArchiveState(metadataRecord: TaskMetadataRecord | null): {
  isArchived: boolean;
  archivedAt: number | null;
} {
  const metadata = isRecord(metadataRecord?.metadata) ? metadataRecord.metadata : {};
  return {
    isArchived: metadata.taskArchived === true,
    archivedAt: typeof metadata.taskArchivedAt === 'number' ? metadata.taskArchivedAt : null
  };
}

function getTaskArchiveCapabilities(
  lifecycleStatus: TaskLifecycleStatus,
  isArchived: boolean
): {
  canArchive: boolean;
  canDelete: boolean;
} {
  const isTerminal = TERMINAL_TASK_LIFECYCLE_STATUSES.has(lifecycleStatus);
  return {
    canArchive: isTerminal && !isArchived,
    canDelete: isTerminal
  };
}

function truncateSerializedValue(value: unknown, maxLength = 140): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return truncateText(value, maxLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return truncateText(JSON.stringify(value), maxLength);
  } catch {
    return null;
  }
}

function summarizeInvocationArguments(invocation: ToolInvocationRecord): string | null {
  const args = isRecord(invocation.arguments) ? invocation.arguments : {};
  const pathLike = findFirstStringField(args, ['path', 'file', 'file_path', 'output']);
  if (pathLike) {
    return pathLike;
  }
  const commandLike = findFirstStringField(args, ['command', 'url', 'query', 'resource']);
  if (commandLike) {
    return truncateText(commandLike, 120);
  }
  const scalarEntries = Object.entries(args)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  if (scalarEntries.length > 0) {
    return truncateText(scalarEntries.join(', '), 120);
  }
  return truncateSerializedValue(args, 120);
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function readNumberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBooleanField(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function mergeInvocationResultAndMetadata(invocation: ToolInvocationRecord): Record<string, unknown> {
  const result = isRecord(invocation.result) ? invocation.result : {};
  const metadata = isRecord(invocation.metadata) ? invocation.metadata : {};
  return { ...metadata, ...result };
}

function buildCommandExecutionSummary(
  invocation: ToolInvocationRecord
): TaskVisibleToolActivity['execution'] {
  if (invocation.toolId.trim().toLowerCase() !== 'run_command') {
    return null;
  }
  const record = mergeInvocationResultAndMetadata(invocation);
  return {
    command: readStringField(record, ['requestedCommand', 'originalCommand', 'command']) ?? readStringField(invocation.arguments, ['command', 'cmd']),
    effectiveCommand: readStringField(record, ['effectiveCommand', 'command']) ?? readStringField(invocation.arguments, ['command', 'cmd']),
    cwd: readStringField(record, ['cwd']),
    exitCode: readNumberField(record, ['exitCode']),
    stdout: readStringField(record, ['stdout']) ?? '',
    stderr: readStringField(record, ['stderr']) ?? '',
    durationMs: readNumberField(record, ['durationMs']),
    timedOut: readBooleanField(record, ['timedOut']),
    shell: readStringField(record, ['shell'])
  };
}

function summarizeInvocationResult(invocation: ToolInvocationRecord): string | null {
  if (invocation.toolId.trim().toLowerCase() === 'run_command') {
    const execution = buildCommandExecutionSummary(invocation);
    const exitCode = execution?.exitCode === undefined || execution?.exitCode === null ? 'unknown' : String(execution.exitCode);
    const stderr = execution?.stderr.trim() ?? '';
    const stdout = execution?.stdout.trim() ?? '';
    const output = stderr || stdout;
    if (invocation.status === 'SUCCEEDED') {
      return truncateText(
        output
          ? `Command exited ${exitCode}: ${output}`
          : `Command exited ${exitCode}.`,
        140
      );
    }
    return truncateText(
      output
        ? `Command failed with exit code ${exitCode}: ${output}`
        : (invocation.error ?? `Command failed with exit code ${exitCode}.`),
      140
    );
  }
  const outputRecord = isRecord(invocation.result?.output) ? invocation.result.output : null;
  const candidates = [
    invocation.error,
    findFirstStringField(invocation.result ?? {}, ['message', 'summary', 'detail', 'path', 'file']),
    outputRecord ? findFirstStringField(outputRecord, ['message', 'summary', 'detail', 'path', 'file']) : null
  ].filter((value): value is string => Boolean(value));
  if (candidates.length > 0) {
    return truncateText(candidates[0], 140);
  }
  return truncateSerializedValue(invocation.result, 140);
}

function shouldSurfaceSucceededTool(invocation: ToolInvocationRecord, evidencePaths: string[], resultSummary: string | null): boolean {
  if (evidencePaths.length > 0) {
    return true;
  }
  const normalizedToolId = invocation.toolId.trim().toLowerCase();
  if (['write_file', 'create_folder', 'run_command'].includes(normalizedToolId)) {
    return true;
  }
  if (normalizedToolId === 'read_file') {
    return true;
  }
  if (['list_files', 'search_files'].includes(normalizedToolId)) {
    return true;
  }
  return Boolean(resultSummary);
}

function buildVisibleToolActivitySummary(params: {
  invocation: ToolInvocationRecord;
  approvalStatus: ToolApprovalRecord['status'] | null;
  evidencePaths: string[];
  argumentsSummary: string | null;
  resultSummary: string | null;
}): { summary: string; detail: string | null } | null {
  const { invocation, approvalStatus, evidencePaths, argumentsSummary, resultSummary } = params;
  const toolLabel = invocation.toolId.replaceAll('_', ' ');

  if (invocation.status === 'WAITING_APPROVAL' || approvalStatus === 'PENDING') {
    return {
      summary: `${toolLabel} is waiting for approval.`,
      detail: argumentsSummary ? `Pending arguments: ${argumentsSummary}` : 'Review the pending tool call and decide whether to continue.'
    };
  }
  if (invocation.status === 'RUNNING') {
    return {
      summary: `${toolLabel} is running.`,
      detail: argumentsSummary ? `Using ${argumentsSummary}.` : null
    };
  }
  if (invocation.status === 'FAILED') {
    return {
      summary: `${toolLabel} failed.`,
      detail: resultSummary ?? argumentsSummary ?? 'Inspect the tool result in details.'
    };
  }
  if (invocation.status === 'DENIED') {
    return {
      summary: `${toolLabel} was denied.`,
      detail: argumentsSummary ? `The blocked request targeted ${argumentsSummary}.` : 'The tool request was denied before it could run.'
    };
  }
  if (invocation.status === 'SUCCEEDED' && shouldSurfaceSucceededTool(invocation, evidencePaths, resultSummary)) {
    if (evidencePaths.length > 0) {
      return {
        summary: `${toolLabel} completed and touched ${summarizePathList(evidencePaths)}.`,
        detail: resultSummary && !resultSummary.includes(evidencePaths[0] ?? '') ? resultSummary : null
      };
    }
    return {
      summary: `${toolLabel} completed.`,
      detail: resultSummary ?? argumentsSummary
    };
  }
  return null;
}

function buildVisibleToolActivities(params: {
  invocations: ToolInvocationRecord[];
  approvals: ToolApprovalRecord[];
}): TaskVisibleToolActivity[] {
  const approvalsByInvocationId = new Map(
    params.approvals.map((approval) => [approval.invocationId, approval])
  );

  return params.invocations
    .map((invocation) => {
      const evidencePaths = [...new Set(collectInvocationEvidencePaths(invocation))];
      const approvalStatus = approvalsByInvocationId.get(invocation.invocationId)?.status ?? null;
      const argumentsSummary = summarizeInvocationArguments(invocation);
      const resultSummary = summarizeInvocationResult(invocation);
      const summary = buildVisibleToolActivitySummary({
        invocation,
        approvalStatus,
        evidencePaths,
        argumentsSummary,
        resultSummary
      });
      if (!summary) {
        return null;
      }
      return {
        activityId: invocation.invocationId,
        toolId: invocation.toolId,
        status: invocation.status,
        summary: summary.summary,
        detail: summary.detail,
        argumentsSummary,
        resultSummary,
        execution: buildCommandExecutionSummary(invocation),
        evidencePaths,
        approvalStatus,
        startedAt: invocation.startedAt,
        endedAt: invocation.endedAt,
        unitId: invocation.unitId
      } satisfies TaskVisibleToolActivity;
    })
    .filter((activity): activity is TaskVisibleToolActivity => Boolean(activity))
    .sort((left, right) => left.startedAt - right.startedAt);
}

function buildPendingApprovalItems(params: {
  approvals: ToolApprovalRecord[];
  invocations: ToolInvocationRecord[];
}): TaskPendingApprovalItem[] {
  const pendingApprovals = params.approvals
    .filter((approval) => approval.status === 'PENDING')
    .sort((left, right) => left.createdAt - right.createdAt);
  const invocationsById = new Map(
    params.invocations.map((invocation) => [invocation.invocationId, invocation])
  );

  return pendingApprovals.map((approval) => {
    const matchingInvocation = invocationsById.get(approval.invocationId) ?? null;
    return {
      invocationId: approval.invocationId,
      toolId: approval.toolId,
      toolName: matchingInvocation?.toolId ?? approval.toolId,
      requestedAt: approval.createdAt,
      argumentsSummary: matchingInvocation ? summarizeInvocationArguments(matchingInvocation) : null,
      status: approval.status,
      availableActions: ['APPROVED', 'REJECTED']
    };
  });
}

function getArtifactDestinationDir(
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>
): string | null {
  return artifactRouting.lastArtifactApplyResult?.destinationDir
    ?? artifactRouting.selectedArtifactDir
    ?? null;
}

function sanitizeContinueReason(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  if (/no active correction requirement/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function describePendingCorrection(kind: TaskRuntimeState['pendingCorrection']): string | null {
  switch (kind) {
    case 'NONE':
      return null;
    case 'AWAITING_TRACKER':
      return 'The runtime needs a progress tracker update before it can continue.';
    case 'AWAITING_OUTPUT_CORRECTION':
      return 'The runtime needs a corrected response before it can continue.';
    case 'AWAITING_TOOL_ACTION':
      return 'The runtime needs a required tool-side action before it can continue.';
    case 'AWAITING_BLOCKER_EXPLANATION':
      return 'The runtime needs a clearer blocker explanation before it can continue.';
    default:
      return 'The runtime is waiting for a required correction before it can continue.';
  }
}

function buildContinueAvailability(params: {
  runtime: TaskRuntimeState;
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
}): { continueAllowed: boolean; continueReason: string } {
  const diagnostics = params.runtime.contractDiagnostics;
  const correctionLoopNonConvergent = diagnostics?.correctionLoopNonConvergent ?? false;

  if (params.runtime.lifecycleStatus !== 'RUNNING') {
    return {
      continueAllowed: false,
      continueReason: `Task lifecycle is ${params.runtime.lifecycleStatus}, so continue is not allowed.`
    };
  }

  if (correctionLoopNonConvergent) {
    return {
      continueAllowed: false,
      continueReason: 'Repeated identical correction failures indicate a non-convergent loop; explicit operator guidance or restart is required.'
    };
  }

  if (params.artifactRouting.artifactPathState === 'unresolved') {
    return {
      continueAllowed: false,
      continueReason: params.artifactRouting.recommendedArtifactDir
        ? `Select a project-relative destination before continuing. Recommended directory: ${params.artifactRouting.recommendedArtifactDir}.`
        : 'Select a project-relative destination before continuing because generated artifacts are still only in the task workspace.'
    };
  }

  return {
    continueAllowed: true,
    continueReason: describePendingCorrection(params.runtime.pendingCorrection)
      ?? 'Task is running with no active correction requirement.'
  };
}

function buildTaskCompletionSummary(params: {
  runtime: TaskRuntimeState;
  latestVisibleOutput: TaskVisibleOutputSummary | null;
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
}): TaskCompletionSummary | null {
  const continueAvailability = buildContinueAvailability({
    runtime: params.runtime,
    artifactRouting: params.artifactRouting
  });
  const artifactDestinationDir = getArtifactDestinationDir(params.artifactRouting);
  const artifactPaths = params.latestVisibleOutput?.artifactPaths.length
    ? params.latestVisibleOutput.artifactPaths
    : params.artifactRouting.artifactPaths;
  const artifactDestinationPaths = params.latestVisibleOutput?.artifactDestinationPaths.length
    ? params.latestVisibleOutput.artifactDestinationPaths
    : params.artifactRouting.artifactDestinationPaths;
  const artifactApplyStatus = params.latestVisibleOutput?.artifactApplyStatus
    ?? params.artifactRouting.lastArtifactApplyResult?.status
    ?? null;
  const issues = params.latestVisibleOutput?.issues ?? [];

  let summary = params.latestVisibleOutput?.summary ?? null;
  let details = params.latestVisibleOutput?.details ?? null;
  const deliveredSummary = artifactDestinationPaths.length > 0
    ? `Delivered ${summarizePathList(artifactPaths)} to ${summarizePathList(artifactDestinationPaths)}.`
    : null;
  const summaryLooksPreDelivery = textLooksPreDelivery(summary);
  const detailsLookPreDelivery = textLooksPreDelivery(details);
  const failureMessage = params.runtime.lastError?.trim()
    || 'The runtime stopped before completion.';

  if (params.runtime.lifecycleStatus === 'FAILED') {
    summary = artifactDestinationPaths.length > 0
      ? `Task failed after delivering ${summarizePathList(artifactPaths)} to ${summarizePathList(artifactDestinationPaths)}.`
      : artifactPaths.length > 0
        ? `Task failed after generating ${summarizePathList(artifactPaths)}.`
        : 'Task failed before producing a final result.';
    details = artifactApplyStatus === 'APPLIED' && artifactDestinationDir
      ? `Artifacts already delivered remain available in ${artifactDestinationDir}. ${failureMessage}`
      : artifactPaths.length > 0
        ? `Generated artifacts remain available in the task workspace. ${failureMessage}`
        : failureMessage;
  }

  if (
    params.runtime.lifecycleStatus === 'COMPLETED'
    && artifactApplyStatus === 'APPLIED'
    && deliveredSummary
    && (!summary || summaryLooksPreDelivery || !textLooksDelivered(summary))
  ) {
    summary = deliveredSummary;
  }

  if (!summary && params.runtime.lifecycleStatus === 'COMPLETED') {
    if (artifactDestinationPaths.length > 0) {
      summary = `Delivered ${summarizePathList(artifactPaths)} to ${summarizePathList(artifactDestinationPaths)}.`;
    } else if (artifactPaths.length > 0) {
      summary = `Completed with ${summarizePathList(artifactPaths)} ready to review.`;
    } else {
      summary = 'Task completed without a visible summary.';
    }
  }

  if (!details && artifactApplyStatus === 'APPLIED' && artifactDestinationDir) {
    details = `Artifacts are available in ${artifactDestinationDir}.`;
  } else if (
    params.runtime.lifecycleStatus === 'COMPLETED'
    && artifactApplyStatus === 'APPLIED'
    && artifactDestinationDir
    && detailsLookPreDelivery
  ) {
    details = `Artifacts are available in ${artifactDestinationDir}.`;
  } else if (!details && artifactPaths.length > 0 && params.runtime.lifecycleStatus === 'COMPLETED') {
    details = 'The task finished and preserved the generated artifact list for review.';
  }

  if (
    !summary
    && !details
    && issues.length === 0
    && artifactPaths.length === 0
    && artifactDestinationPaths.length === 0
    && !artifactDestinationDir
  ) {
    return null;
  }

  return {
    summary,
    details,
    issues,
    artifactPaths,
    artifactDestinationPaths,
    artifactDestinationDir,
    artifactApplyStatus,
    continueAllowed: params.runtime.lifecycleStatus === 'COMPLETED' || continueAvailability.continueAllowed
  };
}

function buildTaskPrimaryActionSummary(params: {
  runtime: TaskRuntimeState;
  approvals: ToolApprovalRecord[];
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  completionSummary: TaskCompletionSummary | null;
  delegationSummary: TaskDelegationSummary | null;
}): TaskPrimaryActionSummary {
  const continueAvailability = buildContinueAvailability({
    runtime: params.runtime,
    artifactRouting: params.artifactRouting
  });
  if (params.delegationSummary?.activeChildTask) {
    return {
      kind: 'wait',
      label: 'Wait for delegated subtask',
      description: `A delegated child task is still running: ${params.delegationSummary.activeChildTask.title}.`,
      destinationDir: params.completionSummary?.artifactDestinationDir ?? null
    };
  }
  if (params.delegationSummary?.missingRequiredDelegation) {
    return {
      kind: 'continue_thread',
      label: 'Continue current thread',
      description: 'This step must launch a delegated child task before parent delivery can continue.',
      destinationDir: params.completionSummary?.artifactDestinationDir ?? null
    };
  }
  const pendingApprovalCount = params.approvals.filter((approval) => approval.status === 'PENDING').length;
  if (pendingApprovalCount > 0) {
    return {
      kind: 'approve',
      label: pendingApprovalCount === 1 ? 'Approve request' : 'Resolve approvals',
      description: 'Approve or reject the pending tool request to keep this thread moving.',
      destinationDir: null
    };
  }

  if (params.artifactRouting.artifactPathState === 'unresolved') {
    if (params.artifactRouting.recommendedArtifactDir) {
      return {
        kind: 'use_recommended_path',
        label: 'Use recommended path',
        description: `Deliver the artifact to ${params.artifactRouting.recommendedArtifactDir}.`,
        destinationDir: params.artifactRouting.recommendedArtifactDir
      };
    }
    return {
      kind: 'choose_custom_path',
      label: 'Choose custom path',
      description: 'Choose a project-relative destination before the thread can finish.',
      destinationDir: null
    };
  }

  switch (params.runtime.lifecycleStatus) {
    case 'SUBMITTED':
      return {
        kind: 'start_task',
        label: 'Start task',
        description: 'Launch the first turn for this thread.',
        destinationDir: null
      };
    case 'PAUSED':
      return {
        kind: 'resume_task',
        label: 'Resume task',
        description: 'Resume the paused thread from its current state.',
        destinationDir: null
      };
    case 'FAILED':
    case 'CANCELLED':
      return {
        kind: 'restart_task',
        label: 'Restart task',
        description: 'Restart the thread from the current task definition.',
        destinationDir: null
      };
    case 'COMPLETED':
      return {
        kind: 'continue_thread',
        label: 'Continue current thread',
        description: params.completionSummary?.artifactDestinationDir
          ? `Keep working from the delivered result in this thread.`
          : 'Keep working from the latest completed result in this thread.',
        destinationDir: params.completionSummary?.artifactDestinationDir ?? null
      };
    default:
      if (continueAvailability.continueAllowed) {
        return {
          kind: 'continue_thread',
          label: 'Continue current thread',
          description: sanitizeContinueReason(continueAvailability.continueReason)
            ?? 'Send the next message to keep the thread moving.',
          destinationDir: params.completionSummary?.artifactDestinationDir ?? null
        };
      }
      return {
        kind: 'wait',
        label: 'Wait',
        description: 'The runtime is still working through the current step.',
        destinationDir: params.completionSummary?.artifactDestinationDir ?? null
      };
  }
}

function buildTaskNextActionSummary(params: {
  runtime: TaskRuntimeState;
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  primaryAction: TaskPrimaryActionSummary;
  delegationSummary: TaskDelegationSummary | null;
}): TaskNextActionSummary {
  const continueAvailability = buildContinueAvailability({
    runtime: params.runtime,
    artifactRouting: params.artifactRouting
  });
  if (params.delegationSummary?.activeChildTask) {
    return {
      label: 'Wait for delegated subtask',
      reason: `The child task "${params.delegationSummary.activeChildTask.title}" is still running and will return scoped results to this thread.`
    };
  }

  if (params.delegationSummary?.missingRequiredDelegation) {
    return {
      label: 'Continue current thread',
      reason: 'Delegation is required before parent delivery can continue. Send the next message so the runtime can satisfy the child-task contract.'
    };
  }

  if (params.primaryAction.kind === 'approve') {
    return {
      label: 'Approve or reject',
      reason: 'A blocked tool request needs a decision before the thread can move again.'
    };
  }

  if (params.primaryAction.kind === 'use_recommended_path') {
    return {
      label: 'Use recommended path',
      reason: `Artifacts are ready in the task workspace and can be delivered to ${params.primaryAction.destinationDir}.`
    };
  }

  if (params.primaryAction.kind === 'choose_custom_path') {
    return {
      label: 'Choose custom path',
      reason: 'Artifacts are ready in the task workspace and still need a project-relative destination.'
    };
  }

  if (params.primaryAction.kind === 'continue_thread') {
    return {
      label: 'Continue current thread',
      reason: params.runtime.lifecycleStatus === 'COMPLETED'
        ? 'The thread is complete, and the next message will continue work in the same thread.'
        : sanitizeContinueReason(continueAvailability.continueReason)
          ?? 'The runtime is ready for the next operator-guided step.'
    };
  }

  if (params.primaryAction.kind === 'wait') {
    const artifactAppliedAndRunning =
      params.artifactRouting.artifactPathState === 'applied' && params.runtime.lifecycleStatus === 'RUNNING';
    return {
      label: 'Wait',
      reason: artifactAppliedAndRunning
        ? 'Artifacts were delivered and the runtime is still finishing the remaining work.'
        : 'The runtime is still progressing through the current step.'
    };
  }

  return {
    label: params.primaryAction.label,
    reason: params.primaryAction.description
  };
}

function buildTaskStatusSummary(params: {
  runtime: TaskRuntimeState;
  approvals: ToolApprovalRecord[];
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  completionSummary: TaskCompletionSummary | null;
  delegationSummary: TaskDelegationSummary | null;
}): TaskStatusSummary {
  const pendingApprovalCount = params.approvals.filter((approval) => approval.status === 'PENDING').length;
  const correctionReason = describePendingCorrection(params.runtime.pendingCorrection);
  const deliveredTo = params.completionSummary?.artifactDestinationPaths.length
    ? summarizePathList(params.completionSummary.artifactDestinationPaths)
    : params.completionSummary?.artifactDestinationDir ?? null;

  if (params.delegationSummary?.activeChildTask) {
    return {
      label: 'Waiting on delegated subtask',
      detail: `SubSccAgent is handling "${params.delegationSummary.activeChildTask.title}" inside this thread boundary.`,
      tone: 'waiting'
    };
  }

  if (params.delegationSummary?.missingRequiredDelegation) {
    return {
      label: 'Delegation required before parent delivery',
      detail: 'This step must launch a bounded child task before the parent can continue or publish a result.',
      tone: 'blocked'
    };
  }

  if (pendingApprovalCount > 0) {
    return {
      label: pendingApprovalCount === 1 ? 'Approval required' : 'Approvals required',
      detail: 'A tool request needs a decision before the thread can move again.',
      tone: 'action_required'
    };
  }

  if (params.artifactRouting.artifactPathState === 'unresolved') {
    return {
      label: 'Use recommended path',
      detail: params.artifactRouting.recommendedArtifactDir
        ? `Artifacts are ready in the task workspace. Use ${params.artifactRouting.recommendedArtifactDir} or choose a custom destination.`
        : 'Artifacts are ready in the task workspace and still need a project-relative destination.',
      tone: 'action_required'
    };
  }

  if (params.runtime.lifecycleStatus === 'COMPLETED') {
    return {
      label: deliveredTo ? 'Delivered to' : 'Completed',
      detail: deliveredTo
        ? `Delivered to ${deliveredTo}. Continue current thread whenever you want to keep going.`
        : 'The task is complete and the next message will continue in this same thread.',
      tone: 'completed'
    };
  }

  if (params.runtime.lifecycleStatus === 'SUBMITTED') {
    return {
      label: 'Ready to start',
      detail: 'Launch the first turn for this thread when you are ready.',
      tone: 'waiting'
    };
  }

  if (params.runtime.lifecycleStatus === 'PAUSED') {
    return {
      label: 'Paused',
      detail: 'Resume the paused thread from its current state.',
      tone: 'waiting'
    };
  }

  if (params.runtime.lifecycleStatus === 'FAILED') {
    return {
      label: 'Failed',
      detail: params.runtime.lastError?.trim() || 'The thread stopped because the runtime hit a failure.',
      tone: 'blocked'
    };
  }

  if (params.runtime.lifecycleStatus === 'CANCELLED') {
    return {
      label: 'Cancelled',
      detail: 'The thread was cancelled. Restart if you want to rebuild from the current task definition.',
      tone: 'blocked'
    };
  }

  if (params.artifactRouting.artifactPathState === 'applied' && deliveredTo) {
    return {
      label: 'Delivered to',
      detail: `Delivered to ${deliveredTo}. The parent thread is still finishing any remaining required work.`,
      tone: 'waiting'
    };
  }

  if (correctionReason) {
    return {
      label: 'Action required',
      detail: correctionReason,
      tone: 'blocked'
    };
  }

  if (params.runtime.pendingOperatorInputs.length > 0) {
    return {
      label: 'Operator input queued',
      detail: 'Operator guidance is queued and the runtime is preparing the next turn.',
      tone: 'waiting'
    };
  }

  return {
    label: 'Working',
    detail: 'The runtime is still progressing through the current step.',
    tone: 'running'
  };
}

function buildSyntheticAssistantSummary(params: {
  taskId: string;
  runtime: TaskRuntimeState;
  approvals: ToolApprovalRecord[];
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  visibleConversations: ConversationMessageRecord[];
  delegationSummary: TaskDelegationSummary | null;
}): ConversationMessageRecord | null {
  const existingDisplayKinds = new Set(
    params.visibleConversations
      .filter(
        (message) => message.role === 'assistant'
          && message.visibility === 'public'
          && message.metadata?.source === 'assistant_summary'
          && typeof message.metadata?.displayKind === 'string'
      )
      .map((message) => String(message.metadata.displayKind))
  );
  const createdAt = params.runtime.updatedAt ?? Date.now();

  let displayKind: string | null = null;
  let content: string | null = null;
  if (params.approvals.some((record) => record.status === 'PENDING')) {
    displayKind = 'approval_waiting';
    content = 'A tool request is waiting for approval before this thread can continue. Review the pending approval to decide the next step.';
  } else if (params.delegationSummary?.activeChildTask) {
    displayKind = 'progress';
    content = `Delegated "${params.delegationSummary.activeChildTask.title}" to a SubSccAgent. Waiting for the child task to finish and return its scoped result.`;
  } else if (params.delegationSummary?.missingRequiredDelegation) {
    displayKind = 'recovery';
    content = 'This step must delegate a bounded child task before the parent can continue. Continue the current thread so the runtime can satisfy the delegation contract.';
  } else if (
    params.artifactRouting.artifactPathState === 'unresolved'
    && params.artifactRouting.artifactPaths.length > 0
  ) {
    displayKind = 'artifact_ready';
    content = `Created ${summarizePathList(params.artifactRouting.artifactPaths)}. Choose a project-relative destination and apply the artifact before the thread can finish.`;
  } else if (
    params.artifactRouting.artifactPathState === 'applied'
    && params.runtime.lifecycleStatus === 'RUNNING'
    && params.artifactRouting.artifactDestinationPaths.length > 0
  ) {
    displayKind = 'artifact_applied';
    content = `Artifacts were delivered to ${summarizePathList(params.artifactRouting.artifactDestinationPaths)}. The parent thread is still finishing any remaining required work.`;
  }

  if (!displayKind || !content || existingDisplayKinds.has(displayKind)) {
    return null;
  }

  return {
    messageId: `synthetic_${params.taskId}_${displayKind}_${createdAt}`,
    taskId: params.taskId,
    sessionId: null,
    correlationId: null,
    role: 'assistant',
    visibility: 'public',
    createdAt,
    content,
    metadata: {
      source: 'assistant_summary',
      displayKind,
      unitId: params.runtime.currentUnitId,
      turnId: params.runtime.latestTurnId,
      synthetic: true
    }
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildDelegatedChildSummary(params: {
  record: TaskRuntimeRecord;
  latestVisibleOutput: TaskVisibleOutputSummary | null;
}): TaskDelegatedChildSummary {
  const delegation = extractDelegationMetadata(params.record.definition);
  return {
    taskId: params.record.taskId,
    title: params.record.definition.title,
    lifecycleStatus: params.record.runtime.lifecycleStatus,
    summary: params.latestVisibleOutput?.summary ?? params.record.runtime.lastError ?? null,
    updatedAt: params.record.updatedAt,
    goal: delegation?.goal ?? null
  };
}

function deriveReconciledBatchState(params: {
  batch: TaskRuntimeState['pendingToolBatches'][number];
  latestInvocationsById: Map<string, ToolInvocationRecord>;
  approvalsByInvocationId: Map<string, ToolApprovalRecord>;
}): TaskRuntimeState['pendingToolBatches'][number] {
  const invocationEntries = params.batch.invocationIds
    .map((invocationId) => ({
      invocation: params.latestInvocationsById.get(invocationId) ?? null,
      approval: params.approvalsByInvocationId.get(invocationId) ?? null
    }))
    .filter((entry) => entry.invocation !== null);

  if (invocationEntries.length === 0) {
    return params.batch;
  }

  let approvalBlockedCount = 0;
  let deniedCount = 0;
  let failedCount = 0;
  let activeCount = 0;

  for (const entry of invocationEntries) {
    const invocation = entry.invocation!;
    if (invocation.status === 'WAITING_APPROVAL') {
      if (!entry.approval || entry.approval.status === 'PENDING') {
        approvalBlockedCount += 1;
      } else if (entry.approval.status === 'REJECTED' || entry.approval.status === 'EXPIRED') {
        deniedCount += 1;
      } else {
        activeCount += 1;
      }
      continue;
    }
    if (invocation.status === 'DENIED') {
      deniedCount += 1;
      continue;
    }
    if (invocation.status === 'FAILED') {
      failedCount += 1;
      continue;
    }
    if (invocation.status === 'PLANNED' || invocation.status === 'RUNNING') {
      activeCount += 1;
    }
  }

  let status = params.batch.status;
  if (params.batch.invocationIds.length === 0) {
    status = 'SUCCEEDED';
  } else if (deniedCount === params.batch.invocationIds.length) {
    status = 'DENIED';
  } else if (approvalBlockedCount > 0 || deniedCount > 0) {
    status = 'PARTIAL_APPROVAL_BLOCKED';
  } else if (failedCount > 0) {
    status = 'FAILED';
  } else if (activeCount > 0) {
    status = 'PLANNED';
  } else {
    status = 'SUCCEEDED';
  }

  return {
    ...params.batch,
    status,
    approvalBlockedCount,
    failedCount
  };
}

export class TaskRecordService {
  private readonly improvements: ImprovementService;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.improvements = new ImprovementService(foundation);
  }

  private normalizeRuntimeForQuery(definition: TaskDefinition, runtime: TaskRuntimeState): TaskRuntimeState {
    const now =
      typeof runtime.updatedAt === 'number'
        ? runtime.updatedAt
        : (typeof runtime.createdAt === 'number' ? runtime.createdAt : Date.now());
    const defaults = createTaskRuntimeState(definition, now);
    const defaultContractDiagnostics = defaults.contractDiagnostics;
    const runtimeContractDiagnostics = runtime.contractDiagnostics;
    const normalizedCurrentUnit = runtimeContractDiagnostics?.currentUnit
      ? {
        ...defaultContractDiagnostics?.currentUnit,
        ...runtimeContractDiagnostics.currentUnit
      }
      : defaultContractDiagnostics!.currentUnit;
    if (normalizedCurrentUnit && normalizedCurrentUnit.unitId === null) {
      normalizedCurrentUnit.contractSource = runtimeContractDiagnostics?.currentUnit?.contractSource;
      normalizedCurrentUnit.usedCompatibilityFallback = runtimeContractDiagnostics?.currentUnit?.usedCompatibilityFallback;
      normalizedCurrentUnit.scopedUnitIds = runtimeContractDiagnostics?.currentUnit?.scopedUnitIds ?? null;
      normalizedCurrentUnit.scopedOutputKeysByUnitId = runtimeContractDiagnostics?.currentUnit?.scopedOutputKeysByUnitId;
      normalizedCurrentUnit.memorySelector = runtimeContractDiagnostics?.currentUnit?.memorySelector;
      normalizedCurrentUnit.memorySelectionSource = runtimeContractDiagnostics?.currentUnit?.memorySelectionSource;
      normalizedCurrentUnit.retrievalScopeSummary = runtimeContractDiagnostics?.currentUnit?.retrievalScopeSummary;
    }
    const defaultPlanner = defaults.planner;
    const runtimePlanner = runtime.planner;
    const defaultPromptBudget = defaults.promptBudget;
    const runtimePromptBudget = runtime.promptBudget;

    return {
      ...defaults,
      ...runtime,
      schedulerUnits: Object.fromEntries(
        Object.keys(defaults.schedulerUnits).map((unitId) => [
          unitId,
          {
            ...defaults.schedulerUnits[unitId],
            ...(runtime.schedulerUnits?.[unitId] ?? {})
          }
        ])
      ),
      invalidOutputUnits: runtime.invalidOutputUnits ?? defaults.invalidOutputUnits,
      awaitingToolDispatch: runtime.awaitingToolDispatch ?? defaults.awaitingToolDispatch,
      awaitingApprovalInvocations: runtime.awaitingApprovalInvocations ?? defaults.awaitingApprovalInvocations,
      completedUnits: runtime.completedUnits ?? defaults.completedUnits,
      failedUnits: runtime.failedUnits ?? defaults.failedUnits,
      skippedUnits: runtime.skippedUnits ?? defaults.skippedUnits,
      progressHistory: runtime.progressHistory ?? defaults.progressHistory,
      llmContextMessages: runtime.llmContextMessages ?? defaults.llmContextMessages,
      pendingOperatorInputs: runtime.pendingOperatorInputs ?? defaults.pendingOperatorInputs,
      memory: {
        ...defaults.memory,
        ...(runtime.memory ?? {})
      },
      promptBudget: {
        ...defaultPromptBudget,
        ...(runtimePromptBudget ?? {}),
        sectionPromptChars: {
          ...defaultPromptBudget.sectionPromptChars,
          ...(runtimePromptBudget?.sectionPromptChars ?? runtime.promptSectionAttribution ?? {})
        },
        sectionPromptRatios: {
          ...defaultPromptBudget.sectionPromptRatios,
          ...(runtimePromptBudget?.sectionPromptRatios ?? {})
        }
      },
      contractDiagnostics: runtimeContractDiagnostics
        ? {
          ...defaultContractDiagnostics,
          ...runtimeContractDiagnostics,
          topology: {
            ...defaultContractDiagnostics?.topology,
            ...(runtimeContractDiagnostics.topology ?? {})
          },
            currentUnit: normalizedCurrentUnit,
            lastExitCondition: runtimeContractDiagnostics.lastExitCondition ?? defaultContractDiagnostics?.lastExitCondition ?? null,
            lastAcceptanceFailureCategory: runtimeContractDiagnostics.lastAcceptanceFailureCategory ?? defaultContractDiagnostics?.lastAcceptanceFailureCategory ?? null,
            lastAcceptanceIssueCodes: runtimeContractDiagnostics.lastAcceptanceIssueCodes ?? defaultContractDiagnostics?.lastAcceptanceIssueCodes ?? [],
            lastAcceptanceIssueMessages: runtimeContractDiagnostics.lastAcceptanceIssueMessages ?? defaultContractDiagnostics?.lastAcceptanceIssueMessages ?? [],
            lastPendingCorrectionKind: runtimeContractDiagnostics.lastPendingCorrectionKind ?? defaultContractDiagnostics?.lastPendingCorrectionKind ?? null,
            lastCorrectionPromptMode: runtimeContractDiagnostics.lastCorrectionPromptMode ?? defaultContractDiagnostics?.lastCorrectionPromptMode ?? 'FULL_PROTOCOL',
            correctionLoopNonConvergent: runtimeContractDiagnostics.correctionLoopNonConvergent ?? defaultContractDiagnostics?.correctionLoopNonConvergent ?? false
          }
        : defaultContractDiagnostics,
      planner: runtimePlanner
        ? {
          ...defaultPlanner,
          ...runtimePlanner,
          dependencySummary: {
            ...defaultPlanner?.dependencySummary,
            ...(runtimePlanner.dependencySummary ?? {})
          }
        }
        : defaultPlanner,
      activeStage: runtime.activeStage ?? defaults.activeStage,
      pendingToolBatches: runtime.pendingToolBatches ?? defaults.pendingToolBatches,
      consolidationState: {
        ...defaults.consolidationState,
        ...(runtime.consolidationState ?? {})
      },
      compressionPolicy: runtime.compressionPolicy
        ? {
          ...(defaults.compressionPolicy ?? {}),
          ...runtime.compressionPolicy
        }
        : defaults.compressionPolicy,
      contextGating: runtime.contextGating
        ? {
          ...(defaults.contextGating ?? {}),
          ...runtime.contextGating
        }
        : defaults.contextGating,
      batchAdmissionDecisions: runtime.batchAdmissionDecisions ?? defaults.batchAdmissionDecisions,
      guardrails: runtime.guardrails
        ? {
          ...(defaults.guardrails ?? {}),
          ...runtime.guardrails
        }
        : defaults.guardrails,
      promptSectionAttribution: {
        ...defaults.promptSectionAttribution,
        ...(runtime.promptSectionAttribution ?? runtimePromptBudget?.sectionPromptChars ?? {})
      },
      stageMemorySummary: runtime.stageMemorySummary ?? defaults.stageMemorySummary,
      capabilitySelectionSummary: runtime.capabilitySelectionSummary ?? defaults.capabilitySelectionSummary,
      retrievalSelectionSummary: runtime.retrievalSelectionSummary ?? defaults.retrievalSelectionSummary,
      contextCompressionCount: runtime.contextCompressionCount ?? defaults.contextCompressionCount,
      createdAt: runtime.createdAt ?? defaults.createdAt,
      updatedAt: runtime.updatedAt ?? defaults.updatedAt
    };
  }

  createCommandResult(
    taskId: string,
    lifecycleStatus: TaskLifecycleStatus,
    message: string,
    ok = true
  ) {
    return {
      ok,
      taskId,
      lifecycleStatus,
      message
    };
  }

  assertLifecycleAllowed(
    runtime: TaskRuntimeState,
    allowed: TaskLifecycleStatus[],
    action: string
  ): void {
    if (!allowed.includes(runtime.lifecycleStatus)) {
      throw new Error(
        `backend_new task error: cannot ${action} when lifecycleStatus is "${runtime.lifecycleStatus}".`
      );
    }
  }

  async loadRuntimeRecord(taskId: string): Promise<TaskRuntimeRecord> {
    const record = await this.foundation.taskRuntimes.get(taskId);
    if (!record) {
      const error = new Error(`backend_new task error: task "${taskId}" was not found.`);
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    return {
      ...record,
      runtime: this.normalizeRuntimeForQuery(record.definition, record.runtime)
    };
  }

  async saveTaskRuntimeRecord(params: {
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
    skipTerminalImprovementRefresh?: boolean;
  }): Promise<void> {
    await this.foundation.taskRuntimes.save({
      taskId: params.definition.taskId,
      definition: params.definition,
      runtime: params.runtime,
      activeProviderId: params.activeProviderId,
      latestCheckpointId: params.runtime.latestCheckpointId,
      updatedAt: params.runtime.updatedAt
    });
    if (
      !params.skipTerminalImprovementRefresh
      && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(params.runtime.lifecycleStatus)
    ) {
      try {
        await this.refreshTerminalTaskImprovements(params.definition.taskId);
      } catch {
        // Keep runtime persistence fail-closed for the task state itself.
      }
    }
  }

  async refreshTerminalTaskImprovements(taskId: string): Promise<void> {
    const taskQuery = await this.buildTaskQuery(taskId);
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(taskQuery.runtime.lifecycleStatus)) {
      return;
    }
    await this.improvements.processTerminalTask(taskQuery);
  }

  private async getImprovementTruth(taskId: string): Promise<{
    improvementProposals: ImprovementProposal[];
    realTaskArchiveStatus: RealTaskArchiveStatus;
  }> {
    const [improvementProposals, realTaskArchiveStatus] = await Promise.all([
      this.improvements.listTaskProposals(taskId),
      this.improvements.getTaskArchiveStatus(taskId)
    ]);
    return {
      improvementProposals,
      realTaskArchiveStatus
    };
  }

  reconcileRuntimeToolingState(params: {
    runtime: TaskRuntimeState;
    invocations: ToolInvocationRecord[];
    approvals: ToolApprovalRecord[];
  }): TaskRuntimeState {
    const latestInvocationsById = new Map(params.invocations.map((invocation) => [invocation.invocationId, invocation]));
    const approvalsByInvocationId = new Map(
      params.approvals
        .slice()
        .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt))
        .map((approval) => [approval.invocationId, approval])
    );
    const pendingToolBatches = params.runtime.pendingToolBatches.map((batch) => deriveReconciledBatchState({
      batch,
      latestInvocationsById,
      approvalsByInvocationId
    }));
    const awaitingToolDispatch = params.invocations
      .filter((invocation) => invocation.status === 'PLANNED')
      .map((invocation) => invocation.invocationId);
    const awaitingApprovalInvocations = params.invocations
      .filter((invocation) => {
        if (invocation.status !== 'WAITING_APPROVAL') {
          return false;
        }
        const approval = approvalsByInvocationId.get(invocation.invocationId);
        return !approval || approval.status === 'PENDING';
      })
      .map((invocation) => invocation.invocationId);

    const batchesChanged = pendingToolBatches.some((batch, index) => {
      const previous = params.runtime.pendingToolBatches[index];
      return batch.status !== previous.status
        || batch.approvalBlockedCount !== previous.approvalBlockedCount
        || batch.failedCount !== previous.failedCount;
    });
    const awaitingDispatchChanged = !arraysEqual(awaitingToolDispatch, params.runtime.awaitingToolDispatch);
    const awaitingApprovalChanged = !arraysEqual(awaitingApprovalInvocations, params.runtime.awaitingApprovalInvocations);
    if (!batchesChanged && !awaitingDispatchChanged && !awaitingApprovalChanged) {
      return params.runtime;
    }

    return {
      ...params.runtime,
      pendingToolBatches,
      awaitingToolDispatch,
      awaitingApprovalInvocations,
      updatedAt: Date.now()
    };
  }

  reconcileRuntimeCorrectionState(params: {
    definition?: TaskDefinition | null;
    runtime: TaskRuntimeState;
    invocations: ToolInvocationRecord[];
    approvals: ToolApprovalRecord[];
  }): TaskRuntimeState {
    if (params.runtime.pendingCorrection !== 'AWAITING_TOOL_ACTION' || !params.runtime.currentUnitId) {
      return params.runtime;
    }

    const approvalsByInvocationId = new Map(
      params.approvals
        .slice()
        .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt))
        .map((approval) => [approval.invocationId, approval])
    );
    const currentUnitInvocations = params.invocations.filter((invocation) => invocation.unitId === params.runtime.currentUnitId);
    const hasSuccessfulToolEvidence = currentUnitInvocations.some((invocation) => invocation.status === 'SUCCEEDED');
    const hasSuccessfulPersistentWriteEvidence = currentUnitInvocations.some((invocation) => (
      invocation.status === 'SUCCEEDED' && isPersistentWriteEvidenceInvocation(invocation)
    ));
    const hasSuccessfulVerificationEvidence = currentUnitInvocations.some((invocation) => (
      invocation.status === 'SUCCEEDED'
      && shouldMarkInvocationAsVerification({
        toolName: invocation.toolId,
        argumentsRecord: invocation.arguments
      })
    ));
    const hasSuccessfulDelegationEvidence = currentUnitInvocations.some((invocation) => (
      invocation.status === 'SUCCEEDED'
      && normalizeToolId(invocation.toolId) === 'delegate_subtask'
    ));
    const hasPendingApproval = currentUnitInvocations.some((invocation) => {
      if (invocation.status !== 'WAITING_APPROVAL') {
        return false;
      }
      const approval = approvalsByInvocationId.get(invocation.invocationId);
      return !approval || approval.status === 'PENDING';
    });
    const hasActiveInvocation = currentUnitInvocations.some((invocation) => (
      invocation.status === 'PLANNED'
      || invocation.status === 'RUNNING'
      || invocation.status === 'WAITING_APPROVAL'
    ));
    const currentUnit = params.definition?.units.find((unit) => unit.id === params.runtime.currentUnitId) ?? null;
    const executionProfileId = currentUnit?.executionProfileId ?? 'analyze';
    const lastAcceptanceFailureCategory = params.runtime.contractDiagnostics?.lastAcceptanceFailureCategory ?? null;
    const lastAcceptanceIssueCodes = params.runtime.contractDiagnostics?.lastAcceptanceIssueCodes ?? [];
    const requiresPersistentWriteEvidence =
      lastAcceptanceFailureCategory === 'artifact_write_required_but_not_emitted'
      || lastAcceptanceIssueCodes.includes('missing_persistent_effect_evidence')
      || lastAcceptanceIssueCodes.includes('runtime_missing_persistent_write_evidence')
      || (lastAcceptanceFailureCategory === null && executionProfileId === 'implement');
    const requiresVerificationEvidence =
      (
        lastAcceptanceFailureCategory === 'tool_action_required_but_not_emitted'
        || lastAcceptanceIssueCodes.includes('missing_verification_evidence')
        || lastAcceptanceIssueCodes.includes('runtime_missing_verification_evidence')
      )
      && executionProfileId === 'verify';
    const requiresDelegationEvidence = lastAcceptanceFailureCategory === 'required_delegation_missing';

    if (!hasSuccessfulToolEvidence || hasPendingApproval || hasActiveInvocation) {
      return params.runtime;
    }
    if (requiresPersistentWriteEvidence && !hasSuccessfulPersistentWriteEvidence) {
      return params.runtime;
    }
    if (requiresVerificationEvidence && !hasSuccessfulVerificationEvidence) {
      return params.runtime;
    }
    if (requiresDelegationEvidence && !hasSuccessfulDelegationEvidence) {
      return params.runtime;
    }

    const currentIssues = params.runtime.invalidOutputUnits[params.runtime.currentUnitId] ?? [];
    const invalidOutputUnits = currentIssues.length > 0
      ? {
        ...params.runtime.invalidOutputUnits,
        [params.runtime.currentUnitId]: []
      }
      : params.runtime.invalidOutputUnits;

    return {
      ...params.runtime,
      pendingCorrection: 'NONE',
      invalidOutputUnits: invalidOutputUnits,
      consolidationState: params.runtime.consolidationState.status === 'CORRECTION_REQUIRED'
        ? {
          ...params.runtime.consolidationState,
          status: 'COMPLETED',
          lastResult: 'COMPLETED',
          lastIssueCodes: []
        }
        : params.runtime.consolidationState,
      planner: params.runtime.planner
        ? {
          ...params.runtime.planner,
          blockingReason: null,
          executionPhase: params.runtime.planner.executionPhase === 'CONSOLIDATING'
            ? 'IDLE'
            : params.runtime.planner.executionPhase
        }
        : params.runtime.planner,
      contractDiagnostics: params.runtime.contractDiagnostics
        ? {
          ...params.runtime.contractDiagnostics,
          lastAcceptanceFailureCategory: null,
          lastAcceptanceIssueCodes: [],
          lastAcceptanceIssueMessages: [],
          lastPendingCorrectionKind: null,
          lastCorrectionPromptMode: 'FULL_PROTOCOL',
          correctionLoopNonConvergent: false
        }
        : params.runtime.contractDiagnostics,
      updatedAt: Date.now()
    };
  }

  async reconcileResolvedApprovalTurn(params: {
    taskId: string;
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    activeProviderId: string | null;
    invocations: ToolInvocationRecord[];
    approvals: ToolApprovalRecord[];
  }): Promise<TaskRuntimeState> {
    const currentUnitId = params.runtime.currentUnitId;
    if (!currentUnitId || params.runtime.lifecycleStatus !== 'RUNNING') {
      return params.runtime;
    }

    const approvalsByInvocationId = new Map(
      params.approvals
        .slice()
        .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt))
        .map((approval) => [approval.invocationId, approval])
    );
    const hasPendingApproval = params.invocations.some((invocation) => isPendingApprovalForInvocation(invocation, approvalsByInvocationId));
    const hasActiveInvocation = params.invocations.some((invocation) => (
      invocation.status === 'PLANNED'
      || invocation.status === 'RUNNING'
      || isPendingApprovalForInvocation(invocation, approvalsByInvocationId)
    ));
    if (hasPendingApproval || hasActiveInvocation) {
      return params.runtime;
    }

    const currentUnit = params.definition.units.find((unit) => unit.id === currentUnitId);
    if (!currentUnit) {
      return params.runtime;
    }

    const [conversations, validatedOutputs, commands] = await Promise.all([
      this.foundation.conversations.list(params.taskId),
      this.foundation.validatedOutputs.list(params.taskId),
      this.foundation.commands.listLatest(params.taskId)
    ]);
    const providerResponse = [...conversations].reverse().find((message) => (
      message.role === 'assistant'
      && message.visibility === 'internal'
      && isRecord(message.metadata)
      && message.metadata.source === 'provider_response'
      && message.metadata.unitId === currentUnitId
      && (message.metadata.turnId === params.runtime.latestTurnId || params.runtime.latestTurnId === null)
    ));
    if (!providerResponse?.content?.trim()) {
      return params.runtime;
    }

    const parsed = parseTurn(providerResponse.content);
    const toolEvidence = buildUnitToolEvidenceSummary({
      invocations: params.invocations,
      unitId: currentUnitId
    });
    const replayedAcceptance = acceptParsedTurn({
      currentUnitId,
      parsed,
      outputContract: currentUnit.outputContract ?? undefined,
      exitCondition: currentUnit.exitCondition ?? undefined,
      trackerPolicy: {
        allowEarlyTerminate: canEarlyTerminateCurrentUnit(params.runtime, currentUnitId),
        requireToolEvidence: requiresToolEvidenceForExecutionProfile(currentUnit.executionProfileId),
        profileId: currentUnit.executionProfileId ?? null,
        requireDelegationEvidence: isDelegationRequiredForUnit({
          definition: params.definition,
          unitId: currentUnitId
        }),
        requireArtifactWriteEvidence: currentUnit.executionProfileId === 'implement',
        requireVerificationEvidence: currentUnit.executionProfileId === 'verify',
        emittedToolEvidenceCount: toolEvidence.toolEvidenceCount,
        emittedDelegationEvidenceCount: params.invocations.filter((invocation) => (
          invocation.unitId === currentUnitId
          && invocation.status === 'SUCCEEDED'
          && normalizeToolId(invocation.toolId) === 'delegate_subtask'
        )).length,
        emittedWriteEvidencePaths: toolEvidence.writeEvidencePaths,
        emittedVerificationEvidenceCount: toolEvidence.verificationEvidenceCount
      },
      correctionContext: buildAcceptanceCorrectionContext(params.runtime, currentUnitId, validatedOutputs)
    });
    if (!replayedAcceptance.ok || !replayedAcceptance.acceptedTracker) {
      return params.runtime;
    }

    let replayedRuntime = applyTrackerState({
      definition: params.definition,
      runtime: params.runtime,
      tracker: replayedAcceptance.acceptedTracker,
      acceptedInvocationIds: [],
      approvalInvocationIds: [],
      sessionId: params.runtime.latestSessionId ?? providerResponse.sessionId ?? 'sess_approval_reconciled',
      correlationId: params.runtime.latestCorrelationId ?? providerResponse.correlationId ?? 'corr_approval_reconciled',
      turnId: params.runtime.latestTurnId ?? ((isRecord(providerResponse.metadata) && typeof providerResponse.metadata.turnId === 'string')
        ? providerResponse.metadata.turnId
        : 'turn_approval_reconciled'),
      checkpointId: params.runtime.latestCheckpointId ?? ((isRecord(providerResponse.metadata) && typeof providerResponse.metadata.checkpointId === 'string')
        ? providerResponse.metadata.checkpointId
        : 'chk_approval_reconciled'),
      providerId: params.activeProviderId ?? params.runtime.selectedProviderId ?? null
    });
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: params.definition,
      invocations: params.invocations,
      commands
    });
    if (artifactRouting.needsExplicitDestination && replayedRuntime.lifecycleStatus === 'COMPLETED') {
      replayedRuntime = {
        ...replayedRuntime,
        lifecycleStatus: 'RUNNING',
        engineStatus: 'RUNNING',
        currentUnitId,
        planner: replayedRuntime.planner
          ? {
            ...replayedRuntime.planner,
            currentStageIndex: params.runtime.planner?.currentStageIndex ?? replayedRuntime.planner.currentStageIndex,
            currentStageUnitIds: params.runtime.planner?.currentStageUnitIds
              ? [...params.runtime.planner.currentStageUnitIds]
              : replayedRuntime.planner.currentStageUnitIds,
            readyStageUnitIds: [],
            executionPhase: 'IDLE',
            blockingReason: null
          }
          : replayedRuntime.planner,
        contractDiagnostics: replayedRuntime.contractDiagnostics
          ? {
            ...replayedRuntime.contractDiagnostics,
            currentUnit: {
              ...replayedRuntime.contractDiagnostics.currentUnit,
              unitId: currentUnitId
            }
          }
          : replayedRuntime.contractDiagnostics,
        executionLease: replayedRuntime.executionLease
          ? {
            ...replayedRuntime.executionLease,
            active: false,
            phase: 'IDLE'
          }
          : replayedRuntime.executionLease
      };
    }

    return {
      ...replayedRuntime,
      pendingToolBatches: params.runtime.pendingToolBatches,
      awaitingToolDispatch: [],
      awaitingApprovalInvocations: [],
      consolidationState: {
        ...params.runtime.consolidationState,
        status: 'COMPLETED',
        lastResult: 'COMPLETED',
        lastIssueCodes: []
      },
      planner: replayedRuntime.planner
        ? {
          ...replayedRuntime.planner,
          blockingReason: null,
          executionPhase: replayedRuntime.lifecycleStatus === 'COMPLETED' ? 'IDLE' : replayedRuntime.planner.executionPhase
        }
        : replayedRuntime.planner,
      contractDiagnostics: replayedRuntime.contractDiagnostics
        ? {
          ...replayedRuntime.contractDiagnostics,
          lastAcceptanceFailureCategory: null,
          lastAcceptanceIssueCodes: [],
          lastAcceptanceIssueMessages: [],
          lastPendingCorrectionKind: null,
          lastCorrectionPromptMode: 'FULL_PROTOCOL',
          correctionLoopNonConvergent: false
        }
        : replayedRuntime.contractDiagnostics,
      updatedAt: Date.now()
    };
  }

  private async buildVisibleOutputSummaryForTaskRecord(
    record: TaskRuntimeRecord
  ): Promise<TaskVisibleOutputSummary | null> {
    if (hasMissingRequiredDelegation({
      definition: record.definition,
      runtime: record.runtime
    })) {
      return null;
    }
    const [validatedOutputs, conversations, commands, invocations] = await Promise.all([
      this.foundation.validatedOutputs.list(record.taskId),
      this.foundation.conversations.list(record.taskId),
      this.foundation.commands.listLatest(record.taskId),
      this.foundation.toolInvocations.listLatest(record.taskId)
    ]);
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: record.definition,
      invocations,
      commands
    });
    const latestValidatedOutput = validatedOutputs.at(-1) ?? null;
    const latestSafeAssistant = [...conversations]
      .reverse()
      .find((message) => message.role === 'assistant' && message.visibility === 'public' && message.metadata?.source !== 'assistant_summary')
      ?? null;

    if (latestValidatedOutput) {
      return buildVisibleOutputFromValidatedRecord({
        record: latestValidatedOutput,
        fallbackArtifactPaths: artifactRouting.artifactPaths,
        artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
        artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir
          ?? artifactRouting.selectedArtifactDir
          ?? null,
        artifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null
      });
    }

    if (latestSafeAssistant) {
      return buildVisibleOutputFromAssistantFallback({
        message: latestSafeAssistant,
        fallbackArtifactPaths: artifactRouting.artifactPaths,
        artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
        artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir
          ?? artifactRouting.selectedArtifactDir
          ?? null,
        artifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null
      });
    }

    return null;
  }

  private async buildDelegationSummary(params: {
    definition: TaskDefinition;
    runtime: TaskRuntimeState;
    approvals: ToolApprovalRecord[];
    artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  }): Promise<TaskDelegationSummary> {
    const allRuntimes = await this.foundation.taskRuntimes.list();
    const activeChildren = getActiveDelegatedChildrenForParent(allRuntimes, params.definition.taskId);
    const recentChildRecords = getDelegatedChildrenForParent(allRuntimes, params.definition.taskId)
      .slice(-3)
      .reverse();
    const recoveryBlocked = params.runtime.lifecycleStatus === 'FAILED'
      || params.runtime.lifecycleStatus === 'CANCELLED'
      || Boolean(params.runtime.lastError);
    const eligibility = buildDelegationEligibility({
      config: this.foundation.config,
      definition: params.definition,
      runtime: params.runtime,
      pendingApprovalCount: params.approvals.filter((approval) => approval.status === 'PENDING').length,
      hasArtifactDestinationBlocker: params.artifactRouting.needsExplicitDestination,
      hasCorrectionLoopBlocker: params.runtime.contractDiagnostics?.correctionLoopNonConvergent ?? false,
      hasRecoveryBlocker: recoveryBlocked,
      activeChildCount: activeChildren.length
    });
    const activeChildTask = activeChildren[0]
      ? buildDelegatedChildSummary({
        record: activeChildren[0],
        latestVisibleOutput: await this.buildVisibleOutputSummaryForTaskRecord(activeChildren[0])
      })
      : null;
    const recentChildren = await Promise.all(
      recentChildRecords.map(async (record) => buildDelegatedChildSummary({
        record,
        latestVisibleOutput: await this.buildVisibleOutputSummaryForTaskRecord(record)
      }))
    );
    const required = params.definition.units.some((unit) => unit.delegationRequired === true);
    const missingRequiredDelegation = hasMissingRequiredDelegation({
      definition: params.definition,
      runtime: params.runtime
    });

    return {
      depth: eligibility.depth,
      delegationEnabled: eligibility.delegationEnabled,
      canDelegate: eligibility.canDelegate,
      required,
      missingRequiredDelegation,
      reason: missingRequiredDelegation
        ? 'Delegation is required before parent delivery can continue.'
        : eligibility.reason,
      activeChildTask,
      recentChildren
    };
  }

  async buildTaskQuery(
    taskId: string,
    options?: {
      includeInternalConversations?: boolean;
    }
  ): Promise<TaskQueryResponse> {
    const runtimeRecord = await this.loadRuntimeRecord(taskId);
    const normalizedRuntime = this.normalizeRuntimeForQuery(runtimeRecord.definition, runtimeRecord.runtime);
    const [projection, approvals, invocations, events, conversations, commands, operatorMessages, interrupts, queueItem, validatedOutputs, metadataRecord] = await Promise.all([
      this.foundation.projections.get(taskId),
      this.foundation.approvals.listLatest(taskId),
      this.foundation.toolInvocations.listLatest(taskId),
      this.foundation.events.list(taskId),
      this.foundation.conversations.list(taskId),
      this.foundation.commands.listLatest(taskId),
      this.foundation.operatorMessages.listLatest(taskId),
      this.foundation.interrupts.listLatest(taskId),
      this.foundation.queue?.get(taskId) ?? Promise.resolve(null),
      this.foundation.validatedOutputs.list(taskId),
      this.foundation.taskMetadata.get(taskId)
    ]);
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: runtimeRecord.definition,
      invocations,
      commands
    });
    const toolingReconciledRuntime = this.reconcileRuntimeToolingState({
      runtime: normalizedRuntime,
      invocations,
      approvals
    });
    const reconciledRuntime = this.reconcileRuntimeCorrectionState({
      definition: runtimeRecord.definition,
      runtime: toolingReconciledRuntime,
      invocations,
      approvals
    });
    const delegationSummary = await this.buildDelegationSummary({
      definition: runtimeRecord.definition,
      runtime: reconciledRuntime,
      approvals,
      artifactRouting
    });
    const baseVisibleConversations = options?.includeInternalConversations
      ? conversations
      : conversations.filter(isUserVisibleConversation);
    const syntheticAssistantSummary = buildSyntheticAssistantSummary({
      taskId,
      runtime: reconciledRuntime,
      approvals,
      artifactRouting,
      visibleConversations: baseVisibleConversations,
      delegationSummary
    });
    const visibleConversations = syntheticAssistantSummary
      ? [...baseVisibleConversations, syntheticAssistantSummary]
      : baseVisibleConversations;
    const providerFailureMetadata = projection?.metadata && typeof projection.metadata === 'object'
      ? {
        message: typeof projection.metadata.providerFailure === 'string' ? projection.metadata.providerFailure : null,
        kind: typeof projection.metadata.providerFailureKind === 'string' ? projection.metadata.providerFailureKind : null,
        category: typeof projection.metadata.providerFailureCategory === 'string' ? projection.metadata.providerFailureCategory : null,
        statusCode: typeof projection.metadata.providerFailureStatusCode === 'number' ? projection.metadata.providerFailureStatusCode : null,
        retryable: typeof projection.metadata.providerFailureRetryable === 'boolean' ? projection.metadata.providerFailureRetryable : null,
        providerId: typeof projection.metadata.providerId === 'string' ? projection.metadata.providerId : null,
        timeoutOrigin: typeof projection.metadata.providerFailureTimeoutOrigin === 'string' ? projection.metadata.providerFailureTimeoutOrigin : null,
        elapsedMs: typeof projection.metadata.providerFailureElapsedMs === 'number' ? projection.metadata.providerFailureElapsedMs : null,
        requestTimeoutMs: typeof projection.metadata.providerFailureRequestTimeoutMs === 'number' ? projection.metadata.providerFailureRequestTimeoutMs : null,
        retryAttempt: typeof projection.metadata.providerFailureRetryAttempt === 'number' ? projection.metadata.providerFailureRetryAttempt : null,
        requestContext: {
          rawContextMessageCount: typeof projection.metadata.providerRequestRawContextMessageCount === 'number'
            ? projection.metadata.providerRequestRawContextMessageCount
            : null,
          retainedContextMessageCount: typeof projection.metadata.providerRequestRetainedContextMessageCount === 'number'
            ? projection.metadata.providerRequestRetainedContextMessageCount
            : null,
          toolMessageCount: typeof projection.metadata.providerRequestToolMessageCount === 'number'
            ? projection.metadata.providerRequestToolMessageCount
            : null,
          gatedContextCharacters: typeof projection.metadata.providerRequestGatedContextCharacters === 'number'
            ? projection.metadata.providerRequestGatedContextCharacters
            : null,
          providerMessageCount: typeof projection.metadata.providerRequestMessageCount === 'number'
            ? projection.metadata.providerRequestMessageCount
            : null,
          estimatedPromptCharacters: typeof projection.metadata.providerRequestEstimatedPromptCharacters === 'number'
            ? projection.metadata.providerRequestEstimatedPromptCharacters
            : null
        }
      }
      : null;
    const latestValidatedOutput = validatedOutputs.at(-1) ?? null;
    const latestSafeAssistant = [...baseVisibleConversations]
      .reverse()
      .find((message) => message.role === 'assistant' && message.metadata?.source !== 'assistant_summary') ?? null;
    const latestVisibleOutput = delegationSummary?.missingRequiredDelegation
      ? null
      : latestValidatedOutput
        ? buildVisibleOutputFromValidatedRecord({
          record: latestValidatedOutput,
          fallbackArtifactPaths: artifactRouting.artifactPaths,
          artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
          artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir
            ?? artifactRouting.selectedArtifactDir
            ?? null,
          artifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null
        })
        : reconciledRuntime.lifecycleStatus === 'FAILED'
          ? buildVisibleOutputFromFailureFallback({
            runtime: reconciledRuntime,
            providerFailureMessage: providerFailureMetadata?.message ?? null,
            fallbackArtifactPaths: artifactRouting.artifactPaths,
            artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
            artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir
              ?? artifactRouting.selectedArtifactDir
              ?? null,
            artifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null
          })
        : latestSafeAssistant
          ? buildVisibleOutputFromAssistantFallback({
            message: latestSafeAssistant,
            fallbackArtifactPaths: artifactRouting.artifactPaths,
            artifactDestinationPaths: artifactRouting.artifactDestinationPaths,
          artifactDestinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir
            ?? artifactRouting.selectedArtifactDir
            ?? null,
          artifactApplyStatus: artifactRouting.lastArtifactApplyResult?.status ?? null
        })
          : null;
    const visibleToolActivities = buildVisibleToolActivities({
      invocations,
      approvals
    });
    const pendingApprovalItems = buildPendingApprovalItems({
      approvals,
      invocations
    });
    const completionSummary = buildTaskCompletionSummary({
      runtime: reconciledRuntime,
      latestVisibleOutput,
      artifactRouting
    });
    const primaryAction = buildTaskPrimaryActionSummary({
      runtime: reconciledRuntime,
      approvals,
      artifactRouting,
      completionSummary,
      delegationSummary
    });
    const nextActionSummary = buildTaskNextActionSummary({
      runtime: reconciledRuntime,
      artifactRouting,
      primaryAction,
      delegationSummary
    });
    const statusSummary = buildTaskStatusSummary({
      runtime: reconciledRuntime,
      approvals,
      artifactRouting,
      completionSummary,
      delegationSummary
    });
    const improvementTruth = await this.getImprovementTruth(taskId);
    const { isArchived } = getTaskArchiveState(metadataRecord);
    const { canArchive, canDelete } = getTaskArchiveCapabilities(reconciledRuntime.lifecycleStatus, isArchived);

    return {
      definition: runtimeRecord.definition,
      runtime: reconciledRuntime,
      isArchived,
      canArchive,
      canDelete,
      projection,
      queue: queueItem,
      conversations: visibleConversations,
      latestVisibleOutput,
      statusSummary,
      primaryAction,
      nextActionSummary,
      completionSummary,
      delegationSummary,
      improvementProposals: improvementTruth.improvementProposals,
      realTaskArchiveStatus: improvementTruth.realTaskArchiveStatus,
      commands,
      operatorMessages,
      interrupts,
      pendingApprovals: approvals.filter(record => record.status === 'PENDING'),
      pendingApprovalItems,
      toolInvocations: invocations,
      visibleToolActivities,
      events,
      diagnostics: {
        lastError: runtimeRecord.runtime.lastError,
        providerFailure: providerFailureMetadata && typeof providerFailureMetadata.message === 'string'
          ? {
            message: providerFailureMetadata.message,
            kind: providerFailureMetadata.kind,
            category: providerFailureMetadata.category,
            statusCode: providerFailureMetadata.statusCode,
            retryable: providerFailureMetadata.retryable,
            providerId: providerFailureMetadata.providerId,
            timeoutOrigin: providerFailureMetadata.timeoutOrigin,
            elapsedMs: providerFailureMetadata.elapsedMs,
            requestTimeoutMs: providerFailureMetadata.requestTimeoutMs,
            retryAttempt: providerFailureMetadata.retryAttempt,
            requestContext: providerFailureMetadata.requestContext
          }
          : null
      }
    };
  }

  async listTasks(includeArchived = false): Promise<TaskSummaryResponse[]> {
    const runtimes = await this.foundation.taskRuntimes.list();
    const topLevelRuntimes = runtimes.filter((record) => !isDelegatedChildDefinition(record.definition));
    const [approvals, activeQueue, metadataRecords] = await Promise.all([
      Promise.all(topLevelRuntimes.map(record => this.foundation.approvals.listLatest(record.taskId))),
      this.foundation.queue?.listActive() ?? Promise.resolve([]),
      Promise.all(topLevelRuntimes.map(record => this.foundation.taskMetadata.get(record.taskId)))
    ]);
    const queueByTaskId = new Map(activeQueue.map(item => [item.taskId, item]));
    const approvalCountByTaskId = new Map(
      topLevelRuntimes.map((record, index) => [
        record.taskId,
        approvals[index].filter(item => item.status === 'PENDING').length
      ])
    );
    return topLevelRuntimes
      .map((record, index) => {
        const { isArchived } = getTaskArchiveState(metadataRecords[index]);
        const { canArchive, canDelete } = getTaskArchiveCapabilities(record.runtime.lifecycleStatus, isArchived);
        return {
          taskId: record.taskId,
          title: record.definition.title,
          intent: record.definition.intent,
          lifecycleStatus: record.runtime.lifecycleStatus,
          isArchived,
          canArchive,
          canDelete,
          currentUnitId: record.runtime.currentUnitId,
          updatedAt: record.updatedAt,
          queueState: queueByTaskId.get(record.taskId)?.state ?? null,
          pendingApprovalCount: approvalCountByTaskId.get(record.taskId) ?? 0,
          lastError: record.runtime.lastError,
          isDelegatedChild: false
        } satisfies TaskSummaryResponse;
      })
      .filter((summary) => includeArchived || !summary.isArchived);
  }
}
