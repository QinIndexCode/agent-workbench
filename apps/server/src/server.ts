import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
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
  parseWecomCallbackXml,
  sanitizeSensitiveText,
  sanitizeSensitiveValue,
  type OpenAIProviderConfigWithName,
  type ResolvedModelProviderConfig
} from "@agent-workbench/core";
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
  KnowledgeModelDownloadRequestSchema,
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
  ProjectMemoryPatchRequestSchema,
  ScheduledTaskCreateRequestSchema,
  ScheduledTaskPatchRequestSchema,
  SlackEventRequestSchema,
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
  TelegramUpdateRequestSchema,
  type ModelProviderRecord,
  type ModelPreset,
  type TaskDetail,
  type TaskEvent,
  type TaskTranscriptItem,
  WecomCallbackRequestSchema,
  WebSearchProviderCreateRequestSchema,
  WebSearchProviderPatchRequestSchema
} from "@agent-workbench/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { createAgentWorkbenchMcpServer } from "./agent-workbench-mcp-server.js";
import { SqliteWorkbenchStore } from "./sqlite-store.js";

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULT_EVENT_WINDOW = 600;
const MAX_EVENT_WINDOW = 1200;
const LIST_EVENT_WINDOW = 0;
const MAX_UI_OUTPUT_CHARS = 12000;
const MAX_UI_SUMMARY_CHARS = 8000;
const MAX_TRANSCRIPT_STREAM_INLINE_CHARS = 4000;
const TASK_WS_HEARTBEAT_MS = 10_000;
const SESSION_HEADER = "x-agent-workbench-session";
const LEGACY_SESSION_HEADER = "x-scc-session";
const AGENT_CARD_CACHE_SECONDS = 300;
const LOCALHOST_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5182",
  "http://localhost:5182",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
] as const;

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

function parseEventWindow(query: unknown, fallback = DEFAULT_EVENT_WINDOW): number {
  const value = z.object({ eventLimit: z.coerce.number().int().nonnegative().optional() }).safeParse(query);
  const limit = value.success ? value.data.eventLimit ?? fallback : fallback;
  return Math.min(Math.max(limit, 0), MAX_EVENT_WINDOW);
}

function parseIncludeChildren(query: unknown, fallback = false): boolean {
  const value = z.object({ includeChildren: z.coerce.boolean().optional() }).safeParse(query);
  return value.success ? value.data.includeChildren ?? fallback : fallback;
}

function taskForTransport(task: TaskDetail, eventLimit = DEFAULT_EVENT_WINDOW): TaskDetail {
  const events = eventLimit <= 0 ? [] : selectEventsForTransport(task.events, eventLimit).map(compactEventForTransport);
  return {
    ...task,
    approvals: sanitizeSensitiveValue(task.approvals),
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
      .filter((event) => event.type === "assistant_message" && !isInlineToolMarkupEvent(event))
      .map((event) => String(event.payload["streamId"] ?? ""))
      .filter(Boolean)
  );
  const finalFallbacks = buildAssistantFinalFallbacks(task.events);
  const normalized = task.events.filter((event) => {
    if (!isTranscriptVisibleEvent(event)) return false;
    if (event.payload["uiHidden"] === true) return false;
    if (isInlineToolMarkupEvent(event)) return false;
    if (event.type === "assistant_delta" && finalStreamIds.has(String(event.payload["streamId"] ?? ""))) return false;
    if (event.type !== "approval_pending") return true;
    const approvalId = String(event.payload["approvalId"] ?? "");
    return task.approvals.some((approval) => approval.id === approvalId && approval.status === "pending");
  }).map((event) => applyAssistantFinalFallback(event, finalFallbacks));
  return coalesceTranscriptStreamEvents(
    normalized.filter((event) => event.type !== "assistant_message" || Boolean(visibleAssistantText(event)))
  );
}

