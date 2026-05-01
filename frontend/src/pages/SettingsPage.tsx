import { type ComponentType, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api/client';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { AdminModal } from '../components/ui/admin-modal';
import { CompactEmptyState } from '../components/ui/compact-empty-state';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { EmptyState } from '../components/ui/empty-state';
import { ExpandableRow } from '../components/ui/expandable-row';
import { IconActionButton } from '../components/ui/icon-action-button';
import {
  CapabilityIcon,
  ConnectionIcon,
  ImprovementsIcon,
  RefreshIcon,
  SkillsIcon,
  SlidersIcon,
  StateIcon,
} from '../components/ui/icons';
import { ToastHost, type ToastItem, type ToastTone } from '../components/ui/toast-host';
import {
  ManagementTable,
  ManagementTableBody,
  ManagementTableHeader,
  ManagementTableRow,
} from '../components/ui/management-table';
import { PaginationBar } from '../components/ui/pagination-bar';
import { SelectInput } from '../components/ui/select-input';
import { Skeleton } from '../components/ui/skeleton';
import { StatusSwitch } from '../components/ui/status-switch';
import { AdminPageShell } from '../components/workbench/AdminPageShell';
import { PageHeader } from '../components/workbench/PageHeader';
import { ReadinessList } from '../components/workbench/ReadinessList';
import { SummaryStrip } from '../components/workbench/SummaryStrip';
import { CapabilitiesSettingsSection } from '../components/settings/CapabilitiesSettingsSection';
import { ConnectionsSettingsSection } from '../components/settings/ConnectionsSettingsSection';
import { SkillsSettingsSection } from '../components/settings/SkillsSettingsSection';
import { usePlatformOverview } from '../hooks/usePlatformOverview';
import { buildPlatformReadinessModel } from '../lib/workbench';
import type { SummaryStripItem } from '../lib/workbench';
import type {
  ImprovementProposal,
  McpCatalogEntry,
  SkillCatalogEntry,
} from '../types';

type SettingsPageKey = 'general' | 'connections' | 'capabilities' | 'ecosystem' | 'skills' | 'state' | 'improvements';

interface McpDraft {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'ws';
  command: string;
  args: string;
  url: string;
}

interface SkillEditorDraft {
  id: string;
  name: string;
  description: string;
  kind: 'runtime-skill' | 'instruction-skill';
  content: string;
}

interface SkillImportDraft {
  id: string;
  name: string;
  rootDir: string;
  description: string;
  kind: 'runtime-skill' | 'instruction-skill';
}

interface MarketplaceImportDraft {
  marketplaceFile: string;
  pluginName: string;
  skillPath: string;
}

interface DeleteIntent {
  id: string;
  label: string;
}

const MANAGEMENT_PAGE_SIZE = 10;
const SETTINGS_NOTICE_TTL_MS = 3_200;
const SETTINGS_NOTICE_DEDUPE_WINDOW_MS = 1_800;
const SETTINGS_NOTICE_LIMIT = 3;

const SETTINGS_TABS: Array<{
  key: SettingsPageKey;
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: 'general', to: '/settings/general', label: 'General', icon: SlidersIcon },
  { key: 'connections', to: '/settings/connections', label: 'Connections', icon: ConnectionIcon },
  { key: 'capabilities', to: '/settings/capabilities', label: 'Capabilities', icon: CapabilityIcon },
  { key: 'ecosystem', to: '/settings/ecosystem', label: 'Ecosystem', icon: CapabilityIcon },
  { key: 'skills', to: '/settings/skills', label: 'Skills', icon: SkillsIcon },
  { key: 'state', to: '/settings/state', label: 'State', icon: StateIcon },
  { key: 'improvements', to: '/settings/improvements', label: 'Improvements', icon: ImprovementsIcon },
];

const MCP_TRANSPORTS: Array<McpDraft['transport']> = ['stdio', 'http', 'ws'];

const EMPTY_SKILL_DRAFT: SkillEditorDraft = {
  id: '',
  name: '',
  description: '',
  kind: 'instruction-skill',
  content: '',
};

function getNestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readConfigBoolean(record: Record<string, unknown>, path: string[], fallback = false) {
  const value = getNestedValue(record, path);
  return typeof value === 'boolean' ? value : fallback;
}

function readConfigString(record: Record<string, unknown>, path: string[], fallback = '') {
  const value = getNestedValue(record, path);
  return typeof value === 'string' ? value : fallback;
}

