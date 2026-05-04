const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadHumanTaskMatrixModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'run-human-task-matrix.mjs');
  return import(pathToFileURL(modulePath).href);
}

test('human task matrix exposes broad ordinary-user cases without scenario pack ids', async () => {
  const { buildHumanTaskCases } = await loadHumanTaskMatrixModule();
  const cases = buildHumanTaskCases();
  const ids = cases.map((entry) => entry.id);

  assert.ok(ids.includes('file-brief-summary'));
  assert.ok(ids.includes('code-test-repair'));
  assert.ok(ids.includes('data-reconcile'));
  assert.ok(ids.includes('docs-decision-log'));
  assert.ok(ids.includes('missing-source-blocker'));
  assert.ok(ids.includes('multi-unit-handoff'));
  assert.equal(ids.some((id) => /database|near-mysql/i.test(id)), false);
  assert.ok(new Set(cases.map((entry) => entry.category)).size >= 5);
});

test('human task matrix selection forms serial model case entries', async () => {
  const { resolveSelectedHumanTaskMatrixEntries } = await loadHumanTaskMatrixModule();

  const entries = resolveSelectedHumanTaskMatrixEntries({
    models: 'mimo-v2.5,mimo-v2.5-pro',
    cases: 'file-brief-summary,data-reconcile',
  }, {});

  assert.deepEqual(entries.map((entry) => `${entry.model}:${entry.testCase.id}`), [
    'mimo-v2.5:file-brief-summary',
    'mimo-v2.5:data-reconcile',
    'mimo-v2.5-pro:file-brief-summary',
    'mimo-v2.5-pro:data-reconcile',
  ]);
});

test('human task matrix definitions keep generated artifacts inside task workspace', async () => {
  const { buildHumanTaskCases, buildTaskDefinition } = await loadHumanTaskMatrixModule();
  const dataCase = buildHumanTaskCases().find((entry) => entry.id === 'data-reconcile');

  const definition = buildTaskDefinition(dataCase, 'test-provider');

  assert.equal(definition.metadata.artifactRouting.pathPolicy, 'task_workspace');
});

test('human task matrix classifier requires terminal completion, tool evidence, and expected artifacts', async () => {
  const { buildHumanTaskCases, classifyHumanTaskRun } = await loadHumanTaskMatrixModule();
  const dataCase = buildHumanTaskCases().find((entry) => entry.id === 'data-reconcile');

  const passed = classifyHumanTaskRun(dataCase, {
    finalStatus: { lifecycleStatus: 'COMPLETED' },
    debugPayload: {
      executionSummary: {
        acceptance: {
          deterministic: { verdict: 'passed' },
        },
      },
    },
    workspaceFiles: ['outputs/customer-summary.json'],
    workspaceTextByPath: {
      'outputs/customer-summary.json': '{"Acme":200,"statusCounts":{"paid":2,"pending":1,"refunded":1}}',
    },
    visibleToolActivityCount: 2,
    inspectionText: '{"Acme":200,"statusCounts":{"paid":2,"pending":1,"refunded":1}}',
  });
  assert.equal(passed.classification, 'passed');

  const failed = classifyHumanTaskRun(dataCase, {
    finalStatus: { lifecycleStatus: 'PAUSED' },
    debugPayload: {
      executionSummary: {
        acceptance: {
          deterministic: { verdict: 'failed' },
        },
      },
    },
    workspaceFiles: [],
    workspaceTextByPath: {},
    visibleToolActivityCount: 0,
    inspectionText: '',
  });
  assert.equal(failed.classification, 'manual_review_required');
  assert.ok(failed.issues.some((issue) => /COMPLETED/i.test(issue)));
  assert.ok(failed.issues.some((issue) => /Missing required workspace file/i.test(issue)));

  const providerBlocked = classifyHumanTaskRun(dataCase, {
    finalStatus: { lifecycleStatus: 'FAILED' },
    debugPayload: {
      task: {
        diagnostics: {
          providerFailure: {
            kind: 'TIMEOUT',
            message: 'provider timed out',
          },
        },
      },
      executionSummary: {
        acceptance: {
          deterministic: { verdict: 'failed' },
        },
      },
    },
    workspaceFiles: [],
    workspaceTextByPath: {},
    visibleToolActivityCount: 1,
    inspectionText: '',
  });
  assert.equal(providerBlocked.classification, 'external_blocker');
  assert.ok(providerBlocked.advisories.some((advisory) => /external blockers/i.test(advisory)));
});

