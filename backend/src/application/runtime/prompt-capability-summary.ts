import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createMcpCatalogView } from '../../foundation/mcp';
import { createSkillCatalogView } from '../../foundation/skills';
import { TaskRuntimeState } from '../../domain/contracts/types';
import {
  PromptExtensionCapabilitySummary,
  PromptMcpCapabilitySummary,
  PromptSkillCapabilitySummary,
  PromptToolCapabilitySummary
} from '../../domain/runtime/prompt-sections';
import { CapabilitySelectionSummaryState } from '../../domain/contracts/types';

function buildToolSummaries(
  foundation: BackendNewFoundation,
  options: {
    allowedToolIds?: string[] | null;
  } = {}
): PromptToolCapabilitySummary[] {
  const summaries: PromptToolCapabilitySummary[] = [];
  const allowed = options.allowedToolIds ? new Set(options.allowedToolIds) : null;
  for (const tool of foundation.extensions.snapshot().tools) {
    if (allowed && !allowed.has(tool.id)) {
      continue;
    }
    const capability = foundation.toolExecutors.resolveCapability(tool);
    if (!capability) {
      continue;
    }
    summaries.push({
      name: tool.name,
      effect: tool.effect,
      riskLevel: tool.riskLevel,
      supportsApprovalResume: capability.supportsApprovalResume,
      maxExecutionMs: capability.maxExecutionMs
    });
  }
  return summaries;
}

function buildSkillSummaries(foundation: BackendNewFoundation): PromptSkillCapabilitySummary[] {
  return createSkillCatalogView(foundation.extensions, foundation.skillRuntimes)
    .map(entry => ({
      name: entry.skill.name,
      kind: entry.kind,
      instructionOnly: entry.kind === 'instruction-skill',
      supportsStreaming: entry.capability?.supportsStreaming ?? false,
      supportsWorkspaceWrite: entry.capability?.supportsWorkspaceWrite ?? false,
      supportsNetworkAccess: entry.capability?.supportsNetworkAccess ?? false
    }));
}

function buildMcpSummaries(foundation: BackendNewFoundation): PromptMcpCapabilitySummary[] {
  return createMcpCatalogView(foundation.extensions, foundation.mcpClients)
    .filter(entry => entry.hasClient && entry.capability)
    .map(entry => ({
      name: entry.server.name,
      transport: entry.server.transport,
      supportsTools: entry.capability!.supportsTools,
      supportsPrompts: entry.capability!.supportsPrompts,
      supportsResources: entry.capability!.supportsResources
    }));
}

export function createPromptCapabilitySummary(
  foundation: BackendNewFoundation,
  options: {
    allowedToolIds?: string[] | null;
  } = {}
): PromptExtensionCapabilitySummary {
  return {
    tools: buildToolSummaries(foundation, options),
    skills: buildSkillSummaries(foundation),
    mcpServers: buildMcpSummaries(foundation)
  };
}

export interface StagePromptCapabilitySummaryResult {
  capabilities: PromptExtensionCapabilitySummary;
  summary: CapabilitySelectionSummaryState;
}

export function createStagePromptCapabilitySummary(params: {
  foundation: BackendNewFoundation;
  runtime: Pick<TaskRuntimeState, 'pendingToolBatches'>;
  pendingInvocations: Array<{ toolId: string }>;
  pendingApprovals: Array<{ toolId: string }>;
  allowedToolIds?: string[] | null;
}): StagePromptCapabilitySummaryResult {
  const allTools = buildToolSummaries(params.foundation, { allowedToolIds: params.allowedToolIds });
  const allSkills = buildSkillSummaries(params.foundation);
  const allMcpServers = buildMcpSummaries(params.foundation);
  const batchBacklog = (params.runtime.pendingToolBatches ?? []).length > 0;
  const activeToolHints = new Set([
    ...params.pendingInvocations.map((entry) => entry.toolId),
    ...params.pendingApprovals.map((entry) => entry.toolId)
  ]);
  const selectedTools = activeToolHints.size > 0
    ? allTools.filter((tool) => activeToolHints.has(tool.name) || activeToolHints.has(tool.name.replace(/_/g, '-')))
    : allTools;
  const stageRelevant = batchBacklog || activeToolHints.size > 0;
  const effectiveTools = selectedTools.length > 0 ? selectedTools : allTools;

  return {
    capabilities: {
      tools: effectiveTools,
      skills: stageRelevant ? [] : allSkills,
      mcpServers: stageRelevant ? [] : allMcpServers
    },
    summary: {
      mode: stageRelevant ? 'STAGE_RELEVANT' : 'FULL',
      toolCount: effectiveTools.length,
      skillCount: stageRelevant ? 0 : allSkills.length,
      mcpCount: stageRelevant ? 0 : allMcpServers.length,
      omittedToolCount: Math.max(0, allTools.length - effectiveTools.length),
      omittedSkillCount: stageRelevant ? allSkills.length : 0,
      omittedMcpCount: stageRelevant ? allMcpServers.length : 0,
      selectedToolNames: effectiveTools.map((tool) => tool.name),
      reasons: stageRelevant
        ? ['stage_relevant_tool_focus', ...(batchBacklog ? ['pending_tool_batch_or_approval_backlog'] : []), ...(activeToolHints.size > 0 ? ['active_tool_hints_present'] : [])]
        : ['full_capability_snapshot']
    }
  };
}
