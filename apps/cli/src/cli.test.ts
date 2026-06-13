import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench, InMemoryWorkbenchStore, type ModelClient, type ModelTurn } from "@agent-workbench/core";
import { createApp, type ServerStartOptions } from "@agent-workbench/server";
import { parseArgs } from "./args.js";
import { ApiClient } from "./http.js";
import { renderValue } from "./render.js";
import { runCli, type CliIO } from "./commands.js";

class StaticFinalModelClient implements ModelClient {
  async next(): Promise<ModelTurn> {
    return { kind: "final", message: "Accepted from CLI test." };
  }
}

describe("CLI argv parser", () => {
  it("parses global flags, repeated options, and command positionals", () => {
    const parsed = parseArgs(["--api", "http://127.0.0.1:5177", "--json", "task", "create", "hello", "--attach", "a.md", "--attach=b.md"]);
    expect(parsed.command).toEqual(["task", "create", "hello"]);
    expect(parsed.options["api"]).toBe("http://127.0.0.1:5177");
    expect(parsed.options["json"]).toBe(true);
    expect(parsed.options["attach"]).toEqual(["a.md", "b.md"]);
  });
});

describe("CLI HTTP client", () => {
  it("bootstraps a session token and sends it on protected requests", async () => {
    const seenHeaders: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken: "session_cli_test" });
      seenHeaders.push(new Headers(init?.headers).get("x-agent-workbench-session") ?? "");
      return jsonResponse([{ id: "task_1", title: "Task", status: "completed" }]);
    });
    const client = new ApiClient({ baseUrl: "http://local.test", fetchImpl });

    const tasks = await client.request<Array<{ id: string }>>("/api/tasks");

    expect(tasks[0]?.id).toBe("task_1");
    expect(seenHeaders).toEqual(["session_cli_test"]);
  });

  it("prints a clear server-start hint when the API is unreachable", async () => {
    const io = captureIo();
    const code = await runCli(["--api", "http://127.0.0.1:59999", "health"], {
      io,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      }
    });

    expect(code).toBe(1);
    expect(io.stderrText()).toContain("aw serve");

    const jsonIo = captureIo();
    const jsonCode = await runCli(["--api", "http://127.0.0.1:59999", "--json", "health"], {
      io: jsonIo,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      }
    });
    const diagnostic = JSON.parse(jsonIo.stderrText()) as { ok: boolean; error: { code: string; hint: string } };
    expect(jsonCode).toBe(1);
    expect(diagnostic.ok).toBe(false);
    expect(diagnostic.error.code).toBe("connection_failed");
    expect(diagnostic.error.hint).toContain("aw serve");
  });
});

describe("CLI command contracts", () => {
  it("prints command-specific help and typo suggestions", async () => {
    const taskIo = captureIo();
    expect(await runCli(["task", "--help"], { io: taskIo })).toBe(0);
    expect(taskIo.stdoutText()).toContain("aw task create");
    expect(taskIo.stdoutText()).toContain("aw task attachments list");

    const searchIo = captureIo();
    expect(await runCli(["search-provider", "--help"], { io: searchIo })).toBe(0);
    expect(searchIo.stdoutText()).toContain("aw search-provider add");
    expect(searchIo.stdoutText()).toContain("{query}");

    const typoIo = captureIo();
    expect(await runCli(["tsk", "list"], { io: typoIo })).toBe(2);
    expect(typoIo.stderrText()).toContain('Did you mean "aw task"?');
  });

  it("does not infer MCP transport on partial updates", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const io = captureIo();
    const code = await runCli(["--api", "http://local.test", "--json", "mcp", "server", "update", "mcp_1", "--label", "Renamed"], {
      io,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken: "session_cli_test" });
        seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ id: "mcp_1", label: "Renamed" });
      }
    });

    expect(code).toBe(0);
    expect(seenBody).toEqual({ label: "Renamed" });
  });

  it("tests model providers through the server API", async () => {
    const seen: string[] = [];
    const io = captureIo();
    const code = await runCli(["--api", "http://local.test", "provider", "test", "provider_1"], {
      io,
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken: "session_cli_test" });
        seen.push(url);
        return jsonResponse({
          providerId: "provider_1",
          label: "Mimo",
          ok: false,
          status: "failed",
          failureClass: "provider_configuration",
          statusCode: 401
        });
      }
    });

    expect(code).toBe(0);
    expect(seen).toEqual(["http://local.test/api/model-providers/provider_1/test"]);
    expect(io.stdoutText()).toContain("provider_configuration");
  });

  it("sends approval reasons through the task approval API", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const io = captureIo();
    const code = await runCli(["--api", "http://local.test", "--json", "task", "approve", "task_1", "approval_1", "allow-global", "--reason", "trusted local read"], {
      io,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken: "session_cli_test" });
        seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ id: "task_1", status: "running" });
      }
    });

    expect(code).toBe(0);
    expect(seenBody).toEqual({ decision: "allow_globally", reason: "trusted local read" });
  });

  it("requires url for knowledge model downloads and sends it to the API", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const io = captureIo();
    const code = await runCli(["--api", "http://local.test", "--json", "knowledge", "download-model", "tiny_reranker_model", "https://example.test/model.bin", "--file-name", "model.bin"], {
      io,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/session/bootstrap")) return jsonResponse({ sessionToken: "session_cli_test" });
        seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ asset: { kind: "tiny_reranker_model", label: "Tiny", exists: true, configured: true }, preferences: {} });
      }
    });

    expect(code).toBe(0);
    expect(seenBody).toMatchObject({
      kind: "tiny_reranker_model",
      url: "https://example.test/model.bin",
      fileName: "model.bin"
    });
  });

  it("rejects ambiguous streaming or externally bound local-session commands", async () => {
    const watchIo = captureIo();
    expect(await runCli(["--json", "task", "create", "hello", "--watch"], { io: watchIo })).toBe(2);
    expect(watchIo.stderrText()).toContain("--json cannot be combined with --watch");

    const serveIo = captureIo();
    expect(await runCli(["serve", "--host", "0.0.0.0"], { io: serveIo })).toBe(2);
    expect(serveIo.stderrText()).toContain("non-loopback");
  });
});

