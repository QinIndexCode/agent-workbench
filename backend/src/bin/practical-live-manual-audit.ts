import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isReusablePracticalLiveReport,
  PracticalLiveTaskAcceptanceSuiteResult,
  runPracticalLiveManualAudit
} from '../application/benchmark';

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function resolveLiveTaskReportPath(): string {
  const profile = process.env.SCORECARD_PROFILE?.trim() || 'default';
  const fileName = profile === 'default'
    ? 'practical-live-task-acceptance.json'
    : `practical-live-task-acceptance.${profile}.json`;
  return path.resolve(resolveRepoRoot(), '.codex-run', 'logs', fileName);
}

function resolveManualAuditReportPath(): string {
  const profile = process.env.SCORECARD_PROFILE?.trim() || 'default';
  const fileName = profile === 'default'
    ? 'practical-live-manual-audit.json'
    : `practical-live-manual-audit.${profile}.json`;
  return path.resolve(resolveRepoRoot(), '.codex-run', 'logs', fileName);
}

async function readExistingLiveReport(): Promise<PracticalLiveTaskAcceptanceSuiteResult | undefined> {
  const reportPath = resolveLiveTaskReportPath();
  try {
    const payload = JSON.parse(await fs.readFile(reportPath, 'utf8')) as PracticalLiveTaskAcceptanceSuiteResult;
    return isReusablePracticalLiveReport(payload, { env: process.env })
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const sourceReport = await readExistingLiveReport();
  const report = await runPracticalLiveManualAudit({ sourceReport });
  const reportPath = resolveManualAuditReportPath();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    'practical live manual audit:',
    ...report.entries.map((entry) => `- ${entry.scenario}: verdict=${entry.verdict}, shipReady=${entry.shipReady}, criticalGaps=${entry.criticalGaps.length}, minorEdits=${entry.minorEditsNeeded.length}, artifacts=${entry.artifactPaths.join(', ') || 'none'}`),
    '',
    `status=${report.status}, externalBlocker=${report.externalBlocker ?? 'none'}`,
    `totals: passed=${report.totals.passed}, failed=${report.totals.failed}, total=${report.totals.total}, shipReadyPassRate=${report.totals.shipReadyPassRate}, criticalGaps=${report.totals.criticalGapsCount}, minorEdits=${report.totals.minorEditsNeededCount}`
  ];

  console.log(lines.join('\n'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
