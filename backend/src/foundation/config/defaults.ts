import { BackendNewConfig } from './types';

export const DEFAULT_BACKEND_NEW_CONFIG: BackendNewConfig = {
  paths: {
    rootDir: 'data',
    tasksDir: 'tasks',
    tracesDir: 'traces',
    workspaceDir: 'workspace',
    checkpointsDir: 'checkpoints',
    logsDir: 'logs',
    secretsDir: 'secrets',
    sessionsDir: 'sessions',
    projectionsDir: 'projections',
    eventsDir: 'events',
    outputsDir: 'validated-outputs',
    toolInvocationsDir: 'tool-invocations',
    approvalsDir: 'approvals',
    conversationsDir: 'conversations',
    configSnapshotsDir: 'config-snapshots'
  },
  logging: {
    longTextLimit: 50_000,
    shortTextLimit: 12_000,
    maxObjectEntries: 100,
    auditFileName: 'audit.jsonl',
    retentionDays: 14,
    cleanupOnInitialize: false
  },
  storage: {
    encoding: 'utf8',
    jsonSpacing: 2,
    driver: 'file'
  },
  database: {
    connectionString: null,
    schema: 'public',
    autoMigrate: false,
    statementTimeoutMs: 15_000,
    queryTimeoutMs: 15_000
  },
  queue: {
    enabled: false,
    leaseMs: 30_000,
    retryDelayMs: 5_000,
    maxRetries: 3
  },
  server: {
    host: '127.0.0.1',
    port: 3011,
    websocketPath: '/ws',
    enableSseFallback: true
  },
  worker: {
    enabled: false,
    pollIntervalMs: 1_000,
    concurrency: 1,
    heartbeatMs: 5_000
  },
  security: {
    secretEncryption: 'aes-256-gcm',
    secretKeyEnvVar: 'BACKEND_NEW_SECRET_KEY'
  },
  skills: {
    enabled: true,
    roots: ['skills']
  },
  mcp: {
    enabled: true,
    registryFile: 'mcp/servers.json'
  },
  tools: {
    allowOverrides: false,
    manifestFile: 'tools/manifest.json',
    permissionMode: 'ask'
  },
  providers: {
    manifestFile: 'providers/manifest.json',
    allowLocalModels: true,
    defaultProviderId: null,
    preferLocalModels: false,
    requestTimeoutMs: 30_000,
    maxRetries: 2,
    retryBackoffMs: 750
  },
  runtime: {
    maxContextMessages: 12,
    retainedContextMessages: 4,
    promptSectionCharacterLimit: 1_800,
    promptMaxSummaryItems: 6,
    delegation: {
      enabled: false,
      maxDepth: 1,
      maxActiveChildrenPerTask: 1
    }
  }
};
