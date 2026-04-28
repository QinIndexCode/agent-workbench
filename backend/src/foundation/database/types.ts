export interface DatabaseQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseMigrationRecord {
  version: string;
  description: string;
  executedAt: number;
}

export interface DatabaseMigrationPlanEntry {
  version: string;
  description: string;
  statements: string[];
}

export interface DatabaseAdapter {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<DatabaseQueryResult<T>>;
  close(): Promise<void>;
  ensureInitialized(): Promise<void>;
  ping(): Promise<boolean>;
}
