import { createBackendNewRuntime } from '../application/create-runtime';
import { createBackendNewHttpServer } from '../interfaces/http/server';

async function main(): Promise<void> {
  const runtime = createBackendNewRuntime();
  const server = createBackendNewHttpServer(runtime);
  await new Promise<void>((resolve) => {
    server.listen(runtime.config.server.port, runtime.config.server.host, () => resolve());
  });
  console.log(`backend server listening on http://${runtime.config.server.host}:${runtime.config.server.port}`);

  const shutdown = async (): Promise<void> => {
    server.close();
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
