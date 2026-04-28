const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  applyToolInvocationTransition,
  createToolApprovalRecord,
  createDefaultToolExecutorCapability,
  createToolExecutionAuditDetails,
  classifyToolError,
  planToolInvocationDispatch,
  evaluateToolInvocationResumePolicy,
  findLatestApprovalForInvocation,
  createToolFailureResult,
  createToolInvocationRecord,
  createToolSuccessResult,
  buildReadFileToolOutput,
  dispatchToolExecutor,
  evaluateToolExecutionPolicy,
  ExtensionRegistry,
  FileStorageAdapter,
  FileToolApprovalRepository,
  FileToolInvocationRepository,
  FileValidatedOutputRepository,
  resolveToolApprovalRecord,
  StorageLayout,
  ToolExecutorRegistry,
  loadBackendNewConfig,
  validateBuiltinRunCommandSafety,
  validateBuiltinWriteFileContent,
  validateToolInvocationRequest
} = require('../dist');
const { buildCurrentTurnToolContextMessages } = require('../dist/application/tasks/turns/turn-runtime-state-builder.js');
const { gateProviderRequestContext } = require('../dist/application/tasks/turns/request-context-gating.js');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('validated output repository stores structured unit output', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const outputs = new FileValidatedOutputRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.outputsDir);

    await outputs.save({
      taskId: 'task_output',
      unitId: 'AGENT-001',
      sessionId: 'sess_output',
      correlationId: 'corr_output',
      turnId: 'turn_output',
      checkpointId: 'chk_turn_output_10',
      contractKeys: ['summary', 'issues'],
      wrapper: 'square',
      raw: '{"summary":"ok","issues":[]}',
      parsed: {
        summary: 'ok',
        issues: []
      },
      validatedAt: 10,
      metadata: {
        validator: 'test'
      }
    });

    const stored = await outputs.get('task_output', 'AGENT-001');
    assert.equal(stored.contractKeys.length, 2);
    assert.equal(stored.turnId, 'turn_output');
    assert.equal(stored.wrapper, 'square');
    assert.equal(stored.parsed.summary, 'ok');
  } finally {
    removeDir(root);
  }
});

