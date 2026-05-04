import { runPublicCapabilityParitySuite, PublicCapabilityParityScenarioResult, PublicCapabilityParitySuiteResult } from './public-capability-parity';

export interface ManualArtifactAuditEntry {
  scenario: string;
  comparisonBaseline: PublicCapabilityParityScenarioResult['comparisonBaseline'];
  baselineFamily: string;
  sourceSuite: PublicCapabilityParityScenarioResult['sourceSuite'];
  sourceScenario: string;
  verdict: 'passed' | 'failed';
  summary: string;
  evidence: string[];
  findings: string[];
}

export interface ManualArtifactAuditReport {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  sourceStatus: PublicCapabilityParitySuiteResult['status'];
  sourceTotals: PublicCapabilityParitySuiteResult['totals'];
  entries: ManualArtifactAuditEntry[];
  totals: {
    total: number;
    passed: number;
    failed: number;
  };
}

function artifactEvidenceForScenario(scenario: PublicCapabilityParityScenarioResult): string[] {
  return scenario.diagnostics.artifactSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => `${snapshot.path}: ${snapshot.excerpt ?? '(no excerpt)'}`);
}

function auditScenario(scenario: PublicCapabilityParityScenarioResult): ManualArtifactAuditEntry {
  const findings: string[] = [];
  const evidence = artifactEvidenceForScenario(scenario);

  if (!scenario.passed) {
    findings.push(`Scenario status is not passed (${scenario.issueCategory ?? 'no_issue_category'}).`);
  }
  if (scenario.artifactEvidence.verdict !== 'passed') {
    findings.push(`Artifact evidence verdict is ${scenario.artifactEvidence.verdict}.`);
  }
  if (scenario.finalLifecycleStatus !== 'COMPLETED') {
    findings.push(`Lifecycle ended in ${scenario.finalLifecycleStatus} instead of COMPLETED.`);
  }
  if (scenario.executionSummary.queueRuntimeAlignment.consistent !== true) {
    findings.push('Queue/runtime alignment is not consistent.');
  }
  if (`${scenario.issueCategory ?? ''}` === 'unknown') {
    findings.push('Scenario reported unknown issue category.');
  }
  if (evidence.length === 0) {
    findings.push('No artifact evidence snapshot was captured.');
  }

  switch (scenario.baselineFamily) {
    case 'project-instructions':
      if ((scenario.executionSummary.ruleSummary.matchedRuleNames.length + scenario.executionSummary.ruleSummary.pathMatchedRuleNames.length) < 1
        && (scenario.executionSummary.eventCounts.WORKSPACE_INSTRUCTIONS_LOADED ?? 0) < 1) {
        findings.push('Project instructions and rule evidence are not visible in the execution summary.');
      }
      break;
    case 'custom-command':
      if (!evidence.some((entry) => /ship-check|release candidate|command/i.test(entry))) {
        findings.push('Workspace command evidence is missing from the artifact snapshots.');
      }
      break;
    case 'subagent-specialized-review':
      if (!scenario.executionSummary.agentSummary.selectedAgent) {
        findings.push('Selected subagent profile is not visible in the execution summary.');
      }
      break;
    case 'hook-observable-recovery':
      if ((scenario.executionSummary.hookSummary.executedCount + scenario.executionSummary.hookSummary.failedCount) < 1) {
        findings.push('Hook execution or failure evidence is not visible.');
      }
      if (scenario.executionSummary.mcpSummary.recent[0]?.status !== 'FAILED') {
        findings.push('The expected MCP failure evidence is missing from the recent MCP summary.');
      }
      break;
    case 'mcp-managed-capability':
    case 'mcp-server-capability':
      if (scenario.executionSummary.mcpSummary.selectedTools.length < 1) {
        findings.push('Selected MCP tools are not visible.');
      }
      if (
        scenario.executionSummary.mcpSummary.selectedResources.length < 1
        && scenario.executionSummary.mcpSummary.selectedPrompts.length < 1
      ) {
        findings.push('Selected MCP resources/prompts are not visible.');
      }
      break;
    case 'issue-resolution':
      if (!evidence.some((entry) => /issue-resolution\.patch/i.test(entry))) {
        findings.push('Issue-resolution patch evidence is missing.');
      }
      if (!evidence.some((entry) => /missing-provider-secret|required-mcp-missing/i.test(entry))) {
        findings.push('Issue-resolution evidence does not mention the expected blocker-ordering fix.');
      }
      break;
    case 'build-plan-agent-split':
      if (scenario.executionSummary.stageDurations.length < 3 || scenario.executionSummary.turnCount < 3) {
        findings.push('Planner/build split evidence is missing multi-stage runtime facts.');
      }
      if (!evidence.some((entry) => /planning file|build file|separation/i.test(entry))) {
        findings.push('Plan/build artifact snapshots do not show explicit split rationale.');
      }
      break;
    case 'provider-model-variant-selection':
      if (!scenario.executionSummary.providerSummary.providerId || !scenario.executionSummary.providerSummary.modelId || !scenario.executionSummary.providerSummary.variantId) {
        findings.push('Provider/model/variant selection facts are incomplete.');
      }
      break;
    case 'permission-allow-ask-deny':
      if (scenario.executionSummary.permissionSummary.approvalRequiredCount < 1 && scenario.executionSummary.permissionSummary.deniedCount < 1) {
        findings.push('Permission gating evidence is missing.');
      }
      break;
    case 'runtime-skill-loading':
      if (scenario.executionSummary.skillSummary.invokedCount < 1 || scenario.executionSummary.skillSummary.recent[0]?.status !== 'SUCCEEDED') {
        findings.push('Runtime skill invocation evidence is missing or failed.');
      }
      break;
    case 'provider-fallback-readiness':
      if (scenario.executionSummary.providerFailureStreak < 1 && !scenario.executionSummary.conservativeModeReason) {
        findings.push('Provider readiness/fallback evidence is not visible.');
      }
      break;
    default:
      break;
  }

  return {
    scenario: scenario.scenario,
    comparisonBaseline: scenario.comparisonBaseline,
    baselineFamily: scenario.baselineFamily,
    sourceSuite: scenario.sourceSuite,
    sourceScenario: scenario.sourceScenario,
    verdict: findings.length === 0 ? 'passed' : 'failed',
    summary: findings.length === 0
      ? 'Artifact bundle, summary state, and capability evidence passed the manual audit rubric.'
      : findings[0],
    evidence,
    findings
  };
}

