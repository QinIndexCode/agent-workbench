import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { AgentToolDefinition } from '../../foundation/extensions/types';
import { CapabilityHubView, EcosystemSummaryView, ImprovementProposal, ScenarioPackSummary, ToolCapabilityEntry, WorkspaceWorkflowView } from './types';

const ACCEPTANCE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'create_folder',
  'list_files',
  'search_files',
  'run_command',
  'delegate_subtask'
]);

const VISIBLE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'create_folder',
  'list_files',
  'search_files',
  'run_command'
]);

const SCENARIO_PACKS: ScenarioPackSummary[] = [
  {
    id: 'web-creation',
    label: 'Web/App Creation',
    focus: 'External-path delivery, browser-verifiable UI, build or DOM quality checks.',
    qualityProfileId: 'web_experience',
    artifactAudit: 'Checks generated files, no placeholder content, visible interaction, and build or browser smoke evidence.',
    cleanupHints: ['workspace', 'external-delivery-path'],
    status: 'ready'
  },
  {
    id: 'docs-normalize',
    label: 'Document Normalize',
    focus: 'Batch rename, hierarchy cleanup, source-preserving trace, and cross-reference repair.',
    qualityProfileId: 'docs_normalize',
    artifactAudit: 'Checks source-to-output trace, preserved phrases, consistent names, and non-template output.',
    cleanupHints: ['workspace/incoming', 'workspace/normalized'],
    status: 'ready'
  },
  {
    id: 'docs-synthesize',
    label: 'Document Synthesis',
    focus: 'Handbook, summary, index, and decision-log synthesis with claim-level sources.',
    qualityProfileId: 'docs_synthesize',
    artifactAudit: 'Checks claim/source trace, no unsupported generic claims, and coherent handbook structure.',
    cleanupHints: ['workspace/source', 'workspace/handbook'],
    status: 'ready'
  },
  {
    id: 'system-audit',
    label: 'System Audit',
    focus: 'Host observation, fact/source binding, unit normalization, and actionable recommendations.',
    qualityProfileId: 'system_audit',
    artifactAudit: 'Checks source invocation ids, reported values, units, and recommendation grounding.',
    cleanupHints: ['workspace/reports', 'workspace/quality'],
    status: 'ready'
  },
  {
    id: 'codebase-work',
    label: 'Codebase Work',
    focus: 'Repo-local implementation, bug fix, verification command evidence, and follow-up diagnosis.',
    qualityProfileId: null,
    artifactAudit: 'Checks changed files, command results, tool evidence, and failure recovery traces.',
    cleanupHints: ['workspace', 'repo-diff'],
    status: 'ready'
  },
  {
    id: 'database-design',
    label: 'Database Design',
    focus: 'High-complexity system design, runnable prototype scaffold, benchmark plan, and dry-run evidence.',
    qualityProfileId: 'database_near_mysql_design',
    artifactAudit: 'Checks design coverage, prototype modules, manifest, benchmark script, and dry-run result.',
    cleanupHints: ['workspace/database-lab'],
    status: 'ready'
  }
];

function normalizeToolName(tool: AgentToolDefinition): string {
  return tool.name.trim().toLowerCase().replace(/-/g, '_');
}

function summarizeSchema(tool: AgentToolDefinition): string[] {
  return tool.inputSchema.map((field) => {
    const required = field.required ? 'required' : 'optional';
    return `${field.name}:${field.type}:${required}`;
  });
}

function evidenceShapeFor(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return 'path, byte/line range, excerpt, and read status';
    case 'write_file':
      return 'path, bytes written, content hash, and JSON validation status when applicable';
    case 'create_folder':
      return 'path and creation status';
    case 'list_files':
      return 'path, recursive flag, and file entries';
    case 'search_files':
      return 'pattern, target path, and matched file/line snippets';
    case 'run_command':
      return 'command, cwd, exitCode, stdout, stderr, duration, and timeout state';
    case 'delegate_subtask':
      return 'child task id, child contract, lifecycle status, and child acceptance truth';
    default:
      return 'tool invocation arguments, status, result summary, and error taxonomy';
  }
}

function failureTaxonomyFor(toolName: string): string[] {
  switch (toolName) {
    case 'read_file':
      return ['not_found', 'access_denied', 'range_invalid', 'encoding_error'];
    case 'write_file':
      return ['access_denied', 'path_escape', 'invalid_quality_json', 'write_failed'];
    case 'run_command':
      return ['non_zero_exit', 'timeout', 'blocked_command', 'spawn_failed'];
    case 'delegate_subtask':
      return ['child_contract_invalid', 'child_failed', 'boundary_violation'];
    default:
      return ['invalid_arguments', 'runtime_unavailable', 'execution_failed'];
  }
}

