import type { TaskDebugResponse, TaskDetail } from '../../types';
import { buildTaskProgressSnapshot } from '../../shared/utils/task-progress';

export interface LegacyTaskDetailPaneProps {
  task: TaskDetail;
  debug: TaskDebugResponse | null;
}

export function TaskDetailPane({ task, debug }: LegacyTaskDetailPaneProps) {
  const snapshot = buildTaskProgressSnapshot(task, debug);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4" data-testid="legacy-task-detail-pane">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Legacy compatibility view</p>
      <h2 className="mt-2 text-lg font-semibold text-zinc-100">{snapshot.title}</h2>
      <dl className="mt-4 grid gap-3 text-sm text-zinc-300 md:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Lifecycle</dt>
          <dd>{snapshot.lifecycleStatus}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Next action</dt>
          <dd>{snapshot.nextAction}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Artifact path</dt>
          <dd>{snapshot.artifactPathState}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Provider</dt>
          <dd>{snapshot.providerId ?? 'not selected'}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-zinc-400">{snapshot.nextActionReason}</p>
    </section>
  );
}

export default TaskDetailPane;
