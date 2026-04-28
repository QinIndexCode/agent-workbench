import {
  ResolveApprovalInput,
  SubmitTaskCommandInput,
  SubmitTaskInput,
  TaskDebugResponse,
  TaskDiagnosticsSummary,
  TaskDiscussionResponse,
  TaskActionInput,
  TaskQueryResponse,
  TaskSummaryResponse,
  TaskToolingResponse,
  TaskTraceEnvelope
} from '../../application/tasks';
import {
  ConfigStateView,
  ComplexTaskAcceptanceReport,
  ImprovementProposal,
  PlatformActionResult,
  PlatformAuditTrailView,
  PlatformMetricsView,
  PlatformStatisticsView,
  PlatformSystemView,
  ProviderProfileView,
  ProviderSecretSummary,
  ProviderTestResult,
  RealTaskArchiveEntry,
  WorkspaceWorkflowView
} from '../../application/platform';
import { OperatorCommandRecord, OperatorMessageRecord, QueueItemRecord, RuntimeEventRecord } from '../../foundation/repository';

export type TaskSubmitRequest = SubmitTaskInput;
export type TaskActionRequest = TaskActionInput;
export type ApprovalResolutionRequest = ResolveApprovalInput;
export type TaskCommandRequest = Omit<SubmitTaskCommandInput, 'taskId'>;
export type TaskQueryApiResponse = TaskQueryResponse;
export type TaskListApiResponse = TaskSummaryResponse[];
export type TaskEventsQueryResponse = RuntimeEventRecord[];
export type TaskCommandsQueryResponse = OperatorCommandRecord[];
export type TaskOperatorMessagesQueryResponse = OperatorMessageRecord[];
export type TaskDiscussionApiResponse = TaskDiscussionResponse;
export type TaskToolingApiResponse = TaskToolingResponse;
export type TaskTracesApiResponse = TaskTraceEnvelope[];
export type TaskDiagnosticsApiResponse = TaskDiagnosticsSummary;
export type TaskDebugApiResponse = TaskDebugResponse;
export type QueueActiveResponse = QueueItemRecord[];
export type QueueDeadLetterResponse = QueueItemRecord[];
export type ProviderListResponse = ProviderProfileView[];
export type ProviderSecretListResponse = ProviderSecretSummary[];
export type ProviderTestResponse = ProviderTestResult;
export type McpListResponse = import('../../application/platform').McpCatalogEntry[];
export type McpTestResponse = import('../../application/platform').McpTestResult;
export type ConfigStateResponse = ConfigStateView;
export type ConfigActionResponse = PlatformActionResult<ConfigStateView>;
export type StatisticsResponse = PlatformStatisticsView;
export type MetricsResponse = PlatformMetricsView;
export type SystemResponse = PlatformSystemView;
export type PlatformAuditTrailResponse = PlatformAuditTrailView;
export type WorkspaceWorkflowResponse = WorkspaceWorkflowView;
export type ImprovementProposalListResponse = ImprovementProposal[];
export type ImprovementProposalResponse = ImprovementProposal;
export type RealTaskArchiveResponse = RealTaskArchiveEntry[];
export type ComplexTaskAcceptanceReportResponse = ComplexTaskAcceptanceReport;

export interface HealthResponse {
  ok: boolean;
  storageDriver: 'file' | 'postgres';
  databaseHealthy: boolean | null;
  queueEnabled: boolean;
  workerEnabled: boolean;
}

export interface ReadinessResponse {
  ok: boolean;
  databaseReady: boolean | null;
  queueReady: boolean | null;
}

export interface QueueRecoverExpiredResponse {
  recovered: number;
}

export interface QueueRequeueResponse {
  ok: boolean;
}

export interface RuntimeEventStreamEnvelope {
  id: string;
  event: string;
  data: RuntimeEventRecord;
}

export type RuntimeWebSocketErrorCode =
  | 'missing_task_id'
  | 'invalid_payload'
  | 'unsupported_message_type'
  | 'subscribe_failed';

export interface RuntimeWebSocketEnvelope {
  kind: 'runtime_event' | 'task_snapshot' | 'subscribed' | 'unsubscribed' | 'error' | 'ready' | 'heartbeat';
  taskId?: string;
  event?: string;
  data?: RuntimeEventRecord;
  task?: TaskQueryApiResponse;
  error?: string;
  code?: RuntimeWebSocketErrorCode;
  timestamp?: number;
  latestEventId?: string | null;
}

export type RuntimeWebSocketClientMessage =
  | {
    type: 'subscribe';
    taskId: string;
    replay?: boolean;
    afterEventId?: string;
  }
  | {
    type: 'unsubscribe';
    taskId: string;
  }
  | {
    type: 'ping';
    timestamp?: number;
  }
  | {
    type: 'command';
    taskId: string;
    command: TaskCommandRequest;
  };
