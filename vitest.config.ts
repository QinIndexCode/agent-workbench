import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-workbench/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@agent-workbench/shared": resolve(__dirname, "packages/shared/src/index.ts")
    }
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup-warning-filter.ts"],
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/core/src/**/*.ts", "apps/server/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
      exclude: [
        "apps/server/src/index.ts",
        "apps/web/src/main.tsx",
        "packages/core/src/openai-model.ts",
        "**/*.d.ts"
      ]
    }
  }
});
