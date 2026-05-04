import fs from 'node:fs/promises';
import path from 'node:path';
import { runPracticalLiveTaskAcceptanceSuite } from '../application/benchmark';

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function resolveReportPath(): string {
  const profile = process.env.SCORECARD_PROFILE?.trim() || 'default';
  const fileName = profile === 'default'
    ? 'practical-live-task-acceptance.json'
    : `practical-live-task-acceptance.${profile}.json`;
  return path.resolve(resolveRepoRoot(), '.codex-run', 'logs', fileName);
}

async function main(): Promise<void> {
  const report = await runPracticalLiveTaskAcceptanceSuite();
  const reportPath = resolveReportPath();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'practical live task acceptance scenarios:',
    ...report.scenarios.map((scenario) => `- ${scenario.scenario}: passed=${scenario.passed}, shipReady=${scenario.shipReady}, criticalGaps=${scenario.criticalGapsCount}, minorEdits=${scenario.minorEditsNeededCount}, clarificationMode=${scenario.clarificationMode}, assumptions=${scenario.assumptionDisclosure.status}, artifact=${scenario.artifactEvidence.verdict}, usageSource=${scenario.metrics.usageSource}, tokens=${scenario.metrics.totalTokens}`),
    '',
    `status=${report.status}, externalBlocker=${report.externalBlocker ?? 'none'}`,
    `provider=${report.provider?.providerId ?? 'none'} model=${report.provider?.model ?? 'none'}`,
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}, artifactEvidencePassRate=${report.totals.artifactEvidencePassRate}, shipReadyPassRate=${report.totals.shipReadyPassRate}, criticalGaps=${report.totals.criticalGapsCount}, liveProviderPassRate=${report.totals.liveProviderPassRate}`,
    `usage: apiCalls=${report.totals.totalApiCalls}, promptTokens=${report.totals.totalPromptTokens}, completionTokens=${report.totals.totalCompletionTokens}, totalTokens=${report.totals.totalTokens}, returnedCalls=${report.totals.usageBreakdown.returnedCalls}, estimatedCalls=${report.totals.usageBreakdown.estimatedCalls}, missingCalls=${report.totals.usageBreakdown.missingCalls}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
