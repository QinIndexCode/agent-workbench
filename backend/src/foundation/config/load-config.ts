import path from 'node:path';
import { DEFAULT_BACKEND_NEW_CONFIG } from './defaults';
import { BackendNewConfig, BackendNewConfigInput } from './types';
import { validateBackendNewConfig } from './validate-config';

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }

  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }

  return fallback;
}

function readStringList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const items = value
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizeDir(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export function loadBackendNewConfig(
  input: BackendNewConfigInput = {},
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): BackendNewConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const rootDir = path.resolve(
    cwd,
    input.paths?.rootDir
      ?? env.BACKEND_NEW_ROOT_DIR
      ?? DEFAULT_BACKEND_NEW_CONFIG.paths.rootDir
  );

  return validateBackendNewConfig({
    paths: {
      rootDir,
      tasksDir: normalizeDir(
        rootDir,
        input.paths?.tasksDir
          ?? env.BACKEND_NEW_TASKS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.tasksDir
      ),
      tracesDir: normalizeDir(
        rootDir,
        input.paths?.tracesDir
          ?? env.BACKEND_NEW_TRACES_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.tracesDir
      ),
      workspaceDir: normalizeDir(
        rootDir,
        input.paths?.workspaceDir
          ?? env.BACKEND_NEW_WORKSPACE_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.workspaceDir
      ),
      checkpointsDir: normalizeDir(
        rootDir,
        input.paths?.checkpointsDir
          ?? env.BACKEND_NEW_CHECKPOINTS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.checkpointsDir
      ),
      logsDir: normalizeDir(
        rootDir,
        input.paths?.logsDir
          ?? env.BACKEND_NEW_LOGS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.logsDir
      ),
      secretsDir: normalizeDir(
        rootDir,
        input.paths?.secretsDir
          ?? env.BACKEND_NEW_SECRETS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.secretsDir
      ),
      sessionsDir: normalizeDir(
        rootDir,
        input.paths?.sessionsDir
          ?? env.BACKEND_NEW_SESSIONS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.sessionsDir
      ),
      projectionsDir: normalizeDir(
        rootDir,
        input.paths?.projectionsDir
          ?? env.BACKEND_NEW_PROJECTIONS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.projectionsDir
      ),
      eventsDir: normalizeDir(
        rootDir,
        input.paths?.eventsDir
          ?? env.BACKEND_NEW_EVENTS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.eventsDir
      ),
      outputsDir: normalizeDir(
        rootDir,
        input.paths?.outputsDir
          ?? env.BACKEND_NEW_OUTPUTS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.outputsDir
      ),
      toolInvocationsDir: normalizeDir(
        rootDir,
        input.paths?.toolInvocationsDir
          ?? env.BACKEND_NEW_TOOL_INVOCATIONS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.toolInvocationsDir
      ),
      approvalsDir: normalizeDir(
        rootDir,
        input.paths?.approvalsDir
          ?? env.BACKEND_NEW_APPROVALS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.approvalsDir
      ),
      conversationsDir: normalizeDir(
        rootDir,
        input.paths?.conversationsDir
          ?? env.BACKEND_NEW_CONVERSATIONS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.conversationsDir
      ),
      configSnapshotsDir: normalizeDir(
        rootDir,
        input.paths?.configSnapshotsDir
          ?? env.BACKEND_NEW_CONFIG_SNAPSHOTS_DIR
          ?? DEFAULT_BACKEND_NEW_CONFIG.paths.configSnapshotsDir
      )
    },
    logging: {
      longTextLimit: readPositiveInt(
        env.BACKEND_NEW_LOG_LONG_TEXT_LIMIT,
        input.logging?.longTextLimit ?? DEFAULT_BACKEND_NEW_CONFIG.logging.longTextLimit
      ),
      shortTextLimit: readPositiveInt(
        env.BACKEND_NEW_LOG_SHORT_TEXT_LIMIT,
        input.logging?.shortTextLimit ?? DEFAULT_BACKEND_NEW_CONFIG.logging.shortTextLimit
      ),
      maxObjectEntries: readPositiveInt(
        env.BACKEND_NEW_LOG_MAX_OBJECT_ENTRIES,
        input.logging?.maxObjectEntries ?? DEFAULT_BACKEND_NEW_CONFIG.logging.maxObjectEntries
      ),
      auditFileName:
        input.logging?.auditFileName
        ?? env.BACKEND_NEW_AUDIT_FILE_NAME
        ?? DEFAULT_BACKEND_NEW_CONFIG.logging.auditFileName,
      retentionDays: readPositiveInt(
        env.BACKEND_NEW_LOG_RETENTION_DAYS,
        input.logging?.retentionDays ?? DEFAULT_BACKEND_NEW_CONFIG.logging.retentionDays
      ),
      cleanupOnInitialize: readBoolean(
        env.BACKEND_NEW_LOG_CLEANUP_ON_INITIALIZE,
        input.logging?.cleanupOnInitialize ?? DEFAULT_BACKEND_NEW_CONFIG.logging.cleanupOnInitialize
      )
    },
    storage: {
      encoding:
        input.storage?.encoding
        ?? (env.BACKEND_NEW_STORAGE_ENCODING as BufferEncoding | undefined)
        ?? DEFAULT_BACKEND_NEW_CONFIG.storage.encoding,
      jsonSpacing: readPositiveInt(
        env.BACKEND_NEW_STORAGE_JSON_SPACING,
        input.storage?.jsonSpacing ?? DEFAULT_BACKEND_NEW_CONFIG.storage.jsonSpacing
      ),
      driver:
        input.storage?.driver
        ?? (env.BACKEND_NEW_STORAGE_DRIVER as 'file' | 'postgres' | undefined)
        ?? DEFAULT_BACKEND_NEW_CONFIG.storage.driver
    },
    database: {
      connectionString:
        input.database?.connectionString
        ?? env.BACKEND_NEW_DATABASE_URL
        ?? DEFAULT_BACKEND_NEW_CONFIG.database.connectionString,
      schema:
        input.database?.schema
        ?? env.BACKEND_NEW_DATABASE_SCHEMA
        ?? DEFAULT_BACKEND_NEW_CONFIG.database.schema,
      autoMigrate: readBoolean(
        env.BACKEND_NEW_DATABASE_AUTO_MIGRATE,
        input.database?.autoMigrate ?? DEFAULT_BACKEND_NEW_CONFIG.database.autoMigrate
      ),
      statementTimeoutMs: readPositiveInt(
        env.BACKEND_NEW_DATABASE_STATEMENT_TIMEOUT_MS,
        input.database?.statementTimeoutMs ?? DEFAULT_BACKEND_NEW_CONFIG.database.statementTimeoutMs
      ),
      queryTimeoutMs: readPositiveInt(
        env.BACKEND_NEW_DATABASE_QUERY_TIMEOUT_MS,
        input.database?.queryTimeoutMs ?? DEFAULT_BACKEND_NEW_CONFIG.database.queryTimeoutMs
      )
    },
    queue: {
      enabled: readBoolean(
        env.BACKEND_NEW_QUEUE_ENABLED,
        input.queue?.enabled ?? DEFAULT_BACKEND_NEW_CONFIG.queue.enabled
      ),
      leaseMs: readPositiveInt(
        env.BACKEND_NEW_QUEUE_LEASE_MS,
        input.queue?.leaseMs ?? DEFAULT_BACKEND_NEW_CONFIG.queue.leaseMs
      ),
      retryDelayMs: readPositiveInt(
        env.BACKEND_NEW_QUEUE_RETRY_DELAY_MS,
        input.queue?.retryDelayMs ?? DEFAULT_BACKEND_NEW_CONFIG.queue.retryDelayMs
      ),
      maxRetries: readPositiveInt(
        env.BACKEND_NEW_QUEUE_MAX_RETRIES,
        input.queue?.maxRetries ?? DEFAULT_BACKEND_NEW_CONFIG.queue.maxRetries
      )
    },
    server: {
      host:
        input.server?.host
        ?? env.BACKEND_NEW_SERVER_HOST
        ?? DEFAULT_BACKEND_NEW_CONFIG.server.host,
      port: readPositiveInt(
        env.BACKEND_NEW_SERVER_PORT,
        input.server?.port ?? DEFAULT_BACKEND_NEW_CONFIG.server.port
      ),
      websocketPath:
        input.server?.websocketPath
        ?? env.BACKEND_NEW_WEBSOCKET_PATH
        ?? DEFAULT_BACKEND_NEW_CONFIG.server.websocketPath,
      enableSseFallback: readBoolean(
        env.BACKEND_NEW_ENABLE_SSE_FALLBACK,
        input.server?.enableSseFallback ?? DEFAULT_BACKEND_NEW_CONFIG.server.enableSseFallback
      )
    },
    worker: {
      enabled: readBoolean(
        env.BACKEND_NEW_WORKER_ENABLED,
        input.worker?.enabled ?? DEFAULT_BACKEND_NEW_CONFIG.worker.enabled
      ),
      pollIntervalMs: readPositiveInt(
        env.BACKEND_NEW_WORKER_POLL_INTERVAL_MS,
        input.worker?.pollIntervalMs ?? DEFAULT_BACKEND_NEW_CONFIG.worker.pollIntervalMs
      ),
      concurrency: readPositiveInt(
        env.BACKEND_NEW_WORKER_CONCURRENCY,
        input.worker?.concurrency ?? DEFAULT_BACKEND_NEW_CONFIG.worker.concurrency
      ),
      heartbeatMs: readPositiveInt(
        env.BACKEND_NEW_WORKER_HEARTBEAT_MS,
        input.worker?.heartbeatMs ?? DEFAULT_BACKEND_NEW_CONFIG.worker.heartbeatMs
      )
    },
    security: {
      secretEncryption:
        input.security?.secretEncryption
        ?? (env.BACKEND_NEW_SECRET_ENCRYPTION as 'none' | 'aes-256-gcm' | undefined)
        ?? DEFAULT_BACKEND_NEW_CONFIG.security.secretEncryption,
      secretKeyEnvVar:
        input.security?.secretKeyEnvVar
        ?? env.BACKEND_NEW_SECRET_KEY_ENV
        ?? DEFAULT_BACKEND_NEW_CONFIG.security.secretKeyEnvVar
    },
    skills: {
      enabled: readBoolean(
        env.BACKEND_NEW_SKILLS_ENABLED,
        input.skills?.enabled ?? DEFAULT_BACKEND_NEW_CONFIG.skills.enabled
      ),
      roots: readStringList(
        env.BACKEND_NEW_SKILL_ROOTS,
        input.skills?.roots ?? DEFAULT_BACKEND_NEW_CONFIG.skills.roots
      ).map(value => normalizeDir(rootDir, value))
    },
    mcp: {
      enabled: readBoolean(
        env.BACKEND_NEW_MCP_ENABLED,
        input.mcp?.enabled ?? DEFAULT_BACKEND_NEW_CONFIG.mcp.enabled
      ),
      registryFile: normalizeDir(
        rootDir,
        input.mcp?.registryFile
          ?? env.BACKEND_NEW_MCP_REGISTRY
          ?? DEFAULT_BACKEND_NEW_CONFIG.mcp.registryFile
      )
    },
    tools: {
      allowOverrides: readBoolean(
        env.BACKEND_NEW_TOOL_ALLOW_OVERRIDES,
        input.tools?.allowOverrides ?? DEFAULT_BACKEND_NEW_CONFIG.tools.allowOverrides
      ),
      manifestFile: normalizeDir(
        rootDir,
        input.tools?.manifestFile
          ?? env.BACKEND_NEW_TOOL_MANIFEST
          ?? DEFAULT_BACKEND_NEW_CONFIG.tools.manifestFile
      ),
      permissionMode:
        input.tools?.permissionMode
        ?? (env.BACKEND_NEW_TOOL_PERMISSION_MODE as 'full' | 'ask' | 'read-only' | undefined)
        ?? DEFAULT_BACKEND_NEW_CONFIG.tools.permissionMode
    },
    providers: {
      allowLocalModels: readBoolean(
        env.BACKEND_NEW_PROVIDER_ALLOW_LOCAL_MODELS,
        input.providers?.allowLocalModels ?? DEFAULT_BACKEND_NEW_CONFIG.providers.allowLocalModels
      ),
      defaultProviderId:
        input.providers?.defaultProviderId
        ?? env.BACKEND_NEW_PROVIDER_DEFAULT_ID
        ?? DEFAULT_BACKEND_NEW_CONFIG.providers.defaultProviderId,
      preferLocalModels: readBoolean(
        env.BACKEND_NEW_PROVIDER_PREFER_LOCAL_MODELS,
        input.providers?.preferLocalModels ?? DEFAULT_BACKEND_NEW_CONFIG.providers.preferLocalModels
      ),
      requestTimeoutMs: readPositiveInt(
        env.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS,
        input.providers?.requestTimeoutMs ?? DEFAULT_BACKEND_NEW_CONFIG.providers.requestTimeoutMs
      ),
      maxRetries: readPositiveInt(
        env.BACKEND_NEW_PROVIDER_MAX_RETRIES,
        input.providers?.maxRetries ?? DEFAULT_BACKEND_NEW_CONFIG.providers.maxRetries
      ),
      retryBackoffMs: readPositiveInt(
        env.BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS,
        input.providers?.retryBackoffMs ?? DEFAULT_BACKEND_NEW_CONFIG.providers.retryBackoffMs
      ),
      manifestFile: normalizeDir(
        rootDir,
        input.providers?.manifestFile
          ?? env.BACKEND_NEW_PROVIDER_MANIFEST
          ?? DEFAULT_BACKEND_NEW_CONFIG.providers.manifestFile
      )
    },
    runtime: {
      maxContextMessages: readPositiveInt(
        env.BACKEND_NEW_RUNTIME_MAX_CONTEXT_MESSAGES,
        input.runtime?.maxContextMessages ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.maxContextMessages
      ),
      retainedContextMessages: readPositiveInt(
        env.BACKEND_NEW_RUNTIME_RETAINED_CONTEXT_MESSAGES,
        input.runtime?.retainedContextMessages ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.retainedContextMessages
      ),
      promptSectionCharacterLimit: readPositiveInt(
        env.BACKEND_NEW_RUNTIME_PROMPT_SECTION_CHARACTER_LIMIT,
        input.runtime?.promptSectionCharacterLimit ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.promptSectionCharacterLimit
      ),
      promptMaxSummaryItems: readPositiveInt(
        env.BACKEND_NEW_RUNTIME_PROMPT_MAX_SUMMARY_ITEMS,
        input.runtime?.promptMaxSummaryItems ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.promptMaxSummaryItems
      ),
      delegation: {
        enabled: readBoolean(
          env.BACKEND_NEW_RUNTIME_DELEGATION_ENABLED,
          input.runtime?.delegation?.enabled ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.delegation.enabled
        ),
        maxDepth: readPositiveInt(
          env.BACKEND_NEW_RUNTIME_DELEGATION_MAX_DEPTH,
          input.runtime?.delegation?.maxDepth ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.delegation.maxDepth
        ),
        maxActiveChildrenPerTask: readPositiveInt(
          env.BACKEND_NEW_RUNTIME_DELEGATION_MAX_ACTIVE_CHILDREN_PER_TASK,
          input.runtime?.delegation?.maxActiveChildrenPerTask ?? DEFAULT_BACKEND_NEW_CONFIG.runtime.delegation.maxActiveChildrenPerTask
        )
      }
    }
  });
}
