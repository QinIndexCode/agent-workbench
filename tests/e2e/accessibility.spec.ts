import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { bootstrapSession, horizontalOverflow } from "./helpers.js";

test.beforeEach(async ({ request }) => {
  await bootstrapSession(request);
});

test("core workbench surfaces pass accessibility checks", async ({ page }) => {
  const failures: string[] = [];
  const routes: Array<{
    name: string;
    path: string;
    ready: () => Promise<void>;
  }> = [
    {
      name: "tasks",
      path: "/tasks/new",
      ready: async () => {
        await expect(page.getByLabel("Task input")).toBeVisible();
      }
    },
    {
      name: "history",
      path: "/history",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
      }
    },
    {
      name: "library",
      path: "/library/memory",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
      }
    },
    {
      name: "settings",
      path: "/settings/providers",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      }
    },
    {
      name: "docs",
      path: "/docs/settings",
      ready: async () => {
        await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
      }
    }
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await route.ready();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "best-practice"])
      .analyze();
    for (const violation of results.violations) {
      failures.push(
        `${route.name}: ${violation.id} - ${violation.help}\n${violation.nodes
          .map((node) => `  ${node.target.join(" ")} :: ${node.failureSummary ?? node.html}`)
          .join("\n")}`
      );
    }
  }

  expect(failures, failures.join("\n\n")).toEqual([]);
});
