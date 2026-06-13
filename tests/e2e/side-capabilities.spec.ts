import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";
import { apiBase, bootstrapSession, horizontalOverflow, SESSION_HEADER } from "./helpers.js";

const settingsSections = [
  { path: "/settings/providers", nav: "Model configuration", heading: "Model configuration" },
  { path: "/settings/permissions", nav: "Permissions", heading: "Permissions" },
  { path: "/settings/mcp", nav: "MCP", heading: "MCP" },
  { path: "/settings/integrations", nav: "Integrations", heading: "Integrations" },
  { path: "/settings/scheduled", nav: "Scheduled tasks", heading: "Scheduled tasks" },
  { path: "/settings/search", nav: "Web search", heading: "Web search" },
  { path: "/settings/preferences", nav: "Preferences", heading: "Agent preferences" }
] as const;

const librarySections = [
  { path: "/library/skills", nav: "Skills", heading: "Skills" },
  { path: "/library/curator", nav: "Curator", heading: "Skill Curator" },
  { path: "/library/knowledge", nav: "Knowledge", heading: "Knowledge" },
  { path: "/library/memory", nav: "Memory", heading: "Memory" }
] as const;

const docsSections = [
  "overview",
  "input",
  "task-management",
  "settings",
  "library",
  "skills",
  "curator",
  "knowledge",
  "memory",
  "providers",
  "permissions",
  "mcp",
  "integrations",
  "scheduled",
  "search",
  "preferences",
  "troubleshooting"
] as const;

test.beforeEach(async ({ request }) => {
  await bootstrapSession(request);
});

