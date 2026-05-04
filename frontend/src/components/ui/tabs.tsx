import { createContext, type ReactNode, useContext } from 'react';
import { cn } from '../../lib/utils';

const TabsContext = createContext<{
  value: string;
  onValueChange: (value: string) => void;
} | null>(null);

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn('flex flex-col gap-3', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('inline-flex rounded-lg border border-border-subtle bg-surface/42 p-1', className)} role="tablist">
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const context = useContext(TabsContext);
  const active = context?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm text-text-secondary transition-colors',
        active ? 'bg-accent text-white' : 'hover:bg-surface-hover hover:text-text-primary',
        className,
      )}
      onClick={() => context?.onValueChange(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const context = useContext(TabsContext);
  if (context?.value !== value) {
    return null;
  }
  return <div className={className}>{children}</div>;
}
