import { FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

export function FolderPickerDialog({
  cancelLabel,
  confirmLabel,
  nameLabel,
  open,
  initialName,
  initialPath,
  pathLabel,
  pathPlaceholder,
  title,
  onCancel,
  onConfirm
}: {
  cancelLabel: string;
  confirmLabel: string;
  nameLabel: string;
  open: boolean;
  initialName?: string;
  initialPath?: string;
  pathLabel: string;
  pathPlaceholder: string;
  title: string;
  onCancel: () => void;
  onConfirm: (input: { name: string; rootPath: string }) => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [path, setPath] = useState(initialPath ?? "");

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setPath(initialPath ?? "");
  }, [initialName, initialPath, open]);

  if (!open) return null;

  const handleConfirm = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    onConfirm({ name: name.trim() || folderNameFromPath(trimmed), rootPath: trimmed });
    setName("");
    setPath("");
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      handleConfirm();
    }
  };

  return (
    <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section aria-modal="true" className="confirmDialog folderPickerDialog" role="dialog" aria-labelledby="folder-picker-title">
        <header className="dialogHeader">
          <div className="confirmTitle">
            <span className="confirmIcon">
              <FolderOpen size={17} aria-hidden="true" />
            </span>
            <h3 id="folder-picker-title">{title}</h3>
          </div>
          <button aria-label={cancelLabel} className="iconButton" type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <div className="confirmBody">
          <div className="folderPickerField">
            <label htmlFor="folder-name">{nameLabel}</label>
            <input
              id="folder-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="folderPickerField">
            <label htmlFor="folder-path">{pathLabel}</label>
            <div className="folderPickerInputWrap">
              <input
                id="folder-path"
                type="text"
                placeholder={pathPlaceholder}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <span className="folderPickerBrowse" aria-hidden="true">
                <FolderOpen size={16} />
              </span>
            </div>
          </div>
        </div>
        <footer className="dialogActions">
          <button className="subtleButton" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className="primaryButton"
            type="button"
            onClick={handleConfirm}
            disabled={!path.trim()}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function folderNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "Folder";
}
