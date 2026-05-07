import { useEffect, useRef, type ReactNode } from "react";
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
  const dialogRef = useRef<HTMLElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement;
      const timer = window.setTimeout(() => {
        confirmButtonRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    } else if (previouslyFocusedRef.current) {
      previouslyFocusedRef.current.focus();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable.item(0);
        const last = focusable.item(focusable.length - 1);
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <section ref={dialogRef as React.RefObject<HTMLElement>} aria-modal="true" className="confirmDialog stdModal stdModalNarrow" role="dialog" aria-labelledby="confirm-dialog-title">
        <div className="stdHeader">
          <h3 id="confirm-dialog-title">{title}</h3>
          <button className="stdClose" type="button" onClick={onCancel} aria-label={cancelLabel}>×</button>
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
          <button ref={confirmButtonRef} className={tone === "danger" ? "dangerButton" : "primaryInlineButton"} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
