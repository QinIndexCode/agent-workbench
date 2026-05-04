import { describe, expect, it } from "vitest";
import { AgentWorkbench, InMemoryWorkbenchStore, PermissionEngine, createId, nowIso } from "../src/index.js";
class StubToolExecutor {
    calls = [];
    async execute(call) {
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
});
describe("AgentWorkbench", () => {
    it("pauses host observation for approval, then resumes and records evidence", async () => {
        const tools = new StubToolExecutor();
        const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), tools });
        const created = await workbench.createTask("帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些");
        expect(created.status).toBe("waiting_approval");
        expect(created.approvals[0]?.riskCategory).toBe("host_observation");
        const approval = created.approvals[0];
        if (!approval)
            throw new Error("expected approval");
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
});
