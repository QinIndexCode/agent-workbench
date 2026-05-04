import { runPracticalTaskAcceptanceSuite } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runPracticalTaskAcceptanceSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'practical task acceptance scenarios:',
    ...report.scenarios.map((scenario) => `- ${scenario.scenario}: passed=${scenario.passed}, clarificationMode=${scenario.clarificationMode}, assumptions=${scenario.assumptionDisclosure.status}, artifact=${scenario.artifactEvidence.verdict}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}, artifactEvidencePassRate=${report.totals.artifactEvidencePassRate}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
