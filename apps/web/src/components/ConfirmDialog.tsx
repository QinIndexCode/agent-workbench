import type { ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";

export function ConfirmDialog({
  cancelLabel,
  children,
  confirmLabel,
  open,
  title,
  tone = "danger",
  onCancel,
  onConfirm
}: {
  cancelLabel: string;
  children: ReactNode;
  confirmLabel: string;
  open: boolean;
  title: string;
  tone?: "danger" | "neutral";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section aria-modal="true" className="confirmDialog" role="dialog" aria-labelledby="confirm-dialog-title">
        <header className="dialogHeader">
          <div className="confirmTitle">
            <span className={tone === "danger" ? "confirmIcon danger" : "confirmIcon"}>
              <AlertTriangle size={17} aria-hidden="true" />
            </span>
            <h3 id="confirm-dialog-title">{title}</h3>
          </div>
          <button aria-label={cancelLabel} className="iconButton" type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <div className="confirmBody">{children}</div>
        <footer className="dialogActions">
          <button className="subtleButton" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={tone === "danger" ? "dangerButton" : "subtleButton"} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
