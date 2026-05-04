import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const reportPath =
  process.env.FLAGSHIP_LOOP_REPORT ??
  path.resolve(rootDir, '.codex-run', 'logs', 'flagship-loop-report.json');
const logsDir = path.resolve(rootDir, '.codex-run', 'logs');
const backendDataDir = path.resolve(rootDir, 'backend', 'data');

const DEFAULT_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.FLAGSHIP_LOOP_COMMAND_TIMEOUT_MS ?? `${12 * 60 * 1000}`,
  10
);
const LONG_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.FLAGSHIP_LOOP_LIVE_TIMEOUT_MS ?? `${30 * 60 * 1000}`,
  10
);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function prepareSpawn(step) {
  if (process.platform === 'win32' && /\.cmd$/i.test(step.command)) {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        `& ${quotePowerShell(step.command)} ${step.args.map((arg) => quotePowerShell(arg)).join(' ')}`
      ],
      displayCommand: [step.command, ...step.args].join(' ')
    };
  }
  return {
    command: step.command,
    args: step.args,
    displayCommand: [step.command, ...step.args].join(' ')
  };
}

function parseFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseIntFlag(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  if (!found) {
    return fallback;
  }
  const value = Number.parseInt(found.slice(prefix.length), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRoundId(index) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `round-${String(index).padStart(2, '0')}-${timestamp}`;
}

function trimOutput(text, maxChars = 12_000) {
  const value = String(text ?? '');
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(-maxChars);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(target) {
  if (!await pathExists(target)) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function directorySize(target) {
  if (!await pathExists(target)) {
    return 0;
  }
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child);
      continue;
    }
    if (entry.isFile()) {
      const stat = await fs.stat(child);
      total += stat.size;
    }
  }
  return total;
}

function classifyFailure(step, outputText, report) {
  const text = `${outputText ?? ''}\n${JSON.stringify(report ?? {})}`.toLowerCase();
  if (text.includes('external_blocker')) {
    return 'external_blocker';
  }
  if (
    text.includes('provider error') ||
    text.includes('upstream') ||
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes(' 500') ||
    text.includes(' 502') ||
    text.includes(' 503') ||
    text.includes(' 504') ||
    text.includes('tls') ||
    text.includes('network') ||
    text.includes('api key') ||
    text.includes('secret')
  ) {
    return 'provider';
  }
  if (
    step.track === 'web' ||
    text.includes('waitforselector') ||
    text.includes('locator') ||
    text.includes('consolefailure') ||
    text.includes('visualfailure')
  ) {
    return 'ui';
  }
  if (
    step.track === 'agent-cli' ||
    text.includes('ndjson') ||
    text.includes('json parse') ||
    text.includes('machine-readable')
  ) {
    return 'harness';
  }
  if (
    text.includes('acceptance') ||
    text.includes('artifactpathstate') ||
    text.includes('contract')
  ) {
    return 'core';
  }
  return step.track === 'baseline' || step.track === 'cleanup' ? 'harness' : 'harness';
}

function summarizeReport(report) {
  if (!report || typeof report !== 'object') {
    return null;
  }
  const status = report.status ?? null;
  const passes = report.passes ?? null;
  const scenarios = Array.isArray(report.scenarios)
    ? report.scenarios.map((scenario) => ({
      name: scenario.name ?? null,
      status: scenario.status ?? null,
      taskId: scenario.taskId ?? null
    }))
    : undefined;
  return {
    status,
    passes,
    providerId: report.providerId ?? report.humanCli?.providerSetup?.providerId ?? report.agentCli?.providerId ?? null,
    taskId: report.taskId ?? report.humanCli?.taskId ?? report.agentCli?.finalTask?.taskId ?? null,
    scenarios,
    screenshots: Array.isArray(report.screenshots) ? report.screenshots.slice(0, 8) : undefined,
    error: report.error ?? null,
    reason: report.reason ?? null
  };
}

