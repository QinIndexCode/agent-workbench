import type { RuntimeEvent, TaskDetail } from '../types';

type EventHandler = (event: RuntimeEvent) => void;
type SnapshotHandler = (snapshot: { taskId?: string; task: TaskDetail }) => void;
type StatusHandler = (status: { connected: boolean; taskId?: string }) => void;

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

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventHandlers: Set<EventHandler> = new Set();
  private snapshotHandlers: Set<SnapshotHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private subscribedTaskId: string | null = null;
  private shouldReconnect = true;

  constructor() {}

  connect() {
    this.shouldReconnect = true;
    try {
      this.ws = new WebSocket(websocketUrl);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected');
        this.emitStatus({ connected: true, taskId: this.subscribedTaskId || undefined });

        if (this.subscribedTaskId) {
          this.subscribe(this.subscribedTaskId);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.kind === 'runtime_event' && data.data) {
            this.eventHandlers.forEach(handler => handler(data.data));
          }

          if (data.kind === 'task_snapshot' && data.task) {
            this.snapshotHandlers.forEach(handler => handler({
              taskId: data.taskId,
              task: data.task,
            }));
          }

          if (data.kind === 'subscribed') {
            console.log(`[WebSocket] Subscribed to ${data.taskId}`);
          }
        } catch (error) {
          console.error('[WebSocket] Parse error:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('[WebSocket] Disconnected');
        this.emitStatus({ connected: false });
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.emitStatus({ connected: false, taskId: this.subscribedTaskId || undefined });
      };
    } catch (error) {
      if (this.shouldReconnect) {
        console.warn('[WebSocket] Connection failed');
        this.scheduleReconnect();
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

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
      return;
    }
    
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        taskId,
        replay: true,
      }));
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

  private emitStatus(status: { connected: boolean; taskId?: string }) {
    this.statusHandlers.forEach(handler => handler(status));
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
