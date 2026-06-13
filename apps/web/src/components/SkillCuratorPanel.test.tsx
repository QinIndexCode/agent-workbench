// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CuratorRun, SkillCuratorItem, SkillDuplicateGroup } from "@agent-workbench/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCuratorPanel } from "./SkillCuratorPanel.js";

afterEach(() => {
  cleanup();
});

function curatorItem(overrides: Partial<SkillCuratorItem>): SkillCuratorItem {
  return {
    id: "curator_item_base",
    kind: "candidate",
    title: "Candidate Skill",
    status: "candidate",
    reason: "Repeated successful task pattern.",
    recommendation: "Activate after review.",
    skillIds: ["skill_candidate"],
    memoryIds: [],
    confidence: 0.82,
    sourceTaskCount: 2,
    successRate: 0.9,
    evidence: ["2 linked successful tasks"],
    blockedReasons: [],
    dedupBasis: [],
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides
  };
}

const curatorRun: CuratorRun = {
  id: "curator_run_1",
  status: "completed",
  progress: {
    phase: "skill",
    completedDomains: ["workspace"],
    nextStep: "duplicate_review_needed"
  },
  tokenUsed: 100,
  budget: 1000,
  createdAt: "2026-05-29T00:00:00.000Z",
  completedAt: "2026-05-29T00:00:02.000Z"
};

const duplicateGroups = [
  {
    fingerprint: "shared-workflow-fingerprint",
    canonicalSkillId: "skill_dup_a",
    reason: "Same workflow intent and applicability.",
    skills: [
      {
        id: "skill_dup_a",
        title: "Duplicate A",
        body: "First reusable workflow.",
        sourceMemoryIds: [],
        applicability: {
          description: "Reusable duplicate workflow",
          requiredTools: [],
          requiredContext: [],
          exclusions: [],
          minConfidence: 0.7,
          keywords: ["duplicate"]
        },
        stats: {
          totalUses: 1,
          successUses: 1,
          failureUses: 0,
          successRate: 1,
          consecutiveFailures: 0
        },
        version: 1,
        corrections: [],
        status: "active",
        relatedPatterns: [],
        createdAt: "2026-05-29T00:00:00.000Z",
        lastUsedAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z"
      },
      {
        id: "skill_dup_b",
        title: "Duplicate B",
        body: "Second reusable workflow.",
        sourceMemoryIds: [],
        applicability: {
          description: "Reusable duplicate workflow",
          requiredTools: [],
          requiredContext: [],
          exclusions: [],
          minConfidence: 0.7,
          keywords: ["duplicate"]
        },
        stats: {
          totalUses: 1,
          successUses: 1,
          failureUses: 0,
          successRate: 1,
          consecutiveFailures: 0
        },
        version: 1,
        corrections: [],
        status: "candidate",
        relatedPatterns: [],
        createdAt: "2026-05-29T00:00:00.000Z",
        lastUsedAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z"
      }
    ]
  }
] satisfies SkillDuplicateGroup[];

describe("SkillCuratorPanel", () => {
  it("covers actionable curator rows, run history, duplicates, and low-value memory controls", async () => {
    const onActivateSkill = vi.fn();
    const onClearCuratorRuns = vi.fn();
    const onDeleteCuratorRun = vi.fn();
    const onDeleteMemory = vi.fn();
    const onMergeDuplicate = vi.fn();
    const onRunCuratorExtraction = vi.fn();
    const onSuspendSkill = vi.fn();

    render(
      <SkillCuratorPanel
        curatorRuns={[curatorRun]}
        duplicates={duplicateGroups}
        items={[
          curatorItem({
            id: "candidate_item",
            kind: "candidate",
            title: "Candidate Skill",
            skillIds: ["skill_candidate"]
          }),
          curatorItem({
            id: "active_item",
            kind: "active",
            title: "Active Skill",
            status: "active",
            skillIds: ["skill_active"]
          }),
          curatorItem({
            id: "duplicate_item",
            kind: "duplicate",
            title: "Duplicate Skill",
            status: "needs_review",
            skillIds: ["skill_dup_a", "skill_dup_b"],
            dedupBasis: ["same normalized workflow"],
            evidence: ["Duplicate A", "Duplicate B"]
          }),
          curatorItem({
            id: "low_value_item",
            kind: "low_value_memory",
            title: "Low Value Memory",
            status: "not_promoted",
            recommendation: "Keep as task memory.",
            skillIds: [],
            memoryIds: ["memory_1"],
            blockedReasons: ["Not enough repeated successful examples"]
          })
        ]}
        language="en-US"
        onActivateSkill={onActivateSkill}
        onClearCuratorRuns={onClearCuratorRuns}
        onDeleteCuratorRun={onDeleteCuratorRun}
        onDeleteMemory={onDeleteMemory}
        onMergeDuplicate={onMergeDuplicate}
        onRunCuratorExtraction={onRunCuratorExtraction}
        onSuspendSkill={onSuspendSkill}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Extract suggestions" }));
    expect(onRunCuratorExtraction).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Activate candidate skill" }));
    expect(onActivateSkill).toHaveBeenCalledWith("skill_candidate");

    fireEvent.click(screen.getByRole("button", { name: "Suspend skill" }));
    expect(onSuspendSkill).toHaveBeenCalledWith("skill_active");

    fireEvent.click(screen.getByRole("button", { name: "Merge duplicate skills" }));
    expect(onMergeDuplicate).toHaveBeenCalledWith(["skill_dup_a", "skill_dup_b"]);

    fireEvent.click(screen.getByRole("button", { name: /Delete record Extracting reusable skill candidates/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete record" }));
    await waitFor(() => expect(onDeleteCuratorRun).toHaveBeenCalledWith("curator_run_1"));

    fireEvent.click(screen.getByRole("button", { name: "Clear run history" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear run history" }));
    await waitFor(() => expect(onClearCuratorRuns).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByText("Show 1 not-promoted memories"));
    fireEvent.click(screen.getByRole("button", { name: "Delete task memory Low Value Memory" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete task memory" }));
    await waitFor(() => expect(onDeleteMemory).toHaveBeenCalledWith("memory_1"));
  });
});
