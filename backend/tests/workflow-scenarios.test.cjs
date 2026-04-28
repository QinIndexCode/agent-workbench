const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runRuntimeBenchmarkSuite,
  runTaskWorkflowScenarioSuite
} = require('../dist');

test('workflow scenario suite covers five code-oriented task flows with structured diagnostics', async () => {
  const benchmark = await runRuntimeBenchmarkSuite();
  const report = await runTaskWorkflowScenarioSuite(benchmark);

  assert.equal(report.scenarios.length, 5);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.passed, 5);
  assert.equal(typeof report.recommendation.priority, 'string');
  assert.equal(typeof report.recommendation.rationale, 'string');

  const codeWorkflow = report.scenarios.find((scenario) => scenario.scenario === 'code-modification-workflow');
  const mixedWorkflow = report.scenarios.find((scenario) => scenario.scenario === 'mixed-file-command-workflow');
  const operatorWorkflow = report.scenarios.find((scenario) => scenario.scenario === 'operator-guided-continue');
  const approvalWorkflow = report.scenarios.find((scenario) => scenario.scenario === 'approval-blocked-workflow');
  const recoveryWorkflow = report.scenarios.find((scenario) => scenario.scenario === 'pause-resume-restart-recovery');

  assert.ok(codeWorkflow);
  assert.ok(mixedWorkflow);
  assert.ok(operatorWorkflow);
  assert.ok(approvalWorkflow);
  assert.ok(recoveryWorkflow);

  assert.equal(codeWorkflow.finalLifecycleStatus, 'COMPLETED');
  assert.equal(codeWorkflow.metrics.apiCallCount <= 5, true);
  assert.equal(codeWorkflow.metrics.executedToolBatchCount >= 1, true);
  assert.equal(codeWorkflow.metrics.toolInvocationCount >= 5, true);
  assert.equal(typeof codeWorkflow.metrics.averageToolInvocationsPerBatch, 'number');
  assert.equal(mixedWorkflow.observedHooks.includes('post-tool-result'), true);
  assert.equal(operatorWorkflow.metrics.continueMessageCount >= 1, true);
  assert.equal(approvalWorkflow.metrics.approvalCount >= 1, true);
  assert.equal(approvalWorkflow.executionSummary.observedHooks.includes('approval-blocked'), true);
  assert.equal(recoveryWorkflow.metrics.recoveryCount >= 1, true);
  assert.equal(recoveryWorkflow.executionSummary.recovery.recoveredAfterRestart, true);
  assert.equal(recoveryWorkflow.executionSummary.recovery.recoveryReason, 'process_restart');
  assert.equal(recoveryWorkflow.executionSummary.recovery.recoveredBy, 'startup');
  assert.equal(recoveryWorkflow.executionSummary.observedHooks.includes('task-resumed'), true);
  assert.equal(Array.isArray(recoveryWorkflow.executionSummary.executionProfiles), true);
  assert.equal(recoveryWorkflow.executionSummary.executionProfiles.length >= 3, true);
  assert.equal(typeof codeWorkflow.executionSummary.contextGating.filteredContextMessageCount, 'number');
  assert.equal(typeof codeWorkflow.metrics.contextGating.estimatedContextReductionRatio, 'number');
  assert.equal(typeof codeWorkflow.executionSummary.executionProfiles[0].historyScope, 'string');
  assert.equal(codeWorkflow.executionSummary.contextGating.filteredContextMessageCount > 0, true);
});
