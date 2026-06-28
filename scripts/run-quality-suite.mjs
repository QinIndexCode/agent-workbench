import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "release-quality");
const resultsPath = resolve(outDir, "quality-results.json");
const summaryPath = resolve(outDir, "summary.md");
const args = new Set(process.argv.slice(2));
const requireReleaseReport =
  args.has("--release") ||
  args.has("--flagship") ||
  (process.env["AGENT_WORKBENCH_RELEASE_REPORT_REQUIRED"] ?? process.env["AGENT_WORKBENCH_FLAGSHIP_REPORT_REQUIRED"] ?? process.env["SCC_FLAGSHIP_REPORT_REQUIRED"]) === "1";
const requireLiveSmoke = (process.env["AGENT_WORKBENCH_LIVE_MODEL_REQUIRED"] ?? process.env["SCC_LIVE_MODEL_REQUIRED"]) === "1" || requireReleaseReport;
const releaseLiveSmokeStressLevel = process.env["AGENT_WORKBENCH_STRESS_LEVEL"] ?? process.env["SCC_STRESS_LEVEL"] ?? "8";
const defaultStepTimeoutMs = 120_000;

const steps = [
  { name: "lint", command: ["npm.cmd", "run", "lint"], timeoutMs: 120_000 },
  { name: "typecheck", command: ["npm.cmd", "run", "typecheck"], timeoutMs: 120_000 },
  { name: "unit", command: ["npm.cmd", "test"], timeoutMs: 180_000 },
  { name: "matrix", command: ["npm.cmd", "run", "test:matrix"], timeoutMs: 120_000 },
  { name: "stress", command: ["npm.cmd", "run", "test:stress"], timeoutMs: 120_000 },
  { name: "build", command: ["npm.cmd", "run", "build"], timeoutMs: 180_000 },
  { name: "web-budgets", command: ["npm.cmd", "run", "test:web-budgets"], timeoutMs: 60_000 },
  { name: "api-route-coverage", command: ["npm.cmd", "run", "test:api-route-coverage"], timeoutMs: 60_000 },
  { name: "docs", command: ["npm.cmd", "run", "test:docs"], timeoutMs: 60_000 },
  { name: "agent-workflow", command: ["npm.cmd", "run", "test:agent-workflow"], timeoutMs: 60_000 },
  { name: "e2e", command: ["npm.cmd", "run", "test:e2e"], timeoutMs: 360_000 },
  { name: "a11y", command: ["npm.cmd", "run", "test:a11y"], timeoutMs: 360_000 },
  { name: "temp-hygiene", command: ["npm.cmd", "run", "test:temp-hygiene"], timeoutMs: 60_000 },
  { name: "sensitive-artifacts", command: ["npm.cmd", "run", "test:sensitive-artifacts"], timeoutMs: 120_000 },
  { name: "release-source", command: ["npm.cmd", "run", "check:release-source"], timeoutMs: 60_000 },
  { name: "no-old-control", command: ["npm.cmd", "run", "check:no-old-control"], timeoutMs: 60_000 }
];

mkdirSync(outDir, { recursive: true });
cleanupGeneratedDocsReports();

const results = [];
let previousFailed = false;
for (const step of steps) {
  const logPath = resolve(outDir, `${step.name}.log`);
  if (previousFailed) {
    results.push({
      name: step.name,
      status: "not_run",
      durationMs: 0,
      command: step.command.join(" "),
      logPath
    });
    continue;
  }
  const started = Date.now();
  const outcome = await runCommand(step.command, logPath, {}, step.timeoutMs);
  const result = {
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
    ...(outcome.timedOut ? { timedOut: true } : {}),
    logPath
  };
  results.push(result);
  previousFailed = outcome.exitCode !== 0;
}

if (!previousFailed && requireLiveSmoke) {
  const step = { name: "live-model-smoke", command: ["node", "scripts/live-model-smoke.mjs"] };
  const logPath = resolve(outDir, `${step.name}.log`);
  const started = Date.now();
  const outcome = await runCommand(step.command, logPath, {
    AGENT_WORKBENCH_LIVE_MODEL_SMOKE: "1",
    AGENT_WORKBENCH_LIVE_MODEL_REQUIRED: "1",
    AGENT_WORKBENCH_STRESS_LEVEL: releaseLiveSmokeStressLevel
  }, 1_200_000);
  results.push({
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
    ...(outcome.timedOut ? { timedOut: true } : {}),
    logPath
  });
  previousFailed = outcome.exitCode !== 0;
}

if (!previousFailed && requireLiveSmoke) {
  const step = { name: "live-agent-http-resume", command: ["node", "scripts/live-agent-http-resume-verifier.mjs"] };
  const logPath = resolve(outDir, `${step.name}.log`);
  const started = Date.now();
  const outcome = await runCommand(step.command, logPath, {
    AGENT_WORKBENCH_LIVE_HTTP_AGENT: "1",
    AGENT_WORKBENCH_LIVE_HTTP_AGENT_REQUIRED: "1",
    AGENT_WORKBENCH_LIVE_MODEL_REQUIRED: "1"
  }, 1_200_000);
  results.push({
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
    ...(outcome.timedOut ? { timedOut: true } : {}),
    logPath
  });
  previousFailed = outcome.exitCode !== 0;
}

