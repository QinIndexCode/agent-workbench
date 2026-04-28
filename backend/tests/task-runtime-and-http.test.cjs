const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyToolInvocationTransition,
  ProviderHttpError,
  applyLifecycleTransition,
  createBackendNewFoundation,
  createBackendNewHttpServer,
  createBackendNewRuntime,
  createTaskRuntimeState,
  createToolInvocationRecord,
  createToolFailureResult,
  createToolSuccessResult
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

function registerProvider(foundation, responses) {
  const queue = [...responses];
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    baseUrl: 'https://provider.example.com',
    model: 'mock-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete() {
      const next = queue.shift();
      if (!next) {
        throw new Error('No mock provider response queued.');
      }
      return {
        responseId: `resp_${Date.now()}`,
        providerId: 'provider-main',
        model: 'mock-model',
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20
        },
        metadata: {}
      };
    }
  });
}

function registerProviderHandler(foundation, handler) {
  foundation.providers.register({
    id: 'provider-main',
    label: 'Provider Main',
    transport: 'openai-compatible',
    baseUrl: 'https://provider.example.com',
    model: 'mock-model'
  });
  foundation.providerClients.register('provider-main', {
    async complete(request) {
      return handler(request);
    }
  });
}

function createRuntimeWithFoundation(options) {
  const foundation = createBackendNewFoundation(options);
  const runtime = createBackendNewRuntime({ foundation });
  return { foundation, runtime };
}

function createTaskInput(units) {
  return {
    title: 'Test Task',
    intent: 'Verify backend_new task core.',
    preferredProviderId: 'provider-main',
    units
  };
}

function createReusableChecklistPayload(overrides = {}) {
  return {
    title: 'Reusable checklist task',
    intent: 'Create a reusable checklist artifact',
    preferredProviderId: 'provider-main',
    units: [
      {
        id: 'AGENT-001',
        role: 'Writer',
        goal: 'Create a reusable checklist artifact',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        executionProfileId: 'implement',
        dependencies: []
      }
    ],
    ...overrides
  };
}

function buildChecklistSuccessResponse(name) {
  return `[AGENT-001_OUTPUT]{"summary":"Prepared reusable checklist ${name}.","artifact":"reports/checklist-${name}.md","details":"Checklist ${name} is ready.","issues":[]}` + '[/AGENT-001_OUTPUT]\n'
    + `{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/checklist-${name}.md","content":"# Checklist ${name}\\n"}}\n`
    + `{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/checklist-${name}.md"]}`;
}

function buildChecklistSuccessResponseWithFolder(name) {
  return `[AGENT-001_OUTPUT]{"summary":"Prepared reusable checklist ${name}.","artifact":"reports/checklist-${name}.md","details":"Checklist ${name} is ready.","issues":[]}` + '[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","tool_name":"create_folder","arguments":{"path":"reports"}}\n'
    + `{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/checklist-${name}.md","content":"# Checklist ${name}\\n"}}\n`
    + `{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/checklist-${name}.md"]}`;
}

function buildChecklistFailureResponse(name) {
  return `[AGENT-001_OUTPUT]{"summary":"Checklist ${name} failed.","artifact":"","details":"Conflicting evidence blocked this attempt.","issues":["conflict"]}` + '[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"FAILED","progress_percent":100,"decision":"CONTINUE","reason":"conflict detected","files_created":[]}';
}

test('applyLifecycleTransition marks CANCELLED runtimes as interrupted and inactive', () => {
  const definition = {
    taskId: 'task_cancelled_transition',
    title: 'Cancelled transition',
    intent: 'Verify cancelled state transition.',
    preferredProviderId: 'provider-main',
    units: [
      { id: 'AGENT-001', role: 'Closer', goal: 'Close', dependencies: [] }
    ]
  };
  const runtime = createTaskRuntimeState(definition, Date.now());
  const cancelled = applyLifecycleTransition({
    ...runtime,
    engineStatus: 'RUNNING',
    executionLease: {
      ...runtime.executionLease,
      active: true,
      phase: 'ACTIVE'
    }
  }, 'CANCELLED');

  assert.equal(cancelled.lifecycleStatus, 'CANCELLED');
  assert.equal(cancelled.engineStatus, 'FAILED');
  assert.equal(cancelled.executionLease.phase, 'INTERRUPTED');
  assert.equal(cancelled.executionLease.active, false);
});

test('task application runs multi-unit task sequentially to completion', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"plan","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}',
      '[AGENT-002_OUTPUT]{"summary":"build","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Planner', goal: 'Plan the work', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-002', role: 'Builder', goal: 'Build the work', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: ['AGENT-001'] }
    ]));
const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
const completed = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.currentUnitId, 'AGENT-002');
    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(completed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(completed.task.runtime.currentUnitId, null);
    assert.deepEqual(completed.task.runtime.completedUnits, ['AGENT-001', 'AGENT-002']);
  } finally {
    removeDir(root);
  }
});

test('analyze profile rejects write or command-style tools even if provider emits them', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"analysis complete","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"tool":"run_command","command":"npm test"}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"analysis done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Analyst',
        goal: 'Inspect the workspace only',
        outputContract: '{"summary":"string","issues":[]}',
        executionProfileId: 'analyze',
        dependencies: []
      }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(started.task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'tool_action_required_but_not_emitted');
    assert.equal(started.task.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_TOOL_ACTION');
    assert.equal(started.task.toolInvocations.length, 0);
  } finally {
    removeDir(root);
  }
});

test('task application honors prune and early terminate tracker decisions', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"plan","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"PRUNE_REMAINING","reason":"skip rest","files_created":[]}',
      '[AGENT-010_OUTPUT]{"summary":"finish early","issues":[]}[/AGENT-010_OUTPUT]\n'
        + '{"current_unit":"AGENT-010","status":"COMPLETE","progress_percent":100,"decision":"EARLY_TERMINATE","reason":"enough","files_created":[]}'
    ]);

const pruned = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Planner', goal: 'Plan', outputContract: '{"summary":"string","issues":[]}', dependencies: [] },
      { id: 'AGENT-002', role: 'Builder', goal: 'Build', outputContract: '{"summary":"string","issues":[]}', dependencies: ['AGENT-001'] },
      { id: 'AGENT-003', role: 'Verifier', goal: 'Verify', outputContract: '{"summary":"string","issues":[]}', dependencies: ['AGENT-002'] }
    ]));
const prunedStarted = await runtime.tasks.startTask({ taskId: pruned.command.taskId });
    assert.equal(prunedStarted.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.deepEqual(prunedStarted.task.runtime.completedUnits, ['AGENT-001']);
    assert.deepEqual(prunedStarted.task.runtime.skippedUnits, ['AGENT-002', 'AGENT-003']);

const early = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-010', role: 'Closer', goal: 'Close', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const earlyStarted = await runtime.tasks.startTask({ taskId: early.command.taskId });
    assert.equal(earlyStarted.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(earlyStarted.task.runtime.currentUnitId, null);
  } finally {
    removeDir(root);
  }
});

test('task application accepts terminate-style tracker aliases from live providers', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"finish","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"TERMINATE","reason":"done","next_unit":null,"files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const conversations = await foundation.conversations.list(submitted.command.taskId);
    const publicAssistantSummaries = conversations.filter(
      (message) => message.role === 'assistant' && message.visibility === 'public' && message.metadata?.source === 'assistant_summary'
    );
    const internalProviderResponses = conversations.filter(
      (message) => message.role === 'assistant' && message.visibility === 'internal' && message.metadata?.source === 'provider_response'
    );

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(started.task.runtime.currentUnitId, null);
    assert.equal(started.task.latestVisibleOutput?.summary, 'finish');
    assert.equal(publicAssistantSummaries.length, 0);
    assert.equal(internalProviderResponses.length, 1);
    assert.match(internalProviderResponses[0].content, /\[AGENT-001_OUTPUT\]/);
  } finally {
    removeDir(root);
  }
});

test('successful turns persist clarification summaries as public assistant notes while keeping raw provider output internal', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Need the target audience before drafting.","details":"The request is missing the audience, desired length, and publishing channel.","issues":["target audience","desired length","publishing channel"]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"clarification captured","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Clarifier', goal: 'Clarify missing request context', outputContract: '{"summary":"string","details":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const conversations = await foundation.conversations.list(submitted.command.taskId);
    const publicClarification = conversations.find(
      (message) => message.role === 'assistant'
        && message.visibility === 'public'
        && message.metadata?.source === 'assistant_summary'
        && message.metadata?.displayKind === 'clarification'
    );
    const internalProviderResponse = conversations.find(
      (message) => message.role === 'assistant'
        && message.visibility === 'internal'
        && message.metadata?.source === 'provider_response'
    );
    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.match(publicClarification?.content ?? '', /need more context/i);
    assert.equal(task.conversations.some((message) => message.metadata?.source === 'provider_response'), false);
    assert.equal(task.conversations.some((message) => message.metadata?.source === 'assistant_summary'), true);
    assert.match(task.latestVisibleOutput?.summary ?? '', /Need the target audience/i);
    assert.match(internalProviderResponse?.content ?? '', /\[AGENT-001_OUTPUT\]/);
    assert.equal(debug.task.conversations.some((message) => message.metadata?.source === 'provider_response'), true);
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'passed');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'analyze');
    assert.equal(debug.executionSummary.acceptance.evidence.toolEvidence.required, false);
    assert.equal(debug.executionSummary.acceptance.semanticReview.status, 'not_requested');
  } finally {
    removeDir(root);
  }
});

test('implement profile requires persistent evidence in layered acceptance truth', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"implementation summary","details":"No file changes were produced.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Implementer',
        goal: 'Implement the requested change',
        executionProfileId: 'implement',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'artifact_write_required_but_not_emitted');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastCorrectionPromptMode, 'TARGETED_TOOL_ACTION');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'implement');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'failed');
    assert.equal(debug.executionSummary.acceptance.evidence.artifactEvidence.required, true);
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('missing_persistent_effect_evidence'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.outcome.failedChecks.includes('implement_outcome_not_materialized'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('verify profile requires successful verification evidence in layered acceptance truth', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"verification summary","details":"No real verification command ran.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Verifier',
        goal: 'Verify the result',
        executionProfileId: 'verify',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'tool_action_required_but_not_emitted');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastCorrectionPromptMode, 'TARGETED_TOOL_ACTION');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'verify');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'failed');
    assert.equal(debug.executionSummary.acceptance.evidence.toolEvidence.required, true);
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('missing_verification_evidence'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.outcome.failedChecks.includes('verification_outcome_not_demonstrated'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('implement profile exposes deterministic artifact gaps when only create_folder evidence exists', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"prepared report shell","details":"Created only the parent folder so far.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"create_folder","arguments":{"path":"reports"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"folder created","files_created":["reports/report.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Implementer',
        goal: 'Deliver the report artifact',
        executionProfileId: 'implement',
        outputContract: '{"summary":"string","report":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'artifact_write_required_but_not_emitted');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.task.runtime.contractDiagnostics?.lastCorrectionPromptMode, 'TARGETED_TOOL_ACTION');
    assert.match(
      debug.task.runtime.schedulerUnits['AGENT-001']?.invalidOutputErrors.join('\n') ?? '',
      /persistent write|matching write evidence/i
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('missing_persistent_effect_evidence'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.execution.failedChecks.includes('missing_progress_tracker'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('query reconciliation keeps tool-action correction when implement turn only has successful read evidence', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '{"current_unit":"AGENT-001","tool_name":"read_file","arguments":{"path":"source/input.md"}}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Implementer',
        goal: 'Produce a repo-grounded follow-up artifact',
        executionProfileId: 'implement',
        outputContract: '{"summary":"string","report":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    const workspaceDir = foundation.layout.forTask(submitted.command.taskId).workspaceDir;
    fs.mkdirSync(path.join(workspaceDir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'source', 'input.md'), '# Input\nConcrete repo follow-up needed.\n', 'utf8');

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const fetchedTask = await runtime.tasks.getTask(submitted.command.taskId);
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(fetchedTask.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(fetchedTask.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(fetchedTask.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'artifact_write_required_but_not_emitted');
    assert.equal(fetchedTask.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_TOOL_ACTION');
    assert.equal(fetchedTask.runtime.contractDiagnostics?.lastCorrectionPromptMode, 'TARGETED_TOOL_ACTION');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('missing_persistent_effect_evidence'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.execution.failedChecks.includes('missing_progress_tracker'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('verify profile accepts successful verification-oriented run_command evidence in layered acceptance truth', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '{"current_unit":"AGENT-001","tool_name":"run_command","arguments":{"command":"node --version"}}\n'
        + '[AGENT-001_OUTPUT]{"summary":"verification summary","details":"Executed node --version as a real verification command.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":80,"decision":"CONTINUE","reason":"verification command executed; waiting to ground final output","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"verification summary","details":"Grounded by the successful node --version run_command result.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Verifier',
        goal: 'Verify the result',
        executionProfileId: 'verify',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.task.runtime.pendingCorrection, 'NONE');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'verify');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'passed');
    assert.equal(debug.executionSummary.acceptance.evidence.toolEvidence.required, true);
    assert.equal(debug.executionSummary.acceptance.evidence.toolEvidence.verificationCount > 0, true);
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('missing_verification_evidence'),
      false
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.outcome.failedChecks.includes('verification_outcome_not_demonstrated'),
      false
    );
  } finally {
    removeDir(root);
  }
});

test('quality-gated verify tasks treat earlier failed probes as resolved after later grounded evidence passes', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    let taskId = null;
    let callCount = 0;
    registerProviderHandler(foundation, async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          responseId: 'resp_failed_probe',
          providerId: 'provider-main',
          model: 'mock-model',
          outputText: '{"tool":"run_command","arguments":{"command":"definitely_missing_command_scc"}}\n'
            + '[AGENT-001_OUTPUT]{"summary":"started","details":"Initial probe failed and needs replacement evidence.","issues":["probe failed"]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":30,"decision":"CONTINUE","reason":"replace failed probe with grounded evidence","files_created":[]}',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          metadata: {}
        };
      }
      if (callCount === 2) {
        return {
          responseId: 'resp_successful_probe',
        providerId: 'provider-main',
        model: 'mock-model',
        outputText: '{"tool":"run_command","arguments":{"command":"Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 @{N=\\\"HealthValue\\\";E={42}} | Format-List"}}\n'
          + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":70,"decision":"CONTINUE","reason":"successful replacement evidence is available","files_created":[]}',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          metadata: {}
        };
      }
      if (callCount > 3) {
        return {
          responseId: 'resp_finalized',
          providerId: 'provider-main',
          model: 'mock-model',
          outputText: '[AGENT-001_OUTPUT]{"summary":"quality passed","details":"Grounded by HealthValue=42 replacement evidence.","issues":[]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"grounded quality evidence passed","files_created":["reports/system-health.md","quality/system-audit.json"]}',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          metadata: {}
        };
      }
      const task = await runtime.tasks.getTask(taskId);
      const evidence = task.toolInvocations.find((invocation) => (
        invocation.toolId === 'run_command'
        && invocation.status === 'SUCCEEDED'
        && JSON.stringify(invocation.result ?? invocation.metadata ?? {}).includes('HealthValue')
      ));
      assert.ok(evidence, 'expected successful replacement evidence before final quality write');
      return {
        responseId: 'resp_quality_pass',
        providerId: 'provider-main',
        model: 'mock-model',
        outputText: '{"tool":"write_file","arguments":{"path":"reports/system-health.md","content":"# System Health\\nHealthValue=42\\n"}}\n'
          + `{"tool":"write_file","arguments":{"path":"quality/system-audit.json","content_json":{"profile":"system_audit","reportFile":"reports/system-health.md","facts":[{"name":"health_value","reportedValue":42,"sourceInvocationId":"${evidence.invocationId}","sourceContains":["HealthValue : 42"]}]}}}\n`
          + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":90,"decision":"CONTINUE","reason":"quality evidence files written; ready to finalize","files_created":["reports/system-health.md","quality/system-audit.json"]}',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        metadata: {}
      };
    });

    const taskInput = createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Verifier',
        goal: 'Verify with quality evidence',
        executionProfileId: 'verify',
        qualityProfileId: 'system_audit',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]);
    taskInput.metadata = {
      artifactRouting: {
        pathPolicy: 'task_workspace',
        artifactApplyMode: 'sandbox_then_apply'
      }
    };
    const submitted = await runtime.tasks.submitTask(taskInput);
    taskId = submitted.command.taskId;

    await runtime.tasks.startTask({ taskId });
    await runtime.tasks.continueTask({ taskId });
    await runtime.tasks.continueTask({ taskId });
    await runtime.tasks.continueTask({ taskId });
    const debug = await runtime.tasks.getTaskDebug(taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.acceptance.quality.verdict, 'passed');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'passed');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('known_verification_failure'),
      false
    );
  } finally {
    removeDir(root);
  }
});

test('implement profile ignores passive read verification failures after persistent write evidence succeeds', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'path', type: 'string', required: true },
        { name: 'content', type: 'string', required: true }
      ]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            bytesWritten: 2
          }
        });
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"implemented","artifact":"report.md","details":"wrote the report","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"ok"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["report.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Implementer',
        goal: 'Implement the requested change',
        executionProfileId: 'implement',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const base = createToolInvocationRecord({
      correlationId: 'corr_passive_read_failure',
      sessionId: 'sess_passive_read_failure',
      turnId: 'turn_passive_read_failure',
      checkpointId: 'chk_passive_read_failure',
      request: {
        taskId: submitted.command.taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: 'report.md'
        }
      },
      startedAt: Date.now(),
      metadata: {
        source: 'test',
        verification: true
      }
    });
    const running = applyToolInvocationTransition(base, {
      type: 'START',
      timestamp: base.startedAt + 1
    });
    const failed = applyToolInvocationTransition(running, {
      type: 'FAIL',
      timestamp: base.startedAt + 2,
      result: createToolFailureResult({
        kind: 'NOT_FOUND',
        message: 'report.md was not available yet'
      })
    });
    await foundation.toolInvocations.append(base);
    await foundation.toolInvocations.append(running);
    await foundation.toolInvocations.append(failed);

    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'implement');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'passed');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('known_verification_failure'),
      false
    );
  } finally {
    removeDir(root);
  }
});

