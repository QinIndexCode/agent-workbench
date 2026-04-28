const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadWaveModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'run-real-task-wave.mjs');
  return import(pathToFileURL(modulePath).href);
}

function writeDatabaseCorePrototypeModules(workspaceDir, overrides = {}) {
  const defaults = {
    'database-lab/prototype/src/storage-engine.js': [
      'class StorageEngine {',
      '  constructor(dataDir = ".tmp") { this.dataDir = dataDir; this.pages = new Map(); }',
      '  initialize() { return true; }',
      '  writePage(pageId, payload) { this.pages.set(pageId, payload); return payload; }',
      '  readPage(pageId) { return this.pages.get(pageId) ?? null; }',
      '  close() { return true; }',
      '}',
      'module.exports = { StorageEngine };',
    ].join('\n'),
    'database-lab/prototype/src/buffer-pool.js': [
      'class BufferPool {',
      '  constructor(options = {}) { this.storageEngine = options.storageEngine ?? options.storage ?? null; this.pages = new Map(); }',
      '  writePage(pageId, payload) { this.pages.set(pageId, payload); return payload; }',
      '  readPage(pageId) { return this.pages.get(pageId) ?? null; }',
      '}',
      'module.exports = { BufferPool };',
    ].join('\n'),
    'database-lab/prototype/src/b-plus-tree-index.js': [
      'class BPlusTreeIndex {',
      '  constructor() { this.entries = new Map(); }',
      '  insert(key, value) { this.entries.set(key, value); return value; }',
      '  search(key) { return this.entries.get(key) ?? null; }',
      '}',
      'module.exports = { BPlusTreeIndex };',
    ].join('\n'),
    'database-lab/prototype/src/wal-manager.js': [
      'class WALManager {',
      '  constructor(baseDir = ".tmp") { this.baseDir = baseDir; this.entries = []; }',
      '  appendEntry(entry) { this.entries.push(entry); return this.entries.length; }',
      '  close() { return true; }',
      '}',
      'module.exports = { WALManager };',
    ].join('\n'),
    'database-lab/prototype/src/transaction-manager.js': [
      'class TransactionManager {',
      '  constructor(options = {}) { this.options = options; this.nextId = 1; }',
      '  beginTransaction() { return { id: this.nextId++ }; }',
      '  commitTransaction(id) { return id; }',
      '}',
      'module.exports = { TransactionManager };',
    ].join('\n'),
  };
  const moduleMap = { ...defaults, ...overrides };
  for (const [relativePath, content] of Object.entries(moduleMap)) {
    const target = path.join(workspaceDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return Object.keys(moduleMap).sort((left, right) => left.localeCompare(right));
}

test('database artifact progress summarizes partial scaffold progress and bench failures', async () => {
  const { buildDatabaseArtifactProgress, summarizeDatabaseArtifactProgress } = await loadWaveModule();
  const progress = buildDatabaseArtifactProgress([
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/buffer-pool.js',
    'quality/database-design.json',
  ], {
    benchRequiredModuleFiles: [
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/storage-engine.js',
    ],
    verificationScriptAudit: {
      command: 'npm',
      args: ['run', 'bench', '--', '--dry-run'],
      exitCode: 1,
      stderr: 'RangeError: Maximum call stack size exceeded',
      stdout: '',
    },
  });

  assert.equal(progress.designDocs.completed, true);
  assert.equal(progress.prototypeTopLevel.completed, true);
  assert.equal(progress.prototypeModules.completed, false);
  assert.equal(progress.prototypeModules.count, 1);
  assert.equal(progress.benchmarkSelfCheck.attempted, true);
  assert.equal(progress.benchmarkSelfCheck.passed, false);

  const summary = summarizeDatabaseArtifactProgress(progress);
  assert.match(summary, /design docs complete/i);
  assert.match(summary, /prototype top-level files complete/i);
  assert.match(summary, /prototype src depth incomplete \(1 files present\)/i);
  assert.match(summary, /quality evidence present: quality\/database-design\.json/i);
  assert.doesNotMatch(summary, /quality\/database-benchmark-result\.json/i);
  assert.match(summary, /benchmark self-check failed/i);
});

test('database prototype top-level batching prioritizes package and readme before bench script', async () => {
  const { getDatabaseLabNextPrototypeTopLevelTargets } = await loadWaveModule();
  const targets = getDatabaseLabNextPrototypeTopLevelTargets({
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ],
  }, 2);

  assert.deepEqual(targets, [
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
  ]);
});

test('database prototype module batching expands past a single imported dependency once it already exists', async () => {
  const { getDatabaseLabNextPrototypeModuleTargets } = await loadWaveModule();
  const targets = getDatabaseLabNextPrototypeModuleTargets({
    workspaceRelativeFiles: [
      'database-lab/prototype/src/storage-engine.js',
    ],
  }, 2, [
    'database-lab/prototype/src/storage-engine.js',
  ]);

  assert.deepEqual(targets, [
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/b-plus-tree-index.js',
  ]);
});

test('database early-stop guard does not cut off a still-running scenario just because benchmark evidence exists', async () => {
  const { shouldStopScenarioEarly } = await loadWaveModule();
  const stopEarly = shouldStopScenarioEarly(
    { id: 'database-near-mysql-design' },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            toolId: 'run_command',
            status: 'SUCCEEDED',
            activityId: 'tool_bench_ok',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: '{"status":"success","summary":"ok","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
          },
        ],
      },
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              verdict: 'passed',
            },
          },
        },
      },
      workspaceRelativeFiles: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'quality/database-design.json',
      ],
    },
  );

  assert.equal(stopEarly, false);
});

test('database early-stop guard rejects dry-run benchmark output that lacks summary and metrics', async () => {
  const { shouldStopScenarioEarly } = await loadWaveModule();
  const stopEarly = shouldStopScenarioEarly(
    { id: 'database-near-mysql-design' },
    {
      summary: {
        lifecycleStatus: 'COMPLETED',
        visibleToolActivities: [
          {
            toolId: 'run_command',
            status: 'SUCCEEDED',
            activityId: 'tool_bench_incomplete',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: '{"status":"dry-run","message":"Benchmark scaffold validated. Pass without --dry-run to execute.","opts":{"dryRun":true}}',
          },
        ],
      },
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              verdict: 'passed',
            },
          },
        },
      },
      workspaceRelativeFiles: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
      ],
    },
  );

  assert.equal(stopEarly, false);
});

test('database artifact progress keeps prototype top-level incomplete when package.json omits bench entry', async () => {
  const { buildDatabaseArtifactProgress, summarizeDatabaseArtifactProgress } = await loadWaveModule();
  const progress = buildDatabaseArtifactProgress([
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/storage-engine.js',
  ], {
    packageEntryDiagnostics: {
      packageJsonFound: true,
      invalidPackageJson: false,
      parseError: null,
      checkedEntries: [],
      missingEntryRefs: [],
      missingRequiredEntries: ['scripts.bench_or_dry-run'],
    },
    benchRequiredModuleFiles: [
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/storage-engine.js',
    ],
  });

  assert.equal(progress.prototypeTopLevel.completed, false);
  assert.ok(progress.prototypeTopLevel.missing.includes('package-entry:scripts.bench_or_dry-run'));
  assert.match(summarizeDatabaseArtifactProgress(progress), /package entry requirements missing: scripts\.bench_or_dry-run/i);
});

test('database benchmark self-check accepts completed status when metrics are present', async () => {
  const { evaluateDatabaseBenchmarkSelfCheck } = await loadWaveModule();
  const result = evaluateDatabaseBenchmarkSelfCheck({
    command: 'npm',
    args: ['run', 'bench', '--', '--dry-run'],
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      status: 'completed',
      summary: 'dry run completed',
      metrics: {
        pagesWritten: 1,
        pagesRead: 1,
        writeDurationMs: 2,
        readDurationMs: 3,
        totalDurationMs: 5,
      },
    }),
  });

  assert.equal(result.passed, true);
  assert.equal(result.parsedStatus, 'completed');
});

test('database benchmark self-check accepts dry-run status when metrics are present', async () => {
  const { evaluateDatabaseBenchmarkSelfCheck } = await loadWaveModule();
  const result = evaluateDatabaseBenchmarkSelfCheck({
    command: 'npm',
    args: ['run', 'bench', '--', '--dry-run'],
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      status: 'dry-run',
      summary: 'benchmark scaffold validated',
      metrics: {
        pagesWritten: 0,
        pagesRead: 0,
        writeDurationMs: 0,
        readDurationMs: 0,
        totalDurationMs: 0,
      },
    }),
  });

  assert.equal(result.passed, true);
  assert.equal(result.parsedStatus, 'dry-run');
});

test('database verify audit treats missing main entry as optional when bench evidence is otherwise valid', async () => {
  const {
    getBlockingDatabasePackageEntryRefs,
    buildDatabaseArtifactProgress,
    summarizeDatabaseArtifactProgress,
  } = await loadWaveModule();
  const packageEntryDiagnostics = {
    packageJsonFound: true,
    invalidPackageJson: false,
    parseError: null,
    checkedEntries: [
      { entry: 'main', target: 'src/index.js', present: false },
      { entry: 'scripts.bench', target: 'scripts/bench.js', present: true },
    ],
    missingEntryRefs: ['main:src/index.js'],
    missingRequiredEntries: [],
  };
  const blockingMissingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
    scenarioId: 'database-near-mysql-verify',
  });
  const optionalMissingEntryRefs = packageEntryDiagnostics.missingEntryRefs.filter(
    (entryRef) => !blockingMissingEntryRefs.includes(entryRef),
  );
  const progress = buildDatabaseArtifactProgress([
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/storage-engine.js',
    'database-lab/prototype/src/buffer-pool.js',
    'quality/database-design.json',
    'quality/database-benchmark-result.json',
  ], {
    packageEntryDiagnostics,
    blockingMissingEntryRefs,
    optionalMissingEntryRefs,
    includeVerifyQualityEvidence: true,
    verificationScriptAudit: {
      command: 'npm',
      args: ['run', 'bench', '--', '--dry-run'],
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        status: 'completed',
        summary: 'dry run completed',
        metrics: {
          pagesWritten: 1,
          pagesRead: 1,
          writeDurationMs: 2,
          readDurationMs: 3,
          totalDurationMs: 5,
        },
      }),
    },
  });

  assert.deepEqual(blockingMissingEntryRefs, []);
  assert.deepEqual(progress.packageEntryRefs.missingBlocking, []);
  assert.deepEqual(progress.packageEntryRefs.missingOptional, ['main:src/index.js']);
  assert.match(summarizeDatabaseArtifactProgress(progress), /optional\/missing: main:src\/index\.js/i);
});

test('database scenario classification keeps environment blocker and current artifact progress together', async () => {
  const { buildDatabaseArtifactProgress, classifyScenario } = await loadWaveModule();
  const artifactProgress = buildDatabaseArtifactProgress([
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/storage-engine.js',
    'quality/database-design.json',
  ], {
    benchRequiredModuleFiles: [
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/wal.js',
      'database-lab/prototype/src/transaction-manager.js',
    ],
    verificationScriptAudit: {
      command: 'npm',
      args: ['run', 'bench', '--', '--dry-run'],
      exitCode: null,
      stderr: '',
      stdout: '',
    },
  });

  const result = classifyScenario(
    { id: 'database-near-mysql-design' },
    {
      summary: {
        lifecycleStatus: 'FAILED',
        visibleToolActivities: [],
      },
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: { verdict: 'failed' },
            quality: { verdict: 'failed' },
          },
          issueCategory: 'timeout',
          issueSummary: 'request timed out while continuing the scaffold',
          providerSummary: {
            lastMessage: 'backend_new provider error: openai-compatible rate-limited or timed out upstream (408): request timed out',
            recentStatus: '408',
          },
          capabilityWarnings: [],
        },
      },
      task: {
        diagnostics: {
          providerFailure: {
            message: 'backend_new provider error: openai-compatible rate-limited or timed out upstream (408): request timed out',
            kind: 'TIMEOUT',
            category: 'timeout',
            statusCode: 408,
            retryable: true,
            timeoutOrigin: 'upstream_http_408',
            elapsedMs: 45032,
            requestTimeoutMs: 45000,
            retryAttempt: 2,
          },
        },
        latestVisibleOutput: {
          summary: 'request timed out while continuing the scaffold',
          details: null,
        },
        completionSummary: null,
      },
    },
    {
      human: { pass: true },
      agent: { pass: true },
      web: { pass: true },
    },
    {
      pass: false,
      buildAudit: { packageJsonFound: true },
      notes: { artifactProgress },
    },
  );

  assert.equal(result.classification, 'environment_blocker');
  assert.match(result.reason, /Current artifact progress:/);
  assert.match(result.reason, /design docs complete/i);
  assert.match(result.reason, /prototype src depth incomplete \(2 files present\)/i);
  assert.match(result.reason, /benchmark module prerequisites missing:/i);
  assert.match(result.reason, /benchmark self-check failed/i);
  assert.match(result.reason, /timeoutOrigin=upstream_http_408/);
  assert.match(result.reason, /elapsedMs=45032/);
});

test('database continue suppression blocks duplicate phase instructions while workspace is unchanged', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
    ],
  };

  const suppressed = shouldSuppressDuplicateContinueInstruction(
    {
      message: 'write the next design batch',
      metadata: {
        uniqueKey: 'database_lab:design_docs:database-lab/design/README.md|database-lab/design/architecture.md',
      },
    },
    scenarioState,
    [
      {
        lifecycleStatus: 'RUNNING',
        workspaceFingerprint: 'database-lab/design/architecture.md|database-lab/design/README.md',
        metadata: {
          uniqueKey: 'database_lab:design_docs:database-lab/design/README.md|database-lab/design/architecture.md',
        },
      },
    ],
  );

  assert.equal(suppressed, true);
});

test('database continue suppression does not block an identical retry after inspection-only targeted reads', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
    ],
  };

  const suppressed = shouldSuppressDuplicateContinueInstruction(
    {
      message: 'repair the next narrow prototype batch',
      metadata: {
        uniqueKey: 'database_lab:prototype_contract_repair:database-lab/prototype/scripts/bench.js|database-lab/prototype/src/storage-engine.js',
      },
    },
    scenarioState,
    [
      {
        lifecycleStatus: 'RUNNING',
        workspaceFingerprint: 'database-lab/design/architecture.md|database-lab/design/README.md',
        observedWriteCount: 0,
        observedReadCount: 2,
        observedToolIds: ['read_file', 'read_file'],
        metadata: {
          allowTargetedReadInspection: true,
          uniqueKey: 'database_lab:prototype_contract_repair:database-lab/prototype/scripts/bench.js|database-lab/prototype/src/storage-engine.js',
        },
      },
    ],
  );

  assert.equal(suppressed, false);
});

test('continue suppression treats list and search as inspection-only when explicitly allowed', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    workspaceRelativeFiles: [
      'quality/web-audit.json',
    ],
  };

  const suppressed = shouldSuppressDuplicateContinueInstruction(
    {
      message: 'write the external blog updates',
      metadata: {
        uniqueKey: 'path-blog-followup:path-blog-delivery',
      },
    },
    scenarioState,
    [
      {
        lifecycleStatus: 'RUNNING',
        workspaceFingerprint: 'quality/web-audit.json',
        observedWriteCount: 0,
        observedReadCount: 0,
        observedToolIds: ['list_files', 'search_files'],
        metadata: {
          allowTargetedReadInspection: true,
          uniqueKey: 'path-blog-followup:path-blog-delivery',
        },
      },
    ],
  );

  assert.equal(suppressed, false);
});

