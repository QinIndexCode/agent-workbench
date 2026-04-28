import type { ReactNode } from 'react';
import { EmptyState } from './empty-state';

export function CompactEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return <EmptyState title={title} description={description} action={action} variant="compact" />;
}
