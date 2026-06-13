import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const outDir = resolve(root, "data", "test-reports", "api-route-coverage");
const reportPath = resolve(outDir, "report.json");
const serverPath = resolve(root, "apps", "server", "src", "server.ts");
const scanRoots = [
  resolve(root, "apps", "server", "tests"),
  resolve(root, "apps", "web", "src"),
  resolve(root, "apps", "cli", "src"),
  resolve(root, "packages", "core", "tests"),
  resolve(root, "tests")
];

const routes = extractFastifyRoutes(readFileSync(serverPath, "utf8"));
const files = scanRoots.flatMap((scanRoot) => walk(scanRoot));
const fileTexts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
const rows = routes.map((route) => {
  const serverTests = hitsFor(route.path, "server");
  const webUnit = hitsFor(route.path, "webUnit");
  const cliUnit = hitsFor(route.path, "cliUnit");
  const e2e = hitsFor(route.path, "e2e");
  return {
    ...route,
    coverage: {
      serverTests,
      webUnit,
      cliUnit,
      e2e
    }
  };
});
const uncovered = rows.filter((route) => Object.values(route.coverage).every((hits) => hits.length === 0));
const noE2e = rows.filter((route) => route.coverage.e2e.length === 0);
const report = {
  generatedAt: new Date().toISOString(),
  sourceFingerprint: sourceFingerprint(root),
  routeCount: rows.length,
  uncoveredCount: uncovered.length,
  noE2eCount: noE2e.length,
  pass: uncovered.length === 0,
  uncovered,
  noE2e: noE2e.map(({ method, path, line, coverage }) => ({ method, path, line, coverage })),
  routes: rows
};

mkdirSync(outDir, { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

if (uncovered.length > 0) {
  console.error(`API route coverage failed: ${uncovered.length} route(s) have no direct server, web, CLI, or E2E coverage.`);
  for (const route of uncovered) console.error(`- ${route.method} ${route.path} (${toRelative(serverPath)}:${route.line})`);
  console.error(`Report: ${reportPath}`);
  process.exit(1);
}

console.log(`API route coverage passed for ${rows.length} route(s). Routes without E2E direct coverage: ${noE2e.length}.`);
console.log(`Report: ${reportPath}`);

function extractFastifyRoutes(source) {
  const routes = [];
  const direct = /app\.(get|post|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = direct.exec(source))) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      line: source.slice(0, match.index).split("\n").length
    });
  }

  const routeObject = /app\.route\(\{[\s\S]*?method:\s*["'`]([^"'`]+)["'`][\s\S]*?url:\s*["'`]([^"'`]+)["'`]/g;
  while ((match = routeObject.exec(source))) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      line: source.slice(0, match.index).split("\n").length
    });
  }

  return routes.sort((left, right) => left.line - right.line || left.path.localeCompare(right.path));
}

function walk(dir, out = []) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) walk(fullPath, out);
    else if ([".js", ".mjs", ".ts", ".tsx"].includes(extname(fullPath))) out.push(fullPath);
  }
  return out;
}

function hitsFor(routePath, scope) {
  const candidates = routePathVariants(routePath);
  const hits = [];
  for (const [file, text] of fileTexts) {
    if (scope === "server" && !normalizePath(file).startsWith("apps/server/tests/")) continue;
    if (scope === "e2e" && !normalizePath(file).startsWith("tests/e2e/")) continue;
    if (scope === "webUnit" && !(normalizePath(file).startsWith("apps/web/src/") && /\.test\.tsx?$/u.test(file))) continue;
    if (scope === "cliUnit" && !(normalizePath(file).startsWith("apps/cli/src/") && /\.test\.tsx?$/u.test(file))) continue;
    if (candidates.some((candidate) => text.includes(candidate))) hits.push(toRelative(file));
  }
  return [...new Set(hits)].sort();
}

function routePathVariants(routePath) {
  const noParams = routePath.replaceAll(/:([A-Za-z0-9_]+)/g, "");
  const prefix = routePath.split("/:")[0];
  return [...new Set([routePath, noParams, prefix].filter((value) => value && value.length > 4))];
}

function normalizePath(filePath) {
  return relative(root, resolve(filePath)).replaceAll("\\", "/");
}

function toRelative(filePath) {
  return normalizePath(filePath);
}
