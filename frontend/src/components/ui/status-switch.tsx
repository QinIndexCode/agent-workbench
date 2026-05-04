interface StatusSwitchProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
  testId?: string;
}

export function StatusSwitch({
  checked,
  label,
  disabled = false,
  onToggle,
  testId,
}: StatusSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onToggle}
      className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full border transition-all duration-fast ease-spring ${
        checked
          ? 'border-accent bg-accent shadow-[0_0_12px_rgba(59,130,246,0.35)]'
          : 'border-border-default bg-surface-hover'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-accent/60 active:scale-95'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-fast ease-spring ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
