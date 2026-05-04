const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runPublicCapabilityParitySuite,
  runManualArtifactAudit
} = require('../dist');

test('public capability parity suite reconstructs public baseline tasks with strict pass gates', async () => {
  let report = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    report = await runPublicCapabilityParitySuite();
    if (report.status === 'achieved') {
      break;
    }
  }

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 12);
  assert.equal(report.totals.passed, 12);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.artifactEvidencePassRate, 1);
  assert.equal(report.totals.byBaseline['claude-code'], 5);
  assert.equal(report.totals.byBaseline['anthropic-swebench'], 1);
  assert.equal(report.totals.byBaseline.opencode, 6);
  assert.equal(report.totals.byFamily['anthropic-swebench-issue-resolution-task'], 1);
  assert.equal(report.totals.byFamily['opencode-build-plan-split-task'], 1);
  assert.equal(report.totals.byFailureCategory.unknown ?? 0, 0);

  const planBuild = report.scenarios.find((scenario) => scenario.scenario === 'opencode-build-plan-split-task');
  const swebenchIssue = report.scenarios.find((scenario) => scenario.scenario === 'anthropic-swebench-issue-resolution-task');
  const claudeCommand = report.scenarios.find((scenario) => scenario.scenario === 'claude-custom-command-task');
  const opencodeProvider = report.scenarios.find((scenario) => scenario.scenario === 'opencode-provider-variant-task');

  assert.ok(planBuild);
  assert.ok(swebenchIssue);
  assert.ok(claudeCommand);
  assert.ok(opencodeProvider);

  assert.equal(planBuild.executionSummary.stageDurations.length >= 3, true);
  assert.equal(swebenchIssue.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/issue-resolution.patch' && snapshot.exists), true);
  assert.equal(claudeCommand.artifactEvidence.verdict, 'passed');
  assert.equal(opencodeProvider.executionSummary.providerSummary.variantId, 'reasoning');
});

test('manual artifact audit report stays green for public capability parity outputs', async () => {
  const report = await runManualArtifactAudit();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 12);
  assert.equal(report.totals.passed, 12);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.entries.every((entry) => entry.verdict === 'passed'), true);
});
