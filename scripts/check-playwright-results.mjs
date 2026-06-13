import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const reportPath = resolve(root, "data", "test-reports", "playwright-json", "results.json");

if (!existsSync(reportPath)) {
  console.error(`Missing Playwright JSON report: ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const counts = { passed: 0, failed: 0, skipped: 0, interrupted: 0, timedOut: 0 };

visitSuites(report.suites ?? []);

if (counts.skipped > 0) {
  console.error(`Playwright strict gate failed: found ${counts.skipped} skipped test(s).`);
  process.exit(1);
}
if (counts.failed > 0 || counts.interrupted > 0 || counts.timedOut > 0) {
  console.error(`Playwright strict gate failed: ${JSON.stringify(counts)}`);
  process.exit(1);
}

console.log(`Playwright strict gate passed: ${JSON.stringify(counts)}`);

function visitSuites(suites) {
  for (const suite of suites) {
    visitSpecs(suite.specs ?? []);
    visitSuites(suite.suites ?? []);
  }
}

function visitSpecs(specs) {
  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      const outcomes = Array.isArray(test.results) ? test.results : [];
      if (outcomes.length === 0) {
        counts.skipped += 1;
        continue;
      }
      const statuses = outcomes.map((result) => String(result.status ?? ""));
      if (statuses.some((status) => status === "failed")) counts.failed += 1;
      else if (statuses.some((status) => status === "interrupted")) counts.interrupted += 1;
      else if (statuses.some((status) => status === "timedOut")) counts.timedOut += 1;
      else if (statuses.every((status) => status === "skipped")) counts.skipped += 1;
      else if (statuses.some((status) => status === "passed")) counts.passed += 1;
      else counts.skipped += 1;
    }
  }
}
