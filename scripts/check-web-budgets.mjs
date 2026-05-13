import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const distDir = resolve(root, "apps", "web", "dist");
const manifestPath = resolve(distDir, ".vite", "manifest.json");
const outDir = resolve(root, "data", "test-reports", "web-budgets");
const reportPath = resolve(outDir, "report.json");
const markdownPath = resolve(outDir, "report.md");
const budgets = {
  jsRaw: 190 * 1024,
  jsGzip: 65 * 1024,
  cssRaw: 80 * 1024,
  cssGzip: 15 * 1024
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entryRecord = Object.entries(manifest).find(([, value]) => value?.isEntry) ?? Object.entries(manifest).find(([key]) => key === "index.html");
if (!entryRecord) throw new Error(`Could not find Vite entry in ${manifestPath}.`);

const [entryKey, entryItem] = entryRecord;
const entryJsAssets = entryItem.file && entryItem.file.endsWith(".js") ? [fileMetrics(resolve(distDir, entryItem.file))] : [];
const entryCssAssets = [...new Set(entryItem.css ?? [])].map((file) => fileMetrics(resolve(distDir, file)));
const initialJsFiles = new Set();
const initialCssFiles = new Set();

collectInitialAssets(entryKey, manifest, initialJsFiles, initialCssFiles);

const initialJsAssets = [...initialJsFiles].map((file) => fileMetrics(resolve(distDir, file)));
const initialCssAssets = [...initialCssFiles].map((file) => fileMetrics(resolve(distDir, file)));
const jsRaw = sum(entryJsAssets, "rawBytes");
const jsGzip = sum(entryJsAssets, "gzipBytes");
const cssRaw = sum(entryCssAssets, "rawBytes");
const cssGzip = sum(entryCssAssets, "gzipBytes");

const report = {
  generatedAt: new Date().toISOString(),
  sourceFingerprint: sourceFingerprint(root),
  entry: entryKey,
  budgets,
  totals: {
    jsRaw,
    jsGzip,
    cssRaw,
    cssGzip,
    initialJsRaw: sum(initialJsAssets, "rawBytes"),
    initialJsGzip: sum(initialJsAssets, "gzipBytes"),
    initialCssRaw: sum(initialCssAssets, "rawBytes"),
    initialCssGzip: sum(initialCssAssets, "gzipBytes")
  },
  assets: {
    entryJs: entryJsAssets,
    entryCss: entryCssAssets,
    initialJs: initialJsAssets,
    initialCss: initialCssAssets
  },
  pass: jsRaw <= budgets.jsRaw && jsGzip <= budgets.jsGzip && cssRaw <= budgets.cssRaw && cssGzip <= budgets.cssGzip
};

mkdirSync(outDir, { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(markdownPath, renderMarkdown(report), "utf8");

if (!report.pass) {
  throw new Error(
    [
      "Web bundle budgets exceeded.",
      `JS raw ${formatKiB(jsRaw)} / budget ${formatKiB(budgets.jsRaw)}`,
      `JS gzip ${formatKiB(jsGzip)} / budget ${formatKiB(budgets.jsGzip)}`,
      `CSS raw ${formatKiB(cssRaw)} / budget ${formatKiB(budgets.cssRaw)}`,
      `CSS gzip ${formatKiB(cssGzip)} / budget ${formatKiB(budgets.cssGzip)}`
    ].join(" ")
  );
}

console.log(
  `Web bundle budgets passed. JS ${formatKiB(jsRaw)} raw / ${formatKiB(jsGzip)} gzip, CSS ${formatKiB(cssRaw)} raw / ${formatKiB(cssGzip)} gzip.`
);

function collectInitialAssets(key, manifestJson, jsSet, cssSet) {
  const item = manifestJson[key];
  if (!item) throw new Error(`Manifest entry "${key}" not found.`);
  if (item.file && item.file.endsWith(".js")) jsSet.add(item.file);
  for (const cssFile of item.css ?? []) cssSet.add(cssFile);
  for (const importKey of item.imports ?? []) collectInitialAssets(importKey, manifestJson, jsSet, cssSet);
}

function fileMetrics(filePath) {
  const raw = readFileSync(filePath);
  return {
    file: filePath.replace(`${distDir}\\`, "").replaceAll("\\", "/"),
    rawBytes: statSync(filePath).size,
    gzipBytes: gzipSync(raw).length
  };
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function renderMarkdown(report) {
  return [
    "# Web Bundle Budget Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Entry: ${report.entry}`,
    "",
    `- Entry JS raw: ${formatKiB(report.totals.jsRaw)} / ${formatKiB(report.budgets.jsRaw)}`,
    `- Entry JS gzip: ${formatKiB(report.totals.jsGzip)} / ${formatKiB(report.budgets.jsGzip)}`,
    `- Entry CSS raw: ${formatKiB(report.totals.cssRaw)} / ${formatKiB(report.budgets.cssRaw)}`,
    `- Entry CSS gzip: ${formatKiB(report.totals.cssGzip)} / ${formatKiB(report.budgets.cssGzip)}`,
    `- Initial JS graph: ${formatKiB(report.totals.initialJsRaw)} raw / ${formatKiB(report.totals.initialJsGzip)} gzip`,
    `- Initial CSS graph: ${formatKiB(report.totals.initialCssRaw)} raw / ${formatKiB(report.totals.initialCssGzip)} gzip`,
    "",
    "## Entry JS Assets",
    "",
    ...report.assets.entryJs.map((asset) => `- ${asset.file}: ${formatKiB(asset.rawBytes)} raw / ${formatKiB(asset.gzipBytes)} gzip`),
    "",
    "## Entry CSS Assets",
    "",
    ...report.assets.entryCss.map((asset) => `- ${asset.file}: ${formatKiB(asset.rawBytes)} raw / ${formatKiB(asset.gzipBytes)} gzip`),
    "",
    "## Initial JS Graph",
    "",
    ...report.assets.initialJs.map((asset) => `- ${asset.file}: ${formatKiB(asset.rawBytes)} raw / ${formatKiB(asset.gzipBytes)} gzip`)
  ].join("\n");
}
