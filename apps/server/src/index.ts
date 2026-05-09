import { createApp } from "./server.js";

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error(`[FATAL] Unhandled promise rejection: ${message}`);
});

process.on("uncaughtException", (error: Error) => {
  console.error(`[FATAL] Uncaught exception: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});

const port = Number(process.env["PORT"] ?? 5177);
const host = process.env["HOST"] ?? "127.0.0.1";

const app = await createApp();
await app.listen({ port, host });
app.log.info(`SCC Agent Workbench listening on http://${host}:${port}`);