test("side capability routes are directly loadable, navigable, reloadable, and responsive", async ({ page }) => {
  test.setTimeout(90_000);

  for (const section of settingsSections) {
    await page.goto(section.path);
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
    await expect(page.locator(".settingsNav").getByRole("button", { name: section.nav, exact: true })).toHaveAttribute("class", /selected/);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
  }

  await page.goto("/settings/providers");
  for (const section of settingsSections.slice(1)) {
    await page.locator(".settingsNav").getByRole("button", { name: section.nav, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  }

  for (const section of librarySections) {
    await page.goto(section.path);
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
    await expect(page.locator(".libraryNav").getByRole("button", { name: section.nav, exact: true })).toHaveAttribute("class", /selected/);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
  }

  await page.goto("/library/skills");
  for (const section of librarySections.slice(1)) {
    await page.locator(".libraryNav").getByRole("button", { name: section.nav, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${section.path}$`));
    await expect(page.getByRole("heading", { name: section.heading, exact: true })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  }

  for (const section of docsSections) {
    await page.goto(`/docs/${section}`);
    await expect(page).toHaveURL(new RegExp(`/docs/${section}$`));
    await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible();
    await expect(page.locator(".docsArticle")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  }
});

test("side capability secret fields are masked in settings forms", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/settings/integrations");
  await page.locator(".settingsPanel .panelHero").getByRole("button", { name: "Add integration", exact: true }).click();
  const integrationDialog = page.locator('form[aria-label="Add integration"]');
  await expect(integrationDialog).toBeVisible();
  await expect(integrationDialog.getByLabel("Bot token")).toHaveAttribute("type", "password");
  await expect(integrationDialog.getByLabel("Public key")).toHaveAttribute("type", "text");
  await integrationDialog.getByRole("button", { name: "Provider", exact: true }).click();
  await page.getByRole("option", { name: /Slack/ }).click();
  await expect(integrationDialog.getByLabel("Signing secret")).toHaveAttribute("type", "password");
  await integrationDialog.getByRole("button", { name: "×" }).click();

  await page.goto("/settings/search");
  await page.locator(".settingsPanel .panelHero").getByRole("button", { name: "Add", exact: true }).click();
  const searchDialog = page.locator('form[aria-label="Add search provider"]');
  await expect(searchDialog).toBeVisible();
  await searchDialog.getByRole("button", { name: "Select search provider kind", exact: true }).click();
  await page.getByRole("option", { name: /Brave/ }).click();
  await expect(searchDialog.getByLabel("API key")).toHaveAttribute("type", "password");
});

test("side capability legacy and invalid routes fall back to usable panels", async ({ page }) => {
  test.setTimeout(45_000);

  await page.goto("/settings/not-a-real-panel");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model configuration", exact: true })).toBeVisible();
  await expect(page.locator(".settingsNav").getByRole("button", { name: "Model configuration", exact: true })).toHaveAttribute("class", /selected/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.goto("/library/reflections");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill Curator", exact: true })).toBeVisible();
  await expect(page.locator(".libraryNav").getByRole("button", { name: "Curator", exact: true })).toHaveAttribute("class", /selected/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.goto("/docs/reflections");
  await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible();
  await expect(page.locator(".docsArticle")).toBeVisible();
  await expect(page.locator(".docsToc").getByRole("button", { name: "Curator", exact: true })).toHaveAttribute("class", /selected/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("side library capabilities support filtering, export, reindex, search, and bulk cleanup", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const headers = await bootstrapSession(request);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const skillActiveTitle = `Side Active ${suffix}`;
  const skillCandidateTitle = `Side Candidate ${suffix}`;
  const knowledgeTitle = `Side Primary Knowledge ${suffix}`;
  const knowledgeSecondTitle = `Side Extra Knowledge ${suffix}`;
  const beacon = `side-capability-beacon-${suffix}`;

  const activeSkill = await createSkill(request, headers, skillActiveTitle, "active", ["side-capability", suffix]);
  const candidateSkill = await createSkill(request, headers, skillCandidateTitle, "candidate", ["side-capability", suffix]);
  const knowledge = await createKnowledge(request, headers, knowledgeTitle, `${beacon} verifies side knowledge search and reindex.`);
  const secondKnowledge = await createKnowledge(request, headers, knowledgeSecondTitle, `secondary ${beacon} item for batch cleanup.`);

  await page.goto("/library/skills");
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await page.getByLabel("Search skills").fill(suffix);
  await expect(page.locator(".skillListRow").filter({ hasText: skillActiveTitle })).toBeVisible();
  await expect(page.locator(".skillListRow").filter({ hasText: skillCandidateTitle })).toBeVisible();

  await page.getByRole("button", { name: "Filter Skill status", exact: true }).click();
  await page.getByRole("option", { name: "active", exact: true }).click();
  await expect(page.locator(".skillListRow").filter({ hasText: skillActiveTitle })).toBeVisible();
  await expect(page.locator(".skillListRow").filter({ hasText: skillCandidateTitle })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.locator(".skillListRow").filter({ hasText: skillActiveTitle }).getByLabel(`Export ${skillActiveTitle}`).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(activeSkill.id);

  await page.getByRole("button", { name: "Filter Skill status", exact: true }).click();
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await page.getByLabel(`Select ${skillActiveTitle}`).check();
  await page.getByLabel(`Select ${skillCandidateTitle}`).check();
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await expect(page.locator(".skillListRow").filter({ hasText: skillActiveTitle })).toHaveCount(0);
  await expect(page.locator(".skillListRow").filter({ hasText: skillCandidateTitle })).toHaveCount(0);
  await expect.poll(async () => (await request.get(`${apiBase}/api/skills/${activeSkill.id}`, { headers })).status()).toBe(404);
  await expect.poll(async () => (await request.get(`${apiBase}/api/skills/${candidateSkill.id}`, { headers })).status()).toBe(404);

  await page.goto("/library/knowledge");
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  await page.getByLabel("Search knowledge").fill(suffix);
  const knowledgeRow = page.locator(".knowledgeRow").filter({ hasText: knowledgeTitle });
  const secondKnowledgeRow = page.locator(".knowledgeRow").filter({ hasText: knowledgeSecondTitle });
  await expect(knowledgeRow).toBeVisible();
  await expect(secondKnowledgeRow).toBeVisible();

  await knowledgeRow.locator(".knowledgeRowMain").click();
  await page.getByLabel(`Reindex ${knowledgeTitle}`).click();
  await expect.poll(async () => {
    const items = await (await request.get(`${apiBase}/api/knowledge`, { headers })).json();
    const item = items.find((entry: { id: string }) => entry.id === knowledge.id);
    return `${item?.indexStatus}:${item?.chunkCount}`;
  }).toMatch(/^indexed:[1-9]/);

  await page.getByLabel("Search test").fill(beacon);
  await page.locator(".inlineSearchForm").getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".knowledgeSearchResult").filter({ hasText: knowledgeTitle })).toBeVisible();

  await page.getByLabel(`Select item ${knowledgeTitle}`).check();
  await page.getByLabel(`Select item ${knowledgeSecondTitle}`).check();
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete selected", exact: true }).click();
  await expect(knowledgeRow).toHaveCount(0);
  await expect(secondKnowledgeRow).toHaveCount(0);
  await expect.poll(async () => (await request.get(`${apiBase}/api/knowledge/${knowledge.id}`, { headers })).status()).toBe(404);
  await expect.poll(async () => (await request.get(`${apiBase}/api/knowledge/${secondKnowledge.id}`, { headers })).status()).toBe(404);
});

test("skill curator supports activation and suspension from review queue", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const headers = await bootstrapSession(request);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const candidateTitle = `Curator Candidate ${suffix}`;
  const activeTitle = `Curator Active ${suffix}`;

  const candidate = await createSkill(request, headers, candidateTitle, "candidate", ["curator", "candidate", suffix]);
  const active = await createSkill(request, headers, activeTitle, "active", ["curator", "active", suffix]);

  await page.goto("/library/curator");
  await expect(page.getByRole("heading", { name: "Skill Curator", exact: true })).toBeVisible();

  const candidateRow = page.locator(".curatorRow").filter({ hasText: candidateTitle });
  await expect(candidateRow).toBeVisible();
  await candidateRow.getByLabel("Activate candidate skill").click();
  await expect.poll(async () => getSkillStatus(request, headers, candidate.id)).toBe("active");

  const activeRow = page.locator(".curatorRow").filter({ hasText: activeTitle });
  await expect(activeRow).toBeVisible();
  await activeRow.getByLabel("Suspend skill").click();
  await expect.poll(async () => getSkillStatus(request, headers, active.id)).toBe("suspended");

  await deleteSkillIfPresent(request, headers, candidate.id);
  await deleteSkillIfPresent(request, headers, active.id);
});

test("knowledge side panel supports file upload, typed filters, and model preferences", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const headers = await bootstrapSession(request);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const fileName = `knowledge-upload-${suffix}.md`;
  const beacon = `uploaded-knowledge-beacon-${suffix}`;

  await page.goto("/library/knowledge");
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from(`# Uploaded ${suffix}\n\n${beacon} verifies file upload and filter behavior.`, "utf8")
  });

  const uploadedRow = page.locator(".knowledgeRow").filter({ hasText: fileName });
  await expect(uploadedRow).toBeVisible();
  await expect(uploadedRow).toContainText("File");
  await page.getByLabel("Search knowledge").fill(suffix);
  await expect(uploadedRow).toBeVisible();

  await page.getByLabel("Filter by type").selectOption("memory");
  await expect(uploadedRow).toHaveCount(0);
  await page.getByLabel("Filter by type").selectOption("file");
  await expect(uploadedRow).toBeVisible();

  await expect.poll(async () => {
    const items = await (await request.get(`${apiBase}/api/knowledge`, { headers })).json();
    const item = items.find((entry: { fileName?: string }) => entry.fileName === fileName);
    return `${item?.indexStatus}:${item?.chunkCount ?? 0}`;
  }).toMatch(/^indexed:[1-9]/);
  await page.getByLabel("Filter by index status").selectOption("indexed");
  await expect(uploadedRow).toBeVisible();
  await page.getByLabel("Filter by index status").selectOption("failed");
  await expect(uploadedRow).toHaveCount(0);
  await page.getByLabel("Filter by index status").selectOption("all");

  await uploadedRow.locator(".knowledgeRowMain").click();
  await page.getByLabel("Search test").fill(beacon);
  await page.locator(".inlineSearchForm").getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".knowledgeSearchResult").filter({ hasText: fileName })).toBeVisible();

  await page.getByText("Local small models", { exact: true }).click();
  await expect(page.getByLabel("Model download URL")).toBeVisible();
  await expect(page.locator(".knowledgeModelDownload").getByRole("button", { name: "Download and configure", exact: true })).toBeDisabled();
  await page.getByLabel("Inject compact knowledge brief").click();
  await expect.poll(async () => (await (await request.get(`${apiBase}/api/preferences`, { headers })).json()).knowledgeActiveInjection).toBe(false);
  await page.getByLabel("Inject compact knowledge brief").click();
  await expect.poll(async () => (await (await request.get(`${apiBase}/api/preferences`, { headers })).json()).knowledgeActiveInjection).toBe(true);

  const uploaded = await findKnowledgeByFileName(request, headers, fileName);
  expect(uploaded?.id).toBeTruthy();
  await uploadedRow.getByLabel(`Delete ${fileName}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(uploadedRow).toHaveCount(0);
  await expect.poll(async () => (await request.get(`${apiBase}/api/knowledge/${uploaded!.id}`, { headers })).status()).toBe(404);
});

test("model provider side panel supports custom models, active switching, and fallback routing", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const headers = await bootstrapSession(request);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const primaryLabel = `Custom Primary ${suffix}`;
  const primaryModel = `custom-primary-${suffix}`;
  const fallbackLabel = `Custom Fallback ${suffix}`;
  const fallbackModel = `custom-fallback-${suffix}`;

  await page.goto("/settings/providers");
  await expect(page.getByRole("heading", { name: "Model configuration", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const providerDialog = page.locator('form[aria-label="Add model"]');
  await expect(providerDialog).toBeVisible();
  await providerDialog.getByLabel("Display name").fill(primaryLabel);
  await providerDialog.getByLabel("Base URL").fill("https://primary.example.test/v1");
  await providerDialog.getByRole("button", { name: "Model", exact: true }).click();
  await providerDialog.locator(".modelField").getByRole("option", { name: "Custom model Custom model", exact: true }).click();
  await providerDialog.getByRole("textbox", { name: "Custom model", exact: true }).fill(primaryModel);
  await providerDialog.getByLabel("Context window").fill("not-a-window");
  await expect(providerDialog.getByText(/Enter a context size like 128K/)).toBeVisible();
  await providerDialog.getByRole("button", { name: "128K", exact: true }).click();
  await expect(providerDialog.getByLabel("Context window")).toHaveValue("128K");
  await providerDialog.getByLabel("API Key").fill(`primary-key-${suffix}`);
  await providerDialog.getByRole("button", { name: "Save", exact: true }).click();
  const primaryRow = page.locator(".providerRow").filter({ hasText: primaryLabel });
  await expect(primaryRow).toBeVisible();
  await expect(primaryRow).toContainText(primaryModel);
  await expect(primaryRow).toContainText("Active");

  const fallback = await createModelProvider(request, headers, fallbackLabel, fallbackModel, false);
  await page.reload();
  const fallbackRow = page.locator(".providerRow").filter({ hasText: fallbackLabel });
  await expect(fallbackRow).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model routing", exact: true })).toBeVisible();
  await expect(page.locator(".modelRouteCard").filter({ hasText: fallbackLabel }).getByRole("button", { name: fallbackLabel, exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.locator(".modelRouteCard").filter({ hasText: fallbackLabel }).getByRole("button", { name: fallbackLabel, exact: true }).click();
  await expect.poll(async () => {
    const preferences = await (await request.get(`${apiBase}/api/preferences`, { headers })).json();
    return preferences.modelRoute?.fallbackProviderIds?.includes(fallback.id) ?? false;
  }).toBe(true);

  await fallbackRow.getByLabel(`Switch to ${fallbackModel}`).click();
  await expect(fallbackRow).toContainText("Active");
  await expect.poll(async () => (await (await request.get(`${apiBase}/api/preferences`, { headers })).json()).activeModelProviderId).toBe(fallback.id);

  await fallbackRow.getByLabel("Delete model").click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete model", exact: true }).click();
  await expect(fallbackRow).toHaveCount(0);
  await primaryRow.getByLabel("Delete model").click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete model", exact: true }).click();
  await expect(primaryRow).toHaveCount(0);
});

test("mcp side panel supports edit, targeted risk overrides, and connection failure feedback", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const headers = await bootstrapSession(request);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const initialLabel = `Side MCP ${suffix}`;
  const updatedLabel = `${initialLabel} Updated`;
  const toolName = `danger.echo.${suffix}`;

  await page.goto("/settings/mcp");
  await expect(page.getByRole("heading", { name: "MCP", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const addDialog = page.locator('form[aria-label="Add server"]');
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel("Server label").fill(initialLabel);
  await addDialog.getByRole("button", { name: "Transport", exact: true }).click();
  await page.getByRole("option", { name: "streamable http", exact: true }).click();
  await addDialog.getByLabel("URL").fill("http://127.0.0.1:59999/mcp");
  await addDialog.getByLabel("Tool risk override (optional)").fill(toolName);
  await addDialog.getByRole("button", { name: "Override risk", exact: true }).click();
  await page.getByRole("option", { name: "destructive", exact: true }).click();
  await addDialog.getByRole("button", { name: "Save", exact: true }).click();

  const initialRow = page.locator(".mcpServerListRow").filter({ hasText: initialLabel });
  await expect(initialRow).toBeVisible();
  await expect.poll(async () => {
    const servers = await (await request.get(`${apiBase}/api/mcp/servers`, { headers })).json();
    const server = servers.find((entry: { label?: string }) => entry.label === initialLabel);
    return server?.toolRiskOverrides?.[toolName];
  }).toBe("destructive");

  await initialRow.getByLabel(`Edit ${initialLabel}`).click();
  const editDialog = page.locator('form[aria-label="Edit server"]');
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Tool risk override (optional)")).toHaveValue(toolName);
  await expect(editDialog.getByRole("button", { name: "Override risk", exact: true })).toContainText("destructive");
  await editDialog.getByLabel("Server label").fill(updatedLabel);
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();

  const updatedRow = page.locator(".mcpServerListRow").filter({ hasText: updatedLabel });
  await expect(updatedRow).toBeVisible();
  await updatedRow.getByLabel("Connect server").click();
  await expect(updatedRow).toContainText("error", { timeout: 15_000 });
  await expect(updatedRow.locator(".dangerText")).toBeVisible();

  await updatedRow.getByLabel(`Delete ${updatedLabel}`).click();
  await page.locator(".confirmDialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(updatedRow).toHaveCount(0);
});

async function createSkill(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  title: string,
  status: "candidate" | "active",
  keywords: string[]
): Promise<{ id: string }> {
  const response = await request.post(`${apiBase}/api/skills`, {
    headers,
    data: {
      title,
      body: `# ${title}\nUse this reusable side capability fixture for UI validation.`,
      status,
      applicability: {
        description: "Side capability E2E validation skill",
        keywords,
        requiredTools: ["read_file"],
        requiredContext: ["side capability"],
        minConfidence: 0.7
      }
    }
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function getSkillStatus(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  skillId: string
): Promise<string> {
  const response = await request.get(`${apiBase}/api/skills/${skillId}`, { headers });
  if (response.status() !== 200) return `missing:${response.status()}`;
  const skill = await response.json();
  return String(skill.status);
}

async function deleteSkillIfPresent(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  skillId: string
): Promise<void> {
  await request.delete(`${apiBase}/api/skills/${skillId}`, { headers });
}

async function createKnowledge(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  title: string,
  content: string
): Promise<{ id: string }> {
  const response = await request.post(`${apiBase}/api/knowledge`, {
    headers,
    data: {
      projectId: "default",
      kind: "memory",
      title,
      content,
      tags: ["side-capability"]
    }
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function findKnowledgeByFileName(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  fileName: string
): Promise<{ id: string } | undefined> {
  const response = await request.get(`${apiBase}/api/knowledge`, { headers });
  expect(response.status()).toBe(200);
  const items = await response.json();
  return items.find((entry: { id: string; fileName?: string }) => entry.fileName === fileName);
}

async function createModelProvider(
  request: import("@playwright/test").APIRequestContext,
  headers: Record<typeof SESSION_HEADER, string>,
  label: string,
  modelId: string,
  makeActive: boolean
): Promise<{ id: string }> {
  const response = await request.post(`${apiBase}/api/model-providers`, {
    headers,
    data: {
      vendor: "custom",
      label,
      protocol: "openai_compatible",
      baseUrl: "https://fallback.example.test/v1",
      apiKey: `key-${modelId}`,
      models: [
        {
          id: modelId,
          label: modelId,
          contextWindow: 65536,
          supportsTools: true,
          supportsThinking: false
        }
      ],
      defaultModelId: modelId,
      enabled: true,
      makeActive
    }
  });
  expect(response.status()).toBe(201);
  return response.json();
}
