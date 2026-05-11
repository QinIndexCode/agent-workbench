import type { TaskDetail, ToolCall } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  raw?: Record<string, unknown>;
}

export interface ModelTraceEvent {
  kind: "request" | "response" | "error" | "provider_fallback";
  timestamp: string;
  streamId: string;
  provider?: {
    providerId?: string;
    protocol?: string;
    model?: string;
    baseURL?: string;
  } | undefined;
  payload: Record<string, unknown>;
}

export type ModelTurn =
  | { kind: "final"; message: string; streamId?: string; usage?: ModelUsage }
  | { kind: "tool_calls"; calls: ToolCall[]; streamId?: string; usage?: ModelUsage }
  | { kind: "empty_response"; reason: string; streamId?: string; usage?: ModelUsage; rawPayload?: Record<string, unknown> };

export interface ModelStreamHandlers {
  streamId: string;
  signal?: AbortSignal;
  onAssistantDelta: (delta: string) => Promise<void>;
  onThinkingDelta: (delta: string) => Promise<void>;
  onProviderFallback?: (event: { fromProviderId?: string; toProviderId?: string; fromModel?: string; toModel?: string; category: string; reason: string }) => Promise<void>;
  onTrace?: (event: ModelTraceEvent) => Promise<void>;
}

export interface ModelClient {
  next(task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn>;
}

export class FallbackModelClient implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const denied = [...task.events].reverse().find(
      (event) => event.type === "approval_resolved" && event.payload["decision"] === "deny"
    );
    if (denied) {
      return {
        kind: "final",
        message: "The requested tool action was denied. I need a different approved path or more context."
      };
    }

    return {
      kind: "final",
      message: "I have the task recorded, but no model provider is configured. Add a model provider with an API key in Settings or provide a concrete approved tool step."
    };
  }
}

export class ConfiguredToolModelClient implements ModelClient {
  constructor(private readonly command: string) {}

  async next(task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const lastToolResultIndex = findLastEventIndex(task, "tool_result");
    const lastAssistantIndex = findLastEventIndex(task, "assistant_message");
    const lastToolResult = lastToolResultIndex >= 0 ? task.events[lastToolResultIndex] : undefined;
    const previousEvidence = lastToolResult ? String(lastToolResult.payload["output"] ?? "") : "";
    if (lastToolResult && lastToolResultIndex > lastAssistantIndex) {
      const message = previousEvidence ? summarizeToolEvidence(previousEvidence) : "Tool completed with no output.";
      await stream?.onTrace?.({
        kind: "response",
        timestamp: nowIso(),
        streamId: stream.streamId,
        payload: {
          response: {
            kind: "final",
            message
          }
        }
      });
      return { kind: "final", message };
    }

    const turn = {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "run_command", args: { command: this.command } }]
    } satisfies ModelTurn;
    await stream?.onTrace?.({
      kind: "response",
      timestamp: nowIso(),
      streamId: stream?.streamId ?? createId("model_stream"),
      payload: {
        response: turn
      }
    });
    return turn;
  }
}

function summarizeToolEvidence(output: string): string {
  const parsed = parseJson(output);
  if (Array.isArray(parsed)) {
    const rows = parsed.slice(0, 5).map((item) => {
      if (!isRecord(item)) return `- ${String(item).slice(0, 160)}`;
      const name = String(item["ProcessName"] ?? item["Name"] ?? item["process"] ?? "process");
      const cpu = item["CPU"] === undefined ? "" : ` CPU ${formatNumber(item["CPU"])}`;
      const memoryRaw = Number(item["WorkingSet64"] ?? item["MemoryBytes"] ?? 0);
      const memory = memoryRaw > 0 ? ` memory ${Math.round(memoryRaw / 1024 / 1024)} MB` : "";
      const id = item["Id"] === undefined ? "" : ` pid ${String(item["Id"])}`;
      return `- ${name}${id}${cpu}${memory}`;
    });
    return `Top entries:\n${rows.join("\n")}`;
  }
  if (isRecord(parsed) && typeof parsed["summary"] === "string") {
    return String(parsed["summary"]);
  }
  const compact = output.length > 1400 ? `${output.slice(0, 1400)}\n... output truncated ...` : output;
  return compact;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(1).replace(/\\.0$/, "") : String(value);
}

function findLastEventIndex(task: TaskDetail, type: TaskDetail["events"][number]["type"]): number {
  for (let index = task.events.length - 1; index >= 0; index--) {
    if (task.events[index]?.type === type) return index;
  }
  return -1;
}
