import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskDetail } from "@agent-workbench/shared";
import {
  AgentWorkbench,
  ContextAssembler,
  createId,
  InMemoryWorkbenchStore,
  nowIso,
  ShellToolExecutor,
  type ModelClient,
  type ModelStreamHandlers,
  type ModelTurn
} from "@agent-workbench/core";

interface StressCase {
  evidence: Record<string, unknown>;
  name: string;
  status: "passed" | "failed";
}

const stressCases: StressCase[] = [];
let memoryRoot = "";
let previousMemoryRoot: string | undefined;

beforeAll(() => {
  previousMemoryRoot = process.env["AGENT_WORKBENCH_MEMORY_DIR"];
  memoryRoot = mkdtempSync(join(tmpdir(), "agent-workbench-stress-memory-root-"));
  process.env["AGENT_WORKBENCH_MEMORY_DIR"] = memoryRoot;
});

afterAll(async () => {
  const outDir = resolve("data", "test-reports", "stress");
  await mkdir(outDir, { recursive: true });
  const generatedAt = nowIso();
  await writeFile(join(outDir, "latest.json"), JSON.stringify({ generatedAt, cases: stressCases }, null, 2), "utf8");
  await writeFile(
    join(outDir, "latest.md"),
    ["# Agent Workbench Stress Report", "", `Generated: ${generatedAt}`, "", ...stressCases.map((item) => `- ${item.status === "passed" ? "PASS" : "FAIL"} ${item.name}`)].join("\n"),
    "utf8"
  );
  if (previousMemoryRoot === undefined) delete process.env["AGENT_WORKBENCH_MEMORY_DIR"];
  else process.env["AGENT_WORKBENCH_MEMORY_DIR"] = previousMemoryRoot;
  if (memoryRoot) rmSync(memoryRoot, { force: true, recursive: true });
});

