import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildXiaomiMimoFlashLiveEnv,
  readXiaomiMimoFlashProviderSource,
  resolveXiaomiMimoFlashDocPath,
  XIAOMI_MIMO_COMPAT_MODEL,
  XIAOMI_MIMO_FLASH_PROVIDER_ID,
  XIAOMI_MIMO_FLASH_SECRET_ID,
  XIAOMI_MIMO_PRO_MODEL,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';
import {
  resolveBackendRuntimeManifestPath,
  resolveBackendRuntimeRoot,
} from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const dotCodexRunRoot = path.resolve(rootDir, '.codex-run');
const backendDataRoot = resolveBackendRuntimeRoot(rootDir);
const backendCliPath = path.resolve(rootDir, 'backend', 'dist', 'bin', 'cli.js');
const matrixRoot = path.resolve(dotCodexRunRoot, 'logs', 'human-task-matrix');
const targetExternalPath = 'D:\\AAA';
const preferredBackendPort = Number.parseInt(process.env.HUMAN_TASK_MATRIX_BACKEND_PORT ?? '3911', 10);
const DEFAULT_TASK_TIMEOUT_MS = Number.parseInt(process.env.HUMAN_TASK_MATRIX_TASK_TIMEOUT_MS ?? `${8 * 60 * 1000}`, 10);
const DEFAULT_MODEL_COOLDOWN_MS = Number.parseInt(process.env.HUMAN_TASK_MATRIX_MODEL_COOLDOWN_MS ?? '30000', 10);
const DEFAULT_STATUS_POLL_MS = Number.parseInt(process.env.HUMAN_TASK_MATRIX_STATUS_POLL_MS ?? '2000', 10);
const FOLLOWUP_EVIDENCE_TIMEOUT_MS = Number.parseInt(process.env.HUMAN_TASK_MATRIX_FOLLOWUP_EVIDENCE_TIMEOUT_MS ?? '30000', 10);
const DEFAULT_AUTO_APPROVE = process.env.HUMAN_TASK_MATRIX_AUTO_APPROVE !== '0';
const DEFAULT_MAX_AUTO_APPROVALS = Number.parseInt(process.env.HUMAN_TASK_MATRIX_MAX_AUTO_APPROVALS ?? '12', 10);
const DEFAULT_MAX_AUTO_CONTINUES = Number.parseInt(process.env.HUMAN_TASK_MATRIX_MAX_AUTO_CONTINUES ?? '6', 10);
const TERMINAL_LIFECYCLES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED']);

const DEFAULT_MODELS = [
  XIAOMI_MIMO_STRONG_MODEL,
  XIAOMI_MIMO_PRO_MODEL,
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function preferredWindowsNpm() {
  return process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : null;
}

function createTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function slugify(value) {
  return String(value ?? 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'unknown';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.stack ?? result.error.message ?? result.error) : null,
  };
}

function spawnNpm(args, env = {}) {
  if (process.platform === 'win32') {
    const executable = preferredWindowsNpm() ?? npmCommand();
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
    if (process.env.HUMAN_TASK_MATRIX_VERBOSE_STDIO === '1') {
      process.stdout.write(`[${label}] ${text}`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    if (process.env.HUMAN_TASK_MATRIX_VERBOSE_STDIO === '1') {
      process.stderr.write(`[${label}] ${text}`);
    }
  });
  return () => ({ stdout, stderr });
}

async function terminateChild(child, label) {
  if (!child?.pid) {
    return;
  }
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort cleanup.
  }
  await sleep(1000);
}

async function findAvailablePort(preferredPort) {
  const net = await import('node:net');
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`No available backend port near ${preferredPort}.`);
}

