const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadScorecardModule() {
  const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/release-scorecard.mjs')).href;
  return import(modulePath);
}

test('interaction E2E summary rejects stale reports even when the report itself passes', async () => {
  const { summarizeInteractionE2E } = await loadScorecardModule();

  const summary = summarizeInteractionE2E({
    commandStatus: 0,
    reportIsFresh: false,
    report: {
      generatedAt: new Date().toISOString(),
      passes: true,
      scenarios: [
        { name: 'web-pause-resume-complete' },
        { name: 'web-approval-approved' },
        { name: 'web-approval-rejected' },
        { name: 'web-artifact-routing-apply' }
      ]
    }
  });

  assert.equal(summary.status, 'open_gap');
  assert.match(summary.detail, /stale|predates/i);
});

test('interaction E2E summary rejects command failures even when an old passing report exists', async () => {
  const { summarizeInteractionE2E } = await loadScorecardModule();

  const summary = summarizeInteractionE2E({
    commandStatus: 1,
    reportIsFresh: true,
    report: {
      generatedAt: new Date().toISOString(),
      passes: true,
      scenarios: [
        { name: 'web-pause-resume-complete' },
        { name: 'web-approval-approved' },
        { name: 'web-approval-rejected' },
        { name: 'web-artifact-routing-apply' }
      ]
    }
  });

  assert.equal(summary.status, 'open_gap');
  assert.match(summary.detail, /did not complete successfully/i);
});

test('interaction E2E summary accepts fresh passing reports from the current run', async () => {
  const { summarizeInteractionE2E } = await loadScorecardModule();

  const summary = summarizeInteractionE2E({
    commandStatus: 0,
    reportIsFresh: true,
    report: {
      generatedAt: new Date().toISOString(),
      passes: true,
      scenarios: [
        { name: 'web-pause-resume-complete' },
        { name: 'web-approval-approved' },
        { name: 'web-approval-rejected' },
        { name: 'web-artifact-routing-apply' }
      ]
    }
  });

  assert.equal(summary.status, 'achieved');
});

test('area-group summary prefers external blockers over open-gap when no implementation gaps remain', async () => {
  const { summarizeAreaGroupStatus } = await loadScorecardModule();

  assert.equal(summarizeAreaGroupStatus([
    { status: 'achieved' },
    { status: 'external_blocker' }
  ]), 'external_blocker');

  assert.equal(summarizeAreaGroupStatus([
    { status: 'achieved' },
    { status: 'external_blocker' },
    { status: 'open_gap' }
  ]), 'open_gap');
});

test('CLI web interaction summary accepts the current viewport-grouped frontend smoke report shape', async () => {
  const { summarizeCliWebInteraction } = await loadScorecardModule();

  const summary = summarizeCliWebInteraction({
    backendTestsOk: true,
    frontendSmokeOk: true,
    interactionConsistency: { status: 'achieved' },
    frontendSmokeReport: {
      passes: true,
      runs: [
        {
          viewport: { name: 'mobile', width: 390, height: 844 },
          actualRuns: [
            {
              page: 'settings-capabilities',
              state: 'actual',
              functionalChecks: { passes: true }
            },
            {
              page: 'tasks',
              state: 'actual',
              extras: {
                inspector: { checked: true }
              }
            }
          ]
        },
        {
          viewport: { name: 'desktop', width: 1280, height: 900 },
          actualRuns: [
            {
              page: 'tasks',
              state: 'actual',
              extras: {
                inspector: { checked: true }
              }
            }
          ]
        }
      ]
    }
  });

  assert.equal(summary.status, 'achieved');
});

test('CLI web interaction summary flags missing task inspector coverage in the current smoke report shape', async () => {
  const { summarizeCliWebInteraction } = await loadScorecardModule();

  const summary = summarizeCliWebInteraction({
    backendTestsOk: true,
    frontendSmokeOk: true,
    interactionConsistency: { status: 'achieved' },
    frontendSmokeReport: {
      passes: true,
      runs: [
        {
          viewport: { name: 'mobile', width: 390, height: 844 },
          actualRuns: [
            {
              page: 'settings-capabilities',
              state: 'actual',
              functionalChecks: { passes: true }
            },
            {
              page: 'tasks',
              state: 'actual',
              extras: {
                inspector: { checked: false }
              }
            }
          ]
        }
      ]
    }
  });

  assert.equal(summary.status, 'open_gap');
  assert.match(summary.detail, /mobile/i);
});

