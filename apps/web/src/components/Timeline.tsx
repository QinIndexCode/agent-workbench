import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { ApprovalDecision, TaskDetail, TaskEvent, TaskRollbackPreview, TaskRollbackRequest, TaskRollbackResult, ToolApproval } from "@agent-workbench/shared";
import { ArrowDown, BookOpen, ChevronDown, Copy, Eye, FileText, Globe2, List as ListIcon, PencilLine, Plug, Search, Sparkles, Terminal, Wrench } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { api } from "../api.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { MarkdownText } from "./MarkdownText.js";
import { describeSkillSource, describeSkillStatus, parseLoadedSkillEvent } from "./skillUx.js";

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
  "tool_requested",
  "tool_started",
  "tool_progress",
  "tool_result",
  "skill_loaded",
  "model_empty_response",
  "model_no_progress",
  "subagent_spawned",
  "subagent_status_changed",
  "subagent_completed",
  "subagent_failed",
  "task_checkpoint_created",
  "task_rollback_completed",
  "task_rollback_failed",
  "plan_step_blocked",
  "web_search_result"
]);

const FOLLOW_BOTTOM_DISTANCE = 56;
const USER_SCROLL_UP_RELEASE_DISTANCE = 8;
const MAX_RENDERED_TIMELINE_ITEMS = 360;
const LARGE_READ_FILE_SUMMARY_BYTES = 24 * 1024;
const LARGE_READ_FILE_SUMMARY_LINES = 360;
const LARGE_READ_FILE_SUMMARY_CHARS = 24 * 1024;
const THINKING_PREVIEW_CHARS = 280;
const THINKING_BODY_PREVIEW_CHARS = 24 * 1024;
const LONG_MARKDOWN_INLINE_CHARS = 10 * 1024;
const LONG_TEXT_PAGE_CHARS = 12 * 1024;
const LIVE_TEXT_PREVIEW_CHARS = 12 * 1024;
const LIVE_TEXT_HEAD_CHARS = 3 * 1024;
const LIVE_TEXT_TAIL_CHARS = 9 * 1024;
const LIVE_STREAM_SMOOTH_FRAME_MS = 26;
const LIVE_STREAM_SMOOTH_MIN_CHARS = 22;
const LIVE_STREAM_SMOOTH_MAX_CHARS = 96;
const LIVE_STREAM_SMOOTH_MAX_LAG_CHARS = 1800;
const LIVE_STREAM_BOUNDARY_CHARS = " \t\n\r.,;:!?，。！？；：、)]}）】》>\"'”’";

export function Timeline({
  language,
  task,
  showThinking = true,
  scrollContainerRef,
  focusEventId,
  onLoadStreamText,
  onPreviewRollback,
  onRollback,
  onApprovalDecision,
  onAnswerUserInput,
  onRevertTurn
}: {
  language?: string | null;
  task: TaskDetail | null;
  showThinking?: boolean | undefined;
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null> | undefined;
  focusEventId?: string | null | undefined;
  onLoadStreamText?: ((taskId: string, streamId: string, type: "assistant_delta" | "thinking_delta") => Promise<string>) | undefined;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onAnswerUserInput?: ((answer: string) => Promise<void> | void) | undefined;
  onRevertTurn?: ((turnId: string) => Promise<void> | void) | undefined;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const scrollAnimationRef = useRef<number | null>(null);
  const resizeFollowFrameRef = useRef<number | null>(null);
  const scrollFollowUntilRef = useRef(0);
  const lastObservedScrollTopRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [jumpButtonPosition, setJumpButtonPosition] = useState<{ bottom: number; left: number } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(MAX_RENDERED_TIMELINE_ITEMS);
  const taskId = task?.id ?? null;
  const safeEvents = useMemo(() => (Array.isArray(task?.events) ? task.events : []), [task]);
  const safeApprovals = useMemo(() => (Array.isArray(task?.approvals) ? task.approvals : []), [task]);
  const items = useMemo(
    () =>
      buildTimelineItems(
        safeEvents.filter((event) => {
          if (!event || !visibleEventTypes.has(event.type)) return false;
          if (!showThinking && event.type === "thinking_delta") return false;
          if (event?.payload?.["uiHidden"] === true) return false;
          if (isInlineToolMarkupEvent(event)) return false;
          if (event.type !== "approval_pending") return true;
          const approvalId = String(event?.payload?.["approvalId"] ?? "");
          return safeApprovals.some((approval) => approval?.id === approvalId && approval?.status === "pending");
        })
      ),
    [safeApprovals, safeEvents, showThinking]
  );
  const lastEventId = safeEvents[safeEvents.length - 1]?.id ?? "empty";
  const timelineVersion = useMemo(() => getTimelineVersion(items), [items]);
  const displayItems = useMemo(() => limitTimelineItems(items, language, visibleLimit), [items, language, visibleLimit]);
  const latestVisibleAgentBodyKey = useMemo(() => {
    for (let index = displayItems.length - 1; index >= 0; index -= 1) {
      const item = displayItems[index];
      if (item && isAgentMessageItem(item)) return item.key;
    }
    return null;
  }, [displayItems]);
  const showRunningIndicator = Boolean(task?.status === "running");
  const runningIndicatorItem = useMemo<TimelineItem | null>(
    () => showRunningIndicator && taskId ? { key: `running-status:${taskId}`, kind: "status" } : null,
    [showRunningIndicator, taskId]
  );
  const getScrollNode = useCallback(() => scrollContainerRef?.current ?? timelineRef.current, [scrollContainerRef]);

  useEffect(() => {
    followBottomRef.current = true;
    setAtBottom(true);
    setVisibleLimit(MAX_RENDERED_TIMELINE_ITEMS);
  }, [taskId]);

  const updateBottomState = useCallback((node: HTMLDivElement) => {
    const previousScrollTop = lastObservedScrollTopRef.current;
    const scrollDelta = node.scrollTop - previousScrollTop;
    lastObservedScrollTopRef.current = node.scrollTop;
    const isAtBottom = getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE;
    if (Date.now() < scrollFollowUntilRef.current) {
      const userPulledAway = scrollDelta < -USER_SCROLL_UP_RELEASE_DISTANCE && !isAtBottom;
      if (userPulledAway) {
        if (scrollAnimationRef.current !== null) {
          window.cancelAnimationFrame(scrollAnimationRef.current);
          scrollAnimationRef.current = null;
        }
        scrollFollowUntilRef.current = 0;
        followBottomRef.current = false;
        setAtBottom(false);
        return false;
      }
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
    const node = getScrollNode();
    if (!node) return;
    const smooth = behavior === "smooth" && !prefersReducedMotion();
    scrollFollowUntilRef.current = Date.now() + (smooth ? 360 : 80);
    animateScrollToBottom(node, smooth ? 220 : 0, scrollAnimationRef, () => {
      lastObservedScrollTopRef.current = node.scrollTop;
      scrollFollowUntilRef.current = 0;
      setAtBottom(getDistanceFromBottom(node) <= FOLLOW_BOTTOM_DISTANCE);
    });
  }, [getScrollNode]);

  const scheduleFollowBottom = useCallback(() => {
    if (!followBottomRef.current || resizeFollowFrameRef.current !== null) return;
    resizeFollowFrameRef.current = window.requestAnimationFrame(() => {
      resizeFollowFrameRef.current = null;
      if (followBottomRef.current) scrollToBottom("auto");
    });
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const node = getScrollNode();
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
  }, [getScrollNode, task?.id, lastEventId, timelineVersion, showRunningIndicator, scrollToBottom]);

  useEffect(() => {
    if (!focusEventId) return;
    const node = getScrollNode();
    if (!node) return;
    const target = Array.from(node.querySelectorAll<HTMLElement>("[data-event-id]")).find((item) => item.dataset.eventId === focusEventId);
    if (!target) {
      if (displayItems.length < items.length) setVisibleLimit(items.length);
      return;
    }
    followBottomRef.current = false;
    setAtBottom(false);
    target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    target.classList.add("timelineFocusPulse");
    const timer = window.setTimeout(() => target.classList.remove("timelineFocusPulse"), 1100);
    return () => window.clearTimeout(timer);
  }, [displayItems.length, focusEventId, getScrollNode, items.length]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      scheduleFollowBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleFollowBottom, task?.id]);

  useEffect(() => {
    const node = getScrollNode();
    if (!node) return;
    const handleScroll = () => {
      updateBottomState(node);
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => node.removeEventListener("scroll", handleScroll);
  }, [getScrollNode, task?.id, updateBottomState]);

  useLayoutEffect(() => {
    const node = getScrollNode();
    if (!node) return;
    const updateJumpButtonPosition = () => {
      const rect = node.getBoundingClientRect();
      const next = {
        left: rect.left + rect.width / 2,
        bottom: Math.max(18, window.innerHeight - rect.bottom + 24)
      };
      setJumpButtonPosition((current) =>
        current && Math.abs(current.left - next.left) < 0.5 && Math.abs(current.bottom - next.bottom) < 0.5 ? current : next
      );
    };
    updateJumpButtonPosition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateJumpButtonPosition);
    observer?.observe(node);
    window.addEventListener("resize", updateJumpButtonPosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateJumpButtonPosition);
    };
  }, [getScrollNode, task?.id]);

  useEffect(() => {
    return () => {
      if (scrollAnimationRef.current !== null) window.cancelAnimationFrame(scrollAnimationRef.current);
      if (resizeFollowFrameRef.current !== null) window.cancelAnimationFrame(resizeFollowFrameRef.current);
    };
  }, []);

  if (!task) return <div className="empty">{getUiCopy(language).thread.startGoal}</div>;

  return (
    <div className="timelineWrap">
      <div
        className="timeline"
        data-task-id={task.id}
        ref={timelineRef}
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
                taskId={task.id}
                canRevert={item.kind === "event" && item.event.type === "user_message" && !item.event.reverted && typeof item.event.payload["turnId"] === "string" && Boolean(onRevertTurn)}
                onLoadStreamText={onLoadStreamText}
                onPreviewRollback={onPreviewRollback}
                onRollback={onRollback}
                onApprovalDecision={onApprovalDecision}
                onAnswerUserInput={onAnswerUserInput}
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
        <div
          className="jumpToBottomAnchor"
          style={jumpButtonPosition ? { bottom: jumpButtonPosition.bottom, left: jumpButtonPosition.left } : undefined}
        >
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
        </div>
      ) : null}
    </div>
  );
}

