const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createBackendNewFoundation,
  createBackendNewRuntime,
  PostgresConfigSnapshotRepository,
  PostgresPlatformAuditRepository,
  PostgresPlatformCommandRepository,
  PostgresDatabaseAdapter,
  PostgresQueueRepository,
  PostgresRuntimeEventRepository,
  PostgresTaskRepository,
  createConfigSnapshotRecord,
  createRuntimeEventEnvelope,
  loadBackendNewConfig,
  runBackendNewMigrations
} = require('../dist');

const connectionString = process.env.BACKEND_NEW_PG_TEST_URL || process.env.BACKEND_NEW_DATABASE_URL || null;
const shouldRun = Boolean(connectionString);

function createIntegrationConfig(schema) {
  return loadBackendNewConfig({
    storage: {
      driver: 'postgres'
    },
    database: {
      connectionString,
      schema,
      autoMigrate: false
    },
    queue: {
      enabled: true
    }
  }, {
    cwd: process.cwd(),
    env: {}
  });
}

test('postgres integration: migrations, task repository CRUD, and queue semantics', { skip: !shouldRun }, async () => {
  const schema = `bn_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const config = createIntegrationConfig(schema);
  const database = new PostgresDatabaseAdapter(config);
  await database.ensureInitialized();
  try {
    await runBackendNewMigrations(config, database);

    const tasks = new PostgresTaskRepository(config, database);
    await tasks.save({
      taskId: 'task_pg_1',
      status: 'SUBMITTED',
      currentUnitId: 'AGENT-001',
      updatedAt: Date.now(),
      payload: {
        hello: 'world'
      }
    });
    const savedTask = await tasks.get('task_pg_1');
    assert.equal(savedTask.taskId, 'task_pg_1');
    assert.equal(savedTask.payload.hello, 'world');

    const queue = new PostgresQueueRepository(config, database);
    const now = Date.now();
    await queue.enqueue({
      taskId: 'task_pg_1',
      state: 'QUEUED',
      runAfter: now,
      priority: 10,
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      maxRetries: 2,
      lastError: null,
      createdAt: now,
      updatedAt: now
    });

    const claim = await queue.claimNext({
      workerId: 'worker_pg',
      now,
      leaseMs: 1_000
    });
    assert.equal(claim.taskId, 'task_pg_1');
    assert.equal(await queue.markRunning({
      taskId: claim.taskId,
      workerId: claim.workerId,
      claimToken: claim.claimToken,
      now: now + 10
    }), true);
    assert.equal(await queue.heartbeat({
      taskId: claim.taskId,
      workerId: claim.workerId,
      claimToken: claim.claimToken,
      leaseMs: 1_000,
      now: now + 20
    }), true);
    const failed = await queue.fail({
      taskId: claim.taskId,
      workerId: claim.workerId,
      claimToken: claim.claimToken,
      now: now + 30,
      retryDelayMs: 100,
      maxRetries: 2,
      error: 'retry me'
    });
    assert.equal(failed.state, 'RETRY_WAITING');
    const recovered = await queue.releaseExpired(now + 2_000);
    assert.equal(typeof recovered, 'number');
  } finally {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
});

test('postgres integration: config snapshots and platform audit trail remain authoritative and replayable', { skip: !shouldRun }, async () => {
  const schema = `bn_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const config = createIntegrationConfig(schema);
  const database = new PostgresDatabaseAdapter(config);
  await database.ensureInitialized();
  try {
    await runBackendNewMigrations(config, database);

    const snapshots = new PostgresConfigSnapshotRepository(config, database);
    const platformCommands = new PostgresPlatformCommandRepository(config, database);
    const platformAudits = new PostgresPlatformAuditRepository(config, database);

    const firstConfig = loadBackendNewConfig({
      storage: { driver: 'postgres' },
      database: {
        connectionString,
        schema,
        autoMigrate: false
      },
      queue: { enabled: true },
      logging: { retentionDays: 7 }
    }, {
      cwd: process.cwd(),
      env: {}
    });
    const secondConfig = loadBackendNewConfig({
      storage: { driver: 'postgres' },
      database: {
        connectionString,
        schema,
        autoMigrate: false
      },
      queue: { enabled: true },
      logging: { retentionDays: 30 }
    }, {
      cwd: process.cwd(),
      env: {}
    });

    const firstSnapshot = createConfigSnapshotRecord(firstConfig, Date.now());
    const secondSnapshot = createConfigSnapshotRecord(secondConfig, Date.now() + 1);
    await snapshots.save(firstSnapshot);
    await snapshots.save(secondSnapshot);

    const active = await snapshots.getActive();
    const activeRows = await database.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."config_snapshots" WHERE is_active = TRUE`);
    assert.equal(active.version, secondSnapshot.version);
    assert.equal(active.fingerprint, secondSnapshot.fingerprint);
    assert.equal(active.config.logging.retentionDays, 30);
    assert.equal(Number(activeRows.rows[0].count), 1);

    const resourceType = 'CHANNEL';
    const resourceId = 'channel_pg_audit';
    const createdAt = Date.now();

    await platformCommands.append({
      commandId: 'pcmd_pg_1',
      resourceType,
      resourceId,
      action: 'UPSERT',
      createdAt,
      actor: 'tester',
      reason: 'create channel',
      input: {
        name: 'Ops channel',
        kind: 'webhook'
      },
      metadata: {
        source: 'postgres-integration-test'
      }
    });
    await platformAudits.append({
      auditId: 'paudit_pg_1',
      commandId: 'pcmd_pg_1',
      resourceType,
      resourceId,
      action: 'UPSERT',
      status: 'APPLIED',
      createdAt: createdAt + 1,
      error: null,
      result: {
        channelId: resourceId,
        status: 'ACTIVE'
      },
      metadata: {
        source: 'postgres-integration-test'
      }
    });
    await platformCommands.append({
      commandId: 'pcmd_pg_2',
      resourceType,
      resourceId,
      action: 'DELETE',
      createdAt: createdAt + 2,
      actor: 'tester',
      reason: 'delete channel',
      input: {
        channelId: resourceId
      },
      metadata: {
        source: 'postgres-integration-test'
      }
    });
    await platformAudits.append({
      auditId: 'paudit_pg_2',
      commandId: 'pcmd_pg_2',
      resourceType,
      resourceId,
      action: 'DELETE',
      status: 'APPLIED',
      createdAt: createdAt + 3,
      error: null,
      result: {
        ok: true,
        channelId: resourceId
      },
      metadata: {
        source: 'postgres-integration-test'
      }
    });
    await platformCommands.append({
      commandId: 'pcmd_pg_other',
      resourceType: 'MEMORY',
      resourceId: 'memory_pg_other',
      action: 'UPSERT',
      createdAt: createdAt + 4,
      actor: 'tester',
      reason: null,
      input: {
        title: 'other'
      },
      metadata: {}
    });

    const commands = await platformCommands.listByResource(resourceType, resourceId);
    const audits = await platformAudits.listByResource(resourceType, resourceId);

    assert.deepEqual(commands.map((record) => record.commandId), ['pcmd_pg_1', 'pcmd_pg_2']);
    assert.deepEqual(audits.map((record) => record.auditId), ['paudit_pg_1', 'paudit_pg_2']);
    assert.equal(commands[0].input.name, 'Ops channel');
    assert.equal(audits[1].result.channelId, resourceId);
    assert.equal(audits.every((record) => record.resourceType === resourceType), true);
  } finally {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
});

test('postgres integration: runtime event listAfter keeps database-side ordering semantics', { skip: !shouldRun }, async () => {
  const schema = `bn_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const config = createIntegrationConfig(schema);
  const database = new PostgresDatabaseAdapter(config);
  await database.ensureInitialized();
  try {
    await runBackendNewMigrations(config, database);

    const events = new PostgresRuntimeEventRepository(config, database);
    const taskId = 'task_pg_events';
    const eventA = createRuntimeEventEnvelope({
      correlationId: 'corr_pg_1',
      sessionId: 'sess_pg_1',
      turnId: 'turn_pg_1',
      taskId,
      unitId: null,
      checkpointId: null,
      type: 'TASK_SUBMITTED',
      payload: { step: 1 }
    });
    const eventB = createRuntimeEventEnvelope({
      correlationId: 'corr_pg_2',
      sessionId: 'sess_pg_2',
      turnId: 'turn_pg_2',
      taskId,
      unitId: 'AGENT-001',
      checkpointId: null,
      type: 'TASK_STARTED',
      payload: { step: 2 }
    });
    const eventC = createRuntimeEventEnvelope({
      correlationId: 'corr_pg_3',
      sessionId: 'sess_pg_3',
      turnId: 'turn_pg_3',
      taskId,
      unitId: 'AGENT-001',
      checkpointId: null,
      type: 'TASK_COMPLETED',
      payload: { step: 3 }
    });

    await events.append({ ...eventA, timestamp: 1000 });
    await events.append({ ...eventB, timestamp: 1000 });
    await events.append({ ...eventC, timestamp: 1001 });

    const ordered = await events.list(taskId);
    const afterFirst = await events.listAfter(taskId, eventA.eventId);
    const afterMissing = await events.listAfter(taskId, 'missing_event_id');

    assert.equal(ordered.length, 3);
    assert.deepEqual(afterFirst.map((record) => record.eventId), [eventB.eventId, eventC.eventId]);
    assert.equal(afterMissing.length, 3);
  } finally {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
});

test('postgres integration: task detail query normalizes runtime diagnostics with production parity', { skip: !shouldRun }, async () => {
  const schema = `bn_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const config = createIntegrationConfig(schema);
  const foundation = createBackendNewFoundation({ resolvedConfig: config });
  await foundation.database.ensureInitialized();
  const runtime = createBackendNewRuntime({ foundation });
  try {
    await runBackendNewMigrations(config, foundation.database);

    const submitted = await runtime.tasks.submitTask({
      title: 'Postgres parity task',
      intent: 'Verify runtime diagnostics query parity.',
      units: [
        {
          id: 'AGENT-001',
          role: 'Closer',
          goal: 'Close the task',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    });

    const record = await foundation.taskRuntimes.get(submitted.command.taskId);
    await foundation.taskRuntimes.save({
      ...record,
      runtime: {
        ...record.runtime,
        planner: undefined,
        activeStage: null,
        pendingToolBatches: undefined,
        consolidationState: undefined,
        compressionPolicy: undefined,
        compressionDowngraded: undefined,
        batchAdmissionDecisions: undefined,
        unsafeBatchRejectedCount: undefined,
        guardrails: undefined,
        plannerFallbackRate: undefined,
        promptSectionAttribution: undefined,
        stageMemorySummary: undefined,
        capabilitySelectionSummary: undefined,
        retrievalSelectionSummary: undefined
      }
    });

    const detail = await runtime.tasks.getTask(submitted.command.taskId);

    assert.equal(detail.definition.taskId, submitted.command.taskId);
    assert.equal(Array.isArray(detail.runtime.pendingToolBatches), true);
    assert.equal(detail.runtime.consolidationState.status, 'IDLE');
    assert.equal(typeof detail.runtime.planner.stageCount, 'number');
    assert.equal(typeof detail.runtime.promptSectionAttribution.taskMemoryChars, 'number');
    assert.equal(detail.runtime.contractDiagnostics.currentUnit.unitId, 'AGENT-001');
  } finally {
    await foundation.database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runtime.close();
  }
});
