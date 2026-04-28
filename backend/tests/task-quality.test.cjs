const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluateTaskQuality,
  getQualityProfilePromptSection,
} = require('../dist/domain/quality/task-quality');

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scc-quality-'));
}

function writeText(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, JSON.stringify(value, null, 2));
}

function evaluate(root, qualityProfileId, toolInvocations = []) {
  return evaluateTaskQuality({
    qualityProfileId,
    workspaceDir: root,
    toolInvocations,
  });
}

function makeSuccessfulBenchInvocation(invocationId = 'tool-bench-success') {
  return {
    invocationId,
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    startedAt: 1000,
    endedAt: 2000,
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
      workingDirectory: 'database-lab/prototype',
      command: 'npm run bench -- --dry-run',
    },
  };
}

const DATABASE_CORE_MODULE_PATHS = [
  'database-lab/prototype/src/storage-engine.js',
  'database-lab/prototype/src/buffer-pool.js',
  'database-lab/prototype/src/b-plus-tree-index.js',
  'database-lab/prototype/src/wal-manager.js',
  'database-lab/prototype/src/transaction-manager.js',
];

function writeDatabaseCoreModules(root, overrides = {}) {
  const defaultBodies = {
    'database-lab/prototype/src/storage-engine.js': [
      'class StorageEngine {',
      '  constructor(baseDir = ".tmp"){ this.baseDir = baseDir; this.pages = new Map(); }',
      '  initialize(){ return this; }',
      '  writePage(id, payload){ this.pages.set(id, payload); return payload; }',
      '  readPage(id){ return this.pages.get(id) ?? null; }',
      '  updateRow(id, payload){ this.pages.set(id, payload); return payload; }',
      '  close(){ return true; }',
      '}',
      'module.exports = { StorageEngine };',
    ].join('\n'),
    'database-lab/prototype/src/buffer-pool.js': [
      'class BufferPool {',
      '  constructor(storageEngine = null){ this.storageEngine = storageEngine; this.pages = new Map(); }',
      '  writePage(id, payload){ this.pages.set(id, payload); if (this.storageEngine?.writePage) { this.storageEngine.writePage(id, payload); } return payload; }',
      '  readPage(id){ return this.pages.get(id) ?? this.storageEngine?.readPage?.(id) ?? null; }',
      '  flush(){ return true; }',
      '}',
      'module.exports = { BufferPool };',
    ].join('\n'),
    'database-lab/prototype/src/b-plus-tree-index.js': [
      'class BPlusTreeIndex {',
      '  constructor(){ this.rows = new Map(); }',
      '  insert(key, rowId){ this.rows.set(key, rowId); return rowId; }',
      '  lookup(key){ return this.rows.get(key) ?? null; }',
      '  scan(){ return Array.from(this.rows.entries()); }',
      '}',
      'module.exports = { BPlusTreeIndex };',
    ].join('\n'),
    'database-lab/prototype/src/wal-manager.js': [
      'class WALManager {',
      '  constructor(baseDir = ".tmp"){ this.baseDir = baseDir; this.entries = []; }',
      '  appendEntry(entry){ this.entries.push(entry); return this.entries.length; }',
      '  replay(){ return [...this.entries]; }',
      '  close(){ return true; }',
      '}',
      'module.exports = { WALManager };',
    ].join('\n'),
    'database-lab/prototype/src/transaction-manager.js': [
      'class TransactionManager {',
      '  constructor(){ this.nextId = 1; this.active = new Map(); }',
      '  beginTransaction(){ const tx = { id: this.nextId++, writes: [] }; this.active.set(tx.id, tx); return tx; }',
      '  commitTransaction(id){ const tx = this.active.get(id?.id ?? id); this.active.delete(id?.id ?? id); return tx ?? null; }',
      '  rollbackTransaction(id){ this.active.delete(id?.id ?? id); return true; }',
      '}',
      'module.exports = { TransactionManager };',
    ].join('\n'),
  };
  for (const relativePath of DATABASE_CORE_MODULE_PATHS) {
    writeText(root, relativePath, overrides[relativePath] ?? defaultBodies[relativePath]);
  }
  return [...DATABASE_CORE_MODULE_PATHS];
}

function makeSuccessfulWriteInvocation(relativePath, invocationId = `tool-write-${relativePath}`) {
  return {
    invocationId,
    toolId: 'write_file',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    startedAt: 3000,
    endedAt: 4000,
    arguments: {
      path: relativePath,
    },
    result: {
      path: relativePath,
    },
    error: null,
    metadata: {},
  };
}

