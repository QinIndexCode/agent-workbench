import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const reportsDir = resolve(root, "docs", "reports");
const datePrefix = new Date().toISOString().slice(0, 10);
const reportPath = resolve(reportsDir, `${datePrefix}-flagship-revalidation.md`);
const requireVerdict = process.env.SCC_FLAGSHIP_REPORT_REQUIRED === "1";
const currentSourceFingerprint = sourceFingerprint(root);

const quality = readJson(resolve(root, "data", "test-reports", "flagship-quality", "quality-results.json"));
const budgets = readJson(resolve(root, "data", "test-reports", "web-budgets", "report.json"));
const liveSmoke = readJson(resolve(root, "data", "test-reports", "live-model-smoke", "report.json"));
const uiMetrics = readJson(resolve(root, "data", "test-reports", "flagship-ui", "metrics.json"));
const screenshotDir = resolve(root, "data", "test-reports", "flagship-ui", "screenshots");
const screenshots = existsSync(screenshotDir) ? readdirSync(screenshotDir).sort() : [];

const blockers = [];
if (!quality) blockers.push("Non-live quality suite results are missing.");
if (!budgets) blockers.push("Web budget report is missing.");
if (!liveSmoke) blockers.push("Live model smoke report is missing.");
if (!uiMetrics) blockers.push("Flagship UI metrics are missing.");

requireFreshArtifact(quality, "quality suite", blockers);
requireFreshArtifact(budgets, "web budgets", blockers);
requireFreshArtifact(liveSmoke, "live smoke", blockers);
requireFreshArtifact(uiMetrics, "flagship UI metrics", blockers);
requireMatchingSource(quality, "quality suite", currentSourceFingerprint, blockers);
requireMatchingSource(budgets, "web budgets", currentSourceFingerprint, blockers);
requireMatchingSource(liveSmoke, "live smoke", currentSourceFingerprint, blockers);

for (const item of quality?.results ?? []) {
  if (item.status !== "passed") blockers.push(`Quality gate ${item.name} is ${item.status}.`);
}

if (budgets?.pass === false) blockers.push("Web bundle budgets exceeded.");

const liveFailed = liveSmoke?.cases?.filter((item) => item.status !== "passed") ?? [];
const providerConfigurationFailed = liveFailed.some((item) => item.failureClass === "provider_configuration");
for (const item of liveFailed) blockers.push(`Live smoke failed: ${item.name}${item.failureClass ? ` (${item.failureClass})` : ""}.`);
if (liveSmoke && liveSmoke.required !== true) blockers.push("Live smoke report was generated without SCC_LIVE_MODEL_REQUIRED=1.");
if (Number(liveSmoke?.stressLevel ?? 0) < 5) blockers.push(`Live smoke stress level is ${liveSmoke?.stressLevel ?? "unknown"}; flagship validation requires level 5.`);
for (const item of liveSmoke?.cases ?? []) {
  const traceBytes = Number(item.evidence?.traceBytes ?? 0);
  const traceMaxEntryBytes = Number(item.evidence?.traceMaxEntryBytes ?? 0);
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

const overflowFailures = (uiMetrics?.views ?? []).filter((item) => Number(item.horizontalOverflow ?? 0) > 1);
for (const item of overflowFailures) blockers.push(`UI overflow exceeded budget on ${item.project}/${item.view}.`);

const verdict = blockers.length === 0 ? "旗舰水准达标" : "未达旗舰水准";

mkdirSync(reportsDir, { recursive: true });
writeFileSync(reportPath, renderMarkdown({
  datePrefix,
  verdict,
  blockers,
  quality,
  budgets,
  liveSmoke,
  uiMetrics,
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
        item.evidence?.contextCompactionObserved !== undefined ? `contextCompaction=${item.evidence.contextCompactionObserved}` : null
      ].filter(Boolean).join(" | ");
      lines.push(`- ${item.name}: ${item.status}${item.failureClass ? ` (${item.failureClass})` : ""}${metrics ? ` | ${metrics}` : ""}`);
    }
  } else {
    lines.push("- live smoke: missing");
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
  if (!generatedAt.startsWith(datePrefix)) {
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
