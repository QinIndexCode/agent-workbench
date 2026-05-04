import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { RuntimeEventHub } from '../../../foundation/projection/event-hub';
import {
  ResolveApprovalInput,
  SubmitTaskCommandInput,
  SubmitTaskInput,
  TaskActionInput,
  TaskActionResponse,
  TaskArchiveResponse,
  TaskDiagnosticsSummary,
  TaskDebugResponse,
  TaskDiscussionResponse,
  TaskGuidanceInput,
  TaskGuidanceRecord,
  TaskQueryResponse,
  TaskSummaryResponse,
  TaskToolingResponse,
  TaskTraceEnvelope
} from '../types';
import { TaskLifecycleService } from './task-lifecycle-service';
import { TaskQueryService } from '../task-query-service';
import { TaskDeletionService } from './task-deletion-service';
import { TaskArchiveService } from './task-archive-service';

export class BackendNewTaskApplication {
  private readonly lifecycle: TaskLifecycleService;
  private readonly queries: TaskQueryService;
  private readonly deletion: TaskDeletionService;
  private readonly archive: TaskArchiveService;
  private readonly eventHub: RuntimeEventHub;

  constructor(foundation: BackendNewFoundation) {
    this.lifecycle = new TaskLifecycleService(foundation);
    this.queries = new TaskQueryService(foundation);
    this.deletion = new TaskDeletionService(foundation);
    this.archive = new TaskArchiveService(foundation);
    this.eventHub = foundation.eventHub;
  }

  async submitTask(input: SubmitTaskInput): Promise<TaskActionResponse> {
    return this.lifecycle.submitTask(input);
  }

  async startTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.lifecycle.startTask(input);
  }

  async continueTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.lifecycle.continueTask(input);
  }

  async submitGuidance(input: TaskGuidanceInput): Promise<TaskActionResponse> {
    return this.lifecycle.submitGuidance(input);
  }

  async pauseTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.lifecycle.pauseTask(input);
  }

  async resumeTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.lifecycle.resumeTask(input);
  }

  async restartTask(input: TaskActionInput): Promise<TaskActionResponse> {
    return this.lifecycle.restartTask(input);
  }

  async deleteTask(taskId: string) {
    return this.deletion.deleteTask(taskId);
  }

  async archiveTask(taskId: string): Promise<TaskArchiveResponse> {
    return this.archive.archiveTask(taskId);
  }

  async unarchiveTask(taskId: string): Promise<TaskArchiveResponse> {
    return this.archive.unarchiveTask(taskId);
  }

  async resolveToolApproval(input: ResolveApprovalInput): Promise<TaskActionResponse> {
    return this.lifecycle.resolveToolApproval(input);
  }

  async submitCommand(input: SubmitTaskCommandInput): Promise<TaskActionResponse> {
    return this.lifecycle.submitCommand(input);
  }

  async getTask(taskId: string): Promise<TaskQueryResponse> {
    return this.queries.getTask(taskId);
  }

  async listTasks(includeArchived = false): Promise<TaskSummaryResponse[]> {
    return this.queries.listTasks(includeArchived);
  }

  async getTaskEvents(taskId: string, afterEventId?: string) {
    return this.queries.getTaskEvents(taskId, afterEventId);
  }

  async getTaskCommands(taskId: string) {
    return this.queries.getTaskCommands(taskId);
  }

  async getTaskOperatorMessages(taskId: string) {
    return this.queries.getTaskOperatorMessages(taskId);
  }

  async getTaskGuidance(taskId: string): Promise<TaskGuidanceRecord[]> {
    return this.queries.getTaskGuidance(taskId);
  }

  async getTaskDiscussion(taskId: string): Promise<TaskDiscussionResponse> {
    return this.queries.getTaskDiscussion(taskId);
  }

  async getTaskTooling(taskId: string): Promise<TaskToolingResponse> {
    return this.queries.getTaskTooling(taskId);
  }

  async getTaskTraces(taskId: string): Promise<TaskTraceEnvelope[]> {
    return this.queries.getTaskTraces(taskId);
  }

  async getTaskDebug(taskId: string): Promise<TaskDebugResponse> {
    return this.queries.getTaskDebug(taskId);
  }

  async getRecentAnalysis(taskId: string) {
    return this.queries.getRecentAnalysis(taskId);
  }

  async getDiagnosticsSummary(): Promise<TaskDiagnosticsSummary> {
    return this.queries.getDiagnosticsSummary();
  }

  async listRecoverableTasks(): Promise<TaskSummaryResponse[]> {
    return this.queries.listRecoverableTasks();
  }

  subscribeTaskEvents(taskId: string, listener: Parameters<RuntimeEventHub['subscribe']>[1]): () => void {
    return this.eventHub.subscribe(taskId, listener);
  }
}
