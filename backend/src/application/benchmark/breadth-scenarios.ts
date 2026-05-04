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

interface BreadthScenarioExpectation {
  lifecycleStatus: TaskLifecycleStatus;
  requiredEventTypes: string[];
  minToolInvocations?: number;
  minApprovalCount?: number;
  minRecoveryCount?: number;
  minContinueMessages?: number;
}

interface BreadthScenarioDefinition {
  name: string;
  category:
    | 'bug-fix'
    | 'refactor'
    | 'docs-generation'
    | 'config-edit'
    | 'test-repair'
    | 'regression-diagnosis'
    | 'multi-file-implementation'
    | 'memory-context-heavy'
    | 'approval-sensitive-tool'
    | 'long-running-recovery';
  description: string;
  units: AgentUnit[];
  responses: string[];
  configOverrides?: {
    tools?: {
      permissionMode?: 'full' | 'ask';
    };
  };
  expectation: BreadthScenarioExpectation;
  execute(harness: BreadthScenarioHarness): Promise<TaskQueryResponse>;
}

export interface TaskBreadthScenarioMetrics {
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
}

export interface TaskBreadthScenarioResult {
  scenario: string;
  category: BreadthScenarioDefinition['category'];
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
  metrics: TaskBreadthScenarioMetrics;
}

export interface TaskBreadthScenarioSuiteResult {
  generatedAt: number;
  scenarios: TaskBreadthScenarioResult[];
  totals: {
    passed: number;
    failed: number;
    successRate: number;
    averageApiCallCount: number;
    averagePlannerFallbackRate: number;
    averageRecoveryCount: number;
    averageApprovalBlockedBatchRate: number;
    byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>>;
    byCategory: Record<string, number>;
  };
}

function createTempRoot(prefix = 'backend-new-breadth-'): string {
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

function createTracker(unitId: string): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'COMPLETE',
    progress_percent: 100,
    decision: 'CONTINUE',
    reason: 'breadth scenario step complete',
    next_unit: null,
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

function registerBreadthProvider(
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
    model: 'breadth-benchmark-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued for breadth scenario.');
      }
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      const completionTokens = estimateTokens(next);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += promptTokens + completionTokens;
      return {
        responseId: `breadth_resp_${metrics.apiCallCount}`,
        providerId: 'provider-main',
        model: 'breadth-benchmark-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          breadthScenario: true
        }
      };
    }
  });
}

function registerBreadthCommandTool(foundation: BackendNewFoundation): void {
  if (!foundation.extensions.findTool('run-command') && !foundation.extensions.findTool('run_command')) {
    foundation.extensions.registerTool({
      id: 'run-command',
      name: 'run_command',
      description: 'Run a deterministic workspace command during breadth scenarios.',
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
            message: `Unsupported breadth command "${command}".`
          });
        } catch (error) {
          return createToolFailureResult({
            kind: 'EXECUTION',
            message: error instanceof Error ? error.message : 'Breadth command failed.'
          });
        }
      }
    });
}

class BreadthScenarioHarness {
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

