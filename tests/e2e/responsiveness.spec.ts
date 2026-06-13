import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { apiBase, bootstrapSession, currentSourceFingerprint, horizontalOverflow, submitInput } from "./helpers.js";

const RESPONSE_BUDGET_MS = 2_000;
const TOOL_RESULT_BUDGET_MS = 5_000;
const ROUTE_SOAK_BUDGET_MS = 2_500;

test.beforeEach(async ({ request }) => {
  await bootstrapSession(request);
});

test("core UI routes respond promptly and keep fixed chrome readable", async ({ page, request }, testInfo) => {
  const headers = await bootstrapSession(request);
  const failures: string[] = [];
  const timings: Array<{ label: string; elapsedMs: number; overflow: number }> = [];
  const consoleIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  await page.goto("/tasks/new");
  await expect(page.getByLabel("Task input")).toBeVisible();
  await assertBrandFits(page);

  await measureInteraction(page, timings, "open support dialog", async () => {
    await openUtilityItem(page, /Support/);
  }, async () => {
    await expect(page.getByRole("dialog", { name: "Need a hand?" })).toBeVisible();
  });

  await measureInteraction(page, timings, "support docs navigation", async () => {
    await page.getByRole("button", { name: "Open Docs" }).click();
  }, async () => {
    await expect(page.locator(".docsView")).toBeVisible();
    await expect(page.locator(".docsArticle")).toBeVisible();
  });

  await measureInteraction(page, timings, "docs back navigation", async () => {
    await page.getByRole("button", { name: "Back" }).click();
  }, async () => {
    await expect(page.getByLabel("Task input")).toBeVisible();
  });

  await measureInteraction(page, timings, "library navigation", async () => {
    await openNavItem(page, /Library/);
  }, async () => {
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  });

  await measureInteraction(page, timings, "settings navigation", async () => {
    await openUtilityItem(page, /Settings/);
  }, async () => {
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Model configuration" })).toBeVisible();
  });

  const longProviderLabel = `CustomProvider${"NameWithoutNaturalBreaks".repeat(5)}`;
  const longProviderResponse = await request.post(`${apiBase}/api/model-providers`, {
    headers,
    data: {
      vendor: "custom",
      label: longProviderLabel,
      protocol: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "e2e-long-provider-secret",
      models: [{ id: "custom-long-provider-model", label: "custom-long-provider-model", contextWindow: 128000, supportsTools: true, supportsThinking: true }],
      defaultModelId: "custom-long-provider-model",
      enabled: false,
      makeActive: false
    }
  });
  expect(longProviderResponse.status()).toBe(201);

  await measureInteraction(page, timings, "long provider row rendering", async () => {
    await page.goto("/settings/providers");
  }, async () => {
    await expect(page.locator(".providerRow").filter({ hasText: longProviderLabel }).first()).toBeVisible();
  });

  const longTaskTitle = `Long route ${"TitleWithoutNaturalBreaks".repeat(5)}`;
  const longTaskGoal = `Inspect this long-task display path ${"GOAL-WITHOUT-NATURAL-BREAKS".repeat(8)}`;
  const longTaskResponse = await request.post(`${apiBase}/api/tasks`, {
    headers,
    data: {
      goal: longTaskGoal,
      title: longTaskTitle
    }
  });
  expect(longTaskResponse.status()).toBe(201);
  const longTask = await longTaskResponse.json() as { id: string };

  await measureInteraction(page, timings, "long task thread rendering", async () => {
    await page.goto(`/tasks/${longTask.id}`);
  }, async () => {
    await expect(page.getByRole("heading", { name: longTaskTitle })).toBeVisible();
    await expect(page.getByLabel("Task input")).toBeVisible();
  });

  for (const item of timings) {
    if (item.elapsedMs > RESPONSE_BUDGET_MS) failures.push(`${item.label} took ${item.elapsedMs}ms`);
    if (item.overflow > 1) failures.push(`${item.label} caused ${item.overflow}px horizontal overflow`);
  }

  await persistResponsivenessReport({
    project: testInfo.project.name,
    route: page.url(),
    responseBudgetMs: RESPONSE_BUDGET_MS,
    timings,
    consoleIssues,
    failures
  });

  expect(consoleIssues, "route interactions should not emit console errors or warnings").toEqual([]);
  expect(failures).toEqual([]);
});

