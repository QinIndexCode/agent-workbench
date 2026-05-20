// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalPermissionGrant, IntegrationProviderConfig, KnowledgeItem, MemoryDocument, MemoryDocumentCompactResult, ModelProviderRecord, ProjectMemory, RiskCategory, ScheduledTask, SkillRecord, TaskDetail, TaskEvent, TaskFolderRecord, ToolApproval, UserPreferences, WebSearchProviderConfig } from "@agent-workbench/shared";
import { App } from "./App.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
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
import { applyTaskShellEvents, compactTaskEventsForTranscript, mergeSelectedTaskShell } from "./useWorkbenchData.js";

afterEach(() => {
  cleanup();
  if (typeof window.localStorage?.clear === "function") window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

const TEST_SESSION_TOKEN = "app-test-session";

function getSendButton(): HTMLElement {
  return screen.queryByLabelText("Send") ?? screen.getByLabelText("发送");
}

describe("Composer", () => {
  it("uses one primary adaptive button for send and stop", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Composer busy={false} running={true} mode="guidance" onSubmit={onSubmit} onStop={onStop} />);

    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "new guidance" } });
    fireEvent.click(getSendButton());
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
    fireEvent.click(screen.getByText("Full access"));
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
    kind: "primary",
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

  it("renders delegated child work cards above the timeline and opens a child thread on click", async () => {
    const onOpenDelegatedTask = vi.fn();
    render(
      <TaskThread
        task={{ ...task, kind: "primary", status: "running" }}
        delegatedChildren={[{
          id: "task_child_1",
          title: "Renderer comparison",
          status: "running",
          updatedAt: new Date().toISOString(),
          parentTaskId: "task_1",
          sourceToolCallId: "tool_spawn_child_1",
          goal: "Compare the renderer paths",
          statusText: "Inspecting the main renderer flow.",
          activeToolName: "read_file"
        }]}
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
        onOpenCustomPermissions={vi.fn()}
        onRestoreCustomPermissions={vi.fn()}
        hasCustomSnapshot={false}
        onPermissionPresetChange={vi.fn()}
        onOpenTasks={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        onRetryTitle={vi.fn()}
        onUseLocalTitle={vi.fn()}
        onApprovalDecision={vi.fn()}
        onOpenDelegatedTask={onOpenDelegatedTask}
      />
    );

    expect(screen.getByRole("heading", { name: "Delegated Work" })).toBeInTheDocument();
    expect(await screen.findByText("check processes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Renderer comparison/i }));
    expect(onOpenDelegatedTask).toHaveBeenCalledWith("task_child_1");
  });

  it("shows a parent breadcrumb when viewing a child task", () => {
    const onReturnToParent = vi.fn();
    render(
      <TaskThread
        task={{ ...task, kind: "subagent", id: "task_child_2", title: "Child thread", parentTaskId: "task_1", status: "completed" }}
        parentTask={{ ...task, kind: "primary", title: "Parent thread" }}
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
        onOpenCustomPermissions={vi.fn()}
        onRestoreCustomPermissions={vi.fn()}
        hasCustomSnapshot={false}
        onPermissionPresetChange={vi.fn()}
        onOpenTasks={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        onRetryTitle={vi.fn()}
        onUseLocalTitle={vi.fn()}
        onApprovalDecision={vi.fn()}
        onReturnToParent={onReturnToParent}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Parent thread/i }));
    expect(onReturnToParent).toHaveBeenCalledOnce();
  });

  it("keeps a child task route selected across background task-shell refreshes even when the list excludes children", async () => {
    window.history.replaceState({}, "", "/tasks/task_child_route");
    const now = new Date().toISOString();
    const parentTask: TaskDetail = {
      ...task,
      kind: "primary",
      id: "task_parent_route",
      title: "Parent route thread",
      status: "completed",
      events: [
        {
          id: "event_parent_route_goal",
          taskId: "task_parent_route",
          type: "user_message",
          createdAt: now,
          summary: "Parent route goal",
          payload: {}
        }
      ]
    };
    const childTask: TaskDetail = {
      ...task,
      kind: "subagent",
      id: "task_child_route",
      title: "Child route thread",
      parentTaskId: "task_parent_route",
      status: "completed",
      events: [
        {
          id: "event_child_route_goal",
          taskId: "task_child_route",
          type: "user_message",
          createdAt: now,
          summary: "Delegated route goal",
          payload: {}
        },
        {
          id: "event_child_route_final",
          taskId: "task_child_route",
          type: "assistant_message",
          createdAt: now,
          summary: "Child route answer",
          payload: {}
        }
      ]
    };
    const requests: string[] = [];

    stubAuthedFetch(async (url) => {
      requests.push(url);
      if (url === "/health") return jsonResponse({ ok: true });
      if (url === "/api/task-folders") return jsonResponse(defaultFolders());
      if (url === "/api/preferences") return jsonResponse(defaultPreferences("en-US"));
      if (url === "/api/tasks") return jsonResponse([parentTask]);
      if (url === "/api/tasks/task_child_route" || url.startsWith("/api/tasks/task_child_route?")) return jsonResponse(childTask);
      if (url === "/api/tasks/task_child_route/transcript") return jsonResponse(childTask.events);
      if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
      return jsonResponse([]);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Child route thread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Parent route thread\s*\/\s*Child route thread/i })).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2700));
    });
    await waitFor(() => expect(requests.filter((url) => url === "/api/tasks/task_child_route/transcript").length).toBeGreaterThanOrEqual(2));

    expect(screen.getByRole("heading", { name: "Child route thread" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/tasks/task_child_route");
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
    expect(screen.getByText(/will be removed from Agent Workbench/)).toBeInTheDocument();
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

  it("shows loaded skills in both the timeline and the task side panel", () => {
    const now = new Date().toISOString();
    const skillTask: TaskDetail = {
      ...task,
      status: "running",
      events: [
        {
          id: "event_skill_user",
          taskId: "task_1",
          type: "user_message",
          createdAt: now,
          summary: "Check the deployment flow",
          payload: {}
        },
        {
          id: "event_skill_loaded",
          taskId: "task_1",
          type: "skill_loaded",
          createdAt: now,
          summary: "Deployment checklist",
          payload: {
            skillId: "skill_deploy",
            title: "Deployment checklist",
            status: "candidate",
            source: "reflection_pattern",
            matchReason: "Matched the release and deploy signals in the current task.",
            matchedSignals: ["deploy", "release"],
            requiredTools: ["read_file", "run_command"],
            requiredContext: ["release-notes"],
            readOnlySuggestion: true
          }
        },
        {
          id: "event_skill_skipped",
          taskId: "task_1",
          type: "skill_load_skipped",
          createdAt: now,
          summary: "Skipped candidate",
          payload: {
            requested: "Legacy release steps",
            reason: "Candidate skill is not active yet.",
            title: "Legacy release steps",
            status: "candidate",
            source: "task_memory",
            matchedSignals: ["release"]
          }
        }
      ],
      approvals: [],
      pendingGuidance: []
    };

    render(
      <TaskThread
        task={skillTask}
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
        onOpenCustomPermissions={vi.fn()}
        onRestoreCustomPermissions={vi.fn()}
        hasCustomSnapshot={false}
        onPermissionPresetChange={vi.fn()}
        onOpenTasks={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        onRetryTitle={vi.fn()}
        onUseLocalTitle={vi.fn()}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getAllByText("Deployment checklist").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Matched the release and deploy signals in the current task.").length).toBeGreaterThan(1);
    expect(screen.getByText("Skills in this task")).toBeInTheDocument();
    expect(screen.getByText("Skipped candidates")).toBeInTheDocument();
    expect(screen.getByText("Candidate skill is not active yet.")).toBeInTheDocument();
  });

  it("uses the sidebar as a file rollback timeline and opens rollback checks in the chat", async () => {
    const now = new Date().toISOString();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    const onPreviewRollback = vi.fn().mockResolvedValue({
      taskId: "task_rollback",
      checkpointId: "checkpoint_1",
      workRoot: process.cwd(),
      restorableFiles: 1,
      deletableFiles: 0,
      skippedFiles: 0,
      createdAt: now,
      files: [{
        path: `${process.cwd()}\\src\\math.ts`,
        relativePath: "src/math.ts",
        status: "modified",
        existedBefore: true,
        existsNow: true,
        canRollback: true,
        sizeBefore: 12,
        sizeNow: 20
      }]
    });
    const onRollback = vi.fn().mockResolvedValue({
      taskId: "task_rollback",
      checkpointId: "checkpoint_1",
      workRoot: process.cwd(),
      restoredFiles: 1,
      deletedFiles: 0,
      skippedFiles: 0,
      createdAt: now,
      files: []
    });
    const onRevertTurn = vi.fn().mockResolvedValue("Rollback discussion draft");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const rollbackTask: TaskDetail = {
      ...task,
      id: "task_rollback",
      status: "completed",
      events: [
        {
          id: "event_user_rollback",
          taskId: "task_rollback",
          type: "user_message",
          createdAt: now,
          summary: "Please fix src/math.ts and keep the change reversible.",
          payload: { turnId: "turn_rollback" }
        },
        {
          id: "event_tool_request",
          taskId: "task_rollback",
          type: "tool_requested",
          createdAt: now,
          summary: "edit_file",
          payload: { toolCallId: "call_edit", toolName: "edit_file", args: { path: "src/math.ts" } }
        },
        {
          id: "event_checkpoint",
          taskId: "task_rollback",
          type: "task_checkpoint_created",
          createdAt: now,
          summary: "Checkpoint created before edit_file.",
          payload: { checkpointId: "checkpoint_1", toolCallId: "call_edit", toolName: "edit_file", fileCount: 1 }
        },
        {
          id: "event_token_usage",
          taskId: "task_rollback",
          type: "token_usage_recorded",
          createdAt: now,
          summary: "Provider token usage recorded.",
          payload: { inputTokens: 999999, outputTokens: 999999, totalTokens: 1999998 }
        }
      ],
      approvals: [],
      pendingGuidance: []
    };

    try {
      const { container } = render(
        <TaskThread
          task={rollbackTask}
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
          onOpenCustomPermissions={vi.fn()}
          onRestoreCustomPermissions={vi.fn()}
          hasCustomSnapshot={false}
          onPermissionPresetChange={vi.fn()}
          onOpenTasks={vi.fn()}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          onPreviewRollback={onPreviewRollback}
          onRollback={onRollback}
          onRevertTurn={onRevertTurn}
          onRetryTitle={vi.fn()}
          onUseLocalTitle={vi.fn()}
          onApprovalDecision={vi.fn()}
        />
      );

      expect(screen.getByText("File rollback timeline")).toBeInTheDocument();
      expect(screen.getByText("Click a rollback point to inspect it in the chat timeline.")).toBeInTheDocument();
      expect(screen.getByText(".../src/math.ts")).toBeInTheDocument();
      expect(screen.queryByText("Review checkpoints")).not.toBeInTheDocument();
      expect(screen.queryByText("Token usage")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Files/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Revert turn/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Rollback selected files/i })).not.toBeInTheDocument();

      const sidebarPoint = container.querySelector(".rollbackCheckpointMain");
      expect(sidebarPoint).not.toBeNull();
      fireEvent.click(sidebarPoint as HTMLElement);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(container.querySelector(".taskPlanPanel")?.className).toContain("collapsed");

      fireEvent.click(screen.getByRole("button", { name: /Inspect rollback point/i }));
      await waitFor(() => expect(onPreviewRollback).toHaveBeenCalledWith({ checkpointId: "checkpoint_1" }));
      expect(screen.getAllByText("src/math.ts").length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: /Rollback selected files/i }));
      await waitFor(() => expect(onRollback).toHaveBeenCalledWith({ checkpointId: "checkpoint_1", filePaths: [`${process.cwd()}\\src\\math.ts`] }));
      expect(onRevertTurn).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("keeps rollback preview errors and empty states in the checkpoint chat card", async () => {
    const now = new Date().toISOString();
    const checkpointTask: TaskDetail = {
      ...task,
      id: "task_checkpoint_empty",
      status: "completed",
      events: [{
        id: "event_checkpoint_empty",
        taskId: "task_checkpoint_empty",
        type: "task_checkpoint_created",
        createdAt: now,
        summary: "Checkpoint created before edit_file.",
        payload: { checkpointId: "checkpoint_empty", toolName: "edit_file", fileCount: 0 }
      }],
      approvals: []
    };
    const failingPreview = vi.fn().mockRejectedValue(new Error("No checkpoint is available for this task."));
    const emptyPreview = vi.fn().mockResolvedValue({
      taskId: "task_checkpoint_empty",
      checkpointId: "checkpoint_empty",
      workRoot: process.cwd(),
      restorableFiles: 0,
      deletableFiles: 0,
      skippedFiles: 0,
      createdAt: now,
      files: []
    });

    const { rerender } = render(
      <Timeline
        task={checkpointTask}
        onPreviewRollback={failingPreview}
        onRollback={vi.fn()}
        onApprovalDecision={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Inspect rollback point/i }));
    expect(await screen.findByText("No checkpoint is available for this task.")).toBeInTheDocument();

    rerender(
      <Timeline
        task={checkpointTask}
        onPreviewRollback={emptyPreview}
        onRollback={vi.fn()}
        onApprovalDecision={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Inspect rollback point/i }));
    expect(await screen.findByText("This rollback point has no files to inspect.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rollback selected files/i })).toBeDisabled();
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
                  "[UI preview truncated: 999 characters omitted. Full evidence is retained by Agent Workbench.]"
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

  it("preserves selected task events when a list refresh only returns shell data", () => {
    const detailedTask: TaskDetail = {
      ...task,
      status: "running",
      events: [
        {
          id: "event_plan",
          taskId: "task_1",
          type: "conversation_summary_created",
          createdAt: new Date().toISOString(),
          summary: "Compacted earlier context",
          payload: {}
        }
      ]
    };
    const shellTask: TaskDetail = {
      ...detailedTask,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      events: [],
      pendingGuidance: []
    };

    const merged = mergeSelectedTaskShell(detailedTask, shellTask);

    expect(merged.status).toBe("running");
    expect(merged.updatedAt).toBe(shellTask.updatedAt);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0]?.type).toBe("conversation_summary_created");
  });

  it("ignores stale task-shell refreshes after a newer polling snapshot", () => {
    const currentTask: TaskDetail = {
      ...task,
      status: "completed",
      updatedAt: "2026-05-17T10:00:02.000Z",
      events: []
    };
    const staleShell: TaskDetail = {
      ...currentTask,
      status: "running",
      updatedAt: "2026-05-17T10:00:01.000Z"
    };

    const merged = mergeSelectedTaskShell(currentTask, staleShell);

    expect(merged.status).toBe("completed");
    expect(merged.updatedAt).toBe(currentTask.updatedAt);
  });

  it("applies realtime title and status events to the task shell immediately", () => {
    const currentTask: TaskDetail = {
      ...task,
      title: "Create Or",
      status: "running",
      updatedAt: "2026-05-17T10:00:01.000Z",
      events: []
    };

    const merged = applyTaskShellEvents(currentTask, [
      {
        id: "event_title_update",
        taskId: "task_1",
        type: "task_title_updated",
        createdAt: "2026-05-17T10:00:02.000Z",
        summary: "Create validation-probe-lines.txt with five lines",
        payload: {
          previousTitle: "Create Or",
          newTitle: "Create validation-probe-lines.txt with five lines",
          uiHidden: true
        }
      },
      {
        id: "event_status_update",
        taskId: "task_1",
        type: "status_changed",
        createdAt: "2026-05-17T10:00:03.000Z",
        summary: "completed",
        payload: {}
      }
    ]);

    expect(merged.title).toBe("Create validation-probe-lines.txt with five lines");
    expect(merged.status).toBe("completed");
    expect(merged.updatedAt).toBe("2026-05-17T10:00:03.000Z");
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

  it("keeps large read_file output out of the inline timeline body", () => {
    const hugeReadMarker = "VERY_LARGE_INLINE_READ_PAYLOAD";
    const { container } = render(
      <Timeline
        task={{
          ...task,
          events: [
            {
              id: "event_tool_large_read",
              taskId: "task_1",
              type: "tool_result",
              createdAt: new Date().toISOString(),
              summary: "Tool completed",
              payload: {
                toolName: "read_file",
                ok: true,
                args: { path: "src/index.html" },
                output: JSON.stringify({
                  path: "src/index.html",
                  mode: "full",
                  sizeBytes: 42959,
                  totalLines: 765,
                  partial: false,
                  content: `${hugeReadMarker}\n${"filler line\n".repeat(500)}`
                })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    const summary = screen.getByRole("button", { name: /index\.html/ });
    fireEvent.click(summary);
    expect(container.querySelector(".toolResultDetails")).toHaveClass("open");
    expect(screen.getByText(/Large change: inline view shows only path, status, and line counts|Large output: inline view shows the summary and path only/)).toBeInTheDocument();
    expect(screen.queryByText(hugeReadMarker)).not.toBeInTheDocument();
  });

  it("preserves readable assistant and thinking preambles for turns that continued into tools", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          events: [
            {
              id: "event_legacy_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "Need to inspect the file first.",
              payload: { streamId: "stream_legacy", delta: "Need to inspect the file first." }
            },
            {
              id: "event_legacy_delta",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: "Now let me read the file.",
              payload: { streamId: "stream_legacy", delta: "Now let me read the file." }
            },
            {
              id: "event_legacy_tool",
              taskId: "task_1",
              type: "tool_result",
              createdAt: new Date().toISOString(),
              summary: "Tool completed",
              payload: {
                toolCallId: "tool_call_legacy",
                toolName: "read_file",
                ok: true,
                output: JSON.stringify({ path: "src/index.html", mode: "large_preview", partial: true, totalLines: 700, content: "preview" })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("Now let me read the file.")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getAllByText("Need to inspect the file first.").length).toBeGreaterThan(0);
    expect(container.querySelector(".event.assistant_delta")).not.toBeNull();
    expect(container.querySelectorAll(".event.tool_result")).toHaveLength(1);
  });

  it("merges running tool progress and final results into one path-focused card", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_tool_started",
              taskId: "task_1",
              type: "tool_started",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "Tool started",
              payload: {
                toolCallId: "tool_call_1",
                toolName: "write_file",
                status: "running",
                args: { path: "src/generated/large-blog.tsx", expectedHash: "__new__", content: "hidden debug arg" }
              }
            },
            {
              id: "event_tool_progress",
              taskId: "task_1",
              type: "tool_progress",
              createdAt: "2026-01-01T00:00:00.100Z",
              summary: "Tool progress",
              payload: {
                toolCallId: "tool_call_1",
                toolName: "write_file",
                status: "running",
                targetPath: "src/generated/large-blog.tsx",
                operation: "create",
                changes: { path: "src/generated/large-blog.tsx", addedLines: 10, removedLines: 0, operation: "create" },
                progress: { processed: 5, total: 10, unit: "lines" },
                message: "Writing file"
              }
            },
            {
              id: "event_tool_result",
              taskId: "task_1",
              type: "tool_result",
              createdAt: "2026-01-01T00:00:00.200Z",
              summary: "Tool completed",
              payload: {
                toolCallId: "tool_call_1",
                toolName: "write_file",
                ok: true,
                output: JSON.stringify({
                  status: "success",
                  path: "src/generated/large-blog.tsx",
                  displayMode: "summary_only",
                  changes: { path: "src/generated/large-blog.tsx", addedLines: 10, removedLines: 0, operation: "create" }
                })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelectorAll(".event.tool_result")).toHaveLength(1);
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("-0")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    const summary = screen.getByRole("button", { name: /large-blog\.tsx/ });
    fireEvent.click(summary);
    expect(screen.getAllByText("src/generated/large-blog.tsx").length).toBeGreaterThan(0);
    expect(screen.getByText(/Large change/)).toBeInTheDocument();
    expect(screen.queryByText("hidden debug arg")).not.toBeInTheDocument();
  });

  it("shows requested tools and live file line changes before completion", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_tool_requested",
              taskId: "task_1",
              type: "tool_requested",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "edit_file",
              payload: {
                toolCallId: "tool_call_requested",
                toolName: "edit_file",
                args: { path: "src/ui/TaskThread.tsx", expectedHash: "abc123" },
                riskCategory: "workspace_write"
              }
            },
            {
              id: "event_tool_progress_requested",
              taskId: "task_1",
              type: "tool_progress",
              createdAt: "2026-01-01T00:00:00.100Z",
              summary: "Applying edit",
              payload: {
                toolCallId: "tool_call_requested",
                toolName: "edit_file",
                status: "running",
                targetPath: "src/ui/TaskThread.tsx",
                operation: "edit",
                changes: { path: "src/ui/TaskThread.tsx", addedLines: 4, removedLines: 2, operation: "edit" },
                progress: { processed: 0, total: 1200, unit: "bytes" },
                message: "Applying edit"
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelectorAll(".event.tool_call.tool_pending")).toHaveLength(1);
    expect(screen.getByText(".../ui/TaskThread.tsx")).toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(screen.getByText("-2")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("shows completed file line changes from result metadata without requiring expansion", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_tool_result_only",
              taskId: "task_1",
              type: "tool_result",
              createdAt: "2026-01-01T00:00:00.200Z",
              summary: "Tool completed",
              payload: {
                toolCallId: "tool_call_result_only",
                toolName: "write_file",
                ok: true,
                output: JSON.stringify({
                  status: "success",
                  path: "src/generated/task-report.md",
                  changes: { path: "src/generated/task-report.md", addedLines: 12, removedLines: 3, operation: "write" },
                  displayMode: "summary_only"
                })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText(".../generated/task-report.md")).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders live long assistant streams as a bounded plain-text preview", () => {
    const longStream = `${"alpha ".repeat(2000)}middle-marker-${"beta ".repeat(2000)}tail-marker`;
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_long_live_stream",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: longStream,
              payload: { streamId: "stream_long_live", delta: longStream }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText(/Live preview:/)).toBeInTheDocument();
    expect(screen.getByText(/tail-marker/)).toBeInTheDocument();
    expect(screen.queryByText(/middle-marker/)).not.toBeInTheDocument();
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

  it("normalizes broken CJK spacing inside thinking cards for display", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_spaced_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "用户 打招呼 “ 你好啊 ”。这是 一个 简单的 问候 。",
              payload: {
                streamId: "stream_spaced_thinking",
                delta: "用户 打招呼 “ 你好啊 ”。这是 一个 简单的 问候 。"
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getAllByText("用户打招呼“你好啊”。这是一个简单的问候。").length).toBeGreaterThan(0);
  });

  it("coalesces streamed thinking chunks into one card without artificial line breaks", async () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_thinking_chunk_1",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "用户 ",
              payload: { streamId: "stream_chunked_thinking", delta: "用户 " }
            },
            {
              id: "event_thinking_chunk_2",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "打招呼 “ ",
              payload: { streamId: "stream_chunked_thinking", delta: "打招呼 “ " }
            },
            {
              id: "event_thinking_chunk_3",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "你好啊 ”。这是 ",
              payload: { streamId: "stream_chunked_thinking", delta: "你好啊 ”。这是 " }
            },
            {
              id: "event_thinking_chunk_4",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "一个 简单的 问候 。",
              payload: { streamId: "stream_chunked_thinking", delta: "一个 简单的 问候 。" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelectorAll(".thinkingDetails")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    await waitFor(() => {
      expect(container.querySelector(".thinkingBodyText")).not.toBeNull();
    });
    expect(container.querySelector(".thinkingBodyText")?.textContent).toBe("用户打招呼“你好啊”。这是一个简单的问候。");
  });

  it("does not mount the thinking body until the card is expanded", async () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_lazy_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "Line one.\nLine two.\nLine three.",
              payload: {
                streamId: "stream_lazy_thinking",
                delta: "Line one.\nLine two.\nLine three."
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelector(".thinkingBody .markdownText, .thinkingBodyText")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    await waitFor(() => {
      expect(container.querySelector(".thinkingBody .markdownText, .thinkingBodyText")).not.toBeNull();
    });
  });

  it("renders very large thinking bodies as plain text to avoid heavy markdown parsing", async () => {
    const longThinking = Array.from({ length: 140 }, (_, index) => `Step ${index + 1}: inspect another part of the workspace.`).join("\n");
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_large_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: longThinking,
              payload: {
                streamId: "stream_large_thinking",
                delta: longThinking
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    await waitFor(() => {
      expect(container.querySelector(".thinkingBodyText")).not.toBeNull();
    });
    expect(container.querySelector(".thinkingBody .markdownText")).toBeNull();
  });

  it("loads the full thinking body on demand when the transcript only ships a lazy preview", async () => {
    const onLoadStreamText = vi.fn().mockResolvedValue("Line 1: inspect the structure.\nLine 2: summarize the visible issues.");
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_lazy_transcript_preview",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "Line 1: inspect the structure.\n\n[Output truncated: 6400 characters omitted. Full evidence is available in the audit log.]",
              payload: {
                streamId: "stream_lazy_preview",
                delta: "Line 1: inspect the structure.\n\n[Output truncated: 6400 characters omitted. Full evidence is available in the audit log.]",
                lazyBody: true,
                fullContentChars: 7000
              }
            }
          ]
        }}
        onLoadStreamText={onLoadStreamText}
        onApprovalDecision={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    await waitFor(() => {
      expect(onLoadStreamText).toHaveBeenCalledWith("task_1", "stream_lazy_preview", "thinking_delta");
    });
    expect(await screen.findByText(/Line 2: summarize the visible issues\./)).toBeInTheDocument();
  });

  it("keeps assistant body visible when final stream text is stripped", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_delta_body",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "I will read the project and then optimize the styles.",
              payload: { streamId: "stream_final_empty", delta: "I will read the project and then optimize the styles." }
            },
            {
              id: "event_final_empty",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: "2026-01-01T00:00:00.010Z",
              summary: "Tool evidence returned.",
              payload: { streamId: "stream_final_empty" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("I will read the project and then optimize the styles.")).toBeInTheDocument();
    expect(screen.queryByText("Tool evidence returned.")).not.toBeInTheDocument();
  });

  it("keeps thinking visible after the same stream receives a final assistant message", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_thinking_before_final",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "I should inspect the current layout before answering.",
              payload: { streamId: "stream_keep_thinking", delta: "I should inspect the current layout before answering." }
            },
            {
              id: "event_delta_before_final",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: "2026-01-01T00:00:00.005Z",
              summary: "I will review the layout now.",
              payload: { streamId: "stream_keep_thinking", delta: "I will review the layout now." }
            },
            {
              id: "event_final_keep_thinking",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: "2026-01-01T00:00:00.010Z",
              summary: "I will review the layout now.",
              payload: { streamId: "stream_keep_thinking" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getAllByText("I should inspect the current layout before answering.").length).toBeGreaterThan(0);
    expect(screen.getByText("I will review the layout now.")).toBeInTheDocument();
  });

  it("keeps assistant body visible when final text only exists in payload", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_final_payload_body",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: "2026-01-01T00:00:00.010Z",
              summary: "Tool evidence returned.",
              payload: {
                streamId: "stream_payload_body",
                message: "Tool evidence returned.\n\n我已经读完当前结构，接下来会优化样式。"
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("我已经读完当前结构，接下来会优化样式。")).toBeInTheDocument();
    expect(screen.queryByText("Tool evidence returned.")).not.toBeInTheDocument();
  });

  it("keeps readable final text when provider leaks inline tool markup", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_delta_before_tool_markup",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "我会先阅读项目代码，再调整界面层级。",
              payload: { streamId: "stream_tool_markup_final", delta: "我会先阅读项目代码，再调整界面层级。" }
            },
            {
              id: "event_final_tool_markup",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: "2026-01-01T00:00:00.010Z",
              summary:
                '我会先阅读项目代码，再调整界面层级。\n\n<function_calls><invoke name="read_file"><parameter name="path">index.html</parameter></invoke></function_calls>',
              payload: { streamId: "stream_tool_markup_final" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("我会先阅读项目代码，再调整界面层级。")).toBeInTheDocument();
    expect(screen.queryByText(/function_calls|read_file/)).not.toBeInTheDocument();
  });

  it("does not strip literal tool-like markup from user messages", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_user_xml_example",
              taskId: "task_1",
              type: "user_message",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: '请解释这个示例：<invoke name="demo"><parameter name="x">1</parameter></invoke>',
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText(/<invoke name="demo">/)).toBeInTheDocument();
  });

  it("drops empty realtime assistant finals after boilerplate cleanup", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "event_empty_final",
        taskId: "task_1",
        type: "assistant_message",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "Tool evidence returned.",
        payload: { streamId: "stream_empty_final" }
      }
    ]);

    expect(transcript).toHaveLength(0);
  });

  it("keeps model empty-response notices in the client transcript", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "event_empty_response_retry",
        taskId: "task_1",
        type: "model_empty_response",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "Model returned no displayable content; retrying once.",
        payload: { status: "retrying", reason: "empty completion" }
      }
    ]);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.type).toBe("model_empty_response");
  });

  it("keeps requested tools in the client transcript so queued work is visible", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "event_requested_tool",
        taskId: "task_1",
        type: "tool_requested",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "edit_file",
        payload: {
          toolCallId: "tool_call_requested",
          toolName: "edit_file",
          args: { path: "src/App.tsx" },
          riskCategory: "workspace_write"
        }
      }
    ]);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.type).toBe("tool_requested");
  });

  it("keeps thinking transcript items after a same-stream assistant final arrives", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "event_transcript_thinking",
        taskId: "task_1",
        type: "thinking_delta",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "I should inspect the current layout before answering.",
        payload: { streamId: "stream_transcript_keep_thinking", delta: "I should inspect the current layout before answering." }
      },
      {
        id: "event_transcript_delta",
        taskId: "task_1",
        type: "assistant_delta",
        createdAt: "2026-01-01T00:00:00.005Z",
        summary: "I will review the layout now.",
        payload: { streamId: "stream_transcript_keep_thinking", delta: "I will review the layout now." }
      },
      {
        id: "event_transcript_final",
        taskId: "task_1",
        type: "assistant_message",
        createdAt: "2026-01-01T00:00:00.010Z",
        summary: "I will review the layout now.",
        payload: { streamId: "stream_transcript_keep_thinking" }
      }
    ]);

    expect(transcript.map((event) => event.id)).toContain("event_transcript_thinking");
    expect(transcript.map((event) => event.id)).not.toContain("event_transcript_delta");
    expect(transcript.map((event) => event.id)).toContain("event_transcript_final");
  });

  it("does not render empty assistant final cards after boilerplate cleanup", () => {
    const { container } = render(
      <Timeline
        task={{
          ...task,
          status: "completed",
          events: [
            {
              id: "event_empty_assistant_final",
              taskId: "task_1",
              type: "assistant_message",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: "Tool evidence returned.",
              payload: {}
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(container.querySelector(".event.assistant_message")).toBeNull();
  });

  it("renders read-only no-progress guard events in the timeline", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "paused",
          events: [
            {
              id: "event_no_progress",
              taskId: "task_1",
              type: "model_no_progress",
              createdAt: "2026-01-01T00:00:00.010Z",
              summary: "Task paused after repeated read-only exploration.",
              payload: {
                reason: "repeated_target",
                readOnlyToolCount: 16,
                repeatedTargetCount: 9,
                lastToolNames: ["read_file", "search_files", "read_file"]
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText(/Task paused: repeated read-only exploration stopped making progress/)).toBeInTheDocument();
    expect(screen.getByText(/16 read-only calls/)).toBeInTheDocument();
  });

  it("keeps latin streaming assistant chunks readable when provider omits spaces", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_delta_latin_1",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: "Let",
              payload: { streamId: "stream_latin", delta: "Let" }
            },
            {
              id: "event_delta_latin_2",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: "me",
              payload: { streamId: "stream_latin", delta: "me" }
            },
            {
              id: "event_delta_latin_3",
              taskId: "task_1",
              type: "assistant_delta",
              createdAt: new Date().toISOString(),
              summary: "search",
              payload: { streamId: "stream_latin", delta: "search" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("Let me search")).toBeInTheDocument();
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

    expect(screen.getByLabelText("Thinking...")).toBeInTheDocument();
    expect(container.querySelector(".event.running_status .thinkingDots")).not.toBeNull();
  });

  it("coalesces burst streaming deltas before rendering transcript state", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "event_delta_0",
        taskId: "task_1",
        type: "assistant_delta",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "chunk-0",
        payload: { streamId: "stream_fast", delta: "chunk-0" }
      },
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
    ]);

    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.summary).toBe("chunk-0 chunk-1 chunk-2");
    expect(transcript[0]?.payload["delta"]).toBe("chunk-0 chunk-1 chunk-2");
    expect(transcript[1]?.type).toBe("tool_result");
  });

  it("coalesces long thinking bursts into a single transcript stream entry", () => {
    const transcript = compactTaskEventsForTranscript([
      {
        id: "thinking_chunk_1",
        taskId: "task_1",
        type: "thinking_delta",
        createdAt: "2026-01-01T00:00:00.000Z",
        summary: "Inspecting the first file.",
        payload: { streamId: "thinking_stream", delta: "Inspecting the first file." }
      },
      {
        id: "thinking_chunk_2",
        taskId: "task_1",
        type: "thinking_delta",
        createdAt: "2026-01-01T00:00:00.010Z",
        summary: "Inspecting the second file.",
        payload: { streamId: "thinking_stream", delta: "Inspecting the second file." }
      },
      {
        id: "thinking_chunk_3",
        taskId: "task_1",
        type: "thinking_delta",
        createdAt: "2026-01-01T00:00:00.020Z",
        summary: "Summarizing the visible layout issues.",
        payload: { streamId: "thinking_stream", delta: "Summarizing the visible layout issues." }
      }
    ]);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.type).toBe("thinking_delta");
    expect(transcript[0]?.payload["delta"]).toBe(
      "Inspecting the first file. Inspecting the second file. Summarizing the visible layout issues."
    );
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

  it("keeps copy actions visible on the latest assistant body even when status items follow", () => {
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
    expect(container.querySelector(".event.assistant_message .messageActions")).toHaveClass("alwaysVisible");
  });

  it("keeps thinking cards visible when tool events follow before any final assistant message", () => {
    render(
      <Timeline
        task={{
          ...task,
          status: "running",
          events: [
            {
              id: "event_user_live_think",
              taskId: "task_1",
              type: "user_message",
              createdAt: new Date().toISOString(),
              summary: "Read the project and then optimize the styles.",
              payload: {}
            },
            {
              id: "event_live_thinking",
              taskId: "task_1",
              type: "thinking_delta",
              createdAt: new Date().toISOString(),
              summary: "I should inspect the entry file before making styling changes.",
              payload: {
                streamId: "stream_live_think",
                delta: "I should inspect the entry file before making styling changes."
              }
            },
            {
              id: "event_live_tool_started",
              taskId: "task_1",
              type: "tool_started",
              createdAt: new Date().toISOString(),
              summary: "read_file started",
              payload: {
                toolCallId: "tool_read_entry",
                toolName: "read_file",
                args: { path: "index.html" }
              }
            },
            {
              id: "event_live_tool_result",
              taskId: "task_1",
              type: "tool_result",
              createdAt: new Date().toISOString(),
              summary: "read_file completed",
              payload: {
                toolCallId: "tool_read_entry",
                toolName: "read_file",
                ok: true,
                output: JSON.stringify({ summary: "Read index.html", path: "index.html" })
              }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getAllByText(/I should inspect the entry file before making styling changes\./).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /index\.html/ })).toBeInTheDocument();
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

  it("renders ask-user options as clickable buttons and answers with the selected option", () => {
    const onAnswerUserInput = vi.fn();
    render(
      <Timeline
        task={{
          ...task,
          status: "waiting_for_user",
          events: [
            {
              id: "event_user_input",
              taskId: "task_test",
              type: "user_input_requested",
              createdAt: new Date().toISOString(),
              summary: "Choose how to continue.",
              payload: { options: ["Option A", "Option B"], status: "pending" }
            }
          ]
        }}
        onApprovalDecision={vi.fn()}
        onAnswerUserInput={onAnswerUserInput}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Option B" }));
    expect(onAnswerUserInput).toHaveBeenCalledWith("Option B");
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
    const onMode = vi.fn();
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
      permissionMode: "ask",
      autoApprove: "none",
      autoApproveStrategy: "ask",
      autoApproveRiskCategories: [],
      llmApprovalMode: "off",
      showThinking: true,
      language: "zh-CN",
      theme: "dark",
      agentTone: "balanced",
      agentRole: "Pragmatic engineering assistant",
      responseDetail: "normal",
      skillAutoInject: true,
      maxInjectedSkills: 3,
      knowledgeActiveInjection: true,
      maxInjectedKnowledgeItems: 3,
      knowledgeFastTextVectorPath: undefined,
      knowledgeTinyRerankerEnabled: false,
      knowledgeTinyRerankerModelPath: undefined,
      knowledgeTinyRerankerVocabPath: undefined,
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
        onPermissionModeChange={onMode}
        onPreference={onPreference}
      />
    );

    expect(screen.getByRole("heading", { name: "权限审批" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置为 Ask" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /自定义/ }));
    fireEvent.click(screen.getByLabelText("取消 主机观察"));
    expect(onMode).toHaveBeenCalledWith("custom", []);
    fireEvent.click(screen.getByRole("radio", { name: /只读/ }));
    expect(onMode).toHaveBeenCalledWith("read_only", ["host_observation", "workspace_read"]);
    fireEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    const fullAccessDialog = screen.getByRole("dialog", { name: "确认完全访问" });
    expect(fullAccessDialog).toBeInTheDocument();
    fireEvent.click(within(fullAccessDialog).getByText("取消"));
    fireEvent.click(screen.getByRole("radio", { name: /自动审批/ }));
    expect(onMode).toHaveBeenCalledWith("auto_approval", ["host_observation", "workspace_read", "network"]);
    fireEvent.click(screen.getByLabelText("LLM 自动审批（实验）"));
    fireEvent.click(screen.getByRole("option", { name: "仅非破坏性" }));
    expect(onPreference).toHaveBeenCalledWith(expect.objectContaining({ llmApprovalMode: "non_destructive" }));

    rerender(
      <PermissionsPanel
        language="zh-CN"
        permissions={[grant]}
        preferences={preferences}
        preferencesOnly={true}
        onPermissionModeChange={onMode}
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
      title: "Skill Curator maintenance",
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
    const onReindex = vi.fn().mockResolvedValue(undefined);
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
    const onSearch = vi.fn().mockResolvedValue([
      {
        item,
        chunk: {
          id: "knowledge_chunk_1",
          knowledgeId: item.id,
          projectId: "default",
          ordinal: 0,
          title: item.title,
          content: item.content,
          tokenEstimate: 12,
          tags: item.tags,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        },
        score: 0.86,
        matchedFields: ["title", "content"],
        highlights: [{ field: "content", text: "Use approvals for runtime changes." }],
        rankReason: "Matched title, content; lexical score 0.86.",
        rerankStatus: "applied",
        rerankScore: 0.9
      }
    ]);

    render(
      <KnowledgePanel
        items={[item]}
        language="en-US"
        onCreate={onCreate}
        onDelete={onDelete}
        onReindex={onReindex}
        onSearch={onSearch}
        onUpdate={onUpdate}
        onUpload={vi.fn()}
      />
    );

    expect(screen.getAllByText("Runtime notes").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Runtime" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search test"), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "approval" })));
    await waitFor(() => expect(screen.getAllByText("content").length).toBeGreaterThan(0));
    expect(screen.getByText(/Local structured|lexical score/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select item Runtime notes"));
    fireEvent.click(screen.getByText("Reindex selected"));
    await waitFor(() => expect(onReindex).toHaveBeenCalledWith("knowledge_1"));
    fireEvent.click(screen.getByLabelText("Select item Runtime notes"));
    fireEvent.click(screen.getByText("Delete selected"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete selected knowledge items?" })).getByRole("button", { name: "Delete selected" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("knowledge_1"));
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

  it("downloads local knowledge model assets and updates model preferences", async () => {
    const now = new Date().toISOString();
    const preferences = defaultPreferences("en-US");
    const onPreference = vi.fn().mockResolvedValue(undefined);
    const onLoadModels = vi.fn().mockResolvedValue({
      assets: [
        { kind: "fasttext_vectors", label: "fastText vectors", exists: false, configured: false },
        { kind: "tiny_reranker_model", label: "Tiny reranker ONNX", exists: true, configured: true, path: "D:/models/tiny.onnx" },
        { kind: "tiny_reranker_vocab", label: "Tiny reranker vocab", exists: true, configured: true, path: "D:/models/vocab.txt" }
      ],
      presets: [],
      tinyRerankerEnabled: false
    });
    const onDownloadModel = vi.fn().mockResolvedValue({
      asset: {
        kind: "fasttext_vectors",
        label: "fastText vectors",
        exists: true,
        configured: true,
        path: "D:/models/mini.vec",
        size: 30,
        updatedAt: now
      },
      preferences: {
        ...preferences,
        knowledgeFastTextVectorPath: "D:/models/mini.vec"
      }
    });

    render(
      <KnowledgePanel
        items={[]}
        language="en-US"
        preferences={preferences}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onDownloadModel={onDownloadModel}
        onLoadModels={onLoadModels}
        onPreference={onPreference}
        onUpdate={vi.fn()}
        onUpload={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("Local small models")).toBeInTheDocument());
    expect(await screen.findByText("Tiny reranker ONNX")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Model download URL"), { target: { value: "https://example.test/mini.vec" } });
    fireEvent.click(screen.getByRole("button", { name: "Download and configure" }));
    await waitFor(() =>
      expect(onDownloadModel).toHaveBeenCalledWith({
        kind: "fasttext_vectors",
        url: "https://example.test/mini.vec"
      })
    );
    await waitFor(() => expect(screen.getByText("D:/models/mini.vec · 30 B")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Enable Tiny ONNX reranker"));
    expect(onPreference).toHaveBeenCalledWith({ knowledgeTinyRerankerEnabled: true });
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
        onOpenDocs={vi.fn()}
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

    fireEvent.click(screen.getByRole("button", { name: "Add integration" }));
    fireEvent.click(screen.getByLabelText("Provider"));
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.getByText("Telegram")).toBeInTheDocument();
    expect(screen.getByText("WeCom")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Slack"));
    const addIntegrationForm = screen.getByRole("form", { name: "Add integration" });
    expect(
      within(addIntegrationForm).getAllByText(/Events API and URL verification/i).length
    ).toBeGreaterThan(0);
    fireEvent.click(within(addIntegrationForm).getByRole("button", { name: "×" }));

    fireEvent.click(screen.getByLabelText("Delete Discord Ops"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete integration?" })).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("integration_discord");
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

    stubAuthedFetch(async (url, init) => {
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
          url === "/api/curator/runs" ||
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
            permissionMode: "ask",
            autoApprove: "none",
            llmApprovalMode: "off",
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
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check host" } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText("Reads host state")).toBeInTheDocument();
    expect(createTask).toHaveBeenCalledWith("check host", undefined);
    fireEvent.click(screen.getByText("Allow once"));
    await waitFor(() => expect(screen.getByText("Top process: node")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "second goal" } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("/api/tasks/task_1/messages", "second goal"));
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("loads only task-shell data on the task route before opening side surfaces", async () => {
    const requests: string[] = [];
    stubAuthedFetch(async (url) => {
        requests.push(url);
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/tasks") return jsonResponse([]);
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();

    expect(requests).toEqual(expect.arrayContaining(["/health", "/api/tasks", "/api/task-folders", "/api/preferences"]));
    expect(requests).not.toEqual(expect.arrayContaining(["/api/permissions/global", "/api/model-providers"]));
    expect(requests).not.toEqual(expect.arrayContaining([
      "/api/skills",
      "/api/skill-curator",
      "/api/curator/runs",
      "/api/project-memories",
      "/api/knowledge",
      "/api/mcp/servers",
      "/api/integrations",
      "/api/scheduled-tasks",
      "/api/web-search/providers"
    ]));
  });

  it("does not immediately re-fetch transcript after creating a running task", async () => {
    const now = new Date().toISOString();
    const created: TaskDetail = {
      ...task,
      id: "task_create_once",
      title: "Cold create",
      status: "running",
      approvals: [],
      events: [
        {
          id: "event_created_goal",
          taskId: "task_create_once",
          type: "user_message",
          createdAt: now,
          summary: "帮我检查这个页面为什么首屏有点慢",
          payload: {}
        }
      ]
    };
    const requests: string[] = [];
    stubAuthedFetch(async (url, init) => {
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/tasks" && method === "POST") return jsonResponse(created);
        if (url === "/api/tasks") return jsonResponse([]);
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
        if (url === "/api/tasks/task_create_once" || url.startsWith("/api/tasks/task_create_once?")) return jsonResponse(created);
        if (url === "/api/tasks/task_create_once/transcript") return jsonResponse(created.events);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "帮我检查这个页面为什么首屏有点慢" } });
    fireEvent.click(getSendButton());

    expect(await screen.findByRole("heading", { name: "Cold create" })).toBeInTheDocument();
    expect(requests.filter((entry) => entry.includes("/api/tasks/task_create_once/transcript"))).toHaveLength(0);
    expect(requests.filter((entry) => entry.includes("/api/tasks/task_create_once?eventLimit=") || entry.endsWith(" /api/tasks/task_create_once"))).toHaveLength(1);
  });

  it("uses WebSocket as the live transcript transport and keeps polling as a fallback", async () => {
    const now = new Date("2026-05-17T10:00:00.000Z").toISOString();
    const later = new Date("2026-05-17T10:00:01.000Z").toISOString();
    const runningTask: TaskDetail = {
      ...task,
      id: "task_polling_transport",
      title: "Polling transport",
      status: "running",
      approvals: [],
      updatedAt: now,
      events: [
        {
          id: "event_polling_user",
          taskId: "task_polling_transport",
          type: "user_message",
          createdAt: now,
          summary: "持续显示修改进度",
          payload: {}
        }
      ]
    };
    const syncedTask: TaskDetail = { ...runningTask, updatedAt: later };
    const syncedTranscript: TaskEvent[] = [
      ...runningTask.events,
      {
        id: "event_polling_delta",
        taskId: "task_polling_transport",
        type: "assistant_delta",
        createdAt: later,
        summary: "已同步文件变化：+12 -3",
        payload: { streamId: "stream_polling_transport", delta: "已同步文件变化：+12 -3" }
      },
      {
        id: "event_polling_empty_response",
        taskId: "task_polling_transport",
        type: "model_empty_response",
        createdAt: later,
        summary: "Model returned no displayable content; retrying once.",
        payload: { status: "retrying", reason: "empty completion" }
      }
    ];
    const webSockets: Array<{
      url: string;
      readyState: number;
      close: ReturnType<typeof vi.fn>;
      onopen: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: Event) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
    }> = [];
    const webSocketConstructor = vi.fn((url: string) => {
      const socket = {
        url,
        readyState: 1,
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null
      };
      webSockets.push(socket);
      return socket;
    });
    const requests: string[] = [];
    vi.stubGlobal("WebSocket", webSocketConstructor);
    stubAuthedFetch(async (url) => {
        requests.push(url);
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/tasks") return jsonResponse([runningTask]);
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
        if (url === "/api/tasks/task_polling_transport" || url.startsWith("/api/tasks/task_polling_transport?")) return jsonResponse(syncedTask);
        if (url === "/api/tasks/task_polling_transport/transcript") {
          return jsonResponse(syncedTranscript);
        }
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Polling transport" })).toBeInTheDocument();
    await waitFor(() => expect(webSocketConstructor).toHaveBeenCalledOnce());
    expect(webSockets[0]?.url).toContain("/api/tasks/task_polling_transport/events/ws");
    expect(webSockets[0]?.url).toContain("session=");

    await act(async () => {
      webSockets[0]?.onopen?.(new Event("open"));
      webSockets[0]?.onmessage?.({ data: JSON.stringify({ type: "event", event: syncedTranscript[1] }) } as MessageEvent);
      webSockets[0]?.onmessage?.({ data: JSON.stringify({ type: "event", event: syncedTranscript[2] }) } as MessageEvent);
    });
    expect(await screen.findByText("已同步文件变化：+12 -3")).toBeInTheDocument();
    expect(await screen.findByText("模型本轮未返回可展示内容，正在自动重试一次。")).toBeInTheDocument();
    await act(async () => {
      webSockets[0]?.onclose?.(new CloseEvent("close"));
    });
    await waitFor(() => expect(webSocketConstructor).toHaveBeenCalledTimes(2), { timeout: 1200 });
    expect(requests.some((url) => url.includes("/events/ws"))).toBe(false);
  });

  it("batches rapid streaming transcript events and keeps long live text bounded", async () => {
    const now = new Date("2026-05-17T10:10:00.000Z").toISOString();
    const runningTask: TaskDetail = {
      ...task,
      id: "task_stream_pressure",
      title: "Stream pressure",
      status: "running",
      approvals: [],
      updatedAt: now,
      events: [
        {
          id: "event_pressure_user",
          taskId: "task_stream_pressure",
          type: "user_message",
          createdAt: now,
          summary: "快速输出大量文本",
          payload: {}
        }
      ]
    };
    const webSockets: Array<{
      url: string;
      readyState: number;
      close: ReturnType<typeof vi.fn>;
      onopen: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: Event) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
    }> = [];
    const webSocketConstructor = vi.fn((url: string) => {
      const socket = {
        url,
        readyState: 1,
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null
      };
      webSockets.push(socket);
      return socket;
    });
    vi.stubGlobal("WebSocket", webSocketConstructor);
    stubAuthedFetch(async (url) => {
        if (url === "/health") return jsonResponse({ ok: true });
        if (url === "/api/tasks") return jsonResponse([runningTask]);
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
        if (url === "/api/tasks/task_stream_pressure" || url.startsWith("/api/tasks/task_stream_pressure?")) return jsonResponse(runningTask);
        if (url === "/api/tasks/task_stream_pressure/transcript") return jsonResponse(runningTask.events);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Stream pressure" })).toBeInTheDocument();
    await waitFor(() => expect(webSocketConstructor).toHaveBeenCalledOnce());

    const deltas = Array.from({ length: 360 }, (_, index) => {
      const marker = index === 180 ? " OMITTED-MIDDLE-MARKER " : index === 359 ? " VISIBLE-TAIL-MARKER " : "";
      const delta = `${marker}chunk-${index.toString().padStart(3, "0")}-${"x".repeat(80)}\n`;
      return {
        id: `event_pressure_delta_${index}`,
        taskId: "task_stream_pressure",
        type: "assistant_delta" as const,
        createdAt: now,
        summary: delta,
        payload: { streamId: "stream_pressure", delta }
      };
    });

    await act(async () => {
      webSockets[0]?.onopen?.(new Event("open"));
      for (const event of deltas) {
        webSockets[0]?.onmessage?.({ data: JSON.stringify({ type: "event", event }) } as MessageEvent);
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(await screen.findByText(/VISIBLE-TAIL-MARKER/)).toBeInTheDocument();
    expect(screen.queryByText(/OMITTED-MIDDLE-MARKER/)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".event.assistant_delta")).toHaveLength(1);
    expect(container.querySelector(".timelineLongText.live")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "still responsive" } });
    expect(screen.getByLabelText("Task input")).toHaveValue("still responsive");
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

    stubAuthedFetch(async (url, init) => {
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
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "帮我检查这个项目为什么慢" } });
    await waitFor(() => expect(screen.getByLabelText("发送")).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("发送"));

    expect(await screen.findByRole("heading", { name: "Long output" })).toBeInTheDocument();
    expect(screen.getByLabelText("思考中...")).toBeInTheDocument();
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

    stubAuthedFetch(async (url, init) => {
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
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Choose permission scope"));
    fireEvent.click(screen.getByText("Read only"));
    await waitFor(() => expect(grantCalls).toEqual(["host_observation"]));

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check this folder" } });
    await waitFor(() => expect(getSendButton()).not.toBeDisabled());
    fireEvent.click(getSendButton());
    expect(createCalls).toHaveLength(0);

    releasePermissionMutation();
    await waitFor(() => expect(grantCalls).toEqual(["host_observation", "workspace_read"]));
    await waitFor(() => expect(createCalls).toEqual(["check this folder"]));
  });

  it("requires an explicit permission preset before starting goal mode with non-destructive max", async () => {
    const now = new Date().toISOString();
    const created: TaskDetail = {
      ...task,
      id: "task_target",
      title: "Goal run",
      status: "running",
      runMode: "target",
      targetLimits: { maxModelTurns: 160, maxToolCalls: 500, maxWallTimeMs: 14_400_000 },
      approvals: [],
      events: []
    };
    const grants: GlobalPermissionGrant[] = [];
    const grantCalls: RiskCategory[] = [];
    const createBodies: Array<{ goal: string; runMode?: string }> = [];
    const preferencePatches: Array<Record<string, unknown>> = [];
    let preferences = defaultPreferences("en-US");

    stubAuthedFetch(async (url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences" && method === "PATCH") {
          const patch = JSON.parse(String(init?.body)) as Partial<UserPreferences>;
          preferencePatches.push(patch as Record<string, unknown>);
          preferences = { ...preferences, ...patch, updatedAt: now };
          return jsonResponse(preferences);
        }
        if (url === "/api/preferences") return jsonResponse(preferences);
        if (url === "/api/permissions/global" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { riskCategory: RiskCategory };
          grantCalls.push(body.riskCategory);
          const grant: GlobalPermissionGrant = {
            id: `grant_${body.riskCategory}`,
            riskCategory: body.riskCategory,
            reason: "target test",
            grantedBy: "test",
            grantedAt: now
          };
          grants.push(grant);
          return jsonResponse(grant);
        }
        if (url === "/api/permissions/global") return jsonResponse(grants);
        if (url === "/api/tasks" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { goal: string; runMode?: string };
          createBodies.push(body);
          return jsonResponse({
            ...created,
            events: [{ id: "event_target", taskId: created.id, type: "user_message", createdAt: now, summary: body.goal, payload: {} }]
          });
        }
        if (url === "/api/tasks") return jsonResponse(createBodies.length ? [created] : []);
        if (url === "/api/tasks/task_target" || url.startsWith("/api/tasks/task_target?")) return jsonResponse(created);
        if (url === "/api/tasks/task_target/transcript") return jsonResponse(created.events);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "/goal repair the failing check" } });
    fireEvent.click(getSendButton());

    const dialog = await screen.findByRole("dialog", { name: "Start /goal" });
    expect(createBodies).toHaveLength(0);
    expect(within(dialog).getByText(/spend more model quota|more quota/i)).toBeInTheDocument();
    const startButton = within(dialog).getByRole("button", { name: "Start goal mode" });
    expect(startButton).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("radio", { name: /Non-destructive max/ }));
    await waitFor(() => expect(startButton).not.toBeDisabled());
    fireEvent.click(startButton);

    await waitFor(() => expect(preferencePatches).toEqual([
      expect.objectContaining({
        permissionMode: "auto_approval",
        autoApproveRiskCategories: ["host_observation", "workspace_read", "workspace_write", "shell", "network"]
      })
    ]));
    expect(grantCalls).not.toContain("destructive");
    await waitFor(() => expect(createBodies).toEqual([expect.objectContaining({ goal: "repair the failing check", runMode: "target" })]));
    expect(await screen.findByText(/Goal mode/)).toBeInTheDocument();
    expect(screen.getByText(/Non-destructive max/)).toBeInTheDocument();
  });

  it("does not start removed target command and points users to goal", async () => {
    stubAuthedFetch(async (url) => {
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences") return jsonResponse(defaultPreferences("en-US"));
        if (url === "/api/tasks") return jsonResponse([]);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "/target repair the failing check" } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText(/\/target command has been removed/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Start \/goal/ })).not.toBeInTheDocument();
  });

  it("requires an extra acknowledgement before full risk goal mode", async () => {
    const now = new Date().toISOString();
    const created: TaskDetail = {
      ...task,
      id: "task_goal_full_risk",
      title: "Goal full risk",
      status: "running",
      runMode: "target",
      targetLimits: { maxModelTurns: 160, maxToolCalls: 500, maxWallTimeMs: 14_400_000 },
      approvals: [],
      events: []
    };
    const grants: GlobalPermissionGrant[] = [];
    const grantCalls: RiskCategory[] = [];
    const createBodies: Array<{ goal: string; runMode?: string }> = [];
    let preferences = defaultPreferences("en-US");

    stubAuthedFetch(async (url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/task-folders") return jsonResponse(defaultFolders());
        if (url === "/api/preferences" && method === "PATCH") {
          const patch = JSON.parse(String(init?.body)) as Partial<UserPreferences>;
          preferences = { ...preferences, ...patch, updatedAt: now };
          return jsonResponse(preferences);
        }
        if (url === "/api/preferences") return jsonResponse(preferences);
        if (url === "/api/permissions/global" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { riskCategory: RiskCategory };
          grantCalls.push(body.riskCategory);
          const grant: GlobalPermissionGrant = { id: `grant_${body.riskCategory}`, riskCategory: body.riskCategory, reason: "goal full risk", grantedBy: "test", grantedAt: now };
          grants.push(grant);
          return jsonResponse(grant);
        }
        if (url === "/api/permissions/global") return jsonResponse(grants);
        if (url === "/api/tasks" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { goal: string; runMode?: string };
          createBodies.push(body);
          return jsonResponse({ ...created, events: [{ id: "event_goal_full_risk", taskId: created.id, type: "user_message", createdAt: now, summary: body.goal, payload: {} }] });
        }
        if (url === "/api/tasks") return jsonResponse(createBodies.length ? [created] : []);
        if (url === "/api/tasks/task_goal_full_risk" || url.startsWith("/api/tasks/task_goal_full_risk?")) return jsonResponse(created);
        if (url === "/api/tasks/task_goal_full_risk/transcript") return jsonResponse(created.events);
        if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
        return jsonResponse([]);
      });

    render(<App />);
    expect(await screen.findByLabelText("Task input")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "/goal repair with full access" } });
    fireEvent.click(getSendButton());

    const dialog = await screen.findByRole("dialog", { name: "Start /goal" });
    const startButton = within(dialog).getByRole("button", { name: "Start goal mode" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Full risk/ }));
    expect(startButton).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /globally allows destructive/i }));
    await waitFor(() => expect(startButton).not.toBeDisabled());
    fireEvent.click(startButton);

    await waitFor(() => expect(grantCalls).toEqual(["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"]));
    await waitFor(() => expect(createBodies).toEqual([expect.objectContaining({ goal: "repair with full access", runMode: "target" })]));
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
          summary: "Original goal: should not appear in transcript\n[UI preview truncated: 123 characters omitted. Full evidence is retained by Agent Workbench.]"
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

    stubAuthedFetch(async (url) => {
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
          url === "/api/curator/runs" ||
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
            permissionMode: "ask",
            autoApprove: "none",
            llmApprovalMode: "off",
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
      });

    render(<App />);

    expect(await screen.findByText(/完整用户原始需求/)).toBeInTheDocument();
    expect(screen.getByText(/我已经创建 styles.css 和 script.js/)).toBeInTheDocument();
    expect(screen.getByText("Tail-only event from the audit window")).toBeInTheDocument();
    expect(screen.queryByText(/Original goal|UI preview truncated/)).not.toBeInTheDocument();
  });

  it("moves governance surfaces into settings", async () => {
    const requests: string[] = [];
    stubAuthedFetch(async (url) => {
        requests.push(url);
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
          url === "/api/curator/runs" ||
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
            permissionMode: "ask",
            autoApprove: "none",
            llmApprovalMode: "off",
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
      });

    render(<App />);
    expect(await screen.findByText("New Task")).toBeInTheDocument();
    expect(requests).not.toContain("/api/model-providers");
    fireEvent.click(await screen.findByText("Settings"));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(requests).toContain("/api/model-providers"));
    expect(window.location.pathname).toBe("/settings/providers");
    fireEvent.click(screen.getByText("Permissions"));
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/permissions");
    fireEvent.click(screen.getByText("Scheduled tasks"));
    expect(await screen.findByRole("heading", { name: "Scheduled tasks" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/scheduled");
    fireEvent.click(screen.getByText("Web search"));
    expect(await screen.findByRole("heading", { name: "Web search" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/search");
  });

  it("opens section-specific docs from settings primers and returns to the same settings section", async () => {
    const requests: string[] = [];
    stubAuthedFetch(async (url) => {
      requests.push(url);
      if (url === "/api/task-folders") return jsonResponse(defaultFolders());
      if (url === "/api/tasks") return jsonResponse([]);
      if (url === "/api/preferences") return jsonResponse(defaultPreferences("en-US"));
      if (
        url === "/api/model-providers" ||
        url === "/api/permissions/global" ||
        url === "/api/mcp/servers" ||
        url === "/api/mcp/tools" ||
        url === "/api/integrations" ||
        url === "/api/scheduled-tasks" ||
        url === "/api/web-search/providers" ||
        isWorkbenchCollectionEndpoint(url)
      ) {
        return jsonResponse([]);
      }
      return jsonResponse([]);
    });

    render(<App />);
    expect(await screen.findByText("New Task")).toBeInTheDocument();

    fireEvent.click(await screen.findByText("Settings"));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    await waitFor(() => expect(requests).toContain("/api/integrations"));

    fireEvent.click(screen.getByRole("button", { name: "View guide" }));
    expect(await screen.findByRole("heading", { name: "Docs" })).toBeInTheDocument();
    expect(await screen.findByText("Supported platforms")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/docs/integrations");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/integrations");
  });

  it("loads docs routes directly for a specific settings section", async () => {
    stubAuthedFetch(async (url) => {
      if (url === "/api/task-folders") return jsonResponse(defaultFolders());
      if (url === "/api/tasks") return jsonResponse([]);
      if (url === "/api/preferences") return jsonResponse(defaultPreferences("zh-CN"));
      if (isWorkbenchCollectionEndpoint(url)) return jsonResponse([]);
      return jsonResponse([]);
    });

    window.history.replaceState({}, "", "/docs/search");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "文档" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "网络搜索" }).length).toBeGreaterThan(0));
    expect(window.location.pathname).toBe("/docs/search");

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByRole("heading", { name: "Docs" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Web Search" }).length).toBeGreaterThan(0));
    expect(screen.getByText("Configure search providers for the built-in web_search tool and understand its permission boundary.")).toBeInTheDocument();
  });
});

function stubAuthedFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session/bootstrap") return jsonResponse({ sessionToken: TEST_SESSION_TOKEN });
      if (url.startsWith("/api/") && url !== "/health") {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-agent-workbench-session") ?? headers.get("x-scc-session")).toBe(TEST_SESSION_TOKEN);
      }
      return handler(url, init);
    })
  );
}

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
    permissionMode: "ask",
    autoApprove: "none",
    autoApproveStrategy: "ask",
    autoApproveRiskCategories: [],
    llmApprovalMode: "off",
    showThinking: true,
    language,
    theme: "dark",
    agentTone: "balanced",
    agentRole: "Pragmatic engineering assistant",
    responseDetail: "normal",
    skillAutoInject: true,
    maxInjectedSkills: 3,
    knowledgeActiveInjection: true,
    maxInjectedKnowledgeItems: 3,
    knowledgeFastTextVectorPath: undefined,
    knowledgeTinyRerankerEnabled: false,
    knowledgeTinyRerankerModelPath: undefined,
    knowledgeTinyRerankerVocabPath: undefined,
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
    url === "/api/curator/runs" ||
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
