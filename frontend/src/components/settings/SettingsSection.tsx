import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '../ui/card';

interface SettingsSectionProps {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SettingsSection({
  eyebrow,
  title,
  description,
  children,
  actions,
  className = '',
}: SettingsSectionProps) {
  return (
    <Card className={`rounded-lg border-border-subtle bg-surface/30 ${className}`}>
      <CardHeader className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{eyebrow}</p>
          <h2 className="mt-1 text-lg font-semibold text-text-primary">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-text-secondary">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-4 pt-0">{children}</CardContent>
    </Card>
  );
}

interface SettingsFieldProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function SettingsField({ label, children, className = '' }: SettingsFieldProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      <label className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">{label}</label>
      {children}
    </div>
  );
}

interface SettingsGridProps {
  children: ReactNode;
  cols?: 1 | 2 | 3 | 4;
  className?: string;
}

export function SettingsGrid({ children, cols = 2, className = '' }: SettingsGridProps) {
  const colClasses = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4',
  };
  return <div className={`grid gap-4 ${colClasses[cols]} ${className}`}>{children}</div>;
}

interface SettingsToggleProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}

export function SettingsToggle({ label, description, checked, onChange, testId }: SettingsToggleProps) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface/24 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="mt-1 text-sm leading-6 text-text-secondary">{description}</p>
      </div>
      <input
        data-testid={testId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-border-default accent-[color:var(--accent)]"
      />
    </label>
  );
}

interface SettingsInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function SettingsInput(props: SettingsInputProps) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

interface SettingsTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function SettingsTextarea(props: SettingsTextareaProps) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

interface SettingsCardProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function SettingsCard({ title, children, className = '' }: SettingsCardProps) {
  return (
    <div className={`rounded-lg border border-border-subtle bg-surface/18 px-4 py-3 ${className}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted mb-3">{title}</p>
      {children}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  note?: string;
  variant?: 'default' | 'success' | 'warning' | 'info' | 'error';
}

export function StatCard({ label, value, note, variant = 'default' }: StatCardProps) {
  const variantClasses = {
    default: 'border-border-subtle bg-surface/18',
    success: 'border-success/25 bg-success-muted/10',
    warning: 'border-warning/25 bg-warning-muted/10',
    info: 'border-info/25 bg-info-muted/10',
    error: 'border-error/25 bg-error-muted/10',
  };

  return (
    <div className={`rounded-lg border px-4 py-3 ${variantClasses[variant]}`}>
      <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{label}</p>
      <p className="mt-2 text-xl font-semibold text-text-primary">{value}</p>
      {note ? <p className="mt-1 text-sm text-text-secondary">{note}</p> : null}
    </div>
  );
}
