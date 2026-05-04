import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.FRONTEND_BASE_URL ?? 'http://127.0.0.1:5893';
const BACKEND_URL = process.env.IMPROVEMENT_GOVERNANCE_AUDIT_BACKEND_URL ?? 'http://127.0.0.1:3931';
const MOCK_PROVIDER_URL = process.env.IMPROVEMENT_GOVERNANCE_AUDIT_MOCK_PROVIDER_URL ?? 'http://127.0.0.1:4331';
const BACKEND_ROOT_DIR = process.env.IMPROVEMENT_GOVERNANCE_AUDIT_BACKEND_ROOT_DIR;
const REPORT_PATH = process.env.IMPROVEMENT_GOVERNANCE_AUDIT_REPORT
  ?? path.resolve(process.cwd(), '.codex-run', 'logs', 'frontend-improvement-governance-audit.json');
const SCREENSHOT_DIR = process.env.IMPROVEMENT_GOVERNANCE_AUDIT_SCREENSHOTS
  ?? path.resolve(process.cwd(), '.codex-run', 'logs', 'frontend-improvement-governance-audit');

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  });
}

async function requestJson(url, init = undefined) {
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

async function waitFor(condition, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await condition();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.errorMessage ?? 'Timed out waiting for condition.');
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
}

async function patchConfig(patch) {
  return requestJson(`${BACKEND_URL}/config`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

async function ensureMockProvider() {
  const providerId = 'mock-e2e';
  await requestJson(`${BACKEND_URL}/providers/${providerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      id: providerId,
      label: 'Mock Governance Provider',
      vendor: 'custom',
      transport: 'openai-compatible',
      baseUrl: `${MOCK_PROVIDER_URL}/v1`,
      model: 'mock-governance-model',
      auth: { scheme: 'none' },
      metadata: { variantId: 'governance-audit' },
    }),
  });
  await requestJson(`${BACKEND_URL}/providers/${providerId}/default`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function resetMockProvider(responses) {
  await requestJson(`${MOCK_PROVIDER_URL}/__admin/reset`, {
    method: 'POST',
    body: JSON.stringify({ responses }),
  });
}

async function submitTask(payload) {
  const response = await requestJson(`${BACKEND_URL}/tasks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return response.command?.taskId ?? response.task?.definition?.taskId ?? null;
}

async function startTask(taskId, userMessage = '') {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/start`, {
    method: 'POST',
    body: JSON.stringify({ userMessage }),
  });
}

async function getTask(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}`);
}

async function listProposals() {
  return requestJson(`${BACKEND_URL}/improvements/proposals`);
}

async function approveProposal(proposalId) {
  return requestJson(`${BACKEND_URL}/improvements/proposals/${proposalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function listArchive() {
  return requestJson(`${BACKEND_URL}/improvements/archive`);
}

async function listMemories() {
  return requestJson(`${BACKEND_URL}/memories`);
}

async function getReport() {
  return requestJson(`${BACKEND_URL}/improvements/report`);
}

function createImplementOutput(summary, details, artifactPath) {
  return [
    `[AGENT-001_OUTPUT]${JSON.stringify({ summary, artifact: artifactPath, details, issues: [] })}[/AGENT-001_OUTPUT]`,
    JSON.stringify({
      current_unit: 'AGENT-001',
      tool_name: 'write_file',
      arguments: {
        path: artifactPath,
        content: `# ${summary}\n`,
      },
    }),
    JSON.stringify({
      current_unit: 'AGENT-001',
      status: 'COMPLETE',
      progress_percent: 100,
      decision: 'CONTINUE',
      reason: 'done',
      files_created: [artifactPath],
    }),
  ].join('\n');
}

function createSimpleAnalyzeOutput(summary, details) {
  return [
    `[AGENT-001_OUTPUT]${JSON.stringify({ summary, details, issues: [] })}[/AGENT-001_OUTPUT]`,
    JSON.stringify({
      current_unit: 'AGENT-001',
      status: 'COMPLETE',
      progress_percent: 100,
      decision: 'CONTINUE',
      reason: 'done',
      files_created: [],
    }),
  ].join('\n');
}