test('tool invocation validation uses extension registry as single source of truth', () => {
  const registry = new ExtensionRegistry();
  registry.registerTool({
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

  const ok = validateToolInvocationRequest(registry, {
    taskId: 'task_tools',
    unitId: 'AGENT-002',
    toolName: 'search-files',
    arguments: {
      pattern: 'TODO',
      limit: 3
    }
  });
  assert.equal(ok.ok, true);

  const bad = validateToolInvocationRequest(registry, {
    taskId: 'task_tools',
    unitId: 'AGENT-002',
    toolName: 'search-files',
    arguments: {
      limit: 'three'
    }
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /Missing required argument "pattern"/);
  assert.match(bad.errors.join(' '), /type "number"/);
});

test('tool invocation validation allows structured write_file content variants and rejects ambiguous payloads', () => {
  const registry = new ExtensionRegistry();
  registry.registerTool({
    id: 'write-file',
    name: 'write_file',
    description: 'Write files',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string' },
      { name: 'content_lines', type: 'array' },
      { name: 'content_json', type: 'object' }
    ]
  });

  const jsonOk = validateToolInvocationRequest(registry, {
    taskId: 'task_tools',
    unitId: 'AGENT-001',
    toolName: 'write_file',
    arguments: {
      path: 'quality/database-design.json',
      content_json: { ok: true }
    }
  });
  assert.equal(jsonOk.ok, true);

  const linesOk = validateToolInvocationRequest(registry, {
    taskId: 'task_tools',
    unitId: 'AGENT-001',
    toolName: 'write_file',
    arguments: {
      path: 'README.md',
      content_lines: ['# Title', '', 'Body']
    }
  });
  assert.equal(linesOk.ok, true);

  const ambiguous = validateToolInvocationRequest(registry, {
    taskId: 'task_tools',
    unitId: 'AGENT-001',
    toolName: 'write_file',
    arguments: {
      path: 'README.md',
      content: 'hello',
      content_lines: ['hello']
    }
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.errors.join(' '), /only one content source/i);
});

test('tool execution policy respects full ask and read-only permission modes', () => {
  const readTool = {
    id: 'search-files',
    name: 'search_files',
    description: 'Search files',
    source: 'builtin',
    effect: 'READ',
    riskLevel: 'LOW',
    inputSchema: []
  };
  const writeTool = {
    id: 'write-file',
    name: 'write_file',
    description: 'Write files',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: []
  };
  const networkTool = {
    id: 'fetch-url',
    name: 'fetch_url',
    description: 'Fetch url',
    source: 'builtin',
    effect: 'NETWORK',
    riskLevel: 'HIGH',
    inputSchema: []
  };

  const fullConfig = loadBackendNewConfig({ tools: { permissionMode: 'full' } }, { cwd: process.cwd(), env: {} });
  const askConfig = loadBackendNewConfig({ tools: { permissionMode: 'ask' } }, { cwd: process.cwd(), env: {} });
  const readOnlyConfig = loadBackendNewConfig(
    { tools: { permissionMode: 'read-only' } },
    { cwd: process.cwd(), env: {} }
  );

  assert.equal(evaluateToolExecutionPolicy({ config: fullConfig, tool: writeTool }).decision, 'ALLOW');
  assert.equal(evaluateToolExecutionPolicy({ config: askConfig, tool: readTool }).decision, 'ALLOW');
  assert.equal(evaluateToolExecutionPolicy({ config: askConfig, tool: writeTool }).decision, 'REQUIRE_APPROVAL');
  assert.equal(evaluateToolExecutionPolicy({ config: askConfig, tool: networkTool }).decision, 'REQUIRE_APPROVAL');
  assert.equal(evaluateToolExecutionPolicy({ config: readOnlyConfig, tool: readTool }).decision, 'ALLOW');
  assert.equal(evaluateToolExecutionPolicy({ config: readOnlyConfig, tool: writeTool }).decision, 'DENY');
  assert.equal(evaluateToolExecutionPolicy({ config: readOnlyConfig, tool: networkTool }).decision, 'DENY');
});

test('tool result envelope and error taxonomy provide stable outcome semantics', () => {
  const success = createToolSuccessResult({
    output: { matches: 4 },
    message: 'done',
    metadata: { source: 'test' }
  });
  const failure = createToolFailureResult({
    kind: classifyToolError('Permission denied while writing file'),
    message: 'Permission denied while writing file',
    metadata: { source: 'test' }
  });

  assert.equal(success.ok, true);
  assert.equal(success.kind, null);
  assert.equal(success.output.matches, 4);
  assert.equal(failure.ok, false);
  assert.equal(failure.kind, 'PERMISSION');
  assert.equal(failure.output, null);
});

test('validateBuiltinWriteFileContent rejects invalid quality json before a write executes', () => {
  const invalid = validateBuiltinWriteFileContent(
    'quality/system-audit.json',
    '{"profile":"system_audit","facts":[{"name":"free_memory","sourceRegex":"FreePhysicalMemory\\s*:\\s*(\\d+)"}]}'
  );
  const valid = validateBuiltinWriteFileContent(
    'quality/system-audit.json',
    '{"profile":"system_audit","facts":[{"name":"free_memory","sourceRegex":"FreePhysicalMemory\\\\s*:\\\\s*(\\\\d+)"}]}'
  );
  const unrelated = validateBuiltinWriteFileContent(
    'reports/system-health.md',
    '# System Health\n'
  );

  assert.match(invalid, /Invalid JSON for quality evidence file/i);
  assert.equal(valid, null);
  assert.equal(unrelated, null);
});

test('builtin write_file executor supports content_json and content_lines payloads', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: root, env: {} });
    const registry = new ToolExecutorRegistry();
    const extensionRegistry = new ExtensionRegistry();
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const foundation = {
      config,
      extensions: extensionRegistry,
      toolExecutors: registry
    };
    const { registerBuiltinToolAdapters } = require('../dist');
    registerBuiltinToolAdapters(foundation, extensionRegistry, registry);

    const writeTool = extensionRegistry.findTool('write_file');
    const writeExecutor = registry.resolve(writeTool);
    const commonContext = {
      config,
      sessionId: 'sess_write_variants',
      correlationId: 'corr_write_variants',
      turnId: 'turn_write_variants',
      checkpointId: null
    };

    const taskId = 'task_write_variants';
    await storage.ensureDir(layout.forTask(taskId).workspaceDir);

    const jsonResult = await writeExecutor.execute({
      tool: writeTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'write_file',
        arguments: {
          path: 'quality/database-design.json',
          content_json: { profile: 'database_near_mysql_design', designFiles: ['database-lab/design/README.md'] }
        }
      },
      context: commonContext
    });
    assert.equal(jsonResult.ok, true);

    const linesResult = await writeExecutor.execute({
      tool: writeTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'write_file',
        arguments: {
          path: 'database-lab/prototype/README.md',
          content_lines: ['# Database Lab Prototype', '', 'Grounded scaffold.']
        }
      },
      context: commonContext
    });
    assert.equal(linesResult.ok, true);

    const qualityContent = await fs.readFile(path.join(layout.forTask(taskId).workspaceDir, 'quality', 'database-design.json'), 'utf8');
    const readmeContent = await fs.readFile(path.join(layout.forTask(taskId).workspaceDir, 'database-lab', 'prototype', 'README.md'), 'utf8');
    assert.match(qualityContent, /"profile": "database_near_mysql_design"/);
    assert.equal(readmeContent, '# Database Lab Prototype\n\nGrounded scaffold.');
  } finally {
    removeDir(root);
  }
});

