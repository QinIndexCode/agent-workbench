import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendNewFoundation } from '../../foundation/bootstrap/create-foundation';
import { createBackendNewRuntime } from '../create-runtime';
import { buildTaskExecutionSummary } from '../tasks/task-execution-observability';
import { TaskExecutionIssueCategory, TaskExecutionSummary } from '../tasks/types';
import { runRepoRealTaskSuite } from './repo-real-tasks';
import { runTaskGeneralComplexScenarioSuite } from './general-complex-scenarios';

export type RuntimeStressValidationFamily =
  | 'high-event-stability'
  | 'approval-backlog-recovery'
  | 'correction-loop-blocking'
  | 'artifact-apply-recovery'
  | 'provider-failure-recovery'
  | 'hook-mcp-recovery'
  | 'queue-runtime-alignment';

export interface RuntimeStressValidationScenarioResult {
  scenario: string;
  family: RuntimeStressValidationFamily;
  sourceSuite: 'repo-real' | 'general-complex' | 'direct-runtime';
  sourceScenario: string;
  passed: boolean;
  issueCategory: TaskExecutionIssueCategory | null;
  summary: string;
  queueRuntimeConsistent: boolean;
  artifactQualityVerdict: 'passed' | 'failed';
  failureCategory: string | null;
  evidence: string[];
  executionSummary: TaskExecutionSummary | null;
}

export interface RuntimeStressValidationSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: RuntimeStressValidationScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactQualityPassRate: number;
    byFamily: Record<RuntimeStressValidationFamily, number>;
    byFailureCategory: Record<string, number>;
  };
}

function createTempRoot(prefix = 'backend-new-runtime-stress-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function registerProvider(foundation: ReturnType<typeof createBackendNewFoundation>, responses: string[]): void {
  const queue = [...responses];
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    baseUrl: 'https://provider.example.com',
    model: 'mock-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete() {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued.');
      }
      return {
        responseId: `resp_${Date.now()}`,
        providerId: 'provider-main',
        model: 'mock-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20
        },
        metadata: {}
      };
    }
  });
}

async function runDirectArtifactApplyScenario(): Promise<RuntimeStressValidationScenarioResult> {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"report created","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"scratch/output","content":"artifact\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["scratch/output"]}',
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Path apply task',
      intent: 'Create a file, wait for an operator-selected destination, then finish.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'ask_if_unclear',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Generate a project artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const unresolved = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      message: 'backend/docs',
      metadata: {
        destinationDir: 'backend/docs'
      }
    });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    const completed = await runtime.tasks.getTask(submitted.command.taskId);
    const destinationPath = path.join(root, 'backend', 'docs', 'scratch', 'output');
    const destinationExists = fs.existsSync(destinationPath);
    const executionSummary = buildTaskExecutionSummary(completed, foundation);

    await runtime.close();

    const passed = unresolved.executionSummary.artifactPathState === 'unresolved'
      && unresolved.executionSummary.turnContract.continueAllowed === false
      && debug.executionSummary.lastArtifactApplyResult?.status === 'APPLIED'
      && completed.runtime.lifecycleStatus === 'COMPLETED'
      && executionSummary.queueRuntimeAlignment.consistent
      && destinationExists;

    return {
      scenario: 'direct-artifact-apply-recovery',
      family: 'artifact-apply-recovery',
      sourceSuite: 'direct-runtime',
      sourceScenario: 'direct-artifact-apply-recovery',
      passed,
      issueCategory: executionSummary.issueCategory,
      summary: passed
        ? 'Artifact routing blocks on unresolved destination, applies sandbox outputs, and auto-completes without drift once no further parent work remains.'
        : 'Artifact apply recovery did not preserve the unresolved blocker, explicit apply, and final completion chain.',
      queueRuntimeConsistent: executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: destinationExists ? 'passed' : 'failed',
      failureCategory: passed ? null : 'artifact_apply_recovery_failed',
      evidence: [
        `preApplyState=${unresolved.executionSummary.artifactPathState}`,
        `continueAllowed=${String(unresolved.executionSummary.turnContract.continueAllowed)}`,
        `applyStatus=${debug.executionSummary.lastArtifactApplyResult?.status ?? 'missing'}`,
        `destination=${destinationPath}`,
        `destinationExists=${String(destinationExists)}`
      ],
      executionSummary
    };
  } finally {
    removeDir(root);
  }
}

