import { defineConfig, devices } from "@playwright/test";

const useExternalServers = process.env.PLAYWRIGHT_EXTERNAL_SERVERS === "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  outputDir: "data/test-reports/playwright-results",
  reporter: [
    ["list"],
    ["json", { outputFile: "data/test-reports/playwright-json/results.json" }],
    ["html", { open: "never", outputFolder: "data/test-reports/playwright-report" }]
  ],
  use: {
    baseURL: "http://127.0.0.1:5182",
    channel: process.env.CI ? undefined : "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 920 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: useExternalServers ? undefined : [
    {
      command: "node scripts/start-e2e-server.mjs",
      url: "http://127.0.0.1:5181/health",
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "node scripts/start-e2e-web.mjs",
      url: "http://127.0.0.1:5182",
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    }
  ]
});
