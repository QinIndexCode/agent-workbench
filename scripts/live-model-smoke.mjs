import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());

const liveSmokeRequested = process.env.SCC_LIVE_MODEL_SMOKE === "1";
const liveSmokeRequired = process.env.SCC_LIVE_MODEL_REQUIRED === "1";

if (!liveSmokeRequested) {
  const message = "Skipping live model smoke. Set SCC_LIVE_MODEL_SMOKE=1 to run it.";
  if (liveSmokeRequired) {
    console.error(`${message} This run marked live smoke as required.`);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

const {
  AgentWorkbench,
  CompositeToolExecutor,
  ContextAssembler,
  createId,
  createModelClientFromEnvironment,
  InMemoryWorkbenchStore,
  KnowledgeSearchToolExecutor,
  loadOpenAiConfig,
  nowIso,
  ShellToolExecutor
} = await import("../packages/core/dist/index.js");

const config = loadOpenAiConfig();
if (!config.apiKey || !config.baseURL) {
  throw new Error("Live model smoke requires a configured local Mimo/OpenAI-compatible provider.");
}
const stressLevel = Math.max(1, Number(process.env.SCC_STRESS_LEVEL ?? "1") || 1);

const report = {
  generatedAt: nowIso(),
  sourceFingerprint: sourceFingerprint(root),
  required: liveSmokeRequired,
  stressLevel,
  provider: {
    baseURL: redactUrl(config.baseURL),
    model: config.model ?? "mimo-v2.5",
    hasApiKey: Boolean(config.apiKey)
  },
  cases: []
};

class EvidenceError extends Error {
  constructor(message, evidencePayload) {
    super(message);
    this.evidence = evidencePayload;
  }
}

await runCase("short no-tool answer", async () => {
  const { workbench } = await createLiveWorkbench();
  const task = await workbench.createTask(
    "你可以帮我做些什么？请直接回答，不要读取文件、不要运行命令、不要检查项目结构。",
    "Live no-tool"
  );
  const toolRequests = task.events.filter((event) => event.type === "tool_requested").length;
  assert(task.status === "completed", `expected completed, got ${task.status}`);
  assert(toolRequests === 0, `expected no tools, got ${toolRequests}`);
  assert(assistantText(task).length >= 12, "assistant response is too short");
  return evidence(task, { toolRequests, assistant: excerpt(assistantText(task)) });
});

await runCase("project file reading", async () => {
  const fixture = createFixtureProject("read");
  try {
    const { workbench, folderId } = await createLiveWorkbench(fixture.root);
    let task = await workbench.createTask(
      [
        "请阅读当前任务文件夹中的项目，给出 3 点结构总结。",
        "必须先使用 list_files 或 read_file 获取证据；不要猜测 README 是否存在。",
        "重点查看 package.json、src/math.mjs、tests/math.test.mjs。"
      ].join("\n"),
      "Live project read",
      folderId
    );
    task = await settleApprovals(workbench, task, () => "allow_for_task");
    const toolResults = task.events.filter((event) => event.type === "tool_result");
    assert(task.status === "completed", `expected completed, got ${task.status}`);
    assert(toolResults.length >= 2, `expected at least 2 tool results, got ${toolResults.length}`);
    return evidence(task, { toolResults: toolResults.length, assistant: excerpt(assistantText(task)) });
  } finally {
    fixture.cleanup();
  }
});

await runCase("debug failing fixture", async () => {
  const fixture = createFixtureProject("debug");
  try {
    const { workbench, folderId } = await createLiveWorkbench(fixture.root);
    let task = await workbench.createTask(
      [
        "修复当前项目中失败的测试。",
        "请按顺序执行：运行 node tests/math.test.mjs，读取必要源码，使用 edit_file 修改，最后重新运行测试。",
        "只能在当前任务文件夹内修改文件。",
        "最终回答必须基于 read_file 看到的原始实现，明确写出失败根因表达式、修改文件和验证结果。"
      ].join("\n"),
      "Live debug fixture",
      folderId
    );
    task = await settleApprovals(workbench, task, () => "allow_for_task", 12);
    const source = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
    const toolOutput = toolOutputs(task).join("\n");
    const assistant = assistantText(task);
    const checkpoints = await workbench.listTaskCheckpoints(task.id);
    const debugEvidence = evidence(task, {
      fixed: source.includes("reduce"),
      testsPassed: toolOutput.includes("math tests passed"),
      checkpoints: checkpoints.length,
      assistant: excerpt(assistant),
      sourceExcerpt: excerpt(source)
    }).evidence;
    assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, debugEvidence);
    assertWithEvidence(source.includes("reduce") || toolOutput.includes("math tests passed"), "fixture was not fixed or tests did not pass", debugEvidence);
    assertWithEvidence(/numbers\.length|数组长度|length/i.test(assistant), "debug summary did not mention the observed length-based bug", debugEvidence);
    assertWithEvidence(!/乘法|multiply|multiplication/i.test(assistant), "debug summary speculated about multiplication instead of observed evidence", debugEvidence);
    assertWithEvidence(checkpoints.length > 0, "edit did not create a task checkpoint", debugEvidence);
    const rollback = await workbench.rollbackTask(task.id);
    const restored = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
    assertWithEvidence(restored.includes("return numbers.length;"), "rollback did not restore the original source", {
      ...debugEvidence,
      rollback
    });
    debugEvidence.rollback = {
      restoredFiles: rollback.restoredFiles,
      skippedFiles: rollback.skippedFiles
    };
    return { status: "passed", evidence: debugEvidence };
  } finally {
    fixture.cleanup();
  }
});

await runCase("documentation authoring", async () => {
  const fixture = createFixtureProject("docs");
  try {
    const { workbench, folderId } = await createLiveWorkbench(fixture.root);
    let task = await workbench.createTask(
      [
        "根据当前项目源码创建 docs/api.md。",
        "请先读取 src/totals.mjs，再用 edit_file 写一个简洁 Markdown 文档。",
        "文档要包含标题、函数说明和一个短代码块。"
      ].join("\n"),
      "Live docs fixture",
      folderId
    );
    task = await settleApprovals(workbench, task, () => "allow_for_task", 10);
    const docPath = join(fixture.root, "docs", "api.md");
    const docs = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
    assert(task.status === "completed", `expected completed, got ${task.status}`);
    assert(docs.includes("#") && docs.includes("```"), "docs/api.md was not created with Markdown structure");
    return evidence(task, { docCreated: true, docExcerpt: excerpt(docs), assistant: excerpt(assistantText(task)) });
  } finally {
    fixture.cleanup();
  }
});

await runCase("host observation approval", async () => {
  const { workbench } = await createLiveWorkbench();
  let task = await workbench.createTask(
    [
      "查看当前桌面/系统正在运行的软件有哪些，并按 CPU 或内存占用给出前 5 个。",
      "请请求一个只读系统观察命令，例如 PowerShell Get-Process；不要编造结果。"
    ].join("\n"),
    "Live process observation"
  );
  task = await settleApprovals(workbench, task, (approval) =>
    approval.riskCategory === "host_observation" || approval.riskCategory === "shell" ? "allow_for_task" : "deny",
    8
  );
  assert(task.status === "completed", `expected completed, got ${task.status}`);
  assert(task.events.some((event) => event.type === "tool_result"), "expected host observation tool evidence");
  return evidence(task, { approvals: approvalSummary(task), assistant: excerpt(assistantText(task)) });
});

await runCase("denied tool path", async () => {
  const { workbench } = await createLiveWorkbench();
  let task = await workbench.createTask(
    "请运行一个命令查看当前目录；如果工具审批被拒绝，请停止请求命令并解释你还能如何继续。",
    "Live denied command"
  );
  task = await settleApprovals(workbench, task, () => "deny", 4);
  assert(task.status === "completed", `expected completed after denial, got ${task.status}`);
  assert(task.events.some((event) => event.type === "approval_resolved" && event.payload?.decision === "deny"), "expected denied approval evidence");
  return evidence(task, { approvals: approvalSummary(task), assistant: excerpt(assistantText(task)) });
});

await runCase("same task follow-up", async () => {
  const { workbench } = await createLiveWorkbench();
  const first = await workbench.createTask("用两句话说明你会如何帮助我维护这个项目。不要使用工具。", "Live follow-up");
  const second = await workbench.appendMessage(first.id, "继续补充一个风险点，也不要使用工具。");
  const tasks = await workbench.listTasks();
  assert(second.id === first.id, "follow-up changed task id");
  assert(tasks.length === 1, `expected one task, got ${tasks.length}`);
  assert(second.events.filter((event) => event.type === "user_message").length === 2, "follow-up was not appended to same thread");
  return evidence(second, { taskCount: tasks.length, assistant: excerpt(assistantText(second)) });
});

if (stressLevel >= 2) {
  await runCase("latest turn revert and edit", async () => {
    const { workbench } = await createLiveWorkbench();
    const first = await workbench.createTask("用一句话回答：第一轮。不要使用工具。", "Live turn revert");
    const second = await workbench.appendMessage(first.id, "第二轮：请补充一个简短注意事项，也不要使用工具。");
    const turns = await workbench.listTaskTurns(second.id);
    const latest = turns.at(-1);
    assert(latest, "expected at least one task turn");
    const reverted = await workbench.revertTaskTurn(second.id, latest.id);
    assert(reverted.draft.includes("第二轮"), "revert did not return the latest user draft");
    const edited = await workbench.editTaskTurn(second.id, latest.id, { content: "第二轮编辑后：只保留一个注意事项，不要使用工具。" });
    const tasks = await workbench.listTasks();
    assert(edited.id === first.id, "edited turn changed task id");
    assert(tasks.length === 1, `expected one task after edit, got ${tasks.length}`);
    assert(edited.events.some((event) => event.type === "turn_reverted"), "missing turn_reverted evidence");
    assert(edited.events.some((event) => event.type === "turn_edit_submitted"), "missing turn_edit_submitted evidence");
    return evidence(edited, { taskCount: tasks.length, draft: excerpt(reverted.draft), assistant: excerpt(assistantText(edited)) });
  });
}

if (stressLevel >= 3) {
  await runCase("long context compaction under low budget", async () => {
    const { workbench, store } = await createLiveWorkbench();
    let task = await workbench.createTask(
      "用一句话记住这个上下文标记：CTX-MARKER-77。不要使用工具。",
      "Live context compaction"
    );
    task = await seedLongConversationHistory(store, task, "CTX-MARKER-77");
    await workbench.updatePreferences({ maxTokensPerRequest: 2200 });
    const continued = await workbench.appendMessage(
      task.id,
      "继续这个任务：请说明你是否仍能看到上下文标记，并用一句话回答。不要使用工具。"
    );
    const summaries = await workbench.listConversationSummaries(continued.id);
    const tasks = await workbench.listTasks();
    const summaryEvents = continued.events.filter((event) => event.type === "conversation_summary_created");
    assert(continued.id === task.id, "long context follow-up changed task id");
    assert(tasks.length === 1, `expected one task after long context follow-up, got ${tasks.length}`);
    assert(summaries.length > 0 || summaryEvents.length > 0, "long context did not create an auditable summary");
    return evidence(continued, {
      taskCount: tasks.length,
      summaries: summaries.length,
      summaryEvents: summaryEvents.length,
      assistant: excerpt(assistantText(continued))
    });
  });
}

if (stressLevel >= 4) {
  await runCase("multi-file debug with rollback", async () => {
    const fixture = createFixtureProject("multi-debug");
    try {
      writeFixture(fixture.root, "package.json", JSON.stringify({ type: "module", scripts: { test: "node tests/math.test.mjs && node tests/totals.test.mjs" } }, null, 2));
      writeFixture(
        fixture.root,
        "src/totals.mjs",
        "export function renderTotal(items) {\n  return '$0.00';\n}\n"
      );
      const { workbench, folderId } = await createLiveWorkbench(fixture.root);
      let task = await workbench.createTask(
        [
          "这是一个更复杂的多文件 Debug 压测。请运行 npm test，定位所有失败测试，读取相关源码，然后只修改必要源文件。",
          "你必须让 math 和 totals 两组测试都通过，最后重新运行 npm test。",
          "最终总结必须列出修改过的文件、每个失败的真实根因和验证命令结果。"
        ].join("\n"),
        "Live multi-file debug",
        folderId
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 16);
      const mathSource = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
      const totalsSource = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");
      const toolOutput = toolOutputs(task).join("\n");
      const checkpoints = await workbench.listTaskCheckpoints(task.id);
      const multiEvidence = evidence(task, {
        mathFixed: mathSource.includes("reduce"),
        totalsFixed: totalsSource.includes("reduce") && totalsSource.includes("toFixed"),
        testsPassed: toolOutput.includes("math tests passed") && toolOutput.includes("totals tests passed"),
        checkpoints: checkpoints.length,
        mathExcerpt: excerpt(mathSource),
        totalsExcerpt: excerpt(totalsSource),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, multiEvidence);
      assertWithEvidence(multiEvidence.mathFixed, "math source was not fixed", multiEvidence);
      assertWithEvidence(multiEvidence.totalsFixed, "totals source was not fixed", multiEvidence);
      assertWithEvidence(multiEvidence.testsPassed, "npm test did not show both fixture suites passing", multiEvidence);
      assertWithEvidence(checkpoints.length >= 2, "multi-file edit did not create checkpoints for both files", multiEvidence);
      const rollback = await workbench.rollbackTask(task.id);
      const restoredMath = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
      const restoredTotals = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");
      assertWithEvidence(restoredMath.includes("return numbers.length;"), "rollback did not restore math source", { ...multiEvidence, rollback });
      assertWithEvidence(restoredTotals.includes("return '$0.00';"), "rollback did not restore totals source", { ...multiEvidence, rollback });
      multiEvidence.rollback = {
        restoredFiles: rollback.restoredFiles,
        skippedFiles: rollback.skippedFiles
      };
      return { status: "passed", evidence: multiEvidence };
    } finally {
      fixture.cleanup();
    }
  });
}

if (stressLevel >= 5) {
  await runCase("long debug follow-up with context compaction", async () => {
    const fixture = createFixtureProject("long-follow-up");
    try {
      writeFixture(fixture.root, "package.json", JSON.stringify({ type: "module", scripts: { test: "node tests/math.test.mjs && node tests/totals.test.mjs" } }, null, 2));
      writeFixture(
        fixture.root,
        "src/totals.mjs",
        "export function renderTotal(items) {\n  return '$0.00';\n}\n"
      );
      const { workbench, store, folderId } = await createLiveWorkbench(fixture.root);
      let task = await workbench.createTask(
        [
          "这是一个长任务验证。先运行 npm test，定位失败测试，读取相关源码，再只修改必要文件。",
          "必须重新运行 npm test，确认 math 和 totals 两组测试都通过。",
          "最终回答要基于真实工具证据，写出根因、修改文件和验证结果。"
        ].join("\n"),
        "Live long debug",
        folderId,
        [],
        {
          runMode: "target",
          targetLimits: {
            maxModelTurns: 48,
            maxToolCalls: 120,
            maxWallTimeMs: 240_000
          }
        }
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 18);
      const fixedMath = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
      const fixedTotals = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");
      assert(task.status === "completed", `expected completed, got ${task.status}`);
      assert(toolOutputs(task).join("\n").includes("math tests passed"), "math fixture did not pass before follow-up");
      assert(toolOutputs(task).join("\n").includes("totals tests passed"), "totals fixture did not pass before follow-up");
      assert(fixedMath.includes("reduce"), "math source was not fixed before follow-up");
      assert(fixedTotals.includes("reduce") && fixedTotals.includes("toFixed"), "totals source was not fixed before follow-up");

      await workbench.rollbackTask(task.id);
      const restoredMath = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
      const restoredTotals = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");
      assert(restoredMath.includes("return numbers.length;"), "rollback did not restore math source before follow-up");
      assert(restoredTotals.includes("return '$0.00';"), "rollback did not restore totals source before follow-up");

      task = await seedLongConversationHistory(store, await workbench.getTask(task.id), "LONG-FOLLOW-UP-MARKER", 22);
      await workbench.updatePreferences({ maxTokensPerRequest: 2600 });
      const toolRequestCountBeforeFollowUp = task.events.filter((event) => event.type === "tool_requested").length;
      let continued = await workbench.appendMessage(
        task.id,
        [
          "继续这个同一个任务。",
          "请基于之前真实执行过的工具证据和刚刚 rollback 的结果，输出一个 JSON 对象，不要使用 Markdown、不要使用代码围栏、不要添加 JSON 之外的解释。",
          "不要重新运行 npm test，也不要再次编辑文件。",
          "你必须使用 read_file 核对 rollback 后的 src/math.mjs 与 src/totals.mjs；不要读取其他文件，也不要调用除 read_file 之外的工具。",
          "只允许基于你已经看到的 npm test 输出、src/math.mjs 和 src/totals.mjs 的真实内容回答，不要猜测不存在的函数或文件，不要使用“可能”“也许”或类似推测词。",
          "JSON 必须包含这些字段：",
          "- originalFailures.math.expected",
          "- originalFailures.math.actual",
          "- originalFailures.math.expression",
          "- originalFailures.totals.expected",
          "- originalFailures.totals.actual",
          "- originalFailures.totals.expression",
          "- modifiedFiles",
          "- rollbackSucceeded",
          "- currentMathExpression",
          "- currentTotalsExpression",
          "- restoredToOriginalBuggyState",
          "真实断言值必须是：sum([2, 3, 5]) 期望 10、实际 3；renderTotal([{ price: 2 }, { price: 5.5 }]) 期望 '$7.50'、实际 '$0.00'。",
          "modifiedFiles 必须列出之前真正被 edit_file 修改过的相对路径；本场景应为 [\"src/math.mjs\", \"src/totals.mjs\"]。",
          "rollback 后当前源码必须反映恢复后的真实表达式。不要新建任务。"
        ].join("\n")
      );
      continued = await settleApprovals(
        workbench,
        continued,
        (approval) => (approval.riskCategory === "workspace_read" ? "allow_for_task" : "deny"),
        8
      );
      const summaries = await workbench.listConversationSummaries(task.id);
      const followUpToolRequests = continued.events.filter((event) => event.type === "tool_requested").slice(toolRequestCountBeforeFollowUp);
      const followUpReadPaths = followUpToolRequests
        .filter((event) => event.payload?.toolName === "read_file")
        .map((event) => String(event.payload?.args?.path ?? ""));
      const assistant = assistantText(continued);
      const assistantJson = parseAssistantJson(assistant);
      const modifiedFiles = normalizeStringArray(assistantJson.modifiedFiles);
      const longEvidence = evidence(continued, {
        summaries: summaries.length,
        assistant: excerpt(assistant),
        restoredMath: excerpt(restoredMath),
        restoredTotals: excerpt(restoredTotals),
        followUpReadPaths
      }).evidence;
      assertWithEvidence(continued.id === task.id, "follow-up changed task id", longEvidence);
      assertWithEvidence(continued.status === "completed", `expected completed, got ${continued.status}`, longEvidence);
      assertWithEvidence(summaries.length > 0 || continued.events.some((event) => event.type === "conversation_summary_created"), "long follow-up did not compact context", longEvidence);
      assertWithEvidence(followUpToolRequests.every((event) => event.payload?.toolName === "read_file"), "follow-up called tools other than read_file", longEvidence);
      assertWithEvidence(followUpReadPaths.every((path) => path.endsWith("src/math.mjs") || path.endsWith("src/totals.mjs")), "follow-up re-read files outside the allowed rollback scope", longEvidence);
      assertWithEvidence(followUpReadPaths.some((path) => path.endsWith("src/math.mjs")), "follow-up did not re-read src/math.mjs after rollback", longEvidence);
      assertWithEvidence(followUpReadPaths.some((path) => path.endsWith("src/totals.mjs")), "follow-up did not re-read src/totals.mjs after rollback", longEvidence);
      assertWithEvidence(Array.isArray(assistantJson.modifiedFiles), "follow-up JSON omitted modifiedFiles", longEvidence);
      assertWithEvidence(modifiedFiles.some((value) => value.endsWith("src/math.mjs")), "follow-up JSON omitted src/math.mjs", longEvidence);
      assertWithEvidence(modifiedFiles.some((value) => value.endsWith("src/totals.mjs")), "follow-up JSON omitted src/totals.mjs", longEvidence);
      assertWithEvidence(assistantJson.rollbackSucceeded === true, "follow-up JSON did not confirm rollback success", longEvidence);
      assertWithEvidence(assistantJson.restoredToOriginalBuggyState === true, "follow-up JSON did not confirm restored buggy state", longEvidence);
      assertWithEvidence(normalizeExpression(assistantJson.currentMathExpression) === "return numbers.length;", "follow-up JSON reported the wrong restored math expression", longEvidence);
      assertWithEvidence(normalizeExpression(assistantJson.currentTotalsExpression) === "return '$0.00';", "follow-up JSON reported the wrong restored totals expression", longEvidence);
      assertWithEvidence(Number(assistantJson.originalFailures?.math?.expected) === 10, "follow-up JSON reported the wrong math expected value", longEvidence);
      assertWithEvidence(Number(assistantJson.originalFailures?.math?.actual) === 3, "follow-up JSON reported the wrong math actual value", longEvidence);
      assertWithEvidence(normalizeExpression(assistantJson.originalFailures?.math?.expression) === "return numbers.length;", "follow-up JSON reported the wrong math failure expression", longEvidence);
      assertWithEvidence(normalizeQuotedValue(assistantJson.originalFailures?.totals?.expected) === "$7.50", "follow-up JSON reported the wrong totals expected value", longEvidence);
      assertWithEvidence(normalizeQuotedValue(assistantJson.originalFailures?.totals?.actual) === "$0.00", "follow-up JSON reported the wrong totals actual value", longEvidence);
      assertWithEvidence(normalizeExpression(assistantJson.originalFailures?.totals?.expression) === "return '$0.00';", "follow-up JSON reported the wrong totals failure expression", longEvidence);
      assertWithEvidence(assistant.includes("LONG-FOLLOW-UP-MARKER") || summaries.length > 0, "long follow-up lost the compaction marker context", longEvidence);
      assertWithEvidence(Number(longEvidence.traceMaxEntryBytes ?? 0) <= 20_000, "trace entries grew beyond the long-task budget", longEvidence);
      assertWithEvidence(Number(longEvidence.traceBytes ?? 0) <= 450_000, "trace output grew beyond the long-task budget", longEvidence);
      return { status: "passed", evidence: longEvidence };
    } finally {
      fixture.cleanup();
    }
  });
}

await runCase("pending guidance consumption", async () => {
  const fixture = createFixtureProject("guidance");
  try {
    const { workbench, folderId } = await createLiveWorkbench(fixture.root);
    let task = await workbench.createTask(
      [
        "请运行 node tests/math.test.mjs。",
        "如果运行期间用户补充引导，最终回答必须明确吸收该引导。"
      ].join("\n"),
      "Live guidance",
      folderId
    );
    assert(task.status === "waiting_approval", `expected waiting approval before guidance, got ${task.status}`);
    task = await workbench.appendMessage(task.id, "补充引导：最终回答请提到这是一个临时 fixture 测试。");
    assert(task.pendingGuidance.length === 1, "guidance was not stored as pending");
    task = await settleApprovals(workbench, task, () => "allow_for_task", 6);
    assert(task.events.some((event) => event.type === "guidance_consumed"), "pending guidance was not consumed");
    return evidence(task, { consumed: true, assistant: excerpt(assistantText(task)) });
  } finally {
    fixture.cleanup();
  }
});

await runCase("work root boundary", async () => {
  const fixture = createFixtureProject("boundary");
  try {
    writeFileSync(join(dirname(fixture.root), "outside.txt"), "outside secret should not be readable", "utf8");
    const { workbench, folderId } = await createLiveWorkbench(fixture.root);
    let task = await workbench.createTask(
      "请尝试读取 ../outside.txt，然后说明工具层是否允许你越过当前任务文件夹。不要换用命令绕过 read_file。",
      "Live boundary",
      folderId
    );
    task = await settleApprovals(workbench, task, () => "allow_for_task", 6);
    assert(task.status === "completed", `expected completed, got ${task.status}`);
    assert(toolOutputs(task).join("\n").includes("outside the workspace"), "outside-root rejection evidence missing");
    return evidence(task, { rejectedOutsideRoot: true, assistant: excerpt(assistantText(task)) });
  } finally {
    fixture.cleanup();
  }
});

await runCase("memory without direct skill promotion", async () => {
  const { workbench } = await createLiveWorkbench();
  await workbench.updatePreferences({ reflectionEnabled: false });
  for (let index = 0; index < 2; index++) {
    await workbench.createTask(`请用一句话总结 SCC Agent Workbench 的一个维护建议 ${index + 1}。不要使用工具。`, `Live memory ${index + 1}`);
  }
  const memories = await workbench.listTaskMemories();
  const skills = await workbench.listSkills();
  assert(memories.length === 2, `expected 2 memories, got ${memories.length}`);
  assert(skills.length === 0, `ordinary tasks directly created ${skills.length} skills`);
  return { status: "passed", evidence: { memories: memories.length, skills: skills.length } };
});

await runCase("knowledge rag citation", async () => {
  const { workbench } = await createLiveWorkbench(undefined, { knowledge: true });
  await workbench.createKnowledgeItem({
    kind: "memory",
    title: "SCC Golden RAG Note",
    sourceUri: "scc://live-smoke/golden-rag-note.md",
    tags: ["live-smoke", "rag"],
    content: [
      "# SCC Golden RAG Note",
      "",
      "The live RAG marker is SCC-GOLDEN-RAG.",
      "When asked about the golden marker, answer with the exact marker and cite this knowledge source."
    ].join("\n")
  });
  const directMatches = await workbench.searchKnowledge({ query: "SCC-GOLDEN-RAG golden marker", projectId: "default", limit: 3 });
  const directEvidence = directMatches.map((match) => ({
    title: match.item.title,
    score: Number(match.score.toFixed(4)),
    excerpt: excerpt(match.chunk.content),
    citation: match.citation
  }));
  assertWithEvidence(
    directMatches.some((match) => match.chunk.content.includes("SCC-GOLDEN-RAG")),
    "direct knowledge search did not retrieve the golden marker",
    { directMatches: directEvidence }
  );
  let task = await workbench.createTask(
    [
      "必须调用 knowledge_search 工具查询资料库中的 golden marker；不要在未调用工具时回答。",
      "回答必须包含精确文本 SCC-GOLDEN-RAG，并说明引用了哪个知识来源。",
      "不要使用文件工具或命令。"
    ].join("\n"),
    "Live RAG citation"
  );
  task = await settleApprovals(workbench, task, () => "allow_for_task", 6);
  const outputs = toolOutputs(task).join("\n");
  const assistant = assistantText(task);
  const citations = outputs.match(/"citation"/g)?.length ?? 0;
  const ragEvidence = evidence(task, {
    citations,
    directMatches: directEvidence,
    assistant: excerpt(assistant),
    knowledgeEvidence: excerpt(outputs, 900)
  }).evidence;
  assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, ragEvidence);
  assertWithEvidence(outputs.includes("SCC-GOLDEN-RAG"), "knowledge_search did not return the golden marker", ragEvidence);
  assertWithEvidence(assistant.includes("SCC-GOLDEN-RAG"), "assistant did not use the retrieved marker", ragEvidence);
  assertWithEvidence(citations > 0, "knowledge_search output did not include citation metadata", ragEvidence);
  return evidence(task, {
    citations,
    directMatches: directEvidence,
    assistant: excerpt(assistant),
    knowledgeEvidence: excerpt(outputs, 900)
  });
});

const failed = report.cases.filter((item) => item.status === "failed");
report.summary = {
  totalCases: report.cases.length,
  passedCases: report.cases.filter((item) => item.status === "passed").length,
  failedCases: failed.length
};
const outDir = resolve("data", "test-reports", "live-model-smoke");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
await writeFile(resolve(outDir, "report.md"), markdownReport(report), "utf8");

if (failed.length > 0) {
  console.error(`Live Mimo smoke failed ${failed.length}/${report.cases.length} cases. Report: ${resolve(outDir, "report.md")}`);
  process.exit(1);
}

console.log(`Live Mimo smoke passed ${report.cases.length}/${report.cases.length}. Report: ${resolve(outDir, "report.md")}`);

async function createLiveWorkbench(rootPath, options = {}) {
  const store = new InMemoryWorkbenchStore();
  const preferences = await store.getPreferences();
  await store.savePreferences({
    ...preferences,
    defaultModel: config.model ?? "mimo-v2.5",
    providerBaseUrl: config.baseURL ?? "",
    showThinking: true,
    updatedAt: nowIso()
  });
  const contextAssembler = new ContextAssembler(store);
  const model = createModelClientFromEnvironment({
    contextAssembler,
    preferenceProvider: () => store.getPreferences()
  });
  const fallbackTools = new ShellToolExecutor();
  const tools = options.knowledge
    ? new CompositeToolExecutor(fallbackTools, [new KnowledgeSearchToolExecutor(store)])
    : fallbackTools;
  const workbench = new AgentWorkbench({ store, contextAssembler, model, tools });
  if (!rootPath) return { workbench, store, folderId: "default" };
  const folder = await workbench.createTaskFolder({ name: "Live fixture", rootPath });
  return { workbench, store, folderId: folder.id };
}

async function settleApprovals(workbench, task, decide, maxRounds = 8) {
  let current = task;
  for (let index = 0; index < maxRounds && current.status === "waiting_approval"; index++) {
    const approval = current.approvals.find((item) => item.status === "pending");
    if (!approval) break;
    const decision = decide(approval, current);
    current = await workbench.decideApproval(current.id, approval.id, decision);
  }
  return current;
}

async function runCase(name, fn) {
  const started = Date.now();
  try {
    const result = await withTimeout(fn(), 180_000, name);
    const evidencePayload = result?.evidence ?? result ?? {};
    assertTraceBudgets(evidencePayload);
    report.cases.push({
      name,
      status: "passed",
      durationMs: Date.now() - started,
      evidence: evidencePayload
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    const evidencePayload = error instanceof EvidenceError ? error.evidence : {};
    const failureClass = classifyFailure(name, error, evidencePayload);
    report.cases.push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      failureClass,
      error: sanitizeError(error),
      evidence: evidencePayload
    });
    console.error(`FAIL ${name} [${failureClass}]: ${sanitizeError(error)}`);
  }
}

function evidence(task, extra = {}) {
  const toolRequests = task.events.filter((event) => event.type === "tool_requested").map((event) => ({
    toolName: event.payload?.toolName,
    riskCategory: event.payload?.riskCategory,
    argsPreview: event.payload?.argsPreview
  }));
  const metrics = taskMetrics(task);
  return {
    status: "passed",
    evidence: {
      taskId: task.id,
      status: task.status,
      workRoot: task.workRoot,
      ...metrics,
      assistant: excerpt(assistantText(task), 10000),
      ...extra,
      eventCounts: eventCounts(task),
      toolRequestCount: toolRequests.length,
      toolRequests: toolRequests.slice(0, 12),
      omittedToolRequests: Math.max(0, toolRequests.length - 12)
    }
  };
}

function createFixtureProject(name) {
  const root = resolve(mkdtempSync(join(tmpdir(), `scc-live-${name}-`)));
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
    "import assert from 'node:assert/strict';\nimport { renderTotal } from '../src/totals.mjs';\nassert.equal(renderTotal([{ price: 2 }, { price: 5.5 }]), '$7.50');\nconsole.log('totals tests passed');\n"
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function seedLongConversationHistory(store, task, marker, noteCount = 34) {
  const seeded = { ...task, events: [...task.events] };
  for (let index = 0; index < noteCount; index++) {
    const content = [
      `Synthetic long-context note ${index + 1}.`,
      index === 2 ? `Important stable marker: ${marker}.` : "Routine maintenance detail.",
      "This row exists only to stress context compaction and should be summarized before the next model call.",
      "Keep the latest user instruction and do not create a new task."
    ].join(" ");
    seeded.events.push({
      id: createId("event"),
      taskId: seeded.id,
      type: index % 2 === 0 ? "user_message" : "assistant_message",
      summary: content,
      payload: { synthetic: true, index },
      createdAt: nowIso()
    });
  }
  await store.saveTask(seeded);
  return seeded;
}

function writeFixture(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function assistantText(task) {
  return [...task.events].reverse().find((event) => event.type === "assistant_message")?.summary ?? "";
}

function parseAssistantJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("assistant did not return a JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function normalizeExpression(value) {
  let text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (!/^return\b/.test(text)) text = `return ${text}`;
  return text.endsWith(";") ? text : `${text};`;
}

function normalizeQuotedValue(value) {
  const text = String(value ?? "").trim();
  return text.replace(/^['"`]|['"`]$/g, "");
}

function toolOutputs(task) {
  return task.events.filter((event) => event.type === "tool_result").map((event) => String(event.payload?.output ?? ""));
}

function approvalSummary(task) {
  return task.events
    .filter((event) => event.type === "approval_pending" || event.type === "approval_resolved" || event.type === "approval_auto_granted")
    .map((event) => ({ type: event.type, summary: event.summary, riskCategory: event.payload?.riskCategory, decision: event.payload?.decision }));
}

function eventCounts(task) {
  const counts = {};
  for (const event of task.events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function taskMetrics(task) {
  const trace = readTraceMetrics(task);
  const createdAt = Date.parse(task.createdAt ?? "");
  const updatedAt = Date.parse(task.updatedAt ?? "");
  const latencyMs = Number.isFinite(createdAt) && Number.isFinite(updatedAt) ? Math.max(0, updatedAt - createdAt) : undefined;
  const approvalCount = task.events.filter((event) => event.type === "approval_pending" || event.type === "approval_resolved" || event.type === "approval_auto_granted").length;
  const rollbackUsed = task.events.some((event) => event.type === "task_rollback_completed" || event.type === "task_rollback_failed");
  const contextCompactionObserved = task.events.some((event) => event.type === "conversation_summary_created" || event.type === "context_overflow_recovered");
  return {
    latencyMs,
    eventCount: task.events.length,
    approvalCount,
    rollbackUsed,
    contextCompactionObserved,
    ...trace
  };
}

function readTraceMetrics(task) {
  const tracePath = join(task.workRoot ?? process.cwd(), "data", "logs", "model-traces", task.id, "trace.jsonl");
  if (!existsSync(tracePath)) {
    return { tracePath, traceArtifactPath: null, traceLines: 0, traceBytes: 0, traceMaxEntryBytes: 0 };
  }
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const artifactDir = resolve("data", "test-reports", "live-model-smoke", "traces");
  mkdirSync(artifactDir, { recursive: true });
  const traceArtifactPath = resolve(artifactDir, `${task.id}.jsonl`);
  writeFileSync(traceArtifactPath, raw, "utf8");
  return {
    tracePath,
    traceArtifactPath,
    traceLines: lines.length,
    traceBytes: Buffer.byteLength(raw, "utf8"),
    traceMaxEntryBytes: lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line, "utf8")), 0)
  };
}

function excerpt(value, max = 10000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertWithEvidence(condition, message, evidencePayload) {
  if (!condition) throw new EvidenceError(message, evidencePayload);
}

function assertTraceBudgets(evidencePayload) {
  if (!evidencePayload || typeof evidencePayload !== "object") return;
  const traceMaxEntryBytes = Number(evidencePayload.traceMaxEntryBytes ?? 0);
  const traceBytes = Number(evidencePayload.traceBytes ?? 0);
  assertWithEvidence(traceMaxEntryBytes <= 20_000, "trace entries grew beyond the flagship per-entry budget", evidencePayload);
  assertWithEvidence(traceBytes <= 450_000, "trace output grew beyond the flagship task budget", evidencePayload);
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\btp-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]");
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "[configured]";
  }
}

function markdownReport(data) {
  const lines = [
    "# SCC Live Mimo Smoke",
    "",
    `Generated: ${data.generatedAt}`,
    `Required gate: ${data.required ? "yes" : "no"}`,
    `Summary: ${data.summary?.passedCases ?? 0}/${data.summary?.totalCases ?? data.cases.length} passed`,
    "",
    `Provider: ${data.provider.baseURL}`,
    `Model: ${data.provider.model}`,
    ""
  ];
  for (const item of data.cases) {
    lines.push(`## ${item.status === "passed" ? "PASS" : "FAIL"} ${item.name}`);
    lines.push("");
    lines.push(`Duration: ${item.durationMs}ms`);
    if (item.failureClass) lines.push(`Failure class: ${item.failureClass}`);
    if (item.evidence) {
      const metrics = [
        item.evidence.latencyMs !== undefined ? `latency=${item.evidence.latencyMs}ms` : null,
        item.evidence.eventCount !== undefined ? `events=${item.evidence.eventCount}` : null,
        item.evidence.approvalCount !== undefined ? `approvals=${item.evidence.approvalCount}` : null,
        item.evidence.traceLines !== undefined ? `traceLines=${item.evidence.traceLines}` : null,
        item.evidence.traceBytes !== undefined ? `traceBytes=${item.evidence.traceBytes}` : null,
        item.evidence.rollbackUsed !== undefined ? `rollback=${item.evidence.rollbackUsed}` : null,
        item.evidence.contextCompactionObserved !== undefined ? `contextCompaction=${item.evidence.contextCompactionObserved}` : null
      ].filter(Boolean);
      if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(" | ")}`);
    }
    if (item.error) lines.push(`Error: ${item.error}`);
    if (item.evidence?.assistant) {
      lines.push("");
      lines.push("Assistant summary:");
      lines.push("");
      lines.push(`> ${String(item.evidence.assistant).replace(/\n+/g, "\n> ")}`);
    }
    if (item.evidence && Object.keys(item.evidence).length > 0) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(item.evidence, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function classifyFailure(name, error, evidencePayload) {
  const message = `${name} ${sanitizeError(error)}`.toLowerCase();
  if (message.includes("trace") || Number(evidencePayload?.traceBytes ?? 0) > 450_000 || Number(evidencePayload?.traceMaxEntryBytes ?? 0) > 20_000) {
    return "trace_bloat";
  }
  if (message.includes("approval") || message.includes("deny") || message.includes("riskcategory") || message.includes("waiting approval")) {
    return "permission_approval";
  }
  if (message.includes("assistant") || message.includes("json") || message.includes("summary") || message.includes("marker") || message.includes("speculated")) {
    return "model_behavior";
  }
  if (
    message.includes("read_file") ||
    message.includes("edit_file") ||
    message.includes("search_files") ||
    message.includes("list_files") ||
    message.includes("outside the workspace") ||
    message.includes("checkpoint") ||
    message.includes("rollback") ||
    message.includes("npm test")
  ) {
    return "tooling_or_workspace";
  }
  if (message.includes("ui")) {
    return "ui_display";
  }
  return "runtime_or_unknown";
}
