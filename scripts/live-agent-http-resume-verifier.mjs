import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "live-agent-http-resume");
const reportPath = resolve(outDir, "report.json");
const enabled =
  process.env["AGENT_WORKBENCH_LIVE_HTTP_AGENT"] === "1" ||
  process.env["AGENT_WORKBENCH_LIVE_MODEL_REQUIRED"] === "1" ||
  process.env["AGENT_WORKBENCH_FLAGSHIP_REPORT_REQUIRED"] === "1";
const required =
  process.env["AGENT_WORKBENCH_LIVE_HTTP_AGENT_REQUIRED"] === "1" ||
  process.env["AGENT_WORKBENCH_LIVE_MODEL_REQUIRED"] === "1" ||
  process.env["AGENT_WORKBENCH_FLAGSHIP_REPORT_REQUIRED"] === "1";
const fingerprint = sourceFingerprint(root);

mkdirSync(outDir, { recursive: true });

if (!enabled) {
  writeReport({
    status: "skipped",
    generatedAt: new Date().toISOString(),
    reason: "Set AGENT_WORKBENCH_LIVE_HTTP_AGENT=1 to run the live HTTP agent verifier.",
    sourceFingerprint: fingerprint
  });
  console.log("Live HTTP agent verifier skipped.");
  process.exit(0);
}

const provider = providerSummary();
const preflightIssues = [
  !provider.hasApiKey ? "missing API key" : "",
  !provider.baseURL ? "missing base URL" : "",
  !provider.model ? "missing model" : "",
  !existsSync(resolve(root, "apps", "server", "dist", "index.js")) ? "apps/server/dist/index.js is missing; run npm.cmd run build first" : ""
].filter(Boolean);

