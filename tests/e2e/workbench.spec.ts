import { expect, test } from "@playwright/test";

test("creates a host observation task and shows approval", async ({ page, request }) => {
  await request.delete("http://127.0.0.1:5181/api/permissions/global/host_observation");
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
  await expect(page.locator(".event.tool_result").filter({ hasText: "Tool evidence returned." }).first()).toBeVisible();

  await page.getByLabel("Task input").fill("再看一次当前运行的软件");
  await page.getByLabel("Send").click();
  await expect(page.locator(".approvalCard")).toHaveCount(0);
  await expect(page.getByText("host_observation: global permission")).toBeVisible();
  await expect(page.locator(".event.tool_result").filter({ hasText: "Tool evidence returned." })).toBeVisible();

  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
  }
  await page.getByRole("button", { name: /Settings/ }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByText("Permissions").click();
  await expect(page.getByText("Global grants skip approval UI for matching risk categories.")).toBeVisible();
});
