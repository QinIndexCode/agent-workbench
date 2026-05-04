import type { RuntimeEvent, TaskDetail } from '../types';

type EventHandler = (event: RuntimeEvent) => void;
type SnapshotHandler = (snapshot: { taskId?: string; task: TaskDetail }) => void;
export type RealtimeTransportMode = 'live' | 'reconnecting' | 'polling' | 'blocked';
export type RealtimeTransportStatus = {
  connected: boolean;
  taskId?: string;
  mode: RealtimeTransportMode;
  reason?: string;
  latestEventId?: string | null;
};
type StatusHandler = (status: RealtimeTransportStatus) => void;
type FetchEvents = (taskId: string, afterEventId?: string) => Promise<RuntimeEvent[]>;

const backendHttpUrl = import.meta.env.VITE_BACKEND_SERVER_URL ?? 'http://127.0.0.1:3011';
const websocketUrl = (() => {
  try {
    const url = new URL(backendHttpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'ws://127.0.0.1:3011/ws';
  }
})();

const MAX_TRACKED_TASK_CURSORS = 64;
const MAX_TRACKED_EVENT_IDS_PER_TASK = 500;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private eventHandlers: Set<EventHandler> = new Set();
  private snapshotHandlers: Set<SnapshotHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private subscribedTaskId: string | null = null;
  private latestEventIdByTask: Map<string, string> = new Map();
  private emittedEventIdsByTask: Map<string, Set<string>> = new Map();
  private shouldReconnect = true;
  private readonly fetchEvents?: FetchEvents;
  private readonly pollingIntervalMs: number;

  constructor(options?: { fetchEvents?: FetchEvents; pollingIntervalMs?: number }) {
    this.fetchEvents = options?.fetchEvents;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 3000;
  }

  connect() {
    this.shouldReconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    try {
      const socket = new WebSocket(websocketUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) {
          return;
        }
        this.stopPolling();
        this.emitStatus({
          connected: true,
          taskId: this.subscribedTaskId || undefined,
          mode: 'live',
          latestEventId: this.getLatestEventId(this.subscribedTaskId)
        });

        if (this.subscribedTaskId) {
          this.subscribe(this.subscribedTaskId);
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) {
          return;
        }
        try {
          const data = JSON.parse(event.data);
          
          if (data.kind === 'runtime_event' && data.data) {
            this.emitRuntimeEvent(data.data);
          }

          if (data.kind === 'task_snapshot' && data.task) {
            this.snapshotHandlers.forEach(handler => handler({
              taskId: data.taskId,
              task: data.task,
            }));
          }

          if (data.kind === 'subscribed') {
            if (typeof data.taskId === 'string') {
              if (typeof data.latestEventId === 'string') {
                this.latestEventIdByTask.set(data.taskId, data.latestEventId);
              }
              this.rememberTaskTracking(data.taskId);
            }
          }
        } catch {
          // Silently ignore parse errors to avoid flooding logs
        }
      };

      socket.onclose = () => {
        if (this.ws !== socket) {
          return;
        }
        this.emitStatus({
          connected: false,
          taskId: this.subscribedTaskId || undefined,
          mode: 'reconnecting',
          reason: 'WebSocket disconnected; reconnecting with the last event cursor.',
          latestEventId: this.getLatestEventId(this.subscribedTaskId)
        });
        if (this.shouldReconnect) {
          this.scheduleReconnect();
          this.startPolling('WebSocket disconnected; polling task events until live transport resumes.');
        }
      };

      socket.onerror = () => {
        if (this.ws !== socket) {
          return;
        }
        this.emitStatus({
          connected: false,
          taskId: this.subscribedTaskId || undefined,
          mode: this.fetchEvents ? 'polling' : 'blocked',
          reason: this.fetchEvents
            ? 'WebSocket error; using REST event polling while reconnecting.'
            : 'WebSocket error and no REST polling client is configured.',
          latestEventId: this.getLatestEventId(this.subscribedTaskId)
        });
        this.startPolling('WebSocket error; using REST event polling while reconnecting.');
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
          this.ws.close();
        }
      };
    } catch {
      if (this.shouldReconnect) {
        this.emitStatus({
          connected: false,
          taskId: this.subscribedTaskId || undefined,
          mode: this.fetchEvents ? 'polling' : 'blocked',
          reason: this.fetchEvents
            ? 'WebSocket connection failed; using REST event polling.'
            : 'WebSocket connection failed and no REST polling client is configured.',
          latestEventId: this.getLatestEventId(this.subscribedTaskId)
        });
        this.scheduleReconnect();
        this.startPolling('WebSocket connection failed; using REST event polling.');
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  subscribe(taskId: string) {
    this.subscribedTaskId = taskId;
    const afterEventId = this.getLatestEventId(taskId);

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
      this.startPolling('Waiting for WebSocket connection; polling task events with cursor.');
      return;
    }
    
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        taskId,
        replay: true,
        afterEventId: afterEventId ?? undefined,
      }));
      this.emitStatus({
        connected: true,
        taskId,
        mode: 'live',
        latestEventId: afterEventId
      });
    } else {
      this.startPolling('WebSocket is not open yet; polling task events with cursor.');
    }
  }

  unsubscribe(taskId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        taskId,
      }));
    }

    if (this.subscribedTaskId === taskId) {
      this.subscribedTaskId = null;
    }
    this.emittedEventIdsByTask.delete(taskId);
    this.stopPolling();
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: RealtimeTransportStatus) {
    this.statusHandlers.forEach(handler => handler(status));
  }

  private getLatestEventId(taskId: string | null): string | null {
    return taskId ? this.latestEventIdByTask.get(taskId) ?? null : null;
  }

  private rememberTaskTracking(taskId: string): void {
    const latestEventId = this.latestEventIdByTask.get(taskId);
    if (latestEventId !== undefined) {
      this.latestEventIdByTask.delete(taskId);
      this.latestEventIdByTask.set(taskId, latestEventId);
    }

    const emittedEventIds = this.emittedEventIdsByTask.get(taskId);
    if (emittedEventIds) {
      this.emittedEventIdsByTask.delete(taskId);
      this.emittedEventIdsByTask.set(taskId, emittedEventIds);
    }

    this.trimTaskTracking();
  }

  private trimTaskTracking(): void {
    while (this.latestEventIdByTask.size > MAX_TRACKED_TASK_CURSORS) {
      const oldestTaskId = [...this.latestEventIdByTask.keys()].find((candidate) => candidate !== this.subscribedTaskId);
      if (!oldestTaskId) {
        break;
      }
      this.latestEventIdByTask.delete(oldestTaskId);
      this.emittedEventIdsByTask.delete(oldestTaskId);
    }

    while (this.emittedEventIdsByTask.size > MAX_TRACKED_TASK_CURSORS) {
      const oldestTaskId = [...this.emittedEventIdsByTask.keys()].find((candidate) => candidate !== this.subscribedTaskId);
      if (!oldestTaskId) {
        break;
      }
      this.emittedEventIdsByTask.delete(oldestTaskId);
    }
  }

  private trimSeenEvents(seen: Set<string>): void {
    while (seen.size > MAX_TRACKED_EVENT_IDS_PER_TASK) {
      const oldestEventId = seen.keys().next().value;
      if (!oldestEventId) {
        break;
      }
      seen.delete(oldestEventId);
    }
  }

  private markEventSeen(event: RuntimeEvent): boolean {
    const seen = this.emittedEventIdsByTask.get(event.taskId) ?? new Set<string>();
    if (seen.has(event.eventId)) {
      return false;
    }
    seen.add(event.eventId);
    this.trimSeenEvents(seen);
    this.emittedEventIdsByTask.set(event.taskId, seen);
    this.latestEventIdByTask.set(event.taskId, event.eventId);
    this.rememberTaskTracking(event.taskId);
    return true;
  }

  private emitRuntimeEvent(event: RuntimeEvent) {
    if (!this.markEventSeen(event)) {
      return;
    }
    this.eventHandlers.forEach(handler => handler(event));
    this.emitStatus({
      connected: this.ws?.readyState === WebSocket.OPEN,
      taskId: event.taskId,
      mode: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'polling',
      latestEventId: event.eventId
    });
  }

  private startPolling(reason: string) {
    if (!this.fetchEvents || !this.subscribedTaskId || this.pollingTimer) {
      return;
    }
    const poll = async () => {
      const taskId = this.subscribedTaskId;
      if (!taskId || !this.fetchEvents || !this.shouldReconnect) {
        this.stopPolling();
        return;
      }
      try {
        const afterEventId = this.getLatestEventId(taskId) ?? undefined;
        const events = await this.fetchEvents(taskId, afterEventId);
        events.forEach((event) => this.emitRuntimeEvent(event));
        this.emitStatus({
          connected: this.ws?.readyState === WebSocket.OPEN,
          taskId,
          mode: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'polling',
          reason,
          latestEventId: this.getLatestEventId(taskId)
        });
      } catch (error) {
        this.emitStatus({
          connected: false,
          taskId,
          mode: 'blocked',
          reason: error instanceof Error ? error.message : 'REST event polling failed.',
          latestEventId: this.getLatestEventId(taskId)
        });
      }
      if (this.subscribedTaskId === taskId && this.shouldReconnect && this.ws?.readyState !== WebSocket.OPEN) {
        this.pollingTimer = setTimeout(poll, this.pollingIntervalMs);
      } else {
        this.pollingTimer = null;
      }
    };
    this.emitStatus({
      connected: false,
      taskId: this.subscribedTaskId,
      mode: 'polling',
      reason,
      latestEventId: this.getLatestEventId(this.subscribedTaskId)
    });
    this.pollingTimer = setTimeout(poll, 0);
  }

  private stopPolling() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPolling();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.latestEventIdByTask.clear();
    this.emittedEventIdsByTask.clear();
  }
}
