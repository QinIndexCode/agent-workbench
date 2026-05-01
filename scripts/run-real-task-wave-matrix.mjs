import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanRealTaskWaveState } from './clean-real-task-wave-state.mjs';
import {
  readXiaomiMimoFlashProviderSource,
  XIAOMI_MIMO_COMPAT_MODEL,
  XIAOMI_MIMO_PRO_MODEL,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';

const rootDir = process.cwd();
const dotCodexRunRoot = path.resolve(rootDir, '.codex-run');
const reportDir = path.join(dotCodexRunRoot, 'logs');
const reportJsonPath = path.join(reportDir, 'real-task-wave-report.json');
const reportMarkdownPath = path.join(reportDir, 'real-task-wave-report.md');
const matrixLogRoot = path.join(reportDir, 'real-task-wave-matrix');
const providerRateLimitStatePath = path.join(matrixLogRoot, '_live-provider-rate-limit-state.json');
const targetExternalPath = 'D:\\AAA';
const DEFAULT_RUN_TIMEOUT_MS = Number.parseInt(process.env.REAL_TASK_WAVE_MATRIX_RUN_TIMEOUT_MS ?? `${75 * 60 * 1000}`, 10);
const DEFAULT_POST_REPORT_GRACE_MS = Number.parseInt(
  process.env.REAL_TASK_WAVE_MATRIX_POST_REPORT_GRACE_MS ?? `${30 * 1000}`,
  10,
);
const DEFAULT_PROVIDER_COOLDOWN_MS = Number.parseInt(
  process.env.REAL_TASK_WAVE_MATRIX_PROVIDER_COOLDOWN_MS ?? `${60 * 1000}`,
  10,
);

const CORE_SCENARIOS = [
  'path-blog-greenfield',
  'path-blog-followup',
  'docs-normalize-batch',
  'docs-synthesize-handbook',
  'system-health-audit',
  'desktop-ops-followup',
];

const DATABASE_SCENARIOS = [
  'database-near-mysql-design',
  'database-near-mysql-verify',
];

const MATRIX_PHASES = [
  {
    id: 'core',
    label: 'Phase A - non-DB core scenarios',
    scenarios: CORE_SCENARIOS,
    models: [XIAOMI_MIMO_STRONG_MODEL, XIAOMI_MIMO_PRO_MODEL, XIAOMI_MIMO_COMPAT_MODEL],
  },
  {
    id: 'database',
    label: 'Phase B - database scenario pack',
    scenarios: DATABASE_SCENARIOS,
    models: [XIAOMI_MIMO_STRONG_MODEL, XIAOMI_MIMO_PRO_MODEL],
  },
  {
    id: 'full',
    label: 'Phase C - combined regression',
    scenarios: [...CORE_SCENARIOS, ...DATABASE_SCENARIOS],
    models: [XIAOMI_MIMO_STRONG_MODEL],
  },
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseArgValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasArg(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseCsv(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function createTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function slugify(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function costGuardConfigured(env = process.env) {
  return Boolean(env.LIVE_COST_MAX_API_CALLS?.trim() || env.LIVE_COST_MAX_TOTAL_TOKENS?.trim());
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

async function copyIfExists(source, destination) {
  if (!(await pathExists(source))) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  return true;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveSelectedEntries() {
  const requestedPhases = new Set(parseCsv(parseArgValue('phases') ?? process.env.REAL_TASK_WAVE_MATRIX_PHASES ?? ''));
  const requestedModels = new Set(parseCsv(parseArgValue('models') ?? process.env.REAL_TASK_WAVE_MATRIX_MODELS ?? ''));
  const unknownPhases = [...requestedPhases].filter((phaseId) => !MATRIX_PHASES.some((phase) => phase.id === phaseId));
  if (unknownPhases.length > 0) {
    throw new Error(`Unknown real-task-wave matrix phase(s): ${unknownPhases.join(', ')}`);
  }
  const selected = [];
  for (const phase of MATRIX_PHASES) {
    if (requestedPhases.size > 0 && !requestedPhases.has(phase.id)) {
      continue;
    }
    for (const model of phase.models) {
      if (requestedModels.size > 0 && !requestedModels.has(model)) {
        continue;
      }
      selected.push({ phase, requestedModel: model });
    }
  }
  if (selected.length === 0) {
    throw new Error('No real-task-wave matrix entries selected.');
  }
  return selected;
}

async function openAppendFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return fs.open(filePath, 'a');
}

function isCompletionPathSatisfied(options) {
  if (!options.completionPath || !fsSync.existsSync(options.completionPath)) {
    return false;
  }
  const expectedScenarioIds = Array.isArray(options.completionScenarioIds)
    ? options.completionScenarioIds.filter(Boolean)
    : [];
  if (expectedScenarioIds.length === 0) {
    return true;
  }
  try {
    const report = JSON.parse(fsSync.readFileSync(options.completionPath, 'utf8'));
    const observedScenarioIds = new Set(
      (Array.isArray(report.scenarios) ? report.scenarios : [])
        .map((scenario) => scenario?.id)
        .filter(Boolean),
    );
    return expectedScenarioIds.every((scenarioId) => observedScenarioIds.has(scenarioId));
  } catch {
    return false;
  }
}

function terminateChildTree(child) {
  if (!child?.pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
      return;
    } catch {
      // Fall back to the direct child kill below.
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort only; callers record timeout or post-report cleanup state.
  }
}

async function runChild(command, args, options) {
  const startedAt = Date.now();
  const stdoutFile = await openAppendFile(options.stdoutPath);
  const stderrFile = await openAppendFile(options.stderrPath);
  let timedOut = false;
  let postCompletionKilled = false;
  let completionObservedAt = null;
  let stdoutTail = '';
  let stderrTail = '';
  let completionTimer = null;
  let completionPoll = null;
  const appendTail = (current, chunk) => {
    const next = `${current}${chunk}`;
    return next.length > 8000 ? next.slice(-8000) : next;
  };

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      windowsHide: true,
      shell: false,
    });

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_RUN_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child);
    }, timeoutMs);

    if (options.completionPath) {
      const completionGraceMs = Number.isFinite(options.completionGraceMs) && options.completionGraceMs > 0
        ? options.completionGraceMs
        : DEFAULT_POST_REPORT_GRACE_MS;
      const pollMs = Number.isFinite(options.completionPollMs) && options.completionPollMs > 0
        ? options.completionPollMs
        : 1000;
      completionPoll = setInterval(() => {
        if (completionObservedAt !== null || !isCompletionPathSatisfied(options)) {
          return;
        }
        completionObservedAt = Date.now();
        completionTimer = setTimeout(() => {
          postCompletionKilled = true;
          terminateChildTree(child);
        }, completionGraceMs);
      }, pollMs);
    }

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdoutTail = appendTail(stdoutTail, text);
      stdoutFile.write(text).catch(() => {});
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = appendTail(stderrTail, text);
      stderrFile.write(text).catch(() => {});
    });
    child.on('error', (error) => {
      stderrTail = appendTail(stderrTail, `${error.stack ?? error.message}\n`);
    });
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timeout);
      if (completionPoll) {
        clearInterval(completionPoll);
      }
      if (completionTimer) {
        clearTimeout(completionTimer);
      }
      await stdoutFile.close().catch(() => {});
      await stderrFile.close().catch(() => {});
      resolve({
        command,
        args,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal,
        timedOut,
        postCompletionKilled,
        completionObservedAt,
        durationMs: Date.now() - startedAt,
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
        stdoutTail,
        stderrTail,
      });
    });
  });
}