test('human task matrix inspection text includes raw explicit output envelopes', async () => {
  const { buildInspectionText } = await loadHumanTaskMatrixModule();

  const text = buildInspectionText({
    debugPayload: {
      task: {
        latestVisibleOutput: {
          summary: 'Launch summary',
          details: 'Success metric only',
        },
        runtime: {
          llmContextMessages: [{
            role: 'assistant',
            content: '[AGENT-001_OUTPUT]\n{"summary":"Launch summary","risks":["partner API quota"]}\n[/AGENT-001_OUTPUT]',
          }],
        },
      },
    },
    chatHuman: '',
    chatNdjson: '',
    workspaceTextByPath: {},
  });

  assert.match(text, /partner API quota/i);
});

test('human task matrix extracts only pending approvable tool items', async () => {
  const { extractPendingApprovalItems } = await loadHumanTaskMatrixModule();

  const items = extractPendingApprovalItems({
    task: {
      pendingApprovalItems: [{
        invocationId: 'tool_write',
        toolId: 'write_file',
        status: 'PENDING',
        availableActions: ['APPROVED', 'REJECTED'],
      }],
      pendingApprovals: [{
        invocationId: 'tool_write',
        toolId: 'write_file',
        status: 'PENDING',
      }, {
        invocationId: 'tool_old',
        toolId: 'run_command',
        status: 'APPROVED',
      }],
    },
  });

  assert.deepEqual(items, [{
    invocationId: 'tool_write',
    toolId: 'write_file',
    status: 'PENDING',
    reason: null,
  }]);
});

test('human task matrix distinguishes generic continue turns from real operator follow-up', async () => {
  const { isAwaitingGenericContinue, isAwaitingOperatorFollowup } = await loadHumanTaskMatrixModule();

  const genericContinue = {
    task: {
      runtime: {
        lifecycleStatus: 'RUNNING',
        pendingCorrection: 'AWAITING_TRACKER',
        executionLease: { active: false },
      },
      primaryAction: { kind: 'continue_thread' },
      nextActionSummary: { label: 'Continue current thread' },
    },
  };
  assert.equal(isAwaitingGenericContinue(genericContinue), true);
  assert.equal(isAwaitingOperatorFollowup(genericContinue), false);

  assert.equal(isAwaitingGenericContinue({
    task: {
      runtime: {
        lifecycleStatus: 'RUNNING',
        pendingCorrection: 'NONE',
        executionLease: { active: true },
      },
      primaryAction: { kind: 'continue_thread' },
      nextActionSummary: { label: 'Continue current thread' },
    },
  }), false);

  assert.equal(isAwaitingOperatorFollowup({
    task: {
      pendingApprovalItems: [{ invocationId: 'tool_write', status: 'PENDING' }],
      runtime: {
        lifecycleStatus: 'RUNNING',
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      primaryAction: { kind: 'approve' },
      nextActionSummary: { label: 'Approve or reject' },
    },
  }), true);

  assert.equal(isAwaitingOperatorFollowup({
    task: {
      runtime: {
        lifecycleStatus: 'COMPLETED',
        pendingCorrection: 'NONE',
        executionLease: { active: false },
      },
      primaryAction: { kind: 'none' },
      nextActionSummary: { label: 'Done' },
    },
  }), false);
});

test('human task matrix report explains script checks as triage evidence', async () => {
  const { formatMarkdownReport } = await loadHumanTaskMatrixModule();
  const markdown = formatMarkdownReport({
    generatedAt: '2026-05-01T00:00:00.000Z',
    runRoot: 'D:/tmp/human-task-matrix',
    summary: {
      total: 1,
      passed: 0,
      manualReviewRequired: 1,
      externalBlockers: 0,
      modelBlockers: 0,
    },
    runs: [{
      requestedModel: 'mimo-v2.5',
      effectiveModel: 'mimo-v2.5',
      fallbackApplied: false,
      id: 'file-brief-summary',
      persona: 'Product operator',
      category: 'grounded_reading',
      taskId: 'task_1',
      finalStatus: { lifecycleStatus: 'COMPLETED' },
      result: {
        classification: 'manual_review_required',
        issues: ['Needs human review'],
      },
      visibleToolActivityCount: 1,
      workspaceFiles: [],
      artifactBundleRoot: 'D:/tmp/bundle',
      checklist: ['Inspect output'],
    }],
    modelBlockers: [],
  });

  assert.match(markdown, /ordinary users submitting tasks/i);
  assert.match(markdown, /Script checks are triage evidence/i);
  assert.match(markdown, /Human checklist/i);
});