function fromExistingScenario(params: Omit<RuntimeStressValidationScenarioResult, 'scenario'> & { scenario?: string }): RuntimeStressValidationScenarioResult {
  return {
    scenario: params.scenario ?? params.sourceScenario,
    ...params
  };
}

export async function runRuntimeStressValidationSuite(): Promise<RuntimeStressValidationSuiteResult> {
  const [repoReal, generalComplex, directArtifactApply] = await Promise.all([
    runRepoRealTaskSuite(),
    runTaskGeneralComplexScenarioSuite(),
    runDirectArtifactApplyScenario()
  ]);

  const repoByFamily = new Map(repoReal.scenarios.map((scenario) => [scenario.family, scenario]));
  const generalByFamily = new Map(generalComplex.scenarios.map((scenario) => [scenario.family, scenario]));
  const eventStability = generalByFamily.get('extension-failure-stability-task');
  const approvalRecovery = repoByFamily.get('permission-blocked-task');
  const correctionLoop = generalByFamily.get('long-running-correction-churn');
  const providerFailure = generalByFamily.get('provider-failure-streak-task');
  const hookRecovery = repoByFamily.get('hook-observable-recovery-task');
  const queueAlignment = generalByFamily.get('checkpoint-recovery-task');

  if (!eventStability || !approvalRecovery || !correctionLoop || !providerFailure || !hookRecovery || !queueAlignment) {
    throw new Error('runtime stress validation could not resolve required source scenarios.');
  }

  const scenarios: RuntimeStressValidationScenarioResult[] = [
    fromExistingScenario({
      family: 'high-event-stability',
      sourceSuite: 'general-complex',
      sourceScenario: eventStability.scenario,
      passed:
        eventStability.executionSummary.queueRuntimeAlignment.consistent
        && eventStability.artifactQuality.verdict === 'passed'
        && eventStability.executionSummary.skillFailureStreak >= 1
        && eventStability.executionSummary.mcpFailureStreak >= 1
        && eventStability.metrics.eventCount >= 20
        && eventStability.executionSummary.lastArtifactApplyResult?.status === 'APPLIED',
      issueCategory: eventStability.issueCategory,
      summary: 'High event density stays explainable and aligned under extension failure stability coverage.',
      queueRuntimeConsistent: eventStability.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: eventStability.artifactQuality.verdict,
      failureCategory: eventStability.artifactQuality.failureCategory,
      evidence: [
        `turnCount=${eventStability.executionSummary.turnCount}`,
        `eventCount=${eventStability.metrics.eventCount}`,
        `queueRuntimeConsistent=${String(eventStability.executionSummary.queueRuntimeAlignment.consistent)}`
      ],
      executionSummary: eventStability.executionSummary
    }),
    fromExistingScenario({
      family: 'approval-backlog-recovery',
      sourceSuite: 'repo-real',
      sourceScenario: approvalRecovery.scenario,
      passed: approvalRecovery.passed && approvalRecovery.executionSummary.permissionSummary.approvalRequiredCount >= 1 && approvalRecovery.executionSummary.queueRuntimeAlignment.consistent,
      issueCategory: approvalRecovery.issueCategory,
      summary: 'Approval backlog recovery remains explainable through summary-first permission and queue/runtime state.',
      queueRuntimeConsistent: approvalRecovery.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: approvalRecovery.artifactQuality.verdict,
      failureCategory: approvalRecovery.artifactQuality.failureCategory,
      evidence: [
        `approvalRequiredCount=${approvalRecovery.executionSummary.permissionSummary.approvalRequiredCount}`,
        `queueRuntimeConsistent=${String(approvalRecovery.executionSummary.queueRuntimeAlignment.consistent)}`
      ],
      executionSummary: approvalRecovery.executionSummary
    }),
    fromExistingScenario({
      family: 'correction-loop-blocking',
      sourceSuite: 'general-complex',
      sourceScenario: correctionLoop.scenario,
      passed: correctionLoop.passed && correctionLoop.executionSummary.correctionDepth >= 1,
      issueCategory: correctionLoop.issueCategory,
      summary: 'Correction churn remains categorized and does not fall into unknown non-convergent drift.',
      queueRuntimeConsistent: correctionLoop.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: correctionLoop.artifactQuality.verdict,
      failureCategory: correctionLoop.artifactQuality.failureCategory,
      evidence: [
        `correctionDepth=${correctionLoop.executionSummary.correctionDepth}`,
        `issueCategory=${correctionLoop.issueCategory ?? 'none'}`
      ],
      executionSummary: correctionLoop.executionSummary
    }),
    directArtifactApply,
    fromExistingScenario({
      family: 'provider-failure-recovery',
      sourceSuite: 'general-complex',
      sourceScenario: providerFailure.scenario,
      passed: providerFailure.passed && providerFailure.executionSummary.providerFailureStreak >= 1 && providerFailure.executionSummary.queueRuntimeAlignment.consistent,
      issueCategory: providerFailure.issueCategory,
      summary: 'Provider failure streak recovery keeps conservative-mode and blocker guidance explainable.',
      queueRuntimeConsistent: providerFailure.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: providerFailure.artifactQuality.verdict,
      failureCategory: providerFailure.artifactQuality.failureCategory,
      evidence: [
        `providerFailureStreak=${providerFailure.executionSummary.providerFailureStreak}`,
        `conservativeModeReason=${providerFailure.executionSummary.conservativeModeReason ?? 'none'}`
      ],
      executionSummary: providerFailure.executionSummary
    }),
    fromExistingScenario({
      family: 'hook-mcp-recovery',
      sourceSuite: 'repo-real',
      sourceScenario: hookRecovery.scenario,
      passed: hookRecovery.passed
        && hookRecovery.executionSummary.mcpSummary.recent.some((record) => record.status === 'FAILED')
        && hookRecovery.executionSummary.hookSummary.executedCount + hookRecovery.executionSummary.hookSummary.failedCount >= 1,
      issueCategory: hookRecovery.issueCategory,
      summary: 'Hook and MCP failure recovery remain operator-visible instead of degrading into opaque failure.',
      queueRuntimeConsistent: hookRecovery.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: hookRecovery.artifactQuality.verdict,
      failureCategory: hookRecovery.artifactQuality.failureCategory,
      evidence: [
        `mcpRecentStatuses=${hookRecovery.executionSummary.mcpSummary.recent.map((record) => record.status).join(',')}`,
        `hookCounts=${hookRecovery.executionSummary.hookSummary.executedCount}/${hookRecovery.executionSummary.hookSummary.failedCount}`
      ],
      executionSummary: hookRecovery.executionSummary
    }),
    fromExistingScenario({
      family: 'queue-runtime-alignment',
      sourceSuite: 'general-complex',
      sourceScenario: queueAlignment.scenario,
      passed: queueAlignment.passed && queueAlignment.executionSummary.queueRuntimeAlignment.consistent,
      issueCategory: queueAlignment.issueCategory,
      summary: 'Restart and checkpoint recovery preserve queue/runtime/projection alignment.',
      queueRuntimeConsistent: queueAlignment.executionSummary.queueRuntimeAlignment.consistent,
      artifactQualityVerdict: queueAlignment.artifactQuality.verdict,
      failureCategory: queueAlignment.artifactQuality.failureCategory,
      evidence: [
        `lastRecoverySource=${queueAlignment.executionSummary.lastRecoverySource ?? 'none'}`,
        `queueRuntimeConsistent=${String(queueAlignment.executionSummary.queueRuntimeAlignment.consistent)}`
      ],
      executionSummary: queueAlignment.executionSummary
    })
  ];

  let passed = 0;
  let failed = 0;
  const byFamily: Record<RuntimeStressValidationFamily, number> = {
    'high-event-stability': 0,
    'approval-backlog-recovery': 0,
    'correction-loop-blocking': 0,
    'artifact-apply-recovery': 0,
    'provider-failure-recovery': 0,
    'hook-mcp-recovery': 0,
    'queue-runtime-alignment': 0
  };
  const byFailureCategory: Record<string, number> = {};

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    if (scenario.passed && scenario.artifactQualityVerdict === 'passed' && scenario.queueRuntimeConsistent) {
      passed += 1;
    } else {
      failed += 1;
      const key = scenario.failureCategory ?? scenario.issueCategory ?? 'runtime_stress_failed';
      byFailureCategory[key] = (byFailureCategory[key] ?? 0) + 1;
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
      artifactQualityPassRate: Number((scenarios.filter((scenario) => scenario.artifactQualityVerdict === 'passed').length / Math.max(1, scenarios.length)).toFixed(4)),
      byFamily,
      byFailureCategory
    }
  };
}
