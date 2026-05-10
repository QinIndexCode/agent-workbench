#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

console.log("Starting SCC Agent Workbench development environment...\n");

const colors = {
  reset: "\x1b[0m",
  blue: "\x1b[1;34m",
  green: "\x1b[1;32m",
  yellow: "\x1b[1;33m"
};

console.log(`${colors.blue}[server]${colors.reset} Starting backend server...`);
const server = spawn(npmCommand, ["run", "dev", "-w", "@scc/server"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

let web;
setTimeout(() => {
  console.log(`${colors.green}[web]${colors.reset} Starting frontend dev server...`);
  web = spawn(npmCommand, ["run", "dev", "-w", "@scc/web"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });

  web.stdout.on("data", (data) => {
    process.stdout.write(`${colors.green}[web]${colors.reset} ${data.toString()}`);
  });
  web.stderr.on("data", (data) => {
    process.stderr.write(`${colors.green}[web]${colors.reset} ${data.toString()}`);
  });
  web.on("close", (code) => {
    console.log(`${colors.yellow}[web]${colors.reset} Frontend process exited with code ${code}`);
    if (server && !server.killed) {
      server.kill("SIGTERM");
    }
    process.exit(code);
  });
}, 2000);

server.stdout.on("data", (data) => {
  process.stdout.write(`${colors.blue}[server]${colors.reset} ${data.toString()}`);
});
server.stderr.on("data", (data) => {
  process.stderr.write(`${colors.blue}[server]${colors.reset} ${data.toString()}`);
});
server.on("close", (code) => {
  console.log(`${colors.yellow}[server]${colors.reset} Backend process exited with code ${code}`);
  if (web && !web.killed) {
    web.kill("SIGTERM");
  }
  process.exit(code);
});

process.on("SIGINT", () => {
  console.log(`\n${colors.yellow}Shutting down...${colors.reset}`);
  if (server && !server.killed) server.kill("SIGTERM");
  if (web && !web.killed) web.kill("SIGTERM");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log(`\n${colors.yellow}Shutting down...${colors.reset}`);
  if (server && !server.killed) server.kill("SIGTERM");
  if (web && !web.killed) web.kill("SIGTERM");
  process.exit(0);
});
