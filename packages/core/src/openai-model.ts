import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import OpenAI from "openai";
import type { TaskDetail, ToolCall, UserPreferences } from "@scc/shared";
import type { ContextAssembler } from "./context-assembler.js";
import { createId } from "./ids.js";
import type { ModelClient, ModelStreamHandlers, ModelTurn } from "./fallback-model.js";
import { ConfiguredToolModelClient, FallbackModelClient } from "./fallback-model.js";

export interface OpenAIModelClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  contextAssembler?: ContextAssembler | undefined;
  toolProvider?: ModelToolProvider | undefined;
  preferenceProvider?: (() => Promise<UserPreferences>) | undefined;
  providerResolver?: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;
}

export interface ResolvedModelProviderConfig {
  providerId?: string;
  protocol: "openai_compatible" | "anthropic_messages" | "gemini";
  apiKey: string;
  baseURL?: string;
  model: string;
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

export class OpenAIModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly defaultBaseURL: string | undefined;
  private readonly defaultModel: string;
  private readonly clientCache = new Map<string, OpenAI>();
  private readonly contextAssembler: ContextAssembler | undefined;
  private readonly toolProvider: ModelToolProvider | undefined;
  private readonly preferenceProvider: (() => Promise<UserPreferences>) | undefined;
  private readonly providerResolver: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;

  constructor(options: OpenAIModelClientOptions) {
    this.apiKey = options.apiKey ?? "";
    this.defaultBaseURL = options.baseURL;
    this.defaultModel = options.model ?? process.env["SCC_MODEL"] ?? "gpt-5.4-mini";
    this.contextAssembler = options.contextAssembler;
    this.toolProvider = options.toolProvider;
    this.preferenceProvider = options.preferenceProvider;
    this.providerResolver = options.providerResolver;
  }

  async next(task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    return this.nextWithSkillRetries(task, 0, stream);
  }

