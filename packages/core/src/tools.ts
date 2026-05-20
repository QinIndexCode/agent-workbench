import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolCall, ToolResult } from "@agent-workbench/shared";
import { createId, nowIso } from "./ids.js";
import { resolveWorkspacePathStrict } from "./path-guards.js";
import { defaultTaskWorkRoot } from "./workspace-root.js";

const DEFAULT_READ_RANGE_LINES = 200;
const READ_FILE_FULL_INLINE_BYTES = 96 * 1024;
const READ_FILE_FULL_INLINE_LINES = 360;
const READ_FILE_FULL_INLINE_CHARS = 24 * 1024;
const READ_FILE_COMPACT_FULL_BYTES = 64 * 1024;
const READ_FILE_COMPACT_FULL_LINES = 900;
const READ_FILE_COMPACT_FULL_CHARS = 64 * 1024;
const READ_FILE_RESULT_INLINE_CHARS = 320 * 1024;
const LARGE_FILE_HEAD_LINES = 220;
const LARGE_FILE_TAIL_LINES = 120;
const WRITE_CHUNK_CHARS = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface ToolProgressUpdate {
  status?: "running" | "completed" | "failed";
  targetPath?: string;
  operation?: string;
  changes?: { path: string; addedLines: number; removedLines: number; operation?: string };
  progress?: { processed?: number; total?: number; unit?: "bytes" | "lines" | "files" | "items" };
  message?: string;
  tail?: string;
  displayMode?: "inline" | "summary_only";
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
  workRoot?: string;
  projectId?: string;
  timeoutMs?: number;
  onProgress?: (progress: ToolProgressUpdate) => void | Promise<void>;
}

export interface ToolExecutor {
  execute(call: ToolCall, options?: ToolExecutionOptions): Promise<ToolResult>;
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
  private readonly defaultTimeoutMs: number;

  constructor(workspaceRoot = defaultTaskWorkRoot(), defaultTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    this.workspaceRoot = workspaceRoot;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const scopedRoot = this.rootFor(options);
    if (scopedRoot !== this.workspaceRoot) {
      const scopedExecutor = new ShellToolExecutor(scopedRoot, this.defaultTimeoutMs);
      const { workRoot: _workRoot, ...scopedOptions } = options;
      return scopedExecutor.execute(call, scopedOptions);
    }

    if (call.toolName === "run_command") {
      return this.runCommand(call, options);
    }
    if (call.toolName === "read_file") {
      return this.readFile(call, options);
    }
    if (call.toolName === "edit_file") {
      return this.editFile(call, options);
    }
    if (call.toolName === "write_file") {
      return this.writeFileDirect(call, options);
    }
    if (call.toolName === "search_files") {
      return this.searchFiles(call, options);
    }
    if (call.toolName === "list_files") {
      return this.listFiles(call, options);
    }

    return this.result(call, false, `Unknown tool: ${call.toolName}`);
  }

  private async runCommand(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    const rawCommand = String(call.args["command"] ?? "");
    if (!rawCommand.trim()) {
      return this.result(call, false, "Missing command.");
    }
    if (options.signal?.aborted) {
      return this.result(call, false, "Command cancelled before it started.");
    }
    const command = normalizeCommandForExecution(rawCommand);

    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        : ["-lc", command];
    const root = this.rootFor(options);
    const cwd = await this.resolveWorkspacePath(String(call.args["cwd"] ?? "."), root);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    await emitToolProgress(options, { status: "running", operation: "run_command", message: "Command process started.", progress: { processed: 0, unit: "bytes" } });

    return new Promise<ToolResult>((resolveResult) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const maxBuffer = 1024 * 1024;
      const child = execFile(shell, args, { cwd, encoding: "buffer", maxBuffer, windowsHide: true }, async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelled) {
          resolveResult(await this.result(call, false, "Command cancelled by user."));
          return;
        }
        if (timedOut) {
          resolveResult(await this.result(call, false, `Command timed out after ${timeoutMs}ms and was terminated.`));
          return;
        }
        if (error) {
          resolveResult(await this.result(call, false, [error.message, decodeCommandOutput(stderr)].filter(Boolean).join("\n").trim()));
          return;
        }
        resolveResult(await this.result(call, true, [decodeCommandOutput(stdout), decodeCommandOutput(stderr)].filter(Boolean).join("\n").trim()));
      });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendLimitedBuffer(stdout, chunk, maxBuffer);
        void emitToolProgress(options, {
          status: "running",
          operation: "run_command",
          progress: { processed: stdout.length + stderr.length, unit: "bytes" },
          tail: decodeCommandOutput(stdout).slice(-1200)
        });
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendLimitedBuffer(stderr, chunk, maxBuffer);
        void emitToolProgress(options, {
          status: "running",
          operation: "run_command",
          progress: { processed: stdout.length + stderr.length, unit: "bytes" },
          tail: decodeCommandOutput(stderr).slice(-1200)
        });
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(this.result(call, false, `Failed to start command: ${err.message}`));
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

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

