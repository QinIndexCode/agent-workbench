import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './button';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';

interface AdminModalProps {
  open: boolean;
  title: string;
  description?: string;
  eyebrow?: string;
  size?: 'md' | 'lg' | 'xl';
  busy?: boolean;
  footer?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  onClose: () => void;
}

const MODAL_WIDTH = {
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-5xl',
} as const;

export function AdminModal({
  open,
  title,
  description,
  eyebrow = 'Manage',
  size = 'lg',
  busy = false,
  footer,
  actions,
  children,
  testId,
  onClose,
}: AdminModalProps) {
  const presence = useAnimatedPresence(open, 180);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((element) => element.offsetParent !== null)
        : [];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  useEffect(() => {
    if (!presence.mounted || presence.state !== 'open') {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && dialogRef.current?.contains(activeElement)) {
      return;
    }
    dialogRef.current?.focus();
  }, [presence.mounted, presence.state]);

  if (!presence.mounted) {
    return null;
  }

  return createPortal(
    <div
      className={`fixed inset-0 z-[130] flex items-center justify-center p-4 ${presence.state === 'open' ? '' : 'pointer-events-none'}`}
      data-testid={testId}
    >
      <button
        type="button"
        aria-label="Close dialog"
        className={`motion-fade absolute inset-0 bg-black/65 backdrop-blur-[3px] ${presence.state === 'open' ? 'motion-overlay-open' : 'motion-overlay-closed'}`}
        disabled={busy}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`motion-fade relative z-[1] flex max-h-[min(90vh,980px)] w-full ${MODAL_WIDTH[size]} flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-[0_28px_120px_-40px_rgba(0,0,0,0.72)] ${presence.state === 'open' ? 'motion-modal-open' : 'motion-modal-closed'}`}
        data-testid={testId ? `${testId}-panel` : undefined}
      >
        <div
          className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5"
          data-testid={testId ? `${testId}-header` : undefined}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{eyebrow}</p>
            <h2 id={titleId} className="mt-2 text-xl font-semibold text-text-primary">{title}</h2>
            {description ? (
              <p id={descriptionId} className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">{description}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClose}
              className="h-10 w-10 rounded-lg p-0"
              aria-label="Close dialog"
              title="Close dialog"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
                <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Button>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-thin"
          data-testid={testId ? `${testId}-body` : undefined}
        >
          {children}
        </div>
        {footer ? (
          <div
            className="border-t border-border-subtle bg-surface/82 px-6 py-4"
            data-testid={testId ? `${testId}-footer` : undefined}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
