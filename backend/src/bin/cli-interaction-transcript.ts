import { runCliInteractionTranscriptSuite } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runCliInteractionTranscriptSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'cli interaction transcript:',
    ...report.scenarios.map((scenario) => `- ${scenario.family}: passed=${scenario.passed}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}`
  ];
  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
