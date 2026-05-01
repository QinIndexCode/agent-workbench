import {
  ProviderCapabilityMetadata,
  ProviderImplementationStatus,
  ProviderPresetCategory,
  ProviderProfile
} from '../../foundation/providers/types';
import {
  PlatformActionType,
  PlatformAuditRecord,
  PlatformCommandRecord,
  PlatformChannelRecord,
  PlatformMemoryRecord,
  PlatformResourceType,
  PlatformScheduleRecord
} from '../../foundation/repository';
import { BackendNewConfigInput } from '../../foundation/config/types';
import {
  InstructionSkillAssetSummary,
  InstructionSkillSource,
  SkillDefinition,
  SkillKind
} from '../../foundation/extensions/types';
import { McpServerDefinition } from '../../foundation/extensions/types';
import { SkillRuntimeCapability } from '../../foundation/skills/types';
import { McpClientCapability } from '../../foundation/mcp/types';
import { WorkspaceDocsSourceDefinition } from './workspace-workflow-loader';

export type CapabilityKind =
  | 'provider'
  | 'mcp-server'
  | 'runtime-skill'
  | 'instruction-skill'
  | 'workspace-command'
  | 'workspace-agent';

export type CapabilityReadiness =
  | 'ready'
  | 'partial'
  | 'missing-secret'
  | 'missing-runtime'
  | 'missing-client'
  | 'metadata-only'
  | 'profile-only'
  | 'external-auth-required'
  | 'disabled';

export type CapabilityScope =
  | 'global'
  | 'workspace'
  | 'task-selected';

export type ProviderAuthSource =
  | 'none'
  | 'secret-store'
  | 'missing-secret';

export interface ProviderAdapter {
  providerId: string;
  transport: NonNullable<ProviderProfile['transport']>;
  vendor: NonNullable<ProviderProfile['vendor']>;
  baseUrl: string | null;
  timeoutMs: number | null;
}

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  label: string;
  reasoning: string | null;
  verbosity: string | null;
  thinkingBudget: number | null;
}

export interface ModelVariantDescriptor {
  providerId: string;
  variantId: string;
  label: string;
  isDefault: boolean;
  isSmallModel: boolean;
  taskPreference: string | null;
}

export interface CapabilityWarning {
  code:
    | 'provider-missing-secret'
    | 'provider-unavailable'
    | 'required-mcp-missing'
    | 'instruction-skill-dependency-missing'
    | 'runtime-skill-unavailable'
    | 'permission-denied'
    | 'hook-failed';
  capabilityKind: CapabilityKind;
  capabilityId: string;
  message: string;
  hardBlocker: boolean;
}

export interface ProviderSecretSummary {
  id: string;
  provider: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  hasValue: boolean;
  metadata: Record<string, unknown>;
}

export interface ProviderProfileView {
  profile: ProviderProfile;
  isDefault: boolean;
  isSavedDefault: boolean;
  isRuntimeDefault: boolean;
  hasRegisteredClient: boolean;
  hasSecret: boolean;
  readiness: CapabilityReadiness;
  authSource: ProviderAuthSource;
  implementationStatus: ProviderImplementationStatus;
  capabilities: ProviderCapabilityMetadata;
  adapter: ProviderAdapter;
  model: ModelDescriptor;
  variant: ModelVariantDescriptor;
}

export interface ProviderPresetView {
  id: string;
  label: string;
  vendor: NonNullable<ProviderProfile['vendor']>;
  transport: NonNullable<ProviderProfile['transport']>;
  baseUrl: string | null;
  defaultModel: string;
  requiresApiKey: boolean;
  supportsQuickAdd: boolean;
  category: ProviderPresetCategory;
  envVarNames: string[];
  requiredConfigFields: string[];
  implementationStatus: ProviderImplementationStatus;
  capabilities: ProviderCapabilityMetadata;
  notes: string | null;
}

export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  message: string;
  capability: Record<string, unknown>;
}

export interface ConfigStateView {
  current: Record<string, unknown>;
  savedDefaultProviderId: string | null;
  activeSnapshot: {
    version: string;
    fingerprint: string;
    createdAt: number;
  } | null;
  activeSnapshotVersion: string | null;
  reloadApplied: boolean;
  restartRequired: boolean;
  effectiveFingerprint: string;
}

export interface ConfigUpdateInput extends BackendNewConfigInput {}

export interface ConfigReloadResult {
  reloadApplied: boolean;
  restartRequired: boolean;
  activeSnapshotVersion: string | null;
}

