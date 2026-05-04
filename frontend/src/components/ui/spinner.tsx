import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn('h-4 w-4 animate-spin', className)}
    />
  );
}