test('buildReadFileToolOutput supports segmented line reads and max char truncation', () => {
  const output = buildReadFileToolOutput({
    path: 'briefing/live-provider-brief.md',
    content: ['alpha', 'beta', 'gamma', 'delta'].join('\n'),
    argumentsRecord: {
      start_line: 2,
      end_line: 4,
      max_chars: 8
    }
  });

  assert.equal(output.path, 'briefing/live-provider-brief.md');
  assert.equal(output.content, 'beta\ngam');
  assert.equal(output.selectedChars, 8);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.selection, {
    startLine: 2,
    endLine: 4,
    totalLines: 4,
    maxChars: 8
  });
});

test('buildCurrentTurnToolContextMessages preserves read_file content for the next correction turn', () => {
  const invocation = {
    invocationId: 'tool_1',
    correlationId: 'corr_1',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    taskId: 'task_1',
    unitId: 'AGENT-001',
    checkpointId: 'chk_1',
    toolId: 'read-file',
    arguments: { path: 'briefing/live-provider-brief.md' },
    status: 'SUCCEEDED',
    startedAt: 10,
    endedAt: 11,
    result: {
      path: 'briefing/live-provider-brief.md',
      content: 'Constraint: return one explicit operator note.\nDo not re-read the file.',
      totalChars: 67,
      selectedChars: 67,
      truncated: false,
      selection: {
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        maxChars: null
      }
    },
    error: null,
    metadata: {}
  };

  const messages = buildCurrentTurnToolContextMessages({
    invocations: [invocation],
    currentUnitId: 'AGENT-001',
    turnId: 'turn_1',
    maxContentChars: 200
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'tool');
  assert.equal(messages[0].metadata.source, 'tool_result');
  assert.match(messages[0].content, /Tool read_file succeeded/i);
  assert.match(messages[0].content, /Constraint: return one explicit operator note\./i);
  assert.match(messages[0].content, /Do not re-read the file\./i);
});

test('buildCurrentTurnToolContextMessages preserves run_command result streams', () => {
  const invocation = {
    invocationId: 'tool_run_1',
    correlationId: 'corr_run_1',
    sessionId: 'sess_run_1',
    turnId: 'turn_run_1',
    taskId: 'task_1',
    unitId: 'AGENT-001',
    checkpointId: 'chk_run_1',
    toolId: 'run_command',
    arguments: { command: 'npm test' },
    status: 'SUCCEEDED',
    startedAt: 10,
    endedAt: 25,
    result: {
      command: 'npm test',
      effectiveCommand: 'npm test',
      cwd: 'D:/workspace',
      exitCode: 0,
      stdout: 'all tests passed',
      stderr: '',
      durationMs: 15,
      timedOut: false,
      shell: 'powershell'
    },
    error: null,
    metadata: {}
  };

  const messages = buildCurrentTurnToolContextMessages({
    invocations: [invocation],
    currentUnitId: 'AGENT-001',
    turnId: 'turn_run_1',
    maxContentChars: 300
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Tool run_command succeeded with exit code 0/i);
  assert.match(messages[0].content, /Requested command: npm test/i);
  assert.match(messages[0].content, /stdout:\s+all tests passed/i);
  assert.match(messages[0].content, /stderr:\s+\(empty\)/i);
});

test('gateProviderRequestContext drops verbose assistant tool payloads but keeps tool results', () => {
  const config = loadBackendNewConfig({}, { cwd: process.cwd(), env: {} });
  const result = gateProviderRequestContext({
    config,
    current: [
      {
        role: 'assistant',
        content: '{"tool":"write_file","arguments":{"path":"database-lab/design/architecture.md","content":"' + 'x'.repeat(2000) + '"}}',
        compressed: false,
        metadata: { unitId: 'AGENT-001' },
      },
      {
        role: 'tool',
        content: 'Tool write_file succeeded.\nResult: {"path":"database-lab/design/architecture.md","bytesWritten":2048}',
        compressed: false,
        metadata: {
          unitId: 'AGENT-001',
          source: 'tool_result',
          invocationId: 'tool_1',
          toolId: 'write_file',
          status: 'SUCCEEDED',
        },
      },
      {
        role: 'user',
        content: 'Continue with the next narrow repair batch.',
        compressed: false,
        metadata: { unitId: 'AGENT-001' },
      },
    ],
    additions: [],
    stageUnitIds: ['AGENT-001'],
    contractUnitIds: [],
    dependencyUnitIds: [],
    executionProfileIds: ['implement'],
    conservative: true,
    guardrailReasons: ['guardrail:consolidation_correction'],
  });

  const retainedAssistantPayload = result.contextMessages.messages.find((message) =>
    message.role === 'assistant' && /database-lab\/design\/architecture\.md/i.test(message.content)
  );
  const retainedToolResult = result.contextMessages.messages.find((message) =>
    message.metadata?.source === 'tool_result' && /bytesWritten/i.test(message.content)
  );

  assert.equal(retainedAssistantPayload, undefined);
  assert.ok(retainedToolResult);
  assert.ok(result.summary.gatedContextCharacters < result.summary.rawContextCharacters);
});

test('gateProviderRequestContext keeps only the latest operator correction prompt during consolidation correction', () => {
  const config = loadBackendNewConfig({}, { cwd: process.cwd(), env: {} });
  const result = gateProviderRequestContext({
    config,
    current: [
      {
        role: 'user',
        content: 'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md only.',
        compressed: false,
        metadata: { unitId: 'AGENT-001' },
      },
      {
        role: 'tool',
        content: 'Tool read_file succeeded for brief/workload-profile.md.\nSelected file content:\n# Workload Profile',
        compressed: false,
        metadata: {
          unitId: 'AGENT-001',
          source: 'tool_result',
          invocationId: 'tool_read_1',
          toolId: 'read_file',
          status: 'SUCCEEDED',
        },
      },
      {
        role: 'user',
        content: 'Write only database-lab/design/README.md and database-lab/design/architecture.md now.',
        compressed: false,
        metadata: { unitId: 'AGENT-001', source: 'operator_message' },
      },
    ],
    additions: [],
    stageUnitIds: ['AGENT-001'],
    contractUnitIds: [],
    dependencyUnitIds: [],
    executionProfileIds: ['implement'],
    conservative: true,
    guardrailReasons: ['guardrail:consolidation_correction'],
  });

  const retainedOperatorMessages = result.contextMessages.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);

  assert.deepEqual(retainedOperatorMessages, [
    'Write only database-lab/design/README.md and database-lab/design/architecture.md now.',
  ]);
  assert.ok(result.contextMessages.messages.some((message) =>
    message.metadata?.source === 'tool_result' && /workload-profile/i.test(message.content)
  ));
});

test('gateProviderRequestContext drops superseded stage-scoped operator prompts in standard mode', () => {
  const config = loadBackendNewConfig({}, { cwd: process.cwd(), env: {} });
  const result = gateProviderRequestContext({
    config,
    current: [
      {
        role: 'user',
        content: 'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md only.',
        compressed: false,
        metadata: { unitId: 'AGENT-001' },
      },
      {
        role: 'tool',
        content: 'Tool read_file succeeded for brief/workload-profile.md.\nSelected file content:\n# Workload Profile',
        compressed: false,
        metadata: {
          unitId: 'AGENT-001',
          source: 'tool_result',
          invocationId: 'tool_read_1',
          toolId: 'read_file',
          status: 'SUCCEEDED',
        },
      },
      {
        role: 'user',
        content: 'Write only database-lab/design/README.md and database-lab/design/architecture.md now.',
        compressed: false,
        metadata: { unitId: 'AGENT-001', source: 'operator_message' },
      },
    ],
    additions: [],
    stageUnitIds: ['AGENT-001'],
    contractUnitIds: [],
    dependencyUnitIds: [],
    executionProfileIds: ['implement'],
    conservative: false,
    guardrailReasons: [],
  });

  const retainedUserMessages = result.contextMessages.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);

  assert.deepEqual(retainedUserMessages, [
    'Write only database-lab/design/README.md and database-lab/design/architecture.md now.',
  ]);
  assert.ok(result.summary.reasons.some((reason) => /superseded_stage_messages_dropped:1/.test(reason)));
  assert.ok(result.contextMessages.messages.some((message) =>
    message.metadata?.source === 'tool_result' && /workload-profile/i.test(message.content)
  ));
});

