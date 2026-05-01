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
  listProviderPresetDefinitions,
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
    assert.equal(profile.baseUrl, 'https://api.deepseek.com');
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
  assert.equal(getProviderPreset('kimi').baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(getProviderPreset('glm').baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(getProviderPreset('ollama').transport, 'openai-compatible');
  assert.equal(getProviderPreset('ollama').baseUrl, 'http://localhost:11434/v1');
  assert.equal(getProviderPreset('huggingface').baseUrl, 'https://router.huggingface.co/v1');
  assert.equal(getProviderPreset('vllm').baseUrl, 'http://localhost:8000/v1');
  assert.equal(getProviderPreset('lmstudio').baseUrl, 'http://localhost:1234/v1');
});

test('provider preset catalog separates runnable adapters from profile-only and cloud-auth presets', () => {
  const presets = listProviderPresetDefinitions();
  const ids = new Set(presets.map((preset) => preset.id));

  for (const id of ['openai', 'xai', 'deepseek', 'anthropic', 'google_gemini', 'groq', 'openrouter', 'azure_openai', 'ollama', 'lmstudio', 'vllm', 'localai', 'llama_cpp']) {
    assert.equal(ids.has(id), true, `missing preset ${id}`);
  }

  const openai = presets.find((preset) => preset.id === 'openai');
  const cohere = presets.find((preset) => preset.id === 'cohere');
  const azure = presets.find((preset) => preset.id === 'azure_openai');
  const ollama = presets.find((preset) => preset.id === 'ollama');

  assert.equal(openai.implementationStatus, 'runnable');
  assert.equal(openai.capabilities.supportsVision, true);
  assert.equal(cohere.implementationStatus, 'profile-only');
  assert.equal(azure.category, 'enterprise-cloud');
  assert.equal(azure.implementationStatus, 'external-auth-required');
  assert.equal(azure.supportsQuickAdd, false);
  assert.equal(ollama.category, 'local');
  assert.equal(ollama.transport, 'openai-compatible');
});

test('provider preset catalog covers API key, enterprise cloud, and local connection surfaces', () => {
  const presets = listProviderPresetDefinitions();
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  assert.equal(byId.size, presets.length, 'provider preset ids must be unique');

  const apiKeyPresetIds = [
    'openai', 'xai', 'deepseek', 'anthropic', 'google_gemini', 'mistral', 'cohere',
    'groq', 'fireworks', 'cerebras', 'sambanova', 'together', 'openrouter',
    'perplexity', 'perplexity_agent', 'huggingface', 'nvidia_nim', 'ai21',
    'replicate', 'dashscope_intl', 'dashscope_us', 'dashscope_cn', 'zhipu',
    'zhipu_coding', 'moonshot', 'minimax', 'minimax_cn', 'siliconflow',
    'siliconflow_cn', 'qianfan', 'stepfun_global', 'stepfun_cn', 'stepfun_plan',
    'deepinfra', 'hyperbolic', 'novita', 'llama_api', 'vercel_ai_gateway',
    'heroku_inference'
  ];
  const enterprisePresetIds = [
    'azure_openai', 'vertex_ai_openai', 'aws_bedrock_openai',
    'cloudflare_workers_ai', 'cloudflare_ai_gateway', 'ibm_watsonx_gateway',
    'volcengine_ark', 'tencent_hunyuan'
  ];
  const localPresetIds = ['ollama', 'lmstudio', 'vllm', 'localai', 'llama_cpp'];

  for (const id of apiKeyPresetIds) {
    const preset = byId.get(id);
    assert.ok(preset, `missing API key preset ${id}`);
    assert.equal(preset.category, 'api-key', `${id} category`);
    assert.equal(Array.isArray(preset.envVarNames), true, `${id} env vars`);
    assert.equal(typeof preset.implementationStatus, 'string', `${id} implementation status`);
    assert.equal(Array.isArray(preset.capabilities.inputModalities), true, `${id} input modalities`);
    assert.equal(Array.isArray(preset.capabilities.outputModalities), true, `${id} output modalities`);
  }

  for (const id of enterprisePresetIds) {
    const preset = byId.get(id);
    assert.ok(preset, `missing enterprise preset ${id}`);
    assert.equal(preset.category, 'enterprise-cloud');
    assert.equal(preset.supportsQuickAdd, false);
    assert.equal(preset.implementationStatus, 'external-auth-required');
    assert.equal(preset.requiredConfigFields.length > 0, true, `${id} should declare required config fields`);
  }

  for (const id of localPresetIds) {
    const preset = byId.get(id);
    assert.ok(preset, `missing local preset ${id}`);
    assert.equal(preset.category, 'local');
    assert.equal(preset.transport, 'openai-compatible');
    assert.equal(preset.auth.scheme, 'none');
    assert.equal(preset.implementationStatus, 'runnable');
    assert.match(preset.baseUrl, /^http:\/\/localhost:/);
  }

  assert.deepEqual(byId.get('openai').envVarNames, ['OPENAI_API_KEY']);
  assert.equal(byId.get('google_gemini').baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.deepEqual(byId.get('huggingface').envVarNames, ['HF_TOKEN', 'HUGGINGFACE_API_KEY']);
  assert.deepEqual(byId.get('azure_openai').requiredConfigFields, ['resource', 'deployment', 'api_version']);
  assert.equal(byId.get('cohere').implementationStatus, 'profile-only');
  assert.equal(byId.get('replicate').transport, 'native-replicate');
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
