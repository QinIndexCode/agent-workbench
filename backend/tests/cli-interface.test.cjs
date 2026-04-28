const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { WebSocket } = require('ws');
const {
  createBackendNewFoundation,
  createBackendNewHttpServer,
  createBackendNewRuntime,
  runBackendNewCli
} = require('../dist');
const { formatTailLine } = require('../dist/interfaces/cli/shared.js');
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
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2
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

function createIoCapture() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout.push(chunk);
        }
      },
      stderr: {
        write(chunk) {
          stderr.push(chunk);
        }
      }
    },
    stdout,
    stderr
  };
}

function createInputStream(lines) {
  return Readable.from(lines.map((line) => `${line}\n`));
}

test('cli can submit list and get tasks through the stable REST interface', async () => {
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify({
      title: 'CLI Task',
      intent: 'Submit through CLI',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Closer',
          goal: 'Close',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    }), 'utf8');

    const submitCapture = createIoCapture();
    const submitExit = await runBackendNewCli({
      argv: ['tasks', 'submit', taskFile, '--server', serverUrl],
      io: submitCapture.io
    });
    assert.equal(submitExit, 0);
    const submitted = JSON.parse(submitCapture.stdout.join(''));

    const listCapture = createIoCapture();
    const listExit = await runBackendNewCli({
      argv: ['tasks', 'list', '--server', serverUrl],
      io: listCapture.io
    });
    assert.equal(listExit, 0);
    const listed = JSON.parse(listCapture.stdout.join(''));
    assert.equal(Array.isArray(listed), true);
    assert.equal(listed.some(item => item.taskId === submitted.command.taskId), true);

    await fetch(`${serverUrl}/tasks/${submitted.command.taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    const getCapture = createIoCapture();
    const getExit = await runBackendNewCli({
      argv: ['tasks', 'inspect', submitted.command.taskId, '--server', serverUrl],
      io: getCapture.io
    });
    assert.equal(getExit, 0);
    const detail = JSON.parse(getCapture.stdout.join(''));
    assert.equal(detail.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(Array.isArray(detail.conversations), true);

    const diagnosticsCapture = createIoCapture();
    const diagnosticsExit = await runBackendNewCli({
      argv: ['tasks', 'diagnostics', submitted.command.taskId, '--server', serverUrl],
      io: diagnosticsCapture.io
    });
    assert.equal(diagnosticsExit, 0);
    const diagnostics = JSON.parse(diagnosticsCapture.stdout.join(''));
    assert.equal(diagnostics.taskId, submitted.command.taskId);
    assert.equal(typeof diagnostics.planner.stageCount, 'number');
    assert.equal(diagnostics.summary.progressState, 'completed');
    assert.equal(diagnostics.summary.nextAction, 'Continue current thread');
    assert.equal(diagnostics.lifecycleStatus, detail.runtime.lifecycleStatus);
    assert.deepEqual(diagnostics.primaryAction, detail.primaryAction);
    assert.deepEqual(diagnostics.nextActionSummary, detail.nextActionSummary);
    assert.deepEqual(diagnostics.visibleToolActivities, detail.visibleToolActivities);
    assert.equal(diagnostics.lastError, detail.diagnostics.lastError);
    assert.equal(typeof diagnostics.providerSummary, 'object');
    assert.equal(typeof diagnostics.quality, 'object');
    assert.equal(typeof diagnostics.acceptance, 'object');
    assert.equal(diagnostics.acceptance.deterministic.verdict, 'passed');
    assert.equal(Array.isArray(diagnostics.acceptance.deterministic.contract.passedChecks), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli status returns compact task summary', async () => {
  const root = createTempRoot();
  const runtime = createBackendNewRuntime({
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'Status Task',
      intent: 'Inspect status',
      units: [
        {
          id: 'AGENT-001',
          role: 'Observer',
          goal: 'Observe',
          outputContract: '{"summary":"string"}',
          dependencies: []
        }
      ]
    });

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'status', submitted.command.taskId, '--server', serverUrl],
      io: capture.io
    });
    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.taskId, submitted.command.taskId);
    assert.equal(payload.lifecycleStatus, 'SUBMITTED');
    assert.equal(payload.progressState, 'ready_to_start');
    assert.equal(payload.nextAction, 'Start task');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli diagnostics exposes experience summary after approved experience reuse', async () => {
  const root = createTempRoot();
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
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const first = await runtime.tasks.submitTask(createReusableChecklistPayload());
    await runtime.tasks.startTask({ taskId: first.command.taskId, userMessage: 'Create the first reusable checklist artifact.' });

    const second = await runtime.tasks.submitTask(createReusableChecklistPayload({
      title: 'Second reusable checklist',
      intent: 'Repeat the same successful checklist pattern.'
    }));
    await runtime.tasks.startTask({ taskId: second.command.taskId, userMessage: 'Repeat the same reusable checklist artifact pattern.' });

    const proposals = await runtime.platform.listImprovementProposals();
    const experienceProposal = proposals.find((proposal) => proposal.taskId === second.command.taskId && proposal.kind === 'experience');
    assert.equal(Boolean(experienceProposal), true);
    await runtime.platform.approveImprovementProposal(experienceProposal.proposalId);

    const third = await runtime.tasks.submitTask(createReusableChecklistPayload({
      title: 'Third reusable checklist',
      intent: 'Use the approved checklist experience again.',
      metadata: {
        experienceProposalIds: [experienceProposal.proposalId]
      }
    }));
    await runtime.tasks.startTask({ taskId: third.command.taskId, userMessage: 'Use the approved checklist reference again.' });

    const diagnosticsCapture = createIoCapture();
    const diagnosticsExit = await runBackendNewCli({
      argv: ['tasks', 'diagnostics', third.command.taskId, '--server', serverUrl],
      io: diagnosticsCapture.io
    });
    assert.equal(diagnosticsExit, 0);
    const diagnostics = JSON.parse(diagnosticsCapture.stdout.join(''));
    assert.equal(Array.isArray(diagnostics.experienceSummary.selected), true);
    assert.equal(diagnostics.experienceSummary.selected[0].proposalId, experienceProposal.proposalId);
    assert.equal(diagnostics.experienceSummary.validationCandidates[0].successfulReuseTaskIds.includes(third.command.taskId), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli archive commands and structured task summary expose archive truth without mixing archived tasks into the default list', async () => {
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'Archive Task',
      intent: 'Complete then archive through the CLI.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Closer',
          goal: 'Finish',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const archiveCapture = createIoCapture();
    const archiveExit = await runBackendNewCli({
      argv: ['tasks', 'archive', submitted.command.taskId, '--server', serverUrl],
      io: archiveCapture.io
    });
    assert.equal(archiveExit, 0);
    const archivePayload = JSON.parse(archiveCapture.stdout.join(''));
    assert.equal(archivePayload.isArchived, true);

    const listCapture = createIoCapture();
    const listExit = await runBackendNewCli({
      argv: ['tasks', 'list', '--server', serverUrl],
      io: listCapture.io
    });
    assert.equal(listExit, 0);
    const defaultListPayload = JSON.parse(listCapture.stdout.join(''));
    assert.equal(defaultListPayload.some((task) => task.taskId === submitted.command.taskId), false);

    const archivedListCapture = createIoCapture();
    const archivedListExit = await runBackendNewCli({
      argv: ['tasks', 'list', '--include-archived', '--server', serverUrl],
      io: archivedListCapture.io
    });
    assert.equal(archivedListExit, 0);
    const archivedListPayload = JSON.parse(archivedListCapture.stdout.join(''));
    assert.equal(archivedListPayload.some((task) => task.taskId === submitted.command.taskId && task.isArchived), true);

    const statusCapture = createIoCapture();
    const statusExit = await runBackendNewCli({
      argv: ['tasks', 'status', submitted.command.taskId, '--server', serverUrl],
      io: statusCapture.io
    });
    assert.equal(statusExit, 0);
    const statusPayload = JSON.parse(statusCapture.stdout.join(''));
    assert.equal(statusPayload.isArchived, true);
    assert.equal(statusPayload.canArchive, false);
    assert.equal(statusPayload.canDelete, true);
    assert.deepEqual(statusPayload.archiveActions.available, ['unarchive', 'delete']);

    const unarchiveCapture = createIoCapture();
    const unarchiveExit = await runBackendNewCli({
      argv: ['tasks', 'unarchive', submitted.command.taskId, '--server', serverUrl],
      io: unarchiveCapture.io
    });
    assert.equal(unarchiveExit, 0);
    const unarchivePayload = JSON.parse(unarchiveCapture.stdout.join(''));
    assert.equal(unarchivePayload.isArchived, false);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli inspect exposes recommended-path guidance for unresolved artifact delivery', async () => {
  const root = createTempRoot();
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
    '[AGENT-001_OUTPUT]{"summary":"release notes drafted","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"docs/release-notes.md","content":"# Release Notes\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["docs/release-notes.md"]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'CLI unresolved artifact guidance',
      intent: 'Draft release notes and wait for a destination.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'ask_if_unclear',
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

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'inspect', submitted.command.taskId, '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.runtime.lifecycleStatus, 'RUNNING');
    assert.equal(payload.statusSummary.label, 'Use recommended path');
    assert.equal(payload.primaryAction.kind, 'use_recommended_path');
    assert.equal(payload.primaryAction.destinationDir, 'backend/docs');
    assert.equal(payload.nextActionSummary.label, 'Use recommended path');
    assert.match(payload.nextActionSummary.reason, /backend\/docs/);
    assert.deepEqual(payload.completionSummary.artifactPaths, ['docs/release-notes.md']);
    assert.equal(payload.completionSummary.artifactApplyStatus, null);
    assert.equal(Array.isArray(payload.visibleToolActivities), true);
    assert.equal(payload.visibleToolActivities.length >= 1, true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli inspect exposes delivered destination and same-thread continue action after safe artifact auto-completion', async () => {
  const root = createTempRoot();
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
    '[AGENT-001_OUTPUT]{"summary":"Created scratch/cli-handoff.md with handoff note content.","artifact":"scratch/cli-handoff.md","details":"The markdown handoff is ready for operator destination selection.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"scratch/cli-handoff.md","content":"# CLI handoff\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["scratch/cli-handoff.md"]}',
    '[AGENT-001_OUTPUT]{"summary":"CLI handoff delivered to backend/docs/cli-review.","artifact":"backend/docs/cli-review","details":"Operator confirmed destination and delivery is complete.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"Delivery confirmed.","next_unit":null,"files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'CLI delivered destination summary',
      intent: 'Create a markdown handoff artifact, apply it, then confirm the delivered destination.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'project_relative',
      preferredArtifactDir: 'backend/docs/cli-review',
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

    await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    await runtime.tasks.submitCommand({
      taskId: submitted.command.taskId,
      type: 'APPLY_ARTIFACTS',
      actor: 'tester',
      metadata: {
        overwrite: true
      }
    });

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'inspect', submitted.command.taskId, '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(payload.statusSummary.label, 'Delivered to');
    assert.equal(payload.primaryAction.kind, 'continue_thread');
    assert.equal(payload.nextActionSummary.label, 'Continue current thread');
    assert.equal(payload.completionSummary.artifactApplyStatus, 'APPLIED');
    assert.deepEqual(payload.completionSummary.artifactDestinationPaths, [
      'backend/docs/cli-review/scratch/cli-handoff.md'
    ]);
    assert.equal(payload.completionSummary.artifactDestinationDir, 'backend/docs/cli-review');
    assert.match(payload.completionSummary.summary, /delivered/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli status exposes structured approval actions for agent consumers', async () => {
  const root = createTempRoot();
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
  foundation.extensions.registerTool({
    id: 'write-file',
    name: 'write_file',
    description: 'Write file',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [{ name: 'path', type: 'string', required: true }]
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"needs approval","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/approval.md","content":"# Approval\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"waiting on tool approval","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'CLI approval summary',
      intent: 'Attempt a write that should block on approval.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Write only after approval.',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const invocationId = started.task.pendingApprovals[0].invocationId;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'status', submitted.command.taskId, '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.statusSummary.label, 'Approval required');
    assert.equal(payload.primaryAction.kind, 'approve');
    assert.equal(payload.pendingApprovals.length, 1);
    assert.equal(payload.pendingApprovals[0].toolName, 'write_file');
    assert.equal(payload.pendingApprovals[0].invocationId, invocationId);
    assert.equal(payload.approvalActions.required, true);
    assert.equal(payload.approvalActions.defaultInvocationId, invocationId);
    assert.match(String(payload.approvalActions.guidance), /Resolve the pending approval/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli platform improvements list exposes generated proposals after a terminal task', async () => {
  const root = createTempRoot();
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
    '[AGENT-001_OUTPUT]{"summary":"Prepared a reusable CLI note.","artifact":"reports/cli-note.md","details":"The note is ready for reuse.","issues":[]}' + '[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/cli-note.md","content":"# CLI note\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":["reports/cli-note.md"]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'CLI improvements task',
      intent: 'Generate a terminal task so improvement proposals exist.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Create a reusable CLI note',
          outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId, userMessage: 'Create a reusable CLI note artifact and preserve the path.' });

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['platform', 'improvements', 'list', '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(Array.isArray(payload), true);
    assert.equal(payload.some((proposal) => proposal.taskId === submitted.command.taskId && proposal.kind === 'lesson'), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('workspace chat human fallback shows explicit approval commands when a task is blocked on approval', async () => {
  const root = createTempRoot();
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
  foundation.extensions.registerTool({
    id: 'write-file',
    name: 'write_file',
    description: 'Write file',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [{ name: 'path', type: 'string', required: true }]
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"needs approval","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"reports/approval.md","content":"# Approval\\n"}}\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"waiting on tool approval","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'Chat approval guidance',
      intent: 'Start a task that blocks on approval.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Writer',
          goal: 'Wait for approval before writing.',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const invocationId = started.task.pendingApprovals[0].invocationId;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--format', 'human', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        `/switch ${submitted.command.taskId}`,
        '/task',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const output = capture.stdout.join('');
    assert.match(output, /Approval required: write_file/);
    assert.match(output, new RegExp(`/approve ${invocationId} or /reject ${invocationId}`));
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli submit accepts inline task flags without requiring a json file', async () => {
  const root = createTempRoot();
  const runtime = createBackendNewRuntime({
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: [
        'tasks',
        'submit',
        '--title', 'Inline Submit',
        '--intent', 'Create from flags',
        '--unit-id', 'AGENT-001',
        '--role', 'Closer',
        '--goal', 'Close the work',
        '--output-contract', '{"summary":"string"}',
        '--server', serverUrl
      ],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.command.ok, true);
    assert.equal(payload.task.definition.title, 'Inline Submit');
    assert.equal(payload.task.definition.units[0].role, 'Closer');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli run submits starts and tails a task from inline flags', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"done","details":"cloud ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: [
        'tasks',
        'run',
        '--title', 'Inline Run',
        '--intent', 'Run end to end from CLI',
        '--provider', 'provider-main',
        '--mode', 'tail',
        '--server', serverUrl
      ],
      io: capture.io,
      createWebSocket: (url) => new WebSocket(url)
    });

    assert.equal(exitCode, 0);
    const output = capture.stdout.join('');
    assert.match(output, /"submitted": true/);
    assert.match(output, /(TASK_COMPLETED|task_snapshot .*status=Completed)/);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli inspect exposes delegation summary and wait action for an active child task', async () => {
  const root = createTempRoot();
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
  registerProvider(foundation, []);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const parentSubmitted = await runtime.tasks.submitTask({
      title: 'CLI parent delegation summary',
      intent: 'Verify CLI delegation truth.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'task_workspace',
      units: [
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Ship the parent task.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
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
      title: 'CLI child task',
      intent: 'Return a scoped child result.',
      preferredProviderId: 'provider-main',
      pathPolicy: 'task_workspace',
      metadata: {
        delegation: {
          parentTaskId,
          parentUnitId: 'AGENT-001',
          depth: 1,
          allowedToolIds: ['read-file'],
          inheritedProviderId: 'provider-main',
          artifactPolicy: 'workspace_only',
          title: 'CLI child task',
          role: 'SubSccAgent',
          goal: 'Return a scoped child result.',
          taskScope: 'Stay inside the child boundary.',
          successCriteria: 'Return a scoped result.'
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
    const childRecord = await foundation.taskRuntimes.get(childSubmitted.command.taskId);
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

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'inspect', parentTaskId, '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.primaryAction?.kind, 'wait');
    assert.equal(payload.nextActionSummary?.label, 'Wait for delegated subtask');
    assert.match(payload.nextActionSummary?.reason ?? '', /child task .* still running/i);
    assert.equal(payload.delegationSummary?.activeChildTask?.title, 'CLI child task');
    assert.equal(payload.delegationSummary?.canDelegate, false);
    assert.match(payload.delegationSummary?.reason ?? '', /active delegated child task/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli inspect exposes required delegation blockers without guessing from raw runtime state', async () => {
  const root = createTempRoot();
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
    '[AGENT-001_OUTPUT]{"summary":"Parent continued alone.","details":"No delegated child was created.","issues":[]}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":20,"decision":"CONTINUE","reason":"parent-only progress","next_unit":"AGENT-001","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'CLI required delegation task',
      intent: 'Delegate one bounded child before parent delivery.',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Delegate one bounded child before parent delivery.',
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          executionProfileId: 'implement',
          delegationRequired: true,
          dependencies: []
        }
      ]
    });
    await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'inspect', submitted.command.taskId, '--server', serverUrl],
      io: capture.io
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(capture.stdout.join(''));
    assert.equal(payload.primaryAction?.kind, 'continue_thread');
    assert.equal(payload.delegationSummary?.required, true);
    assert.equal(payload.delegationSummary?.missingRequiredDelegation, true);
    assert.match(payload.delegationSummary?.reason ?? '', /delegation is required/i);
    assert.match(payload.nextActionSummary?.reason ?? '', /delegation is required/i);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli chat can create an interactive task session and emit ndjson envelopes', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"interactive done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'chat', '--provider', 'provider-main', '--format', 'ndjson', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'Investigate deployment drift',
        '/status',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const records = capture.stdout.join('').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.some((entry) => entry.type === 'session' && entry.action === 'created'), true);
    assert.equal(records.some((entry) => entry.type === 'event' && entry.record.type === 'TASK_COMPLETED'), true);
    assert.equal(records.some((entry) => entry.type === 'task' && entry.task.lifecycleStatus === 'COMPLETED'), true);
    assert.equal(records.some((entry) => entry.type === 'session' && entry.action === 'closed'), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli chat can attach to an existing task and expose diagnostics for agent-compatible interaction', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"attached done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'Interactive Attach',
      intent: 'Attach through chat',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Closer',
          goal: 'Close',
          outputContract: '{"summary":"string","details":"string"}',
          dependencies: []
        }
      ]
    });

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'chat', submitted.command.taskId, '--format', 'ndjson', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'Continue from attached task',
        '/diagnostics',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const records = capture.stdout.join('').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.some((entry) => entry.type === 'session' && entry.action === 'attached' && entry.taskId === submitted.command.taskId), true);
    assert.equal(records.some((entry) => entry.type === 'event' && entry.record.type === 'TASK_COMPLETED'), true);
    const diagnostics = records.find((entry) => entry.type === 'diagnostics');
    assert.equal(Boolean(diagnostics), true);
    assert.equal(diagnostics.taskId, submitted.command.taskId);
    assert.equal(typeof diagnostics.data.promptSectionAttribution, 'object');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('workspace chat continues the completed thread instead of creating a new task', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"first done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
    '[AGENT-001_OUTPUT]{"summary":"second done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'ndjson', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'First workspace request',
        'Second workspace request',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const records = capture.stdout.join('').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const created = records.filter((entry) => entry.type === 'session' && entry.action === 'created');
    assert.equal(created.length, 1);
    assert.equal(typeof created[0].taskId, 'string');
    assert.equal(records.filter((entry) => entry.type === 'event' && entry.record.type === 'TASK_COMPLETED').length >= 2, true);
    const resumed = records.find((entry) => entry.type === 'event' && entry.record.type === 'TASK_RESUMED');
    assert.equal(Boolean(resumed), true);
    assert.equal(resumed.record.payload.continuationMode, 'same_thread');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('workspace chat emits workspace view envelopes and supports line-mode human fallback without tty', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"view done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'human', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'Human fallback request',
        '/tasks',
        '/focus diagnostics',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const output = capture.stdout.join('');
    assert.match(output, /\[session\] Interactive task created/);
    assert.match(output, /Current status:/);
    assert.match(output, /Primary action:/);
    assert.match(output, /\[view:tasks\]/);
    assert.match(output, /\[view:focus\]/);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('human chat keeps ambiguous "check" prompts in a completed interactive thread when no tool evidence is required', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"CLI check completed successfully","details":"All checks passed. System is ready for use."}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'human', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'Provide a short human-readable completion message for this CLI check.',
        '/status',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const output = capture.stdout.join('');
    assert.match(output, /\[session\] Interactive task created/);
    assert.match(output, /Current status: Completed/);
    assert.doesNotMatch(output, /Current status: Action required/);

    const taskIdMatch = output.match(/Interactive task created \((task_[^)]+)\)/);
    assert.ok(taskIdMatch);
    const taskId = taskIdMatch[1];

    const statusCapture = createIoCapture();
    const statusExit = await runBackendNewCli({
      argv: ['tasks', 'status', taskId, '--server', serverUrl],
      io: statusCapture.io
    });
    assert.equal(statusExit, 0);
    const status = JSON.parse(statusCapture.stdout.join(''));
    assert.equal(status.lifecycleStatus, 'COMPLETED');
    assert.equal(status.progressState, 'completed');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('agent-oriented ndjson chat honors a Chinese language request', async () => {
  const root = createTempRoot();
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
    return {
      responseId: `resp_${Date.now()}`,
      providerId: 'provider-main',
      model: 'mock-model',
      outputText: useChinese
        ? '[AGENT-001_OUTPUT]{"summary":"已按中文处理","details":"当前结果保持中文。"}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
        : '[AGENT-001_OUTPUT]{"summary":"Completed in English","details":"Fallback English result."}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      finishReason: 'stop',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2
      },
      metadata: {}
    };
  });
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['tasks', 'chat', '--provider', 'provider-main', '--format', 'ndjson', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        '请用中文总结当前状态，并保持中文输出。',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    assert.match(capture.stdout.join(''), /已按中文处理/);
    assert.equal(capturedSystemPrompts.some((prompt) => prompt.includes('Preferred language: zh-CN')), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('human chat honors an English language request in its visible result', async () => {
  const root = createTempRoot();
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
    const useEnglish = systemPrompt.includes('Preferred language: en');
    return {
      responseId: `resp_${Date.now()}`,
      providerId: 'provider-main',
      model: 'mock-model',
      outputText: useEnglish
        ? '[AGENT-001_OUTPUT]{"summary":"Completed in English","details":"The operator asked to keep the conversation in English."}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
        : '[AGENT-001_OUTPUT]{"summary":"已按中文处理","details":"回退中文结果。"}[/AGENT-001_OUTPUT]\n'
          + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
      finishReason: 'stop',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2
      },
      metadata: {}
    };
  });
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'human', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'Please keep responding in English.',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    assert.match(capture.stdout.join(''), /Completed in English/);
    assert.equal(capturedSystemPrompts.some((prompt) => prompt.includes('Preferred language: en')), true);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('workspace chat /commands shows workspace command metadata and keeps reserved commands protected', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    cwd: root,
    config: {
      paths: {
        rootDir: path.join(root, 'data')
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"workspace done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  fs.mkdirSync(path.join(root, '.scc', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scc', 'project.md'), '# Project\n\nUse workspace commands when possible.\n', 'utf8');
  fs.writeFileSync(path.join(root, '.scc', 'docs.json'), '{\n  "sources": []\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.scc', 'commands', 'release-check.md'), '---\ndescription: Prepare release verification\nargs: <service>\nwhen: use before deploy\n---\nInspect ${args} and summarize blockers.\n', 'utf8');
  fs.writeFileSync(path.join(root, '.scc', 'commands', 'help.md'), '---\ndescription: should not override reserved help\n---\nignored\n', 'utf8');
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'human', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        '/commands',
        '/release-check api',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const output = capture.stdout.join('');
    assert.match(output, /\/release-check - desc=Prepare release verification; args=<service>; when=use before deploy/);
    assert.doesNotMatch(output, /\/help - desc=should not override reserved help/);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('workspace chat ndjson exposes recent task navigation and raw drill-down payloads', async () => {
  const root = createTempRoot();
  const { foundation, runtime } = createRuntimeWithFoundation({
    config: {
      paths: {
        rootDir: root
      }
    }
  });
  registerProvider(foundation, [
    '[AGENT-001_OUTPUT]{"summary":"first done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
    '[AGENT-001_OUTPUT]{"summary":"second done","details":"ok"}[/AGENT-001_OUTPUT]\n'
      + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  ]);
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const capture = createIoCapture();
    const exitCode = await runBackendNewCli({
      argv: ['chat', '--provider', 'provider-main', '--format', 'ndjson', '--server', serverUrl],
      io: capture.io,
      stdin: createInputStream([
        'First workspace prompt',
        'Second workspace prompt',
        '/tasks',
        '/raw',
        '/exit'
      ])
    });

    assert.equal(exitCode, 0);
    const records = capture.stdout.join('').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const tasksView = records.find((entry) => entry.type === 'view' && entry.view === 'tasks');
    assert.equal(Boolean(tasksView), true);
    assert.equal(Array.isArray(tasksView.data.tasks), true);
    assert.equal(tasksView.data.tasks.length >= 1, true);
    assert.equal(tasksView.data.tasks.some((item) => item.isActive === true), true);
    assert.equal(tasksView.data.tasks.filter((item) => item.isRecent === true).length >= 1, true);

    const rawView = records.find((entry) => entry.type === 'view' && entry.view === 'raw');
    assert.equal(Boolean(rawView), true);
    assert.equal(Array.isArray(rawView.data.recentTasks), true);
    assert.equal(Array.isArray(rawView.data.recentEvents), true);
    assert.equal(rawView.data.activeTaskId, tasksView.data.activeTaskId);
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli stream uses websocket first and emits ready subscribed heartbeat and runtime_event envelopes', async () => {
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const submitted = await runtime.tasks.submitTask({
      title: 'WS Stream Task',
      intent: 'Observe websocket stream',
      preferredProviderId: 'provider-main',
      units: [
        {
          id: 'AGENT-001',
          role: 'Closer',
          goal: 'Close',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });

    const capture = createIoCapture();
    const streamPromise = runBackendNewCli({
      argv: ['tasks', 'stream', submitted.command.taskId, '--server', serverUrl],
      io: capture.io,
      createWebSocket: (url) => new WebSocket(url)
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await fetch(`${serverUrl}/tasks/${submitted.command.taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    const exitCode = await streamPromise;
    assert.equal(exitCode, 0);
    const lines = capture.stdout.join('').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.some((line) => line.kind === 'ready'), true);
    assert.equal(lines.some((line) => line.kind === 'subscribed'), true);
    const snapshotLine = lines.find((line) => line.kind === 'task_snapshot' && line.taskSummary);
    assert.equal(Boolean(snapshotLine), true);
    assert.equal(snapshotLine.task.definition.taskId, submitted.command.taskId);
    assert.equal(typeof snapshotLine.taskSummary.statusSummary.label, 'string');
    assert.equal(Array.isArray(snapshotLine.taskSummary.pendingApprovalItems), true);
    assert.equal(Array.isArray(snapshotLine.taskSummary.visibleToolActivities), true);
    assert.equal(
      lines.some((line) => line.kind === 'runtime_event' && line.event === 'TASK_COMPLETED')
      || lines.some((line) => line.kind === 'task_snapshot' && line.task?.runtime?.lifecycleStatus === 'COMPLETED'),
      true
    );
    assert.equal(
      lines.some((line) => line.kind === 'runtime_event' && line.summary && line.summary.progressState === 'completed')
      || lines.some((line) => line.kind === 'task_snapshot' && line.taskSummary?.progressState === 'completed'),
      true
    );
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli falls back to SSE when websocket transport fails', async () => {
  const taskRecord = {
    definition: {
      taskId: 'task_sse',
      title: 'SSE Task',
      intent: 'Fallback',
      units: [],
      createdAt: Date.now()
    },
    runtime: {
      lifecycleStatus: 'RUNNING',
      engineStatus: 'RUNNING',
      currentUnitId: 'AGENT-001',
      updatedAt: Date.now()
    },
    queue: null,
    pendingApprovals: [],
    toolInvocations: [],
    conversations: [],
    events: [],
    diagnostics: {
      lastError: null,
      providerFailure: null
    },
    projection: null
  };
  const outputs = [];
  let sseRequested = false;
  const encoder = new TextEncoder();
  const fetchImpl = async (url) => {
    if (String(url).includes('/tasks/task_sse/events/stream')) {
      sseRequested = true;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('id: evt_1\nevent: TASK_COMPLETED\ndata: {"eventId":"evt_1","taskId":"task_sse","type":"TASK_COMPLETED","payload":{}}\n\n'));
            controller.close();
          }
        })
      };
    }
    if (String(url).endsWith('/tasks/task_sse')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(taskRecord)
      };
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const exitCode = await runBackendNewCli({
    argv: ['tasks', 'watch', 'task_sse', '--server', 'http://localhost:3030'],
    fetchImpl,
    io: {
      stdout: { write(chunk) { outputs.push(chunk); } },
      stderr: { write() {} }
    },
    createWebSocket: () => {
      throw new Error('ws unavailable');
    },
    sleep: async () => {}
  });

  assert.equal(exitCode, 0);
  assert.equal(sseRequested, true);
  assert.match(outputs.join(''), /TASK_COMPLETED/);
});

