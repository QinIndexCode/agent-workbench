import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackendNewFoundation } from '../../foundation/bootstrap/create-foundation';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createToolFailureResult, createToolSuccessResult } from '../../foundation/tools/result-envelope';
import { ProviderCompletionRequest, ProviderCompletionResponse } from '../../foundation/providers/client-types';
import { createBackendNewRuntime, BackendNewRuntime } from '../create-runtime';
import { AgentUnit, ExecutionProfileId, TaskLifecycleStatus } from '../../domain/contracts/types';
import { buildTaskExecutionSummary } from '../tasks/task-execution-observability';
import {
  TaskExecutionIssueCategory,
  TaskExecutionSummary,
  TaskObservationHookId,
  TaskQueryResponse
} from '../tasks/types';

interface MutableMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface MutableScenarioCounters {
  continueCount: number;
  continueMessageCount: number;
  pauseCount: number;
  resumeCount: number;
  approvalCount: number;
  recoveryCount: number;
}

interface FlagshipScenarioExpectation {
  lifecycleStatus: TaskLifecycleStatus;
  requiredEventTypes: string[];
  minToolInvocations?: number;
  minApprovalCount?: number;
  minRecoveryCount?: number;
  minExecutedToolBatches?: number;
  maxApiCallCount?: number;
}

interface FlagshipScenarioDefinition {
  name: string;
  description: string;
  units: AgentUnit[];
  responses: string[];
  configOverrides?: {
    tools?: {
      permissionMode?: 'full' | 'ask';
    };
  };
  expectation: FlagshipScenarioExpectation;
  execute(harness: FlagshipScenarioHarness): Promise<TaskQueryResponse>;
}

export interface TaskFlagshipScenarioMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

export interface TaskFlagshipScenarioResult {
  scenario: string;
  description: string;
  taskId: string;
  passed: boolean;
  finalLifecycleStatus: TaskLifecycleStatus;
  finalQueueState: NonNullable<TaskQueryResponse['queue']>['state'] | null;
  issueCategory: TaskExecutionIssueCategory | null;
  issueSummary: string | null;
  missingRequiredEventTypes: string[];
  observedHooks: TaskObservationHookId[];
  executionSummary: TaskExecutionSummary;
  metrics: TaskFlagshipScenarioMetrics;
}

export interface TaskFlagshipScenarioSuiteResult {
  generatedAt: number;
  scenarios: TaskFlagshipScenarioResult[];
  totals: {
    passed: number;
    failed: number;
    successRate: number;
    averageApiCallCount: number;
    averageExecutedToolBatchCount: number;
    averageToolInvocationsPerBatch: number;
    averageContinueCount: number;
    averageRecoveryCount: number;
    plannerFallbackScenarioCount: number;
    byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>>;
    callCountTargetsSatisfied: boolean;
  };
}

function createTempRoot(prefix = 'backend-new-flagship-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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

function createTracker(unitId: string, nextUnit?: string | null): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'COMPLETE',
    progress_percent: 100,
    decision: 'CONTINUE',
    reason: 'flagship scenario step complete',
    next_unit: nextUnit ?? null,
    files_created: []
  });
}

function createInProgressTracker(unitId: string, reason = 'waiting for tool results before final verification'): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'IN_PROGRESS',
    progress_percent: 75,
    decision: 'CONTINUE',
    reason,
    next_unit: unitId,
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
    exitCondition: '{"report":"required"}',
    executionProfileId: params.profile,
    dependencies: params.dependencies
  };
}

function registerFlagshipProvider(
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
    model: 'flagship-benchmark-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued for flagship scenario.');
      }
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      const completionTokens = estimateTokens(next);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += promptTokens + completionTokens;
      return {
        responseId: `flagship_resp_${metrics.apiCallCount}`,
        providerId: 'provider-main',
        model: 'flagship-benchmark-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          flagshipScenario: true
        }
      };
    }
  });
}

