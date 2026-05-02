import path from 'node:path';
import { BackendNewConfig, BackendNewConfigInput } from '../config/types';
import { loadBackendNewConfig } from '../config/load-config';
import { PostgresDatabaseAdapter } from '../database';
import { TaskLogWriter } from '../logging/task-log-writer';
import {
  FileApiKeySecretRepository,
  FileCheckpointRepository,
  FileConfigSnapshotRepository,
  FileConversationRepository,
  FileInterruptRequestRepository,
  FileOperatorCommandRepository,
  FileOperatorMessageRepository,
  FileExecutionSessionRepository,
  FilePlatformChannelRepository,
  FilePlatformCommandRepository,
  FilePlatformMemoryRepository,
  FilePlatformScheduleRepository,
  FilePlatformAuditRepository,
  FileRuntimeEventRepository,
  FileTaskMetadataRepository,
  FileTaskProjectionRepository,
  FileTaskRepository,
  FileTaskRuntimeRepository,
  FileToolApprovalRepository,
  FileToolInvocationRepository,
  FileValidatedOutputRepository,
  PostgresApiKeySecretRepository,
  PostgresCheckpointRepository,
  PostgresConfigSnapshotRepository,
  PostgresConversationRepository,
  PostgresInterruptRequestRepository,
  PostgresOperatorCommandRepository,
  PostgresOperatorMessageRepository,
  PostgresExecutionSessionRepository,
  PostgresPlatformChannelRepository,
  PostgresPlatformCommandRepository,
  PostgresPlatformMemoryRepository,
  PostgresPlatformScheduleRepository,
  PostgresPlatformAuditRepository,
  PostgresRuntimeEventRepository,
  PostgresTaskMetadataRepository,
  PostgresTaskProjectionRepository,
  PostgresTaskRepository,
  PostgresTaskRuntimeRepository,
  PostgresToolApprovalRepository,
  PostgresToolInvocationRepository,
  PostgresValidatedOutputRepository
} from '../repository';
import { PostgresQueueRepository } from '../queue';
import { createSecretCipher } from '../security/create-secret-cipher';
import { FileStorageAdapter } from '../storage/file-storage';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { ExtensionRegistry } from '../extensions/registry';
import { McpClientRegistry } from '../mcp/client-registry';
import { RuntimeEventHub, TaskSnapshotHub } from '../projection/event-hub';
import { ProviderRegistry } from '../providers/registry';
import { ProviderClientRegistry } from '../providers/client-registry';
import { SkillRuntimeRegistry } from '../skills/runtime-registry';
import { ToolExecutorRegistry } from '../tools/executor-registry';
import { BackendNewFoundation } from './types';

export interface CreateFoundationOptions {
  config?: BackendNewConfigInput;
  resolvedConfig?: BackendNewConfig;
  storage?: StorageAdapter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function createBackendNewFoundation(
  options: CreateFoundationOptions = {}
): BackendNewFoundation {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? env.BACKEND_NEW_WORKSPACE_CWD ?? process.cwd());
  const config = options.resolvedConfig ?? loadBackendNewConfig(options.config, {
    cwd,
    env
  });
  const storage = options.storage ?? new FileStorageAdapter();
  const layout = new StorageLayout(config);
  const logs = new TaskLogWriter(config, storage, layout);
  const eventHub = new RuntimeEventHub();
  const snapshotHub = new TaskSnapshotHub();
  const cipher = createSecretCipher(config, env);
  const database = config.storage.driver === 'postgres'
    ? new PostgresDatabaseAdapter(config)
    : null;

  if (config.storage.driver === 'postgres' && !database) {
    throw new Error('backend_new foundation error: postgres driver requires database adapter.');
  }

  return {
    cwd,
    config,
    storage,
    layout,
    logs,
    eventHub,
    snapshotHub,
    database,
    cipher,
    tasks: database ? new PostgresTaskRepository(config, database) : new FileTaskRepository(config, storage, layout),
    taskRuntimes: database ? new PostgresTaskRuntimeRepository(config, database, snapshotHub) : new FileTaskRuntimeRepository(config, storage, layout, snapshotHub),
    checkpoints: database ? new PostgresCheckpointRepository(config, database) : new FileCheckpointRepository(config, storage, layout),
    apiKeys: database ? new PostgresApiKeySecretRepository(config, database, cipher) : new FileApiKeySecretRepository(config, storage, layout, cipher),
    taskMetadata: database ? new PostgresTaskMetadataRepository(config, database, snapshotHub) : new FileTaskMetadataRepository(config, storage, layout, snapshotHub),
    sessions: database ? new PostgresExecutionSessionRepository(config, database) : new FileExecutionSessionRepository(config, storage, layout),
    projections: database ? new PostgresTaskProjectionRepository(config, database, snapshotHub) : new FileTaskProjectionRepository(config, storage, layout, snapshotHub),
    events: database ? new PostgresRuntimeEventRepository(config, database, eventHub) : new FileRuntimeEventRepository(config, storage, layout, eventHub),
    validatedOutputs: database ? new PostgresValidatedOutputRepository(config, database, snapshotHub) : new FileValidatedOutputRepository(config, storage, layout, snapshotHub),
    toolInvocations: database ? new PostgresToolInvocationRepository(config, database, snapshotHub) : new FileToolInvocationRepository(config, storage, layout, snapshotHub),
    approvals: database ? new PostgresToolApprovalRepository(config, database, snapshotHub) : new FileToolApprovalRepository(config, storage, layout, snapshotHub),
    conversations: database ? new PostgresConversationRepository(config, database, snapshotHub) : new FileConversationRepository(config, storage, layout, snapshotHub),
    commands: database ? new PostgresOperatorCommandRepository(config, database, snapshotHub) : new FileOperatorCommandRepository(config, storage, layout, snapshotHub),
    operatorMessages: database ? new PostgresOperatorMessageRepository(config, database, snapshotHub) : new FileOperatorMessageRepository(config, storage, layout, snapshotHub),
    interrupts: database ? new PostgresInterruptRequestRepository(config, database) : new FileInterruptRequestRepository(config, storage, layout),
    configSnapshots: database ? new PostgresConfigSnapshotRepository(config, database) : new FileConfigSnapshotRepository(config, storage, layout),
    channels: database ? new PostgresPlatformChannelRepository(config, database) : new FilePlatformChannelRepository(config, storage, layout),
    schedules: database ? new PostgresPlatformScheduleRepository(config, database) : new FilePlatformScheduleRepository(config, storage, layout),
    memories: database ? new PostgresPlatformMemoryRepository(config, database) : new FilePlatformMemoryRepository(config, storage, layout),
    platformCommands: database ? new PostgresPlatformCommandRepository(config, database) : new FilePlatformCommandRepository(config, storage, layout),
    platformAudits: database ? new PostgresPlatformAuditRepository(config, database) : new FilePlatformAuditRepository(config, storage, layout),
    queue: database && config.queue.enabled ? new PostgresQueueRepository(config, database) : null,
    extensions: new ExtensionRegistry(),
    providers: new ProviderRegistry(),
    providerClients: new ProviderClientRegistry(),
    skillRuntimes: new SkillRuntimeRegistry(),
    mcpClients: new McpClientRegistry(),
    toolExecutors: new ToolExecutorRegistry()
  };
}
