import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildXiaomiMimoFlashLiveEnv,
  readXiaomiMimoFlashProviderSource,
  resolveXiaomiMimoFlashDocPath,
  XIAOMI_MIMO_FLASH_PROVIDER_ID,
  XIAOMI_MIMO_FLASH_SECRET_ID,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';
import { resolveBackendRuntimeRoot } from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const backendPortStart = Number.parseInt(process.env.AGENT_CLI_LIVE_BACKEND_PORT ?? '3511', 10);
const backendCliPath = path.resolve(rootDir, 'backend', 'dist', 'bin', 'cli.js');
const reportPath =
  process.env.AGENT_CLI_LIVE_REPORT ??
  path.resolve(rootDir, '.codex-run', 'logs', 'agent-cli-live-task-check.json');
const backendDataRoot = resolveBackendRuntimeRoot(rootDir);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const executable = npmCommand();
    const quotedArgs = args.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(' ');
    return spawn('powershell.exe', ['-Command', `& '${executable.replace(/'/g, "''")}' ${quotedArgs}`], {
      cwd: rootDir,
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
    cwd: rootDir,
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
    await sleep(500);
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

async function runCli(args, env = {}) {
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
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`CLI command failed (${exitCode}): ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
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
        // Try the next earlier candidate.
      }
    }
    throw new Error(`Failed to parse JSON output for ${label}: ${error instanceof Error ? error.message : String(error)}\n${trimmed}`);
  }
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

function getTaskWorkspaceDir(taskId) {
  return path.join(backendDataRoot, 'workspace', taskId);
}

async function seedTaskWorkspace(taskId, relativePath, content) {
  const workspaceDir = getTaskWorkspaceDir(taskId);
  const targetPath = path.join(workspaceDir, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
  return {
    workspaceDir,
    targetPath
  };
}

function deriveContinueMessage(debugPayload, taskWorkspacePath) {
  const taskPayload = debugPayload?.task ?? null;
  const correctionKind =
    debugPayload?.task?.runtime?.contractDiagnostics?.lastPendingCorrectionKind
    ?? debugPayload?.executionSummary?.turnContract?.lastPendingCorrectionKind
    ?? null;
  const deterministicVerdict = debugPayload?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
  const trackerStatus = debugPayload?.executionSummary?.acceptance?.evidence?.progressTracker?.status ?? null;
  const primaryActionKind = taskPayload?.primaryAction?.kind ?? '';
  const nextActionLabel = taskPayload?.nextActionSummary?.label ?? '';
  const actionSignal = `${primaryActionKind} ${nextActionLabel}`.trim().toLowerCase();

  if (correctionKind === 'AWAITING_TRACKER') {
    return 'Return only one valid tracker JSON block for the current unit. Do not repeat explicit output, do not emit tool blocks, and do not add prose.';
  }
  if (correctionKind === 'AWAITING_TOOL_ACTION') {
    return [
      `Emit the required read_file tool action for ${taskWorkspacePath} inside the task workspace first.`,
      'After the tool succeeds, return one explicit output block and one tracker JSON block.',
      'Do not claim COMPLETE until the read_file invocation succeeds.'
    ].join(' ');
  }
  if (deterministicVerdict === 'passed' && trackerStatus && trackerStatus !== 'COMPLETE') {
    return [
      `The successful read_file result for ${taskWorkspacePath} is already available.`,
      'Use that grounded evidence to return the final concise operator-facing note now.',
      'Return one explicit output block and one tracker JSON block with status COMPLETE.',
      'Do not repeat the same tool call unless new evidence is genuinely missing.'
    ].join(' ');
  }
  if (actionSignal.includes('continue')) {
    return [
      'Continue from the current runtime state.',
      `If the file ${taskWorkspacePath} has already been inspected, ground the answer in that read result and finish the thread.`,
      'Otherwise take the next required step and then return one explicit output block plus one completion tracker.'
    ].join(' ');
  }
  return undefined;
}

async function main() {
  const liveModel = process.env.XIAOMI_MIMO_LIVE_MODEL?.trim() || XIAOMI_MIMO_STRONG_MODEL;
  await assertLiveCostGuard({
    rootDir,
    env: {
      ...process.env,
      XIAOMI_MIMO_LIVE_MODEL: liveModel,
    },
    label: 'agent-cli:live'
  });
  const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, { model: liveModel });
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir, { model: liveModel });
  const backendPort = await findAvailablePort(backendPortStart);
  const serverUrl = `http://127.0.0.1:${backendPort}`;
  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    ...liveEnv,
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
  const readBackendLogs = collectOutput(backend, 'backend');

  try {
    await waitForHttp(`${serverUrl}/health`, 120_000);

    const baseArgs = ['--server', serverUrl];

    const secretResult = await runCli([
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
    const providerTestPayload = parseJsonOutput(providerTestResult.stdout, 'platform providers test');

    const title = `Agent CLI Live Submit ${Date.now()}`;
    const taskWorkspacePath = 'briefing/live-provider-brief.md';
    const seededContent = [
      '# Live Provider Brief',
      '',
      '- Provider: Xiaomi Mimo Flash',
      '- Mode: real API key validation',
      '- Constraint: built-in file tools operate inside the task workspace.'
    ].join('\n');
    const intent = [
      `Use the read_file tool to inspect ${taskWorkspacePath} inside the task workspace and then return a concise operator-facing note.`,
      'Do not invent facts that are not present in the file.',
      'Mention one explicit constraint from the file contents.',
    ].join(' ');
    const taskFilePath = path.resolve(rootDir, '.codex-run', 'tmp', `agent-cli-live-task-${Date.now()}.json`);
    const taskDefinition = {
      title,
      intent,
      preferredProviderId: XIAOMI_MIMO_FLASH_PROVIDER_ID,
      metadata: {
        source: 'agent-cli-live-task-check',
      },
      units: [
        {
          id: 'AGENT-001',
          role: 'OperatorReviewer',
          goal: `Inspect ${taskWorkspacePath} inside the task workspace with a real tool call and report one grounded constraint.`,
          outputContract: '{"summary":"string","details":"string"}',
          dependencies: [],
          executionProfileId: 'verify',
        },
      ],
    };
    await fs.mkdir(path.dirname(taskFilePath), { recursive: true });
    await fs.writeFile(taskFilePath, JSON.stringify(taskDefinition, null, 2), 'utf8');
    const submitResult = await runCli([
      ...baseArgs,
      'tasks',
      'submit',
      taskFilePath,
    ]);
    const submitPayload = parseJsonOutput(submitResult.stdout, 'tasks submit');
    const taskId = submitPayload?.command?.taskId ?? submitPayload?.task?.definition?.taskId ?? null;
    if (!taskId) {
      throw new Error(`tasks submit did not return a taskId.\n${submitResult.stdout}`);
    }
    const seededWorkspace = await seedTaskWorkspace(taskId, taskWorkspacePath, seededContent);

    const startResult = await runCli([...baseArgs, 'tasks', 'start', taskId]);
    const startPayload = parseJsonOutput(startResult.stdout, 'tasks start');

    let statusPayload = null;
    let latestDebugPayload = null;
    const continueAttempts = [];
    let generalContinueBudget = 2;
    let finalizationContinueBudget = 2;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 300_000) {
      const statusResult = await runCli([...baseArgs, 'tasks', 'status', taskId]);
      statusPayload = parseJsonOutput(statusResult.stdout, 'tasks status');
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(statusPayload.lifecycleStatus)) {
        break;
      }
      const debugResult = await runCli([...baseArgs, 'tasks', 'debug', taskId]);
      latestDebugPayload = parseJsonOutput(debugResult.stdout, 'tasks debug');
      const deterministicAccepted =
        latestDebugPayload?.executionSummary?.acceptance?.deterministic?.verdict === 'passed';
      const trackerStatus =
        latestDebugPayload?.executionSummary?.acceptance?.evidence?.progressTracker?.status ?? null;
      const taskPayload = latestDebugPayload?.task ?? null;
      const primaryActionKind = taskPayload?.primaryAction?.kind ?? '';
      const nextActionLabel = taskPayload?.nextActionSummary?.label ?? '';
      const actionSignal = `${primaryActionKind} ${nextActionLabel}`.trim().toLowerCase();
      const shouldSendGeneralContinue = actionSignal.includes('continue') && !deterministicAccepted && generalContinueBudget > 0;
      const shouldSendFinalizationContinue = actionSignal.includes('continue') && deterministicAccepted && trackerStatus !== 'COMPLETE' && finalizationContinueBudget > 0;
      const continueMessage = (shouldSendGeneralContinue || shouldSendFinalizationContinue)
        ? deriveContinueMessage(latestDebugPayload, taskWorkspacePath)
        : undefined;
      if (continueMessage) {
        const continueResult = await runCli([
          ...baseArgs,
          'tasks',
          'continue',
          taskId,
          '--message',
          continueMessage,
        ]);
        continueAttempts.push({
          attempt: continueAttempts.length + 1,
          message: continueMessage,
          payload: parseJsonOutput(continueResult.stdout, 'tasks continue'),
        });
        if (shouldSendFinalizationContinue) {
          finalizationContinueBudget -= 1;
        } else if (shouldSendGeneralContinue) {
          generalContinueBudget -= 1;
        }
        await sleep(2_000);
        continue;
      }
      await sleep(2_000);
    }

    if (!statusPayload) {
      throw new Error(`Failed to retrieve tasks status for ${taskId}.`);
    }

    const finalDebugResult = await runCli([...baseArgs, 'tasks', 'debug', taskId]);
    const debugPayload = parseJsonOutput(finalDebugResult.stdout, 'tasks debug');
    const diagnosticsResult = await runCli([...baseArgs, 'tasks', 'diagnostics', taskId]);

    const acceptance = debugPayload?.executionSummary?.acceptance ?? null;
    const toolActivities = Array.isArray(debugPayload?.task?.visibleToolActivities)
      ? debugPayload.task.visibleToolActivities
      : Array.isArray(debugPayload?.visibleToolActivities)
        ? debugPayload.visibleToolActivities
        : [];
    const deterministicVerdict = acceptance?.deterministic?.verdict ?? null;
    const semanticReviewStatus = acceptance?.semanticReview?.status ?? null;

    const issues = [];
    const advisories = [];
    if (statusPayload.lifecycleStatus !== 'COMPLETED') {
      issues.push(`Task did not reach COMPLETED. lifecycleStatus=${statusPayload.lifecycleStatus}`);
    }
    if (deterministicVerdict && deterministicVerdict !== 'passed') {
      issues.push(`Deterministic acceptance did not pass. verdict=${deterministicVerdict}`);
    }
    if (
      deterministicVerdict === 'passed'
      && semanticReviewStatus
      && semanticReviewStatus !== 'passed'
      && semanticReviewStatus !== 'not_requested'
      && semanticReviewStatus !== 'unavailable'
    ) {
      issues.push(`Semantic review did not pass. status=${semanticReviewStatus}`);
    } else if (
      deterministicVerdict === 'passed'
      && (semanticReviewStatus === 'unavailable' || semanticReviewStatus === 'not_requested')
    ) {
      advisories.push(`Semantic review remained advisory-only. status=${semanticReviewStatus}`);
    }
    if (toolActivities.length === 0) {
      issues.push('Task completed without any visible tool activity even though the intent explicitly required read_file.');
    }

    const report = {
      generatedAt: new Date().toISOString(),
      serverUrl,
      provider: {
        id: providerSource.providerId,
        model: providerSource.model,
        baseUrl: providerSource.baseUrl,
        sourceFile: providerSource.docPath,
      },
      task: {
        taskId,
        taskFilePath,
        seededWorkspace,
        continueAttempts,
        title,
        intent,
        submitPayload,
        startPayload,
        finalStatus: statusPayload,
        acceptance,
        visibleToolActivities: toolActivities,
        visibleToolActivityCount: toolActivities.length,
      },
      commands: {
        secretSet: secretResult.stdout.trim(),
        providerTest: providerTestResult.stdout.trim(),
        diagnostics: diagnosticsResult.stdout.trim(),
      },
      advisories,
      issues,
    };

    if (providerTestPayload?.capability?.supportsTools === false) {
      report.issues.push('Provider capability view reports supportsTools=false, so tool-required tasks may degrade or silently skip tool use.');
    }

    await writeReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (issues.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const backendLogs = readBackendLogs();
    const report = {
      generatedAt: new Date().toISOString(),
      serverUrl: `http://127.0.0.1:${backendPort}`,
      providerId: XIAOMI_MIMO_FLASH_PROVIDER_ID,
      status: 'open_gap',
      error: error instanceof Error ? error.message : String(error),
      backendLogs,
    };
    await writeReport(report);
    throw error;
  } finally {
    await terminateChild(backend, 'backend');
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
