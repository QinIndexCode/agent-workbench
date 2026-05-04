import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendNewFoundation } from '../../foundation/bootstrap/create-foundation';
import { createBackendNewRuntime } from '../create-runtime';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createToolSuccessResult } from '../../foundation/tools/result-envelope';
import { ProviderCompletionRequest, ProviderCompletionResponse } from '../../foundation/providers/client-types';
import { ContextGatingSummaryState, PromptSectionAttributionState } from '../../domain/contracts/types';
import { TaskQueryResponse } from '../tasks/types';
import {
  BenchmarkValidationScenarioName,
  RuntimeBenchmarkScenarioDefinition,
  RuntimeBenchmarkValidationScenarioDefinition,
  createRealisticBenchmarkDefinitions,
  createSyntheticBenchmarkDefinitions,
  createValidationBenchmarkDefinitions
} from './runtime-benchmark-scenarios';

export interface RuntimeBenchmarkScenarioMetrics {
  mode: 'PLANNER_PRIMARY' | 'SINGLE_ACTIVE_BASELINE';
  taskId: string;
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  stageCount: number;
  batchCount: number;
  plannedToolBatchCount: number;
  toolInvocationCount: number;
  averageToolInvocationsPerBatch: number;
  fallbackCount: number;
  stageUtilizationRatio: number;
  consolidationCorrectionCount: number;
  approvalBlockedBatchCount: number;
  plannerFallbackReasons: string[];
  compatibilityFallbackCount: number;
  correctionLoopRate: number;
  unsafeBatchRejectedCount: number;
  compressionDowngradeCount: number;
  plannerFallbackRate: number;
  stageReopenCount: number;
  sectionPromptChars: PromptSectionAttributionState;
  sectionPromptRatios: PromptSectionAttributionState;
  contextGating: ContextGatingSummaryState;
  rawContextTokens: number;
  gatedContextTokens: number;
  estimatedHistoryReductionRatio: number;
  estimatedSectionReductionRatio: number;
}

export interface RuntimeBenchmarkTokenAnalysis {
  dominantPlannerSection: keyof PromptSectionAttributionState;
  dominantBaselineSection: keyof PromptSectionAttributionState;
  historyReductionRatio: number;
  sectionReductionRatio: number;
  targetReductionRatio: number;
  actualReductionRatio: number;
  reductionGap: number;
  likelyBottleneck: 'stage_runtime' | 'task_memory' | 'validated_outputs' | 'context_history' | 'completion_tokens' | 'mixed';
}

export interface RuntimeBenchmarkResult {
  scenario: string;
  plannerPrimary: RuntimeBenchmarkScenarioMetrics;
  singleActiveBaseline: RuntimeBenchmarkScenarioMetrics;
  deltas: {
    apiCallReductionRatio: number;
    tokenReductionRatio: number;
    latencyReductionRatio: number;
  };
  tokenAnalysis: RuntimeBenchmarkTokenAnalysis;
  objectives: {
    plannerCallRangeSatisfied: boolean;
    tokenReductionTargetSatisfied: boolean;
    fallbackGuardSatisfied: boolean;
  };
}

export interface RuntimeBenchmarkValidationResult {
  scenario: BenchmarkValidationScenarioName;
  taskId: string;
  lifecycleStatus: TaskQueryResponse['runtime']['lifecycleStatus'];
  blockingReason: NonNullable<TaskQueryResponse['runtime']['planner']>['blockingReason'] | null;
  pendingBatchCount: number;
  approvalBlockedBatchCount: number;
  consolidationCorrectionCount: number;
  plannerFallbackReasons: string[];
  compatibilityFallbackCount: number;
  contextGating: ContextGatingSummaryState;
}

export interface RuntimeBenchmarkSuiteResult {
  syntheticBaseline: RuntimeBenchmarkResult;
  realisticComplexDag: RuntimeBenchmarkResult;
  validationScenarios: RuntimeBenchmarkValidationResult[];
}

