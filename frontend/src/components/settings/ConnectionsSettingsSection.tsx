import { type InputHTMLAttributes, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { AdminModal } from '../ui/admin-modal';
import { CompactEmptyState } from '../ui/compact-empty-state';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PlusIcon } from '../ui/icons';
import { IconActionButton } from '../ui/icon-action-button';
import {
  ManagementTable,
  ManagementTableBody,
  ManagementTableHeader,
  ManagementTableRow,
} from '../ui/management-table';
import { PaginationBar } from '../ui/pagination-bar';
import { SelectInput } from '../ui/select-input';
import { StatusSwitch } from '../ui/status-switch';
import { AdminPageShell } from '../workbench/AdminPageShell';
import { SummaryStrip } from '../workbench/SummaryStrip';
import type { SummaryStripItem } from '../../lib/workbench';
import type {
  ProviderCapabilityMetadata,
  ProviderPresetView,
  ProviderProfile,
  ProviderProfileView,
  ProviderTransport,
  ProviderVendor,
} from '../../types';

const PAGE_SIZE = 10;

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilityMetadata = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsVision: false,
  supportsFiles: false,
  supportedFileExtensions: [],
};

interface ProviderDraft {
  id: string;
  label: string;
  transport: ProviderTransport;
  vendor: ProviderVendor;
  baseUrl: string;
  model: string;
  apiKeySecretId: string;
  configFieldValues: Record<string, string>;
}

type ProviderModalMode = 'create' | 'edit';
type ProviderCreateMode = 'quick' | 'custom';

interface ProviderDeleteIntent {
  providerId: string;
  providerLabel: string;
  isDefault: boolean;
  hasSecret: boolean;
}

const PROVIDER_TRANSPORTS: ProviderTransport[] = [
  'openai-compatible',
  'deepseek-compatible',
  'anthropic-compatible',
  'native-cohere',
  'native-ai21',
  'native-replicate',
  'native-perplexity-agent',
  'enterprise-cloud',
  'profile-only',
  'local-stdio',
];

const PROVIDER_VENDORS: ProviderVendor[] = [
  'custom',
  'openai',
  'anthropic',
  'deepseek',
  'xai',
  'google_gemini',
  'mistral',
  'cohere',
  'groq',
  'openrouter',
  'perplexity',
  'huggingface',
  'ollama',
  'lmstudio',
];

function normalizeNameToId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getProviderReadinessVariant(readiness: string) {
  switch (readiness.toLowerCase()) {
    case 'ready':
    case 'stable':
      return 'success' as const;
    case 'warning':
    case 'degraded':
      return 'warning' as const;
    case 'blocked':
    case 'missing':
      return 'error' as const;
    case 'profile-only':
    case 'external-auth-required':
      return 'info' as const;
    default:
      return 'outline' as const;
  }
}

function buildPresetDraft(preset: ProviderPresetView): ProviderDraft {
  return {
    id: normalizeNameToId(preset.id),
    label: preset.label,
    vendor: preset.vendor,
    transport: preset.transport,
    baseUrl: preset.baseUrl ?? '',
    model: preset.defaultModel,
    apiKeySecretId: preset.requiresApiKey ? normalizeNameToId(`${preset.id}-api-key`) : '',
    configFieldValues: Object.fromEntries(preset.requiredConfigFields.map((field) => [field, ''])),
  };
}

function buildCustomDraft(): ProviderDraft {
  return {
    id: '',
    label: '',
    vendor: 'custom',
    transport: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeySecretId: '',
    configFieldValues: {},
  };
}

function buildProviderDraft(profile: ProviderProfileView): ProviderDraft {
  const metadata = profile.profile.metadata && typeof profile.profile.metadata === 'object'
    ? profile.profile.metadata
    : {};
  const rawConfigFields = metadata.configFields;
  const configFieldValues = rawConfigFields && typeof rawConfigFields === 'object' && !Array.isArray(rawConfigFields)
    ? Object.fromEntries(Object.entries(rawConfigFields).map(([key, value]) => [key, String(value ?? '')]))
    : {};
  return {
    id: profile.profile.id,
    label: profile.profile.label,
    transport: profile.profile.transport ?? profile.adapter.transport,
    vendor: profile.profile.vendor ?? profile.adapter.vendor,
    baseUrl: profile.profile.baseUrl ?? '',
    model: profile.profile.model,
    apiKeySecretId: profile.profile.apiKeySecretId ?? '',
    configFieldValues,
  };
}

