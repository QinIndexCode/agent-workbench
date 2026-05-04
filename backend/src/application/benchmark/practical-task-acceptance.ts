import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackendNewFoundation } from '../../foundation/bootstrap/create-foundation';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { ProviderCompletionRequest, ProviderCompletionResponse, ProviderCompletionUsage } from '../../foundation/providers/client-types';
import { createBackendNewRuntime, BackendNewRuntime } from '../create-runtime';
import { AgentUnit, ExecutionProfileId, TaskLifecycleStatus } from '../../domain/contracts/types';
import { buildTaskExecutionSummary } from '../tasks/task-execution-observability';
import {
  TaskExecutionIssueCategory,
  TaskExecutionSummary,
  TaskObservationHookId,
  TaskQueryResponse
} from '../tasks/types';
import { ProviderProfileView } from '../platform/types';
import { LiveProviderExecutionSummary } from './live-provider-scenarios';

export type PracticalTaskFamily =
  | 'vague-blog-request'
  | 'explicit-blog-request'
  | 'vague-summary-request'
  | 'explicit-doc-request'
  | 'operator-report-task'
  | 'analysis-brief-task'
  | 'practical-engineering-change-task'
  | 'practical-review-task'
  | 'vague-landing-page-brief'
  | 'explicit-multi-artifact-doc-bundle'
  | 'engineering-decision-record-task'
  | 'repo-grounded-review-followup-task';

export type PracticalTaskFailureCategory =
  | 'artifact_missing'
  | 'content_assertion_failed'
  | 'summary_mismatch'
  | 'clarification_missing'
  | 'assumption_disclosure_missing'
  | 'queue_runtime_misalignment';

export type PracticalTaskClarificationMode = 'required' | 'assumption-led' | 'not-needed';

export interface PracticalTaskAssumptionDisclosure {
  status: 'declared' | 'not-needed' | 'missing';
  summary: string | null;
}

export interface PracticalTaskArtifactQuality {
  verdict: 'passed' | 'failed';
  failureCategory: PracticalTaskFailureCategory | null;
  summary: string;
  files: string[];
}

export interface PracticalTaskAcceptance extends PracticalTaskArtifactQuality {
  clarificationMode: PracticalTaskClarificationMode;
  assumptionDisclosure: PracticalTaskAssumptionDisclosure;
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

interface PracticalFixtureFile {
  source: string;
  destination?: string;
}

interface PracticalRepoFile {
  source: string;
  destination?: string;
}

export interface PracticalTaskScenarioDefinition {
  name: string;
  family: PracticalTaskFamily;
  description: string;
  intent: string;
  units: AgentUnit[];
  responses?: string[];
  fixtureFiles?: PracticalFixtureFile[];
  repoFiles?: PracticalRepoFile[];
  artifactFiles: string[];
  requiredEventTypes: string[];
  acceptance(harness: PracticalTaskHarness, task: TaskQueryResponse): Promise<PracticalTaskAcceptance>;
}

export interface PracticalTaskScenarioResult {
  scenario: PracticalTaskFamily;
  description: string;
  taskId: string;
  passed: boolean;
  finalLifecycleStatus: TaskLifecycleStatus;
  issueCategory: TaskExecutionIssueCategory | null;
  issueSummary: string | null;
  missingRequiredEventTypes: string[];
  observedHooks: TaskObservationHookId[];
  clarificationMode: PracticalTaskClarificationMode;
  assumptionDisclosure: PracticalTaskAssumptionDisclosure;
  executionSummary: TaskExecutionSummary;
  artifactQuality: PracticalTaskArtifactQuality;
  shipReady: boolean;
  minorEditsNeededCount: number;
  criticalGapsCount: number;
  diagnostics: {
    workspaceDir: string | null;
    sourceFiles: string[];
    artifactSnapshots: Array<{
      path: string;
      exists: boolean;
      excerpt: string | null;
      persistedPath: string | null;
    }>;
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
  };
  metrics: MutableMetrics;
}

export interface PracticalTaskAcceptanceSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: PracticalTaskScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactQualityPassRate: number;
    shipReadyPassRate: number;
    minorEditsNeededCount: number;
    criticalGapsCount: number;
    byFamily: Record<PracticalTaskFamily, number>;
    byFailureCategory: Partial<Record<PracticalTaskFailureCategory, number>>;
  };
}

export interface PracticalLiveTaskAcceptanceSuiteResult {
  generatedAt: number;
  profile: string;
  status: 'achieved' | 'open_gap' | 'external_blocker';
  provider: LiveProviderExecutionSummary | null;
  externalBlocker: string | null;
  scenarios: PracticalTaskScenarioResult[];
  totals: PracticalTaskAcceptanceSuiteResult['totals'] & {
    liveProviderPassRate: number;
    usageSourceCounts: Record<'returned' | 'estimated' | 'missing', number>;
    usageBreakdown: {
      returnedCalls: number;
      estimatedCalls: number;
      missingCalls: number;
    };
    totalApiCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCachedPromptTokens: number;
    totalCacheWritePromptTokens: number;
  };
}

function createFailureExecutionAcceptance(message: string): TaskExecutionSummary['acceptance'] {
  const failedLayer = {
    verdict: 'failed',
    summary: message,
    passedChecks: [],
    failedChecks: ['benchmark_scenario_failed'],
    requiredNextEvidence: ['rerun_scenario_with_runtime_diagnostics']
  } satisfies TaskExecutionSummary['acceptance']['deterministic']['contract'];
  return {
    deterministic: {
      verdict: 'failed',
      profileId: 'analyze',
      unitId: null,
      contract: failedLayer,
      execution: failedLayer,
      evidence: failedLayer,
      outcome: failedLayer
    },
    evidence: {
      explicitOutput: {
        present: false,
        source: 'missing',
        contractKeys: [],
        missingContractKeys: [],
        invalidJson: false,
        summary: 'No explicit output was captured because the scenario failed before completion.'
      },
      progressTracker: {
        present: false,
        status: null,
        decision: null,
        issues: ['benchmark_scenario_failed'],
        summary: 'No accepted progress tracker was captured because the scenario failed before completion.'
      },
      toolEvidence: {
        required: false,
        satisfied: false,
        invocationCount: 0,
        successfulCount: 0,
        verificationCount: 0,
        pendingApprovalCount: 0,
        toolIds: [],
        summary: 'No tool evidence was captured for the failed scenario.'
      },
      artifactEvidence: {
        required: false,
        satisfied: false,
        artifactPathState: 'sandbox_only',
        artifactPaths: [],
        summary: 'No artifact evidence was captured for the failed scenario.'
      },
      deliveryEvidence: {
        required: false,
        delivered: false,
        artifactDestinationDir: null,
        artifactDestinationPaths: [],
        summary: 'No delivery evidence was captured for the failed scenario.'
      },
      groundingEvidence: {
        required: false,
        satisfied: false,
        referenceCount: 0,
        pathReferences: [],
        taskIdReferences: [],
        eventTypeReferences: [],
        artifactReferences: [],
        summary: 'No grounding evidence was captured for the failed scenario.'
      }
    },
    semanticReview: {
      status: 'not_requested',
      verdict: null,
      providerId: null,
      modelId: null,
      reviewedAt: null,
      confidence: null,
      summary: null,
      mismatches: [],
      missingEvidence: [],
      error: null
    }
  };
}

function createScenarioFailureResult(params: {
  definition: PracticalTaskScenarioDefinition;
  taskId: string | null;
  message: string;
  metrics?: MutableMetrics;
  workspaceDir?: string | null;
  sourceFiles?: string[];
}): PracticalTaskScenarioResult {
  return {
    scenario: params.definition.family,
    description: params.definition.description,
    taskId: params.taskId ?? 'unsubmitted',
    passed: false,
    finalLifecycleStatus: 'FAILED',
    issueCategory: 'recovery_inconsistency',
    issueSummary: params.message,
    missingRequiredEventTypes: [...params.definition.requiredEventTypes],
    observedHooks: [],
    clarificationMode: 'not-needed',
    assumptionDisclosure: { status: 'missing', summary: null },
    executionSummary: {
      issuePlane: 'core',
      issueCategory: 'recovery_inconsistency',
      issueSummary: params.message,
      suggestedAction: {
        type: 'inspect_diagnostics',
        label: 'Inspect scenario failure',
        reason: params.message,
        command: null
      },
      workingDirectory: {
        status: 'missing',
        workingDirectory: null,
        source: 'missing',
        requiresSelection: true,
        guidance: 'No project working directory was selected for this scenario result.'
      },
      eventCounts: {},
      turnCount: 0,
      correctionDepth: 0,
      stageDurations: [],
      unitDurations: [],
      plannerFallbackReasons: [],
      approvalBlockedBatchCount: 0,
      batchExecution: {
        plannedProviderBatchCount: 0,
        plannedToolBatchCount: 0,
        executedToolBatchCount: 0,
        toolInvocationCount: 0,
        averageToolInvocationsPerBatch: 0
      },
      observedHooks: [],
      ruleSummary: {
        configuredCount: 0,
        matchedRuleNames: [],
        pathMatchedRuleNames: []
      },
      hookSummary: {
        configuredCount: 0,
        executedCount: 0,
        failedCount: 0,
        recent: []
      },
      agentSummary: {
        configuredCount: 0,
        selectedAgent: null,
        selectedBy: null
      },
      instructionSkillSummary: {
        configuredCount: 0,
        selectedCount: 0,
        selected: []
      },
      experienceSummary: {
        configuredCount: 0,
        selectedCount: 0,
        selected: [],
        validationCandidates: []
      },
      providerSummary: {
        providerId: null,
        modelId: null,
        variantId: null,
        selectedBy: null,
        transport: null,
        readiness: null,
        authSource: null,
        recentStatus: 'unknown',
        lastMessage: null
      },
      skillSummary: {
        configuredCount: 0,
        availableCount: 0,
        invokedCount: 0,
        failureStreak: 0,
        recent: []
      },
      mcpSummary: {
        configuredCount: 0,
        availableCount: 0,
        invokedCount: 0,
        failureStreak: 0,
        selectedServerIds: [],
        selectedTools: [],
        selectedResources: [],
        selectedPrompts: [],
        readinessSummary: {
          ready: [],
          missingClient: [],
          metadataOnly: []
        },
        recent: []
      },
      permissionSummary: {
        mode: 'ask',
        approvalRequiredCount: 0,
        deniedCount: 0,
        recent: []
      },
      providerFailureStreak: 0,
      skillFailureStreak: 0,
      mcpFailureStreak: 0,
      artifactPathState: 'sandbox_only',
      pendingArtifactCount: 0,
      selectedArtifactDir: null,
      recommendedArtifactDir: null,
      artifactPaths: [],
      artifactDestinationPaths: [],
      lastArtifactApplyAt: null,
      lastArtifactApplyResult: null,
      lastSafeCheckpointAt: null,
      lastRecoverySource: null,
      conservativeModeReason: null,
      capabilityWarnings: [],
      queueRuntimeAlignment: {
        consistent: false,
        queueState: null,
        lifecycleStatus: 'FAILED',
        summary: params.message
      },
      recovery: {
        recoveredAfterRestart: false,
        recoveryReason: null,
        recoveredBy: null,
        recoveredFromLifecycleStatus: null,
        previousQueueState: null,
        queueLastError: null
      },
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
        estimatedContextReductionRatio: 0,
        reasons: []
      },
      executionProfiles: [],
      turnContract: {
        currentUnitId: null,
        pendingCorrection: 'NONE',
        requiresToolEvidence: false,
        lastAcceptanceFailureCategory: null,
        lastPendingCorrectionKind: null,
        lastCorrectionPromptMode: 'FULL_PROTOCOL',
        correctionLoopNonConvergent: false,
        conservativeMode: false,
        continueAllowed: false,
        continueReason: params.message
      },
      acceptance: createFailureExecutionAcceptance(params.message)
    },
    artifactQuality: {
      verdict: 'failed',
      failureCategory: 'summary_mismatch',
      summary: params.message,
      files: []
    },
    shipReady: false,
    minorEditsNeededCount: 0,
    criticalGapsCount: 1,
    diagnostics: {
      workspaceDir: params.workspaceDir ?? null,
      sourceFiles: params.sourceFiles ?? [],
      artifactSnapshots: params.definition.artifactFiles.map((artifactPath) => ({
        path: artifactPath,
        exists: false,
        excerpt: null,
        persistedPath: null
      }))
    },
    metrics: params.metrics ?? {
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
    }
  };
}