export function renderManualArtifactAuditMarkdown(report: ManualArtifactAuditReport): string {
  const lines = [
    '# Manual Artifact Audit',
    '',
    `- Status: ${report.status}`,
    `- Source status: ${report.sourceStatus}`,
    `- Pass rate: ${report.totals.passed}/${report.totals.total}`,
    ''
  ];

  for (const entry of report.entries) {
    lines.push(`## ${entry.scenario}`);
    lines.push('');
    lines.push(`- Baseline: ${entry.comparisonBaseline}`);
    lines.push(`- Family: ${entry.baselineFamily}`);
    lines.push(`- Source: ${entry.sourceSuite} / ${entry.sourceScenario}`);
    lines.push(`- Verdict: ${entry.verdict}`);
    lines.push(`- Summary: ${entry.summary}`);
    if (entry.findings.length > 0) {
      lines.push(`- Findings: ${entry.findings.join(' | ')}`);
    }
    if (entry.evidence.length > 0) {
      lines.push('- Evidence:');
      for (const evidence of entry.evidence) {
        lines.push(`  - ${evidence}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function runManualArtifactAudit(): Promise<ManualArtifactAuditReport> {
  const parity = await runPublicCapabilityParitySuite();
  const entries = parity.scenarios.map((scenario) => auditScenario(scenario));
  const passed = entries.filter((entry) => entry.verdict === 'passed').length;
  const failed = entries.length - passed;

  return {
    generatedAt: Date.now(),
    status: failed === 0 && parity.status === 'achieved' ? 'achieved' : 'open_gap',
    sourceStatus: parity.status,
    sourceTotals: parity.totals,
    entries,
    totals: {
      total: entries.length,
      passed,
      failed
    }
  };
}
