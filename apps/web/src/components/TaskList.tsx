import type { TaskDeleteRequest, TaskDetail, TaskFolderClearRequest, TaskFolderRecord } from "@scc/shared";
import { BookOpen, Clock3, Edit3, FileText, Folder, FolderPlus, HelpCircle, Plus, Search, Settings, Terminal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { getUiCopy } from "../i18n.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export type EngineStatus = "running" | "streaming" | "attention";

export function TaskList({
  language,
  open,
  tasks,
  folders,
  selectedId,
  activeFolderId,
  activeView,
  engineStatus,
  onClose,
  onDelete,
  onClearFolder,
  onCreateFolder,
  onOpenDocs,
  onOpenHistory,
  onOpenLibrary,
  onSelect,
  onFolderSelect,
  onUpdateFolder,
  onNewTask,
  onOpenSettings,
  onOpenSupport
}: {
  language?: string | null;
  open: boolean;
  tasks: TaskDetail[];
  folders: TaskFolderRecord[];
  selectedId: string | null;
  activeFolderId: string;
  activeView: "tasks" | "history" | "library" | "docs" | "settings";
  engineStatus: EngineStatus;
  onClose: () => void;
  onDelete: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  onClearFolder: (folderId: string, options: TaskFolderClearRequest) => Promise<void>;
  onCreateFolder: (name: string) => Promise<void>;
  onOpenDocs: () => void;
  onOpenHistory?: () => void;
  onOpenLibrary: () => void;
  onSelect: (taskId: string) => void;
  onFolderSelect: (folderId: string) => void;
  onUpdateFolder: (folderId: string, name: string) => Promise<void>;
  onNewTask: () => void;
  onOpenSettings: () => void;
  onOpenSupport: () => void;
}) {
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [clearingFolderId, setClearingFolderId] = useState<string | null>(null);
  const [folderEditor, setFolderEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [deleteLearningData, setDeleteLearningData] = useState(false);
  const [deleteDerivedSkills, setDeleteDerivedSkills] = useState(false);
  const text = getUiCopy(language).shell;
  const confirmingTask = confirmingId ? tasks.find((task) => task.id === confirmingId) ?? null : null;
  const folderItems = useMemo(
    () => [
      { id: "all", name: text.allTasks, system: true },
      { id: "default", name: text.defaultFolder, system: true },
      ...folders.filter((folder) => folder.id !== "default").map((folder) => ({ id: folder.id, name: folder.name, system: false }))
    ],
    [folders, text.allTasks, text.defaultFolder]
  );
  const activeFolder = folderItems.find((folder) => folder.id === activeFolderId) ?? folderItems[0]!;
  const clearingFolder = clearingFolderId ? folderItems.find((folder) => folder.id === clearingFolderId) ?? null : null;
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>([["all", tasks.length]]);
    for (const task of tasks) {
      const folderId = task.folderId || "default";
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const folderId = task.folderId || "default";
      const folderMatch = activeFolderId === "all" || folderId === activeFolderId;
      const queryMatch = !normalized || `${task.title} ${task.status}`.toLowerCase().includes(normalized);
      return folderMatch && queryMatch;
    });
  }, [activeFolderId, query, tasks]);

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
            className="sidebarNavButton primary"
            onClick={() => {
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
        <section className="folderPanel" aria-label={text.folders}>
          <div className="folderPanelHeader">
            <span>{text.folders}</span>
            <button aria-label={text.addFolder} className="folderIconButton" type="button" onClick={() => setFolderEditor({ id: null, name: "" })}>
              <FolderPlus size={14} />
            </button>
          </div>
          <nav className="folderList" aria-label={text.folders}>
            {folderItems.map((folder) => (
              <div className={folder.id === activeFolderId ? "folderItem selected" : "folderItem"} key={folder.id}>
                <button className="folderItemMain" type="button" onClick={() => onFolderSelect(folder.id)}>
                  <Folder size={14} />
                  <span>{folder.name}</span>
                  <small>{text.folderTasks(folderCounts.get(folder.id) ?? 0)}</small>
                </button>
                {!folder.system ? (
                  <button aria-label={`${text.editFolder} ${folder.name}`} className="folderIconButton" type="button" onClick={() => setFolderEditor({ id: folder.id, name: folder.name })}>
                    <Edit3 size={13} />
                  </button>
                ) : null}
                <button
                  aria-label={`${text.clearFolder} ${folder.name}`}
                  className="folderIconButton dangerIcon"
                  disabled={(folderCounts.get(folder.id) ?? 0) === 0}
                  type="button"
                  onClick={() => {
                    setClearingFolderId(folder.id);
                    setDeleteLearningData(false);
                    setDeleteDerivedSkills(false);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </nav>
        </section>
        <section className="historyPanel open" aria-label={activeFolder.name}>
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
        </section>
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
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={folderEditor?.id ? text.editFolder : text.addFolder}
        open={Boolean(folderEditor)}
        title={folderEditor?.id ? text.editFolder : text.addFolder}
        onCancel={() => setFolderEditor(null)}
        onConfirm={() => {
          if (!folderEditor?.name.trim()) return;
          const action = folderEditor.id ? onUpdateFolder(folderEditor.id, folderEditor.name.trim()) : onCreateFolder(folderEditor.name.trim());
          void action.then(() => setFolderEditor(null));
        }}
      >
        <label className="folderEditField">
          <span>{text.folderName}</span>
          <input autoFocus value={folderEditor?.name ?? ""} onChange={(event) => setFolderEditor((current) => current ? { ...current, name: event.target.value } : current)} />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.clearFolder}
        open={Boolean(clearingFolder)}
        title={text.clearFolderTitle}
        onCancel={() => setClearingFolderId(null)}
        onConfirm={() => {
          if (!clearingFolder) return;
          void onClearFolder(clearingFolder.id, { deleteLearningData, deleteDerivedSkills }).then(() => setClearingFolderId(null));
        }}
      >
        <div className="deleteOptions">
          <p>{clearingFolder ? text.clearFolderBody(clearingFolder.name) : ""}</p>
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
