import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);

export const RiskCategorySchema = z.enum([
  "host_observation",
  "workspace_read",
  "workspace_write",
  "shell",
  "network",
  "destructive"
]);

export const ApprovalDecisionSchema = z.enum(["allow_once", "allow_for_task", "allow_globally", "deny"]);

export const ToolCallSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown())
});

export const ToolResultSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  createdAt: z.string()
});

export const McpTransportKindSchema = z.enum(["stdio", "streamable_http"]);

export const McpServerConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  transport: McpTransportKindSchema,
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  url: z.string().optional(),
  enabled: z.boolean().default(true),
  toolRiskOverrides: z.record(RiskCategorySchema).default({}),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const McpServerStatusSchema = z.object({
  serverId: z.string(),
  connected: z.boolean(),
  state: z.enum(["disconnected", "connecting", "connected", "error"]),
  lastError: z.string().optional(),
  connectedAt: z.string().optional(),
  toolCount: z.number().int().nonnegative()
});

export const McpToolSummarySchema = z.object({
  id: z.string(),
  serverId: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).default({}),
  riskCategory: RiskCategorySchema
});

export const McpToolCallResultSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  ok: z.boolean(),
  output: z.string(),
  isError: z.boolean().optional()
});

export const ToolApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  toolCall: ToolCallSchema,
  riskCategory: RiskCategorySchema,
  reason: z.string(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(["pending", "approved", "denied"]),
  decision: ApprovalDecisionSchema.optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional()
});

export const TaskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.enum([
    "task_created",
    "user_message",
    "attachment_added",
    "attachment_removed",
    "assistant_delta",
    "assistant_message",
    "thinking_delta",
    "guidance_pending",
    "guidance_consumed",
    "tool_requested",
    "approval_pending",
    "approval_resolved",
    "approval_auto_granted",
    "tool_result",
    "status_changed",
    "task_memory_created",
    "conversation_summary_created",
    "context_overflow_recovered",
    "provider_fallback",
    "turn_started",
    "turn_reverted",
    "turn_edit_submitted",
    "event_reverted",
    "rollback_partial",
    "task_checkpoint_created",
    "task_rollback_completed",
    "task_rollback_failed",
    "task_graph_created",
    "task_graph_node_started",
    "verification_result_recorded",
    "prompt_cache_stats",
    "plan_created",
    "plan_step_started",
    "plan_step_completed",
    "plan_step_blocked",
    "plan_revised",
    "web_search_result",
    "knowledge_indexed",
    "integration_message_received",
    "scheduled_task_created",
    "pattern_discovered",
    "reflection_started",
    "reflection_completed",
    "skill_loaded",
    "skill_promoted"
  ]),
  createdAt: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()).default({}),
  reverted: z.boolean().optional()
});

export const TaskTranscriptItemSchema = TaskEventSchema;

export const TaskTurnSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  startEventId: z.string(),
  userEventId: z.string(),
  endEventId: z.string().optional(),
  originalContent: z.string(),
  editedContent: z.string().optional(),
  status: z.enum(["active", "reverted"]).default("active"),
  createdAt: z.string(),
  updatedAt: z.string(),
  revertedAt: z.string().optional()
});

export const TaskTurnRevertResultSchema = z.object({
  task: z.lazy(() => TaskDetailSchema),
  turn: TaskTurnSchema,
  draft: z.string(),
  revertedEventCount: z.number().int().nonnegative(),
  irreversibleEventCount: z.number().int().nonnegative(),
  rollback: z.lazy(() => TaskRollbackResultSchema).optional()
});

export const TaskTurnEditRequestSchema = z
  .object({
    content: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).default([])
  })
  .strict();

export const TaskAttachmentKindSchema = z.enum(["text", "markdown", "code", "data", "image", "pdf", "office", "binary"]);

export const TaskAttachmentSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string().default("application/octet-stream"),
  size: z.number().int().nonnegative(),
  kind: TaskAttachmentKindSchema,
  storagePath: z.string(),
  contentHash: z.string(),
  textPreview: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TaskAttachmentUploadRequestSchema = z
  .object({
    fileName: z.string().min(1),
    mimeType: z.string().default("application/octet-stream"),
    size: z.number().int().nonnegative(),
    dataBase64: z.string().min(1)
  })
  .strict();