function registerFlagshipCommandTool(foundation: BackendNewFoundation): void {
  if (!foundation.extensions.findTool('run-command') && !foundation.extensions.findTool('run_command')) {
    foundation.extensions.registerTool({
      id: 'run-command',
      name: 'run_command',
      description: 'Run a deterministic workspace command during flagship scenarios.',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'command', type: 'string', required: true },
        { name: 'input', type: 'string' },
        { name: 'output', type: 'string' }
      ]
    });
  }

  foundation.toolExecutors.register('run-command', {
      async execute(request) {
        const command = String(request.invocation.arguments.command ?? '').trim();
        const inputPath = typeof request.invocation.arguments.input === 'string'
          ? request.invocation.arguments.input
          : null;
        const outputPath = typeof request.invocation.arguments.output === 'string'
          ? request.invocation.arguments.output
          : null;

        try {
          if (command === 'uppercase-file') {
            if (!inputPath || !outputPath) {
              return createToolFailureResult({
                kind: 'EXECUTION',
                message: 'uppercase-file requires input and output paths.'
              });
            }
            const inputResolved = foundation.layout.resolveWorkspacePath(request.invocation.taskId, inputPath);
            const outputResolved = foundation.layout.resolveWorkspacePath(request.invocation.taskId, outputPath);
            const content = await fsp.readFile(inputResolved, foundation.config.storage.encoding);
            await fsp.mkdir(path.dirname(outputResolved), { recursive: true });
            await fsp.writeFile(outputResolved, content.toUpperCase(), foundation.config.storage.encoding);
            return createToolSuccessResult({
              output: {
                command,
                output: outputPath
              }
            });
          }

          if (command === 'append-checksum') {
            if (!inputPath) {
              return createToolFailureResult({
                kind: 'EXECUTION',
                message: 'append-checksum requires an input path.'
              });
            }
            const resolved = foundation.layout.resolveWorkspacePath(request.invocation.taskId, inputPath);
            const content = await fsp.readFile(resolved, foundation.config.storage.encoding);
            const next = `${content}\nchecksum:${Buffer.byteLength(content, foundation.config.storage.encoding)}`;
            await fsp.writeFile(resolved, next, foundation.config.storage.encoding);
            return createToolSuccessResult({
              output: {
                command,
                input: inputPath
              }
            });
          }

          return createToolFailureResult({
            kind: 'EXECUTION',
            message: `Unsupported flagship command "${command}".`
          });
        } catch (error) {
          return createToolFailureResult({
            kind: 'EXECUTION',
            message: error instanceof Error ? error.message : 'Flagship command failed.'
          });
        }
      }
    });
}

