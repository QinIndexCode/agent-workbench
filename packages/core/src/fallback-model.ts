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
    const lastToolResult = [...task.events].reverse().find((event) => event.type === "tool_result");
    const lastAssistant = [...task.events].reverse().find((event) => event.type === "assistant_message");
    if (lastToolResult && (!lastAssistant || lastToolResult.createdAt > lastAssistant.createdAt)) {
      return { kind: "final", message: summarizeHostObservation(String(lastToolResult.payload["output"] ?? "")) };
    }

    const denied = [...task.events].reverse().find(
      (event) => event.type === "approval_resolved" && event.payload["decision"] === "deny"
    );
    if (denied) {
      return {
        kind: "final",
        message: "The requested tool action was denied. I need a different approved path or more context."
      };
    }

    const text = task.events
      .filter((event) => event.type === "user_message" || event.type === "guidance_consumed")
      .map((event) => event.summary)
      .join("\n")
      .toLowerCase();

    if (mentionsHostProcesses(text)) {
      return {
        kind: "tool_calls",
        calls: [
          {
            id: createId("tool_call"),
            toolName: "run_command",
            args: {
              command:
                "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 15 ProcessName,Id,CPU,WorkingSet64,PM | ConvertTo-Json -Depth 3"
            }
          }
        ]
      };
    }

    return {
      kind: "final",
      message:
        "I have the task recorded. Configure a model provider or give me a concrete tool-backed next step to continue."
    };
  }
}

function mentionsHostProcesses(text: string): boolean {
  return [
    "process",
    "running software",
    "desktop running",
    "performance",
    "cpu",
    "memory",
    "运行",
    "软件",
    "性能",
    "占用",
    "进程"
  ].some((term) => text.includes(term));
}

function summarizeHostObservation(output: string): string {
  const rows = parseJsonRows(output);
  if (rows.length === 0) {
    return output ? `Command completed. Raw output:\n\n${output.slice(0, 4000)}` : "Command completed with no output.";
  }

  const lines = rows.slice(0, 10).map((row, index) => {
    const name = String(row["ProcessName"] ?? "unknown");
    const id = String(row["Id"] ?? "");
    const cpu = Number(row["CPU"] ?? 0).toFixed(2);
    const memoryMb = (Number(row["WorkingSet64"] ?? row["PM"] ?? 0) / 1024 / 1024).toFixed(1);
    return `${index + 1}. ${name} ${id ? `(PID ${id})` : ""} CPU ${cpu}, memory ${memoryMb} MB`;
  });

  return `Top running processes by accumulated CPU from the host observation:\n\n${lines.join("\n")}`;
}

function parseJsonRows(output: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}
