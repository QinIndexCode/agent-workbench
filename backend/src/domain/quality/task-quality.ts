import {
  ExecutionProfileId,
  QualityProfileId
} from '../contracts/types';
import {
  RuntimeEventRecord,
  ToolInvocationRecord
} from '../../foundation/repository/types';

export interface TaskQualityEvaluationInput {
  taskId: string;
  title: string;
  intent: string;
  unitId: string | null;
  executionProfileId: ExecutionProfileId | 'analyze';
  qualityProfileId: QualityProfileId | null | undefined;
  workspaceDir: string;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  latestVisibleOutput?: {
    summary: string | null;
    details: string | null;
    issues: string[];
  } | null;
  completionSummary?: {
    summary: string | null;
    details: string | null;
    issues: string[];
  } | null;
  toolInvocations: ToolInvocationRecord[];
  events?: RuntimeEventRecord[];
}

export interface TaskQualityEvaluationResult {
  profileId: QualityProfileId | null;
  verdict: 'passed' | 'failed' | 'not_applicable';
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
  lastEvaluatedAt: number | null;
}

function hasVisibleOutcome(input: TaskQualityEvaluationInput): boolean {
  return Boolean(
    input.latestVisibleOutput
    || input.completionSummary
    || input.artifactPaths.length > 0
    || input.artifactDestinationPaths.length > 0
    || input.toolInvocations.some((invocation) => invocation.status === 'SUCCEEDED')
  );
}

export function evaluateTaskQuality(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const profileId = typeof input.qualityProfileId === 'string' && input.qualityProfileId.trim()
    ? input.qualityProfileId.trim()
    : null;
  if (!profileId) {
    return {
      profileId: null,
      verdict: 'not_applicable',
      passedChecks: ['quality_contract_not_requested'],
      failedChecks: [],
      requiredNextEvidence: [],
      lastEvaluatedAt: null
    };
  }

  if (hasVisibleOutcome(input)) {
    return {
      profileId,
      verdict: 'passed',
      passedChecks: ['generic_quality_contract_has_runtime_evidence'],
      failedChecks: [],
      requiredNextEvidence: [],
      lastEvaluatedAt: Date.now()
    };
  }

  return {
    profileId,
    verdict: 'failed',
    passedChecks: [],
    failedChecks: ['generic_quality_contract_missing_runtime_evidence'],
    requiredNextEvidence: ['Provide visible output, artifact evidence, or successful tool evidence for the active quality contract.'],
    lastEvaluatedAt: Date.now()
  };
}

export function getQualityProfilePromptSection(profileId: QualityProfileId | null | undefined): string[] {
  const normalized = typeof profileId === 'string' && profileId.trim() ? profileId.trim() : null;
  if (!normalized) {
    return [];
  }
  return [
    'QUALITY CONTRACT',
    `- Active quality contract id: ${normalized}.`,
    '- Treat the quality contract as a generic acceptance extension. Do not assume scenario-specific rules unless the task or harness provides an explicit evidence schema.',
    '- Leave visible output, artifact evidence, or successful tool evidence that lets runtime acceptance decide whether the result is trustworthy.'
  ];
}