test('verify profile treats a failed read_file as resolved after the same path is read successfully', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"verified","artifact":"src/slugify.cjs","details":"verification finished","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Verifier',
        goal: 'Verify the requested file',
        executionProfileId: 'verify',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const failedBase = createToolInvocationRecord({
      correlationId: 'corr_verify_read_failure',
      sessionId: 'sess_verify_read_failure',
      turnId: 'turn_verify_read_failure',
      checkpointId: 'chk_verify_read_failure',
      request: {
        taskId: submitted.command.taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: 'src/slugify.cjs'
        }
      },
      startedAt: Date.now(),
      metadata: {
        source: 'test',
        verification: true
      }
    });
    const failedRunning = applyToolInvocationTransition(failedBase, {
      type: 'START',
      timestamp: failedBase.startedAt + 1
    });
    const failed = applyToolInvocationTransition(failedRunning, {
      type: 'FAIL',
      timestamp: failedBase.startedAt + 2,
      result: createToolFailureResult({
        kind: 'NOT_FOUND',
        message: 'src/slugify.cjs was not available yet'
      })
    });

    const successBase = createToolInvocationRecord({
      correlationId: 'corr_verify_read_success',
      sessionId: 'sess_verify_read_success',
      turnId: 'turn_verify_read_success',
      checkpointId: 'chk_verify_read_success',
      request: {
        taskId: submitted.command.taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: 'src/slugify.cjs'
        }
      },
      startedAt: failedBase.startedAt + 3,
      metadata: {
        source: 'test',
        verification: true
      }
    });
    const successRunning = applyToolInvocationTransition(successBase, {
      type: 'START',
      timestamp: successBase.startedAt + 1
    });
    const success = applyToolInvocationTransition(successRunning, {
      type: 'SUCCEED',
      timestamp: successBase.startedAt + 2,
      result: createToolSuccessResult({
        output: {
          path: 'src/slugify.cjs',
          content: 'module.exports = { slugify: (value) => String(value).toLowerCase() };'
        }
      })
    });

    for (const record of [failedBase, failedRunning, failed, successBase, successRunning, success]) {
      await foundation.toolInvocations.append(record);
    }
    const runtimeRecord = await foundation.taskRuntimes.get(submitted.command.taskId);
    assert.ok(runtimeRecord);
    await foundation.taskRuntimes.save(applyLifecycleTransition({
      ...runtimeRecord,
      currentUnitId: null,
      pendingCorrection: 'NONE',
      awaitingToolDispatch: [],
      awaitingApprovalInvocations: [],
      contractDiagnostics: runtimeRecord.contractDiagnostics
        ? {
          ...runtimeRecord.contractDiagnostics,
          lastAcceptanceFailureCategory: null,
          lastAcceptanceIssueCodes: [],
          lastAcceptanceIssueMessages: [],
          lastPendingCorrectionKind: null
        }
        : runtimeRecord.contractDiagnostics
    }, 'COMPLETED'));

    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.executionSummary.issueCategory, null);
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'verify');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('known_verification_failure'),
      false
    );
  } finally {
    removeDir(root);
  }
});

test('successful read_file invocations surface in visible tool activities', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"completed","details":"review finished","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Analyst',
        goal: 'Review the requested file',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const base = createToolInvocationRecord({
      correlationId: 'corr_surface_read_success',
      sessionId: 'sess_surface_read_success',
      turnId: 'turn_surface_read_success',
      checkpointId: 'chk_surface_read_success',
      request: {
        taskId: submitted.command.taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: 'brief/workload-profile.md'
        }
      },
      startedAt: Date.now(),
      metadata: {
        source: 'test',
      }
    });
    const running = applyToolInvocationTransition(base, {
      type: 'START',
      timestamp: base.startedAt + 1
    });
    const succeeded = applyToolInvocationTransition(running, {
      type: 'SUCCEED',
      timestamp: base.startedAt + 2,
      result: createToolSuccessResult({
        output: {
          path: 'brief/workload-profile.md',
          content: 'Target workload profile'
        }
      })
    });
    await foundation.toolInvocations.append(base);
    await foundation.toolInvocations.append(running);
    await foundation.toolInvocations.append(succeeded);

    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const surfaced = task.visibleToolActivities.find((activity) => activity.toolId === 'read_file' && activity.status === 'SUCCEEDED');

    assert.ok(surfaced);
    assert.match(surfaced.summary, /read file completed/i);
    assert.match(`${surfaced.detail ?? ''} ${surfaced.argumentsSummary ?? ''}`, /brief\/workload-profile\.md/i);
  } finally {
    removeDir(root);
  }
});

test('successful list and search invocations surface in visible tool activities', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"completed","details":"review finished","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Analyst',
        goal: 'Review workspace files',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    for (const [toolName, result] of [
      ['list_files', { path: 'incoming', files: ['incoming/a.md'] }],
      ['search_files', { query: 'release', matches: [{ path: 'incoming/a.md', line: 1 }] }]
    ]) {
      const base = createToolInvocationRecord({
        correlationId: `corr_surface_${toolName}`,
        sessionId: `sess_surface_${toolName}`,
        turnId: `turn_surface_${toolName}`,
        checkpointId: `chk_surface_${toolName}`,
        request: {
          taskId: submitted.command.taskId,
          unitId: 'AGENT-001',
          toolName,
          arguments: toolName === 'list_files' ? { path: 'incoming' } : { query: 'release' }
        },
        startedAt: Date.now(),
        metadata: {
          source: 'test',
        }
      });
      const running = applyToolInvocationTransition(base, {
        type: 'START',
        timestamp: base.startedAt + 1
      });
      const succeeded = applyToolInvocationTransition(running, {
        type: 'SUCCEED',
        timestamp: base.startedAt + 2,
        result: createToolSuccessResult({ output: result })
      });
      await foundation.toolInvocations.append(base);
      await foundation.toolInvocations.append(running);
      await foundation.toolInvocations.append(succeeded);
    }

    const task = await runtime.tasks.getTask(submitted.command.taskId);
    assert.ok(task.visibleToolActivities.some((activity) => activity.toolId === 'list_files' && activity.status === 'SUCCEEDED'));
    assert.ok(task.visibleToolActivities.some((activity) => activity.toolId === 'search_files' && activity.status === 'SUCCEEDED'));
  } finally {
    removeDir(root);
  }
});

test('implement profile still blocks on real verification command failures after write evidence succeeds', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'path', type: 'string', required: true },
        { name: 'content', type: 'string', required: true }
      ]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            bytesWritten: 2
          }
        });
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"implemented","artifact":"report.md","details":"wrote the report","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"ok"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["report.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Implementer',
        goal: 'Implement the requested change',
        executionProfileId: 'implement',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const base = createToolInvocationRecord({
      correlationId: 'corr_verification_failure',
      sessionId: 'sess_verification_failure',
      turnId: 'turn_verification_failure',
      checkpointId: 'chk_verification_failure',
      request: {
        taskId: submitted.command.taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command: 'npm test'
        }
      },
      startedAt: Date.now(),
      metadata: {
        source: 'test',
        verification: true
      }
    });
    const running = applyToolInvocationTransition(base, {
      type: 'START',
      timestamp: base.startedAt + 1
    });
    const failed = applyToolInvocationTransition(running, {
      type: 'FAIL',
      timestamp: base.startedAt + 2,
      result: createToolFailureResult({
        kind: 'PROCESS_EXIT',
        message: 'npm test failed',
        metadata: {
          command: 'npm test',
          effectiveCommand: 'npm test',
          cwd: root,
          exitCode: 1,
          stdout: 'started test run',
          stderr: 'one assertion failed',
          durationMs: 42,
          timedOut: false,
          shell: 'powershell'
        }
      })
    });
    await foundation.toolInvocations.append(base);
    await foundation.toolInvocations.append(running);
    await foundation.toolInvocations.append(failed);

    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.acceptance.deterministic.profileId, 'implement');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'failed');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.evidence.failedChecks.includes('known_verification_failure'),
      true
    );
    const surfacedCommand = debug.task.visibleToolActivities.find((activity) => activity.toolId === 'run_command');
    assert.ok(surfacedCommand);
    assert.equal(surfacedCommand.execution?.exitCode, 1);
    assert.match(surfacedCommand.execution?.stdout ?? '', /started test run/);
    assert.match(surfacedCommand.execution?.stderr ?? '', /one assertion failed/);
  } finally {
    removeDir(root);
  }
});

test('quality gate requests tool-action correction when new evidence files are required', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"handbook drafted","details":"handbook files are present","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Docs synth quality gate',
      intent: 'Synthesize docs with explicit source grounding.',
      preferredProviderId: 'provider-main',
      defaultQualityProfileId: 'docs_synthesize',
      units: [
        {
          id: 'AGENT-001',
          role: 'Synthesizer',
          goal: 'Produce handbook outputs',
          executionProfileId: 'analyze',
          qualityProfileId: 'docs_synthesize',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          dependencies: []
        }
      ]
    });

    const workspaceDir = foundation.layout.forTask(submitted.command.taskId).workspaceDir;
    fs.mkdirSync(path.join(workspaceDir, 'source'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'handbook'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'source', 'product-strategy.md'), '# Product Strategy\n- keep onboarding friction low\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'source', 'ops-decisions.md'), '# Ops Decisions\n- design system refresh\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'source', 'editorial-feedback.md'), '# Editorial Feedback\n- calm but memorable publishing workflow\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'handbook', 'README.md'), '# Handbook\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'handbook', 'index.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'handbook', 'summary.md'), '# Summary\n- keep onboarding friction low\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'handbook', 'decision-log.md'), '# Decision Log\n- design system refresh\n', 'utf8');

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(debug.executionSummary.acceptance.quality.profileId, 'docs_synthesize');
    assert.equal(debug.executionSummary.acceptance.quality.verdict, 'failed');
    assert.equal(
      debug.executionSummary.acceptance.quality.failedChecks.includes('missing_docs_synthesis_trace'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.quality.requiredNextEvidence.includes('write quality/docs-synthesize-trace.json with claim-level grounding'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('semantic review failures are advisory and do not change completed task lifecycle', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const now = Date.now();
    await foundation.apiKeys.save({
      id: 'provider-main-key',
      provider: 'provider-main',
      label: 'Provider Main Key',
      apiKey: 'test-key',
      createdAt: now,
      updatedAt: now,
      metadata: {}
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model',
      apiKeySecretId: 'provider-main-key'
    });
    foundation.providerClients.register('provider-main', {
      async complete(request) {
        if (request.metadata?.purpose === 'acceptance_semantic_review') {
          throw new Error('semantic review unavailable');
        }
        return {
          responseId: `resp_${Date.now()}`,
          providerId: 'provider-main',
          model: 'mock-model',
          outputText:
            '[AGENT-001_OUTPUT]{"summary":"completed","details":"Grounded summary.","issues":[]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20
          },
          metadata: {}
        };
      }
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Reviewer',
        goal: 'Finish with a grounded summary',
        executionProfileId: 'analyze',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'passed');
    assert.equal(debug.executionSummary.acceptance.semanticReview.status, 'unavailable');
    assert.match(debug.executionSummary.acceptance.semanticReview.error ?? '', /semantic review unavailable/i);
  } finally {
    removeDir(root);
  }
});

test('task submission rejects invalid topology before runtime state is created', async () => {
  const root = createTempRoot();
  try {
    const { runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    await assert.rejects(
() => runtime.tasks.submitTask(createTaskInput([
        { id: 'AGENT-001', role: 'A', goal: 'A', dependencies: ['AGENT-002'] },
        { id: 'AGENT-002', role: 'B', goal: 'B', dependencies: ['AGENT-001'] }
      ])),
      /invalid topology or unit contract/i
    );
  } finally {
    removeDir(root);
  }
});

test('task application preserves display conversations while compressing llm context', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        runtime: {
          maxContextMessages: 2,
          retainedContextMessages: 1,
          promptMaxSummaryItems: 2
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"phase1","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":30,"decision":"CONTINUE","reason":"keep going","next_unit":"AGENT-001","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"phase2","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":70,"decision":"CONTINUE","reason":"still going","next_unit":"AGENT-001","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Analyst', goal: 'Iterate on one unit', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
await runtime.tasks.startTask({ taskId: submitted.command.taskId, userMessage: 'first input' });
await runtime.tasks.continueTask({ taskId: submitted.command.taskId, userMessage: 'second input' });
const done = await runtime.tasks.continueTask({ taskId: submitted.command.taskId, userMessage: 'third input' });
    const conversations = await foundation.conversations.list(submitted.command.taskId);

    assert.equal(done.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(done.task.conversations.length < conversations.length, true);
    assert.equal(done.task.conversations.filter(message => message.role === 'user').length, 3);
    assert.equal(done.task.latestVisibleOutput?.summary, 'done');
    assert.equal(done.task.diagnostics.lastError, null);
    assert.equal(done.task.runtime.contextCompressionCount > 0, true);
    assert.equal(done.task.runtime.llmContextMessages.length <= 2, true);
    assert.equal(done.task.runtime.llmContextSnapshotRef.kind, 'llm');
    assert.equal(done.task.runtime.conversationSnapshotRef.kind, 'conversation');
    assert.equal(done.task.runtime.promptBudget.maxContextMessages, 2);
    assert.equal(done.task.runtime.promptBudget.retainedContextMessages, 1);
    assert.equal(conversations.filter(message => message.role === 'user').length, 3);
    assert.equal(
      conversations.filter(
        (message) => message.role === 'assistant' && message.visibility === 'internal' && message.metadata?.source === 'provider_response'
      ).length,
      3
    );
    assert.equal(
      conversations.filter(
        (message) => message.role === 'assistant' && message.visibility === 'public' && message.metadata?.source === 'assistant_summary'
      ).length,
      2
    );
  } finally {
    removeDir(root);
  }
});

test('terminal tasks generate archive entries and lesson proposals that can be approved into lesson memory', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Prepared a reusable handoff note.","artifact":"reports/handoff.md","details":"The note is ready for later delivery.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/handoff.md","content":"# Handoff\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/handoff.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Writer',
        goal: 'Create a reusable handoff note',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        executionProfileId: 'implement',
        dependencies: []
      }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId, userMessage: 'Prepare the reusable handoff note and keep the artifact path visible.' });

    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const proposals = await runtime.platform.listImprovementProposals();
    const lessonProposal = proposals.find((proposal) => proposal.taskId === submitted.command.taskId && proposal.kind === 'lesson');
    const archive = await runtime.platform.listRealTaskArchive();
    const archiveEntry = archive.find((entry) => entry.taskId === submitted.command.taskId);

    assert.equal(task.realTaskArchiveStatus.archived, true);
    assert.equal(Boolean(archiveEntry), true);
    assert.equal(Boolean(lessonProposal), true);
    assert.equal(task.improvementProposals.some((proposal) => proposal.proposalId === lessonProposal.proposalId), true);

    await runtime.platform.approveImprovementProposal(lessonProposal.proposalId);
    const memories = await runtime.platform.listMemories();
    const lessonMemory = memories.find((memory) => memory.metadata?.proposalId === lessonProposal.proposalId);

    assert.equal(Boolean(lessonMemory), true);
    assert.equal(lessonMemory.metadata.layer, 'lesson');
  } finally {
    removeDir(root);
  }
});

test('repeated successful task patterns create experience proposals that materialize into reference experiences', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposals.find((proposal) => proposal.taskId === second.command.taskId && proposal.kind === 'experience');

    assert.equal(Boolean(experienceProposal), true);
    const approved = await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);
    const generatedExperiencePath = path.join(root, 'platform', 'generated-experiences', experienceProposal.proposalId, 'experience.md');
    const skills = await runtime.platform.listSkills();

    assert.equal(fs.existsSync(generatedExperiencePath), true);
    assert.equal(Boolean(approved.resource.experienceProposal?.materializedPath), true);
    assert.equal(approved.resource.experienceProposal?.materializedPath, generatedExperiencePath);
    assert.equal(approved.resource.experienceProposal?.validationStatus, 'monitoring');
    assert.deepEqual(approved.resource.experienceProposal?.successfulReuseTaskIds ?? [], []);
    assert.deepEqual(approved.resource.experienceProposal?.failedReuseTaskIds ?? [], []);
    assert.equal(skills.some((entry) => entry.skill.id === experienceProposal.proposalId), false);
  } finally {
    removeDir(root);
  }
});

test('experience proposals still generate when repeated successful tasks use different write-capable tool mixes', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponseWithFolder('alpha'),
      buildChecklistSuccessResponse('beta')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist variant',
      intent: 'Repeat the same successful checklist pattern with a slightly different tool path.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposals.find((proposal) => proposal.taskId === second.command.taskId && proposal.kind === 'experience');

    assert.equal(Boolean(experienceProposal), true);
  } finally {
    removeDir(root);
  }
});

test('a single successful archived task does not generate an instruction skill proposal yet', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha')
    ]);

    const submitted = await runtime.tasks.submitTask(createReusableChecklistPayload());
    await runtime.tasks.startTask({ taskId: submitted.command.taskId, userMessage: 'Create a reusable checklist artifact we might want to promote later.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const instructionSkill = proposals.find((proposal) => (
      proposal.taskId === submitted.command.taskId && proposal.kind === 'instruction_skill'
    ));

    assert.equal(Boolean(instructionSkill), false);
  } finally {
    removeDir(root);
  }
});

test('explicit approved experience metadata suppresses heuristic fallback when it does not match any record', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const third = await runtime.tasks.submitTask({
      ...payload,
      title: 'Third reusable checklist',
      intent: 'Repeat the same checklist work, but provide an explicit unmatched approved experience reference.',
      metadata: {
        experienceReferences: ['nonexistent-explicit-approved-experience']
      }
    });
    await runtime.tasks.startTask({ taskId: third.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern while honoring the explicit reference metadata.' });
    const thirdDebug = await runtime.tasks.getTaskDebug(third.command.taskId);

    assert.deepEqual(thirdDebug.executionSummary.experienceSummary.selected, []);
    assert.deepEqual(thirdDebug.executionSummary.experienceSummary.validationCandidates, []);
  } finally {
    removeDir(root);
  }
});

