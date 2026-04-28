import type { PlatformReadinessItem } from '../../lib/workbench';
import { Badge } from '../ui/badge';

export function ReadinessList({ items }: { items: PlatformReadinessItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.key} className="rounded-[16px] border border-border-subtle bg-surface/28 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{item.label}</p>
              <p className="mt-1 text-[13px] leading-5 text-text-secondary/90">{item.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={item.variant} className="opacity-65">{item.statusLabel}</Badge>
              <span className="text-sm font-semibold text-text-primary">{item.count}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
