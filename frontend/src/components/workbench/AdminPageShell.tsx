import type { ReactNode } from 'react';

export function AdminPageShell({
  children,
  summary,
}: {
  children: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {summary ? (
        <div className="rounded-lg border border-border-subtle bg-surface/28 p-4">
          {summary}
        </div>
      ) : null}
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}
