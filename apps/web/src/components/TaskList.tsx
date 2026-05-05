import type { TaskDeleteRequest, TaskDetail } from "@scc/shared";
import { BookOpen, Clock3, FileText, HelpCircle, Plus, Search, Settings, Terminal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export type EngineStatus = "running" | "streaming" | "attention";

export function TaskList({
  language,
  open,
  tasks,
  selectedId,
  activeView,
  engineStatus,
  onClose,
  onDelete,
  onOpenDocs,
  onOpenHistory,
  onOpenLibrary,
  onSelect,
  onNewTask,
  onOpenSettings,
  onOpenSupport
}: {
  language?: string | null;
  open: boolean;
  tasks: TaskDetail[];
  selectedId: string | null;
  activeView: "tasks" | "history" | "library" | "docs" | "settings";
  engineStatus: EngineStatus;
  onClose: () => void;
  onDelete: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  onOpenDocs: () => void;
  onOpenHistory?: () => void;
  onOpenLibrary: () => void;
  onSelect: (taskId: string) => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
  onOpenSupport: () => void;
}) {
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteLearningData, setDeleteLearningData] = useState(false);
  const [deleteDerivedSkills, setDeleteDerivedSkills] = useState(false);
  const text = getUiCopy(language).shell;
  const confirmingTask = confirmingId ? tasks.find((task) => task.id === confirmingId) ?? null : null;
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => `${task.title} ${task.status}`.toLowerCase().includes(normalized));
  }, [query, tasks]);

  return (
    <>
      <button
        aria-label="Close task list"
        className={open ? "taskDrawerBackdrop open" : "taskDrawerBackdrop"}
        onClick={onClose}
        type="button"
      />
      <aside className={open ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brandIcon">
            <Terminal size={17} />
          </span>
          <span className="brandCopy">
            <strong>SCC</strong>
            <small>{text.engineStatus[engineStatus]}</small>
          </span>
          <button className="closeDrawerButton" onClick={onClose} type="button">
            {text.close}
          </button>
        </div>
        <div className="sidebarNav" aria-label={text.navigation}>
          <button
            className={activeView === "tasks" ? "sidebarNavButton primary selected" : "sidebarNavButton primary"}
            onClick={() => {
              setHistoryOpen(false);
              onNewTask();
            }}
            type="button"
          >
            <Plus size={16} />
            {text.newTask}
          </button>
          <button
            className={activeView === "history" ? "sidebarNavButton selected" : "sidebarNavButton"}
            onClick={() => {
              setHistoryOpen(false);
              onOpenHistory?.();
            }}
            type="button"
          >
            <Clock3 size={16} />
            {text.history}
          </button>
          <button className={activeView === "library" ? "sidebarNavButton selected" : "sidebarNavButton"} onClick={onOpenLibrary} type="button">
            <BookOpen size={16} />
            {text.library}
          </button>
          <button className={activeView === "settings" ? "sidebarNavButton selected" : "sidebarNavButton"} onClick={onOpenSettings} type="button">
            <Settings size={16} />
            {text.settings}
          </button>
        </div>
        <div className={historyOpen ? "historyPanel open" : "historyPanel"} aria-hidden={!historyOpen}>
          <label className="taskSearch">
            <Search aria-hidden="true" size={14} />
            <input
              aria-label={text.searchTasks}
              placeholder={text.searchTasks}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav className="taskList" aria-label="Task list">
            {visibleTasks.length === 0 ? <p className="sidebarEmpty">{tasks.length === 0 ? text.noTasks : text.noMatchingTasks}</p> : null}
            {visibleTasks.map((task) => (
              <div className={activeView === "tasks" && task.id === selectedId ? "taskItem selected" : "taskItem"} key={task.id}>
                <button
                  className="taskItemMain"
                  onClick={() => {
                    setHistoryOpen(true);
                    onSelect(task.id);
                  }}
                  type="button"
                >
                  <span>{task.title}</span>
                  <small>{task.status.replace("_", " ")}</small>
                </button>
                <button
                  aria-label={`${text.deleteTask} ${task.title}`}
                  className="taskDeleteButton"
                  onClick={() => {
                    setConfirmingId(task.id);
                    setDeleteLearningData(false);
                    setDeleteDerivedSkills(false);
                  }}
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </nav>
        </div>
        <div className="sidebarUtility">
          <button className="sidebarUtilityButton" onClick={onOpenSupport} type="button">
            <HelpCircle size={15} />
            {text.support}
          </button>
          <button className="sidebarUtilityButton" onClick={onOpenDocs} type="button">
            <FileText size={15} />
            {text.docs}
          </button>
        </div>
      </aside>
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.delete}
        open={Boolean(confirmingTask)}
        title={text.deleteTaskTitle}
        onCancel={() => setConfirmingId(null)}
        onConfirm={() => {
          if (!confirmingTask) return;
          void onDelete(confirmingTask.id, { deleteLearningData, deleteDerivedSkills }).then(() => setConfirmingId(null));
        }}
      >
        <div className="deleteOptions">
          <p>{confirmingTask?.status === "running" || confirmingTask?.status === "waiting_approval" ? text.deleteRunning : text.deleteThread}</p>
          <label>
            <input
              checked={deleteLearningData}
              onChange={(event) => {
                setDeleteLearningData(event.target.checked);
                if (!event.target.checked) setDeleteDerivedSkills(false);
              }}
              type="checkbox"
            />
            {text.deleteLearning}
          </label>
          <label className={!deleteLearningData ? "disabledOption" : ""}>
            <input
              checked={deleteDerivedSkills}
              disabled={!deleteLearningData}
              onChange={(event) => setDeleteDerivedSkills(event.target.checked)}
              type="checkbox"
            />
            {text.deleteDerivedSkills}
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}
