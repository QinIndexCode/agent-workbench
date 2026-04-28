const test = require('node:test');
const assert = require('node:assert/strict');
const { runTaskBreadthScenarioSuite } = require('../dist');

test('breadth scenario suite covers ten practical task categories with structured metrics', async () => {
  const report = await runTaskBreadthScenarioSuite();

  assert.equal(report.scenarios.length, 10);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.passed, 10);
  assert.equal(report.totals.successRate, 1);
  assert.equal(typeof report.totals.averageApiCallCount, 'number');
  assert.equal(typeof report.totals.averagePlannerFallbackRate, 'number');
  assert.equal(typeof report.totals.averageRecoveryCount, 'number');
  assert.equal(typeof report.totals.averageApprovalBlockedBatchRate, 'number');

  const categories = new Set(report.scenarios.map((scenario) => scenario.category));
  assert.deepEqual([...categories].sort(), [
    'approval-sensitive-tool',
    'bug-fix',
    'config-edit',
    'docs-generation',
    'long-running-recovery',
    'memory-context-heavy',
    'multi-file-implementation',
    'refactor',
    'regression-diagnosis',
    'test-repair'
  ]);

  const approvalScenario = report.scenarios.find((scenario) => scenario.category === 'approval-sensitive-tool');
  const recoveryScenario = report.scenarios.find((scenario) => scenario.category === 'long-running-recovery');
  const diagnosisScenario = report.scenarios.find((scenario) => scenario.category === 'regression-diagnosis');
  const multiFileScenario = report.scenarios.find((scenario) => scenario.category === 'multi-file-implementation');
  const memoryScenario = report.scenarios.find((scenario) => scenario.category === 'memory-context-heavy');

  assert.ok(approvalScenario);
  assert.ok(recoveryScenario);
  assert.ok(diagnosisScenario);
  assert.ok(multiFileScenario);
  assert.ok(memoryScenario);

  assert.equal(approvalScenario.metrics.approvalCount >= 1, true);
  assert.equal(recoveryScenario.metrics.recoveryCount >= 1, true);
  assert.equal(recoveryScenario.executionSummary.recovery.recoveredAfterRestart, true);
  assert.equal(recoveryScenario.executionSummary.recovery.recoveryReason, 'process_restart');
  assert.equal(recoveryScenario.executionSummary.recovery.recoveredBy, 'startup');
  assert.equal(diagnosisScenario.metrics.toolInvocationCount >= 4, true);
  assert.equal(multiFileScenario.metrics.toolInvocationCount >= 6, true);
  assert.equal(multiFileScenario.metrics.executedToolBatchCount >= 1, true);
  assert.equal(typeof multiFileScenario.metrics.averageToolInvocationsPerBatch, 'number');
  assert.equal(typeof memoryScenario.executionSummary.contextGating.filteredContextMessageCount, 'number');
});
