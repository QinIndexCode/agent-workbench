const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createBackendNewFoundation,
  createBackendNewRuntime,
  createConfigFingerprint,
  createConfigSnapshotRecord,
  createConversationMessage,
  FileConfigSnapshotRepository,
  FileConversationRepository,
  FileStorageAdapter,
  StorageLayout,
  loadBackendNewConfig,
  shouldReloadConfig
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('conversation repository stores ordered user assistant messages', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const conversations = new FileConversationRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.conversationsDir);

    await conversations.append(
      createConversationMessage({
        taskId: 'task_conv',
        role: 'user',
        content: 'hello'
      })
    );
    await conversations.append(
      createConversationMessage({
        taskId: 'task_conv',
        role: 'assistant',
        content: 'world'
      })
    );

    const messages = await conversations.list('task_conv');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
  } finally {
    removeDir(root);
  }
});

test('config reload policy snapshots and detects config changes', async () => {
  const root = createTempRoot();
  try {
    const configA = loadBackendNewConfig({}, { cwd: root, env: {} });
    const configB = loadBackendNewConfig(
      {
        logging: {
          retentionDays: 30
        }
      },
      { cwd: root, env: {} }
    );
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(configA);
    const snapshots = new FileConfigSnapshotRepository(configA, storage, layout);

    await storage.ensureDir(layout.paths.configSnapshotsDir);

    const snapshot = createConfigSnapshotRecord(configA, 123);
    await snapshots.save({
      version: snapshot.version,
      fingerprint: snapshot.fingerprint,
      createdAt: snapshot.createdAt,
      config: snapshot.config
    });

    const active = await snapshots.getActive();
    assert.equal(active.fingerprint, createConfigFingerprint(configA));
    assert.equal(shouldReloadConfig(active, configA), false);
    assert.equal(shouldReloadConfig(active, configB), true);
  } finally {
    removeDir(root);
  }
});

test('create-runtime writes conversation messages and config snapshot on analysis', async () => {
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
      taskId: 'task_conv_runtime',
      currentUnitId: 'AGENT-001',
      outputContract: '{"summary":"string","issues":[]}',
      userMessage: 'Please analyze this task',
      llmResponse:
        '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
    });

    const config = loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} });
    const layout = new StorageLayout(config);
    const convoText = fs.readFileSync(layout.forTask('task_conv_runtime').conversationLogPath, 'utf8');
    const configText = fs.readFileSync(layout.configSnapshotPath, 'utf8');
    const messages = convoText.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const configSnapshot = JSON.parse(configText);

    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[2].role, 'runtime');
    assert.match(configSnapshot.version, /^cfg_/);
  } finally {
    removeDir(root);
  }
});

test('config updates report hot-reload versus restart-required state through snapshot authority', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const before = await runtime.platform.getConfigState();
    const currentPort = before.current.server.port;

    const safeUpdate = await runtime.platform.updateConfig({
      logging: {
        retentionDays: 30
      }
    });
    assert.equal(safeUpdate.resource.reloadApplied, true);
    assert.equal(safeUpdate.resource.restartRequired, false);
    assert.match(safeUpdate.resource.activeSnapshotVersion, /^cfg_/);
    assert.equal(safeUpdate.resource.current.logging.retentionDays, 30);

    const restartUpdate = await runtime.platform.updateConfig({
      server: {
        port: currentPort + 1
      }
    });
    assert.equal(restartUpdate.resource.reloadApplied, false);
    assert.equal(restartUpdate.resource.restartRequired, true);
    assert.match(restartUpdate.resource.activeSnapshotVersion, /^cfg_/);

    const after = await runtime.platform.getConfigState();
    assert.equal(after.current.server.port, currentPort);
    assert.equal(after.restartRequired, true);
    assert.equal(after.reloadApplied, false);
  } finally {
    removeDir(root);
  }
});

test('config updates can hot-reload runtime delegation settings', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    const before = await runtime.platform.getConfigState();
    assert.equal(before.current.runtime.delegation.enabled, false);

    const enabledUpdate = await runtime.platform.updateConfig({
      runtime: {
        delegation: {
          enabled: true,
          maxDepth: 1,
          maxActiveChildrenPerTask: 1
        }
      }
    });
    assert.equal(enabledUpdate.resource.reloadApplied, true);
    assert.equal(enabledUpdate.resource.restartRequired, false);
    assert.equal(enabledUpdate.resource.current.runtime.delegation.enabled, true);
    assert.equal(enabledUpdate.resource.current.runtime.delegation.maxDepth, 1);
    assert.equal(enabledUpdate.resource.current.runtime.delegation.maxActiveChildrenPerTask, 1);

    const afterEnable = await runtime.platform.getConfigState();
    assert.equal(afterEnable.current.runtime.delegation.enabled, true);

    const disabledUpdate = await runtime.platform.updateConfig({
      runtime: {
        delegation: {
          enabled: false,
          maxDepth: 1,
          maxActiveChildrenPerTask: 1
        }
      }
    });
    assert.equal(disabledUpdate.resource.reloadApplied, true);
    assert.equal(disabledUpdate.resource.restartRequired, false);
    assert.equal(disabledUpdate.resource.current.runtime.delegation.enabled, false);

    const afterDisable = await runtime.platform.getConfigState();
    assert.equal(afterDisable.current.runtime.delegation.enabled, false);
  } finally {
    removeDir(root);
  }
});

