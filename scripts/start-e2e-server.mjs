import { rmSync } from "node:fs";

process.env.PORT = "5181";
process.env.SCC_DB_PATH = "data/e2e-workbench.sqlite";
process.env.SCC_API_KEY_FILE = "__disabled__";
process.env.SCC_TEST_TOOL_COMMAND =
  "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 5 ProcessName,Id,CPU,WorkingSet64 | ConvertTo-Json -Depth 3";

rmSync(process.env.SCC_DB_PATH, { force: true });
await import("../apps/server/dist/index.js");
