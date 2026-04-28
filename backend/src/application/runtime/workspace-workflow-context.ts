import fs from 'node:fs/promises';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import { PlatformMemoryRecord } from '../../foundation/repository';
import { SkillDefinition } from '../../foundation/extensions/types';
import { ExecutionProfileId, TaskDefinition } from '../../domain/contracts/types';
import { ApprovedExperienceRecord } from '../platform/types';
import { getTaskPatternKeyFromDefinition } from '../platform/task-pattern';
import {
  WorkspaceAgentDefinition,
  WorkspaceRuleDefinition,
  WorkspaceWorkflowLoader
} from '../platform/workspace-workflow-loader';
import { runWorkspaceHooks } from './workspace-hook-runner';

export interface WorkspaceWorkflowPromptContext {
  workspaceRoot: string | null;
  projectInstructionsSummary: string | null;
  ruleInstructionsSummary: string | null;
  commandInstructionsSummary: string | null;
  agentInstructionsSummary: string | null;
  instructionSkillInstructionsSummary: string | null;
  approvedExperienceInstructionsSummary: string | null;
  matchedRuleNames: string[];
  pathMatchedRuleNames: string[];
  selectedAgentName: string | null;
  selectedAgentReason: string | null;
  configuredRuleCount: number;
  configuredHookCount: number;
  configuredAgentCount: number;
  configuredInstructionSkillCount: number;
  configuredApprovedExperienceCount: number;
  selectedInstructionSkills: Array<{
    skillId: string;
    name: string;
    description: string | null;
    selectedBy: 'metadata' | 'workspace_default' | 'heuristic';
    instructionSummary: string;
    assetPaths: string[];
    sourcePath: string | null;
    declaredMcpDependencies: string[];
    declaredMcpResources: string[];
    declaredMcpPrompts: string[];
    preferredProviderIds: string[];
  }>;
  selectedApprovedExperiences: Array<{
    proposalId: string;
    title: string;
    selectedBy: 'metadata' | 'heuristic';
    validationEligible: boolean;
    materializedPath: string;
    referenceSummary: string;
    limitations: string[];
    validationStatus: ApprovedExperienceRecord['validationStatus'];
    successfulReuseTaskIds: string[];
    failedReuseTaskIds: string[];
  }>;
  importedDocs: Array<{
    title: string;
    content: string;
    sourcePath: string;
  }>;
}

function summarizeText(value: string | null | undefined, limit = 720): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return null;
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function tokenizeSearchText(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  ));
}

