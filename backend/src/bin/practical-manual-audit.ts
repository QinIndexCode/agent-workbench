import { renderPracticalManualAuditMarkdown, runPracticalManualAudit } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runPracticalManualAudit();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderPracticalManualAuditMarkdown(report));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
