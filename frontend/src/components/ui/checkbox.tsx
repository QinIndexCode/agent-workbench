import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      type="checkbox"
      className={cn(
        'h-4 w-4 rounded border-border-default bg-surface-elevated text-accent accent-[var(--color-accent)]',
        'focus-visible:ring-2 focus-visible:ring-accent/50',
        className,
      )}
    />
  );
}
