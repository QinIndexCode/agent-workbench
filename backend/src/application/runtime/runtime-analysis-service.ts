import { parseTurn } from '../../domain/parser/unit-output-parser';
import { evolveTaskMemory, evolveUserPreferenceProfile } from '../../domain/runtime/memory';
import {
  applyCorrectionRequirement,
  applyTracker,
  createInitialState,
  getCorrectionModeDescription
} from '../../domain/runtime/state-machine';
import { acceptParsedTurn } from '../../domain/validation/response-acceptance-policy';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createCheckpointId, createExecutionCorrelation } from '../../foundation/correlation/create-correlation';
import { createConversationMessage } from '../../foundation/conversation/create-message';
import { createConfigSnapshotRecord, shouldReloadConfig } from '../../foundation/config/reload-policy';
import { buildTaskProjection } from '../../foundation/projection/projection-builder';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import {
  findLatestApprovalForInvocation,
  resolveToolApprovalRecord,
  ToolApprovalResolutionInput
} from '../../foundation/tools/approval-resolution';
import { planToolInvocationDispatch, ToolDispatchPlanEntry } from '../../foundation/tools/dispatch-plan';
import { createToolExecutionAuditDetails } from '../../foundation/tools/execution-audit';
import { createToolApprovalRecord } from '../../foundation/tools/approval-record';
import { createToolInvocationRecord } from '../../foundation/tools/create-invocation-record';
import { evaluateToolExecutionPolicy } from '../../foundation/tools/execution-policy';
import { validateToolInvocationRequest } from '../../foundation/tools/validate-invocation';
import { loadUserPreferenceProfile, saveUserPreferenceProfile } from './memory-store';

