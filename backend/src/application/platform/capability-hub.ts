import path from 'node:path';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createMcpCatalogView } from '../../foundation/mcp';
import { getProviderPreset } from '../../foundation/providers/presets';
import { ProviderProfile } from '../../foundation/providers/types';
import { createSkillCatalogView } from '../../foundation/skills';
import {
  CapabilityHubEntry,
  CapabilityHubView,
  CapabilityReadiness,
  CapabilityWarning,
  McpCatalogEntry,
  ModelDescriptor,
  ModelVariantDescriptor,
  ProviderAdapter,
  ProviderAuthSource,
  ProviderProfileView,
  SkillCatalogSource,
  SkillCatalogEntry,
  WorkspaceWorkflowView
} from './types';

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function parseProviderMetadata(profile: ProviderProfile): Record<string, unknown> {
  return profile.metadata && typeof profile.metadata === 'object'
    ? profile.metadata
    : {};
}

function deriveProviderAuthSource(profile: ProviderProfile, hasSecret: boolean): ProviderAuthSource {
  const scheme = profile.auth?.scheme ?? getProviderPreset(profile.vendor).auth.scheme;
  if (scheme === 'none') {
    return 'none';
  }
  return hasSecret ? 'secret-store' : 'missing-secret';
}

function deriveProviderReadiness(params: {
  profile: ProviderProfile;
  hasSecret: boolean;
  hasClient: boolean;
  authSource: ProviderAuthSource;
}): CapabilityReadiness {
  const metadata = parseProviderMetadata(params.profile);
  if (metadata.enabled === false) {
    return 'disabled';
  }
  if (params.authSource === 'missing-secret') {
    return 'missing-secret';
  }
  if (!params.hasClient) {
    return 'missing-client';
  }
  if (!params.profile.baseUrl && params.profile.transport !== 'local-stdio') {
    return 'partial';
  }
  return 'ready';
}

function buildProviderAdapter(profile: ProviderProfile): ProviderAdapter {
  const preset = getProviderPreset(profile.vendor);
  const metadata = parseProviderMetadata(profile);
  const timeoutMs = typeof metadata.timeoutMs === 'number'
    ? metadata.timeoutMs
    : null;
  return {
    providerId: profile.id,
    transport: profile.transport ?? preset.transport,
    vendor: profile.vendor ?? preset.vendor,
    baseUrl: profile.baseUrl ?? preset.baseUrl ?? null,
    timeoutMs
  };
}

function buildModelDescriptor(profile: ProviderProfile): ModelDescriptor {
  const metadata = parseProviderMetadata(profile);
  return {
    providerId: profile.id,
    modelId: profile.model,
    label: String(metadata.modelLabel ?? profile.model),
    reasoning: typeof metadata.reasoning === 'string' ? metadata.reasoning : null,
    verbosity: typeof metadata.verbosity === 'string' ? metadata.verbosity : null,
    thinkingBudget: typeof metadata.thinkingBudget === 'number' ? metadata.thinkingBudget : null
  };
}

function buildModelVariantDescriptor(profile: ProviderProfile): ModelVariantDescriptor {
  const metadata = parseProviderMetadata(profile);
  const variantId = typeof metadata.variantId === 'string'
    ? metadata.variantId
    : 'default';
  return {
    providerId: profile.id,
    variantId,
    label: String(metadata.variantLabel ?? variantId),
    isDefault: metadata.isDefaultVariant !== false,
    isSmallModel: metadata.isSmallModel === true,
    taskPreference: typeof metadata.taskPreference === 'string' ? metadata.taskPreference : null
  };
}

