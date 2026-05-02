import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { Badge } from './components/ui/badge';
import {
  CapabilityIcon,
  DashboardIcon,
  QueueIcon,
  SettingsIcon,
  TasksIcon,
} from './components/ui/icons';
import { DashboardPage } from './pages/DashboardPage';
import { QueuePage } from './pages/QueuePage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';

function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [connectionState, setConnectionState] = useState<{
    state: 'connected' | 'degraded';
    detail: string;
    chips: Array<{
      label: string;
      value: string;
      tone: 'success' | 'warning' | 'error';
    }>;
  }>({
    state: 'degraded',
    detail: 'Checking backend runtime readiness.',
    chips: [
      { label: 'Runtime', value: 'checking', tone: 'warning' },
      { label: 'Worker', value: 'checking', tone: 'warning' },
      { label: 'Providers', value: 'checking', tone: 'warning' },
    ],
  });

  const title = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return 'Settings';
    if (location.pathname.startsWith('/queue')) return 'Queue';
    if (location.pathname.startsWith('/dashboard')) return 'Dashboard';
    return 'Tasks';
  }, [location.pathname]);
  const isTaskWorkspace = location.pathname.startsWith('/tasks');

  const topNavItems = useMemo(() => ([
    {
      key: 'tasks',
      to: '/tasks',
      label: 'Tasks',
      icon: TasksIcon,
      active: location.pathname.startsWith('/tasks'),
    },
    {
      key: 'dashboard',
      to: '/dashboard',
      label: 'Dashboard',
      icon: DashboardIcon,
      active: location.pathname.startsWith('/dashboard'),
    },
    {
      key: 'queue',
      to: '/queue',
      label: 'Queue',
      icon: QueueIcon,
      active: location.pathname.startsWith('/queue'),
    },
    {
      key: 'ecosystem',
      to: '/settings/ecosystem',
      label: 'Ecosystem',
      icon: CapabilityIcon,
      active: location.pathname.startsWith('/settings/ecosystem'),
    },
    {
      key: 'settings',
      to: '/settings/general',
      label: 'Settings',
      icon: SettingsIcon,
      active: location.pathname.startsWith('/settings') && !location.pathname.startsWith('/settings/ecosystem'),
    },
  ]), [location.pathname]);
  const showDesktopSidebar = !isTaskWorkspace;

  useEffect(() => {
    let disposed = false;

    async function loadHealth() {
      try {
        const [health, startup] = await Promise.all([
          api.getHealth(),
          api.getSystemStartup(),
        ]);
        const reasons = [
          health.ok ? null : health.issues?.[0]?.message ?? 'backend health reported degraded',
          startup.queue.enabled && !startup.queue.workerEnabled ? 'queue worker disabled' : null,
          startup.database.enabled && startup.database.healthy === false ? 'database unhealthy' : null,
          startup.registries.providers === 0 ? 'no providers registered' : null,
        ].filter(Boolean) as string[];
        const workerValue = startup.queue.enabled
          ? startup.queue.workerEnabled ? 'online' : 'disabled'
          : 'inline';
        const providerValue = startup.registries.providers > 0
          ? `${startup.registries.providers} registered`
          : 'none';
        if (!disposed) {
          setConnectionState({
            state: reasons.length === 0 ? 'connected' : 'degraded',
            detail: reasons.length
              ? reasons.join(' / ')
              : `runtime ready / worker ${startup.queue.enabled ? startup.queue.workerEnabled ? 'ready' : 'off' : 'inline'} / providers ${startup.registries.providers}`,
            chips: [
              {
                label: 'Runtime',
                value: health.ok ? 'ready' : 'degraded',
                tone: health.ok ? 'success' : 'warning',
              },
              {
                label: 'Worker',
                value: workerValue,
                tone: startup.queue.enabled && !startup.queue.workerEnabled ? 'warning' : 'success',
              },
              {
                label: 'Providers',
                value: providerValue,
                tone: startup.registries.providers > 0 ? 'success' : 'warning',
              },
            ],
          });
        }
      } catch (error) {
        if (!disposed) {
          setConnectionState({
            state: 'degraded',
            detail: error instanceof Error ? error.message : 'backend health check failed',
            chips: [
              { label: 'Runtime', value: 'blocked', tone: 'error' },
              { label: 'Worker', value: 'unknown', tone: 'warning' },
              { label: 'Providers', value: 'unknown', tone: 'warning' },
            ],
          });
        }
      }
    }

    void loadHealth();
    const interval = window.setInterval(() => {
      void loadHealth();
    }, 20_000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {showDesktopSidebar ? (
        <aside
          className="hidden h-full w-72 flex-shrink-0 flex-col border-r border-border-subtle bg-[linear-gradient(180deg,rgba(17,17,20,0.98),rgba(11,11,13,0.98))] px-4 py-4 lg:flex"
          data-testid="app-sidebar"
        >
          <div className="flex items-center gap-3 px-1">
            <img
              src="/logo.png"
              alt="SCC Batch"
              data-testid="app-brand-logo"
              className="h-10 w-10 rounded-lg border border-white/10 object-cover shadow-[0_0_24px_rgba(99,102,241,0.34)]"
            />
            <div className="min-w-0">
              <p className="truncate text-[1.05rem] font-semibold leading-tight text-text-primary">SCC Batch</p>
              <p className="mt-0.5 text-[11px] leading-none text-text-muted">Agent Console</p>
            </div>
          </div>
          <nav className="mt-5 space-y-1" aria-label="Primary console navigation">
            {topNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.key}
                  to={item.to}
                  data-testid={`app-sidebar-nav-${item.key}`}
                  data-active={item.active ? 'true' : 'false'}
                  className={() =>
                    `flex h-10 items-center gap-3 rounded-md border px-3 text-sm transition duration-fast ${
                      item.active
                        ? 'border-border-default bg-surface-elevated text-text-primary shadow-[inset_3px_0_0_rgba(99,102,241,0.86)]'
                        : 'border-transparent text-text-secondary hover:border-border-subtle hover:bg-surface-hover hover:text-text-primary'
                    }`
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="mt-auto rounded-lg border border-border-subtle bg-surface-elevated/45 p-3" data-testid="app-sidebar-runtime">
            <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Runtime</p>
            <p className="mt-2 text-sm font-medium text-text-primary">{connectionState.state}</p>
            <p className="mt-1 line-clamp-3 text-xs leading-5 text-text-secondary">{connectionState.detail}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {connectionState.chips.map((chip) => (
                <Badge
                  key={chip.label}
                  variant={chip.tone === 'success' ? 'success' : chip.tone === 'error' ? 'error' : 'warning'}
                  className="opacity-80"
                >
                  {chip.label}: {chip.value}
                </Badge>
              ))}
            </div>
          </div>
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className={`border-b border-border-subtle bg-background/82 px-3 py-2 backdrop-blur-md sm:px-4 ${
          isTaskWorkspace
            ? 'lg:absolute lg:left-72 lg:right-0 lg:top-0 lg:z-50 xl:left-[19rem]'
            : ''
        }`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <img
                src="/logo.png"
                alt="SCC Batch"
                data-testid="app-brand-logo-mobile"
                className="h-9 w-9 rounded-lg border border-white/10 object-cover shadow-[0_0_22px_rgba(99,102,241,0.20)] lg:hidden"
              />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.3em] text-text-muted">SCC Batch</p>
                <p className="text-sm font-semibold text-text-primary sm:hidden">{title}</p>
                <p className="hidden text-sm font-semibold text-text-primary sm:block lg:hidden">Agent Console</p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2 lg:ml-0">
              <span className="hidden text-xs uppercase tracking-[0.24em] text-text-muted sm:inline">{title}</span>
              <div className="hidden items-center gap-1.5 lg:flex" data-testid="app-runtime-chip-strip">
                {connectionState.chips.map((chip) => (
                  <Badge
                    key={chip.label}
                    variant={chip.tone === 'success' ? 'success' : chip.tone === 'error' ? 'error' : 'warning'}
                    className="opacity-80"
                  >
                    {chip.label}: {chip.value}
                  </Badge>
                ))}
              </div>
              <Badge
                variant={connectionState.state === 'connected' ? 'success' : 'warning'}
                className="opacity-70 lg:hidden"
              >
                <span
                  data-testid="app-runtime-status"
                  title={connectionState.detail}
                  className="inline-block max-w-[8rem] truncate align-bottom capitalize"
                >
                  {connectionState.state}
                </span>
              </Badge>
            </div>
            <div className="ml-auto hidden items-center gap-4 text-xs text-text-secondary lg:flex">
              <span>Help</span>
              <span>Alerts</span>
              <span className="grid h-8 w-8 place-items-center rounded-full border border-border-default bg-surface-elevated text-text-primary">DE</span>
            </div>
          </div>
          <nav className="mt-2 flex items-center gap-1 overflow-x-auto border-b border-border-subtle pb-0.5 scrollbar-thin lg:hidden">
            {topNavItems.map((item) => {
              const Icon = item.icon;
              return (
              <NavLink
                key={item.key}
                to={item.to}
                data-testid={`app-nav-${item.key}`}
                data-active={item.active ? 'true' : 'false'}
                className={() =>
                  `whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition duration-fast ${
                    item.active
                      ? 'bg-surface-elevated text-text-primary ring-1 ring-border-default'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`
                }
              >
                <span className="inline-flex items-center gap-2">
                  <Icon className="h-4 w-4 opacity-85" />
                  <span>{item.label}</span>
                </span>
              </NavLink>
              );
            })}
          </nav>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="app-content">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route
            path="/settings/general"
            element={(
              <SettingsPage
                pageKey="general"
                pageTestId="settings-general-page"
                title="General"
                description="Review the default file-backed operating model."
              />
            )}
          />
          <Route
            path="/settings/connections"
            element={(
              <SettingsPage
                pageKey="connections"
                pageTestId="settings-connections-page"
                summaryTestId="settings-connections-summary"
                title="Connections"
                description="Inspect providers, secrets, and connection posture."
              />
            )}
          />
          <Route
            path="/settings/capabilities"
            element={(
              <SettingsPage
                pageKey="capabilities"
                pageTestId="settings-capabilities-page"
                summaryTestId="settings-capabilities-summary"
                title="Capabilities"
                description="Review readiness for skills, MCP, and workflow assets."
              />
            )}
          />
          <Route
            path="/settings/ecosystem"
            element={(
              <SettingsPage
                pageKey="ecosystem"
                pageTestId="settings-ecosystem-page"
                title="Ecosystem"
                description="Inspect providers, MCP, skills, experience, tools, scenario packs, and workspace commands from one readiness view."
              />
            )}
          />
          <Route path="/settings/providers" element={<Navigate to="/settings/connections" replace />} />
          <Route path="/settings/secrets" element={<Navigate to="/settings/connections" replace />} />
          <Route
            path="/settings/skills"
            element={(
              <SettingsPage
                pageKey="skills"
                pageTestId="settings-skills-page"
                title="Skills"
                description="Inspect imported skills and workflow docs."
              />
            )}
          />
          <Route
            path="/settings/state"
            element={(
              <SettingsPage
                pageKey="state"
                pageTestId="settings-state-page"
                title="State"
                description="Inspect runtime drift, persistence, and config health."
              />
            )}
          />
          <Route
            path="/settings/improvements"
            element={(
              <SettingsPage
                pageKey="improvements"
                pageTestId="settings-improvements-page"
                title="Improvements"
                description="Review generated lessons, experience references, instruction-skill candidates, and optimization recommendations before promotion."
              />
            )}
          />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