test("task timeline updates live without freezing interaction or motion affordances", async ({ page }, testInfo) => {
  const consoleIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  await page.goto("/tasks/new");
  const input = page.getByLabel("Task input");
  await expect(input).toBeVisible();
  await input.fill("Show current host processes and summarize the busiest ones.");
  await submitInput(page);

  const approvalStartedAt = Date.now();
  const approval = page.locator(".approvalCard");
  await expect(approval.getByText("host observation")).toBeVisible();
  const approvalLatencyMs = Date.now() - approvalStartedAt;
  const approvalMotion = await timelineMotionMetrics(page, approval);
  expect(approvalMotion.usesReducedMotion || approvalMotion.animationName.includes("timelineCardIn")).toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  const toolStartedAt = Date.now();
  await approval.getByText("Allow for this task").click();
  const toolResult = page.locator(".event.tool_result").first();
  await expect(toolResult).toBeVisible();
  const toolResultLatencyMs = Date.now() - toolStartedAt;

  const collapsedHeight = await toolDetailsHeight(page);
  await page.locator(".toolResultSummary").first().click();
  await expect(page.locator(".toolResultDetails.open").first()).toBeVisible();
  await expect.poll(async () => toolDetailsHeight(page)).toBeGreaterThan(collapsedHeight);
  const expandedHeight = await toolDetailsHeight(page);
  const toolTransition = await toolBodyTransitionMetrics(page);

  await input.fill("ui remains responsive after realtime tool evidence");
  await expect(input).toHaveValue("ui remains responsive after realtime tool evidence");
  await expect(page.locator(".composerPrimaryButton")).toBeEnabled();
  const frameLatencyMs = await twoFrameLatency(page);
  const overflow = await horizontalOverflow(page);
  const failures = [
    approvalLatencyMs > 3_000 ? `approval card took ${approvalLatencyMs}ms` : "",
    toolResultLatencyMs > TOOL_RESULT_BUDGET_MS ? `tool result took ${toolResultLatencyMs}ms` : "",
    expandedHeight <= collapsedHeight ? "tool result expansion did not increase measured height" : "",
    toolTransition.hasTransition ? "" : "tool result expansion has no transition",
    frameLatencyMs > 500 ? `post-result frame latency was ${frameLatencyMs}ms` : "",
    overflow > 1 ? `task timeline caused ${overflow}px horizontal overflow` : ""
  ].filter(Boolean);

  await persistRealtimeUxReport({
    project: testInfo.project.name,
    route: page.url(),
    approvalLatencyMs,
    toolResultLatencyMs,
    collapsedHeight,
    expandedHeight,
    frameLatencyMs,
    overflow,
    approvalMotion,
    toolTransition,
    consoleIssues,
    failures
  });

  expect(consoleIssues, "live timeline flow should not emit console errors or warnings").toEqual([]);
  expect(failures).toEqual([]);
});

test("docs navigation collapses to a hamburger drawer on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto("/docs/search");
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open docs navigation" })).toBeVisible();
  await expect(page.locator(".docsArticle")).toBeVisible();

  const toc = page.locator("#docs-toc");
  await expect.poll(async () => docsTocLayout(page)).toMatchObject({
    position: "fixed"
  });
  const closedLayout = await docsTocLayout(page);
  expect(closedLayout.left).toBeLessThan(-20);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Open docs navigation" }).click();
  await expect.poll(async () => docsTocLayout(page).then((layout) => layout.left)).toBeGreaterThanOrEqual(0);
  await expect(toc.getByLabel("Search docs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close docs navigation" })).toBeVisible();

  await page.getByRole("button", { name: "Close docs navigation" }).click();
  await expect.poll(async () => docsTocLayout(page).then((layout) => layout.left)).toBeLessThan(-20);
});

test("primary routes survive repeated navigation soak without stale UI state", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const consoleIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  const routeChecks: Array<{
    path: string;
    label: string;
    ready: () => Promise<void>;
  }> = [
    {
      path: "/tasks/new",
      label: "new task",
      ready: async () => {
        await expect(page.getByLabel("Task input")).toBeVisible();
      }
    },
    {
      path: "/library/skills",
      label: "library skills",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
      }
    },
    {
      path: "/library/knowledge",
      label: "library knowledge",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
      }
    },
    {
      path: "/library/curator",
      label: "skill curator",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Skill Curator" })).toBeVisible();
      }
    },
    {
      path: "/settings/providers",
      label: "settings providers",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Model configuration" })).toBeVisible();
      }
    },
    {
      path: "/settings/mcp",
      label: "settings mcp",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
      }
    },
    {
      path: "/docs",
      label: "docs",
      ready: async () => {
        await expect(page.locator(".docsView")).toBeVisible();
        await expect(page.locator(".docsArticle")).toBeVisible();
      }
    },
    {
      path: "/history",
      label: "history",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
        await expect(page.getByLabel("Search history")).toBeVisible();
      }
    }
  ];

  const cycles = 4;
  const timings: Array<{ cycle: number; label: string; path: string; elapsedMs: number; overflow: number; textLength: number }> = [];
  const failures: string[] = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const route of routeChecks) {
      const startedAt = Date.now();
      await page.goto(route.path);
      await route.ready();
      const elapsedMs = Date.now() - startedAt;
      const routeHealth = await routeHealthMetrics(page);
      timings.push({ cycle, label: route.label, path: route.path, elapsedMs, ...routeHealth });
      if (elapsedMs > ROUTE_SOAK_BUDGET_MS) failures.push(`${route.label} cycle ${cycle} took ${elapsedMs}ms`);
      if (routeHealth.overflow > 1) failures.push(`${route.label} cycle ${cycle} caused ${routeHealth.overflow}px horizontal overflow`);
      if (routeHealth.textLength < 80) failures.push(`${route.label} cycle ${cycle} rendered suspiciously little text`);
    }
  }

  await page.goto("/tasks/new");
  await expect(page.getByLabel("Task input")).toBeVisible();
  await page.getByLabel("Task input").fill("route soak final input remains editable");
  await expect(page.getByLabel("Task input")).toHaveValue("route soak final input remains editable");

  await persistRouteSoakReport({
    project: testInfo.project.name,
    cycles,
    routeBudgetMs: ROUTE_SOAK_BUDGET_MS,
    timings,
    consoleIssues,
    failures
  });

  expect(consoleIssues, "route soak should not emit console errors or warnings").toEqual([]);
  expect(failures).toEqual([]);
});

