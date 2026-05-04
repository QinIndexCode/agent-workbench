import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolCall, ToolResult } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

const execFileAsync = promisify(execFile);

export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

export class ShellToolExecutor implements ToolExecutor {
  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.toolName !== "run_command") {
      return this.result(call, false, `Unknown tool: ${call.toolName}`);
    }

    const command = String(call.args["command"] ?? "");
    if (!command.trim()) {
      return this.result(call, false, "Missing command.");
    }

    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        : ["-lc", command];

    try {
      const { stdout, stderr } = await execFileAsync(shell, args, {
        cwd: process.cwd(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      });
      return this.result(call, true, [stdout, stderr].filter(Boolean).join("\n").trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result(call, false, message);
    }
  }

  private result(call: ToolCall, ok: boolean, output: string): ToolResult {
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok,
      output,
      createdAt: nowIso()
    };
  }
}
