import { BackendNewConfig } from '../../../foundation/config/types';
import { ExtensionRegistry } from '../../../foundation/extensions/registry';
import {
  RuntimeEventRepository,
  ToolApprovalRepository,
  ToolInvocationRepository
} from '../../../foundation/repository';
import {
  applyToolInvocationTransition,
  classifyToolError,
  createToolExecutionAuditDetails,
  dispatchToolExecutor,
  evaluateToolInvocationResumePolicy,
  findLatestApprovalForInvocation,
  type ToolRiskCategory,
  ToolExecutorRegistry
} from '../../../foundation/tools';
import { TaskLogWriter } from '../../../foundation/logging/task-log-writer';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';

export class ToolDispatchOrchestrator {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly extensions: ExtensionRegistry,
    private readonly toolExecutors: ToolExecutorRegistry,
    private readonly invocations: ToolInvocationRepository,
    private readonly approvals: ToolApprovalRepository,
    private readonly events: RuntimeEventRepository,
    private readonly logs: TaskLogWriter
  ) {}

  async dispatchReadyInvocations(params: {
    taskId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string | null;
  }): Promise<{
    dispatchedInvocationIds: string[];
    approvalBlockedInvocationIds: string[];
    deniedInvocationIds: string[];
    failedInvocationIds: string[];
  }> {
    const latestInvocations = await this.invocations.listLatest(params.taskId);
    const latestApprovals = await this.approvals.listLatest(params.taskId);
    const candidates = latestInvocations.filter(invocation => (
      invocation.status === 'PLANNED' || invocation.status === 'WAITING_APPROVAL'
    ));

    const dispatchedInvocationIds: string[] = [];
    const approvalBlockedInvocationIds: string[] = [];
    const deniedInvocationIds: string[] = [];
    const failedInvocationIds: string[] = [];

    for (const invocation of candidates) {
      const approval = findLatestApprovalForInvocation(latestApprovals, invocation.invocationId);
      const tool = this.extensions.findTool(invocation.toolId);
      const capability = tool ? this.toolExecutors.resolveCapability(tool) : null;
      const policy = evaluateToolInvocationResumePolicy({
        invocation,
        approval,
        capability
      });

      if (policy.decision === 'WAIT_APPROVAL') {
        approvalBlockedInvocationIds.push(invocation.invocationId);
        continue;
      }

      if (policy.decision === 'DENY' || !tool) {
        const denied = applyToolInvocationTransition(invocation, {
          type: 'DENY',
          reason: tool ? policy.reason : `Unknown tool "${invocation.toolId}".`
        });
        await this.invocations.append(denied);
        deniedInvocationIds.push(invocation.invocationId);
        continue;
      }

      const started = applyToolInvocationTransition(invocation, {
        type: 'START',
        metadata: {
          dispatchReason: policy.reason,
          resumedFromApproval: approval?.status === 'APPROVED'
        }
      });
      await this.invocations.append(started);

      const result = await dispatchToolExecutor({
        registry: this.toolExecutors,
        tool,
        request: {
          tool,
          invocation: {
            taskId: started.taskId,
            unitId: started.unitId,
            toolName: started.toolId,
            arguments: started.arguments
          },
          context: {
            config: this.config,
            sessionId: params.sessionId,
            correlationId: params.correlationId,
            turnId: params.turnId,
            checkpointId: params.checkpointId
          }
        }
      });

      const next = result.ok
        ? applyToolInvocationTransition(started, {
          type: 'SUCCEED',
          result,
          metadata: {
            dispatched: true
          }
        })
        : applyToolInvocationTransition(started, {
          type: 'FAIL',
          result,
          metadata: {
            dispatched: true,
            errorKind: classifyToolError(result.message)
          }
        });
      await this.invocations.append(next);
      await this.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          taskId: params.taskId,
          unitId: started.unitId,
          checkpointId: params.checkpointId,
          type: 'TOOL_EXECUTED',
          payload: {
            invocationId: started.invocationId,
            toolId: started.toolId,
            status: next.status,
            resultOk: result.ok
          }
        })
      );
      await this.logs.recordAudit({
        timestamp: Date.now(),
        severity: result.ok ? 'INFO' : 'WARN',
        event: 'tool_executed',
        taskId: params.taskId,
        unitId: started.unitId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        details: createToolExecutionAuditDetails({
          taskId: params.taskId,
          unitId: started.unitId,
          toolName: started.toolId,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          policy: {
            decision: 'ALLOW',
            reason: policy.reason,
            riskCategory: typeof started.metadata?.riskCategory === 'string'
              ? started.metadata.riskCategory as ToolRiskCategory
              : 'workspace_read',
            grantMatched: started.metadata?.permissionGrantMatched === true
          },
          result
        })
      });

      if (result.ok) {
        dispatchedInvocationIds.push(started.invocationId);
      } else {
        failedInvocationIds.push(started.invocationId);
      }
    }

    return {
      dispatchedInvocationIds,
      approvalBlockedInvocationIds,
      deniedInvocationIds,
      failedInvocationIds
    };
  }
}
