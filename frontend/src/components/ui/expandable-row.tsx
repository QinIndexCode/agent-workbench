import type { ReactNode } from 'react';

interface ExpandableRowProps {
  open: boolean;
  summary: ReactNode;
  details: ReactNode;
  testId?: string;
  summaryTestId?: string;
  onToggle: () => void;
}

export function ExpandableRow({
  open,
  summary,
  details,
  testId,
  summaryTestId,
  onToggle,
}: ExpandableRowProps) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface/24" data-testid={testId}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
        data-testid={summaryTestId}
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">{summary}</div>
        <span className="mt-1 shrink-0 text-text-muted" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" className={`h-5 w-5 transition duration-fast ${open ? 'rotate-180' : ''}`}>
            <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open ? <div className="border-t border-border-subtle px-4 py-3">{details}</div> : null}
    </div>
  );
}