function buildToolCapabilityEntries(foundation: BackendNewFoundation): ToolCapabilityEntry[] {
  return foundation.extensions.snapshot().tools
    .map((tool) => {
      const toolName = normalizeToolName(tool);
      const capability = foundation.toolExecutors.resolveCapability(tool);
      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        source: tool.source,
        effect: tool.effect,
        riskLevel: tool.riskLevel,
        inputSchemaSummary: summarizeSchema(tool),
        evidenceShape: evidenceShapeFor(toolName),
        failureTaxonomy: failureTaxonomyFor(toolName),
        acceptanceEvidence: ACCEPTANCE_TOOL_NAMES.has(toolName),
        executorRegistered: Boolean(capability),
        capability: capability
          ? {
            supportsApprovalResume: capability.supportsApprovalResume,
            supportsDryRun: capability.supportsDryRun,
            supportsStreaming: capability.supportsStreaming,
            maxExecutionMs: capability.maxExecutionMs
          }
          : null,
        readiness: capability ? 'ready' as const : 'partial' as const,
        visibleByDefault: VISIBLE_TOOL_NAMES.has(toolName)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildExperienceHealth(proposals: ImprovementProposal[]): EcosystemSummaryView['experiences'] {
  const approvedExperienceProposals = proposals.filter((proposal) =>
    proposal.kind === 'experience'
    && proposal.status === 'APPROVED'
    && proposal.experienceProposal
  );
  const successfulReuseTaskIds = new Set<string>();
  const failedReuseTaskIds = new Set<string>();
  let lastValidatedAt: number | null = null;

  for (const proposal of approvedExperienceProposals) {
    const payload = proposal.experienceProposal;
    if (!payload) {
      continue;
    }
    for (const taskId of payload.successfulReuseTaskIds) {
      successfulReuseTaskIds.add(taskId);
    }
    for (const taskId of payload.failedReuseTaskIds) {
      failedReuseTaskIds.add(taskId);
    }
    if (payload.lastValidatedAt && (!lastValidatedAt || payload.lastValidatedAt > lastValidatedAt)) {
      lastValidatedAt = payload.lastValidatedAt;
    }
  }

  return {
    approved: approvedExperienceProposals.length,
    monitoring: approvedExperienceProposals.filter((proposal) => proposal.experienceProposal?.validationStatus === 'monitoring').length,
    promotable: approvedExperienceProposals.filter((proposal) => proposal.experienceProposal?.validationStatus === 'promotable').length,
    conflicted: approvedExperienceProposals.filter((proposal) => proposal.experienceProposal?.validationStatus === 'conflicted').length,
    selectedReusableTaskIds: [...successfulReuseTaskIds].sort(),
    failedReuseTaskIds: [...failedReuseTaskIds].sort(),
    lastValidatedAt
  };
}

function buildWarnings(params: {
  capabilities: CapabilityHubView;
  proposals: ImprovementProposal[];
}): EcosystemSummaryView['warnings'] {
  const approvedInstructionSkillIds = new Set(
    params.proposals
      .filter((proposal) => proposal.kind === 'instruction_skill' && proposal.status === 'APPROVED')
      .map((proposal) => proposal.instructionSkillProposal?.importedSkillId)
      .filter((value): value is string => Boolean(value))
  );
  const warnings: EcosystemSummaryView['warnings'] = params.capabilities.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    severity: warning.hardBlocker ? 'blocker' : 'warning',
    capabilityId: warning.capabilityId
  }));

  for (const skill of params.capabilities.skills) {
    if (
      skill.kind === 'instruction-skill'
      && skill.source === 'generated'
      && !approvedInstructionSkillIds.has(skill.skill.id)
      && !skill.instructionSource
    ) {
      warnings.push({
        code: 'orphan-generated-skill',
        message: `Generated instruction skill "${skill.skill.name}" has no approved proposal source.`,
        severity: 'warning',
        capabilityId: skill.skill.id
      });
    }
  }

  return warnings;
}

export function createEcosystemSummaryView(params: {
  foundation: BackendNewFoundation;
  capabilities: CapabilityHubView;
  workspace: WorkspaceWorkflowView;
  proposals: ImprovementProposal[];
}): EcosystemSummaryView {
  const tools = buildToolCapabilityEntries(params.foundation);
  const experiences = buildExperienceHealth(params.proposals);
  const warnings = buildWarnings({
    capabilities: params.capabilities,
    proposals: params.proposals
  });
  const readyProviders = params.capabilities.providers.filter((entry) => entry.readiness === 'ready').length;
  const readyMcpServers = params.capabilities.mcpServers.filter((entry) => entry.readiness === 'ready').length;

  return {
    generatedAt: Date.now(),
    summary: {
      providers: params.capabilities.providers.length,
      readyProviders,
      mcpServers: params.capabilities.mcpServers.length,
      readyMcpServers,
      skills: params.capabilities.skills.length,
      instructionSkills: params.capabilities.skills.filter((entry) => entry.kind === 'instruction-skill').length,
      tools: tools.length,
      acceptanceEvidenceTools: tools.filter((entry) => entry.acceptanceEvidence).length,
      scenarioPacks: SCENARIO_PACKS.length,
      workspaceCommands: params.workspace.commands.length,
      warnings: warnings.length
    },
    providers: params.capabilities.providers,
    mcpServers: params.capabilities.mcpServers,
    skills: params.capabilities.skills,
    experiences,
    tools,
    workspaceCommands: params.workspace.commands,
    scenarioPacks: SCENARIO_PACKS.map((pack) => ({
      ...pack,
      cleanupHints: [...pack.cleanupHints]
    })),
    warnings
  };
}
