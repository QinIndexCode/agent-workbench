import type { TaskDebugResponse, TaskDetail } from '../../types';

export interface TaskProgressSnapshot {
  title: string;
  lifecycleStatus: TaskDetail['runtime']['lifecycleStatus'];
  blockingReason: string | null;
  nextAction: string;
  nextActionReason: string;
  artifactPathState: TaskDebugResponse['executionSummary']['artifactPathState'] | 'sandbox_only';
  selectedArtifactDir: string | null;
  recommendedArtifactDir: string | null;
  pendingApprovalCount: number;
  providerId: string | null;
}

export function buildTaskProgressSnapshot(task: TaskDetail, debug: TaskDebugResponse | null): TaskProgressSnapshot {
  const blockingReason = task.runtime.planner?.blockingReason ?? null;
  const artifactPathState = debug?.executionSummary.artifactPathState ?? 'sandbox_only';

  let nextAction = 'Continue';
  if (task.pendingApprovals.length > 0) {
    nextAction = 'Resolve approval';
  } else if (artifactPathState === 'unresolved') {
    nextAction = 'Choose output directory';
  } else if (task.runtime.lifecycleStatus === 'SUBMITTED') {
    nextAction = 'Start task';
  } else if (task.runtime.lifecycleStatus === 'PAUSED') {
    nextAction = 'Resume task';
  }

  return {
    title: task.definition.title,
    lifecycleStatus: task.runtime.lifecycleStatus,
    blockingReason,
    nextAction,
    nextActionReason:
      debug?.executionSummary.turnContract.continueReason
      ?? blockingReason
      ?? 'No blocking condition is currently reported.',
    artifactPathState,
    selectedArtifactDir: debug?.executionSummary.selectedArtifactDir ?? null,
    recommendedArtifactDir: debug?.executionSummary.recommendedArtifactDir ?? null,
    pendingApprovalCount: task.pendingApprovals.length,
    providerId: debug?.executionSummary.providerSummary.providerId ?? task.definition.preferredProviderId ?? null,
  };
}
