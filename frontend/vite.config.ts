import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(() => {
  const frontendPort = Number.parseInt(process.env.FRONTEND_DEV_PORT ?? "5173", 10);
  const backendPort = Number.parseInt(process.env.FRONTEND_BACKEND_PORT ?? "3011", 10);
  const resolvedBackendPort = Number.isFinite(backendPort) ? backendPort : 3011;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: Number.isFinite(frontendPort) ? frontendPort : 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${resolvedBackendPort}`,
          changeOrigin: true,
          secure: false,
        },
        "/socket.io": {
          target: `http://127.0.0.1:${resolvedBackendPort}`,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
