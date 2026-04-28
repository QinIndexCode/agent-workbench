const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');
const {
  buildProviderCompletionRequest,
  createBackendNewRuntime,
  createBackendNewFoundation,
  createMcpCatalogView,
  createSkillCatalogView,
  DeepSeekCompatibleProviderClient,
  HttpMcpClientAdapter,
  loadBackendNewConfig,
  ModuleSkillRuntime,
  McpClientRegistry,
  normalizeProviderFailure,
  OpenAiCompatibleProviderClient,
  ProviderHttpError,
  ProviderClientRegistry,
  StdioMcpClientAdapter,
  SkillRuntimeRegistry,
  WsMcpClientAdapter
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('provider client registry stores client and capability with stable request shape', async () => {
  const registry = new ProviderClientRegistry();
  registry.register(
    'deepseek-main',
    {
      async complete(request) {
        return {
          responseId: 'resp_1',
          providerId: request.profile.id,
          model: request.profile.model,
          outputText: 'ok',
          finishReason: 'stop',
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2
          },
          metadata: {}
        };
      }
    },
    {
      supportsJsonMode: true,
      maxContextTokens: 64000
    }
  );

  const profile = {
    id: 'deepseek-main',
    label: 'DeepSeek Main',
    transport: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: 'sk-demo'
  };
  const request = buildProviderCompletionRequest({
    profile,
    context: {
      taskId: 'task_provider',
      unitId: 'AGENT-001',
      sessionId: 'sess_1',
      correlationId: 'corr_1',
      turnId: 'turn_1',
      checkpointId: 'chk_1'
    },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ],
    temperature: 0.1,
    maxTokens: 512
  });
  const capability = registry.resolveCapability(profile);
  const response = await registry.resolve(profile).complete(request);

  assert.equal(request.messages.length, 2);
  assert.equal(capability.supportsJsonMode, true);
  assert.equal(capability.maxContextTokens, 64000);
  assert.equal(response.providerId, 'deepseek-main');
  assert.equal(response.outputText, 'ok');
});