test('gateProviderRequestContext drops superseded stage-scoped assistant planning when a newer operator prompt exists', () => {
  const config = loadBackendNewConfig({}, { cwd: process.cwd(), env: {} });
  const result = gateProviderRequestContext({
    config,
    current: [
      {
        role: 'assistant',
        content: 'Next I will read the three brief files and then prepare the grounded design docs.',
        compressed: false,
        metadata: { unitId: 'AGENT-001' },
      },
      {
        role: 'tool',
        content: 'Tool read_file succeeded for brief/workload-profile.md.\nSelected file content:\n# Workload Profile',
        compressed: false,
        metadata: {
          unitId: 'AGENT-001',
          source: 'tool_result',
          invocationId: 'tool_read_1',
          toolId: 'read_file',
          status: 'SUCCEEDED',
        },
      },
      {
        role: 'user',
        content: 'Write only database-lab/design/README.md and database-lab/design/architecture.md now.',
        compressed: false,
        metadata: { unitId: 'AGENT-001', source: 'operator_message' },
      },
    ],
    additions: [],
    stageUnitIds: ['AGENT-001'],
    contractUnitIds: [],
    dependencyUnitIds: [],
    executionProfileIds: ['implement'],
    conservative: false,
    guardrailReasons: [],
  });

  const retainedAssistantMessage = result.contextMessages.messages.find((message) =>
    message.role === 'assistant' && /read the three brief files/i.test(message.content)
  );

  assert.equal(retainedAssistantMessage, undefined);
  assert.ok(result.summary.reasons.some((reason) => /superseded_stage_messages_dropped:1/.test(reason)));
  assert.ok(result.contextMessages.messages.some((message) =>
    message.metadata?.source === 'tool_result' && /workload-profile/i.test(message.content)
  ));
});

