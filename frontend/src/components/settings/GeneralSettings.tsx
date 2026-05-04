import {
  SettingsSection,
  SettingsGrid,
  StatCard,
  SettingsCard,
} from './SettingsSection';
import type { PlatformSystemView } from '../../types';

interface GeneralSettingsProps {
  info: PlatformSystemView | null;
}

export function GeneralSettings({ info }: GeneralSettingsProps) {
  const system = info ?? {
    server: { host: 'unknown', port: 0, websocketPath: '', sseFallback: false },
    storage: { driver: 'unknown', rootDir: 'unknown' },
    database: { enabled: false, healthy: null, schema: '' },
    queue: { enabled: false, workerEnabled: false },
    registries: { providers: 0, skills: 0, mcpServers: 0, tools: 0 },
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        eyebrow="System"
        title="General settings"
        description="System identity, runtime health, and workspace configuration."
      >
        <SettingsGrid cols={4}>
          <StatCard
            label="Host"
            value={system.server.host}
            note="Server bind address"
            variant="default"
          />
          <StatCard
            label="Port"
            value={system.server.port}
            note="HTTP listener"
            variant="default"
          />
          <StatCard
            label="Storage"
            value={system.storage.driver}
            note="Persistence driver"
            variant="default"
          />
          <StatCard
            label="Database"
            value={system.database.enabled ? (system.database.healthy ? 'Healthy' : 'Unhealthy') : 'Disabled'}
            note={system.database.schema || 'No schema'}
            variant={system.database.enabled ? (system.database.healthy ? 'success' : 'warning') : 'default'}
          />
        </SettingsGrid>

        <SettingsCard title="Runtime health">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">Queue</p>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${system.queue.enabled ? 'bg-emerald-400' : 'bg-text-muted'}`} />
                <span className="text-sm font-medium text-text-primary">{system.queue.enabled ? (system.queue.workerEnabled ? 'Worker active' : 'Enabled') : 'Disabled'}</span>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">Registries</p>
              <p className="text-sm text-text-primary">
                {system.registries.providers} providers · {system.registries.skills} skills · {system.registries.mcpServers} MCP
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">WebSocket</p>
              <p className="text-sm text-text-primary">{system.server.websocketPath} {system.server.sseFallback ? '(+ SSE fallback)' : ''}</p>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="Paths">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">Root directory</p>
              <p className="mt-1 truncate text-sm font-mono text-text-secondary">{system.storage.rootDir}</p>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
