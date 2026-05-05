import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("api client", () => {
  it("sends task and approval requests", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "task_1", status: "completed" })
    });

    await expect(api.createTask("hello")).resolves.toMatchObject({ id: "task_1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ goal: "hello" }) })
    );

    await api.decideApproval("task_1", "approval_1", "allow_once");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task_1/approvals/approval_1",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "allow_once" }) })
    );

    await api.grantGlobalPermission("host_observation", "ok");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/permissions/global",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ riskCategory: "host_observation", reason: "ok" }) })
    );
  });

  it("raises failed responses", async () => {
    fetchMock.mockResolvedValue({ ok: false, text: async () => "bad request" });
    await expect(api.listTasks()).rejects.toThrow("bad request");
  });
});
