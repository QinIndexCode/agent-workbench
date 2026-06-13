import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-dom") || /node_modules[\\/](react|scheduler)[\\/]/.test(id)) return "react-vendor";
          if (id.includes("lucide-react") || id.includes("@lobehub")) return "ui-vendor";
          if (id.includes("react-file-icon")) return "file-vendor";
          return "vendor";
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5177",
        changeOrigin: true,
        ws: true
      },
      "/health": {
        target: "http://127.0.0.1:5177",
        changeOrigin: true
      }
    }
  }
});
