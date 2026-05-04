export type TaskLifecycleStatus =
  | 'SUBMITTED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type TaskPathPolicy = 'task_workspace' | 'project_relative' | 'ask_if_unclear';

export type TaskExecutionIssuePlane =
  | 'core'
  | 'ecosystem'
  | 'ui'
  | 'provider'
  | 'external_blocker';

export interface TaskExecutionSuggestedAction {
  type: string;
  label: string;
  reason: string;
  command: string | null;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  intent: string;
  lifecycleStatus: TaskLifecycleStatus;
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  currentUnitId: string | null;
  updatedAt: number;
  queueState: string | null;
  pendingApprovalCount: number;
  lastError: string | null;
  isDelegatedChild: boolean;
}

export interface AgentUnit {
  id: string;
  role: string;
  goal: string;
  profile?: string;
  dependencies: string[];
  outputContract?: string;
  exitCondition?: string;
  executionProfileId?: string;
  delegationRequired?: boolean;
  delegationContract?: {
    title?: string;
    role?: string;
    goal?: string;
    taskScope?: string;
    outputContract?: string;
    allowedToolIds?: string[];
    successCriteria?: string;
  };
}

export interface QueueItem {
  state: string;
  leaseId?: string | null;
  leaseOwner?: string | null;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
}

export interface ConversationMessage {
  messageId: string;
  role: 'system' | 'user' | 'assistant' | 'runtime';
  content: string;
  createdAt: number;
  visibility?: 'public' | 'internal';
  metadata?: {
    source?: string | null;
    displayKind?: string | null;
    actor?: string | null;
    unitId?: string | null;
    turnId?: string | null;
  } | null;
}

export interface OperatorMessage {
  messageId: string;
  commandId: string;
  content: string;
  createdAt: number;
  metadata?: {
    actor?: string | null;
  } | null;
}

export interface TaskGuidanceRecord {
  guidanceId: string;
  taskId: string;
  content: string;
  status: 'PENDING' | 'CONSUMED' | 'REJECTED';
  createdAt: number;
  consumedAt: number | null;
  actor: string | null;
  metadata: Record<string, unknown>;
}

