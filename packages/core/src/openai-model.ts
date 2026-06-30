import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import OpenAI from "openai";
import type { TaskDetail, TaskEvent, ToolCall, UserPreferences } from "@agent-workbench/shared";
import type { CanonicalModelMessage, ContextAssembler } from "./context-assembler.js";
import { createId, nowIso } from "./ids.js";
import type { ModelClient, ModelStreamHandlers, ModelTraceEvent, ModelTurn, ModelUsage } from "./fallback-model.js";
import { ConfiguredToolModelClient, FallbackModelClient } from "./fallback-model.js";
import { isDirectAnswerGoal, toolAllowedByTaskGraph } from "./task-graph.js";

const DEFAULT_PROVIDER_OUTPUT_TOKENS = 4096;
const MAX_PROVIDER_OUTPUT_TOKENS = 64000;
const DEFAULT_PROMPT_CACHE_MODE = "auto";
const OPENAI_EXTENDED_PROMPT_CACHE_RETENTION = "24h";
const LOCAL_RESPONSE_CACHE_MAX_ENTRIES = 128;
const LOCAL_RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
const OPENAI_COMPATIBLE_PROMPT_CACHE_KEY_HOSTS = new Set([
  "api.openai.com",
  "api.moonshot.cn",
  "platform.kimi.com",
  "api.kimi.com",
  "api.xiaomimimo.com",
  "token-plan-cn.xiaomimimo.com",
  "token-plan-sgp.xiaomimimo.com",
  "token-plan-ams.xiaomimimo.com"
]);

export type PromptCacheMode = "auto" | "always" | "off";

export interface OpenAIModelClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  contextAssembler?: ContextAssembler | undefined;
  toolProvider?: ModelToolProvider | undefined;
  preferenceProvider?: (() => Promise<UserPreferences>) | undefined;
  providerResolver?: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;
  promptCacheMode?: PromptCacheMode;
}

export interface ResolvedModelProviderConfig {
  providerId?: string;
  protocol: "openai_compatible" | "anthropic_messages" | "gemini";
  apiKey: string;
  baseURL?: string;
  model: string;
  fallbacks?: ResolvedModelProviderConfig[];
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelToolProvider {
  listModelTools(): Promise<ModelToolDefinition[]>;
}

type ToolUseMode = "auto" | "disabled";

export class OpenAIModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly defaultBaseURL: string | undefined;
  private readonly defaultModel: string;
  private readonly modelTimeoutMs: number;
  private readonly clientCache = new Map<string, OpenAI>();
  private readonly contextAssembler: ContextAssembler | undefined;
  private readonly toolProvider: ModelToolProvider | undefined;
  private readonly preferenceProvider: (() => Promise<UserPreferences>) | undefined;
  private readonly providerResolver: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;
  private readonly promptCacheMode: PromptCacheMode;
  private readonly localResponseCache = new Map<string, { expiresAt: number; message: string; inputTokens: number }>();

  constructor(options: OpenAIModelClientOptions) {
    this.apiKey = options.apiKey ?? "";
    this.defaultBaseURL = options.baseURL;
    this.defaultModel = options.model ?? envValue("AGENT_WORKBENCH_MODEL", "SCC_MODEL") ?? "gpt-5.4-mini";
    this.modelTimeoutMs = Number(envValue("AGENT_WORKBENCH_MODEL_TIMEOUT_MS", "SCC_MODEL_TIMEOUT_MS") ?? 300_000);
    this.contextAssembler = options.contextAssembler;
    this.toolProvider = options.toolProvider;
    this.preferenceProvider = options.preferenceProvider;
    this.providerResolver = options.providerResolver;
    this.promptCacheMode = options.promptCacheMode ?? promptCacheModeFromEnvironment();
  }

  async next(task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const context = this.contextAssembler ? await this.contextAssembler.assemble(task) : null;
    const preferences = await this.preferenceProvider?.();
    const disabledToolFinalization = isFinalAnswerOnlyTurn(task) || isEvidenceReadyFinalSummaryTurn(task) || isArtifactReadyFinalSummaryTurn(task);
    const skipToolProvider = isInitialDirectAnswerTask(task) || isDirectAnswerTask(task) || disabledToolFinalization;
    const dynamicTools = skipToolProvider ? [] : (await this.toolProvider?.listModelTools()) ?? [];
    const modelTools = isInitialDirectAnswerTask(task) || isDirectAnswerTask(task)
      ? []
      : stableModelToolsForRequest(disabledToolFinalization
        ? selectDisabledFinalizationToolsForTask(task)
        : selectModelToolsForTask(task, dynamicTools));
    const toolUseMode: ToolUseMode = disabledToolFinalization ? "disabled" : "auto";
    return await this.nextWithProviderFallbacks(task, context, preferences, modelTools, toolUseMode, stream);
  }

  private async nextWithProviderFallbacks(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    preferences: UserPreferences | undefined,
    modelTools: ModelToolDefinition[],
    toolUseMode: ToolUseMode,
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    const resolved = await this.providerResolver?.();
    const providers = resolved ? [resolved, ...(resolved.fallbacks ?? [])] : [undefined];
    let lastError: unknown;
    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index];
      try {
        return await this.nextSingleProvider(task, context, preferences, modelTools, toolUseMode, provider, stream);
      } catch (error) {
        lastError = error;
        const nextProvider = providers[index + 1];
        if (!nextProvider || !isFallbackableModelError(error)) throw error;
        await emitModelTrace(stream, {
          kind: "provider_fallback",
          timestamp: nowIso(),
          streamId: stream?.streamId ?? createId("model_stream"),
          provider: providerTraceMeta(provider?.providerId, provider?.protocol, provider?.model, provider?.baseURL),
          payload: {
            fromProviderId: provider?.providerId,
            fromModel: provider?.model,
            toProviderId: nextProvider.providerId,
            toModel: nextProvider.model,
            category: classifyModelError(error),
            reason: error instanceof Error ? error.message : String(error)
          }
        });
        await stream?.onProviderFallback?.({
          ...(provider?.providerId ? { fromProviderId: provider.providerId } : {}),
          ...(provider?.model ? { fromModel: provider.model } : {}),
          ...(nextProvider.providerId ? { toProviderId: nextProvider.providerId } : {}),
          toModel: nextProvider.model,
          category: classifyModelError(error),
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Model provider failed."));
  }

  private async nextSingleProvider(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    preferences: UserPreferences | undefined,
    modelTools: ModelToolDefinition[],
    toolUseMode: ToolUseMode,
    provider: ResolvedModelProviderConfig | undefined,
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    if (provider?.protocol === "anthropic_messages") return this.nextAnthropic(task, context, provider, toolUseMode === "disabled" ? [] : modelTools, stream);
    if (provider?.protocol === "gemini") return this.nextGemini(task, context, provider, toolUseMode === "disabled" ? [] : modelTools, stream);

    const preferenceModel =
      preferences?.activeModelProviderId || preferences?.providerBaseUrl?.trim()
        ? preferences.defaultModel?.trim()
        : "";
    const model = provider?.model || preferenceModel || this.defaultModel;
    const baseURL = normalizeBaseURL(provider?.baseURL || preferences?.providerBaseUrl?.trim() || this.defaultBaseURL);
    const apiKey = provider?.apiKey || this.apiKey;
    if (!apiKey) {
      return { kind: "final", message: "No model provider is configured. Add a model provider with an API key in Settings." };
    }
    const client = this.clientFor(baseURL, apiKey);
    const callSignal = this.createCallSignal(stream?.signal);
    const disableThinking = shouldDisableThinkingForOpenAICompatible();
    const replayReasoningContent = !disableThinking && shouldReplayReasoningContentForOpenAICompatible(provider, model, baseURL);
    const messages = toOpenAIChatMessages(contextMessages(context, task), { replayReasoningContent });
    const inlineToolCallsAllowed = modelTools.length > 0 && toolUseMode !== "disabled";
    const localCacheKey = localResponseCacheKey(task, model, baseURL, messages, modelTools, toolUseMode);
    if (localCacheKey) {
      const cached = this.readLocalResponseCache(localCacheKey);
      if (cached) {
        const usage: ModelUsage = {
          inputTokens: cached.inputTokens,
          outputTokens: 0,
          cachedTokens: cached.inputTokens,
          cacheSource: "local_response",
          raw: { cache_source: "local_response", cache_hit: true }
        };
        const turn = { kind: "final" as const, message: cached.message, inlineToolCallsAllowed, ...(stream?.streamId ? { streamId: stream.streamId } : {}), usage };
        await emitModelTrace(stream, {
          kind: "response",
          timestamp: nowIso(),
          streamId: stream?.streamId ?? createId("model_stream"),
          provider: providerTraceMeta(provider?.providerId, "openai_compatible", model, baseURL),
          payload: {
            response: turn,
            cache: { source: "local_response", hit: true }
          }
        });
        return turn;
      }
    }
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    const promptCacheKey = shouldSendOpenAIPromptCacheKey(this.promptCacheMode, baseURL)
      ? buildPromptCacheKey(model, baseURL)
      : undefined;
    if (promptCacheKey) {
      request.prompt_cache_key = promptCacheKey;
    }
    if (shouldSendOpenAIPromptCacheRetention(this.promptCacheMode, baseURL)) {
      (request as unknown as Record<string, unknown>)["prompt_cache_retention"] = OPENAI_EXTENDED_PROMPT_CACHE_RETENTION;
    }
    if (disableThinking) {
      (request as unknown as Record<string, unknown>)["thinking"] = { type: "disabled" };
    }
    if (modelTools.length > 0) {
      request.tool_choice = toolUseMode === "disabled" ? "none" : "auto";
      request.tools = modelTools as OpenAI.Chat.Completions.ChatCompletionTool[];
    }
    await emitModelTrace(stream, {
      kind: "request",
      timestamp: nowIso(),
      streamId: stream?.streamId ?? createId("model_stream"),
      provider: providerTraceMeta(provider?.providerId, "openai_compatible", model, baseURL),
      payload: {
        taskStatus: task.status,
        eventCount: task.events.length,
        attention: attentionTraceMeta(context),
        cache: {
          promptCacheMode: this.promptCacheMode,
          ...(promptCacheKey ? { promptCacheKey } : {}),
          thinking: disableThinking ? "disabled" : "provider_default",
          stablePrefixTokens: estimateOpenAIStablePrefixTokens(messages),
          toolCacheFamily: promptCacheToolFamily(modelTools, toolUseMode)
        },
        request
      }
    });
    try {
      const response = await client.chat.completions.create(
        request,
        { signal: callSignal }
      );

      const streamed = await consumeChatCompletionStream(response, stream);
      const calls = streamed.calls;
      if (calls.length > 0) {
        await emitModelTrace(stream, {
          kind: "response",
          timestamp: nowIso(),
          streamId: stream?.streamId ?? createId("model_stream"),
          provider: providerTraceMeta(provider?.providerId, "openai_compatible", model, baseURL),
          payload: {
            response: {
              kind: "tool_calls",
              calls,
              ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
              ...(streamed.usage ? { usage: streamed.usage } : {})
            }
          }
        });
        return {
          kind: "tool_calls",
          calls,
          ...(stream?.streamId ? { streamId: stream.streamId } : {}),
          ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
          ...(streamed.usage ? { usage: streamed.usage } : {})
        };
      }

      const content = streamed.content.trim();
      const finalResponse = content
        ? {
            kind: "final" as const,
            message: content,
            inlineToolCallsAllowed,
            ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
            ...(streamed.usage ? { usage: streamed.usage } : {})
          }
        : {
            kind: "empty_response" as const,
            reason: "OpenAI-compatible stream ended without content or tool calls.",
            ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
            ...(streamed.usage ? { usage: streamed.usage } : {}),
            rawPayload: streamed.diagnostics
          };
      await emitModelTrace(stream, {
        kind: "response",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider?.providerId, "openai_compatible", model, baseURL),
        payload: {
          response: finalResponse
        }
      });
      if (content && localCacheKey && isCacheableLocalFinalResponse(content, modelTools)) {
        this.writeLocalResponseCache(localCacheKey, content, estimateOpenAIRequestTokens(messages, modelTools));
      }
      return content
        ? {
            kind: "final",
            message: content,
            inlineToolCallsAllowed,
            ...(stream?.streamId ? { streamId: stream.streamId } : {}),
            ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
            ...(streamed.usage ? { usage: streamed.usage } : {})
          }
        : {
            kind: "empty_response",
            reason: "OpenAI-compatible stream ended without content or tool calls.",
            ...(stream?.streamId ? { streamId: stream.streamId } : {}),
            ...(streamed.reasoning ? { reasoningContent: streamed.reasoning } : {}),
            ...(streamed.usage ? { usage: streamed.usage } : {}),
            rawPayload: streamed.diagnostics
          };
    } catch (error) {
      await emitModelTrace(stream, {
        kind: "error",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider?.providerId, "openai_compatible", model, baseURL),
        payload: serializeTraceError(error)
      });
      throw error;
    }
  }

