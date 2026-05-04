import { RuntimeEventHub } from '../../foundation/projection/event-hub';
import {
  OperatorCommandRecord,
  OperatorMessageRecord,
  PlatformResourceType,
  QueueItemRecord,
  RuntimeEventRecord
} from '../../foundation/repository';
import { ExtensionRegistry } from '../../foundation/extensions/registry';
import { ProviderProfile } from '../../foundation/providers/types';
import { UserPreferenceProfile } from '../../domain/contracts/types';
import { ToolApprovalResolutionInput } from '../../foundation/tools/approval-resolution';
import {
  ResolveApprovalInput,
  SubmitTaskCommandInput,
  SubmitTaskInput,
  TaskActionInput,
  TaskActionResponse,
  TaskArchiveResponse,
  TaskDeleteResponse,
  TaskDiagnosticsSummary,
  TaskDebugResponse,
  TaskDiscussionResponse,
  TaskGuidanceInput,
  TaskGuidanceRecord,
  TaskQueryResponse,
  TaskSummaryResponse,
  TaskToolingResponse,
  TaskTraceEnvelope
} from '../tasks/types';
import { BackendNewTaskApplication } from '../tasks/lifecycle/task-application';
import { BackendNewPlatformApplication } from '../platform';
import {
  CapabilityHubView,
  ChannelUpsertInput,
  ApprovedExperienceRecord,
  BulkDeleteResult,
  ComplexTaskAcceptanceReport,
  ConfigStateView,
  ConfigUpdateInput,
  EcosystemSummaryView,
  ExperienceUpsertInput,
  GovernanceExportBundle,
  ImprovementProposal,
  MemoryUpsertInput,
  PlatformActionResult,
  PlatformAuditTrailView,
  PlatformMetricsView,
  PlatformStatisticsView,
  PlatformSystemView,
  ProviderPresetView,
  ProviderProfileView,
  ProviderSecretSummary,
  ProviderTestResult,
  RealTaskArchiveEntry,
  ScheduleUpsertInput,
  SkillCatalogEntry,
  SkillDuplicateInput,
  SkillImportInput
  ,
  SkillUpsertInput,
  McpCatalogEntry,
  McpTestResult,
  WorkspaceDirectoryListing,
  WorkspaceDocsImportSummary,
  WorkspaceWorkflowView
} from '../platform/types';
import { McpServerDefinition } from '../../foundation/extensions/types';
import { ExtensionRuntimeService } from './extension-runtime-service';
import { RuntimeAnalysisService } from './runtime-analysis-service';

type EnsureReady = () => Promise<void>;

function guardAsync<Args extends unknown[], Result>(
  ensureReady: EnsureReady,
  fn: (...args: Args) => Promise<Result> | Result
) {
  return async (...args: Args): Promise<Result> => {
    await ensureReady();
    return fn(...args);
  };
}

export interface BackendNewAnalysisFacade {
  analyzeTurn(params: {
    taskId: string;
    currentUnitId: string;
    outputContract?: string;
    exitCondition?: string;
    llmResponse: string;
    userMessage?: string;
  }): ReturnType<RuntimeAnalysisService['analyzeTurn']>;
  resolveToolApproval(params: {
    taskId: string;
    invocationId: string;
    resolution: ToolApprovalResolutionInput;
  }): ReturnType<RuntimeAnalysisService['resolveToolApproval']>;
  reviewPendingToolDispatch(taskId: string): ReturnType<RuntimeAnalysisService['reviewPendingToolDispatch']>;
}