function coalesceTranscriptStreamEvents(events: TaskTranscriptItem[]): TaskTranscriptItem[] {
  if (events.length <= 1) return events;
  const merged: TaskTranscriptItem[] = [];
  for (const event of events) {
    if (mergeTranscriptStreamDelta(merged, event)) continue;
    merged.push(event);
  }
  return merged;
}

function mergeTranscriptStreamDelta(events: TaskTranscriptItem[], incoming: TaskTranscriptItem): boolean {
  if (!isTranscriptStreamDelta(incoming) || events.length === 0) return false;
  const candidate = events[events.length - 1];
  if (!candidate || !isTranscriptStreamDelta(candidate)) return false;
  if (candidate.type !== incoming.type) return false;
  if (transcriptStreamKey(candidate) !== transcriptStreamKey(incoming)) return false;
  const mergedDelta = appendTranscriptStreamText(transcriptStreamText(candidate), transcriptStreamText(incoming));
  const mergedSummary = appendTranscriptStreamText(candidate.summary ?? "", incoming.summary ?? transcriptStreamText(incoming));
  events[events.length - 1] = {
    ...candidate,
    createdAt: incoming.createdAt,
    summary: mergedSummary,
    payload: {
      ...candidate.payload,
      ...incoming.payload,
      delta: mergedDelta
    }
  };
  return true;
}

function isTranscriptStreamDelta(event: TaskTranscriptItem): event is TaskTranscriptItem & { type: "assistant_delta" | "thinking_delta" } {
  return event.type === "assistant_delta" || event.type === "thinking_delta";
}

function transcriptStreamKey(event: TaskTranscriptItem): string {
  return `${event.type}:${String(event.payload["streamId"] ?? event.id)}`;
}

function transcriptStreamText(event: TaskTranscriptItem): string {
  const delta = event.payload["delta"];
  return typeof delta === "string" ? delta : event.summary ?? "";
}

function appendTranscriptStreamText(current: string, delta: string): string {
  if (!current) return current + delta;
  return `${current}${assistantStreamSeparator(current, delta)}${delta}`;
}

function collectTranscriptStreamText(
  events: TaskEvent[],
  type: "assistant_delta" | "thinking_delta",
  streamId: string
): string {
  let current = "";
  for (const event of events) {
    if (event.type !== type) continue;
    if (String(event.payload["streamId"] ?? "") !== streamId) continue;
    current = appendTranscriptStreamText(current, transcriptStreamText(event));
  }
  return current.trim();
}

function buildAssistantFinalFallbacks(events: TaskEvent[]): Map<string, string> {
  const fallbacks = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "assistant_delta") continue;
    const streamId = String(event.payload["streamId"] ?? "");
    if (!streamId) continue;
    const delta = String(event.payload["delta"] ?? event.summary ?? "");
    if (!stripToolEvidenceBoilerplate(delta)) continue;
    fallbacks.set(streamId, appendAssistantStreamText(fallbacks.get(streamId) ?? "", delta));
  }
  return fallbacks;
}

function applyAssistantFinalFallback(event: TaskEvent, fallbacks: Map<string, string>): TaskEvent {
  if (event.type !== "assistant_message") return event;
  const visible = visibleAssistantText(event);
  if (visible) return visible === event.summary ? event : { ...event, summary: visible };
  const streamId = String(event.payload["streamId"] ?? "");
  const fallback = streamId ? fallbacks.get(streamId)?.trim() : "";
  if (!fallback) return event;
  return {
    ...event,
    summary: fallback,
    payload: {
      ...event.payload,
      streamFinalFallback: true
    }
  };
}

function isTranscriptVisibleEvent(event: TaskEvent): boolean {
  return (
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_message" ||
    event.type === "thinking_delta" ||
    event.type === "subagent_spawned" ||
    event.type === "subagent_status_changed" ||
    event.type === "subagent_completed" ||
    event.type === "subagent_failed" ||
    event.type === "guidance_pending" ||
    event.type === "user_input_requested" ||
    event.type === "user_input_answered" ||
    event.type === "approval_pending" ||
    event.type === "tool_requested" ||
    event.type === "tool_started" ||
    event.type === "tool_progress" ||
    event.type === "tool_result" ||
    event.type === "model_empty_response" ||
    event.type === "model_no_progress" ||
    event.type === "task_checkpoint_created" ||
    event.type === "task_rollback_completed" ||
    event.type === "task_rollback_failed" ||
    event.type === "plan_step_blocked" ||
    event.type === "web_search_result"
  );
}

