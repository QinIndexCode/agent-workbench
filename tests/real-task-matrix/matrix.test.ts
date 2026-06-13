import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RiskCategory, TaskDetail, ToolCall, ToolResult } from "@agent-workbench/shared";
import {
  AgentWorkbench,
  createId,
  InMemoryWorkbenchStore,
  nowIso,
  ShellToolExecutor,
  type ModelClient,
  type ModelStreamHandlers,
  type ModelTurn,
  type ToolExecutor
} from "@agent-workbench/core";

interface MatrixCase {
  name: string;
  status: "passed" | "failed";
  evidence: Record<string, unknown>;
}

const matrixCases: MatrixCase[] = [];

afterAll(async () => {
  const outDir = resolve("data", "test-reports", "real-task-matrix");
  const scorecard = buildScorecard(matrixCases);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), JSON.stringify({ generatedAt: nowIso(), scorecard, cases: matrixCases }, null, 2), "utf8");
  await writeFile(
    join(outDir, "report.md"),
    [
      "# Agent Workbench Real Task Matrix",
      "",
      `Generated: ${nowIso()}`,
      "",
      "## Flagship Agent Scorecard",
      "",
      ...Object.entries(scorecard).map(([key, value]) => `- ${value ? "PASS" : "FAIL"} ${key}`),
      "",
      "## Cases",
      "",
      ...matrixCases.map((item) => `- ${item.status === "passed" ? "PASS" : "FAIL"} ${item.name}`)
    ].join("\n"),
    "utf8"
  );
});

