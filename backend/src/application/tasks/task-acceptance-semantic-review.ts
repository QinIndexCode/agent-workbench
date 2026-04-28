import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { TaskMetadataRecord } from '../../foundation/repository/types';
import { resolveProviderProfile } from '../../foundation/providers/resolver';
import { TaskExecutionSummary, TaskQueryResponse } from './types';

const ACCEPTANCE_SEMANTIC_REVIEW_KEY = 'acceptanceSemanticReview';

interface AcceptanceSemanticReviewCacheRecord {
  checkpointId: string | null;
  status: TaskExecutionSummary['acceptance']['semanticReview']['status'];
  verdict: TaskExecutionSummary['acceptance']['semanticReview']['verdict'];
  providerId: string | null;
  modelId: string | null;
  reviewedAt: number | null;
  confidence: number | null;
  summary: string | null;
  mismatches: string[];
  missingEvidence: string[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticReviewStatus(value: unknown): value is TaskExecutionSummary['acceptance']['semanticReview']['status'] {
  return value === 'not_requested'
    || value === 'pending'
    || value === 'passed'
    || value === 'failed'
    || value === 'unavailable';
}

function isSemanticVerdict(value: unknown): value is NonNullable<TaskExecutionSummary['acceptance']['semanticReview']['verdict']> {
  return value === 'passed' || value === 'failed';
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function extractJsonObject(source: string): Record<string, unknown> | null {
  const trimmed = source.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) {
    return direct;
  }
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParseJsonObject(fenceMatch[1]);
    if (fenced) {
      return fenced;
    }
  }
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return tryParseJsonObject(trimmed.slice(start, index + 1));
      }
    }
  }
  return null;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildPrompt(params: {
  task: TaskQueryResponse;
  executionSummary: TaskExecutionSummary;
}): string {
  const { task, executionSummary } = params;
  const acceptance = executionSummary.acceptance;
  return [
    'You are an independent semantic acceptance reviewer for SCC-Batch.',
    'Judge whether the delivered result matches the user intent, using only the provided task intent, structured output summary, and acceptance evidence.',
    'Do not restate the evidence. Do not invent facts. If evidence is insufficient, say so in missingEvidence.',
    'Return JSON only with this schema:',
    '{"verdict":"passed|failed","confidence":0.0,"summary":"string","mismatches":["string"],"missingEvidence":["string"]}',
    `Task title: ${task.definition.title}`,
    `Task intent: ${task.definition.intent}`,
    `Lifecycle status: ${task.runtime.lifecycleStatus}`,
    `Execution profile: ${acceptance.deterministic.profileId}`,
    `Visible output summary: ${task.latestVisibleOutput?.summary ?? task.completionSummary?.summary ?? 'none'}`,
    `Visible output details: ${task.latestVisibleOutput?.details ?? task.completionSummary?.details ?? 'none'}`,
    `Deterministic acceptance: ${JSON.stringify(acceptance.deterministic)}`,
    `Acceptance evidence: ${JSON.stringify(acceptance.evidence)}`
  ].join('\n');
}

function toSemanticReview(
  payload: Record<string, unknown>,
  providerId: string,
  modelId: string
): TaskExecutionSummary['acceptance']['semanticReview'] | null {
  if (!isSemanticVerdict(payload.verdict)) {
    return null;
  }
  return {
    status: payload.verdict,
    verdict: payload.verdict,
    providerId,
    modelId,
    reviewedAt: Date.now(),
    confidence: clampConfidence(payload.confidence),
    summary: typeof payload.summary === 'string' ? payload.summary : null,
    mismatches: getStringArray(payload.mismatches),
    missingEvidence: getStringArray(payload.missingEvidence),
    error: null
  };
}

function getCachedRecord(metadataRecord: TaskMetadataRecord | null): AcceptanceSemanticReviewCacheRecord | null {
  const raw = metadataRecord?.metadata?.[ACCEPTANCE_SEMANTIC_REVIEW_KEY];
  if (!isRecord(raw) || !isSemanticReviewStatus(raw.status)) {
    return null;
  }
  return {
    checkpointId: typeof raw.checkpointId === 'string' ? raw.checkpointId : null,
    status: raw.status,
    verdict: isSemanticVerdict(raw.verdict) ? raw.verdict : null,
    providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
    modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
    reviewedAt: typeof raw.reviewedAt === 'number' ? raw.reviewedAt : null,
    confidence: clampConfidence(raw.confidence),
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    mismatches: getStringArray(raw.mismatches),
    missingEvidence: getStringArray(raw.missingEvidence),
    error: typeof raw.error === 'string' ? raw.error : null
  };
}

export function readAcceptanceSemanticReview(
  metadataRecord: TaskMetadataRecord | null
): TaskExecutionSummary['acceptance']['semanticReview'] | null {
  const cached = getCachedRecord(metadataRecord);
  if (!cached) {
    return null;
  }
  return {
    status: cached.status,
    verdict: cached.verdict,
    providerId: cached.providerId,
    modelId: cached.modelId,
    reviewedAt: cached.reviewedAt,
    confidence: cached.confidence,
    summary: cached.summary,
    mismatches: [...cached.mismatches],
    missingEvidence: [...cached.missingEvidence],
    error: cached.error
  };
}

