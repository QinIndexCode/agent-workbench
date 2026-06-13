import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { bootstrapSession, horizontalOverflow } from "./helpers.js";

test.beforeEach(async ({ request }) => {
  await bootstrapSession(request);
});

const routes: Array<{
  name: string;
  path: string;
  ready: (page: Page) => Promise<void>;
}> = [
  {
    name: "tasks",
    path: "/tasks/new",
    ready: async (page) => {
      await expect(page.getByLabel("Task input")).toBeVisible();
    }
  },
  {
    name: "history",
    path: "/history",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    }
  },
  {
    name: "library",
    path: "/library/memory",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
    }
  },
  {
    name: "settings",
    path: "/settings/providers",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    }
  },
  {
    name: "docs",
    path: "/docs/settings",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
    }
  }
];

for (const route of routes) {
  test(`core workbench ${route.name} surface passes accessibility checks`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(route.path);
    await route.ready(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "best-practice"])
      .analyze();
    expect(formatViolations(route.name, results.violations), formatViolations(route.name, results.violations).join("\n\n")).toEqual([]);
  });
}

function formatViolations(routeName: string, violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string[] {
  return violations.map(
    (violation) =>
      `${routeName}: ${violation.id} - ${violation.help}\n${violation.nodes
        .map((node) => `  ${node.target.join(" ")} :: ${node.failureSummary ?? node.html}`)
        .join("\n")}`
  );
}
