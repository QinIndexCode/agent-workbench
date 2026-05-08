import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision, TaskDetail, TaskEvent, ToolApproval } from "@scc/shared";
import { ArrowDown, BookOpen, ChevronDown, Copy, Eye, FileText, Globe2, List as ListIcon, PencilLine, Plug, Search, Terminal, Wrench } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { MarkdownText } from "./MarkdownText.js";

const visibleEventTypes = new Set<TaskEvent["type"]>([
  "user_message",
  "attachment_added",
  "assistant_delta",
  "assistant_message",
  "thinking_delta",
  "guidance_pending",
  "approval_pending",
  "tool_result",
  "conversation_summary_created",
  "context_overflow_recovered",
  "task_checkpoint_created",
  "task_rollback_completed",
  "task_rollback_failed",
  "plan_step_blocked",
  "web_search_result"
]);

const FOLLOW_BOTTOM_DISTANCE = 120;
const MAX_RENDERED_TIMELINE_ITEMS = 360;

export function Timeline({
  language,
  task,
  onApprovalDecision,
  onRevertLatestTurn
}: {
  language?: string | null;
  task: TaskDetail | null;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onRevertLatestTurn?: (() => Promise<void> | void) | undefined;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const smoothScrollUntilRef = useRef(0);
  const smoothScrollTimerRef = useRef<number | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const items = useMemo(
    () =>
      buildTimelineItems(
        task?.events.filter((event) => {
        if (!visibleEventTypes.has(event.type)) return false;
        if (event.type === "tool_result" && event.payload["uiHidden"] === true) return false;
        if (event.type !== "approval_pending") return true;
        const approvalId = String(event.payload["approvalId"] ?? "");
        return task.approvals.some((approval) => approval.id === approvalId && approval.status === "pending");
        }) ?? []
      ),
    [task]
  );
  const lastEventId = task?.events[task.events.length - 1]?.id ?? "empty";
  const timelineVersion = useMemo(() => getTimelineVersion(items), [items]);
  const displayItems = useMemo(() => limitTimelineItems(items, language), [items, language]);
  const latestUserEventId = useMemo(() => {
    const latest = [...(task?.events ?? [])].reverse().find((event) => event.type === "user_message" && !event.reverted);
    return latest?.id ?? null;
  }, [task?.events]);
  const latestAgentItemKey = useMemo(() => {
    const latest = [...displayItems].reverse().find(isAgentMessageItem);
    return latest?.key ?? null;
  }, [displayItems]);

  useEffect(() => {
    followBottomRef.current = true;
    setAtBottom(true);
  }, [task?.id]);

  const updateBottomState = useCallback((node: HTMLDivElement) => {
    const isAtBottom = getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE;
    if (Date.now() < smoothScrollUntilRef.current) {
      followBottomRef.current = true;
      if (isAtBottom) {
        smoothScrollUntilRef.current = 0;
        setAtBottom(true);
      }
      return isAtBottom;
    }
    if (!isAtBottom && scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    followBottomRef.current = isAtBottom;
    setAtBottom(isAtBottom);
    return isAtBottom;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = timelineRef.current;
    if (!node) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (behavior === "smooth") {
      smoothScrollUntilRef.current = Date.now() + 520;
      if (smoothScrollTimerRef.current !== null) window.clearTimeout(smoothScrollTimerRef.current);
      scrollElementTo(node, node.scrollHeight, "smooth");
      setAtBottom(true);
      smoothScrollTimerRef.current = window.setTimeout(() => {
        smoothScrollUntilRef.current = 0;
        smoothScrollTimerRef.current = null;
        if (followBottomRef.current && getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE) setAtBottom(true);
      }, 540);
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      setAtBottom(true);
      scrollFrameRef.current = null;
    });
  }, []);

  useLayoutEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const currentTaskId = task?.id ?? null;
    const taskChanged = taskIdRef.current !== currentTaskId;
    if (taskChanged) {
      taskIdRef.current = currentTaskId;
      followBottomRef.current = true;
    }
    if (followBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [task?.id, lastEventId, timelineVersion, scrollToBottom]);

  useEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const observer = new MutationObserver(() => {
      if (followBottomRef.current) scrollToBottom("auto");
    });
    observer.observe(node, { characterData: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, [task?.id, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (smoothScrollTimerRef.current !== null) window.clearTimeout(smoothScrollTimerRef.current);
    };
  }, []);

  if (!task) return <div className="empty">{getUiCopy(language).thread.startGoal}</div>;

  return (
    <div className="timelineWrap">
      <div
        className="timeline"
        data-task-id={task.id}
        ref={timelineRef}
        onScroll={(event) => {
          updateBottomState(event.currentTarget);
        }}
      >
        {displayItems.map((item) => (
          <TimelineEvent
            item={item}
            key={item.key}
            approvals={task.approvals}
            copied={copiedKey === item.key}
            alwaysShowActions={item.key === latestAgentItemKey}
            language={language ?? null}
            canRevert={item.kind === "event" && item.event.id === latestUserEventId && Boolean(onRevertLatestTurn)}
            onApprovalDecision={onApprovalDecision}
            onCopy={(text) => {
              void copyText(text);
              setCopiedKey(item.key);
              window.setTimeout(() => setCopiedKey((current) => (current === item.key ? null : current)), 1400);
            }}
            onRevertLatestTurn={onRevertLatestTurn}
          />
        ))}
      </div>
      {!atBottom ? (
        <button
          className="jumpToBottom"
          type="button"
          aria-label={language === "zh-CN" ? "跳到底部" : "Jump to latest"}
          onClick={() => {
            followBottomRef.current = true;
            setAtBottom(true);
            scrollToBottom("smooth");
          }}
        >
          <ArrowDown size={20} />
        </button>
      ) : null}
    </div>
  );
}

type TimelineItem =
  | { key: string; kind: "event"; event: TaskEvent }
  | { key: string; kind: "stream"; type: "assistant_delta" | "thinking_delta"; streamId: string; summary: string }
  | { key: string; kind: "notice"; summary: string };

function isAgentMessageItem(item: TimelineItem): boolean {
  if (item.kind === "stream") return item.type === "assistant_delta";
  if (item.kind === "notice") return false;
  return item.event.type === "assistant_message";
}

function getDistanceFromBottom(node: HTMLDivElement): number {
  return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

function scrollElementTo(node: HTMLDivElement, top: number, behavior: ScrollBehavior): void {
  if (typeof node.scrollTo === "function") {
    node.scrollTo({ top, behavior });
    return;
  }
  node.scrollTop = top;
}

function getTimelineVersion(items: TimelineItem[]): string {
  return items
    .slice(-8)
    .map((item) => {
      if (item.kind === "stream") return `${item.key}:${item.summary.length}`;
      if (item.kind === "notice") return item.key;
      const output = typeof item.event.payload["output"] === "string" ? String(item.event.payload["output"]).length : 0;
      return `${item.key}:${item.event.reverted ? "r" : "a"}:${item.event.summary.length}:${output}`;
    })
    .join("|");
}

function TimelineEvent({
  item,
  approvals,
  alwaysShowActions,
  canRevert,
  copied,
  language,
  onApprovalDecision,
  onCopy,
  onRevertLatestTurn
}: {
  item: TimelineItem;
  approvals: ToolApproval[];
  alwaysShowActions: boolean;
  canRevert: boolean;
  copied: boolean;
  language?: string | null | undefined;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onCopy: (text: string) => void;
  onRevertLatestTurn?: (() => Promise<void> | void) | undefined;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const zh = language === "zh-CN";
  if (item.kind === "notice") {
    return (
      <article className="event note timeline_window_notice">
        <span>{item.summary}</span>
      </article>
    );
  }
  if (item.kind === "stream") {
    if (item.type === "thinking_delta") {
      return (
        <article className="event thinking_delta">
          <div className={thinkingOpen ? "thinkingDetails open" : "thinkingDetails"}>
            <button
              aria-expanded={thinkingOpen}
              className="thinkingSummary"
              onClick={() => setThinkingOpen((open) => !open)}
              type="button"
            >
              <span className="thinkingLabel">{zh ? "思考" : "Thinking"}</span>
              <span className="thinkingPreview">{compactInline(item.summary)}</span>
              <ChevronDown className="thinkingChevron" size={13} />
            </button>
            <div className="thinkingExpandedActions" aria-hidden={!thinkingOpen}>
              <button
                aria-label={zh ? "复制思考内容" : "Copy thinking"}
                disabled={!thinkingOpen}
                title={zh ? "复制思考内容" : "Copy thinking"}
                type="button"
                onClick={() => onCopy(item.summary)}
              >
                <Copy size={14} />
              </button>
              {copied ? <span>{zh ? "已复制" : "Copied"}</span> : null}
            </div>
            <div className="thinkingBodyShell">
              <div className="thinkingBody">
                <MarkdownText content={item.summary} />
              </div>
            </div>
          </div>
        </article>
      );
    }
    return (
      <article className="event assistant_delta" aria-live="polite">
        <MessageActions alwaysShow={alwaysShowActions} copied={copied} language={language} onCopy={() => onCopy(item.summary)} />
        <MarkdownText content={item.summary} />
      </article>
    );
  }

  const event = item.event;
  if (event.reverted) {
    return (
      <article className={`event note reverted ${event.type}`}>
        <span>{zh ? "此轮已撤回" : "This turn was reverted"}</span>
      </article>
    );
  }
  if (event.type === "attachment_added") {
    return (
      <article className="event attachment_added">
        <MessageActions alwaysShow={alwaysShowActions} copied={copied} language={language} onCopy={() => onCopy(event.summary)} />
        <small>{zh ? "附件" : "attachment"}</small>
        <MarkdownText content={`${event.summary}\n\n${formatBytes(Number(event.payload["size"] ?? 0))} · ${String(event.payload["kind"] ?? "file")}`} />
      </article>
    );
  }

  if (event.type === "conversation_summary_created" || event.type === "context_overflow_recovered") {
    const retained = Array.isArray(event.payload["retainedFacts"]) ? event.payload["retainedFacts"].map(String).slice(0, 4) : [];
    const summary = String(event.payload["summary"] ?? "");
    const title = event.type === "context_overflow_recovered" ? (zh ? "上下文超限，已压缩并重试" : "Context limit recovered with compaction") : (zh ? "已压缩较早上下文" : "Earlier context compacted");
    return (
      <article className={`event note contextCompactEvent ${event.type}`}>
        <details className="contextCompactDetails">
          <summary>
            <span>{title}</span>
            {retained.length > 0 ? <small>{retained.join(" · ")}</small> : null}
          </summary>
          {summary ? <pre>{summary}</pre> : event.summary ? <pre>{event.summary}</pre> : null}
        </details>
      </article>
    );
  }

  if (event.type === "task_checkpoint_created" || event.type === "task_rollback_completed" || event.type === "task_rollback_failed") {
    return (
      <article className={`event note ${event.type}`}>
        <span>{event.summary}</span>
      </article>
    );
  }

  if (event.type.startsWith("plan_")) {
    return (
      <article className={`event note ${event.type}`}>
        <span>{event.summary}</span>
      </article>
    );
  }

  if (event.type === "approval_pending") {
    const approvalId = String(event.payload["approvalId"] ?? "");
    const approval = approvals.find((item) => item.id === approvalId && item.status === "pending");
    if (!approval) return null;
    return (
      <article className="event approval_pending">
        <ApprovalCard approval={approval} language={language ?? null} onDecision={(decision) => onApprovalDecision(approval.id, decision)} />
      </article>
    );
  }

  if (event.type === "tool_result") {
    const output = String(event.payload["output"] ?? "");
    const parsed = parseToolOutput(output);
    const toolName = String(event.payload["toolName"] ?? "tool");
    const ok = Boolean(event.payload["ok"] ?? false);
    const visibleOutput = parsed.display.trim() || parsed.summary || parsed.preview || (zh ? "没有可展示的工具返回内容。" : "No visible tool output.");
    return (
      <article className="event tool_result">
        <div className={`${ok ? "toolResultDetails" : "toolResultDetails failed"}${toolOpen ? " open" : ""}`}>
          <button
            aria-expanded={toolOpen}
            className="toolResultSummary"
            onClick={() => setToolOpen((open) => !open)}
            title={toolName}
            type="button"
          >
            {renderToolIcon(toolName)}
            <span>{formatToolLabel(toolName, event.payload)}</span>
            <ChevronDown className="toolResultChevron" size={13} />
          </button>
          <div className="toolResultBodyShell">
            <div className="toolResultBody">
              <button
                aria-label={zh ? "复制工具返回" : "Copy tool output"}
                className="toolResultCopyButton"
                onClick={() => onCopy(visibleOutput)}
                title={zh ? "复制工具返回" : "Copy tool output"}
                type="button"
              >
                <Copy size={14} />
              </button>
              {parsed.summary ? <MarkdownText content={parsed.summary} /> : parsed.preview ? <pre className="toolInlineOutput">{parsed.preview}</pre> : null}
              {parsed.citations.length > 0 ? (
                <div className="citationList">
                  {parsed.citations.map((citation) => (
                    <span className="citationChip" key={citation.key} title={citation.source ?? citation.excerpt}>
                      {citation.title}{citation.heading ? ` · ${citation.heading}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
              {parsed.rawOutputRef ? <code className="rawRef">{parsed.rawOutputRef}</code> : null}
              <pre className="toolResultRaw">{visibleOutput.slice(0, 8000)}</pre>
              {copied ? <span className="toolCopiedHint">{zh ? "已复制" : "Copied"}</span> : null}
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`event ${event.type}`}>
      <MessageActions
        alwaysShow={alwaysShowActions}
        copied={copied}
        language={language}
        onCopy={() => onCopy(formatVisibleEventSummary(event, language))}
        onRevert={canRevert ? () => void onRevertLatestTurn?.() : undefined}
      />
      <MarkdownText content={formatVisibleEventSummary(event, language)} />
    </article>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Browser automation and some embedded contexts can deny clipboard writes.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function formatVisibleEventSummary(event: TaskEvent, language?: string | null | undefined): string {
  const zh = language === "zh-CN";
  const summary = stripPlaceholderToolEvidence(event.summary).trim();
  if (event.type === "assistant_message" && /^Model provider failed:\s*Connection error\.?$/i.test(summary)) {
    return zh
      ? "模型服务连接失败。请检查模型配置、Base URL、API Key 或网络状态，然后重试。"
      : "The model service could not be reached. Check the model configuration, Base URL, API key, or network, then retry.";
  }
  if (event.type === "assistant_message" && /^Model provider failed:/i.test(summary)) {
    return zh
      ? summary.replace(/^Model provider failed:\s*/i, "模型服务请求失败：")
      : summary;
  }
  return summary;
}

function stripPlaceholderToolEvidence(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !isPlaceholderToolSummary(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function MessageActions({
  alwaysShow,
  copied,
  language,
  onCopy,
  onRevert
}: {
  alwaysShow: boolean;
  copied: boolean;
  language?: string | null | undefined;
  onCopy: () => void;
  onRevert?: (() => void) | undefined;
}) {
  const zh = language === "zh-CN";
  return (
    <div className={alwaysShow ? "messageActions alwaysVisible" : "messageActions"}>
      <button aria-label={zh ? "复制" : "Copy"} title={zh ? "复制" : "Copy"} type="button" onClick={onCopy}>
        <Copy size={14} />
      </button>
      {onRevert ? (
        <button aria-label={zh ? "撤回并编辑最近一轮" : "Revert and edit latest turn"} title={zh ? "撤回并编辑最近一轮" : "Revert and edit latest turn"} type="button" onClick={onRevert}>
          <PencilLine size={14} />
        </button>
      ) : null}
      {copied ? <span>{zh ? "已复制" : "Copied"}</span> : null}
    </div>
  );
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function buildTimelineItems(events: TaskEvent[]): TimelineItem[] {
  const finalStreamIds = new Set(
    events
      .filter((event) => event.type === "assistant_message")
      .map((event) => String(event.payload["streamId"] ?? ""))
      .filter(Boolean)
  );
  const items: TimelineItem[] = [];
  const streamItems = new Map<string, Extract<TimelineItem, { kind: "stream" }>>();
  for (const event of events) {
    if (event.type === "assistant_delta" || event.type === "thinking_delta") {
      const streamId = String(event.payload["streamId"] ?? event.id);
      if (event.type === "assistant_delta" && finalStreamIds.has(streamId)) continue;
      const key = `${event.type}:${streamId}`;
      let stream = streamItems.get(key);
      if (!stream) {
        stream = { key, kind: "stream", type: event.type, streamId, summary: "" };
        streamItems.set(key, stream);
        items.push(stream);
      }
      stream.summary = appendStreamDelta(stream.summary, String(event.payload["delta"] ?? event.summary), event.type);
      continue;
    }
    items.push({ key: event.id, kind: "event", event });
  }
  return items.filter((item) => item.kind === "event" || item.summary.trim().length > 0);
}

function limitTimelineItems(items: TimelineItem[], language?: string | null): TimelineItem[] {
  if (items.length <= MAX_RENDERED_TIMELINE_ITEMS) return items;
  const hidden = items.length - MAX_RENDERED_TIMELINE_ITEMS;
  return [
    {
      key: `timeline-window-notice-${hidden}`,
      kind: "notice",
      summary: language === "zh-CN"
        ? `为保持流畅，界面只渲染最近 ${MAX_RENDERED_TIMELINE_ITEMS} 条信息；较早 ${hidden} 条仍保留在任务历史和上下文摘要中。`
        : `For smooth rendering, only the latest ${MAX_RENDERED_TIMELINE_ITEMS} items are shown; ${hidden} earlier items remain in task history and context summaries.`
    },
    ...items.slice(-MAX_RENDERED_TIMELINE_ITEMS)
  ];
}

function appendStreamDelta(current: string, delta: string, type: "assistant_delta" | "thinking_delta"): string {
  if (!current || type === "assistant_delta") return current + delta;
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return current + delta;
  return `${current}\n${delta}`;
}

function formatToolLabel(toolName: string, payload: Record<string, unknown>): string {
  const args = payload["args"] && typeof payload["args"] === "object" ? (payload["args"] as Record<string, unknown>) : {};
  const candidate = firstStringArg(args, ["path", "file", "targetPath", "cwd", "query", "command", "url"]);
  if (candidate) return compactToolTarget(candidate);
  const normalized = toolName.replace(/^mcp__/, "mcp/").replaceAll("__", "/");
  return normalized.includes("/") ? `.../${normalized.split("/").filter(Boolean).slice(-2).join("/")}` : `.../${normalized}`;
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function compactToolTarget(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\s+/g, " ").trim();
  if (/^(https?:|file:)/i.test(normalized)) {
    try {
      const url = new URL(normalized);
      return `${url.hostname}${url.pathname.length > 1 ? compactPath(url.pathname) : ""}`;
    } catch {
      return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
    }
  }
  if (normalized.includes("/")) return compactPath(normalized);
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

function compactPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length === 0) return value;
  return `.../${parts.slice(-2).join("/")}`;
}

function renderToolIcon(toolName: string): ReactNode {
  const name = toolName.toLowerCase();
  if (name.includes("run_command") || name.includes("shell") || name.includes("command") || name.includes("terminal")) return <Terminal size={14} />;
  if (name.includes("edit") || name.includes("write") || name.includes("patch")) return <PencilLine size={14} />;
  if (name.includes("search")) return <Search size={14} />;
  if (name.includes("list")) return <ListIcon size={14} />;
  if (name.includes("read") || name.includes("file")) return <Eye size={14} />;
  if (name.includes("web") || name.includes("network") || name.includes("browser")) return <Globe2 size={14} />;
  if (name.includes("knowledge") || name.includes("rag") || name.includes("skill")) return <BookOpen size={14} />;
  if (name.includes("mcp")) return <Plug size={14} />;
  if (name.includes("attachment") || name.includes("document")) return <FileText size={14} />;
  return <Wrench size={14} />;
}

function parseToolOutput(output: string): { summary: string; preview: string; display: string; rawOutputRef?: string; citations: Array<{ key: string; title: string; heading?: string; source?: string; excerpt: string }> } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const rawSummary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    const summary = isPlaceholderToolSummary(rawSummary) ? "" : rawSummary;
    const rawOutputRef = typeof parsed["rawOutputRef"] === "string" ? parsed["rawOutputRef"] : undefined;
    const citations = extractCitations(parsed);
    const compact = stringifyToolDisplay(parsed, summary);
    return {
      summary: summary ? firstUsefulLine(summary) : "",
      preview: summary ? "" : firstUsefulToolPreview(parsed),
      display: compact,
      citations,
      ...(rawOutputRef ? { rawOutputRef } : {})
    };
  } catch {
    const placeholder = isPlaceholderToolSummary(output);
    const summary = placeholder ? "" : firstUsefulLine(output);
    return {
      summary,
      preview: summary || placeholder ? "" : output.trim().slice(0, 1200),
      display: placeholder ? "" : output,
      citations: []
    };
  }
}

function isPlaceholderToolSummary(value: string): boolean {
  return /^(tool evidence returned\.?|工具证据已返回。?)$/i.test(value.trim());
}

function stringifyToolDisplay(parsed: Record<string, unknown>, summary: string): string {
  if (summary) return summary;
  const { summary: _summary, ...rest } = parsed;
  return JSON.stringify(rest, null, 2);
}

function firstUsefulToolPreview(parsed: Record<string, unknown>): string {
  const rows = Array.isArray(parsed["entries"]) ? parsed["entries"] : Array.isArray(parsed["results"]) ? parsed["results"] : null;
  if (rows && rows.length > 0) {
    return rows
      .slice(0, 6)
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const record = item as Record<string, unknown>;
        return String(record["name"] ?? record["title"] ?? record["path"] ?? record["sourceUri"] ?? JSON.stringify(record));
      })
      .join("\n");
  }
  const path = typeof parsed["path"] === "string" ? parsed["path"] : typeof parsed["cwd"] === "string" ? parsed["cwd"] : "";
  return path;
}

function extractCitations(parsed: Record<string, unknown>): Array<{ key: string; title: string; heading?: string; source?: string; excerpt: string }> {
  const results = Array.isArray(parsed["results"]) ? parsed["results"] : [];
  return results
    .flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const citation = record["citation"] && typeof record["citation"] === "object" ? (record["citation"] as Record<string, unknown>) : record;
      const title = String(citation["title"] ?? record["title"] ?? "");
      const chunkId = String(citation["chunkId"] ?? record["chunkId"] ?? index);
      const excerpt = String(citation["excerpt"] ?? record["excerpt"] ?? "");
      if (!title && !excerpt) return [];
      return [{
        key: chunkId,
        title: title || "Knowledge",
        ...(typeof citation["heading"] === "string" ? { heading: citation["heading"] } : {}),
        ...(typeof citation["sourceUri"] === "string" ? { source: citation["sourceUri"] } : {}),
        excerpt
      }];
    })
    .slice(0, 6);
}

function firstUsefulLine(output: string): string {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return "";
  return first.length > 220 ? `${first.slice(0, 220)}...` : first;
}
