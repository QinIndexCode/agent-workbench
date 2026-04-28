import {
  ExplicitOutputEnvelope,
  AcceptanceFailureCategory,
  PendingCorrectionKind,
  ProgressTracker
} from '../contracts/types';

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface TrackerSemanticPolicy {
  profileId?: 'analyze' | 'implement' | 'verify' | null;
  allowEarlyTerminate?: boolean;
  requireToolEvidence?: boolean;
  emittedToolEvidenceCount?: number;
  requireDelegationEvidence?: boolean;
  emittedDelegationEvidenceCount?: number;
  requireArtifactWriteEvidence?: boolean;
  emittedWriteEvidencePaths?: string[];
  requireVerificationEvidence?: boolean;
  emittedVerificationEvidenceCount?: number;
}

export interface AcceptanceCorrectionContext {
  pendingCorrection?: PendingCorrectionKind | null;
  priorAcceptedOutput?: ExplicitOutputEnvelope | null;
  priorContractKeys?: string[];
}

export interface ExplicitOutputValidationResult {
  ok: boolean;
  contractKeys: string[];
  issues: ValidationIssue[];
  acceptedOutput: ExplicitOutputEnvelope | null;
}

export interface ProgressTrackerValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  acceptedTracker: ProgressTracker | null;
}

export interface ParsedTurnAcceptanceResult {
  ok: boolean;
  pendingCorrection: PendingCorrectionKind;
  failureCategory: AcceptanceFailureCategory | null;
  acceptedOutput: ExplicitOutputEnvelope | null;
  acceptedTracker: ProgressTracker | null;
  issues: ValidationIssue[];
  contractKeys: string[];
  exitCondition: {
    ok: boolean;
    issueCodes: string[];
    requiredOutputKeys: string[];
    failureCategory: 'OUTPUT' | 'TRACKER' | null;
  };
}
