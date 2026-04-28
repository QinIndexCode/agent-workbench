import { type ReactNode, type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

export function buttonClassName({
  variant = 'primary',
  size = 'md',
  className = '',
}: Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const baseStyles = [
    'inline-flex items-center justify-center',
    'font-medium transition-colors',
    'duration-fast ease-out',
    'rounded-lg focus:outline-none focus:ring-1 focus:ring-offset-0',
    'focus:ring-offset-background',
    'disabled:opacity-50 disabled:pointer-events-none',
  ];
  
  const variants = {
    primary: [
      'bg-accent text-white hover:bg-accent-hover shadow-sm shadow-black/10',
      'focus:ring-accent/50',
    ],
    secondary: [
      'bg-surface-elevated/80 text-text-secondary border border-border-default',
      'hover:bg-surface-hover hover:border-border-strong',
      'focus:ring-accent/50',
    ],
    ghost: [
      'text-text-muted hover:text-text-primary hover:bg-surface-elevated',
      'focus:ring-accent/50',
    ],
  };

  const sizes = {
    sm: ['px-2.5 py-1.5 text-xs gap-1.5'],
    md: ['px-3.5 py-2 text-sm gap-2'],
    lg: ['px-5 py-2.5 text-base gap-2.5'],
  };

  return [...baseStyles, ...variants[variant], ...sizes[size], className].join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  ...props
}: ButtonProps) {

  return (
    <button 
      className={buttonClassName({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  );
}