test('validateBuiltinRunCommandSafety allows PowerShell Format-List while still blocking destructive format commands', () => {
  const powershellFormat = validateBuiltinRunCommandSafety(
    `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object FreeSpace | Format-List`
  );
  const destructiveFormat = validateBuiltinRunCommandSafety('format C:');

  assert.equal(powershellFormat, null);
  assert.match(destructiveFormat, /builtin run_command safety policy/i);
});

test('tool invocation transition applies running, success, and failure states coherently', () => {
  const base = createToolInvocationRecord({
    correlationId: 'corr_tool',
    sessionId: 'sess_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_10',
    request: {
      taskId: 'task_tools',
      unitId: 'AGENT-002',
      toolName: 'search-files',
      arguments: {
        pattern: 'TODO'
      }
    },
    startedAt: 10
  });

  const running = applyToolInvocationTransition(base, {
    type: 'START',
    timestamp: 11,
    metadata: { worker: 'runtime' }
  });
  const succeeded = applyToolInvocationTransition(running, {
    type: 'SUCCEED',
    timestamp: 12,
    result: createToolSuccessResult({
      output: { matches: 2 },
      message: 'done'
    })
  });
  const failed = applyToolInvocationTransition(running, {
    type: 'FAIL',
    timestamp: 13,
    result: createToolFailureResult({
      kind: 'TIMEOUT',
      message: 'tool timed out'
    })
  });

  assert.equal(running.status, 'RUNNING');
  assert.equal(running.metadata.worker, 'runtime');
  assert.equal(succeeded.status, 'SUCCEEDED');
  assert.equal(succeeded.result.matches, 2);
  assert.equal(succeeded.error, null);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.result, null);
  assert.equal(failed.error, 'tool timed out');
  assert.equal(failed.metadata.errorKind, 'TIMEOUT');

  const denied = applyToolInvocationTransition(running, {
    type: 'DENY',
    timestamp: 14,
    reason: 'Approval rejected by user'
  });
  assert.equal(denied.status, 'DENIED');
  assert.equal(denied.error, 'Approval rejected by user');
  assert.equal(denied.metadata.denialReason, 'Approval rejected by user');
});

