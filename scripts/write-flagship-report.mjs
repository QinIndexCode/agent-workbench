import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const reportsDir = resolve(root, "docs", "reports");
const datePrefix = localDateStamp();
const reportPath = resolve(reportsDir, `${datePrefix}-flagship-revalidation.md`);
const requireVerdict = (process.env.AGENT_WORKBENCH_FLAGSHIP_REPORT_REQUIRED ?? process.env.SCC_FLAGSHIP_REPORT_REQUIRED) === "1";
const currentSourceFingerprint = sourceFingerprint(root);
const minimumLiveSmokeStressLevel = 8;

const quality = readJson(resolve(root, "data", "test-reports", "flagship-quality", "quality-results.json"));
const budgets = readJson(resolve(root, "data", "test-reports", "web-budgets", "report.json"));
const apiRouteCoverage = readJson(resolve(root, "data", "test-reports", "api-route-coverage", "report.json"));
const sensitiveArtifacts = readJson(resolve(root, "data", "test-reports", "sensitive-artifacts", "report.json"));
const liveSmoke = readJson(resolve(root, "data", "test-reports", "live-model-smoke", "report.json"));
const liveHttpResume = readJson(resolve(root, "data", "test-reports", "live-agent-http-resume", "report.json"));
const uiMetrics = readJson(resolve(root, "data", "test-reports", "flagship-ui", "metrics.json"));
const routeSoakReports = {
  desktop: readJson(resolve(root, "data", "test-reports", "ui-route-soak", "desktop.json")),
  mobile: readJson(resolve(root, "data", "test-reports", "ui-route-soak", "mobile.json"))
};
const screenshotDir = resolve(root, "data", "test-reports", "flagship-ui", "screenshots");
const screenshots = existsSync(screenshotDir) ? readdirSync(screenshotDir).sort() : [];

const blockers = [];
if (!quality) blockers.push("Non-live quality suite results are missing.");
if (!budgets) blockers.push("Web budget report is missing.");
if (!apiRouteCoverage) blockers.push("API route coverage report is missing.");
if (!sensitiveArtifacts) blockers.push("Sensitive artifact report is missing.");
if (!liveSmoke) blockers.push("Live model smoke report is missing.");
if (!liveHttpResume) blockers.push("Live HTTP resume report is missing.");
if (!uiMetrics) blockers.push("Flagship UI metrics are missing.");
for (const project of ["desktop", "mobile"]) {
  if (!routeSoakReports[project]) blockers.push(`UI route soak report is missing for ${project}.`);
}

requireFreshArtifact(quality, "quality suite", blockers);
requireFreshArtifact(budgets, "web budgets", blockers);
requireFreshArtifact(apiRouteCoverage, "API route coverage", blockers);
requireFreshArtifact(sensitiveArtifacts, "sensitive artifacts", blockers);
requireFreshArtifact(liveSmoke, "live smoke", blockers);
requireFreshArtifact(liveHttpResume, "live HTTP resume", blockers);
requireFreshArtifact(uiMetrics, "flagship UI metrics", blockers);
for (const [project, report] of Object.entries(routeSoakReports)) {
  requireFreshArtifact(report, `UI route soak ${project}`, blockers);
}
requireMatchingSource(quality, "quality suite", currentSourceFingerprint, blockers);
requireMatchingSource(budgets, "web budgets", currentSourceFingerprint, blockers);
requireMatchingSource(apiRouteCoverage, "API route coverage", currentSourceFingerprint, blockers);
requireMatchingSource(sensitiveArtifacts, "sensitive artifacts", currentSourceFingerprint, blockers);
requireMatchingSource(liveSmoke, "live smoke", currentSourceFingerprint, blockers);
requireMatchingSource(liveHttpResume, "live HTTP resume", currentSourceFingerprint, blockers);
requireMatchingSource(uiMetrics, "flagship UI metrics", currentSourceFingerprint, blockers);
for (const [project, report] of Object.entries(routeSoakReports)) {
  requireMatchingSource(report, `UI route soak ${project}`, currentSourceFingerprint, blockers);
}

for (const item of quality?.results ?? []) {
  if (item.status !== "passed") blockers.push(`Quality gate ${item.name} is ${item.status}.`);
}

