import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { AgentToolDefinition } from '../../foundation/extensions/types';
import { CapabilityHubView, EcosystemSummaryView, ImprovementProposal, ScriptCatalogEntry, ToolCapabilityEntry, WorkspaceWorkflowView } from './types';

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

const SCRIPT_CATALOG: ScriptCatalogEntry[] = [
  {
    id: 'frontend-typecheck',
    label: 'Frontend typecheck',
    description: 'Runs the frontend TypeScript checker when the agent needs compiler feedback for UI changes.',
    commandTemplate: 'npm.cmd run typecheck -w frontend',
    defaultCwd: null,
    riskCategory: 'shell_command',
    outputHint: 'Use TypeScript diagnostics to decide the next code edit; a pass is evidence only, not task completion.'
  },
  {
    id: 'backend-typecheck',
    label: 'Backend typecheck',
    description: 'Runs the backend TypeScript checker when the agent needs compiler feedback for runtime or API changes.',
    commandTemplate: 'npm.cmd run typecheck -w backend',
    defaultCwd: null,
    riskCategory: 'shell_command',
    outputHint: 'Use TypeScript diagnostics to decide the next code edit; a pass is evidence only, not task completion.'
  },
  {
    id: 'frontend-build',
    label: 'Frontend build',
    description: 'Builds the frontend when the agent needs production bundle feedback after UI work.',
    commandTemplate: 'npm.cmd run build -w frontend',
    defaultCwd: null,
    riskCategory: 'shell_command',
    outputHint: 'Treat build output as engineering feedback and summarize warnings separately from failures.'
  },
  {
    id: 'frontend-unit',
    label: 'Frontend unit tests',
    description: 'Runs frontend unit tests and coverage when the agent changes component logic or governance UI.',
    commandTemplate: 'npm.cmd run test:unit -w frontend',
    defaultCwd: null,
    riskCategory: 'shell_command',
    outputHint: 'Use failing tests and coverage gaps as feedback; do not treat coverage as task quality judgment.'
  },
  {
    id: 'host-process-observation',
    label: 'Host process observation',
    description: 'Inspects currently running processes and resource usage for desktop/system observation tasks.',
    commandTemplate: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 ProcessName,Id,CPU,WorkingSet',
    defaultCwd: null,
    riskCategory: 'host_observation',
    outputHint: 'Summarize top CPU and memory consumers and mention that CPU is cumulative process time on Windows.'
  },
  {
    id: 'frontend-smoke',
    label: 'Frontend smoke',
    description: 'Runs broad browser smoke validation after substantial UI changes.',
    commandTemplate: 'npm.cmd run smoke:frontend',
    defaultCwd: null,
    riskCategory: 'shell_command',
    outputHint: 'Use screenshots, console failures, and functional failures as feedback for the next agent step.'
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
      return ['access_denied', 'path_escape', 'invalid_content', 'write_failed'];
    case 'run_command':
      return ['non_zero_exit', 'timeout', 'blocked_command', 'spawn_failed'];
    case 'delegate_subtask':
      return ['child_contract_invalid', 'child_failed', 'boundary_violation'];
    default:
      return ['invalid_arguments', 'runtime_unavailable', 'execution_failed'];
  }
}

function healthCheckFor(tool: AgentToolDefinition, executorRegistered: boolean): ToolCapabilityEntry['healthCheck'] {
  const toolName = normalizeToolName(tool);
  const checks = [
    'input_schema_registered',
    'executor_registered',
    'evidence_shape_declared',
    'failure_taxonomy_declared'
  ];
  const diagnostics: string[] = [];
  if (tool.inputSchema.length === 0) {
    diagnostics.push('input_schema_empty');
  }
  if (!executorRegistered) {
    diagnostics.push('executor_missing');
  }
  if (!failureTaxonomyFor(toolName).length) {
    diagnostics.push('failure_taxonomy_empty');
  }
  if (!evidenceShapeFor(toolName)) {
    diagnostics.push('evidence_shape_missing');
  }
  return {
    status: diagnostics.length === 0 ? 'ready' : executorRegistered ? 'partial' : 'blocked',
    checks,
    diagnostics
  };
}

function buildToolCapabilityEntries(foundation: BackendNewFoundation): ToolCapabilityEntry[] {
  return foundation.extensions.snapshot().tools
    .map((tool) => {
      const toolName = normalizeToolName(tool);
      const capability = foundation.toolExecutors.resolveCapability(tool);
      const executorRegistered = Boolean(capability);
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
        executorRegistered,
        capability: capability
          ? {
            supportsApprovalResume: capability.supportsApprovalResume,
            supportsDryRun: capability.supportsDryRun,
            supportsStreaming: capability.supportsStreaming,
            maxExecutionMs: capability.maxExecutionMs
          }
          : null,
        readiness: capability ? 'ready' as const : 'partial' as const,
        visibleByDefault: VISIBLE_TOOL_NAMES.has(toolName),
        healthCheck: healthCheckFor(tool, executorRegistered)
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
    lastValidatedAt,
    approvedDetails: approvedExperienceProposals.map((proposal) => ({
      proposalId: proposal.proposalId,
      title: proposal.experienceProposal?.title ?? proposal.title,
      patternKey: proposal.patternKey,
      materializedPath: proposal.experienceProposal?.materializedPath ?? null,
      validationStatus: proposal.experienceProposal?.validationStatus ?? 'monitoring',
      successfulReuseTaskIds: [...(proposal.experienceProposal?.successfulReuseTaskIds ?? [])],
      failedReuseTaskIds: [...(proposal.experienceProposal?.failedReuseTaskIds ?? [])],
      limitations: [...(proposal.experienceProposal?.limitations ?? [])],
      confidence: proposal.experienceProposal?.confidence ?? proposal.qualityScore
    })).sort((left, right) => left.title.localeCompare(right.title))
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
  const scriptCatalog = SCRIPT_CATALOG.map((entry) => ({ ...entry }));

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
      scriptCatalogEntries: scriptCatalog.length,
      workspaceCommands: params.workspace.commands.length,
      warnings: warnings.length
    },
    providers: params.capabilities.providers,
    mcpServers: params.capabilities.mcpServers,
    skills: params.capabilities.skills,
    experiences,
    tools,
    workspaceCommands: params.workspace.commands,
    scriptCatalog,
    warnings
  };
}
