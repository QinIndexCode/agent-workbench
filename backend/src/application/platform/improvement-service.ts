import path from 'node:path';
import { createHash } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { TaskQueryResponse } from '../tasks/types';
import {
  ApprovedExperienceRecord,
  BulkDeleteResult,
  ComplexTaskAcceptanceReport,
  ExperienceReport,
  ExperienceProposalPayload,
  ExperienceUpsertInput,
  GovernanceExportBundle,
  ImprovementProposal,
  InstructionSkillProposalPayload,
  OptimizationRecommendationCategory,
  PlatformActionResult,
  RealTaskArchiveEntry,
  RealTaskArchiveStatus
} from './types';
import { buildTaskExecutionSummary } from '../tasks/task-execution-observability';
import { MemoryService } from './memory-service';
import { PlatformMutationRecorder } from './platform-mutation-recorder';
import { SkillService } from './skill-service';
import { getTaskPatternKeyFromDefinition } from './task-pattern';

interface ArchiveEligibilityDecision {
  eligible: boolean;
  reason: string;
  complexitySignals: string[];
  actionBearingSignals: string[];
}

interface TaskImprovementStateRecord {
  taskId: string;
  taskTitle: string;
  lifecycleStatus: ExperienceReport['lifecycleStatus'];
  updatedAt: number;
  patternKey: string;
  reviewScore: number;
  experienceReport: ExperienceReport;
  archiveStatus: RealTaskArchiveStatus;
  proposalIds: string[];
}

const ACTION_BEARING_COMPLEXITY_SIGNALS = new Set([
  'tool_activity',
  'artifact_delivery',
  'approval',
  'correction_or_recovery',
  'delegation'
]);

function truncateText(value: string | null | undefined, maxLength = 240): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function createScopedDedupeKey(kind: string, parts: Array<string | null | undefined>): string {
  const normalizedKind = normalizeKey(kind) || 'proposal';
  const hint = normalizeKey(
    parts
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('-')
  ).slice(0, 24) || 'scope';
  const digest = createHash('sha256')
    .update([kind, ...parts.map((value) => (value ?? '').trim())].join('\u001f'))
    .digest('hex')
    .slice(0, 16);
  return `${normalizedKind}-${hint}-${digest}`;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))];
}

function mergeEvidenceTaskIds(...sets: string[][]): string[] {
  return dedupeStrings(sets.flat());
}

async function readCollection<T>(
  foundation: BackendNewFoundation,
  filePath: string
): Promise<T[]> {
  if (!await foundation.storage.exists(filePath)) {
    return [];
  }
  return foundation.storage.readJson<T[]>(filePath, foundation.config.storage.encoding);
}

async function writeCollection<T>(
  foundation: BackendNewFoundation,
  filePath: string,
  records: T[]
): Promise<void> {
  await foundation.storage.ensureDir(path.dirname(filePath));
  await foundation.storage.writeJson(filePath, records, foundation.config.storage.jsonSpacing);
}

function readArtifactEvidence(report: Partial<ExperienceReport> | null | undefined): ExperienceReport['artifactEvidence'] {
  const legacyReport = report as (Partial<ExperienceReport> & {
    artifactQuality?: ExperienceReport['artifactEvidence'];
  }) | null | undefined;
  return (legacyReport?.artifactEvidence ?? legacyReport?.artifactQuality ?? 'none') as ExperienceReport['artifactEvidence'];
}

function readReviewScore(
  record: { reviewScore?: unknown; qualityScore?: unknown } | null | undefined,
  fallback = 0.5
): number {
  if (typeof record?.reviewScore === 'number' && Number.isFinite(record.reviewScore)) {
    return record.reviewScore;
  }
  if (typeof record?.qualityScore === 'number' && Number.isFinite(record.qualityScore)) {
    return record.qualityScore;
  }
  return fallback;
}

function normalizeExperienceReport(
  report: Partial<ExperienceReport> | null | undefined,
  defaults: {
    taskId: string;
    lifecycleStatus: ExperienceReport['lifecycleStatus'];
    summary: string;
  }
): ExperienceReport {
  return {
    reportId: report?.reportId ?? `exp_${defaults.taskId}`,
    taskId: report?.taskId ?? defaults.taskId,
    lifecycleStatus: (report?.lifecycleStatus ?? defaults.lifecycleStatus) as ExperienceReport['lifecycleStatus'],
    summary: truncateText(report?.summary ?? defaults.summary) || defaults.summary,
    outcome: (report?.outcome ?? (
      defaults.lifecycleStatus === 'COMPLETED'
        ? 'success'
        : defaults.lifecycleStatus === 'FAILED'
          ? 'failed'
          : 'cancelled'
    )) as ExperienceReport['outcome'],
    artifactEvidence: readArtifactEvidence(report),
    truthCompleteness: (report?.truthCompleteness ?? 'partial') as ExperienceReport['truthCompleteness'],
    failureTaxonomy: Array.isArray(report?.failureTaxonomy) ? report.failureTaxonomy : [],
    keyFacts: Array.isArray(report?.keyFacts) ? report.keyFacts : [],
    createdAt: report?.createdAt ?? Date.now(),
    complexitySignals: Array.isArray(report?.complexitySignals) ? dedupeStrings(report.complexitySignals) : []
  };
}

function normalizeImprovementProposal(record: ImprovementProposal): ImprovementProposal {
  const lifecycleStatus = (record.experienceReport?.lifecycleStatus ?? 'COMPLETED') as ExperienceReport['lifecycleStatus'];
  const normalizedExperience = normalizeExperienceReport(record.experienceReport, {
    taskId: record.taskId,
    lifecycleStatus,
    summary: record.summary || `${record.title || record.taskId} improvement proposal`
  });
  return {
    ...record,
    evidenceTaskIds: Array.isArray(record.evidenceTaskIds) ? dedupeStrings(record.evidenceTaskIds) : [],
    updatedAt: record.updatedAt ?? record.createdAt ?? Date.now(),
    archivedAt: record.archivedAt ?? null,
    patternKey: record.patternKey ?? normalizeKey(`${record.kind}-${record.taskId}`),
    dedupeKey: record.dedupeKey ?? normalizeKey(`${record.kind}-${record.taskId}-${record.title}`),
    reviewScore: readReviewScore(record),
    archiveEligible: record.archiveEligible ?? false,
    duplicateOfProposalId: record.duplicateOfProposalId ?? null,
    conflictsWithProposalIds: Array.isArray(record.conflictsWithProposalIds) ? dedupeStrings(record.conflictsWithProposalIds) : [],
    supersededByProposalId: record.supersededByProposalId ?? null,
    experienceReport: normalizedExperience,
    lessonProposal: record.lessonProposal ?? null,
    experienceProposal: record.experienceProposal
      ? {
        ...record.experienceProposal,
        applicableScenarios: Array.isArray(record.experienceProposal.applicableScenarios)
          ? dedupeStrings(record.experienceProposal.applicableScenarios)
          : [],
        limitations: Array.isArray(record.experienceProposal.limitations)
          ? dedupeStrings(record.experienceProposal.limitations)
          : [],
        materializedPath: record.experienceProposal.materializedPath ?? null,
        validationStatus: record.experienceProposal.validationStatus ?? 'monitoring',
        successfulReuseTaskIds: Array.isArray(record.experienceProposal.successfulReuseTaskIds)
          ? dedupeStrings(record.experienceProposal.successfulReuseTaskIds)
          : [],
        failedReuseTaskIds: Array.isArray(record.experienceProposal.failedReuseTaskIds)
          ? dedupeStrings(record.experienceProposal.failedReuseTaskIds)
          : [],
        lastValidatedAt: record.experienceProposal.lastValidatedAt ?? null
      }
      : null,
    instructionSkillProposal: record.instructionSkillProposal
      ? {
        ...record.instructionSkillProposal,
        applicableScenarios: Array.isArray(record.instructionSkillProposal.applicableScenarios)
          ? dedupeStrings(record.instructionSkillProposal.applicableScenarios)
          : [],
        inputBoundaries: Array.isArray(record.instructionSkillProposal.inputBoundaries)
          ? dedupeStrings(record.instructionSkillProposal.inputBoundaries)
          : [],
        prohibitions: Array.isArray(record.instructionSkillProposal.prohibitions)
          ? dedupeStrings(record.instructionSkillProposal.prohibitions)
          : [],
        materializedRootDir: record.instructionSkillProposal.materializedRootDir ?? null,
        importedSkillId: record.instructionSkillProposal.importedSkillId ?? null
      }
      : null,
    optimizationRecommendation: record.optimizationRecommendation ?? null,
    metadata: record.metadata ?? {}
  };
}

function normalizeApprovedExperienceRecord(record: ApprovedExperienceRecord): ApprovedExperienceRecord {
  return {
    ...record,
    patternKey: record.patternKey ?? normalizeKey(`experience-${record.proposalId}`),
    title: truncateText(record.title, 120) || record.title,
    materializedPath: record.materializedPath,
    referenceSummary: truncateText(record.referenceSummary, 240) || record.referenceSummary,
    applicableScenarios: Array.isArray(record.applicableScenarios)
      ? dedupeStrings(record.applicableScenarios)
      : [],
    limitations: Array.isArray(record.limitations)
      ? dedupeStrings(record.limitations)
      : [],
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
    validationStatus: record.validationStatus ?? 'monitoring',
    successfulReuseTaskIds: Array.isArray(record.successfulReuseTaskIds)
      ? dedupeStrings(record.successfulReuseTaskIds)
      : [],
    failedReuseTaskIds: Array.isArray(record.failedReuseTaskIds)
      ? dedupeStrings(record.failedReuseTaskIds)
      : [],
    lastValidatedAt: record.lastValidatedAt ?? null,
    createdAt: record.createdAt ?? Date.now(),
    updatedAt: record.updatedAt ?? Date.now()
  };
}