test('cross-pattern approved experience references stay visible but do not count toward reuse validation', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const unrelated = await runtime.tasks.submitTask({
      title: 'Runtime diagnostics note',
      intent: 'Verify runtime diagnostics and capture a short note artifact.',
      preferredProviderId: 'provider-main',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      },
      units: [
        {
          id: 'AGENT-001',
          role: 'Verifier',
          goal: 'Verify runtime diagnostics and capture a short note artifact.',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: unrelated.command.taskId, userMessage: 'Verify the runtime diagnostics and leave a short note artifact.' });
    const unrelatedDebug = await runtime.tasks.getTaskDebug(unrelated.command.taskId);
    const selectedExperience = unrelatedDebug.executionSummary.experienceSummary.selected.find((entry) => (
      entry.proposalId === experienceProposal.proposalId
    )) ?? null;

    assert.equal(Boolean(selectedExperience), true);
    assert.equal(selectedExperience?.validationEligible, false);
    assert.deepEqual(unrelatedDebug.executionSummary.experienceSummary.validationCandidates, []);

    const hydratedExperience = (await runtime.platform.listImprovementProposals()).find((proposal) => (
      proposal.proposalId === experienceProposal.proposalId
    ));
    assert.deepEqual(hydratedExperience.experienceProposal?.successfulReuseTaskIds ?? [], []);
    assert.deepEqual(hydratedExperience.experienceProposal?.failedReuseTaskIds ?? [], []);
  } finally {
    removeDir(root);
  }
});

test('heuristic approved experience selection does not attach unrelated tasks to checklist experiences', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const unrelated = await runtime.tasks.submitTask({
      title: 'Runtime diagnostics note',
      intent: 'Verify runtime diagnostics and capture a short note artifact.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Verifier',
          goal: 'Verify runtime diagnostics and capture a short note artifact.',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: unrelated.command.taskId, userMessage: 'Verify the runtime diagnostics and leave a short note artifact.' });
    const unrelatedDebug = await runtime.tasks.getTaskDebug(unrelated.command.taskId);

    assert.deepEqual(unrelatedDebug.executionSummary.experienceSummary.selected, []);
    assert.deepEqual(unrelatedDebug.executionSummary.experienceSummary.validationCandidates, []);
  } finally {
    removeDir(root);
  }
});

test('approved experiences must be reused successfully before instruction skill proposals are generated and imported', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma'),
      buildChecklistSuccessResponse('delta')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const third = await runtime.tasks.submitTask({
      ...payload,
      title: 'Third reusable checklist',
      intent: 'Use the approved checklist experience to produce another reusable checklist artifact.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: third.command.taskId, userMessage: 'Use the same approved checklist approach again.' });
    const thirdDebug = await runtime.tasks.getTaskDebug(third.command.taskId);
    assert.equal(thirdDebug.executionSummary.experienceSummary.selected.some((entry) => entry.proposalId === experienceProposal.proposalId), true);
    assert.equal(thirdDebug.executionSummary.experienceSummary.validationCandidates.some((entry) => entry.successfulReuseTaskIds.includes(third.command.taskId)), true);

    const fourth = await runtime.tasks.submitTask({
      ...payload,
      title: 'Fourth reusable checklist',
      intent: 'Reuse the same approved checklist experience one more time.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: fourth.command.taskId, userMessage: 'Reuse the same approved checklist approach one more time.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const instructionSkillProposal = proposals.find((proposal) => (
      proposal.taskId === fourth.command.taskId && proposal.kind === 'instruction_skill'
    ));

    assert.equal(Boolean(instructionSkillProposal), true);
    assert.equal(instructionSkillProposal.status, 'PENDING');
    assert.equal(instructionSkillProposal.evidenceTaskIds.includes(third.command.taskId), true);
    assert.equal(instructionSkillProposal.evidenceTaskIds.includes(fourth.command.taskId), true);
    assert.equal(Boolean(instructionSkillProposal.instructionSkillProposal?.draftSkillMarkdown), true);
    assert.equal(instructionSkillProposal.metadata.approvedExperienceProposalId, experienceProposal.proposalId);

    const approved = await runtime.platform.approveImprovementProposal(instructionSkillProposal.proposalId);
    const generatedSkillRoot = path.join(root, 'platform', 'generated-skills', instructionSkillProposal.proposalId);
    const generatedSkillPath = path.join(generatedSkillRoot, 'SKILL.md');
    const skills = await runtime.platform.listSkills();
    const hydratedProposal = (await runtime.platform.listImprovementProposals()).find((proposal) => (
      proposal.proposalId === instructionSkillProposal.proposalId
    ));

    assert.equal(fs.existsSync(generatedSkillPath), true);
    assert.equal(approved.resource.instructionSkillProposal?.materializedRootDir, generatedSkillRoot);
    assert.equal(approved.resource.instructionSkillProposal?.importedSkillId, instructionSkillProposal.proposalId);
    assert.equal(skills.some((entry) => entry.skill.id === instructionSkillProposal.proposalId), true);
    assert.equal(hydratedProposal?.instructionSkillProposal?.materializedRootDir, generatedSkillRoot);
    assert.equal(hydratedProposal?.instructionSkillProposal?.importedSkillId, instructionSkillProposal.proposalId);
  } finally {
    removeDir(root);
  }
});

test('instruction skill proposals stay scoped to their approved experience even when legacy dedupe keys would collide', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('b-alpha'),
      buildChecklistSuccessResponse('b-beta'),
      buildChecklistSuccessResponse('b-gamma'),
      buildChecklistSuccessResponse('b-delta'),
      buildChecklistSuccessResponse('a-alpha'),
      buildChecklistSuccessResponse('a-beta'),
      buildChecklistSuccessResponse('a-gamma'),
      buildChecklistSuccessResponse('a-delta')
    ]);

    const familyAToken = 'sharedfamilyscopealpha1';
    const familyBToken = 'sharedfamilyscopebravo2';
    const outputContract = '{"summary":"string","artifact":"string","details":"string","issues":[]}';
    const createFamilyPayload = (title, intent, familyToken, metadata = undefined) => ({
      title,
      intent,
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: familyToken,
          outputContract,
          executionProfileId: 'implement',
          dependencies: []
        }
      ],
      ...(metadata ? { metadata } : {})
    });
    const legacyNormalizeKey = (value) => value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);

    const familyBFirst = await runtime.tasks.submitTask(createFamilyPayload(
      'Family B checklist 1',
      'Create the first reusable checklist for family B.',
      familyBToken
    ));
    await runtime.tasks.startTask({ taskId: familyBFirst.command.taskId, userMessage: 'Create the first family B checklist artifact.' });

    const familyBSecond = await runtime.tasks.submitTask(createFamilyPayload(
      'Family B checklist 2',
      'Repeat the same family B checklist pattern.',
      familyBToken
    ));
    await runtime.tasks.startTask({ taskId: familyBSecond.command.taskId, userMessage: 'Repeat the same family B checklist artifact pattern.' });

    const proposalsAfterFamilyBArchive = await runtime.platform.listImprovementProposals();
    const familyBExperience = proposalsAfterFamilyBArchive.find((proposal) => (
      proposal.taskId === familyBSecond.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(familyBExperience), true);
    await runtime.platform.approveImprovementProposal(familyBExperience.proposalId);

    const familyBReuseOne = await runtime.tasks.submitTask(createFamilyPayload(
      'Family B checklist 3',
      'Reuse the same approved family B checklist experience once.',
      familyBToken,
      { experienceProposalIds: [familyBExperience.proposalId] }
    ));
    await runtime.tasks.startTask({ taskId: familyBReuseOne.command.taskId, userMessage: 'Reuse the approved family B checklist approach once.' });

    const familyBReuseTwo = await runtime.tasks.submitTask(createFamilyPayload(
      'Family B checklist 4',
      'Reuse the same approved family B checklist experience again.',
      familyBToken,
      { experienceProposalIds: [familyBExperience.proposalId] }
    ));
    await runtime.tasks.startTask({ taskId: familyBReuseTwo.command.taskId, userMessage: 'Reuse the approved family B checklist approach one more time.' });

    const proposalsAfterFamilyBPromotion = await runtime.platform.listImprovementProposals();
    const familyBInstructionSkill = proposalsAfterFamilyBPromotion.find((proposal) => (
      proposal.taskId === familyBReuseTwo.command.taskId && proposal.kind === 'instruction_skill'
    ));
    assert.equal(Boolean(familyBInstructionSkill), true);

    const familyAFirst = await runtime.tasks.submitTask(createFamilyPayload(
      'Family A checklist 1',
      'Create the first reusable checklist for family A.',
      familyAToken
    ));
    await runtime.tasks.startTask({ taskId: familyAFirst.command.taskId, userMessage: 'Create the first family A checklist artifact.' });

    const familyASecond = await runtime.tasks.submitTask(createFamilyPayload(
      'Family A checklist 2',
      'Repeat the same family A checklist pattern.',
      familyAToken
    ));
    await runtime.tasks.startTask({ taskId: familyASecond.command.taskId, userMessage: 'Repeat the same family A checklist artifact pattern.' });

    const proposalsAfterFamilyAArchive = await runtime.platform.listImprovementProposals();
    const familyAExperience = proposalsAfterFamilyAArchive.find((proposal) => (
      proposal.taskId === familyASecond.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(familyAExperience), true);
    assert.notEqual(familyAExperience.patternKey, familyBExperience.patternKey);
    assert.equal(
      legacyNormalizeKey(`instruction-skill-${familyAExperience.patternKey}`),
      legacyNormalizeKey(`instruction-skill-${familyBExperience.patternKey}`)
    );
    await runtime.platform.approveImprovementProposal(familyAExperience.proposalId);

    const familyAReuseOne = await runtime.tasks.submitTask(createFamilyPayload(
      'Family A checklist 3',
      'Reuse the same approved family A checklist experience once.',
      familyAToken,
      { experienceProposalIds: [familyAExperience.proposalId] }
    ));
    await runtime.tasks.startTask({ taskId: familyAReuseOne.command.taskId, userMessage: 'Reuse the approved family A checklist approach once.' });

    const familyAReuseTwo = await runtime.tasks.submitTask(createFamilyPayload(
      'Family A checklist 4',
      'Reuse the same approved family A checklist experience again.',
      familyAToken,
      { experienceProposalIds: [familyAExperience.proposalId] }
    ));
    await runtime.tasks.startTask({ taskId: familyAReuseTwo.command.taskId, userMessage: 'Reuse the approved family A checklist approach one more time.' });

    const finalProposals = await runtime.platform.listImprovementProposals();
    const hydratedFamilyBInstructionSkill = finalProposals.find((proposal) => proposal.proposalId === familyBInstructionSkill.proposalId);
    const familyAInstructionSkill = finalProposals.find((proposal) => (
      proposal.taskId === familyAReuseTwo.command.taskId && proposal.kind === 'instruction_skill'
    ));

    assert.equal(Boolean(familyAInstructionSkill), true);
    assert.notEqual(familyAInstructionSkill.proposalId, familyBInstructionSkill.proposalId);
    assert.equal(familyAInstructionSkill.metadata.approvedExperienceProposalId, familyAExperience.proposalId);
    assert.equal(hydratedFamilyBInstructionSkill.metadata.approvedExperienceProposalId, familyBExperience.proposalId);
    assert.deepEqual(
      [...hydratedFamilyBInstructionSkill.evidenceTaskIds].sort(),
      [familyBReuseOne.command.taskId, familyBReuseTwo.command.taskId].sort()
    );
    assert.equal(hydratedFamilyBInstructionSkill.evidenceTaskIds.includes(familyAReuseOne.command.taskId), false);
    assert.equal(hydratedFamilyBInstructionSkill.evidenceTaskIds.includes(familyAReuseTwo.command.taskId), false);
  } finally {
    removeDir(root);
  }
});

test('conflicting approved experience reuse blocks instruction skill promotion and emits an optimization proposal instead', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma'),
      buildChecklistFailureResponse('delta'),
      buildChecklistSuccessResponse('epsilon')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const third = await runtime.tasks.submitTask({
      ...payload,
      title: 'Third reusable checklist',
      intent: 'Reuse the approved checklist experience successfully once.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: third.command.taskId, userMessage: 'Use the approved checklist reference once.' });

    const fourth = await runtime.tasks.submitTask({
      ...payload,
      title: 'Fourth reusable checklist',
      intent: 'Reuse the approved checklist experience but hit a conflicting failure.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: fourth.command.taskId, userMessage: 'Try the same approved checklist approach even if it conflicts.' });
    const fourthProposals = await runtime.platform.listImprovementProposals();
    const hydratedExperience = fourthProposals.find((proposal) => proposal.proposalId === experienceProposal.proposalId);
    assert.equal(hydratedExperience.experienceProposal?.validationStatus, 'conflicted');
    assert.equal(hydratedExperience.experienceProposal?.failedReuseTaskIds.includes(fourth.command.taskId), true);

    const fifth = await runtime.tasks.submitTask({
      ...payload,
      title: 'Fifth reusable checklist',
      intent: 'Attempt another successful reuse after the approved experience became conflicted.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: fifth.command.taskId, userMessage: 'Attempt one more successful reuse after the conflict.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const instructionSkillProposal = proposals.find((proposal) => (
      proposal.taskId === fifth.command.taskId && proposal.kind === 'instruction_skill'
    ));
    const optimizationProposal = proposals.find((proposal) => (
      proposal.taskId === fifth.command.taskId
      && proposal.kind === 'optimization'
      && /conflict/i.test(proposal.summary)
    ));

    assert.equal(Boolean(instructionSkillProposal), false);
    assert.equal(Boolean(optimizationProposal), true);
  } finally {
    removeDir(root);
  }
});

test('rejecting an instruction skill proposal leaves no generated skill on disk', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      buildChecklistSuccessResponse('alpha'),
      buildChecklistSuccessResponse('beta'),
      buildChecklistSuccessResponse('gamma'),
      buildChecklistSuccessResponse('delta')
    ]);

    const payload = createReusableChecklistPayload();

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact pattern.' });

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern with the same operator-facing shape.' });

    const proposalsAfterArchive = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposalsAfterArchive.find((proposal) => (
      proposal.taskId === second.command.taskId && proposal.kind === 'experience'
    ));
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const third = await runtime.tasks.submitTask({
      ...payload,
      title: 'Third reusable checklist',
      intent: 'Reuse the approved checklist experience successfully once.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: third.command.taskId, userMessage: 'Use the approved checklist reference once.' });

    const fourth = await runtime.tasks.submitTask({
      ...payload,
      title: 'Fourth reusable checklist',
      intent: 'Reuse the approved checklist experience successfully twice.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    });
    await runtime.tasks.startTask({ taskId: fourth.command.taskId, userMessage: 'Use the approved checklist reference twice.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const instructionSkillProposal = proposals.find((proposal) => (
      proposal.taskId === fourth.command.taskId && proposal.kind === 'instruction_skill'
    ));
    assert.equal(Boolean(instructionSkillProposal), true);

    await runtime.platform.rejectImprovementProposal(instructionSkillProposal.proposalId);
    const generatedSkillRoot = path.join(root, 'platform', 'generated-skills', instructionSkillProposal.proposalId);
    const skills = await runtime.platform.listSkills();

    assert.equal(fs.existsSync(generatedSkillRoot), false);
    assert.equal(skills.some((entry) => entry.skill.id === instructionSkillProposal.proposalId), false);
  } finally {
    removeDir(root);
  }
});

test('task runtime follows the latest explicit language preference across turns', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const capturedSystemPrompts = [];
    registerProviderHandler(foundation, async (request) => {
      const systemPrompt = request.messages[0]?.content ?? '';
      capturedSystemPrompts.push(systemPrompt);
      const useChinese = systemPrompt.includes('Preferred language: zh-CN');
      const outputText = useChinese
        ? '[AGENT-001_OUTPUT]{"summary":"已按中文完成","details":"这是中文结果。"}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
        : '[AGENT-001_OUTPUT]{"summary":"Completed in English","details":"This result follows the latest language request."}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}';
      return {
        responseId: `resp_${Date.now()}`,
        providerId: 'provider-main',
        model: 'mock-model',
        outputText,
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20
        },
        metadata: {}
      };
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Responder',
        goal: 'Respond in the operator preferred language.',
        outputContract: '{"summary":"string","details":"string"}',
        dependencies: []
      }
    ]));

    const firstTurn = await runtime.tasks.startTask({
      taskId: submitted.command.taskId,
      userMessage: '请用中文回复，并记住我习惯中文。'
    });
    const secondTurn = await runtime.tasks.continueTask({
      taskId: submitted.command.taskId,
      userMessage: 'Please switch to English from now on.'
    });

    assert.match(firstTurn.task.latestVisibleOutput?.summary ?? '', /中文/);
    assert.match(secondTurn.task.latestVisibleOutput?.summary ?? '', /English/);
    assert.equal(capturedSystemPrompts.some((prompt) => prompt.includes('Preferred language: zh-CN')), true);
    assert.equal(capturedSystemPrompts.some((prompt) => prompt.includes('Preferred language: en')), true);
  } finally {
    removeDir(root);
  }
});

