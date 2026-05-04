import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTasks } from '../../hooks/useTasks';
import { buildThreadPreview } from '../../lib/workbench';
import { ArchiveIcon, PlusIcon } from '../ui/icons';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

const TASK_NAV_REFRESH_MS = 4_000;

interface TaskGlobalNavigationProps {
  variant?: 'sidebar' | 'mobile';
  onNavigate?: () => void;
}

function buildTaskSearch(search: string, taskId: string) {
  const nextParams = new URLSearchParams(search);
  nextParams.set('task', taskId);
  nextParams.delete('create');
  return `?${nextParams.toString()}`;
}

function buildCreateTaskSearch(search: string) {
  const nextParams = new URLSearchParams(search);
  nextParams.set('create', '1');
  return `?${nextParams.toString()}`;
}

export function TaskGlobalNavigation({ variant = 'sidebar', onNavigate }: TaskGlobalNavigationProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const {
    tasks,
    loading,
    error,
    reload,
  } = useTasks({ includeArchived: showArchived });
  const { tasks: allTasks, reload: reloadAllTasks } = useTasks({ includeArchived: true });
  const selectedTaskId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('task');
  }, [location.search]);
  const archivedTaskCount = useMemo(() => allTasks.filter((entry) => entry.isArchived).length, [allTasks]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void reload();
      void reloadAllTasks();
    }, TASK_NAV_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [reload, reloadAllTasks]);

  function navigateToTask(taskId: string) {
    navigate({
      pathname: '/tasks',
      search: buildTaskSearch(location.pathname.startsWith('/tasks') ? location.search : '', taskId),
    });
    onNavigate?.();
  }

  function openTaskComposer() {
    navigate({
      pathname: '/tasks',
      search: buildCreateTaskSearch(location.pathname.startsWith('/tasks') ? location.search : ''),
    });
    onNavigate?.();
  }

  const compact = variant === 'mobile';

  return (
    <section
      data-testid="tasks-explorer-scroll"
      className={
        compact
          ? 'mt-4 border-t border-border-subtle pt-4'
          : 'mt-4 flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border-subtle pt-4'
      }
      aria-label="Task list"
    >
      <div className={compact ? 'space-y-3' : 'flex-shrink-0 space-y-3'}>
        <div className="flex items-start justify-between gap-3 px-1">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-text-muted">Tasks</p>
            <h2 className="text-sm font-semibold text-text-primary">Task list</h2>
          </div>
          <Badge variant="outline">{tasks.length}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            data-testid="task-toggle-show-archived"
            variant={showArchived ? 'secondary' : 'ghost'}
            size="sm"
            className="min-w-0 justify-center px-2.5 text-xs"
            disabled={!showArchived && archivedTaskCount === 0}
            title={
              archivedTaskCount === 0
                ? 'There are no archived threads to show right now.'
                : showArchived
                  ? 'Hide archived threads.'
                  : 'Show archived threads.'
            }
            onClick={() => setShowArchived((current) => !current)}
          >
            <ArchiveIcon className="h-4 w-4" />
            {archivedTaskCount === 0
              ? 'Archived'
              : showArchived
                ? `Hide (${archivedTaskCount})`
                : `Archived (${archivedTaskCount})`}
          </Button>
          <Button
            data-testid="task-create-thread-inline"
            size="sm"
            className="min-w-0 justify-center px-2.5 text-xs"
            onClick={openTaskComposer}
          >
            <PlusIcon className="h-4 w-4" />
            Create task
          </Button>
        </div>
      </div>

      <div
        className={
          compact
            ? 'mt-3 max-h-[52vh] space-y-2 overflow-y-auto pr-1 scrollbar-thin'
            : 'mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scrollbar-thin'
        }
        data-testid="tasks-explorer-viewport"
      >
        {error ? (
          <p className="rounded-lg border border-error/30 bg-error-muted/20 px-3 py-3 text-sm text-error">{error}</p>
        ) : null}
        {showArchived ? (
          <p className="px-1 text-xs text-text-muted">Archived threads are visible.</p>
        ) : null}
        {tasks.map((entry) => {
          const preview = buildThreadPreview(entry);
          const isSelected = selectedTaskId === entry.taskId;
          return (
            <button
              key={entry.taskId}
              type="button"
              data-testid="task-list-item"
              onClick={() => navigateToTask(entry.taskId)}
              className={`w-full rounded-lg border px-3 py-3 text-left transition duration-fast ${
                isSelected
                  ? 'border-accent/40 bg-accent-muted/80'
                  : 'border-border-subtle bg-surface-elevated/72 hover:border-border-default hover:bg-surface-hover'
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant={preview.lifecycleVariant}>{preview.lifecycleLabel}</Badge>
                  {entry.isArchived ? <Badge variant="outline">Archived</Badge> : null}
                </div>
                <span className="shrink-0 text-xs text-text-muted">{preview.updatedLabel}</span>
              </div>
              <p className="line-clamp-1 text-sm font-semibold text-text-primary">{preview.title}</p>
              {!compact && preview.attention ? (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">{preview.attention}</p>
              ) : null}
            </button>
          );
        })}
        {!loading && tasks.length === 0 ? (
          <p className="px-1 text-sm text-text-muted">
            {showArchived ? 'No archived task threads yet.' : 'No task threads yet.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
