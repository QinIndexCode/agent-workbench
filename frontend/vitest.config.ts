import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      react: path.resolve(__dirname, '../node_modules/react'),
      'react/jsx-runtime': path.resolve(__dirname, '../node_modules/react/jsx-runtime.js'),
      'react-dom': path.resolve(__dirname, '../node_modules/react-dom'),
      'react-dom/client': path.resolve(__dirname, '../node_modules/react-dom/client.js'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/components/settings/GovernanceSettingsSection.tsx',
      ],
      thresholds: {
        lines: 80,
        functions: 70,
        branches: 65,
        statements: 80,
      },
    },
  },
});