type TimelineItem =
  | { key: string; kind: "event"; event: TaskEvent }
  | { key: string; kind: "stream"; type: "assistant_delta" | "thinking_delta"; streamId: string; summary: string; payload: Record<string, unknown> }
  | { key: string; kind: "tool"; toolCallId: string; events: ToolTimelineEvent[] }
  | { key: string; kind: "notice"; summary: string; hiddenCount?: number }
  | { key: string; kind: "status" };

type ToolTimelineEvent = TaskEvent & { type: "tool_requested" | "tool_started" | "tool_progress" | "tool_result" };

function AnimatedTimelineItem({ children, item }: { children: ReactNode; item: TimelineItem }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number | null>(null);
  const version = timelineItemContentVersion(item);
  const animateHeight = shouldAnimateTimelineItemHeight(item);

  useLayoutEffect(() => {
    if (!animateHeight) {
      previousHeightRef.current = null;
      return;
    }
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
  }, [animateHeight, version]);

  const side = timelineItemSide(item);
  const eventId = timelineItemPrimaryEventId(item);
  return (
    <div
      className={`timelineItemShell ${side === "right" ? "fromRight" : "fromLeft"}`}
      data-event-id={eventId ?? undefined}
      data-timeline-item-key={item.key}
      ref={shellRef}
    >
      {children}
    </div>
  );
}

function timelineItemPrimaryEventId(item: TimelineItem): string | null {
  if (item.kind === "event") return item.event.id;
  if (item.kind === "tool") return item.events[0]?.id ?? null;
  return null;
}

function timelineItemSide(item: TimelineItem): "left" | "right" {
  if (item.kind === "status") return "left";
  if (item.kind !== "event") return "left";
  return item.event.type === "user_message" || item.event.type === "guidance_pending" || item.event.type === "attachment_added"
    ? "right"
    : "left";
}

function timelineItemContentVersion(item: TimelineItem): string {
  if (item.kind === "stream") {
    const lengthBucket = item.type === "thinking_delta" ? Math.floor(item.summary.length / 512) : item.summary.length;
    return `${item.key}:${lengthBucket}`;
  }
  if (item.kind === "tool") return `${item.key}:${item.events.length}:${toolResultEvent(item)?.payload["output"] ? String(toolResultEvent(item)?.payload["output"]).length : 0}:${JSON.stringify(toolLatestPayload(item)).length}`;
  if (item.kind === "notice") return `${item.key}:${item.summary.length}:${item.hiddenCount ?? 0}`;
  if (item.kind === "status") return item.key;
  const output = typeof item.event.payload["output"] === "string" ? String(item.event.payload["output"]).length : 0;
  return `${item.key}:${item.event.summary.length}:${output}`;
}

function shouldAnimateTimelineItemHeight(item: TimelineItem): boolean {
  if (item.kind === "stream" || item.kind === "tool") return false;
  if (item.kind === "notice" || item.kind === "status") return true;
  const output = typeof item.event.payload["output"] === "string" ? String(item.event.payload["output"]).length : 0;
  return item.event.summary.length + output <= 3000;
}

