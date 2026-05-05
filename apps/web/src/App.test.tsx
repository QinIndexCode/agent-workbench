// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalPermissionGrant, SkillRecord, TaskDetail, ToolApproval, UserPreferences } from "@scc/shared";
import { App } from "./App.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
import { CompactList, LearningPanel } from "./components/LearningPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { SkillPanel } from "./components/SkillPanel.js";
import { TaskList } from "./components/TaskList.js";
import { Timeline } from "./components/Timeline.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("uses a single adaptive button for send and stop", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Composer busy={false} running={true} mode="guidance" onSubmit={onSubmit} onStop={onStop} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "new guidance" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSubmit).toHaveBeenCalledWith("new guidance");
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
    render(
      <TaskList
        activeView="tasks"
        open={false}
        tasks={[task]}
        selectedId="task_1"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelect={onSelect}
      />
    );
    expect(screen.getByText("waiting approval")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Check host"));
    expect(onSelect).toHaveBeenCalledWith("task_1");
  });

  it("confirms task deletion and exposes learning cleanup choices", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskList
        activeView="tasks"
        open={false}
        tasks={[task]}
        selectedId="task_1"
        onClose={vi.fn()}
        onDelete={onDelete}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Delete task Check host"));
    expect(screen.getByText("Delete task?")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove memories and experiences from this task"));
    fireEvent.click(screen.getByLabelText("Delete skills derived only from this task"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("task_1", { deleteLearningData: true, deleteDerivedSkills: true }));
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
      defaultModel: "mimo-v2.5",
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

    render(
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
    fireEvent.click(screen.getByText("撤销"));
    expect(onRevoke).toHaveBeenCalledWith("host_observation");
    fireEvent.change(screen.getByLabelText("界面与回复语言"), { target: { value: "en-US" } });
    expect(onPreference).toHaveBeenCalledWith({ language: "en-US" });
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
    expect(screen.getByText("Legacy skill without stats")).toBeInTheDocument();
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
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("Mock MCP")).toBeInTheDocument();
    expect(screen.getByText("echo")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledWith("mock");
  });

  it("creates a task, resolves an approval, and starts a new task from a completed thread", async () => {
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
    const secondTask: TaskDetail = {
      ...task,
      id: "task_2",
      title: "Second task",
      status: "running",
      events: [
        {
          id: "event_second",
          taskId: "task_2",
          type: "user_message",
          createdAt: new Date().toISOString(),
          summary: "second goal",
          payload: {}
        }
      ]
    };
    let currentTasks: TaskDetail[] = [];
    const createTask = vi.fn((goal: string) => {
      if (goal === "second goal") {
        currentTasks = [secondTask, completed];
        return secondTask;
      }
      currentTasks = [created];
      return created;
    });
    const sendMessage = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/tasks" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { goal: string };
          return jsonResponse(createTask(body.goal));
        }
        if (url === "/api/tasks") return jsonResponse(currentTasks);
        if (url === "/api/tasks/task_1") return jsonResponse(currentTasks.find((item) => item.id === "task_1") ?? created);
        if (url === "/api/tasks/task_2") return jsonResponse(currentTasks.find((item) => item.id === "task_2") ?? secondTask);
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
          url === "/api/mcp/tools"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            defaultModel: "gpt-5.4-mini",
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
          sendMessage(url);
          return jsonResponse(completed);
        }
        return jsonResponse([]);
      })
    );

    render(<App />);
    expect(await screen.findByText("Start with a goal.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check host" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByText("Reads host state")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Allow once"));
    await waitFor(() => expect(screen.getByText("Top process: node")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "second goal" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith("second goal"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("moves governance surfaces into settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
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
          url === "/api/mcp/tools"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            defaultModel: "gpt-5.4-mini",
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
