const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('repo hygiene strips legacy and transition path references from official surfaces', () => {
  const root = path.resolve(__dirname, '..', '..');
  const script = path.join(root, 'scripts', 'check-repo-hygiene.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'achieved');
  assert.equal(Array.isArray(report.issues), true);
  assert.equal(report.issues.length, 0);
  assert.ok(report.checkedFileCount > 0);
});
