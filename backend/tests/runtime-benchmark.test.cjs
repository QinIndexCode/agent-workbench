const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixedRuntimeBenchmark, runRuntimeBenchmarkSuite } = require('../dist');

test('fixed runtime benchmark satisfies terminal planner-first objectives', async () => {
  const result = await runFixedRuntimeBenchmark();

  assert.equal(result.scenario, 'fixed-complex-dag');
  assert.equal(result.plannerPrimary.apiCallCount, 3);
  assert.equal(result.singleActiveBaseline.apiCallCount, 12);
  assert.equal(result.plannerPrimary.stageCount, 3);
  assert.equal(result.plannerPrimary.batchCount, 1);
  assert.equal(result.plannerPrimary.plannedToolBatchCount >= 1, true);
  assert.equal(result.plannerPrimary.toolInvocationCount >= 1, true);
  assert.equal(typeof result.plannerPrimary.averageToolInvocationsPerBatch, 'number');
  assert.equal(result.plannerPrimary.fallbackCount, 0);
  assert.equal(result.singleActiveBaseline.fallbackCount > 0, true);
  assert.equal(result.objectives.plannerCallRangeSatisfied, true);
  assert.equal(result.objectives.tokenReductionTargetSatisfied, true);
  assert.equal(result.objectives.fallbackGuardSatisfied, true);
  assert.equal(result.deltas.apiCallReductionRatio >= 0.75, true);
  assert.equal(result.deltas.tokenReductionRatio >= 0.7, true);
  assert.equal(result.plannerPrimary.stageUtilizationRatio > 1, true);
  assert.equal(Array.isArray(result.plannerPrimary.plannerFallbackReasons), true);
  assert.equal(typeof result.plannerPrimary.compatibilityFallbackCount, 'number');
  assert.equal(typeof result.plannerPrimary.correctionLoopRate, 'number');
  assert.equal(typeof result.plannerPrimary.unsafeBatchRejectedCount, 'number');
  assert.equal(typeof result.plannerPrimary.compressionDowngradeCount, 'number');
  assert.equal(typeof result.plannerPrimary.plannerFallbackRate, 'number');
  assert.equal(typeof result.plannerPrimary.sectionPromptChars.taskMemoryChars, 'number');
  assert.equal(typeof result.plannerPrimary.sectionPromptRatios.validatedOutputChars, 'number');
  assert.equal(typeof result.plannerPrimary.contextGating.filteredContextMessageCount, 'number');
  assert.equal(typeof result.plannerPrimary.contextGating.estimatedContextReductionRatio, 'number');
  assert.equal(typeof result.plannerPrimary.estimatedHistoryReductionRatio, 'number');
  assert.equal(typeof result.tokenAnalysis.reductionGap, 'number');
  assert.equal(typeof result.tokenAnalysis.likelyBottleneck, 'string');
});

test('runtime benchmark suite includes realistic and validation scenarios', async () => {
  const report = await runRuntimeBenchmarkSuite();

  assert.equal(report.syntheticBaseline.scenario, 'fixed-complex-dag');
  assert.equal(report.realisticComplexDag.scenario, 'realistic-complex-dag');
  assert.equal(report.realisticComplexDag.plannerPrimary.apiCallCount >= 1, true);
  assert.equal(report.realisticComplexDag.plannerPrimary.apiCallCount <= 3, true);
  assert.equal(report.realisticComplexDag.plannerPrimary.stageCount >= 3, true);
  assert.equal(report.realisticComplexDag.plannerPrimary.plannedToolBatchCount >= 1, true);
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.averageToolInvocationsPerBatch, 'number');
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.unsafeBatchRejectedCount, 'number');
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.compressionDowngradeCount, 'number');
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.sectionPromptChars.stageRuntimeChars, 'number');
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.sectionPromptRatios.capabilityChars, 'number');
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.contextGating.filteredContextMessageCount, 'number');
  assert.equal(Array.isArray(report.realisticComplexDag.plannerPrimary.contextGating.reasons), true);
  assert.equal(typeof report.realisticComplexDag.plannerPrimary.estimatedSectionReductionRatio, 'number');
  assert.equal(typeof report.realisticComplexDag.tokenAnalysis.historyReductionRatio, 'number');
  assert.equal(typeof report.realisticComplexDag.tokenAnalysis.likelyBottleneck, 'string');
  assert.equal(report.realisticComplexDag.objectives.tokenReductionTargetSatisfied, true);
  assert.equal(report.validationScenarios.length >= 3, true);

  const approvalBlocked = report.validationScenarios.find((scenario) => scenario.scenario === 'approval-blocked-stage');
  const correction = report.validationScenarios.find((scenario) => scenario.scenario === 'consolidation-correction-loop');
  const fallback = report.validationScenarios.find((scenario) => scenario.scenario === 'planner-fallback');

  assert.equal(approvalBlocked.blockingReason, 'CONSOLIDATION_BLOCKED');
  assert.equal(approvalBlocked.approvalBlockedBatchCount > 0, true);
  assert.equal(typeof approvalBlocked.contextGating.filteredContextMessageCount, 'number');
  assert.equal(correction.lifecycleStatus, 'FAILED');
  assert.equal(correction.blockingReason, 'CONTRACT_BLOCKED');
  assert.equal(correction.consolidationCorrectionCount > 0, true);
  assert.equal(typeof correction.contextGating.estimatedContextReductionRatio, 'number');
  assert.equal(fallback.plannerFallbackReasons.includes('benchmark_forced_single_active_fallback'), true);
  assert.equal(Array.isArray(fallback.contextGating.reasons), true);
});
