import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  createdAt: number;
}

type RenderedToastItem = ToastItem & {
  leaving: boolean;
};

function toneClass(tone: ToastTone) {
  switch (tone) {
    case 'error':
      return 'border-error/30 bg-error-muted/92 text-error shadow-[0_22px_48px_-28px_rgba(164,52,66,0.78)]';
    case 'success':
      return 'border-emerald-400/24 bg-emerald-950/92 text-emerald-100 shadow-[0_22px_48px_-28px_rgba(14,116,72,0.7)]';
    default:
      return 'border-sky-400/22 bg-sky-950/92 text-sky-100 shadow-[0_22px_48px_-28px_rgba(3,105,161,0.72)]';
  }
}

export function ToastHost({
  notices,
  onDismiss,
  testId = 'settings-toast-host',
}: {
  notices: ToastItem[];
  onDismiss: (id: number) => void;
  testId?: string;
}) {
  const [renderedNotices, setRenderedNotices] = useState<RenderedToastItem[]>(() => (
    notices.map((notice) => ({ ...notice, leaving: false }))
  ));

  useEffect(() => {
    setRenderedNotices((current) => {
      const nextById = new Map(notices.map((notice) => [notice.id, notice]));
      const updated = current.map((notice) => (
        nextById.has(notice.id)
          ? { ...nextById.get(notice.id)!, leaving: false }
          : { ...notice, leaving: true }
      ));
      const knownIds = new Set(updated.map((notice) => notice.id));
      const added = notices
        .filter((notice) => !knownIds.has(notice.id))
        .map((notice) => ({ ...notice, leaving: false }));
      return [...updated, ...added];
    });
  }, [notices]);

  useEffect(() => {
    if (!renderedNotices.some((notice) => notice.leaving)) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setRenderedNotices((current) => current.filter((notice) => !notice.leaving));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [renderedNotices]);

  if (renderedNotices.length === 0) {
    return null;
  }

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[140] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3"
      data-testid={testId}
    >
      {renderedNotices.map((notice) => (
        <div
          key={notice.id}
          className={`motion-fade pointer-events-auto rounded-[18px] border px-4 py-3 backdrop-blur-xl ${toneClass(notice.tone)} ${notice.leaving ? 'motion-toast-closed' : 'motion-toast-open'}`}
          data-testid="settings-toast"
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-[0.24em] text-current/70">
                {notice.tone === 'error' ? 'Issue' : notice.tone === 'success' ? 'Saved' : 'Update'}
              </p>
              <p className="mt-1 text-sm leading-6 text-current">{notice.message}</p>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-current/80 transition duration-fast hover:bg-white/10 hover:text-current"
              aria-label="Dismiss notification"
              title="Dismiss notification"
              onClick={() => onDismiss(notice.id)}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