test('skill refresh reconciles declared roots and persisted import manifest', async () => {
  const root = createTempRoot();
  const declaredRoot = path.join(root, 'skills', 'declared');
  const importedRoot = path.join(root, 'skills', 'imported');
  const normalizePath = (value) => path.resolve(value).toLowerCase();
  fs.mkdirSync(declaredRoot, { recursive: true });
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        },
        skills: {
          enabled: true,
          roots: [declaredRoot]
        }
      }
    });

    const initial = await runtime.platform.listSkills();
    assert.equal(
      initial.some((entry) => normalizePath(entry.skill.rootDir) === normalizePath(declaredRoot)),
      true
    );

    fs.rmSync(declaredRoot, { recursive: true, force: true });
    fs.mkdirSync(importedRoot, { recursive: true });

    const imported = await runtime.platform.importSkill({
      name: 'Imported Skill',
      rootDir: importedRoot,
      description: 'Imported through manifest authority'
    });
    assert.equal(imported.resource.rootDir, importedRoot);

    const refreshed = await runtime.platform.refreshSkills();
    assert.equal(
      refreshed.resource.some((entry) => normalizePath(entry.skill.rootDir) === normalizePath(declaredRoot)),
      false
    );
    assert.equal(
      refreshed.resource.some((entry) => normalizePath(entry.skill.rootDir) === normalizePath(importedRoot)),
      true
    );

    const layout = new StorageLayout(loadBackendNewConfig({ paths: { rootDir: root } }, { cwd: process.cwd(), env: {} }));
    const manifest = JSON.parse(fs.readFileSync(layout.skillManifestPath, 'utf8'));
    assert.equal(Array.isArray(manifest.skills), true);
    assert.equal(
      manifest.skills.some((entry) => normalizePath(entry.rootDir) === normalizePath(importedRoot)),
      true
    );
  } finally {
    removeDir(root);
  }
});

test('setting the default provider records config authority without duplicate provider-level default audit', async () => {
  const root = createTempRoot();
  try {
    const runtime = createBackendNewRuntime({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    await runtime.platform.upsertProvider({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.test',
      model: 'mock-model'
    });

    const setDefault = await runtime.platform.setDefaultProvider('provider-main');
    const configTrail = await runtime.platform.getAuditTrail('CONFIG', 'active');
    const providerTrail = await runtime.platform.getAuditTrail('PROVIDER', 'provider-main');

    assert.equal(setDefault.resource.profile.id, 'provider-main');
    assert.equal(setDefault.resource.isDefault, true);
    assert.equal(configTrail.commands.some((record) => record.commandId === setDefault.commandId), true);
    assert.equal(configTrail.audits.some((record) => record.commandId === setDefault.commandId), true);
    assert.equal(providerTrail.commands.some((record) => record.commandId === setDefault.commandId), false);
    assert.equal(providerTrail.audits.some((record) => record.commandId === setDefault.commandId), false);

    const state = await runtime.platform.getConfigState();
    assert.equal(state.current.providers.defaultProviderId, 'provider-main');
    assert.equal(state.savedDefaultProviderId, 'provider-main');
  } finally {
    removeDir(root);
  }
});

test('config updates merge against the current effective config when an older snapshot is active', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        },
        server: {
          port: 3811
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });

    const staleSnapshot = createConfigSnapshotRecord(
      loadBackendNewConfig(
        {
          paths: {
            rootDir: root
          }
        },
        { cwd: root, env: {} }
      ),
      123
    );
    await foundation.configSnapshots.save({
      version: staleSnapshot.version,
      fingerprint: staleSnapshot.fingerprint,
      createdAt: staleSnapshot.createdAt,
      config: staleSnapshot.config
    });

    await runtime.platform.upsertProvider({
      id: 'provider-main',
      label: 'Provider Main',
      transport: 'openai-compatible',
      baseUrl: 'https://provider.example.test',
      model: 'mock-model'
    });

    const setDefault = await runtime.platform.setDefaultProvider('provider-main');
    assert.equal(setDefault.resource.isDefault, true);

    const permissionUpdate = await runtime.platform.updateConfig({
      tools: {
        permissionMode: 'full'
      }
    });

    assert.equal(permissionUpdate.resource.reloadApplied, true);
    assert.equal(permissionUpdate.resource.restartRequired, false);
    assert.equal(permissionUpdate.resource.current.server.port, 3811);
    assert.equal(permissionUpdate.resource.current.providers.defaultProviderId, 'provider-main');
    assert.equal(permissionUpdate.resource.savedDefaultProviderId, 'provider-main');
    assert.equal(permissionUpdate.resource.current.tools.permissionMode, 'full');

    const after = await runtime.platform.getConfigState();
    assert.equal(after.current.server.port, 3811);
    assert.equal(after.current.providers.defaultProviderId, 'provider-main');
    assert.equal(after.savedDefaultProviderId, 'provider-main');
    assert.equal(after.current.tools.permissionMode, 'full');
    assert.equal(after.reloadApplied, true);
    assert.equal(after.restartRequired, false);
  } finally {
    removeDir(root);
  }
});
