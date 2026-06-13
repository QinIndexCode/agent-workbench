import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const excludedPrefixes = [
  "node_modules/",
  "apps/web/dist/",
  "apps/web/dist-types/",
  "apps/server/dist/",
  "packages/core/dist/",
  "packages/shared/dist/",
  "data/test-reports/",
  "docs/reports/",
  "output/",
  "coverage/"
];

export function sourceFingerprint(root = process.cwd()) {
  const repoRoot = resolve(root);
  const head = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.trim() || "unknown";
  const statusRaw = runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--", "."]).stdout;
  const statusEntries = parseStatusEntries(statusRaw).filter((entry) => !isExcluded(entry.path));
  const diff = runGit(repoRoot, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
    ".",
    ...excludedPrefixes.map((prefix) => `:(exclude)${prefix}**`)
  ]).stdout;
  const untrackedFiles = splitNul(runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]).stdout)
    .filter((file) => file && !isExcluded(file))
    .sort();

  const hash = createHash("sha256");
  hash.update("source-fingerprint-v1\0");
  hash.update(`head:${head}\0`);
  hash.update("status\0");
  for (const entry of statusEntries) hash.update(`${entry.status} ${entry.path}\0`);
  hash.update("diff\0");
  hash.update(diff);
  hash.update("\0untracked\0");
  for (const file of untrackedFiles) {
    const fullPath = resolve(repoRoot, file);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
    hash.update(`file:${normalizePath(file)}\0`);
    hash.update(readFileSync(fullPath));
    hash.update("\0");
  }

  return {
    algorithm: "git-head-diff-untracked-v1",
    head,
    hash: hash.digest("hex"),
    dirty: statusEntries.length > 0 || untrackedFiles.length > 0,
    dirtyFileCount: statusEntries.length,
    untrackedFileCount: untrackedFiles.length,
    excludedPrefixes
  };
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status === 0) return { stdout: result.stdout ?? "" };
  return { stdout: "" };
}

function parseStatusEntries(raw) {
  const entries = [];
  const parts = splitNul(raw);
  for (let index = 0; index < parts.length; index++) {
    const record = parts[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      const renamedPath = parts[index + 1] ?? firstPath;
      index += 1;
      entries.push({ status, path: normalizePath(renamedPath) });
      continue;
    }
    entries.push({ status, path: normalizePath(firstPath) });
  }
  return entries;
}

function splitNul(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

function isExcluded(filePath) {
  const normalized = normalizePath(filePath);
  return excludedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function normalizePath(filePath) {
  const text = String(filePath ?? "").replaceAll("\\", "/");
  if (!text.match(/^(?:[a-z]:)?\//i)) return text;
  return relative(process.cwd(), resolve(filePath)).replaceAll("\\", "/");
}
