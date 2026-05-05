import { BookOpen, Cpu, Shield, Zap, Layers, MessageSquare, Settings, HelpCircle } from "lucide-react";
import type { ComponentType } from "react";

export type DocsSection =
  | "overview"
  | "input"
  | "task-management"
  | "providers"
  | "permissions"
  | "mcp"
  | "settings"
  | "troubleshooting";

export interface DocMeta {
  id: DocsSection;
  title: Record<string, string>;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export const docMetas: DocMeta[] = [
  { id: "overview", title: { en: "SCC Workbench", zh: "SCC Workbench" }, icon: BookOpen },
  { id: "input", title: { en: "Input Methods", zh: "输入方式" }, icon: MessageSquare },
  { id: "task-management", title: { en: "Task Management", zh: "任务管理" }, icon: Zap },
  { id: "providers", title: { en: "Model Providers", zh: "模型服务商" }, icon: Cpu },
  { id: "permissions", title: { en: "Permissions", zh: "权限" }, icon: Shield },
  { id: "mcp", title: { en: "MCP", zh: "MCP" }, icon: Layers },
  { id: "settings", title: { en: "Settings", zh: "设置" }, icon: Settings },
  { id: "troubleshooting", title: { en: "Troubleshooting", zh: "故障排除" }, icon: HelpCircle }
];

export function getDocTitle(meta: DocMeta, language: string | null | undefined): string {
  const lang = language === "zh" || language === "zh-CN" ? "zh" : "en";
  return meta.title[lang] ?? meta.title.en ?? "";
}

const docModules = import.meta.glob<string>("./**/*.md", { query: "?raw", import: "default" });

export async function loadDocContent(id: DocsSection, language: string | null | undefined): Promise<string> {
  const lang = language === "zh" || language === "zh-CN" ? "zh" : "en";
  const path = `./${lang}/${id}.md`;
  const loader = docModules[path];
  if (!loader) {
    const fallback = docModules[`./en/${id}.md`];
    if (!fallback) return `# ${id}\n\nContent not found.`;
    return (await fallback()) as string;
  }
  return (await loader()) as string;
}
