import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createBackendNewFoundation } from '../../foundation/bootstrap/create-foundation';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createToolFailureResult, createToolSuccessResult } from '../../foundation/tools/result-envelope';
import { createBackendNewRuntime, BackendNewRuntime } from '../create-runtime';
import { AgentUnit, ExecutionProfileId, TaskLifecycleStatus } from '../../domain/contracts/types';
import { buildTaskExecutionSummary } from '../tasks/task-execution-observability';
import {
  TaskExecutionIssueCategory,
  TaskExecutionSummary,
  TaskObservationHookId,
  TaskQueryResponse
} from '../tasks/types';
import { ProviderCompletionUsage } from '../../foundation/providers/client-types';
import { ProviderProfileView } from '../platform/types';

type LiveScenarioFamily =
  | 'bugfix'
  | 'refactor'
  | 'test-repair'
  | 'regression-diagnosis'
  | 'multi-file-implementation';

export const ARTIFACT_QUALITY_VERDICTS = ['passed', 'failed', 'external_blocker'] as const;
export type ArtifactQualityVerdict = typeof ARTIFACT_QUALITY_VERDICTS[number];

export const ARTIFACT_QUALITY_FAILURE_CATEGORIES = [
  'artifact_missing',
  'artifact_apply_conflict',
  'artifact_apply_failed',
  'acceptance_command_failed',
  'content_assertion_failed',
  'provider_disabled',
  'provider_credentials_missing',
  'provider_unavailable',
  'response_shape_mismatch',
  'tracker_missing_after_valid_output',
  'output_contract_mismatch',
  'exit_condition_mismatch',
  'tool_action_required_but_not_emitted',
  'artifact_write_required_but_not_emitted',
  'correction_loop_non_convergent',
  'provider_style_incompatibility',
  'task_failed',
  'unknown'
] as const;
export type ArtifactQualityFailureCategory = typeof ARTIFACT_QUALITY_FAILURE_CATEGORIES[number];

export interface LiveProviderExecutionSummary {
  enabled: boolean;
  providerId: string;
  model: string;
  transport: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface ArtifactQualityAcceptance {
  verdict: ArtifactQualityVerdict;
  failureCategory: ArtifactQualityFailureCategory | null;
  summary: string;
  files: string[];
  testsPassed: boolean | null;
  contentAssertionsPassed: boolean | null;
  diffAssertionsPassed: boolean | null;
}

export interface TaskLiveProviderScenarioMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
  usageSource: 'returned' | 'estimated' | 'missing';
  usageBreakdown: {
    returnedCalls: number;
    estimatedCalls: number;
    missingCalls: number;
  };
  plannedToolBatchCount: number;
  executedToolBatchCount: number;
  toolInvocationCount: number;
  averageToolInvocationsPerBatch: number;
  approvalCount: number;
  recoveryCount: number;
  continueCount: number;
  continueMessageCount: number;
  pauseCount: number;
  resumeCount: number;
  eventCount: number;
  approvalBlockedBatchCount: number;
  plannerFallbackCount: number;
  stageDurations: TaskExecutionSummary['stageDurations'];
  unitDurations: TaskExecutionSummary['unitDurations'];
  contextGating: TaskExecutionSummary['contextGating'];
}

export interface TaskLiveProviderScenarioDiagnostics {
  workspaceDir: string | null;
  latestAssistantMessageExcerpt: string | null;
  continueMessages?: string[];
  recentAssistantMessages?: Array<{
    messageId: string | null;
    turnId: string | null;
    visibility: string | null;
    source: string | null;
    excerpt: string;
  }>;
  recentUserMessages?: Array<{
    messageId: string | null;
    turnId: string | null;
    visibility: string | null;
    source: string | null;
    excerpt: string;
  }>;
  recentToolInvocations: Array<{
    unitId: string;
    toolId: string;
    status: string;
  }>;
  recentFailedToolResults: Array<{
    unitId: string;
    toolId: string;
    status: string;
    summary: string;
  }>;
  artifactSnapshots: Array<{
    path: string;
    exists: boolean;
    excerpt: string | null;
  }>;
  artifactEvidenceSummary: Array<{
    path: string;
    exists: boolean;
    hasMatchingWriteEvidence: boolean;
    lastRelatedToolAction: string | null;
  }>;
  lastAcceptanceFailureCategory: NonNullable<TaskQueryResponse['runtime']['contractDiagnostics']>['lastAcceptanceFailureCategory'] | null;
  lastPendingCorrectionKind: NonNullable<TaskQueryResponse['runtime']['contractDiagnostics']>['lastPendingCorrectionKind'] | null;
  lastCorrectionPromptMode: NonNullable<TaskQueryResponse['runtime']['contractDiagnostics']>['lastCorrectionPromptMode'] | null;
  requiresToolEvidence: boolean;
}

export interface TaskLiveProviderScenarioResult {
  scenario: string;
  family: LiveScenarioFamily;
  description: string;
  taskId: string | null;
  passed: boolean;
  finalLifecycleStatus: TaskLifecycleStatus | null;
  finalQueueState: NonNullable<TaskQueryResponse['queue']>['state'] | null;
  issueCategory: TaskExecutionIssueCategory | null;
  issueSummary: string | null;
  missingRequiredEventTypes: string[];
  observedHooks: TaskObservationHookId[];
  executionSummary: TaskExecutionSummary | null;
  provider: LiveProviderExecutionSummary | null;
  artifactQuality: ArtifactQualityAcceptance;
  metrics: TaskLiveProviderScenarioMetrics;
  diagnostics: TaskLiveProviderScenarioDiagnostics;
  externalBlocker: string | null;
}

export interface TaskLiveProviderScenarioSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap' | 'external_blocker';
  provider: LiveProviderExecutionSummary | null;
  externalBlocker: string | null;
  scenarios: TaskLiveProviderScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    externalBlocked: number;
    successRate: number;
    artifactQualityPassRate: number;
    liveProviderPassRate: number;
    totalApiCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCachedPromptTokens: number;
    totalCacheWritePromptTokens: number;
    usageSourceCounts: Record<'returned' | 'estimated' | 'missing', number>;
    usageBreakdown: {
      returnedCalls: number;
      estimatedCalls: number;
      missingCalls: number;
    };
    averageApiCallCount: number;
    averageExecutedToolBatchCount: number;
    averageToolInvocationsPerBatch: number;
    plannerFallbackScenarioCount: number;
    byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>>;
    byFamily: Record<LiveScenarioFamily, number>;
    byVerdict: Record<ArtifactQualityVerdict, number>;
  };
}

interface MutableMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
  usageSource: 'returned' | 'estimated' | 'missing';
  usageBreakdown: {
    returnedCalls: number;
    estimatedCalls: number;
    missingCalls: number;
  };
}

interface MutableScenarioCounters {
  continueCount: number;
  continueMessageCount: number;
  pauseCount: number;
  resumeCount: number;
  approvalCount: number;
  recoveryCount: number;
}

interface WorkspaceCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface LiveProviderScenarioDefinition {
  name: string;
  family: LiveScenarioFamily;
  description: string;
  intent: string;
  units: AgentUnit[];
  fixtureFiles: Record<string, string>;
  allowedCommands: string[];
  requiredEventTypes: string[];
  artifactFiles: string[];
  acceptance(harness: LiveProviderScenarioHarness, task: TaskQueryResponse): Promise<ArtifactQualityAcceptance>;
}

interface LiveProviderSuiteOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface LiveProviderSelection {
  summary: LiveProviderExecutionSummary | null;
  blocker: string | null;
}

function createTempRoot(prefix = 'backend-new-live-provider-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function resolveLiveProviderManifestPath(projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.BACKEND_NEW_LIVE_PROVIDER_MANIFEST?.trim()) {
    return path.resolve(projectRoot, env.BACKEND_NEW_LIVE_PROVIDER_MANIFEST);
  }
  const candidates = [
    path.resolve(projectRoot, 'backend', 'data', 'providers', 'manifest.json')
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  return resolved ?? candidates[0];
}

function createUnit(params: {
  id: string;
  role: string;
  goal: string;
  profile: ExecutionProfileId;
  dependencies: string[];
  taskScope?: string;
  outputContract?: string;
  exitCondition?: string;
}): AgentUnit {
  const profileAwareOutputContract = params.profile === 'analyze'
    ? '{"summary":"string","issues":[],"report":"string"}'
    : '{"summary":"string","issues":[],"artifact":"string","report":"string"}';
  const profileAwareExitCondition = params.profile === 'analyze'
    ? '{"status":"COMPLETE","report":"required"}'
    : '{"status":"COMPLETE","report":"required"}';
  const profileAwareTaskScope = params.taskScope ?? (
    params.profile === 'analyze'
      ? 'Analysis only. Do not claim code edits, test passes, or final implementation artifacts for downstream units.'
      : params.profile === 'implement'
        ? 'Implementation phase. Produce the required workspace artifacts and use real tools before claiming completion.'
        : 'Verification phase. Use real read/search/run evidence to confirm the implementation artifacts.'
  );
  return {
    id: params.id,
    role: params.role,
    goal: params.goal,
    taskScope: profileAwareTaskScope,
    inputContract: '{"includeGlobalMemory":true}',
    outputContract: params.outputContract ?? profileAwareOutputContract,
    exitCondition: params.exitCondition ?? profileAwareExitCondition,
    executionProfileId: params.profile,
    dependencies: params.dependencies
  };
}

function createEmptyMetrics(): TaskLiveProviderScenarioMetrics {
  return {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheWritePromptTokens: 0,
    usageSource: 'missing',
    usageBreakdown: {
      returnedCalls: 0,
      estimatedCalls: 0,
      missingCalls: 0
    },
    plannedToolBatchCount: 0,
    executedToolBatchCount: 0,
    toolInvocationCount: 0,
    averageToolInvocationsPerBatch: 0,
    approvalCount: 0,
    recoveryCount: 0,
    continueCount: 0,
    continueMessageCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    eventCount: 0,
    approvalBlockedBatchCount: 0,
    plannerFallbackCount: 0,
    stageDurations: [],
    unitDurations: [],
    contextGating: {
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
      reasons: [],
      estimatedContextReductionRatio: 0
    }
  };
}

function deriveUsageSource(breakdown: MutableMetrics['usageBreakdown']): MutableMetrics['usageSource'] {
  if (breakdown.missingCalls > 0) {
    return 'missing';
  }
  if (breakdown.estimatedCalls > 0) {
    return 'estimated';
  }
  if (breakdown.returnedCalls > 0) {
    return 'returned';
  }
  return 'missing';
}

function createExternalBlockerAcceptance(
  summary: string,
  failureCategory: ArtifactQualityFailureCategory
): ArtifactQualityAcceptance {
  return {
    verdict: 'external_blocker',
    failureCategory,
    summary,
    files: [],
    testsPassed: null,
    contentAssertionsPassed: null,
    diffAssertionsPassed: null
  };
}

function createFailureAcceptance(
  summary: string,
  failureCategory: ArtifactQualityFailureCategory,
  params: Partial<ArtifactQualityAcceptance> = {}
): ArtifactQualityAcceptance {
  return {
    verdict: 'failed',
    failureCategory,
    summary,
    files: params.files ?? [],
    testsPassed: params.testsPassed ?? null,
    contentAssertionsPassed: params.contentAssertionsPassed ?? null,
    diffAssertionsPassed: params.diffAssertionsPassed ?? null
  };
}

function createPassedAcceptance(summary: string, files: string[], params: Partial<ArtifactQualityAcceptance> = {}): ArtifactQualityAcceptance {
  return {
    verdict: 'passed',
    failureCategory: null,
    summary,
    files,
    testsPassed: params.testsPassed ?? true,
    contentAssertionsPassed: params.contentAssertionsPassed ?? true,
    diffAssertionsPassed: params.diffAssertionsPassed ?? true
  };
}

function shouldTreatUsageAsMissing(usage: ProviderCompletionUsage): boolean {
  const values = [
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    usage.cachedPromptTokens,
    usage.cacheWritePromptTokens
  ]
    .filter((value): value is number => typeof value === 'number');
  return values.length > 0 && values.every((value) => value === 0);
}

function hasRecordedUsage(usage: ProviderCompletionUsage | null): usage is ProviderCompletionUsage {
  if (!usage) {
    return false;
  }
  return usage.promptTokens !== null
    || usage.completionTokens !== null
    || usage.totalTokens !== null
    || usage.cachedPromptTokens !== null
    || usage.cacheWritePromptTokens !== null;
}

