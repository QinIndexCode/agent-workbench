import { TaskRuntimeState, ParsedTurn } from '../../../domain/contracts/types';
import { BatchAdmissionDecision, BatchGuardrailState, evaluateBatchAdmission } from '../../../domain/validation';
import { ToolBatchExecutionResult, ToolBatchRecord } from '../../../foundation/repository';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { createToolApprovalRecord } from '../../../foundation/tools/approval-record';
import { createToolExecutionAuditDetails } from '../../../foundation/tools/execution-audit';
import { createToolInvocationRecord } from '../../../foundation/tools/create-invocation-record';
import { evaluateToolExecutionPolicy } from '../../../foundation/tools/execution-policy';
import { validateToolInvocationRequest } from '../../../foundation/tools/validate-invocation';
import { validateHostObservationRunCommandBoundary } from '../../runtime/host-observation-policy';
import { ToolDispatchOrchestrator } from './tool-dispatch-orchestrator';
import { shouldMarkInvocationAsVerification } from './tool-verification';

export interface ToolBatchPlanAndExecutionResult {
  batchRecords: ToolBatchRecord[];
  batchExecutionResults: ToolBatchExecutionResult[];
  admissionDecisions: BatchAdmissionDecision[];
  guardrail: BatchGuardrailState;
  dispatch: {
    dispatchedInvocationIds: string[];
    approvalBlockedInvocationIds: string[];
    deniedInvocationIds: string[];
    failedInvocationIds: string[];
  };
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  rejected: string[];
}

interface ValidatedCandidate {
  invocationKey: string;
  batchId: string;
  stageIndex: number;
  unitIdsInBatch: string[];
  hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
  request: {
    taskId: string;
    unitId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  parserSource: ParsedTurn['toolCalls'][number]['source'];
  tool: {
    id: string;
    effect: string;
    riskLevel: string;
  };
}

function createEmptyDispatch() {
  return {
    dispatchedInvocationIds: [] as string[],
    approvalBlockedInvocationIds: [] as string[],
    deniedInvocationIds: [] as string[],
    failedInvocationIds: [] as string[]
  };
}

function computeBatchStatus(params: {
  record: ToolBatchRecord;
  dispatch: ReturnType<typeof createEmptyDispatch>;
}): ToolBatchExecutionResult['status'] {
  const invocationIds = new Set(params.record.items.map((item) => item.invocationId));
  const approvalBlocked = params.dispatch.approvalBlockedInvocationIds.filter((id) => invocationIds.has(id));
  const denied = params.dispatch.deniedInvocationIds.filter((id) => invocationIds.has(id));
  const failed = params.dispatch.failedInvocationIds.filter((id) => invocationIds.has(id));

  if (params.record.items.length === 0) {
    return 'SUCCEEDED';
  }
  if (denied.length === params.record.items.length) {
    return 'DENIED';
  }
  if (approvalBlocked.length > 0 || denied.length > 0) {
    return 'PARTIAL_APPROVAL_BLOCKED';
  }
  if (failed.length > 0) {
    return 'FAILED';
  }
  return 'SUCCEEDED';
}

function createSideEffectKey(candidate: ValidatedCandidate): string | null {
  const args = candidate.request.arguments;
  const pathLike = args.path ?? args.filePath ?? args.target ?? args.url;
  if (pathLike === undefined || pathLike === null || pathLike === '') {
    return candidate.tool.effect === 'READ' ? null : `${candidate.request.toolName}:generic-side-effect`;
  }
  return `${candidate.request.toolName}:${String(pathLike)}`;
}

export class ToolBatchExecutorService {
  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly toolDispatch: ToolDispatchOrchestrator
  ) {}

