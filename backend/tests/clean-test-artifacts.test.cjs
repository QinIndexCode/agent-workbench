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
    await fs.writeFile(path.join(logsDir, 'actual-user-cli-report.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'flagship-loop-report.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'frontend-live-task-review.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'ordinary-interaction-live-check.json'), '{}', 'utf8');
    await fs.writeFile(path.join(logsDir, 'agent-cli-live-task-check.json'), '{}', 'utf8');
    await fs.mkdir(path.join(logsDir, 'human-task-matrix', 'current-run'), { recursive: true });
    await fs.writeFile(path.join(logsDir, 'human-task-matrix', 'current-run', 'human-task-matrix-report.json'), '{}', 'utf8');

    const result = await cleanHistoricalTestArtifacts({
      cwd: tempDir,
      tmpDir: path.join(tempDir, 'tmp')
    });

    const remaining = (await fs.readdir(logsDir)).sort();
    assert.deepEqual(remaining, [
      'actual-user-cli-report.json',
      'agent-cli-live-task-check.json',
      'benchmark.json',
      'flagship-loop-report.json',
      'frontend-live-task-review.json',
      'frontend-smoke-report.json',
      'human-task-matrix',
      'live-cost-probe.json',
      'live-provider-scenarios.json',
      'ordinary-interaction-live-check.json',
      'practical-live-task-acceptance.json'
    ]);
    assert.equal(result.skippedLogs.some((entry) => /live-cost-probe\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /frontend-smoke-report\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /actual-user-cli-report\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /flagship-loop-report\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /frontend-live-task-review\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /ordinary-interaction-live-check\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /agent-cli-live-task-check\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /human-task-matrix$/i.test(entry.target)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cleanHistoricalTestArtifacts prunes oversized preserved log directories', async () => {
  const { cleanHistoricalTestArtifacts } = await loadCleanTestArtifactsModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-test-artifacts-size-'));
  const logsDir = path.join(tempDir, '.codex-run', 'logs');
  const matrixRunDir = path.join(logsDir, 'human-task-matrix', 'large-run');

  try {
    await fs.mkdir(matrixRunDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, 'flagship-loop-report.json'), '{}', 'utf8');
    await fs.writeFile(path.join(matrixRunDir, 'large-screenshot.png'), Buffer.alloc(128));

    const result = await cleanHistoricalTestArtifacts({
      cwd: tempDir,
      tmpDir: path.join(tempDir, 'tmp'),
      maxPreservedLogDirBytes: 64
    });

    const remaining = (await fs.readdir(logsDir)).sort();
    assert.deepEqual(remaining, ['flagship-loop-report.json']);
    assert.equal(result.removedLogs.some((entry) => /human-task-matrix$/i.test(entry)), true);
    assert.equal(result.skippedLogs.some((entry) => /flagship-loop-report\.json$/i.test(entry.target)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cleanHistoricalTestArtifacts removes codex-run tmp runtime roots', async () => {
  const { cleanHistoricalTestArtifacts } = await loadCleanTestArtifactsModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-test-artifacts-codex-tmp-'));
  const codexTmpDir = path.join(tempDir, '.codex-run', 'tmp');

  try {
    await fs.mkdir(path.join(codexTmpDir, 'frontend-mainline-review-123', 'workspace'), { recursive: true });
    await fs.writeFile(path.join(codexTmpDir, 'agent-cli-live-task-123.json'), '{}', 'utf8');
    await fs.mkdir(path.join(tempDir, 'backend', 'docs', 'mainline-artifacts'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'backend', 'docs', 'mainline-artifacts', 'review.md'), '# transient', 'utf8');

    const result = await cleanHistoricalTestArtifacts({
      cwd: tempDir,
      tmpDir: path.join(tempDir, 'tmp')
    });

    const remaining = await fs.readdir(codexTmpDir);
    assert.deepEqual(remaining, []);
    await assert.rejects(() => fs.access(path.join(tempDir, 'backend', 'docs', 'mainline-artifacts')));
    assert.equal(result.removedCodexTmp.some((entry) => /frontend-mainline-review-123$/i.test(entry)), true);
    assert.equal(result.removedCodexTmp.some((entry) => /agent-cli-live-task-123\.json$/i.test(entry)), true);
    assert.equal(result.removedProjectArtifacts.some((entry) => /backend[\\/]docs[\\/]mainline-artifacts$/i.test(entry)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