test('tool execution audit details keep permission and result context stable', () => {
  const details = createToolExecutionAuditDetails({
    taskId: 'task_tools',
    unitId: 'AGENT-002',
    toolName: 'write_file',
    sessionId: 'sess_tool',
    correlationId: 'corr_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_20',
    policy: {
      decision: 'REQUIRE_APPROVAL',
      reason: 'Tool requires approval in ask mode.'
    },
    result: createToolFailureResult({
      kind: 'PERMISSION',
      message: 'Permission denied'
    })
  });

  assert.equal(details.decision, 'REQUIRE_APPROVAL');
  assert.equal(details.turnId, 'turn_tool');
  assert.equal(details.resultKind, 'PERMISSION');
});

test('tool approval repository appends approval records', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const approvals = new FileToolApprovalRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.approvalsDir);

    const invocation = createToolInvocationRecord({
      correlationId: 'corr_tool',
      sessionId: 'sess_tool',
      turnId: 'turn_tool',
      checkpointId: 'chk_turn_tool_20',
      request: {
        taskId: 'task_tools',
        unitId: 'AGENT-002',
        toolName: 'write-file',
        arguments: {
          path: 'report.md'
        }
      },
      status: 'WAITING_APPROVAL'
    });
    const approval = createToolApprovalRecord({
      invocation,
      reason: 'Tool requires approval in ask mode.'
    });

    await approvals.append(approval);
    const stored = await approvals.list('task_tools');

    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'PENDING');
    assert.equal(stored[0].invocationId, invocation.invocationId);
    assert.equal(stored[0].toolId, 'write-file');
  } finally {
    removeDir(root);
  }
});

