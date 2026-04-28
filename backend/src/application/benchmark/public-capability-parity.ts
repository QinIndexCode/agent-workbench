import { TaskLifecycleStatus } from '../../domain/contracts/types';
import {
  TaskExecutionIssueCategory,
  TaskExecutionSummary,
  TaskObservationHookId
} from '../tasks/types';
import { runTaskGeneralComplexScenarioSuite, TaskGeneralComplexScenarioResult } from './general-complex-scenarios';
import { runRepoRealTaskSuite, RepoRealTaskScenarioResult } from './repo-real-tasks';

export type PublicCapabilityBaseline =
  | 'claude-code'
  | 'opencode'
  | 'anthropic-swebench';

export type PublicCapabilityParityFamily =
  | 'claude-project-instructions-task'
  | 'claude-custom-command-task'
  | 'claude-subagent-review-task'
  | 'claude-hook-recovery-task'
  | 'claude-mcp-managed-selection-task'
  | 'anthropic-swebench-issue-resolution-task'
  | 'opencode-build-plan-split-task'
  | 'opencode-provider-variant-task'
  | 'opencode-permission-gated-task'
  | 'opencode-runtime-skill-task'
  | 'opencode-mcp-capability-task'
  | 'opencode-provider-readiness-task';

export interface PublicCapabilityParityArtifactQuality {
  verdict: 'passed' | 'failed';
  failureCategory: string | null;
  summary: string;
  files: string[];
}

export interface PublicCapabilityParityDiagnostics {
  workspaceDir: string | null;
  artifactSnapshots: Array<{
    path: string;
    exists: boolean;
    excerpt: string | null;
  }>;
}

export interface PublicCapabilityParityScenarioResult {
  scenario: PublicCapabilityParityFamily;
  comparisonBaseline: PublicCapabilityBaseline;
  baselineFamily: string;
  sourceSuite: 'repo-real' | 'general-complex';
  sourceScenario: string;
  sourceFamily: string;
  passed: boolean;
  finalLifecycleStatus: TaskLifecycleStatus;
  issueCategory: TaskExecutionIssueCategory | null;
  issueSummary: string | null;
  missingRequiredEventTypes: string[];
  observedHooks: TaskObservationHookId[];
  executionSummary: TaskExecutionSummary;
  artifactQuality: PublicCapabilityParityArtifactQuality;
  diagnostics: PublicCapabilityParityDiagnostics;
}

export interface PublicCapabilityParitySuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: PublicCapabilityParityScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactQualityPassRate: number;
    byBaseline: Record<PublicCapabilityBaseline, number>;
    byFamily: Record<PublicCapabilityParityFamily, number>;
    byFailureCategory: Record<string, number>;
  };
}

interface PublicCapabilityMapping {
  scenario: PublicCapabilityParityFamily;
  comparisonBaseline: PublicCapabilityBaseline;
  baselineFamily: string;
  sourceSuite: 'repo-real' | 'general-complex';
  sourceFamily: string;
}

const PARITY_MAPPINGS: PublicCapabilityMapping[] = [
  {
    scenario: 'claude-project-instructions-task',
    comparisonBaseline: 'claude-code',
    baselineFamily: 'project-instructions',
    sourceSuite: 'repo-real',
    sourceFamily: 'workspace-rule-review-task'
  },
  {
    scenario: 'claude-custom-command-task',
    comparisonBaseline: 'claude-code',
    baselineFamily: 'custom-command',
    sourceSuite: 'general-complex',
    sourceFamily: 'workspace-command-driven-task'
  },
  {
    scenario: 'claude-subagent-review-task',
    comparisonBaseline: 'claude-code',
    baselineFamily: 'subagent-specialized-review',
    sourceSuite: 'repo-real',
    sourceFamily: 'subagent-specialized-review-task'
  },
  {
    scenario: 'claude-hook-recovery-task',
    comparisonBaseline: 'claude-code',
    baselineFamily: 'hook-observable-recovery',
    sourceSuite: 'repo-real',
    sourceFamily: 'hook-observable-recovery-task'
  },
  {
    scenario: 'claude-mcp-managed-selection-task',
    comparisonBaseline: 'claude-code',
    baselineFamily: 'mcp-managed-capability',
    sourceSuite: 'repo-real',
    sourceFamily: 'mcp-readiness-gated-task'
  },
  {
    scenario: 'anthropic-swebench-issue-resolution-task',
    comparisonBaseline: 'anthropic-swebench',
    baselineFamily: 'issue-resolution',
    sourceSuite: 'repo-real',
    sourceFamily: 'swebench-issue-resolution-task'
  },
  {
    scenario: 'opencode-build-plan-split-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'build-plan-agent-split',
    sourceSuite: 'repo-real',
    sourceFamily: 'plan-build-split-task'
  },
  {
    scenario: 'opencode-provider-variant-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'provider-model-variant-selection',
    sourceSuite: 'repo-real',
    sourceFamily: 'provider-variant-task'
  },
  {
    scenario: 'opencode-permission-gated-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'permission-allow-ask-deny',
    sourceSuite: 'repo-real',
    sourceFamily: 'permission-blocked-task'
  },
  {
    scenario: 'opencode-runtime-skill-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'runtime-skill-loading',
    sourceSuite: 'repo-real',
    sourceFamily: 'runtime-skill-integration-task'
  },
  {
    scenario: 'opencode-mcp-capability-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'mcp-server-capability',
    sourceSuite: 'repo-real',
    sourceFamily: 'mcp-readiness-gated-task'
  },
  {
    scenario: 'opencode-provider-readiness-task',
    comparisonBaseline: 'opencode',
    baselineFamily: 'provider-fallback-readiness',
    sourceSuite: 'general-complex',
    sourceFamily: 'provider-failure-streak-task'
  }
];

