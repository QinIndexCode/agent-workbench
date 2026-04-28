const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createBackendNewFoundation,
  createBackendNewRuntime,
  StorageLayout,
  loadBackendNewConfig
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

function createRuntimeWithFoundation(options) {
  const foundation = createBackendNewFoundation(options);
  const runtime = createBackendNewRuntime({ foundation });
  return { foundation, runtime };
}

test('create-runtime persists a coherent success path across repositories and logs', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const result = await runtime.analysis.analyzeTurn({
      taskId: 'task_integration_ok',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);
    const taskLayout = layout.forTask('task_integration_ok');

    assert.match(result.sessionId, /^sess_/);
    assert.match(result.correlationId, /^corr_/);
    assert.equal(result.correctionHint, 'No correction mode is active.');

    assert.ok(fs.existsSync(taskLayout.traceLogPath));
    assert.ok(fs.existsSync(taskLayout.checkpointPath));
    assert.ok(fs.existsSync(taskLayout.taskRecordPath));
    assert.ok(fs.existsSync(taskLayout.taskMetadataPath));
    assert.ok(fs.existsSync(taskLayout.projectionPath));
    assert.ok(fs.existsSync(taskLayout.eventLogPath));
    assert.ok(fs.existsSync(layout.validatedOutputPath('task_integration_ok', 'AGENT-001')));
    assert.ok(fs.existsSync(layout.userProfilePath));
  } finally {
    removeDir(root);
  }
});

test('create-runtime routes missing tracker into correction mode and avoids validated output write when output invalid', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const result = await runtime.analysis.analyzeTurn({
      taskId: 'task_integration_fix',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse: '[AGENT-001_OUTPUT]{"summary":"ok"}[/AGENT-001_OUTPUT]'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);

    assert.match(result.correctionHint, /explicit output/i);
    const metadata = JSON.parse(fs.readFileSync(layout.forTask('task_integration_fix').taskMetadataPath, 'utf8'));
    const session = JSON.parse(fs.readFileSync(layout.sessionRecordPath(result.sessionId), 'utf8'));
    assert.equal(
      fs.existsSync(layout.validatedOutputPath('task_integration_fix', 'AGENT-001')),
      false
    );
    assert.equal(metadata.createdAt <= metadata.updatedAt, true);
    assert.equal(session.status, 'FAILED');
  } finally {
    removeDir(root);
  }
});

test('create-runtime analyzeTurn applies structured exit conditions consistently with runtime acceptance', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const result = await runtime.analysis.analyzeTurn({
      taskId: 'task_exit_condition_analysis',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    });

    assert.match(result.correctionHint, /explicit output/i);
  } finally {
    removeDir(root);
  }
});

test('create-runtime preserves task metadata createdAt across repeated turns', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    await runtime.analysis.analyzeTurn({
      taskId: 'task_metadata_stable',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);
    const metadataPath = layout.forTask('task_metadata_stable').taskMetadataPath;
    const firstMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    await new Promise(resolve => setTimeout(resolve, 10));

    await runtime.analysis.analyzeTurn({
      taskId: 'task_metadata_stable',
      currentUnitId: 'AGENT-002',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-002_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-002_OUTPUT]\n'
        + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":[]}'
    });

    const secondMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.equal(secondMetadata.createdAt, firstMetadata.createdAt);
    assert.equal(secondMetadata.updatedAt >= firstMetadata.updatedAt, true);
    assert.equal(secondMetadata.metadata.latestUnitId, 'AGENT-002');
    assert.equal(Array.isArray(secondMetadata.metadata.memory.keyMilestones), true);
  } finally {
    removeDir(root);
  }
});

test('create-runtime persists planned tool invocations with turn and checkpoint linkage', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    runtime.extensions.registerTool({
      id: 'search-files',
      name: 'search_files',
      description: 'Search files by pattern',
      source: 'builtin',
      effect: 'READ',
      riskLevel: 'LOW',
      inputSchema: [
        { name: 'pattern', type: 'string', required: true },
        { name: 'limit', type: 'number' }
      ]
    });

    const result = await runtime.analysis.analyzeTurn({
      taskId: 'task_integration_tools',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"search_files","arguments":{"pattern":"TODO","limit":2}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);
    const invocationsText = fs.readFileSync(layout.forTask('task_integration_tools').toolInvocationLogPath, 'utf8').trim();
    const invocations = invocationsText.split(/\r?\n/).map(line => JSON.parse(line));
    const validatedOutput = JSON.parse(
      fs.readFileSync(layout.validatedOutputPath('task_integration_tools', 'AGENT-001'), 'utf8')
    );

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].toolId, 'search_files');
    assert.equal(invocations[0].turnId, result.turnId);
    assert.equal(invocations[0].checkpointId, result.checkpointId);
    assert.equal(invocations[0].metadata.source, 'llm_response');
    assert.equal(validatedOutput.turnId, result.turnId);
    assert.equal(validatedOutput.checkpointId, result.checkpointId);
  } finally {
    removeDir(root);
  }
});

