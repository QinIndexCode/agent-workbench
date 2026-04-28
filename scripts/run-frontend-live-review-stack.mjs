import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { buildXiaomiMimoFlashLiveEnv, resolveXiaomiMimoFlashDocPath } from './lib/xiaomi-mimo-live-provider.mjs';

const rootDir = process.cwd();
const windowsNodeDir = process.platform === 'win32' ? path.dirname(process.execPath) : null;
const preferredWindowsNpm = windowsNodeDir ? path.join(windowsNodeDir, 'npm.cmd') : null;
const preferredBackendPort = Number.parseInt(process.env.LIVE_REVIEW_BACKEND_PORT ?? '3611', 10);
const preferredFrontendPort = Number.parseInt(process.env.LIVE_REVIEW_FRONTEND_PORT ?? '5573', 10);
const reportPath =
  process.env.FRONTEND_LIVE_REVIEW_REPORT ??
  path.resolve(rootDir, '.codex-run', 'logs', 'frontend-live-task-review.json');

async function writeExternalBlockerReport(reason) {
  const fs = await import('node:fs/promises');
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: `http://127.0.0.1:${preferredFrontendPort}`,
    backendUrl: `http://127.0.0.1:${preferredBackendPort}`,
    providerId: process.env.BACKEND_NEW_LIVE_PROVIDER_ID ?? null,
    status: 'external_blocker',
    reason,
    scenarios: [],
    screenshots: []
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
    port += 1;
  }
  throw new Error(`Unable to find a free port starting from ${startPort}.`);
}

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

async function main() {
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir);

  const backendPort = await findAvailablePort(preferredBackendPort);
  const frontendPort = await findAvailablePort(preferredFrontendPort);
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;

  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    ...liveEnv,
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
  const readBackendLogs = collectOutput(backend, 'backend');
  const frontend = spawnNpm(['run', 'dev', '-w', 'frontend', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], {
    FRONTEND_BACKEND_PORT: String(backendPort),
    FRONTEND_DEV_PORT: String(frontendPort),
    VITE_BACKEND_SERVER_URL: backendBaseUrl
  });
  const readFrontendLogs = collectOutput(frontend, 'frontend');

  try {
    await waitForHttp(`${backendBaseUrl}/health`, 120_000);
    await waitForHttp(frontendBaseUrl, 120_000);

    const liveReview = spawnNpm(['run', 'live-review', '-w', 'frontend', '--'], {
      ...liveEnv,
      FRONTEND_BASE_URL: frontendBaseUrl,
      FRONTEND_LIVE_REVIEW_BACKEND_URL: backendBaseUrl,
      FRONTEND_LIVE_REVIEW_REPORT: reportPath
    });
    const readLiveReviewLogs = collectOutput(liveReview, 'frontend-live-review');
    const exitCode = await new Promise((resolve, reject) => {
      liveReview.once('error', reject);
      liveReview.once('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      const logs = readLiveReviewLogs();
      throw new Error(`frontend live review failed (${exitCode})\n${logs.stdout}\n${logs.stderr}`);
    }
  } catch (error) {
    const backendLogs = readBackendLogs();
    const frontendLogs = readFrontendLogs();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n[backend stdout]\n${backendLogs.stdout}\n[backend stderr]\n${backendLogs.stderr}\n[frontend stdout]\n${frontendLogs.stdout}\n[frontend stderr]\n${frontendLogs.stderr}`);
  } finally {
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend')
    ]);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
