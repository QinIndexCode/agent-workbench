import type { SummaryStripItem } from '../../lib/workbench';

function getSummaryAccentClass(variant?: SummaryStripItem['variant']) {
  switch (variant) {
    case 'success':
      return 'bg-success';
    case 'warning':
      return 'bg-warning';
    case 'error':
      return 'bg-error';
    case 'info':
      return 'bg-info';
    default:
      return 'bg-text-muted/55';
  }
}

export function SummaryStrip({ items }: { items: SummaryStripItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {items.map((item) => (
        <div
          key={`${item.label}-${item.value}`}
          data-testid={item.testId}
          className="min-w-0 rounded-lg border border-border-subtle bg-surface/20 px-3 py-2 sm:px-3.5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${getSummaryAccentClass(item.variant)}`} />
              <p className="truncate text-[10px] uppercase tracking-[0.22em] text-text-muted">{item.label}</p>
            </div>
            <p className="shrink-0 text-sm font-semibold text-text-primary sm:text-[15px]">{item.value}</p>
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-secondary/80 sm:text-xs">{item.note}</p>
        </div>
      ))}
    </div>
  );
}