test('approved lesson memory absorbs later duplicate evidence without creating a second lesson memory record', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Prepared reusable note alpha.","artifact":"reports/reusable-alpha.md","details":"Reusable note alpha is ready.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/reusable-alpha.md","content":"# Reusable Alpha\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/reusable-alpha.md"]}',
      '[AGENT-001_OUTPUT]{"summary":"Prepared reusable note beta.","artifact":"reports/reusable-beta.md","details":"Reusable note beta is ready.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/reusable-beta.md","content":"# Reusable Beta\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/reusable-beta.md"]}'
    ]);

    const payload = createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Writer',
        goal: 'Create a reusable note artifact',
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        executionProfileId: 'implement',
        dependencies: []
      }
    ]);

    const first = await runtime.tasks.submitTask(payload);
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable note artifact.' });

    const firstLesson = (await runtime.platform.listImprovementProposals()).find((proposal) => (
      proposal.taskId === first.command.taskId && proposal.kind === 'lesson'
    ));
    assert.equal(Boolean(firstLesson), true);
    await runtime.platform.approveImprovementProposal(firstLesson.proposalId);

    const second = await runtime.tasks.submitTask({
      ...payload,
      title: 'Second reusable note',
      intent: 'Repeat the same reusable note pattern.'
    });
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the reusable note pattern with a second artifact.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const mergedLesson = proposals.find((proposal) => proposal.proposalId === firstLesson.proposalId);
    const lessonMemories = (await runtime.platform.listMemories()).filter((memory) => memory.metadata?.layer === 'lesson');

    assert.equal(Boolean(mergedLesson), true);
    assert.equal(mergedLesson.status, 'APPROVED');
    assert.equal(mergedLesson.evidenceTaskIds.includes(first.command.taskId), true);
    assert.equal(mergedLesson.evidenceTaskIds.includes(second.command.taskId), true);
    assert.equal(lessonMemories.length, 1);
    assert.equal(Array.isArray(lessonMemories[0].metadata?.evidenceTaskIds), true);
    assert.equal(lessonMemories[0].metadata.evidenceTaskIds.includes(first.command.taskId), true);
    assert.equal(lessonMemories[0].metadata.evidenceTaskIds.includes(second.command.taskId), true);
  } finally {
    removeDir(root);
  }
});

test('task approval resolution dispatches waiting tool invocation and restart preserves history', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            ok: true
          }
        });
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"rerun","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const pendingApproval = started.task.pendingApprovals[0];
    assert.equal(started.task.toolInvocations[0].status, 'WAITING_APPROVAL');
    assert.equal(started.task.visibleToolActivities.some((activity) => activity.status === 'WAITING_APPROVAL'), true);

const resolved = await runtime.tasks.resolveToolApproval({
      taskId: submitted.command.taskId,
      invocationId: pendingApproval.invocationId,
      status: 'APPROVED',
      grantedBy: 'tester'
    });
    const succeededInvocation = resolved.task.toolInvocations.find(record => record.invocationId === pendingApproval.invocationId);
const debugAfterApproval = await runtime.tasks.getTaskDebug(submitted.command.taskId);
const savedRuntimeAfterApproval = await foundation.taskRuntimes.get(submitted.command.taskId);
const eventsBeforeRestart = await runtime.tasks.getTaskEvents(submitted.command.taskId);
const taskAfterApproval = await runtime.tasks.getTask(submitted.command.taskId);
const restarted = await runtime.tasks.restartTask({ taskId: submitted.command.taskId });
const eventsAfterRestart = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const conversations = await foundation.conversations.list(submitted.command.taskId);
    const synthesizedArtifactReadySummary = taskAfterApproval.conversations.find(
      (message) => message.role === 'assistant'
        && message.metadata?.source === 'assistant_summary'
        && message.metadata?.displayKind === 'artifact_ready'
    );

    assert.equal(succeededInvocation.status, 'SUCCEEDED');
    assert.equal(resolved.task.pendingApprovals.length, 0);
    assert.equal(resolved.task.runtime.pendingToolBatches[0].status, 'SUCCEEDED');
    assert.equal(resolved.task.runtime.pendingToolBatches[0].approvalBlockedCount, 0);
    assert.deepEqual(resolved.task.runtime.awaitingApprovalInvocations, []);
    assert.equal(resolved.task.runtime.pendingCorrection, 'NONE');
    assert.equal(resolved.task.runtime.consolidationState.status, 'COMPLETED');
    assert.notEqual(debugAfterApproval.executionSummary.issueCategory, 'approval_deadlock');
    assert.notEqual(debugAfterApproval.executionSummary.issueSummary, 'Task is blocked on tool approval.');
    assert.equal(debugAfterApproval.executionSummary.turnContract.pendingCorrection, 'NONE');
    assert.match(
      debugAfterApproval.executionSummary.turnContract.continueReason,
      /project-relative destination|Task lifecycle is COMPLETED/i
    );
    assert.equal(savedRuntimeAfterApproval.runtime.pendingToolBatches[0].status, 'SUCCEEDED');
    assert.equal(savedRuntimeAfterApproval.runtime.pendingToolBatches[0].approvalBlockedCount, 0);
    assert.equal(savedRuntimeAfterApproval.runtime.pendingCorrection, 'NONE');
    assert.equal(savedRuntimeAfterApproval.runtime.consolidationState.status, 'COMPLETED');
    assert.equal(eventsAfterRestart.length > eventsBeforeRestart.length, true);
    if (synthesizedArtifactReadySummary) {
      assert.match(synthesizedArtifactReadySummary.content ?? '', /choose a project-relative destination/i);
    }
    assert.equal(conversations.filter(message => message.role === 'assistant').length >= 2, true);
    assert.equal(restarted.task.runtime.lifecycleStatus, 'COMPLETED');
  } finally {
    removeDir(root);
  }
});

test('task approval resolution replays the original tracker after a gated write instead of rerunning the provider', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            ok: true
          }
        });
      }
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });
    let providerCallCount = 0;
    foundation.providerClients.register('provider-main', {
      async complete() {
        providerCallCount += 1;
        return {
          responseId: `resp_${Date.now()}`,
          providerId: 'provider-main',
          model: 'mock-model',
          outputText:
            '[AGENT-001_OUTPUT]{"summary":"created checklist","artifact":"release_checklist.md","details":"saved markdown checklist","issues":[]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"release_checklist.md","content":"# Release Checklist"}}\n'
            + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"artifact created","next_unit":null,"files_created":["release_checklist.md"]}',
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20
          },
          metadata: {}
        };
      }
    });

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create checklist',
          executionProfileId: 'implement',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          dependencies: []
        }
      ]),
      preferredProviderId: 'provider-main',
      pathPolicy: 'task_workspace'
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const pendingApproval = started.task.pendingApprovals[0];

    const resolved = await runtime.tasks.resolveToolApproval({
      taskId: submitted.command.taskId,
      invocationId: pendingApproval.invocationId,
      status: 'APPROVED',
      grantedBy: 'tester'
    });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(providerCallCount, 1);
    assert.equal(resolved.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(resolved.task.pendingApprovals.length, 0);
    assert.equal(resolved.task.runtime.pendingToolBatches[0].status, 'SUCCEEDED');
    assert.equal(resolved.task.runtime.consolidationState.status, 'COMPLETED');
    assert.equal(resolved.task.runtime.progressHistory.at(-1)?.status, 'COMPLETE');
    assert.equal(debug.executionSummary.turnContract.continueAllowed, false);
  } finally {
    removeDir(root);
  }
});

test('task keeps a visible failure summary when a resumed provider turn fails after approval succeeds', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            ok: true
          }
        });
      }
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });
    const providerResponses = [
      '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":40,"decision":"CONTINUE","reason":"keep going after the approved write","next_unit":"AGENT-001","files_created":["report.md"]}',
      new ProviderHttpError('post-approval provider exploded', 'RATE_LIMIT', 429, true)
    ];
    foundation.providerClients.register('provider-main', {
      async complete() {
        const next = providerResponses.shift();
        if (!next) {
          throw new Error('No mock provider response queued.');
        }
        if (next instanceof Error) {
          throw next;
        }
        return {
          responseId: `resp_${Date.now()}`,
          providerId: 'provider-main',
          model: 'mock-model',
          outputText: next,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20
          },
          metadata: {}
        };
      }
    });

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]),
      pathPolicy: 'task_workspace'
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const pendingApproval = started.task.pendingApprovals[0];

    const resolved = await runtime.tasks.resolveToolApproval({
      taskId: submitted.command.taskId,
      invocationId: pendingApproval.invocationId,
      status: 'APPROVED',
      grantedBy: 'tester'
    });
    const continued = await runtime.tasks.continueTask({
      taskId: submitted.command.taskId,
      userMessage: 'Continue after the approved write.'
    });
    const fetchedTask = await runtime.tasks.getTask(submitted.command.taskId);

    const approvedInvocation = continued.task.toolInvocations.find((record) => record.invocationId === pendingApproval.invocationId);

    assert.equal(approvedInvocation?.status, 'SUCCEEDED');
    assert.equal(resolved.task.pendingApprovals.length, 0);
    assert.equal(continued.task.runtime.lifecycleStatus, 'FAILED');
    assert.equal(fetchedTask.latestVisibleOutput?.source, 'validated_output');
    assert.match(fetchedTask.latestVisibleOutput?.summary ?? '', /needs write/i);
    assert.deepEqual(fetchedTask.latestVisibleOutput?.artifactPaths ?? [], ['report.md']);
    assert.equal(fetchedTask.diagnostics.providerFailure?.providerId, 'provider-main');
    assert.match(fetchedTask.completionSummary?.summary ?? '', /failed after generating report\.md/i);
    assert.match(fetchedTask.completionSummary?.details ?? '', /post-approval provider exploded/i);
  } finally {
    removeDir(root);
  }
});

test('provider failures preserve the current turn context summary instead of falling back to the prior runtime snapshot', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });
    const providerResponses = [
      '[AGENT-001_OUTPUT]{"summary":"Initial grounding complete","details":"Continue with the next implementation step.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":40,"decision":"CONTINUE","reason":"keep the same unit active","next_unit":"AGENT-001","files_created":[]}',
      new ProviderHttpError('second turn timed out locally', 'TIMEOUT', 408, true, 'local_abort', 45011, 45000, 3)
    ];
    foundation.providerClients.register('provider-main', {
      async complete() {
        const next = providerResponses.shift();
        if (!next) {
          throw new Error('No mock provider response queued.');
        }
        if (next instanceof Error) {
          throw next;
        }
        return {
          responseId: `resp_${Date.now()}`,
          providerId: 'provider-main',
          model: 'mock-model',
          outputText: next,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20
          },
          metadata: {}
        };
      }
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Architect',
        goal: 'Ground the design brief, then continue with implementation.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'analyze',
        dependencies: []
      }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const continued = await runtime.tasks.continueTask({
      taskId: submitted.command.taskId,
      userMessage: 'Continue using the grounded brief context.'
    });
    const fetchedTask = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.contextGating.rawContextMessageCount, 0);
    assert.equal(continued.task.runtime.lifecycleStatus, 'FAILED');
    assert.ok((fetchedTask.runtime.contextGating.rawContextMessageCount ?? 0) >= 1);
    assert.ok((fetchedTask.runtime.promptBudget.rawContextCharacters ?? 0) > 0);
    assert.equal(fetchedTask.diagnostics.providerFailure?.timeoutOrigin, 'local_abort');
    assert.equal(fetchedTask.diagnostics.providerFailure?.requestContext?.rawContextMessageCount, fetchedTask.runtime.contextGating.rawContextMessageCount);
    assert.equal(fetchedTask.diagnostics.providerFailure?.requestContext?.toolMessageCount, fetchedTask.runtime.contextGating.toolMessageCount);
    assert.ok((fetchedTask.diagnostics.providerFailure?.requestContext?.providerMessageCount ?? 0) >= 2);
    assert.ok((fetchedTask.diagnostics.providerFailure?.requestContext?.estimatedPromptCharacters ?? 0) > 0);
  } finally {
    removeDir(root);
  }
});

test('failed task queries prefer validated output over failure fallback when a validated output exists', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Architect',
        goal: 'Ground the design brief',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        dependencies: []
      }
    ]));
    const taskId = submitted.command.taskId;
    const record = await foundation.taskRuntimes.get(taskId);
    const now = Date.now();

    await foundation.validatedOutputs.save({
      taskId,
      unitId: 'AGENT-001',
      sessionId: 'sess_validated',
      correlationId: 'corr_validated',
      turnId: 'turn_validated',
      checkpointId: 'chk_validated',
      contractKeys: ['summary', 'details', 'producedFiles', 'issues'],
      wrapper: 'square',
      raw: '[AGENT-001_OUTPUT]{"summary":"Briefs grounded","details":"Three brief files were read successfully; the next turn should write the design docs.","producedFiles":[],"issues":[]}[/AGENT-001_OUTPUT]',
      parsed: {
        summary: 'Briefs grounded',
        details: 'Three brief files were read successfully; the next turn should write the design docs.',
        producedFiles: [],
        issues: []
      },
      validatedAt: now,
      metadata: {
        currentUnitId: 'AGENT-001'
      }
    });

    await foundation.taskRuntimes.save({
      ...record,
      runtime: {
        ...record.runtime,
        lifecycleStatus: 'FAILED',
        engineStatus: 'FAILED',
        currentUnitId: 'AGENT-001',
        lastError: 'backend_new provider error: request timed out',
        updatedAt: now
      }
    });

    const fetchedTask = await runtime.tasks.getTask(taskId);

    assert.equal(fetchedTask.runtime.lifecycleStatus, 'FAILED');
    assert.equal(fetchedTask.latestVisibleOutput?.source, 'validated_output');
    assert.equal(fetchedTask.latestVisibleOutput?.summary, 'Briefs grounded');
    assert.match(fetchedTask.latestVisibleOutput?.details ?? '', /next turn should write the design docs/i);
    assert.match(fetchedTask.diagnostics.lastError ?? '', /request timed out/i);
  } finally {
    removeDir(root);
  }
});

test('task approval rejection denies tool without counting as executor failure', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute() {
        throw new Error('should not execute when rejected');
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const pendingApproval = started.task.pendingApprovals[0];
const rejected = await runtime.tasks.resolveToolApproval({
      taskId: submitted.command.taskId,
      invocationId: pendingApproval.invocationId,
      status: 'REJECTED',
      grantedBy: 'tester'
    });

    const deniedInvocation = rejected.task.toolInvocations.find(record => record.invocationId === pendingApproval.invocationId);
    assert.equal(deniedInvocation.status, 'DENIED');
    assert.match(String(deniedInvocation.error), /REJECTED/i);
  } finally {
    removeDir(root);
  }
});

test('artifact path routing blocks continue when destination is unresolved and reports stable guidance', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"draft created","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"scratch/output","content":"artifact"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["scratch/output"]}',
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Artifact routing task',
      intent: 'Produce a file and wait for the destination directory.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Generate a deliverable',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    const conversations = await foundation.conversations.list(submitted.command.taskId);
    const publicArtifactSummary = conversations.find(
      (message) => message.role === 'assistant'
        && message.visibility === 'public'
        && message.metadata?.source === 'assistant_summary'
        && message.metadata?.displayKind === 'artifact_ready'
    );

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.executionSummary.artifactPathState, 'unresolved');
    assert.equal(debug.executionSummary.issueCategory, 'artifact_destination_unresolved');
    assert.equal(debug.executionSummary.turnContract.continueAllowed, false);
    assert.match(debug.executionSummary.turnContract.continueReason, /project-relative destination/i);
    assert.match(publicArtifactSummary?.content ?? '', /choose a project-relative destination/i);
    await assert.rejects(
      () => runtime.tasks.continueTask({ taskId: submitted.command.taskId }),
      /project-relative destination/i
    );
  } finally {
    removeDir(root);
  }
});

test('artifact apply flow copies sandbox outputs into project destination and records apply evidence', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"report created","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["report.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Artifact apply task',
      intent: 'Create a markdown report and apply it into project docs.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a report artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const applied = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      message: 'backend/docs',
      metadata: {
        destinationDir: 'backend/docs'
      }
    });
    const events = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const destinationPath = path.join(root, 'backend', 'docs', 'report.md');
    const copied = fs.readFileSync(destinationPath, 'utf8');
    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(applied.commandMetadata.artifactApplyStatus, 'APPLIED');
    assert.equal(applied.commandMetadata.destinationDir, 'backend/docs');
    assert.equal(copied, '# Report\n');
    assert.equal(events.some((event) => event.type === 'TASK_ARTIFACTS_APPLIED'), true);
    assert.match(task.latestVisibleOutput?.summary ?? '', /delivered report\.md to backend\/docs\/report\.md/i);
    assert.match(task.latestVisibleOutput?.details ?? '', /applied to backend\/docs/i);
    assert.deepEqual(task.latestVisibleOutput?.artifactPaths, ['report.md']);
    assert.deepEqual(task.latestVisibleOutput?.artifactDestinationPaths, ['backend/docs/report.md']);
    assert.equal(task.visibleToolActivities.some((activity) => (
      activity.status === 'SUCCEEDED'
      && activity.evidencePaths.includes('report.md')
    )), true);
    assert.equal(debug.executionSummary.artifactPathState, 'applied');
    assert.equal(debug.executionSummary.selectedArtifactDir, 'backend/docs');
    assert.deepEqual(debug.executionSummary.artifactDestinationPaths, ['backend/docs/report.md']);
    assert.equal(debug.executionSummary.issueSummary, null);
  } finally {
    removeDir(root);
  }
});

test('artifact apply uses the recommended destination when the operator does not provide a custom path', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"release notes drafted","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"docs/release-notes.md","content":"# Release Notes\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["docs/release-notes.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Recommended documentation destination apply task',
      intent: 'Draft release notes and wait for the operator to confirm the project docs location.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a documentation artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const beforeApply = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    assert.equal(beforeApply.executionSummary.artifactPathState, 'unresolved');
    assert.equal(beforeApply.executionSummary.recommendedArtifactDir, 'backend/docs');

    const applied = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      metadata: {
        overwrite: true
      }
    });
    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(applied.commandMetadata.artifactApplyStatus, 'APPLIED');
    assert.equal(applied.commandMetadata.destinationDir, 'backend/docs');
    assert.equal(applied.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.selectedArtifactDir, 'backend/docs');
    assert.deepEqual(debug.executionSummary.artifactDestinationPaths, ['backend/docs/release-notes.md']);
    assert.deepEqual(task.latestVisibleOutput?.artifactDestinationPaths, ['backend/docs/release-notes.md']);
    assert.match(task.latestVisibleOutput?.summary ?? '', /delivered .*release-notes\.md to backend\/docs\/release-notes\.md/i);
    assert.match(task.completionSummary?.summary ?? '', /delivered .*release-notes\.md to backend\/docs\/release-notes\.md/i);
  } finally {
    removeDir(root);
  }
});

