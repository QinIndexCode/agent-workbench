import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

export const apiBase = "http://127.0.0.1:5181";
export const SESSION_HEADER = "x-scc-session";
export const riskCategories = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"] as const;

export async function bootstrapSession(request: APIRequestContext): Promise<Record<string, string>> {
  const bootstrap = await request.get(`${apiBase}/api/session/bootstrap`);
  const { sessionToken } = await bootstrap.json();
  const headers = { [SESSION_HEADER]: sessionToken };
  for (const risk of riskCategories) {
    await request.delete(`${apiBase}/api/permissions/global/${risk}`, { headers });
  }
  await request.patch(`${apiBase}/api/preferences`, {
    data: { language: "en-US", theme: "dark" },
    headers
  });
  return headers;
}

export async function openNavItem(page: Page, name: string | RegExp): Promise<void> {
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

export async function submitInput(page: Page): Promise<void> {
  await page.getByLabel("Task input").press("Enter");
  const useLocalTitle = page.getByRole("button", { name: "Use local title" });
  try {
    await useLocalTitle.waitFor({ state: "visible", timeout: 2_000 });
    await useLocalTitle.click();
  } catch {
    // A configured provider generated a title without requiring the local fallback.
  }
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    )
  );
}

export async function persistFlagshipMetric(metric: {
  project: string;
  view: string;
  horizontalOverflow: number;
  route: string;
  screenshotPath: string;
}): Promise<void> {
  const metricsPath = resolve(process.cwd(), "data", "test-reports", "flagship-ui", "metrics.json");
  mkdirSync(dirname(metricsPath), { recursive: true });
  const existing = readJson(metricsPath) ?? { generatedAt: new Date().toISOString(), views: [] as typeof metric[] };
  const views = existing.views.filter((item: typeof metric) => !(item.project === metric.project && item.view === metric.view));
  views.push(metric);
  views.sort((left: typeof metric, right: typeof metric) => `${left.project}/${left.view}`.localeCompare(`${right.project}/${right.view}`));
  existing.generatedAt = new Date().toISOString();
  existing.views = views;
  writeFileSync(metricsPath, JSON.stringify(existing, null, 2), "utf8");
}

export function screenshotPath(project: string, view: string): string {
  const dir = resolve(process.cwd(), "data", "test-reports", "flagship-ui", "screenshots");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${project}-${view}.png`);
}

function readJson(filePath: string): { generatedAt: string; views: Array<{ project: string; view: string; horizontalOverflow: number; route: string; screenshotPath: string }> } | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