function preserveAcceptanceEvidence(acceptance: ArtifactQualityAcceptance): Partial<ArtifactQualityAcceptance> {
  return {
    files: acceptance.files,
    testsPassed: acceptance.testsPassed,
    contentAssertionsPassed: acceptance.contentAssertionsPassed,
    diffAssertionsPassed: acceptance.diffAssertionsPassed
  };
}

export function applyLiveProviderArtifactQualityGate(
  summary: TaskExecutionSummary,
  artifactQuality: ArtifactQualityAcceptance
): ArtifactQualityAcceptance {
  if (artifactQuality.verdict !== 'passed') {
    return artifactQuality;
  }

  const preserved = preserveAcceptanceEvidence(artifactQuality);
  if (summary.lastArtifactApplyResult?.status === 'CONFLICT') {
    return createFailureAcceptance(
      summary.lastArtifactApplyResult.message || 'Generated artifacts could not be applied because the destination has conflicting edits.',
      'artifact_apply_conflict',
      preserved
    );
  }

  if (summary.lastArtifactApplyResult?.status === 'FAILED') {
    return createFailureAcceptance(
      summary.lastArtifactApplyResult.message || 'Generated artifacts could not be applied to the destination.',
      'artifact_apply_failed',
      preserved
    );
  }

  if (summary.issueCategory === 'artifact_apply_conflict') {
    return createFailureAcceptance(
      summary.issueSummary || 'Generated artifacts could not be applied because the destination has conflicting edits.',
      'artifact_apply_conflict',
      preserved
    );
  }

  if (summary.issueCategory === 'artifact_apply_failed') {
    return createFailureAcceptance(
      summary.issueSummary || 'Generated artifacts could not be applied to the destination.',
      'artifact_apply_failed',
      preserved
    );
  }

  if (!hasRuntimeCompletionGate(summary)) {
    const evidenceFailedChecks = summary.acceptance.deterministic.evidence.failedChecks;
    if (evidenceFailedChecks.includes('known_verification_failure')) {
      return createFailureAcceptance(
        summary.issueSummary
          || summary.acceptance.deterministic.evidence.summary
          || 'Verification evidence recorded a real failure after artifact generation.',
        'acceptance_command_failed',
        preserved
      );
    }
    const mappedCategory = mapAcceptanceFailureToArtifactCategory(summary.turnContract.lastAcceptanceFailureCategory);
    if (mappedCategory) {
      return createFailureAcceptance(
        summary.acceptance.deterministic.execution.summary || 'Runtime acceptance failed after artifact generation.',
        mappedCategory,
        preserved
      );
    }
    return createFailureAcceptance(
      summary.acceptance.deterministic.outcome.summary || 'Runtime acceptance failed after artifact generation.',
      'task_failed',
      preserved
    );
  }

  return artifactQuality;
}

function hasRuntimeCompletionGate(summary: TaskExecutionSummary): boolean {
  const quality = summary.acceptance.quality;
  return summary.acceptance.deterministic.verdict === 'passed'
    && (
      quality.profileId === null
      || quality.verdict === 'passed'
    );
}

function shouldPassLiveProviderScenario(params: {
  task: TaskQueryResponse;
  summary: TaskExecutionSummary;
  artifactQuality: ArtifactQualityAcceptance;
  missingRequiredEventTypes: string[];
}): boolean {
  return params.task.runtime.lifecycleStatus === 'COMPLETED'
    && params.missingRequiredEventTypes.length === 0
    && params.artifactQuality.verdict === 'passed'
    && hasRuntimeCompletionGate(params.summary);
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env.BACKEND_NEW_LIVE_PROVIDER_ENABLED ?? '');
}

function isProviderOrEnvironmentBlockerMessage(message: string): boolean {
  return /missing api key secret|api key|authentication failed|unable to verify the first certificate|certificate|network failure|request failed|upstream failed|rate-limited|timed out|timeout|\b408\b/i.test(message);
}

function classifyProviderBlocker(message: string): ArtifactQualityFailureCategory {
  if (/missing api key secret|api key/i.test(message)) {
    return 'provider_credentials_missing';
  }
  return 'provider_unavailable';
}

function mapAcceptanceFailureToArtifactCategory(
  value: NonNullable<TaskQueryResponse['runtime']['contractDiagnostics']>['lastAcceptanceFailureCategory'] | null | undefined
): ArtifactQualityFailureCategory | null {
  switch (value) {
    case 'response_shape_mismatch':
      return 'response_shape_mismatch';
    case 'tracker_missing_after_valid_output':
      return 'tracker_missing_after_valid_output';
    case 'output_contract_mismatch':
      return 'output_contract_mismatch';
    case 'exit_condition_mismatch':
      return 'exit_condition_mismatch';
    case 'tool_action_required_but_not_emitted':
      return 'tool_action_required_but_not_emitted';
    case 'artifact_write_required_but_not_emitted':
      return 'artifact_write_required_but_not_emitted';
    case 'provider_style_incompatibility':
      return 'provider_style_incompatibility';
    default:
      return null;
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeUsageValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function readUsageFromMetadata(metadata: Record<string, unknown>): ProviderCompletionUsage | null {
  const usage = metadata.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const record = usage as Record<string, unknown>;
  const normalizedUsage = {
    promptTokens: normalizeUsageValue(record.promptTokens),
    completionTokens: normalizeUsageValue(record.completionTokens),
    totalTokens: normalizeUsageValue(record.totalTokens),
    cachedPromptTokens: normalizeUsageValue(record.cachedPromptTokens),
    cacheWritePromptTokens: normalizeUsageValue(record.cacheWritePromptTokens),
    providerReportedUsage: record.providerReportedUsage && typeof record.providerReportedUsage === 'object' && !Array.isArray(record.providerReportedUsage)
      ? record.providerReportedUsage as Record<string, unknown>
      : null
  };
  return shouldTreatUsageAsMissing(normalizedUsage) ? null : normalizedUsage;
}

function estimateUsageFromTaskTurn(task: TaskQueryResponse, assistantMessageId: string): ProviderCompletionUsage | null {
  const assistantMessage = task.conversations.find((message) => message.messageId === assistantMessageId);
  if (!assistantMessage) {
    return null;
  }
  const turnId = typeof assistantMessage.metadata.turnId === 'string'
    ? assistantMessage.metadata.turnId
    : null;
  if (!turnId) {
    return null;
  }
  const relatedMessages = task.conversations.filter((message) => typeof message.metadata.turnId === 'string'
    && message.metadata.turnId === turnId);
  if (relatedMessages.length === 0) {
    return null;
  }
  const promptTokens = relatedMessages
    .filter((message) => message.role !== 'assistant')
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const completionTokens = estimateTokens(assistantMessage.content);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: null,
    cacheWritePromptTokens: null,
    providerReportedUsage: null
  };
}

function buildAssistantMessageExcerpt(task: TaskQueryResponse): string | null {
  const latestAssistantMessage = [...task.conversations]
    .filter((message) => message.role === 'assistant')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!latestAssistantMessage?.content?.trim()) {
    return null;
  }
  const normalized = latestAssistantMessage.content.replace(/\s+/g, ' ').trim();
  return normalized.length <= 800 ? normalized : `${normalized.slice(0, 797)}...`;
}

function truncateConversationExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function extractRecentConversationExcerpts(
  conversations: Array<{
    role: string;
    content: string;
    messageId?: string | null;
    visibility?: string | null;
    metadata?: Record<string, unknown>;
  }>,
  role: 'assistant' | 'user',
  limit: number,
  options: {
    excludeAssistantSummary?: boolean;
  } = {}
): Array<{
  messageId: string | null;
  turnId: string | null;
  visibility: string | null;
  source: string | null;
  excerpt: string;
}> {
  return conversations
    .filter((message) => message.role === role)
    .filter((message) => !(role === 'assistant' && options.excludeAssistantSummary && message.metadata?.source === 'assistant_summary'))
    .slice(-limit)
    .map((message) => ({
      messageId: message.messageId ?? null,
      turnId: typeof message.metadata?.turnId === 'string' ? message.metadata.turnId : null,
      visibility: typeof message.visibility === 'string' ? message.visibility : null,
      source: typeof message.metadata?.source === 'string' ? message.metadata.source : null,
      excerpt: truncateConversationExcerpt(message.content)
    }));
}

function buildRecentToolInvocationSummary(task: TaskQueryResponse): TaskLiveProviderScenarioDiagnostics['recentToolInvocations'] {
  return [...task.toolInvocations]
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))
    .slice(0, 8)
    .map((record) => ({
      unitId: record.unitId,
      toolId: record.toolId,
      status: record.status
    }));
}

function truncateDiagnosticText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isWriteEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'create_folder';
}

function collectToolEvidencePaths(record: TaskQueryResponse['toolInvocations'][number]): string[] {
  const values = [
    record.result?.path,
    record.result?.file,
    record.result?.output && typeof record.result.output === 'object' && !Array.isArray(record.result.output)
      ? (record.result.output as Record<string, unknown>).path
      : undefined,
    record.result?.output && typeof record.result.output === 'object' && !Array.isArray(record.result.output)
      ? (record.result.output as Record<string, unknown>).file
      : undefined,
    record.arguments.path,
    record.arguments.file,
    record.arguments.file_path
  ];
  return values
    .map((value) => normalizeWorkspaceRelativePath(value))
    .filter((value): value is string => !!value);
}

function buildRecentFailedToolResultSummary(task: TaskQueryResponse): TaskLiveProviderScenarioDiagnostics['recentFailedToolResults'] {
  return [...task.toolInvocations]
    .filter((record) => record.status === 'FAILED')
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))
    .slice(0, 5)
    .map((record) => ({
      unitId: record.unitId,
      toolId: record.toolId,
      status: record.status,
      summary: truncateDiagnosticText((() => {
        const parts: string[] = [];
        const command = typeof record.metadata?.command === 'string' ? record.metadata.command.trim() : '';
        const statusCode = typeof record.metadata?.status === 'number' ? record.metadata.status : null;
        const stderr = typeof record.metadata?.stderr === 'string' ? record.metadata.stderr.trim() : '';
        const stdout = typeof record.metadata?.stdout === 'string' ? record.metadata.stdout.trim() : '';
        if (command) {
          parts.push(`command=${command}`);
        }
        if (statusCode !== null) {
          parts.push(`status=${statusCode}`);
        }
        if (stderr) {
          parts.push(`stderr=${stderr}`);
        }
        if (stdout) {
          parts.push(`stdout=${stdout}`);
        }
        if (parts.length > 0) {
          return parts.join(' | ');
        }
        return typeof record.error === 'string' && record.error.trim()
          ? record.error
          : JSON.stringify(record.result ?? {});
      })())
    }));
}

function findLatestSuccessfulToolText(task: TaskQueryResponse, artifactPath: string): string | null {
  const normalizedArtifactPath = normalizeWorkspaceRelativePath(artifactPath);
  if (!normalizedArtifactPath) {
    return null;
  }
  const matchingInvocations = [...task.toolInvocations]
    .filter((record) => {
      if (record.status !== 'SUCCEEDED') {
        return false;
      }
      const normalizedToolId = normalizeToolId(record.toolId);
      if (normalizedToolId !== 'read_file' && normalizedToolId !== 'write_file') {
        return false;
      }
      return collectToolEvidencePaths(record).includes(normalizedArtifactPath);
    })
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt));
  for (const matchingInvocation of matchingInvocations) {
    const normalizedToolId = normalizeToolId(matchingInvocation.toolId);
    if (normalizedToolId === 'read_file') {
      const output = matchingInvocation.result?.output;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const content = (output as Record<string, unknown>).content;
        if (typeof content === 'string' && content.trim()) {
          return content;
        }
      }
      continue;
    }
    if (normalizedToolId === 'write_file') {
      const contentArg = extractLiveProviderWriteFileContent(matchingInvocation.arguments);
      if (contentArg) {
        return contentArg;
      }
      const output = matchingInvocation.result?.output;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const content = (output as Record<string, unknown>).content;
        if (typeof content === 'string' && content.trim()) {
          return content;
        }
      }
    }
  }
  return null;
}

export function extractLiveProviderWriteFileContent(argumentsRecord: Record<string, unknown>): string | null {
  const content = argumentsRecord.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  const contentLines = argumentsRecord.content_lines;
  if (Array.isArray(contentLines)) {
    const lines = contentLines
      .filter((entry): entry is string => typeof entry === 'string')
      .join('\n');
    return lines.trim() ? lines : null;
  }
  const contentJson = argumentsRecord.content_json;
  if (contentJson !== undefined) {
    return `${JSON.stringify(contentJson, null, 2)}\n`;
  }
  return null;
}

