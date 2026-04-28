import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", "scripts"];
const FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx", ".css", ".html"]);
const IGNORE_TOKEN = "size-audit:ignore";
const DANGEROUS_SIZE_PATTERNS = [
  {
    label: "ambiguous-width-token",
    regex: /\b(?:max-w|min-w|w)-(?:sm|md|lg|xl)\b/g,
  },
];

async function collectFiles(rootDir) {
  const files = [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
      continue;
    }
    if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanLine(filePath, line, lineNumber) {
  if (line.includes(IGNORE_TOKEN)) {
    return [];
  }
  const findings = [];
  for (const pattern of DANGEROUS_SIZE_PATTERNS) {
    const matches = [...line.matchAll(pattern.regex)];
    for (const match of matches) {
      findings.push({
        filePath,
        lineNumber,
        label: pattern.label,
        token: match[0],
        line: line.trim(),
      });
    }
  }
  return findings;
}

async function main() {
  const files = (
    await Promise.all(SCAN_ROOTS.map((scanRoot) => collectFiles(path.join(ROOT, scanRoot))))
  ).flat();

  const findings = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      findings.push(...scanLine(filePath, line, index + 1));
    });
  }

  if (findings.length === 0) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          scannedRoots: SCAN_ROOTS,
          scannedFileCount: files.length,
          message: "No ambiguous width tokens detected.",
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error("Ambiguous size classes detected. Use explicit bracket widths or stable container sizes instead.\n");
  for (const finding of findings) {
    const relativePath = path.relative(ROOT, finding.filePath).replaceAll("\\", "/");
    console.error(`${relativePath}:${finding.lineNumber} [${finding.label}] ${finding.token}`);
    console.error(`  ${finding.line}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
