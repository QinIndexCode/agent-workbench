import { type ComponentType, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api/client';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { ToastHost, type ToastItem, type ToastTone } from '../components/ui/toast-host';
import {
  CapabilityIcon,
  ConnectionIcon,
  ImprovementsIcon,
  RefreshIcon,
  SettingsIcon,
  SkillsIcon,
  SlidersIcon,
} from '../components/ui/icons';
import { PageHeader } from '../components/workbench/PageHeader';
import { SummaryStrip } from '../components/workbench/SummaryStrip';
import { CapabilitiesSettingsSection } from '../components/settings/CapabilitiesSettingsSection';
import { ConnectionsSettingsSection } from '../components/settings/ConnectionsSettingsSection';
import { EcosystemSettings } from '../components/settings/EcosystemSettings';
import { GeneralSettings } from '../components/settings/GeneralSettings';
import { GovernanceSettingsSection } from '../components/settings/GovernanceSettingsSection';
import { ImprovementsSettings } from '../components/settings/ImprovementsSettings';
import { SkillsSettingsSection } from '../components/settings/SkillsSettingsSection';
import { usePlatformOverview } from '../hooks/usePlatformOverview';
import { buildPlatformReadinessModel } from '../lib/workbench';
import type { SummaryStripItem } from '../lib/workbench';

type SettingsPageKey = 'general' | 'connections' | 'capabilities' | 'ecosystem' | 'skills' | 'governance' | 'improvements';

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
  { key: 'ecosystem', to: '/settings/ecosystem', label: 'Ecosystem', icon: SettingsIcon },
  { key: 'skills', to: '/settings/skills', label: 'Skills', icon: SkillsIcon },
  { key: 'governance', to: '/settings/governance', label: 'Governance', icon: ImprovementsIcon },
  { key: 'improvements', to: '/settings/improvements', label: 'Improvements', icon: ImprovementsIcon },
];

function readConfigString(record: Record<string, unknown>, path: string[], fallback = '') {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return fallback;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : fallback;
}

