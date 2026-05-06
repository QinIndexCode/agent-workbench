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
    "pattern_discovered",
    "reflection_started",
    "reflection_completed",
    "skill_loaded",
    "skill_promoted"
  ]),
  createdAt: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()).default({})
});

export const TaskDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().default("default"),
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
    title: z.string().min(1),
    folderId: z.string().min(1).optional()
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
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TaskFolderCreateRequestSchema = z
  .object({
    name: z.string().min(1).max(64)
  })
  .strict();

export const TaskFolderPatchRequestSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
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
    content: z.string().min(1)
  })
  .strict();

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
  defaultModel: z.string().default("gpt-5.4-mini"),
  providerBaseUrl: z.string().default(""),
  contextMode: z.enum(["auto", "manual"]).default("auto"),
  customModelContextWindow: z.number().int().positive().optional(),
  maxTokensPerRequest: z.number().int().positive().default(128000),
  autoApprove: z.enum(["none", "low", "medium", "all"]).default("none"),
  showThinking: z.boolean().default(true),
  language: z.string().default("zh-CN"),
  reflectionEnabled: z.boolean().default(true),
  reflectionSchedule: z.string().default("02:00"),
  skillAutoInject: z.boolean().default(true),
  maxInjectedSkills: z.number().int().positive().default(3),
  mcpApprovalMode: z.enum(["confirm_each", "confirm_dangerous", "auto"]).default("confirm_dangerous"),
  sanitizeSensitiveData: z.boolean().default(true),
  encryptStorage: z.boolean().default(false),
  updatedAt: z.string()
});

export const ProviderProtocolSchema = z.enum(["openai_compatible", "anthropic_messages", "gemini"]);

export const ModelPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().default(true),
  supportsThinking: z.boolean().default(false)
});

export const EncryptedSecretRefSchema = z.object({
  secretId: z.string(),
  last4: z.string().optional(),
  updatedAt: z.string()
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
  createdAt: z.string(),
  updatedAt: z.string()
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