export interface BackendNewTasksFacade {
  submitTask(input: SubmitTaskInput): Promise<TaskActionResponse>;
  startTask(input: TaskActionInput): Promise<TaskActionResponse>;
  continueTask(input: TaskActionInput): Promise<TaskActionResponse>;
  submitGuidance(input: TaskGuidanceInput): Promise<TaskActionResponse>;
  pauseTask(input: TaskActionInput): Promise<TaskActionResponse>;
  resumeTask(input: TaskActionInput): Promise<TaskActionResponse>;
  restartTask(input: TaskActionInput): Promise<TaskActionResponse>;
  deleteTask(taskId: string): Promise<TaskDeleteResponse>;
  archiveTask(taskId: string): Promise<TaskArchiveResponse>;
  unarchiveTask(taskId: string): Promise<TaskArchiveResponse>;
  resolveToolApproval(input: ResolveApprovalInput): Promise<TaskActionResponse>;
  submitCommand(input: SubmitTaskCommandInput): Promise<TaskActionResponse>;
  getTask(taskId: string): Promise<TaskQueryResponse>;
  listTasks(includeArchived?: boolean): Promise<TaskSummaryResponse[]>;
  getTaskEvents(taskId: string, afterEventId?: string): Promise<RuntimeEventRecord[]>;
  getTaskCommands(taskId: string): Promise<OperatorCommandRecord[]>;
  getTaskOperatorMessages(taskId: string): Promise<OperatorMessageRecord[]>;
  getTaskGuidance(taskId: string): Promise<TaskGuidanceRecord[]>;
  getTaskDiscussion(taskId: string): Promise<TaskDiscussionResponse>;
  getTaskTooling(taskId: string): Promise<TaskToolingResponse>;
  getTaskTraces(taskId: string): Promise<TaskTraceEnvelope[]>;
  getTaskDebug(taskId: string): Promise<TaskDebugResponse>;
  getRecentAnalysis(taskId: string): Promise<RuntimeEventRecord[]>;
  getDiagnosticsSummary(): Promise<TaskDiagnosticsSummary>;
  listRecoverableTasks(): Promise<TaskSummaryResponse[]>;
  subscribeTaskEvents(taskId: string, listener: Parameters<RuntimeEventHub['subscribe']>[1]): () => void;
}