async function writeReport(report) {
  report.updatedAt = new Date().toISOString();
  report.storage = {
    logsDir,
    logsBytes: await directorySize(logsDir),
    backendDataDir,
    backendDataBytes: await directorySize(backendDataDir)
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function runCommand(step) {
  const startedAt = new Date().toISOString();
  process.stdout.write(`[flagship-loop] ${step.label}\n`);
  const prepared = prepareSpawn(step);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      ...(step.env ?? {})
    }
  });
  const finishedAt = new Date().toISOString();
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return {
    label: step.label,
    track: step.track,
    command: prepared.displayCommand,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    exitCode,
    signal: result.signal ?? null,
    ok: exitCode === 0 && !result.error,
    stdoutTail: trimOutput(result.stdout),
    stderrTail: trimOutput(result.stderr),
    error: result.error ? String(result.error.stack ?? result.error.message ?? result.error) : null
  };
}

function cleanupSteps(phase) {
  return [
    {
      label: `${phase}: clean runtime state`,
      track: 'cleanup',
      command: npmCommand(),
      args: ['run', 'clean:runtime-state'],
      timeoutMs: 2 * 60 * 1000
    },
    {
      label: `${phase}: clean test artifacts`,
      track: 'cleanup',
      command: npmCommand(),
      args: ['run', 'clean:test-artifacts'],
      timeoutMs: 2 * 60 * 1000
    }
  ];
}

function baselineSteps() {
  return [
    {
      label: 'baseline: typecheck',
      track: 'baseline',
      command: npmCommand(),
      args: ['run', 'typecheck']
    },
    {
      label: 'baseline: frontend tests',
      track: 'baseline',
      command: npmCommand(),
      args: ['test', '-w', 'frontend']
    },
    {
      label: 'baseline: CLI interface contract',
      track: 'baseline',
      command: process.execPath,
      args: ['--test', '--test-isolation=none', '--test-concurrency=1', 'backend\\tests\\cli-interface.test.cjs']
    },
    {
      label: 'baseline: repo hygiene',
      track: 'baseline',
      command: npmCommand(),
      args: ['run', 'repo-hygiene']
    },
    {
      label: 'baseline: secret hygiene',
      track: 'baseline',
      command: npmCommand(),
      args: ['run', 'secret-hygiene']
    }
  ];
}

function liveSteps() {
  return [
    {
      label: 'web live: frontend live review',
      track: 'web',
      command: npmCommand(),
      args: ['run', 'review:frontend:live'],
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
      reportPath: path.resolve(logsDir, 'frontend-live-task-review.json')
    },
    ...cleanupSteps('after web live').map((step) => ({ ...step, track: 'cleanup' })),
    {
      label: 'human live: ordinary interaction',
      track: 'human-cli',
      command: npmCommand(),
      args: ['run', 'ordinary-interaction:live'],
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
      reportPath: path.resolve(logsDir, 'ordinary-interaction-live-check.json')
    },
    ...cleanupSteps('after human live').map((step) => ({ ...step, track: 'cleanup' })),
    {
      label: 'agent live: agent CLI',
      track: 'agent-cli',
      command: npmCommand(),
      args: ['run', 'agent-cli:live'],
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
      reportPath: path.resolve(logsDir, 'agent-cli-live-task-check.json')
    },
    ...cleanupSteps('after agent live').map((step) => ({ ...step, track: 'cleanup' }))
  ];
}

function uiRegressionSteps() {
  return [
    {
      label: 'ui regression: frontend smoke',
      track: 'web',
      command: npmCommand(),
      args: ['run', 'smoke:frontend'],
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
      reportPath: path.resolve(logsDir, 'frontend-smoke-report.json')
    },
    {
      label: 'ui regression: frontend mainline review',
      track: 'web',
      command: npmCommand(),
      args: ['run', 'review:frontend:mainline'],
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
      reportPath: path.resolve(logsDir, 'frontend-mainline-review.json')
    }
  ];
}

