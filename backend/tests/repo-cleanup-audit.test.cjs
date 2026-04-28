const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadRepoCleanupAuditModule() {
  const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/repo-cleanup-audit.mjs')).href;
  return import(modulePath);
}

test('buildRepoCleanupAudit separates active source, preserved reports, runtime, and legacy residue', async () => {
  const { buildRepoCleanupAudit } = await loadRepoCleanupAuditModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-cleanup-audit-'));

  try {
    await fs.mkdir(path.join(tempDir, 'backend', 'src'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'backend', 'data', 'providers'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'backend', 'backend'), { recursive: true });
    await fs.mkdir(path.join(tempDir, '.codex-run', 'logs'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'README.md'), '# test\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'backend', 'data', '.gitignore'), '*\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'backend', 'data', 'providers', 'manifest.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(tempDir, '.codex-run', 'logs', 'release-scorecard.json'), '{}\n', 'utf8');

    const manifest = await buildRepoCleanupAudit({
      rootDir: tempDir,
      trackedFiles: [
        'README.md',
        'backend/data/.gitignore',
        'backend/data/providers/manifest.json',
        'backend/backend/old.js'
      ]
    });

    assert.equal(manifest.trackedByCategory.activeSource, 1);
    assert.equal(manifest.trackedByCategory.runtimeBaseline, 2);
    assert.equal(manifest.trackedByCategory.legacyResidue, 1);
    assert.equal(manifest.preservedAuditEvidence.some((entry) => entry.path === '.codex-run/logs/release-scorecard.json'), true);
    assert.equal(manifest.deleteCandidates.some((entry) => entry.path === 'backend/backend_new_data'), true);
    assert.equal(manifest.legacyArchive.some((entry) => entry.path === 'backend/backend' && entry.exists), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
