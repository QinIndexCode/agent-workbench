import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(process.cwd());
const liveTraceRoot = resolve(root, "data", "logs", "model-traces");

const liveSmokeRequested = (process.env.AGENT_WORKBENCH_LIVE_MODEL_SMOKE ?? process.env.SCC_LIVE_MODEL_SMOKE) === "1";
const liveSmokeRequired = (process.env.AGENT_WORKBENCH_LIVE_MODEL_REQUIRED ?? process.env.SCC_LIVE_MODEL_REQUIRED) === "1";

if (!liveSmokeRequested) {
  const message = "Skipping live model smoke. Set AGENT_WORKBENCH_LIVE_MODEL_SMOKE=1 to run it.";
  if (liveSmokeRequired) {
    console.error(`${message} This run marked live smoke as required.`);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

process.env.AGENT_WORKBENCH_MODEL_TIMEOUT_MS ??= "120000";

const {
  AgentWorkbench,
  CompositeToolExecutor,
  ContextAssembler,
  createId,
  createModelClientFromEnvironment,
  InMemoryWorkbenchStore,
  KnowledgeSearchToolExecutor,
  loadOpenAiConfig,
  LocalSecretBox,
  nowIso,
  ShellToolExecutor,
  WebSearchToolExecutor
} = await import("../packages/core/dist/index.js");
const { SqliteWorkbenchStore } = await import("../apps/server/dist/sqlite-store.js");

const environmentConfig = loadOpenAiConfig();
const storedProviderConfig = hasCompleteProviderConfig(environmentConfig) ? null : await loadStoredModelProviderConfig();
const config = hasCompleteProviderConfig(environmentConfig)
  ? { ...environmentConfig, source: "environment" }
  : storedProviderConfig ?? { ...environmentConfig, source: "environment" };
const stressLevel = Math.max(1, Number(process.env.AGENT_WORKBENCH_STRESS_LEVEL ?? process.env.SCC_STRESS_LEVEL ?? "1") || 1);
const maxTransientCaseAttempts = Math.max(1, Number(process.env.AGENT_WORKBENCH_LIVE_MODEL_CASE_ATTEMPTS ?? "3") || 3);
const transientRetryBaseMs = Math.max(0, Number(process.env.AGENT_WORKBENCH_LIVE_MODEL_RETRY_BASE_MS ?? "20000") || 20_000);
const liveCleanupTasks = [];

const report = {
  generatedAt: nowIso(),
  sourceFingerprint: sourceFingerprint(root),
  required: liveSmokeRequired,
  stressLevel,
  provider: {
    baseURL: config.baseURL ? redactUrl(config.baseURL) : "missing",
    model: config.model ?? "mimo-v2.5",
    source: config.source ?? "environment",
    ...(config.providerId ? { providerId: config.providerId } : {}),
    ...(config.dbPath ? { dbPath: toRelative(config.dbPath) } : {}),
    hasApiKey: Boolean(config.apiKey),
    missing: [
      !config.apiKey ? "OPENAI_API_KEY, AGENT_WORKBENCH_OPENAI_API_KEY, SCC_OPENAI_API_KEY, AGENT_WORKBENCH_API_KEY_FILE, or SQLite model provider secret" : null,
      !config.baseURL ? "OPENAI_BASE_URL, AGENT_WORKBENCH_OPENAI_BASE_URL, or SQLite model provider baseUrl" : null
    ].filter(Boolean)
  },
  cases: []
};

if (!config.apiKey || !config.baseURL) {
  report.cases.push({
    name: "provider configuration",
    status: "failed",
    durationMs: 0,
    failureClass: "provider_configuration",
    error: "Live model smoke requires a configured local Mimo/OpenAI-compatible provider.",
    evidence: {
      missingConfig: report.provider.missing,
      sourceFingerprint: report.sourceFingerprint.hash
    }
  });
  report.summary = {
    totalCases: report.cases.length,
    passedCases: 0,
    failedCases: report.cases.length
  };
  const { markdownPath } = await writeLiveSmokeReport(report);
  console.error(`Live Mimo smoke failed before model execution: provider configuration is incomplete. Report: ${markdownPath}`);
  process.exit(1);
}

class EvidenceError extends Error {
  constructor(message, evidencePayload) {
    super(message);
    this.evidence = evidencePayload;
  }
}

const providerPreflight = await checkProviderPreflight(config);
if (!providerPreflight.ok) {
  report.cases.push({
    name: "provider preflight",
    status: "failed",
    durationMs: providerPreflight.durationMs,
    failureClass: providerPreflight.failureClass,
    error: providerPreflight.error,
    evidence: {
      provider: report.provider,
      statusCode: providerPreflight.statusCode,
      sourceFingerprint: report.sourceFingerprint.hash
    }
  });
  report.summary = {
    totalCases: report.cases.length,
    passedCases: 0,
    failedCases: report.cases.length
  };
  const { markdownPath } = await writeLiveSmokeReport(report);
  console.error(`Live Mimo smoke failed before case execution: ${providerPreflight.error}. Report: ${markdownPath}`);
}

if (providerPreflight.ok) {
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
    "请运行一个命令查看当前目录；如果工具审批被拒绝，请停止请求命令，不要调用 ask_user，也不要继续请求其他工具，直接解释你还能如何继续。",
    "Live denied command"
  );
  task = await settleApprovals(workbench, task, () => "deny", 4);
  const deniedEvidence = evidence(task, { approvals: approvalSummary(task), assistant: excerpt(assistantText(task)) }).evidence;
  assertWithEvidence(task.status === "completed", `expected completed after denial, got ${task.status}`, deniedEvidence);
  assertWithEvidence(task.events.some((event) => event.type === "approval_resolved" && event.payload?.decision === "deny"), "expected denied approval evidence", deniedEvidence);
  assertWithEvidence(!task.events.some((event) => event.type === "tool_requested" && event.payload?.toolName === "ask_user"), "denied recovery asked the user instead of giving an alternative", deniedEvidence);
  return { status: "passed", evidence: deniedEvidence };
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
    task = await seedLongConversationHistory(store, task, "CTX-MARKER-77", 80);
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
    assertWithEvidence(summaries.length > 0 || summaryEvents.length > 0, "long context did not create an auditable summary", {
      eventCount: continued.events.length,
      summarizableEvents: continued.events.filter((event) => ["user_message", "assistant_message", "tool_requested", "tool_result", "verification_result_recorded", "guidance_consumed", "pending_guidance"].includes(event.type)).length,
      summaries: summaries.length,
      summaryEvents: summaryEvents.length,
      assistant: excerpt(assistantText(continued))
    });
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
      const behavior = await fixtureBehavior(fixture.root);
      const multiEvidence = evidence(task, {
        mathFixed: behavior.mathGeneral,
        totalsFixed: behavior.totalsGeneral,
        testsPassed: toolOutput.includes("math tests passed") && toolOutput.includes("totals tests passed"),
        behavior,
        checkpoints: checkpoints.length,
        mathExcerpt: excerpt(mathSource),
        totalsExcerpt: excerpt(totalsSource),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, multiEvidence);
      assertWithEvidence(multiEvidence.mathFixed, "math behavior was not fixed for a non-fixture input", multiEvidence);
      assertWithEvidence(multiEvidence.totalsFixed, "totals behavior was not fixed for a non-fixture input", multiEvidence);
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
      const fixedBehavior = await fixtureBehavior(fixture.root);
      const beforeFollowUpEvidence = evidence(task, {
        behavior: fixedBehavior,
        mathExcerpt: excerpt(fixedMath),
        totalsExcerpt: excerpt(fixedTotals),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, beforeFollowUpEvidence);
      assertWithEvidence(toolOutputs(task).join("\n").includes("math tests passed"), "math fixture did not pass before follow-up", beforeFollowUpEvidence);
      assertWithEvidence(toolOutputs(task).join("\n").includes("totals tests passed"), "totals fixture did not pass before follow-up", beforeFollowUpEvidence);
      assertWithEvidence(fixedBehavior.mathGeneral, "math behavior was not fixed before follow-up", beforeFollowUpEvidence);
      assertWithEvidence(fixedBehavior.totalsGeneral, "totals behavior was not fixed before follow-up", beforeFollowUpEvidence);

      await workbench.rollbackTask(task.id);
      const restoredMath = readFileSync(join(fixture.root, "src", "math.mjs"), "utf8");
      const restoredTotals = readFileSync(join(fixture.root, "src", "totals.mjs"), "utf8");
      assert(restoredMath.includes("return numbers.length;"), "rollback did not restore math source before follow-up");
      assert(restoredTotals.includes("return '$0.00';"), "rollback did not restore totals source before follow-up");

      task = await seedLongConversationHistory(store, await workbench.getTask(task.id), "LONG-FOLLOW-UP-MARKER", 22);
      await workbench.updatePreferences({ maxTokensPerRequest: 6000 });
      const toolRequestCountBeforeFollowUp = task.events.filter((event) => event.type === "tool_requested").length;
      let continued = await workbench.appendMessage(
        task.id,
        [
          "继续这个同一个任务。",
          "请基于之前真实执行过的工具证据和刚刚 rollback 的结果，输出一个 JSON 对象，不要使用 Markdown、不要使用代码围栏、不要添加 JSON 之外的解释。",
          "你的最终回答第一个字符必须是 `{`，最后一个字符必须是 `}`。",
          "不要重新运行 npm test，也不要再次编辑文件。",
          "你必须重新读取 src/math.mjs 和 src/totals.mjs；读取后立即回答，最多调用四次 read_file；不要读取其他文件，不要使用空 path，也不要调用除 read_file 之外的工具。",
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
          "请输出完整的一行 JSON 对象，并保留这个结构；把 <...> 替换为你从工具证据中读到的值，不能只输出开头大括号：",
          "{\"originalFailures\":{\"math\":{\"expected\":<number>,\"actual\":<number>,\"expression\":\"return <source expression>;\"},\"totals\":{\"expected\":\"<string>\",\"actual\":\"<string>\",\"expression\":\"return <source expression>;\"}},\"modifiedFiles\":[\"<relative path>\"],\"rollbackSucceeded\":<boolean>,\"currentMathExpression\":\"return <source expression>;\",\"currentTotalsExpression\":\"return <source expression>;\",\"restoredToOriginalBuggyState\":<boolean>}",
          "originalFailures 必须从之前 npm test 的真实失败输出提取 expected 和 actual，不要从本条 follow-up 指令猜测。",
          "所有 expression 字段必须逐字复制刚刚 read_file 看到的当前源码中的完整 return 语句，必须以 `return ` 开头并以 `;` 结尾。",
          "不要把 `sum(...)`、`average(...)`、`renderTotal(...)` 或任何测试断言调用写进 expression 字段；如果 expression 字段不是源码 return 语句，就是错误答案。",
          "modifiedFiles 必须列出之前真正被 edit_file 修改过的相对路径，不要列出没有工具证据的文件。",
          "rollback 后当前源码必须反映恢复后的真实表达式。不要新建任务。"
        ].join("\n")
      );
      continued = await settleApprovals(
        workbench,
        continued,
        (approval) => (approval.riskCategory === "workspace_read" ? "allow_for_task" : "deny"),
        8
      );
      if (!tryParseAssistantJson(assistantText(continued)) && assistantText(continued).trim().length <= 2) {
        continued = await workbench.appendMessage(
          task.id,
          [
            "上一条最终回答明显不完整。不要新建任务。",
            "基于同一线程已有工具证据，直接补全完整的一行 JSON 对象。",
            "不要只输出开头大括号；不要使用 Markdown 代码块；不要请求除 read_file 之外的工具。",
            "字段仍必须包含 originalFailures、modifiedFiles、rollbackSucceeded、currentMathExpression、currentTotalsExpression、restoredToOriginalBuggyState。"
          ].join("\n")
        );
        continued = await settleApprovals(
          workbench,
          continued,
          (approval) => (approval.riskCategory === "workspace_read" ? "allow_for_task" : "deny"),
          8
        );
      }
      const summaries = await workbench.listConversationSummaries(task.id);
      const followUpToolRequests = continued.events.filter((event) => event.type === "tool_requested").slice(toolRequestCountBeforeFollowUp);
      const followUpReadPaths = followUpToolRequests
        .filter((event) => event.payload?.toolName === "read_file")
        .map((event) => String(event.payload?.args?.path ?? ""));
      const editedPaths = continued.events
        .filter((event) => event.type === "tool_requested" && event.payload?.toolName === "edit_file")
        .map((event) => String(event.payload?.args?.path ?? ""));
      const longEvidence = evidence(continued, {
        summaries: summaries.length,
        assistant: excerpt(assistantText(continued)),
        restoredMath: excerpt(restoredMath),
        restoredTotals: excerpt(restoredTotals),
        editedPaths,
        followUpReadPaths
      }).evidence;
      const assistant = assistantText(continued);
      const assistantJson = latestAssistantJson(continued) ?? latestModelFinalJson(continued);
      const noProgressPause = continued.events.some(
        (event) => event.type === "model_no_progress" && event.payload?.status !== "retrying"
      );
      assertWithEvidence(continued.id === task.id, "follow-up changed task id", longEvidence);
      assertWithEvidence(continued.status === "paused", `expected rollback-invalidated verification to pause the task, got ${continued.status}`, longEvidence);
      assertWithEvidence(
        /verification evidence is required|remaining required command/i.test(assistant) || noProgressPause,
        "rollback-invalidated follow-up did not produce a clear verification or no-progress blocker",
        longEvidence
      );
      assertWithEvidence(summaries.length > 0 || continued.events.some((event) => event.type === "conversation_summary_created"), "long follow-up did not compact context", longEvidence);
      assertWithEvidence(editedPaths.some((value) => value.endsWith("src/math.mjs")), "task evidence omitted src/math.mjs edit", longEvidence);
      assertWithEvidence(editedPaths.some((value) => value.endsWith("src/totals.mjs")), "task evidence omitted src/totals.mjs edit", longEvidence);
      assertWithEvidence(
        followUpToolRequests.every((event) => event.payload?.toolName === "read_file" || event.payload?.toolName === "plan_update"),
        "follow-up called tools other than read_file or internal plan_update",
        longEvidence
      );
      assertWithEvidence(followUpReadPaths.every((path) => path.endsWith("src/math.mjs") || path.endsWith("src/totals.mjs")), "follow-up re-read files outside the allowed rollback scope", longEvidence);
      assertWithEvidence(followUpReadPaths.some((path) => path.endsWith("src/math.mjs")), "follow-up did not re-read src/math.mjs after rollback", longEvidence);
      assertWithEvidence(followUpReadPaths.some((path) => path.endsWith("src/totals.mjs")), "follow-up did not re-read src/totals.mjs after rollback", longEvidence);
      if (assistantJson) {
        longEvidence.parsedJson = true;
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
      } else {
        longEvidence.parsedJson = false;
        assertWithEvidence(noProgressPause, "follow-up produced neither structured rollback evidence nor an auditable no-progress pause", longEvidence);
      }
      assertWithEvidence(assistant.includes("LONG-FOLLOW-UP-MARKER") || summaries.length > 0, "long follow-up lost the compaction marker context", longEvidence);
      assertWithEvidence(Number(longEvidence.traceMaxEntryBytes ?? 0) <= 20_000, "trace entries grew beyond the long-task budget", longEvidence);
      assertWithEvidence(Number(longEvidence.traceBytes ?? 0) <= 450_000, "trace output grew beyond the long-task budget", longEvidence);
      return { status: "passed", evidence: longEvidence };
    } finally {
      fixture.cleanup();
    }
  }, { timeoutMs: 300_000 });
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
  const prompts = [
    {
      marker: "MEMORY_SMOKE_ALPHA",
      text: "请不要使用任何工具。请用不少于 80 个汉字回答，并包含 MEMORY_SMOKE_ALPHA：说明 Agent Workbench 在维护任务记录时为什么需要保留可验证证据。"
    },
    {
      marker: "MEMORY_SMOKE_BETA",
      text: "请不要使用任何工具。请用不少于 80 个汉字回答，并包含 MEMORY_SMOKE_BETA：说明 Agent Workbench 在维护工具权限时为什么需要避免普通任务直接生成技能。"
    }
  ];
  const tasks = [];
  for (const [index, item] of prompts.entries()) {
    const task = await workbench.createTask(item.text, `Live memory ${index + 1}`);
    const assistant = assistantText(task);
    assert(task.status === "completed", `memory task ${index + 1} ended as ${task.status}`);
    assert(assistant.replace(/\s/gu, "").length >= 40, `memory task ${index + 1} produced an underspecified answer`);
    tasks.push(task);
  }
  const memories = await workbench.listTaskMemories();
  const skills = await workbench.listSkills();
  const memoryTaskIds = new Set(memories.map((memory) => memory.taskId));
  for (const task of tasks) {
    assert(memoryTaskIds.has(task.id), `missing memory for completed task ${task.id}`);
  }
  assert(skills.length === 0, `ordinary tasks directly created ${skills.length} skills`);
  return {
    status: "passed",
    evidence: {
      memories: memories.length,
      skills: skills.length,
      taskIds: tasks.map((task) => task.id),
      memoryTaskIds: [...memoryTaskIds]
    }
  };
}, { timeoutMs: 300_000 });

