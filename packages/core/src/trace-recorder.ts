import type { TaskDetail, TaskEvent } from "@agent-workbench/shared";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelTraceEvent } from "./fallback-model.js";
import { sanitizeSensitiveValue } from "./secrets.js";
import type { ToolProgressUpdate } from "./tools.js";
import { findWorkspaceRoot } from "./workspace-root.js";

const TRACE_MAX_STRING_CHARS = 4000;
const TRACE_MAX_ARRAY_ITEMS = 24;
const TRACE_MAX_OBJECT_KEYS = 24;
const TRACE_MAX_DEPTH = 5;
const TRACE_PROGRESS_TAIL_CHARS = 320;
const TRACE_PROGRESS_MESSAGE_CHARS = 240;
const TRACE_MODEL_EXCERPT_CHARS = 360;
const TRACE_MODEL_TOOL_ARG_CHARS = 220;
const TRACE_MODEL_TOOL_LIMIT = 8;
const TRACE_ATTENTION_EVIDENCE_LIMIT = 6;

export class TaskTraceRecorder {
  private readonly locks = new Map<string, Promise<void>>();
  readonly root: string;

  constructor(configuredRoot: string | undefined) {
    this.root = resolveTraceRoot(configuredRoot);
  }

  async safeAppendTask(task: TaskDetail, entry: Record<string, unknown>): Promise<void> {
    try {
      await this.appendTask(task, entry);
    } catch {
      // Debug trace output must never break the task runtime.
    }
  }

  async safeAppendModel(task: TaskDetail, event: ModelTraceEvent): Promise<void> {
    await this.safeAppendTask(task, {
      kind: `model_${event.kind}`,
      timestamp: event.timestamp,
      streamId: event.streamId,
      ...(event.provider ? { provider: event.provider } : {}),
      payload: summarizeModelTracePayload(event.kind, event.payload)
    });
  }

  private async appendTask(task: TaskDetail, entry: Record<string, unknown>): Promise<void> {
    const previous = this.locks.get(task.id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.locks.set(task.id, queued);
    await previous.catch(() => undefined);
    try {
      const tracePath = resolve(this.root, task.id, "trace.jsonl");
      const compactEntry = compactTraceEntry({
        taskId: task.id,
        taskStatus: task.status,
        traceRoot: this.root,
        ...entry
      });
      await mkdir(dirname(tracePath), { recursive: true });
      await appendFile(tracePath, `${JSON.stringify(compactEntry)}\n`, "utf8");
    } finally {
      release();
      if (this.locks.get(task.id) === queued) this.locks.delete(task.id);
    }
  }
}

export function compactToolProgressUpdate(progress: ToolProgressUpdate): ToolProgressUpdate {
  const message = excerptTraceText(progress.message, TRACE_PROGRESS_MESSAGE_CHARS);
  const tail = tailTraceText(progress.tail, TRACE_PROGRESS_TAIL_CHARS);
  return {
    ...(progress.status ? { status: progress.status } : {}),
    ...(progress.targetPath ? { targetPath: progress.targetPath } : {}),
    ...(progress.operation ? { operation: progress.operation } : {}),
    ...(progress.changes ? { changes: progress.changes } : {}),
    ...(progress.progress ? { progress: progress.progress } : {}),
    ...(message ? { message } : {}),
    ...(tail ? { tail } : {}),
    ...(progress.displayMode ? { displayMode: progress.displayMode } : {})
  };
}

export function summarizeToolProgressForTrace(progress: ToolProgressUpdate): Record<string, unknown> {
  return {
    ...(progress.status ? { status: progress.status } : {}),
    ...(progress.operation ? { operation: progress.operation } : {}),
    ...(progress.targetPath ? { targetPath: progress.targetPath } : {}),
    ...(progress.progress ? { progress: compactTraceValue(progress.progress, 0) } : {}),
    ...(progress.displayMode ? { displayMode: progress.displayMode } : {}),
    ...(progress.message ? { message: progress.message } : {}),
    ...(progress.tail ? { tail: progress.tail } : {}),
    ...(progress.changes ? {
      changes: {
        path: progress.changes.path,
        addedLines: progress.changes.addedLines,
        removedLines: progress.changes.removedLines,
        ...(progress.changes.operation ? { operation: progress.changes.operation } : {})
      }
    } : {})
  };
}

export function summarizeEventForTrace(event: TaskEvent | undefined): Record<string, unknown> | undefined {
  if (!event) return undefined;
  return {
    id: event.id,
    type: event.type,
    summary: event.summary,
    createdAt: event.createdAt
  };
}

function resolveTraceRoot(configured: string | undefined): string {
  const value =
    configured?.trim() ||
    process.env["AGENT_WORKBENCH_TRACE_ROOT"]?.trim() ||
    process.env["SCC_TRACE_ROOT"]?.trim();
  return resolve(value || resolve(findWorkspaceRoot(), "data", "logs", "model-traces"));
}

function summarizeModelTracePayload(kind: ModelTraceEvent["kind"], payload: Record<string, unknown>): Record<string, unknown> {
  if (kind === "request") return summarizeModelRequestTracePayload(payload);
  if (kind === "response") return summarizeModelResponseTracePayload(payload);
  if (kind === "error") {
    return {
      ...(typeof payload["message"] === "string" ? { message: excerptTraceText(payload["message"], TRACE_MODEL_EXCERPT_CHARS) } : {}),
      ...(typeof payload["stack"] === "string" ? { stackPreview: tailTraceText(payload["stack"], TRACE_MODEL_EXCERPT_CHARS) } : {})
    };
  }
  return {
    ...("fromProviderId" in payload ? { fromProviderId: payload["fromProviderId"] } : {}),
    ...("toProviderId" in payload ? { toProviderId: payload["toProviderId"] } : {}),
    ...("fromModel" in payload ? { fromModel: payload["fromModel"] } : {}),
    ...("toModel" in payload ? { toModel: payload["toModel"] } : {}),
    ...("category" in payload ? { category: payload["category"] } : {}),
    ...(typeof payload["reason"] === "string" ? { reason: excerptTraceText(payload["reason"], TRACE_MODEL_EXCERPT_CHARS) } : {})
  };
}

function summarizeModelRequestTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const request = recordFromUnknown(payload["request"]);
  return {
    ...("taskStatus" in payload ? { taskStatus: payload["taskStatus"] } : {}),
    ...("eventCount" in payload ? { eventCount: payload["eventCount"] } : {}),
    ...(Object.keys(recordFromUnknown(payload["attention"])).length > 0 ? { attention: summarizeTraceAttention(recordFromUnknown(payload["attention"])) } : {}),
    ...(Object.keys(request).length > 0 ? { request: summarizeModelRequestBody(request) } : {})
  };
}

function summarizeModelResponseTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const response = recordFromUnknown(payload["response"]);
  const usage = summarizeModelUsageForTrace(recordFromUnknown(response["usage"]));
  const kind = String(response["kind"] ?? "");
  if (kind === "tool_calls") {
    const calls = Array.isArray(response["calls"]) ? response["calls"] : [];
    return {
      response: {
        kind,
        toolCallCount: calls.length,
        toolCalls: calls.slice(0, TRACE_MODEL_TOOL_LIMIT).map((call) => summarizeToolCallForTrace(recordFromUnknown(call))),
        omittedToolCalls: Math.max(0, calls.length - TRACE_MODEL_TOOL_LIMIT),
        ...(usage ? { usage } : {})
      }
    };
  }
  if (kind === "final") {
    return {
      response: {
        kind,
        messageExcerpt: excerptTraceText(response["message"], TRACE_MODEL_EXCERPT_CHARS),
        ...(usage ? { usage } : {})
      }
    };
  }
  return {
    response: {
      kind: kind || "unknown",
      ...(typeof response["reason"] === "string" ? { reason: excerptTraceText(response["reason"], TRACE_MODEL_EXCERPT_CHARS) } : {}),
      ...(usage ? { usage } : {})
    }
  };
}

function summarizeTraceAttention(attention: Record<string, unknown>): Record<string, unknown> {
  const evidenceRefs = Array.isArray(attention["evidenceRefs"]) ? attention["evidenceRefs"].map((item) => String(item ?? "")) : [];
  const tokenBudget = recordFromUnknown(attention["tokenBudget"]);
  return {
    ...(attention["activeNode"] ? { activeNode: compactTraceValue(attention["activeNode"], 0) } : {}),
    ...(evidenceRefs.length > 0 ? {
      evidenceRefCount: evidenceRefs.length,
      evidenceRefs: evidenceRefs.slice(-TRACE_ATTENTION_EVIDENCE_LIMIT),
      omittedEvidenceRefs: Math.max(0, evidenceRefs.length - TRACE_ATTENTION_EVIDENCE_LIMIT)
    } : {}),
    ...(Object.keys(tokenBudget).length > 0 ? { tokenBudget } : {})
  };
}