function getLatestFailedRunCommandSummary(task: TaskQueryResponse, unitId: string | null): string | null {
  const latestFailedRun = [...task.toolInvocations]
    .filter((record) => {
      if (normalizeToolId(record.toolId) !== 'run_command' || record.status !== 'FAILED') {
        return false;
      }
      return !unitId || record.unitId === unitId;
    })
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))[0];
  if (!latestFailedRun) {
    return null;
  }
  const command = typeof latestFailedRun.metadata?.command === 'string'
    ? latestFailedRun.metadata.command.trim()
    : 'run_command';
  const statusCode = typeof latestFailedRun.metadata?.status === 'number'
    ? String(latestFailedRun.metadata.status)
    : 'unknown';
  const parts = [
    typeof latestFailedRun.metadata?.stderr === 'string' ? latestFailedRun.metadata.stderr : '',
    typeof latestFailedRun.metadata?.stdout === 'string' ? latestFailedRun.metadata.stdout : '',
    typeof latestFailedRun.error === 'string' ? latestFailedRun.error : ''
  ]
    .filter((value) => !!value)
    .join(' ');
  const normalized = parts.replace(/\s+/g, ' ').trim();
  const failureKind = /cannot find module/i.test(normalized)
    ? 'cannot-find-module'
    : /assert(?:ion)?error/i.test(normalized)
      ? 'assertion-failed'
      : /syntaxerror/i.test(normalized)
        ? 'syntax-error'
        : /typeerror/i.test(normalized)
          ? 'type-error'
          : normalized
            ? 'command-failed'
            : 'unknown-failure';
  return `${command}|${statusCode}|${failureKind}`;
}

function buildLiveCorrectionLoopSignature(
  task: TaskQueryResponse,
  summary: TaskExecutionSummary
): string | null {
  const diagnostics = task.runtime.contractDiagnostics;
  const deterministic = summary.acceptance?.deterministic;
  const deterministicFailedChecks = deterministic
    ? [
      ...(deterministic.contract?.failedChecks ?? []),
      ...(deterministic.execution?.failedChecks ?? []),
      ...(deterministic.evidence?.failedChecks ?? []),
      ...(deterministic.outcome?.failedChecks ?? [])
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .sort()
      .join(',')
    : null;
  const signatureParts = [
    task.runtime.currentUnitId,
    task.runtime.pendingCorrection,
    summary.issueCategory,
    diagnostics?.lastAcceptanceFailureCategory ?? null,
    diagnostics?.lastPendingCorrectionKind ?? null,
    diagnostics?.lastCorrectionPromptMode ?? null,
    deterministicFailedChecks,
    getLatestFailedRunCommandSummary(task, task.runtime.currentUnitId)
  ].filter(Boolean);
  return signatureParts.length > 0 ? signatureParts.join('|') : null;
}

function getRequiredWritePathsForLiveFamily(family: string | null): string[] {
  switch (family) {
    case 'bugfix':
      return ['src/math.cjs'];
    case 'refactor':
      return ['src/text-utils.cjs', 'src/user-label.cjs'];
    case 'test-repair':
      return ['tests/number.test.cjs'];
    case 'regression-diagnosis':
      return ['reports/diagnosis.md'];
    case 'multi-file-implementation':
      return ['src/index.cjs', 'src/slugify.cjs'];
    default:
      return [];
  }
}

function getMissingRequiredWritePaths(task: TaskQueryResponse, family: string | null): string[] {
  const writtenPaths = new Set<string>();
  for (const invocation of task.toolInvocations) {
    if (invocation.status !== 'SUCCEEDED' || !isWriteEvidenceTool(invocation.toolId)) {
      continue;
    }
    for (const evidencePath of collectToolEvidencePaths(invocation)) {
      writtenPaths.add(evidencePath);
    }
  }
  return getRequiredWritePathsForLiveFamily(family)
    .filter((requiredPath) => !writtenPaths.has(requiredPath));
}

function buildMissingWriteContinueMessage(family: string | null, missingPaths: string[]): string | null {
  if (missingPaths.length === 0) {
    return null;
  }
  const missing = missingPaths.join(', ');
  switch (family) {
    case 'refactor':
      return [
        `The prior tool evidence is incomplete. Missing write_file evidence for: ${missing}.`,
        'Emit write_file actions for the missing refactor files now.',
        'src/text-utils.cjs must export { toTitleCase } via CommonJS.',
        'src/user-label.cjs must require "./text-utils.cjs" and export { buildUserLabel }.',
        'Then run the exact command npm test and emit one COMPLETE tracker.'
      ].join(' ');
    case 'multi-file-implementation':
      return [
        `The prior tool evidence is incomplete. Missing write_file evidence for: ${missing}.`,
        'Emit write_file actions for the missing implementation files now.',
        'src/slugify.cjs must export { slugify } via CommonJS.',
        'src/index.cjs must require "./slugify.cjs" and export { buildArticlePath }.',
        'Then run the exact command npm test and emit one COMPLETE tracker.'
      ].join(' ');
    default:
      return `The prior tool evidence is incomplete. Missing write_file evidence for: ${missing}. Emit the missing write_file action(s), run the required verification command if applicable, then emit one COMPLETE tracker.`;
  }
}

async function readArtifactTextWithFallback(
  harness: LiveProviderScenarioHarness,
  task: TaskQueryResponse,
  artifactPath: string
): Promise<string | null> {
  try {
    return await harness.readWorkspaceFile(artifactPath);
  } catch {
    return findLatestSuccessfulToolText(task, artifactPath);
  }
}

async function buildArtifactSnapshots(
  harness: LiveProviderScenarioHarness | null,
  artifactFiles: string[]
): Promise<TaskLiveProviderScenarioDiagnostics['artifactSnapshots']> {
  if (!harness) {
    return [];
  }
  const snapshots: TaskLiveProviderScenarioDiagnostics['artifactSnapshots'] = [];
  for (const relativePath of artifactFiles) {
    const exists = await harness.fileExists(relativePath);
    if (!exists) {
      snapshots.push({
        path: relativePath,
        exists: false,
        excerpt: null
      });
      continue;
    }
    try {
      const content = await harness.readWorkspaceFile(relativePath);
      snapshots.push({
        path: relativePath,
        exists: true,
        excerpt: truncateDiagnosticText(content)
      });
    } catch {
      snapshots.push({
        path: relativePath,
        exists: true,
        excerpt: null
      });
    }
  }
  return snapshots;
}

async function buildArtifactEvidenceSummary(
  task: TaskQueryResponse | null,
  harness: LiveProviderScenarioHarness | null,
  artifactFiles: string[]
): Promise<TaskLiveProviderScenarioDiagnostics['artifactEvidenceSummary']> {
  const writeEvidenceByPath = new Map<string, TaskQueryResponse['toolInvocations'][number]>();
  const relatedInvocations = task?.toolInvocations ?? [];
  for (const invocation of relatedInvocations) {
    if (invocation.status !== 'SUCCEEDED' || !isWriteEvidenceTool(invocation.toolId)) {
      continue;
    }
    for (const evidencePath of collectToolEvidencePaths(invocation)) {
      writeEvidenceByPath.set(evidencePath, invocation);
    }
  }

  return Promise.all(artifactFiles.map(async (artifactPath) => {
    const normalizedPath = normalizeWorkspaceRelativePath(artifactPath) ?? artifactPath;
    const exists = harness ? await harness.fileExists(artifactPath) : false;
    const matchingWrite = writeEvidenceByPath.get(normalizedPath) ?? null;
    const latestRelatedInvocation = [...relatedInvocations]
      .filter((invocation) => collectToolEvidencePaths(invocation).includes(normalizedPath))
      .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))[0] ?? null;
    return {
      path: artifactPath,
      exists,
      hasMatchingWriteEvidence: !!matchingWrite,
      lastRelatedToolAction: latestRelatedInvocation
        ? `${latestRelatedInvocation.toolId}:${latestRelatedInvocation.status}`
        : null
    };
  }));
}

async function createScenarioDiagnostics(
  task: TaskQueryResponse | null,
  harness: LiveProviderScenarioHarness | null,
  artifactFiles: string[]
): Promise<TaskLiveProviderScenarioDiagnostics> {
  const allConversations = task && harness
    ? await harness.listConversations()
    : [];
  return {
    workspaceDir: harness?.getWorkspaceDir() ?? null,
    latestAssistantMessageExcerpt: task ? buildAssistantMessageExcerpt(task) : null,
    continueMessages: harness?.getContinueMessages().slice(-4) ?? [],
    recentAssistantMessages: extractRecentConversationExcerpts(allConversations, 'assistant', 4, {
      excludeAssistantSummary: true
    }),
    recentUserMessages: extractRecentConversationExcerpts(allConversations, 'user', 4),
    recentToolInvocations: task ? buildRecentToolInvocationSummary(task) : [],
    recentFailedToolResults: task ? buildRecentFailedToolResultSummary(task) : [],
    artifactSnapshots: await buildArtifactSnapshots(harness, artifactFiles),
    artifactEvidenceSummary: await buildArtifactEvidenceSummary(task, harness, artifactFiles),
    lastAcceptanceFailureCategory: task?.runtime.contractDiagnostics?.lastAcceptanceFailureCategory ?? null,
    lastPendingCorrectionKind: task?.runtime.contractDiagnostics?.lastPendingCorrectionKind ?? null,
    lastCorrectionPromptMode: task?.runtime.contractDiagnostics?.lastCorrectionPromptMode ?? null,
    requiresToolEvidence: task?.runtime.contractDiagnostics?.currentUnit.requiresToolEvidence ?? false
  };
}

