import { createApp } from "./server.js";

const port = Number(process.env["PORT"] ?? 5177);
const host = process.env["HOST"] ?? "127.0.0.1";

const app = await createApp();
await app.listen({ port, host });
app.log.info(`SCC Agent Workbench listening on http://${host}:${port}`);
