import { useEffect, useState } from "react";
import type {
  GlobalPermissionGrant,
  McpServerConfig,
  McpServerStatus,
  McpToolSummary,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  SkillConflict,
  SkillRecord,
  TaskDetail,
  TaskEvent,
  TaskMemory,
  UserPreferences
} from "@scc/shared";
import { api } from "./api.js";

export interface WorkbenchData {
  tasks: TaskDetail[];
  selected: TaskDetail | null;
  selectedId: string | null;
  memories: TaskMemory[];
  patterns: PatternRecord[];
  skills: SkillRecord[];
  skillConflicts: SkillConflict[];
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  reflections: ReflectionSession[];
  projectMemories: ProjectMemory[];
  mcpServers: Array<McpServerConfig & { status: McpServerStatus }>;
  mcpTools: McpToolSummary[];
  realtimeConnected: boolean;
  busy: boolean;
  error: string | null;
  refresh: (nextId?: string | null) => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  runTaskAction: (action: () => Promise<TaskDetail>) => Promise<void>;
  runSideAction: (action: () => Promise<unknown>) => Promise<void>;
}

export function useWorkbenchData(): WorkbenchData {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [memories, setMemories] = useState<TaskMemory[]>([]);
  const [patterns, setPatterns] = useState<PatternRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillConflicts, setSkillConflicts] = useState<SkillConflict[]>([]);
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [reflections, setReflections] = useState<ReflectionSession[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [mcpServers, setMcpServers] = useState<Array<McpServerConfig & { status: McpServerStatus }>>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(nextId = selectedId) {
    const [
      list,
      nextMemories,
      nextPatterns,
      nextSkills,
      nextSkillConflicts,
      nextPermissions,
      nextPreferences,
      nextReflections,
      nextProjectMemories,
      nextMcpServers,
      nextMcpTools
    ] = await Promise.all([
      api.listTasks(),
      api.listTaskMemories(),
      api.listPatterns(),
      api.listSkills(),
      api.listSkillConflicts(),
      api.listGlobalPermissions(),
      api.getPreferences(),
      api.listReflections(),
      api.listProjectMemories(),
      api.listMcpServers(),
      api.listMcpTools()
    ]);
    setTasks(list);
    const id = nextId ?? list[0]?.id ?? null;
    setSelectedId(id);
    setSelected(id ? await api.getTask(id) : null);
    setMemories(nextMemories);
    setPatterns(nextPatterns);
    setSkills(nextSkills);
    setSkillConflicts(nextSkillConflicts);
    setPermissions(nextPermissions);
    setPreferences(nextPreferences);
    setReflections(nextReflections);
    setProjectMemories(nextProjectMemories);
    setMcpServers(nextMcpServers);
    setMcpTools(nextMcpTools);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), realtimeConnected ? 6000 : 2000);
    return () => window.clearInterval(timer);
  }, [realtimeConnected]);

  useEffect(() => {
    if (!selectedId) return;
    const ws = new WebSocket(api.taskEventsWebSocketUrl(selectedId));
    ws.onopen = () => setRealtimeConnected(true);
    ws.onclose = () => setRealtimeConnected(false);
    ws.onerror = () => setRealtimeConnected(false);
    ws.onmessage = (message) => {
      const parsed = parseRealtimeMessage(message.data);
      if (!parsed) return;
      setSelected((current) => {
        if (!current || current.id !== selectedId) return current;
        if (parsed.type === "snapshot") return { ...current, events: parsed.events };
        if (current.events.some((event) => event.id === parsed.event.id)) return current;
        return { ...current, events: [...current.events, parsed.event], updatedAt: parsed.event.createdAt };
      });
    };
    return () => ws.close();
  }, [selectedId]);

  async function selectTask(taskId: string) {
    setSelectedId(taskId);
    setSelected(await api.getTask(taskId));
  }

  async function runTaskAction(action: () => Promise<TaskDetail>) {
    await run(async () => {
      const task = await action();
      setSelectedId(task.id);
      setSelected(task);
      await refresh(task.id);
    });
  }

  async function runSideAction(action: () => Promise<unknown>) {
    await run(async () => {
      await action();
      await refresh(selectedId);
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    tasks,
    selected,
    selectedId,
    memories,
    patterns,
    skills,
    skillConflicts,
    permissions,
    preferences,
    reflections,
    projectMemories,
    mcpServers,
    mcpTools,
    realtimeConnected,
    busy,
    error,
    refresh,
    selectTask,
    runTaskAction,
    runSideAction
  };
}

function parseRealtimeMessage(value: unknown):
  | { type: "snapshot"; events: TaskEvent[] }
  | { type: "event"; event: TaskEvent }
  | null {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    if (parsed["type"] === "snapshot" && Array.isArray(parsed["events"])) {
      return { type: "snapshot", events: parsed["events"] as TaskEvent[] };
    }
    if (parsed["type"] === "event" && typeof parsed["event"] === "object" && parsed["event"]) {
      return { type: "event", event: parsed["event"] as TaskEvent };
    }
    return null;
  } catch {
    return null;
  }
}