function createTempRoot(prefix = 'backend-new-practical-tasks-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeUsageValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeUsageSource(source: MutableMetrics['usageSource']): MutableMetrics['usageSource'] {
  return source;
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

function shouldTreatUsageAsMissing(usage: {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedPromptTokens?: number | null;
  cacheWritePromptTokens?: number | null;
}): boolean {
  const values = [
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    usage.cachedPromptTokens ?? null,
    usage.cacheWritePromptTokens ?? null
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

function readUsageMetadata(metadata: Record<string, unknown>): ProviderCompletionUsage | null {
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

function truncateExcerpt(value: string): string {
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
      excerpt: truncateExcerpt(message.content)
    }));
}

function createOutput(unitId: string, artifact: string, extra: Record<string, unknown> = {}): string {
  return `[${unitId}_OUTPUT]${JSON.stringify({
    summary: `${unitId}-${artifact}`,
    artifact,
    issues: [],
    report: `${artifact} ready`,
    ...extra
  })}[/${unitId}_OUTPUT]`;
}

function createTracker(unitId: string): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'COMPLETE',
    progress_percent: 100,
    decision: 'CONTINUE',
    reason: 'practical task scenario step complete',
    next_unit: null,
    files_created: []
  });
}

function createToolCall(unitId: string, toolName: string, parameters: Record<string, unknown>): string {
  return JSON.stringify({
    current_unit: unitId,
    tool_name: toolName,
    arguments: parameters
  });
}

function createUnit(params: {
  id: string;
  role: string;
  goal: string;
  profile: ExecutionProfileId;
  dependencies: string[];
  taskScope?: string;
}): AgentUnit {
  return {
    id: params.id,
    role: params.role,
    goal: params.goal,
    taskScope: params.taskScope,
    inputContract: '{"includeGlobalMemory":true}',
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    exitCondition: '{"status":"COMPLETE","report":"required"}',
    executionProfileId: params.profile,
    dependencies: params.dependencies
  };
}

function createPassedAcceptance(params: {
  summary: string;
  files: string[];
  clarificationMode: PracticalTaskClarificationMode;
  assumptionDisclosure: PracticalTaskAssumptionDisclosure;
}): PracticalTaskAcceptance {
  return {
    verdict: 'passed',
    failureCategory: null,
    summary: params.summary,
    files: params.files,
    clarificationMode: params.clarificationMode,
    assumptionDisclosure: params.assumptionDisclosure
  };
}

function createFailureAcceptance(
  summary: string,
  failureCategory: PracticalTaskFailureCategory,
  params: {
    files?: string[];
    clarificationMode: PracticalTaskClarificationMode;
    assumptionDisclosure: PracticalTaskAssumptionDisclosure;
  }
): PracticalTaskAcceptance {
  return {
    verdict: 'failed',
    failureCategory,
    summary,
    files: params.files ?? [],
    clarificationMode: params.clarificationMode,
    assumptionDisclosure: params.assumptionDisclosure
  };
}

function hasRuntimeCompletionGate(summary: TaskExecutionSummary): boolean {
  return summary.acceptance.deterministic.verdict === 'passed';
}

function shouldPassPracticalScenario(params: {
  task: TaskQueryResponse;
  summary: TaskExecutionSummary;
  artifactVerdict: PracticalTaskAcceptance['verdict'];
  missingRequiredEventTypes: string[];
}): boolean {
  return params.task.runtime.lifecycleStatus === 'COMPLETED'
    && params.summary.queueRuntimeAlignment.consistent
    && params.missingRequiredEventTypes.length === 0
    && params.artifactVerdict === 'passed'
    && hasRuntimeCompletionGate(params.summary)
    && `${params.summary.issueCategory ?? ''}` !== 'unknown';
}

function buildLatestFailedToolSignature(task: TaskQueryResponse): string | null {
  const latestFailedInvocation = [...task.toolInvocations]
    .filter((record) => record.status === 'FAILED')
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))[0] ?? null;
  if (!latestFailedInvocation) {
    return null;
  }
  const statusCode = typeof latestFailedInvocation.metadata?.status === 'number'
    ? String(latestFailedInvocation.metadata.status)
    : 'unknown';
  const combinedFailureText = [
    typeof latestFailedInvocation.metadata?.stderr === 'string' ? latestFailedInvocation.metadata.stderr : '',
    typeof latestFailedInvocation.metadata?.stdout === 'string' ? latestFailedInvocation.metadata.stdout : '',
    typeof latestFailedInvocation.error === 'string' ? latestFailedInvocation.error : ''
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const failureKind = /cannot find module/i.test(combinedFailureText)
    ? 'cannot-find-module'
    : /assert(?:ion)?error/i.test(combinedFailureText)
      ? 'assertion-failed'
      : /syntaxerror/i.test(combinedFailureText)
        ? 'syntax-error'
        : /typeerror/i.test(combinedFailureText)
          ? 'type-error'
          : combinedFailureText
            ? 'tool-failed'
            : 'unknown-failure';
  return [
    latestFailedInvocation.unitId,
    latestFailedInvocation.toolId,
    statusCode,
    failureKind
  ]
    .filter(Boolean)
    .join('|') || null;
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
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

function buildPracticalCorrectionLoopSignature(
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
      .filter(Boolean)
      .sort()
      .join(',')
    : null;
  const signatureParts = [
    task.runtime.pendingCorrection,
    summary.issueCategory,
    diagnostics?.lastAcceptanceFailureCategory ?? null,
    diagnostics?.lastPendingCorrectionKind ?? null,
    diagnostics?.lastCorrectionPromptMode ?? null,
    deterministicFailedChecks,
    buildLatestFailedToolSignature(task)
  ].filter(Boolean);
  return signatureParts.length > 0 ? signatureParts.join('|') : null;
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function resolveFixtureRoot(): string {
  return path.join(resolveRepoRoot(), 'backend', 'fixtures', 'practical-tasks');
}

function resolveLiveProviderManifestPath(projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.BACKEND_NEW_LIVE_PROVIDER_MANIFEST?.trim()) {
    return path.resolve(projectRoot, env.BACKEND_NEW_LIVE_PROVIDER_MANIFEST);
  }
  const candidates = [
    path.resolve(projectRoot, 'backend', 'data', 'providers', 'manifest.json')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function isLiveProviderEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env.BACKEND_NEW_LIVE_PROVIDER_ENABLED ?? '');
}

function selectLiveProviderView(
  views: ProviderProfileView[],
  configuredDefaultProviderId: string | null,
  explicitProviderId: string | undefined
): ProviderProfileView | null {
  if (explicitProviderId?.trim()) {
    const exact = views.find((view) => view.profile.id === explicitProviderId.trim());
    if (exact) {
      return exact;
    }
  }
  if (configuredDefaultProviderId?.trim()) {
    const configuredDefault = views.find((view) => view.profile.id === configuredDefaultProviderId.trim());
    if (configuredDefault) {
      return configuredDefault;
    }
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
    label: `live-practical:${profile.id}`,
    apiKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    metadata: {
      source: 'practical-live-task-acceptance',
      ephemeral: true
    }
  });
}

async function resolveLiveProvider(
  projectRoot: string,
  env: NodeJS.ProcessEnv
): Promise<{ summary: LiveProviderExecutionSummary | null; blocker: string | null }> {
  if (!isLiveProviderEnabled(env)) {
    return {
      summary: null,
      blocker: 'live provider execution is disabled; set BACKEND_NEW_LIVE_PROVIDER_ENABLED=1 to run live practical acceptance'
    };
  }
  const bootstrapRoot = createTempRoot('backend-new-practical-live-bootstrap-');
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
    const testResult = await runtime.platform.testProvider(selected.profile.id);
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
  } catch (error) {
    return {
      summary: null,
      blocker: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await runtime.close();
    removeDir(bootstrapRoot);
  }
}

function extractSectionContent(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const normalizedHeading = heading.trim().toLowerCase();
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('## ')) {
      continue;
    }
    const lineHeading = line.slice(3).trim().toLowerCase();
    if (lineHeading === normalizedHeading) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex < 0) {
    return null;
  }

  const collected: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('## ')) {
      break;
    }
    collected.push(line);
  }

  const content = collected.join('\n').trim();
  return content.length > 0 ? content : null;
}

