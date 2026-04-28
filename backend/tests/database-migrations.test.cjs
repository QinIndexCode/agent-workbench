const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBackendNewMigrationPlan,
  buildBackendNewSchemaSql,
  loadBackendNewConfig,
  runBackendNewMigrations
} = require('../dist');

class FakeDatabaseAdapter {
  constructor() {
    this.applied = [];
    this.version = null;
    this.executed = [];
  }

  async query(sql, values = []) {
    this.executed.push({ sql, values });
    if (/SELECT version, description, executed_at FROM .*schema_migrations/i.test(sql)) {
      return {
        rows: this.applied.map(record => ({
          version: record.version,
          description: record.description,
          executed_at: record.executedAt
        })),
        rowCount: this.applied.length
      };
    }
    if (/INSERT INTO .*schema_migrations/i.test(sql)) {
      this.applied.push({
        version: values[0],
        description: values[1],
        executedAt: values[2]
      });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO .*schema_version/i.test(sql)) {
      this.version = {
        schemaName: values[0],
        version: values[1],
        updatedAt: values[2]
      };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async close() {}
  async ensureInitialized() {}
  async ping() { return true; }
}

test('schema builder includes migration bootstrap tables', () => {
  const statements = buildBackendNewSchemaSql('scc_new');
  assert.equal(statements.some(sql => /schema_version/i.test(sql)), true);
  assert.equal(statements.some(sql => /schema_migrations/i.test(sql)), true);
  assert.equal(buildBackendNewMigrationPlan('scc_new').length >= 3, true);
});

test('runBackendNewMigrations applies pending migrations once and updates schema version', async () => {
  const config = loadBackendNewConfig({
    database: {
      schema: 'migration_test'
    }
  }, {
    cwd: process.cwd(),
    env: {}
  });
  const database = new FakeDatabaseAdapter();

  const firstRun = await runBackendNewMigrations(config, database);
  const secondRun = await runBackendNewMigrations(config, database);

  assert.equal(firstRun, buildBackendNewMigrationPlan('migration_test').length);
  assert.equal(secondRun, 0);
  assert.equal(database.applied.length, buildBackendNewMigrationPlan('migration_test').length);
  assert.equal(database.version.schemaName, 'migration_test');
  assert.equal(database.version.version, buildBackendNewMigrationPlan('migration_test').at(-1).version);
});
