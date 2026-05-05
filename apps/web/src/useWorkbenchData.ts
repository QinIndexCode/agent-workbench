import { useEffect, useState } from "react";
import type {
  GlobalPermissionGrant,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  SkillRecord,
  TaskDetail,
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
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  reflections: ReflectionSession[];
  projectMemories: ProjectMemory[];
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
  const [permissions, setPermissions] = useState<GlobalPermissionGrant[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [reflections, setReflections] = useState<ReflectionSession[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(nextId = selectedId) {
    const [list, nextMemories, nextPatterns, nextSkills, nextPermissions, nextPreferences, nextReflections, nextProjectMemories] =
      await Promise.all([
        api.listTasks(),
        api.listTaskMemories(),
        api.listPatterns(),
        api.listSkills(),
        api.listGlobalPermissions(),
        api.getPreferences(),
        api.listReflections(),
        api.listProjectMemories()
      ]);
    setTasks(list);
    const id = nextId ?? list[0]?.id ?? null;
    setSelectedId(id);
    setSelected(id ? await api.getTask(id) : null);
    setMemories(nextMemories);
    setPatterns(nextPatterns);
    setSkills(nextSkills);
    setPermissions(nextPermissions);
    setPreferences(nextPreferences);
    setReflections(nextReflections);
    setProjectMemories(nextProjectMemories);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, []);

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
    permissions,
    preferences,
    reflections,
    projectMemories,
    busy,
    error,
    refresh,
    selectTask,
    runTaskAction,
    runSideAction
  };
}
