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
        className={`w-full appearance-none rounded-lg border border-border-default bg-surface-elevated px-3 py-2 pr-11 text-sm text-text-primary outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.12)] hover:border-border-strong ${className}`}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted">
        <SelectArrowsIcon className="h-4 w-4" />
      </span>
    </div>
  );
}
