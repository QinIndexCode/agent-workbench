import { expect, test } from "@playwright/test";

const riskCategories = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const apiBase = "http://127.0.0.1:5181";

test.beforeEach(async ({ request }) => {
  for (const risk of riskCategories) {
    await request.delete(`${apiBase}/api/permissions/global/${risk}`);
  }
  await request.patch(`${apiBase}/api/preferences`, { data: { language: "en-US" } });
});

test("creates a host observation task and shows approval", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await openNavItem(page, "New Task");
  await page.getByLabel("Task input").fill("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
  await submitInput(page);

  const approval = page.locator(".approvalCard");
  await expect(approval.getByText("host observation")).toBeVisible();
  await expect(approval.getByText("Allow once")).toBeVisible();
  await expect(approval.getByText("Allow for this task")).toBeVisible();
  await expect(approval.getByText("Allow globally")).toBeVisible();
  await expect(approval.getByText("Deny")).toBeVisible();
  await expect(page.locator(".event.tool_result")).toHaveCount(0);

  await approval.getByText("Allow globally").click();
  await expect(page.locator(".event.tool_result").first()).toBeVisible();
  await expect(page.getByText("Tool evidence returned.")).toHaveCount(0);

  const collapsedMetrics = await timelineMetrics(page);
  expect(collapsedMetrics.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(collapsedMetrics.toolDetailsHeight).toBeLessThanOrEqual(36);
  expect(collapsedMetrics.toolBodyHeight).toBeLessThanOrEqual(1);
  expect(collapsedMetrics.closedToolBodyText).not.toContain("Tool evidence returned");
  expect(collapsedMetrics.closedToolBodyText).not.toContain("WorkingSet64");

  if ((await page.locator(".thinkingSummary").count()) > 0) {
    await expect(page.locator(".thinkingSummary").first()).toBeVisible();
    const collapsedThinking = await thinkingMetrics(page);
    expect(collapsedThinking.shellHeight).toBeLessThanOrEqual(1);
    expect(collapsedThinking.eventHeight).toBeLessThanOrEqual(38);
    expect(collapsedThinking.actionsOpacity).toBe("0");
    await page.locator(".thinkingSummary").first().click();
    await expect(page.locator(".thinkingDetails.open").first()).toBeVisible();
    const expandedThinking = await thinkingMetrics(page);
    expect(expandedThinking.shellHeight).toBeGreaterThan(collapsedThinking.shellHeight);
    expect(expandedThinking.actionsOpacity).toBe("1");
    await page.locator(".thinkingSummary").first().click();
    await expect.poll(async () => (await thinkingMetrics(page)).shellHeight).toBeLessThanOrEqual(1);
    const reclapsedThinking = await thinkingMetrics(page);
    expect(recollapsedThinking.eventHeight).toBeLessThanOrEqual(38);
  }

  await page.locator(".toolResultSummary").first().click();
  await expect(page.locator(".toolResultDetails.open").first()).toBeVisible();
  await expect.poll(async () => (await timelineMetrics(page)).toolDetailsHeight).toBeGreaterThan(collapsedMetrics.toolDetailsHeight);
  const expandedMetrics = await timelineMetrics(page);
  expect(expandedMetrics.toolDetailsHeight).toBeGreaterThan(collapsedMetrics.toolDetailsHeight);
  await testInfo.attach("timeline-tool-expanded", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png"
  });

  await page.getByLabel("Task input").fill("再看一次当前运行的软件");
  await submitInput(page);
  await expect(page.locator(".approvalCard")).toHaveCount(0);
  await expect(page.getByText("host_observation: global permission")).toHaveCount(0);
  await expect(page.locator(".event.tool_result").first()).toBeVisible();

  await openNavItem(page, /Settings/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByText("Permissions").click();
  await expect(page.getByText("Permissions and preferences")).toBeVisible();
});

test("covers support, docs, settings subpages, and visual overflow probes", async ({ page }, testInfo) => {
  await page.goto("/");
  await openUtilityItem(page, "Support");
  await expect(page.getByRole("dialog", { name: "Need a hand?" })).toBeVisible();
  await page.getByRole("button", { name: "Open Docs" }).click();
  await expect(page.locator(".docsView")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".docsArticle")).toBeVisible();
  await testInfo.attach("docs-view", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png"
  });
  await page.getByRole("button", { name: "Back" }).click();

  await openNavItem(page, /Settings/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const settingsSections = ["Permissions", "MCP", "Integrations", "Scheduled tasks", "Web search", "Preferences"];
  const expectedPanelText: Record<string, string> = {
    "Permissions": "Permissions",
    "MCP": "MCP",
    "Integrations": "Integrations",
    "Scheduled tasks": "Scheduled",
    "Web search": "Web search",
    "Preferences": "Agent preferences"
  };
  for (const section of settingsSections) {
    await page.getByRole("button", { name: section }).click();
    await expect(page.locator(".settingsPanel")).toContainText(expectedPanelText[section]!);
    const metrics = await page.evaluate(() => ({
      horizontalOverflow: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth)
    }));
    expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
  }

  await testInfo.attach("settings-preferences", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png"
  });
});