  private async readFile(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    try {
      const requestedPath = String(call.args["path"] ?? "").trim();
      if (!requestedPath) {
        return this.result(call, false, "Missing path.");
      }
      const path = await this.resolveWorkspacePath(requestedPath, this.rootFor(options));
      if (isInternalTracePath(path)) {
        return this.result(call, false, "Agent Workbench internal trace files are excluded from workspace read tools.");
      }
      const hasExplicitRange = Object.hasOwn(call.args, "offset") || Object.hasOwn(call.args, "limit");
      const info = await stat(path);
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: "read",
        progress: { processed: 0, total: info.size, unit: "bytes" },
        displayMode: info.size > READ_FILE_FULL_INLINE_BYTES ? "summary_only" : "inline"
      });
      if (hasExplicitRange) {
        const offset = Math.max(1, Number(call.args["offset"] ?? 1));
        const limit = Math.max(1, Number(call.args["limit"] ?? DEFAULT_READ_RANGE_LINES));
        const range = await readTextLineRange(path, offset, limit);
        return this.result(
          call,
          true,
          JSON.stringify(
            {
              path,
              mode: "range",
              displayMode: "inline",
              offset,
              limit,
              sizeBytes: info.size,
              totalLines: range.totalLines,
              content: range.content,
              hash: range.hash,
              partial: offset > 1 || offset - 1 + limit < range.totalLines
            },
            null,
            2
          ),
          { maxInlineChars: READ_FILE_RESULT_INLINE_CHARS }
        );
      }

      const profile = await readTextFileProfile(path, info.size);
      const isFull =
        info.size <= READ_FILE_FULL_INLINE_BYTES &&
        profile.totalLines <= READ_FILE_FULL_INLINE_LINES &&
        profile.content.length <= READ_FILE_FULL_INLINE_CHARS;
      const isCompactFull =
        !isFull &&
        info.size <= READ_FILE_COMPACT_FULL_BYTES &&
        profile.totalLines <= READ_FILE_COMPACT_FULL_LINES &&
        profile.content.length <= READ_FILE_COMPACT_FULL_CHARS;
      return this.result(
        call,
        true,
        JSON.stringify(
          isFull
            ? {
                path,
                mode: "full",
                displayMode: "inline",
                sizeBytes: info.size,
                totalLines: profile.totalLines,
                content: profile.content,
                hash: profile.hash,
                partial: false
              }
            : isCompactFull
              ? {
                  path,
                  mode: "full_compact",
                  displayMode: "summary_only",
                  sizeBytes: info.size,
                  totalLines: profile.totalLines,
                  content: profile.content,
                  preview: profile.preview,
                  hash: profile.hash,
                  partial: false,
                  strategy:
                    "Full text is available to the model context, but the UI timeline shows a summary to keep the thread readable."
                }
            : {
                path,
                mode: "large_preview",
                displayMode: "summary_only",
                sizeBytes: info.size,
                totalLines: profile.totalLines,
                content: profile.preview,
                hash: profile.hash,
                partial: true,
                strategy:
                  "File is too large to inject fully into one model turn. Use read_file with offset/limit or search_files for targeted sections."
              },
          null,
          2
        ),
        { maxInlineChars: READ_FILE_RESULT_INLINE_CHARS }
      );
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async validateAndPrepareFileWrite(
    call: ToolCall,
    options: ToolExecutionOptions
  ): Promise<{ path: string; current: string; currentHash: string; existed: boolean } | ToolResult> {
    const path = await this.resolveWorkspacePath(String(call.args["path"] ?? ""), this.rootFor(options));
    const expectedHash = String(call.args["expectedHash"] ?? "");
    if (!expectedHash) {
      await emitToolProgress(options, {
        status: "failed",
        targetPath: path,
        operation: "hash_check",
        message: "Missing expectedHash; refusing to edit without a current file read."
      });
      return this.result(call, false, "Missing expectedHash. Read the file first, or use __new__ when creating a new file.");
    }

    const fileExists = existsSync(path);
    const current = fileExists ? await readFile(path, "utf8") : "";
    const currentHash = hash(current);
    const isNewFileIntent = !fileExists && expectedHash === "__new__";

    if (!isNewFileIntent && expectedHash !== currentHash) {
      await emitToolProgress(options, {
        status: "failed",
        targetPath: path,
        operation: "hash_check",
        message: "Expected hash did not match the current file; write was not started."
      });
      return this.conflictResult(call, path, expectedHash, currentHash, "File changed before write. The file may have been modified by another user or agent; read it again before editing.");
    }

    await emitToolProgress(options, {
      status: "running",
      targetPath: path,
      operation: "hash_check",
      message: isNewFileIntent ? "Confirmed new-file write intent." : "Verified expectedHash against current file.",
      progress: { processed: fileExists ? Buffer.byteLength(current, "utf8") : 0, total: fileExists ? Buffer.byteLength(current, "utf8") : 0, unit: "bytes" }
    });

    return { path, current, currentHash, existed: fileExists };
  }