test('cli tail formatting surfaces live approval and tool activity summaries from task snapshots', () => {
  const approvalLine = formatTailLine({
    kind: 'task_snapshot',
    source: 'tasks.watch',
    summary: {
      statusLabel: 'Waiting approval',
      progressState: 'running',
      blockingReason: 'Waiting on operator approval.',
      nextAction: 'Approve tool invocation.',
      currentUnitId: 'AGENT-001'
    },
    taskSummary: {
      taskId: 'task_live_approval',
      lifecycleStatus: 'RUNNING',
      statusSummary: { label: 'Waiting approval' },
      blockingReason: 'Waiting on operator approval.',
      nextAction: 'Approve tool invocation.',
      pendingApprovalItems: [
        {
          invocationId: 'inv_write_file_1',
          toolName: 'write_file'
        }
      ],
      visibleToolActivities: []
    }
  });
  assert.match(approvalLine, /approval=write_file\(inv_write_file_1\)/);

  const toolLine = formatTailLine({
    kind: 'task_snapshot',
    source: 'tasks.watch',
    summary: {
      statusLabel: 'Running',
      progressState: 'running',
      blockingReason: 'Executing tools.',
      nextAction: 'Wait for tool completion.',
      currentUnitId: 'AGENT-001'
    },
    taskSummary: {
      taskId: 'task_live_tool',
      lifecycleStatus: 'RUNNING',
      statusSummary: { label: 'Running' },
      blockingReason: 'Executing tools.',
      nextAction: 'Wait for tool completion.',
      pendingApprovalItems: [],
      visibleToolActivities: [
        {
          toolId: 'write_file',
          status: 'RUNNING'
        }
      ]
    }
  });
  assert.match(toolLine, /tool=write_file\[RUNNING\]/);
});

