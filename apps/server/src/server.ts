import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AgentWorkbench,
  CompositeToolExecutor,
  ContextAssembler,
  KnowledgeSearchToolExecutor,
  LocalSecretBox,
  McpRegistry,
  ShellToolExecutor,
  WebSearchToolExecutor,
  createModelClientFromEnvironment,
  loadOpenAiProviderConfig,
  type OpenAIProviderConfigWithName,
  type ResolvedModelProviderConfig
} from "@scc/core";
import {
  ApprovalRequestSchema,
  ControlRequestSchema,
  CreateTaskRequestSchema,
  GlobalPermissionRequestSchema,
  DiscordInteractionRequestSchema,
  FeishuEventRequestSchema,
  IntegrationProviderCreateRequestSchema,
  IntegrationProviderPatchRequestSchema,
  KnowledgeCreateRequestSchema,
  KnowledgePatchRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeUploadRequestSchema,
  MessageRequestSchema,
  McpServerCreateRequestSchema,
  McpServerPatchRequestSchema,
  ModelProviderCreateRequestSchema,
  ModelProviderPatchRequestSchema,
  MemoryDocumentPatchSchema,
  PreferencesPatchSchema,
  ProjectMemoryCreateRequestSchema,
  ScheduledTaskCreateRequestSchema,
  ScheduledTaskPatchRequestSchema,
  SkillBulkDeleteRequestSchema,
  SkillCorrectionRequestSchema,
  SkillCreateRequestSchema,
  SkillMergeRequestSchema,
  SkillStatusPatchSchema,
  SkillUpdateRequestSchema,
  TaskFolderClearRequestSchema,
  TaskFolderDeleteRequestSchema,
  TaskFolderCreateRequestSchema,
  TaskFolderPatchRequestSchema,
  TaskPatchRequestSchema,
  TaskRollbackRequestSchema,
  TaskTurnEditRequestSchema,
  TaskTitleRequestSchema,
  TaskDeleteRequestSchema,
  TaskAttachmentUploadRequestSchema,
  type ModelProviderRecord,
  type ModelPreset,
  type TaskDetail,
  type TaskEvent,
  type TaskTranscriptItem,
  WebSearchProviderCreateRequestSchema,
  WebSearchProviderPatchRequestSchema
} from "@scc/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { createSccMcpServer } from "./scc-mcp-server.js";
import { SqliteWorkbenchStore } from "./sqlite-store.js";

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULT_EVENT_WINDOW = 600;
const MAX_EVENT_WINDOW = 1200;
const LIST_EVENT_WINDOW = 0;
const MAX_UI_OUTPUT_CHARS = 12000;
const MAX_UI_SUMMARY_CHARS = 8000;
const TASK_WS_HEARTBEAT_MS = 10_000;

function parseEventWindow(query: unknown, fallback = DEFAULT_EVENT_WINDOW): number {
  const value = z.object({ eventLimit: z.coerce.number().int().nonnegative().optional() }).safeParse(query);
  const limit = value.success ? value.data.eventLimit ?? fallback : fallback;
  return Math.min(Math.max(limit, 0), MAX_EVENT_WINDOW);
}

function taskForTransport(task: TaskDetail, eventLimit = DEFAULT_EVENT_WINDOW): TaskDetail {
  const events = eventLimit <= 0 ? [] : selectEventsForTransport(task.events, eventLimit).map(compactEventForTransport);
  return {
    ...task,
    events,
    pendingGuidance: task.pendingGuidance.map(compactEventForTransport)
  };
}