async function runNpmScript(scriptName, options) {
  if (process.platform === 'win32') {
    return runChild('powershell.exe', [
      '-NoProfile',
      '-Command',
      `& '${npmCommand().replace(/'/g, "''")}' run ${scriptName.replace(/'/g, "''")}`,
    ], options);
  }
  return runChild('npm', ['run', scriptName], options);
}

async function runLiveCostProbe(runDir, effectiveModel) {
  const result = await runChild(process.execPath, ['scripts/run-live-cost-probe.mjs'], {
    cwd: rootDir,
    env: {
      XIAOMI_MIMO_LIVE_MODEL: effectiveModel,
    },
    stdoutPath: path.join(runDir, 'live-cost-probe.stdout.log'),
    stderrPath: path.join(runDir, 'live-cost-probe.stderr.log'),
    timeoutMs: Number.parseInt(process.env.REAL_TASK_WAVE_MATRIX_PROBE_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10),
  });
  await copyIfExists(
    path.join(reportDir, 'live-cost-probe.json'),
    path.join(runDir, 'live-cost-probe.json'),
  );
  return result;
}

async function archiveWaveArtifacts(runDir) {
  const copied = [];
  const copyFile = async (name) => {
    const didCopy = await copyIfExists(path.join(reportDir, name), path.join(runDir, name));
    if (didCopy) {
      copied.push(name);
    }
  };
  await copyFile('real-task-wave-report.json');
  await copyFile('real-task-wave-report.md');
  await copyFile('real-task-wave-command-log.ndjson');
  await copyFile('real-task-wave-backend-build.json');
  for (const directoryName of ['real-task-wave', 'real-task-wave-screenshots']) {
    const didCopy = await copyIfExists(path.join(reportDir, directoryName), path.join(runDir, directoryName));
    if (didCopy) {
      copied.push(directoryName);
    }
  }
  return copied;
}

