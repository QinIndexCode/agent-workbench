import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createIsolatedBackendRuntimeRoot } from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const windowsNodeDir = process.platform === 'win32' ? path.dirname(process.execPath) : null;
const preferredWindowsNpm = windowsNodeDir ? path.join(windowsNodeDir, 'npm.cmd') : null;
const preferredBackendPort = Number.parseInt(process.env.E2E_BACKEND_PORT ?? '3411', 10);
const preferredFrontendPort = Number.parseInt(process.env.E2E_FRONTEND_PORT ?? '5373', 10);
const preferredMockProviderPort = Number.parseInt(process.env.E2E_MOCK_PROVIDER_PORT ?? '4011', 10);
const configuredBackendRootDir = process.env.E2E_BACKEND_ROOT_DIR?.trim() ?? '';
const backendRootDir = configuredBackendRootDir
  ? (path.isAbsolute(configuredBackendRootDir) ? configuredBackendRootDir : path.resolve(rootDir, configuredBackendRootDir))
  : createIsolatedBackendRuntimeRoot(rootDir, 'frontend-e2e');
const ownsBackendRootDir = !configuredBackendRootDir;

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

function spawnNode(args, env = {}) {
  return spawn(process.execPath, args, {
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
  const backendPort = await findAvailablePort(preferredBackendPort);
  const frontendPort = await findAvailablePort(preferredFrontendPort);
  const mockProviderPort = await findAvailablePort(preferredMockProviderPort);
  const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const mockProviderUrl = `http://127.0.0.1:${mockProviderPort}`;
  const frontendE2EReportPath = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-e2e-report.json');
  const frontendE2EScreenshotDir = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-e2e');
  if (ownsBackendRootDir) {
    fsSync.rmSync(backendRootDir, { recursive: true, force: true });
  }
  fsSync.mkdirSync(backendRootDir, { recursive: true });
  const mockProvider = spawnNode(['scripts/mock-provider-server.mjs'], {
    MOCK_PROVIDER_PORT: String(mockProviderPort)
  });
  const readMockProviderLogs = collectOutput(mockProvider, 'mock-provider');
  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    BACKEND_NEW_ROOT_DIR: backendRootDir,
    BACKEND_NEW_WORKSPACE_CWD: rootDir,
  });
  const readBackendLogs = collectOutput(backend, 'backend');
  const frontend = spawnNpm(['run', 'dev', '-w', 'frontend', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], {
    FRONTEND_BACKEND_PORT: String(backendPort),
    FRONTEND_DEV_PORT: String(frontendPort),
    VITE_BACKEND_SERVER_URL: backendBaseUrl
  });
  const readFrontendLogs = collectOutput(frontend, 'frontend');

  try {
    await waitForHttp(`${mockProviderUrl}/health`, 60_000);
    await waitForHttp(`${backendBaseUrl}/health`, 120_000);
    await waitForHttp(frontendBaseUrl, 120_000);

    const e2e = spawnNpm(['run', 'e2e', '-w', 'frontend', '--'], {
      FRONTEND_BASE_URL: frontendBaseUrl,
      FRONTEND_E2E_BACKEND_URL: backendBaseUrl,
      FRONTEND_E2E_MOCK_PROVIDER_URL: mockProviderUrl,
      FRONTEND_E2E_REPORT: frontendE2EReportPath,
      FRONTEND_E2E_SCREENSHOTS: frontendE2EScreenshotDir
    });
    const readE2eLogs = collectOutput(e2e, 'frontend-e2e');
    const exitCode = await new Promise((resolve, reject) => {
      e2e.once('error', reject);
      e2e.once('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      const logs = readE2eLogs();
      throw new Error(`frontend e2e failed (${exitCode})\n${logs.stdout}\n${logs.stderr}`);
    }
  } catch (error) {
    const mockProviderLogs = readMockProviderLogs();
    const backendLogs = readBackendLogs();
    const frontendLogs = readFrontendLogs();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n[mock provider stdout]\n${mockProviderLogs.stdout}\n[mock provider stderr]\n${mockProviderLogs.stderr}\n[backend stdout]\n${backendLogs.stdout}\n[backend stderr]\n${backendLogs.stderr}\n[frontend stdout]\n${frontendLogs.stdout}\n[frontend stderr]\n${frontendLogs.stderr}`);
  } finally {
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend'),
      terminateChild(mockProvider, 'mock-provider')
    ]);
    if (ownsBackendRootDir && process.env.SCC_PRESERVE_STACK_RUNTIME !== '1') {
      fsSync.rmSync(backendRootDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
