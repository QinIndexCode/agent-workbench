const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExecutionCorrelation,
  FileExecutionSessionRepository,
  FileStorageAdapter,
  FileTaskMetadataRepository,
  StorageLayout,
  loadBackendNewConfig
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('correlation ids are generated and persisted through session and metadata repositories', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const metadata = new FileTaskMetadataRepository(config, storage, layout);
    const sessions = new FileExecutionSessionRepository(config, storage, layout);
    const correlation = createExecutionCorrelation('task_meta', 'AGENT-001');

    await storage.ensureDir(layout.paths.rootDir);
    await storage.ensureDir(layout.paths.tasksDir);
    await storage.ensureDir(layout.paths.sessionsDir);

    await metadata.save({
      taskId: 'task_meta',
      createdAt: 1,
      updatedAt: 2,
      latestSessionId: correlation.sessionId,
      selectedProviderId: 'deepseek-main',
      labels: ['analysis'],
      metadata: { source: 'test', latestTurnId: correlation.turnId }
    });

    await sessions.save({
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      taskId: 'task_meta',
      unitId: 'AGENT-001',
      providerId: 'deepseek-main',
      status: 'COMPLETED',
      createdAt: 3,
      updatedAt: 4,
      endedAt: 5,
      metadata: { phase: 'parse' }
    });

    const storedMetadata = await metadata.get('task_meta');
    const storedSession = await sessions.get(correlation.sessionId);

    assert.match(correlation.sessionId, /^sess_/);
    assert.match(correlation.correlationId, /^corr_/);
    assert.match(correlation.turnId, /^turn_/);
    assert.equal(storedMetadata.latestSessionId, correlation.sessionId);
    assert.equal(storedMetadata.metadata.latestTurnId, correlation.turnId);
    assert.equal(storedSession.correlationId, correlation.correlationId);
    assert.equal(storedSession.providerId, 'deepseek-main');
    assert.equal(layout.userProfilePath.endsWith('user-preferences.json'), true);
  } finally {
    removeDir(root);
  }
});
