export type SlashCommandName =
  | "goal"
  | "plan"
  | "review"
  | "verify"
  | "debug"
  | "research"
  | "doc"
  | "knowledge"
  | "memory"
  | "skill"
  | "cache"
  | "docs"
  | "settings"
  | "model"
  | "permissions"
  | "search"
  | "mcp"
  | "integrations"
  | "schedule"
  | "prefs"
  | "curator"
  | "help";

export type SlashSubmitCommandName =
  | "none"
  | "literal"
  | "goal"
  | "plan"
  | "review"
  | "verify"
  | "debug"
  | "research"
  | "doc"
  | "knowledge"
  | "memory"
  | "skill"
  | "cache";

export type SlashNavigationTarget =
  | { area: "docs"; section: "overview" | "task-management" | "providers" | "permissions" | "mcp" | "integrations" | "scheduled" | "search" | "preferences" }
  | { area: "library"; section: "knowledge" | "memory" | "skills" | "curator" }
  | { area: "settings"; section: "providers" | "permissions" | "mcp" | "integrations" | "scheduled" | "search" | "preferences" };

export interface SlashCommandMenuItem {
  name: SlashCommandName;
  command: string;
  title: string;
  detail: string;
  insertText: string;
  category: "task" | "library" | "settings" | "docs";
}

export type ParsedComposerCommand =
  | { kind: "submit"; command: SlashSubmitCommandName; text: string; runMode: "normal" | "target" }
  | { kind: "navigate"; command: SlashCommandName; target: SlashNavigationTarget }
  | { kind: "error"; command: string; message: string };

const commandNames: SlashCommandName[] = [
  "goal",
  "plan",
  "review",
  "verify",
  "debug",
  "research",
  "doc",
  "knowledge",
  "memory",
  "skill",
  "cache",
  "docs",
  "settings",
  "model",
  "permissions",
  "search",
  "mcp",
  "integrations",
  "schedule",
  "prefs",
  "curator",
  "help"
];

const navigationCommands: Record<string, { command: SlashCommandName; target: SlashNavigationTarget }> = {
  help: { command: "help", target: { area: "docs", section: "task-management" } },
  "?": { command: "help", target: { area: "docs", section: "task-management" } },
  docs: { command: "docs", target: { area: "docs", section: "overview" } },
  settings: { command: "settings", target: { area: "settings", section: "providers" } },
  model: { command: "model", target: { area: "settings", section: "providers" } },
  models: { command: "model", target: { area: "settings", section: "providers" } },
  provider: { command: "model", target: { area: "settings", section: "providers" } },
  providers: { command: "model", target: { area: "settings", section: "providers" } },
  permissions: { command: "permissions", target: { area: "settings", section: "permissions" } },
  permission: { command: "permissions", target: { area: "settings", section: "permissions" } },
  search: { command: "search", target: { area: "settings", section: "search" } },
  mcp: { command: "mcp", target: { area: "settings", section: "mcp" } },
  integrations: { command: "integrations", target: { area: "settings", section: "integrations" } },
  integration: { command: "integrations", target: { area: "settings", section: "integrations" } },
  schedule: { command: "schedule", target: { area: "settings", section: "scheduled" } },
  scheduled: { command: "schedule", target: { area: "settings", section: "scheduled" } },
  prefs: { command: "prefs", target: { area: "settings", section: "preferences" } },
  preferences: { command: "prefs", target: { area: "settings", section: "preferences" } },
  knowledge: { command: "knowledge", target: { area: "library", section: "knowledge" } },
  memory: { command: "memory", target: { area: "library", section: "memory" } },
  skill: { command: "skill", target: { area: "library", section: "skills" } },
  skills: { command: "skill", target: { area: "library", section: "skills" } },
  curator: { command: "curator", target: { area: "library", section: "curator" } }
};

