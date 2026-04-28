import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '../ui/badge';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
  badges?: Array<{
    label: string;
    variant?: BadgeVariant;
  }>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  badges = [],
}: PageHeaderProps) {
  return (
    <div className="border-b border-border-subtle bg-surface/18 px-1 pb-4 pt-1">
      <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.28em] text-text-muted">{eyebrow}</p>
          <h1 data-testid="page-header-title" className="mt-1 text-[1.05rem] font-semibold tracking-tight text-text-primary sm:text-[1.25rem]">{title}</h1>
          <p
            data-testid="page-header-description"
            className="mt-1 hidden max-w-[54rem] text-sm leading-6 text-text-secondary/80 sm:block"
          >
            {description}
          </p>
        </div>
        <div
          data-testid="page-header-actions"
          className="flex shrink-0 flex-wrap items-center gap-2 lg:max-w-[26rem] lg:justify-end lg:self-start"
        >
          {badges.map((badge) => (
            <Badge
              key={`${badge.label}-${badge.variant ?? 'default'}`}
              variant={badge.variant ?? 'outline'}
              className="hidden opacity-65 sm:inline-flex"
            >
              {badge.label}
            </Badge>
          ))}
          {actions}
        </div>
      </div>
    </div>
  );
}
