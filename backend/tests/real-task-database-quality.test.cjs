const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadDatabaseQualityModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'real-task-database-quality.mjs');
  return import(pathToFileURL(modulePath).href);
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scc-database-quality-'));
}

function writeText(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, JSON.stringify(value, null, 2));
}

const CORE_MODULES = [
  'database-lab/prototype/src/storage-engine.js',
  'database-lab/prototype/src/buffer-pool.js',
  'database-lab/prototype/src/b-plus-tree-index.js',
  'database-lab/prototype/src/wal-manager.js',
  'database-lab/prototype/src/transaction-manager.js',
];

const REQUIRED_DESIGN_FILES = [
  'database-lab/design/README.md',
  'database-lab/design/architecture.md',
  'database-lab/design/storage-engine.md',
  'database-lab/design/sql-compatibility.md',
  'database-lab/design/benchmark-plan.md',
];

const REQUIRED_PROTOTYPE_FILES = [
  'database-lab/prototype/package.json',
  'database-lab/prototype/README.md',
  'database-lab/prototype/scripts/bench.js',
];

function moduleBody(className) {
  return [
    `class ${className} {`,
    '  constructor(){ this.items = new Map(); this.history = []; this.initialized = true; }',
    '  open(){ this.history.push("open"); return this; }',
    '  writePage(id, payload){ this.items.set(id, payload); this.history.push(["write", id]); return payload; }',
    '  readPage(id){ this.history.push(["read", id]); return this.items.get(id) ?? null; }',
    '  close(){ this.history.push("close"); return this.history.length; }',
    '}',
    `module.exports = { ${className} };`,
  ].join('\n');
}

function makeSuccessfulBenchInvocation(invocationId = 'bench-success', endedAt = 2000) {
  return {
    invocationId,
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    startedAt: endedAt - 1000,
    endedAt,
    arguments: {
      command: 'npm run bench -- --dry-run',
      workingDirectory: 'database-lab/prototype',
    },
    result: {
      stdout: JSON.stringify({
        status: 'success',
        summary: 'dry run complete',
        metrics: {
          pagesWritten: 12,
          pagesRead: 12,
          writeDurationMs: 4,
          readDurationMs: 3,
          totalDurationMs: 12,
        },
      }),
    },
    error: null,
    metadata: {
      command: 'npm run bench -- --dry-run',
      workingDirectory: 'database-lab/prototype',
    },
  };
}

function makeSuccessfulWriteInvocation(relativePath, endedAt = 4000) {
  return {
    invocationId: `write-${relativePath}`,
    toolId: 'write_file',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    startedAt: endedAt - 1000,
    endedAt,
    arguments: { path: relativePath },
    result: { path: relativePath },
    error: null,
    metadata: {},
  };
}

function writeDatabaseDesignWorkspace(root) {
  const designText = [
    'storage page segment layout',
    'index btree hash strategy',
    'transaction concurrency lock mvcc model',
    'wal recovery checkpoint process',
    'buffer cache policy',
    'sql parser planner scope',
    'benchmark latency throughput tps plan',
    'current dry-run benchmark result remains unproven against real MySQL measurements',
  ].join('\n');
  for (const file of REQUIRED_DESIGN_FILES) {
    writeText(root, file, `# ${path.basename(file)}\n\n${designText}\n`);
  }
  writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
  writeText(root, 'database-lab/prototype/README.md', 'Runnable prototype with page storage, buffer cache, WAL, index, transactions, and dry-run benchmark evidence.');
  writeText(
    root,
    'database-lab/prototype/scripts/bench.js',
    [
      "const { StorageEngine } = require('../src/storage-engine');",
      "const { BufferPool } = require('../src/buffer-pool');",
      "const { BPlusTreeIndex } = require('../src/b-plus-tree-index');",
      "const { WALManager } = require('../src/wal-manager');",
      "const { TransactionManager } = require('../src/transaction-manager');",
      'function main(){',
      '  const engine = new StorageEngine().open();',
      '  const buffer = new BufferPool().open();',
      '  const index = new BPlusTreeIndex().open();',
      '  const wal = new WALManager().open();',
      '  const tx = new TransactionManager().open();',
      '  engine.writePage(1, { id: 1 }); buffer.writePage(1, { id: 1 }); index.writePage("tenant:1", 1); wal.writePage(1, "insert"); tx.writePage(1, "commit");',
      '  const metrics = { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 };',
      '  console.log(JSON.stringify({ status: "success", summary: "dry run complete", metrics }));',
      '}',
      'main();',
    ].join('\n'),
  );
  const classNames = ['StorageEngine', 'BufferPool', 'BPlusTreeIndex', 'WALManager', 'TransactionManager'];
  CORE_MODULES.forEach((file, index) => writeText(root, file, moduleBody(classNames[index])));
  writeJson(root, 'quality/database-design.json', {
    profile: 'database_near_mysql_design',
    designFiles: REQUIRED_DESIGN_FILES,
    prototypeFiles: REQUIRED_PROTOTYPE_FILES,
    implementedModules: CORE_MODULES,
    claimBoundaries: ['MySQL-nearness is a target profile, not a measured parity claim.'],
  });
}

