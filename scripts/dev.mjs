import { spawn, execSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { ensurePortsFree, DEFAULT_SERVICE_PORTS } from './lib/port-check.mjs';

const isWin = platform() === 'win32';
const root = resolve(import.meta.dirname, '..');
const backendDir = resolve(root, 'backend');
const frontendDir = resolve(root, 'frontend');

const processes = [];

function addProcess(name, command, args, cwd, useShell = false, env = {}) {
  const proc = spawn(command, args, {
    cwd,
    shell: useShell,
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    windowsHide: true,
  });

  const prefix = `[${name}]`;

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`${prefix} ${line}\n`);
    }
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`${prefix} ${line}\n`);
    }
  });

  proc.on('exit', (code) => {
    process.stdout.write(`${prefix} exited with code ${code ?? 0}\n`);
  });

  processes.push(proc);
  return proc;
}

function buildBackend() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsc', '-p', 'tsconfig.json'], {
      cwd: backendDir,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Backend build failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function main() {
  if (isWin) {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {}
  }

  await ensurePortsFree([
    { service: 'backend', port: DEFAULT_SERVICE_PORTS.backend },
    { service: 'frontend', port: DEFAULT_SERVICE_PORTS.frontend }
  ]);

  process.stdout.write('[dev] Building backend...\n');
  try {
    await buildBackend();
    process.stdout.write('[dev] Backend build complete.\n');
  } catch (err) {
    process.stderr.write(`[dev] Backend build failed: ${err.message}\n`);
    process.exit(1);
  }

  const backendEnv = {
    BACKEND_NEW_WORKSPACE_CWD: root,
    BACKEND_NEW_ROOT_DIR: resolve(backendDir, 'data'),
  };
  addProcess('backend', process.execPath, [resolve(backendDir, 'dist/bin/server.js')], backendDir, false, backendEnv);
  addProcess('worker', process.execPath, [resolve(backendDir, 'dist/bin/worker.js')], backendDir, false, backendEnv);
  addProcess('frontend', 'npx', ['vite', '--strictPort'], frontendDir, true);

  let cleaning = false;
  const cleanup = () => {
    if (cleaning) return;
    cleaning = true;
    process.stdout.write('\n[dev] Shutting down all processes...\n');
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {}
    }
    setTimeout(() => {
      process.exit(0);
    }, 2000);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  if (!isWin) process.on('SIGHUP', cleanup);

  process.on('exit', () => {
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {}
    }
  });
}

main().catch((err) => {
  process.stderr.write(`[dev] Fatal: ${err.message}\n`);
  process.exit(1);
});
