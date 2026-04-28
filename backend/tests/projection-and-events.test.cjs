const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTaskProjection,
  createRuntimeEventEnvelope,
  FileRuntimeEventRepository,
  FileStorageAdapter,
  FileTaskProjectionRepository,
  StorageLayout,
  loadBackendNewConfig
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('projection repository persists stable task view', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const projections = new FileTaskProjectionRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.projectionsDir);

    const projection = buildTaskProjection({
      taskId: 'task_projection',
      status: 'RUNNING',
      currentUnitId: 'AGENT-002',
      latestSessionId: 'sess_demo',
      latestCorrelationId: 'corr_demo',
      latestTurnId: 'turn_demo',
      latestCheckpointId: 'chk_turn_demo_42',
      explicitOutputCount: 1,
      trackerCount: 1,
      toolCallCount: 0,
      pendingCorrection: 'NONE',
      metadata: { phase: 'projection' },
      updatedAt: 10
    });

    await projections.save(projection);
    const stored = await projections.get('task_projection');

    assert.equal(stored.latestSessionId, 'sess_demo');
    assert.equal(stored.latestTurnId, 'turn_demo');
    assert.equal(stored.summary.pendingCorrection, 'NONE');
    assert.equal(stored.metadata.phase, 'projection');
  } finally {
    removeDir(root);
  }
});

test('event repository appends runtime envelopes for realtime delivery contract', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const events = new FileRuntimeEventRepository(config, storage, layout);

    await storage.ensureDir(layout.paths.eventsDir);

    const event = createRuntimeEventEnvelope({
      correlationId: 'corr_demo',
      sessionId: 'sess_demo',
      turnId: 'turn_demo',
      taskId: 'task_events',
      unitId: 'AGENT-001',
      checkpointId: 'chk_turn_demo_42',
      type: 'TURN_ANALYZED',
      payload: {
        step: 'parse'
      },
      timestamp: 42
    });

    await events.append(event);
    const stored = await events.list('task_events');

    assert.equal(stored.length, 1);
    assert.equal(stored[0].correlationId, 'corr_demo');
    assert.equal(stored[0].turnId, 'turn_demo');
    assert.equal(stored[0].checkpointId, 'chk_turn_demo_42');
    assert.equal(stored[0].type, 'TURN_ANALYZED');
    assert.match(stored[0].eventId, /^evt_/);
  } finally {
    removeDir(root);
  }
});
