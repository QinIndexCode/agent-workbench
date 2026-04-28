import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { BackendNewRuntime } from '../../application/create-runtime';
import { RuntimeEventRecord } from '../../foundation/repository';
import {
  RuntimeWebSocketClientMessage,
  RuntimeWebSocketEnvelope
} from '../http/types';
import { isControlPlaneRequestAuthorized } from '../http/utils';

type SubscriptionMap = Map<string, () => void>;

const HEARTBEAT_INTERVAL_MS = 15_000;

function sendEnvelope(socket: WebSocket, envelope: RuntimeWebSocketEnvelope): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(envelope));
  }
}

function toEventEnvelope(record: RuntimeEventRecord): RuntimeWebSocketEnvelope {
  return {
    kind: 'runtime_event',
    taskId: record.taskId,
    event: record.type,
    data: record
  };
}

async function sendTaskSnapshot(
  runtime: BackendNewRuntime,
  socket: WebSocket,
  taskId: string
): Promise<void> {
  const task = await runtime.tasks.getTask(taskId);
  sendEnvelope(socket, {
    kind: 'task_snapshot',
    taskId,
    task,
    timestamp: Date.now()
  });
}

async function subscribeTask(
  runtime: BackendNewRuntime,
  socket: WebSocket,
  subscriptions: SubscriptionMap,
  taskId: string,
  replay: boolean,
  afterEventId?: string | null
): Promise<void> {
  if (subscriptions.has(taskId)) {
    return;
  }

  if (replay) {
    const existing = afterEventId?.trim()
      ? await runtime.tasks.getTaskEvents(taskId, afterEventId)
      : await runtime.tasks.getTaskEvents(taskId);
    for (const event of existing) {
      sendEnvelope(socket, toEventEnvelope(event));
    }
    await sendTaskSnapshot(runtime, socket, taskId);
    sendEnvelope(socket, {
      kind: 'subscribed',
      taskId,
      latestEventId: existing.at(-1)?.eventId ?? afterEventId ?? null
    });
  } else {
    await sendTaskSnapshot(runtime, socket, taskId);
    sendEnvelope(socket, {
      kind: 'subscribed',
      taskId,
      latestEventId: afterEventId ?? null
    });
  }

  const unsubscribeEvent = runtime.tasks.subscribeTaskEvents(taskId, (event) => {
    sendEnvelope(socket, toEventEnvelope(event));
  });
  const unsubscribeSnapshot = runtime.foundationRef.snapshotHub.subscribe(taskId, () => {
    void sendTaskSnapshot(runtime, socket, taskId).catch(() => {
      // Keep the runtime stream alive even if the snapshot fetch fails temporarily.
    });
  });
  subscriptions.set(taskId, () => {
    unsubscribeEvent();
    unsubscribeSnapshot();
  });
}

function unsubscribeTask(socket: WebSocket, subscriptions: SubscriptionMap, taskId: string): void {
  const unsubscribe = subscriptions.get(taskId);
  if (!unsubscribe) {
    return;
  }
  unsubscribe();
  subscriptions.delete(taskId);
  sendEnvelope(socket, {
    kind: 'unsubscribed',
    taskId
  });
}

export function attachBackendNewWebSocketServer(server: http.Server, runtime: BackendNewRuntime): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== runtime.config.server.websocketPath) {
      socket.destroy();
      return;
    }
    if (!isControlPlaneRequestAuthorized(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket, request) => {
    const subscriptions: SubscriptionMap = new Map();
    const url = new URL(request.url ?? '/', 'http://localhost');
    const initialTaskId = url.searchParams.get('taskId');
    const replay = url.searchParams.get('replay') !== 'false';
    const afterEventId = url.searchParams.get('afterEventId');

    const heartbeat = setInterval(() => {
      sendEnvelope(socket, {
        kind: 'heartbeat',
        timestamp: Date.now()
      });
    }, HEARTBEAT_INTERVAL_MS);

    sendEnvelope(socket, {
      kind: 'ready',
      timestamp: Date.now()
    });
    if (initialTaskId) {
      void subscribeTask(runtime, socket, subscriptions, initialTaskId, replay, afterEventId).catch((error) => {
        sendEnvelope(socket, {
          kind: 'error',
          code: 'subscribe_failed',
          error: error instanceof Error ? error.message : 'Failed to subscribe.'
        });
      });
    }

    socket.on('message', (data) => {
      let payload: RuntimeWebSocketClientMessage | Record<string, unknown>;
      try {
        payload = JSON.parse(String(data));
      } catch {
        sendEnvelope(socket, {
          kind: 'error',
          code: 'invalid_payload',
          error: 'Invalid websocket payload.'
        });
        return;
      }

      if (payload.type === 'ping') {
        sendEnvelope(socket, {
          kind: 'heartbeat',
          timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now()
        });
        return;
      }

      if (!('taskId' in payload) || typeof payload.taskId !== 'string' || !payload.taskId.trim()) {
        sendEnvelope(socket, {
          kind: 'error',
          code: 'missing_task_id',
          error: 'taskId is required.'
        });
        return;
      }

      if (payload.type === 'subscribe') {
        const replayAfterEventId = typeof payload.afterEventId === 'string' ? payload.afterEventId : undefined;
        void subscribeTask(runtime, socket, subscriptions, payload.taskId, payload.replay !== false, replayAfterEventId).catch((error) => {
          sendEnvelope(socket, {
            kind: 'error',
            code: 'subscribe_failed',
            error: error instanceof Error ? error.message : 'Failed to subscribe.'
          });
        });
        return;
      }

      if (payload.type === 'unsubscribe') {
        unsubscribeTask(socket, subscriptions, payload.taskId);
        return;
      }

      if (payload.type === 'command') {
        const command = payload.command as RuntimeWebSocketClientMessage extends infer T
          ? T extends { type: 'command'; command: infer C } ? C : never
          : never;
        void runtime.tasks.submitCommand({
          taskId: payload.taskId,
          type: command.type,
          actor: command.actor,
          reason: command.reason,
          message: command.message,
          invocationId: command.invocationId,
          approvalStatus: command.approvalStatus,
          metadata: command.metadata
        }).catch((error) => {
          sendEnvelope(socket, {
            kind: 'error',
            code: 'subscribe_failed',
            error: error instanceof Error ? error.message : 'Failed to execute command.'
          });
        });
        return;
      }

      sendEnvelope(socket, {
        kind: 'error',
        code: 'unsupported_message_type',
        error: `Unsupported websocket message type "${payload.type ?? 'unknown'}".`
      });
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
    });

    socket.on('error', () => {
      clearInterval(heartbeat);
    });
  });

  return wss;
}