async function docsTocLayout(page: import("@playwright/test").Page): Promise<{ left: number; position: string; width: number }> {
  return page.locator("#docs-toc").evaluate((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      left: Math.round(rect.left),
      position: style.position,
      width: Math.round(rect.width)
    };
  });
}

async function measureInteraction(
  page: import("@playwright/test").Page,
  timings: Array<{ label: string; elapsedMs: number; overflow: number }>,
  label: string,
  action: () => Promise<void>,
  ready: () => Promise<void>
): Promise<void> {
  const started = Date.now();
  await action();
  await ready();
  timings.push({
    label,
    elapsedMs: Date.now() - started,
    overflow: await horizontalOverflow(page)
  });
}

async function assertBrandFits(page: import("@playwright/test").Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) return;
  const metrics = await page.locator(".brandCopy strong").evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    text: node.textContent ?? ""
  }));
  expect(metrics.scrollWidth, `${metrics.text} should fit in the default sidebar`).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function openNavItem(page: import("@playwright/test").Page, name: string | RegExp): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 760) {
    await page.getByRole("button", { name: /Tasks/ }).click();
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

async function persistResponsivenessReport(report: {
  project: string;
  route: string;
  responseBudgetMs: number;
  timings: Array<{ label: string; elapsedMs: number; overflow: number }>;
  consoleIssues: string[];
  failures: string[];
}): Promise<void> {
  const reportPath = resolve(process.cwd(), "data", "test-reports", "ui-responsiveness", `${report.project}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), sourceFingerprint: await currentSourceFingerprint(), ...report }, null, 2), "utf8");
}

async function timelineMotionMetrics(
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator
): Promise<{ animationName: string; animationDuration: string; usesReducedMotion: boolean }> {
  return locator.evaluate((node) => {
    const shell = node.closest(".timelineItemShell") as HTMLElement | null;
    const style = shell ? getComputedStyle(shell) : null;
    return {
      animationName: style?.animationName ?? "",
      animationDuration: style?.animationDuration ?? "",
      usesReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };
  });
}

async function toolDetailsHeight(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".toolResultDetails").first().evaluate((node) => node.getBoundingClientRect().height);
}

async function toolBodyTransitionMetrics(page: import("@playwright/test").Page): Promise<{
  transitionDuration: string;
  transitionProperty: string;
  hasTransition: boolean;
}> {
  return page.locator(".toolResultBodyShell").first().evaluate((node) => {
    const style = getComputedStyle(node);
    const durations = style.transitionDuration
      .split(",")
      .map((part) => Number.parseFloat(part.trim()))
      .filter((value) => Number.isFinite(value));
    return {
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
      hasTransition: durations.some((value) => value > 0)
    };
  });
}

async function twoFrameLatency(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() =>
    new Promise<number>((resolve) => {
      const startedAt = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve(Math.round(performance.now() - startedAt));
        });
      });
    })
  );
}

async function routeHealthMetrics(page: import("@playwright/test").Page): Promise<{ overflow: number; textLength: number }> {
  return page.evaluate(() => ({
    overflow: Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    ),
    textLength: (document.body.textContent ?? "").trim().length
  }));
}

async function persistRouteSoakReport(report: {
  project: string;
  cycles: number;
  routeBudgetMs: number;
  timings: Array<{ cycle: number; label: string; path: string; elapsedMs: number; overflow: number; textLength: number }>;
  consoleIssues: string[];
  failures: string[];
}): Promise<void> {
  const reportPath = resolve(process.cwd(), "data", "test-reports", "ui-route-soak", `${report.project}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), sourceFingerprint: await currentSourceFingerprint(), ...report }, null, 2), "utf8");
}

async function persistRealtimeUxReport(report: {
  project: string;
  route: string;
  approvalLatencyMs: number;
  toolResultLatencyMs: number;
  collapsedHeight: number;
  expandedHeight: number;
  frameLatencyMs: number;
  overflow: number;
  approvalMotion: { animationName: string; animationDuration: string; usesReducedMotion: boolean };
  toolTransition: { transitionDuration: string; transitionProperty: string; hasTransition: boolean };
  consoleIssues: string[];
  failures: string[];
}): Promise<void> {
  const reportPath = resolve(process.cwd(), "data", "test-reports", "task-realtime-ux", `${report.project}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), sourceFingerprint: await currentSourceFingerprint(), ...report }, null, 2), "utf8");
}
