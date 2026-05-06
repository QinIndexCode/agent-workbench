import { useEffect, useRef, useState } from "react";
import type {
  GlobalPermissionGrant,
  KnowledgeItem,
  McpServerConfig,
  McpServerStatus,
  McpToolSummary,
  ModelProviderRecord,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  SkillConflict,
  SkillDuplicateGroup,
  SkillRecord,
  TaskDeleteRequest,
  TaskDetail,
  TaskFolderDeleteRequest,
  TaskFolderRecord,
  TaskEvent,
  TaskMemory,
  TaskPatchRequest,
  ToolApproval,
  UserPreferences
} from "@scc/shared";
import { api } from "./api.js";

export interface WorkbenchData {
  tasks: TaskDetail[];
  taskFolders: TaskFolderRecord[];
  selected: TaskDetail | null;
  selectedId: string | null;
  memories: TaskMemory[];
  patterns: PatternRecord[];
  skills: SkillRecord[];
  skillConflicts: SkillConflict[];
  skillDuplicates: SkillDuplicateGroup[];
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  reflections: ReflectionSession[];
  projectMemories: ProjectMemory[];
  knowledgeItems: KnowledgeItem[];
  modelProviders: ModelProviderRecord[];
  mcpServers: Array<McpServerConfig & { status: McpServerStatus }>;
  mcpTools: McpToolSummary[];
  realtimeConnected: boolean;
  busy: boolean;
  error: string | null;
  refresh: (nextId?: string | null) => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  clearSelection: () => void;
  patchTask: (taskId: string, input: TaskPatchRequest) => Promise<void>;
  deleteTask: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  deleteTaskFolder: (folderId: string, options: TaskFolderDeleteRequest) => Promise<void>;
  runTaskAction: (action: () => Promise<TaskDetail>) => Promise<void>;
  runSideAction: (action: () => Promise<unknown>) => Promise<void>;
}