export function parseComposerSlashCommand(input: string, language?: string | null): ParsedComposerCommand {
  const raw = input.trim();
  if (!raw.startsWith("/")) return { kind: "submit", command: "none", text: input, runMode: "normal" };
  if (raw.startsWith("//")) return { kind: "submit", command: "literal", text: raw.slice(1), runMode: "normal" };

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(raw);
  const commandToken = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();
  const zh = language === "zh-CN";

  if (commandToken === "target") {
    return {
      kind: "error",
      command: "/target",
      message: zh ? "/target 指令已移除，请使用 /goal <目标>。" : "The /target command has been removed. Use /goal <goal> instead."
    };
  }

  if (commandToken === "goal") {
    if (!rest) return missingRequestError("/goal", zh ? "修复并验证登录流程" : "fix and verify the login flow", language);
    return { kind: "submit", command: "goal", text: rest, runMode: "target" };
  }

  if (commandToken === "plan") {
    if (!rest) return missingRequestError("/plan", zh ? "设计上传图片后的视觉检查流程" : "design the image-upload visual-check flow", language);
    return { kind: "submit", command: "plan", text: buildPlanFirstPrompt(rest, language), runMode: "normal" };
  }

  if (commandToken === "review") return submitPromptCommand("review", rest, buildReviewPrompt, language);
  if (commandToken === "verify") return submitPromptCommand("verify", rest, buildVerifyPrompt, language);
  if (commandToken === "debug") return submitPromptCommand("debug", rest, buildDebugPrompt, language);
  if (commandToken === "research") return submitPromptCommand("research", rest, buildResearchPrompt, language);
  if (commandToken === "doc") return submitPromptCommand("doc", rest, buildDocumentationPrompt, language);
  if (commandToken === "cache") return { kind: "submit", command: "cache", text: buildCachePrompt(rest, language), runMode: "normal" };
  if (commandToken === "knowledge" && rest) return { kind: "submit", command: "knowledge", text: buildKnowledgePrompt(rest, language), runMode: "normal" };
  if (commandToken === "memory" && rest) return { kind: "submit", command: "memory", text: buildMemoryPrompt(rest, language), runMode: "normal" };
  if ((commandToken === "skill" || commandToken === "skills") && rest) return { kind: "submit", command: "skill", text: buildSkillPrompt(rest, language), runMode: "normal" };

  const navigation = navigationCommands[commandToken];
  if (navigation) return { kind: "navigate", command: navigation.command, target: navigation.target };

  return {
    kind: "error",
    command: commandToken ? `/${commandToken}` : "/",
    message: zh
      ? `未知指令 /${commandToken || ""}。可用指令：${availableCommandList()}。若要发送以 / 开头的普通文本，请输入 //。`
      : `Unknown command /${commandToken || ""}. Available commands: ${availableCommandList()}. To send normal text that starts with /, type //.`
  };
}

export function buildPlanFirstPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请先为下面的请求制定一份可见计划，不要开始实施、修改文件或执行有副作用的操作。",
      "计划需要包含验收标准、关键风险、需要我确认的问题，以及建议的下一步。输出计划后等待我确认再继续。",
      "",
      `请求：${trimmed}`
    ].join("\n");
  }
  return [
    "Create a visible plan for the request below before implementation. Do not modify files or run side-effecting actions yet.",
    "Include acceptance criteria, key risks, questions that need my confirmation, and the recommended next step. Stop after the plan and wait for my confirmation.",
    "",
    `Request: ${trimmed}`
  ].join("\n");
}

export function buildReviewPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请以严苛代码审查/产品审查方式处理下面的请求。",
      "优先列出可复现问题、风险、行为回归和缺失测试；发现明确问题时直接修复并验证。不要做无关重构。",
      "",
      `审查范围：${trimmed}`
    ].join("\n");
  }
  return [
    "Handle the request below as a strict code/product review.",
    "Lead with reproducible issues, risks, regressions, and missing tests. Fix and verify clear issues directly. Avoid unrelated refactors.",
    "",
    `Review scope: ${trimmed}`
  ].join("\n");
}