if (budgets?.pass === false) blockers.push("Web bundle budgets exceeded.");
if (apiRouteCoverage?.pass === false) blockers.push(`API route coverage has ${apiRouteCoverage.uncoveredCount ?? "unknown"} uncovered route(s).`);
if ((sensitiveArtifacts?.findings ?? []).length > 0) blockers.push(`Sensitive artifact scan found ${sensitiveArtifacts.findings.length} finding(s).`);

const liveFailed = liveSmoke?.cases?.filter((item) => item.status !== "passed") ?? [];
const providerConfigurationFailed = liveFailed.some((item) => item.failureClass === "provider_configuration");
for (const item of liveFailed) {
  const missingConfig = normalizeStringArray(item.evidence?.missingConfig);
  const missingDetails = missingConfig.length > 0 ? ` Missing config: ${missingConfig.join("; ")}.` : "";
  blockers.push(`Live smoke failed: ${item.name}${item.failureClass ? ` (${item.failureClass})` : ""}.${missingDetails}`);
}
if (liveSmoke && liveSmoke.required !== true) blockers.push("Live smoke report was generated without AGENT_WORKBENCH_LIVE_MODEL_REQUIRED=1.");
if (Number(liveSmoke?.stressLevel ?? 0) < minimumLiveSmokeStressLevel) blockers.push(`Live smoke stress level is ${liveSmoke?.stressLevel ?? "unknown"}; flagship validation requires level ${minimumLiveSmokeStressLevel}.`);
for (const item of liveSmoke?.cases ?? []) {
  const traceBytes = Number(item.evidence?.traceBytes ?? 0);
  const traceMaxEntryBytes = Number(item.evidence?.traceMaxEntryBytes ?? 0);
  if (typeof item.evidence?.tracePath === "string") {
    const traceLines = Number(item.evidence?.traceLines ?? 0);
    if (traceLines <= 0) blockers.push(`Live smoke trace is missing for ${item.name}.`);
    if (typeof item.evidence?.traceArtifactPath !== "string" || item.evidence.traceArtifactPath.length === 0) blockers.push(`Live smoke trace artifact is missing for ${item.name}.`);
  }
  if (traceBytes > 450_000) blockers.push(`Live smoke trace budget exceeded in ${item.name}: traceBytes=${traceBytes}.`);
  if (traceMaxEntryBytes > 20_000) blockers.push(`Live smoke trace entry budget exceeded in ${item.name}: traceMaxEntryBytes=${traceMaxEntryBytes}.`);
}
if (liveSmoke && !providerConfigurationFailed && !(liveSmoke.cases ?? []).some((item) => Number(item.evidence?.approvalCount ?? 0) > 0)) {
  blockers.push("Live smoke report is missing approval evidence.");
}
if (liveSmoke && !providerConfigurationFailed && !(liveSmoke.cases ?? []).some((item) => item.evidence?.rollbackUsed === true)) {
  blockers.push("Live smoke report is missing rollback evidence.");
}
if (liveSmoke && !providerConfigurationFailed && !(liveSmoke.cases ?? []).some((item) => item.evidence?.contextCompactionObserved === true)) {
  blockers.push("Live smoke report is missing context compaction evidence.");
}
if (liveHttpResume) {
  if (liveHttpResume.status !== "passed") blockers.push(`Live HTTP resume verifier is ${liveHttpResume.status}: ${liveHttpResume.reason ?? liveHttpResume.error ?? "no reason"}.`);
  if (Number(liveHttpResume.checkpoints ?? 0) < 1) blockers.push("Live HTTP resume report is missing checkpoint evidence.");
  if (Number(liveHttpResume.rollback?.restoredFiles ?? 0) < 1) blockers.push("Live HTTP resume report is missing rollback restoration evidence.");
  const toolNames = new Set((liveHttpResume.evidence?.toolResults ?? []).map((item) => String(item.toolName ?? "")));
  for (const toolName of ["run_command", "edit_file"]) {
    if (!toolNames.has(toolName)) blockers.push(`Live HTTP resume report is missing ${toolName} evidence.`);
  }
  if (!toolNames.has("read_file") && !toolNames.has("search_files")) blockers.push("Live HTTP resume report is missing file read/search evidence.");
}

