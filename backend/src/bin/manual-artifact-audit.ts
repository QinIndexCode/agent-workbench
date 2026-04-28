import { renderManualArtifactAuditMarkdown, runManualArtifactAudit } from '../application/benchmark';

async function main(): Promise<void> {
  const report = await runManualArtifactAudit();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderManualArtifactAuditMarkdown(report));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
