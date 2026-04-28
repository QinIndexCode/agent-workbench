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

    const result = await cleanHistoricalTestArtifacts({
      cwd: tempDir,
      tmpDir: path.join(tempDir, 'tmp')
    });

    const remaining = (await fs.readdir(logsDir)).sort();
    assert.deepEqual(remaining, [
      'benchmark.json',
      'frontend-smoke-report.json',
      'live-cost-probe.json',
      'live-provider-scenarios.json',
      'practical-live-task-acceptance.json'
    ]);
    assert.equal(result.skippedLogs.some((entry) => /live-cost-probe\.json$/i.test(entry.target)), true);
    assert.equal(result.skippedLogs.some((entry) => /frontend-smoke-report\.json$/i.test(entry.target)), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
