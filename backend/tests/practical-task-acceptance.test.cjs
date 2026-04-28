const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  runPracticalTaskAcceptanceSuite,
  runPracticalManualAudit
} = require('../dist');

test('practical task acceptance suite validates mixed practical tasks with hybrid clarification semantics', async () => {
  let report = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    report = await runPracticalTaskAcceptanceSuite();
    if (report.status === 'achieved') {
      break;
    }
  }

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 12);
  assert.equal(report.totals.passed, 12);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.artifactQualityPassRate, 1);
  assert.equal(report.totals.shipReadyPassRate, 1);
  assert.equal(report.totals.byFamily['vague-blog-request'], 1);
  assert.equal(report.totals.byFamily['practical-review-task'], 1);
  assert.equal(report.totals.byFamily['vague-landing-page-brief'], 1);
  assert.equal(report.totals.byFamily['explicit-multi-artifact-doc-bundle'], 1);
  assert.equal(report.totals.byFamily['engineering-decision-record-task'], 1);
  assert.equal(report.totals.byFamily['repo-grounded-review-followup-task'], 1);
  assert.equal(report.totals.byFailureCategory.unknown ?? 0, 0);

  const vagueBlog = report.scenarios.find((scenario) => scenario.scenario === 'vague-blog-request');
  const vagueSummary = report.scenarios.find((scenario) => scenario.scenario === 'vague-summary-request');
  const explicitDoc = report.scenarios.find((scenario) => scenario.scenario === 'explicit-doc-request');
  const engineeringTask = report.scenarios.find((scenario) => scenario.scenario === 'practical-engineering-change-task');
  const landingPage = report.scenarios.find((scenario) => scenario.scenario === 'vague-landing-page-brief');
  const multiArtifact = report.scenarios.find((scenario) => scenario.scenario === 'explicit-multi-artifact-doc-bundle');

  assert.ok(vagueBlog);
  assert.ok(vagueSummary);
  assert.ok(explicitDoc);
  assert.ok(engineeringTask);
  assert.ok(landingPage);
  assert.ok(multiArtifact);

  assert.equal(vagueBlog.clarificationMode, 'assumption-led');
  assert.equal(vagueBlog.assumptionDisclosure.status, 'declared');
  assert.equal(vagueSummary.clarificationMode, 'required');
  assert.equal(vagueSummary.assumptionDisclosure.status, 'not-needed');
  assert.equal(landingPage.clarificationMode, 'assumption-led');
  assert.equal(landingPage.assumptionDisclosure.status, 'declared');
  assert.equal(explicitDoc.artifactQuality.verdict, 'passed');
  assert.equal(multiArtifact.diagnostics.artifactSnapshots.filter((snapshot) => snapshot.exists).length, 2);
  assert.equal(engineeringTask.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'patches/task-progress.patch' && snapshot.exists), true);
  assert.equal(
    engineeringTask.diagnostics.artifactSnapshots.some((snapshot) => snapshot.persistedPath && fs.existsSync(snapshot.persistedPath)),
    true
  );
});

test('practical manual audit keeps practical task outputs at ship-ready-with-minor-edits quality', async () => {
  const report = await runPracticalManualAudit();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 12);
  assert.equal(report.totals.passed, 12);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.entries.every((entry) => entry.verdict === 'passed'), true);
});
