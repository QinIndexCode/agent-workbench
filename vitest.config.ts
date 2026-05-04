import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
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
