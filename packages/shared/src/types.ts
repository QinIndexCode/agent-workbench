import type { z } from "zod";
import type {
  ApprovalDecisionSchema,
  ConversationSummarySchema,
  CreateTaskRequestSchema,
  ContextPackSchema,
  ExperienceRecordSchema,
  GlobalPermissionGrantSchema,
  DiscordInteractionRequestSchema,
  EmbeddingProviderConfigSchema,
  EncryptedSecretRefSchema,
  FeishuEventRequestSchema,
  IntegrationChannelBindingSchema,
  IntegrationMessageSchema,
  IntegrationProviderConfigSchema,
  IntegrationProviderCreateRequestSchema,
  IntegrationProviderPatchRequestSchema,
  IntegrationStatusSchema,
  IntegrationKindSchema,
  IntegrationTaskLinkSchema,
  KnowledgeChunkSchema,
  KnowledgeCreateRequestSchema,
  KnowledgeEmbeddingSchema,
  KnowledgeItemSchema,
  KnowledgeModelAssetKindSchema,
  KnowledgeModelAssetStatusSchema,
  KnowledgeModelDownloadRequestSchema,
  KnowledgeModelDownloadResultSchema,
  KnowledgeModelPresetSchema,
  KnowledgeModelStatusSchema,
  KnowledgeSearchFieldSchema,
  KnowledgeSearchIndexEntrySchema,
  KnowledgeReindexResultSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
  KnowledgePatchRequestSchema,
  KnowledgeUploadRequestSchema,
  MessageRequestSchema,
  McpServerConfigSchema,
  McpServerCreateRequestSchema,
  McpServerPatchRequestSchema,
  McpServerStatusSchema,
  McpToolCallResultSchema,
  McpToolSummarySchema,
  McpTransportKindSchema,
  ModelPresetSchema,
  ModelProviderCreateRequestSchema,
  ModelProviderFailureClassSchema,
  ModelProviderPatchRequestSchema,
  ModelProviderRecordSchema,
  ModelProviderTestResultSchema,
  MemoryDocumentCompactResultSchema,
  MemoryDocumentPatchSchema,
  MemoryDocumentSchema,
  PatternRecordSchema,
  PreferencesPatchSchema,
  ProviderProtocolSchema,
  ProjectMemoryCreateRequestSchema,
  ProjectMemoryPatchRequestSchema,
  ProjectMemorySchema,
  PromptCachePolicySchema,
  PromptCacheStatsSchema,
  ReflectionSessionSchema,
  RiskCategorySchema,
  SlackEventRequestSchema,
  SkillCorrectionRequestSchema,
  SkillBulkDeleteRequestSchema,
  SkillCreateRequestSchema,
  SkillCuratorItemSchema,
  SkillConflictSchema,
  SkillDeleteRequestSchema,
  SkillDuplicateGroupSchema,
  SkillMergeRequestSchema,
  SkillRecordSchema,
  SkillStatusPatchSchema,
  SkillUpdateRequestSchema,
  ScheduledTaskCreateRequestSchema,
  ScheduledTaskPatchRequestSchema,
  ScheduledTaskSchema,
  TaskAttachmentKindSchema,
  TaskAttachmentSchema,
  TaskAttachmentUploadRequestSchema,
  TaskCheckpointSchema,
  TaskChildSummarySchema,
  TaskDelegationExpectedOutputSchema,
  TaskDelegationMetaSchema,
  TaskRollbackFileChangeSchema,
  TaskRollbackPreviewSchema,
  TaskRollbackRequestSchema,
  TaskRollbackResultSchema,
  TaskMemorySchema,
  TaskPlanSchema,
  TaskPlanStepSchema,
  TaskFolderClearRequestSchema,
  TaskFolderClearResultSchema,
  TaskFolderDeleteRequestSchema,
  TaskFolderDeleteResultSchema,
  TaskFolderCreateRequestSchema,
  TaskFolderPatchRequestSchema,
  TaskFolderRecordSchema,
  TaskKindSchema,
  TaskPatchRequestSchema,
  TaskTitleRequestSchema,
  TaskTitleResponseSchema,
  TaskDeleteRequestSchema,
  TaskDeleteResultSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskTranscriptItemSchema,
  TaskTurnEditRequestSchema,
  TaskTurnRevertResultSchema,
  TaskTurnSchema,
  TelegramUpdateRequestSchema,
  TaskStatusSchema,
  ToolApprovalSchema,
  ToolCallSchema,
  ToolResultSchema,
  UserPreferencesSchema,
  WecomCallbackRequestSchema,
  WebSearchProviderConfigSchema,
  WebSearchProviderCreateRequestSchema,
  WebSearchProviderKindSchema,
  WebSearchProviderPatchRequestSchema,
  WebSearchResultSchema
} from "./schemas.js";

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type RiskCategory = z.infer<typeof RiskCategorySchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type McpTransportKind = z.infer<typeof McpTransportKindSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpToolSummary = z.infer<typeof McpToolSummarySchema>;
export type McpToolCallResult = z.infer<typeof McpToolCallResultSchema>;
export type McpServerCreateRequest = z.infer<typeof McpServerCreateRequestSchema>;
export type McpServerPatchRequest = z.infer<typeof McpServerPatchRequestSchema>;
export type ToolApproval = z.infer<typeof ToolApprovalSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type TaskTranscriptItem = z.infer<typeof TaskTranscriptItemSchema>;
export type TaskAttachmentKind = z.infer<typeof TaskAttachmentKindSchema>;
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;
export type TaskAttachmentUploadRequest = z.infer<typeof TaskAttachmentUploadRequestSchema>;
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskDelegationExpectedOutput = z.infer<typeof TaskDelegationExpectedOutputSchema>;
export type TaskDelegationMeta = z.infer<typeof TaskDelegationMetaSchema>;
export type TaskChildSummary = z.infer<typeof TaskChildSummarySchema>;
export type TaskRollbackFileChange = z.infer<typeof TaskRollbackFileChangeSchema>;
export type TaskRollbackPreview = z.infer<typeof TaskRollbackPreviewSchema>;
export type TaskRollbackRequest = z.infer<typeof TaskRollbackRequestSchema>;
export type TaskRollbackResult = z.infer<typeof TaskRollbackResultSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type TaskPlanStep = z.infer<typeof TaskPlanStepSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type TaskTitleRequest = z.infer<typeof TaskTitleRequestSchema>;
export type TaskTitleResponse = z.infer<typeof TaskTitleResponseSchema>;
export type TaskFolderRecord = z.infer<typeof TaskFolderRecordSchema>;
export type TaskFolderCreateRequest = z.infer<typeof TaskFolderCreateRequestSchema>;
export type TaskFolderPatchRequest = z.infer<typeof TaskFolderPatchRequestSchema>;
export type TaskFolderClearRequest = z.infer<typeof TaskFolderClearRequestSchema>;
export type TaskFolderClearResult = z.infer<typeof TaskFolderClearResultSchema>;
export type TaskFolderDeleteRequest = z.infer<typeof TaskFolderDeleteRequestSchema>;
export type TaskFolderDeleteResult = z.infer<typeof TaskFolderDeleteResultSchema>;
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>;
export type TaskDeleteRequest = z.infer<typeof TaskDeleteRequestSchema>;
export type TaskDeleteResult = z.infer<typeof TaskDeleteResultSchema>;
export type MessageRequest = z.infer<typeof MessageRequestSchema>;
export type ExperienceRecord = z.infer<typeof ExperienceRecordSchema>;
export type GlobalPermissionGrant = z.infer<typeof GlobalPermissionGrantSchema>;
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;
export type PromptCachePolicy = z.infer<typeof PromptCachePolicySchema>;
export type PromptCacheStats = z.infer<typeof PromptCacheStatsSchema>;
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
export type ModelPreset = z.infer<typeof ModelPresetSchema>;
export type EncryptedSecretRef = z.infer<typeof EncryptedSecretRefSchema>;
export type ModelProviderRecord = z.infer<typeof ModelProviderRecordSchema>;
export type ModelProviderCreateRequest = z.infer<typeof ModelProviderCreateRequestSchema>;
export type ModelProviderPatchRequest = z.infer<typeof ModelProviderPatchRequestSchema>;
export type ModelProviderFailureClass = z.infer<typeof ModelProviderFailureClassSchema>;
export type ModelProviderTestResult = z.infer<typeof ModelProviderTestResultSchema>;
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;
export type MemoryDocumentPatch = z.infer<typeof MemoryDocumentPatchSchema>;
export type MemoryDocumentCompactResult = z.infer<typeof MemoryDocumentCompactResultSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderConfigSchema>;
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;
export type KnowledgeEmbedding = z.infer<typeof KnowledgeEmbeddingSchema>;
export type KnowledgeModelAssetKind = z.infer<typeof KnowledgeModelAssetKindSchema>;
export type KnowledgeModelAssetStatus = z.infer<typeof KnowledgeModelAssetStatusSchema>;
export type KnowledgeModelDownloadRequest = z.infer<typeof KnowledgeModelDownloadRequestSchema>;
export type KnowledgeModelDownloadResult = z.infer<typeof KnowledgeModelDownloadResultSchema>;
export type KnowledgeModelPreset = z.infer<typeof KnowledgeModelPresetSchema>;
export type KnowledgeModelStatus = z.infer<typeof KnowledgeModelStatusSchema>;
export type KnowledgeSearchField = z.infer<typeof KnowledgeSearchFieldSchema>;
export type KnowledgeSearchIndexEntry = z.infer<typeof KnowledgeSearchIndexEntrySchema>;
export type KnowledgeCreateRequest = z.infer<typeof KnowledgeCreateRequestSchema>;
export type KnowledgePatchRequest = z.infer<typeof KnowledgePatchRequestSchema>;
export type KnowledgeUploadRequest = z.infer<typeof KnowledgeUploadRequestSchema>;
export type KnowledgeSearchRequest = z.input<typeof KnowledgeSearchRequestSchema>;
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;
export type KnowledgeReindexResult = z.infer<typeof KnowledgeReindexResultSchema>;
export type IntegrationKind = z.infer<typeof IntegrationKindSchema>;
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export type IntegrationProviderCreateRequest = z.infer<typeof IntegrationProviderCreateRequestSchema>;
export type IntegrationProviderPatchRequest = z.infer<typeof IntegrationProviderPatchRequestSchema>;
export type IntegrationChannelBinding = z.infer<typeof IntegrationChannelBindingSchema>;
export type IntegrationMessage = z.infer<typeof IntegrationMessageSchema>;
export type IntegrationTaskLink = z.infer<typeof IntegrationTaskLinkSchema>;
export type DiscordInteractionRequest = z.infer<typeof DiscordInteractionRequestSchema>;
export type FeishuEventRequest = z.infer<typeof FeishuEventRequestSchema>;
export type SlackEventRequest = z.infer<typeof SlackEventRequestSchema>;
export type TelegramUpdateRequest = z.infer<typeof TelegramUpdateRequestSchema>;
export type WecomCallbackRequest = z.infer<typeof WecomCallbackRequestSchema>;
export type TaskMemory = z.infer<typeof TaskMemorySchema>;
export type PatternRecord = z.infer<typeof PatternRecordSchema>;
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
export type SkillCuratorItem = z.infer<typeof SkillCuratorItemSchema>;
export type SkillConflict = z.infer<typeof SkillConflictSchema>;
export type SkillStatusPatch = z.infer<typeof SkillStatusPatchSchema>;
export type SkillCreateRequest = z.infer<typeof SkillCreateRequestSchema>;
export type SkillUpdateRequest = z.infer<typeof SkillUpdateRequestSchema>;
export type SkillBulkDeleteRequest = z.infer<typeof SkillBulkDeleteRequestSchema>;
export type SkillDeleteRequest = z.infer<typeof SkillDeleteRequestSchema>;
export type SkillMergeRequest = z.infer<typeof SkillMergeRequestSchema>;
export type SkillDuplicateGroup = z.infer<typeof SkillDuplicateGroupSchema>;
export type SkillCorrectionRequest = z.infer<typeof SkillCorrectionRequestSchema>;
export type ReflectionSession = z.infer<typeof ReflectionSessionSchema>;
export type CuratorRun = ReflectionSession;
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
export type ProjectMemoryCreateRequest = z.infer<typeof ProjectMemoryCreateRequestSchema>;
export type ProjectMemoryPatchRequest = z.infer<typeof ProjectMemoryPatchRequestSchema>;
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
export type ScheduledTaskCreateRequest = z.infer<typeof ScheduledTaskCreateRequestSchema>;
export type ScheduledTaskPatchRequest = z.infer<typeof ScheduledTaskPatchRequestSchema>;
export type WebSearchProviderKind = z.infer<typeof WebSearchProviderKindSchema>;
export type WebSearchProviderConfig = z.infer<typeof WebSearchProviderConfigSchema>;
export type WebSearchProviderCreateRequest = z.infer<typeof WebSearchProviderCreateRequestSchema>;
export type WebSearchProviderPatchRequest = z.infer<typeof WebSearchProviderPatchRequestSchema>;
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;
export type TaskTurn = z.infer<typeof TaskTurnSchema>;
export type TaskTurnEditRequest = z.infer<typeof TaskTurnEditRequestSchema>;
export type TaskTurnRevertResult = z.infer<typeof TaskTurnRevertResultSchema>;
