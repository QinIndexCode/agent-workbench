import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full resize-y rounded-lg border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition-all duration-fast placeholder:text-text-muted',
        'hover:border-border-strong focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.12)]',
        className,
      )}
    />
  );
}
