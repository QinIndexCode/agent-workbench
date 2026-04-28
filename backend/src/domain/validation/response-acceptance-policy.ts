import { ParsedTurn } from '../contracts/types';
import { AcceptanceCorrectionContext, ParsedTurnAcceptanceResult, TrackerSemanticPolicy } from './types';
import { evaluateExitCondition } from './evaluate-exit-condition';
import { validateExplicitOutput } from './validate-explicit-output';
import { validateProgressTracker } from './validate-progress-tracker';

function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function collectNormalizedArtifactCandidates(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/[,\n;]+/u)
    .map((item) => normalizeWorkspaceRelativePath(item))
    .filter((item): item is string => !!item);
}

function collectDeclaredArtifactPaths(params: {
  acceptedOutput: ParsedTurnAcceptanceResult['acceptedOutput'];
  acceptedTracker: NonNullable<ReturnType<typeof validateProgressTracker>['acceptedTracker']>;
}): string[] {
  const declared = new Set<string>();
  const trackerFiles = params.acceptedTracker.filesCreated ?? [];
  for (const filePath of trackerFiles) {
    const normalized = normalizeWorkspaceRelativePath(filePath);
    if (normalized) {
      declared.add(normalized);
    }
  }
  const parsedOutput = params.acceptedOutput?.parsedJson;
  if (parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput)) {
    for (const key of ['artifact', 'path', 'file']) {
      for (const normalized of collectNormalizedArtifactCandidates((parsedOutput as Record<string, unknown>)[key])) {
        declared.add(normalized);
      }
    }
  }
  return Array.from(declared);
}

function collectTrackerArtifactPaths(
  acceptedTracker: NonNullable<ReturnType<typeof validateProgressTracker>['acceptedTracker']> | null
): string[] {
  if (!acceptedTracker) {
    return [];
  }
  return acceptedTracker.filesCreated
    .map((filePath) => normalizeWorkspaceRelativePath(filePath))
    .filter((filePath): filePath is string => !!filePath);
}

function collectExplicitOutputArtifactPaths(
  acceptedOutput: ParsedTurnAcceptanceResult['acceptedOutput']
): string[] {
  const parsedOutput = acceptedOutput?.parsedJson;
  if (!parsedOutput || typeof parsedOutput !== 'object' || Array.isArray(parsedOutput)) {
    return [];
  }
  const declared = new Set<string>();
  for (const key of ['artifact', 'path', 'file']) {
    for (const normalized of collectNormalizedArtifactCandidates((parsedOutput as Record<string, unknown>)[key])) {
      declared.add(normalized);
    }
  }
  return Array.from(declared);
}

function classifyOutputFailure(issues: Array<{ code: string }>): ParsedTurnAcceptanceResult['failureCategory'] {
  if (issues.some((issue) => issue.code === 'missing_contract_key')) {
    return 'output_contract_mismatch';
  }
  return 'response_shape_mismatch';
}

function classifyTrackerFailure(issues: Array<{ code: string }>): ParsedTurnAcceptanceResult['failureCategory'] {
  if (issues.some((issue) => issue.code === 'missing_progress_tracker')) {
    return 'tracker_missing_after_valid_output';
  }
  if (issues.some((issue) => issue.code === 'tracker_early_terminate_before_remaining_work')) {
    return 'provider_style_incompatibility';
  }
  if (issues.some((issue) => issue.code === 'artifact_write_required_but_not_emitted')) {
    return 'artifact_write_required_but_not_emitted';
  }
  if (issues.some((issue) => issue.code === 'required_delegation_missing')) {
    return 'required_delegation_missing';
  }
  if (issues.some((issue) => issue.code === 'missing_required_tool_evidence')) {
    return 'tool_action_required_but_not_emitted';
  }
  return 'response_shape_mismatch';
}

function classifyExitFailure(params: {
  failureCategory: 'OUTPUT' | 'TRACKER' | null;
  issues: Array<{ code: string }>;
}): ParsedTurnAcceptanceResult['failureCategory'] {
  if (params.failureCategory === 'TRACKER' && params.issues.some((issue) => issue.code === 'exit_condition_requires_tracker')) {
    return 'tracker_missing_after_valid_output';
  }
  return 'exit_condition_mismatch';
}