if (preflightIssues.length > 0) {
  const payload = {
    status: required ? "failed" : "skipped",
    generatedAt: new Date().toISOString(),
    reason: preflightIssues.join("; "),
    provider,
    sourceFingerprint: fingerprint
  };
  writeReport(payload);
  console.error(`Live HTTP agent verifier preflight ${payload.status}: ${payload.reason}`);
  process.exit(required ? 1 : 0);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = resolve(root, "data", "test-tmp", "live-http-agent", runId);
const projectRoot = resolve(runRoot, "workspace");
const dbPath = resolve(runRoot, "workbench.sqlite");
const previousEnv = snapshotEnv([
  "AGENT_WORKBENCH_DB_PATH",
  "AGENT_WORKBENCH_WORKSPACE_ROOT",
  "AGENT_WORKBENCH_DEFAULT_TASK_ROOT",
  "AGENT_WORKBENCH_LIVE_MODEL_SMOKE",
  "SCC_DB_PATH",
  "SCC_WORKSPACE_ROOT",
  "SCC_DEFAULT_TASK_ROOT"
]);

let server;
let taskId = "";
let restarted = false;
let checkpoints = [];
let passed = false;

try {
  prepareFixture(projectRoot);
  process.env["AGENT_WORKBENCH_DB_PATH"] = dbPath;
  process.env["AGENT_WORKBENCH_WORKSPACE_ROOT"] = runRoot;
  process.env["AGENT_WORKBENCH_DEFAULT_TASK_ROOT"] = projectRoot;
  delete process.env["SCC_DB_PATH"];
  delete process.env["SCC_WORKSPACE_ROOT"];
  delete process.env["SCC_DEFAULT_TASK_ROOT"];

  server = await startHttpServer();
  const created = await server.api("POST", "/api/tasks", {
    goal: [
      "这个小项目跑不起来，帮我定位并修好，最后给出证据。",
      "请按你认为合适的方式检查当前文件夹，不要只给建议。"
    ].join("\n"),
    title: "Live HTTP resume verifier",
    runMode: "target",
    targetLimits: { maxModelTurns: 40, maxToolCalls: 120, maxWallTimeMs: 900000 }
  });
  taskId = created.id;

  let resumeGuidanceSent = false;
  let task = created;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 900000) {
    task = await server.api("GET", `/api/tasks/${taskId}?eventLimit=1000`);
    const pendingApprovals = (task.approvals ?? []).filter((approval) => approval.status === "pending");
    if (!resumeGuidanceSent && pendingApprovals.length > 0) {
      resumeGuidanceSent = true;
      await server.close();
      server = await startHttpServer();
      restarted = true;
      await server.api("POST", `/api/tasks/${taskId}/messages`, {
        content: "继续刚才的任务。请使用已有证据推进，必要时补充验证，最终给出修复和验证证据。"
      });
      task = await server.api("GET", `/api/tasks/${taskId}?eventLimit=1000`);
    }
    await approvePending(server, task);
    if (["completed", "failed", "paused", "cancelled"].includes(task.status)) break;
    await sleep(1000);
  }

  task = await server.api("GET", `/api/tasks/${taskId}?eventLimit=1200`);
  await approvePending(server, task);
  if (!["completed", "paused", "failed"].includes(task.status)) {
    throw new Error(`Task did not reach a terminal or reviewable state, status=${task.status}`);
  }

  const events = await server.api("GET", `/api/tasks/${taskId}/events?eventLimit=1200`);
  checkpoints = await server.api("GET", `/api/tasks/${taskId}/checkpoints`);
  const validation = validateTaskEvidence({ task, events, checkpoints, restarted });
  const preview = checkpoints.length > 0 ? await server.api("POST", `/api/tasks/${taskId}/rollback/preview`, {}) : null;
  const rollback = checkpoints.length > 0 ? await server.api("POST", `/api/tasks/${taskId}/rollback`, {}) : null;
  const restoredBrokenSource = readFileSync(resolve(projectRoot, "src", "calculator.js"), "utf8").includes("return a - b");

  if (!validation.ok) throw new Error(validation.reason);
  if (!preview || preview.restorableFiles < 1) throw new Error("Rollback preview did not expose restorable files.");
  if (!rollback || rollback.restoredFiles < 1) throw new Error("Rollback did not restore any files.");
  if (!restoredBrokenSource) throw new Error("Rollback did not restore the original broken source.");

  writeReport({
    status: "passed",
    generatedAt: new Date().toISOString(),
    provider,
    taskId,
    dbPath,
    workspaceRoot: projectRoot,
    sourceFingerprint: fingerprint,
    evidence: summarizeEvidence(events),
    checkpoints: checkpoints.length,
    rollback: {
      previewRestorableFiles: preview.restorableFiles,
      restoredFiles: rollback.restoredFiles
    }
  });
  passed = true;
  console.log(`Live HTTP agent verifier passed. Report: ${reportPath}`);
} catch (error) {
  const diagnostics = await collectDiagnostics(server, taskId).catch((diagnosticError) => ({
    diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
  }));
  writeReport({
    status: "failed",
    generatedAt: new Date().toISOString(),
    provider,
    taskId,
    dbPath,
    workspaceRoot: projectRoot,
    sourceFingerprint: fingerprint,
    error: error instanceof Error ? error.message : String(error),
    diagnostics
  });
  console.error(`Live HTTP agent verifier failed. See ${reportPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (server) await server.close().catch(() => undefined);
  if (passed) rmSync(runRoot, { recursive: true, force: true });
  restoreEnv(previousEnv);
}

async function startHttpServer() {
  const { createApp } = await import("../apps/server/dist/index.js");
  const app = await createApp({ logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseURL = `http://127.0.0.1:${port}`;
  const bootstrap = await request(baseURL, "GET", "/api/session/bootstrap");
  const token = String(bootstrap.sessionToken ?? "");
  if (!token) throw new Error("Server did not return a session token.");
  return {
    app,
    baseURL,
    token,
    api(method, path, body) {
      return request(baseURL, method, path, body, token);
    },
    close() {
      return app.close();
    }
  };
}

async function approvePending(server, task) {
  for (const approval of task.approvals ?? []) {
    if (approval.status !== "pending") continue;
    if (approval.riskCategory === "destructive" || approval.riskCategory === "network") {
      await server.api("POST", `/api/tasks/${task.id}/approvals/${approval.id}`, { decision: "deny" });
      continue;
    }
    await server.api("POST", `/api/tasks/${task.id}/approvals/${approval.id}`, { decision: "allow_for_task" });
  }
}

function validateTaskEvidence({ task, events, checkpoints, restarted: didRestart }) {
  if (!didRestart) return { ok: false, reason: "Server restart did not occur after first tool evidence." };
  if (task.id !== taskId) return { ok: false, reason: "Task id changed across HTTP resume." };
  if (task.status !== "completed") return { ok: false, reason: `Task did not complete after resume; status=${task.status}.` };
  const types = new Set(events.map((event) => event.type));
  if (!events.some((event) => event.type === "task_graph_created" && event.payload?.source === "compiled")) {
    return { ok: false, reason: "Compiled primary task graph was not recorded." };
  }
  for (const requiredType of ["guidance_pending", "guidance_consumed", "tool_result", "assistant_message"]) {
    if (!types.has(requiredType)) return { ok: false, reason: `Missing ${requiredType} evidence.` };
  }
  if (!hasTool(events, "run_command")) return { ok: false, reason: "Missing run_command evidence." };
  if (!hasTool(events, "read_file") && !hasTool(events, "search_files")) return { ok: false, reason: "Missing file read/search evidence." };
  if (!hasTool(events, "edit_file") && !hasTool(events, "write_file") && !hasWorkspaceWriteCommandEvidence(task)) {
    return { ok: false, reason: "Missing file mutation evidence." };
  }
  if (!events.some((event) => event.type === "verification_result_recorded" && event.payload?.status === "passed")) {
    return { ok: false, reason: "Missing passed verification result." };
  }
  if (checkpoints.length < 1) return { ok: false, reason: "No checkpoint was created before mutation." };
  return { ok: true };
}

function hasTool(events, toolName) {
  return events.some((event) => event.type === "tool_result" && event.payload?.toolName === toolName && event.payload?.ok !== false);
}

function hasWorkspaceWriteCommandEvidence(task) {
  return (task.approvals ?? []).some((approval) =>
    approval.status === "approved" &&
    approval.riskCategory === "workspace_write" &&
    approval.toolCall?.toolName === "run_command" &&
    typeof approval.toolCall?.args?.command === "string"
  );
}

function summarizeEvidence(events) {
  return {
    eventCount: events.length,
    toolResults: events
      .filter((event) => event.type === "tool_result")
      .map((event) => ({
        toolName: event.payload?.toolName,
        ok: event.payload?.ok !== false,
        summary: String(event.summary ?? "").slice(0, 240)
      })),
    finalAssistant: [...events].reverse().find((event) => event.type === "assistant_message")?.summary?.slice(0, 1000) ?? ""
  };
}

async function collectDiagnostics(server, id) {
  if (!server || !id) return {};
  const task = await server.api("GET", `/api/tasks/${id}?eventLimit=1200`).catch((error) => ({ error: String(error) }));
  const events = Array.isArray(task.events) ? task.events : [];
  return {
    taskStatus: task.status,
    approvals: task.approvals,
    recentEvents: events.slice(-40).map((event) => ({
      type: event.type,
      summary: event.summary,
      payload: redactPayload(event.payload)
    }))
  };
}

function prepareFixture(projectRoot) {
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(resolve(projectRoot, "src"), { recursive: true });
  mkdirSync(resolve(projectRoot, "tests"), { recursive: true });
  writeFileSync(
    resolve(projectRoot, "package.json"),
    JSON.stringify({ name: "live-http-agent-fixture", type: "module", scripts: { test: "node tests/calculator.test.js" } }, null, 2),
    "utf8"
  );
  writeFileSync(resolve(projectRoot, "src", "calculator.js"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
  writeFileSync(
    resolve(projectRoot, "tests", "calculator.test.js"),
    [
      "import { strict as assert } from 'node:assert';",
      "import { add } from '../src/calculator.js';",
      "",
      "assert.equal(add(2, 3), 5);",
      "assert.equal(add(-2, 5), 3);",
      "console.log('calculator tests passed');",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function request(baseURL, method, path, body, token) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { "x-agent-workbench-session": token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${redactText(text)}`);
  }
  return payload;
}

function providerSummary() {
  return {
    hasApiKey: Boolean(process.env["AGENT_WORKBENCH_OPENAI_API_KEY"] || process.env["OPENAI_API_KEY"] || process.env["SCC_OPENAI_API_KEY"]),
    baseURL: process.env["AGENT_WORKBENCH_OPENAI_BASE_URL"] || process.env["OPENAI_BASE_URL"] || process.env["OPENAI_BASEURL"] || process.env["SCC_OPENAI_BASE_URL"] || "",
    model: process.env["AGENT_WORKBENCH_MODEL"] || process.env["SCC_MODEL"] || process.env["OPENAI_MODEL"] || "",
    source: process.env["AGENT_WORKBENCH_OPENAI_API_KEY"] ? "agent-env" : process.env["OPENAI_API_KEY"] ? "openai-env" : process.env["SCC_OPENAI_API_KEY"] ? "legacy-env" : "none"
  };
}

function writeReport(payload) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(redactPayload(payload), null, 2)}\n`, "utf8");
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const [key, value] of previous.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function redactPayload(value) {
  return JSON.parse(redactText(JSON.stringify(value ?? null)));
}

function redactText(value) {
  return String(value)
    .replace(/sk-[a-z0-9_-]{12,}/giu, "sk-[redacted]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["'])[^"',\s}]+/giu, "$1[redacted]");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