async function restoreMatrixCache(cacheRoot, repoMatrixRoot) {
  await fs.mkdir(path.dirname(repoMatrixRoot), { recursive: true });
  await fs.rm(repoMatrixRoot, { recursive: true, force: true });
  await fs.cp(cacheRoot, repoMatrixRoot, { recursive: true, force: true });
}

function summarizeScenarios(report) {
  return (Array.isArray(report?.scenarios) ? report.scenarios : []).map((scenario) => ({
    id: scenario.id,
    taskId: scenario.taskId ?? null,
    lifecycleStatus: scenario.lifecycleStatus ?? null,
    acceptanceVerdict: scenario.acceptanceVerdict ?? null,
    qualityProfileId: scenario.qualityProfileId ?? null,
    qualityGateId: scenario.qualityGateId ?? null,
    qualityVerdict: scenario.qualityVerdict ?? null,
    classification: scenario.classification ?? null,
    stopReason: scenario.stopReason ?? null,
    providerFailureSummary: scenario.providerFailureSummary ?? null,
    artifactProgress: scenario.artifactProgress ?? null,
  }));
}

function determineRunStatus(result, report, costProbe) {
  if (costProbe && costProbe.exitCode !== 0) {
    return 'cost_probe_failed';
  }
  if (result?.timedOut) {
    return 'timed_out';
  }
  if (!report) {
    return 'report_missing';
  }
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  if (scenarios.length === 0) {
    return result?.exitCode === 0 ? 'no_scenarios' : 'failed';
  }
  const allPassed = scenarios.every((scenario) => scenario.classification === 'passed');
  if (allPassed && (result?.exitCode === 0 || result?.postCompletionKilled === true)) {
    return 'passed';
  }
  if (allPassed) {
    return 'passed_with_nonzero_exit';
  }
  if (scenarios.some((scenario) => scenario.classification === 'environment_blocker')) {
    return 'environment_blocker';
  }
  return 'failed';
}

function hasProviderRateLimitOrTimeout(scenarios) {
  return (Array.isArray(scenarios) ? scenarios : []).some((scenario) => {
    const summary = String(scenario.providerFailureSummary ?? '');
    return /(?:rate[- ]?limit|timeout|timed out|local_abort|status=408|upstream \(408\))/i.test(summary);
  });
}