test('skill and mcp catalog views expose runtime readiness without executing implementations', () => {
  const foundation = createBackendNewFoundation({
    config: {
      paths: {
        rootDir: createTempRoot()
      }
    }
  });

  try {
    foundation.extensions.registerSkill({
      id: 'skill.analyze',
      name: 'analyze',
      rootDir: 'skills/analyze',
      kind: 'runtime-skill'
    });
    foundation.extensions.registerSkill({
      id: 'skill.guide',
      name: 'guide',
      rootDir: 'skills/guide',
      kind: 'instruction-skill',
      assetSummary: {
        totalFiles: 3,
        markdownFiles: 1,
        scriptFiles: 0,
        templateFiles: 1,
        assetFiles: 1,
        samplePaths: ['SKILL.md', 'templates/checklist.md']
      },
      instructionSource: {
        format: 'claude-style-skill',
        skillFile: 'skills/guide/SKILL.md'
      }
    });
    foundation.extensions.registerMcpServer({
      id: 'mcp.fs',
      name: 'filesystem',
      transport: 'stdio',
      command: 'fs-mcp'
    });

    foundation.skillRuntimes.register('skill.analyze', {
      async invoke() {
        return {
          ok: true,
          output: { done: true },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsWorkspaceWrite: true
    });
    foundation.mcpClients.register('mcp.fs', {
      async connect() {},
      async callTool() {
        return {
          ok: true,
          output: { items: [] },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsResources: true
    });

    const skillCatalog = createSkillCatalogView(foundation.extensions, foundation.skillRuntimes);
    const mcpCatalog = createMcpCatalogView(foundation.extensions, foundation.mcpClients);

    assert.equal(skillCatalog.length, 2);
    assert.equal(skillCatalog[0].hasRuntime, true);
    assert.equal(skillCatalog[0].capability.supportsWorkspaceWrite, true);
    assert.equal(skillCatalog[0].kind, 'runtime-skill');
    assert.equal(skillCatalog[0].readiness, 'ready');
    assert.equal(skillCatalog[1].kind, 'instruction-skill');
    assert.equal(skillCatalog[1].readiness, 'metadata-only');
    assert.deepEqual(skillCatalog[1].assetSummary.samplePaths, ['SKILL.md', 'templates/checklist.md']);
    assert.equal(mcpCatalog.length, 1);
    assert.equal(mcpCatalog[0].hasClient, true);
    assert.equal(mcpCatalog[0].capability.supportsResources, true);
  } finally {
    removeDir(foundation.layout.paths.rootDir);
  }
});

test('backend runtime loads provider manifest during startup', async () => {
  const root = createTempRoot();
  try {
    const providersDir = path.join(root, 'providers');
    fs.mkdirSync(providersDir, { recursive: true });
    fs.writeFileSync(
      path.join(providersDir, 'manifest.json'),
      JSON.stringify({
        providers: [
          {
            id: 'ollama-cloud',
            label: 'Ollama Cloud',
            vendor: 'ollama',
            transport: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'minimax-m2.5:cloud',
            auth: {
              scheme: 'none'
            }
          }
        ]
      }),
      'utf8'
    );

    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });

    try {
      await runtime.tasks.listTasks();
      assert.equal(foundation.providers.list().length, 1);
      assert.equal(foundation.providers.list()[0].id, 'ollama-cloud');
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('backend runtime exposes provider skill and mcp registries from the shared foundation', () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    assert.ok(foundation.providerClients);
    assert.ok(foundation.skillRuntimes);
    assert.ok(foundation.mcpClients);

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    assert.equal(config.paths.rootDir, root);
  } finally {
    removeDir(root);
  }
});

test('openai-compatible provider retries retryable failures and deepseek client adds provider identity', async () => {
  const root = createTempRoot();
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      response.statusCode = 429;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'resp_ok',
      model: 'deepseek-chat',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }));
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = buildProviderCompletionRequest({
      profile: {
        id: 'deepseek-main',
        label: 'DeepSeek Main',
        transport: 'deepseek-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'deepseek-chat',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_provider',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 2,
        retryBackoffMs: 10
      }
    });

    const openaiClient = new OpenAiCompatibleProviderClient();
    const deepseekClient = new DeepSeekCompatibleProviderClient();
    const retried = await openaiClient.complete({
      ...request,
      profile: {
        ...request.profile,
        transport: 'openai-compatible'
      }
    });
    const deepseek = await deepseekClient.complete(request);

    assert.equal(calls >= 3, true);
    assert.equal(retried.outputText, 'ok');
    assert.equal(deepseek.metadata.providerKind, 'deepseek-compatible');
    assert.equal(deepseek.metadata.request.providerId, 'deepseek-main');
  } finally {
    await new Promise(resolve => server.close(resolve));
    removeDir(root);
  }
});

test('openai-compatible provider retries transient network failures with normalized retryable taxonomy', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('socket hang up');
    }
    return {
      ok: true,
      async json() {
        return {
          id: 'resp_network_ok',
          model: 'gpt-benchmark',
          choices: [{ message: { content: 'ok after retry' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        };
      }
    };
  };

  try {
    const request = buildProviderCompletionRequest({
      profile: {
        id: 'provider-main',
        label: 'Provider Main',
        transport: 'openai-compatible',
        baseUrl: 'https://provider.example.com',
        model: 'gpt-benchmark',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_provider_network',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 1,
        retryBackoffMs: 1
      }
    });
    const client = new OpenAiCompatibleProviderClient();
    const response = await client.complete(request);

    assert.equal(calls, 2);
    assert.equal(response.outputText, 'ok after retry');
    assert.equal(response.metadata.providerKind, 'openai-compatible');
  } finally {
    global.fetch = originalFetch;
  }
});

