import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(currentDir, '..');
const connectionString = process.env.BACKEND_NEW_PG_TEST_URL ?? process.env.BACKEND_NEW_DATABASE_URL ?? '';

if (!connectionString.trim()) {
  console.error([
    'Postgres integration tests require BACKEND_NEW_PG_TEST_URL or BACKEND_NEW_DATABASE_URL.',
    'Example:',
    '  BACKEND_NEW_PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5432/scc_batch_test npm run test:postgres -w backend'
  ].join('\n'));
  process.exit(2);
}

const build = spawnSync('npm', ['run', 'build'], {
  cwd: backendDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
if ((build.status ?? 1) !== 0) {
  process.exit(build.status ?? 1);
}

const testRun = spawnSync(process.execPath, ['--test', 'tests/postgres-integration.test.cjs'], {
  cwd: backendDir,
  stdio: 'inherit',
  env: process.env
});

process.exit(testRun.status ?? 1);
