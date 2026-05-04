const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const {
  createBackendNewFoundation,
  createBackendNewRuntime
} = require('../dist');
const {
  buildCurrentTurnToolContextMessages
} = require('../dist/application/tasks/turns/turn-runtime-state-builder');
const { createTempRoot, removeDir } = require('./helpers.cjs');

function createRuntimeWithFoundation(options) {
  const foundation = createBackendNewFoundation(options);
  const runtime = createBackendNewRuntime({ foundation });
  return { foundation, runtime };
}

function createTaskInput(units) {
  return {
    title: 'Adapter Task',
    intent: 'Verify default runtime adapters.',
    preferredProviderId: 'provider-main',
    units
  };
}

test('default openai-compatible provider client resolves by transport and executes a turn', async () => {
  const root = createTempRoot();
  let requestBody = null;
  let authHeader = null;
  const server = require('node:http').createServer(async (req, res) => {
    authHeader = req.headers.authorization ?? null;
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_default',
      model: 'mock-openai-model',
      choices: [
        {
          message: {
            content: '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
              + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 9,
        total_tokens: 21
      }
    }));
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    await foundation.apiKeys.save({
      id: 'provider-main-key',
      provider: 'provider-main',
      label: 'Provider Main Key',
      apiKey: 'secret-token',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'mock-openai-model',
      apiKeySecretId: 'provider-main-key'
    });
    const capability = foundation.providerClients.resolveCapability({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'mock-openai-model',
      apiKeySecretId: 'provider-main-key'
    });

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Closer', goal: 'Close', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(capability.supportsTools, true);
    assert.equal(requestBody.model, 'mock-openai-model');
    assert.equal(Array.isArray(requestBody.messages), true);
    assert.equal(authHeader, 'Bearer secret-token');
  } finally {
    server.close();
    removeDir(root);
  }
});

test('default builtin tool adapters register automatically and write files into workspace', async () => {
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
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://unused.example.com',
      model: 'mock-model'
    });
    foundation.providerClients.register('provider-main', {
      async complete() {
        return {
          responseId: 'resp_builtin_write',
          providerId: 'provider-main',
          model: 'mock-model',
          outputText:
            '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"notes/result.txt","content":"hello world"}}\n'
            + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}',
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

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      { id: 'AGENT-001', role: 'Writer', goal: 'Write result', outputContract: '{"summary":"string","issues":[]}', dependencies: [] }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const writtenFile = path.join(root, 'workspace', submitted.command.taskId, 'notes', 'result.txt');
    const fileContent = await fs.readFile(writtenFile, 'utf8');
    const succeededInvocation = started.task.toolInvocations.find(record => record.status === 'SUCCEEDED');

    assert.equal(started.task.runtime.lifecycleStatus, 'COMPLETED');
    assert.equal(fileContent, 'hello world');
    assert.equal(succeededInvocation.toolId, 'write_file');
  } finally {
    removeDir(root);
  }
});

test('default builtin read/list/search executors work directly against workspace', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_ops';
    const workspaceRoot = path.join(root, 'workspace', taskId);
    await fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'alpha.txt'), 'alpha\nneedle here\nomega', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'beta.txt'), 'beta', 'utf8');

    const readTool = runtime.extensions.findTool('read_file');
    const listTool = runtime.extensions.findTool('list_files');
    const searchTool = runtime.extensions.findTool('search_files');
    const readExecutor = foundation.toolExecutors.resolve(readTool);
    const listExecutor = foundation.toolExecutors.resolve(listTool);
    const searchExecutor = foundation.toolExecutors.resolve(searchTool);

    const commonContext = {
      config: runtime.config,
      sessionId: 'sess_builtin_ops',
      correlationId: 'corr_builtin_ops',
      turnId: 'turn_builtin_ops',
      checkpointId: null
    };
    const readResult = await readExecutor.execute({
      tool: readTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: 'docs/alpha.txt'
        }
      },
      context: commonContext
    });
    const listResult = await listExecutor.execute({
      tool: listTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'list_files',
        arguments: {
          path: 'docs',
          recursive: true
        }
      },
      context: commonContext
    });
    const rootListResult = await listExecutor.execute({
      tool: listTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'list_files',
        arguments: {
          path: '.'
        }
      },
      context: commonContext
    });
    const searchResult = await searchExecutor.execute({
      tool: searchTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'search_files',
        arguments: {
          path: 'docs',
          pattern: 'needle'
        }
      },
      context: commonContext
    });

    assert.equal(readResult.ok, true);
    assert.match(readResult.output.content, /needle here/);
    assert.equal(listResult.ok, true);
    assert.deepEqual(listResult.output.files.sort(), ['docs/alpha.txt', 'docs/beta.txt']);
    assert.equal(rootListResult.ok, true);
    assert.deepEqual(rootListResult.output.files, []);
    assert.deepEqual(rootListResult.output.directories, ['docs']);
    assert.deepEqual(rootListResult.output.entries, [{ path: 'docs', type: 'directory' }]);
    assert.equal(searchResult.ok, true);
    assert.equal(searchResult.output.matches.length, 1);
    assert.equal(searchResult.output.matches[0].path, 'docs/alpha.txt');
  } finally {
    removeDir(root);
  }
});