export interface BackendNewPlatformFacade {
  listProviders(): Promise<ProviderProfileView[]>;
  listProviderPresets(): Promise<ProviderPresetView[]>;
  getProvider(providerId: string): Promise<ProviderProfileView | null>;
  upsertProvider(profile: ProviderProfile): Promise<PlatformActionResult<ProviderProfile>>;
  deleteProvider(providerId: string): Promise<PlatformActionResult<{ ok: true; providerId: string }>>;
  setDefaultProvider(providerId: string): Promise<PlatformActionResult<ProviderProfileView>>;
  listProviderSecrets(): Promise<ProviderSecretSummary[]>;
  setProviderSecret(input: {
    secretId?: string;
    provider: string;
    label: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<PlatformActionResult<ProviderSecretSummary>>;
  testProvider(providerId: string): Promise<ProviderTestResult>;
  listChannels(): Promise<import('../../foundation/repository').PlatformChannelRecord[]>;
  getChannel(channelId: string): Promise<import('../../foundation/repository').PlatformChannelRecord | null>;
  upsertChannel(input: ChannelUpsertInput): Promise<PlatformActionResult<import('../../foundation/repository').PlatformChannelRecord>>;
  deleteChannel(channelId: string): Promise<PlatformActionResult<{ ok: true; channelId: string }>>;
  testChannel(channelId: string): Promise<{ ok: boolean; channelId: string; endpoint: string | null }>;
  listSchedules(): Promise<import('../../foundation/repository').PlatformScheduleRecord[]>;
  getSchedule(scheduleId: string): Promise<import('../../foundation/repository').PlatformScheduleRecord | null>;
  upsertSchedule(input: ScheduleUpsertInput): Promise<PlatformActionResult<import('../../foundation/repository').PlatformScheduleRecord>>;
  deleteSchedule(scheduleId: string): Promise<PlatformActionResult<{ ok: true; scheduleId: string }>>;
  pauseSchedule(scheduleId: string): Promise<PlatformActionResult<import('../../foundation/repository').PlatformScheduleRecord>>;
  resumeSchedule(scheduleId: string): Promise<PlatformActionResult<import('../../foundation/repository').PlatformScheduleRecord>>;
  listMemories(): Promise<import('../../foundation/repository').PlatformMemoryRecord[]>;
  getMemory(memoryId: string): Promise<import('../../foundation/repository').PlatformMemoryRecord | null>;
  searchMemories(query: string): Promise<import('../../foundation/repository').PlatformMemoryRecord[]>;
  upsertMemory(input: MemoryUpsertInput): Promise<PlatformActionResult<import('../../foundation/repository').PlatformMemoryRecord>>;
  deleteMemory(memoryId: string): Promise<PlatformActionResult<{ ok: true; memoryId: string }>>;
  getConfigState(): Promise<ConfigStateView>;
  updateConfig(input: ConfigUpdateInput): Promise<PlatformActionResult<ConfigStateView>>;
  reloadConfig(): Promise<PlatformActionResult<ConfigStateView>>;
  getConfigHealth(): Promise<Record<string, unknown>>;
  getDetailedConfigHealth(): Promise<Record<string, unknown>>;
  getUserPreferenceProfile(): Promise<UserPreferenceProfile | null>;
  listSkills(): Promise<SkillCatalogEntry[]>;
  getSkill(skillId: string): Promise<SkillCatalogEntry | null>;
  refreshSkills(): Promise<PlatformActionResult<SkillCatalogEntry[]>>;
  createSkill(input: SkillUpsertInput): Promise<PlatformActionResult<SkillCatalogEntry>>;
  updateSkill(skillId: string, input: SkillUpsertInput): Promise<PlatformActionResult<SkillCatalogEntry>>;
  deleteSkill(skillId: string): Promise<PlatformActionResult<{ ok: true; skillId: string }>>;
  bulkDeleteSkills(skillIds: string[]): Promise<PlatformActionResult<BulkDeleteResult>>;
  exportSkills(format?: 'json' | 'markdown'): Promise<GovernanceExportBundle<SkillCatalogEntry>>;
  duplicateSkill(skillId: string, input: SkillDuplicateInput): Promise<PlatformActionResult<SkillCatalogEntry>>;
  importSkill(input: SkillImportInput): Promise<PlatformActionResult<import('../../foundation/extensions/types').SkillDefinition>>;
  importMarketplaceSkills(input: Parameters<BackendNewPlatformApplication['importMarketplaceSkills']>[0]): Promise<ReturnType<BackendNewPlatformApplication['importMarketplaceSkills']> extends Promise<infer T> ? T : never>;
  listMcpServers(): Promise<McpCatalogEntry[]>;
  getMcpServer(serverId: string): Promise<McpCatalogEntry | null>;
  upsertMcpServer(input: McpServerDefinition): Promise<PlatformActionResult<McpServerDefinition>>;
  deleteMcpServer(serverId: string): Promise<PlatformActionResult<{ ok: true; serverId: string }>>;
  testMcpServer(serverId: string): Promise<McpTestResult>;
  getStatistics(): Promise<PlatformStatisticsView>;
  getMetrics(): Promise<PlatformMetricsView>;
  getSystemStartup(): Promise<PlatformSystemView>;
  getCapabilityHub(): Promise<CapabilityHubView>;
  getEcosystemSummary(): Promise<EcosystemSummaryView>;
  listToolCapabilities(): Promise<EcosystemSummaryView['tools']>;
  listScriptCatalog(): Promise<EcosystemSummaryView['scriptCatalog']>;
  listEcosystemSkills(): Promise<EcosystemSummaryView['skills']>;
  listEcosystemMcpServers(): Promise<EcosystemSummaryView['mcpServers']>;
  getWorkspaceWorkflow(): Promise<WorkspaceWorkflowView>;
  listWorkspaceDirectories(inputPath?: string | null): Promise<WorkspaceDirectoryListing>;
  initWorkspaceWorkflow(): Promise<PlatformActionResult<WorkspaceWorkflowView>>;
  importWorkspaceDocs(): Promise<PlatformActionResult<WorkspaceDocsImportSummary>>;
  listImprovementProposals(): Promise<ImprovementProposal[]>;
  getImprovementProposal(proposalId: string): Promise<ImprovementProposal | null>;
  approveImprovementProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>>;
  rejectImprovementProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>>;
  listExperiences(): Promise<ApprovedExperienceRecord[]>;
  getExperience(experienceId: string): Promise<ApprovedExperienceRecord | null>;
  createExperience(input: ExperienceUpsertInput): Promise<PlatformActionResult<ApprovedExperienceRecord>>;
  updateExperience(experienceId: string, input: ExperienceUpsertInput): Promise<PlatformActionResult<ApprovedExperienceRecord>>;
  deleteExperience(experienceId: string): Promise<PlatformActionResult<{ ok: true; experienceId: string }>>;
  bulkDeleteExperiences(experienceIds: string[]): Promise<PlatformActionResult<BulkDeleteResult>>;
  exportExperiences(format?: 'json' | 'markdown'): Promise<GovernanceExportBundle<ApprovedExperienceRecord>>;
  promoteExperienceToSkill(experienceId: string): Promise<PlatformActionResult<SkillCatalogEntry>>;
  listRealTaskArchive(): Promise<RealTaskArchiveEntry[]>;
  getComplexTaskAcceptanceReport(): Promise<ComplexTaskAcceptanceReport>;
  getAuditTrail(resourceType: PlatformResourceType, resourceId: string): Promise<PlatformAuditTrailView>;
}

export interface BackendNewExtensionsFacade {
  findTool(toolIdOrName: string): ReturnType<ExtensionRegistry['findTool']>;
  findSkill(skillIdOrName: string): ReturnType<ExtensionRegistry['findSkill']>;
  registerTool(definition: Parameters<ExtensionRegistry['registerTool']>[0]): void;
  registerSkill(definition: Parameters<ExtensionRegistry['registerSkill']>[0]): void;
  snapshot(): ReturnType<ExtensionRegistry['snapshot']>;
  invokeSkill(params: Parameters<ExtensionRuntimeService['invokeSkill']>[0]): ReturnType<ExtensionRuntimeService['invokeSkill']>;
  callMcpTool(params: Parameters<ExtensionRuntimeService['callMcpTool']>[0]): ReturnType<ExtensionRuntimeService['callMcpTool']>;
}

export interface BackendNewWorkerFacade {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  recoverExpiredQueueLeases(now?: number): Promise<number>;
  listDeadLetters(): Promise<QueueItemRecord[]>;
  listActiveQueueItems(): Promise<QueueItemRecord[]>;
  requeueDeadLetter(taskId: string): Promise<boolean>;
}

export function createTasksFacade(params: {
  ensureReady: EnsureReady;
  taskApplication: BackendNewTaskApplication;
}): BackendNewTasksFacade {
  return {
    submitTask: guardAsync(params.ensureReady, params.taskApplication.submitTask.bind(params.taskApplication)),
    startTask: guardAsync(params.ensureReady, params.taskApplication.startTask.bind(params.taskApplication)),
    continueTask: guardAsync(params.ensureReady, params.taskApplication.continueTask.bind(params.taskApplication)),
    submitGuidance: guardAsync(params.ensureReady, params.taskApplication.submitGuidance.bind(params.taskApplication)),
    pauseTask: guardAsync(params.ensureReady, params.taskApplication.pauseTask.bind(params.taskApplication)),
    resumeTask: guardAsync(params.ensureReady, params.taskApplication.resumeTask.bind(params.taskApplication)),
    restartTask: guardAsync(params.ensureReady, params.taskApplication.restartTask.bind(params.taskApplication)),
    deleteTask: guardAsync(params.ensureReady, params.taskApplication.deleteTask.bind(params.taskApplication)),
    archiveTask: guardAsync(params.ensureReady, params.taskApplication.archiveTask.bind(params.taskApplication)),
    unarchiveTask: guardAsync(params.ensureReady, params.taskApplication.unarchiveTask.bind(params.taskApplication)),
    resolveToolApproval: guardAsync(params.ensureReady, params.taskApplication.resolveToolApproval.bind(params.taskApplication)),
    submitCommand: guardAsync(params.ensureReady, params.taskApplication.submitCommand.bind(params.taskApplication)),
    getTask: guardAsync(params.ensureReady, params.taskApplication.getTask.bind(params.taskApplication)),
    listTasks: guardAsync(params.ensureReady, params.taskApplication.listTasks.bind(params.taskApplication)),
    getTaskEvents: guardAsync(params.ensureReady, params.taskApplication.getTaskEvents.bind(params.taskApplication)),
    getTaskCommands: guardAsync(params.ensureReady, params.taskApplication.getTaskCommands.bind(params.taskApplication)),
    getTaskOperatorMessages: guardAsync(params.ensureReady, params.taskApplication.getTaskOperatorMessages.bind(params.taskApplication)),
    getTaskGuidance: guardAsync(params.ensureReady, params.taskApplication.getTaskGuidance.bind(params.taskApplication)),
    getTaskDiscussion: guardAsync(params.ensureReady, params.taskApplication.getTaskDiscussion.bind(params.taskApplication)),
    getTaskTooling: guardAsync(params.ensureReady, params.taskApplication.getTaskTooling.bind(params.taskApplication)),
    getTaskTraces: guardAsync(params.ensureReady, params.taskApplication.getTaskTraces.bind(params.taskApplication)),
    getTaskDebug: guardAsync(params.ensureReady, params.taskApplication.getTaskDebug.bind(params.taskApplication)),
    getRecentAnalysis: guardAsync(params.ensureReady, params.taskApplication.getRecentAnalysis.bind(params.taskApplication)),
    getDiagnosticsSummary: guardAsync(params.ensureReady, params.taskApplication.getDiagnosticsSummary.bind(params.taskApplication)),
    listRecoverableTasks: guardAsync(params.ensureReady, params.taskApplication.listRecoverableTasks.bind(params.taskApplication)),
    subscribeTaskEvents: params.taskApplication.subscribeTaskEvents.bind(params.taskApplication)
  };
}

export function createPlatformFacade(params: {
  ensureReady: EnsureReady;
  platformApplication: BackendNewPlatformApplication;
  getUserPreferenceProfile: () => Promise<UserPreferenceProfile | null>;
}): BackendNewPlatformFacade {
  return {
    listProviders: guardAsync(params.ensureReady, params.platformApplication.listProviders.bind(params.platformApplication)),
    listProviderPresets: guardAsync(params.ensureReady, params.platformApplication.listProviderPresets.bind(params.platformApplication)),
    getProvider: guardAsync(params.ensureReady, params.platformApplication.getProvider.bind(params.platformApplication)),
    upsertProvider: guardAsync(params.ensureReady, params.platformApplication.upsertProvider.bind(params.platformApplication)),
    deleteProvider: guardAsync(params.ensureReady, params.platformApplication.deleteProvider.bind(params.platformApplication)),
    setDefaultProvider: guardAsync(params.ensureReady, params.platformApplication.setDefaultProvider.bind(params.platformApplication)),
    listProviderSecrets: guardAsync(params.ensureReady, params.platformApplication.listProviderSecrets.bind(params.platformApplication)),
    setProviderSecret: guardAsync(params.ensureReady, params.platformApplication.setProviderSecret.bind(params.platformApplication)),
    testProvider: guardAsync(params.ensureReady, params.platformApplication.testProvider.bind(params.platformApplication)),
    listChannels: guardAsync(params.ensureReady, params.platformApplication.listChannels.bind(params.platformApplication)),
    getChannel: guardAsync(params.ensureReady, params.platformApplication.getChannel.bind(params.platformApplication)),
    upsertChannel: guardAsync(params.ensureReady, params.platformApplication.upsertChannel.bind(params.platformApplication)),
    deleteChannel: guardAsync(params.ensureReady, params.platformApplication.deleteChannel.bind(params.platformApplication)),
    testChannel: guardAsync(params.ensureReady, params.platformApplication.testChannel.bind(params.platformApplication)),
    listSchedules: guardAsync(params.ensureReady, params.platformApplication.listSchedules.bind(params.platformApplication)),
    getSchedule: guardAsync(params.ensureReady, params.platformApplication.getSchedule.bind(params.platformApplication)),
    upsertSchedule: guardAsync(params.ensureReady, params.platformApplication.upsertSchedule.bind(params.platformApplication)),
    deleteSchedule: guardAsync(params.ensureReady, params.platformApplication.deleteSchedule.bind(params.platformApplication)),
    pauseSchedule: guardAsync(params.ensureReady, params.platformApplication.pauseSchedule.bind(params.platformApplication)),
    resumeSchedule: guardAsync(params.ensureReady, params.platformApplication.resumeSchedule.bind(params.platformApplication)),
    listMemories: guardAsync(params.ensureReady, params.platformApplication.listMemories.bind(params.platformApplication)),
    getMemory: guardAsync(params.ensureReady, params.platformApplication.getMemory.bind(params.platformApplication)),
    searchMemories: guardAsync(params.ensureReady, params.platformApplication.searchMemories.bind(params.platformApplication)),
    upsertMemory: guardAsync(params.ensureReady, params.platformApplication.upsertMemory.bind(params.platformApplication)),
    deleteMemory: guardAsync(params.ensureReady, params.platformApplication.deleteMemory.bind(params.platformApplication)),
    getConfigState: guardAsync(params.ensureReady, params.platformApplication.getConfigState.bind(params.platformApplication)),
    updateConfig: guardAsync(params.ensureReady, params.platformApplication.updateConfig.bind(params.platformApplication)),
    reloadConfig: guardAsync(params.ensureReady, params.platformApplication.reloadConfig.bind(params.platformApplication)),
    getConfigHealth: guardAsync(params.ensureReady, params.platformApplication.getConfigHealth.bind(params.platformApplication)),
    getDetailedConfigHealth: guardAsync(params.ensureReady, params.platformApplication.getDetailedConfigHealth.bind(params.platformApplication)),
    getUserPreferenceProfile: guardAsync(params.ensureReady, params.getUserPreferenceProfile),
    listSkills: guardAsync(params.ensureReady, params.platformApplication.listSkills.bind(params.platformApplication)),
    getSkill: guardAsync(params.ensureReady, params.platformApplication.getSkill.bind(params.platformApplication)),
    refreshSkills: guardAsync(params.ensureReady, params.platformApplication.refreshSkills.bind(params.platformApplication)),
    createSkill: guardAsync(params.ensureReady, params.platformApplication.createSkill.bind(params.platformApplication)),
    updateSkill: guardAsync(params.ensureReady, params.platformApplication.updateSkill.bind(params.platformApplication)),
    deleteSkill: guardAsync(params.ensureReady, params.platformApplication.deleteSkill.bind(params.platformApplication)),
    bulkDeleteSkills: guardAsync(params.ensureReady, params.platformApplication.bulkDeleteSkills.bind(params.platformApplication)),
    exportSkills: guardAsync(params.ensureReady, params.platformApplication.exportSkills.bind(params.platformApplication)),
    duplicateSkill: guardAsync(params.ensureReady, params.platformApplication.duplicateSkill.bind(params.platformApplication)),
    importSkill: guardAsync(params.ensureReady, params.platformApplication.importSkill.bind(params.platformApplication)),
    importMarketplaceSkills: guardAsync(params.ensureReady, params.platformApplication.importMarketplaceSkills.bind(params.platformApplication)),
    listMcpServers: guardAsync(params.ensureReady, params.platformApplication.listMcpServers.bind(params.platformApplication)),
    getMcpServer: guardAsync(params.ensureReady, params.platformApplication.getMcpServer.bind(params.platformApplication)),
    upsertMcpServer: guardAsync(params.ensureReady, params.platformApplication.upsertMcpServer.bind(params.platformApplication)),
    deleteMcpServer: guardAsync(params.ensureReady, params.platformApplication.deleteMcpServer.bind(params.platformApplication)),
    testMcpServer: guardAsync(params.ensureReady, params.platformApplication.testMcpServer.bind(params.platformApplication)),
    getStatistics: guardAsync(params.ensureReady, params.platformApplication.getStatistics.bind(params.platformApplication)),
    getMetrics: guardAsync(params.ensureReady, params.platformApplication.getMetrics.bind(params.platformApplication)),
    getSystemStartup: guardAsync(params.ensureReady, params.platformApplication.getSystemStartup.bind(params.platformApplication)),
    getCapabilityHub: guardAsync(params.ensureReady, params.platformApplication.getCapabilityHub.bind(params.platformApplication)),
    getEcosystemSummary: guardAsync(params.ensureReady, params.platformApplication.getEcosystemSummary.bind(params.platformApplication)),
    listToolCapabilities: guardAsync(params.ensureReady, params.platformApplication.listToolCapabilities.bind(params.platformApplication)),
    listScriptCatalog: guardAsync(params.ensureReady, params.platformApplication.listScriptCatalog.bind(params.platformApplication)),
    listEcosystemSkills: guardAsync(params.ensureReady, params.platformApplication.listEcosystemSkills.bind(params.platformApplication)),
    listEcosystemMcpServers: guardAsync(params.ensureReady, params.platformApplication.listEcosystemMcpServers.bind(params.platformApplication)),
    getWorkspaceWorkflow: guardAsync(params.ensureReady, params.platformApplication.getWorkspaceWorkflow.bind(params.platformApplication)),
    listWorkspaceDirectories: guardAsync(params.ensureReady, params.platformApplication.listWorkspaceDirectories.bind(params.platformApplication)),
    initWorkspaceWorkflow: guardAsync(params.ensureReady, params.platformApplication.initWorkspaceWorkflow.bind(params.platformApplication)),
    importWorkspaceDocs: guardAsync(params.ensureReady, params.platformApplication.importWorkspaceDocs.bind(params.platformApplication)),
    listImprovementProposals: guardAsync(params.ensureReady, params.platformApplication.listImprovementProposals.bind(params.platformApplication)),
    getImprovementProposal: guardAsync(params.ensureReady, params.platformApplication.getImprovementProposal.bind(params.platformApplication)),
    approveImprovementProposal: guardAsync(params.ensureReady, params.platformApplication.approveImprovementProposal.bind(params.platformApplication)),
    rejectImprovementProposal: guardAsync(params.ensureReady, params.platformApplication.rejectImprovementProposal.bind(params.platformApplication)),
    listExperiences: guardAsync(params.ensureReady, params.platformApplication.listExperiences.bind(params.platformApplication)),
    getExperience: guardAsync(params.ensureReady, params.platformApplication.getExperience.bind(params.platformApplication)),
    createExperience: guardAsync(params.ensureReady, params.platformApplication.createExperience.bind(params.platformApplication)),
    updateExperience: guardAsync(params.ensureReady, params.platformApplication.updateExperience.bind(params.platformApplication)),
    deleteExperience: guardAsync(params.ensureReady, params.platformApplication.deleteExperience.bind(params.platformApplication)),
    bulkDeleteExperiences: guardAsync(params.ensureReady, params.platformApplication.bulkDeleteExperiences.bind(params.platformApplication)),
    exportExperiences: guardAsync(params.ensureReady, params.platformApplication.exportExperiences.bind(params.platformApplication)),
    promoteExperienceToSkill: guardAsync(params.ensureReady, params.platformApplication.promoteExperienceToSkill.bind(params.platformApplication)),
    listRealTaskArchive: guardAsync(params.ensureReady, params.platformApplication.listRealTaskArchive.bind(params.platformApplication)),
    getComplexTaskAcceptanceReport: guardAsync(params.ensureReady, params.platformApplication.getComplexTaskAcceptanceReport.bind(params.platformApplication)),
    getAuditTrail: guardAsync(params.ensureReady, params.platformApplication.getAuditTrail.bind(params.platformApplication))
  };
}

export function createAnalysisFacade(params: {
  ensureReady: EnsureReady;
  analysisService: RuntimeAnalysisService;
}): BackendNewAnalysisFacade {
  return {
    analyzeTurn: guardAsync(params.ensureReady, params.analysisService.analyzeTurn.bind(params.analysisService)),
    resolveToolApproval: guardAsync(params.ensureReady, params.analysisService.resolveToolApproval.bind(params.analysisService)),
    reviewPendingToolDispatch: guardAsync(params.ensureReady, params.analysisService.reviewPendingToolDispatch.bind(params.analysisService))
  };
}

export function createExtensionsFacade(params: {
  ensureReady: EnsureReady;
  extensions: ExtensionRegistry;
  extensionRuntimeService: ExtensionRuntimeService;
}): BackendNewExtensionsFacade {
  return {
    findTool: params.extensions.findTool.bind(params.extensions),
    findSkill: params.extensions.findSkill.bind(params.extensions),
    registerTool: params.extensions.registerTool.bind(params.extensions),
    registerSkill: params.extensions.registerSkill.bind(params.extensions),
    snapshot: params.extensions.snapshot.bind(params.extensions),
    invokeSkill: guardAsync(params.ensureReady, params.extensionRuntimeService.invokeSkill.bind(params.extensionRuntimeService)),
    callMcpTool: guardAsync(params.ensureReady, params.extensionRuntimeService.callMcpTool.bind(params.extensionRuntimeService))
  };
}

export function createWorkerFacade(params: {
  ensureReady: EnsureReady;
  workerService: {
    tick(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
  } | null;
  recoveryService: {
    recoverExpiredQueueLeases(now?: number): Promise<number>;
    listDeadLetters(): Promise<QueueItemRecord[]>;
    listActiveQueueItems(): Promise<QueueItemRecord[]>;
    requeueDeadLetter(taskId: string): Promise<boolean>;
  } | null;
}): BackendNewWorkerFacade {
  return {
    tick: async () => {
      if (params.workerService) {
        await params.workerService.tick();
      }
    },
    start: () => {
      params.workerService?.start();
    },
    stop: async () => {
      await params.workerService?.stop();
    },
    recoverExpiredQueueLeases: guardAsync(params.ensureReady, async (now = Date.now()) => {
      if (!params.recoveryService) {
        return 0;
      }
      return params.recoveryService.recoverExpiredQueueLeases(now);
    }),
    listDeadLetters: guardAsync(params.ensureReady, async () => params.recoveryService?.listDeadLetters() ?? []),
    listActiveQueueItems: guardAsync(params.ensureReady, async () => params.recoveryService?.listActiveQueueItems() ?? []),
    requeueDeadLetter: guardAsync(params.ensureReady, async (taskId) => params.recoveryService?.requeueDeadLetter(taskId) ?? false)
  };
}