interface MutableMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function createTempRoot(prefix = 'backend-new-benchmark-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function createBenchmarkIntent(scenario: string): string {
  return `Benchmark SCC-Batch terminal runtime with staged orchestration for ${scenario}. ${'Context load segment. '.repeat(180)}`;
}

function registerBenchmarkProvider(
  foundation: BackendNewFoundation,
  responses: string[],
  metrics: MutableMetrics
): void {
  const queue = [...responses];
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    baseUrl: 'https://provider.example.com',
    model: 'benchmark-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued for benchmark scenario.');
      }
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      const completionTokens = estimateTokens(next);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += promptTokens + completionTokens;
      return {
        responseId: `benchmark_resp_${metrics.apiCallCount}`,
        providerId: 'provider-main',
        model: 'benchmark-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          benchmark: true
        }
      };
    }
  });
}

async function registerBenchmarkTooling(runtime: ReturnType<typeof createBackendNewRuntime>, foundation: BackendNewFoundation): Promise<void> {
  runtime.extensions.registerTool({
    id: 'write-file',
    name: 'write_file',
    description: 'Write file',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [{ name: 'path', type: 'string', required: true }]
  });
  foundation.toolExecutors.register('write-file', {
    async execute(request) {
      return createToolSuccessResult({
        output: {
          path: request.invocation.arguments.path,
          ok: true
        },
        metadata: {
          benchmark: true
        }
      });
    }
  });
}

async function resolvePendingApprovals(
  runtime: ReturnType<typeof createBackendNewRuntime>,
  task: TaskQueryResponse
): Promise<TaskQueryResponse> {
  let currentTask = task;
  for (const approval of currentTask.pendingApprovals) {
    const resolved = await runtime.tasks.resolveToolApproval({
      taskId: currentTask.definition.taskId,
      invocationId: approval.invocationId,
      status: 'APPROVED',
      grantedBy: 'benchmark-auto-approver',
      reason: 'benchmark-auto-approve'
    });
    currentTask = resolved.task;
  }
  return currentTask;
}

async function applyRecommendedArtifactsIfNeeded(
  runtime: ReturnType<typeof createBackendNewRuntime>,
  task: TaskQueryResponse
): Promise<TaskQueryResponse | null> {
  const debug = await runtime.tasks.getTaskDebug(task.definition.taskId);
  if (debug.executionSummary.issueCategory !== 'artifact_destination_unresolved') {
    return null;
  }
  const destinationDir = debug.executionSummary.selectedArtifactDir
    ?? debug.executionSummary.recommendedArtifactDir
    ?? `benchmark-artifacts/runtime/${task.definition.taskId}`;
  const applied = await runtime.tasks.submitCommand({
    taskId: task.definition.taskId,
    type: 'APPLY_ARTIFACTS',
    message: destinationDir,
    metadata: {
      destinationDir
    }
  });
  return applied.task;
}

