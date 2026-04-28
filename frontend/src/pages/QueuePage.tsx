import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Button, buttonClassName } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { PageHeader } from '../components/workbench/PageHeader';
import { SummaryStrip } from '../components/workbench/SummaryStrip';
import { ThreadPreviewList } from '../components/workbench/ThreadPreviewList';
import { useTasks } from '../hooks/useTasks';
import {
  buildQueueSummary,
  buildTaskWorkspaceCollections,
} from '../lib/workbench';

export function QueuePage() {
  const { tasks, error } = useTasks();
  const collections = useMemo(() => buildTaskWorkspaceCollections(tasks), [tasks]);
  const summaryItems = useMemo(() => buildQueueSummary(collections), [collections]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6" data-testid="queue-page">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <PageHeader
          eyebrow="Queue"
          title="Queue"
          description="Recovery, waiting, and queued work."
          badges={[
            {
              label: collections.recovery.length > 0 ? `${collections.recovery.length} recovery` : 'stable',
              variant: collections.recovery.length > 0 ? 'error' : 'success',
            },
            {
              label: collections.waiting.length > 0 ? `${collections.waiting.length} waiting` : 'clear',
              variant: collections.waiting.length > 0 ? 'warning' : 'outline',
            },
          ]}
          actions={(
            <div className="flex items-center gap-2">
              {collections.recovery.length > 0 ? (
                <Link
                  to="/settings/state"
                  data-testid="queue-open-state"
                  className={buttonClassName({ variant: 'secondary', className: 'no-underline' })}
                >
                  Open state
                </Link>
              ) : null}
              <Link
                to="/tasks"
                data-testid="queue-return-tasks"
                className={buttonClassName({ className: 'no-underline' })}
              >
                Return to tasks
              </Link>
            </div>
          )}
        />

        {error ? (
          <Card className="rounded-lg border-error/30 bg-error-muted/20">
            <CardContent className="px-5 py-4 text-sm text-error">{error}</CardContent>
          </Card>
        ) : null}

        <div className="space-y-2">
          <div className="px-1">
            <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Queue snapshot</p>
            <p className="mt-1 text-sm text-text-secondary">Recovery and waiting stay primary. Counts only help you gauge pressure before you open a thread.</p>
          </div>
          <SummaryStrip items={summaryItems} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.18fr_0.82fr]">
          <Card className="rounded-lg border-error/14 bg-surface/34">
            <CardHeader className="flex items-center justify-between gap-3 py-3.5">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Recovery</p>
                <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Failures and last-error threads</h2>
                <p className="mt-1 text-sm text-text-secondary">Clear these first so the runtime does not drift further.</p>
              </div>
              <Badge variant={collections.recovery.length > 0 ? 'error' : 'success'}>
                {collections.recovery.length > 0 ? 'priority' : 'clear'}
              </Badge>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={collections.recovery}
                emptyTitle="No recovery work"
                emptyDescription="If a thread fails or carries a visible last-error signal, it will surface here."
                listTestId="queue-recovery-list"
                itemTestIdPrefix="queue-recovery-thread"
                condensed
                initialVisibleCount={3}
                actionLabel="Open"
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg border-warning/14 bg-surface/28">
            <CardHeader className="flex items-center justify-between gap-3 py-3.5">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Waiting</p>
                <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Paused and approval-bound threads</h2>
                <p className="mt-1 text-sm text-text-secondary">These are safe to resume once you clear the next decision.</p>
              </div>
              <Badge variant={collections.waiting.length > 0 ? 'warning' : 'outline'}>
                {collections.waiting.length > 0 ? 'attention' : 'quiet'}
              </Badge>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={collections.waiting}
                emptyTitle="Nothing is waiting"
                emptyDescription="Paused threads and approval blockers stay here until an operator decision clears them."
                listTestId="queue-waiting-list"
                itemTestIdPrefix="queue-waiting-thread"
                condensed
                initialVisibleCount={3}
                actionLabel="Open"
              />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <Card className="rounded-lg border-border-subtle bg-surface/24">
            <CardHeader className="py-3.5">
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Backlog</p>
              <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Queued or leased work</h2>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={collections.queued}
                emptyTitle="Nothing is queued"
                emptyDescription="Threads with queue state or an active lease will appear here as soon as the runtime pushes them behind the scenes."
                listTestId="queue-backlog-list"
                itemTestIdPrefix="queue-backlog-thread"
                condensed
                initialVisibleCount={3}
                actionLabel="Open"
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg border-border-subtle bg-surface/20">
            <CardHeader className="py-3.5">
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Recently cleared</p>
              <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Completed threads ready for follow-up</h2>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={collections.completed}
                emptyTitle="No completed queue work yet"
                emptyDescription="Completed threads show up here so you can verify the queue stayed healthy and jump into follow-up if needed."
                listTestId="queue-completed-list"
                itemTestIdPrefix="queue-completed-thread"
                condensed
                initialVisibleCount={3}
                actionLabel="Open"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default QueuePage;
