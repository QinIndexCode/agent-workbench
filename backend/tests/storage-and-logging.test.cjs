const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const {
  FileStorageAdapter,
  StorageLayout,
  TaskLogWriter,
  loadBackendNewConfig
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

test('StorageLayout blocks workspace path escape and unsafe ids', () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const layout = new StorageLayout(config);

    assert.throws(
      () => layout.resolveWorkspacePath('task_safe', '..\\escape.txt'),
      /escapes task workspace/
    );
    assert.throws(
      () => layout.forTask('../bad'),
      /unsafe characters/
    );
    assert.throws(
      () => layout.secretRecordPath('..'),
      /(unsafe characters|not allowed)/
    );
  } finally {
    removeDir(root);
  }
});

test('FileStorageAdapter replaces files safely while a reader stream is open', async () => {
  const root = createTempRoot();
  try {
    const storage = new FileStorageAdapter();
    const filePath = `${root}\\runtime.json`;

    await storage.writeJson(filePath, { revision: 1 });
    const reader = fs.createReadStream(filePath, { encoding: 'utf8' });
    await once(reader, 'open');

    await storage.writeJson(filePath, { revision: 2 });

    reader.resume();
    await once(reader, 'close').catch(() => undefined);
    reader.destroy();

    const payload = await storage.readJson(filePath);
    assert.deepEqual(payload, { revision: 2 });
  } finally {
    removeDir(root);
  }
});

test('TaskLogWriter writes wrapped trace, checkpoint, and audit records', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig(
      {
        logging: {
          longTextLimit: 200,
          shortTextLimit: 50
        }
      },
      { cwd: root, env: {} }
    );
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const logs = new TaskLogWriter(config, storage, layout);

    await logs.recordTrace({
      timestamp: 1,
      taskId: 'task_log',
      unitId: 'AGENT-001',
      correlationId: 'corr_task_log',
      turnId: 'turn_task_log',
      action: 'response_received',
      details: {
        response: 'x'.repeat(20_000)
      }
    });

    await logs.writeCheckpoint({
      timestamp: 2,
      checkpointId: 'chk_turn_task_log_2',
      correlationId: 'corr_task_log',
      turnId: 'turn_task_log',
      taskId: 'task_log',
      unitId: 'AGENT-001',
      state: {
        pendingCorrection: 'NONE'
      }
    });

    await logs.recordAudit({
      timestamp: 3,
      severity: 'INFO',
      event: 'task_checked',
      taskId: 'task_log',
      unitId: 'AGENT-001',
      correlationId: 'corr_task_log',
      turnId: 'turn_task_log',
      checkpointId: 'chk_turn_task_log_2',
      details: {
        note: 'ok'
      }
    });

    const traceText = fs.readFileSync(layout.forTask('task_log').traceLogPath, 'utf8').trim();
    const checkpointText = fs.readFileSync(layout.forTask('task_log').checkpointPath, 'utf8');
    const auditText = fs.readFileSync(layout.auditLogPath, 'utf8').trim();

    const trace = JSON.parse(traceText);
    const checkpoint = JSON.parse(checkpointText);
    const audit = JSON.parse(auditText);

    assert.equal(typeof trace.writerSessionId, 'string');
    assert.equal(trace.sequence, 1);
    assert.equal(trace.payload.turnId, 'turn_task_log');
    assert.match(trace.payload.details.response, /\[truncated\]$/);
    assert.equal(checkpoint.sequence, 2);
    assert.equal(checkpoint.payload.checkpointId, 'chk_turn_task_log_2');
    assert.equal(audit.sequence, 3);
    assert.equal(audit.payload.turnId, 'turn_task_log');
  } finally {
    removeDir(root);
  }
});

test('TaskLogWriter prunes expired log-like files without touching state stores', async () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig(
      {
        paths: {
          rootDir: root
        },
        logging: {
          retentionDays: 1
        }
      },
      { cwd: root, env: {} }
    );
    const storage = new FileStorageAdapter();
    const layout = new StorageLayout(config);
    const logs = new TaskLogWriter(config, storage, layout);
    const taskLayout = layout.forTask('task_retention');

    await logs.initialize();

    fs.writeFileSync(layout.auditLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.traceLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.eventLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.toolInvocationLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.approvalLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.conversationLogPath, '{"old":true}\n');
    fs.writeFileSync(taskLayout.checkpointPath, '{"state":true}\n');

    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(layout.auditLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.traceLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.eventLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.toolInvocationLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.approvalLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.conversationLogPath, oldTime, oldTime);
    fs.utimesSync(taskLayout.checkpointPath, oldTime, oldTime);

    const deleted = await logs.pruneExpiredLogs({ now: Date.now() });

    assert.equal(fs.existsSync(layout.auditLogPath), false);
    assert.equal(fs.existsSync(taskLayout.traceLogPath), false);
    assert.equal(fs.existsSync(taskLayout.eventLogPath), false);
    assert.equal(fs.existsSync(taskLayout.toolInvocationLogPath), false);
    assert.equal(fs.existsSync(taskLayout.approvalLogPath), false);
    assert.equal(fs.existsSync(taskLayout.conversationLogPath), false);
    assert.equal(fs.existsSync(taskLayout.checkpointPath), true);
    assert.equal(deleted.length, 6);
  } finally {
    removeDir(root);
  }
});
