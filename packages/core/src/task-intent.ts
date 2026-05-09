import type { TaskDetail, TaskEvent } from "@scc/shared";

export type TaskIntent = "direct_chat" | "tool_inventory" | "read_only_evidence" | "code_change" | "memory_skill_admin";

export function classifyTaskIntent(task: Pick<TaskDetail, "events">): TaskIntent {
  const text = latestUserText(task);
  if (!text) return "direct_chat";
  if (isToolInventoryRequest(text)) return "tool_inventory";
  if (isDirectChatRequest(text)) return "direct_chat";
  if (isMemorySkillAdminRequest(text)) return "memory_skill_admin";
  if (isCodeChangeRequest(text)) return "code_change";
  if (isReadOnlyEvidenceRequest(text)) return "read_only_evidence";
  return "read_only_evidence";
}

export function latestUserText(task: Pick<TaskDetail, "events">): string {
  const event = [...task.events].reverse().find(isCurrentUserEvent);
  return event?.summary.trim() ?? "";
}

export function isTrivialUserMessage(text: string): boolean {
  const normalized = normalizeIntentText(text).replace(/[!！。.,，?？~～\s]/g, "");
  if (!normalized) return true;
  return [
    "你好",
    "您好",
    "哈喽",
    "嗨",
    "早上好",
    "下午好",
    "晚上好",
    "hi",
    "hello",
    "hey",
    "yo"
  ].includes(normalized);
}

export function shouldLoadDynamicTools(intent: TaskIntent, task: Pick<TaskDetail, "events">): boolean {
  if (intent === "direct_chat" || intent === "tool_inventory") return false;
  if (intent === "code_change" || intent === "memory_skill_admin") return true;
  return mentionsExternalToolSurface(latestUserText(task));
}

export function isLeanContextIntent(intent: TaskIntent): boolean {
  return intent === "direct_chat" || intent === "tool_inventory";
}

export function explicitlyAvoidsToolUse(text: string): boolean {
  return /(不要|无需|不用|别|禁止|不必|不再).{0,16}(新增|重新|再次|再)?(.{0,8})(调用|使用|运行|执行).{0,12}(工具|命令|tool|command)|(不要|无需|不用|别|禁止|不必|不再).{0,16}(新增|重新|再次|再)?(.{0,8})(工具|命令|tool|command).{0,12}(调用|使用|运行|执行)|without\s+(calling|using|running).{0,16}(tools?|commands?)|do\s+not\s+(call|use|run).{0,16}(tools?|commands?)/iu.test(text);
}

export function currentTurnForbidsToolUse(task: Pick<TaskDetail, "events">): boolean {
  return explicitlyAvoidsToolUse(latestUserText(task));
}

function isCurrentUserEvent(event: TaskEvent): boolean {
  return (event.type === "user_message" || event.type === "guidance_pending" || event.type === "guidance_consumed") && !event.reverted;
}

function isToolInventoryRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /(测试|试用|验证|检查).{0,12}(所有|全部|可用|能调用)?.{0,12}(工具|tool)/u.test(normalized) ||
    /(test|try|verify|check).{0,24}(all|available|callable)?.{0,24}tools?/i.test(normalized) ||
    /(列出|有哪些|what|which).{0,16}(工具|tools?|capabilities)/iu.test(normalized) ||
    /能调用.{0,8}(哪些|什么)?.{0,8}工具/u.test(normalized)
  );
}

function isDirectChatRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (isTrivialUserMessage(normalized)) return true;
  return (
    /^(谢谢|感谢|好的|ok|okay|thanks|thank you)$/iu.test(normalized) ||
    /(你能做什么|你可以帮我做什么|可以帮我做些什么|what can you do|how can you help)/iu.test(normalized)
  );
}

function isMemorySkillAdminRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /(记住|记忆|忘记|remember|forget|memory|skill|技能)/iu.test(normalized);
}

function isCodeChangeRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (/(实现|修复|修改|优化|重构|编辑|写入|创建文件|删除文件|提交|推送|运行测试|跑测试|implement|fix|patch|refactor|edit|write|commit|push|run tests?)/iu.test(normalized)) {
    return true;
  }
  const buildVerb = /(编写|搭建|构建|开发|制作|生成|新建|scaffold|build|create|generate|develop|code)/iu.test(normalized);
  const codeObject = /(文件|代码|项目|页面|博客|网站|应用|组件|界面|前端|后端|react|vue|vite|next|html|css|js|ts|typescript|javascript|node)/iu.test(normalized);
  return buildVerb && codeObject;
}

function isReadOnlyEvidenceRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /(检查|查看|阅读|确认|审计|分析|搜索|查找|验证|inspect|read|check|audit|analy[sz]e|search|verify)/iu.test(normalized);
}

function mentionsExternalToolSurface(text: string): boolean {
  return /(mcp|github|slack|gmail|calendar|drive|notion|linear|supabase|vercel|connector|integration|插件|集成|外部工具)/iu.test(text);
}

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
