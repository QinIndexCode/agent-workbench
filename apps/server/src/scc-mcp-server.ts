import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentWorkbench } from "@scc/core";

export function createSccMcpServer(workbench: AgentWorkbench): McpServer {
  const server = new McpServer({ name: "scc-agent-workbench", version: "0.1.0" });

  server.registerTool(
    "scc.list_tasks",
    {
      title: "List SCC tasks",
      description: "List current SCC workbench tasks.",
      annotations: { readOnlyHint: true },
      inputSchema: {}
    },
    async () => textResult(await summarizeTasks(workbench))
  );

  server.registerTool(
    "scc.get_task",
    {
      title: "Get SCC task",
      description: "Get one SCC task with timeline and approvals.",
      annotations: { readOnlyHint: true },
      inputSchema: { taskId: z.string() }
    },
    async ({ taskId }) => textResult((await workbench.getTask(taskId)) ?? { error: "Task not found" })
  );

  server.registerTool(
    "scc.create_task",
    {
      title: "Create SCC task",
      description: "Create and start a new SCC agent task.",
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: { goal: z.string(), title: z.string().optional(), folderId: z.string().optional() }
    },
    async ({ goal, title, folderId }) => textResult(await workbench.createTask(goal, title, folderId))
  );

  server.registerTool(
    "scc.send_message",
    {
      title: "Send SCC message",
      description: "Append a user message or pending guidance to an existing SCC task.",
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: { taskId: z.string(), content: z.string() }
    },
    async ({ taskId, content }) => textResult(await workbench.appendMessage(taskId, content))
  );

  server.registerTool(
    "scc.list_skills",
    {
      title: "List SCC skills",
      description: "List SCC skill metadata.",
      annotations: { readOnlyHint: true },
      inputSchema: {}
    },
    async () =>
      textResult(
        (await workbench.listSkills()).map((skill) => ({
          id: skill.id,
          title: skill.title,
          status: skill.status,
          successRate: skill.stats.successRate,
          keywords: skill.applicability.keywords
        }))
      )
  );

  server.registerTool(
    "scc.use_skill_summary",
    {
      title: "Use SCC skill summary",
      description: "Read a concise SCC skill summary by id.",
      annotations: { readOnlyHint: true },
      inputSchema: { skillId: z.string() }
    },
    async ({ skillId }) => {
      const skill = await workbench.getSkill(skillId);
      return textResult(
        skill
          ? {
              id: skill.id,
              title: skill.title,
              status: skill.status,
              applicability: skill.applicability,
              bodyPreview: skill.body.slice(0, 1600)
            }
          : { error: "Skill not found" }
      );
    }
  );

  return server;
}

async function summarizeTasks(workbench: AgentWorkbench) {
  return (await workbench.listTasks()).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    pendingApprovals: task.approvals.filter((approval) => approval.status === "pending").length
  }));
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}