async function captureScreenshot(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
}

async function injectGovernanceFixtures(params) {
  assertCondition(Boolean(BACKEND_ROOT_DIR), 'IMPROVEMENT_GOVERNANCE_AUDIT_BACKEND_ROOT_DIR is required.');
  const proposalsPath = path.join(BACKEND_ROOT_DIR, 'platform', 'improvements', 'proposals.json');
  const raw = await fs.readFile(proposalsPath, 'utf8');
  const proposals = JSON.parse(raw);
  const lessonProposal = proposals.find((proposal) => proposal.proposalId === params.lessonProposalId);
  assertCondition(Boolean(lessonProposal), `Could not find lesson proposal ${params.lessonProposalId} for governance injection.`);

  const duplicateProposalId = `proposal_duplicate_${params.secondTaskId}`;
  const conflictProposalId = `proposal_conflict_${params.secondTaskId}`;
  const now = Date.now();

  const duplicateProposal = {
    ...lessonProposal,
    proposalId: duplicateProposalId,
    taskId: params.secondTaskId,
    title: `${lessonProposal.title} duplicate`,
    summary: 'Synthetic duplicate proposal kept only for governance-surface validation.',
    evidenceTaskIds: [params.secondTaskId],
    createdAt: now,
    updatedAt: now,
    dedupeKey: `${lessonProposal.dedupeKey}-manual-duplicate`,
    duplicateOfProposalId: lessonProposal.proposalId,
    conflictsWithProposalIds: [],
    supersededByProposalId: null,
    reviewScore: 0.54,
    metadata: {
      ...(lessonProposal.metadata ?? {}),
      injectedBy: 'improvement-governance-audit',
      governanceKind: 'duplicate',
    },
  };

  const conflictProposal = {
    ...lessonProposal,
    proposalId: conflictProposalId,
    taskId: params.secondTaskId,
    title: `${lessonProposal.title} conflict`,
    summary: 'Synthetic conflicting lesson kept only for governance-surface validation.',
    evidenceTaskIds: [params.secondTaskId],
    createdAt: now + 1,
    updatedAt: now + 1,
    dedupeKey: `${lessonProposal.dedupeKey}-manual-conflict`,
    duplicateOfProposalId: null,
    conflictsWithProposalIds: [lessonProposal.proposalId],
    supersededByProposalId: null,
    reviewScore: 0.58,
    experienceReport: {
      ...lessonProposal.experienceReport,
      lifecycleStatus: 'FAILED',
      outcome: 'failed',
      failureTaxonomy: ['runtime_error'],
      summary: 'Synthetic conflicting failure evidence for governance validation.',
    },
    lessonProposal: {
      ...lessonProposal.lessonProposal,
      lessonSummary: 'Synthetic conflicting lesson used to verify conflict governance states.',
      confidence: 0.49,
    },
    metadata: {
      ...(lessonProposal.metadata ?? {}),
      injectedBy: 'improvement-governance-audit',
      governanceKind: 'conflict',
    },
  };

  lessonProposal.conflictsWithProposalIds = [...new Set([...(lessonProposal.conflictsWithProposalIds ?? []), conflictProposalId])];
  proposals.push(duplicateProposal, conflictProposal);
  await fs.writeFile(proposalsPath, JSON.stringify(proposals, null, 2));
  return { duplicateProposalId, conflictProposalId };
}