export type SkillRegistrationSource =
  | 'CONFIG_ROOT'
  | 'IMPORT_MANIFEST';

export type SkillCatalogSource =
  | 'builtin'
  | 'config_root'
  | 'imported'
  | 'marketplace'
  | 'generated';

export interface SkillImportInput {
  id?: string;
  name?: string;
  rootDir?: string;
  description?: string;
  kind?: SkillKind;
  marketplaceFile?: string;
  pluginName?: string;
  skillPath?: string;
}

export interface SkillMarketplaceImportInput {
  marketplaceFile: string;
  pluginName: string;
  skillPath?: string;
}

export interface SkillManifestEntry {
  id?: string;
  name?: string;
  rootDir: string;
  description?: string;
  registrationSource: SkillRegistrationSource;
}

export interface SkillCatalogEntry {
  skill: SkillDefinition;
  runtimeRegistered: boolean;
  capability: SkillRuntimeCapability | null;
  kind: SkillKind;
  readiness: CapabilityReadiness;
  source: SkillCatalogSource;
  editable: boolean;
  deletable: boolean;
  duplicable: boolean;
  updatedAt: number | null;
  content: string | null;
  assetSummary: InstructionSkillAssetSummary | null;
  instructionSource: InstructionSkillSource | null;
  declaredDependencies: {
    mcpServers: string[];
  };
}

export interface SkillUpsertInput {
  id: string;
  name: string;
  description?: string;
  kind: SkillKind;
  content: string;
}

export interface SkillDuplicateInput {
  id?: string;
  name?: string;
}

export interface McpCatalogEntry {
  server: McpServerDefinition;
  clientRegistered: boolean;
  capability: McpClientCapability | null;
  readiness: CapabilityReadiness;
  declaredTools: string[];
  declaredResources: string[];
  declaredPrompts: string[];
  availableTools: string[];
  availableResources: string[];
  availablePrompts: string[];
  lastTestSummary: {
    ok: boolean;
    message: string;
  } | null;
}

export interface McpTestResult {
  ok: boolean;
  serverId: string;
  message: string;
  capability: McpClientCapability | null;
}

export interface PlatformStatisticsView {
  taskCounts: Record<string, number>;
  queue: {
    active: number;
    deadLetters: number;
  };
  providers: number;
  skills: number;
  channels: number;
  schedules: number;
  memories: number;
}

export interface PlatformSystemView {
  server: {
    host: string;
    port: number;
    websocketPath: string;
    sseFallback: boolean;
  };
  storage: {
    driver: string;
    rootDir: string;
  };
  database: {
    enabled: boolean;
    healthy: boolean | null;
    schema: string;
  };
  queue: {
    enabled: boolean;
    workerEnabled: boolean;
  };
  registries: {
    providers: number;
    skills: number;
    mcpServers: number;
    tools: number;
  };
}

export interface PlatformMetricsView {
  promptCompression: {
    averageReductionRatio: number;
    tasksWithBudget: number;
  };
  runtime: {
    activeTasks: number;
    pausedTasks: number;
    failedTasks: number;
    completedTasks: number;
  };
}

export type ChannelUpsertInput = Omit<PlatformChannelRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
};

export type ScheduleUpsertInput = Omit<PlatformScheduleRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
};

export type MemoryUpsertInput = Omit<PlatformMemoryRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
};

export interface PlatformActionResult<T> {
  resourceType: PlatformResourceType;
  resourceId: string;
  action: PlatformActionType;
  commandId: string;
  auditId: string;
  appliedAt: number;
  resource: T;
}

export interface PlatformAuditTrailView {
  resourceType: PlatformResourceType;
  resourceId: string;
  commands: PlatformCommandRecord[];
  audits: PlatformAuditRecord[];
}

export type ImprovementProposalKind =
  | 'lesson'
  | 'experience'
  | 'instruction_skill'
  | 'optimization';

export type ImprovementProposalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED';

export type OptimizationRecommendationCategory =
  | 'prompt_contract'
  | 'approval_boundary'
  | 'memory_layer'
  | 'benchmark_candidate';

export interface ExperienceReport {
  reportId: string;
  taskId: string;
  lifecycleStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  summary: string;
  outcome: 'success' | 'failed' | 'cancelled';
  artifactQuality: 'delivered' | 'artifact_only' | 'none';
  truthCompleteness: 'complete' | 'partial';
  failureTaxonomy: string[];
  keyFacts: string[];
  createdAt: number;
  complexitySignals: string[];
}

