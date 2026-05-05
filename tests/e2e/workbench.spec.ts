import { expect, test } from "@playwright/test";

test("creates a host observation task and shows approval", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Task input").fill("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
  await page.getByLabel("Send").click();

  const approval = page.locator(".approvalCard");
  await expect(approval.getByText("host observation")).toBeVisible();
  await expect(approval.getByText("Allow once")).toBeVisible();
  await expect(approval.getByText("Allow for this task")).toBeVisible();
  await expect(approval.getByText("Allow globally")).toBeVisible();
  await expect(approval.getByText("Deny")).toBeVisible();

  await approval.getByText("Allow globally").click();
  await expect(page.getByText("Tool evidence returned")).toBeVisible();

  await page.getByLabel("Task input").fill("再看一次当前运行的软件");
  await page.getByLabel("Send").click();
  await expect(page.locator(".approvalCard")).toHaveCount(0);
  await expect(page.getByText("host_observation: global permission")).toBeVisible();
  await expect(page.getByText("Tool evidence returned")).toHaveCount(2);
});
