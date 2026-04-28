export interface BackendNewPathConfig {
  rootDir: string;
  tasksDir: string;
  tracesDir: string;
  workspaceDir: string;
  checkpointsDir: string;
  logsDir: string;
  secretsDir: string;
  sessionsDir: string;
  projectionsDir: string;
  eventsDir: string;
  outputsDir: string;
  toolInvocationsDir: string;
  approvalsDir: string;
  conversationsDir: string;
  configSnapshotsDir: string;
}

export interface BackendNewLoggingConfig {
  longTextLimit: number;
  shortTextLimit: number;
  maxObjectEntries: number;
  auditFileName: string;
  retentionDays: number;
  cleanupOnInitialize: boolean;
}

export interface BackendNewStorageConfig {
  encoding: BufferEncoding;
  jsonSpacing: number;
  driver: 'file' | 'postgres';
}

export interface BackendNewDatabaseConfig {
  connectionString: string | null;
  schema: string;
  autoMigrate: boolean;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
}

export interface BackendNewQueueConfig {
  enabled: boolean;
  leaseMs: number;
  retryDelayMs: number;
  maxRetries: number;
}

export interface BackendNewServerConfig {
  host: string;
  port: number;
  websocketPath: string;
  enableSseFallback: boolean;
}

export interface BackendNewWorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  concurrency: number;
  heartbeatMs: number;
}

export interface BackendNewSecurityConfig {
  secretEncryption: 'none' | 'aes-256-gcm';
  secretKeyEnvVar: string;
}

export interface BackendNewSkillConfig {
  enabled: boolean;
  roots: string[];
}

export interface BackendNewMcpConfig {
  enabled: boolean;
  registryFile: string;
}

export interface BackendNewToolConfig {
  allowOverrides: boolean;
  manifestFile: string;
  permissionMode: 'full' | 'ask' | 'read-only';
}

export interface BackendNewProviderConfig {
  manifestFile: string;
  allowLocalModels: boolean;
  defaultProviderId: string | null;
  preferLocalModels: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface BackendNewRuntimeConfig {
  maxContextMessages: number;
  retainedContextMessages: number;
  promptSectionCharacterLimit: number;
  promptMaxSummaryItems: number;
  delegation: BackendNewRuntimeDelegationConfig;
}

export interface BackendNewRuntimeDelegationConfig {
  enabled: boolean;
  maxDepth: number;
  maxActiveChildrenPerTask: number;
}

export interface BackendNewConfig {
  paths: BackendNewPathConfig;
  logging: BackendNewLoggingConfig;
  storage: BackendNewStorageConfig;
  database: BackendNewDatabaseConfig;
  queue: BackendNewQueueConfig;
  server: BackendNewServerConfig;
  worker: BackendNewWorkerConfig;
  security: BackendNewSecurityConfig;
  skills: BackendNewSkillConfig;
  mcp: BackendNewMcpConfig;
  tools: BackendNewToolConfig;
  providers: BackendNewProviderConfig;
  runtime: BackendNewRuntimeConfig;
}

export interface BackendNewConfigInput {
  paths?: Partial<BackendNewPathConfig>;
  logging?: Partial<BackendNewLoggingConfig>;
  storage?: Partial<BackendNewStorageConfig>;
  database?: Partial<BackendNewDatabaseConfig>;
  queue?: Partial<BackendNewQueueConfig>;
  server?: Partial<BackendNewServerConfig>;
  worker?: Partial<BackendNewWorkerConfig>;
  security?: Partial<BackendNewSecurityConfig>;
  skills?: Partial<BackendNewSkillConfig>;
  mcp?: Partial<BackendNewMcpConfig>;
  tools?: Partial<BackendNewToolConfig>;
  providers?: Partial<BackendNewProviderConfig>;
  runtime?: Omit<Partial<BackendNewRuntimeConfig>, 'delegation'> & {
    delegation?: Partial<BackendNewRuntimeDelegationConfig>;
  };
}
