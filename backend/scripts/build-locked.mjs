import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockDir = path.resolve(backendRoot, '.scc-build.lock');
const lockFile = path.join(lockDir, 'owner.json');
const timeoutMs = Number.parseInt(process.env.SCC_BACKEND_BUILD_LOCK_TIMEOUT_MS ?? '300000', 10);
const staleAfterMs = Number.parseInt(process.env.SCC_BACKEND_BUILD_LOCK_STALE_MS ?? '600000', 10);
const pollMs = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function readLockOwner() {
  try {
    return JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleLockIfNeeded() {
  const owner = await readLockOwner();
  const createdAt = typeof owner?.createdAt === 'number' ? owner.createdAt : null;
  const pid = Number.isInteger(owner?.pid) ? owner.pid : null;
  const staleByAge = createdAt === null || Date.now() - createdAt > staleAfterMs;
  const staleByPid = pid !== null && !isProcessAlive(pid);
  if (staleByAge || staleByPid) {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function acquireLock() {
  const startedAt = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(lockFile, JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
      }, null, 2));
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      await removeStaleLockIfNeeded();
      if (Date.now() - startedAt > timeoutMs) {
        const owner = await readLockOwner();
        throw new Error(`Timed out waiting for backend build lock. owner=${JSON.stringify(owner)}`);
      }
      await sleep(pollMs);
    }
  }
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : npmCommand();
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', `${npmCommand()} run _build:tsc`]
      : ['run', '_build:tsc'];
    const child = spawn(command, args, {
      cwd: backendRoot,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Backend TypeScript build failed with code=${code ?? 'null'} signal=${signal ?? 'null'}.`));
    });
  });
}

async function main() {
  await acquireLock();
  try {
    await runBuild();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