describe("stress matrix", () => {
  it("reverts the latest turn, rolls back file changes, and resubmits edited text in-place", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-stress-turn-"));
    try {
      const store = new InMemoryWorkbenchStore();
      const workbench = new AgentWorkbench({ store, model: new TurnFileEditModel(), tools: new ShellToolExecutor(root) });
      const folder = await workbench.createTaskFolder({ name: "Stress root", rootPath: root });
      await workbench.grantGlobalPermission("workspace_write", "stress rollback");

      const created = await workbench.createTask("Create a stress note.", "Stress note", folder.id);
      const notePath = join(root, "stress-note.md");
      expect(created.status).toBe("completed");
      expect(readFileSync(notePath, "utf8")).toContain("original turn");

      const turns = await workbench.listTaskTurns(created.id);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.status).toBe("active");
      const reverted = await workbench.revertTaskTurn(created.id, turns[0]!.id);
      expect(reverted.draft).toContain("Create a stress note");
      expect(existsSync(notePath)).toBe(false);
      expect(reverted.task.events.some((event) => event.type === "turn_reverted")).toBe(true);

      const edited = await workbench.editTaskTurn(created.id, turns[0]!.id, { content: "Create an edited stress note." });
      expect(edited.id).toBe(created.id);
      expect((await workbench.listTasks()).map((task) => task.id)).toEqual([created.id]);
      expect(readFileSync(notePath, "utf8")).toContain("edited turn");
      expect(edited.events.some((event) => event.type === "turn_edit_submitted")).toBe(true);
      recordPass("turn revert and edit", edited, { revertedEvents: reverted.revertedEventCount });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps USER.md and project MEMORY.md bounded, isolated, and compactable", async () => {
    const root = mkdtempSync(join(tmpdir(), "scc-stress-memory-"));
    try {
      const workbench = new AgentWorkbench({ store: new InMemoryWorkbenchStore(), model: new FinalOnlyModel() });
      const folder = await workbench.createTaskFolder({ name: "Memory root", rootPath: root });
      const oversizedUser = Array.from({ length: 80 }, (_, index) => `- preference ${index}: keep responses direct and evidence based, but adapt tone to the user's scene.`).join("\n");
      const oversizedProject = Array.from({ length: 180 }, (_, index) => `- project fact ${index}: important path src/module-${index}.ts with constraint ${index % 7}.`).join("\n");

      const userDoc = await workbench.updateUserProfileDocument({ content: oversizedUser });
      const projectDoc = await workbench.updateProjectMemoryDocument(folder.id, { content: oversizedProject });
      expect(userDoc.scope).toBe("user");
      expect(userDoc.content.length).toBeLessThanOrEqual(6000);
      expect(projectDoc.scope).toBe("project");
      expect(projectDoc.content.length).toBeLessThanOrEqual(12000);
      expect(projectDoc.path).toContain("MEMORY.md");

      const compacted = await workbench.compactProjectMemoryDocument(folder.id);
      expect(compacted.document.content.length).toBeLessThanOrEqual(12000);
      expect(compacted.beforeChars).toBeGreaterThanOrEqual(compacted.afterChars);
      recordPass("memory file bounds and compaction", null, {
        userChars: userDoc.content.length,
        projectChars: projectDoc.content.length,
        compactedChars: compacted.afterChars
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("compacts long task context without dropping the active task identity", async () => {
    const store = new InMemoryWorkbenchStore();
    const assembler = new ContextAssembler(store);
    const taskId = createId("task");
    const recurringConstraint = "preserve active task identity, folder isolation, latest user constraint, file evidence, and rollback state. ".repeat(8);
    const task: TaskDetail = {
      id: taskId,
      title: "Long context stress",
      folderId: "default",
      workRoot: process.cwd(),
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvals: [],
      pendingGuidance: [],
      events: Array.from({ length: 240 }, (_, index) => ({
        id: createId("event"),
        taskId,
        type: (index % 3 === 0 ? "user_message" : index % 3 === 1 ? "assistant_message" : "tool_result") as TaskDetail["events"][number]["type"],
        createdAt: nowIso(),
        summary: `long context item ${index} with recurring project constraint ${index % 7}. ${recurringConstraint}`,
        payload: index % 3 === 2
          ? { toolName: "read_file", ok: true, args: { path: `src/file-${index}.ts` }, output: JSON.stringify({ summary: `file evidence ${index}`, excerpt: recurringConstraint }) }
          : {}
      }))
    };

    const assembled = await assembler.assemble(task, { maxTotal: 10000, reservedForResponse: 1600 });
    const summaries = await store.listConversationSummaries(task.id);
    expect(assembled.usedTokens).toBeLessThanOrEqual(10000);
    expect(assembled.input).toContain("Context Budget Notice");
    expect(assembled.input).toContain("Current Turn");
    expect(assembled.systemPrompt).toContain("Active Task Continuity");
    expect(assembled.systemPrompt).toContain("Use the role-ordered conversation");
    expect(assembled.systemPrompt).toContain(task.workRoot);
    expect(assembled.systemPrompt).not.toContain("Task title:");
    expect(summaries.length).toBeLessThanOrEqual(1);
    recordPass("long context compaction", task, {
      summaryCount: summaries.length,
      usedTokens: assembled.usedTokens
    });
  });
});

class TurnFileEditModel implements ModelClient {
  async next(task: TaskDetail, handlers?: ModelStreamHandlers): Promise<ModelTurn> {
    const activeToolResult = task.events.find((event) => event.type === "tool_result" && !event.reverted);
    if (activeToolResult) {
      handlers?.onThinkingDelta?.("Summarizing reverted-safe file change.");
      return { kind: "final", message: "The stress note was written and can be rolled back." };
    }
    const latestUser = [...task.events].reverse().find((event) => event.type === "user_message" && !event.reverted)?.summary ?? "";
    const text = latestUser.includes("edited") ? "# Stress note\n\nedited turn\n" : "# Stress note\n\noriginal turn\n";
    return {
      kind: "tool_calls",
      calls: [
        {
          id: createId("tool_call"),
          toolName: "edit_file",
          args: {
            path: "stress-note.md",
            expectedHash: "__new__",
            edits: [{ startLine: 1, endLine: 1, newText: text }]
          }
        }
      ]
    };
  }
}

class FinalOnlyModel implements ModelClient {
  async next(_task: TaskDetail): Promise<ModelTurn> {
    return { kind: "final", message: "ok" };
  }
}

function recordPass(name: string, task: TaskDetail | null, evidence: Record<string, unknown>) {
  stressCases.push({
    evidence: {
      ...evidence,
      ...(task ? { taskId: task.id, status: task.status, workRoot: task.workRoot ?? null } : {})
    },
    name,
    status: "passed"
  });
}