function runWorkspaceCommand(command: string, cwd: string): WorkspaceCommandResult {
  const trimmed = command.trim();
  const npmMatch = /^npm(?:\s+(.+))?$/i.exec(trimmed);
  if (process.platform === 'win32' && npmMatch) {
    const npmArgs = (npmMatch[1] ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const quotedNpmArgs = npmArgs.map((value) => {
      if (/[\s"]/u.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    });
    const npmResult = spawnSync('cmd.exe', ['/d', '/s', '/c', `npm.cmd ${quotedNpmArgs.join(' ')}`.trim()], {
      cwd,
      encoding: 'utf8',
      shell: false
    });
    if (npmResult.error) {
      return {
        status: npmResult.status ?? 1,
        stdout: npmResult.stdout ?? '',
        stderr: npmResult.stderr ?? npmResult.error.message
      };
    }
    return {
      status: npmResult.status ?? 1,
      stdout: npmResult.stdout ?? '',
      stderr: npmResult.stderr ?? ''
    };
  }
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      encoding: 'utf8',
      shell: false
    })
    : spawnSync(command, [], {
      cwd,
      encoding: 'utf8',
      shell: true
    });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? ''
  };
}

function registerLiveProviderCommandTool(
  foundation: BackendNewFoundation,
  allowedCommands: string[]
): void {
  if (!foundation.extensions.findTool('run-command') && !foundation.extensions.findTool('run_command')) {
    foundation.extensions.registerTool({
      id: 'run-command',
      name: 'run_command',
      description: 'Run a scenario-allowed workspace command during live-provider artifact validation.',
      source: 'builtin',
      effect: 'READ',
      riskLevel: 'LOW',
      inputSchema: [
        { name: 'command', type: 'string', required: true }
      ]
    });
  }

  foundation.toolExecutors.register('run-command', {
      async execute(request) {
        const command = String(request.invocation.arguments.command ?? '').trim();
        if (!allowedCommands.includes(command)) {
          return createToolFailureResult({
            kind: 'EXECUTION',
            message: `Command "${command}" is not allowed in this live-provider scenario.`
          });
        }
        const workspaceDir = foundation.layout.forTask(request.invocation.taskId).workspaceDir;
        const result = runWorkspaceCommand(command, workspaceDir);
        if (result.status !== 0) {
          return createToolFailureResult({
            kind: 'EXECUTION',
            message: `Command failed with status ${result.status}: ${result.stderr || result.stdout}`.trim(),
            metadata: {
              command,
              status: result.status,
              stdout: result.stdout.trim(),
              stderr: result.stderr.trim()
            }
          });
        }
        return createToolSuccessResult({
          output: {
            command,
            status: result.status,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim()
          }
        });
      }
    });
}

class LiveProviderScenarioHarness {
  private readonly rootDir = createTempRoot();
  private readonly metrics: MutableMetrics = {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheWritePromptTokens: 0,
    usageSource: 'missing',
    usageBreakdown: {
      returnedCalls: 0,
      estimatedCalls: 0,
      missingCalls: 0
    }
  };
  private readonly counters: MutableScenarioCounters = {
    continueCount: 0,
    continueMessageCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    approvalCount: 0,
    recoveryCount: 0
  };
  private foundation: BackendNewFoundation | null = null;
  private runtime: BackendNewRuntime | null = null;
  private taskId: string | null = null;
  private baselineFileHashes = new Map<string, string>();
  private readonly metricsSeen = new Set<string>();
  private readonly continueMessages: string[] = [];

  constructor(
    private readonly definition: LiveProviderScenarioDefinition,
    private readonly providerId: string,
    private readonly projectRoot: string,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  private async bootRuntime(): Promise<void> {
    const manifestPath = resolveLiveProviderManifestPath(this.projectRoot, this.env);
    this.foundation = createBackendNewFoundation({
      cwd: this.projectRoot,
      env: this.env,
      config: {
        paths: {
          rootDir: this.rootDir
        },
        providers: {
          manifestFile: manifestPath,
          defaultProviderId: this.providerId
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    this.runtime = createBackendNewRuntime({
      foundation: this.foundation
    });
    const providerViews = await this.runtime.platform.listProviders();
    const providerProfile = providerViews.find((view) => view.profile.id === this.providerId)?.profile
      ?? this.foundation.providers.get(this.providerId);
    if (providerProfile) {
      await seedLiveProviderSecretIfNeeded(this.foundation, providerProfile, this.env);
    }
    registerLiveProviderCommandTool(this.foundation, this.definition.allowedCommands);
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`Live-provider scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireFoundation(): BackendNewFoundation {
    if (!this.foundation) {
      throw new Error(`Live-provider scenario "${this.definition.name}" is missing its foundation.`);
    }
    return this.foundation;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`Live-provider scenario "${this.definition.name}" has no submitted task id.`);
    }
    return this.taskId;
  }

  private captureUsage(response: { task: TaskQueryResponse }): void {
    for (const message of response.task.conversations) {
      if (message.role !== 'assistant') {
        continue;
      }
      const responseId = typeof message.metadata.responseId === 'string'
        ? message.metadata.responseId
        : `${message.sessionId ?? 'session'}:${message.messageId}`;
      if (this.metricsSeen.has(responseId)) {
        continue;
      }
      this.metricsSeen.add(responseId);
      this.metrics.apiCallCount += 1;
      const returnedUsage = readUsageFromMetadata(message.metadata);
      if (hasRecordedUsage(returnedUsage)) {
        this.metrics.promptTokens += returnedUsage.promptTokens ?? 0;
        this.metrics.completionTokens += returnedUsage.completionTokens ?? 0;
        this.metrics.totalTokens += returnedUsage.totalTokens
          ?? ((returnedUsage.promptTokens ?? 0) + (returnedUsage.completionTokens ?? 0));
        this.metrics.cachedPromptTokens += returnedUsage.cachedPromptTokens ?? 0;
        this.metrics.cacheWritePromptTokens += returnedUsage.cacheWritePromptTokens ?? 0;
        this.metrics.usageBreakdown.returnedCalls += 1;
        this.metrics.usageSource = deriveUsageSource(this.metrics.usageBreakdown);
        continue;
      }
      const estimatedUsage = estimateUsageFromTaskTurn(response.task, message.messageId);
      if (estimatedUsage) {
        this.metrics.promptTokens += estimatedUsage.promptTokens ?? 0;
        this.metrics.completionTokens += estimatedUsage.completionTokens ?? 0;
        this.metrics.totalTokens += estimatedUsage.totalTokens ?? 0;
        this.metrics.cachedPromptTokens += estimatedUsage.cachedPromptTokens ?? 0;
        this.metrics.cacheWritePromptTokens += estimatedUsage.cacheWritePromptTokens ?? 0;
        this.metrics.usageBreakdown.estimatedCalls += 1;
        this.metrics.usageSource = deriveUsageSource(this.metrics.usageBreakdown);
        continue;
      }
      this.metrics.usageBreakdown.missingCalls += 1;
      this.metrics.usageSource = deriveUsageSource(this.metrics.usageBreakdown);
    }
  }

  private async materializeFixtures(): Promise<void> {
    const foundation = this.requireFoundation();
    const taskId = this.requireTaskId();
    for (const [relativePath, content] of Object.entries(this.definition.fixtureFiles)) {
      const resolved = foundation.layout.resolveWorkspacePath(taskId, relativePath);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content, foundation.config.storage.encoding);
      this.baselineFileHashes.set(relativePath, hashText(content));
    }
  }

  async submit(): Promise<TaskQueryResponse> {
    if (!this.runtime || !this.foundation) {
      await this.bootRuntime();
    }
    const runtime = this.requireRuntime();
    const submitted = await runtime.tasks.submitTask({
      title: this.definition.name,
      intent: this.definition.intent,
      preferredProviderId: this.providerId,
      metadata: {
        liveProviderScenario: this.definition.name,
        liveProviderScenarioFamily: this.definition.family
      },
      units: this.definition.units
    });
    this.taskId = submitted.command.taskId;
    await this.materializeFixtures();
    return submitted.task;
  }

  async start(userMessage?: string): Promise<TaskQueryResponse> {
    const runtime = this.requireRuntime();
    const started = await runtime.tasks.startTask({
      taskId: this.requireTaskId(),
      userMessage
    });
    this.captureUsage(started);
    return started.task;
  }

  async continue(userMessage?: string): Promise<TaskQueryResponse> {
    this.counters.continueCount += 1;
    if (userMessage?.trim()) {
      this.counters.continueMessageCount += 1;
      this.continueMessages.push(userMessage.trim());
    }
    const runtime = this.requireRuntime();
    const next = await runtime.tasks.continueTask({
      taskId: this.requireTaskId(),
      userMessage
    });
    this.captureUsage(next);
    return next.task;
  }

  async applyRecommendedArtifacts(task: TaskQueryResponse): Promise<TaskQueryResponse | null> {
    const summary = this.buildSummary(task);
    if (summary.issueCategory !== 'artifact_destination_unresolved') {
      return null;
    }
    const destinationDir = summary.selectedArtifactDir ?? summary.recommendedArtifactDir;
    if (!destinationDir) {
      return null;
    }
    const applied = await this.requireRuntime().tasks.submitCommand({
      taskId: this.requireTaskId(),
      type: 'APPLY_ARTIFACTS',
      message: destinationDir,
      metadata: {
        destinationDir,
        overwrite: true
      }
    });
    this.captureUsage(applied);
    return applied.task;
  }

  async pause(reason = 'live-provider scenario pause'): Promise<TaskQueryResponse> {
    this.counters.pauseCount += 1;
    const runtime = this.requireRuntime();
    const paused = await runtime.tasks.pauseTask({
      taskId: this.requireTaskId(),
      reason
    });
    this.captureUsage(paused);
    return paused.task;
  }

  async resume(userMessage?: string): Promise<TaskQueryResponse> {
    this.counters.resumeCount += 1;
    const runtime = this.requireRuntime();
    const resumed = await runtime.tasks.resumeTask({
      taskId: this.requireTaskId(),
      userMessage
    });
    this.captureUsage(resumed);
    return resumed.task;
  }

  async approveAll(task: TaskQueryResponse): Promise<TaskQueryResponse> {
    let current = task;
    const runtime = this.requireRuntime();
    for (const approval of current.pendingApprovals) {
      this.counters.approvalCount += 1;
      const resolved = await runtime.tasks.resolveToolApproval({
        taskId: current.definition.taskId,
        invocationId: approval.invocationId,
        status: 'APPROVED',
        grantedBy: 'live-provider-auto-approver',
        reason: 'live-provider scenario auto-approval'
      });
      current = resolved.task;
    }
    return current;
  }

  async restartRuntime(): Promise<TaskQueryResponse> {
    this.counters.recoveryCount += 1;
    await this.runtime?.close();
    this.runtime = null;
    this.foundation = null;
    await this.bootRuntime();
    return this.getTask();
  }

  async getTask(): Promise<TaskQueryResponse> {
    const runtime = this.requireRuntime();
    const task = await runtime.tasks.getTask(this.requireTaskId());
    this.captureUsage({ task });
    return task;
  }

  buildSummary(task: TaskQueryResponse): TaskExecutionSummary {
    return buildTaskExecutionSummary(task, this.requireFoundation());
  }

  getWorkspaceDir(): string {
    return this.requireFoundation().layout.forTask(this.requireTaskId()).workspaceDir;
  }

  getContinueMessages(): string[] {
    return [...this.continueMessages];
  }

  async listConversations() {
    try {
      return await this.requireFoundation().conversations.list(this.requireTaskId());
    } catch {
      return [];
    }
  }

  getBaselineHash(relativePath: string): string | null {
    return this.baselineFileHashes.get(relativePath) ?? null;
  }

  getFixtureText(relativePath: string): string | null {
    return this.definition.fixtureFiles[relativePath] ?? null;
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const resolved = this.requireFoundation().layout.resolveWorkspacePath(this.requireTaskId(), relativePath);
    return fsp.readFile(resolved, this.requireFoundation().config.storage.encoding);
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const resolved = this.requireFoundation().layout.resolveWorkspacePath(this.requireTaskId(), relativePath);
    try {
      await fsp.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  runAllowedCommand(command: string): WorkspaceCommandResult {
    if (!this.definition.allowedCommands.includes(command)) {
      throw new Error(`Command "${command}" is not allowed for scenario "${this.definition.name}".`);
    }
    return runWorkspaceCommand(command, this.getWorkspaceDir());
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    if (/^(1|true|yes|on)$/i.test(this.env.BACKEND_NEW_LIVE_PROVIDER_KEEP_WORKSPACES ?? '')) {
      return;
    }
    removeDir(this.rootDir);
  }

  async finalize(task: TaskQueryResponse, provider: LiveProviderExecutionSummary): Promise<TaskLiveProviderScenarioResult> {
    const summary = this.buildSummary(task);
    const missingRequiredEventTypes = this.definition.requiredEventTypes
      .filter((type) => !task.events.some((event) => event.type === type));
    const rawArtifactQuality = task.runtime.lifecycleStatus === 'COMPLETED'
      ? await this.definition.acceptance(this, task)
      : (() => {
        const failureCategory = task.runtime.contractDiagnostics?.correctionLoopNonConvergent
          ? 'correction_loop_non_convergent'
          : (
            mapAcceptanceFailureToArtifactCategory(task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory)
            ?? 'task_failed'
          );
        const summaryText = task.runtime.contractDiagnostics?.correctionLoopNonConvergent
          ? 'Task remained in a repeated non-convergent correction loop and did not reach an artifact-quality verdict.'
          : `Task ended with lifecycle ${task.runtime.lifecycleStatus}.`;
        return createFailureAcceptance(summaryText, failureCategory, { files: [] });
      })();
    const artifactQuality = applyLiveProviderArtifactQualityGate(summary, rawArtifactQuality);
    const passed = shouldPassLiveProviderScenario({
      task,
      summary,
      artifactQuality,
      missingRequiredEventTypes
    });

    return {
      scenario: this.definition.name,
      family: this.definition.family,
      description: this.definition.description,
      taskId: task.definition.taskId,
      passed,
      finalLifecycleStatus: task.runtime.lifecycleStatus,
      finalQueueState: task.queue?.state ?? null,
      issueCategory: summary.issueCategory,
      issueSummary: summary.issueSummary,
      missingRequiredEventTypes,
      observedHooks: [...summary.observedHooks],
      executionSummary: summary,
      provider,
      artifactQuality,
      metrics: {
        apiCallCount: this.metrics.apiCallCount,
        promptTokens: this.metrics.promptTokens,
        completionTokens: this.metrics.completionTokens,
        totalTokens: this.metrics.totalTokens,
        cachedPromptTokens: this.metrics.cachedPromptTokens,
        cacheWritePromptTokens: this.metrics.cacheWritePromptTokens,
        usageSource: this.metrics.usageSource,
        usageBreakdown: { ...this.metrics.usageBreakdown },
        plannedToolBatchCount: summary.batchExecution.plannedToolBatchCount,
        executedToolBatchCount: summary.batchExecution.executedToolBatchCount,
        toolInvocationCount: task.toolInvocations.length,
        averageToolInvocationsPerBatch: summary.batchExecution.averageToolInvocationsPerBatch,
        approvalCount: this.counters.approvalCount,
        recoveryCount: this.counters.recoveryCount,
        continueCount: this.counters.continueCount,
        continueMessageCount: this.counters.continueMessageCount,
        pauseCount: this.counters.pauseCount,
        resumeCount: this.counters.resumeCount,
        eventCount: task.events.length,
        approvalBlockedBatchCount: summary.approvalBlockedBatchCount,
        plannerFallbackCount: summary.plannerFallbackReasons.length,
        stageDurations: [...summary.stageDurations],
        unitDurations: [...summary.unitDurations],
        contextGating: {
          ...summary.contextGating,
          reasons: [...summary.contextGating.reasons]
        }
      },
      diagnostics: await createScenarioDiagnostics(task, this, this.definition.artifactFiles),
      externalBlocker: null
    };
  }
}

async function driveToCompletion(
  harness: LiveProviderScenarioHarness,
  initialTask: TaskQueryResponse,
  continueMessages: Array<string | undefined> = []
): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  let repeatedFailureSignature: string | null = null;
  let repeatedFailureCount = 0;
  let missingPersistentEffectStreak = 0;
  let verificationFailureStreak = 0;
  while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 24) {
    const summary = harness.buildSummary(task);
    const correctionSignature = buildLiveCorrectionLoopSignature(task, summary);
    const deterministic = summary.acceptance?.deterministic;
    const evidenceFailedChecks = deterministic?.evidence?.failedChecks ?? [];
    const latestFailedRunSummary = getLatestFailedRunCommandSummary(task, task.runtime.currentUnitId);
    if (correctionSignature && correctionSignature === repeatedFailureSignature) {
      repeatedFailureCount += 1;
    } else {
      repeatedFailureSignature = correctionSignature;
      repeatedFailureCount = correctionSignature ? 1 : 0;
    }
    if (correctionSignature && repeatedFailureCount >= 3) {
      return harness.pause(`live-provider correction stalled: ${correctionSignature.slice(0, 240)}`);
    }
    if (evidenceFailedChecks.includes('missing_persistent_effect_evidence')) {
      missingPersistentEffectStreak += 1;
    } else {
      missingPersistentEffectStreak = 0;
    }
    if (evidenceFailedChecks.includes('known_verification_failure') && latestFailedRunSummary) {
      verificationFailureStreak += 1;
    } else {
      verificationFailureStreak = 0;
    }
    if (missingPersistentEffectStreak >= 3) {
      return harness.pause('live-provider correction stalled: persistent artifact/write evidence was missing across repeated implement turns.');
    }
    if (verificationFailureStreak >= 3) {
      return harness.pause(`live-provider verification stalled: repeated failed verification remained unresolved (${(latestFailedRunSummary ?? 'verification-failed').slice(0, 240)}).`);
    }
    if (task.pendingApprovals.length > 0) {
      task = await harness.approveAll(task);
    } else {
      const applied = await harness.applyRecommendedArtifacts(task);
      if (applied) {
        task = applied;
        guard += 1;
        continue;
      }
      task = await harness.continue(continueMessages[guard] ?? deriveConvergenceContinueMessage(task, repeatedFailureCount));
    }
    guard += 1;
  }
  if (guard >= 24 && task.runtime.lifecycleStatus === 'RUNNING') {
    return harness.pause(`Live-provider scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function deriveConvergenceContinueMessage(task: TaskQueryResponse, repeatedFailureCount = 0): string | undefined {
  const diagnostics = task.runtime.contractDiagnostics;
  if (!diagnostics) {
    return undefined;
  }
  const family = typeof task.definition.metadata?.liveProviderScenarioFamily === 'string'
    ? task.definition.metadata.liveProviderScenarioFamily
    : null;
  const currentUnitId = task.runtime.currentUnitId;
  const latestFailedRunSummary = getLatestFailedRunCommandSummary(task, currentUnitId);
  const missingRequiredWritePaths = currentUnitId === 'AGENT-002'
    ? getMissingRequiredWritePaths(task, family)
    : [];
  const missingWriteContinueMessage = buildMissingWriteContinueMessage(family, missingRequiredWritePaths);
  if (
    missingWriteContinueMessage
    && (
      diagnostics.lastPendingCorrectionKind === 'AWAITING_OUTPUT_CORRECTION'
      || diagnostics.lastPendingCorrectionKind === 'AWAITING_TRACKER'
    )
  ) {
    return missingWriteContinueMessage;
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TRACKER') {
    if (diagnostics.lastAcceptanceFailureCategory === 'exit_condition_mismatch') {
      return 'Return only one valid tracker JSON block for the current unit with status COMPLETE, progress_percent 100, decision CONTINUE, next_unit null, and no prose. Do not repeat explicit output and do not emit tool blocks.';
    }
    return 'Return only one valid tracker JSON block for the current unit. Do not repeat explicit output, do not emit tool blocks, and do not add prose.';
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TOOL_ACTION') {
    if (currentUnitId === 'AGENT-002') {
      if (
        diagnostics.lastAcceptanceFailureCategory === 'artifact_write_required_but_not_emitted'
        && repeatedFailureCount >= 1
      ) {
        switch (family) {
          case 'bugfix':
            return 'Stop analyzing. In this turn, do not call read_file, list_files, or search_files. Emit exactly one write_file for src/math.cjs so add(a, b) returns a + b, then run the exact command npm test, then emit exactly one tracker JSON block with status COMPLETE.';
          case 'refactor':
            return [
              'Stop analyzing. In this turn, do not call read_file, list_files, or search_files.',
              'Emit exactly two write_file actions, then run the exact command npm test, then emit exactly one tracker JSON block with status COMPLETE.',
              'Write src/text-utils.cjs with exactly this CommonJS helper:',
              '`function toTitleCase(value) {',
              '  const normalized = value.trim().toLowerCase();',
              '  return normalized.replace(/\\\\b\\\\w/g, (char) => char.toUpperCase());',
              '}',
              '',
              'module.exports = { toTitleCase };`',
              'Write src/user-label.cjs with exactly this CommonJS module:',
              '`const { toTitleCase } = require(\'./text-utils.cjs\');',
              '',
              'function buildUserLabel(first, last) {',
              '  return `${toTitleCase(first)} ${toTitleCase(last)}`;',
              '}',
              '',
              'module.exports = { buildUserLabel };`',
              'If your response contains read_file, list_files, or search_files again, it will be rejected.'
            ].join(' ');
          case 'test-repair':
            return 'Stop analyzing. In this turn, do not call read_file, list_files, or search_files. Emit exactly one write_file for tests/number.test.cjs with the required CommonJS import lines and the repaired odd-number assertion, do not edit src/is-even.cjs, then run the exact command npm test, then emit exactly one tracker JSON block with status COMPLETE.';
          case 'regression-diagnosis':
            return 'Stop analyzing. In this turn, do not call read_file, list_files, or search_files first. Emit exactly one write_file for reports/diagnosis.md that explicitly mentions locale, cache, and user:42 evidence, then emit exactly one tracker JSON block with status COMPLETE.';
          default:
            break;
        }
      }
      switch (family) {
        case 'bugfix':
          return 'Emit real tool actions for AGENT-002 in this order: write_file on src/math.cjs if needed, then run the exact command npm test, then one tracker JSON block. Do not claim COMPLETE until npm test succeeds.';
        case 'refactor':
          return 'Emit real tool actions for AGENT-002: write_file src/text-utils.cjs and update src/user-label.cjs so buildUserLabel("  ada", "LOVELACE ") returns exactly "Ada Lovelace" with no trailing space, then run the exact command npm test, then one tracker JSON block. Do not claim COMPLETE until npm test succeeds.';
        case 'test-repair':
          return 'Emit real tool actions for AGENT-002: rewrite only tests/number.test.cjs to exactly this final content with normal newlines: `const test = require(\'node:test\');`, `const assert = require(\'node:assert/strict\');`, `const { isEven } = require(\'../src/is-even.cjs\');`, a blank line, then `test(\'isEven returns false for odd numbers\', () => {`, then `  assert.equal(isEven(3), false);`, then `});`. Do not edit src/is-even.cjs. Then run the exact command npm test, then one tracker JSON block. Do not claim COMPLETE until npm test succeeds.';
        case 'regression-diagnosis':
          return 'Emit the required write_file tool action for reports/diagnosis.md first, then exactly one tracker JSON block. Do not claim COMPLETE until reports/diagnosis.md exists.';
        case 'multi-file-implementation':
          return 'Emit real tool actions for AGENT-002: write src/slugify.cjs and also write src/index.cjs so it still exports buildArticlePath through CommonJS. Do not edit tests/article-path.test.cjs or package.json. Then run the exact command npm test, then one tracker JSON block. Do not claim COMPLETE until npm test succeeds.';
        default:
          break;
      }
    }
    if (currentUnitId === 'AGENT-003') {
      switch (family) {
        case 'bugfix':
          return 'Verification must read src/math.cjs and run the exact command npm test before any COMPLETE tracker. Confirm add(a, b) returns a + b. Do not edit files during verification. If npm test fails, do not claim tests pass.';
        case 'refactor':
          if (latestFailedRunSummary?.includes('Ada Lovelace ')) {
            return 'Your last npm test still failed because the label contains a trailing space: actual "Ada Lovelace " vs expected "Ada Lovelace". Re-run only the exact command npm test after the implementation is corrected; do not claim COMPLETE while that mismatch remains.';
          }
          return 'Verification must read src/text-utils.cjs and src/user-label.cjs, then run the exact command npm test before any COMPLETE tracker. Confirm CommonJS exports still work and the refactor removed trailing-space behavior. Do not edit files during verification. If npm test fails, do not claim tests pass.';
        case 'test-repair':
          if (/TypeError: isEven is not a function/i.test(latestFailedRunSummary ?? '')) {
            return 'Your last npm test failed because the repaired test no longer imports isEven correctly. The implementation file must remain unchanged, and tests/number.test.cjs must keep `const { isEven } = require(\'../src/is-even.cjs\');`. Re-run only the exact command npm test and do not claim COMPLETE while that import mismatch remains.';
          }
          return 'Verification must read tests/number.test.cjs and src/is-even.cjs, confirm the CommonJS require lines stayed exactly as originally provided, then run the exact command npm test before any COMPLETE tracker. Do not edit files during verification. If npm test fails or the import/assert boilerplate changed, do not claim success.';
        case 'multi-file-implementation':
          return 'Verification must read src/slugify.cjs and src/index.cjs, then run the exact command npm test before any COMPLETE tracker. Confirm buildArticlePath still exports through CommonJS and delegates to slugify(title). Do not edit files during verification. If npm test fails, do not claim tests pass.';
        case 'regression-diagnosis':
          return 'Emit the verification tool action first. Read reports/diagnosis.md before any COMPLETE tracker.';
        default:
          break;
      }
    }
    return 'Emit the required machine-readable tool action first, then exactly one tracker JSON block. Do not claim COMPLETE before the tool action is real.';
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_OUTPUT_CORRECTION') {
    if (diagnostics.lastAcceptanceFailureCategory === 'provider_style_incompatibility') {
      return 'Stay within the current unit role. If this is analysis, do not claim implementation or final completion. Return only the required explicit output block and tracker for the current unit.';
    }
    if (currentUnitId === 'AGENT-002') {
      switch (family) {
        case 'bugfix':
          return 'Do not emit any new tool blocks in this correction. The prior tool actions remain valid. Return exactly one AGENT-002 explicit output block that names src/math.cjs, then exactly one tracker JSON block.';
      case 'refactor':
        return 'Do not emit any new tool blocks in this correction. The prior tool actions remain valid. Return exactly one AGENT-002 explicit output block that references src/text-utils.cjs and src/user-label.cjs and states the result has no trailing spaces, then exactly one tracker JSON block.';
      case 'test-repair':
        return 'Do not emit any new tool blocks in this correction. The prior tool actions remain valid. Return exactly one AGENT-002 explicit output block that names tests/number.test.cjs and states the file now contains the exact `node:test`, `node:assert/strict`, and `isEven` require lines while only the odd-number assertion was repaired, then exactly one tracker JSON block.';
        case 'regression-diagnosis':
          return 'Do not emit any new tool blocks in this correction. The prior tool actions remain valid. Return exactly one AGENT-002 explicit output block that names reports/diagnosis.md and includes locale/cache/user:42 root-cause language, then exactly one tracker JSON block.';
        case 'multi-file-implementation':
          return 'Do not emit any new tool blocks in this correction. The prior tool actions remain valid. Return exactly one AGENT-002 explicit output block that references src/slugify.cjs and src/index.cjs and states that tests/article-path.test.cjs was not modified, then exactly one tracker JSON block.';
        default:
          break;
      }
    }
    if (currentUnitId === 'AGENT-003') {
      switch (family) {
        case 'regression-diagnosis':
          return 'Do not emit any new tool blocks in this correction. Return exactly one AGENT-001 explicit output block with only summary and issues keys, then exactly one tracker JSON block. Do not include markdown headings, code fences, or prose outside the explicit output block.';
        case 'bugfix':
          return 'Do not emit any new tool blocks in this correction. The prior verification tools remain valid. Return exactly one AGENT-003 explicit output block that names src/math.cjs and states npm test passed, then exactly one tracker JSON block.';
        case 'refactor':
          return 'Do not emit any new tool blocks in this correction. The prior verification tools remain valid. Return exactly one AGENT-003 explicit output block that names src/text-utils.cjs and src/user-label.cjs and states the helper extraction preserved behavior, then exactly one tracker JSON block.';
        case 'test-repair':
          return 'Do not emit any new tool blocks in this correction. The prior verification tools remain valid. Return exactly one AGENT-003 explicit output block that names tests/number.test.cjs and confirms the original CommonJS require lines stayed intact while only the odd-number assertion was repaired, then exactly one tracker JSON block.';
        case 'multi-file-implementation':
          return 'Do not emit any new tool blocks in this correction. The prior verification tools remain valid. Return exactly one AGENT-003 explicit output block that names src/slugify.cjs and src/index.cjs and states npm test passed without editing tests/article-path.test.cjs, then exactly one tracker JSON block.';
        default:
          break;
      }
    }
    return 'Do not emit any new tool blocks in this correction. Return exactly one corrected explicit output block for the current unit, then exactly one tracker JSON block.';
  }
  if (currentUnitId === 'AGENT-002') {
    switch (family) {
      case 'bugfix':
        return 'Modify only src/math.cjs. Use write_file on src/math.cjs, then run the exact command npm test. Do not mark COMPLETE until npm test succeeds.';
      case 'refactor':
        return 'Create src/text-utils.cjs and update src/user-label.cjs. Keep CommonJS exports. Normalize each name with trim().toLowerCase() before title-casing, and do not leave trailing spaces in the final label. Use write_file for the changed files, then run the exact command npm test. Do not mark COMPLETE until npm test succeeds.';
      case 'test-repair':
        return 'Modify only tests/number.test.cjs. Rewrite it to exactly this final content with normal newlines: `const test = require(\'node:test\');`, `const assert = require(\'node:assert/strict\');`, `const { isEven } = require(\'../src/is-even.cjs\');`, a blank line, then `test(\'isEven returns false for odd numbers\', () => {`, then `  assert.equal(isEven(3), false);`, then `});`. Do not change src/is-even.cjs. Run the exact command npm test and do not mark COMPLETE until it succeeds.';
      case 'regression-diagnosis':
        return 'Write reports/diagnosis.md with write_file. The report must explicitly mention locale, cache, and user:42 root-cause evidence. Do not mark COMPLETE until the file exists.';
      case 'multi-file-implementation':
        return 'Create src/slugify.cjs and rewrite src/index.cjs so it still exports buildArticlePath via CommonJS and calls slugify(title). Do not edit tests/article-path.test.cjs or package.json. After the real tool actions, return one AGENT-002 explicit output block with a short summary and the primary artifact path, then one tracker JSON block. Use write_file on both implementation files, then run the exact command npm test. Do not mark COMPLETE until npm test succeeds.';
      default:
        break;
    }
  }
  if (currentUnitId === 'AGENT-003') {
    switch (family) {
      case 'bugfix':
        return 'Verification must read src/math.cjs and run the exact command npm test before COMPLETE. Confirm add(a, b) returns a + b. Do not edit any files during verification. If npm test fails, do not claim tests pass and do not mark COMPLETE.';
      case 'refactor':
        return 'Verification must read src/text-utils.cjs and src/user-label.cjs, then run the exact command npm test before COMPLETE. Confirm CommonJS exports still work and buildUserLabel("  ada", "LOVELACE ") resolves to exactly "Ada Lovelace". Do not edit any files during verification.';
      case 'test-repair':
        return 'Verification must read tests/number.test.cjs and src/is-even.cjs before COMPLETE. Confirm tests/number.test.cjs still contains exactly `const test = require(\'node:test\');`, `const assert = require(\'node:assert/strict\');`, and `const { isEven } = require(\'../src/is-even.cjs\');`, then run the exact command npm test. Do not edit any files during verification.';
      case 'multi-file-implementation':
        return 'Verification must read src/slugify.cjs and src/index.cjs, then run the exact command npm test before COMPLETE. Confirm buildArticlePath still exports through CommonJS and delegates to slugify(title). Do not edit any files during verification.';
      case 'regression-diagnosis':
        return 'Read reports/diagnosis.md and verify it explicitly mentions locale, cache, and user:42 evidence before COMPLETE.';
      default:
        break;
    }
  }
  return undefined;
}

function createLiveProviderScenarioDefinitions(): LiveProviderScenarioDefinition[] {
  return [
    {
      name: 'live-provider-bugfix',
      family: 'bugfix',
      description: 'Fix a real arithmetic bug and prove the artifact quality with tests and content assertions.',
      intent: [
        'You are fixing a real bug in a tiny Node workspace.',
        'The failing project is already in the task workspace.',
        'Keep the exported API name add(a, b) unchanged. The bug is that add currently subtracts instead of summing.',
        'Fix the implementation in src/math.cjs so npm test passes.',
        'Do not weaken the tests. Use the run_command tool with the exact command "npm test" if you need execution evidence.',
        'Keep edits minimal and focused on the bug.'
      ].join(' '),
      units: [
        createUnit({ id: 'AGENT-001', role: 'Bug Analyst', goal: 'Understand the failing arithmetic behavior and plan the fix.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Bug Fixer', goal: 'Patch src/math.cjs and use tools to verify the workspace.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Bug Verifier', goal: 'Confirm the bugfix and summarize the changed artifact.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      fixtureFiles: {
        'package.json': JSON.stringify({
          name: 'live-bugfix-fixture',
          private: true,
          type: 'commonjs',
          scripts: {
            test: 'node --test --test-isolation=none tests/*.test.cjs'
          }
        }, null, 2),
        'src/math.cjs': 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
        'tests/math.test.cjs': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\nconst { add } = require(\'../src/math.cjs\');\n\ntest(\'add returns a sum\', () => {\n  assert.equal(add(2, 3), 5);\n});\n'
      },
      allowedCommands: ['npm test'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      artifactFiles: ['src/math.cjs', 'tests/math.test.cjs'],
        async acceptance(harness, task) {
          const result = harness.runAllowedCommand('npm test');
          if (result.status !== 0) {
          return createFailureAcceptance(
            `npm test failed: ${(result.stderr || result.stdout).trim()}`.trim(),
            'acceptance_command_failed',
            {
              files: ['src/math.cjs', 'tests/math.test.cjs'],
              testsPassed: false,
              contentAssertionsPassed: null,
              diffAssertionsPassed: null
            }
          );
        }
        const implementation = await readArtifactTextWithFallback(harness, task, 'src/math.cjs');
        if (!implementation) {
          return createFailureAcceptance(
            'src/math.cjs could not be read after verification started.',
            'artifact_missing',
            {
              files: ['src/math.cjs', 'tests/math.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
            }
          );
        }
        if (!implementation.includes('a + b')) {
          return createFailureAcceptance(
            'src/math.cjs does not contain the expected arithmetic fix.',
            'content_assertion_failed',
            {
              files: ['src/math.cjs', 'tests/math.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: true
            }
          );
        }
        return createPassedAcceptance('Arithmetic bug fixed and verified by npm test.', ['src/math.cjs', 'tests/math.test.cjs']);
      }
    },
    {
      name: 'live-provider-refactor',
      family: 'refactor',
      description: 'Refactor duplicated formatting logic into a helper while preserving behavior.',
      intent: [
        'Refactor the Node workspace in place.',
        'Extract the duplicated formatting logic in src/user-label.cjs into a reusable helper file at src/text-utils.cjs.',
        'Keep the exported API exactly as buildUserLabel(first, last). Do not rename exported functions or change the call signature.',
        'Preserve the exact behavior: buildUserLabel("  ada", "LOVELACE ") must still produce "Ada Lovelace".',
        'The final string must not contain trailing spaces. Normalize each input with trim().toLowerCase() before title-casing, or use an equivalent approach that yields exactly "Ada Lovelace".',
        'Keep the workspace in CommonJS form. src/user-label.cjs must continue exporting { buildUserLabel }.',
        'Keep the observable behavior identical and make npm test pass.',
        'Use the run_command tool with the exact command "npm test" if you need runtime verification.'
      ].join(' '),
      units: [
        createUnit({ id: 'AGENT-001', role: 'Refactor Analyst', goal: 'Identify duplication and define the safe refactor.', profile: 'analyze', dependencies: [] }),
        createUnit({
          id: 'AGENT-002',
          role: 'Refactor Implementer',
          goal: 'Extract the helper and update the calling module.',
          profile: 'implement',
          dependencies: ['AGENT-001'],
          taskScope: 'Implementation phase. Use real write/read/run tools. Create src/text-utils.cjs and update src/user-label.cjs. Keep CommonJS exports. src/user-label.cjs must require "./text-utils.cjs" explicitly, not "./text-utils". Normalize each input with trim().toLowerCase() before title-casing so buildUserLabel("  ada", "LOVELACE ") returns exactly "Ada Lovelace". Then run npm test and return one explicit output block followed by one COMPLETE tracker.'
        }),
        createUnit({
          id: 'AGENT-003',
          role: 'Refactor Verifier',
          goal: 'Verify the refactor result and summarize the artifact.',
          profile: 'verify',
          dependencies: ['AGENT-002'],
          taskScope: 'Verification phase. Read src/text-utils.cjs and src/user-label.cjs, confirm src/user-label.cjs still exports buildUserLabel and requires "./text-utils.cjs", then run npm test. Do not modify files during verification.'
        })
      ],
      fixtureFiles: {
        'package.json': JSON.stringify({
          name: 'live-refactor-fixture',
          private: true,
          type: 'commonjs',
          scripts: {
            test: 'node --test --test-isolation=none tests/*.test.cjs'
          }
        }, null, 2),
        'src/user-label.cjs': 'function formatPrimary(name) {\n  const normalized = name.trim().toLowerCase();\n  return normalized.replace(/\\b\\w/g, (char) => char.toUpperCase());\n}\n\nfunction formatSecondary(name) {\n  const normalized = name.trim().toLowerCase();\n  return normalized.replace(/\\b\\w/g, (char) => char.toUpperCase());\n}\n\nfunction buildUserLabel(first, last) {\n  return `${formatPrimary(first)} ${formatSecondary(last)}`;\n}\n\nmodule.exports = { buildUserLabel };\n',
        'tests/user-label.test.cjs': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\nconst { buildUserLabel } = require(\'../src/user-label.cjs\');\n\ntest(\'buildUserLabel normalizes names\', () => {\n  assert.equal(buildUserLabel(\'  ada\', \'LOVELACE \'), \'Ada Lovelace\');\n});\n'
      },
      allowedCommands: ['npm test'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      artifactFiles: ['src/user-label.cjs', 'src/text-utils.cjs'],
      async acceptance(harness, task) {
        const result = harness.runAllowedCommand('npm test');
        if (result.status !== 0) {
          return createFailureAcceptance(
            `npm test failed: ${(result.stderr || result.stdout).trim()}`.trim(),
            'acceptance_command_failed',
            {
              files: ['src/user-label.cjs', 'src/text-utils.cjs'],
              testsPassed: false
            }
          );
        }
        const helperText = await readArtifactTextWithFallback(harness, task, 'src/text-utils.cjs');
        if (!helperText) {
          return createFailureAcceptance(
            'Expected refactor helper src/text-utils.cjs was not created.',
            'artifact_missing',
            {
              files: ['src/user-label.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        const moduleText = await readArtifactTextWithFallback(harness, task, 'src/user-label.cjs');
        if (!moduleText) {
          return createFailureAcceptance(
            'src/user-label.cjs could not be read after verification started.',
            'artifact_missing',
            {
              files: ['src/user-label.cjs', 'src/text-utils.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        if (!/text-utils/.test(moduleText) || !/buildUserLabel/.test(moduleText)) {
          return createFailureAcceptance(
            'src/user-label.cjs does not reference the extracted helper.',
            'content_assertion_failed',
            {
              files: ['src/user-label.cjs', 'src/text-utils.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        return createPassedAcceptance('Refactor helper extracted and behavior preserved.', ['src/user-label.cjs', 'src/text-utils.cjs']);
      }
    },
    {
      name: 'live-provider-test-repair',
      family: 'test-repair',
      description: 'Repair the test suite without mutating the already-correct implementation.',
      intent: [
        'Repair only the failing tests in this Node workspace.',
        'The implementation file src/is-even.cjs is already correct and must not be changed.',
        'The repaired assertion in tests/number.test.cjs must check that isEven(3) is false.',
        'Preserve the existing CommonJS imports and Node test harness boilerplate. Only repair the broken test expectation.',
        'Keep this import line exactly: const { isEven } = require(\'../src/is-even.cjs\');',
        'The final tests/number.test.cjs file must contain exactly these require lines in this order: `const test = require(\'node:test\');`, `const assert = require(\'node:assert/strict\');`, and `const { isEven } = require(\'../src/is-even.cjs\');`.',
        'The final test body must be exactly `test(\'isEven returns false for odd numbers\', () => {` followed by `  assert.equal(isEven(3), false);` and then `});`.',
        'The simplest correct edit is to change only the test description and the assertion so the file still exports the same require/test/assert structure.',
        'Make npm test pass by fixing tests/number.test.cjs only.',
        'Use the run_command tool with the exact command "npm test" if you need runtime verification.'
      ].join(' '),
      units: [
        createUnit({ id: 'AGENT-001', role: 'Test Analyst', goal: 'Identify why the current tests are wrong.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Test Repairer', goal: 'Repair the test file without changing implementation.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Test Verifier', goal: 'Verify the repaired test suite and summarize the result.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      fixtureFiles: {
        'package.json': JSON.stringify({
          name: 'live-test-repair-fixture',
          private: true,
          type: 'commonjs',
          scripts: {
            test: 'node --test --test-isolation=none tests/*.test.cjs'
          }
        }, null, 2),
        'src/is-even.cjs': 'function isEven(value) {\n  return value % 2 === 0;\n}\n\nmodule.exports = { isEven };\n',
        'tests/number.test.cjs': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\nconst { isEven } = require(\'../src/is-even.cjs\');\n\ntest(\'isEven returns true for odd numbers\', () => {\n  assert.equal(isEven(3), true);\n});\n'
      },
      allowedCommands: ['npm test'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      artifactFiles: ['tests/number.test.cjs'],
      async acceptance(harness, task) {
        const result = harness.runAllowedCommand('npm test');
        if (result.status !== 0) {
          return createFailureAcceptance(
            `npm test failed: ${(result.stderr || result.stdout).trim()}`.trim(),
            'acceptance_command_failed',
            {
              files: ['src/is-even.cjs', 'tests/number.test.cjs'],
              testsPassed: false
            }
          );
        }
        const sourceText = await readArtifactTextWithFallback(harness, task, 'src/is-even.cjs');
        if (!sourceText) {
          return createFailureAcceptance(
            'src/is-even.cjs could not be read after verification started.',
            'artifact_missing',
            {
              files: ['src/is-even.cjs', 'tests/number.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
            }
          );
        }
        if (hashText(sourceText) !== harness.getBaselineHash('src/is-even.cjs')) {
          return createFailureAcceptance(
            'src/is-even.cjs changed, but this scenario requires a test-only repair.',
            'content_assertion_failed',
            {
              files: ['src/is-even.cjs', 'tests/number.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
            }
          );
        }
        const testText = await readArtifactTextWithFallback(harness, task, 'tests/number.test.cjs');
          if (!testText) {
            return createFailureAcceptance(
              'tests/number.test.cjs could not be read after verification started.',
              'artifact_missing',
            {
              files: ['tests/number.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
              }
            );
          }
          if (!/const test = require\('node:test'\);/.test(testText) || !/const assert = require\('node:assert\/strict'\);/.test(testText)) {
            return createFailureAcceptance(
              'The repaired test changed the required CommonJS test/assert import shape instead of keeping the existing boilerplate.',
              'content_assertion_failed',
              {
                files: ['tests/number.test.cjs'],
                testsPassed: true,
                contentAssertionsPassed: false,
                diffAssertionsPassed: false
              }
            );
          }
          if (!/const \{ isEven \} = require\('\.\.\/src\/is-even\.cjs'\);/.test(testText)) {
            return createFailureAcceptance(
              'The repaired test changed the required implementation import line.',
              'content_assertion_failed',
              {
                files: ['tests/number.test.cjs'],
                testsPassed: true,
                contentAssertionsPassed: false,
                diffAssertionsPassed: false
              }
            );
          }
          if (!/isEven\(3\), false/.test(testText)) {
            return createFailureAcceptance(
              'The repaired test does not assert the expected odd-number behavior.',
            'content_assertion_failed',
            {
              files: ['tests/number.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        return createPassedAcceptance('Test-only repair succeeded and implementation remained untouched.', ['tests/number.test.cjs'], {
          diffAssertionsPassed: true
        });
      }
    },
    {
      name: 'live-provider-regression-diagnosis',
      family: 'regression-diagnosis',
      description: 'Diagnose a real regression and produce a structured operator-facing report.',
      intent: [
        'Investigate the regression evidence in this workspace and create reports/diagnosis.md.',
        'The report must identify the likely root cause and mention why locale-specific cache behavior is broken.',
        'The report must explicitly mention locale, cache, and user:42 evidence in the final markdown artifact.',
        'Use the existing logs and source files. You do not need to implement the fix in code for this scenario.',
        'Produce a concise, evidence-backed diagnosis artifact.'
      ].join(' '),
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Regression Analyst',
          goal: 'Collect evidence from logs and source files.',
          profile: 'analyze',
          dependencies: [],
          taskScope: 'Analysis only. Read logs/runtime.log and src/cache.cjs, then return one concise explicit output block with summary and issues only. Do not include markdown headings, fenced code blocks, or implementation claims in the analysis output.',
          outputContract: '{"summary":"string","issues":[]}',
          exitCondition: '{"summary":"required"}'
        }),
        createUnit({
          id: 'AGENT-002',
          role: 'Diagnosis Writer',
          goal: 'Write the diagnosis report into reports/diagnosis.md.',
          profile: 'implement',
          dependencies: ['AGENT-001'],
          taskScope: 'Implementation phase. Use one real write_file action to create reports/diagnosis.md. The markdown must explicitly mention locale, cache, and user:42 evidence, and explain that the cache key omits locale. Do not stay in analysis mode once this unit starts. After the write_file action, return one explicit output block and one COMPLETE tracker.'
        }),
        createUnit({
          id: 'AGENT-003',
          role: 'Diagnosis Verifier',
          goal: 'Verify that the report captures the actual root cause.',
          profile: 'verify',
          dependencies: ['AGENT-002'],
          taskScope: 'Verification phase. Read reports/diagnosis.md and confirm it explicitly mentions locale, cache, and user:42 evidence. Do not modify files during verification.'
        })
      ],
      fixtureFiles: {
        'logs/runtime.log': 'INFO request locale=en-US cacheKey=user:42\nINFO request locale=fr-FR cacheKey=user:42\nWARN cache hit reused stale English payload for French response\n',
        'src/cache.cjs': 'function buildCacheKey(userId, locale) {\n  return `user:${userId}`;\n}\n\nmodule.exports = { buildCacheKey };\n'
      },
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TASK_COMPLETED'],
      artifactFiles: ['reports/diagnosis.md'],
      async acceptance(harness, task) {
        const exists = await harness.fileExists('reports/diagnosis.md');
        let report: string | null = null;
        if (exists) {
          try {
            report = await harness.readWorkspaceFile('reports/diagnosis.md');
          } catch {
            report = null;
          }
        }
        if (!report) {
          report = findLatestSuccessfulToolText(task, 'reports/diagnosis.md');
        }
        if (!report) {
          return createFailureAcceptance(
            exists
              ? 'reports/diagnosis.md could not be read after verification started.'
              : 'reports/diagnosis.md was not produced.',
            'artifact_missing',
            {
              files: exists ? ['reports/diagnosis.md'] : [],
              testsPassed: null,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
            }
          );
        }
        const hasKeywords = /locale/i.test(report) && /cache/i.test(report) && /user:42|userId/i.test(report);
        if (!hasKeywords) {
          return createFailureAcceptance(
            'Diagnosis report is missing the expected cache/locale root-cause language.',
            'content_assertion_failed',
            {
              files: ['reports/diagnosis.md'],
              testsPassed: null,
              contentAssertionsPassed: false,
              diffAssertionsPassed: true
            }
          );
        }
        return createPassedAcceptance('Diagnosis artifact identifies the locale cache-key regression.', ['reports/diagnosis.md'], {
          testsPassed: null,
          diffAssertionsPassed: true
        });
      }
    },
    {
      name: 'live-provider-multi-file-implementation',
      family: 'multi-file-implementation',
      description: 'Implement a missing feature across multiple files and verify the final artifact with tests.',
      intent: [
        'Implement the missing article-path feature in this Node workspace.',
        'Create src/slugify.cjs and wire it into src/index.cjs so npm test passes.',
        'Keep the exported API exactly as buildArticlePath(title), and make src/slugify.cjs export { slugify } so the existing import shape stays valid.',
        'Keep the workspace in CommonJS form. Do not convert src/index.cjs or src/slugify.cjs to ESM.',
        'src/index.cjs must continue exporting { buildArticlePath } and requiring "./slugify.cjs" with CommonJS syntax.',
        'The expected behavior is buildArticlePath("Hello SCC Batch") === "/articles/hello-scc-batch".',
        'Keep the implementation small, deterministic, and ASCII-safe.',
        'Use the run_command tool with the exact command "npm test" if you need runtime verification.'
      ].join(' '),
      units: [
        createUnit({ id: 'AGENT-001', role: 'Feature Analyst', goal: 'Understand the missing multi-file feature.', profile: 'analyze', dependencies: [] }),
        createUnit({
          id: 'AGENT-002',
          role: 'Feature Implementer',
          goal: 'Implement slugify and integrate it into the entry module.',
          profile: 'implement',
          dependencies: ['AGENT-001'],
          taskScope: 'Implementation phase. Use real write/read/run tools. Create src/slugify.cjs and ensure src/index.cjs still exports buildArticlePath via CommonJS and delegates to slugify(title). Do not edit tests/article-path.test.cjs or package.json. Then return one concise explicit output block with summary and the main artifact path before the tracker. Do not skip the explicit output block after tool execution.',
          outputContract: '{"summary":"string","artifact":"string"}',
          exitCondition: '{"artifact":"required"}'
        }),
        createUnit({
          id: 'AGENT-003',
          role: 'Feature Verifier',
          goal: 'Verify the feature and summarize the resulting artifacts.',
          profile: 'verify',
          dependencies: ['AGENT-002'],
          taskScope: 'Verification phase. Read src/slugify.cjs and src/index.cjs, then run npm test. Do not modify files during verification. Return one explicit output block and one tracker.'
        })
      ],
      fixtureFiles: {
        'package.json': JSON.stringify({
          name: 'live-multi-file-fixture',
          private: true,
          type: 'commonjs',
          scripts: {
            test: 'node --test --test-isolation=none tests/*.test.cjs'
          }
        }, null, 2),
        'src/index.cjs': 'const { slugify } = require(\'./slugify.cjs\');\n\nfunction buildArticlePath(title) {\n  return `/articles/${slugify(title)}`;\n}\n\nmodule.exports = { buildArticlePath };\n',
        'tests/article-path.test.cjs': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\nconst { buildArticlePath } = require(\'../src/index.cjs\');\n\ntest(\'buildArticlePath slugifies the article title\', () => {\n  assert.equal(buildArticlePath(\'Hello SCC Batch\'), \'/articles/hello-scc-batch\');\n});\n'
      },
      allowedCommands: ['npm test'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      artifactFiles: ['src/index.cjs', 'src/slugify.cjs', 'tests/article-path.test.cjs'],
      async acceptance(harness, task) {
        const result = harness.runAllowedCommand('npm test');
        if (result.status !== 0) {
          return createFailureAcceptance(
            `npm test failed: ${(result.stderr || result.stdout).trim()}`.trim(),
            'acceptance_command_failed',
            {
              files: ['src/index.cjs', 'tests/article-path.test.cjs'],
              testsPassed: false
            }
          );
        }
          const slugifyText = await readArtifactTextWithFallback(harness, task, 'src/slugify.cjs');
          if (!slugifyText) {
          return createFailureAcceptance(
            'Missing expected implementation file src/slugify.cjs.',
            'artifact_missing',
            {
              files: ['src/index.cjs', 'tests/article-path.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
          }
          const indexText = (await readArtifactTextWithFallback(harness, task, 'src/index.cjs'))
            ?? harness.getFixtureText('src/index.cjs');
          if (!indexText) {
            return createFailureAcceptance(
              'src/index.cjs could not be read after verification started.',
            'artifact_missing',
            {
              files: ['src/index.cjs', 'src/slugify.cjs', 'tests/article-path.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false,
              diffAssertionsPassed: false
            }
          );
        }
        if (!/toLowerCase\(\)|replace/.test(slugifyText) || !/module\.exports\s*=\s*\{\s*slugify\s*\}/.test(slugifyText)) {
          return createFailureAcceptance(
            'src/slugify.cjs does not look like a slugification implementation.',
            'content_assertion_failed',
            {
              files: ['src/index.cjs', 'src/slugify.cjs', 'tests/article-path.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        if (!/require\(['"]\.\/slugify\.cjs['"]\)/.test(indexText) || !/module\.exports\s*=\s*\{\s*buildArticlePath\s*\}/.test(indexText)) {
          return createFailureAcceptance(
            'src/index.cjs does not preserve the required CommonJS buildArticlePath export shape.',
            'content_assertion_failed',
            {
              files: ['src/index.cjs', 'src/slugify.cjs', 'tests/article-path.test.cjs'],
              testsPassed: true,
              contentAssertionsPassed: false
            }
          );
        }
        return createPassedAcceptance('Multi-file implementation passed tests and created the slugify artifact.', ['src/index.cjs', 'src/slugify.cjs', 'tests/article-path.test.cjs']);
      }
    }
  ];
}

async function resolveLiveProvider(
  projectRoot: string,
  env: NodeJS.ProcessEnv
): Promise<LiveProviderSelection> {
  if (!isEnabled(env)) {
    return {
      summary: null,
      blocker: 'live provider execution is disabled; set BACKEND_NEW_LIVE_PROVIDER_ENABLED=1 to run flagship quality scenarios'
    };
  }

  const bootstrapRoot = createTempRoot('backend-new-live-provider-bootstrap-');
  const manifestPath = resolveLiveProviderManifestPath(projectRoot, env);
  const foundation = createBackendNewFoundation({
    cwd: projectRoot,
    env,
    config: {
      paths: {
        rootDir: bootstrapRoot
      },
      providers: {
        manifestFile: manifestPath
      }
    }
  });
  const runtime = createBackendNewRuntime({ foundation });
  try {
    const providerViews = await runtime.platform.listProviders();
    const selected = selectLiveProviderView(providerViews, foundation.config.providers.defaultProviderId, env.BACKEND_NEW_LIVE_PROVIDER_ID);
    if (!selected) {
      return {
        summary: null,
        blocker: 'no live provider is configured in the provider manifest'
      };
    }
    await seedLiveProviderSecretIfNeeded(foundation, selected.profile, env);
    let testResult;
    try {
      testResult = await runtime.platform.testProvider(selected.profile.id);
    } catch (error) {
      return {
        summary: null,
        blocker: error instanceof Error ? error.message : String(error)
      };
    }
    if (!testResult.ok) {
      return {
        summary: null,
        blocker: testResult.message
      };
    }
    return {
      summary: {
        enabled: true,
        providerId: selected.profile.id,
        model: selected.profile.model,
        transport: selected.profile.transport ?? 'unknown',
        requestTimeoutMs: foundation.config.providers.requestTimeoutMs,
        maxRetries: foundation.config.providers.maxRetries,
        retryBackoffMs: foundation.config.providers.retryBackoffMs
      },
      blocker: null
    };
  } finally {
    await runtime.close();
    removeDir(bootstrapRoot);
  }
}

function selectLiveProviderView(
  views: ProviderProfileView[],
  configuredDefaultProviderId: string | null,
  explicitProviderId: string | undefined
): ProviderProfileView | null {
  const exact = explicitProviderId
    ? views.find((view) => view.profile.id === explicitProviderId)
    : null;
  if (exact) {
    return exact;
  }
  const configuredDefault = configuredDefaultProviderId
    ? views.find((view) => view.profile.id === configuredDefaultProviderId)
    : null;
  if (configuredDefault) {
    return configuredDefault;
  }
  const xiaomiPreferred = views.find((view) => view.profile.id === 'xiaomi-mimo-v2-flash');
  if (xiaomiPreferred) {
    return xiaomiPreferred;
  }
  return views[0] ?? null;
}

async function seedLiveProviderSecretIfNeeded(
  foundation: BackendNewFoundation,
  profile: ProviderProfileView['profile'],
  env: NodeJS.ProcessEnv
): Promise<void> {
  if (!profile.apiKeySecretId?.trim()) {
    return;
  }
  const apiKey = env.BACKEND_NEW_LIVE_PROVIDER_API_KEY?.trim();
  if (!apiKey) {
    return;
  }
  const existing = await foundation.apiKeys.get(profile.apiKeySecretId);
  if (existing?.apiKey?.trim()) {
    return;
  }
  const now = Date.now();
  await foundation.apiKeys.save({
    id: profile.apiKeySecretId,
    provider: profile.id,
    label: `live-provider:${profile.id}`,
    apiKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    metadata: {
      source: 'live-provider-scenarios',
      ephemeral: true
    }
  });
}

async function createExternalBlockerResult(params: {
  scenario: string;
  family: LiveScenarioFamily;
  description: string;
  blocker: string;
  provider: LiveProviderExecutionSummary | null;
}): Promise<TaskLiveProviderScenarioResult> {
  const failureCategory = params.blocker.includes('disabled')
    ? 'provider_disabled'
    : classifyProviderBlocker(params.blocker);
  return {
    scenario: params.scenario,
    family: params.family,
    description: params.description,
    taskId: null,
    passed: false,
    finalLifecycleStatus: null,
    finalQueueState: null,
    issueCategory: null,
    issueSummary: params.blocker,
    missingRequiredEventTypes: [],
    observedHooks: [],
    executionSummary: null,
    provider: params.provider,
    artifactQuality: createExternalBlockerAcceptance(params.blocker, failureCategory),
    metrics: createEmptyMetrics(),
    diagnostics: await createScenarioDiagnostics(null, null, []),
    externalBlocker: params.blocker
  };
}

async function runSingleLiveScenario(
  definition: LiveProviderScenarioDefinition,
  provider: LiveProviderExecutionSummary,
  projectRoot: string,
  env: NodeJS.ProcessEnv
): Promise<TaskLiveProviderScenarioResult> {
  const harness = new LiveProviderScenarioHarness(definition, provider.providerId, projectRoot, env);
  try {
    await harness.submit();
    let task = await harness.start();
    if (definition.family === 'multi-file-implementation' && task.runtime.lifecycleStatus === 'RUNNING') {
      task = await driveToCompletion(harness, task, ['Focus on the smallest diff that satisfies the tests.']);
    } else {
      task = await driveToCompletion(harness, task);
    }
    return harness.finalize(task, provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const task = (() => {
      try {
        return harness.getTask();
      } catch {
        return null;
      }
    })();
    if (task) {
      const resolvedTask = await task.catch(() => null);
      if (resolvedTask) {
        return harness.finalize(resolvedTask, provider);
      }
    }
    const failureCategory = classifyProviderBlocker(message);
    const isProviderBlocker = isProviderOrEnvironmentBlockerMessage(message);
    return {
      scenario: definition.name,
      family: definition.family,
      description: definition.description,
      taskId: null,
      passed: false,
      finalLifecycleStatus: null,
      finalQueueState: null,
      issueCategory: null,
      issueSummary: message,
      missingRequiredEventTypes: [],
      observedHooks: [],
      executionSummary: null,
      provider,
      artifactQuality: isProviderBlocker
        ? createExternalBlockerAcceptance(message, failureCategory)
        : createFailureAcceptance(message, 'unknown'),
      metrics: createEmptyMetrics(),
      diagnostics: await createScenarioDiagnostics(null, null, definition.artifactFiles),
      externalBlocker: isProviderBlocker ? message : null
    };
  } finally {
    await harness.close();
  }
}

function computeSuiteStatus(result: TaskLiveProviderScenarioSuiteResult['totals'], blocker: string | null): TaskLiveProviderScenarioSuiteResult['status'] {
  if (blocker) {
    return 'external_blocker';
  }
  if (result.total > 0 && result.failed === 0 && result.externalBlocked === 0) {
    return 'achieved';
  }
  return 'open_gap';
}

export async function runTaskLiveProviderScenarioSuite(
  options: LiveProviderSuiteOptions = {}
): Promise<TaskLiveProviderScenarioSuiteResult> {
  const env = options.env ?? process.env;
  const projectRoot = options.cwd ?? process.cwd();
  const definitions = createLiveProviderScenarioDefinitions();
  const selection = await resolveLiveProvider(projectRoot, env);
  const scenarios: TaskLiveProviderScenarioResult[] = [];

  if (!selection.summary) {
    for (const definition of definitions) {
      scenarios.push(await createExternalBlockerResult({
        scenario: definition.name,
        family: definition.family,
        description: definition.description,
        blocker: selection.blocker ?? 'live provider unavailable',
        provider: null
      }));
    }
  } else {
    for (const definition of definitions) {
      scenarios.push(await runSingleLiveScenario(definition, selection.summary, projectRoot, env));
    }
  }

  let passed = 0;
  let failed = 0;
  let externalBlocked = 0;
  let totalApiCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCachedPromptTokens = 0;
  let totalCacheWritePromptTokens = 0;
  let totalExecutedBatches = 0;
  let totalToolsPerBatch = 0;
  let plannerFallbackScenarioCount = 0;
  const usageSourceCounts: Record<'returned' | 'estimated' | 'missing', number> = {
    returned: 0,
    estimated: 0,
    missing: 0
  };
  const usageBreakdown = {
    returnedCalls: 0,
    estimatedCalls: 0,
    missingCalls: 0
  };
  const byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>> = {};
  const byFamily: Record<LiveScenarioFamily, number> = {
    bugfix: 0,
    refactor: 0,
    'test-repair': 0,
    'regression-diagnosis': 0,
    'multi-file-implementation': 0
  };
  const byVerdict: Record<ArtifactQualityVerdict, number> = {
    passed: 0,
    failed: 0,
    external_blocker: 0
  };

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    totalApiCalls += scenario.metrics.apiCallCount;
    totalPromptTokens += scenario.metrics.promptTokens;
    totalCompletionTokens += scenario.metrics.completionTokens;
    totalTokens += scenario.metrics.totalTokens;
    totalCachedPromptTokens += scenario.metrics.cachedPromptTokens;
    totalCacheWritePromptTokens += scenario.metrics.cacheWritePromptTokens;
    usageSourceCounts[scenario.metrics.usageSource] += 1;
    usageBreakdown.returnedCalls += scenario.metrics.usageBreakdown.returnedCalls;
    usageBreakdown.estimatedCalls += scenario.metrics.usageBreakdown.estimatedCalls;
    usageBreakdown.missingCalls += scenario.metrics.usageBreakdown.missingCalls;
    totalExecutedBatches += scenario.metrics.executedToolBatchCount;
    totalToolsPerBatch += scenario.metrics.averageToolInvocationsPerBatch;
    if (scenario.metrics.plannerFallbackCount > 0) {
      plannerFallbackScenarioCount += 1;
    }
    if (scenario.issueCategory) {
      byIssueCategory[scenario.issueCategory] = (byIssueCategory[scenario.issueCategory] ?? 0) + 1;
    }
    if (scenario.artifactQuality.verdict === 'external_blocker') {
      externalBlocked += 1;
      byVerdict.external_blocker += 1;
    } else if (scenario.passed) {
      passed += 1;
      byVerdict.passed += 1;
    } else {
      failed += 1;
      byVerdict.failed += 1;
    }
  }

  const totals = {
    total: scenarios.length,
    passed,
    failed,
    externalBlocked,
    successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
    artifactQualityPassRate: Number((byVerdict.passed / Math.max(1, scenarios.length)).toFixed(4)),
    liveProviderPassRate: Number((passed / Math.max(1, scenarios.length - externalBlocked || 1)).toFixed(4)),
    totalApiCalls,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCachedPromptTokens,
    totalCacheWritePromptTokens,
    usageSourceCounts,
    usageBreakdown,
    averageApiCallCount: Number((totalApiCalls / Math.max(1, scenarios.length)).toFixed(4)),
    averageExecutedToolBatchCount: Number((totalExecutedBatches / Math.max(1, scenarios.length)).toFixed(4)),
    averageToolInvocationsPerBatch: Number((totalToolsPerBatch / Math.max(1, scenarios.length)).toFixed(4)),
    plannerFallbackScenarioCount,
    byIssueCategory,
    byFamily,
    byVerdict
  };

  return {
    generatedAt: Date.now(),
    status: computeSuiteStatus(totals, selection.blocker),
    provider: selection.summary,
    externalBlocker: selection.blocker,
    scenarios,
    totals
  };
}