test('cli falls back to REST polling when websocket and SSE are unavailable', async () => {
  const outputs = [];
  const taskRecord = {
    definition: {
      taskId: 'task_poll',
      title: 'Poll Task',
      intent: 'Fallback',
      units: [],
      createdAt: Date.now()
    },
    runtime: {
      lifecycleStatus: 'RUNNING',
      engineStatus: 'RUNNING',
      currentUnitId: 'AGENT-001',
      updatedAt: Date.now()
    },
    queue: null,
    pendingApprovals: [],
    toolInvocations: [],
    conversations: [],
    events: [],
    diagnostics: {
      lastError: null,
      providerFailure: null
    },
    projection: null
  };
  let polled = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('/tasks/task_poll/events/stream')) {
      return {
        ok: false,
        status: 404,
        body: null
      };
    }
    if (String(url).endsWith('/tasks/task_poll')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(taskRecord)
      };
    }
    if (String(url).includes('/tasks/task_poll/events')) {
      polled = true;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          {
            eventId: 'evt_2',
            taskId: 'task_poll',
            type: 'TASK_COMPLETED',
            payload: {}
          }
        ])
      };
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const exitCode = await runBackendNewCli({
    argv: ['tasks', 'tail', 'task_poll', '--server', 'http://localhost:3030'],
    fetchImpl,
    io: {
      stdout: { write(chunk) { outputs.push(chunk); } },
      stderr: { write() {} }
    },
    createWebSocket: () => {
      throw new Error('ws unavailable');
    },
    sleep: async () => {}
  });

  assert.equal(exitCode, 0);
  assert.equal(polled, true);
  assert.match(outputs.join(''), /TASK_COMPLETED/);
});

