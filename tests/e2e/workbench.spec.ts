import { expect, test } from "@playwright/test";

test("creates a host observation task and shows approval", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Task input").fill("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
  await page.getByLabel("Send").click();

  await expect(page.getByText("host observation")).toBeVisible();
  await expect(page.getByText("Allow once")).toBeVisible();
  await expect(page.getByText("Allow for this task")).toBeVisible();
  await expect(page.getByText("Deny")).toBeVisible();
});
