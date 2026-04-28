import { runBackendNewCli } from '../interfaces/cli';

async function main(): Promise<void> {
  const exitCode = await runBackendNewCli({
    argv: process.argv.slice(2)
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