export const ConversationSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  rangeStartEventId: z.string(),
  rangeEndEventId: z.string(),
  summary: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  reason: z.string().default("event_window"),
  retainedFacts: z.array(z.string()).default([]),
  droppedRanges: z.array(z.object({ startEventId: z.string(), endEventId: z.string(), eventCount: z.number().int().nonnegative() })).default([]),
  tokenBudget: z
    .object({
      maxTotal: z.number().int().positive(),
      reservedForResponse: z.number().int().nonnegative(),
      usedBefore: z.number().int().nonnegative().optional(),
      usedAfter: z.number().int().nonnegative().optional()
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const ContextPackSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  layers: z.array(z.object({ name: z.string(), summary: z.string(), tokenEstimate: z.number().int().nonnegative() })),
  retainedFacts: z.array(z.string()).default([]),
  droppedRanges: z.array(z.object({ startEventId: z.string(), endEventId: z.string(), eventCount: z.number().int().nonnegative() })).default([]),
  tokenBudget: z.object({ maxTotal: z.number().int().positive(), reservedForResponse: z.number().int().nonnegative() }).optional(),
  reason: z.string().default("assembly"),
  createdAt: z.string()
});

export const TaskCheckpointFileSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  existed: z.boolean(),
  beforeHash: z.string().optional(),
  size: z.number().int().nonnegative().default(0),
  snapshotPath: z.string().optional()
});

export const TaskCheckpointSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workRoot: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  reason: z.string(),
  files: z.array(TaskCheckpointFileSchema),
  truncated: z.boolean().default(false),
  createdAt: z.string()
});

export const TaskRollbackRequestSchema = z
  .object({
    checkpointId: z.string().optional(),
    filePaths: z.array(z.string().min(1)).optional()
  })
  .strict();

export const TaskRollbackFileChangeSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  status: z.enum(["modified", "created", "deleted", "unchanged", "skipped"]),
  existedBefore: z.boolean(),
  existsNow: z.boolean(),
  canRollback: z.boolean(),
  beforeHash: z.string().optional(),
  currentHash: z.string().optional(),
  sizeBefore: z.number().int().nonnegative().default(0),
  sizeNow: z.number().int().nonnegative().default(0),
  reason: z.string().optional()
});

export const TaskRollbackPreviewSchema = z.object({
  taskId: z.string(),
  checkpointId: z.string(),
  workRoot: z.string(),
  files: z.array(TaskRollbackFileChangeSchema),
  restorableFiles: z.number().int().nonnegative(),
  deletableFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  createdAt: z.string()
});

export const TaskRollbackResultSchema = z.object({
  taskId: z.string(),
  checkpointId: z.string(),
  workRoot: z.string(),
  files: z.array(TaskRollbackFileChangeSchema),
  restoredFiles: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  createdAt: z.string()
});

export const TaskPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "running", "completed", "blocked"]),
  detail: z.string().optional(),
  updatedAt: z.string()
});

export const TaskPlanSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  steps: z.array(TaskPlanStepSchema),
  updatedAt: z.string()
});

export const TaskDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().default("default"),
  workRoot: z.string().default(""),
  status: TaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(TaskEventSchema),
  approvals: z.array(ToolApprovalSchema),
  pendingGuidance: z.array(TaskEventSchema)
});

export const CreateTaskRequestSchema = z
  .object({
    goal: z.string().min(1),
    title: z.string().min(1).optional(),
    folderId: z.string().min(1).optional(),
    attachmentIds: z.array(z.string().min(1)).default([])
  })
  .strict();

export const TaskTitleRequestSchema = z
  .object({
    goal: z.string().min(1),
    language: z.string().optional(),
    useLocalFallback: z.boolean().default(false)
  })
  .strict();

export const TaskTitleResponseSchema = z.object({
  title: z.string().min(1),
  source: z.enum(["model", "local_fallback"])
});

export const TaskFolderRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string().default(""),
  isDefault: z.boolean().default(false),
  exists: z.boolean().default(true),
  lastValidatedAt: z.string().optional(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TaskFolderCreateRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    rootPath: z.string().min(1).optional()
  })
  .strict();

export const TaskFolderPatchRequestSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    rootPath: z.string().min(1).optional(),
    sortOrder: z.number().int().optional()
  })
  .strict();

export const TaskFolderClearRequestSchema = z
  .object({
    deleteLearningData: z.boolean().default(false),
    deleteDerivedSkills: z.boolean().default(false)
  })
  .strict();

