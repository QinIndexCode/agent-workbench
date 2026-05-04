import type { ReactNode } from 'react';
import { Button } from './button';

interface IconActionButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  variant?: 'ghost' | 'secondary';
  testId?: string;
}

export function IconActionButton({
  label,
  onClick,
  children,
  disabled = false,
  variant = 'ghost',
  testId,
}: IconActionButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="h-10 w-10 rounded-full p-0 text-text-primary hover:text-text-primary hover:shadow-[0_0_16px_rgba(99,102,241,0.2)] active:scale-90"
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