export function createProviderProfileView(params: {
  foundation: BackendNewFoundation;
  profile: ProviderProfile;
  hasSecret: boolean;
  savedDefaultProviderId?: string | null;
  runtimeDefaultProviderId?: string | null;
}): ProviderProfileView {
  const profile = params.profile;
  const hasRegisteredClient = params.foundation.providerClients.has(profile.id)
    || Boolean(profile.transport && params.foundation.providerClients.hasTransport(profile.transport));
  const authSource = deriveProviderAuthSource(profile, params.hasSecret);
  const runtimeDefaultProviderId = params.runtimeDefaultProviderId ?? params.foundation.config.providers.defaultProviderId ?? null;
  const savedDefaultProviderId = params.savedDefaultProviderId ?? runtimeDefaultProviderId;
  return {
    profile,
    isDefault: savedDefaultProviderId === profile.id,
    isSavedDefault: savedDefaultProviderId === profile.id,
    isRuntimeDefault: runtimeDefaultProviderId === profile.id,
    hasRegisteredClient,
    hasSecret: params.hasSecret,
    readiness: deriveProviderReadiness({
      profile,
      hasSecret: params.hasSecret,
      hasClient: hasRegisteredClient,
      authSource
    }),
    authSource,
    adapter: buildProviderAdapter(profile),
    model: buildModelDescriptor(profile),
    variant: buildModelVariantDescriptor(profile)
  };
}

