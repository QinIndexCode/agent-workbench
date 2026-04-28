import { Pool } from 'pg';
import { BackendNewConfig } from '../config/types';
import { runBackendNewMigrations } from './migrate';
import { DatabaseAdapter, DatabaseQueryResult } from './types';

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  private readonly pool: Pool;
  private initializePromise: Promise<void> | null = null;

  constructor(private readonly config: BackendNewConfig) {
    if (!config.database.connectionString) {
      throw new Error('backend_new database error: connectionString is required.');
    }
    this.pool = new Pool({
      connectionString: config.database.connectionString,
      statement_timeout: config.database.statementTimeoutMs,
      query_timeout: config.database.queryTimeoutMs
    });
  }

  async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initialize();
    }
    await this.initializePromise;
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<DatabaseQueryResult<T>> {
    await this.ensureInitialized();
    const result = await this.pool.query(sql, values);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  private async initialize(): Promise<void> {
    if (!this.config.database.autoMigrate) {
      return;
    }
    await runBackendNewMigrations(this.config, {
      query: async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
        const result = await this.pool.query(sql, values);
        return {
          rows: result.rows as T[],
          rowCount: result.rowCount ?? 0
        };
      },
      close: async () => undefined,
      ensureInitialized: async () => undefined,
      ping: async () => true
    });
  }
}
