import { createServer } from "vite";

process.env.VITE_API_BASE = "http://127.0.0.1:5181";

const server = await createServer({
  root: "apps/web",
  server: {
    host: "127.0.0.1",
    port: 5182
  }
});

await server.listen();
server.printUrls();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => {
    console.error("Timed out closing E2E web server; forcing exit.");
    process.exit(0);
  }, 3_000);
  forceExit.unref();
  try {
    await server.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error(error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

await new Promise(() => {});