test('artifact apply rewrites pre-delivery completion summaries that still say ready for delivery', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Artifact ready for delivery","artifact":"docs/release-ready.md","details":"The artifact is ready in the task workspace and needs a destination.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"docs/release-ready.md","content":"# Release Ready\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["docs/release-ready.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Artifact ready for delivery rewrite task',
      intent: 'Create a deliverable artifact, apply the recommended destination, and synthesize a delivered summary.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'ask_if_unclear',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a release-ready artifact.',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const applied = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      metadata: {
        overwrite: true
      }
    });
    const task = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(applied.commandMetadata.artifactApplyStatus, 'APPLIED');
    assert.equal(applied.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.match(task.latestVisibleOutput?.summary ?? '', /delivered .*release-ready\.md to backend\/docs\/release-ready\.md/i);
    assert.match(task.completionSummary?.summary ?? '', /delivered .*release-ready\.md to backend\/docs\/release-ready\.md/i);
    assert.doesNotMatch(task.completionSummary?.summary ?? '', /ready for delivery/i);
  } finally {
    removeDir(root);
  }
});

test('artifact apply can auto-complete when no further parent work remains after delivery', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Created scratch/live-review-handoff.md with handoff note content.","artifact":"scratch/live-review-handoff.md","details":"The markdown handoff is ready for operator destination selection.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"scratch/live-review-handoff.md","content":"# Live review handoff\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["scratch/live-review-handoff.md"]}',
      '[AGENT-001_OUTPUT]{"summary":"Handoff note delivered to backend/docs/live-review-task.","artifact":"backend/docs/live-review-task","details":"Operator confirmed destination; artifacts applied successfully. No further scratch artifacts created.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"Delivery confirmed at operator-selected destination; task complete.","next_unit":null,"files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Artifact apply completion task',
      intent: 'Create a markdown handoff artifact, wait for operator apply, then confirm the delivered destination.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'project_relative',
      preferredArtifactDir: 'backend/docs/live-review-task',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a markdown handoff artifact and confirm delivery.',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.pendingCorrection, 'NONE');

    const applied = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      actor: 'tester',
      metadata: {
        destinationDir: 'backend/docs/live-review-task',
        overwrite: true
      }
    });
    assert.equal(applied.commandMetadata.destinationDir, 'backend/docs/live-review-task');

    const destinationPath = 'backend/docs/live-review-task/scratch/live-review-handoff.md';

    assert.equal(applied.commandMetadata.autoFinished, true);
    assert.equal(applied.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(applied.task.runtime.pendingCorrection, 'NONE');
    assert.deepEqual(applied.task.latestVisibleOutput?.artifactDestinationPaths, [destinationPath]);
    assert.equal(applied.task.latestVisibleOutput?.artifactApplyStatus, 'APPLIED');
    assert.match(applied.task.completionSummary?.summary ?? '', /delivered/i);
    assert.equal(applied.task.completionSummary?.continueAllowed, true);

    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    assert.equal(debug.executionSummary.artifactPathState, 'applied');
    assert.deepEqual(debug.executionSummary.artifactDestinationPaths, [destinationPath]);
    assert.equal(debug.executionSummary.turnContract.pendingCorrection, 'NONE');
  } finally {
    removeDir(root);
  }
});

test('artifact routing treats explicit absolute local output paths as already delivered', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    const externalRoot = path.join(root, 'external-delivery');
    const destinationPath = path.join(externalRoot, 'blog', 'index.html');
    registerProvider(foundation, [
      `[AGENT-001_OUTPUT]{"summary":"Blog delivered","details":"Wrote the requested file to the external destination.","artifactDestination":"${destinationPath.replace(/\\/g, '/')}","issues":[]}[/AGENT-001_OUTPUT]\n`
        + `{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"${destinationPath.replace(/\\/g, '/')}","content":"<html></html>"}}\n`
        + `{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":["${destinationPath.replace(/\\/g, '/')}"]}`
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Absolute external artifact delivery task',
      intent: 'Write a real file to an explicit absolute local destination.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'ask_if_unclear',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Write the external artifact directly to the requested path.',
          outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(debug.executionSummary.artifactPathState, 'applied');
    assert.deepEqual(debug.executionSummary.artifactDestinationPaths, [destinationPath.replace(/\\/g, '/')]);
    assert.equal(debug.executionSummary.issueCategory, null);
    assert.equal(debug.executionSummary.turnContract.pendingCorrection, 'NONE');
  } finally {
    removeDir(root);
  }
});

test('artifact routing ignores create-folder directory placeholders and tracks only deliverable files', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"report created","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"create_folder","arguments":{"path":"reports"}}\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/report.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Artifact directory filtering task',
      intent: 'Create a report file inside a folder without treating the folder as an apply target.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a nested report artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.deepEqual(debug.executionSummary.artifactPaths, ['reports/report.md']);
    assert.equal(debug.executionSummary.pendingArtifactCount, 1);
    assert.equal(debug.executionSummary.recommendedArtifactDir, '.codex-run/logs');
    assert.equal(debug.executionSummary.artifactPathState, 'unresolved');
    assert.equal(debug.executionSummary.turnContract.continueAllowed, false);
  } finally {
    removeDir(root);
  }
});

test('artifact routing keeps recommended documentation destinations unresolved until operator selection is explicit', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"doc drafted","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"docs/release-notes.md","content":"# Release Notes\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":60,"decision":"CONTINUE","reason":"drafted","next_unit":"AGENT-001","files_created":["docs/release-notes.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'Recommended documentation destination task',
      intent: 'Draft release notes and wait for the operator to confirm the project docs location.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a documentation artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.executionSummary.recommendedArtifactDir, 'backend/docs');
    assert.equal(debug.executionSummary.selectedArtifactDir, null);
    assert.equal(debug.executionSummary.artifactPathState, 'unresolved');
    assert.equal(debug.executionSummary.issueCategory, 'artifact_destination_unresolved');
    assert.equal(debug.executionSummary.turnContract.continueAllowed, false);
  } finally {
    removeDir(root);
  }
});

test('artifact routing does not auto-route generic json deliverables into runtime logs', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"manifest drafted","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"output/manifest.json","content":"{\\"ok\\":true}"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":60,"decision":"CONTINUE","reason":"manifest drafted","next_unit":"AGENT-001","files_created":["output/manifest.json"]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      title: 'JSON artifact routing task',
      intent: 'Draft a generic manifest JSON file and require an explicit destination.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a generic JSON artifact',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(debug.executionSummary.recommendedArtifactDir, null);
    assert.equal(debug.executionSummary.artifactPathState, 'unresolved');
    assert.equal(debug.executionSummary.issueCategory, 'artifact_destination_unresolved');
    assert.equal(debug.executionSummary.turnContract.continueAllowed, false);
  } finally {
    removeDir(root);
  }
});

test('approval-blocked stage stays active and reports batch-blocked diagnostics consistently', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            ok: true
          }
        });
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"needs approval","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"waiting on tool approval","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const conversations = await foundation.conversations.list(submitted.command.taskId);
    const approvalSummary = conversations.find(
      (message) => message.role === 'assistant'
        && message.visibility === 'public'
        && message.metadata?.source === 'assistant_summary'
        && message.metadata?.displayKind === 'approval_waiting'
    );

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.planner?.blockingReason, 'CONSOLIDATION_BLOCKED');
    assert.equal(started.task.runtime.activeStage?.stageIndex, 0);
    assert.equal(started.task.runtime.pendingToolBatches.length, 1);
    assert.equal(started.task.runtime.pendingToolBatches[0].status, 'PARTIAL_APPROVAL_BLOCKED');
    assert.equal(started.task.runtime.pendingToolBatches[0].approvalBlockedCount, 1);
    assert.equal(started.task.runtime.consolidationState.status, 'CORRECTION_REQUIRED');
    assert.equal(started.task.pendingApprovals.length, 1);
    assert.equal(started.task.runtime.completedUnits.length, 0);
    assert.match(approvalSummary?.content ?? '', /waiting for approval/i);
  } finally {
    removeDir(root);
  }
});

test('submitted task cancellation uses cancelled lifecycle transition and publishes TASK_CANCELLED', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Cancel before execution', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const cancelled = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'CANCEL_TASK',
      reason: 'operator cancelled before start'
    });
    const events = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const cancelledEvents = events.filter((event) => event.type === 'TASK_CANCELLED');
    const savedTask = await foundation.tasks.get(submitted.command.taskId);

    assert.equal(cancelled.task.runtime.lifecycleStatus, 'CANCELLED');
    assert.equal(cancelled.task.runtime.engineStatus, 'FAILED');
    assert.equal(cancelled.command.message, 'Task cancelled.');
    assert.equal(savedTask.status, 'CANCELLED');
    assert.equal(savedTask.currentUnitId, null);
    assert.equal(cancelledEvents.length, 1);
    assert.equal(cancelledEvents[0].payload.reason, 'operator cancelled before start');
  } finally {
    removeDir(root);
  }
});

test('running task cancellation waits for a safe point and publishes TASK_CANCELLED once', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });

    let providerStartedResolve;
    const providerStarted = new Promise((resolve) => {
      providerStartedResolve = resolve;
    });

    foundation.providerClients.register('provider-main', {
      async complete(request) {
        providerStartedResolve();
        return new Promise((resolve, reject) => {
          request.abortSignal?.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('provider aborted by cancel request')), 30);
          }, { once: true });
          setTimeout(() => resolve({
            responseId: `resp_${Date.now()}`,
            providerId: 'provider-main',
            model: 'mock-model',
            outputText: '[AGENT-001_OUTPUT]{"summary":"late","issues":[]}[/AGENT-001_OUTPUT]\n'
              + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
            finishReason: 'stop',
            usage: {
              promptTokens: 10,
              completionTokens: 10,
              totalTokens: 20
            },
            metadata: {}
          }), 5_000);
        });
      }
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Cancel during provider execution', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const startedPromise = runtime.tasks.startTask({ taskId: submitted.command.taskId });

    await providerStarted;
    const cancellationRequested = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'CANCEL_TASK',
      reason: 'cancel during provider execution'
    });
    const cancelled = await startedPromise;
    const events = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const cancelledEvents = events.filter((event) => event.type === 'TASK_CANCELLED');
    const savedTask = await foundation.tasks.get(submitted.command.taskId);

    assert.equal(cancellationRequested.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(cancellationRequested.command.message, 'Cancellation requested.');
    assert.equal(cancelled.task.runtime.lifecycleStatus, 'CANCELLED');
    assert.equal(cancelled.task.runtime.engineStatus, 'FAILED');
    assert.equal(savedTask.status, 'CANCELLED');
    assert.equal(savedTask.currentUnitId, null);
    assert.equal(cancelledEvents.length, 1);
    assert.equal(cancelledEvents[0].payload.reason, 'cancel during provider execution');
  } finally {
    removeDir(root);
  }
});

test('provider and tool executor failures are persisted as failed task or failed invocation', async () => {
  const root = createTempRoot();
  try {
    const { foundation: providerFailureFoundation, runtime: providerFailureRuntime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: `${root}-provider`
        }
      }
    });
    providerFailureFoundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });
    providerFailureFoundation.providerClients.register('provider-main', {
      async complete() {
        throw new ProviderHttpError('provider exploded', 'RATE_LIMIT', 429, true);
      }
    });

const submittedFailed = await providerFailureRuntime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Planner', goal: 'Plan', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const failed = await providerFailureRuntime.tasks.startTask({ taskId: submittedFailed.command.taskId });
const failedEvents = await providerFailureRuntime.tasks.getTaskEvents(submittedFailed.command.taskId);
    const failedProjection = await providerFailureFoundation.projections.get(submittedFailed.command.taskId);
    assert.equal(failed.command.ok, false);
    assert.equal(failed.task.runtime.lifecycleStatus, 'FAILED');
    assert.equal(failed.task.diagnostics.providerFailure.providerId, 'provider-main');
    assert.equal(failed.task.diagnostics.providerFailure.kind, 'RATE_LIMIT');
    assert.equal(failed.task.diagnostics.providerFailure.category, 'rate_limited');
    assert.match(String(failed.task.runtime.lastError), /provider exploded/);
    assert.equal(failedEvents.some(event => event.type === 'CHECKPOINT_WRITTEN'), true);
    assert.equal(failedEvents.some(event => event.type === 'PROJECTION_UPDATED'), true);
    assert.equal(failedEvents.some(event => event.type === 'TASK_FAILED' && event.payload.providerId === 'provider-main'), true);
    assert.equal(failedProjection.metadata.providerId, 'provider-main');
    assert.match(String(failedProjection.metadata.providerFailure), /provider exploded/);
    assert.equal(failedProjection.metadata.providerFailureKind, 'RATE_LIMIT');
    assert.equal(failedProjection.metadata.providerFailureCategory, 'rate_limited');
    assert.equal(failedProjection.metadata.providerFailureStatusCode, 429);
    assert.equal(failedProjection.metadata.providerFailureRetryable, true);

    const { foundation: toolFailureFoundation, runtime: toolFailureRuntime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: `${root}-tool`
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    toolFailureRuntime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    toolFailureFoundation.toolExecutors.register('write-file', {
      async execute() {
        return createToolFailureResult({
          kind: 'EXECUTION',
          message: 'tool failed'
        });
      }
    });
    registerProvider(toolFailureFoundation, [
      '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submittedTool = await toolFailureRuntime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const toolResult = await toolFailureRuntime.tasks.startTask({ taskId: submittedTool.command.taskId });
    const failedInvocation = toolResult.task.toolInvocations.find(record => record.status === 'FAILED');

    assert.equal(toolResult.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(toolResult.task.runtime.planner.blockingReason, 'CONSOLIDATION_BLOCKED');
    assert.equal(toolResult.task.runtime.consolidationState.lastResult, 'CORRECTION_REQUIRED');
    assert.equal(failedInvocation.status, 'FAILED');
    assert.match(String(failedInvocation.error), /tool failed/);
  } finally {
    removeDir(`${root}-provider`);
    removeDir(`${root}-tool`);
  }
});

test('repeated correction loops keep diagnostics truthful and trigger conservative guardrails', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"first try","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"second try","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Planner',
        goal: 'Plan the work',
        outputContract: '{"summary":"string","issues":[]}',
        exitCondition: '{"report":"required"}',
        dependencies: []
      }
    ]));
    const first = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const second = await runtime.tasks.continueTask({ taskId: submitted.command.taskId, userMessage: 'try again with required report' });

    assert.equal(first.task.runtime.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
    assert.equal(second.task.runtime.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
    assert.equal(second.task.runtime.guardrails?.correctionStreak, 2);
    assert.equal(second.task.runtime.compressionDowngraded, true);
    assert.equal(second.task.runtime.planner?.blockingReason, 'CONSOLIDATION_BLOCKED');
    assert.equal(second.task.runtime.contractDiagnostics?.lastExitCondition?.ok, false);
    assert.equal(second.task.runtime.contractDiagnostics?.lastExitCondition?.failureCategory, 'OUTPUT');
    assert.equal(second.task.runtime.contractDiagnostics?.lastAcceptanceFailureCategory, 'exit_condition_mismatch');
    assert.equal(second.task.runtime.contractDiagnostics?.lastPendingCorrectionKind, 'AWAITING_OUTPUT_CORRECTION');
    assert.equal(second.task.runtime.contractDiagnostics?.lastCorrectionPromptMode, 'TARGETED_OUTPUT');
  } finally {
    removeDir(root);
  }
});

test('non-convergent correction loops require explicit operator guidance before another continue', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"first try","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"second try","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"third try","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Planner',
        goal: 'Plan the work',
        outputContract: '{"summary":"string","issues":[]}',
        exitCondition: '{"report":"required"}',
        dependencies: []
      }
    ]));

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    await runtime.tasks.continueTask({ taskId: submitted.command.taskId, userMessage: 'add the required report field' });
    const third = await runtime.tasks.continueTask({ taskId: submitted.command.taskId, userMessage: 'try again and satisfy the exit condition exactly' });

    assert.equal(third.task.runtime.contractDiagnostics?.correctionLoopNonConvergent, true);

    await assert.rejects(
      () => runtime.tasks.continueTask({ taskId: submitted.command.taskId }),
      /non-convergent correction loop/i
    );
  } finally {
    removeDir(root);
  }
});

test('pause and resume enforce lifecycle boundaries explicitly', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"partial","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","next_unit":"AGENT-001","reason":"keep going","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"resumed","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Solo', goal: 'Do work', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));

    await assert.rejects(
() => runtime.tasks.continueTask({ taskId: submitted.command.taskId }),
      /cannot continue task/i
    );

const paused = await runtime.tasks.pauseTask({ taskId: submitted.command.taskId }).catch(error => error);
    assert.equal(paused instanceof Error, true);

const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');

const pausedOk = await runtime.tasks.pauseTask({ taskId: submitted.command.taskId });
    const pausedTaskRecord = await foundation.tasks.get(submitted.command.taskId);
    assert.equal(pausedOk.task.runtime.lifecycleStatus, 'PAUSED');
    assert.equal(pausedTaskRecord.status, 'PAUSED');
    assert.equal(pausedTaskRecord.currentUnitId, 'AGENT-001');

    await assert.rejects(
() => runtime.tasks.continueTask({ taskId: submitted.command.taskId }),
      /cannot continue task/i
    );

const resumed = await runtime.tasks.resumeTask({ taskId: submitted.command.taskId });
    assert.equal(resumed.task.runtime.lifecycleStatus, 'COMPLETED');

const restartable = await runtime.tasks.restartTask({ taskId: submitted.command.taskId });
    assert.equal(restartable.task.runtime.lifecycleStatus, 'FAILED');
  } finally {
    removeDir(root);
  }
});

