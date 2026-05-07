import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

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
    <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <section aria-modal="true" className="confirmDialog stdModal stdModalNarrow" role="dialog" aria-labelledby="confirm-dialog-title">
        <div className="stdHeader">
          <h3 id="confirm-dialog-title">{title}</h3>
          <button className="stdClose" type="button" onClick={onCancel}>×</button>
        </div>
        <div className="stdBody">
          <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
            <span className={tone === "danger" ? "confirmIcon danger" : "confirmIcon"} style={{ marginTop: 2 }}>
              <AlertTriangle size={17} aria-hidden="true" />
            </span>
            {children}
          </div>
        </div>
        <div className="stdFooter">
          <button className="stdCancelBtn" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={tone === "danger" ? "dangerButton" : "primaryInlineButton"} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