export const TaskFolderClearResultSchema = z.object({
  folderId: z.string(),
  deletedTasks: z.number().int().nonnegative(),
  deletedExperiences: z.number().int().nonnegative(),
  deletedTaskMemories: z.number().int().nonnegative(),
  deletedSkills: z.number().int().nonnegative(),
  updatedSkills: z.number().int().nonnegative()
});

export const TaskFolderDeleteRequestSchema = TaskFolderClearRequestSchema;

export const TaskFolderDeleteResultSchema = TaskFolderClearResultSchema.extend({
  deletedFolder: z.boolean()
});

export const TaskPatchRequestSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    folderId: z.string().min(1).optional()
  })
  .strict();

export const TaskDeleteRequestSchema = z
  .object({
    deleteLearningData: z.boolean().default(false),
    deleteDerivedSkills: z.boolean().default(false)
  })
  .strict();

export const TaskDeleteResultSchema = z.object({
  taskId: z.string(),
  deletedTask: z.boolean(),
  deletedExperiences: z.number().int().nonnegative(),
  deletedTaskMemories: z.number().int().nonnegative(),
  deletedSkills: z.number().int().nonnegative(),
  updatedSkills: z.number().int().nonnegative(),
  cancelledRun: z.boolean()
});

export const MessageRequestSchema = z
  .object({
    content: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).default([])
  })
  .strict();

export const MemoryDocumentSchema = z.object({
  scope: z.enum(["user", "project"]),
  folderId: z.string().optional(),
  workRoot: z.string().optional(),
  path: z.string(),
  fileName: z.string(),
  content: z.string(),
  charLimit: z.number().int().positive(),
  entryCharLimit: z.number().int().positive(),
  updatedAt: z.string()
});

export const MemoryDocumentPatchSchema = z
  .object({
    content: z.string()
  })
  .strict();

export const MemoryDocumentCompactResultSchema = z.object({
  document: MemoryDocumentSchema,
  beforeChars: z.number().int().nonnegative(),
  afterChars: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative()
});

export const ControlRequestSchema = z
  .object({
    action: z.enum(["pause", "resume", "cancel"])
  })
  .strict();

export const ApprovalRequestSchema = z
  .object({
    decision: ApprovalDecisionSchema
  })
  .strict();

export const GlobalPermissionGrantSchema = z.object({
  id: z.string(),
  riskCategory: RiskCategorySchema,
  grantedAt: z.string(),
  grantedBy: z.string(),
  reason: z.string().optional(),
  expiresAt: z.string().optional()
});

export const UserPreferencesSchema = z.object({
  llmProvider: z.enum(["mimo", "openai", "openai_compatible", "custom"]).default("mimo"),
  activeModelProviderId: z.string().optional(),
  defaultModel: z.string().default("mimo-v2.5"),
  providerBaseUrl: z.string().default(""),
  contextMode: z.enum(["auto", "manual"]).default("auto"),
  customModelContextWindow: z.number().int().positive().optional(),
  maxTokensPerRequest: z.number().int().positive().default(1048576),
  autoApprove: z.enum(["none", "low", "medium", "all"]).default("none"),
  showThinking: z.boolean().default(true),
  language: z.string().default("zh-CN"),
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  agentTone: z.enum(["concise", "balanced", "warm", "formal"]).default("balanced"),
  agentRole: z.string().default("Pragmatic engineering assistant"),
  responseDetail: z.enum(["brief", "normal", "detailed"]).default("normal"),
  skillAutoInject: z.boolean().default(true),
  maxInjectedSkills: z.number().int().positive().default(3),
  mcpApprovalMode: z.enum(["confirm_each", "confirm_dangerous", "auto"]).default("confirm_dangerous"),
  sanitizeSensitiveData: z.boolean().default(true),
  encryptStorage: z.boolean().default(false),
  customPermissionSnapshot: z.array(z.enum(["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"])).optional(),
  modelRoute: z
    .object({
      mainProviderId: z.string().optional(),
      fallbackProviderIds: z.array(z.string()).default([]),
      compressionProviderId: z.string().optional(),
      titleGenerationProviderId: z.string().optional(),
      ragSummaryProviderId: z.string().optional(),
      reflectionProviderId: z.string().optional()
    })
    .default({ fallbackProviderIds: [] }),
  updatedAt: z.string()
});

export const PromptCachePolicySchema = z.enum(["auto_savings", "off"]);