test('default builtin file executors allow explicit absolute local paths outside the task workspace', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_absolute_paths';
    const externalRoot = path.join(root, 'external-output');
    const targetFile = path.join(externalRoot, 'notes', 'result.txt');
    await fs.mkdir(externalRoot, { recursive: true });

    const writeTool = runtime.extensions.findTool('write_file');
    const readTool = runtime.extensions.findTool('read_file');
    const listTool = runtime.extensions.findTool('list_files');
    const writeExecutor = foundation.toolExecutors.resolve(writeTool);
    const readExecutor = foundation.toolExecutors.resolve(readTool);
    const listExecutor = foundation.toolExecutors.resolve(listTool);

    const commonContext = {
      config: runtime.config,
      sessionId: 'sess_builtin_absolute_paths',
      correlationId: 'corr_builtin_absolute_paths',
      turnId: 'turn_builtin_absolute_paths',
      checkpointId: null
    };

    const writeResult = await writeExecutor.execute({
      tool: writeTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'write_file',
        arguments: {
          path: targetFile,
          content: 'external hello'
        }
      },
      context: commonContext
    });
    const readResult = await readExecutor.execute({
      tool: readTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'read_file',
        arguments: {
          path: targetFile
        }
      },
      context: commonContext
    });
    const listResult = await listExecutor.execute({
      tool: listTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'list_files',
        arguments: {
          path: externalRoot,
          recursive: true
        }
      },
      context: commonContext
    });

    const fileContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(writeResult.ok, true);
    assert.equal(readResult.ok, true);
    assert.equal(listResult.ok, true);
    assert.equal(fileContent, 'external hello');
    assert.equal(writeResult.output.path, targetFile.replace(/\\/g, '/'));
    assert.equal(readResult.output.path, targetFile.replace(/\\/g, '/'));
    assert.deepEqual(listResult.output.files, [targetFile.replace(/\\/g, '/')]);
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command executor reports stdout and cwd for host-safe commands', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command';
    const workspaceRoot = path.join(root, 'workspace', taskId);
    await fs.mkdir(workspaceRoot, { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const command = process.platform === 'win32'
      ? 'Get-Location | Select-Object -ExpandProperty Path'
      : 'pwd';
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command',
        correlationId: 'corr_builtin_command',
        turnId: 'turn_builtin_command',
        checkpointId: null
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.equal(result.output.cwd, workspaceRoot);
    assert.match(result.output.stdout.trim(), new RegExp(`${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command preserves UTF-8 PowerShell output on Windows', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_utf8';
    await fs.mkdir(path.join(root, 'workspace', taskId), { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const command = "Write-Output 'Path – A Thoughtful Blog 中文'";
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_utf8',
        correlationId: 'corr_builtin_command_utf8',
        turnId: 'turn_builtin_command_utf8',
        checkpointId: null
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.match(result.output.stdout, /Path – A Thoughtful Blog 中文/);
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command executor preserves failed command stdout and stderr', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_failure_result';
    await fs.mkdir(path.join(root, 'workspace', taskId), { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const command = process.platform === 'win32'
      ? "Write-Output 'OUT_MARKER'; [Console]::Error.WriteLine('ERR_MARKER'); exit 7"
      : 'node -e "console.log(\'OUT_MARKER\'); console.error(\'ERR_MARKER\'); process.exit(7)"';
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_failure_result',
        correlationId: 'corr_builtin_command_failure_result',
        turnId: 'turn_builtin_command_failure_result',
        checkpointId: null
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'EXECUTION');
    assert.equal(result.output.exitCode, 7);
    assert.match(result.output.stdout, /OUT_MARKER/);
    assert.match(result.output.stderr, /ERR_MARKER/);
    assert.equal(result.metadata.exitCode, 7);
    assert.equal(result.metadata.originalCommand, command);
    assert.equal(result.metadata.effectiveCommand, command);
    assert.match(result.metadata.stdout, /OUT_MARKER/);
    assert.match(result.metadata.stderr, /ERR_MARKER/);
  } finally {
    removeDir(root);
  }
});

test('current turn tool context includes failed run_command execution output for self-correction', () => {
  const messages = buildCurrentTurnToolContextMessages({
    currentUnitId: 'AGENT-001',
    turnId: 'turn_failed_command_context',
    maxContentChars: 2000,
    invocations: [
      {
        invocationId: 'inv_failed_command_context',
        correlationId: 'corr_failed_command_context',
        sessionId: 'sess_failed_command_context',
        turnId: 'turn_failed_command_context',
        taskId: 'task_failed_command_context',
        unitId: 'AGENT-001',
        checkpointId: null,
        toolId: 'run_command',
        arguments: {
          command: 'node -e "console.log(\'OUT_MARKER\'); console.error(\'ERR_MARKER\'); process.exit(7)"'
        },
        status: 'FAILED',
        startedAt: 10,
        endedAt: 20,
        result: null,
        error: 'Command failed with exit code 7.',
        metadata: {
          exitCode: 7,
          stdout: 'OUT_MARKER\n',
          stderr: 'ERR_MARKER\n',
          command: 'node -e "..."',
          effectiveCommand: 'node -e "..."',
          cwd: 'D:/workspace/task_failed_command_context',
          durationMs: 123,
          timedOut: false
        }
      }
    ]
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'tool');
  assert.match(messages[0].content, /Exit code: 7/);
  assert.match(messages[0].content, /OUT_MARKER/);
  assert.match(messages[0].content, /ERR_MARKER/);
  assert.match(messages[0].content, /cwd: D:\/workspace\/task_failed_command_context/);
});

test('fallback task turns feed failed run_command output into the next provider request', async () => {
  const root = createTempRoot();
  const providerRequests = [];
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
    foundation.providers.register({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://unused.example.com',
      model: 'mock-model'
    });
    const failingCommand = process.platform === 'win32'
      ? "Write-Output 'OUT_MARKER'; [Console]::Error.WriteLine('ERR_MARKER'); exit 7"
      : 'node -e "console.log(\'OUT_MARKER\'); console.error(\'ERR_MARKER\'); process.exit(7)"';
    foundation.providerClients.register('provider-main', {
      async complete(request) {
        providerRequests.push(request);
        if (providerRequests.length === 1) {
          return {
            responseId: 'resp_failed_command_first_turn',
            providerId: 'provider-main',
            model: 'mock-model',
            outputText:
              `${JSON.stringify({ tool: 'run_command', arguments: { command: failingCommand } })}\n`
              + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":40,"decision":"CONTINUE","reason":"Waiting for command result","files_created":[]}',
            finishReason: 'stop',
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2
            },
            metadata: {}
          };
        }
        const requestText = request.messages.map((message) => message.content).join('\n');
        assert.match(requestText, /OUT_MARKER/);
        assert.match(requestText, /ERR_MARKER/);
        assert.match(requestText, /Exit code: 7/);
        return {
          responseId: 'resp_failed_command_second_turn',
          providerId: 'provider-main',
          model: 'mock-model',
          outputText:
            '[AGENT-001_OUTPUT]{"summary":"Observed failed command output and will not claim success.","issues":["ERR_MARKER"]}[/AGENT-001_OUTPUT]\n'
            + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"reported failure evidence","files_created":[]}',
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

    const submitted = await runtime.tasks.submitTask(createTaskInput([
      {
        id: 'AGENT-001',
        role: 'Verifier',
        goal: 'Run a verification command and report the exact result.',
        executionProfileId: 'verify',
        outputContract: '{"summary":"string","issues":[]}',
        dependencies: []
      }
    ]));
    const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
    const failedInvocation = started.task.toolInvocations.find((record) => record.toolId === 'run_command');
    assert.equal(failedInvocation.status, 'FAILED');
    assert.equal(failedInvocation.result.exitCode, 7);
    assert.match(failedInvocation.result.stdout, /OUT_MARKER/);
    assert.match(failedInvocation.result.stderr, /ERR_MARKER/);
    assert.match(failedInvocation.metadata.stdout, /OUT_MARKER/);
    assert.match(failedInvocation.metadata.stderr, /ERR_MARKER/);
    assert.match(JSON.stringify(started.task.runtime.llmContextMessages ?? []), /OUT_MARKER/);
    assert.match(JSON.stringify(started.task.runtime.llmContextMessages ?? []), /ERR_MARKER/);

    await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
    assert.equal(providerRequests.length, 2);
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command unwraps nested PowerShell command wrappers on Windows', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_nested_powershell';
    const workspaceRoot = path.join(root, 'workspace', taskId);
    await fs.mkdir(workspaceRoot, { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command: 'powershell -Command "1 | ForEach-Object { $_ + 41 }"'
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_nested_powershell',
        correlationId: 'corr_builtin_command_nested_powershell',
        turnId: 'turn_builtin_command_nested_powershell',
        checkpointId: null
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.equal(result.output.command, '1 | ForEach-Object { $_ + 41 }');
    assert.equal(result.output.cwd, workspaceRoot);
    assert.match(result.output.stdout.trim(), /^42$/);
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command accepts cmd alias and working_directory alias', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_aliases';
    const workspaceRoot = path.join(root, 'workspace', taskId);
    const nestedRoot = path.join(workspaceRoot, 'nested');
    await fs.mkdir(nestedRoot, { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          cmd: process.platform === 'win32'
            ? 'Get-Location | Select-Object -ExpandProperty Path'
            : 'pwd',
          working_directory: 'nested'
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_aliases',
        correlationId: 'corr_builtin_command_aliases',
        turnId: 'turn_builtin_command_aliases',
        checkpointId: null
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.equal(result.output.cwd, nestedRoot);
    assert.match(result.output.stdout.trim(), new RegExp(`${nestedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command translates common unix-style ls invocations on Windows', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_ls_translation';
    const workspaceRoot = path.join(root, 'workspace', taskId);
    const storeRoot = path.join(workspaceRoot, 'store');
    await fs.mkdir(storeRoot, { recursive: true });
    await fs.writeFile(path.join(storeRoot, 'package.json'), '{"name":"store"}', 'utf8');

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId,
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command: process.platform === 'win32' ? 'ls -la store/' : 'ls -la store/'
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_ls_translation',
        correlationId: 'corr_builtin_command_ls_translation',
        turnId: 'turn_builtin_command_ls_translation',
        checkpointId: null
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.match(result.output.stdout, /package\.json/i);
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command translates common unix diagnostic probes on Windows', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const taskId = 'task_builtin_command_unix_diagnostics_translation';
    await fs.mkdir(path.join(root, 'workspace', taskId), { recursive: true });

    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const commonContext = {
      config: runtime.config,
      sessionId: 'sess_builtin_command_unix_diagnostics_translation',
      correlationId: 'corr_builtin_command_unix_diagnostics_translation',
      turnId: 'turn_builtin_command_unix_diagnostics_translation',
      checkpointId: null
    };
    const commands = [
      {
        command: 'uname -a',
        expected: /Caption|BuildNumber|OSArchitecture/i
      },
      {
        command: 'systeminfo 2>/dev/null || uname -a',
        expected: /CSName|Caption|Version|BuildNumber/i
      },
      {
        command: 'free -b 2>/dev/null || echo MEMORY_UNAVAILABLE',
        expected: /TotalVisibleMemorySize|FreePhysicalMemory/i
      },
      {
        command: 'df -h',
        expected: /DeviceID|FreeSpace|Size/i
      },
      {
        command: 'top -bn1 | head -20',
        expected: /ProcessName|CPU|WS/i
      },
      {
        command: 'ps aux --sort=-%mem | head -10',
        expected: /ProcessName|CPU|WS/i
      }
    ];

    for (const entry of commands) {
      const result = await runExecutor.execute({
        tool: runTool,
        invocation: {
          taskId,
          unitId: 'AGENT-001',
          toolName: 'run_command',
          arguments: {
            command: entry.command
          }
        },
        context: commonContext
      });

      assert.equal(result.ok, true, entry.command);
      assert.equal(result.output.exitCode, 0, entry.command);
      assert.equal(result.output.translatedCommand, true, entry.command);
      assert.match(result.output.stdout, entry.expected, entry.command);
    }
  } finally {
    removeDir(root);
  }
});

test('default builtin run_command blocks obviously destructive commands', async () => {
  const root = createTempRoot();
  try {
    const { foundation, runtime } = createRuntimeWithFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const runTool = runtime.extensions.findTool('run_command');
    const runExecutor = foundation.toolExecutors.resolve(runTool);
    const result = await runExecutor.execute({
      tool: runTool,
      invocation: {
        taskId: 'task_builtin_command_blocked',
        unitId: 'AGENT-001',
        toolName: 'run_command',
        arguments: {
          command: 'rm -rf logs'
        }
      },
      context: {
        config: runtime.config,
        sessionId: 'sess_builtin_command_blocked',
        correlationId: 'corr_builtin_command_blocked',
        turnId: 'turn_builtin_command_blocked',
        checkpointId: null
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'PERMISSION');
  } finally {
    removeDir(root);
  }
});