test('live provider usage accounting fails when any call-level provenance is missing', async () => {
  const { summarizeLiveProviderUsageAccounting } = await loadScorecardModule();

  const summary = summarizeLiveProviderUsageAccounting({
    liveProviderReport: {
      status: 'achieved',
      externalBlocker: null,
      totals: {
        totalTokens: 1200,
        totalApiCalls: 3,
        usageBreakdown: {
          returnedCalls: 2,
          estimatedCalls: 0,
          missingCalls: 1
        }
      }
    },
    livePracticalReport: {
      status: 'achieved',
      externalBlocker: null,
      totals: {
        totalTokens: 1600,
        totalApiCalls: 4,
        usageBreakdown: {
          returnedCalls: 4,
          estimatedCalls: 0,
          missingCalls: 0
        }
      }
    }
  });

  assert.equal(summary.status, 'open_gap');
  assert.match(summary.detail, /missing provider usage calls/i);
});

test('live provider usage accounting accepts call-level returned and estimated usage without gaps', async () => {
  const { summarizeLiveProviderUsageAccounting } = await loadScorecardModule();

  const summary = summarizeLiveProviderUsageAccounting({
    liveProviderReport: {
      status: 'achieved',
      externalBlocker: null,
      totals: {
        totalTokens: 1200,
        totalApiCalls: 3,
        usageBreakdown: {
          returnedCalls: 2,
          estimatedCalls: 1,
          missingCalls: 0
        }
      }
    },
    livePracticalReport: {
      status: 'achieved',
      externalBlocker: null,
      totals: {
        totalTokens: 1600,
        totalApiCalls: 4,
        usageBreakdown: {
          returnedCalls: 3,
          estimatedCalls: 1,
          missingCalls: 0
        }
      }
    }
  });

  assert.equal(summary.status, 'achieved');
  assert.match(summary.detail, /returnedCalls=5/);
  assert.match(summary.detail, /estimatedCalls=2/);
});

test('parseReportFile accepts a fresh reusable live report', async () => {
  const { parseReportFile } = await loadScorecardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-report-'));
  const reportPath = path.join(tempDir, 'practical-live-task-acceptance.json');

  try {
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      status: 'achieved',
      scenarios: [],
      totals: {}
    }), 'utf8');

    const result = await parseReportFile(reportPath, {
      label: 'practical-live-task-acceptance',
      validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
    });

    assert.ok(result.payload);
    assert.equal(result.issues.length, 0);
    assert.equal(result.reportIsFresh, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('parseReportFile reports contract drift instead of rerunning live suites when reusable json is malformed', async () => {
  const { parseReportFile } = await loadScorecardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-report-'));
  const reportPath = path.join(tempDir, 'practical-live-task-acceptance.json');

  try {
    await fs.writeFile(reportPath, '{"status":"achieved"', 'utf8');

    const result = await parseReportFile(reportPath, {
      label: 'practical-live-task-acceptance',
      validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
    });

    assert.equal(result.payload, null);
    assert.equal(result.issues.some((issue) => /report_contract_drift/i.test(issue)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('loadSuiteFromCommandOrReport does not rerun a live suite when the reusable report is missing', async () => {
  const { loadSuiteFromCommandOrReport } = await loadScorecardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-load-suite-'));
  const missingReportPath = path.join(tempDir, 'live-provider-scenarios.json');

  try {
    const result = await loadSuiteFromCommandOrReport({
      label: 'live-provider',
      command: 'node',
      args: ['-e', 'process.stdout.write("unexpected-rerun")'],
      reportPath: missingReportPath,
      forceRerun: false,
      validator: () => true
    });

    assert.equal(result.source, 'report');
    assert.equal(result.command.status, 1);
    assert.equal(result.command.stdout, '');
    assert.match(result.command.stderr, /reusable report missing/i);
    assert.equal(result.parse.payload, null);
    assert.match(result.parse.issues.join('; '), /reusable report missing/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
