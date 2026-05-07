import { useEffect, useRef, useState } from "react";
import type {
  GlobalPermissionGrant,
  IntegrationProviderConfig,
  KnowledgeItem,
  McpServerConfig,
  McpServerStatus,
  McpToolSummary,
  ModelProviderRecord,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  ScheduledTask,
  SkillConflict,
  SkillCuratorItem,
  SkillDuplicateGroup,
  SkillRecord,
  TaskRollbackPreview,
  TaskRollbackRequest,
  TaskRollbackResult,
  TaskDeleteRequest,
  TaskDetail,
  TaskFolderDeleteRequest,
  TaskFolderRecord,
  TaskEvent,
  TaskMemory,
  TaskPatchRequest,
  ToolApproval,
  UserPreferences,
  PromptCacheStats,
  WebSearchProviderConfig
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
  skillCurator: SkillCuratorItem[];
  skillDuplicates: SkillDuplicateGroup[];
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  reflections: ReflectionSession[];
  projectMemories: ProjectMemory[];
  knowledgeItems: KnowledgeItem[];
  promptCacheStats: PromptCacheStats[];
  integrations: IntegrationProviderConfig[];
  modelProviders: ModelProviderRecord[];
  mcpServers: Array<McpServerConfig & { status: McpServerStatus }>;
  mcpTools: McpToolSummary[];
  scheduledTasks: ScheduledTask[];
  webSearchProviders: WebSearchProviderConfig[];
  realtimeConnected: boolean;
  busy: boolean;
  busySince: number | null;
  error: string | null;
  backendHealthy: boolean | null;
  abortController: AbortController | null;
  refresh: (nextId?: string | null) => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  clearSelection: () => void;
  patchTask: (taskId: string, input: TaskPatchRequest) => Promise<void>;
  previewRollbackTask: (taskId: string, input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>;
  rollbackTask: (taskId: string, input?: TaskRollbackRequest) => Promise<TaskRollbackResult>;
  revertLatestTurn: (taskId: string) => Promise<string>;
  deleteTask: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  deleteTaskFolder: (folderId: string, options: TaskFolderDeleteRequest) => Promise<void>;
  runTaskAction: (action: () => Promise<TaskDetail>) => Promise<void>;
  runSideAction: (action: () => Promise<unknown>) => Promise<void>;
  cancelBusy: () => void;
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
  const [skillCurator, setSkillCurator] = useState<SkillCuratorItem[]>([]);
  const [skillDuplicates, setSkillDuplicates] = useState<SkillDuplicateGroup[]>([]);
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [reflections, setReflections] = useState<ReflectionSession[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [promptCacheStats, setPromptCacheStats] = useState<PromptCacheStats[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationProviderConfig[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<Array<McpServerConfig & { status: McpServerStatus }>>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [webSearchProviders, setWebSearchProviders] = useState<WebSearchProviderConfig[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);
  const newTaskModeRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsCancelRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  async function refresh(nextId?: string | null) {
    const [
      list,
      nextTaskFolders,
      nextMemories,
      nextPatterns,
      nextSkills,
      nextSkillConflicts,
      nextSkillCurator,
      nextSkillDuplicates,
      nextPermissions,
      nextPreferences,
      nextReflections,
      nextProjectMemories,
      nextKnowledgeItems,
      nextPromptCacheStats,
      nextIntegrations,
      nextModelProviders,
      nextMcpServers,
      nextMcpTools,
      nextScheduledTasks,
      nextWebSearchProviders
    ] = await Promise.all([
      api.listTasks(),
      api.listTaskFolders(),
      api.listTaskMemories(),
      api.listPatterns(),
      api.listSkills(),
      api.listSkillConflicts(),
      api.listSkillCurator(),
      api.listSkillDuplicates(),
      api.listGlobalPermissions(),
      api.getPreferences(),
      api.listReflections(),
      api.listProjectMemories(),
      api.listKnowledgeItems(),
      api.listPromptCacheStats(),
      api.listIntegrations(),
      api.listModelProviders(),
      api.listMcpServers(),
      api.listMcpTools(),
      api.listScheduledTasks(),
      api.listWebSearchProviders()
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
    setSkillCurator(nextSkillCurator);
    setSkillDuplicates(nextSkillDuplicates);
    setPermissions(nextPermissions);
    setPreferences(nextPreferences);
    setReflections(nextReflections);
    setProjectMemories(nextProjectMemories);
    setKnowledgeItems(nextKnowledgeItems);
    setPromptCacheStats(nextPromptCacheStats);
    setIntegrations(nextIntegrations);
    setModelProviders(nextModelProviders);
    setMcpServers(nextMcpServers);
    setMcpTools(nextMcpTools);
    setScheduledTasks(nextScheduledTasks);
    setWebSearchProviders(nextWebSearchProviders);
  }

  useEffect(() => {
    void refresh();
    if (refreshTimerRef.current !== null) {
      window.clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setInterval(() => void refresh(), realtimeConnected ? 6000 : 2000);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [realtimeConnected]);

  useEffect(() => {
    async function checkHealth() {
      try {
        await api.healthCheck();
        setBackendHealthy(true);
      } catch {
        setBackendHealthy(false);
      }
    }
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    wsCancelRef.current = false;
    const connectTimer = window.setTimeout(() => {
      if (wsCancelRef.current) return;
      const ws = new WebSocket(api.taskEventsWebSocketUrl(selectedId));
      wsRef.current = ws;
      ws.onopen = () => {
        if (wsCancelRef.current) {
          ws.close();
          return;
        }
        setRealtimeConnected(true);
      };
      ws.onclose = () => {
        if (!wsCancelRef.current) setRealtimeConnected(false);
      };
      ws.onerror = () => {
        if (!wsCancelRef.current) setRealtimeConnected(false);
      };
      ws.onmessage = (message) => {
        if (wsCancelRef.current) return;
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
      wsCancelRef.current = true;
      window.clearTimeout(connectTimer);
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.close();
      }
      wsRef.current = null;
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

  async function previewRollbackTask(taskId: string, input: TaskRollbackRequest = {}) {
    return api.previewTaskRollback(taskId, input);
  }

  async function rollbackTask(taskId: string, input: TaskRollbackRequest = {}): Promise<TaskRollbackResult> {
    let result!: TaskRollbackResult;
    await run(async () => {
      result = await api.rollbackTask(taskId, input);
      await refresh(taskId);
    });
    return result;
  }

  async function revertLatestTurn(taskId: string): Promise<string> {
    let draft = "";
    await run(async () => {
      const turns = await api.listTaskTurns(taskId);
      const latest = [...turns].reverse().find((turn) => turn.status === "active");
      if (!latest) throw new Error("No active user turn is available to revert.");
      const result = await api.revertTaskTurn(taskId, latest.id);
      draft = result.draft;
      setSelected(result.task);
      await refresh(taskId);
    });
    return draft;
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
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy(true);
    setBusySince(performance.now());
    setError(null);
    try {
      await action();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setBusySince(null);
        abortControllerRef.current = null;
      }
    }
  }

  function cancelBusy() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setBusy(false);
    setBusySince(null);
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
    skillCurator,
    skillDuplicates,
    permissions,
    preferences,
    reflections,
    projectMemories,
    knowledgeItems,
    promptCacheStats,
    integrations,
    modelProviders,
    mcpServers,
    mcpTools,
    scheduledTasks,
    webSearchProviders,
    realtimeConnected,
    busy,
    busySince,
    error,
    backendHealthy,
    abortController: abortControllerRef.current,
    refresh,
    selectTask,
    clearSelection,
    patchTask,
    previewRollbackTask,
    rollbackTask,
    revertLatestTurn,
    deleteTask,
    deleteTaskFolder,
    runTaskAction,
    runSideAction,
    cancelBusy
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
