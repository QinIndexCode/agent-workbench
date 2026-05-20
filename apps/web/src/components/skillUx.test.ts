import { describeCuratorRunNextStep, describeCuratorRunStatus, summarizeCuratorRun } from "./skillUx.js";
import { describe, expect, it } from "vitest";

describe("skillUx helpers", () => {
  it("maps internal Curator run next-step codes to user-facing copy", () => {
    expect(describeCuratorRunNextStep("skills_promoted", "zh-CN")).not.toContain("skills_promoted");
    expect(describeCuratorRunNextStep("wait_for_more_task_memories", "en")).not.toContain("wait_for_more_task_memories");
  });

  it("maps Curator run statuses to friendly labels", () => {
    expect(describeCuratorRunStatus("completed", "zh-CN")).toBe("已完成");
    expect(describeCuratorRunStatus("running", "en")).toBe("Running");
  });

  it("keeps Curator run summaries free of internal phase codes", () => {
    expect(
      summarizeCuratorRun(
        {
          id: "curator_run_1",
          createdAt: new Date().toISOString(),
          status: "completed",
          tokenUsed: 12,
          budget: 120,
          progress: {
            phase: "skill",
            nextStep: "skills_promoted",
            completedDomains: []
          }
        },
        "zh-CN"
      )
    ).not.toContain("skills_promoted");
  });
});
