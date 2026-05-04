import { describe, expect, it } from "vitest";
import { AgentWorkbench, InMemoryWorkbenchStore } from "@scc/core";
import { createApp } from "../src/server.js";
describe("server API", () => {
    it("creates a task and exposes an approval", async () => {
        const app = await createApp({
            workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
        });
        const response = await app.inject({
            method: "POST",
            url: "/api/tasks",
            payload: { goal: "check running processes" }
        });
        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.status).toBe("waiting_approval");
        expect(body.approvals[0].riskCategory).toBe("host_observation");
        await app.close();
    });
    it("rejects unknown request fields through strict schemas", async () => {
        const app = await createApp({
            workbench: new AgentWorkbench({ store: new InMemoryWorkbenchStore() })
        });
        const response = await app.inject({
            method: "POST",
            url: "/api/tasks",
            payload: { goal: "hello", unexpected: true }
        });
        expect(response.statusCode).toBe(500);
        await app.close();
    });
});
