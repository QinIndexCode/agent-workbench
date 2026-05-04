import type { z } from "zod";
import type {
  ApprovalDecisionSchema,
  CreateTaskRequestSchema,
  ExperienceRecordSchema,
  MessageRequestSchema,
  RiskCategorySchema,
  SkillRecordSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskStatusSchema,
  ToolApprovalSchema,
  ToolCallSchema,
  ToolResultSchema
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
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