test('completed tasks require an explicit follow-up message and continue on the same thread when provided', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"first pass","details":"Initial delivery is complete.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"second pass","details":"The same thread completed a follow-up change.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        { id: 'AGENT-001', role: 'Solo', goal: 'Ship the task', outputContract: '{"summary":"string","details":"string","issues":[]}', dependencies: [] }
      ]),
      pathPolicy: 'task_workspace'
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(started.task.latestVisibleOutput?.summary, 'first pass');

    await assert.rejects(
      () => runtime.tasks.continueTask({ taskId: submitted.command.taskId }),
      /explicit follow-up message after the thread is completed/i
    );

    const continued = await runtime.tasks.continueTask({
      taskId: submitted.command.taskId,
      userMessage: 'Add one more detail to the same thread before we wrap.'
    });
    const events = await runtime.tasks.getTaskEvents(submitted.command.taskId);

    assert.equal(continued.task.definition.taskId, submitted.command.taskId);
    assert.equal(continued.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(continued.task.latestVisibleOutput?.summary, 'second pass');
    assert.equal(events.some((event) => event.type === 'TASK_RESUMED'), true);
  } finally {
    removeDir(root);
  }
});

test('delegated child tasks stay hidden from top-level task lists and surface through parent delegation summary', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        },
        runtime: {
          delegation: {
            enabled: true
          }
        }
      }
    });

    const parentSubmitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Ship the parent task.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]),
      pathPolicy: 'task_workspace'
    });
    const parentTaskId = parentSubmitted.command.taskId;
    const parentRecord = await foundation.taskRuntimes.get(parentTaskId);
    assert.ok(parentRecord);
    await foundation.taskRuntimes.save({
      ...parentRecord,
      runtime: {
        ...parentRecord.runtime,
        lifecycleStatus: 'RUNNING',
        engineStatus: 'IDLE',
        currentUnitId: 'AGENT-001',
        updatedAt: Date.now()
      }
    });

    const childSubmitted = await runtime.tasks.submitTask({
      title: 'Scoped child',
      intent: 'Handle a bounded child task inside the parent thread.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'task_workspace',
      metadata: {
        delegation: {
          parentTaskId,
          parentUnitId: 'AGENT-001',
          depth: 1,
          allowedToolIds: ['read-file', 'write-file'],
          inheritedProviderId: 'provider-main',
          artifactPolicy: 'workspace_only',
          title: 'Scoped child',
          role: 'SubSccAgent',
          goal: 'Return a scoped child result.',
          taskScope: 'Draft supporting notes only.',
          successCriteria: 'Return the scoped child summary.'
        }
      },
      units: [
        {
          id: 'SUBAGENT-001',
          role: 'SubSccAgent',
          goal: 'Return a scoped child result.',
          outputContract: '{"summary":"string"}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });
    const childTaskId = childSubmitted.command.taskId;
    const childRecord = await foundation.taskRuntimes.get(childTaskId);
    assert.ok(childRecord);
    await foundation.taskRuntimes.save({
      ...childRecord,
      runtime: {
        ...childRecord.runtime,
        lifecycleStatus: 'RUNNING',
        engineStatus: 'IDLE',
        currentUnitId: 'SUBAGENT-001',
        updatedAt: Date.now() + 1
      }
    });

    const summaries = await runtime.tasks.listTasks();
    assert.equal(summaries.some((task) => task.taskId === childTaskId), false);
    assert.equal(summaries.some((task) => task.taskId === parentTaskId), true);

    const parentTask = await runtime.tasks.getTask(parentTaskId);
    assert.equal(parentTask.delegationSummary?.activeChildTask?.taskId, childTaskId);
    assert.equal(parentTask.primaryAction?.kind, 'wait');
    assert.match(parentTask.nextActionSummary?.reason ?? '', /child task|SubSccAgent/i);

    const childTask = await runtime.tasks.getTask(childTaskId);
    assert.equal(childTask.delegationSummary?.canDelegate, false);
    assert.match(childTask.delegationSummary?.reason ?? '', /cannot delegate again/i);
  } finally {
    removeDir(root);
  }
});

test('delegate_subtask runs a controlled child task and returns its scoped result to the parent thread', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        },
        runtime: {
          delegation: {
            enabled: true
          }
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Delegated child launched.","details":"The parent thread has handed off one bounded child task and is waiting to integrate the scoped result.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"delegate_subtask","arguments":{"title":"Delegated note draft","role":"SubSccAgent","goal":"Draft a short scoped note for the parent thread.","taskScope":"Return only the scoped note and stay within the child boundary.","outputContract":{"summary":"string","details":"string","issues":[]},"allowedToolIds":["write-file"],"successCriteria":"Return the scoped note."}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":55,"decision":"CONTINUE","reason":"delegated child launched","next_unit":"AGENT-001","files_created":[]}',
      '[SUBAGENT-001_OUTPUT]{"summary":"Child scoped note complete.","details":"The child stayed inside the workspace boundary and returned its scoped result.","issues":[]}[/SUBAGENT-001_OUTPUT]\n'
        + '{"current_unit":"SUBAGENT-001","tool_name":"write_file","arguments":{"path":"scratch/child-note.md","content":"delegated note\\n"}}\n'
        + '{"current_unit":"SUBAGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"child done","files_created":["scratch/child-note.md"]}',
      '[AGENT-001_OUTPUT]{"summary":"Parent delivery complete.","details":"The parent thread delegated a bounded child task and integrated its scoped result.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"parent wrapped the child result","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Ship the parent task with one delegated child.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          delegationRequired: true,
          dependencies: []
        }
      ]),
      pathPolicy: 'task_workspace'
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const parentTaskId = submitted.command.taskId;

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.primaryAction?.kind, 'continue_thread');
    assert.equal(started.task.delegationSummary?.required, true);
    assert.equal(started.task.latestVisibleOutput?.summary, 'Delegated child launched.');

    const continued = await runtime.tasks.continueTask({
      taskId: parentTaskId,
      userMessage: 'Integrate the scoped child result into the parent delivery and finish this thread.'
    });
    if (continued.task.runtime.lifecycleStatus !== 'COMPLETED') {
      assert.fail(JSON.stringify({
        continuedTask: {
          lifecycleStatus: continued.task.runtime.lifecycleStatus,
          primaryAction: continued.task.primaryAction,
          nextActionSummary: continued.task.nextActionSummary,
          latestVisibleOutput: continued.task.latestVisibleOutput,
          completionSummary: continued.task.completionSummary,
          visibleToolActivities: continued.task.visibleToolActivities,
          delegationSummary: continued.task.delegationSummary,
          pendingApprovals: continued.task.pendingApprovals,
          lastError: continued.task.diagnostics?.lastError
        }
      }, null, 2));
    }
    assert.equal(continued.task.latestVisibleOutput?.summary, 'Parent delivery complete.');

    const summaries = await runtime.tasks.listTasks();
    assert.equal(summaries.some((task) => task.taskId === parentTaskId), true);
    assert.equal(summaries.some((task) => task.title === 'Delegated note draft'), false);

    const parentTask = await runtime.tasks.getTask(parentTaskId);
    const recentChild = parentTask.delegationSummary?.recentChildren?.[0] ?? null;
    assert.equal(parentTask.primaryAction?.kind, 'continue_thread');
    assert.equal(parentTask.delegationSummary?.activeChildTask, null);
    assert.equal(parentTask.delegationSummary?.required, true);
    assert.equal(parentTask.delegationSummary?.missingRequiredDelegation, false);
    assert.equal(recentChild?.title, 'Delegated note draft');
    assert.equal(recentChild?.lifecycleStatus, 'COMPLETED');
    assert.match(recentChild?.summary ?? '', /child scoped note complete/i);

    const childTaskId = recentChild?.taskId;
    assert.equal(typeof childTaskId, 'string');
    const childTask = await runtime.tasks.getTask(childTaskId);
    assert.equal(childTask.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(childTask.delegationSummary?.canDelegate, false);
    assert.match(childTask.delegationSummary?.reason ?? '', /cannot delegate again/i);
    assert.equal(childTask.latestVisibleOutput?.summary, 'Child scoped note complete.');
  } finally {
    removeDir(root);
  }
});

test('delegate_subtask can reuse the required child contract when provider omits most arguments', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        },
        runtime: {
          delegation: {
            enabled: true
          }
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Delegated child launched from the required contract.","details":"The parent reused the predefined child contract and is waiting for the scoped result.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"delegate_subtask","arguments":{"title":"Delegated note draft"}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":55,"decision":"CONTINUE","reason":"delegated child launched","next_unit":"AGENT-001","files_created":[]}',
      '[SUBAGENT-001_OUTPUT]{"summary":"Child scoped note complete.","details":"The child returned a scoped result from the required contract.","issues":[]}[/SUBAGENT-001_OUTPUT]\n'
        + '{"current_unit":"SUBAGENT-001","tool_name":"write_file","arguments":{"path":"scratch/child-note.md","content":"delegated note\\n"}}\n'
        + '{"current_unit":"SUBAGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"child done","files_created":["scratch/child-note.md"]}',
      '[AGENT-001_OUTPUT]{"summary":"Parent delivery complete.","details":"The parent integrated the delegated child result and completed delivery.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"parent wrapped the child result","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Ship the parent task with one delegated child.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          delegationRequired: true,
          delegationContract: {
            title: 'Delegated note draft',
            role: 'SubSccAgent',
            goal: 'Draft a short scoped note for the parent thread.',
            taskScope: 'Return only the scoped note and stay within the child boundary.',
            outputContract: '{"summary":"string","details":"string","issues":[]}',
            allowedToolIds: ['write-file'],
            successCriteria: 'Return the scoped note.'
          },
          dependencies: []
        }
      ]),
      pathPolicy: 'task_workspace'
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(started.task.delegationSummary?.required, true);
    assert.equal(started.task.latestVisibleOutput?.summary, 'Delegated child launched from the required contract.');

    const continued = await runtime.tasks.continueTask({
      taskId: submitted.command.taskId,
      userMessage: 'Finish the parent delivery after the child returns.'
    });
    assert.equal(continued.task.runtime.lifecycleStatus, 'COMPLETED');

    const parentTask = await runtime.tasks.getTask(submitted.command.taskId);
    const recentChild = parentTask.delegationSummary?.recentChildren?.[0] ?? null;
    assert.equal(recentChild?.title, 'Delegated note draft');
    assert.equal(recentChild?.lifecycleStatus, 'COMPLETED');
    assert.match(recentChild?.summary ?? '', /child scoped note complete/i);
  } finally {
    removeDir(root);
  }
});

test('delegate_subtask rejects child tool scopes that would require separate approval under ask mode', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        runtime: {
          delegation: {
            enabled: true
          }
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Delegation blocked.","details":"The child boundary requested approval-gated tools and was rejected before launch.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"delegate_subtask","arguments":{"title":"Approval-blocked child","role":"SubSccAgent","goal":"Try to draft a note with write access.","taskScope":"Stay within the child boundary.","outputContract":{"summary":"string","details":"string","issues":[]},"allowedToolIds":["write-file"],"successCriteria":"Return a scoped note."}}\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":30,"decision":"CONTINUE","reason":"delegation attempt blocked","next_unit":"AGENT-001","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Try to launch a delegated child that would require approval.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]),
      pathPolicy: 'task_workspace'
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(
      started.task.toolInvocations.some(
        (invocation) => invocation.toolId === 'delegate_subtask' && invocation.status === 'FAILED'
      ),
      true
    );
    assert.match(
      started.task.visibleToolActivities.find((activity) => activity.toolId === 'delegate_subtask')?.detail ?? '',
      /permission boundary|requires approval/i
    );
    assert.equal(started.task.delegationSummary?.activeChildTask, null);
    const summaries = await runtime.tasks.listTasks();
    assert.equal(summaries.some((task) => task.title === 'Approval-blocked child'), false);
  } finally {
    removeDir(root);
  }
});

test('required delegation blocks parent-only progress until a real child task is created', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        },
        runtime: {
          delegation: {
            enabled: true
          }
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"Parent tried to continue alone.","details":"No child task was launched.","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":25,"decision":"CONTINUE","reason":"started parent-only work","next_unit":"AGENT-001","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask({
      ...createTaskInput([
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Use one delegated child task before parent delivery.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          delegationRequired: true,
          dependencies: []
        }
      ]),
      pathPolicy: 'task_workspace'
    });

    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(started.task.delegationSummary?.required, true);
    assert.equal(started.task.delegationSummary?.missingRequiredDelegation, true);
    assert.equal(started.task.delegationSummary?.activeChildTask, null);
    assert.equal(started.task.primaryAction?.kind, 'continue_thread');
    assert.match(started.task.nextActionSummary?.reason ?? '', /delegation is required/i);
    assert.equal(started.task.latestVisibleOutput, null);
    assert.equal(
      started.task.conversations.some((message) => (
        message.role === 'assistant'
        && message.metadata?.source === 'assistant_summary'
        && message.metadata?.displayKind === 'recovery'
      )),
      true
    );
    assert.equal(debug.executionSummary.issueCategory, 'required_delegation_missing');
    assert.match(debug.executionSummary.issueSummary ?? '', /delegation is required/i);
  } finally {
    removeDir(root);
  }
});

test('command bus records operator messages and consumes queued inputs on next turn', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));

const queued = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'SEND_OPERATOR_MESSAGE',
      actor: 'tester',
      message: 'remember this preference'
    });
const started = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'START_TASK'
    });
const commands = await runtime.tasks.getTaskCommands(submitted.command.taskId);
const operatorMessages = await runtime.tasks.getTaskOperatorMessages(submitted.command.taskId);

    assert.equal(queued.task.runtime.pendingOperatorInputs.length, 1);
    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(started.task.runtime.promptBudget.operatorInputCount, 1);
    assert.equal(started.task.runtime.pendingOperatorInputs.length, 0);
    assert.equal(commands.some(record => record.type === 'SEND_OPERATOR_MESSAGE' && record.status === 'APPLIED'), true);
    assert.equal(commands.some(record => record.type === 'START_TASK' && record.status === 'APPLIED'), true);
    assert.equal(operatorMessages.some(record => record.status === 'CONSUMED'), true);
    const messageCommand = commands.find(record => record.type === 'SEND_OPERATOR_MESSAGE' && record.status === 'APPLIED');
    assert.equal(operatorMessages.some(record => record.commandId === messageCommand?.commandId), true);
  } finally {
    removeDir(root);
  }
});

test('interrupt command aborts provider execution and parks task at a safe point', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    let providerStartedResolve;
    const providerStarted = new Promise((resolve) => {
      providerStartedResolve = resolve;
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.com',
      model: 'mock-model'
    });
    foundation.providerClients.register('provider-main', {
      async complete(request) {
        providerStartedResolve();
        return new Promise((resolve, reject) => {
          request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by operator')), { once: true });
        });
      }
    });

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const startPromise = runtime.tasks.startTask({ taskId: submitted.command.taskId });
    await providerStarted;
const interruptResponse = await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'INTERRUPT_TASK',
      actor: 'tester',
      reason: 'stop now'
    });
    const started = await startPromise;
const commands = await runtime.tasks.getTaskCommands(submitted.command.taskId);
    const interrupts = started.task.interrupts;

    assert.equal(['RUNNING', 'PAUSED'].includes(interruptResponse.task.runtime.lifecycleStatus), true);
    assert.equal(started.task.runtime.lifecycleStatus, 'PAUSED');
    assert.equal(started.task.runtime.safePoint.stage, 'AFTER_PROVIDER');
    assert.equal(commands.some(record => record.type === 'INTERRUPT_TASK' && record.status === 'APPLIED'), true);
    const interruptCommand = commands.find(record => record.type === 'INTERRUPT_TASK' && record.status === 'APPLIED');
    assert.equal(interrupts.some(record => record.commandId === interruptCommand?.commandId), true);
  } finally {
    removeDir(root);
  }
});

test('dependency-scoped context excludes unrelated validated outputs from later prompts', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"alpha","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '[AGENT-002_OUTPUT]{"summary":"beta","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","next_unit":"AGENT-003","reason":"done","files_created":[]}\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-003_OUTPUT]{"summary":"gamma","issues":[]}[/AGENT-003_OUTPUT]\n'
        + '{"current_unit":"AGENT-003","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'A', goal: 'A', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-002', role: 'B', goal: 'B', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      {
        id: 'AGENT-003',
        role: 'C',
        goal: 'C',
        taskScope: 'Use only A output.',
        inputContract: 'Only use AGENT-001 output.',
        outputContract: '{"summary":"string","issues":[]}',
        exitCondition: '{"summary":"required"}',
        executionProfileId: 'analyze',
        permissionLevel: 'DEPENDENCY',
        dependencies: ['AGENT-001']
      }
    ]));
await runtime.tasks.startTask({ taskId: submitted.command.taskId });
const finished = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    const internalPrompts = debug.task.conversations
      .filter(message => message.role === 'runtime')
      .map(message => message.content);
    const finalPrompt = internalPrompts[internalPrompts.length - 1];

    assert.equal(finished.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(finished.task.conversations.some(message => message.role === 'runtime'), false);
    assert.match(finalPrompt, /AGENT-001/);
    assert.doesNotMatch(finalPrompt, /AGENT-002:.*beta/);
    assert.equal(finished.task.runtime.promptBudget.policyFilteredOutputCount >= 1, true);
  } finally {
    removeDir(root);
  }
});

test('structured inputContract limits visible fields from upstream validated outputs in later prompts', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"alpha","details":"private-detail","issues":["i1"]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","next_unit":"AGENT-002","reason":"done","files_created":[]}',
      '[AGENT-002_OUTPUT]{"summary":"beta","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'A', goal: 'A', outputContract: '{"summary":"string","details":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      {
        id: 'AGENT-002',
        role: 'B',
        goal: 'B',
        permissionLevel: 'GLOBAL',
        inputContract: '{"units":["AGENT-001"],"outputKeys":{"AGENT-001":["summary"]}}',
        outputContract: '{"summary":"string","issues":[]}',
        executionProfileId: 'analyze',
        dependencies: ['AGENT-001']
      }
    ]));
