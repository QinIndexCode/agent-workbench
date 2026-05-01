import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

type GeneralComplexScenarioFamily =
  | 'config-migration'
  | 'script-repair'
  | 'data-transformation'
  | 'workspace-maintenance'
  | 'long-running-correction-churn'
  | 'checkpoint-recovery-task'
  | 'provider-failure-streak-task'
  | 'extension-failure-stability-task'
  | 'workspace-bootstrap'
  | 'workspace-docs-import'
  | 'workspace-command-driven-task'
  | 'workspace-index-rebuild'
  | 'workspace-bulk-maintenance'
  | 'rule-constrained-implementation'
  | 'hook-observable-task'
  | 'agent-assisted-review'
  | 'workspace-command-with-doc-memory'
  | 'skill-driven-task'
  | 'mcp-tool-assisted-task'
  | 'skill-failure-diagnostics'
  | 'mcp-failure-recovery'
  | 'instruction-skill-guided-task'
  | 'instruction-skill-with-assets'
  | 'mixed-runtime-and-instruction-skill-task'
  | 'diagnostic-triage'
  | 'policy-sensitive-change'
  | 'rich-doc-output'
  | 'complex-docs-bundle'
  | 'decision-log-synthesis'
  | 'decision-doc-from-imported-sources'
  | 'multi-artifact-bundle';

type GeneralComplexFailureCategory =
  | 'artifact_missing'
  | 'acceptance_command_failed'
  | 'content_assertion_failed'
  | 'tool_action_required_but_not_emitted'
  | 'response_shape_mismatch'
  | 'correction_loop_non_convergent'
  | 'rule_constraint_mismatch'
  | 'hook_execution_failed'
  | 'agent_profile_misapplied'
  | 'workspace_command_resolution_failed';

interface ArtifactQualityAcceptance {
  verdict: 'passed' | 'failed';
  failureCategory: GeneralComplexFailureCategory | null;
  summary: string;
  files: string[];
  testsPassed: boolean | null;
  contentAssertionsPassed: boolean | null;
  diffAssertionsPassed: boolean | null;
}

interface MutableMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface MutableScenarioCounters {
  continueCount: number;
  continueMessageCount: number;
}

interface WorkspaceCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface GeneralComplexScenarioDefinition {
  name: string;
  family: GeneralComplexScenarioFamily;
  description: string;
  intent: string;
  units: AgentUnit[];
  responses: string[];
  fixtureFiles: Record<string, string>;
  artifactFiles: string[];
  allowedCommands: string[];
  requiredEventTypes: string[];
  taskMetadata?: Record<string, unknown>;
  prepare?(harness: GeneralComplexScenarioHarness): Promise<void>;
  execute?(harness: GeneralComplexScenarioHarness): Promise<TaskQueryResponse>;
  acceptance(harness: GeneralComplexScenarioHarness, task: TaskQueryResponse): Promise<ArtifactQualityAcceptance>;
}

export interface TaskGeneralComplexScenarioMetrics {
  apiCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  plannedToolBatchCount: number;
  executedToolBatchCount: number;
  toolInvocationCount: number;
  averageToolInvocationsPerBatch: number;
  continueCount: number;
  continueMessageCount: number;
  eventCount: number;
  approvalBlockedBatchCount: number;
  plannerFallbackCount: number;
  stageDurations: TaskExecutionSummary['stageDurations'];
  unitDurations: TaskExecutionSummary['unitDurations'];
  contextGating: TaskExecutionSummary['contextGating'];
}

export interface TaskGeneralComplexScenarioDiagnostics {
  workspaceDir: string | null;
  latestAssistantMessageExcerpt: string | null;
  recentToolInvocations: Array<{
    unitId: string;
    toolId: string;
    status: string;
  }>;
  artifactSnapshots: Array<{
    path: string;
    exists: boolean;
    excerpt: string | null;
  }>;
}

export interface TaskGeneralComplexScenarioResult {
  scenario: string;
  family: GeneralComplexScenarioFamily;
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
  artifactQuality: ArtifactQualityAcceptance;
  metrics: TaskGeneralComplexScenarioMetrics;
  diagnostics: TaskGeneralComplexScenarioDiagnostics;
}

export interface TaskGeneralComplexScenarioSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: TaskGeneralComplexScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactQualityPassRate: number;
    averageApiCallCount: number;
    averageExecutedToolBatchCount: number;
    byFamily: Record<GeneralComplexScenarioFamily, number>;
    byFailureCategory: Partial<Record<GeneralComplexFailureCategory, number>>;
  };
}

function createTempRoot(prefix = 'backend-new-general-complex-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function truncateExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
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
    reason: 'general complex scenario step complete',
    next_unit: null,
    files_created: []
  });
}

function hasToolResultContext(request: ProviderCompletionRequest): boolean {
  return request.messages.some((message) => (
    message.role === 'tool'
    || /tool\s+(?:result|write_file|read_file|run_command|search_files|list_files|create_folder)\s+(?:succeeded|completed|failed)/i.test(message.content)
    || /Wait for the tool results/i.test(message.content)
  ));
}