  private async editFile(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    try {
      const edits = Array.isArray(call.args["edits"]) ? call.args["edits"] : [];
      if (edits.length === 0) return this.result(call, false, "No edits provided.");

      const validation = await this.validateAndPrepareFileWrite(call, options);
      if (!("path" in validation)) return validation;
      const { path, current, existed } = validation;

      const lines = current.split(/\r?\n/);
      const appliedEdits: Array<{ startLine: number; endLine: number; beforeText: string; afterText: string }> = [];
      const normalized = edits
        .map((edit) => {
          if (!isRecord(edit)) throw new Error("Invalid edit entry.");
          return {
            startLine: Number(edit["startLine"]),
            endLine: Number(edit["endLine"]),
            newText: String(edit["newText"] ?? ""),
            expectedText: typeof edit["expectedText"] === "string" ? String(edit["expectedText"]) : undefined
          };
        })
        .sort((a, b) => b.startLine - a.startLine);

      for (const edit of normalized) {
        if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine < 1) {
          throw new Error("Edit line ranges must be positive integers.");
        }
        if (edit.endLine < edit.startLine - 1) throw new Error("Invalid edit range.");
        if (edit.startLine > lines.length + 1 || edit.endLine > lines.length) {
          return this.conflictResult(call, path, String(call.args["expectedHash"] ?? ""), hash(current), `Edit range ${edit.startLine}-${edit.endLine} no longer matches the file. The file may have been modified by another user or agent; read it again before editing.`);
        }
        const existingText = lines.slice(edit.startLine - 1, edit.endLine).join("\n");
        if (edit.expectedText !== undefined) {
          if (normalizeNewlines(existingText) !== normalizeNewlines(edit.expectedText)) {
            return this.conflictResult(call, path, String(call.args["expectedHash"] ?? ""), hash(current), `Expected text for lines ${edit.startLine}-${edit.endLine} did not match current file content. The file may have been modified by another user or agent; read it again before editing.`);
          }
        }
        if (appliedEdits.length < 3) {
          appliedEdits.push({
            startLine: edit.startLine,
            endLine: edit.endLine,
            beforeText: previewEditText(existingText),
            afterText: previewEditText(edit.newText)
          });
        }
        const replacement = edit.newText.length > 0 ? edit.newText.split(/\r?\n/) : [];
        lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement);
      }