await runtime.tasks.startTask({ taskId: submitted.command.taskId });
const completed = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    const internalPrompts = debug.task.conversations
      .filter((message) => message.role === 'runtime')
      .map((message) => message.content);
    const finalPrompt = internalPrompts[internalPrompts.length - 1];

    assert.equal(completed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(completed.task.conversations.some((message) => message.role === 'runtime'), false);
    assert.match(finalPrompt, /summary/);
    assert.doesNotMatch(finalPrompt, /private-detail/);
    assert.equal(completed.task.runtime.contractDiagnostics?.topology.stageCount, 2);
    assert.equal(completed.task.runtime.contractDiagnostics?.topology.currentStageIndex, null);
    assert.deepEqual(
      completed.task.runtime.contractDiagnostics?.currentUnit?.memorySelector,
      undefined
    );
    assert.equal(
      completed.task.runtime.schedulerUnits['AGENT-002']?.contextPolicy?.scopedOutputKeysByUnitId?.['AGENT-001']?.includes('summary'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('planner summary is exposed and planner-first runtime advances by stage without skipping prerequisites', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"alpha","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '[AGENT-002_OUTPUT]{"summary":"beta","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","next_unit":"AGENT-003","reason":"skip ahead","files_created":[]}\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","next_unit":"AGENT-003","reason":"ready now","files_created":[]}',
      '[AGENT-003_OUTPUT]{"summary":"gamma","issues":[]}[/AGENT-003_OUTPUT]\n'
        + '{"current_unit":"AGENT-003","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'A', goal: 'A', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-002', role: 'B', goal: 'B', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-003', role: 'C', goal: 'C', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: ['AGENT-001', 'AGENT-002'] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const completed = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });

    assert.deepEqual(started.task.runtime.completedUnits, ['AGENT-001', 'AGENT-002']);
    assert.equal(started.task.runtime.currentUnitId, 'AGENT-003');
    assert.equal(started.task.runtime.planner?.stageCount, 2);
    assert.equal(started.task.runtime.planner?.currentStageIndex, 1);
    assert.deepEqual(started.task.runtime.planner?.currentStageUnitIds, ['AGENT-003']);
    assert.deepEqual(started.task.runtime.planner?.readyStageUnitIds, ['AGENT-003']);
    assert.equal(started.task.runtime.planner?.blockingReason, null);
    assert.equal(completed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(completed.task.runtime.planner?.currentStageIndex, null);
  } finally {
    removeDir(root);
  }
});

test('planner turn, tool batch execution, and consolidation surface runtime diagnostics through the existing task query', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write file',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [{ name: 'path', type: 'string', required: true }]
    });
    foundation.toolExecutors.register('write-file', {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            path: request.invocation.arguments.path,
            ok: true
          }
        });
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const events = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const eventTypes = events.map((event) => event.type);

    assert.equal(started.task.runtime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(started.task.runtime.planner?.executionPhase, 'CONSOLIDATING');
    assert.equal(started.task.runtime.planner?.blockingReason, 'CONSOLIDATION_BLOCKED');
    assert.equal(started.task.runtime.activeStage?.stageIndex, 0);
    assert.equal(started.task.runtime.pendingToolBatches.length, 1);
    assert.equal(started.task.runtime.pendingToolBatches[0].status, 'PARTIAL_APPROVAL_BLOCKED');
    assert.equal(started.task.runtime.consolidationState.status, 'CORRECTION_REQUIRED');
    assert.equal(eventTypes.includes('PLAN_CREATED'), true);
    assert.equal(eventTypes.includes('PLAN_VALIDATED'), true);
    assert.equal(eventTypes.includes('TOOL_BATCH_PLANNED'), true);
    assert.equal(eventTypes.includes('TOOL_BATCH_EXECUTED'), true);
    assert.equal(eventTypes.includes('CONSOLIDATION_STARTED'), true);
    assert.equal(eventTypes.includes('CONSOLIDATION_COMPLETED'), true);
  } finally {
    removeDir(root);
  }
});

test('structured memory selector narrows runtime memory without leaking global items', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"alpha","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","next_unit":"AGENT-002","reason":"done","files_created":[]}',
      '[AGENT-002_OUTPUT]{"summary":"beta","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'A', goal: 'A', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      {
        id: 'AGENT-002',
        role: 'B',
        goal: 'B',
        permissionLevel: 'GLOBAL',
        inputContract: '{"memoryUnits":["AGENT-001"],"memoryKinds":["MILESTONE"],"includeGlobalMemory":false}',
        outputContract: '{"summary":"string","issues":[]}',
        executionProfileId: 'analyze',
        dependencies: ['AGENT-001']
      }
    ]));
const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId, userMessage: 'remember this preference' });
const completed = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
    const finalPrompt = debug.task.conversations
      .filter((message) => message.role === 'runtime')
      .map((message) => message.content)
      .at(-1);

    assert.equal(completed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(completed.task.conversations.some((message) => message.role === 'runtime'), false);
    assert.equal(started.task.runtime.contractDiagnostics?.currentUnit?.memorySelector?.includeGlobalMemory, false);
    assert.deepEqual(started.task.runtime.contractDiagnostics?.currentUnit?.memorySelector?.memoryKinds, ['MILESTONE']);
    assert.deepEqual(started.task.runtime.contractDiagnostics?.currentUnit?.memorySelector?.unitIds, ['AGENT-001']);
    assert.match(finalPrompt, /TASK_MEMORY/);
    assert.doesNotMatch(finalPrompt, /active provider:/i);
  } finally {
    removeDir(root);
  }
});

test('planner-first runtime executes multi-unit stage without falling back to single-active mode', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"alpha","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '[AGENT-002_OUTPUT]{"summary":"beta","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":[]}\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      '[AGENT-003_OUTPUT]{"summary":"gamma","issues":[]}[/AGENT-003_OUTPUT]\n'
        + '{"current_unit":"AGENT-003","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'A', goal: 'A', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-002', role: 'B', goal: 'B', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: [] },
      { id: 'AGENT-003', role: 'C', goal: 'C', outputContract: '{"summary":"string","issues":[]}', executionProfileId: 'analyze', dependencies: ['AGENT-001', 'AGENT-002'] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const validatedAfterStage = await foundation.validatedOutputs.list(submitted.command.taskId);
    const stageEvents = await runtime.tasks.getTaskEvents(submitted.command.taskId);
    const completed = await runtime.tasks.continueTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.deepEqual(started.task.runtime.completedUnits, ['AGENT-001', 'AGENT-002']);
    assert.equal(started.task.runtime.currentUnitId, 'AGENT-003');
    assert.equal(started.task.runtime.planner?.executionPhase, 'IDLE');
    assert.equal(started.task.runtime.planner?.stageCount >= 2, true);
    assert.equal(started.task.runtime.contractDiagnostics?.topology.currentStageIndex, 1);
    assert.equal(validatedAfterStage.length, 2);
    assert.deepEqual(
      validatedAfterStage.map((record) => record.unitId).sort(),
      ['AGENT-001', 'AGENT-002']
    );
    assert.equal(stageEvents.some((event) => event.type === 'PLAN_CREATED'), true);
    assert.equal(stageEvents.some((event) => event.type === 'CONSOLIDATION_COMPLETED'), true);
    assert.doesNotMatch(String(started.task.runtime.planner?.blockingReason ?? ''), /falling back/i);

    assert.equal(completed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.deepEqual(completed.task.runtime.completedUnits, ['AGENT-001', 'AGENT-002', 'AGENT-003']);
  } finally {
    removeDir(root);
  }
});

test('exit condition failure keeps task in correction mode and records diagnostics', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"plan","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Planner',
        goal: 'Plan the work',
        outputContract: '{"summary":"string","issues":[]}',
        exitCondition: '{"report":"required"}',
        dependencies: []
      }
    ]));
const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(started.task.runtime.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
    assert.equal(started.task.runtime.completedUnits.length, 0);
    assert.equal(started.task.runtime.contractDiagnostics?.lastExitCondition?.ok, false);
    assert.equal(started.task.runtime.contractDiagnostics?.lastExitCondition?.failureCategory, 'OUTPUT');
    assert.equal(
      started.task.runtime.contractDiagnostics?.lastExitCondition?.issueCodes.includes('exit_condition_missing_output_key'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('http interfaces expose task commands queries and event stream coherently', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const submitResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submitPayload = await submitResponse.json();
    const taskId = submitPayload.command.taskId;

    const startResponse = await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const taskResponse = await fetch(`${baseUrl}/tasks/${taskId}`);
    const discussionResponse = await fetch(`${baseUrl}/tasks/${taskId}/discussion`);
    const debugResponse = await fetch(`${baseUrl}/tasks/${taskId}/debug`);
    const listResponse = await fetch(`${baseUrl}/tasks`);
    const eventsResponse = await fetch(`${baseUrl}/tasks/${taskId}/events`);
    const commandsResponse = await fetch(`${baseUrl}/tasks/${taskId}/commands`);
    const operatorMessageResponse = await fetch(`${baseUrl}/tasks/${taskId}/operator-messages`);
    const eventsReplayResponse = await fetch(`${baseUrl}/tasks/${taskId}/events?afterEventId=evt_missing`);
    const controller = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/tasks/${taskId}/events/stream`, {
      signal: controller.signal
    });
    const startedPayload = await startResponse.json();
    const taskPayload = await taskResponse.json();
    const discussionPayload = await discussionResponse.json();
    const debugPayload = await debugResponse.json();
    const listPayload = await listResponse.json();
    const eventsPayload = await eventsResponse.json();
    const commandsPayload = await commandsResponse.json();
    const operatorMessagePayload = await operatorMessageResponse.json();
    const replayPayload = await eventsReplayResponse.json();
    const reader = streamResponse.body.getReader();
    const firstChunk = await reader.read();
    controller.abort();
    const streamText = Buffer.from(firstChunk.value ?? []).toString('utf8');

    assert.equal(startedPayload.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(taskPayload.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(Array.isArray(taskPayload.conversations), true);
    assert.equal(taskPayload.conversations.some((message) => message.role === 'runtime'), false);
    assert.equal(Array.isArray(discussionPayload.conversations), true);
    assert.equal(discussionPayload.conversations.some((message) => message.role === 'runtime'), false);
    assert.equal(Array.isArray(debugPayload.task.conversations), true);
    assert.equal(debugPayload.task.conversations.some((message) => message.role === 'runtime'), true);
    assert.equal(taskPayload.diagnostics.lastError, null);
    assert.equal(listPayload.some(item => item.taskId === taskId && item.queueState === null), true);
    assert.equal(Array.isArray(eventsPayload), true);
    assert.equal(Array.isArray(commandsPayload), true);
    assert.equal(Array.isArray(operatorMessagePayload), true);
    assert.equal(Array.isArray(replayPayload), true);
    assert.equal(replayPayload.length, eventsPayload.length);
    assert.match(streamText, /event: TASK_SUBMITTED/);
    assert.match(streamText, /event: TURN_ANALYZED|event: TASK_COMPLETED/);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('task detail query normalizes legacy runtime records without throwing', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  const server = createBackendNewHttpServer(runtime);

  try {
    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const record = await foundation.taskRuntimes.get(submitted.command.taskId);
    await foundation.taskRuntimes.save({
      ...record,
      runtime: {
        ...record.runtime,
        planner: undefined,
        activeStage: null,
        pendingToolBatches: undefined,
        consolidationState: undefined,
        compressionPolicy: undefined,
        compressionDowngraded: undefined,
        batchAdmissionDecisions: undefined,
        unsafeBatchRejectedCount: undefined,
        guardrails: undefined,
        plannerFallbackRate: undefined,
        promptSectionAttribution: undefined,
        stageMemorySummary: undefined,
        capabilitySelectionSummary: undefined,
        retrievalSelectionSummary: undefined
      }
    });

    const task = await runtime.tasks.getTask(submitted.command.taskId);
    assert.equal(Array.isArray(task.runtime.pendingToolBatches), true);
    assert.equal(task.runtime.consolidationState.status, 'IDLE');
    assert.equal(typeof task.runtime.planner.stageCount, 'number');
    assert.equal(typeof task.runtime.promptSectionAttribution.taskMemoryChars, 'number');

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/tasks/${submitted.command.taskId}`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(payload.runtime.pendingToolBatches), true);
    assert.equal(payload.runtime.consolidationState.status, 'IDLE');
    assert.equal(typeof payload.runtime.planner.stageCount, 'number');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('task queries expose only public discussion and derive a safe visible output fallback', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const taskId = submitted.command.taskId;
    const now = Date.now();

    await foundation.conversations.append({
      messageId: 'msg_user_public',
      taskId,
      sessionId: null,
      correlationId: null,
      role: 'user',
      visibility: 'public',
      createdAt: now,
      content: 'Please wrap this up.',
      metadata: {}
    });
    await foundation.conversations.append({
      messageId: 'msg_assistant_public',
      taskId,
      sessionId: null,
      correlationId: null,
      role: 'assistant',
      visibility: 'public',
      createdAt: now + 1,
      content: 'Wrapped up. I created the final summary and no issues remain.',
      metadata: {
        unitId: 'AGENT-001'
      }
    });
    await foundation.conversations.append({
      messageId: 'msg_runtime_internal',
      taskId,
      sessionId: null,
      correlationId: null,
      role: 'runtime',
      visibility: 'internal',
      createdAt: now + 2,
      content: 'SYSTEM: internal provider-facing prompt',
      metadata: {}
    });

    const task = await runtime.tasks.getTask(taskId);
    const debug = await runtime.tasks.getTaskDebug(taskId);

    assert.equal(task.conversations.some((message) => message.role === 'runtime'), false);
    assert.equal(task.latestVisibleOutput?.source, 'assistant_fallback');
    assert.match(task.latestVisibleOutput?.summary ?? '', /Wrapped up/);
    assert.deepEqual(task.latestVisibleOutput?.issues ?? [], []);
    assert.deepEqual(task.latestVisibleOutput?.artifactDestinationPaths ?? [], []);
    assert.deepEqual(task.visibleToolActivities, []);
    assert.equal(debug.task.conversations.some((message) => message.role === 'runtime'), true);
  } finally {
    removeDir(root);
  }
});

test('task queries preserve producedFiles and artifactDestination contract evidence from validated output', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"docs normalized","details":"Wrote the normalized package and recorded the requested destination.","producedFiles":"normalized/index.md, normalized/guide.md","artifactDestination":"D:/AAA","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"normalized/index.md","content":"# Index\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["normalized/index.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'DocNormalizer',
        goal: 'Normalize docs',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"artifactDestination":"string","issues":[]}',
        executionProfileId: 'implement',
        dependencies: []
      }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.deepEqual(task.latestVisibleOutput?.artifactPaths, ['normalized/index.md', 'normalized/guide.md']);
    assert.equal(task.latestVisibleOutput?.artifactDestinationDir, 'D:/AAA');
    assert.deepEqual(debug.executionSummary.acceptance.evidence.explicitOutput.missingContractKeys, []);
    assert.equal(debug.executionSummary.acceptance.deterministic.contract.verdict, 'passed');
  } finally {
    removeDir(root);
  }
});

test('acceptance does not pass when the latest tracker is still in progress', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        },
        tools: {
          permissionMode: 'full'
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"normalized docs","details":"Files were written but final completion has not been declared.","producedFiles":["normalized/index.md"],"issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"normalized/index.md","content":"# Index\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":80,"decision":"CONTINUE","reason":"quality gate should be checked before final completion","files_created":["normalized/index.md"]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'DocNormalizer',
        goal: 'Normalize docs',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        dependencies: []
      }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(debug.executionSummary.acceptance.evidence.progressTracker.status, 'IN_PROGRESS');
    assert.equal(debug.executionSummary.acceptance.deterministic.verdict, 'failed');
    assert.equal(debug.executionSummary.acceptance.deterministic.outcome.verdict, 'failed');
    assert.equal(
      debug.executionSummary.acceptance.deterministic.outcome.failedChecks.includes('tracker_not_complete:in_progress'),
      true
    );
    assert.equal(
      debug.executionSummary.acceptance.deterministic.outcome.requiredNextEvidence.includes('emit_complete_progress_tracker_when_work_is_done'),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('terminal task can be hard-deleted and disappears from task queries', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const deleted = await runtime.tasks.deleteTask(submitted.command.taskId);
    const deletedAgain = await runtime.tasks.deleteTask(submitted.command.taskId);
    const listed = await runtime.tasks.listTasks();

    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);
    assert.equal(deletedAgain.ok, true);
    assert.equal(deletedAgain.deleted, false);
    assert.equal(listed.some((task) => task.taskId === submitted.command.taskId), false);
    await assert.rejects(
      () => runtime.tasks.getTask(submitted.command.taskId),
      /was not found/i
    );
  } finally {
    removeDir(root);
  }
});

test('terminal tasks can be archived, hidden from default lists, and restored with includeArchived or unarchive', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const archived = await runtime.tasks.archiveTask(submitted.command.taskId);
    const hiddenList = await runtime.tasks.listTasks();
    const archivedList = await runtime.tasks.listTasks(true);
    const archivedTask = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(archived.ok, true);
    assert.equal(archived.isArchived, true);
    assert.equal(hiddenList.some((task) => task.taskId === submitted.command.taskId), false);
    assert.equal(archivedList.some((task) => task.taskId === submitted.command.taskId && task.isArchived), true);
    assert.equal(archivedTask.isArchived, true);
    assert.equal(archivedTask.canArchive, false);
    assert.equal(archivedTask.canDelete, true);

    const unarchived = await runtime.tasks.unarchiveTask(submitted.command.taskId);
    const visibleList = await runtime.tasks.listTasks();
    const restoredTask = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(unarchived.ok, true);
    assert.equal(unarchived.isArchived, false);
    assert.equal(visibleList.some((task) => task.taskId === submitted.command.taskId), true);
    assert.equal(restoredTask.isArchived, false);

    const runningTask = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Runner', goal: 'Stay submitted', outputContract: '{"summary":"string"}', dependencies: [] }
    ]));
    await assert.rejects(
      () => runtime.tasks.archiveTask(runningTask.command.taskId),
      /must be terminal/i
    );
  } finally {
    removeDir(root);
  }
});