async function waitForProviderCooldown(entry, providerSource) {
  const cooldownMs = Number.isFinite(DEFAULT_PROVIDER_COOLDOWN_MS) && DEFAULT_PROVIDER_COOLDOWN_MS > 0
    ? DEFAULT_PROVIDER_COOLDOWN_MS
    : 0;
  const policy = {
    sharedCredentialSerial: true,
    cooldownMs,
    waitedMs: 0,
    statePath: providerRateLimitStatePath,
    reason: null,
    previousUse: null,
  };
  if (cooldownMs <= 0) {
    entry.providerRateLimit = policy;
    return policy;
  }

  const previousUse = await readJsonIfExists(providerRateLimitStatePath);
  if (previousUse?.finishedAtMs) {
    const elapsedMs = Math.max(0, Date.now() - Number(previousUse.finishedAtMs));
    const waitMs = Math.max(0, cooldownMs - elapsedMs);
    policy.previousUse = {
      runId: previousUse.runId ?? null,
      providerId: previousUse.providerId ?? null,
      requestedModel: previousUse.requestedModel ?? null,
      effectiveModel: previousUse.effectiveModel ?? null,
      status: previousUse.status ?? null,
      finishedAt: previousUse.finishedAt ?? null,
      elapsedMs,
    };
    if (waitMs > 0) {
      policy.waitedMs = waitMs;
      policy.reason = 'shared_api_key_cooldown';
      process.stdout.write(`[matrix] waiting ${waitMs}ms before ${entry.runId} to avoid shared API-key rate-limit overlap\n`);
      await sleep(waitMs);
    }
  }

  entry.providerRateLimit = policy;
  await writeJson(providerRateLimitStatePath, {
    runId: entry.runId,
    providerId: providerSource.providerId,
    requestedModel: providerSource.requestedModel,
    effectiveModel: providerSource.model,
    status: 'running',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  });
  return policy;
}

async function recordProviderUseFinished(entry) {
  await writeJson(providerRateLimitStatePath, {
    runId: entry.runId,
    providerId: entry.provider?.id ?? entry.provider?.providerId ?? null,
    requestedModel: entry.requestedModel,
    effectiveModel: entry.effectiveModel,
    status: entry.status,
    exitCode: entry.exitCode,
    sharedCredentialTimeoutLikely: Boolean(entry.sharedCredentialTimeoutLikely),
    finishedAt: new Date().toISOString(),
    finishedAtMs: Date.now(),
  });
}