test('database scenario design quality lives in harness and rejects stubs', async () => {
  const { evaluateDatabaseScenarioQuality } = await loadDatabaseQualityModule();
  const root = createTempRoot();
  try {
    writeDatabaseDesignWorkspace(root);
    writeText(root, CORE_MODULES[0], '// TODO stub');

    const failed = evaluateDatabaseScenarioQuality({
      qualityGateId: 'database_near_mysql_design',
      workspaceDir: root,
      toolInvocations: [makeSuccessfulBenchInvocation()],
    });
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes(`stub_module:${CORE_MODULES[0]}`));

    writeText(root, CORE_MODULES[0], moduleBody('StorageEngine'));
    const passed = evaluateDatabaseScenarioQuality({
      qualityGateId: 'database_near_mysql_design',
      workspaceDir: root,
      toolInvocations: [makeSuccessfulBenchInvocation()],
    });
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database scenario design quality requires fresh benchmark evidence after writes', async () => {
  const { evaluateDatabaseScenarioQuality } = await loadDatabaseQualityModule();
  const root = createTempRoot();
  try {
    writeDatabaseDesignWorkspace(root);
    const stale = evaluateDatabaseScenarioQuality({
      qualityGateId: 'database_near_mysql_design',
      workspaceDir: root,
      toolInvocations: [
        makeSuccessfulBenchInvocation('bench-before-write', 2000),
        makeSuccessfulWriteInvocation('database-lab/prototype/scripts/bench.js', 4000),
      ],
    });
    assert.equal(stale.verdict, 'failed');
    assert.ok(stale.failedChecks.includes('benchmark_self_check_stale'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database scenario verify quality requires benchmark result and implemented module evidence', async () => {
  const { evaluateDatabaseScenarioQuality } = await loadDatabaseQualityModule();
  const root = createTempRoot();
  try {
    writeDatabaseDesignWorkspace(root);
    writeJson(root, 'quality/database-benchmark-result.json', {
      profile: 'database_near_mysql_verify',
      benchmarkCommand: 'npm run bench -- --dry-run',
      sourceInvocationId: 'bench-success',
      resultFile: 'database-lab/prototype/results/bench-dry-run.json',
      updatedDocs: ['database-lab/design/benchmark-plan.md'],
      implementedModules: CORE_MODULES,
      verificationSummary: 'Dry-run benchmark completed; MySQL-nearness remains unproven.',
    });
    writeJson(root, 'database-lab/prototype/results/bench-dry-run.json', {
      status: 'success',
      summary: 'dry run complete',
      metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12 },
    });
    writeText(root, 'database-lab/design/benchmark-plan.md', '# Benchmark Plan\n\nDry-run result validated; MySQL-nearness remains unproven.');

    const passed = evaluateDatabaseScenarioQuality({
      qualityGateId: 'database_near_mysql_verify',
      workspaceDir: root,
      toolInvocations: [makeSuccessfulBenchInvocation('bench-success')],
    });
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));

    writeJson(root, 'quality/database-benchmark-result.json', {
      profile: 'database_near_mysql_verify',
      benchmarkCommand: 'npm run bench -- --dry-run',
      sourceInvocationId: 'bench-success',
      resultFile: 'database-lab/prototype/results/bench-dry-run.json',
      updatedDocs: ['database-lab/design/benchmark-plan.md'],
      implementedModules: [],
      verificationSummary: 'Incomplete verification manifest.',
    });
    const failed = evaluateDatabaseScenarioQuality({
      qualityGateId: 'database_near_mysql_verify',
      workspaceDir: root,
      toolInvocations: [makeSuccessfulBenchInvocation('bench-success')],
    });
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('missing_verified_implemented_modules'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