export const PromptCacheStatsSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string(),
  policy: PromptCachePolicySchema.default("auto_savings"),
  source: z.enum(["provider", "estimated"]).default("estimated"),
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheHitRatio: z.number().min(0).max(1),
  estimatedSavings: z.number().nonnegative(),
  providerUsage: z.record(z.unknown()).optional(),
  createdAt: z.string()
});

export const ProviderProtocolSchema = z.enum(["openai_compatible", "anthropic_messages", "gemini"]);

export const ModelPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  contextWindowKind: z.enum(["total", "input"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  docsUrl: z.string().url().optional(),
  verifiedAt: z.string().optional(),
  supportsTools: z.boolean().default(true),
  supportsThinking: z.boolean().default(false)
});

export const EncryptedSecretRefSchema = z.object({
  secretId: z.string(),
  last4: z.string().optional(),
  updatedAt: z.string()
});

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  type: z.enum(["prompt", "reflection", "knowledge_reindex", "integration_digest", "skill_review"]).default("prompt"),
  title: z.string(),
  prompt: z.string(),
  folderId: z.string().optional(),
  modelProviderId: z.string().optional(),
  permissionPreset: z.enum(["ask", "read_only", "custom", "all"]).default("ask"),
  schedule: z.object({
    kind: z.enum(["once", "interval", "calendar"]),
    frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
    timeOfDay: z.string().optional(),
    runAt: z.string().optional(),
    intervalMinutes: z.number().int().positive().optional()
  }),
  status: z.enum(["active", "paused", "completed"]),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  lastTaskId: z.string().optional(),
  lastRunSummary: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const ScheduledTaskRequestBaseSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    folderId: z.string().optional(),
    scheduleKind: z.enum(["calendar", "interval"]).default("calendar"),
    frequency: z.enum(["daily", "weekly", "monthly"]).default("daily"),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    intervalHours: z.number().int().min(0).max(12).optional(),
    intervalMinutes: z.number().int().min(0).max(59).optional()
  })
  .strict();

function validateScheduledTaskInterval(
  value: {
    scheduleKind?: "calendar" | "interval" | undefined;
    intervalHours?: number | undefined;
    intervalMinutes?: number | undefined;
  },
  context: z.RefinementCtx
) {
  if (value.scheduleKind !== "interval") return;
  const totalMinutes = (value.intervalHours ?? 0) * 60 + (value.intervalMinutes ?? 0);
  if (totalMinutes <= 0 || totalMinutes > 720) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Interval must be greater than 0 and no more than 12 hours.",
      path: ["intervalMinutes"]
    });
  }
}

export const ScheduledTaskCreateRequestSchema = ScheduledTaskRequestBaseSchema.superRefine(validateScheduledTaskInterval);

export const ScheduledTaskPatchRequestSchema = ScheduledTaskRequestBaseSchema.partial()
  .extend({
    status: z.enum(["active", "paused", "completed"]).optional()
  })
  .strict()
  .superRefine(validateScheduledTaskInterval);

export const WebSearchProviderKindSchema = z.enum(["brave", "serpapi", "duckduckgo", "custom"]);

export const WebSearchProviderConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: WebSearchProviderKindSchema,
  endpoint: z.string().optional(),
  apiKeyRef: EncryptedSecretRefSchema.optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const WebSearchProviderCreateRequestSchema = z
  .object({
    label: z.string().min(1),
    kind: WebSearchProviderKindSchema,
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean().default(true)
  })
  .strict();

export const WebSearchProviderPatchRequestSchema = z
  .object({
    label: z.string().min(1).optional(),
    kind: WebSearchProviderKindSchema.optional(),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    clearApiKey: z.boolean().optional(),
    enabled: z.boolean().optional()
  })
  .strict();

export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string().optional(),
  publishedAt: z.string().optional()
});

export const ModelProviderRecordSchema = z.object({
  id: z.string(),
  vendor: z.string().min(1),
  label: z.string().min(1),
  protocol: ProviderProtocolSchema,
  baseUrl: z.string().default(""),
  apiKeyRef: EncryptedSecretRefSchema.optional(),
  models: z.array(ModelPresetSchema).default([]),
  defaultModelId: z.string().min(1),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const ModelProviderCreateRequestSchema = z
  .object({
    vendor: z.string().min(1),
    label: z.string().min(1),
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().default(""),
    apiKey: z.string().min(1).optional(),
    models: z.array(ModelPresetSchema).min(1),
    defaultModelId: z.string().min(1),
    enabled: z.boolean().default(true),
    makeActive: z.boolean().default(true)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.models.some((model) => model.id === value.defaultModelId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "defaultModelId must match a configured model.", path: ["defaultModelId"] });
    }
  });

