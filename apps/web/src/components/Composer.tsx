import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { getUiCopy } from "../i18n.js";

export type ComposerMode = "new_task" | "guidance" | "continue";

export function Composer({
  busy,
  language,
  running,
  mode,
  onSubmit,
  onStop
}: {
  busy: boolean;
  language?: string | null;
  running: boolean;
  mode: ComposerMode;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = text.trim().length > 0;
  const canStop = running && !canSubmit;
  const labels = getUiCopy(language).composer;
  const modeCopy = labels.modes[mode];
  const icon = busy ? (
    <LoaderCircle className="spin" size={18} />
  ) : canStop ? (
    <Square size={14} />
  ) : (
    <ArrowUp size={18} />
  );
  const label = busy ? labels.working : canSubmit ? labels.send : canStop ? labels.stop : labels.idle;

  return (
    <form
      className={mode === "new_task" ? "composer composerLarge" : "composer"}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composerInputWrap">
        <textarea
          ref={textareaRef}
          aria-label="Task input"
          placeholder={modeCopy[0]}
          rows={4}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            resize(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="composerHint">{busy ? labels.workingHint : canSubmit ? modeCopy[1] : running ? labels.stopHint : modeCopy[1]}</span>
      </div>
      <button aria-label={label} disabled={busy || (!canSubmit && !running)} type="submit">
        {icon}
      </button>
    </form>
  );

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function submit() {
    if (busy) return;
    if (canSubmit) {
      onSubmit(text.trim());
      setText("");
      if (textareaRef.current) resize(textareaRef.current, true);
    } else if (running) {
      onStop();
    }
  }
}

function resize(element: HTMLTextAreaElement, reset = false) {
  element.style.height = "auto";
  element.style.height = reset ? "" : `${Math.min(element.scrollHeight, 180)}px`;
}
