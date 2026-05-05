import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5182",
    channel: "chrome",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 920 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: [
    {
      command: "node scripts/start-e2e-server.mjs",
      url: "http://127.0.0.1:5181/health",
      reuseExistingServer: false,
      timeout: 20_000
    },
    {
      command: "node scripts/start-e2e-web.mjs",
      url: "http://127.0.0.1:5182",
      reuseExistingServer: false,
      timeout: 20_000
    }
  ]
});