export interface ToolApproval {
  invocationId: string;
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: number;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PendingApprovalItem {
  invocationId: string;
  toolId: string;
  toolName: string;
  requestedAt: number;
  argumentsSummary: string | null;
  riskCategory?: string | null;
  reason?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  availableActions: Array<'APPROVED' | 'APPROVED_ONCE' | 'REJECTED'>;
}

export interface ToolInvocation {
  invocationId: string;
  toolId: string;
  toolName?: string;
  status: string;
  unitId: string;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  metadata?: Record<string, unknown>;
}

export interface VisibleToolActivity {
  activityId: string;
  toolId: string;
  status: string;
  summary: string;
  detail: string | null;
  argumentsSummary: string | null;
  resultSummary: string | null;
  execution: {
    command: string | null;
    effectiveCommand: string | null;
    cwd: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number | null;
    timedOut: boolean | null;
    shell: string | null;
  } | null;
  evidencePaths: string[];
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | null;
  startedAt: number;
  endedAt: number | null;
  unitId: string;
}

export interface RuntimeEvent {
  eventId: string;
  taskId: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface OperatorCommand {
  commandId: string;
  type: string;
  status: string;
  actor?: string | null;
  reason?: string | null;
  message?: string | null;
  invocationId?: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderFailure {
  message: string;
  kind: string | null;
  category: string | null;
  statusCode: number | null;
  retryable: boolean | null;
  providerId: string | null;
}

export interface TaskDetail {
  definition: {
    taskId: string;
    title: string;
    intent: string;
    units: AgentUnit[];
    preferredProviderId?: string | null;
    metadata?: {
      pathPolicy?: TaskPathPolicy;
      preferredArtifactDir?: string | null;
    } | null;
  };
  runtime: {
    lifecycleStatus: TaskLifecycleStatus;
    updatedAt?: number | null;
    engineStatus?: string;
    currentUnitId: string | null;
    executionLease?: {
      phase: string;
      active: boolean;
    } | null;
    planner?: {
      blockingReason: string | null;
    } | null;
  };
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  projection?: Record<string, unknown> | null;
  queue: QueueItem | null;
  conversations: ConversationMessage[];
  latestVisibleOutput: TaskVisibleOutputSummary | null;
  statusSummary: TaskStatusSummary;
  primaryAction: TaskPrimaryActionSummary;
  nextActionSummary: TaskNextActionSummary;
  completionSummary: TaskCompletionSummary | null;
  delegationSummary: TaskDelegationSummary;
  improvementProposals: ImprovementProposal[];
  realTaskArchiveStatus: RealTaskArchiveStatus;
  commands: OperatorCommand[];
  operatorMessages: OperatorMessage[];
  pendingGuidance: TaskGuidanceRecord[];
  interrupts?: Array<Record<string, unknown>>;
  pendingApprovals: ToolApproval[];
  pendingApprovalItems: PendingApprovalItem[];
  toolInvocations: ToolInvocation[];
  visibleToolActivities: VisibleToolActivity[];
  events: RuntimeEvent[];
  diagnostics: {
    lastError: string | null;
    providerFailure: ProviderFailure | null;
  };
}

export interface TaskVisibleOutputSummary {
  source: 'validated_output' | 'assistant_fallback' | 'failure_fallback';
  unitId: string | null;
  validatedAt: number | null;
  summary: string;
  details: string | null;
  issues: string[];
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: 'APPLIED' | 'CONFLICT' | 'FAILED' | null;
}

export type TaskPrimaryActionKind =
  | 'approve'
  | 'reject'
  | 'use_recommended_path'
  | 'choose_custom_path'
  | 'continue_thread'
  | 'send_guidance'
  | 'start_task'
  | 'resume_task'
  | 'wait';

export interface TaskPrimaryActionSummary {
  kind: TaskPrimaryActionKind;
  label: string;
  description: string;
  destinationDir: string | null;
}

export type TaskStatusSummaryTone =
  | 'running'
  | 'waiting'
  | 'action_required'
  | 'blocked'
  | 'completed';

export interface TaskStatusSummary {
  label: string;
  detail: string;
  tone: TaskStatusSummaryTone;
}

export interface TaskNextActionSummary {
  label: string;
  reason: string;
}

export interface TaskCompletionSummary {
  summary: string | null;
  details: string | null;
  issues: string[];
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  artifactApplyStatus: 'APPLIED' | 'CONFLICT' | 'FAILED' | null;
  continueAllowed: boolean;
}

export interface TaskDelegatedChildSummary {
  taskId: string;
  title: string;
  lifecycleStatus: TaskLifecycleStatus;
  summary: string | null;
  updatedAt: number;
  goal: string | null;
}

export interface TaskDelegationSummary {
  depth: number;
  delegationEnabled: boolean;
  canDelegate: boolean;
  required: boolean;
  missingRequiredDelegation: boolean;
  reason: string;
  activeChildTask: TaskDelegatedChildSummary | null;
  recentChildren: TaskDelegatedChildSummary[];
}

export type TaskAcceptanceLayerVerdict = 'passed' | 'failed' | 'not_applicable';
export type TaskAcceptanceDeterministicVerdict = 'passed' | 'failed';
export type TaskAcceptanceSemanticReviewStatus =
  | 'not_requested'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'unavailable';

export interface TaskAcceptanceLayer {
  verdict: TaskAcceptanceLayerVerdict;
  summary: string;
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
}

export interface TaskAcceptanceDeterministicSummary {
  verdict: TaskAcceptanceDeterministicVerdict;
  profileId: 'analyze' | 'implement' | 'verify';
  unitId: string | null;
  contract: TaskAcceptanceLayer;
  execution: TaskAcceptanceLayer;
  evidence: TaskAcceptanceLayer;
  outcome: TaskAcceptanceLayer;
}

export interface TaskAcceptanceEvidence {
  explicitOutput: {
    present: boolean;
    source: 'validated_output' | 'assistant_fallback' | 'failure_fallback' | 'missing';
    contractKeys: string[];
    missingContractKeys: string[];
    invalidJson: boolean;
    summary: string;
  };
  progressTracker: {
    present: boolean;
    status: string | null;
    decision: string | null;
    issues: string[];
    summary: string;
  };
  toolEvidence: {
    required: boolean;
    satisfied: boolean;
    invocationCount: number;
    successfulCount: number;
    verificationCount: number;
    pendingApprovalCount: number;
    toolIds: string[];
    summary: string;
  };
  artifactEvidence: {
    required: boolean;
    satisfied: boolean;
    artifactPathState: 'unresolved' | 'sandbox_only' | 'ready_to_apply' | 'applied';
    artifactPaths: string[];
    summary: string;
  };
  deliveryEvidence: {
    required: boolean;
    delivered: boolean;
    artifactDestinationDir: string | null;
    artifactDestinationPaths: string[];
    summary: string;
  };
  groundingEvidence: {
    required: boolean;
    satisfied: boolean;
    referenceCount: number;
    pathReferences: string[];
    taskIdReferences: string[];
    eventTypeReferences: string[];
    artifactReferences: string[];
    summary: string;
  };
}

export interface TaskAcceptanceSemanticReview {
  status: TaskAcceptanceSemanticReviewStatus;
  verdict: 'passed' | 'failed' | null;
  providerId: string | null;
  modelId: string | null;
  reviewedAt: number | null;
  confidence: number | null;
  summary: string | null;
  mismatches: string[];
  missingEvidence: string[];
  error: string | null;
}

export interface TaskAcceptanceSummary {
  deterministic: TaskAcceptanceDeterministicSummary;
  evidence: TaskAcceptanceEvidence;
  semanticReview: TaskAcceptanceSemanticReview;
}

export interface TaskExecutionSummary {
  issuePlane: TaskExecutionIssuePlane | null;
  issueCategory: string | null;
  issueSummary: string | null;
  suggestedAction: TaskExecutionSuggestedAction;
  workingDirectory: {
    status: 'explicit' | 'default' | 'missing';
    workingDirectory: string | null;
    source: 'operator' | 'runtime_default' | 'metadata' | 'missing';
    requiresSelection: boolean;
    guidance: string;
  };
  providerSummary: {
    providerId: string | null;
    modelId: string | null;
    variantId: string | null;
    recentStatus: string | null;
    lastMessage: string | null;
  };
  permissionSummary: {
    mode: 'full' | 'read-only' | 'ask';
    approvalRequiredCount: number;
    deniedCount: number;
  };
  artifactPathState: 'unresolved' | 'sandbox_only' | 'ready_to_apply' | 'applied';
  pendingArtifactCount: number;
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  lastArtifactApplyAt: number | null;
  lastArtifactApplyResult: {
    status: 'APPLIED' | 'CONFLICT' | 'FAILED';
    destinationDir?: string | null;
    appliedCount?: number;
    conflictCount?: number;
    failedCount?: number;
  } | null;
  capabilityWarnings: Array<{
    code?: string;
    message?: string;
  }>;
  recovery: {
    recoveredAfterRestart: boolean;
    recoveryReason: string | null;
  };
  turnContract: {
    continueAllowed: boolean;
    continueReason: string;
    conservativeMode: boolean;
  };
  acceptance: TaskAcceptanceSummary;
  experienceSummary: {
    configuredCount: number;
    selectedCount: number;
    selected: Array<{
      proposalId: string;
      title: string;
      selectedBy: 'metadata' | 'heuristic';
      materializedPath: string;
      referenceSummary: string;
      limitations: string[];
      validationStatus: 'monitoring' | 'promotable' | 'conflicted';
    }>;
    validationCandidates: Array<{
      proposalId: string;
      validationStatus: 'monitoring' | 'promotable' | 'conflicted';
      successfulReuseTaskIds: string[];
      failedReuseTaskIds: string[];
    }>;
  };
}

export interface TaskDebugResponse {
  task: TaskDetail;
  metadata: unknown;
  runtimeRecord: unknown;
  queue: QueueItem | null;
  executionSummary: TaskExecutionSummary;
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

export interface ExperienceReport {
  reportId: string;
  taskId: string;
  lifecycleStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  summary: string;
  outcome: 'success' | 'failed' | 'cancelled';
  artifactEvidence: 'delivered' | 'artifact_only' | 'none';
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

export interface ExperienceRecord {
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

export interface ExperienceUpsertPayload {
  proposalId?: string;
  patternKey?: string;
  title: string;
  referenceSummary: string;
  applicableScenarios?: string[];
  limitations?: string[];
  confidence?: number;
  validationStatus?: 'monitoring' | 'promotable' | 'conflicted';
  successfulReuseTaskIds?: string[];
  failedReuseTaskIds?: string[];
  lastValidatedAt?: number | null;
  draftExperienceMarkdown?: string;
}

export interface GovernanceExportBundle<TRecord> {
  generatedAt: number;
  format: 'json' | 'markdown';
  records: TRecord[];
  content: string;
}

export interface BulkDeleteResult {
  requestedIds: string[];
  deletedIds: string[];
  failed: Array<{
    id: string;
    error: string;
  }>;
}

export interface OptimizationRecommendationPayload {
  title: string;
  summary: string;
  category: 'prompt_contract' | 'approval_boundary' | 'memory_layer' | 'benchmark_candidate';
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
  reviewScore: number;
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
  reviewScore: number;
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
  proposalGenerationEvidence: {
    lesson: number;
    experience: number;
    instructionSkill: number;
    optimization: number;
  };
}

export interface SubmitTaskPayload {
  title: string;
  intent: string;
  units: AgentUnit[];
  preferredProviderId?: string | null;
  pathPolicy?: TaskPathPolicy;
  preferredArtifactDir?: string | null;
  workingDirectory?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskCommandPayload {
  type: string;
  actor?: string | null;
  reason?: string | null;
  message?: string | null;
  invocationId?: string | null;
  approvalStatus?: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  metadata?: Record<string, unknown>;
}

export interface TaskActionOptions {
  autoRun?: boolean;
  maxTurns?: number;
}

export interface TaskActionResponse {
  command: {
    taskId: string;
    status: string;
    message?: string | null;
  };
  task: TaskDetail;
  commandMetadata?: Record<string, unknown>;
}

export type ProviderTransport =
  | 'openai-compatible'
  | 'deepseek-compatible'
  | 'anthropic-compatible'
  | 'native-cohere'
  | 'native-ai21'
  | 'native-replicate'
  | 'native-perplexity-agent'
  | 'enterprise-cloud'
  | 'profile-only'
  | 'local-stdio';

export type ProviderVendor =
  | 'ai21'
  | 'openai'
  | 'chatgpt'
  | 'anthropic'
  | 'aws_bedrock_openai'
  | 'azure_openai'
  | 'cerebras'
  | 'cloudflare_ai_gateway'
  | 'cloudflare_workers_ai'
  | 'cohere'
  | 'dashscope_cn'
  | 'dashscope_intl'
  | 'dashscope_us'
  | 'deepinfra'
  | 'deepseek'
  | 'fireworks'
  | 'gemini'
  | 'google_gemini'
  | 'glm'
  | 'grok'
  | 'groq'
  | 'heroku_inference'
  | 'huggingface'
  | 'hyperbolic'
  | 'ibm_watsonx_gateway'
  | 'kimi'
  | 'llama'
  | 'llama_api'
  | 'llama_cpp'
  | 'lmstudio'
  | 'localai'
  | 'meta'
  | 'minimax'
  | 'minimax_cn'
  | 'mistral'
  | 'moonshot'
  | 'novita'
  | 'nvidia_nim'
  | 'ollama'
  | 'openrouter'
  | 'perplexity'
  | 'perplexity_agent'
  | 'qianfan'
  | 'replicate'
  | 'sambanova'
  | 'siliconflow'
  | 'siliconflow_cn'
  | 'stepfun_cn'
  | 'stepfun_global'
  | 'stepfun_plan'
  | 'tencent_hunyuan'
  | 'together'
  | 'vertex_ai_openai'
  | 'vercel_ai_gateway'
  | 'vllm'
  | 'volcengine_ark'
  | 'xai'
  | 'zhipu'
  | 'zhipu_coding'
  | 'custom';

export type ProviderPresetCategory = 'api-key' | 'enterprise-cloud' | 'local';
export type ProviderImplementationStatus = 'runnable' | 'profile-only' | 'external-auth-required';
export type ProviderModality = 'text' | 'image' | 'audio' | 'file';

export interface ProviderCapabilityMetadata {
  inputModalities: ProviderModality[];
  outputModalities: ProviderModality[];
  supportsVision: boolean;
  supportsFiles: boolean;
  supportedFileExtensions: string[];
}

export interface ProviderProfile {
  id: string;
  label: string;
  transport?: ProviderTransport;
  vendor?: ProviderVendor;
  baseUrl?: string;
  model: string;
  apiKeySecretId?: string;
  headers?: Record<string, string>;
  auth?: {
    scheme: 'bearer' | 'x-api-key' | 'none';
    headerName?: string;
    prefix?: string;
  };
  endpoints?: {
    chatCompletionsPath?: string;
    messagesPath?: string;
  };
  apiVersion?: string | null;
  organization?: string | null;
  project?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderPresetView {
  id: string;
  label: string;
  vendor: ProviderVendor;
  transport: ProviderTransport;
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

export interface ProviderProfileView {
  profile: ProviderProfile;
  isDefault: boolean;
  isSavedDefault: boolean;
  isRuntimeDefault: boolean;
  hasRegisteredClient: boolean;
  hasSecret: boolean;
  readiness: string;
  authSource: string;
  implementationStatus: ProviderImplementationStatus;
  capabilities: ProviderCapabilityMetadata;
  adapter: {
    providerId: string;
    transport: ProviderTransport;
    vendor: ProviderVendor;
    baseUrl: string | null;
    timeoutMs: number | null;
  };
  model: {
    providerId: string;
    modelId: string;
    label: string;
    reasoning: string | null;
    verbosity: string | null;
    thinkingBudget: number | null;
  };
  variant: {
    providerId: string;
    variantId: string;
    label: string;
    isDefault: boolean;
    isSmallModel: boolean;
    taskPreference: string | null;
  };
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

export interface PlatformConfigHealth {
  ok: boolean;
  storageDriver?: string;
  databaseHealthy?: boolean | null;
  queueEnabled?: boolean;
  workerEnabled?: boolean;
  providers?: number;
  skills?: number;
  channels?: number;
  schedules?: number;
  memories?: number;
  issues?: Array<{
    code?: string;
    message?: string;
  }>;
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

export interface WorkspaceWorkflowView {
  workspaceRoot: string | null;
  sccDir: string | null;
  projectInstructionsPresent: boolean;
  projectInstructionsSummary: string | null;
  commands: Array<{
    name: string;
    description: string | null;
    args: string | null;
    when: string | null;
    template?: string;
  }>;
  rules: Array<{
    name: string;
    summary: string | null;
    paths: string[];
  }>;
  hooks: Array<{
    event: string;
    command: string;
    description: string | null;
    timeoutMs: number | null;
  }>;
  agents: Array<{
    name: string;
    description: string | null;
  }>;
  docsSources: Array<{
    path: string;
    title?: string;
    tags: string[];
  }>;
  docsImportSummary: {
    trackedSourceCount: number;
    importedMemoryCount: number;
    imported: number;
    updated: number;
    skipped: number;
    importedMemoryIds: string[];
    lastImportedAt: number | null;
  };
}

export interface WorkspaceDirectoryListing {
  workspaceRoot: string;
  currentPath: string;
  relativePath: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    absolutePath: string;
  }>;
}

export interface CapabilityHubView {
  warnings: Array<{
    code?: string;
    message?: string;
  }>;
}

export type EcosystemReadiness = 'ready' | 'partial' | 'blocked' | 'quiet';

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

export interface ScriptCatalogEntry {
  id: string;
  label: string;
  description: string;
  commandTemplate: string;
  defaultCwd: string | null;
  riskCategory: string;
  outputHint: string;
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
    scriptCatalogEntries: number;
    workspaceCommands: number;
    warnings: number;
  };
  providers: ProviderProfileView[];
  mcpServers: McpCatalogEntry[];
  skills: SkillCatalogEntry[];
  experiences: ExperienceHealthSummary;
  tools: ToolCapabilityEntry[];
  workspaceCommands: WorkspaceWorkflowView['commands'];
  scriptCatalog: ScriptCatalogEntry[];
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'blocker';
    capabilityId?: string;
  }>;
}

export interface SkillCatalogEntry {
  skill: {
    id: string;
    name: string;
    rootDir: string;
    description?: string;
    kind?: 'runtime-skill' | 'instruction-skill';
    registrationSource?: string;
    metadata?: Record<string, unknown>;
  };
  runtimeRegistered: boolean;
  capability: Record<string, unknown> | null;
  kind: 'runtime-skill' | 'instruction-skill';
  readiness: string;
  source: 'builtin' | 'config_root' | 'imported' | 'marketplace' | 'generated';
  editable: boolean;
  deletable: boolean;
  duplicable: boolean;
  updatedAt: number | null;
  content: string | null;
  assetSummary: {
    totalFiles: number;
    markdownFiles: number;
    scriptFiles: number;
    templateFiles: number;
    assetFiles: number;
    samplePaths: string[];
  } | null;
  instructionSource: {
    format: 'claude-style-skill';
    skillFile: string;
    marketplaceFile?: string | null;
    pluginName?: string | null;
  } | null;
  declaredDependencies: {
    mcpServers: string[];
  };
}

export interface McpCatalogEntry {
  server: {
    id: string;
    name: string;
    transport: 'stdio' | 'http' | 'ws';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    declaredTools?: string[];
    declaredResources?: string[];
    declaredPrompts?: string[];
    metadata?: Record<string, unknown>;
  };
  clientRegistered: boolean;
  capability: Record<string, unknown> | null;
  readiness: string;
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
  capability: Record<string, unknown> | null;
}

export interface PlatformActionResult<T> {
  resourceType: string;
  resourceId: string;
  action: string;
  commandId: string;
  auditId: string;
  appliedAt: number;
  resource: T;
}
