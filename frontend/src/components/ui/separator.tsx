import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Separator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('h-px w-full bg-border-subtle', className)} />;
}
