import { startTransition, useEffect, useRef, useState } from "react";
import type {
  GlobalPermissionGrant,
  IntegrationProviderConfig,
  KnowledgeItem,
  McpServerConfig,
  McpServerStatus,
  McpToolSummary,
  ModelProviderRecord,
  ProjectMemory,
  CuratorRun,
  ScheduledTask,
  SkillConflict,
  SkillCuratorItem,
  SkillDuplicateGroup,
  SkillRecord,
  TaskRollbackPreview,
  TaskRollbackRequest,
  TaskRollbackResult,
  TaskChildSummary,
  TaskDeleteRequest,
  TaskDetail,
  TaskFolderDeleteRequest,
  TaskFolderRecord,
  TaskEvent,
  TaskPatchRequest,
  TaskTranscriptItem,
  UserPreferences,
  WebSearchProviderConfig
} from "@agent-workbench/shared";
import { api } from "./api.js";

export interface WorkbenchData {
  tasks: TaskDetail[];
  taskFolders: TaskFolderRecord[];
  selected: TaskDetail | null;
  selectedChildren: TaskChildSummary[];
  selectedTranscript: TaskTranscriptItem[];
  selectedId: string | null;
  skills: SkillRecord[];
  skillConflicts: SkillConflict[];
  skillCurator: SkillCuratorItem[];
  skillDuplicates: SkillDuplicateGroup[];
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  curatorRuns: CuratorRun[];
  projectMemories: ProjectMemory[];
  knowledgeItems: KnowledgeItem[];
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
  getTaskStreamText: (taskId: string, streamId: string, type: "assistant_delta" | "thinking_delta") => Promise<string>;
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
  librarySection?: "skills" | "curator" | "knowledge" | "memory";
  settingsSection?: "providers" | "permissions" | "mcp" | "integrations" | "scheduled" | "search" | "preferences";
}

const defaultLoadProfile: WorkbenchLoadProfile = { activeView: "tasks" };
type LibraryLoadSection = NonNullable<WorkbenchLoadProfile["librarySection"]>;
type SettingsLoadSection = NonNullable<WorkbenchLoadProfile["settingsSection"]>;
const libraryLoadSections: LibraryLoadSection[] = ["skills", "curator", "knowledge", "memory"];
const settingsLoadSections: SettingsLoadSection[] = ["providers", "permissions", "mcp", "integrations", "scheduled", "search", "preferences"];
const RUNNING_TASK_SYNC_INTERVAL_MS = 1000;