test('approval resolution and latest approval selection remain deterministic', () => {
  const invocation = createToolInvocationRecord({
    correlationId: 'corr_tool',
    sessionId: 'sess_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_20',
    request: {
      taskId: 'task_tools',
      unitId: 'AGENT-002',
      toolName: 'write-file',
      arguments: {
        path: 'report.md'
      }
    },
    status: 'WAITING_APPROVAL',
    startedAt: 20
  });
  const pending = createToolApprovalRecord({
    invocation,
    reason: 'Need approval',
    createdAt: 21
  });
  const approved = resolveToolApprovalRecord(pending, {
    status: 'APPROVED',
    resolvedAt: 22,
    grantedBy: 'user-1',
    reason: 'approved'
  });

  const latest = findLatestApprovalForInvocation([pending, approved], invocation.invocationId);
  assert.equal(latest.status, 'APPROVED');
  assert.equal(latest.grantedBy, 'user-1');
});

test('invocation resume policy waits denies or dispatches based on approval state and capability', () => {
  const planned = createToolInvocationRecord({
    correlationId: 'corr_tool',
    sessionId: 'sess_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_19',
    request: {
      taskId: 'task_tools',
      unitId: 'AGENT-001',
      toolName: 'search-files',
      arguments: {
        pattern: 'TODO'
      }
    },
    status: 'PLANNED',
    startedAt: 19
  });
  const invocation = createToolInvocationRecord({
    correlationId: 'corr_tool',
    sessionId: 'sess_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_20',
    request: {
      taskId: 'task_tools',
      unitId: 'AGENT-002',
      toolName: 'write-file',
      arguments: {
        path: 'report.md'
      }
    },
    status: 'WAITING_APPROVAL',
    startedAt: 20
  });
  const pending = createToolApprovalRecord({
    invocation,
    reason: 'Need approval',
    createdAt: 21
  });
  const approved = resolveToolApprovalRecord(pending, {
    status: 'APPROVED',
    resolvedAt: 22
  });
  const rejected = resolveToolApprovalRecord(pending, {
    status: 'REJECTED',
    resolvedAt: 23
  });

  assert.equal(
    evaluateToolInvocationResumePolicy({
      invocation: planned,
      approval: null,
      capability: null
    }).decision,
    'DENY'
  );
  assert.equal(
    evaluateToolInvocationResumePolicy({
      invocation,
      approval: pending,
      capability: createDefaultToolExecutorCapability()
    }).decision,
    'WAIT_APPROVAL'
  );
  assert.equal(
    evaluateToolInvocationResumePolicy({
      invocation,
      approval: approved,
      capability: createDefaultToolExecutorCapability()
    }).decision,
    'DISPATCH'
  );
  assert.equal(
    evaluateToolInvocationResumePolicy({
      invocation,
      approval: approved,
      capability: {
        ...createDefaultToolExecutorCapability(),
        supportsApprovalResume: false
      }
    }).decision,
    'DENY'
  );
  assert.equal(
    evaluateToolInvocationResumePolicy({
      invocation,
      approval: rejected,
      capability: createDefaultToolExecutorCapability()
    }).decision,
    'DENY'
  );
});

test('tool dispatch plan promotes approved invocations and denies unrecoverable ones deterministically', () => {
  const invocation = createToolInvocationRecord({
    correlationId: 'corr_tool',
    sessionId: 'sess_tool',
    turnId: 'turn_tool',
    checkpointId: 'chk_turn_tool_20',
    request: {
      taskId: 'task_tools',
      unitId: 'AGENT-002',
      toolName: 'write-file',
      arguments: {
        path: 'report.md'
      }
    },
    status: 'WAITING_APPROVAL',
    startedAt: 20
  });
  const pending = createToolApprovalRecord({
    invocation,
    reason: 'Need approval',
    createdAt: 21
  });
  const approved = resolveToolApprovalRecord(pending, {
    status: 'APPROVED',
    resolvedAt: 22
  });
  const rejected = resolveToolApprovalRecord(pending, {
    status: 'REJECTED',
    resolvedAt: 23
  });

  const dispatchPlan = planToolInvocationDispatch({
    invocation,
    approval: approved,
    capability: createDefaultToolExecutorCapability()
  });
  const deniedPlan = planToolInvocationDispatch({
    invocation,
    approval: rejected,
    capability: createDefaultToolExecutorCapability()
  });

  assert.equal(dispatchPlan.decision, 'DISPATCH');
  assert.equal(dispatchPlan.nextInvocation.status, 'PLANNED');
  assert.equal(dispatchPlan.nextInvocation.metadata.latestApprovalStatus, 'APPROVED');
  assert.equal(deniedPlan.decision, 'DENY');
  assert.equal(deniedPlan.nextInvocation.status, 'DENIED');
  assert.match(deniedPlan.nextInvocation.error, /REJECTED/i);
});

