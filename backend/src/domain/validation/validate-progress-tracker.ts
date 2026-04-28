import { Decision, ProgressTracker, UnitStatus } from '../contracts/types';
import { ProgressTrackerValidationResult, TrackerSemanticPolicy, ValidationIssue } from './types';

const VALID_STATUSES = new Set<UnitStatus>([
  'PENDING',
  'IN_PROGRESS',
  'PARTIAL',
  'COMPLETE',
  'FAILED',
  'SKIPPED'
]);

const VALID_DECISIONS = new Set<Decision>([
  'CONTINUE',
  'PRUNE_REMAINING',
  'EARLY_TERMINATE'
]);

export function validateProgressTracker(params: {
  currentUnitId: string;
  trackers: ProgressTracker[];
  trackerPolicy?: TrackerSemanticPolicy;
}): ProgressTrackerValidationResult {
  const issues: ValidationIssue[] = [];
  const matchingTrackers = params.trackers.filter(tracker => tracker.currentUnit === params.currentUnitId);

  if (matchingTrackers.length === 0) {
    issues.push({
      code: 'missing_progress_tracker',
      message: `Missing progress tracker for unit "${params.currentUnitId}".`
    });
    return {
      ok: false,
      issues,
      acceptedTracker: null
    };
  }

  if (matchingTrackers.length > 1) {
    issues.push({
      code: 'duplicate_progress_tracker',
      message: `Multiple progress trackers detected for unit "${params.currentUnitId}".`
    });
  }

  const acceptedTracker = matchingTrackers[0] ?? null;
  if (!acceptedTracker) {
    return {
      ok: false,
      issues,
      acceptedTracker: null
    };
  }

  if (!VALID_STATUSES.has(acceptedTracker.status)) {
    issues.push({
      code: 'invalid_tracker_status',
      message: `Unsupported tracker status "${acceptedTracker.status}".`
    });
  }

  if (!VALID_DECISIONS.has(acceptedTracker.decision)) {
    issues.push({
      code: 'invalid_tracker_decision',
      message: `Unsupported tracker decision "${acceptedTracker.decision}".`
    });
  }

  if (!Number.isFinite(acceptedTracker.progressPercent)) {
    issues.push({
      code: 'invalid_tracker_progress_percent',
      message: `Tracker for unit "${params.currentUnitId}" must include a finite progress_percent value.`
    });
  } else {
    if (acceptedTracker.progressPercent < 0 || acceptedTracker.progressPercent > 100) {
      issues.push({
        code: 'invalid_tracker_progress_percent',
        message: `Tracker for unit "${params.currentUnitId}" must keep progress_percent within 0-100.`
      });
    }
    if (acceptedTracker.status === 'COMPLETE' && acceptedTracker.progressPercent !== 100) {
      issues.push({
        code: 'tracker_complete_requires_full_progress',
        message: `Tracker for unit "${params.currentUnitId}" cannot use status COMPLETE unless progress_percent is exactly 100.`
      });
    }
  }

  if (!acceptedTracker.reason || acceptedTracker.reason.trim().length === 0) {
    issues.push({
      code: 'tracker_reason_blank',
      message: `Tracker for unit "${params.currentUnitId}" must include a non-empty reason.`
    });
  }

  if (
    acceptedTracker.status === 'COMPLETE'
    && typeof acceptedTracker.reason === 'string'
    && /\b(remaining|next turn|next pass|still need|left for next|later turn|continue later|pending)\b/i.test(acceptedTracker.reason)
  ) {
    issues.push({
      code: 'tracker_complete_reason_conflict',
      message: `Tracker for unit "${params.currentUnitId}" cannot report COMPLETE while the reason still describes remaining or deferred work.`
    });
  }

  if (acceptedTracker.decision === 'EARLY_TERMINATE' && params.trackerPolicy?.allowEarlyTerminate === false) {
    issues.push({
      code: 'tracker_early_terminate_before_remaining_work',
      message: `Tracker for unit "${params.currentUnitId}" cannot use EARLY_TERMINATE while downstream required work remains.`
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    acceptedTracker: issues.length === 0 ? acceptedTracker : null
  };
}