  private readLocalResponseCache(key: string): { message: string; inputTokens: number } | null {
    const cached = this.localResponseCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.localResponseCache.delete(key);
      return null;
    }
    this.localResponseCache.delete(key);
    this.localResponseCache.set(key, cached);
    return { message: cached.message, inputTokens: cached.inputTokens };
  }

  private writeLocalResponseCache(key: string, message: string, inputTokens: number): void {
    if (!message.trim()) return;
    this.localResponseCache.set(key, {
      expiresAt: Date.now() + LOCAL_RESPONSE_CACHE_TTL_MS,
      message,
      inputTokens
    });
    while (this.localResponseCache.size > LOCAL_RESPONSE_CACHE_MAX_ENTRIES) {
      const oldest = this.localResponseCache.keys().next().value;
      if (!oldest) break;
      this.localResponseCache.delete(oldest);
    }
  }

  private async nextAnthropic(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    provider: ResolvedModelProviderConfig,
    modelTools: ModelToolDefinition[],
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    const canonicalMessages = contextMessages(context, task);
    const systemText = systemTextFromMessages(canonicalMessages);
    const requestBody = {
      model: provider.model,
      max_tokens: responseTokenBudget(context),
      system: this.promptCacheMode !== "off"
        ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
        : systemText,
      messages: toAnthropicMessages(canonicalMessages),
      ...(modelTools.length > 0 ? { tools: modelTools.map(toAnthropicTool) } : {})
    };
    await emitModelTrace(stream, {
      kind: "request",
      timestamp: nowIso(),
      streamId: stream?.streamId ?? createId("model_stream"),
      provider: providerTraceMeta(provider.providerId, "anthropic_messages", provider.model, provider.baseURL || "https://api.anthropic.com"),
      payload: {
        taskStatus: task.status,
        eventCount: task.events.length,
        attention: attentionTraceMeta(context),
        request: requestBody
      }
    });
    try {
      const response = await fetch(`${provider.baseURL || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: this.createCallSignal(stream?.signal),
        headers: {
          "content-type": "application/json",
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as Record<string, unknown>;
      const parts = Array.isArray(payload["content"]) ? payload["content"] : [];
      const text = parts.map(extractText).filter(Boolean).join("\n").trim();
      if (text) await stream?.onAssistantDelta(text);
      const calls = parts.map(toAnthropicToolCall).filter((call): call is ToolCall => Boolean(call));
      const usage = anthropicUsage(payload);
      await emitModelTrace(stream, {
        kind: "response",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider.providerId, "anthropic_messages", provider.model, provider.baseURL || "https://api.anthropic.com"),
        payload: {
          response: calls.length > 0
            ? { kind: "tool_calls", calls, ...(usage ? { usage } : {}), rawPayload: payload }
            : text
              ? { kind: "final", message: text, ...(usage ? { usage } : {}), rawPayload: payload }
              : { kind: "empty_response", reason: "Anthropic response contained no text or tool use.", ...(usage ? { usage } : {}), rawPayload: payload }
        }
      });
      if (calls.length > 0) return { kind: "tool_calls", calls, ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}) };
      return text
        ? { kind: "final", message: text, inlineToolCallsAllowed: modelTools.length > 0, ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}) }
        : { kind: "empty_response", reason: "Anthropic response contained no text or tool use.", ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}), rawPayload: payload };
    } catch (error) {
      await emitModelTrace(stream, {
        kind: "error",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider.providerId, "anthropic_messages", provider.model, provider.baseURL || "https://api.anthropic.com"),
        payload: serializeTraceError(error)
      });
      throw error;
    }
  }

  private async nextGemini(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    provider: ResolvedModelProviderConfig,
    modelTools: ModelToolDefinition[],
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    const base = provider.baseURL || "https://generativelanguage.googleapis.com/v1beta";
    const canonicalMessages = contextMessages(context, task);
    const requestBody = {
      systemInstruction: { parts: [{ text: systemTextFromMessages(canonicalMessages) }] },
      contents: toGeminiContents(canonicalMessages),
      ...(modelTools.length > 0 ? { tools: [{ functionDeclarations: modelTools.map(toGeminiTool) }] } : {})
    };
    await emitModelTrace(stream, {
      kind: "request",
      timestamp: nowIso(),
      streamId: stream?.streamId ?? createId("model_stream"),
      provider: providerTraceMeta(provider.providerId, "gemini", provider.model, base),
      payload: {
        taskStatus: task.status,
        eventCount: task.events.length,
        attention: attentionTraceMeta(context),
        request: requestBody
      }
    });
    try {
      const response = await fetch(`${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
        method: "POST",
        signal: this.createCallSignal(stream?.signal),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as Record<string, unknown>;
      const parts = geminiParts(payload);
      const text = parts.map(extractText).filter(Boolean).join("\n").trim();
      if (text) await stream?.onAssistantDelta(text);
      const calls = parts.map(toGeminiToolCall).filter((call): call is ToolCall => Boolean(call));
      const usage = geminiUsage(payload);
      await emitModelTrace(stream, {
        kind: "response",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider.providerId, "gemini", provider.model, base),
        payload: {
          response: calls.length > 0
            ? { kind: "tool_calls", calls, ...(usage ? { usage } : {}), rawPayload: payload }
            : text
              ? { kind: "final", message: text, ...(usage ? { usage } : {}), rawPayload: payload }
              : { kind: "empty_response", reason: "Gemini response contained no text or function calls.", ...(usage ? { usage } : {}), rawPayload: payload }
        }
      });
      if (calls.length > 0) return { kind: "tool_calls", calls, ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}) };
      return text
        ? { kind: "final", message: text, inlineToolCallsAllowed: modelTools.length > 0, ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}) }
        : { kind: "empty_response", reason: "Gemini response contained no text or function calls.", ...(stream?.streamId ? { streamId: stream.streamId } : {}), ...(usage ? { usage } : {}), rawPayload: payload };
    } catch (error) {
      await emitModelTrace(stream, {
        kind: "error",
        timestamp: nowIso(),
        streamId: stream?.streamId ?? createId("model_stream"),
        provider: providerTraceMeta(provider.providerId, "gemini", provider.model, base),
        payload: serializeTraceError(error)
      });
      throw error;
    }
  }

  private createCallSignal(existingSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.modelTimeoutMs);
    if (!existingSignal) return timeoutSignal;
    if (typeof AbortSignal.any === "function") return AbortSignal.any([existingSignal, timeoutSignal]);
    if (existingSignal.aborted) return existingSignal;
    const controller = new AbortController();
    existingSignal.addEventListener("abort", () => {
      controller.abort(existingSignal.reason);
    }, { once: true });
    timeoutSignal.addEventListener("abort", () => {
      controller.abort(timeoutSignal.reason);
    }, { once: true });
    return controller.signal;
  }

  private clientFor(baseURL: string | undefined, apiKey: string): OpenAI {
    const key = `${baseURL || "__default__"}:${apiKey.slice(-8)}`;
    const cached = this.clientCache.get(key);
    if (cached) return cached;
    if (this.clientCache.size >= 20) {
      const firstKey = this.clientCache.keys().next().value;
      if (firstKey) this.clientCache.delete(firstKey);
    }
    const client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {})
    });
    this.clientCache.set(key, client);
    return client;
  }
}

interface StreamToolCallPart {
  id?: string;
  name?: string;
  arguments: string;
}

async function consumeChatCompletionStream(
  stream: AsyncIterable<unknown>,
  handlers?: ModelStreamHandlers
): Promise<{ content: string; reasoning: string; calls: ToolCall[]; usage?: ModelUsage; diagnostics: Record<string, unknown> }> {
  let content = "";
  let reasoning = "";
  const toolParts = new Map<number, StreamToolCallPart>();
  let usage: ModelUsage | undefined;
  let chunkCount = 0;
  const finishReasons = new Set<string>();

  for await (const chunk of stream) {
    chunkCount += 1;
    if (handlers?.signal?.aborted) throw new Error("Model request cancelled by user.");
    const delta = readStreamDelta(chunk);
    const finishReason = readStreamFinishReason(chunk);
    if (finishReason) finishReasons.add(finishReason);
    const chunkUsage = extractOpenAIUsage(chunk);
    if (chunkUsage) usage = chunkUsage;
    if (!delta) continue;

    const thinking = extractReasoningDelta(delta);
    if (thinking) {
      reasoning += thinking;
      await handlers?.onThinkingDelta(thinking);
    }

    const text = typeof delta["content"] === "string" ? delta["content"] : "";
    if (text) {
      content += text;
      await handlers?.onAssistantDelta(text);
    }

    const toolCalls = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
    for (const rawToolCall of toolCalls) {
      if (!isRecord(rawToolCall)) continue;
      const index = Number(rawToolCall["index"] ?? toolParts.size);
      const current = toolParts.get(index) ?? { arguments: "" };
      if (typeof rawToolCall["id"] === "string") current.id = rawToolCall["id"];
      if (isRecord(rawToolCall["function"])) {
        const fn = rawToolCall["function"];
        if (typeof fn["name"] === "string") current.name = fn["name"];
        if (typeof fn["arguments"] === "string") current.arguments += fn["arguments"];
      }
      toolParts.set(index, current);
    }

    if (isRecord(delta["function_call"])) {
      const fn = delta["function_call"];
      const current = toolParts.get(0) ?? { arguments: "" };
      if (typeof fn["name"] === "string") current.name = fn["name"];
      if (typeof fn["arguments"] === "string") current.arguments += fn["arguments"];
      toolParts.set(0, current);
    }
  }

  const calls: ToolCall[] = [...toolParts.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, part]) => Boolean(part.name))
    .map(([, part]) => ({
      id: part.id ?? createId("tool_call"),
      toolName: part.name ?? "unknown_tool",
      args: parseArgs(part.arguments || "{}")
    }));
  return {
    content,
    reasoning,
    calls,
    ...(usage ? { usage } : {}),
    diagnostics: {
      chunkCount,
      finishReasons: [...finishReasons]
    }
  };
}

