import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";

export function Composer({
  busy,
  running,
  onSubmit,
  onStop
}: {
  busy: boolean;
  running: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = text.trim().length > 0;
  const canStop = running && !canSubmit;
  const icon = busy ? <LoaderCircle className="spin" size={18} /> : canSubmit ? <ArrowUp size={18} /> : <Square size={14} />;
  const label = busy ? "Working" : canSubmit ? "Send" : canStop ? "Stop" : "Idle";

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Task input"
        placeholder="Ask the agent to do something..."
        rows={1}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          resize(event.currentTarget);
        }}
        onKeyDown={handleKeyDown}
      />
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