function selectEventsForTransport(events: TaskEvent[], eventLimit: number): TaskEvent[] {
  if (eventLimit <= 0) return [];
  if (events.length <= eventLimit) return events;
  const tail = events.slice(-eventLimit);
  if (eventLimit < 50) return tail;

  const tailIds = new Set(tail.map((event) => event.id));
  const anchors = events
    .slice(0, -eventLimit)
    .filter((event) => shouldPreserveTransportAnchor(event))
    .slice(-80)
    .filter((event) => !tailIds.has(event.id));

  return [...anchors, ...tail].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function shouldPreserveTransportAnchor(event: TaskEvent): boolean {
  return (
    event.type === "task_created" ||
    event.type === "turn_started" ||
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "conversation_summary_created" ||
    event.type === "context_overflow_recovered"
  );
}

function taskTranscriptForTransport(task: TaskDetail): TaskTranscriptItem[] {
  return buildTaskTranscript(task).map(compactTranscriptItemForTransport);
}

function buildTaskTranscript(task: TaskDetail): TaskTranscriptItem[] {
  const finalStreamIds = new Set(
    task.events
      .filter((event) => event.type === "assistant_message")
      .map((event) => String(event.payload["streamId"] ?? ""))
      .filter(Boolean)
  );
  return task.events.filter((event) => {
    if (!isTranscriptVisibleEvent(event)) return false;
    if (event.payload["uiHidden"] === true) return false;
    if (isInlineToolMarkupEvent(event)) return false;
    if (event.type === "assistant_delta" && finalStreamIds.has(String(event.payload["streamId"] ?? ""))) return false;
    if (event.type !== "approval_pending") return true;
    const approvalId = String(event.payload["approvalId"] ?? "");
    return task.approvals.some((approval) => approval.id === approvalId && approval.status === "pending");
  });
}

function isTranscriptVisibleEvent(event: TaskEvent): boolean {
  return (
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_message" ||
    event.type === "thinking_delta" ||
    event.type === "guidance_pending" ||
    event.type === "approval_pending" ||
    event.type === "tool_result" ||
    event.type === "task_checkpoint_created" ||
    event.type === "task_rollback_completed" ||
    event.type === "task_rollback_failed" ||
    event.type === "plan_step_blocked" ||
    event.type === "web_search_result"
  );
}

function compactTranscriptItemForTransport(event: TaskTranscriptItem): TaskTranscriptItem {
  if (event.type === "assistant_message" || event.type === "assistant_delta") {
    return {
      ...event,
      summary: stripToolEvidenceBoilerplate(event.summary),
      payload: stripAssistantPayloadBoilerplate(event.payload)
    };
  }
  if (event.type !== "tool_result" && event.type !== "web_search_result") return event;
  const summary = compactTranscriptText(event.summary, MAX_UI_SUMMARY_CHARS);
  const payload: Record<string, unknown> = { ...event.payload };
  if (typeof payload["output"] === "string") payload["output"] = compactTranscriptText(payload["output"], MAX_UI_OUTPUT_CHARS);
  if (typeof payload["summary"] === "string") payload["summary"] = compactTranscriptText(payload["summary"], MAX_UI_SUMMARY_CHARS);
  return { ...event, summary, payload };
}

function compactEventForTransport(event: TaskEvent): TaskEvent {
  const summary = compactUiText(event.summary, MAX_UI_SUMMARY_CHARS);
  const payload: Record<string, unknown> = { ...event.payload };
  if (typeof payload["output"] === "string") payload["output"] = compactUiText(payload["output"], MAX_UI_OUTPUT_CHARS);
  if (typeof payload["delta"] === "string") payload["delta"] = compactUiText(payload["delta"], MAX_UI_OUTPUT_CHARS);
  if (typeof payload["summary"] === "string") payload["summary"] = compactUiText(payload["summary"], MAX_UI_SUMMARY_CHARS);
  return { ...event, summary, payload };
}

function isInlineToolMarkupEvent(event: TaskEvent): boolean {
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return false;
  const text = [
    event.summary,
    typeof event.payload["message"] === "string" ? event.payload["message"] : "",
    typeof event.payload["delta"] === "string" ? event.payload["delta"] : "",
    typeof event.payload["text"] === "string" ? event.payload["text"] : ""
  ]
    .filter(Boolean)
    .join("\n");
  return /<function_calls\b|<invoke\s+name=/i.test(text);
}

function compactUiText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[UI preview truncated: ${omitted} characters omitted. Full evidence is retained by SCC.]`;
}

function compactTranscriptText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[Output truncated: ${omitted} characters omitted. Full evidence is available in the audit log.]`;
}