describe("real task matrix", () => {
  it("answers a short capability question without probing files", async () => {
    const workbench = new AgentWorkbench({ model: new DirectAnswerModel() });
    const task = await createRegisteredTask(workbench, "你可以帮我做些什么", "Capability answer");

    expect(task.status).toBe("completed");
    expect(task.events.filter((event) => event.type === "tool_requested")).toHaveLength(0);
    expect(task.events.some((event) => event.type === "thinking_delta")).toBe(true);
    recordPass("short no-tool answer", task, { toolRequests: 0 });
  });

  it("treats a broad tool-testing request as a safe model decision, not a code filter", async () => {
    const workbench = new AgentWorkbench({ model: new SafeToolInventoryModel() });
    const task = await createRegisteredTask(workbench, "测试一下你大概能用哪些工具", "Tool inventory");

    expect(task.status).toBe("completed");
    expect(task.events.filter((event) => event.type === "tool_requested")).toHaveLength(0);
    expect(assistantText(task)).toContain("read-only");
    expect(assistantText(task)).toContain("approval");
    recordPass("safe tool inventory wording", task, { toolRequests: 0 });
  });

  it("reads a fixture codebase and summarizes the relevant files", async () => {
    const fixture = createFixtureProject("read");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new CodebaseReadModel());
      const task = await runWithApprovals(
        await createRegisteredTask(
          fixtureWorkbench.workbench,
          "Read this project and summarize the important files.",
          "Read fixture",
          fixtureWorkbench.folderId
        )
      );

      expect(task.status).toBe("completed");
      expect(assistantText(task)).toContain("package.json");
      expect(assistantText(task)).toContain("math.mjs");
      expect(toolEvents(task, "list_files")).toHaveLength(1);
      expect(toolEvents(task, "read_file").length).toBeGreaterThanOrEqual(2);
      recordPass("codebase reading", task, { readTools: toolEvents(task, "read_file").length });
    } finally {
      fixture.cleanup();
    }
  });

  it("debugs a failing fixture project, edits the source, and reruns tests", async () => {
    const fixture = createFixtureProject("debug");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new DebugFixModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "Fix the failing math test in this project.", "Debug fixture", fixtureWorkbench.folderId)
      );
      const finalSource = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");

      expect(task.status).toBe("completed");
      expect(assistantText(task)).toContain("tests now pass");
      expect(finalSource).toContain("reduce");
      expect(successfulToolOutputs(task).join("\n")).toContain("math tests passed");
      recordPass("debug and fix", task, { toolResults: task.events.filter((event) => event.type === "tool_result").length });
    } finally {
      fixture.cleanup();
    }
  }, 15_000);

  it("handles a vague broken-project request with evidence before the fix", async () => {
    const fixture = createFixtureProject("vague-debug");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new DebugFixModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "这个项目好像跑不起来，帮我看看", "Vague debug", fixtureWorkbench.folderId)
      );
      const finalSource = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");

      expect(task.status).toBe("completed");
      expect(toolEvents(task, "run_command")).toHaveLength(2);
      expect(toolEvents(task, "read_file")).toHaveLength(1);
      expect(finalSource).toContain("reduce");
      expect(assistantText(task)).toContain("tests now pass");
      recordPass("vague debug request", task, { promptStyle: "ordinary", verified: true });
    } finally {
      fixture.cleanup();
    }
  }, 15_000);

  it("supports a read-only diagnosis turn without code-level prompt blocking", async () => {
    const fixture = createFixtureProject("read-only-diagnosis");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new ReadOnlyDiagnosisModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "先帮我判断大概问题在哪，暂时不用改代码", "Read-only diagnosis", fixtureWorkbench.folderId)
      );

      expect(task.status).toBe("completed");
      expect(toolEvents(task, "list_files")).toHaveLength(1);
      expect(toolEvents(task, "read_file")).toHaveLength(1);
      expect(toolEvents(task, "edit_file")).toHaveLength(0);
      expect(toolEvents(task, "write_file")).toHaveLength(0);
      expect(assistantText(task)).toContain("likely issue");
      recordPass("read-only diagnosis", task, { writes: 0 });
    } finally {
      fixture.cleanup();
    }
  });

  it("performs a small maintenance refactor without changing the task work root", async () => {
    const fixture = createFixtureProject("refactor");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new RefactorModel());
      const task = await runWithApprovals(
        await createRegisteredTask(
          fixtureWorkbench.workbench,
          "Refactor totals to use a shared formatter.",
          "Refactor fixture",
          fixtureWorkbench.folderId
        )
      );
      const finalSource = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");

      expect(task.status).toBe("completed");
      expect(finalSource).toContain("formatCurrency");
      expectSamePath(task.workRoot, fixture.root);
      expect(successfulToolOutputs(task).join("\n")).toContain("totals tests passed");
      recordPass("maintenance refactor", task, { workRoot: task.workRoot });
    } finally {
      fixture.cleanup();
    }
  });

  it("creates Markdown documentation from fixture source evidence", async () => {
    const fixture = createFixtureProject("docs");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new DocumentationModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "Write concise API documentation from the source.", "Document fixture", fixtureWorkbench.folderId)
      );
      const docs = readFileSync(join(fixture.root, "docs", "api.md"), "utf8");

      expect(task.status).toBe("completed");
      expect(docs).toContain("# API Guide");
      expect(docs).toContain("```js");
      expect(docs).toContain("formatCurrency");
      recordPass("documentation authoring", task, { docPath: "docs/api.md" });
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps follow-up messages in the same completed task thread", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new FollowUpModel() });
    const first = await createRegisteredTask(workbench, "Explain the fixture purpose.", "Follow-up fixture");
    const second = await workbench.appendMessage(first.id, "Now give me one risk.");

    expect(second.id).toBe(first.id);
    expect((await workbench.listTasks()).map((task) => task.id)).toEqual([first.id]);
    expect(second.events.filter((event) => event.type === "user_message")).toHaveLength(2);
    recordPass("same-thread follow-up", second, { taskCount: (await workbench.listTasks()).length });
  });

  it("stores pending guidance during approval and consumes it on resume", async () => {
    const fixture = createFixtureProject("guidance");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new GuidanceAwareModel());
      await fixtureWorkbench.workbench.revokeGlobalPermission("shell");
      const waiting = await createRegisteredTask(
        fixtureWorkbench.workbench,
        "Run the local test and wait for my guidance.",
        "Guidance fixture",
        fixtureWorkbench.folderId
      );
      const withGuidance = await fixtureWorkbench.workbench.appendMessage(waiting.id, "After the command, mention the fallback path.");
      const completed = await runWithApprovals(withGuidance);

      expect(withGuidance.pendingGuidance).toHaveLength(1);
      expect(completed.pendingGuidance).toHaveLength(0);
      expect(completed.events.some((event) => event.type === "guidance_consumed")).toBe(true);
      expect(assistantText(completed)).toContain("fallback path");
      recordPass("pending guidance", completed, { consumed: true });
    } finally {
      fixture.cleanup();
    }
  });

  it("asks the user when a real task is under-specified and resumes from the answer", async () => {
    const workbench = new AgentWorkbench({ model: new AskUserMatrixModel() });
    const waiting = await createRegisteredTask(workbench, "这个接口文档我没想清楚，帮我先把方向定一下", "Ask user matrix");

    expect(waiting.status).toBe("waiting_for_user");
    expect(waiting.events.some((event) => event.type === "user_input_requested")).toBe(true);

    const completed = await workbench.appendMessage(waiting.id, "给外部客户看，语气保守一点");
    expect(completed.status).toBe("completed");
    expect(completed.events.some((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user")).toBe(true);
    expect(assistantText(completed).toLowerCase()).toContain("external");
    recordPass("ask user clarification", completed, { waitingState: true, answered: true });
  });

  it("recovers from an empty model turn without showing diagnostics as assistant text", async () => {
    const workbench = new AgentWorkbench({ model: new EmptyOnceMatrixModel() });
    const task = await createRegisteredTask(workbench, "刚才好像没输出，继续处理一下", "Empty response matrix");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "model_empty_response")).toBe(true);
    expect(assistantText(task)).not.toContain("I could not produce a result");
    expect(assistantText(task)).toContain("Recovered");
    recordPass("empty response recovery", task, { emptyEvents: task.events.filter((event) => event.type === "model_empty_response").length });
  });

  it("shows progress events for a large file write before the final result", async () => {
    const fixture = createFixtureProject("large-write");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new LargeWriteModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "帮我生成一份稍微完整点的排查记录，放到 docs 里", "Large write matrix", fixtureWorkbench.folderId)
      );
      const notes = readFileSync(join(fixture.root, "docs", "diagnostics.md"), "utf8");

      expect(task.status).toBe("completed");
      expect(task.events.some((event) => event.type === "tool_started" && event.payload["toolName"] === "edit_file")).toBe(true);
      expect(task.events.some((event) => event.type === "tool_progress" && event.payload["toolName"] === "edit_file")).toBe(true);
      expect(successfulToolOutputs(task).join("\n")).toContain("\"addedLines\"");
      expect(notes).toContain("Diagnostic Notes");
      recordPass("large write progress", task, {
        progressEvents: task.events.filter((event) => event.type === "tool_progress").length,
        artifact: "docs/diagnostics.md"
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects reads outside the task work root while allowing isolated roots", async () => {
    const left = createFixtureProject("left");
    const right = createFixtureProject("right");
    writeFileSync(join(left.root, "shared.txt"), "left-root-only", "utf8");
    writeFileSync(join(right.root, "shared.txt"), "right-root-only", "utf8");
    try {
      const leftWorkbench = await workbenchForRoot(left.root, new ReadSharedModel());
      const rightWorkbench = await workbenchForRoot(right.root, new ReadSharedModel());
      const leftTask = await runWithApprovals(
        await createRegisteredTask(leftWorkbench.workbench, "Read shared data.", "Left root", leftWorkbench.folderId)
      );
      const rightTask = await runWithApprovals(
        await createRegisteredTask(rightWorkbench.workbench, "Read shared data.", "Right root", rightWorkbench.folderId)
      );

      expect(assistantText(leftTask)).toContain("left-root-only");
      expect(assistantText(rightTask)).toContain("right-root-only");

      const boundaryWorkbench = await workbenchForRoot(left.root, new EscapeReadModel());
      const boundaryTask = await runWithApprovals(
        await createRegisteredTask(boundaryWorkbench.workbench, "Try to read outside the folder.", "Boundary check", boundaryWorkbench.folderId)
      );
      expect(boundaryTask.status).toBe("completed");
      expect(failedToolOutputs(boundaryTask).join("\n")).toContain("outside the workspace");
      recordPass("work root isolation", boundaryTask, { leftRoot: left.root, rightRoot: right.root });
    } finally {
      left.cleanup();
      right.cleanup();
    }
  });

  it("records long output as a bounded summary with a raw output reference", async () => {
    const fixture = createFixtureProject("long-output");
    try {
      const fixtureWorkbench = await workbenchForRoot(fixture.root, new LongOutputModel());
      const task = await runWithApprovals(
        await createRegisteredTask(fixtureWorkbench.workbench, "Produce a long diagnostic output.", "Long output", fixtureWorkbench.folderId)
      );
      const output = successfulToolOutputs(task).join("\n");

      expect(task.status).toBe("completed");
      expect(output).toContain("rawOutputRef");
      expect(output).toContain("output truncated");
      recordPass("long output handling", task, { truncated: true });
    } finally {
      fixture.cleanup();
    }
  }, 15_000);

  it("cancels a long-running tool and prevents the next turn from continuing", async () => {
    const executor = new AbortableMatrixToolExecutor();
    const workbench = new AgentWorkbench({ model: new SlowToolModel(), tools: executor });
    await workbench.grantGlobalPermission("shell", "matrix cancellation");
    const started = remember(workbench, await workbench.startTask("Start a slow command.", "Cancellation fixture"));
    await waitUntil(() => executor.calls.length === 1, 1000);
    const cancelled = await workbench.control(started.id, "cancel");

    expect(cancelled.status).toBe("cancelled");
    await waitUntil(() => executor.aborted, 1000);
    const persisted = await workbench.getTask(started.id);
    expect(persisted?.status).toBe("cancelled");
    expect(persisted?.events.some((event) => event.type === "assistant_message")).toBe(false);
    recordPass("long task cancellation", persisted ?? cancelled, { aborted: executor.aborted });
  });

  it("keeps denied MCP-style tools as evidence instead of forcing a hidden retry path", async () => {
    const workbench = new AgentWorkbench({
      model: new McpDenyModel(),
      tools: new MockMcpToolExecutor(),
      toolRiskProvider: new MockMcpRiskProvider()
    });
    const waiting = await createRegisteredTask(workbench, "Call a mock external tool.", "MCP denial");
    const denied = await workbench.decideApproval(waiting.id, waiting.approvals[0]!.id, "deny");

    expect(denied.status).toBe("completed");
    expect(assistantText(denied)).toContain("denied");
    expect(denied.events.some((event) => event.type === "approval_resolved" && event.payload["decision"] === "deny")).toBe(true);
    recordPass("mcp denial evidence", denied, { decision: "deny" });
  });

  it("runs destructive tools only after explicit full-access style grants", async () => {
    const workbench = new AgentWorkbench({ model: new DestructiveCommandModel(), tools: new PermissionMatrixToolExecutor() });
    const allRisks: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
    for (const risk of allRisks) await workbench.grantGlobalPermission(risk, "matrix full access");

    const task = await createRegisteredTask(workbench, "我确认可以完全访问，执行这条维护命令", "Full access matrix");

    expect(task.status).toBe("completed");
    expect(task.approvals).toHaveLength(0);
    expect(task.events.some((event) => event.type === "approval_auto_granted" && event.payload["riskCategory"] === "destructive")).toBe(true);
    expect(successfulToolOutputs(task).join("\n")).toContain("safe destructive fixture");
    recordPass("full access destructive audit", task, { destructiveEvidence: true });
  });

  it("keeps custom permissions bounded when shell is not globally allowed", async () => {
    const workbench = new AgentWorkbench({ model: new ShellDeniedRecoveryModel(), tools: new PermissionMatrixToolExecutor() });
    await workbench.grantGlobalPermission("workspace_read", "matrix custom");
    await workbench.grantGlobalPermission("workspace_write", "matrix custom");

    const waiting = await createRegisteredTask(workbench, "我只想允许读写文件，命令行先别直接跑", "Custom bounded matrix");
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.approvals[0]?.riskCategory).toBe("shell");

    const denied = await workbench.decideApproval(waiting.id, waiting.approvals[0]!.id, "deny");
    expect(denied.status).toBe("completed");
    expect(assistantText(denied)).toContain("Shell was not allowed");
    expect(denied.events.some((event) => event.type === "approval_resolved" && event.payload["decision"] === "deny")).toBe(true);
    recordPass("custom shell denied", denied, { shellExecuted: false });
  });

  it("uses auto approval rules and optional LLM approval without hardcoded prompt gates", async () => {
    const workbench = new AgentWorkbench({ model: new LlmApprovalMatrixModel(), tools: new PermissionMatrixToolExecutor() });
    await workbench.updatePreferences({
      permissionMode: "auto_approval",
      autoApproveRiskCategories: ["host_observation"],
      llmApprovalMode: "non_destructive",
      reflectionEnabled: false
    });

    const task = await createRegisteredTask(workbench, "看看当前目录里有哪些关键文件", "Auto approval matrix");

    expect(task.status).toBe("completed");
    expect(task.events.some((event) => event.type === "approval_auto_granted" && event.payload["approvalSource"] === "llmApproval")).toBe(true);
    expect(task.events.some((event) => event.type === "token_usage_recorded")).toBe(true);
    expect(assistantText(task)).toContain("Listed files after approval evidence");
    recordPass("auto approval with llm review", task, { approvalSource: "llmApproval" });
  });

  it("records memories for ordinary tasks without directly creating skills", async () => {
    const store = new InMemoryWorkbenchStore();
    const workbench = new AgentWorkbench({ store, model: new DirectAnswerModel() });
    await workbench.updatePreferences({ reflectionEnabled: false });

    for (let index = 0; index < 3; index++) {
      await createRegisteredTask(workbench, `Document a simple note ${index + 1}.`, `Memory ${index + 1}`);
    }

    expect(await workbench.listSkills()).toHaveLength(0);
    expect(await workbench.listTaskMemories()).toHaveLength(3);
    const session = await workbench.runReflection();
    expect(session.status).toBe("completed");
    expect(await workbench.listSkills()).toHaveLength(0);
    recordPass("memory before skills", (await workbench.listTasks())[0]!, { memories: (await workbench.listTaskMemories()).length });
  });
});