export const ModelProviderPatchRequestSchema = z
  .object({
    vendor: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    protocol: ProviderProtocolSchema.optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().min(1).optional(),
    clearApiKey: z.boolean().optional(),
    models: z.array(ModelPresetSchema).min(1).optional(),
    defaultModelId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    makeActive: z.boolean().optional()
  })
  .strict();

export const KnowledgeKindSchema = z.enum(["memory", "file"]);

export const KnowledgeIndexStatusSchema = z.enum(["pending", "indexed", "failed", "metadata_only"]);

export const KnowledgeItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: KnowledgeKindSchema,
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  sourceUri: z.string().optional(),
  indexStatus: KnowledgeIndexStatusSchema.default("pending"),
  chunkCount: z.number().int().nonnegative().default(0),
  lastIndexedAt: z.string().optional(),
  indexError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const EmbeddingProviderConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["local_hash", "openai_compatible", "custom"]).default("local_hash"),
  model: z.string().default("local-hash-v1"),
  dimensions: z.number().int().positive().default(128),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const KnowledgeChunkSchema = z.object({
  id: z.string(),
  knowledgeId: z.string(),
  projectId: z.string(),
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  content: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  tags: z.array(z.string()).default([]),
  heading: z.string().optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  sourceUri: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const KnowledgeEmbeddingSchema = z.object({
  id: z.string(),
  chunkId: z.string(),
  providerId: z.string().default("local_hash"),
  model: z.string().default("local-hash-v1"),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number()),
  createdAt: z.string()
});

export const KnowledgeSearchRequestSchema = z
  .object({
    query: z.string().min(1),
    projectId: z.string().default("default"),
    limit: z.number().int().positive().max(12).default(5)
  })
  .strict();

export const KnowledgeSearchResultSchema = z.object({
  item: KnowledgeItemSchema,
  chunk: KnowledgeChunkSchema,
  score: z.number().min(0).max(1),
  citation: z
    .object({
      knowledgeId: z.string(),
      chunkId: z.string(),
      title: z.string(),
      sourceUri: z.string().optional(),
      heading: z.string().optional(),
      excerpt: z.string(),
      score: z.number().min(0).max(1)
    })
    .optional()
});

export const KnowledgeReindexResultSchema = z.object({
  knowledgeId: z.string(),
  status: KnowledgeIndexStatusSchema,
  chunks: z.number().int().nonnegative(),
  error: z.string().optional()
});

export const KnowledgeCreateRequestSchema = z
  .object({
    projectId: z.string().default("default"),
    kind: KnowledgeKindSchema.default("memory"),
    title: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string()).default([]),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    sourceUri: z.string().optional()
  })
  .strict();

export const KnowledgePatchRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    sourceUri: z.string().optional()
  })
  .strict();

export const KnowledgeUploadRequestSchema = z
  .object({
    projectId: z.string().default("default"),
    title: z.string().min(1).optional(),
    fileName: z.string().min(1),
    mimeType: z.string().default("text/plain"),
    size: z.number().int().nonnegative(),
    content: z.string(),
    tags: z.array(z.string()).default([])
  })
  .strict();

export const IntegrationKindSchema = z.enum(["discord", "feishu"]);

export const IntegrationStatusSchema = z.enum(["disabled", "setup_pending", "connecting", "connected", "error"]);

