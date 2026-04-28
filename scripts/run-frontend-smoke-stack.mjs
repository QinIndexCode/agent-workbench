import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { getPortStatus } from './lib/port-check.mjs';

const rootDir = process.cwd();
const windowsNodeDir = process.platform === 'win32' ? path.dirname(process.execPath) : null;
const preferredWindowsNpm = windowsNodeDir ? path.join(windowsNodeDir, 'npm.cmd') : null;
const backendPort = Number.parseInt(process.env.SMOKE_BACKEND_PORT ?? '3311', 10);
const frontendPort = Number.parseInt(process.env.SMOKE_FRONTEND_PORT ?? '5273', 10);
const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
const smokeTimeoutMs = Number.parseInt(process.env.FRONTEND_SMOKE_TIMEOUT_MS ?? '600000', 10);
const smokeReportPath = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-smoke-report.json');
const smokeScreenshotDir = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-smoke-snapshots');

function spawnNpm(args, env = {}) {
  if (process.platform === 'win32') {
    const executable = preferredWindowsNpm ?? 'npm.cmd';
    const quotedArgs = args.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(' ');
    return spawn('powershell.exe', ['-Command', `& '${executable.replace(/'/g, "''")}' ${quotedArgs}`], {
      cwd: rootDir,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...env
      }
    });
  }
  return spawn('npm', args, {
    cwd: rootDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      ...env
    }
  });
}

function collectOutput(child, label) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(`[${label}] ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(`[${label}] ${text}`);
  });
  return () => ({ stdout, stderr });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function terminateChild(child, label) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  } else {
    child.kill('SIGTERM');
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (exited === undefined && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      child.kill('SIGKILL');
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
  }
  process.stdout.write(`[${label}] stopped\n`);
}

async function waitForChildExit(child, label, timeoutMs) {
  let timeoutHandle;
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
      timeoutHandle = setTimeout(async () => {
        await terminateChild(child, label);
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function writeSmokeStackFailureReport(error, context) {
  const message = error instanceof Error ? error.message : String(error);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: frontendBaseUrl,
    passes: false,
    failureKind: message.includes('timed out') ? 'smoke_timeout' : 'smoke_stack_failure',
    error: message,
    timeoutMs: smokeTimeoutMs,
    backendPort,
    frontendPort,
    backendLogs: context.backendLogs,
    frontendLogs: context.frontendLogs,
    smokeLogs: context.smokeLogs ?? null
  };
  await fs.mkdir(path.dirname(smokeReportPath), { recursive: true });
  await fs.writeFile(smokeReportPath, JSON.stringify(report, null, 2));
}

async function cleanupPortOwners(portEntries) {
  for (const entry of portEntries) {
    const status = await getPortStatus(entry.port, entry.label);
    if (!status.occupied || !status.occupant?.pid) {
      continue;
    }
    const pid = String(status.occupant.pid);
    process.stdout.write(
      `[cleanup] terminating ${entry.label} port owner ${status.occupant.processName ?? 'process'} (${pid}) on ${entry.port}\n`
    );
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', pid, '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      spawnSync('kill', ['-TERM', pid], {
        stdio: 'ignore'
      });
    }
  }
}

async function main() {
  await cleanupPortOwners([
    { port: backendPort, label: 'smoke-backend' },
    { port: frontendPort, label: 'smoke-frontend' }
  ]);

  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    BACKEND_NEW_SERVER_PORT: String(backendPort)
  });
  const readBackendLogs = collectOutput(backend, 'backend');
  const frontend = spawnNpm(['run', 'dev', '-w', 'frontend', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], {
    FRONTEND_BACKEND_PORT: String(backendPort),
    FRONTEND_DEV_PORT: String(frontendPort),
    VITE_BACKEND_SERVER_URL: `http://127.0.0.1:${backendPort}`
  });
  const readFrontendLogs = collectOutput(frontend, 'frontend');
  let readSmokeLogs = null;

  try {
    await waitForHttp(`http://127.0.0.1:${backendPort}/health`, 120000);
    await waitForHttp(frontendBaseUrl, 120000);
    const smoke = spawnNpm(['run', 'smoke', '-w', 'frontend', '--'], {
      FRONTEND_BASE_URL: frontendBaseUrl,
      FRONTEND_SMOKE_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      FRONTEND_SMOKE_REPORT: smokeReportPath,
      FRONTEND_SMOKE_SCREENSHOTS: smokeScreenshotDir
    });
    readSmokeLogs = collectOutput(smoke, 'smoke');
    const exitCode = await waitForChildExit(smoke, 'smoke', smokeTimeoutMs);
    if (exitCode !== 0) {
      const logs = readSmokeLogs();
      throw new Error(`frontend smoke failed (${exitCode})\n${logs.stdout}\n${logs.stderr}`);
    }
  } catch (error) {
    const backendLogs = readBackendLogs();
    const frontendLogs = readFrontendLogs();
    const smokeLogs = typeof readSmokeLogs === 'function' ? readSmokeLogs() : null;
    await writeSmokeStackFailureReport(error, {
      backendLogs,
      frontendLogs,
      smokeLogs
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n[backend stdout]\n${backendLogs.stdout}\n[backend stderr]\n${backendLogs.stderr}\n[frontend stdout]\n${frontendLogs.stdout}\n[frontend stderr]\n${frontendLogs.stderr}`);
  } finally {
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend')
    ]);
    await cleanupPortOwners([
      { port: backendPort, label: 'smoke-backend' },
      { port: frontendPort, label: 'smoke-frontend' }
    ]);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
