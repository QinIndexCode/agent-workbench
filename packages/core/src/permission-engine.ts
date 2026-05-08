import type { GlobalPermissionGrant, RiskCategory, ToolApproval } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export interface RiskAssessment {
  category: RiskCategory;
  reason: string;
}

export interface PermissionState {
  allowedForTask: Set<RiskCategory>;
}

const destructivePattern =
  /\b(remove-item|rm|del|erase|shutdown|restart-computer|stop-process|kill|rd|rmdir)\b|\bformat(?:\.com)?\s+[a-z]:/i;
const writePattern =
  /\b(set-content|add-content|out-file|new-item|move-item|copy-item|apply-patch|git commit|git push)\b|>>|>/i;
const networkPattern = /\b(invoke-webrequest|curl|wget|fetch|npm install|npm view|git fetch|git pull)\b/i;
const hostObservationPattern =
  /\b(get-process|tasklist|systeminfo|get-ciminstance|get-service|get-counter|wmic)\b/i;
const workspaceReadPattern = /\b(get-content|select-string|rg|dir|ls|get-childitem|git status|git diff)\b/i;

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
      return { category: "workspace_write", reason: `${toolName} changes persistent local SCC memory or skills.` };
    }
    if (toolName === "plan_update") {
      return { category: "workspace_read", reason: "plan_update changes visible task planning state without touching external resources." };
    }
    if (toolName === "web_search") {
      return { category: "network", reason: "web_search reaches external search providers and web pages." };
    }

    if (toolName !== "run_command") {
      return { category: "shell", reason: "Custom tool execution requires review." };
    }

    const command = String(args["command"] ?? "");
    if (destructivePattern.test(command)) {
      return { category: "destructive", reason: "Command can stop processes, remove data, or alter the host." };
    }
    if (networkPattern.test(command)) {
      return { category: "network", reason: "Command can reach external services or change dependencies." };
    }
    if (writePattern.test(command)) {
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
