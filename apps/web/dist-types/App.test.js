import { jsx as _jsx } from "react/jsx-runtime";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, ApprovalCard, CompactList, Composer, TaskList, Timeline } from "./App.js";
afterEach(() => {
    vi.unstubAllGlobals();
});
describe("Composer", () => {
    it("uses a single adaptive button for send and stop", () => {
        const onSubmit = vi.fn();
        const onStop = vi.fn();
        render(_jsx(Composer, { busy: false, running: true, onSubmit: onSubmit, onStop: onStop }));
        expect(screen.getAllByRole("button")).toHaveLength(1);
        fireEvent.click(screen.getByLabelText("Stop"));
        expect(onStop).toHaveBeenCalledOnce();
        fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "new guidance" } });
        fireEvent.click(screen.getByLabelText("Send"));
        expect(onSubmit).toHaveBeenCalledWith("new guidance");
    });
});
describe("Workbench components", () => {
    const task = {
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
        render(_jsx(TaskList, { tasks: [task], selectedId: "task_1", onSelect: onSelect }));
        expect(screen.getByText("waiting approval")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Check host"));
        expect(onSelect).toHaveBeenCalledWith("task_1");
    });
    it("renders user-facing timeline evidence", () => {
        render(_jsx(Timeline, { task: task }));
        expect(screen.getByText("check processes")).toBeInTheDocument();
        expect(screen.getByText("node 100")).toBeInTheDocument();
    });
    it("renders approval decisions", () => {
        const approval = {
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
        render(_jsx(ApprovalCard, { approval: approval, onDecision: onDecision }));
        fireEvent.click(screen.getByText("Allow for this task"));
        expect(onDecision).toHaveBeenCalledWith("allow_for_task");
    });
    it("renders compact governance rows", () => {
        render(_jsx(CompactList, { title: "Skills", rows: [{ id: "skill_1", label: "Host observation", meta: "enabled" }] }));
        expect(screen.getByText("Host observation")).toBeInTheDocument();
        expect(screen.getByText("enabled")).toBeInTheDocument();
    });
    it("creates a task and resolves an approval from the app shell", async () => {
        const approval = {
            id: "approval_1",
            taskId: "task_1",
            riskCategory: "host_observation",
            reason: "Reads host state",
            status: "pending",
            createdAt: new Date().toISOString(),
            toolCall: { id: "tool_1", toolName: "run_command", args: { command: "Get-Process" } }
        };
        const created = {
            ...task,
            id: "task_1",
            title: "Check host",
            approvals: [approval],
            events: [{ ...task.events[0], taskId: "task_1" }]
        };
        const completed = {
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
        let currentTasks = [];
        vi.stubGlobal("fetch", vi.fn(async (input, init) => {
            const url = String(input);
            if (url === "/api/tasks" && init?.method === "POST") {
                currentTasks = [created];
                return jsonResponse(created);
            }
            if (url === "/api/tasks")
                return jsonResponse(currentTasks);
            if (url === "/api/tasks/task_1")
                return jsonResponse(currentTasks[0] ?? created);
            if (url === "/api/experiences" || url === "/api/skills")
                return jsonResponse([]);
            if (url.includes("/approvals/")) {
                currentTasks = [completed];
                return jsonResponse(completed);
            }
            return jsonResponse([]);
        }));
        render(_jsx(App, {}));
        expect(await screen.findByText("Start with a goal.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Task input"), { target: { value: "check host" } });
        fireEvent.click(screen.getByLabelText("Send"));
        expect(await screen.findByText("Reads host state")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Allow once"));
        await waitFor(() => expect(screen.getByText("Top process: node")).toBeInTheDocument());
    });
});
function jsonResponse(value) {
    return {
        ok: true,
        json: async () => value,
        text: async () => JSON.stringify(value)
    };
}
