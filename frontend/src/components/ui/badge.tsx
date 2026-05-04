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
    default: ['bg-surface-elevated text-text-secondary ring-1 ring-white/[0.04]'],
    success: ['bg-success-muted text-success shadow-[0_0_8px_rgba(34,197,94,0.15)]'],
    warning: ['bg-warning-muted text-warning shadow-[0_0_8px_rgba(245,158,11,0.15)]'],
    error: ['bg-error-muted text-error shadow-[0_0_8px_rgba(239,68,68,0.15)]'],
    info: ['bg-info-muted text-info shadow-[0_0_8px_rgba(59,130,246,0.15)]'],
    outline: ['border border-border-default text-text-muted'],
  };

  return (
    <span
      className={[
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium leading-5 tracking-[0.02em]',
        'transition-all duration-fast',
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
