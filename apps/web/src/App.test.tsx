// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalPermissionGrant, IntegrationProviderConfig, KnowledgeItem, MemoryDocument, MemoryDocumentCompactResult, ModelProviderRecord, ProjectMemory, RiskCategory, ScheduledTask, SkillRecord, TaskDetail, TaskEvent, TaskFolderRecord, ToolApproval, UserPreferences, WebSearchProviderConfig } from "@scc/shared";
import { App } from "./App.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
import { CompactList, LearningPanel } from "./components/LearningPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { IntegrationsPanel } from "./components/IntegrationsPanel.js";
import { ModelProvidersPanel } from "./components/ModelProvidersPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { ProjectMemoryPanel } from "./components/ProjectMemoryPanel.js";
import { SkillPanel } from "./components/SkillPanel.js";
import { ScheduledTasksPanel } from "./components/ScheduledTasksPanel.js";
import { TaskList } from "./components/TaskList.js";
import { TaskThread } from "./components/TaskThread.js";
import { Timeline } from "./components/Timeline.js";
import { WebSearchPanel } from "./components/WebSearchPanel.js";
import { coalesceRealtimeEvents, parseRealtimeMessage } from "./useWorkbenchData.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("uses one primary adaptive button for send and stop", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Composer busy={false} running={true} mode="guidance" onSubmit={onSubmit} onStop={onStop} />);

    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "new guidance" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSubmit).toHaveBeenCalledWith("new guidance");
  });

  it("keeps the running primary action as stop instead of a loader", () => {
    const { container } = render(<Composer busy={true} running={true} mode="guidance" onSubmit={vi.fn()} onStop={vi.fn()} />);

    expect(screen.getByLabelText("Stop")).toBeDisabled();
    expect(container.querySelector(".composerPrimaryButton .spin")).toBeNull();
  });

  it("lets users switch models and quick global permissions from the composer", () => {
    const onModelChange = vi.fn();
    const onFolderChange = vi.fn();
    const onGrant = vi.fn();
    render(
      <Composer
        busy={false}
        running={false}
        mode="new_task"
        folderValue="default"
        folderOptions={[
          { label: "Default", value: "default", description: process.cwd() },
          { label: "Project A", value: "folder_a", description: "D:\\ProjectA" }
        ]}
        modelValue="mimo-v2.5"
        modelOptions={[
          { label: "Mimo v2.5", value: "mimo-v2.5" },
          { label: "Mimo v2.5 Pro", value: "mimo-v2.5-pro" }
        ]}
        permissionPreset="ask"
        permissionScopeLabel="Ask"
        onFolderChange={onFolderChange}
        onModelChange={onModelChange}
        onPermissionPresetChange={onGrant}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Choose work folder"));
    fireEvent.click(screen.getByText("Project A"));
    expect(onFolderChange).toHaveBeenCalledWith("folder_a");
    fireEvent.click(screen.getByLabelText("Choose model"));
    expect(screen.queryByText("mimo-v2.5-pro")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Mimo v2.5 Pro"));
    expect(onModelChange).toHaveBeenCalledWith("mimo-v2.5-pro");
    fireEvent.click(screen.getByLabelText("Choose permission scope"));
    fireEvent.click(screen.getByText("Read only"));
    expect(onGrant).toHaveBeenCalledWith("read_only");
    fireEvent.click(screen.getByLabelText("Choose permission scope"));
    fireEvent.click(screen.getByText("All"));
    expect(onGrant).toHaveBeenCalledWith("all");
  });

  it("uses Enter to submit and Shift+Enter for a newline", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Composer busy={false} running={false} mode="new_task" onSubmit={onSubmit} onStop={onStop} />);
    const input = screen.getByLabelText("Task input");

    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("line one");
  });

  it("does not expose stop semantics when the task is not running", () => {
    render(<Composer busy={false} running={false} mode="new_task" onSubmit={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByLabelText("Idle")).toBeDisabled();
  });
});

