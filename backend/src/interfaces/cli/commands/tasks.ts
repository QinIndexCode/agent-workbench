import { WebSocket } from 'ws';
import {
  CliCommandModule,
  requestJson,
  resolveTaskSubmitPayload,
  runTaskFlowStream,
  submitTaskPayload,
  TaskCommandRequest,
  TaskCommandsQueryResponse,
  TaskEventsQueryResponse,
  TaskOperatorMessagesQueryResponse,
  TaskQueryApiResponse,
  TaskListApiResponse,
  getAfterEventId,
  getFlagString,
  hasFlag,
  requestTaskDebug,
  summarizeTask,
  writeJson,
  writeJsonLine
} from '../shared';
import { projectTaskDiagnostics } from '../chat/protocol/diagnostics-projection';
import { runTaskChatSession } from './tasks-chat';

function getOptionalPositiveIntFlag(args: Parameters<typeof getFlagString>[0], name: string): number | undefined {
  const value = getFlagString(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const tasksCommandModule: CliCommandModule = {
  group: 'tasks',
  usage: [
    'tasks list|get|inspect|status|submit|run|chat|start|continue|pause|resume|restart|apply',
    'tasks archive|unarchive|delete|interrupt|cancel|message|commands|operator-messages|events|watch|stream|tail',
    'tasks approve <taskId> <invocationId> <APPROVED|REJECTED|EXPIRED>',
    'tasks discussion|tooling|traces|debug|recent-analysis <taskId>',
    'tasks diagnostics',
    'tasks recoverable'
  ],
  async handle(action, rest, context) {
    const { fetchImpl, io, serverUrl, args, createWebSocket, sleep } = context;

    if (action === 'chat') {
      return runTaskChatSession(context, args, rest, context.stdin);
    }

    if (action === 'list') {
      const includeArchived = hasFlag(args, 'include-archived');
      const listUrl = includeArchived ? `${serverUrl}/tasks?includeArchived=true` : `${serverUrl}/tasks`;
      writeJson(io, await requestJson<TaskListApiResponse>(fetchImpl, listUrl, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'get' || action === 'inspect') {
      writeJson(io, await requestJson<TaskQueryApiResponse>(fetchImpl, `${serverUrl}/tasks/${rest[0]}`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'status') {
      const response = await requestJson<TaskQueryApiResponse>(fetchImpl, `${serverUrl}/tasks/${rest[0]}`, { method: 'GET', headers: {} });
      const debug = await requestTaskDebug(fetchImpl, serverUrl, rest[0]);
      writeJson(io, summarizeTask(response, debug));
      return 0;
    }
    if (action === 'submit') {
      writeJson(io, await submitTaskPayload(fetchImpl, serverUrl, resolveTaskSubmitPayload(rest, args)));
      return 0;
    }
    if (action === 'run') {
      const payload = resolveTaskSubmitPayload(rest, args);
      const submitted = await submitTaskPayload(fetchImpl, serverUrl, payload);
      const modeFlag = getFlagString(args, 'mode') ?? 'watch';
      const mode = ['watch', 'stream', 'tail'].includes(modeFlag) ? modeFlag as 'watch' | 'stream' | 'tail' : 'watch';
      const submittedPayload = {
        submitted: true,
        taskId: submitted.command.taskId,
        preferredProviderId: payload.preferredProviderId ?? null,
        mode
      };
      if (mode === 'stream') writeJsonLine(io, submittedPayload);
      else writeJson(io, submittedPayload);

      if (!hasFlag(args, 'no-start')) {
        const taskId = submitted.command.taskId;
        await requestJson(fetchImpl, `${serverUrl}/tasks/${taskId}/start`, {
          method: 'POST',
          body: JSON.stringify({
            userMessage: getFlagString(args, 'message'),
            autoRun: !hasFlag(args, 'no-auto-run'),
            maxTurns: getOptionalPositiveIntFlag(args, 'max-turns')
          })
        });
        await runTaskFlowStream({
          taskId,
          context: { ...context, createWebSocket: createWebSocket ?? ((url) => new WebSocket(url) as any), sleep },
          mode
        });
      }
      return 0;
    }
    if (action === 'events') {
      const url = new URL(`/tasks/${rest[0]}/events`, serverUrl);
      const afterEventId = getAfterEventId(args);
      if (afterEventId) url.searchParams.set('afterEventId', afterEventId);
      writeJson(io, await requestJson<TaskEventsQueryResponse>(fetchImpl, url.toString(), { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'commands') {
      writeJson(io, await requestJson<TaskCommandsQueryResponse>(fetchImpl, `${serverUrl}/tasks/${rest[0]}/commands`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'operator-messages') {
      writeJson(io, await requestJson<TaskOperatorMessagesQueryResponse>(fetchImpl, `${serverUrl}/tasks/${rest[0]}/operator-messages`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'watch' || action === 'stream' || action === 'tail') {
      await runTaskFlowStream({
        taskId: rest[0],
        context: { ...context, createWebSocket: createWebSocket ?? ((url) => new WebSocket(url) as any), sleep },
        mode: action
      });
      return 0;
    }
    if (action === 'approve') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/approvals/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          invocationId: rest[1],
          status: rest[2],
          grantedBy: getFlagString(args, 'granted-by'),
          reason: getFlagString(args, 'reason') ?? null
        })
      }));
      return 0;
    }
    if (action === 'message') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'SEND_OPERATOR_MESSAGE',
          actor: getFlagString(args, 'actor') ?? null,
          reason: getFlagString(args, 'reason') ?? null,
          message: getFlagString(args, 'message') ?? null
        } satisfies TaskCommandRequest)
      }));
      return 0;
    }
    if (action === 'archive' || action === 'unarchive') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/${action}`, {
        method: 'POST',
        body: JSON.stringify({})
      }));
      return 0;
    }
    if (action === 'delete') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}`, {
        method: 'DELETE',
        headers: {}
      }));
      return 0;
    }
    if (action === 'apply') {
      const destinationDir = rest[1] ?? getFlagString(args, 'output-dir') ?? null;
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'APPLY_ARTIFACTS',
          actor: getFlagString(args, 'actor') ?? null,
          reason: getFlagString(args, 'reason') ?? null,
          message: destinationDir,
          metadata: {
            destinationDir,
            overwrite: hasFlag(args, 'overwrite')
          }
        } satisfies TaskCommandRequest)
      }));
      return 0;
    }
    if (action === 'interrupt' || action === 'cancel') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          type: action === 'interrupt' ? 'INTERRUPT_TASK' : 'CANCEL_TASK',
          actor: getFlagString(args, 'actor') ?? null,
          reason: getFlagString(args, 'reason') ?? null,
          message: getFlagString(args, 'message') ?? null
        } satisfies TaskCommandRequest)
      }));
      return 0;
    }
    if (['start', 'continue', 'pause', 'resume', 'restart'].includes(action ?? '')) {
      const supportsAutoRun = action === 'start' || action === 'continue' || action === 'restart';
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          userMessage: getFlagString(args, 'message'),
          autoRun: supportsAutoRun && hasFlag(args, 'auto-run') ? true : undefined,
          maxTurns: supportsAutoRun ? getOptionalPositiveIntFlag(args, 'max-turns') : undefined
        })
      }));
      return 0;
    }
    if (action === 'discussion' || action === 'tooling' || action === 'traces' || action === 'debug' || action === 'recent-analysis') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/${rest[0]}/${action}`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'diagnostics') {
      if (rest[0]) {
        const debug = await requestTaskDebug(fetchImpl, serverUrl, rest[0]);
        writeJson(io, projectTaskDiagnostics(debug.task, debug));
        return 0;
      }
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/diagnostics`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'recoverable') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tasks/recoverable`, { method: 'GET', headers: {} }));
      return 0;
    }
    return null;
  }
};
