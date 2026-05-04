import { existsSync, readFileSync } from "node:fs";
import OpenAI from "openai";
import type { TaskDetail, ToolCall } from "@scc/shared";
import { createId } from "./ids.js";
import type { ModelClient, ModelTurn } from "./fallback-model.js";
import { FallbackModelClient } from "./fallback-model.js";

export interface OpenAIModelClientOptions {
  apiKey: string;
  model?: string;
}

export class OpenAIModelClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIModelClientOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? process.env["SCC_MODEL"] ?? "gpt-5.4-mini";
  }

  async next(task: TaskDetail): Promise<ModelTurn> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: [
        "You are the SCC workbench agent.",
        "Choose the next action yourself based on the user's goal, the available tools, and the evidence already shown.",
        "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
        "When evidence is enough, answer directly. Do not emit fixed wrappers or diagnostic files."
      ].join("\n"),
      input: buildInput(task),
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "run_command",
          description:
            "Request a local shell command. The application will classify risk and ask the user before running it.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: {
                type: "string",
                description: "The command to run. Prefer read-only observation unless the user asked for changes."
              }
            },
            required: ["command"]
          },
          strict: true
        }
      ]
    });

    const calls = extractToolCalls(response.output);
    if (calls.length > 0) return { kind: "tool_calls", calls };

    const message = extractText(response.output).trim();
    return { kind: "final", message: message || "I could not produce a result from the model response." };
  }
}

export function createModelClientFromEnvironment(): ModelClient {
  const apiKey = loadOpenAiKey();
  return apiKey ? new OpenAIModelClient({ apiKey }) : new FallbackModelClient();
}

function loadOpenAiKey(): string | undefined {
  if (process.env["OPENAI_API_KEY"]) return process.env["OPENAI_API_KEY"];

  const filePath = process.env["SCC_API_KEY_FILE"] ?? "dont_touch_(APIKEY).md";
  if (!existsSync(filePath)) return undefined;

  const text = readFileSync(filePath, "utf8");
  const envMatch = text.match(/OPENAI_API_KEY\s*=\s*([^\s]+)/);
  if (envMatch?.[1]) return envMatch[1].trim();

  const keyMatch = text.match(/sk-[A-Za-z0-9_\-]+/);
  return keyMatch?.[0];
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

function extractToolCalls(output: unknown): ToolCall[] {
  if (!Array.isArray(output)) return [];
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "function_call") continue;
    if (item["name"] !== "run_command") continue;
    const rawArgs = typeof item["arguments"] === "string" ? item["arguments"] : "{}";
    calls.push({
      id: createId("tool_call"),
      toolName: "run_command",
      args: parseArgs(rawArgs)
    });
  }
  return calls;
}

function extractText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "message" || !Array.isArray(item["content"])) continue;
    for (const part of item["content"]) {
      if (isRecord(part) && part["type"] === "output_text" && typeof part["text"] === "string") {
        chunks.push(part["text"]);
      }
    }
  }
  return chunks.join("\n");
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