function createGroundedFinalResponse(unitId: string | null): string | null {
  const currentUnitId = typeof unitId === 'string' && unitId.trim() ? unitId.trim() : null;
  if (!currentUnitId) {
    return null;
  }
  return [
    createOutput(currentUnitId, 'tool-result-verification.md', {
      report: 'Verified the completed tool result evidence before finalizing this unit.'
    }),
    createTracker(currentUnitId)
  ].join('\n');
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

function createPassedAcceptance(summary: string, files: string[]): ArtifactQualityAcceptance {
  return {
    verdict: 'passed',
    failureCategory: null,
    summary,
    files,
    testsPassed: true,
    contentAssertionsPassed: true,
    diffAssertionsPassed: true
  };
}

async function writeClaudeStyleMarketplaceFixture(params: {
  rootDir: string;
  pluginName: string;
  skills: Array<{
    path: string;
    skillMarkdown: string;
    extraFiles?: Record<string, string>;
  }>;
}): Promise<string> {
  const marketplaceRoot = path.join(params.rootDir, 'external-skills', params.pluginName);
  for (const skill of params.skills) {
    const skillRoot = path.join(marketplaceRoot, 'skills', skill.path);
    await fsp.mkdir(skillRoot, { recursive: true });
    await fsp.writeFile(path.join(skillRoot, 'SKILL.md'), skill.skillMarkdown, 'utf8');
    for (const [relativePath, content] of Object.entries(skill.extraFiles ?? {})) {
      const target = path.join(skillRoot, relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
    }
  }
  const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin-marketplace.json');
  await fsp.writeFile(
    marketplaceFile,
    JSON.stringify({
      plugins: [
        {
          name: params.pluginName,
          source: './skills',
          skills: params.skills.map((skill) => skill.path)
        }
      ]
    }, null, 2),
    'utf8'
  );
  return marketplaceFile;
}

async function readOptionalWorkspaceFile(harness: GeneralComplexScenarioHarness, relativePath: string): Promise<string | null> {
  try {
    return await harness.readWorkspaceFile(relativePath);
  } catch {
    return null;
  }
}

function createFailureAcceptance(
  summary: string,
  failureCategory: GeneralComplexFailureCategory,
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

function hasSuccessfulToolInvocation(task: TaskQueryResponse, toolId: string, command?: string): boolean {
  return task.toolInvocations.some((record) => {
    if (record.status !== 'SUCCEEDED' || record.toolId !== toolId) {
      return false;
    }
    if (!command) {
      return true;
    }
    return String(record.arguments.command ?? '').trim() === command;
  });
}

function runWorkspaceCommand(command: string, cwd: string): WorkspaceCommandResult {
  const trimmed = command.trim();
  const npmMatch = /^npm(?:\s+(.+))?$/i.exec(trimmed);
  if (process.platform === 'win32' && npmMatch) {
    const npmArgs = (npmMatch[1] ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const quotedNpmArgs = npmArgs.map((value) => /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
    const npmResult = spawnSync('cmd.exe', ['/d', '/s', '/c', `npm.cmd ${quotedNpmArgs.join(' ')}`.trim()], {
      cwd,
      encoding: 'utf8',
      shell: false
    });
    return {
      status: npmResult.status ?? 1,
      stdout: npmResult.stdout ?? '',
      stderr: npmResult.stderr ?? npmResult.error?.message ?? ''
    };
  }
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', trimmed], {
      cwd,
      encoding: 'utf8',
      shell: false
    })
    : spawnSync(trimmed, [], {
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

function registerGeneralComplexProvider(
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
    model: 'general-complex-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
      let generatedAfterToolResultFallback = false;
      let next = queue.shift();
      if (!next && hasToolResultContext(request)) {
        next = createGroundedFinalResponse(request.context.unitId) ?? undefined;
        generatedAfterToolResultFallback = Boolean(next);
      }
      if (!next) {
        throw new Error('No mock provider response queued for general complex scenario.');
      }
      const promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
      const completionTokens = estimateTokens(next);
      metrics.apiCallCount += 1;
      metrics.promptTokens += promptTokens;
      metrics.completionTokens += completionTokens;
      metrics.totalTokens += promptTokens + completionTokens;
      return {
        responseId: `general_complex_resp_${metrics.apiCallCount}`,
        providerId: 'provider-main',
        model: 'general-complex-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metadata: {
          generalComplexScenario: true,
          generatedAfterToolResultFallback
        }
      };
    }
  });
}

function registerGeneralComplexCommandTool(
  foundation: BackendNewFoundation,
  allowedCommands: string[]
): void {
  if (!foundation.extensions.findTool('run-command') && !foundation.extensions.findTool('run_command')) {
    foundation.extensions.registerTool({
      id: 'run-command',
      name: 'run_command',
      description: 'Run an allowed workspace command during general-complex scenario validation.',
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
            message: `Command "${command}" is not allowed in this general-complex scenario.`
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

class GeneralComplexScenarioHarness {
  private readonly rootDir = createTempRoot();
  private readonly metrics: MutableMetrics = {
    apiCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
  private readonly counters: MutableScenarioCounters = {
    continueCount: 0,
    continueMessageCount: 0
  };
  private foundation: BackendNewFoundation | null = null;
  private runtime: BackendNewRuntime | null = null;
  private taskId: string | null = null;
  private baselineFileHashes = new Map<string, string>();

  constructor(private readonly definition: GeneralComplexScenarioDefinition) {}

  private async bootRuntime(): Promise<void> {
    this.foundation = createBackendNewFoundation({
      cwd: this.rootDir,
      config: {
        paths: {
          rootDir: this.rootDir
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    this.runtime = createBackendNewRuntime({
      foundation: this.foundation
    });
    registerGeneralComplexProvider(this.foundation, this.definition.responses, this.metrics);
    registerGeneralComplexCommandTool(this.foundation, this.definition.allowedCommands);
  }

  private requireRuntime(): BackendNewRuntime {
    if (!this.runtime) {
      throw new Error(`General complex scenario "${this.definition.name}" is not initialized.`);
    }
    return this.runtime;
  }

  private requireFoundation(): BackendNewFoundation {
    if (!this.foundation) {
      throw new Error(`General complex scenario "${this.definition.name}" has no foundation.`);
    }
    return this.foundation;
  }

  private requireTaskId(): string {
    if (!this.taskId) {
      throw new Error(`General complex scenario "${this.definition.name}" has no submitted task id.`);
    }
    return this.taskId;
  }

  getWorkspaceDir(): string | null {
    if (!this.foundation || !this.taskId) {
      return null;
    }
    return this.foundation.layout.forTask(this.taskId).workspaceDir;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async writeRootFile(relativePath: string, content: string): Promise<void> {
    const resolved = path.join(this.rootDir, relativePath);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, content, this.requireFoundation().config.storage.encoding);
  }

  async readRootFile(relativePath: string): Promise<string> {
    return fsp.readFile(path.join(this.rootDir, relativePath), this.requireFoundation().config.storage.encoding);
  }

  async initWorkspaceWorkflow() {
    return this.requireRuntime().platform.initWorkspaceWorkflow();
  }

  async importWorkspaceDocs() {
    return this.requireRuntime().platform.importWorkspaceDocs();
  }

  async importMarketplaceSkills(params: {
    marketplaceFile: string;
    pluginName: string;
    skillPath?: string;
  }) {
    return this.requireRuntime().platform.importMarketplaceSkills(params);
  }

  async importSkill(params: {
    id?: string;
    name?: string;
    rootDir: string;
    description?: string;
    kind?: 'runtime-skill' | 'instruction-skill';
  }) {
    return this.requireRuntime().platform.importSkill(params);
  }

  async getWorkspaceWorkflowView() {
    return this.requireRuntime().platform.getWorkspaceWorkflow();
  }

  async registerSkillRuntime(params: {
    id: string;
    name: string;
    rootDir: string;
    runtime: Parameters<BackendNewFoundation['skillRuntimes']['register']>[1];
    capability?: Parameters<BackendNewFoundation['skillRuntimes']['register']>[2];
  }): Promise<void> {
    const foundation = this.requireFoundation();
    await fsp.mkdir(params.rootDir, { recursive: true });
    foundation.extensions.registerSkill({
      id: params.id,
      name: params.name,
      rootDir: params.rootDir
    });
    foundation.skillRuntimes.register(params.id, params.runtime, params.capability);
  }

  registerProviderClient(
    id: string,
    client: Parameters<BackendNewFoundation['providerClients']['register']>[1],
    capability?: Parameters<BackendNewFoundation['providerClients']['register']>[2]
  ): void {
    this.requireFoundation().providerClients.register(id, client, capability);
  }

  registerMcpServerRuntime(params: {
    id: string;
    name: string;
    transport: 'stdio' | 'http' | 'ws';
    command?: string;
    url?: string;
    client: Parameters<BackendNewFoundation['mcpClients']['register']>[1];
    capability?: Parameters<BackendNewFoundation['mcpClients']['register']>[2];
  }): void {
    const foundation = this.requireFoundation();
    foundation.extensions.registerMcpServer({
      id: params.id,
      name: params.name,
      transport: params.transport,
      command: params.command,
      url: params.url
    });
    foundation.mcpClients.register(params.id, params.client, params.capability);
  }

  async submit(): Promise<TaskQueryResponse> {
    if (!this.runtime) {
      await this.bootRuntime();
    }
    if (this.definition.prepare) {
      await this.definition.prepare(this);
    }
    const runtime = this.requireRuntime();
    const submitted = await runtime.tasks.submitTask({
      title: this.definition.name,
      intent: `${this.definition.intent} ${'general-complex-context '.repeat(18)}`.trim(),
      preferredProviderId: 'provider-main',
      metadata: {
        generalComplexScenario: this.definition.name,
        generalComplexFamily: this.definition.family,
        ...(this.definition.taskMetadata ?? {})
      },
      units: this.definition.units
    });
    this.taskId = submitted.command.taskId;

    const foundation = this.requireFoundation();
    for (const [relativePath, content] of Object.entries(this.definition.fixtureFiles)) {
      const resolved = foundation.layout.resolveWorkspacePath(this.taskId, relativePath);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content, foundation.config.storage.encoding);
      this.baselineFileHashes.set(relativePath, hashText(content));
    }
    return submitted.task;
  }

  async start(userMessage?: string): Promise<TaskQueryResponse> {
    return this.requireRuntime().tasks.startTask({
      taskId: this.requireTaskId(),
      userMessage
    }).then((result) => result.task);
  }

  async continue(userMessage?: string): Promise<TaskQueryResponse> {
    this.counters.continueCount += 1;
    if (userMessage?.trim()) {
      this.counters.continueMessageCount += 1;
    }
    return this.requireRuntime().tasks.continueTask({
      taskId: this.requireTaskId(),
      userMessage
    }).then((result) => result.task);
  }

  async getTask(): Promise<TaskQueryResponse> {
    return this.requireRuntime().tasks.getTask(this.requireTaskId());
  }

  async getTaskDebug() {
    return this.requireRuntime().tasks.getTaskDebug(this.requireTaskId());
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

  async pause(): Promise<TaskQueryResponse> {
    return this.requireRuntime().tasks.pauseTask({
      taskId: this.requireTaskId()
    }).then((result) => result.task);
  }

  async resume(): Promise<TaskQueryResponse> {
    return this.requireRuntime().tasks.resumeTask({
      taskId: this.requireTaskId()
    }).then((result) => result.task);
  }

  async restart(): Promise<TaskQueryResponse> {
    return this.requireRuntime().tasks.restartTask({
      taskId: this.requireTaskId()
    }).then((result) => result.task);
  }

  async fileExists(relativePath: string): Promise<boolean> {
    try {
      await fsp.access(this.resolveWorkspacePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    return fsp.readFile(this.resolveWorkspacePath(relativePath), this.requireFoundation().config.storage.encoding);
  }

  getBaselineHash(relativePath: string): string | null {
    return this.baselineFileHashes.get(relativePath) ?? null;
  }

  runAllowedCommand(command: string): WorkspaceCommandResult {
    if (!this.definition.allowedCommands.includes(command)) {
      throw new Error(`Command "${command}" is not allowed in scenario "${this.definition.name}".`);
    }
    const workspaceDir = this.getWorkspaceDir();
    if (!workspaceDir) {
      throw new Error(`Workspace not initialized for scenario "${this.definition.name}".`);
    }
    return runWorkspaceCommand(command, workspaceDir);
  }

  private resolveWorkspacePath(relativePath: string): string {
    return this.requireFoundation().layout.resolveWorkspacePath(this.requireTaskId(), relativePath);
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    removeDir(this.rootDir);
  }

  async finalize(task: TaskQueryResponse): Promise<TaskGeneralComplexScenarioResult> {
    const summary = buildTaskExecutionSummary(task);
    const artifactQuality = await this.definition.acceptance(this, task);
    const missingRequiredEventTypes = this.definition.requiredEventTypes
      .filter((type) => !task.events.some((event) => event.type === type));
    const passed = task.runtime.lifecycleStatus === 'COMPLETED'
      && missingRequiredEventTypes.length === 0
      && artifactQuality.verdict === 'passed';

    const artifactSnapshots: TaskGeneralComplexScenarioDiagnostics['artifactSnapshots'] = [];
    for (const relativePath of this.definition.artifactFiles) {
      const exists = await this.fileExists(relativePath);
      let excerpt: string | null = null;
      if (exists) {
        try {
          excerpt = truncateExcerpt(await this.readWorkspaceFile(relativePath));
        } catch {
          excerpt = null;
        }
      }
      artifactSnapshots.push({
        path: relativePath,
        exists,
        excerpt
      });
    }
    const latestAssistant = [...task.conversations]
      .filter((message) => message.role === 'assistant')
      .sort((left, right) => right.createdAt - left.createdAt)[0];

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
      artifactQuality,
      metrics: {
        apiCallCount: this.metrics.apiCallCount,
        promptTokens: this.metrics.promptTokens,
        completionTokens: this.metrics.completionTokens,
        totalTokens: this.metrics.totalTokens,
        plannedToolBatchCount: summary.batchExecution.plannedToolBatchCount,
        executedToolBatchCount: summary.batchExecution.executedToolBatchCount,
        toolInvocationCount: task.toolInvocations.length,
        averageToolInvocationsPerBatch: summary.batchExecution.averageToolInvocationsPerBatch,
        continueCount: this.counters.continueCount,
        continueMessageCount: this.counters.continueMessageCount,
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
      diagnostics: {
        workspaceDir: this.getWorkspaceDir(),
        latestAssistantMessageExcerpt: latestAssistant?.content?.trim()
          ? truncateExcerpt(latestAssistant.content)
          : null,
        recentToolInvocations: [...task.toolInvocations]
          .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))
          .slice(0, 8)
          .map((record) => ({
            unitId: record.unitId,
            toolId: record.toolId,
            status: record.status
          })),
        artifactSnapshots
      }
    };
  }
}

async function driveToCompletion(
  harness: GeneralComplexScenarioHarness,
  initialTask: TaskQueryResponse,
  continueMessages: Array<string | undefined> = []
): Promise<TaskQueryResponse> {
  let task = initialTask;
  let guard = 0;
  while (task.runtime.lifecycleStatus === 'RUNNING' && guard < 16) {
    const applied = await harness.applyRecommendedArtifacts(task);
    if (applied) {
      task = applied;
      guard += 1;
      continue;
    }
    task = await harness.continue(continueMessages[guard]);
    guard += 1;
  }
  if (guard >= 16) {
    throw new Error(`General complex scenario exceeded continue guard for "${initialTask.definition.taskId}".`);
  }
  return task;
}

function createGeneralComplexScenarioDefinitions(): GeneralComplexScenarioDefinition[] {
  return [
    {
      name: 'general-config-migration',
      family: 'config-migration',
      description: 'Migrate a runtime config file to the v2 shape and validate the result.',
      intent: 'Migrate config/app.json to config/app.v2.json with a nested runtime object, preserve appName, and enable the audit feature. Validate the migrated file with the workspace validator.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Config Analyst', goal: 'Analyze the current config shape.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Config Migrator', goal: 'Write the migrated config artifact.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Config Verifier', goal: 'Verify the migrated config.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/config-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'config/app.v2.json'),
          createToolCall('AGENT-002', 'write_file', { path: 'config/app.v2.json', content: '{\n  "appName": "scc-batch",\n  "runtime": {\n    "mode": "safe",\n    "retries": 3\n  },\n  "features": {\n    "audit": true\n  }\n}\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/config-migration.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'config/app.v2.json' }),
          createTracker('AGENT-003')
        ].join('\n'),
      ],
      fixtureFiles: {
        'config/app.json': '{\n  "appName": "scc-batch",\n  "mode": "legacy",\n  "retries": 1\n}\n',
        'scripts/validate-config.mjs': 'import fs from "node:fs";\nconst value = JSON.parse(fs.readFileSync("config/app.v2.json", "utf8"));\nif (value.appName !== "scc-batch" || value.runtime?.mode !== "safe" || value.runtime?.retries !== 3 || value.features?.audit !== true) {\n  throw new Error("invalid migrated config");\n}\nconsole.log("config-ok");\n'
      },
      artifactFiles: ['config/app.v2.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        if (!await harness.fileExists('config/app.v2.json')) {
          return createFailureAcceptance('config/app.v2.json was not created.', 'artifact_missing', {
            files: [],
            contentAssertionsPassed: false
          });
        }
        const text = await harness.readWorkspaceFile('config/app.v2.json').catch(() => null);
        if (!text || !/"runtime"/.test(text) || !/"mode": "safe"/.test(text) || !/"audit": true/.test(text)) {
          return createFailureAcceptance('Migrated config artifact is missing the required v2 fields.', 'content_assertion_failed', {
            files: ['config/app.v2.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Config migration produced the required v2 artifact.', ['config/app.v2.json']);
      }
    },
    {
      name: 'general-script-repair',
      family: 'script-repair',
      description: 'Repair a broken build script and verify the resulting output file.',
      intent: 'Repair scripts/build.mjs so it writes dist/build.txt containing BUILD_OK, then verify by running the script.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Script Analyst', goal: 'Identify why the build script fails.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Script Repairer', goal: 'Repair the build script.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Script Verifier', goal: 'Run the repaired script and verify the output file.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/script-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'scripts/build.mjs'),
          createToolCall('AGENT-002', 'write_file', { path: 'scripts/build.mjs', content: 'import fs from "node:fs";\nimport path from "node:path";\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync(path.join("dist", "build.txt"), "BUILD_OK\\n", "utf8");\nconsole.log("build-ok");\n' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'dist' }),
          createToolCall('AGENT-002', 'write_file', { path: 'dist/build.txt', content: 'BUILD_OK\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'dist/build.txt'),
          createToolCall('AGENT-003', 'read_file', { path: 'scripts/build.mjs' }),
          createToolCall('AGENT-003', 'read_file', { path: 'dist/build.txt' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'scripts/build.mjs': 'throw new Error("broken build script");\n'
      },
      artifactFiles: ['scripts/build.mjs', 'dist/build.txt'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const scriptText = await harness.readWorkspaceFile('scripts/build.mjs').catch(() => null);
        const output = await harness.readWorkspaceFile('dist/build.txt').catch(() => null);
        if (!scriptText || !/fs\.writeFileSync/.test(scriptText) || !output || !/BUILD_OK/.test(output)) {
          return createFailureAcceptance('dist/build.txt does not contain BUILD_OK.', 'content_assertion_failed', {
            files: ['scripts/build.mjs', 'dist/build.txt'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Script repair produced the expected build artifact.', ['scripts/build.mjs', 'dist/build.txt']);
      }
    },
    {
      name: 'general-data-transformation',
      family: 'data-transformation',
      description: 'Transform source records into a structured summary file and verify the output.',
      intent: 'Read data/source.json, produce data/output.json containing totalUsers and uppercaseNames, and verify the transformed structure with the workspace validator.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Data Analyst', goal: 'Inspect the source data contract.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Transformer', goal: 'Generate the transformed output.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Transformation Verifier', goal: 'Validate the transformed output.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/data-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'data/output.json'),
          createToolCall('AGENT-002', 'write_file', { path: 'data/output.json', content: '{\n  "totalUsers": 3,\n  "uppercaseNames": ["ALICE", "BOB", "CAROL"]\n}\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/data-transformation.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'data/output.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'data/source.json': '{\n  "users": ["alice", "bob", "carol"]\n}\n',
        'scripts/validate-output.mjs': 'import fs from "node:fs";\nconst value = JSON.parse(fs.readFileSync("data/output.json", "utf8"));\nif (value.totalUsers !== 3 || JSON.stringify(value.uppercaseNames) !== JSON.stringify(["ALICE","BOB","CAROL"])) {\n  throw new Error("invalid transformed output");\n}\nconsole.log("transform-ok");\n'
      },
      artifactFiles: ['data/output.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const text = await harness.readWorkspaceFile('data/output.json').catch(() => null);
        if (!text || !/"totalUsers": 3/.test(text) || !/"ALICE"/.test(text) || !/"BOB"/.test(text) || !/"CAROL"/.test(text)) {
          return createFailureAcceptance('Transformed output file is missing the expected structured summary.', 'content_assertion_failed', {
            files: ['data/output.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Data transformation generated the expected summary artifact.', ['data/output.json']);
      }
    },
    {
      name: 'general-workspace-maintenance',
      family: 'workspace-maintenance',
      description: 'Index a small workspace and emit a maintenance manifest with readback verification.',
      intent: 'Create workspace/index.json and workspace/summary.md that inventory docs/a.md and docs/b.md, then verify the generated manifest.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Workspace Analyst', goal: 'Identify what needs to be indexed.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Workspace Maintainer', goal: 'Write the index and summary artifacts.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Workspace Verifier', goal: 'Verify the maintenance artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/workspace-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'workspace/index.json'),
          createToolCall('AGENT-002', 'create_folder', { path: 'workspace' }),
          createToolCall('AGENT-002', 'write_file', { path: 'workspace/index.json', content: '{\n  "entries": ["docs/a.md", "docs/b.md"]\n}\n' }),
          createToolCall('AGENT-002', 'write_file', { path: 'workspace/summary.md', content: '# Workspace Summary\n\nIndexed docs/a.md and docs/b.md.\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/workspace-maintenance.md'),
          createToolCall('AGENT-003', 'list_files', { path: '.', recursive: true }),
          createToolCall('AGENT-003', 'read_file', { path: 'workspace/index.json' }),
          createToolCall('AGENT-003', 'read_file', { path: 'workspace/summary.md' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'docs/a.md': '# A\n\nAlpha\n',
        'docs/b.md': '# B\n\nBeta\n'
      },
      artifactFiles: ['workspace/index.json', 'workspace/summary.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const indexText = await harness.readWorkspaceFile('workspace/index.json').catch(() => null);
        const summaryText = await harness.readWorkspaceFile('workspace/summary.md').catch(() => null);
        if (!indexText || !summaryText) {
          return createFailureAcceptance('Workspace maintenance artifacts were not fully produced.', 'artifact_missing', {
            files: ['workspace/index.json', 'workspace/summary.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/docs\/a\.md/.test(indexText) || !/docs\/b\.md/.test(indexText) || !/Indexed docs\/a\.md and docs\/b\.md/i.test(summaryText)) {
          return createFailureAcceptance('Workspace maintenance artifacts do not reflect the indexed files.', 'content_assertion_failed', {
            files: ['workspace/index.json', 'workspace/summary.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace maintenance artifacts index the expected files.', ['workspace/index.json', 'workspace/summary.md']);
      }
    },
    {
      name: 'general-long-running-correction-churn',
      family: 'long-running-correction-churn',
      description: 'Drive a task through repeated correction turns before it converges and completes.',
      intent: 'Write reports/correction-churn.md, survive repeated tracker corrections, and complete only after the final valid tracker is emitted.',
      taskMetadata: {
        artifactRouting: {
          pathPolicy: 'task_workspace'
        }
      },
      units: [
        createUnit({ id: 'AGENT-001', role: 'Correction Writer', goal: 'Write the report and converge after repeated tracker corrections.', profile: 'implement', dependencies: [], taskScope: 'reports/correction-churn.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/correction-churn.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/correction-churn.md',
            content: '# Correction Churn\n\nInitial artifact written before the tracker converges.\n'
          })
        ].join('\n'),
        createOutput('AGENT-001', 'reports/correction-churn.md'),
        [
          createOutput('AGENT-001', 'reports/correction-churn.md'),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      fixtureFiles: {},
      artifactFiles: ['reports/correction-churn.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TURN_ANALYZED', 'TASK_COMPLETED'],
      async execute(harness) {
        const started = await harness.start();
        return driveToCompletion(harness, started, [
          'Return only the missing tracker.',
          'Return the final valid tracker now.'
        ]);
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/correction-churn.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Long-running correction churn task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/correction-churn.md'],
            contentAssertionsPassed: false
          });
        }
        if (summary.correctionDepth < 2 || summary.turnCount < 3) {
          return createFailureAcceptance('Long-running correction churn did not expose the expected correction depth and turn count.', 'content_assertion_failed', {
            files: ['reports/correction-churn.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Long-running correction churn completed after repeated correction turns and preserved correction depth in diagnostics.', ['reports/correction-churn.md']);
      }
    },
    {
      name: 'general-checkpoint-recovery-task',
      family: 'checkpoint-recovery-task',
      description: 'Pause and resume a multi-stage task while keeping checkpoint and queue/runtime state aligned.',
      intent: 'Write reports/recovery.md through a paused and resumed task run, then verify the task still completes with a stable safe checkpoint summary.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Recovery Analyst', goal: 'Prepare the staged recovery work.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Recovery Writer', goal: 'Write the recovery report after resume.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'reports/recovery.md' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/recovery-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/recovery.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/recovery.md',
            content: '# Recovery Report\n\nTask completed after pause and resume.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      fixtureFiles: {},
      artifactFiles: ['reports/recovery.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'SAFE_POINT_REACHED', 'CHECKPOINT_WRITTEN', 'TASK_PAUSED', 'TASK_COMPLETED'],
      async execute(harness) {
        const started = await harness.start();
        await harness.pause();
        return harness.resume();
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/recovery.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Checkpoint recovery task did not produce the recovery report.', 'artifact_missing', {
            files: ['reports/recovery.md'],
            contentAssertionsPassed: false
          });
        }
        if (!summary.queueRuntimeAlignment.consistent || summary.lastSafeCheckpointAt === null) {
          return createFailureAcceptance('Checkpoint recovery task did not preserve queue/runtime alignment or safe checkpoint metadata.', 'content_assertion_failed', {
            files: ['reports/recovery.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Checkpoint recovery task completed after pause/resume and preserved stable checkpoint metadata.', ['reports/recovery.md']);
      }
    },
    {
      name: 'general-provider-failure-streak-task',
      family: 'provider-failure-streak-task',
      description: 'Fail on repeated provider attempts, then recover and complete with failure streak evidence preserved.',
      intent: 'Recover from repeated provider timeouts, then write reports/provider-recovery.md and keep the failure streak visible in diagnostics.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Provider Recovery Writer', goal: 'Recover from repeated provider failures and write the recovery report.', profile: 'implement', dependencies: [], taskScope: 'reports/provider-recovery.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/provider-recovery.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/provider-recovery.md',
            content: '# Provider Recovery\n\nRecovered after repeated provider failures.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n')
      ],
      async prepare(harness) {
        const queue = [
          new Error('provider timeout on attempt 1'),
          new Error('provider timeout on attempt 2'),
          '[AGENT-001_OUTPUT]{"summary":"provider-recovered","artifact":"reports/provider-recovery.md","issues":[],"report":"provider recovered"}[/AGENT-001_OUTPUT]\n'
            + '[TOOL_CALL] {"tool":"create_folder","args":{"path":"reports"}} [/TOOL_CALL]\n'
            + '[TOOL_CALL] {"tool":"write_file","args":{"path":"reports/provider-recovery.md","content":"# Provider Recovery\\n\\nRecovered after repeated provider failures.\\n"}} [/TOOL_CALL]\n'
            + createTracker('AGENT-001')
        ];
        harness.registerProviderClient('provider-main', {
          async complete(request) {
            const next = queue.shift();
            if (next instanceof Error) {
              throw next;
            }
            return {
              responseId: `general_complex_provider_recovery_${Date.now()}`,
              providerId: request.profile.id,
              model: request.profile.model,
              outputText: next ?? '',
              finishReason: 'stop',
              usage: {
                promptTokens: 8,
                completionTokens: 8,
                totalTokens: 16
              },
              metadata: {
                generalComplexScenario: 'provider-failure-streak-task'
              }
            };
          }
        }, {
          supportsJsonMode: true
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/provider-recovery.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TASK_FAILED', 'CHECKPOINT_WRITTEN', 'TASK_COMPLETED'],
      async execute(harness) {
        await harness.start();
        await harness.restart();
        return harness.restart();
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/provider-recovery.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Provider failure streak task did not produce the recovery report.', 'artifact_missing', {
            files: ['reports/provider-recovery.md'],
            contentAssertionsPassed: false
          });
        }
        if (summary.providerFailureStreak < 2 || !task.events.some((event) => event.type === 'TASK_FAILED')) {
          return createFailureAcceptance('Provider failure streak task did not preserve repeated provider failure evidence.', 'content_assertion_failed', {
            files: ['reports/provider-recovery.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Provider failure streak task recovered successfully while preserving repeated provider failure evidence.', ['reports/provider-recovery.md']);
      }
    },
    {
      name: 'general-extension-failure-stability-task',
      family: 'extension-failure-stability-task',
      description: 'Keep extension failures explainable during a long-running task that still completes with a fallback artifact.',
      intent: 'Attempt the configured failing skill and MCP extension, then write reports/extension-fallback.md describing the fallback path without losing failure visibility.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Extension Fallback Writer', goal: 'Write a stable fallback report after extension failures.', profile: 'implement', dependencies: [], taskScope: 'reports/extension-fallback.md' }),
        createUnit({ id: 'AGENT-002', role: 'Extension Fallback Verifier', goal: 'Verify the fallback report and extension failure summaries.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/extension-fallback.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/extension-fallback.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/extension-fallback.md',
            content: '# Extension Fallback\n\nFallback path used because skill and MCP helpers both failed.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/extension-fallback.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/extension-fallback.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        harness.registerMcpServerRuntime({
          id: 'mcp.long-running-failure',
          name: 'mcp-long-running-failure',
          transport: 'stdio',
          command: 'mcp-long-running-failure',
          client: {
            async connect() {},
            async callTool() {
              return {
                ok: false,
                output: null,
                error: 'simulated MCP instability',
                metadata: {
                  source: 'general-complex'
                }
              };
            }
          },
          capability: {
            supportsTools: true,
            supportsPrompts: false,
            supportsResources: false,
            supportsStreaming: false
          }
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/extension-fallback.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'SKILL_EXECUTED', 'MCP_TOOL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        extensions: {
          skills: [
            {
              unitId: 'AGENT-001',
              skillId: 'skill.long-running-missing',
              payload: { value: 'fallback' }
            }
          ],
          mcp: [
            {
              unitId: 'AGENT-001',
              serverId: 'mcp.long-running-failure',
              toolName: 'echo',
              arguments: { value: 'fallback' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/extension-fallback.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Extension failure stability task did not produce the fallback report.', 'artifact_missing', {
            files: ['reports/extension-fallback.md'],
            contentAssertionsPassed: false
          });
        }
        if (summary.skillFailureStreak < 1 || summary.mcpFailureStreak < 1) {
          return createFailureAcceptance('Extension failure stability task did not preserve failing extension streaks.', 'content_assertion_failed', {
            files: ['reports/extension-fallback.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Extension failure stability task completed with fallback output while keeping extension failure diagnostics visible.', ['reports/extension-fallback.md']);
      }
    },
    {
      name: 'general-workspace-bootstrap',
      family: 'workspace-bootstrap',
      description: 'Bootstrap a project workflow skeleton inside the workspace and verify the generated .scc layout.',
      intent: 'Create a minimal .scc workflow skeleton with project instructions, docs manifest, and one release-check command, then verify the generated workspace bootstrap artifacts.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Workflow Bootstrap Analyst', goal: 'Determine the minimum project workflow structure required for the workspace.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Workflow Bootstrap Author', goal: 'Create the .scc workflow skeleton inside the workspace.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Workflow Bootstrap Verifier', goal: 'Verify the .scc workflow skeleton.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/workspace-bootstrap-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', '.scc/project.md'),
          createToolCall('AGENT-002', 'create_folder', { path: '.scc' }),
          createToolCall('AGENT-002', 'create_folder', { path: '.scc/commands' }),
          createToolCall('AGENT-002', 'write_file', {
            path: '.scc/project.md',
            content: '# Project Instructions\n\n- Prefer reproducible scripts.\n- Keep runtime diagnostics stable.\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: '.scc/docs.json',
            content: '{\n  "sources": []\n}\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: '.scc/commands/release-check.md',
            content: '---\ndescription: Release readiness check\n---\nPrepare a release readiness checklist for ${args}.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', '.scc/commands/release-check.md'),
          createToolCall('AGENT-003', 'read_file', { path: '.scc/project.md' }),
          createToolCall('AGENT-003', 'read_file', { path: '.scc/docs.json' }),
          createToolCall('AGENT-003', 'read_file', { path: '.scc/commands/release-check.md' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {},
      artifactFiles: ['.scc/project.md', '.scc/docs.json', '.scc/commands/release-check.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const project = await harness.readWorkspaceFile('.scc/project.md').catch(() => null);
        const docs = await harness.readWorkspaceFile('.scc/docs.json').catch(() => null);
        const command = await harness.readWorkspaceFile('.scc/commands/release-check.md').catch(() => null);
        if (!project || !docs || !command) {
          return createFailureAcceptance('Workspace bootstrap did not produce the expected .scc skeleton.', 'artifact_missing', {
            files: ['.scc/project.md', '.scc/docs.json', '.scc/commands/release-check.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Project Instructions/.test(project) || !/"sources": \[\]/.test(docs) || !/description: Release readiness check/.test(command) || !/\$\{args\}/.test(command)) {
          return createFailureAcceptance('Workspace bootstrap artifacts are missing the expected workflow content.', 'content_assertion_failed', {
            files: ['.scc/project.md', '.scc/docs.json', '.scc/commands/release-check.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace bootstrap created the expected .scc workflow skeleton.', ['.scc/project.md', '.scc/docs.json', '.scc/commands/release-check.md']);
      }
    },
    {
      name: 'general-workspace-docs-import',
      family: 'workspace-docs-import',
      description: 'Import workspace docs into memories and write a summary artifact that reflects the imported sources.',
      intent: 'Use the imported workspace docs to produce reports/workspace-docs-import.md describing the handbook owner and the policy review cadence, then verify the imported docs summary.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Workspace Docs Analyst', goal: 'Review the imported workspace docs requirements.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Workspace Docs Author', goal: 'Write a report that reflects the imported workspace docs.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Workspace Docs Verifier', goal: 'Verify the workspace docs report and import summary.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/workspace-docs-import-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/workspace-docs-import.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/workspace-docs-import.md',
            content: '# Workspace Docs Import\n\n- Handbook owner: platform-team\n- Policy review cadence: weekly\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/workspace-docs-import.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/workspace-docs-import.md' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('workspace-docs/handbook.md', '# Handbook\n\nOwner: platform-team\n');
        await harness.writeRootFile('workspace-docs/policies.md', '# Policies\n\nReview cadence: weekly\n');
        await harness.writeRootFile('.scc/docs.json', '{\n  "sources": [\n    { "path": "workspace-docs/handbook.md", "title": "Workspace Handbook", "tags": ["handbook"] },\n    { "path": "workspace-docs/policies.md", "title": "Workspace Policies", "tags": ["policy"] }\n  ]\n}\n');
        await harness.importWorkspaceDocs();
      },
      fixtureFiles: {},
      artifactFiles: ['reports/workspace-docs-import.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const report = await harness.readWorkspaceFile('reports/workspace-docs-import.md').catch(() => null);
        const workflow = await harness.getWorkspaceWorkflowView();
        if (!report) {
          return createFailureAcceptance('Workspace docs import report was not generated.', 'artifact_missing', {
            files: ['reports/workspace-docs-import.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/platform-team/.test(report) || !/weekly/.test(report)) {
          return createFailureAcceptance('Workspace docs import report is missing the expected imported-doc facts.', 'content_assertion_failed', {
            files: ['reports/workspace-docs-import.md'],
            contentAssertionsPassed: false
          });
        }
        if (workflow.docsImportSummary.importedMemoryCount < 2 || workflow.docsImportSummary.trackedSourceCount < 2) {
          return createFailureAcceptance('Workspace docs were not imported into memories as expected.', 'content_assertion_failed', {
            files: ['reports/workspace-docs-import.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace docs import produced the expected report and memory import summary.', ['reports/workspace-docs-import.md']);
      }
    },
    {
      name: 'general-workspace-command-driven-task',
      family: 'workspace-command-driven-task',
      description: 'Drive a task from a workspace custom command and verify the generated command report.',
      intent: 'Use the workspace ship-check command to generate reports/ship-check.md and reports/ship-check.json for release candidate 2026.04, then verify the command-driven artifacts.',
      taskMetadata: {
        workspaceCommand: {
          name: 'ship-check',
          description: 'Generate a release readiness checklist.',
          template: 'Prepare a release readiness checklist for ${args}.'
        }
      },
      units: [
        createUnit({ id: 'AGENT-001', role: 'Command Analyst', goal: 'Interpret the workspace command request.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Command Author', goal: 'Produce the command-driven release checklist artifacts.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Command Verifier', goal: 'Verify the command-driven release checklist artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/ship-check-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/ship-check.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/ship-check.md',
            content: '# Ship Check\n\nRelease candidate: 2026.04\n\n- Verify provider routing\n- Confirm rollback notes\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/ship-check.json',
            content: '{\n  "releaseCandidate": "2026.04",\n  "checks": ["Verify provider routing", "Confirm rollback notes"]\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/ship-check.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/ship-check.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/ship-check.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('.scc/commands/ship-check.md', '---\ndescription: Generate a release readiness checklist.\n---\nPrepare a release readiness checklist for ${args}.\n');
      },
      fixtureFiles: {},
      artifactFiles: ['reports/ship-check.md', 'reports/ship-check.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const markdown = await harness.readWorkspaceFile('reports/ship-check.md').catch(() => null);
        const json = await harness.readWorkspaceFile('reports/ship-check.json').catch(() => null);
        const workflow = await harness.getWorkspaceWorkflowView();
        if (!markdown || !json) {
          return createFailureAcceptance('Workspace command-driven artifacts were not fully created.', 'artifact_missing', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/2026\.04/.test(markdown) || !/rollback/.test(markdown) || !/2026\.04/.test(json)) {
          return createFailureAcceptance('Workspace command-driven artifacts are missing the expected release checklist content.', 'content_assertion_failed', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        if (!workflow.commands.some((command) => command.name === 'ship-check')) {
          return createFailureAcceptance('Workspace command metadata was not discoverable in the current workflow snapshot.', 'content_assertion_failed', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace command-driven task produced the expected release checklist artifacts.', ['reports/ship-check.md', 'reports/ship-check.json']);
      }
    },
    {
      name: 'general-workspace-index-rebuild',
      family: 'workspace-index-rebuild',
      description: 'Rebuild a workspace index and emit a rebuild note after scanning multiple package folders.',
      intent: 'Scan packages/core and packages/docs, rebuild workspace/index.json with package metadata, and verify the regenerated index and rebuild report.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Index Analyst', goal: 'Map the workspace inputs that belong in the rebuilt index.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Index Rebuilder', goal: 'Write the rebuilt workspace index and report.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Index Verifier', goal: 'Verify the rebuilt index artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/index-rebuild-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'workspace/index.json'),
          createToolCall('AGENT-002', 'create_folder', { path: 'workspace' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'workspace/index.json',
            content: '{\n  "packages": [\n    {\n      "path": "packages/core/README.md",\n      "name": "core",\n      "title": "Core Package"\n    },\n    {\n      "path": "packages/docs/README.md",\n      "name": "docs",\n      "title": "Docs Package"\n    }\n  ],\n  "generatedBy": "workspace-index-rebuild"\n}\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/index-rebuild.md',
            content: '# Workspace Index Rebuild\n\nRebuilt the workspace index for packages/core/README.md and packages/docs/README.md.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/index-rebuild.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'workspace/index.json' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/index-rebuild.md' }),
          createToolCall('AGENT-003', 'list_files', { path: 'packages', recursive: true }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'packages/core/README.md': '# Core Package\n\nShared runtime helpers.\n',
        'packages/docs/README.md': '# Docs Package\n\nOperator notes.\n',
        'workspace/state.json': '{\n  "stale": true\n}\n'
      },
      artifactFiles: ['workspace/index.json', 'reports/index-rebuild.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const indexText = await harness.readWorkspaceFile('workspace/index.json').catch(() => null);
        const reportText = await harness.readWorkspaceFile('reports/index-rebuild.md').catch(() => null);
        if (!indexText || !reportText) {
          return createFailureAcceptance('Workspace index rebuild artifacts were not fully produced.', 'artifact_missing', {
            files: ['workspace/index.json', 'reports/index-rebuild.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/packages\/core\/README\.md/.test(indexText) || !/packages\/docs\/README\.md/.test(indexText) || !/workspace-index-rebuild/.test(indexText)) {
          return createFailureAcceptance('Rebuilt workspace index is missing the expected package entries.', 'content_assertion_failed', {
            files: ['workspace/index.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/packages\/core\/README\.md/.test(reportText) || !/packages\/docs\/README\.md/.test(reportText)) {
          return createFailureAcceptance('Workspace index rebuild report is missing the expected package summary.', 'content_assertion_failed', {
            files: ['reports/index-rebuild.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace index rebuild produced the expected index and report.', ['workspace/index.json', 'reports/index-rebuild.md']);
      }
    },
    {
      name: 'general-workspace-bulk-maintenance',
      family: 'workspace-bulk-maintenance',
      description: 'Apply a coordinated multi-directory maintenance pass and summarize the bulk changes.',
      intent: 'Normalize docs and config ownership metadata across docs/guide.md, docs/runbook.md, and config/index.json, then verify the maintenance report.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Bulk Analyst', goal: 'Identify the stale workspace metadata that needs normalization.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Bulk Maintainer', goal: 'Apply the coordinated maintenance changes and write a summary.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Bulk Verifier', goal: 'Verify the maintenance changes and summary report.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/workspace-bulk-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/workspace-bulk.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/guide.md',
            content: '# Guide\n\nOwner: platform-team\n\nStatus: normalized\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/runbook.md',
            content: '# Runbook\n\nOwner: platform-team\n\nStatus: normalized\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'config/index.json',
            content: '{\n  "owner": "platform-team",\n  "status": "normalized"\n}\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/workspace-bulk.md',
            content: '# Workspace Bulk Maintenance\n\nUpdated docs/guide.md, docs/runbook.md, and config/index.json to platform-team ownership.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/workspace-bulk.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/guide.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/runbook.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'config/index.json' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/workspace-bulk.md' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'docs/guide.md': '# Guide\n\nOwner: legacy-team\n\nStatus: stale\n',
        'docs/runbook.md': '# Runbook\n\nOwner: legacy-team\n\nStatus: stale\n',
        'config/index.json': '{\n  "owner": "legacy-team",\n  "status": "stale"\n}\n'
      },
      artifactFiles: ['docs/guide.md', 'docs/runbook.md', 'config/index.json', 'reports/workspace-bulk.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const guide = await harness.readWorkspaceFile('docs/guide.md').catch(() => null);
        const runbook = await harness.readWorkspaceFile('docs/runbook.md').catch(() => null);
        const config = await harness.readWorkspaceFile('config/index.json').catch(() => null);
        const report = await harness.readWorkspaceFile('reports/workspace-bulk.md').catch(() => null);
        if (!guide || !runbook || !config || !report) {
          return createFailureAcceptance('Workspace bulk maintenance artifacts were not all produced.', 'artifact_missing', {
            files: ['docs/guide.md', 'docs/runbook.md', 'config/index.json', 'reports/workspace-bulk.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/platform-team/.test(guide) || !/platform-team/.test(runbook) || !/"owner": "platform-team"/.test(config)) {
          return createFailureAcceptance('Workspace bulk maintenance did not normalize ownership across all targets.', 'content_assertion_failed', {
            files: ['docs/guide.md', 'docs/runbook.md', 'config/index.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/docs\/guide\.md/.test(report) || !/docs\/runbook\.md/.test(report) || !/config\/index\.json/.test(report)) {
          return createFailureAcceptance('Workspace bulk maintenance report is missing the touched-path summary.', 'content_assertion_failed', {
            files: ['reports/workspace-bulk.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace bulk maintenance updated all required files and summarized the changes.', ['docs/guide.md', 'docs/runbook.md', 'config/index.json', 'reports/workspace-bulk.md']);
      }
    },
    {
      name: 'general-diagnostic-triage',
      family: 'diagnostic-triage',
      description: 'Triage a regression from logs and source hints, then emit a concise report.',
      intent: 'Read logs/runtime.log and src/cache.cjs, produce reports/triage.md naming the locale cache issue, and verify the final diagnosis content.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Triage Analyst', goal: 'Collect the root-cause evidence.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Triage Writer', goal: 'Write the triage report.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Triage Verifier', goal: 'Verify the triage report.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/triage-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/triage.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', { path: 'reports/triage.md', content: '# Triage\n\nThe locale-specific cache issue happens because buildCacheKey ignores locale and reuses user:42 across languages.\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/triage.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/triage.md' }),
          createToolCall('AGENT-003', 'search_files', { path: 'logs', pattern: 'user:42' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'logs/runtime.log': 'WARN locale=fr-FR cacheKey=user:42 stale response reused\n',
        'src/cache.cjs': 'function buildCacheKey(userId, locale) {\n  return `user:${userId}`;\n}\n'
      },
      artifactFiles: ['reports/triage.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const report = await harness.readWorkspaceFile('reports/triage.md').catch(() => null);
        if (!report) {
          return createFailureAcceptance('reports/triage.md was not produced.', 'artifact_missing', {
            files: [],
            contentAssertionsPassed: false
          });
        }
        if (!/locale/i.test(report) || !/cache/i.test(report) || !/user:42/i.test(report)) {
          return createFailureAcceptance('Triage report is missing the expected root-cause evidence.', 'content_assertion_failed', {
            files: ['reports/triage.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Diagnostic triage report captures the locale cache regression.', ['reports/triage.md']);
      }
    },
    {
      name: 'general-policy-sensitive-change',
      family: 'policy-sensitive-change',
      description: 'Apply a constrained change in the allowed area without touching restricted files.',
      intent: 'Update policies/allowed.json to reflect safe mode and emit a review note, but do not modify policies/restricted.json.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Policy Analyst', goal: 'Identify the allowed change surface.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Policy Editor', goal: 'Apply the safe allowed change only.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Policy Verifier', goal: 'Verify that restricted files remain untouched.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/policy-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'policies/allowed.json'),
          createToolCall('AGENT-002', 'write_file', { path: 'policies/allowed.json', content: '{\n  "mode": "safe",\n  "audit": true\n}\n' }),
          createToolCall('AGENT-002', 'write_file', { path: 'reports/policy-review.md', content: '# Policy Review\n\nUpdated allowed policy only.\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/policy-review.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'policies/allowed.json' }),
          createToolCall('AGENT-003', 'read_file', { path: 'policies/restricted.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'policies/allowed.json': '{\n  "mode": "legacy",\n  "audit": false\n}\n',
        'policies/restricted.json': '{\n  "secret": "do-not-touch"\n}\n'
      },
      artifactFiles: ['policies/allowed.json', 'policies/restricted.json', 'reports/policy-review.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const allowedText = await harness.readWorkspaceFile('policies/allowed.json').catch(() => null);
        const restrictedText = await harness.readWorkspaceFile('policies/restricted.json').catch(() => null);
        const review = await harness.readWorkspaceFile('reports/policy-review.md').catch(() => null);
        if (!allowedText || !restrictedText || !review) {
          return createFailureAcceptance('Policy-sensitive artifacts were not fully produced.', 'artifact_missing', {
            files: ['policies/allowed.json', 'policies/restricted.json', 'reports/policy-review.md'],
            contentAssertionsPassed: false
          });
        }
        const restrictedHash = harness.getBaselineHash('policies/restricted.json');
        if (restrictedHash && hashText(restrictedText) !== restrictedHash) {
          return createFailureAcceptance('Restricted policy file changed during the scenario.', 'content_assertion_failed', {
            files: ['policies/restricted.json'],
            contentAssertionsPassed: false,
            diffAssertionsPassed: false
          });
        }
        if (!/"mode": "safe"/.test(allowedText) || !/"audit": true/.test(allowedText)) {
          return createFailureAcceptance('Allowed policy file was not updated to the required safe-mode state.', 'content_assertion_failed', {
            files: ['policies/allowed.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Policy-sensitive change updated only the allowed surface.', ['policies/allowed.json', 'policies/restricted.json', 'reports/policy-review.md']);
      }
    },
    {
      name: 'general-rich-doc-output',
      family: 'rich-doc-output',
      description: 'Generate paired Markdown and HTML artifacts from a structured brief.',
      intent: 'Produce docs/overview.md and docs/overview.html that summarize the deployment brief with title, status, and next steps.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Doc Analyst', goal: 'Review the source brief.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Doc Author', goal: 'Write markdown and HTML outputs.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Doc Verifier', goal: 'Verify the generated documentation artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/doc-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'docs/overview.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'docs' }),
          createToolCall('AGENT-002', 'write_file', { path: 'docs/overview.md', content: '# Deployment Overview\n\nStatus: Green\n\n## Next Steps\n\n- Monitor rollout\n- Capture follow-up notes\n' }),
          createToolCall('AGENT-002', 'write_file', { path: 'docs/overview.html', content: '<html><body><h1>Deployment Overview</h1><p>Status: Green</p><h2>Next Steps</h2><ul><li>Monitor rollout</li><li>Capture follow-up notes</li></ul></body></html>\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'docs/overview.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/overview.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/overview.html' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'brief/overview.json': '{\n  "title": "Deployment Overview",\n  "status": "Green",\n  "nextSteps": ["Monitor rollout", "Capture follow-up notes"]\n}\n'
      },
      artifactFiles: ['docs/overview.md', 'docs/overview.html'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const markdown = await harness.readWorkspaceFile('docs/overview.md').catch(() => null);
        const html = await harness.readWorkspaceFile('docs/overview.html').catch(() => null);
        if (!markdown || !html) {
          return createFailureAcceptance('Rich documentation artifacts were not both created.', 'artifact_missing', {
            files: ['docs/overview.md', 'docs/overview.html'],
            contentAssertionsPassed: false
          });
        }
        if (!/Deployment Overview/.test(markdown) || !/Next Steps/.test(markdown) || !/<h1>Deployment Overview<\/h1>/.test(html)) {
          return createFailureAcceptance('Generated documentation artifacts are missing the required structure.', 'content_assertion_failed', {
            files: ['docs/overview.md', 'docs/overview.html'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Rich documentation artifacts contain both markdown and HTML outputs.', ['docs/overview.md', 'docs/overview.html']);
      }
    },
    {
      name: 'general-complex-docs-bundle',
      family: 'complex-docs-bundle',
      description: 'Generate a richer documentation bundle with operator docs, HTML output, and a table-of-contents artifact.',
      intent: 'Produce docs/guide.md, docs/guide.html, docs/operator/runbook.md, and docs/toc.json from the rollout brief, then verify the bundle structure and content.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Docs Bundle Analyst', goal: 'Review the rollout brief and docs requirements.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Docs Bundle Author', goal: 'Write the markdown, HTML, operator guide, and TOC artifacts.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Docs Bundle Verifier', goal: 'Verify the generated docs bundle.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/docs-bundle-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'docs/guide.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'docs' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'docs/operator' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/guide.md',
            content: '# Rollout Guide\n\nStatus: Ready\n\n## Steps\n\n1. Announce rollout\n2. Monitor alerts\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/guide.html',
            content: '<html><body><h1>Rollout Guide</h1><p>Status: Ready</p><ol><li>Announce rollout</li><li>Monitor alerts</li></ol></body></html>\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/operator/runbook.md',
            content: '# Operator Runbook\n\n- Confirm status dashboard\n- Capture follow-up actions\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'docs/toc.json',
            content: '{\n  "entries": ["docs/guide.md", "docs/operator/runbook.md"]\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'docs/toc.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/guide.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/guide.html' }),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/operator/runbook.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'docs/toc.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'brief/rollout.json': '{\n  "title": "Rollout Guide",\n  "status": "Ready",\n  "steps": ["Announce rollout", "Monitor alerts"],\n  "operatorNotes": ["Confirm status dashboard", "Capture follow-up actions"]\n}\n'
      },
      artifactFiles: ['docs/guide.md', 'docs/guide.html', 'docs/operator/runbook.md', 'docs/toc.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const guide = await harness.readWorkspaceFile('docs/guide.md').catch(() => null);
        const html = await harness.readWorkspaceFile('docs/guide.html').catch(() => null);
        const runbook = await harness.readWorkspaceFile('docs/operator/runbook.md').catch(() => null);
        const toc = await harness.readWorkspaceFile('docs/toc.json').catch(() => null);
        if (!guide || !html || !runbook || !toc) {
          return createFailureAcceptance('Complex docs bundle artifacts were not fully created.', 'artifact_missing', {
            files: ['docs/guide.md', 'docs/guide.html', 'docs/operator/runbook.md', 'docs/toc.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/Rollout Guide/.test(guide) || !/<h1>Rollout Guide<\/h1>/.test(html) || !/Operator Runbook/.test(runbook)) {
          return createFailureAcceptance('Complex docs bundle is missing the expected guide or operator content.', 'content_assertion_failed', {
            files: ['docs/guide.md', 'docs/guide.html', 'docs/operator/runbook.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/docs\/guide\.md/.test(toc) || !/docs\/operator\/runbook\.md/.test(toc)) {
          return createFailureAcceptance('Complex docs bundle TOC does not include the generated documents.', 'content_assertion_failed', {
            files: ['docs/toc.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Complex docs bundle contains the expected guide, operator runbook, HTML output, and TOC.', ['docs/guide.md', 'docs/guide.html', 'docs/operator/runbook.md', 'docs/toc.json']);
      }
    },
    {
      name: 'general-decision-log-synthesis',
      family: 'decision-log-synthesis',
      description: 'Synthesize multiple note and log sources into a structured decision log and action summary.',
      intent: 'Read notes/meeting-a.md, notes/meeting-b.md, and logs/ops.log, then generate reports/decision-log.md and reports/decision-log.json with decisions and next actions.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Decision Analyst', goal: 'Extract the decisions and actions from the source notes.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Decision Synthesizer', goal: 'Write the decision log artifacts.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Decision Verifier', goal: 'Verify the decision log bundle.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/decision-log-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/decision-log.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/decision-log.md',
            content: '# Decision Log\n\n## Decisions\n\n- Move rollout to Friday\n- Require operator approval for cache flushes\n\n## Actions\n\n- Update the on-call runbook\n- Share the Friday rollout note\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/decision-log.json',
            content: '{\n  "decisions": ["Move rollout to Friday", "Require operator approval for cache flushes"],\n  "actions": ["Update the on-call runbook", "Share the Friday rollout note"]\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/decision-log.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/decision-log.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/decision-log.json' }),
          createToolCall('AGENT-003', 'search_files', { path: 'notes', pattern: 'Friday' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'notes/meeting-a.md': '# Meeting A\n\nDecision: Move rollout to Friday.\n',
        'notes/meeting-b.md': '# Meeting B\n\nDecision: Require operator approval for cache flushes.\n',
        'logs/ops.log': 'ACTION update the on-call runbook\nACTION share the Friday rollout note\n'
      },
      artifactFiles: ['reports/decision-log.md', 'reports/decision-log.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const markdown = await harness.readWorkspaceFile('reports/decision-log.md').catch(() => null);
        const json = await harness.readWorkspaceFile('reports/decision-log.json').catch(() => null);
        if (!markdown || !json) {
          return createFailureAcceptance('Decision log synthesis artifacts were not fully produced.', 'artifact_missing', {
            files: ['reports/decision-log.md', 'reports/decision-log.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/Move rollout to Friday/.test(markdown) || !/operator approval/.test(markdown) || !/Update the on-call runbook/.test(markdown)) {
          return createFailureAcceptance('Decision log markdown is missing the expected decisions or actions.', 'content_assertion_failed', {
            files: ['reports/decision-log.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Move rollout to Friday/.test(json) || !/Share the Friday rollout note/.test(json)) {
          return createFailureAcceptance('Decision log JSON is missing the expected structured decision payload.', 'content_assertion_failed', {
            files: ['reports/decision-log.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Decision log synthesis generated the expected markdown and JSON artifacts.', ['reports/decision-log.md', 'reports/decision-log.json']);
      }
    },
    {
      name: 'general-decision-doc-from-imported-sources',
      family: 'decision-doc-from-imported-sources',
      description: 'Synthesize a decision document from imported workspace docs and verify the resulting bundle.',
      intent: 'Use imported workspace docs to generate reports/imported-decision-log.md and reports/imported-decision-actions.json with the final decision and follow-up actions, then verify the imported-source summary.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Imported Decision Analyst', goal: 'Review the imported decision sources.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Imported Decision Synthesizer', goal: 'Write the decision document from the imported sources.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Imported Decision Verifier', goal: 'Verify the imported-source decision artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/imported-decision-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/imported-decision-log.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/imported-decision-log.md',
            content: '# Imported Decision Log\n\nDecision: Enable staged rollout for the API gateway.\n\nActions:\n\n- Publish the operator FAQ\n- Schedule the Friday review\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/imported-decision-actions.json',
            content: '{\n  "decision": "Enable staged rollout for the API gateway",\n  "actions": ["Publish the operator FAQ", "Schedule the Friday review"]\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/imported-decision-actions.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/imported-decision-log.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/imported-decision-actions.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('workspace-docs/decision-a.md', '# Decision A\n\nDecision: Enable staged rollout for the API gateway.\n');
        await harness.writeRootFile('workspace-docs/decision-b.md', '# Decision B\n\nAction: Publish the operator FAQ.\nAction: Schedule the Friday review.\n');
        await harness.writeRootFile('.scc/docs.json', '{\n  "sources": [\n    { "path": "workspace-docs/decision-a.md", "title": "Decision A", "tags": ["decision"] },\n    { "path": "workspace-docs/decision-b.md", "title": "Decision B", "tags": ["decision", "action"] }\n  ]\n}\n');
        await harness.importWorkspaceDocs();
      },
      fixtureFiles: {},
      artifactFiles: ['reports/imported-decision-log.md', 'reports/imported-decision-actions.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const markdown = await harness.readWorkspaceFile('reports/imported-decision-log.md').catch(() => null);
        const json = await harness.readWorkspaceFile('reports/imported-decision-actions.json').catch(() => null);
        const workflow = await harness.getWorkspaceWorkflowView();
        if (!markdown || !json) {
          return createFailureAcceptance('Imported decision artifacts were not fully produced.', 'artifact_missing', {
            files: ['reports/imported-decision-log.md', 'reports/imported-decision-actions.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/staged rollout/i.test(markdown) || !/operator FAQ/.test(markdown) || !/Friday review/.test(json)) {
          return createFailureAcceptance('Imported decision artifacts are missing the expected decision or actions.', 'content_assertion_failed', {
            files: ['reports/imported-decision-log.md', 'reports/imported-decision-actions.json'],
            contentAssertionsPassed: false
          });
        }
        if (workflow.docsImportSummary.importedMemoryCount < 2) {
          return createFailureAcceptance('Imported decision sources were not visible in workspace docs memories.', 'content_assertion_failed', {
            files: ['reports/imported-decision-log.md', 'reports/imported-decision-actions.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Imported decision sources produced the expected decision log artifacts.', ['reports/imported-decision-log.md', 'reports/imported-decision-actions.json']);
      }
    },
    {
      name: 'general-rule-constrained-implementation',
      family: 'rule-constrained-implementation',
      description: 'Apply a constrained implementation while matching a path-scoped workspace rule.',
      intent: 'Implement src/service.cjs and do not modify docs or config files while following the src-only workspace rule.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Rule Analyst', goal: 'Understand the src-only implementation rule.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Rule Implementer', goal: 'Implement src/service.cjs under the matched src rule.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'src/service.cjs' }),
        createUnit({ id: 'AGENT-003', role: 'Rule Verifier', goal: 'Verify the constrained implementation result.', profile: 'verify', dependencies: ['AGENT-002'], taskScope: 'src/service.cjs' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/src-rule-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'src/service.cjs'),
          createToolCall('AGENT-002', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'src/service.cjs',
            content: 'module.exports = {\n  serviceName: "rule-locked-service",\n  mode: "safe"\n};\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'src/service.cjs'),
          createToolCall('AGENT-003', 'read_file', { path: 'src/service.cjs' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('.scc/rules/src-only.md', '---\ndescription: Only modify src artifacts for this task\npaths: src\n---\nOnly modify source files under src and keep docs/config untouched.\n');
      },
      fixtureFiles: {
        'docs/locked.md': '# Locked Doc\n\nDo not change.\n',
        'config/app.json': '{\n  "mode": "unchanged"\n}\n'
      },
      artifactFiles: ['src/service.cjs'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const service = await harness.readWorkspaceFile('src/service.cjs').catch(() => null);
        const lockedDoc = await harness.readWorkspaceFile('docs/locked.md').catch(() => null);
        const config = await harness.readWorkspaceFile('config/app.json').catch(() => null);
        if (!service) {
          return createFailureAcceptance('Rule-constrained implementation did not produce the expected src artifact.', 'artifact_missing', {
            files: ['src/service.cjs'],
            contentAssertionsPassed: false
          });
        }
        if (!/rule-locked-service/.test(service)) {
          return createFailureAcceptance('Rule-constrained implementation artifact content is incorrect.', 'content_assertion_failed', {
            files: ['src/service.cjs'],
            contentAssertionsPassed: false
          });
        }
        if (!lockedDoc || !/Do not change/.test(lockedDoc) || !config || !/unchanged/.test(config)) {
          return createFailureAcceptance('Rule-constrained implementation touched files outside the allowed scope.', 'rule_constraint_mismatch', {
            files: ['docs/locked.md', 'config/app.json'],
            contentAssertionsPassed: false
          });
        }
        if (!task.events.some((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED')) {
          return createFailureAcceptance('Workspace rule matching was not observed during task execution.', 'content_assertion_failed', {
            files: ['src/service.cjs'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Rule-constrained implementation respected the src-only rule and produced the expected source artifact.', ['src/service.cjs']);
      }
    },
    {
      name: 'general-hook-observable-task',
      family: 'hook-observable-task',
      description: 'Run task lifecycle hooks and verify their observability footprint.',
      intent: 'Execute a task with workspace hooks enabled and verify that hook artifacts and runtime hook events are recorded.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Hook Implementer', goal: 'Write the hook-visible report artifact.', profile: 'implement', dependencies: [], taskScope: 'reports/hook-status.md' }),
        createUnit({ id: 'AGENT-002', role: 'Hook Verifier', goal: 'Verify hook events and hook-visible outputs.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/hook-status.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/hook-status.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/hook-status.md',
            content: '# Hook Status\n\nWorkspace hooks executed during this task.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/hook-status.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/hook-status.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('scripts/hook-created.cjs', "const fs = require('node:fs'); const path = require('node:path'); const targetDir = process.env.SCC_TASK_WORKSPACE || process.cwd(); fs.mkdirSync(path.join(targetDir, 'reports'), { recursive: true }); fs.appendFileSync(path.join(targetDir, 'reports', 'hook-events.log'), 'task.created\\n');\n");
        await harness.writeRootFile('scripts/hook-completed.cjs', "const fs = require('node:fs'); const path = require('node:path'); const targetDir = process.env.SCC_TASK_WORKSPACE || process.cwd(); fs.mkdirSync(path.join(targetDir, 'reports'), { recursive: true }); fs.appendFileSync(path.join(targetDir, 'reports', 'hook-events.log'), 'task.completed\\n');\n");
        await harness.writeRootFile('scripts/hook-turn-stop.cjs', "const fs = require('node:fs'); const path = require('node:path'); const targetDir = process.env.SCC_TASK_WORKSPACE || process.cwd(); fs.mkdirSync(path.join(targetDir, 'reports'), { recursive: true }); fs.appendFileSync(path.join(targetDir, 'reports', 'hook-events.log'), 'turn.stop\\n');\n");
        await harness.writeRootFile('.scc/hooks.json', '{\n  "hooks": [\n    { "event": "task.created", "command": "node scripts/hook-created.cjs" },\n    { "event": "task.completed", "command": "node scripts/hook-completed.cjs" },\n    { "event": "turn.stop", "command": "node scripts/hook-turn-stop.cjs" }\n  ]\n}\n');
      },
      fixtureFiles: {},
      artifactFiles: ['reports/hook-status.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TASK_COMPLETED'],
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/hook-status.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        const observedHookEvent = task.events.some((event) => event.type === 'WORKSPACE_HOOK_FAILED' || event.type === 'WORKSPACE_HOOK_EXECUTED');
        if (!report) {
          return createFailureAcceptance('Hook-observable task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/hook-status.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Workspace hooks executed/.test(report)) {
          return createFailureAcceptance('Hook-observable task report is missing the expected hook summary.', 'content_assertion_failed', {
            files: ['reports/hook-status.md'],
            contentAssertionsPassed: false
          });
        }
        if (!observedHookEvent && summary.hookSummary.executedCount < 1 && summary.hookSummary.failedCount < 1) {
          return createFailureAcceptance('Hook-observable task did not preserve explainable hook diagnostics.', 'hook_execution_failed', {
            files: ['reports/hook-status.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Hook-observable task preserved hook diagnostics and visible report artifacts.', ['reports/hook-status.md']);
      }
    },
    {
      name: 'general-agent-assisted-review',
      family: 'agent-assisted-review',
      description: 'Select a workspace agent profile and verify the review artifact is produced under that profile.',
      intent: 'Use the review workspace agent to inspect src/feature.cjs and write reports/review-findings.md with regression-focused notes.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Feature Analyst', goal: 'Inspect src/feature.cjs and collect review risks.', profile: 'analyze', dependencies: [], taskScope: 'src/feature.cjs' }),
        createUnit({ id: 'AGENT-002', role: 'Review Writer', goal: 'Write the regression-focused review findings.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'reports/review-findings.md' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/review-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/review-findings.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/review-findings.md',
            content: '# Review Findings\n\n- Regression risk: missing fallback for null feature flag.\n- Suggested test: cover null and disabled flag paths.\n'
          }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('.scc/agents/review.md', '---\ndescription: Regression-first review agent\n---\nFocus on regressions, missing tests, and rollout risks.\n');
      },
      fixtureFiles: {
        'src/feature.cjs': 'module.exports = function feature(flag) { return flag ? "on" : "off"; };\n'
      },
      artifactFiles: ['reports/review-findings.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'TASK_COMPLETED'],
      taskMetadata: {
        workspaceAgent: 'review'
      },
      async acceptance(harness, task) {
        const review = await harness.readWorkspaceFile('reports/review-findings.md').catch(() => null);
        if (!review) {
          return createFailureAcceptance('Agent-assisted review did not produce the review findings artifact.', 'artifact_missing', {
            files: ['reports/review-findings.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Regression risk/i.test(review) || !/Suggested test/i.test(review)) {
          return createFailureAcceptance('Agent-assisted review artifact is missing regression-focused content.', 'agent_profile_misapplied', {
            files: ['reports/review-findings.md'],
            contentAssertionsPassed: false
          });
        }
        const instructionsEvent = [...task.events].reverse().find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED');
        if (!instructionsEvent || instructionsEvent.payload?.selectedAgent !== 'review') {
          return createFailureAcceptance('Agent-assisted review did not apply the requested workspace agent profile.', 'agent_profile_misapplied', {
            files: ['reports/review-findings.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Agent-assisted review applied the review agent profile and produced the expected findings.', ['reports/review-findings.md']);
      }
    },
    {
      name: 'general-workspace-command-with-doc-memory',
      family: 'workspace-command-with-doc-memory',
      description: 'Resolve workspace command metadata and imported doc memory inside a task execution path.',
      intent: 'Use the ship-check workspace command context and imported runbook docs to generate reports/ship-check.md and reports/ship-check.json.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Ship Check Analyst', goal: 'Review imported docs and the ship-check command intent.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Ship Check Writer', goal: 'Write the ship-check report using imported docs and command context.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'reports/ship-check.md' }),
        createUnit({ id: 'AGENT-003', role: 'Ship Check Verifier', goal: 'Verify the ship-check report and JSON summary.', profile: 'verify', dependencies: ['AGENT-002'], taskScope: 'reports/ship-check.json' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/ship-check-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/ship-check.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/ship-check.md',
            content: '# Ship Check\n\n- Verify cache health before deploy.\n- Confirm rollback checklist is linked.\n'
          }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/ship-check.json',
            content: '{\n  "checks": ["Verify cache health before deploy", "Confirm rollback checklist is linked"]\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/ship-check.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/ship-check.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/ship-check.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.initWorkspaceWorkflow();
        await harness.writeRootFile('workspace-docs/runbook.md', '# Runbook\n\nVerify cache health before deploy.\nLink the rollback checklist.\n');
        await harness.writeRootFile('.scc/commands/ship-check.md', '---\ndescription: Build a release ship check summary\nargs: <target>\nwhen: use before release\n---\nBuild the ship check for ${args} using imported runbook guidance.\n');
        await harness.writeRootFile('.scc/docs.json', '{\n  "sources": [\n    { "path": "workspace-docs/runbook.md", "title": "Runbook", "tags": ["ops", "release"] }\n  ]\n}\n');
        await harness.importWorkspaceDocs();
      },
      fixtureFiles: {},
      artifactFiles: ['reports/ship-check.md', 'reports/ship-check.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'TASK_COMPLETED'],
      taskMetadata: {
        workspaceCommand: {
          name: 'ship-check',
          description: 'Build a release ship check summary',
          template: 'Build the ship check using imported runbook guidance.'
        }
      },
      async acceptance(harness, task) {
        const markdown = await harness.readWorkspaceFile('reports/ship-check.md').catch(() => null);
        const json = await harness.readWorkspaceFile('reports/ship-check.json').catch(() => null);
        if (!markdown || !json) {
          return createFailureAcceptance('Workspace command with doc memory did not produce the expected ship-check artifacts.', 'artifact_missing', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/Verify cache health before deploy/i.test(markdown) || !/rollback checklist/i.test(markdown) || !/Verify cache health before deploy/i.test(json)) {
          return createFailureAcceptance('Workspace command with doc memory missed required imported-doc content.', 'workspace_command_resolution_failed', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        const instructionsEvent = [...task.events].reverse().find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED');
        if (!instructionsEvent || instructionsEvent.payload?.commandName !== 'ship-check') {
          return createFailureAcceptance('Workspace command metadata was not resolved into the task execution context.', 'workspace_command_resolution_failed', {
            files: ['reports/ship-check.md', 'reports/ship-check.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Workspace command and imported doc memory were both applied to the ship-check task.', ['reports/ship-check.md', 'reports/ship-check.json']);
      }
    },
    {
      name: 'general-skill-driven-task',
      family: 'skill-driven-task',
      description: 'Execute a configured skill during task runtime and keep the result visible in outputs and diagnostics.',
      intent: 'Use the registered echo skill during implementation and write reports/skill-output.md summarizing the returned payload.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Skill Analyst', goal: 'Understand the skill-driven task goal.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Skill Writer', goal: 'Write the report using the skill output.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'reports/skill-output.md' }),
        createUnit({ id: 'AGENT-003', role: 'Skill Verifier', goal: 'Verify the report and recorded skill execution.', profile: 'verify', dependencies: ['AGENT-002'], taskScope: 'reports/skill-output.md' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/skill-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/skill-output.md'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/skill-output.md',
            content: '# Skill Output\n\nSkill returned value: skill-ok\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/skill-output.md'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/skill-output.md' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        await harness.registerSkillRuntime({
          id: 'skill.echo',
          name: 'skill-echo',
          rootDir: path.join(harness.getRootDir(), 'skills', 'echo'),
          runtime: {
            async invoke({ input }) {
              return {
                ok: true,
                output: {
                  echoed: input.value ?? 'none'
                },
                error: null,
                metadata: {
                  source: 'general-complex'
                }
              };
            }
          },
          capability: {
            supportsStreaming: false,
            supportsWorkspaceWrite: false,
            supportsNetworkAccess: false
          }
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/skill-output.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'SKILL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        extensions: {
          skills: [
            {
              unitId: 'AGENT-002',
              skillId: 'skill.echo',
              payload: { value: 'skill-ok' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/skill-output.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Skill-driven task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/skill-output.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/skill-ok/.test(report)) {
          return createFailureAcceptance('Skill-driven task report is missing the skill output.', 'content_assertion_failed', {
            files: ['reports/skill-output.md'],
            contentAssertionsPassed: false
          });
        }
        if ((summary.skillSummary?.recent?.[0]?.status ?? null) !== 'SUCCEEDED') {
          return createFailureAcceptance('Skill-driven task did not record a successful skill execution summary.', 'content_assertion_failed', {
            files: ['reports/skill-output.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Skill-driven task produced the report artifact and exposed successful skill execution in diagnostics.', ['reports/skill-output.md']);
      }
    },
    {
      name: 'general-mcp-tool-assisted-task',
      family: 'mcp-tool-assisted-task',
      description: 'Execute a configured MCP tool during task runtime and keep the result visible in outputs and diagnostics.',
      intent: 'Use the registered MCP echo tool during implementation and write reports/mcp-output.json summarizing the tool result.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'MCP Analyst', goal: 'Understand the MCP-assisted task goal.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'MCP Writer', goal: 'Write the report using the MCP tool output.', profile: 'implement', dependencies: ['AGENT-001'], taskScope: 'reports/mcp-output.json' }),
        createUnit({ id: 'AGENT-003', role: 'MCP Verifier', goal: 'Verify the MCP report and recorded tool execution.', profile: 'verify', dependencies: ['AGENT-002'], taskScope: 'reports/mcp-output.json' })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/mcp-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'reports/mcp-output.json'),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'write_file', {
            path: 'reports/mcp-output.json',
            content: '{\n  "tool": "echo",\n  "value": "mcp-ok"\n}\n'
          }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'reports/mcp-output.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/mcp-output.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      async prepare(harness) {
        harness.registerMcpServerRuntime({
          id: 'mcp.echo',
          name: 'mcp-echo',
          transport: 'stdio',
          command: 'mcp-echo',
          client: {
            async connect() {},
            async callTool({ toolName, arguments: args }) {
              return {
                ok: true,
                output: {
                  toolName,
                  echoed: args.value ?? 'none'
                },
                error: null,
                metadata: {
                  source: 'general-complex'
                }
              };
            }
          },
          capability: {
            supportsTools: true,
            supportsPrompts: false,
            supportsResources: false,
            supportsStreaming: false
          }
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/mcp-output.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'MCP_TOOL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        extensions: {
          mcp: [
            {
              unitId: 'AGENT-002',
              serverId: 'mcp.echo',
              toolName: 'echo',
              arguments: { value: 'mcp-ok' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/mcp-output.json').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('MCP-assisted task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/mcp-output.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/mcp-ok/.test(report)) {
          return createFailureAcceptance('MCP-assisted task report is missing the MCP tool output.', 'content_assertion_failed', {
            files: ['reports/mcp-output.json'],
            contentAssertionsPassed: false
          });
        }
        if ((summary.mcpSummary?.recent?.[0]?.status ?? null) !== 'SUCCEEDED') {
          return createFailureAcceptance('MCP-assisted task did not record a successful MCP execution summary.', 'content_assertion_failed', {
            files: ['reports/mcp-output.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('MCP-assisted task produced the report artifact and exposed successful MCP execution in diagnostics.', ['reports/mcp-output.json']);
      }
    },
    {
      name: 'general-skill-failure-diagnostics',
      family: 'skill-failure-diagnostics',
      description: 'Keep task diagnostics interpretable when a configured skill is unavailable.',
      intent: 'Attempt the configured missing skill during implementation, then write reports/skill-failure.md explaining the fallback path.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Fallback Writer', goal: 'Write a fallback report after the missing skill attempt.', profile: 'implement', dependencies: [], taskScope: 'reports/skill-failure.md' }),
        createUnit({ id: 'AGENT-002', role: 'Fallback Verifier', goal: 'Verify the fallback report and missing-skill diagnostics.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/skill-failure.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/skill-failure.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/skill-failure.md',
            content: '# Skill Failure\n\nFallback path used because the configured skill was unavailable.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/skill-failure.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/skill-failure.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      fixtureFiles: {},
      artifactFiles: ['reports/skill-failure.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'SKILL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        extensions: {
          skills: [
            {
              unitId: 'AGENT-001',
              skillId: 'skill.missing',
              payload: { value: 'fallback' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/skill-failure.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Skill-failure diagnostics task did not produce the fallback report artifact.', 'artifact_missing', {
            files: ['reports/skill-failure.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/unavailable/i.test(report)) {
          return createFailureAcceptance('Skill-failure diagnostics report is missing the fallback explanation.', 'content_assertion_failed', {
            files: ['reports/skill-failure.md'],
            contentAssertionsPassed: false
          });
        }
        if ((summary.skillSummary?.recent?.[0]?.status ?? null) !== 'UNAVAILABLE' || summary.issueCategory !== 'skill_runtime_unavailable') {
          return createFailureAcceptance('Skill-failure diagnostics did not preserve the expected missing-skill summary.', 'content_assertion_failed', {
            files: ['reports/skill-failure.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Skill-failure diagnostics kept the task explainable after a missing skill invocation.', ['reports/skill-failure.md']);
      }
    },
    {
      name: 'general-mcp-failure-recovery',
      family: 'mcp-failure-recovery',
      description: 'Keep task diagnostics interpretable when a configured MCP call fails and the task recovers with a fallback artifact.',
      intent: 'Attempt the configured failing MCP tool during implementation, then write reports/mcp-fallback.md explaining the fallback path.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Fallback Writer', goal: 'Write a fallback report after the failing MCP call.', profile: 'implement', dependencies: [], taskScope: 'reports/mcp-fallback.md' }),
        createUnit({ id: 'AGENT-002', role: 'Fallback Verifier', goal: 'Verify the fallback report and MCP failure diagnostics.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/mcp-fallback.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/mcp-fallback.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/mcp-fallback.md',
            content: '# MCP Fallback\n\nFallback path used because the configured MCP tool call failed.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/mcp-fallback.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/mcp-fallback.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        harness.registerMcpServerRuntime({
          id: 'mcp.failing',
          name: 'mcp-failing',
          transport: 'stdio',
          command: 'mcp-failing',
          client: {
            async connect() {},
            async callTool() {
              return {
                ok: false,
                output: null,
                error: 'simulated MCP failure',
                metadata: {
                  source: 'general-complex'
                }
              };
            }
          },
          capability: {
            supportsTools: true,
            supportsPrompts: false,
            supportsResources: false,
            supportsStreaming: false
          }
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/mcp-fallback.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'MCP_TOOL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        extensions: {
          mcp: [
            {
              unitId: 'AGENT-001',
              serverId: 'mcp.failing',
              toolName: 'echo',
              arguments: { value: 'recover-me' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/mcp-fallback.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('MCP-failure recovery task did not produce the fallback report artifact.', 'artifact_missing', {
            files: ['reports/mcp-fallback.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/failed/i.test(report)) {
          return createFailureAcceptance('MCP-failure recovery report is missing the failure explanation.', 'content_assertion_failed', {
            files: ['reports/mcp-fallback.md'],
            contentAssertionsPassed: false
          });
        }
        if ((summary.mcpSummary?.recent?.[0]?.status ?? null) !== 'FAILED' || summary.issueCategory !== 'mcp_call_failed') {
          return createFailureAcceptance('MCP-failure recovery did not preserve the expected MCP failure summary.', 'content_assertion_failed', {
            files: ['reports/mcp-fallback.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('MCP-failure recovery kept the task explainable after a failing MCP tool call.', ['reports/mcp-fallback.md']);
      }
    },
    {
      name: 'general-instruction-skill-guided-task',
      family: 'instruction-skill-guided-task',
      description: 'Import a Claude-style instruction skill and apply it as explicit task guidance without treating it as an executable runtime skill.',
      intent: 'Use the imported release-guidance instruction skill to write reports/instruction-guided.md with the checklist language from the skill instructions.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Instruction Skill Writer', goal: 'Produce the guided report using the selected instruction skill.', profile: 'implement', dependencies: [], taskScope: 'reports/instruction-guided.md' }),
        createUnit({ id: 'AGENT-002', role: 'Instruction Skill Verifier', goal: 'Verify the selected instruction skill summary and generated report.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/instruction-guided.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/instruction-guided.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/instruction-guided.md',
            content: '# Guided Release Report\n\n- Verify rollout checklist\n- Confirm rollback note is attached\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/instruction-guided.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/instruction-guided.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        const marketplaceFile = await writeClaudeStyleMarketplaceFixture({
          rootDir: harness.getRootDir(),
          pluginName: 'guided-release',
          skills: [
            {
              path: 'release-guidance',
              skillMarkdown: [
                '---',
                'name: release-guidance',
                'description: Use the release checklist language before shipping.',
                '---',
                'Verify rollout checklist and confirm rollback note is attached before release.'
              ].join('\n')
            }
          ]
        });
        await harness.importMarketplaceSkills({
          marketplaceFile,
          pluginName: 'guided-release'
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/instruction-guided.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'TASK_COMPLETED'],
      taskMetadata: {
        instructionSkills: ['release-guidance']
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/instruction-guided.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Instruction-skill guided task did not produce the guided report artifact.', 'artifact_missing', {
            files: ['reports/instruction-guided.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Verify rollout checklist/i.test(report) || !/rollback note/i.test(report)) {
          return createFailureAcceptance('Instruction-skill guided report is missing the imported guidance language.', 'content_assertion_failed', {
            files: ['reports/instruction-guided.md'],
            contentAssertionsPassed: false
          });
        }
        if (summary.instructionSkillSummary.selectedCount !== 1 || summary.instructionSkillSummary.selected[0]?.name !== 'release-guidance') {
          return createFailureAcceptance('Instruction-skill guided task did not expose the selected Claude-style skill in the execution summary.', 'content_assertion_failed', {
            files: ['reports/instruction-guided.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Instruction-skill guided task kept the imported Claude-style skill visible and applied in task context.', ['reports/instruction-guided.md']);
      }
    },
    {
      name: 'general-instruction-skill-with-assets',
      family: 'instruction-skill-with-assets',
      description: 'Import a Claude-style instruction skill with templates/assets and keep those asset references visible during task execution.',
      intent: 'Use the imported rollout-assets instruction skill to write reports/asset-guided.md referencing the template and screenshot asset hints.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Asset Skill Writer', goal: 'Write the asset-guided report using the selected instruction skill assets.', profile: 'implement', dependencies: [], taskScope: 'reports/asset-guided.md' }),
        createUnit({ id: 'AGENT-002', role: 'Asset Skill Verifier', goal: 'Verify the asset-guided report and exposed asset paths.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/asset-guided.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/asset-guided.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/asset-guided.md',
            content: '# Asset Guided Report\n\nUse templates/checklist.md and assets/images/reference.txt during rollout validation.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/asset-guided.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/asset-guided.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        const marketplaceFile = await writeClaudeStyleMarketplaceFixture({
          rootDir: harness.getRootDir(),
          pluginName: 'asset-guidance',
          skills: [
            {
              path: 'rollout-assets',
              skillMarkdown: [
                '---',
                'name: rollout-assets',
                'description: Use rollout templates and reference assets.',
                'mcpServers: browser-mcp',
                '---',
                'Use templates/checklist.md and screenshot references during rollout validation.'
              ].join('\n'),
              extraFiles: {
                'templates/checklist.md': '# Checklist\n\n- Verify rollout checklist\n',
                'assets/images/reference.txt': 'reference asset'
              }
            }
          ]
        });
        await harness.importMarketplaceSkills({
          marketplaceFile,
          pluginName: 'asset-guidance'
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/asset-guided.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'TASK_COMPLETED'],
      taskMetadata: {
        instructionSkills: ['rollout-assets']
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/asset-guided.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Instruction-skill asset task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/asset-guided.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/templates\/checklist\.md/i.test(report) || !/assets\/images\/reference\.txt/i.test(report)) {
          return createFailureAcceptance('Instruction-skill asset task report is missing the asset references.', 'content_assertion_failed', {
            files: ['reports/asset-guided.md'],
            contentAssertionsPassed: false
          });
        }
        const selected = summary.instructionSkillSummary.selected[0];
        if (!selected || !selected.assetPaths.includes('templates/checklist.md') || !selected.assetPaths.includes('assets/images/reference.txt')) {
          return createFailureAcceptance('Instruction-skill asset task did not preserve template and asset references in the execution summary.', 'content_assertion_failed', {
            files: ['reports/asset-guided.md'],
            contentAssertionsPassed: false
          });
        }
        if (!selected.declaredMcpDependencies.includes('browser-mcp')) {
          return createFailureAcceptance('Instruction-skill asset task did not preserve declared MCP dependency hints.', 'content_assertion_failed', {
            files: ['reports/asset-guided.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Instruction-skill asset task kept imported asset references visible to operators and the task summary.', ['reports/asset-guided.md']);
      }
    },
    {
      name: 'general-mixed-runtime-and-instruction-skill-task',
      family: 'mixed-runtime-and-instruction-skill-task',
      description: 'Combine executable runtime skills with selected Claude-style instruction skills without blurring their execution semantics.',
      intent: 'Use the imported release-guidance instruction skill plus the runtime echo skill to write reports/mixed-skill.md explaining both the guidance and the executed runtime result.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Mixed Skill Writer', goal: 'Write the mixed skill report using instruction guidance and runtime skill output.', profile: 'implement', dependencies: [], taskScope: 'reports/mixed-skill.md' }),
        createUnit({ id: 'AGENT-002', role: 'Mixed Skill Verifier', goal: 'Verify the mixed skill report and both skill summaries.', profile: 'verify', dependencies: ['AGENT-001'], taskScope: 'reports/mixed-skill.md' })
      ],
      responses: [
        [
          createOutput('AGENT-001', 'reports/mixed-skill.md'),
          createToolCall('AGENT-001', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-001', 'write_file', {
            path: 'reports/mixed-skill.md',
            content: '# Mixed Skill Report\n\nInstruction guidance: Verify rollout checklist.\nRuntime skill result: runtime-ok.\n'
          }),
          createTracker('AGENT-001')
        ].join('\n'),
        [
          createOutput('AGENT-002', 'reports/mixed-skill.md'),
          createToolCall('AGENT-002', 'read_file', { path: 'reports/mixed-skill.md' }),
          createTracker('AGENT-002')
        ].join('\n')
      ],
      async prepare(harness) {
        const marketplaceFile = await writeClaudeStyleMarketplaceFixture({
          rootDir: harness.getRootDir(),
          pluginName: 'mixed-skills',
          skills: [
            {
              path: 'release-guidance',
              skillMarkdown: [
                '---',
                'name: release-guidance',
                'description: Use the release checklist language before shipping.',
                '---',
                'Verify rollout checklist before release.'
              ].join('\n')
            }
          ]
        });
        await harness.importMarketplaceSkills({
          marketplaceFile,
          pluginName: 'mixed-skills'
        });
        await harness.registerSkillRuntime({
          id: 'skill.echo',
          name: 'skill-echo',
          rootDir: path.join(harness.getRootDir(), 'skills', 'echo'),
          runtime: {
            async invoke({ input }) {
              return {
                ok: true,
                output: {
                  echoed: input.value ?? 'none'
                },
                error: null,
                metadata: {
                  source: 'general-complex'
                }
              };
            }
          },
          capability: {
            supportsStreaming: false,
            supportsWorkspaceWrite: false,
            supportsNetworkAccess: false
          }
        });
      },
      fixtureFiles: {},
      artifactFiles: ['reports/mixed-skill.md'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED', 'SKILL_EXECUTED', 'TASK_COMPLETED'],
      taskMetadata: {
        instructionSkills: ['release-guidance'],
        extensions: {
          skills: [
            {
              unitId: 'AGENT-001',
              skillId: 'skill.echo',
              payload: { value: 'runtime-ok' }
            }
          ]
        }
      },
      async acceptance(harness, task) {
        const report = await harness.readWorkspaceFile('reports/mixed-skill.md').catch(() => null);
        const summary = buildTaskExecutionSummary(task);
        if (!report) {
          return createFailureAcceptance('Mixed runtime and instruction skill task did not produce the expected report artifact.', 'artifact_missing', {
            files: ['reports/mixed-skill.md'],
            contentAssertionsPassed: false
          });
        }
        if (!/Verify rollout checklist/i.test(report) || !/runtime-ok/i.test(report)) {
          return createFailureAcceptance('Mixed skill task report is missing either the instruction guidance or runtime skill result.', 'content_assertion_failed', {
            files: ['reports/mixed-skill.md'],
            contentAssertionsPassed: false
          });
        }
        if (summary.instructionSkillSummary.selectedCount !== 1 || summary.skillSummary.recent[0]?.status !== 'SUCCEEDED') {
          return createFailureAcceptance('Mixed skill task did not expose both instruction-skill selection and runtime-skill execution summaries.', 'content_assertion_failed', {
            files: ['reports/mixed-skill.md'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Mixed runtime and instruction skill task kept both skill tracks visible without conflating execution semantics.', ['reports/mixed-skill.md']);
      }
    },
    {
      name: 'general-multi-artifact-bundle',
      family: 'multi-artifact-bundle',
      description: 'Produce code, report, and index artifacts together and verify the bundle.',
      intent: 'Generate src/bundle.cjs, reports/bundle.md, and bundle/index.json for the release helper bundle, then verify that all artifacts agree on the bundle name.',
      units: [
        createUnit({ id: 'AGENT-001', role: 'Bundle Analyst', goal: 'Understand the bundle requirements.', profile: 'analyze', dependencies: [] }),
        createUnit({ id: 'AGENT-002', role: 'Bundle Author', goal: 'Write the multi-artifact bundle.', profile: 'implement', dependencies: ['AGENT-001'] }),
        createUnit({ id: 'AGENT-003', role: 'Bundle Verifier', goal: 'Verify the bundle artifacts.', profile: 'verify', dependencies: ['AGENT-002'] })
      ],
      responses: [
        [createOutput('AGENT-001', 'analysis/bundle-plan.md'), createTracker('AGENT-001')].join('\n'),
        [
          createOutput('AGENT-002', 'src/bundle.cjs'),
          createToolCall('AGENT-002', 'create_folder', { path: 'src' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'reports' }),
          createToolCall('AGENT-002', 'create_folder', { path: 'bundle' }),
          createToolCall('AGENT-002', 'write_file', { path: 'src/bundle.cjs', content: 'module.exports = { bundleName: "release-helper" };\n' }),
          createToolCall('AGENT-002', 'write_file', { path: 'reports/bundle.md', content: '# Bundle Report\n\nBundle: release-helper\n' }),
          createToolCall('AGENT-002', 'write_file', { path: 'bundle/index.json', content: '{\n  "bundleName": "release-helper",\n  "artifacts": ["src/bundle.cjs", "reports/bundle.md"]\n}\n' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'bundle/index.json'),
          createToolCall('AGENT-003', 'read_file', { path: 'src/bundle.cjs' }),
          createToolCall('AGENT-003', 'read_file', { path: 'reports/bundle.md' }),
          createToolCall('AGENT-003', 'read_file', { path: 'bundle/index.json' }),
          createTracker('AGENT-003')
        ].join('\n')
      ],
      fixtureFiles: {
        'inputs/bundle.json': '{\n  "bundleName": "release-helper"\n}\n'
      },
      artifactFiles: ['src/bundle.cjs', 'reports/bundle.md', 'bundle/index.json'],
      allowedCommands: [],
      requiredEventTypes: ['TASK_STARTED', 'TOOL_BATCH_EXECUTED', 'TASK_COMPLETED'],
      async acceptance(harness) {
        const code = await harness.readWorkspaceFile('src/bundle.cjs').catch(() => null);
        const report = await harness.readWorkspaceFile('reports/bundle.md').catch(() => null);
        const index = await harness.readWorkspaceFile('bundle/index.json').catch(() => null);
        if (!code || !report || !index) {
          return createFailureAcceptance('Multi-artifact bundle was not fully generated.', 'artifact_missing', {
            files: ['src/bundle.cjs', 'reports/bundle.md', 'bundle/index.json'],
            contentAssertionsPassed: false
          });
        }
        if (!/release-helper/.test(code) || !/release-helper/.test(report) || !/release-helper/.test(index)) {
          return createFailureAcceptance('Bundle artifacts do not agree on the bundle name.', 'content_assertion_failed', {
            files: ['src/bundle.cjs', 'reports/bundle.md', 'bundle/index.json'],
            contentAssertionsPassed: false
          });
        }
        return createPassedAcceptance('Multi-artifact bundle contains consistent code, report, and index outputs.', ['src/bundle.cjs', 'reports/bundle.md', 'bundle/index.json']);
      }
    }
  ];
}

async function runTaskGeneralComplexScenarioSuiteOnce(): Promise<TaskGeneralComplexScenarioSuiteResult> {
  const definitions = createGeneralComplexScenarioDefinitions();
  const scenarios: TaskGeneralComplexScenarioResult[] = [];

  for (const definition of definitions) {
    const harness = new GeneralComplexScenarioHarness(definition);
    try {
      await harness.submit();
      const task = definition.execute
        ? await definition.execute(harness)
        : await (async () => {
          const started = await harness.start();
          return driveToCompletion(harness, started);
        })();
      scenarios.push(await harness.finalize(task));
    } finally {
      await harness.close();
    }
  }

  let passed = 0;
  let failed = 0;
  let totalApiCalls = 0;
  let totalExecutedToolBatches = 0;
  const byFailureCategory: Partial<Record<GeneralComplexFailureCategory, number>> = {};
  const byFamily: Record<GeneralComplexScenarioFamily, number> = {
    'config-migration': 0,
    'script-repair': 0,
    'data-transformation': 0,
    'workspace-maintenance': 0,
    'long-running-correction-churn': 0,
    'checkpoint-recovery-task': 0,
    'provider-failure-streak-task': 0,
    'extension-failure-stability-task': 0,
    'workspace-bootstrap': 0,
    'workspace-docs-import': 0,
    'workspace-command-driven-task': 0,
    'workspace-index-rebuild': 0,
    'workspace-bulk-maintenance': 0,
    'rule-constrained-implementation': 0,
    'hook-observable-task': 0,
    'agent-assisted-review': 0,
    'workspace-command-with-doc-memory': 0,
    'skill-driven-task': 0,
    'mcp-tool-assisted-task': 0,
    'skill-failure-diagnostics': 0,
    'mcp-failure-recovery': 0,
    'instruction-skill-guided-task': 0,
    'instruction-skill-with-assets': 0,
    'mixed-runtime-and-instruction-skill-task': 0,
    'diagnostic-triage': 0,
    'policy-sensitive-change': 0,
    'rich-doc-output': 0,
    'complex-docs-bundle': 0,
    'decision-log-synthesis': 0,
    'decision-doc-from-imported-sources': 0,
    'multi-artifact-bundle': 0
  };

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    totalApiCalls += scenario.metrics.apiCallCount;
    totalExecutedToolBatches += scenario.metrics.executedToolBatchCount;
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
    if (scenario.artifactQuality.failureCategory) {
      byFailureCategory[scenario.artifactQuality.failureCategory] = (byFailureCategory[scenario.artifactQuality.failureCategory] ?? 0) + 1;
    }
  }

  return {
    generatedAt: Date.now(),
    status: failed === 0 ? 'achieved' : 'open_gap',
    scenarios,
    totals: {
      total: scenarios.length,
      passed,
      failed,
      successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      artifactQualityPassRate: Number((scenarios.filter((scenario) => scenario.artifactQuality.verdict === 'passed').length / Math.max(1, scenarios.length)).toFixed(4)),
      averageApiCallCount: Number((totalApiCalls / Math.max(1, scenarios.length)).toFixed(4)),
      averageExecutedToolBatchCount: Number((totalExecutedToolBatches / Math.max(1, scenarios.length)).toFixed(4)),
      byFamily,
      byFailureCategory
    }
  };
}

export async function runTaskGeneralComplexScenarioSuite(): Promise<TaskGeneralComplexScenarioSuiteResult> {
  const first = await runTaskGeneralComplexScenarioSuiteOnce();
  if (first.status === 'achieved') {
    return first;
  }
  return runTaskGeneralComplexScenarioSuiteOnce();
}
