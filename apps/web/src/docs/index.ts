import { BookOpen, BrainCircuit, Cpu, Database, HelpCircle, Layers, MessageSquare, Network, Settings, Shield, Sparkles, WandSparkles, Zap } from "lucide-react";
import type { ComponentType } from "react";

export type DocsSection =
  | "overview"
  | "input"
  | "task-management"
  | "settings"
  | "library"
  | "skills"
  | "curator"
  | "knowledge"
  | "memory"
  | "providers"
  | "permissions"
  | "mcp"
  | "protocols"
  | "integrations"
  | "scheduled"
  | "search"
  | "preferences"
  | "troubleshooting";

export interface DocMeta {
  id: DocsSection;
  title: Record<string, string>;
  summary: Record<string, string>;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export const docMetas: DocMeta[] = [
  {
    id: "overview",
    title: { en: "Agent Workbench", zh: "Agent Workbench" },
    summary: {
      en: "A quick orientation to tasks, context, approvals, and the main workbench loop.",
      zh: "快速了解任务、上下文、权限审批和整个工作台的主流程。"
    },
    icon: BookOpen
  },
  {
    id: "input",
    title: { en: "Input Methods", zh: "输入方式" },
    summary: {
      en: "How to start tasks, continue threads, attach files, and use voice or guidance modes.",
      zh: "说明如何发起任务、继续线程、附加文件，以及使用语音和引导模式。"
    },
    icon: MessageSquare
  },
  {
    id: "task-management",
    title: { en: "Task Management", zh: "任务管理" },
    summary: {
      en: "Covers folders, history, checkpoints, rollbacks, and how to recover from mistakes.",
      zh: "涵盖文件夹、历史记录、检查点、回滚，以及出现问题后的恢复方式。"
    },
    icon: Zap
  },
  {
    id: "settings",
    title: { en: "Settings Center", zh: "设置中心" },
    summary: {
      en: "Explains how the Settings center is organized and which page to visit first.",
      zh: "说明设置中心如何组织，以及第一次配置时应该先进入哪一页。"
    },
    icon: Settings
  },
  {
    id: "library",
    title: { en: "Library", zh: "资料库" },
    summary: {
      en: "How the Library is organized, which section to use first, and what belongs in each surface.",
      zh: "说明资料库如何组织、第一次应先看哪一页，以及每个分区适合存放什么内容。"
    },
    icon: BookOpen
  },
  {
    id: "skills",
    title: { en: "Skills", zh: "Skills" },
    summary: {
      en: "Review reusable skills, edit applicability, and understand when a skill should stay candidate-only.",
      zh: "查看可复用 Skill、编辑适用范围，并理解哪些 Skill 应该停留在候选状态。"
    },
    icon: Sparkles
  },
  {
    id: "curator",
    title: { en: "Curator", zh: "Curator" },
    summary: {
      en: "Audit why a memory was promoted, blocked, or grouped as a duplicate before you activate anything.",
      zh: "在启用前审查为什么某条记忆被推荐、被拦截，或被识别为重复。"
    },
    icon: WandSparkles
  },
  {
    id: "knowledge",
    title: { en: "Knowledge", zh: "知识库" },
    summary: {
      en: "Manage imported knowledge, search quality, and optional local retrieval assets without cluttering the main task flow.",
      zh: "管理导入知识、检索质量和可选本地模型资产，同时不干扰主任务流。"
    },
    icon: BrainCircuit
  },
  {
    id: "memory",
    title: { en: "Memory", zh: "记忆" },
    summary: {
      en: "Store durable user and project memory, compact it when needed, and keep it useful instead of noisy.",
      zh: "保存持久的用户与项目记忆，在需要时压缩，并保持它有用而不是噪音。"
    },
    icon: Database
  },
  {
    id: "providers",
    title: { en: "Model Providers", zh: "模型配置" },
    summary: {
      en: "Add model endpoints, switch the active provider, and manage fallback routing safely.",
      zh: "添加模型服务、切换当前模型来源，并安全地管理失败回退路由。"
    },
    icon: Cpu
  },
  {
    id: "permissions",
    title: { en: "Permissions", zh: "权限审批" },
    summary: {
      en: "Choose how tool calls are approved, which risks stay gated, and what auto-approval really changes.",
      zh: "选择工具调用如何审批、哪些风险始终受控，以及自动审批究竟会改变什么。"
    },
    icon: Shield
  },
  {
    id: "mcp",
    title: { en: "MCP", zh: "MCP" },
    summary: {
      en: "Connect external tool servers and understand discovery, approval, and risk overrides.",
      zh: "连接外部工具服务器，并理解工具发现、审批链和风险覆盖的作用范围。"
    },
    icon: Layers
  },
  {
    id: "protocols",
    title: { en: "Agent Protocols", zh: "Agent 通用协议" },
    summary: {
      en: "Understand MCP, A2A, Agent Card discovery, and which interoperability boundaries are implemented versus future-only.",
      zh: "理解 MCP、A2A、Agent Card discovery，以及哪些互操作边界已实现、哪些只是未来边界。"
    },
    icon: Network
  },
  {
    id: "integrations",
    title: { en: "Integrations", zh: "集成" },
    summary: {
      en: "Turn Discord, Feishu, Slack, Telegram, and WeCom messages into Agent Workbench tasks with provider-specific verification.",
      zh: "把 Discord、飞书、Slack、Telegram 和 WeCom 消息转换成 Agent Workbench 任务，并了解各平台的验签配置。"
    },
    icon: MessageSquare
  },
  {
    id: "scheduled",
    title: { en: "Scheduled Tasks", zh: "定时任务" },
    summary: {
      en: "Set repeat tasks, understand when they run, and manage the built-in Curator automation.",
      zh: "设置重复任务、理解它们何时运行，并管理内置的 Curator 自动任务。"
    },
    icon: Zap
  },
  {
    id: "search",
    title: { en: "Web Search", zh: "网络搜索" },
    summary: {
      en: "Configure search providers for the built-in web_search tool and understand its permission boundary.",
      zh: "为内置 web_search 工具配置搜索来源，并理解它和 network 权限的关系。"
    },
    icon: MessageSquare
  },
  {
    id: "preferences",
    title: { en: "Preferences", zh: "偏好" },
    summary: {
      en: "Personalize language, tone, startup behavior, and storage hygiene without changing approval policy.",
      zh: "个性化语言、语气、启动行为和本地存储习惯，但不直接改变权限审批策略。"
    },
    icon: Settings
  },
  {
    id: "troubleshooting",
    title: { en: "Troubleshooting", zh: "故障排除" },
    summary: {
      en: "Where to look when models, tools, settings, or live connections do not behave as expected.",
      zh: "当模型、工具、设置或实时连接表现异常时，先看哪些地方排查。"
    },
    icon: HelpCircle
  }
];

export function getDocTitle(meta: DocMeta, language: string | null | undefined): string {
  const lang = language === "zh" || language === "zh-CN" ? "zh" : "en";
  return meta.title[lang] ?? meta.title.en ?? "";
}

const docModules = import.meta.glob<string>("./**/*.md", { query: "?raw", import: "default" });
const docContentCache = new Map<string, Promise<string>>();

export async function loadDocContent(id: DocsSection, language: string | null | undefined): Promise<string> {
  const lang = normalizeDocLanguage(language);
  const cacheKey = `${lang}:${id}`;
  const cached = docContentCache.get(cacheKey);
  if (cached) return cached;
  const loading = loadDocContentUncached(id, lang);
  docContentCache.set(cacheKey, loading);
  return loading;
}

export async function preloadDocContents(language: string | null | undefined): Promise<void> {
  const preferred = normalizeDocLanguage(language);
  const languages = preferred === "zh" ? ["zh", "en"] : ["en", "zh"];
  for (const lang of languages) {
    await Promise.all(docMetas.map((meta) => loadDocContent(meta.id, lang).catch(() => "")));
  }
}

function normalizeDocLanguage(language: string | null | undefined): "zh" | "en" {
  return language === "zh" || language === "zh-CN" ? "zh" : "en";
}

async function loadDocContentUncached(id: DocsSection, lang: "zh" | "en"): Promise<string> {
  const path = `./${lang}/${id}.md`;
  const loader = docModules[path];
  if (!loader) {
    const fallback = docModules[`./en/${id}.md`];
    if (!fallback) return `# ${id}\n\nContent not found.`;
    return (await fallback()) as string;
  }
  return (await loader()) as string;
}