test('database continue suppression blocks prototype repair read-only drift when targeted inspection was not allowed', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
    ],
  };

  const suppressed = shouldSuppressDuplicateContinueInstruction(
    {
      message: 'repair the next narrow prototype batch',
      metadata: {
        uniqueKey: 'database_lab:prototype_contract_repair:database-lab/prototype/scripts/bench.js|database-lab/prototype/src/storage-engine.js',
      },
    },
    scenarioState,
    [
      {
        lifecycleStatus: 'RUNNING',
        workspaceFingerprint: 'database-lab/design/architecture.md|database-lab/design/README.md|database-lab/prototype/scripts/bench.js|database-lab/prototype/src/storage-engine.js',
        observedWriteCount: 0,
        observedReadCount: 2,
        observedToolIds: ['read_file', 'read_file'],
        metadata: {
          strategy: 'database_lab_scaffold',
          phase: 'prototype_contract_repair',
          uniqueKey: 'database_lab:prototype_contract_repair:database-lab/prototype/scripts/bench.js|database-lab/prototype/src/storage-engine.js',
        },
      },
    ],
  );

  assert.equal(suppressed, true);
});

test('database continue suppression allows one retry after a no-tool correction turn', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const uniqueKey = 'database_lab:prototype_modules:database-lab/prototype/src/wal-manager.js|database-lab/prototype/src/transaction-manager.js';
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        engineStatus: 'FAILED',
        pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
        executionLease: { active: false },
      },
      toolInvocations: [],
    },
    workspaceRelativeFiles: [
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
    ],
  };
  const instruction = {
    message: 'write the remaining prototype modules',
    metadata: {
      uniqueKey,
    },
  };
  const firstAttempt = {
    issuedAt: 1000,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint: 'database-lab/prototype/src/b-plus-tree-index.js|database-lab/prototype/src/buffer-pool.js|database-lab/prototype/src/storage-engine.js',
    metadata: { uniqueKey },
  };

  assert.equal(shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [firstAttempt]), false);
  assert.equal(
    shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [
      firstAttempt,
      { ...firstAttempt, issuedAt: 2000 },
    ]),
    true,
  );
});

test('database continue drift detection stops write-only repair turns that emit forbidden tools', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'read_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/scripts/bench.js' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'bench_api_repair',
        allowedTools: ['write_file'],
        allowedPaths: ['database-lab/prototype/scripts/bench.js'],
      },
    },
  );

  assert.match(drift, /forbidden tool/i);
  assert.match(drift, /read_file/i);
});

test('database continue drift detection accepts write-only repair turns that stay on allowed paths', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/scripts/bench.js' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'bench_api_repair',
        allowedTools: ['write_file'],
        allowedPaths: ['database-lab/prototype/scripts/bench.js'],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection accepts extra required design docs in the design phase', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/design/README.md' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            startedAt: 220,
            arguments: { path: 'database-lab/design/sql-compatibility.md' },
          },
          {
            invocationId: 'tool_3',
            toolId: 'write_file',
            startedAt: 240,
            arguments: { path: 'database-lab/design/benchmark-plan.md' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'design_docs',
        allowedTools: ['write_file'],
        targetPaths: ['database-lab/design/README.md'],
        allowedOptionalPaths: [
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
        ],
      },
    },
  );

  assert.equal(drift, null);
});

test('database design doc path drift is recoverable when progress narrows to missing canonical docs', async () => {
  const {
    detectContinueInstructionDrift,
    isRecoverableContinueInstructionDrift,
    deriveContinueMessage,
  } = await loadWaveModule();
  const attempt = {
    issuedAt: 100,
    observedSinceAt: 100,
    metadata: {
      phase: 'design_docs',
      allowedTools: ['write_file'],
      targetPaths: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
      ],
      allowedPaths: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
      ],
      uniqueKey: 'database_lab:design_docs:initial',
    },
  };
  const scenarioState = {
    summary: { lifecycleStatus: 'RUNNING' },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/design/transactions-concurrency.md',
    ],
    task: {
      toolInvocations: [
        {
          invocationId: 'read_1',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          startedAt: 10,
          arguments: { path: 'brief/workload-profile.md' },
        },
        {
          invocationId: 'read_2',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          startedAt: 20,
          arguments: { path: 'brief/mysql-targets.md' },
        },
        {
          invocationId: 'read_3',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          startedAt: 30,
          arguments: { path: 'brief/constraints.md' },
        },
        {
          invocationId: 'tool_1',
          toolId: 'write_file',
          status: 'SUCCEEDED',
          startedAt: 200,
          arguments: { path: 'database-lab/design/README.md' },
        },
        {
          invocationId: 'tool_2',
          toolId: 'write_file',
          status: 'SUCCEEDED',
          startedAt: 220,
          arguments: { path: 'database-lab/design/storage-engine.md' },
        },
        {
          invocationId: 'tool_3',
          toolId: 'write_file',
          status: 'SUCCEEDED',
          startedAt: 240,
          arguments: { path: 'database-lab/design/benchmark-plan.md' },
        },
        {
          invocationId: 'tool_4',
          toolId: 'write_file',
          status: 'SUCCEEDED',
          startedAt: 260,
          arguments: { path: 'database-lab/design/transactions-concurrency.md' },
        },
      ],
    },
  };

  const drift = detectContinueInstructionDrift(scenarioState, attempt);
  assert.match(drift, /transactions-concurrency\.md/);
  assert.equal(
    isRecoverableContinueInstructionDrift(
      { id: 'database-near-mysql-design' },
      scenarioState,
      attempt,
      drift,
      [attempt],
    ),
    true,
  );

  const nextInstruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(nextInstruction.metadata.phase, 'design_docs');
  assert.deepEqual(nextInstruction.metadata.targetPaths, [
    'database-lab/design/architecture.md',
  ]);
  assert.match(nextInstruction.message, /Leave the remaining files for the next repair pass: database-lab\/design\/sql-compatibility\.md/);
  assert.doesNotMatch(nextInstruction.message, /transactions-concurrency\.md/);
});

test('database continue drift detection accepts early manifest write after targeted design docs are satisfied', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 200,
            arguments: { path: 'database-lab/design/README.md' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 220,
            arguments: { path: 'quality/database-design.json' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'design_docs',
        allowedTools: ['write_file'],
        targetPaths: ['database-lab/design/README.md'],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection still rejects manifest-only writes during design docs', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 200,
            arguments: { path: 'quality/database-design.json' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'design_docs',
        allowedTools: ['write_file'],
        targetPaths: ['database-lab/design/README.md'],
      },
    },
  );

  assert.match(drift, /path drift/i);
  assert.match(drift, /quality\/database-design\.json/i);
});

test('database continue drift detection accepts benchmark run after required prototype repair writes', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/scripts/bench.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 220,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
          {
            invocationId: 'tool_3',
            toolId: 'run_command',
            status: 'FAILED',
            startedAt: 240,
            arguments: { command: 'npm.cmd run bench -- --dry-run', cwd: 'database-lab/prototype' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'prototype_contract_repair',
        allowedTools: ['write_file'],
        targetPaths: [
          'database-lab/prototype/scripts/bench.js',
          'database-lab/prototype/src/storage-engine.js',
        ],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection falls back to targetPaths for exact write-only batches', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/src/wal.js' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'prototype_modules',
        allowedTools: ['write_file'],
        targetPaths: ['database-lab/prototype/src/wal-manager.js'],
      },
    },
  );

  assert.match(drift, /path drift/i);
  assert.match(drift, /wal\.js/i);
});

test('database continue drift detection rejects forbidden manifest writes during prototype module batches', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            startedAt: 220,
            arguments: { path: 'quality/database-design.json' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'prototype_modules',
        allowedTools: ['write_file'],
        targetPaths: [
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
        ],
        forbiddenWritePaths: ['quality/database-design.json'],
      },
    },
  );

  assert.match(drift, /forbidden write path/i);
  assert.match(drift, /quality\/database-design\.json/i);
});

test('database continue drift detection rejects COMPLETE tracker for partial prototype module batches', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        runtime: {
          progressHistory: [
            {
              currentUnit: 'AGENT-001',
              status: 'IN_PROGRESS',
              progressPercent: 40,
              decision: 'CONTINUE',
              reason: 'Earlier phase',
              nextUnit: null,
              filesCreated: [],
            },
            {
              currentUnit: 'AGENT-001',
              status: 'COMPLETE',
              progressPercent: 80,
              decision: 'CONTINUE',
              reason: 'Wrote two prototype modules and will continue later.',
              nextUnit: null,
              filesCreated: [
                'database-lab/prototype/src/storage-engine.js',
                'database-lab/prototype/src/buffer-pool.js',
              ],
            },
          ],
        },
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            startedAt: 220,
            arguments: { path: 'database-lab/prototype/src/buffer-pool.js' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      trackerCountAtIssue: 1,
      metadata: {
        phase: 'prototype_modules',
        allowedTools: ['write_file'],
        targetPaths: [
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
        ],
        requiredTrackerStatus: 'IN_PROGRESS',
        requiredTrackerDecision: 'CONTINUE',
      },
    },
  );

  assert.match(drift, /invalid tracker status/i);
  assert.match(drift, /expected IN_PROGRESS, got COMPLETE/i);
});

test('database bench dependency extraction canonicalizes legacy module aliases', async () => {
  const { extractDatabaseLabBenchRequiredModuleFiles } = await loadWaveModule();
  const files = extractDatabaseLabBenchRequiredModuleFiles([
    "const { StorageEngine } = require('../src/storage-engine.js');",
    "const { BufferPool } = require('../src/buffer-pool.js');",
    "const { WAL } = require('../src/wal.js');",
    "const { BPlusTreeIndex } = require('../src/b-plus-tree.js');",
    "const { TransactionManager } = require('../src/transaction-manager.js');",
  ].join('\n'));

  assert.deepEqual(files, [
    'database-lab/prototype/src/storage-engine.js',
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/wal-manager.js',
    'database-lab/prototype/src/b-plus-tree-index.js',
    'database-lab/prototype/src/transaction-manager.js',
  ]);
});

test('real-task-wave live model defaults to flash for non-database scenarios and strong for database scenarios', async () => {
  const { resolveRealTaskWaveLiveModel } = await loadWaveModule();
  const original = process.env.REAL_TASK_WAVE_LIVE_MODEL;
  delete process.env.REAL_TASK_WAVE_LIVE_MODEL;
  try {
    assert.equal(resolveRealTaskWaveLiveModel([{ id: 'docs-normalize-batch' }]), 'mimo-v2-flash');
    assert.equal(resolveRealTaskWaveLiveModel([{ id: 'database-near-mysql-design' }]), 'mimo-v2.5');
  } finally {
    if (typeof original === 'string') {
      process.env.REAL_TASK_WAVE_LIVE_MODEL = original;
    } else {
      delete process.env.REAL_TASK_WAVE_LIVE_MODEL;
    }
  }
});

test('database prototype diagnostics report benchmark-called StorageEngine methods that do not exist', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine({ pageSize: 4096 });',
        '  await engine.open();',
        '  const pageId = engine.allocatePageId();',
        '  await engine.close();',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2, pageId } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  constructor(options = {}) { this.options = options; }',
        '  close() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_missing_method:open'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_missing_method:allocatePageId'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /missing benchmark-called engine methods line up: open, allocatePageId/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype contract repair stays write-only when current source is embedded', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/README.md',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'near-mysql-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        "'use strict';",
        'class StorageEngine {',
        '  constructor(options = {}) { this.options = options; }',
        '  close() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine({ pageSize: 4096 });',
        '  await engine.open();',
        '  const pageId = engine.allocatePageId();',
        '  await engine.close();',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2, pageId } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'quality', 'database-design.json'),
      JSON.stringify({
        profile: 'database_near_mysql_design',
        designFiles: [
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
        ],
        prototypeFiles: [
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          ...coreModuleFiles,
        ],
        implementedModules: coreModuleFiles,
      }, null, 2),
      'utf8',
    );

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        summary: {
          lifecycleStatus: 'RUNNING',
          visibleToolActivities: [
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          ],
        },
        debug: {
          executionSummary: {
            providerSummary: { modelId: 'mimo-v2.5' },
            acceptance: {
              quality: {
                profileId: 'database_near_mysql_design',
                verdict: 'failed',
                failedChecks: ['benchmark_self_check_failed'],
                requiredNextEvidence: ['repair the benchmark scaffold before rerunning the dry-run benchmark'],
              },
            },
          },
        },
        workspaceDir,
        workspaceRelativeFiles: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          ...coreModuleFiles,
          'quality/database-design.json',
        ],
      },
    );

    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.equal(instruction.metadata.allowTargetedReadInspection, true);
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.match(instruction.message, /missing StorageEngine methods called/i);
    assert.match(instruction.message, /one narrow re-read is still necessary/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('path blog finalization switches to output and complete tracker when only tracker remains incomplete', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'quality/web-audit.json', resultSummary: 'quality/web-audit.json' },
        ],
      },
      task: {
        latestVisibleOutput: {
          summary: 'Created the blog website in D:/AAA.',
          details: 'index.html, styles.css, and script.js were written and quality/web-audit.json passed.',
          artifactPaths: ['D:/AAA/index.html', 'D:/AAA/styles.css', 'D:/AAA/script.js', 'quality/web-audit.json'],
        },
      },
      workspaceRelativeFiles: ['quality/web-audit.json'],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'passed', requiredNextEvidence: [] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: {
                verdict: 'failed',
                failedChecks: ['tracker_not_complete:in_progress'],
                requiredNextEvidence: [],
              },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'passed',
              requiredNextEvidence: [],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'tracker_only_finalization');
  assert.equal(instruction.metadata.phase, 'finalize');
  assert.deepEqual(instruction.metadata.allowedTools, []);
  assert.match(instruction.message, /status to COMPLETE/i);
  assert.doesNotMatch(instruction.message, /write_file/i);
});

test('path blog repair writes missing web audit to workspace instead of delivery folder', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
        ],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'passed', requiredNextEvidence: [] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_web_audit'],
              requiredNextEvidence: ['write quality/web-audit.json'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_quality_evidence');
  assert.equal(instruction.metadata.phase, 'web_audit_repair');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file']);
  assert.deepEqual(instruction.metadata.allowedWritePaths, ['quality/web-audit.json']);
  assert.match(instruction.message, /arguments\.path set to the relative task-workspace path "quality\/web-audit\.json"/i);
  assert.match(instruction.message, /Do not create or write D:\/AAA\/quality\/web-audit\.json/i);
});

test('path blog repair narrows JavaScript syntax failures to script rewrite and syntax check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'quality/web-audit.json', resultSummary: 'quality/web-audit.json' },
        ],
      },
      workspaceRelativeFiles: ['quality/web-audit.json'],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: {
                verdict: 'failed',
                failedChecks: [
                  'pending_correction:awaiting_tool_action',
                  'issue:quality:javascript_syntax_error:D:/AAA/script.js',
                ],
                requiredNextEvidence: ['emit_real_tool_or_verification_evidence'],
              },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['javascript_syntax_error:D:/AAA/script.js'],
              requiredNextEvidence: ['repair JavaScript syntax in D:/AAA/script.js (Invalid or unexpected token)'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_script_syntax_repair');
  assert.equal(instruction.metadata.phase, 'web_script_syntax_repair');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'run_command']);
  assert.match(instruction.message, /Do not rewrite index\.html, styles\.css, or any quality JSON/i);
  assert.match(instruction.message, /node --check D:\/AAA\/script\.js/i);
  assert.doesNotMatch(instruction.message, /\\"D:\\AAA\\script\.js\\"/i);
  assert.ok(instruction.metadata.forbiddenWritePaths.includes('quality/web-audit.json'));
});