export class TaskAcceptanceSemanticReviewService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async maybeReview(params: {
    task: TaskQueryResponse;
    metadataRecord: TaskMetadataRecord | null;
    executionSummary: TaskExecutionSummary;
  }): Promise<{
    metadataRecord: TaskMetadataRecord;
    semanticReview: TaskExecutionSummary['acceptance']['semanticReview'];
  } | null> {
    const { task, executionSummary } = params;
    if (task.runtime.lifecycleStatus !== 'COMPLETED') {
      return null;
    }
    if (executionSummary.acceptance.deterministic.verdict !== 'passed') {
      return null;
    }

    const cached = getCachedRecord(params.metadataRecord);
    const checkpointId = task.runtime.latestCheckpointId ?? null;
    if (cached && cached.checkpointId === checkpointId && cached.status !== 'pending') {
      return null;
    }

    const providerId = task.runtime.selectedProviderId ?? task.definition.preferredProviderId ?? null;
    if (!providerId) {
      return null;
    }

    const profile = this.foundation.providers.get(providerId);
    if (!profile || !profile.apiKeySecretId) {
      return null;
    }

    try {
      const resolvedProfile = await resolveProviderProfile(this.foundation.providers, this.foundation.apiKeys, providerId);
      const client = this.foundation.providerClients.resolve(resolvedProfile);
      if (!client) {
        return await this.persistReview(params.metadataRecord, task, {
          status: 'unavailable',
          verdict: null,
          providerId,
          modelId: resolvedProfile.model,
          reviewedAt: Date.now(),
          confidence: null,
          summary: null,
          mismatches: [],
          missingEvidence: ['provider_client_unavailable'],
          error: 'No provider client is registered for semantic review.'
        });
      }

      const response = await client.complete({
        profile: resolvedProfile,
        context: {
          taskId: task.definition.taskId,
          unitId: executionSummary.acceptance.deterministic.unitId,
          sessionId: task.runtime.latestSessionId ?? `semantic_review_${task.definition.taskId}`,
          correlationId: task.runtime.latestCorrelationId ?? `semantic_review_${task.definition.taskId}`,
          turnId: `semantic_review_${task.definition.taskId}`,
          checkpointId
        },
        messages: [{
          role: 'system',
          content: buildPrompt({
            task,
            executionSummary
          })
        }],
        temperature: 0,
        maxTokens: 400,
        metadata: {
          purpose: 'acceptance_semantic_review',
          taskId: task.definition.taskId,
          checkpointId
        }
      });
      const parsed = extractJsonObject(response.outputText);
      const review = parsed
        ? toSemanticReview(parsed, resolvedProfile.id, resolvedProfile.model)
        : null;
      if (!review) {
        return await this.persistReview(params.metadataRecord, task, {
          status: 'unavailable',
          verdict: null,
          providerId: resolvedProfile.id,
          modelId: resolvedProfile.model,
          reviewedAt: Date.now(),
          confidence: null,
          summary: null,
          mismatches: [],
          missingEvidence: ['semantic_review_json_invalid'],
          error: 'Semantic reviewer did not return a valid JSON verdict.'
        });
      }
      return await this.persistReview(params.metadataRecord, task, review);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Semantic review failed.';
      return await this.persistReview(params.metadataRecord, task, {
        status: 'unavailable',
        verdict: null,
        providerId,
        modelId: profile.model,
        reviewedAt: Date.now(),
        confidence: null,
        summary: null,
        mismatches: [],
        missingEvidence: ['semantic_review_call_failed'],
        error: message
      });
    }
  }

  private async persistReview(
    existing: TaskMetadataRecord | null,
    task: TaskQueryResponse,
    review: TaskExecutionSummary['acceptance']['semanticReview']
  ): Promise<{
    metadataRecord: TaskMetadataRecord;
    semanticReview: TaskExecutionSummary['acceptance']['semanticReview'];
  }> {
    const now = Date.now();
    const nextRecord: TaskMetadataRecord = {
      taskId: task.definition.taskId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      latestSessionId: existing?.latestSessionId ?? task.runtime.latestSessionId ?? null,
      selectedProviderId: existing?.selectedProviderId ?? task.runtime.selectedProviderId ?? task.definition.preferredProviderId ?? null,
      labels: existing?.labels ?? [],
      metadata: {
        ...(existing?.metadata ?? {}),
        [ACCEPTANCE_SEMANTIC_REVIEW_KEY]: {
          checkpointId: task.runtime.latestCheckpointId ?? null,
          status: review.status,
          verdict: review.verdict,
          providerId: review.providerId,
          modelId: review.modelId,
          reviewedAt: review.reviewedAt,
          confidence: review.confidence,
          summary: review.summary,
          mismatches: review.mismatches,
          missingEvidence: review.missingEvidence,
          error: review.error
        } satisfies AcceptanceSemanticReviewCacheRecord
      }
    };
    await this.foundation.taskMetadata.save(nextRecord);
    return {
      metadataRecord: nextRecord,
      semanticReview: review
    };
  }
}