function summarizeMetrics(task: TaskQueryResponse, metrics: MutableMetrics, latencyMs: number): RuntimeBenchmarkScenarioMetrics {
  const completedUnitCount = task.runtime.completedUnits.length;
  const consolidationCorrectionCount = task.events.filter((event) => (
    event.type === 'CONSOLIDATION_COMPLETED'
    && event.payload
    && typeof event.payload === 'object'
    && (event.payload as { ok?: boolean }).ok === false
  )).length;
  const fallbackCount = task.events.filter((event) => (
    event.type === 'PLAN_CREATED'
    && event.payload
    && typeof event.payload === 'object'
    && Array.isArray((event.payload as { fallbackReasons?: unknown }).fallbackReasons)
    && ((event.payload as { fallbackReasons?: unknown[] }).fallbackReasons?.length ?? 0) > 0
  )).length;
  const plannedToolBatchIds = new Set<string>();
  for (const event of task.events) {
    if (!event.payload || typeof event.payload !== 'object') {
      continue;
    }
    if (event.type === 'TOOL_BATCH_PLANNED') {
      const batchId = (event.payload as { batchId?: unknown }).batchId;
      if (typeof batchId === 'string' && batchId.trim()) {
        plannedToolBatchIds.add(batchId);
      }
    }
    if (event.type === 'PLAN_CREATED') {
      const batches = (event.payload as {
        plannedToolBatches?: Array<{ batchId?: unknown }>;
      }).plannedToolBatches ?? [];
      for (const batch of batches) {
        if (typeof batch.batchId === 'string' && batch.batchId.trim()) {
          plannedToolBatchIds.add(batch.batchId);
        }
      }
    }
  }
  const executedToolBatchCount = task.events.filter((event) => event.type === 'TOOL_BATCH_EXECUTED').length;
  return {
    mode: task.definition.metadata['benchmark.forceSingleActiveFallback'] === true ? 'SINGLE_ACTIVE_BASELINE' : 'PLANNER_PRIMARY',
    taskId: task.definition.taskId,
    apiCallCount: metrics.apiCallCount,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    totalTokens: metrics.totalTokens,
    latencyMs,
    stageCount: task.runtime.planner?.stageCount ?? 0,
    batchCount: executedToolBatchCount,
    plannedToolBatchCount: Math.max(
      task.runtime.planner?.toolBatchCount ?? 0,
      plannedToolBatchIds.size,
      task.events.filter((event) => event.type === 'TOOL_BATCH_PLANNED').length
    ),
    toolInvocationCount: task.toolInvocations.length,
    averageToolInvocationsPerBatch: Number(
      (task.toolInvocations.length / Math.max(1, executedToolBatchCount || task.runtime.planner?.toolBatchCount || 0)).toFixed(4)
    ),
    fallbackCount,
    stageUtilizationRatio: Number((completedUnitCount / Math.max(1, metrics.apiCallCount)).toFixed(4)),
    consolidationCorrectionCount,
    approvalBlockedBatchCount: task.events.filter((event) => (
      event.type === 'TOOL_BATCH_EXECUTED'
      && event.payload
      && typeof event.payload === 'object'
      && (event.payload as { status?: string }).status === 'PARTIAL_APPROVAL_BLOCKED'
    )).length,
    plannerFallbackReasons: [...(task.runtime.planner?.fallbackReasons ?? [])],
    compatibilityFallbackCount: task.runtime.contractDiagnostics?.compatibilityFallbackCount ?? 0,
    correctionLoopRate: Number((consolidationCorrectionCount / Math.max(1, task.runtime.planner?.stageCount ?? 1)).toFixed(4)),
    unsafeBatchRejectedCount: task.runtime.unsafeBatchRejectedCount ?? 0,
    compressionDowngradeCount: task.runtime.compressionDowngraded ? 1 : 0,
    plannerFallbackRate: Number((fallbackCount / Math.max(1, metrics.apiCallCount)).toFixed(4)),
    stageReopenCount: consolidationCorrectionCount,
    sectionPromptChars: task.runtime.promptBudget.sectionPromptChars,
    sectionPromptRatios: task.runtime.promptBudget.sectionPromptRatios,
    contextGating: {
      ...(task.runtime.contextGating ?? {
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
        reasons: ['missing_runtime_context_gating_summary']
      }),
      reasons: [...(task.runtime.contextGating?.reasons ?? ['missing_runtime_context_gating_summary'])]
    },
    rawContextTokens: task.runtime.promptBudget.rawContextTokens ?? 0,
    gatedContextTokens: task.runtime.promptBudget.gatedContextTokens ?? 0,
    estimatedHistoryReductionRatio: task.runtime.promptBudget.estimatedHistoryReductionRatio ?? 0,
    estimatedSectionReductionRatio: task.runtime.promptBudget.estimatedSectionReductionRatio ?? 0
  };
}

