import {
  runRuntimeBenchmarkSuite,
  runTaskWorkflowScenarioSuite
} from '../application/benchmark';

function formatScenarioLine(result: Awaited<ReturnType<typeof runTaskWorkflowScenarioSuite>>['scenarios'][number]): string {
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
    `continues=${result.metrics.continueCount}`,
    `fallbacks=${result.metrics.plannerFallbackCount}`
  ].join(', ');
}

async function main(): Promise<void> {
  const workflowOnly = process.argv.includes('--workflow-only');
  const benchmark = workflowOnly ? undefined : await runRuntimeBenchmarkSuite();
  const report = await runTaskWorkflowScenarioSuite(benchmark);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      benchmark: workflowOnly ? null : benchmark,
      workflow: report
    }, null, 2));
    return;
  }

  const lines = [
    'workflow scenarios:',
    ...report.scenarios.map((scenario) => `- ${formatScenarioLine(scenario)}`),
    '',
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}`,
    `recommendation: ${report.recommendation.priority} (${report.recommendation.rationale})`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