if (stressLevel >= 6) {
  await runCase("explicit file tool coverage", async () => {
    const fixture = createFixtureProject("file-tools");
    try {
      writeFixture(
        fixture.root,
        "src/search-target.mjs",
        "export const LIVE_FILE_TOOL_MARKER = 'AW-LIVE-FILE-TOOLS';\nexport function marker() {\n  return LIVE_FILE_TOOL_MARKER;\n}\n"
      );
      const { workbench, folderId } = await createLiveWorkbench(fixture.root);
      let task = await workbench.createTask(
        [
          "请严格按顺序验证当前项目文件工具：",
          "1. 调用 list_files 查看 src 目录。",
          "2. 调用 search_files 搜索 AW-LIVE-FILE-TOOLS。",
          "3. 调用 read_file 读取 src/search-target.mjs。",
          "4. 调用 write_file 新建 docs/file-tool-coverage.md，expectedHash 必须使用 __new__。",
          "不要使用 edit_file，不要运行命令。最终回答列出实际用到的工具和新文档路径。"
        ].join("\n"),
        "Live file tool coverage",
        folderId
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 10);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const toolNames = toolRequestNames(task);
        const docPath = join(fixture.root, "docs", "file-tool-coverage.md");
        const hasAllTools = ["list_files", "search_files", "read_file", "write_file"].every((toolName) => toolNames.includes(toolName));
        if (hasAllTools && existsSync(docPath)) break;
        task = await workbench.appendMessage(
          task.id,
          [
            "继续同一个任务，刚才还没有完成所有步骤。",
            "必须补齐缺失的文件工具调用：read_file 读取 src/search-target.mjs，并用 write_file 创建 docs/file-tool-coverage.md。",
            "不要重新开始，不要使用 edit_file，不要运行命令。最终回答列出实际已用工具。"
          ].join("\n")
        );
        task = await settleApprovals(workbench, task, () => "allow_for_task", 10);
      }
      const docPath = join(fixture.root, "docs", "file-tool-coverage.md");
      const doc = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
      const toolNames = toolRequestNames(task);
      const fileEvidence = evidence(task, {
        toolNames,
        docCreated: Boolean(doc),
        docExcerpt: excerpt(doc),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, fileEvidence);
      for (const expectedTool of ["list_files", "search_files", "read_file", "write_file"]) {
        assertWithEvidence(toolNames.includes(expectedTool), `missing ${expectedTool} tool call`, fileEvidence);
      }
      assertWithEvidence(!toolNames.includes("edit_file"), "used edit_file despite write_file-only instruction", fileEvidence);
      assertWithEvidence(doc.includes("AW-LIVE-FILE-TOOLS") || assistantText(task).includes("AW-LIVE-FILE-TOOLS"), "file marker was not carried into evidence or final answer", fileEvidence);
      return { status: "passed", evidence: fileEvidence };
    } finally {
      fixture.cleanup();
    }
  });

  await runCase("active skill use coverage", async () => {
    const { workbench } = await createLiveWorkbench();
    const skill = await workbench.createSkill({
      title: "Live Golden Runbook",
      body: [
        "# Live Golden Runbook",
        "",
        "When this runbook is used, the final answer must include SKILL-GOLDEN-RUNBOOK and mention that the guidance came from an active skill."
      ].join("\n"),
      status: "active",
      applicability: {
        description: "Use when the user asks for the live golden runbook marker.",
        keywords: ["golden", "runbook", "skill"]
      }
    });
    let task = await workbench.createTask(
      [
        `请先调用 use_skill 加载名为 ${skill.title} 的技能。`,
        "然后只用一句话回答，并包含精确文本 SKILL-GOLDEN-RUNBOOK。",
        "不要读取文件，不要运行命令。"
      ].join("\n"),
      "Live skill use"
    );
    task = await settleApprovals(workbench, task, () => "allow_for_task", 4);
    const toolNames = toolRequestNames(task);
    const skillEvidence = evidence(task, {
      skillId: skill.id,
      skillTitle: skill.title,
      toolNames,
      assistant: excerpt(assistantText(task))
    }).evidence;
    assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, skillEvidence);
    assertWithEvidence(toolNames.includes("use_skill"), "model did not call use_skill", skillEvidence);
    assertWithEvidence(assistantText(task).includes("SKILL-GOLDEN-RUNBOOK"), "assistant did not use the active skill marker", skillEvidence);
    return { status: "passed", evidence: skillEvidence };
  });

  await runCase("web search tool coverage", async () => {
    const { workbench } = await createLiveWorkbench(undefined, { webSearch: true });
    const searchServer = await createDeterministicSearchServer({
      results: [
        {
          title: "Agent Workbench Live Search Marker",
          url: "https://example.test/agent-workbench-live-search",
          snippet: "The live web search marker is AW-WEB-SEARCH-GOLDEN."
        }
      ]
    });
    try {
      await workbench.createWebSearchProvider({
        label: "Live deterministic search",
        kind: "custom",
        endpoint: searchServer.endpoint,
        enabled: true
      });
      let task = await workbench.createTask(
        [
          "请调用 web_search 搜索 Agent Workbench live search marker。",
          "最终回答必须包含精确文本 AW-WEB-SEARCH-GOLDEN，并说明这是来自搜索结果。",
          "如果 web_search 的 tool result 中包含该 marker，你必须逐字复制该 marker，不能只写泛化摘要。",
          "不要使用文件工具或命令。"
        ].join("\n"),
        "Live web search"
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 6);
      const toolNames = toolRequestNames(task);
      const outputs = toolOutputs(task).join("\n");
      const webEvidence = evidence(task, {
        toolNames,
        searchEvidence: excerpt(outputs, 1200),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, webEvidence);
      assertWithEvidence(toolNames.includes("web_search"), "model did not call web_search", webEvidence);
      assertWithEvidence(outputs.includes("AW-WEB-SEARCH-GOLDEN"), "web_search did not return the marker", webEvidence);
      assertWithEvidence(assistantText(task).includes("AW-WEB-SEARCH-GOLDEN"), "assistant did not use the web search marker", webEvidence);
      return { status: "passed", evidence: webEvidence };
    } finally {
      await searchServer.close();
    }
  });
}

