import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { createRuntimeEventEnvelope } from '../../../foundation/projection/event-envelope';
import { createTaskRuntimeState } from '../../../domain/runtime/state-transition-applier';
import { createTaskDefinition } from '../task-definition';
import { TaskCommandExecutor } from './task-command-executor';
import { TaskQueryService } from '../task-query-service';
import { TaskRecordService } from '../task-record-service';
import { TaskTurnRunner } from '../task-turn-runner';
import { ToolDispatchOrchestrator } from '../tools/tool-dispatch-orchestrator';
import { InterruptController } from '../control/interrupt-controller';
import { OperatorCommandService } from '../control/operator-command-service';
import { TaskPlannerService } from '../planning/task-planner-service';
import { ResolveApprovalInput, SubmitTaskCommandInput, SubmitTaskInput, TaskActionInput, TaskActionResponse } from '../types';
import { runWorkspaceHooks } from '../../runtime/workspace-hook-runner';

function now(): number {
  return Date.now();
}

export class TaskLifecycleService {
  private readonly records: TaskRecordService;
  private readonly queries: TaskQueryService;
  private readonly commandExecutor: TaskCommandExecutor;
  private readonly planner: TaskPlannerService;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.records = new TaskRecordService(foundation);
    this.queries = new TaskQueryService(foundation);
    this.planner = new TaskPlannerService();

    const interrupts = new InterruptController();
    const commands = new OperatorCommandService(foundation);
    const toolDispatch = new ToolDispatchOrchestrator(
      foundation.config,
      foundation.extensions,
      foundation.toolExecutors,
      foundation.toolInvocations,
      foundation.approvals,
      foundation.events,
      foundation.logs
    );
    const turns = new TaskTurnRunner(foundation, this.records, toolDispatch, interrupts, commands);

    this.commandExecutor = new TaskCommandExecutor(
      foundation,
      this.records,
      this.queries,
      turns,
      toolDispatch,
      interrupts,
      commands
    );
  }

  async submitTask(input: SubmitTaskInput): Promise<TaskActionResponse> {
    await this.foundation.logs.initialize();
    const definition = createTaskDefinition(input);
    this.planner.assertValidPlan(definition);
    const runtime = createTaskRuntimeState(definition);
    const createdAt = now();

    await this.records.saveTaskRuntimeRecord({
      definition,
      runtime,
      activeProviderId: definition.preferredProviderId
    });
    await this.foundation.tasks.save({
      taskId: definition.taskId,
      status: runtime.lifecycleStatus,
      currentUnitId: runtime.currentUnitId,
      updatedAt: createdAt,
      payload: {
        title: definition.title,
        intent: definition.intent
      }
    });
    await this.foundation.taskMetadata.save({
      taskId: definition.taskId,
      createdAt,
      updatedAt: createdAt,
      latestSessionId: null,
      selectedProviderId: definition.preferredProviderId,
      labels: [],
      metadata: {
        title: definition.title
      }
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: 'corr_task_submitted',
        sessionId: 'sess_task_submitted',
        turnId: 'turn_task_submitted',
        taskId: definition.taskId,
        unitId: runtime.currentUnitId,
        checkpointId: null,
        type: 'TASK_SUBMITTED',
        payload: {
          title: definition.title,
          intent: definition.intent
        }
      })
    );
    await runWorkspaceHooks({
      foundation: this.foundation,
      event: 'task.created',
      taskId: definition.taskId,
      unitId: runtime.currentUnitId,
      correlationId: 'corr_task_submitted',
      sessionId: 'sess_task_submitted',
      turnId: 'turn_task_submitted',
      metadata: {
        title: definition.title,
        intent: definition.intent
      }
    });
    return {
      command: this.records.createCommandResult(definition.taskId, runtime.lifecycleStatus, 'Task submitted.'),
      task: await this.queries.getTask(definition.taskId)
    };
  }

  async startTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'START_TASK',
      actor: input.actor,
      reason: input.reason,
      message: input.userMessage,
      metadata: input.metadata
    });
  }

  async continueTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'CONTINUE_TASK',
      actor: input.actor,
      reason: input.reason,
      message: input.userMessage,
      metadata: input.metadata
    });
  }

  async pauseTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'PAUSE_TASK',
      actor: input.actor,
      reason: input.reason,
      message: input.userMessage,
      metadata: input.metadata
    });
  }

  async resumeTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'RESUME_TASK',
      actor: input.actor,
      reason: input.reason,
      message: input.userMessage,
      metadata: input.metadata
    });
  }

  async restartTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'RESTART_TASK',
      actor: input.actor,
      reason: input.reason,
      message: input.userMessage,
      metadata: input.metadata
    });
  }

  async resolveToolApproval(input: ResolveApprovalInput): Promise<TaskActionResponse> {
    return this.submitCommand({
      taskId: input.taskId,
      type: 'RESOLVE_APPROVAL',
      actor: input.grantedBy ?? null,
      reason: input.reason ?? null,
      invocationId: input.invocationId,
      approvalStatus: input.status,
      metadata: input.metadata
    });
  }

  async submitCommand(input: SubmitTaskCommandInput): Promise<TaskActionResponse> {
    return this.commandExecutor.submitCommand(input);
  }
}
