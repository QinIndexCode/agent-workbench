import { runTaskFlagshipScenarioSuite } from '../application/benchmark';

function formatScenarioLine(result: Awaited<ReturnType<typeof runTaskFlagshipScenarioSuite>>['scenarios'][number]): string {
  return [
    `${result.scenario}: passed=${result.passed}`,
    `lifecycle=${result.finalLifecycleStatus}`,
    `queue=${result.finalQueueState ?? 'none'}`,
    `issue=${result.issueCategory ?? 'none'}`,
    `calls=${result.metrics.apiCallCount}`,
    `toolBatches=${result.metrics.executedToolBatchCount}`,
    `tools=${result.metrics.toolInvocationCount}`,
    `toolsPerBatch=${result.metrics.averageToolInvocationsPerBatch}`,
    `approvals=${result.metrics.approvalCount}`,
    `recoveries=${result.metrics.recoveryCount}`,
    `fallbacks=${result.metrics.plannerFallbackCount}`
  ].join(', ');
}

async function main(): Promise<void> {
  const report = await runTaskFlagshipScenarioSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'flagship scenarios:',
    ...report.scenarios.map((scenario) => `- ${formatScenarioLine(scenario)}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}`,
    `averages: apiCalls=${report.totals.averageApiCallCount}, executedToolBatches=${report.totals.averageExecutedToolBatchCount}, toolsPerBatch=${report.totals.averageToolInvocationsPerBatch}, continueCount=${report.totals.averageContinueCount}, recoveryCount=${report.totals.averageRecoveryCount}`,
    `callCountTargetsSatisfied=${report.totals.callCountTargetsSatisfied}, plannerFallbackScenarioCount=${report.totals.plannerFallbackScenarioCount}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