if (stressLevel >= 7) {
  await runCase("repeated same-thread follow-up endurance", async () => {
    const { workbench } = await createLiveWorkbench();
    let task = await workbench.createTask("这是长跑多轮一致性检查的第 1 轮。请只用一句话回答，不要使用工具。", "Live repeated follow-up");
    const followUps = [
      "第 2 轮：继续保持同一个任务，只补充一个风险点，不要使用工具。",
      "第 3 轮：继续保持同一个任务，只补充一个验证点，不要使用工具。",
      "第 4 轮：继续保持同一个任务，只补充一个收尾判断，不要使用工具。"
    ];
    for (const followUp of followUps) {
      task = await workbench.appendMessage(task.id, followUp);
    }
    const tasks = await workbench.listTasks();
    const followEvidence = evidence(task, {
      taskCount: tasks.length,
      userMessages: task.events.filter((event) => event.type === "user_message").length,
      toolRequests: toolRequestNames(task),
      assistant: excerpt(assistantText(task))
    }).evidence;
    assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, followEvidence);
    assertWithEvidence(tasks.length === 1, `expected one task after repeated follow-up, got ${tasks.length}`, followEvidence);
    assertWithEvidence(task.events.filter((event) => event.type === "user_message").length === 4, "follow-up turns were not retained on the same thread", followEvidence);
    assertWithEvidence(toolRequestNames(task).length === 0, "no-tool follow-up endurance unexpectedly requested tools", followEvidence);
    return { status: "passed", evidence: followEvidence };
  });

  await runCase("long command output materialization", async () => {
    const fixture = createFixtureProject("long-output-live");
    try {
      const { workbench, folderId } = await createLiveWorkbench(fixture.root);
      let task = await workbench.createTask(
        [
          "请运行下面这个精确命令来生成长输出，然后总结工具是否将原文物化到 rawOutputRef：",
          "node -e \"for (let i = 0; i < 520; i++) console.log('LIVE-LONG-OUTPUT-' + i + '-' + 'x'.repeat(40))\"",
          "不要读取文件，不要修改文件。最终回答必须提到 rawOutputRef 或 output truncated。"
        ].join("\n"),
        "Live long output",
        folderId
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 6);
      const output = toolOutputs(task).join("\n");
      const longOutputEvidence = evidence(task, {
        outputEvidence: excerpt(output, 1800),
        assistant: excerpt(assistantText(task))
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, longOutputEvidence);
      assertWithEvidence(toolRequestNames(task).includes("run_command"), "model did not run the long output command", longOutputEvidence);
      assertWithEvidence(output.includes("rawOutputRef"), "long output was not materialized with rawOutputRef", longOutputEvidence);
      assertWithEvidence(output.includes("output truncated"), "long output summary did not record truncation", longOutputEvidence);
      return { status: "passed", evidence: longOutputEvidence };
    } finally {
      fixture.cleanup();
    }
  }, { timeoutMs: 300_000 });
}

