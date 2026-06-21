import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "swe-bench-style");
const traceRoot = resolve(root, "data", "logs", "model-traces");
const requested = envFlag("AGENT_WORKBENCH_SWE_BENCH_STYLE", "SCC_SWE_BENCH_STYLE");
const required = envFlag("AGENT_WORKBENCH_SWE_BENCH_STYLE_REQUIRED", "SCC_SWE_BENCH_STYLE_REQUIRED");
const maxTransientCaseAttempts = Math.max(1, Number(process.env.AGENT_WORKBENCH_SWE_BENCH_STYLE_CASE_ATTEMPTS ?? "2") || 2);
const transientRetryBaseMs = Math.max(0, Number(process.env.AGENT_WORKBENCH_SWE_BENCH_STYLE_RETRY_BASE_MS ?? "15000") || 15_000);

class EvidenceError extends Error {
  constructor(message, evidencePayload) {
    super(message);
    this.evidence = evidencePayload;
  }
}

if (!requested) {
  const report = {
    generatedAt: new Date().toISOString(),
    sourceFingerprint: sourceFingerprint(root),
    required,
    status: required ? "failed" : "skipped",
    reason: "Set AGENT_WORKBENCH_SWE_BENCH_STYLE=1 to run the live SWE-bench-style agent evaluation.",
    cases: [],
    summary: { totalCases: 0, passedCases: 0, failedCases: required ? 1 : 0 }
  };
  await writeReport(report);
  const message = `${report.reason}${required ? " This run marked the evaluation as required." : ""}`;
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

process.env.AGENT_WORKBENCH_MODEL_TIMEOUT_MS ??= "180000";
process.env.AGENT_WORKBENCH_PROMPT_CACHE_MODE ??= "auto";

const {
  AgentWorkbench,
  ContextAssembler,
  createModelClientFromEnvironment,
  InMemoryWorkbenchStore,
  loadOpenAiConfig,
  LocalSecretBox,
  nowIso,
  ShellToolExecutor
} = await import("../packages/core/dist/index.js");
const { SqliteWorkbenchStore } = await import("../apps/server/dist/sqlite-store.js");

const environmentConfig = loadOpenAiConfig();
const storedProviderConfig = hasCompleteProviderConfig(environmentConfig) ? null : await loadStoredModelProviderConfig();
const config = hasCompleteProviderConfig(environmentConfig)
  ? { ...environmentConfig, source: "environment" }
  : storedProviderConfig ?? { ...environmentConfig, source: "environment" };

const report = {
  generatedAt: nowIso(),
  sourceFingerprint: sourceFingerprint(root),
  required,
  status: "running",
  provider: {
    baseURL: config.baseURL ? redactUrl(config.baseURL) : "missing",
    model: config.model ?? "mimo-v2.5",
    source: config.source ?? "environment",
    ...(config.providerId ? { providerId: config.providerId } : {}),
    ...(config.dbPath ? { dbPath: toRelative(config.dbPath) } : {}),
    hasApiKey: Boolean(config.apiKey),
    missing: [
      !config.apiKey ? "OPENAI_API_KEY, AGENT_WORKBENCH_OPENAI_API_KEY, SCC_OPENAI_API_KEY, AGENT_WORKBENCH_API_KEY_FILE, or SQLite model provider secret" : null,
      !config.baseURL ? "OPENAI_BASE_URL, AGENT_WORKBENCH_OPENAI_BASE_URL, or SQLite model provider baseUrl" : null
    ].filter(Boolean)
  },
  cases: []
};

if (!config.apiKey || !config.baseURL) {
  report.status = "failed";
  report.cases.push({
    name: "provider configuration",
    status: "failed",
    durationMs: 0,
    failureClass: "provider_configuration",
    error: "SWE-bench-style evaluation requires a configured OpenAI-compatible provider.",
    evidence: { missingConfig: report.provider.missing, sourceFingerprint: report.sourceFingerprint.hash }
  });
  refreshSummary(report);
  await writeReport(report);
  console.error("SWE-bench-style evaluation failed before model execution: provider configuration is incomplete.");
  process.exit(1);
}

const providerPreflight = await checkProviderPreflight(config);
if (!providerPreflight.ok) {
  report.status = "failed";
  report.cases.push({
    name: "provider preflight",
    status: "failed",
    durationMs: providerPreflight.durationMs,
    failureClass: providerPreflight.failureClass,
    error: providerPreflight.error,
    evidence: {
      provider: report.provider,
      statusCode: providerPreflight.statusCode,
      sourceFingerprint: report.sourceFingerprint.hash
    }
  });
  refreshSummary(report);
  await writeReport(report);
  console.error(`SWE-bench-style evaluation failed before case execution: ${providerPreflight.error}`);
  process.exit(1);
}

const cleanupTasks = [];
try {
  for (const spec of sweStyleCases()) {
    await runCase(spec);
  }
} finally {
  await cleanupResources();
}

refreshSummary(report);
report.status = report.summary.failedCases === 0 ? "passed" : "failed";
await writeReport(report);

const failed = report.cases.filter((item) => item.status !== "passed");
if (failed.length > 0) {
  console.error(`SWE-bench-style evaluation failed: ${failed.length}/${report.cases.length} case(s) failed. Report: ${toRelative(resolve(outDir, "report.json"))}`);
  process.exit(1);
}
console.log(`SWE-bench-style evaluation passed: ${report.summary.passedCases}/${report.summary.totalCases} cases. Report: ${toRelative(resolve(outDir, "report.json"))}`);

function sweStyleCases() {
  return [
    {
      name: "slug normalization regression",
      issue: [
        "Slug IDs generated from user-facing titles still contain punctuation and repeated separators.",
        "They should be lowercase ASCII-ish identifiers, collapse non-alphanumeric runs to one dash, and trim leading/trailing dashes.",
        "Make a minimal general fix. Do not special-case the visible assertions."
      ].join(" "),
      files: {
        "package.json": jsonPackage("swe-style-slug", "node tests/slug.test.mjs"),
        "src/slug.mjs": [
          "export function slugify(input) {",
          "  return String(input).toLowerCase().trim().replace(/\\s+/g, \"-\");",
          "}",
          ""
        ].join("\n"),
        "tests/slug.test.mjs": [
          "import assert from 'node:assert/strict';",
          "import { slugify } from '../src/slug.mjs';",
          "",
          "assert.equal(slugify('  Hello, Agent Workbench!  '), 'hello-agent-workbench');",
          "assert.equal(slugify('cache___hit   ratio'), 'cache-hit-ratio');",
          "assert.equal(slugify('Already--slugged'), 'already-slugged');",
          "console.log('slug tests passed');",
          ""
        ].join("\n")
      },
      hiddenCheck: [
        "import assert from 'node:assert/strict';",
        "import { slugify } from './src/slug.mjs';",
        "assert.equal(slugify('A/B/C'), 'a-b-c');",
        "assert.equal(slugify('version 2.0 beta'), 'version-2-0-beta');",
        "assert.equal(slugify('---trim---'), 'trim');",
        "console.log('slug hidden behavior passed');"
      ].join("\n")
    },
    {
      name: "async cache inflight regression",
      issue: [
        "The async memoization helper does not share in-flight work, so concurrent identical calls duplicate expensive provider requests.",
        "Successful results should remain memoized after they settle; rejected attempts should be evicted so a later retry can run again.",
        "It also must not poison the cache when the underlying function rejects.",
        "Reproduce the test failure, inspect the implementation, and make the smallest general fix."
      ].join(" "),
      files: {
        "package.json": jsonPackage("swe-style-cache", "node tests/cache.test.mjs"),
        "src/cache.mjs": [
          "export function memoizeAsync(fn) {",
          "  const cache = new Map();",
          "  return async (key) => {",
          "    if (cache.has(key)) return cache.get(key);",
          "    const value = await fn(key);",
          "    cache.set(key, value);",
          "    return value;",
          "  };",
          "}",
          ""
        ].join("\n"),
        "tests/cache.test.mjs": [
          "import assert from 'node:assert/strict';",
          "import { memoizeAsync } from '../src/cache.mjs';",
          "",
          "let calls = 0;",
          "const memoized = memoizeAsync(async (key) => {",
          "  calls += 1;",
          "  await new Promise((resolve) => setTimeout(resolve, 20));",
          "  return `${key}:${calls}`;",
          "});",
          "",
          "const [first, second] = await Promise.all([memoized('x'), memoized('x')]);",
          "assert.equal(first, second);",
          "assert.equal(calls, 1);",
          "",
          "let attempts = 0;",
          "const flaky = memoizeAsync(async () => {",
          "  attempts += 1;",
          "  if (attempts === 1) throw new Error('boom');",
          "  return 'ok';",
          "});",
          "await assert.rejects(() => flaky('retry'), /boom/);",
          "assert.equal(await flaky('retry'), 'ok');",
          "assert.equal(attempts, 2);",
          "console.log('cache tests passed');",
          ""
        ].join("\n")
      },
      hiddenCheck: [
        "import assert from 'node:assert/strict';",
        "import { memoizeAsync } from './src/cache.mjs';",
        "let calls = 0;",
        "const memoized = memoizeAsync(async (key) => { calls += 1; await Promise.resolve(); return `${key}:${calls}`; });",
        "const [a, b, c] = await Promise.all([memoized('a'), memoized('b'), memoized('a')]);",
        "assert.equal(a, c);",
        "assert.notEqual(a, b);",
        "assert.equal(calls, 2);",
        "assert.equal(await memoized('a'), a);",
        "assert.equal(calls, 2);",
        "console.log('cache hidden behavior passed');"
      ].join("\n")
    },
    {
      name: "nested option merge regression",
      issue: [
        "Partial option patches overwrite nested default objects instead of preserving sibling keys.",
        "Plain objects should merge recursively, arrays should be replaced, and inputs should not be mutated.",
        "Fix the general merge behavior and verify with the package test."
      ].join(" "),
      files: {
        "package.json": jsonPackage("swe-style-options", "node tests/options.test.mjs"),
        "src/options.mjs": [
          "export function mergeOptions(defaults, override = {}) {",
          "  return { ...defaults, ...override };",
          "}",
          ""
        ].join("\n"),
        "tests/options.test.mjs": [
          "import assert from 'node:assert/strict';",
          "import { mergeOptions } from '../src/options.mjs';",
          "",
          "const defaults = {",
          "  theme: { mode: 'light', contrast: 'normal' },",
          "  flags: { analytics: true, beta: false },",
          "  retries: 2,",
          "  tags: ['stable']",
          "};",
          "",
          "const merged = mergeOptions(defaults, { theme: { contrast: 'high' }, flags: { beta: true }, tags: ['edge'] });",
          "assert.deepEqual(merged, {",
          "  theme: { mode: 'light', contrast: 'high' },",
          "  flags: { analytics: true, beta: true },",
          "  retries: 2,",
          "  tags: ['edge']",
          "});",
          "assert.deepEqual(defaults.theme, { mode: 'light', contrast: 'normal' });",
          "assert.notEqual(merged.theme, defaults.theme);",
          "console.log('options tests passed');",
          ""
        ].join("\n")
      },
      hiddenCheck: [
        "import assert from 'node:assert/strict';",
        "import { mergeOptions } from './src/options.mjs';",
        "const defaults = { outer: { inner: { keep: 1, replace: 2 } }, list: ['a'], enabled: true };",
        "const merged = mergeOptions(defaults, { outer: { inner: { replace: 9 } }, list: ['b', 'c'] });",
        "assert.deepEqual(merged.outer.inner, { keep: 1, replace: 9 });",
        "assert.deepEqual(merged.list, ['b', 'c']);",
        "assert.equal(merged.enabled, true);",
        "assert.deepEqual(defaults.outer.inner, { keep: 1, replace: 2 });",
        "console.log('options hidden behavior passed');"
      ].join("\n")
    }
  ];
}

async function runCase(spec) {
  const started = Date.now();
  const attempts = maxTransientCaseAttempts;
  const failedAttempts = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStarted = Date.now();
    const fixture = createFixtureProject(spec);
    try {
      const baseline = runNpmTest(fixture.root);
      assertWithEvidence(!baseline.ok, `${spec.name} unexpectedly passed before agent repair`, {
        baseline
      });
      const snapshots = snapshotFiles(fixture.root);
      const { workbench, folderId } = await createLiveWorkbench(fixture.root);
      let task = await workbench.createTask(
        buildRepairGoal(spec),
        `SWE style: ${spec.name}`,
        folderId,
        [],
        {
          runMode: "target",
          targetLimits: {
            maxModelTurns: 80,
            maxToolCalls: 240,
            maxWallTimeMs: 900_000
          }
        }
      );
      task = await settleApprovals(workbench, task, repairApprovalDecision, 40);
      const postTest = runNpmTest(fixture.root);
      const hidden = runNodeHiddenCheck(fixture.root, spec.hiddenCheck);
      const changedFiles = changedFileList(fixture.root, snapshots);
      const caseEvidence = evidence(task, {
        attempt,
        fixtureRoot: fixture.root,
        baselineExitCode: baseline.exitCode,
        baselineOutput: excerpt(baseline.output, 2000),
        postTestExitCode: postTest.exitCode,
        postTestOutput: excerpt(postTest.output, 4000),
        hiddenExitCode: hidden.exitCode,
        hiddenOutput: excerpt(hidden.output, 2000),
        changedFiles,
        finalHashes: Object.fromEntries(changedFiles.map((file) => [file, fileHash(join(fixture.root, file))]))
      }).evidence;

      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, caseEvidence);
      assertWithEvidence(postTest.ok, "package test still fails after agent repair", caseEvidence);
      assertWithEvidence(hidden.ok, "hidden behavior check still fails after agent repair", caseEvidence);
      assertWithEvidence(changedFiles.some((file) => file.startsWith("src/")), "agent did not change source files", caseEvidence);
      assertWithEvidence(hasAnyTool(task, ["run_command"]), "agent did not run verification commands", caseEvidence);
      assertWithEvidence(hasAnyTool(task, ["read_file", "search_files", "list_files"]), "agent did not inspect project files", caseEvidence);
      assertWithEvidence(hasAnyTool(task, ["edit_file", "write_file"]), "agent did not use safe file editing tools", caseEvidence);
      assertWithEvidence(!caseEvidence.approvals.some((item) => item.decision === "deny"), "agent requested a denied out-of-scope action", caseEvidence);

      if (failedAttempts.length > 0) {
        caseEvidence.transientRetries = failedAttempts.map(summarizeFailedAttempt);
      }
      report.cases.push({
        name: spec.name,
        status: "passed",
        durationMs: Date.now() - started,
        evidence: caseEvidence
      });
      refreshSummary(report);
      await writeReport(report);
      console.log(`PASS ${spec.name}${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
      fixture.cleanup();
      return;
    } catch (error) {
      const evidencePayload = error instanceof EvidenceError ? error.evidence : {};
      const failureClass = classifyFailure(spec.name, error, evidencePayload);
      failedAttempts.push({
        attempt,
        durationMs: Date.now() - attemptStarted,
        failureClass,
        error: sanitizeError(error),
        evidence: evidencePayload
      });
      fixture.cleanup();
      if (attempt < attempts && isTransientProviderFailure(failureClass, error, evidencePayload)) {
        const delayMs = transientRetryBaseMs * attempt;
        console.warn(`RETRY ${spec.name} after transient ${failureClass} failure on attempt ${attempt}/${attempts}; waiting ${delayMs}ms.`);
        await sleep(delayMs);
        continue;
      }
      report.cases.push({
        name: spec.name,
        status: "failed",
        durationMs: Date.now() - started,
        failureClass,
        error: sanitizeError(error),
        evidence: {
          ...evidencePayload,
          transientRetries: failedAttempts.map(summarizeFailedAttempt)
        }
      });
      refreshSummary(report);
      await writeReport(report);
      console.error(`FAIL ${spec.name} [${failureClass}]: ${sanitizeError(error)}`);
      return;
    }
  }
}

function buildRepairGoal(spec) {
  return [
    "You are solving a SWE-bench-style issue in this isolated repository.",
    `Issue: ${spec.issue}`,
    "",
    "Required workflow:",
    "1. Reproduce the failure with npm.cmd test.",
    "2. Inspect relevant source and tests with workspace file tools.",
    "3. Patch the smallest general implementation bug. Do not hardcode behavior for the visible test strings.",
    "4. Check the broader issue contract, not only the visible assertions; add or reason through representative edge cases when the visible test is narrower than the issue.",
    "5. Rerun npm.cmd test after the latest edit.",
    "6. Final answer must include root cause, changed file(s), and verification command evidence.",
    "",
    "Use Windows-compatible commands when running shell commands."
  ].join("\n");
}

async function createLiveWorkbench(rootPath) {
  const store = new InMemoryWorkbenchStore();
  const preferences = await store.getPreferences();
  await store.savePreferences({
    ...preferences,
    activeModelProviderId: config.providerId,
    defaultModel: config.model ?? "mimo-v2.5",
    providerBaseUrl: config.baseURL ?? "",
    showThinking: false,
    responseDetail: "detailed",
    updatedAt: nowIso()
  });
  const contextAssembler = new ContextAssembler(store);
  const model = createModelClientFromEnvironment({
    contextAssembler,
    preferenceProvider: () => store.getPreferences(),
    providerResolver: hasCompleteProviderConfig(config)
      ? async () => ({
          ...(config.providerId ? { providerId: config.providerId } : {}),
          protocol: config.protocol ?? "openai_compatible",
          apiKey: config.apiKey,
          ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          model: config.model ?? "mimo-v2.5"
        })
      : undefined
  });
  const workbench = new AgentWorkbench({
    store,
    contextAssembler,
    model,
    tools: new ShellToolExecutor(),
    traceRoot
  });
  cleanupTasks.push(() => workbench.dispose());
  const folder = await workbench.createTaskFolder({ name: "SWE style fixture", rootPath });
  return { workbench, store, folderId: folder.id };
}

async function settleApprovals(workbench, task, decide, maxRounds = 8) {
  let current = task;
  for (let index = 0; index < maxRounds && current.status === "waiting_approval"; index += 1) {
    const approval = current.approvals.find((item) => item.status === "pending");
    if (!approval) break;
    current = await workbench.decideApproval(current.id, approval.id, decide(approval, current));
  }
  return current;
}

function repairApprovalDecision(approval) {
  const toolName = String(approval.toolCall?.toolName ?? "");
  const args = approval.toolCall?.args ?? {};
  const command = String(args.command ?? "");
  const text = `${toolName} ${command}`.toLowerCase();
  if (/\b(npm(?:\.cmd)?\s+(?:install|i|add|audit)|curl|wget|invoke-webrequest|irm|iwr|git\s+clone)\b/iu.test(text)) return "deny";
  if (/\b(?:remove-item|del|erase|rd|rmdir|rm)\b/iu.test(text)) return "deny";
  if (String(approval.riskCategory ?? "").toLowerCase().includes("network")) return "deny";
  return "allow_for_task";
}

function createFixtureProject(spec) {
  const fixtureRoot = resolve(mkdtempSync(join(tmpdir(), "aw-swe-style-")));
  for (const [file, content] of Object.entries(spec.files)) {
    writeFixture(fixtureRoot, file, content);
  }
  return {
    root: fixtureRoot,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true })
  };
}

function writeFixture(fixtureRoot, file, content) {
  const full = join(fixtureRoot, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function jsonPackage(name, testScript) {
  return `${JSON.stringify({ name, private: true, type: "module", scripts: { test: testScript } }, null, 2)}\n`;
}

function runNpmTest(cwd) {
  if (process.platform === "win32") return runFile("cmd.exe", ["/d", "/s", "/c", "npm.cmd test"], cwd, 90_000);
  return runFile("npm", ["test"], cwd, 90_000);
}

function runNodeHiddenCheck(cwd, code) {
  return runFile(process.execPath, ["--input-type=module", "-e", code], cwd, 60_000);
}

function runFile(command, args, cwd, timeoutMs) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, exitCode: 0, output: stdout };
  } catch (error) {
    return {
      ok: false,
      exitCode: typeof error.status === "number" ? error.status : 1,
      output: `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`.trim()
    };
  }
}

function snapshotFiles(fixtureRoot) {
  const output = new Map();
  for (const file of collectFiles(fixtureRoot)) {
    output.set(toFixtureRelative(fixtureRoot, file), readFileSync(file, "utf8"));
  }
  return output;
}

function changedFileList(fixtureRoot, snapshots) {
  const current = snapshotFiles(fixtureRoot);
  const names = new Set([...snapshots.keys(), ...current.keys()]);
  return [...names]
    .filter((name) => snapshots.get(name) !== current.get(name))
    .sort((left, right) => left.localeCompare(right));
}

function collectFiles(entry) {
  if (!existsSync(entry)) return [];
  if (statSync(entry).isDirectory()) {
    return readdirSync(entry, { withFileTypes: true }).flatMap((child) => {
      if (child.name === "node_modules") return [];
      return collectFiles(join(entry, child.name));
    });
  }
  return [entry];
}

function toFixtureRelative(fixtureRoot, file) {
  return relative(fixtureRoot, file).replaceAll("\\", "/");
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

function evidence(task, extra = {}) {
  const toolRequests = task.events.filter((event) => event.type === "tool_requested").map((event) => ({
    toolName: event.payload?.toolName,
    riskCategory: event.payload?.riskCategory,
    argsPreview: event.payload?.argsPreview
  }));
  const metrics = taskMetrics(task);
  return {
    status: "passed",
    evidence: {
      taskId: task.id,
      status: task.status,
      workRoot: task.workRoot,
      ...metrics,
      assistant: excerpt(assistantText(task), 8000),
      ...extra,
      eventCounts: eventCounts(task),
      approvals: approvalSummary(task),
      toolRequestCount: toolRequests.length,
      toolRequests: toolRequests.slice(0, 24),
      omittedToolRequests: Math.max(0, toolRequests.length - 24)
    }
  };
}

function hasAnyTool(task, names) {
  const allowed = new Set(names);
  return task.events.some((event) => event.type === "tool_requested" && allowed.has(String(event.payload?.toolName ?? "")));
}

function assistantText(task) {
  return [...task.events].reverse().find((event) => event.type === "assistant_message")?.summary ?? "";
}

function approvalSummary(task) {
  return task.events
    .filter((event) => event.type === "approval_pending" || event.type === "approval_resolved" || event.type === "approval_auto_granted")
    .map((event) => ({
      type: event.type,
      summary: event.summary,
      riskCategory: event.payload?.riskCategory,
      decision: event.payload?.decision
    }));
}

function eventCounts(task) {
  const counts = {};
  for (const event of task.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function taskMetrics(task) {
  const trace = readTraceMetrics(task);
  const createdAt = Date.parse(task.createdAt ?? "");
  const updatedAt = Date.parse(task.updatedAt ?? "");
  return {
    latencyMs: Number.isFinite(createdAt) && Number.isFinite(updatedAt) ? Math.max(0, updatedAt - createdAt) : undefined,
    eventCount: task.events.length,
    approvalCount: task.events.filter((event) => event.type === "approval_pending" || event.type === "approval_resolved" || event.type === "approval_auto_granted").length,
    rollbackUsed: task.events.some((event) => event.type === "task_rollback_completed" || event.type === "task_rollback_failed"),
    contextCompactionObserved: task.events.some((event) => event.type === "conversation_summary_created" || event.type === "context_overflow_recovered"),
    ...trace
  };
}

function readTraceMetrics(task) {
  const tracePath = resolve(traceRoot, task.id, "trace.jsonl");
  if (!existsSync(tracePath)) return { tracePath, traceArtifactPath: null, traceLines: 0, traceBytes: 0, traceMaxEntryBytes: 0 };
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const artifactDir = resolve(outDir, "traces");
  mkdirSync(artifactDir, { recursive: true });
  const traceArtifactPath = resolve(artifactDir, `${task.id}.jsonl`);
  writeFileSync(traceArtifactPath, raw, "utf8");
  const promptCache = summarizePromptCacheFromTrace(lines);
  return {
    tracePath,
    traceArtifactPath,
    traceLines: lines.length,
    traceBytes: Buffer.byteLength(raw, "utf8"),
    traceMaxEntryBytes: lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line, "utf8")), 0),
    ...(promptCache.turns > 0 ? { promptCache } : {})
  };
}

function summarizePromptCacheFromTrace(lines) {
  const rows = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.kind !== "model_turn_completed") continue;
      const usage = entry?.usage;
      const inputTokens = Number(usage?.inputTokens ?? 0);
      const cachedTokens = Number(usage?.cachedTokens ?? 0);
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) continue;
      if (!Number.isFinite(cachedTokens) || cachedTokens < 0) continue;
      rows.push({
        inputTokens,
        cachedTokens,
        cacheHitRatio: cachedTokens / inputTokens,
        source: usage?.cacheSource === "local_response" ? "local_response" : "provider"
      });
    } catch {
      // Ignore concurrently incomplete trace rows.
    }
  }
  const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0);
  const cachedTokens = rows.reduce((total, row) => total + row.cachedTokens, 0);
  const ratios = rows.map((row) => row.cacheHitRatio);
  return {
    turns: rows.length,
    inputTokens,
    cachedTokens,
    cacheHitRatio: cachedTokens / Math.max(1, inputTokens),
    targetHitRatio: 0.9,
    targetMet: cachedTokens / Math.max(1, inputTokens) >= 0.9,
    providerTurns: rows.filter((row) => row.source === "provider").length,
    localResponseTurns: rows.filter((row) => row.source === "local_response").length,
    ...(ratios.length > 0 ? { minCacheHitRatio: Math.min(...ratios), maxCacheHitRatio: Math.max(...ratios) } : {})
  };
}

function refreshSummary(data) {
  const failed = data.cases.filter((item) => item.status !== "passed");
  const promptCache = aggregatePromptCache(data.cases);
  data.summary = {
    totalCases: data.cases.length,
    passedCases: data.cases.filter((item) => item.status === "passed").length,
    failedCases: failed.length,
    ...(promptCache.turns > 0 ? { promptCache } : {})
  };
  return data;
}

function aggregatePromptCache(cases) {
  const totals = {
    turns: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheHitRatio: 0,
    targetHitRatio: 0.9,
    targetMet: false,
    providerTurns: 0,
    localResponseTurns: 0,
    minCacheHitRatio: null,
    maxCacheHitRatio: null
  };
  for (const item of cases) {
    const cache = item.evidence?.promptCache;
    if (!cache || !Number.isFinite(Number(cache.turns))) continue;
    totals.turns += Number(cache.turns);
    totals.inputTokens += Number(cache.inputTokens ?? 0);
    totals.cachedTokens += Number(cache.cachedTokens ?? 0);
    totals.providerTurns += Number(cache.providerTurns ?? cache.turns);
    totals.localResponseTurns += Number(cache.localResponseTurns ?? 0);
    const minRatio = Number(cache.minCacheHitRatio);
    const maxRatio = Number(cache.maxCacheHitRatio);
    if (Number.isFinite(minRatio)) totals.minCacheHitRatio = totals.minCacheHitRatio === null ? minRatio : Math.min(totals.minCacheHitRatio, minRatio);
    if (Number.isFinite(maxRatio)) totals.maxCacheHitRatio = totals.maxCacheHitRatio === null ? maxRatio : Math.max(totals.maxCacheHitRatio, maxRatio);
  }
  totals.cacheHitRatio = totals.cachedTokens / Math.max(1, totals.inputTokens);
  totals.targetMet = totals.cacheHitRatio >= totals.targetHitRatio;
  return totals;
}

async function writeReport(data) {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "report.json"), JSON.stringify(data, null, 2), "utf8");
  await writeFile(resolve(outDir, "report.md"), markdownReport(data), "utf8");
}

function markdownReport(data) {
  const cache = data.summary?.promptCache;
  const lines = [
    "# SWE-bench-style Agent Evaluation",
    "",
    `Generated: ${data.generatedAt}`,
    `Required gate: ${data.required ? "yes" : "no"}`,
    `Status: ${data.status}`,
    `Summary: ${data.summary?.passedCases ?? 0}/${data.summary?.totalCases ?? data.cases.length} passed`,
    cache
      ? `Effective input cache: ${Math.round(cache.cacheHitRatio * 100)}% (${cache.cachedTokens}/${cache.inputTokens} cached input tokens, ${cache.turns} turns, provider ${cache.providerTurns}, local ${cache.localResponseTurns}, target ${Math.round(cache.targetHitRatio * 100)}%, ${cache.targetMet ? "met" : "below target"})`
      : "Prompt cache: unavailable",
    data.provider ? `Provider: ${data.provider.baseURL}` : "",
    data.provider ? `Model: ${data.provider.model}` : "",
    "",
    "This is a local live-agent SWE-bench-style gate, not an official SWE-bench leaderboard submission. Each case uses an isolated repository, starts from failing tests, requires the agent to patch source through product tools, and verifies with external package tests plus hidden behavior checks.",
    ""
  ].filter((line) => line !== "");
  if (data.reason) lines.push(`Reason: ${data.reason}`, "");
  for (const item of data.cases) {
    lines.push(`## ${item.status === "passed" ? "PASS" : "FAIL"} ${item.name}`, "");
    lines.push(`Duration: ${item.durationMs}ms`);
    if (item.failureClass) lines.push(`Failure class: ${item.failureClass}`);
    if (item.error) lines.push(`Error: ${item.error}`);
    const metrics = [
      item.evidence?.latencyMs !== undefined ? `latency=${item.evidence.latencyMs}ms` : null,
      item.evidence?.eventCount !== undefined ? `events=${item.evidence.eventCount}` : null,
      item.evidence?.approvalCount !== undefined ? `approvals=${item.evidence.approvalCount}` : null,
      item.evidence?.traceLines !== undefined ? `traceLines=${item.evidence.traceLines}` : null,
      item.evidence?.traceBytes !== undefined ? `traceBytes=${item.evidence.traceBytes}` : null,
      item.evidence?.promptCache ? `cache=${Math.round(item.evidence.promptCache.cacheHitRatio * 100)}%` : null
    ].filter(Boolean);
    if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(" | ")}`);
    if (Array.isArray(item.evidence?.changedFiles)) lines.push(`Changed files: ${item.evidence.changedFiles.join(", ") || "none"}`);
    if (item.evidence?.assistant) {
      lines.push("", "Assistant summary:", "", `> ${String(item.evidence.assistant).replace(/\n+/g, "\n> ")}`);
    }
    if (item.evidence) {
      lines.push("", "```json", JSON.stringify(item.evidence, null, 2), "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function loadStoredModelProviderConfig() {
  for (const dbPath of candidateWorkbenchDbPaths()) {
    if (!existsSync(dbPath)) continue;
    const store = new SqliteWorkbenchStore(dbPath);
    try {
      const preferences = await store.getPreferences();
      const providers = (await store.listModelProviders()).filter((provider) => provider.enabled !== false);
      const preferredIds = [
        preferences.activeModelProviderId,
        ...providers.map((provider) => provider.id)
      ].filter((id, index, all) => typeof id === "string" && id.length > 0 && all.indexOf(id) === index);
      for (const providerId of preferredIds) {
        const provider = providers.find((item) => item.id === providerId);
        if (!provider?.apiKeyRef) continue;
        const secret = await store.getModelProviderSecret(provider.id);
        if (!secret) continue;
        const apiKey = new LocalSecretBox(join(dirname(dbPath), "local-secret.key")).decrypt(secret);
        if (!apiKey || !provider.baseUrl) continue;
        return {
          providerId: provider.id,
          protocol: provider.protocol ?? "openai_compatible",
          apiKey,
          baseURL: provider.baseUrl,
          model: provider.defaultModelId ?? preferences.defaultModel ?? "mimo-v2.5",
          source: "sqlite",
          dbPath
        };
      }
    } catch (error) {
      console.warn(`Skipping stored provider config from ${toRelative(dbPath)}: ${sanitizeError(error)}`);
    } finally {
      store.close();
    }
  }
  return null;
}

async function checkProviderPreflight(providerConfig) {
  const started = Date.now();
  try {
    const response = await fetch(providerEndpoint(providerConfig.baseURL, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: providerConfig.model ?? "mimo-v2.5",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (response.ok) return { ok: true, durationMs: Date.now() - started, statusCode: response.status };
    const body = await response.text();
    return {
      ok: false,
      durationMs: Date.now() - started,
      statusCode: response.status,
      failureClass: classifyProviderStatus(response.status, body),
      error: providerPreflightError(response.status, body)
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      failureClass: "provider_transient",
      error: `Provider preflight request failed: ${sanitizeError(error)}`
    };
  }
}

function providerEndpoint(baseURL, route) {
  return `${String(baseURL ?? "").replace(/\/+$/, "")}/${route}`;
}

function classifyProviderStatus(status, body) {
  const text = String(body ?? "").toLowerCase();
  if (status === 429 || /rate.?limit|too many requests/u.test(text)) return "rate_limit";
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden/u.test(text)) return "provider_configuration";
  if (status >= 500) return "provider_transient";
  return "provider_configuration";
}

function providerPreflightError(status, body) {
  const text = sanitizeError(String(body ?? "")).replace(/\s+/g, " ").trim();
  return `Provider preflight failed with HTTP ${status}${text ? `: ${text.slice(0, 500)}` : ""}`;
}

function candidateWorkbenchDbPaths() {
  const configured = process.env.AGENT_WORKBENCH_DB_PATH ?? process.env.SCC_DB_PATH;
  return [
    configured ? resolve(configured) : null,
    resolve(root, "data", "workbench.sqlite"),
    resolve(root, "apps", "server", "data", "workbench.sqlite")
  ].filter((value, index, all) => value && all.indexOf(value) === index);
}

async function cleanupResources() {
  const failures = [];
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(sanitizeError(error));
    }
  }
  if (failures.length > 0) console.warn(`SWE-bench-style cleanup completed with ${failures.length} warning(s): ${failures.slice(0, 3).join(" | ")}`);
}

function envFlag(primary, legacy) {
  return (process.env[primary] ?? process.env[legacy]) === "1";
}

function hasCompleteProviderConfig(value) {
  return Boolean(value?.apiKey && value?.baseURL);
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "[configured]";
  }
}

