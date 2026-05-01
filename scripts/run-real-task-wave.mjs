import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanRealTaskWaveState } from './clean-real-task-wave-state.mjs';
import { generateRealTaskManualReview } from './generate-real-task-manual-review.mjs';
import {
  buildXiaomiMimoFlashLiveEnv,
  readXiaomiMimoFlashProviderSource,
  resolveXiaomiMimoFlashDocPath,
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
  buildRealTaskScenarioSpecs,
  classifyScenarioWithPolicy,
  getScenarioArtifactAuditPolicy,
  getScenarioQualityGateId as getScenarioQualityGateIdFromPack,
  getScenarioQualityProfileId as getScenarioQualityProfileIdFromPack,
  getScenarioIdsForPack,
  getScenarioProjectKinds,
  getScenarioReuseWorkspace,
  getScenarioRequiredOutputFiles,
  getScenarioSeedFiles,
  getSourceFilesForDocsNormalizeOutput,
  getScenarioTimeoutPolicy,
  scenarioBelongsToAnyPack,
  scenarioBelongsToPack,
} from './lib/real-task-scenario-packs.mjs';
import {
  createScenarioPackContinuePolicy,
  evaluateScenarioPackQuality,
  formatScenarioPackArtifactProgress,
  getScenarioPackClassificationFacts,
  isScenarioPackBenignDriftInvocation,
  runScenarioPackBoundaryArtifactAudit,
  scenarioPackAllowsContinueAfterBudget,
  scenarioPackHasSufficientEvidence,
  scenarioPackNeedsMoreEvidence,
  shouldForceScenarioPackBenchmarkSelfCheck,
  summarizeScenarioPackConfirmedIssues,
} from './lib/real-task-scenario-pack-hooks.mjs';
import {
  detectWorkspaceProjects,
  selectPrimaryProject,
} from './lib/real-task-project-detectors.mjs';

const rootDir = process.cwd();
const backendDataRoot = resolveBackendRuntimeRoot(rootDir);
const dotCodexRunRoot = path.resolve(rootDir, '.codex-run');
const reportDir = path.resolve(dotCodexRunRoot, 'logs');
const reportJsonPath = path.resolve(reportDir, 'real-task-wave-report.json');
const reportMarkdownPath = path.resolve(reportDir, 'real-task-wave-report.md');
const manualReviewJsonPath = path.resolve(reportDir, 'real-task-manual-review.json');
const manualReviewMarkdownPath = path.resolve(reportDir, 'real-task-manual-review.md');
const manualReviewArtifactRoot = path.resolve(reportDir, 'real-task-manual-review-artifacts');
const commandLogPath = path.resolve(reportDir, 'real-task-wave-command-log.ndjson');
const scenarioLogRoot = path.resolve(reportDir, 'real-task-wave');
const screenshotRoot = path.resolve(reportDir, 'real-task-wave-screenshots');
const backendCliPath = path.resolve(rootDir, 'backend', 'dist', 'bin', 'cli.js');
const backendQualityRuntimePath = path.resolve(rootDir, 'backend', 'dist', 'domain', 'quality', 'task-quality.js');
const preferredBackendPort = Number.parseInt(process.env.REAL_TASK_WAVE_BACKEND_PORT ?? '3811', 10);
const preferredFrontendPort = Number.parseInt(process.env.REAL_TASK_WAVE_FRONTEND_PORT ?? '5673', 10);
const CONTINUE_NO_PROGRESS_GRACE_MS = Number.parseInt(process.env.REAL_TASK_WAVE_NO_PROGRESS_GRACE_MS ?? '90000', 10);
const DEFAULT_HTTP_TIMEOUT_MS = Number.parseInt(process.env.REAL_TASK_WAVE_HTTP_TIMEOUT_MS ?? '30000', 10);
const DEFAULT_CLI_TIMEOUT_MS = Number.parseInt(process.env.REAL_TASK_WAVE_CLI_TIMEOUT_MS ?? '300000', 10);
const DEFAULT_SUBMIT_ONLY_OBSERVE_MS = Number.parseInt(process.env.REAL_TASK_WAVE_SUBMIT_ONLY_OBSERVE_MS ?? '300000', 10);
const targetExternalPath = 'D:\\AAA';
const requireFromScript = createRequire(import.meta.url);
let sharedQualityRuntime = null;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function preferredWindowsNpm() {
  return process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : null;
}

function isEnabledEnvFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function normalizeModeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
}

function resolveRealTaskWaveVerificationMode(env = process.env) {
  const mode = normalizeModeName(env.REAL_TASK_WAVE_MODE);
  if (
    isEnabledEnvFlag(env.REAL_TASK_WAVE_SUBMIT_ONLY)
    || isEnabledEnvFlag(env.REAL_TASK_WAVE_MANUAL_REVIEW)
    || mode === 'submit_only'
    || mode === 'manual_review'
    || mode === 'submit_only_manual_review'
  ) {
    return 'submit_only_manual_review';
  }
  return 'automated_wave';
}

function requiresManualReview(verificationMode) {
  return verificationMode === 'submit_only_manual_review';
}

function isTerminalLifecycleStatus(status) {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(status);
}

function getSubmitOnlyObserveMs(spec) {
  const configured = Number.isFinite(DEFAULT_SUBMIT_ONLY_OBSERVE_MS) && DEFAULT_SUBMIT_ONLY_OBSERVE_MS > 0
    ? DEFAULT_SUBMIT_ONLY_OBSERVE_MS
    : 300_000;
  const scenarioTimeout = Number.isFinite(spec?.timeoutMs) && spec.timeoutMs > 0
    ? spec.timeoutMs
    : configured;
  return Math.min(configured, scenarioTimeout);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function getScenarioQualityProfileId(spec) {
  return getScenarioQualityProfileIdFromPack(spec.id);
}

function getScenarioQualityGateId(spec) {
  return getScenarioQualityGateIdFromPack(spec.id);
}

function isWebScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToPack(scenarioId, 'web');
}

function isDocsNormalizeScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToPack(scenarioId, 'docs-normalize');
}

function isDocsSynthesizeScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToPack(scenarioId, 'docs-synthesize');
}

function isDocsScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToAnyPack(scenarioId, ['docs-normalize', 'docs-synthesize']);
}

function isSystemAuditScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToPack(scenarioId, 'system-audit');
}

function isDesktopObservationScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToPack(scenarioId, 'desktop-observation');
}

function isHostObservationScenario(specOrId) {
  const scenarioId = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  return scenarioBelongsToAnyPack(scenarioId, ['system-audit', 'desktop-observation']);
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

async function launchValidationBrowser(executablePath) {
  const configuredAttempts = Number.parseInt(process.env.REAL_TASK_WAVE_BROWSER_LAUNCH_ATTEMPTS ?? '3', 10);
  const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0
    ? configuredAttempts
    : 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError;
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

function shouldStreamVerboseCommandOutput() {
  return process.env.REAL_TASK_WAVE_VERBOSE_STDIO === '1';
}

function redactCliArgs(args) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    redacted.push(value);
    if (value === '--api-key' && index + 1 < args.length) {
      redacted.push('[REDACTED]');
      index += 1;
    }
  }
  return redacted;
}

async function appendCommandLog(entry) {
  try {
    await fs.mkdir(path.dirname(commandLogPath), { recursive: true });
    await fs.appendFile(commandLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never change wave behavior.
  }
}

async function runCli(args, env = {}, options = {}) {
  const startedAt = Date.now();
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
    if (shouldStreamVerboseCommandOutput()) {
      process.stdout.write(`[cli] ${text}`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    if (shouldStreamVerboseCommandOutput()) {
      process.stderr.write(`[cli] ${text}`);
    }
  });

  if (typeof options.stdinText === 'string') {
    child.stdin?.write(options.stdinText);
    child.stdin?.end();
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Number(options.timeoutMs))
    : Math.max(1000, DEFAULT_CLI_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateChild(child, `cli ${args.join(' ')}`).catch(() => null);
  }, timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timer));
  await appendCommandLog({
    type: 'cli',
    startedAt,
    endedAt: Date.now(),
    args: redactCliArgs(args),
    exitCode,
    timedOut,
    stdout,
    stderr,
  });
  if (!shouldStreamVerboseCommandOutput()) {
    process.stdout.write(`[cli] ${redactCliArgs(args).join(' ')} -> exit ${exitCode}; stdout ${stdout.length} bytes; stderr ${stderr.length} bytes\n`);
  }
  if (timedOut) {
    throw new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
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

async function requestJson(url, init = {}, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Number(options.timeoutMs))
    : Math.max(1000, DEFAULT_HTTP_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
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
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${init?.method ?? 'GET'} ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  const projects = await detectWorkspaceProjects(root, { maxDepth: 4 });
  return projects
    .filter((project) => project.kind === 'node')
    .map((project) => path.join(project.root, 'package.json'));
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
  const qualityGateId = getScenarioQualityGateId(spec);
  const createNotApplicable = () => ({
    profileId: qualityGateId ?? profileId ?? null,
    verdict: 'not_applicable',
    passedChecks: [],
    failedChecks: [],
    requiredNextEvidence: [],
    lastEvaluatedAt: null,
  });
  if (!profileId && !qualityGateId) {
    return createNotApplicable();
  }
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
  const qualityInput = {
    taskId: definition.taskId ?? scenarioState.summary?.taskId ?? 'unknown-task',
    title: definition.title ?? scenarioState.summary?.title ?? spec.title,
    intent: definition.intent ?? spec.intent,
    unitId: currentUnit?.id ?? null,
    executionProfileId: currentUnit?.executionProfileId ?? 'analyze',
    qualityProfileId: currentUnit?.qualityProfileId ?? profileId,
    qualityGateId,
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
  };
  const scenarioPackQuality = evaluateScenarioPackQuality(spec, qualityInput);
  if (scenarioPackQuality && scenarioPackQuality.verdict !== 'not_applicable') {
    return scenarioPackQuality;
  }
  if (!profileId) {
    return createNotApplicable();
  }
  const { evaluateTaskQuality } = getSharedQualityRuntime();
  return evaluateTaskQuality(qualityInput);
}

function attachScenarioQuality(spec, scenarioState) {
  const quality = evaluateScenarioQuality(spec, scenarioState);
  if (!quality || quality.verdict === 'not_applicable') {
    return scenarioState;
  }
  const debug = scenarioState.debug ?? {};
  const executionSummary = debug.executionSummary ?? {};
  const acceptance = executionSummary.acceptance ?? {};
  return {
    ...scenarioState,
    debug: {
      ...debug,
      executionSummary: {
        ...executionSummary,
        acceptance: {
          ...acceptance,
          quality,
        },
      },
    },
    summary: {
      ...(scenarioState.summary ?? {}),
      acceptance: {
        ...(scenarioState.summary?.acceptance ?? {}),
        quality,
      },
    },
  };
}

async function captureScenarioState(serverUrl, taskId, workspaceDir, spec) {
  return attachScenarioQuality(
    spec,
    await attachWorkspaceSnapshot(await captureTaskState(serverUrl, taskId), workspaceDir)
  );
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

function getToolInvocationsById(scenarioState, toolId) {
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  const normalizedToolId = String(toolId ?? '').trim().toLowerCase();
  return [...taskInvocations, ...debugInvocations].filter(
    (entry) => String(entry?.toolId ?? '').trim().toLowerCase() === normalizedToolId,
  );
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
  const surfacedIds = getSuccessfulToolActivitiesById(scenarioState, toolId)
    .map((activity) => activity?.activityId)
    .filter(Boolean);
  const invocationIds = getSuccessfulToolInvocationsById(scenarioState, toolId)
    .map((entry) => entry?.invocationId ?? entry?.id ?? entry?.activityId)
    .filter(Boolean);
  return Array.from(new Set([...surfacedIds, ...invocationIds])).slice(-limit);
}

function getUnitInvalidOutputErrors(scenarioState) {
  const debug = scenarioState?.debug ?? scenarioState;
  return scenarioState?.task?.runtime?.schedulerUnits?.['AGENT-001']?.invalidOutputErrors
    ?? debug?.task?.runtime?.schedulerUnits?.['AGENT-001']?.invalidOutputErrors
    ?? [];
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
  const normalizedFactName = factName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (/(total_(physical_)?memory(_mb|_kb)?|total_visible_memory_size|free_(physical_)?memory(_mb|_kb)?)/i.test(normalizedFactName)) {
    return 'memory';
  }
  if (/(number_of_cores|cpu_cores|(^|_)cores$|number_of_logical_processors|logical_processors|max_clock_speed(_mhz)?)/i.test(normalizedFactName)) {
    return 'cpu';
  }
  if (/(disk_.*(free|total|size)|free_space(_gb)?|size_gb|disk_free_space_gb|disk_total_size_gb)/i.test(normalizedFactName)) {
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
  if (isDesktopObservationScenario(spec)) {
    return hasDesktopObservationEvidence(scenarioState);
  }
  const packSufficient = scenarioPackHasSufficientEvidence(spec, scenarioState);
  if (packSufficient !== null) {
    return packSufficient;
  }
  return false;
}

function getScenarioContinueBudget(spec) {
  const policyBudget = Number(getScenarioTimeoutPolicy(spec?.id)?.maxTurns);
  return Number.isFinite(policyBudget) && policyBudget > 0 ? policyBudget : 8;
}

function getScenarioFinalizeBudget(spec) {
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
  if (scenarioPackAllowsContinueAfterBudget(spec, normalized, continueAttempts) === true) {
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

function scenarioNeedsMoreEvidence(spec, scenarioState) {
  if (isDesktopObservationScenario(spec)) {
    return !hasDesktopObservationEvidence(scenarioState);
  }
  const packNeedsMoreEvidence = scenarioPackNeedsMoreEvidence(spec, scenarioState);
  if (packNeedsMoreEvidence !== null) {
    return packNeedsMoreEvidence;
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

const {
  buildScenarioPackBenchmarkSelfCheckInstruction,
  deriveContinueMessage,
} = createScenarioPackContinuePolicy({
  path,
  targetExternalPath,
  buildJsonToolCallPrelude,
  buildWriteOnlyRepairPrelude,
  createContinueInstruction,
  normalizeSlashes,
  readTextFileIfExists,
  truncateScenarioPromptText,
  collectAcceptanceRequiredNextEvidence,
  getUnitInvalidOutputErrors,
  getRuntimeCorrectionKind,
  hasDesktopObservationEvidence,
  hasExternalBlogWriteEvidence,
  hasMeaningfulWriteProgress,
  buildLatestToolFailureSummary,
  parseOutputContractKeys,
  getScenarioWorkspaceFiles,
  getMissingWorkspaceFiles,
  hasWorkspaceFiles,
  countSuccessfulReadActivities,
  buildEmbeddedSourceBlocks,
  buildToolInvocationResultExcerpt,
  getSystemAuditFamiliesFromFailures,
  getRecentSuccessfulInvocationIds,
  getFailedToolActivitiesById,
  getSystemAuditRunEvidenceCoverage,
  getScenarioRequiredOutputFiles,
  getSourceFilesForDocsNormalizeOutput,
  isWebScenario,
  isDocsNormalizeScenario,
  isDocsSynthesizeScenario,
  isDocsScenario,
  isSystemAuditScenario,
  isDesktopObservationScenario,
  isHostObservationScenario,
});

function hasToolInvocationSince(scenarioState, timestamp) {
  if (typeof timestamp !== 'number') {
    return false;
  }
  return getToolInvocationsSince(scenarioState, timestamp).length > 0;
}

function getToolInvocationTimestamp(entry) {
  const startedAt = entry?.startedAt ?? entry?.createdAt ?? entry?.timestamp ?? null;
  const endedAt = entry?.endedAt ?? entry?.finishedAt ?? null;
  return {
    startedAt: typeof startedAt === 'number' ? startedAt : null,
    endedAt: typeof endedAt === 'number' ? endedAt : null,
  };
}

function getToolInvocationStatus(entry) {
  const status = String(entry?.status ?? '').trim().toUpperCase();
  if (status) {
    return status;
  }
  if (entry?.resultOk === false || entry?.ok === false) {
    return 'FAILED';
  }
  if (entry?.resultOk === true || entry?.ok === true) {
    return 'SUCCEEDED';
  }
  return '';
}

function getAllToolInvocationRecords(scenarioState) {
  const candidates = [
    scenarioState?.task?.toolInvocations,
    scenarioState?.debug?.task?.toolInvocations,
    scenarioState?.task?.visibleToolActivities,
    scenarioState?.summary?.visibleToolActivities,
  ];
  const records = [];
  const seen = new Set();
  for (const entries of candidates) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const { startedAt, endedAt } = getToolInvocationTimestamp(entry);
      const key = String(entry?.invocationId ?? entry?.activityId ?? `${entry?.toolId ?? 'tool'}:${startedAt ?? ''}:${endedAt ?? ''}:${getToolInvocationStatus(entry)}`);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      records.push(entry);
    }
  }
  return records;
}

function getToolInvocationsSince(scenarioState, timestamp) {
  if (typeof timestamp !== 'number') {
    return [];
  }
  return getAllToolInvocationRecords(scenarioState).filter((entry) => {
    const { startedAt, endedAt } = getToolInvocationTimestamp(entry);
    return (typeof startedAt === 'number' && startedAt >= timestamp)
      || (typeof endedAt === 'number' && endedAt >= timestamp);
  });
}

function hasFailedToolInvocationNoWorkspaceProgressSince(scenarioState, attempt) {
  if (!attempt || typeof attempt.issuedAt !== 'number') {
    return false;
  }
  const currentFingerprint = getScenarioWorkspaceFingerprint(scenarioState);
  if (!attempt.workspaceFingerprint || attempt.workspaceFingerprint !== currentFingerprint) {
    return false;
  }
  return getToolInvocationsSince(scenarioState, attempt.issuedAt)
    .some((entry) => getToolInvocationStatus(entry) === 'FAILED');
}

function hasInspectionOnlyToolNoWorkspaceProgressSince(scenarioState, attempt) {
  if (!attempt || typeof attempt.issuedAt !== 'number') {
    return false;
  }
  if (attempt?.metadata?.allowTargetedReadInspection !== true) {
    return false;
  }
  const currentFingerprint = getScenarioWorkspaceFingerprint(scenarioState);
  if (!attempt.workspaceFingerprint || attempt.workspaceFingerprint !== currentFingerprint) {
    return false;
  }
  const invocations = getToolInvocationsSince(scenarioState, attempt.issuedAt);
  if (invocations.length === 0) {
    return false;
  }
  return invocations.every((entry) =>
    ['read_file', 'list_files', 'search_files'].includes(String(entry?.toolId ?? '').trim().toLowerCase())
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
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (
    ['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION'].includes(correctionKind)
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
    return countContinueAttemptsByUniqueKey(continueAttempts, normalized.metadata.uniqueKey) >= 2;
  }
  if (
    hasFailedToolInvocationNoWorkspaceProgressSince(scenarioState, lastAttempt)
    && countContinueAttemptsByUniqueKey(continueAttempts, normalized.metadata.uniqueKey) < 2
  ) {
    return false;
  }
  return lastAttempt.lifecycleStatus === 'RUNNING'
    && lastAttempt.workspaceFingerprint === workspaceFingerprint;
}

function hasDuplicateContinueNoProgress(instruction, scenarioState, continueAttempts) {
  const normalized = normalizeContinueInstruction(instruction);
  if (!normalized?.metadata?.uniqueKey) {
    return false;
  }
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  if (!['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION'].includes(correctionKind)) {
    return false;
  }
  const attempts = Array.isArray(continueAttempts) ? continueAttempts : [];
  const matchingAttempts = attempts.filter((attempt) => attempt?.metadata?.uniqueKey === normalized.metadata.uniqueKey);
  if (matchingAttempts.length < 2) {
    return false;
  }
  const latestAttempt = matchingAttempts.at(-1);
  if (!latestAttempt) {
    return false;
  }
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (executionLeaseActive) {
    return false;
  }
  if (hasToolInvocationSince(scenarioState, latestAttempt.issuedAt)) {
    return hasFailedToolInvocationNoWorkspaceProgressSince(scenarioState, latestAttempt)
      || hasInspectionOnlyToolNoWorkspaceProgressSince(scenarioState, latestAttempt);
  }
  return true;
}

function hasStaleContinueNoProgress(attempt, scenarioState, now = Date.now()) {
  if (!attempt || typeof attempt.issuedAt !== 'number') {
    return false;
  }
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  if (!['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION', 'AWAITING_TRACKER'].includes(correctionKind)) {
    return false;
  }
  if (
    hasToolInvocationSince(scenarioState, attempt.issuedAt)
    && !hasFailedToolInvocationNoWorkspaceProgressSince(scenarioState, attempt)
    && !hasInspectionOnlyToolNoWorkspaceProgressSince(scenarioState, attempt)
  ) {
    return false;
  }
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (executionLeaseActive) {
    return false;
  }
  const graceMs = Number.isFinite(CONTINUE_NO_PROGRESS_GRACE_MS)
    ? Math.max(1000, CONTINUE_NO_PROGRESS_GRACE_MS)
    : 90000;
  return now - attempt.issuedAt >= graceMs;
}

function hasRuntimeCorrectionNoProgress(scenarioState, now = Date.now()) {
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  if (!['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION', 'AWAITING_TRACKER'].includes(correctionKind)) {
    return false;
  }
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (executionLeaseActive) {
    return false;
  }
  const pendingApprovals = Array.isArray(scenarioState.task?.pendingApprovalItems)
    ? scenarioState.task.pendingApprovalItems
    : Array.isArray(scenarioState.task?.pendingApprovals)
      ? scenarioState.task.pendingApprovals
      : [];
  if (pendingApprovals.length > 0) {
    return false;
  }
  const updatedAt =
    scenarioState?.task?.runtime?.updatedAt
    ?? scenarioState?.debug?.task?.runtime?.updatedAt
    ?? scenarioState?.summary?.updatedAt
    ?? scenarioState?.task?.updatedAt
    ?? null;
  if (typeof updatedAt !== 'number') {
    return false;
  }
  const graceMs = Number.isFinite(CONTINUE_NO_PROGRESS_GRACE_MS)
    ? Math.max(1000, CONTINUE_NO_PROGRESS_GRACE_MS)
    : 90000;
  return now - updatedAt >= graceMs;
}

function hasInactiveRunningNoProgress(scenarioState, now = Date.now()) {
  const lifecycleStatus =
    scenarioState?.summary?.lifecycleStatus
    ?? scenarioState?.task?.runtime?.lifecycleStatus
    ?? scenarioState?.debug?.task?.runtime?.lifecycleStatus
    ?? null;
  if (lifecycleStatus !== 'RUNNING') {
    return false;
  }
  const runtime = scenarioState?.task?.runtime ?? scenarioState?.debug?.task?.runtime ?? {};
  const executionLeaseActive = scenarioState?.task?.runtime?.executionLease?.active === true
    || scenarioState?.debug?.task?.runtime?.executionLease?.active === true;
  if (executionLeaseActive) {
    return false;
  }
  const pendingApprovals = Array.isArray(scenarioState.task?.pendingApprovalItems)
    ? scenarioState.task.pendingApprovalItems
    : Array.isArray(scenarioState.task?.pendingApprovals)
      ? scenarioState.task.pendingApprovals
      : [];
  if (pendingApprovals.length > 0) {
    return false;
  }
  const awaitingToolDispatch = Array.isArray(runtime.awaitingToolDispatch) ? runtime.awaitingToolDispatch : [];
  const pendingToolBatches = Array.isArray(runtime.pendingToolBatches) ? runtime.pendingToolBatches : [];
  const closedBatchStatuses = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED', 'COMPLETED']);
  const activePendingToolBatches = pendingToolBatches.filter((batch) =>
    !closedBatchStatuses.has(String(batch?.status ?? '').trim().toUpperCase())
  );
  if (awaitingToolDispatch.length > 0 || activePendingToolBatches.length > 0) {
    return false;
  }
  const liveToolStatuses = new Set(['PENDING', 'RUNNING', 'APPROVAL_REQUIRED', 'AWAITING_APPROVAL']);
  const toolInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  if (toolInvocations.some((entry) => liveToolStatuses.has(String(entry?.status ?? '').trim().toUpperCase()))) {
    return false;
  }
  const correctionKind = getRuntimeCorrectionKind(scenarioState);
  if (['AWAITING_OUTPUT_CORRECTION', 'AWAITING_TOOL_ACTION', 'AWAITING_TRACKER'].includes(correctionKind)) {
    return hasRuntimeCorrectionNoProgress(scenarioState, now);
  }
  const eventTimestamps = Array.isArray(scenarioState?.task?.events)
    ? scenarioState.task.events.map((event) => event?.timestamp).filter((value) => typeof value === 'number')
    : [];
  const candidates = [
    runtime.safePoint?.reachedAt,
    scenarioState?.task?.lastSafeCheckpointAt,
    scenarioState?.summary?.lastSafeCheckpointAt,
    ...eventTimestamps,
  ].filter((value) => typeof value === 'number');
  if (candidates.length === 0) {
    return false;
  }
  const latestRuntimeActivityAt = Math.max(...candidates);
  const graceMs = Number.isFinite(CONTINUE_NO_PROGRESS_GRACE_MS)
    ? Math.max(1000, CONTINUE_NO_PROGRESS_GRACE_MS)
    : 90000;
  return now - latestRuntimeActivityAt >= graceMs;
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
  const invocationCandidates = getAllToolInvocationRecords(scenarioState).filter((entry) => {
    const startedAt = typeof entry?.startedAt === 'number' ? entry.startedAt : null;
    return startedAt !== null && startedAt >= observedSinceAt;
  });
  if (invocationCandidates.length === 0) {
    return null;
  }
  const canonicalInvocations = Array.from(new Map(
    invocationCandidates.map((entry) => {
      const { startedAt, endedAt } = getToolInvocationTimestamp(entry);
      const key = String(entry?.invocationId ?? entry?.activityId ?? `${entry?.toolId ?? 'tool'}:${startedAt ?? ''}:${endedAt ?? ''}:${getToolInvocationStatus(entry)}`);
      return [key, entry];
    }),
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
  const isBenignScenarioPackDrift = (entry) => isScenarioPackBenignDriftInvocation({
    attempt,
    entry,
    requiredWritePathsSatisfied,
    benchmarkSelfCheckRunObserved,
  });
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
      && !isBenignScenarioPackDrift(entry)
    )
    : [];
  if (toolViolations.length > 0) {
    const observed = toolViolations.map((entry) => entry.toolId).filter(Boolean).join(', ');
    return `observed forbidden tool(s) after ${attempt.metadata.phase ?? 'continue'}: ${observed}`;
  }
  if (allowedPaths.length > 0) {
    const pathViolations = canonicalInvocations.filter((entry) => {
      if (isBenignScenarioPackDrift(entry)) {
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

function buildScenarioSpecsLive() {
  return buildRealTaskScenarioSpecs({ targetExternalPath });
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

function applyScenarioPackRuntimePolicy(spec) {
  const timeoutPolicy = getScenarioTimeoutPolicy(spec.id);
  const maxRuntimeMs = Number(timeoutPolicy?.maxRuntimeMs);
  return {
    ...spec,
    timeoutMs: Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0 ? maxRuntimeMs : spec.timeoutMs,
    timeoutPolicy: timeoutPolicy ?? null,
  };
}

function resolveRealTaskWaveLiveModel(specs) {
  const explicitModel = process.env.REAL_TASK_WAVE_LIVE_MODEL?.trim();
  if (explicitModel) {
    return explicitModel;
  }
  return XIAOMI_MIMO_STRONG_MODEL;
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
  const packArtifactAudit = await runScenarioPackBoundaryArtifactAudit(spec, {
    workspaceDir,
    workspaceRelativeFiles,
    sharedQuality,
    scenarioState,
    runNodeProjectBuild: maybeRunNodeProjectBuild,
    runCommandCapture,
    npmCommand,
    hostObservation: {
      summaryText: buildTaskSummaryText(scenarioState),
      toolEvidenceCount: getVisibleToolActivities(scenarioState).length,
      successfulDesktopEvidence: hasDesktopObservationEvidence(scenarioState),
      hostTruth,
      issueSummary: scenarioState.debug?.executionSummary?.issueSummary ?? '',
    },
  });
  if (packArtifactAudit) {
    return packArtifactAudit;
  }

  if (isWebScenario(spec)) {
    const externalFiles = await listFilesRecursive(targetExternalPath, { maxDepth: 6 }).catch(() => []);
    const externalRelativeFiles = externalFiles.map((filePath) => normalizeSlashes(path.relative(targetExternalPath, filePath)));
    const auditPolicy = getScenarioArtifactAuditPolicy(spec.id);
    const preferredProjectKinds = getScenarioProjectKinds(spec.id);
    const workspaceProjects = await detectWorkspaceProjects(workspaceDir, { maxDepth: 4 });
    const externalProjects = await detectWorkspaceProjects(targetExternalPath, { maxDepth: 4 }).catch(() => []);
    const primaryProject = selectPrimaryProject([...externalProjects, ...workspaceProjects], {
      preferredKinds: preferredProjectKinds.length > 0 ? preferredProjectKinds : undefined,
    });
    const buildAudit = primaryProject?.kind === 'node' ? await maybeRunNodeProjectBuild(primaryProject.root) : null;
    const staticIndexPath = primaryProject?.kind === 'static_site'
      ? primaryProject.markerPath
      : externalFiles.find((filePath) => path.basename(filePath).toLowerCase() === 'index.html') ?? null;
    const staticPreviewAudit = primaryProject?.kind !== 'node' && staticIndexPath
      ? await maybePreviewStaticSite(staticIndexPath, browser, screenshotRoot, spec.id)
      : null;
    const previewAudit =
      primaryProject?.kind === 'node' && buildAudit?.build?.exitCode === 0
        ? await maybePreviewNodeProject(primaryProject.root, browser, screenshotRoot, spec.id)
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
      primaryProject,
      primaryProjectRoot: primaryProject?.root ?? (staticIndexPath ? targetExternalPath : null),
      buildAudit,
      previewAudit,
      pass:
        sharedQuality.verdict === 'passed'
        && externalRelativeFiles.length > 0
        && (nodeProjectSatisfied || staticSiteSatisfied),
      notes: {
        auditPolicy,
        externalProjectCount: externalProjects.length,
        workspaceProjectCount: workspaceProjects.length,
        projectDetections: [...externalProjects, ...workspaceProjects].map((project) => ({
          kind: project.kind,
          root: project.root,
          markerRelativePath: project.markerRelativePath,
          verifyCommand: project.verifyCommand,
        })),
        staticSiteSatisfied,
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
  return classifyScenarioWithPolicy(spec.id, {
    surfacesPass,
    lifecycleStatus,
    acceptanceVerdict,
    qualityVerdict,
    artifactPass: artifactAudit.pass,
    environmentBlocked: hasEnvironmentBlockerSignal(scenarioState),
    externalFileCount: Array.isArray(artifactAudit.externalRelativeFiles)
      ? artifactAudit.externalRelativeFiles.length
      : 0,
    targetExternalPath,
    hasHostObservationEvidence: hasDesktopObservationEvidence(scenarioState),
    honestBlocker: Boolean(
      artifactAudit.notes?.honestBlocker
        || /no real host observability|does not provide direct desktop|no desktop automation capabilities available|cannot perform real desktop or application-level operations/i.test(summaryText),
    ),
    verificationScriptExitCode: artifactAudit.notes?.verificationScriptAudit?.exitCode ?? null,
    providerFailureSummary: formatProviderFailureSummary(getScenarioProviderFailure(scenarioState)),
    ...getScenarioPackClassificationFacts(spec, scenarioState, artifactAudit),
  });
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
  const blogScenarios = getScenarioIdsForPack('web')
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
  const systemScenarios = [
    ...getScenarioIdsForPack('system-audit'),
    ...getScenarioIdsForPack('desktop-observation'),
  ]
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
  issues.push(...summarizeScenarioPackConfirmedIssues(report));
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
    `- Verification mode: ${report.verificationMode ?? 'automated_wave'}`,
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
    lines.push(`- Verification mode: ${scenario.verificationMode ?? report.verificationMode ?? 'automated_wave'}`);
    lines.push(`- Manual review required: ${scenario.manualReviewRequired === true}`);
    lines.push(`- Classification: ${scenario.classification}`);
    lines.push(`- Task ID: ${scenario.taskId}`);
    lines.push(`- Lifecycle: ${scenario.lifecycleStatus}`);
    lines.push(`- Blocking reason: ${scenario.blockingReason ?? 'n/a'}`);
    lines.push(`- Next action: ${scenario.nextAction ?? 'n/a'}`);
    lines.push(`- Acceptance verdict: ${scenario.acceptanceVerdict ?? 'n/a'}`);
    lines.push(`- Quality verdict: ${scenario.qualityVerdict ?? 'n/a'} (profile: ${scenario.qualityProfileId ?? 'none'}, gate: ${scenario.qualityGateId ?? 'none'})`);
    lines.push(`- Visible tool activities: ${scenario.visibleToolActivityCount}`);
    if (scenario.providerFailureSummary) {
      lines.push(`- Provider failure: ${scenario.providerFailureSummary}`);
    }
    lines.push(`- Human CLI pass: ${scenario.surfaceChecks.human.pass}`);
    lines.push(`- Agent CLI pass: ${scenario.surfaceChecks.agent.pass}`);
    lines.push(`- Web pass: ${scenario.surfaceChecks.web.pass}`);
    lines.push(`- Artifact audit pass: ${scenario.artifactAudit.pass}`);
    const artifactProgressSummary = formatScenarioPackArtifactProgress(scenario.artifactProgress);
    if (artifactProgressSummary) {
      lines.push(`- Artifact progress: ${artifactProgressSummary}`);
    }
    lines.push(`- Classification reason: ${scenario.classificationReason}`);
    lines.push('');
  }

  lines.push('## Confirmed Issues', '');
  for (const issue of report.confirmedIssues) {
    lines.push(`- ${issue.issue}: ${issue.evidence} (${issue.scenarios.join(', ')})`);
  }

  if (report.manualReview?.required) {
    lines.push('', '## Manual Review', '');
    lines.push(`- Status: ${report.manualReview.status ?? 'manual_review_required'}`);
    lines.push(`- Markdown: ${report.manualReview.markdownPath}`);
    lines.push(`- JSON: ${report.manualReview.jsonPath}`);
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
  const unitSpecs = Array.isArray(spec.units) && spec.units.length > 0
    ? spec.units
    : [spec.unit];
  const defaultQualityProfileId =
    spec.defaultQualityProfileId
    ?? unitSpecs.find((unit) => unit?.qualityProfileId)?.qualityProfileId
    ?? undefined;
  const taskDefinition = {
    title: spec.title,
    intent: spec.intent,
    defaultQualityProfileId,
    preferredProviderId: XIAOMI_MIMO_FLASH_PROVIDER_ID,
    pathPolicy: spec.pathPolicy,
    metadata: {
      source: 'real-task-wave',
      scenarioId: spec.id,
    },
    units: unitSpecs.map((unit, index) => ({
      id: unit.id ?? `AGENT-${String(index + 1).padStart(3, '0')}`,
      role: unit.role,
      goal: unit.goal,
      outputContract: unit.outputContract,
      dependencies: Array.isArray(unit.dependencies) ? unit.dependencies : [],
      executionProfileId: unit.executionProfileId,
      qualityProfileId: unit.qualityProfileId ?? undefined,
      taskScope: unit.taskScope,
    })),
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
  let latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec);
  const startedAt = Date.now();
  const verificationMode = context.verificationMode ?? 'automated_wave';
  const manualReviewMode = requiresManualReview(verificationMode);

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

  while (!manualReviewMode && Date.now() - startedAt < spec.timeoutMs) {
    latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec);
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
      if (hasStaleContinueNoProgress(latestContinueAttempt, latestState)) {
        latestContinueAttempt.noProgress = true;
        stopReason = 'continue_no_progress';
        break;
      }
    }
    const latestContinueAttemptForProgress = [...continueAttempts]
      .reverse()
      .find((attempt) => typeof attempt?.issuedAt === 'number');
    if (
      latestContinueAttemptForProgress
      && latestContinueAttemptForProgress !== latestContinueAttempt
      && hasStaleContinueNoProgress(latestContinueAttemptForProgress, latestState)
    ) {
      latestContinueAttemptForProgress.noProgress = true;
      stopReason = 'continue_no_progress';
      break;
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
      if (continueMessage && shouldSuppressDuplicateContinueInstruction(continueMessage, latestState, continueAttempts)) {
        if (hasInactiveRunningNoProgress(latestState)) {
          stopReason = 'continue_no_progress';
          break;
        }
        if (hasDuplicateContinueNoProgress(continueMessage, latestState, continueAttempts)) {
          stopReason = 'continue_no_progress';
          break;
        }
        await sleep(2000);
        continue;
      }
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
    if (continueMessage && shouldSuppressDuplicateContinueInstruction(continueMessage, latestState, continueAttempts)) {
      if (hasInactiveRunningNoProgress(latestState)) {
        stopReason = 'continue_no_progress';
        break;
      }
      const forcedBenchmarkSelfCheck = shouldForceScenarioPackBenchmarkSelfCheck(spec, latestState, continueAttempts)
        ? buildScenarioPackBenchmarkSelfCheckInstruction(
          'A previous static prototype repair instruction would be a duplicate, while the quality gate now specifically requires benchmark self-check evidence.'
        )
        : null;
      if (
        forcedBenchmarkSelfCheck
        && canIssueContinue(spec, continueAttempts, forcedBenchmarkSelfCheck)
        && !shouldSuppressDuplicateContinueInstruction(forcedBenchmarkSelfCheck, latestState, continueAttempts)
        && await tryIssueContinue(forcedBenchmarkSelfCheck, 'forced benchmark self-check after duplicate repair')
      ) {
        await sleep(2000);
        continue;
      }
      if (hasDuplicateContinueNoProgress(continueMessage, latestState, continueAttempts)) {
        stopReason = 'continue_no_progress';
        break;
      }
      await sleep(2000);
      continue;
    }

    if (continueMessage && canIssueContinue(spec, continueAttempts, continueMessage)) {
      if (await tryIssueContinue(continueMessage, 'continue')) {
        await sleep(2000);
        continue;
      }
    }

    if (continueMessage) {
      const normalizedContinue = normalizeContinueInstruction(continueMessage);
      const baseBudget = getScenarioContinueBudget(spec);
      if (
        normalizedContinue
        && normalizedContinue?.metadata?.phase !== 'finalize'
        && Array.isArray(continueAttempts)
        && continueAttempts.length >= baseBudget
      ) {
        stopReason = 'continue_budget_exhausted';
        break;
      }
    }

    const correctionKind = getRuntimeCorrectionKind(latestState);
    if (!continueMessage && hasRuntimeCorrectionNoProgress(latestState)) {
      stopReason = 'continue_no_progress';
      break;
    }
    if (!continueMessage && hasInactiveRunningNoProgress(latestState)) {
      stopReason = 'continue_no_progress';
      break;
    }
    if (spec.stopOnAwaitingTool && correctionKind === 'AWAITING_TOOL_ACTION') {
      stopReason = 'awaiting_tool_action';
      break;
    }

    await sleep(2000);
  }

  if (!manualReviewMode && !isTerminalLifecycleStatus(latestState.summary.lifecycleStatus)) {
    latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec)
      .catch(() => latestState);
  }

  if (!manualReviewMode && !isTerminalLifecycleStatus(latestState.summary.lifecycleStatus)) {
    const finalizationInstruction = deriveContinueMessage(spec, latestState);
    const normalizedFinalization = normalizeContinueInstruction(finalizationInstruction);
    if (
      normalizedFinalization?.metadata?.phase === 'finalize'
      && canIssueContinue(spec, continueAttempts, normalizedFinalization)
      && await tryIssueContinue(normalizedFinalization, 'finalize after evidence timeout')
    ) {
      await sleep(2000);
      latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec)
        .catch(() => latestState);
    }
  }

  if (!manualReviewMode && !isTerminalLifecycleStatus(latestState.summary.lifecycleStatus)) {
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
    latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec)
      .catch(() => latestState);
  }

  if (manualReviewMode) {
    stopReason = 'submit_only_manual_review';
    const observeStartedAt = Date.now();
    const observeMs = getSubmitOnlyObserveMs(spec);
    while (Date.now() - observeStartedAt < observeMs) {
      latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec)
        .catch(() => latestState);
      if (isTerminalLifecycleStatus(latestState.summary.lifecycleStatus)) {
        break;
      }
      await sleep(2000);
    }
    if (!isTerminalLifecycleStatus(latestState.summary.lifecycleStatus)) {
      timedOut = true;
      stopReason = 'submit_only_observation_timeout';
      await runCli([
        '--server',
        context.serverUrl,
        'tasks',
        'cancel',
        taskId,
        '--reason',
        `Manual-review mode stopped observation for ${spec.id}; inspect generated artifacts instead of relying on harness repair turns.`,
      ], context.liveEnv).catch(() => null);
      latestState = await captureScenarioState(context.serverUrl, taskId, workspaceDir, spec)
        .catch(() => latestState);
    }
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
    verificationMode,
    manualReviewRequired: manualReviewMode,
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
    qualityProfileId: getScenarioQualityProfileId(spec),
    qualityGateId: getScenarioQualityGateId(spec),
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
  const verificationMode = resolveRealTaskWaveVerificationMode();
  const selectedScenarioSpecs = filterScenarioSpecs(buildScenarioSpecsLive()).map(applyScenarioPackRuntimePolicy);
  const requestedLiveModel = resolveRealTaskWaveLiveModel(selectedScenarioSpecs);
  const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, {
    model: requestedLiveModel,
    allowCompatibleModelFallback: true,
    requireTextAgentModel: true
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
  const cleanup = await cleanRealTaskWaveState({
    rootDir,
    externalPaths: [targetExternalPath],
    preservedRepoPathPrefixes: ['.codex-run/logs/real-task-wave-matrix'],
  });
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir, {
    model: liveModel,
    requireTextAgentModel: true
  });
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
    verificationMode,
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
      reportJsonPath,
      reportMarkdownPath,
      manualReviewJsonPath,
      manualReviewMarkdownPath,
      manualReviewArtifactRoot,
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
    manualReview: requiresManualReview(verificationMode)
      ? {
          required: true,
          status: 'manual_review_pending',
          jsonPath: manualReviewJsonPath,
          markdownPath: manualReviewMarkdownPath,
          artifactBundleRoot: manualReviewArtifactRoot,
        }
      : null,
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

    browser = await launchValidationBrowser(chromeExecutable);
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
        verificationMode,
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
    if (requiresManualReview(verificationMode)) {
      const manualReview = await generateRealTaskManualReview({
        reportPath: reportJsonPath,
        jsonPath: manualReviewJsonPath,
        markdownPath: manualReviewMarkdownPath,
        artifactBundleRoot: manualReviewArtifactRoot,
      });
      report.manualReview = {
        required: true,
        status: manualReview.review.status,
        jsonPath: manualReview.jsonPath,
        markdownPath: manualReview.markdownPath,
        artifactBundleRoot: manualReview.artifactBundleRoot,
        generatedAt: manualReview.review.generatedAt,
        totals: manualReview.review.totals,
      };
      await writeJson(reportJsonPath, report);
      await writeText(reportMarkdownPath, buildMarkdownReport(report));
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!requiresManualReview(verificationMode) && report.scenarios.some((scenario) => scenario.classification !== 'passed')) {
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
  classifyScenario,
  deriveContinueMessage,
  formatProviderFailureSummary,
  detectContinueInstructionDrift,
  isRecoverableContinueInstructionDrift,
  canIssueContinue,
  buildScenarioPackBenchmarkSelfCheckInstruction,
  resolveRealTaskWaveLiveModel,
  resolveRealTaskWaveVerificationMode,
  normalizeContinueInstruction,
  shouldStopScenarioEarly,
  shouldSuppressDuplicateContinueInstruction,
  hasDuplicateContinueNoProgress,
  hasStaleContinueNoProgress,
  hasRuntimeCorrectionNoProgress,
  hasInactiveRunningNoProgress,
};