test("manages task folders from the sidebar on desktop and mobile", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const folder = await (await request.post(`${apiBase}/api/task-folders`, { data: { name: `Ops ${suffix}` } })).json();
  const taskResponse = await request.post(`${apiBase}/api/tasks`, {
    data: { goal: `Folder task ${suffix}`, title: `Folder ${suffix}`, folderId: folder.id }
  });
  expect(taskResponse.status()).toBe(201);

  await page.goto("/");
  await openTaskDrawer(page);
  await expect(page.getByText("Task folders")).toBeVisible();
  await page.locator(".folderTreeMain").filter({ hasText: `Ops ${suffix}` }).click();
  await page.getByLabel("Search tasks").fill(`Folder ${suffix}`);
  const taskRow = page.locator(".taskItem").filter({ hasText: `Folder ${suffix}` });
  await expect(taskRow).toBeVisible();

  await taskRow.getByLabel(new RegExp(`Edit task Folder ${suffix}`)).click();
  const taskEditDialog = page.locator(".taskEditDialog");
  await expect(taskEditDialog).toBeVisible();
  await taskEditDialog.getByLabel("Task title").fill(`Folder renamed ${suffix}`);
  await taskEditDialog.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Search tasks").fill(`Folder renamed ${suffix}`);
  const renamedTaskRow = page.locator(".taskItem").filter({ hasText: `Folder renamed ${suffix}` });
  await expect(renamedTaskRow).toBeVisible();

  await renamedTaskRow.getByLabel(new RegExp(`Delete task Folder renamed ${suffix}`)).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(renamedTaskRow).toHaveCount(0);

  const second = await (await request.post(`${apiBase}/api/tasks`, {
    data: { goal: `Folder cleanup ${suffix}`, title: `Cleanup ${suffix}`, folderId: folder.id }
  })).json();
  await page.reload();
  await openTaskDrawer(page);
  await page.locator(".folderTreeMain").filter({ hasText: `Ops ${suffix}` }).click();
  await page.getByLabel(`Delete folder Ops ${suffix}`).click();
  await expect(page.locator(".confirmDialog")).toContainText("real disk directory will not be deleted");
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete folder" }).click();
  await expect.poll(async () => (await request.get(`${apiBase}/api/tasks/${second.id}`)).status()).toBe(404);
  await expect(page.locator(".folderTreeMain").filter({ hasText: `Ops ${suffix}` })).toHaveCount(0);
});

test("manages model providers and MCP servers from settings", async ({ page }, testInfo) => {
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
  await expect(mimoRow).toContainText(/mimo/i);
  await expect(mimoRow).toContainText("••••");

  await mimoRow.getByLabel("Edit model").click();
  const editDialog = page.locator('form[aria-label="Edit model"]');
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Display name")).toHaveValue("Xiaomi MiMo");
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
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(mcpRow).toHaveCount(0);

  await page.getByRole("button", { name: "Model configuration" }).click();
  await mimoRow.getByLabel("Delete model").click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete model" }).click();
  await expect(mimoRow).toHaveCount(0);
});

test("loads the library memory route directly", async ({ page }) => {
  await page.goto("/library/memory");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(page.getByLabel("USER.md content")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
  const metrics = await page.evaluate(() => ({
    horizontalOverflow: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth)
  }));
  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
});