function scoreWorkspaceDoc(record: PlatformMemoryRecord, tokens: string[]): number {
  const haystack = `${record.title} ${record.content}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim().toLowerCase();
}

function collectPathCandidates(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    const normalized = normalizeWorkspacePath(value);
    if (normalized && /[/.\\]/.test(normalized)) {
      into.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPathCandidates(entry, into);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectPathCandidates(entry, into);
    }
  }
}

function matchWorkspaceRules(params: {
  rules: WorkspaceRuleDefinition[];
  definition: TaskDefinition;
  currentGoal: string;
  currentUnitId?: string | null;
  currentExecutionProfileId?: ExecutionProfileId | null;
  recentToolPaths: string[];
}): {
  matchedRules: WorkspaceRuleDefinition[];
  pathMatchedRuleNames: string[];
} {
  const currentUnit = params.currentUnitId
    ? params.definition.units.find((unit) => unit.id === params.currentUnitId) ?? null
    : null;
  const pathCandidates = new Set<string>(params.recentToolPaths.map(normalizeWorkspacePath));
  collectPathCandidates(params.definition.title, pathCandidates);
  collectPathCandidates(params.definition.intent, pathCandidates);
  collectPathCandidates(params.currentGoal, pathCandidates);
  collectPathCandidates(currentUnit?.taskScope, pathCandidates);

  const currentText = [
    params.definition.title,
    params.definition.intent,
    params.currentGoal,
    currentUnit?.role,
    currentUnit?.goal,
    currentUnit?.taskScope,
    params.currentExecutionProfileId
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const matchedRules: WorkspaceRuleDefinition[] = [];
  const pathMatchedRuleNames: string[] = [];
  for (const rule of params.rules) {
    if (rule.paths.length === 0) {
      matchedRules.push(rule);
      continue;
    }
    const matchesPath = rule.paths.some((rulePath) => {
      const normalizedRulePath = normalizeWorkspacePath(rulePath);
      return Array.from(pathCandidates).some((candidate) => (
        candidate === normalizedRulePath
        || candidate.startsWith(`${normalizedRulePath}/`)
        || candidate.includes(normalizedRulePath)
      ));
    });
    const matchesText = rule.paths.some((rulePath) => {
      const normalizedRulePath = normalizeWorkspacePath(rulePath);
      return normalizedRulePath.length > 0 && currentText.includes(normalizedRulePath);
    });
    if (matchesPath || matchesText) {
      matchedRules.push(rule);
      pathMatchedRuleNames.push(rule.name);
    }
  }

  return {
    matchedRules,
    pathMatchedRuleNames
  };
}

function summarizeRules(rules: WorkspaceRuleDefinition[]): string | null {
  if (rules.length === 0) {
    return null;
  }
  return rules
    .slice(0, 4)
    .map((rule) => {
      const scope = rule.paths.length > 0 ? `paths=${rule.paths.join(',')}; ` : '';
      return `${rule.name}: ${scope}${summarizeText(rule.summary ?? rule.content, 120)}`;
    })
    .filter((line): line is string => Boolean(line))
    .join(' | ');
}

function parseDelimitedSkillNames(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSkillMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stripFrontMatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized.trim();
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    return normalized.trim();
  }
  return normalized.slice(closingIndex + 5).trim();
}

async function loadInstructionSkillSummary(skill: SkillDefinition): Promise<string> {
  const skillFile = skill.instructionSource?.skillFile;
  if (!skillFile) {
    return summarizeText(skill.description ?? skill.name, 240) ?? skill.name;
  }
  try {
    const content = await fs.readFile(skillFile, 'utf8');
    return summarizeText(stripFrontMatter(content), 240)
      ?? summarizeText(skill.description ?? skill.name, 240)
      ?? skill.name;
  } catch {
    return summarizeText(skill.description ?? skill.name, 240) ?? skill.name;
  }
}

function shouldUseWorkspaceDefaultSkill(skill: SkillDefinition): boolean {
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  return metadata.workspaceDefault === true
    || metadata.defaultForWorkspace === true
    || metadata.workspacedefault === true
    || metadata.defaultforworkspace === true;
}

function resolveInstructionSkillMcpDependencies(skill: SkillDefinition): string[] {
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  return [
    ...parseDelimitedSkillNames(metadata.mcpServers),
    ...parseDelimitedSkillNames(metadata.mcpservers),
    ...parseDelimitedSkillNames(metadata.mcpTools),
    ...parseDelimitedSkillNames(metadata.mcptools)
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function resolveInstructionSkillMcpResources(skill: SkillDefinition): string[] {
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  return [
    ...parseDelimitedSkillNames(metadata.mcpResources),
    ...parseDelimitedSkillNames(metadata.mcpresources)
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function resolveInstructionSkillMcpPrompts(skill: SkillDefinition): string[] {
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  return [
    ...parseDelimitedSkillNames(metadata.mcpPrompts),
    ...parseDelimitedSkillNames(metadata.mcpprompts)
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function resolveInstructionSkillPreferredProviders(skill: SkillDefinition): string[] {
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  return [
    ...parseDelimitedSkillNames(metadata.preferredProviders),
    ...parseDelimitedSkillNames(metadata.providerPreference),
    ...parseDelimitedSkillNames(metadata.providers)
  ].filter((value, index, values) => values.indexOf(value) === index);
}

async function readApprovedExperiences(foundation: BackendNewFoundation): Promise<ApprovedExperienceRecord[]> {
  const filePath = foundation.layout.approvedExperiencesPath;
  if (!await foundation.storage.exists(filePath)) {
    return [];
  }
  const records = await foundation.storage.readJson<ApprovedExperienceRecord[]>(
    filePath,
    foundation.config.storage.encoding
  );
  return Array.isArray(records)
    ? records.filter((entry): entry is ApprovedExperienceRecord => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
}

function resolveApprovedExperienceMetadataHints(definition: TaskDefinition): string[] {
  const metadata = definition.metadata ?? {};
  return [
    ...parseDelimitedSkillNames(metadata.approvedExperiences),
    ...parseDelimitedSkillNames(metadata.experienceProposalIds),
    ...parseDelimitedSkillNames(metadata.experienceReferences),
  ].map((entry) => entry.toLowerCase());
}

function matchApprovedExperienceHeuristically(record: ApprovedExperienceRecord, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  let score = 0;
  for (const token of tokens) {
    if (record.title.toLowerCase().includes(token)) {
      score += 3;
    }
    if (record.patternKey.toLowerCase().includes(token)) {
      score += 2;
    }
    if (record.referenceSummary.toLowerCase().includes(token)) {
      score += 2;
    }
    if (record.applicableScenarios.some((scenario) => scenario.toLowerCase().includes(token))) {
      score += 1;
    }
  }
  return score;
}

async function selectApprovedExperiences(params: {
  foundation: BackendNewFoundation;
  definition: TaskDefinition;
  currentGoal: string;
}): Promise<{
  configuredApprovedExperienceCount: number;
  selectedApprovedExperiences: WorkspaceWorkflowPromptContext['selectedApprovedExperiences'];
  approvedExperienceInstructionsSummary: string | null;
}> {
  const configuredExperiences = (await readApprovedExperiences(params.foundation))
    .filter((record) => Boolean(record.materializedPath));
  if (configuredExperiences.length === 0) {
    return {
      configuredApprovedExperienceCount: 0,
      selectedApprovedExperiences: [],
      approvedExperienceInstructionsSummary: null
    };
  }

  const metadataHints = new Set(resolveApprovedExperienceMetadataHints(params.definition));
  const heuristicTokens = tokenizeSearchText(`${params.definition.title} ${params.definition.intent} ${params.currentGoal}`);
  const currentPatternKey = getTaskPatternKeyFromDefinition(params.definition);
  const selected = new Map<string, WorkspaceWorkflowPromptContext['selectedApprovedExperiences'][number]>();

  const registerSelection = (
    record: ApprovedExperienceRecord,
    selectedBy: 'metadata' | 'heuristic'
  ) => {
    if (selected.has(record.proposalId) || selected.size >= 2) {
      return;
    }
    selected.set(record.proposalId, {
      proposalId: record.proposalId,
      title: record.title,
      selectedBy,
      validationEligible: record.patternKey === currentPatternKey,
      materializedPath: record.materializedPath,
      referenceSummary: record.referenceSummary,
      limitations: [...record.limitations],
      validationStatus: record.validationStatus,
      successfulReuseTaskIds: [...record.successfulReuseTaskIds],
      failedReuseTaskIds: [...record.failedReuseTaskIds]
    });
  };

  for (const record of configuredExperiences) {
    const candidates = [record.proposalId, record.title, record.patternKey, record.materializedPath]
      .map((entry) => entry.trim().toLowerCase());
    if (candidates.some((candidate) => metadataHints.has(candidate))) {
      registerSelection(record, 'metadata');
    }
  }

  if (metadataHints.size === 0 && selected.size < 2) {
      const heuristicallyMatched = configuredExperiences
        .filter((record) => record.validationStatus !== 'conflicted')
        .filter((record) => record.patternKey === currentPatternKey)
        .filter((record) => !selected.has(record.proposalId))
      .map((record) => ({
          record,
          score: matchApprovedExperienceHeuristically(record, heuristicTokens)
      }))
      .filter((entry) => entry.score >= 4)
      .sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
      .slice(0, 2 - selected.size);
    for (const entry of heuristicallyMatched) {
      registerSelection(entry.record, 'heuristic');
    }
  }

  const selectedApprovedExperiences = [...selected.values()];
  const approvedExperienceInstructionsSummary = selectedApprovedExperiences.length === 0
    ? null
    : selectedApprovedExperiences
      .map((record) => {
        const limits = record.limitations.length > 0
          ? `; limits=${record.limitations.slice(0, 2).join(' / ')}`
          : '';
        return `${record.title} [${record.selectedBy}]${limits}: ${record.referenceSummary}`;
      })
      .join(' | ');

  return {
    configuredApprovedExperienceCount: configuredExperiences.length,
    selectedApprovedExperiences,
    approvedExperienceInstructionsSummary
  };
}

function matchInstructionSkillHeuristically(skill: SkillDefinition, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const metadata = normalizeSkillMetadataRecord(skill.metadata);
  const assetPaths = skill.assetSummary?.samplePaths ?? [];
  const haystack = [
    skill.id,
    skill.name,
    skill.description ?? '',
    ...assetPaths,
    ...parseDelimitedSkillNames(metadata.tags),
    ...parseDelimitedSkillNames(metadata.Tags),
    ...parseDelimitedSkillNames(metadata.keywords),
    ...parseDelimitedSkillNames(metadata.keyWords),
    ...resolveInstructionSkillMcpDependencies(skill)
  ]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

async function selectInstructionSkills(params: {
  foundation: BackendNewFoundation;
  definition: TaskDefinition;
  currentGoal: string;
}): Promise<{
  configuredInstructionSkillCount: number;
  selectedInstructionSkills: WorkspaceWorkflowPromptContext['selectedInstructionSkills'];
  instructionSkillInstructionsSummary: string | null;
}> {
  const configuredSkills = params.foundation.extensions.snapshot().skills
    .filter((skill) => skill.kind === 'instruction-skill');
  if (configuredSkills.length === 0) {
    return {
      configuredInstructionSkillCount: 0,
      selectedInstructionSkills: [],
      instructionSkillInstructionsSummary: null
    };
  }

  const selectionHints = parseDelimitedSkillNames(params.definition.metadata?.instructionSkills);
  const explicitSelections = new Set(selectionHints.map((entry) => entry.toLowerCase()));
  const heuristicTokens = tokenizeSearchText(`${params.definition.title} ${params.definition.intent} ${params.currentGoal}`);
  const selected = new Map<string, WorkspaceWorkflowPromptContext['selectedInstructionSkills'][number]>();

  const registerSelectedSkill = async (
    skill: SkillDefinition,
    selectedBy: 'metadata' | 'workspace_default' | 'heuristic'
  ) => {
    if (selected.has(skill.id)) {
      return;
    }
    const instructionSummary = await loadInstructionSkillSummary(skill);
    selected.set(skill.id, {
      skillId: skill.id,
      name: skill.name,
      description: skill.description ?? null,
      selectedBy,
      instructionSummary,
      assetPaths: [...(skill.assetSummary?.samplePaths ?? [])],
      sourcePath: skill.instructionSource?.skillFile ?? null,
      declaredMcpDependencies: resolveInstructionSkillMcpDependencies(skill),
      declaredMcpResources: resolveInstructionSkillMcpResources(skill),
      declaredMcpPrompts: resolveInstructionSkillMcpPrompts(skill),
      preferredProviderIds: resolveInstructionSkillPreferredProviders(skill)
    });
  };

  for (const skill of configuredSkills) {
    const candidates = [skill.id, skill.name, skill.rootDir, skill.instructionSource?.skillFile]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    if (candidates.some((candidate) => explicitSelections.has(candidate))) {
      await registerSelectedSkill(skill, 'metadata');
    }
  }

  if (selected.size === 0) {
    for (const skill of configuredSkills) {
      if (shouldUseWorkspaceDefaultSkill(skill)) {
        await registerSelectedSkill(skill, 'workspace_default');
      }
    }
  }

  if (selected.size === 0) {
    const heuristicallyMatched = configuredSkills
      .map((skill) => ({
        skill,
        score: matchInstructionSkillHeuristically(skill, heuristicTokens)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
      .slice(0, 3);
    for (const entry of heuristicallyMatched) {
      await registerSelectedSkill(entry.skill, 'heuristic');
    }
  }

  const selectedInstructionSkills = [...selected.values()];
  const instructionSkillInstructionsSummary = selectedInstructionSkills.length === 0
    ? null
    : selectedInstructionSkills
      .slice(0, 3)
      .map((skill) => {
        const assets = skill.assetPaths.length > 0 ? `; assets=${skill.assetPaths.join(',')}` : '';
        const mcp = skill.declaredMcpDependencies.length > 0
          ? `; mcp=${skill.declaredMcpDependencies.join(',')}`
          : '';
        const resources = skill.declaredMcpResources.length > 0
          ? `; resources=${skill.declaredMcpResources.join(',')}`
          : '';
        const prompts = skill.declaredMcpPrompts.length > 0
          ? `; prompts=${skill.declaredMcpPrompts.join(',')}`
          : '';
        const providers = skill.preferredProviderIds.length > 0
          ? `; providers=${skill.preferredProviderIds.join(',')}`
          : '';
        return `${skill.name} [${skill.selectedBy}]${assets}${mcp}${resources}${prompts}${providers}: ${skill.instructionSummary}`;
      })
      .join(' | ');

  return {
    configuredInstructionSkillCount: configuredSkills.length,
    selectedInstructionSkills,
    instructionSkillInstructionsSummary
  };
}

function selectWorkspaceAgent(params: {
  agents: WorkspaceAgentDefinition[];
  definition: TaskDefinition;
  currentGoal: string;
  currentExecutionProfileId?: ExecutionProfileId | null;
}): {
  agent: WorkspaceAgentDefinition | null;
  reason: string | null;
} {
  if (params.agents.length === 0) {
    return { agent: null, reason: null };
  }
  const requestedAgent = typeof params.definition.metadata?.workspaceAgent === 'string'
    ? params.definition.metadata.workspaceAgent.trim().toLowerCase()
    : '';
  if (requestedAgent) {
    const directMatch = params.agents.find((agent) => agent.name.toLowerCase() === requestedAgent) ?? null;
    if (directMatch) {
      return {
        agent: directMatch,
        reason: 'metadata'
      };
    }
  }

  const byProfile = params.currentExecutionProfileId === 'analyze'
    ? 'explore'
    : params.currentExecutionProfileId === 'verify'
      ? 'verify'
      : null;
  if (byProfile) {
    const profileMatch = params.agents.find((agent) => agent.name.toLowerCase() === byProfile) ?? null;
    if (profileMatch) {
      return {
        agent: profileMatch,
        reason: 'execution_profile'
      };
    }
  }

  const goalText = params.currentGoal.toLowerCase();
  const heuristicTarget = /(review|regression|risk|audit)/.test(goalText)
    ? 'review'
    : /(verify|validation|validate|check|test)/.test(goalText)
      ? 'verify'
      : /(explore|research|discover|analy)/.test(goalText)
        ? 'explore'
        : null;
  if (heuristicTarget) {
    const heuristicMatch = params.agents.find((agent) => agent.name.toLowerCase() === heuristicTarget) ?? null;
    if (heuristicMatch) {
      return {
        agent: heuristicMatch,
        reason: 'goal_heuristic'
      };
    }
  }

  return { agent: null, reason: null };
}

function getCommandInstructionsSummary(definition: TaskDefinition): string | null {
  const workspaceCommand = definition.metadata?.workspaceCommand;
  if (!workspaceCommand || typeof workspaceCommand !== 'object' || Array.isArray(workspaceCommand)) {
    return null;
  }
  const commandRecord = workspaceCommand as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof commandRecord.name === 'string' && commandRecord.name.trim()) {
    parts.push(`command=${commandRecord.name.trim()}`);
  }
  if (typeof commandRecord.description === 'string' && commandRecord.description.trim()) {
    parts.push(`description=${commandRecord.description.trim()}`);
  }
  if (typeof commandRecord.template === 'string' && commandRecord.template.trim()) {
    parts.push(`template=${summarizeText(commandRecord.template, 320)}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

export async function loadWorkspaceWorkflowPromptContext(params: {
  foundation: BackendNewFoundation;
  definition: TaskDefinition;
  currentGoal: string;
  taskId?: string;
  currentUnitId?: string | null;
  currentExecutionProfileId?: ExecutionProfileId | null;
  correlationId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  checkpointId?: string | null;
}): Promise<WorkspaceWorkflowPromptContext> {
  const loader = new WorkspaceWorkflowLoader(params.foundation.cwd);
  const snapshot = await loader.discover();
  const projectInstructionsSummary = summarizeText(snapshot.projectInstructions, 720);
  const commandInstructionsSummary = getCommandInstructionsSummary(params.definition);
  const recentToolPaths = params.taskId
    ? (() => {
      const paths = new Set<string>();
      return params.foundation.toolInvocations.listLatest(params.taskId).then((records) => {
        for (const record of records) {
          collectPathCandidates(record.arguments, paths);
          collectPathCandidates(record.result, paths);
        }
        return [...paths];
      });
    })()
    : Promise.resolve<string[]>([]);
  const [resolvedRecentToolPaths] = await Promise.all([recentToolPaths]);
  const matchedRules = matchWorkspaceRules({
    rules: snapshot.rules,
    definition: params.definition,
    currentGoal: params.currentGoal,
    currentUnitId: params.currentUnitId,
    currentExecutionProfileId: params.currentExecutionProfileId,
    recentToolPaths: resolvedRecentToolPaths
  });
  const selectedAgent = selectWorkspaceAgent({
    agents: snapshot.agents,
    definition: params.definition,
    currentGoal: params.currentGoal,
    currentExecutionProfileId: params.currentExecutionProfileId
  });
  const ruleInstructionsSummary = summarizeRules(matchedRules.matchedRules);
  const instructionSkills = await selectInstructionSkills({
    foundation: params.foundation,
    definition: params.definition,
    currentGoal: params.currentGoal
  });
  const approvedExperiences = await selectApprovedExperiences({
    foundation: params.foundation,
    definition: params.definition,
    currentGoal: params.currentGoal
  });
  const agentInstructionsSummary = selectedAgent.agent
    ? `agent=${selectedAgent.agent.name}; description=${selectedAgent.agent.description ?? 'none'}; prompt=${summarizeText(selectedAgent.agent.prompt, 220)}`
    : null;
  if (!snapshot.workspaceRoot) {
    if (params.taskId) {
      await params.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId ?? 'corr_workspace_instructions',
          sessionId: params.sessionId ?? 'sess_workspace_instructions',
          turnId: params.turnId ?? 'turn_workspace_instructions',
          taskId: params.taskId,
          unitId: params.currentUnitId ?? null,
          checkpointId: params.checkpointId ?? null,
          type: 'WORKSPACE_INSTRUCTIONS_LOADED',
          payload: {
            workspaceRoot: null,
            matchedRules: matchedRules.matchedRules.map((rule) => rule.name),
            pathMatchedRules: matchedRules.pathMatchedRuleNames,
            configuredRuleCount: snapshot.rules.length,
            configuredHookCount: snapshot.hooks.length,
            configuredAgentCount: snapshot.agents.length,
            configuredInstructionSkillCount: instructionSkills.configuredInstructionSkillCount,
            configuredApprovedExperienceCount: approvedExperiences.configuredApprovedExperienceCount,
            selectedAgent: selectedAgent.agent?.name ?? null,
            selectedAgentReason: selectedAgent.reason,
            selectedInstructionSkills: instructionSkills.selectedInstructionSkills,
            selectedApprovedExperiences: approvedExperiences.selectedApprovedExperiences,
            commandName: typeof params.definition.metadata?.workspaceCommand === 'object'
              && params.definition.metadata.workspaceCommand
              && !Array.isArray(params.definition.metadata.workspaceCommand)
              && typeof (params.definition.metadata.workspaceCommand as Record<string, unknown>).name === 'string'
                ? (params.definition.metadata.workspaceCommand as Record<string, unknown>).name
                : null,
            importedDocCount: 0
          }
        })
      );
    }
    return {
      workspaceRoot: null,
      projectInstructionsSummary,
      ruleInstructionsSummary,
      commandInstructionsSummary,
      agentInstructionsSummary,
      instructionSkillInstructionsSummary: instructionSkills.instructionSkillInstructionsSummary,
      approvedExperienceInstructionsSummary: approvedExperiences.approvedExperienceInstructionsSummary,
      matchedRuleNames: matchedRules.matchedRules.map((rule) => rule.name),
      pathMatchedRuleNames: matchedRules.pathMatchedRuleNames,
      selectedAgentName: selectedAgent.agent?.name ?? null,
      selectedAgentReason: selectedAgent.reason,
      configuredRuleCount: snapshot.rules.length,
      configuredHookCount: snapshot.hooks.length,
      configuredAgentCount: snapshot.agents.length,
      configuredInstructionSkillCount: instructionSkills.configuredInstructionSkillCount,
      configuredApprovedExperienceCount: approvedExperiences.configuredApprovedExperienceCount,
      selectedInstructionSkills: instructionSkills.selectedInstructionSkills,
      selectedApprovedExperiences: approvedExperiences.selectedApprovedExperiences,
      importedDocs: []
    };
  }
  const memories = await params.foundation.memories.list();
  const workspaceDocs = memories.filter((memory) => (
    memory.metadata?.sourceKind === 'workspace-doc'
    && memory.metadata?.workspaceRoot === snapshot.workspaceRoot
  ));
  const tokens = tokenizeSearchText(`${params.definition.title} ${params.definition.intent} ${params.currentGoal}`);
  const importedDocs = workspaceDocs
    .map((memory) => ({
      record: memory,
      score: scoreWorkspaceDoc(memory, tokens)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.record.updatedAt - left.record.updatedAt)
    .slice(0, 3)
    .map((entry) => ({
      title: entry.record.title,
      content: summarizeText(entry.record.content, 360) ?? '',
      sourcePath: typeof entry.record.metadata?.sourcePath === 'string' ? entry.record.metadata.sourcePath : entry.record.memoryId
    }));

  if (params.taskId) {
    await params.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId ?? 'corr_workspace_instructions',
        sessionId: params.sessionId ?? 'sess_workspace_instructions',
        turnId: params.turnId ?? 'turn_workspace_instructions',
        taskId: params.taskId,
        unitId: params.currentUnitId ?? null,
        checkpointId: params.checkpointId ?? null,
        type: 'WORKSPACE_INSTRUCTIONS_LOADED',
        payload: {
          workspaceRoot: snapshot.workspaceRoot,
          matchedRules: matchedRules.matchedRules.map((rule) => rule.name),
          pathMatchedRules: matchedRules.pathMatchedRuleNames,
          configuredRuleCount: snapshot.rules.length,
          configuredHookCount: snapshot.hooks.length,
          configuredAgentCount: snapshot.agents.length,
          configuredInstructionSkillCount: instructionSkills.configuredInstructionSkillCount,
          configuredApprovedExperienceCount: approvedExperiences.configuredApprovedExperienceCount,
          selectedAgent: selectedAgent.agent?.name ?? null,
          selectedAgentReason: selectedAgent.reason,
          selectedInstructionSkills: instructionSkills.selectedInstructionSkills,
          selectedApprovedExperiences: approvedExperiences.selectedApprovedExperiences,
          commandName: typeof params.definition.metadata?.workspaceCommand === 'object'
            && params.definition.metadata.workspaceCommand
            && !Array.isArray(params.definition.metadata.workspaceCommand)
            && typeof (params.definition.metadata.workspaceCommand as Record<string, unknown>).name === 'string'
              ? (params.definition.metadata.workspaceCommand as Record<string, unknown>).name
              : null,
          importedDocCount: importedDocs.length
        }
      })
    );
    await runWorkspaceHooks({
      foundation: params.foundation,
      event: 'workspace.instructions_loaded',
      taskId: params.taskId,
      unitId: params.currentUnitId ?? null,
      correlationId: params.correlationId ?? null,
      sessionId: params.sessionId ?? null,
      turnId: params.turnId ?? null,
      checkpointId: params.checkpointId ?? null,
        metadata: {
          workspaceRoot: snapshot.workspaceRoot,
          selectedAgent: selectedAgent.agent?.name ?? null,
          matchedRules: matchedRules.matchedRules.map((rule) => rule.name),
          selectedInstructionSkills: instructionSkills.selectedInstructionSkills.map((skill) => skill.name),
          selectedApprovedExperiences: approvedExperiences.selectedApprovedExperiences.map((record) => record.proposalId)
      }
    });
  }

  return {
    workspaceRoot: snapshot.workspaceRoot,
    projectInstructionsSummary,
    ruleInstructionsSummary,
    commandInstructionsSummary,
    agentInstructionsSummary,
    instructionSkillInstructionsSummary: instructionSkills.instructionSkillInstructionsSummary,
    approvedExperienceInstructionsSummary: approvedExperiences.approvedExperienceInstructionsSummary,
    matchedRuleNames: matchedRules.matchedRules.map((rule) => rule.name),
    pathMatchedRuleNames: matchedRules.pathMatchedRuleNames,
    selectedAgentName: selectedAgent.agent?.name ?? null,
    selectedAgentReason: selectedAgent.reason,
    configuredRuleCount: snapshot.rules.length,
    configuredHookCount: snapshot.hooks.length,
    configuredAgentCount: snapshot.agents.length,
    configuredInstructionSkillCount: instructionSkills.configuredInstructionSkillCount,
    configuredApprovedExperienceCount: approvedExperiences.configuredApprovedExperienceCount,
    selectedInstructionSkills: instructionSkills.selectedInstructionSkills,
    selectedApprovedExperiences: approvedExperiences.selectedApprovedExperiences,
    importedDocs
  };
}
