import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-types",
  "docs(knowlage)",
  "coverage",
  "playwright-report",
  "test-results",
  "data"
]);
const forbidden = [
  ["quality", "Profile", "Id"],
  ["quality", "Gate", "Id"],
  ["scenario", "Pack"],
  ["scenario", "-", "pack"],
  ["restart", "Task"],
  ["task", "-", "action", "-", "restart"],
  ["tracker", " ", "JSON"]
].map((parts) => parts.join(""));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

const hits = [];
const generatedHits = [];
for await (const file of walk(root)) {
  if (/\\(apps|packages|tests)\\.*\.(js|d\.ts|d\.ts\.map)$/.test(file)) {
    generatedHits.push(file);
    continue;
  }
  const text = await readFile(file, "utf8").catch(() => "");
  for (const term of forbidden) {
    if (text.includes(term)) hits.push(`${file}: ${term}`);
  }
}

const fallbackText = await readFile(join(root, "packages/core/src/fallback-model.ts"), "utf8").catch(() => "");
for (const term of ["Get-Process", "tasklist", "running software", "进程", "性能占用"]) {
  if (fallbackText.includes(term)) hits.push(`fallback-model.ts contains task-specific fallback term: ${term}`);
}

if (hits.length > 0 || generatedHits.length > 0) {
  if (hits.length > 0) console.error(hits.join("\n"));
  if (generatedHits.length > 0) {
    console.error("Generated artifacts found in source/test tree:");
    console.error(generatedHits.join("\n"));
  }
  process.exit(1);
}

console.log("No legacy control-chain terms found in new source.");
