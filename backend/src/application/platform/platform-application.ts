import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { ChannelService } from './channel-service';
import { ConfigService } from './config-service';
import { MemoryService } from './memory-service';
import { ProviderService } from './provider-service';
import { ScheduleService } from './schedule-service';
import { SkillService } from './skill-service';
import { McpService } from './mcp-service';
import { StatisticsService } from './statistics-service';
import { SystemService } from './system-service';
import { WorkspaceWorkflowService } from './workspace-workflow-service';
import { ImprovementService } from './improvement-service';
import {
  CapabilityHubView,
  ChannelUpsertInput,
  ComplexTaskAcceptanceReport,
  ConfigUpdateInput,
  EcosystemSummaryView,
  ImprovementProposal,
  MemoryUpsertInput,
  PlatformAuditTrailView,
  RealTaskArchiveEntry,
  ScheduleUpsertInput,
  SkillDuplicateInput,
  SkillImportInput,
  SkillUpsertInput,
  WorkspaceDocsImportSummary,
  WorkspaceWorkflowView
} from './types';
import { ProviderProfile } from '../../foundation/providers/types';
import { createCapabilityHubView } from './capability-hub';
import { createEcosystemSummaryView } from './ecosystem-registry';

export class BackendNewPlatformApplication {
  private readonly channels: ChannelService;
  readonly config: ConfigService;
  private readonly memories: MemoryService;
  private readonly providers: ProviderService;
  private readonly schedules: ScheduleService;
  private readonly skills: SkillService;
  private readonly mcp: McpService;
  private readonly statistics: StatisticsService;
  private readonly system: SystemService;
  private readonly workspace: WorkspaceWorkflowService;
  private readonly improvements: ImprovementService;

  constructor(foundation: BackendNewFoundation) {
    this.channels = new ChannelService(foundation);
    this.config = new ConfigService(foundation);
    this.memories = new MemoryService(foundation);
    this.providers = new ProviderService(foundation, this.config);
    this.schedules = new ScheduleService(foundation);
    this.skills = new SkillService(foundation);
    this.mcp = new McpService(foundation);
    this.statistics = new StatisticsService(foundation);
    this.system = new SystemService(foundation);
    this.workspace = new WorkspaceWorkflowService(foundation);
    this.improvements = new ImprovementService(foundation);
    this.foundation = foundation;
  }

  private readonly foundation: BackendNewFoundation;

  listChannels() { return this.channels.list(); }
  getChannel(channelId: string) { return this.channels.get(channelId); }
  upsertChannel(input: ChannelUpsertInput) { return this.channels.upsert(input); }
  deleteChannel(channelId: string) { return this.channels.remove(channelId); }
  testChannel(channelId: string) { return this.channels.test(channelId); }

  getConfigState() { return this.config.getState(); }
  updateConfig(input: ConfigUpdateInput) { return this.config.update(input); }
  reloadConfig() { return this.config.reload(); }
  getConfigHealth() { return this.config.health(); }
  getDetailedConfigHealth() { return this.config.detailedHealth(); }

  listMemories() { return this.memories.list(); }
  getMemory(memoryId: string) { return this.memories.get(memoryId); }
  searchMemories(query: string) { return this.memories.search(query); }
  upsertMemory(input: MemoryUpsertInput) { return this.memories.upsert(input); }
  deleteMemory(memoryId: string) { return this.memories.remove(memoryId); }

  listProviders() { return this.providers.list(); }
  listProviderPresets() { return this.providers.listPresets(); }
  getProvider(providerId: string) { return this.providers.get(providerId); }
  upsertProvider(profile: ProviderProfile) { return this.providers.upsert(profile); }
  deleteProvider(providerId: string) { return this.providers.remove(providerId); }
  setDefaultProvider(providerId: string) { return this.providers.setDefault(providerId); }
  listProviderSecrets() { return this.providers.listSecrets(); }
  setProviderSecret(input: Parameters<ProviderService['setSecret']>[0]) { return this.providers.setSecret(input); }
  testProvider(providerId: string) { return this.providers.test(providerId); }

