import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";

export type ComposerMode = "new_task" | "guidance" | "continue";

const modeCopy: Record<ComposerMode, { placeholder: string; hint: string }> = {
  new_task: {
    placeholder: "Ask the agent to do something...",
    hint: "Starts a new task"
  },
  guidance: {
    placeholder: "Add guidance for the running task...",
    hint: "Sends pending guidance"
  },
  continue: {
    placeholder: "Continue this task...",
    hint: "Continues the selected task"
  }
};

export function Composer({
  busy,
  running,
  mode,
  onSubmit,
  onStop
}: {
  busy: boolean;
  running: boolean;
  mode: ComposerMode;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = text.trim().length > 0;
  const canStop = running && !canSubmit;
  const icon = busy ? (
    <LoaderCircle className="spin" size={18} />
  ) : canStop ? (
    <Square size={14} />
  ) : (
    <ArrowUp size={18} />
  );
  const label = busy ? "Working" : canSubmit ? "Send" : canStop ? "Stop" : "Idle";
  const copy = modeCopy[mode];

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
          placeholder={copy.placeholder}
          rows={4}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            resize(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="composerHint">{busy ? "Working..." : canSubmit ? copy.hint : running ? "Stops the current run" : copy.hint}</span>
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
