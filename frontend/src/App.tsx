import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { Badge } from './components/ui/badge';
import {
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
  const [connectionState, setConnectionState] = useState<'connected' | 'degraded'>('connected');

  const title = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return 'Settings';
    if (location.pathname.startsWith('/queue')) return 'Queue';
    if (location.pathname.startsWith('/dashboard')) return 'Dashboard';
    return 'Tasks';
  }, [location.pathname]);

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
        const health = await api.getHealth();
        if (!disposed) {
          setConnectionState(health.ok ? 'connected' : 'degraded');
        }
      } catch {
        if (!disposed) {
          setConnectionState('degraded');
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-border-subtle bg-background/86 px-3 py-2 backdrop-blur-md sm:px-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.3em] text-text-muted">SCC Batch</p>
              <p className="text-sm font-semibold text-text-primary sm:hidden">{title}</p>
              <p className="hidden text-sm font-semibold text-text-primary sm:block">Workspace</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs uppercase tracking-[0.24em] text-text-muted sm:inline">{title}</span>
              <Badge variant={connectionState === 'connected' ? 'success' : 'warning'} className="opacity-70">
                {connectionState}
              </Badge>
            </div>
          </div>
          <nav className="mt-2 flex items-center gap-1 overflow-x-auto border-b border-border-subtle pb-0.5 scrollbar-thin">
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
