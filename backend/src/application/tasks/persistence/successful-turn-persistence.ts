import { createConversationMessage } from '../../../foundation/conversation/create-message';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { TaskRecordService } from '../task-record-service';
import { ToolDispatchOrchestrator } from '../tools/tool-dispatch-orchestrator';
import { OperatorCommandService } from '../control/operator-command-service';
import { saveUserPreferenceProfile } from '../../runtime/memory-store';
import { TaskProjectionPersistence } from './task-projection-persistence';
import { RuntimeCheckpointPersistence } from './runtime-checkpoint-persistence';
import { SuccessfulTurnPersistenceInput, TurnPersistenceResult } from './turn-persistence-types';
import { ValidatedOutputPersistence } from './validated-output-persistence';
import { runWorkspaceHooks } from '../../runtime/workspace-hook-runner';
import { deriveTaskArtifactRoutingSummary } from '../artifact-routing';

type AssistantSummaryDisplayKind =
  | 'clarification'
  | 'progress'
  | 'approval_waiting'
  | 'artifact_ready'
  | 'artifact_applied'
  | 'recovery'
  | 'failure';

type VisibleOutputCandidate = {
  summary: string | null;
  details: string | null;
  issues: string[];
  artifactPaths: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findFirstStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeIssueList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function normalizeArtifactPaths(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function truncateText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function looksLikeMachineReadableProtocol(content: string): boolean {
  return /\[[A-Z0-9_-]+_OUTPUT\]/.test(content)
    || /"current_unit"\s*:/.test(content)
    || /"tool_name"\s*:/.test(content)
    || /"files_created"\s*:/.test(content)
    || /Do not wrap the explicit output block/i.test(content)
    || /Use this exact explicit output wrapper pattern/i.test(content);
}

function summarizePathList(paths: string[]): string {
  if (paths.length === 0) {
    return 'the generated artifact';
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return `${paths[0]} +${paths.length - 1} more`;
}

function buildVisibleOutputCandidate(params: SuccessfulTurnPersistenceInput): VisibleOutputCandidate | null {
  const acceptedOutput = params.acceptedOutputs?.at(-1) ?? (
    params.orchestrated.acceptance.acceptedOutput
      ? {
        unitId: params.orchestrated.acceptance.acceptedOutput.unitId,
        wrapper: params.orchestrated.acceptance.acceptedOutput.wrapper,
        raw: params.orchestrated.acceptance.acceptedOutput.raw,
        parsedJson: params.orchestrated.acceptance.acceptedOutput.parsedJson,
        contractKeys: params.orchestrated.acceptance.contractKeys
      }
      : null
  );

  if (acceptedOutput && isRecord(acceptedOutput.parsedJson)) {
    const parsedRecord = acceptedOutput.parsedJson;
    return {
      summary: findFirstStringField(parsedRecord, ['summary', 'title', 'headline']) ?? truncateText(acceptedOutput.raw),
      details: findFirstStringField(parsedRecord, ['details', 'report', 'body', 'content', 'notes']),
      issues: normalizeIssueList(parsedRecord.issues),
      artifactPaths: [
        ...normalizeArtifactPaths(parsedRecord.artifact),
        ...normalizeArtifactPaths(parsedRecord.artifacts),
        ...normalizeArtifactPaths(parsedRecord.files),
        ...normalizeArtifactPaths(parsedRecord.files_created)
      ]
    };
  }

  const providerText = params.providerOutputText.trim();
  if (!providerText || looksLikeMachineReadableProtocol(providerText)) {
    return null;
  }

  return {
    summary: truncateText(providerText, 140),
    details: providerText,
    issues: [],
    artifactPaths: []
  };
}

function looksLikeClarificationCandidate(candidate: VisibleOutputCandidate | null): boolean {
  if (!candidate) {
    return false;
  }
  const combinedText = [
    candidate.summary,
    candidate.details,
    ...candidate.issues
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  return /\b(request is missing|missing (?:the )?(?:audience|target|constraint|success criteria|destination|path|input|context)|required context|need more context|cannot safely continue|safest next step|ask the operator|ask for|please clarify|needs clarification|waiting for operator)\b/i.test(combinedText);
}

function buildClarificationMessage(candidate: VisibleOutputCandidate): string {
  const primaryIssues = candidate.issues.slice(0, 3);
  if (primaryIssues.length > 0) {
    return `Need more context before this thread can continue safely. Ask for: ${primaryIssues.join('; ')}.`;
  }
  return candidate.summary
    ? `Need more context before this thread can continue safely. ${candidate.summary}`
    : 'Need more context before this thread can continue safely. Ask the operator for the missing target, constraints, or success criteria.';
}

function buildPublicAssistantSummary(params: {
  input: SuccessfulTurnPersistenceInput;
  visibleCandidate: VisibleOutputCandidate | null;
  artifactRouting: ReturnType<typeof deriveTaskArtifactRoutingSummary>;
  approvalBlockedCount: number;
}): { content: string; displayKind: AssistantSummaryDisplayKind } | null {
  const { input, visibleCandidate, artifactRouting, approvalBlockedCount } = params;
  const lifecycleStatus = input.nextRuntime.lifecycleStatus;
  const isTerminal = lifecycleStatus === 'COMPLETED' || lifecycleStatus === 'FAILED' || lifecycleStatus === 'CANCELLED';

  if (approvalBlockedCount > 0) {
    return {
      displayKind: 'approval_waiting',
      content: 'A tool request is waiting for approval before this thread can continue. Review the pending approval to decide the next step.'
    };
  }

  if (artifactRouting.artifactPathState === 'unresolved' && artifactRouting.artifactPaths.length > 0) {
    return {
      displayKind: 'artifact_ready',
      content: `Created ${summarizePathList(artifactRouting.artifactPaths)}. Choose a project-relative destination and apply the artifact before the thread can finish.`
    };
  }

  if (artifactRouting.artifactPathState === 'applied' && !isTerminal) {
    const destinationLabel = summarizePathList(artifactRouting.artifactDestinationPaths);
    return {
      displayKind: 'artifact_applied',
      content: `Artifacts were delivered to ${destinationLabel}. Continue the thread to confirm delivery or finish the remaining work.`
    };
  }

  if (lifecycleStatus === 'FAILED' && input.nextRuntime.lastError) {
    return {
      displayKind: 'failure',
      content: `The thread stopped after a runtime failure: ${truncateText(input.nextRuntime.lastError, 120)}`
    };
  }

  if (
    input.nextRuntime.pendingCorrection !== 'NONE'
    || input.nextRuntime.contractDiagnostics?.correctionLoopNonConvergent
  ) {
    return {
      displayKind: 'recovery',
      content: 'The thread needs corrective follow-up before it can continue. Review the latest issue and decide how to proceed.'
    };
  }

  if (looksLikeClarificationCandidate(visibleCandidate)) {
    return {
      displayKind: 'clarification',
      content: buildClarificationMessage(visibleCandidate!)
    };
  }

  if (!isTerminal && visibleCandidate?.summary) {
    return {
      displayKind: 'progress',
      content: visibleCandidate.summary
    };
  }

  return null;
}

export class SuccessfulTurnPersistence {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly records: TaskRecordService,
    private readonly toolDispatch: ToolDispatchOrchestrator,
    private readonly commandService: OperatorCommandService,
    private readonly outputPersistence: ValidatedOutputPersistence,
    private readonly projectionPersistence: TaskProjectionPersistence,
    private readonly checkpointPersistence: RuntimeCheckpointPersistence
  ) {}

  async persist(params: SuccessfulTurnPersistenceInput): Promise<TurnPersistenceResult> {
    await this.foundation.logs.recordTrace({
      timestamp: Date.now(),
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      action: 'turn_completed',
      details: {
        providerId: params.selectedProvider.id,
        prompt: params.prompt,
        response: params.providerOutputText,
        providerResponseId: params.providerResponseId,
        providerUsage: params.providerUsage,
        pendingCorrection: params.nextRuntime.pendingCorrection,
        acceptedToolCallCount: params.plannedTools.accepted,
        approvalRequiredToolCallCount: params.plannedTools.approvalRequired,
        rejectedToolCalls: params.plannedTools.rejected,
        contextCompressionCount: params.nextRuntime.contextCompressionCount,
        promptBudget: params.nextRuntime.promptBudget,
        promptPolicy: params.promptPolicy
      }
    });
    await this.checkpointPersistence.persist({
      taskId: params.taskId,
      definition: params.definition,
      runtime: params.nextRuntime,
      activeProviderId: params.selectedProvider.id,
      skipTerminalImprovementRefresh: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(params.nextRuntime.lifecycleStatus),
      correlationId: params.correlationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      unitId: params.currentUnitId
    });
    await saveUserPreferenceProfile(this.foundation, params.updatedUserProfile);
    await this.foundation.taskMetadata.save({
      taskId: params.taskId,
      createdAt: params.previousRuntime.createdAt,
      updatedAt: params.nextRuntime.updatedAt,
      latestSessionId: params.sessionId,
      selectedProviderId: params.selectedProvider.id,
      labels: [],
      metadata: {
        latestUnitId: params.currentUnitId,
        latestTurnId: params.turnId,
        latestCheckpointId: params.checkpointId,
        memory: params.nextRuntime.memory,
        promptEfficiency: params.nextRuntime.promptBudget
      }
    });
    await this.foundation.sessions.save({
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      taskId: params.taskId,
      unitId: params.currentUnitId,
      providerId: params.selectedProvider.id,
      status: params.nextRuntime.lifecycleStatus === 'FAILED' ? 'FAILED' : 'COMPLETED',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: Date.now(),
      metadata: {
        model: params.resolvedProvider.model,
        responseId: params.providerResponseId,
        usage: params.providerUsage
      }
    });

    const acceptedOutputs = params.acceptedOutputs ?? (params.orchestrated.acceptance.acceptedOutput && params.orchestrated.acceptance.acceptedOutput.parsedJson !== null
      ? [{
        unitId: params.orchestrated.acceptance.acceptedOutput.unitId,
        wrapper: params.orchestrated.acceptance.acceptedOutput.wrapper,
        raw: params.orchestrated.acceptance.acceptedOutput.raw,
        parsedJson: params.orchestrated.acceptance.acceptedOutput.parsedJson,
        contractKeys: params.orchestrated.acceptance.contractKeys
      }]
      : []);
    await this.outputPersistence.persistAcceptedOutputs({
      taskId: params.taskId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      currentUnitId: params.currentUnitId,
      acceptedOutputs
    });

    await this.projectionPersistence.persistSuccessfulTurnProjection({
      taskId: params.taskId,
      definition: params.definition,
      runtime: params.nextRuntime,
      currentUnitId: params.currentUnitId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      explicitOutputCount: params.orchestrated.parsed.explicitOutputs.length,
      trackerCount: params.orchestrated.parsed.trackers.length,
      toolCallCount: params.orchestrated.parsed.toolCalls.length,
      selectedProviderId: params.selectedProvider.id
    });

    if (params.pendingOperatorInputs.length > 0) {
      for (const pendingInput of params.pendingOperatorInputs) {
        const latestOperatorRecord = params.latestOperatorMessages.find((record) => record.messageId === pendingInput.messageId);
        if (!latestOperatorRecord || latestOperatorRecord.status === 'CONSUMED') {
          continue;
        }
        await this.foundation.operatorMessages.append(
          this.commandService.createConsumedOperatorMessage(latestOperatorRecord, {
            consumedTurnId: params.turnId
          })
        );
      }
    }
    if (params.nextRuntime.lifecycleStatus === 'COMPLETED') {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TASK_COMPLETED',
          payload: {
            taskId: params.taskId
          }
        })
      );
    } else if (params.nextRuntime.lifecycleStatus === 'PAUSED') {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TASK_PAUSED',
          payload: {
            taskId: params.taskId,
            reason: params.interruptReason ?? 'pause applied after turn'
          }
        })
      );
    } else if (params.nextRuntime.lifecycleStatus === 'FAILED') {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TASK_FAILED',
          payload: {
            taskId: params.taskId,
            error: params.nextRuntime.lastError
          }
        })
      );
    } else if (params.nextRuntime.lifecycleStatus === 'CANCELLED') {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TASK_CANCELLED',
          payload: {
            taskId: params.taskId,
            reason: params.interruptReason ?? 'cancel applied after turn'
          }
        })
      );
    }

    await this.foundation.conversations.append(
      createConversationMessage({
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        role: 'runtime',
        visibility: 'internal',
        content: params.prompt,
        metadata: {
          unitId: params.currentUnitId,
          turnId: params.turnId,
          checkpointId: params.checkpointId
        }
      })
    );
    if (params.userMessage?.trim()) {
      await this.foundation.conversations.append(
        createConversationMessage({
          taskId: params.taskId,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          role: 'user',
          content: params.userMessage.trim(),
          metadata: {
            unitId: params.currentUnitId,
            turnId: params.turnId
          }
        })
      );
    }
    await this.foundation.conversations.append(
      createConversationMessage({
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        role: 'assistant',
        visibility: 'internal',
        content: params.providerOutputText,
        metadata: {
          source: 'provider_response',
          unitId: params.currentUnitId,
          turnId: params.turnId,
          responseId: params.providerResponseId,
          usage: params.providerUsage
        }
      })
    );

    const dispatch = params.precomputedToolDispatch ?? await this.toolDispatch.dispatchReadyInvocations({
      taskId: params.taskId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId
    });
    const [latestInvocations, latestCommands] = await Promise.all([
      this.foundation.toolInvocations.listLatest(params.taskId),
      this.foundation.commands.listLatest(params.taskId)
    ]);
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: params.definition,
      invocations: latestInvocations,
      commands: latestCommands
    });
    const visibleOutputCandidate = buildVisibleOutputCandidate({
      ...params,
      acceptedOutputs
    });
    const publicAssistantSummary = buildPublicAssistantSummary({
      input: params,
      visibleCandidate: visibleOutputCandidate,
      artifactRouting,
      approvalBlockedCount: dispatch.approvalBlockedInvocationIds.length
    });
    if (publicAssistantSummary) {
      await this.foundation.conversations.append(
        createConversationMessage({
          taskId: params.taskId,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          role: 'assistant',
          visibility: 'public',
          content: publicAssistantSummary.content,
          metadata: {
            source: 'assistant_summary',
            displayKind: publicAssistantSummary.displayKind,
            unitId: params.currentUnitId,
            turnId: params.turnId
          }
        })
      );
    }
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'TOOL_DISPATCH_REVIEWED',
        payload: dispatch
      })
    );
    if (params.nextRuntime.lifecycleStatus === 'COMPLETED') {
      await runWorkspaceHooks({
        foundation: this.foundation,
        event: 'task.completed',
        taskId: params.taskId,
        unitId: params.currentUnitId,
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        metadata: {
          providerId: params.selectedProvider.id
        }
      });
    }
    await runWorkspaceHooks({
      foundation: this.foundation,
      event: 'turn.stop',
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: params.correlationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      metadata: {
        lifecycleStatus: params.nextRuntime.lifecycleStatus,
        providerId: params.selectedProvider.id
      }
    });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(params.nextRuntime.lifecycleStatus)) {
      await this.records.refreshTerminalTaskImprovements(params.taskId);
    }

    return {
      response: {
        command: this.records.createCommandResult(params.taskId, params.nextRuntime.lifecycleStatus, 'Task turn executed.'),
        task: await this.records.buildTaskQuery(params.taskId)
      }
    };
  }
}
