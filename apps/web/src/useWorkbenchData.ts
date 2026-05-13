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
  TaskTranscriptItem,
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
  selectedTranscript: TaskTranscriptItem[];
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
  realtimeStale: boolean;
  lastRealtimeAt: number | null;
  lastSuccessfulSyncAt: number | null;
  syncWarning: string | null;
  busy: boolean;
  busySince: number | null;
  error: string | null;
  backendHealthy: boolean | null;
  abortController: AbortController | null;
  refresh: (nextId?: string | null) => Promise<void>;
  loadPermissions: (force?: boolean) => Promise<void>;
  loadModelProviders: (force?: boolean) => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  clearSelection: () => void;
  patchTask: (taskId: string, input: TaskPatchRequest) => Promise<void>;
  previewRollbackTask: (taskId: string, input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>;
  rollbackTask: (taskId: string, input?: TaskRollbackRequest) => Promise<TaskRollbackResult>;
  revertLatestTurn: (taskId: string) => Promise<string>;
  revertTaskTurn: (taskId: string, turnId: string) => Promise<string>;
  deleteTask: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  deleteTaskFolder: (folderId: string, options: TaskFolderDeleteRequest) => Promise<void>;
  runTaskAction: (action: () => Promise<TaskDetail>) => Promise<void>;
  runSideAction: (action: () => Promise<unknown>) => Promise<void>;
  runSideActionResult: <T>(action: () => Promise<T>, options?: { rethrow?: boolean }) => Promise<T>;
  cancelBusy: () => void;
}

export interface WorkbenchLoadProfile {
  activeView?: "tasks" | "history" | "library" | "docs" | "settings";
  librarySection?: "skills" | "curator" | "knowledge" | "memory" | "reflections";
  settingsSection?: "providers" | "permissions" | "mcp" | "integrations" | "scheduled" | "search" | "preferences";
}

const defaultLoadProfile: WorkbenchLoadProfile = { activeView: "tasks" };