export class RuntimeAnalysisService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  private resolveSessionStatus(pendingCorrection: string): 'COMPLETED' | 'FAILED' {
    return pendingCorrection === 'NONE' ? 'COMPLETED' : 'FAILED';
  }

  private async persistPlannedToolInvocations(params: {
    taskId: string;
    currentUnitId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    parsedToolCalls: ReturnType<typeof parseTurn>['toolCalls'];
  }): Promise<{
    accepted: number;
    approvalRequired: number;
    rejected: string[];
  }> {
    const rejected: string[] = [];
    let accepted = 0;
    let approvalRequired = 0;
    const latestApprovals = await this.foundation.approvals.listLatest(params.taskId);

    for (const call of params.parsedToolCalls) {
      const request = {
        taskId: params.taskId,
        unitId: call.unitId === 'UNKNOWN' ? params.currentUnitId : call.unitId,
        toolName: call.toolName,
        arguments: call.parameters
      };
      const validation = validateToolInvocationRequest(this.foundation.extensions, request);
      if (!validation.ok) {
        rejected.push(`${request.toolName}: ${validation.errors.join(' ')}`);
        continue;
      }

      const policy = evaluateToolExecutionPolicy({
        config: this.foundation.config,
        tool: validation.tool,
        argumentsRecord: validation.normalizedArguments,
        taskApprovals: latestApprovals
      });
      if (policy.decision === 'DENY') {
        rejected.push(`${request.toolName}: ${policy.reason}`);
        await this.foundation.logs.recordAudit({
          timestamp: Date.now(),
          severity: 'WARN',
          event: 'tool_invocation_denied',
          taskId: params.taskId,
          unitId: request.unitId,
          correlationId: params.correlationId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          details: createToolExecutionAuditDetails({
            taskId: params.taskId,
            unitId: request.unitId,
            toolName: request.toolName,
            sessionId: params.sessionId,
            correlationId: params.correlationId,
            turnId: params.turnId,
            checkpointId: params.checkpointId,
            policy
          })
        });
        continue;
      }

      const status = policy.decision === 'REQUIRE_APPROVAL' ? 'WAITING_APPROVAL' : 'PLANNED';
      if (status === 'WAITING_APPROVAL') {
        approvalRequired += 1;
      }

      const invocation = createToolInvocationRecord({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        request: {
          ...request,
          arguments: validation.normalizedArguments
        },
        status,
        metadata: {
          source: 'llm_response',
          parserSource: call.source,
          permissionDecision: policy.decision,
          permissionReason: policy.reason,
          riskCategory: policy.riskCategory,
          permissionGrantMatched: policy.grantMatched,
          toolEffect: validation.tool.effect,
          toolRiskLevel: validation.tool.riskLevel
        }
      });
      await this.foundation.toolInvocations.append(invocation);

      if (status === 'WAITING_APPROVAL') {
        await this.foundation.approvals.append(
          createToolApprovalRecord({
            invocation,
            reason: policy.reason,
            metadata: {
              permissionDecision: policy.decision,
              riskCategory: policy.riskCategory,
              grantScope: 'task_risk_category',
              toolEffect: validation.tool.effect,
              toolRiskLevel: validation.tool.riskLevel
            }
          })
        );
      }
      await this.foundation.logs.recordAudit({
        timestamp: Date.now(),
        severity: policy.decision === 'REQUIRE_APPROVAL' ? 'INFO' : 'DEBUG',
        event: policy.decision === 'REQUIRE_APPROVAL'
          ? 'tool_invocation_waiting_approval'
          : 'tool_invocation_planned',
        taskId: params.taskId,
        unitId: request.unitId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        details: createToolExecutionAuditDetails({
          taskId: params.taskId,
          unitId: request.unitId,
          toolName: request.toolName,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          policy
        })
      });
      accepted += 1;
    }

    return {
      accepted,
      approvalRequired,
      rejected
    };
  }

  async analyzeTurn(params: {
    taskId: string;
    currentUnitId: string;
    outputContract?: string;
    exitCondition?: string;
    llmResponse: string;
    userMessage?: string;
  }): Promise<{
    contractKeys: string[];
    parsed: ReturnType<typeof parseTurn>;
    correctionHint: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
  }> {
    await this.foundation.logs.initialize();
    const correlation = createExecutionCorrelation(params.taskId, params.currentUnitId);
    const checkpointId = createCheckpointId(correlation.turnId);
    const activeConfig = await this.foundation.configSnapshots.getActive();
    if (shouldReloadConfig(activeConfig, this.foundation.config)) {
      const snapshot = createConfigSnapshotRecord(this.foundation.config);
      await this.foundation.configSnapshots.save({
        version: snapshot.version,
        fingerprint: snapshot.fingerprint,
        createdAt: snapshot.createdAt,
        config: snapshot.config
      });
    }

    const state = createInitialState(params.taskId);
    const parsed = parseTurn(params.llmResponse);
    const plannedTools = await this.persistPlannedToolInvocations({
      taskId: params.taskId,
      currentUnitId: params.currentUnitId,
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      checkpointId,
      parsedToolCalls: parsed.toolCalls
    });
    const acceptance = acceptParsedTurn({
      currentUnitId: params.currentUnitId,
      parsed,
      outputContract: params.outputContract,
      exitCondition: params.exitCondition
    });
    const contractKeys = acceptance.contractKeys;
    const primaryOutput = acceptance.acceptedOutput;

    await this.foundation.logs.recordTrace({
      timestamp: Date.now(),
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      action: 'response_received',
      details: {
        response: params.llmResponse,
        outputContract: params.outputContract ?? null,
        exitCondition: params.exitCondition ?? null
      }
    });

    if (params.userMessage?.trim()) {
      await this.foundation.conversations.append(
        createConversationMessage({
          taskId: params.taskId,
          sessionId: correlation.sessionId,
          correlationId: correlation.correlationId,
          role: 'user',
          content: params.userMessage,
          metadata: {
            unitId: params.currentUnitId,
            turnId: correlation.turnId
          }
        })
      );
    }

    await this.foundation.conversations.append(
      createConversationMessage({
        taskId: params.taskId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        role: 'assistant',
        content: params.llmResponse,
        metadata: {
          unitId: params.currentUnitId,
          turnId: correlation.turnId
        }
      })
    );

    await this.foundation.logs.recordTrace({
      timestamp: Date.now(),
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      action: 'parse_completed',
      details: {
        explicitOutputCount: parsed.explicitOutputs.length,
        trackerCount: parsed.trackers.length,
        toolCallCount: parsed.toolCalls.length,
        acceptedToolCallCount: plannedTools.accepted,
        approvalRequiredToolCallCount: plannedTools.approvalRequired,
        rejectedToolCalls: plannedTools.rejected,
        contractKeys,
        acceptanceOk: acceptance.ok,
        pendingCorrection: acceptance.pendingCorrection,
        issues: acceptance.issues.map(issue => issue.message)
      }
    });

    const nextState = acceptance.ok && acceptance.acceptedTracker
      ? applyTracker(state, acceptance.acceptedTracker)
      : applyCorrectionRequirement(
        state,
        params.currentUnitId,
        acceptance.pendingCorrection,
        acceptance.issues.map(issue => issue.message)
      );

    if (nextState.pendingCorrection !== 'NONE') {
      await this.foundation.logs.recordTrace({
        timestamp: Date.now(),
        taskId: params.taskId,
        unitId: params.currentUnitId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        action: 'validation_failed',
        details: {
          pendingCorrection: nextState.pendingCorrection,
          issues: acceptance.issues.map(issue => issue.message)
        }
      });
    }

    await this.foundation.logs.writeCheckpoint({
      timestamp: Date.now(),
      checkpointId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      taskId: params.taskId,
      unitId: params.currentUnitId,
      state: {
        currentUnitId: nextState.currentUnitId,
        status: nextState.status,
        pendingCorrection: nextState.pendingCorrection,
        progressHistory: nextState.progressHistory
      }
    });

    await this.foundation.checkpoints.save({
      taskId: params.taskId,
      timestamp: Date.now(),
      state: {
        currentUnitId: nextState.currentUnitId,
        status: nextState.status,
        pendingCorrection: nextState.pendingCorrection,
        progressHistory: nextState.progressHistory
      }
    });

    const [existingMetadata, userProfile] = await Promise.all([
      this.foundation.taskMetadata.get(params.taskId),
      loadUserPreferenceProfile(this.foundation)
    ]);
    const updatedUserProfile = evolveUserPreferenceProfile({
      current: userProfile,
      userMessage: params.userMessage
    });
    const updatedTaskMemory = evolveTaskMemory({
      current: (existingMetadata?.metadata?.memory as ReturnType<typeof evolveTaskMemory> | undefined) ?? null,
      userMessage: params.userMessage,
      acceptedTracker: acceptance.acceptedTracker,
      acceptedOutput: acceptance.acceptedOutput,
      userProfile: updatedUserProfile
    });
    const now = Date.now();
    await saveUserPreferenceProfile(this.foundation, updatedUserProfile);
    await this.foundation.taskMetadata.save({
      taskId: params.taskId,
      createdAt: existingMetadata?.createdAt ?? now,
      updatedAt: now,
      latestSessionId: correlation.sessionId,
      selectedProviderId: existingMetadata?.selectedProviderId ?? null,
      labels: existingMetadata?.labels ?? [],
      metadata: {
        ...(existingMetadata?.metadata ?? {}),
        latestUnitId: params.currentUnitId,
        latestTurnId: correlation.turnId,
        latestCheckpointId: checkpointId,
        memory: updatedTaskMemory,
        userPreferences: updatedUserProfile
      }
    });

    await this.foundation.sessions.save({
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      taskId: params.taskId,
      unitId: params.currentUnitId,
      providerId: null,
      status: this.resolveSessionStatus(nextState.pendingCorrection),
      createdAt: now,
      updatedAt: now,
      endedAt: now,
      metadata: {
        explicitOutputCount: parsed.explicitOutputs.length,
        trackerCount: parsed.trackers.length,
        toolCallCount: parsed.toolCalls.length,
        acceptedToolCallCount: plannedTools.accepted,
        approvalRequiredToolCallCount: plannedTools.approvalRequired,
        rejectedToolCalls: plannedTools.rejected,
        issues: acceptance.issues.map(issue => issue.message)
      }
    });

    if (primaryOutput && primaryOutput.parsedJson !== null) {
      await this.foundation.validatedOutputs.save({
        taskId: params.taskId,
        unitId: primaryOutput.unitId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        checkpointId,
        contractKeys,
        wrapper: primaryOutput.wrapper,
        raw: primaryOutput.raw,
        parsed: primaryOutput.parsedJson,
        validatedAt: Date.now(),
        metadata: {
          currentUnitId: params.currentUnitId
        }
      });
    }

    const projection = buildTaskProjection({
      taskId: params.taskId,
      status: nextState.status,
      currentUnitId: nextState.currentUnitId,
      latestSessionId: correlation.sessionId,
      latestCorrelationId: correlation.correlationId,
      latestTurnId: correlation.turnId,
      latestCheckpointId: checkpointId,
      explicitOutputCount: parsed.explicitOutputs.length,
      trackerCount: parsed.trackers.length,
      toolCallCount: parsed.toolCalls.length,
      pendingCorrection: nextState.pendingCorrection,
      metadata: {
        latestUnitId: params.currentUnitId
      }
    });

    await this.foundation.projections.save(projection);
    await this.foundation.tasks.save({
      taskId: params.taskId,
      status: nextState.status,
      currentUnitId: nextState.currentUnitId,
      updatedAt: Date.now(),
      payload: {
        contractKeys,
        explicitOutputCount: parsed.explicitOutputs.length,
        trackerCount: parsed.trackers.length,
        toolCallCount: parsed.toolCalls.length,
        acceptedToolCallCount: plannedTools.accepted,
        approvalRequiredToolCallCount: plannedTools.approvalRequired,
        rejectedToolCalls: plannedTools.rejected,
        pendingCorrection: nextState.pendingCorrection,
        latestTurnId: correlation.turnId,
        latestCheckpointId: checkpointId
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: correlation.correlationId,
        sessionId: correlation.sessionId,
        turnId: correlation.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId,
        type: 'TURN_ANALYZED',
        payload: {
          projection,
          correctionHint: getCorrectionModeDescription(nextState.pendingCorrection),
          acceptedToolCallCount: plannedTools.accepted,
          approvalRequiredToolCallCount: plannedTools.approvalRequired,
          rejectedToolCalls: plannedTools.rejected
        }
      })
    );

    await this.foundation.conversations.append(
      createConversationMessage({
        taskId: params.taskId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        role: 'runtime',
        visibility: 'internal',
        content: getCorrectionModeDescription(nextState.pendingCorrection),
        metadata: {
          pendingCorrection: nextState.pendingCorrection,
          turnId: correlation.turnId,
          checkpointId
        }
      })
    );

    await this.foundation.logs.recordAudit({
      timestamp: Date.now(),
      severity: 'INFO',
      event: 'turn_analyzed',
      taskId: params.taskId,
      unitId: params.currentUnitId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      checkpointId,
      details: {
        explicitOutputCount: parsed.explicitOutputs.length,
        trackerCount: parsed.trackers.length,
        toolCallCount: parsed.toolCalls.length,
        acceptedToolCallCount: plannedTools.accepted,
        approvalRequiredToolCallCount: plannedTools.approvalRequired,
        rejectedToolCalls: plannedTools.rejected,
        pendingCorrection: nextState.pendingCorrection
      }
    });

    return {
      contractKeys,
      parsed,
      correctionHint: getCorrectionModeDescription(nextState.pendingCorrection),
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      checkpointId
    };
  }

  async resolveToolApproval(params: {
    taskId: string;
    invocationId: string;
    resolution: ToolApprovalResolutionInput;
  }) {
    const approvals = await this.foundation.approvals.list(params.taskId);
    const latest = findLatestApprovalForInvocation(approvals, params.invocationId);
    if (!latest) {
      throw new Error(`backend_new runtime error: no approval record found for invocation "${params.invocationId}".`);
    }

    const resolved = resolveToolApprovalRecord(latest, params.resolution);
    await this.foundation.approvals.append(resolved);
    await this.foundation.logs.recordAudit({
      timestamp: resolved.resolvedAt ?? Date.now(),
      severity: 'INFO',
      event: 'tool_approval_resolved',
      taskId: resolved.taskId,
      unitId: resolved.unitId,
      correlationId: resolved.correlationId,
      turnId: resolved.turnId,
      checkpointId: resolved.checkpointId,
      details: {
        invocationId: resolved.invocationId,
        approvalId: resolved.approvalId,
        status: resolved.status,
        grantedBy: resolved.grantedBy,
        reason: resolved.reason
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: resolved.correlationId,
        sessionId: resolved.sessionId,
        turnId: resolved.turnId,
        taskId: resolved.taskId,
        unitId: resolved.unitId,
        checkpointId: resolved.checkpointId,
        type: 'TOOL_APPROVAL_RESOLVED',
        payload: {
          invocationId: resolved.invocationId,
          approvalId: resolved.approvalId,
          status: resolved.status,
          grantedBy: resolved.grantedBy,
          reason: resolved.reason
        }
      })
    );

    return resolved;
  }

  async reviewPendingToolDispatch(taskId: string): Promise<{
    entries: ToolDispatchPlanEntry[];
    summary: {
      dispatchable: number;
      waitingApproval: number;
      denied: number;
    };
  }> {
    const [invocations, approvals] = await Promise.all([
      this.foundation.toolInvocations.list(taskId),
      this.foundation.approvals.list(taskId)
    ]);

    const candidates = invocations.filter(invocation => (
      invocation.status === 'PLANNED' || invocation.status === 'WAITING_APPROVAL'
    ));
    const entries = candidates.map(invocation => {
      const latestApproval = findLatestApprovalForInvocation(approvals, invocation.invocationId);
      const tool = this.foundation.extensions.findTool(invocation.toolId);
      const capability = tool ? this.foundation.toolExecutors.resolveCapability(tool) : null;
      return planToolInvocationDispatch({
        invocation,
        approval: latestApproval,
        capability
      });
    });

    const summary = {
      dispatchable: entries.filter(entry => entry.decision === 'DISPATCH').length,
      waitingApproval: entries.filter(entry => entry.decision === 'WAIT_APPROVAL').length,
      denied: entries.filter(entry => entry.decision === 'DENY').length
    };

    await this.foundation.logs.recordAudit({
      timestamp: Date.now(),
      severity: 'INFO',
      event: 'tool_dispatch_reviewed',
      taskId,
      unitId: null,
      correlationId: null,
      turnId: null,
      checkpointId: null,
      details: summary
    });

    return {
      entries,
      summary
    };
  }
}
