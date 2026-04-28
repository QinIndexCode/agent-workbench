import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { OperatorCommandService } from '../control/operator-command-service';
import { TaskQueryService } from '../task-query-service';
import { TaskRecordService } from '../task-record-service';
import { TaskTurnRunner } from '../task-turn-runner';
import { ToolDispatchOrchestrator } from '../tools/tool-dispatch-orchestrator';
import { InterruptController } from '../control/interrupt-controller';
import { SubmitTaskCommandInput, TaskActionResponse } from '../types';
import { ApprovalCommandHandler } from '../commands/approval-command-handler';
import { CommandDispatcher } from '../commands/command-dispatcher';
import { TaskCommandHandlerServices } from '../commands/command-handler-types';
import { LifecycleCommandHandler } from '../commands/lifecycle-command-handler';
import { OperatorCommandHandler } from '../commands/operator-command-handler';

export class TaskCommandExecutor {
  private readonly dispatcher: CommandDispatcher;

  constructor(
    foundation: BackendNewFoundation,
    records: TaskRecordService,
    private readonly queries: TaskQueryService,
    turns: TaskTurnRunner,
    toolDispatch: ToolDispatchOrchestrator,
    interrupts: InterruptController,
    private readonly commands: OperatorCommandService
  ) {
    const services: TaskCommandHandlerServices = {
      foundation,
      records,
      queries,
      turns,
      toolDispatch,
      interrupts,
      commands
    };
    this.dispatcher = new CommandDispatcher(
      new LifecycleCommandHandler(services),
      new OperatorCommandHandler(services),
      new ApprovalCommandHandler(services)
    );
  }

  private async executeRecordedCommand(
    input: SubmitTaskCommandInput,
    handler: (commandId: string) => Promise<TaskActionResponse>
  ): Promise<TaskActionResponse> {
    const command = this.commands.createAcceptedRecord(input);
    await this.commands.appendAccepted(command);
    try {
      const result = await handler(command.commandId);
      await this.commands.appendApplied(command, {
        lifecycleStatus: result.task.runtime.lifecycleStatus,
        ...(result.commandMetadata ?? {})
      });
      const task = await this.commandsTaskTruth(input.taskId, result.task);
      return {
        ...result,
        task
      };
    } catch (error) {
      await this.commands.appendRejected(
        command,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async submitCommand(input: SubmitTaskCommandInput): Promise<TaskActionResponse> {
    return this.executeRecordedCommand(input, async (commandId) => this.dispatcher.dispatch(input, commandId));
  }

  private async commandsTaskTruth(taskId: string, fallback: TaskActionResponse['task']): Promise<TaskActionResponse['task']> {
    try {
      return await this.commandsTaskQuery(taskId);
    } catch {
      return fallback;
    }
  }

  private async commandsTaskQuery(taskId: string): Promise<TaskActionResponse['task']> {
    return this.queries.getTask(taskId);
  }
}