function buildSummaryMarkdown(summary) {
  const lines = [
    '# Real Task Wave Matrix Summary',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Matrix root: ${summary.matrixRoot}`,
    `- Provider cooldown: ${summary.rateLimitPolicy.cooldownMs}ms, shared credential serial: ${summary.rateLimitPolicy.sharedCredentialSerial ? 'yes' : 'no'}`,
    `- Runs: ${summary.totals.total}, passed: ${summary.totals.passed}, failed: ${summary.totals.failed}`,
    '',
    '| Phase | Requested model | Effective model | Fallback | Status | Exit | Cooldown | Shared-key timeout | Scenarios |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of summary.runs) {
    const scenarioText = run.scenarios.length > 0
      ? run.scenarios.map((scenario) => `${scenario.id}:${scenario.classification ?? 'n/a'}`).join('<br>')
      : 'n/a';
    lines.push(`| ${run.phase} | ${run.requestedModel} | ${run.effectiveModel ?? 'n/a'} | ${run.fallbackApplied ? 'yes' : 'no'} | ${run.status} | ${run.exitCode ?? 'n/a'} | ${run.providerRateLimit?.waitedMs ?? 0}ms | ${run.sharedCredentialTimeoutLikely ? 'yes' : 'no'} | ${scenarioText} |`);
  }
  const failedRuns = summary.runs.filter((run) => run.status !== 'passed');
  if (failedRuns.length > 0) {
    lines.push('', '## Non-Passing Runs', '');
    for (const run of failedRuns) {
      lines.push(`- ${run.phase}/${run.requestedModel}: ${run.status}`);
      for (const scenario of run.scenarios.filter((entry) => entry.classification !== 'passed')) {
        lines.push(`  - ${scenario.id}: ${scenario.classification ?? 'n/a'}; quality=${scenario.qualityVerdict ?? 'n/a'}; gate=${scenario.qualityGateId ?? 'none'}; provider=${scenario.providerFailureSummary ?? 'none'}`);
      }
      if (run.error) {
        lines.push(`  - error: ${run.error}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function writeMatrixSummary(cacheRoot, repoMatrixRoot, summary) {
  await writeJson(path.join(cacheRoot, 'matrix-summary.json'), summary);
  await writeText(path.join(cacheRoot, 'matrix-summary.md'), buildSummaryMarkdown(summary));
  await restoreMatrixCache(cacheRoot, repoMatrixRoot);
}

async function cleanAfterRun(cacheRoot, repoMatrixRoot) {
  const cleanup = await cleanRealTaskWaveState({
    rootDir,
    externalPaths: [targetExternalPath],
    preservedRepoPathPrefixes: ['.codex-run/logs/real-task-wave-matrix'],
  });
  await restoreMatrixCache(cacheRoot, repoMatrixRoot);
  return cleanup;
}

async function runMatrixEntry(params) {
  const { phase, requestedModel, index, cacheRoot, repoMatrixRoot, skipCostProbe } = params;
  const runId = `${String(index + 1).padStart(2, '0')}-${phase.id}-${slugify(requestedModel)}`;
  const runDir = path.join(cacheRoot, runId);
  await fs.mkdir(runDir, { recursive: true });

  const entry = {
    runId,
    phase: phase.id,
    phaseLabel: phase.label,
    requestedModel,
    effectiveModel: null,
    fallbackApplied: false,
    scenariosRequested: phase.scenarios,
    status: 'not_started',
    exitCode: null,
    durationMs: 0,
    reportPath: path.join(repoMatrixRoot, runId, 'real-task-wave-report.json'),
    markdownReportPath: path.join(repoMatrixRoot, runId, 'real-task-wave-report.md'),
    command: null,
    costProbe: null,
    preflight: null,
    provider: null,
    providerRateLimit: null,
    sharedCredentialTimeoutLikely: false,
    scenarios: [],
    copiedArtifacts: [],
    cleanup: null,
    error: null,
  };

  try {
    const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, {
      model: requestedModel,
      allowCompatibleModelFallback: true,
      requireTextAgentModel: true,
    });
    entry.effectiveModel = providerSource.model;
    entry.fallbackApplied = providerSource.requestedModel !== providerSource.model;
    entry.provider = {
      id: providerSource.providerId,
      requestedModel: providerSource.requestedModel,
      model: providerSource.model,
      baseUrl: providerSource.baseUrl,
      sourceFile: providerSource.docPath,
    };
    await waitForProviderCooldown(entry, providerSource);
  } catch (error) {
    entry.status = 'model_resolution_failed';
    entry.error = error instanceof Error ? error.message : String(error);
    await writeJson(path.join(runDir, 'matrix-entry.json'), entry);
    entry.cleanup = await cleanAfterRun(cacheRoot, repoMatrixRoot);
    return entry;
  }

  if (!skipCostProbe && costGuardConfigured()) {
    entry.costProbe = await runLiveCostProbe(runDir, entry.effectiveModel);
    if (entry.costProbe.exitCode !== 0) {
      entry.status = 'cost_probe_failed';
      entry.error = entry.costProbe.stderrTail || entry.costProbe.stdoutTail || 'live-cost-probe failed';
      await recordProviderUseFinished(entry);
      await writeJson(path.join(runDir, 'matrix-entry.json'), entry);
      entry.cleanup = await cleanAfterRun(cacheRoot, repoMatrixRoot);
      return entry;
    }
  }

  const startedAt = Date.now();
  const waveResult = await runNpmScript('real-task-wave', {
    cwd: rootDir,
    env: {
      REAL_TASK_WAVE_LIVE_MODEL: requestedModel,
      REAL_TASK_WAVE_SCENARIOS: phase.scenarios.join(','),
      REAL_TASK_WAVE_PRESERVE_MATRIX_LOGS: '1',
    },
    stdoutPath: path.join(runDir, 'real-task-wave.stdout.log'),
    stderrPath: path.join(runDir, 'real-task-wave.stderr.log'),
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    completionPath: reportJsonPath,
    completionScenarioIds: phase.scenarios,
    completionGraceMs: DEFAULT_POST_REPORT_GRACE_MS,
  });
  entry.command = waveResult;
  entry.exitCode = waveResult.exitCode;
  entry.durationMs = Date.now() - startedAt;
  entry.copiedArtifacts = await archiveWaveArtifacts(runDir);
  const report = await readJsonIfExists(reportJsonPath);
  entry.preflight = report?.preflight ?? null;
  entry.provider = report?.provider ?? entry.provider;
  entry.effectiveModel = report?.provider?.model ?? entry.effectiveModel;
  entry.fallbackApplied = Boolean(report?.preflight?.modelRouting?.fallbackApplied ?? entry.fallbackApplied);
  entry.scenarios = summarizeScenarios(report);
  entry.status = determineRunStatus(waveResult, report, entry.costProbe);
  entry.sharedCredentialTimeoutLikely = entry.status === 'environment_blocker' && hasProviderRateLimitOrTimeout(entry.scenarios);
  await recordProviderUseFinished(entry);
  await writeJson(path.join(runDir, 'matrix-entry.json'), entry);
  entry.cleanup = await cleanAfterRun(cacheRoot, repoMatrixRoot);
  await writeJson(path.join(runDir, 'matrix-entry.json'), entry);
  return entry;
}

async function main() {
  const selectedEntries = resolveSelectedEntries();
  if (hasArg('list') || process.env.REAL_TASK_WAVE_MATRIX_LIST === '1') {
    const entries = [];
    for (const selected of selectedEntries) {
      const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, {
        model: selected.requestedModel,
        allowCompatibleModelFallback: true,
        requireTextAgentModel: true,
      });
      entries.push({
        phase: selected.phase.id,
        requestedModel: selected.requestedModel,
        effectiveModel: providerSource.model,
        fallbackApplied: providerSource.requestedModel !== providerSource.model,
        scenarios: selected.phase.scenarios,
      });
    }
    process.stdout.write(`${JSON.stringify({ entries }, null, 2)}\n`);
    return;
  }
  const timestamp = process.env.REAL_TASK_WAVE_MATRIX_ID?.trim() || createTimestamp();
  const repoMatrixRoot = path.join(reportDir, 'real-task-wave-matrix', timestamp);
  const cacheRoot = path.join(os.tmpdir(), `scc-real-task-wave-matrix-${timestamp}-${process.pid}`);
  const skipCostProbe = hasArg('skip-cost-probe') || process.env.REAL_TASK_WAVE_MATRIX_SKIP_COST_PROBE === '1';
  const stopOnFailure = hasArg('stop-on-failure') || process.env.REAL_TASK_WAVE_MATRIX_STOP_ON_FAILURE === '1';
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(cacheRoot, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    rootDir,
    matrixRoot: repoMatrixRoot,
    cacheRoot,
    rateLimitPolicy: {
      sharedCredentialSerial: true,
      cooldownMs: Number.isFinite(DEFAULT_PROVIDER_COOLDOWN_MS) && DEFAULT_PROVIDER_COOLDOWN_MS > 0
        ? DEFAULT_PROVIDER_COOLDOWN_MS
        : 0,
      statePath: providerRateLimitStatePath,
      env: 'REAL_TASK_WAVE_MATRIX_PROVIDER_COOLDOWN_MS',
    },
    selected: selectedEntries.map((entry) => ({
      phase: entry.phase.id,
      requestedModel: entry.requestedModel,
      scenarios: entry.phase.scenarios,
    })),
    runs: [],
    totals: {
      total: selectedEntries.length,
      passed: 0,
      failed: 0,
    },
  };
  await writeMatrixSummary(cacheRoot, repoMatrixRoot, summary);

  for (const [index, selected] of selectedEntries.entries()) {
    process.stdout.write(`[matrix] starting ${index + 1}/${selectedEntries.length}: ${selected.phase.id} requestedModel=${selected.requestedModel}\n`);
    const result = await runMatrixEntry({
      ...selected,
      index,
      cacheRoot,
      repoMatrixRoot,
      skipCostProbe,
    });
    summary.runs.push(result);
    summary.totals.passed = summary.runs.filter((run) => run.status === 'passed').length;
    summary.totals.failed = summary.runs.length - summary.totals.passed;
    await writeMatrixSummary(cacheRoot, repoMatrixRoot, summary);
    process.stdout.write(`[matrix] finished ${result.runId}: ${result.status} exit=${result.exitCode ?? 'n/a'} effectiveModel=${result.effectiveModel ?? 'n/a'}\n`);
    if (stopOnFailure && result.status !== 'passed') {
      break;
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.totals.total = summary.runs.length;
  summary.totals.passed = summary.runs.filter((run) => run.status === 'passed').length;
  summary.totals.failed = summary.runs.length - summary.totals.passed;
  await writeMatrixSummary(cacheRoot, repoMatrixRoot, summary);
  process.stdout.write(`${JSON.stringify({
    matrixRoot: repoMatrixRoot,
    cacheRoot,
    totals: summary.totals,
  }, null, 2)}\n`);
  if (summary.totals.failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