test('database continue drift detection permits targeted read inspection during prototype repair when explicitly allowed', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const attempt = {
    issuedAt: 100,
    metadata: {
      phase: 'prototype_contract_repair',
      allowTargetedReadInspection: true,
      allowedTools: ['write_file', 'read_file'],
      allowedPaths: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    },
  };
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'read_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/scripts/bench.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'read_file',
            startedAt: 220,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
        ],
      },
    },
    attempt,
  );

  assert.equal(drift, null);
  assert.equal(attempt.observedWriteCount, 0);
  assert.equal(attempt.observedReadCount, 2);
  assert.deepEqual(attempt.observedToolIds, ['read_file', 'read_file']);
});

test('database continue drift detection permits optional design manifest sync during prototype repair', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            startedAt: 220,
            arguments: { path: 'quality/database-design.json' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'prototype_contract_repair',
        allowedTools: ['write_file'],
        allowedPaths: ['database-lab/prototype/src/storage-engine.js'],
        allowedOptionalPaths: ['quality/database-design.json'],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection permits additional prototype src writes when prototype module phase allows src prefix', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'write_file',
            startedAt: 200,
            arguments: { path: 'database-lab/prototype/src/storage-engine.js' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'write_file',
            startedAt: 220,
            arguments: { path: 'database-lab/prototype/src/query-executor.js' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'prototype_modules',
        allowedTools: ['write_file'],
        allowedPaths: [
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
        ],
        allowedPathPrefixes: ['database-lab/prototype/src/'],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection still catches forbidden tools when attempt timestamp is recorded after command dispatch', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'read_file',
            startedAt: 950,
            arguments: { path: 'database-lab/prototype/scripts/bench.js' },
          },
        ],
      },
    },
    {
      issuedAt: 1000,
      observedSinceAt: 900,
      metadata: {
        phase: 'bench_api_repair',
        allowedTools: ['write_file'],
        allowedPaths: ['database-lab/prototype/scripts/bench.js'],
      },
    },
  );

  assert.match(drift, /forbidden tool/i);
  assert.match(drift, /read_file/i);
});

test('database continue drift detection ignores forbidden tools that finished before the continue instruction was issued', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_before',
            toolId: 'create_folder',
            startedAt: 990,
            arguments: { path: 'database-lab/design' },
          },
          {
            invocationId: 'tool_after_1',
            toolId: 'read_file',
            startedAt: 1010,
            arguments: { path: 'brief/workload-profile.md' },
            status: 'SUCCEEDED',
          },
          {
            invocationId: 'tool_after_2',
            toolId: 'read_file',
            startedAt: 1020,
            arguments: { path: 'brief/mysql-targets.md' },
            status: 'SUCCEEDED',
          },
          {
            invocationId: 'tool_after_3',
            toolId: 'read_file',
            startedAt: 1030,
            arguments: { path: 'brief/constraints.md' },
            status: 'SUCCEEDED',
          },
        ],
      },
    },
    {
      issuedAt: 1000,
      observedSinceAt: 1000,
      metadata: {
        phase: 'brief_read',
        allowedTools: ['list_files', 'read_file'],
        allowedPaths: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
        ],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection permits list_files during grounded brief reads', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'list_files',
            startedAt: 200,
            arguments: { path: 'brief' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'read_file',
            startedAt: 220,
            arguments: { path: 'brief/workload-profile.md' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'brief_read',
        allowedTools: ['list_files', 'read_file'],
        allowedPaths: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
        ],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection tolerates inspection after benchmark command evidence', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1500,
            arguments: { command: 'npm.cmd run bench -- --dry-run' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'list_files',
            status: 'SUCCEEDED',
            startedAt: 1510,
            arguments: { path: 'database-lab/prototype' },
          },
        ],
      },
    },
    {
      issuedAt: 1000,
      metadata: {
        phase: 'benchmark_self_check',
        allowedTools: ['run_command'],
        allowedPaths: ['database-lab/prototype/scripts/bench.js'],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue drift detection tolerates brief read filename guesses once the required brief files are successfully read in the same turn', async () => {
  const { detectContinueInstructionDrift } = await loadWaveModule();
  const drift = detectContinueInstructionDrift(
    {
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_1',
            toolId: 'list_files',
            status: 'SUCCEEDED',
            startedAt: 200,
            arguments: { path: 'brief/' },
          },
          {
            invocationId: 'tool_2',
            toolId: 'read_file',
            status: 'FAILED',
            startedAt: 210,
            arguments: { path: 'brief/workload.md' },
          },
          {
            invocationId: 'tool_3',
            toolId: 'read_file',
            status: 'FAILED',
            startedAt: 220,
            arguments: { path: 'brief/targets.md' },
          },
          {
            invocationId: 'tool_4',
            toolId: 'read_file',
            status: 'SUCCEEDED',
            startedAt: 230,
            arguments: { path: 'brief/workload-profile.md' },
          },
          {
            invocationId: 'tool_5',
            toolId: 'read_file',
            status: 'SUCCEEDED',
            startedAt: 240,
            arguments: { path: 'brief/mysql-targets.md' },
          },
          {
            invocationId: 'tool_6',
            toolId: 'read_file',
            status: 'SUCCEEDED',
            startedAt: 250,
            arguments: { path: 'brief/constraints.md' },
          },
        ],
      },
    },
    {
      issuedAt: 100,
      metadata: {
        phase: 'brief_read',
        allowedTools: ['list_files', 'read_file'],
        allowedPaths: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
        ],
      },
    },
  );

  assert.equal(drift, null);
});

test('database continue prompt advances to prototype top-level after design docs are complete', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'prototype_top_level');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js',
  ]);
  assert.match(instruction.message, /If runtime acceptance still requires quality\/database-design\.json after this top-level batch/i);
  assert.match(instruction.message, /prefer write_file\.arguments\.content_json/i);
});

test('database continue prompt batches all core prototype modules for strong-model design scaffolds', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'prototype_modules');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/prototype/src/storage-engine.js',
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/b-plus-tree-index.js',
    'database-lab/prototype/src/wal-manager.js',
    'database-lab/prototype/src/transaction-manager.js',
  ]);
  assert.deepEqual(instruction.metadata.allowedWritePaths, [
    'database-lab/prototype/src/storage-engine.js',
    'database-lab/prototype/src/buffer-pool.js',
    'database-lab/prototype/src/b-plus-tree-index.js',
    'database-lab/prototype/src/wal-manager.js',
    'database-lab/prototype/src/transaction-manager.js',
  ]);
  assert.deepEqual(instruction.metadata.allowedOptionalPaths, [
    'quality/database-design.json',
  ]);
  assert.deepEqual(instruction.metadata.forbiddenWritePaths, []);
  assert.equal(instruction.metadata.requiredTrackerStatus, 'IN_PROGRESS');
  assert.equal(instruction.metadata.requiredTrackerDecision, 'CONTINUE');
  assert.match(instruction.message, /Write only these concrete implementation modules now/i);
  assert.match(instruction.message, /If runtime acceptance still requires quality\/database-design\.json after this batch/i);
  assert.match(instruction.message, /final tracker must use exactly status IN_PROGRESS and decision CONTINUE/i);
});

test('database continue prompt permits benchmark companion src module writes when bench.js is the remaining top-level target', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'prototype_top_level');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/prototype/scripts/bench.js',
  ]);
  assert.ok(
    instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/src/storage-engine.js'),
    JSON.stringify(instruction.metadata, null, 2),
  );
  assert.ok(
    instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/src/transaction-manager.js'),
    JSON.stringify(instruction.metadata, null, 2),
  );
});

test('database continue prompt does not jump to benchmark or API repair while core prototype modules are still missing', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'module.exports = { runBenchmark };',
      ].join('\n'),
      'utf8',
    );
    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        task: {
          runtime: {
            schedulerUnits: {
              'AGENT-001': {
                invalidOutputErrors: [
                  'quality_gate_failed:benchmark_self_check_output_invalid',
                ],
              },
            },
          },
        },
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: [
                'benchmark_self_check_output_invalid',
                'missing_core_module:database-lab/prototype/src/b-plus-tree-index.js',
                'benchmark_dependency_missing:database-lab/prototype/src/wal-manager.js',
              ],
              requiredNextEvidence: [
                'repair database-lab/prototype/scripts/bench.js so the successful dry-run stdout is one parseable JSON object',
              ],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_modules');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/prototype/src/b-plus-tree-index.js',
    'database-lab/prototype/src/wal-manager.js',
    'database-lab/prototype/src/transaction-manager.js',
  ]);
    assert.doesNotMatch(instruction.message, /Run a real dry-run benchmark/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design continue defers to runtime required evidence once scaffold exists and a tool repair is pending', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-db-runtime-required-'));
  try {
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
    ]) {
      const absolutePath = path.join(workspaceDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'placeholder\n');
    }

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        workspaceDir,
        workspaceRelativeFiles: [
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
          'database-lab/prototype/src/b-plus-tree-index.js',
          'database-lab/prototype/src/wal-manager.js',
          'database-lab/prototype/src/transaction-manager.js',
        ],
        task: {
          runtime: {
            pendingCorrection: 'AWAITING_TOOL_ACTION',
          },
          toolInvocations: [
            {
              invocationId: 'tool_failed_bench',
              toolId: 'run_command',
              status: 'FAILED',
              startedAt: 10,
              endedAt: 20,
              result: {
                exitCode: 1,
                stdout: 'bench failed',
                stderr: '',
              },
              error: 'Command failed with exit code 1.',
            },
          ],
        },
        debug: {
          executionSummary: {
            issueCategory: 'tool_execution_failure',
            acceptance: {
              deterministic: {
                contract: { requiredNextEvidence: [] },
                execution: { requiredNextEvidence: ['emit_real_tool_or_verification_evidence'] },
                evidence: { requiredNextEvidence: [] },
                outcome: { requiredNextEvidence: [] },
              },
              quality: {
                profileId: 'database_near_mysql_design',
                requiredNextEvidence: ['write quality/database-design.json with designFiles and implementedModules'],
              },
            },
          },
        },
      },
    );

    assert.equal(instruction.metadata.strategy, 'runtime_required_evidence');
    assert.equal(instruction.metadata.phase, 'runtime_required_evidence');
    assert.match(instruction.message, /Drive this turn from runtime acceptance and quality truth only/i);
    assert.match(instruction.message, /write quality\/database-design\.json with designFiles and implementedModules/i);
    assert.doesNotMatch(instruction.message, /First read brief\/workload-profile\.md/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design continue defers to runtime required evidence once real file writes have started, even before full scaffold completion', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-db-runtime-progress-'));
  try {
    for (const relativePath of [
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
    ]) {
      const absolutePath = path.join(workspaceDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'placeholder\n');
    }

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        workspaceDir,
        workspaceRelativeFiles: [
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
        ],
        summary: {
          visibleToolActivities: [
            {
              toolId: 'write_file',
              status: 'SUCCEEDED',
              argumentsSummary: 'database-lab/design/architecture.md',
              resultSummary: 'bytesWritten=1200',
            },
            {
              toolId: 'write_file',
              status: 'SUCCEEDED',
              argumentsSummary: 'database-lab/prototype/package.json',
              resultSummary: 'bytesWritten=320',
            },
          ],
        },
        task: {
          runtime: {
            pendingCorrection: 'AWAITING_TOOL_ACTION',
          },
        },
        debug: {
          executionSummary: {
            acceptance: {
              deterministic: {
                contract: { requiredNextEvidence: [] },
                execution: { requiredNextEvidence: [] },
                evidence: { requiredNextEvidence: [] },
                outcome: { requiredNextEvidence: [] },
              },
              quality: {
                profileId: 'database_near_mysql_design',
                requiredNextEvidence: ['write quality/database-design.json with designFiles and implementedModules'],
              },
            },
          },
        },
      },
    );

    assert.equal(instruction.metadata.strategy, 'runtime_required_evidence');
    assert.equal(instruction.metadata.phase, 'runtime_required_evidence');
    assert.match(instruction.message, /write quality\/database-design\.json with designFiles and implementedModules/i);
    assert.doesNotMatch(instruction.message, /Write only this next narrow batch of missing prototype top-level files/i);
    assert.doesNotMatch(instruction.message, /First read brief\/workload-profile\.md/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design continue defers to runtime required evidence after a real failed tool run even without explicit quality next-evidence entries', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-db-runtime-tool-failure-'));
  try {
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
    ]) {
      const absolutePath = path.join(workspaceDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'placeholder\n');
    }

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        workspaceDir,
        workspaceRelativeFiles: [
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
          'database-lab/prototype/src/b-plus-tree-index.js',
          'database-lab/prototype/src/wal-manager.js',
          'database-lab/prototype/src/transaction-manager.js',
          'quality/database-design.json',
        ],
        summary: {
          visibleToolActivities: [
            {
              toolId: 'write_file',
              status: 'SUCCEEDED',
              argumentsSummary: 'database-lab/prototype/scripts/bench.js',
            },
          ],
        },
        task: {
          runtime: {
            pendingCorrection: 'AWAITING_TOOL_ACTION',
          },
          toolInvocations: [
            {
              invocationId: 'tool_failed_bench_contract',
              toolId: 'run_command',
              status: 'FAILED',
              startedAt: 10,
              endedAt: 20,
              result: {
                exitCode: 1,
                stdout: '',
                stderr: 'TypeError: engine.open is not a function',
              },
              error: 'Command failed with exit code 1.',
            },
          ],
        },
        debug: {
          executionSummary: {
            issueCategory: 'tool_execution_failure',
            acceptance: {
              deterministic: {
                contract: { requiredNextEvidence: [] },
                execution: { requiredNextEvidence: [] },
                evidence: { requiredNextEvidence: [] },
                outcome: { requiredNextEvidence: [] },
              },
              quality: {
                profileId: 'database_near_mysql_design',
                failedChecks: ['benchmark_self_check_failed'],
                requiredNextEvidence: [],
              },
            },
          },
        },
      },
    );

    assert.equal(instruction.metadata.strategy, 'runtime_required_evidence');
    assert.equal(instruction.metadata.phase, 'runtime_required_evidence');
    assert.match(instruction.message, /Use the latest failed tool result as the repair surface/i);
    assert.match(instruction.message, /restrict inspection to the files or stack frames cited by the latest failed tool result/i);
    assert.doesNotMatch(instruction.message, /Write only these concrete implementation modules now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt defers src index companion while core benchmark modules are still missing', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        main: 'src/index.js',
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_modules');
    assert.deepEqual(instruction.metadata.targetPaths, [
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
    ]);
    assert.ok(!instruction.metadata.targetPaths.includes('database-lab/prototype/src/index.js'));
    assert.ok(!instruction.metadata.targetPaths.includes('database-lab/prototype/package.json'));
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt starts strong-model design phase with all required design docs', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'design_docs');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
  ]);
  assert.match(instruction.message, /Land the required design corpus now/i);
});

test('database continue prompt recognizes brief reads from task tool invocations even when visible activities omit them', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [],
    },
    task: {
      toolInvocations: [
        {
          invocationId: 'tool_read_workload',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          arguments: { path: 'brief/workload-profile.md' },
          result: { output: { path: 'brief/workload-profile.md', content: 'OLTP workload brief' } },
        },
        {
          invocationId: 'tool_read_targets',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          arguments: { path: 'brief/mysql-targets.md' },
          result: { output: { path: 'brief/mysql-targets.md', content: 'Compatibility targets' } },
        },
        {
          invocationId: 'tool_read_constraints',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          arguments: { path: 'brief/constraints.md' },
          result: { output: { path: 'brief/constraints.md', content: 'Project constraints' } },
        },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'design_docs');
  assert.deepEqual(instruction.metadata.targetPaths, [
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
  ]);
});

