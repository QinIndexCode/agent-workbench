import http from 'node:http';
import { URL } from 'node:url';
import { BackendNewRuntime } from '../../application/create-runtime';
import { attachBackendNewWebSocketServer } from '../ws/server';
import { HttpRouteModule } from './route-types';
import {
  applyCorsHeaders,
  isControlPlaneRequestAuthorized,
  isTrustedBrowserOrigin,
  sendJson
} from './utils';
import { coreRoutes } from './routes/core-routes';
import { platformRoutes } from './routes/platform-routes';
import { queueRoutes } from './routes/queue-routes';
import { taskRoutes } from './routes/task-routes';

const ROUTES: HttpRouteModule[] = [
  coreRoutes,
  queueRoutes,
  taskRoutes,
  platformRoutes
];

export function createBackendNewHttpServer(runtime: BackendNewRuntime): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      applyCorsHeaders(request, response);

      if (!request.url || !request.method) {
        sendJson(response, 400, { error: 'Invalid request.' });
        return;
      }

      if (request.method === 'OPTIONS') {
        if (request.headers.origin && !isTrustedBrowserOrigin(request, request.headers.origin)) {
          sendJson(response, 403, {
            error: 'backend_new http auth error: origin is not allowed to access the local control plane.'
          });
          return;
        }
        response.statusCode = 204;
        response.end();
        return;
      }

      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const segments = path.split('/').filter(Boolean);

      if (!['/health', '/ready'].includes(path) && !isControlPlaneRequestAuthorized(request)) {
        sendJson(response, 403, {
          error:
            'backend_new http auth error: control-plane requests must originate from loopback or present BACKEND_NEW_CONTROL_API_TOKEN.'
        });
        return;
      }

      for (const route of ROUTES) {
        const handled = await route.handle({
          runtime,
          request,
          response,
          url,
          path,
          segments
        });
        if (handled) {
          return;
        }
      }

      sendJson(response, 404, { error: 'Route not found.' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode =
        typeof (error as Error & { statusCode?: number }).statusCode === 'number'
          ? (error as Error & { statusCode: number }).statusCode
          : 500;
      const code =
        typeof (error as Error & { code?: string }).code === 'string'
          ? (error as Error & { code: string }).code
          : 'internal_error';
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Unknown error.',
        code,
        statusCode
      });
    }
  });
  attachBackendNewWebSocketServer(server, runtime);
  return server;
}