function buildManualExperienceMarkdown(input: {
  title: string;
  referenceSummary: string;
  applicableScenarios: string[];
  limitations: string[];
  evidenceTaskIds: string[];
}): string {
  return buildExperienceMarkdown({
    title: input.title,
    summary: input.referenceSummary,
    applicableScenarios: input.applicableScenarios,
    limitations: input.limitations,
    evidenceTaskIds: input.evidenceTaskIds
  });
}

function normalizeExperienceId(value: string | null | undefined): string {
  return normalizeKey(value?.trim() || 'experience') || 'experience';
}

function isWithinDir(candidatePath: string, parentPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

function buildExperienceExportMarkdown(records: ApprovedExperienceRecord[]): string {
  const sections = records.map((record) => [
    `# ${record.title}`,
    '',
    `- Proposal: ${record.proposalId}`,
    `- Pattern: ${record.patternKey}`,
    `- Status: ${record.validationStatus}`,
    `- Confidence: ${record.confidence.toFixed(2)}`,
    `- Materialized: ${record.materializedPath}`,
    '',
    '## Reference',
    record.referenceSummary,
    '',
    '## Applicable Scenarios',
    ...(record.applicableScenarios.length ? record.applicableScenarios.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## Limits',
    ...(record.limitations.length ? record.limitations.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## Reuse Evidence',
    `- Successful: ${record.successfulReuseTaskIds.join(', ') || 'none'}`,
    `- Failed: ${record.failedReuseTaskIds.join(', ') || 'none'}`
  ].join('\n'));
  return `${sections.join('\n\n---\n\n')}\n`;
}

function normalizeArchiveStatus(
  status: Partial<RealTaskArchiveStatus> | null | undefined,
  taskId: string
): RealTaskArchiveStatus {
  return {
    archived: status?.archived ?? false,
    eligible: status?.eligible ?? status?.archived ?? false,
    reason: status?.reason ?? (status?.archived ? 'legacy_archived' : 'not_processed'),
    archiveEntryId: status?.archiveEntryId ?? (status?.archived ? `archive_${taskId}` : null),
    complexitySignals: Array.isArray(status?.complexitySignals) ? dedupeStrings(status.complexitySignals) : [],
    lastArchivedAt: status?.lastArchivedAt ?? null
  };
}

function normalizeArchiveEntry(record: RealTaskArchiveEntry): RealTaskArchiveEntry {
  const lifecycleStatus = (record.lifecycleStatus ?? record.experienceReport?.lifecycleStatus ?? 'COMPLETED') as ExperienceReport['lifecycleStatus'];
  const normalizedExperience = normalizeExperienceReport(record.experienceReport, {
    taskId: record.taskId,
    lifecycleStatus,
    summary: record.experienceReport?.summary || `${record.taskId} archive entry`
  });
  const complexitySignals = Array.isArray(record.archiveEligibility?.complexitySignals)
    ? dedupeStrings(record.archiveEligibility.complexitySignals)
    : normalizedExperience.complexitySignals;
  return {
    ...record,
    lifecycleStatus,
    archivedAt: record.archivedAt ?? Date.now(),
    proposalIds: Array.isArray(record.proposalIds) ? dedupeStrings(record.proposalIds) : [],
    archiveEligibility: {
      eligible: record.archiveEligibility?.eligible ?? true,
      reason: record.archiveEligibility?.reason ?? 'legacy_archived',
      complexitySignals
    },
    reviewScore: readReviewScore(record),
    patternKey: record.patternKey ?? normalizeKey(`${record.lifecycleStatus}-${record.taskId}`),
    experienceReport: normalizedExperience
  };
}

function normalizeTaskImprovementState(record: TaskImprovementStateRecord): TaskImprovementStateRecord {
  const lifecycleStatus = (record.lifecycleStatus ?? record.experienceReport?.lifecycleStatus ?? 'COMPLETED') as ExperienceReport['lifecycleStatus'];
  const normalizedExperience = normalizeExperienceReport(record.experienceReport, {
    taskId: record.taskId,
    lifecycleStatus,
    summary: record.taskTitle || `${record.taskId} terminal task`
  });
  return {
    ...record,
    lifecycleStatus,
    updatedAt: record.updatedAt ?? Date.now(),
    patternKey: record.patternKey ?? normalizeKey(`${record.taskTitle}-${record.taskId}`),
    reviewScore: readReviewScore(record),
    experienceReport: normalizedExperience,
    archiveStatus: normalizeArchiveStatus(record.archiveStatus, record.taskId),
    proposalIds: Array.isArray(record.proposalIds) ? dedupeStrings(record.proposalIds) : []
  };
}

function extractComplexitySignals(task: TaskQueryResponse): string[] {
  const signals: string[] = [];
  const publicDiscussionCount = task.conversations.filter((message) => message.role !== 'assistant').length
    + task.operatorMessages.length;
  if (publicDiscussionCount > 1) {
    signals.push('multi_turn');
  }
  if (task.visibleToolActivities.length > 0) {
    signals.push('tool_activity');
  }
  if (
    (task.completionSummary?.artifactPaths.length ?? 0) > 0
    || (task.latestVisibleOutput?.artifactPaths.length ?? 0) > 0
    || (task.completionSummary?.artifactDestinationPaths.length ?? 0) > 0
    || task.completionSummary?.artifactDestinationDir
  ) {
    signals.push('artifact_delivery');
  }
  if (task.pendingApprovals.length > 0 || task.events.some((event) => /APPROVAL/i.test(event.type))) {
    signals.push('approval');
  }
  if (
    task.runtime.pendingCorrection !== 'NONE'
    || task.events.some((event) => /CORRECTION|RECOVERY|FAILED/i.test(event.type))
    || task.diagnostics.lastError
  ) {
    signals.push('correction_or_recovery');
  }
  if (task.delegationSummary.activeChildTask || task.delegationSummary.recentChildren.length > 0 || task.delegationSummary.required) {
    signals.push('delegation');
  }
  return dedupeStrings(signals);
}

function getActionBearingSignals(complexitySignals: string[]): string[] {
  return complexitySignals.filter((signal) => ACTION_BEARING_COMPLEXITY_SIGNALS.has(signal));
}

function computeArtifactEvidence(task: TaskQueryResponse): ExperienceReport['artifactEvidence'] {
  if ((task.completionSummary?.artifactDestinationPaths.length ?? 0) > 0 || task.completionSummary?.artifactDestinationDir) {
    return 'delivered';
  }
  if ((task.completionSummary?.artifactPaths.length ?? 0) > 0 || (task.latestVisibleOutput?.artifactPaths.length ?? 0) > 0) {
    return 'artifact_only';
  }
  return 'none';
}

function computeTruthCompleteness(task: TaskQueryResponse): ExperienceReport['truthCompleteness'] {
  const hasCoreTruth = Boolean(
    task.statusSummary?.label
    && task.primaryAction?.label
    && task.nextActionSummary?.label
    && task.visibleToolActivities
  );
  const hasCompletionTruth = Boolean(
    task.completionSummary
    && (
      task.completionSummary.summary
      || task.completionSummary.artifactDestinationDir
      || task.completionSummary.artifactDestinationPaths.length > 0
      || task.completionSummary.artifactPaths.length > 0
    )
  );
  return hasCoreTruth && (task.runtime.lifecycleStatus !== 'COMPLETED' || hasCompletionTruth)
    ? 'complete'
    : 'partial';
}

function computeFailureTaxonomy(task: TaskQueryResponse): string[] {
  const categories: string[] = [];
  if (task.delegationSummary.missingRequiredDelegation) {
    categories.push('required_delegation_missing');
  }
  if (task.pendingApprovals.length > 0) {
    categories.push('approval_blocked');
  }
  if (task.diagnostics.providerFailure?.category) {
    categories.push(task.diagnostics.providerFailure.category);
  }
  if (task.runtime.pendingCorrection !== 'NONE') {
    categories.push(task.runtime.pendingCorrection.toLowerCase());
  }
  if (task.diagnostics.lastError) {
    categories.push('runtime_error');
  }
  if (task.runtime.lifecycleStatus === 'FAILED') {
    categories.push('task_failed');
  }
  if (task.runtime.lifecycleStatus === 'CANCELLED') {
    categories.push('task_cancelled');
  }
  return dedupeStrings(categories);
}

function buildExperienceReport(task: TaskQueryResponse): ExperienceReport {
  const complexitySignals = extractComplexitySignals(task);
  const artifactEvidence = computeArtifactEvidence(task);
  const truthCompleteness = computeTruthCompleteness(task);
  const failureTaxonomy = computeFailureTaxonomy(task);
  const resultSummary = truncateText(
    task.completionSummary?.summary
    ?? task.latestVisibleOutput?.summary
    ?? task.statusSummary.detail
  );
  const outcome: ExperienceReport['outcome'] = task.runtime.lifecycleStatus === 'COMPLETED'
    ? 'success'
    : task.runtime.lifecycleStatus === 'FAILED'
      ? 'failed'
      : 'cancelled';

  return {
    reportId: `exp_${task.definition.taskId}`,
    taskId: task.definition.taskId,
    lifecycleStatus: task.runtime.lifecycleStatus as ExperienceReport['lifecycleStatus'],
    summary: resultSummary || `${task.definition.title} ended with ${task.runtime.lifecycleStatus.toLowerCase()}.`,
    outcome,
    artifactEvidence,
    truthCompleteness,
    failureTaxonomy,
    keyFacts: dedupeStrings([
      task.statusSummary.label,
      task.primaryAction.label,
      task.nextActionSummary.label,
      task.completionSummary?.summary,
      task.completionSummary?.artifactDestinationDir,
      task.diagnostics.lastError,
      task.diagnostics.providerFailure?.message
    ]).slice(0, 8),
    createdAt: Date.now(),
    complexitySignals
  };
}

function computeArchiveEligibility(task: TaskQueryResponse, experienceReport: ExperienceReport): ArchiveEligibilityDecision {
  const complexitySignals = experienceReport.complexitySignals;
  const actionBearingSignals = getActionBearingSignals(complexitySignals);
  const failedOrCancelled = task.runtime.lifecycleStatus === 'FAILED' || task.runtime.lifecycleStatus === 'CANCELLED';
  const eligible = failedOrCancelled
    ? actionBearingSignals.length > 0 && experienceReport.failureTaxonomy.length > 0
    : complexitySignals.length >= 2 && actionBearingSignals.length > 0;

  return {
    eligible,
    reason: eligible
      ? (failedOrCancelled ? 'failure_archive_eligible' : 'complex_threshold_met')
      : 'not_complex_enough',
    complexitySignals,
    actionBearingSignals
  };
}

function computeReviewScore(params: {
  task: TaskQueryResponse;
  experienceReport: ExperienceReport;
  evidenceCount?: number;
  optimisticBonus?: number;
}): number {
  let score = 0.42;
  score += Math.min(params.experienceReport.complexitySignals.length, 4) * 0.07;
  score += params.experienceReport.truthCompleteness === 'complete' ? 0.16 : 0.05;
  score += params.experienceReport.artifactEvidence === 'delivered'
    ? 0.16
    : params.experienceReport.artifactEvidence === 'artifact_only'
      ? 0.08
      : 0;
  score += params.task.runtime.lifecycleStatus === 'COMPLETED'
    ? 0.1
    : params.experienceReport.failureTaxonomy.length > 0
      ? 0.08
      : 0.03;
  score += Math.min(params.evidenceCount ?? 1, 4) * 0.03;
  score += params.optimisticBonus ?? 0;
  return Number(Math.max(0.05, Math.min(0.98, score)).toFixed(2));
}

function buildLessonProposal(task: TaskQueryResponse, experienceReport: ExperienceReport, patternKey: string): ImprovementProposal | null {
  const isSuccess = experienceReport.outcome === 'success';
  const hasSuccessTruth = Boolean(
    task.completionSummary?.summary
    || task.latestVisibleOutput?.summary
    || task.completionSummary?.artifactDestinationDir
    || (task.completionSummary?.artifactDestinationPaths.length ?? 0) > 0
  );
  if (isSuccess && !hasSuccessTruth) {
    return null;
  }
  if (!isSuccess && experienceReport.failureTaxonomy.length === 0) {
    return null;
  }

  const lessonSummary = isSuccess
    ? truncateText(
      task.completionSummary?.artifactDestinationDir
        ? 'When a delivery-first task lands cleanly, keep the delivered path and completion summary visible so the next operator can continue from the artifact.'
        : 'When a task completes cleanly, preserve the operator-facing completion summary and next action as a reusable lesson.'
    )
    : truncateText(
      `When a task ends in ${task.runtime.lifecycleStatus.toLowerCase()}, surface the blocker explicitly and retain the failure evidence for the next guided attempt.`
    );
  const triggerPattern = isSuccess
    ? (experienceReport.complexitySignals.join(', ') || 'successful_terminal_task')
    : (experienceReport.failureTaxonomy.join(', ') || 'failed_terminal_task');
  const dedupeKey = normalizeKey(`lesson-${patternKey}-${isSuccess ? 'success' : 'failure'}-${triggerPattern}`);

  return {
    proposalId: `proposal_lesson_${task.definition.taskId}`,
    kind: 'lesson',
    status: 'PENDING',
    taskId: task.definition.taskId,
    title: `${task.definition.title} lesson`,
    summary: lessonSummary,
    evidenceTaskIds: [task.definition.taskId],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    patternKey,
    dedupeKey,
    reviewScore: computeReviewScore({ task, experienceReport }),
    archiveEligible: true,
    duplicateOfProposalId: null,
    conflictsWithProposalIds: [],
    supersededByProposalId: null,
    experienceReport,
    lessonProposal: {
      title: `${task.definition.title} lesson`,
      lessonSummary,
      triggerPattern,
      recommendedUseScope: isSuccess
        ? 'Reuse for similar delivery-oriented tasks in the same workspace.'
        : 'Reuse when the runtime encounters a similar blocker or recovery path.',
      confidence: isSuccess ? 0.76 : 0.67
    },
    experienceProposal: null,
    instructionSkillProposal: null,
    optimizationRecommendation: null,
    metadata: {
      complexitySignals: experienceReport.complexitySignals,
      lessonOutcome: isSuccess ? 'success' : 'failure'
    }
  };
}

function buildSkillMarkdown(params: {
  title: string;
  summary: string;
  applicableScenarios: string[];
  inputBoundaries: string[];
  prohibitions: string[];
  evidenceTaskIds: string[];
}): string {
  const scenarioLines = params.applicableScenarios.map((entry) => `- ${entry}`).join('\n');
  const boundaryLines = params.inputBoundaries.map((entry) => `- ${entry}`).join('\n');
  const prohibitionLines = params.prohibitions.map((entry) => `- ${entry}`).join('\n');
  const evidenceLines = params.evidenceTaskIds.map((entry) => `- ${entry}`).join('\n');
  return `# ${params.title}

## Purpose
${params.summary}

## When To Use
${scenarioLines || '- Repeated workspace tasks with the same successful pattern.'}

## Input Boundaries
${boundaryLines || '- Use only when the task goal and artifact expectations match the evidence set.'}

## Do Not Use
${prohibitionLines || '- Do not use for unrelated tasks or when the evidence pattern conflicts.'}

## Evidence
${evidenceLines || '- No evidence recorded.'}
`;
}

function buildExperienceMarkdown(params: {
  title: string;
  summary: string;
  applicableScenarios: string[];
  limitations: string[];
  evidenceTaskIds: string[];
}): string {
  const scenarioLines = params.applicableScenarios.map((entry) => `- ${entry}`).join('\n');
  const limitationLines = params.limitations.map((entry) => `- ${entry}`).join('\n');
  const evidenceLines = params.evidenceTaskIds.map((entry) => `- ${entry}`).join('\n');
  return `# ${params.title}

## What this experience captures
${params.summary}

## When it is a useful reference
${scenarioLines || '- Revisit this note when a task has a similar shape and delivery contract.'}

## Limits
${limitationLines || '- Treat this as guidance, not an always-on runtime rule.'}

## Evidence
${evidenceLines || '- No evidence recorded.'}
`;
}

function buildExperienceProposal(params: {
  task: TaskQueryResponse;
  experienceReport: ExperienceReport;
  patternKey: string;
  matchingArchiveEntries: RealTaskArchiveEntry[];
}): ImprovementProposal | null {
  if (params.task.runtime.lifecycleStatus !== 'COMPLETED' || params.matchingArchiveEntries.length < 1) {
    return null;
  }
  const evidenceTaskIds = dedupeStrings([
    params.task.definition.taskId,
    ...params.matchingArchiveEntries.map((entry) => entry.taskId)
  ]).slice(0, 6);
  const applicableScenarios = dedupeStrings([
    `Tasks shaped like ${params.task.definition.title}`,
    params.task.completionSummary?.artifactDestinationDir
      ? 'Delivery-first tasks that finish with a clear artifact destination.'
      : 'Tasks that converge on the same reusable reference pattern.'
  ]);
  const inputBoundaries = dedupeStrings([
    params.task.definition.intent,
    'Expect the same workspace scope, delivery contract, and operator-visible result structure.'
  ]);
  const prohibitions = [
    'Do not use when the task needs a different provider boundary or execution profile.',
    'Do not use when evidence shows conflicting outcomes for the same pattern.'
  ];
  const summary = 'This repeated success pattern is stable enough to save as a reusable experience reference before it is promoted into an always-on skill.';
  const title = `${params.task.definition.units[0]?.role ?? 'workflow'} experience`;
  const payload: ExperienceProposalPayload = {
    title,
    referenceSummary: truncateText(
      `Stable reference for ${params.task.definition.title}: ${params.matchingArchiveEntries.length + 1} successful archived tasks converged on the same reusable delivery shape.`
    ),
    applicableScenarios,
    limitations: dedupeStrings([
      ...inputBoundaries,
      ...prohibitions,
      'Keep this as advisory material unless an operator explicitly promotes it into an instruction skill.'
    ]),
    confidence: 0.81,
    draftExperienceMarkdown: buildExperienceMarkdown({
      title,
      summary,
      applicableScenarios,
      limitations: dedupeStrings([
        ...inputBoundaries,
        ...prohibitions,
      ]),
      evidenceTaskIds
    }),
    materializedPath: null,
    validationStatus: 'monitoring',
    successfulReuseTaskIds: [],
    failedReuseTaskIds: [],
    lastValidatedAt: null
  };
  return {
    proposalId: `proposal_experience_${params.task.definition.taskId}`,
    kind: 'experience',
    status: 'PENDING',
    taskId: params.task.definition.taskId,
    title,
    summary,
    evidenceTaskIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    patternKey: params.patternKey,
    dedupeKey: normalizeKey(`experience-${params.patternKey}`),
    reviewScore: computeReviewScore({
      task: params.task,
      experienceReport: params.experienceReport,
      evidenceCount: evidenceTaskIds.length,
      optimisticBonus: 0.08
    }),
    archiveEligible: true,
    duplicateOfProposalId: null,
    conflictsWithProposalIds: [],
    supersededByProposalId: null,
    experienceReport: params.experienceReport,
    lessonProposal: null,
    experienceProposal: payload,
    instructionSkillProposal: null,
    optimizationRecommendation: null,
    metadata: {
      patternKey: params.patternKey,
      evidenceArchiveIds: params.matchingArchiveEntries.map((entry) => entry.archiveEntryId)
    }
  };
}

function buildInstructionSkillProposal(params: {
  task: TaskQueryResponse;
  experienceReport: ExperienceReport;
  patternKey: string;
  approvedExperience: ApprovedExperienceRecord;
  validationTaskIds: string[];
}): ImprovementProposal | null {
  if (params.task.runtime.lifecycleStatus !== 'COMPLETED') {
    return null;
  }
  const evidenceTaskIds = dedupeStrings(params.validationTaskIds).slice(0, 6);
  if (evidenceTaskIds.length < 2) {
    return null;
  }
  const applicableScenarios = dedupeStrings([
    ...params.approvedExperience.applicableScenarios,
    `Tasks shaped like ${params.task.definition.title}`,
    'Use only after the approved experience has completed at least two later successful reuse validations.'
  ]);
  const inputBoundaries = dedupeStrings([
    params.task.definition.intent,
    'Keep the same workspace scope, artifact contract, and operator-visible completion shape as the evidence set.',
    'Use only when the task family follows the same unit role, action kind, tool boundary, and approved experience scope.'
  ]);
  const prohibitions = dedupeStrings([
    'Do not use when post-approval validation recorded a conflicting failed reuse for the same pattern.',
    'Do not use when the task needs a different provider boundary, execution profile, or artifact contract.',
    'Do not promote this automatically; keep it pending operator review before import.'
  ]);
  const title = `${params.task.definition.units[0]?.role ?? 'workflow'} instruction skill`;
  const summary = 'This approved experience has now been validated by later successful reuse, so it is stable enough to hold as a pending instruction-skill candidate. It still requires operator approval before promotion into the runtime skill registry.';
  const payload: InstructionSkillProposalPayload = {
    title,
    applicableScenarios,
    inputBoundaries,
    prohibitions,
    validationSummary: `${evidenceTaskIds.length} post-approval reuse tasks validated the approved experience with no conflicting failures. Keep the candidate pending until an operator approves promotion.`,
    confidence: 0.86,
    draftSkillMarkdown: buildSkillMarkdown({
      title,
      summary,
      applicableScenarios,
      inputBoundaries,
      prohibitions,
      evidenceTaskIds
    }),
    materializedRootDir: null,
    importedSkillId: null
  };

  return {
    proposalId: `proposal_instruction_skill_${params.task.definition.taskId}`,
    kind: 'instruction_skill',
    status: 'PENDING',
    taskId: params.task.definition.taskId,
    title,
    summary,
    evidenceTaskIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    patternKey: params.patternKey,
    dedupeKey: createScopedDedupeKey('instruction-skill', [
      params.patternKey,
      params.approvedExperience.proposalId
    ]),
    reviewScore: computeReviewScore({
      task: params.task,
      experienceReport: params.experienceReport,
      evidenceCount: evidenceTaskIds.length,
      optimisticBonus: 0.12
    }),
    archiveEligible: true,
    duplicateOfProposalId: null,
    conflictsWithProposalIds: [],
    supersededByProposalId: null,
    experienceReport: params.experienceReport,
    lessonProposal: null,
    experienceProposal: null,
    instructionSkillProposal: payload,
    optimizationRecommendation: null,
    metadata: {
      patternKey: params.patternKey,
      approvedExperienceProposalId: params.approvedExperience.proposalId,
      successfulReuseTaskIds: evidenceTaskIds,
      promotionMode: 'manual_review_required'
    }
  };
}

function buildOptimizationProposal(params: {
  task: TaskQueryResponse;
  experienceReport: ExperienceReport;
  patternKey: string;
  category?: OptimizationRecommendationCategory | null;
  summary?: string | null;
}): ImprovementProposal | null {
  const category: OptimizationRecommendationCategory | null = params.category ?? (
    params.task.delegationSummary.missingRequiredDelegation
      ? 'prompt_contract'
      : params.task.pendingApprovals.length > 0
        ? 'approval_boundary'
        : params.task.runtime.lifecycleStatus !== 'COMPLETED'
          ? 'benchmark_candidate'
          : params.experienceReport.truthCompleteness === 'partial'
            ? 'memory_layer'
            : null
  );
  if (!category) {
    return null;
  }
  const summary = params.summary ?? (
    category === 'prompt_contract'
      ? 'Tighten delegation or output contracts so the runtime cannot silently skip the required child-task boundary.'
      : category === 'approval_boundary'
        ? 'Review approval and tool-boundary guidance so operator actions stay explicit and easier to resolve.'
        : category === 'memory_layer'
          ? 'Capture this task family as a memory-layer improvement candidate because delivery truth is still partial.'
          : 'Promote this task family into a future benchmark candidate so regression risk is visible earlier.'
  );
  return {
    proposalId: `proposal_optimization_${params.task.definition.taskId}_${normalizeKey(category)}`,
    kind: 'optimization',
    status: 'PENDING',
    taskId: params.task.definition.taskId,
    title: `${params.task.definition.title} optimization`,
    summary,
    evidenceTaskIds: [params.task.definition.taskId],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    patternKey: params.patternKey,
    dedupeKey: normalizeKey([
      'optimization',
      category,
      params.summary ? normalizeKey(params.summary).slice(0, 24) : null,
      params.patternKey
    ].filter(Boolean).join('-')),
    reviewScore: computeReviewScore({
      task: params.task,
      experienceReport: params.experienceReport,
      optimisticBonus: 0.02
    }),
    archiveEligible: true,
    duplicateOfProposalId: null,
    conflictsWithProposalIds: [],
    supersededByProposalId: null,
    experienceReport: params.experienceReport,
    lessonProposal: null,
    experienceProposal: null,
    instructionSkillProposal: null,
    optimizationRecommendation: {
      title: `${params.task.definition.title} optimization`,
      summary,
      category,
      confidence: category === 'benchmark_candidate' ? 0.61 : 0.72
    },
    metadata: {
      complexitySignals: params.experienceReport.complexitySignals
    }
  };
}

function getLatestWorkspaceInstructionsPayload(task: TaskQueryResponse): Record<string, unknown> | null {
  const latestWorkspaceEvent = [...task.events]
    .reverse()
    .find((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED' && event.payload && typeof event.payload === 'object');
  return latestWorkspaceEvent?.payload && typeof latestWorkspaceEvent.payload === 'object'
    ? latestWorkspaceEvent.payload as Record<string, unknown>
    : null;
}

function getValidationEligibleApprovedExperienceProposalIds(task: TaskQueryResponse): string[] {
  const payload = getLatestWorkspaceInstructionsPayload(task);
  const selected = Array.isArray(payload?.selectedApprovedExperiences)
    ? payload.selectedApprovedExperiences
    : [];
  return dedupeStrings(
    selected
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .filter((entry) => entry.validationEligible === true)
      .map((entry) => typeof entry.proposalId === 'string' ? entry.proposalId : null)
  );
}

function isApprovedExperienceEnvironmentBlocker(task: TaskQueryResponse): boolean {
  const combinedMessage = [
    task.diagnostics.providerFailure?.category,
    task.diagnostics.providerFailure?.message,
    task.diagnostics.lastError,
    task.statusSummary.detail,
    task.nextActionSummary.label
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  return /unable to verify the first certificate|certificate|timed out|timeout|\b408\b|upstream failed|network failure|request failed|rate-limited/i.test(combinedMessage);
}

function getApprovedExperienceValidationOutcome(
  task: TaskQueryResponse,
  foundation: BackendNewFoundation
): 'passed' | 'failed' | 'environment_blocker' {
  if (task.runtime.lifecycleStatus !== 'COMPLETED') {
    return isApprovedExperienceEnvironmentBlocker(task) ? 'environment_blocker' : 'failed';
  }
  const executionSummary = buildTaskExecutionSummary(task, foundation);
  const passed = executionSummary.acceptance.deterministic.verdict === 'passed';
  if (passed) {
    return 'passed';
  }
  return isApprovedExperienceEnvironmentBlocker(task) ? 'environment_blocker' : 'failed';
}

function isActiveProposalStatus(status: ImprovementProposal['status']): boolean {
  return status === 'PENDING' || status === 'APPROVED';
}

function getInstructionSkillApprovedExperienceProposalId(proposal: ImprovementProposal): string | null {
  if (proposal.kind !== 'instruction_skill') {
    return null;
  }
  const proposalId = proposal.metadata?.approvedExperienceProposalId;
  return typeof proposalId === 'string' && proposalId.trim().length > 0 ? proposalId : null;
}

function canMergeProposalCandidate(existing: ImprovementProposal, candidate: ImprovementProposal): boolean {
  if (existing.kind !== candidate.kind) {
    return false;
  }
  if (!isActiveProposalStatus(existing.status) || existing.dedupeKey !== candidate.dedupeKey) {
    return false;
  }
  if (candidate.kind === 'instruction_skill') {
    return getInstructionSkillApprovedExperienceProposalId(existing) === getInstructionSkillApprovedExperienceProposalId(candidate);
  }
  return true;
}

function hasOpposingLessonMeaning(left: ImprovementProposal, right: ImprovementProposal): boolean {
  if (left.kind !== 'lesson' || right.kind !== 'lesson') {
    return false;
  }
  return (left.experienceReport.outcome === 'success') !== (right.experienceReport.outcome === 'success');
}

function mergeProposalEvidence(existing: ImprovementProposal, incoming: ImprovementProposal): ImprovementProposal {
  const existingMergedEvidenceTaskIds = Array.isArray(existing.metadata.mergedEvidenceTaskIds)
    ? existing.metadata.mergedEvidenceTaskIds as string[]
    : [];
  const incomingMergedEvidenceTaskIds = Array.isArray(incoming.metadata.mergedEvidenceTaskIds)
    ? incoming.metadata.mergedEvidenceTaskIds as string[]
    : [];
  const existingSuccessfulReuseTaskIds = Array.isArray(existing.metadata.successfulReuseTaskIds)
    ? existing.metadata.successfulReuseTaskIds as string[]
    : [];
  const incomingSuccessfulReuseTaskIds = Array.isArray(incoming.metadata.successfulReuseTaskIds)
    ? incoming.metadata.successfulReuseTaskIds as string[]
    : [];
  const approvedExperienceProposalId = getInstructionSkillApprovedExperienceProposalId(existing)
    ?? getInstructionSkillApprovedExperienceProposalId(incoming);
  return {
    ...existing,
    evidenceTaskIds: mergeEvidenceTaskIds(existing.evidenceTaskIds, incoming.evidenceTaskIds),
    updatedAt: Date.now(),
    reviewScore: Math.max(existing.reviewScore, incoming.reviewScore),
    archiveEligible: existing.archiveEligible || incoming.archiveEligible,
    experienceReport: incoming.experienceReport,
    lessonProposal: existing.lessonProposal && incoming.lessonProposal
      ? {
        ...existing.lessonProposal,
        confidence: Math.max(existing.lessonProposal.confidence, incoming.lessonProposal.confidence)
      }
      : (existing.lessonProposal ?? incoming.lessonProposal),
    experienceProposal: existing.experienceProposal && incoming.experienceProposal
      ? {
        ...existing.experienceProposal,
        confidence: Math.max(existing.experienceProposal.confidence, incoming.experienceProposal.confidence),
        referenceSummary: incoming.experienceProposal.referenceSummary,
        draftExperienceMarkdown: incoming.experienceProposal.draftExperienceMarkdown,
        validationStatus:
          existing.experienceProposal.validationStatus === 'conflicted'
          || incoming.experienceProposal.validationStatus === 'conflicted'
            ? 'conflicted'
            : existing.experienceProposal.validationStatus === 'promotable'
              || incoming.experienceProposal.validationStatus === 'promotable'
                ? 'promotable'
                : 'monitoring',
        successfulReuseTaskIds: mergeEvidenceTaskIds(
          existing.experienceProposal.successfulReuseTaskIds,
          incoming.experienceProposal.successfulReuseTaskIds
        ),
        failedReuseTaskIds: mergeEvidenceTaskIds(
          existing.experienceProposal.failedReuseTaskIds,
          incoming.experienceProposal.failedReuseTaskIds
        ),
        lastValidatedAt: incoming.experienceProposal.lastValidatedAt ?? existing.experienceProposal.lastValidatedAt
      }
      : (existing.experienceProposal ?? incoming.experienceProposal),
    instructionSkillProposal: existing.instructionSkillProposal && incoming.instructionSkillProposal
      ? {
        ...existing.instructionSkillProposal,
        confidence: Math.max(existing.instructionSkillProposal.confidence, incoming.instructionSkillProposal.confidence),
        validationSummary: incoming.instructionSkillProposal.validationSummary,
        draftSkillMarkdown: incoming.instructionSkillProposal.draftSkillMarkdown
      }
      : (existing.instructionSkillProposal ?? incoming.instructionSkillProposal),
    optimizationRecommendation: existing.optimizationRecommendation ?? incoming.optimizationRecommendation,
    metadata: {
      ...existing.metadata,
      ...incoming.metadata,
      ...(approvedExperienceProposalId ? { approvedExperienceProposalId } : {}),
      mergedEvidenceTaskIds: mergeEvidenceTaskIds(
        existingMergedEvidenceTaskIds,
        incomingMergedEvidenceTaskIds,
        incoming.evidenceTaskIds
      ),
      successfulReuseTaskIds: mergeEvidenceTaskIds(
        existingSuccessfulReuseTaskIds,
        incomingSuccessfulReuseTaskIds
      )
    }
  };
}

export class ImprovementService {
  private readonly recorder: PlatformMutationRecorder;
  private readonly memories: MemoryService;
  private readonly skills: SkillService;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
    this.memories = new MemoryService(foundation);
    this.skills = new SkillService(foundation);
  }

  private async listProposalCollection(): Promise<ImprovementProposal[]> {
    const proposals = await readCollection<ImprovementProposal>(this.foundation, this.foundation.layout.improvementProposalsPath);
    return proposals.map(normalizeImprovementProposal).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async saveProposalCollection(records: ImprovementProposal[]): Promise<void> {
    await writeCollection(this.foundation, this.foundation.layout.improvementProposalsPath, records);
  }

  private async listArchiveCollection(): Promise<RealTaskArchiveEntry[]> {
    const archive = await readCollection<RealTaskArchiveEntry>(this.foundation, this.foundation.layout.realTaskArchivePath);
    return archive.map(normalizeArchiveEntry).sort((left, right) => right.archivedAt - left.archivedAt);
  }

  private async saveArchiveCollection(records: RealTaskArchiveEntry[]): Promise<void> {
    await writeCollection(this.foundation, this.foundation.layout.realTaskArchivePath, records);
  }

  private async listApprovedExperienceCollection(): Promise<ApprovedExperienceRecord[]> {
    const records = await readCollection<ApprovedExperienceRecord>(
      this.foundation,
      this.foundation.layout.approvedExperiencesPath
    );
    return records.map(normalizeApprovedExperienceRecord).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async saveApprovedExperienceCollection(records: ApprovedExperienceRecord[]): Promise<void> {
    await writeCollection(this.foundation, this.foundation.layout.approvedExperiencesPath, records);
  }

  private async listTaskStateCollection(): Promise<TaskImprovementStateRecord[]> {
    const records = await readCollection<TaskImprovementStateRecord>(this.foundation, this.foundation.layout.taskImprovementStatesPath);
    return records.map(normalizeTaskImprovementState).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async saveTaskStateCollection(records: TaskImprovementStateRecord[]): Promise<void> {
    await writeCollection(this.foundation, this.foundation.layout.taskImprovementStatesPath, records);
  }

  async listProposals(): Promise<ImprovementProposal[]> {
    return this.listProposalCollection();
  }

  async getProposal(proposalId: string): Promise<ImprovementProposal | null> {
    return (await this.listProposalCollection()).find((proposal) => proposal.proposalId === proposalId) ?? null;
  }

  async listTaskProposals(taskId: string): Promise<ImprovementProposal[]> {
    return (await this.listProposalCollection()).filter((proposal) => proposal.taskId === taskId);
  }

  async listArchive(): Promise<RealTaskArchiveEntry[]> {
    return this.listArchiveCollection();
  }

  async listExperiences(): Promise<ApprovedExperienceRecord[]> {
    return this.listApprovedExperienceCollection();
  }

  async getExperience(experienceId: string): Promise<ApprovedExperienceRecord | null> {
    return (await this.listApprovedExperienceCollection()).find((record) => record.proposalId === experienceId) ?? null;
  }

  async createExperience(input: ExperienceUpsertInput): Promise<PlatformActionResult<ApprovedExperienceRecord>> {
    const now = Date.now();
    const proposalId = normalizeExperienceId(input.proposalId || input.title);
    const existing = await this.getExperience(proposalId);
    if (existing) {
      throw new Error(`backend_new experience error: experience "${proposalId}" already exists.`);
    }
    const record = await this.materializeExperienceInput(input, {
      proposalId,
      createdAt: now,
      updatedAt: now
    });
    const command = await this.recorder.recordCommand({
      resourceType: 'IMPROVEMENT',
      resourceId: record.proposalId,
      action: 'UPSERT',
      input: { kind: 'experience', proposalId: record.proposalId }
    });
    try {
      await this.saveApprovedExperienceCollection([...(await this.listApprovedExperienceCollection()), record]);
      return await this.recorder.recordApplied(command, record);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async updateExperience(experienceId: string, input: ExperienceUpsertInput): Promise<PlatformActionResult<ApprovedExperienceRecord>> {
    const records = await this.listApprovedExperienceCollection();
    const existing = records.find((record) => record.proposalId === experienceId);
    if (!existing) {
      throw new Error(`backend_new experience error: unknown experience "${experienceId}".`);
    }
    const updated = await this.materializeExperienceInput(input, {
      proposalId: existing.proposalId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
      existing
    });
    const command = await this.recorder.recordCommand({
      resourceType: 'IMPROVEMENT',
      resourceId: updated.proposalId,
      action: 'UPDATE',
      input: { kind: 'experience', proposalId: updated.proposalId }
    });
    try {
      await this.saveApprovedExperienceCollection(records.map((record) => (
        record.proposalId === experienceId ? updated : record
      )));
      return await this.recorder.recordApplied(command, updated);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async deleteExperience(experienceId: string): Promise<PlatformActionResult<{ ok: true; experienceId: string }>> {
    const records = await this.listApprovedExperienceCollection();
    const existing = records.find((record) => record.proposalId === experienceId);
    if (!existing) {
      throw new Error(`backend_new experience error: unknown experience "${experienceId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'IMPROVEMENT',
      resourceId: existing.proposalId,
      action: 'DELETE',
      input: { kind: 'experience' }
    });
    try {
      await this.saveApprovedExperienceCollection(records.filter((record) => record.proposalId !== experienceId));
      if (isWithinDir(existing.materializedPath, this.foundation.layout.generatedExperiencesDirPath)) {
        const rootDir = path.dirname(existing.materializedPath);
        if (await this.foundation.storage.exists(existing.materializedPath)) {
          await this.foundation.storage.deleteFile(existing.materializedPath);
        }
        if (isWithinDir(rootDir, this.foundation.layout.generatedExperiencesDirPath) && await this.foundation.storage.exists(rootDir)) {
          await this.foundation.storage.deleteDir(rootDir);
        }
      }
      return await this.recorder.recordApplied(command, { ok: true as const, experienceId });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async bulkDeleteExperiences(experienceIds: string[]): Promise<PlatformActionResult<BulkDeleteResult>> {
    const requestedIds = dedupeStrings(experienceIds);
    const deletedIds: string[] = [];
    const failed: BulkDeleteResult['failed'] = [];
    for (const experienceId of requestedIds) {
      try {
        await this.deleteExperience(experienceId);
        deletedIds.push(experienceId);
      } catch (error) {
        failed.push({ id: experienceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.recorder.applied({
      resourceType: 'IMPROVEMENT',
      resourceId: 'experience-bulk-delete',
      action: 'DELETE',
      resource: { requestedIds, deletedIds, failed }
    });
  }

  async exportExperiences(format: 'json' | 'markdown' = 'json'): Promise<GovernanceExportBundle<ApprovedExperienceRecord>> {
    const records = await this.listApprovedExperienceCollection();
    const generatedAt = Date.now();
    const content = format === 'markdown'
      ? buildExperienceExportMarkdown(records)
      : JSON.stringify({ generatedAt, records }, null, this.foundation.config.storage.jsonSpacing);
    return { generatedAt, format, records, content };
  }

  async promoteExperienceToSkill(experienceId: string) {
    const experience = await this.getExperience(experienceId);
    if (!experience) {
      throw new Error(`backend_new experience error: unknown experience "${experienceId}".`);
    }
    const skillId = normalizeExperienceId(`skill-${experience.proposalId}`);
    return this.skills.create({
      id: skillId,
      name: `${experience.title} skill`,
      description: experience.referenceSummary,
      kind: 'instruction-skill',
      content: buildSkillMarkdown({
        title: `${experience.title} skill`,
        summary: experience.referenceSummary,
        applicableScenarios: experience.applicableScenarios,
        inputBoundaries: experience.limitations,
        prohibitions: [
          'Do not use when the current task falls outside the approved experience scope.',
          'Do not use when failed reuse evidence exists for the same pattern.'
        ],
        evidenceTaskIds: experience.successfulReuseTaskIds
      })
    });
  }

  private async materializeExperienceInput(
    input: ExperienceUpsertInput,
    context: {
      proposalId: string;
      createdAt: number;
      updatedAt: number;
      existing?: ApprovedExperienceRecord;
    }
  ): Promise<ApprovedExperienceRecord> {
    const title = truncateText(input.title, 120) || context.existing?.title || 'Managed experience';
    const referenceSummary = truncateText(input.referenceSummary, 240) || context.existing?.referenceSummary || 'Managed reusable experience.';
    const applicableScenarios = dedupeStrings(input.applicableScenarios ?? context.existing?.applicableScenarios ?? []);
    const limitations = dedupeStrings(input.limitations ?? context.existing?.limitations ?? []);
    const successfulReuseTaskIds = dedupeStrings(input.successfulReuseTaskIds ?? context.existing?.successfulReuseTaskIds ?? []);
    const failedReuseTaskIds = dedupeStrings(input.failedReuseTaskIds ?? context.existing?.failedReuseTaskIds ?? []);
    const rootDir = path.join(this.foundation.layout.generatedExperiencesDirPath, context.proposalId);
    const materializedPath = context.existing?.materializedPath ?? path.join(rootDir, 'experience.md');
    const markdown = input.draftExperienceMarkdown?.trim() || buildManualExperienceMarkdown({
      title,
      referenceSummary,
      applicableScenarios,
      limitations,
      evidenceTaskIds: successfulReuseTaskIds
    });
    if (isWithinDir(materializedPath, this.foundation.layout.generatedExperiencesDirPath)) {
      await this.foundation.storage.ensureDir(path.dirname(materializedPath));
      await this.foundation.storage.writeText(materializedPath, markdown, this.foundation.config.storage.encoding);
    }
    return normalizeApprovedExperienceRecord({
      proposalId: context.proposalId,
      patternKey: input.patternKey?.trim() || context.existing?.patternKey || normalizeExperienceId(title),
      title,
      materializedPath,
      referenceSummary,
      applicableScenarios,
      limitations,
      confidence: typeof input.confidence === 'number' ? input.confidence : context.existing?.confidence ?? 0.5,
      validationStatus: input.validationStatus ?? context.existing?.validationStatus ?? 'monitoring',
      successfulReuseTaskIds,
      failedReuseTaskIds,
      lastValidatedAt: input.lastValidatedAt ?? context.existing?.lastValidatedAt ?? null,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt
    });
  }

  private async syncLessonMemoryFromProposal(proposal: ImprovementProposal): Promise<void> {
    if (proposal.kind !== 'lesson' || !proposal.lessonProposal) {
      return;
    }
    if (proposal.conflictsWithProposalIds.length > 0) {
      throw new Error('backend_new improvements error: resolve conflicting lesson evidence before writing lesson memory.');
    }
    const existingLessonMemory = (await this.memories.list()).find((memory) => (
      memory.metadata?.layer === 'lesson'
      && memory.metadata?.dedupeKey === proposal.dedupeKey
    )) ?? null;
    await this.memories.upsert({
      memoryId: existingLessonMemory?.memoryId ?? `lesson_${proposal.proposalId}`,
      title: proposal.lessonProposal.title,
      content: proposal.lessonProposal.lessonSummary,
      scope: 'GLOBAL',
      tags: dedupeStrings(['lesson-memory', proposal.patternKey, ...proposal.evidenceTaskIds]),
      metadata: {
        ...(existingLessonMemory?.metadata ?? {}),
        layer: 'lesson',
        source: 'improvement_pipeline',
        proposalId: proposal.proposalId,
        triggerPattern: proposal.lessonProposal.triggerPattern,
        recommendedUseScope: proposal.lessonProposal.recommendedUseScope,
        confidence: Math.max(
          Number(existingLessonMemory?.metadata?.confidence ?? 0),
          proposal.lessonProposal.confidence
        ),
        evidenceTaskIds: mergeEvidenceTaskIds(
          Array.isArray(existingLessonMemory?.metadata?.evidenceTaskIds)
            ? existingLessonMemory?.metadata?.evidenceTaskIds as string[]
            : [],
          proposal.evidenceTaskIds
        ),
        dedupeKey: proposal.dedupeKey
      }
    });
  }

  async getTaskArchiveStatus(taskId: string): Promise<RealTaskArchiveStatus> {
    const state = (await this.listTaskStateCollection()).find((entry) => entry.taskId === taskId) ?? null;
    if (state) {
      return state.archiveStatus;
    }
    return {
      archived: false,
      eligible: false,
      reason: 'not_processed',
      archiveEntryId: null,
      complexitySignals: [],
      lastArchivedAt: null
    };
  }

  async buildComplexTaskAcceptanceReport(): Promise<ComplexTaskAcceptanceReport> {
    const [archive, proposals, taskStates, memories] = await Promise.all([
      this.listArchiveCollection(),
      this.listProposalCollection(),
      this.listTaskStateCollection(),
      this.memories.list()
    ]);

    const failureCounter = new Map<string, number>();
    const skipReasonCounter = new Map<string, number>();
    let lesson = 0;
    let experience = 0;
    let instructionSkill = 0;
    let optimization = 0;
    let complete = 0;
    let partial = 0;

    for (const entry of archive) {
      for (const category of entry.experienceReport.failureTaxonomy) {
        failureCounter.set(category, (failureCounter.get(category) ?? 0) + 1);
      }
      if (entry.experienceReport.truthCompleteness === 'complete') {
        complete += 1;
      } else {
        partial += 1;
      }
    }

    for (const proposal of proposals) {
      if (proposal.kind === 'lesson') {
        lesson += 1;
      } else if (proposal.kind === 'experience') {
        experience += 1;
      } else if (proposal.kind === 'instruction_skill') {
        instructionSkill += 1;
      } else {
        optimization += 1;
      }
    }

    for (const state of taskStates.filter((entry) => !entry.archiveStatus.eligible)) {
      skipReasonCounter.set(
        state.archiveStatus.reason,
        (skipReasonCounter.get(state.archiveStatus.reason) ?? 0) + 1
      );
    }

    const lessonMemoryCount = memories.filter((memory) => memory.metadata?.layer === 'lesson').length;
    const generatedExperienceCount = proposals.filter((proposal) => (
      proposal.kind === 'experience'
      && Boolean(proposal.experienceProposal?.materializedPath)
    )).length;
    const generatedInstructionSkillCount = proposals.filter((proposal) => (
      proposal.kind === 'instruction_skill'
      && Boolean(proposal.instructionSkillProposal?.materializedRootDir)
      && Boolean(proposal.instructionSkillProposal?.importedSkillId)
    )).length;

    return {
      generatedAt: Date.now(),
      curatedSuite: {
        total: 0,
        passed: 0,
        failed: 0
      },
      archive: {
        total: archive.length,
        completed: archive.filter((entry) => entry.lifecycleStatus === 'COMPLETED').length,
        failed: archive.filter((entry) => entry.lifecycleStatus === 'FAILED').length,
        cancelled: archive.filter((entry) => entry.lifecycleStatus === 'CANCELLED').length,
        delivered: archive.filter((entry) => entry.experienceReport.artifactEvidence === 'delivered').length,
        artifactOnly: archive.filter((entry) => entry.experienceReport.artifactEvidence === 'artifact_only').length,
        proposalGenerated: archive.reduce((count, entry) => count + entry.proposalIds.length, 0)
      },
      archiveEligibleCount: taskStates.filter((entry) => entry.archiveStatus.eligible).length,
      archiveSkippedCount: taskStates.filter((entry) => !entry.archiveStatus.eligible).length,
      skipReasons: [...skipReasonCounter.entries()].map(([reason, count]) => ({ reason, count })),
      duplicateProposalCount: proposals.filter((proposal) => Boolean(proposal.duplicateOfProposalId)).length,
      conflictedProposalCount: proposals.filter((proposal) => proposal.conflictsWithProposalIds.length > 0).length,
      supersededProposalCount: proposals.filter((proposal) => Boolean(proposal.supersededByProposalId)).length,
      lessonMemoryCount,
      generatedExperienceCount,
      generatedInstructionSkillCount,
      failureTaxonomy: [...failureCounter.entries()].map(([category, count]) => ({ category, count })),
      truthCompleteness: {
        complete,
        partial
      },
      proposalGenerationEvidence: {
        lesson,
        experience,
        instructionSkill,
        optimization
      }
    };
  }

  async processTerminalTask(task: TaskQueryResponse): Promise<void> {
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.runtime.lifecycleStatus)) {
      return;
    }

    const now = Date.now();
    const experienceReport = buildExperienceReport(task);
    const patternKey = getTaskPatternKeyFromDefinition(task.definition);
    const archiveDecision = computeArchiveEligibility(task, experienceReport);
    const archiveReviewScore = computeReviewScore({ task, experienceReport });

    const [archive, proposals, taskStates, approvedExperiences] = await Promise.all([
      this.listArchiveCollection(),
      this.listProposalCollection(),
      this.listTaskStateCollection(),
      this.listApprovedExperienceCollection()
    ]);

    const priorArchive = archive.filter((entry) => entry.taskId !== task.definition.taskId);
    let nextProposals = proposals.filter((proposal) => proposal.taskId !== task.definition.taskId);
    const nextArchive = priorArchive.slice();
    let nextApprovedExperiences = approvedExperiences.slice();

    const samePatternCompleted = priorArchive.filter((entry) => (
      entry.patternKey === patternKey && entry.lifecycleStatus === 'COMPLETED'
    ));
    const samePatternFailures = priorArchive.filter((entry) => (
      entry.patternKey === patternKey && entry.lifecycleStatus !== 'COMPLETED'
    ));

    const proposalIds: string[] = [];
    const candidateProposals: ImprovementProposal[] = [];

    const selectedApprovedExperienceProposalIds = getValidationEligibleApprovedExperienceProposalIds(task);
    if (selectedApprovedExperienceProposalIds.length > 0) {
      const validationOutcome = getApprovedExperienceValidationOutcome(task, this.foundation);
      nextApprovedExperiences = nextApprovedExperiences.map((record) => {
        if (!selectedApprovedExperienceProposalIds.includes(record.proposalId)) {
          return record;
        }
        const successfulReuseTaskIds = validationOutcome === 'passed'
          ? dedupeStrings([...record.successfulReuseTaskIds, task.definition.taskId])
          : record.successfulReuseTaskIds;
        const failedReuseTaskIds = validationOutcome === 'failed'
          ? dedupeStrings([...record.failedReuseTaskIds, task.definition.taskId])
          : record.failedReuseTaskIds;
        const validationStatus = failedReuseTaskIds.length > 0
          ? 'conflicted'
          : successfulReuseTaskIds.length >= 2
            ? 'promotable'
            : 'monitoring';
        return {
          ...record,
          successfulReuseTaskIds,
          failedReuseTaskIds,
          validationStatus,
          lastValidatedAt: validationOutcome === 'environment_blocker'
            ? record.lastValidatedAt
            : now,
          updatedAt: now
        };
      });
      nextProposals = nextProposals.map((proposal) => {
        if (proposal.kind !== 'experience' || !proposal.experienceProposal) {
          return proposal;
        }
        const matchingRecord = nextApprovedExperiences.find((record) => record.proposalId === proposal.proposalId) ?? null;
        if (!matchingRecord) {
          return proposal;
        }
        return {
          ...proposal,
          updatedAt: now,
          experienceProposal: {
            ...proposal.experienceProposal,
            validationStatus: matchingRecord.validationStatus,
            successfulReuseTaskIds: matchingRecord.successfulReuseTaskIds,
            failedReuseTaskIds: matchingRecord.failedReuseTaskIds,
            lastValidatedAt: matchingRecord.lastValidatedAt,
            materializedPath: matchingRecord.materializedPath
          }
        };
      });
    }

    if (archiveDecision.eligible) {
      const lessonProposal = buildLessonProposal(task, experienceReport, patternKey);
      if (lessonProposal) {
        candidateProposals.push(lessonProposal);
      }

      const canGenerateExperience = task.runtime.lifecycleStatus === 'COMPLETED'
        && samePatternCompleted.length >= 1
        && samePatternFailures.length === 0;
      if (canGenerateExperience) {
        const experienceProposal = buildExperienceProposal({
          task,
          experienceReport,
          patternKey,
          matchingArchiveEntries: samePatternCompleted
        });
        if (experienceProposal) {
          candidateProposals.push(experienceProposal);
        }
      } else if (task.runtime.lifecycleStatus === 'COMPLETED' && samePatternFailures.length > 0) {
        const optimizationProposal = buildOptimizationProposal({
          task,
          experienceReport,
          patternKey,
          category: 'benchmark_candidate',
          summary: 'Archived success and failure evidence now conflict for this pattern. Resolve the pattern before promoting it into a reusable instruction skill.'
        });
        if (optimizationProposal) {
          candidateProposals.push(optimizationProposal);
        }
      }

      const promotableApprovedExperience = nextApprovedExperiences.find((record) => (
        record.patternKey === patternKey
        && selectedApprovedExperienceProposalIds.includes(record.proposalId)
        && record.validationStatus === 'promotable'
        && record.failedReuseTaskIds.length === 0
        && record.successfulReuseTaskIds.length >= 2
      )) ?? null;

      if (promotableApprovedExperience) {
        const instructionSkillProposal = buildInstructionSkillProposal({
          task,
          experienceReport,
          patternKey,
          approvedExperience: promotableApprovedExperience,
          validationTaskIds: promotableApprovedExperience.successfulReuseTaskIds
        });
        if (instructionSkillProposal) {
          candidateProposals.push(instructionSkillProposal);
        }
      } else if (task.runtime.lifecycleStatus === 'COMPLETED' && selectedApprovedExperienceProposalIds.length > 0) {
        const conflictedApprovedExperience = nextApprovedExperiences.find((record) => (
          record.patternKey === patternKey
          && selectedApprovedExperienceProposalIds.includes(record.proposalId)
          && record.validationStatus === 'conflicted'
        )) ?? null;
        if (conflictedApprovedExperience) {
          const optimizationProposal = buildOptimizationProposal({
            task,
            experienceReport,
            patternKey,
            category: 'benchmark_candidate',
            summary: 'Approved experience reuse now has conflicting runtime evidence. Resolve the conflict before promoting it into an instruction skill.'
          });
          if (optimizationProposal) {
            candidateProposals.push(optimizationProposal);
          }
        }
      }

      const baselineOptimization = buildOptimizationProposal({
        task,
        experienceReport,
        patternKey
      });
      if (baselineOptimization) {
        candidateProposals.push(baselineOptimization);
      }
    }

    const approvedLessonProposalsToSync: ImprovementProposal[] = [];

    for (const candidate of candidateProposals) {
      const duplicateIndex = nextProposals.findIndex((proposal) => (
        canMergeProposalCandidate(proposal, candidate)
      ));
      if (duplicateIndex >= 0) {
        const merged = mergeProposalEvidence(nextProposals[duplicateIndex], candidate);
        nextProposals[duplicateIndex] = merged;
        if (merged.kind === 'lesson' && merged.status === 'APPROVED') {
          approvedLessonProposalsToSync.push(merged);
        }
        proposalIds.push(merged.proposalId);
        continue;
      }

      if (candidate.kind === 'lesson') {
        const conflictingProposalIds = nextProposals
          .filter((proposal) => (
            proposal.kind === 'lesson'
            && proposal.patternKey === candidate.patternKey
            && proposal.dedupeKey !== candidate.dedupeKey
            && isActiveProposalStatus(proposal.status)
            && hasOpposingLessonMeaning(proposal, candidate)
          ))
          .map((proposal) => proposal.proposalId);
        if (conflictingProposalIds.length > 0) {
          candidate.conflictsWithProposalIds = conflictingProposalIds;
          nextProposals = nextProposals.map((proposal) => (
            conflictingProposalIds.includes(proposal.proposalId)
              ? {
                ...proposal,
                conflictsWithProposalIds: dedupeStrings([
                  ...proposal.conflictsWithProposalIds,
                  candidate.proposalId
                ])
              }
              : proposal
          ));
        }
      }

      nextProposals.push(candidate);
      proposalIds.push(candidate.proposalId);
    }

    if (archiveDecision.eligible) {
      nextArchive.push({
        archiveEntryId: `archive_${task.definition.taskId}`,
        taskId: task.definition.taskId,
        taskTitle: task.definition.title,
        taskIntent: task.definition.intent,
        lifecycleStatus: task.runtime.lifecycleStatus as RealTaskArchiveEntry['lifecycleStatus'],
        archivedAt: now,
        complexitySignals: archiveDecision.complexitySignals,
        archiveEligibility: {
          eligible: true,
          reason: archiveDecision.reason,
          complexitySignals: archiveDecision.complexitySignals
        },
        reviewScore: archiveReviewScore,
        patternKey,
        truthSummary: {
          statusSummary: task.statusSummary.label,
          primaryAction: task.primaryAction.label,
          nextAction: task.nextActionSummary.label,
          completionSummary: task.completionSummary?.summary ?? null,
          truthCompleteness: experienceReport.truthCompleteness
        },
        finalDelivery: {
          summary: task.completionSummary?.summary ?? task.latestVisibleOutput?.summary ?? null,
          deliveredTo: task.completionSummary?.artifactDestinationPaths ?? [],
          destinationDir: task.completionSummary?.artifactDestinationDir ?? null
        },
        artifactPaths: task.completionSummary?.artifactPaths ?? task.latestVisibleOutput?.artifactPaths ?? [],
        blockerSummary: task.runtime.lifecycleStatus === 'COMPLETED'
          ? null
          : truncateText(task.diagnostics.lastError ?? task.statusSummary.detail) || null,
        proposalIds,
        experienceReport,
        metadata: {
          primaryActionKind: task.primaryAction.kind,
          delegationRequired: task.delegationSummary.required,
          actionBearingSignals: archiveDecision.actionBearingSignals
        }
      });
    }

    const archiveStatus: RealTaskArchiveStatus = {
      archived: archiveDecision.eligible,
      eligible: archiveDecision.eligible,
      reason: archiveDecision.reason,
      archiveEntryId: archiveDecision.eligible ? `archive_${task.definition.taskId}` : null,
      complexitySignals: archiveDecision.complexitySignals,
      lastArchivedAt: archiveDecision.eligible ? now : null
    };

    const nextTaskStates = taskStates.filter((entry) => entry.taskId !== task.definition.taskId);
    nextTaskStates.push({
      taskId: task.definition.taskId,
      taskTitle: task.definition.title,
      lifecycleStatus: task.runtime.lifecycleStatus as ExperienceReport['lifecycleStatus'],
      updatedAt: now,
      patternKey,
      reviewScore: archiveReviewScore,
      experienceReport,
      archiveStatus,
      proposalIds
    });

    await this.saveProposalCollection(nextProposals);
    await this.saveArchiveCollection(nextArchive);
    await this.saveApprovedExperienceCollection(nextApprovedExperiences);
    await this.saveTaskStateCollection(nextTaskStates);
    for (const proposal of approvedLessonProposalsToSync) {
      await this.syncLessonMemoryFromProposal(proposal);
    }
  }

  async approveProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>> {
    const [proposals, approvedExperiences] = await Promise.all([
      this.listProposalCollection(),
      this.listApprovedExperienceCollection()
    ]);
    const proposal = proposals.find((entry) => entry.proposalId === proposalId);
    if (!proposal) {
      throw new Error(`backend_new improvements error: unknown proposal "${proposalId}".`);
    }
    if (proposal.status === 'APPROVED') {
      return {
        resourceType: 'IMPROVEMENT',
        resourceId: proposal.proposalId,
        action: 'APPROVE',
        commandId: `pcmd_existing_${proposal.proposalId}`,
        auditId: `paud_existing_${proposal.proposalId}`,
        appliedAt: proposal.updatedAt,
        resource: proposal
      };
    }
    if (proposal.conflictsWithProposalIds.length > 0) {
      throw new Error('backend_new improvements error: resolve conflicting lesson evidence before approving this proposal.');
    }

    const command = await this.recorder.recordCommand({
      resourceType: 'IMPROVEMENT',
      resourceId: proposal.proposalId,
      action: 'APPROVE',
      input: {
        kind: proposal.kind,
        taskId: proposal.taskId
      }
    });

    const now = Date.now();
    const updatedProposal: ImprovementProposal = {
      ...proposal,
      status: 'APPROVED',
      updatedAt: now
    };
    let nextApprovedExperiences = approvedExperiences.slice();

    if (updatedProposal.kind === 'lesson' && updatedProposal.lessonProposal) {
      await this.syncLessonMemoryFromProposal(updatedProposal);
    }

    if (proposal.kind === 'experience' && proposal.experienceProposal) {
      if (proposal.evidenceTaskIds.length < 2) {
        throw new Error('backend_new improvements error: experience proposals need at least two evidence tasks before materialization.');
      }
      const rootDir = path.join(this.foundation.layout.generatedExperiencesDirPath, proposal.proposalId);
      await this.foundation.storage.ensureDir(rootDir);
      const experiencePath = path.join(rootDir, 'experience.md');
      await this.foundation.storage.writeText(
        experiencePath,
        proposal.experienceProposal.draftExperienceMarkdown,
        this.foundation.config.storage.encoding
      );
      updatedProposal.experienceProposal = {
        ...proposal.experienceProposal,
        materializedPath: experiencePath
      };
      const nextRecord = normalizeApprovedExperienceRecord({
        proposalId: proposal.proposalId,
        patternKey: proposal.patternKey,
        title: proposal.experienceProposal.title,
        materializedPath: experiencePath,
        referenceSummary: proposal.experienceProposal.referenceSummary,
        applicableScenarios: proposal.experienceProposal.applicableScenarios,
        limitations: proposal.experienceProposal.limitations,
        confidence: proposal.experienceProposal.confidence,
        validationStatus: proposal.experienceProposal.validationStatus,
        successfulReuseTaskIds: proposal.experienceProposal.successfulReuseTaskIds,
        failedReuseTaskIds: proposal.experienceProposal.failedReuseTaskIds,
        lastValidatedAt: proposal.experienceProposal.lastValidatedAt,
        createdAt: proposal.createdAt,
        updatedAt: now
      });
      nextApprovedExperiences = [
        ...nextApprovedExperiences.filter((record) => record.proposalId !== proposal.proposalId),
        nextRecord
      ];
    }

    if (proposal.kind === 'instruction_skill' && proposal.instructionSkillProposal) {
      if (proposal.evidenceTaskIds.length < 2) {
        throw new Error('backend_new improvements error: instruction skill proposals need at least two evidence tasks before materialization.');
      }
      const approvedExperienceProposalId = typeof proposal.metadata?.approvedExperienceProposalId === 'string'
        ? proposal.metadata.approvedExperienceProposalId
        : null;
      if (approvedExperienceProposalId) {
        const approvedExperience = nextApprovedExperiences.find((record) => record.proposalId === approvedExperienceProposalId) ?? null;
        const approvedExperienceProposal = proposals.find((entry) => entry.proposalId === approvedExperienceProposalId) ?? null;
        if (!approvedExperience || !approvedExperienceProposal || approvedExperienceProposal.status !== 'APPROVED') {
          throw new Error('backend_new improvements error: instruction skill promotion requires a previously approved experience reference.');
        }
      }
      const rootDir = path.join(this.foundation.layout.generatedSkillsDirPath, proposal.proposalId);
      await this.foundation.storage.ensureDir(rootDir);
      await this.foundation.storage.writeText(
        path.join(rootDir, 'SKILL.md'),
        proposal.instructionSkillProposal.draftSkillMarkdown,
        this.foundation.config.storage.encoding
      );
      const imported = await this.skills.importSkill({
        id: proposal.proposalId,
        name: proposal.instructionSkillProposal.title,
        rootDir,
        description: proposal.summary,
        kind: 'instruction-skill'
      });
      updatedProposal.instructionSkillProposal = {
        ...proposal.instructionSkillProposal,
        materializedRootDir: rootDir,
        importedSkillId: imported.resource.id
      };
    }

    const next = proposals.map((entry) => entry.proposalId === proposalId ? updatedProposal : entry);
    await this.saveProposalCollection(next);
    await this.saveApprovedExperienceCollection(nextApprovedExperiences);
    return this.recorder.recordApplied(command, updatedProposal);
  }

  async rejectProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>> {
    const proposals = await this.listProposalCollection();
    const proposal = proposals.find((entry) => entry.proposalId === proposalId);
    if (!proposal) {
      throw new Error(`backend_new improvements error: unknown proposal "${proposalId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'IMPROVEMENT',
      resourceId: proposal.proposalId,
      action: 'REJECT',
      input: {
        kind: proposal.kind,
        taskId: proposal.taskId
      }
    });
    const updatedProposal: ImprovementProposal = {
      ...proposal,
      status: 'REJECTED',
      updatedAt: Date.now()
    };
    const next = proposals.map((entry) => entry.proposalId === proposalId ? updatedProposal : entry);
    await this.saveProposalCollection(next);
    return this.recorder.recordApplied(command, updatedProposal);
  }
}