function summarizeModelRequestBody(request: Record<string, unknown>): Record<string, unknown> {
  const toolNames = extractTraceToolNames(request);
  return {
    ...(typeof request["model"] === "string" ? { model: request["model"] } : {}),
    ...("stream" in request ? { stream: Boolean(request["stream"]) } : {}),
    ...(Number.isFinite(Number(request["max_tokens"])) ? { maxTokens: Number(request["max_tokens"]) } : {}),
    ...(Number.isFinite(Number(request["max_completion_tokens"])) ? { maxCompletionTokens: Number(request["max_completion_tokens"]) } : {}),
    ...(Number.isFinite(Number(request["temperature"])) ? { temperature: Number(request["temperature"]) } : {}),
    ...(request["tool_choice"] !== undefined ? { toolChoice: compactTraceValue(request["tool_choice"], 0) } : {}),
    ...(toolNames.length > 0 ? {
      toolSummary: {
        count: toolNames.length,
        names: toolNames.slice(0, TRACE_MODEL_TOOL_LIMIT),
        omittedNames: Math.max(0, toolNames.length - TRACE_MODEL_TOOL_LIMIT)
      }
    } : {}),
    messageSummary: summarizeTraceMessages(request)
  };
}

function summarizeTraceMessages(request: Record<string, unknown>): Record<string, unknown> {
  const summaries = extractTraceMessageSummaries(request);
  const roleCounts: Record<string, number> = {};
  for (const item of summaries) {
    roleCounts[item.role] = (roleCounts[item.role] ?? 0) + 1;
  }
  return {
    count: summaries.length,
    roleCounts,
    ...(findTraceMessageExcerpt(summaries, "system", false) ? { systemExcerpt: findTraceMessageExcerpt(summaries, "system", false) } : {}),
    ...(findTraceMessageExcerpt(summaries, "user", true) ? { latestUserExcerpt: findTraceMessageExcerpt(summaries, "user", true) } : {}),
    ...(findTraceMessageExcerpt(summaries, "assistant", true) ? { latestAssistantExcerpt: findTraceMessageExcerpt(summaries, "assistant", true) } : {}),
    ...(findTraceMessageExcerpt(summaries, "tool", true) ? { latestToolExcerpt: findTraceMessageExcerpt(summaries, "tool", true) } : {})
  };
}

function extractTraceMessageSummaries(request: Record<string, unknown>): Array<{ role: string; excerpt: string }> {
  const output: Array<{ role: string; excerpt: string }> = [];
  const push = (role: string, value: unknown): void => {
    const excerpt = excerptTraceText(value, TRACE_MODEL_EXCERPT_CHARS);
    if (excerpt) output.push({ role, excerpt });
  };

  const systemInstruction = recordFromUnknown(request["systemInstruction"]);
  const systemParts = Array.isArray(systemInstruction["parts"]) ? systemInstruction["parts"] : [];
  for (const part of systemParts) {
    const text = recordFromUnknown(part)["text"];
    if (typeof text === "string") push("system", text);
  }

  if (Array.isArray(request["messages"])) {
    for (const rawMessage of request["messages"]) {
      const message = recordFromUnknown(rawMessage);
      const role = String(message["role"] ?? "unknown");
      const content = summarizeTraceMessageContent(message["content"]);
      if (content) push(role, content);
      const toolCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
      for (const rawCall of toolCalls.slice(0, TRACE_MODEL_TOOL_LIMIT)) {
        const call = recordFromUnknown(rawCall);
        const fn = recordFromUnknown(call["function"]);
        const argsPreview = excerptTraceText(fn["arguments"], TRACE_MODEL_TOOL_ARG_CHARS);
        const name = String(fn["name"] ?? "tool");
        push("assistant", `${name}${argsPreview ? ` ${argsPreview}` : ""}`);
      }
    }
  }

  if (Array.isArray(request["contents"])) {
    for (const rawContent of request["contents"]) {
      const content = recordFromUnknown(rawContent);
      const role = content["role"] === "model" ? "assistant" : String(content["role"] ?? "user");
      const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
      const partTexts = parts
        .map((part) => summarizeTraceMessageContent(part))
        .filter((item): item is string => Boolean(item));
      if (partTexts.length > 0) push(role, partTexts.join(" | "));
    }
  }

  return output;
}

function summarizeTraceMessageContent(value: unknown): string {
  if (typeof value === "string") return excerptTraceText(value, TRACE_MODEL_EXCERPT_CHARS);
  if (!value) return "";
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => summarizeTraceMessageContent(item))
      .filter((item): item is string => Boolean(item));
    return excerptTraceText(parts.join(" | "), TRACE_MODEL_EXCERPT_CHARS);
  }
  const record = recordFromUnknown(value);
  if (typeof record["text"] === "string") return excerptTraceText(record["text"], TRACE_MODEL_EXCERPT_CHARS);
  if (typeof record["content"] === "string") return excerptTraceText(record["content"], TRACE_MODEL_EXCERPT_CHARS);
  if (record["tool_result"]) return excerptTraceText(JSON.stringify(record["tool_result"]), TRACE_MODEL_EXCERPT_CHARS);
  if (record["tool_use_id"]) {
    return excerptTraceText(`${String(record["type"] ?? "tool_result")} ${String(record["tool_use_id"] ?? "")} ${String(record["content"] ?? "")}`, TRACE_MODEL_EXCERPT_CHARS);
  }
  if (record["functionCall"]) {
    const fn = recordFromUnknown(record["functionCall"]);
    return excerptTraceText(`${String(fn["name"] ?? "functionCall")} ${JSON.stringify(fn["args"] ?? {})}`, TRACE_MODEL_EXCERPT_CHARS);
  }
  if (record["functionResponse"]) {
    const fn = recordFromUnknown(record["functionResponse"]);
    return excerptTraceText(`${String(fn["name"] ?? "functionResponse")} ${JSON.stringify(fn["response"] ?? {})}`, TRACE_MODEL_EXCERPT_CHARS);
  }
  return excerptTraceText(JSON.stringify(compactTraceValue(record, 0)), TRACE_MODEL_EXCERPT_CHARS);
}

