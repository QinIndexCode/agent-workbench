import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Button, buttonClassName } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/workbench/PageHeader';
import { SummaryStrip } from '../components/workbench/SummaryStrip';
import { ThreadPreviewList } from '../components/workbench/ThreadPreviewList';
import { useTasks } from '../hooks/useTasks';
import {
  buildTaskOverviewSummary,
  buildTaskWorkspaceCollections,
} from '../lib/workbench';

export function DashboardPage() {
  const { tasks, loading, error } = useTasks();

  const collections = useMemo(() => buildTaskWorkspaceCollections(tasks), [tasks]);
  const summaryItems = useMemo(() => buildTaskOverviewSummary(collections), [collections]);
  const liveThreads = collections.running.length > 0 ? collections.running : collections.recent.slice(0, 4);

  return (
    <div className="h-full overflow-y-auto px-6 py-6" data-testid="dashboard-page">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <PageHeader
          eyebrow="Overview"
          title="Workspace overview"
          description="Attention, running work, and recent outcomes."
          badges={[
            {
              label: collections.attention.length > 0 ? `${collections.attention.length} attention` : 'clear',
              variant: collections.attention.length > 0 ? 'warning' : 'success',
            },
            {
              label: collections.running.length > 0 ? `${collections.running.length} running` : 'quiet',
              variant: collections.running.length > 0 ? 'success' : 'outline',
            },
          ]}
          actions={(
            <Link
              to="/tasks"
              data-testid="dashboard-open-tasks"
              className={buttonClassName({ className: 'no-underline' })}
            >
              Open tasks
            </Link>
          )}
        />

        {error ? (
          <Card className="rounded-lg border-error/30 bg-error-muted/20">
            <CardContent className="px-5 py-4 text-sm text-error">{error}</CardContent>
          </Card>
        ) : null}

        {loading ? (
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="px-1">
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Snapshot</p>
              <p className="mt-1 text-sm text-text-secondary">Keep the summary light. The sections below should stay the fastest route back into work.</p>
            </div>
            <SummaryStrip items={summaryItems} />
          </div>
        )}

        <Card className="rounded-lg border-border-subtle bg-surface/38">
          <CardHeader className="flex items-center justify-between gap-3 py-3.5">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Attention first</p>
              <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Start with the thread that needs a decision</h2>
              <p className="mt-1 text-sm text-text-secondary">Keep the next operator decision in view, then move.</p>
            </div>
            <Badge variant={collections.attention.length > 0 ? 'warning' : 'success'}>
              {collections.attention.length > 0 ? 'active' : 'clear'}
            </Badge>
          </CardHeader>
          <CardContent className="pt-0">
            <ThreadPreviewList
              items={collections.attention}
              emptyTitle="Nothing urgent right now"
              emptyDescription="Approvals, pauses, and recoveries will surface here as soon as the runtime needs a decision."
              listTestId="dashboard-attention-list"
              itemTestIdPrefix="dashboard-attention-thread"
            />
          </CardContent>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <Card className="rounded-lg border-border-subtle bg-surface/30">
            <CardHeader className="flex items-center justify-between gap-3 py-3.5">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Live flow</p>
                <h2 className="mt-1.5 text-lg font-semibold text-text-primary">Running and recently touched threads</h2>
              </div>
              <Badge variant={collections.running.length > 0 ? 'success' : 'outline'}>
                {collections.running.length > 0 ? 'moving' : 'quiet'}
              </Badge>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={liveThreads}
                emptyTitle="No active work right now"
                emptyDescription="Start or resume a thread from Tasks and it will show up here."
                listTestId="dashboard-live-list"
                itemTestIdPrefix="dashboard-live-thread"
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg border-border-subtle bg-surface/26">
            <CardHeader className="py-3.5">
              <p className="text-xs uppercase tracking-[0.28em] text-text-muted">Recent changes</p>
              <h2 className="mt-1.5 text-lg font-semibold text-text-primary">What moved most recently</h2>
            </CardHeader>
            <CardContent className="pt-0">
              <ThreadPreviewList
                items={collections.recent}
                emptyTitle="No thread history yet"
                emptyDescription="As soon as the runtime creates or updates work, the latest threads will appear here."
                listTestId="dashboard-recent-list"
                itemTestIdPrefix="dashboard-recent-thread"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