test("covers library, reflection, and history management", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const taskResponse = await request.post(`${apiBase}/api/tasks`, {
    data: { goal: `E2E history cleanup ${suffix}`, title: `History ${suffix}` }
  });
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

  await page.getByRole("button", { name: /Knowledge/ }).click();
  await page.getByRole("button", { name: "New item" }).click();
  const knowledgeDialog = page.locator(".knowledgeDialog");
  await knowledgeDialog.getByLabel("Title").fill(`E2E Knowledge ${suffix}`);
  await knowledgeDialog.getByLabel("Tags").fill("e2e, note");
  await knowledgeDialog.getByLabel("Content").fill("# E2E Note\nThis verifies knowledge CRUD rendering.");
  await knowledgeDialog.getByRole("button", { name: "Save" }).click();
  const knowledgeRow = page.locator(".knowledgeRow").filter({ hasText: `E2E Knowledge ${suffix}` });
  await expect(knowledgeRow).toBeVisible();

  await page.locator(".libraryNav").getByRole("button", { name: "Memory" }).click();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(page.getByLabel("USER.md content")).toBeVisible();
  await page.getByLabel("USER.md content").fill("# USER.md\n- E2E prefers concise evidence.");
  await page.locator(".libraryPreviewHeader").getByLabel("Save").click();
  await page.getByRole("button", { name: /Project memory/ }).first().click();
  await expect(page.getByLabel("MEMORY.md content")).toBeVisible();
  await page.getByLabel("MEMORY.md content").fill("# MEMORY.md\n- E2E memory route is wired.\n- E2E memory route is wired.");
  await page.locator(".libraryPreviewHeader").getByLabel("Save").click();
  await page.getByLabel("Compact project memory").click();
  await expect(page.getByText(/Compacted project memory/)).toBeVisible();
  await page.getByRole("button", { name: "New project memory" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Create project memory" });
  await memoryDialog.getByLabel("Title").fill(`E2E Memory ${suffix}`);
  await memoryDialog.getByLabel("Tags").fill("e2e, memory");
  await memoryDialog.getByLabel("Content").fill("Memory side surface is wired through Library.");
  await memoryDialog.getByRole("button", { name: "Save" }).click();
  const memoryRow = page.locator(".knowledgeRow").filter({ hasText: `E2E Memory ${suffix}` });
  await expect(memoryRow).toBeVisible();
  await memoryRow.getByLabel(`Delete E2E Memory ${suffix}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(memoryRow).toHaveCount(0);

  await page.getByRole("button", { name: /Reflections/ }).click();
  await page.getByRole("button", { name: "Run reflection" }).click();
  await expect(page.locator(".reflectionList")).toBeVisible();

  await openNavItem(page, /History/);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await page.getByLabel("Search history").fill(`History ${suffix}`);
  const historyRow = page.locator(".historyRow").filter({ hasText: `History ${suffix}` });
  await expect(historyRow).toBeVisible();
  await historyRow.getByLabel(new RegExp(`Delete History ${suffix}`)).click();
  await expect(historyRow).toHaveCount(0);
  expect((await request.get(`${apiBase}/api/tasks/${task.id}`)).status()).toBe(404);

  await openNavItem(page, /Library/);
  await skillRow.getByLabel(`Delete E2E Skill ${suffix}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(skillRow).toHaveCount(0);
  await page.getByRole("button", { name: /Knowledge/ }).click();
  await knowledgeRow.getByLabel(`Delete E2E Knowledge ${suffix}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(knowledgeRow).toHaveCount(0);
});

async function openNavItem(page: import("@playwright/test").Page, name: string | RegExp): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
  }
  if (String(name).includes("Settings")) {
    await page.locator(".sidebarUtilityToggle").click();
    await page.locator(".sidebarUtilityMenu").getByRole("button", { name }).click();
    return;
  }
  await page.locator(".sidebarNav").getByRole("button", { name }).click();
}

async function openUtilityItem(page: import("@playwright/test").Page, name: string | RegExp): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
  }
  await page.locator(".sidebarUtilityToggle").click();
  await page.locator(".sidebarUtilityMenu").getByRole("button", { name }).click();
}

async function openTaskDrawer(page: import("@playwright/test").Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
  }
}

async function timelineMetrics(page: import("@playwright/test").Page): Promise<{
  closedToolBodyText: string;
  horizontalOverflow: number;
  toolBodyHeight: number;
  toolDetailsHeight: number;
}> {
  return page.evaluate(() => {
    const toolDetails = document.querySelector(".toolResultDetails") as HTMLElement | null;
    const shell = document.querySelector(".toolResultBodyShell") as HTMLElement | null;
    const toolBodyHeight = shell?.getBoundingClientRect().height ?? 0;
    return {
      closedToolBodyText: toolBodyHeight > 1 ? shell?.innerText ?? "" : "",
      horizontalOverflow: Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.body.clientWidth
      ),
      toolBodyHeight,
      toolDetailsHeight: toolDetails?.getBoundingClientRect().height ?? 0
    };
  });
}

async function thinkingMetrics(page: import("@playwright/test").Page): Promise<{
  actionsOpacity: string;
  eventHeight: number;
  shellHeight: number;
}> {
  return page.evaluate(() => {
    const event = document.querySelector(".event.thinking_delta") as HTMLElement | null;
    const shell = document.querySelector(".thinkingBodyShell") as HTMLElement | null;
    const actions = document.querySelector(".thinkingExpandedActions") as HTMLElement | null;
    return {
      actionsOpacity: actions ? getComputedStyle(actions).opacity : "0",
      eventHeight: event?.getBoundingClientRect().height ?? 0,
      shellHeight: shell?.getBoundingClientRect().height ?? 0
    };
  });
}

async function submitInput(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel("Task input").press("Enter");
  const useLocalTitle = page.getByRole("button", { name: "Use local title" });
  try {
    await useLocalTitle.waitFor({ state: "visible", timeout: 2_000 });
    await useLocalTitle.click();
  } catch {
    // A configured model provider generated the title, so no fallback action was shown.
  }
}
