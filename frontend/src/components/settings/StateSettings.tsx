import { api } from '../../api/client';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Skeleton } from '../ui/skeleton';
import { ReadinessList } from '../workbench/ReadinessList';
import {
  SettingsSection,
  SettingsGrid,
} from './SettingsSection';
import type { PlatformReadinessModel } from '../../lib/workbench';
import type { PlatformOverviewData } from '../../hooks/usePlatformOverview';

interface StateSettingsProps {
  data?: PlatformOverviewData | null;
  model: PlatformReadinessModel;
  loading: boolean;
  busyKey: string | null;
  onAction: <T>(key: string, action: () => Promise<T>, successMessage: string, options?: { reload?: boolean }) => Promise<T | null>;
  onReload: () => Promise<void>;
}

export function StateSettings({ data, model, loading, busyKey, onAction, onReload }: StateSettingsProps) {
  return (
    <div className="space-y-4">
      <SettingsSection
        eyebrow="Runtime"
        title="Platform readiness"
        description="Current runtime health and configuration status."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="settings-state-refresh-status"
              variant="secondary"
              size="sm"
              disabled={busyKey !== null}
              onClick={() => void onAction('state-refresh', async () => {
                await onReload();
                return true;
              }, 'Runtime status refreshed.', { reload: false })}
            >
              Refresh
            </Button>
            <Button
              data-testid="settings-state-config-reload"
              variant="secondary"
              size="sm"
              disabled={busyKey !== null}
              onClick={() => void onAction('state-reload', () => api.reloadConfig(), 'Config reload requested.')}
            >
              Reload config
            </Button>
          </div>
        }
      >
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
            title="No platform inventory"
            description="Refresh once the backend is warmed up."
            variant="compact"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        eyebrow="Config"
        title="Configuration state"
        description="Current config application status and fingerprint."
      >
        <SettingsGrid cols={2}>
          <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Reload posture</p>
            <p className="mt-2 text-sm font-medium text-text-primary">
              {data?.configState.reloadApplied ? 'Config is applied' : 'Config reload pending'}
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              {data?.configState.restartRequired ? 'Restart required for some changes' : 'No restart needed'}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface/20 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Fingerprint</p>
            <p className="mt-2 break-all font-mono text-xs text-text-primary">
              {data?.configState.effectiveFingerprint ?? 'Unavailable'}
            </p>
          </div>
        </SettingsGrid>

        {(data?.configHealth.issues?.length ?? 0) > 0 ? (
          <div className="rounded-lg border border-warning/22 bg-warning-muted/12 px-4 py-3">
            <p className="text-sm font-semibold text-text-primary">Configuration issues</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
              {(data?.configHealth.issues ?? []).map((issue: { code?: string; message?: string }, index: number) => (
                <li key={`${issue.code ?? 'warning'}-${index}`}>{issue.message ?? issue.code ?? 'Unknown issue'}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}