export const IntegrationProviderConfigSchema = z.object({
  id: z.string(),
  kind: IntegrationKindSchema,
  label: z.string(),
  status: IntegrationStatusSchema.default("disabled"),
  enabled: z.boolean().default(false),
  botTokenRef: EncryptedSecretRefSchema.optional(),
  signingSecretRef: EncryptedSecretRefSchema.optional(),
  appId: z.string().optional(),
  appSecretRef: EncryptedSecretRefSchema.optional(),
  callbackUrl: z.string().optional(),
  defaultFolderId: z.string().default("default"),
  defaultPermissionPreset: z.enum(["ask", "read_only", "custom", "all"]).default("ask"),
  lastError: z.string().optional(),
  connectedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const IntegrationProviderCreateRequestSchema = z
  .object({
    kind: IntegrationKindSchema,
    label: z.string().min(1),
    botToken: z.string().optional(),
    signingSecret: z.string().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    callbackUrl: z.string().optional(),
    defaultFolderId: z.string().default("default"),
    defaultPermissionPreset: z.enum(["ask", "read_only", "custom", "all"]).default("ask"),
    enabled: z.boolean().default(false)
  })
  .strict();

export const IntegrationProviderPatchRequestSchema = IntegrationProviderCreateRequestSchema.partial()
  .extend({
    clearBotToken: z.boolean().optional(),
    clearSigningSecret: z.boolean().optional(),
    clearAppSecret: z.boolean().optional()
  })
  .strict();

export const IntegrationChannelBindingSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  externalChannelId: z.string(),
  label: z.string(),
  folderId: z.string().default("default"),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const IntegrationMessageSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  externalMessageId: z.string(),
  externalChannelId: z.string(),
  senderId: z.string().optional(),
  text: z.string(),
  taskId: z.string().optional(),
  createdAt: z.string()
});

export const IntegrationTaskLinkSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  taskId: z.string(),
  externalChannelId: z.string(),
  externalThreadId: z.string().optional(),
  createdAt: z.string()
});

export const DiscordInteractionRequestSchema = z
  .object({
    integrationId: z.string().optional(),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    userId: z.string().optional(),
    text: z.string().min(1)
  })
  .strict();

export const FeishuEventRequestSchema = z
  .object({
    integrationId: z.string().optional(),
    challenge: z.string().optional(),
    event: z
      .object({
        message: z
          .object({
            message_id: z.string().optional(),
            chat_id: z.string().optional(),
            content: z.string().optional()
          })
          .optional(),
        sender: z.record(z.unknown()).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const ToolTraceSchema = z.object({
  toolName: z.string(),
  args: z.record(z.unknown()),
  result: z.string(),
  riskCategory: RiskCategorySchema
});

export const TaskMemorySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  goal: z.string(),
  toolsUsed: z.array(ToolTraceSchema),
  result: z.string(),
  assessment: z.object({
    goalAchieved: z.boolean(),
    confidence: z.number().min(0).max(1),
    issues: z.array(z.string()),
    learnings: z.array(z.string()),
    suggestedPatterns: z.array(z.string())
  }),
  meta: z.object({
    outcome: z.enum(["success", "failure", "partial"]),
    complexity: z.enum(["simple", "medium", "complex"]),
    domains: z.array(z.string()),
    tools: z.array(z.string()),
    hasSideEffects: z.boolean(),
    duration: z.number()
  }),
  reflectionCount: z.number().int().nonnegative(),
  reflectionStatus: z.enum(["pending", "reflected", "archived"]),
  createdAt: z.string()
});

export const PatternRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  trigger: z.object({
    keywords: z.array(z.string()),
    requiredTools: z.array(z.string()),
    domainHints: z.array(z.string())
  }),
  content: z.object({
    approach: z.string(),
    toolSequence: z.array(z.string()),
    cautions: z.array(z.string()),
    commonMistakes: z.array(z.string())
  }),
  sourceTaskCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  status: z.enum(["forming", "stable", "deprecated"]),
  confidence: z.number().min(0).max(1),
  relatedSkills: z.array(z.string()),
  createdAt: z.string(),
  lastValidatedAt: z.string()
});

export const SkillRecordSchema = z.object({
  id: z.string(),
  sourcePatternId: z.string().optional(),
  sourceMemoryIds: z.array(z.string()).default([]),
  title: z.string(),
  body: z.string(),
  applicability: z.object({
    description: z.string(),
    requiredTools: z.array(z.string()),
    requiredContext: z.array(z.string()),
    exclusions: z.array(z.string()),
    minConfidence: z.number().min(0).max(1),
    keywords: z.array(z.string())
  }),
  stats: z.object({
    totalUses: z.number().int().nonnegative(),
    successUses: z.number().int().nonnegative(),
    failureUses: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    lastFailureAt: z.string().optional(),
    consecutiveFailures: z.number().int().nonnegative()
  }),
  version: z.number().int().positive(),
  corrections: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["user", "agent", "auto"]),
      reason: z.string(),
      originalBody: z.string(),
      revisedBody: z.string(),
      createdAt: z.string()
    })
  ),
  status: z.enum(["candidate", "active", "suspended", "retired"]),
  relatedPatterns: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  updatedAt: z.string()
});