function isAgentMessageItem(item: TimelineItem): boolean {
  if (item.kind === "stream") return item.type === "assistant_delta";
  if (item.kind === "notice" || item.kind === "status" || item.kind === "tool") return false;
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
      if (item.kind === "tool") return `${item.key}:${item.events.length}:${timelineItemContentVersion(item)}`;
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
  taskId,
  onLoadStreamText,
  onPreviewRollback,
  onRollback,
  onApprovalDecision,
  onAnswerUserInput,
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
  taskId: string;
  onLoadStreamText?: ((taskId: string, streamId: string, type: "assistant_delta" | "thinking_delta") => Promise<string>) | undefined;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onAnswerUserInput?: ((answer: string) => Promise<void> | void) | undefined;
  onCopy: (text: string) => void;
  onLoadOlder: () => void;
  onRevertTurn?: ((turnId: string) => Promise<void> | void) | undefined;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingLoadedBody, setThinkingLoadedBody] = useState<string | null>(null);
  const [thinkingLoading, setThinkingLoading] = useState(false);
  const [thinkingLoadError, setThinkingLoadError] = useState<string | null>(null);
  const [toolOpen, setToolOpen] = useState(false);
  const zh = language === "zh-CN";
  const thinkingSummary = item.kind === "stream" && item.type === "thinking_delta" ? item.summary : "";
  const lazyThinkingBody = item.kind === "stream" && item.type === "thinking_delta" && item.payload["lazyBody"] === true;
  const rawThinkingBody = thinkingLoadedBody ?? (lazyThinkingBody ? "" : thinkingSummary);
  const thinkingPreview = useMemo(
    () => (thinkingSummary ? compactInline(normalizeThinkingDisplayText(truncateThinkingPreview(thinkingSummary))) : ""),
    [thinkingSummary]
  );
  const thinkingBodyText = useMemo(
    () => (thinkingOpen && rawThinkingBody ? normalizeThinkingDisplayText(rawThinkingBody) : ""),
    [rawThinkingBody, thinkingOpen]
  );
  const visibleThinkingBodyText = useMemo(
    () => truncateThinkingBodyForDisplay(thinkingBodyText, zh),
    [thinkingBodyText, zh]
  );

  async function ensureThinkingBodyLoaded(): Promise<string> {
    if (item.kind !== "stream" || item.type !== "thinking_delta") return "";
    if (!lazyThinkingBody || thinkingLoadedBody) return thinkingLoadedBody ?? thinkingSummary;
    if (!onLoadStreamText || !item.streamId) {
      const message = zh ? "当前无法加载完整思考内容。" : "Full thinking is unavailable right now.";
      setThinkingLoadError(message);
      throw new Error(message);
    }
    setThinkingLoading(true);
    setThinkingLoadError(null);
    try {
      const text = await onLoadStreamText(taskId, item.streamId, "thinking_delta");
      setThinkingLoadedBody(text);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setThinkingLoadError(message);
      throw error;
    } finally {
      setThinkingLoading(false);
    }
  }

  async function copyThinkingText(): Promise<void> {
    try {
      const text = lazyThinkingBody ? await ensureThinkingBodyLoaded() : thinkingSummary;
      onCopy(normalizeThinkingDisplayText(text));
    } catch {
      // Keep the current UI state; the inline error is already shown when loading fails.
    }
  }

  function toggleThinkingCard(): void {
    const nextOpen = !thinkingOpen;
    setThinkingOpen(nextOpen);
    if (nextOpen && lazyThinkingBody && !thinkingLoadedBody && !thinkingLoading) {
      void ensureThinkingBodyLoaded();
    }
  }

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
              onClick={toggleThinkingCard}
              type="button"
            >
              <span className="thinkingLabel">{zh ? "思考" : "Thinking"}</span>
              <span className="thinkingPreview">{thinkingPreview}</span>
              <ChevronDown className="thinkingChevron" size={13} />
            </button>
            <div className="thinkingExpandedActions" aria-hidden={!thinkingOpen}>
              <button
                aria-label={zh ? "复制思考内容" : "Copy thinking"}
                disabled={thinkingLoading}
                title={zh ? "复制思考内容" : "Copy thinking"}
                type="button"
                onClick={() => void copyThinkingText()}
              >
                <Copy size={14} />
              </button>
              {copied ? <span>{zh ? "已复制" : "Copied"}</span> : null}
            </div>
            <div className="thinkingBodyShell">
              {thinkingOpen ? (
                <div className="thinkingBody">
                  {thinkingLoading ? (
                    <p className="thinkingStatus">{zh ? "正在加载完整思考内容…" : "Loading full thinking…"}</p>
                  ) : thinkingLoadError ? (
                    <div className="thinkingStatus">
                      <p>{thinkingLoadError}</p>
                      <button type="button" onClick={() => void ensureThinkingBodyLoaded()}>
                        {zh ? "重试" : "Retry"}
                      </button>
                    </div>
                  ) : (
                    <pre className="thinkingBodyText">{visibleThinkingBodyText}</pre>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </article>
      );
    }
    return (
      <article className="event assistant_delta streaming" aria-live="polite" data-streaming="true">
        <MessageActions alwaysShow={alwaysShowActions} copied={copied} language={language} onCopy={() => onCopy(item.summary)} />
        <div className="streamingAssistantBody">
          <TimelineText content={item.summary} language={language} live smooth />
          <span className="streamingCaret" aria-hidden="true" />
        </div>
      </article>
    );
  }

  if (item.kind === "tool") {
    const result = toolResultEvent(item);
    const payload = toolPrimaryPayload(item);
    const progress = toolLatestProgressPayload(item);
    const toolName = toolNameForItem(item);
    const ok = result ? Boolean(result.payload["ok"] ?? false) : true;
    const status = toolStatusForItem(item);
    const parsedHeader = result ? parseToolOutputHeader(String(result.payload["output"] ?? "")) : null;
    const parsed = result && toolOpen ? parseToolOutput(String(result.payload["output"] ?? "")) : null;
    const parsedForTarget = parsed ?? (parsedHeader ? { ...emptyParsedToolOutput(), ...(parsedHeader.changes ? { changes: parsedHeader.changes } : {}) } : emptyParsedToolOutput());
    const changes = extractPayloadChanges(progress) ?? parsed?.changes ?? parsedHeader?.changes ?? extractPayloadChanges(payload);
    const displayMode = parsed?.displayMode ?? parsedHeader?.displayMode ?? String(progress["displayMode"] ?? payload["displayMode"] ?? "");
    const fullTarget = fullToolTarget(payload, parsedForTarget, progress);
    const visibleOutput = result
      ? (parsed?.display.trim() || parsed?.summary || parsed?.preview || (zh ? "没有可展示的工具返回内容。" : "No visible tool output."))
      : formatActiveToolOutput(status, progress, language);
    const summaryText = result ? parsed?.summary : activeToolSummary(status, progress, item, language);
    const previewText = result ? parsed?.preview : String(progress["tail"] ?? "");
    const summaryOnly = displayMode === "summary_only" || isLargeChange(changes) || isLargeReadFileOutput(toolName, parsed?.meta);
    return (
      <article className={`event tool_call ${result ? "tool_result" : "tool_pending"}`}>
        <div className={`${ok ? "toolResultDetails" : "toolResultDetails failed"} runningState-${status}${toolOpen ? " open" : ""}`}>
          <button
            aria-expanded={toolOpen}
            className="toolResultSummary"
            onClick={() => setToolOpen((open) => !open)}
            title={fullTarget || toolName}
            type="button"
          >
            {renderToolIcon(toolName)}
            <span>{formatToolLabel(toolName, payload, changes)}</span>
            {changes ? <LineChangeBadge added={changes.addedLines} removed={changes.removedLines} /> : null}
            <small className={`toolStatusPill ${status}`}>{formatToolStatus(status, language)}</small>
            <ChevronDown className="toolResultChevron" size={13} />
          </button>
          <div className="toolResultBodyShell">
            {toolOpen ? (
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
                <ToolProgressMeta payload={progress} language={language} />
                {renderToolSemanticNote(toolName, parsed?.meta, language)}
                {summaryText ? <TimelineText content={summaryText} language={language} live={status !== "completed"} /> : previewText ? <pre className="toolInlineOutput">{previewText}</pre> : null}
                {parsed?.citations.length ? (
                  <div className="citationList">
                    {parsed.citations.map((citation) => (
                      <span className="citationChip" key={citation.key} title={citation.source ?? citation.excerpt}>
                        {citation.title}{citation.heading ? ` · ${citation.heading}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                {parsed?.rawOutputRef ? <code className="rawRef">{parsed.rawOutputRef}</code> : null}
                {summaryOnly ? (
                  <p className="toolLargeChangeNote">{zh ? "变更较大，行内仅显示路径、状态和增删行摘要；完整调试数据保留在 trace 中。" : "Large change: inline view shows only path, status, and line counts. Full debug data remains in the trace."}</p>
                ) : (
                  <pre className="toolResultRaw">{visibleOutput.slice(0, 8000)}</pre>
                )}
                {copied ? <span className="toolCopiedHint">{zh ? "已复制" : "Copied"}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  const event = item.event;
  if (event.type === "skill_loaded") {
    const loadedSkill = parseLoadedSkillEvent(event);
    if (!loadedSkill) return null;
    return (
      <article className="event skill_loaded">
        <div className="inlineNotice">
          <span>{zh ? "Skill 已命中" : "Skill matched"}</span>
        </div>
        <div className="libraryPreviewHeader">
          <div>
            <h3><Sparkles size={15} aria-hidden="true" /> {loadedSkill.title}</h3>
            <p>{loadedSkill.matchReason}</p>
          </div>
        </div>
        <dl className="libraryMetaGrid">
          <div><dt>{zh ? "状态" : "Status"}</dt><dd>{describeSkillStatus(loadedSkill.status, language)}</dd></div>
          <div><dt>{zh ? "来源" : "Source"}</dt><dd>{describeSkillSource(loadedSkill.source, language)}</dd></div>
          <div><dt>{zh ? "Skill ID" : "Skill ID"}</dt><dd>{loadedSkill.skillId}</dd></div>
          <div><dt>{zh ? "信号" : "Signals"}</dt><dd>{loadedSkill.matchedSignals.join(", ") || (zh ? "无" : "None")}</dd></div>
          <div><dt>{zh ? "工具" : "Tools"}</dt><dd>{loadedSkill.requiredTools.join(", ") || (zh ? "无" : "None")}</dd></div>
          <div><dt>{zh ? "上下文" : "Context"}</dt><dd>{loadedSkill.requiredContext.join(", ") || (zh ? "无" : "None")}</dd></div>
        </dl>
        {loadedSkill.readOnlySuggestion ? (
          <p className="toolSemanticNote">{zh ? "这条 Skill 以只读建议形式加入当前任务，不会强制写入流程。" : "This skill was loaded as a read-only suggestion and does not force a write path."}</p>
        ) : null}
      </article>
    );
  }
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
        <TimelineText content={`${event.summary}\n\n${formatBytes(Number(event.payload["size"] ?? 0))} · ${String(event.payload["kind"] ?? "file")}`} language={language} />
        {event.payload["kind"] === "image" && typeof event.payload["attachmentId"] === "string" ? (
          <AttachmentImagePreview
            attachmentId={event.payload["attachmentId"]}
            fileName={String(event.payload["fileName"] ?? event.summary)}
            language={language ?? null}
            taskId={event.taskId}
          />
        ) : null}
      </article>
    );
  }

  if (event.type === "task_checkpoint_created") {
    return (
      <CheckpointEventCard
        event={event}
        language={language ?? null}
        onPreviewRollback={onPreviewRollback}
        onRollback={onRollback}
      />
    );
  }

  if (event.type === "task_rollback_completed" || event.type === "task_rollback_failed") {
    return (
      <article className={`event note ${event.type}`}>
        <span>{event.summary}</span>
      </article>
    );
  }

  if (
    event.type === "subagent_spawned" ||
    event.type === "subagent_status_changed" ||
    event.type === "subagent_completed" ||
    event.type === "subagent_failed"
  ) {
    const title = String(event.payload["title"] ?? event.summary);
    const statusText = String(event.payload["statusText"] ?? "").trim();
    const lastAssistantSummary = String(event.payload["lastAssistantSummary"] ?? "").trim();
    return (
      <article className={`event note ${event.type}`}>
        <strong>{title}</strong>
        <span>{event.summary}</span>
        {statusText ? <small>{statusText}</small> : null}
        {lastAssistantSummary ? <small>{lastAssistantSummary}</small> : null}
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
    const answered = event.payload["status"] === "answered";
    const optionButtonsEnabled = Boolean(onAnswerUserInput) && !answered;
    return (
      <article className="event user_input_requested">
        <small>{zh ? "需要用户确认" : "User input needed"}</small>
        <TimelineText content={event.summary} language={language} />
        {typeof event.payload["details"] === "string" ? <p className="muted">{String(event.payload["details"])}</p> : null}
        {options.length > 0 ? (
          <div className="askUserOptions">
            {options.map((option) => optionButtonsEnabled ? (
              <button
                className="askUserOptionButton"
                key={option}
                type="button"
                onClick={() => void onAnswerUserInput?.(option)}
              >
                {option}
              </button>
            ) : (
              <span key={option}>{option}</span>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  if (event.type === "user_input_answered") {
    return (
      <article className="event user_input_answered">
        <small>{zh ? "用户回答" : "User answered"}</small>
        <TimelineText content={event.summary} language={language} />
      </article>
    );
  }

  if (event.type === "model_empty_response") {
    const retrying = event.payload["status"] === "retrying";
    return (
      <article className="event note model_empty_response">
        <span>
          {retrying
            ? zh
              ? "模型本轮未返回可展示内容，正在自动重试一次。"
              : "The model returned no displayable content; retrying once."
            : zh
              ? "模型连续未返回可展示内容，任务已暂停，可重试或检查模型配置。"
              : "The model returned no displayable content twice; the task is paused for retry or provider inspection."}
        </span>
      </article>
    );
  }

  if (event.type === "model_no_progress") {
    const readOnlyToolCount = Number(event.payload["readOnlyToolCount"] ?? 0);
    const repeatedTargetCount = Number(event.payload["repeatedTargetCount"] ?? 0);
    const lastToolNames = Array.isArray(event.payload["lastToolNames"])
      ? event.payload["lastToolNames"].map(String).filter(Boolean).slice(-4)
      : [];
    const reason = String(event.payload["reason"] ?? "").trim();
    const details = [
      readOnlyToolCount > 0 ? (zh ? `只读工具 ${readOnlyToolCount} 次` : `${readOnlyToolCount} read-only calls`) : "",
      repeatedTargetCount > 0 ? (zh ? `重复目标 ${repeatedTargetCount} 次` : `${repeatedTargetCount} repeated targets`) : "",
      lastToolNames.length > 0 ? lastToolNames.join(" / ") : ""
    ].filter(Boolean).join(" · ");
    return (
      <article className="event note model_no_progress">
        <span>
          {zh
            ? `任务已暂停：连续只读探索没有获得新信息${reason ? `（${reason}）` : ""}${details ? `。${details}` : ""}`
            : `Task paused: repeated read-only exploration stopped making progress${reason ? ` (${reason})` : ""}${details ? `. ${details}` : ""}`}
        </span>
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
    const summaryOnly = parsed.displayMode === "summary_only" || isLargeChange(parsed.changes) || isLargeReadFileOutput(toolName, parsed.meta);
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
            <span>{formatToolLabel(toolName, event.payload, parsed.changes)}</span>
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
              {renderToolSemanticNote(toolName, parsed.meta, language)}
              {parsed.summary ? <TimelineText content={parsed.summary} language={language} /> : parsed.preview ? <pre className="toolInlineOutput">{parsed.preview}</pre> : null}
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
              {summaryOnly ? (
                <p className="toolLargeChangeNote">{zh ? "输出较大，行内仅显示摘要和路径；完整调试数据保留在 trace 中。" : "Large output: inline view shows the summary and path only. Full debug data remains in the trace."}</p>
              ) : (
                <pre className="toolResultRaw">{visibleOutput.slice(0, 8000)}</pre>
              )}
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
      <TimelineText content={formatVisibleEventSummary(event, language)} language={language} />
    </article>
  );
}

function CheckpointEventCard({
  event,
  language,
  onPreviewRollback,
  onRollback
}: {
  event: TaskEvent;
  language?: string | null;
  onPreviewRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackPreview>) | undefined;
  onRollback?: ((input?: TaskRollbackRequest) => Promise<TaskRollbackResult>) | undefined;
}) {
  const zh = language === "zh-CN";
  const checkpointId = String(event.payload["checkpointId"] ?? "").trim();
  const [preview, setPreview] = useState<TaskRollbackPreview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<TaskRollbackResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSelectableFiles = selectedFiles.size > 0;

  async function inspectRollbackPoint() {
    if (!checkpointId || !onPreviewRollback) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const nextPreview = await onPreviewRollback({ checkpointId });
      setPreview(nextPreview);
      setSelectedFiles(new Set(nextPreview.files.filter((file) => file.canRollback).map((file) => file.path)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rollbackSelectedFiles() {
    if (!checkpointId || !onRollback || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const nextResult = await onRollback({ checkpointId: preview.checkpointId, filePaths: [...selectedFiles] });
      setResult(nextResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="event note task_checkpoint_created checkpointRollbackEvent">
      <div className="checkpointRollbackHeader">
        <span>{event.summary}</span>
        {checkpointId && onPreviewRollback ? (
          <button disabled={busy} type="button" onClick={() => void inspectRollbackPoint()}>
            <Eye size={13} />
            {busy ? (zh ? "检查中..." : "Inspecting...") : preview ? (zh ? "刷新回滚点" : "Refresh point") : (zh ? "检查回滚点" : "Inspect rollback point")}
          </button>
        ) : null}
      </div>
      {preview ? (
        <div className="rollbackInlinePreview checkpointRollbackPreview">
          <div className="rollbackSummary">
            <span>{zh ? "可恢复" : "Restorable"}: {preview.restorableFiles}</span>
            <span>{zh ? "新增文件" : "New files"}: {preview.deletableFiles}</span>
            <span>{zh ? "跳过" : "Skipped"}: {preview.skippedFiles}</span>
          </div>
          {preview.files.length > 0 ? (
            <div className="rollbackFileList inline">
              {preview.files.map((file) => (
                <label className={file.canRollback ? "rollbackFileRow" : "rollbackFileRow disabled"} key={file.path}>
                  <input
                    checked={selectedFiles.has(file.path)}
                    disabled={!file.canRollback}
                    type="checkbox"
                    onChange={() => {
                      const next = new Set(selectedFiles);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      setSelectedFiles(next);
                    }}
                  />
                  <span>
                    <strong>{file.relativePath}</strong>
                    <small>{rollbackFileStatusText(file.status, language)}{file.reason ? ` · ${file.reason}` : ""}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">{zh ? "这个回滚点没有可检查的文件。" : "This rollback point has no files to inspect."}</p>
          )}
          {error ? <p className="formError">{error}</p> : null}
          {result ? (
            <div className="rollbackResult">
              {zh ? "文件回滚完成" : "File rollback complete"}: {result.restoredFiles} restored, {result.deletedFiles} deleted, {result.skippedFiles} skipped.
            </div>
          ) : null}
          {onRollback ? (
            <button className="primaryInlineButton rollbackRunButton" disabled={busy || !hasSelectableFiles} type="button" onClick={() => void rollbackSelectedFiles()}>
              {busy ? (zh ? "回滚中..." : "Rolling back...") : (zh ? "仅回滚所选文件" : "Rollback selected files")}
            </button>
          ) : null}
        </div>
      ) : error ? (
        <p className="formError">{error}</p>
      ) : null}
    </article>
  );
}

function rollbackFileStatusText(status: string, language?: string | null): string {
  const zh = language === "zh-CN";
  switch (status) {
    case "modified":
      return zh ? "已修改" : "Modified";
    case "created":
      return zh ? "新增文件" : "Created";
    case "deleted":
      return zh ? "已删除" : "Deleted";
    case "unchanged":
      return zh ? "无变化" : "Unchanged";
    case "skipped":
      return zh ? "跳过" : "Skipped";
    default:
      return status;
  }
}

function RunningStatus({ language }: { language?: string | null | undefined }) {
  const label = language === "zh-CN" ? "思考中..." : "Thinking...";
  return (
    <article className="event running_status" aria-live="polite" aria-label={label}>
      <span className="runningStatusGlow" aria-hidden="true" />
      <span className="thinkingDots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="runningStatusLabel">{label}</span>
    </article>
  );
}

function TimelineText({
  content,
  language,
  live = false,
  smooth = false
}: {
  content: string;
  language?: string | null | undefined;
  live?: boolean | undefined;
  smooth?: boolean | undefined;
}) {
  const [visibleChars, setVisibleChars] = useState(LONG_TEXT_PAGE_CHARS);
  const zh = language === "zh-CN";
  const visibleContent = useSmoothLiveText(content, live && smooth);
  if (live) {
    const livePreview = liveTextPreview(visibleContent, zh);
    return (
      <div className={`timelineLongText live${smooth ? " smooth" : ""}`}>
        <pre className="timelineLongTextBody live">
          {livePreview}
        </pre>
      </div>
    );
  }
  if (content.length <= LONG_MARKDOWN_INLINE_CHARS) return <MarkdownText content={content} />;
  const visibleText = content.slice(0, visibleChars);
  const remaining = Math.max(0, content.length - visibleChars);
  return (
    <div className="timelineLongText">
      <pre className="timelineLongTextBody">
        {visibleText}
        {remaining > 0
          ? `\n\n[${zh ? `长内容预览：还有 ${remaining} 个字符未渲染。` : `Long content preview: ${remaining} more characters are not rendered.`}]`
          : ""}
      </pre>
      {remaining > 0 ? (
        <button
          className="timelineLongTextMore"
          type="button"
          onClick={() => setVisibleChars((current) => Math.min(content.length, current + LONG_TEXT_PAGE_CHARS))}
        >
          {zh ? "继续显示更多" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function useSmoothLiveText(content: string, enabled: boolean): string {
  const [visible, setVisible] = useState(content);
  const visibleRef = useRef(content);

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      visibleRef.current = content;
      setVisible(content);
      return;
    }
    if (!content.startsWith(visibleRef.current) || visibleRef.current.length > content.length) {
      visibleRef.current = content;
      setVisible(content);
      return;
    }
    if (visibleRef.current === content) return;

    let cancelled = false;
    let timer: number | null = null;
    const tick = () => {
      if (cancelled) return;
      let current = visibleRef.current;
      if (!content.startsWith(current) || current.length > content.length) {
        visibleRef.current = content;
        setVisible(content);
        return;
      }
      const lag = content.length - current.length;
      if (lag <= 0) return;
      if (lag > LIVE_STREAM_SMOOTH_MAX_LAG_CHARS) {
        current = content.slice(0, Math.max(0, content.length - LIVE_STREAM_SMOOTH_MAX_LAG_CHARS));
      }
      const next = current + nextSmoothLiveTextChunk(content.slice(current.length));
      visibleRef.current = next;
      setVisible(next);
      if (next.length < content.length) timer = window.setTimeout(tick, LIVE_STREAM_SMOOTH_FRAME_MS);
    };

    timer = window.setTimeout(tick, 12);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [content, enabled]);

  return enabled ? visible : content;
}

function nextSmoothLiveTextChunk(remaining: string): string {
  if (remaining.length <= LIVE_STREAM_SMOOTH_MAX_CHARS) return remaining;
  const minIndex = Math.min(LIVE_STREAM_SMOOTH_MIN_CHARS, remaining.length);
  const maxIndex = Math.min(LIVE_STREAM_SMOOTH_MAX_CHARS, remaining.length);
  for (let index = minIndex; index < maxIndex; index += 1) {
    const char = remaining[index];
    if (char && LIVE_STREAM_BOUNDARY_CHARS.includes(char)) return remaining.slice(0, index + 1);
  }
  return remaining.slice(0, maxIndex);
}

function liveTextPreview(content: string, zh: boolean): string {
  if (content.length <= LIVE_TEXT_PREVIEW_CHARS) return content;
  const omitted = Math.max(0, content.length - LIVE_TEXT_HEAD_CHARS - LIVE_TEXT_TAIL_CHARS);
  return [
    content.slice(0, LIVE_TEXT_HEAD_CHARS),
    `[${zh ? `实时预览：中间 ${omitted} 个字符未渲染，完整内容仍在任务记录中。` : `Live preview: ${omitted} middle characters are not rendered. Full content remains in the task record.`}]`,
    content.slice(-LIVE_TEXT_TAIL_CHARS)
  ].join("\n\n");
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
  const summary =
    event.type === "assistant_message" || event.type === "assistant_delta"
      ? visibleAssistantText(event)
      : stripPlaceholderToolEvidence(event.summary).trim();
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

function visibleAssistantText(event: TaskEvent): string {
  const summary = stripAssistantToolEvidence(event.summary).trim();
  if (summary || (event.type !== "assistant_message" && event.type !== "assistant_delta")) return summary;
  for (const key of ["message", "text", "delta"]) {
    const value = event.payload[key];
    if (typeof value !== "string") continue;
    const visible = stripAssistantToolEvidence(value).trim();
    if (visible) return visible;
  }
  return "";
}

function stripPlaceholderToolEvidence(value: string): string {
  return value.split(/\r?\n/)
    .filter((line) => !isPlaceholderToolSummary(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripAssistantToolEvidence(value: string): string {
  return stripPlaceholderToolEvidence(stripInlineToolMarkup(value));
}

function isInlineToolMarkupEvent(event: TaskEvent | null | undefined): boolean {
  if (!event) return false;
  if (event.type !== "assistant_message" && event.type !== "assistant_delta") return false;
  const raw = formatRawEventText(event);
  return containsInlineToolMarkup(raw) && !stripAssistantToolEvidence(raw);
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

function stripInlineToolMarkup(value: string): string {
  return value
    .replace(/<function_calls\b[\s\S]*?<\/function_calls>/gi, "\n")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "\n");
}

function compactInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateThinkingPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= THINKING_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, THINKING_PREVIEW_CHARS)}…`;
}

function normalizeThinkingDisplayText(value: string): string {
  if (!needsThinkingTextNormalization(value)) return value;
  return value
    .replace(/([A-Za-z0-9])\s+(-)\s*([A-Za-z0-9])/g, "$1$2$3")
    .replace(/([A-Za-z0-9])\s*-\s+([A-Za-z0-9])/g, "$1-$2")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "$1$2")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+([，。！？；：、“”‘’（）《》〈〉【】])/gu, "$1$2")
    .replace(/([，。！？；：、“”‘’（）《》〈〉【】])\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "$1$2")
    .replace(/([“‘（《〈【])\s+/gu, "$1")
    .replace(/\s+([”’）》〉】])/gu, "$1");
}

function needsThinkingTextNormalization(value: string): boolean {
  return /(?:[A-Za-z0-9]\s+-\s*[A-Za-z0-9])|(?:[A-Za-z0-9]\s*-\s+[A-Za-z0-9])|(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、“”‘’（）《》〈〉【】])|(?:[“‘（《〈【]\s+)|(?:\s+[”’）》〉】])/u.test(value);
}

function truncateThinkingBodyForDisplay(value: string, zh: boolean): string {
  if (value.length <= THINKING_BODY_PREVIEW_CHARS) return value;
  const omitted = value.length - THINKING_BODY_PREVIEW_CHARS;
  const note = zh
    ? `\n\n[思考内容较长，已先显示前 ${THINKING_BODY_PREVIEW_CHARS} 个字符；还有 ${omitted} 个字符未渲染，可使用复制获取完整内容。]`
    : `\n\n[Long thinking preview: showing the first ${THINKING_BODY_PREVIEW_CHARS} characters; ${omitted} more characters are not rendered. Use copy for the full text.]`;
  return `${value.slice(0, THINKING_BODY_PREVIEW_CHARS)}${note}`;
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
  const finalFallbacks = buildAssistantFinalFallbacks(events);
  const items: TimelineItem[] = [];
  const streamItems = new Map<string, Extract<TimelineItem, { kind: "stream" }>>();
  const toolItems = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  for (const event of events) {
    if (event.type === "assistant_delta" || event.type === "thinking_delta") {
      const streamId = String(event.payload["streamId"] ?? event.id);
      if (event.type === "assistant_delta" && finalStreamIds.has(streamId)) continue;
      const key = `${event.type}:${streamId}`;
      let stream = streamItems.get(key);
      if (!stream) {
        stream = { key, kind: "stream", type: event.type, streamId, summary: "", payload: { ...event.payload } };
        streamItems.set(key, stream);
        items.push(stream);
      } else {
        stream.payload = {
          ...stream.payload,
          ...event.payload
        };
      }
      stream.summary = appendStreamDelta(stream.summary, String(event.payload["delta"] ?? event.summary));
      continue;
    }
    if (isToolTimelineEvent(event)) {
      const toolCallId = String(event.payload["toolCallId"] ?? event.payload["id"] ?? event.id);
      let tool = toolItems.get(toolCallId);
      if (!tool) {
        tool = { key: `tool:${toolCallId}`, kind: "tool", toolCallId, events: [] };
        toolItems.set(toolCallId, tool);
        items.push(tool);
      }
      tool.events.push(event);
      continue;
    }
    const normalized = applyAssistantFinalFallback(event, finalFallbacks);
    if (normalized.type === "assistant_message" && !visibleAssistantText(normalized)) continue;
    items.push({ key: normalized.id, kind: "event", event: normalized });
  }
  return items.filter((item) => {
    if (item.kind !== "stream") return true;
    const summary = item.summary.trim();
    return summary.length > 0 && !containsInlineToolMarkup(summary);
  });
}

function isToolTimelineEvent(event: TaskEvent): event is ToolTimelineEvent {
  return event.type === "tool_requested" || event.type === "tool_started" || event.type === "tool_progress" || event.type === "tool_result";
}

function buildAssistantFinalFallbacks(events: TaskEvent[]): Map<string, string> {
  const fallbacks = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "assistant_delta") continue;
    const streamId = String(event.payload["streamId"] ?? "");
    if (!streamId) continue;
    const delta = String(event.payload["delta"] ?? event.summary ?? "");
    if (!stripAssistantToolEvidence(delta)) continue;
    fallbacks.set(streamId, appendStreamDelta(fallbacks.get(streamId) ?? "", delta));
  }
  return fallbacks;
}

function applyAssistantFinalFallback(event: TaskEvent, fallbacks: Map<string, string>): TaskEvent {
  if (event.type !== "assistant_message") return event;
  const visible = visibleAssistantText(event);
  if (visible) return visible === event.summary ? event : { ...event, summary: visible };
  const streamId = String(event.payload["streamId"] ?? "");
  const fallback = streamId ? fallbacks.get(streamId)?.trim() : "";
  if (!fallback) return event;
  return {
    ...event,
    summary: fallback,
    payload: {
      ...event.payload,
      streamFinalFallback: true
    }
  };
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

function AttachmentImagePreview({
  attachmentId,
  fileName,
  language,
  taskId
}: {
  attachmentId: string;
  fileName: string;
  language?: string | null;
  taskId: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zh = language === "zh-CN";

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setObjectUrl(null);
    setError(null);
    void api.getTaskAttachmentContent(taskId, attachmentId)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachmentId, taskId]);

  if (error) {
    return <p className="attachmentPreviewState">{zh ? "图片预览加载失败" : "Image preview failed"}</p>;
  }
  if (!objectUrl) {
    return <p className="attachmentPreviewState">{zh ? "正在加载图片预览..." : "Loading image preview..."}</p>;
  }
  return (
    <figure className="attachmentImagePreview">
      <img alt={zh ? `附件图片预览：${fileName}` : `Attachment image preview: ${fileName}`} src={objectUrl} />
      <figcaption>{fileName}</figcaption>
    </figure>
  );
}

function isPreservedTimelineAnchor(item: TimelineItem): boolean {
  if (item.kind !== "event") return false;
  return (
    item.event.type === "user_message" ||
    item.event.type === "attachment_added"
  );
}

function itemTimestamp(item: TimelineItem): string {
  if (item.kind === "event") return item.event.createdAt;
  if (item.kind === "tool") return item.events[0]?.createdAt ?? item.key;
  return item.key;
}

function appendStreamDelta(current: string, delta: string): string {
  if (!current) return current + delta;
  return `${current}${streamDeltaSeparator(current, delta)}${delta}`;
}

function streamDeltaSeparator(current: string, delta: string): string {
  if (!delta || /^\s/.test(delta) || /\s$/.test(current)) return "";
  const previous = current.at(-1) ?? "";
  const next = delta[0] ?? "";
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(previous + next)) return "";
  if (/[A-Za-z0-9)]/.test(previous) && /[A-Za-z0-9(]/.test(next)) return " ";
  if (/[.,;:!?]/.test(previous) && /[A-Za-z0-9]/.test(next)) return " ";
  return "";
}

function formatToolLabel(toolName: string, payload: Record<string, unknown>, changes?: { path: string; addedLines: number; removedLines: number; operation?: string } | undefined): string {
  if (changes?.path) return compactToolTarget(changes.path);
  const direct = firstStringArg(payload, ["targetPath", "path", "file", "cwd", "query", "command", "url"]);
  if (direct) return compactToolTarget(direct);
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

function parseToolOutput(output: string): {
  summary: string;
  preview: string;
  display: string;
  rawOutputRef?: string;
  displayMode?: string;
  citations: Array<{ key: string; title: string; heading?: string; source?: string; excerpt: string }>;
  changes?: { path: string; addedLines: number; removedLines: number; operation?: string };
  meta?: Record<string, unknown>;
} {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const rawSummary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    const summary = isPlaceholderToolSummary(rawSummary) ? "" : rawSummary;
    const rawOutputRef = typeof parsed["rawOutputRef"] === "string" ? parsed["rawOutputRef"] : undefined;
    const citations = extractCitations(parsed);
    const compact = stringifyToolDisplay(parsed, summary);
    const changes = extractLineChanges(parsed);
    const displayMode = typeof parsed["displayMode"] === "string" ? parsed["displayMode"] : undefined;
    return {
      summary: summary ? firstUsefulLine(summary) : "",
      preview: summary ? "" : firstUsefulToolPreview(parsed),
      display: compact,
      citations,
      meta: parsed,
      ...(changes ? { changes } : {}),
      ...(displayMode ? { displayMode } : {}),
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

function fullToolTarget(payload: Record<string, unknown>, parsed: ReturnType<typeof parseToolOutput>, progress?: Record<string, unknown>): string {
  if (parsed.changes?.path) return parsed.changes.path;
  const progressPath = progress ? firstStringArg(progress, ["targetPath", "path", "file", "cwd", "url"]) : "";
  if (progressPath) return progressPath;
  const direct = firstStringArg(payload, ["targetPath", "path", "file", "cwd", "url"]);
  if (direct) return direct;
  const args = payload["args"] && typeof payload["args"] === "object" ? (payload["args"] as Record<string, unknown>) : {};
  return firstStringArg(args, ["path", "file", "targetPath", "cwd", "url"]);
}

function emptyParsedToolOutput(): ReturnType<typeof parseToolOutput> {
  return { summary: "", preview: "", display: "", citations: [] };
}

function toolResultEvent(item: Extract<TimelineItem, { kind: "tool" }>): ToolTimelineEvent | undefined {
  return [...item.events].reverse().find((event) => event.type === "tool_result");
}

function toolPrimaryPayload(item: Extract<TimelineItem, { kind: "tool" }>): Record<string, unknown> {
  return (item.events.find((event) => event.type === "tool_started") ?? item.events.find((event) => event.type === "tool_requested") ?? toolResultEvent(item) ?? item.events[0])?.payload ?? {};
}

function toolLatestPayload(item: Extract<TimelineItem, { kind: "tool" }>): Record<string, unknown> {
  return item.events[item.events.length - 1]?.payload ?? {};
}

function toolLatestProgressPayload(item: Extract<TimelineItem, { kind: "tool" }>): Record<string, unknown> {
  return [...item.events].reverse().find((event) => event.type === "tool_progress")?.payload ?? toolLatestPayload(item);
}

function toolNameForItem(item: Extract<TimelineItem, { kind: "tool" }>): string {
  return String(toolPrimaryPayload(item)["toolName"] ?? toolLatestPayload(item)["toolName"] ?? "tool");
}

function toolStatusForItem(item: Extract<TimelineItem, { kind: "tool" }>): "queued" | "running" | "completed" | "failed" {
  const result = toolResultEvent(item);
  if (result) return result.payload["ok"] === true ? "completed" : "failed";
  const status = String(toolLatestProgressPayload(item)["status"] ?? "");
  if (status === "completed" || status === "failed") return status;
  return item.events.some((event) => event.type === "tool_started" || event.type === "tool_progress") ? "running" : "queued";
}

function eventSummaryForTool(item: Extract<TimelineItem, { kind: "tool" }>): string {
  return [...item.events].reverse().map((event) => event.summary).find(Boolean) ?? "";
}

function extractPayloadChanges(payload: Record<string, unknown>): { path: string; addedLines: number; removedLines: number; operation?: string } | undefined {
  return extractLineChanges(payload);
}

function parseToolOutputHeader(output: string): { changes?: { path: string; addedLines: number; removedLines: number; operation?: string }; displayMode?: string } | null {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const changes = extractLineChanges(parsed);
    const displayMode = typeof parsed["displayMode"] === "string" ? parsed["displayMode"] : undefined;
    return {
      ...(changes ? { changes } : {}),
      ...(displayMode ? { displayMode } : {})
    };
  } catch {
    return null;
  }
}

function isLargeChange(changes?: { addedLines: number; removedLines: number } | undefined): boolean {
  if (!changes) return false;
  return changes.addedLines + changes.removedLines > 160;
}

function isLargeReadFileOutput(toolName: string, meta: Record<string, unknown> | undefined): boolean {
  if (toolName !== "read_file" || !meta) return false;
  const mode = String(meta["mode"] ?? "");
  if (mode === "range") return false;
  if (meta["partial"] === true) return true;
  const totalLines = Number(meta["totalLines"] ?? NaN);
  if (Number.isFinite(totalLines) && totalLines > LARGE_READ_FILE_SUMMARY_LINES) return true;
  const sizeBytes = Number(meta["sizeBytes"] ?? NaN);
  if (Number.isFinite(sizeBytes) && sizeBytes > LARGE_READ_FILE_SUMMARY_BYTES) return true;
  const content = typeof meta["content"] === "string" ? meta["content"] : "";
  return content.length > LARGE_READ_FILE_SUMMARY_CHARS;
}

function formatToolStatus(status: "queued" | "running" | "completed" | "failed", language?: string | null | undefined): string {
  const zh = language === "zh-CN";
  if (status === "queued") return zh ? "待执行" : "Requested";
  if (status === "running") return zh ? "运行中" : "Running";
  if (status === "failed") return zh ? "失败" : "Failed";
  return zh ? "完成" : "Done";
}

function formatActiveToolOutput(status: "queued" | "running" | "completed" | "failed", payload: Record<string, unknown>, language?: string | null | undefined): string {
  const zh = language === "zh-CN";
  const message = typeof payload["message"] === "string" ? payload["message"] : "";
  const tail = typeof payload["tail"] === "string" ? payload["tail"] : "";
  const fallback = status === "queued"
    ? (zh ? "工具已请求，正在等待执行、审批或调度。" : "Tool requested; waiting for execution, approval, or scheduling.")
    : (zh ? "工具正在运行。" : "Tool is running.");
  return [message || fallback, tail].filter(Boolean).join("\n\n");
}

function activeToolSummary(
  status: "queued" | "running" | "completed" | "failed",
  payload: Record<string, unknown>,
  item: Extract<TimelineItem, { kind: "tool" }>,
  language?: string | null | undefined
): string {
  const explicit = String(payload["message"] ?? "").trim();
  if (explicit) return explicit;
  const summary = eventSummaryForTool(item);
  if (summary && !/^tool_?requested$|^tool_?started$|^tool_?progress$/i.test(summary.trim())) return summary;
  const zh = language === "zh-CN";
  if (status === "queued") return zh ? "工具请求已进入队列。" : "Tool request is queued.";
  return zh ? "工具正在运行，结果会实时追加。" : "Tool is running; progress will update live.";
}

function ToolProgressMeta({ payload, language }: { payload: Record<string, unknown>; language?: string | null | undefined }) {
  const progress = payload["progress"] && typeof payload["progress"] === "object" ? payload["progress"] as Record<string, unknown> : null;
  if (!progress) return null;
  const processed = Number(progress["processed"] ?? NaN);
  const total = Number(progress["total"] ?? NaN);
  const unit = String(progress["unit"] ?? "");
  const zh = language === "zh-CN";
  if (!Number.isFinite(processed) && !Number.isFinite(total)) return null;
  const text = Number.isFinite(total) && total > 0
    ? `${Math.max(0, processed || 0)} / ${Math.max(0, total)} ${unit}`
    : `${Math.max(0, processed || 0)} ${unit}`;
  return <small className="toolProgressMeta">{zh ? "进度" : "Progress"}: {text}</small>;
}

function renderToolSemanticNote(toolName: string, meta: Record<string, unknown> | undefined, language?: string | null | undefined) {
  const zh = language === "zh-CN";
  if (toolName === "search_files") {
    return (
      <p className="toolSemanticNote">
        {zh
          ? "search_files 只返回工作区匹配路径、行号和片段，不返回完整文件正文；需要全文时继续调用 read_file。"
          : "search_files returns live workspace paths, line numbers, and snippets only. Use read_file for full file content."}
      </p>
    );
  }
  if (toolName === "knowledge_search") {
    return (
      <p className="toolSemanticNote">
        {zh
          ? "knowledge_search 搜索资料库中的已保存知识，不代表当前工作区文件现状；需要核对源码时继续使用 search_files 或 read_file。"
          : "knowledge_search queries saved library knowledge, not live workspace files. Use search_files or read_file to verify current source."}
      </p>
    );
  }
  if (toolName === "read_file") {
    const mode = String(meta?.["mode"] ?? "");
    const partial = meta?.["partial"] === true;
    const large = isLargeReadFileOutput(toolName, meta);
    const note =
      mode === "full" && !partial && !large
        ? zh
          ? "本次返回的是完整文件内容。"
          : "This read returned the full file content."
        : mode === "range"
          ? zh
            ? "本次只返回指定范围的文件内容；如需其他位置，请继续按范围读取。"
            : "This read returned only the requested range. Read another range if you need different lines."
          : zh
            ? "本次是大文件预览或预算受限读取；如需精确位置，请继续按范围读取。"
            : "This read is a large-file preview or a budget-limited read. Request another range for exact lines.";
    return <p className="toolSemanticNote">{note}</p>;
  }
  return null;
}

function isPlaceholderToolSummary(value: string): boolean {
  return /^(tool evidence returned\.?|tool evidence returned[:：].*|工具证据已返回。?|工具证据已返回[:：].*)$/i.test(value.trim());
}

function stringifyToolDisplay(parsed: Record<string, unknown>, summary: string): string {
  if (summary) return summary;
  const { summary: _unusedSummary, ...rest } = parsed;
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
