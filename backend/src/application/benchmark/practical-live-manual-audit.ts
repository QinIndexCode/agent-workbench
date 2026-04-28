import fs from 'node:fs';
import {
  PracticalLiveTaskAcceptanceSuiteResult,
  PracticalTaskScenarioResult,
  runPracticalLiveTaskAcceptanceSuite
} from './practical-task-acceptance';

export interface PracticalLiveManualAuditEntry {
  scenario: PracticalTaskScenarioResult['scenario'];
  verdict: 'passed' | 'failed';
  shipReady: boolean;
  artifactPaths: string[];
  minorEditsNeeded: string[];
  criticalGaps: string[];
  summary: string;
  evidence: string[];
  findings: string[];
}

export interface PracticalLiveManualAuditReport {
  generatedAt: number;
  profile: string;
  status: 'achieved' | 'open_gap' | 'external_blocker';
  sourceStatus: PracticalLiveTaskAcceptanceSuiteResult['status'];
  sourceTotals: {
    total: number;
    passed: number;
    failed: number;
  };
  provider: {
    providerId: string;
    model: string;
  } | null;
  externalBlocker: string | null;
  entries: PracticalLiveManualAuditEntry[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    shipReadyPassRate: number;
    minorEditsNeededCount: number;
    criticalGapsCount: number;
  };
}

function artifactEvidenceForScenario(scenario: PracticalTaskScenarioResult): string[] {
  return scenario.diagnostics.artifactSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => {
      const fullArtifact = snapshot.persistedPath
        ? readPersistedArtifact(snapshot.persistedPath)
        : null;
      return `${snapshot.path}: ${fullArtifact ?? snapshot.excerpt ?? '(no excerpt)'}`;
    });
}

function artifactPathsForScenario(scenario: PracticalTaskScenarioResult): string[] {
  return scenario.diagnostics.artifactSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => snapshot.persistedPath ?? snapshot.path);
}

