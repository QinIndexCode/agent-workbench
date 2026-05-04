const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadLiveCostGuardModule() {
  const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/lib/live-cost-guard.mjs')).href;
  return import(modulePath);
}

test('evaluateLiveCostGuard is disabled when no budgets are configured', async () => {
  const { evaluateLiveCostGuard } = await loadLiveCostGuardModule();

  const result = await evaluateLiveCostGuard({
    rootDir: path.resolve(__dirname, '../..'),
    env: {},
    label: 'test-live-command'
  });

  assert.equal(result.status, 'disabled');
  assert.equal(result.blocked, false);
  assert.equal(result.reason, 'limits_not_configured');
});

test('evaluateLiveCostGuard blocks when the probe report is missing and budgets are configured', async () => {
  const { evaluateLiveCostGuard } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-missing-'));

  try {
    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4'
      },
      label: 'agent-cli:live'
    });

    assert.equal(result.status, 'cost_guard_blocked');
    assert.equal(result.blocked, true);
    assert.match(result.reason, /missing_probe_report/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard accepts provider cache telemetry fallback when stable prefix and usage metrics exist', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-ok-'));

  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2.5'
      },
      promptBudget: {
        stablePrefixChars: 1200,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0.75
      },
      usage: {
        apiCalls: 2,
        totalTokens: 1800
      },
      cacheTelemetryStatus: 'provider_cache_telemetry_unavailable'
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4',
        LIVE_COST_MAX_TOTAL_TOKENS: '4000'
      },
      label: 'agent-script-catalog'
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.blocked, false);
    assert.equal(result.cacheTelemetryStatus, 'provider_cache_telemetry_unavailable');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard accepts the flash model when the expected model is overridden in env', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-flash-'));
  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2-flash'
      },
      promptBudget: {
        stablePrefixChars: 1200,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0.75
      },
      usage: {
        apiCalls: 2,
        totalTokens: 1800
      },
      cacheTelemetryStatus: 'provider_cache_telemetry_unavailable'
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4',
        LIVE_COST_MAX_TOTAL_TOKENS: '4000',
        XIAOMI_MIMO_LIVE_MODEL: 'mimo-v2-flash'
      },
      label: 'agent-cli:live'
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.blocked, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard blocks when stable prefix metrics are missing', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-prefix-'));

  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2.5'
      },
      promptBudget: {
        stablePrefixChars: 0,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0
      },
      usage: {
        apiCalls: 2,
        totalTokens: 1800
      },
      cacheTelemetryStatus: 'reported'
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4'
      },
      label: 'ordinary-interaction:live'
    });

    assert.equal(result.status, 'cost_guard_blocked');
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'stable_prefix_metrics_missing');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard classifies provider TLS handshake failures as environment blockers', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-tls-'));

  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2.5'
      },
      promptBudget: {
        stablePrefixChars: 1200,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0.75
      },
      usage: {
        apiCalls: 0,
        totalTokens: 0
      },
      cacheTelemetryStatus: 'provider_cache_telemetry_unavailable',
      issues: [
        'provider_probe_failed:backend_new provider error: openai-compatible network failure: write EPROTO ... ssl/tls alert handshake failure'
      ],
      error: {
        message: 'write EPROTO ssl/tls alert handshake failure'
      }
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4'
      },
      label: 'agent-cli:live'
    });

    assert.equal(result.status, 'cost_guard_blocked');
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'environment_blocker:provider_tls_handshake_failed');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard classifies reserved endpoint resolution as environment blocker', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-dns-'));

  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2.5'
      },
      dns: {
        hostname: 'api.xiaomimimo.com',
        addresses: ['198.18.0.115'],
        hasReservedAddress: true
      },
      promptBudget: {
        stablePrefixChars: 1200,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0.75
      },
      usage: {
        apiCalls: 0,
        totalTokens: 0
      },
      cacheTelemetryStatus: 'provider_cache_telemetry_unavailable',
      issues: [
        'provider_endpoint_resolves_to_reserved_address:198.18.0.115'
      ]
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4'
      },
      label: 'agent-cli:live'
    });

    assert.equal(result.status, 'cost_guard_blocked');
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'environment_blocker:provider_endpoint_resolves_to_reserved_address');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('evaluateLiveCostGuard does not block reserved fake-ip resolution when real usage was recorded', async () => {
  const { evaluateLiveCostGuard, resolveLiveCostProbeReportPath } = await loadLiveCostGuardModule();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cost-guard-fake-ip-ok-'));

  try {
    const reportPath = resolveLiveCostProbeReportPath(tempDir);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      provider: {
        providerId: 'xiaomi-mimo-v2-flash',
        model: 'mimo-v2.5'
      },
      dns: {
        hostname: 'api.xiaomimimo.com',
        addresses: ['198.18.0.24'],
        hasReservedAddress: true
      },
      promptBudget: {
        stablePrefixChars: 1200,
        volatileSuffixChars: 400,
        stablePrefixRatio: 0.75
      },
      usage: {
        apiCalls: 2,
        totalTokens: 2236
      },
      cacheTelemetryStatus: 'provider_cache_telemetry_unavailable',
      issues: []
    }), 'utf8');

    const result = await evaluateLiveCostGuard({
      rootDir: tempDir,
      env: {
        LIVE_COST_MAX_API_CALLS: '4',
        LIVE_COST_MAX_TOTAL_TOKENS: '4000'
      },
      label: 'agent-cli:live'
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.blocked, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
