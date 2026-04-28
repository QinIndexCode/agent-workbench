import { runRepoRealTaskSuite } from '../application/benchmark';

function formatScenarioLine(result: Awaited<ReturnType<typeof runRepoRealTaskSuite>>['scenarios'][number]): string {
  return [
    `${result.scenario}: passed=${result.passed}`,
    `family=${result.family}`,
    `lifecycle=${result.finalLifecycleStatus}`,
    `queue=${result.finalQueueState ?? 'none'}`,
    `issue=${result.issueCategory ?? 'none'}`,
    `artifact=${result.artifactQuality.verdict}`,
    `calls=${result.metrics.apiCallCount}`,
    `toolBatches=${result.metrics.executedToolBatchCount}`,
    `tools=${result.metrics.toolInvocationCount}`
  ].join(', ');
}

async function main(): Promise<void> {
  const report = await runRepoRealTaskSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'repo real task scenarios:',
    ...report.scenarios.map((scenario) => `- ${formatScenarioLine(scenario)}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