if (!previousFailed && requireLiveSmoke) {
  const step = { name: "swe-bench-style-agent", command: ["node", "scripts/swe-bench-style-agent-eval.mjs"] };
  const logPath = resolve(outDir, `${step.name}.log`);
  const started = Date.now();
  const outcome = await runCommand(step.command, logPath, {
    AGENT_WORKBENCH_SWE_BENCH_STYLE: "1",
    AGENT_WORKBENCH_SWE_BENCH_STYLE_REQUIRED: "1",
    AGENT_WORKBENCH_LIVE_MODEL_REQUIRED: "1"
  }, 1_800_000);
  results.push({
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
    ...(outcome.timedOut ? { timedOut: true } : {}),
    logPath
  });
  previousFailed = outcome.exitCode !== 0;
}

const currentSourceFingerprint = sourceFingerprint(root);
const payload = {
  generatedAt: new Date().toISOString(),
  cwd: root,
  sourceFingerprint: currentSourceFingerprint,
  results
};

writeFileSync(resultsPath, JSON.stringify(payload, null, 2), "utf8");
writeFileSync(summaryPath, renderSummary(payload), "utf8");

const liveSmokeFresh = hasFreshArtifact(resolve(root, "data", "test-reports", "live-model-smoke", "report.json"), currentSourceFingerprint);
let reportStatus = "skipped";
if (liveSmokeFresh || requireReleaseReport) {
  const outcome = await runCommand(["node", "scripts/write-release-report.mjs"], resolve(outDir, "report-write.log"), {
    AGENT_WORKBENCH_RELEASE_REPORT_REQUIRED: requireReleaseReport ? "1" : process.env["AGENT_WORKBENCH_RELEASE_REPORT_REQUIRED"] ?? process.env["AGENT_WORKBENCH_FLAGSHIP_REPORT_REQUIRED"] ?? process.env["SCC_FLAGSHIP_REPORT_REQUIRED"]
  });
  reportStatus = outcome.exitCode === 0 ? "written" : "failed";
  if (outcome.exitCode !== 0) {
    console.error("Release report generation failed. See data/test-reports/release-quality/report-write.log");
    process.exit(outcome.exitCode);
  }
}

const failed = results.find((item) => item.status === "failed");
if (failed) {
  console.error(`Non-live quality suite failed at ${failed.name}. See ${failed.logPath}`);
  process.exit(1);
}

if (reportStatus === "skipped") {
  console.log("Non-live quality suite passed. Skipped release report because no fresh live smoke artifact is available.");
} else {
  console.log("Non-live quality suite passed and release report was refreshed.");
}
console.log(`Results: ${resultsPath}`);

function runCommand(command, logPath, envOverrides = {}, timeoutMs = defaultStepTimeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(toCommandLine(command), {
      cwd: root,
      env: { ...process.env, ...envOverrides },
      shell: true,
      windowsHide: true
    });
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(timeoutGrace);
      writeFileSync(logPath, output, "utf8");
      resolvePromise({ exitCode: timedOut ? 124 : exitCode ?? 1, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      output += `\nCommand timed out after ${timeoutMs}ms.\n`;
      killProcessTree(child.pid);
      timeoutGrace = setTimeout(() => {
        output += "Command process did not emit close after timeout cleanup.\n";
        settle(124);
      }, 10_000);
    }, timeoutMs);
    let timeoutGrace;
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (exitCode) => {
      settle(exitCode);
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  const command = process.platform === "win32" ? "taskkill" : "kill";
  const args = process.platform === "win32" ? ["/pid", String(pid), "/t", "/f"] : ["-TERM", String(pid)];
  try {
    spawn(command, args, { windowsHide: true });
  } catch {
    // The command result is already marked as timed out; cleanup is best effort.
  }
}

function toCommandLine(command) {
  return command
    .map((part) => {
      if (/[\s"]/u.test(part)) return `"${part.replaceAll('"', '\\"')}"`;
      return part;
    })
    .join(" ");
}

function renderSummary(payload) {
  return [
    "# Non-live Quality Suite",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    ...payload.results.map((item) => `- ${item.name}: ${item.status} (${item.durationMs}ms)`)
  ].join("\n");
}

function hasFreshArtifact(reportPath, expectedSourceFingerprint) {
  try {
    const payload = JSON.parse(readFileSync(reportPath, "utf8"));
    const generatedAt = String(payload.generatedAt ?? "");
    const hash = String(payload.sourceFingerprint?.hash ?? "");
    const generatedDate = Number.isNaN(Date.parse(generatedAt)) ? "" : localDateStamp(new Date(generatedAt));
    return generatedDate === localDateStamp(new Date()) && hash === expectedSourceFingerprint.hash;
  } catch {
    return false;
  }
}

function localDateStamp(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env["TZ"] || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function cleanupGeneratedDocsReports() {
  const reportsDir = resolve(root, "docs", "reports");
  if (!existsSync(reportsDir)) return;
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "README.md" || !entry.name.endsWith(".md")) continue;
    rmSync(resolve(reportsDir, entry.name), { force: true });
  }
}