test('create-runtime marks risky tools as waiting approval in ask mode and denies writes in read-only mode', async () => {
  const root = createTempRoot();
  try {
    const askRuntime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: path.join(root, 'ask')
        },
        tools: {
          permissionMode: 'ask'
        }
      }
    });
    askRuntime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write files',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'path', type: 'string', required: true }
      ]
    });

    await askRuntime.analysis.analyzeTurn({
      taskId: 'task_tool_approval',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const askConfig = loadBackendNewConfig({ paths: { rootDir: path.join(root, 'ask') } }, { cwd: process.cwd(), env: {} });
    const askLayout = new StorageLayout(askConfig);
    const askInvocations = fs.readFileSync(askLayout.forTask('task_tool_approval').toolInvocationLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    const askApprovals = fs.readFileSync(askLayout.forTask('task_tool_approval').approvalLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    assert.equal(askInvocations.length, 1);
    assert.equal(askInvocations[0].status, 'WAITING_APPROVAL');
    assert.equal(askApprovals.length, 1);
    assert.equal(askApprovals[0].status, 'PENDING');
    assert.equal(askApprovals[0].invocationId, askInvocations[0].invocationId);

    const readOnlyRuntime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: path.join(root, 'readonly')
        },
        tools: {
          permissionMode: 'read-only'
        }
      }
    });
    readOnlyRuntime.extensions.registerTool({
      id: 'write-file',
      name: 'write_file',
      description: 'Write files',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'path', type: 'string', required: true }
      ]
    });

    await readOnlyRuntime.analysis.analyzeTurn({
      taskId: 'task_tool_denied',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const readOnlyConfig = loadBackendNewConfig(
      { paths: { rootDir: path.join(root, 'readonly') } },
      { cwd: process.cwd(), env: {} }
    );
    const readOnlyLayout = new StorageLayout(readOnlyConfig);
    assert.equal(
      fs.existsSync(readOnlyLayout.forTask('task_tool_denied').toolInvocationLogPath),
      false
    );
    assert.equal(
      fs.existsSync(readOnlyLayout.forTask('task_tool_denied').approvalLogPath),
      false
    );
  } finally {
    removeDir(root);
  }
});

test('create-runtime resolves approvals and reviews dispatch readiness without executing tools', async () => {
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
      description: 'Write files',
      source: 'builtin',
      effect: 'WRITE',
      riskLevel: 'MEDIUM',
      inputSchema: [
        { name: 'path', type: 'string', required: true }
      ]
    });
    foundation.toolExecutors.register('write-file', {
      async execute() {
        throw new Error('executor should not run during dispatch review');
      }
    });

    await runtime.analysis.analyzeTurn({
      taskId: 'task_tool_review',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"report.md","content":"# Report\\n"}}\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);
    const approvalLogPath = layout.forTask('task_tool_review').approvalLogPath;
    const invocationLogPath = layout.forTask('task_tool_review').toolInvocationLogPath;
    const pendingApproval = fs.readFileSync(approvalLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))[0];
    const invocation = fs.readFileSync(invocationLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))[0];

    const waiting = await runtime.analysis.reviewPendingToolDispatch('task_tool_review');
    assert.equal(waiting.summary.dispatchable, 0);
    assert.equal(waiting.summary.waitingApproval, 1);
    assert.equal(waiting.entries[0].nextInvocation.status, 'WAITING_APPROVAL');

    const resolved = await runtime.analysis.resolveToolApproval({
      taskId: 'task_tool_review',
      invocationId: pendingApproval.invocationId,
      resolution: {
        status: 'APPROVED',
        grantedBy: 'tester',
        reason: 'approved for test'
      }
    });

    const dispatchable = await runtime.analysis.reviewPendingToolDispatch('task_tool_review');
    assert.equal(resolved.status, 'APPROVED');
    assert.equal(dispatchable.summary.dispatchable, 1);
    assert.equal(dispatchable.summary.waitingApproval, 0);
    assert.equal(dispatchable.entries[0].invocation.invocationId, invocation.invocationId);
    assert.equal(dispatchable.entries[0].nextInvocation.status, 'PLANNED');
    assert.equal(dispatchable.entries[0].nextInvocation.metadata.latestApprovalStatus, 'APPROVED');
  } finally {
    removeDir(root);
  }
});

test('platform resource writes produce append-only audit trails alongside projections', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const created = await runtime.platform.upsertChannel({
      name: 'Ops channel',
      kind: 'webhook',
      status: 'ACTIVE',
      endpoint: 'https://example.test/hook',
      metadata: {
        team: 'ops'
      }
    });

    const trail = await runtime.platform.getAuditTrail('CHANNEL', created.resource.channelId);
    assert.equal(trail.resourceType, 'CHANNEL');
    assert.equal(trail.resourceId, created.resource.channelId);
    assert.equal(trail.commands.length, 1);
    assert.equal(trail.audits.length, 1);
    assert.equal(trail.commands[0].commandId, created.commandId);
    assert.equal(trail.audits[0].commandId, created.commandId);
    assert.equal(trail.audits[0].resourceId, created.resource.channelId);
    assert.equal(trail.audits[0].status, 'APPLIED');
  } finally {
    removeDir(root);
  }
});
