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
import { RuntimeBenchmarkSuiteResult } from './runtime-benchmark';

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

interface WorkflowScenarioExpectation {
  lifecycleStatus: TaskLifecycleStatus;
  requiredEventTypes: string[];
  minToolInvocations?: number;
  minApprovalCount?: number;
  minRecoveryCount?: number;
  minContinueMessages?: number;
}

interface WorkflowScenarioDefinition {
  name: string;
  description: string;
  units: AgentUnit[];
  responses: string[];
  configOverrides?: {
    tools?: {
      permissionMode?: 'full' | 'ask';
    };
  };
  expectation: WorkflowScenarioExpectation;
  execute(harness: WorkflowScenarioHarness): Promise<TaskQueryResponse>;
}

export interface TaskScenarioMetrics {
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

export interface TaskScenarioResult {
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
  metrics: TaskScenarioMetrics;
}

export interface WorkflowOptimizationRecommendation {
  priority:
    | 'keep-current-path'
    | 'batch-tool-execution'
    | 'context-gating'
    | 'snapshot-recovery';
  rationale: string;
}

export interface TaskWorkflowScenarioSuiteResult {
  generatedAt: number;
  scenarios: TaskScenarioResult[];
  totals: {
    passed: number;
    failed: number;
    byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>>;
  };
  recommendation: WorkflowOptimizationRecommendation;
}

function createTempRoot(prefix = 'backend-new-workflow-'): string {
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
    ...extra
  })}[/${unitId}_OUTPUT]`;
}

function createTracker(unitId: string, nextUnit?: string | null): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'COMPLETE',
    progress_percent: 100,
    decision: 'CONTINUE',
    reason: 'workflow scenario step complete',
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
    exitCondition: '{"status":"COMPLETE","report":"required"}',
    executionProfileId: params.profile,
    dependencies: params.dependencies
  };
}

function deriveWorkflowContinueMessage(task: TaskQueryResponse): string | undefined {
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

function registerWorkflowProvider(
  foundation: BackendNewFoundation,
  responses: string[],
  metrics: MutableMetrics
): void {
  const queue = responses;
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    baseUrl: 'https://provider.example.com',
    model: 'workflow-benchmark-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued for workflow scenario.');
      }
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      const completionTokens = estimateTokens(next);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += promptTokens + completionTokens;
      return {
        responseId: `workflow_resp_${metrics.apiCallCount}`,
        providerId: 'provider-main',
        model: 'workflow-benchmark-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          workflowScenario: true
        }
      };
    }
  });
}

function registerWorkflowCommandTool(foundation: BackendNewFoundation): void {
  if (!foundation.extensions.findTool('run-command') && !foundation.extensions.findTool('run_command')) {
    foundation.extensions.registerTool({
      id: 'run-command',
      name: 'run_command',
      description: 'Run a deterministic workspace command during workflow scenarios.',
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
            message: `Unsupported workflow command "${command}".`
          });
        } catch (error) {
          return createToolFailureResult({
            kind: 'EXECUTION',
            message: error instanceof Error ? error.message : 'Workflow command failed.'
          });
        }
      }
    });
}

class WorkflowScenarioHarness {
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

  constructor(private readonly definition: WorkflowScenarioDefinition) {
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
    registerWorkflowProvider(this.foundation, this.responseQueue, this.metrics);
    registerWorkflowCommandTool(this.foundation);
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`Workflow scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`Workflow scenario "${this.definition.name}" has no submitted task id.`);
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
      intent: `${this.definition.description} ${'workflow-context '.repeat(24)}`.trim(),
      preferredProviderId: 'provider-main',
      metadata: {
        workflowScenario: this.definition.name
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

  async pause(reason = 'workflow scenario pause'): Promise<TaskQueryResponse> {
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
        grantedBy: 'workflow-auto-approver',
        reason: 'workflow scenario auto-approval'
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

  async finalize(task: TaskQueryResponse): Promise<TaskScenarioResult> {
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

async function driveToCompletion(harness: WorkflowScenarioHarness, initialTask: TaskQueryResponse, continueMessages: Array<string | undefined> = []): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  while (guard < 16) {
    task = await harness.getTask();
    if (task.runtime.lifecycleStatus !== 'RUNNING') {
      break;
    }
    const applied = await harness.applyRecommendedArtifacts(task);
    if (applied) {
      task = applied;
      guard += 1;
      continue;
    }
    task = await harness.continue(continueMessages[guard] ?? deriveWorkflowContinueMessage(task));
    guard += 1;
  }
  if (guard >= 16) {
    throw new Error(`Workflow scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function createWorkflowScenarioDefinitions(): WorkflowScenarioDefinition[] {
  return [
    {
      name: 'code-modification-workflow',
      description: 'Multi-stage code change workflow covering analyze, plan, implement, and verify phases.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Analyzer', goal: 'Inspect current requirements', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Planner', goal: 'Produce implementation plan', profile: 'analyze', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Implementer', goal: 'Write target artifact', profile: 'implement', dependencies: ['AGENT-002'] }),
        createUnit({ id: 'AGENT-004', role: 'Verifier', goal: 'Validate workspace output', profile: 'verify', dependencies: ['AGENT-003'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis.md', { report: 'requirements captured' }), createTracker('AGENT-001')].join('\n'),
        [createOutput('AGENT-002', 'plan.md', { report: 'implementation plan ready' }), createTracker('AGENT-002')].join('\n'),
        [
          createOutput('AGENT-003', 'src/refactor.ts', { report: 'implementation artifact written' }),
          createToolCall('AGENT-003', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-003', 'write_file', {
            path: 'src/refactor.ts',
            content: 'export const refactored = true;\n'
          }),
          createTracker('AGENT-003')
        ].join('\n'),
        [
          createOutput('AGENT-004', 'verification.md', { report: 'workspace artifact verified' }),
          createToolCall('AGENT-004', 'list_files', { path: '.', recursive: true }),
          createToolCall('AGENT-004', 'read_file', { path: 'src/refactor.ts' }),
          createToolCall('AGENT-004', 'search_files', { path: '.', pattern: 'refactored' }),
          createInProgressTracker('AGENT-004')
        ].join('\n'),
        [createOutput('AGENT-004', 'verification.md', { report: 'workspace artifact verified from list, read, and search results' }), createTracker('AGENT-004')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TURN_STARTED', 'TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 5
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'mixed-file-command-workflow',
      description: 'Workspace workflow mixing file reads, file writes, and deterministic command execution.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Workspace Analyst', goal: 'Assess command workflow', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Command Implementer', goal: 'Run workspace command pipeline', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Validator', goal: 'Validate command output', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'workspace-plan.md', { report: 'workspace execution path identified' }), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'workspace/output.txt', { report: 'workspace command finished' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'workspace' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'workspace/input.txt',
            content: 'hello workflow\n'
          }),
          createToolCall('AGENT-002', 'run_command', {
            command: 'uppercase-file',
            input: 'workspace/input.txt',
            output: 'workspace/output.txt'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'validation.md', { report: 'workspace output validated' }),
          createToolCall('AGENT-003', 'read_file', { path: 'workspace/output.txt' }),
          createToolCall('AGENT-003', 'run_command', {
            command: 'append-checksum',
            input: 'workspace/output.txt'
          }),
          createInProgressTracker('AGENT-003')
        ].join('\n'),
        [createOutput('AGENT-003', 'validation.md', { report: 'workspace output validated from read_file and command results' }), createTracker('AGENT-003')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
        minToolInvocations: 5
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started);
      }
    },
    {
      name: 'operator-guided-continue',
      description: 'Workflow that injects operator guidance through continue messages before final verification.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Analyst', goal: 'Capture operator constraints', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Implementer', goal: 'Apply operator guidance', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Verifier', goal: 'Confirm guidance was applied', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'operator-brief.md', { report: 'operator constraints captured' }), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'CHANGELOG.md', { report: 'operator guidance applied to changelog' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'CHANGELOG.md',
            content: 'Applied operator guidance for rollout safety.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'operator-verification.md', { report: 'operator guidance verified' }),
          createToolCall('AGENT-003', 'read_file', { path: 'CHANGELOG.md' }),
          createInProgressTracker('AGENT-003')
        ].join('\n'),
        [createOutput('AGENT-003', 'operator-verification.md', { report: 'operator guidance verified from read_file result' }), createTracker('AGENT-003')].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TASK_STARTED', 'COMMAND_ACCEPTED', 'TASK_COMPLETED'],
        minToolInvocations: 2,
        minContinueMessages: 1
      },
      async execute(harness) {
        await harness.submit();
        const started = await harness.start();
        return driveToCompletion(harness, started, [
          'Tighten rollout guidance and write the changelog entry before verification.'
        ]);
      }
    },
    {
      name: 'approval-blocked-workflow',
      description: 'Workflow that blocks on tool approval, resolves approval, and then resumes to completion.',
      configOverrides: {
        tools: {
          permissionMode: 'ask'
        }
      },
      units: [
        createUnit({ id: 'AGENT-001', role: 'Planner', goal: 'Prepare approved workspace change', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Implementer', goal: 'Write approved artifact and finalize the change', profile: 'implement', dependencies: ['AGENT-001'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'approval-plan.md', { report: 'approval gate identified' }), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'secure/approved.txt', { report: 'artifact waiting for approval' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'secure/approved.txt',
            content: 'approved by workflow scenario\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'secure/approved.txt', { report: 'approved artifact finalized' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      expectation: {
        lifecycleStatus: 'COMPLETED',
        requiredEventTypes: ['TOOL_BATCH_EXECUTED', 'TOOL_APPROVAL_RESOLVED', 'TASK_COMPLETED'],
        minToolInvocations: 1,
        minApprovalCount: 1
      },
      async execute(harness) {
        await harness.submit();
        let task = await harness.start();
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
            task = await harness.continue(deriveWorkflowContinueMessage(task));
          }
          guard += 1;
        }
        if (guard >= 16) {
          throw new Error(`Workflow scenario exceeded approval guard for "${task.definition.taskId}".`);
        }
        return task;
      }
    },
    {
      name: 'pause-resume-restart-recovery',
      description: 'Workflow covering manual pause/resume followed by process restart recovery and completion.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Analyzer', goal: 'Prepare recovery context', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Implementer', goal: 'Write recovery artifact', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Verifier', goal: 'Verify recovered artifact', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'recovery-plan.md', { report: 'recovery context prepared' }), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'recovery/state.txt', { report: 'state written after resume' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'recovery' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'recovery/state.txt',
            content: 'runtime recovered\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'recovery-verification.md', { report: 'restart recovery verified' }),
          createToolCall('AGENT-003', 'read_file', { path: 'recovery/state.txt' }),
          createInProgressTracker('AGENT-003')
        ].join('\n'),
        [createOutput('AGENT-003', 'recovery-verification.md', { report: 'restart recovery verified from read_file result' }), createTracker('AGENT-003')].join('\n')
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
        task = await harness.pause('workflow scenario manual pause');
        task = await harness.resume('Resume after manual pause and continue work.');
        task = await harness.restartRuntime();
        if (task.runtime.lifecycleStatus === 'PAUSED') {
          task = await harness.resume('Resume after process restart recovery.');
        }
        return driveToCompletion(harness, task);
      }
    }
  ];
}

export function deriveWorkflowOptimizationRecommendation(params: {
  workflow: TaskWorkflowScenarioSuiteResult;
  benchmark?: RuntimeBenchmarkSuiteResult;
}): WorkflowOptimizationRecommendation {
  if (params.workflow.scenarios.some((scenario) => scenario.issueCategory === 'recovery_inconsistency')) {
    return {
      priority: 'snapshot-recovery',
      rationale: 'Workflow scenarios still show restart recovery inconsistencies, so unit-level recovery should be optimized first.'
    };
  }

  if (
    params.benchmark
    && (
      params.benchmark.realisticComplexDag.plannerPrimary.fallbackCount > 0
      || params.benchmark.validationScenarios.some((scenario) => scenario.plannerFallbackReasons.length > 0)
    )
  ) {
    return {
      priority: 'context-gating',
      rationale: 'Planner fallback is still visible in benchmark output, so context gating is the next highest-value optimization.'
    };
  }

  if (
    params.benchmark
    && (
      params.benchmark.realisticComplexDag.deltas.apiCallReductionRatio < 0.5
      || params.workflow.scenarios.some((scenario) => scenario.metrics.averageToolInvocationsPerBatch < 2)
    )
  ) {
    return {
      priority: 'batch-tool-execution',
      rationale: 'Planner-first batching is not yet compressing tool-heavy work enough across realistic benchmarks and workflow scenarios.'
    };
  }

  return {
    priority: 'keep-current-path',
    rationale: 'Workflow scenarios pass and current benchmark signals do not show a dominant bottleneck yet.'
  };
}

export async function runTaskWorkflowScenarioSuite(
  benchmarkContext?: RuntimeBenchmarkSuiteResult
): Promise<TaskWorkflowScenarioSuiteResult> {
  const definitions = createWorkflowScenarioDefinitions();
  const scenarios: TaskScenarioResult[] = [];

  for (const definition of definitions) {
    const harness = new WorkflowScenarioHarness(definition);
    try {
      const task = await definition.execute(harness);
      scenarios.push(await harness.finalize(task));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`workflow scenario "${definition.name}" failed: ${reason}`);
    } finally {
      await harness.close();
    }
  }

  const byIssueCategory: Partial<Record<TaskExecutionIssueCategory, number>> = {};
  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
    if (scenario.issueCategory) {
      byIssueCategory[scenario.issueCategory] = (byIssueCategory[scenario.issueCategory] ?? 0) + 1;
    }
  }

  const suite: TaskWorkflowScenarioSuiteResult = {
    generatedAt: Date.now(),
    scenarios,
    totals: {
      passed,
      failed,
      byIssueCategory
    },
    recommendation: {
      priority: 'keep-current-path',
      rationale: 'Workflow assessment was not derived yet.'
    }
  };
  suite.recommendation = deriveWorkflowOptimizationRecommendation({
    workflow: suite,
    benchmark: benchmarkContext
  });
  return suite;
}