function compactTranscriptItemForTransport(event: TaskTranscriptItem): TaskTranscriptItem {
  if (event.type === "thinking_delta") {
    const fullText = transcriptStreamText(event);
    if (fullText.length > MAX_TRANSCRIPT_STREAM_INLINE_CHARS) {
      const preview = compactTranscriptText(fullText, MAX_TRANSCRIPT_STREAM_INLINE_CHARS);
      return {
        ...event,
        summary: preview,
        payload: {
          ...event.payload,
          delta: preview,
          lazyBody: true,
          fullContentChars: fullText.length
        }
      };
    }
  }
  if (event.type === "assistant_message" || event.type === "assistant_delta") {
    return {
      ...event,
      summary: visibleAssistantText(event),
      payload: stripAssistantPayloadBoilerplate(event.payload)
    };
  }
  if (event.type !== "tool_requested" && event.type !== "tool_result" && event.type !== "tool_progress" && event.type !== "tool_started" && event.type !== "web_search_result") return event;
  const summary = compactTranscriptText(event.summary, MAX_UI_SUMMARY_CHARS);
  const payload = compactToolEventPayloadForTransport(event.payload, "transcript");
  return { ...event, summary, payload };
}

function compactEventForTransport(event: TaskEvent): TaskEvent {
  const summary = compactUiText(event.summary, MAX_UI_SUMMARY_CHARS);
  const payload: Record<string, unknown> =
    event.type === "tool_requested" ||
    event.type === "tool_started" ||
    event.type === "tool_progress" ||
    event.type === "tool_result" ||
    event.type === "web_search_result"
      ? compactToolEventPayloadForTransport(event.payload, "event")
      : { ...event.payload };
  if (typeof payload["output"] === "string") payload["output"] = compactUiText(payload["output"], MAX_UI_OUTPUT_CHARS);
  if (typeof payload["delta"] === "string") payload["delta"] = compactUiText(payload["delta"], MAX_UI_OUTPUT_CHARS);
  if (typeof payload["summary"] === "string") payload["summary"] = compactUiText(payload["summary"], MAX_UI_SUMMARY_CHARS);
  return { ...event, summary, payload };
}

function compactToolEventPayloadForTransport(payload: Record<string, unknown>, mode: "event" | "transcript"): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  if (typeof next["output"] === "string") next["output"] = compactTranscriptText(next["output"], MAX_UI_OUTPUT_CHARS);
  if (typeof next["summary"] === "string") next["summary"] = compactTranscriptText(next["summary"], MAX_UI_SUMMARY_CHARS);
  if (next["args"] && typeof next["args"] === "object" && !Array.isArray(next["args"])) {
    next["args"] = compactToolArgsForTransport(next["args"] as Record<string, unknown>, mode);
  }
  return next;
}

function compactToolArgsForTransport(args: Record<string, unknown>, mode: "event" | "transcript"): Record<string, unknown> {
  const maxStringChars = mode === "transcript" ? 1200 : 1800;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "content" && typeof value === "string") {
      next[key] = compactToolArgText(value, maxStringChars, "content");
      next["contentChars"] = value.length;
      continue;
    }
    if (key === "edits" && Array.isArray(value)) {
      next[key] = value.slice(0, 12).map((item) => compactEditArgForTransport(item, maxStringChars));
      if (value.length > 12) next["omittedEditCount"] = value.length - 12;
      continue;
    }
    if (typeof value === "string") {
      next[key] = compactToolArgText(value, maxStringChars, key);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function compactEditArgForTransport(value: unknown, maxStringChars: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if ((key === "newText" || key === "expectedText") && typeof entry === "string") {
      next[key] = compactToolArgText(entry, Math.min(700, maxStringChars), key);
      next[`${key}Chars`] = entry.length;
      continue;
    }
    next[key] = entry;
  }
  return next;
}