class DirectAnswerModel implements ModelClient {
  async next(_task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    await stream?.onThinkingDelta("Deciding whether tools are needed.");
    await stream?.onAssistantDelta("I can help with code, docs, debugging, and task planning.");
    return { kind: "final", message: "I can help with code, docs, debugging, and task planning.", streamId: stream?.streamId };
  }
}

class SafeToolInventoryModel implements ModelClient {
  async next(): Promise<ModelTurn> {
    return {
      kind: "final",
      message: "I can explain available capabilities and run read-only checks when useful. Tools with side effects still go through approval."
    };
  }
}

class CodebaseReadModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("list_files", { path: ".", recursive: true });
    if (results.length === 1) return singleCall("read_file", { path: "package.json" });
    if (results.length === 2) return singleCall("read_file", { path: "src/math.mjs" });
    return { kind: "final", message: "The fixture contains package.json for scripts and src/math.mjs for core arithmetic behavior." };
  }
}

class DebugFixModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("run_command", { command: "node tests/math.test.mjs" });
    if (results.length === 1) return singleCall("read_file", { path: "src/math.mjs" });
    if (results.length === 2) {
      const hash = readHash(lastToolOutput(task));
      return singleCall("edit_file", {
        path: "src/math.mjs",
        expectedHash: hash,
        edits: [
          {
            startLine: 1,
            endLine: 3,
            newText: "export function sum(numbers) {\n  return numbers.reduce((total, value) => total + value, 0);\n}"
          }
        ]
      });
    }
    if (results.length === 3) return singleCall("run_command", { command: "node tests/math.test.mjs" });
    return { kind: "final", message: "The math tests now pass after fixing sum to add values instead of counting entries." };
  }
}

class ReadOnlyDiagnosisModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("list_files", { path: ".", recursive: true });
    if (results.length === 1) return singleCall("read_file", { path: "src/math.mjs" });
    return { kind: "final", message: "The likely issue is in src/math.mjs: sum counts entries instead of adding values. No files were changed." };
  }
}

class RefactorModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("read_file", { path: "src/totals.mjs" });
    if (results.length === 1) {
      const hash = readHash(lastToolOutput(task));
      return singleCall("edit_file", {
        path: "src/totals.mjs",
        expectedHash: hash,
        edits: [
          {
            startLine: 1,
            endLine: 4,
            newText:
              "export function formatCurrency(value) {\n  return `$${value.toFixed(2)}`;\n}\n\nexport function renderTotal(items) {\n  const total = items.reduce((sum, item) => sum + item.price, 0);\n  return formatCurrency(total);\n}"
          }
        ]
      });
    }
    if (results.length === 2) return singleCall("run_command", { command: "node tests/totals.test.mjs" });
    return { kind: "final", message: "The totals module now exposes a reusable formatter and the totals tests passed." };
  }
}

class DocumentationModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("read_file", { path: "src/totals.mjs" });
    if (results.length === 1) {
      return singleCall("edit_file", {
        path: "docs/api.md",
        expectedHash: "__new__",
        edits: [
          {
            startLine: 1,
            endLine: 0,
            newText:
              "# API Guide\n\n## Totals\n\nUse `renderTotal(items)` to calculate and format a cart total.\n\n```js\nimport { renderTotal } from \"../src/totals.mjs\";\n```\n\n`formatCurrency(value)` keeps display formatting reusable."
          }
        ]
      });
    }
    return { kind: "final", message: "Created docs/api.md from the source evidence." };
  }
}

class FollowUpModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const messageCount = task.events.filter((event) => event.type === "user_message").length;
    return { kind: "final", message: messageCount > 1 ? "Follow-up stayed in the same task." : "Initial response recorded." };
  }
}

class GuidanceAwareModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const results = task.events.filter((event) => event.type === "tool_result");
    if (results.length === 0) return singleCall("run_command", { command: "node tests/math.test.mjs" });
    const consumed = task.events.find((event) => event.type === "guidance_consumed")?.summary ?? "";
    return { kind: "final", message: `Command finished; ${consumed || "no extra guidance"}` };
  }
}

class AskUserMatrixModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const answer = task.events.find((event) => event.type === "tool_result" && event.payload["toolName"] === "ask_user");
    if (answer) return { kind: "final", message: "External-customer direction recorded; I will keep the documentation conservative and evidence-led." };
    return singleCall("ask_user", {
      question: "Who is the documentation for?",
      options: ["Internal engineering team", "External customers"],
      required: true,
      details: "The audience changes tone, examples, and risk disclosure."
    });
  }
}

class EmptyOnceMatrixModel implements ModelClient {
  calls = 0;

  async next(_task: TaskDetail, stream?: ModelStreamHandlers): Promise<ModelTurn> {
    this.calls += 1;
    if (this.calls === 1) return { kind: "empty_response", reason: "fixture empty response", streamId: stream?.streamId };
    return { kind: "final", message: "Recovered after the empty model turn.", streamId: stream?.streamId };
  }
}

class LargeWriteModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) {
      return singleCall("edit_file", {
        path: "docs/diagnostics.md",
        expectedHash: "__new__",
        edits: [
          {
            startLine: 1,
            endLine: 0,
            newText: [
              "# Diagnostic Notes",
              "",
              ...Array.from({ length: 80 }, (_unused, index) => `- Check ${index + 1}: capture evidence before changing behavior.`)
            ].join("\n")
          }
        ]
      });
    }
    return { kind: "final", message: "Created the diagnostics note with a recorded file-change summary." };
  }
}

class ReadSharedModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) return singleCall("read_file", { path: "shared.txt" });
    return { kind: "final", message: `Shared content: ${readContent(lastToolOutput(task))}` };
  }
}

class EscapeReadModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) return singleCall("read_file", { path: "../outside.txt" });
    return { kind: "final", message: "The outside read was rejected by the tool boundary." };
  }
}

class LongOutputModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) {
      return singleCall("run_command", { command: "1..2200 | ForEach-Object { \"diagnostic line $_\" }" });
    }
    return { kind: "final", message: "Long output was summarized with a raw output reference." };
  }
}

class SlowToolModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) return singleCall("run_command", { command: "slow diagnostic" });
    return { kind: "final", message: "This should not be reached after cancellation." };
  }
}

class McpDenyModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const denied = task.events.some((event) => event.type === "approval_resolved" && event.payload["decision"] === "deny");
    if (denied) return { kind: "final", message: "The mock MCP tool was denied, so I will explain the limitation instead." };
    return singleCall("mcp__mock__lookup", { query: "status" });
  }
}

class DestructiveCommandModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (!task.events.some((event) => event.type === "tool_result")) return singleCall("run_command", { command: "Stop-Process -Id 99999" });
    return { kind: "final", message: "Full access was explicit, the destructive-class fixture command produced evidence." };
  }
}

class ShellDeniedRecoveryModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    const denied = task.events.some((event) => event.type === "approval_resolved" && event.payload["decision"] === "deny");
    if (denied) return { kind: "final", message: "Shell was not allowed, so I will continue from the existing permission evidence instead." };
    return singleCall("run_command", { command: "Write-Output custom-permission-check" });
  }
}

class LlmApprovalMatrixModel implements ModelClient {
  async next(task: TaskDetail): Promise<ModelTurn> {
    if (task.title === "LLM tool approval review") {
      return {
        kind: "final",
        message: JSON.stringify({ allow: true, reason: "Read-only directory listing is scoped and non-destructive." }),
        usage: { inputTokens: 32, outputTokens: 12, totalTokens: 44, cachedTokens: 0 }
      };
    }
    if (!task.events.some((event) => event.type === "tool_result")) return singleCall("list_files", { path: "." });
    return { kind: "final", message: "Listed files after approval evidence." };
  }
}

class AbortableMatrixToolExecutor implements ToolExecutor {
  calls: ToolCall[] = [];
  aborted = false;

  async execute(call: ToolCall, options?: { signal?: AbortSignal }): Promise<ToolResult> {
    this.calls.push(call);
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 5000);
      options?.signal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
    });
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: !this.aborted,
      createdAt: nowIso(),
      output: this.aborted ? "Command cancelled by user." : "slow command finished"
    };
  }
}

class MockMcpToolExecutor implements ToolExecutor {
  async execute(call: ToolCall): Promise<ToolResult> {
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output: JSON.stringify({ summary: "mock MCP response" })
    };
  }
}

class PermissionMatrixToolExecutor implements ToolExecutor {
  calls: ToolCall[] = [];

  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return {
      id: createId("tool_result"),
      toolCallId: call.id,
      ok: true,
      createdAt: nowIso(),
      output:
        call.toolName === "run_command"
          ? "safe destructive fixture command observed without touching host state"
          : JSON.stringify({ path: ".", files: ["package.json", "src/math.mjs"] })
    };
  }
}

class MockMcpRiskProvider {
  async assessTool(call: ToolCall) {
    if (call.toolName.startsWith("mcp__")) return { category: "network" as const, reason: "Mock MCP calls are external tool calls." };
    return undefined;
  }

  async describeToolCall(call: ToolCall) {
    if (!call.toolName.startsWith("mcp__")) return undefined;
    return { serverId: "mock", toolName: "lookup", argsPreview: JSON.stringify(call.args) };
  }
}

async function workbenchForRoot(root: string, model: ModelClient): Promise<{ workbench: AgentWorkbench; folderId: string }> {
  const workbench = new AgentWorkbench({ model, tools: new ShellToolExecutor() });
  await workbench.updatePreferences({ reflectionEnabled: false });
  const folder = await workbench.createTaskFolder({ name: "Fixture", rootPath: root });
  await workbench.grantGlobalPermission("workspace_read", "matrix fixture");
  await workbench.grantGlobalPermission("workspace_write", "matrix fixture");
  await workbench.grantGlobalPermission("shell", "matrix fixture");
  return { workbench, folderId: folder.id };
}

async function runWithApprovals(task: TaskDetail, decision: "allow_once" | "allow_for_task" | "allow_globally" = "allow_for_task"): Promise<TaskDetail> {
  const workbench = findWorkbench(task);
  let current = task;
  for (let attempt = 0; attempt < 12 && current.status === "waiting_approval"; attempt++) {
    const approval = current.approvals.find((item) => item.status === "pending");
    if (!approval) break;
    current = await workbench.decideApproval(current.id, approval.id, decision);
  }
  return current;
}

const taskWorkbenchMap = new Map<string, AgentWorkbench>();

function remember(workbench: AgentWorkbench, task: TaskDetail): TaskDetail {
  taskWorkbenchMap.set(task.id, workbench);
  return task;
}

function findWorkbench(task: TaskDetail): AgentWorkbench {
  const workbench = taskWorkbenchMap.get(task.id);
  if (!workbench) throw new Error(`No workbench registered for ${task.id}`);
  return workbench;
}

function singleCall(toolName: string, args: Record<string, unknown>): ModelTurn {
  return { kind: "tool_calls", calls: [{ id: createId("tool_call"), toolName, args }] };
}

async function createRegisteredTask(workbench: AgentWorkbench, goal: string, title: string, folderId?: string): Promise<TaskDetail> {
  return remember(workbench, await workbench.createTask(goal, title, folderId));
}