const overflowFailures = (uiMetrics?.views ?? []).filter((item) => Number(item.horizontalOverflow ?? 0) > 1);
for (const item of overflowFailures) blockers.push(`UI overflow exceeded budget on ${item.project}/${item.view}.`);
for (const [project, report] of Object.entries(routeSoakReports)) {
  validateRouteSoak(report, project, blockers);
}

const verdict = blockers.length === 0 ? "旗舰水准达标" : "未达旗舰水准";

mkdirSync(reportsDir, { recursive: true });
writeFileSync(reportPath, renderMarkdown({
  datePrefix,
  verdict,
  blockers,
  quality,
  budgets,
  apiRouteCoverage,
  sensitiveArtifacts,
  liveSmoke,
  liveHttpResume,
  uiMetrics,
  routeSoakReports,
  screenshots,
  currentSourceFingerprint
}), "utf8");

console.log(`Flagship report written to ${reportPath}`);
if (requireVerdict && blockers.length > 0) {
  console.error(`Flagship report has ${blockers.length} blocker(s).`);
  process.exit(1);
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function localDateStamp(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderMarkdown(context) {
  const lines = [
    `# ${context.datePrefix} Flagship Revalidation`,
    "",
    `结论：${context.verdict}`,
    ""
  ];

  if (context.blockers.length > 0) {
    lines.push("## 阻断项", "");
    for (const blocker of context.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }

  lines.push("## 本轮门禁结果", "");
  lines.push(`- source fingerprint: ${context.currentSourceFingerprint.hash}`);
  if (context.quality?.results?.length) {
    for (const item of context.quality.results) {
      lines.push(`- ${item.name}: ${item.status}${item.logPath ? ` (${toRelative(item.logPath)})` : ""}`);
    }
  } else {
    lines.push("- quality: missing");
  }
  lines.push("");

  lines.push("## 前端预算", "");
  if (context.budgets) {
    lines.push(`- JS raw: ${formatKiB(context.budgets.totals.jsRaw)} / ${formatKiB(context.budgets.budgets.jsRaw)}`);
    lines.push(`- JS gzip: ${formatKiB(context.budgets.totals.jsGzip)} / ${formatKiB(context.budgets.budgets.jsGzip)}`);
    lines.push(`- CSS raw: ${formatKiB(context.budgets.totals.cssRaw)} / ${formatKiB(context.budgets.budgets.cssRaw)}`);
    lines.push(`- CSS gzip: ${formatKiB(context.budgets.totals.cssGzip)} / ${formatKiB(context.budgets.budgets.cssGzip)}`);
  } else {
    lines.push("- web budgets: missing");
  }
  lines.push("");

  lines.push("## API 路由覆盖", "");
  if (context.apiRouteCoverage) {
    lines.push(`- routes: ${context.apiRouteCoverage.routeCount}`);
    lines.push(`- uncovered: ${context.apiRouteCoverage.uncoveredCount}`);
    lines.push(`- no direct E2E hit: ${context.apiRouteCoverage.noE2eCount}`);
    if ((context.apiRouteCoverage.uncovered ?? []).length > 0) {
      for (const item of context.apiRouteCoverage.uncovered) lines.push(`- missing: ${item.method} ${item.path}`);
    }
  } else {
    lines.push("- api route coverage: missing");
  }
  lines.push("");

  lines.push("## 敏感产物扫描", "");
  if (context.sensitiveArtifacts) {
    lines.push(`- SQLite files: ${context.sensitiveArtifacts.scanned?.sqliteFileCount ?? "unknown"}`);
    lines.push(`- artifact files: ${context.sensitiveArtifacts.scanned?.artifactFileCount ?? "unknown"}`);
    lines.push(`- artifact bytes: ${context.sensitiveArtifacts.scanned?.artifactBytes ?? "unknown"}`);
    lines.push(`- tmp files: ${context.sensitiveArtifacts.scanned?.tmpFileCount ?? "unknown"}`);
    lines.push(`- findings: ${context.sensitiveArtifacts.findings?.length ?? "unknown"}`);
  } else {
    lines.push("- sensitive artifacts: missing");
  }
  lines.push("");

  lines.push("## Live Smoke", "");
  if (context.liveSmoke) {
    lines.push(`- stressLevel: ${context.liveSmoke.stressLevel}`);
    lines.push(`- cases: ${context.liveSmoke.cases.length}`);
    for (const item of context.liveSmoke.cases) {
      const metrics = [
        item.evidence?.latencyMs !== undefined ? `latency=${item.evidence.latencyMs}ms` : null,
        item.evidence?.eventCount !== undefined ? `events=${item.evidence.eventCount}` : null,
        item.evidence?.approvalCount !== undefined ? `approvals=${item.evidence.approvalCount}` : null,
        item.evidence?.traceBytes !== undefined ? `traceBytes=${item.evidence.traceBytes}` : null,
        item.evidence?.traceMaxEntryBytes !== undefined ? `traceMaxEntry=${item.evidence.traceMaxEntryBytes}` : null,
        item.evidence?.rollbackUsed !== undefined ? `rollback=${item.evidence.rollbackUsed}` : null,
        item.evidence?.contextCompactionObserved !== undefined ? `contextCompaction=${item.evidence.contextCompactionObserved}` : null,
        normalizeStringArray(item.evidence?.missingConfig).length > 0 ? `missingConfig=${normalizeStringArray(item.evidence?.missingConfig).join("; ")}` : null
      ].filter(Boolean).join(" | ");
      lines.push(`- ${item.name}: ${item.status}${item.failureClass ? ` (${item.failureClass})` : ""}${metrics ? ` | ${metrics}` : ""}`);
    }
  } else {
    lines.push("- live smoke: missing");
  }
  lines.push("");

  lines.push("## Live HTTP Resume", "");
  if (context.liveHttpResume) {
    lines.push(`- status: ${context.liveHttpResume.status}`);
    lines.push(`- taskId: ${context.liveHttpResume.taskId ?? "unknown"}`);
    lines.push(`- checkpoints: ${context.liveHttpResume.checkpoints ?? "unknown"}`);
    lines.push(`- rollback restored files: ${context.liveHttpResume.rollback?.restoredFiles ?? "unknown"}`);
    lines.push(`- event count: ${context.liveHttpResume.evidence?.eventCount ?? "unknown"}`);
    for (const item of context.liveHttpResume.evidence?.toolResults ?? []) {
      lines.push(`- ${item.toolName}: ${item.ok ? "ok" : "failed"}${item.summary ? ` | ${item.summary}` : ""}`);
    }
  } else {
    lines.push("- live HTTP resume: missing");
  }
  lines.push("");

  lines.push("## UI 截图与布局指标", "");
  if (context.uiMetrics?.views?.length) {
    for (const item of context.uiMetrics.views) {
      lines.push(`- ${item.project}/${item.view}: overflow=${item.horizontalOverflow}px, screenshot=${toRelative(item.screenshotPath)}`);
    }
  } else {
    lines.push("- flagship UI metrics: missing");
  }
  if (context.screenshots.length > 0) {
    lines.push("", "截图文件：", "");
    for (const file of context.screenshots) lines.push(`- ${toRelative(resolve(root, "data", "test-reports", "flagship-ui", "screenshots", file))}`);
  }
  lines.push("");

  lines.push("## 前端路由 Soak", "");
  for (const project of ["desktop", "mobile"]) {
    const report = context.routeSoakReports?.[project];
    if (!report) {
      lines.push(`- ${project}: missing`);
      continue;
    }
    const timings = Array.isArray(report.timings) ? report.timings : [];
    const maxElapsed = Math.max(0, ...timings.map((item) => Number(item.elapsedMs ?? 0)));
    const maxOverflow = Math.max(0, ...timings.map((item) => Number(item.overflow ?? 0)));
    const routeCount = new Set(timings.map((item) => item.path).filter(Boolean)).size;
    lines.push(`- ${project}: cycles=${report.cycles}, routes=${routeCount}, checks=${timings.length}, budget=${report.routeBudgetMs}ms, maxElapsed=${maxElapsed}ms, maxOverflow=${maxOverflow}px, consoleIssues=${report.consoleIssues?.length ?? "unknown"}, failures=${report.failures?.length ?? "unknown"}`);
  }
  lines.push("");

  lines.push("## 视觉证据边界", "");
  lines.push("- 本报告只自动汇总截图归档、横向溢出预算、E2E 与 a11y 结果；未把人工审美复核伪装成自动通过项。");
  lines.push("- 若需要人工视觉签核，应在同一日期追加独立复核记录，并说明审阅者、视口、浏览器和阻断结论。");
  lines.push("");

  lines.push("## 说明", "");
  lines.push("- 只有所有硬门禁通过、无阻断项、live smoke 与 UI 指标齐全时，才能判定为旗舰水准。");
  return lines.join("\n");
}

function formatKiB(bytes) {
  return `${(Number(bytes ?? 0) / 1024).toFixed(2)} KiB`;
}

function toRelative(filePath) {
  return filePath.replace(`${root}\\`, "").replaceAll("\\", "/");
}

function requireFreshArtifact(report, label, blockers) {
  if (!report) return;
  const generatedAt = String(report.generatedAt ?? "").trim();
  const generatedDate = Number.isNaN(Date.parse(generatedAt)) ? "" : localDateStamp(new Date(generatedAt));
  if (generatedDate !== datePrefix) {
    blockers.push(`${label} report is stale or from a different day: ${generatedAt || "missing generatedAt"}.`);
  }
}

function requireMatchingSource(report, label, currentFingerprint, blockers) {
  if (!report) return;
  const reportFingerprint = report.sourceFingerprint;
  if (!reportFingerprint?.hash) {
    blockers.push(`${label} report is missing a source fingerprint.`);
    return;
  }
  if (reportFingerprint.hash !== currentFingerprint.hash) {
    blockers.push(`${label} report was generated for a different source fingerprint: ${reportFingerprint.hash}.`);
  }
}

function validateRouteSoak(report, project, blockers) {
  if (!report) return;
  const expectedRoutes = [
    "/tasks/new",
    "/library/skills",
    "/library/knowledge",
    "/library/curator",
    "/settings/providers",
    "/settings/mcp",
    "/docs",
    "/history"
  ];
  const routeBudgetMs = Number(report.routeBudgetMs ?? 0);
  const cycles = Number(report.cycles ?? 0);
  const timings = Array.isArray(report.timings) ? report.timings : [];
  if (report.project !== project) blockers.push(`UI route soak ${project} has mismatched project field: ${report.project ?? "missing"}.`);
  if (cycles < 4) blockers.push(`UI route soak ${project} only ran ${cycles || "unknown"} cycle(s); flagship validation requires at least 4.`);
  if (!Number.isFinite(routeBudgetMs) || routeBudgetMs <= 0 || routeBudgetMs > 2_500) blockers.push(`UI route soak ${project} has invalid route budget: ${report.routeBudgetMs ?? "missing"}.`);
  if (timings.length < expectedRoutes.length * Math.max(cycles, 1)) blockers.push(`UI route soak ${project} has insufficient route checks: ${timings.length}.`);
  const routeSet = new Set(timings.map((item) => String(item.path ?? "")));
  for (const route of expectedRoutes) {
    if (!routeSet.has(route)) blockers.push(`UI route soak ${project} did not cover ${route}.`);
  }
  const consoleIssues = normalizeStringArray(report.consoleIssues);
  const failures = normalizeStringArray(report.failures);
  if (consoleIssues.length > 0) blockers.push(`UI route soak ${project} recorded ${consoleIssues.length} console issue(s).`);
  if (failures.length > 0) blockers.push(`UI route soak ${project} recorded ${failures.length} failure(s).`);
  for (const item of timings) {
    const label = `${project} ${item.label ?? item.path ?? "unknown route"} cycle ${item.cycle ?? "?"}`;
    if (Number(item.elapsedMs ?? 0) > routeBudgetMs) blockers.push(`UI route soak exceeded route budget on ${label}: ${item.elapsedMs}ms.`);
    if (Number(item.overflow ?? 0) > 1) blockers.push(`UI route soak overflow exceeded budget on ${label}: ${item.overflow}px.`);
    if (Number(item.textLength ?? 0) < 80) blockers.push(`UI route soak rendered suspiciously little text on ${label}.`);
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}
