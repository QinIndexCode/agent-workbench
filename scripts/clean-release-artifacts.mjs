import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const generatedDirs = [
  "output",
  "playwright-report",
  "test-results",
  "coverage",
  "data/test-tmp"
];

const generatedReportDir = resolve(root, "docs", "reports");

let deletedFiles = 0;
let deletedBytes = 0;

for (const relativePath of generatedDirs) {
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

if (existsSync(generatedReportDir)) {
  for (const entry of readdirSync(generatedReportDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "README.md" || !entry.name.endsWith(".md")) continue;
    const filePath = resolve(generatedReportDir, entry.name);
    assertInsideRoot(filePath);
    const stats = statSync(filePath);
    deletedFiles += 1;
    deletedBytes += stats.size;
    rmSync(filePath, { force: true });
  }
} else {
  mkdirSync(generatedReportDir, { recursive: true });
}

console.log(JSON.stringify({ deletedFiles, deletedBytes, docsReportsKept: ["README.md"] }, null, 2));

function assertInsideRoot(absolutePath) {
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Refusing to clean outside workspace: ${absolutePath}`);
  }
}

function collectStats(dir) {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
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