async function appendStepResult(report, round, step, result) {
  const childReport = step.reportPath ? await readJsonIfExists(step.reportPath) : null;
  const childSummary = summarizeReport(childReport);
  const outputText = `${result.stdoutTail}\n${result.stderrTail}`;
  const childOpenGap = childSummary && !['achieved', undefined, null].includes(childSummary.status);
  const childFailedPasses = childSummary && childSummary.passes === false;
  const failed = !result.ok || childOpenGap || childFailedPasses;
  const entry = {
    ...result,
    reportPath: step.reportPath ?? null,
    report: childSummary,
    failurePlane: failed ? classifyFailure(step, outputText, childReport) : null,
    issueSummary: failed
      ? `${step.label} did not achieve the required state.`
      : null
  };
  round.steps.push(entry);
  if (failed) {
    round.issues.push({
      plane: entry.failurePlane,
      track: step.track,
      label: step.label,
      command: entry.command,
      reportPath: entry.reportPath,
      summary: entry.issueSummary,
      suggestedAction: entry.failurePlane === 'external_blocker'
        ? 'Keep blocker evidence and rerun when the external dependency is available.'
        : 'Inspect the command output and child report, fix the actionable defect, then rerun this loop.'
    });
  }
  await writeReport(report);
  return !failed;
}

async function runRound(report, roundIndex, options) {
  const round = {
    roundId: createRoundId(roundIndex),
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
    issues: [],
    stopDecision: null
  };
  report.rounds.push(round);
  await writeReport(report);

  const steps = [
    ...cleanupSteps('round start'),
    ...baselineSteps(),
    ...liveSteps(),
    ...(options.includeUiRegression ? uiRegressionSteps() : []),
    ...cleanupSteps('round end')
  ];

  for (const step of steps) {
    const result = runCommand(step);
    await appendStepResult(report, round, step, result);
    if (!result.ok && !options.continueOnFailure) {
      round.status = 'open_gap';
      round.stopDecision = {
        achieved: false,
        reason: `${step.label} failed; stopping early because --continue-on-failure was not set.`
      };
      round.finishedAt = new Date().toISOString();
      await writeReport(report);
      return round;
    }
  }

  const actionableIssues = round.issues.filter((issue) => issue.plane !== 'external_blocker');
  const externalBlockers = round.issues.filter((issue) => issue.plane === 'external_blocker');
  round.status = actionableIssues.length === 0 && externalBlockers.length === 0
    ? 'achieved'
    : actionableIssues.length === 0
      ? 'external_blocker'
      : 'open_gap';
  round.stopDecision = {
    achieved: round.status === 'achieved',
    reason: round.status === 'achieved'
      ? 'All Web, Human CLI, Agent CLI, baseline, and cleanup checks achieved in this round.'
      : round.status === 'external_blocker'
        ? 'Only external blockers remain; preserve evidence and rerun when dependencies recover.'
        : 'Actionable defects remain and must be fixed before the loop can stop.',
    actionableIssueCount: actionableIssues.length,
    externalBlockerCount: externalBlockers.length
  };
  round.finishedAt = new Date().toISOString();
  await writeReport(report);
  return round;
}

async function main() {
  const options = {
    rounds: parseIntFlag('rounds', Number.parseInt(process.env.FLAGSHIP_LOOP_ROUNDS ?? '1', 10)),
    includeUiRegression: parseFlag('ui-regression') || process.env.FLAGSHIP_LOOP_UI_REGRESSION === '1',
    continueOnFailure: parseFlag('continue-on-failure') || process.env.FLAGSHIP_LOOP_CONTINUE_ON_FAILURE === '1'
  };
  const report = {
    generatedAt: new Date().toISOString(),
    updatedAt: null,
    status: 'running',
    reportPath,
    options,
    tracks: ['web', 'human-cli', 'agent-cli'],
    issuePlanes: ['core', 'ecosystem', 'harness', 'ui', 'provider', 'external_blocker'],
    rounds: [],
    storage: null
  };

  await writeReport(report);
  for (let index = 1; index <= options.rounds; index += 1) {
    const round = await runRound(report, index, options);
    if (round.status === 'achieved') {
      break;
    }
    if (round.status === 'open_gap') {
      break;
    }
  }

  const latestRound = report.rounds.at(-1);
  report.status = latestRound?.status ?? 'open_gap';
  report.stopDecision = latestRound?.stopDecision ?? {
    achieved: false,
    reason: 'No round executed.'
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    reportPath,
    stopDecision: report.stopDecision
  }, null, 2)}\n`);
  if (report.status === 'open_gap') {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    status: 'open_gap',
    reportPath,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
  console.error(fallback.error);
  process.exit(1);
});
