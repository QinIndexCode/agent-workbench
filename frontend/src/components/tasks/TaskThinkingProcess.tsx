import { useState } from 'react';
import { BrainIcon, ChevronDown, ChevronUp } from '../ui/icons';

interface TaskThinkingProcessProps {
  content: string;
  timestamp?: number;
  isStreaming?: boolean;
}

export function TaskThinkingProcess({ content, timestamp, isStreaming }: TaskThinkingProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!content?.trim()) {
    return null;
  }

  const lines = content.split('\n').filter(line => line.trim());
  const shouldCollapse = lines.length > 3 || content.length > 200;
  const displayContent = isExpanded || !shouldCollapse
    ? content
    : lines.slice(0, 3).join('\n') + '...';

  return (
    <div
      data-testid="task-thinking-process"
      className="max-w-[52rem] rounded-lg border border-sky-400/16 bg-surface/38 px-3.5 py-3"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-sky-300/20 bg-sky-400/10 text-sky-100 ${isStreaming ? 'animate-thinking-glow' : ''}`}>
            <BrainIcon className="h-3.5 w-3.5" />
          </span>
          <span className="text-xs font-medium text-sky-100/80">Thinking Process</span>
          {isStreaming && (
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-sky-400 animate-slow-pulse" />
          )}
          {timestamp && (
            <span className="text-[11px] text-text-muted">
              {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-sky-100/60 transition hover:bg-sky-400/10 hover:text-sky-100"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3 w-3" />
                Collapse
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                Expand
              </>
            )}
          </button>
        )}
      </div>
      <div
        className={`whitespace-pre-wrap text-sm leading-6 text-text-secondary transition-all duration-300 ${
          isExpanded ? 'max-h-[800px] overflow-y-auto' : 'max-h-[200px] overflow-hidden'
        } ${!isExpanded && shouldCollapse ? 'thinking-collapsed-hint' : ''}`}
      >
        {displayContent}
      </div>
      {!isExpanded && shouldCollapse && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-sky-100/40">
          <span className="inline-block h-px w-4 bg-sky-400/20" />
          <span>{lines.length} lines hidden</span>
          <span className="inline-block h-px flex-1 bg-sky-400/10" />
        </div>
      )}
    </div>
  );
}
