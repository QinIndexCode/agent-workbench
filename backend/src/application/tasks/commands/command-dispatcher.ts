import { ResolveApprovalInput, SubmitTaskCommandInput, TaskActionResponse } from '../types';
import {
  TaskApprovalCommandHandler,
  TaskCommandDispatcher,
  TaskLifecycleCommandHandler,
  TaskOperatorInteractionHandler
} from './command-handler-types';

export class CommandDispatcher implements TaskCommandDispatcher {
  constructor(
    private readonly lifecycle: TaskLifecycleCommandHandler,
    private readonly operator: TaskOperatorInteractionHandler,
    private readonly approvals: TaskApprovalCommandHandler
  ) {}

  async dispatch(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse> {
    if (input.type === 'START_TASK') {
      return this.lifecycle.startTask({
        taskId: input.taskId,
        userMessage: input.message ?? undefined,
        autoRun: input.autoRun,
        maxTurns: input.maxTurns,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata
      });
    }
    if (input.type === 'CONTINUE_TASK') {
      return this.lifecycle.continueTask({
        taskId: input.taskId,
        userMessage: input.message ?? undefined,
        autoRun: input.autoRun,
        maxTurns: input.maxTurns,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata
      });
    }
    if (input.type === 'PAUSE_TASK') {
      return this.lifecycle.pauseTask({
        taskId: input.taskId,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata
      }, commandId);
    }
    if (input.type === 'RESUME_TASK') {
      return this.lifecycle.resumeTask({
        taskId: input.taskId,
        userMessage: input.message ?? undefined,
        autoRun: input.autoRun,
        maxTurns: input.maxTurns,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata
      });
    }
    if (input.type === 'RESTART_TASK') {
      return this.lifecycle.restartTask({
        taskId: input.taskId,
        userMessage: input.message ?? undefined,
        autoRun: input.autoRun,
        maxTurns: input.maxTurns,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata
      });
    }
    if (input.type === 'SEND_OPERATOR_MESSAGE') {
      return this.operator.sendOperatorMessage(input, commandId);
    }
    if (input.type === 'RESOLVE_APPROVAL') {
      if (!input.invocationId || !input.approvalStatus) {
        throw new Error('backend_new task error: approval command requires invocationId and approvalStatus.');
      }
      return this.approvals.resolveToolApproval({
        taskId: input.taskId,
        invocationId: input.invocationId,
        status: input.approvalStatus,
        grantedBy: input.actor ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata
      } satisfies ResolveApprovalInput);
    }
    if (input.type === 'INTERRUPT_TASK') {
      return this.operator.interruptTask(input, commandId);
    }
    if (input.type === 'APPLY_ARTIFACTS') {
      return this.operator.applyArtifacts(input, commandId);
    }
    if (input.type === 'CANCEL_TASK') {
      return this.lifecycle.cancelTask(input, commandId);
    }
    throw new Error(`backend_new task error: unsupported command type "${input.type}".`);
  }
}
