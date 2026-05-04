import {
  PracticalTaskAcceptanceSuiteResult,
  PracticalTaskScenarioResult,
  runPracticalTaskAcceptanceSuite
} from './practical-task-acceptance';

export interface PracticalManualAuditEntry {
  scenario: PracticalTaskScenarioResult['scenario'];
  verdict: 'passed' | 'failed';
  summary: string;
  evidence: string[];
  findings: string[];
}

export interface PracticalManualAuditReport {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  sourceStatus: PracticalTaskAcceptanceSuiteResult['status'];
  sourceTotals: PracticalTaskAcceptanceSuiteResult['totals'];
  entries: PracticalManualAuditEntry[];
  totals: {
    total: number;
    passed: number;
    failed: number;
  };
}

function artifactEvidenceForScenario(scenario: PracticalTaskScenarioResult): string[] {
  return scenario.diagnostics.artifactSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => `${snapshot.path}: ${snapshot.excerpt ?? '(no excerpt)'}`);
}

function auditScenario(scenario: PracticalTaskScenarioResult): PracticalManualAuditEntry {
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

  switch (scenario.scenario) {
    case 'vague-blog-request':
      if (scenario.clarificationMode !== 'assumption-led') {
        findings.push('Vague blog request did not use the expected assumption-led mode.');
      }
      if (scenario.assumptionDisclosure.status !== 'declared') {
        findings.push('Vague blog request did not explicitly declare assumptions.');
      }
      break;
    case 'vague-summary-request':
      if (scenario.clarificationMode !== 'required') {
        findings.push('Vague summary request did not choose clarification-first behavior.');
      }
      if (!evidence.some((entry) => /缺失信息|确认的问题|下一步建议/i.test(entry))) {
        findings.push('Clarification artifact does not show missing information and next questions clearly enough.');
      }
      break;
    case 'explicit-blog-request':
      if (!evidence.some((entry) => /CTO|三个实践建议|结尾/i.test(entry))) {
        findings.push('Explicit blog request does not appear ship-ready for the requested audience and structure.');
      }
      break;
    case 'explicit-doc-request':
      if (!evidence.some((entry) => /发布前|发布后|heartbeat|queueReady=true/i.test(entry))) {
        findings.push('Explicit doc artifact is missing concrete operational checklist language.');
      }
      break;
    case 'operator-report-task':
      if (!evidence.some((entry) => /Recommended Actions|destination path|MCP/i.test(entry))) {
        findings.push('Operator report does not surface actionable next steps strongly enough.');
      }
      break;
    case 'analysis-brief-task':
      if (!evidence.some((entry) => /Conclusion|Risks|Recommendation/i.test(entry))) {
        findings.push('Analysis brief does not visibly contain conclusion, risks, and recommendation sections.');
      }
      break;
    case 'practical-engineering-change-task':
      if (!evidence.some((entry) => /task-progress\.patch|missing-provider-secret|required-mcp-missing/i.test(entry))) {
        findings.push('Engineering change bundle does not show a concrete repo-grounded patch with the expected blocker fix.');
      }
      break;
    case 'practical-review-task':
      if (!evidence.some((entry) => /\[P2\]|utils\.ts|Residual Risk/i.test(entry))) {
        findings.push('Review artifact does not look finding-first or repo-specific enough.');
      }
      break;
    case 'vague-landing-page-brief':
      if (scenario.clarificationMode !== 'assumption-led' || scenario.assumptionDisclosure.status !== 'declared') {
        findings.push('Vague landing-page brief did not use explicit assumption-led handling.');
      }
      if (!evidence.some((entry) => /Assumptions|Hero|CTA/i.test(entry))) {
        findings.push('Landing-page brief does not preserve the expected publish-ready structure.');
      }
      break;
    case 'explicit-multi-artifact-doc-bundle':
      if (!evidence.some((entry) => /launch-plan\.md/i.test(entry)) || !evidence.some((entry) => /launch-faq\.md/i.test(entry))) {
        findings.push('Multi-artifact bundle did not preserve both deliverables.');
      }
      break;
    case 'engineering-decision-record-task':
      if (!evidence.some((entry) => /Decision|Tradeoffs|Recommendation/i.test(entry))) {
        findings.push('Engineering decision record is missing decision/tradeoff/recommendation structure.');
      }
      break;
    case 'repo-grounded-review-followup-task':
      if (!evidence.some((entry) => /http-utils-followup\.patch|utils\.ts|trusted local origins/i.test(entry))) {
        findings.push('Repo-grounded follow-up artifact is not concrete enough.');
      }
      break;
    default:
      break;
  }

  return {
    scenario: scenario.scenario,
    verdict: findings.length === 0 ? 'passed' : 'failed',
    summary: findings.length === 0
      ? 'Artifact is ship-ready with minor edits, and the task handling mode matches the practical-task rubric.'
      : findings[0],
    evidence,
    findings
  };
}

export function renderPracticalManualAuditMarkdown(report: PracticalManualAuditReport): string {
  const lines = [
    '# Practical Manual Audit',
    '',
    `- Status: ${report.status}`,
    `- Source status: ${report.sourceStatus}`,
    `- Pass rate: ${report.totals.passed}/${report.totals.total}`,
    '- Bar: Ship-Ready With Minor Edits',
    ''
  ];

  for (const entry of report.entries) {
    lines.push(`## ${entry.scenario}`);
    lines.push('');
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

export async function runPracticalManualAudit(): Promise<PracticalManualAuditReport> {
  const practical = await runPracticalTaskAcceptanceSuite();
  const entries = practical.scenarios.map((scenario) => auditScenario(scenario));
  const passed = entries.filter((entry) => entry.verdict === 'passed').length;
  const failed = entries.length - passed;

  return {
    generatedAt: Date.now(),
    status: failed === 0 && practical.status === 'achieved' ? 'achieved' : 'open_gap',
    sourceStatus: practical.status,
    sourceTotals: practical.totals,
    entries,
    totals: {
      total: entries.length,
      passed,
      failed
    }
  };
}
