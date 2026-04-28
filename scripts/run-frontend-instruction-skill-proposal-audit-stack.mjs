import http from 'node:http';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const windowsNodeDir = process.platform === 'win32' ? path.dirname(process.execPath) : null;
const preferredWindowsNpm = windowsNodeDir ? path.join(windowsNodeDir, 'npm.cmd') : null;
const preferredWindowsNpmCli = windowsNodeDir ? path.join(windowsNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;
const backendPort = Number.parseInt(process.env.INSTRUCTION_SKILL_AUDIT_BACKEND_PORT ?? '3921', 10);
const frontendPort = Number.parseInt(process.env.INSTRUCTION_SKILL_AUDIT_FRONTEND_PORT ?? '5883', 10);
const mockProviderPort = Number.parseInt(process.env.INSTRUCTION_SKILL_AUDIT_MOCK_PROVIDER_PORT ?? '4321', 10);
const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
const mockProviderUrl = `http://127.0.0.1:${mockProviderPort}`;
const backendRootDir = path.join(
  rootDir,
  '.codex-run',
  'tmp',
  `instruction-skill-audit-${Date.now()}`
);

function spawnNpm(args, env = {}) {
  if (process.platform === 'win32') {
    if (preferredWindowsNpmCli && fsSync.existsSync(preferredWindowsNpmCli)) {
      return spawn(process.execPath, [preferredWindowsNpmCli, ...args], {
        cwd: rootDir,
        stdio: 'pipe',
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...env }
      });
    }
    const executable = preferredWindowsNpm ?? 'npm.cmd';
    return spawn(executable, args, {
      cwd: rootDir,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...env }
    });
  }
  return spawn('npm', args, {
    cwd: rootDir,
    stdio: 'pipe',
    env: { ...process.env, ...env }
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

function normalizeQueuedResponse(entry) {
  if (typeof entry === 'string') {
    return { content: entry, statusCode: 200, delayMs: 0 };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error('Queued provider response must be a string or object.');
  }
  if (typeof entry.error === 'string') {
    return {
      error: entry.error,
      statusCode: Number(entry.statusCode ?? 500),
      delayMs: Number(entry.delayMs ?? 0)
    };
  }
  return {
    content: String(entry.content ?? ''),
    statusCode: Number(entry.statusCode ?? 200),
    delayMs: Number(entry.delayMs ?? 0)
  };
}

async function createMockProviderServer(port) {
  let responses = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, queuedResponses: responses.length });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/__admin/reset') {
        const payload = await readJson(request);
        responses = Array.isArray(payload.responses)
          ? payload.responses.map((entry) => normalizeQueuedResponse(entry))
          : [];
        sendJson(response, 200, { ok: true, queuedResponses: responses.length });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (responses.length === 0) {
          sendJson(response, 500, { error: { message: 'mock provider queue is empty' } });
          return;
        }
        const next = responses.shift();
        if (next.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, next.delayMs));
        }
        if (next.error) {
          sendJson(response, next.statusCode, { error: { message: next.error } });
          return;
        }
        sendJson(response, next.statusCode, {
          id: `mock_${Date.now()}`,
          object: 'chat.completion',
          model: 'mock-e2e-model',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: next.content }
          }],
          usage: {
            prompt_tokens: 32,
            completion_tokens: Math.max(8, Math.ceil(next.content.length / 4)),
            total_tokens: 32 + Math.max(8, Math.ceil(next.content.length / 4))
          }
        });
        return;
      }
      sendJson(response, 404, {
        error: { message: `unknown mock provider route: ${request.method} ${url.pathname}` }
      });
    } catch (error) {
      sendJson(response, 500, {
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`[mock-provider] listening on ${port}\n`);
  return server;
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

async function closeServer(server, label) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(`[${label}] stopped\n`);
}

async function main() {
  fsSync.rmSync(backendRootDir, { recursive: true, force: true });
  fsSync.mkdirSync(backendRootDir, { recursive: true });
  const mockProvider = await createMockProviderServer(mockProviderPort);
  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    BACKEND_NEW_ROOT_DIR: backendRootDir
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

    const review = spawnNpm(['run', 'improvement-proposal-audit', '-w', 'frontend', '--'], {
      FRONTEND_BASE_URL: frontendBaseUrl,
      FRONTEND_IMPROVEMENT_AUDIT_BACKEND_URL: backendBaseUrl,
      FRONTEND_IMPROVEMENT_AUDIT_MOCK_PROVIDER_URL: mockProviderUrl,
      FRONTEND_IMPROVEMENT_AUDIT_MODE: 'instruction-skill'
    });
    const readReviewLogs = collectOutput(review, 'frontend-instruction-skill-proposal-audit');
    const exitCode = await new Promise((resolve, reject) => {
      review.once('error', reject);
      review.once('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      const logs = readReviewLogs();
      throw new Error(`frontend instruction-skill proposal audit failed (${exitCode})\n${logs.stdout}\n${logs.stderr}`);
    }
  } catch (error) {
    const backendLogs = readBackendLogs();
    const frontendLogs = readFrontendLogs();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n[backend stdout]\n${backendLogs.stdout}\n[backend stderr]\n${backendLogs.stderr}\n[frontend stdout]\n${frontendLogs.stdout}\n[frontend stderr]\n${frontendLogs.stderr}`);
  } finally {
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend'),
      closeServer(mockProvider, 'mock-provider')
    ]);
    fsSync.rmSync(backendRootDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
