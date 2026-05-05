import type { TaskDeleteRequest, TaskDetail } from "@scc/shared";
import { Plus, Search, Settings, Terminal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

export function TaskList({
  open,
  tasks,
  selectedId,
  activeView,
  onClose,
  onDelete,
  onSelect,
  onNewTask,
  onOpenSettings
}: {
  open: boolean;
  tasks: TaskDetail[];
  selectedId: string | null;
  activeView: "tasks" | "settings";
  onClose: () => void;
  onDelete: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  onSelect: (taskId: string) => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteLearningData, setDeleteLearningData] = useState(false);
  const [deleteDerivedSkills, setDeleteDerivedSkills] = useState(false);
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
          <Terminal size={18} />
          <span>SCC</span>
          <button className="closeDrawerButton" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <div className="sidebarActions">
          <button className="newTaskButton" onClick={onNewTask} type="button">
            <Plus size={16} />
            New Task
          </button>
          <button className={activeView === "settings" ? "iconNavButton selected" : "iconNavButton"} onClick={onOpenSettings} type="button">
            <Settings size={16} />
            Settings
          </button>
        </div>
        <label className="taskSearch">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav className="taskList" aria-label="Task list">
          {visibleTasks.length === 0 ? <p className="sidebarEmpty">{tasks.length === 0 ? "No tasks yet." : "No matching tasks."}</p> : null}
          {visibleTasks.map((task) => (
            <div className={activeView === "tasks" && task.id === selectedId ? "taskItem selected" : "taskItem"} key={task.id}>
              <button className="taskItemMain" onClick={() => onSelect(task.id)} type="button">
                <span>{task.title}</span>
                <small>{task.status.replace("_", " ")}</small>
              </button>
              <button
                aria-label={`Delete task ${task.title}`}
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
              {confirmingId === task.id ? (
                <div className="taskDeleteConfirm">
                  <div className="taskDeleteConfirmHeader">
                    <strong>Delete task?</strong>
                    <button aria-label="Cancel delete" onClick={() => setConfirmingId(null)} type="button">
                      <X size={14} />
                    </button>
                  </div>
                  <p>{task.status === "running" || task.status === "waiting_approval" ? "The current run will be stopped before deletion." : "The task thread and approvals will be removed."}</p>
                  <label>
                    <input
                      checked={deleteLearningData}
                      onChange={(event) => {
                        setDeleteLearningData(event.target.checked);
                        if (!event.target.checked) setDeleteDerivedSkills(false);
                      }}
                      type="checkbox"
                    />
                    Remove memories and experiences from this task
                  </label>
                  <label className={!deleteLearningData ? "disabledOption" : ""}>
                    <input
                      checked={deleteDerivedSkills}
                      disabled={!deleteLearningData}
                      onChange={(event) => setDeleteDerivedSkills(event.target.checked)}
                      type="checkbox"
                    />
                    Delete skills derived only from this task
                  </label>
                  <div className="taskDeleteActions">
                    <button onClick={() => setConfirmingId(null)} type="button">
                      Cancel
                    </button>
                    <button
                      className="dangerButton"
                      onClick={() => {
                        void onDelete(task.id, { deleteLearningData, deleteDerivedSkills }).then(() => setConfirmingId(null));
                      }}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