export function useWorkbenchData(loadProfile: WorkbenchLoadProfile = defaultLoadProfile): WorkbenchData {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [taskFolders, setTaskFolders] = useState<TaskFolderRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<TaskTranscriptItem[]>([]);
  const [memories] = useState<TaskMemory[]>([]);
  const [patterns] = useState<PatternRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillConflicts, setSkillConflicts] = useState<SkillConflict[]>([]);
  const [skillCurator, setSkillCurator] = useState<SkillCuratorItem[]>([]);
  const [skillDuplicates, setSkillDuplicates] = useState<SkillDuplicateGroup[]>([]);
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [reflections, setReflections] = useState<ReflectionSession[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [promptCacheStats] = useState<PromptCacheStats[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationProviderConfig[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<Array<McpServerConfig & { status: McpServerStatus }>>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [webSearchProviders, setWebSearchProviders] = useState<WebSearchProviderConfig[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [realtimeStale, setRealtimeStale] = useState(false);
  const [lastRealtimeAt, setLastRealtimeAt] = useState<number | null>(null);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<number | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);
  const newTaskModeRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsCancelRef = useRef(false);
  const wsEventQueueRef = useRef<TaskEvent[]>([]);
  const wsFlushTimerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const backgroundPollRef = useRef(0);
  const lastRealtimeAtRef = useRef<number | null>(null);
  const lastSuccessfulSyncAtRef = useRef<number | null>(null);
  const realtimeConnectedRef = useRef(false);
  const transcriptHydrationRef = useRef<Record<string, boolean>>({});
  const loadProfileRef = useRef<WorkbenchLoadProfile>(loadProfile);
  const lastActiveViewRef = useRef(loadProfile.activeView);
  const loadedLibrarySectionsRef = useRef<Record<NonNullable<WorkbenchLoadProfile["librarySection"]>, boolean>>({
    skills: false,
    curator: false,
    knowledge: false,
    memory: false,
    reflections: false
  });
  const loadedSettingsSectionsRef = useRef<Record<NonNullable<WorkbenchLoadProfile["settingsSection"]>, boolean>>({
    providers: false,
    permissions: false,
    mcp: false,
    integrations: false,
    scheduled: false,
    search: false,
    preferences: true
  });

  useEffect(() => {
    realtimeConnectedRef.current = realtimeConnected;
  }, [realtimeConnected]);

  useEffect(() => {
    loadProfileRef.current = loadProfile;
  }, [loadProfile]);

  async function refresh(nextId?: string | null) {
    await refreshCore(nextId);
    await ensureVisibleSurfaceLoaded();
  }

  async function refreshCore(nextId?: string | null, options: { loadTranscript?: boolean } = {}) {
    const results = await Promise.allSettled([
      api.listTasks(),
      api.listTaskFolders(),
      api.getPreferences()
    ] as const);
    const nextTasks = settledValue<TaskDetail[]>(results[0]) ?? [];
    const nextTaskFolders = settledValue<TaskFolderRecord[]>(results[1]) ?? [];
    const nextPreferences = settledValue<UserPreferences>(results[2]) ?? null;
    setTasks(nextTasks);
    setTaskFolders(nextTaskFolders);
    setPreferences(nextPreferences);
    await syncSelectionFromTaskList(nextTasks, nextId, false);
    const transcriptTaskId = selectedIdRef.current;
    if (options.loadTranscript && transcriptTaskId) {
      try {
        const transcript = await api.listTaskTranscript(transcriptTaskId);
        applySelectedTranscript(transcriptTaskId, transcript);
      } catch (error) {
        recordBackgroundSyncFailure(error);
      }
    }
    markSyncSuccess();
  }

  async function ensureVisibleSurfaceLoaded(force = false) {
    const profile = loadProfileRef.current;
    if (profile.activeView === "library") {
      await ensureLibrarySectionLoaded(profile.librarySection ?? "skills", force);
      return;
    }
    if (profile.activeView === "settings") {
      await ensureSettingsSectionLoaded(profile.settingsSection ?? "providers", force);
      return;
    }
  }

  async function ensureLibrarySectionLoaded(section: NonNullable<WorkbenchLoadProfile["librarySection"]>, force = false) {
    if (!force && loadedLibrarySectionsRef.current[section]) return;
    switch (section) {
      case "skills": {
        const results = await Promise.allSettled([api.listSkills(), api.listSkillConflicts(), api.listSkillDuplicates(), api.listReflections()] as const);
        setSkills(settledValue<SkillRecord[]>(results[0]) ?? []);
        setSkillConflicts(settledValue<SkillConflict[]>(results[1]) ?? []);
        setSkillDuplicates(settledValue<SkillDuplicateGroup[]>(results[2]) ?? []);
        setReflections(settledValue<ReflectionSession[]>(results[3]) ?? []);
        break;
      }
      case "curator": {
        const results = await Promise.allSettled([api.listSkillCurator(), api.listReflections()] as const);
        setSkillCurator(settledValue<SkillCuratorItem[]>(results[0]) ?? []);
        setReflections(settledValue<ReflectionSession[]>(results[1]) ?? []);
        break;
      }
      case "knowledge": {
        setKnowledgeItems(await api.listKnowledgeItems());
        break;
      }
      case "memory": {
        setProjectMemories(await api.listProjectMemories());
        break;
      }
      case "reflections": {
        const results = await Promise.allSettled([api.listReflections(), api.listSkillConflicts(), api.listSkillDuplicates()] as const);
        setReflections(settledValue<ReflectionSession[]>(results[0]) ?? []);
        setSkillConflicts(settledValue<SkillConflict[]>(results[1]) ?? []);
        setSkillDuplicates(settledValue<SkillDuplicateGroup[]>(results[2]) ?? []);
        break;
      }
    }
    loadedLibrarySectionsRef.current[section] = true;
    markSyncSuccess();
  }

  async function ensureSettingsSectionLoaded(section: NonNullable<WorkbenchLoadProfile["settingsSection"]>, force = false) {
    if (!force && loadedSettingsSectionsRef.current[section]) return;
    switch (section) {
      case "providers": {
        setModelProviders(await api.listModelProviders());
        break;
      }
      case "permissions": {
        setPermissions(await api.listGlobalPermissions());
        break;
      }
      case "mcp": {
        const results = await Promise.allSettled([api.listMcpServers(), api.listMcpTools()] as const);
        setMcpServers(settledValue<Array<McpServerConfig & { status: McpServerStatus }>>(results[0]) ?? []);
        setMcpTools(settledValue<McpToolSummary[]>(results[1]) ?? []);
        break;
      }
      case "integrations": {
        setIntegrations(await api.listIntegrations());
        break;
      }
      case "scheduled": {
        setScheduledTasks(await api.listScheduledTasks());
        break;
      }
      case "search": {
        setWebSearchProviders(await api.listWebSearchProviders());
        break;
      }
      default:
        break;
    }
    loadedSettingsSectionsRef.current[section] = true;
    markSyncSuccess();
  }

  async function refreshTaskShell(nextId?: string | null, loadTranscript = false) {
    const list = await api.listTasks();
    setTasks(list);
    await syncSelectionFromTaskList(list, nextId, loadTranscript);
    markSyncSuccess();
  }

  async function syncSelectionFromTaskList(list: TaskDetail[], nextId?: string | null, loadTranscript = false) {
    const previousSelectedId = selectedIdRef.current;
    const hasExplicitNext = nextId !== undefined;
    const preferredId = hasExplicitNext ? nextId : selectedIdRef.current;
    const preferredExists = preferredId ? list.some((task) => task.id === preferredId) : false;
    if (!hasExplicitNext && preferredId && !preferredExists && list.length === 0) {
      return;
    }
    const id = preferredExists ? preferredId : newTaskModeRef.current && !hasExplicitNext ? null : list[0]?.id ?? null;
    selectedIdRef.current = id;
    setSelectedId(id);
    if (!id) {
      setSelected(null);
      setSelectedTranscript([]);
      return;
    }
    if (previousSelectedId !== id) {
      transcriptHydrationRef.current[id] = false;
      setSelectedTranscript([]);
    }
    if (!loadTranscript) {
      const nextSelected = list.find((task) => task.id === id) ?? null;
      if (nextSelected) {
        setSelected((current) => mergeSelectedTaskShell(current, nextSelected));
      }
      return;
    }
    const [nextSelected, nextTranscript] = await Promise.all([api.getTask(id), api.listTaskTranscript(id)]);
    setSelected(nextSelected);
    applySelectedTranscript(id, nextTranscript);
  }

  useEffect(() => {
    void refresh().catch(recordBackgroundSyncFailure);
    if (refreshTimerRef.current !== null) {
      window.clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setInterval(() => {
      if (loadProfileRef.current.activeView !== "tasks") return;
      const cycleLength = realtimeConnected ? 10 : 5;
      backgroundPollRef.current = (backgroundPollRef.current + 1) % cycleLength;
      const shouldFullRefresh = backgroundPollRef.current === 0;
      if (shouldFullRefresh) {
        void refreshCore(undefined).catch(recordBackgroundSyncFailure);
        return;
      }
      void refreshTaskShell(undefined, !realtimeConnected).catch(recordBackgroundSyncFailure);
    }, realtimeConnected ? 8000 : 2500);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [realtimeConnected]);

  useEffect(() => {
    const previousView = lastActiveViewRef.current;
    lastActiveViewRef.current = loadProfile.activeView;
    if (loadProfile.activeView === "tasks") {
      if (previousView !== "tasks") {
        void refreshCore(selectedIdRef.current).catch(recordBackgroundSyncFailure);
      }
      return;
    }
    void ensureVisibleSurfaceLoaded().catch(recordBackgroundSyncFailure);
  }, [loadProfile.activeView, loadProfile.librarySection, loadProfile.settingsSection]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!selectedIdRef.current || !realtimeConnected) {
        setRealtimeStale(false);
        return;
      }
      const now = Date.now();
      const lastRealtime = lastRealtimeAtRef.current;
      const lastSync = lastSuccessfulSyncAtRef.current;
      setRealtimeStale(Boolean(lastRealtime && now - lastRealtime > 25_000 && (!lastSync || now - lastSync > 25_000)));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [realtimeConnected]);

  useEffect(() => {
    if (loadProfile.activeView !== "tasks" || !selectedId) return;
    if (transcriptHydrationRef.current[selectedId]) return;
    if (selected && selected.id === selectedId && isRealtimeDrivenTaskStatus(selected.status)) return;
    const taskId = selectedId;
    const timer = window.setTimeout(() => {
      if (selectedIdRef.current !== taskId || transcriptHydrationRef.current[taskId]) return;
      void api.listTaskTranscript(taskId).then((transcript) => {
        applySelectedTranscript(taskId, transcript);
        markSyncSuccess();
      }).catch(recordBackgroundSyncFailure);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [loadProfile.activeView, selected, selectedId]);

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
    const currentTaskId = selectedId;
    wsCancelRef.current = false;
    wsEventQueueRef.current = [];
    if (wsFlushTimerRef.current !== null) {
      window.clearTimeout(wsFlushTimerRef.current);
      wsFlushTimerRef.current = null;
    }
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    function connect() {
      if (wsCancelRef.current) return;
      if (typeof WebSocket === "undefined") {
        setRealtimeConnected(false);
        return;
      }
      try {
        void api.taskEventsWebSocketUrl(currentTaskId).then((url) => {
          if (wsCancelRef.current) return;
          const ws = new WebSocket(url);
          wsRef.current = ws;
          ws.onopen = () => {
            if (wsCancelRef.current) {
              ws.close();
              return;
            }
            markRealtimeSeen();
            setRealtimeConnected(true);
            reconnectAttempt = 0;
          };
          ws.onclose = () => {
            if (wsCancelRef.current) return;
            setRealtimeConnected(false);
            scheduleReconnect();
          };
          ws.onerror = () => {
            if (wsCancelRef.current) return;
            setRealtimeConnected(false);
            try { ws.close(); } catch { /* ignore */ }
          };
          ws.onmessage = (message) => {
            if (wsCancelRef.current) return;
            try {
              markRealtimeSeen();
              const parsed = parseRealtimeMessage(message.data);
              if (!parsed) return;
              if (parsed.type === "heartbeat") {
                return;
              }
              if (parsed.type === "snapshot") {
                wsEventQueueRef.current = [];
                if (wsFlushTimerRef.current !== null) {
                  window.clearTimeout(wsFlushTimerRef.current);
                  wsFlushTimerRef.current = null;
                }
                setSelected((current) => {
                  if (!current || current.id !== currentTaskId) return current;
                  return { ...current, events: parsed.events };
                });
                markSyncSuccess();
                if (parsed.transcript) {
                  applySelectedTranscript(currentTaskId, parsed.transcript);
                } else {
                  void api.listTaskTranscript(currentTaskId).then((transcript) => {
                    if (wsCancelRef.current) return;
                    applySelectedTranscript(currentTaskId, transcript);
                    markSyncSuccess();
                  }).catch(recordBackgroundSyncFailure);
                }
                return;
              }
              wsEventQueueRef.current.push(parsed.event);
              scheduleRealtimeFlush(currentTaskId);
            } catch (e) {
              console.warn("Failed to handle WebSocket message:", e);
            }
          };
        }).catch((error) => {
          if (wsCancelRef.current) return;
          recordBackgroundSyncFailure(error);
          scheduleReconnect();
        });
      } catch (e) {
        console.warn("Failed to create WebSocket:", e);
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (wsCancelRef.current) return;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000);
      reconnectAttempt++;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!wsCancelRef.current) connect();
      }, delay);
    }

    const connectTimer = window.setTimeout(connect, 50);
    return () => {
      wsCancelRef.current = true;
      window.clearTimeout(connectTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      wsEventQueueRef.current = [];
      if (wsFlushTimerRef.current !== null) {
        window.clearTimeout(wsFlushTimerRef.current);
        wsFlushTimerRef.current = null;
      }
      try {
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
          wsRef.current.close();
        }
      } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, [selectedId]);

  function scheduleRealtimeFlush(taskId: string) {
    if (wsFlushTimerRef.current !== null) return;
    wsFlushTimerRef.current = window.setTimeout(() => {
      wsFlushTimerRef.current = null;
      const queued = wsEventQueueRef.current;
      wsEventQueueRef.current = [];
      if (queued.length === 0 || wsCancelRef.current) return;
      setSelected((current) => {
        if (!current || current.id !== taskId) return current;
        const merged = coalesceRealtimeEvents(current.events, queued);
        if (merged.events.length === current.events.length && merged.changedCount === 0) return current;
        let nextApprovals = current.approvals;
        let updatedAt = current.updatedAt;
        for (const event of merged.acceptedEvents) {
          nextApprovals = approvalFromEvent(event, nextApprovals);
          updatedAt = event.createdAt;
        }
        return { ...current, events: merged.events, approvals: nextApprovals, updatedAt };
      });
      setSelectedTranscript((current) => appendTranscriptEvents(current, queued));
      markSyncSuccess();
    }, 40);
  }

  async function selectTask(taskId: string) {
    newTaskModeRef.current = false;
    selectedIdRef.current = taskId;
    transcriptHydrationRef.current[taskId] = false;
    setSelectedId(taskId);
    setSelectedTranscript([]);
    const nextSelected = await api.getTask(taskId);
    if (selectedIdRef.current !== taskId) return;
    setSelected(nextSelected);
    setTasks((current) => upsertTask(current, nextSelected));
    markSyncSuccess();
  }

  function clearSelection() {
    newTaskModeRef.current = true;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelected(null);
    setSelectedTranscript([]);
  }

  async function deleteTask(taskId: string, options: TaskDeleteRequest) {
    await run(async () => {
      const wasSelected = selectedIdRef.current === taskId;
      await api.deleteTask(taskId, options);
      if (wasSelected) {
        selectedIdRef.current = null;
        setSelectedId(null);
        setSelected(null);
        setSelectedTranscript([]);
      }
      await refresh(wasSelected ? undefined : selectedIdRef.current);
    });
  }

  async function patchTask(taskId: string, input: TaskPatchRequest) {
    await run(async () => {
      const updated = await api.patchTask(taskId, input);
      if (selectedIdRef.current === taskId) {
        setSelected(updated);
        applySelectedTranscript(taskId, await api.listTaskTranscript(taskId));
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
      applySelectedTranscript(taskId, await api.listTaskTranscript(taskId));
      await refresh(taskId);
    });
    return draft;
  }

  async function revertTaskTurn(taskId: string, turnId: string): Promise<string> {
    let draft = "";
    await run(async () => {
      const result = await api.revertTaskTurn(taskId, turnId);
      draft = result.draft;
      setSelected(result.task);
      applySelectedTranscript(taskId, await api.listTaskTranscript(taskId));
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
        setSelectedTranscript([]);
      }
      await refresh(affectsSelected ? null : selectedIdRef.current);
    });
  }

  async function runTaskAction(action: () => Promise<TaskDetail>) {
    await run(async () => {
      const task = await action();
      activateTask(task);
      void hydrateSelectedTask(task.id);
    });
  }

  async function runSideActionResult<T>(action: () => Promise<T>, options: { rethrow?: boolean } = {}): Promise<T> {
    let result!: T;
    await run(async () => {
      result = await action();
      await refreshCore(selectedIdRef.current);
      await ensureVisibleSurfaceLoaded(true);
    }, options);
    return result;
  }

  async function runSideAction(action: () => Promise<unknown>) {
    await runSideActionResult(action);
  }

  async function run(action: () => Promise<void>, options: { rethrow?: boolean } = {}) {
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
      if (options.rethrow) throw err;
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

  function activateTask(task: TaskDetail) {
    newTaskModeRef.current = false;
    selectedIdRef.current = task.id;
    transcriptHydrationRef.current[task.id] = false;
    setSelectedId(task.id);
    setSelected(task);
    setSelectedTranscript(compactTaskEventsForTranscript(task.events));
    setTasks((current) => upsertTask(current, task));
    markSyncSuccess();
  }

  async function hydrateSelectedTask(taskId: string) {
    try {
      const nextSelected = await api.getTask(taskId);
      if (selectedIdRef.current !== taskId) return;
      setSelected(nextSelected);
      setTasks((current) => upsertTask(current, nextSelected));
      markSyncSuccess();
    } catch (error) {
      recordBackgroundSyncFailure(error);
    }
  }

  function markRealtimeSeen() {
    const now = Date.now();
    lastRealtimeAtRef.current = now;
    setLastRealtimeAt(now);
    setRealtimeStale(false);
  }

  function markSyncSuccess() {
    const now = Date.now();
    lastSuccessfulSyncAtRef.current = now;
    setLastSuccessfulSyncAt(now);
    setSyncWarning(null);
  }

  function recordBackgroundSyncFailure(error: unknown) {
    setSyncWarning(error instanceof Error ? error.message : String(error));
  }

  function applySelectedTranscript(taskId: string, transcript: TaskTranscriptItem[]) {
    transcriptHydrationRef.current[taskId] = true;
    if (selectedIdRef.current !== taskId) return;
    setSelectedTranscript(transcript);
  }

  return {
    tasks,
    taskFolders,
    selected,
    selectedTranscript,
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
    realtimeStale,
    lastRealtimeAt,
    lastSuccessfulSyncAt,
    syncWarning,
    busy,
    busySince,
    error,
    backendHealthy,
    abortController: abortControllerRef.current,
    refresh,
    loadPermissions: (force = false) => ensureSettingsSectionLoaded("permissions", force),
    loadModelProviders: (force = false) => ensureSettingsSectionLoaded("providers", force),
    selectTask,
    clearSelection,
    patchTask,
    previewRollbackTask,
    rollbackTask,
    revertLatestTurn,
    revertTaskTurn,
    deleteTask,
    deleteTaskFolder,
    runTaskAction,
    runSideAction,
    runSideActionResult,
    cancelBusy
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function upsertTask(tasks: TaskDetail[], task: TaskDetail): TaskDetail[] {
  const existingIndex = tasks.findIndex((item) => item.id === task.id);
  if (existingIndex < 0) return [task, ...tasks];
  const next = [...tasks];
  next[existingIndex] = task;
  return next;
}

function isRealtimeDrivenTaskStatus(status: TaskDetail["status"]): boolean {
  return status === "running" || status === "waiting_for_user" || status === "waiting_approval";
}

function compactTaskEventsForTranscript(events: TaskEvent[]): TaskTranscriptItem[] {
  return events
    .filter((event) => isClientTranscriptEvent(event) && !isInlineToolMarkupEvent(event))
    .map(compactLiveTranscriptEvent);
}

function approvalFromEvent(event: TaskEvent, approvals: ToolApproval[]): ToolApproval[] {
  if (event.type !== "approval_pending") return approvals;
  const approval = event.payload["approval"] as ToolApproval | undefined;
  if (!approval || approvals.some((item) => item.id === approval.id)) return approvals;
  return [...approvals, approval];
}

export function mergeSelectedTaskShell(current: TaskDetail | null, incoming: TaskDetail): TaskDetail {
  if (!current || current.id !== incoming.id) return incoming;
  const preserveEvents = incoming.events.length === 0 && current.events.length > 0;
  const preservePendingGuidance = incoming.pendingGuidance.length === 0 && current.pendingGuidance.length > 0;
  return {
    ...current,
    ...incoming,
    events: preserveEvents ? current.events : incoming.events,
    pendingGuidance: preservePendingGuidance ? current.pendingGuidance : incoming.pendingGuidance
  };
}

export function parseRealtimeMessage(value: unknown):
  | { type: "snapshot"; events: TaskEvent[]; transcript?: TaskTranscriptItem[] }
  | { type: "event"; event: TaskEvent }
  | { type: "heartbeat"; taskId?: string; timestamp?: string }
  | null {
  try {
    const strValue = String(value ?? "");
    if (!strValue.trim()) return null;
    const parsed = JSON.parse(strValue) as Record<string, unknown>;
    if (parsed["type"] === "snapshot" && Array.isArray(parsed["events"])) {
      const events = parsed["events"].filter(
        (e): e is TaskEvent => typeof e === "object" && e !== null
      );
      return {
        type: "snapshot",
        events,
        ...(Array.isArray(parsed["transcript"]) ? { transcript: parsed["transcript"] as TaskTranscriptItem[] } : {})
      };
    }
    if (parsed["type"] === "event" && typeof parsed["event"] === "object" && parsed["event"]) {
      return { type: "event", event: parsed["event"] as TaskEvent };
    }
    if (parsed["type"] === "heartbeat") {
      return {
        type: "heartbeat",
        ...(typeof parsed["taskId"] === "string" ? { taskId: parsed["taskId"] } : {}),
        ...(typeof parsed["timestamp"] === "string" ? { timestamp: parsed["timestamp"] } : {})
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function coalesceRealtimeEvents(
  currentEvents: TaskEvent[],
  incomingEvents: TaskEvent[]
): { events: TaskEvent[]; acceptedEvents: TaskEvent[]; changedCount: number } {
  const next = [...currentEvents];
  const acceptedEvents: TaskEvent[] = [];
  const seen = new Set(currentEvents.map((event) => event.id));
  let changedCount = 0;
  for (const event of incomingEvents) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (mergeAdjacentStreamDelta(next, event)) {
      acceptedEvents.push(event);
      changedCount++;
      continue;
    }
    next.push(event);
    acceptedEvents.push(event);
    changedCount++;
  }
  return { events: next, acceptedEvents, changedCount };
}

function appendTranscriptEvents(current: TaskTranscriptItem[], events: TaskEvent[]): TaskTranscriptItem[] {
  const next = [...current];
  const seen = new Set(next.map((event) => event.id));
  for (const event of events) {
    if (seen.has(event.id) || !isClientTranscriptEvent(event)) continue;
    if (isInlineToolMarkupEvent(event)) continue;
    seen.add(event.id);
    const compact = compactLiveTranscriptEvent(event);
    if (mergeAdjacentStreamDelta(next, compact)) {
      continue;
    }
    next.push(compact);
  }
  return next;
}

function mergeAdjacentStreamDelta<T extends TaskEvent | TaskTranscriptItem>(events: T[], incoming: T): boolean {
  if (!isStreamDeltaEvent(incoming) || events.length === 0) return false;
  const candidate = events[events.length - 1];
  if (!candidate || !isStreamDeltaEvent(candidate) || streamDeltaKey(candidate) !== streamDeltaKey(incoming)) return false;
  events[events.length - 1] = mergeStreamDeltaEvents(candidate, incoming) as T;
  return true;
}

type StreamDeltaEvent = (TaskEvent | TaskTranscriptItem) & { type: "assistant_delta" | "thinking_delta" };

function mergeStreamDeltaEvents<T extends StreamDeltaEvent>(current: T, incoming: T): T {
  const currentDelta = streamDeltaText(current);
  const incomingDelta = streamDeltaText(incoming);
  const mergedDelta = appendStreamDeltaText(currentDelta, incomingDelta, incoming.type);
  const mergedSummary = appendStreamDeltaText(current.summary ?? "", incoming.summary ?? incomingDelta, incoming.type);
  return {
    ...current,
    createdAt: incoming.createdAt,
    summary: mergedSummary,
    payload: {
      ...current.payload,
      ...incoming.payload,
      delta: mergedDelta
    }
  };
}

function isStreamDeltaEvent(event: TaskEvent | TaskTranscriptItem): event is StreamDeltaEvent {
  return event.type === "assistant_delta" || event.type === "thinking_delta";
}

function streamDeltaKey(event: TaskEvent | TaskTranscriptItem): string {
  return `${event.type}:${String(event.payload["streamId"] ?? event.id)}`;
}

function streamDeltaText(event: TaskEvent | TaskTranscriptItem): string {
  const delta = event.payload["delta"];
  return typeof delta === "string" ? delta : event.summary ?? "";
}

function appendStreamDeltaText(current: string, delta: string, type: "assistant_delta" | "thinking_delta"): string {
  if (!current) return current + delta;
  if (type === "assistant_delta") return `${current}${streamDeltaSeparator(current, delta)}${delta}`;
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return current + delta;
  return `${current}\n${delta}`;
}

function streamDeltaSeparator(current: string, delta: string): string {
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return "";
  const previous = current.at(-1) ?? "";
  const next = delta[0] ?? "";
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(previous + next)) return "";
  if (/[A-Za-z0-9)]/.test(previous) && /[A-Za-z0-9(]/.test(next)) return " ";
  if (/[.,;:!?]/.test(previous) && /[A-Za-z0-9]/.test(next)) return " ";
  return "";
}

function compactLiveTranscriptEvent(event: TaskEvent): TaskTranscriptItem {
  if (event.type === "assistant_message" || event.type === "assistant_delta") {
    return {
      ...event,
      summary: stripToolEvidenceBoilerplate(event.summary),
      payload: stripAssistantPayloadBoilerplate(event.payload)
    };
  }
  if (event.type !== "tool_result" && event.type !== "web_search_result") return event;
  const payload: Record<string, unknown> = { ...event.payload };
  if (typeof payload["output"] === "string") payload["output"] = normalizeTranscriptTruncationMarker(payload["output"]);
  if (typeof payload["summary"] === "string") payload["summary"] = normalizeTranscriptTruncationMarker(payload["summary"]);
  return {
    ...event,
    summary: normalizeTranscriptTruncationMarker(event.summary),
    payload
  };
}

function stripAssistantPayloadBoilerplate(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  for (const key of ["message", "delta", "text"]) {
    if (typeof next[key] === "string") next[key] = stripToolEvidenceBoilerplate(next[key]);
  }
  return next;
}

function stripToolEvidenceBoilerplate(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTranscriptTruncationMarker(value: string): string {
  return value.replace(
    /\[UI preview truncated: (\d+) characters omitted\. Full evidence is retained by SCC\.\]/g,
    "[Output truncated: $1 characters omitted. Full evidence is available in the audit log.]"
  );
}

function isClientTranscriptEvent(event: TaskEvent | null | undefined): boolean {
  if (!event) return false;
  return (
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_message" ||
    event.type === "thinking_delta" ||
    event.type === "guidance_pending" ||
    event.type === "user_input_requested" ||
    event.type === "user_input_answered" ||
    event.type === "approval_pending" ||
    event.type === "tool_started" ||
    event.type === "tool_progress" ||
    event.type === "tool_result" ||
    event.type === "task_checkpoint_created" ||
    event.type === "task_rollback_completed" ||
    event.type === "task_rollback_failed" ||
    event.type === "plan_step_blocked" ||
    event.type === "web_search_result"
  );
}

function isInlineToolMarkupEvent(event: TaskEvent | null | undefined): boolean {
  if (!event) return false;
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return false;
  const text = [
    event.summary ?? "",
    typeof event?.payload?.["message"] === "string" ? event.payload["message"] : "",
    typeof event?.payload?.["delta"] === "string" ? event.payload["delta"] : "",
    typeof event?.payload?.["text"] === "string" ? event.payload["text"] : ""
  ]
    .filter(Boolean)
    .join("\n");
  return /<function_calls\b|<invoke\s+name=/i.test(text);
}
