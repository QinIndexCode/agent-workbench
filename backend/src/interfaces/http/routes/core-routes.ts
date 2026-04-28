import { HttpRouteModule } from '../route-types';
import { sendJson } from '../utils';

export const coreRoutes: HttpRouteModule = {
  async handle({ runtime, request, path, response }) {
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, await runtime.platform.getConfigHealth());
      return true;
    }

    if (request.method === 'GET' && path === '/ready') {
      const startup = await runtime.platform.getSystemStartup();
      const queueReady = startup.queue.enabled ? startup.queue.workerEnabled : null;
      sendJson(response, 200, {
        ok:
          startup.database.healthy === false
            ? false
            : queueReady === false
              ? false
              : true,
        databaseReady: startup.database.healthy,
        queueReady
      });
      return true;
    }

    if (request.method === 'GET' && path === '/memory/profile') {
      sendJson(response, 200, await runtime.platform.getUserPreferenceProfile());
      return true;
    }

    if (request.method === 'GET' && path === '/statistics') {
      sendJson(response, 200, await runtime.platform.getStatistics());
      return true;
    }

    if (request.method === 'GET' && path === '/statistics/metrics') {
      sendJson(response, 200, await runtime.platform.getMetrics());
      return true;
    }

    if (request.method === 'GET' && path === '/system/startup') {
      sendJson(response, 200, await runtime.platform.getSystemStartup());
      return true;
    }

    if (request.method === 'GET' && path === '/system/metrics') {
      sendJson(response, 200, await runtime.platform.getMetrics());
      return true;
    }

    return false;
  }
};