describe("CLI renderers", () => {
  it("renders arrays as compact tables and preserves JSON when requested", () => {
    expect(renderValue([{ id: "provider_1", label: "Mimo", enabled: true }], false)).toContain("provider_1");
    expect(renderValue([{ id: "provider_1", label: "Mimo" }], true)).toContain('"label": "Mimo"');
  });
});

describe("CLI integration against the local server API", () => {
  const cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it("covers health, task, permission, knowledge, skill, attachment, and serve flows", async () => {
    const app = await createApp({
      logger: false,
      workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new StaticFinalModelClient() })
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => app.close());
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address.");
    const api = `http://127.0.0.1:${address.port}`;
    const tempDir = mkdtempSync(join(tmpdir(), "aw-cli-"));
    cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
    const attachmentPath = join(tempDir, "note.md");
    writeFileSync(attachmentPath, "# CLI note\nsecret=not-for-output", "utf8");

    await expectCli(["--api", api, "health", "--json"], /"ok": true/);
    await expectCli(["--api", api, "permission", "grant", "workspace_read", "--reason", "cli test", "--json"], /workspace_read/);
    await expectCli(["--api", api, "permission", "list"], /workspace_read/);
    const task = await expectCli(["--api", api, "task", "create", "Investigate CLI coverage", "--json"], /Investigate CLI coverage/);
    const taskId = JSON.parse(task.stdoutText()).id as string;
    await expectCli(["--api", api, "task", "show", taskId], /Investigate CLI coverage/);
    await expectCli(["--api", api, "task", "transcript", taskId], /user_message/);
    await expectCli(["--api", api, "task", "control", taskId, "cancel", "--json"], /cancelled/);
    await expectCli(["--api", api, "task", "attachments", "upload", attachmentPath, "--json"], /note.md/);
    const attachedTask = await expectCli(["--api", api, "task", "create", "Attach CLI note", "--attach", attachmentPath, "--json"], /Attach CLI note/);
    const attachedTaskId = JSON.parse(attachedTask.stdoutText()).id as string;
    await expectCli(["--api", api, "task", "attachments", "list", attachedTaskId, "--json"], /note.md/);
    await expectCli(["--api", api, "task", "control", attachedTaskId, "cancel", "--json"], /cancelled/);
    const knowledge = await expectCli(["--api", api, "knowledge", "add", "CLI Knowledge", "runtime approvals are searchable", "--tag", "cli", "--json"], /CLI Knowledge/);
    const knowledgeId = JSON.parse(knowledge.stdoutText()).id as string;
    await expectCli(["--api", api, "knowledge", "search", "runtime approvals", "--json"], /CLI Knowledge/);
    await runOk(["--api", api, "knowledge", "delete", knowledgeId, "--json"]);
    const knowledgeList = await expectCli(["--api", api, "knowledge", "list", "--json"], /\[/);
    expect(knowledgeList.stdoutText()).not.toContain("CLI Knowledge");
    const skill = await expectCli(["--api", api, "skill", "create", "CLI Skill", "Use the CLI through local HTTP APIs.", "--json"], /CLI Skill/);
    const skillId = JSON.parse(skill.stdoutText()).id as string;
    await expectCli(["--api", api, "skill", "list"], /CLI Skill/);
    await expectCli(["--api", api, "skill", "export", skillId], /Use the CLI through local HTTP APIs/);
    await runOk(["--api", api, "skill", "delete", skillId, "--json"]);
    const skillList = await expectCli(["--api", api, "skill", "list", "--json"], /\[/);
    expect(skillList.stdoutText()).not.toContain("CLI Skill");
    await runOk(["--api", api, "permission", "revoke", "workspace_read", "--json"]);
    const permissions = await expectCli(["--api", api, "permission", "list", "--json"], /\[/);
    expect(permissions.stdoutText()).not.toContain("workspace_read");

    let serveOptions: ServerStartOptions | undefined;
    const serveIo = captureIo();
    const serveCode = await runCli(["serve", "--host", "0.0.0.0", "--port", "6001", "--yes"], {
      io: serveIo,
      startServer: async (options) => {
        serveOptions = options;
        return app;
      }
    });
    expect(serveCode).toBe(0);
    expect(serveOptions).toEqual({ host: "0.0.0.0", port: 6001 });
  });
});

async function runOk(argv: string[]): Promise<ReturnType<typeof captureIo>> {
  const io = captureIo();
  const code = await runCli(argv, { io });
  expect(code).toBe(0);
  return io;
}

async function expectCli(argv: string[], pattern: RegExp): Promise<ReturnType<typeof captureIo>> {
  const io = captureIo();
  const code = await runCli(argv, { io });
  expect(code).toBe(0);
  expect(io.stdoutText()).toMatch(pattern);
  return io;
}

function captureIo(): CliIO & { stdoutText: () => string; stderrText: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
