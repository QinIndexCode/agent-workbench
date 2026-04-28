import type { SelectHTMLAttributes } from 'react';
import { SelectArrowsIcon } from './icons';

export function SelectInput({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`w-full appearance-none rounded-2xl border border-border-default bg-surface-elevated px-3 py-2 pr-11 text-sm text-text-primary outline-none transition duration-fast focus:border-accent focus:ring-1 focus:ring-accent/30 ${className}`}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted">
        <SelectArrowsIcon className="h-4 w-4" />
      </span>
    </div>
  );
}
