import type { z } from "zod";
import type {
  ApprovalDecisionSchema,
  CreateTaskRequestSchema,
  ExperienceRecordSchema,
  GlobalPermissionGrantSchema,
  MessageRequestSchema,
  PatternRecordSchema,
  PreferencesPatchSchema,
  ProjectMemoryCreateRequestSchema,
  ProjectMemorySchema,
  ReflectionSessionSchema,
  RiskCategorySchema,
  SkillCorrectionRequestSchema,
  SkillRecordSchema,
  SkillStatusPatchSchema,
  TaskMemorySchema,
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
export type ToolApproval = z.infer<typeof ToolApprovalSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type MessageRequest = z.infer<typeof MessageRequestSchema>;
export type ExperienceRecord = z.infer<typeof ExperienceRecordSchema>;
export type GlobalPermissionGrant = z.infer<typeof GlobalPermissionGrantSchema>;
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;
export type TaskMemory = z.infer<typeof TaskMemorySchema>;
export type PatternRecord = z.infer<typeof PatternRecordSchema>;
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
export type SkillStatusPatch = z.infer<typeof SkillStatusPatchSchema>;
export type SkillCorrectionRequest = z.infer<typeof SkillCorrectionRequestSchema>;
export type ReflectionSession = z.infer<typeof ReflectionSessionSchema>;
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
export type ProjectMemoryCreateRequest = z.infer<typeof ProjectMemoryCreateRequestSchema>;