export function useWorkbenchData(): WorkbenchData {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [taskFolders, setTaskFolders] = useState<TaskFolderRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [memories, setMemories] = useState<TaskMemory[]>([]);
  const [patterns, setPatterns] = useState<PatternRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillConflicts, setSkillConflicts] = useState<SkillConflict[]>([]);
  const [skillDuplicates, setSkillDuplicates] = useState<SkillDuplicateGroup[]>([]);
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [reflections, setReflections] = useState<ReflectionSession[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<Array<McpServerConfig & { status: McpServerStatus }>>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newTaskModeRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  async function refresh(nextId?: string | null) {
    const [
      list,
      nextTaskFolders,
      nextMemories,
      nextPatterns,
      nextSkills,
      nextSkillConflicts,
      nextSkillDuplicates,
      nextPermissions,
      nextPreferences,
      nextReflections,
      nextProjectMemories,
      nextKnowledgeItems,
      nextModelProviders,
      nextMcpServers,
      nextMcpTools
    ] = await Promise.all([
      api.listTasks(),
      api.listTaskFolders(),
      api.listTaskMemories(),
      api.listPatterns(),
      api.listSkills(),
      api.listSkillConflicts(),
      api.listSkillDuplicates(),
      api.listGlobalPermissions(),
      api.getPreferences(),
      api.listReflections(),
      api.listProjectMemories(),
      api.listKnowledgeItems(),
      api.listModelProviders(),
      api.listMcpServers(),
      api.listMcpTools()
    ]);
    setTasks(list);
    setTaskFolders(nextTaskFolders);
    const hasExplicitNext = nextId !== undefined;
    const preferredId = hasExplicitNext ? nextId : selectedIdRef.current;
    const preferredExists = preferredId ? list.some((task) => task.id === preferredId) : false;
    const id = preferredExists ? preferredId : newTaskModeRef.current && !hasExplicitNext ? null : list[0]?.id ?? null;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelected(id ? await api.getTask(id) : null);
    setMemories(nextMemories);
    setPatterns(nextPatterns);
    setSkills(nextSkills);
    setSkillConflicts(nextSkillConflicts);
    setSkillDuplicates(nextSkillDuplicates);
    setPermissions(nextPermissions);
    setPreferences(nextPreferences);
    setReflections(nextReflections);
    setProjectMemories(nextProjectMemories);
    setKnowledgeItems(nextKnowledgeItems);
    setModelProviders(nextModelProviders);
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
    let ws: WebSocket | null = null;
    let cancelled = false;
    const connectTimer = window.setTimeout(() => {
      ws = new WebSocket(api.taskEventsWebSocketUrl(selectedId));
      ws.onopen = () => {
        if (cancelled) {
          ws?.close();
          return;
        }
        setRealtimeConnected(true);
      };
      ws.onclose = () => {
        if (!cancelled) setRealtimeConnected(false);
      };
      ws.onerror = () => {
        if (!cancelled) setRealtimeConnected(false);
      };
      ws.onmessage = (message) => {
        if (cancelled) return;
        const parsed = parseRealtimeMessage(message.data);
        if (!parsed) return;
        setSelected((current) => {
          if (!current || current.id !== selectedId) return current;
          if (parsed.type === "snapshot") return { ...current, events: parsed.events };
          if (current.events.some((event) => event.id === parsed.event.id)) return current;
          const nextApprovals = approvalFromEvent(parsed.event, current.approvals);
          return { ...current, events: [...current.events, parsed.event], approvals: nextApprovals, updatedAt: parsed.event.createdAt };
        });
      };
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    };
  }, [selectedId]);

  async function selectTask(taskId: string) {
    newTaskModeRef.current = false;
    selectedIdRef.current = taskId;
    setSelectedId(taskId);
    setSelected(await api.getTask(taskId));
  }

  function clearSelection() {
    newTaskModeRef.current = true;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelected(null);
  }

  async function deleteTask(taskId: string, options: TaskDeleteRequest) {
    await run(async () => {
      const wasSelected = selectedIdRef.current === taskId;
      await api.deleteTask(taskId, options);
      if (wasSelected) {
        selectedIdRef.current = null;
        setSelectedId(null);
        setSelected(null);
      }
      await refresh(wasSelected ? undefined : selectedIdRef.current);
    });
  }

  async function patchTask(taskId: string, input: TaskPatchRequest) {
    await run(async () => {
      const updated = await api.patchTask(taskId, input);
      if (selectedIdRef.current === taskId) {
        setSelected(updated);
      }
      await refresh(selectedIdRef.current);
    });
  }

  async function deleteTaskFolder(folderId: string, options: TaskFolderDeleteRequest) {
    await run(async () => {
      const affectsSelected = Boolean(selected && (selected.folderId || "default") === folderId);
      await api.deleteTaskFolder(folderId, options);
      if (affectsSelected) {
        newTaskModeRef.current = true;
        selectedIdRef.current = null;
        setSelectedId(null);
        setSelected(null);
      }
      await refresh(affectsSelected ? null : selectedIdRef.current);
    });
  }

  async function runTaskAction(action: () => Promise<TaskDetail>) {
    await run(async () => {
      const task = await action();
      newTaskModeRef.current = false;
      selectedIdRef.current = task.id;
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
    taskFolders,
    selected,
    selectedId,
    memories,
    patterns,
    skills,
    skillConflicts,
    skillDuplicates,
    permissions,
    preferences,
    reflections,
    projectMemories,
    knowledgeItems,
    modelProviders,
    mcpServers,
    mcpTools,
    realtimeConnected,
    busy,
    error,
    refresh,
    selectTask,
    clearSelection,
    patchTask,
    deleteTask,
    deleteTaskFolder,
    runTaskAction,
    runSideAction
  };
}

function approvalFromEvent(event: TaskEvent, approvals: ToolApproval[]): ToolApproval[] {
  if (event.type !== "approval_pending") return approvals;
  const approval = event.payload["approval"] as ToolApproval | undefined;
  if (!approval || approvals.some((item) => item.id === approval.id)) return approvals;
  return [...approvals, approval];
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