export const ReflectionSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "partial", "failed"]),
  progress: z.object({
    phase: z.string(),
    completedDomains: z.array(z.string()),
    nextStep: z.string().optional()
  }),
  tokenUsed: z.number().int().nonnegative(),
  budget: z.number().int().positive(),
  createdAt: z.string(),
  completedAt: z.string().optional()
});

export const ProjectMemorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.enum(["architecture", "tech_stack", "business_logic", "convention"]),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const SkillConflictSchema = z.object({
  id: z.string(),
  skillIds: z.array(z.string()).min(2),
  reason: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  status: z.enum(["open", "acknowledged", "resolved"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const SkillCuratorItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["candidate", "active", "duplicate", "conflict", "low_value_memory"]),
  title: z.string(),
  status: z.enum(["candidate", "active", "suspended", "retired", "needs_review", "not_promoted"]),
  reason: z.string(),
  recommendation: z.string(),
  skillIds: z.array(z.string()).default([]),
  memoryIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  createdAt: z.string()
});

export const GlobalPermissionRequestSchema = z
  .object({
    riskCategory: RiskCategorySchema,
    reason: z.string().optional()
  })
  .strict();

export const PreferencesPatchSchema = UserPreferencesSchema.partial()
  .omit({ updatedAt: true })
  .strict();

export const ProjectMemoryCreateRequestSchema = z
  .object({
    title: z.string().min(1),
    content: z.string().min(1),
    category: ProjectMemorySchema.shape.category,
    tags: z.array(z.string()).default([]),
    projectId: z.string().default("default")
  })
  .strict();

export const McpServerCreateRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    label: z.string().min(1),
    transport: McpTransportKindSchema,
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    enabled: z.boolean().default(true),
    toolRiskOverrides: z.record(RiskCategorySchema).default({})
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio MCP servers require command.", path: ["command"] });
    }
    if (value.transport === "streamable_http" && !value.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "streamable_http MCP servers require url.", path: ["url"] });
    }
  });

export const McpServerPatchRequestSchema = z
  .object({
    label: z.string().min(1).optional(),
    transport: McpTransportKindSchema.optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    enabled: z.boolean().optional(),
    toolRiskOverrides: z.record(RiskCategorySchema).optional()
  })
  .strict();

export const SkillStatusPatchSchema = z
  .object({
    status: z.enum(["candidate", "active", "suspended", "retired"])
  })
  .strict();

export const SkillApplicabilityPatchSchema = z
  .object({
    description: z.string().min(1).optional(),
    requiredTools: z.array(z.string()).optional(),
    requiredContext: z.array(z.string()).optional(),
    exclusions: z.array(z.string()).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    keywords: z.array(z.string()).optional()
  })
  .strict();

export const SkillCreateRequestSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    status: z.enum(["candidate", "active", "suspended", "retired"]).default("candidate"),
    applicability: SkillApplicabilityPatchSchema.default({}),
    sourceMemoryIds: z.array(z.string()).default([]),
    relatedPatterns: z.array(z.string()).default([])
  })
  .strict();

export const SkillUpdateRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    status: z.enum(["candidate", "active", "suspended", "retired"]).optional(),
    applicability: SkillApplicabilityPatchSchema.optional(),
    sourceMemoryIds: z.array(z.string()).optional(),
    relatedPatterns: z.array(z.string()).optional()
  })
  .strict();

export const SkillBulkDeleteRequestSchema = z
  .object({
    skillIds: z.array(z.string()).min(1)
  })
  .strict();

export const SkillDeleteRequestSchema = SkillBulkDeleteRequestSchema;

export const SkillMergeRequestSchema = z
  .object({
    sourceSkillIds: z.array(z.string()).min(1),
    targetSkillId: z.string().optional(),
    deleteSources: z.boolean().default(true)
  })
  .strict();

export const SkillDuplicateGroupSchema = z.object({
  fingerprint: z.string(),
  canonicalSkillId: z.string(),
  reason: z.string(),
  skills: z.array(SkillRecordSchema).min(2)
});

export const SkillCorrectionRequestSchema = z
  .object({
    reason: z.string().min(1),
    revisedBody: z.string().min(1)
  })
  .strict();

export const ExperienceRecordSchema = TaskMemorySchema.extend({
  body: z.string(),
  readOnly: z.boolean()
});
