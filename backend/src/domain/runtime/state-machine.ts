import {
  PendingCorrectionKind,
  ProgressTracker,
  RuntimeState,
  UnitStatus
} from '../contracts/types';

export interface StateTransitionInput {
  tracker?: ProgressTracker;
  outputErrors?: string[];
  currentUnitId: string;
}

export function createInitialState(taskId: string): RuntimeState {
  return {
    taskId,
    status: 'IDLE',
    currentUnitId: null,
    pendingCorrection: 'NONE',
    units: {},
    progressHistory: []
  };
}

function ensureUnit(state: RuntimeState, unitId: string): void {
  if (!state.units[unitId]) {
    state.units[unitId] = {
      unitId,
      status: 'PENDING',
      invalidOutputErrors: []
    };
  }
}

export function applyValidationFailure(
  state: RuntimeState,
  unitId: string,
  errors: string[]
): RuntimeState {
  return applyCorrectionRequirement(state, unitId, 'AWAITING_OUTPUT_CORRECTION', errors);
}

export function applyCorrectionRequirement(
  state: RuntimeState,
  unitId: string,
  kind: PendingCorrectionKind,
  errors: string[]
): RuntimeState {
  const next: RuntimeState = structuredClone(state);
  ensureUnit(next, unitId);
  next.currentUnitId = unitId;
  next.units[unitId].status = 'PARTIAL';
  next.units[unitId].invalidOutputErrors = [...errors];
  next.pendingCorrection = kind;
  next.status = 'RUNNING';
  return next;
}

export function applyTracker(
  state: RuntimeState,
  tracker: ProgressTracker
): RuntimeState {
  const next: RuntimeState = structuredClone(state);
  ensureUnit(next, tracker.currentUnit);
  next.currentUnitId = tracker.nextUnit || tracker.currentUnit;
  next.units[tracker.currentUnit].status = tracker.status as UnitStatus;
  next.units[tracker.currentUnit].invalidOutputErrors = [];
  next.progressHistory.push(tracker);
  next.pendingCorrection = tracker.status === 'FAILED'
    ? 'AWAITING_BLOCKER_EXPLANATION'
    : 'NONE';
  next.status = tracker.status === 'FAILED' ? 'FAILED' : 'RUNNING';
  return next;
}

export function getCorrectionModeDescription(kind: PendingCorrectionKind): string {
  switch (kind) {
    case 'AWAITING_TRACKER':
      return 'Current turn requires a valid progress tracker.';
    case 'AWAITING_OUTPUT_CORRECTION':
      return 'Current turn must provide valid explicit output before submitting a tracker.';
    case 'AWAITING_TOOL_ACTION':
      return 'Current turn must execute a real tool action, not only text or tracker.';
    case 'AWAITING_BLOCKER_EXPLANATION':
      return 'Current turn must explain the blocker instead of continuing ambiguously.';
    default:
      return 'No correction mode is active.';
  }
}
