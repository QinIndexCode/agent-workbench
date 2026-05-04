import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import {
  buildXiaomiMimoFlashLiveEnv,
  readXiaomiMimoFlashProviderSource,
  resolveXiaomiMimoFlashDocPath,
  XIAOMI_MIMO_FLASH_PROVIDER_ID,
  XIAOMI_MIMO_FLASH_SECRET_ID,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';
import { createIsolatedBackendRuntimeRoot } from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const backendCliPath = path.resolve(rootDir, 'backend', 'dist', 'bin', 'cli.js');
const reportPath = path.resolve(rootDir, '.codex-run', 'logs', 'ordinary-interaction-live-check.json');
const screenshotDir = path.resolve(rootDir, '.codex-run', 'logs', 'ordinary-interaction-live');
const preferredBackendPort = Number.parseInt(process.env.ORDINARY_INTERACTION_BACKEND_PORT ?? '3611', 10);
const preferredFrontendPort = Number.parseInt(process.env.ORDINARY_INTERACTION_FRONTEND_PORT ?? '5773', 10);
const RUN_FAMILY_TAG = process.env.ORDINARY_INTERACTION_RUN_TAG ?? `aaordinaryrun${Date.now().toString(36)}`;
const configuredBackendRootDir = process.env.ORDINARY_INTERACTION_BACKEND_ROOT_DIR?.trim() ?? '';
const backendRootDir = configuredBackendRootDir
  ? (path.isAbsolute(configuredBackendRootDir) ? configuredBackendRootDir : path.resolve(rootDir, configuredBackendRootDir))
  : createIsolatedBackendRuntimeRoot(rootDir, 'ordinary-interaction-live');
const ownsBackendRootDir = !configuredBackendRootDir;

const COMMON_GOAL = `Create a reusable markdown release checklist artifact for repeated operator use. Pattern family ${RUN_FAMILY_TAG}.`;
const COMMON_OUTPUT_CONTRACT = '{"summary":"string","artifact":"string","details":"string","issues":[]}';
const WEB_UNITS = [
  {
    id: 'AGENT-001',
    role: 'Generalist',
    goal: COMMON_GOAL,
    outputContract: COMMON_OUTPUT_CONTRACT,
    executionProfileId: 'implement',
    dependencies: [],
  },
];

const PROMPTS = {
  human: {
    title: '发布检查清单 1',
    intent: '请整理一份可复用的发布前检查清单，保存成 markdown 文件，方便团队后续反复沿用。',
    start: '请开始处理，先实际创建 markdown 文件，再给我结果。',
  },
  agent: {
    title: '发布检查清单 2',
    intent: '请再整理一份同类的发布前检查清单，也保存成 markdown 文件，保持可复用写法。',
    start: '请开始处理，先实际创建 markdown 文件，再反馈结果。',
  },
  web: {
    title: '发布检查清单 3',
    intent: '请继续整理一份同类发布前检查清单，保存成 markdown 文件，延续前面的可复用写法。',
    start: '请开始处理，先实际创建 markdown 文件，再告诉我结果。',
    followUp: '同一线程里再补一条上线前验证提醒，保持同样风格并继续落到 markdown 文件里。',
  },
  reuse: {
    title: '发布检查清单 4',
    intent: '请再补一份同类发布前检查清单，保存成 markdown 文件，继续沿用前面的可复用方式。',
    start: '请继续按之前的可复用方式处理，先创建 markdown 文件再汇报。',
  },
};

PROMPTS.human = {
  title: 'Release checklist draft',
  intent: 'Please draft a reusable release checklist and save it as a markdown file so the team can reuse it later.',
  start: 'Please create the markdown file in the task workspace first, then summarize the result.',
};
PROMPTS.agent = {
  title: 'Release checklist refresh',
  intent: 'Please prepare another reusable release checklist in markdown, keeping the same practical style.',
  start: 'Create the markdown file in the task workspace before you report back.',
};
PROMPTS.web = {
  title: 'Release checklist handoff',
  intent: 'Please continue the same release checklist work and save the result as a markdown file in the workspace.',
  start: 'Start by writing the markdown file, then tell me what you created.',
  followUp: 'In the same thread, add a short pre-launch reminder section to that markdown file and keep the tone consistent.',
};
PROMPTS.reuse = {
  title: 'Release checklist follow-up',
  intent: 'Please make one more reusable release checklist in markdown and continue the same working approach as before.',
  start: 'Please continue with the same reusable approach and create the markdown file before summarizing it.',
};

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function runCli(args, options = {}) {
  const child = spawn(process.execPath, [backendCliPath, ...args], {
    cwd: path.resolve(rootDir, 'backend'),
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ...(options.env ?? {}),
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
  if (Array.isArray(options.stdinLines) && options.stdinLines.length > 0) {
    child.stdin?.write(`${options.stdinLines.join('\n')}\n`);
  }
  child.stdin?.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`CLI command failed (${exitCode}): ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
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

function parseNdjson(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractTaskIdFromHumanChat(stdout) {
  const matches = [...stdout.matchAll(/\btask_\d+_[a-f0-9]+\b/g)];
  return matches.length > 0 ? matches[matches.length - 1][0] : null;
}

function extractTaskIdFromNdjson(stdout) {
  const entries = parseNdjson(stdout);
  for (const entry of entries) {
    if (entry?.type === 'session' && typeof entry.taskId === 'string') {
      return entry.taskId;
    }
    if (entry?.type === 'task' && entry.task && typeof entry.task.taskId === 'string') {
      return entry.task.taskId;
    }
  }
  return null;
}

async function writeMetadataFile(name, metadata) {
  await fs.mkdir(screenshotDir, { recursive: true });
  const target = path.join(screenshotDir, `${RUN_FAMILY_TAG}-${name}.metadata.json`);
  await fs.writeFile(target, JSON.stringify(metadata, null, 2), 'utf8');
  return target;
}

function createInteractiveCliArgs(serverUrl, prompt, metadataFile = null) {
  const args = [
    'chat',
    '--server',
    serverUrl,
    '--provider',
    XIAOMI_MIMO_FLASH_PROVIDER_ID,
    '--title',
    prompt.title,
    '--intent',
    prompt.intent,
    '--role',
    'Generalist',
    '--goal',
    COMMON_GOAL,
    '--execution-profile',
    'implement',
    '--output-contract',
    COMMON_OUTPUT_CONTRACT,
    '--path-policy',
    'task_workspace',
  ];
  if (metadataFile) {
    args.push('--metadata-file', metadataFile);
  }
  return args;
}

async function fetchTask(serverUrl, taskId) {
  return requestJson(`${serverUrl}/tasks/${taskId}`);
}

async function fetchTaskDebug(serverUrl, taskId) {
  return requestJson(`${serverUrl}/tasks/${taskId}/debug`);
}

async function listProposals(serverUrl) {
  return requestJson(`${serverUrl}/improvements/proposals`);
}

async function approveProposal(serverUrl, proposalId) {
  return requestJson(`${serverUrl}/improvements/proposals/${proposalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

function getPendingApprovalInvocationIds(task) {
  const items = Array.isArray(task?.pendingApprovalItems) ? task.pendingApprovalItems : [];
  if (items.length > 0) {
    return items
      .map((entry) => entry?.invocationId)
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }
  const approvals = Array.isArray(task?.pendingApprovals) ? task.pendingApprovals : [];
  return approvals
    .map((entry) => entry?.invocationId)
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function deriveFollowupMessage(debug) {
  const correctionKind =
    debug?.task?.runtime?.contractDiagnostics?.lastPendingCorrectionKind
    ?? debug?.executionSummary?.turnContract?.lastPendingCorrectionKind
    ?? null;
  const failureCategory =
    debug?.task?.runtime?.contractDiagnostics?.lastAcceptanceFailureCategory
    ?? debug?.executionSummary?.turnContract?.lastAcceptanceFailureCategory
    ?? null;
  const artifactEvidenceSatisfied =
    debug?.acceptance?.evidence?.artifactEvidence?.satisfied === true
    || debug?.executionSummary?.acceptance?.evidence?.artifactEvidence?.satisfied === true;
  const toolIds = Array.isArray(debug?.executionSummary?.acceptance?.evidence?.toolEvidence?.toolIds)
    ? debug.executionSummary.acceptance.evidence.toolEvidence.toolIds
    : [];
  const onlyPassiveReadEvidence = toolIds.length > 0
    && toolIds.every((toolId) => ['list_files', 'read_file', 'search_files'].includes(toolId));
  if (
    failureCategory === 'artifact_write_required_but_not_emitted'
    || !artifactEvidenceSatisfied
    || onlyPassiveReadEvidence
  ) {
    return 'Write the markdown file itself with a real write action first, then return exactly one corrected explicit output block and one tracker JSON block. Do not just inspect the workspace or read a file.';
  }
  if (correctionKind === 'AWAITING_TOOL_ACTION') {
    return 'Create the markdown file with a real tool action first, then report the result. Do not stop at a verbal summary.';
  }
  if (correctionKind === 'AWAITING_OUTPUT_CORRECTION') {
    if (
      failureCategory === 'response_shape_mismatch'
      || failureCategory === 'tracker_missing_after_valid_output'
      || artifactEvidenceSatisfied
    ) {
      return 'Return exactly one corrected explicit output block and one tracker JSON block now. Do not emit new tool calls, and do not rewrite the file again unless the runtime explicitly says tool evidence is still missing.';
    }
    if (!artifactEvidenceSatisfied) {
      return 'Return the structured result only after the markdown file has actually been written. If it is not written yet, create it with a real write action first.';
    }
    return 'Use the file you already created and return the final structured result now. Do not repeat the same tool action unless new evidence is still missing.';
  }
  if (correctionKind === 'AWAITING_TRACKER') {
    return 'Return only one valid tracker JSON block for the current unit. Do not repeat explicit output, do not emit tool blocks, and do not add prose.';
  }
  return 'Use the result you already created and finish the current thread now. Return the final structured result and completion tracker only. Do not start a new revision or rerun tools unless evidence is still genuinely missing.';
}

function shouldSendFollowup(task) {
  if (!task || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.runtime?.lifecycleStatus)) {
    return false;
  }
  if (task.runtime?.pendingCorrection && task.runtime.pendingCorrection !== 'NONE') {
    return true;
  }
  if (Array.isArray(task.runtime?.pendingOperatorInputs) && task.runtime.pendingOperatorInputs.length > 0) {
    return true;
  }
  const primaryActionKind = task.nextActionSummary?.label ?? task.primaryAction?.kind ?? '';
  const normalized = String(primaryActionKind).trim().toLowerCase();
  return normalized.includes('continue');
}

function needsDirectedFollowup(task) {
  if (!task || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.runtime?.lifecycleStatus)) {
    return false;
  }
  if (task.runtime?.pendingCorrection && task.runtime.pendingCorrection !== 'NONE') {
    return true;
  }
  return Array.isArray(task.runtime?.pendingOperatorInputs) && task.runtime.pendingOperatorInputs.length > 0;
}

function isDeterministicAccepted(debug) {
  return debug?.executionSummary?.acceptance?.deterministic?.verdict === 'passed';
}

function getThreadMessageCount(task) {
  const conversationCount = Array.isArray(task?.conversations) ? task.conversations.length : 0;
  const operatorMessageCount = Array.isArray(task?.operatorMessages) ? task.operatorMessages.length : 0;
  return conversationCount + operatorMessageCount;
}

function getTrackerStatus(debug) {
  const status = debug?.executionSummary?.acceptance?.evidence?.progressTracker?.status;
  return typeof status === 'string' ? status : null;
}

function isExplicitGuidanceRequiredError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /continue task requires explicit operator guidance/i.test(message)
    || /non-convergent correction loop/i.test(message);
}

async function invokeContinueAction(params, debug) {
  const artifactEvidenceSatisfied =
    debug?.acceptance?.evidence?.artifactEvidence?.satisfied === true
    || debug?.executionSummary?.acceptance?.evidence?.artifactEvidence?.satisfied === true;
  const trackerStatus = getTrackerStatus(debug);
  if (!artifactEvidenceSatisfied || trackerStatus === null) {
    return params.followup(deriveFollowupMessage(debug));
  }
  if (typeof params.continueAction === 'function') {
    try {
      return await params.continueAction();
    } catch (error) {
      if (!isExplicitGuidanceRequiredError(error)) {
        throw error;
      }
    }
  }
  return params.followup(deriveFollowupMessage(debug));
}

async function waitForTaskSettle(params) {
  const followups = [];
  const approvals = [];
  const maxFollowups = params.maxFollowups ?? 10;
  let generalContinueBudget = params.generalContinueBudget ?? 0;
  let postApprovalContinueBudget = params.postApprovalContinueBudget ?? 0;
  let finalizationContinueBudget = params.finalizationContinueBudget ?? 0;
  let lastApprovalAt = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 300_000)) {
    // eslint-disable-next-line no-await-in-loop
    const task = await fetchTask(params.serverUrl, params.taskId);
    // eslint-disable-next-line no-await-in-loop
    const debug = await fetchTaskDebug(params.serverUrl, params.taskId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.runtime.lifecycleStatus)) {
      return { task, debug, followups, approvals };
    }
    const pendingApprovalIds = getPendingApprovalInvocationIds(task);
    if (pendingApprovalIds.length > 0 && typeof params.resolveApprovals === 'function') {
      // eslint-disable-next-line no-await-in-loop
      await params.resolveApprovals(task, debug, pendingApprovalIds);
      approvals.push(...pendingApprovalIds);
      postApprovalContinueBudget = Math.max(postApprovalContinueBudget, params.postApprovalContinueBudgetAfterApproval ?? 1);
      lastApprovalAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000);
      continue;
    }
    const requiresDirectedFollowup = needsDirectedFollowup(task);
    const deterministicAccepted = isDeterministicAccepted(debug);
    const trackerStatus = getTrackerStatus(debug);
    const approvalGraceElapsed = lastApprovalAt === 0
      || (Date.now() - lastApprovalAt) >= (params.approvalGraceMs ?? 8_000);
    const canSpendPostApprovalContinue = approvalGraceElapsed
      && postApprovalContinueBudget > 0
      && shouldSendFollowup(task)
      && !deterministicAccepted;
    const canSpendGeneralContinue = generalContinueBudget > 0
      && shouldSendFollowup(task)
      && !requiresDirectedFollowup
      && !deterministicAccepted;
    const canSpendFinalizationContinue = finalizationContinueBudget > 0
      && shouldSendFollowup(task)
      && !requiresDirectedFollowup
      && deterministicAccepted;
    if (requiresDirectedFollowup && followups.length < maxFollowups) {
      const message = deriveFollowupMessage(debug);
      // eslint-disable-next-line no-await-in-loop
      const followupSent = await params.followup(message);
      if (followupSent !== false) {
        followups.push(message);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000);
      continue;
    }
    if (canSpendGeneralContinue) {
      // eslint-disable-next-line no-await-in-loop
      const continueSent = await invokeContinueAction(params, debug);
      if (continueSent !== false) {
        followups.push('[general-continue]');
        generalContinueBudget -= 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000);
      continue;
    }
    if (canSpendFinalizationContinue) {
      const message = deriveFollowupMessage(debug);
      // eslint-disable-next-line no-await-in-loop
      const continueSent = await params.followup(message);
      if (continueSent !== false) {
        followups.push(message);
        finalizationContinueBudget -= 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000);
      continue;
    }
    if (canSpendPostApprovalContinue) {
      // eslint-disable-next-line no-await-in-loop
      const continueSent = await invokeContinueAction(params, debug);
      if (continueSent !== false) {
        followups.push('[continue-action]');
        postApprovalContinueBudget -= 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(2_000);
  }
  const task = await fetchTask(params.serverUrl, params.taskId);
  const debug = await fetchTaskDebug(params.serverUrl, params.taskId);
  return { task, debug, followups, approvals };
}

async function runHumanChatCreate(serverUrl, prompt, metadataFile = null) {
  const result = await runCli([
    ...createInteractiveCliArgs(serverUrl, prompt, metadataFile),
    '--format',
    'human',
  ], {
    stdinLines: [prompt.start, '/exit'],
  });
  const taskId = extractTaskIdFromHumanChat(result.stdout);
  assertCondition(taskId, `Human chat did not emit a taskId.\n${result.stdout}`);
  return { taskId, output: result.stdout };
}

async function runHumanChatFollowup(serverUrl, taskId, message) {
  return runCli([
    '--server',
    serverUrl,
    'chat',
    '--format',
    'human',
    '--task',
    taskId,
  ], {
    stdinLines: [message, '/exit'],
  });
}

async function runAgentChatCreate(serverUrl, prompt, metadataFile = null) {
  const result = await runCli([
    ...createInteractiveCliArgs(serverUrl, prompt, metadataFile),
    '--format',
    'ndjson',
  ], {
    stdinLines: [prompt.start, '/exit'],
  });
  const taskId = extractTaskIdFromNdjson(result.stdout);
  assertCondition(taskId, `Agent chat did not emit a taskId.\n${result.stdout}`);
  return { taskId, output: result.stdout };
}

async function runAgentChatFollowup(serverUrl, taskId, message) {
  return runCli([
    '--server',
    serverUrl,
    'chat',
    '--format',
    'ndjson',
    '--task',
    taskId,
  ], {
    stdinLines: [message, '/exit'],
  });
}

async function captureScreenshot(page, name) {
  await fs.mkdir(screenshotDir, { recursive: true });
  const target = path.join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

async function ensureTaskPageReady(page, frontendBaseUrl, taskId) {
  await page.goto(`${frontendBaseUrl}/tasks?task=${encodeURIComponent(taskId)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="tasks-page"]', { timeout: 30_000 });
}

async function ensureInspectorVisible(page) {
  const panel = page.locator('[data-testid="task-experience-panel"]');
  if (await panel.count() > 0 && await panel.first().isVisible()) {
    return;
  }
  const advancedDetails = page.locator('[data-testid="task-advanced-summary"]').first();
  if (!(await advancedDetails.count() > 0 && await advancedDetails.isVisible())) {
    const toggle = page.locator('[data-testid="task-context-toggle"]').first();
    if (await toggle.count() > 0 && await toggle.isVisible()) {
      const expanded = await toggle.getAttribute('aria-expanded');
      if (expanded !== 'true') {
        await toggle.click();
      }
    }
    await advancedDetails.waitFor({ state: 'visible', timeout: 30_000 });
  }
  const isAdvancedOpen = await advancedDetails.evaluate((node) => (
    node instanceof HTMLDetailsElement ? node.open : false
  ));
  if (!isAdvancedOpen) {
    await page.locator('[data-testid="task-advanced-summary"] > summary').first().click();
  }
  const acceptanceTab = page.locator('[data-testid="task-tab-acceptance"]').first();
  await acceptanceTab.waitFor({ state: 'visible', timeout: 30_000 });
  await acceptanceTab.click();
  await panel.first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function submitWebTask(page, frontendBaseUrl, prompt) {
  await ensureTaskPageReady(page, frontendBaseUrl, 'none');
  await page.click('[data-testid="task-create-thread-inline"]');
  await page.waitForSelector('[data-testid="task-composer-dialog"]', { timeout: 30_000 });
  await page.fill('[data-testid="task-composer-title"]', prompt.title);
  await page.fill('[data-testid="task-composer-provider"]', XIAOMI_MIMO_FLASH_PROVIDER_ID);
  await page.fill('[data-testid="task-composer-intent"]', prompt.intent);
  const unitsField = page.locator('[data-testid="task-composer-units"]');
  if (!(await unitsField.isVisible())) {
    await page.locator('summary').filter({ hasText: /advanced(?: task)? contract/i }).first().click();
    await unitsField.waitFor({ state: 'visible', timeout: 30_000 });
  }
  await unitsField.fill(JSON.stringify(WEB_UNITS, null, 2));
  const [response] = await Promise.all([
    page.waitForResponse((entry) => entry.url().endsWith('/tasks') && entry.request().method() === 'POST', { timeout: 30_000 }),
    page.click('[data-testid="task-composer-submit"]'),
  ]);
  const payload = await response.json();
  const taskId = payload?.command?.taskId ?? null;
  assertCondition(taskId, 'Web composer did not return a taskId.');
  await page.waitForURL((url) => url.pathname === '/tasks' && url.searchParams.get('task') === taskId, { timeout: 30_000 });
  await page.locator('[data-testid="task-composer-card"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  return taskId;
}

async function sendWebFollowup(page, frontendBaseUrl, taskId, message) {
  await ensureTaskPageReady(page, frontendBaseUrl, taskId);
  const composerCard = page.locator('[data-testid="task-composer-card"]').first();
  await composerCard.waitFor({ state: 'visible', timeout: 30_000 });
  const expand = composerCard.locator('[data-testid="task-action-expand-follow-up"], [data-testid="task-compact-action-open-follow-up"]');
  if (await composerCard.locator('[data-testid="task-continue-message"]').count() === 0 && await expand.count() > 0) {
    await expand.first().click();
  }
  const continueMessage = composerCard.locator('[data-testid="task-continue-message"]').first();
  if (await continueMessage.count() > 0 && await continueMessage.isVisible()) {
    await continueMessage.fill(message);
  }
  const actionButtons = [
    { testId: 'task-action-start', endpoint: 'start' },
    { testId: 'task-action-resume', endpoint: 'resume' },
    { testId: 'task-action-continue', endpoint: 'continue' },
  ];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (const action of actionButtons) {
      const candidate = composerCard.locator(`[data-testid="${action.testId}"]`).first();
      if (await candidate.count() === 0) {
        continue;
      }
      if (await candidate.isVisible() && await candidate.isEnabled()) {
        await candidate.click();
        await page.waitForTimeout(500);
        return action.endpoint;
      }
    }
    const waitAction = composerCard.locator('[data-testid="task-action-wait"]').first();
    if (await waitAction.count() > 0 && await waitAction.isVisible()) {
      await page.waitForTimeout(1_000);
      continue;
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

async function approvePendingTaskViaCli(serverUrl, taskId, runFollowup, invocationIds) {
  for (const invocationId of invocationIds) {
    // eslint-disable-next-line no-await-in-loop
    await runFollowup(serverUrl, taskId, `/approve ${invocationId}`);
  }
}

async function approvePendingTaskViaWeb(page, frontendBaseUrl, taskId, invocationIds) {
  for (const _invocationId of invocationIds) {
    // eslint-disable-next-line no-await-in-loop
    await ensureTaskPageReady(page, frontendBaseUrl, taskId);
    const bannerApprove = page.locator('[data-testid="task-banner-approve"]');
    if (await bannerApprove.count() > 0 && await bannerApprove.first().isVisible()) {
      // eslint-disable-next-line no-await-in-loop
      await bannerApprove.first().click();
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(400);
      continue;
    }
    const approvalsTab = page.locator('[data-testid="task-tab-approvals"]');
    if (await approvalsTab.count() > 0 && await approvalsTab.first().isVisible()) {
      // eslint-disable-next-line no-await-in-loop
      await approvalsTab.first().click();
    }
    const inspectorApprove = page.locator('[data-testid="task-approval-approve"]').first();
    // eslint-disable-next-line no-await-in-loop
    await inspectorApprove.waitFor({ state: 'visible', timeout: 30_000 });
    // eslint-disable-next-line no-await-in-loop
    await inspectorApprove.click();
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(400);
  }
}

async function readTaskDiagnostics(serverUrl, taskId) {
  const result = await runCli([
    '--server',
    serverUrl,
    'tasks',
    'diagnostics',
    taskId,
  ]);
  return {
    raw: result.stdout,
    json: parseJsonOutput(result.stdout, `tasks diagnostics ${taskId}`),
  };
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

function summarizeTaskSurface(task, debug) {
  return {
    taskId: task.definition.taskId,
    lifecycleStatus: task.runtime.lifecycleStatus,
    currentUnitId: task.runtime.currentUnitId,
    nextAction: task.nextActionSummary,
    visibleToolActivities: task.visibleToolActivities.map((entry) => ({
      toolId: entry.toolId,
      status: entry.status,
      summary: entry.summary,
    })),
    acceptance: debug.executionSummary.acceptance,
    experienceSummary: debug.executionSummary.experienceSummary,
  };
}

function isTerminalCompleted(task, debug) {
  return ['COMPLETED'].includes(task?.runtime?.lifecycleStatus)
    && debug?.executionSummary?.acceptance?.deterministic?.verdict === 'passed';
}

async function main() {
  const liveModel = process.env.XIAOMI_MIMO_LIVE_MODEL?.trim() || XIAOMI_MIMO_STRONG_MODEL;
  await assertLiveCostGuard({
    rootDir,
    env: {
      ...process.env,
      XIAOMI_MIMO_LIVE_MODEL: liveModel,
    },
    label: 'ordinary-interaction:live'
  });
  const providerSource = await readXiaomiMimoFlashProviderSource(rootDir, { model: liveModel });
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir, { model: liveModel });
  const backendPort = await findAvailablePort(preferredBackendPort);
  const frontendPort = await findAvailablePort(preferredFrontendPort);
  const serverUrl = `http://127.0.0.1:${backendPort}`;
  const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
  if (ownsBackendRootDir) {
    fsSync.rmSync(backendRootDir, { recursive: true, force: true });
  }
  fsSync.mkdirSync(backendRootDir, { recursive: true });

  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    ...liveEnv,
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    BACKEND_NEW_ROOT_DIR: backendRootDir,
    BACKEND_NEW_WORKSPACE_CWD: rootDir,
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
  const issues = [];
  const runStartedAt = Date.now();

  try {
    await waitForHttp(`${serverUrl}/health`, 120_000);
    await waitForHttp(frontendBaseUrl, 120_000);

    await runCli([
      '--server',
      serverUrl,
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
    const providerTest = await runCli([
      '--server',
      serverUrl,
      'platform',
      'providers',
      'test',
      XIAOMI_MIMO_FLASH_PROVIDER_ID,
    ]);
    const providerTestPayload = parseJsonOutput(providerTest.stdout, 'platform providers test');

    const phaseOneMetadataFile = await writeMetadataFile('phase-one', {
      experienceReferences: [`phase-one-isolation-${RUN_FAMILY_TAG}`],
    });
    const humanCreate = await runHumanChatCreate(serverUrl, PROMPTS.human, phaseOneMetadataFile);
    const humanSettled = await waitForTaskSettle({
      serverUrl,
      taskId: humanCreate.taskId,
      followup: async (message) => { await runHumanChatFollowup(serverUrl, humanCreate.taskId, message); },
      continueAction: async () => { await runHumanChatFollowup(serverUrl, humanCreate.taskId, '/continue'); },
      resolveApprovals: async (_task, _debug, invocationIds) => {
        await approvePendingTaskViaCli(serverUrl, humanCreate.taskId, runHumanChatFollowup, invocationIds);
      },
      generalContinueBudget: 4,
      finalizationContinueBudget: 2,
      maxFollowups: 10,
    });
    if (!isTerminalCompleted(humanSettled.task, humanSettled.debug)) {
      issues.push(`Human ordinary-interaction phase-one task did not reach terminal completed state (${humanSettled.task.runtime.lifecycleStatus}).`);
    }

    const agentCreate = await runAgentChatCreate(serverUrl, PROMPTS.agent, phaseOneMetadataFile);
    const agentSettled = await waitForTaskSettle({
      serverUrl,
      taskId: agentCreate.taskId,
      followup: async (message) => { await runAgentChatFollowup(serverUrl, agentCreate.taskId, message); },
      continueAction: async () => { await runAgentChatFollowup(serverUrl, agentCreate.taskId, '/continue'); },
      resolveApprovals: async (_task, _debug, invocationIds) => {
        await approvePendingTaskViaCli(serverUrl, agentCreate.taskId, runAgentChatFollowup, invocationIds);
      },
      generalContinueBudget: 4,
      finalizationContinueBudget: 2,
      maxFollowups: 10,
    });
    if (!isTerminalCompleted(agentSettled.task, agentSettled.debug)) {
      issues.push(`Agent ordinary-interaction phase-one task did not reach terminal completed state (${agentSettled.task.runtime.lifecycleStatus}).`);
    }

    const proposalsAfterPhaseOne = await listProposals(serverUrl);
    const phaseOneTaskIds = new Set([humanCreate.taskId, agentCreate.taskId]);
    const experienceProposal = proposalsAfterPhaseOne
      .filter((proposal) => (
        proposal.kind === 'experience'
        && phaseOneTaskIds.has(proposal.taskId)
        && typeof proposal.createdAt === 'number'
        && proposal.createdAt >= runStartedAt
      ))
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
    if (!experienceProposal) {
      issues.push('Phase-one ordinary-interaction tasks did not generate an experience proposal.');
    } else {
      await approveProposal(serverUrl, experienceProposal.proposalId);
    }

    browser = await chromium.launch({
      headless: process.env.ORDINARY_INTERACTION_HEADED === '1' ? false : true,
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

    const webTaskId = await submitWebTask(page, frontendBaseUrl, PROMPTS.web);
    await sendWebFollowup(page, frontendBaseUrl, webTaskId, PROMPTS.web.start);
    const webSettled = await waitForTaskSettle({
      serverUrl,
      taskId: webTaskId,
      followup: async (message) => { await sendWebFollowup(page, frontendBaseUrl, webTaskId, message); },
      continueAction: async () => sendWebFollowup(page, frontendBaseUrl, webTaskId, ''),
      resolveApprovals: async (_task, _debug, invocationIds) => {
        await approvePendingTaskViaWeb(page, frontendBaseUrl, webTaskId, invocationIds);
      },
      generalContinueBudget: 2,
      finalizationContinueBudget: 1,
      maxFollowups: 10,
    });
    await ensureTaskPageReady(page, frontendBaseUrl, webTaskId);
    await ensureInspectorVisible(page);
    const webInspectorScreenshot = await captureScreenshot(page, 'ordinary-web-task');

    const webSelectedProposalIds = webSettled.debug.executionSummary.experienceSummary.selected.map((entry) => entry.proposalId);
    if (experienceProposal && !webSelectedProposalIds.includes(experienceProposal.proposalId)) {
      issues.push('Web-created reuse task did not heuristically select the approved experience.');
    }
    const experiencePanelVisible = await page.locator('[data-testid="task-experience-panel"]').count() > 0;
    if (!experiencePanelVisible) {
      issues.push('Web inspector did not render the Experience panel.');
    }

    const preFollowupConversations = getThreadMessageCount(webSettled.task);
    await sendWebFollowup(page, frontendBaseUrl, webTaskId, PROMPTS.web.followUp);
    const webAfterFollowup = await waitForTaskSettle({
      serverUrl,
      taskId: webTaskId,
      followup: async (message) => { await sendWebFollowup(page, frontendBaseUrl, webTaskId, message); },
      continueAction: async () => sendWebFollowup(page, frontendBaseUrl, webTaskId, ''),
      resolveApprovals: async (_task, _debug, invocationIds) => {
        await approvePendingTaskViaWeb(page, frontendBaseUrl, webTaskId, invocationIds);
      },
      timeoutMs: 120_000,
      generalContinueBudget: 2,
      finalizationContinueBudget: 1,
      maxFollowups: 6,
    });
    const webFollowupScreenshot = await captureScreenshot(page, 'ordinary-web-followup');
    const webAfterFollowupFinal = isTerminalCompleted(webAfterFollowup.task, webAfterFollowup.debug)
      ? webAfterFollowup
      : await waitForTaskSettle({
        serverUrl,
        taskId: webTaskId,
        timeoutMs: 90_000,
        maxFollowups: 0,
      });
    if (getThreadMessageCount(webAfterFollowupFinal.task) <= preFollowupConversations) {
      issues.push('Web follow-up composer did not continue the existing thread.');
    }
    if (!isTerminalCompleted(webAfterFollowupFinal.task, webAfterFollowupFinal.debug)) {
      issues.push(`Web ordinary-interaction follow-up task did not reach terminal completed state (${webAfterFollowupFinal.task.runtime.lifecycleStatus}).`);
    }

    const agentReuseMetadataFile = experienceProposal
      ? await writeMetadataFile('agent-reuse', {
        experienceProposalIds: [experienceProposal.proposalId],
      })
      : null;
    const agentReuse = await runAgentChatCreate(serverUrl, PROMPTS.reuse, agentReuseMetadataFile);
    const agentReuseSettled = await waitForTaskSettle({
      serverUrl,
      taskId: agentReuse.taskId,
      followup: async (message) => { await runAgentChatFollowup(serverUrl, agentReuse.taskId, message); },
      continueAction: async () => { await runAgentChatFollowup(serverUrl, agentReuse.taskId, '/continue'); },
      resolveApprovals: async (_task, _debug, invocationIds) => {
        await approvePendingTaskViaCli(serverUrl, agentReuse.taskId, runAgentChatFollowup, invocationIds);
      },
      generalContinueBudget: 4,
      finalizationContinueBudget: 2,
      maxFollowups: 10,
    });
    if (!isTerminalCompleted(agentReuseSettled.task, agentReuseSettled.debug)) {
      issues.push(`Agent ordinary-interaction reuse task did not reach terminal completed state (${agentReuseSettled.task.runtime.lifecycleStatus}).`);
    }

    const proposalsAfterReuse = await listProposals(serverUrl);
    const instructionSkillProposal = proposalsAfterReuse
      .filter((proposal) => proposal.kind === 'instruction_skill')
      .filter((proposal) => (
        proposal.taskId === agentReuse.taskId
        || proposal.metadata?.approvedExperienceProposalId === experienceProposal?.proposalId
        || (Array.isArray(proposal.evidenceTaskIds) && proposal.evidenceTaskIds.includes(agentReuse.taskId))
      ))
      .filter((proposal) => typeof proposal.updatedAt !== 'number' || proposal.updatedAt >= runStartedAt)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0] ?? null;
    if (!instructionSkillProposal) {
      issues.push('Post-approval successful reuse did not generate an instruction skill proposal.');
    }

    const humanDiagnostics = await runCli([
      '--server',
      serverUrl,
      'chat',
      '--format',
      'human',
      '--task',
      agentReuse.taskId,
    ], {
      stdinLines: ['/diagnostics', '/exit'],
    });
    if (!/Experience:/i.test(humanDiagnostics.stdout)) {
      issues.push('Human CLI diagnostics did not render the experience summary.');
    }

    const agentDiagnostics = await readTaskDiagnostics(serverUrl, agentReuse.taskId);
    if (!agentDiagnostics.json?.experienceSummary) {
      issues.push('Agent diagnostics did not include experienceSummary.');
    }
    if (experienceProposal) {
      const reuseSelectedProposalIds = agentReuseSettled.debug.executionSummary.experienceSummary.selected.map((entry) => entry.proposalId);
      if (!reuseSelectedProposalIds.includes(experienceProposal.proposalId)) {
        issues.push('Agent reuse task did not heuristically select the approved experience.');
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      status: issues.length === 0 ? 'achieved' : 'open_gap',
      runFamilyTag: RUN_FAMILY_TAG,
      provider: {
        id: providerSource.providerId,
        model: providerSource.model,
        sourceFile: providerSource.docPath,
        providerTest: providerTestPayload,
      },
      tasks: {
        humanCreate: {
          prompt: PROMPTS.human,
          chatOutput: humanCreate.output,
          followups: humanSettled.followups,
          surface: summarizeTaskSurface(humanSettled.task, humanSettled.debug),
        },
        agentCreate: {
          prompt: PROMPTS.agent,
          chatOutput: agentCreate.output,
          followups: agentSettled.followups,
          surface: summarizeTaskSurface(agentSettled.task, agentSettled.debug),
        },
        webCreate: {
          prompt: PROMPTS.web,
          initialFollowups: webSettled.followups,
          followupFollowups: webAfterFollowup.followups,
          finalizationFollowups: webAfterFollowupFinal.followups,
          surface: summarizeTaskSurface(webAfterFollowupFinal.task, webAfterFollowupFinal.debug),
          initialSurface: summarizeTaskSurface(webSettled.task, webSettled.debug),
          screenshots: [webInspectorScreenshot, webFollowupScreenshot],
          followupConversationCount: webAfterFollowupFinal.task.conversations.length,
        },
        agentReuse: {
          prompt: PROMPTS.reuse,
          chatOutput: agentReuse.output,
          followups: agentReuseSettled.followups,
          surface: summarizeTaskSurface(agentReuseSettled.task, agentReuseSettled.debug),
        },
      },
      experience: {
        proposalId: experienceProposal?.proposalId ?? null,
        approved: experienceProposal ? true : false,
        webSelected: webSettled.debug.executionSummary.experienceSummary.selected,
        agentReuseSelected: agentReuseSettled.debug.executionSummary.experienceSummary.selected,
        instructionSkillProposalId: instructionSkillProposal?.proposalId ?? null,
      },
      surfaceChecks: {
        humanDiagnostics: humanDiagnostics.stdout,
        agentDiagnostics: agentDiagnostics.json,
        webExperiencePanelVisible: experiencePanelVisible,
      },
      issues,
    };

    await writeReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (issues.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const backendLogs = readBackendLogs();
    const frontendLogs = readFrontendLogs();
    const report = {
      generatedAt: new Date().toISOString(),
      status: 'open_gap',
      error: error instanceof Error ? error.message : String(error),
      backendLogs,
      frontendLogs,
      issues,
    };
    await writeReport(report);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await Promise.all([
      terminateChild(frontend, 'frontend'),
      terminateChild(backend, 'backend'),
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