export interface LessonProposalPayload {
  title: string;
  lessonSummary: string;
  triggerPattern: string;
  recommendedUseScope: string;
  confidence: number;
}

export interface InstructionSkillProposalPayload {
  title: string;
  applicableScenarios: string[];
  inputBoundaries: string[];
  prohibitions: string[];
  validationSummary: string;
  confidence: number;
  draftSkillMarkdown: string;
  materializedRootDir: string | null;
  importedSkillId: string | null;
}

export interface ExperienceProposalPayload {
  title: string;
  referenceSummary: string;
  applicableScenarios: string[];
  limitations: string[];
  confidence: number;
  draftExperienceMarkdown: string;
  materializedPath: string | null;
  validationStatus: 'monitoring' | 'promotable' | 'conflicted';
  successfulReuseTaskIds: string[];
  failedReuseTaskIds: string[];
  lastValidatedAt: number | null;
}

export interface ApprovedExperienceRecord {
  proposalId: string;
  patternKey: string;
  title: string;
  materializedPath: string;
  referenceSummary: string;
  applicableScenarios: string[];
  limitations: string[];
  confidence: number;
  validationStatus: 'monitoring' | 'promotable' | 'conflicted';
  successfulReuseTaskIds: string[];
  failedReuseTaskIds: string[];
  lastValidatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface OptimizationRecommendationPayload {
  title: string;
  summary: string;
  category: OptimizationRecommendationCategory;
  confidence: number;
}

export interface ImprovementProposal {
  proposalId: string;
  kind: ImprovementProposalKind;
  status: ImprovementProposalStatus;
  taskId: string;
  title: string;
  summary: string;
  evidenceTaskIds: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  patternKey: string;
  dedupeKey: string;
  qualityScore: number;
  archiveEligible: boolean;
  duplicateOfProposalId: string | null;
  conflictsWithProposalIds: string[];
  supersededByProposalId: string | null;
  experienceReport: ExperienceReport;
  lessonProposal: LessonProposalPayload | null;
  experienceProposal: ExperienceProposalPayload | null;
  instructionSkillProposal: InstructionSkillProposalPayload | null;
  optimizationRecommendation: OptimizationRecommendationPayload | null;
  metadata: Record<string, unknown>;
}

export interface RealTaskArchiveStatus {
  archived: boolean;
  eligible: boolean;
  reason: string;
  archiveEntryId: string | null;
  complexitySignals: string[];
  lastArchivedAt: number | null;
}

export interface RealTaskArchiveEntry {
  archiveEntryId: string;
  taskId: string;
  taskTitle: string;
  taskIntent: string;
  lifecycleStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  archivedAt: number;
  complexitySignals: string[];
  archiveEligibility: {
    eligible: boolean;
    reason: string;
    complexitySignals: string[];
  };
  qualityScore: number;
  patternKey: string;
  truthSummary: {
    statusSummary: string;
    primaryAction: string;
    nextAction: string;
    completionSummary: string | null;
    truthCompleteness: 'complete' | 'partial';
  };
  finalDelivery: {
    summary: string | null;
    deliveredTo: string[];
    destinationDir: string | null;
  };
  artifactPaths: string[];
  blockerSummary: string | null;
  proposalIds: string[];
  experienceReport: ExperienceReport;
  metadata: Record<string, unknown>;
}

export interface ComplexTaskAcceptanceReport {
  generatedAt: number;
  curatedSuite: {
    total: number;
    passed: number;
    failed: number;
  };
  archive: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    delivered: number;
    artifactOnly: number;
    proposalGenerated: number;
  };
  archiveEligibleCount: number;
  archiveSkippedCount: number;
  skipReasons: Array<{
    reason: string;
    count: number;
  }>;
  duplicateProposalCount: number;
  conflictedProposalCount: number;
  supersededProposalCount: number;
  lessonMemoryCount: number;
  generatedExperienceCount: number;
  generatedInstructionSkillCount: number;
  failureTaxonomy: Array<{
    category: string;
    count: number;
  }>;
  truthCompleteness: {
    complete: number;
    partial: number;
  };
  proposalGenerationQuality: {
    lesson: number;
    experience: number;
    instructionSkill: number;
    optimization: number;
  };
}

export interface ImprovementProposalAuditView {
  generatedAt: number;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  byKind: Record<ImprovementProposalKind, number>;
}

export interface WorkspaceCommandView {
  name: string;
  description: string | null;
  args: string | null;
  when: string | null;
  template?: string;
}

export interface WorkspaceRuleView {
  name: string;
  summary: string | null;
  paths: string[];
}