export function useWorkbenchData(loadProfile: WorkbenchLoadProfile = defaultLoadProfile): WorkbenchData {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [taskFolders, setTaskFolders] = useState<TaskFolderRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [selectedChildren, setSelectedChildren] = useState<TaskChildSummary[]>([]);
  const [selectedTranscript, setSelectedTranscript] = useState<TaskTranscriptItem[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillConflicts, setSkillConflicts] = useState<SkillConflict[]>([]);
  const [skillCurator, setSkillCurator] = useState<SkillCuratorItem[]>([]);
  const [skillDuplicates, setSkillDuplicates] = useState<SkillDuplicateGroup[]>([]);
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [curatorRuns, setCuratorRuns] = useState<CuratorRun[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
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
  const runningTaskSyncTimerRef = useRef<number | null>(null);
  const runningTaskSyncInFlightRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const backgroundPollRef = useRef(0);
  const childPollTimerRef = useRef<number | null>(null);
  const idleDataPreloadStartedRef = useRef(false);
  const lastSuccessfulSyncAtRef = useRef<number | null>(null);
  const realtimeSocketRef = useRef<WebSocket | null>(null);
  const realtimeStaleTimerRef = useRef<number | null>(null);
  const realtimeTranscriptQueueRef = useRef<Map<string, Array<TaskEvent | TaskTranscriptItem>>>(new Map());
  const realtimeTranscriptFlushFrameRef = useRef<number | null>(null);
  const realtimeCallbacksRef = useRef<{
    markRealtimeSeen: () => void;
    applyRealtimeMessage: (taskId: string, data: unknown) => void;
  }>({
    markRealtimeSeen: () => undefined,
    applyRealtimeMessage: () => undefined
  });
  const selectedUpdatedAtRef = useRef<string | null>(null);
  const transcriptHydrationRef = useRef<Record<string, boolean>>({});
  const loadProfileRef = useRef<WorkbenchLoadProfile>(loadProfile);
  const lastActiveViewRef = useRef(loadProfile.activeView);
  const loadedLibrarySectionsRef = useRef<Record<NonNullable<WorkbenchLoadProfile["librarySection"]>, boolean>>({
    skills: false,
    curator: false,
    knowledge: false,
    memory: false
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
  const selectedTaskId = selected?.id ?? null;
  const selectedTaskKind = selected?.kind ?? null;
  const selectedTaskStatus = selected?.status ?? null;
  const selectedTaskUpdatedAt = selected?.updatedAt ?? null;
  const selectedPrimaryTaskId = selectedTaskKind === "subagent" ? null : selectedTaskId;
  const selectedHasSubagentMarker = selected ? hasSubagentLifecycleMarker(selected.events) : false;
  const selectedHasChildren = selectedChildren.length > 0;
  const selectedHasRunningChildren = selectedChildren.some((child) => isRunningChildSummary(child));

  useEffect(() => {
    selectedUpdatedAtRef.current = selected?.updatedAt ?? null;
  }, [selected?.id, selected?.updatedAt]);

  useEffect(() => {
    loadProfileRef.current = loadProfile;
  }, [loadProfile]);

  async function refresh(nextId?: string | null) {
    await refreshCore(nextId);
    await ensureVisibleSurfaceLoaded();
  }

  async function refreshCore(nextId?: string | null, options: { loadTranscript?: boolean } = {}) {
    const results = await Promise.allSettled([
      api.listTasks(false),
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
        const results = await Promise.allSettled([api.listSkills(), api.listSkillConflicts(), api.listSkillDuplicates()] as const);
        setSkills(settledValue<SkillRecord[]>(results[0]) ?? []);
        setSkillConflicts(settledValue<SkillConflict[]>(results[1]) ?? []);
        setSkillDuplicates(settledValue<SkillDuplicateGroup[]>(results[2]) ?? []);
        break;
      }
      case "curator": {
        const results = await Promise.allSettled([api.listSkillCurator(), api.listCuratorRuns(), api.listSkillConflicts(), api.listSkillDuplicates()] as const);
        setSkillCurator(settledValue<SkillCuratorItem[]>(results[0]) ?? []);
        setCuratorRuns(settledValue<CuratorRun[]>(results[1]) ?? []);
        setSkillConflicts(settledValue<SkillConflict[]>(results[2]) ?? []);
        setSkillDuplicates(settledValue<SkillDuplicateGroup[]>(results[3]) ?? []);
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
    const list = await api.listTasks(false);
    const currentSelectedId = selectedIdRef.current;
    const shouldLoadTranscript = loadTranscript || Boolean(currentSelectedId && !list.some((task) => task.id === currentSelectedId));
    setTasks(list);
    await syncSelectionFromTaskList(list, nextId, shouldLoadTranscript);
    markSyncSuccess();
  }

  async function syncSelectionFromTaskList(list: TaskDetail[], nextId?: string | null, loadTranscript = false) {
    const previousSelectedId = selectedIdRef.current;
    const hasExplicitNext = nextId !== undefined;
    const preferredId = hasExplicitNext ? nextId : selectedIdRef.current;
    const preferredExists = preferredId ? list.some((task) => task.id === preferredId) : false;
    const preserveHiddenSelection = Boolean(preferredId && !preferredExists && previousSelectedId === preferredId);
    if (!hasExplicitNext && preferredId && !preferredExists && list.length === 0) {
      return;
    }
    if (preserveHiddenSelection && preferredId) {
      selectedIdRef.current = preferredId;
      setSelectedId(preferredId);
      if (!loadTranscript) return;
      const [nextSelected, nextTranscript] = await Promise.all([api.getTask(preferredId), api.listTaskTranscript(preferredId)]);
      if (selectedIdRef.current !== preferredId) return;
      setSelected(projectSelectedTask(nextSelected));
      applySelectedTranscript(preferredId, nextTranscript);
      return;
    }
    const id = preferredExists ? preferredId : newTaskModeRef.current && !hasExplicitNext ? null : list[0]?.id ?? null;
    selectedIdRef.current = id;
    setSelectedId(id);
    if (!id) {
      setSelected(null);
      setSelectedChildren([]);
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
        setSelected((current) => mergeSelectedTaskShell(current, projectSelectedTask(nextSelected)));
      }
      return;
    }
    const [nextSelected, nextTranscript] = await Promise.all([api.getTask(id), api.listTaskTranscript(id)]);
    setSelected(projectSelectedTask(nextSelected));
    applySelectedTranscript(id, nextTranscript);
  }

  const liveCallbacksRef = useRef({
    refresh,
    refreshCore,
    refreshTaskShell,
    syncRunningSelection,
    ensureLibrarySectionLoaded,
    ensureSettingsSectionLoaded,
    ensureVisibleSurfaceLoaded
  });
  liveCallbacksRef.current = {
    refresh,
    refreshCore,
    refreshTaskShell,
    syncRunningSelection,
    ensureLibrarySectionLoaded,
    ensureSettingsSectionLoaded,
    ensureVisibleSurfaceLoaded
  };
  realtimeCallbacksRef.current = {
    markRealtimeSeen,
    applyRealtimeMessage
  };

  useEffect(() => {
    void liveCallbacksRef.current.refresh().catch(recordBackgroundSyncFailure);
    if (refreshTimerRef.current !== null) {
      window.clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setInterval(() => {
      if (loadProfileRef.current.activeView !== "tasks") return;
      const cycleLength = 5;
      backgroundPollRef.current = (backgroundPollRef.current + 1) % cycleLength;
      const shouldFullRefresh = backgroundPollRef.current === 0;
      if (shouldFullRefresh) {
        void liveCallbacksRef.current.refreshCore(undefined).catch(recordBackgroundSyncFailure);
        return;
      }
      void liveCallbacksRef.current.refreshTaskShell(undefined, false).catch(recordBackgroundSyncFailure);
    }, 2500);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (realtimeTranscriptFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(realtimeTranscriptFlushFrameRef.current);
        realtimeTranscriptFlushFrameRef.current = null;
      }
      realtimeTranscriptQueueRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const previousView = lastActiveViewRef.current;
    lastActiveViewRef.current = loadProfile.activeView;
    if (loadProfile.activeView === "tasks") {
      if (previousView !== "tasks") {
        void liveCallbacksRef.current.refreshCore(selectedIdRef.current).catch(recordBackgroundSyncFailure);
      }
      return;
    }
    void liveCallbacksRef.current.ensureVisibleSurfaceLoaded().catch(recordBackgroundSyncFailure);
  }, [loadProfile.activeView, loadProfile.librarySection, loadProfile.settingsSection]);

  useEffect(() => {
    if (idleDataPreloadStartedRef.current) return;
    idleDataPreloadStartedRef.current = true;
    const jobs = [
      ...libraryLoadSections.map((section) => () => liveCallbacksRef.current.ensureLibrarySectionLoaded(section)),
      ...settingsLoadSections.map((section) => () => liveCallbacksRef.current.ensureSettingsSectionLoaded(section))
    ];
    return runIdleDataPreloadQueue(jobs, recordBackgroundSyncFailure);
  }, []);

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
    if (runningTaskSyncTimerRef.current !== null) {
      window.clearInterval(runningTaskSyncTimerRef.current);
      runningTaskSyncTimerRef.current = null;
    }
    if (loadProfile.activeView !== "tasks" || !selectedId || !selectedTaskStatus || !isRealtimeDrivenTaskStatus(selectedTaskStatus)) {
      return;
    }
    const taskId = selectedId;
    runningTaskSyncTimerRef.current = window.setInterval(() => {
      if (selectedIdRef.current !== taskId || !shouldRunVisibleTaskSync()) return;
      void liveCallbacksRef.current.syncRunningSelection(taskId).catch(recordBackgroundSyncFailure);
    }, RUNNING_TASK_SYNC_INTERVAL_MS);
    return () => {
      if (runningTaskSyncTimerRef.current !== null) {
        window.clearInterval(runningTaskSyncTimerRef.current);
        runningTaskSyncTimerRef.current = null;
      }
    };
  }, [loadProfile.activeView, selectedId, selectedTaskStatus]);

  useEffect(() => {
    closeRealtimeSocket(false);
    if (loadProfile.activeView !== "tasks" || !selectedId || !selectedTaskStatus || !isRealtimeDrivenTaskStatus(selectedTaskStatus) || typeof WebSocket === "undefined") {
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | null = null;
    const taskId = selectedId;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const scheduleReconnect = (attempt: number) => {
      if (cancelled || selectedIdRef.current !== taskId) return;
      clearReconnectTimer();
      const delayMs = Math.min(5_000, 500 * 2 ** Math.min(attempt, 4));
      reconnectTimer = window.setTimeout(() => connect(attempt + 1), delayMs);
    };
    const connect = (attempt = 0) => {
      void api.taskEventsWebSocketUrl(taskId).then((url) => {
        if (cancelled || selectedIdRef.current !== taskId) return;
        const socket = new WebSocket(url);
        realtimeSocketRef.current = socket;

        socket.onopen = () => {
          if (selectedIdRef.current !== taskId) return;
          setRealtimeConnected(true);
          realtimeCallbacksRef.current.markRealtimeSeen();
        };
        socket.onmessage = (message) => {
          if (selectedIdRef.current !== taskId) return;
          realtimeCallbacksRef.current.markRealtimeSeen();
          realtimeCallbacksRef.current.applyRealtimeMessage(taskId, message.data);
        };
        socket.onerror = () => {
          if (selectedIdRef.current !== taskId) return;
          setRealtimeConnected(false);
          setRealtimeStale(true);
        };
        socket.onclose = () => {
          if (realtimeSocketRef.current === socket) realtimeSocketRef.current = null;
          setRealtimeConnected(false);
          if (!cancelled && selectedIdRef.current === taskId) {
            setRealtimeStale(true);
            scheduleReconnect(attempt);
          }
        };
      }).catch((error) => {
        recordBackgroundSyncFailure(error);
        scheduleReconnect(attempt);
      });
    };

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeRealtimeSocket(false);
    };
  }, [loadProfile.activeView, selectedId, selectedTaskStatus]);

  useEffect(() => {
    const shouldLoadChildren =
      loadProfile.activeView === "tasks" &&
      selectedPrimaryTaskId !== null &&
      (selectedHasChildren || selectedHasSubagentMarker);
    if (!shouldLoadChildren) {
      setSelectedChildren([]);
      return;
    }
    let cancelled = false;
    const taskId = selectedPrimaryTaskId;
    const loadChildren = async () => {
      try {
        if (!taskId) return;
        const children = await api.listTaskChildren(taskId);
        if (cancelled || selectedIdRef.current !== taskId) return;
        setSelectedChildren(children);
        markSyncSuccess();
      } catch (error) {
        if (cancelled) return;
        recordBackgroundSyncFailure(error);
      }
    };
    void loadChildren();
    return () => {
      cancelled = true;
    };
  }, [loadProfile.activeView, selectedHasChildren, selectedHasSubagentMarker, selectedPrimaryTaskId, selectedTaskUpdatedAt]);

  useEffect(() => {
    if (childPollTimerRef.current !== null) {
      window.clearInterval(childPollTimerRef.current);
      childPollTimerRef.current = null;
    }
    if (loadProfile.activeView !== "tasks" || !selectedPrimaryTaskId || !selectedHasRunningChildren) {
      return;
    }
    const taskId = selectedPrimaryTaskId;
    childPollTimerRef.current = window.setInterval(() => {
      void api.listTaskChildren(taskId)
        .then((children) => {
          if (selectedIdRef.current !== taskId) return;
          setSelectedChildren(children);
          markSyncSuccess();
        })
        .catch(recordBackgroundSyncFailure);
    }, 2000);
    return () => {
      if (childPollTimerRef.current !== null) {
        window.clearInterval(childPollTimerRef.current);
        childPollTimerRef.current = null;
      }
    };
  }, [loadProfile.activeView, selectedHasRunningChildren, selectedPrimaryTaskId]);

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

  async function syncRunningSelection(taskId: string) {
    if (runningTaskSyncInFlightRef.current === taskId) return;
    runningTaskSyncInFlightRef.current = taskId;
    try {
      const [nextSelected, nextTranscript] = await Promise.all([api.getTask(taskId), api.listTaskTranscript(taskId)]);
      if (selectedIdRef.current !== taskId) return;
      if (isOlderTaskSnapshot(nextSelected.updatedAt, selectedUpdatedAtRef.current)) return;
      selectedUpdatedAtRef.current = nextSelected.updatedAt;
      startTransition(() => {
        setSelected(projectSelectedTask(nextSelected));
        setTasks((current) => upsertVisibleTask(current, nextSelected));
        applySelectedTranscript(taskId, nextTranscript);
      });
      markSyncSuccess();
    } finally {
      if (runningTaskSyncInFlightRef.current === taskId) runningTaskSyncInFlightRef.current = null;
    }
  }

  async function selectTask(taskId: string) {
    newTaskModeRef.current = false;
    selectedIdRef.current = taskId;
    transcriptHydrationRef.current[taskId] = false;
    setSelectedId(taskId);
    setSelectedChildren([]);
    setSelectedTranscript([]);
    const nextSelected = await api.getTask(taskId);
    if (selectedIdRef.current !== taskId) return;
    setSelected(projectSelectedTask(nextSelected));
    setTasks((current) => upsertVisibleTask(current, nextSelected));
    markSyncSuccess();
  }

  function clearSelection() {
    newTaskModeRef.current = true;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelected(null);
    setSelectedChildren([]);
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
        setSelectedChildren([]);
        setSelectedTranscript([]);
      }
      await refresh(wasSelected ? undefined : selectedIdRef.current);
    });
  }

  async function patchTask(taskId: string, input: TaskPatchRequest) {
    await run(async () => {
      const updated = await api.patchTask(taskId, input);
      if (selectedIdRef.current === taskId) {
        setSelected(projectSelectedTask(updated));
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

  async function getTaskStreamText(taskId: string, streamId: string, type: "assistant_delta" | "thinking_delta"): Promise<string> {
    const response = await api.getTaskStreamText(taskId, streamId, type);
    return response.text;
  }

  async function revertLatestTurn(taskId: string): Promise<string> {
    let draft = "";
    await run(async () => {
      const turns = await api.listTaskTurns(taskId);
      const latest = [...turns].reverse().find((turn) => turn.status === "active");
      if (!latest) throw new Error("No active user turn is available to revert.");
      const result = await api.revertTaskTurn(taskId, latest.id);
      draft = result.draft;
      setSelected(projectSelectedTask(result.task));
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
      setSelected(projectSelectedTask(result.task));
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
    setSelected(projectSelectedTask(task));
    setSelectedChildren([]);
    setSelectedTranscript(compactTaskEventsForTranscript(task.events));
    setTasks((current) => upsertVisibleTask(current, task));
    markSyncSuccess();
  }

  async function hydrateSelectedTask(taskId: string) {
    try {
      const nextSelected = await api.getTask(taskId);
      if (selectedIdRef.current !== taskId) return;
      setSelected(projectSelectedTask(nextSelected));
      setTasks((current) => upsertVisibleTask(current, nextSelected));
      markSyncSuccess();
    } catch (error) {
      recordBackgroundSyncFailure(error);
    }
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

  function markRealtimeSeen() {
    const now = Date.now();
    setLastRealtimeAt(now);
    setRealtimeStale(false);
    markSyncSuccess();
    if (realtimeStaleTimerRef.current !== null) window.clearTimeout(realtimeStaleTimerRef.current);
    realtimeStaleTimerRef.current = window.setTimeout(() => {
      setRealtimeStale(true);
    }, 25_000);
  }

  function closeRealtimeSocket(markStale: boolean) {
    if (realtimeStaleTimerRef.current !== null) {
      window.clearTimeout(realtimeStaleTimerRef.current);
      realtimeStaleTimerRef.current = null;
    }
    const socket = realtimeSocketRef.current;
    realtimeSocketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === 0) {
        socket.onopen = () => socket.close();
      } else if (socket.readyState === 1) {
        socket.close();
      }
    }
    setRealtimeConnected(false);
    if (markStale) setRealtimeStale(true);
  }

  function applyRealtimeMessage(taskId: string, data: unknown) {
    if (typeof data !== "string") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    if (payload["type"] === "snapshot") {
      const transcript = Array.isArray(payload["transcript"]) ? payload["transcript"] as TaskTranscriptItem[] : [];
      const events = Array.isArray(payload["events"]) ? payload["events"] as TaskEvent[] : [];
      applyRealtimeTaskShellEvents(taskId, events);
      if (transcript.length > 0) {
        applySelectedTranscript(taskId, transcript);
      } else if (events.length > 0) {
        queueSelectedTranscriptEvents(taskId, events);
      }
      return;
    }
    if (payload["type"] === "event" && isRecord(payload["event"])) {
      const event = payload["event"] as TaskEvent;
      applyRealtimeTaskShellEvents(taskId, [event]);
      queueSelectedTranscriptEvents(taskId, [event]);
    }
  }

  function applyRealtimeTaskShellEvents(taskId: string, events: TaskEvent[]) {
    if (events.length === 0) return;
    setSelected((current) => {
      if (!current || current.id !== taskId) return current;
      return applyTaskShellEvents(current, events);
    });
    setTasks((current) => current.map((task) => (task.id === taskId ? applyTaskShellEvents(task, events) : task)));
  }

  function queueSelectedTranscriptEvents(taskId: string, events: Array<TaskEvent | TaskTranscriptItem>) {
    if (events.length === 0) return;
    const queued = realtimeTranscriptQueueRef.current.get(taskId) ?? [];
    queued.push(...events);
    realtimeTranscriptQueueRef.current.set(taskId, queued);
    if (realtimeTranscriptFlushFrameRef.current !== null) return;
    realtimeTranscriptFlushFrameRef.current = window.requestAnimationFrame(() => {
      realtimeTranscriptFlushFrameRef.current = null;
      flushQueuedRealtimeTranscript();
    });
  }

  function flushQueuedRealtimeTranscript() {
    const queued = realtimeTranscriptQueueRef.current;
    realtimeTranscriptQueueRef.current = new Map();
    for (const [taskId, events] of queued) {
      appendSelectedTranscript(taskId, events);
    }
  }

  function applySelectedTranscript(taskId: string, transcript: TaskTranscriptItem[]) {
    transcriptHydrationRef.current[taskId] = true;
    if (selectedIdRef.current !== taskId) return;
    const nextTranscript = appendTranscriptEvents([], transcript);
    setSelectedTranscript((current) => (
      transcriptSignature(current) === transcriptSignature(nextTranscript) ? current : nextTranscript
    ));
  }

  function appendSelectedTranscript(taskId: string, events: Array<TaskEvent | TaskTranscriptItem>) {
    transcriptHydrationRef.current[taskId] = true;
    if (selectedIdRef.current !== taskId) return;
    setSelectedTranscript((current) => {
      const nextTranscript = appendTranscriptEvents(current, events);
      return transcriptSignature(current) === transcriptSignature(nextTranscript) ? current : nextTranscript;
    });
  }

  return {
    tasks,
    taskFolders,
    selected,
    selectedChildren,
    selectedTranscript,
    selectedId,
    skills,
    skillConflicts,
    skillCurator,
    skillDuplicates,
    permissions,
    preferences,
    curatorRuns,
    projectMemories,
    knowledgeItems,
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
    getTaskStreamText,
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

function shouldRunVisibleTaskSync(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function isOlderTaskSnapshot(incomingUpdatedAt: string | null | undefined, currentUpdatedAt: string | null | undefined): boolean {
  if (!incomingUpdatedAt || !currentUpdatedAt) return false;
  const incomingTime = Date.parse(incomingUpdatedAt);
  const currentTime = Date.parse(currentUpdatedAt);
  if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) return incomingTime < currentTime;
  return incomingUpdatedAt < currentUpdatedAt;
}

function transcriptSignature(events: TaskTranscriptItem[]): string {
  if (events.length === 0) return "empty";
  return events.map((event) => {
    const streamText = streamDeltaText(event);
    return [
      event.id,
      event.type,
      event.createdAt,
      textFingerprint(event.summary ?? ""),
      textFingerprint(streamText),
      payloadTextFingerprint(event, "message"),
      payloadTextFingerprint(event, "output"),
      payloadTextFingerprint(event, "summary")
    ].join(":");
  }).join("|");
}

function payloadTextFingerprint(event: TaskTranscriptItem, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? textFingerprint(value) : "0:0";
}

function textFingerprint(value: string): string {
  if (!value) return "0:0";
  const sample = value.length <= 2048
    ? value
    : `${value.slice(0, 768)}${value.slice(Math.max(0, Math.floor(value.length / 2) - 256), Math.floor(value.length / 2) + 256)}${value.slice(-768)}`;
  let hash = 2166136261;
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
}

function upsertTask(tasks: TaskDetail[], task: TaskDetail): TaskDetail[] {
  const existingIndex = tasks.findIndex((item) => item.id === task.id);
  if (existingIndex < 0) return [task, ...tasks];
  const next = [...tasks];
  next[existingIndex] = task;
  return next;
}

function upsertVisibleTask(tasks: TaskDetail[], task: TaskDetail): TaskDetail[] {
  if (task.kind === "subagent") return tasks.filter((item) => item.id !== task.id);
  return upsertTask(tasks, task);
}

function isRunningChildSummary(child: TaskChildSummary): boolean {
  return child.status === "running" || child.status === "waiting_approval" || child.status === "waiting_for_user";
}

function hasSubagentLifecycleMarker(events: TaskEvent[]): boolean {
  return events.some((event) =>
    event.type === "subagent_spawned" ||
    event.type === "subagent_status_changed" ||
    event.type === "subagent_completed" ||
    event.type === "subagent_failed"
  );
}

function isRealtimeDrivenTaskStatus(status: TaskDetail["status"]): boolean {
  return status === "running" || status === "waiting_for_user" || status === "waiting_approval";
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function laterIso(current: string, incoming: string): string {
  return incoming.localeCompare(current) > 0 ? incoming : current;
}

function taskStatusFromUnknown(value: unknown): TaskDetail["status"] | null {
  return value === "running" ||
    value === "waiting_approval" ||
    value === "waiting_for_user" ||
    value === "completed" ||
    value === "paused" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}

export function compactTaskEventsForTranscript(events: TaskEvent[]): TaskTranscriptItem[] {
  return appendTranscriptEvents([], events);
}

export function mergeSelectedTaskShell(current: TaskDetail | null, incoming: TaskDetail): TaskDetail {
  if (!current || current.id !== incoming.id) return incoming;
  if (isOlderTaskSnapshot(incoming.updatedAt, current.updatedAt)) return current;
  const preserveEvents = incoming.events.length === 0 && current.events.length > 0;
  const preservePendingGuidance = incoming.pendingGuidance.length === 0 && current.pendingGuidance.length > 0;
  return {
    ...current,
    ...incoming,
    events: preserveEvents ? current.events : incoming.events,
    pendingGuidance: preservePendingGuidance ? current.pendingGuidance : incoming.pendingGuidance
  };
}

export function applyTaskShellEvents(task: TaskDetail, events: TaskEvent[]): TaskDetail {
  let next = task;
  for (const event of events) {
    if (event.taskId !== task.id || event.reverted) continue;
    const updated = applyTaskShellEvent(next, event);
    if (updated !== next) next = updated;
  }
  return next;
}

function applyTaskShellEvent(task: TaskDetail, event: TaskEvent): TaskDetail {
  if (event.type === "task_title_updated") {
    const newTitle = stringFromUnknown(event.payload["newTitle"]) || stringFromUnknown(event.payload["title"]) || event.summary;
    const title = newTitle.trim();
    if (!title || title === task.title) return task;
    return {
      ...task,
      title,
      updatedAt: laterIso(task.updatedAt, event.createdAt)
    };
  }
  if (event.type === "status_changed") {
    const status = taskStatusFromUnknown(event.summary || event.payload["status"]);
    if (!status || status === task.status) return task;
    return {
      ...task,
      status,
      updatedAt: laterIso(task.updatedAt, event.createdAt)
    };
  }
  return task;
}

function projectSelectedTask(task: TaskDetail): TaskDetail {
  const events = compactSelectedTaskEvents(task.events);
  return events === task.events ? task : { ...task, events };
}

function compactSelectedTaskEvents(events: TaskEvent[]): TaskEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events;
  let changed = false;
  const next: TaskEvent[] = [];
  for (const event of events) {
    if (event.type === "assistant_delta" || event.type === "thinking_delta") {
      changed = true;
      continue;
    }
    next.push(event);
  }
  return changed ? next : events;
}

function appendTranscriptEvents(current: TaskTranscriptItem[], events: Array<TaskEvent | TaskTranscriptItem>): TaskTranscriptItem[] {
  const next = [...current];
  const seen = new Set(next.map((event) => event.id));
  for (const event of coalesceIncomingStreamEvents(events)) {
    if (seen.has(event.id) || !isClientTranscriptEvent(event)) continue;
    if (event.payload["uiHidden"] === true) continue;
    if (isInlineToolMarkupEvent(event)) continue;
    seen.add(event.id);
    let compact = compactLiveTranscriptEvent(event);
    if (compact.type === "assistant_message") {
      const payloadBody = assistantPayloadBody(compact);
      if (!compact.summary && payloadBody) {
        compact = { ...compact, summary: payloadBody };
      }
      const streamId = String(compact.payload["streamId"] ?? "");
      if (streamId) {
        const fallback = stripToolEvidenceBoilerplate(compact.summary) ? "" : assistantFallbackForStream(next, streamId);
        next.splice(0, next.length, ...next.filter((item) => !isAssistantDeltaForStream(item, streamId)));
        if (fallback) {
          compact = {
            ...compact,
            summary: fallback,
            payload: {
              ...compact.payload,
              streamFinalFallback: true
            }
          };
        }
      }
      if (!stripToolEvidenceBoilerplate(compact.summary)) continue;
    }
    if (compact.type === "assistant_delta" && hasAssistantFinalForStream(next, String(compact.payload["streamId"] ?? ""))) continue;
    if (mergeAdjacentStreamDelta(next, compact)) {
      continue;
    }
    next.push(compact);
  }
  return next;
}

function coalesceIncomingStreamEvents<T extends TaskEvent | TaskTranscriptItem>(events: T[]): T[] {
  if (events.length <= 1) return events;
  const merged: T[] = [];
  for (const event of events) {
    if (mergeAdjacentStreamDelta(merged, event)) continue;
    merged.push(event);
  }
  return merged;
}

function assistantFallbackForStream(events: TaskTranscriptItem[], streamId: string): string {
  return events
    .filter((event) => event.type === "assistant_delta" && String(event.payload["streamId"] ?? "") === streamId)
    .map((event) => streamDeltaText(event))
    .filter((value) => stripToolEvidenceBoilerplate(value).length > 0)
    .reduce((current, delta) => appendStreamDeltaText(current, delta), "")
    .trim();
}

function isAssistantDeltaForStream(event: TaskTranscriptItem, streamId: string): boolean {
  return event.type === "assistant_delta" && String(event.payload["streamId"] ?? "") === streamId;
}

function hasAssistantFinalForStream(events: TaskTranscriptItem[], streamId: string): boolean {
  return Boolean(streamId) && events.some((event) => event.type === "assistant_message" && String(event.payload["streamId"] ?? "") === streamId);
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
  const mergedDelta = appendStreamDeltaText(currentDelta, incomingDelta);
  const mergedSummary = appendStreamDeltaText(current.summary ?? "", incoming.summary ?? incomingDelta);
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

function appendStreamDeltaText(current: string, delta: string): string {
  if (!current) return current + delta;
  return `${current}${streamDeltaSeparator(current, delta)}${delta}`;
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

function compactLiveTranscriptEvent(event: TaskEvent | TaskTranscriptItem): TaskTranscriptItem {
  if (event.type === "assistant_message" || event.type === "assistant_delta") {
    const summary = stripToolEvidenceBoilerplate(event.summary);
    return {
      ...event,
      summary: summary || assistantPayloadBody(event),
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
  return stripInlineToolMarkup(value)
    .split(/\r?\n/)
    .filter((line) => !/^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assistantPayloadBody(event: TaskEvent | TaskTranscriptItem): string {
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return "";
  for (const key of ["message", "text", "delta"]) {
    const value = event.payload[key];
    if (typeof value !== "string") continue;
    const visible = stripToolEvidenceBoilerplate(value);
    if (visible) return visible;
  }
  return "";
}

function stripInlineToolMarkup(value: string): string {
  return value
    .replace(/<function_calls\b[\s\S]*?<\/function_calls>/gi, "\n")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "\n");
}

function normalizeTranscriptTruncationMarker(value: string): string {
  return value.replace(
    /\[UI preview truncated: (\d+) characters omitted\. Full evidence is retained by (?:Agent Workbench|SCC Agent Workbench)\.\]/g,
    "[Output truncated: $1 characters omitted. Full evidence is available in the audit log.]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runIdleDataPreloadQueue(jobs: Array<() => Promise<void>>, onError: (error: unknown) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  let cancelled = false;
  let idleHandle: number | null = null;
  let timeoutHandle: number | null = null;

  const clearScheduled = () => {
    if (idleHandle !== null) {
      window.cancelIdleCallback?.(idleHandle);
      idleHandle = null;
    }
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const scheduleNext = () => {
    if (cancelled) return;
    const runNext = () => {
      idleHandle = null;
      timeoutHandle = null;
      if (cancelled) return;
      const job = jobs.shift();
      if (!job) return;
      void job()
        .catch(onError)
        .finally(() => {
          scheduleNext();
        });
    };
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(runNext, { timeout: 3000 });
    } else {
      timeoutHandle = window.setTimeout(runNext, 450);
    }
  };

  scheduleNext();
  return () => {
    cancelled = true;
    clearScheduled();
  };
}

function isClientTranscriptEvent(event: TaskEvent | null | undefined): boolean {
  if (!event) return false;
  return (
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_message" ||
    event.type === "thinking_delta" ||
    event.type === "subagent_spawned" ||
    event.type === "subagent_status_changed" ||
    event.type === "subagent_completed" ||
    event.type === "subagent_failed" ||
    event.type === "guidance_pending" ||
    event.type === "user_input_requested" ||
    event.type === "user_input_answered" ||
    event.type === "approval_pending" ||
    event.type === "tool_requested" ||
    event.type === "tool_started" ||
    event.type === "tool_progress" ||
    event.type === "tool_result" ||
    event.type === "model_empty_response" ||
    event.type === "model_no_progress" ||
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
  return /<function_calls\b|<invoke\s+name=/i.test(text) && !stripToolEvidenceBoilerplate(text);
}