  listSchedules() { return this.schedules.list(); }
  getSchedule(scheduleId: string) { return this.schedules.get(scheduleId); }
  upsertSchedule(input: ScheduleUpsertInput) { return this.schedules.upsert(input); }
  deleteSchedule(scheduleId: string) { return this.schedules.remove(scheduleId); }
  pauseSchedule(scheduleId: string) { return this.schedules.pause(scheduleId); }
  resumeSchedule(scheduleId: string) { return this.schedules.resume(scheduleId); }

  listSkills() { return this.skills.list(); }
  getSkill(skillId: string) { return this.skills.get(skillId); }
  refreshSkills() { return this.skills.refresh(); }
  createSkill(input: SkillUpsertInput) { return this.skills.create(input); }
  updateSkill(skillId: string, input: SkillUpsertInput) { return this.skills.update(skillId, input); }
  deleteSkill(skillId: string) { return this.skills.remove(skillId); }
  duplicateSkill(skillId: string, input: SkillDuplicateInput) { return this.skills.duplicate(skillId, input); }
  importSkill(input: SkillImportInput) { return this.skills.importSkill(input); }
  importMarketplaceSkills(input: Parameters<SkillService['importMarketplace']>[0]) { return this.skills.importMarketplace(input); }
  invokeSkill(input: Parameters<SkillService['invoke']>[0]) { return this.skills.invoke(input); }
  listMcpServers() { return this.mcp.list(); }
  getMcpServer(serverId: string) { return this.mcp.get(serverId); }
  upsertMcpServer(input: Parameters<McpService['upsert']>[0]) { return this.mcp.upsert(input); }
  deleteMcpServer(serverId: string) { return this.mcp.remove(serverId); }
  testMcpServer(serverId: string) { return this.mcp.test(serverId); }

  getStatistics() { return this.statistics.getAggregate(); }
  getMetrics() { return this.statistics.getMetrics(); }
  getSystemStartup() { return this.system.getStartup(); }
  listImprovementProposals(): Promise<ImprovementProposal[]> { return this.improvements.listProposals(); }
  getImprovementProposal(proposalId: string): Promise<ImprovementProposal | null> { return this.improvements.getProposal(proposalId); }
  approveImprovementProposal(proposalId: string) { return this.improvements.approveProposal(proposalId); }
  rejectImprovementProposal(proposalId: string) { return this.improvements.rejectProposal(proposalId); }
  listRealTaskArchive(): Promise<RealTaskArchiveEntry[]> { return this.improvements.listArchive(); }
  getComplexTaskAcceptanceReport(): Promise<ComplexTaskAcceptanceReport> { return this.improvements.buildComplexTaskAcceptanceReport(); }
  async getCapabilityHub(): Promise<CapabilityHubView> {
    const workspace = await this.workspace.getView();
    return createCapabilityHubView({
      foundation: this.foundation,
      workspace
    });
  }
  async getEcosystemSummary(): Promise<EcosystemSummaryView> {
    const workspace = await this.workspace.getView();
    const capabilities = await createCapabilityHubView({
      foundation: this.foundation,
      workspace
    });
    const proposals = await this.improvements.listProposals();
    return createEcosystemSummaryView({
      foundation: this.foundation,
      capabilities,
      workspace,
      proposals
    });
  }
  async listToolCapabilities(): Promise<EcosystemSummaryView['tools']> {
    return (await this.getEcosystemSummary()).tools;
  }
  getWorkspaceWorkflow(): Promise<WorkspaceWorkflowView> { return this.workspace.getView(); }
  initWorkspaceWorkflow() { return this.workspace.initWorkspace(); }
  importWorkspaceDocs(): Promise<import('./types').PlatformActionResult<WorkspaceDocsImportSummary>> { return this.workspace.importDocs(); }

  async getAuditTrail(resourceType: Parameters<BackendNewFoundation['platformCommands']['listByResource']>[0], resourceId: string): Promise<PlatformAuditTrailView> {
    return {
      resourceType,
      resourceId,
      commands: await this.foundation.platformCommands.listByResource(resourceType, resourceId),
      audits: await this.foundation.platformAudits.listByResource(resourceType, resourceId)
    };
  }
}
