export const TASK_OBSERVATION_HOOK_POINTS = [
  'pre-tool-dispatch',
  'post-tool-result',
  'approval-blocked',
  'task-resumed',
  'task-failed'
] as const;

export type TaskObservationHookPoint = typeof TASK_OBSERVATION_HOOK_POINTS[number];
