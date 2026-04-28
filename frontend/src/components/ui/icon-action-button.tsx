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
      className="h-10 w-10 rounded-full p-0 text-text-primary hover:text-text-primary"
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
