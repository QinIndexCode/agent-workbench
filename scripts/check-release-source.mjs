import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const root = resolve(process.cwd());

const failures = [
  ...checkDocsReports(),
  ...checkForbiddenFiles(),
  ...checkForbiddenText(),
  ...checkForbiddenSourcePaths(),
  ...checkPackageMetadata(),
  ...checkGitignore()
];

if (failures.length > 0) {
  console.error(`Release source check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Release source check passed.");

function checkDocsReports() {
  const dir = resolve(root, "docs", "reports");
  if (!existsSync(dir)) return ["docs/reports is missing; keep docs/reports/README.md as the generated-report boundary."];
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const unexpected = files.filter((name) => name !== "README.md");
  const failures = [];
  if (!files.includes("README.md")) failures.push("docs/reports/README.md is missing.");
  if (unexpected.length > 0) failures.push(`docs/reports contains generated source artifacts: ${unexpected.join(", ")}`);
  return failures;
}

function checkForbiddenFiles() {
  const forbiddenNames = [
    "dont_touch_(APIKEY).md",
    "apikey.md",
    "api_key.md",
    "secrets.md",
    ".env",
    ".env.local"
  ];
  return forbiddenNames
    .map((name) => resolve(root, name))
    .filter((file) => existsSync(file))
    .map((file) => `forbidden local secret/scratch file exists: ${toRelative(file)}`);
}

function checkForbiddenText() {
  const patterns = [
    ["old_repository_url", /QinIndexCode\/Scc-batch-Agent/i],
    ["openai_like_secret", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["token_plan_secret", /\btp-[A-Za-z0-9_-]{16,}/],
    ["literal_api_key_assignment", /\b(?:apiKey|tokenPlanApiKey)\s*:\s*(?:sk-|tp-)[A-Za-z0-9_-]+/i]
  ];
  const files = collectFiles(root, shouldScanTextFile);
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) failures.push(`${label} in ${toRelative(file)}`);
    }
  }
  return failures;
}

function checkForbiddenSourcePaths() {
  const patterns = [
    ["old_workspace_name", new RegExp(["Scc", "batch", "web"].join("_"), "i")],
    ["local_windows_workspace_path", /[A-Za-z]:[\\/](?:Users|MyCode)[\\/]/i]
  ];
  const files = collectFiles(root, shouldScanSourceTextFile);
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) failures.push(`${label} in ${toRelative(file)}`);
    }
  }
  return failures;
}

function checkPackageMetadata() {
  const failures = [];
  const rootPackage = readJson(resolve(root, "package.json"));
  if (rootPackage.private !== true) failures.push("root package.json must stay private until the license and distribution plan are selected.");
  if (rootPackage.license !== "MIT") failures.push("root package.json must declare the selected MIT license.");
  if (rootPackage.repository?.url !== "git+https://github.com/QinIndexCode/agent-workbench.git") failures.push("root package.json repository must point at QinIndexCode/agent-workbench.");
  if (rootPackage.bugs?.url !== "https://github.com/QinIndexCode/agent-workbench/issues") failures.push("root package.json bugs URL must point at QinIndexCode/agent-workbench.");
  if (rootPackage.homepage !== "https://github.com/QinIndexCode/agent-workbench#readme") failures.push("root package.json homepage must point at QinIndexCode/agent-workbench.");

  const packagePaths = [
    "apps/cli/package.json",
    "apps/server/package.json",
    "packages/core/package.json",
    "packages/shared/package.json"
  ];
  for (const packagePath of packagePaths) {
    const manifest = readJson(resolve(root, packagePath));
    if (manifest.private !== true) failures.push(`${packagePath} must stay private until npm publishing is intentional.`);
    if (manifest.license !== "MIT") failures.push(`${packagePath} must declare the selected MIT license.`);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length !== 1 || files[0] !== "dist") failures.push(`${packagePath} must publish only dist via files: ["dist"].`);
    if (manifest.publishConfig) failures.push(`${packagePath} has publishConfig before the distribution plan is selected.`);
  }
  return failures;
}

function checkGitignore() {
  const text = readFileSync(resolve(root, ".gitignore"), "utf8");
  const required = ["dont_touch_(APIKEY).md", "docs/reports/*.md", "!docs/reports/README.md", "data", "workspace"];
  return required.filter((entry) => !text.includes(entry)).map((entry) => `.gitignore is missing ${entry}`);
}

function collectFiles(entry, predicate) {
  if (!existsSync(entry)) return [];
  const stat = statSync(entry);
  if (stat.isDirectory()) {
    return readdirSync(entry).flatMap((child) => collectFiles(join(entry, child), predicate));
  }
  return predicate(entry) ? [entry] : [];
}

function shouldScanTextFile(file) {
  const relativePath = toRelative(file);
  if (isIgnoredScanPath(relativePath)) return false;
  const extension = extname(file).toLowerCase();
  if ([".md", ".mdx", ".txt", ".json", ".yaml", ".yml"].includes(extension)) return true;
  return basename(file) === ".gitignore";
}

function shouldScanSourceTextFile(file) {
  const relativePath = toRelative(file);
  if (isIgnoredScanPath(relativePath)) return false;
  const extension = extname(file).toLowerCase();
  return [".css", ".html", ".js", ".json", ".md", ".mdx", ".mjs", ".py", ".ts", ".tsx", ".txt", ".yaml", ".yml"].includes(extension);
}

function isIgnoredScanPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return [
    "node_modules/",
    "data/",
    "workspace/",
    "apps/web/dist/",
    "apps/server/dist/",
    "apps/cli/dist/",
    "packages/core/dist/",
    "packages/shared/dist/",
    "output/",
    "playwright-report/",
    "test-results/",
    "coverage/"
  ].some((prefix) => normalized.startsWith(prefix));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function toRelative(file) {
  return relative(root, resolve(file)).replaceAll("\\", "/");
}
