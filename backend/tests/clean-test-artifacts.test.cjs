const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadCleanTestArtifactsModule() {
  const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/clean-test-artifacts.mjs')).href;
  return import(modulePath);
}

async function loadCleanRealTaskWaveStateModule() {
  const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/clean-real-task-wave-state.mjs')).href;
  return import(modulePath);
}

test('cleanHistoricalTestArtifacts preserves reusable release evidence reports by default', async () => {
  const { cleanHistoricalTestArtifacts } = await loadCleanTestArtifactsModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-test-artifacts-'));
  const logsDir = path.join(tempDir, '.codex-run', 'logs');

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, 'live-cost-probe.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'live-provider-scenarios.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'practical-live-task-acceptance.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'benchmark.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'frontend-smoke-report.json'), '{}', 'utf8');
    await fs.mkdir(path.join(logsDir, 'real-task-wave-matrix', 'current-run'), { recursive: true });
    await fs.writeFile(path.join(logsDir, 'real-task-wave-matrix', 'current-run', 'matrix-summary.json'), '{}', 'utf8');
    await fs.mkdir(path.join(logsDir, 'human-task-matrix', 'current-run'), { recursive: true });
    await fs.writeFile(path.join(logsDir, 'human-task-matrix', 'current-run', 'human-task-matrix-report.json'), '{}', 'utf8');

    const result = await cleanHistoricalTestArtifacts({
      cwd: tempDir,
      tmpDir: path.join(tempDir, 'tmp')
    });

    const remaining = (await fs.readdir(logsDir)).sort();
    assert.deepEqual(remaining, [
      'benchmark.json',
      'frontend-smoke-report.json',
      'human-task-matrix',
      'live-cost-probe.json',
      'live-provider-scenarios.json',
      'practical-live-task-acceptance.json',
      'real-task-wave-matrix'
    ]);
    assert.equal(result.skippedLogs.some((entry) => /live-cost-probe\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /frontend-smoke-report\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /real-task-wave-matrix$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /human-task-matrix$/i.test(entry.target)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cleanRealTaskWaveState can preserve matrix logs while cleaning transient wave artifacts', async () => {
  const { cleanRealTaskWaveState } = await loadCleanRealTaskWaveStateModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-real-task-wave-'));
  const matrixRunDir = path.join(tempDir, '.codex-run', 'logs', 'real-task-wave-matrix', 'old-run');

  try {
    await fs.mkdir(matrixRunDir, { recursive: true });
    await fs.writeFile(path.join(matrixRunDir, 'matrix-summary.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(tempDir, '.codex-run', 'logs', 'transient.log'), 'remove me', 'utf8');
    await fs.mkdir(path.join(tempDir, 'backend', 'data', 'providers'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'backend', 'data', 'providers', 'manifest.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'backend', 'data', 'transient.json'), '{}\n', 'utf8');

    const result = await cleanRealTaskWaveState({
      rootDir: tempDir,
      trackedPaths: new Set(['backend/data/providers/manifest.json']),
      externalPaths: [],
      legacyResiduePaths: [],
      preservedRepoPathPrefixes: ['.codex-run/logs/real-task-wave-matrix'],
    });

    await fs.access(path.join(matrixRunDir, 'matrix-summary.json'));
    await assert.rejects(() => fs.access(path.join(tempDir, '.codex-run', 'logs', 'transient.log')));
    await assert.rejects(() => fs.access(path.join(tempDir, 'backend', 'data', 'transient.json')));
    assert.equal(result.ok, true);
    assert.equal(result.residuals.dotCodexRun.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cleanRealTaskWaveState preserves matrix logs by default and does not recreate empty runtime stores', async () => {
  const { cleanRealTaskWaveState } = await loadCleanRealTaskWaveStateModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-real-task-wave-default-'));
  const matrixRunDir = path.join(tempDir, '.codex-run', 'logs', 'real-task-wave-matrix', 'current-run');
  const humanMatrixRunDir = path.join(tempDir, '.codex-run', 'logs', 'human-task-matrix', 'current-run');

  try {
    await fs.mkdir(matrixRunDir, { recursive: true });
    await fs.mkdir(humanMatrixRunDir, { recursive: true });
    await fs.writeFile(path.join(matrixRunDir, 'matrix-summary.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(humanMatrixRunDir, 'human-task-matrix-report.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(tempDir, '.codex-run', 'logs', 'real-task-wave-report.json'), '{}\n', 'utf8');
    await fs.mkdir(path.join(tempDir, 'backend', 'data', 'providers'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'backend', 'data', 'workspace'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'backend', 'data', 'providers', 'manifest.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'backend', 'data', 'workspace', 'transient.txt'), 'remove me', 'utf8');

    const result = await cleanRealTaskWaveState({
      rootDir: tempDir,
      trackedPaths: new Set(['backend/data/providers/manifest.json']),
      externalPaths: [],
      legacyResiduePaths: [],
    });

    await fs.access(path.join(matrixRunDir, 'matrix-summary.json'));
    await fs.access(path.join(humanMatrixRunDir, 'human-task-matrix-report.json'));
    await fs.access(path.join(tempDir, 'backend', 'data', 'providers'));
    await assert.rejects(() => fs.access(path.join(tempDir, '.codex-run', 'logs', 'real-task-wave-report.json')));
    await assert.rejects(() => fs.access(path.join(tempDir, 'backend', 'data', 'workspace')));
    assert.equal(result.ok, true);
    assert.equal(result.residuals.dotCodexRun.length, 0);
    assert.equal(result.residuals.backendData.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
