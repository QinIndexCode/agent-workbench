import { type ComponentPropsWithoutRef, type ReactNode } from 'react';

interface CardProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = '', onClick, ...props }: CardProps) {
  return (
    <div
      className={[
        'bg-surface/72 backdrop-blur-sm',
        'border border-border-subtle rounded-lg shadow-none',
        'transition-all duration-fast',
        onClick && 'cursor-pointer hover:border-border-default hover:bg-surface-elevated/70 hover:shadow-sm active:scale-[0.995]',
        className,
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardHeaderProps) {
  return (
    <div className={`border-b border-border-subtle px-4 py-3 ${className}`}>
      {children}
    </div>
  );
}

interface CardContentProps {
  children: ReactNode;
  className?: string;
}

export function CardContent({ children, className = '' }: CardContentProps) {
  return (
    <div className={`px-4 py-3 ${className}`}>
      {children}
    </div>
  );
}