describe("Workbench components", () => {
  const task: TaskDetail = {
    id: "task_1",
    title: "Check host",
    folderId: "default",
    workRoot: process.cwd(),
    status: "waiting_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: [],
    pendingGuidance: [],
    events: [
      {
        id: "event_1",
        taskId: "task_1",
        type: "user_message",
        createdAt: new Date().toISOString(),
        summary: "check processes",
        payload: {}
      },
      {
        id: "event_2",
        taskId: "task_1",
        type: "tool_result",
        createdAt: new Date().toISOString(),
        summary: "Tool completed",
        payload: { output: "node 100" }
      }
    ]
  };

  it("renders task list status as text", () => {
    const onSelect = vi.fn();
    const onOpenLibrary = vi.fn();
    render(
      <TaskList
        activeView="tasks"
        engineStatus="running"
        open={false}
        tasks={[task]}
        folders={[]}
        selectedId="task_1"
        activeFolderId="default"
        onClose={vi.fn()}
        onCreateFolder={vi.fn()}
        onDelete={vi.fn()}
        onDeleteFolder={vi.fn()}
        onFolderSelect={vi.fn()}
        onOpenDocs={vi.fn()}
        onOpenLibrary={onOpenLibrary}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={onSelect}
        onUpdateTask={vi.fn()}
        onUpdateFolder={vi.fn()}
      />
    );
    expect(screen.getByText("waiting approval")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Check host"));
    expect(onSelect).toHaveBeenCalledWith("task_1");
    fireEvent.click(screen.getByText("Library"));
    expect(onOpenLibrary).toHaveBeenCalledOnce();
  });

  it("renders the new task hero and composer", () => {
    const onSubmit = vi.fn();
    render(
      <TaskThread
        task={null}
        busy={false}
        error={null}
        language="en-US"
        engineStatus="running"
        preferences={null}
        attachments={[]}
        attachmentBusy={false}
        attachmentError={null}
        modelLabel="mimo-v2.5"
        modelOptions={[{ label: "Mimo v2.5", value: "mimo-v2.5" }]}
        permissionPreset="ask"
        permissionScopeLabel="Approval"
        onModelChange={vi.fn()}
        onFilesSelected={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onOpenConnect={vi.fn()}
        onOpenPermissionSettings={vi.fn()}
        onOpenCustomPermissions={vi.fn()}
        onRestoreCustomPermissions={vi.fn()}
        hasCustomSnapshot={false}
        onPermissionPresetChange={vi.fn()}
        onOpenTasks={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
        onRetryTitle={vi.fn()}
        onUseLocalTitle={vi.fn()}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task input")).toHaveValue("");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("confirms task deletion and exposes learning cleanup choices", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskList
        activeView="tasks"
        engineStatus="running"
        open={false}
        tasks={[task]}
        folders={[]}
        selectedId="task_1"
        activeFolderId="default"
        onClose={vi.fn()}
        onCreateFolder={vi.fn()}
        onDelete={onDelete}
        onDeleteFolder={vi.fn()}
        onFolderSelect={vi.fn()}
        onOpenDocs={vi.fn()}
        onOpenLibrary={vi.fn()}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={vi.fn()}
        onUpdateTask={vi.fn()}
        onUpdateFolder={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Delete task Check host"));
    expect(screen.getByText("Delete task?")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove memories and experiences from this task"));
    fireEvent.click(screen.getByLabelText("Delete skills derived only from this task"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("task_1", { deleteLearningData: true, deleteDerivedSkills: true }));
  });

  it("filters tasks by folder and edits/deletes folders and tasks from the sidebar", async () => {
    const folder: TaskFolderRecord = {
      id: "folder_ops",
      name: "Operations",
      rootPath: process.cwd(),
      isDefault: false,
      exists: true,
      sortOrder: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const onFolderSelect = vi.fn();
    const onDeleteFolder = vi.fn().mockResolvedValue(undefined);
    const onCreateFolder = vi.fn().mockResolvedValue(undefined);
    const onUpdateFolder = vi.fn().mockResolvedValue(undefined);
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    const onSelect = vi.fn();
    render(
      <TaskList
        activeView="tasks"
        engineStatus="running"
        open={false}
        tasks={[
          { ...task, id: "task_ops", title: "Ops check", folderId: "folder_ops" },
          { ...task, id: "task_default", title: "Default check", folderId: "default" }
        ]}
        folders={[folder]}
        selectedId={null}
        activeFolderId="folder_ops"
        onClose={vi.fn()}
        onCreateFolder={onCreateFolder}
        onDelete={vi.fn()}
        onDeleteFolder={onDeleteFolder}
        onFolderSelect={onFolderSelect}
        onOpenDocs={vi.fn()}
        onOpenLibrary={vi.fn()}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={onSelect}
        onUpdateTask={onUpdateTask}
        onUpdateFolder={onUpdateFolder}
      />
    );

    expect(screen.getByText("Task folders")).toBeInTheDocument();
    expect(screen.getByText("Ops check")).toBeInTheDocument();
    expect(screen.queryByText("Default check")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Default"));
    expect(onFolderSelect).toHaveBeenCalledWith("default");
    onFolderSelect.mockClear();

    fireEvent.click(screen.getByLabelText("New folder"));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("Local path"), { target: { value: process.cwd() } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "New folder" })).getByRole("button", { name: "New folder" }));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith("Research", process.cwd()));

    fireEvent.click(screen.getByLabelText("Edit folder Operations"));
    expect(onFolderSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Ops" } });
    fireEvent.change(screen.getByLabelText("Local path"), { target: { value: process.cwd() } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit folder" })).getByRole("button", { name: "Edit folder" }));
    await waitFor(() => expect(onUpdateFolder).toHaveBeenCalledWith("folder_ops", "Ops", process.cwd()));

    fireEvent.click(screen.getByText("Operations"));
    onFolderSelect.mockClear();
    fireEvent.click(screen.getByLabelText("Edit task Ops check"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Ops renamed" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit task" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith("task_ops", { title: "Ops renamed", folderId: "folder_ops" }));

    fireEvent.click(screen.getByLabelText("Delete folder Operations"));
    expect(onFolderSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this task folder?")).toBeInTheDocument();
    expect(screen.getByText(/will be removed from SCC/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove memories and experiences from this task"));
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(onDeleteFolder).toHaveBeenCalledWith("folder_ops", { deleteLearningData: true, deleteDerivedSkills: false }));
  });

  it("renders user-facing timeline evidence", () => {
    render(<Timeline task={task} onApprovalDecision={vi.fn()} />);
    expect(screen.getByText("check processes")).toBeInTheDocument();
    expect(screen.getByText(".../tool")).toBeInTheDocument();
    expect(screen.queryByText("View raw output")).not.toBeInTheDocument();
  });

  it("windows very large timelines so old events do not overload the DOM", () => {
    const events = Array.from({ length: 390 }, (_, index) => ({
      id: `event_window_${index}`,
      taskId: "task_1",
      type: "assistant_message" as const,
      createdAt: new Date().toISOString(),
      summary: `assistant item ${index}`,
      payload: {}
    }));
    render(<Timeline task={{ ...task, events }} onApprovalDecision={vi.fn()} />);

    expect(screen.getByText(/30 older assistant\/tool items are not rendered yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load 30 older/i })).toBeInTheDocument();
    expect(screen.getByText("assistant item 389")).toBeInTheDocument();
    expect(screen.queryByText("assistant item 0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load 30 older/i }));
    expect(screen.getByText("assistant item 0")).toBeInTheDocument();
  });

  it("preserves the original user request when windowing a large timeline", () => {
    const events = [
      {
        id: "event_original_goal",
        taskId: "task_1",
        type: "user_message" as const,
        createdAt: new Date().toISOString(),
        summary: "Build a complete blog page with smooth interactions",
        payload: {}
      },
      ...Array.from({ length: 390 }, (_, index) => ({
        id: `event_window_${index}`,
        taskId: "task_1",
        type: "assistant_message" as const,
        createdAt: new Date().toISOString(),
        summary: `assistant item ${index}`,
        payload: {}
      }))
    ];
    render(<Timeline task={{ ...task, events }} onApprovalDecision={vi.fn()} />);

    expect(screen.getByText("Build a complete blog page with smooth interactions")).toBeInTheDocument();
    expect(screen.getByText("assistant item 389")).toBeInTheDocument();
  });

  it("keeps context compaction audit out of the chat stream", () => {
    const fullUserMessage = "优化样式，当前主题变化还未实现，你怎么没有检查呢";
    render(
      <Timeline
        task={{
          ...task,
          events: [
            {
              id: "event_user_full",
              taskId: "task_1",
              type: "user_message",
              createdAt: new Date().toISOString(),
              summary: fullUserMessage,
              payload: {}
            },
            {
              id: "event_summary",
              taskId: "task_1",
              type: "conversation_summary_created",
              createdAt: new Date().toISOString(),
              summary: "Earlier context was compacted into an auditable summary.",
              payload: {
                summary: [
                  "Earlier conversation was compacted to keep the task within the model context window.",
                  "- **Tool Call**: edit_file({ very large payload })",
                  "[UI preview truncated: 999 characters omitted. Full evidence is retained by SCC.]"
                ].join("\n"),
                retainedFacts: ["Original goal: 编写一个完整博客页面"]
              }
            },
            {
              id: "event_overflow",
              taskId: "task_1",
              type: "context_overflow_recovered",
              createdAt: new Date().toISOString(),
              summary: "Context exceeded the active model window; older context was compacted and the request was retried once.",
              payload: {}
            },
            {
              id: "event_answer",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "我会先重新检查主题切换，再验证页面效果。",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText(fullUserMessage)).toBeInTheDocument();
    expect(screen.getByText("我会先重新检查主题切换，再验证页面效果。")).toBeInTheDocument();
    expect(screen.queryByText(/已压缩较早上下文|Earlier context compacted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Original goal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tool Call/)).not.toBeInTheDocument();
    expect(screen.queryByText(/UI preview truncated/)).not.toBeInTheDocument();
  });

  it("keeps tool evidence collapsed, path-focused, and free of placeholder text", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          events: [
            {
              id: "event_tool_path",
              taskId: "task_1",
              type: "tool_result",
              createdAt: new Date().toISOString(),
              summary: "Tool completed",
              payload: {
                toolName: "read_file",
                ok: true,
                args: { path: "src/components/Timeline.tsx" },
                output: JSON.stringify({ summary: "Tool evidence returned.", path: "src/components/Timeline.tsx", content: "actual returned content" })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    const summary = screen.getByRole("button", { name: /components\/Timeline\.tsx/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(".../components/Timeline.tsx")).toBeInTheDocument();
    expect(screen.queryByText("Tool evidence returned.")).not.toBeInTheDocument();
    expect(container.querySelector(".toolResultDetails")).not.toHaveClass("open");

    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".toolResultDetails")).toHaveClass("open");
    expect(screen.getByText(/actual returned content/)).toBeInTheDocument();
  });

  it("strips provider fallback tool boilerplate from assistant messages", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_boilerplate_answer",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "Tool evidence returned.\n\nTop entries:\n- node.exe",
              payload: { message: "Tool evidence returned.\n\nTop entries:\n- node.exe" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.queryByText(/Tool evidence returned/)).not.toBeInTheDocument();
    expect(screen.getByText(/Top entries/)).toBeInTheDocument();
  });

  it("does not render provider-leaked inline tool markup as assistant text", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_leaked_tool_markup",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary:
                'I will inspect files.\n\n<function_calls><invoke name="list_files"><parameter name="path">.</parameter></invoke></function_calls>',
              payload: {}
            },
            {
              id: "event_visible_answer",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "Artifact verified.",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.queryByText(/function_calls/)).not.toBeInTheDocument();
    expect(screen.queryByText(/list_files/)).not.toBeInTheDocument();
    expect(screen.getByText("Artifact verified.")).toBeInTheDocument();
  });

  it("renders streaming assistant output and collapsible thinking", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            ...task.events,
            {
              id: "event_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "Looking at available tools.",
              payload: { streamId: "stream_1", delta: "Looking at available tools." }
            },
            {
              id: "event_delta_1",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: "Partial",
              payload: { streamId: "stream_1", delta: "Partial" }
            },
            {
              id: "event_delta_2",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: " output",
              payload: { streamId: "stream_1", delta: " output" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Partial output")).toBeInTheDocument();
    const thinking = screen.getByRole("button", { name: /Thinking/ });
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".thinkingDetails")).not.toHaveClass("open");
    fireEvent.click(thinking);
    expect(thinking).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".thinkingDetails")).toHaveClass("open");
    expect(container.querySelector(".timelineItemShell.fromLeft .event.assistant_delta")).not.toBeNull();
  });

  it("shows a lightweight running indicator while a response is still open", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_user_running",
              taskId: "task_1",
              type: "user_message",
              createdAt: new Date().toISOString(),
              summary: "Please check this",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByLabelText("think...")).toBeInTheDocument();
    expect(container.querySelector(".event.running_status .thinkingDots")).not.toBeNull();
  });

  it("coalesces burst streaming deltas before appending them to live task state", () => {
    const base: TaskEvent = {
      id: "event_delta_0",
      taskId: "task_1",
      type: "assistant_delta",
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "chunk-0",
      payload: { streamId: "stream_fast", delta: "chunk-0" }
    };
    const burst: TaskEvent[] = [
      {
        id: "event_delta_1",
        taskId: "task_1",
        type: "assistant_delta",
        createdAt: "2026-01-01T00:00:00.010Z",
        summary: "chunk-1",
        payload: { streamId: "stream_fast", delta: "chunk-1" }
      },
      {
        id: "event_delta_2",
        taskId: "task_1",
        type: "assistant_delta",
        createdAt: "2026-01-01T00:00:00.020Z",
        summary: "chunk-2",
        payload: { streamId: "stream_fast", delta: "chunk-2" }
      },
      {
        id: "event_tool",
        taskId: "task_1",
        type: "tool_result",
        createdAt: "2026-01-01T00:00:00.030Z",
        summary: "Tool completed",
        payload: { toolName: "read_file", ok: true, output: "{}" }
      }
    ];

    const merged = coalesceRealtimeEvents([base], burst);

    expect(merged.events).toHaveLength(2);
    expect(merged.acceptedEvents).toHaveLength(3);
    expect(merged.events[0]?.summary).toBe("chunk-0chunk-1chunk-2");
    expect(merged.events[0]?.payload["delta"]).toBe("chunk-0chunk-1chunk-2");
    expect(merged.events[1]?.type).toBe("tool_result");
  });

  it("parses websocket heartbeat messages without treating them as task events", () => {
    expect(parseRealtimeMessage(JSON.stringify({ type: "heartbeat", taskId: "task_1", timestamp: "2026-01-01T00:00:00.000Z" }))).toEqual({
      type: "heartbeat",
      taskId: "task_1",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
  });

  it("uses side-aware animation shells for user and assistant cards", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          events: [
            {
              id: "event_user_side",
              taskId: "task_1",
              type: "user_message",
              createdAt: new Date().toISOString(),
              summary: "请帮我看一下这里",
              payload: {}
            },
            {
              id: "event_assistant_side",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "我先说明当前观察。",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelector(".timelineItemShell.fromRight .event.user_message")).not.toBeNull();
    expect(container.querySelector(".timelineItemShell.fromLeft .event.assistant_message")).not.toBeNull();
  });

  it("hides thinking events when the user preference disables thinking display", () => {
    render(
      <Timeline
        showThinking={false}
        task={{
          ...task,
          events: [
            {
              id: "event_thinking_hidden",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "internal thought should not render",
              payload: { delta: "internal thought should not render", streamId: "stream_hidden" }
            },
            {
              id: "event_visible_body",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "Visible answer.",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.queryByText(/internal thought should not render/)).not.toBeInTheDocument();
    expect(screen.getByText("Visible answer.")).toBeInTheDocument();
  });

  it("only keeps copy actions visible when the last timeline item is assistant body text", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_assistant_body",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "I will inspect the current files first.",
              payload: {}
            },
            {
              id: "event_later_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "Thinking about the next read.",
              payload: { streamId: "stream_thinking", delta: "Thinking about the next read." }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("I will inspect the current files first.")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(container.querySelector(".event.assistant_message .messageActions")).not.toHaveClass("alwaysVisible");
  });

  it("renders assistant markdown as structured content", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_markdown",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: new Date().toISOString(),
              summary: "## Capabilities\n\n- Read code\n- Run tests\n\n```ts\nconst ok = true;\n```",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.getByText("Read code")).toBeInTheDocument();
    expect(screen.getByText("const ok = true;")).toBeInTheDocument();
  });

  it("renders pending approvals inline in the timeline", () => {
    const approval: ToolApproval = {
      id: "approval_1",
      taskId: "task_1",
      riskCategory: "host_observation",
      reason: "Reads system state",
      status: "pending",
      createdAt: new Date().toISOString(),
      toolCall: {
        id: "tool_1",
        toolName: "run_command",
        args: { command: "Get-Process" }
      }
    };
    const onDecision = vi.fn();
    render(
      <Timeline
        task={{
          ...task,
          approvals: [approval],
          events: [
            ...task.events,
            {
              id: "event_approval",
              taskId: "task_1",
              type: "approval_pending",
              createdAt: new Date().toISOString(),
              summary: "Approval needed",
              payload: { approvalId: "approval_1" }
            }
          ]
        }}
        onApprovalDecision={onDecision}
      />
    );
    fireEvent.click(screen.getByText("Allow once"));
    expect(onDecision).toHaveBeenCalledWith("approval_1", "allow_once");
  });

  it("renders approval decisions", () => {
    const approval: ToolApproval = {
      id: "approval_1",
      taskId: "task_1",
      riskCategory: "host_observation",
      reason: "Reads system state",
      status: "pending",
      createdAt: new Date().toISOString(),
      toolCall: {
        id: "tool_1",
        toolName: "run_command",
        args: { command: "Get-Process" }
      }
    };
    const onDecision = vi.fn();
    render(<ApprovalCard approval={approval} onDecision={onDecision} />);
    expect(screen.getByText("Allow globally")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Allow for this task"));
    expect(onDecision).toHaveBeenCalledWith("allow_for_task");
  });

  it("renders permission grants, revoke actions, and localized preferences", () => {
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    const onPreference = vi.fn();
    const grant: GlobalPermissionGrant = {
      id: "global_permission_host_observation",
      riskCategory: "host_observation",
      grantedAt: new Date("2026-05-05T12:00:00.000Z").toISOString(),
      grantedBy: "user",
      reason: "test grant"
    };
    const preferences: UserPreferences = {
      llmProvider: "mimo",
      defaultModel: "mimo-v2.5",
      providerBaseUrl: "",
      contextMode: "auto",
      customModelContextWindow: 128000,
      maxTokensPerRequest: 128000,
      autoApprove: "none",
      showThinking: true,
      language: "zh-CN",
      theme: "dark",
      agentTone: "balanced",
      agentRole: "Pragmatic engineering assistant",
      responseDetail: "normal",
      skillAutoInject: true,
      maxInjectedSkills: 3,
      mcpApprovalMode: "confirm_dangerous",
      sanitizeSensitiveData: true,
      encryptStorage: false,
      modelRoute: { fallbackProviderIds: [] },
      updatedAt: new Date().toISOString()
    };

    const { rerender } = render(
      <PermissionsPanel
        language="zh-CN"
        permissions={[grant]}
        preferences={preferences}
        onGrant={onGrant}
        onRevoke={onRevoke}
        onPreference={onPreference}
      />
    );

    expect(screen.getByRole("heading", { name: "权限与偏好" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /自定义/ }));
    fireEvent.click(screen.getByLabelText("取消自动通过 主机观察"));
    expect(onRevoke).toHaveBeenCalledWith("host_observation");
    fireEvent.click(screen.getByRole("radio", { name: /Read only/ }));
    expect(onGrant).toHaveBeenCalledWith("workspace_read");

    rerender(
      <PermissionsPanel
        language="zh-CN"
        permissions={[grant]}
        preferences={preferences}
        preferencesOnly={true}
        onGrant={onGrant}
        onRevoke={onRevoke}
        onPreference={onPreference}
      />
    );
    fireEvent.click(screen.getByLabelText("界面与回复语言"));
    fireEvent.click(screen.getByRole("option", { name: "English" }));
    expect(onPreference).toHaveBeenCalledWith(expect.objectContaining({ language: "en-US" }));
    fireEvent.click(screen.getByLabelText("外观主题"));
    fireEvent.click(screen.getByRole("option", { name: "白色" }));
    expect(onPreference).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
  });

  it("shows default reflection automation as non-deletable", () => {
    const onDelete = vi.fn();
    const task: ScheduledTask = {
      id: "schedule_agent_reflection",
      type: "reflection",
      title: "Agent self-reflection",
      prompt: "Review recent task memories.",
      permissionPreset: "ask",
      schedule: { kind: "calendar", frequency: "daily", timeOfDay: "02:00" },
      status: "active",
      nextRunAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    render(<ScheduledTasksPanel folders={[]} language="en-US" scheduledTasks={[task]} onCreate={vi.fn()} onDelete={onDelete} onUpdate={vi.fn()} />);

    expect(screen.getByText("System default")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete scheduled task" })).not.toBeInTheDocument();
  });

  it("manages model providers through a compact modal", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const provider: ModelProviderRecord = {
      id: "provider_1",
      vendor: "mimo",
      label: "Mimo",
      protocol: "openai_compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      models: [
        {
          id: "mimo-v2.5",
          label: "mimo-v2.5",
          contextWindow: 128000,
          supportsTools: true,
          supportsThinking: true
        }
      ],
      defaultModelId: "mimo-v2.5",
      enabled: true,
      apiKeyRef: { secretId: "model_provider_provider_1", last4: "1234", updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    render(
      <ModelProvidersPanel
        activeProviderId="provider_1"
        language="en-US"
        providers={[provider]}
        onCreate={onCreate}
        onDelete={onDelete}
        onUpdate={onUpdate}
      />
    );

    expect(screen.getByText("Mimo")).toBeInTheDocument();
    expect(screen.getAllByText("mimo-v2.5").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Mimo").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Edit model"));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key-123456" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        "provider_1",
        expect.objectContaining({
          apiKey: "test-key-123456",
          defaultModelId: "mimo-v2.5"
        })
      )
    );

    fireEvent.click(screen.getByLabelText("Delete model"));
    expect(screen.getByText("This removes Mimo (mimo-v2.5) and its locally stored key. Existing task history is kept.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete model configuration" })).getByRole("button", { name: "Delete model" }));
    expect(onDelete).toHaveBeenCalledWith("provider_1");
  });

  it("manages knowledge notes with markdown preview", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const item: KnowledgeItem = {
      id: "knowledge_1",
      projectId: "default",
      kind: "memory",
      title: "Runtime notes",
      content: "## Runtime\n\n- Use approvals",
      tags: ["runtime", "approval"],
      fileName: undefined,
      mimeType: "text/markdown",
      size: 0,
      indexStatus: "indexed",
      chunkCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    render(
      <KnowledgePanel
        items={[item]}
        language="en-US"
        onCreate={onCreate}
        onDelete={onDelete}
        onUpdate={onUpdate}
        onUpload={vi.fn()}
      />
    );

    expect(screen.getAllByText("Runtime notes").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Runtime" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText("Edit item Runtime notes")[0]!);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated notes" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("knowledge_1", expect.objectContaining({ title: "Updated notes" })));

    fireEvent.click(screen.getByText("New item"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fresh note" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "New body" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Fresh note", kind: "memory" })));
  });

  it("manages user and project memory documents plus structured memories", async () => {
    const now = new Date().toISOString();
    const userDoc: MemoryDocument = {
      scope: "user",
      path: "memory/USER.md",
      fileName: "USER.md",
      content: "# USER.md\n- Prefer concise evidence.",
      charLimit: 12000,
      entryCharLimit: 600,
      updatedAt: now,
    };
    const projectDoc: MemoryDocument = {
      scope: "project",
      folderId: "default",
      workRoot: "D:/repo",
      path: "memory/projects/default/MEMORY.md",
      fileName: "MEMORY.md",
      content: "# MEMORY.md\n- Keep route tests current.",
      charLimit: 12000,
      entryCharLimit: 600,
      updatedAt: now,
    };
    const memory: ProjectMemory = {
      id: "project_memory_1",
      projectId: "default",
      title: "Validation convention",
      content: "Trace files stay outside normal UI.",
      category: "convention",
      tags: ["trace", "ui"],
      createdAt: now,
      updatedAt: now,
    };
    const compactResult: MemoryDocumentCompactResult = {
      document: projectDoc,
      beforeChars: 80,
      afterChars: 64,
      removedLines: 1,
    };
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onLoadProjectMemory = vi.fn().mockResolvedValue(projectDoc);
    const onLoadUserProfile = vi.fn().mockResolvedValue(userDoc);
    const onSaveProjectMemory = vi.fn().mockResolvedValue(projectDoc);
    const onSaveUserProfile = vi.fn().mockResolvedValue(userDoc);
    const onCompactProjectMemory = vi.fn().mockResolvedValue(compactResult);

    render(
      <ProjectMemoryPanel
        activeFolderId="default"
        folders={[{ id: "default", name: "Default", rootPath: "D:/repo", isDefault: true, exists: true, sortOrder: 0, createdAt: now, updatedAt: now }]}
        memories={[memory]}
        onCompactProjectMemory={onCompactProjectMemory}
        onCreate={onCreate}
        onDelete={onDelete}
        onLoadProjectMemory={onLoadProjectMemory}
        onLoadUserProfile={onLoadUserProfile}
        onSaveProjectMemory={onSaveProjectMemory}
        onSaveUserProfile={onSaveUserProfile}
      />,
    );

    expect(await screen.findByLabelText("USER.md content")).toHaveValue(userDoc.content);
    fireEvent.change(screen.getByLabelText("USER.md content"), {
      target: { value: "# USER.md\n- Prefer direct answers." },
    });
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(onSaveUserProfile).toHaveBeenCalledWith("# USER.md\n- Prefer direct answers."));

    fireEvent.click(screen.getAllByRole("button", { name: /Project memory/ })[0]!);
    expect(await screen.findByLabelText("MEMORY.md content")).toHaveValue(projectDoc.content);
    fireEvent.change(screen.getByLabelText("MEMORY.md content"), {
      target: { value: "# MEMORY.md\n- Keep route tests current." },
    });
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(onSaveProjectMemory).toHaveBeenCalledWith("default", "# MEMORY.md\n- Keep route tests current."));

    fireEvent.click(screen.getByLabelText("Compact project memory"));
    await waitFor(() => expect(onCompactProjectMemory).toHaveBeenCalledWith("default"));
    expect(await screen.findByText(/Compacted project memory/)).toBeInTheDocument();

    expect(screen.getByText("Validation convention")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New project memory" }));
    const dialog = screen.getByRole("dialog", { name: "Create project memory" });
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Runtime architecture" },
    });
    fireEvent.change(within(dialog).getByLabelText("Tags"), {
      target: { value: "runtime, trace" },
    });
    fireEvent.change(within(dialog).getByLabelText("Content"), {
      target: { value: "Trace files stay outside normal UI." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        projectId: "default",
        title: "Runtime architecture",
        content: "Trace files stay outside normal UI.",
        category: "architecture",
        tags: ["runtime", "trace"],
      }),
    );

    fireEvent.click(screen.getByLabelText("Delete Validation convention"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete project memory?" })).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("project_memory_1");
  });

  it("manages web search providers with accessible row actions", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const provider: WebSearchProviderConfig = {
      id: "search_brave",
      label: "Brave Search",
      kind: "brave",
      apiKeyRef: { secretId: "search_brave", last4: "1234", updatedAt: new Date().toISOString() },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    render(<WebSearchPanel providers={[provider]} language="en-US" onCreate={onCreate} onDelete={onDelete} onUpdate={onUpdate} />);

    expect(screen.getByText("Brave Search")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Edit search provider Brave Search"));
    fireEvent.change(screen.getByDisplayValue("Brave Search"), { target: { value: "Brave Updated" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("search_brave", expect.objectContaining({ label: "Brave Updated", kind: "brave" })));

    fireEvent.click(screen.getByLabelText("Delete search provider Brave Search"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete search provider" })).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("search_brave");
  });

  it("manages integration rows without exposing secret values", async () => {
    const now = new Date().toISOString();
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onDisconnect = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const provider: IntegrationProviderConfig = {
      id: "integration_discord",
      kind: "discord",
      label: "Discord Ops",
      status: "disabled",
      enabled: false,
      botTokenRef: { secretId: "integration_discord:botToken", last4: "9876", updatedAt: now },
      defaultFolderId: "default",
      defaultPermissionPreset: "ask",
      createdAt: now,
      updatedAt: now
    };

    render(
      <IntegrationsPanel
        folders={defaultFolders()}
        integrations={[provider]}
        language="en-US"
        onConnect={onConnect}
        onCreate={onCreate}
        onDelete={onDelete}
        onDisconnect={onDisconnect}
        onUpdate={onUpdate}
      />
    );

    expect(screen.getByText("Discord Ops")).toBeInTheDocument();
    expect(screen.getByText(/9876/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-token/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Connect Discord Ops"));
    expect(onConnect).toHaveBeenCalledWith("integration_discord");

    fireEvent.click(screen.getByLabelText("Edit integration Discord Ops"));
    fireEvent.change(screen.getByDisplayValue("Discord Ops"), { target: { value: "Discord Support" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("integration_discord", expect.objectContaining({ label: "Discord Support" })));

    fireEvent.click(screen.getByLabelText("Delete Discord Ops"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete integration?" })).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("integration_discord");
  });

  it("renders compact governance rows", () => {
    render(<CompactList title="Skills" rows={[{ id: "skill_1", label: "Host observation", meta: "active" }]} />);
    expect(screen.getByText("Host observation")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("keeps skill settings usable with normalized skill rows", () => {
    render(
      <SkillPanel
        skills={[
          {
            id: "legacy_skill",
            title: "Legacy skill without stats",
            status: "active",
            body: "Use host observation evidence.",
            sourceMemoryIds: [],
            applicability: {
              description: "Legacy row",
              keywords: [],
              requiredTools: [],
              requiredContext: [],
              exclusions: [],
              minConfidence: 0.7
            },
            stats: {
              totalUses: 0,
              successUses: 0,
              failureUses: 0,
              successRate: 0,
              consecutiveFailures: 0
            },
            version: 1,
            corrections: [],
            relatedPatterns: [],
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          } as unknown as SkillRecord
        ]}
        duplicates={[]}
        conflicts={[]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onBulkDelete={vi.fn()}
        onMergeDuplicate={vi.fn()}
        onExport={vi.fn()}
      />
    );
    expect(screen.getAllByText("Legacy skill without stats").length).toBeGreaterThan(0);
    expect(screen.getByText("active · not used yet")).toBeInTheDocument();
  });

  it("renders MCP servers and tools", () => {
    const onConnect = vi.fn();
    render(
      <McpPanel
        servers={[
          {
            id: "mock",
            label: "Mock MCP",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            enabled: true,
            toolRiskOverrides: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: { serverId: "mock", connected: false, state: "disconnected", toolCount: 1 }
          }
        ]}
        tools={[{ id: "mcp__mock__echo", serverId: "mock", name: "echo", displayName: "echo", inputSchema: {}, riskCategory: "shell" }]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("Mock MCP")).toBeInTheDocument();
    expect(screen.getByText("echo")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Connect server"));
    expect(onConnect).toHaveBeenCalledWith("mock");
  });

  it("creates a task, resolves an approval, and continues from a completed thread", async () => {
    const approval: ToolApproval = {
      id: "approval_1",
      taskId: "task_1",
      riskCategory: "host_observation",
      reason: "Reads host state",
      status: "pending",
      createdAt: new Date().toISOString(),
      toolCall: { id: "tool_1", toolName: "run_command", args: { command: "Get-Process" } }
    };
    const created: TaskDetail = {
      ...task,
      id: "task_1",
      title: "Check host",
      approvals: [approval],
      events: [
        { ...task.events[0]!, taskId: "task_1" },
        {
          id: "event_approval",
          taskId: "task_1",
          type: "approval_pending",
          createdAt: new Date().toISOString(),
          summary: "Approval required",
          payload: { approvalId: "approval_1" }
        }
      ]
    };
    const completed: TaskDetail = {
      ...created,
      status: "completed",
      approvals: [{ ...approval, status: "approved" }],
      events: [
        ...created.events,
        {
          id: "event_final",
          taskId: "task_1",
          type: "assistant_message",
          createdAt: new Date().toISOString(),
          summary: "Top process: node",
          payload: {}
        }
      ]
    };
    let currentTasks: TaskDetail[] = [];
    const createTask = vi.fn((goal: string, title?: string) => {
      currentTasks = [{ ...created, title: title ?? "Check host" }];
      return currentTasks[0];
    });
    const sendMessage = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/task-folders") return jsonResponse([{ id: "default", name: "Default", sortOrder: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
        if (url === "/api/tasks" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { goal: string; title?: string };
          return jsonResponse(createTask(body.goal, body.title));
        }
        if (url === "/api/tasks") return jsonResponse(currentTasks);
        if (url.startsWith("/api/tasks/task_1/transcript")) return jsonResponse((currentTasks.find((item) => item.id === "task_1") ?? created).events);
        if (url === "/api/tasks/task_1" || url.startsWith("/api/tasks/task_1?")) return jsonResponse(currentTasks.find((item) => item.id === "task_1") ?? created);
        if (
          url === "/api/experiences" ||
          url === "/api/task-memories" ||
          url === "/api/patterns" ||
          url === "/api/skills" ||
          url === "/api/skills/duplicates" ||
          url === "/api/skill-conflicts" ||
          url === "/api/skill-curator" ||
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories" ||
          url === "/api/mcp/servers" ||
          url === "/api/mcp/tools" ||
          url === "/api/knowledge" ||
          url === "/api/model-providers" ||
          url === "/api/scheduled-tasks" ||
          url === "/api/web-search/providers"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            llmProvider: "mimo",
            defaultModel: "gpt-5.4-mini",
            providerBaseUrl: "",
            contextMode: "auto",
            customModelContextWindow: 128000,
            maxTokensPerRequest: 128000,
            autoApprove: "none",
            showThinking: true,
            language: "en-US",
            theme: "dark",
            agentTone: "balanced",
            agentRole: "Pragmatic engineering assistant",
            responseDetail: "normal",
            skillAutoInject: true,
            maxInjectedSkills: 3,
            mcpApprovalMode: "confirm_dangerous",
            sanitizeSensitiveData: true,
            encryptStorage: false,
            modelRoute: { fallbackProviderIds: [] },
            updatedAt: new Date().toISOString()
          });
        }
        if (url.includes("/approvals/")) {
          currentTasks = [completed];
          return jsonResponse(completed);
        }
        if (url.endsWith("/messages")) {
          const body = JSON.parse(String(init?.body)) as { content: string };
          sendMessage(url, body.content);
          return jsonResponse({
            ...completed,
            events: [
              ...completed.events,
              {
                id: "event_continue",
                taskId: "task_1",
                type: "user_message",
                createdAt: new Date().toISOString(),
                summary: body.content,
                payload: {}
              }
            ]
          });
        }
        return jsonResponse([]);
      })
    );

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check host" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByText("Reads host state")).toBeInTheDocument();
    expect(createTask).toHaveBeenCalledWith("check host", undefined);
    fireEvent.click(screen.getByText("Allow once"));
    await waitFor(() => expect(screen.getByText("Top process: node")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "second goal" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("/api/tasks/task_1/messages", "second goal"));
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("keeps a created running task visible when transcript hydration times out", async () => {
    const now = new Date().toISOString();
    const created: TaskDetail = {
      ...task,
      id: "task_long",
      title: "Long output",
      status: "running",
      approvals: [],
      events: [
        {
          id: "event_user_long",
          taskId: "task_long",
          type: "user_message",
          createdAt: now,
          summary: "帮我检查这个项目为什么慢",
          payload: {}
        }
      ]
    };
    let currentTasks: TaskDetail[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
        if (url === "/api/tasks" && method === "POST") {
          currentTasks = [created];
          return jsonResponse(created);
        }
        if (url === "/api/tasks") return jsonResponse(currentTasks);
        if (url === "/api/tasks/task_long" || url.startsWith("/api/tasks/task_long?")) return jsonResponse(created);
        if (url === "/api/tasks/task_long/transcript") throw new Error("后端响应超时。模型处理时间较长，请稍后重试或检查后端服务状态。");
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      })
    );

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "帮我检查这个项目为什么慢" } });
    await waitFor(() => expect(screen.getByLabelText("发送")).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("发送"));

    expect(await screen.findByRole("heading", { name: "Long output" })).toBeInTheDocument();
    expect(screen.getByLabelText("think...")).toBeInTheDocument();
    expect(screen.queryByText(/后端响应超时/)).not.toBeInTheDocument();
  });

  it("waits for pending permission preset updates before starting a new task", async () => {
    const now = new Date().toISOString();
    const created: TaskDetail = {
      ...task,
      id: "task_permission",
      title: "Permission check",
      status: "running",
      approvals: [],
      events: []
    };
    const grants: GlobalPermissionGrant[] = [];
    const grantCalls: RiskCategory[] = [];
    const createCalls: string[] = [];
    let releasePermissionMutation!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermissionMutation = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("en-US"));
        if (url === "/api/permissions/global" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { riskCategory: RiskCategory };
          grantCalls.push(body.riskCategory);
          await permissionGate;
          const grant: GlobalPermissionGrant = {
            id: `grant_${body.riskCategory}`,
            riskCategory: body.riskCategory,
            reason: "test",
            grantedBy: "test",
            grantedAt: now
          };
          grants.push(grant);
          return jsonResponse(grant);
        }
        if (url === "/api/permissions/global") return jsonResponse(grants);
        if (url === "/api/tasks" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { goal: string };
          createCalls.push(body.goal);
          return jsonResponse({ ...created, events: [{ id: "event_goal", taskId: created.id, type: "user_message", createdAt: now, summary: body.goal, payload: {} }] });
        }
        if (url === "/api/tasks") return jsonResponse(createCalls.length > 0 ? [created] : []);
        if (url === "/api/tasks/task_permission" || url.startsWith("/api/tasks/task_permission?")) return jsonResponse(created);
        if (url === "/api/tasks/task_permission/transcript") return jsonResponse(created.events);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      })
    );

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Choose permission scope"));
    fireEvent.click(screen.getByText("Read only"));
    await waitFor(() => expect(grantCalls).toEqual(["host_observation"]));

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check this folder" } });
    await waitFor(() => expect(screen.getByLabelText("Send")).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("Send"));
    expect(createCalls).toHaveLength(0);

    releasePermissionMutation();
    await waitFor(() => expect(grantCalls).toEqual(["host_observation", "workspace_read"]));
    await waitFor(() => expect(createCalls).toEqual(["check this folder"]));
  });

  it("renders the full transcript endpoint instead of rebuilding chat from windowed events", async () => {
    const now = new Date().toISOString();
    const windowedTask: TaskDetail = {
      ...task,
      id: "task_1",
      title: "Long transcript",
      status: "completed",
      events: [
        {
          id: "event_window_tail",
          taskId: "task_1",
          type: "assistant_message",
          createdAt: now,
          summary: "Tail-only event from the audit window",
          payload: {}
        }
      ]
    };
    const fullTranscript = [
      {
        id: "event_original_user",
        taskId: "task_1",
        type: "user_message" as const,
        createdAt: now,
        summary: "完整用户原始需求：编写一个完整博客页面，拥有炫酷效果和优雅布局和丝滑交互",
        payload: {}
      },
      {
        id: "event_context_summary",
        taskId: "task_1",
        type: "conversation_summary_created" as const,
        createdAt: now,
        summary: "Earlier context compacted",
        payload: {
          summary: "Original goal: should not appear in transcript\n[UI preview truncated: 123 characters omitted. Full evidence is retained by SCC.]"
        }
      },
      {
        id: "event_early_agent",
        taskId: "task_1",
        type: "assistant_message" as const,
        createdAt: now,
        summary: "我已经创建 styles.css 和 script.js，并会继续验证主题切换。",
        payload: {}
      },
      windowedTask.events[0]!
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/task-folders") return jsonResponse([{ id: "default", name: "Default", sortOrder: 0, createdAt: now, updatedAt: now }]);
        if (url === "/api/tasks") return jsonResponse([windowedTask]);
        if (url === "/api/tasks/task_1" || url.startsWith("/api/tasks/task_1?")) return jsonResponse(windowedTask);
        if (url === "/api/tasks/task_1/transcript") return jsonResponse(fullTranscript.filter((event) => event.type !== "conversation_summary_created"));
        if (
          url === "/api/experiences" ||
          url === "/api/task-memories" ||
          url === "/api/patterns" ||
          url === "/api/skills" ||
          url === "/api/skills/duplicates" ||
          url === "/api/skill-conflicts" ||
          url === "/api/skill-curator" ||
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories" ||
          url === "/api/mcp/servers" ||
          url === "/api/mcp/tools" ||
          url === "/api/knowledge" ||
          url === "/api/model-providers" ||
          url === "/api/scheduled-tasks" ||
          url === "/api/web-search/providers"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            llmProvider: "mimo",
            defaultModel: "mimo-v2.5",
            providerBaseUrl: "",
            contextMode: "auto",
            customModelContextWindow: 128000,
            maxTokensPerRequest: 128000,
            autoApprove: "none",
            showThinking: true,
            language: "zh-CN",
            theme: "dark",
            agentTone: "balanced",
            agentRole: "Pragmatic engineering assistant",
            responseDetail: "normal",
            skillAutoInject: true,
            maxInjectedSkills: 3,
            mcpApprovalMode: "confirm_dangerous",
            sanitizeSensitiveData: true,
            encryptStorage: false,
            modelRoute: { fallbackProviderIds: [] },
            updatedAt: now
          });
        }
        return jsonResponse([]);
      })
    );

    render(<App />);

    expect(await screen.findByText(/完整用户原始需求/)).toBeInTheDocument();
    expect(screen.getByText(/我已经创建 styles.css 和 script.js/)).toBeInTheDocument();
    expect(screen.getByText("Tail-only event from the audit window")).toBeInTheDocument();
    expect(screen.queryByText(/Original goal|UI preview truncated/)).not.toBeInTheDocument();
  });

  it("moves governance surfaces into settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/task-folders") return jsonResponse([{ id: "default", name: "Default", sortOrder: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
        if (url === "/api/tasks") return jsonResponse([]);
        if (
          url === "/api/experiences" ||
          url === "/api/task-memories" ||
          url === "/api/patterns" ||
          url === "/api/skills" ||
          url === "/api/skills/duplicates" ||
          url === "/api/skill-conflicts" ||
          url === "/api/skill-curator" ||
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories" ||
          url === "/api/mcp/servers" ||
          url === "/api/mcp/tools" ||
          url === "/api/knowledge" ||
          url === "/api/model-providers" ||
          url === "/api/scheduled-tasks" ||
          url === "/api/web-search/providers"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            llmProvider: "mimo",
            defaultModel: "gpt-5.4-mini",
            providerBaseUrl: "",
            contextMode: "auto",
            customModelContextWindow: 128000,
            maxTokensPerRequest: 128000,
            autoApprove: "none",
            showThinking: true,
            language: "en-US",
            theme: "dark",
            agentTone: "balanced",
            agentRole: "Pragmatic engineering assistant",
            responseDetail: "normal",
            skillAutoInject: true,
            maxInjectedSkills: 3,
            mcpApprovalMode: "confirm_dangerous",
            sanitizeSensitiveData: true,
            encryptStorage: false,
            modelRoute: { fallbackProviderIds: [] },
            updatedAt: new Date().toISOString()
          });
        }
        return jsonResponse([]);
      })
    );

    render(<App />);
    expect(await screen.findByText("Model: not configured")).toBeInTheDocument();
    expect(screen.queryByText("gpt-5.4-mini")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("Settings"));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/providers");
    fireEvent.click(screen.getByText("Permissions"));
    expect(await screen.findByText("Permissions and preferences")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/permissions");
    fireEvent.click(screen.getByText("Scheduled tasks"));
    expect(await screen.findByRole("heading", { name: "Scheduled tasks" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/scheduled");
    fireEvent.click(screen.getByText("Web search"));
    expect(await screen.findByRole("heading", { name: "Web search" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/search");
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
    text: async () => JSON.stringify(value)
  } as Response;
}

function defaultFolders(): TaskFolderRecord[] {
  return [{ id: "default", name: "Default", sortOrder: 0, isDefault: true, exists: true, rootPath: process.cwd(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
}

function defaultPreferences(language: "zh-CN" | "en-US"): UserPreferences {
  return {
    llmProvider: "mimo",
    defaultModel: "mimo-v2.5",
    providerBaseUrl: "",
    contextMode: "auto",
    customModelContextWindow: 128000,
    maxTokensPerRequest: 128000,
    autoApprove: "none",
    showThinking: true,
    language,
    theme: "dark",
    agentTone: "balanced",
    agentRole: "Pragmatic engineering assistant",
    responseDetail: "normal",
    skillAutoInject: true,
    maxInjectedSkills: 3,
    mcpApprovalMode: "confirm_dangerous",
    sanitizeSensitiveData: true,
    encryptStorage: false,
    modelRoute: { fallbackProviderIds: [] },
    updatedAt: new Date().toISOString()
  } as UserPreferences;
}

function isWorkbenchCollectionEndpoint(url: string): boolean {
  return (
    url === "/api/experiences" ||
    url === "/api/task-memories" ||
    url === "/api/patterns" ||
    url === "/api/skills" ||
    url === "/api/skills/duplicates" ||
    url === "/api/skill-conflicts" ||
    url === "/api/skill-curator" ||
    url === "/api/reflections" ||
    url === "/api/project-memories" ||
    url === "/api/mcp/servers" ||
    url === "/api/mcp/tools" ||
    url === "/api/knowledge" ||
    url === "/api/model-providers" ||
    url === "/api/scheduled-tasks" ||
    url === "/api/web-search/providers" ||
    url === "/api/prompt-cache-stats"
  );
}