export function buildVerifyPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请用证据优先的方式验证下面的请求。",
      "先确认当前状态，再运行或设计最小但有代表性的检查；结论必须区分已验证事实、剩余风险和需要后续处理的缺口。",
      "",
      `验证目标：${trimmed}`
    ].join("\n");
  }
  return [
    "Verify the request below with evidence first.",
    "Establish the current state, then run or design the smallest representative checks. Separate verified facts, residual risk, and follow-up gaps.",
    "",
    `Verification target: ${trimmed}`
  ].join("\n");
}

export function buildDebugPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请按调试闭环处理下面的问题。",
      "先复现或定位症状，再找最小根因，修复后回归验证。不要只给猜测性解释。",
      "",
      `问题：${trimmed}`
    ].join("\n");
  }
  return [
    "Handle the issue below as a debugging loop.",
    "Reproduce or localize the symptom, identify the smallest root cause, fix it, and run regression checks. Do not stop at speculation.",
    "",
    `Issue: ${trimmed}`
  ].join("\n");
}

export function buildResearchPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请先收集当前可靠证据，再回答下面的研究请求。",
      "如果信息可能随时间变化，请联网核验并给出来源；如果来自本地项目，请引用实际文件、接口或测试证据。",
      "",
      `研究问题：${trimmed}`
    ].join("\n");
  }
  return [
    "Gather current reliable evidence before answering the research request below.",
    "Browse and cite sources for time-sensitive information. For local project facts, cite actual files, APIs, or test evidence.",
    "",
    `Research question: ${trimmed}`
  ].join("\n");
}

export function buildDocumentationPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请创建或更新与当前代码一致的文档。",
      "先核对实际实现和现有文档边界；不要夸大已实现能力，也不要把规划内容写成既有事实。完成后运行相关文档检查。",
      "",
      `文档请求：${trimmed}`
    ].join("\n");
  }
  return [
    "Create or update documentation that matches the current code.",
    "Check the implementation and existing doc boundaries first. Do not overstate shipped capabilities or present plans as facts. Run relevant documentation checks afterward.",
    "",
    `Documentation request: ${trimmed}`
  ].join("\n");
}

export function buildKnowledgePrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请围绕下面的问题使用知识库能力。",
      "需要历史资料时先使用 knowledge_search；但不要把知识库结果当成当前源码事实，涉及当前文件时继续用实时文件工具核验。",
      "",
      `知识库问题：${trimmed}`
    ].join("\n");
  }
  return [
    "Use the Knowledge library for the request below.",
    "Call knowledge_search when saved background material is needed, but do not treat it as proof of current source state. Verify current files with live file tools when relevant.",
    "",
    `Knowledge request: ${trimmed}`
  ].join("\n");
}

export function buildMemoryPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请围绕下面的请求检查或整理持久记忆。",
      "只保存稳定、可复用、已确认的信息；不要保存密钥、临时任务输出或未经验证的猜测。需要修改记忆时说明理由和范围。",
      "",
      `记忆请求：${trimmed}`
    ].join("\n");
  }
  return [
    "Inspect or organize durable memory for the request below.",
    "Only keep stable, reusable, confirmed information. Do not store secrets, transient task output, or unverified guesses. Explain the scope and reason before memory changes.",
    "",
    `Memory request: ${trimmed}`
  ].join("\n");
}

export function buildSkillPrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  if (language === "zh-CN") {
    return [
      "请围绕下面的请求检查或整理 Skill。",
      "只有当模式可复用且边界明确时才建议创建、合并或删除 Skill；先处理重复、冲突和适用范围，再给出变更与验证结果。",
      "",
      `Skill 请求：${trimmed}`
    ].join("\n");
  }
  return [
    "Inspect or organize Skills for the request below.",
    "Recommend creating, merging, or deleting a Skill only when the pattern is reusable and bounded. Handle duplicates, conflicts, and applicability before reporting changes and verification.",
    "",
    `Skill request: ${trimmed}`
  ].join("\n");
}

