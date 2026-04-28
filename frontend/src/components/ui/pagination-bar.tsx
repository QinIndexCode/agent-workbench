import { Button } from './button';

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemLabel: string;
  disabled?: boolean;
  testId?: string;
  onPrevious: () => void;
  onNext: () => void;
}

export function PaginationBar({
  currentPage,
  totalPages,
  totalItems,
  itemLabel,
  disabled = false,
  testId,
  onPrevious,
  onNext,
}: PaginationBarProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-border-subtle bg-surface/18 px-4 py-3"
      data-testid={testId}
    >
      <div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Pagination</p>
        <p className="mt-1 text-sm text-text-secondary">
          Page {currentPage} of {Math.max(totalPages, 1)} · {totalItems} {itemLabel}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || currentPage <= 1}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || currentPage >= totalPages}
          onClick={onNext}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
