import { HttpRouteModule } from '../route-types';
import { sendJson } from '../utils';

export const queueRoutes: HttpRouteModule = {
  async handle({ runtime, request, response, segments, path }) {
    if (request.method === 'GET' && path === '/queue/dead-letters') {
      sendJson(response, 200, await runtime.worker.listDeadLetters());
      return true;
    }

    if (request.method === 'GET' && path === '/queue/active') {
      sendJson(response, 200, await runtime.worker.listActiveQueueItems());
      return true;
    }

    if (request.method === 'POST' && path === '/queue/recover-expired') {
      sendJson(response, 200, { recovered: await runtime.worker.recoverExpiredQueueLeases() });
      return true;
    }

    if (request.method === 'POST' && segments[0] === 'queue' && segments[1] === 'dead-letters' && segments[2] && segments[3] === 'requeue') {
      sendJson(response, 200, { ok: await runtime.worker.requeueDeadLetter(segments[2]) });
      return true;
    }

    return false;
  }
};
