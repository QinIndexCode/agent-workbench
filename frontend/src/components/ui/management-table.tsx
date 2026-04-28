import type { ReactNode } from 'react';

export function ManagementTable({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="overflow-hidden rounded-[20px] border border-border-subtle bg-surface/26"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function ManagementTableHeader({
  children,
  columns,
}: {
  children: ReactNode;
  columns: string;
}) {
  return (
    <div
      className="grid gap-3 border-b border-border-subtle px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </div>
  );
}

export function ManagementTableBody({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border-subtle">{children}</div>;
}

export function ManagementTableRow({
  children,
  columns,
  active = false,
  testId,
}: {
  children: ReactNode;
  columns: string;
  active?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`grid gap-3 px-4 py-3 transition duration-fast ${active ? 'bg-surface/42' : 'hover:bg-surface/34'}`}
      style={{ gridTemplateColumns: columns }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
