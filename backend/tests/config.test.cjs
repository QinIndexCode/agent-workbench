const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBackendNewFoundation, loadBackendNewConfig } = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('loadBackendNewConfig resolves foundation paths and extension paths', () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig(
      {},
      {
        cwd: root,
        env: {
          BACKEND_NEW_ROOT_DIR: 'runtime-root',
          BACKEND_NEW_SKILL_ROOTS: 'skills/a,skills/b',
          BACKEND_NEW_MCP_REGISTRY: 'mcp/servers.json',
          BACKEND_NEW_TOOL_MANIFEST: 'tools/manifest.json',
          BACKEND_NEW_TOOL_PERMISSION_MODE: 'read-only',
          BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS: '45000',
          BACKEND_NEW_PROVIDER_MAX_RETRIES: '4',
          BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS: '1200',
          BACKEND_NEW_RUNTIME_PROMPT_SECTION_CHARACTER_LIMIT: '2400',
          BACKEND_NEW_RUNTIME_PROMPT_MAX_SUMMARY_ITEMS: '5'
        }
      }
    );

    assert.equal(config.paths.rootDir, path.resolve(root, 'runtime-root'));
    assert.equal(config.paths.secretsDir, path.resolve(root, 'runtime-root', 'secrets'));
    assert.equal(config.paths.sessionsDir, path.resolve(root, 'runtime-root', 'sessions'));
    assert.equal(config.paths.projectionsDir, path.resolve(root, 'runtime-root', 'projections'));
    assert.equal(config.paths.eventsDir, path.resolve(root, 'runtime-root', 'events'));
    assert.equal(config.paths.outputsDir, path.resolve(root, 'runtime-root', 'validated-outputs'));
    assert.equal(config.paths.toolInvocationsDir, path.resolve(root, 'runtime-root', 'tool-invocations'));
    assert.equal(config.paths.approvalsDir, path.resolve(root, 'runtime-root', 'approvals'));
    assert.equal(config.paths.conversationsDir, path.resolve(root, 'runtime-root', 'conversations'));
    assert.equal(config.paths.configSnapshotsDir, path.resolve(root, 'runtime-root', 'config-snapshots'));
    assert.deepEqual(config.skills.roots, [
      path.resolve(root, 'runtime-root', 'skills/a'),
      path.resolve(root, 'runtime-root', 'skills/b')
    ]);
    assert.equal(
      config.mcp.registryFile,
      path.resolve(root, 'runtime-root', 'mcp/servers.json')
    );
    assert.equal(
      config.tools.manifestFile,
      path.resolve(root, 'runtime-root', 'tools/manifest.json')
    );
    assert.equal(config.tools.permissionMode, 'read-only');
    assert.equal(config.providers.requestTimeoutMs, 45000);
    assert.equal(config.providers.maxRetries, 4);
    assert.equal(config.providers.retryBackoffMs, 1200);
    assert.equal(config.runtime.promptSectionCharacterLimit, 2400);
    assert.equal(config.runtime.promptMaxSummaryItems, 5);
  } finally {
    removeDir(root);
  }
});

test('loadBackendNewConfig rejects invalid logging and security settings', () => {
  const root = createTempRoot();
  try {
    assert.throws(
      () =>
        loadBackendNewConfig(
          {
            logging: {
              longTextLimit: 10,
              shortTextLimit: 50
            }
          },
          { cwd: root, env: {} }
        ),
      /longTextLimit/
    );

    assert.throws(
      () =>
        loadBackendNewConfig(
          {
            security: {
              secretKeyEnvVar: '   '
            }
          },
          { cwd: root, env: {} }
        ),
      /secretKeyEnvVar/
    );

    assert.throws(
      () =>
        loadBackendNewConfig(
          {
            tools: {
              permissionMode: 'unsafe'
            }
          },
          { cwd: root, env: {} }
        ),
      /permission mode/
    );

    assert.throws(
      () =>
        loadBackendNewConfig(
          {
            runtime: {
              maxContextMessages: 2,
              retainedContextMessages: 1,
              promptMaxSummaryItems: 3
            }
          },
          { cwd: root, env: {} }
        ),
      /promptMaxSummaryItems/
    );
  } finally {
    removeDir(root);
  }
});

test('createBackendNewFoundation can separate workspace cwd from runtime storage root', () => {
  const root = createTempRoot();
  try {
    const workspaceRoot = path.join(root, 'workspace-root');
    const runtimeRoot = path.join(root, 'runtime-root');
    const foundation = createBackendNewFoundation({
      env: {
        BACKEND_NEW_WORKSPACE_CWD: workspaceRoot,
        BACKEND_NEW_ROOT_DIR: runtimeRoot
      }
    });

    assert.equal(foundation.cwd, path.resolve(workspaceRoot));
    assert.equal(foundation.config.paths.rootDir, path.resolve(runtimeRoot));
  } finally {
    removeDir(root);
  }
});
