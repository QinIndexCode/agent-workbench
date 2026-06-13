import { rmSync } from "node:fs";

process.env.PORT = "5181";
process.env.AGENT_WORKBENCH_DB_PATH = "data/e2e-workbench.sqlite";
process.env.AGENT_WORKBENCH_API_KEY_FILE = "__disabled__";
process.env.AGENT_WORKBENCH_TEST_TOOL_COMMAND =
  "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 5 ProcessName,Id,CPU,WorkingSet64 | ConvertTo-Json -Depth 3";

for (const file of [
  process.env.AGENT_WORKBENCH_DB_PATH,
  `${process.env.AGENT_WORKBENCH_DB_PATH}-wal`,
  `${process.env.AGENT_WORKBENCH_DB_PATH}-shm`
]) {
  rmSync(file, { force: true });
}
const { startServer } = await import("../apps/server/dist/index.js");
await startServer();