test('openai-compatible provider appends a minimal user turn when the request only contains system instructions', async () => {
  const http = require('node:http');
  let seenBody = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          id: 'resp_system_only_ok',
          model: 'mimo-v2.5',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        }));
    });
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new OpenAiCompatibleProviderClient();
    await client.complete(buildProviderCompletionRequest({
      profile: {
        id: 'mimo-main',
          label: 'Mimo Main',
          transport: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${port}`,
          model: 'mimo-v2.5',
          apiKey: 'sk-secret'
        },
      context: {
        taskId: 'task_provider_system_only',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'system', content: 'You are helpful.' }],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 0,
        retryBackoffMs: 1
      }
    }));

    assert.equal(Array.isArray(seenBody.messages), true);
    assert.equal(seenBody.messages.length, 2);
    assert.deepEqual(seenBody.messages[0], { role: 'system', content: 'You are helpful.' });
    assert.equal(seenBody.messages[1].role, 'user');
    assert.match(seenBody.messages[1].content, /produce the requested result/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('openai-compatible provider downgrades internal tool history messages to user messages', async () => {
  let seenBody = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: 'resp_tool_history_ok',
        model: 'mimo-v2.5',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }));
    });
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new OpenAiCompatibleProviderClient();
    await client.complete(buildProviderCompletionRequest({
      profile: {
        id: 'mimo-main',
        label: 'Mimo Main',
        transport: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mimo-v2.5',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_provider_tool_history',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'assistant', content: '{"tool":"read_file","arguments":{"path":"briefing/live-provider-brief.md"}}' },
        { role: 'tool', content: 'Tool read_file succeeded for briefing/live-provider-brief.md.' }
      ],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 0,
        retryBackoffMs: 1
      }
    }));

    assert.equal(Array.isArray(seenBody.messages), true);
    assert.equal(seenBody.messages[1].role, 'assistant');
    assert.equal(seenBody.messages[2].role, 'user');
    assert.match(seenBody.messages[2].content, /Tool read_file succeeded/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('openai-compatible provider treats all-zero returned usage as missing so downstream suites can estimate tokens', async () => {
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'resp_zero_usage',
      model: 'mimo-v2.5',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }));
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new OpenAiCompatibleProviderClient();
    const response = await client.complete(buildProviderCompletionRequest({
      profile: {
        id: 'mimo-main',
        label: 'Mimo Main',
        transport: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mimo-v2.5',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_provider_zero_usage',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 0,
        retryBackoffMs: 1
      }
    }));

    assert.deepEqual(response.usage, {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedPromptTokens: null,
      cacheWritePromptTokens: null,
      providerReportedUsage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('module skill runtime loads entry file and stdio mcp client executes json-line tool call', async () => {
  const root = createTempRoot();
  try {
    const skillRoot = path.join(root, 'skills', 'demo');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, 'entry.cjs'),
      "exports.invoke = async (input, context) => ({ echoed: input.value, unitId: context.unitId });",
      'utf8'
    );
    const skillRuntime = new ModuleSkillRuntime();
    const skillResult = await skillRuntime.invoke({
      skill: {
        id: 'skill.demo',
        name: 'demo',
        rootDir: skillRoot,
        entryFile: 'entry.cjs'
      },
      input: { value: 'hello' },
      context: {
        taskId: 'task_skill',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: null
      }
    });

    const mcpRoot = path.join(root, 'mcp');
    fs.mkdirSync(mcpRoot, { recursive: true });
    const serverScript = path.join(mcpRoot, 'server.cjs');
    fs.writeFileSync(serverScript, [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  process.stdout.write(JSON.stringify({ id: message.id, ok: true, output: { toolName: message.params.toolName, echoed: message.params.arguments.value }, metadata: { transport: 'stdio' } }) + '\\n');",
      "  setTimeout(() => process.exit(0), 10);",
      "});"
    ].join('\n'), 'utf8');

    const mcpClient = new StdioMcpClientAdapter();
    const mcpResult = await mcpClient.callTool({
      server: {
        id: 'mcp.demo',
        name: 'demo',
        transport: 'stdio',
        command: process.execPath,
        args: [serverScript]
      },
      toolName: 'echo',
      arguments: { value: 'world' },
      context: {
        taskId: 'task_mcp',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1'
      }
    });

    assert.equal(skillResult.ok, true);
    assert.equal(skillResult.output.echoed, 'hello');
    assert.equal(mcpResult.ok, true);
    assert.equal(mcpResult.output.toolName, 'echo');
    assert.equal(mcpResult.output.echoed, 'world');
    mcpClient.close();
  } finally {
    removeDir(root);
  }
});

test('module skill runtime rejects escaped entry file and reports structured error metadata', async () => {
  const root = createTempRoot();
  try {
    const skillRoot = path.join(root, 'skills', 'unsafe');
    fs.mkdirSync(skillRoot, { recursive: true });
    const runtime = new ModuleSkillRuntime();
    const result = await runtime.invoke({
      skill: {
        id: 'skill.unsafe',
        name: 'unsafe',
        rootDir: skillRoot,
        entryFile: '../escape.cjs'
      },
      input: {},
      context: {
        taskId: 'task_skill',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: null
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.metadata.errorKind, 'RESOLVE');
    assert.match(result.error, /skill root/i);
  } finally {
    removeDir(root);
  }
});

test('http and ws mcp adapters support capability discovery and tool invocation', async () => {
  const httpServer = http.createServer((request, response) => {
    if (request.url === '/capabilities' && request.method === 'GET') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        capability: {
          supportsTools: true,
          supportsPrompts: false,
          supportsResources: true,
          supportsStreaming: false
        },
        metadata: {
          transport: 'http'
        }
      }));
      return;
    }

    if (request.url === '/call-tool' && request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          ok: true,
          output: {
            echoed: payload.arguments.value,
            toolName: payload.toolName
          },
          metadata: {
            transport: 'http'
          }
        }));
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  const wsServer = new WebSocket.Server({ port: 0 });
  wsServer.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.method === 'discoverCapabilities') {
        socket.send(JSON.stringify({
          id: message.id,
          ok: true,
          capability: {
            supportsTools: true,
            supportsPrompts: false,
            supportsResources: false,
            supportsStreaming: true
          },
          metadata: {
            transport: 'ws'
          }
        }));
        return;
      }
      socket.send(JSON.stringify({
        id: message.id,
        ok: true,
        output: {
          echoed: message.params.arguments.value,
          toolName: message.params.toolName
        },
        metadata: {
          transport: 'ws'
        }
      }));
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = httpServer.address().port;
    const wsPort = wsServer.address().port;

    const httpClient = new HttpMcpClientAdapter();
    const wsClient = new WsMcpClientAdapter();
    const context = {
      taskId: 'task_mcp',
      sessionId: 'sess_1',
      correlationId: 'corr_1',
      turnId: 'turn_1'
    };

    const httpCapabilities = await httpClient.discoverCapabilities({
      server: {
        id: 'mcp.http',
        name: 'http-demo',
        transport: 'http',
        url: `http://127.0.0.1:${httpPort}`
      },
      context
    });
    const httpResult = await httpClient.callTool({
      server: {
        id: 'mcp.http',
        name: 'http-demo',
        transport: 'http',
        url: `http://127.0.0.1:${httpPort}`
      },
      toolName: 'echo',
      arguments: {
        value: 'http'
      },
      context
    });
    const wsCapabilities = await wsClient.discoverCapabilities({
      server: {
        id: 'mcp.ws',
        name: 'ws-demo',
        transport: 'ws',
        url: `ws://127.0.0.1:${wsPort}`
      },
      context
    });
    const wsResult = await wsClient.callTool({
      server: {
        id: 'mcp.ws',
        name: 'ws-demo',
        transport: 'ws',
        url: `ws://127.0.0.1:${wsPort}`
      },
      toolName: 'echo',
      arguments: {
        value: 'ws'
      },
      context
    });

    assert.equal(httpCapabilities.capability.supportsResources, true);
    assert.equal(httpResult.ok, true);
    assert.equal(httpResult.output.echoed, 'http');
    assert.equal(wsCapabilities.capability.supportsStreaming, true);
    assert.equal(wsResult.ok, true);
    assert.equal(wsResult.output.echoed, 'ws');
    wsClient.close();
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
    await new Promise(resolve => wsServer.close(resolve));
  }
});

