import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BACKEND_URL = process.env.LESSON_MEMORY_DEDUPE_AUDIT_BACKEND_URL ?? 'http://127.0.0.1:3941';
const MOCK_PROVIDER_URL = process.env.LESSON_MEMORY_DEDUPE_AUDIT_MOCK_PROVIDER_URL ?? 'http://127.0.0.1:4341';
const REPORT_PATH = process.env.LESSON_MEMORY_DEDUPE_AUDIT_REPORT
  ?? path.resolve(process.cwd(), '.codex-run', 'logs', 'lesson-memory-dedupe-audit.json');

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
      label: 'Mock Lesson Memory Provider',
      vendor: 'custom',
      transport: 'openai-compatible',
      baseUrl: `${MOCK_PROVIDER_URL}/v1`,
      model: 'mock-lesson-memory-model',
      auth: { scheme: 'none' },
      metadata: { variantId: 'lesson-memory-dedupe-audit' },
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

async function listMemories() {
  return requestJson(`${BACKEND_URL}/memories`);
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

async function main() {
  await patchConfig({ tools: { permissionMode: 'full' } });
  await ensureMockProvider();
  await resetMockProvider([
    createImplementOutput(
      'Prepared reusable lesson alpha.',
      'Reusable lesson alpha is ready.',
      'reports/lesson-alpha.md',
    ),
    createImplementOutput(
      'Prepared reusable lesson beta.',
      'Reusable lesson beta repeats the same pattern.',
      'reports/lesson-beta.md',
    ),
  ]);

  const payload = {
    preferredProviderId: 'mock-e2e',
    units: [{
      id: 'AGENT-001',
      role: 'Writer',
      goal: 'Create a reusable lesson artifact.',
      outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
      executionProfileId: 'implement',
      dependencies: [],
    }],
  };

  const firstTaskId = await submitTask({
    title: 'Lesson memory alpha',
    intent: 'Create the first lesson candidate.',
    ...payload,
  });
  assertCondition(Boolean(firstTaskId), 'Failed to create the first lesson-memory task.');
  await startTask(firstTaskId, 'Create the first reusable lesson artifact.');
  await waitFor(async () => {
    const task = await getTask(firstTaskId);
    return task.runtime?.lifecycleStatus === 'COMPLETED' ? task : null;
  }, { errorMessage: 'Timed out waiting for the first lesson-memory task.' });

  const lessonProposal = await waitFor(async () => {
    const proposals = await listProposals();
    return proposals.find((proposal) => proposal.taskId === firstTaskId && proposal.kind === 'lesson') ?? null;
  }, { errorMessage: 'Timed out waiting for the first lesson proposal.' });

  await approveProposal(lessonProposal.proposalId);
  const firstMemoryState = await waitFor(async () => {
    const memories = await listMemories();
    return memories.find((memory) => (
      memory.metadata?.layer === 'lesson'
      && memory.metadata?.dedupeKey === lessonProposal.dedupeKey
      && Array.isArray(memory.metadata?.evidenceTaskIds)
      && memory.metadata.evidenceTaskIds.includes(firstTaskId)
    )) ?? null;
  }, { errorMessage: 'Timed out waiting for the approved lesson memory.' });

  const secondTaskId = await submitTask({
    title: 'Lesson memory beta',
    intent: 'Repeat the same lesson candidate so evidence can merge.',
    ...payload,
  });
  assertCondition(Boolean(secondTaskId), 'Failed to create the second lesson-memory task.');
  await startTask(secondTaskId, 'Repeat the same lesson pattern.');

  const mergedProposal = await waitFor(async () => {
    const proposals = await listProposals();
    const proposal = proposals.find((entry) => entry.proposalId === lessonProposal.proposalId);
    return proposal
      && proposal.status === 'APPROVED'
      && proposal.evidenceTaskIds.includes(firstTaskId)
      && proposal.evidenceTaskIds.includes(secondTaskId)
      ? proposal
      : null;
  }, { errorMessage: 'Timed out waiting for the approved lesson proposal to merge second-task evidence.' });

  const mergedMemory = await waitFor(async () => {
    const memories = await listMemories();
    return memories.find((memory) => (
      memory.metadata?.layer === 'lesson'
      && memory.metadata?.dedupeKey === lessonProposal.dedupeKey
      && Array.isArray(memory.metadata?.evidenceTaskIds)
      && memory.metadata.evidenceTaskIds.includes(firstTaskId)
      && memory.metadata.evidenceTaskIds.includes(secondTaskId)
    )) ?? null;
  }, { errorMessage: 'Timed out waiting for merged evidence to flow into lesson memory.' });

  await approveProposal(lessonProposal.proposalId);
  const finalMemories = await listMemories();
  const lessonMemories = finalMemories.filter((memory) => memory.metadata?.layer === 'lesson');

  assertCondition(lessonMemories.length === 1, `Lesson memory dedupe should keep exactly one lesson memory record. Found=${lessonMemories.length}`);
  assertCondition(mergedMemory.memoryId === firstMemoryState.memoryId, 'Merged lesson evidence should update the existing lesson memory record instead of creating a new one.');

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'achieved',
    proposalId: lessonProposal.proposalId,
    lessonMemoryId: mergedMemory.memoryId,
    evidenceTaskIds: mergedProposal.evidenceTaskIds,
    lessonMemoryEvidenceTaskIds: mergedMemory.metadata?.evidenceTaskIds ?? [],
    lessonMemoryCount: lessonMemories.length,
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
    // ignore report write failures in fallback path
  }
  console.error(error.stack ?? error.message);
  process.exit(1);
});
