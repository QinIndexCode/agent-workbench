import { rmSync } from "node:fs";

process.env.PORT = "5181";
process.env.SCC_DB_PATH = "data/e2e-workbench.sqlite";
process.env.SCC_API_KEY_FILE = "__disabled__";

rmSync(process.env.SCC_DB_PATH, { force: true });
await import("../apps/server/dist/index.js");
