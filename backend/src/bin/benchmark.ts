import fs from 'node:fs/promises';
import path from 'node:path';
import { runRuntimeBenchmarkSuite } from '../application/benchmark';

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function resolveReportPath(): string {
  const profile = process.env.SCORECARD_PROFILE?.trim() || 'default';
  const fileName = profile === 'default'
    ? 'benchmark.json'
    : `benchmark.${profile}.json`;
  return path.resolve(resolveRepoRoot(), '.codex-run', 'logs', fileName);
}

function formatScenarioReport(label: string, report: Awaited<ReturnType<typeof runRuntimeBenchmarkSuite>>['syntheticBaseline']): string[] {
  return [
    `${label}: ${report.scenario}`,
    `Planner primary: calls=${report.plannerPrimary.apiCallCount}, totalTokens=${report.plannerPrimary.totalTokens}, latencyMs=${report.plannerPrimary.latencyMs}, stages=${report.plannerPrimary.stageCount}, batches=${report.plannerPrimary.batchCount}, plannedToolBatches=${report.plannerPrimary.plannedToolBatchCount}, tools=${report.plannerPrimary.toolInvocationCount}, toolsPerBatch=${report.plannerPrimary.averageToolInvocationsPerBatch}, fallbacks=${report.plannerPrimary.fallbackCount}`,
    `Single-active baseline: calls=${report.singleActiveBaseline.apiCallCount}, totalTokens=${report.singleActiveBaseline.totalTokens}, latencyMs=${report.singleActiveBaseline.latencyMs}, stages=${report.singleActiveBaseline.stageCount}, batches=${report.singleActiveBaseline.batchCount}, plannedToolBatches=${report.singleActiveBaseline.plannedToolBatchCount}, tools=${report.singleActiveBaseline.toolInvocationCount}, toolsPerBatch=${report.singleActiveBaseline.averageToolInvocationsPerBatch}, fallbacks=${report.singleActiveBaseline.fallbackCount}`,
    `Deltas: callReduction=${report.deltas.apiCallReductionRatio}, tokenReduction=${report.deltas.tokenReductionRatio}, latencyReduction=${report.deltas.latencyReductionRatio}`,
    `Token analysis: plannerSection=${report.tokenAnalysis.dominantPlannerSection}, baselineSection=${report.tokenAnalysis.dominantBaselineSection}, historyReduction=${report.tokenAnalysis.historyReductionRatio}, sectionReduction=${report.tokenAnalysis.sectionReductionRatio}, bottleneck=${report.tokenAnalysis.likelyBottleneck}, gapToTarget=${report.tokenAnalysis.reductionGap}`,
    `Objectives: callRange=${report.objectives.plannerCallRangeSatisfied}, tokenTarget=${report.objectives.tokenReductionTargetSatisfied}, fallbackGuard=${report.objectives.fallbackGuardSatisfied}`
  ];
}

function formatReport(report: Awaited<ReturnType<typeof runRuntimeBenchmarkSuite>>): string {
  return [
    ...formatScenarioReport('Synthetic baseline', report.syntheticBaseline),
    '',
    ...formatScenarioReport('Realistic benchmark', report.realisticComplexDag),
    '',
    'Validation scenarios:',
    ...report.validationScenarios.map((scenario) => (
      `- ${scenario.scenario}: lifecycle=${scenario.lifecycleStatus}, blockingReason=${scenario.blockingReason}, pendingBatchCount=${scenario.pendingBatchCount}, approvalBlockedBatchCount=${scenario.approvalBlockedBatchCount}, consolidationCorrectionCount=${scenario.consolidationCorrectionCount}, fallbackReasons=${scenario.plannerFallbackReasons.join('|') || 'none'}`
    ))
  ].join('\n');
}

async function main(): Promise<void> {
  const report = await runRuntimeBenchmarkSuite();
  const reportPath = resolveReportPath();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatReport(report));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
