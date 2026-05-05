// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, ToolApproval } from "@scc/shared";
import { App } from "./App.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
import { CompactList } from "./components/LearningPanel.js";
import { TaskList } from "./components/TaskList.js";
import { Timeline } from "./components/Timeline.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("uses a single adaptive button for send and stop", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Composer busy={false} running={true} onSubmit={onSubmit} onStop={onStop} />);

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
    render(<Composer busy={false} running={false} onSubmit={onSubmit} onStop={onStop} />);
    const input = screen.getByLabelText("Task input");

    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("line one");
  });

  it("does not expose stop semantics when the task is not running", () => {
    render(<Composer busy={false} running={false} onSubmit={vi.fn()} onStop={vi.fn()} />);
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
    render(<TaskList open={false} tasks={[task]} selectedId="task_1" onClose={vi.fn()} onSelect={onSelect} />);
    expect(screen.getByText("waiting approval")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Check host"));
    expect(onSelect).toHaveBeenCalledWith("task_1");
  });

  it("renders user-facing timeline evidence", () => {
    render(<Timeline task={task} />);
    expect(screen.getByText("check processes")).toBeInTheDocument();
    expect(screen.getByText("View raw output")).toBeInTheDocument();
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

  it("renders compact governance rows", () => {
    render(<CompactList title="Skills" rows={[{ id: "skill_1", label: "Host observation", meta: "active" }]} />);
    expect(screen.getByText("Host observation")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("creates a task and resolves an approval from the app shell", async () => {
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
      events: [{ ...task.events[0]!, taskId: "task_1" }]
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/tasks" && init?.method === "POST") {
          currentTasks = [created];
          return jsonResponse(created);
        }
        if (url === "/api/tasks") return jsonResponse(currentTasks);
        if (url === "/api/tasks/task_1") return jsonResponse(currentTasks[0] ?? created);
        if (
          url === "/api/experiences" ||
          url === "/api/task-memories" ||
          url === "/api/patterns" ||
          url === "/api/skills" ||
          url === "/api/permissions/global" ||
          url === "/api/reflections" ||
          url === "/api/project-memories"
        ) {
          return jsonResponse([]);
        }
        if (url === "/api/preferences") {
          return jsonResponse({
            defaultModel: "gpt-5.4-mini",
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
          });
        }
        if (url.includes("/approvals/")) {
          currentTasks = [completed];
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
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
    text: async () => JSON.stringify(value)
  } as Response;
}