if (stressLevel >= 8) {
  await runCase("concurrent no-tool task isolation", async () => {
    const { workbench } = await createLiveWorkbench();
    const [left, right] = await Promise.all([
      workbench.createTask("并发隔离检查 A：只回答 A-ISOLATED，不要使用工具。", "Live concurrent A"),
      workbench.createTask("并发隔离检查 B：只回答 B-ISOLATED，不要使用工具。", "Live concurrent B")
    ]);
    const tasks = await workbench.listTasks();
    const concurrentEvidence = {
      leftTaskId: left.id,
      rightTaskId: right.id,
      leftStatus: left.status,
      rightStatus: right.status,
      taskCount: tasks.length,
      leftAssistant: excerpt(assistantText(left)),
      rightAssistant: excerpt(assistantText(right)),
      leftToolRequests: toolRequestNames(left),
      rightToolRequests: toolRequestNames(right)
    };
    assertWithEvidence(left.id !== right.id, "concurrent tasks reused the same task id", concurrentEvidence);
    assertWithEvidence(left.status === "completed" && right.status === "completed", "concurrent no-tool tasks did not both complete", concurrentEvidence);
    assertWithEvidence(tasks.length === 2, `expected two concurrent tasks, got ${tasks.length}`, concurrentEvidence);
    assertWithEvidence(toolRequestNames(left).length === 0 && toolRequestNames(right).length === 0, "concurrent no-tool tasks unexpectedly requested tools", concurrentEvidence);
    return { status: "passed", evidence: concurrentEvidence };
  });

  await runCase("combined skill knowledge web search chain", async () => {
    const { workbench } = await createLiveWorkbench(undefined, { knowledge: true, webSearch: true });
    await workbench.grantGlobalPermission("workspace_read", "combined live verification");
    await workbench.grantGlobalPermission("network", "combined live verification");
    const skill = await workbench.createSkill({
      title: "Combined Live Verification Skill",
      body: [
        "# Combined Live Verification Skill",
        "",
        "When this skill is used, the final answer must include SKILL-COMBINED-MARKER."
      ].join("\n"),
      status: "active",
      applicability: {
        description: "Use when the user asks for combined live verification.",
        keywords: ["combined", "verification", "skill"]
      }
    });
    await workbench.createKnowledgeItem({
      kind: "memory",
      title: "Combined Live Knowledge Marker",
      sourceUri: "agent-workbench://live-smoke/combined-knowledge.md",
      tags: ["live-smoke", "combined"],
      content: "The combined live knowledge marker is COMBINED-KNOWLEDGE-MARKER."
    });
    const searchServer = await createDeterministicSearchServer({
      results: [
        {
          title: "Combined Live Web Marker",
          url: "https://example.test/combined-live-web-marker",
          snippet: "The combined live web marker is AW-COMBINED-WEB-MARKER."
        }
      ]
    });
    try {
      await workbench.createWebSearchProvider({
        label: "Combined deterministic search",
        kind: "custom",
        endpoint: searchServer.endpoint,
        enabled: true
      });
      let task = await workbench.createTask(
        [
          "请完成一次组合工具链验证：",
          `1. 调用 use_skill 加载名为 ${skill.title} 的技能。`,
          "2. 调用 knowledge_search 查询 COMBINED-KNOWLEDGE-MARKER。",
          "3. 调用 web_search 查询 Agent Workbench combined live web marker。",
          "最终回答必须逐字包含 SKILL-COMBINED-MARKER、COMBINED-KNOWLEDGE-MARKER、AW-COMBINED-WEB-MARKER。",
          "不要读取文件，不要运行命令。"
        ].join("\n"),
        "Live combined tools"
      );
      task = await settleApprovals(workbench, task, () => "allow_for_task", 10);
      const toolNames = toolRequestNames(task);
      const outputs = toolOutputs(task).join("\n");
      const assistant = assistantText(task);
      const combinedEvidence = evidence(task, {
        skillId: skill.id,
        toolNames,
        toolOutput: excerpt(outputs, 1800),
        assistant: excerpt(assistant)
      }).evidence;
      assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, combinedEvidence);
      for (const toolName of ["use_skill", "knowledge_search", "web_search"]) {
        assertWithEvidence(toolNames.includes(toolName), `combined chain did not call ${toolName}`, combinedEvidence);
      }
      for (const marker of ["SKILL-COMBINED-MARKER", "COMBINED-KNOWLEDGE-MARKER", "AW-COMBINED-WEB-MARKER"]) {
        assertWithEvidence(`${outputs}\n${assistant}`.includes(marker), `combined chain lost marker ${marker}`, combinedEvidence);
        assertWithEvidence(assistant.includes(marker), `assistant final answer omitted marker ${marker}`, combinedEvidence);
      }
      return { status: "passed", evidence: combinedEvidence };
    } finally {
      await searchServer.close();
    }
  });
}

