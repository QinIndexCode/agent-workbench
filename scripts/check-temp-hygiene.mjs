import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const scanRoots = ["apps", "packages", "scripts", "tests"].map((entry) => resolve(root, entry));
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const forbiddenPatterns = [
  {
    pattern: /\bmkdtemp(?:Sync)?\s*\(\s*(?:join|resolve)\s*\(\s*process\.cwd\s*\(\s*\)\s*,/g,
    reason: "temporary directories must use os.tmpdir() or a test-owned workspace, not process.cwd()"
  }
];

const findings = [];
for (const scanRoot of scanRoots) {
  if (!existsSync(scanRoot)) continue;
  visit(scanRoot);
}

if (findings.length > 0) {
  console.error("Temp hygiene check failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.reason}`);
  }
  process.exit(1);
}

console.log("Temp hygiene check passed.");

function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-types") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) continue;
    scanFile(fullPath);
  }
}

function scanFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  for (const check of forbiddenPatterns) {
    check.pattern.lastIndex = 0;
    for (const match of text.matchAll(check.pattern)) {
      findings.push({
        file: relative(root, filePath).replaceAll("\\", "/"),
        line: lineNumberAt(text, match.index ?? 0),
        reason: check.reason
      });
    }
  }
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}
