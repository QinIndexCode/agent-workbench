const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isReusablePracticalLiveReport,
  runPracticalLiveManualAudit
} = require('../dist');

function createScenario(overrides = {}) {
  return {
    scenario: 'analysis-brief-task',
    description: 'analysis brief',
    taskId: 'task-live-1',
    passed: true,
    finalLifecycleStatus: 'COMPLETED',
    issueCategory: null,
    issueSummary: null,
    missingRequiredEventTypes: [],
    observedHooks: [],
    clarificationMode: 'not-needed',
    assumptionDisclosure: {
      status: 'not-needed',
      summary: null
    },
    executionSummary: {
      queueRuntimeAlignment: {
        consistent: true
      }
    },
    artifactQuality: {
      verdict: 'passed',
      failureCategory: null,
      summary: 'ok',
      files: ['analysis-brief.md']
    },
    diagnostics: {
      workspaceDir: null,
      sourceFiles: [],
      artifactSnapshots: []
    },
    metrics: {
      apiCallCount: 1,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      usageSource: 'returned',
      usageBreakdown: {
        returnedCalls: 1,
        estimatedCalls: 0,
        missingCalls: 0
      }
    },
    ...overrides
  };
}

function createSourceReport(overrides = {}) {
  return {
    generatedAt: Date.now(),
    profile: 'default',
    status: 'achieved',
    provider: {
      providerId: 'xiaomi-mimo-v2-flash',
      model: 'mimo-v2-flash'
    },
    externalBlocker: null,
    scenarios: [createScenario()],
    totals: {
      total: 1,
      passed: 1,
      failed: 0,
      successRate: 1,
      artifactQualityPassRate: 1,
      byFamily: {
        'vague-blog-request': 0,
        'explicit-blog-request': 0,
        'vague-summary-request': 0,
        'explicit-doc-request': 0,
        'operator-report-task': 0,
        'analysis-brief-task': 1,
        'practical-engineering-change-task': 0,
        'practical-review-task': 0,
        'vague-landing-page-brief': 0,
        'explicit-multi-artifact-doc-bundle': 0,
        'engineering-decision-record-task': 0,
        'repo-grounded-review-followup-task': 0
      },
      byFailureCategory: {},
      shipReadyPassRate: 1,
      minorEditsNeededCount: 0,
      criticalGapsCount: 0,
      liveProviderPassRate: 1,
      usageSourceCounts: {
        returned: 1,
        estimated: 0,
        missing: 0
      },
      usageBreakdown: {
        returnedCalls: 1,
        estimatedCalls: 0,
        missingCalls: 0
      },
      totalApiCalls: 1,
      totalPromptTokens: 10,
      totalCompletionTokens: 20,
      totalTokens: 30
    },
    ...overrides
  };
}

test('practical live report reuse rejects stale or mismatched provider reports', async () => {
  const now = Date.now();
  const fresh = createSourceReport({
    generatedAt: now - 10_000
  });

  assert.equal(isReusablePracticalLiveReport(fresh, {
    now,
    env: {
      SCORECARD_PROFILE: 'default',
      BACKEND_NEW_LIVE_PROVIDER_ID: 'xiaomi-mimo-v2-flash',
      BACKEND_NEW_LIVE_PROVIDER_MODEL: 'mimo-v2-flash'
    }
  }), true);

  assert.equal(isReusablePracticalLiveReport(createSourceReport({
    generatedAt: now - 10 * 60 * 1000
  }), {
    now,
    env: {
      SCORECARD_PROFILE: 'default',
      BACKEND_NEW_LIVE_PROVIDER_ID: 'xiaomi-mimo-v2-flash',
      BACKEND_NEW_LIVE_PROVIDER_MODEL: 'mimo-v2-flash'
    }
  }), false);

  assert.equal(isReusablePracticalLiveReport(createSourceReport({
    provider: {
      providerId: 'other-provider',
      model: 'mimo-v2-flash'
    }
  }), {
    now,
    env: {
      SCORECARD_PROFILE: 'default',
      BACKEND_NEW_LIVE_PROVIDER_ID: 'xiaomi-mimo-v2-flash',
      BACKEND_NEW_LIVE_PROVIDER_MODEL: 'mimo-v2-flash'
    }
  }), false);
});

test('practical live manual audit prefers persisted full artifacts over short excerpts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'practical-live-audit-'));
  try {
    const persistedPath = path.join(tempDir, 'analysis-brief.md');
    const fullContent = `# Analysis Brief\n${'x'.repeat(260)}\nConclusion\nRisks\nRecommendation\nFULL_ARTIFACT_MARKER`;
    fs.writeFileSync(persistedPath, fullContent, 'utf8');

    const report = await runPracticalLiveManualAudit({
      sourceReport: createSourceReport({
        scenarios: [
          createScenario({
            diagnostics: {
              workspaceDir: null,
              sourceFiles: [],
              artifactSnapshots: [{
                path: 'analysis-brief.md',
                exists: true,
                excerpt: 'short excerpt only',
                persistedPath
              }]
            }
          })
        ]
      })
    });

    assert.equal(report.status, 'achieved');
    assert.equal(report.profile, 'default');
    assert.equal(report.entries[0].verdict, 'passed');
    assert.equal(report.entries[0].artifactPaths.length, 1);
    assert.equal(report.entries[0].evidence.some((entry) => entry.includes('FULL_ARTIFACT_MARKER')), true);
    assert.equal(report.entries[0].evidence.some((entry) => entry.includes('short excerpt only')), false);
    assert.equal(report.totals.shipReadyPassRate, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('practical live manual audit can rely on an explicit source report without rerunning the live suite', async () => {
  const report = await runPracticalLiveManualAudit({
    env: {
      ...process.env,
      BACKEND_NEW_LIVE_PROVIDER_ENABLED: '0'
    },
    sourceReport: createSourceReport({
      scenarios: [
        createScenario({
          diagnostics: {
            workspaceDir: null,
            sourceFiles: [],
            artifactSnapshots: [{
              path: 'analysis-brief.md',
              exists: true,
              excerpt: 'Conclusion Risks Recommendation',
              persistedPath: null
            }]
          }
        })
      ]
    })
  });

  assert.equal(report.status, 'achieved');
  assert.equal(report.sourceStatus, 'achieved');
  assert.equal(report.provider.providerId, 'xiaomi-mimo-v2-flash');
});