await runCase("knowledge rag citation", async () => {
  const { workbench } = await createLiveWorkbench(undefined, { knowledge: true });
  await workbench.createKnowledgeItem({
    kind: "memory",
    title: "Agent Workbench Golden RAG Note",
    sourceUri: "agent-workbench://live-smoke/golden-rag-note.md",
    tags: ["live-smoke", "rag"],
    content: [
      "# Agent Workbench Golden RAG Note",
      "",
      "The live RAG marker is AGENT-WORKBENCH-GOLDEN-RAG.",
      "When asked about the golden marker, answer with the exact marker and cite this knowledge source."
    ].join("\n")
  });
  const directMatches = await workbench.searchKnowledge({ query: "AGENT-WORKBENCH-GOLDEN-RAG golden marker", projectId: "default", limit: 3 });
  const directEvidence = directMatches.map((match) => ({
    title: match.item.title,
    score: Number(match.score.toFixed(4)),
    excerpt: excerpt(match.chunk.content),
    citation: match.citation
  }));
  assertWithEvidence(
    directMatches.some((match) => match.chunk.content.includes("AGENT-WORKBENCH-GOLDEN-RAG")),
    "direct knowledge search did not retrieve the golden marker",
    { directMatches: directEvidence }
  );
  let task = await workbench.createTask(
    [
      "必须调用 knowledge_search 工具查询资料库中的 golden marker；不要在未调用工具时回答。",
      "回答必须包含精确文本 AGENT-WORKBENCH-GOLDEN-RAG，并说明引用了哪个知识来源。",
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
  assertWithEvidence(outputs.includes("AGENT-WORKBENCH-GOLDEN-RAG"), "knowledge_search did not return the golden marker", ragEvidence);
  assertWithEvidence(assistant.includes("AGENT-WORKBENCH-GOLDEN-RAG"), "assistant did not use the retrieved marker", ragEvidence);
  assertWithEvidence(citations > 0, "knowledge_search output did not include citation metadata", ragEvidence);
  return evidence(task, {
    citations,
    directMatches: directEvidence,
    assistant: excerpt(assistant),
    knowledgeEvidence: excerpt(outputs, 900)
  });
});
}

const failed = report.cases.filter((item) => item.status === "failed");
report.summary = {
  totalCases: report.cases.length,
  passedCases: report.cases.filter((item) => item.status === "passed").length,
  failedCases: failed.length
};
const { markdownPath } = await writeLiveSmokeReport(report);

if (failed.length > 0) {
  console.error(`Live Mimo smoke failed ${failed.length}/${report.cases.length} cases. Report: ${markdownPath}`);
} else {
  console.log(`Live Mimo smoke passed ${report.cases.length}/${report.cases.length}. Report: ${markdownPath}`);
}
await cleanupLiveSmokeResources();
if (process.env.AGENT_WORKBENCH_LIVE_MODEL_HANDLE_DIAGNOSTICS === "1") printActiveHandles();
process.exitCode = failed.length > 0 ? 1 : 0;

async function writeLiveSmokeReport(data) {
  const outDir = resolve("data", "test-reports", "live-model-smoke");
  const jsonPath = resolve(outDir, "report.json");
  const markdownPath = resolve(outDir, "report.md");
  await mkdir(outDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
  await writeFile(markdownPath, markdownReport(data), "utf8");
  return { jsonPath, markdownPath };
}

async function createLiveWorkbench(rootPath, options = {}) {
  const store = new InMemoryWorkbenchStore();
  const preferences = await store.getPreferences();
  await store.savePreferences({
    ...preferences,
    activeModelProviderId: config.providerId,
    defaultModel: config.model ?? "mimo-v2.5",
    providerBaseUrl: config.baseURL ?? "",
    showThinking: true,
    updatedAt: nowIso()
  });
  const contextAssembler = new ContextAssembler(store);
  const model = createModelClientFromEnvironment({
    contextAssembler,
    preferenceProvider: () => store.getPreferences(),
    providerResolver: hasCompleteProviderConfig(config) ? async () => ({
      ...(config.providerId ? { providerId: config.providerId } : {}),
      protocol: config.protocol ?? "openai_compatible",
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      model: config.model ?? "mimo-v2.5"
    }) : undefined
  });
  const fallbackTools = new ShellToolExecutor();
  const delegates = [
    ...(options.knowledge ? [new KnowledgeSearchToolExecutor(store)] : []),
    ...(options.webSearch ? [new WebSearchToolExecutor(store)] : [])
  ];
  const tools = delegates.length > 0 ? new CompositeToolExecutor(fallbackTools, delegates) : fallbackTools;
  const workbench = new AgentWorkbench({ store, contextAssembler, model, tools, traceRoot: liveTraceRoot });
  registerLiveCleanup(() => workbench.dispose());
  if (!rootPath) return { workbench, store, folderId: "default" };
  const folder = await workbench.createTaskFolder({ name: "Live fixture", rootPath });
  return { workbench, store, folderId: folder.id };
}

function registerLiveCleanup(cleanup) {
  liveCleanupTasks.push(cleanup);
}

async function cleanupLiveSmokeResources() {
  const failures = [];
  for (const cleanup of liveCleanupTasks.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(sanitizeError(error));
    }
  }
  if (failures.length > 0) {
    console.warn(`Live smoke cleanup completed with ${failures.length} warning(s): ${failures.slice(0, 3).join(" | ")}`);
  }
}

function printActiveHandles() {
  const getHandles = process._getActiveHandles;
  if (typeof getHandles !== "function") return;
  const handles = getHandles.call(process).map((handle) => handle?.constructor?.name ?? typeof handle);
  console.warn(`Active handles after cleanup: ${handles.length}${handles.length ? ` (${handles.join(", ")})` : ""}`);
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

async function runCase(name, fn, options = {}) {
  const started = Date.now();
  const attempts = Math.max(1, Number(options.attempts ?? maxTransientCaseAttempts) || 1);
  const failedAttempts = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStarted = Date.now();
    try {
      const result = await withTimeout(fn(), options.timeoutMs ?? 180_000, name);
      const evidencePayload = result?.evidence ?? result ?? {};
      assertTraceBudgets(evidencePayload);
      if (failedAttempts.length > 0) {
        evidencePayload.transientRetries = failedAttempts.map(summarizeFailedAttempt);
      }
      report.cases.push({
        name,
        status: "passed",
        durationMs: Date.now() - started,
        evidence: evidencePayload
      });
      await writeLiveSmokeReport(refreshSummary(report));
      console.log(`PASS ${name}${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
      return;
    } catch (error) {
      const evidencePayload = error instanceof EvidenceError ? error.evidence : {};
      const failureClass = classifyFailure(name, error, evidencePayload);
      const failedAttempt = {
        attempt,
        durationMs: Date.now() - attemptStarted,
        failureClass,
        error: sanitizeError(error),
        evidence: evidencePayload
      };
      failedAttempts.push(failedAttempt);
      if (attempt < attempts && isTransientProviderFailure(failureClass, error, evidencePayload)) {
        const delayMs = transientRetryBaseMs * attempt;
        console.warn(`RETRY ${name} after transient ${failureClass} failure on attempt ${attempt}/${attempts}; waiting ${delayMs}ms.`);
        await sleep(delayMs);
        continue;
      }
      report.cases.push({
        name,
        status: "failed",
        durationMs: Date.now() - started,
        failureClass,
        error: sanitizeError(error),
        evidence: {
          ...evidencePayload,
          transientRetries: failedAttempts.map(summarizeFailedAttempt)
        }
      });
      await writeLiveSmokeReport(refreshSummary(report));
      console.error(`FAIL ${name} [${failureClass}]: ${sanitizeError(error)}`);
      return;
    }
  }
}

function refreshSummary(data) {
  const failed = data.cases.filter((item) => item.status === "failed");
  data.summary = {
    totalCases: data.cases.length,
    passedCases: data.cases.filter((item) => item.status === "passed").length,
    failedCases: failed.length
  };
  return data;
}

function evidence(task, extra = {}) {
  const toolRequests = task.events.filter((event) => event.type === "tool_requested").map((event) => ({
    toolName: event.payload?.toolName,
    riskCategory: event.payload?.riskCategory,
    argsPreview: event.payload?.argsPreview
  }));
  const noProgressEvents = task.events.filter((event) => event.type === "model_no_progress").map((event) => ({
    summary: event.summary,
    reason: event.payload?.reason,
    status: event.payload?.status,
    readOnlyToolCount: event.payload?.readOnlyToolCount,
    repeatedTargetCount: event.payload?.repeatedTargetCount,
    lastToolNames: event.payload?.lastToolNames
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
      noProgressEvents,
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

async function createDeterministicSearchServer(payload) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = JSON.stringify({
      ...payload,
      query: url.searchParams.get("q") ?? "",
      limit: url.searchParams.get("limit") ?? ""
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(body);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to start deterministic web search server.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/search?q={query}&limit={limit}`,
    close: () => closeServer(server)
  };
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function fixtureBehavior(fixtureRoot) {
  const version = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const math = await import(`${pathToFileURL(join(fixtureRoot, "src", "math.mjs")).href}?${version}`);
  const totals = await import(`${pathToFileURL(join(fixtureRoot, "src", "totals.mjs")).href}?${version}`);
  const sumGeneral = typeof math.sum === "function" ? math.sum([1, 4, 9]) : undefined;
  const averageGeneral = typeof math.average === "function" ? math.average([3, 6, 9]) : undefined;
  const totalGeneral = typeof totals.renderTotal === "function"
    ? totals.renderTotal([{ price: 1.25 }, { price: 2 }, { price: 3.5 }])
    : undefined;
  return {
    sumGeneral,
    averageGeneral,
    totalGeneral,
    mathGeneral: sumGeneral === 14 && averageGeneral === 6,
    totalsGeneral: totalGeneral === "$6.75"
  };
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

function latestAssistantJson(task) {
  for (const event of [...task.events].reverse()) {
    if (event.type !== "assistant_message") continue;
    const parsed = tryParseAssistantJson(event.payload?.blockedFinalMessage) ?? tryParseAssistantJson(event.summary);
    if (parsed) return parsed;
  }
  return null;
}

function latestModelFinalJson(task) {
  const tracePath = resolve(liveTraceRoot, task.id, "trace.jsonl");
  if (!existsSync(tracePath)) return null;
  const rows = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
  for (const row of rows.reverse()) {
    try {
      const event = JSON.parse(row);
      if (event.kind !== "model_turn_completed" || event.resultKind !== "final") continue;
      const parsed = tryParseAssistantJson(event.message);
      if (parsed) return parsed;
    } catch {
      // Ignore malformed or concurrently incomplete trace rows and continue to older evidence.
    }
  }
  return null;
}

function tryParseAssistantJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  for (const slice of extractBalancedJsonObjectCandidates(candidate)) {
    try {
      return JSON.parse(slice);
    } catch {
      // Try the next balanced object; model output can contain examples before the final JSON.
    }
  }
  return undefined;
}

function extractBalancedJsonObjectCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function hasCompleteProviderConfig(value) {
  return Boolean(value?.apiKey && value?.baseURL);
}

async function loadStoredModelProviderConfig() {
  for (const dbPath of candidateWorkbenchDbPaths()) {
    if (!existsSync(dbPath)) continue;
    const store = new SqliteWorkbenchStore(dbPath);
    try {
      const preferences = await store.getPreferences();
      const providers = (await store.listModelProviders()).filter((provider) => provider.enabled !== false);
      const preferredIds = [
        preferences.activeModelProviderId,
        ...providers.map((provider) => provider.id)
      ].filter((id, index, all) => typeof id === "string" && id.length > 0 && all.indexOf(id) === index);
      for (const providerId of preferredIds) {
        const provider = providers.find((item) => item.id === providerId);
        if (!provider?.apiKeyRef) continue;
        const secret = await store.getModelProviderSecret(provider.id);
        if (!secret) continue;
        const apiKey = new LocalSecretBox(join(dirname(dbPath), "local-secret.key")).decrypt(secret);
        if (!apiKey || !provider.baseUrl) continue;
        return {
          providerId: provider.id,
          protocol: provider.protocol ?? "openai_compatible",
          apiKey,
          baseURL: provider.baseUrl,
          model: provider.defaultModelId ?? preferences.defaultModel ?? "mimo-v2.5",
          source: "sqlite",
          dbPath
        };
      }
    } catch (error) {
      console.warn(`Skipping stored provider config from ${toRelative(dbPath)}: ${sanitizeError(error)}`);
    } finally {
      store.close();
    }
  }
  return null;
}

async function checkProviderPreflight(providerConfig) {
  const started = Date.now();
  try {
    const endpoint = providerEndpoint(providerConfig.baseURL, "chat/completions");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: providerConfig.model ?? "mimo-v2.5",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (response.ok) {
      return { ok: true, durationMs: Date.now() - started, statusCode: response.status };
    }
    const body = await response.text();
    return {
      ok: false,
      durationMs: Date.now() - started,
      statusCode: response.status,
      failureClass: classifyProviderStatus(response.status, body),
      error: providerPreflightError(response.status, body)
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      failureClass: "provider_transient",
      error: `Provider preflight request failed: ${sanitizeError(error)}`
    };
  }
}

function providerEndpoint(baseURL, route) {
  const normalizedBase = String(baseURL ?? "").replace(/\/+$/, "");
  return `${normalizedBase}/${route}`;
}

function classifyProviderStatus(status, body) {
  const text = String(body ?? "").toLowerCase();
  if (status === 429 || /rate.?limit|too many requests/u.test(text)) return "rate_limit";
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden/u.test(text)) return "provider_configuration";
  if (status >= 500) return "provider_transient";
  return "provider_configuration";
}

function providerPreflightError(status, body) {
  const text = sanitizeError(String(body ?? "")).replace(/\s+/g, " ").trim();
  const suffix = text ? `: ${text.slice(0, 500)}` : "";
  return `Provider preflight failed with HTTP ${status}${suffix}`;
}

function candidateWorkbenchDbPaths() {
  const configured = process.env.AGENT_WORKBENCH_DB_PATH ?? process.env.SCC_DB_PATH;
  return [
    configured ? resolve(configured) : null,
    resolve("data", "workbench.sqlite"),
    resolve("apps", "server", "data", "workbench.sqlite")
  ].filter((value, index, all) => value && all.indexOf(value) === index);
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

function toolRequestNames(task) {
  return task.events.filter((event) => event.type === "tool_requested").map((event) => String(event.payload?.toolName ?? ""));
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
  const tracePath = resolve(liveTraceRoot, task.id, "trace.jsonl");
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
  if (typeof evidencePayload.tracePath === "string") {
    assertWithEvidence(Number(evidencePayload.traceLines ?? 0) > 0, "trace output was not captured for a model-backed live smoke case", evidencePayload);
    assertWithEvidence(typeof evidencePayload.traceArtifactPath === "string" && evidencePayload.traceArtifactPath.length > 0, "trace artifact was not copied for a model-backed live smoke case", evidencePayload);
  }
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

function toRelative(filePath) {
  return filePath.replace(`${root}\\`, "").replaceAll("\\", "/");
}

function markdownReport(data) {
  const lines = [
    "# Agent Workbench Live Mimo Smoke",
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
  const evidenceText = `${evidencePayload?.assistant ?? ""} ${evidencePayload?.error ?? ""}`.toLowerCase();
  if (/429|too many requests|rate.?limit/u.test(`${message} ${evidenceText}`)) return "rate_limit";
  if (/timeout|timed out|econnreset|etimedout|provider unavailable|model provider failed/u.test(`${message} ${evidenceText}`)) return "provider_transient";
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

function isTransientProviderFailure(failureClass, error, evidencePayload) {
  if (failureClass === "rate_limit" || failureClass === "provider_transient") return true;
  const text = `${sanitizeError(error)} ${evidencePayload?.assistant ?? ""} ${evidencePayload?.error ?? ""}`;
  return /429|too many requests|rate.?limit|timeout|timed out|econnreset|etimedout/i.test(text);
}

function summarizeFailedAttempt(item) {
  return {
    attempt: item.attempt,
    durationMs: item.durationMs,
    failureClass: item.failureClass,
    error: item.error,
    ...(item.evidence?.taskId ? { taskId: item.evidence.taskId } : {}),
    ...(item.evidence?.status ? { status: item.evidence.status } : {}),
    ...(item.evidence?.assistant ? { assistant: excerpt(item.evidence.assistant, 500) } : {})
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
