import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keepReports = process.argv.includes("--keep-reports");

const artifactDirs = [
  "data/logs/model-traces",
  "data/tool-output",
  "data/checkpoints",
  "data/attachments",
  "workspace/default/data/logs/model-traces",
  "workspace/default/data/tool-output",
  "workspace/default/data/checkpoints",
  "workspace/default/data/attachments",
  "data/test-reports/live-model-smoke/traces",
  "data/test-tmp"
];

const reportFiles = [
  "data/test-reports/live-model-smoke/report.json",
  "data/test-reports/live-model-smoke/report.md",
  "data/test-reports/flagship-quality/quality-results.json"
];

let deletedFiles = 0;
let deletedBytes = 0;

for (const relativePath of artifactDirs) {
  const absolutePath = resolve(root, relativePath);
  assertInsideRoot(absolutePath);
  if (existsSync(absolutePath)) {
    const stats = collectStats(absolutePath);
    deletedFiles += stats.files;
    deletedBytes += stats.bytes;
    rmSync(absolutePath, { recursive: true, force: true });
  }
  mkdirSync(absolutePath, { recursive: true });
}

if (!keepReports) {
  for (const relativePath of reportFiles) {
    const absolutePath = resolve(root, relativePath);
    assertInsideRoot(absolutePath);
    if (!existsSync(absolutePath)) continue;
    const stats = statSync(absolutePath);
    deletedFiles += 1;
    deletedBytes += stats.size;
    rmSync(absolutePath, { force: true });
  }
}

console.log(JSON.stringify({ deletedFiles, deletedBytes, reportsRemoved: !keepReports }, null, 2));

function assertInsideRoot(absolutePath) {
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Refusing to clean outside workspace: ${absolutePath}`);
  }
}

function collectStats(dir) {
  let files = 0;
  let bytes = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const child = collectStats(path);
      files += child.files;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      const stats = statSync(path);
      files += 1;
      bytes += stats.size;
    }
  }
  return { files, bytes };
}
