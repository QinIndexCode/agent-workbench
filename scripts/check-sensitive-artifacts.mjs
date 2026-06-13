import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "sensitive-artifacts");
const reportPath = resolve(outDir, "report.json");
const maxTextScanBytes = 5 * 1024 * 1024;

const sqliteRoots = [
  resolve(root, "data"),
  resolve(root, "apps", "server", "data")
];

const artifactRoots = [
  resolve(root, "data", "tool-output"),
  resolve(root, "data", "attachments"),
  resolve(root, "data", "checkpoints"),
  resolve(root, "data", "logs"),
  resolve(root, "apps", "server", "data"),
  resolve(root, "data", "test-reports", "flagship-quality"),
  resolve(root, "data", "test-reports", "live-model-smoke"),
  resolve(root, "data", "test-reports", "live-agent-http-resume"),
  resolve(root, "docs", "reports", `${localDateStamp()}-flagship-revalidation.md`)
];

const tmpRoots = [
  resolve(root, "data"),
  resolve(root, "apps"),
  resolve(root, "packages"),
  resolve(root, "tests"),
  resolve(root, "scripts"),
  resolve(root, "docs")
];

const sourceTextFiles = unique([
  ...collectFiles(root, isRootReleaseTextFile),
  ...collectFiles(resolve(root, "docs"), isReleaseTextFile)
]);

const sqliteNeedles = [
  ["preference_field", Buffer.from("encryptStorage", "utf8")],
  ["provider_base_url", Buffer.from("providerBaseUrl", "utf8")],
  ["token_plan_model", Buffer.from("token-plan-cn", "utf8")],
  ["mimo_model", Buffer.from("mimo-v2.5", "utf8")],
  ["openai_env_key_name", Buffer.from("OPENAI_API_KEY", "utf8")],
  ["anthropic_env_key_name", Buffer.from("ANTHROPIC_API_KEY", "utf8")]
];

const sqliteTextPatterns = [
  ["openai_like_key", /\bsk-[A-Za-z0-9_\-*]{8,}/],
  ["bearer_token", /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i]
];

function localDateStamp(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const artifactPatterns = [
  ["env_api_key", /(?:OPENAI_API_KEY|AGENT_WORKBENCH_OPENAI_API_KEY|SCC_OPENAI_API_KEY|ANTHROPIC_API_KEY|MIMO_API_KEY|DEEPSEEK_API_KEY)\s*[:=]\s*[^\s"'`,;]+/i],
  ["bearer_token", /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ["openai_like_key", /\bsk-[A-Za-z0-9_\-*]{8,}/i],
  ["secret_key_file", /local-secret\.key/i]
];

mkdirSync(outDir, { recursive: true });

const sqliteFiles = unique(flatMap(sqliteRoots, (entry) => collectFiles(entry, isSqliteFamilyFile)));
const artifactFiles = unique(flatMap(artifactRoots, (entry) => collectFiles(entry, () => true)));
const tmpFiles = unique(flatMap(tmpRoots, (entry) => collectFiles(entry, (file) => /\.tmp$/i.test(basename(file)))));

const findings = [
  ...scanSqliteFiles(sqliteFiles),
  ...scanArtifactFiles(artifactFiles),
  ...scanSourceTextFiles(sourceTextFiles),
  ...tmpFiles.map((file) => ({ kind: "tmp_file", file: toRelative(file), pattern: "tmp_residue" }))
];

const report = {
  generatedAt: new Date().toISOString(),
  cwd: root,
  sourceFingerprint: sourceFingerprint(root),
  scanned: {
    sqliteFileCount: sqliteFiles.length,
    artifactFileCount: artifactFiles.length,
    sourceTextFileCount: sourceTextFiles.length,
    tmpFileCount: tmpFiles.length,
    artifactBytes: artifactFiles.reduce((total, file) => total + safeStat(file).size, 0)
  },
  findings
};

writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

if (findings.length > 0) {
  console.error(`Sensitive artifact gate failed with ${findings.length} finding(s). Report: ${reportPath}`);
  for (const finding of findings.slice(0, 20)) {
    console.error(`- ${finding.kind}: ${finding.file} (${finding.pattern})`);
  }
  process.exit(1);
}

console.log(`Sensitive artifact gate passed. SQLite files=${sqliteFiles.length}, artifacts=${artifactFiles.length}, tmp files=${tmpFiles.length}. Report: ${reportPath}`);

function scanSqliteFiles(files) {
  const output = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const [pattern, needle] of sqliteNeedles) {
      if (bytes.includes(needle)) output.push({ kind: "sqlite_plaintext", file: toRelative(file), pattern });
    }
    const text = bytes.toString("latin1");
    for (const [pattern, regex] of sqliteTextPatterns) {
      if (regex.test(text)) output.push({ kind: "sqlite_secret", file: toRelative(file), pattern });
    }
  }
  return output;
}

function scanArtifactFiles(files) {
  const output = [];
  for (const file of files) {
    const stat = safeStat(file);
    if (stat.size > maxTextScanBytes) continue;
    const text = readFileSync(file, "utf8");
    for (const [pattern, regex] of artifactPatterns) {
      if (regex.test(text)) output.push({ kind: "artifact_secret", file: toRelative(file), pattern });
    }
  }
  return output;
}

function scanSourceTextFiles(files) {
  const output = [];
  for (const file of files) {
    const stat = safeStat(file);
    if (stat.size > maxTextScanBytes) continue;
    const text = readFileSync(file, "utf8");
    for (const [pattern, regex] of artifactPatterns) {
      if (regex.test(text)) output.push({ kind: "source_text_secret", file: toRelative(file), pattern });
    }
  }
  return output;
}

function collectFiles(entry, predicate) {
  if (!existsSync(entry)) return [];
  const stat = safeStat(entry);
  if (stat.isDirectory()) {
    const files = [];
    for (const child of readdirSync(entry)) files.push(...collectFiles(join(entry, child), predicate));
    return files;
  }
  return predicate(entry) ? [entry] : [];
}

function isSqliteFamilyFile(file) {
  return /\.sqlite(?:-(?:wal|shm))?$/i.test(basename(file));
}

function isRootReleaseTextFile(file) {
  return dirname(resolve(file)) === root && isReleaseTextFile(file);
}

function isReleaseTextFile(file) {
  const name = basename(file);
  if (name === "package-lock.json") return false;
  if (name === "README.md") return true;
  return [".md", ".mdx", ".txt", ".json", ".yaml", ".yml"].includes(extname(name).toLowerCase());
}

function safeStat(file) {
  return statSync(file);
}

function flatMap(items, mapper) {
  return items.flatMap((item) => mapper(item));
}

function unique(items) {
  return [...new Set(items.map((item) => resolve(item)))].sort();
}

function toRelative(file) {
  return resolve(file).replace(`${root}\\`, "").replaceAll("\\", "/");
}
