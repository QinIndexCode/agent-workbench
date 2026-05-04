const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  applyLiveProviderArtifactEvidenceGate,
  extractLiveProviderWriteFileContent,
  runTaskLiveProviderScenarioSuite
} = require('../dist');

const repoRoot = path.resolve(__dirname, '..', '..');

test('live provider suite reports a structured external blocker when real-provider execution is disabled', async () => {
  const report = await runTaskLiveProviderScenarioSuite({
    env: {
      ...process.env,
      BACKEND_NEW_LIVE_PROVIDER_ENABLED: '0'
    },
    cwd: repoRoot
  });

  assert.equal(report.status, 'external_blocker');
  assert.equal(report.totals.total, 5);
  assert.equal(report.totals.externalBlocked, 5);
  assert.equal(report.totals.byVerdict.external_blocker, 5);
  assert.equal(typeof report.externalBlocker, 'string');
  assert.equal(report.scenarios.every((scenario) => scenario.artifactEvidence.verdict === 'external_blocker'), true);
  assert.equal(report.scenarios.every((scenario) => scenario.externalBlocker), true);
});

test('live provider suite resolves the provider manifest from the backend workspace and surfaces missing credentials instead of missing providers', async () => {
  const report = await runTaskLiveProviderScenarioSuite({
    env: {
      ...process.env,
      BACKEND_NEW_LIVE_PROVIDER_ENABLED: '1',
      BACKEND_NEW_LIVE_PROVIDER_MANIFEST: '',
      BACKEND_NEW_LIVE_PROVIDER_ID: 'xiaomi-mimo-v2-flash',
      BACKEND_NEW_LIVE_PROVIDER_API_KEY: ''
    },
    cwd: repoRoot
  });

  assert.equal(report.status, 'external_blocker');
  assert.equal(report.totals.total, 5);
  assert.equal(report.totals.externalBlocked, 5);
  assert.match(report.externalBlocker ?? '', /missing api key secret|api key/i);
  assert.equal(report.scenarios.every((scenario) => scenario.externalBlocker), true);
});

test('live provider artifact gate rejects unresolved artifact apply conflicts even when the scenario acceptance initially passed', () => {
  const gated = applyLiveProviderArtifactEvidenceGate({
    issueCategory: 'artifact_apply_conflict',
    issueSummary: 'Destination file has conflicting local edits.',
    lastArtifactApplyResult: {
      status: 'CONFLICT',
      appliedCount: 0,
      skippedCount: 1,
      message: 'Destination file has conflicting local edits.'
    }
  }, {
    verdict: 'passed',
    failureCategory: null,
    summary: 'workspace artifacts validated',
    files: ['src/example.ts'],
    testsPassed: true,
    contentAssertionsPassed: true,
    diffAssertionsPassed: true
  });

  assert.equal(gated.verdict, 'failed');
  assert.equal(gated.failureCategory, 'artifact_apply_conflict');
  assert.match(gated.summary, /conflicting local edits/i);
  assert.deepEqual(gated.files, ['src/example.ts']);
});

test('live provider artifact audit recovers write_file content_lines and content_json evidence', () => {
  assert.equal(
    extractLiveProviderWriteFileContent({
      content_lines: [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");'
      ]
    }),
    'const test = require("node:test");\nconst assert = require("node:assert/strict");'
  );

  assert.equal(
    extractLiveProviderWriteFileContent({
      content_json: {
        report: 'ok',
        files: ['reports/diagnosis.md']
      }
    }),
    '{\n  "report": "ok",\n  "files": [\n    "reports/diagnosis.md"\n  ]\n}\n'
  );
});