function extractDeclaredMcpDependencies(metadata: Record<string, unknown>): string[] {
  const raw = metadata.declaredMcpDependencies ?? metadata.mcpServers;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isWithinDir(candidatePath: string, parentPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

function deriveSkillCatalogSource(foundation: BackendNewFoundation, skill: SkillCatalogEntry['skill']): SkillCatalogSource {
  const rootDir = path.resolve(skill.rootDir);
  const generatedRoot = path.resolve(foundation.layout.generatedSkillsDirPath);
  if (isWithinDir(rootDir, generatedRoot)) {
    return 'generated';
  }
  if (skill.instructionSource?.marketplaceFile) {
    return 'marketplace';
  }
  if (skill.registrationSource === 'CONFIG_ROOT') {
    return 'config_root';
  }
  if (skill.registrationSource === 'IMPORT_MANIFEST') {
    return 'imported';
  }
  return 'builtin';
}

async function readSkillContent(foundation: BackendNewFoundation, skill: SkillCatalogEntry['skill']): Promise<string | null> {
  const contentPath = skill.kind === 'instruction-skill'
    ? skill.instructionSource?.skillFile ?? path.join(skill.rootDir, 'SKILL.md')
    : skill.entryFile
      ? path.join(skill.rootDir, skill.entryFile)
      : path.join(skill.rootDir, 'index.js');
  if (!await foundation.storage.exists(contentPath)) {
    return null;
  }
  return foundation.storage.readText(contentPath, foundation.config.storage.encoding);
}

async function readSkillUpdatedAt(foundation: BackendNewFoundation, skill: SkillCatalogEntry['skill']): Promise<number | null> {
  const targetPath = skill.kind === 'instruction-skill'
    ? skill.instructionSource?.skillFile ?? path.join(skill.rootDir, 'SKILL.md')
    : skill.entryFile
      ? path.join(skill.rootDir, skill.entryFile)
      : skill.rootDir;
  if (!await foundation.storage.exists(targetPath)) {
    return null;
  }
  const stat = await foundation.storage.stat(targetPath);
  return stat.modifiedAt;
}

export async function createSkillCatalogEntry(params: {
  foundation: BackendNewFoundation;
  skillId: string;
}): Promise<SkillCatalogEntry | null> {
  const entry = createSkillCatalogView(params.foundation.extensions, params.foundation.skillRuntimes)
    .find((item) => item.skill.id === params.skillId);
  if (!entry) {
    return null;
  }
  const metadata = entry.skill.metadata && typeof entry.skill.metadata === 'object'
    ? entry.skill.metadata
    : {};
  const readiness: CapabilityReadiness = entry.kind === 'instruction-skill'
    ? 'metadata-only'
    : entry.hasRuntime
      ? 'ready'
      : 'missing-runtime';
  const source = deriveSkillCatalogSource(params.foundation, entry.skill);
  const editable = ['generated', 'imported', 'config_root'].includes(source);
  const deletable = ['generated', 'imported'].includes(source);
  const duplicable = !editable;
  return {
    skill: entry.skill,
    runtimeRegistered: entry.hasRuntime,
    capability: entry.capability,
    kind: entry.kind,
    readiness,
    source,
    editable,
    deletable,
    duplicable,
    updatedAt: await readSkillUpdatedAt(params.foundation, entry.skill),
    content: await readSkillContent(params.foundation, entry.skill),
    assetSummary: entry.assetSummary ?? null,
    instructionSource: entry.instructionSource ?? null,
    declaredDependencies: {
      mcpServers: extractDeclaredMcpDependencies(metadata)
    }
  };
}

export async function createAllSkillCatalogEntries(foundation: BackendNewFoundation): Promise<SkillCatalogEntry[]> {
  const entries = await Promise.all(
    createSkillCatalogView(foundation.extensions, foundation.skillRuntimes)
      .map((entry) => createSkillCatalogEntry({ foundation, skillId: entry.skill.id }))
  );
  return entries.filter((entry): entry is SkillCatalogEntry => Boolean(entry));
}

export function createMcpCatalogEntry(params: {
  foundation: BackendNewFoundation;
  serverId: string;
  lastTestSummary?: { ok: boolean; message: string } | null;
}): McpCatalogEntry | null {
  const entry = createMcpCatalogView(params.foundation.extensions, params.foundation.mcpClients)
    .find((item) => item.server.id === params.serverId);
  if (!entry) {
    return null;
  }
  const readiness: CapabilityReadiness = !entry.hasClient
    ? 'missing-client'
    : entry.capability
      ? 'ready'
      : 'partial';
  const metadata = entry.server.metadata && typeof entry.server.metadata === 'object'
    ? entry.server.metadata
    : {};
  const declaredTools = [
    ...(entry.server.declaredTools ?? []),
    ...parseStringList(metadata.declaredTools),
    ...parseStringList(metadata.tools)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const declaredResources = [
    ...(entry.server.declaredResources ?? []),
    ...parseStringList(metadata.declaredResources),
    ...parseStringList(metadata.resources)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const declaredPrompts = [
    ...(entry.server.declaredPrompts ?? []),
    ...parseStringList(metadata.declaredPrompts),
    ...parseStringList(metadata.prompts)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const availableTools = [
    ...(entry.capability?.toolNames ?? []),
    ...declaredTools
  ].filter((value, index, values) => values.indexOf(value) === index);
  const availableResources = [
    ...(entry.capability?.resourceNames ?? []),
    ...declaredResources
  ].filter((value, index, values) => values.indexOf(value) === index);
  const availablePrompts = [
    ...(entry.capability?.promptNames ?? []),
    ...declaredPrompts
  ].filter((value, index, values) => values.indexOf(value) === index);
  return {
    server: entry.server,
    clientRegistered: entry.hasClient,
    capability: entry.capability,
    readiness,
    declaredTools,
    declaredResources,
    declaredPrompts,
    availableTools,
    availableResources,
    availablePrompts,
    lastTestSummary: params.lastTestSummary ?? null
  };
}

export function createAllMcpCatalogEntries(foundation: BackendNewFoundation): McpCatalogEntry[] {
  return createMcpCatalogView(foundation.extensions, foundation.mcpClients)
    .map((entry) => createMcpCatalogEntry({ foundation, serverId: entry.server.id }))
    .filter((entry): entry is McpCatalogEntry => Boolean(entry));
}

export async function createCapabilityHubView(params: {
  foundation: BackendNewFoundation;
  workspace: WorkspaceWorkflowView;
}): Promise<CapabilityHubView> {
  const providerSecrets = await params.foundation.apiKeys.list();
  const secretIds = new Set(providerSecrets.map((secret) => secret.id));
  const activeSnapshot = await params.foundation.configSnapshots.getActive();
  const snapshotConfig = activeSnapshot?.config as Record<string, unknown> | undefined;
  const snapshotProviders = snapshotConfig?.providers;
  const savedDefaultProviderId = (
    snapshotProviders
    && typeof snapshotProviders === 'object'
    && !Array.isArray(snapshotProviders)
    && typeof (snapshotProviders as Record<string, unknown>).defaultProviderId === 'string'
  )
    ? ((snapshotProviders as Record<string, unknown>).defaultProviderId as string).trim() || null
    : null;
  const runtimeDefaultProviderId = params.foundation.config.providers.defaultProviderId ?? null;
  const providers = params.foundation.providers.list().map((profile) => createProviderProfileView({
    foundation: params.foundation,
    profile,
    hasSecret: Boolean(profile.apiKeySecretId && secretIds.has(profile.apiKeySecretId)),
    savedDefaultProviderId,
    runtimeDefaultProviderId,
  }));
  const skills = await createAllSkillCatalogEntries(params.foundation);
  const mcpServers = createAllMcpCatalogEntries(params.foundation);

  const warnings: CapabilityWarning[] = [
    ...providers
      .filter((entry) => entry.readiness === 'missing-secret')
      .map((entry) => ({
        code: 'provider-missing-secret' as const,
        capabilityKind: 'provider' as const,
        capabilityId: entry.profile.id,
        message: `Provider "${entry.profile.label}" is configured without a required secret.`,
        hardBlocker: true
      })),
    ...providers
      .filter((entry) => entry.readiness === 'missing-client' || entry.readiness === 'disabled')
      .map((entry) => ({
        code: 'provider-unavailable' as const,
        capabilityKind: 'provider' as const,
        capabilityId: entry.profile.id,
        message: entry.readiness === 'disabled'
          ? `Provider "${entry.profile.label}" is disabled.`
          : `Provider "${entry.profile.label}" has no registered runtime client.`,
        hardBlocker: true
      })),
    ...skills
      .filter((entry) => entry.kind === 'runtime-skill' && entry.readiness === 'missing-runtime')
      .map((entry) => ({
        code: 'runtime-skill-unavailable' as const,
        capabilityKind: 'runtime-skill' as const,
        capabilityId: entry.skill.id,
        message: `Runtime skill "${entry.skill.name}" is imported but has no executable runtime.`,
        hardBlocker: false
      })),
    ...mcpServers
      .filter((entry) => entry.readiness === 'missing-client')
      .map((entry) => ({
        code: 'required-mcp-missing' as const,
        capabilityKind: 'mcp-server' as const,
        capabilityId: entry.server.id,
        message: `MCP server "${entry.server.name}" is configured without a registered client.`,
        hardBlocker: false
      }))
  ];

  const entries: CapabilityHubEntry[] = [
    ...providers.map((entry) => ({
      id: entry.profile.id,
      kind: 'provider' as const,
      scope: 'global' as const,
      name: entry.profile.label,
      readiness: entry.readiness,
      detail: `${entry.adapter.vendor}/${entry.adapter.transport} -> ${entry.model.modelId}`
    })),
    ...mcpServers.map((entry) => ({
      id: entry.server.id,
      kind: 'mcp-server' as const,
      scope: 'global' as const,
      name: entry.server.name,
      readiness: entry.readiness,
      detail: `${entry.server.transport}${entry.capability ? ' with runtime capability' : ''}; tools=${entry.availableTools.length}; resources=${entry.availableResources.length}; prompts=${entry.availablePrompts.length}`
    })),
    ...skills.map((entry) => ({
      id: entry.skill.id,
      kind: entry.kind,
      scope: 'global' as const,
      name: entry.skill.name,
      readiness: entry.readiness,
      detail: entry.kind === 'instruction-skill'
        ? 'instruction bundle'
        : 'runtime executable'
    })),
    ...params.workspace.commands.map((command) => ({
      id: command.name,
      kind: 'workspace-command' as const,
      scope: 'workspace' as const,
      name: command.name,
      readiness: 'ready' as const,
      detail: command.description ?? 'workspace command'
    })),
    ...params.workspace.agents.map((agent) => ({
      id: agent.name,
      kind: 'workspace-agent' as const,
      scope: 'workspace' as const,
      name: agent.name,
      readiness: 'ready' as const,
      detail: agent.description ?? 'workspace agent'
    }))
  ];

  const ready = entries.filter((entry) => entry.readiness === 'ready').length;
  const partial = entries.filter((entry) => entry.readiness === 'partial' || entry.readiness === 'metadata-only').length;
  const blocked = entries.filter((entry) => ['missing-secret', 'missing-runtime', 'missing-client', 'disabled'].includes(entry.readiness)).length;

  return {
    summary: {
      total: entries.length,
      ready,
      partial,
      blocked
    },
    providers,
    mcpServers,
    skills,
    workspace: {
      commands: params.workspace.commands,
      agents: params.workspace.agents,
      rules: params.workspace.rules,
      hooks: params.workspace.hooks
    },
    entries,
    warnings
  };
}
