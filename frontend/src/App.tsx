import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { TaskGlobalNavigation } from './components/tasks/TaskGlobalNavigation';
import { Badge } from './components/ui/badge';
import {
  CapabilityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('scc-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
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
      key: 'settings',
      to: '/settings/general',
      label: 'Settings',
      icon: SettingsIcon,
      active: location.pathname.startsWith('/settings'),
    },
  ]), [location.pathname]);

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
            detail: reasons[0] ?? 'All runtime checks passed.',
            chips: [
              { label: 'Runtime', value: health.ok ? 'ready' : 'degraded', tone: health.ok ? 'success' : 'warning' },
              { label: 'Worker', value: workerValue, tone: workerValue === 'online' ? 'success' : 'warning' },
              { label: 'Providers', value: providerValue, tone: startup.registries.providers > 0 ? 'success' : 'warning' },
            ],
          });
        }
      } catch {
        if (!disposed) {
          setConnectionState({
            state: 'degraded',
            detail: 'Unable to reach the backend.',
            chips: [
              { label: 'Runtime', value: 'offline', tone: 'error' },
              { label: 'Worker', value: 'offline', tone: 'error' },
              { label: 'Providers', value: 'offline', tone: 'error' },
            ],
          });
        }
      }
    }

    loadHealth();
    const interval = window.setInterval(loadHealth, 12_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('scc-sidebar-collapsed', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside
        className={`hidden h-full flex-shrink-0 flex-col border-r border-border-subtle bg-surface py-2.5 transition-all duration-300 ease-out lg:flex ${
          sidebarCollapsed ? 'w-16 items-center px-2' : 'w-72 px-4'
        }`}
        data-testid="app-sidebar"
      >
        <div className={`flex items-center gap-3 ${sidebarCollapsed ? 'px-0 justify-center' : 'px-1'}`}>
          <img
            src="/logo.png"
            alt="SCC Batch"
            data-testid="app-brand-logo"
            className="h-10 w-10 rounded-lg border border-border-subtle object-cover shrink-0"
          />
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <p className="truncate text-[1.05rem] font-semibold leading-tight text-text-primary">SCC Batch</p>
              <p className="mt-0.5 text-[11px] leading-none text-text-muted">Agent Console</p>
            </div>
          )}
        </div>
        <nav className={`mt-5 space-y-1 w-full ${sidebarCollapsed ? 'px-0' : ''}`} aria-label="Primary console navigation">
          {topNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.key}
                to={item.to}
                data-testid={`app-sidebar-nav-${item.key}`}
                data-active={item.active ? 'true' : 'false'}
                title={item.label}
                className={() =>
                  `flex h-10 items-center rounded-md border text-sm transition duration-fast ${
                    sidebarCollapsed ? 'justify-center px-0 w-10 mx-auto' : 'gap-3 px-3'
                  } ${
                    item.active
                      ? 'border-border-default bg-surface-elevated text-text-primary'
                      : 'border-transparent text-text-secondary hover:border-border-subtle hover:bg-surface-hover hover:text-text-primary'
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>
        {isTaskWorkspace && !sidebarCollapsed ? <TaskGlobalNavigation /> : null}
        {isTaskWorkspace && sidebarCollapsed ? (
          <div className="mt-4 flex flex-col items-center gap-2 border-t border-border-subtle pt-4 w-full">
            <p className="text-[10px] text-text-muted">Tasks</p>
          </div>
        ) : null}
        {!sidebarCollapsed && (
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
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          className={`mt-3 inline-flex h-8 items-center justify-center rounded-md border border-border-subtle bg-surface-elevated text-text-secondary transition hover:bg-surface-hover hover:text-text-primary ${
            sidebarCollapsed ? 'w-10 mx-auto' : 'w-full gap-2 px-3'
          }`}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <ChevronRightIcon className="h-4 w-4" /> : <>
            <ChevronLeftIcon className="h-4 w-4" />
            <span className="text-xs">Collapse</span>
          </>}
        </button>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-border-subtle bg-background/95 px-3 py-2 backdrop-blur-md sm:px-4 min-h-[2.8125rem]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <img
                src="/logo.png"
                alt="SCC Batch"
                data-testid="app-brand-logo-mobile"
                className="h-9 w-9 rounded-lg border border-border-subtle object-cover lg:hidden"
              />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.3em] text-text-muted">SCC Batch</p>
                <p className="text-sm font-semibold text-text-primary sm:hidden">{title}</p>
                <p className="hidden text-sm font-semibold text-text-primary sm:block lg:hidden">Agent Console</p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2 lg:ml-0">
              <span className="hidden text-xs uppercase tracking-[0.24em] text-text-muted sm:inline">{title}</span>
              <div
                className="hidden items-center gap-1.5 lg:flex"
                data-testid="app-runtime-chip-strip"
              >
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
            <button
              type="button"
              data-testid={isTaskWorkspace ? 'task-open-threads' : undefined}
              className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary lg:hidden"
              aria-label="Open menu"
              onClick={() => setMobileMenuOpen(true)}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
          {mobileMenuOpen ? (
            <div
              data-testid="app-mobile-overlay"
              className="fixed inset-0 z-50 flex flex-col gap-4 border-r border-border-subtle bg-surface p-4 lg:hidden"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src="/logo.png"
                    alt="SCC Batch"
                    data-testid="app-brand-logo"
                    className="h-10 w-10 rounded-lg border border-border-subtle object-cover"
                  />
                  <div>
                    <p className="text-[1.05rem] font-semibold leading-tight text-text-primary">SCC Batch</p>
                    <p className="mt-0.5 text-[11px] leading-none text-text-muted">Agent Console</p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="app-mobile-menu-close"
                  onClick={() => setMobileMenuOpen(false)}
                  className="rounded-md border border-border-subtle p-2 text-text-secondary transition hover:bg-surface-hover hover:text-text-primary"
                  aria-label="Close mobile menu"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
              <nav className="space-y-1" aria-label="Mobile console navigation">
                {topNavItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.key}
                      to={item.to}
                      data-testid={`app-mobile-nav-${item.key}`}
                      onClick={() => setMobileMenuOpen(false)}
                      className={() =>
                        `flex h-11 items-center gap-3 rounded-md border px-3 text-sm transition duration-fast ${
                          item.active
                            ? 'border-border-default bg-surface-elevated text-text-primary'
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
              {isTaskWorkspace ? (
                <div className="border-t border-border-subtle pt-3">
                  <TaskGlobalNavigation />
                </div>
              ) : null}
              <div className="mt-auto rounded-lg border border-border-subtle bg-surface-elevated/45 p-3">
                <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Runtime</p>
                <p className="mt-2 text-sm font-medium text-text-primary">{connectionState.state}</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{connectionState.detail}</p>
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
            </div>
          ) : null}
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
                description="Overview of providers, MCP, skills, tools, and experience."
              />
            )}
          />
          <Route
            path="/settings/skills"
            element={(
              <SettingsPage
                pageKey="skills"
                pageTestId="settings-skills-page"
                title="Skills"
                description="Managed skill catalog and import tools."
              />
            )}
          />
          <Route
            path="/settings/governance"
            element={(
              <SettingsPage
                pageKey="governance"
                pageTestId="settings-governance-page"
                title="Governance"
                description="Experience governance and skill promotion pipeline."
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
                description="Review and manage improvement proposals."
              />
            )}
          />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
