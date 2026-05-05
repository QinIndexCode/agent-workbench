import type { z } from "zod";
import type {
  ApprovalDecisionSchema,
  CreateTaskRequestSchema,
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
  TaskMemorySchema,
  TaskDeleteRequestSchema,
  TaskDeleteResultSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskStatusSchema,
  ToolApprovalSchema,
  ToolCallSchema,
  ToolResultSchema,
  UserPreferencesSchema
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
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
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