  async planAndExecute(params: {
    taskId: string;
    currentUnitId: string;
    runtime: TaskRuntimeState;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    activeStage: {
      stageIndex: number;
      unitIds: string[];
    } | null;
    toolCallFormat: 'json-or-xml' | 'json';
    allowedToolIdsByUnitId: Record<string, string[] | null>;
    plannedBatches: Array<{
      batchId: string;
      stageIndex: number;
      unitIds: string[];
      hint: 'SERIAL_READY' | 'PARALLEL_CANDIDATE';
    }>;
    parsedToolCalls: ParsedTurn['toolCalls'];
    parseWarnings?: string[];
  }): Promise<ToolBatchPlanAndExecutionResult> {
    if (!params.activeStage || params.plannedBatches.length === 0) {
      return {
        batchRecords: [],
        batchExecutionResults: [],
        admissionDecisions: [],
        guardrail: {
          batchAdmissionRestricted: false,
          reasons: []
        },
        dispatch: createEmptyDispatch(),
        acceptedInvocationIds: [],
        approvalInvocationIds: [],
        rejected: []
      };
    }

    const stageUnitIds = new Set(params.activeStage.unitIds);
    const rejected: string[] = [];
    const acceptedInvocationIds: string[] = [];
    const approvalInvocationIds: string[] = [];
    const batches = params.plannedBatches.map((batch) => ({
      ...batch,
      items: [] as ToolBatchRecord['items']
    }));
    const candidates: ValidatedCandidate[] = [];
    const invalidToolWarnings = (params.parseWarnings ?? []).filter((warning) => /invalid_tool_json/i.test(warning));
    if (invalidToolWarnings.length > 0) {
      rejected.push(...invalidToolWarnings);
      return {
        batchRecords: [],
        batchExecutionResults: [],
        admissionDecisions: [],
        guardrail: {
          batchAdmissionRestricted: false,
          reasons: ['invalid_tool_json']
        },
        dispatch: createEmptyDispatch(),
        acceptedInvocationIds,
        approvalInvocationIds,
        rejected
      };
    }

    for (const [callIndex, call] of params.parsedToolCalls.entries()) {
      if (params.toolCallFormat === 'json' && call.source === 'xml') {
        rejected.push(`${call.toolName}: XML tool wrappers are not allowed for the current JSON-only provider policy. Emit a canonical JSON tool object instead.`);
        continue;
      }
      const requestedUnitId = call.unitId === 'UNKNOWN' ? params.currentUnitId : call.unitId;
      if (!stageUnitIds.has(requestedUnitId)) {
        rejected.push(`${call.toolName}: tool call unit "${requestedUnitId}" is outside active stage ${params.activeStage.stageIndex}.`);
        continue;
      }
      const batch = batches.find((candidate) => candidate.unitIds.includes(requestedUnitId)) ?? batches[0];
      const request = {
        taskId: params.taskId,
        unitId: requestedUnitId,
        toolName: call.toolName,
        arguments: call.parameters
      };
      const validation = validateToolInvocationRequest(this.foundation.extensions, request);
      if (!validation.ok) {
        rejected.push(`${request.toolName}: ${validation.errors.join(' ')}`);
        continue;
      }
      const allowedToolIds = params.allowedToolIdsByUnitId[requestedUnitId] ?? null;
      if (allowedToolIds && !allowedToolIds.includes(validation.tool.id)) {
        rejected.push(`${request.toolName}: tool is not allowed for unit "${requestedUnitId}" execution profile.`);
        continue;
      }
      const hostObservationBoundaryError = validateHostObservationRunCommandBoundary({
        allowedToolIds,
        toolId: validation.tool.id,
        argumentsRecord: validation.normalizedArguments
      });
      if (hostObservationBoundaryError) {
        rejected.push(`${request.toolName}: ${hostObservationBoundaryError}`);
        continue;
      }
      candidates.push({
        invocationKey: `${batch.batchId}:${callIndex}:${requestedUnitId}:${request.toolName}`,
        batchId: batch.batchId,
        stageIndex: batch.stageIndex,
        unitIdsInBatch: [...batch.unitIds],
        hint: batch.hint,
        request: {
          ...request,
          arguments: validation.normalizedArguments
        },
        parserSource: call.source,
        tool: {
          id: validation.tool.id,
          effect: validation.tool.effect,
          riskLevel: validation.tool.riskLevel
        }
      });
    }

    const admission = evaluateBatchAdmission({
      runtime: params.runtime,
      candidates: candidates.map((candidate) => ({
        invocationKey: candidate.invocationKey,
        batchId: candidate.batchId,
        stageIndex: candidate.stageIndex,
        unitId: candidate.request.unitId,
        unitIdsInBatch: candidate.unitIdsInBatch,
        toolName: candidate.request.toolName,
        sideEffectKey: createSideEffectKey(candidate),
        argumentText: JSON.stringify(candidate.request.arguments)
      }))
    });
    const decisionByBatchId = new Map(admission.decisions.map((decision) => [decision.batchId, decision]));
    const latestApprovals = await this.foundation.approvals.listLatest(params.taskId);

    for (const candidate of candidates) {
      const batch = batches.find((entry) => entry.batchId === candidate.batchId);
      if (!batch) {
        rejected.push(`${candidate.request.toolName}: batch "${candidate.batchId}" was not found.`);
        continue;
      }
      const decision = decisionByBatchId.get(candidate.batchId);
      const admitted = decision?.admittedInvocationKeys.includes(candidate.invocationKey) ?? true;
      if (!admitted) {
        rejected.push(`${candidate.request.toolName}: ${(decision?.rejectionReasons ?? []).join(', ')}`);
        continue;
      }

      const policy = evaluateToolExecutionPolicy({
        config: this.foundation.config,
        tool: {
          id: candidate.tool.id,
          name: candidate.request.toolName,
          description: candidate.request.toolName,
          source: 'builtin',
          effect: candidate.tool.effect as 'READ' | 'WRITE' | 'NETWORK',
          riskLevel: candidate.tool.riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
          inputSchema: []
        },
        argumentsRecord: candidate.request.arguments,
        taskApprovals: latestApprovals
      });
      const invocation = createToolInvocationRecord({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        request: candidate.request,
        status: policy.decision === 'DENY'
          ? 'DENIED'
          : (policy.decision === 'REQUIRE_APPROVAL' ? 'WAITING_APPROVAL' : 'PLANNED'),
        error: policy.decision === 'DENY' ? policy.reason : null,
        metadata: {
          source: 'planner_batch',
          parserSource: candidate.parserSource,
          batchId: candidate.batchId,
          stageIndex: candidate.stageIndex,
          permissionDecision: policy.decision,
          permissionReason: policy.reason,
          riskCategory: policy.riskCategory,
          permissionGrantMatched: policy.grantMatched,
          verification: shouldMarkInvocationAsVerification({
            toolName: candidate.request.toolName,
            argumentsRecord: candidate.request.arguments
          }),
          toolEffect: candidate.tool.effect,
          toolRiskLevel: candidate.tool.riskLevel
        }
      });
      batch.items.push({
        invocationId: invocation.invocationId,
        unitId: invocation.unitId,
        toolId: invocation.toolId,
        status: invocation.status
      });
      await this.foundation.toolInvocations.append(invocation);

      if (policy.decision === 'DENY') {
        rejected.push(`${candidate.request.toolName}: ${policy.reason}`);
      } else if (policy.decision === 'REQUIRE_APPROVAL') {
        approvalInvocationIds.push(invocation.invocationId);
        await this.foundation.approvals.append(
          createToolApprovalRecord({
            invocation,
            reason: policy.reason,
            metadata: {
              permissionDecision: policy.decision,
              riskCategory: policy.riskCategory,
              grantScope: 'task_risk_category',
              batchId: candidate.batchId
            }
          })
        );
      } else {
        acceptedInvocationIds.push(invocation.invocationId);
      }

      await this.foundation.logs.recordAudit({
        timestamp: Date.now(),
        severity: policy.decision === 'DENY' ? 'WARN' : (policy.decision === 'REQUIRE_APPROVAL' ? 'INFO' : 'DEBUG'),
        event: policy.decision === 'DENY'
          ? 'tool_invocation_denied'
          : (policy.decision === 'REQUIRE_APPROVAL' ? 'tool_invocation_waiting_approval' : 'tool_invocation_planned'),
        taskId: params.taskId,
        unitId: candidate.request.unitId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        details: createToolExecutionAuditDetails({
          taskId: params.taskId,
          unitId: candidate.request.unitId,
          toolName: candidate.request.toolName,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          policy
        })
      });
    }

    const batchRecords: ToolBatchRecord[] = batches
      .filter((batch) => batch.items.length > 0)
      .map((batch) => ({
        batchId: batch.batchId,
        taskId: params.taskId,
        stageIndex: batch.stageIndex,
        unitIds: [...batch.unitIds],
        status: 'PLANNED',
        createdAt: Date.now(),
        executedAt: null,
        items: batch.items.map((item) => ({ ...item })),
        metadata: {
          hint: batch.hint
        }
      }));

    for (const record of batchRecords) {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TOOL_BATCH_PLANNED',
          payload: {
            batchId: record.batchId,
            stageIndex: record.stageIndex,
            unitIds: record.unitIds,
            invocationIds: record.items.map((item) => item.invocationId)
          }
        })
      );
    }

    const dispatch = batchRecords.length > 0
      ? await this.toolDispatch.dispatchReadyInvocations({
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId
      })
      : createEmptyDispatch();

    const batchExecutionResults = batchRecords.map((record) => {
      const status = computeBatchStatus({ record, dispatch });
      return {
        batchId: record.batchId,
        stageIndex: record.stageIndex,
        status,
        dispatchedInvocationIds: dispatch.dispatchedInvocationIds.filter((id) => record.items.some((item) => item.invocationId === id)),
        approvalBlockedInvocationIds: dispatch.approvalBlockedInvocationIds.filter((id) => record.items.some((item) => item.invocationId === id)),
        deniedInvocationIds: dispatch.deniedInvocationIds.filter((id) => record.items.some((item) => item.invocationId === id)),
        failedInvocationIds: dispatch.failedInvocationIds.filter((id) => record.items.some((item) => item.invocationId === id))
      } satisfies ToolBatchExecutionResult;
    });

    for (const result of batchExecutionResults) {
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: params.currentUnitId,
          checkpointId: params.checkpointId,
          type: 'TOOL_BATCH_EXECUTED',
          payload: result
        })
      );
    }

    return {
      batchRecords,
      batchExecutionResults,
      admissionDecisions: admission.decisions,
      guardrail: admission.guardrail,
      dispatch,
      acceptedInvocationIds,
      approvalInvocationIds,
      rejected
    };
  }
}
