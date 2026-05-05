import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import OpenAI from "openai";
import type { TaskDetail, ToolCall } from "@scc/shared";
import type { ContextAssembler } from "./context-assembler.js";
import { createId } from "./ids.js";
import type { ModelClient, ModelTurn } from "./fallback-model.js";
import { ConfiguredToolModelClient, FallbackModelClient } from "./fallback-model.js";

export interface OpenAIModelClientOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  contextAssembler?: ContextAssembler | undefined;
}

export class OpenAIModelClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly contextAssembler: ContextAssembler | undefined;

  constructor(options: OpenAIModelClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {})
    });
    this.model = options.model ?? process.env["SCC_MODEL"] ?? "gpt-5.4-mini";
    this.contextAssembler = options.contextAssembler;
  }

  async next(task: TaskDetail): Promise<ModelTurn> {
    return this.nextWithSkillRetries(task, 0);
  }

  private async nextWithSkillRetries(task: TaskDetail, skillRetryCount: number): Promise<ModelTurn> {
    const context = this.contextAssembler ? await this.contextAssembler.assemble(task) : null;
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: context?.systemPrompt ?? fallbackInstructions() },
        { role: "user", content: context?.input ?? buildInput(task) }
      ],
      tool_choice: "auto" as const,
      tools: toolDefinitions()
    });

    const message = response.choices[0]?.message;
    const calls = extractToolCalls(message?.tool_calls);
    const skillCall = calls.find((call) => call.toolName === "use_skill");
    if (skillCall && this.contextAssembler) {
      const skillId = String(skillCall.args["skillId"] ?? "");
      const skill = await this.contextAssembler.loadSkill(task.id, skillId);
      if ((skill || skillRetryCount < 2) && skillRetryCount < 3) return this.nextWithSkillRetries(task, skillRetryCount + 1);
    }

    const executableCalls = calls.filter((call) => call.toolName !== "use_skill");
    if (executableCalls.length > 0) return { kind: "tool_calls", calls: executableCalls };

    const content = extractText(message?.content).trim();
    return { kind: "final", message: content || "I could not produce a result from the model response." };
  }
}

export function createModelClientFromEnvironment(options: { contextAssembler?: ContextAssembler } = {}): ModelClient {
  if (process.env["SCC_TEST_TOOL_COMMAND"]) {
    return new ConfiguredToolModelClient(process.env["SCC_TEST_TOOL_COMMAND"]);
  }
  const config = loadOpenAiConfig();
  return config.apiKey
    ? new OpenAIModelClient({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(options.contextAssembler ? { contextAssembler: options.contextAssembler } : {})
      })
    : new FallbackModelClient();
}

function fallbackInstructions(): string {
  return [
    "You are the SCC workbench agent.",
    "Choose the next action yourself based on the user's goal, available tools, permissions, and evidence.",
    "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
    "Do not emit fixed machine-readable wrappers, diagnostic files, or scripted review reports unless explicitly requested."
  ].join("\n");
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

interface OpenAIProviderSection {
  name: string;
  config: OpenAIProviderConfig;
}

export function loadOpenAiConfig(filePath = process.env["SCC_API_KEY_FILE"] ?? "dont_touch_(APIKEY).md"): OpenAIProviderConfig {
  const fileConfig = loadOpenAiConfigFile(filePath);
  const apiKey = process.env["OPENAI_API_KEY"] ?? fileConfig.apiKey;
  const baseURL = process.env["OPENAI_BASE_URL"] ?? process.env["OPENAI_BASEURL"] ?? process.env["SCC_OPENAI_BASE_URL"] ?? fileConfig.baseURL;
  const model = process.env["SCC_MODEL"] ?? process.env["OPENAI_MODEL"] ?? fileConfig.model;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {})
  };
}

function loadOpenAiConfigFile(filePath: string): OpenAIProviderConfig {
  const resolvedPath = resolveApiKeyPath(filePath);
  if (!existsSync(resolvedPath)) return {};

  const sections = parseProviderSections(readFileSync(resolvedPath, "utf8"));
  const preferredProvider = process.env["SCC_API_PROVIDER"] ?? process.env["OPENAI_PROVIDER"];
  const preferred = preferredProvider
    ? sections.find((section) => normalizeProviderName(section.name).includes(normalizeProviderName(preferredProvider)))
    : undefined;

  const complete = (section: OpenAIProviderSection): boolean => Boolean(section.config.apiKey && section.config.baseURL);
  return (
    preferred?.config ??
    sections.find((section) => complete(section) && section.config.model)?.config ??
    sections.find(complete)?.config ??
    sections[0]?.config ??
    {}
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

function toolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Request a local shell command. The application classifies risk and may ask the user before running it.",
        parameters: strictObject({
          command: { type: "string", description: "The command to run. Prefer read-only observation unless the user asked for changes." }
        }, ["command"])
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read workspace file content with optional 1-based line range. Use this instead of run_command for file reads.",
        parameters: strictObject({
          path: { type: "string" },
          offset: { type: "number", description: "Start line, default 1" },
          limit: { type: "number", description: "Maximum lines, default 200" }
        }, ["path", "offset", "limit"])
      }
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a workspace file by line ranges. Include expectedHash from read_file when available.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            expectedHash: { type: "string" },
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
        description: "Search workspace file paths and text content.",
        parameters: strictObject({
          query: { type: "string" },
          path: { type: "string", description: "Directory to search, default workspace root" }
        }, ["query", "path"])
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List workspace files in a directory.",
        parameters: strictObject({
          path: { type: "string", description: "Directory path, default ." },
          recursive: { type: "boolean", description: "Whether to recurse" }
        }, ["path", "recursive"])
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
    }
  ];
}

function strictObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
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