function createFixtureProject(name: string): { root: string; cleanup: () => void } {
  const root = resolve(mkdtempSync(join(tmpdir(), `scc-matrix-${name}-`)));
  writeFixture(root, "package.json", JSON.stringify({ type: "module", scripts: { test: "node tests/math.test.mjs" } }, null, 2));
  writeFixture(
    root,
    "src/math.mjs",
    "export function sum(numbers) {\n  return numbers.length;\n}\n\nexport function average(numbers) {\n  return numbers.length === 0 ? 0 : sum(numbers) / numbers.length;\n}\n"
  );
  writeFixture(
    root,
    "src/totals.mjs",
    "export function renderTotal(items) {\n  const total = items.reduce((sum, item) => sum + item.price, 0);\n  return `$${total.toFixed(2)}`;\n}\n"
  );
  writeFixture(
    root,
    "tests/math.test.mjs",
    "import assert from 'node:assert/strict';\nimport { sum, average } from '../src/math.mjs';\nassert.equal(sum([2, 3, 5]), 10);\nassert.equal(average([2, 4, 6]), 4);\nconsole.log('math tests passed');\n"
  );
  writeFixture(
    root,
    "tests/totals.test.mjs",
    "import assert from 'node:assert/strict';\nimport { renderTotal, formatCurrency } from '../src/totals.mjs';\nassert.equal(formatCurrency(3), '$3.00');\nassert.equal(renderTotal([{ price: 2 }, { price: 5.5 }]), '$7.50');\nconsole.log('totals tests passed');\n"
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeFixture(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function comparablePath(path: string): string {
  const resolved = resolve(path.trim());
  const real = realpathSync.native(resolved);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function expectSamePath(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(comparablePath(actual ?? "")).toBe(comparablePath(expected));
}

function assistantText(task: TaskDetail): string {
  return task.events.filter((event) => event.type === "assistant_message").map((event) => event.summary).join("\n");
}

function toolEvents(task: TaskDetail, toolName: string): TaskDetail["events"] {
  return task.events.filter((event) => event.type === "tool_requested" && event.payload["toolName"] === toolName);
}

function successfulToolOutputs(task: TaskDetail): string[] {
  return task.events
    .filter((event) => event.type === "tool_result" && event.payload["ok"] === true)
    .map((event) => String(event.payload["output"] ?? ""));
}

function failedToolOutputs(task: TaskDetail): string[] {
  return task.events
    .filter((event) => event.type === "tool_result" && event.payload["ok"] === false)
    .map((event) => String(event.payload["output"] ?? ""));
}

function lastToolOutput(task: TaskDetail): string {
  return String([...task.events].reverse().find((event) => event.type === "tool_result")?.payload["output"] ?? "");
}

function readHash(output: string): string {
  const parsed = JSON.parse(output) as { hash?: string };
  if (!parsed.hash) throw new Error(`Missing file hash in output: ${output}`);
  return parsed.hash;
}

function readContent(output: string): string {
  const parsed = JSON.parse(output) as { content?: string };
  return parsed.content ?? output;
}

function recordPass(name: string, task: TaskDetail, evidence: Record<string, unknown>): void {
  matrixCases.push({
    name,
    status: "passed",
    evidence: {
      taskId: task.id,
      status: task.status,
      workRoot: task.workRoot,
      eventCount: task.events.length,
      ...evidence
    }
  });
}

function buildScorecard(cases: MatrixCase[]): Record<string, boolean> {
  const names = new Set(cases.filter((item) => item.status === "passed").map((item) => item.name));
  return {
    "goal retention": names.has("same-thread follow-up") && names.has("vague debug request"),
    "evidence-first execution": names.has("debug and fix") && names.has("read-only diagnosis"),
    "permission control": names.has("mcp denial evidence") && names.has("work root isolation") && names.has("custom shell denied"),
    "permission modes": names.has("full access destructive audit") && names.has("auto approval with llm review"),
    "tool traceability": names.has("large write progress") && names.has("long output handling"),
    "interruptibility": names.has("long task cancellation"),
    "user clarification": names.has("ask user clarification"),
    "empty-response recovery": names.has("empty response recovery"),
    "side capability hygiene": names.has("memory before skills")
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}
