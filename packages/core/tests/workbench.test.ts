import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResult } from "@scc/shared";
import { ShellToolExecutor } from "../src/tools.js";
import { AgentWorkbench, InMemoryWorkbenchStore, PermissionEngine, createExperience, createId, nowIso, promoteExperience } from "../src/index.js";

class StubToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: JSON.stringify([{ ProcessName: "node", Id: 42, CPU: 100, WorkingSet64: 1024 * 1024 * 200 }])
    };
  }
}

describe("PermissionEngine", () => {
  it("classifies Get-Process as host observation", () => {
    const engine = new PermissionEngine();
    const risk = engine.assess("run_command", { command: "Get-Process | Sort-Object CPU" });
    expect(risk.category).toBe("host_observation");
  });

  it("classifies destructive process changes separately", () => {
    const engine = new PermissionEngine();
    const risk = engine.assess("run_command", { command: "Stop-Process -Id 100" });
    expect(risk.category).toBe("destructive");
  });

  it("classifies workspace writes and network requests", () => {
    const engine = new PermissionEngine();
    expect(engine.assess("run_command", { command: "Set-Content note.txt hi" }).category).toBe("workspace_write");
    expect(engine.assess("run_command", { command: "npm install left-pad" }).category).toBe("network");
  });
});

describe("AgentWorkbench", () => {
  it("pauses host observation for approval, then resumes and records evidence", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools });

    const created = await workbench.createTask("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
    expect(created.status).toBe("waiting_approval");
    expect(created.approvals[0]?.riskCategory).toBe("host_observation");

    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");
    const completed = await workbench.decideApproval(created.id, approval.id, "allow_for_task");

    expect(completed.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
    expect(completed.events.some((event) => event.type === "tool_result")).toBe(true);
    expect(completed.events.some((event) => event.type === "assistant_message")).toBe(true);
  });

  it("keeps running user input pending until the next safe point", async () => {
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools: new StubToolExecutor() });
    const created = await workbench.createTask("check running processes");
    const guided = await workbench.appendMessage(created.id, "Focus on memory too");

    expect(guided.status).toBe("waiting_approval");
    expect(guided.pendingGuidance[0]?.summary).toBe("Focus on memory too");
  });

  it("records read-only experience as an enabled skill", async () => {
    const tools = new StubToolExecutor();
    const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools });
    const created = await workbench.createTask("check running processes");
    const approval = created.approvals[0];
    if (!approval) throw new Error("expected approval");

    await workbench.decideApproval(created.id, approval.id, "allow_for_task");

    const experiences = await workbench.listExperiences();
    const skills = await workbench.listSkills();
    expect(experiences[0]?.readOnly).toBe(true);
    expect(skills[0]?.status).toBe("enabled");
  });

  it("marks side-effect experience promotions as drafts", () => {
    const base = {
      id: "task_1",
      title: "write file",
      status: "completed" as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pendingGuidance: [],
      approvals: [],
      events: [
        {
          id: "event_1",
          taskId: "task_1",
          type: "user_message" as const,
          createdAt: nowIso(),
          summary: "write a file",
          payload: {}
        },
        {
          id: "event_2",
          taskId: "task_1",
          type: "tool_requested" as const,
          createdAt: nowIso(),
          summary: "run_command",
          payload: { toolName: "run_command", riskCategory: "workspace_write" }
        },
        {
          id: "event_3",
          taskId: "task_1",
          type: "assistant_message" as const,
          createdAt: nowIso(),
          summary: "done",
          payload: {}
        }
      ]
    };
    const experience = createExperience(base);
    expect(promoteExperience(experience).status).toBe("draft");
  });
});

describe("ShellToolExecutor", () => {
  it("runs a harmless command", async () => {
    const executor = new ShellToolExecutor();
    const result = await executor.execute({
      id: createId("tool_call"),
      toolName: "run_command",
      args: { command: "Write-Output ok" }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
  });
});
