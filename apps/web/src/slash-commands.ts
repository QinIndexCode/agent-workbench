export type SlashCommandName = "goal" | "plan" | "help";

export interface SlashCommandMenuItem {
  name: SlashCommandName;
  command: string;
  title: string;
  detail: string;
  insertText: string;
}

export type ParsedComposerCommand =
  | { kind: "submit"; command: "none" | "literal" | "goal" | "plan"; text: string; runMode: "normal" | "target" }
  | { kind: "open_help"; command: "help" }
  | { kind: "error"; command: string; message: string };

const commandNames: SlashCommandName[] = ["goal", "plan", "help"];

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
    if (!rest) {
      return {
        kind: "error",
        command: "/goal",
        message: zh ? "请在 /goal 后写清楚目标，例如：/goal 修复并验证登录流程。" : "Add a goal after /goal, for example: /goal fix and verify the login flow."
      };
    }
    return { kind: "submit", command: "goal", text: rest, runMode: "target" };
  }

  if (commandToken === "plan") {
    if (!rest) {
      return {
        kind: "error",
        command: "/plan",
        message: zh ? "请在 /plan 后写清楚要规划的请求，例如：/plan 设计上传图片后的视觉检查流程。" : "Add a request after /plan, for example: /plan design the image-upload visual-check flow."
      };
    }
    return { kind: "submit", command: "plan", text: buildPlanFirstPrompt(rest, language), runMode: "normal" };
  }

  if (commandToken === "help" || commandToken === "?") {
    return { kind: "open_help", command: "help" };
  }

  return {
    kind: "error",
    command: commandToken ? `/${commandToken}` : "/",
    message: zh
      ? `未知指令 /${commandToken || ""}。可用指令：/goal、/plan、/help。若要发送以 / 开头的普通文本，请输入 //。`
      : `Unknown command /${commandToken || ""}. Available commands: /goal, /plan, /help. To send normal text that starts with /, type //.`
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

export function getSlashCommandMenuItems(language?: string | null): SlashCommandMenuItem[] {
  const zh = language === "zh-CN";
  return [
    {
      name: "goal",
      command: "/goal",
      title: zh ? "目标完成模式" : "Goal mode",
      detail: zh ? "持续执行和验证，启动前确认权限与风险。" : "Pursue verified completion after a permission confirmation.",
      insertText: "/goal "
    },
    {
      name: "plan",
      command: "/plan",
      title: zh ? "先规划再确认" : "Plan first",
      detail: zh ? "只生成可见计划，等待你确认后再实施。" : "Create a visible plan and wait before implementation.",
      insertText: "/plan "
    },
    {
      name: "help",
      command: "/help",
      title: zh ? "查看指令说明" : "Command help",
      detail: zh ? "打开任务指令文档和使用边界。" : "Open task command docs and usage boundaries.",
      insertText: "/help"
    }
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
    const haystack = `${item.name} ${item.command} ${item.title} ${item.detail}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function slashCommandNames(): SlashCommandName[] {
  return [...commandNames];
}
