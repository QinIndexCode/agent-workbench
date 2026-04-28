import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const frontendPort = Number.parseInt(process.env.FRONTEND_DEV_PORT ?? '5173', 10)
const backendPort = Number.parseInt(process.env.FRONTEND_BACKEND_PORT ?? '3011', 10)

export default defineConfig({
  root: path.resolve(__dirname, './frontend'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './frontend/src'),
    },
  },
  server: {
    port: Number.isFinite(frontendPort) ? frontendPort : 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number.isFinite(backendPort) ? backendPort : 3011}`,
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: `http://127.0.0.1:${Number.isFinite(backendPort) ? backendPort : 3011}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, './frontend/dist'),
    emptyOutDir: true,
  },
})
