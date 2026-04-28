export interface SettingsConnectionSummary {
  connectionState: 'connected' | 'degraded' | 'disconnected';
  providerCount: number;
  defaultProviderId: string | null;
  warning: string | null;
}

export function summarizeConnections(input: {
  providerCount: number;
  defaultProviderId?: string | null;
  hasTransportWarning?: boolean;
}): SettingsConnectionSummary {
  const providerCount = Math.max(0, input.providerCount);
  const defaultProviderId = input.defaultProviderId ?? null;
  const connectionState =
    providerCount === 0
      ? 'disconnected'
      : input.hasTransportWarning
        ? 'degraded'
        : 'connected';

  return {
    connectionState,
    providerCount,
    defaultProviderId,
    warning:
      connectionState === 'degraded'
        ? 'One or more configured providers still need attention.'
        : connectionState === 'disconnected'
          ? 'No provider is configured yet.'
          : null,
  };
}

export function SettingsConnectionsPage() {
  const summary = summarizeConnections({
    providerCount: 1,
    defaultProviderId: 'provider-main',
    hasTransportWarning: false,
  });

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4" data-testid="legacy-settings-connections-page">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Legacy compatibility view</p>
      <h2 className="mt-2 text-lg font-semibold text-zinc-100">Connections</h2>
      <p className="mt-3 text-sm text-zinc-300">State: {summary.connectionState}</p>
      <p className="mt-1 text-sm text-zinc-300">Providers: {summary.providerCount}</p>
      <p className="mt-1 text-sm text-zinc-300">Default provider: {summary.defaultProviderId ?? 'none'}</p>
      {summary.warning && <p className="mt-3 text-sm text-amber-400">{summary.warning}</p>}
    </section>
  );
}

export default SettingsConnectionsPage;