function sortProviders(providers: ProviderProfileView[]) {
  return [...providers].sort((left, right) => {
    const leftOrder = typeof left.profile.metadata?.settingsOrder === 'number'
      ? left.profile.metadata.settingsOrder
      : Number.POSITIVE_INFINITY;
    const rightOrder = typeof right.profile.metadata?.settingsOrder === 'number'
      ? right.profile.metadata.settingsOrder
      : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.profile.label.localeCompare(right.profile.label);
  });
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

const PRESET_CATEGORY_LABELS = {
  'api-key': 'API key providers',
  'enterprise-cloud': 'Enterprise cloud',
  local: 'Local services',
} as const;

const PRESET_CATEGORY_ORDER: Array<ProviderPresetView['category']> = ['api-key', 'enterprise-cloud', 'local'];

function normalizeFieldTestId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function hasRunnableAdapter(preset: ProviderPresetView | null) {
  return !preset || preset.implementationStatus === 'runnable';
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

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
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

export function ConnectionsSettingsSection({
  providers,
  providerPresets,
  savedDefaultProviderId,
  runtimeDefaultProviderId,
  restartRequired = false,
  summaryItems,
  onReload,
  onNotice,
}: {
  providers: ProviderProfileView[];
  providerPresets: ProviderPresetView[];
  savedDefaultProviderId?: string | null;
  runtimeDefaultProviderId?: string | null;
  restartRequired?: boolean;
  summaryItems: SummaryStripItem[];
  onReload: () => Promise<void>;
  onNotice: (tone: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerModalMode, setProviderModalMode] = useState<ProviderModalMode>('create');
  const effectiveProviderPresets = useMemo(() => providerPresets, [providerPresets]);
  const quickAddPresets = useMemo(
    () => effectiveProviderPresets.filter((preset) => preset.supportsQuickAdd),
    [effectiveProviderPresets]
  );
  const defaultQuickPreset = quickAddPresets[0] ?? effectiveProviderPresets[0] ?? null;
  const [providerCreateMode, setProviderCreateMode] = useState<ProviderCreateMode>('quick');
  const [providerModalTemplate, setProviderModalTemplate] = useState(defaultQuickPreset?.id ?? '');
  const [providerModalTargetId, setProviderModalTargetId] = useState<string | null>(null);
  const [providerModalDraft, setProviderModalDraft] = useState<ProviderDraft>(defaultQuickPreset ? buildPresetDraft(defaultQuickPreset) : buildCustomDraft());
  const [providerModalSecret, setProviderModalSecret] = useState('');
  const [providerModalAdvancedOpen, setProviderModalAdvancedOpen] = useState(false);
  const [providerEnableAfterSave, setProviderEnableAfterSave] = useState(true);
  const [providerDeleteIntent, setProviderDeleteIntent] = useState<ProviderDeleteIntent | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, string>>({});

  const orderedProviders = useMemo(() => sortProviders(providers), [providers]);
  const groupedProviderPresets = useMemo(
    () => PRESET_CATEGORY_ORDER.map((category) => ({
      category,
      label: PRESET_CATEGORY_LABELS[category],
      presets: effectiveProviderPresets.filter((preset) => preset.category === category),
    })).filter((group) => group.presets.length > 0),
    [effectiveProviderPresets]
  );
  const savedEnabledProvider = useMemo(
    () => orderedProviders.find((provider) => provider.isSavedDefault || provider.profile.id === savedDefaultProviderId) ?? null,
    [orderedProviders, savedDefaultProviderId]
  );
  const runtimeEnabledProvider = useMemo(
    () => orderedProviders.find((provider) => provider.isRuntimeDefault || provider.profile.id === runtimeDefaultProviderId) ?? null,
    [orderedProviders, runtimeDefaultProviderId]
  );
  const providerTruthMismatch = Boolean(
    savedEnabledProvider
    && (
      !runtimeEnabledProvider
      || runtimeEnabledProvider.profile.id !== savedEnabledProvider.profile.id
    )
  );
  const totalPages = useMemo(() => Math.max(1, Math.ceil(orderedProviders.length / PAGE_SIZE)), [orderedProviders.length]);
  const pagedProviders = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return orderedProviders.slice(start, start + PAGE_SIZE);
  }, [currentPage, orderedProviders]);
  const selectedPreset = useMemo(
    () => effectiveProviderPresets.find((preset) => preset.id === providerModalTemplate) ?? defaultQuickPreset,
    [defaultQuickPreset, effectiveProviderPresets, providerModalTemplate]
  );
  const selectedRequiredConfigFields = providerModalMode === 'create' && providerCreateMode === 'quick'
    ? selectedPreset?.requiredConfigFields ?? []
    : [];
  const selectedMissingRequiredConfig = selectedRequiredConfigFields.some((field) => !providerModalDraft.configFieldValues[field]?.trim());
  const selectedPresetRunnable = hasRunnableAdapter(providerModalMode === 'create' && providerCreateMode === 'quick' ? selectedPreset : null);
  const providerTransportOptions = useMemo(
    () => uniqueStrings([
      ...PROVIDER_TRANSPORTS,
      ...effectiveProviderPresets.map((preset) => preset.transport),
      ...orderedProviders.map((provider) => provider.profile.transport ?? provider.adapter.transport),
    ]),
    [effectiveProviderPresets, orderedProviders]
  );
  const providerVendorOptions = useMemo(
    () => uniqueStrings([
      ...PROVIDER_VENDORS,
      ...effectiveProviderPresets.map((preset) => preset.vendor),
      ...orderedProviders.map((provider) => provider.profile.vendor ?? provider.adapter.vendor),
    ]),
    [effectiveProviderPresets, orderedProviders]
  );

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (!defaultQuickPreset || providerModalTemplate) {
      return;
    }
    setProviderModalTemplate(defaultQuickPreset.id);
    if (!providerModalOpen) {
      setProviderModalDraft(buildPresetDraft(defaultQuickPreset));
    }
  }, [defaultQuickPreset, providerModalOpen, providerModalTemplate]);

  const runAction = async <T,>(
    key: string,
    action: () => Promise<T>,
    successMessage: string,
    options?: { reload?: boolean }
  ) => {
    try {
      setBusyKey(key);
      const result = await action();
      if (options?.reload !== false) {
        await onReload();
      }
      onNotice('success', successMessage);
      return result;
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : 'Action failed.');
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const openCreateModal = () => {
    setProviderModalMode('create');
    setProviderCreateMode(defaultQuickPreset ? 'quick' : 'custom');
    setProviderModalTemplate(defaultQuickPreset?.id ?? '');
    setProviderModalTargetId(null);
    setProviderModalDraft(defaultQuickPreset ? buildPresetDraft(defaultQuickPreset) : buildCustomDraft());
    setProviderModalSecret('');
    setProviderModalAdvancedOpen(false);
    setProviderEnableAfterSave(true);
    setProviderModalOpen(true);
  };

  const openEditModal = (provider: ProviderProfileView) => {
    setProviderModalMode('edit');
    setProviderCreateMode('custom');
    setProviderModalTargetId(provider.profile.id);
    setProviderModalDraft(buildProviderDraft(provider));
    setProviderModalSecret('');
    setProviderModalAdvancedOpen(true);
    setProviderEnableAfterSave(provider.isSavedDefault || provider.isDefault);
    setProviderModalOpen(true);
  };

  const closeModal = () => {
    setProviderModalOpen(false);
    setProviderModalSecret('');
    setProviderModalTargetId(null);
    setProviderModalAdvancedOpen(false);
  };

  const announceDraftContext = (message: string) => {
    onNotice('info', message);
  };

  const handleSave = async () => {
    const providerId = normalizeNameToId(providerModalDraft.id || providerModalDraft.label);
    if (!providerId) {
      throw new Error('Provider ID is required.');
    }
    if (!providerModalDraft.label.trim()) {
      throw new Error('Provider label is required.');
    }
    if (!providerModalDraft.model.trim()) {
      throw new Error('Provider model is required.');
    }
    const duplicateProvider = orderedProviders.find((provider) => (
      provider.profile.id === providerId && provider.profile.id !== providerModalTargetId
    ));
    if (duplicateProvider) {
      throw new Error(`Provider ID "${providerId}" already exists. Choose a different ID before saving.`);
    }
    const existing = providerModalTargetId
      ? orderedProviders.find((provider) => provider.profile.id === providerModalTargetId) ?? null
      : null;
    const presetForDraft = providerModalMode === 'create' && providerCreateMode === 'quick'
      ? selectedPreset
      : null;
    const baseProfile: ProviderProfile = existing?.profile ?? {
      id: providerId,
      label: providerModalDraft.label,
      transport: providerModalDraft.transport,
      vendor: providerModalDraft.vendor,
      baseUrl: providerModalDraft.baseUrl || undefined,
      model: providerModalDraft.model,
    };
    const configFields = Object.fromEntries(
      Object.entries(providerModalDraft.configFieldValues)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => Boolean(value))
    );
    const metadata = presetForDraft
      ? {
        ...(baseProfile.metadata ?? {}),
        presetId: presetForDraft.id,
        providerCategory: presetForDraft.category,
        implementationStatus: presetForDraft.implementationStatus,
        envVarNames: presetForDraft.envVarNames,
        requiredConfigFields: presetForDraft.requiredConfigFields,
        configFields,
        capabilities: presetForDraft.capabilities,
      }
      : baseProfile.metadata;
    const normalizedSecretId = providerModalDraft.apiKeySecretId.trim() || (providerModalSecret.trim() ? `${providerId}-api-key` : '');
    const saved = await api.updateProvider(providerId, {
      ...baseProfile,
      id: providerId,
      label: providerModalDraft.label.trim(),
      transport: providerModalDraft.transport,
      vendor: providerModalDraft.vendor,
      baseUrl: providerModalDraft.baseUrl.trim() || undefined,
      model: providerModalDraft.model.trim(),
      apiKeySecretId: normalizedSecretId || undefined,
      metadata,
    });

    if (providerModalSecret.trim()) {
      const secret = await api.setProviderSecret({
        secretId: normalizedSecretId || undefined,
        provider: providerId,
        label: `${providerModalDraft.label.trim()} secret`,
        apiKey: providerModalSecret.trim(),
      });
      if (secret.resource.id !== saved.resource.apiKeySecretId) {
        await api.updateProvider(providerId, {
          ...saved.resource,
          apiKeySecretId: secret.resource.id,
        });
      }
    }
    if (providerEnableAfterSave) {
      await api.setDefaultProvider(providerId);
    }
    closeModal();
  };

  return (
    <AdminPageShell summary={<SummaryStrip items={summaryItems} />}>
      <Card className="rounded-lg border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-4 sm:flex-row sm:items-end sm:justify-between">
          <SectionLead
            eyebrow="Connections"
            title="Connection templates"
            description="Keep the roster stable, flip one enabled provider at a time, and handle all details inside a focused modal."
          />
          <Button data-testid="settings-connections-create" disabled={busyKey !== null} onClick={openCreateModal}>
            <PlusIcon className="h-4 w-4" />
            New connection
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {orderedProviders.length === 0 ? (
            <CompactEmptyState
              title="No provider connections yet"
              description="Start with a reusable template, then tune the connection details in the editor."
            />
          ) : (
            <>
              {!savedEnabledProvider && !runtimeEnabledProvider ? (
                <div
                  className="rounded-lg border border-warning/25 bg-warning-muted/10 px-4 py-3 text-sm text-text-secondary"
                  data-testid="settings-connections-no-enabled-provider"
                >
                  No provider is enabled in saved config or runtime yet. Choose one connection to make the roster deterministic.
                </div>
              ) : null}
              {providerTruthMismatch ? (
                <div
                  className="rounded-lg border border-warning/25 bg-warning-muted/10 px-4 py-3 text-sm text-text-secondary"
                  data-testid="settings-connections-runtime-pending"
                >
                  {restartRequired
                    ? `Saved default "${savedEnabledProvider?.profile.label}" is waiting on reload or restart before runtime switches over.`
                    : `Saved default "${savedEnabledProvider?.profile.label}" has not propagated to runtime yet.`}
                  {runtimeEnabledProvider
                    ? ` Runtime still reports "${runtimeEnabledProvider.profile.label}" as active.`
                    : ' Runtime does not report an active provider yet.'}
                </div>
              ) : null}
              <ManagementTable testId="settings-connections-table">
                <ManagementTableHeader columns="minmax(0,1.6fr) minmax(0,1fr) auto auto auto">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Test</span>
                  <span>Enabled</span>
                  <span className="text-right">Actions</span>
                </ManagementTableHeader>
                <ManagementTableBody>
                  {pagedProviders.map((provider) => {
                    const isSavedDefault = provider.isSavedDefault || provider.isDefault || provider.profile.id === savedDefaultProviderId;
                    const isRuntimeDefault = provider.isRuntimeDefault || provider.isDefault || provider.profile.id === runtimeDefaultProviderId;
                    const implementationStatus = provider.implementationStatus ?? 'runnable';
                    const capabilities = provider.capabilities ?? DEFAULT_PROVIDER_CAPABILITIES;
                    const pendingRuntimeSwitch = isSavedDefault && !isRuntimeDefault;
                    const secondaryStateLabel = pendingRuntimeSwitch
                      ? (restartRequired ? 'reload required' : 'runtime pending')
                      : (!isSavedDefault && isRuntimeDefault ? 'runtime active' : null);

                    return (
                      <ManagementTableRow
                        key={provider.profile.id}
                        columns="minmax(0,1.6fr) minmax(0,1fr) auto auto auto"
                        testId={`settings-connections-provider-card-${provider.profile.id}`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{provider.profile.label}</p>
                          <p className="mt-1 text-xs text-text-muted">{provider.profile.id}</p>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Badge variant={getProviderReadinessVariant(provider.readiness)}>{provider.readiness}</Badge>
                          {implementationStatus !== 'runnable' ? (
                            <Badge variant="info">{implementationStatus}</Badge>
                          ) : null}
                          {capabilities.supportsVision ? <Badge variant="outline">vision</Badge> : null}
                          {capabilities.supportsFiles ? <Badge variant="outline">files</Badge> : null}
                          {isSavedDefault ? <Badge variant="success">enabled provider</Badge> : null}
                          {secondaryStateLabel ? (
                            <Badge variant={pendingRuntimeSwitch ? 'warning' : 'info'}>
                              {secondaryStateLabel}
                            </Badge>
                          ) : null}
                          {!provider.hasSecret ? <Badge variant="warning">missing secret</Badge> : null}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyKey !== null}
                          data-testid={`settings-connections-provider-test-${provider.profile.id}`}
                          onClick={() => void runAction(
                            `provider-test-${provider.profile.id}`,
                            async () => {
                              const result = await api.testProvider(provider.profile.id);
                              setProviderTestResults((current) => ({ ...current, [provider.profile.id]: result.message }));
                              return result;
                            },
                            `Tested provider ${provider.profile.id}.`,
                            { reload: false }
                          )}
                        >
                          Test
                        </Button>
                        <StatusSwitch
                          checked={isSavedDefault}
                          disabled={busyKey !== null || isSavedDefault}
                          label={isSavedDefault ? `${provider.profile.label} is the saved enabled provider` : `Enable ${provider.profile.label}`}
                          testId={`settings-connections-provider-default-${provider.profile.id}`}
                          onToggle={() => void runAction(
                            `provider-default-${provider.profile.id}`,
                            () => api.setDefaultProvider(provider.profile.id),
                            `${provider.profile.label} is now the saved enabled provider.`
                          )}
                        />
                        <div className="flex items-center justify-end gap-2">
                          <IconActionButton
                            label={`Edit ${provider.profile.label}`}
                            disabled={busyKey !== null}
                            testId={`settings-connections-provider-edit-${provider.profile.id}`}
                            onClick={() => openEditModal(provider)}
                          >
                            <EditIcon />
                          </IconActionButton>
                          <IconActionButton
                            label={`Delete ${provider.profile.label}`}
                            disabled={busyKey !== null}
                            testId={`settings-connections-provider-delete-${provider.profile.id}`}
                            onClick={() => setProviderDeleteIntent({
                              providerId: provider.profile.id,
                              providerLabel: provider.profile.label,
                              isDefault: isSavedDefault || isRuntimeDefault,
                              hasSecret: provider.hasSecret,
                            })}
                          >
                            <DeleteIcon />
                          </IconActionButton>
                        </div>
                      </ManagementTableRow>
                    );
                  })}
                </ManagementTableBody>
              </ManagementTable>

              <PaginationBar
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={orderedProviders.length}
                itemLabel="connections"
                disabled={busyKey !== null}
                testId="settings-connections-pagination"
                onPrevious={() => setCurrentPage((current) => Math.max(1, current - 1))}
                onNext={() => setCurrentPage((current) => Math.min(totalPages, current + 1))}
              />

              {pagedProviders.some((provider) => providerTestResults[provider.profile.id]) ? (
                <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Latest connection tests</p>
                  <div className="mt-2 space-y-2 text-sm text-text-secondary">
                    {pagedProviders.filter((provider) => providerTestResults[provider.profile.id]).map((provider) => (
                      <p key={provider.profile.id}>
                        <span className="font-medium text-text-primary">{provider.profile.label}:</span>{' '}
                        {providerTestResults[provider.profile.id]}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <AdminModal
        open={providerModalOpen}
        testId="settings-connections-provider-modal"
        eyebrow={providerModalMode === 'create' ? 'New connection' : 'Edit connection'}
        title={providerModalMode === 'create' ? 'Create provider connection' : 'Edit provider connection'}
        description="Configure transport, secrets, and model details here without disturbing the connections roster."
        onClose={closeModal}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-text-secondary">Keep the roster stable. Any context updates appear as toast messages instead of pushing the modal layout around.</div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={closeModal} disabled={busyKey !== null}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid={providerModalMode === 'create' ? 'settings-connections-provider-create-submit' : `settings-connections-provider-save-${providerModalTargetId ?? 'draft'}`}
                disabled={busyKey !== null || !providerModalDraft.label.trim() || !providerModalDraft.model.trim() || selectedMissingRequiredConfig}
                onClick={() => void runAction(
                  providerModalMode === 'create' ? 'provider-create' : `provider-save-${providerModalTargetId ?? 'draft'}`,
                  handleSave,
                  providerModalMode === 'create'
                    ? `Created provider ${providerModalDraft.label}.`
                    : `Saved provider ${providerModalDraft.label}.`
                )}
              >
                {providerModalMode === 'create' ? 'Create connection' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 md:col-span-2">
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Connection editor</p>
            <p className="mt-2 text-sm text-text-secondary">
              Start with a quick preset when all you need is an API key and a model. Open the advanced fields only when you need to tune transport details.
            </p>
          </div>
          {providerModalMode === 'create' ? (
            <div className="space-y-3 md:col-span-2">
              <FieldLabel>Create mode</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={providerCreateMode === 'quick' ? 'primary' : 'secondary'}
                  disabled={!effectiveProviderPresets.length}
                  onClick={() => {
                    const presetToLoad = defaultQuickPreset ?? selectedPreset;
                    if (!presetToLoad) {
                      return;
                    }
                    setProviderCreateMode('quick');
                    setProviderModalTemplate(presetToLoad.id);
                    setProviderModalDraft(buildPresetDraft(presetToLoad));
                    setProviderModalAdvancedOpen(false);
                    announceDraftContext('Quick add mode keeps the form focused on API key and model.');
                  }}
                >
                  Quick add preset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={providerCreateMode === 'custom' ? 'primary' : 'secondary'}
                  onClick={() => {
                    setProviderCreateMode('custom');
                    setProviderModalTemplate('custom-openai-compatible');
                    setProviderModalDraft(buildCustomDraft());
                    setProviderModalAdvancedOpen(true);
                    announceDraftContext('Custom mode exposes the full transport and vendor settings.');
                  }}
                >
                  Custom provider
                </Button>
              </div>
              {providerCreateMode === 'quick' ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel>Preset</FieldLabel>
                    <SelectInput
                      data-testid="settings-connections-provider-template"
                      value={providerModalTemplate}
                      onChange={(event) => {
                        const nextTemplate = event.target.value;
                        const nextPreset = effectiveProviderPresets.find((preset) => preset.id === nextTemplate);
                        setProviderModalTemplate(nextTemplate);
                        if (nextPreset) {
                          const nextDraft = buildPresetDraft(nextPreset);
                          setProviderModalDraft(nextDraft);
                          announceDraftContext(`Loaded ${nextPreset.label}.`);
                        }
                      }}
                    >
                      {groupedProviderPresets.map((group) => (
                        <optgroup key={group.category} label={group.label}>
                          {group.presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.label} · {preset.implementationStatus}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </SelectInput>
                  </div>
                  <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Preset details</p>
                    <div className="mt-2 space-y-1 text-sm text-text-secondary">
                      <p className="break-words"><span className="text-text-primary">Vendor:</span> {selectedPreset?.vendor ?? 'custom'}</p>
                      <p className="break-words"><span className="text-text-primary">Transport:</span> {selectedPreset?.transport ?? 'openai-compatible'}</p>
                      <p className="break-words"><span className="text-text-primary">Category:</span> {selectedPreset?.category ?? 'api-key'}</p>
                      <p className="break-words"><span className="text-text-primary">Adapter:</span> {selectedPreset?.implementationStatus ?? 'runnable'}</p>
                      <p className="break-words"><span className="text-text-primary">Default model:</span> {selectedPreset?.defaultModel || 'choose one below'}</p>
                      {selectedPreset?.baseUrl ? (
                        <p className="break-words"><span className="text-text-primary">Base URL:</span> {selectedPreset.baseUrl}</p>
                      ) : null}
                      {selectedPreset?.envVarNames.length ? (
                        <p className="break-words"><span className="text-text-primary">Env:</span> {selectedPreset.envVarNames.join(', ')}</p>
                      ) : null}
                      {selectedPreset?.requiredConfigFields.length ? (
                        <p className="break-words"><span className="text-text-primary">Config:</span> {selectedPreset.requiredConfigFields.join(', ')}</p>
                      ) : null}
                      {selectedPreset ? (
                        <p className="break-words">
                          <span className="text-text-primary">Inputs:</span>{' '}
                          {selectedPreset.capabilities.inputModalities.join(', ')}
                          {selectedPreset.capabilities.supportsVision ? ' · vision' : ''}
                          {selectedPreset.capabilities.supportsFiles ? ' · files' : ''}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {!selectedPresetRunnable && selectedPreset ? (
                    <div
                      className="rounded-lg border border-info/25 bg-info-muted/10 px-4 py-3 text-sm text-text-secondary md:col-span-2"
                      data-testid="settings-connections-provider-non-runnable"
                    >
                      {selectedPreset.implementationStatus === 'external-auth-required'
                        ? 'This enterprise preset stores configuration metadata, but it needs external cloud authentication before runtime can execute it.'
                        : 'This profile-only preset is visible for configuration, but no runnable adapter is registered in this release.'}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <FieldLabel>Label</FieldLabel>
            <TextInput
              data-testid={`settings-connections-provider-label-${providerModalTargetId ?? 'new'}`}
              value={providerModalDraft.label}
              onChange={(event) => setProviderModalDraft((current) => ({ ...current, label: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Model</FieldLabel>
            <TextInput
              data-testid={`settings-connections-provider-model-${providerModalTargetId ?? 'new'}`}
              value={providerModalDraft.model}
              onChange={(event) => setProviderModalDraft((current) => ({ ...current, model: event.target.value }))}
            />
          </div>
          {selectedRequiredConfigFields.length ? (
            <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 md:col-span-2">
              <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Required configuration</p>
              <p className="mt-1 text-sm text-text-secondary">
                These fields are stored as provider metadata so enterprise and gateway profiles stay explicit.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {selectedRequiredConfigFields.map((field) => (
                  <div className="space-y-2" key={field}>
                    <FieldLabel>{field}</FieldLabel>
                    <TextInput
                      data-testid={`settings-connections-provider-config-field-${normalizeFieldTestId(field)}`}
                      value={providerModalDraft.configFieldValues[field] ?? ''}
                      onChange={(event) => setProviderModalDraft((current) => ({
                        ...current,
                        configFieldValues: {
                          ...current.configFieldValues,
                          [field]: event.target.value,
                        },
                      }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <FieldLabel>{selectedPreset?.requiresApiKey === false ? 'Access token (optional)' : 'API key'}</FieldLabel>
            <TextInput
              data-testid={`settings-connections-provider-secret-value-${providerModalTargetId ?? 'new'}`}
              type="password"
              value={providerModalSecret}
              onChange={(event) => setProviderModalSecret(event.target.value)}
            />
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Enable after save</p>
                <p className="mt-1 text-sm text-text-secondary">
                  Turn the saved connection into the workspace default as soon as it is created or updated.
                </p>
              </div>
              <StatusSwitch
                checked={providerEnableAfterSave}
                label="Enable provider after save"
                testId="settings-connections-provider-enable-after-save"
                onToggle={() => setProviderEnableAfterSave((current) => !current)}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Advanced settings</p>
                <p className="mt-1 text-sm text-text-secondary">
                  Use advanced settings for transport overrides, custom vendors, local endpoints, and explicit secret ids.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="settings-connections-provider-advanced-toggle"
                onClick={() => setProviderModalAdvancedOpen((current) => !current)}
              >
                {providerModalAdvancedOpen ? 'Hide advanced' : 'Show advanced'}
              </Button>
            </div>
            {providerModalAdvancedOpen ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel>ID</FieldLabel>
                  <TextInput
                    data-testid={`settings-connections-provider-id-${providerModalTargetId ?? 'new'}`}
                    value={providerModalDraft.id}
                    onChange={(event) => setProviderModalDraft((current) => ({ ...current, id: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Linked secret ID</FieldLabel>
                  <TextInput
                    data-testid={`settings-connections-provider-secret-id-${providerModalTargetId ?? 'new'}`}
                    value={providerModalDraft.apiKeySecretId}
                    onChange={(event) => setProviderModalDraft((current) => ({ ...current, apiKeySecretId: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Transport</FieldLabel>
                  <SelectInput
                    data-testid={`settings-connections-provider-transport-${providerModalTargetId ?? 'new'}`}
                    value={providerModalDraft.transport}
                    onChange={(event) => {
                      const nextTransport = event.target.value as ProviderTransport;
                      setProviderModalDraft((current) => ({
                        ...current,
                        transport: nextTransport,
                      }));
                      announceDraftContext(`Transport switched to ${nextTransport}.`);
                    }}
                  >
                    {providerTransportOptions.map((transport) => (
                      <option key={transport} value={transport}>{transport}</option>
                    ))}
                  </SelectInput>
                </div>
                <div className="space-y-2">
                  <FieldLabel>Vendor</FieldLabel>
                  <SelectInput
                    data-testid={`settings-connections-provider-vendor-${providerModalTargetId ?? 'new'}`}
                    value={providerModalDraft.vendor}
                    onChange={(event) => {
                      const nextVendor = event.target.value as ProviderVendor;
                      setProviderModalDraft((current) => ({
                        ...current,
                        vendor: nextVendor,
                      }));
                      announceDraftContext(`Vendor switched to ${nextVendor}.`);
                    }}
                  >
                    {providerVendorOptions.map((vendor) => (
                      <option key={vendor} value={vendor}>{vendor}</option>
                    ))}
                  </SelectInput>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>Base URL</FieldLabel>
                  <TextInput
                    data-testid={`settings-connections-provider-base-url-${providerModalTargetId ?? 'new'}`}
                    value={providerModalDraft.baseUrl}
                    onChange={(event) => setProviderModalDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </div>
              </div>
            ) : null}
          </div>
          {providerModalMode === 'edit' && providerModalTargetId ? (
            <div className="rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 md:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Connectivity check</p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {providerTestResults[providerModalTargetId] ?? 'Run a quick test against the saved connection profile.'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={`settings-connections-provider-test-${providerModalTargetId}`}
                  disabled={busyKey !== null}
                  onClick={() => void runAction(
                    `provider-test-${providerModalTargetId}`,
                    async () => {
                      const result = await api.testProvider(providerModalTargetId);
                      setProviderTestResults((current) => ({ ...current, [providerModalTargetId]: result.message }));
                      return result;
                    },
                    `Tested provider ${providerModalTargetId}.`,
                    { reload: false }
                  )}
                >
                  Test current config
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </AdminModal>

      <ConfirmDialog
        open={providerDeleteIntent !== null}
        title={providerDeleteIntent ? `Delete provider "${providerDeleteIntent.providerLabel}"?` : 'Delete provider?'}
        description="This removes the provider profile from the roster. Delivered tasks stay intact, but the connection will no longer be selectable."
        details={providerDeleteIntent ? [
          providerDeleteIntent.isDefault
            ? 'This provider is currently enabled. Deleting it will leave the workspace without an enabled provider until another connection is enabled.'
            : 'Only this connection entry will be removed.',
          providerDeleteIntent.hasSecret
            ? 'A linked secret exists and will stop being usable for this provider after deletion.'
            : 'No linked secret is attached to this connection.',
        ] : []}
        confirmLabel="Delete provider"
        cancelLabel="Keep provider"
        tone="danger"
        busy={busyKey !== null}
        testId="settings-connections-delete-dialog"
        confirmTestId="settings-connections-delete-confirm"
        cancelTestId="settings-connections-delete-cancel"
        onCancel={() => setProviderDeleteIntent(null)}
        onConfirm={() => {
          if (!providerDeleteIntent) {
            return;
          }
          void runAction(
            `provider-delete-${providerDeleteIntent.providerId}`,
            async () => {
              const result = await api.deleteProvider(providerDeleteIntent.providerId);
              setProviderDeleteIntent(null);
              return result;
            },
            `Deleted provider ${providerDeleteIntent.providerId}.`
          );
        }}
      />
    </AdminPageShell>
  );
}