  private async nextWithSkillRetries(task: TaskDetail, skillRetryCount: number, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    const context = this.contextAssembler ? await this.contextAssembler.assemble(task) : null;
    const preferences = await this.preferenceProvider?.();
    const dynamicTools = (await this.toolProvider?.listModelTools()) ?? [];
    const provider = await this.providerResolver?.();
    if (provider?.protocol === "anthropic_messages") return this.nextAnthropic(task, context, provider, dynamicTools, stream);
    if (provider?.protocol === "gemini") return this.nextGemini(task, context, provider, dynamicTools, stream);

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
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: context?.systemPrompt ?? fallbackInstructions() },
          { role: "user", content: context?.input ?? buildInput(task) }
        ],
        stream: true,
        tool_choice: "auto" as const,
        tools: [...toolDefinitions(), ...dynamicTools] as OpenAI.Chat.Completions.ChatCompletionTool[]
      },
      stream?.signal ? { signal: stream.signal } : undefined
    );

    const streamed = await consumeChatCompletionStream(response, stream);
    const calls = streamed.calls;
    const skillCall = calls.find((call) => call.toolName === "use_skill");
    if (skillCall && this.contextAssembler) {
      const skillId = String(skillCall.args["skillId"] ?? "");
      const skill = await this.contextAssembler.loadSkill(task.id, skillId);
      if ((skill || skillRetryCount < 2) && skillRetryCount < 3) return this.nextWithSkillRetries(task, skillRetryCount + 1, stream);
    }

    const executableCalls = calls.filter((call) => call.toolName !== "use_skill");
    if (executableCalls.length > 0) {
      return {
        kind: "tool_calls",
        calls: executableCalls,
        ...(stream?.streamId ? { streamId: stream.streamId } : {})
      };
    }

    const content = streamed.content.trim();
    return {
      kind: "final",
      message: content || "I could not produce a result from the model response.",
      ...(stream?.streamId ? { streamId: stream.streamId } : {})
    };
  }

  private async nextAnthropic(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    provider: ResolvedModelProviderConfig,
    dynamicTools: ModelToolDefinition[],
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    const response = await fetch(`${provider.baseURL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      ...(stream?.signal ? { signal: stream.signal } : {}),
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        system: context?.systemPrompt ?? fallbackInstructions(),
        messages: [{ role: "user", content: context?.input ?? buildInput(task) }],
        tools: [...toolDefinitions(), ...dynamicTools].map(toAnthropicTool)
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json()) as Record<string, unknown>;
    const parts = Array.isArray(payload["content"]) ? payload["content"] : [];
    const text = parts.map(extractText).filter(Boolean).join("\n").trim();
    if (text) await stream?.onAssistantDelta(text);
    const calls = parts.map(toAnthropicToolCall).filter((call): call is ToolCall => Boolean(call));
    return calls.length > 0 ? { kind: "tool_calls", calls, ...(stream?.streamId ? { streamId: stream.streamId } : {}) } : { kind: "final", message: text || "No response returned.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }

  private async nextGemini(
    task: TaskDetail,
    context: Awaited<ReturnType<ContextAssembler["assemble"]>> | null,
    provider: ResolvedModelProviderConfig,
    dynamicTools: ModelToolDefinition[],
    stream?: ModelStreamHandlers
  ): Promise<ModelTurn> {
    const base = provider.baseURL || "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetch(`${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
      method: "POST",
      ...(stream?.signal ? { signal: stream.signal } : {}),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: context?.systemPrompt ?? fallbackInstructions() }] },
        contents: [{ role: "user", parts: [{ text: context?.input ?? buildInput(task) }] }],
        tools: [{ functionDeclarations: [...toolDefinitions(), ...dynamicTools].map(toGeminiTool) }]
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json()) as Record<string, unknown>;
    const parts = geminiParts(payload);
    const text = parts.map(extractText).filter(Boolean).join("\n").trim();
    if (text) await stream?.onAssistantDelta(text);
    const calls = parts.map(toGeminiToolCall).filter((call): call is ToolCall => Boolean(call));
    return calls.length > 0 ? { kind: "tool_calls", calls, ...(stream?.streamId ? { streamId: stream.streamId } : {}) } : { kind: "final", message: text || "No response returned.", ...(stream?.streamId ? { streamId: stream.streamId } : {}) };
  }

  private clientFor(baseURL: string | undefined, apiKey: string): OpenAI {
    const key = `${baseURL || "__default__"}:${apiKey.slice(-8)}`;
    const cached = this.clientCache.get(key);
    if (cached) return cached;
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
): Promise<{ content: string; calls: ToolCall[] }> {
  let content = "";
  const toolParts = new Map<number, StreamToolCallPart>();

  for await (const chunk of stream) {
    if (handlers?.signal?.aborted) throw new Error("Model request cancelled by user.");
    const delta = readStreamDelta(chunk);
    if (!delta) continue;

    const thinking = extractReasoningDelta(delta);
    if (thinking) await handlers?.onThinkingDelta(thinking);

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
  }

  const calls: ToolCall[] = [...toolParts.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, part]) => Boolean(part.name))
    .map(([, part]) => ({
      id: part.id ?? createId("tool_call"),
      toolName: part.name ?? "unknown_tool",
      args: parseArgs(part.arguments || "{}")
    }));
  return { content, calls };
}

