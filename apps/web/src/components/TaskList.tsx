import type { TaskDeleteRequest, TaskDetail, TaskFolderDeleteRequest, TaskFolderRecord, TaskPatchRequest } from "@agent-workbench/shared";
import { BookOpen, ChevronRight, Clock3, Edit3, FileText, Folder, FolderPlus, HelpCircle, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import logoBlackTheme from "../assets/logo/logo-blackTheme.png";
import logoWhiteTheme from "../assets/logo/logo-whiteTheme.png";
import { getUiCopy } from "../i18n.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FolderPickerDialog } from "./FolderPickerDialog.js";
import { TaskEditDialog } from "./TaskEditDialog.js";

export type EngineStatus = "running" | "streaming" | "attention";

export function TaskList({
  language,
  resolvedTheme = "dark",
  open,
  tasks,
  folders,
  selectedId,
  activeFolderId,
  activeView,
  engineStatus,
  onClose,
  onDelete,
  onDeleteFolder,
  onCreateFolder,
  onOpenDocs,
  onOpenHistory,
  onOpenLibrary,
  onSelect,
  onFolderSelect,
  onUpdateTask,
  onUpdateFolder,
  onNewTask,
  onOpenSettings,
  onOpenSupport
}: {
  language?: string | null;
  resolvedTheme?: "dark" | "light";
  open: boolean;
  tasks: TaskDetail[];
  folders: TaskFolderRecord[];
  selectedId: string | null;
  activeFolderId: string;
  activeView: "tasks" | "history" | "library" | "docs" | "settings";
  engineStatus: EngineStatus;
  onClose: () => void;
  onDelete: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  onDeleteFolder: (folderId: string, options: TaskFolderDeleteRequest) => Promise<void>;
  onCreateFolder: (name: string, rootPath: string) => Promise<void>;
  onOpenDocs: () => void;
  onOpenHistory?: () => void;
  onOpenLibrary: () => void;
  onSelect: (taskId: string) => void;
  onFolderSelect: (folderId: string) => void;
  onUpdateTask: (taskId: string, input: TaskPatchRequest) => Promise<void>;
  onUpdateFolder: (folderId: string, name: string, rootPath: string) => Promise<void>;
  onNewTask: () => void;
  onOpenSettings: () => void;
  onOpenSupport: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedFolderId, setExpandedFolderId] = useState<string>(activeFolderId);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [folderEditor, setFolderEditor] = useState<{ id: string | null; name: string; rootPath: string } | null>(null);
  const [taskEditorId, setTaskEditorId] = useState<string | null>(null);
  const [deleteLearningData, setDeleteLearningData] = useState(false);
  const [deleteDerivedSkills, setDeleteDerivedSkills] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [contentVisible, setContentVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number; visible: boolean }>({ text: "", x: 0, y: 0, visible: false });
  const draggingRef = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const preCollapseWidthRef = useRef(300);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const toggleButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mainButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const text = getUiCopy(language).shell;
  const confirmingTask = confirmingId ? tasks.find((task) => task.id === confirmingId) ?? null : null;
  const editingTask = taskEditorId ? tasks.find((task) => task.id === taskEditorId) ?? null : null;
  const editorFolders = useMemo<TaskFolderRecord[]>(() => {
    const hasDefault = folders.some((folder) => folder.id === "default");
    return hasDefault
      ? folders
      : [
          {
            id: "default",
            name: text.defaultFolder,
            rootPath: "",
            isDefault: true,
            exists: true,
            sortOrder: 0,
            createdAt: "",
            updatedAt: ""
          },
          ...folders
        ];
  }, [folders, text.defaultFolder]);
  const folderItems = useMemo(() => {
    return editorFolders.map((folder) => ({
        id: folder.id,
        name: displayFolderName(folder, text.defaultFolder),
        rootPath: folder.rootPath,
        system: folder.id === "default" || folder.isDefault,
        browseOnly: false
      }));
  }, [editorFolders, text.defaultFolder]);
  const deletingFolder = deletingFolderId ? folderItems.find((folder) => folder.id === deletingFolderId) ?? null : null;
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const folderId = task.folderId || "default";
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => `${task.title} ${task.status}`.toLowerCase().includes(normalized));
  }, [query, tasks]);

  const MIN_SIDEBAR_WIDTH = 200;
  const MAX_SIDEBAR_WIDTH = 480;

  useEffect(() => {
    const shell = document.querySelector(".shell") as HTMLElement | null;
    if (!shell) return;
    shell.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    if (open && collapsed) setCollapsed(false);
  }, [collapsed, open]);

  useEffect(() => {
    if (collapsed) {
      setContentVisible(false);
      setSidebarWidth((current) => {
        preCollapseWidthRef.current = current;
        return 52;
      });
      return;
    } else {
      setSidebarWidth(preCollapseWidthRef.current);
      const t = setTimeout(() => setContentVisible(true), 180);
      return () => clearTimeout(t);
    }
  }, [collapsed]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      event.preventDefault();
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const handleResizeStart: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    if (collapsed) return;
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const getFolderTasks = (folderId: string) => {
    return filteredTasks.filter((task) => (task.folderId || "default") === folderId);
  };

  return (
    <>
      <button
        aria-label="Close task list"
        className={open ? "taskDrawerBackdrop open" : "taskDrawerBackdrop"}
        onClick={onClose}
        type="button"
      />
      <button
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        className={collapsed ? "sidebarToggleButton collapsed" : "sidebarToggleButton"}
        title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        type="button"
        onClick={() => {
          setCollapsed(!collapsed);
        }}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <aside ref={sidebarRef} className={collapsed ? "sidebar collapsed" : open ? "sidebar open" : "sidebar"}>
        <div className="sidebarCollapsedRail">
          <button
            className="sidebarCollapsedIcon"
            onClick={() => {
              onNewTask();
            }}
            title={text.newTask}
            type="button"
          >
            <Plus size={18} />
          </button>
        </div>
        <div className={contentVisible ? "sidebarExpandedContent" : "sidebarExpandedContent contentHidden"}>
          <div className="brand">
            <span className="brandIcon">
              <img alt="" className="brandLogo" src={resolvedTheme === "light" ? logoWhiteTheme : logoBlackTheme} />
            </span>
            <span className="brandCopy">
              <strong>Agent Workbench</strong>
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
              title={text.newTask}
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
              title={text.history}
              type="button"
            >
              <Clock3 size={16} />
              {text.history}
            </button>
            <button className={activeView === "library" ? "sidebarNavButton selected" : "sidebarNavButton"} onClick={onOpenLibrary} title={text.library} type="button">
              <BookOpen size={16} />
              {text.library}
            </button>
          </div>
            <section className="folderPanel" aria-label={text.folders}>
              <div className="folderPanelHeader">
                <span className={searchOpen ? "folderPanelTitle hidden" : "folderPanelTitle"}>{text.folders}</span>
                <div className="folderPanelActions">
                  <button
                    aria-label={language === "zh-CN" ? "打开任务搜索" : "Open task search"}
                    className={searchOpen ? "folderIconButton searchHidden" : "folderIconButton"}
                    onClick={() => setSearchOpen(true)}
                    type="button"
                  >
                    <Search size={14} />
                  </button>
                  <button aria-label={text.addFolder} className="folderIconButton" type="button" onClick={() => setFolderEditor({ id: null, name: "", rootPath: "" })}>
                    <FolderPlus size={14} />
                  </button>
                </div>
                <div className={searchOpen ? "folderSearchWrap open" : "folderSearchWrap"}>
                  <Search aria-hidden="true" size={13} />
                  <input
                    aria-label={text.searchTasks}
                    autoFocus={searchOpen}
                    placeholder={text.searchTasks}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button
                    aria-label={text.close}
                    className="folderSearchClose"
                    onClick={() => {
                      setSearchOpen(false);
                      setQuery("");
                    }}
                    type="button"
                  >
                    <span aria-hidden="true">&times;</span>
                  </button>
                </div>
              </div>
              <nav className="folderTree" aria-label={text.folders}>
                {folderItems.map((folder) => {
                  const folderTasks = getFolderTasks(folder.id);
                  const isExpanded = expandedFolderId === folder.id;
                  return (
                    <div className={isExpanded ? "folderTreeItem expanded" : "folderTreeItem"} key={folder.id}>
                      <div className="folderTreeRow">
                        <button
                          ref={(el) => {
                            if (el) toggleButtonRefs.current.set(folder.id, el);
                          }}
                          aria-label={isExpanded ? text.collapseFolder(folder.name) : text.expandFolder(folder.name)}
                          className="folderTreeToggle"
                          type="button"
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedFolderId("");
                            } else {
                              setExpandedFolderId(folder.id);
                              onFolderSelect(folder.id);
                            }
                          }}
                          aria-expanded={isExpanded}
                        >
                          <ChevronRight
                            size={13}
                            className={isExpanded ? "folderTreeChevron open" : "folderTreeChevron"}
                          />
                        </button>
                        <button
                          ref={(el) => {
                            if (el) mainButtonRefs.current.set(folder.id, el);
                          }}
                          className="folderTreeMain"
                          type="button"
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedFolderId("");
                            } else {
                              setExpandedFolderId(folder.id);
                              onFolderSelect(folder.id);
                            }
                          }}
                          onMouseEnter={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setTooltip({
                              text: folder.rootPath ? `${folder.name}\n${folder.rootPath}` : folder.name,
                              x: rect.left,
                              y: rect.top - 8,
                              visible: true
                            });
                          }}
                          onMouseLeave={() => setTooltip((prev) => ({ ...prev, visible: false }))}
                        >
                          <Folder size={14} />
                          <span className="folderName">{folder.name.split(/[\\/]/).pop() || folder.name}</span>
                          <small className="folderTaskCount">{text.folderTasks(folderCounts.get(folder.id) ?? 0)}</small>
                        </button>
                        <button
                          aria-label={`${text.newTask} ${folder.name}`}
                          className="folderAddTaskButton"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onFolderSelect(folder.id);
                            onNewTask();
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        {!folder.browseOnly && !folder.system ? (
                          <button
                            aria-label={`${text.editFolder} ${folder.name}`}
                            className="folderEditButton"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setFolderEditor({ id: folder.id, name: folder.name, rootPath: folder.rootPath ?? "" });
                            }}
                          >
                            <Edit3 size={13} />
                          </button>
                        ) : null}
                        {!folder.system ? (
                          <button
                            aria-label={`${text.deleteFolder} ${folder.name}`}
                            className="folderDeleteButton"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeletingFolderId(folder.id);
                              setDeleteLearningData(false);
                              setDeleteDerivedSkills(false);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : null}
                      </div>
                      {isExpanded ? (
                        <div className="folderTaskList">
                          {folderTasks.length === 0 ? (
                            <p className="folderEmpty">{query ? text.noMatchingTasks : text.noTasks}</p>
                          ) : (
                            folderTasks.map((task) => (
                              <div className={activeView === "tasks" && task.id === selectedId ? "folderTaskItem taskItem selected" : "folderTaskItem taskItem"} key={task.id}>
                                <button
                                  className="folderTaskItemMain"
                                  onClick={() => {
                                    onSelect(task.id);
                                  }}
                                  type="button"
                                >
                                  <span>{task.title}</span>
                                  <small>{task.status.replace("_", " ")}</small>
                                </button>
                                <button
                                  aria-label={`${text.editTask} ${task.title}`}
                                  className="taskEditButton"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setTaskEditorId(task.id);
                                  }}
                                  type="button"
                                >
                                  <Edit3 size={14} />
                                </button>
                                <button
                                  aria-label={`${text.deleteTask} ${task.title}`}
                                  className="taskDeleteButton"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setConfirmingId(task.id);
                                    setDeleteLearningData(false);
                                    setDeleteDerivedSkills(false);
                                  }}
                                  type="button"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </nav>
            </section>
            <div className="sidebarUtility">
              <button
                aria-expanded={utilityOpen}
                className={utilityOpen ? "sidebarUtilityToggle open" : "sidebarUtilityToggle"}
                onClick={() => setUtilityOpen((v) => !v)}
                title={text.settings}
                type="button"
              >
                <Settings size={16} />
              </button>
              <div
                aria-hidden={!utilityOpen}
                className={utilityOpen ? "sidebarUtilityMenu open" : "sidebarUtilityMenu"}
              >
                <button
                  className={activeView === "settings" ? "sidebarUtilityItem selected" : "sidebarUtilityItem"}
                  onClick={() => {
                    onOpenSettings();
                    setUtilityOpen(false);
                  }}
                  tabIndex={utilityOpen ? 0 : -1}
                  type="button"
                >
                  <Settings size={14} />
                  {text.settings}
                </button>
                <button
                  className="sidebarUtilityItem"
                  onClick={onOpenSupport}
                  tabIndex={utilityOpen ? 0 : -1}
                  type="button"
                >
                  <HelpCircle size={14} />
                  {text.support}
                </button>
                <button
                  className="sidebarUtilityItem"
                  onClick={onOpenDocs}
                  tabIndex={utilityOpen ? 0 : -1}
                  type="button"
                >
                  <FileText size={14} />
                  {text.docs}
                </button>
              </div>
          </div>
        </div>
        <div className="sidebarResizeHandle" onMouseDown={handleResizeStart} />
      </aside>
      <div
        ref={tooltipRef}
        className="folderTooltip"
        style={{
          display: tooltip.visible ? "block" : "none",
          left: tooltip.x,
          top: tooltip.y,
          transform: "translateY(-100%)"
        }}
      >
        {tooltip.text}
      </div>
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
          <p>{confirmingTask?.status === "running" || confirmingTask?.status === "waiting_approval" || confirmingTask?.status === "waiting_for_user" ? text.deleteRunning : text.deleteThread}</p>
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
      <FolderPickerDialog
        cancelLabel={text.cancel}
        confirmLabel={folderEditor?.id ? text.editFolder : text.addFolder}
        initialName={folderEditor?.name ?? ""}
        initialPath={folderEditor?.rootPath ?? ""}
        nameLabel={text.folderName}
        open={Boolean(folderEditor)}
        pathLabel={text.folderPath}
        pathPlaceholder={text.folderPathPlaceholder}
        title={folderEditor?.id ? text.editFolder : text.addFolder}
        onCancel={() => setFolderEditor(null)}
        onConfirm={(input) => {
          const action = folderEditor?.id
            ? onUpdateFolder(folderEditor.id, input.name, input.rootPath)
            : onCreateFolder(input.name, input.rootPath);
          void action.then(() => setFolderEditor(null));
        }}
      />
      <TaskEditDialog
        cancelLabel={text.cancel}
        confirmLabel={text.save}
        folderLabel={text.taskFolder}
        folders={editorFolders}
        initialFolderId={editingTask?.folderId ?? "default"}
        initialTitle={editingTask?.title ?? ""}
        open={Boolean(editingTask)}
        title={text.editTaskTitle}
        titleLabel={text.taskTitle}
        onCancel={() => setTaskEditorId(null)}
        onConfirm={(input) => {
          if (!editingTask) return;
          void onUpdateTask(editingTask.id, input).then(() => setTaskEditorId(null));
        }}
      />
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.deleteFolder}
        open={Boolean(deletingFolder)}
        title={text.deleteFolderTitle}
        onCancel={() => setDeletingFolderId(null)}
        onConfirm={() => {
          if (!deletingFolder) return;
          void onDeleteFolder(deletingFolder.id, { deleteLearningData, deleteDerivedSkills }).then(() => setDeletingFolderId(null));
        }}
      >
        <div className="deleteOptions">
          {deletingFolder ? (
            <>
              <p className="dangerCopy">{text.deleteFolderBody(deletingFolder.name, folderCounts.get(deletingFolder.id) ?? 0)}</p>
              <p className="folderPathWarning">
                <strong>{text.folderPath}:</strong> {deletingFolder.rootPath || text.defaultFolder}
              </p>
              <p>{text.deleteFolderDiskSafe}</p>
            </>
          ) : null}
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

function displayFolderName(folder: TaskFolderRecord, defaultLabel: string): string {
  if (folder.id === "default" || folder.isDefault) return defaultLabel;
  return folder.name;
}
