import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "flagship-quality");
const resultsPath = resolve(outDir, "quality-results.json");
const summaryPath = resolve(outDir, "summary.md");
const requireFlagshipReport = process.env["SCC_FLAGSHIP_REPORT_REQUIRED"] === "1";
const requireLiveSmoke = process.env["SCC_LIVE_MODEL_REQUIRED"] === "1" || requireFlagshipReport;

const steps = [
  { name: "lint", command: ["npm.cmd", "run", "lint"] },
  { name: "typecheck", command: ["npm.cmd", "run", "typecheck"] },
  { name: "unit", command: ["npm.cmd", "test"] },
  { name: "matrix", command: ["npm.cmd", "run", "test:matrix"] },
  { name: "stress", command: ["npm.cmd", "run", "test:stress"] },
  { name: "build", command: ["npm.cmd", "run", "build"] },
  { name: "web-budgets", command: ["npm.cmd", "run", "test:web-budgets"] },
  { name: "docs", command: ["npm.cmd", "run", "test:docs"] },
  { name: "e2e", command: ["npm.cmd", "run", "test:e2e"] },
  { name: "a11y", command: ["npm.cmd", "run", "test:a11y"] },
  { name: "no-old-control", command: ["npm.cmd", "run", "check:no-old-control"] }
];

mkdirSync(outDir, { recursive: true });

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
  const outcome = await runCommand(step.command, logPath);
  const result = {
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
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
    SCC_LIVE_MODEL_SMOKE: "1",
    SCC_LIVE_MODEL_REQUIRED: "1",
    SCC_STRESS_LEVEL: process.env["SCC_STRESS_LEVEL"] ?? "5"
  });
  results.push({
    name: step.name,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    command: step.command.join(" "),
    exitCode: outcome.exitCode,
    logPath
  });
  previousFailed = outcome.exitCode !== 0;
}

const payload = {
  generatedAt: new Date().toISOString(),
  cwd: root,
  sourceFingerprint: sourceFingerprint(root),
  results
};

writeFileSync(resultsPath, JSON.stringify(payload, null, 2), "utf8");
writeFileSync(summaryPath, renderSummary(payload), "utf8");

const liveSmokeFresh = hasFreshArtifact(resolve(root, "data", "test-reports", "live-model-smoke", "report.json"));
let reportStatus = "skipped";
if (liveSmokeFresh || requireFlagshipReport) {
  const outcome = await runCommand(["node", "scripts/write-flagship-report.mjs"], resolve(outDir, "report-write.log"), {
    SCC_FLAGSHIP_REPORT_REQUIRED: requireFlagshipReport ? "1" : process.env["SCC_FLAGSHIP_REPORT_REQUIRED"]
  });
  reportStatus = outcome.exitCode === 0 ? "written" : "failed";
  if (outcome.exitCode !== 0) {
    console.error("Flagship report generation failed. See data/test-reports/flagship-quality/report-write.log");
    process.exit(outcome.exitCode);
  }
}

const failed = results.find((item) => item.status === "failed");
if (failed) {
  console.error(`Non-live quality suite failed at ${failed.name}. See ${failed.logPath}`);
  process.exit(1);
}

if (reportStatus === "skipped") {
  console.log("Non-live quality suite passed. Skipped flagship report because no fresh live smoke artifact is available.");
} else {
  console.log("Non-live quality suite passed and flagship report was refreshed.");
}
console.log(`Results: ${resultsPath}`);

function runCommand(command, logPath, envOverrides = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const child = spawn(toCommandLine(command), {
      cwd: root,
      env: { ...process.env, ...envOverrides },
      shell: true,
      windowsHide: true
    });
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
      writeFileSync(logPath, output, "utf8");
      resolvePromise({ exitCode: exitCode ?? 1 });
    });
  });
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

function hasFreshArtifact(reportPath) {
  try {
    const payload = JSON.parse(readFileSync(reportPath, "utf8"));
    const generatedAt = String(payload.generatedAt ?? "");
    return generatedAt.startsWith(new Date().toISOString().slice(0, 10));
  } catch {
    return false;
  }
}
