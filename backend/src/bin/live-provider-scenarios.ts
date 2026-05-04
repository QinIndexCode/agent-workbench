import { runTaskLiveProviderScenarioSuite } from '../application/benchmark';

function formatScenarioLine(result: Awaited<ReturnType<typeof runTaskLiveProviderScenarioSuite>>['scenarios'][number]): string {
  return [
    `${result.scenario}: passed=${result.passed}`,
    `verdict=${result.artifactEvidence.verdict}`,
    `family=${result.family}`,
    `lifecycle=${result.finalLifecycleStatus ?? 'none'}`,
    `queue=${result.finalQueueState ?? 'none'}`,
    `provider=${result.provider?.providerId ?? 'none'}`,
    `calls=${result.metrics.apiCallCount}`,
    `toolBatches=${result.metrics.executedToolBatchCount}`,
    `evidence=${result.artifactEvidence.summary}`
  ].join(', ');
}

async function main(): Promise<void> {
  const report = await runTaskLiveProviderScenarioSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'live-provider scenarios:',
    ...report.scenarios.map((scenario) => `- ${formatScenarioLine(scenario)}`),
    '',
    `status=${report.status}, externalBlocker=${report.externalBlocker ?? 'none'}`,
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, externalBlocked=${report.totals.externalBlocked}, total=${report.totals.total}`,
    `rates: artifactEvidencePassRate=${report.totals.artifactEvidencePassRate}, liveProviderPassRate=${report.totals.liveProviderPassRate}`,
    `usage: apiCalls=${report.totals.totalApiCalls}, promptTokens=${report.totals.totalPromptTokens}, completionTokens=${report.totals.totalCompletionTokens}, totalTokens=${report.totals.totalTokens}, usageSources=${JSON.stringify(report.totals.usageSourceCounts)}`,
    `averages: apiCalls=${report.totals.averageApiCallCount}, executedToolBatches=${report.totals.averageExecutedToolBatchCount}, toolsPerBatch=${report.totals.averageToolInvocationsPerBatch}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
