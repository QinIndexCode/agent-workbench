import { useEffect, useState } from "react";
import type { LibrarySection } from "./components/LibraryView.js";
import type { SettingsSection } from "./components/SettingsView.js";
import type { DocsSection } from "./docs/index.js";

export type ActiveView = "tasks" | "history" | "library" | "docs" | "settings";

export type AppRoute =
  | { view: "tasks"; taskId?: string; newTask?: boolean }
  | { view: "history" }
  | { view: "library"; section: LibrarySection }
  | { view: "settings"; section: SettingsSection }
  | { view: "docs"; section: DocsSection };

const librarySections = new Set<LibrarySection>(["skills", "curator", "knowledge", "memory"]);
const settingsSections = new Set<SettingsSection>(["providers", "permissions", "mcp", "integrations", "scheduled", "search", "preferences"]);
const docsSections = new Set<DocsSection>([
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
  "protocols",
  "integrations",
  "scheduled",
  "search",
  "preferences",
  "troubleshooting"
]);

export function useAppRoute(): [AppRoute, (route: AppRoute, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseAppRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(next: AppRoute, options: { replace?: boolean } = {}) {
    const path = routeToPath(next);
    if (path !== window.location.pathname) {
      if (options.replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
    setRoute(next);
  }

  return [route, navigate];
}

export function routeToPath(route: AppRoute): string {
  if (route.view === "tasks") {
    if (route.newTask) return "/tasks/new";
    return route.taskId ? `/tasks/${encodeURIComponent(route.taskId)}` : "/tasks";
  }
  if (route.view === "library") return `/library/${route.section}`;
  if (route.view === "settings") return `/settings/${route.section}`;
  if (route.view === "docs") return `/docs/${route.section}`;
  return "/history";
}

function parseAppRoute(pathname: string): AppRoute {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [root, value] = parts;
  if (!root || root === "tasks") {
    if (value === "new") return { view: "tasks", newTask: true };
    return value ? { view: "tasks", taskId: value } : { view: "tasks" };
  }
  if (root === "history") return { view: "history" };
  if (root === "library") {
    if (value === "reflections") return { view: "library", section: "curator" };
    return { view: "library", section: librarySections.has(value as LibrarySection) ? value as LibrarySection : "skills" };
  }
  if (root === "settings") return { view: "settings", section: settingsSections.has(value as SettingsSection) ? value as SettingsSection : "providers" };
  if (root === "docs") {
    if (value === "reflections") return { view: "docs", section: "curator" };
    return { view: "docs", section: docsSections.has(value as DocsSection) ? value as DocsSection : "overview" };
  }
  return { view: "tasks" };
}
