import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

const root = process.cwd();
const playwrightArgs = process.argv.slice(2);
const serverProcesses = [];
const shouldStreamServerLogs = process.env.E2E_SERVER_LOGS === "1";

try {
  await assertPortsAvailable([
    { name: "api", port: 5181 },
    { name: "web", port: 5182 }
  ]);
  const apiProcess = startProcess("api", process.execPath, ["scripts/start-e2e-server.mjs"]);
  serverProcesses.push(apiProcess);
  const webProcess = startProcess("web", process.execPath, ["scripts/start-e2e-web.mjs"]);
  serverProcesses.push(webProcess);
  await waitForUrl("http://127.0.0.1:5181/health", 20_000, apiProcess);
  await waitForUrl("http://127.0.0.1:5182", 20_000, webProcess);

  const testArgs = playwrightArgs.length > 0
    ? playwrightArgs
    : [
        "tests/e2e/workbench.spec.ts",
        "tests/e2e/release-ui.spec.ts",
        "tests/e2e/responsiveness.spec.ts",
        "tests/e2e/side-capabilities.spec.ts"
      ];
  const hasExplicitProject = testArgs.some((arg) => arg === "--project" || arg.startsWith("--project="));
  const runArgs = hasExplicitProject ? testArgs : [...testArgs, "--project=desktop", "--project=mobile"];
  process.exitCode = await runForeground([
    "npx",
    "playwright",
    "test",
    ...runArgs
  ], {
    ...process.env,
    PLAYWRIGHT_EXTERNAL_SERVERS: "1"
  });
} finally {
  await Promise.allSettled(serverProcesses.map((child) => stopProcessTree(child)));
}

process.exit(process.exitCode ?? 0);

function startProcess(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.e2eName = name;
  child.e2eExit = null;
  child.e2eStopping = false;
  child.stdout.on("data", (chunk) => {
    if (shouldStreamServerLogs) process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    if (shouldStreamServerLogs) process.stderr.write(`[${name}] ${chunk}`);
  });
  child.once("exit", (code, signal) => {
    child.e2eExit = { code, signal };
    if (code !== 0 && signal === null && !child.e2eStopping) {
      process.stderr.write(`[${name}] exited with code ${code}\n`);
    }
  });
  return child;
}

function assertPortsAvailable(ports) {
  return Promise.all(ports.map(({ name, port }) => assertPortAvailable(name, port)));
}

function assertPortAvailable(name, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.once("error", (error) => {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      if (code === "EADDRINUSE") {
        rejectPromise(new Error(`E2E ${name} port ${port} is already in use. Stop the stale service before running the isolated E2E suite.`));
        return;
      }
      rejectPromise(error);
    });
    probe.once("listening", () => {
      probe.close(() => resolvePromise());
    });
    probe.listen(port, "127.0.0.1");
  });
}

function runForeground(args, env) {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "cmd.exe" : args[0];
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", ...args] : args.slice(1);
    const child = spawn(command, commandArgs, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function waitForUrl(url, timeoutMs, child) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child?.e2eExit) {
      throw new Error(`Timed out waiting for ${url}: ${describeProcessExit(child)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no response")}`);
}

function describeProcessExit(child) {
  const exit = child.e2eExit;
  const name = child.e2eName ?? "process";
  if (!exit) return `${name} is not running`;
  if (exit.signal) return `${name} exited from signal ${exit.signal}`;
  return `${name} exited with code ${exit.code ?? "unknown"}`;
}

function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  child.e2eStopping = true;
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolve();
      }, 3_000);
      timer.unref();
      killer.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    timer.unref();
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