test('provider failure normalization preserves production diagnostics', () => {
  const normalized = normalizeProviderFailure({
    name: 'Error',
    message: 'plain object'
  });
  assert.equal(normalized.kind, 'UNKNOWN');
  assert.equal(normalized.category, 'provider_unavailable');
  assert.equal(normalized.retryable, false);
});

test('provider failure normalization maps retryability and auth semantics to stable categories', () => {
  const rateLimited = normalizeProviderFailure(new ProviderHttpError('slow down', 'RATE_LIMIT', 429, true));
  const authFailed = normalizeProviderFailure(new ProviderHttpError('bad key', 'AUTH', 401, false));
  const networkRetryable = normalizeProviderFailure(new ProviderHttpError('socket hang up', 'NETWORK', null, true));
  const networkNonRetryable = normalizeProviderFailure(new ProviderHttpError('dns failure', 'NETWORK', null, false));
  const contractError = normalizeProviderFailure(new ProviderHttpError('bad request', 'UNKNOWN', 422, false));

  assert.equal(rateLimited.category, 'rate_limited');
  assert.equal(authFailed.category, 'auth_failed');
  assert.equal(networkRetryable.category, 'network_retryable');
  assert.equal(networkNonRetryable.category, 'network_non_retryable');
  assert.equal(contractError.category, 'provider_contract_error');
});

