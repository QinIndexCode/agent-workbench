import { runPublicCapabilityParitySuite } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runPublicCapabilityParitySuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'public capability parity scenarios:',
    ...report.scenarios.map((scenario) => `- ${scenario.scenario}: baseline=${scenario.comparisonBaseline}, family=${scenario.baselineFamily}, passed=${scenario.passed}, source=${scenario.sourceSuite}/${scenario.sourceFamily}, artifact=${scenario.artifactQuality.verdict}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