test('tool executor registry and dispatch contract resolve executors predictably', async () => {
  const registry = new ToolExecutorRegistry();
  registry.register(
    'search-files',
    {
      async execute(request) {
        return createToolSuccessResult({
          output: {
            echoedPattern: request.invocation.arguments.pattern
          }
        });
      }
    },
    {
      supportsApprovalResume: false,
      maxExecutionMs: 5000
    }
  );

  const config = loadBackendNewConfig({}, { cwd: process.cwd(), env: {} });
  const tool = {
    id: 'search-files',
    name: 'search_files',
    description: 'Search files',
    source: 'builtin',
    effect: 'READ',
    riskLevel: 'LOW',
    inputSchema: []
  };

  const success = await dispatchToolExecutor({
    registry,
    tool,
    request: {
      tool,
      invocation: {
        taskId: 'task_tools',
        unitId: 'AGENT-001',
        toolName: 'search-files',
        arguments: {
          pattern: 'TODO'
        }
      },
      context: {
        config,
        sessionId: 'sess_tool',
        correlationId: 'corr_tool',
        turnId: 'turn_tool',
        checkpointId: 'chk_turn_tool_1'
      }
    }
  });
  const missingTool = {
    ...tool,
    id: 'missing-tool',
    name: 'missing_tool'
  };
  const missing = await dispatchToolExecutor({
    registry: new ToolExecutorRegistry(),
    tool: missingTool,
    request: {
      tool: missingTool,
      invocation: {
        taskId: 'task_tools',
        unitId: 'AGENT-001',
        toolName: 'missing-tool',
        arguments: {}
      },
      context: {
        config,
        sessionId: 'sess_tool',
        correlationId: 'corr_tool',
        turnId: 'turn_tool',
        checkpointId: 'chk_turn_tool_2'
      }
    }
  });

  assert.equal(success.ok, true);
  assert.equal(success.output.echoedPattern, 'TODO');
  assert.equal(registry.resolveCapability(tool).supportsApprovalResume, false);
  assert.equal(registry.resolveCapability(tool).maxExecutionMs, 5000);
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'NOT_FOUND');
});

test('tool invocation repository appends invocation records', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const invocations = new FileToolInvocationRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.toolInvocationsDir);

    const record = createToolInvocationRecord({
      correlationId: 'corr_tool',
      sessionId: 'sess_tool',
      turnId: 'turn_tool',
      checkpointId: 'chk_turn_tool_20',
      request: {
        taskId: 'task_tools',
        unitId: 'AGENT-002',
        toolName: 'search-files',
        arguments: {
          pattern: 'TODO'
        }
      },
      status: 'SUCCEEDED',
      endedAt: 20,
      result: {
        matches: 4
      }
    });

    await invocations.append(record);
    const stored = await invocations.list('task_tools');

    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'SUCCEEDED');
    assert.equal(stored[0].turnId, 'turn_tool');
    assert.equal(stored[0].checkpointId, 'chk_turn_tool_20');
    assert.equal(stored[0].result.matches, 4);
    assert.match(stored[0].invocationId, /^tool_/);
  } finally {
    removeDir(root);
  }
});
