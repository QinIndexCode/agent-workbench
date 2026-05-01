const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadXiaomiLiveProviderModule() {
  const modulePath = pathToFileURL(
    path.resolve(__dirname, '../../scripts/lib/xiaomi-mimo-live-provider.mjs')
  ).href;
  return import(modulePath);
}

async function withTempRepo(run, options = {}) {
  const includeTokenPlan = options.includeTokenPlan ?? true;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaomi-live-provider-'));
  try {
    const lines = [
      '# Secrets',
      '',
      'xiaomi (mimo)',
      'apiKey: test-key',
      'baseUrl: https://api.xiaomimimo.com/v1/chat/completions',
    ];
    if (includeTokenPlan) {
      lines.push(
        '',
        'tokenPlan:',
        'tokenPlanApiKey:tp-test-key',
        'baseUrl:https://token-plan-cn.xiaomimimo.com/v1 (openAi)',
      );
    }
    lines.push('---');
    await fs.writeFile(
      path.join(tempDir, 'dont_touch_(APIKEY).md'),
      lines.join('\n'),
      'utf8'
    );
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('buildXiaomiMimoFlashLiveEnv uses text-agent model defaults and excludes the legacy flash request from the default matrix', async () => {
  const {
    buildXiaomiMimoFlashLiveEnv,
    XIAOMI_MIMO_FAST_MODEL,
    XIAOMI_MIMO_PRO_MODEL,
    XIAOMI_MIMO_STRONG_MODEL,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    const compatEnv = await buildXiaomiMimoFlashLiveEnv(repoRoot, {
      model: XIAOMI_MIMO_FAST_MODEL,
      env: {},
    });
    const strongEnv = await buildXiaomiMimoFlashLiveEnv(repoRoot, {
      model: XIAOMI_MIMO_STRONG_MODEL,
      env: {},
    });
    const proEnv = await buildXiaomiMimoFlashLiveEnv(repoRoot, {
      model: XIAOMI_MIMO_PRO_MODEL,
      env: {},
    });

    assert.equal(compatEnv.BACKEND_NEW_LIVE_PROVIDER_MODEL, 'mimo-v2-pro');
    assert.equal(strongEnv.BACKEND_NEW_LIVE_PROVIDER_MODEL, XIAOMI_MIMO_STRONG_MODEL);
    assert.equal(proEnv.BACKEND_NEW_LIVE_PROVIDER_MODEL, 'mimo-v2.5-pro');
    assert.equal(compatEnv.BACKEND_NEW_LIVE_PROVIDER_API_KEY, 'test-key');
    assert.equal(compatEnv.BACKEND_NEW_LIVE_PROVIDER_MANIFEST, compatEnv.BACKEND_NEW_PROVIDER_MANIFEST);
    assert.match(compatEnv.BACKEND_NEW_LIVE_PROVIDER_MANIFEST, /xiaomi-mimo-v2-flash\.mimo-v2-pro\.manifest\.json$/);
    assert.equal(compatEnv.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS, '60000');
    assert.equal(strongEnv.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS, '90000');
    assert.equal(proEnv.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS, '90000');
    assert.equal(compatEnv.BACKEND_NEW_PROVIDER_MAX_RETRIES, '2');
    assert.equal(strongEnv.BACKEND_NEW_PROVIDER_MAX_RETRIES, '2');
  }, { includeTokenPlan: false });
});

test('readXiaomiMimoFlashProviderSource prefers tokenPlan credentials and base URL when present', async () => {
  const {
    readXiaomiMimoFlashProviderSource,
    XIAOMI_MIMO_STRONG_MODEL,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    const source = await readXiaomiMimoFlashProviderSource(repoRoot, {
      model: XIAOMI_MIMO_STRONG_MODEL,
      env: {},
    });

    assert.equal(source.apiKey, 'tp-test-key');
    assert.equal(source.chatCompletionsUrl, 'https://token-plan-cn.xiaomimimo.com/v1 (openAi)');
    assert.equal(source.baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
  });
});

test('readXiaomiMimoFlashProviderSource rejects unsupported flash model on tokenPlan endpoint', async () => {
  const {
    readXiaomiMimoFlashProviderSource,
    XIAOMI_MIMO_FLASH_MODEL,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    await assert.rejects(
      () => readXiaomiMimoFlashProviderSource(repoRoot, {
        model: XIAOMI_MIMO_FLASH_MODEL,
        env: {},
      }),
      /does not currently support model mimo-v2-flash/i
    );
  });
});

test('readXiaomiMimoFlashProviderSource can fall back from flash to v2.5 on tokenPlan for endpoint-aware harnesses', async () => {
  const {
    readXiaomiMimoFlashProviderSource,
    buildXiaomiMimoFlashLiveEnv,
    XIAOMI_MIMO_FLASH_MODEL,
    XIAOMI_MIMO_STRONG_MODEL,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    const source = await readXiaomiMimoFlashProviderSource(repoRoot, {
      model: XIAOMI_MIMO_FLASH_MODEL,
      env: {},
      allowCompatibleModelFallback: true,
    });
    const env = await buildXiaomiMimoFlashLiveEnv(repoRoot, {
      model: XIAOMI_MIMO_FLASH_MODEL,
      env: {},
      allowCompatibleModelFallback: true,
    });

    assert.equal(source.requestedModel, XIAOMI_MIMO_FLASH_MODEL);
    assert.equal(source.model, XIAOMI_MIMO_STRONG_MODEL);
    assert.equal(env.BACKEND_NEW_LIVE_PROVIDER_MODEL, XIAOMI_MIMO_STRONG_MODEL);
    assert.equal(env.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS, '90000');
  });
});

test('readXiaomiMimoFlashProviderSource rejects TTS models when the text-agent matrix is required', async () => {
  const {
    readXiaomiMimoFlashProviderSource,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    await assert.rejects(
      () => readXiaomiMimoFlashProviderSource(repoRoot, {
        model: 'mimo-v2.5-tts',
        env: {},
        requireTextAgentModel: true,
      }),
      /not part of the text-agent validation matrix/i
    );
  });
});

test('buildXiaomiMimoFlashLiveEnv honors explicit provider timeout overrides', async () => {
  const {
    buildXiaomiMimoFlashLiveEnv,
    XIAOMI_MIMO_STRONG_MODEL,
  } = await loadXiaomiLiveProviderModule();

  await withTempRepo(async (repoRoot) => {
    const env = await buildXiaomiMimoFlashLiveEnv(repoRoot, {
      model: XIAOMI_MIMO_STRONG_MODEL,
      env: {
        BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS: '120000',
        BACKEND_NEW_PROVIDER_MAX_RETRIES: '5',
        BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS: '2500',
      },
    });

    assert.equal(env.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS, '120000');
    assert.equal(env.BACKEND_NEW_PROVIDER_MAX_RETRIES, '5');
    assert.equal(env.BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS, '2500');
  });
});
