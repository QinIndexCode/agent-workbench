const test = require('node:test');
const assert = require('node:assert/strict');
const { runRuntimeStressValidationSuite } = require('../dist/application/benchmark/runtime-stress-validation.js');

test('runtime stress validation suite keeps recovery and drift scenarios explainable', async () => {
  const report = await runRuntimeStressValidationSuite();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.total >= 7, true);
  assert.equal(report.scenarios.some((scenario) => scenario.family === 'artifact-apply-recovery'), true);
});