export function createModelClientFromEnvironment(
  options: {
    contextAssembler?: ContextAssembler;
    toolProvider?: ModelToolProvider;
    preferenceProvider?: (() => Promise<UserPreferences>) | undefined;
    providerResolver?: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;
  } = {}
): ModelClient {
  const testToolCommand = envValue("AGENT_WORKBENCH_TEST_TOOL_COMMAND", "SCC_TEST_TOOL_COMMAND");
  if (testToolCommand) {
    return new ConfiguredToolModelClient(testToolCommand);
  }
  const config = loadOpenAiConfig();
  return config.apiKey || options.providerResolver
    ? new OpenAIModelClient({
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(options.contextAssembler ? { contextAssembler: options.contextAssembler } : {}),
        ...(options.toolProvider ? { toolProvider: options.toolProvider } : {}),
        ...(options.preferenceProvider ? { preferenceProvider: options.preferenceProvider } : {}),
        ...(options.providerResolver ? { providerResolver: options.providerResolver } : {})
      })
    : new FallbackModelClient();
}

function contextMessages(
  context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
  task: TaskDetail
): CanonicalModelMessage[] {
  if (context?.messages && context.messages.length > 0) return context.messages;
  return fallbackCanonicalMessages(task);
}

function fallbackCanonicalMessages(task: TaskDetail): CanonicalModelMessage[] {
  const system = fallbackInstructions();
  const input = buildInput(task);
  return [
    { role: "system", content: system },
    { role: "user", content: input || "No current user message is available." }
  ];
}

