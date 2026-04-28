import { runEcommerceDeliverySuite } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runEcommerceDeliverySuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'ecommerce delivery scenarios:',
    ...report.scenarios.map((scenario) => `- ${scenario.family}: passed=${scenario.passed}, artifact=${scenario.artifactQuality.verdict}, manual=${scenario.manualAudit.verdict}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`,
    `manualAudit: ${report.manualAudit.passed}/${report.manualAudit.total}`,
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