export function acceptParsedTurn(params: {
  currentUnitId: string;
  parsed: ParsedTurn;
  outputContract?: string;
  exitCondition?: string;
  trackerPolicy?: TrackerSemanticPolicy;
  correctionContext?: AcceptanceCorrectionContext;
}): ParsedTurnAcceptanceResult {
  const currentUnitToolCallCount = params.parsed.toolCalls.filter((call) => (
    call.unitId === params.currentUnitId || call.unitId === 'UNKNOWN'
  )).length;
  const trackerOnlyCorrectionOutput =
    params.correctionContext?.pendingCorrection === 'AWAITING_TRACKER'
    && params.parsed.explicitOutputs.length === 0
    && params.correctionContext.priorAcceptedOutput
      ? {
        ok: true,
        contractKeys: [...(params.correctionContext.priorContractKeys ?? [])],
        issues: [],
        acceptedOutput: params.correctionContext.priorAcceptedOutput
      }
      : null;
  const toolActionCorrectionOutput =
    params.correctionContext?.pendingCorrection === 'AWAITING_TOOL_ACTION'
    && currentUnitToolCallCount > 0
    && params.parsed.explicitOutputs.length === 0
    && params.correctionContext.priorAcceptedOutput
      ? {
        ok: true,
        contractKeys: [...(params.correctionContext.priorContractKeys ?? [])],
        issues: [],
        acceptedOutput: params.correctionContext.priorAcceptedOutput
      }
      : null;

  const outputValidation = trackerOnlyCorrectionOutput ?? toolActionCorrectionOutput ?? validateExplicitOutput({
    currentUnitId: params.currentUnitId,
    explicitOutputs: params.parsed.explicitOutputs,
    outputContract: params.outputContract
  });

  if (!outputValidation.ok) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
      failureCategory: classifyOutputFailure(outputValidation.issues),
      acceptedOutput: null,
      acceptedTracker: null,
      issues: outputValidation.issues,
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }

  const trackerValidation = validateProgressTracker({
    currentUnitId: params.currentUnitId,
    trackers: params.parsed.trackers,
    trackerPolicy: params.trackerPolicy
  });

  if (!trackerValidation.ok) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_TRACKER',
      failureCategory: classifyTrackerFailure(trackerValidation.issues),
      acceptedOutput: outputValidation.acceptedOutput,
      acceptedTracker: null,
      issues: trackerValidation.issues,
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }

  const requiresToolEvidence = params.trackerPolicy?.requireToolEvidence === true;
  const requiresDelegationEvidence = params.trackerPolicy?.requireDelegationEvidence === true;
  const requiresArtifactWriteEvidence = params.trackerPolicy?.requireArtifactWriteEvidence === true;
  const emittedWriteEvidencePaths = new Set(
    (params.trackerPolicy?.emittedWriteEvidencePaths ?? [])
      .map((value) => normalizeWorkspaceRelativePath(value))
      .filter((value): value is string => !!value)
  );
  const requiresVerificationEvidence = params.trackerPolicy?.requireVerificationEvidence === true;
  const emittedVerificationEvidenceCount = params.trackerPolicy?.emittedVerificationEvidenceCount ?? 0;
  const emittedToolEvidenceCount = params.trackerPolicy?.emittedToolEvidenceCount
    ?? params.parsed.toolCalls.filter((call) => call.unitId === params.currentUnitId || call.unitId === 'UNKNOWN').length;
  const emittedDelegationEvidenceCount = params.trackerPolicy?.emittedDelegationEvidenceCount ?? 0;
  if (
    requiresDelegationEvidence
    && trackerValidation.acceptedTracker
    && emittedDelegationEvidenceCount < 1
  ) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      failureCategory: 'required_delegation_missing',
      acceptedOutput: outputValidation.acceptedOutput,
      acceptedTracker: null,
      issues: [{
        code: 'required_delegation_missing',
        message: `Unit "${params.currentUnitId}" must call delegate_subtask and create a real child task before parent delivery can continue.`
      }],
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }
  const acceptedTracker = trackerValidation.acceptedTracker;
  const acceptedOutput = outputValidation.acceptedOutput;
  const trackerArtifactPaths = collectTrackerArtifactPaths(acceptedTracker);
  const declaredArtifactPaths = acceptedTracker
    ? collectDeclaredArtifactPaths({
      acceptedOutput,
      acceptedTracker
    })
    : [];
  const explicitOutputArtifactPaths = collectExplicitOutputArtifactPaths(acceptedOutput);
  if (
    requiresArtifactWriteEvidence
    && acceptedTracker
    && acceptedTracker.status === 'COMPLETE'
    && declaredArtifactPaths.length > 0
  ) {
    const missingTrackerWriteEvidencePaths = trackerArtifactPaths.filter(
      (artifactPath) => !emittedWriteEvidencePaths.has(artifactPath)
    );
    if (missingTrackerWriteEvidencePaths.length > 0) {
      return {
        ok: false,
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        failureCategory: 'artifact_write_required_but_not_emitted',
        acceptedOutput,
        acceptedTracker: null,
        issues: [{
          code: 'artifact_write_required_but_not_emitted',
          message: `Unit "${params.currentUnitId}" declared artifact paths without matching write evidence: ${missingTrackerWriteEvidencePaths.join(', ')}.`
        }],
        contractKeys: outputValidation.contractKeys,
        exitCondition: {
          ok: false,
          issueCodes: [],
          requiredOutputKeys: [],
          failureCategory: null
        }
      };
    }
    const mismatchedExplicitOutputArtifacts = explicitOutputArtifactPaths.filter(
      (artifactPath) => !emittedWriteEvidencePaths.has(artifactPath)
    );
    if (
      emittedWriteEvidencePaths.size > 0
      && mismatchedExplicitOutputArtifacts.length > 0
    ) {
      return {
        ok: false,
        pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
        failureCategory: 'response_shape_mismatch',
        acceptedOutput,
        acceptedTracker: null,
        issues: [{
          code: 'declared_artifact_path_mismatch',
          message: `Unit "${params.currentUnitId}" declared artifact paths that do not match recorded write evidence. Declared: ${mismatchedExplicitOutputArtifacts.join(', ')}. Recorded writes: ${Array.from(emittedWriteEvidencePaths).join(', ')}.`
        }],
        contractKeys: outputValidation.contractKeys,
        exitCondition: {
          ok: false,
          issueCodes: [],
          requiredOutputKeys: [],
          failureCategory: null
        }
      };
    }
    const missingWriteEvidencePaths = declaredArtifactPaths.filter((artifactPath) => !emittedWriteEvidencePaths.has(artifactPath));
    if (missingWriteEvidencePaths.length > 0) {
      return {
        ok: false,
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        failureCategory: 'artifact_write_required_but_not_emitted',
        acceptedOutput,
        acceptedTracker: null,
        issues: [{
          code: 'artifact_write_required_but_not_emitted',
          message: `Unit "${params.currentUnitId}" declared artifact paths without matching write evidence: ${missingWriteEvidencePaths.join(', ')}.`
        }],
        contractKeys: outputValidation.contractKeys,
        exitCondition: {
          ok: false,
          issueCodes: [],
          requiredOutputKeys: [],
          failureCategory: null
        }
      };
    }
  }

  if (
    requiresToolEvidence
    && acceptedTracker
    && acceptedTracker.status === 'COMPLETE'
    && emittedToolEvidenceCount < 1
  ) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      failureCategory: 'tool_action_required_but_not_emitted',
      acceptedOutput,
      acceptedTracker: null,
      issues: [{
        code: 'missing_required_tool_evidence',
        message: `Unit "${params.currentUnitId}" must emit at least one real tool action before COMPLETE can be accepted.`
      }],
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }

  if (
    requiresVerificationEvidence
    && acceptedTracker
    && acceptedTracker.status === 'COMPLETE'
    && emittedVerificationEvidenceCount < 1
  ) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      failureCategory: 'tool_action_required_but_not_emitted',
      acceptedOutput,
      acceptedTracker: null,
      issues: [{
        code: 'missing_required_tool_evidence',
        message: `Unit "${params.currentUnitId}" must emit at least one successful read/search/list/run verification action before COMPLETE can be accepted.`
      }],
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }

  if (
    requiresVerificationEvidence
    && acceptedTracker
    && acceptedTracker.status === 'COMPLETE'
    && currentUnitToolCallCount > 0
  ) {
    return {
      ok: false,
      pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
      failureCategory: 'response_shape_mismatch',
      acceptedOutput,
      acceptedTracker: null,
      issues: [{
        code: 'verification_result_not_grounded_yet',
        message: `Unit "${params.currentUnitId}" emitted COMPLETE alongside verification tool calls in the same turn. Wait for the tool results, then return a grounded explicit output and tracker in a follow-up turn.`
      }],
      contractKeys: outputValidation.contractKeys,
      exitCondition: {
        ok: false,
        issueCodes: [],
        requiredOutputKeys: [],
        failureCategory: null
      }
    };
  }

  const exitEvaluation = evaluateExitCondition({
    currentUnitId: params.currentUnitId,
    exitCondition: params.exitCondition,
    acceptedOutput: outputValidation.acceptedOutput,
    acceptedTracker: trackerValidation.acceptedTracker
  });

  if (!exitEvaluation.ok) {
    const pendingCorrection = exitEvaluation.failureCategory === 'TRACKER'
      ? 'AWAITING_TRACKER'
      : 'AWAITING_OUTPUT_CORRECTION';
    return {
      ok: false,
      pendingCorrection,
      failureCategory: classifyExitFailure({
        failureCategory: exitEvaluation.failureCategory,
        issues: exitEvaluation.issues
      }),
      acceptedOutput: outputValidation.acceptedOutput,
      acceptedTracker: trackerValidation.acceptedTracker,
      issues: exitEvaluation.issues,
      contractKeys: [
        ...outputValidation.contractKeys,
        ...exitEvaluation.requiredOutputKeys.filter((key) => !outputValidation.contractKeys.includes(key))
      ],
      exitCondition: {
        ok: false,
        issueCodes: exitEvaluation.issues.map((issue) => issue.code),
        requiredOutputKeys: exitEvaluation.requiredOutputKeys,
        failureCategory: exitEvaluation.failureCategory
      }
    };
  }

  return {
    ok: true,
    pendingCorrection: 'NONE',
    failureCategory: null,
    acceptedOutput: outputValidation.acceptedOutput,
    acceptedTracker: trackerValidation.acceptedTracker,
    issues: [],
    contractKeys: [
      ...outputValidation.contractKeys,
      ...exitEvaluation.requiredOutputKeys.filter((key) => !outputValidation.contractKeys.includes(key))
    ],
    exitCondition: {
      ok: true,
      issueCodes: [],
      requiredOutputKeys: exitEvaluation.requiredOutputKeys,
      failureCategory: null
    }
  };
}