  constructor(private readonly definition: BreadthScenarioDefinition) {
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
    registerBreadthProvider(this.foundation, this.responseQueue, this.metrics);
    registerBreadthCommandTool(this.foundation);
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`Breadth scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`Breadth scenario "${this.definition.name}" has no submitted task id.`);
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
      intent: `${this.definition.description} ${'breadth-context '.repeat(16)}`.trim(),
      preferredProviderId: 'provider-main',
      metadata: {
        breadthScenario: this.definition.name,
        breadthCategory: this.definition.category
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
    const destinationDir = summary.selectedArtifactDir
      ?? summary.recommendedArtifactDir
      ?? `benchmark-artifacts/${this.definition.category}/${this.requireTaskId()}`;
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

  async pause(reason = 'breadth scenario pause'): Promise<TaskQueryResponse> {
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
        grantedBy: 'breadth-auto-approver',
        reason: 'breadth scenario auto-approval'
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

  async finalize(task: TaskQueryResponse): Promise<TaskBreadthScenarioResult> {
    const summary = buildTaskExecutionSummary(task);
    const missingRequiredEventTypes = this.definition.expectation.requiredEventTypes
      .filter((type) => !task.events.some((event) => event.type === type));
    const passed = task.runtime.lifecycleStatus === this.definition.expectation.lifecycleStatus
      && missingRequiredEventTypes.length === 0
      && task.toolInvocations.length >= (this.definition.expectation.minToolInvocations ?? 0)
      && this.counters.approvalCount >= (this.definition.expectation.minApprovalCount ?? 0)
      && this.counters.recoveryCount >= (this.definition.expectation.minRecoveryCount ?? 0)
      && this.counters.continueMessageCount >= (this.definition.expectation.minContinueMessages ?? 0);

    return {
      scenario: this.definition.name,
      category: this.definition.category,
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
        unitDurations: [...summary.unitDurations]
      }
    };
  }
}

async function driveToCompletion(
  harness: BreadthScenarioHarness,
  initialTask: TaskQueryResponse,
  continueMessages: Array<string | undefined> = []
): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  while (guard < 16) {
    task = await harness.getTask();
    if (task.runtime.lifecycleStatus !== 'RUNNING') {
      break;
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
      task = await harness.continue(continueMessages[guard]);
    }
    guard += 1;
  }
  if (guard >= 16) {
    throw new Error(`Breadth scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function createBreadthScenarioDefinitions(): BreadthScenarioDefinition[] {
  return [
    {
      name: 'breadth-bug-fix',
      category: 'bug-fix',
      description: 'Fix a targeted runtime bug and verify the patch artifact.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Bug Analyst', goal: 'Locate the bug and define the fix', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Bug Fixer', goal: 'Apply the fix', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Bug Verifier', goal: 'Verify the fix artifact', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'bug-analysis.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'src/bugfix.ts'),
          createToolCall('AGENT-002', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-002', 'write_file', { path: 'src/bugfix.ts', content: 'export const fixedBug = true;\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [createOutput('AGENT-003', 'bugfix-report.md'), createToolCall('AGENT-003', 'read_file', { path: 'src/bugfix.ts' }), createInProgressTracker('AGENT-003')].join('\n'),
        [createOutput('AGENT-003', 'bugfix-report.md', { report: 'verified src/bugfix.ts from read_file result' }), createTracker('AGENT-003')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TASK_COMPLETED'],
        minToolInvocations: 3
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-refactor',
      category: 'refactor',
      description: 'Refactor a module while preserving behavior and verify the replacement.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Refactor Planner', goal: 'Plan the refactor', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Refactor Implementer', goal: 'Write the refactored module', profile: 'implement', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'refactor-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'src/refactor.ts'),
          createToolCall('AGENT-002', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-002', 'write_file', { path: 'src/refactor.ts', content: 'export function runRefactor() { return "ok"; }\n' }),
          createToolCall('AGENT-002', 'read_file', { path: 'src/refactor.ts' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TURN_STARTED', 'TASK_COMPLETED'],
        minToolInvocations: 3
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-docs-generation',
      category: 'docs-generation',
      description: 'Generate operator-facing documentation from a task brief.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Docs Writer', goal: 'Write generated docs', profile: 'implement', dependencies: [] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'docs/guide.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'docs' }),
          createToolCall('AGENT-001', 'write_file', { path: 'docs/guide.md', content: '# Generated Guide\n\nUse the task runner carefully.\n' }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TASK_COMPLETED'],
        minToolInvocations: 2
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-config-edit',
      category: 'config-edit',
      description: 'Edit a configuration file and confirm the updated content.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Config Editor', goal: 'Update the config file', profile: 'implement', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Config Verifier', goal: 'Read back the config file', profile: 'verify', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'config/runtime.json'),
          createToolCall('AGENT-001', 'create_folder', { path: 'config' }),
          createToolCall('AGENT-001', 'write_file', { path: 'config/runtime.json', content: '{\"mode\":\"safe\",\"retries\":2}\n' }),
          createTracker('AGENT-001')
        ].join('\n'),
        [createOutput('AGENT-002', 'config-verify.md'), createToolCall('AGENT-002', 'read_file', { path: 'config/runtime.json' }), createInProgressTracker('AGENT-002')].join('\n'),
        [createOutput('AGENT-002', 'config-verify.md', { report: 'verified config/runtime.json from read_file result' }), createTracker('AGENT-002')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 3
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-test-repair',
      category: 'test-repair',
      description: 'Repair a failing test file and verify the new test artifact.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Test Fixer', goal: 'Repair the failing test', profile: 'implement', dependencies: [] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'tests/fixed.test.ts'),
          createToolCall('AGENT-001', 'create_folder', { path: 'tests' }),
          createToolCall('AGENT-001', 'write_file', { path: 'tests/fixed.test.ts', content: 'test(\"fixed\", () => expect(true).toBe(true));\n' }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TASK_COMPLETED'],
        minToolInvocations: 2
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-regression-diagnosis',
      category: 'regression-diagnosis',
      description: 'Diagnose a regression by reading logs and searching workspace traces.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Regression Analyst', goal: 'Inspect regression evidence', profile: 'implement', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Regression Verifier', goal: 'Validate diagnosis evidence', profile: 'verify', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'logs/runtime.log'),
          createToolCall('AGENT-001', 'create_folder', { path: 'logs' }),
          createToolCall('AGENT-001', 'write_file', { path: 'logs/runtime.log', content: 'ERROR regression detected\nINFO fallback path entered\n' }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'diagnosis.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'logs/runtime.log' }),
          createToolCall('AGENT-002', 'search_files', { path: '.', pattern: 'regression' }),
          createInProgressTracker('AGENT-002')
        ].join('\n'),
        [createOutput('AGENT-002', 'diagnosis.md', { report: 'verified regression evidence from read_file and search_files results' }), createTracker('AGENT-002')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 4
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-multi-file-implementation',
      category: 'multi-file-implementation',
      description: 'Implement a feature that touches multiple files and validate all outputs.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Feature Implementer', goal: 'Write multiple feature files', profile: 'implement', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Feature Verifier', goal: 'Verify the created feature files', profile: 'verify', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'src/feature.ts'),
          createToolCall('AGENT-001', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-001', 'write_file', { path: 'src/feature.ts', content: 'export const feature = \"ready\";\n' }),
          createToolCall('AGENT-001', 'write_file', { path: 'src/feature.test.ts', content: 'test(\"feature\", () => expect(true).toBe(true));\n' }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'feature-verify.md'),
          createToolCall('AGENT-002', 'list_files', { path: 'src', recursive: true }),
          createToolCall('AGENT-002', 'read_file', { path: 'src/feature.ts' }),
          createToolCall('AGENT-002', 'read_file', { path: 'src/feature.test.ts' }),
          createInProgressTracker('AGENT-002')
        ].join('\n'),
        [createOutput('AGENT-002', 'feature-verify.md', { report: 'verified src/feature.ts and src/feature.test.ts from tool results' }), createTracker('AGENT-002')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 6
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-memory-context-heavy',
      category: 'memory-context-heavy',
      description: 'Run a memory-heavy task with long intent and verify the distilled result remains focused.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Memory Analyst', goal: 'Distill the long context into a compact plan', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Memory Reviewer', goal: 'Review the distilled artifact for relevance and focus', profile: 'analyze', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'memory-plan.md', { report: 'context distilled successfully' }), createTracker('AGENT-001')].join('\n'),
        [createOutput('AGENT-002', 'memory-verify.md', { report: 'distilled result verified' }), createTracker('AGENT-002')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TURN_STARTED', 'TASK_COMPLETED']
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start('Keep the output narrow and do not leak unnecessary context.');
        return driveToCompletion(harness, started, ['Summarize only the most relevant points for the operator.']);
      }
    },
    {
      name: 'breadth-approval-sensitive-tool',
      category: 'approval-sensitive-tool',
      description: 'Block on write approval and then finish after operator approval.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Approval Planner', goal: 'Plan the guarded write', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Approval Implementer', goal: 'Write the guarded file', profile: 'implement', dependencies: ['AGENT-001'] })
      ],
      configOverrides: {
        tools: {
          permissionMode: 'ask'
        }
      },
      responses: [
        [createOutput('AGENT-001', 'approval-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'secure/approval.txt'),
          createToolCall('AGENT-002', 'write_file', { path: 'secure/approval.txt', content: 'approval sensitive content\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [createOutput('AGENT-002', 'secure/approval.txt', { report: 'guarded write completed after approval' }), createTracker('AGENT-002')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_APPROVAL_RESOLVED', 'TASK_COMPLETED'],
        minToolInvocations: 1,
        minApprovalCount: 1
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'breadth-long-running-recovery',
      category: 'long-running-recovery',
      description: 'Pause, resume, restart runtime, and complete a long-running task safely.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Recovery Planner', goal: 'Prepare recovery path', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Recovery Implementer', goal: 'Write recovered state', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Recovery Verifier', goal: 'Read back recovered state', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'recovery-path.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'runtime/recovery.txt'),
          createToolCall('AGENT-002', 'create_folder', { path: 'runtime' }),
          createToolCall('AGENT-002', 'write_file', { path: 'runtime/recovery.txt', content: 'recovered after restart\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [createOutput('AGENT-003', 'recovery-check.md'), createToolCall('AGENT-003', 'read_file', { path: 'runtime/recovery.txt' }), createInProgressTracker('AGENT-003')].join('\n'),
        [createOutput('AGENT-003', 'recovery-check.md', { report: 'verified runtime/recovery.txt from read_file result' }), createTracker('AGENT-003')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_PAUSED', 'TASK_RESUMED', 'TASK_COMPLETED'],
        minToolInvocations: 3,
        minRecoveryCount: 1
      },
      async execute(harness) {
        await harness.submit();
        let task = await harness.start();
        task = await harness.pause('Pause before runtime restart.');
        task = await harness.resume('Resume after planned pause.');
        task = await harness.restartRuntime();
        if (task.runtime.lifecycleStatus === 'PAUSED') {
          task = await harness.resume('Resume after runtime restart.');
        }
        return driveToCompletion(harness, task);
      }
    }
  ];
}

export async function runTaskBreadthScenarioSuite(): Promise<TaskBreadthScenarioSuiteResult> {
  const definitions = createBreadthScenarioDefinitions();
  const scenarios: TaskBreadthScenarioResult[] = [];

  for (const definition of definitions) {
    const harness = new BreadthScenarioHarness(definition);
    try {
      const task = await definition.execute(harness);
      scenarios.push(await harness.finalize(task));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`breadth scenario "${definition.name}" failed: ${reason}`);
    } finally {
      await harness.close();
    }
  }

  let passed = 0;
  let failed = 0;
  let totalApiCalls = 0;
  let totalFallbacks = 0;
  let totalRecoveries = 0;
  let totalApprovalBlocked = 0;
  const byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>> = {};
  const byCategory: Record<string, number> = {};

  for (const scenario of scenarios) {
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
    totalApiCalls += scenario.metrics.apiCallCount;
    totalFallbacks += scenario.metrics.plannerFallbackCount;
    totalRecoveries += scenario.metrics.recoveryCount;
    totalApprovalBlocked += scenario.metrics.approvalBlockedBatchCount;
    byCategory[scenario.category] = (byCategory[scenario.category] ?? 0) + 1;
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
      averagePlannerFallbackRate: Number((totalFallbacks / Math.max(1, scenarios.length)).toFixed(4)),
      averageRecoveryCount: Number((totalRecoveries / Math.max(1, scenarios.length)).toFixed(4)),
      averageApprovalBlockedBatchRate: Number((totalApprovalBlocked / Math.max(1, scenarios.length)).toFixed(4)),
      byIssueCategory,
      byCategory
    }
  };
}
