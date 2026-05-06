// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalPermissionGrant, KnowledgeItem, ModelProviderRecord, SkillRecord, TaskDetail, TaskFolderRecord, ToolApproval, UserPreferences } from "@scc/shared";
import { App } from "./App.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
import { CompactList, LearningPanel } from "./components/LearningPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { ModelProvidersPanel } from "./components/ModelProvidersPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { SkillPanel } from "./components/SkillPanel.js";
import { TaskList } from "./components/TaskList.js";
import { TaskThread } from "./components/TaskThread.js";
import { Timeline } from "./components/Timeline.js";

afterEach(() => {
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
        onClearFolder={vi.fn()}
        onCreateFolder={vi.fn()}
        onDelete={vi.fn()}
        onFolderSelect={vi.fn()}
        onOpenDocs={vi.fn()}
        onOpenLibrary={onOpenLibrary}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={onSelect}
        onUpdateFolder={vi.fn()}
      />
    );
    expect(screen.getByText("waiting approval")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Check host"));
    expect(onSelect).toHaveBeenCalledWith("task_1");
    fireEvent.click(screen.getByText("Library"));
    expect(onOpenLibrary).toHaveBeenCalledOnce();
  });

  it("renders the new task hero and fills the composer from suggestions", () => {
    const onSubmit = vi.fn();
    render(
      <TaskThread
        task={null}
        busy={false}
        error={null}
        language="en-US"
        engineStatus="running"
        preferences={null}
        modelLabel="mimo-v2.5"
        modelOptions={[{ label: "Mimo v2.5", value: "mimo-v2.5" }]}
        permissionPreset="ask"
        permissionScopeLabel="Approval"
        onModelChange={vi.fn()}
        onOpenConnect={vi.fn()}
        onOpenPermissionSettings={vi.fn()}
        onPermissionPresetChange={vi.fn()}
        onOpenTasks={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
        onRetryTitle={vi.fn()}
        onUseLocalTitle={vi.fn()}
        onApprovalDecision={vi.fn()}
      />
    );

    expect(screen.getByText("Start a new task")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Inspect system load"));
    expect(screen.getByLabelText("Task input")).toHaveValue("Show me which desktop software is running and which processes use the most CPU and memory");
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
        onClearFolder={vi.fn()}
        onCreateFolder={vi.fn()}
        onDelete={onDelete}
        onFolderSelect={vi.fn()}
        onOpenDocs={vi.fn()}
        onOpenLibrary={vi.fn()}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={vi.fn()}
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

  it("filters tasks by folder and clears folder tasks from the sidebar", async () => {
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
    const onClearFolder = vi.fn().mockResolvedValue(undefined);
    const onCreateFolder = vi.fn().mockResolvedValue(undefined);
    const onUpdateFolder = vi.fn().mockResolvedValue(undefined);
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
        onClearFolder={onClearFolder}
        onCreateFolder={onCreateFolder}
        onDelete={vi.fn()}
        onFolderSelect={onFolderSelect}
        onOpenDocs={vi.fn()}
        onOpenLibrary={vi.fn()}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSupport={vi.fn()}
        onSelect={vi.fn()}
        onUpdateFolder={onUpdateFolder}
      />
    );

    expect(screen.getByText("Task folders")).toBeInTheDocument();
    expect(screen.getByText("Ops check")).toBeInTheDocument();
    expect(screen.queryByText("Default check")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Default"));
    expect(onFolderSelect).toHaveBeenCalledWith("default");

    fireEvent.click(screen.getByLabelText("New folder"));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("Local path"), { target: { value: process.cwd() } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "New folder" })).getByRole("button", { name: "New folder" }));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith("Research", process.cwd()));

    fireEvent.click(screen.getByLabelText("Edit folder Operations"));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Ops" } });
    fireEvent.change(screen.getByLabelText("Local path"), { target: { value: process.cwd() } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit folder" })).getByRole("button", { name: "Edit folder" }));
    await waitFor(() => expect(onUpdateFolder).toHaveBeenCalledWith("folder_ops", "Ops", process.cwd()));

    fireEvent.click(screen.getByLabelText("Clear tasks Operations"));
    expect(screen.getByText("Clear this folder's tasks?")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove memories and experiences from this task"));
    fireEvent.click(screen.getByRole("button", { name: "Clear tasks" }));
    await waitFor(() => expect(onClearFolder).toHaveBeenCalledWith("folder_ops", { deleteLearningData: true, deleteDerivedSkills: false }));
  });

  it("renders user-facing timeline evidence", () => {
    render(<Timeline task={task} onApprovalDecision={vi.fn()} />);
    expect(screen.getByText("check processes")).toBeInTheDocument();
    expect(screen.getByText("View raw output")).toBeInTheDocument();
  });

  it("renders streaming assistant output and collapsible thinking", () => {
    render(
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
      reflectionEnabled: true,
      reflectionSchedule: "02:00",
      skillAutoInject: true,
      maxInjectedSkills: 3,
      mcpApprovalMode: "confirm_dangerous",
      sanitizeSensitiveData: true,
      encryptStorage: false,
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
    const createTask = vi.fn((goal: string, title: string) => {
      currentTasks = [created];
      return { ...created, title };
    });
    const sendMessage = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/task-folders") return jsonResponse([{ id: "default", name: "Default", sortOrder: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
        if (url === "/api/tasks/title" && init?.method === "POST") return jsonResponse({ title: "Check host", source: "model" });
        if (url === "/api/tasks" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { goal: string; title: string };
          return jsonResponse(createTask(body.goal, body.title));
        }
        if (url === "/api/tasks") return jsonResponse(currentTasks);
        if (url === "/api/tasks/task_1") return jsonResponse(currentTasks.find((item) => item.id === "task_1") ?? created);
        if (
          url === "/api/experiences" ||
          url === "/api/task-memories" ||
          url === "/api/patterns" ||
          url === "/api/skills" ||
          url === "/api/skills/duplicates" ||
          url === "/api/skill-conflicts" ||
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories" ||
          url === "/api/mcp/servers" ||
          url === "/api/mcp/tools" ||
          url === "/api/knowledge" ||
          url === "/api/model-providers"
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
            reflectionEnabled: true,
            reflectionSchedule: "02:00",
            skillAutoInject: true,
            maxInjectedSkills: 3,
            mcpApprovalMode: "confirm_dangerous",
            sanitizeSensitiveData: true,
            encryptStorage: false,
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
    expect(await screen.findByText("Start a new task")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check host" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByText("Reads host state")).toBeInTheDocument();
    expect(createTask).toHaveBeenCalledWith("check host", "Check host");
    fireEvent.click(screen.getByText("Allow once"));
    await waitFor(() => expect(screen.getByText("Top process: node")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "second goal" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("/api/tasks/task_1/messages", "second goal"));
    expect(createTask).toHaveBeenCalledTimes(1);
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
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories" ||
          url === "/api/mcp/servers" ||
          url === "/api/mcp/tools" ||
          url === "/api/knowledge" ||
          url === "/api/model-providers"
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
            reflectionEnabled: true,
            reflectionSchedule: "02:00",
            skillAutoInject: true,
            maxInjectedSkills: 3,
            mcpApprovalMode: "confirm_dangerous",
            sanitizeSensitiveData: true,
            encryptStorage: false,
            updatedAt: new Date().toISOString()
          });
        }
        return jsonResponse([]);
      })
    );

    render(<App />);
    fireEvent.click(await screen.findByText("Settings"));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Permissions"));
    expect(screen.getByText("Permissions and preferences")).toBeInTheDocument();
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
    text: async () => JSON.stringify(value)
  } as Response;
}
