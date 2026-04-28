const test = require('node:test');
const assert = require('node:assert/strict');
const { runCliInteractionTranscriptSuite } = require('../dist/application/benchmark/cli-interaction-transcript.js');

test('cli interaction transcript suite keeps operator guidance complete across slash commands and stream modes', async () => {
  const report = await runCliInteractionTranscriptSuite();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.total >= 4, true);
  assert.equal(report.totals.artifactQualityPassRate, 1);
});
