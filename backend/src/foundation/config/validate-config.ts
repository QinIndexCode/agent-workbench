import path from 'node:path';
import { BackendNewConfig } from './types';

const SUPPORTED_ENCODINGS = new Set<BufferEncoding>([
  'utf8',
  'utf-8',
  'utf16le',
  'ucs2',
  'ucs-2',
  'ascii',
  'latin1'
]);

function assertAbsoluteDir(name: string, value: string): void {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`backend_new config error: "${name}" must be an absolute path.`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`backend_new config error: "${name}" must be a positive number.`);
  }
}

function assertAuditFileName(fileName: string): void {
  if (!fileName) {
    throw new Error('backend_new config error: "logging.auditFileName" is required.');
  }

  if (path.basename(fileName) !== fileName) {
    throw new Error('backend_new config error: "logging.auditFileName" must not contain path segments.');
  }

  if (!fileName.endsWith('.jsonl')) {
    throw new Error('backend_new config error: "logging.auditFileName" must end with .jsonl.');
  }
}

export function validateBackendNewConfig(config: BackendNewConfig): BackendNewConfig {
  assertAbsoluteDir('paths.rootDir', config.paths.rootDir);
  assertAbsoluteDir('paths.tasksDir', config.paths.tasksDir);
  assertAbsoluteDir('paths.tracesDir', config.paths.tracesDir);
  assertAbsoluteDir('paths.workspaceDir', config.paths.workspaceDir);
  assertAbsoluteDir('paths.checkpointsDir', config.paths.checkpointsDir);
  assertAbsoluteDir('paths.logsDir', config.paths.logsDir);
  assertAbsoluteDir('paths.secretsDir', config.paths.secretsDir);
  assertAbsoluteDir('paths.sessionsDir', config.paths.sessionsDir);
  assertAbsoluteDir('paths.projectionsDir', config.paths.projectionsDir);
  assertAbsoluteDir('paths.eventsDir', config.paths.eventsDir);
  assertAbsoluteDir('paths.outputsDir', config.paths.outputsDir);
  assertAbsoluteDir('paths.toolInvocationsDir', config.paths.toolInvocationsDir);
  assertAbsoluteDir('paths.approvalsDir', config.paths.approvalsDir);
  assertAbsoluteDir('paths.conversationsDir', config.paths.conversationsDir);
  assertAbsoluteDir('paths.configSnapshotsDir', config.paths.configSnapshotsDir);

  assertPositive('logging.longTextLimit', config.logging.longTextLimit);
  assertPositive('logging.shortTextLimit', config.logging.shortTextLimit);
  assertPositive('logging.maxObjectEntries', config.logging.maxObjectEntries);
  assertPositive('logging.retentionDays', config.logging.retentionDays);
  assertPositive('storage.jsonSpacing', config.storage.jsonSpacing);
  assertPositive('database.statementTimeoutMs', config.database.statementTimeoutMs);
  assertPositive('database.queryTimeoutMs', config.database.queryTimeoutMs);
  assertPositive('queue.leaseMs', config.queue.leaseMs);
  assertPositive('queue.retryDelayMs', config.queue.retryDelayMs);
  assertPositive('queue.maxRetries', config.queue.maxRetries);
  assertPositive('server.port', config.server.port);
  assertPositive('worker.pollIntervalMs', config.worker.pollIntervalMs);
  assertPositive('worker.concurrency', config.worker.concurrency);
  assertPositive('worker.heartbeatMs', config.worker.heartbeatMs);
  assertPositive('providers.requestTimeoutMs', config.providers.requestTimeoutMs);
  assertPositive('providers.maxRetries', config.providers.maxRetries);
  assertPositive('providers.retryBackoffMs', config.providers.retryBackoffMs);
  assertPositive('runtime.maxContextMessages', config.runtime.maxContextMessages);
  assertPositive('runtime.retainedContextMessages', config.runtime.retainedContextMessages);
  assertPositive('runtime.promptSectionCharacterLimit', config.runtime.promptSectionCharacterLimit);
  assertPositive('runtime.promptMaxSummaryItems', config.runtime.promptMaxSummaryItems);
  assertPositive('runtime.delegation.maxDepth', config.runtime.delegation.maxDepth);
  assertPositive('runtime.delegation.maxActiveChildrenPerTask', config.runtime.delegation.maxActiveChildrenPerTask);
  assertAbsoluteDir('mcp.registryFile', path.dirname(config.mcp.registryFile));
  assertAbsoluteDir('tools.manifestFile', path.dirname(config.tools.manifestFile));
  assertAbsoluteDir('providers.manifestFile', path.dirname(config.providers.manifestFile));

  for (const skillRoot of config.skills.roots) {
    assertAbsoluteDir('skills.roots[]', skillRoot);
  }

  if (config.logging.longTextLimit < config.logging.shortTextLimit) {
    throw new Error(
      'backend_new config error: "logging.longTextLimit" must be >= "logging.shortTextLimit".'
    );
  }

  if (config.storage.jsonSpacing > 8) {
    throw new Error('backend_new config error: "storage.jsonSpacing" must be <= 8.');
  }

  if (!['file', 'postgres'].includes(config.storage.driver)) {
    throw new Error(
      `backend_new config error: unsupported storage driver "${config.storage.driver}".`
    );
  }

  if (config.storage.driver === 'postgres' && !config.database.connectionString?.trim()) {
    throw new Error('backend_new config error: "database.connectionString" is required for postgres driver.');
  }

  if (!config.database.schema.trim()) {
    throw new Error('backend_new config error: "database.schema" must not be empty.');
  }

  if (!config.server.host.trim()) {
    throw new Error('backend_new config error: "server.host" must not be empty.');
  }

  if (!config.server.websocketPath.startsWith('/')) {
    throw new Error('backend_new config error: "server.websocketPath" must start with "/".');
  }

  if (config.runtime.maxContextMessages < config.runtime.retainedContextMessages) {
    throw new Error(
      'backend_new config error: "runtime.maxContextMessages" must be >= "runtime.retainedContextMessages".'
    );
  }

  if (config.runtime.promptMaxSummaryItems > config.runtime.maxContextMessages) {
    throw new Error(
      'backend_new config error: "runtime.promptMaxSummaryItems" must be <= "runtime.maxContextMessages".'
    );
  }

  if (config.runtime.delegation.maxDepth !== 1) {
    throw new Error(
      'backend_new config error: "runtime.delegation.maxDepth" must be 1 for the current controlled SubSccAgent release.'
    );
  }

  if (!SUPPORTED_ENCODINGS.has(config.storage.encoding)) {
    throw new Error(
      `backend_new config error: unsupported storage encoding "${config.storage.encoding}".`
    );
  }

  if (!['none', 'aes-256-gcm'].includes(config.security.secretEncryption)) {
    throw new Error(
      `backend_new config error: unsupported secret encryption "${config.security.secretEncryption}".`
    );
  }

  if (!config.security.secretKeyEnvVar.trim()) {
    throw new Error('backend_new config error: "security.secretKeyEnvVar" must not be empty.');
  }

  if (config.providers.defaultProviderId !== null && !config.providers.defaultProviderId.trim()) {
    throw new Error('backend_new config error: "providers.defaultProviderId" must be null or non-empty.');
  }

  if (!['full', 'ask', 'read-only'].includes(config.tools.permissionMode)) {
    throw new Error(
      `backend_new config error: unsupported tool permission mode "${config.tools.permissionMode}".`
    );
  }

  assertAuditFileName(config.logging.auditFileName);

  return config;
}