function readPersistedArtifact(targetPath: string): string | null {
  try {
    return fs.readFileSync(targetPath, 'utf8').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

function auditScenario(scenario: PracticalTaskScenarioResult): PracticalLiveManualAuditEntry {
  const findings: string[] = [];
  const minorEditsNeeded: string[] = [];
  const criticalGaps: string[] = [];
  const evidence = artifactEvidenceForScenario(scenario);

  if (!scenario.passed) {
    criticalGaps.push(`Scenario status is not passed (${scenario.issueCategory ?? 'no_issue_category'}).`);
  }
  if (scenario.artifactQuality.verdict !== 'passed') {
    criticalGaps.push(`Artifact quality verdict is ${scenario.artifactQuality.verdict}.`);
  }
  if (scenario.finalLifecycleStatus !== 'COMPLETED') {
    criticalGaps.push(`Lifecycle ended in ${scenario.finalLifecycleStatus} instead of COMPLETED.`);
  }
  if (scenario.executionSummary.queueRuntimeAlignment.consistent !== true) {
    criticalGaps.push('Queue/runtime alignment is not consistent.');
  }
  if (`${scenario.issueCategory ?? ''}` === 'unknown') {
    criticalGaps.push('Scenario reported unknown issue category.');
  }
  if (evidence.length === 0) {
    criticalGaps.push('No artifact evidence snapshot was captured.');
  }

  switch (scenario.scenario) {
    case 'vague-blog-request':
      if (scenario.clarificationMode !== 'assumption-led') {
        criticalGaps.push('Vague blog request did not use assumption-led handling.');
      }
      if (scenario.assumptionDisclosure.status !== 'declared') {
        criticalGaps.push('Vague blog request did not explicitly declare assumptions.');
      }
      if (!evidence.some((entry) => /Assumptions/i.test(entry))) {
        minorEditsNeeded.push('Make the assumptions section more visible to the reader.');
      }
      break;
    case 'vague-summary-request':
      if (scenario.clarificationMode !== 'required') {
        criticalGaps.push('Vague summary request did not choose clarification-first behavior.');
      }
      if (!evidence.some((entry) => /missing information|questions|clarif/i.test(entry))) {
        criticalGaps.push('Clarification artifact does not clearly explain the missing information and next questions.');
      }
      break;
    case 'explicit-blog-request':
      if (!evidence.some((entry) => /Conclusion|Takeaways|CTO|engineering/i.test(entry))) {
        minorEditsNeeded.push('Sharpen the audience-specific framing and closing section.');
      }
      break;
    case 'explicit-doc-request':
      if (!evidence.some((entry) => /Checklist|queueReady|heartbeat|release/i.test(entry))) {
        criticalGaps.push('Explicit doc artifact is missing concrete operational checklist language.');
      }
      break;
    case 'operator-report-task':
      if (!evidence.some((entry) => /Recommended Actions|destination path|MCP/i.test(entry))) {
        criticalGaps.push('Operator report does not surface actionable next steps strongly enough.');
      }
      break;
    case 'analysis-brief-task':
      if (!evidence.some((entry) => /Conclusion|Risks|Recommendation/i.test(entry))) {
        criticalGaps.push('Analysis brief does not visibly contain conclusion, risks, and recommendation sections.');
      }
      break;
    case 'practical-engineering-change-task':
      if (!evidence.some((entry) => /task-progress\.patch|missing-provider-secret|required-mcp-missing/i.test(entry))) {
        criticalGaps.push('Engineering change bundle does not show a concrete repo-grounded patch with the expected blocker fix.');
      }
      break;
    case 'practical-review-task':
      if (!evidence.some((entry) => /\[P\d\]|utils\.ts|Residual Risk/i.test(entry))) {
        criticalGaps.push('Review artifact does not look finding-first or repo-specific enough.');
      }
      break;
    case 'vague-landing-page-brief':
      if (scenario.clarificationMode !== 'assumption-led' || scenario.assumptionDisclosure.status !== 'declared') {
        criticalGaps.push('Vague landing-page brief did not use explicit assumption-led handling.');
      }
      if (!evidence.some((entry) => /## Assumptions|## Hero|## CTA/i.test(entry))) {
        criticalGaps.push('Landing-page brief does not look publish-ready enough.');
      }
      break;
    case 'explicit-multi-artifact-doc-bundle':
      if (!evidence.some((entry) => /launch-plan\.md/i.test(entry)) || !evidence.some((entry) => /launch-faq\.md/i.test(entry))) {
        criticalGaps.push('Multi-artifact doc bundle is missing one of the persisted deliverables.');
      }
      if (!evidence.some((entry) => /## Scope|## Audience FAQ/i.test(entry))) {
        criticalGaps.push('Multi-artifact doc bundle does not preserve the requested structure.');
      }
      break;
    case 'engineering-decision-record-task':
      if (!evidence.some((entry) => /## Decision|## Tradeoffs|## Recommendation/i.test(entry))) {
        criticalGaps.push('Engineering decision record does not visibly contain decision, tradeoffs, and recommendation.');
      }
      break;
    case 'repo-grounded-review-followup-task':
      if (!evidence.some((entry) => /http-utils-followup\.patch|backend\/src\/interfaces\/http\/utils\.ts|trusted local origins/i.test(entry))) {
        criticalGaps.push('Repo-grounded follow-up artifact is not concrete enough.');
      }
      break;
    default:
      break;
  }

  findings.push(...criticalGaps, ...minorEditsNeeded);
  const passed = criticalGaps.length === 0;
  return {
    scenario: scenario.scenario,
    verdict: passed ? 'passed' : 'failed',
    shipReady: passed,
    artifactPaths: artifactPathsForScenario(scenario),
    minorEditsNeeded,
    criticalGaps,
    summary: passed
      ? 'Artifact is ship-ready with minor edits, and the live-model handling matches the practical-task rubric.'
      : criticalGaps[0],
    evidence,
    findings
  };
}

export async function runPracticalLiveManualAudit(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sourceReport?: PracticalLiveTaskAcceptanceSuiteResult;
} = {}): Promise<PracticalLiveManualAuditReport> {
  const env = options.env ?? process.env;
  const practical = options.sourceReport ?? await runPracticalLiveTaskAcceptanceSuite(options);
  const profile = practical.profile?.trim?.() || env.SCORECARD_PROFILE?.trim() || 'default';
  if (practical.status === 'external_blocker') {
    return {
      generatedAt: Date.now(),
      profile,
      status: 'external_blocker',
      sourceStatus: 'external_blocker',
      sourceTotals: {
        total: practical.totals.total,
        passed: practical.totals.passed,
        failed: practical.totals.failed
      },
      provider: practical.provider
        ? {
          providerId: practical.provider.providerId,
          model: practical.provider.model
        }
        : null,
      externalBlocker: practical.externalBlocker,
      entries: [],
      totals: {
        total: 0,
        passed: 0,
        failed: 0,
        shipReadyPassRate: 0,
        minorEditsNeededCount: 0,
        criticalGapsCount: 0
      }
    };
  }

  const entries = practical.scenarios.map((scenario) => auditScenario(scenario));
  const passed = entries.filter((entry) => entry.verdict === 'passed').length;
  const failed = entries.length - passed;
  const shipReadyCount = entries.filter((entry) => entry.shipReady).length;
  const minorEditsNeededCount = entries.reduce((total, entry) => total + entry.minorEditsNeeded.length, 0);
  const criticalGapsCount = entries.reduce((total, entry) => total + entry.criticalGaps.length, 0);
  return {
    generatedAt: Date.now(),
    profile,
    status: failed === 0 && practical.status === 'achieved' ? 'achieved' : 'open_gap',
    sourceStatus: practical.status,
    sourceTotals: {
      total: practical.totals.total,
      passed: practical.totals.passed,
      failed: practical.totals.failed
    },
    provider: practical.provider
      ? {
        providerId: practical.provider.providerId,
        model: practical.provider.model
      }
      : null,
    externalBlocker: practical.externalBlocker,
    entries,
    totals: {
      total: entries.length,
      passed,
      failed,
      shipReadyPassRate: Number((shipReadyCount / Math.max(1, entries.length)).toFixed(4)),
      minorEditsNeededCount,
      criticalGapsCount
    }
  };
}