function deriveBenchmarkContinueMessage(task: TaskQueryResponse): string | undefined {
  const diagnostics = task.runtime.contractDiagnostics;
  if (!diagnostics) {
    return undefined;
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TRACKER') {
    if (diagnostics.lastAcceptanceFailureCategory === 'exit_condition_mismatch') {
      return 'Return only one valid tracker JSON block for the current unit with status COMPLETE, progress_percent 100, decision CONTINUE, next_unit null, and no prose or tool blocks.';
    }
    return 'Return only one valid tracker JSON block for the current unit. Do not add prose, explicit output blocks, or tool blocks.';
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_TOOL_ACTION') {
    return 'Emit the required tool action evidence in this turn, then return the required explicit output block and one COMPLETE tracker JSON block. Do not stay in analysis mode.';
  }
  if (diagnostics.lastPendingCorrectionKind === 'AWAITING_OUTPUT_CORRECTION') {
    return 'Return one corrected explicit output block that satisfies the output contract, then one COMPLETE tracker JSON block. Do not emit tool blocks in this correction turn.';
  }
  if (diagnostics.correctionLoopNonConvergent) {
    return 'Resolve the pending correction for the current unit now and return only the missing structured output needed to complete the unit. Do not add extra prose.';
  }
  return undefined;
}

function findDominantSection(sectionPromptChars: PromptSectionAttributionState): keyof PromptSectionAttributionState {
  const pairs = Object.entries(sectionPromptChars) as Array<[keyof PromptSectionAttributionState, number]>;
  pairs.sort((left, right) => right[1] - left[1]);
  return pairs[0]?.[0] ?? 'stageRuntimeChars';
}

function classifyTokenBottleneck(params: {
  dominantPlannerSection: keyof PromptSectionAttributionState;
  historyReductionRatio: number;
  sectionReductionRatio: number;
  plannerCompletionTokens: number;
  plannerTotalTokens: number;
}): RuntimeBenchmarkTokenAnalysis['likelyBottleneck'] {
  if (params.historyReductionRatio < 0.2) {
    return 'context_history';
  }
  if ((params.plannerCompletionTokens / Math.max(1, params.plannerTotalTokens)) > 0.25) {
    return 'completion_tokens';
  }
  if (params.sectionReductionRatio < 0.2) {
    return 'mixed';
  }
  switch (params.dominantPlannerSection) {
    case 'stageRuntimeChars':
      return 'stage_runtime';
    case 'taskMemoryChars':
      return 'task_memory';
    case 'validatedOutputChars':
      return 'validated_outputs';
    default:
      return 'mixed';
  }
}

async function runScenario(definition: RuntimeBenchmarkScenarioDefinition): Promise<RuntimeBenchmarkScenarioMetrics> {
  const root = createTempRoot();
  const metrics: MutableMetrics = {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
  try {
    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: definition.configOverrides?.tools?.permissionMode ?? 'full'
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });
    registerBenchmarkProvider(foundation, definition.responses, metrics);
    await registerBenchmarkTooling(runtime, foundation);
    const submitted = await runtime.tasks.submitTask({
      title: `${definition.scenario}-${definition.mode}`,
      intent: createBenchmarkIntent(definition.scenario),
      preferredProviderId: 'provider-main',
      metadata: {
        'benchmark.forceSingleActiveFallback': definition.forceSingleActiveFallback
      },
      units: definition.units
    });
    const startedAt = Date.now();
    let task = (await runtime.tasks.startTask({ taskId: submitted.command.taskId })).task;
    let guard = 0;
    while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 16) {
      task = await runtime.tasks.getTask(submitted.command.taskId);
      if (definition.autoApprovePendingApprovals && task.pendingApprovals.length > 0) {
        task = await resolvePendingApprovals(runtime, task);
      }
      if (definition.stopOnBlockingReason && task.runtime.planner?.blockingReason === definition.stopOnBlockingReason) {
        break;
      }
      if (task.runtime.lifecycleStatus !== 'RUNNING') {
        break;
      }
      const applied = await applyRecommendedArtifactsIfNeeded(runtime, task);
      if (applied) {
        task = applied;
        guard += 1;
        continue;
      }
      task = (await runtime.tasks.continueTask({
        taskId: submitted.command.taskId,
        userMessage: deriveBenchmarkContinueMessage(task)
      })).task;
      guard += 1;
    }
    if (guard >= 16) {
      throw new Error(`Benchmark scenario "${definition.scenario}" exceeded continue-task guard.`);
    }
    const latencyMs = Date.now() - startedAt;
    return summarizeMetrics(task, metrics, latencyMs);
  } finally {
    removeDir(root);
  }
}

