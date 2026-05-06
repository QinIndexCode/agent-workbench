import { FolderOpen, X } from "lucide-react";
import { useState } from "react";

export function FolderPickerDialog({
  cancelLabel,
  confirmLabel,
  fieldLabel,
  open,
  placeholder,
  title,
  onCancel,
  onConfirm
}: {
  cancelLabel: string;
  confirmLabel: string;
  fieldLabel: string;
  open: boolean;
  placeholder: string;
  title: string;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const [path, setPath] = useState("");

  if (!open) return null;

  const handleConfirm = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
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
            <label htmlFor="folder-path">{fieldLabel}</label>
            <div className="folderPickerInputWrap">
              <input
                id="folder-path"
                type="text"
                placeholder={placeholder}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
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
