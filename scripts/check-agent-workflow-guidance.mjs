import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const contextPath = resolve(root, "packages", "core", "src", "context-assembler.ts");
const taskGraphPath = resolve(root, "packages", "core", "src", "task-graph.ts");
const workbenchPath = resolve(root, "packages", "core", "src", "workbench.ts");
const docsPath = resolve(root, "docs", "agent-workflow.md");
const matrixPath = resolve(root, "tests", "real-task-matrix", "matrix.test.ts");
const qualityPath = resolve(root, "scripts", "run-quality-suite.mjs");
const reportWriterPath = resolve(root, "scripts", "write-release-report.mjs");
const e2eRunnerPath = resolve(root, "scripts", "run-e2e.mjs");
const liveHttpPath = resolve(root, "scripts", "live-agent-http-resume-verifier.mjs");
const sweStylePath = resolve(root, "scripts", "swe-bench-style-agent-eval.mjs");
const ciWorkflowPath = resolve(root, ".github", "workflows", "ci.yml");
const liveQualityWorkflowPath = resolve(root, ".github", "workflows", "live-quality.yml");

const context = readFileSync(contextPath, "utf8");
const taskGraph = readFileSync(taskGraphPath, "utf8");
const workbench = readFileSync(workbenchPath, "utf8");
const docs = readFileSync(docsPath, "utf8");
const matrix = readFileSync(matrixPath, "utf8");
const quality = readFileSync(qualityPath, "utf8");
const reportWriter = readFileSync(reportWriterPath, "utf8");
const e2eRunner = readFileSync(e2eRunnerPath, "utf8");
const liveHttp = readFileSync(liveHttpPath, "utf8");
const sweStyle = readFileSync(sweStylePath, "utf8");
const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
const liveQualityWorkflow = readFileSync(liveQualityWorkflowPath, "utf8");

assertIncludes(context, [
  "Agent Workflow Heuristics",
  "decision heuristics, not a hard checklist",
  "Do not force tools, plans, tests",
  "Never hardcode behavior to satisfy a particular test prompt",
  "strongest practical proof",
  "Complete when current evidence supports the preserved acceptance criteria at a level proportional to risk"
], contextPath);

assertIncludes(taskGraph, [
  "compileTaskGraph",
  "isDirectAnswerGoal",
  "hasImplementationIntent",
  "hasHighBlastRadius",
  "Active acceptance criteria",
  "Avoid hardcoded behavior that only satisfies one prompt"
], taskGraphPath);

assertIncludes(workbench, ["attachCompiledTaskGraph", "compileTaskGraph(task)", "source: \"compiled\""], workbenchPath);

assertIncludes(docs, [
  "not a rigid checklist",
  "Workflow Ladder",
  "Task Graph Compiler",
  "Simple chat, greetings, and capability questions do not get a graph",
  "Verification Ladder",
  "Live HTTP resume verifier",
  "SWE-bench-style agent evaluation",
  "Do not force tools, plans, tests",
  "Never hardcode behavior",
  "quality:full",
  "quality:release",
  "Anti-Overconstraint Guardrails"
], docsPath);

assertIncludes(matrix, [
  "safe tool inventory wording",
  "read-only diagnosis",
  "vague debug request",
  "ask_user",
  "custom shell denied",
  "auto approval with llm review"
], matrixPath);

assertIncludes(quality, ["--release", "agent-workflow", "live-agent-http-resume", "swe-bench-style-agent", "AGENT_WORKBENCH_SWE_BENCH_STYLE", "AGENT_WORKBENCH_RELEASE_REPORT_REQUIRED", "localDateStamp", "hasFreshArtifact"], qualityPath);
assertNotIncludes(quality, ["new Date().toISOString().slice(0, 10)"], qualityPath);
assertIncludes(reportWriter, [
  "live-agent-http-resume",
  "Live HTTP resume report is missing",
  "Live HTTP Resume",
  "rollback restored files",
  "Live HTTP resume verifier is"
], reportWriterPath);
assertIncludes(reportWriter, [
  "swe-bench-style",
  "SWE-bench-style agent evaluation report is missing",
  "SWE-bench-style Agent Evaluation",
  "SWE-bench-style repair failed"
], reportWriterPath);
assertIncludes(e2eRunner, ["PLAYWRIGHT_EXTERNAL_SERVERS", "--project=desktop", "--project=mobile"], e2eRunnerPath);
assertNotIncludes(e2eRunner, ["writeRunnerResults", "runner-passed", "scheduleCompletedProcessStop"], e2eRunnerPath);
assertIncludes(liveHttp, [
  "createApp",
  "/api/session/bootstrap",
  "/api/tasks",
  "/api/tasks/${taskId}/messages",
  "/api/tasks/${task.id}/approvals/${approval.id}",
  "/api/tasks/${taskId}/rollback/preview",
  "/api/tasks/${taskId}/rollback",
  "AGENT_WORKBENCH_DB_PATH",
  "AGENT_WORKBENCH_DEFAULT_TASK_ROOT"
], liveHttpPath);
assertIncludes(sweStyle, [
  "SWE-bench-style",
  "AGENT_WORKBENCH_SWE_BENCH_STYLE",
  "runMode: \"target\"",
  "hidden behavior",
  "Do not hardcode behavior for the visible test strings",
  "edit_file",
  "write_file",
  "promptCache"
], sweStylePath);
assertIncludes(ciWorkflow, [
  "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24",
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "actions/upload-artifact@v6"
], ciWorkflowPath);
assertIncludes(liveQualityWorkflow, [
  "Resolve live smoke configuration",
  "steps.live_smoke.outputs.configured == 'true'",
  "missing_live_model_secrets",
  "data/test-reports/live-model-smoke/skip.json",
  "AGENT_WORKBENCH_LIVE_MODEL_REQUIRED: \"1\"",
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "actions/upload-artifact@v6"
], liveQualityWorkflowPath);
assertNotIncludes(ciWorkflow, ["actions/checkout@v4", "actions/checkout@v5", "actions/setup-node@v4", "actions/upload-artifact@v4"], ciWorkflowPath);
assertNotIncludes(liveQualityWorkflow, ["actions/checkout@v4", "actions/checkout@v5", "actions/setup-node@v4", "actions/upload-artifact@v4", "throw \"Missing secret"], liveQualityWorkflowPath);

console.log("Agent workflow guidance validation passed.");

function assertIncludes(source, needles, filePath) {
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${filePath} is missing required workflow guidance evidence: ${missing.join(", ")}`);
  }
}

function assertNotIncludes(source, needles, filePath) {
  const present = needles.filter((needle) => source.includes(needle));
  if (present.length > 0) {
    throw new Error(`${filePath} contains stale workflow guidance anti-patterns: ${present.join(", ")}`);
  }
}
