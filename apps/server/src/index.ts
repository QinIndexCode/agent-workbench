import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./server.js";

export { createApp } from "./server.js";

export interface ServerStartOptions {
  host?: string;
  port?: number;
  logger?: boolean;
}

export async function startServer(options: ServerStartOptions = {}) {
  const port = options.port ?? Number(process.env["PORT"] ?? 5177);
  const host = options.host ?? process.env["HOST"] ?? "127.0.0.1";

  const app = await createApp(options.logger === undefined ? {} : { logger: options.logger });
  await app.listen({ port, host });
  app.log.info(`Agent Workbench listening on http://${host}:${port}`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}; closing Agent Workbench server.`);
    const forceExit = setTimeout(() => {
      app.log.error(`Timed out closing Agent Workbench server after ${signal}; forcing exit.`);
      process.exit(0);
    }, 3_000);
    forceExit.unref();
    try {
      await app.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExit);
      app.log.error(error, "Failed to close Agent Workbench server cleanly.");
      process.exit(1);
    }
  }

  process.on("SIGINT", (signal) => {
    void shutdown(signal);
  });

  process.on("SIGTERM", (signal) => {
    void shutdown(signal);
  });

  return app;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
  return import.meta.url === entry;
}

if (isDirectExecution()) {
  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error(`[FATAL] Unhandled promise rejection: ${message}`);
  });

  process.on("uncaughtException", (error: Error) => {
    console.error(`[FATAL] Uncaught exception: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });

  await startServer();
}