async function main() {
  const executablePath = resolveChromeExecutable();
  assertCondition(Boolean(executablePath), 'Chrome executable not found for improvement governance audit.');

  await patchConfig({ tools: { permissionMode: 'full' } });
  await ensureMockProvider();
  await resetMockProvider([
    createImplementOutput(
      'Prepared governance checklist alpha.',
      'Governance checklist alpha is ready for archive eligibility.',
      'reports/governance-alpha.md',
    ),
    createImplementOutput(
      'Prepared governance checklist beta.',
      'Governance checklist beta repeats the same lesson pattern.',
      'reports/governance-beta.md',
    ),
    createSimpleAnalyzeOutput(
      'Simple terminal note.',
      'This task should stay out of the durable archive because it is not complex enough.',
    ),
  ]);

  const complexPayload = {
    preferredProviderId: 'mock-e2e',
    units: [{
      id: 'AGENT-001',
      role: 'Writer',
      goal: 'Create a reusable governance checklist artifact.',
      outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
      executionProfileId: 'implement',
      dependencies: [],
    }],
  };

  const firstTaskId = await submitTask({
    title: 'Governance audit alpha',
    intent: 'Create the first governance checklist artifact.',
    ...complexPayload,
  });
  assertCondition(Boolean(firstTaskId), 'Failed to create the first governance task.');
  await startTask(firstTaskId, 'Create the first governance checklist artifact.');
  await waitFor(async () => {
    const task = await getTask(firstTaskId);
    return task.runtime?.lifecycleStatus === 'COMPLETED' ? task : null;
  }, { errorMessage: 'Timed out waiting for the first governance task to complete.' });

  const firstLesson = await waitFor(async () => {
    const proposals = await listProposals();
    return proposals.find((proposal) => proposal.taskId === firstTaskId && proposal.kind === 'lesson') ?? null;
  }, { errorMessage: 'Timed out waiting for the first lesson proposal.' });
  await approveProposal(firstLesson.proposalId);

  const secondTaskId = await submitTask({
    title: 'Governance audit beta',
    intent: 'Repeat the same governance checklist pattern.',
    ...complexPayload,
  });
  assertCondition(Boolean(secondTaskId), 'Failed to create the second governance task.');
  await startTask(secondTaskId, 'Repeat the governance checklist pattern.');

  const mergedLesson = await waitFor(async () => {
    const proposals = await listProposals();
    const proposal = proposals.find((entry) => entry.proposalId === firstLesson.proposalId);
    return proposal && proposal.evidenceTaskIds.includes(firstTaskId) && proposal.evidenceTaskIds.includes(secondTaskId)
      ? proposal
      : null;
  }, { errorMessage: 'Timed out waiting for duplicate lesson evidence to merge into the approved lesson.' });

  const lessonMemory = await waitFor(async () => {
    const memories = await listMemories();
    return memories.find((memory) => (
      memory.metadata?.layer === 'lesson'
      && memory.metadata?.dedupeKey === mergedLesson.dedupeKey
      && Array.isArray(memory.metadata?.evidenceTaskIds)
      && memory.metadata.evidenceTaskIds.includes(firstTaskId)
      && memory.metadata.evidenceTaskIds.includes(secondTaskId)
    )) ?? null;
  }, { errorMessage: 'Timed out waiting for merged lesson evidence to reach lesson memory.' });

  const simpleTaskId = await submitTask({
    title: 'Governance audit simple terminal task',
    intent: 'Produce a simple summary that should not enter the durable archive.',
    preferredProviderId: 'mock-e2e',
    units: [{
      id: 'AGENT-001',
      role: 'Analyst',
      goal: 'Create a simple note without delivery or tool activity.',
      outputContract: '{"summary":"string","details":"string","issues":[]}',
      executionProfileId: 'analyze',
      dependencies: [],
    }],
  });
  assertCondition(Boolean(simpleTaskId), 'Failed to create the simple terminal governance task.');
  await startTask(simpleTaskId, 'Produce a simple summary only.');
  const simpleTask = await waitFor(async () => {
    const task = await getTask(simpleTaskId);
    return task.runtime?.lifecycleStatus === 'COMPLETED' ? task : null;
  }, { errorMessage: 'Timed out waiting for the simple terminal task to complete.' });

  assertCondition(simpleTask.realTaskArchiveStatus?.eligible === false, 'Simple terminal task should not be archive eligible.');
  assertCondition(simpleTask.realTaskArchiveStatus?.reason === 'not_complex_enough', `Simple terminal task should be skipped for not_complex_enough. Status=${JSON.stringify(simpleTask.realTaskArchiveStatus)}`);
  assertCondition((await listArchive()).every((entry) => entry.taskId !== simpleTaskId), 'Simple terminal task leaked into the durable archive.');

  const injected = await injectGovernanceFixtures({
    lessonProposalId: mergedLesson.proposalId,
    secondTaskId,
  });

  const report = await waitFor(async () => {
    const value = await getReport();
    return value.duplicateProposalCount >= 1 && value.conflictedProposalCount >= 1 ? value : null;
  }, { errorMessage: 'Timed out waiting for governance counters to surface duplicate/conflict proposals.' });

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const screenshots = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

    await page.goto(`${BASE_URL}/tasks?task=${simpleTaskId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="tasks-page"]');
    await page.waitForSelector('[data-testid="task-proposal-note"]');
    await page.getByText('No durable proposals generated for this simple terminal task.', { exact: true }).waitFor();
    assertCondition(await page.locator('[data-testid="task-proposal-lesson"]').count() === 0, 'Simple terminal task should not render a durable lesson proposal card.');
    screenshots.simpleTask = await captureScreenshot(page, 'simple-terminal-task');

    await page.goto(`${BASE_URL}/settings/improvements`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="settings-page"]');
    await page.waitForSelector('[data-testid="settings-improvements-filter-conflicted"]');
    await page.waitForSelector(`[data-testid="settings-improvement-${mergedLesson.proposalId}"]`);
    screenshots.default = await captureScreenshot(page, 'improvements-default');

    await page.click('[data-testid="settings-improvements-filter-conflicted"]');
    await page.waitForTimeout(300);
    await page.waitForSelector(`[data-testid="settings-improvement-${injected.conflictProposalId}"]`);
    screenshots.conflicted = await captureScreenshot(page, 'improvements-conflicted');

    await page.click('[data-testid="settings-improvements-filter-duplicates"]');
    await page.waitForTimeout(300);
    await page.waitForSelector(`[data-testid="settings-improvement-${injected.duplicateProposalId}"]`);
    screenshots.duplicates = await captureScreenshot(page, 'improvements-duplicates');

    await page.click('[data-testid="settings-improvements-filter-archive-eligible"]');
    await page.waitForTimeout(300);
    await page.waitForSelector(`[data-testid="settings-improvement-${mergedLesson.proposalId}"]`);
    screenshots.archiveEligible = await captureScreenshot(page, 'improvements-archive-eligible');
  } finally {
    await browser.close();
  }

  const finalProposals = await listProposals();
  const finalMemories = await listMemories();
  const finalLessonMemory = finalMemories.find((memory) => memory.metadata?.dedupeKey === mergedLesson.dedupeKey) ?? null;

  const output = {
    generatedAt: new Date().toISOString(),
    status: 'achieved',
    archiveEligibility: {
      complexTaskArchived: true,
      simpleTaskSkipped: true,
      simpleTaskReason: simpleTask.realTaskArchiveStatus?.reason ?? null,
    },
    duplicateLessonMerge: {
      proposalId: mergedLesson.proposalId,
      evidenceTaskIds: mergedLesson.evidenceTaskIds,
      lessonMemoryId: lessonMemory.memoryId,
    },
    governanceFlags: {
      duplicateProposalId: injected.duplicateProposalId,
      conflictProposalId: injected.conflictProposalId,
      duplicateProposalCount: report.duplicateProposalCount,
      conflictedProposalCount: report.conflictedProposalCount,
    },
    proposalInventory: {
      total: finalProposals.length,
      archiveEligible: finalProposals.filter((proposal) => proposal.archiveEligible).length,
    },
    lessonMemory: {
      count: finalMemories.filter((memory) => memory.metadata?.layer === 'lesson').length,
      evidenceTaskIds: finalLessonMemory?.metadata?.evidenceTaskIds ?? [],
    },
    screenshots,
  };

  await writeReport(output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(async (error) => {
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'open_gap',
    error: error instanceof Error ? error.message : String(error),
  };
  try {
    await writeReport(report);
  } catch {
    // ignore write failures in fallback path
  }
  console.error(error.stack ?? error.message);
  process.exit(1);
});
