import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface AccordionSelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function AccordionSelect({
  ariaLabel,
  className,
  disabled,
  options,
  placement = "down",
  size = "default",
  value,
  onChange
}: {
  ariaLabel: string;
  className?: string | undefined;
  disabled?: boolean | undefined;
  options: AccordionSelectOption[];
  placement?: "up" | "down" | undefined;
  size?: "default" | "compact" | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (!open) return;
    function onDocumentMouseDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open]);

  return (
    <div
      className={[
        "accordionSelect",
        open ? "open" : "",
        disabled ? "disabled" : "",
        placement === "up" ? "up" : "",
        size === "compact" ? "compact" : "",
        className ?? ""
      ]
        .filter(Boolean)
        .join(" ")}
      ref={rootRef}
    >
      <button
        aria-controls={`${id}-panel`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="accordionSelectTrigger"
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="accordionSelectValue">
          {selected?.icon ? <span className="accordionSelectInlineIcon">{selected.icon}</span> : null}
          <span>{selected?.label ?? ""}</span>
        </span>
        <ChevronDown className="accordionSelectChevron" size={15} aria-hidden="true" />
      </button>
      <div aria-label={`${ariaLabel} options`} className="accordionSelectPanel" id={`${id}-panel`} role="listbox">
        {options.map((option) => (
          <button
            aria-selected={option.value === value}
            className={option.value === value ? "accordionSelectOption selected" : "accordionSelectOption"}
            disabled={option.disabled}
            key={option.value}
            role="option"
            tabIndex={open ? 0 : -1}
            type="button"
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            {option.icon ? <span className="accordionSelectOptionIcon">{option.icon}</span> : null}
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
