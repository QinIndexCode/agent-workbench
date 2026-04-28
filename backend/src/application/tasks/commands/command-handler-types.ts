import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { InterruptController } from '../control/interrupt-controller';
import { OperatorCommandService } from '../control/operator-command-service';
import { TaskQueryService } from '../task-query-service';
import { TaskRecordService } from '../task-record-service';
import { TaskTurnRunner } from '../task-turn-runner';
import { ToolDispatchOrchestrator } from '../tools/tool-dispatch-orchestrator';
import { ResolveApprovalInput, SubmitTaskCommandInput, TaskActionInput, TaskActionResponse } from '../types';

export interface TaskCommandHandlerServices {
  foundation: BackendNewFoundation;
  records: TaskRecordService;
  queries: TaskQueryService;
  turns: TaskTurnRunner;
  toolDispatch: ToolDispatchOrchestrator;
  interrupts: InterruptController;
  commands: OperatorCommandService;
}

export interface TaskCommandDispatcher {
  dispatch(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse>;
}

export interface TaskLifecycleCommandHandler {
  startTask(input: TaskActionInput): Promise<TaskActionResponse>;
  continueTask(input: TaskActionInput): Promise<TaskActionResponse>;
  pauseTask(input: TaskActionInput, commandId: string | null): Promise<TaskActionResponse>;
  resumeTask(input: TaskActionInput): Promise<TaskActionResponse>;
  restartTask(input: TaskActionInput): Promise<TaskActionResponse>;
  cancelTask(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse>;
}

export interface TaskOperatorInteractionHandler {
  sendOperatorMessage(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse>;
  interruptTask(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse>;
  applyArtifacts(input: SubmitTaskCommandInput, commandId: string): Promise<TaskActionResponse>;
}

export interface TaskApprovalCommandHandler {
  resolveToolApproval(input: ResolveApprovalInput): Promise<TaskActionResponse>;
}
