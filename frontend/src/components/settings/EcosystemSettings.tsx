import { useState } from 'react';
import { api } from '../../api/client';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import {
  SettingsSection,
  SettingsGrid,
  StatCard,
  SettingsCard,
} from './SettingsSection';
import type { ProviderProfileView } from '../../types';

interface EcosystemSettingsProps {
  providers: ProviderProfileView[];
  busyKey: string | null;
  onAction: <T>(key: string, action: () => Promise<T>, successMessage: string, options?: { reload?: boolean }) => Promise<T | null>;
}

export function EcosystemSettings({ providers, busyKey, onAction }: EcosystemSettingsProps) {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [draftApiKey, setDraftApiKey] = useState('');

  const enabledCount = providers.filter((p) => p.readiness.toLowerCase() === 'ready').length;
  const hasProviders = providers.length > 0;

  return (
    <div className="space-y-4">
      <SettingsSection
        eyebrow="Ecosystem"
        title="AI providers"
        description="Configure provider endpoints, API keys, and model preferences."
      >
        <SettingsGrid cols={3}>
          <StatCard
            label="Providers"
            value={providers.length}
            note="Configured endpoints"
            variant={providers.length > 0 ? 'info' : 'default'}
          />
          <StatCard
            label="Ready"
            value={enabledCount}
            note="Active for inference"
            variant={enabledCount > 0 ? 'success' : 'warning'}
          />
          <StatCard
            label="Default"
            value={providers.find((p) => p.isDefault)?.profile.label ?? 'None'}
            note="Preferred provider"
            variant="default"
          />
        </SettingsGrid>

        <SettingsCard title="Provider configurations">
          {hasProviders ? (
            <div className="space-y-3">
              {providers.map((provider) => (
                <div
                  key={provider.profile.id}
                  data-testid={`settings-provider-row-${provider.profile.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-text-primary">{provider.profile.label}</p>
                      <Badge variant={provider.readiness.toLowerCase() === 'ready' ? 'success' : 'outline'}>
                        {provider.readiness}
                      </Badge>
                      {provider.isDefault ? <Badge variant="info">Default</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {provider.adapter.transport} · {provider.adapter.vendor} · {provider.adapter.baseUrl ?? 'No base URL'}
                    </p>
                    {provider.model.modelId ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {provider.model.label}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {editingProvider === provider.profile.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={draftApiKey}
                          onChange={(e) => setDraftApiKey(e.target.value)}
                          placeholder="API key"
                          className="w-40 rounded-md border border-border-default bg-surface-elevated px-2 py-1 text-sm text-text-primary outline-none focus:border-accent"
                        />
                        <Button
                          size="sm"
                          disabled={busyKey !== null || !draftApiKey.trim()}
                          onClick={() =>
                            void onAction(
                              `provider-key-${provider.profile.id}`,
                              () => api.updateProvider(provider.profile.id, { id: provider.profile.id, label: provider.profile.label, model: provider.model.modelId, apiKeySecretId: draftApiKey.trim() }),
                              `Updated API key for ${provider.profile.label}.`,
                            )
                          }
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingProvider(null);
                            setDraftApiKey('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyKey !== null}
                          onClick={() => {
                            setEditingProvider(provider.profile.id);
                            setDraftApiKey('');
                          }}
                        >
                          Update key
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No providers configured"
              description="Add AI provider endpoints in your backend configuration."
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