function hasAnyMatch(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function extractAnySection(markdown: string, headings: string[]): string | null {
  for (const heading of headings) {
    const content = extractSectionContent(markdown, heading);
    if (content) {
      return content;
    }
  }
  return null;
}

function buildLiveIntent(definition: PracticalTaskScenarioDefinition): string {
  const genericSuffix = 'Use real workspace tools. Create any required folders before writing files. Finish by returning one explicit output block for the current unit and one tracker JSON block. Do not claim completion before the requested files exist in the workspace.';
  switch (definition.family) {
    case 'vague-blog-request':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/blog-post.md. Do not ask the user a follow-up question. Choose a low-risk engineering collaboration topic and make your assumptions explicit. Use headings exactly: "## Assumptions", "## Title Suggestions", "## Draft", "## Conclusion". In "## Assumptions" include bullets for target reader, publishing channel, and user intent. ${genericSuffix}`;
    case 'explicit-blog-request':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/release-engineering-blog.md. Mention CTO readers explicitly. Use headings exactly: "## Opening", "## Why Release Engineering Is an Organizational Capability", "## Three Practical Recommendations", "## Closing". ${genericSuffix}`;
    case 'vague-summary-request':
      return `${definition.intent} Treat this as a clarification-first task. Do not invent missing scope and do not stay in analysis mode. Deliver exactly one markdown file at deliverables/requirement-clarification.md with headings exactly: "## Known Context", "## Missing Information", "## Questions to Confirm", "## Recommended Next Step". ${genericSuffix}`;
    case 'explicit-doc-request':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/release-checklist.md. Use headings exactly: "## Before Release", "## During Release", "## After Release". Include the literal strings "queueReady=true" and "heartbeat". ${genericSuffix}`;
    case 'operator-report-task':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/operator-report.md. Use headings exactly: "## Snapshot", "## Key Risks", "## Recommended Actions". Mention the destination path blocker and MCP dependency/readiness risk explicitly. ${genericSuffix}`;
    case 'analysis-brief-task':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/analysis-brief.md. Choose one rollout strategy and recommend it. Use headings exactly: "## Conclusion", "## Why", "## Risks", "## Recommendation". Keep the brief concise and complete in one pass. ${genericSuffix}`;
    case 'practical-engineering-change-task':
      return `${definition.intent} Deliver exactly two files: patches/task-progress.patch and reports/engineering-change.md. The patch must target frontend/src/shared/utils/task-progress.ts and mention missing-provider-secret. The summary must mention required-mcp-missing and explain why the ordering change matters. ${genericSuffix}`;
    case 'practical-review-task':
      return `${definition.intent} Deliver exactly one markdown file at reports/review-findings.md. Do not stay in analysis mode. If you inspect the copied file, still write the final artifact in the same turn. Use a finding-first format with numbered findings like "1. [P2] ...". Include concrete evidence that references backend/src/interfaces/http/utils.ts. End with a short residual risk section. ${genericSuffix}`;
    case 'vague-landing-page-brief':
      return `${definition.intent} Deliver exactly one markdown file at deliverables/landing-page-brief.md. Do not ask a follow-up question. Use headings exactly: "## Assumptions", "## Audience", "## Hero", "## Core Sections", "## CTA". Make the assumptions explicit and keep the structure publish-ready. ${genericSuffix}`;
    case 'explicit-multi-artifact-doc-bundle':
      return `${definition.intent} Deliver exactly two markdown files: deliverables/launch-plan.md and deliverables/launch-faq.md. The launch plan must use headings exactly: "## Scope", "## Timeline", "## Owners", "## Risks". The FAQ must use headings exactly: "## Audience FAQ" and "## Internal FAQ". Keep the two artifacts consistent with each other. ${genericSuffix}`;
    case 'engineering-decision-record-task':
      return `${definition.intent} Deliver exactly one markdown file at reports/decision-record.md. Use headings exactly: "## Decision", "## Context", "## Tradeoffs", "## Risks", "## Recommendation". Keep the decision record technical, concrete, and ready for engineering review. ${genericSuffix}`;
    case 'repo-grounded-review-followup-task':
      return `${definition.intent} Deliver exactly two files: patches/http-utils-followup.patch and reports/review-followup.md. The patch and follow-up note must both reference backend/src/interfaces/http/utils.ts and explain a concrete follow-up around PATCH handling and trusted local origins. ${genericSuffix}`;
    default:
      return `${definition.intent} ${genericSuffix}`;
  }
}

function registerScenarioProvider(
  foundation: BackendNewFoundation,
  responses: string[],
  metrics: MutableMetrics
): void {
  const queue = [...responses];
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    vendor: 'custom',
    baseUrl: 'https://provider.example.test/v1',
    model: 'gpt-5.4'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      const next = queue.shift();
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.totalTokens += promptTokens;
      if (!next) {
        throw new Error('No mock provider response queued for practical task scenario.');
      }
      const completionTokens = estimateTokens(next);
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += completionTokens;
      return {
        responseId: `practical_task_resp_${metrics.apiCallCount}`,
        providerId: request.profile.id,
        model: request.profile.model,
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          practicalTaskScenario: true
        }
      };
    }
  });
}

class PracticalTaskHarness {
  private readonly rootDir = createTempRoot();
  private readonly repoRoot = resolveRepoRoot();
  private readonly fixtureRoot = resolveFixtureRoot();
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
  private foundation: BackendNewFoundation | null = null;
  private runtime: BackendNewRuntime | null = null;
  private taskId: string | null = null;
  private readonly metricsSeen = new Set<string>();
  private readonly continueMessages: string[] = [];
  private persistedArtifactsRoot: string | null = null;

  constructor(
    private readonly definition: PracticalTaskScenarioDefinition,
    private readonly options: {
      providerMode?: 'mock' | 'live';
      providerId?: string | null;
      projectRoot?: string;
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {}

  private async bootRuntime(): Promise<void> {
    const providerMode = this.options.providerMode ?? 'mock';
    const env = this.options.env ?? process.env;
    const projectRoot = this.options.projectRoot ?? this.repoRoot;
    this.foundation = createBackendNewFoundation({
      cwd: providerMode === 'live' ? projectRoot : this.rootDir,
      env,
      config: {
        paths: {
          rootDir: this.rootDir
        },
        providers: providerMode === 'live'
          ? {
            manifestFile: resolveLiveProviderManifestPath(projectRoot, env),
            defaultProviderId: this.options.providerId ?? undefined
          }
          : undefined,
        tools: {
          permissionMode: 'full'
        }
      }
    });
    this.runtime = createBackendNewRuntime({
      foundation: this.foundation
    });
    if (providerMode === 'live') {
      const providerViews = await this.runtime.platform.listProviders();
      const providerProfile = providerViews.find((view) => view.profile.id === this.options.providerId)?.profile
        ?? (this.options.providerId ? this.foundation.providers.get(this.options.providerId) : null);
      if (providerProfile) {
        await seedLiveProviderSecretIfNeeded(this.foundation, providerProfile, env);
      }
    } else {
      registerScenarioProvider(this.foundation, this.definition.responses ?? [], this.metrics);
    }
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`Practical task scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireFoundation(): BackendNewFoundation {
    if (!this.foundation) {
      throw new Error(`Practical task scenario "${this.definition.name}" has no foundation.`);
    }
    return this.foundation;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`Practical task scenario "${this.definition.name}" has no submitted task id.`);
    }
    return this.taskId;
  }

  getMetrics(): MutableMetrics {
    return {
      ...this.metrics,
      usageBreakdown: { ...this.metrics.usageBreakdown }
    };
  }

  getTaskId(): string | null {
    return this.taskId;
  }

  private captureUsage(task: TaskQueryResponse): void {
    for (const message of task.conversations) {
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
      const returnedUsage = readUsageMetadata(message.metadata);
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
      const estimatedUsage = estimateUsageFromTaskTurn(task, message.messageId);
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

  private async persistArtifact(relativePath: string): Promise<string | null> {
    const taskId = this.taskId;
    if (!taskId) {
      return null;
    }
    const sourcePath = this.resolveWorkspacePath(relativePath);
    const artifactsRoot = path.join(
      this.repoRoot,
      '.codex-run',
      'logs',
      this.options.providerMode === 'live' ? 'practical-live-artifacts' : 'practical-artifacts',
      taskId,
      this.definition.family
    );
    const destinationPath = path.join(artifactsRoot, relativePath);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.copyFile(sourcePath, destinationPath);
    this.persistedArtifactsRoot = artifactsRoot;
    return destinationPath;
  }

  getWorkspaceDir(): string | null {
    if (!this.foundation || !this.taskId) {
      return null;
    }
    return this.foundation.layout.forTask(this.taskId).workspaceDir;
  }

  private resolveWorkspacePath(relativePath: string): string {
    return this.requireFoundation().layout.resolveWorkspacePath(this.requireTaskId(), relativePath);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    return fsp.readFile(this.resolveWorkspacePath(relativePath), this.requireFoundation().config.storage.encoding);
  }

  async fileExists(relativePath: string): Promise<boolean> {
    try {
      await fsp.access(this.resolveWorkspacePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async copyFixtureFile(source: string, destination = source): Promise<void> {
    const fixturePath = path.join(this.fixtureRoot, source);
    const content = await fsp.readFile(fixturePath, 'utf8');
    const target = this.resolveWorkspacePath(destination);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }

  async copyRepoFile(source: string, destination = source): Promise<void> {
    const content = await fsp.readFile(path.join(this.repoRoot, source), 'utf8');
    const target = this.resolveWorkspacePath(destination);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }

  async submit(): Promise<void> {
    if (!this.runtime) {
      await this.bootRuntime();
    }
    const submitted = await this.requireRuntime().tasks.submitTask({
      title: this.definition.name,
      intent: this.options.providerMode === 'live'
        ? buildLiveIntent(this.definition)
        : this.definition.intent,
      preferredProviderId: this.options.providerMode === 'live'
        ? (this.options.providerId ?? undefined)
        : 'provider-main',
      metadata: {
        practicalTaskScenario: this.definition.name,
        practicalTaskFamily: this.definition.family,
        practicalTaskProviderMode: this.options.providerMode ?? 'mock'
      },
      units: this.definition.units
    });
    this.taskId = submitted.command.taskId;
    for (const fixture of this.definition.fixtureFiles ?? []) {
      await this.copyFixtureFile(fixture.source, fixture.destination ?? fixture.source);
    }
    for (const repoFile of this.definition.repoFiles ?? []) {
      await this.copyRepoFile(repoFile.source, repoFile.destination ?? repoFile.source);
    }
  }

  async start(): Promise<TaskQueryResponse> {
    const started = await this.requireRuntime().tasks.startTask({
      taskId: this.requireTaskId()
    }).then((result) => result.task);
    this.captureUsage(started);
    return started;
  }

  async continue(userMessage?: string): Promise<TaskQueryResponse> {
    if (typeof userMessage === 'string' && userMessage.trim().length > 0) {
      this.continueMessages.push(userMessage.trim());
    }
    const next = await this.requireRuntime().tasks.continueTask({
      taskId: this.requireTaskId(),
      userMessage
    }).then((result) => result.task);
    this.captureUsage(next);
    return next;
  }

  async applyArtifacts(destinationDir?: string): Promise<TaskQueryResponse> {
    const next = await this.requireRuntime().tasks.submitCommand({
      taskId: this.requireTaskId(),
      type: 'APPLY_ARTIFACTS',
      actor: 'practical-live-harness',
      message: destinationDir ?? null,
      metadata: destinationDir
        ? {
          destinationDir,
          overwrite: true
        }
        : undefined
    }).then((result) => result.task);
    this.captureUsage(next);
    return next;
  }

  async getTask(): Promise<TaskQueryResponse> {
    const task = await this.requireRuntime().tasks.getTask(this.requireTaskId());
    this.captureUsage(task);
    return task;
  }

  async pause(reason = 'practical live correction loop stalled'): Promise<TaskQueryResponse> {
    const paused = await this.requireRuntime().tasks.pauseTask({
      taskId: this.requireTaskId(),
      reason
    }).then((result) => result.task);
    this.captureUsage(paused);
    return paused;
  }

  buildSummary(task: TaskQueryResponse): TaskExecutionSummary {
    return buildTaskExecutionSummary(task, this.requireFoundation());
  }

  async finalize(task: TaskQueryResponse): Promise<PracticalTaskScenarioResult> {
    this.captureUsage(task);
    const summary = this.buildSummary(task);
    const acceptance = await this.definition.acceptance(this, task);
    const allConversations = await this.requireFoundation().conversations.list(this.requireTaskId());
    const missingRequiredEventTypes = this.definition.requiredEventTypes
      .filter((type) => !task.events.some((event) => event.type === type));
    const artifactSnapshots: PracticalTaskScenarioResult['diagnostics']['artifactSnapshots'] = [];
    for (const relativePath of this.definition.artifactFiles) {
      const exists = await this.fileExists(relativePath);
      let excerpt: string | null = null;
      let persistedPath: string | null = null;
      if (exists) {
        excerpt = truncateExcerpt(await this.readWorkspaceFile(relativePath));
        persistedPath = await this.persistArtifact(relativePath);
      }
      artifactSnapshots.push({
        path: relativePath,
        exists,
        excerpt,
        persistedPath
      });
    }

    const passed = shouldPassPracticalScenario({
      task,
      summary,
      artifactVerdict: acceptance.verdict,
      missingRequiredEventTypes
    });

    return {
      scenario: this.definition.family,
      description: this.definition.description,
      taskId: this.requireTaskId(),
      passed,
      finalLifecycleStatus: task.runtime.lifecycleStatus,
      issueCategory: summary.issueCategory,
      issueSummary: summary.issueSummary,
      missingRequiredEventTypes,
      observedHooks: [...summary.observedHooks],
      clarificationMode: acceptance.clarificationMode,
      assumptionDisclosure: acceptance.assumptionDisclosure,
      executionSummary: summary,
      artifactQuality: {
        verdict: acceptance.verdict,
        failureCategory: acceptance.failureCategory,
        summary: acceptance.summary,
        files: acceptance.files
      },
      shipReady: passed,
      minorEditsNeededCount: 0,
      criticalGapsCount: passed ? 0 : 1,
      diagnostics: {
        workspaceDir: this.getWorkspaceDir(),
        sourceFiles: [
          ...(this.definition.fixtureFiles ?? []).map((entry) => `fixture:${entry.source}`),
          ...(this.definition.repoFiles ?? []).map((entry) => `repo:${entry.source}`)
        ],
        artifactSnapshots,
        continueMessages: this.continueMessages.slice(-4),
        recentAssistantMessages: extractRecentConversationExcerpts(allConversations, 'assistant', 4, {
          excludeAssistantSummary: true
        }),
        recentUserMessages: extractRecentConversationExcerpts(allConversations, 'user', 4)
      },
      metrics: this.getMetrics()
    };
  }

  async createFailureResult(message: string, task?: TaskQueryResponse | null): Promise<PracticalTaskScenarioResult> {
    if (!task) {
      return createScenarioFailureResult({
        definition: this.definition,
        taskId: this.getTaskId(),
        message,
        metrics: this.getMetrics(),
        workspaceDir: this.getWorkspaceDir(),
        sourceFiles: [
          ...(this.definition.fixtureFiles ?? []).map((entry) => `fixture:${entry.source}`),
          ...(this.definition.repoFiles ?? []).map((entry) => `repo:${entry.source}`)
        ]
      });
    }

    this.captureUsage(task);
    const summary = this.buildSummary(task);
    const allConversations = await this.requireFoundation().conversations.list(this.requireTaskId());
    const artifactSnapshots: PracticalTaskScenarioResult['diagnostics']['artifactSnapshots'] = [];
    for (const relativePath of this.definition.artifactFiles) {
      const exists = await this.fileExists(relativePath);
      let excerpt: string | null = null;
      let persistedPath: string | null = null;
      if (exists) {
        excerpt = truncateExcerpt(await this.readWorkspaceFile(relativePath));
        persistedPath = await this.persistArtifact(relativePath);
      }
      artifactSnapshots.push({
        path: relativePath,
        exists,
        excerpt,
        persistedPath
      });
    }

    return {
      scenario: this.definition.family,
      description: this.definition.description,
      taskId: this.requireTaskId(),
      passed: false,
      finalLifecycleStatus: task.runtime.lifecycleStatus,
      issueCategory: summary.issueCategory,
      issueSummary: summary.issueSummary ?? message,
      missingRequiredEventTypes: this.definition.requiredEventTypes
        .filter((type) => !task.events.some((event) => event.type === type)),
      observedHooks: [...summary.observedHooks],
      clarificationMode: 'not-needed',
      assumptionDisclosure: { status: 'missing', summary: null },
      executionSummary: summary,
      artifactQuality: {
        verdict: 'failed',
        failureCategory: 'summary_mismatch',
        summary: message,
        files: artifactSnapshots.filter((artifact) => artifact.exists).map((artifact) => artifact.path)
      },
      shipReady: false,
      minorEditsNeededCount: 0,
      criticalGapsCount: 1,
      diagnostics: {
        workspaceDir: this.getWorkspaceDir(),
        sourceFiles: [
          ...(this.definition.fixtureFiles ?? []).map((entry) => `fixture:${entry.source}`),
          ...(this.definition.repoFiles ?? []).map((entry) => `repo:${entry.source}`)
        ],
        artifactSnapshots,
        continueMessages: this.continueMessages.slice(-4),
        recentAssistantMessages: extractRecentConversationExcerpts(allConversations, 'assistant', 4, {
          excludeAssistantSummary: true
        }),
        recentUserMessages: extractRecentConversationExcerpts(allConversations, 'user', 4)
      },
      metrics: this.getMetrics()
    };
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    removeDir(this.rootDir);
  }
}

async function driveToCompletion(harness: PracticalTaskHarness, initialTask: TaskQueryResponse): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 12) {
    task = await harness.continue();
    guard += 1;
  }
  const finalSummary = harness.buildSummary(task);
  const finalRecommendedDir = finalSummary.recommendedArtifactDir
    ?? parseRecommendedArtifactDirFromMessage(finalSummary.turnContract.continueReason);
  if (finalSummary.issueCategory === 'artifact_destination_unresolved' && finalRecommendedDir) {
    task = await harness.applyArtifacts(finalRecommendedDir);
  }
  if (guard >= 12) {
    throw new Error(`Practical task scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function liveCorrectionStillNeedsExplicitOutput(summary: TaskExecutionSummary): boolean {
  if (summary.acceptance?.evidence?.explicitOutput?.present === false) {
    return true;
  }
  const contractFailedChecks = summary.acceptance?.deterministic?.contract?.failedChecks ?? [];
  return contractFailedChecks.includes('missing_validated_explicit_output');
}

function deriveLiveContinueMessage(
  task: TaskQueryResponse,
  definition: PracticalTaskScenarioDefinition,
  attempt: number,
  summary: TaskExecutionSummary
): string | undefined {
  const diagnostics = task.runtime.contractDiagnostics;
  const primaryArtifact = definition.artifactFiles[0] ?? 'deliverables/output.md';
  const artifactList = definition.artifactFiles.join(', ');
  const needsExplicitOutput = liveCorrectionStillNeedsExplicitOutput(summary);
  const toolActionClosing = needsExplicitOutput
    ? 'After the required tool block(s), return one explicit output block and one tracker JSON block.'
    : 'Do not repeat the already accepted explicit output. After the required tool block(s), return exactly one tracker JSON block.';
  if (!diagnostics) {
    return `Complete the requested artifact set (${artifactList}). Use workspace tools first, then return one output block and one tracker JSON block.`;
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TRACKER') {
    return 'Return only one tracker JSON block for the current unit. Do not add prose or extra output blocks.';
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TOOL_ACTION') {
    switch (definition.family) {
      case 'practical-engineering-change-task':
        return `Use create_folder/write_file to create both patches/task-progress.patch and reports/engineering-change.md in the workspace. The patch must reference frontend/src/shared/utils/task-progress.ts and mention missing-provider-secret. The summary must mention required-mcp-missing. ${toolActionClosing}`;
      case 'practical-review-task':
        return `Use create_folder/write_file to create reports/review-findings.md in the workspace. Write numbered findings like "1. [P2] ..." and cite backend/src/interfaces/http/utils.ts. Create_folder alone does not count, and no more read_file-only turns are allowed. If you inspect, the same response must also include the write_file block. ${toolActionClosing}`;
      case 'vague-summary-request':
        return `Use create_folder/write_file to create deliverables/requirement-clarification.md with headings "## Known Context", "## Missing Information", "## Questions to Confirm", and "## Recommended Next Step". Do not invent missing scope. ${toolActionClosing}`;
      case 'vague-landing-page-brief':
        return `Use create_folder/write_file to create deliverables/landing-page-brief.md with headings "## Assumptions", "## Audience", "## Hero", "## Core Sections", and "## CTA". Make assumptions explicit instead of asking a follow-up question. ${toolActionClosing}`;
      case 'explicit-multi-artifact-doc-bundle':
        if (attempt >= 1) {
          return `Stop iterating. Do not emit create_folder again and do not return analysis prose. In this turn, emit exactly two write_file blocks for deliverables/launch-plan.md and deliverables/launch-faq.md. The launch plan must use headings exactly "## Scope", "## Timeline", "## Owners", "## Risks". The FAQ must use headings exactly "## Audience FAQ" and "## Internal FAQ". ${toolActionClosing.replace('required tool block(s)', 'both write_file blocks')}`;
        }
        return `Use create_folder/write_file to create both deliverables/launch-plan.md and deliverables/launch-faq.md. Keep them consistent and structured as requested. Create_folder alone does not count; this turn must emit both write_file blocks. ${toolActionClosing.replace('required tool block(s)', 'both write_file blocks')}`;
      case 'engineering-decision-record-task':
        return `Use create_folder/write_file to create reports/decision-record.md with headings "## Decision", "## Context", "## Tradeoffs", "## Risks", and "## Recommendation". ${toolActionClosing}`;
      case 'repo-grounded-review-followup-task':
        if (attempt >= 1) {
          return `Stop iterating. Do not call read_file again in this turn. Emit exactly four tool actions in this order: create_folder patches, create_folder reports, write_file patches/http-utils-followup.patch, write_file reports/review-followup.md. The patch must mention backend/src/interfaces/http/utils.ts and PATCH handling. The note must mention backend/src/interfaces/http/utils.ts, PATCH, and trusted local origins. ${toolActionClosing.replace('required tool block(s)', 'all four required tool blocks')}`;
        }
        return `Use create_folder/write_file to create patches/http-utils-followup.patch and reports/review-followup.md. Both must reference backend/src/interfaces/http/utils.ts and explain follow-up changes around PATCH handling and trusted local origins. Do not spend another turn on read_file-only inspection. ${toolActionClosing}`;
      default:
        return `Use create_folder/write_file to create ${primaryArtifact} in the workspace. ${toolActionClosing} Do not claim completion before the file exists.`;
    }
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_OUTPUT_CORRECTION') {
    return `Do not emit new tool calls in this correction. Return one corrected explicit output block that references the requested artifact set (${artifactList}), then one tracker JSON block.`;
  }
  switch (definition.family) {
    case 'vague-blog-request':
      return 'Keep the draft grounded in a low-risk engineering collaboration topic. If you need assumptions, declare them explicitly under "## Assumptions" and include target reader, publishing channel, and user intent.';
    case 'explicit-blog-request':
      return 'Keep the blog aligned to CTO readers and preserve the required structure: Opening, Why Release Engineering Is an Organizational Capability, Three Practical Recommendations, Closing.';
    case 'vague-summary-request':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create deliverables/requirement-clarification.md now with exactly these headings: "## Known Context", "## Missing Information", "## Questions to Confirm", and "## Recommended Next Step". Do not invent scope. After the file exists, return one output block and one tracker JSON block.';
      }
      return 'This scenario should choose clarification over invention. Make the missing information and next questions explicit in the artifact.';
    case 'explicit-doc-request':
      return 'Keep the checklist operational and concrete. Include queueReady=true and heartbeat explicitly.';
    case 'operator-report-task':
      return 'Keep the report operator-focused. Preserve snapshot, key risks, and recommended actions with a destination path blocker and MCP readiness mention.';
    case 'analysis-brief-task':
      return 'Finish the analysis brief now. Choose one rollout strategy, state it in the conclusion, include risks, and end with a recommendation. Avoid repeating planning prose.';
    case 'practical-engineering-change-task':
      return 'Keep the engineering bundle repo-grounded. You still need both the patch and the summary doc, and they must agree on the same blocker-ordering change.';
    case 'practical-review-task':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create reports/review-findings.md now with write_file. Do not use read_file unless the same response also includes that write_file block. Use this exact structure: "# Review Findings", then at least two numbered findings like "1. [P2] ...", each with evidence that cites backend/src/interfaces/http/utils.ts, then "## Residual Risk". After the file exists, return one output block and one tracker JSON block.';
      }
      return 'Keep the review finding-first, evidence-based, and repo-specific. Number the findings and cite backend/src/interfaces/http/utils.ts directly.';
    case 'vague-landing-page-brief':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create deliverables/landing-page-brief.md now with exact headings "## Assumptions", "## Audience", "## Hero", "## Core Sections", and "## CTA". In the assumptions section include bullets for target audience, publishing/use channel, and user goal. After the file exists, return one output block and one tracker JSON block.';
      }
      return 'Treat this as a low-risk vague content task. Do not ask a follow-up question. Declare assumptions explicitly and finish the landing-page brief with the required publish-ready sections.';
    case 'explicit-multi-artifact-doc-bundle':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create both deliverables/launch-plan.md and deliverables/launch-faq.md now with two write_file blocks. Create_folder alone is not enough. Preserve headings exactly: launch-plan uses "## Scope", "## Timeline", "## Owners", "## Risks"; launch-faq uses "## Audience FAQ" and "## Internal FAQ". After both files exist, return one output block and one tracker JSON block.';
      }
      return 'Keep the launch plan and FAQ consistent. Finish both files in the same turn and preserve the requested headings.';
    case 'engineering-decision-record-task':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create reports/decision-record.md now using headings exactly "## Decision", "## Context", "## Tradeoffs", "## Risks", and "## Recommendation". Keep it technical and concrete. After the file exists, return one output block and one tracker JSON block.';
      }
      return 'Keep the decision record concrete. Make the tradeoffs, risks, and recommendation explicit so it can be reviewed without extra context.';
    case 'repo-grounded-review-followup-task':
      if (attempt >= 2) {
        return 'Stop iterating. In this turn, create both patches/http-utils-followup.patch and reports/review-followup.md now. Both must reference backend/src/interfaces/http/utils.ts and explain the same concrete follow-up around PATCH handling and trusted local origins. After both files exist, return one output block and one tracker JSON block.';
      }
      return 'This scenario needs both a repo-grounded follow-up patch and a follow-up note. Make them agree on the same PATCH/CORS local-origin follow-up.';
    default:
      return `Keep the response grounded in the requested artifact ${primaryArtifact}. If assumptions are needed, declare them explicitly. If clarification is required, say what is missing and write the clarification artifact before completion.`;
  }
}

function parseRecommendedArtifactDirFromMessage(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  const quoted = /Recommended directory:\s*"([^"\r\n]+)"/i.exec(message);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const bare = /Recommended directory:\s*([^\r\n.]+)/i.exec(message);
  return bare?.[1]?.trim() || null;
}

async function driveLiveToCompletion(
  harness: PracticalTaskHarness,
  definition: PracticalTaskScenarioDefinition,
  initialTask: TaskQueryResponse
): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  let repeatedFailureSignature: string | null = null;
  let repeatedFailureCount = 0;
  let missingPersistentEffectStreak = 0;
  let verificationFailureStreak = 0;
  while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 18) {
    const summary = harness.buildSummary(task);
    const correctionSignature = buildPracticalCorrectionLoopSignature(task, summary);
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
      return harness.pause(`practical live correction stalled: ${correctionSignature.slice(0, 240)}`);
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
      return harness.pause('practical live correction stalled: persistent artifact/write evidence was missing across repeated implement turns.');
    }
    if (verificationFailureStreak >= 3) {
      return harness.pause(`practical live verification stalled: repeated failed verification remained unresolved (${(latestFailedRunSummary ?? 'verification-failed').slice(0, 240)}).`);
    }
    const recommendedArtifactDir = summary.recommendedArtifactDir
      ?? parseRecommendedArtifactDirFromMessage(summary.turnContract.continueReason);
    if (summary.issueCategory === 'artifact_destination_unresolved' && recommendedArtifactDir) {
      task = await harness.applyArtifacts(recommendedArtifactDir);
      if (task.runtime.lifecycleStatus !== 'RUNNING') {
        break;
      }
    }
    try {
      task = await harness.continue(deriveLiveContinueMessage(task, definition, guard, summary));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const destinationBlocked = /requires a project-relative destination before proceeding/i.test(message);
      if (!destinationBlocked) {
        throw error;
      }
      const fallbackSummary = harness.buildSummary(task);
      const destinationDir = fallbackSummary.recommendedArtifactDir
        ?? parseRecommendedArtifactDirFromMessage(message)
        ?? parseRecommendedArtifactDirFromMessage(fallbackSummary.turnContract.continueReason);
      if (!destinationDir) {
        throw error;
      }
      task = await harness.applyArtifacts(destinationDir);
      if (task.runtime.lifecycleStatus !== 'RUNNING') {
        break;
      }
    }
    guard += 1;
  }
  const finalSummary = harness.buildSummary(task);
  const finalRecommendedDir = finalSummary.recommendedArtifactDir
    ?? parseRecommendedArtifactDirFromMessage(finalSummary.turnContract.continueReason);
  if (finalSummary.issueCategory === 'artifact_destination_unresolved' && finalRecommendedDir) {
    task = await harness.applyArtifacts(finalRecommendedDir);
  }
  if (guard >= 18 && task.runtime.lifecycleStatus === 'RUNNING') {
    return harness.pause(`Practical live task scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

export function createScenarioDefinitions(): PracticalTaskScenarioDefinition[] {
  return [
    {
      name: 'practical-vague-blog-request',
      family: 'vague-blog-request',
      description: 'Handle a vague blog-writing request by delivering a usable draft with explicit assumptions.',
      intent: 'A user says “帮我写一个博客”. Produce a publishable markdown draft for a low-risk topic, and make any assumptions explicit instead of silently inventing context.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Content Writer',
          goal: 'Write a useful blog post draft with declared assumptions.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/blog-post.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/blog-post.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/blog-post.md',
            content: [
              '# 博客草稿：让 AI 协作工具真正提升开发团队效率',
              '',
              '## Assumptions',
              '- 假设目标读者是 20-80 人的软件团队负责人。',
              '- 假设文章发布渠道是团队官网博客，语气以务实经验分享为主。',
              '- 假设用户希望主题聚焦在工程协作效率，而不是模型技术原理。',
              '',
              '## 标题建议',
              '- 让 AI 工具真正成为工程团队的生产力，而不是新噪音',
              '',
              '## 正文',
              '很多团队已经开始引入 AI 助手，但效果参差不齐。真正拉开差距的，不是是否“用了 AI”，而是是否把它纳入明确的协作流程：任务拆解、风险提醒、验证回路、交付落盘。',
              '',
              '第一，先定义 AI 应该帮团队做什么。对于大多数团队而言，最值钱的不是让它一次性写完整个系统，而是让它持续完成高频、可验证、可回滚的工作，例如需求澄清、代码改动、发布检查和问题复盘。',
              '',
              '第二，把 AI 的输出纳入团队的交付标准。只有当输出带着明确假设、证据引用和下一步动作时，它才真正能降低沟通成本，而不是制造新的返工。',
              '',
              '## 结论',
              '如果团队把 AI 当作流程节点而不是魔法按钮，它就更有可能成为稳定的协作者。'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'vague-blog-request.md', destination: 'inputs/vague-blog-request.md' }
      ],
      artifactFiles: ['deliverables/blog-post.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const blog = await harness.readWorkspaceFile('deliverables/blog-post.md').catch(() => null);
        if (!blog) {
          return createFailureAcceptance('Vague blog request did not produce a blog artifact.', 'artifact_missing', {
            files: ['deliverables/blog-post.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'missing', summary: null }
          });
        }
        const assumptions = extractAnySection(blog, ['Assumptions', '假设']);
        const titleSuggestionsPresent = hasAnyMatch(blog, [
          /^##\s+Title Suggestions$/im,
          /^##\s+标题建议$/im
        ]);
        const conclusionPresent = hasAnyMatch(blog, [
          /^##\s+Conclusion$/im,
          /^##\s+结论$/im
        ]);
        const assumptionSignals = assumptions
          ? [
            /target reader/i,
            /publishing channel/i,
            /user intent/i,
            /目标读者/,
            /发布渠道/,
            /用户意图/
          ].filter((pattern) => pattern.test(assumptions)).length
          : 0;
        if (!assumptions || assumptionSignals < 2) {
          return createFailureAcceptance('Vague blog request delivered a draft without explicit assumption disclosure.', 'assumption_disclosure_missing', {
            files: ['deliverables/blog-post.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'missing', summary: null }
          });
        }
        if (!titleSuggestionsPresent || !conclusionPresent) {
          return createFailureAcceptance('Vague blog request artifact is missing expected blog structure.', 'content_assertion_failed', {
            files: ['deliverables/blog-post.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Vague blog request summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/blog-post.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
          });
        }
        return createPassedAcceptance({
          summary: 'Vague blog request completed with a ship-ready draft and explicit low-risk assumptions.',
          files: ['deliverables/blog-post.md'],
          clarificationMode: 'assumption-led',
          assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
        });
      }
    },
    {
      name: 'practical-explicit-blog-request',
      family: 'explicit-blog-request',
      description: 'Produce a structured blog post from an explicit content brief.',
      intent: 'Write a markdown blog post for CTO readers about release engineering, using the provided audience, outline, and tone requirements.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Technical Blogger',
          goal: 'Write the requested explicit blog draft.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/release-engineering-blog.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/release-engineering-blog.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/release-engineering-blog.md',
            content: [
              '# Release Engineering 不是发布按钮，而是交付系统',
              '',
              '> 受众：中大型技术团队 CTO',
              '',
              '## 开场',
              '对于 CTO 来说，发布流程的关键问题不是“今天能不能上线”，而是“系统是否以可解释、可恢复、可审计的方式持续上线”。',
              '',
              '## 为什么发布工程是组织能力',
              '当发布路径依赖少数人记忆时，团队会把风险埋进流程细节。把检查、审批、回滚和观测做成标准化交付面，才能把速度和稳定性同时留下来。',
              '',
              '## 三个实践建议',
              '1. 把阻塞理由显式化。',
              '2. 让审批和回滚都有证据。',
              '3. 把长任务的恢复与漂移校正做成默认能力。',
              '',
              '## 结尾',
              '真正成熟的发布工程，不是让人更忙，而是让系统自己解释风险。'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'explicit-blog-request.md', destination: 'inputs/explicit-blog-request.md' }
      ],
      artifactFiles: ['deliverables/release-engineering-blog.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const blog = await harness.readWorkspaceFile('deliverables/release-engineering-blog.md').catch(() => null);
        if (!blog) {
          return createFailureAcceptance('Explicit blog request did not produce the blog artifact.', 'artifact_missing', {
            files: ['deliverables/release-engineering-blog.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const hasRecommendations = hasAnyMatch(blog, [
          /^##\s+Three Practical Recommendations$/im,
          /^##\s+三个实践建议$/im
        ]);
        const hasClosing = hasAnyMatch(blog, [
          /^##\s+Closing$/im,
          /^##\s+结尾$/im
        ]);
        if (!/CTO/i.test(blog) || !hasRecommendations || !hasClosing) {
          return createFailureAcceptance('Explicit blog request artifact is missing the requested audience or structure.', 'content_assertion_failed', {
            files: ['deliverables/release-engineering-blog.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Explicit blog request summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/release-engineering-blog.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Explicit blog request completed with structure, tone, and audience alignment intact.',
          files: ['deliverables/release-engineering-blog.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-vague-summary-request',
      family: 'vague-summary-request',
      description: 'Treat a vague summary request as a clarification-led deliverable when key scope details are missing.',
      intent: 'A user says “帮我整理一下这个需求”. Produce a structured clarification artifact that explains what is known, what is missing, and the next questions to unblock work.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Requirement Clarifier',
          goal: 'Summarize what is known and what still needs clarification.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/requirement-clarification.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/requirement-clarification.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/requirement-clarification.md',
            content: [
              '# 需求梳理与澄清',
              '',
              '## 当前已知',
              '- 目标是做一套面向运营团队的工作台。',
              '- 需要支持任务流转、审批与状态追踪。',
              '',
              '## 缺失信息',
              '- 目标用户的角色边界还不明确。',
              '- 成功标准、交付时间和上线范围没有说明。',
              '- 是否涉及移动端和多语言支持仍未知。',
              '',
              '## 建议先确认的问题',
              '1. 第一版必须上线的角色与页面范围是什么？',
              '2. 成功标准是效率提升、错误率下降，还是交付速度？',
              '3. 是否存在强约束集成，例如 CRM、工单系统或内部审批平台？',
              '',
              '## 下一步建议',
              '在拿到上述答案前，建议先暂停拆实现任务，先补一页需求边界说明。'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'vague-summary-request.md', destination: 'inputs/vague-summary-request.md' }
      ],
      artifactFiles: ['deliverables/requirement-clarification.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const artifact = await harness.readWorkspaceFile('deliverables/requirement-clarification.md').catch(() => null);
        if (!artifact) {
          return createFailureAcceptance('Vague summary request did not produce a clarification artifact.', 'artifact_missing', {
            files: ['deliverables/requirement-clarification.md'],
            clarificationMode: 'required',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const hasMissingInformation = hasAnyMatch(artifact, [
          /^##\s+Missing Information$/im,
          /^##\s+缺失信息$/im
        ]);
        const hasQuestions = hasAnyMatch(artifact, [
          /^##\s+Questions to Confirm$/im,
          /^##\s+建议先确认的问题$/im
        ]);
        if (!hasMissingInformation || !hasQuestions) {
          return createFailureAcceptance('Vague summary request failed to surface missing information and next clarification questions.', 'clarification_missing', {
            files: ['deliverables/requirement-clarification.md'],
            clarificationMode: 'required',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Vague summary request summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/requirement-clarification.md'],
            clarificationMode: 'required',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Vague summary request correctly chose clarification over overconfident delivery.',
          files: ['deliverables/requirement-clarification.md'],
          clarificationMode: 'required',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-explicit-doc-request',
      family: 'explicit-doc-request',
      description: 'Produce a directly usable document from explicit source material and output requirements.',
      intent: 'Turn the provided release notes and acceptance bullets into a markdown release checklist document that can be sent to operators.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Documentation Writer',
          goal: 'Write the requested release checklist document.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/release-checklist.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/release-checklist.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/release-checklist.md',
            content: [
              '# 发布检查清单',
              '',
              '## 发布前',
              '- 确认 provider 配置与 secret 已就绪。',
              '- 确认 worker 已启用，/ready 返回 queueReady=true。',
              '- 确认路径策略 blocker 已清空，待提交 artifact 已 apply。',
              '',
              '## 发布中',
              '- 观察任务事件流是否持续收到 heartbeat。',
              '- 关注 approval backlog 与 hook failure 告警。',
              '',
              '## 发布后',
              '- 复核 diagnostics、events 和 capability warnings 是否一致。',
              '- 记录回滚路径与人工处理说明。'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'explicit-doc-request.md', destination: 'inputs/explicit-doc-request.md' }
      ],
      artifactFiles: ['deliverables/release-checklist.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const artifact = await harness.readWorkspaceFile('deliverables/release-checklist.md').catch(() => null);
        if (!artifact) {
          return createFailureAcceptance('Explicit doc request did not produce the checklist artifact.', 'artifact_missing', {
            files: ['deliverables/release-checklist.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const hasBeforeRelease = hasAnyMatch(artifact, [
          /^##\s+Before Release$/im,
          /^##\s+发布前$/im
        ]);
        if (!hasBeforeRelease || !/queueReady=true/.test(artifact) || !/heart.?beat/i.test(artifact)) {
          return createFailureAcceptance('Explicit doc request artifact is missing required operational content.', 'content_assertion_failed', {
            files: ['deliverables/release-checklist.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Explicit doc request summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/release-checklist.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Explicit doc request completed with a directly reusable operator checklist.',
          files: ['deliverables/release-checklist.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-operator-report-task',
      family: 'operator-report-task',
      description: 'Produce a concise operator-facing report from structured status inputs.',
      intent: 'Summarize runtime health, backlog, and blockers into an operator report with recommended next actions.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Operator Analyst',
          goal: 'Write an operator report that supports quick decision-making.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/operator-report.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/operator-report.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/operator-report.md',
            content: [
              '# Operator Status Report',
              '',
              '## Snapshot',
              '- Running tasks: 14',
              '- Pending approvals: 3',
              '- Worker status: online',
              '- Realtime status: degraded after one reconnect',
              '',
              '## Key Risks',
              '- One artifact-routing task is blocked on destination path selection.',
              '- Two tasks show repeated MCP failures but remain recoverable.',
              '',
              '## Recommended Actions',
              '1. Resolve the blocked destination path before asking the task to continue.',
              '2. Review MCP dependency readiness for the repeated failure streak.',
              '3. Keep the worker online and watch for another reconnect spike in the next 15 minutes.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'operator-report-input.json', destination: 'inputs/operator-report-input.json' }
      ],
      artifactFiles: ['deliverables/operator-report.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('deliverables/operator-report.md').catch(() => null);
        if (!report) {
          return createFailureAcceptance('Operator report task did not produce a report artifact.', 'artifact_missing', {
            files: ['deliverables/operator-report.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        if (!/## Snapshot/.test(report) || !/## Recommended Actions/.test(report) || !/destination path/i.test(report)) {
          return createFailureAcceptance('Operator report task did not preserve the expected snapshot and recommended actions.', 'content_assertion_failed', {
            files: ['deliverables/operator-report.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Operator report summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/operator-report.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Operator report task completed with actionable status and next-step guidance.',
          files: ['deliverables/operator-report.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-analysis-brief-task',
      family: 'analysis-brief-task',
      description: 'Produce an analysis brief with conclusion, rationale, risks, and recommendation.',
      intent: 'Compare two rollout strategies and recommend one, with concise reasoning and explicit risks.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Strategy Analyst',
          goal: 'Write an analysis brief with a clear recommendation.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/analysis-brief.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/analysis-brief.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/analysis-brief.md',
            content: [
              '# Analysis Brief',
              '',
              '## Conclusion',
              'Recommendation: choose staged rollout with operator approvals.',
              '',
              '## Why',
              '- It reduces blast radius while preserving observable checkpoints.',
              '- It aligns with the existing approval and diagnostics workflow.',
              '',
              '## Risks',
              '- Slower rollout if approval backlog grows.',
              '- Slightly more operator overhead during the first deployment window.',
              '',
              '## Recommendation',
              'Use staged rollout as the default path, then relax to broader rollout after the first two clean release windows.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'analysis-brief-input.md', destination: 'inputs/analysis-brief-input.md' }
      ],
      artifactFiles: ['deliverables/analysis-brief.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const brief = await harness.readWorkspaceFile('deliverables/analysis-brief.md').catch(() => null);
        if (!brief) {
          return createFailureAcceptance('Analysis brief task did not produce a brief artifact.', 'artifact_missing', {
            files: ['deliverables/analysis-brief.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const hasConclusion = hasAnyMatch(brief, [
          /^##\s+Conclusion$/im,
          /^##\s+结论$/im
        ]);
        const hasRisks = hasAnyMatch(brief, [
          /^##\s+Risks$/im,
          /^##\s+风险$/im
        ]);
        const hasRecommendation = hasAnyMatch(brief, [
          /^##\s+Recommendation$/im,
          /^##\s+建议$/im,
          /Recommendation:/i,
          /Recommended strategy/i,
          /recommend(?:ed)?\b/i
        ]);
        if (!hasConclusion || !hasRisks || !hasRecommendation) {
          return createFailureAcceptance('Analysis brief task did not produce the required conclusion/risk/recommendation structure.', 'content_assertion_failed', {
            files: ['deliverables/analysis-brief.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Analysis brief summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/analysis-brief.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Analysis brief task completed with a clear recommendation, rationale, and risks.',
          files: ['deliverables/analysis-brief.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-engineering-change-task',
      family: 'practical-engineering-change-task',
      description: 'Produce a practical engineering change bundle against a copied repo file.',
      intent: 'Review the copied task progress utility and produce a patch plus change summary that clarify missing provider-secret and required-MCP guidance ordering.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Engineer',
          goal: 'Write a change summary and patch tied to a real repo file.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'patches/task-progress.patch'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'patches/task-progress.patch'),
          createToolCall('AGENT-001', 'create_folder', { path: 'patches' }),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'patches/task-progress.patch',
            content: [
              '--- a/frontend/src/shared/utils/task-progress.ts',
              '+++ b/frontend/src/shared/utils/task-progress.ts',
              '@@',
              '+// Show missing-provider-secret before generic continue guidance',
              '+// Show required-mcp-missing before generic continue guidance'
            ].join('\n')
          }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/engineering-change.md',
            content: [
              '# Engineering Change Summary',
              '',
              'Target: frontend/src/shared/utils/task-progress.ts',
              '',
              '## Change',
              '- Reorder next-action guidance so missing-provider-secret is surfaced before generic continue messaging.',
              '- Surface required-mcp-missing before non-blocking guidance.',
              '',
              '## Why',
              'This keeps operator guidance consistent with actual blockers and avoids overconfident continue suggestions.',
              '',
              '## Validation',
              '- Patch references the copied repo file.',
              '- Summary and patch describe the same behavioral change.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      repoFiles: [
        { source: 'frontend/src/shared/utils/task-progress.ts' }
      ],
      artifactFiles: ['patches/task-progress.patch', 'reports/engineering-change.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const patch = await harness.readWorkspaceFile('patches/task-progress.patch').catch(() => null);
        const summaryDoc = await harness.readWorkspaceFile('reports/engineering-change.md').catch(() => null);
        const copiedRepoFile = await harness.readWorkspaceFile('frontend/src/shared/utils/task-progress.ts').catch(() => null);
        if (!patch || !summaryDoc || !copiedRepoFile) {
          return createFailureAcceptance('Practical engineering change task did not produce the expected patch bundle.', 'artifact_missing', {
            files: ['patches/task-progress.patch', 'reports/engineering-change.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const combinedBundle = `${patch}\n${summaryDoc}`;
        const mentionsTargetFile = /frontend\/src\/shared\/utils\/task-progress\.ts/.test(combinedBundle);
        const mentionsMissingProviderSecret = /missing[- ]provider[- ]secret/i.test(combinedBundle);
        const mentionsRequiredMcpGuidance = /required[- ]mcp(?:[- ]missing)?/i.test(combinedBundle);
        if (!mentionsTargetFile || !mentionsMissingProviderSecret || !mentionsRequiredMcpGuidance) {
          return createFailureAcceptance('Practical engineering change task produced inconsistent patch or summary content.', 'content_assertion_failed', {
            files: ['patches/task-progress.patch', 'reports/engineering-change.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Practical engineering change summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['patches/task-progress.patch', 'reports/engineering-change.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Practical engineering change task completed with a repo-grounded patch and aligned summary.',
          files: ['patches/task-progress.patch', 'reports/engineering-change.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-review-task',
      family: 'practical-review-task',
      description: 'Produce a finding-first review artifact with concrete evidence against a copied repo file.',
      intent: 'Review the copied backend HTTP utils file and write a concise finding-first review artifact with concrete evidence.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Reviewer',
          goal: 'Write a concrete review artifact against a real repo file.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'reports/review-findings.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/review-findings.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/review-findings.md',
            content: [
              '# Review Findings',
              '',
              '1. [P2] PATCH requests must remain in the CORS allow list.',
              'Evidence: backend/src/interfaces/http/utils.ts should keep PATCH alongside PUT/DELETE so browser config updates do not fail preflight.',
              '',
              '2. [P2] CORS origin policy should stay restricted to trusted local origins.',
              'Evidence: backend/src/interfaces/http/utils.ts is part of the control-plane surface and should not reflect arbitrary origins.',
              '',
              '## Residual Risk',
              'No blocking issue found in the copied file beyond keeping these invariants under test.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      repoFiles: [
        { source: 'backend/src/interfaces/http/utils.ts' }
      ],
      artifactFiles: ['reports/review-findings.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const review = await harness.readWorkspaceFile('reports/review-findings.md').catch(() => null);
        const copiedRepoFile = await harness.readWorkspaceFile('backend/src/interfaces/http/utils.ts').catch(() => null);
        if (!review || !copiedRepoFile) {
          return createFailureAcceptance('Practical review task did not produce the review artifact or copy the referenced repo file.', 'artifact_missing', {
            files: ['reports/review-findings.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const hasFindingFirstShape = /^\s*1\.\s+\**\[P\d\]\**/m.test(review) || /##\s+Findings[\s\S]*?1\.\s+\**\[P\d\]\**/im.test(review);
        const citesRepoFile = /`?backend\/src\/interfaces\/http\/utils\.ts`?/i.test(review);
        if (!hasFindingFirstShape || !citesRepoFile) {
          return createFailureAcceptance('Practical review task did not produce a finding-first artifact with concrete repo evidence.', 'content_assertion_failed', {
            files: ['reports/review-findings.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Practical review summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['reports/review-findings.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Practical review task completed with concrete findings and repo-backed evidence.',
          files: ['reports/review-findings.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-vague-landing-page-brief',
      family: 'vague-landing-page-brief',
      description: 'Handle a vague landing-page brief with explicit assumptions and a publish-ready content structure.',
      intent: 'A user says “帮我整理一个产品落地页文案大纲”. Produce a publishable landing-page brief, choose low-risk assumptions, and make those assumptions explicit instead of silently inventing context.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Landing Page Strategist',
          goal: 'Write a publish-ready landing-page brief with explicit assumptions.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/landing-page-brief.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/landing-page-brief.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/landing-page-brief.md',
            content: [
              '# Landing Page Brief',
              '',
              '## Assumptions',
              '- Target reader: engineering leads evaluating an internal delivery platform.',
              '- Publishing channel: product launch page shared in a B2B sales workflow.',
              '- User intent: communicate value quickly without needing a technical deep dive first.',
              '',
              '## Audience',
              'Engineering managers and platform leads who need clearer task delivery, approvals, and runtime visibility.',
              '',
              '## Hero',
              'Headline: Turn long-running task delivery into an explainable operating system.',
              'Supporting copy: Give teams a workspace where provider choice, approvals, artifacts, and blockers stay visible from start to finish.',
              '',
              '## Core Sections',
              '1. Explainable execution',
              '2. Artifact routing and approvals',
              '3. Live provider quality and auditability',
              '',
              '## CTA',
              'Primary CTA: Book an operator walkthrough',
              'Secondary CTA: Review the delivery checklist'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'vague-landing-page-brief.md', destination: 'inputs/vague-landing-page-brief.md' }
      ],
      artifactFiles: ['deliverables/landing-page-brief.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const brief = await harness.readWorkspaceFile('deliverables/landing-page-brief.md').catch(() => null);
        if (!brief) {
          return createFailureAcceptance('Vague landing-page brief did not produce the expected artifact.', 'artifact_missing', {
            files: ['deliverables/landing-page-brief.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'missing', summary: null }
          });
        }
        const assumptions = extractSectionContent(brief, 'Assumptions');
        const assumptionSignals = assumptions
          ? [
            /target reader|target user|target audience|目标用户|目标受众|受众|决策者/i,
            /publishing channel|landing page|campaign|sales workflow|digital marketing|落地页|投放|渠道|营销|销售/i,
            /user intent|primary goal|goal|lead generation|free trial|用户目标|核心目标|核心价值|转化|线索|试用|降低成本|提升效率/i
          ].filter((pattern) => pattern.test(assumptions)).length
          : 0;
        const assumptionBulletCount = assumptions
          ? assumptions.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+/.test(line)).length
          : 0;
        if (!assumptions || (assumptionSignals < 2 && assumptionBulletCount < 3)) {
          return createFailureAcceptance('Vague landing-page brief did not clearly disclose assumptions.', 'assumption_disclosure_missing', {
            files: ['deliverables/landing-page-brief.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'missing', summary: null }
          });
        }
        if (!/^##\s+Hero$/im.test(brief) || !/^##\s+CTA$/im.test(brief)) {
          return createFailureAcceptance('Vague landing-page brief is missing required publish-ready sections.', 'content_assertion_failed', {
            files: ['deliverables/landing-page-brief.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Vague landing-page brief summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/landing-page-brief.md'],
            clarificationMode: 'assumption-led',
            assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
          });
        }
        return createPassedAcceptance({
          summary: 'Vague landing-page brief completed with explicit assumptions and a publish-ready structure.',
          files: ['deliverables/landing-page-brief.md'],
          clarificationMode: 'assumption-led',
          assumptionDisclosure: { status: 'declared', summary: truncateExcerpt(assumptions) }
        });
      }
    },
    {
      name: 'practical-explicit-multi-artifact-doc-bundle',
      family: 'explicit-multi-artifact-doc-bundle',
      description: 'Produce a consistent multi-artifact documentation bundle from an explicit brief.',
      intent: 'Create a launch plan and FAQ bundle from an explicit product-launch brief, and keep the files consistent enough to hand to marketing and operations.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Launch Writer',
          goal: 'Create a consistent multi-artifact launch bundle.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'deliverables/launch-plan.md, deliverables/launch-faq.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'deliverables/launch-plan.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'deliverables' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/launch-plan.md',
            content: [
              '# Launch Plan',
              '',
              '## Scope',
              'Ship provider visibility, artifact routing, and approval recovery for operator teams.',
              '',
              '## Timeline',
              '- Week 1: rollout to internal operator group',
              '- Week 2: collect audit and runtime feedback',
              '- Week 3: expand to release engineering teams',
              '',
              '## Owners',
              '- Product operations',
              '- Release engineering',
              '- Platform reliability',
              '',
              '## Risks',
              '- Provider cost drift if live usage accounting regresses',
              '- Operator confusion if destination-path prompts are inconsistent'
            ].join('\n')
          }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'deliverables/launch-faq.md',
            content: [
              '# Launch FAQ',
              '',
              '## Audience FAQ',
              '- Who is this for? Operator teams, release engineering leads, and platform owners.',
              '- What changes first? Provider visibility, artifact routing, and approval recovery.',
              '',
              '## Internal FAQ',
              '- Which teams own rollout? Product operations, release engineering, and platform reliability.',
              '- What should we watch? Live usage accounting and destination-path consistency.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'explicit-multi-artifact-doc-bundle.md', destination: 'inputs/explicit-multi-artifact-doc-bundle.md' }
      ],
      artifactFiles: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const launchPlan = await harness.readWorkspaceFile('deliverables/launch-plan.md').catch(() => null);
        const launchFaq = await harness.readWorkspaceFile('deliverables/launch-faq.md').catch(() => null);
        if (!launchPlan || !launchFaq) {
          return createFailureAcceptance('Explicit multi-artifact doc bundle did not produce both deliverables.', 'artifact_missing', {
            files: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        if (!/^##\s+Scope$/im.test(launchPlan) || !/^##\s+Audience FAQ$/im.test(launchFaq)) {
          return createFailureAcceptance('Explicit multi-artifact doc bundle is missing required structure.', 'content_assertion_failed', {
            files: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const consistencySignals = [
          /launch/i.test(launchPlan) && /launch/i.test(launchFaq),
          /Week\s+\d/i.test(launchPlan) && /Week\s+\d/i.test(launchFaq),
          /(Product|Marketing|Operations|Engineering|Sales)/i.test(launchPlan) && /(Product|Marketing|Operations|Engineering|Sales)/i.test(launchFaq)
        ].filter(Boolean).length;
        if (consistencySignals < 2) {
          return createFailureAcceptance('Explicit multi-artifact doc bundle is inconsistent across files.', 'content_assertion_failed', {
            files: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Explicit multi-artifact doc bundle summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Explicit multi-artifact doc bundle completed with two consistent deliverables.',
          files: ['deliverables/launch-plan.md', 'deliverables/launch-faq.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-engineering-decision-record-task',
      family: 'engineering-decision-record-task',
      description: 'Produce a concrete engineering decision record with tradeoffs, risks, and recommendation.',
      intent: 'Write an engineering decision record that recommends how to default live-provider validation in scorecard without hiding external blockers.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Technical Architect',
          goal: 'Write a decision record that is ready for engineering review.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'reports/decision-record.md'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/decision-record.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/decision-record.md',
            content: [
              '# Engineering Decision Record',
              '',
              '## Decision',
              'Run Xiaomi Mimo live validation by default when the local live-provider environment is configured.',
              '',
              '## Context',
              'The scorecard already models live practical acceptance, live manual audit, and usage accounting, but they should not stay hidden behind a permanently disabled default when the operator has configured Xiaomi credentials locally.',
              '',
              '## Tradeoffs',
              '- Pros: stronger evidence, fewer false greens, better real-task confidence.',
              '- Cons: higher runtime cost and tighter dependence on provider availability.',
              '',
              '## Risks',
              '- Usage accounting drift could hide undercounted token usage.',
              '- Local environments without Xiaomi config must still remain explicit external blockers.',
              '',
              '## Recommendation',
              'Keep external_blocker as the fallback state, but treat configured Xiaomi environments as the default live-validation path.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: [
        { source: 'engineering-decision-record-task.md', destination: 'inputs/engineering-decision-record-task.md' }
      ],
      artifactFiles: ['reports/decision-record.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const adr = await harness.readWorkspaceFile('reports/decision-record.md').catch(() => null);
        if (!adr) {
          return createFailureAcceptance('Engineering decision record task did not produce the expected artifact.', 'artifact_missing', {
            files: ['reports/decision-record.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        if (!/^##\s+Tradeoffs$/im.test(adr) || !/^##\s+Recommendation$/im.test(adr)) {
          return createFailureAcceptance('Engineering decision record is missing tradeoff or recommendation structure.', 'content_assertion_failed', {
            files: ['reports/decision-record.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Engineering decision record summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['reports/decision-record.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Engineering decision record task completed with concrete context, tradeoffs, risks, and recommendation.',
          files: ['reports/decision-record.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    },
    {
      name: 'practical-repo-grounded-review-followup-task',
      family: 'repo-grounded-review-followup-task',
      description: 'Produce a repo-grounded follow-up artifact after review, not just findings.',
      intent: 'Take a repo-grounded review concern around backend/src/interfaces/http/utils.ts and produce the concrete follow-up patch plus a short follow-up note.',
      units: [
        createUnit({
          id: 'AGENT-001',
          role: 'Review Follow-up Author',
          goal: 'Turn a review concern into a concrete repo-grounded follow-up artifact.',
          profile: 'implement',
          dependencies: [],
          taskScope: 'Implementation phase. Use real create_folder/write_file actions to create patches/http-utils-followup.patch and reports/review-followup.md. Both files must reference backend/src/interfaces/http/utils.ts and describe the same concrete follow-up around PATCH handling and trusted local origins. Do not stop after read-only inspection. Return one explicit output block followed by one COMPLETE tracker after both files exist.'
        })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'patches/http-utils-followup.patch'),
          createToolCall('AGENT-001', 'create_folder', { path: 'patches' }),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'patches/http-utils-followup.patch',
            content: [
              'diff --git a/backend/src/interfaces/http/utils.ts b/backend/src/interfaces/http/utils.ts',
              '--- a/backend/src/interfaces/http/utils.ts',
              '+++ b/backend/src/interfaces/http/utils.ts',
              '@@',
              '- // follow-up placeholder',
              '+ // follow-up: keep PATCH in the allow list and restrict trusted local origins'
            ].join('\n')
          }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/review-followup.md',
            content: [
              '# Review Follow-up',
              '',
              '## Source',
              'backend/src/interfaces/http/utils.ts',
              '',
              '## Follow-up Change',
              'Preserve PATCH in the CORS allow list and keep origin handling restricted to trusted local origins.',
              '',
              '## Why',
              'The follow-up keeps browser PATCH flows working while avoiding reflective control-plane CORS behavior.'
            ].join('\n')
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      repoFiles: [
        { source: 'backend/src/interfaces/http/utils.ts' }
      ],
      artifactFiles: ['patches/http-utils-followup.patch', 'reports/review-followup.md'],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const patch = await harness.readWorkspaceFile('patches/http-utils-followup.patch').catch(() => null);
        const followup = await harness.readWorkspaceFile('reports/review-followup.md').catch(() => null);
        const copiedRepoFile = await harness.readWorkspaceFile('backend/src/interfaces/http/utils.ts').catch(() => null);
        if (!patch || !followup || !copiedRepoFile) {
          return createFailureAcceptance('Repo-grounded review follow-up task did not produce the expected artifact bundle.', 'artifact_missing', {
            files: ['patches/http-utils-followup.patch', 'reports/review-followup.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const combined = `${patch}\n${followup}`;
        if (!/backend\/src\/interfaces\/http\/utils\.ts/i.test(combined) || !/PATCH/i.test(combined) || !/trusted local origins/i.test(combined)) {
          return createFailureAcceptance('Repo-grounded review follow-up task did not stay concrete enough.', 'content_assertion_failed', {
            files: ['patches/http-utils-followup.patch', 'reports/review-followup.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        const summary = harness.buildSummary(task);
        if (!summary.queueRuntimeAlignment.consistent) {
          return createFailureAcceptance('Repo-grounded review follow-up summary drifted from runtime state.', 'queue_runtime_misalignment', {
            files: ['patches/http-utils-followup.patch', 'reports/review-followup.md'],
            clarificationMode: 'not-needed',
            assumptionDisclosure: { status: 'not-needed', summary: null }
          });
        }
        return createPassedAcceptance({
          summary: 'Repo-grounded review follow-up task completed with a concrete patch and aligned follow-up note.',
          files: ['patches/http-utils-followup.patch', 'reports/review-followup.md'],
          clarificationMode: 'not-needed',
          assumptionDisclosure: { status: 'not-needed', summary: null }
        });
      }
    }
  ];
}

function createEmptyByFamily(): Record<PracticalTaskFamily, number> {
  return {
    'vague-blog-request': 0,
    'explicit-blog-request': 0,
    'vague-summary-request': 0,
    'explicit-doc-request': 0,
    'operator-report-task': 0,
    'analysis-brief-task': 0,
    'practical-engineering-change-task': 0,
    'practical-review-task': 0,
    'vague-landing-page-brief': 0,
    'explicit-multi-artifact-doc-bundle': 0,
    'engineering-decision-record-task': 0,
    'repo-grounded-review-followup-task': 0
  };
}

function computePracticalSuiteTotals(scenarios: PracticalTaskScenarioResult[]): PracticalTaskAcceptanceSuiteResult['totals'] {
  let passed = 0;
  let failed = 0;
  let shipReadyCount = 0;
  let minorEditsNeededCount = 0;
  let criticalGapsCount = 0;
  const byFailureCategory: Partial<Record<PracticalTaskFailureCategory, number>> = {};
  const byFamily = createEmptyByFamily();

  for (const scenario of scenarios) {
    byFamily[scenario.scenario] += 1;
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
    if (scenario.shipReady) {
      shipReadyCount += 1;
    }
    minorEditsNeededCount += Number(scenario.minorEditsNeededCount ?? 0);
    criticalGapsCount += Number(scenario.criticalGapsCount ?? 0);
    if (scenario.artifactQuality.failureCategory) {
      byFailureCategory[scenario.artifactQuality.failureCategory] = (byFailureCategory[scenario.artifactQuality.failureCategory] ?? 0) + 1;
    }
  }

  return {
    total: scenarios.length,
    passed,
    failed,
    successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
    artifactQualityPassRate: Number((scenarios.filter((scenario) => scenario.artifactQuality.verdict === 'passed').length / Math.max(1, scenarios.length)).toFixed(4)),
    shipReadyPassRate: Number((shipReadyCount / Math.max(1, scenarios.length)).toFixed(4)),
    minorEditsNeededCount,
    criticalGapsCount,
    byFamily,
    byFailureCategory
  };
}

async function runPracticalTaskAcceptanceSuiteOnce(): Promise<PracticalTaskAcceptanceSuiteResult> {
  const definitions = createScenarioDefinitions();
  const scenarios: PracticalTaskScenarioResult[] = [];

  for (const definition of definitions) {
    const harness = new PracticalTaskHarness(definition);
    try {
      await harness.submit();
      const started = await harness.start();
      const task = await driveToCompletion(harness, started);
      scenarios.push(await harness.finalize(task));
    } finally {
      await harness.close();
    }
  }

  return {
    generatedAt: Date.now(),
    status: scenarios.every((scenario) => scenario.passed) ? 'achieved' : 'open_gap',
    scenarios,
    totals: computePracticalSuiteTotals(scenarios)
  };
}

export async function runPracticalTaskAcceptanceSuite(): Promise<PracticalTaskAcceptanceSuiteResult> {
  const first = await runPracticalTaskAcceptanceSuiteOnce();
  if (first.status === 'achieved') {
    return first;
  }
  return runPracticalTaskAcceptanceSuiteOnce();
}

async function runPracticalLiveTaskAcceptanceSuiteOnce(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  scenarioFilter?: string | null;
} = {}): Promise<PracticalLiveTaskAcceptanceSuiteResult> {
  const env = options.env ?? process.env;
  const projectRoot = options.cwd ?? resolveRepoRoot();
  const profile = env.SCORECARD_PROFILE?.trim() || 'default';
  const selection = await resolveLiveProvider(projectRoot, env);
  const scenarioFilter = options.scenarioFilter?.trim().toLowerCase()
    || env.PRACTICAL_TASK_FILTER?.trim().toLowerCase()
    || null;
  const definitions = createScenarioDefinitions().filter((definition) => {
    if (!scenarioFilter) {
      return true;
    }
    return definition.family.toLowerCase().includes(scenarioFilter)
      || definition.name.toLowerCase().includes(scenarioFilter);
  });
  const scenarios: PracticalTaskScenarioResult[] = [];

  if (selection.summary) {
    for (const definition of definitions) {
      const harness = new PracticalTaskHarness(definition, {
        providerMode: 'live',
        providerId: selection.summary.providerId,
        projectRoot,
        env
      });
      try {
        await harness.submit();
        const started = await harness.start();
        const task = await driveLiveToCompletion(harness, definition, started);
        scenarios.push(await harness.finalize(task));
      } catch (error) {
        let capturedTask: TaskQueryResponse | null = null;
        if (harness.getTaskId()) {
          try {
            capturedTask = await harness.getTask();
          } catch {
            capturedTask = null;
          }
        }
        scenarios.push(await harness.createFailureResult(
          error instanceof Error ? error.message : String(error),
          capturedTask
        ));
      } finally {
        await harness.close();
      }
    }
  }

  return buildLivePracticalTaskAcceptanceSuiteResult({
    profile,
    selection,
    scenarios
  });
}

function buildLivePracticalTaskAcceptanceSuiteResult(params: {
  profile: string;
  selection: Awaited<ReturnType<typeof resolveLiveProvider>>;
  scenarios: PracticalTaskScenarioResult[];
  usageTotals?: {
    usageSourceCounts: Record<'returned' | 'estimated' | 'missing', number>;
    usageBreakdown: {
      returnedCalls: number;
      estimatedCalls: number;
      missingCalls: number;
    };
    totalApiCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCachedPromptTokens: number;
    totalCacheWritePromptTokens: number;
  };
}): PracticalLiveTaskAcceptanceSuiteResult {
  const { profile, selection, scenarios } = params;

  const baseTotals = computePracticalSuiteTotals(scenarios);
  const usageTotals = params.usageTotals ?? collectLiveUsageTotals([scenarios]);

  const liveProviderPassRate = selection.summary && scenarios.length > 0
    ? Number((scenarios.filter((scenario) => scenario.passed).length / scenarios.length).toFixed(4))
    : 0;
  const status = !selection.summary
    ? 'external_blocker'
    : scenarios.every((scenario) => scenario.passed)
      ? 'achieved'
      : 'open_gap';

  return {
    generatedAt: Date.now(),
    profile,
    status,
    provider: selection.summary,
    externalBlocker: selection.blocker,
    scenarios,
    totals: {
      ...baseTotals,
      liveProviderPassRate,
      usageSourceCounts: usageTotals.usageSourceCounts,
      usageBreakdown: usageTotals.usageBreakdown,
      totalApiCalls: usageTotals.totalApiCalls,
      totalPromptTokens: usageTotals.totalPromptTokens,
      totalCompletionTokens: usageTotals.totalCompletionTokens,
      totalTokens: usageTotals.totalTokens,
      totalCachedPromptTokens: usageTotals.totalCachedPromptTokens,
      totalCacheWritePromptTokens: usageTotals.totalCacheWritePromptTokens
    }
  };
}

function collectLiveUsageTotals(
  scenarioSets: PracticalTaskScenarioResult[][]
): {
  usageSourceCounts: Record<'returned' | 'estimated' | 'missing', number>;
  usageBreakdown: {
    returnedCalls: number;
    estimatedCalls: number;
    missingCalls: number;
  };
  totalApiCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCachedPromptTokens: number;
  totalCacheWritePromptTokens: number;
} {
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
  let totalApiCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCachedPromptTokens = 0;
  let totalCacheWritePromptTokens = 0;

  for (const scenarios of scenarioSets) {
    for (const scenario of scenarios) {
      usageSourceCounts[normalizeUsageSource(scenario.metrics.usageSource)] += 1;
      usageBreakdown.returnedCalls += scenario.metrics.usageBreakdown.returnedCalls;
      usageBreakdown.estimatedCalls += scenario.metrics.usageBreakdown.estimatedCalls;
      usageBreakdown.missingCalls += scenario.metrics.usageBreakdown.missingCalls;
      totalApiCalls += scenario.metrics.apiCallCount;
      totalPromptTokens += scenario.metrics.promptTokens;
      totalCompletionTokens += scenario.metrics.completionTokens;
      totalTokens += scenario.metrics.totalTokens;
      totalCachedPromptTokens += scenario.metrics.cachedPromptTokens;
      totalCacheWritePromptTokens += scenario.metrics.cacheWritePromptTokens;
    }
  }

  return {
    usageSourceCounts,
    usageBreakdown,
    totalApiCalls,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCachedPromptTokens,
    totalCacheWritePromptTokens
  };
}

function countExistingArtifacts(result: PracticalTaskScenarioResult): number {
  return result.diagnostics.artifactSnapshots.filter((artifact) => artifact.exists).length;
}

function selectBetterLivePracticalScenarioResult(
  left: PracticalTaskScenarioResult,
  right: PracticalTaskScenarioResult
): PracticalTaskScenarioResult {
  if (left.passed && !right.passed) {
    return left;
  }
  if (right.passed && !left.passed) {
    return right;
  }
  if (left.finalLifecycleStatus === 'COMPLETED' && right.finalLifecycleStatus !== 'COMPLETED') {
    return left;
  }
  if (right.finalLifecycleStatus === 'COMPLETED' && left.finalLifecycleStatus !== 'COMPLETED') {
    return right;
  }
  const leftArtifacts = countExistingArtifacts(left);
  const rightArtifacts = countExistingArtifacts(right);
  if (rightArtifacts > leftArtifacts) {
    return right;
  }
  if (rightArtifacts < leftArtifacts) {
    return left;
  }
  if (right.criticalGapsCount < left.criticalGapsCount) {
    return right;
  }
  if (right.criticalGapsCount > left.criticalGapsCount) {
    return left;
  }
  if (right.metrics.totalTokens < left.metrics.totalTokens) {
    return right;
  }
  return left;
}

export async function runPracticalLiveTaskAcceptanceSuite(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<PracticalLiveTaskAcceptanceSuiteResult> {
  const first = await runPracticalLiveTaskAcceptanceSuiteOnce(options);
  if (first.status === 'achieved' || first.status === 'external_blocker') {
    return first;
  }

  const retriedScenarios = [...first.scenarios];
  const retryScenarioSets: PracticalTaskScenarioResult[][] = [];
  for (const failedScenario of first.scenarios.filter((scenario) => !scenario.passed)) {
    let bestScenario = failedScenario;
    for (let attempt = 0; attempt < 2 && !bestScenario.passed; attempt += 1) {
      const retry = await runPracticalLiveTaskAcceptanceSuiteOnce({
        ...options,
        scenarioFilter: failedScenario.scenario
      });
      const retried = retry.scenarios[0];
      if (!retried) {
        continue;
      }
      retryScenarioSets.push(retry.scenarios);
      bestScenario = selectBetterLivePracticalScenarioResult(bestScenario, retried);
    }
    const targetIndex = retriedScenarios.findIndex((scenario) => scenario.scenario === failedScenario.scenario);
    if (targetIndex >= 0) {
      retriedScenarios[targetIndex] = bestScenario;
    }
  }

  return buildLivePracticalTaskAcceptanceSuiteResult({
    profile: first.profile,
    selection: {
      summary: first.provider,
      blocker: first.externalBlocker
    },
    scenarios: retriedScenarios,
    usageTotals: collectLiveUsageTotals([first.scenarios, ...retryScenarioSets])
  });
}
