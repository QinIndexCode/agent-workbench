import { type ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  variant?: 'default' | 'compact';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'default',
}: EmptyStateProps) {
  const compact = variant === 'compact';

  return (
    <div
      data-testid={compact ? 'empty-state-compact' : 'empty-state'}
      className={
        compact
          ? 'flex w-full flex-col items-start justify-start px-0 py-6 text-left'
          : 'mx-auto flex w-full max-w-2xl flex-col items-center justify-center px-4 py-12 text-center'
      }
    >
      {icon && (
        <div className="mb-3 text-text-muted opacity-30">{icon}</div>
      )}
      <h3 className={`mb-1.5 text-base font-semibold text-text-primary ${compact ? 'text-left' : ''}`}>{title}</h3>
      <p
        className={
          compact
            ? 'mb-4 w-full max-w-[34rem] whitespace-normal break-words text-sm leading-6 text-text-secondary'
            : 'mb-5 w-full max-w-[36rem] whitespace-normal break-words text-sm leading-relaxed text-text-secondary'
        }
      >
        {description}
      </p>
      {action}
    </div>
  );
}
