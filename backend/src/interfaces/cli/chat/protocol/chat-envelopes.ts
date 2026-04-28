import { TaskEventsQueryResponse } from '../../shared';

export type ChatOutputFormat = 'human' | 'ndjson';

export type CliViewMode = 'summary' | 'capabilities' | 'diagnostics' | 'events' | 'approvals' | 'raw' | 'tasks';

export interface CliTranscriptEntry {
  kind: 'user' | 'system' | 'event' | 'error';
  text: string;
  timestamp: number;
}

export interface CliInspectorSnapshot {
  activeTask: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  approvals: Array<Record<string, unknown>>;
  viewMode: CliViewMode;
  recentTaskIds: string[];
  selectedApprovalIndex: number;
  lastViewPayload: unknown;
}

export interface CliRecentTaskItem {
  taskId: string;
  title: string;
  lifecycleStatus: string;
  currentUnitId: string | null;
  updatedAt: number;
  pendingApprovalCount: number;
  isActive: boolean;
  isRecent: boolean;
}

export interface WorkspaceChatSessionState {
  mode: 'workspace' | 'task';
  activeTaskId: string | null;
  recentTaskIds: string[];
  recentTasks: CliRecentTaskItem[];
  inputDraft: string;
  viewMode: CliViewMode;
  eventCursorByTaskId: Record<string, string | null>;
  recentEvents: TaskEventsQueryResponse[number][];
  latestTaskSummary: Record<string, unknown> | null;
  latestDiagnostics: Record<string, unknown> | null;
  latestApprovals: Array<Record<string, unknown>>;
  selectedApprovalIndex: number;
  transcript: CliTranscriptEntry[];
  lastViewPayload: unknown;
}

export type BaseChatEnvelope =
  | { type: 'session'; action: 'attached' | 'created' | 'detached' | 'closed'; taskId: string | null; message: string }
  | { type: 'task'; task: Record<string, unknown> }
  | { type: 'event'; record: TaskEventsQueryResponse[number] }
  | { type: 'info'; message: string }
  | { type: 'prompt'; prompt: string }
  | { type: 'diagnostics'; taskId: string; data: unknown }
  | { type: 'approvals'; taskId: string; count: number; approvals: Array<Record<string, unknown>> };

export type WorkspaceChatEnvelope =
  | BaseChatEnvelope
  | { type: 'view'; view: 'tasks' | 'focus' | 'clear' | 'raw' | 'capabilities'; data: unknown };

export type TaskChatEnvelope = BaseChatEnvelope;

export function formatEventLine(record: TaskEventsQueryResponse[number]): string {
  const payload = record.payload ?? {};
  const message = typeof payload.message === 'string' ? payload.message : null;
  const commandType = typeof payload.commandType === 'string' ? payload.commandType : null;
  const stageIndex = typeof payload.stageIndex === 'number' ? payload.stageIndex : null;
  const blockingReason = typeof payload.blockingReason === 'string' ? payload.blockingReason : null;
  const toolName = typeof payload.toolId === 'string' ? payload.toolId : typeof payload.toolName === 'string' ? payload.toolName : null;
  const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : null;
  const fragments: string[] = [record.type];
  if (commandType) fragments.push(commandType);
  if (stageIndex !== null) fragments.push(`stage=${stageIndex}`);
  if (toolName) fragments.push(`tool=${toolName}`);
  if (invocationId) fragments.push(`invocation=${invocationId}`);
  if (blockingReason) fragments.push(`blocked=${blockingReason}`);
  if (message) fragments.push(`msg=${message.length > 48 ? `${message.slice(0, 45)}...` : message}`);
  fragments.push(record.taskId);
  return fragments.join(' ');
}
