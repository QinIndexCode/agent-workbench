import type { GlobalPermissionGrant, RiskCategory, ToolApproval } from "@agent-workbench/shared";
import { createId, nowIso } from "./ids.js";

export interface RiskAssessment {
  category: RiskCategory;
  reason: string;
}

export interface PermissionState {
  allowedForTask: Set<RiskCategory>;
}

const destructivePattern =
  /\b(remove-item|rm|del|erase|shutdown|restart-computer|stop-process|kill|rd|rmdir|unlink|chmod|chown|rimraf|rmsync|unlinksync|rmdirsync|removesync)\b|\b(?:fs|node:fs)\.(?:rm|unlink|rmdir)(?:sync)?\b|\bos\.(?:remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\bformat(?:\.com)?\s+[a-z]:/i;
const writePattern =
  /\b(set-content|add-content|out-file|new-item|move-item|copy-item|apply-patch|git commit|mv|cp|mkdir|touch)\b|>>|>|echo.*>|printf.*>/i;
const networkPattern = /\b(invoke-webrequest|curl|wget|fetch|npm(?:\.cmd)?\s+view|pnpm\s+view|yarn\s+info|git fetch|wget|nc|netcat|telnet|ssh|scp|ftp|sftp)\b/i;
const networkMutationPattern =
  /\b(git\s+(?:push|pull|clone)|npm(?:\.cmd)?\s+(?:install|i|ci|update|uninstall|remove|add)|pnpm\s+(?:install|add|remove|update)|yarn\s+(?:install|add|remove|upgrade)|bun\s+(?:install|add|remove|update))\b/i;
const hostObservationPattern =
  /\b(get-process|tasklist|systeminfo|get-ciminstance|get-service|get-counter|wmic|ps|top|whoami|id|uname|hostname)\b/i;
const workspaceReadPattern = /\b(dir|ls|get-childitem|tree|git status|git diff|git show)\b/i;

export class PermissionEngine {
  assess(toolName: string, args: Record<string, unknown>): RiskAssessment {
    if (toolName === "read_file" || toolName === "search_files" || toolName === "list_files") {
      return { category: "workspace_read", reason: `${toolName} reads local project state.` };
    }
    if (toolName === "use_skill") {
      return { category: "workspace_read", reason: "use_skill reads a saved skill and loads its reusable guidance." };
    }
    if (toolName === "knowledge_search") {
      return { category: "workspace_read", reason: "knowledge_search reads indexed local knowledge snippets." };
    }
    if (toolName === "ask_user") {
      return { category: "workspace_read", reason: "ask_user pauses the task to request user input without touching external resources." };
    }
    if (toolName === "edit_file" || toolName === "write_file") {
      return { category: "workspace_write", reason: `${toolName} changes local project files.` };
    }
    if (
      toolName === "user_memory_add" ||
      toolName === "user_memory_edit" ||
      toolName === "user_memory_delete" ||
      toolName === "project_memory_add" ||
      toolName === "project_memory_edit" ||
      toolName === "project_memory_delete" ||
      toolName === "skill_create" ||
      toolName === "skill_edit" ||
      toolName === "skill_delete"
    ) {
      return { category: "workspace_write", reason: `${toolName} changes persistent local Agent Workbench memory or skills.` };
    }
    if (toolName === "plan_update") {
      return { category: "workspace_read", reason: "plan_update changes visible task planning state without touching external resources." };
    }
    if (toolName === "web_search") {
      return { category: "network", reason: "web_search reaches external search providers and web pages." };
    }

    if (toolName === "run_command") {
      const command = String(args["command"] ?? "");
      if (destructivePattern.test(command)) {
        return { category: "destructive", reason: "Command can stop processes, remove data, or alter the host." };
      }
      const reachesNetwork = networkPattern.test(command) || networkMutationPattern.test(command);
      const mutatesWorkspace = writePattern.test(command) || networkMutationPattern.test(command);
      if (reachesNetwork && mutatesWorkspace) {
        return { category: "shell", reason: "Command combines external access with local or remote mutation and needs explicit shell review." };
      }
      if (reachesNetwork) {
        return { category: "network", reason: "Command can reach external services without an obvious local mutation." };
      }
      if (mutatesWorkspace) {
        return { category: "workspace_write", reason: "Command can write or mutate local files." };
      }
      if (hostObservationPattern.test(command)) {
        return { category: "host_observation", reason: "Command reads local system state without changing it." };
      }
      if (workspaceReadPattern.test(command)) {
        return { category: "workspace_read", reason: "Command reads project or version-control state." };
      }
      return { category: "shell", reason: "Shell command risk cannot be reduced to a read-only category." };
    }

    // For MCP or other custom tools, use shell category
    return { category: "shell", reason: "Custom tool execution requires review." };
  }

  needsApproval(category: RiskCategory, state: PermissionState): boolean {
    return !state.allowedForTask.has(category);
  }

  isGloballyAllowed(category: RiskCategory, grants: GlobalPermissionGrant[]): boolean {
    const now = Date.now();
    return grants.some((grant) => {
      if (grant.riskCategory !== category) return false;
      if (!grant.expiresAt) return true;
      return new Date(grant.expiresAt).getTime() > now;
    });
  }

  createApproval(input: {
    taskId: string;
    toolCall: ToolApproval["toolCall"];
    assessment: RiskAssessment;
    metadata?: Record<string, unknown>;
  }): ToolApproval {
    return {
      id: createId("approval"),
      taskId: input.taskId,
      toolCall: input.toolCall,
      riskCategory: input.assessment.category,
      reason: input.assessment.reason,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      status: "pending",
      createdAt: nowIso()
    };
  }
}