test('database verify prompt can reference existing design docs when prototype files are still missing', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    debug: {
      task: {
        runtime: {
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: [],
            },
          },
        },
      },
      executionSummary: {
        acceptance: {
          quality: {
            failedChecks: ['missing_database_design_manifest'],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
  assert.equal(typeof instruction, 'string');
  assert.match(instruction, /quality\/database-design\.json/i);
  assert.match(instruction, /database-lab\/design\/README\.md/i);
});

test('database verify prompt forces benchmark-first when a seeded scaffold already exists', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    debug: {
      task: {
        runtime: {
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: [
                'quality_gate_failed:missing_benchmark_self_check',
                'quality_gate_failed:missing_database_benchmark_result',
              ],
            },
          },
        },
      },
      executionSummary: {
        acceptance: {
          quality: {
            profileId: 'database_near_mysql_verify',
            verdict: 'failed',
            failedChecks: [
              'missing_benchmark_self_check',
              'missing_database_benchmark_result',
            ],
            requiredNextEvidence: [
              'run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence',
            ],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/bench-data/page_1.bin',
      'database-lab/prototype/bench-wal/wal.log',
      'database-lab/prototype/package-lock.json',
      'quality/database-design.json',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'verify_benchmark_first');
  assert.deepEqual(instruction.metadata.allowedTools, ['run_command', 'read_file', 'list_files']);
  assert.match(instruction.message, /already present in this workspace from the earlier design phase/i);
  assert.match(instruction.message, /Do not recreate folders and do not rewrite existing files/i);
  assert.match(instruction.message, /Your first real action must be one benchmark-related run_command/i);
  assert.match(instruction.message, /Do not emit create_folder in this turn/i);
  assert.match(instruction.message, /Do not emit write_file in this turn unless the benchmark fails/i);
});

test('database verify prompt repairs a failed benchmark before rerunning it', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-verify-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      "const wal = { init() {} };\nw.init();\n",
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      'class WALManager { init() {} }\nmodule.exports = { WALManager };\n',
    );
    const workspaceRelativeFiles = [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
    ];
    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'ReferenceError: w is not defined',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            toolId: 'run_command',
            status: 'FAILED',
            arguments: {
              command: 'npm run bench -- --dry-run',
              workingDirectory: 'database-lab/prototype',
            },
            result: {
              exitCode: 1,
              stdout: '',
              stderr: 'ReferenceError: w is not defined\n    at Object.<anonymous> (database-lab/prototype/scripts/bench.js:2:1)',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: { modelId: 'mimo-v2.5' },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_verify',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: [
                'repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype',
              ],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles,
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'verify_bench_failure_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.match(instruction.message, /ReferenceError: w is not defined/i);
    assert.match(instruction.message, /no undeclared variables/i);
    assert.doesNotMatch(instruction.message, /Your first real action must be one benchmark-related run_command/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database verify prompt repairs current benchmark API drift before trusting old successful evidence', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-verify-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { DatabaseEngine } = require('../src/index');",
        'async function main() {',
        '  const engine = new DatabaseEngine();',
        '  await engine.init();',
        '  await engine.rangeScan(1, 5);',
        '  console.log(JSON.stringify({ status: "dry-run", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } }));',
        '}',
        'main();',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'index.js'),
      [
        'class DatabaseEngine {',
        '  async init() {}',
        '  async rangeQuery() { return []; }',
        '  getStats() { return {}; }',
        '}',
        'module.exports = { DatabaseEngine };',
      ].join('\n'),
    );
    const workspaceRelativeFiles = [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/index.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
      'quality/database-benchmark-result.json',
    ];
    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            toolId: 'run_command',
            status: 'SUCCEEDED',
            activityId: 'tool_old_bench',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: '{"status":"dry-run","summary":"old","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_old_bench',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            arguments: {
              command: 'npm run bench -- --dry-run',
              workingDirectory: 'database-lab/prototype',
            },
            result: {
              exitCode: 0,
              stdout: '{"status":"dry-run","summary":"old","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
              stderr: '',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: { modelId: 'mimo-v2.5' },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_verify',
              verdict: 'failed',
              failedChecks: [
                'benchmark_dependency_untracked:database-lab/prototype/src/index.js',
                'benchmark_self_check_not_grounded',
              ],
              requiredNextEvidence: [
                'list database-lab/prototype/src/index.js in quality/database-design.json implementedModules',
                'rerun the dry-run benchmark only after database-lab/prototype/src contains real modules and database-lab/prototype/scripts/bench.js imports them directly',
              ],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles,
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'verify_bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/index.js'));
    assert.equal(instruction.metadata.allowTargetedReadInspection, true);
    assert.ok(instruction.metadata.allowedTools.includes('read_file'));
    assert.ok(instruction.metadata.allowedReadPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.match(instruction.message, /engine\.rangeScan/i);
    assert.match(instruction.message, /rangeQuery/i);
    assert.match(instruction.message, /Phase-specific exception/i);
    assert.doesNotMatch(instruction.message, /benchmark-plan\.md/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database verify prompt repairs design manifest grounding together with benchmark result evidence', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        {
          toolId: 'run_command',
          status: 'SUCCEEDED',
          activityId: 'tool_fresh_bench',
          argumentsSummary: 'npm run bench -- --dry-run',
          resultSummary: '{"status":"ok","summary":"fresh","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
        },
      ],
    },
    task: {
      toolInvocations: [
        {
          invocationId: 'tool_fresh_bench',
          toolId: 'run_command',
          status: 'SUCCEEDED',
          arguments: {
            command: 'npm run bench -- --dry-run',
            workingDirectory: 'database-lab/prototype',
          },
          result: {
            exitCode: 0,
            stdout: '{"status":"ok","summary":"fresh","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
            stderr: '',
          },
        },
      ],
    },
    debug: {
      executionSummary: {
        acceptance: {
          quality: {
            profileId: 'database_near_mysql_verify',
            verdict: 'failed',
            failedChecks: [
              'core_module_untracked:database-lab/prototype/src/storage-engine.js',
              'benchmark_dependency_untracked:database-lab/prototype/src/storage-engine.js',
              'missing_database_benchmark_result',
            ],
            requiredNextEvidence: [
              'list database-lab/prototype/src/storage-engine.js in quality/database-design.json implementedModules',
              'write quality/database-benchmark-result.json with resultFile and sourceInvocationId',
            ],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
  assert.equal(typeof instruction, 'string');
  assert.match(instruction, /Emit write_file calls for these exact paths/i);
  assert.match(instruction, /quality\/database-design\.json/i);
  assert.match(instruction, /quality\/database-benchmark-result\.json/i);
  assert.match(instruction, /database-lab\/prototype\/results\/bench-dry-run\.json/i);
  assert.match(instruction, /implementedModules lists the real substantive prototype src modules/i);
  assert.match(instruction, /tool_fresh_bench/i);
});

test('database verify prompt reruns benchmark when prior benchmark evidence is stale after bench changes', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        {
          toolId: 'run_command',
          status: 'SUCCEEDED',
          activityId: 'tool_old_bench',
          argumentsSummary: 'npm run bench -- --dry-run',
          resultSummary: '{"status":"dry-run","summary":"validated","metrics":{"pagesWritten":0,"pagesRead":0,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}',
        },
      ],
    },
    task: {
      toolInvocations: [
        {
          invocationId: 'tool_old_bench',
          toolId: 'run_command',
          status: 'SUCCEEDED',
          arguments: {
            command: 'npm run bench -- --dry-run',
          },
          result: {
            exitCode: 0,
            stdout: JSON.stringify({
              status: 'dry-run',
              summary: 'validated',
              metrics: {
                pagesWritten: 0,
                pagesRead: 0,
                writeDurationMs: 0,
                readDurationMs: 0,
                totalDurationMs: 0,
              },
            }),
            stderr: '',
          },
        },
      ],
    },
    debug: {
      task: {
        runtime: {
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: ['quality_gate_failed:benchmark_self_check_stale'],
            },
          },
        },
      },
      executionSummary: {
        acceptance: {
          quality: {
            profileId: 'database_near_mysql_verify',
            verdict: 'failed',
            failedChecks: ['benchmark_self_check_stale'],
            requiredNextEvidence: ['rerun a successful dry-run benchmark command from database-lab/prototype after the latest bench.js or prototype/src changes'],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
      'quality/database-benchmark-result.json',
      'database-lab/prototype/results/bench-dry-run.json',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-verify' }, scenarioState);
  assert.equal(typeof instruction, 'string');
  assert.match(instruction, /evidence is now stale/i);
  assert.match(instruction, /Do not reuse the old invocation ids yet/i);
  assert.match(instruction, /rerun one real dry-run benchmark command/i);
  assert.doesNotMatch(instruction, /Do not rerun the benchmark first/i);
});

test('database design runs a real benchmark self-check before speculative API repair when core scaffold exists', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine();',
        '  await engine.initialize();',
        '  await engine.writePage(1, Buffer.from("row"));',
        '  await engine.readPage(1);',
        '  await engine.close();',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'if (require.main === module) {',
        '  dryRun().then((result) => console.log(JSON.stringify(result)));',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['missing_benchmark_self_check'],
              requiredNextEvidence: ['run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'benchmark_self_check');
    assert.deepEqual(instruction.metadata.targetPaths, [
      'database-lab/prototype/scripts/bench.js',
    ]);
    assert.deepEqual(instruction.metadata.allowedTools, ['run_command']);
    assert.match(instruction.message, /Run one real benchmark self-check now before any speculative prototype contract repair/i);
    assert.doesNotMatch(instruction.message, /Static inspection already sees likely prototype issues/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design repairs benchmark stdout contract before attempting self-check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'async function dryRun() {',
        '  const storage = new StorageEngine();',
        '  const pool = new BufferPool();',
        '  const index = new BPlusTreeIndex();',
        '  const wal = new WALManager();',
        '  const tx = new TransactionManager();',
        '  void storage; void pool; void index; void wal; void tx;',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'if (require.main === module) {',
        '  dryRun().then((result) => console.log("[bench] completed metrics", result.metrics));',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['missing_benchmark_self_check'],
              requiredNextEvidence: ['run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.match(instruction.message, /prints one machine-readable JSON object/i);
    assert.doesNotMatch(instruction.message, /Run one real benchmark self-check now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design repairs undeclared external prototype dependencies before attempting benchmark self-check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
        dependencies: {},
        devDependencies: {},
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'async function dryRun() {',
        '  return { status: "success", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/transaction-manager.js': [
        "'use strict';",
        "const { v4: uuidv4 } = require('uuid');",
        'class TransactionManager {',
        '  beginTransaction() { return { id: uuidv4() }; }',
        '  commitTransaction(id) { return id; }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['missing_benchmark_self_check'],
              requiredNextEvidence: ['run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.ok(
      instruction.metadata.targetPaths.includes('database-lab/prototype/src/transaction-manager.js'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.ok(
      instruction.metadata.targetPaths.includes('database-lab/prototype/package.json'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.match(instruction.message, /undeclared external module "uuid"/i);
    assert.doesNotMatch(instruction.message, /Run one real benchmark self-check now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch undeclared Node builtins before rerunning bench', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        "  const dataDir = path.join(os.tmpdir(), 'scc-db-bench');",
        '  const engine = new StorageEngine(dataDir);',
        '  await engine.initialize?.();',
        '  return { status: "dry-run", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('undeclared_node_builtin:database-lab/prototype/scripts/bench.js:path'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('undeclared_node_builtin:database-lab/prototype/scripts/bench.js:os'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /declares path before using path\.\*/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /declares os before using os\.\*/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design repairs undeclared Node builtins before attempting benchmark self-check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
        dependencies: {},
        devDependencies: {},
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        "  const dataDir = path.join(os.tmpdir(), 'scc-db-bench');",
        '  const engine = new StorageEngine(dataDir);',
        '  await engine.initialize?.();',
        '  return { status: "dry-run", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['missing_benchmark_self_check'],
              requiredNextEvidence: ['run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.ok(
      instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.match(instruction.message, /missing CommonJS require declarations for Node builtins/i);
    assert.match(instruction.message, /const path = require\('path'\)/i);
    assert.match(instruction.message, /const os = require\('os'\)/i);
    assert.doesNotMatch(instruction.message, /Run one real benchmark self-check now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch bench and buffer-pool API mismatches before rerunning bench', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const BufferPool = require('../src/buffer-pool.js');",
        "const StorageEngine = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storage = new StorageEngine();',
        '  const bufferPool = new BufferPool(storage);',
        '  await bufferPool.writePage(1, Buffer.from("row"));',
        '  return bufferPool.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        'class BufferPool {',
        '  constructor(size) { this.size = size; this.cache = new Map(); }',
        '  getPage(pageId) { return this.cache.get(pageId) ?? null; }',
        '  putPage(pageId, page) { this.cache.set(pageId, page); return page; }',
        '}',
        'module.exports = BufferPool;',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {',
        '  updateRow() { return true; }',
        '  close() { return true; }',
        '}',
        'module.exports = StorageEngine;',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_buffer_pool_missing_method:writePage'));
    assert.ok(diagnostics.failedChecks.includes('bench_buffer_pool_missing_method:readPage'));
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /writePage, readPage/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch bench and storage-engine API mismatches before rerunning bench', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine({ dataDir: ".tmp" });',
        '  await engine.open();',
        '  await engine.select("users", { id: 1 });',
        '  await engine.delete("users", { id: 1 });',
        '  return engine.close();',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {',
        '  constructor(opts) { this.opts = opts; }',
        '  insert() { return true; }',
        '  flush() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:open'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:select'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:delete'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:close'));
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch missing storage-engine dataRoot constructor arguments before dry-run', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine();',
        '  await engine.writePage(1, Buffer.alloc(4096));',
        '  return { status: "success", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 0, writeDurationMs: 1, readDurationMs: 0, totalDurationMs: 1 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(dataRoot) {',
        '    this.pagePath = path.join(dataRoot, "pages");',
        '  }',
        '  async writePage() {}',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );
    const scenarioState = {
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    };

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics(scenarioState);
    assert.ok(diagnostics.failedChecks.includes('storage_engine_constructor_data_root_missing'));
    assert.match(
      diagnostics.requiredNextEvidence.join(' '),
      /new StorageEngine\(\) without the base directory string/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch storage-engine constructor path-root drift through assigned instance fields', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine({ pageSize: 4096 });',
        '  await engine.writePage({ pageId: 1, data: Buffer.alloc(4096), writeChecksum() {} });',
        '  return { status: "success", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 0, writeDurationMs: 1, readDurationMs: 0, totalDurationMs: 1 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(baseDir, options = {}) {',
        '    this.baseDir = baseDir;',
        '    this.pageSize = options.pageSize || 16384;',
        '  }',
        '  _getFilePath(pageId) {',
        "    return path.join(this.baseDir, `page-${pageId}.dat`);",
        '  }',
        '  async writePage() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch'));
    assert.match(
      diagnostics.requiredNextEvidence.join(' '),
      /bench\.js is passing an options object/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch storage-engine API mismatches even when bench uses non-default object names', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  storageEngine.writePage(1, Buffer.alloc(4096));',
        '  return storageEngine.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  read(key) { return key; }',
        '  write(key, value) { return value; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        'class BufferPool {',
        '  constructor() {}',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:writePage'));
    assert.ok(diagnostics.failedChecks.includes('storage_engine_missing_method:readPage'));
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch buffer-pool and storage-engine page API mismatches before rerunning bench', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'async function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  const bufferPool = new BufferPool({ storageEngine });',
        '  await bufferPool.writePage(1, Buffer.alloc(4096));',
        '  return bufferPool.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/buffer-pool.js': [
        'class BufferPool {',
        '  constructor({ storageEngine }) { this.storage = storageEngine; }',
        '  async writePage(pageId, page) { return this.storage.writePage(pageId, page); }',
        '  async readPage(pageId) { return this.storage.readPage(pageId); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  read(key) { return key; }',
        '  write(key, value) { return value; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('buffer_pool_storage_engine_missing_method:writePage'));
    assert.ok(diagnostics.failedChecks.includes('buffer_pool_storage_engine_missing_method:readPage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /BufferPool only calls storage methods the StorageEngine actually implements/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch JavaScript syntax errors before benchmark self-check', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const StorageEngine = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine();',
        '  return engine.close?.() ?? true;',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {',
        '  constructor() {',
        'n    this.bufferOrder = [];',
        '  }',
        '  close() { return true; }',
        '}',
        'module.exports = StorageEngine;',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('javascript_syntax_error:database-lab/prototype/src/storage-engine.js'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /repair database-lab\/prototype\/src\/storage-engine\.js so it parses as valid CommonJS JavaScript/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt routes prototype syntax errors into write-only syntax repair before broader contract repair', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        'function dryRun() {',
        '  return { status: "ok", summary: "placeholder", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': "module.exports = { StorageEngine: class StorageEngine { close() { n const broken = true; } } };\n",
      'database-lab/prototype/src/wal-manager.js': "module.exports = { WALManager: class WALManager { appendEntry() { return true; } close() { n const broken = true; } } };\n",
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_syntax_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.deepEqual([...instruction.metadata.targetPaths].sort(), [
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/wal-manager.js',
    ].sort());
    assert.match(instruction.message, /Repair only these syntax-broken files now/i);
    assert.match(instruction.message, /Do not emit read_file/i);
    assert.match(instruction.message, /parse as valid CommonJS JavaScript/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch CommonJS export mismatches before benchmark self-check', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { BufferPool } = require('../src/buffer-pool');",
        "const { StorageEngine } = require('../src/storage-engine');",
        'async function dryRun() {',
        '  const pool = new BufferPool({ poolSize: 8 });',
        '  const engine = new StorageEngine(".tmp");',
        '  return { pool: !!pool, engine: !!engine };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        'class BufferPool {',
        '  constructor(size) { this.size = size; }',
        '}',
        'module.exports = BufferPool;',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {',
        '  constructor(rootDir) { this.rootDir = rootDir; }',
        '}',
        'module.exports = StorageEngine;',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('bench_module_export_mismatch:database-lab/prototype/src/buffer-pool.js'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('bench_module_export_mismatch:database-lab/prototype/src/storage-engine.js'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /CommonJS import\/export shape agrees/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch named CommonJS export drift and bench API mismatches for imported prototype modules', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { MVCCManager } = require('../src/mvcc-manager.js');",
        'function dryRun() {',
        '  const wal = new WALManager();',
        '  const mvcc = new MVCCManager();',
        "  wal.appendEntry({ type: 'BEGIN', txnId: 1 });",
        '  const txnId = mvcc.beginTxn();',
        "  return { status: 'ok', summary: 'ok', metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 }, txnId };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      [
        'class WalManager {',
        '  logBegin(txnId) { return txnId; }',
        '  logCommit(txnId) { return txnId; }',
        '}',
        'module.exports = { WalManager };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'mvcc-manager.js'),
      [
        'class MvccManager {',
        '  register(txnId) { return txnId; }',
        '  commit(txnId) { return txnId; }',
        '}',
        'module.exports = { MvccManager };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/mvcc-manager.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('bench_module_export_name_mismatch:database-lab/prototype/src/wal-manager.js:WALManager'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('bench_module_export_name_mismatch:database-lab/prototype/src/mvcc-manager.js:MVCCManager'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('bench_module_api_mismatch:database-lab/prototype/src/wal-manager.js'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('bench_module_api_mismatch:database-lab/prototype/src/mvcc-manager.js'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /named CommonJS export exists/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /exposes the methods bench\.js is calling/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics require machine-readable benchmark stdout', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine');",
        'async function dryRun() {',
        '  const engine = new StorageEngine();',
        '  await engine.initialize();',
        '  console.log("human readable only");',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {',
        '  async initialize() { return true; }',
        '  async close() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('bench_output_not_machine_readable'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /prints one machine-readable JSON object/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics require a top-level benchmark result envelope', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        'function dryRun() {',
        '  const metrics = { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 };',
        '  process.stdout.write(JSON.stringify(metrics));',
        '  return metrics;',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('bench_output_missing_result_envelope'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.requiredNextEvidence.some((entry) => /top-level object with status, summary, and metrics keys/i.test(entry)),
      JSON.stringify(diagnostics, null, 2),
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics reject extra stdout logs around benchmark JSON', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        'function dryRun() {',
        '  const result = { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        "  console.log('[bench] dry-run complete');",
        '  console.log(JSON.stringify(result));',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_output_extra_stdout_logs'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /exactly one JSON\.stringify\(result\) payload/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect direct bench WAL method drift', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { WALManager } = require('../src/wal-manager.js');",
        'function dryRun() {',
        '  const wal = new WALManager();',
        '  const result = { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2, walFlushCount: wal.getFlushCount() } };',
        '  console.log(JSON.stringify(result));',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      [
        "'use strict';",
        'class WALManager {',
        '  constructor() { this.flushCount = 0; }',
        '  flush() { this.flushCount += 1; }',
        '}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/wal-manager.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_wal_manager_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_wal_manager_missing_method:getFlushCount'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /WALManager exposes the methods bench\.js is calling directly/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics reject dynamic module loader export-name drift', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const path = require('path');",
        "const MODULE_DEFS = [{ key: 'walManager', rel: '../src/wal-manager.js' }];",
        'function loadModules() {',
        '  const loaded = {};',
        '  for (const def of MODULE_DEFS) { loaded[def.key] = require(path.resolve(__dirname, def.rel)); }',
        '  return { loaded, missing: [] };',
        '}',
        'function dryRun() {',
        '  const { loaded } = loadModules();',
        '  const { WALManager } = loaded.walManager;',
        '  const wal = new WALManager();',
        '  const result = { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2, walEntries: wal.entries.length } };',
        '  console.log(JSON.stringify(result));',
        '  return result;',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      [
        "'use strict';",
        'class WalManager { constructor() { this.entries = []; } }',
        'module.exports = { WalManager };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/wal-manager.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.ok(
      diagnostics.failedChecks.includes('bench_module_export_name_mismatch:database-lab/prototype/src/wal-manager.js:WALManager'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /direct named CommonJS destructuring/i);
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /expects WALManager through loaded\.walManager/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database scenario classification stays artifact failure without structured provider blocker truth', async () => {
  const { buildDatabaseArtifactProgress, classifyScenario } = await loadWaveModule();
  const artifactProgress = buildDatabaseArtifactProgress([
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
  ], {});

  const result = classifyScenario(
    { id: 'database-near-mysql-design' },
    {
      summary: {
        lifecycleStatus: 'FAILED',
        visibleToolActivities: [],
      },
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: { verdict: 'failed' },
            quality: { verdict: 'failed' },
          },
          issueCategory: 'timeout',
          issueSummary: 'request timed out while continuing the scaffold',
          providerSummary: {
            lastMessage: 'request timed out',
            recentStatus: '408',
          },
          capabilityWarnings: [],
        },
      },
      task: {
        latestVisibleOutput: {
          summary: 'request timed out while continuing the scaffold',
          details: null,
        },
        completionSummary: null,
      },
    },
    {
      human: { pass: true },
      agent: { pass: true },
      web: { pass: true },
    },
    {
      pass: false,
      buildAudit: { packageJsonFound: false },
      notes: { artifactProgress },
    },
  );

  assert.equal(result.classification, 'artifact_failure');
  assert.match(result.reason, /Current artifact progress:/);
});

test('database artifact progress does not mark benchmark self-check passed when stderr contains a fatal runtime error', async () => {
  const { buildDatabaseArtifactProgress } = await loadWaveModule();
  const progress = buildDatabaseArtifactProgress(
    [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'database-lab/prototype/src/sql-parser.js',
      'quality/database-design.json',
    ],
    {
      verificationScriptAudit: {
        command: 'npm.cmd',
        args: ['run', 'bench', '--', '--dry-run'],
        exitCode: 0,
        stdout: [
          '> database-lab-prototype@0.1.0 bench',
          '> node scripts/bench.js --dry-run',
        ].join('\n'),
        stderr: 'TypeError: StorageEngine is not a constructor',
      },
    },
  );

  assert.equal(progress.benchmarkSelfCheck.attempted, true);
  assert.equal(progress.benchmarkSelfCheck.passed, false);
  assert.equal(progress.benchmarkSelfCheck.parseError, 'stdout_json_parse_failed');
  assert.equal(progress.benchmarkSelfCheck.hasRequiredMetrics, false);
});

test('database artifact progress marks benchmark self-check passed only with valid benchmark JSON metrics', async () => {
  const { buildDatabaseArtifactProgress } = await loadWaveModule();
  const progress = buildDatabaseArtifactProgress(
    [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'database-lab/prototype/src/sql-parser.js',
      'quality/database-design.json',
    ],
    {
      verificationScriptAudit: {
        command: 'npm.cmd',
        args: ['run', 'bench', '--', '--dry-run'],
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'passed',
          metrics: {
            pagesWritten: 12,
            pagesRead: 8,
            writeDurationMs: 4,
            readDurationMs: 3,
            totalDurationMs: 7,
          },
        }),
        stderr: '',
      },
    },
  );

  assert.equal(progress.benchmarkSelfCheck.attempted, true);
  assert.equal(progress.benchmarkSelfCheck.passed, true);
  assert.equal(progress.benchmarkSelfCheck.parseError, null);
  assert.equal(progress.benchmarkSelfCheck.hasRequiredMetrics, true);
  assert.equal(progress.benchmarkSelfCheck.parsedStatus, 'passed');
});

test('database benchmark self-check parses JSON wrapped by benchmark banner logs', async () => {
  const { buildDatabaseArtifactProgress } = await loadWaveModule();
  const progress = buildDatabaseArtifactProgress(
    [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'quality/database-design.json',
    ],
    {
      verificationScriptAudit: {
        command: 'npm.cmd',
        args: ['run', 'bench', '--', '--dry-run'],
        exitCode: 0,
        stdout: [
          '[bench] Starting dry-run benchmark...',
          JSON.stringify({
            summary: { label: 'near-mysql-dry-run' },
            metrics: {
              pagesWritten: 12,
              pagesRead: 8,
              writeDurationMs: 4,
              readDurationMs: 3,
              totalDurationMs: 7,
            },
          }, null, 2),
          '[bench] Benchmark completed successfully.',
        ].join('\n'),
        stderr: '',
      },
    },
  );

  assert.equal(progress.benchmarkSelfCheck.attempted, true);
  assert.equal(progress.benchmarkSelfCheck.passed, true);
  assert.equal(progress.benchmarkSelfCheck.parseError, null);
  assert.equal(progress.benchmarkSelfCheck.hasRequiredMetrics, true);
  assert.equal(progress.benchmarkSelfCheck.parsedStatus, null);
});

test('database continue prompt stays in benchmark self-check mode once scaffold is complete', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine();',
        '  const bufferPool = new BufferPool();',
        '  const txManager = new TransactionManager();',
        '  const walManager = new WALManager();',
        '  const indexManager = new BPlusTreeIndex();',
        '  const result = {',
        '    status: "passed",',
        '    summary: "ok",',
        '    metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 },',
        '    modules: { engine: !!engine, bufferPool: !!bufferPool, txManager: !!txManager, walManager: !!walManager, indexManager: !!indexManager }',
        '  };',
        '  process.stdout.write(JSON.stringify(result));',
        '  return result;',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    for (const relativePath of [
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
    ]) {
      const classNameMap = {
        'storage-engine.js': 'StorageEngine',
        'buffer-pool.js': 'BufferPool',
        'b-plus-tree-index.js': 'BPlusTreeIndex',
        'wal-manager.js': 'WALManager',
        'transaction-manager.js': 'TransactionManager',
      };
      const className = classNameMap[path.basename(relativePath)];
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), `class ${className} {}\nmodule.exports = { ${className} };\n`, 'utf8');
    }

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/b-plus-tree-index.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/transaction-manager.js',
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'benchmark_self_check');
    assert.deepEqual(instruction.metadata.targetPaths, [
      'database-lab/prototype/scripts/bench.js',
    ]);
    assert.match(instruction.message, /Run one real benchmark self-check now before any speculative prototype contract repair/i);
    assert.doesNotMatch(instruction.message, /Write only this next design-doc batch now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt treats an observed benchmark run_command as real benchmark evidence for the next repair turn', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        'function dryRun() {',
        '  return { iterations: 200, pagesWritten: 0, pagesRead: 0, totalDurationMs: 7 };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': "module.exports = { StorageEngine: class StorageEngine { close() { return true; } } };\n",
      'database-lab/prototype/src/buffer-pool.js': "module.exports = { BufferPool: class BufferPool { close() { return true; } } };\n",
      'database-lab/prototype/src/b-plus-tree-index.js': "module.exports = { BPlusTreeIndex: class BPlusTreeIndex {} };\n",
      'database-lab/prototype/src/wal-manager.js': "module.exports = { WALManager: class WALManager {} };\n",
      'database-lab/prototype/src/transaction-manager.js': "module.exports = { TransactionManager: class TransactionManager {} };\n",
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            activityId: 'tool_bench_1',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'database-lab/prototype',
            detail: 'stdout captured from database-lab/prototype benchmark self-check',
            evidencePaths: ['database-lab/prototype/scripts/bench.js'],
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_1',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            arguments: {
              command: 'npm run bench -- --dry-run',
              workingDirectory: 'database-lab/prototype',
            },
            result: {
              exitCode: 0,
              stdout: '[bench] results: {"iterations":200,"pagesWritten":0,"pagesRead":0,"totalDurationMs":7}',
              stderr: '',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/b-plus-tree-index.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/transaction-manager.js',
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.doesNotMatch(instruction.message, /Run one real benchmark self-check now before any speculative prototype contract repair/i);
    assert.match(instruction.message, /top-level status, summary, and metrics keys/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect storage-engine constructor argument mismatches', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  const engine = new StorageEngine({ dataDir: ".bench-data", pageCapacity: 256 });',
        '  return Boolean(engine);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(baseDir) {',
        "    this.dataFile = path.join(baseDir, 'data.db');",
        '  }',
        '  open(){ return this; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /bench\.js is passing an options object, but storage-engine\.js still treats the constructor argument as a base directory string/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect package and CommonJS module-system mismatches', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        type: 'module',
        main: 'src/index.js',
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        'class StorageEngine {}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/package.json',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(
      diagnostics.failedChecks.includes('prototype_module_system_mismatch'),
      JSON.stringify(diagnostics, null, 2),
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /package\.json currently declares type=module, but those files still use CommonJS require\/module\.exports/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt expands typeerror benchmark repair to storage-engine when buffer-pool delegates missing page methods', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'async function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  const bufferPool = new BufferPool({ storageEngine });',
        '  await bufferPool.writePage(1, Buffer.alloc(4096));',
        '  return bufferPool.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/buffer-pool.js': [
        'class BufferPool {',
        '  constructor({ storageEngine }) { this.storage = storageEngine; }',
        '  async writePage(pageId, page) { return this.storage.writePage(pageId, page); }',
        '  async readPage(pageId) { return this.storage.readPage(pageId); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  read(key) { return key; }',
        '  write(key, value) { return value; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'TypeError: this.storage.writePage is not a function',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: {
              stdout: '',
              stderr: 'TypeError: this.storage.writePage is not a function\n    at BufferPool.writePage (database-lab/prototype/src/buffer-pool.js:3:56)',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/buffer-pool.js'));
    assert.match(instruction.message, /buffer-pool\.js is delegating page I\/O to this\.storage\.readPage\/writePage/i);
    assert.match(instruction.message, /implement readPage\/writePage coherently in database-lab\/prototype\/src\/storage-engine\.js/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt keeps benchmark API repair instead of generic runtime-evidence repair after a failed benchmark turn', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(baseDir) {',
        "    this.dataFile = path.join(baseDir, 'data.db');",
        '  }',
        '  readPage(pageId) { return pageId; }',
        '  writePage(pageId, payload) { return payload; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'database-lab/prototype/src/buffer-pool.js': [
        'class BufferPool {',
        '  constructor({ storageEngine }) { this.storage = storageEngine; }',
        '  async writePage(pageId, page) { return this.storage.writePage(pageId, page); }',
        '  async readPage(pageId) { return this.storage.readPage(pageId); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/b-plus-tree-index.js': [
        'class BPlusTreeIndex {',
        '  insert(key, pageId) { return { key, pageId }; }',
        '  lookup(key) { return key; }',
        '}',
        'module.exports = { BPlusTreeIndex };',
      ].join('\n'),
    });

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'async function dryRun() {',
        "  const storageEngine = new StorageEngine({ pageSize: 4096, file: ':memory:' });",
        '  const bufferPool = new BufferPool({ storageEngine });',
        '  await bufferPool.writePage(1, Buffer.alloc(4096));',
        '  return bufferPool.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'Command failed with exit code 1.',
          },
        ],
      },
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
        },
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            toolId: 'run_command',
            status: 'FAILED',
            result: null,
            error: 'Command failed with exit code 1.',
            metadata: {
              stdout: '{\"status\":\"FAILED\",\"issues\":[\"storage_engine_init:The \\\"path\\\" argument must be of type string or an instance of Buffer or URL. Received an instance of Object\"]}',
              stderr: '',
              exitCode: 1,
            },
          },
        ],
      },
      debug: {
        task: {
          runtime: {
            pendingCorrection: 'AWAITING_TOOL_ACTION',
          },
        },
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.doesNotMatch(instruction.metadata.phase, /runtime_required_evidence/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt expands typeerror benchmark repair to storage-engine when bench calls a non-default storageEngine variable', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  storageEngine.writePage(1, Buffer.alloc(4096));',
        '  return storageEngine.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  read(key) { return key; }',
        '  write(key, value) { return value; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm.cmd run bench -- --dry-run',
            resultSummary: 'TypeError: storageEngine.writePage is not a function',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: {
              stdout: '',
              stderr: 'TypeError: storageEngine.writePage is not a function',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.match(instruction.message, /storageEngine\.writePage is not a function/i);
    assert.match(instruction.message, /StorageEngine\.writePage matches the benchmark scaffold contract/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt routes ENOENT benchmark failures into benchmark runtime I/O repair using invocation metadata stderr', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  storageEngine.writePage(1, Buffer.alloc(16384));',
        '  return storageEngine.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(options = {}) {',
        "    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');",
        '  }',
        '  async initialize() {',
        '    if (!fs.existsSync(this.dataDir)) {',
        '      fs.mkdirSync(this.dataDir, { recursive: true });',
        '    }',
        '  }',
        '  async writePage(pageId, pageBuf, tablespace = "default") {',
        '    return this._openFile(path.join(this.dataDir, `${tablespace}.dat`));',
        '  }',
        '  async readPage(pageId, tablespace = "default") {',
        '    return this._openFile(path.join(this.dataDir, `${tablespace}.dat`));',
        '  }',
        '  async _openFile(filePath) {',
        "    return fs.openSync(filePath, 'a+');",
        '  }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'Command failed with exit code 1.',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: null,
            metadata: {
              stdout: '{"status":"success","summary":"ok","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
              stderr: "Error: ENOENT: no such file or directory, open 'database-lab/prototype/data/default.dat'",
              exitCode: 1,
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_runtime_io_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.match(instruction.message, /no such file or directory/i);
    assert.match(instruction.message, /awaits storageEngine\.init\(\)\/initialize\(\)/i);
    assert.match(instruction.message, /creates or verifies the parent data directory/i);
    assert.match(instruction.message, /Do not emit run_command in this repair turn/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt routes numeric table lookup benchmark failures into table identity repair', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'brief'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'const DEFAULT_TABLE_ID = 0;',
        'async function dryRun() {',
        '  const storageEngine = new StorageEngine({ pageSize: 4096 });',
        '  await storageEngine.writePage(DEFAULT_TABLE_ID, 1, Buffer.alloc(4096));',
        '  await storageEngine.readPage(DEFAULT_TABLE_ID, 1);',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        "'use strict';",
        'class StorageEngine {',
        '  constructor(options = {}) { this.pageSize = options.pageSize || 4096; this.tables = new Map(); }',
        '  createTable(name, schema = {}) { this.tables.set(name, { schema, pages: new Map() }); return this.tables.get(name); }',
        '  openTable(name) { const table = this.tables.get(name); if (!table) throw new Error(`Table ${name} not found`); return table; }',
        '  async writePage(tableName, pageNum, pageBuffer) { this.openTable(tableName).pages.set(pageNum, pageBuffer); return { tableName, pageNum }; }',
        '  async readPage(tableName, pageNum) { return this.openTable(tableName).pages.get(pageNum); }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'Command failed with exit code 1.',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: null,
            metadata: {
              stdout: '',
              stderr: 'Error: Table 0 not found',
              exitCode: 1,
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_table_identity_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.match(instruction.message, /Table 0 not found/i);
    assert.match(instruction.message, /DEFAULT_TABLE_ID = 0/i);
    assert.match(instruction.message, /string-named benchmark table/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design repairs static peer module drift before benchmark self-check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'function dryRun() {',
        '  const storage = new StorageEngine({ pageSize: 8192 });',
        '  const bufferPool = new BufferPool({ storage, maxPages: 64 });',
        '  const index = new BPlusTreeIndex({ order: 64 });',
        '  const wal = new WALManager({ storage });',
        '  const txManager = new TransactionManager({ wal, storage, bufferPool });',
        '  storage.allocatePage();',
        '  storage.writePage(1, Buffer.from("row"));',
        '  storage.getPageCount();',
        '  index.insert("k1", 1);',
        '  index.search("k1");',
        '  const tx = txManager.beginTransaction();',
        '  txManager.commitTransaction(tx.id);',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'if (require.main === module) {',
        '  const result = dryRun();',
        '  console.log(JSON.stringify(result));',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  constructor(options = {}) { this.options = options; }',
        '  close() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'database-lab/prototype/src/buffer-pool.js': [
        'class BufferPool {',
        '  constructor(options = {}) { this.options = options; }',
        '  writePage(pageId, payload) { return payload; }',
        '  readPage(pageId) { return pageId; }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/b-plus-tree-index.js': [
        'class BPlusTreeIndex {',
        '  insert(key, value) { return value; }',
        '  search(key) { return key; }',
        '}',
        'module.exports = { BPlusTreeIndex };',
      ].join('\n'),
      'database-lab/prototype/src/wal-manager.js': [
        'class WALManager {',
        '  constructor(options = {}) { this.options = options; }',
        '  appendEntry(entry) { return entry; }',
        '}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'database-lab/prototype/src/transaction-manager.js': [
        'class TransactionManager {',
        '  constructor(options = {}) { this.options = options; }',
        '  beginTransaction() { return { id: 1 }; }',
        '  commitTransaction(id) { return id; }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  allocatePage() { return 1; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        "'use strict';",
        'class BufferPool {',
        '  constructor(storageEngine, poolSize) { this.storage = storageEngine; this.poolSize = poolSize; }',
        '  putPage(id, payload) { return payload; }',
        '  getPage(id) { return id; }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'b-plus-tree-index.js'),
      [
        "'use strict';",
        'class BPlusTree {',
        '  insert(key, value) { return { key, value }; }',
        '}',
        'module.exports = { BPlusTree };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'transaction-manager.js'),
      [
        "'use strict';",
        'class TransactionManager {',
        '  begin() { return { id: 1 }; }',
        '  commit() { return true; }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      [
        "'use strict';",
        'class WALManager {}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'utf8',
    );

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      task: {
        toolInvocations: [],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/b-plus-tree-index.js',
        'database-lab/prototype/src/transaction-manager.js',
        'database-lab/prototype/src/wal-manager.js',
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.match(instruction.message, /Static inspection already found real prototype contract defects/i);
    assert.doesNotMatch(instruction.message, /Run one real benchmark self-check now/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect bench async and page-size contract mismatches before dry-run', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  const engine = new StorageEngine("bench.db");',
        '  for (let i = 0; i < 4; i++) {',
        '    const pageData = Buffer.from(`Page ${i} data`);',
        '    engine.writePage(i, pageData);',
        '    engine.readPage(i);',
        '  }',
        '  return { status: "success", summary: "ok", metrics: { pagesWritten: 4, pagesRead: 4, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        "const fs = require('fs');",
        'class StorageEngine {',
        '  constructor(filePath, pageSize = 4096) {',
        '    this.filePath = filePath;',
        '    this.pageSize = pageSize;',
        '    this.fd = null;',
        '  }',
        '  open() {',
        '    return new Promise((resolve) => resolve());',
        '  }',
        '  readPage(pageId) {',
        '    return new Promise((resolve, reject) => {',
        '      fs.read(this.fd, Buffer.alloc(this.pageSize), 0, this.pageSize, pageId * this.pageSize, (err, bytesRead, buffer) => err ? reject(err) : resolve(buffer));',
        '    });',
        '  }',
        '  writePage(pageId, data) {',
        '    return new Promise((resolve, reject) => {',
        '      if (data.length !== this.pageSize) { reject(new Error("Data size must match page size")); return; }',
        '      fs.write(this.fd, data, 0, this.pageSize, pageId * this.pageSize, (err) => err ? reject(err) : resolve());',
        '    });',
        '  }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_open_missing'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_page_size_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_async_usage_mismatch:writePage'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_async_usage_mismatch:readPage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /opens or initializes the real StorageEngine before calling readPage\/writePage/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /benchmark page writes respect the StorageEngine pageSize contract/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect fixed page writes with short benchmark buffers', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storage = new StorageEngine({ pageSize: 4096 });',
        '  await storage.initialize();',
        '  for (let i = 0; i < 4; i++) {',
        '    const pageId = storage.allocatePageId();',
        '    const data = Buffer.from(JSON.stringify({ id: i, name: "user-" + i }));',
        '    storage.writePage("users", pageId, data);',
        '  }',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 4, pagesRead: 0, writeDurationMs: 1, readDurationMs: 0, totalDurationMs: 1 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        "const fs = require('fs');",
        'class StorageEngine {',
        '  constructor({ pageSize = 4096 } = {}) { this.pageSize = pageSize; this.files = new Map(); }',
        '  initialize() { return true; }',
        '  allocatePageId() { return 1; }',
        '  open(storeName) { if (!this.files.has(storeName)) this.files.set(storeName, 1); return this.files.get(storeName); }',
        '  writePage(storeName, pageId, buffer) {',
        '    this.open(storeName);',
        '    const fd = this.files.get(storeName);',
        '    fs.writeSync(fd, buffer, 0, this.pageSize, pageId * this.pageSize);',
        '  }',
        '  readPage() { return Buffer.alloc(this.pageSize); }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_page_size_mismatch'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /do not pass short Buffer\.from\(\.\.\.\) payloads into writePage/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect benchmark calls with too few StorageEngine arguments', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'function dryRun() {',
        '  const engine = new StorageEngine({ pageSize: 4096 });',
        "  engine.writePage(1, Buffer.alloc(4096, 'A'));",
        '  engine.readPage(1);',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  constructor(options = {}) { this.pageSize = options.pageSize || 4096; }',
        '  writePage(fileId, pageId, data) { return { fileId, pageId, bytes: data.length }; }',
        '  readPage(fileId, pageId) { return { fileId, pageId }; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_arg_mismatch:writePage'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_arg_mismatch:readPage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /called with 3 required argument\(s\); bench\.js currently supplies 2/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect numeric table ids passed to table-name storage APIs', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'const DEFAULT_TABLE_ID = 0;',
        'async function dryRun() {',
        '  const storage = new StorageEngine({ pageSize: 4096 });',
        '  await storage.writePage(DEFAULT_TABLE_ID, 1, Buffer.alloc(4096));',
        '  await storage.readPage(DEFAULT_TABLE_ID, 1);',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  constructor(options = {}) { this.pageSize = options.pageSize || 4096; }',
        '  async writePage(tableName, pageNum, pageBuffer) { return { tableName, pageNum, bytes: pageBuffer.length }; }',
        '  async readPage(tableName, pageNum) { return { tableName, pageNum }; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_table_name_mismatch:writePage'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_table_name_mismatch:readPage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /DEFAULT_TABLE_ID = 0|Table 0 not found|numeric table id/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect BufferPool construction without required storage dependency', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'function dryRun() {',
        '  const storage = new StorageEngine();',
        '  const pool = new BufferPool();',
        '  pool.writePage(1, Buffer.alloc(4096));',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  writePage(pageId, pageBuffer) { return { pageId, bytes: pageBuffer.length }; }',
        '  readPage(pageId) { return Buffer.alloc(4096); }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        "'use strict';",
        'class BufferPool {',
        '  constructor(options) {',
        "    if (!options || !options.storageEngine) throw new Error('BufferPool requires options.storageEngine');",
        '    this.storageEngine = options.storageEngine;',
        '  }',
        '  writePage(pageId, pageBuffer) { return this.storageEngine.writePage(pageId, pageBuffer); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /new BufferPool\(\) without options\.storageEngine/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect BufferPool initialize calls when no initialize method exists', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'async function dryRun() {',
        '  const pool = new BufferPool({ capacity: 64 });',
        '  await pool.initialize();',
        '  pool.putPage("p1", Buffer.alloc(4096));',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        "'use strict';",
        'class BufferPool {',
        '  constructor(options = {}) { this.capacity = options.capacity || 64; this.pages = new Map(); }',
        '  putPage(key, value) { this.pages.set(key, value); }',
        '  getPage(key) { return this.pages.get(key) ?? null; }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/buffer-pool.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize'));
    assert.ok(diagnostics.failedChecks.includes('bench_buffer_pool_missing_method:initialize'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /pool\.initialize\(\)/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect missing table lifecycle before page I/O', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storage = new StorageEngine({ pageSize: 4096 });',
        '  const TABLE_NAME = "benchmark_table";',
        '  storage.writePage(TABLE_NAME, 0, Buffer.alloc(4096));',
        '  return storage.readPage(TABLE_NAME, 0);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  constructor() { this.tables = new Map(); }',
        '  createTable(tableName) { this.tables.set(tableName, { tableName }); }',
        "  writePage(tableName) { if (!this.tables.has(tableName)) throw new Error(`Table '${tableName}' not loaded`); return true; }",
        "  readPage(tableName) { if (!this.tables.has(tableName)) throw new Error(`Table '${tableName}' not loaded`); return Buffer.alloc(4096); }",
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /create.*load.*benchmark table before page I\/O/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect signed bitwise uint32 writes', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storage = new StorageEngine();',
        '  const page = storage.allocatePage();',
        '  await storage.writePage(0, page);',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 0, writeDurationMs: 1, readDurationMs: 0, totalDurationMs: 1 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        'class StorageEngine {',
        '  allocatePage() {',
        '    const buf = Buffer.alloc(16384);',
        '    buf.writeUInt32BE(Date.now() & 0xFFFFFFFF, 4);',
        '    return buf;',
        '  }',
        '  async writePage() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /writeUInt32BE.*unsigned/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect missing storage setup when benchmark performs file-backed page I/O', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        'async function dryRun() {',
        '  const storageEngine = new StorageEngine();',
        '  storageEngine.writePage(1, Buffer.alloc(16384));',
        '  return storageEngine.readPage(1);',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(options = {}) {',
        "    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');",
        '  }',
        '  async init() {',
        '    if (!fs.existsSync(this.dataDir)) {',
        '      fs.mkdirSync(this.dataDir, { recursive: true });',
        '    }',
        '  }',
        '  async writePage(pageId, pageBuf, tablespace = "default") {',
        '    return this._openFile(path.join(this.dataDir, `${tablespace}.dat`));',
        '  }',
        '  async readPage(pageId, tablespace = "default") {',
        '    return this._openFile(path.join(this.dataDir, `${tablespace}.dat`));',
        '  }',
        '  async _openFile(filePath) {',
        "    return fs.openSync(filePath, 'a+');",
        '  }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_initialize_missing'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_open_missing'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_async_usage_mismatch:writePage'));
    assert.ok(diagnostics.failedChecks.includes('bench_storage_engine_async_usage_mismatch:readPage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /awaits storageEngine.*init\(\).*initialize\(\).*before the first readPage\/writePage call/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype repair target prioritization favors benchmark export blockers before generic constructor drift', async () => {
  const { getPrioritizedDatabasePrototypeRepairTargets } = await loadWaveModule();

  const targets = getPrioritizedDatabasePrototypeRepairTargets(
    {
      failedChecks: [
        'bench_module_export_name_mismatch:database-lab/prototype/src/wal-manager.js:WALManager',
        'bench_module_api_mismatch:database-lab/prototype/src/wal-manager.js',
        'bench_module_api_mismatch:database-lab/prototype/src/transaction-manager.js',
        'storage_engine_constructor_arg_mismatch',
        'buffer_pool_constructor_arg_mismatch',
      ],
    },
    [
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/wal-manager.js',
      'database-lab/prototype/src/transaction-manager.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
    ],
  );

  assert.deepEqual(targets, [
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/wal-manager.js',
    'database-lab/prototype/src/transaction-manager.js',
    'database-lab/prototype/src/storage-engine.js',
    'database-lab/prototype/src/buffer-pool.js',
  ]);
});

test('database prototype repair target prioritization escalates transaction API drift to transaction-manager before storage drift', async () => {
  const { getPrioritizedDatabasePrototypeRepairTargets } = await loadWaveModule();

  const targets = getPrioritizedDatabasePrototypeRepairTargets(
    {
      failedChecks: [
        'bench_transaction_api_mismatch',
        'bench_transaction_missing_method:insert',
        'bench_transaction_missing_method:lookup',
        'storage_engine_constructor_arg_mismatch',
      ],
    },
    [
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/transaction-manager.js',
      'database-lab/prototype/src/storage-engine.js',
    ],
  );

  assert.deepEqual(targets, [
    'database-lab/prototype/scripts/bench.js',
    'database-lab/prototype/src/transaction-manager.js',
    'database-lab/prototype/src/storage-engine.js',
  ]);
});

test('database prototype diagnostics detect transaction instance API drift from bench scaffold', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-tx-drift-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'function runBenchmark() {',
        '  const txManager = new TransactionManager({});',
        '  const tx = txManager.begin();',
        '  tx.insert({ id: 1 });',
        '  tx.lookup(1);',
        '  tx.commit();',
        '}',
        'module.exports = { runBenchmark };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'transaction-manager.js'),
      [
        'class Transaction {',
        '  read(key) { return key; }',
        '  write(key, value) { return { key, value }; }',
        '  commit() { return true; }',
        '}',
        'class TransactionManager {',
        '  begin() { return new Transaction(); }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/transaction-manager.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('bench_transaction_api_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_transaction_missing_method:insert'));
    assert.ok(diagnostics.failedChecks.includes('bench_transaction_missing_method:lookup'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /transaction object returned by begin\(\) exposes the methods bench\.js is calling/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics detect wal, buffer-pool, and query-executor constructor contract mismatches before dry-run', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        "const { QueryExecutor } = require('../src/query-executor.js');",
        'async function dryRun() {',
        "  const storage = new StorageEngine({ basePath: '/tmp/db-lab-bench' });",
        '  const bufferPool = new BufferPool({ capacity: 256, storage });',
        "  const wal = new WALManager({ basePath: '/tmp/db-lab-bench/wal' });",
        '  const txManager = new TransactionManager({ wal, storage, index: null });',
        '  const executor = new QueryExecutor({ storage, bufferPool, wal });',
        '  return { status: "completed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 }, txManager: !!txManager };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'),
      [
        "'use strict';",
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(baseDir) {',
        "    this.dataRoot = baseDir || path.join(process.cwd(), 'data');",
        "    this.pageFile = path.join(baseDir, 'pages.dat');",
        '  }',
        '  readPage() { return null; }',
        '  writePage() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'),
      [
        "'use strict';",
        'class BufferPool {',
        '  constructor(storageEngine, poolSize) {',
        '    this.storage = storageEngine;',
        '    this.poolSize = poolSize || 256;',
        '  }',
        '  writePage() { return true; }',
        '  readPage() { return null; }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'),
      [
        "'use strict';",
        "const path = require('path');",
        'class WALManager {',
        '  constructor(baseDir) {',
        "    this.walDir = path.join(baseDir, 'wal');",
        '  }',
        '}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'transaction-manager.js'),
      [
        "'use strict';",
        'class TransactionManager {',
        '  constructor({ storageEngine, bufferPool, walManager, indexManager } = {}) {',
        '    this.storageEngine = storageEngine;',
        '    this.bufferPool = bufferPool;',
        '    this.walManager = walManager;',
        '    this.indexManager = indexManager;',
        '  }',
        '  beginTransaction() { return { commit() { return true; } }; }',
        '  commitTransaction(txId) {',
        "    this.walManager.writeRecord({ type: 'COMMIT', txId });",
        "    this.storageEngine.put('k', 'v');",
        '    return true;',
        '  }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'query-executor.js'),
      [
        "'use strict';",
        'class QueryExecutor {',
        '  constructor(database) {',
        '    this.database = database;',
        '  }',
        '  executeSelect(parsed) {',
        '    return this.database.getTable(parsed.table);',
        '  }',
        '}',
        'module.exports = { QueryExecutor };',
      ].join('\n'),
      'utf8',
    );

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/transaction-manager.js',
        'database-lab/prototype/src/query-executor.js',
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_wal_missing_method:writeRecord'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_storage_missing_method:put'));
    assert.ok(diagnostics.failedChecks.includes('query_executor_database_contract_mismatch'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /WALManager is constructed consistently/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /TransactionManager only calls WALManager methods that really exist/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /TransactionManager only calls StorageEngine methods that really exist/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /QueryExecutor receives a real database facade/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /TransactionManager is constructed with the real option keys/i,
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch transaction-manager alias-based wal and storage contract drift before benchmark rerun', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics, deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'function dryRun() {',
        "  const engine = new StorageEngine({ dataDir: '.bench-data' });",
        '  const pool = new BufferPool({ engine });',
        '  const index = new BPlusTreeIndex({ order: 64 });',
        "  const wal = new WALManager({ dir: '.bench-wal' });",
        '  const txManager = new TransactionManager({ wal, storage: engine, bufferPool: pool, index });',
        '  const tx = txManager.beginTransaction();',
        '  return { status: "ok", summary: "placeholder", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 }, tx };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  constructor(options = {}) { this.options = options; }',
        '  readPage(pageId) { return pageId; }',
        '  writePage(pageId, payload) { return payload; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'database-lab/prototype/src/wal-manager.js': [
        'class WALManager {',
        '  constructor(options = {}) { this.options = options; }',
        '  getCurrentLSN() { return 1; }',
        '  append(entry) { return entry; }',
        '}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'database-lab/prototype/src/transaction-manager.js': [
        'class TransactionManager {',
        '  constructor({ wal, storage, bufferPool, index } = {}) {',
        '    this.wal = wal;',
        '    this.storage = storage;',
        '    this.bufferPool = bufferPool;',
        '    this.index = index;',
        '  }',
        '  begin() {',
        '    const beginLsn = this.wal.currentLsn();',
        '    const pageId = this.storage.allocatePage();',
        '    return { txnId: 1, beginLsn, pageId };',
        '  }',
        '  beginTransaction() { return this.begin(); }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_wal_missing_method:currentLsn'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_storage_missing_method:allocatePage'));
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /TransactionManager only calls WALManager methods that really exist/i,
    );
    assert.match(
      diagnostics.requiredNextEvidence.join('\n'),
      /TransactionManager only calls StorageEngine methods that really exist/i,
    );

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'TypeError: this.wal.currentLsn is not a function',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: {
              stdout: '',
              stderr: 'TypeError: this.wal.currentLsn is not a function\n    at TransactionManager.begin (database-lab/prototype/src/transaction-manager.js:8:31)',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/transaction-manager.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/wal-manager.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.match(instruction.message, /currentLsn/i);
    assert.match(instruction.message, /TransactionManager only calls WALManager methods that really exist/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch options-object wal alias and commit argument drift before benchmark rerun', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics, deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'function dryRun() {',
        '  const storage = new StorageEngine({ basePath: "./.bench-data" });',
        '  const bufferPool = new BufferPool({ storage });',
        '  const wal = new WALManager({ basePath: "./.bench-wal" });',
        '  const txManager = new TransactionManager({ wal, storage, bufferPool });',
        '  const tx = txManager.begin();',
        '  txManager.commit(tx);',
        '  return { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'if (require.main === module) console.log(JSON.stringify(dryRun()));',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        'class StorageEngine {',
        '  constructor(options = {}) { this.options = options; }',
        '  readPage(pageId) { return pageId; }',
        '  writePage(pageId, payload) { return payload; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'database-lab/prototype/src/buffer-pool.js': [
        'class BufferPool {',
        '  constructor(options = {}) { this.storage = options.storage; }',
        '  readPage(pageId) { return this.storage.readPage(pageId); }',
        '  writePage(pageId, payload) { return this.storage.writePage(pageId, payload); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/wal-manager.js': [
        'class WALManager {',
        '  constructor(options = {}) { this.options = options; }',
        '  logBegin(txnId) { return { type: "BEGIN", txnId }; }',
        '  logCommit(txnId) { return { type: "COMMIT", txnId }; }',
        '}',
        'module.exports = { WALManager };',
      ].join('\n'),
      'database-lab/prototype/src/transaction-manager.js': [
        'class TransactionManager {',
        '  constructor(options = {}) {',
        '    this.walManager = options.walManager;',
        '    this.storage = options.storage;',
        '    this.bufferPool = options.bufferPool;',
        '    this.activeTxns = new Map();',
        '    this.nextTxnId = 1;',
        '  }',
        '  begin() {',
        '    const txn = { id: this.nextTxnId++, commit: () => true };',
        '    txn.beginLsn = this.walManager.logBegin(txn.id);',
        '    this.activeTxns.set(txn.id, txn);',
        '    return txn;',
        '  }',
        '  commit(txnId) {',
        '    const txn = this.activeTxns.get(txnId);',
        '    if (!txn) throw new Error(`Transaction ${txnId} not found`);',
        '    this.walManager.logCommit(txnId);',
        '    this.activeTxns.delete(txnId);',
        '    return txn.commit();',
        '  }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });

    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles: [
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
      ],
    });

    assert.ok(diagnostics.failedChecks.includes('transaction_manager_constructor_option_alias_mismatch:walManager:wal'));
    assert.ok(diagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch:commit'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /option key walManager/i);
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /passes transaction object tx/i);

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: "TypeError: Cannot read properties of undefined (reading 'logBegin')",
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: {
              stdout: '',
              stderr: "TypeError: Cannot read properties of undefined (reading 'logBegin')\n    at TransactionManager.begin (database-lab/prototype/src/transaction-manager.js:9:37)",
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/transaction-manager.js'));
    assert.match(instruction.message, /walManager/i);
    assert.match(instruction.message, /commit\/rollback/i);
    assert.doesNotMatch(instruction.message, /database-lab\/design\/architecture\.md/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database prototype diagnostics catch commit calls missing the expected transaction id', async () => {
  const { getDatabaseLabPrototypeCodeDiagnostics, deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({ scripts: { bench: 'node scripts/bench.js' } }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine({ pageSize: 4096 });',
        '  const bufferPool = new BufferPool({ capacity: 64 });',
        '  const wal = new WALManager({ segmentSize: 1024 * 1024 });',
        '  const txManager = new TransactionManager({ walManager: wal, index: {} });',
        '  await wal.open();',
        '  await txManager.begin();',
        '  await txManager.commit();',
        '  await wal.close();',
        '  return { status: "ok", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'if (require.main === module) dryRun().then((result) => console.log(JSON.stringify(result)));',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/transaction-manager.js': [
        'class TransactionManager {',
        '  constructor(options = {}) { this.walManager = options.walManager; this.activeTxns = new Map(); this.nextTxnId = 1; }',
        '  begin() { const txn = { id: this.nextTxnId++ }; this.activeTxns.set(txn.id, txn); return txn; }',
        '  commit(txnId) { const txn = this.activeTxns.get(txnId); if (!txn) throw new Error(`Transaction ${txnId} not found`); this.activeTxns.delete(txnId); return txn; }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });

    const workspaceRelativeFiles = [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      ...coreModuleFiles,
      'quality/database-design.json',
    ];
    const diagnostics = getDatabaseLabPrototypeCodeDiagnostics({
      workspaceDir,
      workspaceRelativeFiles,
    });

    assert.ok(diagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch'));
    assert.ok(diagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch:commit'));
    assert.match(diagnostics.requiredNextEvidence.join('\n'), /without the required id parameter/i);

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_fail',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'Dry-run failed: Error: Transaction undefined not found',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_fail',
            result: {
              stdout: '',
              stderr: 'Dry-run failed: Error: Transaction undefined not found\n    at TransactionManager.commit (database-lab/prototype/src/transaction-manager.js:4:71)',
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: { modelId: 'mimo-v2.5' },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles,
    });
    assert.equal(instruction.metadata.phase, 'bench_api_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/src/transaction-manager.js'));
    assert.match(instruction.message, /Transaction undefined not found/i);
    assert.match(instruction.message, /commit\/rollback calls pass the expected id/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt finalizes once scaffold, quality, and benchmark evidence are all complete', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'database-lab/design/README.md' },
        { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'database-lab/prototype/scripts/bench.js' },
        {
          toolId: 'run_command',
          status: 'SUCCEEDED',
          argumentsSummary: 'npm run bench -- --dry-run',
          detail: 'workingDirectory=database-lab/prototype',
          resultSummary: '{"status":"ok","summary":"dry run complete","metrics":{"pagesWritten":4,"pagesRead":4,"writeDurationMs":2,"readDurationMs":2,"totalDurationMs":4}}',
        },
      ],
    },
    debug: {
      executionSummary: {
        providerSummary: {
          modelId: 'mimo-v2.5',
        },
        acceptance: {
          quality: {
            profileId: 'database_near_mysql_design',
            verdict: 'passed',
            failedChecks: [],
            requiredNextEvidence: [],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/buffer-pool.js',
      'quality/database-design.json',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.equal(instruction.metadata.phase, 'finalize');
  assert.deepEqual(instruction.metadata.allowedTools, []);
  assert.match(instruction.message, /Do not emit any tool calls/i);
  assert.match(instruction.message, /status to COMPLETE/i);
  assert.match(instruction.message, /database-lab\/prototype\/scripts\/bench\.js/i);
  assert.doesNotMatch(instruction.message, /database-lab\/prototype\/bench-data\/page_1\.bin/i);
  assert.doesNotMatch(instruction.message, /database-lab\/prototype\/bench-wal\/wal\.log/i);
  assert.doesNotMatch(instruction.message, /database-lab\/prototype\/package-lock\.json/i);
});

test('database prototype contract repair chunks mixed constructor and transaction drift', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        scripts: {
          bench: 'node scripts/bench.js',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'function dryRun() {',
        '  const storageEngine = new StorageEngine({ pageSize: 4096 });',
        '  const bufferPool = new BufferPool({ storageEngine, pageSize: 4096, poolSize: 32 });',
        '  const index = new BPlusTreeIndex({ order: 64 });',
        "  const walManager = new WALManager({ directory: '.bench-wal' });",
        '  const txnManager = new TransactionManager({ walManager, storageEngine, bufferPool, index });',
        '  return { storageEngine, bufferPool, index, walManager, txnManager };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );

    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir, {
      'database-lab/prototype/src/storage-engine.js': [
        "'use strict';",
        "const path = require('path');",
        'class StorageEngine {',
        '  constructor(baseDir, opts = {}) {',
        "    this.baseDir = baseDir;",
        "    this.dataDir = path.join(baseDir, 'data');",
        '    this.pageSize = opts.pageSize || 4096;',
        '  }',
        '  readPage() { return null; }',
        '  writePage() { return true; }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n'),
      'database-lab/prototype/src/buffer-pool.js': [
        "'use strict';",
        'class BufferPool {',
        '  constructor(storageEngine, opts = {}) {',
        '    this.storage = storageEngine;',
        '    this.poolSize = opts.poolSize || 64;',
        '  }',
        '  getPage(tableName, pageId) { return this.storage.readPage(tableName, pageId); }',
        '  putPage(tableName, pageId, payload) { return this.storage.writePage(tableName, pageId, payload); }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n'),
      'database-lab/prototype/src/wal-manager.js': [
        "'use strict';",
        'class WalManager {',
        '  constructor(opts = {}) { this.dir = opts.dir || \'.bench-wal\'; }',
        '  beginTx(txId) { return txId; }',
        '  commitTx(txId) { return txId; }',
        '  abortTx(txId) { return txId; }',
        '}',
        'module.exports = { WalManager };',
      ].join('\n'),
      'database-lab/prototype/src/transaction-manager.js': [
        "'use strict';",
        'class TransactionManager {',
        '  constructor({ wal, bufferPool, storage } = {}) {',
        '    this.wal = wal;',
        '    this.bufferPool = bufferPool;',
        '    this.storage = storage;',
        '  }',
        '  begin() { return { id: 1 }; }',
        '  commit(txnId) { return this.wal.append({ type: \'COMMIT\', txnId }); }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n'),
    });

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
        ],
      },
      task: {
        toolInvocations: [],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['benchmark_self_check_failed'],
              requiredNextEvidence: ['repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'prototype_contract_repair');
    assert.ok(instruction.metadata.targetPaths.includes('database-lab/prototype/scripts/bench.js'));
    assert.ok(instruction.metadata.targetPaths.length <= 6);
    assert.ok(instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/package.json'));
    assert.ok(instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/src/storage-engine.js'));
    assert.ok(instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/src/buffer-pool.js'));
    assert.match(instruction.message, /Repair only this next narrow prototype batch now/i);
    assert.match(instruction.message, /database-lab\/prototype\/src\/storage-engine\.js/i);
    assert.match(instruction.message, /StorageEngine is constructed consistently/i);
    assert.match(instruction.message, /BufferPool is constructed consistently/i);
    assert.match(instruction.message, /TransactionManager only calls WALManager methods that really exist/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design reserves one extra finalize continue after the base scenario budget is exhausted', async () => {
  const { canIssueContinue } = await loadWaveModule();
  const spec = { id: 'database-near-mysql-design' };
  const exhaustedAttempts = Array.from({ length: 12 }, (_, index) => ({
    metadata: {
      phase: index === 11 ? 'benchmark_self_check' : 'prototype_modules',
      allowedTools: ['write_file'],
    },
  }));
  const finalizeInstruction = {
    message: 'finalize',
    metadata: {
      phase: 'finalize',
      allowedTools: [],
    },
  };
  const ordinaryInstruction = {
    message: 'prototype follow-up',
    metadata: {
      phase: 'prototype_modules',
      allowedTools: ['write_file'],
    },
  };

  assert.equal(canIssueContinue(spec, exhaustedAttempts, finalizeInstruction), true);
  assert.equal(canIssueContinue(spec, exhaustedAttempts, ordinaryInstruction), false);
  assert.equal(
    canIssueContinue(spec, exhaustedAttempts.concat([{ metadata: { phase: 'finalize', allowedTools: [] } }]), finalizeInstruction),
    false,
  );
});

test('database write-only continue prompt keeps repair turns tool-first and tracker-only', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
      visibleToolActivities: [
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
        { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
      ],
    },
    debug: {
      executionSummary: {
        acceptance: {
          quality: {
            profileId: 'database_near_mysql_design',
            verdict: 'failed',
            failedChecks: ['missing_database_design_manifest'],
            requiredNextEvidence: ['write quality/database-design.json with designFiles and implementedModules'],
          },
        },
      },
    },
    workspaceDir: os.tmpdir(),
    workspaceRelativeFiles: [
      'brief/workload-profile.md',
      'brief/mysql-targets.md',
      'brief/constraints.md',
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
    ],
  };

  const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
  assert.ok(instruction);
  assert.match(instruction.message, /append exactly one final tracker JSON/i);
  assert.match(instruction.message, /Do not emit an explicit output envelope in this repair turn/i);
  assert.doesNotMatch(instruction.message, /emit exactly one \[AGENT-001_OUTPUT\] JSON envelope/i);
});

test('database continue prompt repairs design manifest when benchmark already passed but implementedModules still claims a shallow barrel file', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/index.js',
    ]) {
      fs.mkdirSync(path.dirname(path.join(workspaceDir, ...relativePath.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "'use strict';",
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'async function dryRun() {',
        '  return { status: "success", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'), "class StorageEngine { readPage(){ return null; } writePage(){ return true; } } module.exports = { StorageEngine };\n", 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'), "class BufferPool { writePage(){ return true; } readPage(){ return null; } } module.exports = { BufferPool };\n", 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'index.js'), "'use strict';\nconst { StorageEngine } = require('./storage-engine');\nconst { BufferPool } = require('./buffer-pool');\nmodule.exports = { StorageEngine, BufferPool };\n", 'utf8');
    fs.writeFileSync(
      path.join(workspaceDir, 'quality', 'database-design.json'),
      JSON.stringify({
        profile: 'database_near_mysql_design',
        designFiles: [
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
        ],
        prototypeFiles: [
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
          'database-lab/prototype/src/b-plus-tree-index.js',
          'database-lab/prototype/src/wal-manager.js',
          'database-lab/prototype/src/transaction-manager.js',
          'database-lab/prototype/src/index.js',
        ],
        implementedModules: [
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
          'database-lab/prototype/src/index.js',
        ],
      }, null, 2),
      'utf8',
    );

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        summary: {
          lifecycleStatus: 'RUNNING',
          visibleToolActivities: [
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
            {
              toolId: 'run_command',
              status: 'SUCCEEDED',
              argumentsSummary: 'npm run bench -- --dry-run',
              resultSummary: '{"status":"success","summary":"ok","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
            },
          ],
        },
        debug: {
          executionSummary: {
            providerSummary: {
              modelId: 'mimo-v2.5',
            },
            acceptance: {
              quality: {
                profileId: 'database_near_mysql_design',
                verdict: 'failed',
                failedChecks: [
                  'module_too_shallow:database-lab/prototype/src/index.js',
                  'benchmark_self_check_not_grounded',
                ],
                requiredNextEvidence: [
                  'expand database-lab/prototype/src/index.js beyond a shallow placeholder',
                  'rerun the dry-run benchmark only after database-lab/prototype/src contains real modules and database-lab/prototype/scripts/bench.js imports them directly',
                ],
              },
            },
          },
        },
        workspaceDir,
        workspaceRelativeFiles: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          ...coreModuleFiles,
          'database-lab/prototype/src/index.js',
          'quality/database-design.json',
        ],
      },
    );

    assert.equal(instruction.metadata.phase, 'design_quality_repair');
    assert.deepEqual(instruction.metadata.targetPaths, ['quality/database-design.json']);
    assert.match(instruction.message, /dry-run benchmark already succeeded/i);
    assert.match(instruction.message, /remove them from implementedModules/i);
    assert.match(instruction.message, /src\/index\.js/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database continue prompt repairs benchmark module-system mismatches before rerunning bench', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });

    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/README.md',
      'quality/database-design.json',
    ]) {
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    const coreModuleFiles = writeDatabaseCorePrototypeModules(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'package.json'),
      JSON.stringify({
        name: 'db-prototype',
        private: true,
        type: 'module',
        scripts: {
          bench: 'node scripts/bench.js',
          'dry-run': 'node scripts/bench.js --dry-run',
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        'function dryRun() {',
        '  const metrics = { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 };',
        '  return { status: "success", summary: "placeholder", metrics };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'), 'class StorageEngine {} module.exports = { StorageEngine };\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'), 'class BufferPool {} module.exports = { BufferPool };\n', 'utf8');

    const scenarioState = {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
          {
            toolId: 'run_command',
            status: 'FAILED',
            activityId: 'tool_bench_failed',
            argumentsSummary: 'npm run bench -- --dry-run',
            resultSummary: 'ReferenceError: require is not defined in ES module scope',
          },
        ],
      },
      task: {
        toolInvocations: [
          {
            invocationId: 'tool_bench_failed',
            toolId: 'run_command',
            status: 'FAILED',
            arguments: {
              command: 'npm run bench -- --dry-run',
            },
            result: {
              stdout: '> db-prototype@0.1.0 bench\n> node scripts/bench.js --dry-run',
              stderr: "ReferenceError: require is not defined in ES module scope",
            },
          },
        ],
      },
      debug: {
        executionSummary: {
          providerSummary: {
            modelId: 'mimo-v2.5',
          },
          acceptance: {
            quality: {
              profileId: 'database_near_mysql_design',
              verdict: 'failed',
              failedChecks: ['missing_benchmark_self_check'],
              requiredNextEvidence: ['run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence'],
            },
          },
        },
      },
      workspaceDir,
      workspaceRelativeFiles: [
        'brief/workload-profile.md',
        'brief/mysql-targets.md',
        'brief/constraints.md',
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        ...coreModuleFiles,
        'quality/database-design.json',
      ],
    };

    const instruction = deriveContinueMessage({ id: 'database-near-mysql-design' }, scenarioState);
    assert.equal(instruction.metadata.phase, 'bench_module_system_repair');
    assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
    assert.deepEqual([...instruction.metadata.targetPaths].sort(), [
      'database-lab/prototype/package.json',
      'database-lab/prototype/scripts/bench.js',
      'database-lab/prototype/src/b-plus-tree-index.js',
      'database-lab/prototype/src/buffer-pool.js',
      'database-lab/prototype/src/storage-engine.js',
      'database-lab/prototype/src/transaction-manager.js',
      'database-lab/prototype/src/wal-manager.js',
    ].sort());
    assert.ok(
      instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/README.md'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.ok(
      instruction.metadata.allowedOptionalPaths.includes('database-lab/prototype/src/index.js'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.ok(
      instruction.metadata.allowedOptionalPaths.includes('quality/database-design.json'),
      JSON.stringify(instruction.metadata, null, 2),
    );
    assert.match(instruction.message, /remove "type": "module" from database-lab\/prototype\/package\.json/i);
    assert.match(instruction.message, /instantiate and call the real StorageEngine and BufferPool modules instead of placeholder counter loops/i);
    assert.match(instruction.message, /Do not emit run_command in this repair turn/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('database design manifest repair prompt constrains designFiles to existing docs', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-db-design-'));
  try {
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'design'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src'), { recursive: true });
    for (const relativePath of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
      'database-lab/prototype/package.json',
      'database-lab/prototype/README.md',
    ]) {
      fs.mkdirSync(path.dirname(path.join(workspaceDir, ...relativePath.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, ...relativePath.split('/')), '# ok\n', 'utf8');
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'database-lab', 'prototype', 'scripts', 'bench.js'),
      [
        "const { StorageEngine } = require('../src/storage-engine.js');",
        "const { BufferPool } = require('../src/buffer-pool.js');",
        "const { BPlusTreeIndex } = require('../src/b-plus-tree-index.js');",
        "const { WALManager } = require('../src/wal-manager.js');",
        "const { TransactionManager } = require('../src/transaction-manager.js');",
        'async function dryRun() {',
        '  const engine = new StorageEngine(".tmp");',
        '  const bufferPool = new BufferPool();',
        '  const index = new BPlusTreeIndex();',
        '  const wal = new WALManager();',
        '  const txManager = new TransactionManager();',
        '  const result = { status: "passed", summary: "ok", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 }, modules: { engine: !!engine, bufferPool: !!bufferPool, index: !!index, wal: !!wal, txManager: !!txManager } };',
        '  process.stdout.write(JSON.stringify(result));',
        '  return result;',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'storage-engine.js'), 'class StorageEngine { constructor(baseDir){ this.baseDir = baseDir; } open(){ return this; } readPage(){ return null; } writePage(){ return true; } initialize(){ return true; } } module.exports = { StorageEngine };\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'buffer-pool.js'), 'class BufferPool { constructor(){ this.pages = new Map(); } writePage(id, payload){ this.pages.set(id, payload); return payload; } readPage(id){ return this.pages.get(id) ?? null; } flush(){ return true; } } module.exports = { BufferPool };\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'b-plus-tree-index.js'), 'class BPlusTreeIndex { insert(){ return true; } search(){ return null; } } module.exports = { BPlusTreeIndex };\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'wal-manager.js'), 'class WALManager { appendEntry(entry){ return entry; } close(){ return true; } } module.exports = { WALManager };\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'database-lab', 'prototype', 'src', 'transaction-manager.js'), 'class TransactionManager { beginTransaction(){ return { id: 1 }; } commitTransaction(){ return true; } rollbackTransaction(){ return true; } } module.exports = { TransactionManager };\n', 'utf8');

    const instruction = deriveContinueMessage(
      { id: 'database-near-mysql-design' },
      {
        summary: {
          lifecycleStatus: 'RUNNING',
          visibleToolActivities: [
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/workload-profile.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/mysql-targets.md' },
            { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'brief/constraints.md' },
            {
              toolId: 'run_command',
              status: 'SUCCEEDED',
              activityId: 'tool_bench_passed',
              argumentsSummary: 'npm run bench -- --dry-run',
              resultSummary: '{"status":"passed","summary":"ok","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
            },
          ],
        },
        task: {
          toolInvocations: [
            {
              invocationId: 'tool_bench_passed',
              toolId: 'run_command',
              status: 'SUCCEEDED',
              arguments: {
                command: 'npm run bench -- --dry-run',
              },
              result: {
                exitCode: 0,
                stdout: '{"status":"passed","summary":"ok","metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":1,"readDurationMs":1,"totalDurationMs":2}}',
                stderr: '',
              },
            },
          ],
        },
        debug: {
          executionSummary: {
            providerSummary: {
              modelId: 'mimo-v2.5',
            },
          },
        },
        workspaceDir,
        workspaceRelativeFiles: [
          'brief/workload-profile.md',
          'brief/mysql-targets.md',
          'brief/constraints.md',
          'database-lab/design/README.md',
          'database-lab/design/architecture.md',
          'database-lab/design/storage-engine.md',
          'database-lab/design/sql-compatibility.md',
          'database-lab/design/benchmark-plan.md',
          'database-lab/prototype/package.json',
          'database-lab/prototype/README.md',
          'database-lab/prototype/scripts/bench.js',
          'database-lab/prototype/src/storage-engine.js',
          'database-lab/prototype/src/buffer-pool.js',
          'database-lab/prototype/src/b-plus-tree-index.js',
          'database-lab/prototype/src/wal-manager.js',
          'database-lab/prototype/src/transaction-manager.js',
        ],
      },
    );

    assert.equal(instruction.metadata.phase, 'design_manifest');
    assert.match(instruction.message, /designFiles must be a subset of the real design markdown files already on disk/i);
    for (const designFile of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      assert.match(instruction.message, new RegExp(designFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
    assert.match(instruction.message, /Do not invent extra design files such as indexing\.md, transactions\.md, wal-recovery\.md, or buffer-pool\.md/i);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
