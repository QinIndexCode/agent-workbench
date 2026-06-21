import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-types/**",
      "apps/web/dist/**",
      "data/**",
      "tests/e2e/**"
    ],
    hookTimeout: 15_000,
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "tests/real-task-matrix/**/*.test.ts",
      "tests/stress/**/*.test.ts"
    ],
    setupFiles: ["tests/setup-warning-filter.ts"],
    testTimeout: 15_000
  }
});