async function runValidationScenario(definition: RuntimeBenchmarkValidationScenarioDefinition): Promise<RuntimeBenchmarkValidationResult> {
  const root = createTempRoot();
  const metrics: MutableMetrics = {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
  try {
    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: definition.configOverrides?.tools?.permissionMode ?? 'full'
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });
    registerBenchmarkProvider(foundation, definition.responses, metrics);
    await registerBenchmarkTooling(runtime, foundation);
    const submitted = await runtime.tasks.submitTask({
      title: definition.validationName,
      intent: createBenchmarkIntent(definition.validationName),
      preferredProviderId: 'provider-main',
      metadata: {
        'benchmark.forceSingleActiveFallback': definition.forceSingleActiveFallback
      },
      units: definition.units
    });
    let task = (await runtime.tasks.startTask({ taskId: submitted.command.taskId })).task;
    let guard = 0;
    while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 16) {
      task = await runtime.tasks.getTask(submitted.command.taskId);
      if (definition.autoApprovePendingApprovals && task.pendingApprovals.length > 0) {
        task = await resolvePendingApprovals(runtime, task);
      }
      if (definition.stopOnBlockingReason && task.runtime.planner?.blockingReason === definition.stopOnBlockingReason) {
        break;
      }
      if (task.runtime.lifecycleStatus !== 'RUNNING') {
        break;
      }
      const applied = await applyRecommendedArtifactsIfNeeded(runtime, task);
      if (applied) {
        task = applied;
        guard += 1;
        continue;
      }
      task = (await runtime.tasks.continueTask({
        taskId: submitted.command.taskId,
        userMessage: deriveBenchmarkContinueMessage(task)
      })).task;
      guard += 1;
    }
    if (guard >= 16) {
      throw new Error(`Benchmark validation scenario "${definition.validationName}" exceeded continue-task guard.`);
    }
    return {
      scenario: definition.validationName,
      taskId: task.definition.taskId,
      lifecycleStatus: task.runtime.lifecycleStatus,
      blockingReason: task.runtime.planner?.blockingReason ?? null,
      pendingBatchCount: task.runtime.pendingToolBatches.length,
      approvalBlockedBatchCount: task.runtime.pendingToolBatches.filter((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED').length,
      consolidationCorrectionCount: task.events.filter((event) => (
        event.type === 'CONSOLIDATION_COMPLETED'
        && event.payload
        && typeof event.payload === 'object'
        && (event.payload as { ok?: boolean }).ok === false
      )).length,
      plannerFallbackReasons: [...(task.runtime.planner?.fallbackReasons ?? [])],
      compatibilityFallbackCount: task.runtime.contractDiagnostics?.compatibilityFallbackCount ?? 0,
      contextGating: {
        ...(task.runtime.contextGating ?? {
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
          reasons: ['missing_runtime_context_gating_summary']
        }),
        reasons: [...(task.runtime.contextGating?.reasons ?? ['missing_runtime_context_gating_summary'])]
      }
    };
  } finally {
    removeDir(root);
  }
}

