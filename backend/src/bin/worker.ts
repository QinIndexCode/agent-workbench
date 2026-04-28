import { createBackendNewRuntime } from '../application/create-runtime';

async function main(): Promise<void> {
  const runtime = createBackendNewRuntime({
    config: {
      worker: {
        enabled: true
      }
    }
  });
  if (!runtime.worker) {
    throw new Error('backend_new worker error: queue is not configured. Enable postgres queue first.');
  }

  runtime.worker.start();
  console.log('backend_new worker started.');

  const shutdown = async (): Promise<void> => {
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