class FlagshipScenarioHarness {
  private readonly rootDir = createTempRoot();
  private readonly metrics: MutableMetrics = {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
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
  private readonly responseQueue: string[];

  constructor(private readonly definition: FlagshipScenarioDefinition) {
    this.responseQueue = [...definition.responses];
  }

  private async bootRuntime(): Promise<void> {
    this.foundation = createBackendNewFoundation({
      cwd: this.rootDir,
      config: {
        paths: {
          rootDir: this.rootDir
        },
        tools: {
          permissionMode: this.definition.configOverrides?.tools?.permissionMode ?? 'full'
        }
      }
    });
    this.runtime = createBackendNewRuntime({
      foundation: this.foundation
    });
    registerFlagshipProvider(this.foundation, this.responseQueue, this.metrics);
    registerFlagshipCommandTool(this.foundation);
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`Flagship scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`Flagship scenario "${this.definition.name}" has no submitted task id.`);
    }
    return this.taskId;
  }

  async submit(): Promise<TaskQueryResponse> {
    if (!this.runtime || !this.foundation) {
      await this.bootRuntime();
    }
    const runtime = this.requireRuntime();
    const submitted = await runtime.tasks.submitTask({
      title: this.definition.name,
      intent: `${this.definition.description} ${'flagship-context '.repeat(28)}`.trim(),
      preferredProviderId: 'provider-main',
      metadata: {
        flagshipScenario: this.definition.name
      },
      units: this.definition.units
    });
    this.taskId = submitted.command.taskId;
    return submitted.task;
  }

  async start(userMessage?: string): Promise<TaskQueryResponse> {
    const runtime = this.requireRuntime();
    const started = await runtime.tasks.startTask({
      taskId: this.requireTaskId(),
      userMessage
    });
    return started.task;
  }

  async continue(userMessage?: string): Promise<TaskQueryResponse> {
    this.counters.continueCount += 1;
    if (userMessage?.trim()) {
      this.counters.continueMessageCount += 1;
    }
    const runtime = this.requireRuntime();
    const next = await runtime.tasks.continueTask({
      taskId: this.requireTaskId(),
      userMessage
    });
    return next.task;
  }

  async applyRecommendedArtifacts(task: TaskQueryResponse): Promise<TaskQueryResponse | null> {
    const summary = buildTaskExecutionSummary(task);
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
        destinationDir
      }
    });
    return applied.task;
  }

  async pause(reason = 'flagship scenario pause'): Promise<TaskQueryResponse> {
    this.counters.pauseCount += 1;
    const runtime = this.requireRuntime();
    const paused = await runtime.tasks.pauseTask({
      taskId: this.requireTaskId(),
      reason
    });
    return paused.task;
  }

  async resume(userMessage?: string): Promise<TaskQueryResponse> {
    this.counters.resumeCount += 1;
    const runtime = this.requireRuntime();
    const resumed = await runtime.tasks.resumeTask({
      taskId: this.requireTaskId(),
      userMessage
    });
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
        grantedBy: 'flagship-auto-approver',
        reason: 'flagship scenario auto-approval'
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
    return runtime.tasks.getTask(this.requireTaskId());
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    removeDir(this.rootDir);
  }

  async finalize(task: TaskQueryResponse): Promise<TaskFlagshipScenarioResult> {
    const summary = buildTaskExecutionSummary(task);
    const missingRequiredEventTypes = this.definition.expectation.requiredEventTypes
      .filter((type) => !task.events.some((event) => event.type === type));
    const passed = task.runtime.lifecycleStatus === this.definition.expectation.lifecycleStatus
      && missingRequiredEventTypes.length === 0
      && task.toolInvocations.length >= (this.definition.expectation.minToolInvocations ?? 0)
      && this.counters.approvalCount >= (this.definition.expectation.minApprovalCount ?? 0)
      && this.counters.recoveryCount >= (this.definition.expectation.minRecoveryCount ?? 0)
      && summary.batchExecution.executedToolBatchCount >= (this.definition.expectation.minExecutedToolBatches ?? 0)
      && this.metrics.apiCallCount <= (this.definition.expectation.maxApiCallCount ?? Number.POSITIVE_INFINITY);

    return {
      scenario: this.definition.name,
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
      metrics: {
        apiCallCount: this.metrics.apiCallCount,
        promptTokens: this.metrics.promptTokens,
        completionTokens: this.metrics.completionTokens,
        totalTokens: this.metrics.totalTokens,
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
      }
    };
  }
}

async function driveToCompletion(
  harness: FlagshipScenarioHarness,
  initialTask: TaskQueryResponse,
  continueMessages: Array<string | undefined> = []
): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 16) {
    if (task.pendingApprovals.length > 0) {
      task = await harness.approveAll(task);
    } else {
      const applied = await harness.applyRecommendedArtifacts(task);
      if (applied) {
        task = applied;
        guard += 1;
        continue;
      }
      task = await harness.continue(continueMessages[guard]);
    }
    guard += 1;
  }
  if (guard >= 16) {
    throw new Error(`Flagship scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function createFlagshipScenarioDefinitions(): FlagshipScenarioDefinition[] {
  return [
    {
      name: 'flagship-multi-file-implementation',
      description: 'Implement multiple files, generate tests, and verify the resulting workspace in minimal model turns.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Requirements Analyst', goal: 'Capture requirements', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Test Strategist', goal: 'Capture test strategy', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-003', role: 'Feature Implementer', goal: 'Write the feature module', profile: 'implement', dependencies: ['AGENT-001', 'AGENT-002'] }),
        createUnit({ id: 'AGENT-004', role: 'Test Implementer', goal: 'Write the test module', profile: 'implement', dependencies: ['AGENT-001', 'AGENT-002'] }),
        createUnit({ id: 'AGENT-005', role: 'Verifier', goal: 'Verify module and tests', profile: 'verify', dependencies: ['AGENT-003', 'AGENT-004'] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'analysis/requirements.md'),
          createTracker('AGENT-001'),
          createOutput('AGENT-002', 'analysis/tests.md'),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'src/feature.ts'),
          createToolCall('AGENT-003', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-003', 'write_file', { path: 'src/feature.ts', content: 'export const featureReady = true;\n' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'tests/feature.test.ts'),
          createToolCall('AGENT-004', 'create_folder', { path: 'tests' }),
          createToolCall('AGENT-004', 'write_file', { path: 'tests/feature.test.ts', content: 'test(\"feature\", () => expect(true).toBe(true));\n' }),
          createTracker('AGENT-004')
        ].join('\n'),
        [
          createOutput('AGENT-005', 'verification/feature.md'),
          createToolCall('AGENT-005', 'list_files', { path: '.', recursive: true }),
          createToolCall('AGENT-005', 'read_file', { path: 'src/feature.ts' }),
          createToolCall('AGENT-005', 'read_file', { path: 'tests/feature.test.ts' }),
          createToolCall('AGENT-005', 'search_files', { path: '.', pattern: 'featureReady' }),
          createInProgressTracker('AGENT-005')
        ].join('\n'),
        [createOutput('AGENT-005', 'verification/feature.md', { report: 'verified feature and test files from tool results' }), createTracker('AGENT-005')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 8,
        minExecutedToolBatches: 2,
        maxApiCallCount: 4
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'flagship-regression-diagnosis',
      description: 'Diagnose a regression by collecting evidence through batched search, reads, and deterministic command output.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Log Analyst', goal: 'Frame the log investigation', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Trace Analyst', goal: 'Frame the trace investigation', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-003', role: 'Evidence Collector', goal: 'Collect log evidence', profile: 'implement', dependencies: ['AGENT-001', 'AGENT-002'] }),
        createUnit({ id: 'AGENT-004', role: 'Signal Collector', goal: 'Collect trace evidence', profile: 'implement', dependencies: ['AGENT-001', 'AGENT-002'] }),
        createUnit({ id: 'AGENT-005', role: 'Regression Verifier', goal: 'Verify the diagnosis output', profile: 'verify', dependencies: ['AGENT-003', 'AGENT-004'] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'analysis/logs.md'),
          createTracker('AGENT-001'),
          createOutput('AGENT-002', 'analysis/traces.md'),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'logs/runtime.log'),
          createToolCall('AGENT-003', 'create_folder', { path: 'logs' }),
          createToolCall('AGENT-003', 'write_file', { path: 'logs/runtime.log', content: 'ERROR regression detected\nWARN fallback entered\n' }),
          createToolCall('AGENT-003', 'read_file', { path: 'logs/runtime.log' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'logs/trace.txt'),
          createToolCall('AGENT-004', 'write_file', { path: 'logs/trace.txt', content: 'trace: search evidence\ntrace: batch candidate\n' }),
          createToolCall('AGENT-004', 'search_files', { path: 'logs', pattern: 'trace' }),
          createTracker('AGENT-004')
        ].join('\n'),
        [
          createOutput('AGENT-005', 'diagnosis/regression.md'),
          createToolCall('AGENT-005', 'run_command', { command: 'uppercase-file', input: 'logs/runtime.log', output: 'logs/runtime.upper.txt' }),
          createToolCall('AGENT-005', 'read_file', { path: 'logs/runtime.upper.txt' }),
          createToolCall('AGENT-005', 'search_files', { path: 'logs', pattern: 'REGRESSION' }),
          createInProgressTracker('AGENT-005')
        ].join('\n'),
        [createOutput('AGENT-005', 'diagnosis/regression.md', { report: 'verified regression evidence from command, read, and search results' }), createTracker('AGENT-005')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 8,
        minExecutedToolBatches: 2,
        maxApiCallCount: 4
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'flagship-batch-file-modification',
      description: 'Modify multiple files in one implementation stage and validate the resulting batch in a single verification turn.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Planner', goal: 'Plan the batch edit', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Module Editor', goal: 'Write module A', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Config Editor', goal: 'Write module B', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-004', role: 'Doc Editor', goal: 'Write module C', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-005', role: 'Verifier', goal: 'Read back the batch edits', profile: 'verify', dependencies: ['AGENT-002', 'AGENT-003', 'AGENT-004'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'batch/plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'src/a.ts'),
          createToolCall('AGENT-002', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-002', 'write_file', { path: 'src/a.ts', content: 'export const aReady = true;\n' }),
          createTracker('AGENT-002'),
          createOutput('AGENT-003', 'src/b.ts'),
          createToolCall('AGENT-003', 'write_file', { path: 'src/b.ts', content: 'export const bReady = true;\n' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'docs/batch.md'),
          createToolCall('AGENT-004', 'create_folder', { path: 'docs' }),
          createToolCall('AGENT-004', 'write_file', { path: 'docs/batch.md', content: '# Batch Update\n\nAll files updated.\n' }),
          createTracker('AGENT-004')
        ].join('\n'),
        [
          createOutput('AGENT-005', 'batch/verify.md'),
          createToolCall('AGENT-005', 'read_file', { path: 'src/a.ts' }),
          createToolCall('AGENT-005', 'read_file', { path: 'src/b.ts' }),
          createToolCall('AGENT-005', 'read_file', { path: 'docs/batch.md' }),
          createToolCall('AGENT-005', 'list_files', { path: '.', recursive: true }),
          createInProgressTracker('AGENT-005')
        ].join('\n'),
        [createOutput('AGENT-005', 'batch/verify.md', { report: 'verified batch files from read_file and list_files results' }), createTracker('AGENT-005')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 9,
        minExecutedToolBatches: 2,
        maxApiCallCount: 4
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'flagship-approval-sensitive-write',
      description: 'Execute approval-sensitive write batches, recover after restart, and finish with a verification pass.',
      configOverrides: {
        tools: {
          permissionMode: 'ask'
        }
      },
      units: [
        createUnit({ id: 'AGENT-001', role: 'Planner', goal: 'Prepare guarded changes', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Guarded Writer A', goal: 'Write the first guarded file', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Guarded Writer B', goal: 'Write the second guarded file', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-004', role: 'Verifier', goal: 'Verify approved files', profile: 'verify', dependencies: ['AGENT-002', 'AGENT-003'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'approval/plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'secure/a.txt'),
          createToolCall('AGENT-002', 'create_folder', { path: 'secure' }),
          createToolCall('AGENT-002', 'write_file', { path: 'secure/a.txt', content: 'guarded-a\n' }),
          createTracker('AGENT-002'),
          createOutput('AGENT-003', 'secure/b.txt'),
          createToolCall('AGENT-003', 'write_file', { path: 'secure/b.txt', content: 'guarded-b\n' }),
          createTracker('AGENT-003')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'secure/a.txt', { report: 'guarded file finalized after approval' }),
          createTracker('AGENT-002'),
          createOutput('AGENT-003', 'secure/b.txt', { report: 'guarded file finalized after approval' }),
          createTracker('AGENT-003')
        ].join('\n'),
        [
          createOutput('AGENT-004', 'approval/verify.md'),
          createToolCall('AGENT-004', 'read_file', { path: 'secure/a.txt' }),
          createToolCall('AGENT-004', 'read_file', { path: 'secure/b.txt' }),
          createInProgressTracker('AGENT-004')
        ].join('\n'),
        [createOutput('AGENT-004', 'approval/verify.md', { report: 'verified approved files from read_file results' }), createTracker('AGENT-004')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_APPROVAL_RESOLVED', 'TASK_COMPLETED'],
        minToolInvocations: 5,
        minApprovalCount: 2,
        minExecutedToolBatches: 2,
        maxApiCallCount: 6
      },
      async execute(harness) {
        await harness.submit();
        let task = await harness.start();
        if (task.runtime.lifecycleStatus === 'RUNNING' && task.pendingApprovals.length === 0) {
          task = await harness.continue();
        }
        if (task.pendingApprovals.length > 0) {
          task = await harness.approveAll(task);
        }
        return driveToCompletion(harness, task);
      }
    },
    {
      name: 'flagship-long-running-recovery',
      description: 'Pause, resume, restart, and finish a long-running tool-heavy task without losing recovery state.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Recovery Analyst', goal: 'Prepare long-running execution', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Recovery Implementer A', goal: 'Write runtime state A', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Recovery Implementer B', goal: 'Write runtime state B', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-004', role: 'Recovery Verifier', goal: 'Verify recovered runtime state', profile: 'verify', dependencies: ['AGENT-002', 'AGENT-003'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'recovery/plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'runtime/a.txt'),
          createToolCall('AGENT-002', 'create_folder', { path: 'runtime' }),
          createToolCall('AGENT-002', 'write_file', { path: 'runtime/a.txt', content: 'runtime-a\n' }),
          createTracker('AGENT-002'),
          createOutput('AGENT-003', 'runtime/b.txt'),
          createToolCall('AGENT-003', 'write_file', { path: 'runtime/b.txt', content: 'runtime-b\n' }),
          createTracker('AGENT-003')
        ].join('\n'),
        [
          createOutput('AGENT-004', 'recovery/verify.md'),
          createToolCall('AGENT-004', 'read_file', { path: 'runtime/a.txt' }),
          createToolCall('AGENT-004', 'read_file', { path: 'runtime/b.txt' }),
          createToolCall('AGENT-004', 'run_command', { command: 'append-checksum', input: 'runtime/a.txt' }),
          createInProgressTracker('AGENT-004')
        ].join('\n'),
        [createOutput('AGENT-004', 'recovery/verify.md', { report: 'verified recovered runtime files from read_file and command results' }), createTracker('AGENT-004')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_PAUSED', 'TASK_RESUMED', 'TASK_COMPLETED'],
        minToolInvocations: 6,
        minRecoveryCount: 1,
        minExecutedToolBatches: 2,
        maxApiCallCount: 6
      },
      async execute(harness) {
        await harness.submit();
        let task = await harness.start();
        task = await harness.pause('Pause before continuing the long-running scenario.');
        task = await harness.resume('Resume after intentional pause.');
        task = await harness.restartRuntime();
        if (task.runtime.lifecycleStatus === 'PAUSED') {
          task = await harness.resume('Resume after runtime restart.');
        }
        return driveToCompletion(harness, task);
      }
    }
  ];
}

export async function runTaskFlagshipScenarioSuite(): Promise<TaskFlagshipScenarioSuiteResult> {
  const definitions = createFlagshipScenarioDefinitions();
  const scenarios: TaskFlagshipScenarioResult[] = [];

  for (const definition of definitions) {
    const harness = new FlagshipScenarioHarness(definition);
    try {
      const task = await definition.execute(harness);
      scenarios.push(await harness.finalize(task));
    } finally {
      await harness.close();
    }
  }

  let passed = 0;
  let failed = 0;
  let totalApiCalls = 0;
  let totalExecutedToolBatches = 0;
  let totalToolInvocationsPerBatch = 0;
  let totalContinueCount = 0;
  let totalRecoveryCount = 0;
  let plannerFallbackScenarioCount = 0;
  const byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>> = {};

  for (const scenario of scenarios) {
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
    totalApiCalls += scenario.metrics.apiCallCount;
    totalExecutedToolBatches += scenario.metrics.executedToolBatchCount;
    totalToolInvocationsPerBatch += scenario.metrics.averageToolInvocationsPerBatch;
    totalContinueCount += scenario.metrics.continueCount;
    totalRecoveryCount += scenario.metrics.recoveryCount;
    if (scenario.metrics.plannerFallbackCount > 0) {
      plannerFallbackScenarioCount += 1;
    }
    if (scenario.issueCategory) {
      byIssueCategory[scenario.issueCategory] = (byIssueCategory[scenario.issueCategory] ?? 0) + 1;
    }
  }

  return {
    generatedAt: Date.now(),
    scenarios,
    totals: {
      passed,
      failed,
      successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      averageApiCallCount: Number((totalApiCalls / Math.max(1, scenarios.length)).toFixed(4)),
      averageExecutedToolBatchCount: Number((totalExecutedToolBatches / Math.max(1, scenarios.length)).toFixed(4)),
      averageToolInvocationsPerBatch: Number((totalToolInvocationsPerBatch / Math.max(1, scenarios.length)).toFixed(4)),
      averageContinueCount: Number((totalContinueCount / Math.max(1, scenarios.length)).toFixed(4)),
      averageRecoveryCount: Number((totalRecoveryCount / Math.max(1, scenarios.length)).toFixed(4)),
      plannerFallbackScenarioCount,
      byIssueCategory,
      callCountTargetsSatisfied: scenarios.every((scenario) => scenario.metrics.apiCallCount <= 6)
    }
  };
}
