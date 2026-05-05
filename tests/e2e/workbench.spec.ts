import { expect, test } from "@playwright/test";

const riskCategories = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const apiBase = "http://127.0.0.1:5181";

test.beforeEach(async ({ request }) => {
  for (const risk of riskCategories) {
    await request.delete(`${apiBase}/api/permissions/global/${risk}`);
  }
  await request.patch(`${apiBase}/api/preferences`, { data: { language: "en-US" } });
});

test("creates a host observation task and shows approval", async ({ page, request }) => {
  await page.goto("/");
  await openNavItem(page, "New Task");
  await page.getByLabel("Task input").fill("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
  await page.getByLabel("Task input").press("Enter");

  const approval = page.locator(".approvalCard");
  await expect(approval.getByText("host observation")).toBeVisible();
  await expect(approval.getByText("Allow once")).toBeVisible();
  await expect(approval.getByText("Allow for this task")).toBeVisible();
  await expect(approval.getByText("Allow globally")).toBeVisible();
  await expect(approval.getByText("Deny")).toBeVisible();

  await approval.getByText("Allow globally").click();
  await expect(page.locator(".event.tool_result").filter({ hasText: "Tool evidence returned." }).first()).toBeVisible();

  await page.getByLabel("Task input").fill("再看一次当前运行的软件");
  await page.getByLabel("Task input").press("Enter");
  await expect(page.locator(".approvalCard")).toHaveCount(0);
  await expect(page.getByText("host_observation: global permission")).toBeVisible();
  await expect(page.locator(".event.tool_result").filter({ hasText: "Tool evidence returned." }).first()).toBeVisible();

  await openNavItem(page, /Settings/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByText("Permissions").click();
  await expect(page.getByText("Permissions and preferences")).toBeVisible();
});

test("manages model providers and MCP servers from settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "settings management is covered on desktop; mobile keeps task-flow coverage");
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto("/");
  await openNavItem(page, /Settings/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Add model" }).click();
  const providerDialog = page.locator('form[aria-label="Add model"]');
  await expect(providerDialog).toBeVisible();
  await providerDialog.getByLabel("Preset vendor").click();
  await page.getByRole("option", { name: "Mimo" }).click();
  await providerDialog.getByLabel("API Key").fill(`e2e-mimo-key-${suffix}`);
  await providerDialog.getByRole("button", { name: "Save" }).click();
  const mimoRow = page.locator(".providerRow").filter({ hasText: "Mimo" }).first();
  await expect(mimoRow).toBeVisible();
  await expect(mimoRow).toContainText("mimo");
  await expect(mimoRow).toContainText("••••");

  await mimoRow.getByLabel("Edit model").click();
  const editDialog = page.locator('form[aria-label="Edit model"]');
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Display name")).toHaveValue("Mimo");
  await editDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "MCP" }).click();
  await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
  await page.getByRole("button", { name: "Add server" }).click();
  const mcpDialog = page.locator('form[aria-label="Add server"]');
  await expect(mcpDialog).toBeVisible();
  await mcpDialog.getByLabel("Server label").fill(`E2E MCP ${suffix}`);
  await mcpDialog.getByLabel("Transport").click();
  await page.getByRole("option", { name: "streamable http" }).click();
  await mcpDialog.getByLabel("URL").fill("http://127.0.0.1:59999/mcp");
  await mcpDialog.getByRole("button", { name: "Save" }).click();
  const mcpRow = page.locator(".mcpServerListRow").filter({ hasText: `E2E MCP ${suffix}` });
  await expect(mcpRow).toBeVisible();
  await expect(mcpRow).toContainText("streamable http");

  await mcpRow.getByLabel(`Delete E2E MCP ${suffix}`).click();
  await expect(mcpRow).toHaveCount(0);

  await page.getByRole("button", { name: "Model configuration" }).click();
  await mimoRow.getByLabel("Delete model").click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete model" }).click();
  await expect(mimoRow).toHaveCount(0);
});

test("covers library, reflection, and history management", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "library and history CRUD are covered on desktop; mobile keeps task-flow coverage");
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const taskResponse = await request.post(`${apiBase}/api/tasks`, { data: { goal: `E2E history cleanup ${suffix}` } });
  const task = await taskResponse.json();
  await page.goto("/");

  await openNavItem(page, /Library/);
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await page.getByRole("button", { name: "New skill" }).click();
  const skillDialog = page.locator(".skillDialog");
  await expect(skillDialog).toBeVisible();
  await skillDialog.getByLabel("Title").fill(`E2E Skill ${suffix}`);
  await skillDialog.getByLabel("Applicability").fill("Reusable E2E test capability");
  await skillDialog.getByLabel("Body").fill("# E2E Skill\nUse clear steps, reusable constraints, and no one-off task output.");
  await skillDialog.getByLabel("Trigger conditions").fill("e2e skill, reusable test");
  await skillDialog.getByRole("button", { name: "Save" }).click();
  const skillRow = page.locator(".skillListRow").filter({ hasText: `E2E Skill ${suffix}` });
  await expect(skillRow).toBeVisible();
  await skillRow.getByLabel(`Edit skill E2E Skill ${suffix}`).click();
  await expect(page.locator(".skillDialog").getByLabel("Title")).toHaveValue(`E2E Skill ${suffix}`);
  await page.locator(".skillDialog").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await page.getByRole("button", { name: "New item" }).click();
  const knowledgeDialog = page.locator(".knowledgeDialog");
  await knowledgeDialog.getByLabel("Title").fill(`E2E Knowledge ${suffix}`);
  await knowledgeDialog.getByLabel("Tags").fill("e2e, note");
  await knowledgeDialog.getByLabel("Content").fill("# E2E Note\nThis verifies knowledge CRUD rendering.");
  await knowledgeDialog.getByRole("button", { name: "Save" }).click();
  const knowledgeRow = page.locator(".knowledgeRow").filter({ hasText: `E2E Knowledge ${suffix}` });
  await expect(knowledgeRow).toBeVisible();

  await page.getByRole("tab", { name: /Reflections/ }).click();
  await page.getByRole("button", { name: "Run reflection" }).click();
  await expect(page.locator(".reflectionList")).toBeVisible();

  await openNavItem(page, /History/);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await page.getByLabel("Search history").fill(`E2E history cleanup ${suffix}`);
  const historyRow = page.locator(".historyRow").filter({ hasText: `E2E history cleanup ${suffix}` });
  await expect(historyRow).toBeVisible();
  await historyRow.getByLabel(new RegExp(`Delete E2E history cleanup ${suffix}`)).click();
  await expect(historyRow).toHaveCount(0);
  expect((await request.get(`${apiBase}/api/tasks/${task.id}`)).status()).toBe(404);

  await openNavItem(page, /Library/);
  await skillRow.getByLabel(`Delete E2E Skill ${suffix}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(skillRow).toHaveCount(0);
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await knowledgeRow.getByLabel(`Delete E2E Knowledge ${suffix}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(knowledgeRow).toHaveCount(0);
});

async function openNavItem(page: import("@playwright/test").Page, name: string | RegExp): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
  }
  await page.getByRole("button", { name }).click();
}
