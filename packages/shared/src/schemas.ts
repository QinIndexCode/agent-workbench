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

export const ApprovalDecisionSchema = z.enum(["allow_once", "allow_for_task", "deny"]);

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

export const ToolApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  toolCall: ToolCallSchema,
  riskCategory: RiskCategorySchema,
  reason: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  createdAt: z.string(),
  decidedAt: z.string().optional()
});

export const TaskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.enum([
    "task_created",
    "user_message",
    "assistant_message",
    "guidance_pending",
    "guidance_consumed",
    "tool_requested",
    "approval_pending",
    "approval_resolved",
    "tool_result",
    "status_changed",
    "experience_recorded",
    "skill_promoted"
  ]),
  createdAt: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()).default({})
});

export const TaskDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
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
    title: z.string().min(1).optional()
  })
  .strict();

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

export const ExperienceRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  body: z.string(),
  readOnly: z.boolean(),
  createdAt: z.string()
});

export const SkillRecordSchema = z.object({
  id: z.string(),
  sourceExperienceId: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["enabled", "draft"]),
  createdAt: z.string()
});
