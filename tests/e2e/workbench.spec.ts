import { expect, test } from "@playwright/test";

const riskCategories = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const apiBase = "http://127.0.0.1:5181";
const SESSION_HEADER = "x-agent-workbench-session";

let sessionHeaders: Record<string, string> = {};

test.beforeEach(async ({ request }) => {
  const bootstrap = await request.get(`${apiBase}/api/session/bootstrap`);
  const { sessionToken } = await bootstrap.json();
  sessionHeaders = { [SESSION_HEADER]: sessionToken };
  for (const risk of riskCategories) {
    await request.delete(`${apiBase}/api/permissions/global/${risk}`, { headers: sessionHeaders });
  }
  await request.patch(`${apiBase}/api/preferences`, { data: { language: "en-US" }, headers: sessionHeaders });
});

test("creates a host observation task and shows approval", async ({ page }, testInfo) => {
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
    expect((await thinkingMetrics(page)).eventHeight).toBeLessThanOrEqual(38);
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
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
  await expect(page.getByText("Approval strategy")).toBeVisible();
});

test("uploads, attaches, lists, and deletes task attachments through public HTTP APIs", async ({ request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const fileName = `e2e-note-${suffix}.md`;
  const content = `# E2E attachment ${suffix}\nsecret=sk-e2e-attachment-${suffix}`;
  const upload = await request.post(`${apiBase}/api/task-attachments`, {
    headers: sessionHeaders,
    data: {
      fileName,
      mimeType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
      dataBase64: Buffer.from(content, "utf8").toString("base64")
    }
  });
  expect(upload.status()).toBe(201);
  const attachment = await upload.json() as { id: string; fileName: string; textPreview?: string };
  expect(attachment.fileName).toBe(fileName);
  expect(attachment.textPreview ?? "").toContain("[redacted-secret]");
  expect(attachment.textPreview ?? "").not.toContain("sk-e2e-attachment");

  const taskResponse = await request.post(`${apiBase}/api/tasks`, {
    headers: sessionHeaders,
    data: {
      goal: `Use the uploaded attachment ${suffix}`,
      title: `Attachment ${suffix}`,
      attachmentIds: [attachment.id]
    }
  });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json() as { id: string };

  const listResponse = await request.get(`${apiBase}/api/tasks/${task.id}/attachments`, { headers: sessionHeaders });
  expect(listResponse.status()).toBe(200);
  const attached = await listResponse.json() as Array<{ id: string; fileName: string }>;
  expect(attached).toEqual(expect.arrayContaining([expect.objectContaining({ id: attachment.id, fileName })]));

  const deleteResponse = await request.delete(`${apiBase}/api/task-attachments/${attachment.id}`, { headers: sessionHeaders });
  expect(deleteResponse.status()).toBe(204);
  const afterDelete = await request.get(`${apiBase}/api/tasks/${task.id}/attachments`, { headers: sessionHeaders });
  expect(afterDelete.status()).toBe(200);
  expect(await afterDelete.json()).toEqual([]);
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
    await page.getByRole("button", { name: section, exact: true }).click();
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
  const folder = await (await request.post(`${apiBase}/api/task-folders`, { data: { name: `Ops ${suffix}` }, headers: sessionHeaders })).json();
  const taskResponse = await request.post(`${apiBase}/api/tasks`, {
    data: { goal: `Folder task ${suffix}`, title: `Folder ${suffix}`, folderId: folder.id },
    headers: sessionHeaders
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
    data: { goal: `Folder cleanup ${suffix}`, title: `Cleanup ${suffix}`, folderId: folder.id },
    headers: sessionHeaders
  })).json();
  await page.reload();
  await openTaskDrawer(page);
  await page.locator(".folderTreeMain").filter({ hasText: `Ops ${suffix}` }).click();
  await page.getByLabel(`Delete folder Ops ${suffix}`).click();
  await expect(page.locator(".confirmDialog")).toContainText("real disk directory will not be deleted");
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete folder" }).click();
  await expect.poll(async () => (await request.get(`${apiBase}/api/tasks/${second.id}`, { headers: sessionHeaders })).status()).toBe(404);
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
  await providerDialog.getByRole("button", { name: "Preset vendor" }).click();
  await page.getByRole("option", { name: "Mimo Xiaomi MiMo", exact: true }).click();
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
  await mcpDialog.getByRole("button", { name: "Transport" }).click();
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

test("manages permissions, integrations, scheduled tasks, search providers, and preferences from settings", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const integrationName = `E2E Discord ${suffix}`;
  const integrationUpdatedName = `${integrationName} Updated`;
  const scheduledName = `E2E Schedule ${suffix}`;
  const scheduledUpdatedName = `${scheduledName} Updated`;
  const searchName = `E2E Search ${suffix}`;
  const searchUpdatedName = `${searchName} Updated`;

  await page.goto("/");
  await openNavItem(page, /Settings/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
  await page.getByRole("radio", { name: "Read only" }).click();
  await expect.poll(async () => {
    const grants = await (await request.get(`${apiBase}/api/permissions/global`, { headers: sessionHeaders })).json();
    return [...grants].map((grant: { riskCategory: string }) => grant.riskCategory).sort().join(",");
  }).toBe("host_observation,workspace_read");

  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await page.locator(".settingsPanel").getByRole("button", { name: "View guide" }).click();
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
  await expect(page).toHaveURL(/\/docs\/integrations$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings\/integrations$/);

  await page.locator(".settingsPanel .panelHero").getByRole("button", { name: "Add integration" }).click();
  const integrationDialog = page.locator('form[aria-label="Add integration"]');
  await expect(integrationDialog).toBeVisible();
  await integrationDialog.getByLabel("Name").fill(integrationName);
  await integrationDialog.getByLabel("Bot token").fill(`bot-${suffix}`);
  await integrationDialog.getByLabel("Public key").fill(`public-${suffix}`);
  await integrationDialog.getByLabel("App ID").fill(`app-${suffix}`);
  await integrationDialog.getByLabel("Callback URL").fill(`https://example.com/${suffix}`);
  await integrationDialog.getByRole("button", { name: "Save" }).click();
  const integrationRow = page.locator(".providerRow").filter({ hasText: integrationName });
  await expect(integrationRow).toBeVisible();
  await expect.poll(async () => {
    const integrations = await (await request.get(`${apiBase}/api/integrations`, { headers: sessionHeaders })).json();
    return integrations.some((item: { label: string }) => item.label === integrationName);
  }).toBe(true);

  await integrationRow.getByLabel(`Edit integration ${integrationName}`).click();
  const editIntegrationDialog = page.locator('form[aria-label="Edit integration"]');
  await expect(editIntegrationDialog).toBeVisible();
  await editIntegrationDialog.getByLabel("Name").fill(integrationUpdatedName);
  await editIntegrationDialog.getByLabel("Can receive messages").click();
  await editIntegrationDialog.getByRole("button", { name: "Save" }).click();
  const integrationUpdatedRow = page.locator(".providerRow").filter({ hasText: integrationUpdatedName });
  await expect(integrationUpdatedRow).toBeVisible();
  await expect.poll(async () => {
    const integrations = await (await request.get(`${apiBase}/api/integrations`, { headers: sessionHeaders })).json();
    const match = integrations.find((item: { label: string }) => item.label === integrationUpdatedName);
    return match ? String(Boolean(match.enabled)) : "missing";
  }).toBe("true");

  await integrationUpdatedRow.getByLabel(`Delete ${integrationUpdatedName}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(integrationUpdatedRow).toHaveCount(0);

  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduled tasks" })).toBeVisible();
  await page.locator(".settingsPanel .panelHero").getByRole("button", { name: "New" }).click();
  const scheduleDialog = page.locator('form[aria-label="New scheduled task"]');
  await expect(scheduleDialog).toBeVisible();
  await scheduleDialog.getByLabel("Task name").fill(scheduledName);
  await scheduleDialog.getByLabel("Run time").fill("09:15");
  await scheduleDialog.getByLabel("Task prompt").fill("Create a compact daily operational summary.");
  await scheduleDialog.getByRole("button", { name: "Create" }).click();
  const scheduledRow = page.locator(".scheduledTaskRow").filter({ hasText: scheduledName });
  await expect(scheduledRow).toBeVisible();
  await expect.poll(async () => {
    const tasks = await (await request.get(`${apiBase}/api/scheduled-tasks`, { headers: sessionHeaders })).json();
    return tasks.some((item: { title: string }) => item.title === scheduledName);
  }).toBe(true);

  await scheduledRow.getByLabel("Pause scheduled task").click();
  await expect.poll(async () => {
    const tasks = await (await request.get(`${apiBase}/api/scheduled-tasks`, { headers: sessionHeaders })).json();
    const match = tasks.find((item: { title: string }) => item.title === scheduledName);
    return match?.status ?? "missing";
  }).toBe("paused");
  await scheduledRow.getByLabel("Resume scheduled task").click();
  await expect.poll(async () => {
    const tasks = await (await request.get(`${apiBase}/api/scheduled-tasks`, { headers: sessionHeaders })).json();
    const match = tasks.find((item: { title: string }) => item.title === scheduledName);
    return match?.status ?? "missing";
  }).toBe("active");

  await scheduledRow.getByLabel("Edit scheduled task").click();
  const editScheduledDialog = page.locator('form[aria-label="Edit scheduled task"]');
  await expect(editScheduledDialog).toBeVisible();
  await editScheduledDialog.getByLabel("Task name").fill(scheduledUpdatedName);
  await editScheduledDialog.getByRole("button", { name: "Save" }).click();
  const scheduledUpdatedRow = page.locator(".scheduledTaskRow").filter({ hasText: scheduledUpdatedName });
  await expect(scheduledUpdatedRow).toBeVisible();
  await scheduledUpdatedRow.getByLabel("Delete scheduled task").click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(scheduledUpdatedRow).toHaveCount(0);

  await page.getByRole("button", { name: "Web search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Web search" })).toBeVisible();
  await page.locator(".settingsPanel .panelHero").getByRole("button", { name: "Add" }).click();
  const searchDialog = page.locator('form[aria-label="Add search provider"]');
  await expect(searchDialog).toBeVisible();
  await searchDialog.getByLabel("Label").fill(searchName);
  await searchDialog.getByRole("button", { name: "Save" }).click();
  const searchRow = page.locator(".providerRow").filter({ hasText: searchName });
  await expect(searchRow).toBeVisible();
  await expect.poll(async () => {
    const providers = await (await request.get(`${apiBase}/api/web-search/providers`, { headers: sessionHeaders })).json();
    return providers.some((item: { label: string }) => item.label === searchName);
  }).toBe(true);

  await searchRow.getByLabel(`Edit search provider ${searchName}`).click();
  const editSearchDialog = page.locator('form[aria-label="Edit search provider"]');
  await expect(editSearchDialog).toBeVisible();
  await editSearchDialog.getByLabel("Label").fill(searchUpdatedName);
  await editSearchDialog.getByRole("button", { name: "Select search provider kind" }).click();
  await page.getByRole("option", { name: "Custom" }).click();
  await editSearchDialog.getByLabel("Endpoint").fill("https://example.com/search?q={query}&limit={limit}");
  await editSearchDialog.getByLabel("Available for search").click();
  await editSearchDialog.getByRole("button", { name: "Save" }).click();
  const searchUpdatedRow = page.locator(".providerRow").filter({ hasText: searchUpdatedName });
  await expect(searchUpdatedRow).toBeVisible();
  await expect.poll(async () => {
    const providers = await (await request.get(`${apiBase}/api/web-search/providers`, { headers: sessionHeaders })).json();
    const match = providers.find((item: { label: string }) => item.label === searchUpdatedName);
    return match ? `${match.kind}:${String(Boolean(match.enabled))}` : "missing";
  }).toBe("custom:false");

  await searchUpdatedRow.getByLabel(`Delete search provider ${searchUpdatedName}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete" }).click();
  await expect(searchUpdatedRow).toHaveCount(0);

  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent preferences" })).toBeVisible();
  await page.getByRole("button", { name: "Appearance theme" }).click();
  await page.getByRole("option", { name: "Light" }).click();
  await page.getByRole("button", { name: "Response detail" }).click();
  await page.getByRole("option", { name: "Detailed" }).click();
  await expect.poll(async () => {
    const preferences = await (await request.get(`${apiBase}/api/preferences`, { headers: sessionHeaders })).json();
    return `${preferences.theme}:${preferences.responseDetail}`;
  }).toBe("light:detailed");
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/preferences$/);
  await expect(page.getByRole("button", { name: "Appearance theme" })).toContainText("Light");
  await expect(page.getByRole("button", { name: "Response detail" })).toContainText("Detailed");
});

test("keeps settings and docs usable on mobile, including section guide links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/preferences");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent preferences", exact: true })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.locator(".settingsPanel").getByRole("button", { name: "View guide" }).click();
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
  await expect(page).toHaveURL(/\/docs\/preferences$/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await expect(page.locator(".docsArticle")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings\/preferences$/);
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
    data: { goal: `E2E history cleanup ${suffix}`, title: `History ${suffix}` },
    headers: sessionHeaders
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

  await page.getByRole("button", { name: /Curator/ }).click();
  await expect(page.getByRole("heading", { name: "Skill Curator" })).toBeVisible();
  await page.getByRole("button", { name: "Extract suggestions" }).click();
  await expect(page.locator(".curatorPanel")).toContainText("Review queue");

  await openNavItem(page, /History/);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await page.getByLabel("Search history").fill(`History ${suffix}`);
  const historyRow = page.locator(".historyRow").filter({ hasText: `History ${suffix}` });
  await expect(historyRow).toBeVisible();
  await historyRow.getByLabel(new RegExp(`Delete History ${suffix}`)).click();
  await expect(historyRow).toHaveCount(0);
  expect((await request.get(`${apiBase}/api/tasks/${task.id}`, { headers: sessionHeaders })).status()).toBe(404);

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

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    )
  );
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
