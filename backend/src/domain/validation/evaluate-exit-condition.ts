import { ExplicitOutputEnvelope, ProgressTracker } from '../contracts/types';
import { extractContractKeys, parseContractObject } from '../parser/contract-shape';
import { ValidationIssue } from './types';

export interface ExitConditionEvaluationResult {
  ok: boolean;
  issues: ValidationIssue[];
  requiredOutputKeys: string[];
  failureCategory: 'OUTPUT' | 'TRACKER' | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectRequiredOutputKeys(exitCondition: string | undefined): string[] {
  if (!exitCondition) {
    return [];
  }
  const parsed = parseContractObject(exitCondition);
  if (!parsed) {
    return extractContractKeys(exitCondition);
  }
  return Object.keys(parsed).filter((key) => !['status', 'decision', 'progress_percent', 'progressPercent'].includes(key));
}

export function evaluateExitCondition(params: {
  currentUnitId: string;
  exitCondition?: string;
  acceptedOutput: ExplicitOutputEnvelope | null;
  acceptedTracker: ProgressTracker | null;
}): ExitConditionEvaluationResult {
  if (!params.exitCondition?.trim()) {
    return {
      ok: true,
      issues: [],
      requiredOutputKeys: [],
      failureCategory: null
    };
  }

  const issues: ValidationIssue[] = [];
  const parsedCondition = parseContractObject(params.exitCondition);
  const requiredOutputKeys = collectRequiredOutputKeys(params.exitCondition);
  const output = params.acceptedOutput?.parsedJson;
  let failureCategory: 'OUTPUT' | 'TRACKER' | null = null;

  if (requiredOutputKeys.length > 0) {
    if (!isObjectRecord(output)) {
      failureCategory = failureCategory ?? 'OUTPUT';
      issues.push({
        code: 'exit_condition_output_not_object',
        message: `Exit condition for unit "${params.currentUnitId}" requires a JSON object output.`
      });
    } else {
      for (const key of requiredOutputKeys) {
        if (!(key in output)) {
          failureCategory = failureCategory ?? 'OUTPUT';
          issues.push({
            code: 'exit_condition_missing_output_key',
            message: `Exit condition for unit "${params.currentUnitId}" is missing output key "${key}".`
          });
        }
      }
    }
  }

  if (parsedCondition && params.acceptedTracker) {
    const expectedStatus = typeof parsedCondition.status === 'string' ? parsedCondition.status : null;
    const expectedDecision = typeof parsedCondition.decision === 'string' ? parsedCondition.decision : null;
    const minimumProgress = typeof parsedCondition.progress_percent === 'number'
      ? parsedCondition.progress_percent
      : (typeof parsedCondition.progressPercent === 'number' ? parsedCondition.progressPercent : null);
    const requiresTracker = parsedCondition.requiresTracker === true;

    if (expectedStatus && params.acceptedTracker.status !== expectedStatus) {
      failureCategory = failureCategory ?? 'TRACKER';
      issues.push({
        code: 'exit_condition_status_mismatch',
        message: `Exit condition for unit "${params.currentUnitId}" requires tracker status "${expectedStatus}".`
      });
    }

    if (expectedDecision && params.acceptedTracker.decision !== expectedDecision) {
      failureCategory = failureCategory ?? 'TRACKER';
      issues.push({
        code: 'exit_condition_decision_mismatch',
        message: `Exit condition for unit "${params.currentUnitId}" requires tracker decision "${expectedDecision}".`
      });
    }

    if (typeof minimumProgress === 'number' && params.acceptedTracker.progressPercent < minimumProgress) {
      failureCategory = failureCategory ?? 'TRACKER';
      issues.push({
        code: 'exit_condition_progress_too_low',
        message: `Exit condition for unit "${params.currentUnitId}" requires progressPercent >= ${minimumProgress}.`
      });
    }

    if (requiresTracker !== true && issues.length === 0) {
      // No-op; keeps the structured marker accepted without changing current semantics.
    }
  } else if (parsedCondition && (parsedCondition.status || parsedCondition.decision || parsedCondition.progress_percent || parsedCondition.progressPercent)) {
    failureCategory = 'TRACKER';
    issues.push({
      code: 'exit_condition_requires_tracker',
      message: `Exit condition for unit "${params.currentUnitId}" requires a valid progress tracker.`
    });
  } else if (parsedCondition?.requiresTracker === true && !params.acceptedTracker) {
    failureCategory = 'TRACKER';
    issues.push({
      code: 'exit_condition_requires_tracker',
      message: `Exit condition for unit "${params.currentUnitId}" requires a valid progress tracker.`
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    requiredOutputKeys,
    failureCategory
  };
}
