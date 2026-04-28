const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBackendNewFoundation,
  FileStorageAdapter
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('createBackendNewFoundation composes the base dependencies once', () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });

    assert.ok(foundation.storage instanceof FileStorageAdapter);
    assert.equal(foundation.layout.paths.rootDir, root);
    assert.ok(foundation.logs);
    assert.ok(foundation.tasks);
    assert.ok(foundation.checkpoints);
    assert.ok(foundation.apiKeys);
    assert.ok(foundation.taskMetadata);
    assert.ok(foundation.sessions);
    assert.ok(foundation.projections);
    assert.ok(foundation.events);
    assert.ok(foundation.validatedOutputs);
    assert.ok(foundation.toolInvocations);
    assert.ok(foundation.approvals);
    assert.ok(foundation.conversations);
    assert.ok(foundation.configSnapshots);
    assert.ok(foundation.extensions);
    assert.ok(foundation.providers);
    assert.ok(foundation.providerClients);
    assert.ok(foundation.skillRuntimes);
    assert.ok(foundation.mcpClients);
    assert.ok(foundation.toolExecutors);
  } finally {
    removeDir(root);
  }
});