function stripAssistantPayloadBoilerplate(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  for (const key of ["message", "delta", "text"]) {
    if (typeof next[key] === "string") next[key] = stripToolEvidenceBoilerplate(next[key]);
  }
  return next;
}

function stripToolEvidenceBoilerplate(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface AppOptions {
  workbench?: AgentWorkbench;
  mcpRegistry?: McpRegistry;
  logger?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    const requestId = generateRequestId();
    request.log.error({ err: error, requestId }, "Unhandled server error");
    return reply.code(500).send({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      requestId
    });
  });
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type"]
  });
  await app.register(websocket);

  const events = new TaskEventBroadcaster();
  const runtime = options.workbench
    ? { workbench: options.workbench, mcpRegistry: options.mcpRegistry }
    : createDefaultRuntime((event) => events.publish(event));
  const workbench = runtime.workbench;
  const mcpRegistry = runtime.mcpRegistry;
  const closeRuntime = "close" in runtime ? runtime.close : undefined;
  app.addHook("onClose", async () => closeRuntime?.());
  if (!options.workbench) await bootstrapMimoProviderFromApiKeyDoc(workbench);
  await workbench.ensureDefaultScheduledTasks();
  await workbench.recoverInterruptedTasks();
  const scheduler = options.workbench
    ? undefined
    : setInterval(() => {
        void workbench.runDueScheduledTasks().catch((error) => app.log.warn({ err: error }, "Scheduled task processing failed"));
      }, 60_000);
  app.addHook("onClose", async () => {
    if (scheduler) clearInterval(scheduler);
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/tasks", async () => (await workbench.listTasks()).map((task) => taskForTransport(task, LIST_EVENT_WINDOW)));

  app.post("/api/tasks/title", async (request, reply) => {
    const input = TaskTitleRequestSchema.parse(request.body);
    try {
      return await workbench.generateTaskTitle(input);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? redactSensitiveText(error.message) : "Unable to generate title" });
    }
  });

  app.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskRequestSchema.parse(request.body);
    try {
      const task = await workbench.startTask(input.goal, input.title, input.folderId, input.attachmentIds);
      return reply.code(201).send(task);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/task-folders", async () => workbench.listTaskFolders());

  app.post("/api/task-folders", async (request, reply) => {
    const input = TaskFolderCreateRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await workbench.createTaskFolder(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/task-folders/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskFolderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateTaskFolder(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.delete("/api/task-folders/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskFolderDeleteRequestSchema.parse(request.body ?? {});
    try {
      return reply.code(200).send(await workbench.deleteTaskFolder(id, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.post("/api/task-folders/:id/clear", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskFolderClearRequestSchema.parse(request.body);
    try {
      return reply.code(200).send(await workbench.clearTaskFolder(id, input));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const eventLimit = parseEventWindow(request.query);
    const task = await workbench.getTask(id);
    return task ? taskForTransport(task, eventLimit) : reply.code(404).send({ error: "Task not found" });
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateTask(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.delete("/api/tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskDeleteRequestSchema.parse(request.body ?? {});
    try {
      return await workbench.deleteTask(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tasks/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const eventLimit = parseEventWindow(request.query);
    const task = await workbench.getTask(id);
    return task ? selectEventsForTransport(task.events, eventLimit).map(compactEventForTransport) : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/transcript", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? taskTranscriptForTransport(task) : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/attachments", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? workbench.listTaskAttachments(id) : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/summaries", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? workbench.listConversationSummaries(id) : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/checkpoints", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? workbench.listTaskCheckpoints(id) : reply.code(404).send({ error: "Task not found" });
  });

  app.post("/api/tasks/:id/rollback/preview", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskRollbackRequestSchema.parse(request.body ?? {});
    try {
      return await workbench.previewTaskRollback(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") || message.includes("No checkpoint") ? 404 : 400).send({ error: message });
    }
  });

  app.post("/api/tasks/:id/rollback", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = TaskRollbackRequestSchema.parse(request.body ?? {});
    try {
      return await workbench.rollbackTask(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") || message.includes("No checkpoint") ? 404 : 400).send({ error: message });
    }
  });

  app.get("/api/tasks/:id/turns", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.listTaskTurns(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks/:id/turns/:turnId/revert", async (request, reply) => {
    const { id, turnId } = z.object({ id: z.string(), turnId: z.string() }).parse(request.params);
    try {
      return await workbench.revertTaskTurn(id, turnId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.post("/api/tasks/:id/turns/:turnId/edit", async (request, reply) => {
    const { id, turnId } = z.object({ id: z.string(), turnId: z.string() }).parse(request.params);
    const input = TaskTurnEditRequestSchema.parse(request.body);
    try {
      return await workbench.editTaskTurn(id, turnId, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.post("/api/task-attachments", async (request, reply) => {
    const input = TaskAttachmentUploadRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await workbench.uploadTaskAttachment(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/task-attachments/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteTaskAttachment(id);
    return reply.code(204).send();
  });

  app.get("/api/tasks/:id/events/ws", { websocket: true }, async (socket, request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const eventLimit = parseEventWindow(request.query);
    const task = await workbench.getTask(id);
    safeSocketSend(socket, {
      type: "snapshot",
      events: task ? selectEventsForTransport(task.events, eventLimit).map(compactEventForTransport) : [],
      transcript: task ? taskTranscriptForTransport(task) : []
    });
    const unsubscribe = events.subscribe(id, (event) => safeSocketSend(socket, { type: "event", event: compactEventForTransport(event) }));
    const heartbeat = setInterval(() => {
      safeSocketSend(socket, { type: "heartbeat", taskId: id, timestamp: new Date().toISOString() });
    }, TASK_WS_HEARTBEAT_MS);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  app.post("/api/tasks/:id/messages", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = MessageRequestSchema.parse(request.body);
    try {
      return await workbench.appendMessageInBackground(id, input.content, input.attachmentIds);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks/:id/control", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ControlRequestSchema.parse(request.body);
    try {
      return await workbench.controlInBackground(id, input.action);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks/:id/approvals/:approvalId", async (request, reply) => {
    const { id, approvalId } = z.object({ id: z.string(), approvalId: z.string() }).parse(request.params);
    const input = ApprovalRequestSchema.parse(request.body);
    try {
      return await workbench.decideApprovalInBackground(id, approvalId, input.decision);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/experiences", async () => workbench.listExperiences());
  app.get("/api/task-memories", async () => workbench.listTaskMemories());
  app.get("/api/patterns", async () => workbench.listPatterns());

  app.post("/api/experiences/:id/promote", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return reply.code(201).send(await workbench.promoteExperience(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not eligible") ? 400 : 404).send({ error: message });
    }
  });

  app.get("/api/skills", async () => workbench.listSkills());
  app.post("/api/skills", async (request, reply) => {
    const input = SkillCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createSkill(input));
  });
  app.get("/api/skills/duplicates", async () => workbench.listSkillDuplicates());
  app.post("/api/skills/bulk-delete", async (request) => {
    const input = SkillBulkDeleteRequestSchema.parse(request.body);
    return workbench.bulkDeleteSkills(input.skillIds);
  });
  app.post("/api/skills/cleanup-duplicates", async () => workbench.cleanupDuplicateSkills());
  app.get("/api/skill-conflicts", async () => workbench.listSkillConflicts());
  app.get("/api/skill-curator", async () => workbench.listSkillCuratorItems());

  app.get("/api/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const skill = await workbench.getSkill(id);
    return skill ? skill : reply.code(404).send({ error: "Skill not found" });
  });

  app.patch("/api/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = SkillUpdateRequestSchema.or(SkillStatusPatchSchema).parse(request.body);
    try {
      return await workbench.updateSkill(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteSkill(id);
    return reply.code(204).send();
  });

  app.post("/api/skills/:id/merge", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = SkillMergeRequestSchema.parse(request.body);
    try {
      return await workbench.mergeSkills({ ...input, targetSkillId: input.targetSkillId ?? id });
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/skills/:id/corrections", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = SkillCorrectionRequestSchema.parse(request.body);
    try {
      return await workbench.correctSkill(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/skills/:id/export", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.exportSkill(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/mcp/servers", async () => requireMcp(mcpRegistry).listServers());

  app.post("/api/mcp/servers", async (request, reply) => {
    const input = McpServerCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await requireMcp(mcpRegistry).createServer(input));
  });

  app.patch("/api/mcp/servers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = McpServerPatchRequestSchema.parse(request.body);
    try {
      return await requireMcp(mcpRegistry).patchServer(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/mcp/servers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireMcp(mcpRegistry).deleteServer(id);
    return reply.code(204).send();
  });

  app.post("/api/mcp/servers/:id/connect", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return reply.code(202).send(await requireMcp(mcpRegistry).connectServer(id));
  });

  app.post("/api/mcp/servers/:id/disconnect", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return requireMcp(mcpRegistry).disconnectServer(id);
  });

  app.get("/api/mcp/tools", async () => requireMcp(mcpRegistry).listTools());

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/api/mcp/server",
    handler: async (request, reply) => {
      const server = createSccMcpServer(workbench);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
      await server.connect(transport as never);
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack();
    }
  });

  app.get("/api/permissions/global", async () => workbench.listGlobalPermissions());

  app.post("/api/permissions/global", async (request, reply) => {
    const input = GlobalPermissionRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.grantGlobalPermission(input.riskCategory, input.reason));
  });

  app.delete("/api/permissions/global/:riskCategory", async (request, reply) => {
    const { riskCategory } = z.object({ riskCategory: z.string() }).parse(request.params);
    const parsed = GlobalPermissionRequestSchema.shape.riskCategory.parse(riskCategory);
    await workbench.revokeGlobalPermission(parsed);
    return reply.code(204).send();
  });

  app.get("/api/preferences", async () => workbench.getPreferences());

  app.patch("/api/preferences", async (request) => {
    const input = PreferencesPatchSchema.parse(request.body);
    return workbench.updatePreferences(input);
  });

  app.get("/api/user-profile", async () => workbench.getUserProfileDocument());

  app.patch("/api/user-profile", async (request) => {
    const input = MemoryDocumentPatchSchema.parse(request.body);
    return workbench.updateUserProfileDocument(input);
  });

  app.get("/api/project-memory", async (request) => {
    const query = z.object({ folderId: z.string().optional() }).parse(request.query);
    return workbench.getProjectMemoryDocument(query.folderId ?? "default");
  });

  app.patch("/api/project-memory", async (request) => {
    const query = z.object({ folderId: z.string().optional() }).parse(request.query);
    const input = MemoryDocumentPatchSchema.parse(request.body);
    return workbench.updateProjectMemoryDocument(query.folderId ?? "default", input);
  });

  app.post("/api/project-memory/compact", async (request) => {
    const query = z.object({ folderId: z.string().optional() }).parse(request.query);
    return workbench.compactProjectMemoryDocument(query.folderId ?? "default");
  });

  app.get("/api/model-providers", async () => workbench.listModelProviders());

  app.post("/api/model-providers", async (request, reply) => {
    const input = ModelProviderCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createModelProvider(input));
  });

  app.patch("/api/model-providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ModelProviderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateModelProvider(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/model-providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteModelProvider(id);
    return reply.code(204).send();
  });

  app.get("/api/scheduled-tasks", async () => workbench.listScheduledTasks());

  app.post("/api/scheduled-tasks", async (request, reply) => {
    const input = ScheduledTaskCreateRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await workbench.createScheduledTask(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ScheduledTaskPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateScheduledTask(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.delete("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      await workbench.deleteScheduledTask(id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/web-search/providers", async () => workbench.listWebSearchProviders());

  app.post("/api/web-search/providers", async (request, reply) => {
    const input = WebSearchProviderCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createWebSearchProvider(input));
  });

  app.patch("/api/web-search/providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = WebSearchProviderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateWebSearchProvider(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/web-search/providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteWebSearchProvider(id);
    return reply.code(204).send();
  });

  app.get("/api/reflections", async () => workbench.listReflectionSessions());

  app.post("/api/reflections", async (request, reply) => reply.code(201).send(await workbench.runReflection()));

  app.get("/api/project-memories", async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return workbench.listProjectMemories(query.projectId);
  });

  app.post("/api/project-memories", async (request, reply) => {
    const input = ProjectMemoryCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createProjectMemory(input));
  });

  app.delete("/api/project-memories/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteProjectMemory(id);
    return reply.code(204).send();
  });

  app.get("/api/knowledge", async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return workbench.listKnowledgeItems(query.projectId);
  });

  app.post("/api/knowledge", async (request, reply) => {
    const input = KnowledgeCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createKnowledgeItem(input));
  });

  app.post("/api/knowledge/upload", async (request, reply) => {
    const input = KnowledgeUploadRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.uploadKnowledgeFile(input));
  });

  app.post("/api/knowledge/search", async (request) => {
    const input = KnowledgeSearchRequestSchema.parse(request.body);
    return workbench.searchKnowledge(input);
  });

  app.post("/api/knowledge/:id/reindex", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.reindexKnowledgeItem(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/knowledge/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = KnowledgePatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateKnowledgeItem(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/knowledge/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteKnowledgeItem(id);
    return reply.code(204).send();
  });

  app.get("/api/prompt-cache-stats", async (request) => {
    const query = z.object({ taskId: z.string().optional() }).parse(request.query);
    return workbench.listPromptCacheStats(query.taskId);
  });

  app.get("/api/integrations", async () => workbench.listIntegrationProviders());

  app.post("/api/integrations", async (request, reply) => {
    const input = IntegrationProviderCreateRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await workbench.createIntegrationProvider(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/integrations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = IntegrationProviderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateIntegrationProvider(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.delete("/api/integrations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteIntegrationProvider(id);
    return reply.code(204).send();
  });

  app.post("/api/integrations/:id/connect", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.connectIntegrationProvider(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/:id/disconnect", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.disconnectIntegrationProvider(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/discord/interactions", async (request, reply) => {
    const input = DiscordInteractionRequestSchema.parse(request.body);
    try {
      return await workbench.handleDiscordInteraction(input);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/feishu/events", async (request, reply) => {
    const input = FeishuEventRequestSchema.parse(request.body);
    if (input.challenge) return { challenge: input.challenge };
    try {
      return (await workbench.handleFeishuEvent(input)) ?? { ok: true, ignored: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
}

async function bootstrapMimoProviderFromApiKeyDoc(workbench: AgentWorkbench): Promise<void> {
  if ((await workbench.listModelProviders()).length > 0) return;
  const config = loadOpenAiProviderConfig();
  if (!config.apiKey || !config.baseURL || !config.model) return;
  if (!isMimoProviderConfig(config)) return;

  await workbench.createModelProvider({
    vendor: "mimo",
    label: "Mimo",
    protocol: "openai_compatible",
    baseUrl: config.baseURL,
    apiKey: config.apiKey,
    models: [toBootstrapModelPreset(config.model)],
    defaultModelId: config.model,
    enabled: true,
    makeActive: true
  });
}

function isMimoProviderConfig(config: OpenAIProviderConfigWithName): boolean {
  const haystack = [config.providerName, config.baseURL, config.model].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes("mimo") || haystack.includes("xiaomi") || haystack.includes("xiaomimimo");
}

function toBootstrapModelPreset(model: string): ModelPreset {
  return {
    id: model,
    label: model,
    contextWindow: contextWindowForModel(model),
    supportsTools: true,
    supportsThinking: true
  };
}

function contextWindowForModel(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("mimo-v2.5")) return 1_048_576;
  if (normalized.includes("gpt-5.4")) return 1_050_000;
  if (normalized.includes("gpt-5.5")) return 1_000_000;
  if (normalized.includes("1m")) return 1_000_000;
  if (normalized.includes("400k")) return 400_000;
  if (normalized.includes("256k")) return 256_000;
  if (normalized.includes("200k")) return 200_000;
  if (normalized.includes("128k")) return 128_000;
  if (normalized.includes("64k")) return 64_000;
  return 1_048_576;
}

function createDefaultRuntime(onEvent: (event: TaskEvent) => void): { workbench: AgentWorkbench; mcpRegistry: McpRegistry; close: () => void } {
  const store = new SqliteWorkbenchStore(process.env["SCC_DB_PATH"] ?? "data/workbench.sqlite");
  const contextAssembler = new ContextAssembler(store);
  const mcpRegistry = new McpRegistry(store);
  const secretBox = new LocalSecretBox();
  const tools = new CompositeToolExecutor(new ShellToolExecutor(), [mcpRegistry, new WebSearchToolExecutor(store), new KnowledgeSearchToolExecutor(store)]);
  const workbench = new AgentWorkbench({
    store,
    contextAssembler,
    model: createModelClientFromEnvironment({
      contextAssembler,
      toolProvider: mcpRegistry,
      preferenceProvider: () => store.getPreferences(),
      providerResolver: async (): Promise<ResolvedModelProviderConfig | null> => {
        const preferences = await store.getPreferences();
        const providers = (await store.listModelProviders()).filter((provider) => provider.enabled);
        const route = preferences.modelRoute;
        const main =
          providers.find((item) => item.id === route.mainProviderId) ??
          providers.find((item) => item.id === preferences.activeModelProviderId) ??
          providers.find((item) => item.apiKeyRef) ??
          null;
        const resolved = main ? await resolveRuntimeModelProvider(store, secretBox, main) : null;
        if (!resolved || !main) return null;
        const fallbackIds = [...new Set(route.fallbackProviderIds.filter((id) => id !== main.id))];
        const fallbacks = (
          await Promise.all(
            fallbackIds
              .map((id) => providers.find((provider) => provider.id === id))
              .filter((provider): provider is ModelProviderRecord => Boolean(provider))
              .map((provider) => resolveRuntimeModelProvider(store, secretBox, provider))
          )
        ).filter((provider): provider is ResolvedModelProviderConfig => Boolean(provider));
        return fallbacks.length > 0 ? { ...resolved, fallbacks } : resolved;
      }
    }),
    tools,
    toolRiskProvider: mcpRegistry,
    onEvent
  });
  return { workbench, mcpRegistry, close: () => store.close() };
}

async function resolveRuntimeModelProvider(
  store: SqliteWorkbenchStore,
  secretBox: LocalSecretBox,
  provider: ModelProviderRecord
): Promise<ResolvedModelProviderConfig | null> {
  if (!provider.apiKeyRef) return null;
  const encrypted = await store.getModelProviderSecret(provider.id);
  if (!encrypted) return null;
  return {
    providerId: provider.id,
    protocol: provider.protocol,
    apiKey: secretBox.decrypt(encrypted),
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    model: provider.defaultModelId
  };
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/(OPENAI_API_KEY\s*=\s*)\S+/gi, "$1[redacted]");
}

function safeSocketSend(socket: { send: (data: string) => void }, payload: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The client may have closed between the event publish and this send.
  }
}

function requireMcp(registry: McpRegistry | undefined): McpRegistry {
  if (!registry) throw new Error("MCP registry is not configured.");
  return registry;
}

class TaskEventBroadcaster {
  private readonly subscribers = new Map<string, Set<(event: TaskEvent) => void>>();

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const listeners = this.subscribers.get(taskId) ?? new Set<(event: TaskEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  publish(event: TaskEvent): void {
    for (const listener of this.subscribers.get(event.taskId) ?? []) {
      listener(event);
    }
  }
}