export interface WorkspaceHookView {
  event: string;
  command: string;
  description: string | null;
  timeoutMs: number | null;
}

export interface WorkspaceAgentView {
  name: string;
  description: string | null;
}

export interface WorkspaceDocsImportSummary {
  trackedSourceCount: number;
  importedMemoryCount: number;
  imported: number;
  updated: number;
  skipped: number;
  importedMemoryIds: string[];
  lastImportedAt: number | null;
}

export interface WorkspaceWorkflowView {
  workspaceRoot: string | null;
  sccDir: string | null;
  projectInstructionsPresent: boolean;
  projectInstructionsSummary: string | null;
  commands: WorkspaceCommandView[];
  rules: WorkspaceRuleView[];
  hooks: WorkspaceHookView[];
  agents: WorkspaceAgentView[];
  docsSources: WorkspaceDocsSourceDefinition[];
  docsImportSummary: WorkspaceDocsImportSummary;
  ruleSummary?: {
    total: number;
    pathScoped: number;
    alwaysOn: number;
  };
  hookSummary?: {
    total: number;
    events: string[];
  };
  agentSummary?: {
    total: number;
    names: string[];
  };
}

export interface CapabilityHubEntry {
  id: string;
  kind: CapabilityKind;
  scope: CapabilityScope;
  name: string;
  readiness: CapabilityReadiness;
  detail: string;
}

export interface CapabilityHubView {
  summary: {
    total: number;
    ready: number;
    partial: number;
    blocked: number;
  };
  providers: ProviderProfileView[];
  mcpServers: McpCatalogEntry[];
  skills: SkillCatalogEntry[];
  workspace: {
    commands: WorkspaceCommandView[];
    agents: WorkspaceAgentView[];
    rules: WorkspaceRuleView[];
    hooks: WorkspaceHookView[];
  };
  entries: CapabilityHubEntry[];
  warnings: CapabilityWarning[];
}

export type EcosystemReadiness =
  | 'ready'
  | 'partial'
  | 'blocked'
  | 'quiet';

export interface ToolCapabilityEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  effect: string;
  riskLevel: string;
  inputSchemaSummary: string[];
  evidenceShape: string;
  failureTaxonomy: string[];
  acceptanceEvidence: boolean;
  executorRegistered: boolean;
  capability: {
    supportsApprovalResume: boolean;
    supportsDryRun: boolean;
    supportsStreaming: boolean;
    maxExecutionMs: number | null;
  } | null;
  readiness: EcosystemReadiness;
  visibleByDefault: boolean;
  healthCheck: {
    status: EcosystemReadiness;
    checks: string[];
    diagnostics: string[];
  };
}

export interface ScenarioPackSummary {
  id: string;
  label: string;
  focus: string;
  qualityProfileId: string | null;
  qualityGateId?: string | null;
  artifactAudit: string;
  surfaceChecks: string[];
  cleanupHints: string[];
  modelPolicy: {
    defaultModelClass: 'fast' | 'strong' | 'provider-default';
    reason: string;
  };
  timeoutPolicy: {
    maxTurns: number;
    maxIdleCorrections: number;
    maxRuntimeMs: number;
  };
  status: EcosystemReadiness;
}

export interface ExperienceHealthSummary {
  approved: number;
  monitoring: number;
  promotable: number;
  conflicted: number;
  selectedReusableTaskIds: string[];
  failedReuseTaskIds: string[];
  lastValidatedAt: number | null;
  approvedDetails: Array<{
    proposalId: string;
    title: string;
    patternKey: string;
    materializedPath: string | null;
    validationStatus: 'monitoring' | 'promotable' | 'conflicted';
    successfulReuseTaskIds: string[];
    failedReuseTaskIds: string[];
    limitations: string[];
    confidence: number;
  }>;
}

export interface EcosystemSummaryView {
  generatedAt: number;
  summary: {
    providers: number;
    readyProviders: number;
    mcpServers: number;
    readyMcpServers: number;
    skills: number;
    instructionSkills: number;
    tools: number;
    acceptanceEvidenceTools: number;
    scenarioPacks: number;
    workspaceCommands: number;
    warnings: number;
  };
  providers: ProviderProfileView[];
  mcpServers: McpCatalogEntry[];
  skills: SkillCatalogEntry[];
  experiences: ExperienceHealthSummary;
  tools: ToolCapabilityEntry[];
  workspaceCommands: WorkspaceCommandView[];
  scenarioPacks: ScenarioPackSummary[];
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'blocker';
    capabilityId?: string;
  }>;
}
