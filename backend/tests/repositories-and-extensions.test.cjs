const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSecretCipher,
  ExtensionRegistry,
  FileApiKeySecretRepository,
  FileCheckpointRepository,
  FileStorageAdapter,
  FileTaskRepository,
  StorageLayout,
  loadBackendNewConfig,
  loadExtensionManifests,
  loadSkillPlaceholders
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('repositories persist task, checkpoint, and encrypted api key', async () => {
  const root = createTempRoot();
  try {
    const env = {
      BACKEND_NEW_ROOT_DIR: 'data',
      BACKEND_NEW_SECRET_ENCRYPTION: 'aes-256-gcm',
      BACKEND_NEW_SECRET_KEY_ENV: 'BACKEND_NEW_SECRET_KEY',
      BACKEND_NEW_SECRET_KEY: Buffer.alloc(32, 5).toString('base64')
    };
    const config = loadBackendNewConfig({}, { cwd: root, env });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const tasks = new FileTaskRepository(config, storage, layout);
    const checkpoints = new FileCheckpointRepository(config, storage, layout);
    const secrets = new FileApiKeySecretRepository(
      config,
      storage,
      layout,
      createSecretCipher(config, env)
    );

    await storage.ensureDir(layout.paths.rootDir);
    await storage.ensureDir(layout.paths.tasksDir);
    await storage.ensureDir(layout.paths.checkpointsDir);
    await storage.ensureDir(layout.paths.secretsDir);

    await tasks.save({
      taskId: 'task_repo',
      status: 'RUNNING',
      currentUnitId: 'AGENT-001',
      updatedAt: 1,
      payload: { phase: 'runtime' }
    });
    await checkpoints.save({
      taskId: 'task_repo',
      timestamp: 2,
      state: { pendingCorrection: 'NONE' }
    });
    await secrets.save({
      id: 'deepseek_primary',
      provider: 'deepseek',
      label: 'DeepSeek Primary',
      apiKey: 'sk-live-demo',
      createdAt: 3,
      updatedAt: 4,
      metadata: { scope: 'primary' }
    });

    const task = await tasks.get('task_repo');
    const checkpoint = await checkpoints.get('task_repo');
    const secret = await secrets.get('deepseek_primary');
    const secretText = fs.readFileSync(layout.secretRecordPath('deepseek_primary'), 'utf8');

    assert.equal(task.payload.phase, 'runtime');
    assert.equal(checkpoint.state.pendingCorrection, 'NONE');
    assert.equal(secret.apiKey, 'sk-live-demo');
    assert.doesNotMatch(secretText, /sk-live-demo/);
    assert.match(secretText, /cipherText/);
  } finally {
    removeDir(root);
  }
});

test('default secret encryption generates a local key file and never stores plaintext api keys', async () => {
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

    await storage.ensureDir(layout.paths.rootDir);
    await storage.ensureDir(layout.paths.secretsDir);
    await secrets.save({
      id: 'default_encrypted_secret',
      provider: 'openai',
      label: 'OpenAI Default',
      apiKey: 'sk-live-default',
      createdAt: 10,
      updatedAt: 11,
      metadata: {}
    });

    const secret = await secrets.get('default_encrypted_secret');
    const secretText = fs.readFileSync(layout.secretRecordPath('default_encrypted_secret'), 'utf8');
    const generatedKeyPath = path.join(config.paths.secretsDir, '.backend-new-secret.key');

    assert.equal(config.security.secretEncryption, 'aes-256-gcm');
    assert.equal(secret.apiKey, 'sk-live-default');
    assert.equal(fs.existsSync(generatedKeyPath), true);
    assert.doesNotMatch(secretText, /sk-live-default/);
    assert.match(secretText, /cipherText/);
  } finally {
    removeDir(root);
  }
});

test('extension loaders accept BOM JSON and skill placeholders', async () => {
  const root = createTempRoot();
  try {
    const env = {
      BACKEND_NEW_ROOT_DIR: 'data',
      BACKEND_NEW_SKILL_ROOTS: 'skills/demo-skill'
    };
    const config = loadBackendNewConfig({}, { cwd: root, env });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const registry = new ExtensionRegistry();

    await storage.ensureDir(path.dirname(config.mcp.registryFile));
    await storage.ensureDir(path.dirname(config.tools.manifestFile));
    await storage.ensureDir(config.skills.roots[0]);

    fs.writeFileSync(
      config.mcp.registryFile,
      '\uFEFF{"servers":[{"id":"mcp-demo","name":"Demo MCP","transport":"stdio","command":"demo.exe"}]}'
    );
    fs.writeFileSync(
      config.tools.manifestFile,
      '\uFEFF{"tools":[{"id":"tool-demo","name":"tool_demo","description":"demo tool","source":"manifest","effect":"READ","riskLevel":"LOW","inputSchema":[{"name":"query","type":"string","required":true}]}]}'
    );
    fs.writeFileSync(path.join(config.skills.roots[0], '.keep'), '');

    await loadExtensionManifests(config, storage, registry);
    await loadSkillPlaceholders(config, storage, registry);

    const snapshot = registry.snapshot();
    assert.equal(snapshot.mcpServers[0].id, 'mcp-demo');
    assert.equal(snapshot.tools[0].id, 'tool-demo');
    assert.equal(snapshot.skills[0].name, 'demo-skill');
  } finally {
    removeDir(root);
  }
});
