import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
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
  "user_input_requested",
  "user_input_answered",
  "approval_pending",
  "tool_result",
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
  showThinking = true,
  onApprovalDecision,
  onRevertTurn
}: {
  language?: string | null;
  task: TaskDetail | null;
  showThinking?: boolean | undefined;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onRevertTurn?: ((turnId: string) => Promise<void> | void) | undefined;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const scrollAnimationRef = useRef<number | null>(null);
  const scrollFollowUntilRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(MAX_RENDERED_TIMELINE_ITEMS);
  const items = useMemo(
    () =>
      buildTimelineItems(
        (Array.isArray(task?.events) ? task.events : []).filter((event) => {
          if (!event || !visibleEventTypes.has(event.type)) return false;
          if (!showThinking && event.type === "thinking_delta") return false;
          if (event?.payload?.["uiHidden"] === true) return false;
          if (isInlineToolMarkupEvent(event)) return false;
          if (event.type !== "approval_pending") return true;
          const approvalId = String(event?.payload?.["approvalId"] ?? "");
          const safeApprovals = Array.isArray(task?.approvals) ? task.approvals : [];
          return safeApprovals.some((approval) => approval?.id === approvalId && approval?.status === "pending");
        })
      ),
    [task, showThinking]
  );
  const safeEvents = Array.isArray(task?.events) ? task.events : [];
  const lastEventId = safeEvents[safeEvents.length - 1]?.id ?? "empty";
  const timelineVersion = useMemo(() => getTimelineVersion(items), [items]);
  const displayItems = useMemo(() => limitTimelineItems(items, language, visibleLimit), [items, language, visibleLimit]);
  const latestVisibleAgentBodyKey = useMemo(() => {
    const latest = displayItems[displayItems.length - 1];
    return latest && isAgentMessageItem(latest) ? latest.key : null;
  }, [displayItems]);
  const showRunningIndicator = Boolean(task?.status === "running");
  const runningIndicatorItem = useMemo<TimelineItem | null>(
    () => showRunningIndicator && task ? { key: `running-status:${task.id}`, kind: "status" } : null,
    [showRunningIndicator, task?.id]
  );

  useEffect(() => {
    followBottomRef.current = true;
    setAtBottom(true);
    setVisibleLimit(MAX_RENDERED_TIMELINE_ITEMS);
  }, [task?.id]);

  const updateBottomState = useCallback((node: HTMLDivElement) => {
    const isAtBottom = getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE;
    if (Date.now() < scrollFollowUntilRef.current) {
      followBottomRef.current = true;
      if (isAtBottom) {
        scrollFollowUntilRef.current = 0;
        setAtBottom(true);
      }
      return isAtBottom;
    }
    if (!isAtBottom && scrollAnimationRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationRef.current);
      scrollAnimationRef.current = null;
    }
    followBottomRef.current = isAtBottom;
    setAtBottom(isAtBottom);
    return isAtBottom;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = timelineRef.current;
    if (!node) return;
    const smooth = behavior === "smooth" && !prefersReducedMotion();
    scrollFollowUntilRef.current = Date.now() + (smooth ? 360 : 80);
    animateScrollToBottom(node, smooth ? 220 : 0, scrollAnimationRef, () => {
      scrollFollowUntilRef.current = 0;
      setAtBottom(getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE);
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
      scrollToBottom(taskChanged ? "auto" : "smooth");
    }
  }, [task?.id, lastEventId, timelineVersion, showRunningIndicator, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scrollToBottom("smooth");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [task?.id, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollAnimationRef.current !== null) window.cancelAnimationFrame(scrollAnimationRef.current);
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
        <div className="timelineContent" ref={contentRef}>
          {displayItems.map((item) => (
            <AnimatedTimelineItem item={item} key={item.key}>
              <TimelineEvent
                item={item}
                approvals={task.approvals}
                copied={copiedKey === item.key}
                alwaysShowActions={item.key === latestVisibleAgentBodyKey}
                language={language ?? null}
                canRevert={item.kind === "event" && item.event.type === "user_message" && !item.event.reverted && typeof item.event.payload["turnId"] === "string" && Boolean(onRevertTurn)}
                onApprovalDecision={onApprovalDecision}
                onCopy={(text) => {
                  void copyText(text);
                  setCopiedKey(item.key);
                  window.setTimeout(() => setCopiedKey((current) => (current === item.key ? null : current)), 1400);
                }}
                onLoadOlder={() => setVisibleLimit((current) => Math.min(items.length, current + MAX_RENDERED_TIMELINE_ITEMS))}
                onRevertTurn={onRevertTurn}
              />
            </AnimatedTimelineItem>
          ))}
          {runningIndicatorItem ? (
            <AnimatedTimelineItem item={runningIndicatorItem} key={runningIndicatorItem.key}>
              <RunningStatus language={language ?? null} />
            </AnimatedTimelineItem>
          ) : null}
        </div>
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
  | { key: string; kind: "notice"; summary: string; hiddenCount?: number }
  | { key: string; kind: "status" };

function AnimatedTimelineItem({ children, item }: { children: ReactNode; item: TimelineItem }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number | null>(null);
  const version = timelineItemContentVersion(item);

  useLayoutEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const nextHeight = node.getBoundingClientRect().height;
    const previousHeight = previousHeightRef.current;
    previousHeightRef.current = nextHeight;
    if (previousHeight === null || prefersReducedMotion()) return;
    const delta = Math.abs(nextHeight - previousHeight);
    if (delta < 2 || delta > 1600) return;
    node.style.height = `${previousHeight}px`;
    node.style.overflow = "hidden";
    node.style.willChange = "height";
    const frame = window.requestAnimationFrame(() => {
      node.style.transition = "height 180ms cubic-bezier(0.2, 0, 0, 1)";
      node.style.height = `${nextHeight}px`;
    });
    const timer = window.setTimeout(() => {
      node.style.height = "";
      node.style.overflow = "";
      node.style.transition = "";
      node.style.willChange = "";
    }, 220);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [version]);

  const side = timelineItemSide(item);
  return (
    <div className={`timelineItemShell ${side === "right" ? "fromRight" : "fromLeft"}`} data-timeline-item-key={item.key} ref={shellRef}>
      {children}
    </div>
  );
}

function timelineItemSide(item: TimelineItem): "left" | "right" {
  if (item.kind === "status") return "left";
  if (item.kind !== "event") return "left";
  return item.event.type === "user_message" || item.event.type === "guidance_pending" || item.event.type === "attachment_added"
    ? "right"
    : "left";
}

function timelineItemContentVersion(item: TimelineItem): string {
  if (item.kind === "stream") return `${item.key}:${item.summary.length}`;
  if (item.kind === "notice") return `${item.key}:${item.summary.length}:${item.hiddenCount ?? 0}`;
  if (item.kind === "status") return item.key;
  const output = typeof item.event.payload["output"] === "string" ? String(item.event.payload["output"]).length : 0;
  return `${item.key}:${item.event.summary.length}:${output}`;
}

function isAgentMessageItem(item: TimelineItem): boolean {
  if (item.kind === "stream") return item.type === "assistant_delta";
  if (item.kind === "notice" || item.kind === "status") return false;
  return item.event.type === "assistant_message";
}

function getDistanceFromBottom(node: HTMLDivElement): number {
  return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

function animateScrollToBottom(
  node: HTMLDivElement,
  durationMs: number,
  frameRef: MutableRefObject<number | null>,
  onDone: () => void
): void {
  if (frameRef.current !== null) {
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }
  const targetTop = () => Math.max(0, node.scrollHeight - node.clientHeight);
  if (durationMs <= 0 || prefersReducedMotion()) {
    node.scrollTop = targetTop();
    onDone();
    return;
  }
  const startedAt = performance.now();
  const startTop = node.scrollTop;
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    const target = targetTop();
    node.scrollTop = startTop + (target - startTop) * eased;
    if (progress < 1) {
      frameRef.current = window.requestAnimationFrame(step);
      return;
    }
    frameRef.current = null;
    node.scrollTop = targetTop();
    onDone();
  };
  frameRef.current = window.requestAnimationFrame(step);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getTimelineVersion(items: TimelineItem[]): string {
  return items
    .slice(-8)
    .map((item) => {
      if (item.kind === "stream") return `${item.key}:${item.summary.length}`;
      if (item.kind === "notice") return item.key;
      if (item.kind === "status") return item.key;
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
  onLoadOlder,
  onRevertTurn
}: {
  item: TimelineItem;
  approvals: ToolApproval[];
  alwaysShowActions: boolean;
  canRevert: boolean;
  copied: boolean;
  language?: string | null | undefined;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onCopy: (text: string) => void;
  onLoadOlder: () => void;
  onRevertTurn?: ((turnId: string) => Promise<void> | void) | undefined;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const zh = language === "zh-CN";
  if (item.kind === "status") {
    return <RunningStatus language={language} />;
  }
  if (item.kind === "notice") {
    return (
      <article className="event note timeline_window_notice">
        <span>{item.summary}</span>
        {item.hiddenCount && item.hiddenCount > 0 ? (
          <button className="loadOlderTimelineButton" type="button" onClick={onLoadOlder}>
            {zh ? `显示更早 ${Math.min(item.hiddenCount, MAX_RENDERED_TIMELINE_ITEMS)} 条` : `Load ${Math.min(item.hiddenCount, MAX_RENDERED_TIMELINE_ITEMS)} older`}
          </button>
        ) : null}
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

  if (event.type === "user_input_requested") {
    const options = Array.isArray(event.payload["options"]) ? event.payload["options"].map(String).filter(Boolean) : [];
    return (
      <article className="event user_input_requested">
        <small>{zh ? "需要用户确认" : "User input needed"}</small>
        <MarkdownText content={event.summary} />
        {typeof event.payload["details"] === "string" ? <p className="muted">{String(event.payload["details"])}</p> : null}
        {options.length > 0 ? (
          <div className="askUserOptions">
            {options.map((option) => <span key={option}>{option}</span>)}
          </div>
        ) : null}
      </article>
    );
  }

  if (event.type === "user_input_answered") {
    return (
      <article className="event user_input_answered">
        <small>{zh ? "用户回答" : "User answered"}</small>
        <MarkdownText content={event.summary} />
      </article>
    );
  }

  if (event.type === "tool_result") {
    const output = String(event.payload["output"] ?? "");
    const parsed = parseToolOutput(output);
    const toolName = String(event.payload["toolName"] ?? "tool");
    const ok = Boolean(event.payload["ok"] ?? false);
    const visibleOutput = parsed.display.trim() || parsed.summary || parsed.preview || (zh ? "没有可展示的工具返回内容。" : "No visible tool output.");
    const fullTarget = fullToolTarget(event.payload, parsed);
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
            {parsed.changes ? <LineChangeBadge added={parsed.changes.addedLines} removed={parsed.changes.removedLines} /> : null}
            <ChevronDown className="toolResultChevron" size={13} />
          </button>
          <div className="toolResultBodyShell">
            <div className="toolResultBody">
              {fullTarget ? <div className="toolFullPath" title={fullTarget}>{fullTarget}</div> : null}
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
        onRevert={canRevert ? () => void onRevertTurn?.(String(event.payload["turnId"])) : undefined}
      />
      <MarkdownText content={formatVisibleEventSummary(event, language)} />
    </article>
  );
}

function RunningStatus({ language }: { language?: string | null | undefined }) {
  const label = language === "zh-CN" ? "think" : "think";
  return (
    <article className="event running_status" aria-live="polite" aria-label="think...">
      <span>{label}</span>
      <span className="thinkingDots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </article>
  );
}

function LineChangeBadge({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="lineChangeBadge" aria-label={`+${added} -${removed}`}>
      <span className="added">+{added}</span>
      <span className="removed">-{removed}</span>
    </span>
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

function isInlineToolMarkupEvent(event: TaskEvent | null | undefined): boolean {
  if (!event) return false;
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return false;
  return containsInlineToolMarkup(formatRawEventText(event));
}

function formatRawEventText(event: TaskEvent | null | undefined): string {
  if (!event) return "";
  return [
    event.summary ?? "",
    typeof event?.payload?.["message"] === "string" ? event.payload["message"] : "",
    typeof event?.payload?.["delta"] === "string" ? event.payload["delta"] : "",
    typeof event?.payload?.["text"] === "string" ? event.payload["text"] : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function containsInlineToolMarkup(value: string): boolean {
  return /<function_calls\b|<invoke\s+name=/i.test(value);
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
  return items.filter((item) => {
    if (item.kind !== "stream") return true;
    const summary = item.summary.trim();
    return summary.length > 0 && !containsInlineToolMarkup(summary);
  });
}

function limitTimelineItems(items: TimelineItem[], language?: string | null, visibleLimit = MAX_RENDERED_TIMELINE_ITEMS): TimelineItem[] {
  if (items.length <= visibleLimit) return items;
  const tail = items.slice(-visibleLimit);
  const tailKeys = new Set(tail.map((item) => item.key));
  const anchors = items
    .slice(0, -visibleLimit)
    .filter(isPreservedTimelineAnchor)
    .filter((item) => !tailKeys.has(item.key));
  const hidden = Math.max(0, items.length - tail.length - anchors.length);
  const ordered = [...anchors, ...tail].sort((left, right) => itemTimestamp(left).localeCompare(itemTimestamp(right)));
  if (hidden <= 0) return ordered;
  return [{
    key: `timeline-window-notice-${hidden}-${visibleLimit}`,
    kind: "notice",
    hiddenCount: hidden,
    summary: language === "zh-CN"
      ? `较早 ${hidden} 条助手/工具信息暂未渲染，完整历史仍保留。`
      : `${hidden} older assistant/tool items are not rendered yet. Full history is retained.`
  }, ...ordered];
}

function isPreservedTimelineAnchor(item: TimelineItem): boolean {
  if (item.kind !== "event") return false;
  return (
    item.event.type === "user_message" ||
    item.event.type === "attachment_added"
  );
}

function itemTimestamp(item: TimelineItem): string {
  return item.kind === "event" ? item.event.createdAt : item.key;
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

function parseToolOutput(output: string): { summary: string; preview: string; display: string; rawOutputRef?: string; citations: Array<{ key: string; title: string; heading?: string; source?: string; excerpt: string }>; changes?: { path: string; addedLines: number; removedLines: number; operation?: string } } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const rawSummary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    const summary = isPlaceholderToolSummary(rawSummary) ? "" : rawSummary;
    const rawOutputRef = typeof parsed["rawOutputRef"] === "string" ? parsed["rawOutputRef"] : undefined;
    const citations = extractCitations(parsed);
    const compact = stringifyToolDisplay(parsed, summary);
    const changes = extractLineChanges(parsed);
    return {
      summary: summary ? firstUsefulLine(summary) : "",
      preview: summary ? "" : firstUsefulToolPreview(parsed),
      display: compact,
      citations,
      ...(changes ? { changes } : {}),
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

function extractLineChanges(parsed: Record<string, unknown>): { path: string; addedLines: number; removedLines: number; operation?: string } | undefined {
  const value = parsed["changes"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const addedLines = Number(record["addedLines"] ?? 0);
  const removedLines = Number(record["removedLines"] ?? 0);
  if (!Number.isFinite(addedLines) || !Number.isFinite(removedLines)) return undefined;
  return {
    path: String(record["path"] ?? parsed["path"] ?? ""),
    addedLines: Math.max(0, Math.round(addedLines)),
    removedLines: Math.max(0, Math.round(removedLines)),
    ...(typeof record["operation"] === "string" ? { operation: record["operation"] } : {})
  };
}

function fullToolTarget(payload: Record<string, unknown>, parsed: ReturnType<typeof parseToolOutput>): string {
  if (parsed.changes?.path) return parsed.changes.path;
  const args = payload["args"] && typeof payload["args"] === "object" ? (payload["args"] as Record<string, unknown>) : {};
  return firstStringArg(args, ["path", "file", "targetPath", "cwd", "url"]);
}

function isPlaceholderToolSummary(value: string): boolean {
  return /^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(value.trim());
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