test('platform REST surfaces channels schedules memories statistics and system views', async () => {
  const root = createTempRoot();
  const runtime = createBackendNewRuntime({
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
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const createdChannel = await fetch(`${serverUrl}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Primary Channel',
        kind: 'webhook',
        status: 'ACTIVE',
        endpoint: 'https://example.com/hook',
        metadata: {}
      })
    }).then((response) => response.json());

    const createdSchedule = await fetch(`${serverUrl}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily',
        status: 'ACTIVE',
        cadence: 'daily@09:00',
        taskTemplate: { title: 'Daily' },
        metadata: {}
      })
    }).then((response) => response.json());

    const createdMemory = await fetch(`${serverUrl}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Global note',
        content: 'Remember this',
        scope: 'GLOBAL',
        tags: ['alpha'],
        metadata: {}
      })
    }).then((response) => response.json());

    const statistics = await fetch(`${serverUrl}/statistics`).then((response) => response.json());
    const system = await fetch(`${serverUrl}/system/startup`).then((response) => response.json());
    const diagnostics = await fetch(`${serverUrl}/tasks/diagnostics`).then((response) => response.json());

    assert.equal(createdChannel.resource.name, 'Primary Channel');
    assert.equal(createdSchedule.resource.name, 'Daily');
    assert.equal(createdMemory.resource.title, 'Global note');
    assert.equal(typeof statistics.channels, 'number');
    assert.equal(system.storage.driver, 'file');
    assert.equal(typeof diagnostics.totals.tasks, 'number');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('cli platform commands operate through the stable REST interface', async () => {
  const root = createTempRoot();
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
  const server = createBackendNewHttpServer(runtime);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const channelFile = path.join(root, 'channel.json');
    fs.writeFileSync(channelFile, JSON.stringify({
      name: 'CLI Channel',
      kind: 'email',
      status: 'ACTIVE',
      endpoint: 'mailto:test@example.com',
      metadata: {}
    }), 'utf8');

    const createCapture = createIoCapture();
    const createExit = await runBackendNewCli({
      argv: ['platform', 'channels', 'create', channelFile, '--server', serverUrl],
      io: createCapture.io
    });
    assert.equal(createExit, 0);
    const createdChannel = JSON.parse(createCapture.stdout.join(''));

    const listCapture = createIoCapture();
    const listExit = await runBackendNewCli({
      argv: ['platform', 'channels', 'list', '--server', serverUrl],
      io: listCapture.io
    });
    assert.equal(listExit, 0);
    const listedChannels = JSON.parse(listCapture.stdout.join(''));
    assert.equal(listedChannels.some((item) => item.channelId === createdChannel.resource.channelId), true);

    const providersCapture = createIoCapture();
    const providersExit = await runBackendNewCli({
      argv: ['providers', 'list', '--server', serverUrl],
      io: providersCapture.io
    });
    assert.equal(providersExit, 0);
    const providers = JSON.parse(providersCapture.stdout.join(''));
    assert.equal(providers.some((item) => item.profile.id === 'provider-main'), true);

    const legacyProvidersCapture = createIoCapture();
    const legacyProvidersExit = await runBackendNewCli({
      argv: ['platform', 'providers', 'list', '--server', serverUrl],
      io: legacyProvidersCapture.io
    });
    assert.equal(legacyProvidersExit, 0);
    const legacyProviders = JSON.parse(legacyProvidersCapture.stdout.join(''));
    assert.equal(legacyProviders.some((item) => item.profile.id === 'provider-main'), true);

    const presetsCapture = createIoCapture();
    const presetsExit = await runBackendNewCli({
      argv: ['platform', 'providers', 'presets', '--server', serverUrl],
      io: presetsCapture.io
    });
    assert.equal(presetsExit, 0);
    const presets = JSON.parse(presetsCapture.stdout.join(''));
    assert.equal(Array.isArray(presets), true);
    assert.equal(presets.some((item) => item.id === 'openai' && item.supportsQuickAdd === true), true);

    const secretCapture = createIoCapture();
    const secretExit = await runBackendNewCli({
      argv: [
        'platform',
        'providers',
        'secrets',
        'set',
        '--provider', 'provider-main',
        '--label', 'Primary Key',
        '--api-key', 'secret-value',
        '--server', serverUrl
      ],
      io: secretCapture.io
    });
    assert.equal(secretExit, 0);

    const secretListCapture = createIoCapture();
    const secretListExit = await runBackendNewCli({
      argv: ['platform', 'providers', 'secrets', '--server', serverUrl],
      io: secretListCapture.io
    });
    assert.equal(secretListExit, 0);
    const secrets = JSON.parse(secretListCapture.stdout.join(''));
    assert.equal(secrets.some((item) => item.provider === 'provider-main' && item.label === 'Primary Key'), true);

    const configCapture = createIoCapture();
    const configExit = await runBackendNewCli({
      argv: ['config', 'get', '--server', serverUrl],
      io: configCapture.io
    });
    assert.equal(configExit, 0);
    const config = JSON.parse(configCapture.stdout.join(''));
    assert.equal(config.current.server.port > 0, true);
  } finally {
    server.close();
    removeDir(root);
  }
});
