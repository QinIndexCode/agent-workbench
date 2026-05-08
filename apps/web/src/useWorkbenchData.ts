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
  const [selectedTranscript, setSelectedTranscript] = useState<TaskTranscriptItem[]>([]);
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
  const wsEventQueueRef = useRef<TaskEvent[]>([]);
  const wsFlushTimerRef = useRef<number | null>(null);
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
    if (id) {
      const [nextSelected, nextTranscript] = await Promise.all([api.getTask(id), api.listTaskTranscript(id)]);
      setSelected(nextSelected);
      setSelectedTranscript(nextTranscript);
    } else {
      setSelected(null);
      setSelectedTranscript([]);
    }
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
    wsEventQueueRef.current = [];
    if (wsFlushTimerRef.current !== null) {
      window.clearTimeout(wsFlushTimerRef.current);
      wsFlushTimerRef.current = null;
    }
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
        if (parsed.type === "snapshot") {
          wsEventQueueRef.current = [];
          if (wsFlushTimerRef.current !== null) {
            window.clearTimeout(wsFlushTimerRef.current);
            wsFlushTimerRef.current = null;
          }
          setSelected((current) => {
            if (!current || current.id !== selectedId) return current;
            return { ...current, events: parsed.events };
          });
          if (parsed.transcript) {
            setSelectedTranscript(parsed.transcript);
          } else {
            void api.listTaskTranscript(selectedId).then((transcript) => {
              if (!wsCancelRef.current && selectedIdRef.current === selectedId) setSelectedTranscript(transcript);
            }).catch(() => undefined);
          }
          return;
        }
        wsEventQueueRef.current.push(parsed.event);
        scheduleRealtimeFlush(selectedId);
      };
    }, 50);
    return () => {
      wsCancelRef.current = true;
      window.clearTimeout(connectTimer);
      wsEventQueueRef.current = [];
      if (wsFlushTimerRef.current !== null) {
        window.clearTimeout(wsFlushTimerRef.current);
        wsFlushTimerRef.current = null;
      }
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.close();
      }
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
        const seen = new Set(current.events.map((event) => event.id));
        const nextEvents = [...current.events];
        let nextApprovals = current.approvals;
        let updatedAt = current.updatedAt;
        for (const event of queued) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          nextEvents.push(event);
          nextApprovals = approvalFromEvent(event, nextApprovals);
          updatedAt = event.createdAt;
        }
        if (nextEvents.length === current.events.length) return current;
        return { ...current, events: nextEvents, approvals: nextApprovals, updatedAt };
      });
      setSelectedTranscript((current) => appendTranscriptEvents(current, queued));
    }, 40);
  }

  async function selectTask(taskId: string) {
    newTaskModeRef.current = false;
    selectedIdRef.current = taskId;
    setSelectedId(taskId);
    const [nextSelected, nextTranscript] = await Promise.all([api.getTask(taskId), api.listTaskTranscript(taskId)]);
    setSelected(nextSelected);
    setSelectedTranscript(nextTranscript);
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
        setSelectedTranscript(await api.listTaskTranscript(taskId));
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
      setSelectedTranscript(await api.listTaskTranscript(taskId));
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
      newTaskModeRef.current = false;
      selectedIdRef.current = task.id;
      setSelectedId(task.id);
      setSelected(task);
      setSelectedTranscript(await api.listTaskTranscript(task.id));
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
  | { type: "snapshot"; events: TaskEvent[]; transcript?: TaskTranscriptItem[] }
  | { type: "event"; event: TaskEvent }
  | null {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    if (parsed["type"] === "snapshot" && Array.isArray(parsed["events"])) {
      return {
        type: "snapshot",
        events: parsed["events"] as TaskEvent[],
        ...(Array.isArray(parsed["transcript"]) ? { transcript: parsed["transcript"] as TaskTranscriptItem[] } : {})
      };
    }
    if (parsed["type"] === "event" && typeof parsed["event"] === "object" && parsed["event"]) {
      return { type: "event", event: parsed["event"] as TaskEvent };
    }
    return null;
  } catch {
    return null;
  }
}

function appendTranscriptEvents(current: TaskTranscriptItem[], events: TaskEvent[]): TaskTranscriptItem[] {
  const next = [...current];
  const seen = new Set(next.map((event) => event.id));
  for (const event of events) {
    if (seen.has(event.id) || !isClientTranscriptEvent(event)) continue;
    if (isInlineToolMarkupEvent(event)) continue;
    seen.add(event.id);
    next.push(compactLiveTranscriptEvent(event));
  }
  return next;
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

function isClientTranscriptEvent(event: TaskEvent): boolean {
  return (
    event.type === "user_message" ||
    event.type === "attachment_added" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_message" ||
    event.type === "thinking_delta" ||
    event.type === "guidance_pending" ||
    event.type === "approval_pending" ||
    event.type === "tool_result" ||
    event.type === "task_checkpoint_created" ||
    event.type === "task_rollback_completed" ||
    event.type === "task_rollback_failed" ||
    event.type === "plan_step_blocked" ||
    event.type === "web_search_result"
  );
}

function isInlineToolMarkupEvent(event: TaskEvent): boolean {
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return false;
  const text = [
    event.summary,
    typeof event.payload["message"] === "string" ? event.payload["message"] : "",
    typeof event.payload["delta"] === "string" ? event.payload["delta"] : "",
    typeof event.payload["text"] === "string" ? event.payload["text"] : ""
  ]
    .filter(Boolean)
    .join("\n");
  return /<function_calls\b|<invoke\s+name=/i.test(text);
}
