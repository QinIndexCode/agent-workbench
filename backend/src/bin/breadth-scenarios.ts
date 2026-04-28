import { runTaskBreadthScenarioSuite } from '../application/benchmark';

function formatScenarioLine(result: Awaited<ReturnType<typeof runTaskBreadthScenarioSuite>>['scenarios'][number]): string {
  return [
    `${result.scenario}: passed=${result.passed}`,
    `category=${result.category}`,
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
  const report = await runTaskBreadthScenarioSuite();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'breadth scenarios:',
    ...report.scenarios.map((scenario) => `- ${formatScenarioLine(scenario)}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, successRate=${report.totals.successRate}`,
    `averages: apiCalls=${report.totals.averageApiCallCount}, plannerFallbackRate=${report.totals.averagePlannerFallbackRate}, recoveryCount=${report.totals.averageRecoveryCount}, approvalBlockedBatchRate=${report.totals.averageApprovalBlockedBatchRate}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
