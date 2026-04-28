import { type ReactNode } from 'react';
import type { TaskLifecycleStatus } from '../../types';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'outline';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  const variants = {
    default: ['bg-surface-elevated text-text-secondary'],
    success: ['bg-success-muted text-success'],
    warning: ['bg-warning-muted text-warning'],
    error: ['bg-error-muted text-error'],
    info: ['bg-info-muted text-info'],
    outline: ['border border-border-default text-text-muted'],
  };

  return (
    <span 
      className={[
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium leading-5 tracking-[0.02em]',
        ...variants[variant],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}

export function lifecycleBadgeVariant(status: TaskLifecycleStatus): BadgeProps['variant'] {
  switch (status) {
    case 'SUBMITTED': return 'info';
    case 'RUNNING': return 'success';
    case 'PAUSED': return 'warning';
    case 'COMPLETED': return 'default';
    case 'FAILED': return 'error';
    default: return 'default';
  }
}
