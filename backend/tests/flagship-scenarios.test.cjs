const test = require('node:test');
const assert = require('node:assert/strict');
const { runTaskFlagshipScenarioSuite } = require('../dist');

test('flagship scenario suite validates complex code-task performance and recovery behavior', async () => {
  const report = await runTaskFlagshipScenarioSuite();

  assert.equal(report.scenarios.length, 5);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.passed, 5);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.callCountTargetsSatisfied, true);
  assert.equal(report.totals.plannerFallbackScenarioCount, 0);
  assert.equal(typeof report.totals.averageExecutedToolBatchCount, 'number');
  assert.equal(typeof report.totals.averageToolInvocationsPerBatch, 'number');

  const multiFile = report.scenarios.find((scenario) => scenario.scenario === 'flagship-multi-file-implementation');
  const diagnosis = report.scenarios.find((scenario) => scenario.scenario === 'flagship-regression-diagnosis');
  const batchEdit = report.scenarios.find((scenario) => scenario.scenario === 'flagship-batch-file-modification');
  const approval = report.scenarios.find((scenario) => scenario.scenario === 'flagship-approval-sensitive-write');
  const recovery = report.scenarios.find((scenario) => scenario.scenario === 'flagship-long-running-recovery');

  assert.ok(multiFile);
  assert.ok(diagnosis);
  assert.ok(batchEdit);
  assert.ok(approval);
  assert.ok(recovery);

  assert.equal(multiFile.metrics.apiCallCount <= 4, true);
  assert.equal(multiFile.metrics.executedToolBatchCount >= 2, true);
  assert.equal(multiFile.metrics.averageToolInvocationsPerBatch >= 2, true);
  assert.equal(diagnosis.metrics.toolInvocationCount >= 8, true);
  assert.equal(batchEdit.metrics.executedToolBatchCount >= 2, true);
  assert.equal(approval.metrics.approvalCount >= 2, true);
  assert.equal(approval.executionSummary.observedHooks.includes('approval-blocked'), true);
  assert.equal(recovery.metrics.recoveryCount >= 1, true);
  assert.equal(recovery.executionSummary.recovery.recoveredAfterRestart, true);
  assert.equal(recovery.executionSummary.recovery.recoveryReason, 'process_restart');
  assert.equal(recovery.executionSummary.recovery.recoveredBy, 'startup');
  assert.equal(typeof recovery.metrics.contextGating.filteredContextMessageCount, 'number');
  assert.equal(recovery.metrics.plannerFallbackCount, 0);
});