export function SettingsPage({
  pageKey,
  pageTestId,
  title,
  description,
}: {
  pageKey: SettingsPageKey;
  pageTestId: string;
  title: string;
  description: string;
}) {
  const { data, loading, error, reload } = usePlatformOverview();
  const model = useMemo(() => buildPlatformReadinessModel(data), [data]);

  const [notices, setNotices] = useState<ToastItem[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

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
    if (!normalized) return;
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

  const pageDescription = useMemo(() => {
    switch (pageKey) {
      case 'general':
        return 'System identity, runtime health, and workspace paths.';
      case 'connections':
        return 'Provider connections, secrets, and transport settings.';
      case 'capabilities':
        return 'Workflow bootstrap, MCP servers, and feature management.';
      case 'ecosystem':
        return 'AI provider configurations and model preferences.';
      case 'skills':
        return 'Managed skill catalog and import tools.';
      case 'governance':
        return 'Experience governance and skill promotion pipeline.';
      case 'improvements':
        return 'Review and manage improvement proposals.';
      default:
        return description;
    }
  }, [description, pageKey]);

  const readinessSummaryItems = useMemo(() => model.summaryItems, [model]);
  const effectiveProviders = useMemo(() => data?.providers ?? [], [data?.providers]);
  const configuredDefaultProviderId = useMemo(() => {
    const currentConfig = data?.configState.current;
    if (!currentConfig) return null;
    const configured = readConfigString(currentConfig, ['providers', 'defaultProviderId'], '').trim();
    return configured || null;
  }, [data?.configState.current]);
  const runtimeDefaultProviderId = useMemo(() => {
    const providerDefault = (data?.providers ?? []).find((provider) => provider.isRuntimeDefault || provider.isDefault)?.profile.id?.trim();
    return providerDefault || null;
  }, [data?.providers]);
  const resolvedDefaultProviderId = useMemo(() => {
    if (configuredDefaultProviderId) return configuredDefaultProviderId;
    const savedConfigured = data?.configState.savedDefaultProviderId?.trim();
    if (savedConfigured) return savedConfigured;
    const savedProviderDefault = (data?.providers ?? []).find((provider) => provider.isSavedDefault || provider.isDefault)?.profile.id?.trim();
    if (savedProviderDefault) return savedProviderDefault;
    return runtimeDefaultProviderId;
  }, [configuredDefaultProviderId, data?.configState.savedDefaultProviderId, data?.providers, runtimeDefaultProviderId]);

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
      savedDefaultProvider && runtimeDefaultProvider && savedDefaultProvider.profile.id === runtimeDefaultProvider.profile.id
    );
    const runtimeStateLabel = savedDefaultProvider
      ? providerStatesAligned ? 'in sync' : (data?.configState.restartRequired ? 'reload required' : 'runtime pending')
      : runtimeDefaultProvider ? 'runtime only' : 'unset';

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
        note: runtimeDefaultProvider ? 'Current runtime provider.' : savedDefaultProvider ? 'Waiting to become active.' : 'No runtime provider active.',
        variant: runtimeDefaultProvider ? 'info' : savedDefaultProvider ? 'warning' : 'outline',
      },
      {
        label: 'Reload state',
        value: runtimeStateLabel,
        note: providerStatesAligned ? 'Saved and runtime match.' : 'Config drift detected.',
        variant: providerStatesAligned ? 'success' : savedDefaultProvider ? 'warning' : 'outline',
      },
      {
        label: 'Ready',
        value: `${readyCount} / ${providers.length}`,
        note: `${secretLinkedCount} profiles have credentials.`,
        variant: readyCount > 0 ? 'success' : 'warning',
      },
    ];
  }, [data?.configState.restartRequired, effectiveProviders, resolvedDefaultProviderId, runtimeDefaultProviderId]);

  const renderPanel = () => {
    switch (pageKey) {
      case 'general':
        return (
          <GeneralSettings
            info={data?.system ?? null}
          />
        );
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
        return (
          <EcosystemSettings
            providers={effectiveProviders}
            busyKey={busyKey}
            onAction={runAction}
          />
        );
      case 'skills':
        return (
          <SkillsSettingsSection
            skills={data?.skills ?? []}
            onReload={reload}
            onNotice={setMessage}
          />
        );
      case 'governance':
        return (
          <GovernanceSettingsSection
            experiences={data?.experiences ?? []}
            skills={data?.skills ?? []}
            onReload={reload}
            onNotice={setMessage}
          />
        );
      case 'improvements':
        return (
          <ImprovementsSettings
            data={data ?? null}
            busyKey={busyKey}
            onAction={runAction}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full overflow-hidden" data-testid={pageTestId}>
      {/* Sidebar Navigation */}
      <aside className="hidden h-full w-56 flex-shrink-0 flex-col border-r border-border-subtle bg-surface px-3 py-4 lg:flex">
        <p className="px-2 text-[11px] font-medium uppercase tracking-[0.24em] text-text-muted mb-3">Settings</p>
        <nav className="space-y-1 flex-1 overflow-y-auto scrollbar-thin">
          {SETTINGS_TABS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.key}
                to={item.to}
                data-testid={`settings-tab-${item.key}`}
                className={({ isActive }) =>
                  `flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition duration-fast ${
                    isActive
                      ? 'bg-surface-elevated text-text-primary border border-border-default'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0 opacity-80" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="mt-auto pt-3 border-t border-border-subtle">
          <Button
            data-testid="settings-refresh-status"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => void reload()}
          >
            <RefreshIcon className="h-4 w-4 mr-2" />
            Refresh status
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-6">
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
          />

          {error ? (
            <Card className="mt-4 rounded-lg border-warning/30 bg-warning-muted/15">
              <CardContent className="px-5 py-4 text-sm text-warning">
                {error}
              </CardContent>
            </Card>
          ) : null}

          <ToastHost notices={notices} onDismiss={dismissNotice} />

          {/* Readiness Summary */}
          <Card className="mt-4 rounded-lg border-border-subtle bg-surface/28" data-testid="settings-readiness-summary">
            <CardHeader className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Readiness snapshot</p>
                <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Platform status at a glance</h2>
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

          {/* Page Content */}
          <div className="mt-4 flex flex-col gap-4">
            {renderPanel()}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