      const next = lines.join("\n");
      const changes = lineChangeSummary(path, current, next, existed ? "edit" : "create", existed);
      const nextBytes = Buffer.byteLength(next, "utf8");
      const displayMode = isLargeChange(changes, next) ? "summary_only" : "inline";
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: "diff",
        message: `Computed ${changes.operation} diff: +${changes.addedLines} / -${changes.removedLines} lines.`,
        changes,
        progress: { processed: changes.addedLines + changes.removedLines, total: changes.addedLines + changes.removedLines, unit: "lines" },
        displayMode
      });
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: changes.operation,
        message: "Writing updated file content.",
        changes,
        progress: { processed: 0, total: nextBytes, unit: "bytes" },
        displayMode
      });
      await writeTextFileInChunks(path, next, options, { path, changes, operation: changes.operation, totalBytes: nextBytes, displayMode });
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: "commit",
        message: "File write committed; verifying written hash.",
        changes,
        progress: { processed: nextBytes, total: nextBytes, unit: "bytes" },
        displayMode
      });
      const verification = await verifyWrittenFile(path, next);
      if (!verification.ok) {
        await emitToolProgress(options, {
          status: "failed",
          targetPath: path,
          operation: "verify",
          message: verification.message,
          changes,
          progress: { processed: nextBytes, total: nextBytes, unit: "bytes" },
          displayMode
        });
        return this.result(call, false, verification.message);
      }
      await emitToolProgress(options, {
        status: "completed",
        targetPath: path,
        operation: "verify",
        message: "Verified written file hash.",
        changes,
        progress: { processed: nextBytes, total: nextBytes, unit: "bytes" },
        displayMode
      });
      return this.result(
        call,
        true,
        JSON.stringify({
          status: "success",
          path,
          hash: hash(next),
          changed: current !== next,
          changes,
          editsApplied: appliedEdits.reverse(),
          displayMode
        }, null, 2)
      );
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async writeFileDirect(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    try {
      const content = String(call.args["content"] ?? "");
      const validation = await this.validateAndPrepareFileWrite(call, options);
      if (!("path" in validation)) return validation;
      const { path, current, existed } = validation;

      const changes = lineChangeSummary(path, current, content, existed ? "write" : "create", existed);
      const totalBytes = Buffer.byteLength(content, "utf8");
      const displayMode = isLargeChange(changes, content) ? "summary_only" : "inline";
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: "diff",
        message: `Computed ${changes.operation} diff: +${changes.addedLines} / -${changes.removedLines} lines.`,
        changes,
        progress: { processed: changes.addedLines + changes.removedLines, total: changes.addedLines + changes.removedLines, unit: "lines" },
        displayMode
      });
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: changes.operation,
        message: "Writing file content.",
        changes,
        progress: { processed: 0, total: totalBytes, unit: "bytes" },
        displayMode
      });
      await writeTextFileInChunks(path, content, options, { path, changes, operation: changes.operation, totalBytes, displayMode });
      await emitToolProgress(options, {
        status: "running",
        targetPath: path,
        operation: "commit",
        message: "File write committed; verifying written hash.",
        changes,
        progress: { processed: totalBytes, total: totalBytes, unit: "bytes" },
        displayMode
      });
      const verification = await verifyWrittenFile(path, content);
      if (!verification.ok) {
        await emitToolProgress(options, {
          status: "failed",
          targetPath: path,
          operation: "verify",
          message: verification.message,
          changes,
          progress: { processed: totalBytes, total: totalBytes, unit: "bytes" },
          displayMode
        });
        return this.result(call, false, verification.message);
      }
      await emitToolProgress(options, {
        status: "completed",
        targetPath: path,
        operation: "verify",
        message: "Verified written file hash.",
        changes,
        progress: { processed: totalBytes, total: totalBytes, unit: "bytes" },
        displayMode
      });
      return this.result(
        call,
        true,
        JSON.stringify(
          {
            status: "success",
            path,
            hash: hash(content),
            changed: current !== content,
            changes,
            sizeBytes: totalBytes,
            totalLines: countContentLines(content),
            displayMode
          },
          null,
          2
        )
      );
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async searchFiles(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    try {
      const query = String(call.args["query"] ?? "");
      if (!query.trim()) return this.result(call, false, "Missing query.");
      const terms = parseSearchTerms(query);
      const root = await this.resolveWorkspacePath(String(call.args["path"] ?? "."), this.rootFor(options));
      if (isInternalTracePath(root)) {
        return this.result(call, false, "Agent Workbench internal trace files are excluded from workspace search tools.");
      }
      await emitToolProgress(options, { status: "running", targetPath: root, operation: "search", message: "Scanning workspace files.", progress: { processed: 0, unit: "files" } });
      const files = await walk(root, 300);
      const matches: Array<{ path: string; line?: number; text?: string; matchedTerm?: string }> = [];
      for (const file of files) {
        if (matches.length >= 100) break;
        const pathTerm = findMatchedTerm(file, terms);
        if (pathTerm) {
          matches.push({ path: file, matchedTerm: pathTerm });
          continue;
        }
        if (!isTextFile(file)) continue;
        const content = await readFile(file, "utf8").catch(() => "");
        const lines = content.split(/\r?\n/);
        const matchedTermsInFile = new Set<string>();
        for (const [index, line] of lines.entries()) {
          if (matches.length >= 100 || matchedTermsInFile.size >= terms.length) break;
          const matchedTerm = findMatchedTerm(line, terms);
          if (!matchedTerm || matchedTermsInFile.has(matchedTerm)) continue;
          matchedTermsInFile.add(matchedTerm);
          const text = line.slice(0, 240);
          matches.push(text ? { path: file, line: index + 1, text, matchedTerm } : { path: file, line: index + 1, matchedTerm });
        }
      }
      return this.result(call, true, JSON.stringify({
        kind: "workspace_file_search",
        query,
        terms,
        note: "search_files returns matching project paths and line snippets only. Use read_file with the returned path, and offset/limit when needed, to inspect complete content.",
        matches
      }, null, 2));
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async listFiles(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    try {
      const root = await this.resolveWorkspacePath(String(call.args["path"] ?? "."), this.rootFor(options));
      if (isInternalTracePath(root)) {
        return this.result(call, false, "Agent Workbench internal trace files are excluded from workspace list tools.");
      }
      const recursive = Boolean(call.args["recursive"] ?? false);
      await emitToolProgress(options, { status: "running", targetPath: root, operation: "list", message: "Listing workspace files.", progress: { processed: 0, unit: "files" } });
      const files = recursive ? await walk(root, 500) : await list(root);
      return this.result(call, true, JSON.stringify({ path: root, files }, null, 2));
    } catch (error) {
      return this.result(call, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async result(call: ToolCall, ok: boolean, output: string, options: { maxInlineChars?: number } = {}): Promise<ToolResult> {
    const id = createId("tool_result");
    return {
      id,
      toolCallId: call.id,
      ok,
      output: await materializeOutput(this.workspaceRoot, id, output, options.maxInlineChars),
      createdAt: nowIso()
    };
  }

  private rootFor(options: ToolExecutionOptions = {}): string {
    return resolve(options.workRoot?.trim() || this.workspaceRoot);
  }

  private async resolveWorkspacePath(input: string, root: string): Promise<string> {
    return resolveWorkspacePathStrict(root, input);
  }

  private async conflictResult(call: ToolCall, path: string, expectedHash: string, actualHash: string, reason: string): Promise<ToolResult> {
    return this.result(
      call,
      false,
      JSON.stringify(
        {
          status: "conflict",
          path,
          expectedHash,
          actualHash,
          output: reason
        },
        null,
        2
      )
    );
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeCommandForExecution(command: string): string {
  if (process.platform !== "win32") return command;
  let current = command.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    const unwrapped = unwrapWindowsPowerShellCommand(current);
    if (!unwrapped || unwrapped === current) break;
    current = unwrapped;
  }
  return current;
}

function unwrapWindowsPowerShellCommand(command: string): string {
  const shellMatch = /^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)\b\s*([\s\S]*)$/i.exec(command.trim());
  if (!shellMatch) return command;
  let rest = shellMatch[1]?.trim() ?? "";
  if (!rest) return command;
  while (rest.length > 0) {
    if (/^-noprofile\b/i.test(rest)) {
      rest = rest.replace(/^-noprofile\b\s*/i, "").trim();
      continue;
    }
    if (/^-noninteractive\b/i.test(rest)) {
      rest = rest.replace(/^-noninteractive\b\s*/i, "").trim();
      continue;
    }
    if (/^-nologo\b/i.test(rest)) {
      rest = rest.replace(/^-nologo\b\s*/i, "").trim();
      continue;
    }
    if (/^-executionpolicy\b/i.test(rest)) {
      rest = rest.replace(/^-executionpolicy\b\s+\S+\s*/i, "").trim();
      continue;
    }
    break;
  }
  if (/^-encodedcommand\b/i.test(rest)) return command;
  const commandMatch = /^(?:-command|-c)\b\s*([\s\S]*)$/i.exec(rest);
  if (!commandMatch) return command;
  const inner = unwrapOuterShellQuotes(commandMatch[1]?.trim() ?? "");
  return inner || command;
}

function unwrapOuterShellQuotes(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value.at(-1) !== quote) return value;
  const unquoted = value.slice(1, -1);
  return quote === "\"" ? unquoted.replace(/""/g, "\"") : unquoted.replace(/''/g, "'");
}

function lineChangeSummary(
  path: string,
  before: string,
  after: string,
  operation: "create" | "edit" | "write",
  existed: boolean
): { path: string; addedLines: number; removedLines: number; operation: "create" | "edit" | "write" } {
  if (!existed) {
    return { path, addedLines: countContentLines(after), removedLines: 0, operation: "create" };
  }
  const beforeLines = splitComparableLines(before);
  const afterLines = splitComparableLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    path,
    addedLines: Math.max(0, afterLines.length - prefix - suffix),
    removedLines: Math.max(0, beforeLines.length - prefix - suffix),
    operation
  };
}

function splitComparableLines(value: string): string[] {
  if (!value) return [];
  const lines = normalizeNewlines(value).split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function countContentLines(value: string): number {
  return value.length === 0 ? 0 : splitComparableLines(value).length;
}

function isLargeChange(changes: { addedLines: number; removedLines: number }, content: string): boolean {
  return changes.addedLines + changes.removedLines > 160 || Buffer.byteLength(content, "utf8") > 64 * 1024;
}

async function list(root: string): Promise<string[]> {
  const rootInfo = await stat(root).catch(() => null);
  if (rootInfo?.isFile()) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && !entry.isSymbolicLink())
    .map((entry) => resolve(root, entry.name))
    .filter((path) => !isInternalTracePath(path));
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
      if (entry.isSymbolicLink()) continue;
      const full = resolve(dir, entry.name);
      if (isInternalTracePath(full)) continue;
      if (entry.isDirectory()) await visit(full);
      else output.push(full);
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await visit(root);
  else output.push(root);
  return output;
}

function isInternalTracePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith("/data/logs/model-traces") ||
    normalized.includes("/data/logs/model-traces/") ||
    normalized.endsWith("/.agent-workbench/traces") ||
    normalized.includes("/.agent-workbench/traces/")
  );
}

