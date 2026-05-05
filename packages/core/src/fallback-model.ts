import type { TaskDetail, ToolCall } from "@scc/shared";
import { createId } from "./ids.js";

export type ModelTurn =
  | { kind: "final"; message: string }
  | { kind: "tool_calls"; calls: ToolCall[] };

export interface ModelClient {
  next(task: TaskDetail): Promise<ModelTurn>;
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
      message: "I have the task recorded, but no model provider is configured. Add an OpenAI API key or provide a concrete approved tool step."
    };
  }
}

export class ConfiguredToolModelClient implements ModelClient {
  constructor(private readonly command: string) {}

  async next(task: TaskDetail): Promise<ModelTurn> {
    const lastToolResult = [...task.events].reverse().find((event) => event.type === "tool_result");
    const lastAssistant = [...task.events].reverse().find((event) => event.type === "assistant_message");
    if (lastToolResult && (!lastAssistant || lastToolResult.createdAt > lastAssistant.createdAt)) {
      const output = String(lastToolResult.payload["output"] ?? "");
      return { kind: "final", message: output ? `Tool evidence returned:\n\n${output.slice(0, 4000)}` : "Tool completed with no output." };
    }

    return {
      kind: "tool_calls",
      calls: [{ id: createId("tool_call"), toolName: "run_command", args: { command: this.command } }]
    };
  }
}