function extractTraceToolNames(request: Record<string, unknown>): string[] {
  const names: string[] = [];
  const tools = Array.isArray(request["tools"]) ? request["tools"] : [];
  for (const rawTool of tools) {
    const tool = recordFromUnknown(rawTool);
    const fn = recordFromUnknown(tool["function"]);
    if (typeof fn["name"] === "string" && fn["name"].trim()) {
      names.push(fn["name"].trim());
      continue;
    }
    if (typeof tool["name"] === "string" && tool["name"].trim()) {
      names.push(tool["name"].trim());
      continue;
    }
    const declarations = Array.isArray(tool["functionDeclarations"]) ? tool["functionDeclarations"] : [];
    for (const rawDeclaration of declarations) {
      const declaration = recordFromUnknown(rawDeclaration);
      if (typeof declaration["name"] === "string" && declaration["name"].trim()) names.push(declaration["name"].trim());
    }
  }
  return names;
}

function summarizeToolCallForTrace(call: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(call["id"] ? { id: call["id"] } : {}),
    ...(call["toolName"] ? { toolName: call["toolName"] } : {}),
    ...(call["args"] !== undefined ? { argsPreview: excerptTraceText(JSON.stringify(call["args"]), TRACE_MODEL_TOOL_ARG_CHARS) } : {})
  };
}

function summarizeModelUsageForTrace(usage: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(usage).length === 0) return undefined;
  const summary: Record<string, unknown> = {};
  if (Number.isFinite(Number(usage["inputTokens"]))) summary["inputTokens"] = Number(usage["inputTokens"]);
  if (Number.isFinite(Number(usage["outputTokens"]))) summary["outputTokens"] = Number(usage["outputTokens"]);
  if (Number.isFinite(Number(usage["cachedTokens"]))) summary["cachedTokens"] = Number(usage["cachedTokens"]);
  if (summary["inputTokens"] === undefined && Number.isFinite(Number(usage["prompt_tokens"]))) summary["inputTokens"] = Number(usage["prompt_tokens"]);
  if (summary["outputTokens"] === undefined && Number.isFinite(Number(usage["completion_tokens"]))) summary["outputTokens"] = Number(usage["completion_tokens"]);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function findTraceMessageExcerpt(
  messages: Array<{ role: string; excerpt: string }>,
  role: string,
  fromEnd: boolean
): string {
  const ordered = fromEnd ? [...messages].reverse() : messages;
  return ordered.find((item) => item.role === role)?.excerpt ?? "";
}

function excerptTraceText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)} ...[trace excerpt truncated ${omitted} chars]`;
}

function tailTraceText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `[tail truncated ${omitted} chars]\n${text.slice(-maxChars)}`;
}

function compactTraceEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return compactTraceValue(sanitizeSensitiveValue(entry), 0) as Record<string, unknown>;
}

function compactTraceValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && value.length > TRACE_MAX_STRING_CHARS) {
    const omitted = value.length - TRACE_MAX_STRING_CHARS;
    return `${value.slice(0, TRACE_MAX_STRING_CHARS)}\n...[trace truncated ${omitted} chars]`;
  }
  if (typeof value !== "object") return value;
  if (depth >= TRACE_MAX_DEPTH) return "[trace truncated depth]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, TRACE_MAX_ARRAY_ITEMS).map((item) => compactTraceValue(item, depth + 1));
    if (value.length <= TRACE_MAX_ARRAY_ITEMS) return kept;
    return [...kept, `[trace truncated ${value.length - TRACE_MAX_ARRAY_ITEMS} items]`];
  }
  const entries = Object.entries(recordFromUnknown(value));
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, TRACE_MAX_OBJECT_KEYS)) {
    compacted[key] = compactTraceValue(entry, depth + 1);
  }
  if (entries.length > TRACE_MAX_OBJECT_KEYS) {
    compacted["_traceTruncatedKeys"] = entries.length - TRACE_MAX_OBJECT_KEYS;
  }
  return compacted;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
