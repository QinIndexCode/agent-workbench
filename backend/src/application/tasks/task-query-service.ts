import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import {
  OperatorCommandRecord,
  OperatorMessageRecord
} from '../../foundation/repository';
import {
  TaskDebugResponse,
  TaskDiagnosticsSummary,
  TaskDiscussionResponse,
  TaskQueryResponse,
  TaskSummaryResponse,
  TaskToolingResponse,
  TaskTraceEnvelope
} from './types';
import { TaskRecordService } from './task-record-service';
import { LoggedEnvelope } from '../../foundation/logging/types';
import { TaskPlannerService } from './planning/task-planner-service';
import { buildTaskExecutionSummary } from './task-execution-observability';
import { ConversationMessageRecord } from '../../foundation/conversation/types';
import {
  readAcceptanceSemanticReview,
  TaskAcceptanceSemanticReviewService
} from './task-acceptance-semantic-review';

function isUserVisibleDiscussionMessage(message: ConversationMessageRecord): boolean {
  if (message.visibility !== 'public') {
    return false;
  }
  if (message.role === 'system' || message.role === 'tool' || message.role === 'runtime') {
    return false;
  }
  if (message.role === 'assistant') {
    return !/\[[A-Z0-9_-]+_OUTPUT\]/.test(message.content)
      && !/"current_unit"\s*:/.test(message.content)
      && !/"tool_name"\s*:/.test(message.content)
      && !/"files_created"\s*:/.test(message.content);
  }
  return true;
}

export class TaskQueryService {
  private readonly records: TaskRecordService;
  private readonly planner: TaskPlannerService;
  private readonly acceptanceSemanticReview: TaskAcceptanceSemanticReviewService;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.records = new TaskRecordService(foundation);
    this.planner = new TaskPlannerService();
    this.acceptanceSemanticReview = new TaskAcceptanceSemanticReviewService(foundation);
  }

  async getTask(taskId: string): Promise<TaskQueryResponse> {
    const task = await this.records.buildTaskQuery(taskId);
    const planner = this.planner.summarizeTurn(task.definition, task.runtime);
    task.runtime.planner = planner.planner;
    task.runtime.activeStage = planner.activeStage;
    return task;
  }

  async listTasks(includeArchived = false): Promise<TaskSummaryResponse[]> {
    return this.records.listTasks(includeArchived);
  }

  async getTaskEvents(taskId: string, afterEventId?: string) {
    if (afterEventId?.trim()) {
      return this.foundation.events.listAfter(taskId, afterEventId);
    }
    return this.foundation.events.list(taskId);
  }

  async getTaskCommands(taskId: string): Promise<OperatorCommandRecord[]> {
    return this.foundation.commands.listLatest(taskId);
  }

  async getTaskOperatorMessages(taskId: string): Promise<OperatorMessageRecord[]> {
    return this.foundation.operatorMessages.listLatest(taskId);
  }

  async getTaskDiscussion(taskId: string): Promise<TaskDiscussionResponse> {
    const task = await this.records.buildTaskQuery(taskId);
    return {
      taskId,
      conversations: task.conversations.filter(isUserVisibleDiscussionMessage),
      operatorMessages: await this.foundation.operatorMessages.listLatest(taskId)
    };
  }

  async getTaskTooling(taskId: string): Promise<TaskToolingResponse> {
    return {
      taskId,
      pendingApprovals: await this.foundation.approvals.listLatest(taskId),
      toolInvocations: await this.foundation.toolInvocations.listLatest(taskId)
    };
  }

  async getTaskTraces(taskId: string): Promise<TaskTraceEnvelope[]> {
    const tracePath = this.foundation.layout.forTask(taskId).traceLogPath;
    if (!await this.foundation.storage.exists(tracePath)) {
      return [];
    }
    const content = await this.foundation.storage.readText(tracePath, this.foundation.config.storage.encoding);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as LoggedEnvelope<Record<string, unknown>>);
  }

  async getTaskDebug(taskId: string): Promise<TaskDebugResponse> {
    const [task, initialMetadata, session, queue] = await Promise.all([
      this.records.buildTaskQuery(taskId, { includeInternalConversations: true }),
      this.foundation.taskMetadata.get(taskId),
      this.foundation.taskRuntimes.get(taskId),
      this.foundation.queue?.get(taskId) ?? Promise.resolve(null)
    ]);
    let metadata = initialMetadata;
    const cachedSemanticReview = readAcceptanceSemanticReview(metadata);
    let executionSummary = buildTaskExecutionSummary(task, this.foundation, {
      semanticReview: cachedSemanticReview
    });
    const reviewed = await this.acceptanceSemanticReview.maybeReview({
      task,
      metadataRecord: metadata,
      executionSummary
    });
    if (reviewed) {
      metadata = reviewed.metadataRecord;
      executionSummary = buildTaskExecutionSummary(task, this.foundation, {
        semanticReview: reviewed.semanticReview
      });
    }
    return {
      task,
      metadata,
      runtimeRecord: session,
      queue,
      executionSummary
    };
  }

  async getRecentAnalysis(taskId: string) {
    const events = await this.foundation.events.list(taskId);
    return events.slice(-20);
  }

  async getDiagnosticsSummary(): Promise<TaskDiagnosticsSummary> {
    const runtimes = await this.foundation.taskRuntimes.list();
    const totals = {
      tasks: runtimes.length,
      submitted: 0,
      running: 0,
      paused: 0,
      failed: 0,
      completed: 0,
      cancelled: 0
    };
    const recoverableTaskIds: string[] = [];

    for (const record of runtimes) {
      const status = record.runtime.lifecycleStatus;
      if (status === 'SUBMITTED') totals.submitted += 1;
      if (status === 'RUNNING') totals.running += 1;
      if (status === 'PAUSED') totals.paused += 1;
      if (status === 'FAILED') totals.failed += 1;
      if (status === 'COMPLETED') totals.completed += 1;
      if (status === 'CANCELLED') totals.cancelled += 1;

      const queueItem = this.foundation.queue ? await this.foundation.queue.get(record.taskId) : null;
      if (status === 'PAUSED' || status === 'FAILED' || queueItem?.state === 'DEAD_LETTER') {
        recoverableTaskIds.push(record.taskId);
      }
    }

    return { totals, recoverableTaskIds };
  }

  async listRecoverableTasks(): Promise<TaskSummaryResponse[]> {
    const summaries = await this.records.listTasks(false);
    const recoverable = await this.getDiagnosticsSummary();
    const allowed = new Set(recoverable.recoverableTaskIds);
    return summaries.filter(summary => allowed.has(summary.taskId));
  }
}