async function waitForHttp(url, timeoutMs = 120000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function parseJsonOutput(output, label) {
  const trimmed = String(output ?? '').trim();
  if (!trimmed) {
    throw new Error(`Expected JSON output for ${label}, but stdout was empty.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const candidates = [];
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] === '{' || trimmed[index] === '[') {
        candidates.push(index);
      }
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(trimmed.slice(candidates[index]));
      } catch {
        // Keep searching for a JSON suffix.
      }
    }
    throw new Error(`Failed to parse JSON output for ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Number(options.timeoutMs)) : 300000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateChild(child, `cli ${args.join(' ')}`).catch(() => null);
  }, timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  const result = {
    args: redactCliArgs(args),
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
  if (timedOut) {
    throw new Error(`CLI command timed out: ${redactCliArgs(args).join(' ')}`);
  }
  if (exitCode !== 0) {
    throw new Error(`CLI command failed (${exitCode}): ${redactCliArgs(args).join(' ')}\n${stdout}\n${stderr}`);
  }
  return result;
}

function buildHumanTaskCases() {
  return [
    {
      id: 'file-brief-summary',
      label: 'Grounded file summary',
      persona: 'Product operator',
      category: 'grounded_reading',
      timeoutMs: 240000,
      seedFiles: {
        'inputs/project-brief.md': [
          '# Atlas Release Brief',
          '',
          '- Launch window: 2026-06-12',
          '- Primary risk: partner API quota may be exhausted during import backfill.',
          '- Success metric: 98% of imports finish within 15 minutes.',
        ].join('\n'),
      },
      task: {
        title: 'Human Matrix: summarize a project brief',
        intent: 'Read inputs/project-brief.md and produce a concise operator note. Mention the launch window, primary risk, and success metric only if they are present in the file.',
        units: [{
          id: 'AGENT-001',
          role: 'OperatorAnalyst',
          goal: 'Use file evidence to summarize the project brief for a busy operator.',
          outputContract: '{"summary":"string","details":"string","risks":["string"]}',
          dependencies: [],
          executionProfileId: 'verify',
          taskScope: 'Do not invent project facts. Use the workspace file as the source of truth.',
        }],
      },
      expectedText: [/2026-06-12|June 12, 2026/i, /partner API quota/i, /98%|98 percent/i],
      requireToolActivity: true,
      checklist: [
        'Confirm the summary cites only facts present in inputs/project-brief.md.',
        'Confirm the response separates the risk from the success metric.',
      ],
    },
    {
      id: 'code-test-repair',
      label: 'Small code repair with verification',
      persona: 'Developer',
      category: 'coding',
      timeoutMs: 360000,
      seedFiles: {
        'package.json': JSON.stringify({
          type: 'commonjs',
          scripts: {
            test: 'node --test tests/math.test.cjs',
          },
        }, null, 2),
        'src/math.cjs': [
          'function addTax(amount, rate) {',
          '  return amount + rate;',
          '}',
          '',
          'module.exports = { addTax };',
        ].join('\n'),
        'tests/math.test.cjs': [
          "const test = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const { addTax } = require('../src/math.cjs');",
          '',
          "test('adds tax by multiplying the amount by the rate', () => {",
          '  assert.equal(addTax(100, 0.08), 108);',
          '});',
        ].join('\n'),
      },
      task: {
        title: 'Human Matrix: repair a tiny tax calculation',
        intent: 'Fix the failing tax calculation in the workspace and verify it with npm test. Do not add dependencies.',
        units: [{
          id: 'AGENT-001',
          role: 'CodeRepairer',
          goal: 'Inspect the failing test, repair the implementation, and run the test command.',
          outputContract: '{"summary":"string","details":"string","artifacts":["string"]}',
          dependencies: [],
          executionProfileId: 'implement',
          taskScope: 'Keep the change minimal and evidence-backed by a real command result.',
        }],
      },
      requiredWorkspaceFiles: ['src/math.cjs'],
      expectedFileText: {
        'src/math.cjs': [/amount\s*\*/, /rate/],
      },
      expectedText: [/npm test|node --test|test/i],
      requireToolActivity: true,
      checklist: [
        'Run the copied workspace test manually if needed and confirm it passes.',
        'Confirm the implementation change is minimal and does not hard-code the test value.',
      ],
    },
    {
      id: 'data-reconcile',
      label: 'CSV reconciliation artifact',
      persona: 'Finance analyst',
      category: 'data_transform',
      timeoutMs: 300000,
      seedFiles: {
        'inputs/orders.csv': [
          'customer,amount,status',
          'Acme,120,paid',
          'Beta,45,pending',
          'Acme,80,paid',
          'Delta,30,refunded',
        ].join('\n'),
      },
      task: {
        title: 'Human Matrix: reconcile a small CSV',
        intent: 'Read inputs/orders.csv and write outputs/customer-summary.json with per-customer totals and status counts. Include a short explanation in the final response.',
        units: [{
          id: 'AGENT-001',
          role: 'DataReconciler',
          goal: 'Transform the CSV into a small JSON summary and explain the calculation.',
          outputContract: '{"summary":"string","details":"string","artifacts":["string"]}',
          dependencies: [],
          executionProfileId: 'verify',
          taskScope: 'Use only the provided CSV. Do not infer hidden rows.',
        }],
      },
      requiredWorkspaceFiles: ['outputs/customer-summary.json'],
      expectedFileText: {
        'outputs/customer-summary.json': [/Acme/i, /200/, /pending/i, /refunded/i],
      },
      requireToolActivity: true,
      checklist: [
        'Verify customer totals match inputs/orders.csv.',
        'Confirm status counts include paid, pending, and refunded rows.',
      ],
    },
    {
      id: 'docs-decision-log',
      label: 'Synthesize docs into a decision log',
      persona: 'Team lead',
      category: 'docs',
      timeoutMs: 300000,
      seedFiles: {
        'notes/meeting-a.md': [
          '# Meeting A',
          '',
          '- Decision: keep the importer synchronous for the pilot.',
          '- Concern: large customers may need batch progress visibility.',
        ].join('\n'),
        'notes/meeting-b.md': [
          '# Meeting B',
          '',
          '- Decision: add a retry queue after pilot feedback.',
          '- Owner: platform team.',
        ].join('\n'),
      },
      task: {
        title: 'Human Matrix: create a decision log',
        intent: 'Read notes/meeting-a.md and notes/meeting-b.md, then write outputs/decision-log.md and outputs/trace.json. Each decision must cite the source note filename.',
        units: [{
          id: 'AGENT-001',
          role: 'DocsSynthesizer',
          goal: 'Create a grounded decision log and trace file from two meeting notes.',
          outputContract: '{"summary":"string","details":"string","artifacts":["string"]}',
          dependencies: [],
          executionProfileId: 'verify',
          taskScope: 'Every decision must be traceable to a source file.',
        }],
      },
      requiredWorkspaceFiles: ['outputs/decision-log.md', 'outputs/trace.json'],
      expectedFileText: {
        'outputs/decision-log.md': [/Meeting A/i, /Meeting B/i, /synchronous/i, /retry queue/i],
        'outputs/trace.json': [/meeting-a\.md/i, /meeting-b\.md/i],
      },
      requireToolActivity: true,
      checklist: [
        'Confirm every decision in the log has a source filename.',
        'Confirm trace.json maps claims to real note files.',
      ],
    },
    {
      id: 'missing-source-blocker',
      label: 'Honest blocker for missing input',
      persona: 'Support operator',
      category: 'honesty',
      timeoutMs: 240000,
      seedFiles: {},
      task: {
        title: 'Human Matrix: report a missing source blocker',
        intent: 'Inspect inputs/customer-escalation.md. If it does not exist, clearly report the missing-file blocker and do not invent customer details.',
        units: [{
          id: 'AGENT-001',
          role: 'SupportReviewer',
          goal: 'Check whether the escalation source exists and report the blocker honestly.',
          outputContract: '{"summary":"string","details":"string","issues":["string"]}',
          dependencies: [],
          executionProfileId: 'verify',
          taskScope: 'No customer details may be invented when the source file is absent.',
        }],
      },
      expectedText: [/missing|not found|does not exist/i, /inputs\/customer-escalation\.md/i],
      requireToolActivity: true,
      checklist: [
        'Confirm the result explicitly identifies the missing source file.',
        'Confirm no customer facts are invented.',
      ],
    },
    {
      id: 'multi-unit-handoff',
      label: 'Two-unit handoff and review',
      persona: 'Release manager',
      category: 'multi_unit',
      timeoutMs: 420000,
      seedFiles: {
        'inputs/release-notes.md': [
          '# Release Notes',
          '',
          '- Feature: background import cancellation.',
          '- Fix: CSV parser now preserves quoted commas.',
          '- Risk: cancellation telemetry is not yet dashboarded.',
        ].join('\n'),
      },
      task: {
        title: 'Human Matrix: release note handoff',
        intent: 'Have one unit inspect inputs/release-notes.md and a second unit write outputs/release-review.md from the first unit output. The review must include feature, fix, and risk sections.',
        units: [
          {
            id: 'AGENT-001',
            role: 'ReleaseReader',
            goal: 'Read the release notes and produce grounded findings.',
            outputContract: '{"summary":"string","feature":"string","fix":"string","risk":"string"}',
            dependencies: [],
            executionProfileId: 'verify',
            taskScope: 'Use only inputs/release-notes.md.',
          },
          {
            id: 'AGENT-002',
            role: 'ReleaseReviewer',
            goal: 'Use AGENT-001 output to write outputs/release-review.md with feature, fix, and risk sections.',
            outputContract: '{"summary":"string","details":"string","artifacts":["string"]}',
            dependencies: ['AGENT-001'],
            executionProfileId: 'implement',
            taskScope: 'Do not reread unrelated files or add release facts absent from AGENT-001 output.',
          },
        ],
      },
      requiredWorkspaceFiles: ['outputs/release-review.md'],
      expectedFileText: {
        'outputs/release-review.md': [/background import cancellation/i, /quoted comma/i, /telemetry/i],
      },
      requireToolActivity: true,
      checklist: [
        'Confirm the second unit used the first unit findings.',
        'Confirm feature, fix, and risk sections are all present and grounded.',
      ],
    },
  ];
}

function resolveSelectedHumanTaskMatrixEntries(options = {}, env = process.env) {
  const allCases = buildHumanTaskCases();
  const caseIds = parseCsv(options.cases ?? env.HUMAN_TASK_MATRIX_CASES ?? parseArgValue('cases') ?? '');
  const models = parseCsv(options.models ?? env.HUMAN_TASK_MATRIX_MODELS ?? parseArgValue('models') ?? '')
    .concat([]);
  const selectedModels = models.length > 0 ? models : DEFAULT_MODELS;
  const requestedCaseIds = new Set(caseIds);
  const unknownCases = caseIds.filter((id) => !allCases.some((testCase) => testCase.id === id));
  if (unknownCases.length > 0) {
    throw new Error(`Unknown human task matrix case(s): ${unknownCases.join(', ')}`);
  }
  const selectedCases = requestedCaseIds.size > 0
    ? allCases.filter((testCase) => requestedCaseIds.has(testCase.id))
    : allCases;
  return selectedModels.flatMap((model) => selectedCases.map((testCase) => ({ model, testCase })));
}

function buildTaskDefinition(testCase, providerId) {
  return {
    title: testCase.task.title,
    intent: testCase.task.intent,
    preferredProviderId: providerId,
    metadata: {
      source: 'human-task-matrix',
      humanTaskCaseId: testCase.id,
      humanPersona: testCase.persona,
      category: testCase.category,
      artifactRouting: {
        pathPolicy: 'task_workspace',
        preferredArtifactDir: null,
        artifactApplyMode: 'sandbox_then_apply',
      },
    },
    units: testCase.task.units.map((unit) => ({
      id: unit.id,
      role: unit.role,
      goal: unit.goal,
      outputContract: unit.outputContract,
      dependencies: Array.isArray(unit.dependencies) ? unit.dependencies : [],
      executionProfileId: unit.executionProfileId,
      taskScope: unit.taskScope,
    })),
  };
}

async function seedTaskWorkspace(taskId, seedFiles) {
  const workspaceDir = path.join(backendDataRoot, 'workspace', taskId);
  const seeded = [];
  for (const [relativePath, content] of Object.entries(seedFiles ?? {})) {
    const target = path.join(workspaceDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    seeded.push({ relativePath, path: target });
  }
  return { workspaceDir, seeded };
}

async function listFilesRecursive(rootPath) {
  const files = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  await visit(rootPath);
  return files.sort((left, right) => left.localeCompare(right));
}

async function readWorkspaceText(workspaceDir, relativePath, limit = 12000) {
  const filePath = path.join(workspaceDir, ...relativePath.split('/'));
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function extractVisibleToolActivities(debugPayload) {
  if (Array.isArray(debugPayload?.task?.visibleToolActivities)) {
    return debugPayload.task.visibleToolActivities;
  }
  if (Array.isArray(debugPayload?.visibleToolActivities)) {
    return debugPayload.visibleToolActivities;
  }
  const invocations = Array.isArray(debugPayload?.task?.toolInvocations)
    ? debugPayload.task.toolInvocations
    : [];
  return invocations.map((entry) => ({
    toolId: entry.toolId,
    status: entry.status,
    argumentsSummary: entry.argumentsSummary ?? null,
    resultSummary: entry.resultSummary ?? entry.result?.summary ?? null,
  }));
}

function extractPendingApprovalItems(debugPayload) {
  const task = debugPayload?.task ?? debugPayload ?? {};
  const candidates = [
    ...(Array.isArray(task.pendingApprovalItems) ? task.pendingApprovalItems : []),
    ...(Array.isArray(task.pendingApprovals) ? task.pendingApprovals : []),
  ];
  const seen = new Set();
  const items = [];
  for (const entry of candidates) {
    const invocationId = entry?.invocationId;
    if (!invocationId || seen.has(invocationId)) {
      continue;
    }
    const status = String(entry.status ?? '').toUpperCase();
    const availableActions = Array.isArray(entry.availableActions) ? entry.availableActions.map((value) => String(value).toUpperCase()) : ['APPROVED'];
    if (status !== 'PENDING' || !availableActions.includes('APPROVED')) {
      continue;
    }
    seen.add(invocationId);
    items.push({
      invocationId,
      toolId: entry.toolId ?? null,
      status,
      reason: entry.reason ?? null,
    });
  }
  return items;
}

async function approvePendingApprovals({ serverUrl, taskId, liveEnv, debugPayload, approvalsApplied, maxApprovals }) {
  if (!DEFAULT_AUTO_APPROVE) {
    return 0;
  }
  const remaining = Math.max(0, maxApprovals - approvalsApplied.length);
  if (remaining <= 0) {
    return 0;
  }
  const pendingItems = extractPendingApprovalItems(debugPayload).slice(0, remaining);
  for (const item of pendingItems) {
    await runCli([
      '--server',
      serverUrl,
      'tasks',
      'approve',
      taskId,
      item.invocationId,
      'APPROVED',
      '--granted-by',
      'human-task-matrix',
      '--reason',
      `Human task matrix approved ${item.toolId ?? 'tool'} for validation.`,
    ], liveEnv, { timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS });
    approvalsApplied.push({
      invocationId: item.invocationId,
      toolId: item.toolId,
      approvedAt: new Date().toISOString(),
    });
  }
  if (pendingItems.length > 0) {
    await runCli(['--server', serverUrl, 'tasks', 'continue', taskId, '--auto-run', '--max-turns', '8'], liveEnv, {
      timeoutMs: 300000,
    }).catch(() => null);
  }
  return pendingItems.length;
}

function extractAssistantExplicitOutputs(debugPayload) {
  const candidates = [
    ...(Array.isArray(debugPayload?.task?.runtime?.llmContextMessages) ? debugPayload.task.runtime.llmContextMessages : []),
    ...(Array.isArray(debugPayload?.runtime?.llmContextMessages) ? debugPayload.runtime.llmContextMessages : []),
    ...(Array.isArray(debugPayload?.task?.conversations) ? debugPayload.task.conversations : []),
    ...(Array.isArray(debugPayload?.conversations) ? debugPayload.conversations : []),
  ];
  return candidates
    .filter((entry) => entry?.role === 'assistant')
    .map((entry) => String(entry.content ?? ''))
    .filter((content) => /\[[A-Za-z0-9_-]+_OUTPUT\]/.test(content))
    .join('\n\n');
}

function buildInspectionText({ debugPayload, chatHuman, chatNdjson, workspaceTextByPath }) {
  const parts = [
    JSON.stringify(debugPayload?.task?.latestVisibleOutput ?? null),
    JSON.stringify(debugPayload?.task?.completionSummary ?? null),
    JSON.stringify(debugPayload?.executionSummary?.acceptance ?? null),
    extractAssistantExplicitOutputs(debugPayload),
    chatHuman,
    chatNdjson,
    ...Object.values(workspaceTextByPath ?? {}),
  ];
  return parts.filter(Boolean).join('\n\n');
}

function classifyHumanTaskRun(testCase, run) {
  const issues = [];
  const advisories = [];
  const lifecycle = run.finalStatus?.lifecycleStatus ?? run.debugPayload?.task?.runtime?.lifecycleStatus ?? null;
  const deterministicVerdict = run.debugPayload?.executionSummary?.acceptance?.deterministic?.verdict ?? null;
  const providerFailure = run.debugPayload?.task?.diagnostics?.providerFailure ?? null;
  const workspaceFiles = new Set(run.workspaceFiles ?? []);
  const inspectionText = run.inspectionText ?? '';

  if (lifecycle !== 'COMPLETED') {
    issues.push(`Task did not reach COMPLETED. lifecycleStatus=${lifecycle ?? 'unknown'}`);
  }
  if (run.stoppedReason) {
    issues.push(`Runner stopped after detecting ${run.stoppedReason}.`);
  }
  if (deterministicVerdict && deterministicVerdict !== 'passed') {
    issues.push(`Deterministic acceptance did not pass. verdict=${deterministicVerdict}`);
  }
  if (providerFailure) {
    issues.push(`Provider failure was recorded: ${providerFailure.message ?? JSON.stringify(providerFailure)}`);
  }
  if (testCase.requireToolActivity && Number(run.visibleToolActivityCount ?? 0) === 0) {
    issues.push('No visible tool activity was recorded even though the human task required evidence.');
  }
  for (const relativePath of testCase.requiredWorkspaceFiles ?? []) {
    if (!workspaceFiles.has(relativePath)) {
      issues.push(`Missing required workspace file: ${relativePath}`);
    }
  }
  for (const [relativePath, patterns] of Object.entries(testCase.expectedFileText ?? {})) {
    const text = run.workspaceTextByPath?.[relativePath] ?? '';
    for (const pattern of patterns) {
      if (!pattern.test(text)) {
        issues.push(`Workspace file ${relativePath} did not match expected pattern ${pattern}.`);
      }
    }
  }
  for (const pattern of testCase.expectedText ?? []) {
    if (!pattern.test(inspectionText)) {
      issues.push(`Observed output did not match expected pattern ${pattern}.`);
    }
  }

  const classification = providerFailure
    ? 'external_blocker'
    : issues.length === 0
      ? 'passed'
      : 'manual_review_required';
  if (classification === 'manual_review_required') {
    advisories.push('Inspect the artifact bundle before treating this as a product failure; live model output can vary.');
  }
  if (classification === 'external_blocker') {
    advisories.push('Treat provider or network failures as external blockers before changing runtime behavior.');
  }
  return {
    classification,
    issues,
    advisories,
  };
}

async function copyWorkspaceBundle(workspaceDir, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  if (!(await pathExists(workspaceDir))) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(workspaceDir, destination, { recursive: true, force: true });
  return true;
}

async function waitForTaskTerminal(serverUrl, taskId, liveEnv, timeoutMs) {
  const startedAt = Date.now();
  let statusPayload = null;
  let debugPayload = null;
  const approvalsApplied = [];
  const continuesApplied = [];
  while (Date.now() - startedAt < timeoutMs) {
    const statusResult = await runCli(['--server', serverUrl, 'tasks', 'status', taskId], liveEnv);
    statusPayload = parseJsonOutput(statusResult.stdout, 'tasks status');
    if (TERMINAL_LIFECYCLES.has(statusPayload.lifecycleStatus)) {
      return { statusPayload, debugPayload, stoppedReason: null, timedOut: false, approvalsApplied };
    }
    const debugResult = await runCli(['--server', serverUrl, 'tasks', 'debug', taskId], liveEnv)
      .catch(() => null);
    debugPayload = debugResult ? parseJsonOutput(debugResult.stdout, 'tasks debug') : null;
    const approvedCount = await approvePendingApprovals({
      serverUrl,
      taskId,
      liveEnv,
      debugPayload,
      approvalsApplied,
      maxApprovals: Number.isFinite(DEFAULT_MAX_AUTO_APPROVALS) ? DEFAULT_MAX_AUTO_APPROVALS : 12,
    });
    if (approvedCount > 0) {
      await sleep(DEFAULT_STATUS_POLL_MS);
      continue;
    }
    if (isAwaitingGenericContinue(debugPayload)) {
      if (continuesApplied.length >= DEFAULT_MAX_AUTO_CONTINUES) {
        return {
          statusPayload,
          debugPayload,
          stoppedReason: 'generic_continue_limit',
          timedOut: false,
          approvalsApplied,
          continuesApplied,
        };
      }
      continuesApplied.push({ appliedAt: new Date().toISOString() });
      await runCli([
        '--server',
        serverUrl,
        'tasks',
        'continue',
        taskId,
        '--auto-run',
        '--max-turns',
        '8',
        '--message',
        'Continue after the runtime requested the next generic correction turn; no scenario-specific guidance is provided.',
      ], liveEnv, { timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS });
      await sleep(DEFAULT_STATUS_POLL_MS);
      continue;
    }
    if (isAwaitingOperatorFollowup(debugPayload)) {
      return {
        statusPayload,
        debugPayload,
        stoppedReason: 'awaiting_operator_followup',
        timedOut: false,
        approvalsApplied,
        continuesApplied,
      };
    }
    await sleep(DEFAULT_STATUS_POLL_MS);
  }
  return { statusPayload, debugPayload, stoppedReason: 'timeout', timedOut: true, approvalsApplied, continuesApplied };
}

function getRunnableTaskState(debugPayload) {
  const task = debugPayload?.task ?? null;
  const runtime = task?.runtime ?? null;
  if (!task || !runtime || TERMINAL_LIFECYCLES.has(runtime.lifecycleStatus)) {
    return null;
  }
  const leaseActive = runtime.executionLease?.active === true;
  if (leaseActive) {
    return null;
  }
  return { task, runtime };
}

function isAwaitingGenericContinue(debugPayload) {
  const state = getRunnableTaskState(debugPayload);
  if (!state) {
    return false;
  }
  const { task, runtime } = state;
  if (Array.isArray(task.pendingApprovalItems) && task.pendingApprovalItems.length > 0) {
    return false;
  }
  if (Array.isArray(runtime.awaitingApprovalInvocations) && runtime.awaitingApprovalInvocations.length > 0) {
    return false;
  }
  if (Array.isArray(runtime.pendingOperatorInputs) && runtime.pendingOperatorInputs.length > 0) {
    return false;
  }
  const primaryActionKind = String(task.primaryAction?.kind ?? '').toLowerCase();
  if (primaryActionKind === 'use_recommended_path' || primaryActionKind === 'choose_custom_path' || primaryActionKind === 'approve') {
    return false;
  }
  const nextActionLabel = String(task.nextActionSummary?.label ?? '').toLowerCase();
  const pendingCorrection = String(runtime.pendingCorrection ?? 'NONE').toUpperCase();
  return primaryActionKind === 'continue_thread'
    || nextActionLabel.includes('continue')
    || pendingCorrection === 'AWAITING_TRACKER'
    || pendingCorrection === 'AWAITING_OUTPUT'
    || pendingCorrection === 'AWAITING_TOOL_ACTION'
    || pendingCorrection === 'AWAITING_BLOCKER_EXPLANATION';
}

function isAwaitingOperatorFollowup(debugPayload) {
  const state = getRunnableTaskState(debugPayload);
  if (!state) {
    return false;
  }
  const { task, runtime } = state;
  const primaryActionKind = String(task.primaryAction?.kind ?? '').toLowerCase();
  return primaryActionKind === 'use_recommended_path'
    || primaryActionKind === 'choose_custom_path'
    || primaryActionKind === 'approve'
    || (Array.isArray(runtime.pendingOperatorInputs) && runtime.pendingOperatorInputs.length > 0)
    || (Array.isArray(runtime.awaitingApprovalInvocations) && runtime.awaitingApprovalInvocations.length > 0)
    || (Array.isArray(task.pendingApprovalItems) && task.pendingApprovalItems.length > 0);
}

async function runHumanTaskCase({ testCase, model, providerSource, serverUrl, liveEnv, runRoot }) {
  const caseRoot = path.join(runRoot, slugify(model), slugify(testCase.id));
  await fs.mkdir(caseRoot, { recursive: true });
  const taskDefinition = buildTaskDefinition(testCase, providerSource.providerId);
  const taskFilePath = path.join(caseRoot, 'task-definition.json');
  await writeJson(taskFilePath, taskDefinition);

  const submitResult = await runCli(['--server', serverUrl, 'tasks', 'submit', taskFilePath], liveEnv);
  const submitPayload = parseJsonOutput(submitResult.stdout, `${testCase.id} submit`);
  const taskId = submitPayload?.command?.taskId ?? submitPayload?.task?.definition?.taskId ?? null;
  if (!taskId) {
    throw new Error(`${testCase.id} submit did not return a taskId.`);
  }
  const seededWorkspace = await seedTaskWorkspace(taskId, testCase.seedFiles);
  const startResult = await runCli(['--server', serverUrl, 'tasks', 'start', taskId, '--auto-run', '--max-turns', '8'], liveEnv, {
    timeoutMs: testCase.startTimeoutMs ?? 300000,
  });
  const startPayload = parseJsonOutput(startResult.stdout, `${testCase.id} start`);

  const waitResult = await waitForTaskTerminal(serverUrl, taskId, liveEnv, testCase.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
  if (waitResult.timedOut || waitResult.stoppedReason) {
    await runCli([
      '--server',
      serverUrl,
      'tasks',
      'cancel',
      taskId,
      '--reason',
      `Human task matrix stopped ${testCase.id} after ${waitResult.stoppedReason ?? 'timeout'}; no harness repair instruction was sent.`,
    ], liveEnv, { timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS }).catch(() => null);
  }

  const statusResult = await runCli(['--server', serverUrl, 'tasks', 'status', taskId], liveEnv, {
    timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS,
  }).catch(() => null);
  const finalStatus = statusResult
    ? parseJsonOutput(statusResult.stdout, `${testCase.id} final status`)
    : (waitResult.statusPayload ?? { lifecycleStatus: 'UNKNOWN' });
  const freshDebugResult = await runCli(['--server', serverUrl, 'tasks', 'debug', taskId], liveEnv, {
    timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS,
  }).catch(() => null);
  const debugPayload = freshDebugResult
    ? parseJsonOutput(freshDebugResult.stdout, `${testCase.id} debug`)
    : waitResult.debugPayload;
  const diagnosticsResult = await runCli(['--server', serverUrl, 'tasks', 'diagnostics', taskId], liveEnv, {
    timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS,
  })
    .catch((error) => ({ stdout: '', stderr: String(error), exitCode: 1 }));
  const chatHumanResult = await runCli(['--server', serverUrl, 'chat', '--format', 'human', '--task', taskId], liveEnv, {
    timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS,
  })
    .catch((error) => ({ stdout: '', stderr: String(error), exitCode: 1 }));
  const chatNdjsonResult = await runCli(['--server', serverUrl, 'tasks', 'chat', taskId, '--format', 'ndjson'], liveEnv, {
    timeoutMs: FOLLOWUP_EVIDENCE_TIMEOUT_MS,
  })
    .catch((error) => ({ stdout: '', stderr: String(error), exitCode: 1 }));

  const workspaceDir = seededWorkspace.workspaceDir;
  const workspaceFiles = await listFilesRecursive(workspaceDir);
  const workspaceTextByPath = {};
  const interestingFiles = new Set([
    ...(testCase.requiredWorkspaceFiles ?? []),
    ...Object.keys(testCase.expectedFileText ?? {}),
  ]);
  for (const relativePath of interestingFiles) {
    if (workspaceFiles.includes(relativePath)) {
      workspaceTextByPath[relativePath] = await readWorkspaceText(workspaceDir, relativePath);
    }
  }
  const visibleToolActivities = extractVisibleToolActivities(debugPayload);
  const inspectionText = buildInspectionText({
    debugPayload,
    chatHuman: chatHumanResult.stdout,
    chatNdjson: chatNdjsonResult.stdout,
    workspaceTextByPath,
  });
  const runRecord = {
    id: testCase.id,
    label: testCase.label,
    persona: testCase.persona,
    category: testCase.category,
    requestedModel: model,
    effectiveModel: providerSource.model,
    fallbackApplied: providerSource.requestedModel !== providerSource.model,
    taskId,
    taskFilePath,
    workspaceDir,
    evidenceRoot: caseRoot,
    artifactBundleRoot: path.join(caseRoot, 'artifact-bundle'),
    submitPayload,
    startPayload,
    finalStatus,
    timedOut: waitResult.timedOut,
    stoppedReason: waitResult.stoppedReason,
    approvalsApplied: waitResult.approvalsApplied ?? [],
    continuesApplied: waitResult.continuesApplied ?? [],
    preStopDebugPayload: waitResult.debugPayload,
    debugPayload,
    diagnosticsText: diagnosticsResult.stdout || diagnosticsResult.stderr,
    chatHuman: chatHumanResult.stdout,
    chatNdjson: chatNdjsonResult.stdout,
    workspaceFiles,
    workspaceTextByPath,
    visibleToolActivities,
    visibleToolActivityCount: visibleToolActivities.length,
    checklist: testCase.checklist,
  };
  runRecord.inspectionText = inspectionText;
  runRecord.result = classifyHumanTaskRun(testCase, runRecord);

  await writeJson(path.join(caseRoot, 'task-debug.json'), debugPayload);
  await writeText(path.join(caseRoot, 'chat-human.txt'), chatHumanResult.stdout);
  await writeText(path.join(caseRoot, 'chat.ndjson'), chatNdjsonResult.stdout);
  await writeText(path.join(caseRoot, 'diagnostics.txt'), runRecord.diagnosticsText);
  await writeJson(path.join(caseRoot, 'run-result.json'), {
    ...runRecord,
    debugPayload: undefined,
    chatHuman: undefined,
    chatNdjson: undefined,
    inspectionText: undefined,
  });
  await copyWorkspaceBundle(workspaceDir, runRecord.artifactBundleRoot);
  return runRecord;
}

function formatMarkdownReport(report) {
  const lines = [
    '# Human Task Matrix Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Run root: ${report.runRoot}`,
    '',
    'This matrix simulates ordinary users submitting tasks through the public task API/CLI. It does not inject scenario-pack repair turns. Script checks are triage evidence; artifact bundles remain the review authority.',
    '',
    '## Summary',
    '',
    `- Runs: ${report.summary.total}`,
    `- Passed: ${report.summary.passed}`,
    `- Manual review required: ${report.summary.manualReviewRequired}`,
    `- External blockers: ${report.summary.externalBlockers ?? 0}`,
    `- Model blockers: ${report.summary.modelBlockers}`,
    '',
    '## Runs',
    '',
  ];
  for (const run of report.runs) {
    lines.push(`### ${run.requestedModel} / ${run.id}`);
    lines.push('');
    lines.push(`- Persona: ${run.persona}`);
    lines.push(`- Category: ${run.category}`);
    lines.push(`- Effective model: ${run.effectiveModel}`);
    lines.push(`- Fallback applied: ${run.fallbackApplied}`);
    lines.push(`- Task ID: ${run.taskId}`);
    lines.push(`- Lifecycle: ${run.finalStatus?.lifecycleStatus ?? 'unknown'}`);
    lines.push(`- Stopped reason: ${run.stoppedReason ?? 'none'}`);
    lines.push(`- Classification: ${run.result.classification}`);
    lines.push(`- Simulated approvals: ${run.approvalsApplied?.length ?? 0}`);
    lines.push(`- Visible tool activities: ${run.visibleToolActivityCount}`);
    lines.push(`- Workspace files: ${run.workspaceFiles.length}`);
    lines.push(`- Artifact bundle: ${run.artifactBundleRoot}`);
    if (run.result.issues.length > 0) {
      lines.push('- Issues:');
      for (const issue of run.result.issues) {
        lines.push(`  - ${issue}`);
      }
    }
    lines.push('- Human checklist:');
    for (const item of run.checklist ?? []) {
      lines.push(`  - [ ] ${item}`);
    }
    lines.push('');
  }
  if (report.modelBlockers.length > 0) {
    lines.push('## Model Blockers', '');
    for (const blocker of report.modelBlockers) {
      lines.push(`- ${blocker.requestedModel}: ${blocker.error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function summarizeReport(runs, modelBlockers) {
  return {
    total: runs.length,
    passed: runs.filter((run) => run.result.classification === 'passed').length,
    manualReviewRequired: runs.filter((run) => run.result.classification === 'manual_review_required').length,
    externalBlockers: runs.filter((run) => run.result.classification === 'external_blocker').length,
    modelBlockers: modelBlockers.length,
  };
}

async function setupProvider(serverUrl, providerSource, liveEnv) {
  const secretResult = await runCli([
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
  ], liveEnv);
  const providerTestResult = await runCli([
    '--server',
    serverUrl,
    'platform',
    'providers',
    'test',
    XIAOMI_MIMO_FLASH_PROVIDER_ID,
  ], liveEnv);
  return {
    secretSet: parseJsonOutput(secretResult.stdout, 'provider secret set'),
    providerTest: parseJsonOutput(providerTestResult.stdout, 'provider test'),
  };
}

function validateManifest(providerSource) {
  const manifestPath = resolveBackendRuntimeManifestPath(rootDir);
  const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
  const provider = providers.find((entry) => entry?.id === XIAOMI_MIMO_FLASH_PROVIDER_ID) ?? null;
  const issues = [];
  if (!provider) {
    issues.push(`Provider manifest is missing ${XIAOMI_MIMO_FLASH_PROVIDER_ID}.`);
  }
  if (provider?.model !== providerSource.model) {
    issues.push(`Provider manifest model mismatch. expected=${providerSource.model} actual=${provider?.model ?? 'missing'}`);
  }
  return {
    manifestPath,
    provider,
    issues,
    passed: issues.length === 0,
  };
}

async function runModelGroup({ model, entries, runRoot, report }) {
  let providerSource = null;
  let liveEnv = null;
  try {
    providerSource = await readXiaomiMimoFlashProviderSource(rootDir, {
      model,
      allowCompatibleModelFallback: true,
      requireTextAgentModel: true,
    });
    liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir, {
      model: providerSource.model,
      requireTextAgentModel: true,
    });
  } catch (error) {
    report.modelBlockers.push({
      requestedModel: model,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const backendPort = await findAvailablePort(preferredBackendPort);
  const serverUrl = `http://127.0.0.1:${backendPort}`;
  const buildResult = runCommandCapture(npmCommand(), ['run', 'build', '-w', 'backend'], {
    cwd: rootDir,
    timeoutMs: 300000,
  });
  await writeJson(path.join(runRoot, slugify(model), 'backend-build.json'), buildResult);
  if (buildResult.exitCode !== 0) {
    report.modelBlockers.push({
      requestedModel: model,
      effectiveModel: providerSource.model,
      error: 'Backend build failed before human task matrix could start.',
    });
    return;
  }

  const backend = spawnNpm(['run', 'start', '-w', 'backend'], {
    ...liveEnv,
    BACKEND_NEW_SERVER_PORT: String(backendPort),
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
  const readBackendLogs = collectOutput(backend, `backend:${model}`);
  try {
    await waitForHttp(`${serverUrl}/health`, 120000);
    const preflight = {
      provider: {
        id: providerSource.providerId,
        requestedModel: providerSource.requestedModel,
        effectiveModel: providerSource.model,
        fallbackApplied: providerSource.requestedModel !== providerSource.model,
        baseUrl: providerSource.baseUrl,
      },
      manifest: validateManifest(providerSource),
      providerSetup: await setupProvider(serverUrl, providerSource, liveEnv),
    };
    await writeJson(path.join(runRoot, slugify(model), 'preflight.json'), preflight);
    for (const entry of entries) {
      process.stdout.write(`[human-task-matrix] ${model} / ${entry.testCase.id}\n`);
      const runRecord = await runHumanTaskCase({
        testCase: entry.testCase,
        model,
        providerSource,
        serverUrl,
        liveEnv,
        runRoot,
      });
      report.runs.push(runRecord);
      await writeMatrixReport(runRoot, report);
      if (DEFAULT_MODEL_COOLDOWN_MS > 0) {
        await sleep(DEFAULT_MODEL_COOLDOWN_MS);
      }
    }
  } catch (error) {
    report.modelBlockers.push({
      requestedModel: model,
      effectiveModel: providerSource.model,
      error: error instanceof Error ? error.message : String(error),
      backendLogs: readBackendLogs(),
    });
    await writeMatrixReport(runRoot, report);
  } finally {
    await writeJson(path.join(runRoot, slugify(model), 'backend-logs.json'), readBackendLogs());
    await terminateChild(backend, `backend:${model}`);
  }
}

async function writeMatrixReport(runRoot, report) {
  report.summary = summarizeReport(report.runs, report.modelBlockers);
  const jsonPath = path.join(runRoot, 'human-task-matrix-report.json');
  const markdownPath = path.join(runRoot, 'human-task-matrix-report.md');
  const slimReport = {
    ...report,
    runs: report.runs.map((run) => ({
      ...run,
      debugPayload: undefined,
      chatHuman: undefined,
      chatNdjson: undefined,
      inspectionText: undefined,
    })),
  };
  await writeJson(jsonPath, slimReport);
  await writeText(markdownPath, formatMarkdownReport(slimReport));
}

async function main() {
  const entries = resolveSelectedHumanTaskMatrixEntries();
  const runRoot = path.join(matrixRoot, createTimestamp());
  const grouped = new Map();
  for (const entry of entries) {
    const list = grouped.get(entry.model) ?? [];
    list.push(entry);
    grouped.set(entry.model, list);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    runRoot,
    mode: 'human_submit_wait_inspect',
    availableTextModels: [
      XIAOMI_MIMO_STRONG_MODEL,
      XIAOMI_MIMO_PRO_MODEL,
      XIAOMI_MIMO_COMPAT_MODEL,
      'mimo-v2-omni',
    ],
    requested: {
      models: [...grouped.keys()],
      cases: [...new Set(entries.map((entry) => entry.testCase.id))],
    },
    runs: [],
    modelBlockers: [],
    summary: summarizeReport([], []),
  };
  await fs.mkdir(runRoot, { recursive: true });
  await writeMatrixReport(runRoot, report);

  for (const [model, modelEntries] of grouped.entries()) {
    await runModelGroup({ model, entries: modelEntries, runRoot, report });
  }
  await writeMatrixReport(runRoot, report);
  process.stdout.write(`${JSON.stringify({
    status: 'completed',
    runRoot,
    summary: report.summary,
  }, null, 2)}\n`);
  if ((hasArg('strict') || process.env.HUMAN_TASK_MATRIX_STRICT === '1') && report.summary.manualReviewRequired > 0) {
    process.exitCode = 1;
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
  buildHumanTaskCases,
  buildInspectionText,
  buildTaskDefinition,
  classifyHumanTaskRun,
  extractPendingApprovalItems,
  formatMarkdownReport,
  isAwaitingGenericContinue,
  isAwaitingOperatorFollowup,
  resolveSelectedHumanTaskMatrixEntries,
};