function toRelative(filePath) {
  return resolve(filePath).replace(`${root}\\`, "").replaceAll("\\", "/");
}

function excerpt(value, max = 10000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function assertWithEvidence(condition, message, evidencePayload) {
  if (!condition) throw new EvidenceError(message, evidencePayload);
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\btp-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]");
}

function classifyFailure(name, error, evidencePayload) {
  const message = `${name} ${sanitizeError(error)}`.toLowerCase();
  const evidenceText = `${evidencePayload?.assistant ?? ""} ${evidencePayload?.error ?? ""} ${evidencePayload?.postTestOutput ?? ""}`.toLowerCase();
  if (/429|too many requests|rate.?limit/u.test(`${message} ${evidenceText}`)) return "rate_limit";
  if (/timeout|timed out|econnreset|etimedout|provider unavailable|model provider failed/u.test(`${message} ${evidenceText}`)) return "provider_transient";
  if (message.includes("approval") || message.includes("deny") || message.includes("riskcategory") || message.includes("waiting approval")) return "permission_approval";
  if (message.includes("hidden behavior") || message.includes("package test") || message.includes("source files")) return "repair_quality";
  if (message.includes("run_command") || message.includes("read_file") || message.includes("edit_file") || message.includes("write_file")) return "tooling_or_workspace";
  return "runtime_or_unknown";
}

function isTransientProviderFailure(failureClass, error, evidencePayload) {
  if (failureClass === "rate_limit" || failureClass === "provider_transient") return true;
  const text = `${sanitizeError(error)} ${evidencePayload?.assistant ?? ""} ${evidencePayload?.error ?? ""}`;
  return /429|too many requests|rate.?limit|timeout|timed out|econnreset|etimedout/i.test(text);
}

function summarizeFailedAttempt(item) {
  return {
    attempt: item.attempt,
    durationMs: item.durationMs,
    failureClass: item.failureClass,
    error: item.error,
    ...(item.evidence?.taskId ? { taskId: item.evidence.taskId } : {}),
    ...(item.evidence?.status ? { status: item.evidence.status } : {}),
    ...(item.evidence?.assistant ? { assistant: excerpt(item.evidence.assistant, 500) } : {})
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
