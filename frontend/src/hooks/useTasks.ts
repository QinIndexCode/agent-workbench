import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import type { TaskSummary, TaskDetail, RuntimeEvent } from '../types';

function toTaskSummary(task: TaskDetail): TaskSummary {
  return {
    taskId: task.definition.taskId,
    title: task.definition.title,
    intent: task.definition.intent,
    lifecycleStatus: task.runtime.lifecycleStatus,
    isArchived: task.isArchived,
    canArchive: task.canArchive,
    canDelete: task.canDelete,
    currentUnitId: task.runtime.currentUnitId,
    updatedAt: task.runtime.updatedAt ?? Date.now(),
    queueState: task.queue?.state ?? null,
    pendingApprovalCount: task.pendingApprovalItems?.length ?? task.pendingApprovals?.length ?? 0,
    lastError: task.diagnostics?.lastError ?? null,
    isDelegatedChild: false,
  };
}

function mergeEvents(previous: RuntimeEvent[], next: RuntimeEvent[]): RuntimeEvent[] {
  const byId = new Map<string, RuntimeEvent>();
  for (const event of previous) {
    byId.set(event.eventId, event);
  }
  for (const event of next) {
    byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function useTasks(options?: { includeArchived?: boolean }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const includeArchived = options?.includeArchived ?? false;
  const requestSequence = useRef(0);

  const loadTasks = useCallback(async () => {
    const currentRequest = requestSequence.current + 1;
    requestSequence.current = currentRequest;
    try {
      setLoading(true);
      setError(null);
      const data = await api.getTasks(includeArchived);
      if (requestSequence.current !== currentRequest) {
        return;
      }
      setTasks(data);
    } catch (err) {
      if (requestSequence.current !== currentRequest) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      if (requestSequence.current === currentRequest) {
        setLoading(false);
      }
    }
  }, [includeArchived]);

  useEffect(() => {
    loadTasks();
    return () => {
      requestSequence.current += 1;
    };
  }, [loadTasks]);

  const applyTaskSnapshot = useCallback((task: TaskDetail) => {
    const nextSummary = toTaskSummary(task);
    setTasks((previous) => {
      const existingIndex = previous.findIndex((entry) => entry.taskId === nextSummary.taskId);
      if (nextSummary.isArchived && !includeArchived) {
        return existingIndex >= 0
          ? previous.filter((entry) => entry.taskId !== nextSummary.taskId)
          : previous;
      }
      if (existingIndex < 0) {
        return [nextSummary, ...previous].sort((left, right) => right.updatedAt - left.updatedAt);
      }
      const updated = [...previous];
      updated[existingIndex] = nextSummary;
      updated.sort((left, right) => right.updatedAt - left.updatedAt);
      return updated;
    });
  }, [includeArchived]);

  return { tasks, loading, error, reload: loadTasks, applyTaskSnapshot };
}

export function useTaskDetail(taskId: string | null) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadTask = useCallback(async () => {
    if (!taskId) {
      requestSequence.current += 1;
      setTask(null);
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }

    const currentRequest = requestSequence.current + 1;
    requestSequence.current = currentRequest;

    try {
      setLoading(true);
      setError(null);
      const [taskData, eventsData] = await Promise.all([
        api.getTask(taskId),
        api.getTaskEvents(taskId),
      ]);
      if (requestSequence.current !== currentRequest) {
        return;
      }
      setTask(taskData);
      setEvents((previous) => mergeEvents(previous.filter((event) => event.taskId === taskId), eventsData));
    } catch (err) {
      if (requestSequence.current !== currentRequest) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      if (requestSequence.current === currentRequest) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    loadTask();
  }, [loadTask]);

  const applySnapshot = useCallback((snapshot: TaskDetail) => {
    requestSequence.current += 1;
    setLoading(false);
    setError(null);
    setTask(snapshot);
    setEvents((previous) => mergeEvents(previous.filter((event) => event.taskId === snapshot.definition.taskId), Array.isArray(snapshot.events) ? snapshot.events : []));
  }, []);

  const appendEvent = useCallback((event: RuntimeEvent) => {
    setEvents(prev => mergeEvents(prev, [event]));
    
    if (event.type === 'TASK_STARTED' || event.type === 'TASK_COMPLETED' || 
        event.type === 'TASK_FAILED' || event.type === 'TASK_PAUSED') {
      loadTask();
    }
  }, [loadTask]);

  return { task, events, loading, error, reload: loadTask, appendEvent, applySnapshot };
}