export function buildCachePrompt(request: string, language?: string | null): string {
  const trimmed = request.trim();
  const scope = trimmed || (language === "zh-CN" ? "当前项目和最近任务" : "the current project and recent tasks");
  if (language === "zh-CN") {
    return [
      "请检查并优化 LLM 请求缓存命中率，但不能牺牲任务完成质量。",
      "优先查看现有缓存遥测、provider 配置和请求组装路径；如果命中率不足，提出或实施不会减少必要工具/上下文的改进，并验证效果。",
      "",
      `范围：${scope}`
    ].join("\n");
  }
  return [
    "Inspect and improve LLM request cache hit rate without reducing task quality.",
    "Check existing cache telemetry, provider configuration, and request assembly first. If hit rate is low, propose or implement changes that do not remove necessary tools or context, then verify the result.",
    "",
    `Scope: ${scope}`
  ].join("\n");
}

export function getSlashCommandMenuItems(language?: string | null): SlashCommandMenuItem[] {
  const zh = language === "zh-CN";
  return [
    menu("goal", "/goal", zh ? "目标完成模式" : "Goal mode", zh ? "持续执行和验证，启动前确认权限与风险。" : "Pursue verified completion after a permission confirmation.", "/goal ", "task"),
    menu("plan", "/plan", zh ? "先规划再确认" : "Plan first", zh ? "只生成可见计划，等待你确认后再实施。" : "Create a visible plan and wait before implementation.", "/plan ", "task"),
    menu("review", "/review", zh ? "严苛审查" : "Strict review", zh ? "先列问题、风险和缺失测试，再修复可确认问题。" : "Lead with findings, risks, and missing tests before fixes.", "/review ", "task"),
    menu("verify", "/verify", zh ? "证据验证" : "Evidence check", zh ? "先验证当前状态，再给出已证实结论和剩余风险。" : "Verify current state before conclusions and residual risk.", "/verify ", "task"),
    menu("debug", "/debug", zh ? "调试闭环" : "Debug loop", zh ? "复现、定位、修复、回归验证。" : "Reproduce, localize, fix, and regression-test.", "/debug ", "task"),
    menu("research", "/research", zh ? "联网/本地研究" : "Research", zh ? "对易变事实先查证，对项目事实引用本地证据。" : "Use current sources for unstable facts and local evidence for project facts.", "/research ", "task"),
    menu("doc", "/doc", zh ? "文档同步" : "Documentation", zh ? "按当前代码更新文档，不夸大未实现能力。" : "Update docs against current code without overstating shipped features.", "/doc ", "task"),
    menu("knowledge", "/knowledge", zh ? "知识库" : "Knowledge", zh ? "无参数打开知识库；带问题时要求使用 knowledge_search 并核验实时源码。" : "Open Knowledge, or ask the agent to search saved knowledge.", "/knowledge ", "library"),
    menu("memory", "/memory", zh ? "持久记忆" : "Memory", zh ? "无参数打开记忆；带请求时整理稳定可复用信息。" : "Open Memory, or ask the agent to curate durable memory.", "/memory ", "library"),
    menu("skill", "/skill", zh ? "Skills" : "Skills", zh ? "无参数打开 Skills；带请求时审查重复、冲突和适用范围。" : "Open Skills, or ask the agent to review reusable patterns.", "/skill ", "library"),
    menu("cache", "/cache", zh ? "缓存命中率" : "Cache hit rate", zh ? "检查 LLM 请求缓存遥测和不降质优化空间。" : "Inspect prompt-cache telemetry and quality-preserving improvements.", "/cache ", "task"),
    menu("docs", "/docs", zh ? "文档中心" : "Docs", zh ? "打开文档总览。" : "Open the docs overview.", "/docs", "docs"),
    menu("settings", "/settings", zh ? "设置中心" : "Settings", zh ? "打开设置中心。" : "Open Settings.", "/settings", "settings"),
    menu("model", "/model", zh ? "模型配置" : "Model providers", zh ? "打开模型服务、路由和缓存配置说明。" : "Open model provider, routing, and cache settings.", "/model", "settings"),
    menu("permissions", "/permissions", zh ? "权限审批" : "Permissions", zh ? "打开权限策略和全局授权管理。" : "Open approval policy and global grants.", "/permissions", "settings"),
    menu("search", "/search", zh ? "搜索配置" : "Search settings", zh ? "打开 web_search provider 配置。" : "Open web_search provider settings.", "/search", "settings"),
    menu("mcp", "/mcp", zh ? "MCP 工具" : "MCP tools", zh ? "打开 MCP server 与工具发现配置。" : "Open MCP server and tool discovery settings.", "/mcp", "settings"),
    menu("integrations", "/integrations", zh ? "外部集成" : "Integrations", zh ? "打开 Discord、飞书、Slack 等集成。" : "Open Discord, Feishu, Slack, and related integrations.", "/integrations", "settings"),
    menu("schedule", "/schedule", zh ? "定时任务" : "Schedules", zh ? "打开自动运行任务配置。" : "Open recurring task settings.", "/schedule", "settings"),
    menu("prefs", "/prefs", zh ? "偏好设置" : "Preferences", zh ? "打开语言、语气和存储偏好。" : "Open language, tone, and storage preferences.", "/prefs", "settings"),
    menu("curator", "/curator", zh ? "Curator" : "Curator", zh ? "打开记忆到 Skill 的候选审查。" : "Open memory-to-skill curation.", "/curator", "library"),
    menu("help", "/help", zh ? "查看指令说明" : "Command help", zh ? "打开任务指令文档和使用边界。" : "Open task command docs and usage boundaries.", "/help", "docs")
  ];
}

