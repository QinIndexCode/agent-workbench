import type { z } from "zod";
import type {
  ApprovalDecisionSchema,
  ConversationSummarySchema,
  CreateTaskRequestSchema,
  ContextPackSchema,
  ExperienceRecordSchema,
  GlobalPermissionGrantSchema,
  KnowledgeCreateRequestSchema,
  KnowledgeItemSchema,
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
  ModelProviderPatchRequestSchema,
  ModelProviderRecordSchema,
  PatternRecordSchema,
  PreferencesPatchSchema,
  ProviderProtocolSchema,
  ProjectMemoryCreateRequestSchema,
  ProjectMemorySchema,
  ReflectionSessionSchema,
  RiskCategorySchema,
  SkillCorrectionRequestSchema,
  SkillBulkDeleteRequestSchema,
  SkillCreateRequestSchema,
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
  TaskPatchRequestSchema,
  TaskTitleRequestSchema,
  TaskTitleResponseSchema,
  TaskDeleteRequestSchema,
  TaskDeleteResultSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskStatusSchema,
  ToolApprovalSchema,
  ToolCallSchema,
  ToolResultSchema,
  UserPreferencesSchema,
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
export type TaskAttachmentKind = z.infer<typeof TaskAttachmentKindSchema>;
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;
export type TaskAttachmentUploadRequest = z.infer<typeof TaskAttachmentUploadRequestSchema>;
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
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
export type ModelPreset = z.infer<typeof ModelPresetSchema>;
export type ModelProviderRecord = z.infer<typeof ModelProviderRecordSchema>;
export type ModelProviderCreateRequest = z.infer<typeof ModelProviderCreateRequestSchema>;
export type ModelProviderPatchRequest = z.infer<typeof ModelProviderPatchRequestSchema>;
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
export type KnowledgeCreateRequest = z.infer<typeof KnowledgeCreateRequestSchema>;
export type KnowledgePatchRequest = z.infer<typeof KnowledgePatchRequestSchema>;
export type KnowledgeUploadRequest = z.infer<typeof KnowledgeUploadRequestSchema>;
export type TaskMemory = z.infer<typeof TaskMemorySchema>;
export type PatternRecord = z.infer<typeof PatternRecordSchema>;
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
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
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
export type ProjectMemoryCreateRequest = z.infer<typeof ProjectMemoryCreateRequestSchema>;
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
export type ScheduledTaskCreateRequest = z.infer<typeof ScheduledTaskCreateRequestSchema>;
export type ScheduledTaskPatchRequest = z.infer<typeof ScheduledTaskPatchRequestSchema>;
export type WebSearchProviderKind = z.infer<typeof WebSearchProviderKindSchema>;
export type WebSearchProviderConfig = z.infer<typeof WebSearchProviderConfigSchema>;
export type WebSearchProviderCreateRequest = z.infer<typeof WebSearchProviderCreateRequestSchema>;
export type WebSearchProviderPatchRequest = z.infer<typeof WebSearchProviderPatchRequestSchema>;
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;
