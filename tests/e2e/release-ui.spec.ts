import { expect, test } from "@playwright/test";
import { bootstrapSession, horizontalOverflow, persistReleaseUiMetric, screenshotPath, submitInput } from "./helpers.js";

test.beforeEach(async ({ request }) => {
  await bootstrapSession(request);
});

test("captures release UI screenshots and layout metrics", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const captures: Array<{ view: string; ready: () => Promise<void> }> = [
    {
      view: "tasks",
      ready: async () => {
        await page.goto("/tasks/new");
        await page.getByLabel("Task input").fill("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
        await submitInput(page);
        const approval = page.locator(".approvalCard");
        await expect(approval.getByText("host observation")).toBeVisible();
        await approval.getByText("Allow globally").click();
        await expect(page.locator(".event.tool_result").first()).toBeVisible({ timeout: 30_000 });
      }
    },
    {
      view: "settings",
      ready: async () => {
        await page.goto("/settings/providers");
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Model configuration" })).toBeVisible();
      }
    },
    {
      view: "docs",
      ready: async () => {
        await page.goto("/docs/settings");
        await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
        await expect(page.locator(".docsArticle")).toBeVisible();
      }
    },
    {
      view: "history",
      ready: async () => {
        await page.goto("/history");
        await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
      }
    },
    {
      view: "library",
      ready: async () => {
        await page.goto("/library/memory");
        await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
      }
    }
  ];

  for (const capture of captures) {
    await capture.ready();
    const screenshot = screenshotPath(testInfo.project.name, capture.view);
    const overflow = await horizontalOverflow(page);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: screenshot, fullPage: false });
    await persistReleaseUiMetric({
      project: testInfo.project.name,
      view: capture.view,
      horizontalOverflow: overflow,
      route: page.url(),
      screenshotPath: screenshot
    });
  }
});
