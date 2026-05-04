import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './button';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  busy?: boolean;
  testId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  details = [],
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  testId,
  confirmTestId,
  cancelTestId,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const presence = useAnimatedPresence(open, 160);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, open]);

  if (!presence.mounted) {
    return null;
  }

  return createPortal((
    <div
      className={`fixed inset-0 z-[120] flex items-center justify-center p-4 ${presence.state === 'open' ? '' : 'pointer-events-none'}`}
      data-testid={testId}
    >
      <button
        type="button"
        aria-label="Close confirmation dialog"
        className={`motion-fade absolute inset-0 bg-black/60 backdrop-blur-[2px] ${presence.state === 'open' ? 'motion-overlay-open' : 'motion-overlay-closed'}`}
        disabled={busy}
        onClick={onCancel}
      />
      <div
        className={`motion-fade relative z-[1] w-[min(36rem,calc(100vw-2rem))] max-w-[36rem] rounded-lg border border-border-subtle bg-surface-elevated p-5 shadow-2xl ${presence.state === 'open' ? 'motion-modal-open' : 'motion-modal-closed'}`}
        data-testid={testId ? `${testId}-panel` : undefined}
      >
        <div data-testid={testId ? `${testId}-body` : undefined}>
          <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Confirm action</p>
          <h2 className="mt-2 text-lg font-semibold text-text-primary">{title}</h2>
          {description ? (
            <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
          ) : null}
          {details.length ? (
            <div className="mt-4 rounded-lg border border-border-subtle bg-surface/40 px-4 py-3">
              <ul className="space-y-2 text-sm leading-6 text-text-secondary">
                {details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2" data-testid={testId ? `${testId}-footer` : undefined}>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel} data-testid={cancelTestId}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'danger' ? 'secondary' : 'primary'}
            className={tone === 'danger' ? 'border border-error/30 text-error hover:bg-error-muted/16 hover:text-error' : ''}
            disabled={busy}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  ), document.body);
}
