import { EventEmitter } from 'node:events';
import { RuntimeEventRecord } from '../repository';

type TaskEventListener = (event: RuntimeEventRecord) => void;
type TaskSnapshotListener = (taskId: string) => void;

export class RuntimeEventHub {
  private readonly emitter = new EventEmitter();

  publish(event: RuntimeEventRecord): void {
    this.emitter.emit(`task:${event.taskId}`, event);
  }

  subscribe(taskId: string, listener: TaskEventListener): () => void {
    const eventName = `task:${taskId}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }
}

export class TaskSnapshotHub {
  private readonly emitter = new EventEmitter();

  publish(taskId: string): void {
    this.emitter.emit(`task:${taskId}`, taskId);
  }

  subscribe(taskId: string, listener: TaskSnapshotListener): () => void {
    const eventName = `task:${taskId}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }
}
