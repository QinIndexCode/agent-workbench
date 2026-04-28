const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AnthropicCompatibleProviderClient,
  createSecretCipher,
  FileApiKeySecretRepository,
  FileStorageAdapter,
  getProviderPreset,
  ProviderRegistry,
  selectProviderProfile,
  StorageLayout,
  loadBackendNewConfig,
  loadProviderManifest,
  resolveProviderProfile
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('provider manifest and api key secret resolve into runtime profile', async () => {
  const root = createTempRoot();
  try {
    const env = {
      BACKEND_NEW_ROOT_DIR: 'data',
      BACKEND_NEW_SECRET_ENCRYPTION: 'aes-256-gcm',
      BACKEND_NEW_SECRET_KEY_ENV: 'BACKEND_NEW_SECRET_KEY',
      BACKEND_NEW_SECRET_KEY: Buffer.alloc(32, 6).toString('base64')
    };
    const config = loadBackendNewConfig({}, { cwd: root, env });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const secrets = new FileApiKeySecretRepository(
      config,
      storage,
      layout,
      createSecretCipher(config, env)
    );
    const registry = new ProviderRegistry();

    await storage.ensureDir(path.dirname(config.providers.manifestFile));
    await storage.ensureDir(layout.paths.secretsDir);

    fs.writeFileSync(
      config.providers.manifestFile,
      JSON.stringify({
        providers: [
          {
            id: 'deepseek-main',
            label: 'DeepSeek Main',
            vendor: 'deepseek',
            model: 'deepseek-chat',
            apiKeySecretId: 'deepseek_api'
          }
        ]
      })
    );

    await secrets.save({
      id: 'deepseek_api',
      provider: 'deepseek',
      label: 'DeepSeek API',
      apiKey: 'sk-provider-demo',
      createdAt: 1,
      updatedAt: 2,
      metadata: {}
    });

    await loadProviderManifest(config, storage, registry);
    const profile = await resolveProviderProfile(registry, secrets, 'deepseek-main');

    assert.equal(profile.id, 'deepseek-main');
    assert.equal(profile.apiKey, 'sk-provider-demo');
    assert.equal(profile.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(profile.transport, 'deepseek-compatible');
    assert.equal(profile.vendor, 'deepseek');
  } finally {
    removeDir(root);
  }
});

test('provider resolver rejects invalid cloud profile without baseUrl', async () => {
  const root = createTempRoot();
  try {
    const env = {
      BACKEND_NEW_ROOT_DIR: 'data'
    };
    const config = loadBackendNewConfig({}, { cwd: root, env });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const secrets = new FileApiKeySecretRepository(
      config,
      storage,
      layout,
      createSecretCipher(config, env)
    );
    const registry = new ProviderRegistry();
    registry.register({
      id: 'broken-cloud',
      label: 'Broken Cloud',
      transport: 'openai-compatible',
      model: 'gpt-x',
      apiKeySecretId: 'missing'
    });

    await assert.rejects(
      () => resolveProviderProfile(registry, secrets, 'broken-cloud'),
      /baseUrl/
    );
  } finally {
    removeDir(root);
  }
});

test('provider selection policy respects preferred, default, and local preference', () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig(
      {
        providers: {
          defaultProviderId: 'cloud-main',
          preferLocalModels: true
        }
      },
      { cwd: root, env: {} }
    );
    const registry = new ProviderRegistry();
    registry.register({
      id: 'cloud-main',
      label: 'Cloud Main',
      transport: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      model: 'cloud-model'
    });
    registry.register({
      id: 'local-main',
      label: 'Local Main',
      transport: 'local-stdio',
      model: 'local-model'
    });
    registry.register({
      id: 'ollama-main',
      label: 'Ollama Main',
      vendor: 'ollama',
      model: 'qwen2.5:7b'
    });

    assert.equal(
      selectProviderProfile(registry, config, { preferredProviderId: 'local-main' }).id,
      'local-main'
    );
    assert.equal(selectProviderProfile(registry, config, {}).id, 'cloud-main');

    const configPreferLocal = loadBackendNewConfig(
      {
        providers: {
          defaultProviderId: null,
          preferLocalModels: true
        }
      },
      { cwd: root, env: {} }
    );
    assert.equal(selectProviderProfile(registry, configPreferLocal, {}).id, 'local-main');

    const configPreferLocalHttp = loadBackendNewConfig(
      {
        providers: {
          defaultProviderId: null,
          preferLocalModels: true
        }
      },
      { cwd: root, env: {} }
    );
    const registryLocalHttp = new ProviderRegistry();
    registryLocalHttp.register({
      id: 'cloud-main',
      label: 'Cloud Main',
      transport: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      model: 'cloud-model'
    });
    registryLocalHttp.register({
      id: 'ollama-main',
      label: 'Ollama Main',
      vendor: 'ollama',
      model: 'qwen2.5:7b'
    });
    assert.equal(selectProviderProfile(registryLocalHttp, configPreferLocalHttp, {}).id, 'ollama-main');
  } finally {
    removeDir(root);
  }
});

test('provider presets cover mainstream vendor defaults', () => {
  assert.equal(getProviderPreset('openai').transport, 'openai-compatible');
  assert.equal(getProviderPreset('anthropic').transport, 'anthropic-compatible');
  assert.equal(getProviderPreset('deepseek').transport, 'deepseek-compatible');
  assert.equal(getProviderPreset('grok').baseUrl, 'https://api.x.ai/v1');
  assert.equal(getProviderPreset('kimi').baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(getProviderPreset('glm').baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(getProviderPreset('ollama').baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(getProviderPreset('huggingface').baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(getProviderPreset('vllm').baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(getProviderPreset('lmstudio').baseUrl, 'http://127.0.0.1:1234/v1');
});

test('anthropic-compatible provider uses anthropic headers and messages endpoint', async () => {
  const root = createTempRoot();
  const http = require('node:http');
  let seenHeaders = null;
  let seenPath = null;
  let seenBody = null;
  const server = http.createServer((request, response) => {
    seenHeaders = request.headers;
    seenPath = request.url;
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: 'msg_1',
        model: 'claude-3-7-sonnet',
        content: [{ type: 'text', text: 'anthropic ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 7 }
      }));
    });
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = new AnthropicCompatibleProviderClient();
    const result = await client.complete({
      profile: {
        id: 'anthropic-main',
        label: 'Anthropic Main',
        vendor: 'anthropic',
        transport: 'anthropic-compatible',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'claude-3-7-sonnet',
        apiKey: 'sk-ant',
        auth: { scheme: 'x-api-key' },
        endpoints: { messagesPath: '/messages' },
        apiVersion: '2023-06-01',
        organization: null,
        project: null
      },
      context: {
        taskId: 'task_a',
        unitId: 'AGENT-001',
        sessionId: 'sess_1',
        correlationId: 'corr_1',
        turnId: 'turn_1',
        checkpointId: 'chk_1'
      },
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Hello' }
      ],
      metadata: {
        timeoutMs: 5000,
        maxRetries: 1,
        retryBackoffMs: 10
      }
    });

    assert.equal(seenPath, '/messages');
    assert.equal(seenHeaders['x-api-key'], 'sk-ant');
    assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
    assert.equal(seenBody.system, 'Be precise.');
    assert.equal(result.outputText, 'anthropic ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
    removeDir(root);
  }
});