function systemTextFromMessages(messages: CanonicalModelMessage[]): string {
  return messages
    .filter((message): message is Extract<CanonicalModelMessage, { role: "system" }> => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n") || fallbackInstructions();
}

function toOpenAIChatMessages(
  messages: CanonicalModelMessage[],
  options: { replayReasoningContent?: boolean } = {}
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.flatMap((message): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
    if (message.role === "system") return [{ role: "system", content: message.content }];
    if (message.role === "user") {
      if (!message.imageAttachments || message.imageAttachments.length === 0) return [{ role: "user", content: message.content }];
      return [{
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...message.imageAttachments.map((image) => ({
            type: "image_url" as const,
            image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` }
          }))
        ]
      } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam];
    }
    if (message.role === "tool") {
      return [{
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      }];
    }
    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      const assistantMessage: Record<string, unknown> = {
        role: "assistant",
        content: message.content ?? ""
      };
      if (options.replayReasoningContent && message.reasoningContent) {
        assistantMessage["reasoning_content"] = message.reasoningContent;
      }
      return [assistantMessage as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam];
    }
    const assistantMessage: Record<string, unknown> = {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.args ?? {})
        }
      }))
    };
    if (options.replayReasoningContent && message.reasoningContent) {
      assistantMessage["reasoning_content"] = message.reasoningContent;
    }
    return [assistantMessage as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam];
  });
}

function shouldReplayReasoningContentForOpenAICompatible(
  provider: ResolvedModelProviderConfig | undefined,
  model: string | undefined,
  baseURL: string | undefined
): boolean {
  const mode = openAICompatibleReasoningReplayModeFromEnvironment();
  if (mode === "disabled") return false;
  if (mode === "enabled") {
    return openAICompatibleProviderFingerprint(provider, model, baseURL).includes("mimo") ||
      openAICompatibleProviderFingerprint(provider, model, baseURL).includes("xiaomimimo");
  }
  return false;
}

function openAICompatibleReasoningReplayModeFromEnvironment(): "auto" | "disabled" | "enabled" {
  const value = envValue("AGENT_WORKBENCH_OPENAI_COMPAT_REASONING_REPLAY", "SCC_OPENAI_COMPAT_REASONING_REPLAY")?.trim().toLowerCase();
  if (value === "disabled" || value === "disable" || value === "off" || value === "0" || value === "false") return "disabled";
  if (value === "enabled" || value === "enable" || value === "on" || value === "1" || value === "true") return "enabled";
  return "auto";
}

function shouldDisableThinkingForOpenAICompatible(): boolean {
  const mode = openAICompatibleThinkingModeFromEnvironment();
  if (mode === "disabled") return true;
  if (mode === "enabled") return false;
  return false;
}

function openAICompatibleThinkingModeFromEnvironment(): "auto" | "disabled" | "enabled" {
  const value = envValue("AGENT_WORKBENCH_OPENAI_COMPAT_THINKING", "SCC_OPENAI_COMPAT_THINKING")?.trim().toLowerCase();
  if (value === "disabled" || value === "disable" || value === "off" || value === "0" || value === "false") return "disabled";
  if (value === "enabled" || value === "enable" || value === "on" || value === "1" || value === "true") return "enabled";
  return "auto";
}

function openAICompatibleProviderFingerprint(
  provider: ResolvedModelProviderConfig | undefined,
  model: string | undefined,
  baseURL: string | undefined
): string {
  const fingerprint = [provider?.providerId, model, baseURL]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  return fingerprint;
}

function toAnthropicMessages(messages: CanonicalModelMessage[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const image of message.imageAttachments ?? []) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.dataBase64
          }
        });
      }
      converted.push({ role: "user", content: content.length > 0 ? content : message.content });
      continue;
    }
    if (message.role === "tool") {
      appendAnthropicToolResult(converted, message);
      continue;
    }
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.toolName,
          input: call.args ?? {}
        });
      }
    converted.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
  }
  return converted.length > 0 ? converted : [{ role: "user", content: "Continue." }];
}

function toGeminiContents(messages: CanonicalModelMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const image of message.imageAttachments ?? []) {
        parts.push({
          inlineData: {
            mimeType: image.mimeType,
            data: image.dataBase64
          }
        });
      }
      contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: "" }] });
      continue;
    }
    if (message.role === "tool") {
      appendGeminiToolResponse(contents, message);
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.toolName, args: call.args ?? {} } });
    }
    contents.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
  }
  return contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "Continue." }] }];
}

function appendAnthropicToolResult(target: Array<Record<string, unknown>>, message: Extract<CanonicalModelMessage, { role: "tool" }>): void {
  const block = {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: message.content,
    is_error: toolContentIsError(message.content)
  };
  const last = target.at(-1);
  const lastContent = Array.isArray(last?.["content"]) ? last["content"] as Array<Record<string, unknown>> : null;
  if (last?.["role"] === "user" && lastContent?.every((item) => item["type"] === "tool_result")) {
    lastContent.push(block);
    return;
  }
  target.push({ role: "user", content: [block] });
}

function appendGeminiToolResponse(target: Array<Record<string, unknown>>, message: Extract<CanonicalModelMessage, { role: "tool" }>): void {
  const part = {
    functionResponse: {
      name: message.toolName,
      response: toolContentAsGeminiResponse(message.content)
    }
  };
  const last = target.at(-1);
  const lastParts = Array.isArray(last?.["parts"]) ? last["parts"] as Array<Record<string, unknown>> : null;
  if (last?.["role"] === "user" && lastParts?.every((item) => "functionResponse" in item)) {
    lastParts.push(part);
    return;
  }
  target.push({ role: "user", parts: [part] });
}

function toolContentIsError(content: string): boolean {
  const parsed = parseJsonRecord(content);
  return parsed ? parsed["ok"] === false : /failed|denied|cancelled|canceled|error/i.test(content);
}

function toolContentAsGeminiResponse(content: string): Record<string, unknown> {
  const parsed = parseJsonRecord(content);
  return parsed ?? { output: content };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fallbackInstructions(): string {
  return [
    "You are the Agent Workbench agent.",
    "Choose the next action yourself based on the user's goal, available tools, durable memory, skills, and evidence.",
    "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
    "When a tool needs user approval, the application will ask the user; do not assume the current authorization state.",
    "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless explicitly requested.",
    "When using side-effect-free state tools such as plan_update or use_skill, do not narrate the tool mechanics, tool JSON, or success status to the user; continue with the actual task.",
    "For greetings, thanks, simple chat, and capability questions, answer directly without calling tools.",
    "When asked to test or list tools, treat it as a safe capability check; do not create files, edit memory, edit skills, or run persistent side-effect tools unless the user explicitly authorizes that scope.",
    "When the user asks what you can do, answer directly from your general capabilities; do not inspect files first.",
    "Do not claim the project name, stack, files, or runtime state until you have verified them with tool evidence.",
    "If you need a file but are unsure it exists, list or search first instead of guessing paths such as README.md.",
    "When reporting a debug fix, base the root cause and final summary only on observed tool output and source code; do not speculate about code you did not see.",
    "After debugging or editing code, the final answer should include the observed failure, exact root cause expression or file location when known, changed files, and verification result.",
    "Keep normal answers concise, calm, and product-like.",
    "Match the user's tone and the task context; keep serious debugging and incident-style work plain unless the user asks for a warmer style.",
    "Avoid hype, decorative openings, and marketing-style introductions unless the user asks for that tone.",
    "Use Markdown for readable structure when helpful: short headings, bullets, tables, and code blocks are supported."
  ].join("\n");
}

async function emitModelTrace(stream: ModelStreamHandlers | undefined, event: ModelTraceEvent): Promise<void> {
  await stream?.onTrace?.(event);
}

function providerTraceMeta(
  providerId: string | undefined,
  protocol: ResolvedModelProviderConfig["protocol"] | "openai_compatible" | undefined,
  model: string | undefined,
  baseURL: string | undefined
): ModelTraceEvent["provider"] {
  if (!providerId && !protocol && !model && !baseURL) return undefined;
  return {
    ...(providerId ? { providerId } : {}),
    ...(protocol ? { protocol } : {}),
    ...(model ? { model } : {}),
    ...(baseURL ? { baseURL } : {})
  };
}

function serializeTraceError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return { message: String(error) };
}

export function selectModelToolsForTask(task: TaskDetail, dynamicTools: ModelToolDefinition[] = []): ModelToolDefinition[] {
  if (isDirectAnswerTask(task)) return [];
  if (isFinalAnswerOnlyTurn(task)) return [];
  if (isEvidenceReadyFinalSummaryTurn(task)) return [];
  if (isArtifactReadyFinalSummaryTurn(task)) return [];
  const builtIns = toolDefinitions();
  const stableDynamicTools = [...dynamicTools].sort((left, right) => left.function.name.localeCompare(right.function.name));
  const explicitlyLimited = filterToolsForLatestUserConstraint(task, filterToolsForTaskGraph(task, [...builtIns, ...stableDynamicTools]));
  return applyTaskSpecificToolHints(task, filterOptionalModelToolsForTask(task, explicitlyLimited)).map(stabilizeModelTool);
}

function selectDisabledFinalizationToolsForTask(task: TaskDetail): ModelToolDefinition[] {
  if (isDirectAnswerTask(task)) return [];
  const tools = filterToolsForLatestUserConstraint(task, filterToolsForTaskGraph(task, toolDefinitions()));
  return applyTaskSpecificToolHints(task, filterOptionalModelToolsForTask(task, tools))
    .filter((tool) => tool.function.name !== "ask_user")
    .map(stabilizeModelTool);
}

function isDirectAnswerTask(task: TaskDetail): boolean {
  const latest = [...task.events].reverse().find((event) =>
    (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") &&
    !event.reverted
  );
  return Boolean(latest && isDirectAnswerGoal(latest.summary));
}

function isInitialDirectAnswerTask(task: TaskDetail): boolean {
  const meaningfulEvents = task.events.filter((event) =>
    !event.reverted &&
    event.type !== "task_created" &&
    event.type !== "turn_started" &&
    event.type !== "status_changed" &&
    event.type !== "task_title_updated"
  );
  return meaningfulEvents.length === 1 && meaningfulEvents[0]?.type === "user_message" && isDirectAnswerGoal(meaningfulEvents[0].summary);
}

function isFinalAnswerOnlyTurn(task: TaskDetail): boolean {
  const latest = [...task.events].reverse().find((event) =>
    !event.reverted &&
    event.type !== "turn_started" &&
    event.type !== "token_usage_recorded" &&
    event.type !== "prompt_cache_stats" &&
    event.type !== "assistant_delta" &&
    event.type !== "thinking_delta"
  );
  if (!latest || latest.type !== "model_no_progress") return false;
  if (latest.payload["status"] !== "finalizing") return false;
  const reason = String(latest.payload["reason"] ?? "");
  return reason === "finalization_before_turn_limit" || reason === "finalization_after_internal_continuation";
}

function isEvidenceReadyFinalSummaryTurn(task: TaskDetail): boolean {
  const passedIndex = findLatestPassedVerificationIndex(task.events);
  if (passedIndex < 0) return false;
  if (findLatestUserIndex(task.events) > passedIndex) return false;
  if (findLatestAssistantMessageIndex(task.events) > passedIndex) return false;
  if (findLatestFileMutationIndex(task.events) > passedIndex) return false;
  if (hasFailedVerificationAfter(task.events, passedIndex)) return false;
  if (hasUnresolvedToolRequestAfter(task.events, passedIndex)) return false;
  const taskText = taskToolSelectionText(task);
  if (!/final|summary|summari[sz]e|report|result|verification|verify|validated|最终|总结|汇总|结果|验证|通过/iu.test(taskText)) return false;
  if (taskMayNeedFileMutation(taskText) && !hasSuccessfulToolEvidence(task, ["read_file", "edit_file", "write_file"])) return false;
  return true;
}

function isArtifactReadyFinalSummaryTurn(task: TaskDetail): boolean {
  const taskText = taskToolSelectionText(task);
  if (!taskMayNeedFileMutation(taskText)) return false;
  if (taskMayNeedShellTool(taskText)) return false;
  if (taskMayNeedArtifactPreview(taskText)) return false;
  const mutation = findLatestSuccessfulFileMutation(task.events);
  if (!mutation) return false;
  if (findLatestUserIndex(task.events) > mutation.index) return false;
  if (findLatestAssistantMessageIndex(task.events) > mutation.index) return false;
  if (hasUnresolvedToolRequestAfter(task.events, mutation.index)) return false;
  if (hasFailedToolResultAfter(task.events, mutation.index)) return false;
  return findSuccessfulReadFilePathAfter(task.events, mutation.index, mutation.path) >= 0;
}

function findLatestSuccessfulFileMutation(events: TaskEvent[]): { index: number; path: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted || event.type !== "tool_result" || event.payload["ok"] === false) continue;
    const toolName = String(event.payload["toolName"] ?? "");
    if (toolName !== "edit_file" && toolName !== "write_file") continue;
    const path = toolEventPath(event);
    if (path) return { index, path };
  }
  return null;
}

function findSuccessfulReadFilePathAfter(events: TaskEvent[], startIndex: number, path: string): number {
  const expected = normalizeToolPathForComparison(path);
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.reverted || event.type !== "tool_result" || event.payload["ok"] === false) continue;
    if (String(event.payload["toolName"] ?? "") !== "read_file") continue;
    if (normalizeToolPathForComparison(toolEventPath(event)) === expected) return index;
  }
  return -1;
}

function hasFailedToolResultAfter(events: TaskEvent[], startIndex: number): boolean {
  return events.slice(startIndex + 1).some((event) => !event.reverted && event.type === "tool_result" && event.payload["ok"] === false);
}

function findLatestPassedVerificationIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted || event.type !== "verification_result_recorded") continue;
    if (event.payload["status"] === "passed") return index;
  }
  return -1;
}

function findLatestUserIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted) continue;
    if (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") return index;
  }
  return -1;
}

function findLatestAssistantMessageIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted) continue;
    if (event.type === "assistant_message") return index;
  }
  return -1;
}

function findLatestFileMutationIndex(events: TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.reverted) continue;
    if (event.type === "task_rollback_completed") return index;
    if (event.type !== "tool_result" || event.payload["ok"] === false) continue;
    const toolName = String(event.payload["toolName"] ?? "");
    if (toolName === "edit_file" || toolName === "write_file") return index;
  }
  return -1;
}

function hasFailedVerificationAfter(events: TaskEvent[], startIndex: number): boolean {
  return events.slice(startIndex + 1).some((event) =>
    !event.reverted &&
    event.type === "verification_result_recorded" &&
    event.payload["status"] === "failed"
  );
}

function hasUnresolvedToolRequestAfter(events: TaskEvent[], startIndex: number): boolean {
  const requested = new Set<string>();
  const resolved = new Set<string>();
  for (const event of events.slice(startIndex + 1)) {
    if (event.reverted) continue;
    if (event.type === "tool_requested") {
      const id = String(event.payload["toolCallId"] ?? event.payload["id"] ?? "");
      if (id) requested.add(id);
    }
    if (event.type === "tool_result") {
      const id = String(event.payload["toolCallId"] ?? event.payload["id"] ?? "");
      if (id) resolved.add(id);
    }
  }
  return [...requested].some((id) => !resolved.has(id));
}

function hasSuccessfulToolEvidence(task: TaskDetail, toolNames: string[]): boolean {
  const allowed = new Set(toolNames);
  return task.events.some((event) =>
    !event.reverted &&
    event.type === "tool_result" &&
    event.payload["ok"] !== false &&
    allowed.has(String(event.payload["toolName"] ?? ""))
  );
}

function filterToolsForTaskGraph(task: TaskDetail, tools: ModelToolDefinition[]): ModelToolDefinition[] {
  return tools.filter((tool) => toolAllowedByTaskGraph(task, tool.function.name, tool.function.description ?? ""));
}

function filterToolsForLatestUserConstraint(task: TaskDetail, tools: ModelToolDefinition[]): ModelToolDefinition[] {
  const latest = latestUserToolConstraintText(task);
  if (!latest) return tools;
  if (/\b(no tools?|without tools?|do not use tools?|don't use tools?|dont use tools?)\b|不要使用工具|不用工具|不要调用工具|别用工具/iu.test(latest)) {
    return [];
  }
  if (/\b(?:only|except)\s+read_file\b|\bread_file\s+only\b|除\s*read_file\s*之外.*(?:不要|别|不).*(?:工具|请求|调用)|不要.*(?:工具|请求|调用).*除\s*read_file\s*之外/iu.test(latest)) {
    return tools.filter((tool) => tool.function.name === "read_file");
  }
  return tools;
}

function filterOptionalModelToolsForTask(task: TaskDetail, tools: ModelToolDefinition[]): ModelToolDefinition[] {
  const text = taskToolSelectionText(task);
  if (wantsFullToolInventory(text)) return tools;
  return tools.filter((tool) => optionalModelToolAllowed(task, tool.function.name, text));
}

function applyTaskSpecificToolHints(task: TaskDetail, tools: ModelToolDefinition[]): ModelToolDefinition[] {
  const taskText = taskToolSelectionText(task);
  let hintedTools = applyExplicitReadFilePathHints(task, tools);
  if (!taskRequiresInitialShellEvidence(task, taskText)) return hintedTools;
  const requiredCommands = extractExplicitShellCommands(taskText).slice(0, 4);
  if (requiredCommands.length === 0) return hintedTools;
  hintedTools = hintedTools.map((tool) => {
    if (tool.function.name !== "run_command") return tool;
    const parameters = stableValue(tool.function.parameters) as Record<string, unknown>;
    const properties = parameters["properties"] && typeof parameters["properties"] === "object" && !Array.isArray(parameters["properties"])
      ? parameters["properties"] as Record<string, unknown>
      : {};
    const command = properties["command"] && typeof properties["command"] === "object" && !Array.isArray(properties["command"])
      ? properties["command"] as Record<string, unknown>
      : {};
    return {
      ...tool,
      function: {
        ...tool.function,
        description: `${tool.function.description ?? ""} The user named the required first command; run that exact command before any other shell exploration.`,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            command: {
              ...command,
              enum: requiredCommands,
              description: `${String(command["description"] ?? "").trim()} Run one of the user-specified command(s) exactly first: ${requiredCommands.map((commandText) => `\`${commandText}\``).join(", ")}.`.trim()
            }
          }
        }
      }
    };
  });
  return hintedTools;
}

function applyExplicitReadFilePathHints(task: TaskDetail, tools: ModelToolDefinition[]): ModelToolDefinition[] {
  if (hasSuccessfulToolEvidence(task, ["edit_file", "write_file"])) return tools;
  const taskText = taskToolSelectionText(task);
  const rawTaskText = taskToolSelectionRawText(task);
  const explicitPaths = extractReadFilePathCandidates(rawTaskText, taskText).filter((path) => !taskHasSuccessfulReadFilePath(task, path));
  if (explicitPaths.length === 0) return tools;
  const pathCandidates = explicitPaths.slice(0, 6);
  return tools.map((tool) => {
    if (tool.function.name !== "read_file") return tool;
    const parameters = stableValue(tool.function.parameters) as Record<string, unknown>;
    const properties = parameters["properties"] && typeof parameters["properties"] === "object" && !Array.isArray(parameters["properties"])
      ? parameters["properties"] as Record<string, unknown>
      : {};
    const path = properties["path"] && typeof properties["path"] === "object" && !Array.isArray(properties["path"])
      ? properties["path"] as Record<string, unknown>
      : {};
    return {
      ...tool,
      function: {
        ...tool.function,
        description: `${tool.function.description ?? ""} The user named explicit file path(s); read those file path(s) directly before broad directory exploration.`,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            path: {
              ...path,
              enum: pathCandidates,
              description: `${String(path["description"] ?? "").trim()} Use one of the explicit user-named file path(s) first: ${pathCandidates.map((filePath) => `\`${filePath}\``).join(", ")}. Do not pass "." to read_file; use list_files for directories.`.trim()
            }
          }
        }
      }
    };
  });
}

function optionalModelToolAllowed(task: TaskDetail, toolName: string, taskText: string): boolean {
  if (taskRequiresInitialShellEvidence(task, taskText) && !taskNeedsStableCommandFileToolPack(taskText) && toolName !== "run_command") return false;
  if (taskHasToolEvidence(task, toolName)) return true;
  switch (toolName) {
    case "ask_user":
      return taskMayNeedUserClarification(taskText);
    case "run_command":
      return taskMayNeedShellTool(taskText);
    case "read_file":
      return true;
    case "edit_file":
    case "write_file":
      return taskMayNeedFileMutation(taskText);
    case "search_files":
      return taskMayNeedFileMutation(taskText) || taskMayNeedSearchTool(taskText) || !taskHasExplicitFilePath(taskText);
    case "list_files":
      if (taskShouldAvoidDirectoryListingAfterCommand(task, taskText)) return false;
      return taskMayNeedDirectoryListing(taskText) || !taskHasExplicitFilePath(taskText);
    case "knowledge_search":
      return /\b(knowledge|rag|citation|reference|references|saved notes?)\b|知识|知识库|引用|资料库|本地知识|文献/iu.test(taskText);
    case "web_search":
      return /\b(web_search|web search|internet|web|online|latest|today|vendor|provider|model list|external docs?|news)\b|搜索网络|联网|网页|官网|最新|今日|今天|厂商|模型列表|新闻/iu.test(taskText);
    case "use_skill":
      return /\b(use_skill|skill|skills?|guidance|pptx?|docx|pdf|spreadsheet|presentation|slides?|word)\b|技能|调用.*skill|办公|演示|表格|幻灯片/iu.test(taskText);
    case "attach_task_file":
      return /\b(attach|attachment|screenshot|image|visual|preview|download|artifact|pptx?|docx?|pdf)\b|附件|上传|截图|图片|视觉|预览|下载|生成.{0,12}(文件|报告|文档|图片)/iu.test(taskText);
    case "plan_update":
      return taskMayNeedPlanTool(task, taskText);
    case "spawn_subagent":
      return /\b(subagent|child agent|parallel|delegate|delegation|deep|audit|review|large|flagship)\b|子\s*agent|派遣|并行|委派|深入|全面|审查|复核|旗舰/iu.test(taskText);
    case "user_memory_add":
    case "user_memory_edit":
    case "user_memory_delete":
      return /\b(remember|forget|memory|preference|habit)\b|记住|记忆|偏好|习惯|忘记/iu.test(taskText);
    case "project_memory_add":
    case "project_memory_edit":
    case "project_memory_delete":
      return /\b(project memory|remember|forget|memory|constraint|risk)\b|项目记忆|记住|记忆|约束|风险|忘记/iu.test(taskText);
    case "skill_create":
    case "skill_edit":
    case "skill_delete":
      return /\b(skill|skills?|create skill|edit skill|delete skill)\b|技能|创建.*skill|编辑.*skill|删除.*skill/iu.test(taskText);
    default:
      return true;
  }
}

function taskMayNeedShellTool(taskText: string): boolean {
  if (/\b(?:do not|don't|dont|without|no)\s+(?:run\s+)?(?:commands?|shell|terminal)\b|不要.*(?:运行|执行).*(?:命令|终端|shell)|不要.*(?:命令|终端|shell)|不用.*(?:命令|终端|shell)/iu.test(taskText)) return false;
  return /\b(?:run|command|shell|terminal|process|host|install|build|compile|verify|verification|debug|failing|failed|failure|fix|repair|lint|typecheck|npm|pnpm|yarn|node|python|pytest|vitest|jest|playwright|cargo|go\s+test|run\s+tests?|unit\s+tests?|e2e\s+tests?|failing\s+tests?|failed\s+tests?|react|vite|next\.?js|frontend|web\s*(?:app|page|site)|website)\b|运行|命令|终端|进程|主机|电脑|桌面|安装|构建|编译|测试|验证|调试|失败|报错|修复|排查|定位|检查.*环境|浏览器能力|电脑操作|前端|网页|页面|网站|应用/iu.test(taskText);
}

function taskRequiresInitialShellEvidence(task: TaskDetail, taskText: string): boolean {
  if (taskHasToolEvidence(task, "run_command")) return false;
  if (!taskMayNeedShellTool(taskText)) return false;
  const commandName = String.raw`(?:npm|pnpm|yarn|node|python|pytest|vitest|jest|playwright|cargo|go\s+test|tests?|build|lint|typecheck)`;
  const chineseCommandName = String.raw`(?:npm|pnpm|yarn|node|python|pytest|vitest|jest|playwright|测试|构建|编译|lint|typecheck)`;
  return new RegExp(
    [
      String.raw`\b(?:first|start\s+by|begin\s+by|before\s+anything|initially)\b[\s\S]{0,100}\b(?:run|execute)\b[\s\S]{0,120}\b${commandName}\b`,
      String.raw`\b(?:run|execute)\b[\s\S]{0,120}\b${commandName}\b[\s\S]{0,140}\b(?:then|afterwards?|locate|read|inspect|debug|fix|repair)\b`,
      String.raw`(?:先|首先|第一步|一开始)[\s\S]{0,80}(?:运行|执行|跑)[\s\S]{0,120}${chineseCommandName}`,
      String.raw`(?:运行|执行|跑)[\s\S]{0,120}${chineseCommandName}[\s\S]{0,140}(?:然后|再|定位|读取|查看|检查|调试|修复|排查)`
    ].join("|"),
    "iu"
  ).test(taskText);
}

function taskNeedsStableCommandFileToolPack(taskText: string): boolean {
  if (!taskMayNeedFileMutation(taskText) && !taskMayNeedSearchTool(taskText) && !taskHasExplicitFilePath(taskText)) return false;
  if (/\b(?:just|only|solely)\s+(?:run|execute)\b[\s\S]{0,120}\b(?:report|show|tell)\b|只(?:运行|执行|跑)[\s\S]{0,80}(?:告诉|汇报|展示).*结果/iu.test(taskText)) return false;
  return /\b(?:then|afterwards?|after that|locate|read|inspect|debug|fix|repair|source|code|file|files?)\b|然后|再|之后|定位|读取|查看|检查|源码|代码|文件|调试|修复|排查/iu.test(taskText) ||
    taskMayNeedFileMutation(taskText) ||
    taskHasExplicitFilePath(taskText);
}

function extractExplicitShellCommands(text: string): string[] {
  const commands = new Set<string>();
  const patterns = [
    /\b(?:npm(?:\.cmd)?(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:pnpm(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:yarn(?:\s+run)?\s+[a-z0-9:_-]+)\b/giu,
    /\b(?:npx\s+[a-z0-9:_-]+(?:\s+[a-z0-9:_./-]+){0,4})\b/giu,
    /\b(?:node|deno|bun|python(?:3)?)\s+[^\s`"'，。；：,;:]+(?:\s+[^\s`"'，。；：,;:]+){0,4}/giu,
    /\b(?:vitest|jest|pytest|playwright(?:\s+test)?|tsc|cargo\s+test|go\s+test)(?:\s+[^\s`"'，。；：,;:]+){0,4}/giu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeExtractedShellCommand(match[0] ?? "");
      if (value) commands.add(value);
      if (commands.size >= 4) return [...commands];
    }
  }
  return [...commands];
}

function extractReadFilePathCandidates(rawText: string, normalizedTaskText: string): string[] {
  const explicitPaths = extractExplicitFilePaths(rawText);
  if (explicitPaths.length === 0) return [];
  const readCandidates = explicitPaths.filter((filePath) =>
    !isLikelyNewOutputPath(rawText, filePath) &&
    isLikelyReadFilePathCandidate(rawText, filePath)
  );
  if (readCandidates.length > 0) return readCandidates;
  if (!taskMayNeedFileMutation(normalizedTaskText)) return explicitPaths;
  return explicitPaths.filter((filePath) => !isLikelyNewOutputPath(rawText, filePath));
}

function extractExplicitFilePaths(text: string): string[] {
  const paths = new Set<string>();
  const pattern =
    /(?:^|[\s"'`(（])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_@+~.-]+[\\/])*[A-Za-z0-9_@+~.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|html|css|scss|py|java|go|rs|cpp|c|h|yaml|yml|toml|xml|csv|sql|sh|ps1|bat))(?:$|[\s"'`),，。；;:）])/giu;
  for (const match of text.matchAll(pattern)) {
    const normalized = normalizeExtractedFilePath(match[1] ?? "");
    if (!normalized) continue;
    paths.add(normalized);
    if (paths.size >= 8) break;
  }
  return [...paths];
}

function normalizeExtractedFilePath(value: string): string {
  const normalized = value
    .replace(/\\/gu, "/")
    .replace(/^[`"'([{]+/u, "")
    .replace(/[`"')\]}.,;:，。；：]+$/u, "")
    .replace(/^\.\//u, "")
    .trim();
  if (!normalized) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) return "";
  if (/^[a-z]:\//iu.test(normalized)) return "";
  if (normalized.startsWith("/") || normalized.startsWith("../")) return "";
  return normalized;
}

function isLikelyReadFilePathCandidate(text: string, filePath: string): boolean {
  return filePathContexts(text, filePath).some(({ before, after }) => {
    const context = `${before} ${after}`;
    if (/(?:read|inspect|open|view|check|review|summari[sz]e|analy[sz]e|source|from|based on|according to)\b/iu.test(context)) return true;
    if (/(?:读取|查看|检查|阅读|分析|总结|打开|源码|源文件|根据|基于)/iu.test(context)) return true;
    return false;
  });
}

function isLikelyNewOutputPath(text: string, filePath: string): boolean {
  return filePathContexts(text, filePath).some(({ before }) =>
    /(?:create|write|generate|author|scaffold|new|add|output|save\s+as)\s*$/iu.test(before) ||
    /(?:创建|新建|新增|生成|写入|撰写|编写|输出到|保存为)\s*$/u.test(before)
  );
}

function filePathContexts(text: string, filePath: string): Array<{ before: string; after: string }> {
  const contexts: Array<{ before: string; after: string }> = [];
  const escaped = escapeRegExp(filePath).replace(/\//gu, String.raw`[\\/]`);
  const pattern = new RegExp(escaped, "giu");
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    contexts.push({
      before: text.slice(Math.max(0, index - 48), index),
      after: text.slice(index + match[0].length, index + match[0].length + 72)
    });
    if (contexts.length >= 4) break;
  }
  return contexts;
}

function normalizeExtractedShellCommand(value: string): string {
  return value
    .replace(/^[`"'([{]+/u, "")
    .replace(/[`"')\]}.,;:，。；：]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function taskMayNeedFileMutation(taskText: string): boolean {
  if (/\b(?:do not|don't|dont|without|no)\s+(?:edit|write|modify|change|create|update|delete|remove)\b|不要.*(?:修改|写入|写|编辑|创建|新增|更新|删除|移除)|不用.*(?:修改|写入|写|编辑|创建|新增|更新|删除|移除)|不(?:修改|写入|编辑|创建|新增|更新|删除|移除)/iu.test(taskText)) return false;
  return /\b(?:write|edit|create|add|update|delete|remove|replace|modify|fix|repair|implement|build|generate|author|refactor|optimi[sz]e|complete|scaffold|migrate)\b|写|编辑|创建|新增|更新|删除|移除|替换|修改|修复|实现|构建|生成|撰写|编写|补齐|完善|优化|重构|迁移/iu.test(taskText);
}

function taskShouldAvoidDirectoryListingAfterCommand(task: TaskDetail, taskText: string): boolean {
  if (!task.events.some((event) => !event.reverted && event.type === "tool_result" && String(event.payload["toolName"] ?? "") === "run_command")) return false;
  if (taskNeedsStableCommandFileToolPack(taskText)) return false;
  if (taskMayNeedDirectoryListing(taskText)) return false;
  return /\b(?:debug|failing|failed|failure|fix|repair|test|tests?|assertion|stack trace|stacktrace)\b|调试|失败|报错|修复|排查|定位|测试|断言/iu.test(taskText);
}

function taskMayNeedUserClarification(taskText: string): boolean {
  return /\b(?:ask_user|ask the user|clarify|clarification|confirm|confirmation|choose|choice|decision|ambiguous|ambiguity|missing requirement|if unclear|if unsure|when in doubt)\b|询问用户|问用户|澄清|确认|选择|决策|歧义|不明确|不清楚|不确定|缺少需求|如果.*(?:不清楚|不明确|不确定)/iu.test(taskText);
}

function taskMayNeedPlanTool(task: TaskDetail, taskText: string): boolean {
  if (task.runMode === "target") return true;
  return /\b(?:plan|steps?|progress|status|long task|multi-?file|debug|failing|failed|failure|fix|repair|implement|build|verify|verification|test|rollback|checkpoint|audit|review|migrate|refactor|stress|react|vite|next\.?js|frontend|web\s*(?:app|page|site)|website)\b|计划|步骤|进度|状态|长任务|多文件|调试|失败|报错|修复|实现|构建|验证|测试|回滚|检查点|审查|复核|迁移|重构|压测|旗舰|前端|网页|页面|网站|应用/iu.test(taskText);
}

function taskMayNeedSearchTool(taskText: string): boolean {
  return /\b(?:search|find|grep|locate|where|unknown|uncertain|reference|references|usage|symbol|debug|failing|failed|failure|fix|repair)\b|搜索|查找|定位|不确定|未知|引用|调用点|符号|调试|失败|报错|修复|排查/iu.test(taskText);
}

function taskMayNeedDirectoryListing(taskText: string): boolean {
  return /\b(?:list\s+files?|directory|folder|tree|structure|project\s+structure|readme|workspace|current\s+(?:project|folder|directory))\b|列出|目录|文件夹|结构|项目结构|当前任务文件夹|当前文件夹|工作区|README/iu.test(taskText);
}

function taskMayNeedArtifactPreview(taskText: string): boolean {
  return /\b(?:attach|attachment|screenshot|image|visual|preview|render|browser|pptx?|docx?|pdf|slides?|presentation|spreadsheet)\b|附件|上传|截图|图片|视觉|预览|渲染|浏览器|幻灯片|演示|表格/iu.test(taskText);
}

function taskHasExplicitFilePath(taskText: string): boolean {
  return /(?:^|[\s"'`(（])[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|html|css|scss|py|java|go|rs|cpp|c|h|yaml|yml|toml|xml|csv|sql|sh|ps1|bat)(?:$|[\s"'`),，。；;:）])/iu.test(taskText);
}

function taskHasSuccessfulReadFilePath(task: TaskDetail, filePath: string): boolean {
  const expected = normalizeToolPathForComparison(filePath);
  return task.events.some((event) => {
    if (event.reverted || event.type !== "tool_result" || event.payload["ok"] === false) return false;
    if (String(event.payload["toolName"] ?? "") !== "read_file") return false;
    const args = isRecord(event.payload["args"]) ? event.payload["args"] : {};
    const observed = normalizeToolPathForComparison(String(args["path"] ?? event.payload["path"] ?? ""));
    return observed === expected;
  });
}

function normalizeToolPathForComparison(value: string): string {
  return normalizeExtractedFilePath(value).toLowerCase();
}

function toolEventPath(event: TaskEvent): string {
  const args = isRecord(event.payload["args"]) ? event.payload["args"] : {};
  const argPath = typeof args["path"] === "string" ? args["path"] : "";
  if (argPath) return argPath;
  if (typeof event.payload["path"] === "string") return event.payload["path"];
  const output = typeof event.payload["output"] === "string" ? event.payload["output"] : "";
  if (!output.trim().startsWith("{")) return "";
  try {
    const parsed = JSON.parse(output);
    return isRecord(parsed) && typeof parsed["path"] === "string" ? parsed["path"] : "";
  } catch {
    return "";
  }
}

function wantsFullToolInventory(taskText: string): boolean {
  return /\b(all tools?|tool inventory|list tools?|available tools?|capability check)\b|所有.{0,8}工具|全部.{0,8}工具|能调用.{0,8}工具|测试工具/iu.test(taskText);
}

function taskHasToolEvidence(task: TaskDetail, toolName: string): boolean {
  return task.events.some((event) =>
    !event.reverted &&
    (event.type === "tool_requested" || event.type === "tool_result") &&
    String(event.payload["toolName"] ?? "") === toolName
  );
}

function taskToolSelectionText(task: TaskDetail): string {
  return task.events
    .filter((event) => !event.reverted && (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed"))
    .map((event) => event.summary)
    .join("\n")
    .toLowerCase();
}

function taskToolSelectionRawText(task: TaskDetail): string {
  return task.events
    .filter((event) => !event.reverted && (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed"))
    .map((event) => event.summary)
    .join("\n");
}

function latestUserToolConstraintText(task: TaskDetail): string {
  const latest = [...task.events].reverse().find((event) =>
    !event.reverted && (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed")
  );
  return latest?.summary.toLowerCase() ?? "";
}

function attentionTraceMeta(context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null): Record<string, unknown> | undefined {
  const packet = context?.attentionPacket;
  if (!packet) return undefined;
  return {
    ...(packet.activeNode ? {
      activeNode: {
        id: packet.activeNode.id,
        role: packet.activeNode.role,
        objective: packet.activeNode.objective,
        verification: packet.activeNode.verification
      }
    } : {}),
    evidenceRefs: packet.evidenceRefs,
    tokenBudget: packet.tokenBudget
  };
}

function responseTokenBudget(context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null): number {
  const explicit = Number(envValue("AGENT_WORKBENCH_MAX_OUTPUT_TOKENS", "SCC_MAX_OUTPUT_TOKENS") ?? "");
  const reserved = Number(context?.attentionPacket.tokenBudget.reservedForResponse ?? 0);
  const candidate = Number.isFinite(explicit) && explicit > 0 ? explicit : reserved;
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_PROVIDER_OUTPUT_TOKENS;
  return Math.max(1, Math.min(MAX_PROVIDER_OUTPUT_TOKENS, Math.round(candidate)));
}

function promptCacheModeFromEnvironment(): PromptCacheMode {
  const value = envValue("AGENT_WORKBENCH_PROMPT_CACHE_MODE", "SCC_PROMPT_CACHE_MODE")?.trim().toLowerCase();
  return value === "always" || value === "off" || value === "auto" ? value : DEFAULT_PROMPT_CACHE_MODE;
}

export function shouldSendOpenAIPromptCacheKey(mode: PromptCacheMode, baseURL: string | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  if (!baseURL) return true;
  try {
    return OPENAI_COMPATIBLE_PROMPT_CACHE_KEY_HOSTS.has(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function shouldSendOpenAIPromptCacheRetention(mode: PromptCacheMode, baseURL: string | undefined): boolean {
  if (mode === "off") return false;
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function buildPromptCacheKey(
  model: string,
  baseURL: string | undefined
): string {
  const fingerprint = stableJson({
    protocol: "openai_compatible",
    model,
    endpoint: promptCacheEndpointScope(baseURL),
    version: 3
  });
  return `aw-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 40)}`;
}

function promptCacheToolFamily(tools: ModelToolDefinition[], toolUseMode: ToolUseMode = "auto"): Record<string, unknown> {
  if (tools.length === 0) return { mode: "no_tools", toolChoice: toolUseMode };
  return {
    mode: "tools",
    toolChoice: toolUseMode === "disabled" ? "none" : "auto",
    names: tools
      .map((tool) => tool.function.name)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  };
}

function localResponseCacheKey(
  task: TaskDetail,
  model: string,
  baseURL: string | undefined,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: ModelToolDefinition[],
  toolUseMode: ToolUseMode = "auto"
): string | null {
  const scope = localResponseCacheScope(task, messages, tools);
  if (!scope) return null;
  const normalizedMessages = normalizeMessagesForLocalResponseCache(messages);
  if (!normalizedMessages) return null;
  const fingerprint = stableJson({
    protocol: "openai_compatible",
    model,
    endpoint: promptCacheEndpointScope(baseURL),
    scope,
    toolUseMode,
    toolFamily: promptCacheToolFamily(tools, toolUseMode),
    messages: normalizedMessages,
    version: 4
  });
  return `local-aw-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 40)}`;
}

function isCacheableLocalFinalResponse(message: string, tools: ModelToolDefinition[]): boolean {
  const text = message.trim();
  if (!text) return false;
  if (looksLikeInlineToolMarkupText(text)) return false;
  if (/^Internal continuity note\b/i.test(text)) return false;
  if (/^Prior\s+(?:thinking|reasoning)\s+retained\s+for\s+continuity\b/i.test(text)) return false;
  if (/Do not quote this note verbatim/i.test(text)) return false;
  for (const tool of tools) {
    const name = tool.function.name.trim();
    if (name && new RegExp(`\\b${escapeRegExp(name)}\\b`, "iu").test(text)) return false;
  }
  return true;
}

function localResponseCacheScope(
  task: TaskDetail,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: ModelToolDefinition[]
): "initial_direct" | "post_tool_final" | null {
  if (latestNoProgressEventRequiresFreshModelTurn(task)) return null;
  if (isInitialDirectAnswerTask(task) && tools.length === 0) {
    return messages.length === 2 ? "initial_direct" : null;
  }
  const hasToolResult = task.events.some((event) => !event.reverted && event.type === "tool_result");
  const hasToolRoleMessage = messages.some((message) => message.role === "tool");
  return hasToolResult && hasToolRoleMessage ? "post_tool_final" : null;
}

function latestNoProgressEventRequiresFreshModelTurn(task: TaskDetail): boolean {
  const latest = [...task.events].reverse().find((event) =>
    !event.reverted &&
    event.type !== "token_usage_recorded" &&
    event.type !== "assistant_delta" &&
    event.type !== "thinking_delta"
  );
  return latest?.type === "model_no_progress" && latest.payload["status"] === "retrying";
}

function looksLikeInlineToolMarkupText(text: string): boolean {
  return /<\s*tool_call\b|<\s*function\s*=|<\s*parameter\s*=|<\s*\/\s*function\s*>/iu.test(text);
}

function normalizeMessagesForLocalResponseCache(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Array<Record<string, unknown>> | null {
  const toolCallIds = new Map<string, string>();
  const normalizeToolCallId = (id: string): string => {
    const existing = toolCallIds.get(id);
    if (existing) return existing;
    const created = `call_${toolCallIds.size + 1}`;
    toolCallIds.set(id, created);
    return created;
  };
  const normalized: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    const role = String(record["role"] ?? "");
    const content = record["content"];
    if (typeof content !== "string") return null;
    if (role === "system" || role === "user") {
      normalized.push({ role, content: role === "user" ? normalizeDirectAnswerCacheText(content) : content });
      continue;
    }
    if (role === "assistant") {
      const assistant: Record<string, unknown> = { role, content };
      if (typeof record["reasoning_content"] === "string") assistant["reasoning_content"] = record["reasoning_content"];
      if (Array.isArray(record["tool_calls"])) {
        const calls = [];
        for (const call of record["tool_calls"]) {
          if (!isRecord(call) || !isRecord(call["function"])) return null;
          const id = typeof call["id"] === "string" ? call["id"] : "";
          const name = typeof call["function"]["name"] === "string" ? call["function"]["name"] : "";
          const args = typeof call["function"]["arguments"] === "string" ? normalizeToolCallArgumentsForLocalResponseCache(call["function"]["arguments"]) : "";
          if (!id || !name) return null;
          calls.push({
            id: normalizeToolCallId(id),
            type: call["type"] === "function" ? "function" : String(call["type"] ?? "function"),
            function: { name, arguments: args }
          });
        }
        assistant["tool_calls"] = calls;
      }
      normalized.push(assistant);
      continue;
    }
    if (role === "tool") {
      const toolCallId = typeof record["tool_call_id"] === "string" ? record["tool_call_id"] : "";
      if (!toolCallId) return null;
      normalized.push({ role, tool_call_id: normalizeToolCallId(toolCallId), content });
      continue;
    }
    return null;
  }
  return normalized;
}

function normalizeToolCallArgumentsForLocalResponseCache(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return stableJson(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

function normalizeDirectAnswerCacheText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function estimateOpenAIMessageTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  const chars = JSON.stringify(messages).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateOpenAIRequestTokens(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: ModelToolDefinition[]
): number {
  const chars = JSON.stringify({ messages, ...(tools.length > 0 ? { tools } : {}) }).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateOpenAIStablePrefixTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  const firstDynamicIndex = messages.findIndex((message, index) => !isOpenAIStablePrefixMessage(message, index));
  const prefix = firstDynamicIndex >= 0 ? messages.slice(0, firstDynamicIndex) : messages;
  return estimateOpenAIMessageTokens(prefix);
}

function isOpenAIStablePrefixMessage(message: OpenAI.Chat.Completions.ChatCompletionMessageParam, index: number): boolean {
  if (message.role === "system") return true;
  if (index === 1 && message.role === "user" && openAIMessageText(message).startsWith("## Stable Task Context")) return true;
  return false;
}

function openAIMessageText(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return "";
}

function promptCacheEndpointScope(baseURL: string | undefined): string {
  if (!baseURL) return "api.openai.com";
  try {
    const url = new URL(baseURL);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return baseURL.replace(/\/+$/, "");
  }
}

function stableModelToolsForRequest(tools: ModelToolDefinition[]): ModelToolDefinition[] {
  return tools
    .map(stabilizeModelTool)
    .sort((left, right) => {
      const leftName = left.function.name;
      const rightName = right.function.name;
      return leftName === rightName
        ? stableJson(left).localeCompare(stableJson(right))
        : leftName.localeCompare(rightName);
    });
}

function stabilizeModelTool(tool: ModelToolDefinition): ModelToolDefinition {
  return stableValue(tool) as ModelToolDefinition;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableValue(value[key])])
  );
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface OpenAIProviderConfigWithName extends OpenAIProviderConfig {
  providerName?: string;
}

interface OpenAIProviderSection {
  name: string;
  config: OpenAIProviderConfig;
}

export function loadOpenAiConfig(filePath = normalizeApiKeyFilePath(envValue("AGENT_WORKBENCH_API_KEY_FILE", "SCC_API_KEY_FILE"))): OpenAIProviderConfig {
  const fileConfig = loadOpenAiProviderConfig(filePath);
  const apiKey = process.env["OPENAI_API_KEY"] ?? envValue("AGENT_WORKBENCH_OPENAI_API_KEY", "SCC_OPENAI_API_KEY") ?? fileConfig.apiKey;
  const baseURL = process.env["OPENAI_BASE_URL"] ?? process.env["OPENAI_BASEURL"] ?? envValue("AGENT_WORKBENCH_OPENAI_BASE_URL", "SCC_OPENAI_BASE_URL") ?? fileConfig.baseURL;
  const model = envValue("AGENT_WORKBENCH_MODEL", "SCC_MODEL") ?? process.env["OPENAI_MODEL"] ?? fileConfig.model;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {})
  };
}

export function loadOpenAiProviderConfig(
  filePath = normalizeApiKeyFilePath(envValue("AGENT_WORKBENCH_API_KEY_FILE", "SCC_API_KEY_FILE"))
): OpenAIProviderConfigWithName {
  const section = loadOpenAiConfigFileSection(filePath);
  return section ? { ...section.config, providerName: section.name } : {};
}

function loadOpenAiConfigFileSection(filePath?: string): OpenAIProviderSection | undefined {
  if (!filePath) return undefined;
  const resolvedPath = resolveApiKeyPath(filePath);
  if (!existsSync(resolvedPath)) return undefined;

  const sections = parseProviderSections(readFileSync(resolvedPath, "utf8"));
  const preferredProvider = envValue("AGENT_WORKBENCH_API_PROVIDER", "SCC_API_PROVIDER") ?? process.env["OPENAI_PROVIDER"];
  const preferred = preferredProvider
    ? sections.find((section) => normalizeProviderName(section.name).includes(normalizeProviderName(preferredProvider)))
    : undefined;

  const complete = (section: OpenAIProviderSection): boolean => Boolean(section.config.apiKey && section.config.baseURL);
  return (
    preferred ??
    sections.find((section) => complete(section) && section.config.model) ??
    sections.find(complete) ??
    sections[0]
  );
}

function parseProviderSections(text: string): OpenAIProviderSection[] {
  const sections: OpenAIProviderSection[] = [];
  let current: OpenAIProviderSection = { name: "default", config: {} };

  const commit = (): void => {
    if (current.config.apiKey || current.config.baseURL || current.config.model) sections.push(current);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "---") {
      commit();
      current = { name: `section-${sections.length + 1}`, config: {} };
      continue;
    }
    if (!line || line.startsWith("#")) continue;

    const parsed = parseConfigLine(line);
    if (!parsed) {
      if (looksLikeProviderHeading(line)) current.name = cleanHeading(line);
      continue;
    }
    if (/deleted|删除|废弃|失效/i.test(line)) continue;

    if (isApiKeyName(parsed.name)) current.config.apiKey = cleanConfigValue(parsed.value);
    if (isBaseUrlName(parsed.name)) current.config.baseURL = cleanConfigValue(parsed.value);
    if (isModelName(parsed.name)) current.config.model = cleanConfigValue(parsed.value);
  }

  commit();
  return sections;
}

function parseConfigLine(line: string): { name: string; value: string } | null {
  const match = line.match(/^[-*>\s`]*(?<name>[A-Za-z][A-Za-z0-9_-]*)\s*(?::|=)\s*(?<value>.+?)\s*`?$/);
  if (!match?.groups) return null;
  const name = match.groups["name"]?.trim();
  const value = match.groups["value"]?.trim();
  return name && value ? { name, value } : null;
}

function cleanConfigValue(value: string): string {
  return value
    .replace(/\s+\([^)]*\)\s*$/u, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function isApiKeyName(name: string): boolean {
  return /^(OPENAI_API_KEY|apiKey|api_key|openaiApiKey|tokenPlanApiKey)$/i.test(name);
}

function isBaseUrlName(name: string): boolean {
  return /^(OPENAI_BASE_URL|OPENAI_BASEURL|baseUrl|baseURL|base_url|openaiBaseUrl)$/i.test(name);
}

function isModelName(name: string): boolean {
  return /^(AGENT_WORKBENCH_MODEL|SCC_MODEL|OPENAI_MODEL|model|canonicalLiveModel)$/i.test(name);
}

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function looksLikeProviderHeading(line: string): boolean {
  if (line.startsWith("|") || line.startsWith("<") || line.startsWith("```")) return false;
  if (line.length > 80) return false;
  return /^[\p{L}\p{N}_ ().-]+$/u.test(line);
}

function cleanHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

function normalizeApiKeyFilePath(filePath: string | undefined): string | undefined {
  const trimmed = filePath?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseURL(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/chat\/completions\/?$/i, "");
}

function classifyModelError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/context|token|maximum context|too long|length/i.test(text)) return "context_overflow";
  if (/rate.?limit|429|too many requests/i.test(text)) return "rate_limit";
  if (/timeout|timed out|aborted|ECONNRESET|ETIMEDOUT/i.test(text)) return "timeout";
  if (/empty response|no response|invalid response/i.test(text)) return "empty_response";
  if (/unauthorized|invalid api key|forbidden|401|403|auth/i.test(text)) return "auth_failure";
  return "provider_unavailable";
}

function isFallbackableModelError(error: unknown): boolean {
  return !["auth_failure"].includes(classifyModelError(error));
}

function normalizeProviderName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveApiKeyPath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (filePath.includes("/") || filePath.includes("\\")) return filePath;

  let current = process.cwd();
  while (true) {
    const candidate = join(current, filePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return resolve(process.cwd(), filePath);
    current = parent;
  }
}

function buildInput(task: TaskDetail): string {
  const lines: string[] = [];
  for (const event of task.events) {
    if (event.type === "status_changed" || event.type === "task_created") continue;
    if (event.type.startsWith("plan_")) continue;
    if (event.type === "conversation_summary_created" || event.type === "context_overflow_recovered" || event.type === "prompt_cache_stats") continue;
    if (event.type === "tool_result") {
      const toolName = String(event.payload["toolName"] ?? "tool");
      const ok = event.payload["ok"] !== false;
      lines.push(`tool_result ${toolName}: ${JSON.stringify({ ok, output: String(event.payload["output"] ?? "").slice(0, 6000) })}`);
      continue;
    }
    if (event.payload["uiHidden"] === true) continue;
    lines.push(`${event.type}: ${event.summary}`);
  }
  return lines.join("\n");
}

function readStreamDelta(chunk: unknown): Record<string, unknown> | null {
  if (!isRecord(chunk) || !Array.isArray(chunk["choices"])) return null;
  const choice = chunk["choices"][0];
  if (!isRecord(choice) || !isRecord(choice["delta"])) return null;
  return choice["delta"];
}

function readStreamFinishReason(chunk: unknown): string {
  if (!isRecord(chunk) || !Array.isArray(chunk["choices"])) return "";
  const choice = chunk["choices"][0];
  if (!isRecord(choice)) return "";
  return typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : "";
}

function extractOpenAIUsage(chunk: unknown): ModelUsage | undefined {
  if (!isRecord(chunk) || !isRecord(chunk["usage"])) return undefined;
  const usage = chunk["usage"];
  const promptDetails = isRecord(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};
  const cachedTokens = Number(promptDetails["cached_tokens"] ?? 0);
  return {
    ...optionalNumber("inputTokens", usage["prompt_tokens"]),
    ...optionalNumber("outputTokens", usage["completion_tokens"]),
    ...(Number.isFinite(cachedTokens) && cachedTokens > 0 ? { cachedTokens } : {}),
    raw: usage
  };
}

function anthropicUsage(payload: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(payload["usage"])) return undefined;
  const usage = payload["usage"];
  const uncachedInputTokens = finiteNonNegativeNumber(usage["input_tokens"]);
  const cachedTokens = finiteNonNegativeNumber(usage["cache_read_input_tokens"]);
  const cacheCreationTokens = finiteNonNegativeNumber(usage["cache_creation_input_tokens"]);
  return {
    inputTokens: uncachedInputTokens + cachedTokens + cacheCreationTokens,
    ...optionalNumber("outputTokens", usage["output_tokens"]),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    raw: usage
  };
}

function geminiUsage(payload: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(payload["usageMetadata"])) return undefined;
  const usage = payload["usageMetadata"];
  return {
    ...optionalNumber("inputTokens", usage["promptTokenCount"]),
    ...optionalNumber("outputTokens", usage["candidatesTokenCount"]),
    ...optionalNumber("cachedTokens", usage["cachedContentTokenCount"]),
    raw: usage
  };
}

function optionalNumber(key: "inputTokens" | "outputTokens" | "cachedTokens", value: unknown): Partial<ModelUsage> {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? { [key]: number } : {};
}

function finiteNonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function extractReasoningDelta(delta: Record<string, unknown>): string {
  const candidates = [
    delta["reasoning_content"],
    delta["reasoning"],
    delta["thinking"],
    delta["thought"],
    delta["reasoning_summary"]
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) {
      const text = value
        .map((part) => {
          if (typeof part === "string") return part;
          if (isRecord(part) && typeof part["text"] === "string") return part["text"];
          return "";
        })
        .join("");
      if (text) return text;
    }
  }
  return "";
}

function toolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the user a concise clarification or decision question only when progress truly depends on missing requirements, ambiguous intent, or a choice only the user can make. Do not ask whether to perform actions the user already explicitly requested.",
        parameters: strictObject({
          question: { type: "string", description: "The specific question the user needs to answer." },
          options: { type: "array", items: { type: "string" }, description: "Optional short mutually exclusive options." },
          required: { type: "boolean", description: "Whether the answer is required before continuing. Defaults to true." },
          details: { type: "string", description: "Optional short context explaining why the question matters." }
        }, ["question"])
      }
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: `Request a local shell command for scripts, builds, tests, or host/process inspection. The application classifies risk and may ask the user before running it. Do not use run_command to read workspace file bodies or search project text when list_files, search_files, or read_file can answer the question. ${runCommandShellPortabilityGuidance()}`,
        parameters: strictObject({
          command: { type: "string", description: `The command to run. Prefer read-only observation unless the user asked for changes. For workspace file inspection, prefer list_files/search_files/read_file instead of shell cat/type/Get-Content/grep. ${runCommandShellPortabilityGuidance()}` },
          cwd: { type: "string", description: "Working directory inside the task folder. Defaults to the task folder root." }
        }, ["command"])
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read project file content inside the task folder. Prefer workspace-relative paths, especially paths returned by list_files/search_files; do not pass the absolute workRoot path when a relative path works. This is the only file tool that returns file body text. Whole-file reads are only appropriate for genuinely small files. For long HTML/CSS/JSON/log files or files with hundreds of lines, start with search_files and then use offset/limit to read the exact range you need. If the path is uncertain, call list_files or search_files first.",
        parameters: strictObject({
          path: { type: "string", description: "Workspace-relative file path preferred." },
          offset: { type: "number", description: "Optional 1-based start line for targeted file reads. Prefer this for long files after search_files identifies the relevant section." },
          limit: { type: "number", description: "Optional maximum lines for targeted file reads. Keep ranges tight when the file is large." }
        }, ["path"])
      }
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a project file by line ranges. Prefer workspace-relative paths, especially paths returned by read_file/search_files/list_files. Include expectedHash from read_file when available. When replacing a function or code block, include the full syntactic block through the matching closing delimiter so the edit cannot leave duplicate or dangling braces. If creating a new whole file, prefer write_file with expectedHash=\"__new__\"; do not ask the user first when they already requested the file.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Workspace-relative file path preferred." },
          expectedHash: { type: "string", description: "Hash from read_file; use __new__ only when creating a new file." },
            edits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                  newText: { type: "string" },
                  expectedText: { type: "string", description: "Optional exact current text for the target range. The edit fails if it no longer matches." }
                },
                required: ["startLine", "endLine", "newText"]
              }
            }
          },
          required: ["path", "expectedHash", "edits"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or replace a whole project file. Prefer workspace-relative paths. Use __new__ as expectedHash only for new files; otherwise include the hash from read_file. Parent directories are created automatically. Large content is written safely by the tool.",
        parameters: strictObject({
          path: { type: "string", description: "Workspace-relative file path preferred." },
          expectedHash: { type: "string", description: "Hash from read_file; use __new__ only when creating a new file." },
          content: { type: "string", description: "Complete file content to write." }
        }, ["path", "expectedHash", "content"])
      }
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search live workspace file paths and text lines. Returns workspace-relative file paths, line numbers, and short snippets only; it does not return full file contents. Use returned relative paths directly with read_file/edit_file/write_file. Supports simple OR terms separated by |. Use this before read_file when the file is large or the exact location is unknown.",
        parameters: strictObject({
          query: { type: "string", description: "Literal text to find in project file paths or lines. Use term1|term2 for simple OR search." },
          path: { type: "string", description: "Workspace-relative directory to search, default project root." }
        }, ["query"])
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a task folder directory. Returns workspace-relative paths. Use this before reading guessed project files, but do not list the same directory repeatedly unless contents may have changed.",
        parameters: strictObject({
          path: { type: "string", description: "Workspace-relative directory path, default ." },
          recursive: { type: "boolean", description: "Whether to recurse" }
        }, [])
      }
    },
    {
      type: "function",
      function: {
        name: "attach_task_file",
        description: "Attach an existing file inside the task folder to the current task timeline so the user can preview or download it. Use this for screenshots, rendered images, or generated files after creating or capturing them. The path must stay inside the task folder.",
        parameters: strictObject({
          path: { type: "string", description: "Path to an existing file inside the task folder." },
          fileName: { type: "string", description: "Optional display file name. Defaults to the source file basename." },
          mimeType: { type: "string", description: "Optional MIME type. Defaults from the file extension when omitted." }
        }, ["path"])
      }
    },
    {
      type: "function",
      function: {
        name: "use_skill",
        description: "Load a listed skill's full guidance into the next context. Use only for directly relevant skills.",
        parameters: strictObject({
          skillId: { type: "string", description: "Skill ID from Available Skills" },
          name: { type: "string", description: "Skill ID or exact title/name from Available Skills." }
        }, ["name"])
      }
    },
    {
      type: "function",
      function: {
        name: "user_memory_add",
        description: "Add a short durable global USER.md memory only when the user explicitly asks you to remember a stable preference or habit.",
        parameters: strictObject({
          content: { type: "string", description: "One concise memory entry. Do not include transient task output." },
          section: { type: "string", description: "Optional USER.md section, such as Preferences or Long-term Constraints." }
        }, ["content"])
      }
    },
    {
      type: "function",
      function: {
        name: "user_memory_edit",
        description: "Edit an existing global USER.md memory by matching a short exact phrase and replacing it.",
        parameters: strictObject({
          match: { type: "string", description: "Existing phrase or line to replace." },
          replacement: { type: "string", description: "Replacement memory text." }
        }, ["match", "replacement"])
      }
    },
    {
      type: "function",
      function: {
        name: "user_memory_delete",
        description: "Delete an existing global USER.md memory when the user asks to forget or remove it.",
        parameters: strictObject({
          match: { type: "string", description: "Phrase or line identifying the memory to remove." }
        }, ["match"])
      }
    },
    {
      type: "function",
      function: {
        name: "project_memory_add",
        description: "Add a short durable project MEMORY.md fact for the current task folder. Use only for stable project facts, constraints, paths, or risks.",
        parameters: strictObject({
          content: { type: "string", description: "One concise project memory entry." },
          section: { type: "string", description: "Optional MEMORY.md section, such as Key Facts or Open Risks." },
          folderId: { type: "string", description: "Optional task folder id; defaults to the current task folder." }
        }, ["content"])
      }
    },
    {
      type: "function",
      function: {
        name: "project_memory_edit",
        description: "Edit an existing project MEMORY.md entry in the current task folder.",
        parameters: strictObject({
          match: { type: "string", description: "Existing phrase or line to replace." },
          replacement: { type: "string", description: "Replacement memory text." },
          folderId: { type: "string", description: "Optional task folder id; defaults to the current task folder." }
        }, ["match", "replacement"])
      }
    },
    {
      type: "function",
      function: {
        name: "project_memory_delete",
        description: "Delete an existing project MEMORY.md entry in the current task folder.",
        parameters: strictObject({
          match: { type: "string", description: "Phrase or line identifying the project memory to remove." },
          folderId: { type: "string", description: "Optional task folder id; defaults to the current task folder." }
        }, ["match"])
      }
    },
    {
      type: "function",
      function: {
        name: "skill_create",
        description: "Create a reusable skill draft only when the user explicitly asks to create a skill or after a stable reusable pattern has been approved.",
        parameters: strictObject({
          title: { type: "string" },
          body: { type: "string", description: "Reusable method only. Do not include single-run outputs or full conversation logs." },
          description: { type: "string", description: "Applicability description." },
          requiredTools: { type: "array", items: { type: "string" } },
          requiredContext: { type: "array", items: { type: "string" } },
          exclusions: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["candidate", "active", "suspended", "retired"] }
        }, ["title", "body"])
      }
    },
    {
      type: "function",
      function: {
        name: "skill_delete",
        description: "Delete a saved skill by id or title when the user explicitly asks to remove it.",
        parameters: strictObject({
          skillId: { type: "string" },
          title: { type: "string" }
        }, [])
      }
    },
    {
      type: "function",
      function: {
        name: "skill_edit",
        description: "Edit a saved skill by id or title when the user explicitly asks to revise it.",
        parameters: strictObject({
          skillId: { type: "string" },
          title: { type: "string", description: "Existing skill title if skillId is unknown." },
          newTitle: { type: "string" },
          body: { type: "string", description: "Reusable revised method only; no single-run outputs." },
          description: { type: "string" },
          requiredTools: { type: "array", items: { type: "string" } },
          requiredContext: { type: "array", items: { type: "string" } },
          exclusions: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["candidate", "active", "suspended", "retired"] }
        }, [])
      }
    },
    {
      type: "function",
      function: {
        name: "plan_update",
        description: "Update the side-panel task plan/progress when a task benefits from visible planning. Do not use for trivial tasks. After a successful plan_update, do not call plan_update again unless the plan materially changes; continue the task or answer the user.",
        parameters: strictObject({
          context: { type: "string", description: "Short current plan context or why the plan changed." },
          status: { type: "string", enum: ["empty", "planning", "running", "blocked", "completed"] },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                status: { type: "string", enum: ["pending", "running", "completed", "blocked"] },
                detail: { type: "string" }
              },
              required: ["title", "status"]
            }
          }
        }, [])
      }
    },
    {
      type: "function",
      function: {
        name: "spawn_subagent",
        description: "Delegate a bounded read-only research subtask to a child agent that may inspect local files, host state, and the network, but cannot edit files, run destructive commands, ask the user, or spawn another subagent. Use only when a parallel research thread will materially help the current task.",
        parameters: strictObject({
          goal: { type: "string", description: "The exact delegated research goal." },
          context: { type: "string", description: "Optional short context the child agent should know before it starts." },
          fileHints: { type: "array", items: { type: "string" }, description: "Optional likely-relevant files or directories." },
          title: { type: "string", description: "Optional short child task title." },
          expectedOutput: { type: "string", enum: ["summary", "checklist", "comparison"], description: "The preferred shape of the child agent's final summary." }
        }, ["goal"])
      }
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web through a configured provider when current external information is needed. Use sparingly and summarize only relevant evidence.",
        parameters: strictObject({
          query: { type: "string", description: "Focused search query." },
          limit: { type: "number", description: "Number of results, default 5, max 10." }
        }, ["query"])
      }
    },
    {
      type: "function",
      function: {
        name: "knowledge_search",
        description: "Search the user's indexed local Knowledge library: saved notes, uploaded references, reusable facts, and curated snippets. This does not search the live workspace source tree; use search_files/read_file for current project files. Knowledge results are background references and may be stale until verified against live files.",
        parameters: strictObject({
          query: { type: "string", description: "Focused knowledge-library search query." },
          projectId: { type: "string", description: "Knowledge project id, default default." },
          limit: { type: "number", description: "Number of chunks, default 5, max 12." }
        }, ["query"])
      }
    }
  ];
}

function toAnthropicTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: tool.function.parameters
  };
}

function toAnthropicToolCall(part: unknown): ToolCall | null {
  if (!isRecord(part) || part["type"] !== "tool_use") return null;
  return {
    id: typeof part["id"] === "string" ? part["id"] : createId("tool_call"),
    toolName: String(part["name"] ?? "unknown_tool"),
    args: isRecord(part["input"]) ? part["input"] : {}
  };
}

function toGeminiTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters
  };
}

function geminiParts(payload: Record<string, unknown>): unknown[] {
  const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
  const first = candidates.find(isRecord);
  if (!first || !isRecord(first["content"]) || !Array.isArray(first["content"]["parts"])) return [];
  return first["content"]["parts"];
}

function toGeminiToolCall(part: unknown): ToolCall | null {
  if (!isRecord(part) || !isRecord(part["functionCall"])) return null;
  const call = part["functionCall"];
  return {
    id: createId("tool_call"),
    toolName: String(call["name"] ?? "unknown_tool"),
    args: isRecord(call["args"]) ? call["args"] : {}
  };
}

function runCommandShellPortabilityGuidance(): string {
  if (process.platform === "win32") {
    return "This host runs Windows PowerShell: use Get-ChildItem -Force instead of ls -la, Select-Object -First instead of head, and npm.cmd for generated npm commands unless the user specified an exact command.";
  }
  return "Use POSIX-compatible commands on non-Windows hosts; avoid PowerShell-only cmdlets unless the user requested them.";
}

function strictObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content["text"] === "string") return content["text"];
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part["text"] === "string") return part["text"];
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