export function filterSlashCommandMenuItems(query: string, language?: string | null): SlashCommandMenuItem[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  const items = getSlashCommandMenuItems(language);
  if (!normalized) return items;
  if (normalized === "?") return items.filter((item) => item.name === "help");
  const prefixMatches = items.filter((item) => item.name.startsWith(normalized) || item.command.slice(1).startsWith(normalized));
  if (prefixMatches.length > 0) return prefixMatches;
  return items.filter((item) => {
    const haystack = `${item.name} ${item.command} ${item.title} ${item.detail} ${item.category}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function slashCommandNames(): SlashCommandName[] {
  return [...commandNames];
}

function menu(name: SlashCommandName, command: string, title: string, detail: string, insertText: string, category: SlashCommandMenuItem["category"]): SlashCommandMenuItem {
  return { name, command, title, detail, insertText, category };
}

function submitPromptCommand(
  command: Exclude<SlashSubmitCommandName, "none" | "literal" | "goal" | "plan" | "knowledge" | "memory" | "skill" | "cache">,
  request: string,
  builder: (request: string, language?: string | null) => string,
  language?: string | null
): ParsedComposerCommand {
  if (!request.trim()) return missingRequestError(`/${command}`, exampleFor(command, language), language);
  return { kind: "submit", command, text: builder(request, language), runMode: "normal" };
}

function missingRequestError(command: string, example: string, language?: string | null): ParsedComposerCommand {
  const zh = language === "zh-CN";
  return {
    kind: "error",
    command,
    message: zh ? `请在 ${command} 后写清楚请求，例如：${command} ${example}。` : `Add a request after ${command}, for example: ${command} ${example}.`
  };
}

function exampleFor(command: string, language?: string | null): string {
  const zh = language === "zh-CN";
  const examples: Record<string, [string, string]> = {
    review: ["检查知识库检索体验", "review the knowledge-search flow"],
    verify: ["确认 CLI 与 Web 指令都可用", "verify the CLI and Web command flows"],
    debug: ["定位任务状态没有闭合的问题", "debug why task status does not close"],
    research: ["搜索最新 Agent 协议边界", "research the latest agent protocol boundaries"],
    doc: ["同步知识库和指令文档", "sync the Knowledge and command docs"]
  };
  const entry = examples[command] ?? ["处理当前请求", "handle the current request"];
  return zh ? entry[0] : entry[1];
}

function availableCommandList(): string {
  return commandNames.map((name) => `/${name}`).join("、");
}
