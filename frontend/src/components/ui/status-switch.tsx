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
      className={`relative inline-flex h-8 w-[3.15rem] flex-shrink-0 items-center rounded-full border transition duration-fast ${
        checked
          ? 'border-accent bg-accent/90'
          : 'border-border-default bg-surface-hover'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-accent/60'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition duration-fast ${
          checked ? 'translate-x-[1.45rem]' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
