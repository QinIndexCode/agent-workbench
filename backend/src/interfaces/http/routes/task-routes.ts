import { BackendNewRuntime } from '../../../application/create-runtime';
import {
  ApprovalResolutionRequest,
  RuntimeEventStreamEnvelope,
  TaskActionRequest,
  TaskCommandRequest,
  TaskSubmitRequest
} from '../types';
import { HttpRouteModule } from '../route-types';
import { readJsonBody, sendJson } from '../utils';

function toSseEnvelope(record: Awaited<ReturnType<BackendNewRuntime['tasks']['getTaskEvents']>>[number]): RuntimeEventStreamEnvelope {
  return {
    id: record.eventId,
    event: record.type,
    data: record
  };
}

function sendSse(response: import('node:http').ServerResponse, envelopes: RuntimeEventStreamEnvelope[]): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  for (const envelope of envelopes) {
    response.write(`id: ${envelope.id}\n`);
    response.write(`event: ${envelope.event}\n`);
    response.write(`data: ${JSON.stringify(envelope.data)}\n\n`);
  }
}

export const taskRoutes: HttpRouteModule = {
  async handle({ runtime, request, response, url, path, segments }) {
    if (request.method === 'POST' && path === '/tasks') {
      const body = await readJsonBody<TaskSubmitRequest>(request);
      sendJson(response, 200, await runtime.tasks.submitTask(body));
      return true;
    }

    if (request.method === 'GET' && path === '/tasks') {
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      sendJson(response, 200, await runtime.tasks.listTasks(includeArchived));
      return true;
    }

    if (request.method === 'GET' && path === '/tasks/diagnostics') {
      sendJson(response, 200, await runtime.tasks.getDiagnosticsSummary());
      return true;
    }

    if (request.method === 'GET' && path === '/tasks/recoverable') {
      sendJson(response, 200, await runtime.tasks.listRecoverableTasks());
      return true;
    }

    if (segments[0] !== 'tasks' || !segments[1]) {
      return false;
    }

    const taskId = segments[1];

    if (request.method === 'GET' && segments.length === 2) {
      sendJson(response, 200, await runtime.tasks.getTask(taskId));
      return true;
    }

    if (request.method === 'DELETE' && segments.length === 2) {
      sendJson(response, 200, await runtime.tasks.deleteTask(taskId));
      return true;
    }

    if (request.method === 'POST' && segments[2] === 'archive' && segments.length === 3) {
      sendJson(response, 200, await runtime.tasks.archiveTask(taskId));
      return true;
    }

    if (request.method === 'POST' && segments[2] === 'unarchive' && segments.length === 3) {
      sendJson(response, 200, await runtime.tasks.unarchiveTask(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'events' && segments.length === 3) {
      sendJson(response, 200, await runtime.tasks.getTaskEvents(taskId, url.searchParams.get('afterEventId') ?? undefined));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'discussion') {
      sendJson(response, 200, await runtime.tasks.getTaskDiscussion(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'tooling') {
      sendJson(response, 200, await runtime.tasks.getTaskTooling(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'traces') {
      sendJson(response, 200, await runtime.tasks.getTaskTraces(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'debug') {
      sendJson(response, 200, await runtime.tasks.getTaskDebug(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'recent-analysis') {
      sendJson(response, 200, await runtime.tasks.getRecentAnalysis(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'commands' && segments.length === 3) {
      sendJson(response, 200, await runtime.tasks.getTaskCommands(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'operator-messages' && segments.length === 3) {
      sendJson(response, 200, await runtime.tasks.getTaskOperatorMessages(taskId));
      return true;
    }

    if (request.method === 'GET' && segments[2] === 'events' && segments[3] === 'stream') {
      if (!runtime.config.server.enableSseFallback) {
        sendJson(response, 404, { error: 'SSE fallback is disabled.' });
        return true;
      }
      const afterEventId = url.searchParams.get('afterEventId') ?? undefined;
      const events = await runtime.tasks.getTaskEvents(taskId, afterEventId);
      sendSse(response, events.map(toSseEnvelope));
      const unsubscribe = runtime.tasks.subscribeTaskEvents(taskId, (event) => {
        const envelope = toSseEnvelope(event);
        response.write(`id: ${envelope.id}\n`);
        response.write(`event: ${envelope.event}\n`);
        response.write(`data: ${JSON.stringify(envelope.data)}\n\n`);
      });
      request.on('close', unsubscribe);
      return true;
    }

      if (request.method === 'POST' && ['start', 'continue', 'pause', 'resume', 'restart'].includes(segments[2] ?? '')) {
        const body = await readJsonBody<Omit<TaskActionRequest, 'taskId'>>(request);
        const actionInput = {
          taskId,
          userMessage: body.userMessage,
          autoRun: body.autoRun,
          maxTurns: body.maxTurns,
          actor: body.actor,
          reason: body.reason,
          metadata: body.metadata
        };
      if (segments[2] === 'start') {
        sendJson(response, 200, await runtime.tasks.startTask(actionInput));
        return true;
      }
      if (segments[2] === 'continue') {
        sendJson(response, 200, await runtime.tasks.continueTask(actionInput));
        return true;
      }
      if (segments[2] === 'pause') {
        sendJson(response, 200, await runtime.tasks.pauseTask(actionInput));
        return true;
      }
      if (segments[2] === 'resume') {
        sendJson(response, 200, await runtime.tasks.resumeTask(actionInput));
        return true;
      }
      if (segments[2] === 'restart') {
        sendJson(response, 200, await runtime.tasks.restartTask(actionInput));
        return true;
      }
    }

    if (request.method === 'POST' && segments[2] === 'commands' && segments.length === 3) {
      const body = await readJsonBody<TaskCommandRequest>(request);
      sendJson(response, 200, await runtime.tasks.submitCommand({
        taskId,
        type: body.type,
        actor: body.actor,
        reason: body.reason,
        message: body.message,
        invocationId: body.invocationId,
        approvalStatus: body.approvalStatus,
        metadata: body.metadata
      }));
      return true;
    }

    if (request.method === 'POST' && segments[2] === 'approvals' && segments[3] === 'resolve') {
      const body = await readJsonBody<Omit<ApprovalResolutionRequest, 'taskId'>>(request);
      sendJson(response, 200, await runtime.tasks.resolveToolApproval({
        taskId,
        invocationId: body.invocationId,
        status: body.status,
        grantedBy: body.grantedBy,
        reason: body.reason,
        metadata: body.metadata
      }));
      return true;
    }

    return false;
  }
};
