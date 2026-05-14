import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function findWorkspaceRoot(): string {
  const configured = process.env["AGENT_WORKBENCH_WORKSPACE_ROOT"] ?? process.env["SCC_WORKSPACE_ROOT"];
  if (configured?.trim()) return resolve(configured);

  let current = process.cwd();
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        if (Array.isArray(parsed["workspaces"])) return current;
      } catch {
        // Keep walking; a malformed package file should not hide a valid parent workspace.
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function defaultTaskWorkRoot(): string {
  const configured = process.env["AGENT_WORKBENCH_DEFAULT_TASK_ROOT"] ?? process.env["SCC_DEFAULT_TASK_ROOT"];
  const root = configured?.trim() ? resolve(configured) : resolve(findWorkspaceRoot(), "workspace", "default");
  mkdirSync(root, { recursive: true });
  return root;
}
