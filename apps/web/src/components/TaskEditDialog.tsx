import { FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { TaskFolderRecord } from "@agent-workbench/shared";

export function TaskEditDialog({
  cancelLabel,
  confirmLabel,
  folderLabel,
  folders,
  initialFolderId,
  initialTitle,
  open,
  title,
  titleLabel,
  onCancel,
  onConfirm
}: {
  cancelLabel: string;
  confirmLabel: string;
  folderLabel: string;
  folders: TaskFolderRecord[];
  initialFolderId: string;
  initialTitle: string;
  open: boolean;
  title: string;
  titleLabel: string;
  onCancel: () => void;
  onConfirm: (input: { title: string; folderId: string }) => void;
}) {
  const [taskTitle, setTaskTitle] = useState(initialTitle);
  const [folderId, setFolderId] = useState(initialFolderId || "default");

  useEffect(() => {
    if (!open) return;
    setTaskTitle(initialTitle);
    setFolderId(initialFolderId || "default");
  }, [initialFolderId, initialTitle, open]);

  if (!open) return null;

  const normalizedFolders = folders.length > 0 ? folders : [];
  const canSave = taskTitle.trim().length > 0 && folderId.trim().length > 0;

  return (
    <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section aria-modal="true" className="confirmDialog taskEditDialog" role="dialog" aria-labelledby="task-edit-title">
        <header className="dialogHeader">
          <div className="confirmTitle">
            <span className="confirmIcon">
              <FileText size={17} aria-hidden="true" />
            </span>
            <h3 id="task-edit-title">{title}</h3>
          </div>
          <button aria-label={cancelLabel} className="iconButton" type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <div className="confirmBody">
          <div className="folderPickerField">
            <label htmlFor="task-edit-title-input">{titleLabel}</label>
            <input
              autoFocus
              id="task-edit-title-input"
              maxLength={120}
              type="text"
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
            />
          </div>
          <div className="folderPickerField">
            <span className="fieldLabel">{folderLabel}</span>
            <div className="folderChoiceList" role="listbox" aria-label={folderLabel}>
              {normalizedFolders.map((folder) => (
                <button
                  aria-selected={folder.id === folderId}
                  className={folder.id === folderId ? "folderChoice selected" : "folderChoice"}
                  key={folder.id}
                  onClick={() => setFolderId(folder.id)}
                  role="option"
                  type="button"
                >
                  <span>{folder.name}</span>
                  <small>{folder.rootPath}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="dialogActions">
          <button className="subtleButton" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="primaryButton" disabled={!canSave} type="button" onClick={() => onConfirm({ title: taskTitle.trim(), folderId })}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