test('openai-compatible provider preserves upstream 408 timeout diagnostics', async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = 408;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { message: 'upstream timeout' } }));
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new OpenAiCompatibleProviderClient();
    const request = buildProviderCompletionRequest({
      profile: {
        id: 'xiaomi-live',
        label: 'Xiaomi Live',
        transport: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mimo-v2.5',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_timeout_upstream',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'user', content: 'Generate the next scaffold module.' }],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 0,
        retryBackoffMs: 1
      }
    });

    await assert.rejects(
      () => client.complete(request),
      (error) => {
        assert.equal(error instanceof ProviderHttpError, true);
        assert.equal(error.kind, 'TIMEOUT');
        assert.equal(error.statusCode, 408);
        assert.equal(error.timeoutOrigin, 'upstream_http_408');
        assert.equal(typeof error.elapsedMs, 'number');
        assert.ok(error.elapsedMs >= 0);
        assert.equal(error.requestTimeoutMs, 5000);
        assert.equal(error.retryAttempt, 1);
        const normalized = normalizeProviderFailure(error);
        assert.equal(normalized.category, 'timeout');
        assert.equal(normalized.timeoutOrigin, 'upstream_http_408');
        return true;
      }
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('openai-compatible provider distinguishes local request timeout aborts from upstream 408', async () => {
  const server = http.createServer((_request, _response) => {
    // Keep the socket open long enough for the local timeout to fire.
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new OpenAiCompatibleProviderClient();
    const request = buildProviderCompletionRequest({
      profile: {
        id: 'xiaomi-live',
        label: 'Xiaomi Live',
        transport: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mimo-v2.5',
        apiKey: 'sk-secret'
      },
      context: {
        taskId: 'task_timeout_local',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [{ role: 'user', content: 'Continue the prototype scaffold.' }],
      metadata: {
        timeoutMs: 75,
        maxRetries: 0,
        retryBackoffMs: 1
      }
    });

    await assert.rejects(
      () => client.complete(request),
      (error) => {
        assert.equal(error instanceof ProviderHttpError, true);
        assert.equal(error.kind, 'TIMEOUT');
        assert.equal(error.statusCode, 408);
        assert.equal(error.timeoutOrigin, 'local_abort');
        assert.equal(error.requestTimeoutMs, 75);
        assert.equal(error.retryAttempt, 1);
        assert.equal(typeof error.elapsedMs, 'number');
        assert.ok(error.elapsedMs >= 50);
        const normalized = normalizeProviderFailure(error);
        assert.equal(normalized.timeoutOrigin, 'local_abort');
        return true;
      }
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