export function createModelClientFromEnvironment(
  options: {
    contextAssembler?: ContextAssembler;
    toolProvider?: ModelToolProvider;
    preferenceProvider?: (() => Promise<UserPreferences>) | undefined;
    providerResolver?: (() => Promise<ResolvedModelProviderConfig | null>) | undefined;
  } = {}
): ModelClient {
  if (process.env["SCC_TEST_TOOL_COMMAND"]) {
    return new ConfiguredToolModelClient(process.env["SCC_TEST_TOOL_COMMAND"]);
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

function fallbackInstructions(): string {
  return [
    "You are the SCC workbench agent.",
    "Choose the next action yourself based on the user's goal, available tools, permissions, and evidence.",
    "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
    "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless explicitly requested.",
    "When the user asks what you can do, answer directly from your general capabilities; do not inspect files first.",
    "Do not claim the project name, stack, files, or runtime state until you have verified them with tool evidence.",
    "If you need a file but are unsure it exists, list or search first instead of guessing paths such as README.md.",
    "When reporting a debug fix, base the root cause and final summary only on observed tool output and source code; do not speculate about code you did not see.",
    "After debugging or editing code, the final answer should include the observed failure, exact root cause expression or file location when known, changed files, and verification result.",
    "Keep normal answers concise, calm, and product-like.",
    "Use emoji only when it fits the user's tone, preference, and task context; avoid emoji in serious debugging or incident-style work unless the user likes that style.",
    "Avoid hype, decorative openings, and marketing-style introductions unless the user asks for that tone.",
    "Use Markdown for readable structure when helpful: short headings, bullets, tables, and code blocks are supported."
  ].join("\n");
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

export function loadOpenAiConfig(filePath = process.env["SCC_API_KEY_FILE"] ?? "dont_touch_(APIKEY).md"): OpenAIProviderConfig {
  const fileConfig = loadOpenAiProviderConfig(filePath);
  const apiKey = process.env["OPENAI_API_KEY"] ?? fileConfig.apiKey;
  const baseURL = process.env["OPENAI_BASE_URL"] ?? process.env["OPENAI_BASEURL"] ?? process.env["SCC_OPENAI_BASE_URL"] ?? fileConfig.baseURL;
  const model = process.env["SCC_MODEL"] ?? process.env["OPENAI_MODEL"] ?? fileConfig.model;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {})
  };
}

export function loadOpenAiProviderConfig(
  filePath = process.env["SCC_API_KEY_FILE"] ?? "dont_touch_(APIKEY).md"
): OpenAIProviderConfigWithName {
  const section = loadOpenAiConfigFileSection(filePath);
  return section ? { ...section.config, providerName: section.name } : {};
}

function loadOpenAiConfigFileSection(filePath: string): OpenAIProviderSection | undefined {
  const resolvedPath = resolveApiKeyPath(filePath);
  if (!existsSync(resolvedPath)) return undefined;

  const sections = parseProviderSections(readFileSync(resolvedPath, "utf8"));
  const preferredProvider = process.env["SCC_API_PROVIDER"] ?? process.env["OPENAI_PROVIDER"];
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
  return /^(SCC_MODEL|OPENAI_MODEL|model|canonicalLiveModel)$/i.test(name);
}

function looksLikeProviderHeading(line: string): boolean {
  if (line.startsWith("|") || line.startsWith("<") || line.startsWith("```")) return false;
  if (line.length > 80) return false;
  return /^[\p{L}\p{N}_ ().-]+$/u.test(line);
}

function cleanHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

function normalizeBaseURL(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/chat\/completions\/?$/i, "");
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
  const lines = [`Task: ${task.title}`, ""];
  for (const event of task.events) {
    if (event.type === "status_changed" || event.type === "task_created") continue;
    if (event.type === "tool_result") {
      lines.push(`tool_result: ${String(event.payload["output"] ?? "").slice(0, 6000)}`);
      continue;
    }
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

function extractToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  const calls: ToolCall[] = [];
  for (const item of toolCalls) {
    if (!isRecord(item) || item["type"] !== "function" || !isRecord(item["function"])) continue;
    const fn = item["function"];
    const rawArgs = typeof fn["arguments"] === "string" ? fn["arguments"] : "{}";
    calls.push({
      id: createId("tool_call"),
      toolName: String(fn["name"] ?? "unknown_tool"),
      args: parseArgs(rawArgs)
    });
  }
  return calls;
}

function toolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Request a local shell command. The application classifies risk and may ask the user before running it.",
        parameters: strictObject({
          command: { type: "string", description: "The command to run. Prefer read-only observation unless the user asked for changes." },
          cwd: { type: "string", description: "Working directory inside the task folder. Defaults to the task folder root." }
        }, ["command"])
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file content inside the task folder with optional 1-based line range. Use this instead of run_command for file reads. If the path is uncertain, call list_files or search_files first.",
        parameters: strictObject({
          path: { type: "string" },
          offset: { type: "number", description: "Start line, default 1" },
          limit: { type: "number", description: "Maximum lines, default 200" }
        }, ["path"])
      }
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a project file by line ranges. Include expectedHash from read_file when available.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
          expectedHash: { type: "string", description: "Hash from read_file; use __new__ only when creating a new file." },
            edits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                  newText: { type: "string" }
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
        name: "search_files",
        description: "Search project file paths and text content.",
        parameters: strictObject({
          query: { type: "string" },
          path: { type: "string", description: "Directory to search, default project root" }
        }, ["query"])
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a task folder directory. Use this before reading guessed project files.",
        parameters: strictObject({
          path: { type: "string", description: "Directory path, default ." },
          recursive: { type: "boolean", description: "Whether to recurse" }
        }, [])
      }
    },
    {
      type: "function",
      function: {
        name: "use_skill",
        description: "Load a listed skill's full guidance into the next context. Use only for directly relevant skills.",
        parameters: strictObject({
          skillId: { type: "string", description: "Skill ID from Available Skills" }
        }, ["skillId"])
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
