#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./commands.js";

export { runCli } from "./commands.js";
export { parseArgs, CliUsageError } from "./args.js";
export { ApiClient, ApiError } from "./http.js";
export { renderValue } from "./render.js";

function isDirectExecution(): boolean {
  const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
  return import.meta.url === entry;
}

if (isDirectExecution()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
