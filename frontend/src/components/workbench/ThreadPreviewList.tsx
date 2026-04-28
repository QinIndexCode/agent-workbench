import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ThreadPreview } from '../../lib/workbench';
import { Badge } from '../ui/badge';
import { Button, buttonClassName } from '../ui/button';
import { EmptyState } from '../ui/empty-state';

interface ThreadPreviewListProps {
  items: ThreadPreview[];
  emptyTitle: string;
  emptyDescription: string;
  actionLabel?: string;
  listTestId?: string;
  itemTestIdPrefix?: string;
  condensed?: boolean;
  initialVisibleCount?: number;
}

export function ThreadPreviewList({
  items,
  emptyTitle,
  emptyDescription,
  actionLabel = 'Open thread',
  listTestId,
  itemTestIdPrefix,
  condensed = false,
  initialVisibleCount,
}: ThreadPreviewListProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} variant="compact" />;
  }

  const hasVisibleLimit = typeof initialVisibleCount === 'number' && initialVisibleCount > 0 && items.length > initialVisibleCount;
  const visibleItems = hasVisibleLimit && !expanded ? items.slice(0, initialVisibleCount) : items;
  const remainingCount = hasVisibleLimit ? Math.max(0, items.length - (initialVisibleCount ?? 0)) : 0;

  return (
    <div className="space-y-2" data-testid={listTestId}>
      {visibleItems.map((item, index) => (
        <div
          key={item.taskId}
          data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-item-${index}` : undefined}
          className={`rounded-lg border border-border-subtle bg-surface/18 transition duration-fast hover:border-border-default hover:bg-surface/34 ${
            condensed ? 'px-4 py-3' : 'px-3.5 py-3'
          }`}
        >
          <div className={`flex gap-3 ${condensed ? 'items-center' : 'items-start'}`}>
            <div className="min-w-0 flex-1">
              <div className={`flex justify-between gap-3 ${condensed ? 'items-center' : 'items-start'}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{item.title}</p>
                  <p className={`mt-0.5 line-clamp-1 ${condensed ? 'text-[12px]' : 'text-[13px]'} text-text-secondary/90`}>
                    {item.preview}
                  </p>
                </div>
                <Badge variant={item.lifecycleVariant} className="shrink-0 opacity-75">
                  {item.lifecycleLabel}
                </Badge>
              </div>
              <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-text-muted ${condensed ? 'mt-1.5' : 'mt-2'}`}>
                {condensed ? (
                  <>
                    {item.meta[0] ? <span>{item.meta[0]}</span> : null}
                    <span>{item.updatedLabel}</span>
                  </>
                ) : (
                  <>
                    {item.meta.map((meta) => (
                      <span key={`${item.taskId}-${meta}`}>{meta}</span>
                    ))}
                    <span>{item.updatedLabel}</span>
                  </>
                )}
              </div>
              {!condensed && item.attention ? (
                <div className="mt-2 flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warning/80" />
                  <p className="line-clamp-2 text-[13px] leading-5 text-text-secondary">
                    {item.attention}
                  </p>
                </div>
              ) : null}
            </div>
            <Link
              to={item.href}
              className={buttonClassName({
                size: 'sm',
                variant: 'ghost',
                className: `shrink-0 text-text-primary no-underline ${condensed ? 'h-8 px-2.5 text-xs' : 'h-9 px-3'}`,
              })}
              data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-open-${index}` : undefined}
            >
              <span className="contents">
                {condensed ? 'Open' : actionLabel}
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                  <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Link>
          </div>
        </div>
      ))}
      {hasVisibleLimit ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setExpanded((value) => !value)}
            data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-toggle` : undefined}
          >
            {expanded ? 'Show less' : `Show ${remainingCount} more`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
