import { describeReflectionNextStep, describeReflectionStatus, summarizeReflectionSession } from "./skillUx.js";
import { describe, expect, it } from "vitest";

describe("skillUx helpers", () => {
  it("maps internal reflection next-step codes to user-facing copy", () => {
    expect(describeReflectionNextStep("skills_promoted", "zh-CN")).not.toContain("skills_promoted");
    expect(describeReflectionNextStep("wait_for_more_task_memories", "en")).not.toContain("wait_for_more_task_memories");
  });

  it("maps reflection statuses to friendly labels", () => {
    expect(describeReflectionStatus("completed", "zh-CN")).toBe("已完成");
    expect(describeReflectionStatus("running", "en")).toBe("Running");
  });

  it("keeps reflection summaries free of internal phase codes", () => {
    expect(
      summarizeReflectionSession(
        {
          id: "reflection_1",
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