function isTextFile(path: string): boolean {
  return /\.(cjs|css|html|js|json|jsx|md|mjs|ts|tsx|txt|yml|yaml)$/i.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendLimitedBuffer(current: Buffer<ArrayBufferLike>, chunk: Buffer | string, maxBytes: number): Buffer<ArrayBufferLike> {
  const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const next = Buffer.concat([current, nextChunk]);
  return next.length <= maxBytes ? next : next.subarray(next.length - maxBytes);
}

function previewEditText(value: string, maxChars = 240): string {
  const compact = normalizeNewlines(value).trim();
  if (!compact) return "";
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 3)}...`;
}

function parseSearchTerms(query: string): string[] {
  const terms = query
    .split("|")
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length > 0 ? terms : [query.trim()];
}

function findMatchedTerm(value: string, terms: string[]): string {
  const normalized = value.toLowerCase();
  return terms.find((term) => normalized.includes(term.toLowerCase())) ?? "";
}

function decodeCommandOutput(buffer: Buffer<ArrayBufferLike>): string {
  if (buffer.length === 0) return "";
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    const gb18030 = new TextDecoder("gb18030").decode(buffer);
    return replacementCount(gb18030) < replacementCount(utf8) ? gb18030 : utf8;
  } catch {
    return utf8;
  }
}

function replacementCount(value: string): number {
  return (value.match(/\uFFFD/g) ?? []).length;
}

async function readTextFileProfile(path: string, sizeBytes: number): Promise<{ content: string; preview: string; totalLines: number; hash: string }> {
  const hasher = createHash("sha256");
  const collectFullContent = sizeBytes <= READ_FILE_FULL_INLINE_BYTES;
  const contentParts: string[] = [];
  const headLines: string[] = [];
  const tailLines: string[] = [];
  let carry = "";
  let totalLines = 0;

  const consumeLine = (line: string): void => {
    totalLines += 1;
    if (headLines.length < LARGE_FILE_HEAD_LINES) headLines.push(line);
    tailLines.push(line);
    if (tailLines.length > LARGE_FILE_TAIL_LINES) tailLines.shift();
  };

  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    const text = String(chunk);
    hasher.update(text);
    if (collectFullContent) contentParts.push(text);
    const lines = `${carry}${text}`.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  if (carry.length > 0) consumeLine(carry);

  const content = contentParts.join("");
  const omittedLines = Math.max(0, totalLines - headLines.length - tailLines.length);
  const preview = [
    `[Large file preview: ${sizeBytes} bytes, ${totalLines} lines. Full content is retained on disk and was not inserted into this tool result.]`,
    ...headLines,
    omittedLines > 0 ? `... (${omittedLines} lines omitted; use read_file with offset/limit or search_files for targeted sections) ...` : "",
    ...tailLines
  ].filter(Boolean).join("\n");
  if (collectFullContent) {
    return { content, preview, totalLines, hash: hasher.digest("hex").slice(0, 16) };
  }
  return { content: "", preview, totalLines, hash: hasher.digest("hex").slice(0, 16) };
}

async function readTextLineRange(path: string, offset: number, limit: number): Promise<{ content: string; totalLines: number; hash: string }> {
  const hasher = createHash("sha256");
  const selected: string[] = [];
  let carry = "";
  let totalLines = 0;
  const endLine = offset + limit - 1;

  const consumeLine = (line: string): void => {
    totalLines += 1;
    if (totalLines >= offset && totalLines <= endLine) selected.push(line);
  };

  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    const text = String(chunk);
    hasher.update(text);
    const lines = `${carry}${text}`.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  if (carry.length > 0) consumeLine(carry);

  return { content: selected.join("\n"), totalLines, hash: hasher.digest("hex").slice(0, 16) };
}

async function writeTextFileInChunks(
  path: string,
  content: string,
  options: ToolExecutionOptions = {},
  progress?: {
    path: string;
    changes: { path: string; addedLines: number; removedLines: number; operation?: string };
    operation: string;
    totalBytes: number;
    displayMode: "inline" | "summary_only";
  }
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  let processed = 0;
  try {
    for (let index = 0; index < content.length; index += WRITE_CHUNK_CHARS) {
      const chunk = content.slice(index, index + WRITE_CHUNK_CHARS);
      await handle.write(chunk, undefined, "utf8");
      processed += Buffer.byteLength(chunk, "utf8");
      if (progress) {
        await emitToolProgress(options, {
          status: "running",
          targetPath: progress.path,
          operation: progress.operation,
          changes: progress.changes,
          progress: { processed, total: progress.totalBytes, unit: "bytes" },
          displayMode: progress.displayMode
        });
      }
    }
  } finally {
    await handle.close();
  }
}

async function verifyWrittenFile(path: string, expectedContent: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const actual = await readFile(path, "utf8").catch((error: unknown) => {
    throw new Error(`Unable to verify written file: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (hash(actual) === hash(expectedContent)) return { ok: true };
  return { ok: false, message: "Written file hash did not match the intended content; inspect the file before continuing." };
}

async function emitToolProgress(options: ToolExecutionOptions, progress: ToolProgressUpdate): Promise<void> {
  if (!options.onProgress) return;
  try {
    await options.onProgress(progress);
  } catch {
    // Progress is best-effort and must not fail the tool itself.
  }
}

async function materializeOutput(workspaceRoot: string, resultId: string, output: string, maxInlineChars = 12000): Promise<string> {
  if (output.length <= maxInlineChars) return output;
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
