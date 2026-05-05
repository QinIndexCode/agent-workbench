import type { TaskDetail } from "@scc/shared";
import { Terminal } from "lucide-react";

export function TaskList({
  open,
  tasks,
  selectedId,
  onClose,
  onSelect
}: {
  open: boolean;
  tasks: TaskDetail[];
  selectedId: string | null;
  onClose: () => void;
  onSelect: (taskId: string) => void;
}) {
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
        <nav className="taskList" aria-label="Task list">
          {tasks.map((task) => (
            <button
              className={task.id === selectedId ? "taskItem selected" : "taskItem"}
              key={task.id}
              onClick={() => onSelect(task.id)}
            >
              <span>{task.title}</span>
              <small>{task.status.replace("_", " ")}</small>
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}
