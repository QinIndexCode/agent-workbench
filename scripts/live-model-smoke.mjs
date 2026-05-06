import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (process.env.SCC_LIVE_MODEL_SMOKE !== "1") {
  console.log("Skipping live model smoke. Set SCC_LIVE_MODEL_SMOKE=1 to run it.");
  process.exit(0);
}

const {
  AgentWorkbench,
  ContextAssembler,
  createModelClientFromEnvironment,
  InMemoryWorkbenchStore,
  loadOpenAiConfig,
  nowIso,
  ShellToolExecutor
} = await import("../packages/core/dist/index.js");

const config = loadOpenAiConfig();
if (!config.apiKey || !config.baseURL) {
  throw new Error("Live model smoke requires a configured local Mimo/OpenAI-compatible provider.");
}

const report = {
  generatedAt: nowIso(),
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
    const debugEvidence = evidence(task, {
      fixed: source.includes("reduce"),
      testsPassed: toolOutput.includes("math tests passed"),
      assistant: excerpt(assistant),
      sourceExcerpt: excerpt(source)
    }).evidence;
    assertWithEvidence(task.status === "completed", `expected completed, got ${task.status}`, debugEvidence);
    assertWithEvidence(source.includes("reduce") || toolOutput.includes("math tests passed"), "fixture was not fixed or tests did not pass", debugEvidence);
    assertWithEvidence(/numbers\.length|数组长度|length/i.test(assistant), "debug summary did not mention the observed length-based bug", debugEvidence);
    assertWithEvidence(!/乘法|multiply|multiplication/i.test(assistant), "debug summary speculated about multiplication instead of observed evidence", debugEvidence);
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

const failed = report.cases.filter((item) => item.status === "failed");
const outDir = resolve("data", "test-reports", "live-model-smoke");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
await writeFile(resolve(outDir, "report.md"), markdownReport(report), "utf8");

if (failed.length > 0) {
  console.error(`Live Mimo smoke failed ${failed.length}/${report.cases.length} cases. Report: ${resolve(outDir, "report.md")}`);
  process.exit(1);
}

console.log(`Live Mimo smoke passed ${report.cases.length}/${report.cases.length}. Report: ${resolve(outDir, "report.md")}`);

async function createLiveWorkbench(rootPath) {
  const store = new InMemoryWorkbenchStore();
  const preferences = await store.getPreferences();
  await store.savePreferences({
    ...preferences,
    defaultModel: config.model ?? "mimo-v2.5",
    providerBaseUrl: config.baseURL ?? "",
    reflectionEnabled: false,
    showThinking: true,
    updatedAt: nowIso()
  });
  const contextAssembler = new ContextAssembler(store);
  const model = createModelClientFromEnvironment({
    contextAssembler,
    preferenceProvider: () => store.getPreferences()
  });
  const workbench = new AgentWorkbench({ store, contextAssembler, model, tools: new ShellToolExecutor() });
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
    report.cases.push({
      name,
      status: "passed",
      durationMs: Date.now() - started,
      evidence: result.evidence ?? result
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.cases.push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      error: sanitizeError(error),
      evidence: error instanceof EvidenceError ? error.evidence : {}
    });
    console.error(`FAIL ${name}: ${sanitizeError(error)}`);
  }
}

function evidence(task, extra = {}) {
  const toolRequests = task.events.filter((event) => event.type === "tool_requested").map((event) => ({
    toolName: event.payload?.toolName,
    riskCategory: event.payload?.riskCategory,
    argsPreview: event.payload?.argsPreview
  }));
  return {
    status: "passed",
    evidence: {
      taskId: task.id,
      status: task.status,
      workRoot: task.workRoot,
      assistant: excerpt(assistantText(task), 900),
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

function writeFixture(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function assistantText(task) {
  return task.events.filter((event) => event.type === "assistant_message").map((event) => event.summary).join("\n");
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

function excerpt(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertWithEvidence(condition, message, evidencePayload) {
  if (!condition) throw new EvidenceError(message, evidencePayload);
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
  const lines = ["# SCC Live Mimo Smoke", "", `Generated: ${data.generatedAt}`, "", `Provider: ${data.provider.baseURL}`, `Model: ${data.provider.model}`, ""];
  for (const item of data.cases) {
    lines.push(`## ${item.status === "passed" ? "PASS" : "FAIL"} ${item.name}`);
    lines.push("");
    lines.push(`Duration: ${item.durationMs}ms`);
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
      lines.push(JSON.stringify(item.evidence, null, 2).slice(0, 6000));
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