test('web_experience rejects placeholder web artifacts and accepts grounded interactive static sites', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'site/index.html', '<h1>My Blog</h1><p>Lorem ipsum sample copy</p>');
    writeText(root, 'site/app.js', 'console.log("no interaction");');
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/app.js'],
      interactionSelectors: [],
      brandingTitle: 'My Blog',
    });

    const failed = evaluate(root, 'web_experience');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.some((check) => check.startsWith('placeholder_copy:')));
    assert.ok(failed.failedChecks.includes('missing_interaction_selectors'));

    writeText(root, 'site/index.html', '<h1>Field Notes on Runtime Quality Gates</h1><input placeholder="Email address"><button id="theme-toggle">Toggle contrast</button>');
    writeText(root, 'site/styles.css', '.newsletter-input::placeholder { color: #789; }');
    writeText(root, 'site/app.js', "'use strict';\nconst label = '\\2606';\ndocument.querySelector('#theme-toggle').addEventListener('click', () => document.body.classList.toggle('high-contrast'));");
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/styles.css', 'site/app.js'],
      interactionSelectors: ['#theme-toggle'],
      brandingTitle: 'Runtime Quality Notes',
    });

    const syntaxFailed = evaluate(root, 'web_experience');
    assert.equal(syntaxFailed.verdict, 'failed');
    assert.equal(syntaxFailed.failedChecks.some((check) => check.startsWith('placeholder_copy:')), false);
    assert.equal(syntaxFailed.failedChecks.some((check) => check.startsWith('javascript_syntax_error:')), true);

    writeText(root, 'site/index.html', '<h1>Field Notes on Runtime Quality Gates</h1><button id="theme-toggle">Toggle contrast</button>');
    writeText(root, 'site/app.js', 'document.querySelector("#theme-toggle").addEventListener("click", () => document.body.classList.toggle("high-contrast"));');
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/app.js'],
      interactionSelectors: ['#theme-toggle'],
      brandingTitle: 'Runtime Quality Notes',
    });

    const passed = evaluate(root, 'web_experience');
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_normalize requires source phrasing and traceable output mappings', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/product-notes.md', '# Product Notes\nLatency budget: p95 under 45ms for queue handoff.');
    writeText(root, 'normalized/product-notes.md', '# Feature 1\nRequirement A: improve performance.');
    writeJson(root, 'quality/docs-normalize-trace.json', {
      profile: 'docs_normalize',
      mappings: [{
        sourceFile: 'incoming/product-notes.md',
        outputFile: 'normalized/product-notes.md',
        sourceSnippets: ['Latency budget: p95 under 45ms for queue handoff.'],
      }],
    });

    const failed = evaluate(root, 'docs_normalize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('template_placeholder_detected:normalized/product-notes.md'));
    assert.ok(failed.failedChecks.includes('output_lost_source_phrasing:normalized/product-notes.md'));

    writeText(root, 'normalized/product-notes.md', '# Product Notes\nLatency budget: p95 under 45ms for queue handoff.\n\n## Index\n- Source: incoming/product-notes.md');
    const passed = evaluate(root, 'docs_normalize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_normalize requires markdown cross-links for normalized document sets', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/product-notes.md', '# Product Notes\ninteractive elegance\nadd author spotlight');
    writeText(root, 'incoming/content-roadmap.md', '# Content Roadmap\nweekly essays\ncreator interviews');
    writeText(root, 'incoming/launch-retro.md', '# Launch Retro\nreadable layouts\nfast navigation');
    writeText(root, 'normalized/index.md', '# Documentation Index\n\n- [Product Notes](product-notes.md)\n- [Content Roadmap](content-roadmap.md)\n- [Launch Retrospective](launch-retrospective.md)');
    writeText(root, 'normalized/product-notes.md', '# Product Notes\ninteractive elegance\nadd author spotlight');
    writeText(root, 'normalized/content-roadmap.md', '# Content Roadmap\nweekly essays\ncreator interviews');
    writeText(root, 'normalized/launch-retrospective.md', '# Launch Retrospective\nreadable layouts\nfast navigation');
    writeJson(root, 'quality/docs-normalize-trace.json', {
      profile: 'docs_normalize',
      mappings: [
        {
          sourceFile: 'incoming/product-notes.md',
          outputFile: 'normalized/product-notes.md',
          sourceSnippets: ['interactive elegance', 'add author spotlight'],
        },
        {
          sourceFile: 'incoming/content-roadmap.md',
          outputFile: 'normalized/content-roadmap.md',
          sourceSnippets: ['weekly essays', 'creator interviews'],
        },
        {
          sourceFile: 'incoming/launch-retro.md',
          outputFile: 'normalized/launch-retrospective.md',
          sourceSnippets: ['readable layouts', 'fast navigation'],
        },
      ],
    });

    const failed = evaluate(root, 'docs_normalize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('docs_normalize_missing_markdown_cross_references'));

    writeText(
      root,
      'normalized/product-notes.md',
      '# Product Notes\ninteractive elegance\nadd author spotlight\n\nSee the [content roadmap](content-roadmap.md).',
    );
    writeText(
      root,
      'normalized/launch-retrospective.md',
      '# Launch Retrospective\nreadable layouts\nfast navigation\n\nRefer back to the [product notes](product-notes.md).',
    );

    const passed = evaluate(root, 'docs_normalize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize rejects generic claims without source grounding', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/decision.md', '# Decision\nDecision: keep local-first approvals because remote browser control is out of scope.');
    writeText(root, 'handbook/decision-log.md', '# Decision Log\nThe platform has an enterprise-grade robust platform strategy.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/decision-log.md',
        claimText: 'The platform has an enterprise-grade robust platform strategy.',
        sourceFile: 'incoming/decision.md',
        sourceSnippets: ['Decision: keep local-first approvals because remote browser control is out of scope.'],
      }],
    });

    const failed = evaluate(root, 'docs_synthesize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('claim_not_lexically_grounded:handbook/decision-log.md'));

    writeText(root, 'handbook/decision-log.md', '# Decision Log\nDecision: keep local-first approvals because remote browser control is out of scope.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/decision-log.md',
        claimText: 'Decision: keep local-first approvals because remote browser control is out of scope.',
        sourceFile: 'incoming/decision.md',
        sourceSnippets: ['Decision: keep local-first approvals because remote browser control is out of scope.'],
      }],
    });

    const passed = evaluate(root, 'docs_synthesize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize accepts claim text that appears with markdown emphasis and title case in output', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'source/product-strategy.md', '# Product Strategy\n- Constraint: keep onboarding friction low');
    writeText(root, 'handbook/summary.md', '# Summary\nThe workflow must **Keep onboarding friction low**.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/summary.md',
        claimText: 'keep onboarding friction low',
        sourceFile: 'source/product-strategy.md',
        sourceSnippets: ['keep onboarding friction low'],
      }],
    });

    const result = evaluate(root, 'docs_synthesize');
    assert.equal(result.verdict, 'passed');
    assert.ok(!result.failedChecks.includes('claim_missing_from_output:handbook/summary.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize accepts claim text through normalized file-path wording and light inflection', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'source/product-strategy.md', '# Product Strategy\n- Constraint: keep onboarding friction low');
    writeText(root, 'handbook/index.md', '# Handbook Index\n\n- `source/product-strategy.md`\n');
    writeText(root, 'handbook/README.md', '# Readme\n\nKey constraints include keeping onboarding friction low.\n');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [
        {
          outputFile: 'handbook/index.md',
          claimText: 'Product Strategy',
          sourceFile: 'source/product-strategy.md',
          sourceSnippets: ['# Product Strategy'],
        },
        {
          outputFile: 'handbook/README.md',
          claimText: 'keep onboarding friction low',
          sourceFile: 'source/product-strategy.md',
          sourceSnippets: ['keep onboarding friction low'],
        },
      ],
    });

    const result = evaluate(root, 'docs_synthesize');
    assert.equal(result.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit checks reported facts against real tool output within tolerance', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-1',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    result: { stdout: 'FreePhysicalMemory : 8051548\nStatus : Running\n' },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 10');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'free_memory_kb',
        reportedValue: 10,
        sourceInvocationId: 'tool-1',
        sourceRegex: 'FreePhysicalMemory\\s*:\\s*(\\d+)',
      }],
    });

    const failed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('fact_value_mismatch:free_memory_kb'));
    assert.ok(failed.requiredNextEvidence.some((entry) => /reportedValue for free_memory_kb/i.test(entry)));

    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 8051548');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'free_memory_kb',
        reportedValue: 8051548,
        sourceInvocationId: 'tool-1',
        sourceRegex: 'FreePhysicalMemory\\s*:\\s*(\\d+)',
      }],
    });

    const passed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit gives actionable repair evidence when facts cite the wrong tool output', () => {
  const root = createTempRoot();
  const invocations = [
    {
      invocationId: 'tool-memory',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'FreePhysicalMemory=7302236\nTotalVisibleMemorySize=33279308\n' },
      error: null,
      metadata: {},
    },
    {
      invocationId: 'tool-disk',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'FreeSpaceGb : 86.33\nSizeGb      : 351.93\n' },
      error: null,
      metadata: {},
    },
  ];

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 7302236\nC drive free: 86.33');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'free_memory_kb',
          reportedValue: 7302236,
          sourceInvocationId: 'tool-disk',
          sourceContains: ['FreePhysicalMemory=7302236'],
        },
        {
          name: 'c_drive_free_gb',
          reportedValue: 86.33,
          sourceInvocationId: 'tool-memory',
          sourceContains: ['FreeSpaceGb : 86.33'],
        },
      ],
    });

    const failed = evaluate(root, 'system_audit', invocations);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('tool_output_mismatch:free_memory_kb'));
    assert.ok(failed.failedChecks.includes('tool_output_mismatch:c_drive_free_gb'));
    assert.ok(failed.requiredNextEvidence.some((entry) => /free_memory_kb.*sourceInvocationId.*FreePhysicalMemory=7302236/i.test(entry)));
    assert.ok(failed.requiredNextEvidence.some((entry) => /c_drive_free_gb.*sourceInvocationId.*FreeSpaceGb : 86\.33/i.test(entry)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit tolerates localized source labels when the reported value is grounded in tool output', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-systeminfo',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    result: {
      stdout: 'OS �汾:            10.0.26200 ��ȱ Build 26200\nOS Architecture: 64-bit\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nOS version: 10.0.26200 Build 26200');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'os_version',
        reportedValue: '10.0.26200 Build 26200',
        sourceInvocationId: 'tool-systeminfo',
        sourceContains: ['OS 版本:            10.0.26200 暂缺 Build 26200'],
      }],
    });

    const passed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('source_contains_value_grounded:os_version'));
    assert.ok(!passed.failedChecks.includes('tool_output_mismatch:os_version'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit rejects Win32 memory commands that divide KB values by 1MB', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-memory-bad-units',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: "Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object @{Name='TotalPhysicalMemoryMb';Expression={[math]::Round($_.TotalVisibleMemorySize/1MB,2)}}, @{Name='FreePhysicalMemoryMb';Expression={[math]::Round($_.FreePhysicalMemory/1MB,2)}} | Format-List",
    },
    result: {
      stdout: 'TotalPhysicalMemoryMb : 31.74\nFreePhysicalMemoryMb  : 7.01\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nTotal Physical Memory: 31.74 MB\nFree Physical Memory: 7.01 MB');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'total_physical_memory_mb',
          reportedValue: 31.74,
          sourceInvocationId: 'tool-memory-bad-units',
          sourceRegex: 'TotalPhysicalMemoryMb\\s*:\\s*([\\d.]+)',
        },
        {
          name: 'free_physical_memory_mb',
          reportedValue: 7.01,
          sourceInvocationId: 'tool-memory-bad-units',
          sourceRegex: 'FreePhysicalMemoryMb\\s*:\\s*([\\d.]+)',
        },
      ],
    });

    const failed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('memory_unit_mismatch_command:total_physical_memory_mb'));
    assert.ok(failed.failedChecks.includes('memory_unit_mismatch_command:free_physical_memory_mb'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop_observation requires real desktop process evidence and source mapping', () => {
  const root = createTempRoot();
  const desktopInvocation = {
    invocationId: 'tool-desktop',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: 'Get-Process | Select-Object -First 5 ProcessName,Responding,MainWindowTitle',
    },
    result: {
      stdout: 'ProcessName : explorer\nResponding  : True\nMainWindowTitle : Documents\n',
    },
    error: null,
    metadata: {},
  };
  const genericInvocation = {
    invocationId: 'tool-generic',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: 'Get-Date',
    },
    result: {
      stdout: 'Tuesday, April 28, 2026 09:00:00\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/desktop-observation.md', '# Desktop Observation\nExplorer responding: True');
    writeJson(root, 'quality/desktop-observation.json', {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [{
        name: 'explorer_responding',
        reportedValue: 'True',
        sourceInvocationId: 'tool-generic',
        sourceContains: ['explorer', 'Responding'],
      }],
    });

    const failed = evaluate(root, 'desktop_observation', [genericInvocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('not_desktop_observation:explorer_responding'));

    writeJson(root, 'quality/desktop-observation.json', {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [{
        name: 'explorer_responding',
        reportedValue: 'True',
        sourceInvocationId: 'tool-desktop',
        sourceRegex: 'Responding\\s*:\\s*(True|False)',
        sourceContains: ['ProcessName', 'explorer', 'Responding'],
      }],
    });

    const passed = evaluate(root, 'desktop_observation', [desktopInvocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('desktop_observation_grounded:explorer_responding'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design rejects README-only stubs and accepts runnable module depth', () => {
  const root = createTempRoot();
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

  try {
    writeText(root, 'database-lab/design/README.md', designText);
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'no actual database functionality is implemented');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function dryRun() {',
        '  const store = new PageStore();',
        '  const tx = new TransactionManager();',
        "  return { status: 'ok', summary: 'dry run complete', metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 }, storeReady: Boolean(store), txReady: Boolean(tx) };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeText(root, 'database-lab/prototype/src/storage.js', '// TODO stub');
    writeJson(root, 'quality/database-design.json', {
      profile: 'database_near_mysql_design',
      designFiles: ['database-lab/design/README.md'],
      prototypeFiles: ['database-lab/prototype/package.json', 'database-lab/prototype/README.md', 'database-lab/prototype/scripts/bench.js'],
      implementedModules: ['database-lab/prototype/src/storage.js'],
      claimBoundaries: ['target profile only'],
    });

    const failed = evaluate(root, 'database_near_mysql_design');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('insufficient_implemented_modules'));
    assert.ok(failed.failedChecks.includes('stub_module:database-lab/prototype/src/storage.js'));

    for (const file of [
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    const moduleBody = 'class PageStore { constructor(){ this.pages = new Map(); } writePage(id, row){ this.pages.set(id, { row, committed: true }); } readPage(id){ return this.pages.get(id) ?? null; } scan(){ return Array.from(this.pages.values()); } } module.exports = { PageStore };';
    writeText(root, 'database-lab/prototype/src/storage.js', moduleBody);
    writeText(root, 'database-lab/prototype/src/transactions.js', 'class TransactionManager { constructor(){ this.nextId = 1; this.active = new Map(); } begin(){ const id = this.nextId++; this.active.set(id, { writes: [] }); return id; } record(id, write){ this.active.get(id).writes.push(write); } commit(id){ const txn = this.active.get(id); this.active.delete(id); return txn.writes.length; } } module.exports = { TransactionManager };');
    const coreModules = writeDatabaseCoreModules(root);
    writeText(root, 'database-lab/prototype/README.md', 'Runnable prototype with page storage, transaction manager, and benchmark dry run. MySQL nearness remains an unproven target profile.');
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const passed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design prompt section example reflects the full core module set', () => {
  const prompt = getQualityProfilePromptSection('database_near_mysql_design').join('\n');
  assert.match(prompt, /database-lab\/prototype\/src\/storage-engine\.js/);
  assert.match(prompt, /database-lab\/prototype\/src\/buffer-pool\.js/);
  assert.match(prompt, /database-lab\/prototype\/src\/b-plus-tree-index\.js/);
  assert.match(prompt, /database-lab\/prototype\/src\/wal-manager\.js/);
  assert.match(prompt, /database-lab\/prototype\/src\/transaction-manager\.js/);
});

test('database_near_mysql_design rejects benchmark scaffolds with worker spread-push stack risk', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with worker-backed dry-run benchmark scaffold.');
    const coreModules = writeDatabaseCoreModules(root);
    writeText(
      root,
      'database-lab/prototype/src/storage.js',
      [
        'class PageStore {',
        '  constructor() {',
        '    this.pages = new Map();',
        '  }',
        '  writePage(id, row) {',
        '    const record = { id, row, updatedAt: Date.now(), committed: true };',
        '    this.pages.set(id, record);',
        '    return record;',
        '  }',
        '  readPage(id) {',
        '    return this.pages.get(id) ?? null;',
        '  }',
        '  scanPages() {',
        '    return Array.from(this.pages.values());',
        '  }',
        '}',
        'module.exports = { PageStore };',
      ].join('\n')
    );
    writeText(
      root,
      'database-lab/prototype/src/transactions.js',
      [
        'class TransactionManager {',
        '  constructor() {',
        '    this.nextId = 1;',
        '    this.active = new Map();',
        '  }',
        '  begin() {',
        '    const id = this.nextId++;',
        '    this.active.set(id, { writes: [], begunAt: Date.now() });',
        '    return id;',
        '  }',
        '  recordWrite(id, write) {',
        '    const txn = this.active.get(id);',
        '    txn.writes.push(write);',
        '    return txn.writes.length;',
        '  }',
        '  commit(id) {',
        '    const txn = this.active.get(id);',
        '    this.active.delete(id);',
        '    return { committed: true, writes: txn?.writes.length ?? 0 };',
        '  }',
        '}',
        'module.exports = { TransactionManager };',
      ].join('\n')
    );
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { Worker } = require('worker_threads');",
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function aggregate(results) {',
          '  const allLatencies = [];',
          '  for (const result of results) {',
          '    allLatencies.push(...result.latencies);',
          '  }',
        '  return { status: \'ok\', summary: \'dry run complete\', metrics: { pagesWritten: 4, pagesRead: 4, writeDurationMs: 2, readDurationMs: 2, totalDurationMs: 12 }, storeType: typeof PageStore, txType: typeof TransactionManager };',
        '}',
        'module.exports = { aggregate, Worker };',
      ].join('\n')
    );
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const failed = evaluate(root, 'database_near_mysql_design');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('benchmark_scaffold_stack_risk'));

    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { Worker } = require('worker_threads');",
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function aggregate(results) {',
        '  let totalSamples = 0;',
        '  let minLatencyMs = Number.POSITIVE_INFINITY;',
        '  let maxLatencyMs = 0;',
        '  for (const result of results) {',
        '    const latencies = Array.isArray(result.latencies) ? result.latencies : [];',
        '    totalSamples += latencies.length;',
        '    for (const latency of latencies) {',
        '      if (latency < minLatencyMs) minLatencyMs = latency;',
        '      if (latency > maxLatencyMs) maxLatencyMs = latency;',
        '    }',
        '  }',
        '  return { status: \'ok\', summary: \'dry run complete\', metrics: { totalSamples, minLatencyMs, maxLatencyMs, pagesWritten: 6, pagesRead: 6, writeDurationMs: 2, readDurationMs: 3, totalDurationMs: 12 }, storeType: typeof PageStore, txType: typeof TransactionManager };',
        '}',
        'module.exports = { aggregate, Worker };',
      ].join('\n')
    );

    const passed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design does not treat explanatory comments as stub modules', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with real modules and dry-run benchmark. MySQL parity remains unproven.');
    const coreModules = writeDatabaseCoreModules(root);
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { IndexManager } = require('../src/index-manager');",
        "const { TransactionManager } = require('../src/transactions');",
        'function dryRun() {',
        '  const index = new IndexManager();',
        '  const tx = new TransactionManager();',
        "  index.insert('pk:1', { pageId: 1, slotIndex: 0 });",
        '  return { status: "ok", summary: "dry run complete", metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12 }, indexReady: Boolean(index), txReady: Boolean(tx) };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeText(
      root,
      'database-lab/prototype/src/index-manager.js',
      [
        '/**',
        ' * Persistence-backed leaf linking is not implemented here yet.',
        ' * This comment should not cause a stub failure by itself.',
        ' */',
        'class IndexManager {',
        '  constructor(){ this.rows = new Map(); }',
        '  insert(key, payload){ this.rows.set(key, payload); return payload; }',
        '  lookup(key){ return this.rows.get(key) ?? null; }',
        '  rangeScan(prefix){ return Array.from(this.rows.entries()).filter(([key]) => key.startsWith(prefix)); }',
        '  delete(key){ return this.rows.delete(key); }',
        '}',
        'module.exports = { IndexManager };',
      ].join('\n')
    );
    writeText(
      root,
      'database-lab/prototype/src/transactions.js',
      'class TransactionManager { constructor(){ this.nextId = 1; this.active = new Map(); } begin(){ const id = this.nextId++; this.active.set(id, []); return id; } commit(id){ const writes = this.active.get(id) ?? []; this.active.delete(id); return writes.length; } rollback(id){ this.active.delete(id); return true; } } module.exports = { TransactionManager };'
    );
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/index-manager.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const result = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(result.verdict, 'passed', JSON.stringify(result, null, 2));
    assert.ok(!result.failedChecks.includes('stub_module:database-lab/prototype/src/index-manager.js'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design aligns bench dependencies with real src modules and manifest truth', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with benchmark scaffold and unproven MySQL-nearness.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { BufferPool } = require('../src/buffer-pool');",
        "const { StorageEngine } = require('../src/storage-engine');",
        'function dryRun() {',
        '  const pool = new BufferPool();',
        '  const engine = new StorageEngine(pool);',
        "  return { status: 'ok', summary: 'dry run complete', metrics: { pagesWritten: 10, pagesRead: 10, writeDurationMs: 4, readDurationMs: 4, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 }, engineReady: Boolean(engine) };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeText(
      root,
      'database-lab/prototype/src/storage-engine.js',
      [
        'class StorageEngine {',
        '  constructor(bufferPool) {',
        '    this.bufferPool = bufferPool;',
        '    this.pages = new Map();',
        '  }',
        '  writePage(id, payload) {',
        '    const page = { id, payload, committed: true, updatedAt: Date.now() };',
        '    this.pages.set(id, page);',
        '    return page;',
        '  }',
        '  readPage(id) {',
        '    return this.pages.get(id) ?? null;',
        '  }',
        '}',
        'module.exports = { StorageEngine };',
      ].join('\n')
    );
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        'database-lab/prototype/src/storage-engine.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const missingDependency = evaluate(root, 'database_near_mysql_design');
    assert.equal(missingDependency.verdict, 'failed');
    assert.ok(missingDependency.failedChecks.includes('benchmark_dependency_missing:database-lab/prototype/src/buffer-pool.js'));

    writeText(
      root,
      'database-lab/prototype/src/buffer-pool.js',
      [
        'class BufferPool {',
        '  constructor() {',
        '    this.frames = new Map();',
        '  }',
        '  pin(pageId, value) {',
        '    this.frames.set(pageId, { pageId, value, pinned: true });',
        '    return this.frames.get(pageId);',
        '  }',
        '  unpin(pageId) {',
        '    const frame = this.frames.get(pageId);',
        '    if (frame) frame.pinned = false;',
        '    return frame ?? null;',
        '  }',
        '}',
        'module.exports = { BufferPool };',
      ].join('\n')
    );

    const untrackedDependency = evaluate(root, 'database_near_mysql_design');
    assert.equal(untrackedDependency.verdict, 'failed');
    assert.ok(untrackedDependency.failedChecks.includes('benchmark_dependency_untracked:database-lab/prototype/src/buffer-pool.js'));

    const coreModules = writeDatabaseCoreModules(root);

    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const passed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design rejects benchmark scaffolds that never call real prototype modules', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with two runnable modules but a placeholder benchmark harness.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        'class PlaceholderStore {',
        '  constructor() {',
        '    this.rows = new Map();',
        '  }',
        '}',
        "function dryRun() { return { status: 'ok', summary: 'placeholder only', metrics: { pagesWritten: 0, pagesRead: 0, writeDurationMs: 0, readDurationMs: 0, totalDurationMs: 12 } }; }",
        'module.exports = { dryRun, PlaceholderStore };',
      ].join('\n')
    );
    writeText(root, 'database-lab/prototype/src/storage.js', 'class PageStore { constructor(){ this.rows = new Map(); } writePage(id, row){ this.rows.set(id, row); } readPage(id){ return this.rows.get(id) ?? null; } } module.exports = { PageStore };');
    writeText(root, 'database-lab/prototype/src/transactions.js', 'class TransactionManager { constructor(){ this.active = new Map(); this.nextId = 1; } begin(){ const id = this.nextId++; this.active.set(id, []); return id; } commit(id){ const writes = this.active.get(id) ?? []; this.active.delete(id); return writes.length; } } module.exports = { TransactionManager };');
    const coreModules = writeDatabaseCoreModules(root);
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const failed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('benchmark_not_wired_to_prototype_modules'));
    assert.ok(failed.failedChecks.includes('benchmark_self_check_not_grounded'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design treats invented manifest module paths as manifest drift, not missing required scaffold files', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with real modules and dry-run benchmark.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const BufferPool = require('../src/buffer-pool');",
        "const StorageEngine = require('../src/storage-engine');",
        'function dryRun() {',
        '  const storage = new StorageEngine();',
        '  const bufferPool = new BufferPool();',
        '  bufferPool.putPage(1, storage.insertRow ? storage : { id: 1 });',
        '  return { status: "ok", summary: "dry run complete", metrics: { pagesWritten: 1, pagesRead: 1, writeDurationMs: 1, readDurationMs: 1, totalDurationMs: 2 } };',
        '}',
        'module.exports = { dryRun };',
      ].join('\n'),
    );
    writeText(root, 'database-lab/prototype/src/buffer-pool.js', 'class BufferPool { constructor(){ this.pages = new Map(); } putPage(id, payload){ this.pages.set(id, payload); return payload; } getPage(id){ return this.pages.get(id) ?? null; } } module.exports = BufferPool;');
    writeText(root, 'database-lab/prototype/src/storage-engine.js', 'class StorageEngine { constructor(){ this.rows = new Map(); } insertRow(id, payload){ this.rows.set(id, payload); return payload; } updateRow(id, payload){ this.rows.set(id, payload); return payload; } close(){ return true; } } module.exports = StorageEngine;');
    writeJson(root, 'quality/database-design.json', {
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
        'database-lab/prototype/src/engine.js',
      ],
      implementedModules: [
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/engine.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const failed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('manifest_references_missing_file:database-lab/prototype/src/engine.js'));
    assert.ok(failed.failedChecks.includes('manifest_references_missing_implemented_module:database-lab/prototype/src/engine.js'));
    assert.ok(!failed.failedChecks.includes('missing_required_file:database-lab/prototype/src/engine.js'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design requires successful benchmark self-check evidence', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with real modules and dry-run benchmark.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function dryRun() {',
        '  const store = new PageStore();',
        '  const tx = new TransactionManager();',
        "  return { status: 'ok', summary: 'dry run complete', metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 }, storeReady: Boolean(store), txReady: Boolean(tx) };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeText(root, 'database-lab/prototype/src/storage.js', 'class PageStore { constructor(){ this.rows = new Map(); } writePage(id, row){ this.rows.set(id, row); } readPage(id){ return this.rows.get(id) ?? null; } } module.exports = { PageStore };');
    writeText(root, 'database-lab/prototype/src/transactions.js', 'class TransactionManager { constructor(){ this.active = new Map(); this.nextId = 1; } begin(){ const id = this.nextId++; this.active.set(id, []); return id; } commit(id){ const writes = this.active.get(id) ?? []; this.active.delete(id); return writes.length; } } module.exports = { TransactionManager };');
    const coreModules = writeDatabaseCoreModules(root);
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const missingEvidence = evaluate(root, 'database_near_mysql_design');
    assert.equal(missingEvidence.verdict, 'failed');
    assert.ok(missingEvidence.failedChecks.includes('missing_benchmark_self_check'));

    const passed = evaluate(root, 'database_near_mysql_design', [makeSuccessfulBenchInvocation()]);
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_design rejects stale benchmark evidence after later scaffold writes', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Prototype with real modules and dry-run benchmark.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function dryRun() {',
        '  const store = new PageStore();',
        '  const tx = new TransactionManager();',
        "  return { status: 'ok', summary: 'dry run complete', metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 }, storeReady: Boolean(store), txReady: Boolean(tx) };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeText(root, 'database-lab/prototype/src/storage.js', 'class PageStore { constructor(){ this.rows = new Map(); } writePage(id, row){ this.rows.set(id, row); } readPage(id){ return this.rows.get(id) ?? null; } } module.exports = { PageStore };');
    writeText(root, 'database-lab/prototype/src/transactions.js', 'class TransactionManager { constructor(){ this.active = new Map(); this.nextId = 1; } begin(){ const id = this.nextId++; this.active.set(id, []); return id; } commit(id){ const writes = this.active.get(id) ?? []; this.active.delete(id); return writes.length; } } module.exports = { TransactionManager };');
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });

    const result = evaluate(root, 'database_near_mysql_design', [
      makeSuccessfulBenchInvocation('tool-bench-success'),
      makeSuccessfulWriteInvocation('database-lab/prototype/scripts/bench.js'),
    ]);
    assert.equal(result.verdict, 'failed');
    assert.ok(result.failedChecks.includes('benchmark_self_check_stale'));
    assert.ok(result.requiredNextEvidence.some((entry) => entry.includes('rerun a successful dry-run benchmark command')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit reports invalid quality json explicitly instead of collapsing to missing evidence', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'quality/system-audit.json', '{"profile":"system_audit","facts":[{"name":"free_memory","sourceRegex":"FreePhysicalMemory\\s*:\\s*(\\d+)"}]}');

    const result = evaluate(root, 'system_audit', []);
    assert.equal(result.verdict, 'failed');
    assert.ok(result.failedChecks.includes('invalid_system_audit_json'));
    assert.ok(result.requiredNextEvidence.some((entry) => entry.includes('quality/system-audit.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database_near_mysql_verify requires real prototype src modules and valid benchmark json', () => {
  const root = createTempRoot();
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

  try {
    for (const file of [
      'database-lab/design/README.md',
      'database-lab/design/architecture.md',
      'database-lab/design/storage-engine.md',
      'database-lab/design/sql-compatibility.md',
      'database-lab/design/benchmark-plan.md',
    ]) {
      writeText(root, file, designText);
    }
    writeText(root, 'database-lab/prototype/package.json', '{"scripts":{"bench":"node scripts/bench.js --dry-run"}}');
    writeText(root, 'database-lab/prototype/README.md', 'Runnable prototype with unproven MySQL-nearness.');
    writeText(
      root,
      'database-lab/prototype/scripts/bench.js',
      [
        "const { PageStore } = require('../src/storage');",
        "const { TransactionManager } = require('../src/transactions');",
        'function dryRun() {',
        '  const store = new PageStore();',
        '  const tx = new TransactionManager();',
        "  return { status: 'ok', summary: 'dry run complete', metrics: { pagesWritten: 12, pagesRead: 12, writeDurationMs: 4, readDurationMs: 3, totalDurationMs: 12, latencyP95Ms: 3, throughputTps: 1200 }, storeReady: Boolean(store), txReady: Boolean(tx) };",
        '}',
        'module.exports = { dryRun };',
      ].join('\n')
    );
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });
    writeJson(root, 'quality/database-benchmark-result.json', {
      profile: 'database_near_mysql_verify',
      benchmarkCommand: 'npm run bench -- --dry-run',
      sourceInvocationId: 'tool-1',
      resultFile: 'database-lab/prototype/results/bench-dry-run.json',
      updatedDocs: ['database-lab/design/benchmark-plan.md'],
      implementedModules: ['database-lab/prototype/src/storage.js', 'database-lab/prototype/src/transactions.js'],
      verificationSummary: 'Dry-run benchmark completed; MySQL-nearness remains unproven.',
    });
    writeJson(root, 'database-lab/prototype/results/bench-dry-run.json', {
      status: 'ok',
      summary: 'dry run complete',
    });

    const failed = evaluate(root, 'database_near_mysql_verify', [makeSuccessfulBenchInvocation('tool-1')]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('missing_prototype_src_modules'));

    const moduleBody = 'class PageStore { constructor(){ this.pages = new Map(); } writePage(id, row){ this.pages.set(id, { row, committed: true }); } readPage(id){ return this.pages.get(id) ?? null; } scan(){ return Array.from(this.pages.values()); } } module.exports = { PageStore };';
    writeText(root, 'database-lab/prototype/src/storage.js', moduleBody);
    writeText(root, 'database-lab/prototype/src/transactions.js', 'class TransactionManager { constructor(){ this.nextId = 1; this.active = new Map(); } begin(){ const id = this.nextId++; this.active.set(id, { writes: [] }); return id; } record(id, write){ this.active.get(id).writes.push(write); } commit(id){ const txn = this.active.get(id); this.active.delete(id); return txn.writes.length; } } module.exports = { TransactionManager };');
    const coreModules = writeDatabaseCoreModules(root);
    writeJson(root, 'quality/database-design.json', {
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
      ],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      claimBoundaries: ['target profile only', 'not measured against MySQL'],
    });
    writeJson(root, 'quality/database-benchmark-result.json', {
      profile: 'database_near_mysql_verify',
      benchmarkCommand: 'npm run bench -- --dry-run',
      sourceInvocationId: 'tool-1',
      resultFile: 'database-lab/prototype/results/bench-dry-run.json',
      updatedDocs: ['database-lab/design/benchmark-plan.md'],
      implementedModules: [
        ...coreModules,
        'database-lab/prototype/src/storage.js',
        'database-lab/prototype/src/transactions.js',
      ],
      verificationSummary: 'Dry-run benchmark completed; MySQL-nearness remains unproven.',
    });

    const passed = evaluate(root, 'database_near_mysql_verify', [makeSuccessfulBenchInvocation('tool-1')]);
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
