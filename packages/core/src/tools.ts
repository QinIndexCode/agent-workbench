import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ToolCall, ToolResult } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export interface ToolExecutor {
  execute(call: ToolCall, options?: ToolExecutionOptions): Promise<ToolResult>;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export interface ToolExecutorDelegate extends ToolExecutor {
  canExecute(toolName: string): boolean;
}

export class CompositeToolExecutor implements ToolExecutor {
  constructor(
    private readonly fallback: ToolExecutor,
    private readonly delegates: ToolExecutorDelegate[] = []
  ) {}

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const delegate = this.delegates.find((item) => item.canExecute(call.toolName));
    return delegate ? delegate.execute(call, options) : this.fallback.execute(call, options);
  }
}

export class ShellToolExecutor implements ToolExecutor {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot = findWorkspaceRoot()) {
    this.workspaceRoot = workspaceRoot;
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    if (call.toolName === "run_command") {
      return this.runCommand(call, options);
    }
    if (call.toolName === "read_file") {
      return this.readFile(call);
    }
    if (call.toolName === "edit_file") {
      return this.editFile(call);
    }
    if (call.toolName === "search_files") {
      return this.searchFiles(call);
    }
    if (call.toolName === "list_files") {
      return this.listFiles(call);
    }

    return this.result(call, false, `Unknown tool: ${call.toolName}`);
  }

  private async runCommand(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    const command = String(call.args["command"] ?? "");
    if (!command.trim()) {
      return this.result(call, false, "Missing command.");
    }
    if (options.signal?.aborted) {
      return this.result(call, false, "Command cancelled before it started.");
    }

    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        : ["-lc", command];
    const cwd = this.resolveWorkspacePath(String(call.args["cwd"] ?? "."));

    return new Promise<ToolResult>((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const maxBuffer = 1024 * 1024;
      const child = execFile(shell, args, { cwd, maxBuffer, windowsHide: true }, async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelled) {
          resolveResult(await this.result(call, false, "Command cancelled by user."));
          return;
        }
        if (timedOut) {
          resolveResult(await this.result(call, false, "Command timed out after 30000ms and was terminated."));
          return;
        }
        if (error) {
          resolveResult(await this.result(call, false, [error.message, stderr].filter(Boolean).join("\n").trim()));
          return;
        }
        resolveResult(await this.result(call, true, [stdout, stderr].filter(Boolean).join("\n").trim()));
      });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendLimited(stdout, String(chunk), maxBuffer);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendLimited(stderr, String(chunk), maxBuffer);
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 30_000);

      const onAbort = () => {
        cancelled = true;
        child.kill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      function cleanup() {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }
    });
  }

  private async readFile(call: ToolCall): Promise<ToolResult> {
    try {
      const path = this.resolveWorkspacePath(String(call.args["path"] ?? ""));
      const content = await readFile(path, "utf8");
      const offset = Math.max(1, Number(call.args["offset"] ?? 1));
      const limit = Math.max(1, Number(call.args["limit"] ?? 200));
      const lines = content.split(/\r?\n/);
      const slice = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      return this.result(
        call,
        true,
        JSON.stringify(
          {
            path,
            offset,
            limit,
            totalLines: lines.length,
            content: slice,
            hash: hash(content),
            partial: offset > 1 || offset - 1 + limit < lines.length
          },
          null,
          2
        )
      );
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async editFile(call: ToolCall): Promise<ToolResult> {
    try {
      const path = this.resolveWorkspacePath(String(call.args["path"] ?? ""));
      const edits = Array.isArray(call.args["edits"]) ? call.args["edits"] : [];
      if (edits.length === 0) return this.result(call, false, "No edits provided.");

      const fileExists = existsSync(path);
      const current = fileExists ? await readFile(path, "utf8") : "";
      const expectedHash = String(call.args["expectedHash"] ?? "");
      if (!expectedHash) {
        return this.result(call, false, "Missing expectedHash. Read the file first, or use __new__ when creating a new file.");
      }
      const isNewFileIntent = !fileExists && expectedHash === "__new__";
      if (!isNewFileIntent && expectedHash !== hash(current)) {
        return this.result(call, false, `File changed before edit. Expected ${expectedHash}, actual ${hash(current)}.`);
      }

      const lines = current.split(/\r?\n/);
      const normalized = edits
        .map((edit) => {
          if (!isRecord(edit)) throw new Error("Invalid edit entry.");
          return {
            startLine: Number(edit["startLine"]),
            endLine: Number(edit["endLine"]),
            newText: String(edit["newText"] ?? "")
          };
        })
        .sort((a, b) => b.startLine - a.startLine);

      for (const edit of normalized) {
        if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine < 1) {
          throw new Error("Edit line ranges must be positive integers.");
        }
        if (edit.endLine < edit.startLine - 1) throw new Error("Invalid edit range.");
        const replacement = edit.newText.length > 0 ? edit.newText.split(/\r?\n/) : [];
        lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement);
      }

      const next = lines.join("\n");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, next, "utf8");
      return this.result(call, true, JSON.stringify({ path, hash: hash(next), changed: current !== next }, null, 2));
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async searchFiles(call: ToolCall): Promise<ToolResult> {
    try {
      const query = String(call.args["query"] ?? "");
      if (!query.trim()) return this.result(call, false, "Missing query.");
      const root = this.resolveWorkspacePath(String(call.args["path"] ?? "."));
      const files = await walk(root, 300);
      const matches: Array<{ path: string; line?: number; text?: string }> = [];
      for (const file of files) {
        if (matches.length >= 100) break;
        if (file.toLowerCase().includes(query.toLowerCase())) {
          matches.push({ path: file });
          continue;
        }
        if (!isTextFile(file)) continue;
        const content = await readFile(file, "utf8").catch(() => "");
        const lines = content.split(/\r?\n/);
        const index = lines.findIndex((line) => line.toLowerCase().includes(query.toLowerCase()));
        if (index >= 0) {
          const text = lines[index]?.slice(0, 240);
          matches.push(text ? { path: file, line: index + 1, text } : { path: file, line: index + 1 });
        }
      }
      return this.result(call, true, JSON.stringify({ query, matches }, null, 2));
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async listFiles(call: ToolCall): Promise<ToolResult> {
    try {
      const root = this.resolveWorkspacePath(String(call.args["path"] ?? "."));
      const recursive = Boolean(call.args["recursive"] ?? false);
      const files = recursive ? await walk(root, 500) : await list(root);
      return this.result(call, true, JSON.stringify({ path: root, files }, null, 2));
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async result(call: ToolCall, ok: boolean, output: string): Promise<ToolResult> {
    const id = createId("tool_result");
    return {
      id,
      toolCallId: call.id,
      ok,
      output: await materializeOutput(this.workspaceRoot, id, output),
      createdAt: nowIso()
    };
  }

  private resolveWorkspacePath(input: string): string {
    return resolveWorkspacePath(this.workspaceRoot, input);
  }
}

function resolveWorkspacePath(root: string, input: string): string {
  if (!input.trim()) throw new Error("Missing path.");
  const full = resolve(root, input);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  return full;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function list(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => resolve(root, entry.name));
}

async function walk(root: string, maxFiles: number): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (output.length >= maxFiles) return;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage" || entry.name.startsWith(".")) {
        continue;
      }
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else output.push(full);
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await visit(root);
  else output.push(root);
  return output;
}

function isTextFile(path: string): boolean {
  return /\.(cjs|css|html|js|json|jsx|md|mjs|ts|tsx|txt|yml|yaml)$/i.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendLimited(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

async function materializeOutput(workspaceRoot: string, resultId: string, output: string): Promise<string> {
  if (output.length <= 12000) return output;
  const rawOutputRef = resolve(workspaceRoot, "data", "tool-output", `${resultId}.txt`);
  await mkdir(dirname(rawOutputRef), { recursive: true });
  await writeFile(rawOutputRef, output, "utf8");
  return JSON.stringify(
    {
      truncated: true,
      totalChars: output.length,
      rawOutputRef,
      summary: `${output.slice(0, 4000)}\n\n... output truncated; raw output is stored on disk ...\n\n${output.slice(-3000)}`
    },
    null,
    2
  );
}

function findWorkspaceRoot(): string {
  const configured = process.env["SCC_WORKSPACE_ROOT"];
  if (configured?.trim()) return resolve(configured);

  let current = process.cwd();
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        if (Array.isArray(parsed["workspaces"])) return current;
      } catch {
        // Keep walking; a malformed package file should not hide a valid parent workspace.
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) return process.cwd();
    current = parent;
  }
}
