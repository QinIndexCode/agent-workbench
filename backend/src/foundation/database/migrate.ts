import { BackendNewConfig } from '../config/types';
import {
  buildBackendNewMigrationBootstrapSql,
  buildBackendNewMigrationPlan
} from './schema';
import { DatabaseAdapter, DatabaseMigrationRecord } from './types';

interface MigrationRow {
  version: string;
  description: string;
  executed_at: number;
}

export async function runBackendNewMigrations(
  config: BackendNewConfig,
  database: DatabaseAdapter
): Promise<number> {
  for (const statement of buildBackendNewMigrationBootstrapSql(config.database.schema)) {
    await database.query(statement);
  }

  const historyTable = `"${config.database.schema}"."schema_migrations"`;
  const versionTable = `"${config.database.schema}"."schema_version"`;
  const applied = await listAppliedMigrations(database, historyTable);
  const plan = buildBackendNewMigrationPlan(config.database.schema);
  let appliedCount = 0;
  let latestVersion = applied.at(-1)?.version ?? 'bootstrap';

  for (const entry of plan) {
    if (applied.some(record => record.version === entry.version)) {
      latestVersion = entry.version;
      continue;
    }
    for (const statement of entry.statements) {
      await database.query(statement);
    }
    const executedAt = Date.now();
    await database.query(
      `INSERT INTO ${historyTable} (version, description, executed_at) VALUES ($1, $2, $3)
       ON CONFLICT (version) DO NOTHING`,
      [entry.version, entry.description, executedAt]
    );
    latestVersion = entry.version;
    appliedCount += 1;
  }

  await database.query(
    `INSERT INTO ${versionTable} (schema_name, version, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (schema_name) DO UPDATE SET version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
    [config.database.schema, latestVersion, Date.now()]
  );

  return appliedCount;
}

export async function listAppliedMigrations(
  database: DatabaseAdapter,
  historyTable: string
): Promise<DatabaseMigrationRecord[]> {
  const result = await database.query<MigrationRow>(
    `SELECT version, description, executed_at FROM ${historyTable} ORDER BY executed_at ASC, version ASC`
  );
  return result.rows.map(row => ({
    version: row.version,
    description: row.description,
    executedAt: Number(row.executed_at)
  }));
}
