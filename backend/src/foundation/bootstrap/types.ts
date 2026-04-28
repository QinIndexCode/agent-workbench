import { BackendNewConfig } from '../config/types';
import { TaskLogWriter } from '../logging/task-log-writer';
import { RuntimeEventHub, TaskSnapshotHub } from '../projection/event-hub';
import {
  ApiKeySecretRepository,
  CheckpointRepository,
  ConfigSnapshotRepository,
  ConversationRepository,
  ExecutionSessionRepository,
  QueueRepository,
  RuntimeEventRepository,
  InterruptRequestRepository,
  OperatorCommandRepository,
  OperatorMessageRepository,
  PlatformChannelRepository,
  PlatformCommandRepository,
  PlatformMemoryRepository,
  PlatformScheduleRepository,
  PlatformAuditRepository,
  TaskMetadataRepository,
  TaskProjectionRepository,
  TaskRepository,
  TaskRuntimeRepository,
  ToolApprovalRepository,
  ToolInvocationRepository,
  ValidatedOutputRepository
} from '../repository';
import { DatabaseAdapter } from '../database/types';
import { SecretCipher } from '../security/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import { ExtensionRegistry } from '../extensions/registry';
import { McpClientRegistry } from '../mcp/client-registry';
import { ProviderRegistry } from '../providers/registry';
import { ProviderClientRegistry } from '../providers/client-registry';
import { SkillRuntimeRegistry } from '../skills/runtime-registry';
import { ToolExecutorRegistry } from '../tools/executor-registry';

export interface BackendNewFoundation {
  cwd: string;
  config: BackendNewConfig;
  storage: StorageAdapter;
  layout: StorageLayout;
  logs: TaskLogWriter;
  eventHub: RuntimeEventHub;
  snapshotHub: TaskSnapshotHub;
  database: DatabaseAdapter | null;
  cipher: SecretCipher;
  tasks: TaskRepository;
  taskRuntimes: TaskRuntimeRepository;
  checkpoints: CheckpointRepository;
  apiKeys: ApiKeySecretRepository;
  taskMetadata: TaskMetadataRepository;
  sessions: ExecutionSessionRepository;
  projections: TaskProjectionRepository;
  events: RuntimeEventRepository;
  validatedOutputs: ValidatedOutputRepository;
  toolInvocations: ToolInvocationRepository;
  approvals: ToolApprovalRepository;
  conversations: ConversationRepository;
  commands: OperatorCommandRepository;
  operatorMessages: OperatorMessageRepository;
  interrupts: InterruptRequestRepository;
  configSnapshots: ConfigSnapshotRepository;
  channels: PlatformChannelRepository;
  schedules: PlatformScheduleRepository;
  memories: PlatformMemoryRepository;
  platformCommands: PlatformCommandRepository;
  platformAudits: PlatformAuditRepository;
  queue: QueueRepository | null;
  extensions: ExtensionRegistry;
  providers: ProviderRegistry;
  providerClients: ProviderClientRegistry;
  skillRuntimes: SkillRuntimeRegistry;
  mcpClients: McpClientRegistry;
  toolExecutors: ToolExecutorRegistry;
}
