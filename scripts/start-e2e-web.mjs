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
await new Promise(() => {});