test('http delete rejects non-terminal tasks and removes terminal tasks', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const submittedResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submittedPayload = await submittedResponse.json();
    const taskId = submittedPayload.command.taskId;

    const rejectedDelete = await fetch(`${baseUrl}/tasks/${taskId}`, { method: 'DELETE' });
    const rejectedPayload = await rejectedDelete.json();

    assert.equal(rejectedDelete.status, 409);
    assert.match(String(rejectedPayload.error), /must be terminal/i);

    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    const deleteResponse = await fetch(`${baseUrl}/tasks/${taskId}`, { method: 'DELETE' });
    const deletePayload = await deleteResponse.json();
    const deleteAgainResponse = await fetch(`${baseUrl}/tasks/${taskId}`, { method: 'DELETE' });
    const deleteAgainPayload = await deleteAgainResponse.json();
    const listPayload = await fetch(`${baseUrl}/tasks`).then((response) => response.json());
    const missingResponse = await fetch(`${baseUrl}/tasks/${taskId}`);
    const missingPayload = await missingResponse.json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.ok, true);
    assert.equal(deletePayload.deleted, true);
    assert.equal(deleteAgainResponse.status, 200);
    assert.equal(deleteAgainPayload.ok, true);
    assert.equal(deleteAgainPayload.deleted, false);
    assert.equal(listPayload.some((task) => task.taskId === taskId), false);
    assert.equal(missingResponse.status, 404);
    assert.match(String(missingPayload.error), /was not found/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('http archive and unarchive hide archived tasks by default while includeArchived reveals them', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const submittedResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submittedPayload = await submittedResponse.json();
    const taskId = submittedPayload.command.taskId;

    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    const archiveResponse = await fetch(`${baseUrl}/tasks/${taskId}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const archivePayload = await archiveResponse.json();
    const listPayload = await fetch(`${baseUrl}/tasks`).then((response) => response.json());
    const archivedListPayload = await fetch(`${baseUrl}/tasks?includeArchived=true`).then((response) => response.json());
    const archivedTaskPayload = await fetch(`${baseUrl}/tasks/${taskId}`).then((response) => response.json());

    assert.equal(archiveResponse.status, 200);
    assert.equal(archivePayload.ok, true);
    assert.equal(archivePayload.isArchived, true);
    assert.equal(listPayload.some((task) => task.taskId === taskId), false);
    assert.equal(archivedListPayload.some((task) => task.taskId === taskId && task.isArchived), true);
    assert.equal(archivedTaskPayload.isArchived, true);

    const unarchiveResponse = await fetch(`${baseUrl}/tasks/${taskId}/unarchive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const unarchivePayload = await unarchiveResponse.json();
    const restoredListPayload = await fetch(`${baseUrl}/tasks`).then((response) => response.json());

    assert.equal(unarchiveResponse.status, 200);
    assert.equal(unarchivePayload.ok, true);
    assert.equal(unarchivePayload.isArchived, false);
    assert.equal(restoredListPayload.some((task) => task.taskId === taskId), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('http health endpoints and websocket stream stay consistent with runtime events', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    const ready = await fetch(`${baseUrl}/ready`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(ready.ok, true);

    const submitResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submitPayload = await submitResponse.json();
    const taskId = submitPayload.command.taskId;

    const wsMessages = [];
    const wsDone = new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${taskId}`);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        wsMessages.push(message);
        if (message.kind === 'ready') {
          socket.send(JSON.stringify({ type: 'ping', timestamp: 123 }));
        }
        if (message.kind === 'runtime_event' && message.event === 'TASK_COMPLETED') {
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });

    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    await wsDone;

    assert.equal(wsMessages.some(message => message.kind === 'ready'), true);
    assert.equal(wsMessages.some(message => message.kind === 'heartbeat' && message.timestamp === 123), true);
    assert.equal(wsMessages.some(message => message.kind === 'subscribed' && message.taskId === taskId), true);
    assert.equal(wsMessages.some(message => message.kind === 'runtime_event' && message.event === 'TASK_STARTED'), true);
    assert.equal(wsMessages.some(message => message.kind === 'runtime_event' && message.event === 'TASK_COMPLETED'), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('ready endpoint fails orchestration gating when queue is enabled without a worker', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  foundation.queue = {
    async listActive() {
      return [];
    }
  };
  foundation.config.worker.enabled = false;
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ready = await fetch(`${baseUrl}/ready`).then(response => response.json());

    assert.equal(ready.ok, false);
    assert.equal(ready.queueReady, false);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('http control plane rejects arbitrary browser origins and trusted localhost preflight exposes PATCH', async () => {
  const root = createTempRoot();
  const { runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const preflight = await fetch(`${baseUrl}/config`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'PATCH'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/);

    const hostile = await fetch(`${baseUrl}/tasks`, {
      headers: {
        Origin: 'https://evil.example'
      }
    });
    const hostilePayload = await hostile.json();

    assert.equal(hostile.status, 403);
    assert.match(hostilePayload.error, /control-plane requests must originate from loopback/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('config patch hot reloads tool permission mode for subsequent task turns', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":40,"decision":"CONTINUE","reason":"need approval","next_unit":"AGENT-001","files_created":["report.md"]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: {
          permissionMode: 'ask'
        }
      })
    });

    const submitResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submitPayload = await submitResponse.json();
    const taskId = submitPayload.command.taskId;

    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const task = await fetch(`${baseUrl}/tasks/${taskId}`).then(response => response.json());

    assert.equal(task.pendingApprovals.length, 1);
    assert.equal(task.toolInvocations[0].status, 'WAITING_APPROVAL');
    assert.equal(task.runtime.lifecycleStatus, 'RUNNING');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('websocket pushes live task snapshots when approvals and tool activity become visible', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"needs write","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":40,"decision":"CONTINUE","reason":"need approval","next_unit":"AGENT-001","files_created":["report.md"]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const submitResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Writer', goal: 'Write output', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submitPayload = await submitResponse.json();
    const taskId = submitPayload.command.taskId;

    const snapshots = [];
    const done = new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${taskId}`);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.kind === 'task_snapshot') {
          snapshots.push(message);
          const pendingCount = Array.isArray(message.task?.pendingApprovalItems) ? message.task.pendingApprovalItems.length : 0;
          const hasWaitingTool = Array.isArray(message.task?.visibleToolActivities)
            && message.task.visibleToolActivities.some((activity) => activity.status === 'WAITING_APPROVAL');
          if (pendingCount > 0 && hasWaitingTool) {
            socket.close();
            resolve();
          }
        }
      });
      socket.on('error', reject);
    });

    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    await done;

    assert.equal(
      snapshots.some((snapshot) => Array.isArray(snapshot.task?.pendingApprovalItems) && snapshot.task.pendingApprovalItems.length > 0),
      true
    );
    assert.equal(
      snapshots.some((snapshot) => Array.isArray(snapshot.task?.visibleToolActivities)
        && snapshot.task.visibleToolActivities.some((activity) => activity.status === 'WAITING_APPROVAL')),
      true
    );
  } finally {
    server.close();
    removeDir(root);
  }
});

test('websocket supports replay cursor and structured error envelopes', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const submitResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTaskInput([
        { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
      ]))
    });
    const submitPayload = await submitResponse.json();
    const taskId = submitPayload.command.taskId;
    await fetch(`${baseUrl}/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const events = await fetch(`${baseUrl}/tasks/${taskId}/events`).then(response => response.json());
    const afterEventId = events[0].eventId;

    const replayMessages = [];
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${taskId}&afterEventId=${afterEventId}`);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        replayMessages.push(message);
        if (message.kind === 'subscribed') {
          socket.send(JSON.stringify({ type: 'unknown' }));
        }
        if (message.kind === 'error') {
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });

    const replayedEvents = replayMessages.filter(message => message.kind === 'runtime_event');
    const errorMessage = replayMessages.find(message => message.kind === 'error');
    const subscribed = replayMessages.find(message => message.kind === 'subscribed');
    const snapshot = replayMessages.find(message => message.kind === 'task_snapshot');

    assert.equal(replayedEvents.length > 0, true);
    assert.equal(replayedEvents.some(message => message.data.eventId === afterEventId), false);
    assert.equal(subscribed.latestEventId !== undefined, true);
    assert.equal(Boolean(snapshot), true);
    assert.equal(snapshot.taskId, taskId);
    assert.equal(snapshot.task.definition.taskId, taskId);
    assert.equal(typeof snapshot.task.statusSummary.label, 'string');
    assert.equal(Array.isArray(snapshot.task.visibleToolActivities), true);
    assert.equal(errorMessage.code, 'missing_task_id');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('queue worker claims queued task and drives it to completion', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.config.queue.enabled = true;

    let queueRecord = null;
    let activeClaim = null;
    foundation.queue = {
      async enqueue(record) {
        queueRecord = { ...record };
      },
      async get(taskId) {
        return queueRecord && queueRecord.taskId === taskId ? { ...queueRecord } : null;
      },
      async claimNext({ workerId, now, leaseMs }) {
        if (!queueRecord || queueRecord.state !== 'QUEUED' || queueRecord.runAfter > now) {
          return null;
        }
        activeClaim = {
          workerId,
          taskId: queueRecord.taskId,
          claimToken: `claim_${now}`,
          claimedAt: now,
          leaseExpiresAt: now + leaseMs,
          attempt: (queueRecord.attemptCount ?? 0) + 1
        };
        queueRecord = {
          ...queueRecord,
          state: 'CLAIMED',
          leaseOwner: workerId,
          claimToken: activeClaim.claimToken,
          leaseExpiresAt: activeClaim.leaseExpiresAt,
          updatedAt: now
        };
        return { ...activeClaim };
      },
      async heartbeat() {
        return true;
      },
      async markRunning({ taskId, workerId, claimToken, now }) {
        if (!queueRecord || queueRecord.taskId !== taskId || queueRecord.claimToken !== claimToken || queueRecord.leaseOwner !== workerId) {
          return false;
        }
        queueRecord = {
          ...queueRecord,
          state: 'RUNNING',
          updatedAt: now
        };
        return true;
      },
      async complete({ taskId, workerId, claimToken, now }) {
        if (!queueRecord || queueRecord.taskId !== taskId || queueRecord.claimToken !== claimToken || queueRecord.leaseOwner !== workerId) {
          return false;
        }
        queueRecord = {
          ...queueRecord,
          state: 'COMPLETED',
          updatedAt: now
        };
        return true;
      },
      async fail({ taskId, now, error }) {
        if (!queueRecord || queueRecord.taskId !== taskId) {
          return null;
        }
        queueRecord = {
          ...queueRecord,
          state: 'DEAD_LETTER',
          lastError: error,
          updatedAt: now
        };
        return { ...queueRecord };
      },
      async releaseExpired() {
        return 0;
      },
      async listActive() {
        return queueRecord ? [{ ...queueRecord }] : [];
      }
    };

    const runtime = createBackendNewRuntime({ foundation });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close the task', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
const queued = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(queued.task.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(queueRecord.state, 'QUEUED');

    await runtime.worker.tick();
const completed = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(activeClaim.taskId, submitted.command.taskId);
    assert.equal(queueRecord.state, 'COMPLETED');
    assert.equal(completed.runtime.lifecycleStatus, 'COMPLETED');
  } finally {
    removeDir(root);
  }
});

test('runtime startup pauses stale running tasks after restart', async () => {
  const root = createTempRoot();
  try {
    const firstRuntimeState = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(firstRuntimeState.foundation, [
      '[AGENT-001_OUTPUT]{"summary":"phase-1","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":40,"decision":"CONTINUE","reason":"need another turn","next_unit":"AGENT-001","files_created":[]}'
    ]);

    const submitted = await firstRuntimeState.runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Analyst', goal: 'Iterate until done', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await firstRuntimeState.runtime.tasks.startTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'RUNNING');
    await firstRuntimeState.runtime.close();

    const restartedRuntimeState = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const recovered = await restartedRuntimeState.runtime.tasks.getTask(submitted.command.taskId);
    const events = await restartedRuntimeState.runtime.tasks.getTaskEvents(submitted.command.taskId);
    const listed = await restartedRuntimeState.runtime.tasks.listTasks();

    assert.equal(recovered.runtime.lifecycleStatus, 'PAUSED');
    assert.equal(listed.some(item => item.taskId === submitted.command.taskId && item.lifecycleStatus === 'PAUSED'), true);
    assert.equal(events.some(event => event.type === 'TASK_PAUSED' && event.payload.recovery === 'PROCESS_RESTART'), true);

    await restartedRuntimeState.runtime.close();
  } finally {
    removeDir(root);
  }
});

test('resume normalizes persisted runtime records before executing turns', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Resume old runtime safely', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const persisted = await foundation.taskRuntimes.get(submitted.command.taskId);

    delete persisted.runtime.pendingOperatorInputs;
    delete persisted.runtime.llmContextMessages;
    persisted.runtime.lifecycleStatus = 'PAUSED';
    persisted.runtime.engineStatus = 'PAUSED';
    persisted.runtime.updatedAt = Date.now();

    await foundation.taskRuntimes.save({
      ...persisted,
      latestCheckpointId: persisted.runtime.latestCheckpointId,
      updatedAt: persisted.runtime.updatedAt
    });

    const resumed = await runtime.tasks.resumeTask({ taskId: submitted.command.taskId });

    assert.equal(resumed.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.deepEqual(resumed.task.runtime.pendingOperatorInputs, []);
    assert.equal(Array.isArray(resumed.task.runtime.llmContextMessages), true);
  } finally {
    removeDir(root);
  }
});

test('queue worker dead letters synchronize runtime lifecycle to failed', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.config.queue.enabled = true;
    foundation.config.worker.enabled = false;
    foundation.config.queue.maxRetries = 1;

    let queueRecord = null;
    let activeClaim = null;
    let enqueueCount = 0;
    foundation.queue = {
      async enqueue(record) {
        enqueueCount += 1;
        if (enqueueCount > 1) {
          throw new Error('queue persistence failed');
        }
        queueRecord = { ...record };
      },
      async get(taskId) {
        return queueRecord && queueRecord.taskId === taskId ? { ...queueRecord } : null;
      },
      async claimNext({ workerId, now, leaseMs }) {
        if (!queueRecord || queueRecord.state !== 'QUEUED' || queueRecord.runAfter > now) {
          return null;
        }
        activeClaim = {
          workerId,
          taskId: queueRecord.taskId,
          claimToken: `claim_${now}`,
          claimedAt: now,
          leaseExpiresAt: now + leaseMs,
          attempt: (queueRecord.attemptCount ?? 0) + 1
        };
        queueRecord = {
          ...queueRecord,
          state: 'CLAIMED',
          leaseOwner: workerId,
          claimToken: activeClaim.claimToken,
          leaseExpiresAt: activeClaim.leaseExpiresAt,
          updatedAt: now
        };
        return { ...activeClaim };
      },
      async heartbeat() {
        return true;
      },
      async markRunning({ taskId, workerId, claimToken, now }) {
        if (!queueRecord || queueRecord.taskId !== taskId || queueRecord.claimToken !== claimToken || queueRecord.leaseOwner !== workerId) {
          return false;
        }
        queueRecord = {
          ...queueRecord,
          state: 'RUNNING',
          updatedAt: now
        };
        return true;
      },
      async complete() {
        return false;
      },
      async fail({ taskId, now, error }) {
        if (!queueRecord || queueRecord.taskId !== taskId) {
          return null;
        }
        queueRecord = {
          ...queueRecord,
          state: 'DEAD_LETTER',
          lastError: error,
          updatedAt: now
        };
        return { ...queueRecord };
      },
      async releaseExpired() {
        return 0;
      },
      async listActive() {
        return queueRecord ? [{ ...queueRecord }] : [];
      }
    };

    const runtime = createBackendNewRuntime({ foundation });
    registerProvider(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"phase-1","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":40,"decision":"CONTINUE","reason":"need another turn","next_unit":"AGENT-001","files_created":[]}'
    ]);
    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Trigger a worker failure', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const queued = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    assert.equal(queued.task.runtime.lifecycleStatus, 'RUNNING');

    await runtime.worker.tick();

    const task = await runtime.tasks.getTask(submitted.command.taskId);
    const summary = (await runtime.tasks.listTasks()).find(item => item.taskId === submitted.command.taskId);

    assert.equal(activeClaim.taskId, submitted.command.taskId);
    assert.equal(queueRecord.state, 'DEAD_LETTER');
    assert.equal(task.runtime.lifecycleStatus, 'FAILED');
    assert.equal(task.diagnostics.lastError, 'queue persistence failed');
    assert.equal(summary?.lifecycleStatus, 'FAILED');

    await runtime.close();
  } finally {
    removeDir(root);
  }
});

test('queue recovery endpoints expose dead letters and allow requeue', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.config.queue.enabled = true;

    let queueRecord = {
      taskId: 'task_dead',
      state: 'DEAD_LETTER',
      runAfter: Date.now(),
      priority: 0,
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 3,
      maxRetries: 3,
      lastError: 'boom',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    foundation.queue = {
      async enqueue(record) {
        queueRecord = { ...record };
      },
      async get(taskId) {
        return taskId === queueRecord.taskId ? { ...queueRecord } : null;
      },
      async claimNext() {
        return null;
      },
      async heartbeat() {
        return true;
      },
      async markRunning() {
        return true;
      },
      async complete() {
        return true;
      },
      async fail() {
        return { ...queueRecord };
      },
      async releaseExpired() {
        return 1;
      },
      async listActive() {
        return [{ ...queueRecord }];
      }
    };

    const runtime = createBackendNewRuntime({ foundation });
    const server = createBackendNewHttpServer(runtime);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const deadLetters = await fetch(`${baseUrl}/queue/dead-letters`).then(response => response.json());
    const active = await fetch(`${baseUrl}/queue/active`).then(response => response.json());
    const recovered = await fetch(`${baseUrl}/queue/recover-expired`, { method: 'POST' }).then(response => response.json());
    const requeued = await fetch(`${baseUrl}/queue/dead-letters/task_dead/requeue`, { method: 'POST' }).then(response => response.json());
const recoveryEvents = await runtime.tasks.getTaskEvents('task_dead');

    assert.equal(deadLetters.length, 1);
    assert.equal(active.length, 1);
    assert.equal(deadLetters[0].state, 'DEAD_LETTER');
    assert.equal(recovered.recovered, 1);
    assert.equal(requeued.ok, true);
    assert.equal(queueRecord.state, 'QUEUED');
    assert.equal(recoveryEvents.some(event => event.type === 'TASK_DEAD_LETTER_REQUEUED'), true);

    server.close();
  } finally {
    removeDir(root);
  }
});
