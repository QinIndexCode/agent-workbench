import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentWorkbench } from "@agent-workbench/core";

type ToolPrefix = "agent_workbench" | "scc";

export function createAgentWorkbenchMcpServer(workbench: AgentWorkbench): McpServer {
  const server = new McpServer({ name: "agent-workbench", version: "0.1.0" });
  registerWorkbenchTools(server, workbench, "agent_workbench");
  registerWorkbenchTools(server, workbench, "scc");
  return server;
}

function registerWorkbenchTools(server: McpServer, workbench: AgentWorkbench, prefix: ToolPrefix): void {
  const legacy = prefix === "scc";
  const product = legacy ? "legacy Agent Workbench" : "Agent Workbench";

  server.registerTool(
    `${prefix}.list_tasks`,
    {
      title: legacy ? "List legacy Agent Workbench tasks" : "List Agent Workbench tasks",
      description: `List current ${product} tasks.`,
      annotations: { readOnlyHint: true },
      inputSchema: {}
    },
    async () => textResult(await summarizeTasks(workbench))
  );

  server.registerTool(
    `${prefix}.get_task`,
    {
      title: legacy ? "Get legacy Agent Workbench task" : "Get Agent Workbench task",
      description: `Get one ${product} task with timeline and approvals.`,
      annotations: { readOnlyHint: true },
      inputSchema: { taskId: z.string() }
    },
    async ({ taskId }) => textResult((await workbench.getTask(taskId)) ?? { error: "Task not found" })
  );

  server.registerTool(
    `${prefix}.create_task`,
    {
      title: legacy ? "Create legacy Agent Workbench task" : "Create Agent Workbench task",
      description: `Create and start a new ${product} agent task.`,
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: { goal: z.string(), title: z.string().optional(), folderId: z.string().optional() }
    },
    async ({ goal, title, folderId }) => textResult(await workbench.createTask(goal, title, folderId))
  );

  server.registerTool(
    `${prefix}.send_message`,
    {
      title: legacy ? "Send legacy Agent Workbench message" : "Send Agent Workbench message",
      description: `Append a user message or pending guidance to an existing ${product} task.`,
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: { taskId: z.string(), content: z.string() }
    },
    async ({ taskId, content }) => textResult(await workbench.appendMessage(taskId, content))
  );

  server.registerTool(
    `${prefix}.list_skills`,
    {
      title: legacy ? "List legacy Agent Workbench skills" : "List Agent Workbench skills",
      description: `List ${product} skill metadata.`,
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
    `${prefix}.use_skill_summary`,
    {
      title: legacy ? "Use legacy Agent Workbench skill summary" : "Use Agent Workbench skill summary",
      description: `Read a concise ${product} skill summary by id.`,
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
