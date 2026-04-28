import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { builtinModules as NODE_BUILTIN_MODULES, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanRealTaskWaveState } from './clean-real-task-wave-state.mjs';
import {
  buildXiaomiMimoFlashLiveEnv,
  readXiaomiMimoFlashProviderSource,
  resolveXiaomiMimoFlashDocPath,
  XIAOMI_MIMO_FAST_MODEL,
  XIAOMI_MIMO_FLASH_PROVIDER_ID,
  XIAOMI_MIMO_FLASH_SECRET_ID,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';
import {
  resolveBackendRuntimeManifestPath,
  resolveBackendRuntimeRoot,
} from './lib/backend-runtime-paths.mjs';
import {
  getScenarioQualityProfileId as getScenarioQualityProfileIdFromPack,
  getScenarioReuseWorkspace,
  getScenarioSeedFiles,
  scenarioRequiresStrongLiveModel as scenarioRequiresStrongLiveModelFromPack,
} from './lib/real-task-scenario-packs.mjs';

const rootDir = process.cwd();
const backendDataRoot = resolveBackendRuntimeRoot(rootDir);
const dotCodexRunRoot = path.resolve(rootDir, '.codex-run');
const reportDir = path.resolve(dotCodexRunRoot, 'logs');
const reportJsonPath = path.resolve(reportDir, 'real-task-wave-report.json');
const reportMarkdownPath = path.resolve(reportDir, 'real-task-wave-report.md');
const scenarioLogRoot = path.resolve(reportDir, 'real-task-wave');
const screenshotRoot = path.resolve(reportDir, 'real-task-wave-screenshots');
const backendCliPath = path.resolve(rootDir, 'backend', 'dist', 'bin', 'cli.js');
const backendQualityRuntimePath = path.resolve(rootDir, 'backend', 'dist', 'domain', 'quality', 'task-quality.js');
const preferredBackendPort = Number.parseInt(process.env.REAL_TASK_WAVE_BACKEND_PORT ?? '3811', 10);
const preferredFrontendPort = Number.parseInt(process.env.REAL_TASK_WAVE_FRONTEND_PORT ?? '5673', 10);
const targetExternalPath = 'D:\\AAA';
const DOCS_NORMALIZE_REQUIRED_FILES = [
  'normalized/index.md',
  'normalized/product-notes.md',
  'normalized/content-roadmap.md',
  'normalized/launch-retro.md',
];
const DOCS_SYNTHESIZE_REQUIRED_FILES = [
  'handbook/README.md',
  'handbook/index.md',
  'handbook/summary.md',
  'handbook/decision-log.md',
];
const SYSTEM_AUDIT_REQUIRED_FILES = [
  'reports/system-health.md',
  'quality/system-audit.json',
];
const DATABASE_LAB_ROOT = 'database-lab';
const DATABASE_LAB_DESIGN_DIR = `${DATABASE_LAB_ROOT}/design`;
const DATABASE_LAB_PROTOTYPE_DIR = `${DATABASE_LAB_ROOT}/prototype`;
const DATABASE_LAB_REQUIRED_DESIGN_FILES = [
  `${DATABASE_LAB_DESIGN_DIR}/README.md`,
  `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
  `${DATABASE_LAB_DESIGN_DIR}/storage-engine.md`,
  `${DATABASE_LAB_DESIGN_DIR}/sql-compatibility.md`,
  `${DATABASE_LAB_DESIGN_DIR}/benchmark-plan.md`,
];
const DATABASE_LAB_REQUIRED_PROTOTYPE_FILES = [
  `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
];
const DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES = [
  `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`,
  `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,
];
const DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES = [
  ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
];
const DATABASE_LAB_CANONICAL_MODULE_ALIASES = new Map([
  [`${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`],
  [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`],
]);
const DATABASE_LAB_PROTOTYPE_STACK_TARGETS = [
  `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
  ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
];
const DATABASE_LAB_DESIGN_TOPIC_GROUPS = {
  1: {
    label: 'storage/page/segment',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/storage-engine.md`,
    ],
  },
  2: {
    label: 'index/btree/hash',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/sql-compatibility.md`,
    ],
  },
  3: {
    label: 'transaction/concurrency/lock/mvcc',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/storage-engine.md`,
    ],
  },
  4: {
    label: 'wal/recovery/checkpoint',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/storage-engine.md`,
      `${DATABASE_LAB_DESIGN_DIR}/benchmark-plan.md`,
    ],
  },
  5: {
    label: 'buffer/cache',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/storage-engine.md`,
    ],
  },
  6: {
    label: 'sql/parser/planner',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/sql-compatibility.md`,
    ],
  },
  7: {
    label: 'benchmark/latency/throughput/tps',
    docs: [
      `${DATABASE_LAB_DESIGN_DIR}/README.md`,
      `${DATABASE_LAB_DESIGN_DIR}/architecture.md`,
      `${DATABASE_LAB_DESIGN_DIR}/benchmark-plan.md`,
    ],
  },
};
const DATABASE_LAB_DESIGN_QUALITY_FILE = 'quality/database-design.json';
const DATABASE_LAB_VERIFY_QUALITY_FILE = 'quality/database-benchmark-result.json';
const DATABASE_LAB_BENCH_RESULT_FILE = `${DATABASE_LAB_PROTOTYPE_DIR}/results/bench-dry-run.json`;
const requireFromScript = createRequire(import.meta.url);
const NODE_BUILTIN_MODULE_SET = new Set([
  ...NODE_BUILTIN_MODULES,
  ...NODE_BUILTIN_MODULES
    .filter((moduleName) => typeof moduleName === 'string' && !moduleName.startsWith('node:'))
    .map((moduleName) => `node:${moduleName}`),
]);
let sharedQualityRuntime = null;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function preferredWindowsNpm() {
  return process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function getDatabasePrototypePathsMentionedInText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  const normalized = text.replace(/\\/g, '/');
  const paths = new Set();
  const regex = /database-lab\/prototype\/(?:scripts\/bench\.js|src\/[A-Za-z0-9._-]+\.js)/g;
  for (const match of normalized.matchAll(regex)) {
    const relativePath = canonicalizeDatabasePrototypeModulePath(match[0]);
    if (DATABASE_LAB_PROTOTYPE_STACK_TARGETS.includes(relativePath)) {
      paths.add(relativePath);
    }
  }
  const stackText = normalized;
  const addIf = (pattern, relativePath) => {
    if (pattern.test(stackText)) {
      paths.add(relativePath);
    }
  };
  addIf(/(?:StorageEngine|storage|engine)\.(?:open|init|initialize|readPage|writePage|createFile)|StorageEngine\.|storage-engine\.js/i, `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`);
  addIf(/(?:BufferPool|bufferPool|pool)\.(?:open|init|initialize|getPage|putPage|readPage|writePage)|BufferPool\.|buffer-pool\.js/i, `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`);
  addIf(/(?:WALManager|wal)\.(?:open|init|initialize|append|appendEntry|close|getFlushCount)|WALManager\.|wal-manager\.js/i, `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`);
  addIf(/(?:TransactionManager|txManager|transactionManager)\.(?:begin|beginTransaction|commit|commitTransaction|rollback|rollbackTransaction|abort)|Transaction\s+(?:undefined|null|[^\s]+)\s+not found|transaction-manager\.js/i, `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`);
  if (/BPlusTreeIndex|b-plus-tree-index\.js/i.test(stackText)) {
    paths.add(`${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`);
  }
  return Array.from(paths);
}

function getScenarioQualityProfileId(spec) {
  return getScenarioQualityProfileIdFromPack(spec.id);
}

function getSharedQualityRuntime() {
  if (sharedQualityRuntime) {
    return sharedQualityRuntime;
  }
  if (!fsSync.existsSync(backendQualityRuntimePath)) {
    throw new Error(`Shared quality runtime is missing: ${backendQualityRuntimePath}`);
  }
  sharedQualityRuntime = requireFromScript(backendQualityRuntimePath);
  return sharedQualityRuntime;
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return Boolean(candidate && fsSync.existsSync(candidate));
    } catch {
      return false;
    }
  }) ?? null;
}

function spawnNpm(args, env = {}, cwd = rootDir) {
  if (process.platform === 'win32') {
    const executable = preferredWindowsNpm() ?? npmCommand();
    const quotedArgs = args.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(' ');
    return spawn('powershell.exe', ['-Command', `& '${executable.replace(/'/g, "''")}' ${quotedArgs}`], {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...env,
      },
    });
  }
  return spawn('npm', args, {
    cwd,
    stdio: 'pipe',
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
  });
}

function collectOutput(child, label) {
  let stdout = '';
  let stderr = '';
  const safeWrite = (stream, text) => {
    try {
      stream.write(text);
    } catch (error) {
      if (error?.code !== 'EPIPE') {
        throw error;
      }
    }
  };
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    safeWrite(process.stdout, `[${label}] ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    safeWrite(process.stderr, `[${label}] ${text}`);
  });
  return () => ({ stdout, stderr });
}

async function terminateChild(child, label) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000),
  ]);
  process.stdout.write(`[${label}] stopped\n`);
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
    await sleep(500);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(`Expected JSON output for ${label}, but stdout was empty.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const candidateIndexes = [];
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (character === '{' || character === '[') {
        candidateIndexes.push(index);
      }
    }
    for (let index = candidateIndexes.length - 1; index >= 0; index -= 1) {
      const candidate = trimmed.slice(candidateIndexes[index]);
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep searching for a valid JSON suffix.
      }
    }
    throw new Error(`Failed to parse JSON output for ${label}: ${error instanceof Error ? error.message : String(error)}\n${trimmed}`);
  }
}

async function runCli(args, env = {}, options = {}) {
  const child = spawn(process.execPath, [backendCliPath, ...args], {
    cwd: path.resolve(rootDir, 'backend'),
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(`[cli] ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(`[cli] ${text}`);
  });

  if (typeof options.stdinText === 'string') {
    child.stdin?.write(options.stdinText);
    child.stdin?.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`CLI command failed (${exitCode}): ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
  return {
    exitCode,
    stdout,
    stderr,
  };
}

function runCommandCapture(command, args, options = {}) {
  let executable = command;
  let finalArgs = args;
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    executable = 'powershell.exe';
    finalArgs = ['-Command', `& '${command.replace(/'/g, "''")}' ${args.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(' ')}`];
  }
  const result = spawnSync(executable, finalArgs, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
  return {
    command,
    args,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? (result.error.stack ?? result.error.message) : null,
  };
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `${init?.method ?? 'GET'} ${url} failed with ${response.status}`);
  }
  return payload;
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function writeText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function getTaskWorkspaceDir(taskId) {
  return path.join(backendDataRoot, 'workspace', taskId);
}

async function seedWorkspaceFiles(taskId, filesByRelativePath) {
  const workspaceDir = getTaskWorkspaceDir(taskId);
  const seededFiles = [];
  for (const [relativePath, content] of Object.entries(filesByRelativePath)) {
    const targetPath = path.join(workspaceDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf8');
    seededFiles.push({
      relativePath,
      absolutePath: targetPath,
    });
  }
  return seededFiles;
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function listFilesRecursive(root, options = {}) {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const files = [];

  async function walk(currentDir, depth) {
    if (depth > maxDepth) {
      return;
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await walk(root, 0);
  return files;
}

async function discoverNodeProjects(root) {
  const files = await listFilesRecursive(root, { maxDepth: 4 });
  return files.filter((filePath) => path.basename(filePath).toLowerCase() === 'package.json');
}

async function readJsonSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function findReusableScenarioWorkspace(scenarioId, predicate = null) {
  const scenarioResultPath = path.join(scenarioLogRoot, scenarioId, 'scenario-result.json');
  const scenarioResult = await readJsonSafe(scenarioResultPath);
  const workspaceDir = typeof scenarioResult?.workspaceDir === 'string' ? scenarioResult.workspaceDir : null;
  if (!workspaceDir || !fsSync.existsSync(workspaceDir)) {
    return null;
  }
  if (typeof predicate === 'function' && !predicate(scenarioResult)) {
    return null;
  }
  return {
    workspaceDir,
    scenarioResultPath,
    scenarioResult,
  };
}

function getTaskSummaryFields(task, debug) {
  const statusSummary = task?.statusSummary ?? {};
  const primaryAction = task?.primaryAction ?? {};
  const nextActionSummary = task?.nextActionSummary ?? {};
  return {
    taskId: task?.definition?.taskId ?? null,
    title: task?.definition?.title ?? null,
    lifecycleStatus: task?.runtime?.lifecycleStatus ?? null,
    currentUnitId: task?.runtime?.currentUnitId ?? null,
    blockingReason: statusSummary?.detail ?? null,
    nextAction: primaryAction?.label ?? nextActionSummary?.label ?? null,
    nextActionReason: primaryAction?.description ?? nextActionSummary?.reason ?? null,
    visibleToolActivities: Array.isArray(task?.visibleToolActivities) ? task.visibleToolActivities : [],
    acceptance: debug?.executionSummary?.acceptance ?? null,
  };
}

function evaluateScenarioQuality(spec, scenarioState) {
  const profileId = getScenarioQualityProfileId(spec);
  if (!profileId) {
    return {
      profileId: null,
      verdict: 'not_applicable',
      passedChecks: [],
      failedChecks: [],
      requiredNextEvidence: [],
      lastEvaluatedAt: null,
    };
  }
  const { evaluateTaskQuality } = getSharedQualityRuntime();
  const task = scenarioState.task ?? {};
  const definition = task.definition ?? {};
  const units = Array.isArray(definition.units) ? definition.units : [];
  const currentUnit = units.find((unit) => unit?.id === task.runtime?.currentUnitId) ?? units[0] ?? null;
  const artifactSummary = scenarioState.debug?.executionSummary ?? {};
  const latestVisibleOutput = task.latestVisibleOutput
    ? {
        summary: task.latestVisibleOutput.summary,
        details: task.latestVisibleOutput.details ?? null,
        issues: Array.isArray(task.latestVisibleOutput.issues) ? task.latestVisibleOutput.issues : [],
      }
    : null;
  const completionSummary = task.completionSummary
    ? {
        summary: task.completionSummary.summary ?? null,
        details: task.completionSummary.details ?? null,
        issues: Array.isArray(task.completionSummary.issues) ? task.completionSummary.issues : [],
      }
    : null;
  return evaluateTaskQuality({
    taskId: definition.taskId ?? scenarioState.summary?.taskId ?? 'unknown-task',
    title: definition.title ?? scenarioState.summary?.title ?? spec.title,
    intent: definition.intent ?? spec.intent,
    unitId: currentUnit?.id ?? null,
    executionProfileId: currentUnit?.executionProfileId ?? 'analyze',
    qualityProfileId: currentUnit?.qualityProfileId ?? profileId,
    workspaceDir: scenarioState.workspaceDir,
    artifactPaths: Array.isArray(artifactSummary.artifactPaths) ? artifactSummary.artifactPaths : [],
    artifactDestinationPaths: Array.isArray(artifactSummary.artifactDestinationPaths) ? artifactSummary.artifactDestinationPaths : [],
    artifactDestinationDir:
      artifactSummary.lastArtifactApplyResult?.destinationDir
      ?? artifactSummary.selectedArtifactDir
      ?? task.completionSummary?.artifactDestinationDir
      ?? task.latestVisibleOutput?.artifactDestinationDir
      ?? null,
    latestVisibleOutput,
    completionSummary,
    toolInvocations: Array.isArray(task.toolInvocations) ? task.toolInvocations : [],
    events: Array.isArray(task.events) ? task.events : [],
  });
}

async function ensureLiveProviderSecret(serverUrl, providerSource) {
  const baseArgs = ['--server', serverUrl];
  const secretSetResult = await runCli([
    ...baseArgs,
    'platform',
    'providers',
    'secrets',
    'set',
    '--secret-id',
    XIAOMI_MIMO_FLASH_SECRET_ID,
    '--provider',
    XIAOMI_MIMO_FLASH_PROVIDER_ID,
    '--label',
    XIAOMI_MIMO_FLASH_SECRET_ID,
    '--api-key',
    providerSource.apiKey,
  ]);
  const providerTestResult = await runCli([
    ...baseArgs,
    'platform',
    'providers',
    'test',
    XIAOMI_MIMO_FLASH_PROVIDER_ID,
  ]);
  return {
    secretSet: secretSetResult.stdout.trim(),
    providerTest: parseJsonOutput(providerTestResult.stdout, 'platform providers test'),
  };
}

async function patchConfig(serverUrl, patch) {
  return requestJson(`${serverUrl}/config`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

async function readTask(serverUrl, taskId) {
  return requestJson(`${serverUrl}/tasks/${taskId}`);
}

async function readTaskDebug(serverUrl, taskId) {
  return requestJson(`${serverUrl}/tasks/${taskId}/debug`);
}

async function captureTaskState(serverUrl, taskId) {
  const [task, debug] = await Promise.all([
    readTask(serverUrl, taskId),
    readTaskDebug(serverUrl, taskId),
  ]);
  return {
    task,
    debug,
    summary: getTaskSummaryFields(task, debug),
  };
}

async function attachWorkspaceSnapshot(scenarioState, workspaceDir) {
  const workspaceFiles = await listFilesRecursive(workspaceDir, { maxDepth: 6 }).catch(() => []);
  return {
    ...scenarioState,
    workspaceDir,
    workspaceRelativeFiles: workspaceFiles.map((filePath) => normalizeSlashes(path.relative(workspaceDir, filePath))),
  };
}

async function captureScreenshot(page, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function buildTaskSummaryText(scenarioState) {
  return [
    scenarioState?.task?.latestVisibleOutput?.summary ?? '',
    scenarioState?.task?.latestVisibleOutput?.details ?? '',
    scenarioState?.task?.completionSummary?.summary ?? '',
    scenarioState?.task?.completionSummary?.details ?? '',
    scenarioState?.debug?.executionSummary?.issueSummary ?? '',
  ].join('\n');
}

function getVisibleToolActivities(scenarioState) {
  return Array.isArray(scenarioState?.summary?.visibleToolActivities) ? scenarioState.summary.visibleToolActivities : [];
}

function hasExternalBlogWriteEvidence(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'write_file' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity.argumentsSummary ?? '',
      activity.resultSummary ?? '',
      activity.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /D:[\\/]+AAA[\\/]+(?:index\.html|styles\.css|script\.js)/i.test(text);
  });
}

function hasDesktopObservationEvidence(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'run_command' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity.argumentsSummary ?? '',
      activity.resultSummary ?? '',
      activity.detail ?? '',
    ].join(' ');
    return /(get-process|mainwindowtitle|explorer|msedge|code|responding|get-ciminstance|win32_operatingsystem|win32_processor|win32_logicaldisk|totalphysicalmemorymb|freephysicalmemorymb|numberofcores|numberoflogicalprocessors|maxclockspeed|freespacegb|sizegb)/i.test(text);
  });
}

function getScenarioWorkspaceFiles(scenarioState) {
  return Array.isArray(scenarioState?.workspaceRelativeFiles) ? scenarioState.workspaceRelativeFiles : [];
}

function hasWorkspaceFiles(scenarioState, requiredFiles) {
  const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
  return requiredFiles.every((relativePath) => workspaceFiles.includes(relativePath));
}

function getMissingWorkspaceFiles(scenarioState, requiredFiles) {
  const workspaceFiles = new Set(getScenarioWorkspaceFiles(scenarioState));
  return requiredFiles.filter((relativePath) => !workspaceFiles.has(relativePath));
}

function getToolActivitiesMatching(scenarioState, predicate) {
  return getVisibleToolActivities(scenarioState).filter((activity) => {
    try {
      return predicate(activity);
    } catch {
      return false;
    }
  });
}

function getSuccessfulToolActivitiesById(scenarioState, toolId) {
  return getToolActivitiesMatching(
    scenarioState,
    (activity) => activity?.toolId === toolId && activity?.status === 'SUCCEEDED',
  );
}

function getSuccessfulToolInvocationsById(scenarioState, toolId) {
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  const normalizedToolId = String(toolId ?? '').trim().toLowerCase();
  return [...taskInvocations, ...debugInvocations].filter((entry) => (
    entry?.status === 'SUCCEEDED'
    && String(entry?.toolId ?? '').trim().toLowerCase() === normalizedToolId
  ));
}

function getFailedToolActivitiesById(scenarioState, toolId) {
  return getToolActivitiesMatching(
    scenarioState,
    (activity) => activity?.toolId === toolId && activity?.status === 'FAILED',
  );
}

function countSuccessfulReadActivities(scenarioState, pathPattern) {
  const surfacedReadCount = getSuccessfulToolActivitiesById(scenarioState, 'read_file')
    .filter((activity) => {
      const text = [
        activity?.argumentsSummary ?? '',
        activity?.resultSummary ?? '',
        activity?.detail ?? '',
        ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
      ].join(' ');
      return pathPattern.test(text);
    })
    .length;
  if (surfacedReadCount > 0) {
    return surfacedReadCount;
  }
  return getSuccessfulToolInvocationsById(scenarioState, 'read_file')
    .filter((invocation) => {
      const text = [
        typeof invocation?.arguments?.path === 'string' ? invocation.arguments.path : '',
        typeof invocation?.result?.output?.path === 'string' ? invocation.result.output.path : '',
        typeof invocation?.result?.output?.file === 'string' ? invocation.result.output.file : '',
      ].join(' ');
      return pathPattern.test(text);
    })
    .length;
}

function countSuccessfulWriteActivities(scenarioState, pathPattern) {
  return getSuccessfulToolActivitiesById(scenarioState, 'write_file')
    .filter((activity) => {
      const text = [
        activity?.argumentsSummary ?? '',
        activity?.resultSummary ?? '',
        activity?.detail ?? '',
        ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
      ].join(' ');
      return pathPattern.test(text);
    })
    .length;
}

function hasMeaningfulWriteProgress(scenarioState, pathPattern) {
  if (getScenarioWorkspaceFiles(scenarioState).some((relativePath) => pathPattern.test(relativePath))) {
    return true;
  }
  if (countSuccessfulWriteActivities(scenarioState, pathPattern) > 0) {
    return true;
  }
  const progressHistory = Array.isArray(scenarioState?.debug?.runtime?.progressHistory)
    ? scenarioState.debug.runtime.progressHistory
    : Array.isArray(scenarioState?.runtime?.progressHistory)
      ? scenarioState.runtime.progressHistory
      : [];
  return progressHistory.some((entry) =>
    Array.isArray(entry?.filesCreated)
    && entry.filesCreated.some((relativePath) => typeof relativePath === 'string' && pathPattern.test(relativePath))
  );
}

function buildJsonToolCallPrelude() {
  return [
    'Return machine-readable JSON tool call objects first.',
    'For large markdown or code files, prefer write_file.arguments.content_lines over one giant escaped content string.',
    'For JSON manifests, prefer write_file.arguments.content_json over an escaped JSON string.',
    'After the tool calls, append exactly one final tracker JSON.',
    'Do not emit prose, markdown fences, or bullet lists.',
  ].join(' ');
}

function buildWriteOnlyRepairPrelude(requiredPaths, options = {}) {
  const allowTargetedReads = options?.allowTargetedReads === true;
  const normalizedPaths = Array.isArray(requiredPaths) ? requiredPaths.filter(Boolean) : [];
  const normalizedReadPaths = Array.isArray(options?.allowedReadPaths)
    ? options.allowedReadPaths.filter(Boolean)
    : normalizedPaths;
  const forbiddenWritePaths = Array.isArray(options?.forbiddenWritePaths)
    ? options.forbiddenWritePaths.filter(Boolean)
    : [];
  return [
    'Return machine-readable JSON tool call objects first.',
    `Emit write_file calls for these exact paths in this turn: ${normalizedPaths.join(', ')}.`,
    `Emit exactly ${normalizedPaths.length} write_file JSON objects in this turn, with one write_file object per listed path.`,
    'write_file automatically creates missing parent directories, so prefer write_file over create_folder for these repair targets.',
    'For larger markdown or code files, prefer write_file.arguments.content_lines instead of one giant escaped content string.',
    'For JSON manifests or package files, prefer write_file.arguments.content_json instead of an escaped JSON string.',
    allowTargetedReads
      ? `Prefer write_file directly because the current target file contents are already embedded below. If you truly need one more inspection pass before rewriting, you may emit read_file only for these exact allowed paths and at most once per path: ${normalizedReadPaths.join(', ')}. Do not read any other path.`
      : 'Do not emit create_folder, read_file, list_files, search_files, or run_command in this repair turn.',
    forbiddenWritePaths.length > 0
      ? `Do not emit write_file for any other path in this turn. The following paths are explicitly forbidden in this phase and will be treated as drift if written: ${forbiddenWritePaths.join(', ')}.`
      : null,
    'Do not emit an explicit output envelope in this repair turn unless the runtime explicitly asks for output correction. After the tool calls, append exactly one final tracker JSON that reports only the real files written in this turn.',
    'Do not emit prose, markdown fences, or bullet lists in this turn.',
  ].filter(Boolean).join(' ');
}

function canonicalizeDatabasePrototypeModulePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return relativePath;
  }
  return DATABASE_LAB_CANONICAL_MODULE_ALIASES.get(relativePath) ?? relativePath;
}

function extractFirstBalancedJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const source = text.trim();
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (character === '\\') {
        escapeNext = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function isInspectionOnlyReadDriftAttempt(attempt) {
  return Number(attempt?.observedWriteCount ?? 0) === 0
    && Array.isArray(attempt?.observedToolIds)
    && attempt.observedToolIds.length > 0
    && attempt.observedToolIds.every((toolId) => ['read_file', 'list_files', 'search_files'].includes(toolId));
}

function createContinueInstruction(message, metadata = null) {
  return {
    message,
    metadata: metadata && typeof metadata === 'object' ? metadata : null,
  };
}

function normalizeContinueInstruction(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return createContinueInstruction(value);
  }
  if (typeof value?.message === 'string' && value.message.trim()) {
    return createContinueInstruction(value.message, value.metadata ?? null);
  }
  return null;
}

function getScenarioWorkspaceFingerprint(scenarioState) {
  return getScenarioWorkspaceFiles(scenarioState)
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .join('|');
}

function getScenarioProviderFailure(scenarioState) {
  return scenarioState?.task?.diagnostics?.providerFailure
    ?? scenarioState?.debug?.task?.diagnostics?.providerFailure
    ?? null;
}

function formatProviderFailureSummary(providerFailure) {
  if (!providerFailure || typeof providerFailure !== 'object') {
    return null;
  }
  const parts = [];
  if (providerFailure.category || providerFailure.kind) {
    parts.push(`category=${providerFailure.category ?? providerFailure.kind}`);
  }
  if (typeof providerFailure.statusCode === 'number') {
    parts.push(`status=${providerFailure.statusCode}`);
  }
  if (typeof providerFailure.timeoutOrigin === 'string' && providerFailure.timeoutOrigin.trim()) {
    parts.push(`timeoutOrigin=${providerFailure.timeoutOrigin}`);
  }
  if (typeof providerFailure.elapsedMs === 'number') {
    parts.push(`elapsedMs=${providerFailure.elapsedMs}`);
  }
  if (typeof providerFailure.requestTimeoutMs === 'number') {
    parts.push(`requestTimeoutMs=${providerFailure.requestTimeoutMs}`);
  }
  if (typeof providerFailure.retryAttempt === 'number') {
    parts.push(`retryAttempt=${providerFailure.retryAttempt}`);
  }
  if (typeof providerFailure.message === 'string' && providerFailure.message.trim()) {
    parts.push(`message=${providerFailure.message.trim()}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function getRecentSuccessfulInvocationIds(scenarioState, toolId, limit = 5) {
  return getSuccessfulToolActivitiesById(scenarioState, toolId)
    .slice(-limit)
    .map((activity) => activity?.activityId)
    .filter(Boolean);
}

function getUnitInvalidOutputErrors(scenarioState) {
  const debug = scenarioState?.debug ?? scenarioState;
  return scenarioState?.task?.runtime?.schedulerUnits?.['AGENT-001']?.invalidOutputErrors
    ?? debug?.task?.runtime?.schedulerUnits?.['AGENT-001']?.invalidOutputErrors
    ?? [];
}

function getSourceFileForDocsNormalizeOutput(relativePath) {
  if (relativePath.endsWith('product-notes.md')) {
    return 'incoming/raw-product-notes.md';
  }
  if (relativePath.endsWith('content-roadmap.md')) {
    return 'incoming/content-roadmap draft.md';
  }
  if (relativePath.endsWith('launch-retro.md') || relativePath.endsWith('launch-retrospective.md')) {
    return 'incoming/launch-retro.MD';
  }
  return 'incoming/raw-product-notes.md';
}

function getSourceFilesForDocsNormalizeOutput(relativePath) {
  if (relativePath.endsWith('index.md')) {
    return [
      'incoming/raw-product-notes.md',
      'incoming/content-roadmap draft.md',
      'incoming/launch-retro.MD',
    ];
  }
  return [getSourceFileForDocsNormalizeOutput(relativePath)];
}

function readScenarioWorkspaceText(scenarioState, relativePath) {
  const workspaceDir = scenarioState?.workspaceDir;
  if (!workspaceDir || !relativePath) {
    return '';
  }
  try {
    return fsSync.readFileSync(path.join(workspaceDir, ...relativePath.split('/')), 'utf8').trim();
  } catch {
    return '';
  }
}

function readTextFileIfExists(filePath) {
  if (!filePath) {
    return '';
  }
  try {
    return fsSync.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function truncateScenarioPromptText(value, limit = 900) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function buildEmbeddedSourceBlocks(scenarioState, relativePaths) {
  return relativePaths
    .map((relativePath) => {
      const content = readScenarioWorkspaceText(scenarioState, relativePath);
      if (!content) {
        return null;
      }
      return `Source excerpt from ${relativePath}:\n<<<SOURCE\n${truncateScenarioPromptText(content, 1200)}\nSOURCE`;
    })
    .filter(Boolean);
}

function getScenarioToolInvocation(scenarioState, invocationId) {
  if (!invocationId) {
    return null;
  }
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  return [...taskInvocations, ...debugInvocations].find((entry) => entry?.invocationId === invocationId) ?? null;
}

function buildToolInvocationResultExcerpt(scenarioState, invocationId) {
  const invocation = getScenarioToolInvocation(scenarioState, invocationId);
  if (!invocation) {
    return null;
  }
  const stdout = typeof invocation?.result?.stdout === 'string'
    ? invocation.result.stdout.trim()
    : (typeof invocation?.metadata?.stdout === 'string' ? invocation.metadata.stdout.trim() : '');
  const stderr = typeof invocation?.result?.stderr === 'string'
    ? invocation.result.stderr.trim()
    : (typeof invocation?.metadata?.stderr === 'string' ? invocation.metadata.stderr.trim() : '');
  const errorText = typeof invocation?.error === 'string'
    ? invocation.error.trim()
    : (typeof invocation?.metadata?.error === 'string' ? invocation.metadata.error.trim() : '');
  const exitCode = Number.isFinite(invocation?.result?.exitCode)
    ? invocation.result.exitCode
    : (Number.isFinite(invocation?.metadata?.exitCode) ? invocation.metadata.exitCode : null);
  const parts = [];
  if (exitCode !== null) {
    parts.push(`exitCode: ${exitCode}`);
  }
  if (errorText) {
    parts.push(`error: ${errorText}`);
  }
  if (stdout) {
    parts.push(`stdout:\n${stdout}`);
  }
  if (stderr) {
    parts.push(`stderr:\n${stderr}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Observed output from ${invocationId}:\n<<<OUTPUT\n${truncateScenarioPromptText(parts.join('\n\n'), 1200)}\nOUTPUT`;
}

function collectAcceptanceRequiredNextEvidence(debug) {
  const deterministic = debug?.executionSummary?.acceptance?.deterministic ?? null;
  const quality = debug?.executionSummary?.acceptance?.quality ?? null;
  const buckets = [
    deterministic?.contract?.requiredNextEvidence,
    deterministic?.execution?.requiredNextEvidence,
    deterministic?.evidence?.requiredNextEvidence,
    deterministic?.outcome?.requiredNextEvidence,
    quality?.requiredNextEvidence,
  ];
  return Array.from(new Set(
    buckets
      .flatMap((entries) => Array.isArray(entries) ? entries : [])
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0),
  ));
}

function getLatestFailedToolInvocation(scenarioState) {
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  return [...taskInvocations, ...debugInvocations]
    .filter((entry) => entry?.status === 'FAILED')
    .sort((left, right) => {
      const leftAt = typeof left?.endedAt === 'number'
        ? left.endedAt
        : (typeof left?.startedAt === 'number' ? left.startedAt : 0);
      const rightAt = typeof right?.endedAt === 'number'
        ? right.endedAt
        : (typeof right?.startedAt === 'number' ? right.startedAt : 0);
      return rightAt - leftAt;
    })[0] ?? null;
}

function buildLatestToolFailureSummary(scenarioState) {
  const latestFailedInvocation = getLatestFailedToolInvocation(scenarioState);
  if (!latestFailedInvocation) {
    return null;
  }
  const excerpt = latestFailedInvocation.invocationId
    ? buildToolInvocationResultExcerpt(scenarioState, latestFailedInvocation.invocationId)
    : null;
  if (excerpt) {
    return excerpt;
  }
  const toolId = latestFailedInvocation.toolId ?? 'unknown_tool';
  const errorText = typeof latestFailedInvocation?.error === 'string'
    ? latestFailedInvocation.error.trim()
    : (typeof latestFailedInvocation?.metadata?.error === 'string' ? latestFailedInvocation.metadata.error.trim() : '');
  return errorText
    ? `Latest failed tool: ${toolId}. ${errorText}`
    : `Latest failed tool: ${toolId}.`;
}

function getSystemAuditFactFamily(factName) {
  if (typeof factName !== 'string' || factName.trim() === '') {
    return null;
  }
  if (/(total_physical_memory_mb|free_physical_memory_mb)/i.test(factName)) {
    return 'memory';
  }
  if (/(number_of_cores|number_of_logical_processors|max_clock_speed_mhz)/i.test(factName)) {
    return 'cpu';
  }
  if (/(disk_free_space_gb|disk_total_size_gb)/i.test(factName)) {
    return 'disk';
  }
  return null;
}

function getSystemAuditRunEvidenceCoverage(scenarioState) {
  const successfulActivities = getSuccessfulToolActivitiesById(scenarioState, 'run_command');
  const families = {
    memory: [],
    cpu: [],
    disk: [],
  };
  for (const activity of successfulActivities) {
    const invocationId = activity?.activityId;
    if (!invocationId) {
      continue;
    }
    const invocation = getScenarioToolInvocation(scenarioState, invocationId);
    const commandText = typeof invocation?.arguments?.command === 'string' ? invocation.arguments.command : '';
    const stdout = typeof invocation?.result?.stdout === 'string' ? invocation.result.stdout : '';
    const stderr = typeof invocation?.result?.stderr === 'string' ? invocation.result.stderr : '';
    const activityText = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      commandText,
      stdout,
      stderr,
    ].join('\n');
    if (/(TotalPhysicalMemoryMb|FreePhysicalMemoryMb|Win32_OperatingSystem|TotalVisibleMemorySize|FreePhysicalMemory)/i.test(activityText)) {
      families.memory.push(invocationId);
    }
    if (/(NumberOfCores|NumberOfLogicalProcessors|MaxClockSpeed|Win32_Processor)/i.test(activityText)) {
      families.cpu.push(invocationId);
    }
    if (/(FreeSpaceGb|SizeGb|Win32_LogicalDisk|DeviceID|FreeSpace)/i.test(activityText)) {
      families.disk.push(invocationId);
    }
  }
  const latestByFamily = Object.fromEntries(
    Object.entries(families).map(([family, invocationIds]) => [family, invocationIds[invocationIds.length - 1] ?? null]),
  );
  const missingFamilies = Object.entries(families)
    .filter(([, invocationIds]) => invocationIds.length === 0)
    .map(([family]) => family);
  return {
    successfulRunIds: successfulActivities.map((activity) => activity?.activityId).filter(Boolean),
    families,
    latestByFamily,
    missingFamilies,
  };
}

function getSystemAuditFamiliesFromFailures(failures) {
  const families = new Set();
  for (const failure of failures) {
    if (typeof failure !== 'string') {
      continue;
    }
    const factName = failure.includes(':') ? failure.split(':').slice(1).join(':') : failure;
    const family = getSystemAuditFactFamily(factName);
    if (family) {
      families.add(family);
    }
  }
  return Array.from(families);
}

function parseOutputContractKeys(spec) {
  try {
    const parsed = JSON.parse(spec?.unit?.outputContract ?? '{}');
    return Object.keys(parsed);
  } catch {
    return [];
  }
}

function hasDatabaseLabRequiredDesignFiles(scenarioState) {
  const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
  return DATABASE_LAB_REQUIRED_DESIGN_FILES.every((relativePath) => workspaceFiles.includes(relativePath));
}

function hasDatabaseLabRequiredPrototypeFiles(scenarioState) {
  const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
  if (!DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.every((relativePath) => workspaceFiles.includes(relativePath))) {
    return false;
  }
  return workspaceFiles.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
}

function hasDatabaseLabRequiredWorkspaceShape(scenarioState) {
  return hasDatabaseLabRequiredDesignFiles(scenarioState) && hasDatabaseLabRequiredPrototypeFiles(scenarioState);
}

function hasDatabaseLabArtifactEvidence(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'write_file' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity.argumentsSummary ?? '',
      activity.resultSummary ?? '',
      activity.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/](design|prototype)[\\/].+\.(md|js|json))/i.test(text);
  });
}

function hasDatabaseLabVerificationEvidence(scenarioState, options = {}) {
  const allowFailed = options.allowFailed === true;
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (!allowFailed && activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity?.toolId ?? '',
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    if (activity?.toolId === 'read_file' && /database-lab[\\/](design|prototype)[\\/].+\.(md|js|json)/i.test(text)) {
      return true;
    }
    if (
      activity?.toolId === 'run_command'
      && /(database-lab[\\/]prototype|bench\.js|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|synthetic benchmark|throughput|latency)/i.test(text)
    ) {
      return true;
    }
    return false;
  });
}

function hasSuccessfulDatabaseBenchRunEvidence(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'run_command' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    if (!/(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text)) {
      return false;
    }
    const invocation = getScenarioToolInvocation(scenarioState, activity?.activityId);
    const stdout = typeof invocation?.result?.stdout === 'string'
      ? invocation.result.stdout
      : (typeof invocation?.metadata?.stdout === 'string'
        ? invocation.metadata.stdout
        : (typeof activity?.resultSummary === 'string'
          ? activity.resultSummary
          : (typeof activity?.detail === 'string' ? activity.detail : '')));
    const stderr = typeof invocation?.result?.stderr === 'string'
      ? invocation.result.stderr
      : (typeof invocation?.metadata?.stderr === 'string'
        ? invocation.metadata.stderr
        : '');
    const exitCode = Number.isFinite(invocation?.result?.exitCode)
      ? invocation.result.exitCode
      : (Number.isFinite(invocation?.metadata?.exitCode) ? invocation.metadata.exitCode : 0);
    const verificationAudit = {
      command: 'run_command',
      args: [activity?.argumentsSummary ?? ''],
      exitCode,
      stdout,
      stderr,
    };
    return evaluateDatabaseBenchmarkSelfCheck(verificationAudit).passed;
  });
}

function hasObservedDatabaseBenchRunAttempt(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'run_command') {
      return false;
    }
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
  });
}

function getLatestDatabaseBenchRunFailure(scenarioState) {
  const failures = getFailedToolActivitiesById(scenarioState, 'run_command').filter((activity) => {
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
  });
  return failures.at(-1) ?? null;
}

function extractDatabaseLabBenchRequiredModuleFiles(benchScriptContent) {
  if (typeof benchScriptContent !== 'string' || benchScriptContent.trim().length === 0) {
    return [];
  }
  const dependencies = [];
  const patterns = [
    /require\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
    /from\s+['"`](\.\.?\/[^'"`]+)['"`]/g,
    /import\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(benchScriptContent)) !== null) {
      const specifier = String(match[1] ?? '').trim();
      if (!specifier) {
        continue;
      }
      let normalizedPath = path.posix.normalize(path.posix.join(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts`, specifier.replace(/\\/g, '/')));
      if (!normalizedPath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)) {
        continue;
      }
      if (!path.posix.extname(normalizedPath)) {
        normalizedPath = `${normalizedPath}.js`;
      }
      normalizedPath = canonicalizeDatabasePrototypeModulePath(normalizedPath);
      if (!dependencies.includes(normalizedPath)) {
        dependencies.push(normalizedPath);
      }
    }
  }
  return dependencies;
}

function getDatabaseLabBenchRequiredModuleFilesFromWorkspace(workspaceDir, workspaceRelativeFiles = []) {
  if (!workspaceDir) {
    return [];
  }
  const benchScriptRelativePath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  if (Array.isArray(workspaceRelativeFiles) && !workspaceRelativeFiles.includes(benchScriptRelativePath)) {
    return [];
  }
  const benchScriptPath = path.join(workspaceDir, ...benchScriptRelativePath.split('/'));
  if (!fsSync.existsSync(benchScriptPath)) {
    return [];
  }
  try {
    return extractDatabaseLabBenchRequiredModuleFiles(fsSync.readFileSync(benchScriptPath, 'utf8'));
  } catch {
    return [];
  }
}

function mergeDatabaseBenchRequiredModuleFiles(modulePaths, options = {}) {
  const includeCoreModuleBaseline = options?.includeCoreModuleBaseline === true;
  const merged = [
    ...(includeCoreModuleBaseline ? DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES : []),
    ...(Array.isArray(modulePaths) ? modulePaths : []),
  ]
    .map((relativePath) => canonicalizeDatabasePrototypeModulePath(relativePath))
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
  return Array.from(new Set(merged));
}

function getScenarioBenchRequiredModuleFiles(scenarioState, options = {}) {
  const workspaceRelativeFiles = getScenarioWorkspaceFiles(scenarioState);
  const extracted = getDatabaseLabBenchRequiredModuleFilesFromWorkspace(
    scenarioState?.workspaceDir ?? null,
    workspaceRelativeFiles,
  );
  const merged = mergeDatabaseBenchRequiredModuleFiles(extracted, {
    includeCoreModuleBaseline: options.includeCoreModuleBaseline === true,
  });
  if (merged.length > 0) {
    return merged;
  }
  if (options.fallbackToDefaultWhenEmpty === true) {
    return [...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES];
  }
  return [];
}

function stripQuotedToken(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractNodeEntryPath(command) {
  if (typeof command !== 'string') {
    return null;
  }
  const match = command.match(/^\s*node(?:\.exe)?\s+("[^"]+"|'[^']+'|[^\s]+)/i);
  if (!match) {
    return null;
  }
  const candidate = stripQuotedToken(match[1]);
  if (!candidate || candidate.startsWith('-')) {
    return null;
  }
  return normalizeSlashes(candidate.replace(/^\.\//, ''));
}

function getDatabaseLabPackageEntryDiagnostics(workspaceDir) {
  const prototypeRoot = path.join(workspaceDir, DATABASE_LAB_PROTOTYPE_DIR);
  const packageJsonPath = path.join(prototypeRoot, 'package.json');
  if (!fsSync.existsSync(packageJsonPath)) {
    return {
      packageJsonFound: false,
      invalidPackageJson: false,
      parseError: null,
      checkedEntries: [],
      missingEntryRefs: [],
      missingRequiredEntries: [],
    };
  }

  try {
    const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
    const checkedEntries = [];
    const missingEntryRefs = [];
    const missingRequiredEntries = [];

    const mainTarget = typeof packageJson.main === 'string'
      ? normalizeSlashes(stripQuotedToken(packageJson.main).replace(/^\.\//, ''))
      : null;
    if (mainTarget) {
      const present = fsSync.existsSync(path.join(prototypeRoot, ...mainTarget.split('/')));
      checkedEntries.push({ entry: 'main', target: mainTarget, present });
      if (!present) {
        missingEntryRefs.push(`main:${mainTarget}`);
      }
    }

    for (const scriptName of ['build', 'dry-run', 'bench']) {
      const scriptCommand = packageJson?.scripts?.[scriptName];
      const scriptTarget = extractNodeEntryPath(scriptCommand);
      if (!scriptTarget) {
        continue;
      }
      const present = fsSync.existsSync(path.join(prototypeRoot, ...scriptTarget.split('/')));
      checkedEntries.push({ entry: `scripts.${scriptName}`, target: scriptTarget, present });
      if (!present) {
        missingEntryRefs.push(`scripts.${scriptName}:${scriptTarget}`);
      }
    }

    if (typeof packageJson?.scripts?.bench !== 'string' && typeof packageJson?.scripts?.['dry-run'] !== 'string') {
      missingRequiredEntries.push('scripts.bench_or_dry-run');
    }

    return {
      packageJsonFound: true,
      invalidPackageJson: false,
      parseError: null,
      checkedEntries,
      missingEntryRefs,
      missingRequiredEntries,
    };
  } catch (error) {
    return {
      packageJsonFound: true,
      invalidPackageJson: true,
      parseError: error instanceof Error ? error.message : String(error),
      checkedEntries: [],
      missingEntryRefs: [],
      missingRequiredEntries: [],
    };
  }
}

function getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, options = {}) {
  const missingEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
    ? packageEntryDiagnostics.missingEntryRefs
    : [];
  const scenarioId = typeof options?.scenarioId === 'string' ? options.scenarioId : '';
  if (!scenarioId.startsWith('database-near-mysql-')) {
    return missingEntryRefs;
  }
  return missingEntryRefs.filter((entryRef) => entryRef !== 'main:src/index.js');
}

function getDatabasePrototypePathFromPackageEntryRef(entryRef) {
  if (typeof entryRef !== 'string' || !entryRef.includes(':')) {
    return null;
  }
  const [, rawTarget] = entryRef.split(/:(.+)/);
  const normalizedTarget = typeof rawTarget === 'string'
    ? normalizeSlashes(stripQuotedToken(rawTarget).replace(/^\.\//, ''))
    : '';
  if (!normalizedTarget) {
    return null;
  }
  return `${DATABASE_LAB_PROTOTYPE_DIR}/${normalizedTarget}`;
}

function getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, options = {}) {
  const targetPathSet = new Set(Array.isArray(repairTargets) ? repairTargets.filter(Boolean) : []);
  const packageEntryDiagnostics = options?.packageEntryDiagnostics ?? null;
  const blockingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
    scenarioId: typeof options?.scenarioId === 'string' ? options.scenarioId : '',
  });
  const optionalEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
    ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingEntryRefs.includes(entryRef))
    : (Array.isArray(options?.artifactProgress?.packageEntryRefs?.missingOptional)
      ? options.artifactProgress.packageEntryRefs.missingOptional
      : []);
  const optionalEntryPaths = optionalEntryRefs
    .map((entryRef) => getDatabasePrototypePathFromPackageEntryRef(entryRef))
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`));
  const optionalPaths = [
    repairTargets?.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
      ? DATABASE_LAB_DESIGN_QUALITY_FILE
      : null,
    `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`,
    ...optionalEntryPaths,
  ]
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.length > 0)
    .filter((relativePath) => !targetPathSet.has(relativePath));
  return Array.from(new Set(optionalPaths));
}

function getDatabaseLabPrototypeCodeDiagnostics(scenarioState) {
  const packageJsonPath = `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`;
  const storageEnginePath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`;
  const bufferPoolPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`;
  const walManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`;
  const transactionManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`;
  const queryExecutorPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`;
  const benchScriptPath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  const packageJsonContent = readScenarioWorkspaceText(scenarioState, packageJsonPath);
  const storageEngineContent = readScenarioWorkspaceText(scenarioState, storageEnginePath);
  const bufferPoolContent = readScenarioWorkspaceText(scenarioState, bufferPoolPath);
  const walManagerContent = readScenarioWorkspaceText(scenarioState, walManagerPath);
  const transactionManagerContent = readScenarioWorkspaceText(scenarioState, transactionManagerPath);
  const queryExecutorContent = readScenarioWorkspaceText(scenarioState, queryExecutorPath);
  const benchScriptContent = readScenarioWorkspaceText(scenarioState, benchScriptPath);
  const failedChecks = [];
  const requiredNextEvidence = [];
  const workspacePrototypeModulePaths = getScenarioWorkspaceFiles(scenarioState)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`) && relativePath.endsWith('.js'))
    .sort((left, right) => left.localeCompare(right));
  const extractDeclaredMethods = (sourceText) => {
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g));
    return new Set(
      matches
        .map((match) => match[1])
        .filter((name) => !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name))
    );
  };
  const splitTopLevelArguments = (argumentText) => {
    if (typeof argumentText !== 'string' || argumentText.trim().length === 0) {
      return [];
    }
    const args = [];
    let current = '';
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (const char of argumentText) {
      if (quote) {
        current += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === '\'' || char === '`') {
        quote = char;
        current += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        current += char;
        continue;
      }
      if (char === ')' || char === ']' || char === '}') {
        depth = Math.max(0, depth - 1);
        current += char;
        continue;
      }
      if (char === ',' && depth === 0) {
        if (current.trim()) {
          args.push(current.trim());
        }
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) {
      args.push(current.trim());
    }
    return args;
  };
  const readBalancedCallArguments = (sourceText, openParenIndex) => {
    let depth = 1;
    let quote = null;
    let escaped = false;
    let text = '';
    for (let index = openParenIndex + 1; index < sourceText.length; index += 1) {
      const char = sourceText[index];
      if (quote) {
        text += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === '\'' || char === '`') {
        quote = char;
        text += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        text += char;
        continue;
      }
      if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          return text;
        }
        text += char;
        continue;
      }
      text += char;
    }
    return null;
  };
  const extractDeclaredMethodRequiredArgCounts = (sourceText) => {
    const counts = new Map();
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g));
    for (const match of matches) {
      const methodName = match[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(methodName)) {
        continue;
      }
      const requiredCount = splitTopLevelArguments(match[2] ?? '')
        .filter((argument) => argument && !argument.startsWith('...') && !argument.includes('='))
        .length;
      counts.set(methodName, requiredCount);
    }
    return counts;
  };
  const extractDeclaredMethodParamNames = (sourceText) => {
    const paramsByMethod = new Map();
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g));
    for (const match of matches) {
      const methodName = match[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(methodName)) {
        continue;
      }
      const params = splitTopLevelArguments(match[2] ?? '')
        .map((argument) => argument.replace(/\s*=.*$/s, '').replace(/^\.{3}/, '').trim())
        .map((argument) => argument.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? '')
        .filter(Boolean);
      paramsByMethod.set(methodName, params);
    }
    return paramsByMethod;
  };
  const extractNumericConstNames = (sourceText) => new Set(
    Array.from((sourceText ?? '').matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*-?\d+(?:\.\d+)?\s*;?/g))
      .map((match) => match[1]),
  );
  const storageFirstParamRequiresNamedTable = (paramName) =>
    /^(?:tableName|tableKey|tablePath|tablespace|relationName|relation|table)$/i.test(String(paramName ?? '').trim());
  const argumentLooksLikeNumericTableId = (argumentText, numericConstNames) => {
    const normalized = String(argumentText ?? '').trim().replace(/;$/, '');
    if (!normalized) {
      return false;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
      return true;
    }
    if (numericConstNames.has(normalized)) {
      return true;
    }
    return /\b(?:DEFAULT_TABLE_ID|TABLE_ID|tableId|fileId|pageId|recordId|rowId)\b/.test(normalized);
  };
  const extractObjectMethodCallDetails = (sourceText, objectName) => {
    const escaped = escapeForRegExp(objectName);
    const pattern = new RegExp(`${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    const details = [];
    for (const match of sourceText.matchAll(pattern)) {
      const openParenIndex = (match.index ?? 0) + match[0].length - 1;
      const argumentText = readBalancedCallArguments(sourceText, openParenIndex);
      details.push({
        methodName: match[1],
        args: argumentText === null ? [] : splitTopLevelArguments(argumentText),
      });
    }
    return details;
  };
  const hasNodeBuiltinBinding = (sourceText, bindingName) => {
    const escaped = escapeForRegExp(bindingName);
    return new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*require\\s*\\(\\s*['"\`](?:node:)?${escaped}['"\`]\\s*\\)`, 'm').test(sourceText)
      || new RegExp(`\\bimport\\s+\\*\\s+as\\s+${escaped}\\s+from\\s+['"\`](?:node:)?${escaped}['"\`]`, 'm').test(sourceText)
      || new RegExp(`\\bimport\\s+${escaped}\\s+from\\s+['"\`](?:node:)?${escaped}['"\`]`, 'm').test(sourceText);
  };
  const extractObjectMethodCalls = (sourceText, objectName) => {
    const pattern = new RegExp(`${objectName}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    return Array.from(sourceText.matchAll(pattern)).map((match) => match[1]);
  };
  const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extractMemberMethodCalls = (sourceText, objectExpression) => {
    const escaped = escapeForRegExp(objectExpression);
    const pattern = new RegExp(`${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    return Array.from(sourceText.matchAll(pattern)).map((match) => match[1]);
  };
  const sliceClassSource = (sourceText, className) => {
    if (typeof sourceText !== 'string' || typeof className !== 'string' || className.trim().length === 0) {
      return sourceText;
    }
    const classMatch = new RegExp(`\\bclass\\s+${escapeForRegExp(className)}\\b`).exec(sourceText);
    if (!classMatch) {
      return sourceText;
    }
    const rest = sourceText.slice(classMatch.index);
    const nextClassMatch = /\n\s*class\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.exec(rest.slice(classMatch[0].length));
    if (!nextClassMatch) {
      return rest;
    }
    return rest.slice(0, classMatch[0].length + nextClassMatch.index);
  };
  const extractConstructorParamText = (sourceText, className = null) => {
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const match = sourceScope.match(/constructor\s*\(([^)]*)\)/m);
    return match?.[1]?.trim() ?? '';
  };
  const extractConstructorOptionKeys = (sourceText, className = null) => {
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const objectMatch = constructorParamText.match(/^\{\s*([^}]*)\}/);
    if (!objectMatch?.[1]) {
      return new Set();
    }
    return new Set(
      objectMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(/\s*=\s*/)[0]?.trim())
        .map((entry) => entry.replace(/^\.{3}/, '').trim())
        .map((entry) => entry.split(/\s*:\s*/)[0]?.trim())
        .filter(Boolean)
    );
  };
  const extractConstructorConsumedOptionKeys = (sourceText, className = null) => {
    const keys = new Set(extractConstructorOptionKeys(sourceText, className));
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    const optionParamName = firstConstructorParam
      .replace(/\s*=.*$/s, '')
      .trim();
    if (!optionParamName || !/^(?:options|opts|config|params)$/i.test(optionParamName)) {
      return keys;
    }
    const escapedOptionParamName = escapeForRegExp(optionParamName);
    for (const match of sourceScope.matchAll(new RegExp(`\\b${escapedOptionParamName}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, 'g'))) {
      if (match[1]) {
        keys.add(match[1]);
      }
    }
    return keys;
  };
  const classConstructorTakesOptionsObject = (sourceText, className = null) => {
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    return /^\{/.test(constructorParamText) || /\b(?:options|opts|config|params)\b/i.test(firstConstructorParam);
  };
  const classConstructorUsesFirstParamAsPathRoot = (sourceText, className = null) => {
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    if (!firstConstructorParam || classConstructorTakesOptionsObject(sourceText, className)) {
      return false;
    }
    const escapedParam = firstConstructorParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`path\\.join\\(\\s*${escapedParam}\\s*,`).test(sourceScope)) {
      return true;
    }
    const assignedProperties = Array.from(
      sourceScope.matchAll(new RegExp(`this\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escapedParam}\\b`, 'g')),
    ).map((match) => match[1]);
    return assignedProperties.some((propertyName) => {
      const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`path\\.join\\(\\s*this\\.${escapedProperty}\\b`, 'm').test(sourceScope)
        || new RegExp(`fs\\.(?:mkdirSync|readdirSync|statSync|openSync)\\(\\s*this\\.${escapedProperty}\\b`, 'm').test(sourceScope);
    });
  };
  const benchConstructsWithOptionsObject = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return false;
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`new\\s+${escaped}\\s*\\(\\s*\\{`, 'm').test(sourceText);
  };
  const benchConstructsWithoutArguments = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return false;
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`new\\s+${escaped}\\s*\\(\\s*(?:undefined|null)?\\s*\\)`, 'm').test(sourceText);
  };
  const extractBenchConstructorOptionKeys = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return new Set();
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sourceText.match(new RegExp(`new\\s+${escaped}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, 'm'));
    if (!match?.[1]) {
      return new Set();
    }
    return new Set(
      match[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(/\s*:\s*/)[0]?.trim())
        .filter(Boolean)
    );
  };
  const detectModuleExportStyle = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return 'unknown';
    }
    if (/module\.exports\s*=\s*\{[\s\S]*?\}/m.test(sourceText) || /exports\.[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(sourceText)) {
      return 'named';
    }
    if (/module\.exports\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*;?/m.test(sourceText)) {
      return 'default';
    }
    return 'unknown';
  };
  const detectJavaScriptModuleSystem = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return {
        usesCommonJs: false,
        usesEsm: false,
      };
    }
    return {
      usesCommonJs: /\brequire\s*\(|module\.exports\b|\bexports\.[A-Za-z_][A-Za-z0-9_]*\b/.test(sourceText),
      usesEsm: /(?:^|\n)\s*import\s.+from\s+['"`]|(?:^|\n)\s*export\s+(?:default|const|class|function|\{)/m.test(sourceText),
    };
  };
  const extractNamedCommonJsExports = (sourceText) => {
    const exportedNames = new Set();
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return exportedNames;
    }
    for (const match of sourceText.matchAll(/(?:module\.exports|exports)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
      exportedNames.add(match[1]);
    }
    const objectExportMatch = sourceText.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?/m);
    if (objectExportMatch) {
      const entries = objectExportMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      for (const entry of entries) {
        const aliasMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_]*$/);
        if (aliasMatch) {
          exportedNames.add(aliasMatch[1]);
          continue;
        }
        const shorthandMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (shorthandMatch) {
          exportedNames.add(shorthandMatch[1]);
        }
      }
    }
    return exportedNames;
  };
  const extractBenchRequireBindings = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return [];
    }
    const bindings = [];
    const requirePattern = /const\s+(\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
    for (const match of sourceText.matchAll(requirePattern)) {
      const bindingSource = match[1].trim();
      const rawModulePath = match[2].trim();
      const normalizedModulePath = rawModulePath.endsWith('.js')
        ? rawModulePath
        : `${rawModulePath}.js`;
      if (bindingSource.startsWith('{')) {
        const names = bindingSource
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [importedName, localName] = entry.split(/\s*:\s*/);
            return {
              importedName: importedName.trim(),
              localName: (localName ?? importedName).trim(),
            };
          });
        bindings.push({
          source: 'named',
          modulePath: normalizedModulePath,
          names,
        });
        continue;
      }
      bindings.push({
        source: 'default',
        modulePath: normalizedModulePath,
        names: [{ importedName: 'default', localName: bindingSource }],
      });
    }
    return bindings;
  };
  const normalizePackageSpecifierRoot = (specifier) => {
    if (typeof specifier !== 'string') {
      return null;
    }
    const normalized = specifier.trim();
    if (!normalized || normalized.startsWith('.') || normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalized)) {
      return null;
    }
    if (normalized.startsWith('node:')) {
      return normalized;
    }
    if (normalized.startsWith('@')) {
      const [scope, name] = normalized.split('/');
      return scope && name ? `${scope}/${name}` : normalized;
    }
    return normalized.split('/')[0] ?? normalized;
  };
  const extractBareModuleSpecifiers = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return [];
    }
    const specifiers = [];
    const patterns = [
      /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
      /from\s+['"`]([^'"`]+)['"`]/g,
      /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    ];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(sourceText)) !== null) {
        const packageRoot = normalizePackageSpecifierRoot(String(match[1] ?? '').trim());
        if (!packageRoot || NODE_BUILTIN_MODULE_SET.has(packageRoot)) {
          continue;
        }
        specifiers.push(packageRoot);
      }
    }
    return Array.from(new Set(specifiers));
  };
  const toPrototypeRelativePath = (modulePath) => {
    if (typeof modulePath !== 'string' || !modulePath.startsWith('../src/')) {
      return null;
    }
    return `${DATABASE_LAB_PROTOTYPE_DIR}/src/${modulePath.slice('../src/'.length)}`;
  };
  const benchRequireBindings = extractBenchRequireBindings(benchScriptContent);
  const benchImportedModuleFiles = Array.from(new Set(
    benchRequireBindings
      .map((binding) => toPrototypeRelativePath(binding.modulePath))
      .filter(Boolean),
  ));
  const prototypeModulePaths = Array.from(new Set([
    ...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES,
    ...workspacePrototypeModulePaths,
    ...benchImportedModuleFiles,
  ])).sort((left, right) => left.localeCompare(right));
  const prototypeModuleSources = new Map(
    prototypeModulePaths.map((relativePath) => [relativePath, readScenarioWorkspaceText(scenarioState, relativePath)]),
  );
  const extractBenchObjectBindings = (sourceText, requireBindings) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return new Map();
    }
    const constructorSourceByLocalName = new Map();
    for (const binding of requireBindings) {
      const relativePath = toPrototypeRelativePath(binding.modulePath);
      if (!relativePath) {
        continue;
      }
      for (const name of binding.names) {
        constructorSourceByLocalName.set(name.localName, relativePath);
      }
    }
    const objectBindings = new Map();
    for (const match of sourceText.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const objectName = match[1];
      const constructorName = match[2];
      const relativePath = constructorSourceByLocalName.get(constructorName);
      if (relativePath) {
        objectBindings.set(objectName, { constructorName, relativePath });
      }
    }
    return objectBindings;
  };
  const benchObjectBindings = extractBenchObjectBindings(benchScriptContent, benchRequireBindings);
  const storageBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === storageEnginePath)
    .map(([objectName]) => objectName);
  const bufferPoolBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === bufferPoolPath)
    .map(([objectName]) => objectName);
  const walManagerBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === walManagerPath)
    .map(([objectName]) => objectName);
  const registerSyntaxDiagnostic = (sourceText, relativePath) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return;
    }
    try {
      new vm.Script(sourceText, { filename: relativePath });
    } catch (error) {
      failedChecks.push(`javascript_syntax_error:${relativePath}`);
      requiredNextEvidence.push(`repair ${relativePath} so it parses as valid CommonJS JavaScript before rerunning the benchmark scaffold`);
    }
  };

  for (const [relativePath, sourceText] of prototypeModuleSources.entries()) {
    registerSyntaxDiagnostic(sourceText, relativePath);
  }
  registerSyntaxDiagnostic(benchScriptContent, benchScriptPath);
  for (const [relativePath, sourceText] of [...prototypeModuleSources.entries(), [benchScriptPath, benchScriptContent]]) {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      continue;
    }
    for (const builtinName of ['path', 'fs', 'os']) {
      const usesBinding = new RegExp(`\\b${builtinName}\\.`, 'm').test(sourceText);
      if (usesBinding && !hasNodeBuiltinBinding(sourceText, builtinName)) {
        failedChecks.push(`undeclared_node_builtin:${relativePath}:${builtinName}`);
        requiredNextEvidence.push(`repair ${relativePath} so it declares ${builtinName} before using ${builtinName}.*; add a CommonJS require such as const ${builtinName} = require('${builtinName}') or remove the ${builtinName}.* usage`);
      }
    }
  }

  let packageJsonType = null;
  let declaredPackageDependencies = new Set();
  if (typeof packageJsonContent === 'string' && packageJsonContent.trim().length > 0) {
    try {
      const packageJson = JSON.parse(packageJsonContent);
      packageJsonType = typeof packageJson?.type === 'string' ? packageJson.type.trim().toLowerCase() : null;
      declaredPackageDependencies = new Set([
        ...Object.keys(packageJson?.dependencies ?? {}),
        ...Object.keys(packageJson?.devDependencies ?? {}),
      ]);
    } catch {
      packageJsonType = null;
      declaredPackageDependencies = new Set();
    }
  }

  const prototypeDependencySources = new Map();
  for (const [relativePath, sourceText] of [...prototypeModuleSources.entries(), [benchScriptPath, benchScriptContent]]) {
    const undeclaredSpecifiers = extractBareModuleSpecifiers(sourceText)
      .filter((specifier) => !declaredPackageDependencies.has(specifier));
    if (undeclaredSpecifiers.length === 0) {
      continue;
    }
    prototypeDependencySources.set(relativePath, undeclaredSpecifiers);
  }
  for (const [relativePath, undeclaredSpecifiers] of prototypeDependencySources.entries()) {
    for (const specifier of undeclaredSpecifiers) {
      failedChecks.push(`prototype_undeclared_external_dependency_source:${relativePath}:${specifier}`);
      requiredNextEvidence.push(
        `repair ${relativePath} and/or ${packageJsonPath} so the prototype no longer requires undeclared external module "${specifier}". Prefer a built-in Node API such as node:crypto when possible, or declare the dependency explicitly in package.json before rerunning the benchmark scaffold`,
      );
    }
  }

  if (packageJsonType) {
    const moduleSystemViolations = [];
    for (const [relativePath, sourceText] of prototypeModuleSources.entries()) {
      const syntax = detectJavaScriptModuleSystem(sourceText);
      if (packageJsonType === 'module' && syntax.usesCommonJs) {
        moduleSystemViolations.push(relativePath);
      }
      if (packageJsonType !== 'module' && syntax.usesEsm) {
        moduleSystemViolations.push(relativePath);
      }
    }
    {
      const syntax = detectJavaScriptModuleSystem(benchScriptContent);
      if (packageJsonType === 'module' && syntax.usesCommonJs) {
        moduleSystemViolations.push(benchScriptPath);
      }
      if (packageJsonType !== 'module' && syntax.usesEsm) {
        moduleSystemViolations.push(benchScriptPath);
      }
    }
    if (moduleSystemViolations.length > 0) {
      failedChecks.push('prototype_module_system_mismatch');
      const uniqueViolations = Array.from(new Set(moduleSystemViolations));
      if (packageJsonType === 'module') {
        requiredNextEvidence.push(`repair ${packageJsonPath} and/or these prototype files so the module system is consistent: ${uniqueViolations.join(', ')}. package.json currently declares type=module, but those files still use CommonJS require/module.exports. Either remove "type": "module" or convert the cited files to real ESM import/export syntax before rerunning the benchmark scaffold`);
      } else {
        requiredNextEvidence.push(`repair ${packageJsonPath} and/or these prototype files so the module system is consistent: ${uniqueViolations.join(', ')}. The current package runtime is CommonJS, but those files use ESM import/export syntax. Either keep CommonJS everywhere or move the package to a coherent ESM contract before rerunning the benchmark scaffold`);
      }
    }
  }

  if (benchScriptContent) {
    for (const binding of benchRequireBindings) {
      const relativePath = toPrototypeRelativePath(binding.modulePath);
      if (!relativePath) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(relativePath);
      if (typeof moduleSource !== 'string' || moduleSource.trim().length === 0) {
        continue;
      }
      const exportStyle = detectModuleExportStyle(moduleSource);
      const exportedNames = extractNamedCommonJsExports(moduleSource);
      if (binding.source === 'named' && exportStyle === 'default') {
        failedChecks.push(`bench_module_export_mismatch:${relativePath}`);
        const namedImports = binding.names.map((entry) => entry.importedName).join(', ');
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so CommonJS import/export shape agrees; bench.js is destructuring { ${namedImports} } from ${binding.modulePath}, but ${relativePath} currently exports a default class via module.exports = ClassName`);
      }
      if (binding.source === 'default' && exportStyle === 'named') {
        failedChecks.push(`bench_module_export_mismatch:${relativePath}`);
        const localName = binding.names[0]?.localName ?? 'Module';
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so CommonJS import/export shape agrees; bench.js is default-importing ${binding.modulePath} as ${localName}, but ${relativePath} currently exports named bindings via module.exports = { ... }`);
      }
      if (binding.source === 'named' && exportStyle === 'named' && exportedNames.size > 0) {
        for (const name of binding.names) {
          if (!exportedNames.has(name.importedName)) {
            failedChecks.push(`bench_module_export_name_mismatch:${relativePath}:${name.importedName}`);
            requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so the named CommonJS export exists; bench.js imports { ${name.importedName} } from ${binding.modulePath}, but ${relativePath} currently exports { ${Array.from(exportedNames).join(', ')} }`);
          }
        }
      }
    }
    const dynamicLoadedBindings = [
      ['storageEngine', storageEnginePath, 'StorageEngine'],
      ['bufferPool', bufferPoolPath, 'BufferPool'],
      ['bPlusTreeIndex', `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`, 'BPlusTreeIndex'],
      ['walManager', walManagerPath, 'WALManager'],
      ['transactionManager', transactionManagerPath, 'TransactionManager'],
    ];
    const usesDynamicModuleRegistry =
      /\bMODULE_DEFS\b/.test(benchScriptContent)
      && /\bloadModules\s*\(/.test(benchScriptContent)
      && /\bloaded\.[A-Za-z_][A-Za-z0-9_]*\b/.test(benchScriptContent);
    if (usesDynamicModuleRegistry) {
      failedChecks.push('bench_dynamic_module_loader_contract_mismatch');
      requiredNextEvidence.push(`repair ${benchScriptPath} so it imports benchmark-critical modules with direct named CommonJS destructuring instead of a dynamic MODULE_DEFS/loadModules registry. Static quality and runtime repair need explicit imports such as const { StorageEngine } = require('../src/storage-engine.js').`);
    }
    for (const [loadedKey, relativePath, expectedExport] of dynamicLoadedBindings) {
      if (
        !new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${escapeForRegExp(expectedExport)}\\b[^}]*\\}\\s*=\\s*loaded\\.${escapeForRegExp(loadedKey)}\\b`).test(benchScriptContent)
        && !new RegExp(`loaded\\.${escapeForRegExp(loadedKey)}\\.${escapeForRegExp(expectedExport)}\\b`).test(benchScriptContent)
      ) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(relativePath);
      const exportedNames = extractNamedCommonJsExports(moduleSource);
      if (exportedNames.size > 0 && !exportedNames.has(expectedExport)) {
        failedChecks.push(`bench_module_export_name_mismatch:${relativePath}:${expectedExport}`);
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so the named CommonJS export exists; bench.js expects ${expectedExport} through loaded.${loadedKey}, but ${relativePath} currently exports { ${Array.from(exportedNames).join(', ')} }`);
      }
    }

    for (const [objectName, binding] of benchObjectBindings.entries()) {
      if (binding.relativePath === storageEnginePath || binding.relativePath === bufferPoolPath) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(binding.relativePath);
      if (typeof moduleSource !== 'string' || moduleSource.trim().length === 0) {
        continue;
      }
      const declaredMethods = extractDeclaredMethods(moduleSource);
      const calledMethods = Array.from(new Set(extractObjectMethodCalls(benchScriptContent, objectName)));
      const missingMethods = calledMethods.filter((methodName) => !declaredMethods.has(methodName));
      if (missingMethods.length > 0) {
        failedChecks.push(`bench_module_api_mismatch:${binding.relativePath}`);
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${binding.relativePath} so ${binding.constructorName} exposes the methods bench.js is calling on ${objectName}: ${missingMethods.join(', ')}`);
      }
    }
  }

  if (storageEngineContent) {
    const hasStringLengthPrefix = /writeUInt16BE\s*\(\s*str\.length\s*,\s*offset\s*\)/i.test(storageEngineContent);
    const writesVariableStringBytes = /buf\.write\s*\(\s*str\s*,\s*offset\s*\+\s*2\s*,\s*['"`]utf8['"`]\s*\)/i.test(storageEngineContent);
    const readsEveryColumnAsDouble = /readDoubleBE\s*\(\s*off\s*\)/i.test(storageEngineContent);
    const fixedEightByteSlots =
      /offset\s*\+=\s*8\b/.test(storageEngineContent)
      && /return\s+4\s*\+\s*columns\.length\s*\*\s*8/i.test(storageEngineContent);
    if (hasStringLengthPrefix && writesVariableStringBytes && readsEveryColumnAsDouble && fixedEightByteSlots) {
      failedChecks.push('storage_engine_row_format_mismatch');
      requiredNextEvidence.push('repair storage-engine row serialization so insertRow, readRow, and scanTable share one explicit row format with consistent length bookkeeping');
    }
    const uint32WritesWithSignedBitwiseCoercion = Array.from(
      storageEngineContent.matchAll(/writeUInt32BE\s*\(\s*([^,\n]+?)\s*,/g),
    )
      .map((match) => match[1]?.trim() ?? '')
      .filter((expression) =>
        /&\s*0x(?:f{8}|F{8})\b/.test(expression)
        && !/>>>\s*0\b/.test(expression)
      );
    if (uint32WritesWithSignedBitwiseCoercion.length > 0) {
      failedChecks.push('storage_engine_uint32_signed_bitwise_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so every Buffer.writeUInt32BE value is constrained to an unsigned 32-bit integer. Current expression(s) can become negative through JavaScript signed bitwise coercion: ${uint32WritesWithSignedBitwiseCoercion.join('; ')}. Use >>> 0 or an explicit unsigned clamp before writeUInt32BE.`);
    }

    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const benchStorageMethodCalls = benchScriptContent
      ? Array.from(new Set(
        storageBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
      ))
      : [];
    const missingBenchStorageMethods = benchStorageMethodCalls
      .filter((methodName) => !declaredStorageMethods.has(methodName));
    for (const methodName of missingBenchStorageMethods) {
      if (!declaredStorageMethods.has(methodName)) {
        failedChecks.push(`storage_engine_missing_method:${methodName}`);
        if (!failedChecks.includes(`bench_storage_engine_missing_method:${methodName}`)) {
          failedChecks.push(`bench_storage_engine_missing_method:${methodName}`);
        }
        requiredNextEvidence.push(`repair database-lab/prototype/src/storage-engine.js and/or database-lab/prototype/scripts/bench.js so StorageEngine.${methodName} matches the benchmark scaffold contract`);
      }
    }
    const declaredStorageRequiredArgCounts = extractDeclaredMethodRequiredArgCounts(storageEngineContent);
    const declaredStorageParamNames = extractDeclaredMethodParamNames(storageEngineContent);
    const numericBenchConstNames = extractNumericConstNames(benchScriptContent ?? '');
    for (const objectName of storageBenchObjectNames) {
      for (const call of extractObjectMethodCallDetails(benchScriptContent ?? '', objectName)) {
        const requiredArgCount = declaredStorageRequiredArgCounts.get(call.methodName);
        if (typeof requiredArgCount === 'number' && requiredArgCount > 0 && call.args.length < requiredArgCount) {
          const failedCheck = `bench_storage_engine_arg_mismatch:${call.methodName}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so ${objectName}.${call.methodName} is called with ${requiredArgCount} required argument(s); bench.js currently supplies ${call.args.length}`);
        }
        const paramNames = declaredStorageParamNames.get(call.methodName) ?? [];
        const firstParamName = paramNames[0] ?? '';
        const firstArg = call.args[0] ?? '';
        if (
          storageFirstParamRequiresNamedTable(firstParamName)
          && argumentLooksLikeNumericTableId(firstArg, numericBenchConstNames)
        ) {
          const failedCheck = `bench_storage_engine_table_name_mismatch:${call.methodName}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so ${objectName}.${call.methodName} passes the named table identifier expected by StorageEngine.${call.methodName}(${paramNames.join(', ')}); bench.js currently passes ${firstArg || 'no first argument'}, which resolves to a numeric table id and can produce runtime failures such as "Table 0 not found"`);
        }
      }
    }
    if (benchScriptContent) {
      const benchPassesOptionsObject = benchConstructsWithOptionsObject(benchScriptContent, 'StorageEngine');
      const benchPassesNoArgument = benchConstructsWithoutArguments(benchScriptContent, 'StorageEngine');
      const constructorUsesPathString = classConstructorUsesFirstParamAsPathRoot(storageEngineContent, 'StorageEngine');
      if (benchPassesOptionsObject && constructorUsesPathString) {
        failedChecks.push('storage_engine_constructor_arg_mismatch');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so StorageEngine is constructed consistently; bench.js is passing an options object, but storage-engine.js still treats the constructor argument as a base directory string for path.join(...)`);
      }
      if (benchPassesNoArgument && constructorUsesPathString) {
        failedChecks.push('storage_engine_constructor_data_root_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so StorageEngine is constructed with a real dataRoot path; bench.js is currently calling new StorageEngine() without the base directory string that storage-engine.js passes into path.join(...)`);
      }
      const storageRequiresLoadedTables =
        (/not\s+loaded/i.test(storageEngineContent) && /\b(?:createTable|loadTable)\s*\(/.test(storageEngineContent));
      const benchUsesTablePageIo =
        /\.(?:readPage|writePage)\s*\(\s*(?:['"`][A-Za-z0-9_$-]+['"`]|[A-Z_]*(?:TABLE|TABLE_NAME|TABLE_ID)[A-Z_]*|[A-Za-z_$][A-Za-z0-9_$]*)/i.test(benchScriptContent);
      const benchCreatesOrLoadsTables =
        /\.(?:createTable|loadTable|openTable|ensureTable)\s*\(/i.test(benchScriptContent);
      if (storageRequiresLoadedTables && benchUsesTablePageIo && !benchCreatesOrLoadsTables) {
        failedChecks.push('bench_storage_table_lifecycle_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so the benchmark creates or loads the benchmark table before page I/O. StorageEngine throws "Table ... not loaded" unless createTable/loadTable has populated table metadata, but bench.js currently writes pages without that lifecycle step.`);
      }
    }
    const promiseReturningStorageMethods = ['open', 'initialize', 'close', 'readPage', 'writePage']
      .filter((methodName) =>
        new RegExp(`async\\s+${methodName}\\s*\\(`, 'm').test(storageEngineContent)
        || new RegExp(`${methodName}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?return\\s+new\\s+Promise\\s*\\(`, 'm').test(storageEngineContent)
      );
    for (const objectName of storageBenchObjectNames) {
      for (const methodName of promiseReturningStorageMethods) {
        const methodCalled = new RegExp(`${objectName}\\.${methodName}\\s*\\(`, 'm').test(benchScriptContent);
        const methodAwaited = new RegExp(`await\\s+${objectName}\\.${methodName}\\s*\\(`, 'm').test(benchScriptContent);
        if (methodCalled && !methodAwaited) {
          failedChecks.push(`bench_storage_engine_async_usage_mismatch:${methodName}`);
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so ${objectName}.${methodName} is awaited consistently before the benchmark reports success; ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js currently implements ${methodName} as Promise-based I/O`);
        }
      }
      const usesFileDescriptorBackedPages = /this\.fd\b/.test(storageEngineContent)
        && /(?:readPage|writePage)\s*\([^)]*\)\s*\{[\s\S]*?fs\.(?:read|write)\s*\(\s*this\.fd\b/m.test(storageEngineContent);
      const storageInitializeCreatesDataDir =
        /async\s+(?:init|initialize)\s*\([^)]*\)\s*\{[\s\S]*?mkdirSync\s*\([^)]*recursive:\s*true/i.test(storageEngineContent)
        || /async\s+(?:init|initialize)\s*\([^)]*\)\s*\{[\s\S]*?mkdirSync\s*\(/i.test(storageEngineContent);
      const benchCallsReadOrWrite = benchStorageMethodCalls.includes('readPage') || benchStorageMethodCalls.includes('writePage');
      const benchOpensStorage = new RegExp(`await\\s+${objectName}\\.(?:open|init|initialize)\\s*\\(`, 'm').test(benchScriptContent);
      if (storageInitializeCreatesDataDir && benchCallsReadOrWrite && !benchOpensStorage) {
        failedChecks.push('bench_storage_engine_initialize_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it awaits ${objectName}.init() or ${objectName}.initialize() before the first readPage/writePage call, or repair storage-engine.js so writePage ensures its data directory exists before writing; storage-engine.js currently creates its data directory during setup and benchmark I/O must not run against an uninitialized data path`);
      }
      if ((usesFileDescriptorBackedPages || storageInitializeCreatesDataDir) && benchCallsReadOrWrite && !benchOpensStorage) {
        failedChecks.push('bench_storage_engine_open_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it opens or initializes the real StorageEngine before calling readPage/writePage; the current storage engine uses fd-backed I/O and cannot safely benchmark unopened pages`);
      }
      const enforcesExactPageSize = /data\.length\s*!==\s*this\.pageSize/.test(storageEngineContent);
      const writesFixedPageLength =
        /fs\.write(?:Sync)?\s*\(\s*[^,]+,\s*[^,]+,\s*0\s*,\s*this\.pageSize\b/m.test(storageEngineContent);
      const benchWritesBufferFromStrings =
        new RegExp(`${objectName}\\.writePage\\s*\\([^)]*Buffer\\.from\\s*\\(`, 'm').test(benchScriptContent)
        || (/Buffer\.from\s*\(/.test(benchScriptContent) && new RegExp(`${objectName}\\.writePage\\s*\\(`, 'm').test(benchScriptContent) && !/Buffer\.alloc\s*\([^)]*pageSize/i.test(benchScriptContent));
      if ((enforcesExactPageSize || writesFixedPageLength) && benchWritesBufferFromStrings) {
        if (!failedChecks.includes('bench_storage_page_size_mismatch')) {
          failedChecks.push('bench_storage_page_size_mismatch');
        }
        const evidence = `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so benchmark page writes respect the StorageEngine pageSize contract; do not pass short Buffer.from(...) payloads into writePage when storage-engine.js requires fixed-size pages`;
        if (!requiredNextEvidence.includes(evidence)) {
          requiredNextEvidence.push(evidence);
        }
      }
    }
  }

  if (bufferPoolContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const delegatedStorageMethods = Array.from(new Set(extractMemberMethodCalls(bufferPoolContent, 'this.storage')));
    const missingDelegatedMethods = delegatedStorageMethods.filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingDelegatedMethods.length > 0) {
      failedChecks.push('buffer_pool_storage_engine_contract_mismatch');
      for (const methodName of missingDelegatedMethods) {
        failedChecks.push(`buffer_pool_storage_engine_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so BufferPool only calls storage methods the StorageEngine actually implements. buffer-pool.js currently calls ${missingDelegatedMethods.join(', ')}, but storage-engine.js currently exposes ${Array.from(declaredStorageMethods).sort().join(', ') || 'no usable storage methods'}`,
      );
    }
  }

  if (benchScriptContent && !/createEngine|new\s+StorageEngine/i.test(benchScriptContent)) {
    failedChecks.push('bench_scaffold_missing_storage_engine_entrypoint');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so it imports the real storage engine entrypoint instead of placeholder logic');
  }

  if (benchScriptContent && bufferPoolContent) {
    const declaredBufferMethods = extractDeclaredMethods(bufferPoolContent);
    const benchBufferMethodCalls = Array.from(new Set(
      bufferPoolBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    if (benchConstructsWithOptionsObject(benchScriptContent, 'BufferPool') && !classConstructorTakesOptionsObject(bufferPoolContent, 'BufferPool')) {
      failedChecks.push('buffer_pool_constructor_arg_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool is constructed consistently; bench.js is passing an options object, but buffer-pool.js still expects positional arguments like (storageEngine, poolSize)`);
    }
    const bufferPoolRequiresStorageEngineOption =
      /constructor\s*\(\s*(?:options|opts|config)\s*=?\s*[^)]*\)\s*\{[\s\S]{0,700}!(?:options|opts|config)\.storageEngine/i.test(bufferPoolContent)
      || /constructor\s*\(\s*(?:options|opts|config)\s*=?\s*[^)]*\)\s*\{[\s\S]{0,700}(?:options|opts|config)\.storageEngine/i.test(bufferPoolContent);
    if (benchConstructsWithoutArguments(benchScriptContent, 'BufferPool') && bufferPoolRequiresStorageEngineOption) {
      failedChecks.push('buffer_pool_constructor_dependency_missing');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool is constructed with the storage dependency expected by ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js; bench.js currently calls new BufferPool() without options.storageEngine`);
    }
    const bufferPoolHasWritePage = declaredBufferMethods.has('writePage');
    const bufferPoolHasReadPage = declaredBufferMethods.has('readPage');
    const bufferPoolHasPutPage = declaredBufferMethods.has('putPage');
    const bufferPoolHasGetPage = declaredBufferMethods.has('getPage');
    const missingBenchBufferMethods = benchBufferMethodCalls.filter((methodName) => !declaredBufferMethods.has(methodName));
    if (missingBenchBufferMethods.includes('initialize')) {
      failedChecks.push('bench_buffer_pool_missing_initialize');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so bench.js does not call pool.initialize() unless BufferPool actually implements initialize(). Prefer removing the call when BufferPool has no setup phase, or implement an async initialize method that prepares the same storage dependency used by getPage/writePage.`);
    }
    for (const methodName of missingBenchBufferMethods) {
      if (!failedChecks.includes(`bench_buffer_pool_missing_method:${methodName}`)) {
        failedChecks.push(`bench_buffer_pool_missing_method:${methodName}`);
      }
    }
    const genericMismatch = missingBenchBufferMethods.length > 0;
    if (
      genericMismatch
      || ((benchBufferMethodCalls.includes('writePage') && !bufferPoolHasWritePage && bufferPoolHasPutPage)
      || (benchBufferMethodCalls.includes('readPage') && !bufferPoolHasReadPage && bufferPoolHasGetPage))
    ) {
      failedChecks.push('bench_buffer_pool_api_mismatch');
      requiredNextEvidence.push(`repair database-lab/prototype/scripts/bench.js and/or database-lab/prototype/src/buffer-pool.js so they share one coherent API. Bench currently calls buffer-pool methods not implemented by BufferPool: ${missingBenchBufferMethods.join(', ') || 'writePage/readPage vs putPage/getPage drift'}. Remove stale calls such as pool.initialize() or implement those methods before rerunning the benchmark.`);
    }
  }

  if (benchScriptContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const benchStorageMethodCalls = Array.from(new Set(
      storageBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingBenchStorageMethods = benchStorageMethodCalls
      .filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingBenchStorageMethods.length > 0) {
      failedChecks.push('bench_storage_engine_api_mismatch');
      for (const methodName of missingBenchStorageMethods) {
        if (!failedChecks.includes(`bench_storage_engine_missing_method:${methodName}`)) {
          failedChecks.push(`bench_storage_engine_missing_method:${methodName}`);
        }
      }
      requiredNextEvidence.push(`repair database-lab/prototype/scripts/bench.js and/or database-lab/prototype/src/storage-engine.js so these missing benchmark-called engine methods line up: ${missingBenchStorageMethods.join(', ')}. Either implement the methods in StorageEngine or stop bench.js from calling them.`);
    }
  }

  if (benchScriptContent && walManagerContent) {
    const walConstructorUsesPathString = classConstructorUsesFirstParamAsPathRoot(walManagerContent, 'WALManager');
    if (benchConstructsWithOptionsObject(benchScriptContent, 'WALManager') && walConstructorUsesPathString) {
      failedChecks.push('wal_manager_constructor_arg_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so WALManager is constructed consistently; bench.js is passing an options object, but wal-manager.js still treats the constructor argument as a base directory string for path.join(...)`);
    }
    const declaredWalMethods = extractDeclaredMethods(walManagerContent);
    const benchWalMethodCalls = Array.from(new Set(
      walManagerBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingBenchWalMethods = benchWalMethodCalls.filter((methodName) => !declaredWalMethods.has(methodName));
    if (missingBenchWalMethods.length > 0) {
      failedChecks.push('bench_wal_manager_api_mismatch');
      for (const methodName of missingBenchWalMethods) {
        if (!failedChecks.includes(`bench_wal_manager_missing_method:${methodName}`)) {
          failedChecks.push(`bench_wal_manager_missing_method:${methodName}`);
        }
      }
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WALManager exposes the methods bench.js is calling directly: ${missingBenchWalMethods.join(', ')}. Either implement those methods or change bench.js to use the actual WALManager API before rerunning the benchmark.`);
    }
  }

  if (benchScriptContent && transactionManagerContent) {
    const constructorOptionKeys = extractConstructorConsumedOptionKeys(transactionManagerContent, 'TransactionManager');
    const benchOptionKeys = extractBenchConstructorOptionKeys(benchScriptContent, 'TransactionManager');
    if (constructorOptionKeys.size > 0 && benchOptionKeys.size > 0) {
      const overlappingKeys = Array.from(benchOptionKeys).filter((key) => constructorOptionKeys.has(key));
      if (overlappingKeys.length === 0) {
        failedChecks.push('transaction_manager_constructor_arg_mismatch');
        requiredNextEvidence.push(
          `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager is constructed with the real option keys. bench.js currently passes { ${Array.from(benchOptionKeys).join(', ')} }, but transaction-manager.js expects { ${Array.from(constructorOptionKeys).join(', ')} }.`
        );
      }
      const constructorAliasPairs = [
        ['walManager', ['wal', 'walLog', 'logManager']],
        ['storageEngine', ['storage', 'engine']],
        ['indexManager', ['index', 'bTreeIndex', 'tree']],
        ['lockManager', ['locks']],
      ];
      for (const [expectedKey, aliasKeys] of constructorAliasPairs) {
        const matchingAlias = aliasKeys.find((aliasKey) => benchOptionKeys.has(aliasKey));
        if (constructorOptionKeys.has(expectedKey) && matchingAlias && !benchOptionKeys.has(expectedKey)) {
          const failedCheck = `transaction_manager_constructor_option_alias_mismatch:${expectedKey}:${matchingAlias}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          if (!failedChecks.includes('transaction_manager_constructor_arg_mismatch')) {
            failedChecks.push('transaction_manager_constructor_arg_mismatch');
          }
          requiredNextEvidence.push(
            `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager receives option key ${expectedKey}; bench.js currently passes alias key ${matchingAlias}, leaving transaction-manager.js with an undefined dependency during begin/commit`,
          );
        }
      }
    }

    const declaredTransactionMethods = extractDeclaredMethods(transactionManagerContent);
    const transactionManagerObjectNames = Array.from(benchObjectBindings.entries())
      .filter(([, binding]) => binding.relativePath === transactionManagerPath)
      .map(([objectName]) => objectName);
    const transactionAliasNames = new Set();
    for (const objectName of transactionManagerObjectNames) {
      const aliasPattern = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?${escapeForRegExp(objectName)}\\.begin\\s*\\(`,
        'g',
      );
      for (const match of benchScriptContent.matchAll(aliasPattern)) {
        if (match[1]) {
          transactionAliasNames.add(match[1]);
        }
      }
    }
    const transactionAliasCalls = Array.from(new Set(
      Array.from(transactionAliasNames).flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingTransactionMethods = transactionAliasCalls.filter((methodName) => !declaredTransactionMethods.has(methodName));
    if (missingTransactionMethods.length > 0) {
      failedChecks.push('bench_transaction_api_mismatch');
      for (const methodName of missingTransactionMethods) {
        failedChecks.push(`bench_transaction_missing_method:${methodName}`);
      }
      const aliasList = Array.from(transactionAliasNames);
      const aliasSummary = aliasList.length > 0 ? aliasList.join(', ') : 'transaction instances';
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so the transaction object returned by begin() exposes the methods bench.js is calling on ${aliasSummary}: ${missingTransactionMethods.join(', ')}. If the real transaction API is read/write/delete, then bench.js must stop calling insert/lookup and use the coherent method names instead.`,
      );
    }
    const transactionAliasList = Array.from(transactionAliasNames);
    const declaredTransactionParamNames = extractDeclaredMethodParamNames(transactionManagerContent);
    for (const objectName of transactionManagerObjectNames) {
      for (const call of extractObjectMethodCallDetails(benchScriptContent, objectName)) {
        if (!/^(?:commit|rollback|abort)$/i.test(call.methodName)) {
          continue;
        }
        const paramNames = declaredTransactionParamNames.get(call.methodName) ?? [];
        const firstParam = paramNames[0] ?? '';
        if (!firstParam) {
          continue;
        }
        const methodBodyUsesIdLookup = new RegExp(`${escapeForRegExp(call.methodName)}\\s*\\([^)]*${escapeForRegExp(firstParam)}[^)]*\\)\\s*\\{[\\s\\S]{0,500}\\.(?:get|has|delete)\\s*\\(\\s*${escapeForRegExp(firstParam)}\\s*\\)`, 'm').test(transactionManagerContent);
        const methodExpectsId = /(?:txn|tx|transaction).{0,8}id|id$/i.test(firstParam) || methodBodyUsesIdLookup;
        if (!methodExpectsId) {
          continue;
        }
        if (call.args.length === 0) {
          failedChecks.push('bench_transaction_manager_argument_mismatch');
          failedChecks.push(`bench_transaction_manager_argument_mismatch:${call.methodName}`);
          requiredNextEvidence.push(
            `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so ${objectName}.${call.methodName} receives the value expected by transaction-manager.js. bench.js currently calls ${objectName}.${call.methodName}() without the required id parameter (${firstParam || 'transaction id'}). Capture the transaction returned by begin() and pass txn.id, or change commit/rollback to accept the omitted/default transaction consistently before rerunning the benchmark.`,
          );
          continue;
        }
        const firstArg = String(call.args[0] ?? '').trim();
        if (!transactionAliasList.includes(firstArg)) {
          continue;
        }
        failedChecks.push('bench_transaction_manager_argument_mismatch');
        failedChecks.push(`bench_transaction_manager_argument_mismatch:${call.methodName}`);
        requiredNextEvidence.push(
          `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so ${objectName}.${call.methodName} receives the value expected by transaction-manager.js. bench.js currently passes transaction object ${firstArg}, but ${call.methodName} appears to expect an id parameter (${firstParam || 'transaction id'}). Pass ${firstArg}.id, change commit/rollback to accept the transaction object, or make begin() return the id consistently before rerunning the benchmark.`,
        );
      }
    }
  }

  if (transactionManagerContent && walManagerContent) {
    const declaredWalMethods = extractDeclaredMethods(walManagerContent);
    const transactionWalCalls = Array.from(new Set([
      ...extractMemberMethodCalls(transactionManagerContent, 'this._wal'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.wal'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.walManager'),
    ]));
    const missingWalMethods = transactionWalCalls.filter((methodName) => !declaredWalMethods.has(methodName));
    if (missingWalMethods.length > 0) {
      failedChecks.push('transaction_manager_wal_contract_mismatch');
      for (const methodName of missingWalMethods) {
        failedChecks.push(`transaction_manager_wal_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so TransactionManager only calls WALManager methods that really exist. transaction-manager.js currently calls ${missingWalMethods.join(', ')}, but wal-manager.js currently exposes ${Array.from(declaredWalMethods).sort().join(', ') || 'no usable wal methods'}`,
      );
    }
  }

  if (transactionManagerContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const transactionStorageCalls = Array.from(new Set([
      ...extractMemberMethodCalls(transactionManagerContent, 'this._engine'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.storage'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.storageEngine'),
    ]));
    const missingStorageMethods = transactionStorageCalls.filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingStorageMethods.length > 0) {
      failedChecks.push('transaction_manager_storage_contract_mismatch');
      for (const methodName of missingStorageMethods) {
        failedChecks.push(`transaction_manager_storage_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so TransactionManager only calls StorageEngine methods that really exist. transaction-manager.js currently calls ${missingStorageMethods.join(', ')}, but storage-engine.js currently exposes ${Array.from(declaredStorageMethods).sort().join(', ') || 'no usable storage methods'}`,
      );
    }
  }

  if (benchScriptContent && queryExecutorContent) {
    const queryExecutorAssumesDatabaseFacade =
      /this\.database\.getTable\s*\(/.test(queryExecutorContent)
      || /this\.database\.insertRow\s*\(/.test(queryExecutorContent)
      || /this\.database\.beginTransaction\s*\(/.test(queryExecutorContent);
    if (benchConstructsWithOptionsObject(benchScriptContent, 'QueryExecutor') && queryExecutorAssumesDatabaseFacade) {
      failedChecks.push('query_executor_database_contract_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js so QueryExecutor receives a real database facade with getTable/insertRow/beginTransaction behavior instead of a loose object literal with partial fields only`);
    }
  }

  if (benchScriptContent && !/(?:console\.log|process\.stdout\.write)\s*\(\s*JSON\.stringify\s*\(/.test(benchScriptContent)) {
    failedChecks.push('bench_output_not_machine_readable');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so npm run bench -- --dry-run prints one machine-readable JSON object with top-level status, summary, and metrics keys instead of prose-only console logs');
  }
  const extraStdoutLogLines = typeof benchScriptContent === 'string'
    ? benchScriptContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /^console\.log\s*\(/.test(line)
        && !/JSON\.stringify\s*\(/.test(line)
      )
    : [];
  if (extraStdoutLogLines.length > 0) {
    failedChecks.push('bench_output_extra_stdout_logs');
    requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so dry-run stdout contains exactly one JSON.stringify(result) payload and no banner or phase console.log lines before or after it. Remove or redirect these stdout logs: ${extraStdoutLogLines.slice(0, 3).join(' | ')}`);
  }
  if (benchScriptContent && !/\bstatus\s*:\s*['"`]/.test(benchScriptContent) && !/\bstatus\b[\s\S]{0,120}\bsummary\b[\s\S]{0,200}\bmetrics\b/.test(benchScriptContent)) {
    failedChecks.push('bench_output_missing_result_envelope');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so dryRun returns and prints a top-level object with status, summary, and metrics keys instead of emitting raw metrics only');
  }

  return {
    storageEnginePath,
    bufferPoolPath,
    benchScriptPath,
    benchImportedModuleFiles,
    prototypeModulePaths,
    failedChecks,
    requiredNextEvidence,
  };
}

function getDatabaseLabNextPrototypeModuleTargets(scenarioState, limit = 2, preferredModuleFiles = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES) {
  const existing = new Set(
    getScenarioWorkspaceFiles(scenarioState)
      .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
  );
  const prioritizedFiles = Array.isArray(preferredModuleFiles) && preferredModuleFiles.length > 0
    ? preferredModuleFiles
    : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES;
  const missing = prioritizedFiles.filter((relativePath) => !existing.has(relativePath));
  const defaultMissing = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !existing.has(relativePath));
  const targets =
    missing.length > 0
      ? missing
      : defaultMissing.length > 0
        ? defaultMissing
        : prioritizedFiles;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabNextPrototypeTopLevelTargets(scenarioState, limit = 2) {
  const existing = new Set(getScenarioWorkspaceFiles(scenarioState));
  const orderedTargets = [
    `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
  ];
  const missing = orderedTargets.filter((relativePath) => !existing.has(relativePath));
  const targets = missing.length > 0 ? missing : orderedTargets;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabNextDesignDocTargets(scenarioState, limit = 2) {
  const existing = new Set(getScenarioWorkspaceFiles(scenarioState));
  const missing = DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => !existing.has(relativePath));
  const targets = missing.length > 0 ? missing : DATABASE_LAB_REQUIRED_DESIGN_FILES;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabExistingDesignFiles(scenarioState) {
  return getScenarioWorkspaceFiles(scenarioState)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_DESIGN_DIR}/`) && relativePath.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
}

function isStrongDatabaseLiveModel(modelId) {
  return typeof modelId === 'string' && modelId.trim().toLowerCase() === XIAOMI_MIMO_STRONG_MODEL.toLowerCase();
}

function buildDatabaseArtifactProgress(workspaceRelativeFiles, notes = {}) {
  const workspaceSet = new Set(Array.isArray(workspaceRelativeFiles) ? workspaceRelativeFiles : []);
  const designFilesPresent = DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => workspaceSet.has(relativePath));
  const prototypeTopLevelFilesPresent = DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.filter((relativePath) => workspaceSet.has(relativePath));
  const prototypeSrcFiles = Array.from(workspaceSet)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
    .sort((left, right) => left.localeCompare(right));
  const benchRequiredModuleFiles = Array.isArray(notes?.benchRequiredModuleFiles)
    ? notes.benchRequiredModuleFiles
    : DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES;
  const missingCoreModules = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !workspaceSet.has(relativePath));
  const missingBenchDependencyModules = benchRequiredModuleFiles.filter((relativePath) => !workspaceSet.has(relativePath));
  const includeVerifyQualityEvidence = notes?.includeVerifyQualityEvidence === true;
  const expectedQualityFiles = [
    DATABASE_LAB_DESIGN_QUALITY_FILE,
    ...(includeVerifyQualityEvidence ? [DATABASE_LAB_VERIFY_QUALITY_FILE] : []),
  ];
  const qualityFilesPresent = expectedQualityFiles.filter((relativePath) => workspaceSet.has(relativePath));
  const verificationAudit = notes?.verificationScriptAudit ?? null;
  const packageEntryDiagnostics = notes?.packageEntryDiagnostics ?? null;
  const derivedBlockingMissingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
    scenarioId: typeof notes?.scenarioId === 'string' ? notes.scenarioId : '',
  });
  const blockingMissingEntryRefs = Array.isArray(notes?.blockingMissingEntryRefs)
    ? notes.blockingMissingEntryRefs
    : derivedBlockingMissingEntryRefs;
  const optionalMissingEntryRefs = Array.isArray(notes?.optionalMissingEntryRefs)
    ? notes.optionalMissingEntryRefs
    : (Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
      ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingMissingEntryRefs.includes(entryRef))
      : []);
  const benchmarkSelfCheck = evaluateDatabaseBenchmarkSelfCheck(verificationAudit);
  const progress = {
    designDocs: {
      completed: designFilesPresent.length === DATABASE_LAB_REQUIRED_DESIGN_FILES.length,
      present: designFilesPresent,
      missing: DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => !workspaceSet.has(relativePath)),
    },
    prototypeTopLevel: {
      completed:
        prototypeTopLevelFilesPresent.length === DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.length
        && (packageEntryDiagnostics?.missingRequiredEntries?.length ?? 0) === 0,
      present: prototypeTopLevelFilesPresent,
      missing: [
        ...DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.filter((relativePath) => !workspaceSet.has(relativePath)),
        ...((packageEntryDiagnostics?.missingRequiredEntries ?? []).map((entry) => `package-entry:${entry}`)),
      ],
    },
    prototypeModules: {
      completed: missingCoreModules.length === 0 && missingBenchDependencyModules.length === 0,
      count: prototypeSrcFiles.length,
      present: prototypeSrcFiles,
      nextSuggestedTargets: DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !workspaceSet.has(relativePath)).slice(0, 2),
      missingCoreModules,
      missingBenchDependencyModules,
    },
    benchDependencies: {
      wiredToPrototypeModules: benchRequiredModuleFiles.length > 0,
      required: benchRequiredModuleFiles,
      missing: missingBenchDependencyModules,
    },
    qualityEvidence: {
      present: qualityFilesPresent,
      missing: expectedQualityFiles.filter((relativePath) => !workspaceSet.has(relativePath)),
    },
    benchmarkSelfCheck,
    packageEntryRefs: {
      packageJsonFound: packageEntryDiagnostics?.packageJsonFound === true,
      invalidPackageJson: packageEntryDiagnostics?.invalidPackageJson === true,
      parseError: packageEntryDiagnostics?.parseError ?? null,
      checked: Array.isArray(packageEntryDiagnostics?.checkedEntries) ? packageEntryDiagnostics.checkedEntries : [],
      missing: Array.isArray(packageEntryDiagnostics?.missingEntryRefs) ? packageEntryDiagnostics.missingEntryRefs : [],
      missingBlocking: blockingMissingEntryRefs,
      missingOptional: optionalMissingEntryRefs,
      missingRequired: Array.isArray(packageEntryDiagnostics?.missingRequiredEntries) ? packageEntryDiagnostics.missingRequiredEntries : [],
    },
  };
  if (!progress.designDocs.completed) {
    progress.nextStage = 'design_docs';
  } else if (!progress.prototypeTopLevel.completed) {
    progress.nextStage = 'prototype_top_level';
  } else if (!progress.prototypeModules.completed) {
    progress.nextStage = 'prototype_modules';
  } else if (!progress.benchmarkSelfCheck.passed) {
    progress.nextStage = 'benchmark_self_check';
  } else if (progress.qualityEvidence.missing.includes(DATABASE_LAB_DESIGN_QUALITY_FILE)) {
    progress.nextStage = 'design_manifest';
  } else {
    progress.nextStage = 'complete';
  }
  return progress;
}

function tryParseJsonFromCommandStdout(stdoutText) {
  const trimmed = typeof stdoutText === 'string' ? stdoutText.trim() : '';
  if (!trimmed) {
    return { parsed: null, parseError: 'stdout_empty' };
  }
  const balancedJson = extractFirstBalancedJsonObject(trimmed);
  if (balancedJson) {
    try {
      return { parsed: JSON.parse(balancedJson), parseError: null };
    } catch {
      // Fall through to legacy candidate scanning.
    }
  }
  const braceIndexes = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === '{') {
      braceIndexes.push(index);
    }
  }
  for (const index of braceIndexes) {
    const candidate = trimmed.slice(index);
    try {
      return { parsed: JSON.parse(candidate), parseError: null };
    } catch {
      // Try the next candidate.
    }
  }
  return { parsed: null, parseError: 'stdout_json_parse_failed' };
}

function evaluateDatabaseBenchmarkSelfCheck(verificationAudit) {
  const stderr = typeof verificationAudit?.stderr === 'string' ? verificationAudit.stderr.trim() : '';
  const stdout = typeof verificationAudit?.stdout === 'string' ? verificationAudit.stdout.trim() : '';
  const { parsed, parseError } = tryParseJsonFromCommandStdout(stdout);
  const metrics = parsed && typeof parsed === 'object' ? parsed.metrics : null;
  const hasRequiredMetrics =
    !!metrics
    && ['pagesWritten', 'pagesRead', 'writeDurationMs', 'readDurationMs', 'totalDurationMs']
      .every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]));
  const status = parsed && typeof parsed === 'object' && typeof parsed.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : null;
  const statusAcceptable =
    status === null
    || status === 'ok'
    || status === 'passed'
    || status === 'success'
    || status === 'completed'
    || status === 'dry-run'
    || status === 'dry_run'
    || status === 'dryrun';
  const stderrLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stderr);
  const stdoutLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stdout);
  const passed =
    !!verificationAudit
    && verificationAudit.exitCode === 0
    && !stderrLooksFatal
    && !stdoutLooksFatal
    && hasRequiredMetrics
    && statusAcceptable;

  return {
    attempted: Boolean(verificationAudit),
    passed,
    command: verificationAudit ? `${verificationAudit.command} ${Array.isArray(verificationAudit.args) ? verificationAudit.args.join(' ') : ''}`.trim() : null,
    exitCode: verificationAudit?.exitCode ?? null,
    stderr: stderr || null,
    stdout: stdout || null,
    parsedStatus: status,
    parseError,
    hasRequiredMetrics,
  };
}

function summarizeDatabaseArtifactProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return 'artifact progress unavailable';
  }
  const completed = [];
  const remaining = [];
  if (progress.designDocs?.completed) {
    completed.push('design docs complete');
  } else if (Array.isArray(progress.designDocs?.missing) && progress.designDocs.missing.length > 0) {
    remaining.push(`design docs missing: ${progress.designDocs.missing.join(', ')}`);
  }
  if (progress.prototypeTopLevel?.completed) {
    completed.push('prototype top-level files complete');
  } else if (Array.isArray(progress.prototypeTopLevel?.missing) && progress.prototypeTopLevel.missing.length > 0) {
    remaining.push(`prototype top-level files missing: ${progress.prototypeTopLevel.missing.join(', ')}`);
  }
  if (progress.prototypeModules?.completed) {
    completed.push(`prototype src depth reached (${progress.prototypeModules.count} files)`);
  } else {
    remaining.push(`prototype src depth incomplete (${progress.prototypeModules?.count ?? 0} files present)`);
  }
  if (Array.isArray(progress.prototypeModules?.missingCoreModules) && progress.prototypeModules.missingCoreModules.length > 0) {
    remaining.push(`core prototype modules missing: ${progress.prototypeModules.missingCoreModules.join(', ')}`);
  }
  if (progress.benchDependencies?.wiredToPrototypeModules === false) {
    remaining.push('benchmark scaffold not wired to prototype src modules');
  }
  if (Array.isArray(progress.prototypeModules?.missingBenchDependencyModules) && progress.prototypeModules.missingBenchDependencyModules.length > 0) {
    remaining.push(`benchmark module prerequisites missing: ${progress.prototypeModules.missingBenchDependencyModules.join(', ')}`);
  }
  if (Array.isArray(progress.qualityEvidence?.present) && progress.qualityEvidence.present.length > 0) {
    completed.push(`quality evidence present: ${progress.qualityEvidence.present.join(', ')}`);
  }
  if (Array.isArray(progress.qualityEvidence?.missing) && progress.qualityEvidence.missing.length > 0) {
    remaining.push(`quality evidence missing: ${progress.qualityEvidence.missing.join(', ')}`);
  }
  if (Array.isArray(progress.packageEntryRefs?.missingRequired) && progress.packageEntryRefs.missingRequired.length > 0) {
    remaining.push(`package entry requirements missing: ${progress.packageEntryRefs.missingRequired.join(', ')}`);
  }
  if (progress.benchmarkSelfCheck?.attempted) {
    completed.push(progress.benchmarkSelfCheck.passed ? 'benchmark self-check passed' : 'benchmark self-check failed');
  } else {
    remaining.push('benchmark self-check not yet observed');
  }
  if (progress.packageEntryRefs?.invalidPackageJson) {
    remaining.push(`prototype package.json invalid (${progress.packageEntryRefs.parseError ?? 'parse failure'})`);
  } else if (Array.isArray(progress.packageEntryRefs?.missingBlocking) && progress.packageEntryRefs.missingBlocking.length > 0) {
    remaining.push(`prototype package entry refs broken: ${progress.packageEntryRefs.missingBlocking.join(', ')}`);
  }
  if (Array.isArray(progress.packageEntryRefs?.missingOptional) && progress.packageEntryRefs.missingOptional.length > 0) {
    remaining.push(`prototype package entry refs optional/missing: ${progress.packageEntryRefs.missingOptional.join(', ')}`);
  }
  return [completed.join('; '), remaining.join('; ')].filter(Boolean).join(' | ');
}

function hasEnvironmentBlockerSignal(scenarioState) {
  const executionSummary = scenarioState?.debug?.executionSummary ?? {};
  const providerSummary = executionSummary?.providerSummary ?? {};
  const providerFailure = getScenarioProviderFailure(scenarioState);
  const capabilityWarnings = Array.isArray(executionSummary?.capabilityWarnings) ? executionSummary.capabilityWarnings : [];
  if (providerFailure) {
    return true;
  }
  const warningText = capabilityWarnings
    .map((entry) => `${entry?.code ?? ''} ${entry?.message ?? ''}`)
    .join('\n');
  const providerText = [
    executionSummary.issueCategory ?? '',
    providerSummary.lastMessage ?? '',
    providerSummary.recentStatus ?? '',
  ].join('\n');
  if (/unable to verify the first certificate|certificate|authentication failed|missing api key secret|tls|network failure/i.test(warningText)) {
    return true;
  }
  return /unable to verify the first certificate|certificate|authentication failed|missing api key secret|tls/i.test(providerText);
}

function shouldStopScenarioEarly(spec, scenarioState) {
  const lifecycleStatus = scenarioState?.summary?.lifecycleStatus ?? null;
  if (lifecycleStatus !== 'COMPLETED') {
    return false;
  }
  const acceptanceVerdict = scenarioState?.debug?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
  if (acceptanceVerdict !== 'passed') {
    return false;
  }
  if (spec.id === 'desktop-ops-followup') {
    return hasDesktopObservationEvidence(scenarioState);
  }
  if (spec.id === 'database-near-mysql-design') {
    return hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
  }
  if (spec.id === 'database-near-mysql-verify') {
    return hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  if (spec.id.startsWith('database-near-mysql-')) {
    return hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  return false;
}

function getScenarioContinueBudget(spec) {
  if (spec?.id === 'database-near-mysql-design') {
    return 12;
  }
  return 8;
}

function getScenarioFinalizeBudget(spec) {
  if (spec?.id === 'database-near-mysql-design') {
    return 1;
  }
  return 1;
}

function countContinueAttemptsByPhase(continueAttempts, phase) {
  if (!Array.isArray(continueAttempts) || typeof phase !== 'string' || phase.trim().length === 0) {
    return 0;
  }
  return continueAttempts.filter((attempt) => attempt?.metadata?.phase === phase).length;
}

function canIssueContinue(spec, continueAttempts, instruction) {
  const normalized = normalizeContinueInstruction(instruction);
  if (!normalized) {
    return false;
  }
  const baseBudget = getScenarioContinueBudget(spec);
  const usedAttempts = Array.isArray(continueAttempts) ? continueAttempts.length : 0;
  if (usedAttempts < baseBudget) {
    return true;
  }
  if (normalized?.metadata?.phase !== 'finalize') {
    return false;
  }
  const finalizeBudget = getScenarioFinalizeBudget(spec);
  if (finalizeBudget <= 0) {
    return false;
  }
  const finalizeAttempts = countContinueAttemptsByPhase(continueAttempts, 'finalize');
  if (finalizeAttempts >= finalizeBudget) {
    return false;
  }
  const allowedTools = Array.isArray(normalized?.metadata?.allowedTools) ? normalized.metadata.allowedTools : null;
  return !allowedTools || allowedTools.length === 0;
}

function getPrioritizedDatabasePrototypeRepairTargets(prototypeCodeDiagnostics, allTargets) {
  const failedChecks = Array.isArray(prototypeCodeDiagnostics?.failedChecks)
    ? prototypeCodeDiagnostics.failedChecks
    : [];
  const targetSet = new Set(Array.isArray(allTargets) ? allTargets : []);
  const criticalTargets = [];
  const secondaryTargets = [];
  const fallbackTargets = [];
  const pushUnique = (bucket, relativePath) => {
    if (targetSet.has(relativePath) && !criticalTargets.includes(relativePath) && !secondaryTargets.includes(relativePath) && !fallbackTargets.includes(relativePath)) {
      bucket.push(relativePath);
    }
  };
  const pushCritical = (relativePath) => pushUnique(criticalTargets, relativePath);
  const pushSecondary = (relativePath) => pushUnique(secondaryTargets, relativePath);
  const pushFallback = (relativePath) => pushUnique(fallbackTargets, relativePath);
  const benchPath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  const storagePath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`;
  const bufferPoolPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`;
  const walManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`;
  const transactionManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`;
  const packageJsonPath = `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`;
  const benchModuleExportTargets = Array.from(new Set(
    failedChecks
      .filter((entry) =>
        entry.startsWith('bench_module_export_mismatch:')
        || entry.startsWith('bench_module_export_name_mismatch:')
      )
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),
  ));
  const benchModuleApiTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('bench_module_api_mismatch:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),
  ));
  const undeclaredExternalDependencyTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
  ));
  const undeclaredNodeBuiltinTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('undeclared_node_builtin:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
  ));

  if (failedChecks.includes('prototype_module_system_mismatch')) {
    pushCritical(packageJsonPath);
    pushCritical(benchPath);
  }
  if (benchModuleExportTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleExportTargets) {
      pushCritical(relativePath);
    }
  }
  if (benchModuleApiTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleApiTargets) {
      pushCritical(relativePath);
    }
  }
  if (undeclaredExternalDependencyTargets.length > 0) {
    pushCritical(packageJsonPath);
    for (const relativePath of undeclaredExternalDependencyTargets) {
      pushCritical(relativePath);
    }
  }
  if (undeclaredNodeBuiltinTargets.length > 0) {
    for (const relativePath of undeclaredNodeBuiltinTargets) {
      pushCritical(relativePath);
    }
  }
  if (
    failedChecks.includes('bench_transaction_api_mismatch')
    || failedChecks.includes('bench_transaction_manager_argument_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
  ) {
    pushCritical(benchPath);
    pushCritical(transactionManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_constructor_arg_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
  ) {
    pushCritical(benchPath);
    pushCritical(transactionManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
  ) {
    pushSecondary(transactionManagerPath);
    pushSecondary(walManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_storage_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))
  ) {
    pushSecondary(transactionManagerPath);
    pushSecondary(storagePath);
  }
  if (
    failedChecks.includes('bench_storage_engine_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_storage_engine_'))
    || failedChecks.some((entry) => entry.startsWith('storage_engine_'))
    || failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(storagePath);
  }
  if (
    failedChecks.includes('bench_buffer_pool_api_mismatch')
    || failedChecks.includes('buffer_pool_constructor_arg_mismatch')
    || failedChecks.includes('buffer_pool_constructor_dependency_missing')
    || failedChecks.includes('bench_buffer_pool_missing_initialize')
    || failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(bufferPoolPath);
  }
  if (failedChecks.includes('wal_manager_constructor_arg_mismatch')) {
    pushSecondary(benchPath);
    pushSecondary(walManagerPath);
  }
  if (
    failedChecks.includes('bench_wal_manager_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(walManagerPath);
  }
  const benchModuleContractTargets = Array.from(new Set([
    ...benchModuleExportTargets,
    ...benchModuleApiTargets,
  ]));
  if (benchModuleContractTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleContractTargets) {
      pushCritical(relativePath);
    }
  }
  if (
    failedChecks.includes('bench_output_not_machine_readable')
    || failedChecks.includes('bench_output_extra_stdout_logs')
    || failedChecks.includes('bench_output_missing_result_envelope')
    || failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
  ) {
    pushCritical(benchPath);
  }

  for (const relativePath of targetSet) {
    pushFallback(relativePath);
  }
  const prioritized = [...criticalTargets, ...secondaryTargets, ...fallbackTargets];
  const hasTransactionApiDrift =
    failedChecks.includes('bench_transaction_api_mismatch')
    || failedChecks.includes('bench_transaction_manager_argument_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'));
  const hasStorageDrift =
    failedChecks.includes('bench_storage_engine_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_storage_engine_'))
    || failedChecks.some((entry) => entry.startsWith('storage_engine_'));
  const hasBufferDrift =
    failedChecks.includes('bench_buffer_pool_api_mismatch')
    || failedChecks.includes('buffer_pool_constructor_arg_mismatch')
    || failedChecks.includes('buffer_pool_constructor_dependency_missing')
    || failedChecks.includes('bench_buffer_pool_missing_initialize')
    || failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
    || failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'));
  const hasWalDrift =
    failedChecks.includes('wal_manager_constructor_arg_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_module_export_name_mismatch:') && entry.includes('/wal-manager.js:'))
    || failedChecks.some((entry) => entry.startsWith('bench_module_api_mismatch:') && entry.includes('/wal-manager.js'))
    || failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'));
  const hasTransactionContractDrift =
    failedChecks.includes('transaction_manager_constructor_arg_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
    || failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.includes('transaction_manager_storage_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'));
  const hasQueryExecutorDrift = failedChecks.includes('query_executor_database_contract_mismatch');
  const driftCategoryCount = [
    benchModuleContractTargets.length > 0 || failedChecks.includes('prototype_module_system_mismatch'),
    hasStorageDrift,
    hasBufferDrift,
    hasWalDrift,
    hasTransactionApiDrift || hasTransactionContractDrift,
    hasQueryExecutorDrift,
  ].filter(Boolean).length;
  let maxTargets = hasTransactionApiDrift && hasStorageDrift ? 3 : 2;
  if (driftCategoryCount >= 4) {
    maxTargets = Math.max(maxTargets, 6);
  } else if (driftCategoryCount === 3) {
    maxTargets = Math.max(maxTargets, 5);
  } else if (driftCategoryCount === 2) {
    maxTargets = Math.max(maxTargets, 4);
  }
  return prioritized.slice(0, maxTargets);
}

function scenarioNeedsMoreEvidence(spec, scenarioState) {
  if (spec.id === 'desktop-ops-followup') {
    return !hasDesktopObservationEvidence(scenarioState);
  }
  if (spec.id === 'database-near-mysql-design') {
    return !hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      || !hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
  }
  if (spec.id === 'database-near-mysql-verify') {
    return !hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      || !hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  return false;
}

function getRuntimeCorrectionKind(scenarioState) {
  const debug = scenarioState?.debug ?? scenarioState;
  return scenarioState?.task?.runtime?.contractDiagnostics?.lastPendingCorrectionKind
    ?? scenarioState?.task?.runtime?.pendingCorrection
    ?? debug?.task?.runtime?.contractDiagnostics?.lastPendingCorrectionKind
    ?? debug?.task?.runtime?.pendingCorrection
    ?? debug?.executionSummary?.turnContract?.lastPendingCorrectionKind
    ?? null;
}

function hasToolInvocationSince(scenarioState, timestamp) {
  if (typeof timestamp !== 'number') {
    return false;
  }
  const candidates = [
    scenarioState?.task?.toolInvocations,
    scenarioState?.debug?.task?.toolInvocations,
    scenarioState?.task?.visibleToolActivities,
    scenarioState?.summary?.visibleToolActivities,
  ];
  return candidates.some((entries) =>
    Array.isArray(entries)
    && entries.some((entry) => {
      const startedAt = entry?.startedAt ?? entry?.createdAt ?? entry?.timestamp ?? null;
      const endedAt = entry?.endedAt ?? entry?.finishedAt ?? null;
      return (typeof startedAt === 'number' && startedAt >= timestamp)
        || (typeof endedAt === 'number' && endedAt >= timestamp);
    })
  );
}

function countContinueAttemptsByUniqueKey(continueAttempts, uniqueKey) {
  if (!Array.isArray(continueAttempts) || typeof uniqueKey !== 'string' || uniqueKey.trim().length === 0) {
    return 0;
  }
  return continueAttempts.filter((attempt) => attempt?.metadata?.uniqueKey === uniqueKey).length;
}

function shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, continueAttempts) {
  const normalized = normalizeContinueInstruction(instruction);
  if (!normalized?.metadata?.uniqueKey) {
    return false;
  }
  const lifecycleStatus = scenarioState?.summary?.lifecycleStatus ?? null;
  if (lifecycleStatus !== 'RUNNING') {
    return false;
  }
  const workspaceFingerprint = getScenarioWorkspaceFingerprint(scenarioState);
  const lastAttempt = [...(Array.isArray(continueAttempts) ? continueAttempts : [])]
    .reverse()
    .find((attempt) => attempt?.metadata?.uniqueKey === normalized.metadata.uniqueKey);
  if (!lastAttempt) {
    return false;
  }
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  const engineStatus = scenarioState?.task?.runtime?.engineStatus
    ?? scenarioState?.debug?.task?.runtime?.engineStatus
    ?? null;
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (
    ['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION'].includes(correctionKind)
    && engineStatus !== 'RUNNING'
    && !executionLeaseActive
    && !hasToolInvocationSince(scenarioState, lastAttempt.issuedAt)
    && countContinueAttemptsByUniqueKey(continueAttempts, normalized.metadata.uniqueKey) < 2
  ) {
    return false;
  }
  if (
    lastAttempt?.metadata?.allowTargetedReadInspection === true
    && isInspectionOnlyReadDriftAttempt(lastAttempt)
  ) {
    return false;
  }
  return lastAttempt.lifecycleStatus === 'RUNNING'
    && lastAttempt.workspaceFingerprint === workspaceFingerprint;
}

function detectContinueInstructionDrift(scenarioState, attempt) {
  const observedSinceAt = typeof attempt?.observedSinceAt === 'number'
    ? attempt.observedSinceAt
    : typeof attempt?.issuedAt === 'number'
      ? attempt.issuedAt
      : null;
  if (!attempt?.metadata || observedSinceAt === null) {
    return null;
  }
  const allowedTools = Array.isArray(attempt.metadata.allowedTools)
    ? attempt.metadata.allowedTools.filter(Boolean)
    : [];
  const targetPaths = Array.isArray(attempt.metadata.targetPaths)
    ? attempt.metadata.targetPaths.filter(Boolean)
    : [];
  const allowedPaths = Array.isArray(attempt.metadata.allowedPaths)
    ? attempt.metadata.allowedPaths.filter(Boolean)
    : targetPaths;
  const allowedReadPaths = Array.isArray(attempt.metadata.allowedReadPaths)
    ? attempt.metadata.allowedReadPaths.filter(Boolean)
    : allowedPaths;
  const allowedWritePaths = Array.isArray(attempt.metadata.allowedWritePaths)
    ? attempt.metadata.allowedWritePaths.filter(Boolean)
    : allowedPaths;
  const allowedOptionalPaths = Array.isArray(attempt.metadata.allowedOptionalPaths)
    ? attempt.metadata.allowedOptionalPaths.filter(Boolean)
    : [];
  const forbiddenWritePaths = Array.isArray(attempt.metadata.forbiddenWritePaths)
    ? attempt.metadata.forbiddenWritePaths.filter(Boolean)
    : [];
  const allowedPathPrefixes = Array.isArray(attempt.metadata.allowedPathPrefixes)
    ? attempt.metadata.allowedPathPrefixes.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const allowedReadPathPrefixes = Array.isArray(attempt.metadata.allowedReadPathPrefixes)
    ? attempt.metadata.allowedReadPathPrefixes.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : allowedPathPrefixes;
  const allowedWritePathPrefixes = Array.isArray(attempt.metadata.allowedWritePathPrefixes)
    ? attempt.metadata.allowedWritePathPrefixes.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : allowedPathPrefixes;
  if (
    allowedTools.length === 0
    && allowedReadPaths.length === 0
    && allowedWritePaths.length === 0
    && allowedReadPathPrefixes.length === 0
    && allowedWritePathPrefixes.length === 0
  ) {
    return null;
  }
  const toolInvocations = Array.isArray(scenarioState?.task?.toolInvocations)
    ? scenarioState.task.toolInvocations
    : [];
  const invocationCandidates = toolInvocations.filter((entry) => {
    const startedAt = typeof entry?.startedAt === 'number' ? entry.startedAt : null;
    return startedAt !== null && startedAt >= observedSinceAt;
  });
  if (invocationCandidates.length === 0) {
    return null;
  }
  const canonicalInvocations = Array.from(new Map(
    invocationCandidates.map((entry) => [entry.invocationId, entry]),
  ).values());
  attempt.observedToolIds = canonicalInvocations.map((entry) => entry?.toolId).filter(Boolean);
  attempt.observedPaths = canonicalInvocations
    .map((entry) => (typeof entry?.arguments?.path === 'string' ? entry.arguments.path : null))
    .filter(Boolean);
  attempt.observedWriteCount = canonicalInvocations.filter((entry) => entry?.toolId === 'write_file').length;
  attempt.observedReadCount = canonicalInvocations.filter((entry) => entry?.toolId === 'read_file').length;
  const successfulWritePaths = new Set(
    canonicalInvocations
      .filter((entry) => entry?.toolId === 'write_file' && (entry.status === 'SUCCEEDED' || entry.status === undefined))
      .map((entry) => (typeof entry?.arguments?.path === 'string' ? entry.arguments.path : null))
      .filter(Boolean),
  );
  const requiredWritePathsSatisfied = allowedWritePaths.length > 0
    && allowedWritePaths.every((relativePath) => successfulWritePaths.has(relativePath));
  const benchmarkSelfCheckRunObserved =
    attempt.metadata.phase === 'benchmark_self_check'
    && canonicalInvocations.some((entry) => entry?.toolId === 'run_command');
  const benchmarkAfterWriteAllowedPhases = new Set([
    'prototype_modules',
    'prototype_contract_repair',
    'bench_scaffold_repair',
    'bench_module_system_repair',
    'bench_runtime_io_repair',
    'bench_api_repair',
    'storage_engine_repair',
  ]);
  const isBenignPostWriteBenchmarkRun = (entry) => {
    if (entry?.toolId !== 'run_command' || !requiredWritePathsSatisfied) {
      return false;
    }
    if (!benchmarkAfterWriteAllowedPhases.has(attempt.metadata.phase)) {
      return false;
    }
    const serializedArgs = JSON.stringify(entry.arguments ?? {});
    return /\bbench\b|dry-run|--dry-run/i.test(serializedArgs);
  };
  const isBenignBenchmarkInspection = (entry) =>
    benchmarkSelfCheckRunObserved
    && ['read_file', 'list_files', 'search_files'].includes(entry?.toolId);
  const isBenignEarlyDesignManifestWrite = (entry) =>
    attempt.metadata.phase === 'design_docs'
    && entry?.toolId === 'write_file'
    && requiredWritePathsSatisfied
    && entry.arguments?.path === DATABASE_LAB_DESIGN_QUALITY_FILE;
  if (forbiddenWritePaths.length > 0) {
    const forbiddenWrites = canonicalInvocations.filter((entry) => {
      if (entry?.toolId !== 'write_file') {
        return false;
      }
      const targetPath = typeof entry.arguments?.path === 'string' ? entry.arguments.path : null;
      return targetPath && forbiddenWritePaths.includes(targetPath);
    });
    if (forbiddenWrites.length > 0) {
      const observed = forbiddenWrites
        .map((entry) => `${entry.toolId}:${entry.arguments?.path ?? 'unknown'}`)
        .join(', ');
      return `observed forbidden write path after ${attempt.metadata.phase ?? 'continue'}: ${observed}`;
    }
  }
  const toolViolations = allowedTools.length > 0
    ? canonicalInvocations.filter((entry) =>
      !allowedTools.includes(entry.toolId)
      && !isBenignBenchmarkInspection(entry)
      && !isBenignPostWriteBenchmarkRun(entry)
    )
    : [];
  if (toolViolations.length > 0) {
    const observed = toolViolations.map((entry) => entry.toolId).filter(Boolean).join(', ');
    return `observed forbidden tool(s) after ${attempt.metadata.phase ?? 'continue'}: ${observed}`;
  }
  if (allowedPaths.length > 0) {
    const pathViolations = canonicalInvocations.filter((entry) => {
      if (isBenignBenchmarkInspection(entry)) {
        return false;
      }
      if (isBenignEarlyDesignManifestWrite(entry)) {
        return false;
      }
      if (entry.toolId !== 'write_file' && entry.toolId !== 'read_file') {
        return false;
      }
      const targetPath = typeof entry.arguments?.path === 'string' ? entry.arguments.path : null;
      const isRead = entry.toolId === 'read_file';
      const activeAllowedPaths = isRead ? allowedReadPaths : allowedWritePaths;
      const activeAllowedPrefixes = isRead ? allowedReadPathPrefixes : allowedWritePathPrefixes;
      const allowedByPrefix = targetPath
        && activeAllowedPrefixes.some((prefix) => targetPath.startsWith(prefix));
      return targetPath
        && !allowedByPrefix
        && !activeAllowedPaths.includes(targetPath)
        && !allowedOptionalPaths.includes(targetPath);
    });
    if (pathViolations.length > 0) {
      if (attempt.metadata.phase === 'brief_read') {
        const briefReadViolationsOnly = pathViolations.every((entry) => entry.toolId === 'read_file');
        const successfulRequiredReads = new Set(
          canonicalInvocations
            .filter((entry) => entry.toolId === 'read_file' && entry.status === 'SUCCEEDED')
            .map((entry) => (typeof entry.arguments?.path === 'string' ? entry.arguments.path : null))
            .filter(Boolean),
        );
        const requiredReadsSatisfied = allowedPaths.every((relativePath) => successfulRequiredReads.has(relativePath));
        if (briefReadViolationsOnly && requiredReadsSatisfied) {
          return null;
        }
      }
      const observed = pathViolations
        .map((entry) => `${entry.toolId}:${entry.arguments?.path ?? 'unknown'}`)
        .join(', ');
      return `observed tool path drift after ${attempt.metadata.phase ?? 'continue'}: ${observed}`;
    }
  }
  const requiredTrackerStatus = typeof attempt.metadata.requiredTrackerStatus === 'string'
    ? attempt.metadata.requiredTrackerStatus.trim().toUpperCase()
    : '';
  const requiredTrackerDecision = typeof attempt.metadata.requiredTrackerDecision === 'string'
    ? attempt.metadata.requiredTrackerDecision.trim().toUpperCase()
    : '';
  const progressHistory = Array.isArray(scenarioState?.task?.runtime?.progressHistory)
    ? scenarioState.task.runtime.progressHistory
    : (Array.isArray(scenarioState?.debug?.task?.runtime?.progressHistory)
      ? scenarioState.debug.task.runtime.progressHistory
      : []);
  const trackerCountAtIssue = Number.isInteger(attempt?.trackerCountAtIssue)
    ? attempt.trackerCountAtIssue
    : null;
  if ((requiredTrackerStatus || requiredTrackerDecision) && trackerCountAtIssue !== null && progressHistory.length > trackerCountAtIssue) {
    const newTrackers = progressHistory.slice(trackerCountAtIssue).filter((entry) => entry && typeof entry === 'object');
    const latestTracker = newTrackers.at(-1) ?? null;
    if (latestTracker) {
      attempt.observedTracker = latestTracker;
      const actualStatus = typeof latestTracker.status === 'string' ? latestTracker.status.trim().toUpperCase() : '';
      const actualDecision = typeof latestTracker.decision === 'string' ? latestTracker.decision.trim().toUpperCase() : '';
      if (requiredTrackerStatus && actualStatus !== requiredTrackerStatus) {
        return `observed invalid tracker status after ${attempt.metadata.phase ?? 'continue'}: expected ${requiredTrackerStatus}, got ${actualStatus || 'UNKNOWN'}`;
      }
      if (requiredTrackerDecision && actualDecision !== requiredTrackerDecision) {
        return `observed invalid tracker decision after ${attempt.metadata.phase ?? 'continue'}: expected ${requiredTrackerDecision}, got ${actualDecision || 'UNKNOWN'}`;
      }
    }
  }
  return null;
}

function isRecoverableContinueInstructionDrift(spec, scenarioState, attempt, correctionDrift, continueAttempts) {
  const driftText = typeof correctionDrift === 'string' ? correctionDrift : '';
  if (!/observed tool path drift/i.test(driftText)) {
    return false;
  }
  const metadata = attempt?.metadata ?? {};
  const allowedTools = Array.isArray(metadata.allowedTools) ? metadata.allowedTools : [];
  if (!allowedTools.includes('write_file') || Number(attempt?.observedWriteCount ?? 0) <= 0) {
    return false;
  }
  if (/forbidden write path|forbidden tool|invalid tracker/i.test(driftText)) {
    return false;
  }
  const nextInstruction = normalizeContinueInstruction(deriveContinueMessage(spec, scenarioState));
  if (!nextInstruction?.metadata?.uniqueKey || nextInstruction.metadata.uniqueKey === metadata.uniqueKey) {
    return false;
  }
  const nextTargets = Array.isArray(nextInstruction.metadata.targetPaths)
    ? nextInstruction.metadata.targetPaths.filter(Boolean)
    : [];
  if (nextTargets.length === 0 || nextTargets.some((targetPath) => attempt.observedPaths?.includes(targetPath))) {
    return false;
  }
  return canIssueContinue(spec, continueAttempts, nextInstruction);
}

function deriveContinueMessage(spec, scenarioState) {
  const debug = scenarioState?.debug ?? scenarioState;
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  const deterministicAcceptance = debug?.executionSummary?.acceptance?.deterministic ?? null;
  const qualityAcceptance = debug?.executionSummary?.acceptance?.quality ?? null;
  const runtimeRequiredNextEvidence = collectAcceptanceRequiredNextEvidence(debug);
  const invalidOutputErrors = getUnitInvalidOutputErrors(scenarioState);
  const missingVerificationEvidence =
    deterministicAcceptance?.evidence?.failedChecks?.includes('missing_verification_evidence')
    || deterministicAcceptance?.outcome?.failedChecks?.includes('verification_outcome_not_demonstrated');
  const toolEvidenceSatisfied = debug?.executionSummary?.acceptance?.evidence?.toolEvidence?.satisfied === true;
  const artifactEvidenceSatisfied = debug?.executionSummary?.acceptance?.evidence?.artifactEvidence?.satisfied === true;
  const toolExecutionFailure = debug?.executionSummary?.issueCategory === 'tool_execution_failure';
  const desktopEvidenceSatisfied = hasDesktopObservationEvidence(scenarioState);
  const databaseLabArtifactSatisfied = hasDatabaseLabArtifactEvidence(scenarioState);
  const databaseLabBenchSatisfied = hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
  const databaseLabVerificationSatisfied = hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  const externalBlogWriteSatisfied = hasExternalBlogWriteEvidence(scenarioState);
  const databaseLabWriteProgressObserved = hasMeaningfulWriteProgress(
    scenarioState,
    /^(database-lab\/|quality\/database-design\.json$)/i,
  );
  const databasePrototypeSrcFileCount = getScenarioWorkspaceFiles(scenarioState)
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
    .length;
  const shouldKeepDatabaseLabPhaseRepair =
    spec.id === 'database-near-mysql-design'
    && databasePrototypeSrcFileCount >= 3
    && hasObservedDatabaseBenchRunAttempt(scenarioState);

  function buildOutputAndTrackerCorrection(detailSuffix) {
    const outputKeys = parseOutputContractKeys(spec);
    return [
      'Return exactly two blocks in this order and nothing else.',
      'Block 1 must be one [AGENT-001_OUTPUT] JSON envelope.',
      'Block 2 must be one tracker JSON object for the current unit.',
      'Do not emit tool calls. Do not add prose.',
      outputKeys.length > 0
        ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`
        : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',
      'The tracker JSON must include current_unit, status, progress_percent, decision, reason, next_unit, and files_created.',
      detailSuffix,
    ].join(' ');
  }

  function buildTrackerOnlyFinalizationInstruction() {
    const outputKeys = parseOutputContractKeys(spec);
    const latestOutput = scenarioState?.task?.latestVisibleOutput ?? scenarioState?.summary?.latestVisibleOutput ?? null;
    const workspaceArtifactCandidates = getScenarioWorkspaceFiles(scenarioState)
      .filter((relativePath) => !relativePath.startsWith('incoming/') && !relativePath.startsWith('source/') && !relativePath.startsWith('brief/'));
    const artifactPaths = Array.from(new Set([
      ...(Array.isArray(latestOutput?.artifactPaths) ? latestOutput.artifactPaths : []),
      ...(spec.id.startsWith('database-near-mysql-')
        ? workspaceArtifactCandidates.filter((relativePath) => isDatabaseLabDeclarableProducedFile(relativePath))
        : workspaceArtifactCandidates),
    ].filter((value) => typeof value === 'string' && value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
    const existingSummary = typeof latestOutput?.summary === 'string' && latestOutput.summary.trim()
      ? latestOutput.summary.trim()
      : 'The required artifacts have been written and verified by runtime evidence.';
    const existingDetails = typeof latestOutput?.details === 'string' && latestOutput.details.trim()
      ? latestOutput.details.trim()
      : 'Runtime acceptance evidence is present. Finalize the thread without emitting more tools.';
    return createContinueInstruction([
      'Runtime evidence is already sufficient except the final tracker still says the unit is in progress.',
      'Do not emit tool calls, prose, markdown fences, or extra commentary in this turn.',
      'Return exactly two machine-readable blocks in this order: one [AGENT-001_OUTPUT] JSON envelope, then one final tracker JSON object.',
      'Use this exact wrapper pattern with both tags present: [AGENT-001_OUTPUT]{...}[/AGENT-001_OUTPUT].',
      outputKeys.length > 0
        ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`
        : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',
      `Use a grounded summary like: ${JSON.stringify(existingSummary)}.`,
      `Use grounded details like: ${JSON.stringify(existingDetails)}.`,
      artifactPaths.length > 0
        ? `Set any file list fields to real produced files only: ${JSON.stringify(artifactPaths)}.`
        : 'Do not invent produced files; use an empty file list if the contract asks for one.',
      'Set issues to [] unless a real unresolved blocker remains.',
      'The final tracker JSON must set current_unit to AGENT-001, status to COMPLETE, progress_percent to 100, decision to CONTINUE, next_unit to null, and files_created to the same real produced files list.',
    ].join(' '), {
      strategy: 'tracker_only_finalization',
      phase: 'finalize',
      allowedTools: [],
      allowedPaths: [],
      uniqueKey: `${spec.id}:tracker_only_finalize`,
      requiredTrackerStatus: 'COMPLETE',
      requiredTrackerDecision: 'CONTINUE',
    });
  }

  function buildRuntimeRequiredEvidenceInstruction() {
    const latestToolFailureSummary = buildLatestToolFailureSummary(scenarioState);
    const qualityProfileId = qualityAcceptance?.profileId ?? spec?.unit?.qualityProfileId ?? 'none';
    const evidenceLines = runtimeRequiredNextEvidence.map((entry, index) => `${index + 1}. ${entry}`);
    const genericWarnings = [];
    if (correctionKind === 'AWAITING_TOOL_ACTION') {
      genericWarnings.push('This is a tool-action correction turn. Emit real tool JSON first and end with one tracker JSON.');
      if (latestToolFailureSummary) {
        genericWarnings.push('If you must inspect files before writing or rerunning a command, restrict inspection to the files or stack frames cited by the latest failed tool result.');
      }
    }
    if (spec.id === 'database-near-mysql-design') {
      genericWarnings.push(`The existing grounded files under ${DATABASE_LAB_ROOT}/ already exist. Do not reread brief/* and do not rewrite completed design docs unless the cited evidence gap explicitly requires it.`);
      genericWarnings.push(`Do not batch-rebuild the whole scaffold. Repair only the specific files implied by the current evidence gaps and the latest failed tool result.`);
    }
    if (spec.id === 'database-near-mysql-verify') {
      genericWarnings.push(`Use the existing ${DATABASE_LAB_ROOT}/ scaffold. Do not rebuild design/package files unless the cited evidence gap explicitly requires it.`);
    }
    return createContinueInstruction([
      buildJsonToolCallPrelude(),
      `Drive this turn from runtime acceptance and quality truth only. The active quality profile is ${qualityProfileId}.`,
      'Do not restart completed phases or broad-read the workspace again unless a cited evidence gap explicitly requires a re-read.',
      evidenceLines.length > 0
        ? `Address only these currently required evidence gaps in this turn: ${evidenceLines.join(' ')}`
        : 'Address only the currently reported acceptance and tool-failure gaps in this turn.',
      latestToolFailureSummary
        ? `Use the latest failed tool result as the repair surface instead of speculative rewrites. ${latestToolFailureSummary}`
        : null,
      toolExecutionFailure
        ? 'A real tool execution failure already occurred. Repair the implicated files or command contract before rerunning the same tool.'
        : null,
      ...genericWarnings,
      'Do not emit prose, markdown fences, or extra commentary. Emit only the minimum real tool actions needed for the current evidence gaps, then one tracker JSON.',
    ].filter(Boolean).join(' '), {
      strategy: 'runtime_required_evidence',
      phase: 'runtime_required_evidence',
    });
  }

  function buildDatabaseLabContinueInstruction(parts, metadata = {}) {
    const normalizedMetadata = { ...metadata };
    const phaseName = typeof normalizedMetadata.phase === 'string'
      ? normalizedMetadata.phase
      : '';
    const isRepairPhase = /repair/i.test(phaseName);
    if (
      isRepairPhase
      && normalizedMetadata.allowTargetedReadInspection !== false
      && Array.isArray(normalizedMetadata.targetPaths)
      && normalizedMetadata.targetPaths.length > 0
    ) {
      normalizedMetadata.allowTargetedReadInspection = true;
    }
    if (!Array.isArray(normalizedMetadata.allowedTools)) {
      if (normalizedMetadata.phase === 'brief_read') {
        normalizedMetadata.allowedTools = ['list_files', 'read_file'];
      } else if (normalizedMetadata.phase === 'benchmark_self_check') {
        normalizedMetadata.allowedTools = ['run_command'];
      } else if (normalizedMetadata.allowTargetedReadInspection === true && Array.isArray(normalizedMetadata.targetPaths) && normalizedMetadata.targetPaths.length > 0) {
        normalizedMetadata.allowedTools = ['write_file', 'read_file'];
      } else if (Array.isArray(normalizedMetadata.targetPaths) && normalizedMetadata.targetPaths.length > 0) {
        normalizedMetadata.allowedTools = ['write_file'];
      }
    }
    if (!Array.isArray(normalizedMetadata.allowedPaths) && Array.isArray(normalizedMetadata.targetPaths)) {
      normalizedMetadata.allowedPaths = [...normalizedMetadata.targetPaths];
    }
    if (
      normalizedMetadata.allowTargetedReadInspection === true
      && !Array.isArray(normalizedMetadata.allowedReadPaths)
      && Array.isArray(normalizedMetadata.targetPaths)
    ) {
      normalizedMetadata.allowedReadPaths = Array.from(new Set([
        ...normalizedMetadata.targetPaths,
        ...(Array.isArray(normalizedMetadata.allowedOptionalPaths) ? normalizedMetadata.allowedOptionalPaths : []),
      ]));
    }
    const bodyParts = parts.filter(Boolean);
    if (
      normalizedMetadata.allowTargetedReadInspection === true
      && Array.isArray(normalizedMetadata.allowedReadPaths)
      && normalizedMetadata.allowedReadPaths.length > 0
    ) {
      bodyParts.push(
        `Phase-specific exception: if one narrow inspection pass is necessary before rewriting, read_file is allowed only for these exact paths and at most once per path: ${normalizedMetadata.allowedReadPaths.join(', ')}. Do not read any other path.`,
      );
    }
    return createContinueInstruction(
      bodyParts.join(' '),
      {
        strategy: 'database_lab_scaffold',
        ...normalizedMetadata,
      },
    );
  }

  function buildDatabaseLabFinalizationInstruction(producedFiles) {
    const outputKeys = parseOutputContractKeys(spec);
    const normalizedProducedFiles = Array.from(new Set(
      (Array.isArray(producedFiles) ? producedFiles : [])
        .filter((relativePath) => typeof relativePath === 'string' && relativePath.trim().length > 0)
        .sort((left, right) => left.localeCompare(right)),
    ));
    const producedFilesJson = JSON.stringify(normalizedProducedFiles);
    const detailsText = [
      `The design package under ${DATABASE_LAB_ROOT}/ is complete.`,
      'The design docs, prototype scaffold, and quality manifest were written successfully.',
      `A real benchmark self-check already passed from ${DATABASE_LAB_PROTOTYPE_DIR} via npm.cmd run bench -- --dry-run.`,
      'Describe verified prototype behavior separately from unproven MySQL-nearness claims.',
    ].join(' ');
    return buildDatabaseLabContinueInstruction([
      'Do not emit any tool calls, prose, markdown fences, or extra commentary in this turn.',
      'Return exactly two machine-readable blocks in this order and nothing else: one [AGENT-001_OUTPUT] JSON envelope, then one final tracker JSON object.',
      'Use this exact wrapper pattern with both tags present: [AGENT-001_OUTPUT]{...}[/AGENT-001_OUTPUT].',
      outputKeys.length > 0
        ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`
        : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',
      `Set producedFiles to exactly this real written file list: ${producedFilesJson}.`,
      `Set details to a grounded completion summary like: ${JSON.stringify(detailsText)}.`,
      'Keep issues as [] unless a real unresolved problem still exists.',
      'The final tracker JSON must set current_unit to AGENT-001, status to COMPLETE, progress_percent to 100, decision to CONTINUE, next_unit to null, and files_created to the exact same producedFiles list.',
      'The tracker reason must say that the database design package and benchmark self-check are complete.',
      `The completion summary must not claim measured MySQL parity. Keep that distinction explicit while still marking the real scaffold work as complete.`,
    ], {
      phase: 'finalize',
      phaseCursor: 'complete',
      allowedTools: [],
      allowedPaths: [],
      uniqueKey: 'database_lab:finalize',
    });
  }

  function getDatabaseLabProducedFilesForFinalization() {
    return Array.from(new Set(
      getScenarioWorkspaceFiles(scenarioState)
        .filter((relativePath) => isDatabaseLabDeclarableProducedFile(relativePath))
        .sort((left, right) => left.localeCompare(right)),
    ));
  }

  function isDatabaseLabDeclarableProducedFile(relativePath) {
    if (typeof relativePath !== 'string') {
      return false;
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      normalized === DATABASE_LAB_DESIGN_QUALITY_FILE
      || normalized === DATABASE_LAB_VERIFY_QUALITY_FILE
      || DATABASE_LAB_REQUIRED_DESIGN_FILES.includes(normalized)
      || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`
      || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`
      || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`
    ) {
      return true;
    }
    const prototypeSrcPrefix = `${DATABASE_LAB_PROTOTYPE_DIR}/src/`;
    if (
      normalized.startsWith(prototypeSrcPrefix)
      && normalized.endsWith('.js')
      && !normalized.slice(prototypeSrcPrefix.length).includes('/')
    ) {
      return true;
    }
    const prototypeResultsPrefix = `${DATABASE_LAB_PROTOTYPE_DIR}/results/`;
    if (
      normalized.startsWith(prototypeResultsPrefix)
      && normalized.endsWith('.json')
      && !normalized.slice(prototypeResultsPrefix.length).includes('/')
    ) {
      return true;
    }
    return false;
  }

  const shouldPreferRuntimeEvidenceRepair =
    runtimeRequiredNextEvidence.length > 0
    || (toolExecutionFailure && databaseLabWriteProgressObserved);

  const outcomeFailedChecks = Array.isArray(deterministicAcceptance?.outcome?.failedChecks)
    ? deterministicAcceptance.outcome.failedChecks
    : [];
  const outcomeOnlyNeedsCompleteTracker =
    outcomeFailedChecks.length > 0
    && outcomeFailedChecks.every((entry) => typeof entry === 'string' && entry.startsWith('tracker_not_complete'));
  const deterministicPreconditionsReadyForFinalTracker =
    deterministicAcceptance?.contract?.verdict === 'passed'
    && deterministicAcceptance?.execution?.verdict === 'passed'
    && deterministicAcceptance?.evidence?.verdict === 'passed'
    && (qualityAcceptance?.profileId == null || qualityAcceptance?.verdict === 'passed');
  const trackerOnlyFinalizationNeeded =
    deterministicPreconditionsReadyForFinalTracker
    && (
      (
        runtimeRequiredNextEvidence.length > 0
        && runtimeRequiredNextEvidence.every((entry) => entry === 'emit_complete_progress_tracker_when_work_is_done')
      )
      || outcomeOnlyNeedsCompleteTracker
    );

  if (trackerOnlyFinalizationNeeded) {
    if (spec.id === 'database-near-mysql-design') {
      return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
    }
    return buildTrackerOnlyFinalizationInstruction();
  }

  if (
    shouldPreferRuntimeEvidenceRepair
    && correctionKind === 'AWAITING_TOOL_ACTION'
    && !shouldKeepDatabaseLabPhaseRepair
    && !(
      spec.id === 'database-near-mysql-design'
      && !databaseLabWriteProgressObserved
      && !hasObservedDatabaseBenchRunAttempt(scenarioState)
    )
  ) {
    return buildRuntimeRequiredEvidenceInstruction();
  }

  const shouldFinalizeDatabaseLabDesign =
    spec.id === 'database-near-mysql-design'
    && databaseLabArtifactSatisfied
    && databaseLabBenchSatisfied
    && qualityAcceptance?.verdict === 'passed'
    && deterministicAcceptance?.verdict !== 'passed';

  function buildPathBlogToolPrompt() {
    const externalEntryPath = normalizeSlashes(path.join(targetExternalPath, 'index.html'));
    const externalStylePath = normalizeSlashes(path.join(targetExternalPath, 'styles.css'));
    const externalScriptPath = normalizeSlashes(path.join(targetExternalPath, 'script.js'));
    const hasWorkspaceWebAudit = hasWorkspaceFiles(scenarioState, ['quality/web-audit.json']);
    const webQualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];
    const hasExternalScriptSyntaxFailure = [
      ...webQualityFailedChecks,
      ...invalidOutputErrors,
    ].some((entry) => {
      const normalized = normalizeSlashes(String(entry ?? '')).toLowerCase();
      return normalized.includes('javascript_syntax_error:')
        && normalized.includes('d:/aaa/script.js');
    });
    if (externalBlogWriteSatisfied && hasWorkspaceWebAudit && hasExternalScriptSyntaxFailure) {
      const currentScript = readTextFileIfExists(path.join(targetExternalPath, 'script.js'));
      return createContinueInstruction([
        buildJsonToolCallPrelude(),
        `The delivered blog already exists in ${targetExternalPath}, but the quality gate found JavaScript syntax failure in ${externalScriptPath}.`,
        'Do not rewrite index.html, styles.css, or any quality JSON in this turn.',
        `Emit exactly one write_file tool call for "${targetExternalPath}\\script.js" with complete valid JavaScript content.`,
        'Preserve the intended interactions: theme toggle, mobile navigation, scroll reveal, newsletter submit feedback, and active nav state.',
        `After rewriting the script, emit one run_command tool call with command "node --check ${externalScriptPath}" so the next turn receives real syntax-check evidence.`,
        'End with one tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the syntax check and quality gate pass.',
        currentScript
          ? `Current broken script.js content is embedded below. Repair it directly without reading files again:\n<<<SCRIPT_JS\n${truncateScenarioPromptText(currentScript, 4200)}\nSCRIPT_JS`
          : 'If the current script content is unavailable, still write a complete replacement script for the existing HTML selectors.',
      ].join(' '), {
        strategy: 'path_blog_script_syntax_repair',
        phase: 'web_script_syntax_repair',
        uniqueKey: `${spec.id}:script-syntax-repair`,
        allowedTools: ['write_file', 'run_command'],
        allowedPaths: [
          normalizeSlashes(path.join(targetExternalPath, 'script.js')),
          `${targetExternalPath}\\script.js`,
        ],
        allowedWritePaths: [
          normalizeSlashes(path.join(targetExternalPath, 'script.js')),
          `${targetExternalPath}\\script.js`,
        ],
        forbiddenWritePaths: [
          normalizeSlashes(path.join(targetExternalPath, 'index.html')),
          normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
          normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
          `${targetExternalPath}\\index.html`,
          `${targetExternalPath}\\styles.css`,
          `${targetExternalPath}\\quality\\web-audit.json`,
          'quality/web-audit.json',
        ],
      });
    }
    if (externalBlogWriteSatisfied && !hasWorkspaceWebAudit) {
      return createContinueInstruction([
        buildJsonToolCallPrelude(),
        'The external blog files already exist. Do not rewrite D:/AAA/index.html, styles.css, or script.js in this turn.',
        'Emit exactly one write_file tool call with arguments.path set to the relative task-workspace path "quality/web-audit.json".',
        'Do not create or write D:/AAA/quality/web-audit.json. The quality evidence file belongs in the task workspace, not the delivered website folder.',
        `The JSON content must include profile "web_experience", artifactKind "static_site", entryFiles ["${externalEntryPath}"], supportingFiles ["${externalStylePath}", "${externalScriptPath}"], interactionSelectors, and brandingTitle.`,
        'End with one tracker JSON using status IN_PROGRESS and decision CONTINUE.',
      ].join(' '), {
        strategy: 'path_blog_quality_evidence',
        phase: 'web_audit_repair',
        uniqueKey: `${spec.id}:web-audit-workspace`,
        allowedTools: ['write_file'],
        allowedPaths: ['quality/web-audit.json'],
        allowedWritePaths: ['quality/web-audit.json'],
        forbiddenWritePaths: [
          normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
          `${targetExternalPath}\\quality\\web-audit.json`,
        ],
      });
    }
    return createContinueInstruction([
      buildJsonToolCallPrelude(),
      'Use real external-path writes for the website files, not workspace writes.',
      `Emit one create_folder for "${targetExternalPath}" only if it does not already exist.`,
      `Then emit one write_file for each of "${targetExternalPath}\\index.html", "${targetExternalPath}\\styles.css", and "${targetExternalPath}\\script.js" with full file contents.`,
      'Also emit one write_file with arguments.path exactly "quality/web-audit.json" in the task workspace.',
      'Do not create or write D:/AAA/quality/web-audit.json; that is the wrong location for quality evidence.',
      'The workspace quality JSON must include profile, artifactKind, entryFiles, supportingFiles, interactionSelectors, and brandingTitle.',
      `Set entryFiles to ["${externalEntryPath}"] and supportingFiles to ["${externalStylePath}", "${externalScriptPath}"].`,
      'The next turn can summarize only after those write_file calls succeed.',
    ].join(' '), {
      strategy: 'path_blog_delivery',
      phase: 'path_blog_delivery',
      uniqueKey: `${spec.id}:path-blog-delivery`,
      allowTargetedReadInspection: true,
      allowedTools: ['create_folder', 'write_file', 'read_file', 'list_files', 'search_files'],
      allowedPaths: [
        normalizeSlashes(path.join(targetExternalPath, 'index.html')),
        normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
        normalizeSlashes(path.join(targetExternalPath, 'script.js')),
        `${targetExternalPath}\\index.html`,
        `${targetExternalPath}\\styles.css`,
        `${targetExternalPath}\\script.js`,
        'quality/web-audit.json',
      ],
      allowedReadPaths: [
        normalizeSlashes(path.join(targetExternalPath, 'index.html')),
        normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
        normalizeSlashes(path.join(targetExternalPath, 'script.js')),
        `${targetExternalPath}\\index.html`,
        `${targetExternalPath}\\styles.css`,
        `${targetExternalPath}\\script.js`,
      ],
      allowedWritePaths: [
        normalizeSlashes(path.join(targetExternalPath, 'index.html')),
        normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
        normalizeSlashes(path.join(targetExternalPath, 'script.js')),
        `${targetExternalPath}\\index.html`,
        `${targetExternalPath}\\styles.css`,
        `${targetExternalPath}\\script.js`,
        'quality/web-audit.json',
      ],
      forbiddenWritePaths: [
        normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
        `${targetExternalPath}\\quality\\web-audit.json`,
      ],
    });
  }

  function buildDocsNormalizeToolPrompt() {
    const missingDocs = getMissingWorkspaceFiles(scenarioState, DOCS_NORMALIZE_REQUIRED_FILES);
    const traceMissing = !hasWorkspaceFiles(scenarioState, ['quality/docs-normalize-trace.json']);
    const sourceAlreadyRead = countSuccessfulReadActivities(scenarioState, /^incoming\//i) >= 3;
    const ungroundedTraceOutputs = invalidOutputErrors
      .filter((entry) => entry.startsWith('quality_gate_failed:trace_not_grounded:'))
      .map((entry) => entry.split('quality_gate_failed:trace_not_grounded:')[1])
      .filter(Boolean);
    const lostPhrasingOutputs = invalidOutputErrors
      .filter((entry) => entry.startsWith('quality_gate_failed:output_lost_source_phrasing:'))
      .map((entry) => entry.split('quality_gate_failed:output_lost_source_phrasing:')[1])
      .filter(Boolean);
    const missingMarkdownCrossLinks = invalidOutputErrors.includes('quality_gate_failed:docs_normalize_missing_markdown_cross_references')
      || invalidOutputErrors.includes('quality_gate_failed:docs_normalize_index_missing_links')
      || invalidOutputErrors.includes('quality_gate_failed:missing_docs_normalize_index');
    const targetedRepairOutputs = Array.from(new Set([
      ...ungroundedTraceOutputs,
      ...lostPhrasingOutputs,
    ]));
    if (targetedRepairOutputs.length > 0) {
      const sourceFiles = Array.from(new Set(targetedRepairOutputs.flatMap((entry) => getSourceFilesForDocsNormalizeOutput(entry))));
      const sourceBlocks = buildEmbeddedSourceBlocks(scenarioState, sourceFiles);
      return [
        buildWriteOnlyRepairPrelude([...targetedRepairOutputs, 'quality/docs-normalize-trace.json']),
        `The docs_normalize quality gate is still failing for these exact outputs: ${targetedRepairOutputs.join(', ')}.`,
        `The needed source files are already known from earlier successful reads: ${sourceFiles.join(', ')}.`,
        `Repair these exact normalized files in the same turn: ${targetedRepairOutputs.join(', ')}.`,
        'Then rewrite the entire quality/docs-normalize-trace.json in the same turn so every mapping reflects the repaired files and uses fresh verbatim sourceSnippets[].',
        'The needed source excerpts are embedded below. Do not emit read_file in this turn.',
        'Every repaired normalized file must stay within source-backed facts and headings. If a current bullet is unsupported by the source excerpt, delete it instead of broadening it.',
        'Do not invent Q1/Q2 plans, launch dates, metrics, team sizes, dashboards, collaboration features, accessibility claims, offline support, or analytics requirements unless those exact details appear in the cited source file.',
        'Every mappings[].sourceSnippets[] entry must be copied verbatim from the cited source file. Do not paraphrase, broaden, or synthesize extra details.',
        'At least one sourceSnippets[] entry for each mapping must also appear verbatim in the rewritten output file. Preserve original casing and wording from the source instead of title-casing or broad paraphrase.',
        'Use real markdown links such as [Content Roadmap](content-roadmap.md) or [Product Notes](product-notes.md) when a normalized file needs a cross-reference. Plain text like "related to content-roadmap" does not satisfy the cross-reference requirement.',
        'Never use a file name or path as a sourceSnippets[] entry. Strings like "raw-product-notes.md", "content-roadmap draft.md", or "launch-retro.MD" are invalid snippets.',
        'For normalized/index.md, keep only short grounded cross-references that reuse exact phrases from the source files. Delete generic labels such as feature specifications, editorial calendar, delivery timeline, lessons learned, or action items when those exact phrases are absent from source.',
        'Keep outputFile values aligned with the repaired normalized/*.md files.',
        ...sourceBlocks,
      ].join(' ');
    }
    if (missingDocs.length === 0 && missingMarkdownCrossLinks) {
      return [
        buildWriteOnlyRepairPrelude([...DOCS_NORMALIZE_REQUIRED_FILES, 'quality/docs-normalize-trace.json']),
        'The normalized files and trace exist, but the docs_normalize quality gate still requires real markdown cross-links.',
        'Do not emit read_file in this turn. Repair only normalized/index.md, normalized/product-notes.md, normalized/content-roadmap.md, normalized/launch-retro.md, and quality/docs-normalize-trace.json.',
        'normalized/index.md must link to every sibling normalized markdown file.',
        'At least two normalized markdown files must contain real sibling markdown links such as [Content Roadmap](content-roadmap.md) or [Product Notes](product-notes.md).',
        'Plain text mentions like "related to content-roadmap" are not enough.',
        'Keep all source-backed wording grounded and rewrite quality/docs-normalize-trace.json so its mappings still match the repaired outputs and use exact sourceSnippets[].',
      ].join(' ');
    }
    if (missingDocs.length === 0 && traceMissing) {
      return [
        buildWriteOnlyRepairPrelude(['quality/docs-normalize-trace.json']),
        'The normalized Markdown files already exist under normalized/. Do not spend another turn re-reading the whole incoming/ folder.',
        'Do not emit read_file in this turn. Emit the missing quality/docs-normalize-trace.json write_file now.',
        'Write quality/docs-normalize-trace.json with mappings[]. Each mapping must contain sourceFile, outputFile, and sourceSnippets[] copied exactly from the real incoming files.',
        'Each mapping must point to one of normalized/index.md, normalized/product-notes.md, normalized/content-roadmap.md, or normalized/launch-retro.md.',
        'Do not use template placeholders such as Feature 1 or Requirement A.',
      ].join(' ');
    }
    return [
      buildJsonToolCallPrelude(),
      sourceAlreadyRead
        ? 'The source files under incoming/ were already read successfully in this thread. Do not repeat broad read_file calls on incoming/ before writing.'
        : 'First read incoming/raw-product-notes.md, incoming/content-roadmap draft.md, and incoming/launch-retro.MD.',
      'Use create_folder for normalized/ and quality/ if needed.',
      `Create or repair these exact documentation files: ${(missingDocs.length > 0 ? missingDocs : DOCS_NORMALIZE_REQUIRED_FILES).join(', ')}.`,
      traceMissing
        ? 'Also write quality/docs-normalize-trace.json with mappings containing sourceFile, outputFile, and exact sourceSnippets[] from the real incoming files.'
        : 'Keep quality/docs-normalize-trace.json consistent with the written normalized files.',
      'normalized/index.md must link to every sibling normalized markdown file, and at least two normalized markdown files must contain real sibling markdown links.',
      'Each normalized output must preserve concrete source wording instead of Feature 1 or Requirement A placeholders.',
      'The next turn can summarize only after the required write_file calls succeed.',
    ].join(' ');
  }

  function buildDocsSynthesizeToolPrompt() {
    const missingDocs = getMissingWorkspaceFiles(scenarioState, DOCS_SYNTHESIZE_REQUIRED_FILES);
    const traceMissing = !hasWorkspaceFiles(scenarioState, ['quality/docs-synthesize-trace.json']);
    const sourceAlreadyRead = countSuccessfulReadActivities(scenarioState, /^source\//i) >= 3;
    const missingGroundingClaims = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:claim_missing_source_grounding:'));
    const missingOutputClaims = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:claim_missing_from_output:'));
    const missingGroundingEvidence = invalidOutputErrors.filter((entry) => entry.startsWith('quality_required_evidence:add grounded sourceSnippets for '));
    if (missingGroundingClaims.length > 0 || missingOutputClaims.length > 0 || missingGroundingEvidence.length > 0) {
      const groundedTargets = Array.from(new Set([
        ...missingGroundingClaims.map((entry) => entry.split('quality_gate_failed:claim_missing_source_grounding:')[1]),
        ...missingOutputClaims.map((entry) => entry.split('quality_gate_failed:claim_missing_from_output:')[1]),
      ].filter(Boolean)));
      const sourceBlocks = buildEmbeddedSourceBlocks(scenarioState, [
        'source/product-strategy.md',
        'source/ops-decisions.md',
        'source/editorial-feedback.md',
      ]);
      return [
        buildWriteOnlyRepairPrelude([
          ...(groundedTargets.length > 0 ? groundedTargets : ['handbook/README.md', 'handbook/summary.md', 'handbook/decision-log.md']),
          'quality/docs-synthesize-trace.json',
        ]),
        `Repair these handbook files so every claim is grounded in source wording: ${groundedTargets.join(', ') || 'handbook/README.md, handbook/summary.md, handbook/decision-log.md'}.`,
        'Delete unsupported claims instead of trying to justify them. If a claim is not explicitly present in source/, remove it from both the handbook output and the trace JSON.',
        'Do not leave generic abstractions such as "strategy direction set", "operational approach chosen", or "editorial refinements applied" unless those exact phrases exist in source/.',
        'Do not mention project management tools, PostgreSQL, AWS, SSO, team sizes, MVP dates, reporting dashboards, automated PR testing gates, or any other noun phrase that does not appear in the source excerpts below.',
        'Rewrite the handbook files to preserve concrete source phrases and constraints from source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',
        'Then rewrite quality/docs-synthesize-trace.json so each claim includes sourceSnippets[] copied verbatim from the cited source file.',
        'Every claimText in quality/docs-synthesize-trace.json must also appear verbatim in the corresponding handbook outputFile.',
        'Prefer short grounded summaries over broad synthesized prose. Every handbook claim must stay traceable to real source bullets or lines.',
        ...sourceBlocks,
      ].join(' ');
    }
    if (missingDocs.length === 0 && traceMissing) {
      return [
        buildWriteOnlyRepairPrelude(['quality/docs-synthesize-trace.json']),
        'The handbook Markdown files already exist under handbook/. Do not spend another turn re-reading the whole source/ folder.',
        'Do not emit read_file in this turn. Emit the missing quality/docs-synthesize-trace.json write_file now.',
        'Write quality/docs-synthesize-trace.json with claims[]. Each claim must include outputFile, claimText, sourceFile, and sourceSnippets[] copied exactly from the cited source file.',
        'Every summary or decision claim must be grounded in cited source text, not generic enterprise wording.',
      ].join(' ');
    }
    return [
      buildJsonToolCallPrelude(),
      sourceAlreadyRead
        ? 'The source files under source/ were already read successfully in this thread. Do not repeat broad read_file calls on source/ before writing.'
        : 'First read source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',
      'Use create_folder for handbook/ and quality/ if needed.',
      `Create or repair these exact handbook files: ${(missingDocs.length > 0 ? missingDocs : DOCS_SYNTHESIZE_REQUIRED_FILES).join(', ')}.`,
      traceMissing
        ? 'Also write quality/docs-synthesize-trace.json with grounded claims for the handbook outputs.'
        : 'Keep quality/docs-synthesize-trace.json aligned with the real handbook outputs.',
      'Every summary or decision claim must be grounded in cited source text, not generic enterprise wording.',
      'The next turn can summarize only after successful write_file evidence exists.',
    ].join(' ');
  }

  function buildSystemAuditToolPrompt() {
    const systemAuditCoverage = getSystemAuditRunEvidenceCoverage(scenarioState);
    const successfulRunIds = systemAuditCoverage.successfulRunIds.slice(-6);
    const reportsMissing = getMissingWorkspaceFiles(scenarioState, SYSTEM_AUDIT_REQUIRED_FILES);
    const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];
    const evidenceFailures = invalidOutputErrors.filter((entry) => /^quality_gate_failed:(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry));
    const reportFailures = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:report_missing_fact:'));
    const invalidJsonFailures = qualityFailedChecks.filter((entry) => entry === 'invalid_system_audit_json');
    const fileRepairFailures = qualityFailedChecks.filter((entry) => /^missing_system_audit_(report|report_file|facts)$/i.test(entry));
    const targetedFamilies = Array.from(
      new Set([
        ...systemAuditCoverage.missingFamilies,
        ...getSystemAuditFamiliesFromFailures(evidenceFailures),
        ...getSystemAuditFamiliesFromFailures(qualityFailedChecks.filter((entry) => /^(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry))),
      ]),
    );
    if (successfulRunIds.length > 0 && targetedFamilies.length > 0) {
      const familyExcerpts = targetedFamilies
        .map((family) => systemAuditCoverage.latestByFamily[family])
        .filter(Boolean)
        .map((invocationId) => buildToolInvocationResultExcerpt(scenarioState, invocationId))
        .filter(Boolean);
      const familyInstructions = [];
      if (targetedFamilies.includes('memory')) {
        familyInstructions.push('Run one command that prints TotalPhysicalMemoryMb and FreePhysicalMemoryMb in plain text using Get-CimInstance Win32_OperatingSystem with PowerShell-calculated MB fields and Format-List. Win32_OperatingSystem memory fields are already in KB, so convert to MB by dividing by 1024, not by 1MB.');
      }
      if (targetedFamilies.includes('cpu')) {
        familyInstructions.push('Run one command that prints NumberOfCores, NumberOfLogicalProcessors, and MaxClockSpeed in plain text using Get-CimInstance Win32_Processor | Select-Object -First 1 ... | Format-List.');
      }
      if (targetedFamilies.includes('disk')) {
        familyInstructions.push('Run one command that prints DeviceID, FreeSpaceGb, and SizeGb for drive C: in plain text using Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'" | Select-Object DeviceID, @{N=\'FreeSpaceGb\';E={[math]::Round($_.FreeSpace/1GB,2)}}, @{N=\'SizeGb\';E={[math]::Round($_.Size/1GB,2)}} | Format-List.');
      }
      return [
        buildJsonToolCallPrelude(),
        `Successful host-observation invocation ids already exist in this thread: ${successfulRunIds.join(', ')}.`,
        systemAuditCoverage.missingFamilies.length > 0
          ? `Required fact coverage is incomplete. Missing command groups: ${systemAuditCoverage.missingFamilies.join(', ')}.`
          : `Existing command evidence does not satisfy these fact families: ${targetedFamilies.join(', ')}.`,
        ...familyExcerpts,
        'Emit fresh Windows-only run_command JSON tool objects now. Do not use uname, free, df, cat /proc, systeminfo fallback chains, or wmic.',
        'Do not emit write_file yet. First repair the missing or failed host-evidence command groups below.',
        ...familyInstructions,
        'After memory, cpu, and disk evidence all exist as successful run_command invocations in this thread, then emit write_file for reports/system-health.md and quality/system-audit.json.',
        'Use fresh sourceInvocationId values from the new successful commands. sourceRegex values must match the new field names exactly, such as TotalPhysicalMemoryMb, FreePhysicalMemoryMb, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, FreeSpaceGb, and SizeGb.',
        'reportedValue must equal the numeric value observed in the cited command output. Do not estimate or silently convert units unless the command output already uses that unit. For Win32_OperatingSystem memory fields, the command must print MB by dividing the KB source values by 1024.',
        `Repair these exact quality failures: ${[...evidenceFailures, ...qualityFailedChecks.filter((entry) => /^(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry))].join('; ') || 'system audit evidence coverage is incomplete'}.`,
      ].filter(Boolean).join(' ');
    }
    if (successfulRunIds.length > 0 && systemAuditCoverage.missingFamilies.length === 0 && (reportsMissing.length > 0 || reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0)) {
      return [
        buildWriteOnlyRepairPrelude([
          ...(reportsMissing.includes('reports/system-health.md') || reportFailures.length > 0 || fileRepairFailures.includes('missing_system_audit_report_file') ? ['reports/system-health.md'] : []),
          ...(reportsMissing.includes('quality/system-audit.json') || reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0 ? ['quality/system-audit.json'] : []),
        ]),
        `You already have successful host-observation evidence in this thread from invocation ids: ${successfulRunIds.join(', ')}.`,
        'Do not emit run_command or broad read_file calls in this turn. The required memory, cpu, and disk evidence already exists, so emit only write_file calls now.',
        ...(reportsMissing.includes('reports/system-health.md')
          ? ['Write or repair reports/system-health.md with grounded findings and practical recommendations tied to those real command results.']
          : []),
        ...(reportsMissing.includes('quality/system-audit.json') || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0
          ? ['Write or repair quality/system-audit.json with reportFile, facts[], sourceInvocationId, and sourceRegex or sourceContains values that match the successful command output. The file must be valid JSON, and every backslash inside sourceRegex must be escaped so JSON.parse succeeds.']
          : []),
        reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0
          ? `Repair these exact quality failures in the rewritten report or quality JSON: ${[...reportFailures, ...invalidJsonFailures, ...fileRepairFailures].join('; ')}.`
          : null,
      ].join(' ');
    }
    return [
      buildJsonToolCallPrelude(),
      'Use direct PowerShell command text, not nested "powershell -Command".',
      'Do not use Linux-only commands such as uname, free, df, ps, or cat /proc on this Windows host.',
      'Do not use systeminfo fallback chains or wmic. Use Windows PowerShell / Get-CimInstance commands only.',
      'Run real Windows host-observation commands first, and do not use write_file until all three evidence families exist: memory, cpu, and disk.',
      'Emit JSON run_command tool objects for three command groups: (1) Win32_OperatingSystem with TotalPhysicalMemoryMb and FreePhysicalMemoryMb printed via Format-List after converting the Win32 KB values to MB by dividing by 1024, (2) Win32_Processor with NumberOfCores, NumberOfLogicalProcessors, and MaxClockSpeed via Format-List, and (3) Win32_LogicalDisk for C: with FreeSpaceGb and SizeGb via Format-List.',
      'The quality JSON must include reportFile, facts[], sourceInvocationId, and sourceRegex or sourceContains values that match the successful command output.',
      'quality/system-audit.json must be valid JSON. Escape backslashes inside sourceRegex values, for example use "\\\\s" instead of "\\s".',
      'reportedValue must match the exact observed numeric value from the cited command output. If the fact name says _mb, make the command output print MB first instead of converting silently in the report. For Win32_OperatingSystem memory fields, never divide by 1MB; divide the KB values by 1024.',
      'The next turn can summarize after successful command and write_file evidence exists.',
    ].join(' ');
  }

  function buildDesktopObservationToolPrompt() {
    const successfulRunIds = getRecentSuccessfulInvocationIds(scenarioState, 'run_command', 6);
    const blockedCommands = getFailedToolActivitiesById(scenarioState, 'run_command')
      .filter((activity) => /blocked by the builtin run_command safety policy/i.test(activity?.detail ?? ''))
      .map((activity) => activity?.argumentsSummary ?? '')
      .filter(Boolean);
    const reportRepairNeeded = invalidOutputErrors.some((entry) => /quality_gate_failed:(report_missing_(?:fact|observation)|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch|missing_desktop_observations|invalid_desktop_observation_json):/i.test(entry));
    if (hasDesktopObservationEvidence(scenarioState) && successfulRunIds.length > 0) {
      return [
        buildWriteOnlyRepairPrelude(['reports/desktop-observation.md', 'quality/desktop-observation.json']),
        `You already have successful desktop-observation evidence in this thread from invocation ids: ${successfulRunIds.join(', ')}.`,
        'Do not emit run_command or broad read_file calls in this turn unless a required desktop/application observation is still completely missing. Use the existing evidence and emit write_file for reports/desktop-observation.md and quality/desktop-observation.json now.',
        'The quality JSON must contain observations[] with sourceInvocationId mappings that cite the real run_command invocation ids.',
        reportRepairNeeded
          ? `Repair these exact quality failures in the rewritten report or quality JSON: ${invalidOutputErrors.join('; ')}.`
          : null,
      ].join(' ');
    }
    return [
      buildJsonToolCallPrelude(),
      'Use direct PowerShell command text, not nested "powershell -Command".',
      'Use commands that still succeed when some applications are absent.',
      ...(blockedCommands.length > 0
        ? [`Do not repeat blocked commands such as: ${blockedCommands.slice(0, 2).join(' ; ')}.`]
        : []),
      'Do not use Linux-only commands such as uname on this Windows host.',
      'Example objects:',
      '{"tool":"run_command","command":"Get-Process | Where-Object { $_.ProcessName -in @(\'explorer\',\'Code\',\'msedge\',\'chrome\') } | Select-Object -First 10 ProcessName,Responding,CPU,WS,MainWindowTitle","timeout_ms":30000}',
      '{"tool":"run_command","command":"Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 10 ProcessName,MainWindowTitle,Responding","timeout_ms":30000}',
      '{"tool":"run_command","command":"Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 ProcessName,Id,CPU,WS,MainWindowTitle","timeout_ms":30000}',
      'After successful commands exist, emit write_file for reports/desktop-observation.md and quality/desktop-observation.json with observations[] mappings that cite the real invocation ids.',
      'quality/desktop-observation.json must remain valid JSON; escape backslashes inside sourceRegex values.',
      'Use observation names tied to real desktop/application evidence, such as visible_window_processes, responding_desktop_processes, or top_processes_with_window_titles. Do not invent memory, CPU, or disk facts for this desktop follow-up.',
      'The next turn can summarize after successful command evidence exists.',
    ].join(' ');
  }

  function buildDatabaseLabScaffoldPrompt() {
    const effectiveModelId =
      debug?.executionSummary?.providerSummary?.modelId
      ?? process.env.XIAOMI_MIMO_LIVE_MODEL
      ?? XIAOMI_MIMO_FAST_MODEL;
    const strongModelScaffold = isStrongDatabaseLiveModel(effectiveModelId);
    const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
    const existingDesignDocCount = DATABASE_LAB_REQUIRED_DESIGN_FILES
      .filter((relativePath) => workspaceFiles.includes(relativePath))
      .length;
    const designDocBatchSize = strongModelScaffold ? DATABASE_LAB_REQUIRED_DESIGN_FILES.length : 1;
    const prototypeTopLevelBatchSize = strongModelScaffold ? 3 : 1;
    const prototypeModuleBatchSize = strongModelScaffold ? DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.length : 1;
    const missingDesignFiles = getMissingWorkspaceFiles(scenarioState, DATABASE_LAB_REQUIRED_DESIGN_FILES);
    const nextDesignDocTargets = getDatabaseLabNextDesignDocTargets(scenarioState, designDocBatchSize);
    const existingPrototypeSrcFiles = workspaceFiles
      .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
    const missingPrototypeFiles = getMissingWorkspaceFiles(scenarioState, DATABASE_LAB_REQUIRED_PROTOTYPE_FILES);
    const nextPrototypeTopLevelTargets = getDatabaseLabNextPrototypeTopLevelTargets(scenarioState, prototypeTopLevelBatchSize)
      .slice(0, prototypeTopLevelBatchSize);
    const benchRequiredModuleFiles = getScenarioBenchRequiredModuleFiles(scenarioState, {
      fallbackToDefaultWhenEmpty: !hasWorkspaceFiles(scenarioState, [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),
      includeCoreModuleBaseline: true,
    });
    const missingBenchDependencyModules = benchRequiredModuleFiles.length > 0
      ? getMissingWorkspaceFiles(scenarioState, benchRequiredModuleFiles)
      : [];
    const nextPrototypeModuleTargets = (
      missingBenchDependencyModules.length > 0
        ? missingBenchDependencyModules
        : getDatabaseLabNextPrototypeModuleTargets(scenarioState, prototypeModuleBatchSize, benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)
    ).slice(0, prototypeModuleBatchSize);
    const prototypeNeedsMoreDepth = existingPrototypeSrcFiles.length < 2 || missingBenchDependencyModules.length > 0;
    const qualityFileMissing = !hasWorkspaceFiles(scenarioState, [DATABASE_LAB_DESIGN_QUALITY_FILE]);
    const briefAlreadyRead = countSuccessfulReadActivities(scenarioState, /^brief\//i) >= 3;
    const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];
    const shallowModuleChecks = qualityFailedChecks.filter((entry) =>
      entry.startsWith('module_too_shallow:')
      || entry.startsWith('stub_module:')
      || entry.startsWith('manifest_references_missing_implemented_module:')
    );
    const shallowModuleTargets = shallowModuleChecks
      .map((entry) => entry.split(':').slice(1).join(':'))
      .filter((value) => typeof value === 'string' && value.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
    const benchmarkMetricKeysRepairNeeded =
      invalidOutputErrors.includes('quality_gate_failed:benchmark_scaffold_missing_required_metric_keys')
      || qualityFailedChecks.includes('benchmark_scaffold_missing_required_metric_keys');
    const manifestMissing =
      invalidOutputErrors.includes('quality_gate_failed:missing_database_design_manifest')
      || qualityFailedChecks.includes('missing_database_design_manifest');
    const implementedModulesInsufficient =
      invalidOutputErrors.includes('quality_gate_failed:insufficient_implemented_modules')
      || qualityFailedChecks.includes('insufficient_implemented_modules');
    const manifestReferenceRepairChecks = qualityFailedChecks.filter((entry) =>
      entry.startsWith('manifest_references_missing_file:')
      || entry.startsWith('manifest_references_missing_implemented_module:')
    );
    const manifestReferenceRepairTargets = manifestReferenceRepairChecks
      .map((entry) => entry.split(':').slice(1).join(':'))
      .filter(Boolean);
    const benchNotWiredToPrototypeModules = hasWorkspaceFiles(scenarioState, [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`])
      && existingPrototypeSrcFiles.length > 0
      && benchRequiredModuleFiles.length === 0;
    const successfulBenchRunSatisfied = hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
    const latestBenchFailure = getLatestDatabaseBenchRunFailure(scenarioState);
    const packageEntryDiagnostics = getDatabaseLabPackageEntryDiagnostics(scenarioState.workspaceDir);
    const prototypeCodeDiagnostics = getDatabaseLabPrototypeCodeDiagnostics(scenarioState);
    const existingDesignDocFiles = getDatabaseLabExistingDesignFiles(scenarioState);
    const artifactProgress = buildDatabaseArtifactProgress(workspaceFiles, {
      benchRequiredModuleFiles,
      packageEntryDiagnostics,
      scenarioId: spec.id,
    });
    const benchmarkSelfCheckAttempted = artifactProgress?.benchmarkSelfCheck?.attempted === true;
    const brokenPackageEntryRefs = Array.isArray(packageEntryDiagnostics.missingEntryRefs)
      ? packageEntryDiagnostics.missingEntryRefs
      : [];
    const blockingPackageEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
      scenarioId: spec.id,
    });
    const missingRequiredPackageEntries = Array.isArray(packageEntryDiagnostics.missingRequiredEntries)
      ? packageEntryDiagnostics.missingRequiredEntries
      : [];
    const manifestRepairNeeded =
      qualityFileMissing
      || manifestMissing
      || implementedModulesInsufficient
      || manifestReferenceRepairChecks.length > 0;
    const benchmarkSelfCheckFailureSignalsPresent =
      latestBenchFailure !== null
      || qualityFailedChecks.includes('benchmark_self_check_failed')
      || qualityFailedChecks.includes('benchmark_self_check_output_invalid')
      || qualityFailedChecks.includes('benchmark_self_check_stale')
      || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_failed')
      || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_output_invalid')
      || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_stale');
    const benchmarkSelfCheckObservedInThread = hasObservedDatabaseBenchRunAttempt(scenarioState);
    const benchmarkSelfCheckObserved =
      benchmarkSelfCheckAttempted
      || benchmarkSelfCheckFailureSignalsPresent
      || benchmarkSelfCheckObservedInThread;
    const prototypeCodeRepairTargets = Array.from(new Set([
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) => entry.startsWith('javascript_syntax_error:'))
        .map((entry) => entry.split(':').slice(1).join(':'))
        .filter(Boolean),
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) => entry.startsWith('undeclared_node_builtin:'))
        .map((entry) => entry.split(':').slice(1, 2).join(':'))
        .filter(Boolean),
      ...(prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch')
        ? [
          `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...benchRequiredModuleFiles,
        ]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
        : []),
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) => entry.startsWith('bench_module_export_mismatch:'))
        .flatMap((entry) => {
          const relativePath = entry.split(':').slice(1).join(':');
          return relativePath ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, relativePath] : [];
        }),
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) => entry.startsWith('bench_module_export_name_mismatch:') || entry.startsWith('bench_module_api_mismatch:'))
        .flatMap((entry) => {
          const relativePath = entry.split(':').slice(1, 2).join(':');
          return relativePath ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, relativePath] : [];
        }),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.some((entry) =>
        entry.startsWith('bench_storage_engine_async_usage_mismatch:')
        || entry === 'bench_storage_engine_open_missing'
        || entry === 'bench_storage_engine_initialize_missing'
        || entry === 'bench_storage_page_size_mismatch'
        || entry === 'bench_storage_table_lifecycle_missing'
        || entry.startsWith('bench_storage_engine_arg_mismatch:')
        || entry.startsWith('bench_storage_engine_table_name_mismatch:')
      )
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))
        ? [
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
        ]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
        : []),
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'))
        .flatMap((entry) => {
          const relativePath = entry.split(':').slice(1, 2).join(':');
          return relativePath
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`, relativePath]
            : [];
        }),
      ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
        ? [
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`,
        ]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))
        ? [
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
        ]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]
        : []),
      ...(benchmarkMetricKeysRepairNeeded
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]
        : []),
    ]));
    const buildPrototypeRepairSourceBlocks = (relativePaths, limit = 6) => buildEmbeddedSourceBlocks(
      scenarioState,
      Array.from(new Set(
        (Array.isArray(relativePaths) ? relativePaths : [])
          .filter((relativePath) => typeof relativePath === 'string' && /\.(?:js|json|md)$/i.test(relativePath))
          .slice(0, limit),
      )),
    );
    const prototypePreBenchmarkDependencyRepairNeeded = prototypeCodeDiagnostics.failedChecks
      .some((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'));
    const prototypePreBenchmarkOutputRepairNeeded =
      prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
      || prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
      || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
      || benchmarkMetricKeysRepairNeeded;
    const corePrototypeReadyForRepair =
      artifactProgress.prototypeModules.completed
      && hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && missingBenchDependencyModules.length === 0;
    const hasFocusedDatabaseRepairSignal =
      corePrototypeReadyForRepair
      && (
        prototypeCodeDiagnostics.failedChecks.length > 0
        || latestBenchFailure !== null
        || successfulBenchRunSatisfied
        || qualityFailedChecks.some((entry) =>
          typeof entry === 'string'
          && !entry.startsWith('missing_core_module:')
          && !entry.startsWith('benchmark_dependency_missing:')
          && entry !== 'insufficient_implemented_modules'
          && entry !== 'missing_database_design_manifest'
        )
        || invalidOutputErrors.some((entry) =>
          typeof entry === 'string'
          && !entry.startsWith('quality_gate_failed:missing_core_module:')
          && !entry.startsWith('quality_gate_failed:benchmark_dependency_missing:')
          && entry !== 'quality_gate_failed:insufficient_implemented_modules'
          && entry !== 'quality_gate_failed:missing_database_design_manifest'
        )
      );
    const prototypeRepairOrBenchmarkReady =
      corePrototypeReadyForRepair || hasFocusedDatabaseRepairSignal;
    const buildPrototypeModulesInstruction = () => {
      const targetPaths = Array.from(new Set(nextPrototypeModuleTargets));
      const deferPackageEntryRepairs = missingBenchDependencyModules.length > 0;
      const deferredPrototypeModulePaths = Array.from(new Set(
        (benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)
          .filter((relativePath) => !targetPaths.includes(relativePath)),
      ));
      const companionPrototypeEntryTargets = (deferPackageEntryRepairs ? [] : blockingPackageEntryRefs)
        .map((entryRef) => getDatabasePrototypePathFromPackageEntryRef(entryRef))
        .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
      const repairPaths = Array.from(new Set([
        ...targetPaths,
        ...companionPrototypeEntryTargets,
        ...(!deferPackageEntryRepairs && blockingPackageEntryRefs.length > 0 ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`] : []),
      ]));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(repairPaths, {
          forbiddenWritePaths: manifestRepairNeeded ? [] : [DATABASE_LAB_DESIGN_QUALITY_FILE],
        }),
        'The design docs and prototype top-level files already exist. Do not rewrite them in this turn.',
        'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',
        `Write only these concrete implementation modules now so ${DATABASE_LAB_PROTOTYPE_DIR}/src/ reaches real runnable depth: ${targetPaths.join(', ')}.`,
        `This batch is selected from the benchmark-critical prototype modules: ${(benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : targetPaths).join(', ')}.`,
        `Use the exact canonical prototype module filenames listed in this batch. Do not substitute legacy aliases such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal.js or ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree.js.`,
        deferredPrototypeModulePaths.length > 0
          ? `Do not rewrite design docs or jump to every remaining src module in one turn. Leave these remaining benchmark-related src files for the next repair pass unless you must touch one to keep the constructor or method contract coherent with the targeted files: ${deferredPrototypeModulePaths.join(', ')}.`
          : 'If you need to touch any other src file beyond this batch, do it only to keep a constructor or method contract coherent with the targeted files.',
        'Each module must contain runnable logic, not placeholders or TODO stubs.',
        'Keep the module APIs simple and directly usable by the benchmark scaffold.',
        `Export each prototype module with named CommonJS bindings, for example module.exports = { StorageEngine }, module.exports = { BufferPool }, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with those named imports.`,
        !deferPackageEntryRepairs && blockingPackageEntryRefs.length > 0
          ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json so these blocking entry refs no longer point at missing files: ${blockingPackageEntryRefs.join(', ')}.`
          : null,
        manifestRepairNeeded
          ? `If runtime acceptance still requires ${DATABASE_LAB_DESIGN_QUALITY_FILE} after this batch, you may also write or repair it in this turn, but only if designFiles, prototypeFiles, and implementedModules match the real files already on disk after the current module writes.`
          : `Do not write ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn. The design manifest belongs to the next phase only, after the core prototype modules are complete and the benchmark self-check succeeds.`,
        'Because this batch lands only part of the remaining core module set, the final tracker must use exactly status IN_PROGRESS and decision CONTINUE. Do not use COMPLETE until every required core module exists and the benchmark self-check has passed.',
      ], {
        phase: 'prototype_modules',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: repairPaths,
        allowedWritePaths: repairPaths,
        forbiddenWritePaths: manifestRepairNeeded ? [] : [DATABASE_LAB_DESIGN_QUALITY_FILE],
        allowedOptionalPaths: manifestRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : [],
        requiredTrackerStatus: 'IN_PROGRESS',
        requiredTrackerDecision: 'CONTINUE',
        uniqueKey: `database_lab:prototype_modules:${repairPaths.join('|')}`,
      });
    };
    if (briefAlreadyRead && !artifactProgress.designDocs.completed) {
      const targetPaths = nextDesignDocTargets;
      const optionalDesignDocPaths = DATABASE_LAB_REQUIRED_DESIGN_FILES
        .filter((relativePath) => !targetPaths.includes(relativePath));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(nextDesignDocTargets),
        'The seeded brief files were already read successfully. Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',
        `Write only this next narrow batch of missing design docs now under ${DATABASE_LAB_DESIGN_DIR}/: ${nextDesignDocTargets.join(', ')}.`,
        missingDesignFiles.length > nextDesignDocTargets.length
          ? `Do not try to finish all remaining design docs in this turn. Leave the remaining files for the next repair pass: ${missingDesignFiles.slice(nextDesignDocTargets.length).join(', ')}.`
          : 'This batch covers all remaining required design docs. If it succeeds, the next turn must continue with prototype top-level files.',
        strongModelScaffold && existingDesignDocCount === 0
          ? 'This is the first design-doc write turn for the strong model. Land the required design corpus now, but do not move into prototype files in this turn.'
          : 'Keep this batch narrow. Land only the listed file contents in this turn.',
        'Ground every claim in the already-read brief files.',
        'Cover only the sections that belong in the targeted file(s). Leave prototype files and the design manifest for later turns.',
        `Do not invent additional design document filenames. Put transaction, concurrency, recovery, index, and SQL notes inside the canonical target files only: ${DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}.`,
        'Do not claim measured MySQL parity. Keep it as a target profile and keep unproven areas explicit.',
      ], {
        phase: 'design_docs',
        phaseCursor: artifactProgress.nextStage,
        targetPaths,
        allowedOptionalPaths: optionalDesignDocPaths,
        uniqueKey: `database_lab:design_docs:${targetPaths.join('|')}`,
      });
    }
    if (briefAlreadyRead && !artifactProgress.prototypeTopLevel.completed) {
      const targetPaths = missingRequiredPackageEntries.length > 0
        ? Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
          ...(workspaceFiles.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`) ? [] : [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),
        ])).slice(0, prototypeTopLevelBatchSize)
        : nextPrototypeTopLevelTargets.length > 0
          ? nextPrototypeTopLevelTargets
          : artifactProgress.prototypeTopLevel.missing
            .filter((entry) => !entry.startsWith('package-entry:'))
            .slice(0, prototypeTopLevelBatchSize);
      const topLevelAllowedOptionalPaths = Array.from(new Set([
        ...(manifestRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : []),
        ...(targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? (benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)
          : []),
      ]));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(targetPaths),
        'The required design docs already exist under database-lab/design/. Do not rewrite them in this turn.',
        'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',
        `Write only this next narrow batch of missing prototype top-level files now under ${DATABASE_LAB_PROTOTYPE_DIR}/: ${targetPaths.join(', ')}.`,
        missingPrototypeFiles.length > targetPaths.length
          ? `Do not try to finish all remaining prototype top-level files in this turn. Leave the remaining files for the next repair pass: ${missingPrototypeFiles.slice(targetPaths.length).join(', ')}.`
          : 'If this batch succeeds, the next turn can continue with the remaining prototype files or src modules.',
        'The prototype package.json must not point main, build, or dry-run at invented files such as src/index.js unless those files are written in the same turn.',
        'package.json must declare either scripts.bench or scripts["dry-run"], and that script must point to a real prototype entrypoint such as node scripts/bench.js.',
        'If package.json declares bench or dry-run scripts, they must reference real prototype files only.',
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`)
          ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, prefer write_file.arguments.content_json so the runtime can pretty-print a real JSON object instead of relying on one large escaped string.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/README.md`)
          ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/README.md, prefer write_file.arguments.content_lines as an array of markdown lines instead of one large escaped string.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, prefer write_file.arguments.content_lines as an array of source lines instead of one giant escaped script string.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? `When ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js imports benchmark-critical modules, use these exact canonical files only: ${DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES.join(', ')}. Do not create or import legacy alias files such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal.js or ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree.js.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? `The dry-run scaffold must exercise the full core prototype module set, not only storage and buffer helpers. Keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with all five canonical runtime modules: ${DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES.join(', ')}.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? `When ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js imports prototype modules, use named CommonJS destructuring that matches module.exports = { ClassName }, for example const { StorageEngine } = require('../src/storage-engine.js'). Do not default-import a module that exports named bindings.`
          : null,
        missingRequiredPackageEntries.length > 0
          ? `Repair these package entry requirements now: ${missingRequiredPackageEntries.join(', ')}.`
          : null,
        'Keep the README honest about what is implemented versus still unproven about MySQL-nearness.',
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? `If you write ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js in this turn, export a dryRun-capable entrypoint that returns top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? 'The bench CLI must print exactly one JSON.stringify(result) payload to stdout for --dry-run. Do not print banner logs, phase logs, or explanatory prose before or after the JSON payload.'
          : null,
        targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
          ? 'Do not aggregate worker results by spread-pushing large latency arrays or using Math.max(...largeArray). Aggregate incrementally so the dry-run scaffold cannot blow the stack.'
          : null,
        manifestRepairNeeded
          ? `If runtime acceptance still requires ${DATABASE_LAB_DESIGN_QUALITY_FILE} after this top-level batch, you may also write or repair it in this turn, but only if it stays honest about the still-missing prototype src modules and matches the real files on disk.`
          : `Do not write ${DATABASE_LAB_DESIGN_QUALITY_FILE} yet. Finish the prototype src module phase first, then write the design manifest in the next phase.`,
      ], {
        phase: 'prototype_top_level',
        phaseCursor: artifactProgress.nextStage,
        targetPaths,
        allowedOptionalPaths: topLevelAllowedOptionalPaths,
        uniqueKey: `database_lab:prototype_top_level:${targetPaths.join('|')}`,
      });
    }
    if (briefAlreadyRead && !artifactProgress.prototypeModules.completed && !prototypeRepairOrBenchmarkReady) {
      return buildPrototypeModulesInstruction();
    }
    if (briefAlreadyRead && artifactProgress.prototypeModules.completed && benchNotWiredToPrototypeModules) {
      const repairPaths = Array.from(new Set([
        `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        ...(brokenPackageEntryRefs.length > 0 ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`] : []),
      ]));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(repairPaths),
        'The prototype source modules already exist, but the current benchmark scaffold is still placeholder-only and does not call them.',
        'Do not emit run_command, read_file, search_files, or list_files in this turn.',
        `Rewrite ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it imports and exercises these real modules: ${existingPrototypeSrcFiles.join(', ')}.`,
        'Remove placeholder-only in-memory store logic. The dry-run benchmark must execute the real prototype module APIs that already exist.',
        `The dryRun result must expose top-level status, summary, and metrics. metrics must include pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`,
        'Aggregate incrementally. Do not spread-push large latency arrays or use Math.max(...largeArray) over worker output.',
        brokenPackageEntryRefs.length > 0
          ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json in the same turn so these broken entry refs are removed or pointed at real files: ${brokenPackageEntryRefs.join(', ')}.`
          : null,
        `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless a module path changed. Keep the next repair focused on the benchmark scaffold itself.`,
      ], {
        phase: 'bench_scaffold_repair',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: repairPaths,
        uniqueKey: `database_lab:bench_scaffold_repair:${repairPaths.join('|')}`,
      });
    }
    if (briefAlreadyRead && manifestRepairNeeded && artifactProgress.prototypeModules.completed && successfulBenchRunSatisfied) {
      const prototypeManifestTargets = Array.from(new Set([
        ...workspaceFiles.filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
      ]));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude([DATABASE_LAB_DESIGN_QUALITY_FILE]),
        'The design docs and prototype scaffold already exist. Do not rewrite them in this turn.',
        'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',
        `Write or repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} now. It must include designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files currently present under database-lab/.`,
        manifestReferenceRepairTargets.length > 0
          ? `Remove or repair these stale manifest references now: ${manifestReferenceRepairTargets.join(', ')}. Do not invent files that are not on disk.`
          : null,
        `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}/: ${existingDesignDocFiles.join(', ') || 'none yet'}. Do not invent extra design files such as indexing.md, transactions.md, wal-recovery.md, or buffer-pool.md unless you actually wrote them in the same turn, which this repair does not allow.`,
        `prototypeFiles must match only the real files currently present under ${DATABASE_LAB_PROTOTYPE_DIR}/: ${prototypeManifestTargets.join(', ') || 'none yet'}.`,
        `implementedModules must point only to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/: ${existingPrototypeSrcFiles.join(', ') || 'none yet'}. Do not claim ${DATABASE_LAB_PROTOTYPE_DIR}/src/engine.js unless that file truly exists on disk.`,
      ], {
        phase: 'design_manifest',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
        uniqueKey: 'database_lab:design_manifest:quality/database-design.json',
      });
    }
    if (briefAlreadyRead && artifactProgress.prototypeModules.completed && successfulBenchRunSatisfied && shallowModuleTargets.length > 0) {
      const shallowBenchModules = shallowModuleTargets.filter((relativePath) => benchRequiredModuleFiles.includes(relativePath));
      const manifestOnlyTargets = shallowModuleTargets.filter((relativePath) => !benchRequiredModuleFiles.includes(relativePath));
      const repairPaths = Array.from(new Set([
        DATABASE_LAB_DESIGN_QUALITY_FILE,
        ...shallowBenchModules,
      ]));
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(repairPaths),
        'The dry-run benchmark already succeeded. Do not rerun it in this turn unless you change database-lab/prototype/scripts/bench.js or one of the benchmark-imported prototype modules.',
        `Repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} now so implementedModules only claims real runtime modules that are non-stub and non-shallow.`,
        manifestOnlyTargets.length > 0
          ? `These cited modules are currently too shallow for implementedModules and are not required by the benchmark import chain: ${manifestOnlyTargets.join(', ')}. If they are only barrel exports or thin wrappers, remove them from implementedModules instead of padding them with filler code.`
          : null,
        shallowBenchModules.length > 0
          ? `These cited modules are benchmark-critical and still too shallow: ${shallowBenchModules.join(', ')}. Expand them into real runnable logic in this turn and keep ${DATABASE_LAB_DESIGN_QUALITY_FILE} aligned with the repaired files.`
          : null,
        'Do not rewrite the design docs or the full scaffold in this turn.',
        'Keep prototypeFiles accurate, but use implementedModules only for the src files that actually contain substantive runnable database behavior.',
        `If ${DATABASE_LAB_DESIGN_QUALITY_FILE} currently lists a shallow index/barrel file such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js, drop it from implementedModules unless you genuinely expand it into real runtime logic in this same turn.`,
      ], {
        phase: 'design_quality_repair',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: repairPaths,
        uniqueKey: `database_lab:design_quality_repair:${repairPaths.join('|')}`,
      });
    }
    if (
      briefAlreadyRead
      && hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && artifactProgress.prototypeModules.completed
      && !successfulBenchRunSatisfied
      && (missingBenchDependencyModules.length === 0 || hasFocusedDatabaseRepairSignal)
    ) {
      const syntaxRepairTargets = Array.from(new Set(
        prototypeCodeDiagnostics.failedChecks
          .filter((entry) => entry.startsWith('javascript_syntax_error:'))
          .map((entry) => entry.split(':').slice(1).join(':'))
          .filter(Boolean),
      ));
      const benchFailureExcerpt = latestBenchFailure
        ? buildToolInvocationResultExcerpt(scenarioState, latestBenchFailure.activityId)
        : null;
      const prototypeModuleSystemMismatch =
        prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch');
      if (!benchmarkSelfCheckObserved && syntaxRepairTargets.length > 0) {
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(syntaxRepairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(syntaxRepairTargets),
          'The current prototype scaffold is blocked by JavaScript syntax errors in files that already exist on disk.',
          `Repair only these syntax-broken files now so they parse as valid CommonJS JavaScript: ${syntaxRepairTargets.join(', ')}.`,
          `Do not emit read_file, list_files, search_files, create_folder, or run_command in this turn. Use the embedded file contents directly and rewrite only the cited files.`,
          ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>
            syntaxRepairTargets.some((relativePath) => entry.includes(relativePath)),
          ),
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Keep constructor signatures, exports, and benchmark-facing method names coherent while you repair syntax. Do not invent new module paths.`,
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files.`,
          'Do not emit run_command in this repair turn. After the syntax errors are fixed, the next turn can continue the narrower prototype contract or benchmark repair flow.',
        ], {
          phase: 'prototype_syntax_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: syntaxRepairTargets,
          allowedOptionalPaths: syntaxRepairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
            ? [DATABASE_LAB_DESIGN_QUALITY_FILE]
            : [],
          uniqueKey: `database_lab:prototype_syntax_repair:${syntaxRepairTargets.join('|')}`,
        });
      }
      if (!benchmarkSelfCheckObserved && prototypeModuleSystemMismatch) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...benchRequiredModuleFiles,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'The benchmark scaffold is blocked by a prototype package and JavaScript module-system mismatch before a meaningful dry-run can execute.',
          `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json and the cited benchmark files so the scaffold uses one coherent module system end-to-end before the next benchmark self-check.`,
          `Prefer CommonJS for this scaffold: remove "type": "module" from ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, keep module.exports in the prototype src files, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js on named require destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`,
          'If you choose ESM instead, then convert every cited file consistently to import/export syntax and keep package scripts pointing at the real entrypoint files. Do not leave a mixed contract.',
          prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
            ? `While repairing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, also instantiate and call the real StorageEngine and BufferPool modules instead of placeholder counter loops. A benchmark that only imports modules but never exercises them is not acceptable.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
            ? `Keep the dryRun result machine-readable with top-level status, summary, and metrics keys after the module-system fix.`
            : null,
          benchmarkMetricKeysRepairNeeded
            ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the result metrics include exactly pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
            : null,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the package and benchmark contract first.`,
          'Do not emit run_command in this repair turn. After the module-system fix lands, the next turn can rerun the dry-run benchmark.',
        ].filter(Boolean), {
          phase: 'bench_module_system_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
            artifactProgress,
            packageEntryDiagnostics,
            scenarioId: spec.id,
          }),
          uniqueKey: `database_lab:bench_module_system_repair:${repairTargets.join('|')}`,
        });
      }
      if (
        !benchmarkSelfCheckObserved
        && !prototypePreBenchmarkDependencyRepairNeeded
        && !prototypePreBenchmarkOutputRepairNeeded
        && prototypeCodeDiagnostics.failedChecks.length === 0
      ) {
        return buildDatabaseLabContinueInstruction([
          buildJsonToolCallPrelude(),
          `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,
          `Do not reread brief/* and do not rewrite the scaffold in this turn.`,
          'Run one real benchmark self-check now before any speculative prototype contract repair.',
          `Run the dry-run benchmark from ${DATABASE_LAB_PROTOTYPE_DIR} and keep the exact stdout/stderr. The next repair turn must use the real command result instead of static guesswork.`,
          prototypeCodeDiagnostics.failedChecks.length > 0
            ? `Static inspection already sees likely prototype issues (${prototypeCodeDiagnostics.failedChecks.join(', ')}), but do not repair them yet in this turn. First capture the real benchmark failure surface.`
            : null,
          'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
          'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
          'If the dry-run fails, keep the exact stderr and do not claim design completion.',
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',
        ], {
          phase: 'benchmark_self_check',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],
          uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',
        });
      }
      if (prototypeCodeDiagnostics.failedChecks.length > 0 && !latestBenchFailure) {
        if (syntaxRepairTargets.length > 0) {
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(syntaxRepairTargets);
          return buildDatabaseLabContinueInstruction([
            buildWriteOnlyRepairPrelude(syntaxRepairTargets),
            'The current prototype scaffold is blocked by JavaScript syntax errors in files that already exist on disk.',
            `Repair only these syntax-broken files now so they parse as valid CommonJS JavaScript: ${syntaxRepairTargets.join(', ')}.`,
            `Do not emit read_file, list_files, search_files, create_folder, or run_command in this turn. Use the embedded file contents directly and rewrite only the cited files.`,
            ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>
              syntaxRepairTargets.some((relativePath) => entry.includes(relativePath)),
            ),
            ...(repairSourceBlocks.length > 0
              ? [
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
                ...repairSourceBlocks,
              ]
              : []),
            `Keep constructor signatures, exports, and benchmark-facing method names coherent while you repair syntax. Do not invent new module paths.`,
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files.`,
            'Do not emit run_command in this repair turn. After the syntax errors are fixed, the next turn can continue the narrower prototype contract or benchmark repair flow.',
          ], {
            phase: 'prototype_syntax_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: syntaxRepairTargets,
            allowedOptionalPaths: syntaxRepairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
              ? [DATABASE_LAB_DESIGN_QUALITY_FILE]
              : [],
            uniqueKey: `database_lab:prototype_syntax_repair:${syntaxRepairTargets.join('|')}`,
          });
        }
        const rowFormatRepairNeeded = prototypeCodeDiagnostics.failedChecks.includes('storage_engine_row_format_mismatch');
        const allPrototypeContractRepairTargets = getPrioritizedDatabasePrototypeRepairTargets(
          prototypeCodeDiagnostics,
          prototypeCodeRepairTargets,
        );
        const prototypeContractRepairBatchSize = prototypeCodeDiagnostics.failedChecks.some((entry) =>
          entry.startsWith('bench_module_')
          || entry.startsWith('bench_buffer_pool_')
          || entry.startsWith('bench_wal_manager_')
          || entry.startsWith('bench_transaction_')
          || entry.includes('_api_mismatch')
          || entry.includes('_missing_method:')
        )
          ? 3
          : 3;
        const prototypeContractRepairTargets = allPrototypeContractRepairTargets.slice(0, prototypeContractRepairBatchSize);
        const prototypeContractInspectionPaths = Array.from(new Set([
          ...prototypeContractRepairTargets,
          ...prototypeCodeDiagnostics.failedChecks
            .filter((entry) =>
              entry.startsWith('bench_module_export_mismatch:')
              || entry.startsWith('bench_module_export_name_mismatch:')
              || entry.startsWith('bench_module_api_mismatch:')
            )
            .map((entry) => entry.split(':').slice(1, 2).join(':'))
            .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),
          ...benchRequiredModuleFiles,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(
          prototypeContractRepairTargets,
          Math.max(3, prototypeContractRepairTargets.length),
        );
        const allowPrototypeContractTargetedReads =
          prototypeContractRepairTargets.length > 0;
        const prototypeContractAllowedOptionalPaths = Array.from(new Set([
          DATABASE_LAB_DESIGN_QUALITY_FILE,
          `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
          ...allPrototypeContractRepairTargets,
        ]));
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(prototypeContractRepairTargets, {
            allowTargetedReads: allowPrototypeContractTargetedReads,
            allowedReadPaths: prototypeContractInspectionPaths,
          }),
          'The design docs, prototype top-level files, and initial src modules already exist. Do not rewrite them broadly in this turn.',
          `Static inspection already found real prototype contract defects: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`,
          `Repair only this next narrow prototype batch now: ${prototypeContractRepairTargets.join(', ')}.`,
          allPrototypeContractRepairTargets.length > prototypeContractRepairTargets.length
            ? `Leave the remaining prototype files for later repair turns after this batch lands: ${allPrototypeContractRepairTargets.filter((relativePath) => !prototypeContractRepairTargets.includes(relativePath)).join(', ')}.`
            : null,
          benchmarkMetricKeysRepairNeeded
            ? `The benchmark scaffold must emit metrics with exactly these numeric keys: pagesWritten, pagesRead, writeDurationMs, readDurationMs, totalDurationMs. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the top-level JSON result includes all five keys.`
            : null,
          benchmarkMetricKeysRepairNeeded || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_output_'))
            ? `The dry-run stdout contract is strict: ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must print exactly one JSON.stringify(result) object and nothing else. Required shape: {"status":"ok","summary":{"writeCount":1,"readCount":1},"metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}. Put all banner/debug text on stderr or remove it.`
            : null,
          ...prototypeCodeDiagnostics.requiredNextEvidence,
          ...(repairSourceBlocks.length > 0
            ? [
              allowPrototypeContractTargetedReads
                ? 'Current file contents for the cited repair targets are embedded below. Prefer them directly. If one narrow re-read is still necessary before rewriting, use only the explicitly allowed read paths from this repair batch.'
                : 'Current file contents for the cited repair targets are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          rowFormatRepairNeeded
            ? 'Use one explicit row wire format across _serializeRow, _deserializeRow, readRow, scanTable, and any page-header bookkeeping. A length-prefixed JSON payload per row is acceptable if the same format is read back consistently.'
            : null,
          rowFormatRepairNeeded
            ? 'scanTable and readRow must skip page header bytes, respect row boundaries exactly, and never decode string-bearing rows as fixed-width doubles.'
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
            ? `If bench.js already calls engine methods that do not exist, either align bench.js to the real StorageEngine API or implement those exact methods in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_missing_method:'))
            ? `Static inspection already identified missing StorageEngine methods called by ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js: ${prototypeCodeDiagnostics.failedChecks.filter((entry) => entry.startsWith('bench_storage_engine_missing_method:')).map((entry) => entry.split(':').slice(1).join(':')).join(', ')}. Fix the API mismatch in the cited files now; do not spend this turn rereading them.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_async_usage_mismatch:'))
            ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js exposes Promise-based methods such as open, readPage, writePage, or close, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must await them. Do not treat Promise-returning I/O as synchronous benchmark work.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_open_missing')
            ? `If the storage engine uses fd-backed page I/O, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must open or initialize it before calling readPage/writePage.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_initialize_missing')
            ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js uses init() or initialize() to create its data directory or metadata paths, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must await that setup before the first readPage/writePage call. Alternatively, make storage-engine.js ensure the data directory exists inside writePage before fs.writeFileSync. Do not benchmark against an uninitialized data path.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_page_size_mismatch')
            ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js enforces fixed-size pages, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must allocate page-sized buffers or the storage engine must expose a coherent page-serialization helper. Do not pass short Buffer.from(...) payloads into writePage unchanged.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('undeclared_node_builtin:'))
            ? `Add missing CommonJS require declarations for Node builtins before using them. For example, if ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js uses path.join or os.tmpdir, it must include const path = require('path') and const os = require('os') before those calls.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_arg_mismatch:'))
            ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js call StorageEngine methods with the same required argument shape implemented by ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js, or simplify storage-engine.js to the benchmark's actual method contract. Do not leave writePage/readPage calls with missing fileId/pageId/data parameters.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
            ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js createTable/loadTable the benchmark table before any readPage/writePage call when ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js keeps table metadata in memory. Do not write pages to a table that has not been loaded into StorageEngine.tables.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_table_name_mismatch:'))
            ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js use the named table identifier expected by ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js before calling writePage/readPage. If storage-engine.js exposes writePage(tableName, pageNum, pageBuffer), then bench.js must create/open a string-named benchmark table and pass that table name; do not pass DEFAULT_TABLE_ID = 0 or another numeric id into a table-name API.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')
            ? `If bench.js constructs StorageEngine with an options object, either make storage-engine.js accept { dataDir, ... } explicitly or change bench.js to pass the string path that StorageEngine actually expects. Do not leave path.join(...) receiving a raw object.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_module_export_mismatch:'))
            ? `Use one canonical CommonJS contract before rerunning the benchmark: prototype modules should export named bindings such as module.exports = { StorageEngine }, and bench.js should import them with destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
            ? `Rewrite ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js to use direct named CommonJS imports for the canonical modules instead of MODULE_DEFS/loadModules/loaded.* indirection. Direct imports are required so static quality and repair diagnostics can verify the module contract before rerunning the benchmark.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
            ? `Align ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js on one method contract before any benchmark rerun.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so the dry-run no longer calls pool.initialize() unless BufferPool implements that exact async setup method. If BufferPool has no setup phase, remove the await pool.initialize() line and use its real getPage/putPage/readPage/writePage contract directly.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
            ? `BufferPool and StorageEngine currently disagree on the page API. If buffer-pool.js calls this.storage.readPage/writePage, then storage-engine.js must implement those exact methods or buffer-pool.js must be rewritten to use the real key-value engine API. Do not leave buffer-pool.js delegating to non-existent storage methods.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so npm run bench -- --dry-run prints one machine-readable JSON object to stdout with top-level status, summary, and metrics keys. Human-readable banner logs alone are not acceptable for the benchmark self-check.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
            ? `Remove non-JSON console.log banner and phase output from ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js. The dry-run command stdout must contain exactly one JSON.stringify(result) payload and no extra prose before or after it.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so dryRun returns and prints a top-level object with status, summary, and metrics keys. Printing raw metrics alone is not acceptable.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so direct WAL calls use the real WALManager API. Do not keep wal.getFlushCount() unless WALManager implements that method.`
            : null,
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure constructor, export, and method-contract repairs should stay scoped to the cited prototype files only.`,
          'Do not emit run_command in this repair turn. After the prototype contract defects are fixed, the next turn can run the dry-run benchmark.',
        ], {
          phase: 'prototype_contract_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: prototypeContractRepairTargets,
          allowTargetedReadInspection: allowPrototypeContractTargetedReads,
          allowedReadPaths: prototypeContractInspectionPaths,
          allowedOptionalPaths: prototypeContractAllowedOptionalPaths,
          uniqueKey: `database_lab:prototype_contract_repair:${prototypeContractRepairTargets.join('|')}`,
        });
      }
      if (benchFailureExcerpt && /maximum call stack size exceeded/i.test(benchFailureExcerpt)) {
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks([`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`], 1);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude([`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),
          `The design docs, prototype top-level files, and initial src modules already exist. Do not rewrite them in this turn.`,
          'The benchmark dry-run already failed. Repair only database-lab/prototype/scripts/bench.js now.',
          benchFailureExcerpt,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current benchmark scaffold is embedded below. Use it directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          'Fix the benchmark aggregator so it does not spread-push large latency arrays from worker results into one array. Aggregate incrementally instead.',
          'Keep the benchmark result shape compatible with dry-run verification: emit summary and metrics data without blowing the stack.',
          'Do not emit run_command in this repair turn. After bench.js is repaired, the next turn can rerun the dry-run benchmark.',
        ], {
          phase: 'bench_stack_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],
          uniqueKey: `database_lab:bench_stack_repair:${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        });
      }
      if (
        prototypeModuleSystemMismatch
        || (benchFailureExcerpt && /(require is not defined in ES module scope|module is not defined in ES module scope|exports is not defined in ES module scope|ERR_REQUIRE_ESM|Cannot use import statement outside a module|Unexpected token 'export')/i.test(benchFailureExcerpt))
      ) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...benchRequiredModuleFiles,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'The benchmark dry-run already failed because the prototype package and JavaScript files are using conflicting module systems.',
          ...(benchFailureExcerpt ? [benchFailureExcerpt] : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch')
            ? [`Static inspection also found a module-system mismatch: ${prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) => /module system is consistent/i.test(entry)).join(' ')}`]
            : []),
          `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json and the cited benchmark files so the scaffold uses one coherent module system end-to-end.`,
          `Prefer CommonJS for this scaffold: remove "type": "module" from ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, keep module.exports in the prototype src files, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js on named require destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`,
          'If you choose ESM instead, then convert every cited file consistently to import/export syntax and keep package scripts pointing at the real entrypoint files. Do not leave a mixed contract.',
          prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
            ? `While repairing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, also instantiate and call the real StorageEngine and BufferPool modules instead of placeholder counter loops. A benchmark that only imports modules but never exercises them is not acceptable.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
            ? `Keep the dryRun result machine-readable with top-level status, summary, and metrics keys after the module-system fix.`
            : null,
          benchmarkMetricKeysRepairNeeded
            ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the result metrics include exactly pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
            : null,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the package and benchmark contract first.`,
          'Do not emit run_command in this repair turn. After the module-system fix lands, the next turn can rerun the dry-run benchmark.',
        ].filter(Boolean), {
          phase: 'bench_module_system_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
            artifactProgress,
            packageEntryDiagnostics,
            scenarioId: spec.id,
          }),
          uniqueKey: `database_lab:bench_module_system_repair:${repairTargets.join('|')}`,
        });
      }
      if (
        prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
        || (benchFailureExcerpt && /(ERR_OUT_OF_RANGE|out of range|Received\s+-\d+)/i.test(benchFailureExcerpt) && /writeUInt32BE/i.test(benchFailureExcerpt))
      ) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'The benchmark dry-run already failed because the storage engine passed a negative or out-of-range value into Buffer.writeUInt32BE.',
          ...(benchFailureExcerpt ? [benchFailureExcerpt] : []),
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
            ? `Static inspection also found signed bitwise coercion before writeUInt32BE in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js. JavaScript bitwise operators return signed 32-bit numbers, so expressions like Date.now() & 0xFFFFFFFF can become negative.`
            : null,
          `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so every value passed to Buffer.writeUInt32BE is guaranteed to be an unsigned integer in the range 0..4294967295. Prefer (value >>> 0) for 32-bit fields or an explicit clamp helper. Do not use signed bitwise & 0xFFFFFFFF without unsigned conversion.`,
          `Keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with the storage page format and do not claim benchmark success until a later run_command captures a successful dry-run.`,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the storage integer encoding contract.`,
          'Do not emit run_command in this repair turn. After the uint32 encoding repair lands, the next turn can rerun the dry-run benchmark.',
        ].filter(Boolean), {
          phase: 'bench_uint32_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
            artifactProgress,
            packageEntryDiagnostics,
            scenarioId: spec.id,
          }),
          uniqueKey: `database_lab:bench_uint32_repair:${repairTargets.join('|')}`,
        });
      }
      if (benchFailureExcerpt && /(ENOENT|no such file or directory)/i.test(benchFailureExcerpt)) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'The benchmark dry-run already failed because prototype file-backed I/O started before the data path or page-file contract was ready.',
          benchFailureExcerpt,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_initialize_missing')
            ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js is calling readPage/writePage without awaiting storageEngine init()/initialize() or otherwise ensuring the data directory exists.`
            : null,
          `Repair only ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js now.`,
          `Ensure ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js constructs StorageEngine with a real data directory, awaits storageEngine.init()/initialize() before the first readPage/writePage call or makes writePage create its directory safely, and awaits any Promise-based storage methods before printing success JSON.`,
          `Ensure ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js creates or verifies the parent data directory before it opens tablespace files such as default.dat. Do not assume the directory already exists.`,
          'If the benchmark writes page data, keep the page-write contract coherent: either pass page-sized buffers into writePage or expose one storage helper that serializes benchmark payloads into valid pages before disk I/O.',
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the benchmark I/O contract.`,
          'Do not emit run_command in this repair turn. After the I/O contract is repaired, the next turn can rerun the dry-run benchmark.',
        ].filter(Boolean), {
          phase: 'bench_runtime_io_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
          uniqueKey: `database_lab:bench_runtime_io_repair:${repairTargets.join('|')}`,
        });
      }
      if (benchFailureExcerpt && /Table\s+(?:(?:0|\d+)|['"`][^'"`]+['"`])\s+not\s+(?:found|loaded)/i.test(benchFailureExcerpt)) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          /not\s+loaded/i.test(benchFailureExcerpt)
            ? 'The benchmark dry-run already failed because page I/O ran before the benchmark table was created or loaded into the storage engine.'
            : 'The benchmark dry-run already failed because the benchmark passed a numeric table id into a storage API that expects a named table identifier.',
          benchFailureExcerpt,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_table_name_mismatch:'))
            ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js is calling StorageEngine readPage/writePage with a numeric table id while ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js expects tableName/table identifiers.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
            ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js uses table page I/O without a createTable/loadTable/openTable lifecycle step, while ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js tracks loaded table metadata.`
            : null,
          `Repair only ${repairTargets.join(', ')} now so the benchmark, buffer pool, and storage engine share one table identity and table lifecycle contract.`,
          `Preferred fix: make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js create or load a string-named benchmark table such as "benchmark_table" before page writes, then call writePage/readPage with that table name and the page number. If BufferPool evicts dirty pages, ensure its flush path cannot write to a table missing from StorageEngine.tables. If you instead change storage-engine.js to lazy-create/load tables, keep create/open/read/write/delete behavior coherent and update the benchmark accordingly.`,
          'Do not leave DEFAULT_TABLE_ID = 0 flowing into a table-name lookup. Do not claim benchmark success until a later run_command captures a successful dry-run.',
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the benchmark table identity contract.`,
          'Do not emit run_command in this repair turn. After the table identity contract is repaired, the next turn can rerun the dry-run benchmark.',
        ].filter(Boolean), {
          phase: 'bench_table_identity_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
          uniqueKey: `database_lab:bench_table_identity_repair:${repairTargets.join('|')}`,
        });
      }
      const benchPrototypeContractMismatchDetected =
        prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
        || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_data_root_missing')
        || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) =>
          entry.startsWith('storage_engine_missing_method:')
          || entry.startsWith('bench_storage_engine_table_name_mismatch:')
          || entry.startsWith('bench_wal_manager_missing_method:')
          || entry.startsWith('bench_buffer_pool_missing_method:')
          || entry.startsWith('buffer_pool_storage_engine_missing_method:')
          || entry.startsWith('bench_transaction_missing_method:')
          || entry.startsWith('bench_transaction_manager_argument_mismatch:')
          || entry.startsWith('transaction_manager_wal_missing_method:')
          || entry.startsWith('transaction_manager_storage_missing_method:')
          || entry.startsWith('transaction_manager_constructor_option_alias_mismatch:')
        );
      if (
        benchFailureExcerpt
        && (
          /(ERR_INVALID_ARG_TYPE|TypeError)/i.test(benchFailureExcerpt)
            || (
              benchPrototypeContractMismatchDetected
            && /(storage_engine_init|buffer_pool_init|wal_init|tx_manager_init|bplus_tree_init|The \"path\" argument|ENOENT|no such file or directory|Received an instance of Object|BufferPool requires options\.storageEngine|pool\.initialize is not a function|Transaction\s+(?:undefined|null|[^\s]+)\s+not found)/i.test(benchFailureExcerpt)
          )
        )
      ) {
        const failureMentionedPrototypePaths = getDatabasePrototypePathsMentionedInText(benchFailureExcerpt);
        const failureImpliesStorageRepair =
          /(storage|engine|StorageEngine)\.(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt)
          || /(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
        const failureImpliesWalRepair =
          /\bwal\.(?:open|init|initialize|append|appendEntry|close|getFlushCount)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
        const failureImpliesBufferRepair =
          /(?:bufferPool|pool)\.(?:open|init|initialize|readPage|writePage|getPage|putPage)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
        const failureImpliesTransactionRepair =
          /(?:txManager|transactionManager)\.(?:begin|beginTransaction|commit|commitTransaction|rollback|rollbackTransaction|abort)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt)
          || /Transaction\s+(?:undefined|null|[^\s]+)\s+not found/i.test(benchFailureExcerpt);
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...failureMentionedPrototypePaths,
          ...(failureImpliesStorageRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`] : []),
          ...(failureImpliesWalRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`] : []),
          ...(failureImpliesBufferRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`] : []),
          ...(failureImpliesTransactionRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`] : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_constructor_'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
            || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
            || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
            ? [
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`,
            ]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))
            ? [
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
            ]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))
            ? [
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
              `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
            ]
            : []),
          ...prototypeCodeDiagnostics.failedChecks
            .filter((entry) => entry.startsWith('bench_module_export_mismatch:') || entry.startsWith('bench_module_export_name_mismatch:') || entry.startsWith('bench_module_api_mismatch:'))
            .map((entry) => entry.split(':').slice(1, 2).join(':'))
            .filter(Boolean),
          ...prototypeCodeDiagnostics.benchImportedModuleFiles.filter((relativePath) => benchFailureExcerpt.includes(relativePath.split('/').slice(-1)[0])),
        ]));
        const repairInspectionPaths = Array.from(new Set([
          ...repairTargets,
          ...prototypeCodeDiagnostics.benchImportedModuleFiles,
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets, {
            allowTargetedReads: true,
            allowedReadPaths: repairInspectionPaths,
          }),
          `The benchmark dry-run already failed because the benchmark scaffold and the prototype module APIs do not agree on constructor or method signatures.`,
          benchFailureExcerpt,
          failureImpliesStorageRepair
            ? `The concrete benchmark failure points at the StorageEngine contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so the method named in stderr actually exists and is awaited when async.`
            : null,
          failureImpliesWalRepair
            ? `The concrete benchmark failure points at the WALManager contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so the method named in stderr actually exists or the benchmark calls the real WAL API.`
            : null,
          failureImpliesBufferRepair
            ? `The concrete benchmark failure points at the BufferPool contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so read/write methods align.`
            : null,
          failureImpliesTransactionRepair
            ? `The concrete benchmark failure points at the TransactionManager contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so begin/commit/rollback calls use one coherent transaction id or object contract.`
            : null,
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
            ? ['Static inspection also found a direct bench/buffer-pool API mismatch: bench.js is calling bufferPool.writePage/readPage while buffer-pool.js currently exposes putPage/getPage.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
            ? ['Static inspection also found a direct bench/buffer-pool constructor mismatch: bench.js is passing an options object, but buffer-pool.js still expects positional constructor arguments like (storageEngine, poolSize).']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
            ? ['Static inspection also found a direct bench/buffer-pool constructor mismatch: bench.js calls new BufferPool() without the required options.storageEngine dependency.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
            ? ['Static inspection also found a direct bench/buffer-pool API mismatch: bench.js calls pool.initialize(), but buffer-pool.js does not implement initialize. Remove that call or implement the method before rerunning the benchmark.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
            ? [
              'Static inspection also found a deeper prototype contract mismatch: buffer-pool.js is delegating page I/O to this.storage.readPage/writePage, but storage-engine.js does not implement the same page API.',
            ]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
            ? ['Static inspection also found a WAL constructor mismatch: bench.js is passing an options object, but wal-manager.js still treats its constructor input as a base directory string for path.join(...).']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            ? ['Static inspection also found a direct bench/WAL API mismatch: bench.js is calling WALManager methods that wal-manager.js does not implement.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
            ? ['Static inspection also found a TransactionManager constructor mismatch: bench.js is passing alias keys such as wal/storage/index, but transaction-manager.js expects storageEngine/bufferPool/walManager/indexManager.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
            ? ['Static inspection also found a TransactionManager option alias mismatch: bench.js passes a short alias such as wal, but transaction-manager.js consumes a canonical option key such as walManager, leaving the dependency undefined at runtime.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
            ? ['Static inspection also found a TransactionManager call argument mismatch: bench.js passes a transaction object to commit/rollback, but transaction-manager.js appears to expect a transaction id lookup key.']
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
            ? ['Static inspection also found a query-executor contract mismatch: bench.js is constructing QueryExecutor with a loose object literal, but query-executor.js expects a richer database facade that exposes methods like getTable and insertRow.']
            : []),
          ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>
            /named CommonJS export exists|direct named CommonJS destructuring|exposes the methods bench\.js is calling|StorageEngine\.(?:readPage|writePage)|these engine methods line up|pool\.initialize|BufferPool actually implements initialize|BufferPool only calls storage methods|WALManager exposes the methods bench\.js is calling|TransactionManager only calls WALManager methods|TransactionManager only calls StorageEngine methods/i.test(entry)
          ),
          `Repair only the cited files now so ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js constructs and calls the real prototype modules correctly.`,
          'Use the current module APIs or repair those module exports in the same turn; do not leave constructor arguments or method names mismatched.',
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
            ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js calls StorageEngine page methods such as readPage or writePage, then ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js must implement those exact methods or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must stop calling them. Do not leave page-method calls pointing at a key-value-only engine API.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_data_root_missing')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so StorageEngine receives a real dataRoot path before it calls path.join(...). Do not leave new StorageEngine() with an undefined base directory.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')
            ? `If bench.js constructs StorageEngine with an options object, either make ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js accept that object shape explicitly or change ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js to pass the string path that StorageEngine actually expects.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
            ? `If bench.js is meant to benchmark page-oriented storage, then implement readPage/writePage coherently in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and keep ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js delegating to that contract. If the real storage engine is key-value only, then rewrite buffer-pool.js and bench.js together to use one coherent key/value contract instead of page calls.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so BufferPool construction is coherent. Do not keep new BufferPool({ ... }) if buffer-pool.js still expects positional arguments.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool receives the real StorageEngine dependency it requires. Do not keep new BufferPool() when ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js throws unless options.storageEngine is provided.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it no longer calls pool.initialize() against a BufferPool class that does not expose initialize(). If setup is needed, add the exact initialize method to ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and keep it coherent with the existing constructor and storage dependency.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WALManager receives a real directory string before path.join(...). Do not keep new WALManager({ ... }) if wal-manager.js still expects a base directory string.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so direct WAL calls are coherent. Do not keep wal.getFlushCount() unless WALManager implements getFlushCount(); using wal.flushCount or adding a real getFlushCount() method are both acceptable if the benchmark result remains machine-readable.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager uses one coherent option contract. Do not keep new TransactionManager({ wal, storage, index }) if the real constructor expects keys such as storageEngine, bufferPool, walManager, and indexManager.`
            : null,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so aliases such as wal are not silently accepted when the constructor consumes walManager. Prefer one explicit options contract and keep bench.js aligned with it.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so transaction begin/commit logic only calls WAL methods that really exist. If transaction-manager.js calls this.wal.currentLsn() or append-style methods, wal-manager.js must expose them, or transaction-manager.js must switch to the actual exported WAL API before any benchmark rerun.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so transaction lifecycle code only calls StorageEngine methods that really exist. Do not leave transaction-manager.js calling allocatePage, put, or other methods that storage-engine.js does not export.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so the object returned by begin() exposes the methods bench.js actually calls. If the real transaction API is read/write/delete, then bench.js must stop calling insert/lookup and switch to those coherent method names before any benchmark rerun.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so commit/rollback calls pass the expected id or the manager methods accept the transaction object consistently. Do not leave txManager.commit(tx) if commit(txnId) looks up activeTxns by id.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js so QueryExecutor operates on one coherent database facade. Either instantiate the exported Database wrapper from ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js or provide an equivalent object with the methods query-executor.js actually calls.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it uses direct named CommonJS require statements for the benchmark-critical modules. Do not keep MODULE_DEFS/loadModules/loaded.* dynamic indirection because it hides import/export mismatches from the quality gate.`
            : null,
          benchmarkMetricKeysRepairNeeded
            ? `Keep the repaired benchmark result machine-readable and include metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
            : null,
          `The repaired benchmark CLI must print exactly one JSON.stringify(result) object and no banner logs. Required stdout shape: {"status":"ok","summary":{"writeCount":1,"readCount":1},"metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}.`,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure constructor and method repairs should stay scoped to the cited prototype files only.`,
          'Do not emit run_command in this repair turn. After the API mismatch is fixed, the next turn can rerun the dry-run benchmark.',
        ], {
          phase: 'bench_api_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowTargetedReadInspection: true,
          allowedReadPaths: repairInspectionPaths,
          allowedOptionalPaths: repairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
            ? [DATABASE_LAB_DESIGN_QUALITY_FILE]
            : [],
          uniqueKey: `database_lab:bench_api_repair:${repairTargets.join('|')}`,
        });
      }
      if (benchFailureExcerpt && /(Unexpected non-whitespace character after JSON|SyntaxError)/i.test(benchFailureExcerpt)) {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
          ...(benchFailureExcerpt.includes('bench.js') ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`] : []),
        ]));
        const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'The benchmark dry-run failed because the storage engine row serialization contract is internally inconsistent, so scanTable or readRow could not recover the rows they wrote.',
          benchFailureExcerpt,
          ...(prototypeCodeDiagnostics.failedChecks.length > 0
            ? [`Static inspection also found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`]
            : []),
          `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so insertRow, readRow, scanTable, updateRow, and close all follow one coherent storage-engine contract.`,
          'Use one explicit row wire format across _serializeRow and _deserializeRow. If rows can contain strings, do not write variable-length UTF-8 bytes into fixed 8-byte numeric slots and then decode them back with readDoubleBE.',
          'scanTable and readRow must skip page header bytes, respect stored row boundaries exactly, and never concatenate adjacent rows into one payload.',
          'If bench.js assumes a conflicting row or engine API, repair bench.js in the same turn so it uses the real storage-engine API without inventing an alternate record layout.',
          benchmarkMetricKeysRepairNeeded
            ? `Keep the repaired benchmark output machine-readable and include metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
            : null,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure serialization fixes should stay scoped to the cited prototype files only.`,
          'Do not emit run_command in this repair turn. After the scan/serialization bug is fixed, the next turn can rerun the dry-run benchmark.',
        ], {
          phase: 'storage_engine_repair',
          phaseCursor: artifactProgress.nextStage,
          targetPaths: repairTargets,
          allowedOptionalPaths: repairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
            ? [DATABASE_LAB_DESIGN_QUALITY_FILE]
            : [],
          uniqueKey: `database_lab:storage_engine_repair:${repairTargets.join('|')}`,
        });
      }
      return buildDatabaseLabContinueInstruction([
        buildJsonToolCallPrelude(),
        `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,
        `Do not reread brief/* and do not rewrite the full scaffold in this turn.`,
        `Run a real dry-run benchmark self-check from ${DATABASE_LAB_PROTOTYPE_DIR} now.`,
        'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"npm run build","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'If the dry-run fails, keep the exact stderr and do not claim design completion.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',
      ], {
        phase: 'benchmark_self_check',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],
        uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',
      });
    }
    if (briefAlreadyRead && artifactProgress.prototypeModules.completed && artifactProgress.nextStage === 'benchmark_self_check') {
      return buildDatabaseLabContinueInstruction([
        buildJsonToolCallPrelude(),
        `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,
        `Do not reread brief/* and do not rewrite design docs in this turn.`,
        `Stay in benchmark self-check mode. Run a real dry-run benchmark command from ${DATABASE_LAB_PROTOTYPE_DIR} now instead of restarting the scaffold phases.`,
        'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'If the dry-run fails, keep the exact stderr and do not claim design completion.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',
      ], {
        phase: 'benchmark_self_check',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],
        uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',
      });
    }
    if (briefAlreadyRead && !artifactProgress.prototypeModules.completed) {
      return buildPrototypeModulesInstruction();
    }
    if (
      briefAlreadyRead
      && databaseLabArtifactSatisfied
      && successfulBenchRunSatisfied
      && qualityAcceptance?.verdict === 'passed'
    ) {
      const producedFiles = Array.from(new Set([
        ...workspaceFiles.filter((relativePath) =>
          relativePath.startsWith(`${DATABASE_LAB_ROOT}/`) || relativePath === DATABASE_LAB_DESIGN_QUALITY_FILE
        ),
      ]));
      return buildDatabaseLabFinalizationInstruction(producedFiles);
    }
    if (!briefAlreadyRead) {
      return buildDatabaseLabContinueInstruction([
        buildJsonToolCallPrelude(),
        `Create the design package under ${DATABASE_LAB_DESIGN_DIR}/ and the prototype scaffold under ${DATABASE_LAB_PROTOTYPE_DIR}/, but do not start writing files in this turn.`,
        'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md only.',
        'Do not emit write_file, create_folder, list_files, search_files, or run_command in this turn after the three read_file calls.',
        'Return exactly three machine-readable blocks in this order: one [AGENT-001_OUTPUT] JSON envelope, then the three read_file JSON objects, then one final tracker JSON.',
        'Use this exact explicit output wrapper pattern with both tags present: [AGENT-001_OUTPUT]{"summary":"...","details":"...","producedFiles":[],"issues":[]}[/AGENT-001_OUTPUT]. Do not omit the closing [/AGENT-001_OUTPUT] tag.',
        'The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: summary, details, producedFiles, issues.',
        'In this read-only grounding phase, producedFiles must be [] and the output must say that the brief files were read successfully and the design-doc write phase is next.',
        'Append exactly one final tracker JSON after the three read_file objects using this shape: {"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":20,"decision":"CONTINUE","reason":"Read the grounded brief files; next turn will write the design docs.","next_unit":null,"files_created":[]}.',
        'Do not leave the read phase open-ended. The tracker is required so the next turn can start the design-doc write phase with the grounded brief contents already in context.',
      ], {
        phase: 'brief_read',
        phaseCursor: artifactProgress.nextStage,
        targetPaths: ['brief/workload-profile.md', 'brief/mysql-targets.md', 'brief/constraints.md'],
        uniqueKey: 'database_lab:brief_read',
      });
    }
      return buildDatabaseLabContinueInstruction([
        buildJsonToolCallPrelude(),
        `Create the design package under ${DATABASE_LAB_DESIGN_DIR}/ and the prototype scaffold under ${DATABASE_LAB_PROTOTYPE_DIR}/.`,
        briefAlreadyRead
          ? 'The seeded brief files were already read successfully in this thread. Do not spend another turn re-reading brief/*.'
          : 'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md.',
        'write_file automatically creates missing parent directories. Do not spend a turn emitting create_folder before the real file writes.',
      `Write only this next design-doc batch now: ${(missingDesignFiles.length > 0 ? nextDesignDocTargets : getDatabaseLabNextDesignDocTargets(scenarioState, designDocBatchSize)).join(', ')}.`,
      missingDesignFiles.length > nextDesignDocTargets.length
        ? `Do not try to finish the full design corpus in one turn. Leave these remaining design docs for later turns: ${missingDesignFiles.slice(nextDesignDocTargets.length).join(', ')}.`
        : 'If the design-doc batch succeeds, the next turn can continue with prototype scaffold work.',
      `After the design-doc phase, continue with prototype top-level files, then prototype src modules, then ${DATABASE_LAB_DESIGN_QUALITY_FILE}, and only then run the dry-run benchmark.`,
      'Do not claim measured MySQL parity. Keep it as a target profile only.',
      'The next turn can summarize only after the required write_file calls succeed.',
    ], {
      phase: artifactProgress.nextStage ?? 'design_docs',
      phaseCursor: artifactProgress.nextStage,
      targetPaths: nextDesignDocTargets,
      uniqueKey: `database_lab:fallback:${artifactProgress.nextStage ?? 'design_docs'}:${nextDesignDocTargets.join('|')}`,
    });
  }

  function buildDatabaseLabVerificationPrompt() {
    const missingFiles = getMissingWorkspaceFiles(
      scenarioState,
      [...DATABASE_LAB_REQUIRED_DESIGN_FILES, ...DATABASE_LAB_REQUIRED_PROTOTYPE_FILES],
    );
    const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
    const existingDesignDocFiles = getScenarioWorkspaceFiles(scenarioState)
      .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_DESIGN_DIR}/`));
    const existingPrototypeSrcFiles = getScenarioWorkspaceFiles(scenarioState)
      .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
    const prototypeCodeDiagnostics = getDatabaseLabPrototypeCodeDiagnostics(scenarioState);
    const successfulRunIds = getRecentSuccessfulInvocationIds(scenarioState, 'run_command', 4);
    const latestVerifyBenchFailure = getLatestDatabaseBenchRunFailure(scenarioState);
    const benchmarkDocRepairTargets = invalidOutputErrors
      .filter((entry) => entry.startsWith('quality_gate_failed:doc_not_updated_with_benchmark:'))
      .map((entry) => entry.split('quality_gate_failed:doc_not_updated_with_benchmark:')[1])
      .filter(Boolean);
    const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];
    const designManifestMissing =
      invalidOutputErrors.includes('quality_gate_failed:missing_database_design_manifest')
      || qualityFailedChecks.includes('missing_database_design_manifest');
    const benchmarkResultMissing =
      invalidOutputErrors.includes('quality_gate_failed:missing_database_benchmark_result')
      || qualityFailedChecks.includes('missing_database_benchmark_result');
    const benchmarkToolEvidenceMissing =
      invalidOutputErrors.includes('quality_gate_failed:missing_benchmark_tool_evidence')
      || qualityFailedChecks.includes('missing_benchmark_tool_evidence');
    const benchmarkMetricsMissing =
      invalidOutputErrors.includes('quality_gate_failed:benchmark_result_missing_metrics')
      || qualityFailedChecks.includes('benchmark_result_missing_metrics');
    const benchmarkMetricKeysRepairNeeded =
      invalidOutputErrors.includes('quality_gate_failed:benchmark_scaffold_missing_required_metric_keys')
      || qualityFailedChecks.includes('benchmark_scaffold_missing_required_metric_keys')
      || qualityFailedChecks.includes('benchmark_self_check_missing_required_metrics');
    const benchmarkOutputContractRepairNeeded =
      benchmarkMetricKeysRepairNeeded
      || qualityFailedChecks.includes('benchmark_self_check_output_invalid')
      || prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
      || prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
      || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope');
    const benchmarkRepairNeeded =
      benchmarkResultMissing
      || benchmarkToolEvidenceMissing
      || benchmarkMetricsMissing;
    const benchmarkSelfCheckStale =
      invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_stale')
      || qualityFailedChecks.includes('benchmark_self_check_stale');
    const benchmarkSelfCheckNotGrounded =
      invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_not_grounded')
      || qualityFailedChecks.includes('benchmark_self_check_not_grounded');
    const verifyBenchmarkSelfCheckObserved = hasObservedDatabaseBenchRunAttempt(scenarioState);
    const benchmarkDependencyUntrackedTargets = Array.from(new Set([
      ...qualityFailedChecks
        .filter((entry) => entry.startsWith('benchmark_dependency_untracked:'))
        .map((entry) => entry.split(':').slice(1).join(':')),
      ...invalidOutputErrors
        .filter((entry) => entry.startsWith('quality_gate_failed:benchmark_dependency_untracked:'))
        .map((entry) => entry.split(':').slice(2).join(':')),
    ].filter(Boolean)));
    const designManifestGroundingTargets = Array.from(new Set([
      ...benchmarkDependencyUntrackedTargets,
      ...qualityFailedChecks
        .filter((entry) => entry.startsWith('core_module_untracked:'))
        .map((entry) => entry.split(':').slice(1).join(':')),
      ...invalidOutputErrors
        .filter((entry) => entry.startsWith('quality_gate_failed:core_module_untracked:'))
        .map((entry) => entry.split(':').slice(2).join(':')),
    ].filter(Boolean)));
    const designManifestGroundingRepairNeeded =
      designManifestGroundingTargets.length > 0
      || qualityFailedChecks.some((entry) => entry.startsWith('implemented_module_outside_prototype_src:'))
      || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:implemented_module_outside_prototype_src:'));
    const designCoverageGapIndexes = Array.from(new Set(
      qualityFailedChecks
        .filter((entry) => entry.startsWith('design_coverage_gap:'))
        .map((entry) => Number.parseInt(entry.split(':')[1] ?? '', 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ));
    const designCoverageRepairTargets = Array.from(new Set(
      designCoverageGapIndexes
        .flatMap((index) => DATABASE_LAB_DESIGN_TOPIC_GROUPS[index]?.docs ?? DATABASE_LAB_REQUIRED_DESIGN_FILES),
    ));
    const designCoverageRepairTopics = designCoverageGapIndexes
      .map((index) => `group ${index}: ${DATABASE_LAB_DESIGN_TOPIC_GROUPS[index]?.label ?? 'unknown topic group'}`);
    const seededScaffoldPresent = missingFiles.length === 0 && hasDatabaseLabRequiredWorkspaceShape(scenarioState);
    const targetedInspectionPaths = Array.from(new Set([
      `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
      `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
      `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
      ...existingPrototypeSrcFiles.slice(0, 2),
      DATABASE_LAB_DESIGN_QUALITY_FILE,
    ].filter((relativePath) => workspaceFiles.includes(relativePath))));
    const buildVerifyPrototypeRepairSourceBlocks = (relativePaths, limit = 3) => buildEmbeddedSourceBlocks(
      scenarioState,
      Array.from(new Set(
        (Array.isArray(relativePaths) ? relativePaths : [])
          .filter((relativePath) => typeof relativePath === 'string' && /\.(?:js|json|md)$/i.test(relativePath))
          .slice(0, limit),
      )),
    );
    const verifyBenchFailureExcerpt = latestVerifyBenchFailure
      ? buildToolInvocationResultExcerpt(scenarioState, latestVerifyBenchFailure.activityId)
      : null;
    const verifyPrototypeApiRepairTargets = Array.from(new Set([
      `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
      ...getDatabasePrototypePathsMentionedInText(verifyBenchFailureExcerpt),
      ...prototypeCodeDiagnostics.failedChecks
        .filter((entry) =>
          entry.startsWith('bench_module_api_mismatch:')
          || entry.startsWith('bench_module_export_mismatch:')
          || entry.startsWith('bench_module_export_name_mismatch:')
        )
        .map((entry) => entry.split(':').slice(1, 2).join(':'))
        .filter(Boolean),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
        ? prototypeCodeDiagnostics.benchImportedModuleFiles
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
        : []),
      ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
        ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
        : []),
    ].filter(Boolean)));
    const verifyPrototypeApiRepairNeeded =
      seededScaffoldPresent
      && verifyPrototypeApiRepairTargets.length > 1
      && (
        Boolean(verifyBenchFailureExcerpt)
        || successfulRunIds.length > 0
        || benchmarkSelfCheckStale
        || benchmarkSelfCheckNotGrounded
        || verifyBenchmarkSelfCheckObserved
      );
    if (verifyPrototypeApiRepairNeeded) {
      const verifyPrototypeApiInspectionPaths = Array.from(new Set([
        ...verifyPrototypeApiRepairTargets,
        ...prototypeCodeDiagnostics.benchImportedModuleFiles,
      ]));
      const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(
        verifyPrototypeApiRepairTargets,
        verifyPrototypeApiRepairTargets.length,
      );
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(verifyPrototypeApiRepairTargets, {
          allowTargetedReads: true,
          allowedReadPaths: verifyPrototypeApiInspectionPaths,
        }),
        'The benchmark scaffold and the current prototype APIs are not aligned. Repair the cited prototype files before rerunning or writing benchmark result evidence.',
        ...(verifyBenchFailureExcerpt ? [verifyBenchFailureExcerpt] : []),
        `Static prototype inspection found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`,
        prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_module_api_mismatch:'))
          ? 'If bench.js calls methods that the imported database facade does not expose, either change bench.js to the real method names or add coherent methods to the imported module. Do not leave calls such as engine.rangeScan when the module only exposes rangeQuery.'
          : null,
        prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
          ? 'The benchmark should exercise real prototype modules directly or through a substantive facade. If it imports src/index.js, that file must contain real runtime behavior and must be listed in the design manifest after the repair.'
          : null,
        `Keep the repair scoped to: ${verifyPrototypeApiRepairTargets.join(', ')}.`,
        `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE} in this turn. After this API repair, the next turn must rerun the dry-run benchmark against the current files.`,
        ...(repairSourceBlocks.length > 0
          ? [
            'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
            ...repairSourceBlocks,
          ]
          : []),
      ].filter(Boolean), {
        phase: 'verify_bench_api_repair',
        phaseCursor: 'verify_bench_api_repair',
        targetPaths: verifyPrototypeApiRepairTargets,
        allowTargetedReadInspection: true,
        allowedReadPaths: verifyPrototypeApiInspectionPaths,
        allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
        uniqueKey: `database_lab:verify_bench_api_repair:${verifyPrototypeApiRepairTargets.join('|')}`,
      });
    }
    if (seededScaffoldPresent && successfulRunIds.length === 0 && verifyBenchFailureExcerpt) {
      const repairTargets = Array.from(new Set([
        `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        ...getDatabasePrototypePathsMentionedInText(verifyBenchFailureExcerpt),
        ...prototypeCodeDiagnostics.failedChecks
          .filter((entry) =>
            entry.startsWith('bench_module_api_mismatch:')
            || entry.startsWith('bench_module_export_mismatch:')
            || entry.startsWith('bench_module_export_name_mismatch:')
          )
          .map((entry) => entry.split(':').slice(1, 2).join(':'))
          .filter(Boolean),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
          : []),
        ...prototypeCodeDiagnostics.benchImportedModuleFiles.filter((relativePath) =>
          verifyBenchFailureExcerpt.includes(relativePath.split('/').slice(-1)[0])
        ),
      ]));
      const verifyBenchFailureInspectionPaths = Array.from(new Set([
        ...repairTargets,
        ...prototypeCodeDiagnostics.benchImportedModuleFiles,
      ]));
      const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(repairTargets, repairTargets.length);
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(repairTargets, {
          allowTargetedReads: true,
          allowedReadPaths: verifyBenchFailureInspectionPaths,
        }),
        'The benchmark command already ran and failed with concrete stderr. Do not run another benchmark and do not recreate the scaffold in this turn.',
        verifyBenchFailureExcerpt,
        prototypeCodeDiagnostics.failedChecks.length > 0
          ? `Static prototype inspection also found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`
          : null,
        /ReferenceError:\s+[A-Za-z_$][A-Za-z0-9_$]*\s+is not defined/i.test(verifyBenchFailureExcerpt)
          ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it has no undeclared variables. Replace stray aliases with the actual declared benchmark objects, or declare the variable from the real prototype module before use.`
          : null,
        /Transaction\s+(?:undefined|null|[^\s]+)\s+not found/i.test(verifyBenchFailureExcerpt)
          ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js only as needed so commit/rollback calls pass the expected transaction id or the manager methods accept the transaction object consistently.`
          : null,
        `Keep the repair scoped to the cited prototype files: ${repairTargets.join(', ')}.`,
        'Do not write benchmark result JSON or quality verification JSON in this turn. The next turn must rerun the dry-run benchmark after this repair and only then write fresh evidence files.',
        ...(repairSourceBlocks.length > 0
          ? [
            'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
            ...repairSourceBlocks,
          ]
          : []),
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the failed benchmark is being repaired.',
      ].filter(Boolean), {
        phase: 'verify_bench_failure_repair',
        phaseCursor: 'verify_bench_failure_repair',
        targetPaths: repairTargets,
        allowTargetedReadInspection: true,
        allowedReadPaths: verifyBenchFailureInspectionPaths,
        uniqueKey: `database_lab:verify_bench_failure_repair:${repairTargets.join('|')}`,
      });
    }
    if (seededScaffoldPresent && successfulRunIds.length === 0) {
      return buildDatabaseLabContinueInstruction([
        'An existing database-lab design and prototype scaffold is already present in this workspace from the earlier design phase.',
        `Do not recreate folders and do not rewrite existing files under ${DATABASE_LAB_DESIGN_DIR} or ${DATABASE_LAB_PROTOTYPE_DIR} in this turn unless a targeted inspection or failed benchmark command proves a specific defect.`,
        `The existing scaffold already includes these key files: ${[
          ...existingDesignDocFiles,
          ...targetedInspectionPaths.filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
        ].join(', ')}.`,
        'A brief inventory pass is allowed if needed before the benchmark attempt, but keep it narrow.',
        targetedInspectionPaths.length > 0
          ? `If you truly need inspection before the benchmark attempt, emit read_file only for these exact paths and at most once per path: ${targetedInspectionPaths.join(', ')}.`
          : 'Do not emit broad read_file calls in this turn.',
        `Your first real action must be one benchmark-related run_command from ${DATABASE_LAB_PROTOTYPE_DIR}.`,
        'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Do not emit create_folder in this turn.',
        'Do not emit write_file in this turn unless the benchmark fails and the exact failing file is first confirmed by read_file or command stderr.',
        `After a successful benchmark command, the next turn can write ${DATABASE_LAB_BENCH_RESULT_FILE} and ${DATABASE_LAB_VERIFY_QUALITY_FILE} with the real invocation id and observed result.`,
        'If the runtime requires a tracker after tool calls, use exactly status IN_PROGRESS and decision CONTINUE while verification work remains.',
      ], {
        phase: 'verify_benchmark_first',
        phaseCursor: 'verify_benchmark_first',
        allowedTools: ['run_command', 'read_file', 'list_files'],
        allowedPaths: targetedInspectionPaths,
        targetPaths: targetedInspectionPaths,
        uniqueKey: `database_lab:verify_benchmark_first:${targetedInspectionPaths.join('|')}`,
      });
    }
    if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkOutputContractRepairNeeded) {
      const repairTargets = Array.from(new Set([
        `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
          : []),
      ]));
      const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(repairTargets, repairTargets.length);
      return buildDatabaseLabContinueInstruction([
        buildWriteOnlyRepairPrelude(repairTargets, { allowTargetedReads: true }),
        `A benchmark-related command already executed in this thread. Reuse one of these invocation ids later only if the repaired benchmark output is actually successful: ${successfulRunIds.join(', ')}.`,
        'Do not rerun the benchmark in this turn. The remaining blocker is the benchmark scaffold output/API contract, not missing execution evidence.',
        `Repair only ${repairTargets.join(', ')} now so npm run bench -- --dry-run prints exactly one machine-readable success JSON object to stdout.`,
        `That JSON object must have top-level status, summary, and metrics keys. metrics must include pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`,
        'Do not print banner logs, phase logs, or any extra prose before or after the JSON object. stdout must be parseable as one benchmark result payload.',
        prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
          ? `Static inspection also found a bench/WAL API mismatch. Do not keep wal.getFlushCount() unless ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js implements getFlushCount(); using an existing flushCount property is acceptable if the benchmark result remains successful and machine-readable.`
          : null,
        'Keep the existing real module execution path intact. This turn is only for repairing the benchmark output contract, not for rewriting design docs or result files.',
        ...(repairSourceBlocks.length > 0
          ? [
            'The current benchmark scaffold is embedded below. Use it directly and do not emit read_file in this turn.',
            ...repairSourceBlocks,
          ]
          : []),
        `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE} in this turn. After bench.js is repaired, the next turn can rerun the dry-run benchmark and then write the result artifacts against the new successful invocation id.`,
      ].filter(Boolean), {
        phase: 'verify_bench_scaffold_repair',
        phaseCursor: 'verify_bench_scaffold_repair',
        targetPaths: repairTargets,
        allowTargetedReadInspection: true,
        uniqueKey: `database_lab:verify_bench_scaffold_repair:${repairTargets.join('|')}`,
      });
    }
    if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkSelfCheckStale) {
      return [
        buildJsonToolCallPrelude(),
        `A benchmark-related command succeeded earlier in this thread, but that evidence is now stale because ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js or prototype/src changed afterward.`,
        `Do not reuse the old invocation ids yet: ${successfulRunIds.join(', ')}.`,
        `Before writing ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE}, rerun one real dry-run benchmark command from ${DATABASE_LAB_PROTOTYPE_DIR} now and capture a fresh run_command invocation id.`,
        'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
        'Do not emit write_file in this turn unless the rerun fails and stderr points to a specific file that must be repaired first.',
        'If the rerun succeeds, the next turn can write fresh benchmark result artifacts against the new successful invocation id.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the rerun is still pending.',
      ].join(' ');
    }
    if (
      missingFiles.length === 0
      && successfulRunIds.length > 0
      && (
        benchmarkDocRepairTargets.length > 0
        || designManifestMissing
        || benchmarkRepairNeeded
        || designManifestGroundingRepairNeeded
      )
    ) {
      const repairPaths = Array.from(new Set([
        ...benchmarkDocRepairTargets,
        ...(designManifestMissing || designManifestGroundingRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : []),
        ...(benchmarkRepairNeeded ? [DATABASE_LAB_VERIFY_QUALITY_FILE, DATABASE_LAB_BENCH_RESULT_FILE] : []),
      ]));
      return [
        buildWriteOnlyRepairPrelude(repairPaths),
        `A benchmark-related command already succeeded in this thread. Reuse one of these invocation ids: ${successfulRunIds.join(', ')}.`,
        'Do not rerun the benchmark first. This is a write-first verification repair pass.',
        benchmarkDocRepairTargets.length > 0
          ? `Repair these exact design docs so they include the observed benchmark or dry-run result: ${benchmarkDocRepairTargets.join(', ')}.`
          : null,
        'Do not emit read_file or run_command in this turn unless one of those files is actually missing. This is a write-first repair pass.',
        designManifestMissing
          ? `Write or repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} with designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files already present under ${DATABASE_LAB_ROOT}/.`
          : null,
        designManifestGroundingRepairNeeded
          ? `Also repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so implementedModules lists the real substantive prototype src modules used by the benchmark: ${(designManifestGroundingTargets.length > 0 ? designManifestGroundingTargets : existingPrototypeSrcFiles).join(', ')}. Do not leave those files in pendingModules, and do not list ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js as an implemented module.`
          : null,
        designManifestMissing
          ? `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}: ${existingDesignDocFiles.join(', ') || DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}. Do not invent indexing.md, transactions.md, wal-recovery.md, or buffer-pool.md unless those files were actually written in the same turn.`
          : null,
        benchmarkRepairNeeded
          ? `Write or repair ${DATABASE_LAB_VERIFY_QUALITY_FILE} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary. sourceInvocationId must equal one of these literal successful run_command ids: ${successfulRunIds.join(', ')}. Do not use placeholders such as pending_command_result or result_pending. resultFile should be ${DATABASE_LAB_BENCH_RESULT_FILE}.`
          : null,
        benchmarkRepairNeeded
          ? `Write or repair ${DATABASE_LAB_BENCH_RESULT_FILE} in the same turn. The JSON must contain top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs. You may keep extra fields such as config, operations, or mysqlParity, but status/summary/metrics are mandatory.`
          : null,
        `implementedModules must name real runnable files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/: ${existingPrototypeSrcFiles.join(', ') || DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.join(', ')}.`,
        'Keep the updated docs explicit about what the prototype actually verified versus what remains unproven about MySQL-nearness.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while verification or repair work remains.',
      ].join(' ');
    }
    if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkDependencyUntrackedTargets.length > 0) {
      return [
        buildWriteOnlyRepairPrelude([DATABASE_LAB_DESIGN_QUALITY_FILE]),
        `A benchmark-related command already succeeded, but quality cannot treat it as grounded because these benchmark-imported modules are missing from ${DATABASE_LAB_DESIGN_QUALITY_FILE}: ${benchmarkDependencyUntrackedTargets.join(', ')}.`,
        'Do not rerun the benchmark in this turn and do not rewrite design docs. This is a manifest-only grounding repair.',
        `Repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so implementedModules includes every real benchmark dependency module under ${DATABASE_LAB_PROTOTYPE_DIR}/src that contains substantive runnable behavior.`,
        `The current real src files are: ${existingPrototypeSrcFiles.join(', ') || 'none'}.`,
        `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js is only a thin barrel export, change the benchmark to import substantive modules directly in a separate bench API repair instead of listing the barrel as implemented behavior.`,
        'After the manifest is repaired, the next turn must rerun the dry-run benchmark if any benchmark or imported src file changed after the last successful command.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while grounding repair remains.',
      ].join(' ');
    }
    if (missingFiles.length === 0 && successfulRunIds.length > 0 && designCoverageGapIndexes.length > 0) {
      return [
        buildWriteOnlyRepairPrelude(designCoverageRepairTargets),
        `A benchmark-related command already succeeded in this thread. Reuse one of these invocation ids: ${successfulRunIds.join(', ')}.`,
        `The remaining quality failure is design coverage, not benchmark execution: ${designCoverageRepairTopics.join(', ')}.`,
        'Do not rerun the benchmark and do not emit broad read_file calls in this turn. This is a write-only design repair pass.',
        `Rewrite only these design docs now: ${designCoverageRepairTargets.join(', ')}.`,
        'Add explicit sections or bullets that cover the missing topic groups in concrete architectural language.',
        'For wal/recovery/checkpoint, describe the intended write-ahead log flow, checkpoint trigger, crash-recovery replay order, and what remains unproven in the current prototype.',
        'Keep all MySQL-nearness statements honest. The docs must distinguish implemented prototype behavior from target design and unproven areas.',
        'Do not remove the existing benchmark evidence. Keep references to the successful dry-run benchmark and keep limitations explicit.',
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while these doc repairs are being written.',
      ].join(' ');
    }
    if (missingFiles.length > 0) {
      const repairPaths = Array.from(new Set([
        ...missingFiles,
        DATABASE_LAB_DESIGN_QUALITY_FILE,
      ]));
      return [
        buildWriteOnlyRepairPrelude(repairPaths),
        `These required files are still missing and must be repaired before any benchmark command can run: ${missingFiles.join(', ')}.`,
        `Do not emit create_folder or run_command in this turn. First write the missing database design and prototype files under ${DATABASE_LAB_ROOT}/.`,
        `Also write or repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so it lists designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files you just wrote.`,
        `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}: ${existingDesignDocFiles.join(', ') || DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}.`,
        `implementedModules must point to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/, such as: ${DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.join(', ')}.`,
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE. Do not use BLOCKED.',
        'The next turn can execute the benchmark only after these files exist.',
      ].join(' ');
    }
    return [
      buildJsonToolCallPrelude(),
      `The database design package must live under ${DATABASE_LAB_ROOT}/. Produce real verification evidence now.`,
      `Read these exact files first only if you need to confirm their contents: ${DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}, ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, ${DATABASE_LAB_PROTOTYPE_DIR}/README.md, and ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js.`,
      `Then execute a real benchmark-related command from ${DATABASE_LAB_PROTOTYPE_DIR}. Do not use ${DATABASE_LAB_ROOT}/package.json; the Node project root is ${DATABASE_LAB_PROTOTYPE_DIR}.`,
      'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
      'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"npm run build","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
      'If the prototype scripts are missing or broken, repair the real files first and then execute the verification command.',
      successfulRunIds.length > 0
        ? `If a benchmark-related command already succeeded in this thread, cite one of these invocation ids in the result file and quality report: ${successfulRunIds.join(', ')}.`
        : 'After the benchmark command succeeds, capture the real invocation id and cite it in the result file and quality report.',
      `sourceInvocationId must be the literal tool_... id of the successful run_command. Do not use placeholders such as pending_command_result or result_pending.`,
      `After the benchmark command succeeds, write ${DATABASE_LAB_BENCH_RESULT_FILE} with top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs. You may keep extra fields such as config, operations, engineStats, or mysqlParity.`,
      `Then write ${DATABASE_LAB_VERIFY_QUALITY_FILE} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary. resultFile should be ${DATABASE_LAB_BENCH_RESULT_FILE}.`,
      `implementedModules must point to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/. Do not claim verification success while ${DATABASE_LAB_PROTOTYPE_DIR}/src/ is empty or stub-only.`,
      'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE until the benchmark and evidence files are complete. Do not use BLOCKED.',
      'After command results exist, the next turn can summarize what was actually verified and what remains unproven about MySQL-nearness.',
    ].join(' ');
  }

  if (correctionKind === 'AWAITING_TRACKER') {
    if (spec.id === 'docs-normalize-batch') {
      return buildOutputAndTrackerCorrection('The output must list only files that were actually written under normalized/, and files_created must match that exact written set.');
    }
    if (spec.id === 'docs-synthesize-handbook') {
      return buildOutputAndTrackerCorrection('The output must list only handbook files that were actually written, and the details must reference the real source filenames you used.');
    }
    if (spec.id.startsWith('path-blog-')) {
      if (!externalBlogWriteSatisfied) {
        return buildPathBlogToolPrompt();
      }
      return buildOutputAndTrackerCorrection(`The output must reflect only files that were really written into ${targetExternalPath}; do not describe planned work as completed work.`);
    }
    if (spec.id.startsWith('system-') || spec.id.startsWith('desktop-')) {
      return buildOutputAndTrackerCorrection('Base every system or application claim strictly on successful run_command evidence from this thread.');
    }
    if (spec.id.startsWith('database-near-mysql-')) {
      return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, and separate verified prototype behavior from unproven MySQL-nearness claims.`);
    }
    return buildOutputAndTrackerCorrection('Base every artifact path and claim on successful tool results from this thread.');
  }

  if (correctionKind === 'AWAITING_OUTPUT_CORRECTION') {
    if (spec.id === 'docs-normalize-batch') {
      return buildOutputAndTrackerCorrection(`producedFiles must list only files that were actually written under normalized/, files_created must match that exact written set, and issues must mention any remaining quality failures: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id === 'docs-synthesize-handbook') {
      return buildOutputAndTrackerCorrection(`producedFiles must list only handbook files that were actually written, the details must reference the real source filenames you used, and issues must mention any remaining quality failures: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id === 'system-health-audit') {
      const hasSystemAuditQualityIssue =
        qualityAcceptance?.verdict === 'failed'
        || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
      if (hasSystemAuditQualityIssue) {
        return buildSystemAuditToolPrompt();
      }
      return buildOutputAndTrackerCorrection(`Base every system claim strictly on successful run_command evidence from this thread, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id === 'database-near-mysql-design') {
      if (shouldFinalizeDatabaseLabDesign) {
        return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
      }
      const hasDatabaseQualityIssue =
        qualityAcceptance?.verdict === 'failed'
        || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
      if (hasDatabaseQualityIssue) {
        return buildDatabaseLabScaffoldPrompt();
      }
      return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified scaffold work from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id === 'database-near-mysql-verify') {
      const hasDatabaseQualityIssue =
        qualityAcceptance?.verdict === 'failed'
        || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
      if (hasDatabaseQualityIssue) {
        return buildDatabaseLabVerificationPrompt();
      }
      return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified prototype behavior from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id.startsWith('path-blog-')) {
      if (!externalBlogWriteSatisfied) {
        return buildPathBlogToolPrompt();
      }
      return buildOutputAndTrackerCorrection(`The output must reflect the files that were really written into ${targetExternalPath}; do not describe planned work as completed work.`);
    }
    if (spec.id.startsWith('system-') || spec.id.startsWith('desktop-')) {
      return buildOutputAndTrackerCorrection(`Base every system or application claim strictly on successful run_command evidence from this thread, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    if (spec.id.startsWith('database-near-mysql-')) {
      return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified prototype behavior from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
    }
    return buildOutputAndTrackerCorrection('Base every artifact path and claim on successful tool results from this thread.');
  }

  const qualityNeedsEvidence =
    qualityAcceptance?.profileId
    && qualityAcceptance.verdict === 'failed'
    && (qualityAcceptance.requiredNextEvidence?.length ?? 0) > 0;
  if (qualityNeedsEvidence) {
    if (spec.id.startsWith('path-blog-')) {
      return buildPathBlogToolPrompt();
    }
    if (spec.id === 'docs-normalize-batch') {
      return buildDocsNormalizeToolPrompt();
    }
    if (spec.id === 'docs-synthesize-handbook') {
      return buildDocsSynthesizeToolPrompt();
    }
    if (spec.id === 'system-health-audit') {
      return buildSystemAuditToolPrompt();
    }
    if (spec.id === 'desktop-ops-followup') {
      return buildDesktopObservationToolPrompt();
    }
    if (spec.id === 'database-near-mysql-design') {
      if (shouldFinalizeDatabaseLabDesign) {
        return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
      }
      return buildDatabaseLabScaffoldPrompt();
    }
    if (spec.id === 'database-near-mysql-verify') {
      return buildDatabaseLabVerificationPrompt();
    }
  }

  if (qualityAcceptance?.profileId && qualityAcceptance.verdict === 'failed' && correctionKind !== 'AWAITING_TOOL_ACTION') {
    if (spec.id === 'system-health-audit') {
      return buildSystemAuditToolPrompt();
    }
    const failedChecks = qualityAcceptance.failedChecks.join(', ') || 'quality gate failed';
    const nextEvidence = qualityAcceptance.requiredNextEvidence.join(', ') || 'no additional evidence was projected';
    return buildOutputAndTrackerCorrection(
      `Fix these structured quality failures before claiming completion: ${failedChecks}. Required next evidence: ${nextEvidence}.`
    );
  }

  if (spec.id === 'database-near-mysql-verify' && databaseLabVerificationSatisfied && deterministicAcceptance?.verdict === 'passed') {
    return undefined;
  }

  if (shouldFinalizeDatabaseLabDesign) {
    return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
  }

  if (spec.id === 'database-near-mysql-design' && databaseLabArtifactSatisfied && databaseLabBenchSatisfied && deterministicAcceptance?.verdict === 'passed') {
    return undefined;
  }

  if (spec.id === 'desktop-ops-followup' && desktopEvidenceSatisfied && deterministicAcceptance?.verdict === 'passed') {
    return undefined;
  }

  if (spec.id === 'desktop-ops-followup' && !desktopEvidenceSatisfied) {
    return buildDesktopObservationToolPrompt();
  }

  if (spec.id === 'database-near-mysql-design' && !databaseLabArtifactSatisfied) {
    return buildDatabaseLabScaffoldPrompt();
  }

  if (spec.id === 'database-near-mysql-design' && !hasDatabaseLabRequiredWorkspaceShape(scenarioState)) {
    return buildDatabaseLabScaffoldPrompt();
  }

  if (spec.id === 'database-near-mysql-design' && !databaseLabBenchSatisfied) {
    return buildDatabaseLabScaffoldPrompt();
  }

  if (spec.id === 'database-near-mysql-verify' && (!hasDatabaseLabRequiredWorkspaceShape(scenarioState) || !databaseLabVerificationSatisfied)) {
    return buildDatabaseLabVerificationPrompt();
  }

  if (spec.id === 'database-near-mysql-verify' && toolExecutionFailure) {
    return buildOutputAndTrackerCorrection(`Quote the exact benchmark or prototype execution blocker, keep producedFiles limited to real files written under ${DATABASE_LAB_ROOT}/, and state clearly what was verified versus still unproven.`);
  }

  if (correctionKind === 'AWAITING_TOOL_ACTION') {
    if (spec.id.startsWith('docs-')) {
      if (spec.id === 'docs-normalize-batch') {
        return buildDocsNormalizeToolPrompt();
      }
      return buildDocsSynthesizeToolPrompt();
    }
    if (spec.id.startsWith('system-') || spec.id.startsWith('desktop-')) {
      if (spec.id === 'system-health-audit') {
        return buildSystemAuditToolPrompt();
      }
      return buildDesktopObservationToolPrompt();
    }
    if (spec.id === 'database-near-mysql-design') {
      if (shouldFinalizeDatabaseLabDesign) {
        return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
      }
      return buildDatabaseLabScaffoldPrompt();
    }
    if (spec.id === 'database-near-mysql-verify') {
      return buildDatabaseLabVerificationPrompt();
    }
    return buildPathBlogToolPrompt();
  }

  if (spec.id.startsWith('path-blog-') && !toolEvidenceSatisfied && !artifactEvidenceSatisfied) {
    return buildPathBlogToolPrompt();
  }

  if (missingVerificationEvidence) {
    if (spec.id === 'system-health-audit') {
      return buildSystemAuditToolPrompt();
    }
    if (spec.id === 'desktop-ops-followup') {
      return buildDesktopObservationToolPrompt();
    }
    if (spec.id === 'database-near-mysql-verify') {
      return buildDatabaseLabVerificationPrompt();
    }
  }

  if (spec.id === 'database-near-mysql-verify' && !databaseLabVerificationSatisfied) {
    return buildDatabaseLabVerificationPrompt();
  }

  return undefined;
}

function buildScenarioSpecsLive() {
  return [
    {
      id: 'path-blog-greenfield',
      title: 'Real Task Wave: Path Blog Greenfield',
      intent: [
        `Create a blog website directly in ${targetExternalPath}.`,
        'The result should feel elegant, fast to interact with, and visually memorable.',
        `Write real files into ${targetExternalPath}. At minimum deliver index.html, styles.css, and script.js in that external path.`,
        'Task-workspace output is allowed only as an intermediate step and does not count as the final delivery.',
        'If the live runtime cannot really deliver files to that path, state the blocker explicitly instead of pretending the task succeeded.',
      ].join(' '),
      pathPolicy: 'ask_if_unclear',
      timeoutMs: 210_000,
      stopOnArtifactUnresolved: true,
      unit: {
        role: 'BlogArchitect',
        goal: `Create the requested blog site directly in ${targetExternalPath} and make the final delivery path explicit.`,
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'web_experience',
        taskScope: `The final website must live in ${targetExternalPath}. Workspace-only artifacts are not an acceptable final answer. The minimum external deliverables are index.html, styles.css, and script.js.`,
      },
    },
    {
      id: 'path-blog-followup',
      title: 'Real Task Wave: Path Blog Followup',
      intent: [
        `Continue iterating on the blog website in ${targetExternalPath}.`,
        'Add at least one clearly visible feature or interaction improvement.',
        'Do not switch the final delivery back into task workspace and do not answer with prose-only change descriptions.',
        `Keep using ${targetExternalPath} as the final destination. If the previous scenario did not really land there, say so explicitly and describe the blocker.`,
      ].join(' '),
      pathPolicy: 'ask_if_unclear',
      timeoutMs: 210_000,
      stopOnArtifactUnresolved: true,
      unit: {
        role: 'BlogEnhancer',
        goal: `Apply a real follow-up improvement directly in ${targetExternalPath}.`,
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'web_experience',
        taskScope: `Do not switch back to task workspace as the final destination. The website must still live in ${targetExternalPath}.`,
      },
    },
    {
      id: 'docs-normalize-batch',
      title: 'Real Task Wave: Docs Normalize Batch',
      intent: [
        'The task workspace contains a batch of messy Markdown files under incoming/.',
        'Read the real seeded files incoming/raw-product-notes.md, incoming/content-roadmap draft.md, and incoming/launch-retro.MD.',
        'Normalize them into a coherent documentation set under normalized/.',
        'Write normalized/index.md plus at least three additional normalized Markdown files with consistent headings, naming, and cross references.',
        'Do not claim files that were not actually written.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      unit: {
        role: 'DocNormalizer',
        goal: 'Normalize the seeded Markdown batch into normalized/ with a stable index and cross references.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'docs_normalize',
        taskScope: 'Read only from incoming/ and write the cleaned documentation set into normalized/. The output must be real files, not a plan.',
      },
    },
    {
      id: 'docs-synthesize-handbook',
      title: 'Real Task Wave: Docs Synthesize Handbook',
      intent: [
        'The task workspace contains a small structured document set under source/.',
        'Read the real seeded files source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',
        'Synthesize them into handbook/README.md, handbook/index.md, handbook/summary.md, and handbook/decision-log.md.',
        'Your conclusions must be grounded in those exact source files. Do not invent filenames or references.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      unit: {
        role: 'KnowledgeSynthesizer',
        goal: 'Synthesize the seeded Markdown set into a small handbook package under handbook/.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'docs_synthesize',
        taskScope: 'Read only from source/ and write the synthesized handbook outputs into handbook/.',
      },
    },
    {
      id: 'system-health-audit',
      title: 'Real Task Wave: System Health Audit',
      intent: [
        'Inspect the current computer state and provide practical recommendations.',
        'Every claim must be grounded in real host-observation evidence, such as processes, memory, services, disk, or operating-system status.',
        'Use Windows-friendly real commands. If live runtime lacks host observation capability, state that blocker explicitly instead of inventing results.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 180_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'SystemAuditor',
        goal: 'Audit the current machine state with real host observations and give grounded advice.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        qualityProfileId: 'system_audit',
        taskScope: 'Do not claim any system fact unless it comes from real host-observation evidence.',
      },
    },
    {
      id: 'desktop-ops-followup',
      title: 'Real Task Wave: Desktop Ops Followup',
      intent: [
        'Perform a stronger follow-up desktop or application-level observation task based on the system audit.',
        'At minimum, inspect real desktop-facing processes or application state on this Windows machine.',
        'If live runtime cannot do desktop or application observation, explain that capability boundary clearly instead of fabricating actions.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 180_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'DesktopOperator',
        goal: 'Perform or explicitly block a stronger desktop-level follow-up task with real evidence.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        qualityProfileId: 'desktop_observation',
        taskScope: 'This task requires real desktop or application observation. Do not fabricate desktop actions.',
      },
    },
    {
      id: 'database-near-mysql-design',
      title: 'Real Task Wave: Database Near MySQL Design',
      intent: [
        'Design a MySQL-like relational OLTP database system in the task workspace.',
        'Treat near-MySQL performance as a target profile, not as a proven measured claim.',
        `Write the design package into ${DATABASE_LAB_DESIGN_DIR}/ and a runnable Node.js prototype scaffold into ${DATABASE_LAB_PROTOTYPE_DIR}/.`,
        'Read the seeded brief files under brief/ and ground the design in those exact workload, target, and constraint notes.',
        'The design must explicitly cover storage layout, indexes, transactions or concurrency control, WAL or recovery, cache or buffer-pool behavior, SQL compatibility scope, and benchmark dimensions.',
        'The prototype must include a real package.json, source files, and a synthetic benchmark scaffold.',
        'Do not claim that the system already matches MySQL performance. Only describe the target envelope, architecture choices, and how the prototype would be measured.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 420_000,
      unit: {
        role: 'DatabaseArchitect',
        goal: 'Produce a grounded database design package and a runnable Node.js prototype scaffold under database-lab/.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'database_near_mysql_design',
        taskScope: `Write the design package into ${DATABASE_LAB_ROOT}/. The work must stay grounded in brief/ and include both design documents and a prototype scaffold with a benchmark entrypoint.`,
      },
    },
    {
      id: 'database-near-mysql-verify',
      title: 'Real Task Wave: Database Near MySQL Verify',
      intent: [
        'Continue by validating and tightening the MySQL-like database design and prototype in the task workspace.',
        `Use the existing files under ${DATABASE_LAB_ROOT}/, execute a real synthetic benchmark scaffold or a dry-run benchmark command, and then update the design notes with the observed result.`,
        'Clearly separate verified prototype behavior from unproven MySQL-nearness claims.',
        'Do not invent benchmark success. Use real command output and keep any limitation explicit.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'DatabaseVerifier',
        goal: 'Verify the benchmark scaffold and tighten the MySQL-like database design with real execution evidence.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        qualityProfileId: 'database_near_mysql_verify',
        taskScope: `Validate the design honestly with real command evidence from ${DATABASE_LAB_PROTOTYPE_DIR}. A textual guess is not enough.`,
      },
    },
  ];
}

function filterScenarioSpecs(specs) {
  const raw = process.env.REAL_TASK_WAVE_SCENARIOS ?? '';
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return specs;
  }
  const requested = new Set(ids);
  return specs.filter((spec) => requested.has(spec.id));
}

function scenarioRequiresStrongLiveModel(spec) {
  return scenarioRequiresStrongLiveModelFromPack(spec.id);
}

function resolveRealTaskWaveLiveModel(specs) {
  const explicitModel = process.env.REAL_TASK_WAVE_LIVE_MODEL?.trim();
  if (explicitModel) {
    return explicitModel;
  }
  return specs.some((spec) => scenarioRequiresStrongLiveModel(spec))
    ? XIAOMI_MIMO_STRONG_MODEL
    : XIAOMI_MIMO_FAST_MODEL;
}

async function prepareScenarioWorkspace(spec, taskId, scenarioResultsById, context = {}) {
  const seedFiles = getScenarioSeedFiles(spec.id);
  if (seedFiles) {
    return seedWorkspaceFiles(taskId, seedFiles);
  }

  const reuseWorkspace = getScenarioReuseWorkspace(spec.id);
  if (reuseWorkspace) {
    const previous = scenarioResultsById.get(reuseWorkspace.sourceScenarioId);
    const previousWorkspace = previous?.workspaceDir ?? null;
    if (previousWorkspace && fsSync.existsSync(previousWorkspace)) {
      await copyDirectoryContents(previousWorkspace, getTaskWorkspaceDir(taskId));
      return [
        {
          copiedFrom: previousWorkspace,
          copiedTo: getTaskWorkspaceDir(taskId),
        },
      ];
    }
    const fallbackSeed = await findReusableScenarioWorkspace(
      reuseWorkspace.sourceScenarioId,
      (scenarioResult) => reuseWorkspace.acceptArtifactNotes(scenarioResult?.artifactAudit?.notes ?? {})
    );
    if (fallbackSeed) {
      await copyDirectoryContents(fallbackSeed.workspaceDir, getTaskWorkspaceDir(taskId));
      return [
        {
          copiedFrom: fallbackSeed.workspaceDir,
          copiedTo: getTaskWorkspaceDir(taskId),
          source: reuseWorkspace.source,
          scenarioResultPath: fallbackSeed.scenarioResultPath,
        },
      ];
    }
  }

  return [];
}

async function runHumanSurfaceCheck(serverUrl, taskId, scenarioDir) {
  const stdinText = ['/task', '/diagnostics', '/exit', ''].join(os.EOL);
  const result = await runCli(
    ['--server', serverUrl, 'chat', '--format', 'human', '--task', taskId],
    {},
    { stdinText },
  );
  const outputPath = path.join(scenarioDir, 'human-cli.txt');
  await writeText(outputPath, result.stdout);
  return {
    exitCode: result.exitCode,
    outputPath,
    pass:
      result.stdout.includes(taskId)
      && result.stdout.includes('Current status:')
      && result.stdout.includes('[diagnostics]')
      && result.stdout.includes('Suggested action:')
      && result.stdout.includes('Acceptance:')
      && result.stdout.includes('Quality:'),
    stdoutPreview: result.stdout.slice(0, 800),
  };
}

async function runAgentSurfaceCheck(serverUrl, taskId, scenarioDir) {
  const stdinText = ['/task', '/diagnostics', '/exit', ''].join(os.EOL);
  const result = await runCli(
    ['--server', serverUrl, 'tasks', 'chat', taskId, '--format', 'ndjson'],
    {},
    { stdinText },
  );
  const outputPath = path.join(scenarioDir, 'agent-cli.ndjson');
  await writeText(outputPath, result.stdout);
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const envelopes = [];
  for (const line of lines) {
    try {
      envelopes.push(JSON.parse(line));
    } catch {
      // Keep raw output on disk even if a line is malformed.
    }
  }
  const hasTaskEnvelope = envelopes.some((envelope) => envelope?.type === 'task' && envelope?.task?.taskId === taskId);
  const diagnosticsEnvelope = envelopes.find((envelope) => envelope?.type === 'diagnostics' && envelope?.taskId === taskId) ?? null;
  return {
    exitCode: result.exitCode,
    outputPath,
    envelopeCount: envelopes.length,
    pass: hasTaskEnvelope && Boolean(diagnosticsEnvelope?.data?.acceptance?.quality),
    diagnosticsAcceptance: diagnosticsEnvelope?.data?.acceptance ?? null,
  };
}

async function verifyWebToolActivityIcons(page) {
  const cardCount = await page.locator('[data-testid="task-tool-activity"]').count();
  if (cardCount === 0) {
    return {
      pass: true,
      skipped: true,
      reason: 'no_tool_activity_cards_visible',
      cardCount,
      iconCount: 0,
    };
  }
  const iconCount = await page.locator('[data-testid="task-tool-activity-icon"]').count();
  if (iconCount < cardCount) {
    throw new Error(`Tool activity cards rendered without icon nodes. cards=${cardCount} icons=${iconCount}`);
  }
  return {
    pass: true,
    skipped: false,
    cardCount,
    iconCount,
  };
}

async function verifyWebComposerNoJump(page) {
  const textarea = page.locator('[data-testid="task-continue-message"]').first();
  if ((await textarea.count()) === 0 || !(await textarea.isVisible().catch(() => false))) {
    const expandFollowUp = page.locator('[data-testid="task-action-expand-follow-up"]').first();
    if ((await expandFollowUp.count()) > 0 && await expandFollowUp.isVisible().catch(() => false)) {
      await expandFollowUp.click();
      await page.waitForTimeout(200);
    }
  }
  if ((await textarea.count()) === 0 || !(await textarea.isVisible().catch(() => false))) {
    return {
      pass: true,
      skipped: true,
      reason: 'no_continue_textarea_visible',
    };
  }

  const draftValue = `real-task-wave-anchor-${Date.now()}`;
  await textarea.scrollIntoViewIfNeeded();
  await textarea.fill(draftValue);

  async function captureComposerSnapshot() {
    return page.evaluate(() => {
      const textareaNode = document.querySelector('[data-testid="task-continue-message"]');
      const composerNode = document.querySelector('[data-testid="task-composer-card"]');
      const draftNoticeNode = document.querySelector('[data-testid="task-composer-draft-lock-notice"]');
      const actionNode = document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"], [data-testid="task-action-use-recommended-path"]');
      const titleNode = composerNode?.querySelector('p');
      if (!(textareaNode instanceof HTMLTextAreaElement) || !(composerNode instanceof HTMLElement)) {
        return null;
      }
      const textareaRect = textareaNode.getBoundingClientRect();
      const composerRect = composerNode.getBoundingClientRect();
      return {
        value: textareaNode.value,
        placeholder: textareaNode.placeholder,
        composerTop: composerRect.top,
        textareaTop: textareaRect.top,
        actionLabel: actionNode instanceof HTMLElement ? actionNode.innerText.trim() : null,
        composerTitle: titleNode instanceof HTMLElement ? titleNode.innerText.trim() : null,
        draftNoticeVisible: draftNoticeNode instanceof HTMLElement && draftNoticeNode.getClientRects().length > 0,
      };
    });
  }

  const before = await captureComposerSnapshot();
  if (!before) {
    throw new Error('Could not capture the pre-refresh composer snapshot.');
  }

  await page.locator('[data-testid="task-action-refresh"]').click();
  await page.waitForTimeout(300);

  const contextToggle = page.locator('[data-testid="task-context-toggle"]').first();
  if ((await contextToggle.count()) > 0 && await contextToggle.isVisible().catch(() => false)) {
    await contextToggle.click();
    await page.waitForTimeout(150);
    await contextToggle.click();
    await page.waitForTimeout(150);
  }

  const after = await captureComposerSnapshot();
  if (!after) {
    throw new Error('Composer disappeared after refresh/details toggles.');
  }

  const actionStable = after.actionLabel === before.actionLabel || after.draftNoticeVisible;
  const unexpectedRestart = before.actionLabel !== 'Restart task' && after.actionLabel === 'Restart task' && !after.draftNoticeVisible;
  const topStable = Math.abs(after.textareaTop - before.textareaTop) <= 24 && Math.abs(after.composerTop - before.composerTop) <= 24;
  if (after.value !== draftValue || !actionStable || unexpectedRestart || !topStable) {
    throw new Error(`Composer moved or changed unexpectedly after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  return {
    pass: true,
    skipped: false,
    before,
    after,
  };
}

async function runWebSurfaceCheck(page, frontendBaseUrl, scenario, taskState, screenshotDir) {
  const taskId = taskState.summary.taskId;
  const targetUrl = `${frontendBaseUrl}/tasks?task=${encodeURIComponent(taskId)}`;
  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="tasks-page"]', { timeout: 60_000 });

  const taskLocator = page.locator('[data-testid="task-list-item"]:visible').filter({
    hasText: scenario.title,
  }).first();
  if (await taskLocator.count()) {
    await taskLocator.click();
  }

  const inspectorVisible = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="task-inspector-scroll"]');
    return node instanceof HTMLElement && node.getClientRects().length > 0;
  });
  if (!inspectorVisible) {
    await page.locator('[data-testid="task-context-toggle"]').click();
    await page.waitForSelector('[data-testid="task-inspector-scroll"]', { timeout: 15_000 });
  }

  const advancedSummary = page.locator('[data-testid="task-advanced-summary"]').first();
  if (await advancedSummary.count()) {
    const detailsOpen = await advancedSummary.evaluate((node) => node instanceof HTMLDetailsElement && node.open);
    if (!detailsOpen) {
      const summaryToggle = advancedSummary.locator('summary').first();
      await summaryToggle.scrollIntoViewIfNeeded();
      await summaryToggle.click({ timeout: 5_000 });
      await page.waitForSelector('[data-testid="task-tab-summary"]', { timeout: 15_000 });
    }
  }

  const tabIds = ['summary', 'acceptance', 'diagnostics', 'events', 'artifacts'];
  const visibleTabs = [];
  const tabSnapshots = {
    acceptance: '',
    diagnostics: '',
    artifacts: '',
  };
  for (const tabId of tabIds) {
    const tab = page.locator(`[data-testid="task-tab-${tabId}"]:visible`).first();
    if (await tab.count()) {
      try {
        await tab.scrollIntoViewIfNeeded();
        await tab.click({ timeout: 3_000 });
        visibleTabs.push(tabId);
        if (tabId === 'acceptance') {
          const acceptancePanel = page.locator('[data-testid="task-acceptance-panel"]').first();
          await acceptancePanel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);
          if (await acceptancePanel.count()) {
            tabSnapshots.acceptance = await acceptancePanel.innerText().catch(() => '');
          }
          const qualityPanel = page.locator('[data-testid="task-acceptance-quality-review"]').first();
          await qualityPanel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);
        }
        if (tabId === 'diagnostics' || tabId === 'artifacts') {
          const diagnosticsPre = advancedSummary.locator('pre').first();
          await diagnosticsPre.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);
          if (await diagnosticsPre.count()) {
            const snapshotText = await diagnosticsPre.innerText().catch(() => '');
            if (tabId === 'diagnostics') {
              tabSnapshots.diagnostics = snapshotText;
            }
            if (tabId === 'artifacts') {
              tabSnapshots.artifacts = snapshotText;
            }
          }
        }
        await page.waitForTimeout(200);
      } catch {
        // Keep the run moving; the pass/fail decision below still records missing tabs.
      }
    }
  }

  const screenshotPath = await captureScreenshot(page, path.join(screenshotDir, `${scenario.id}.png`));
  const body = await page.locator('body').innerText();
  const acceptanceVerdict = taskState.debug?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
  const qualityVerdict = taskState.debug?.executionSummary?.acceptance?.quality?.verdict ?? null;
  const lifecycleStatus = taskState.summary.lifecycleStatus ?? '';
  const statusLabel = taskState.task?.statusSummary?.label ?? '';
  const nextActionLabel = taskState.summary.nextAction ?? '';
  const acceptanceText = tabSnapshots.acceptance.toLowerCase();
  const diagnosticsText = tabSnapshots.diagnostics.toLowerCase();
  const expectedAcceptanceToken = acceptanceVerdict ? String(acceptanceVerdict).toLowerCase() : null;
  const normalizedBody = body.toLowerCase();
  const hasStatusSignal = [lifecycleStatus, statusLabel, nextActionLabel]
    .filter(Boolean)
    .some((token) => normalizedBody.includes(String(token).toLowerCase()));
  const toolIcons = await verifyWebToolActivityIcons(page);
  const composerStability = await verifyWebComposerNoJump(page);
  return {
    url: targetUrl,
    screenshotPath,
    visibleTabs,
    tabSnapshots,
    uiSignoff: {
      toolIcons,
      composerStability,
    },
    pass:
      normalizedBody.includes(scenario.title.toLowerCase())
      && hasStatusSignal
      && (!expectedAcceptanceToken || acceptanceText.includes(expectedAcceptanceToken))
      && (!qualityVerdict || acceptanceText.includes(String(qualityVerdict).toLowerCase()))
      && visibleTabs.includes('acceptance')
      && visibleTabs.includes('diagnostics')
      && diagnosticsText.includes('"acceptance"')
      && toolIcons.pass
      && composerStability.pass,
    bodyPreview: body.slice(0, 1200),
  };
}

async function maybeRunNodeProjectBuild(projectRoot) {
  const packageJson = await readJsonSafe(path.join(projectRoot, 'package.json'));
  if (!packageJson) {
    return {
      projectRoot,
      packageJsonFound: false,
      install: null,
      build: null,
      preview: null,
      dependencies: [],
      scripts: {},
    };
  }

  const dependencies = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ].sort((left, right) => left.localeCompare(right));
  const result = {
    projectRoot,
    packageJsonFound: true,
    packageName: packageJson.name ?? null,
    dependencies,
    scripts: packageJson.scripts ?? {},
    install: null,
    build: null,
    preview: null,
  };

  result.install = runCommandCapture(npmCommand(), ['install'], {
    cwd: projectRoot,
    timeoutMs: 300_000,
  });

  if (result.install.exitCode === 0 && packageJson.scripts?.build) {
    result.build = runCommandCapture(npmCommand(), ['run', 'build'], {
      cwd: projectRoot,
      timeoutMs: 300_000,
    });
  }

  return result;
}

async function maybePreviewNodeProject(projectRoot, browser, screenshotDir, scenarioId) {
  const packageJson = await readJsonSafe(path.join(projectRoot, 'package.json'));
  if (!packageJson) {
    return {
      attempted: false,
      reason: 'package_json_missing',
    };
  }
  const previewScript = packageJson.scripts?.preview ? 'preview' : packageJson.scripts?.dev ? 'dev' : null;
  if (!previewScript) {
    return {
      attempted: false,
      reason: 'no_preview_or_dev_script',
    };
  }

  const port = await findAvailablePort(6280);
  const serverUrl = `http://127.0.0.1:${port}`;
  const child = spawnNpm(['run', previewScript, '--', '--host', '127.0.0.1', '--port', String(port)], {}, projectRoot);
  const readLogs = collectOutput(child, `preview:${scenarioId}`);

  try {
    await waitForHttp(serverUrl, 60_000);
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(serverUrl, { waitUntil: 'networkidle' });
    const screenshotPath = await captureScreenshot(page, path.join(screenshotDir, `${scenarioId}-preview.png`));
    const bodyText = await page.locator('body').innerText();
    await page.close();
    return {
      attempted: true,
      previewScript,
      serverUrl,
      screenshotPath,
      bodyPreview: bodyText.slice(0, 1000),
      logs: readLogs(),
    };
  } catch (error) {
    return {
      attempted: true,
      previewScript,
      serverUrl,
      error: error instanceof Error ? error.message : String(error),
      logs: readLogs(),
    };
  } finally {
    await terminateChild(child, `preview:${scenarioId}`);
  }
}

async function maybePreviewStaticSite(indexPath, browser, screenshotDir, scenarioId) {
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: 'domcontentloaded' });
    const screenshotPath = await captureScreenshot(page, path.join(screenshotDir, `${scenarioId}-static-preview.png`));
    const bodyText = await page.locator('body').innerText();
    const interactionNodeCount = await page.locator('button, a[href], input, textarea, select, [data-interaction], [role="button"]').count();
    await page.close();
    return {
      attempted: true,
      fileUrl: pathToFileURL(indexPath).href,
      screenshotPath,
      bodyPreview: bodyText.slice(0, 1000),
      interactionNodeCount,
    };
  } catch (error) {
    return {
      attempted: true,
      fileUrl: pathToFileURL(indexPath).href,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runArtifactAudit(spec, scenarioState, browser, hostTruth) {
  const workspaceDir = scenarioState.workspaceDir;
  const workspaceFiles = await listFilesRecursive(workspaceDir, { maxDepth: 6 });
  const workspaceRelativeFiles = workspaceFiles.map((filePath) => normalizeSlashes(path.relative(workspaceDir, filePath)));
  const sharedQuality = evaluateScenarioQuality(spec, scenarioState);

  if (spec.id.startsWith('path-blog-')) {
    const externalFiles = await listFilesRecursive(targetExternalPath, { maxDepth: 6 }).catch(() => []);
    const externalRelativeFiles = externalFiles.map((filePath) => normalizeSlashes(path.relative(targetExternalPath, filePath)));
    const workspaceProjects = await discoverNodeProjects(workspaceDir);
    const externalProjects = await discoverNodeProjects(targetExternalPath).catch(() => []);
    const primaryProject = externalProjects[0] ?? workspaceProjects[0] ?? null;
    const buildAudit = primaryProject ? await maybeRunNodeProjectBuild(path.dirname(primaryProject)) : null;
    const staticIndexPath = externalFiles.find((filePath) => path.basename(filePath).toLowerCase() === 'index.html') ?? null;
    const staticPreviewAudit = !primaryProject && staticIndexPath
      ? await maybePreviewStaticSite(staticIndexPath, browser, screenshotRoot, spec.id)
      : null;
    const previewAudit =
      primaryProject && buildAudit?.build?.exitCode === 0
        ? await maybePreviewNodeProject(path.dirname(primaryProject), browser, screenshotRoot, spec.id)
        : staticPreviewAudit;
    const staticSiteSatisfied =
      Boolean(staticIndexPath)
      && externalRelativeFiles.some((entry) => entry.toLowerCase().endsWith('.css'))
      && externalRelativeFiles.some((entry) => entry.toLowerCase().endsWith('.js'))
      && !staticPreviewAudit?.error;
    const nodeProjectSatisfied = Boolean(primaryProject && (buildAudit?.build?.exitCode === 0 || buildAudit?.scripts?.build == null));
    return {
      workspaceDir,
      workspaceRelativeFiles,
      externalPath: targetExternalPath,
      externalRelativeFiles,
      primaryProjectRoot: primaryProject ? path.dirname(primaryProject) : staticIndexPath ? targetExternalPath : null,
      buildAudit,
      previewAudit,
      pass:
        sharedQuality.verdict === 'passed'
        && externalRelativeFiles.length > 0
        && (nodeProjectSatisfied || staticSiteSatisfied),
      notes: {
        externalProjectCount: externalProjects.length,
        workspaceProjectCount: workspaceProjects.length,
        staticSiteSatisfied,
        sharedQuality,
      },
    };
  }

  if (spec.id === 'docs-normalize-batch') {
    const normalizedFiles = workspaceRelativeFiles.filter((entry) => entry.startsWith('normalized/') && entry.endsWith('.md') && entry !== 'normalized/index.md');
    const indexContent = await fs.readFile(path.join(workspaceDir, 'normalized', 'index.md'), 'utf8').catch(() => '');
    const normalizedContents = await Promise.all(
      normalizedFiles.map(async (relativePath) => ({
        relativePath,
        content: await fs.readFile(path.join(workspaceDir, ...relativePath.split('/')), 'utf8').catch(() => ''),
      })),
    );
    const allHaveHeading = normalizedContents.every((entry) => /^#\s+/m.test(entry.content));
    const indexReferencesAll = normalizedFiles.every((relativePath) => indexContent.includes(path.basename(relativePath)));
    const crossReferenceCount = normalizedContents.filter((entry) => /\[.*\]\(.*\.md\)/.test(entry.content)).length;
    return {
      workspaceDir,
      workspaceRelativeFiles,
      normalizedFiles,
      pass:
        sharedQuality.verdict === 'passed'
        &&
        normalizedFiles.length >= 3
        && allHaveHeading
        && indexContent.includes('#')
        && indexReferencesAll
        && crossReferenceCount >= 2,
      notes: {
        allHaveHeading,
        indexReferencesAll,
        crossReferenceCount,
        sharedQuality,
      },
    };
  }

  if (spec.id === 'docs-synthesize-handbook') {
    const requiredFiles = [
      'handbook/README.md',
      'handbook/index.md',
      'handbook/summary.md',
      'handbook/decision-log.md',
    ];
    const contents = {};
    for (const relativePath of requiredFiles) {
      contents[relativePath] = await fs.readFile(path.join(workspaceDir, ...relativePath.split('/')), 'utf8').catch(() => '');
    }
    const hasAllFiles = requiredFiles.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
    const combinedContent = Object.values(contents).join('\n');
    const sourceMentions =
      /Product Strategy|source\/product-strategy\.md/i.test(combinedContent)
      && /(Operations Decisions|Operational Decisions|source\/ops-decisions\.md)/i.test(combinedContent)
      && /(Editorial Feedback|source\/editorial-feedback\.md)/i.test(combinedContent);
    return {
      workspaceDir,
      workspaceRelativeFiles,
      requiredFiles,
      pass: sharedQuality.verdict === 'passed' && hasAllFiles && sourceMentions,
      notes: {
        hasAllFiles,
        sourceMentions,
        sharedQuality,
      },
    };
  }

  if (spec.id === 'system-health-audit' || spec.id === 'desktop-ops-followup') {
    const summaryText = buildTaskSummaryText(scenarioState);
    const toolEvidenceCount = getVisibleToolActivities(scenarioState).length;
    const successfulDesktopEvidence = hasDesktopObservationEvidence(scenarioState);
    const mentionsHostFacts =
      summaryText.includes(hostTruth.system.csName ?? '')
      || summaryText.includes('CPU')
      || summaryText.includes('memory');
    const mentionsApplicationFacts =
      /\b(explorer|code|msedge|chrome|window|responding|mainwindowtitle)\b/i.test(summaryText);
    const honestBlocker = /cannot|unable|unavailable|no (?:system|desktop|host) tool|blocked/i.test(summaryText)
      || (scenarioState.debug?.executionSummary?.issueSummary ?? '').toLowerCase().includes('tool');
    return {
      workspaceDir,
      workspaceRelativeFiles,
      toolEvidenceCount,
      pass: sharedQuality.verdict === 'passed' && successfulDesktopEvidence && (mentionsHostFacts || mentionsApplicationFacts),
      notes: {
        honestBlocker,
        successfulDesktopEvidence,
        mentionsHostFacts,
        mentionsApplicationFacts,
        hostTruthSummary: {
          csName: hostTruth.system.csName,
        },
        sharedQuality,
      },
    };
  }

  if (spec.id.startsWith('database-near-mysql-')) {
    const prototypeRoot = path.join(workspaceDir, DATABASE_LAB_PROTOTYPE_DIR);
    const buildAudit = fsSync.existsSync(path.join(prototypeRoot, 'package.json'))
      ? await maybeRunNodeProjectBuild(prototypeRoot)
      : null;
    const packageEntryDiagnostics = getDatabaseLabPackageEntryDiagnostics(workspaceDir);
    const designContents = Object.fromEntries(await Promise.all(
      DATABASE_LAB_REQUIRED_DESIGN_FILES.map(async (relativePath) => [
        relativePath,
        await fs.readFile(path.join(workspaceDir, ...relativePath.split('/')), 'utf8').catch(() => ''),
      ]),
    ));
    const combinedDesignContent = Object.values(designContents).join('\n');
    const prototypeSrcFiles = workspaceRelativeFiles.filter((entry) => entry.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
    const hasRequiredDesignFiles = DATABASE_LAB_REQUIRED_DESIGN_FILES.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
    const hasRequiredPrototypeFiles = DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
    const designCoverage = {
      mysqlTarget: /mysql/i.test(combinedDesignContent),
      storageEngine: /(storage engine|page layout|segment|sstable|btree|buffer pool)/i.test(combinedDesignContent),
      indexes: /\bindex(?:es)?\b|btree|hash index/i.test(combinedDesignContent),
      transactions: /\btransaction|mvcc|locking|isolation/i.test(combinedDesignContent),
      recovery: /\bwal|write-ahead|recovery|checkpoint/i.test(combinedDesignContent),
      cache: /\b(buffer pool|page cache|cache|caching)\b/i.test(combinedDesignContent),
      sqlCompatibility: /\bsql\b|parser|planner|dialect|compatib/i.test(combinedDesignContent),
      benchmarkPlan: /\bbenchmark|throughput|latency|p95|workload/i.test(combinedDesignContent),
    };
    const verificationScriptName =
      buildAudit?.scripts?.bench ? 'bench'
        : buildAudit?.scripts?.['dry-run'] ? 'dry-run'
          : null;
    const verificationScriptAudit =
      buildAudit?.packageJsonFound && buildAudit.install?.exitCode === 0 && verificationScriptName
        ? runCommandCapture(npmCommand(), verificationScriptName === 'bench'
          ? ['run', 'bench', '--', '--dry-run']
          : ['run', verificationScriptName], {
            cwd: prototypeRoot,
            timeoutMs: 300_000,
          })
        : null;
    const benchRequiredModuleFiles = mergeDatabaseBenchRequiredModuleFiles(
      getDatabaseLabBenchRequiredModuleFilesFromWorkspace(workspaceDir, workspaceRelativeFiles),
      { includeCoreModuleBaseline: true },
    );
    const runtimeVerificationEvidence = hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
    const blockingMissingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, { scenarioId: spec.id });
    const optionalMissingEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
      ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingMissingEntryRefs.includes(entryRef))
      : [];
    const prototypeReady = Boolean(
      buildAudit?.packageJsonFound
      && buildAudit.install?.exitCode === 0
      && hasRequiredPrototypeFiles
      && prototypeSrcFiles.length > 0
      && packageEntryDiagnostics.invalidPackageJson !== true
      && blockingMissingEntryRefs.length === 0
      && (packageEntryDiagnostics.missingRequiredEntries?.length ?? 0) === 0
      && verificationScriptName
      && verificationScriptAudit?.exitCode === 0
    );
    const designReady = hasRequiredDesignFiles && Object.values(designCoverage).every(Boolean);
    const verifyRuntimeSatisfied = spec.id === 'database-near-mysql-verify' ? runtimeVerificationEvidence : true;
    const artifactProgress = buildDatabaseArtifactProgress(workspaceRelativeFiles, {
      verificationScriptAudit,
      benchRequiredModuleFiles,
      includeVerifyQualityEvidence: spec.id === 'database-near-mysql-verify',
      packageEntryDiagnostics,
      blockingMissingEntryRefs,
      optionalMissingEntryRefs,
      scenarioId: spec.id,
    });
    return {
      workspaceDir,
      workspaceRelativeFiles,
      projectRoot: buildAudit?.projectRoot ?? prototypeRoot,
      buildAudit,
      previewAudit: null,
      pass: sharedQuality.verdict === 'passed' && designReady && prototypeReady && verifyRuntimeSatisfied,
      notes: {
        hasRequiredDesignFiles,
        hasRequiredPrototypeFiles,
        prototypeSrcFileCount: prototypeSrcFiles.length,
        verificationScriptName,
        packageEntryDiagnostics,
        runtimeVerificationEvidence,
        designCoverage,
        verificationScriptAudit,
        artifactProgress,
        sharedQuality,
      },
    };
  }

  return {
    workspaceDir,
    workspaceRelativeFiles,
    pass: sharedQuality.verdict === 'passed',
    notes: { sharedQuality },
  };
}

function classifyScenario(spec, scenarioState, surfaceChecks, artifactAudit) {
  const surfacesPass = surfaceChecks.human.pass && surfaceChecks.agent.pass && surfaceChecks.web.pass;
  const lifecycleStatus = scenarioState.summary.lifecycleStatus;
  const acceptanceVerdict = scenarioState.debug?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
  const qualityVerdict = scenarioState.debug?.executionSummary?.acceptance?.quality?.verdict ?? null;
  const summaryText = buildTaskSummaryText(scenarioState);
  const environmentBlocked = hasEnvironmentBlockerSignal(scenarioState);
  const providerFailureSummary = formatProviderFailureSummary(getScenarioProviderFailure(scenarioState));

  if (!surfacesPass) {
    return {
      classification: 'surface_drift',
      reason: 'Web, Human CLI, and Agent CLI did not all show the expected diagnostics truth for this task.'
    };
  }

  if (spec.id.startsWith('path-blog-')) {
    if (lifecycleStatus === 'COMPLETED' && acceptanceVerdict === 'passed' && qualityVerdict === 'passed' && artifactAudit.pass) {
      return {
        classification: 'passed',
        reason: `${targetExternalPath} contains a real project artifact, the project audit passed, and runtime acceptance truth is clean.`,
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: 'The scenario hit a real provider or network blocker before the external-path delivery flow could complete.',
      };
    }
    const externalFileCount = Array.isArray(artifactAudit.externalRelativeFiles)
      ? artifactAudit.externalRelativeFiles.length
      : 0;
    return {
      classification: externalFileCount > 0 ? 'artifact_failure' : 'product_gap',
      reason: externalFileCount > 0
        ? `Real files landed in ${targetExternalPath}, but the runtime quality gate or artifact audit did not converge cleanly for this scenario.`
        : `The runtime did not deliver real files into ${targetExternalPath}; task-workspace output is not enough for this scenario.`,
    };
  }

  if (spec.id.startsWith('docs-')) {
    if (lifecycleStatus === 'COMPLETED' && acceptanceVerdict === 'passed' && qualityVerdict === 'passed' && artifactAudit.pass) {
      return {
        classification: 'passed',
        reason: 'The documentation outputs were written into the task workspace, passed the structure audit, and runtime acceptance truth is clean.',
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: 'The documentation scenario hit a real provider or network blocker before the artifact set converged.',
      };
    }
    if (!artifactAudit.pass || acceptanceVerdict !== 'passed' || lifecycleStatus !== 'COMPLETED') {
      return {
        classification: 'artifact_failure',
        reason: 'The task did not finish with a clean completed acceptance state and a passing documentation artifact audit.',
      };
    }
  }

  if (spec.id === 'system-health-audit' || spec.id === 'desktop-ops-followup') {
    if (artifactAudit.pass && acceptanceVerdict === 'passed' && qualityVerdict === 'passed' && hasDesktopObservationEvidence(scenarioState)) {
      return {
        classification: 'passed',
        reason: 'The task provided host-grounded evidence, the audit matched it to real machine truth, and runtime acceptance truth is clean.',
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: 'The host-observation scenario hit a real provider or network blocker before the evidence chain converged.',
      };
    }
    if (
      artifactAudit.notes?.honestBlocker
      || /no real host observability|does not provide direct desktop|no desktop automation capabilities available|cannot perform real desktop or application-level operations/i.test(summaryText)
    ) {
      return {
        classification: 'product_gap',
        reason: 'The task surfaced the lack of real host or desktop tooling instead of fabricating a result.',
      };
    }
    return {
      classification: 'artifact_failure',
      reason: 'The task produced system claims that were not backed by host evidence.',
    };
  }

  if (spec.id.startsWith('database-near-mysql-')) {
    const runtimeVerificationEvidence = hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
    const artifactProgressSummary = summarizeDatabaseArtifactProgress(artifactAudit.notes?.artifactProgress);
    if (artifactAudit.pass && lifecycleStatus === 'COMPLETED' && acceptanceVerdict === 'passed' && qualityVerdict === 'passed') {
      return {
        classification: 'passed',
        reason: 'The database design package and prototype scaffold passed audit, and runtime acceptance truth is clean.',
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: `The database design scenario hit a real provider or network blocker before the design package fully converged. Current artifact progress: ${artifactProgressSummary}.${providerFailureSummary ? ` Provider failure: ${providerFailureSummary}.` : ''}`,
      };
    }
    if (spec.id === 'database-near-mysql-verify' && !runtimeVerificationEvidence) {
      return {
        classification: 'artifact_failure',
        reason: 'The verify scenario did not leave real benchmark or prototype execution evidence in the runtime tool trace.',
      };
    }
    if (artifactAudit.buildAudit?.packageJsonFound && artifactAudit.notes?.verificationScriptAudit?.exitCode && artifactAudit.notes.verificationScriptAudit.exitCode !== 0) {
      return {
        classification: 'artifact_failure',
        reason: `The prototype exists, but the benchmark or verification script did not execute cleanly. Current artifact progress: ${artifactProgressSummary}.`,
      };
    }
    return {
      classification: 'artifact_failure',
      reason: `The database design package did not satisfy the required document, prototype, or verification audit bar. Current artifact progress: ${artifactProgressSummary}.`,
    };
  }

  if (lifecycleStatus === 'COMPLETED' && acceptanceVerdict === 'passed' && artifactAudit.pass) {
    return {
      classification: 'passed',
      reason: 'The task reached a completed state and the artifact audit passed.',
    };
  }

  return {
    classification: 'artifact_failure',
    reason: 'The task did not satisfy the required completion or artifact quality bar.',
  };
}

function summarizeConfirmedIssues(report) {
  const issues = [];
  const scenarioById = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
  const environmentBlockedScenarios = report.scenarios
    .filter((scenario) => scenario.classification === 'environment_blocker')
    .map((scenario) => scenario.id);
  if (environmentBlockedScenarios.length > 0) {
    issues.push({
      issue: 'provider_or_network_environment_blocker',
      evidence: 'At least one real-task-wave scenario failed because the live provider or network layer timed out or returned an upstream blocker.',
      scenarios: environmentBlockedScenarios,
    });
  }
  const blogScenarios = ['path-blog-greenfield', 'path-blog-followup']
    .map((id) => scenarioById.get(id))
    .filter(Boolean);
  const failingBlogScenarios = blogScenarios
    .filter((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')
    .map((scenario) => scenario.id);
  const undeliveredBlogScenarios = blogScenarios
    .filter((scenario) => (
      (scenario.artifactAudit?.externalRelativeFiles?.length ?? 0) === 0
      && (scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')
    ))
    .map((scenario) => scenario.id);
  if (undeliveredBlogScenarios.length > 0) {
    issues.push({
      issue: 'absolute_external_path_delivery_unsupported',
      evidence: `Blog path scenarios did not deliver real files into ${targetExternalPath}.`,
      scenarios: undeliveredBlogScenarios,
    });
  }
  const lowQualityBlogScenarios = blogScenarios
    .filter((scenario) => failingBlogScenarios.includes(scenario.id) && (scenario.artifactAudit?.externalRelativeFiles?.length ?? 0) > 0)
    .map((scenario) => scenario.id);
  if (lowQualityBlogScenarios.length > 0) {
    issues.push({
      issue: 'external_blog_quality_gate_failed',
      evidence: `Blog files landed in ${targetExternalPath}, but quality evidence or artifact audit did not pass.`,
      scenarios: lowQualityBlogScenarios,
    });
  }
  const systemScenarios = ['system-health-audit', 'desktop-ops-followup']
    .map((id) => scenarioById.get(id))
    .filter(Boolean);
  if (systemScenarios.some((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')) {
    issues.push({
      issue: 'host_and_desktop_observation_gap',
      evidence: 'System and desktop scenarios could not produce real host-evidence-backed observations through the default live runtime.',
      scenarios: systemScenarios
        .filter((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')
        .map((scenario) => scenario.id),
    });
  }
  const databaseScenarios = ['database-near-mysql-design', 'database-near-mysql-verify']
    .map((id) => scenarioById.get(id))
    .filter(Boolean);
  if (databaseScenarios.some((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')) {
    issues.push({
      issue: 'mysql_like_database_design_incomplete',
      evidence: 'The database design scenarios did not prove a complete design package and benchmark-capable prototype through the default live runtime.',
      scenarios: databaseScenarios
        .filter((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')
        .map((scenario) => scenario.id),
    });
  }
  if (report.scenarios.some((scenario) => scenario.classification === 'surface_drift')) {
    issues.push({
      issue: 'surface_truth_inconsistency',
      evidence: 'At least one scenario failed the Web / Human CLI / Agent CLI consistency check.',
      scenarios: report.scenarios.filter((scenario) => scenario.classification === 'surface_drift').map((scenario) => scenario.id),
    });
  }
  if (report.scenarios.some((scenario) => scenario.classification === 'artifact_failure')) {
    issues.push({
      issue: 'artifact_quality_or_completeness_gap',
      evidence: 'At least one scenario produced artifacts that did not satisfy the post-run audit.',
      scenarios: report.scenarios.filter((scenario) => scenario.classification === 'artifact_failure').map((scenario) => scenario.id),
    });
  }
  return issues;
}

function buildMarkdownReport(report) {
  const lines = [
    '# Real Task Wave Report',
    '',
    `- Generated at: ${report.generatedAt}`,
    `- Provider: ${report.provider.id}`,
    `- Server URL: ${report.server.backendUrl}`,
    `- Frontend URL: ${report.server.frontendUrl}`,
    `- Active runtime root: ${report.paths.runtimeRoot}`,
    `- Audit evidence root: ${report.paths.auditEvidenceRoot}`,
    '',
    '## Cleanup',
    '',
    `- Cleanup ok: ${report.cleanup.ok}`,
    `- DotCodex residual count: ${report.cleanup.residuals.dotCodexRun.length}`,
    `- Backend data residual count: ${report.cleanup.residuals.backendData.length}`,
    `- External residual count: ${report.cleanup.residuals.external.map((entry) => entry.entries.length).join(', ')}`,
    '',
    '## Preflight',
    '',
    `- Passed: ${report.preflight.passed}`,
  ];

  for (const issue of report.preflight.issues) {
    lines.push(`- Issue: ${issue}`);
  }

  lines.push('', '## Scenarios', '');
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id}`);
    lines.push(`- Classification: ${scenario.classification}`);
    lines.push(`- Task ID: ${scenario.taskId}`);
    lines.push(`- Lifecycle: ${scenario.lifecycleStatus}`);
    lines.push(`- Blocking reason: ${scenario.blockingReason ?? 'n/a'}`);
    lines.push(`- Next action: ${scenario.nextAction ?? 'n/a'}`);
    lines.push(`- Acceptance verdict: ${scenario.acceptanceVerdict ?? 'n/a'}`);
    lines.push(`- Quality verdict: ${scenario.qualityVerdict ?? 'n/a'} (${scenario.qualityProfileId ?? 'none'})`);
    lines.push(`- Visible tool activities: ${scenario.visibleToolActivityCount}`);
    if (scenario.providerFailureSummary) {
      lines.push(`- Provider failure: ${scenario.providerFailureSummary}`);
    }
    lines.push(`- Human CLI pass: ${scenario.surfaceChecks.human.pass}`);
    lines.push(`- Agent CLI pass: ${scenario.surfaceChecks.agent.pass}`);
    lines.push(`- Web pass: ${scenario.surfaceChecks.web.pass}`);
    lines.push(`- Artifact audit pass: ${scenario.artifactAudit.pass}`);
    if (scenario.artifactProgress) {
      lines.push(`- Artifact progress: ${summarizeDatabaseArtifactProgress(scenario.artifactProgress)}`);
    }
    lines.push(`- Classification reason: ${scenario.classificationReason}`);
    lines.push('');
  }

  lines.push('## Confirmed Issues', '');
  for (const issue of report.confirmedIssues) {
    lines.push(`- ${issue.issue}: ${issue.evidence} (${issue.scenarios.join(', ')})`);
  }

  return `${lines.join('\n')}\n`;
}

function collectSystemJson(command) {
  const result = runCommandCapture('powershell.exe', ['-NoProfile', '-Command', command], { timeoutMs: 20_000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      raw: result,
      parsed: null,
    };
  }
  try {
    return {
      raw: result,
      parsed: JSON.parse(result.stdout),
    };
  } catch {
    return {
      raw: result,
      parsed: null,
    };
  }
}

function firstArrayItem(value) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function gatherHostTruth() {
  const system = collectSystemJson("(Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime,FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json -Depth 4 -Compress)");
  const topProcesses = collectSystemJson("(Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 ProcessName,Id,CPU,WS | ConvertTo-Json -Depth 4 -Compress)");
  const drives = collectSystemJson("(Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free,Root | ConvertTo-Json -Depth 4 -Compress)");
  return {
    system: {
      csName: firstArrayItem(system.parsed)?.CSName ?? system.parsed?.CSName ?? null,
      caption: firstArrayItem(system.parsed)?.Caption ?? system.parsed?.Caption ?? null,
      version: firstArrayItem(system.parsed)?.Version ?? system.parsed?.Version ?? null,
      lastBootUpTime: firstArrayItem(system.parsed)?.LastBootUpTime ?? system.parsed?.LastBootUpTime ?? null,
      raw: system.raw,
    },
    topProcesses: topProcesses.parsed,
    drives: drives.parsed,
    nodeVersion: runCommandCapture('node', ['--version'], { timeoutMs: 10_000 }),
    dockerVersion: runCommandCapture('docker', ['--version'], { timeoutMs: 10_000 }),
  };
}

function validateManifest(providerSource) {
  const manifestPath = resolveBackendRuntimeManifestPath(rootDir);
  const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
  const issues = [];
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
  const liveProviders = providers.filter((entry) => {
    const scope = typeof entry?.metadata?.scope === 'string' ? entry.metadata.scope : '';
    return entry?.id === XIAOMI_MIMO_FLASH_PROVIDER_ID || scope === 'live-provider';
  });
  if (liveProviders.length !== 1) {
    issues.push('Provider manifest must contain exactly one canonical live provider for this wave.');
  }
  const provider = liveProviders[0] ?? null;
  if (!provider || provider.id !== XIAOMI_MIMO_FLASH_PROVIDER_ID) {
    issues.push(`Active provider manifest must be ${XIAOMI_MIMO_FLASH_PROVIDER_ID}.`);
  }
  if (provider?.baseUrl && /127\.0\.0\.1|localhost|mock/i.test(String(provider.baseUrl))) {
    issues.push('Provider manifest still points at a mock or local test endpoint.');
  }
  if (providerSource.providerId !== XIAOMI_MIMO_FLASH_PROVIDER_ID) {
    issues.push(`API key source did not resolve to ${XIAOMI_MIMO_FLASH_PROVIDER_ID}.`);
  }
  return {
    manifestPath,
    provider,
    issues,
  };
}

async function runScenario(spec, context, scenarioResultsById, page, browser) {
  const scenarioDir = path.join(scenarioLogRoot, spec.id);
  await fs.mkdir(scenarioDir, { recursive: true });
  const taskFilePath = path.join(dotCodexRunRoot, 'tmp', 'real-task-wave', `${spec.id}.json`);
  const taskDefinition = {
    title: spec.title,
    intent: spec.intent,
    defaultQualityProfileId: spec.unit.qualityProfileId ?? undefined,
    preferredProviderId: XIAOMI_MIMO_FLASH_PROVIDER_ID,
    pathPolicy: spec.pathPolicy,
    metadata: {
      source: 'real-task-wave',
      scenarioId: spec.id,
    },
    units: [
      {
        id: 'AGENT-001',
        role: spec.unit.role,
        goal: spec.unit.goal,
        outputContract: spec.unit.outputContract,
        dependencies: [],
        executionProfileId: spec.unit.executionProfileId,
        qualityProfileId: spec.unit.qualityProfileId ?? undefined,
        taskScope: spec.unit.taskScope,
      },
    ],
  };
  await writeJson(taskFilePath, taskDefinition);

  const submitResult = await runCli(['--server', context.serverUrl, 'tasks', 'submit', taskFilePath], context.liveEnv);
  const submitPayload = parseJsonOutput(submitResult.stdout, `${spec.id} submit`);
  const taskId = submitPayload?.command?.taskId ?? submitPayload?.task?.definition?.taskId ?? null;
  if (!taskId) {
    throw new Error(`${spec.id} submit did not return a taskId.`);
  }

  const seededWorkspace = await prepareScenarioWorkspace(spec, taskId, scenarioResultsById, context);
  const startResult = await runCli(['--server', context.serverUrl, 'tasks', 'start', taskId], context.liveEnv);
  const startPayload = parseJsonOutput(startResult.stdout, `${spec.id} start`);
  const workspaceDir = getTaskWorkspaceDir(taskId);

  const continueAttempts = [];
  const approvalResolutions = [];
  let stopReason = null;
  let timedOut = false;
  let latestState = await attachWorkspaceSnapshot(await captureTaskState(context.serverUrl, taskId), workspaceDir);
  const startedAt = Date.now();

  async function tryIssueContinue(instruction, label) {
    const normalized = normalizeContinueInstruction(instruction);
    if (!normalized) {
      return false;
    }
    if (shouldSuppressDuplicateContinueInstruction(normalized, latestState, continueAttempts)) {
      return false;
    }
    const issuedAt = Date.now();
    const continueResult = await runCli([
      '--server',
      context.serverUrl,
      'tasks',
      'continue',
      taskId,
      '--message',
      normalized.message,
    ], context.liveEnv);
    continueAttempts.push({
      issuedAt,
      observedSinceAt: issuedAt,
      message: normalized.message,
      metadata: normalized.metadata,
      lifecycleStatus: latestState.summary.lifecycleStatus,
      workspaceFingerprint: getScenarioWorkspaceFingerprint(latestState),
      payload: parseJsonOutput(continueResult.stdout, `${spec.id} ${label}`),
    });
    return true;
  }

  while (Date.now() - startedAt < spec.timeoutMs) {
    latestState = await attachWorkspaceSnapshot(await captureTaskState(context.serverUrl, taskId), workspaceDir);
    const latestContinueAttempt = [...continueAttempts].reverse().find((attempt) => attempt?.driftChecked !== true);
    if (latestContinueAttempt) {
      const correctionDrift = detectContinueInstructionDrift(latestState, latestContinueAttempt);
      if (correctionDrift) {
        const retryableInspectionOnlyDrift =
          latestContinueAttempt?.metadata?.allowTargetedReadInspection === true
          && isInspectionOnlyReadDriftAttempt(latestContinueAttempt)
          && countContinueAttemptsByPhase(continueAttempts, 'prototype_contract_repair') < 2;
        const recoverableTargetPathDrift = isRecoverableContinueInstructionDrift(
          spec,
          latestState,
          latestContinueAttempt,
          correctionDrift,
          continueAttempts,
        );
        latestContinueAttempt.driftChecked = true;
        latestContinueAttempt.driftReason = correctionDrift;
        if (retryableInspectionOnlyDrift || recoverableTargetPathDrift) {
          latestContinueAttempt.recoverableDrift = recoverableTargetPathDrift === true;
          await sleep(1000);
          continue;
        }
        stopReason = 'correction_drift';
        break;
      }
      if (Array.isArray(latestState?.task?.toolInvocations) && latestState.task.toolInvocations.some((entry) => (entry?.startedAt ?? 0) >= latestContinueAttempt.issuedAt)) {
        latestContinueAttempt.driftChecked = true;
      }
    }
    const pendingApprovals = Array.isArray(latestState.task?.pendingApprovalItems)
      ? latestState.task.pendingApprovalItems
      : Array.isArray(latestState.task?.pendingApprovals)
        ? latestState.task.pendingApprovals
        : [];
    if (pendingApprovals.length > 0) {
      for (const approval of pendingApprovals) {
        const invocationId = approval.invocationId;
        if (!invocationId) {
          continue;
        }
        const approveResult = await runCli([
          '--server',
          context.serverUrl,
          'tasks',
          'approve',
          taskId,
          invocationId,
          'APPROVED',
          '--reason',
          'Approved by real-task-wave harness to continue real-provider validation.',
        ], context.liveEnv);
        approvalResolutions.push({
          invocationId,
          payload: parseJsonOutput(approveResult.stdout, `${spec.id} approve ${invocationId}`),
        });
      }
      await sleep(1000);
      continue;
    }

    const lifecycleStatus = latestState.summary.lifecycleStatus;
    const acceptanceVerdict = latestState.debug?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
    const completionContinueAllowed = latestState.task?.completionSummary?.continueAllowed === true;
    if (
      lifecycleStatus === 'COMPLETED'
      && (acceptanceVerdict !== 'passed' || scenarioNeedsMoreEvidence(spec, latestState))
      && completionContinueAllowed
    ) {
      const continueMessage = deriveContinueMessage(spec, latestState);
      if (canIssueContinue(spec, continueAttempts, continueMessage)
        && await tryIssueContinue(continueMessage, 'continue after failed acceptance')) {
        await sleep(2000);
        continue;
      }
    }
    if (shouldStopScenarioEarly(spec, latestState)) {
      stopReason = 'sufficient_verified_evidence';
      break;
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(lifecycleStatus)) {
      break;
    }

    const artifactState = latestState.debug?.executionSummary?.artifactPathState ?? null;
    if (spec.stopOnArtifactUnresolved && artifactState === 'unresolved') {
      stopReason = 'artifact_unresolved';
      break;
    }

    const continueMessage = deriveContinueMessage(spec, latestState);
    if (continueMessage && canIssueContinue(spec, continueAttempts, continueMessage)) {
      if (await tryIssueContinue(continueMessage, 'continue')) {
        await sleep(2000);
        continue;
      }
    }

    if (continueMessage && shouldSuppressDuplicateContinueInstruction(continueMessage, latestState, continueAttempts)) {
      await sleep(2000);
      continue;
    }

    const correctionKind = getRuntimeCorrectionKind(latestState);
    if (spec.stopOnAwaitingTool && correctionKind === 'AWAITING_TOOL_ACTION') {
      stopReason = 'awaiting_tool_action';
      break;
    }

    await sleep(2000);
  }

  if (!['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(latestState.summary.lifecycleStatus)) {
    latestState = await captureTaskState(context.serverUrl, taskId)
      .then((state) => attachWorkspaceSnapshot(state, workspaceDir))
      .catch(() => latestState);
  }

  if (!['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(latestState.summary.lifecycleStatus)) {
    const finalizationInstruction = deriveContinueMessage(spec, latestState);
    const normalizedFinalization = normalizeContinueInstruction(finalizationInstruction);
    if (
      normalizedFinalization?.metadata?.phase === 'finalize'
      && canIssueContinue(spec, continueAttempts, normalizedFinalization)
      && await tryIssueContinue(normalizedFinalization, 'finalize after evidence timeout')
    ) {
      await sleep(2000);
      latestState = await captureTaskState(context.serverUrl, taskId)
        .then((state) => attachWorkspaceSnapshot(state, workspaceDir))
        .catch(() => latestState);
    }
  }

  if (!['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(latestState.summary.lifecycleStatus)) {
    timedOut = true;
    if (!stopReason) {
      stopReason = 'timeout';
    }
    await runCli([
      '--server',
      context.serverUrl,
      'tasks',
      'cancel',
      taskId,
      '--reason',
      `Harness captured sufficient evidence for ${spec.id} and stopped the task after ${stopReason}.`,
    ], context.liveEnv).catch(() => null);
    latestState = await captureTaskState(context.serverUrl, taskId)
      .then((state) => attachWorkspaceSnapshot(state, workspaceDir))
      .catch(() => latestState);
  }

  const human = await runHumanSurfaceCheck(context.serverUrl, taskId, scenarioDir);
  const agent = await runAgentSurfaceCheck(context.serverUrl, taskId, scenarioDir);
  const web = await runWebSurfaceCheck(page, context.frontendUrl, spec, latestState, screenshotRoot);
  const artifactAudit = await runArtifactAudit(spec, {
    ...latestState,
    workspaceDir,
    workspaceRelativeFiles: latestState.workspaceRelativeFiles,
  }, browser, context.hostTruth);
  await writeJson(path.join(scenarioDir, 'task.json'), latestState.task);
  await writeJson(path.join(scenarioDir, 'debug.json'), latestState.debug);
  await writeJson(path.join(scenarioDir, 'artifact-audit.json'), artifactAudit);

  const classification = classifyScenario(spec, latestState, { human, agent, web }, artifactAudit);
  const scenarioRecord = {
    id: spec.id,
    title: spec.title,
    taskId,
    taskFilePath,
    workspaceDir,
    runtimeRoot: backendDataRoot,
    auditEvidenceRoot: scenarioDir,
    seededWorkspace,
    submitPayload,
    startPayload,
    continueAttempts,
    correctionDriftReasons: continueAttempts
      .map((attempt) => attempt?.driftReason)
      .filter((value) => typeof value === 'string' && value.trim().length > 0),
    approvalResolutions,
    stopReason,
    timedOut,
    lifecycleStatus: latestState.summary.lifecycleStatus,
    currentUnitId: latestState.summary.currentUnitId,
    blockingReason: latestState.summary.blockingReason,
    nextAction: latestState.summary.nextAction,
    nextActionReason: latestState.summary.nextActionReason,
    providerFailure: latestState.task?.diagnostics?.providerFailure ?? null,
    providerFailureSummary: formatProviderFailureSummary(latestState.task?.diagnostics?.providerFailure ?? null),
    acceptanceVerdict: latestState.debug?.executionSummary?.acceptance?.deterministic?.verdict ?? null,
    qualityProfileId: latestState.debug?.executionSummary?.acceptance?.quality?.profileId ?? null,
    qualityVerdict: latestState.debug?.executionSummary?.acceptance?.quality?.verdict ?? null,
    visibleToolActivityCount: latestState.summary.visibleToolActivities.length,
    visibleToolActivities: latestState.summary.visibleToolActivities,
    artifactPathState: latestState.debug?.executionSummary?.artifactPathState ?? null,
    artifactProgress: artifactAudit.notes?.artifactProgress ?? null,
    surfaceChecks: {
      human,
      agent,
      web,
    },
    artifactAudit,
    classification: classification.classification,
    classificationReason: classification.reason,
  };

  await writeJson(path.join(scenarioDir, 'scenario-result.json'), scenarioRecord);
  return scenarioRecord;
}

async function main() {
  const selectedScenarioSpecs = filterScenarioSpecs(buildScenarioSpecsLive());
  const requestedLiveModel = resolveRealTaskWaveLiveModel(selectedScenarioSpecs);
  const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, {
    model: requestedLiveModel,
    allowCompatibleModelFallback: true
  });
  const liveModel = providerSource.model;
  await assertLiveCostGuard({
    rootDir,
    env: {
      ...process.env,
      XIAOMI_MIMO_LIVE_MODEL: liveModel,
    },
    label: 'real-task-wave'
  });
  const cleanup = await cleanRealTaskWaveState({ rootDir, externalPaths: [targetExternalPath] });
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir, { model: liveModel });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.mkdir(scenarioLogRoot, { recursive: true });
  await fs.mkdir(screenshotRoot, { recursive: true });

  const preflight = validateManifest(providerSource);
  preflight.modelRouting = {
    requestedModel: providerSource.requestedModel,
    effectiveModel: providerSource.model,
    fallbackApplied: providerSource.requestedModel !== providerSource.model,
  };
  const aaaEntries = await fs.readdir(targetExternalPath).catch(() => []);
  if (aaaEntries.length > 0) {
    preflight.issues.push(`${targetExternalPath} is not empty after cleanup.`);
  }
  if (!cleanup.ok) {
    preflight.issues.push('Cleanup left residual runtime or external files behind.');
  }
  const hostTruth = gatherHostTruth();
  preflight.hostTruth = hostTruth;
  preflight.passed = preflight.issues.length === 0;

  const report = {
    generatedAt: new Date().toISOString(),
    provider: {
      id: providerSource.providerId,
      requestedModel: providerSource.requestedModel,
      model: providerSource.model,
      baseUrl: providerSource.baseUrl,
      sourceFile: providerSource.docPath,
    },
    paths: {
      runtimeRoot: backendDataRoot,
      auditEvidenceRoot: reportDir,
      scenarioEvidenceRoot: scenarioLogRoot,
    },
    cleanup,
    preflight,
    server: {
      backendUrl: null,
      frontendUrl: null,
    },
    scenarios: [],
    surfaceChecks: [],
    artifactAudit: [],
    classification: [],
    confirmedIssues: [],
  };

  if (!preflight.passed) {
    report.confirmedIssues = [{
      issue: 'cleanup_or_preflight_failure',
      evidence: preflight.issues.join(' | '),
      scenarios: [],
    }];
    await writeJson(reportJsonPath, report);
    await writeText(reportMarkdownPath, buildMarkdownReport(report));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const chromeExecutable = resolveChromeExecutable();
  if (!chromeExecutable) {
    report.confirmedIssues = [{
      issue: 'web_validation_external_blocker',
      evidence: 'Chrome executable was not found, so Web validation could not start.',
      scenarios: [],
    }];
    await writeJson(reportJsonPath, report);
    await writeText(reportMarkdownPath, buildMarkdownReport(report));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const backendPort = await findAvailablePort(preferredBackendPort);
  const frontendPort = await findAvailablePort(preferredFrontendPort);
  const serverUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  report.server.backendUrl = serverUrl;
  report.server.frontendUrl = frontendUrl;

  const buildResult = runCommandCapture(npmCommand(), ['run', 'build', '-w', 'backend'], {
    cwd: rootDir,
    timeoutMs: 300_000,
  });
  await writeJson(path.join(reportDir, 'real-task-wave-backend-build.json'), buildResult);
  if (buildResult.exitCode !== 0) {
    report.confirmedIssues = [{
      issue: 'backend_build_failed',
      evidence: 'The backend build failed before the live task wave could start.',
      scenarios: [],
    }];
    await writeJson(reportJsonPath, report);
    await writeText(reportMarkdownPath, buildMarkdownReport(report));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    ...liveEnv,
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
  const readBackendLogs = collectOutput(backend, 'backend');
  const frontend = spawnNpm(['run', 'dev', '-w', 'frontend', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], {
    FRONTEND_BACKEND_PORT: String(backendPort),
    FRONTEND_DEV_PORT: String(frontendPort),
    VITE_BACKEND_SERVER_URL: serverUrl,
  });
  const readFrontendLogs = collectOutput(frontend, 'frontend');

  let browser = null;
  let page = null;
  try {
    await waitForHttp(`${serverUrl}/health`, 120_000);
    await waitForHttp(frontendUrl, 120_000);
    const providerSetup = await ensureLiveProviderSecret(serverUrl, providerSource);
    preflight.providerSetup = providerSetup;
    if (providerSetup.providerTest?.ok !== true) {
      const providerMessage = providerSetup.providerTest?.message
        ?? providerSetup.providerTest?.error
        ?? 'Provider test did not return ok=true.';
      preflight.issues.push(`Provider test failed for ${providerSource.providerId}/${providerSource.model}: ${providerMessage}`);
      preflight.passed = false;
      report.confirmedIssues = [{
        issue: 'provider_preflight_failure',
        evidence: preflight.issues.join(' | '),
        scenarios: [],
      }];
      report.backendLogs = readBackendLogs();
      report.frontendLogs = readFrontendLogs();
      await writeJson(reportJsonPath, report);
      await writeText(reportMarkdownPath, buildMarkdownReport(report));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    await patchConfig(serverUrl, {
      tools: {
        permissionMode: 'full',
      },
    });

    browser = await chromium.launch({
      headless: true,
      executablePath: chromeExecutable,
    });
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });

    const scenarioResultsById = new Map();
    for (const spec of selectedScenarioSpecs) {
      const scenarioResult = await runScenario(spec, {
        serverUrl,
        frontendUrl,
        liveEnv,
        hostTruth,
      }, scenarioResultsById, page, browser);
      report.scenarios.push(scenarioResult);
      report.surfaceChecks.push({
        id: scenarioResult.id,
        taskId: scenarioResult.taskId,
        human: scenarioResult.surfaceChecks.human,
        agent: scenarioResult.surfaceChecks.agent,
        web: scenarioResult.surfaceChecks.web,
      });
      report.artifactAudit.push({
        id: scenarioResult.id,
        taskId: scenarioResult.taskId,
        audit: scenarioResult.artifactAudit,
      });
      report.classification.push({
        id: scenarioResult.id,
        classification: scenarioResult.classification,
        reason: scenarioResult.classificationReason,
      });
      scenarioResultsById.set(spec.id, scenarioResult);
      await writeJson(reportJsonPath, report);
      await writeText(reportMarkdownPath, buildMarkdownReport(report));
    }

    report.confirmedIssues = summarizeConfirmedIssues(report);
    await writeJson(reportJsonPath, report);
    await writeText(reportMarkdownPath, buildMarkdownReport(report));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.scenarios.some((scenario) => scenario.classification !== 'passed')) {
      process.exitCode = 1;
    }
  } catch (error) {
    report.confirmedIssues = [{
      issue: 'wave_execution_failure',
      evidence: error instanceof Error ? error.message : String(error),
      scenarios: report.scenarios.map((scenario) => scenario.id),
    }];
    report.backendLogs = readBackendLogs();
    report.frontendLogs = readFrontendLogs();
    await writeJson(reportJsonPath, report);
    await writeText(reportMarkdownPath, buildMarkdownReport(report));
    throw error;
  } finally {
    if (page) {
      await page.close().catch(() => null);
    }
    if (browser) {
      await browser.close().catch(() => null);
    }
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend'),
    ]);
  }
}

const isDirectRun = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}

export {
  buildDatabaseArtifactProgress,
  extractDatabaseLabBenchRequiredModuleFiles,
  summarizeDatabaseArtifactProgress,
  classifyScenario,
  deriveContinueMessage,
  evaluateDatabaseBenchmarkSelfCheck,
  formatProviderFailureSummary,
  detectContinueInstructionDrift,
  isRecoverableContinueInstructionDrift,
  getDatabasePrototypePathFromPackageEntryRef,
  getBlockingDatabasePackageEntryRefs,
  getDatabaseLabNextPrototypeModuleTargets,
  getPrioritizedDatabasePrototypeRepairTargets,
  getDatabaseLabPrototypeCodeDiagnostics,
  getDatabaseLabNextPrototypeTopLevelTargets,
  canIssueContinue,
  resolveRealTaskWaveLiveModel,
  normalizeContinueInstruction,
  shouldStopScenarioEarly,
  shouldSuppressDuplicateContinueInstruction,
};