function normalizeDiagnostics(source: RepoRealTaskScenarioResult | TaskGeneralComplexScenarioResult): PublicCapabilityParityDiagnostics {
  return {
    workspaceDir: source.diagnostics.workspaceDir,
    artifactSnapshots: source.diagnostics.artifactSnapshots.map((snapshot) => ({
      path: snapshot.path,
      exists: snapshot.exists,
      excerpt: snapshot.excerpt
    }))
  };
}

function normalizeArtifactQuality(source: RepoRealTaskScenarioResult | TaskGeneralComplexScenarioResult): PublicCapabilityParityArtifactQuality {
  return {
    verdict: source.artifactQuality.verdict,
    failureCategory: source.artifactQuality.failureCategory,
    summary: source.artifactQuality.summary,
    files: [...source.artifactQuality.files]
  };
}

function findSourceScenario(
  mapping: PublicCapabilityMapping,
  repoReal: Awaited<ReturnType<typeof runRepoRealTaskSuite>>,
  generalComplex: Awaited<ReturnType<typeof runTaskGeneralComplexScenarioSuite>>
): RepoRealTaskScenarioResult | TaskGeneralComplexScenarioResult {
  const scenarios = mapping.sourceSuite === 'repo-real' ? repoReal.scenarios : generalComplex.scenarios;
  const found = scenarios.find((scenario) => scenario.family === mapping.sourceFamily);
  if (!found) {
    throw new Error(`Public capability parity mapping "${mapping.scenario}" could not find source family "${mapping.sourceFamily}" in ${mapping.sourceSuite}.`);
  }
  return found;
}

function createEmptyByFamily(): Record<PublicCapabilityParityFamily, number> {
  return {
    'claude-project-instructions-task': 0,
    'claude-custom-command-task': 0,
    'claude-subagent-review-task': 0,
    'claude-hook-recovery-task': 0,
    'claude-mcp-managed-selection-task': 0,
    'anthropic-swebench-issue-resolution-task': 0,
    'opencode-build-plan-split-task': 0,
    'opencode-provider-variant-task': 0,
    'opencode-permission-gated-task': 0,
    'opencode-runtime-skill-task': 0,
    'opencode-mcp-capability-task': 0,
    'opencode-provider-readiness-task': 0
  };
}

export async function runPublicCapabilityParitySuite(): Promise<PublicCapabilityParitySuiteResult> {
  const [repoReal, generalComplex] = await Promise.all([
    runRepoRealTaskSuite(),
    runTaskGeneralComplexScenarioSuite()
  ]);

  const scenarios = PARITY_MAPPINGS.map((mapping) => {
    const source = findSourceScenario(mapping, repoReal, generalComplex);
    return {
      scenario: mapping.scenario,
      comparisonBaseline: mapping.comparisonBaseline,
      baselineFamily: mapping.baselineFamily,
      sourceSuite: mapping.sourceSuite,
      sourceScenario: source.scenario,
      sourceFamily: source.family,
      passed: source.passed,
      finalLifecycleStatus: source.finalLifecycleStatus,
      issueCategory: source.issueCategory,
      issueSummary: source.issueSummary,
      missingRequiredEventTypes: [...source.missingRequiredEventTypes],
      observedHooks: [...source.observedHooks],
      executionSummary: source.executionSummary,
      artifactQuality: normalizeArtifactQuality(source),
      diagnostics: normalizeDiagnostics(source)
    } satisfies PublicCapabilityParityScenarioResult;
  });

  let passed = 0;
  let failed = 0;
  const byFailureCategory: Record<string, number> = {};
  const byFamily = createEmptyByFamily();
  const byBaseline: Record<PublicCapabilityBaseline, number> = {
    'claude-code': 0,
    opencode: 0,
    'anthropic-swebench': 0
  };

  for (const scenario of scenarios) {
    byFamily[scenario.scenario] += 1;
    byBaseline[scenario.comparisonBaseline] += 1;
    if (scenario.passed && scenario.artifactQuality.verdict === 'passed') {
      passed += 1;
    } else {
      failed += 1;
    }
    if (scenario.artifactQuality.failureCategory) {
      byFailureCategory[scenario.artifactQuality.failureCategory] = (byFailureCategory[scenario.artifactQuality.failureCategory] ?? 0) + 1;
    }
    if (`${scenario.issueCategory ?? ''}` === 'unknown') {
      byFailureCategory.unknown = (byFailureCategory.unknown ?? 0) + 1;
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
      byBaseline,
      byFamily,
      byFailureCategory
    }
  };
}