function createBenchmarkResult(
  scenario: string,
  plannerPrimary: RuntimeBenchmarkScenarioMetrics,
  singleActiveBaseline: RuntimeBenchmarkScenarioMetrics
): RuntimeBenchmarkResult {
  const apiCallReductionRatio = Number(
    Math.max(0, 1 - (plannerPrimary.apiCallCount / Math.max(1, singleActiveBaseline.apiCallCount))).toFixed(4)
  );
  const tokenReductionRatio = Number(
    Math.max(0, 1 - (plannerPrimary.totalTokens / Math.max(1, singleActiveBaseline.totalTokens))).toFixed(4)
  );
  const latencyReductionRatio = Number(
    Math.max(0, 1 - (plannerPrimary.latencyMs / Math.max(1, singleActiveBaseline.latencyMs))).toFixed(4)
  );
  const targetReductionRatio = 0.7;
  const actualReductionRatio = tokenReductionRatio;
  const reductionGap = Number(Math.max(0, targetReductionRatio - actualReductionRatio).toFixed(4));
  const dominantPlannerSection = findDominantSection(plannerPrimary.sectionPromptChars);
  const dominantBaselineSection = findDominantSection(singleActiveBaseline.sectionPromptChars);
  return {
    scenario,
    plannerPrimary,
    singleActiveBaseline,
    deltas: {
      apiCallReductionRatio,
      tokenReductionRatio,
      latencyReductionRatio
    },
    tokenAnalysis: {
      dominantPlannerSection,
      dominantBaselineSection,
      historyReductionRatio: plannerPrimary.estimatedHistoryReductionRatio,
      sectionReductionRatio: plannerPrimary.estimatedSectionReductionRatio,
      targetReductionRatio,
      actualReductionRatio,
      reductionGap,
      likelyBottleneck: classifyTokenBottleneck({
        dominantPlannerSection,
        historyReductionRatio: plannerPrimary.estimatedHistoryReductionRatio,
        sectionReductionRatio: plannerPrimary.estimatedSectionReductionRatio,
        plannerCompletionTokens: plannerPrimary.completionTokens,
        plannerTotalTokens: plannerPrimary.totalTokens
      })
    },
    objectives: {
      plannerCallRangeSatisfied: plannerPrimary.apiCallCount >= 1 && plannerPrimary.apiCallCount <= 3,
      tokenReductionTargetSatisfied: tokenReductionRatio >= targetReductionRatio,
      fallbackGuardSatisfied: plannerPrimary.fallbackCount === 0 && singleActiveBaseline.fallbackCount > 0
    }
  };
}

export async function runFixedRuntimeBenchmark(): Promise<RuntimeBenchmarkResult> {
  const synthetic = createSyntheticBenchmarkDefinitions();
  const plannerPrimary = await runScenario(synthetic.plannerPrimary);
  const singleActiveBaseline = await runScenario(synthetic.singleActiveBaseline);
  return createBenchmarkResult('fixed-complex-dag', plannerPrimary, singleActiveBaseline);
}

export async function runRuntimeBenchmarkSuite(): Promise<RuntimeBenchmarkSuiteResult> {
  const synthetic = createSyntheticBenchmarkDefinitions();
  const realistic = createRealisticBenchmarkDefinitions();
  const validationDefinitions = createValidationBenchmarkDefinitions();
  const syntheticPlannerPrimary = await runScenario(synthetic.plannerPrimary);
  const syntheticSingleActive = await runScenario(synthetic.singleActiveBaseline);
  const realisticPlannerPrimary = await runScenario(realistic.plannerPrimary);
  const realisticSingleActive = await runScenario(realistic.singleActiveBaseline);
  const validationScenarios: RuntimeBenchmarkValidationResult[] = [];
  for (const definition of validationDefinitions) {
    validationScenarios.push(await runValidationScenario(definition));
  }
  return {
    syntheticBaseline: createBenchmarkResult('fixed-complex-dag', syntheticPlannerPrimary, syntheticSingleActive),
    realisticComplexDag: createBenchmarkResult('realistic-complex-dag', realisticPlannerPrimary, realisticSingleActive),
    validationScenarios
  };
}