function compactToolArgText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[${label} preview truncated: ${omitted} characters omitted.]`;
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
  return /<function_calls\b|<invoke\s+name=/i.test(text) && !stripToolEvidenceBoilerplate(text);
}

function compactUiText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[UI preview truncated: ${omitted} characters omitted. Full evidence is retained by Agent Workbench.]`;
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

function visibleAssistantText(event: TaskEvent | TaskTranscriptItem): string {
  const summary = stripToolEvidenceBoilerplate(event.summary);
  if (summary || (event.type !== "assistant_message" && event.type !== "assistant_delta")) return summary;
  for (const key of ["message", "text", "delta"]) {
    const value = event.payload[key];
    if (typeof value !== "string") continue;
    const visible = stripToolEvidenceBoilerplate(value);
    if (visible) return visible;
  }
  return "";
}

function stripToolEvidenceBoilerplate(value: string): string {
  return stripInlineToolMarkup(value)
    .split(/\r?\n/)
    .filter((line) => !/^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripInlineToolMarkup(value: string): string {
  return value
    .replace(/<function_calls\b[\s\S]*?<\/function_calls>/gi, "\n")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "\n");
}

function appendAssistantStreamText(current: string, delta: string): string {
  if (!current) return delta;
  return `${current}${assistantStreamSeparator(current, delta)}${delta}`;
}

function assistantStreamSeparator(current: string, delta: string): string {
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return "";
  const previous = current.at(-1) ?? "";
  const next = delta[0] ?? "";
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(previous + next)) return "";
  if (/[A-Za-z0-9)]/.test(previous) && /[A-Za-z0-9(]/.test(next)) return " ";
  if (/[.,;:!?]/.test(previous) && /[A-Za-z0-9]/.test(next)) return " ";
  return "";
}