function parseArgString(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeNameToId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createMcpDraft(entry?: McpCatalogEntry | null): McpDraft {
  return {
    id: entry?.server.id ?? '',
    name: entry?.server.name ?? '',
    transport: entry?.server.transport ?? 'stdio',
    command: entry?.server.command ?? '',
    args: entry?.server.args?.join('\n') ?? '',
    url: entry?.server.url ?? '',
  };
}

function createSkillEditorDraft(entry?: SkillCatalogEntry | null): SkillEditorDraft {
  return {
    id: entry?.skill.id ?? '',
    name: entry?.skill.name ?? '',
    description: entry?.skill.description ?? '',
    kind: entry?.kind ?? 'instruction-skill',
    content: entry?.content ?? '',
  };
}

function SectionLead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{eyebrow}</p>
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <p className="text-sm leading-6 text-text-secondary">{description}</p>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <label className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">{children}</label>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

function TextAreaInput(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M13.75 3.75a1.768 1.768 0 1 1 2.5 2.5L8.125 14.375 5 15l.625-3.125L13.75 3.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M4.375 5.625h11.25M7.5 5.625V4.375A.625.625 0 0 1 8.125 3.75h3.75a.625.625 0 0 1 .625.625v1.25m-6.25 0 .625 8.125c.032.41.374.725.785.725h4.68c.41 0 .753-.315.785-.725l.625-8.125" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconButton({
  label,
  onClick,
  variant = 'ghost',
  disabled = false,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  variant?: 'ghost' | 'secondary';
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="h-10 w-10 rounded-full p-0"
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

function EnableSwitch({
  checked,
  disabled = false,
  label,
  onToggle,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onToggle}
      className={`relative inline-flex h-8 w-[3.25rem] flex-shrink-0 items-center rounded-md border transition duration-fast ${
        checked
          ? 'border-accent bg-accent/90'
          : 'border-border-default bg-surface-hover'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-accent/60'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        className={`absolute left-1 h-[1.375rem] w-[1.375rem] rounded-full bg-white shadow-sm transition duration-fast ${
          checked ? 'translate-x-[1.2rem]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface/24 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="mt-1 text-sm leading-6 text-text-secondary">{description}</p>
      </div>
      <input
        data-testid={testId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-border-default accent-[color:var(--accent)]"
      />
    </label>
  );
}

function ProposalBadge({ proposal }: { proposal: ImprovementProposal }) {
  const variant = proposal.status === 'APPROVED'
    ? 'success'
    : proposal.status === 'REJECTED'
      ? 'outline'
      : 'warning';
  const label = proposal.kind === 'experience'
    ? 'Experience'
    : proposal.kind === 'instruction_skill'
      ? 'Instruction skill'
    : proposal.kind === 'optimization'
      ? 'Optimization'
      : 'Lesson';
  return <Badge variant={variant}>{label} · {proposal.status.toLowerCase()}</Badge>;
}

export function SettingsPage({
  pageKey,
  pageTestId,
  title,
  description,
}: {
  pageKey: SettingsPageKey;
  pageTestId: string;
  summaryTestId?: string;
  title: string;
  description: string;
}) {
  const { data, loading, error, reload } = usePlatformOverview();
  const model = useMemo(() => buildPlatformReadinessModel(data), [data]);

  const [notices, setNotices] = useState<ToastItem[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [generalPermissionMode, setGeneralPermissionMode] = useState<'full' | 'ask' | 'read-only'>('full');
  const [generalSseFallback, setGeneralSseFallback] = useState(false);
  const [generalDelegationEnabled, setGeneralDelegationEnabled] = useState(false);
  const [mcpDrafts, setMcpDrafts] = useState<Record<string, McpDraft>>({});
  const [newMcpDraft, setNewMcpDraft] = useState<McpDraft>(createMcpDraft(null));
  const [currentMcpPage, setCurrentMcpPage] = useState(1);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpModalMode, setMcpModalMode] = useState<'create' | 'edit'>('create');
  const [mcpModalTargetId, setMcpModalTargetId] = useState<string | null>(null);
  const [mcpModalDraft, setMcpModalDraft] = useState<McpDraft>(createMcpDraft(null));
  const [mcpDeleteIntent, setMcpDeleteIntent] = useState<DeleteIntent | null>(null);
  const [skillImportDraft, setSkillImportDraft] = useState<SkillImportDraft>({
    id: '',
    name: '',
    rootDir: '',
    description: '',
    kind: 'instruction-skill',
  });
  const [marketplaceDraft, setMarketplaceDraft] = useState<MarketplaceImportDraft>({
    marketplaceFile: '',
    pluginName: '',
    skillPath: '',
  });
  const [currentSkillsPage, setCurrentSkillsPage] = useState(1);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [skillModalMode, setSkillModalMode] = useState<'create' | 'edit' | 'duplicate'>('create');
  const [skillModalTargetId, setSkillModalTargetId] = useState<string | null>(null);
  const [skillModalDraft, setSkillModalDraft] = useState<SkillEditorDraft>(EMPTY_SKILL_DRAFT);
  const [skillDeleteIntent, setSkillDeleteIntent] = useState<DeleteIntent | null>(null);
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, string>>({});
  const [improvementFilter, setImprovementFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'conflicted' | 'duplicates' | 'archive-eligible'>('all');
  const [expandedImprovementId, setExpandedImprovementId] = useState<string | null>(null);
  const [expandedArchiveId, setExpandedArchiveId] = useState<string | null>(null);
  const [showAllImprovements, setShowAllImprovements] = useState(false);
  const [showAllArchive, setShowAllArchive] = useState(false);

  useEffect(() => {
    if (!data) {
      return;
    }
    setGeneralPermissionMode(
      readConfigString(data.configState.current, ['tools', 'permissionMode'], 'full') as 'full' | 'ask' | 'read-only'
    );
    setGeneralSseFallback(readConfigBoolean(data.configState.current, ['server', 'enableSseFallback'], false));
    setGeneralDelegationEnabled(readConfigBoolean(data.configState.current, ['runtime', 'delegation', 'enabled'], false));
    setMcpDrafts(Object.fromEntries(data.mcpServers.map((entry) => [entry.server.id, createMcpDraft(entry)])));
  }, [data]);

  useEffect(() => {
    if (notices.length === 0) {
      return undefined;
    }

    const timers = notices.map((notice) => window.setTimeout(() => {
      setNotices((current) => current.filter((entry) => entry.id !== notice.id));
    }, Math.max(400, SETTINGS_NOTICE_TTL_MS - (Date.now() - notice.createdAt))));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [notices]);

  const dismissNotice = (id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  };

  const setMessage = (tone: ToastTone, message: string) => {
    const normalized = message.trim();
    if (!normalized) {
      return;
    }
    const createdAt = Date.now();
    setNotices((current) => {
      const duplicate = current.find(
        (notice) =>
          notice.tone === tone
          && notice.message === normalized
          && createdAt - notice.createdAt < SETTINGS_NOTICE_DEDUPE_WINDOW_MS,
      );

      if (duplicate) {
        return [
          ...current.filter((notice) => notice.id !== duplicate.id),
          { ...duplicate, createdAt },
        ].slice(-SETTINGS_NOTICE_LIMIT);
      }

      return [
        ...current,
        { id: createdAt + current.length, tone, message: normalized, createdAt },
      ].slice(-SETTINGS_NOTICE_LIMIT);
    });
  };

  const runAction = async <T,>(key: string, action: () => Promise<T>, successMessage: string, options?: { reload?: boolean }) => {
    try {
      setBusyKey(key);
      const result = await action();
      if (options?.reload !== false) {
        await reload();
      }
      setMessage('success', successMessage);
      return result;
    } catch (actionError) {
      setMessage('error', actionError instanceof Error ? actionError.message : 'Action failed.');
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const openCreateMcpModal = () => {
    setMcpModalMode('create');
    setMcpModalTargetId(null);
    setMcpModalDraft(createMcpDraft(null));
    setMcpModalOpen(true);
  };

  const openEditMcpModal = (entry: McpCatalogEntry) => {
    setMcpModalMode('edit');
    setMcpModalTargetId(entry.server.id);
    setMcpModalDraft(mcpDrafts[entry.server.id] ?? createMcpDraft(entry));
    setMcpModalOpen(true);
  };

  const closeMcpModal = () => {
    setMcpModalOpen(false);
    setMcpModalTargetId(null);
  };

  const openCreateSkillModal = () => {
    setSkillModalMode('create');
    setSkillModalTargetId(null);
    setSkillModalDraft({
      ...EMPTY_SKILL_DRAFT,
      id: `generated-skill-${Date.now()}`,
      name: 'New instruction skill',
      content: '## Goal\n\nDescribe the reusable instruction flow.\n'
    });
    setSkillModalOpen(true);
  };

  const openEditSkillModal = (entry: SkillCatalogEntry) => {
    setSkillModalMode('edit');
    setSkillModalTargetId(entry.skill.id);
    setSkillModalDraft(createSkillEditorDraft(entry));
    setSkillModalOpen(true);
  };

  const openDuplicateSkillModal = (entry: SkillCatalogEntry) => {
    setSkillModalMode('duplicate');
    setSkillModalTargetId(entry.skill.id);
    setSkillModalDraft({
      ...createSkillEditorDraft(entry),
      id: `${normalizeNameToId(entry.skill.name)}-copy`,
      name: `${entry.skill.name} copy`,
    });
    setSkillModalOpen(true);
  };

  const closeSkillModal = () => {
    setSkillModalOpen(false);
    setSkillModalTargetId(null);
  };

  const pageDescription = useMemo(() => {
    switch (pageKey) {
      case 'general':
        return 'Keep the default file-backed posture portable and predictable.';
      case 'connections':
        return 'Edit providers, secrets, and transport defaults without leaving Settings.';
      case 'capabilities':
        return 'Manage workflow bootstrap, docs import, and MCP reach from one place.';
      case 'ecosystem':
        return 'Inspect the AI IDE ecosystem: providers, MCP, skills, experience, tools, scenario packs, and workspace commands.';
      case 'skills':
        return 'Refresh and import runtime skills without dropping into the CLI.';
      case 'state':
        return 'Refresh runtime posture and reload config when the workspace drifts.';
      case 'improvements':
        return 'Review generated lessons, experience references, instruction-skill candidates, and optimization suggestions.';
      default:
        return description;
    }
  }, [description, pageKey]);

  const filteredImprovements = useMemo(() => {
    const proposals = data?.improvements ?? [];
    switch (improvementFilter) {
      case 'all':
        return proposals;
      case 'conflicted':
        return proposals.filter((proposal) => proposal.conflictsWithProposalIds.length > 0);
      case 'duplicates':
        return proposals.filter((proposal) => Boolean(proposal.duplicateOfProposalId));
      case 'archive-eligible':
        return proposals.filter((proposal) => proposal.archiveEligible);
      default:
        return proposals.filter((proposal) => proposal.status.toLowerCase() === improvementFilter);
    }
  }, [data?.improvements, improvementFilter]);

  useEffect(() => {
    if (!expandedImprovementId) {
      return;
    }
    if (!filteredImprovements.some((proposal) => proposal.proposalId === expandedImprovementId)) {
      setExpandedImprovementId(null);
    }
  }, [expandedImprovementId, filteredImprovements]);

  useEffect(() => {
    setShowAllImprovements(false);
  }, [improvementFilter]);

  useEffect(() => {
    if (!expandedArchiveId) {
      return;
    }
    const archive = data?.archive ?? [];
    if (!archive.some((entry) => entry.archiveEntryId === expandedArchiveId)) {
      setExpandedArchiveId(null);
    }
  }, [data?.archive, expandedArchiveId]);

  const readinessSummaryItems = useMemo(() => model.summaryItems, [model]);
  const configuredDefaultProviderId = useMemo(() => {
    const currentConfig = data?.configState.current;
    if (!currentConfig) {
      return null;
    }
    const configured = readConfigString(currentConfig, ['providers', 'defaultProviderId'], '').trim();
    return configured || null;
  }, [data?.configState.current]);
  const runtimeDefaultProviderId = useMemo(() => {
    const providerDefault = (data?.providers ?? []).find((provider) => provider.isRuntimeDefault || provider.isDefault)?.profile.id?.trim();
    return providerDefault || null;
  }, [data?.providers]);
  const resolvedDefaultProviderId = useMemo(() => {
    if (configuredDefaultProviderId) {
      return configuredDefaultProviderId;
    }
    const savedConfigured = data?.configState.savedDefaultProviderId?.trim();
    if (savedConfigured) {
      return savedConfigured;
    }
    const savedProviderDefault = (data?.providers ?? []).find((provider) => provider.isSavedDefault || provider.isDefault)?.profile.id?.trim();
    if (savedProviderDefault) {
      return savedProviderDefault;
    }
    return runtimeDefaultProviderId;
  }, [configuredDefaultProviderId, data?.configState.savedDefaultProviderId, data?.providers, runtimeDefaultProviderId]);
  const effectiveProviders = useMemo(() => data?.providers ?? [], [data?.providers]);
  const orderedMcpServers = useMemo(
    () => [...(data?.mcpServers ?? [])].sort((left, right) => left.server.name.localeCompare(right.server.name)),
    [data?.mcpServers]
  );
  const totalMcpPages = useMemo(
    () => Math.max(1, Math.ceil(orderedMcpServers.length / MANAGEMENT_PAGE_SIZE)),
    [orderedMcpServers.length]
  );
  const pagedMcpServers = useMemo(() => {
    const start = (currentMcpPage - 1) * MANAGEMENT_PAGE_SIZE;
    return orderedMcpServers.slice(start, start + MANAGEMENT_PAGE_SIZE);
  }, [currentMcpPage, orderedMcpServers]);
  const orderedSkills = useMemo(
    () => [...(data?.skills ?? [])].sort((left, right) => left.skill.name.localeCompare(right.skill.name)),
    [data?.skills]
  );
  const totalSkillPages = useMemo(
    () => Math.max(1, Math.ceil(orderedSkills.length / MANAGEMENT_PAGE_SIZE)),
    [orderedSkills.length]
  );
  const pagedSkills = useMemo(() => {
    const start = (currentSkillsPage - 1) * MANAGEMENT_PAGE_SIZE;
    return orderedSkills.slice(start, start + MANAGEMENT_PAGE_SIZE);
  }, [currentSkillsPage, orderedSkills]);
  const providerSummaryItems = useMemo<SummaryStripItem[]>(() => {
    const providers = effectiveProviders;
    const secretLinkedCount = providers.filter((provider) => provider.hasSecret).length;
    const readyCount = providers.filter((provider) => provider.readiness.toLowerCase() === 'ready').length;
    const savedDefaultProvider = resolvedDefaultProviderId
      ? providers.find((provider) => provider.profile.id === resolvedDefaultProviderId) ?? null
      : null;
    const runtimeDefaultProvider = runtimeDefaultProviderId
      ? providers.find((provider) => provider.profile.id === runtimeDefaultProviderId) ?? null
      : null;
    const providerStatesAligned = Boolean(
      savedDefaultProvider
      && runtimeDefaultProvider
      && savedDefaultProvider.profile.id === runtimeDefaultProvider.profile.id
    );
    const runtimeStateLabel = savedDefaultProvider
      ? providerStatesAligned
        ? 'in sync'
        : (data?.configState.restartRequired ? 'reload required' : 'runtime pending')
      : runtimeDefaultProvider
        ? 'runtime only'
        : 'unset';
    const runtimeStateNote = savedDefaultProvider
      ? providerStatesAligned
        ? 'Saved and runtime provider truth match.'
        : data?.configState.restartRequired
          ? 'The saved default is waiting for reload or restart before runtime switches over.'
          : 'The saved default has not propagated to runtime yet.'
      : runtimeDefaultProvider
        ? 'Runtime is still on an active provider, but no saved default is configured.'
        : 'No provider is enabled in saved config or runtime.';

    return [
      {
        label: 'Saved default',
        value: savedDefaultProvider?.profile.label ?? 'Unset',
        note: savedDefaultProvider?.model.label ?? 'Choose a primary connection.',
        variant: savedDefaultProvider ? 'success' : 'warning',
      },
      {
        label: 'Runtime default',
        value: runtimeDefaultProvider?.profile.label ?? (savedDefaultProvider ? 'Pending switch' : 'Unset'),
        note: runtimeDefaultProvider
          ? 'Current runtime provider truth.'
          : savedDefaultProvider
            ? 'Saved provider is waiting to become active at runtime.'
            : 'No runtime provider is active yet.',
        variant: runtimeDefaultProvider ? 'info' : savedDefaultProvider ? 'warning' : 'outline',
      },
      {
        label: 'Reload state',
        value: runtimeStateLabel,
        note: runtimeStateNote,
        variant: providerStatesAligned ? 'success' : savedDefaultProvider ? 'warning' : 'outline',
      },
      {
        label: 'Ready',
        value: `${readyCount} / ${providers.length}`,
        note: `${secretLinkedCount} profiles have linked credentials.`,
        variant: readyCount > 0 ? 'success' : 'warning',
      },
    ];
  }, [data?.configState.restartRequired, effectiveProviders, resolvedDefaultProviderId, runtimeDefaultProviderId]);

  useEffect(() => {
    setCurrentMcpPage((current) => Math.min(current, totalMcpPages));
  }, [totalMcpPages]);

  useEffect(() => {
    setCurrentSkillsPage((current) => Math.min(current, totalSkillPages));
  }, [totalSkillPages]);

  const renderGeneralPanel = () => (
    <Card className="rounded-lg border-border-subtle bg-surface/30">
      <CardHeader className="py-3.5">
        <SectionLead
          eyebrow="General"
          title="Portable defaults"
          description="Expose only stable runtime flags here. Save the portable baseline, then go back to Tasks."
        />
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel>Permission mode</FieldLabel>
            <SelectInput
              data-testid="settings-general-permission-mode"
              value={generalPermissionMode}
              onChange={(event) => setGeneralPermissionMode(event.target.value as 'full' | 'ask' | 'read-only')}
            >
              <option value="full">Full</option>
              <option value="ask">Ask</option>
              <option value="read-only">Read-only</option>
            </SelectInput>
          </div>
        </div>
        <ToggleRow
          label="Enable SSE fallback"
          description="Keep the fallback transport available on machines where websocket connectivity is unreliable."
          checked={generalSseFallback}
          onChange={setGeneralSseFallback}
          testId="settings-general-sse-fallback"
        />
        <ToggleRow
          label="Enable delegated sub-agents"
          description="Allow the main SCC-Batch agent to spin up one controlled SubSccAgent for a bounded child task when the current thread is eligible."
          checked={generalDelegationEnabled}
          onChange={setGeneralDelegationEnabled}
          testId="settings-general-delegation-enabled"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="settings-general-save"
            disabled={busyKey !== null}
            onClick={() => void runAction(
              'general-save',
              () => api.patchConfig({
                tools: { permissionMode: generalPermissionMode },
                server: { enableSseFallback: generalSseFallback },
                runtime: {
                  delegation: {
                    enabled: generalDelegationEnabled,
                  },
                },
              }),
              'General settings saved.'
            )}
          >
            Save defaults
          </Button>
          <Button
            data-testid="settings-general-reload"
            variant="secondary"
            disabled={busyKey !== null}
            onClick={() => void runAction('general-reload', () => api.reloadConfig(), 'Config reload requested.')}
          >
            Reload config
          </Button>
        </div>
      </CardContent>
    </Card>
  );
  const renderCapabilitiesPanel = () => (
    <div className="space-y-4">
      <Card className="rounded-lg border-border-subtle bg-surface/30">
        <CardHeader className="py-3.5">
          <SectionLead
            eyebrow="Workflow"
            title="Bootstrap the workspace"
            description="Initialize the workflow surface or re-import docs without dropping into the terminal."
          />
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          <Button
            data-testid="settings-capabilities-workflow-init"
            disabled={busyKey !== null}
            onClick={() => void runAction('workflow-init', () => api.initWorkspaceWorkflow(), 'Workspace workflow initialized.')}
          >
            Init workflow
          </Button>
          <Button
            data-testid="settings-capabilities-workflow-import-docs"
            variant="secondary"
            disabled={busyKey !== null}
            onClick={() => void runAction('workflow-import-docs', () => api.importWorkspaceDocs(), 'Workspace docs import completed.')}
          >
            Import docs
          </Button>
        </CardContent>
      </Card>

      <Card className="rounded-lg border-border-subtle bg-surface/24">
        <CardHeader className="py-3.5">
          <SectionLead
            eyebrow="MCP"
            title="Manage MCP servers"
            description="Add, update, test, and remove servers directly from Settings."
          />
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {data?.mcpServers.map((entry) => {
            const draft = mcpDrafts[entry.server.id] ?? createMcpDraft(entry);
            return (
              <div key={entry.server.id} className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-4">
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary">{entry.server.id}</p>
                  <Badge variant={entry.lastTestSummary?.ok === false ? 'warning' : 'outline'}>{entry.readiness}</Badge>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel>ID</FieldLabel>
                    <TextInput
                      data-testid={`settings-capabilities-mcp-id-${entry.server.id}`}
                      value={draft.id}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, id: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Name</FieldLabel>
                    <TextInput
                      data-testid={`settings-capabilities-mcp-name-${entry.server.id}`}
                      value={draft.name}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, name: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Transport</FieldLabel>
                    <SelectInput
                      data-testid={`settings-capabilities-mcp-transport-${entry.server.id}`}
                      value={draft.transport}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, transport: event.target.value as McpDraft['transport'] },
                      }))}
                    >
                      {MCP_TRANSPORTS.map((transport) => (
                        <option key={transport} value={transport}>{transport}</option>
                      ))}
                    </SelectInput>
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Command</FieldLabel>
                    <TextInput
                      data-testid={`settings-capabilities-mcp-command-${entry.server.id}`}
                      value={draft.command}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, command: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <FieldLabel>Args</FieldLabel>
                    <TextAreaInput
                      data-testid={`settings-capabilities-mcp-args-${entry.server.id}`}
                      rows={3}
                      value={draft.args}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, args: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <FieldLabel>URL</FieldLabel>
                    <TextInput
                      data-testid={`settings-capabilities-mcp-url-${entry.server.id}`}
                      value={draft.url}
                      onChange={(event) => setMcpDrafts((current) => ({
                        ...current,
                        [entry.server.id]: { ...draft, url: event.target.value },
                      }))}
                    />
                  </div>
                </div>
                {mcpTestResults[entry.server.id] ? <p className="mt-3 text-sm text-text-secondary">{mcpTestResults[entry.server.id]}</p> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    data-testid={`settings-capabilities-mcp-save-${entry.server.id}`}
                    disabled={busyKey !== null || !draft.id || !draft.name}
                    onClick={() => void runAction(
                      `mcp-save-${entry.server.id}`,
                      () => api.upsertMcpServer(draft.id, {
                        id: draft.id,
                        name: draft.name,
                        transport: draft.transport,
                        command: draft.command || undefined,
                        args: parseArgString(draft.args),
                        url: draft.url || undefined,
                      }),
                      `Saved MCP server ${draft.id}.`
                    )}
                  >
                    Save
                  </Button>
                  <Button
                    data-testid={`settings-capabilities-mcp-test-${entry.server.id}`}
                    variant="secondary"
                    disabled={busyKey !== null}
                    onClick={() => void runAction(
                      `mcp-test-${entry.server.id}`,
                      async () => {
                        const result = await api.testMcpServer(entry.server.id);
                        setMcpTestResults((current) => ({ ...current, [entry.server.id]: result.message }));
                        return result;
                      },
                      `Tested MCP server ${entry.server.id}.`,
                      { reload: false }
                    )}
                  >
                    Test
                  </Button>
                  <Button
                    data-testid={`settings-capabilities-mcp-delete-${entry.server.id}`}
                    variant="ghost"
                    disabled={busyKey !== null}
                    onClick={() => void runAction(
                      `mcp-delete-${entry.server.id}`,
                      () => api.deleteMcpServer(entry.server.id),
                      `Removed MCP server ${entry.server.id}.`
                    )}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}

          <div className="rounded-lg border border-dashed border-border-default bg-surface/12 px-4 py-4">
            <p className="text-sm font-semibold text-text-primary">Add MCP server</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel>ID</FieldLabel>
                <TextInput data-testid="settings-capabilities-mcp-new-id" value={newMcpDraft.id} onChange={(event) => setNewMcpDraft((current) => ({ ...current, id: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Name</FieldLabel>
                <TextInput data-testid="settings-capabilities-mcp-new-name" value={newMcpDraft.name} onChange={(event) => setNewMcpDraft((current) => ({ ...current, name: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Transport</FieldLabel>
                <SelectInput data-testid="settings-capabilities-mcp-new-transport" value={newMcpDraft.transport} onChange={(event) => setNewMcpDraft((current) => ({ ...current, transport: event.target.value as McpDraft['transport'] }))}>
                  {MCP_TRANSPORTS.map((transport) => (
                    <option key={transport} value={transport}>{transport}</option>
                  ))}
                </SelectInput>
              </div>
              <div className="space-y-2">
                <FieldLabel>Command</FieldLabel>
                <TextInput data-testid="settings-capabilities-mcp-new-command" value={newMcpDraft.command} onChange={(event) => setNewMcpDraft((current) => ({ ...current, command: event.target.value }))} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <FieldLabel>Args</FieldLabel>
                <TextAreaInput data-testid="settings-capabilities-mcp-new-args" rows={3} value={newMcpDraft.args} onChange={(event) => setNewMcpDraft((current) => ({ ...current, args: event.target.value }))} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <FieldLabel>URL</FieldLabel>
                <TextInput data-testid="settings-capabilities-mcp-new-url" value={newMcpDraft.url} onChange={(event) => setNewMcpDraft((current) => ({ ...current, url: event.target.value }))} />
              </div>
            </div>
            <div className="mt-4">
              <Button
                data-testid="settings-capabilities-mcp-create"
                disabled={busyKey !== null || !newMcpDraft.id || !newMcpDraft.name}
                onClick={() => void runAction(
                  'mcp-create',
                  async () => {
                    const result = await api.upsertMcpServer(newMcpDraft.id, {
                      id: newMcpDraft.id,
                      name: newMcpDraft.name,
                      transport: newMcpDraft.transport,
                      command: newMcpDraft.command || undefined,
                      args: parseArgString(newMcpDraft.args),
                      url: newMcpDraft.url || undefined,
                    });
                    setNewMcpDraft(createMcpDraft(null));
                    return result;
                  },
                  `Created MCP server ${newMcpDraft.id}.`
                )}
              >
                Add server
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
  const renderSkillsPanel = () => (
    <div className="space-y-4">
      <Card className="rounded-lg border-border-subtle bg-surface/30">
        <CardHeader className="py-3.5">
          <SectionLead
            eyebrow="Skills"
            title="Refresh and import"
            description="Keep runtime skills and imported instruction packs current from one page."
          />
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="settings-skills-refresh"
              disabled={busyKey !== null}
              onClick={() => void runAction('skills-refresh', () => api.refreshSkills(), 'Skill catalog refreshed.')}
            >
              Refresh skills
            </Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-4">
              <p className="text-sm font-semibold text-text-primary">Import local skill</p>
              <div className="mt-3 grid gap-3">
                <div className="space-y-2">
                  <FieldLabel>Root directory</FieldLabel>
                  <TextInput data-testid="settings-skills-import-root" value={skillImportDraft.rootDir} onChange={(event) => setSkillImportDraft((current) => ({ ...current, rootDir: event.target.value }))} />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel>Name</FieldLabel>
                    <TextInput data-testid="settings-skills-import-name" value={skillImportDraft.name} onChange={(event) => setSkillImportDraft((current) => ({ ...current, name: event.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>ID</FieldLabel>
                    <TextInput data-testid="settings-skills-import-id" value={skillImportDraft.id} onChange={(event) => setSkillImportDraft((current) => ({ ...current, id: event.target.value }))} />
                  </div>
                </div>
                <div className="space-y-2">
                  <FieldLabel>Kind</FieldLabel>
                  <SelectInput data-testid="settings-skills-import-kind" value={skillImportDraft.kind} onChange={(event) => setSkillImportDraft((current) => ({ ...current, kind: event.target.value as SkillImportDraft['kind'] }))}>
                    <option value="instruction-skill">instruction-skill</option>
                    <option value="runtime-skill">runtime-skill</option>
                  </SelectInput>
                </div>
                <div className="space-y-2">
                  <FieldLabel>Description</FieldLabel>
                  <TextAreaInput data-testid="settings-skills-import-description" rows={3} value={skillImportDraft.description} onChange={(event) => setSkillImportDraft((current) => ({ ...current, description: event.target.value }))} />
                </div>
                <Button
                  data-testid="settings-skills-import-local"
                  disabled={busyKey !== null || !skillImportDraft.rootDir}
                  onClick={() => void runAction(
                    'skills-import-local',
                    () => api.importSkill({
                      id: skillImportDraft.id || undefined,
                      name: skillImportDraft.name || undefined,
                      rootDir: skillImportDraft.rootDir,
                      description: skillImportDraft.description || undefined,
                      kind: skillImportDraft.kind,
                    }),
                    'Local skill imported.'
                  )}
                >
                  Import local skill
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-4">
              <p className="text-sm font-semibold text-text-primary">Import from marketplace</p>
              <div className="mt-3 grid gap-3">
                <div className="space-y-2">
                  <FieldLabel>Marketplace file</FieldLabel>
                  <TextInput data-testid="settings-skills-marketplace-file" value={marketplaceDraft.marketplaceFile} onChange={(event) => setMarketplaceDraft((current) => ({ ...current, marketplaceFile: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Plugin name</FieldLabel>
                  <TextInput data-testid="settings-skills-marketplace-plugin" value={marketplaceDraft.pluginName} onChange={(event) => setMarketplaceDraft((current) => ({ ...current, pluginName: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Skill path</FieldLabel>
                  <TextInput data-testid="settings-skills-marketplace-path" value={marketplaceDraft.skillPath} onChange={(event) => setMarketplaceDraft((current) => ({ ...current, skillPath: event.target.value }))} />
                </div>
                <Button
                  data-testid="settings-skills-import-marketplace"
                  disabled={busyKey !== null || !marketplaceDraft.marketplaceFile || !marketplaceDraft.pluginName}
                  onClick={() => void runAction(
                    'skills-import-marketplace',
                    () => api.importMarketplaceSkills({
                      marketplaceFile: marketplaceDraft.marketplaceFile,
                      pluginName: marketplaceDraft.pluginName,
                      skillPath: marketplaceDraft.skillPath || undefined,
                    }),
                    'Marketplace skill import completed.'
                  )}
                >
                  Import marketplace skill
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const renderEcosystemPanel = () => {
    const ecosystem = data?.ecosystem;
    const summary = ecosystem?.summary;
    const ecosystemSummaryItems: SummaryStripItem[] = [
      {
        label: 'Providers',
        value: summary ? `${summary.readyProviders} / ${summary.providers}` : '0 / 0',
        note: 'Ready provider/model connections.',
        variant: (summary?.readyProviders ?? 0) > 0 ? 'success' : 'warning',
      },
      {
        label: 'MCP',
        value: summary ? `${summary.readyMcpServers} / ${summary.mcpServers}` : '0 / 0',
        note: 'Configured and runtime-available MCP servers.',
        variant: (summary?.mcpServers ?? 0) > 0 ? 'success' : 'outline',
      },
      {
        label: 'Tools',
        value: summary ? `${summary.acceptanceEvidenceTools} / ${summary.tools}` : '0 / 0',
        note: 'Tools that can produce acceptance evidence.',
        variant: (summary?.acceptanceEvidenceTools ?? 0) > 0 ? 'info' : 'warning',
      },
      {
        label: 'Experience',
        value: ecosystem?.experiences.approved ?? 0,
        note: `${ecosystem?.experiences.promotable ?? 0} promotable, ${ecosystem?.experiences.conflicted ?? 0} conflicted.`,
        variant: (ecosystem?.experiences.conflicted ?? 0) > 0 ? 'warning' : 'outline',
      },
      {
        label: 'Scenario packs',
        value: summary?.scenarioPacks ?? 0,
        note: 'Reusable focused validation packs outside the generic runner.',
        variant: (summary?.scenarioPacks ?? 0) > 0 ? 'success' : 'outline',
      },
    ];

    return (
      <div className="space-y-4" data-testid="settings-ecosystem-section">
        <Card className="rounded-lg border-border-subtle bg-surface/30">
          <CardHeader className="py-3.5">
            <SectionLead
              eyebrow="Ecosystem"
              title="AI IDE ecosystem registry"
              description="One readiness view for providers, MCP, skills, approved experience, tools, scenario packs, and workspace commands."
            />
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <SummaryStrip items={ecosystemSummaryItems} />
            {(ecosystem?.warnings.length ?? 0) > 0 ? (
              <div className="rounded-lg border border-warning/22 bg-warning-muted/12 px-4 py-3">
                <p className="text-sm font-semibold text-text-primary">Warnings</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                  {(ecosystem?.warnings ?? []).slice(0, 6).map((warning) => (
                    <li key={`${warning.code}-${warning.capabilityId ?? warning.message}`}>
                      {warning.code}: {warning.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="rounded-lg border-border-subtle bg-surface/26">
            <CardHeader className="py-3.5">
              <SectionLead
                eyebrow="Runtime"
                title="Providers and MCP"
                description="Provider/model truth and MCP readiness without turning task creation into a configuration screen."
              />
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {(ecosystem?.providers ?? []).slice(0, 6).map((provider) => (
                <div key={provider.profile.id} className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{provider.profile.label}</p>
                      <p className="mt-1 text-xs text-text-secondary">{provider.adapter.transport} · {provider.model.modelId}</p>
                    </div>
                    <Badge variant={provider.readiness === 'ready' ? 'success' : provider.readiness === 'missing-secret' ? 'warning' : 'outline'}>
                      {provider.readiness}
                    </Badge>
                  </div>
                </div>
              ))}
              {(ecosystem?.mcpServers ?? []).slice(0, 6).map((server) => (
                <div key={server.server.id} className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{server.server.name}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        tools={server.availableTools.length} · resources={server.availableResources.length} · prompts={server.availablePrompts.length}
                      </p>
                    </div>
                    <Badge variant={server.readiness === 'ready' ? 'success' : 'outline'}>{server.readiness}</Badge>
                  </div>
                </div>
              ))}
              {!ecosystem?.providers.length && !ecosystem?.mcpServers.length ? (
                <CompactEmptyState title="No runtime ecosystem entries" description="Providers and MCP entries will appear after backend startup." />
              ) : null}
            </CardContent>
          </Card>

          <Card className="rounded-lg border-border-subtle bg-surface/26">
            <CardHeader className="py-3.5">
              <SectionLead
                eyebrow="Capabilities"
                title="Tools, skills, and experience"
                description="Tool evidence shapes and approved experience health are visible here before they influence real tasks."
              />
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Instruction skills</p>
                  <p className="mt-2 text-xl font-semibold text-text-primary">{summary?.instructionSkills ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Approved experience</p>
                  <p className="mt-2 text-xl font-semibold text-text-primary">{ecosystem?.experiences.approved ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Workspace commands</p>
                  <p className="mt-2 text-xl font-semibold text-text-primary">{summary?.workspaceCommands ?? 0}</p>
                </div>
              </div>
              <div className="space-y-2">
                {(ecosystem?.tools ?? []).slice(0, 8).map((tool) => (
                  <div key={tool.id} className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{tool.name}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{tool.evidenceShape}</p>
                      <p className="mt-1 text-xs text-text-muted">
                        Health: {tool.healthCheck.status}
                        {tool.healthCheck.diagnostics.length > 0 ? ` · ${tool.healthCheck.diagnostics.slice(0, 2).join(', ')}` : ''}
                      </p>
                    </div>
                    <Badge variant={tool.healthCheck.status === 'ready' ? 'success' : tool.healthCheck.status === 'blocked' ? 'warning' : 'outline'}>
                      {tool.acceptanceEvidence ? 'evidence' : tool.healthCheck.status}
                    </Badge>
                  </div>
                ))}
              </div>
              {(ecosystem?.experiences.approvedDetails.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  {(ecosystem?.experiences.approvedDetails ?? []).slice(0, 4).map((experience) => (
                    <div key={experience.proposalId} className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{experience.title}</p>
                          <p className="mt-1 text-xs text-text-secondary">
                            {experience.successfulReuseTaskIds.length} successful reuse · {experience.failedReuseTaskIds.length} failed reuse
                          </p>
                        </div>
                        <Badge variant={experience.validationStatus === 'promotable' ? 'success' : experience.validationStatus === 'conflicted' ? 'warning' : 'outline'}>
                          {experience.validationStatus}
                        </Badge>
                      </div>
                      <p className="mt-2 truncate text-xs text-text-muted">{experience.materializedPath ?? experience.patternKey}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-lg border-border-subtle bg-surface/26">
          <CardHeader className="py-3.5">
            <SectionLead
              eyebrow="Scenario packs"
              title="Reusable validation packs"
              description="Generic harness submits, observes, and reports; pack-specific quality and artifact rules stay in the pack layer."
            />
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(ecosystem?.scenarioPacks ?? []).map((pack) => (
              <div key={pack.id} className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{pack.label}</p>
                    <p className="mt-1 text-xs text-text-secondary">{pack.focus}</p>
                  </div>
                  <Badge variant={pack.status === 'ready' ? 'success' : 'outline'}>{pack.status}</Badge>
                </div>
                <p className="mt-3 text-xs text-text-muted">
                  Core quality: {pack.qualityProfileId ?? 'none'} · Scenario gate: {pack.qualityGateId ?? 'none'} · Model: {pack.modelPolicy.defaultModelClass} · Turns: {pack.timeoutPolicy.maxTurns}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
                  Checks: {pack.surfaceChecks.join(', ')}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderStatePanel = () => (
    <div className="space-y-4">
      <Card className="rounded-lg border-border-subtle bg-surface/26">
        <CardHeader className="flex items-center justify-between gap-3 py-3.5">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Readiness detail</p>
            <h2 className="mt-1.5 text-lg font-semibold text-text-primary">What the runtime can actually rely on</h2>
            <p className="mt-1 text-sm text-text-secondary">Use this page when you need the deeper posture, warning, and drift view.</p>
          </div>
          <Badge variant={model.warnings + model.configIssues > 0 ? 'warning' : 'success'}>
            {model.warnings + model.configIssues > 0 ? 'attention' : 'stable'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : (
            <ReadinessList items={model.readinessItems} />
          )}
          {model.providers + model.skills + model.mcpServers + model.workflowAssets === 0 ? (
            <EmptyState
              title="No platform inventory surfaced yet"
              description="Refresh once the backend is warmed up. This page is ready to show runtime inventory as soon as the backend exposes it."
              variant="compact"
            />
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-lg border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-3.5 lg:flex-row lg:items-start lg:justify-between">
          <SectionLead
            eyebrow="State"
            title="Refresh posture and reload config"
            description="Use State to confirm current runtime health and recover after config drift."
          />
          <div className="flex flex-wrap gap-2">
            <IconActionButton
              label="Refresh runtime status"
              testId="settings-state-refresh-status"
              disabled={busyKey !== null}
              onClick={() => void runAction('state-refresh', async () => {
                await reload();
                return true;
              }, 'Runtime status refreshed.', { reload: false })}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
                <path d="M15.625 10a5.625 5.625 0 1 1-1.648-3.977M15.625 4.375v3.75h-3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconActionButton>
            <IconActionButton
              label="Reload config"
              testId="settings-state-config-reload"
              variant="secondary"
              disabled={busyKey !== null}
              onClick={() => void runAction('state-reload', () => api.reloadConfig(), 'Config reload requested.')}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
                <path d="M10 3.75v3.75M10 12.5v3.75M3.75 10h3.75M12.5 10h3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </IconActionButton>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Reload posture</p>
              <p className="mt-2 text-sm font-medium text-text-primary">
                {data?.configState.reloadApplied ? 'Config is applied.' : 'Config reload is still pending.'}
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                {data?.configState.restartRequired ? 'A restart is still required for part of the config.' : 'No restart is required right now.'}
              </p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Fingerprint</p>
              <p className="mt-2 break-all text-sm text-text-primary">{data?.configState.effectiveFingerprint ?? 'Unavailable'}</p>
            </div>
          </div>
          {(data?.configHealth.issues?.length ?? 0) > 0 ? (
            <div className="rounded-lg border border-warning/22 bg-warning-muted/12 px-4 py-3">
              <p className="text-sm font-semibold text-text-primary">Warnings to review</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {(data?.configHealth.issues ?? []).map((issue, index) => (
                  <li key={`${issue.code ?? 'warning'}-${index}`}>{issue.message ?? issue.code ?? 'Runtime warning'}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );

  const renderImprovementsPanel = () => {
    const proposals = filteredImprovements;
    const archive = data?.archive ?? [];
    const report = data?.complexReport ?? null;
    const defaultVisibleCount = 4;
    const hasMoreProposals = proposals.length > defaultVisibleCount;
    const hasMoreArchive = archive.length > defaultVisibleCount;
    const visibleProposals = showAllImprovements ? proposals : proposals.slice(0, defaultVisibleCount);
    const visibleArchive = showAllArchive ? archive : archive.slice(0, defaultVisibleCount);
    const hiddenProposalCount = Math.max(0, proposals.length - defaultVisibleCount);
    const hiddenArchiveCount = Math.max(0, archive.length - defaultVisibleCount);

    return (
      <div className="space-y-4">
        <Card className="rounded-lg border-border-subtle bg-surface/30">
          <CardHeader className="py-3.5">
              <SectionLead
                eyebrow="Improvements"
                title="Proposal-only improvement inbox"
                description="Review generated lessons, experience references, instruction-skill candidates, and optimization recommendations before anything is promoted."
              />
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Proposals</p>
                  <p className="mt-2 text-xl font-semibold text-text-primary">{data?.improvements.length ?? 0}</p>
                  <p className="mt-1 text-sm text-text-secondary">Generated post-task and held for operator review before promotion.</p>
                </div>
              <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Archive eligible</p>
                <p className="mt-2 text-xl font-semibold text-text-primary">{report?.archiveEligibleCount ?? archive.length}</p>
                <p className="mt-1 text-sm text-text-secondary">Complex real tasks retained as durable truth evidence.</p>
              </div>
              <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Governance noise</p>
                <p className="mt-2 text-xl font-semibold text-text-primary">
                  {(report?.duplicateProposalCount ?? 0) + (report?.conflictedProposalCount ?? 0)}
                </p>
                <p className="mt-1 text-sm text-text-secondary">Duplicate and conflicted proposals waiting for cleanup.</p>
              </div>
                <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Experience refs</p>
                  <p className="mt-2 text-xl font-semibold text-text-primary">{report?.generatedExperienceCount ?? 0}</p>
                  <p className="mt-1 text-sm text-text-secondary">Approved reference experiences waiting for repeated runtime validation before instruction-skill promotion.</p>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                ['all', 'All'],
                ['pending', 'Pending'],
                ['approved', 'Approved'],
                ['rejected', 'Rejected'],
                ['conflicted', 'Conflicted'],
                ['duplicates', 'Duplicates'],
                ['archive-eligible', 'Archive eligible'],
              ].map(([key, label]) => (
                <Button
                  key={key}
                  variant={improvementFilter === key ? 'primary' : 'secondary'}
                  onClick={() => setImprovementFilter(key as typeof improvementFilter)}
                  data-testid={`settings-improvements-filter-${key}`}
                >
                  {label}
                </Button>
              ))}
            </div>

            <div className="space-y-3">
              {proposals.length === 0 ? (
                <EmptyState
                  title="No proposals match this filter"
                  description="Terminal tasks will place lesson, experience, instruction-skill, and optimization candidates here once they are archived."
                />
              ) : visibleProposals.map((proposal) => (
                <ExpandableRow
                  key={proposal.proposalId}
                  testId={`settings-improvement-${proposal.proposalId}`}
                  summaryTestId={`settings-improvement-toggle-${proposal.proposalId}`}
                  open={expandedImprovementId === proposal.proposalId}
                  onToggle={() => setExpandedImprovementId((current) => (
                    current === proposal.proposalId ? null : proposal.proposalId
                  ))}
                  summary={(
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-text-primary">{proposal.title}</p>
                          <ProposalBadge proposal={proposal} />
                          {proposal.archiveEligible ? <Badge variant="info">archive eligible</Badge> : null}
                          {proposal.duplicateOfProposalId ? <Badge variant="warning">duplicate proposal</Badge> : null}
                          {proposal.conflictsWithProposalIds.length > 0 ? <Badge variant="warning">conflicting proposal</Badge> : null}
                          {proposal.supersededByProposalId ? <Badge variant="outline">superseded proposal</Badge> : null}
                        </div>
                          <p className="mt-1 line-clamp-1 text-xs leading-5 text-text-secondary">
                            {(proposal.kind === 'instruction_skill' ? 'instruction skill' : proposal.kind).replace('_', ' ')} · {proposal.status.toLowerCase()} · Evidence {proposal.evidenceTaskIds.length} · Quality {proposal.qualityScore.toFixed(2)}
                          </p>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-text-muted">
                        <p>{proposal.experienceReport.outcome}</p>
                        <p className="mt-1">{proposal.experienceReport.truthCompleteness}</p>
                      </div>
                    </div>
                  )}
                  details={(
                    <div className="space-y-3">
                      <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-3">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Summary</p>
                        <p className="mt-2 text-sm leading-6 text-text-primary">{proposal.summary}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          disabled={busyKey !== null || proposal.status === 'APPROVED'}
                          onClick={() => void runAction(
                            `approve-${proposal.proposalId}`,
                            () => api.approveImprovementProposal(proposal.proposalId),
                            'Improvement proposal approved.'
                          )}
                          data-testid={`settings-improvement-approve-${proposal.proposalId}`}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busyKey !== null || proposal.status === 'REJECTED'}
                          onClick={() => void runAction(
                            `reject-${proposal.proposalId}`,
                            () => api.rejectImprovementProposal(proposal.proposalId),
                            'Improvement proposal rejected.'
                          )}
                          data-testid={`settings-improvement-reject-${proposal.proposalId}`}
                        >
                          Reject
                        </Button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-3">
                          <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Evidence</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {proposal.evidenceTaskIds.slice(0, 4).map((taskId) => (
                              <span key={taskId} className="rounded-md border border-border-default bg-surface px-3 py-1 text-xs text-text-primary">
                                {taskId}
                              </span>
                            ))}
                            {proposal.evidenceTaskIds.length > 4 ? (
                              <span className="rounded-md border border-border-default bg-surface px-3 py-1 text-xs text-text-secondary">
                                +{proposal.evidenceTaskIds.length - 4} more
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm text-text-secondary">
                            Outcome: {proposal.experienceReport.outcome} · Artifact quality: {proposal.experienceReport.artifactQuality}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            Evidence count: {proposal.evidenceTaskIds.length} · Quality: {proposal.qualityScore.toFixed(2)}
                          </p>
                          {proposal.kind === 'experience' && proposal.experienceProposal ? (
                            <p className="mt-1 text-sm text-text-secondary">
                              Validation: {proposal.experienceProposal.validationStatus} · success {proposal.experienceProposal.successfulReuseTaskIds.length} · failed {proposal.experienceProposal.failedReuseTaskIds.length}
                            </p>
                          ) : null}
                        </div>
                        <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-3">
                          <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Governance</p>
                            <p className="mt-2 text-sm text-text-primary">
                              {proposal.kind === 'lesson'
                                ? proposal.lessonProposal?.triggerPattern
                                : proposal.kind === 'experience'
                                  ? proposal.experienceProposal?.referenceSummary
                                : proposal.kind === 'instruction_skill'
                                  ? proposal.instructionSkillProposal?.validationSummary
                                  : proposal.optimizationRecommendation?.category}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            Truth completeness: {proposal.experienceReport.truthCompleteness}
                          </p>
                          {proposal.duplicateOfProposalId ? (
                            <p className="mt-1 text-sm text-text-secondary">Merged into: {proposal.duplicateOfProposalId}</p>
                          ) : null}
                          {proposal.conflictsWithProposalIds.length > 0 ? (
                            <p className="mt-1 text-sm text-text-secondary">Conflicts: {proposal.conflictsWithProposalIds.join(', ')}</p>
                          ) : null}
                          {proposal.supersededByProposalId ? (
                            <p className="mt-1 text-sm text-text-secondary">Superseded by: {proposal.supersededByProposalId}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  )}
                />
              ))}
              {hasMoreProposals ? (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="secondary"
                    onClick={() => setShowAllImprovements((current) => !current)}
                    data-testid="settings-improvements-toggle-more"
                  >
                    {showAllImprovements ? 'Show fewer proposals' : `Show ${hiddenProposalCount} more proposals`}
                  </Button>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg border-border-subtle bg-surface/30">
          <CardHeader className="py-3.5">
            <SectionLead
              eyebrow="Archive"
              title="Real complex task archive"
              description="Curated suites stay as the stable floor. This archive captures real terminal tasks that crossed the complexity bar."
            />
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {archive.length === 0 ? (
              <EmptyState
                title="No archived real tasks yet"
                description="Complex terminal tasks will start showing up here once they cross the archive threshold."
              />
              ) : visibleArchive.map((entry) => (
              <ExpandableRow
                key={entry.archiveEntryId}
                testId={`settings-archive-${entry.archiveEntryId}`}
                summaryTestId={`settings-archive-toggle-${entry.archiveEntryId}`}
                open={expandedArchiveId === entry.archiveEntryId}
                onToggle={() => setExpandedArchiveId((current) => (
                  current === entry.archiveEntryId ? null : entry.archiveEntryId
                ))}
                summary={(
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-text-primary">{entry.taskTitle}</p>
                        <Badge variant={entry.lifecycleStatus === 'COMPLETED' ? 'success' : entry.lifecycleStatus === 'FAILED' ? 'error' : 'outline'}>
                          {entry.lifecycleStatus.toLowerCase()}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-text-secondary">
                        Quality {entry.qualityScore.toFixed(2)} · {entry.patternKey} · {entry.archiveEligibility.reason}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-text-muted">
                      <p>{entry.complexitySignals.length} signals</p>
                    </div>
                  </div>
                )}
                details={(
                  <div className="space-y-2 text-sm text-text-secondary">
                    <p>
                      Completion: {entry.truthSummary.completionSummary ?? entry.truthSummary.statusSummary}
                    </p>
                    <p>
                      Signals: {entry.complexitySignals.join(', ') || 'none'}
                    </p>
                    <p>
                      Delivery: {entry.finalDelivery.deliveredTo.join(', ') || entry.finalDelivery.destinationDir || 'not delivered'}
                    </p>
                    <p>
                      Truth summary: {entry.truthSummary.statusSummary}
                    </p>
                  </div>
                )}
                />
            ))}
              {hasMoreArchive ? (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="secondary"
                  onClick={() => setShowAllArchive((current) => !current)}
                  data-testid="settings-archive-toggle-more"
                >
                  {showAllArchive ? 'Show fewer archive entries' : `Show ${hiddenArchiveCount} more archive entries`}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  };

  const secondaryPanel = (() => {
    switch (pageKey) {
      case 'general':
        return renderGeneralPanel();
      case 'connections':
        return (
          <ConnectionsSettingsSection
            providers={effectiveProviders}
            providerPresets={data?.providerPresets ?? []}
            savedDefaultProviderId={resolvedDefaultProviderId}
            runtimeDefaultProviderId={runtimeDefaultProviderId}
            restartRequired={Boolean(data?.configState.restartRequired)}
            summaryItems={providerSummaryItems}
            onReload={reload}
            onNotice={setMessage}
          />
        );
      case 'capabilities':
        return (
          <CapabilitiesSettingsSection
            workflow={data?.workflow ?? {
              workspaceRoot: null,
              sccDir: null,
              projectInstructionsPresent: false,
              projectInstructionsSummary: null,
              commands: [],
              rules: [],
              hooks: [],
              agents: [],
              docsSources: [],
              docsImportSummary: {
                trackedSourceCount: 0,
                importedMemoryCount: 0,
                imported: 0,
                updated: 0,
                skipped: 0,
                importedMemoryIds: [],
                lastImportedAt: null,
              },
            }}
            mcpServers={data?.mcpServers ?? []}
            onReload={reload}
            onNotice={setMessage}
          />
        );
      case 'ecosystem':
        return renderEcosystemPanel();
      case 'skills':
        return (
          <SkillsSettingsSection
            skills={data?.skills ?? []}
            onReload={reload}
            onNotice={setMessage}
          />
        );
      case 'state':
        return renderStatePanel();
      case 'improvements':
        return renderImprovementsPanel();
      default:
        return null;
    }
  })();

  return (
    <div className="h-full overflow-y-auto px-6 py-6" data-testid="settings-page">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <PageHeader
          eyebrow="Settings"
          title={title}
          description={pageDescription}
          badges={[
            {
              label: model.warnings + model.configIssues > 0 ? `${model.warnings + model.configIssues} warning` : 'stable',
              variant: model.warnings + model.configIssues > 0 ? 'warning' : 'success',
            },
            {
              label: model.workflowAssets > 0 ? `${model.workflowAssets} workflow` : 'quiet',
              variant: model.workflowAssets > 0 ? 'info' : 'outline',
            },
          ]}
          actions={(
            <Button data-testid="settings-refresh-status" variant="secondary" onClick={() => void reload()}>
              <RefreshIcon className="h-4 w-4" />
              Refresh status
            </Button>
          )}
        />

        <nav className="flex flex-nowrap gap-1.5 overflow-x-auto pb-1 pr-2 scrollbar-thin sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pb-0 sm:pr-0" data-testid={pageTestId}>
          {SETTINGS_TABS.map((item) => {
            const Icon = item.icon;
            return (
            <NavLink
              key={item.key}
              to={item.to}
              data-testid={`settings-tab-${item.key}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs transition duration-fast sm:px-3.5 sm:py-2 sm:text-sm ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'border border-border-subtle bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`
              }
            >
              <span className="inline-flex items-center gap-2 leading-none">
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                  <Icon className="h-4 w-4 shrink-0 opacity-80" />
                </span>
                <span>{item.label}</span>
              </span>
            </NavLink>
            );
          })}
        </nav>

        {error ? (
          <Card className="rounded-lg border-warning/30 bg-warning-muted/15">
            <CardContent className="px-5 py-4 text-sm text-warning">
              {error}
            </CardContent>
          </Card>
        ) : null}

        <ToastHost notices={notices} onDismiss={dismissNotice} />

        <Card className="rounded-lg border-border-subtle bg-surface/28" data-testid="settings-readiness-summary">
          <CardHeader className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Readiness snapshot</p>
              <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Keep the platform read at a glance, then work in the page below.</h2>
            </div>
            <Badge variant={model.warnings + model.configIssues > 0 ? 'warning' : 'success'}>
              {model.warnings + model.configIssues > 0 ? 'attention' : 'stable'}
            </Badge>
          </CardHeader>
          <CardContent className="pt-0">
            {loading ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-20 rounded-lg" />
                ))}
              </div>
            ) : (
              <SummaryStrip items={readinessSummaryItems} />
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {secondaryPanel}
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;