export interface AppOptions {
  workbench?: AgentWorkbench;
  mcpRegistry?: McpRegistry;
  logger?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            serializers: {
              req(request) {
                return {
                  method: request.method,
                  url: sanitizeUrlForLogs(request.url),
                  host: request.host,
                  remoteAddress: request.ip
                };
              }
            },
            redact: {
              paths: [`req.headers.${SESSION_HEADER}`, `req.headers.${LEGACY_SESSION_HEADER}`],
              censor: "[redacted-session]"
            }
          }
  });
  const sessionToken = createSessionToken();
  const allowedOrigins = resolveAllowedOrigins();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(/^application\/([a-z0-9.+-]+\+)?json(?:;.*)?$/i, { parseAs: "string" }, (request, body, done) => {
    try {
      const rawBody = typeof body === "string" ? body : body.toString("utf8");
      (request as RequestWithRawBody).rawBody = rawBody;
      done(null, rawBody.trim().length > 0 ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  app.addContentTypeParser(/^(application|text)\/xml(?:;.*)?$/i, { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as RequestWithRawBody).rawBody = rawBody;
    done(null, rawBody);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    const requestId = generateRequestId();
    request.log.error({ err: errorForLogs(error), requestId }, "Unhandled server error");
    return reply.code(500).send({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      requestId
    });
  });
  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || isAllowedOrigin(origin, allowedOrigins));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", SESSION_HEADER, LEGACY_SESSION_HEADER]
  });
  await app.register(websocket);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
      return reply.code(403).send({ error: "Origin not allowed." });
    }
    const path = requestPathname(request);
    if (isPublicPath(path)) return;
    if (/^\/api\/tasks\/[^/]+\/events\/ws$/i.test(path) || request.raw.headers.upgrade === "websocket") {
      const session = readRequestQueryValue(request, "session");
      if (!session || session !== sessionToken) {
        return reply.code(401).send({ error: "Missing or invalid session token." });
      }
      return;
    }
    const session = readSessionHeader(request.headers[SESSION_HEADER] ?? request.headers[LEGACY_SESSION_HEADER]);
    if (session !== sessionToken) {
      return reply.code(401).send({ error: "Missing or invalid session token." });
    }
  });

  const events = new TaskEventBroadcaster();
  const runtime = options.workbench
    ? { workbench: options.workbench, mcpRegistry: options.mcpRegistry }
    : createDefaultRuntime((event) => events.publish(event));
  const workbench = runtime.workbench;
  const mcpRegistry = runtime.mcpRegistry;
  const closeRuntime = "close" in runtime ? runtime.close : undefined;
  app.addHook("onClose", async () => closeRuntime?.());
  if (!options.workbench) await bootstrapMimoProviderFromApiKeyDoc(workbench);
  await workbench.ensureDefaultSkills();
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

  const startedAt = Date.now();
  app.get("/health", async () => ({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    version: "0.1.0",
    timestamp: new Date().toISOString()
  }));
  app.get("/.well-known/agent-card.json", async (request, reply) => {
    const card = buildAgentCard(request);
    const serialized = JSON.stringify(card);
    const etag = `"${createHash("sha256").update(serialized).digest("base64url").slice(0, 32)}"`;
    reply.header("cache-control", `public, max-age=${AGENT_CARD_CACHE_SECONDS}`);
    reply.header("etag", etag);
    reply.type("application/a2a+json; charset=utf-8");
    if (ifNoneMatchValues(request.headers["if-none-match"]).includes(etag)) {
      return reply.code(304).send();
    }
    return reply.send(card);
  });
  app.get("/api/session/bootstrap", async () => ({ sessionToken }));

  app.get("/api/tasks", async (request) => {
    const includeChildren = parseIncludeChildren(request.query);
    return (await workbench.listTasks({ includeChildren })).map((task) => taskForTransport(task, LIST_EVENT_WINDOW));
  });

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
      const task = await workbench.startTask(input.goal, input.title, input.folderId, input.attachmentIds, {
        runMode: input.runMode,
        ...(input.targetLimits ? { targetLimits: input.targetLimits } : {})
      });
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

  app.get("/api/tasks/:id/children", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? workbench.listTaskChildren(id) : reply.code(404).send({ error: "Task not found" });
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

  app.get("/api/tasks/:id/stream-text", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({
      streamId: z.string().min(1),
      type: z.enum(["assistant_delta", "thinking_delta"])
    }).parse(request.query);
    const task = await workbench.getTask(id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    const text = collectTranscriptStreamText(task.events, query.type, query.streamId);
    return text ? { streamId: query.streamId, type: query.type, text } : reply.code(404).send({ error: "Stream not found" });
  });

  app.get("/api/tasks/:id/attachments", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? workbench.listTaskAttachments(id) : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/attachments/:attachmentId/content", async (request, reply) => {
    const { id, attachmentId } = z.object({ id: z.string(), attachmentId: z.string() }).parse(request.params);
    try {
      const { attachment, bytes } = await workbench.readTaskAttachmentContent(id, attachmentId);
      return reply
        .header("content-type", attachment.mimeType || "application/octet-stream")
        .header("content-length", String(bytes.byteLength))
        .header("x-content-type-options", "nosniff")
        .send(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
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
      return await workbench.decideApprovalInBackground(id, approvalId, input.decision, input.reason);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/experiences", async () => workbench.listExperiences());
  app.get("/api/task-memories", async () => workbench.listTaskMemories());
  app.delete("/api/task-memories/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteTaskMemory(id);
    return reply.code(204).send();
  });
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
    try {
      return reply.code(201).send(await requireMcp(mcpRegistry).createServer(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/mcp/servers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = McpServerPatchRequestSchema.parse(request.body);
    try {
      return await requireMcp(mcpRegistry).patchServer(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
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
      const server = createAgentWorkbenchMcpServer(workbench);
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
    try {
      return reply.code(201).send(await workbench.createModelProvider(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/model-providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ModelProviderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateModelProvider(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.post("/api/model-providers/:id/test", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.testModelProvider(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
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
    try {
      return reply.code(201).send(await workbench.createWebSearchProvider(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/web-search/providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = WebSearchProviderPatchRequestSchema.parse(request.body);
    try {
      return await workbench.updateWebSearchProvider(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
    }
  });

  app.delete("/api/web-search/providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteWebSearchProvider(id);
    return reply.code(204).send();
  });

  const listCuratorRuns = async () => workbench.listReflectionSessions();
  const createCuratorRun = async (_request: unknown, reply: FastifyReply) => reply.code(201).send(await workbench.runReflection());
  const clearCuratorRuns = async (_request: unknown, reply: FastifyReply) => {
    await workbench.clearReflectionSessions();
    return reply.code(204).send();
  };
  const deleteCuratorRun = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteReflectionSession(id);
    return reply.code(204).send();
  };

  app.get("/api/curator/runs", listCuratorRuns);
  app.post("/api/curator/runs", createCuratorRun);
  app.delete("/api/curator/runs", clearCuratorRuns);
  app.delete("/api/curator/runs/:id", deleteCuratorRun);

  app.get("/api/reflections", listCuratorRuns);
  app.post("/api/reflections", createCuratorRun);
  app.delete("/api/reflections", clearCuratorRuns);
  app.delete("/api/reflections/:id", deleteCuratorRun);

  app.get("/api/project-memories", async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return workbench.listProjectMemories(query.projectId);
  });

  app.post("/api/project-memories", async (request, reply) => {
    const input = ProjectMemoryCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createProjectMemory(input));
  });

  app.patch("/api/project-memories/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ProjectMemoryPatchRequestSchema.parse(request.body);
    return workbench.updateProjectMemory(id, input);
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

  app.get("/api/knowledge/models", async () => workbench.getKnowledgeModelStatus());

  app.post("/api/knowledge/models/download", async (request, reply) => {
    const input = KnowledgeModelDownloadRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await workbench.downloadKnowledgeModel(input));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
    const signature = String(request.headers["x-signature-ed25519"] ?? "");
    const timestamp = String(request.headers["x-signature-timestamp"] ?? "");
    const rawBody = (request as RequestWithRawBody).rawBody ?? JSON.stringify(request.body ?? {});
    try {
      if (input.type === 1) {
        await workbench.handleDiscordInteraction(input, { rawBody, signature, timestamp }).catch((error) => {
          throw error;
        });
        return { type: 1 };
      }
      const task = await workbench.handleDiscordInteraction(input, { rawBody, signature, timestamp });
      if (!task) {
        return {
          type: 4,
          data: { content: "Verified Discord interaction, but this payload is not yet supported." }
        };
      }
      return {
        type: 4,
        data: { content: `Created Agent Workbench task: ${task.title}` },
        taskId: task.id
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /signature|public key/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post("/api/integrations/feishu/events", async (request, reply) => {
    const input = FeishuEventRequestSchema.parse(request.body);
    try {
      const task = await workbench.handleFeishuEvent(input);
      if (input.challenge) return { challenge: input.challenge };
      return task ? { ok: true, taskId: task.id } : { ok: true, ignored: true, reason: "Verified Feishu event, but this payload is not yet supported." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /verification token/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post("/api/integrations/slack/events", async (request, reply) => {
    const input = SlackEventRequestSchema.parse(request.body);
    const signature = String(request.headers["x-slack-signature"] ?? "");
    const timestamp = String(request.headers["x-slack-request-timestamp"] ?? "");
    const rawBody = (request as RequestWithRawBody).rawBody ?? JSON.stringify(request.body ?? {});
    try {
      const task = await workbench.handleSlackEvent(input, { rawBody, signature, timestamp });
      if (input.type === "url_verification" && input.challenge) return { challenge: input.challenge };
      return task ? { ok: true, taskId: task.id } : { ok: true, ignored: true, reason: "Verified Slack event, but this payload is not yet supported." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /signature|signing secret/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post("/api/integrations/telegram/updates", async (request, reply) => {
    const input = TelegramUpdateRequestSchema.parse(request.body);
    const secretToken = String(request.headers["x-telegram-bot-api-secret-token"] ?? "");
    try {
      const task = await workbench.handleTelegramUpdate(input, { secretToken });
      return task ? { ok: true, taskId: task.id } : { ok: true, ignored: true, reason: "Verified Telegram update, but this payload is not yet supported." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /secret token/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.get("/api/integrations/wecom/callback", async (request, reply) => {
    const query = z.object({
      integrationId: z.string().optional(),
      msg_signature: z.string().default(""),
      timestamp: z.string().default(""),
      nonce: z.string().default(""),
      echostr: z.string().default("")
    }).parse(request.query);
    try {
      const echo = await workbench.verifyWecomCallback(query.integrationId, {
        msgSignature: query.msg_signature,
        timestamp: query.timestamp,
        nonce: query.nonce,
        echostr: query.echostr
      });
      return reply.type("text/plain").send(echo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /signature|token|aes/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post("/api/integrations/wecom/callback", async (request, reply) => {
    const query = z.object({
      integrationId: z.string().optional(),
      msg_signature: z.string().default(""),
      timestamp: z.string().default(""),
      nonce: z.string().default("")
    }).parse(request.query);
    const rawBody = (request as RequestWithRawBody).rawBody ?? String(request.body ?? "");
    const parsedBody = typeof request.body === "string" ? parseWecomCallbackXml(request.body) : WecomCallbackRequestSchema.parse(request.body);
    const input = WecomCallbackRequestSchema.parse({ ...parsedBody, ...(query.integrationId ? { integrationId: query.integrationId } : {}) });
    try {
      const task = await workbench.handleWecomCallback(input, {
        msgSignature: query.msg_signature,
        timestamp: query.timestamp,
        nonce: query.nonce,
        rawBody
      });
      return task ? { ok: true, taskId: task.id } : { ok: true, ignored: true, reason: "Verified WeCom callback, but this payload is not yet supported." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /signature|token|aes/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
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
  const store = new SqliteWorkbenchStore(process.env["AGENT_WORKBENCH_DB_PATH"] ?? process.env["SCC_DB_PATH"] ?? "data/workbench.sqlite");
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
  return sanitizeSensitiveText(input).replace(/((?:OPENAI_API_KEY|AGENT_WORKBENCH_OPENAI_API_KEY|SCC_OPENAI_API_KEY)\s*=\s*)\S+/gi, "$1[redacted]");
}

function errorForLogs(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
    return {
      type: error.name || "Error",
      message: redactSensitiveText(error.message),
      ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
      ...(record.code !== undefined ? { code: redactSensitiveText(String(record.code)) } : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.statusCode !== undefined ? { statusCode: record.statusCode } : {})
    };
  }
  return { type: typeof error, message: redactSensitiveText(String(error)) };
}

function createSessionToken(): string {
  return randomBytes(24).toString("hex");
}

interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
  provider: { organization: string; url: string };
  version: string;
  documentationUrl: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  securitySchemes: Record<string, { apiKeySecurityScheme: { name: string; in: "header"; description: string } }>;
  security: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
    inputModes: string[];
    outputModes: string[];
  }>;
}

function buildAgentCard(request: FastifyRequest): AgentCard {
  const baseUrl = publicBaseUrl(request);
  return {
    name: "Agent Workbench",
    description:
      "Local-first, permissioned agent workbench. This public card enables discovery; operational APIs are protected by a per-process local session token from /api/session/bootstrap.",
    supportedInterfaces: [
      {
        url: new URL("/api", baseUrl).href,
        protocolBinding: "https://github.com/QinIndexCode/agent-workbench/protocols/local-http",
        protocolVersion: "0.1.0"
      }
    ],
    provider: {
      organization: "Agent Workbench",
      url: "https://github.com/QinIndexCode/agent-workbench"
    },
    version: "0.1.0",
    documentationUrl: "https://github.com/QinIndexCode/agent-workbench#readme",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false
    },
    securitySchemes: {
      agentWorkbenchSession: {
        apiKeySecurityScheme: {
          name: SESSION_HEADER,
          in: "header",
          description: "Fetch a transient session token from /api/session/bootstrap on the same local server process."
        }
      }
    },
    security: [{ agentWorkbenchSession: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "permissioned-task-workbench",
        name: "Permissioned Task Workbench",
        description: "Create, inspect, continue, control, and review local agent tasks through protected HTTP APIs.",
        tags: ["tasks", "approvals", "local-http", "agent-workbench"],
        examples: ["Create a task from a goal, watch its events, then approve or deny pending tool requests."],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json", "text/plain"]
      },
      {
        id: "workspace-tool-execution",
        name: "Workspace Tool Execution",
        description: "Run workspace-scoped file, shell, browser, and computer-control workflows behind explicit permission gates.",
        tags: ["workspace", "tools", "permissions", "automation"],
        examples: ["Inspect a repository, edit files through safe file tools, run focused tests, and return evidence."],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json", "text/plain"]
      },
      {
        id: "memory-knowledge-skills",
        name: "Memory, Knowledge, And Skills",
        description: "Manage project memory, knowledge documents, reusable skills, curator runs, and reflection records through protected APIs.",
        tags: ["memory", "knowledge", "skills", "reflection"],
        examples: ["Search local knowledge, export a skill, or compact project memory for a workspace."],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json", "text/plain"]
      }
    ]
  };
}

function publicBaseUrl(request: FastifyRequest): string {
  const configured = process.env["AGENT_WORKBENCH_PUBLIC_BASE_URL"]?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return withoutTrailingSlash(url.href);
    } catch {
      // Invalid public URLs should not break local startup.
    }
  }
  const proto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = proto === "https" ? "https" : "http";
  const host = sanitizePublicHost(firstHeaderValue(request.headers["x-forwarded-host"]) || firstHeaderValue(request.headers.host));
  return `${protocol}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return raw.split(",")[0]?.trim().toLowerCase() ?? "";
}

function sanitizePublicHost(value: string): string {
  return /^[a-z0-9.-]+(?::\d{1,5})?$/iu.test(value) ? value : "127.0.0.1:5177";
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function ifNoneMatchValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function resolveAllowedOrigins(): Set<string> {
  const configured = (process.env["AGENT_WORKBENCH_ALLOWED_ORIGINS"] ?? process.env["SCC_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...LOCALHOST_ALLOWED_ORIGINS, ...configured]);
}

function isAllowedOrigin(origin: string, allowedOrigins: Set<string>): boolean {
  return allowedOrigins.has(origin);
}

function sanitizeUrlForLogs(url: string | undefined): string {
  if (!url) return "/";
  return url.replace(/([?&]session=)[^&]+/gi, "$1[redacted-session]");
}

function requestPathname(request: FastifyRequest): string {
  try {
    return new URL(request.raw.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return request.raw.url?.split("?")[0] ?? "/";
  }
}

function readRequestQueryValue(request: FastifyRequest, key: string): string | null {
  try {
    return new URL(request.raw.url ?? "/", "http://127.0.0.1").searchParams.get(key);
  } catch {
    return null;
  }
}

function isPublicPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/.well-known/agent-card.json" ||
    path === "/api/session/bootstrap" ||
    path === "/api/integrations/discord/interactions" ||
    path === "/api/integrations/feishu/events" ||
    path === "/api/integrations/slack/events" ||
    path === "/api/integrations/telegram/updates" ||
    path === "/api/integrations/wecom/callback"
  );
}

function readSessionHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
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
