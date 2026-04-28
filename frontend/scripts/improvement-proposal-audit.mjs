import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const MODE = (process.env.FRONTEND_IMPROVEMENT_AUDIT_MODE ?? "full").trim().toLowerCase();
const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5873";
const BACKEND_URL = process.env.FRONTEND_IMPROVEMENT_AUDIT_BACKEND_URL ?? "http://127.0.0.1:3911";
const MOCK_PROVIDER_URL = process.env.FRONTEND_IMPROVEMENT_AUDIT_MOCK_PROVIDER_URL ?? "http://127.0.0.1:4311";
const REPORT_PATH =
  process.env.FRONTEND_IMPROVEMENT_AUDIT_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", `frontend-${MODE === "instruction-skill" ? "instruction-skill-proposal-audit" : "improvement-proposal-audit"}.json`);
const SCREENSHOT_DIR =
  process.env.FRONTEND_IMPROVEMENT_AUDIT_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", `frontend-${MODE === "instruction-skill" ? "instruction-skill-proposal-audit" : "improvement-proposal-audit"}`);

function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return Boolean(candidate && fsSync.existsSync(candidate));
    } catch {
      return false;
    }
  });
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `${init?.method ?? "GET"} ${url} failed with ${response.status}`);
  }
  return payload;
}

async function waitFor(condition, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await condition();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.errorMessage ?? "Timed out waiting for condition.");
}

async function patchConfig(patch) {
  return requestJson(`${BACKEND_URL}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function ensureMockProvider() {
  const providerId = "mock-e2e";
  await requestJson(`${BACKEND_URL}/providers/${providerId}`, {
    method: "PUT",
    body: JSON.stringify({
      id: providerId,
      label: "Mock E2E Provider",
      vendor: "custom",
      transport: "openai-compatible",
      baseUrl: `${MOCK_PROVIDER_URL}/v1`,
      model: "mock-e2e-model",
      auth: { scheme: "none" },
      metadata: { variantId: "improvement-audit" },
    }),
  });
  await requestJson(`${BACKEND_URL}/providers/${providerId}/default`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function resetMockProvider(responses) {
  await requestJson(`${MOCK_PROVIDER_URL}/__admin/reset`, {
    method: "POST",
    body: JSON.stringify({ responses }),
  });
}

async function submitTask(input) {
  const response = await requestJson(`${BACKEND_URL}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.command?.taskId ?? response.task?.definition?.taskId ?? null;
}

async function startTask(taskId, userMessage = "") {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/start`, {
    method: "POST",
    body: JSON.stringify({ userMessage }),
  });
}

async function getTask(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}`);
}

async function getProposal(proposalId) {
  return requestJson(`${BACKEND_URL}/improvements/proposals/${proposalId}`);
}

async function listProposals() {
  return requestJson(`${BACKEND_URL}/improvements/proposals`);
}

async function listArchive() {
  return requestJson(`${BACKEND_URL}/improvements/archive`);
}

async function getComplexReport() {
  return requestJson(`${BACKEND_URL}/improvements/report`);
}

async function listMemories() {
  return requestJson(`${BACKEND_URL}/memories`);
}

async function listSkills() {
  return requestJson(`${BACKEND_URL}/skills`);
}

async function captureScreenshot(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
}

function createTaskOutput(summary, details, artifact) {
  return [
    `[AGENT-001_OUTPUT]${JSON.stringify({ summary, artifact, details, issues: [] })}[/AGENT-001_OUTPUT]`,
    JSON.stringify({
      current_unit: "AGENT-001",
      tool_name: "write_file",
      arguments: {
        path: artifact,
        content: `# ${summary}\n`,
      },
    }),
    JSON.stringify({
      current_unit: "AGENT-001",
      status: "COMPLETE",
      progress_percent: 100,
      decision: "CONTINUE",
      reason: "done",
      next_unit: null,
      files_created: [artifact],
    }),
  ].join("\n");
}

async function main() {
  const executablePath = resolveChromeExecutable();
  assertCondition(executablePath, "Chrome executable not found for frontend improvement audit.");

  await patchConfig({
    tools: { permissionMode: "full" },
  });
  await ensureMockProvider();
  await resetMockProvider([
    createTaskOutput("Prepared reusable checklist alpha.", "Checklist alpha is ready for reuse.", "reports/checklist-alpha.md"),
    createTaskOutput("Prepared reusable checklist beta.", "Checklist beta is ready for reuse.", "reports/checklist-beta.md"),
  ]);

  const baseTaskInput = {
    preferredProviderId: "mock-e2e",
    units: [{
      id: "AGENT-001",
      role: "Writer",
      goal: "Create a reusable checklist pattern.",
      outputContract: "{\"summary\":\"string\",\"artifact\":\"string\",\"details\":\"string\",\"issues\":[]}",
      executionProfileId: "implement",
      dependencies: [],
    }],
  };

  const firstTaskId = await submitTask({
    title: "Improvement proposal alpha",
    intent: "Create a reusable checklist pattern for proposal generation.",
    ...baseTaskInput,
  });
  assertCondition(firstTaskId, "Failed to create first improvement-audit task.");
  await startTask(firstTaskId, "Create the first reusable checklist artifact and keep the path visible.");

  const secondTaskId = await submitTask({
    title: "Improvement proposal beta",
    intent: "Repeat a reusable checklist pattern so instruction-skill proposals can be generated.",
    ...baseTaskInput,
  });
  assertCondition(secondTaskId, "Failed to create second improvement-audit task.");
  await startTask(secondTaskId, "Repeat the reusable checklist artifact pattern so it can be learned.");

  const firstTask = await waitFor(async () => {
    const task = await getTask(firstTaskId);
    return task.runtime?.lifecycleStatus === "COMPLETED" ? task : null;
  }, {
    timeoutMs: 30_000,
    errorMessage: "Timed out waiting for the first task to complete.",
  });

  const secondTask = await waitFor(async () => {
    const task = await getTask(secondTaskId);
    return task.runtime?.lifecycleStatus === "COMPLETED" ? task : null;
  }, {
    timeoutMs: 30_000,
    errorMessage: "Timed out waiting for the second task to complete.",
  });

  let lastProposalSnapshot = null;
  const allProposals = await waitFor(async () => {
    const proposals = await listProposals();
    lastProposalSnapshot = proposals.map((proposal) => ({
      proposalId: proposal.proposalId,
      taskId: proposal.taskId,
      kind: proposal.kind,
      archiveEligible: proposal.archiveEligible,
      duplicateOfProposalId: proposal.duplicateOfProposalId,
      conflictsWithProposalIds: proposal.conflictsWithProposalIds,
    }));
    const lesson = proposals.find((proposal) => proposal.taskId === firstTaskId && proposal.kind === "lesson")
      ?? proposals.find((proposal) => proposal.taskId === secondTaskId && proposal.kind === "lesson");
    const skill = proposals.find((proposal) => proposal.taskId === secondTaskId && proposal.kind === "instruction_skill");
    if (MODE === "instruction-skill") {
      return skill ? proposals : null;
    }
    return lesson && skill ? proposals : null;
  }, {
    timeoutMs: 30_000,
    errorMessage: `Timed out waiting for terminal task proposals. Snapshot=${JSON.stringify(lastProposalSnapshot)}`,
  });
  const lessonProposal = allProposals.find((proposal) => proposal.taskId === firstTaskId && proposal.kind === "lesson")
    ?? allProposals.find((proposal) => proposal.taskId === secondTaskId && proposal.kind === "lesson");
  const skillProposal = allProposals.find((proposal) => proposal.taskId === secondTaskId && proposal.kind === "instruction_skill");
  assertCondition(Boolean(skillProposal), "Instruction-skill proposal was not generated.");
  if (MODE !== "instruction-skill") {
    assertCondition(Boolean(lessonProposal), "Lesson proposal was not generated.");
  }
  assertCondition(skillProposal?.archiveEligible === true, "Instruction-skill proposal must be archive eligible.");
  if (lessonProposal) {
    assertCondition(lessonProposal.archiveEligible === true, "Lesson proposal must be archive eligible.");
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const screenshots = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

    await page.goto(`${BASE_URL}/tasks?task=${secondTaskId}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="tasks-page"]');
    await page.waitForSelector('[data-testid="task-detail-pane"]');
    await page.waitForSelector('[data-testid="task-proposal-instruction_skill"]');
    screenshots.task = await captureScreenshot(page, MODE === "instruction-skill" ? "instruction-skill-task" : "improvement-task-skill");

    if (MODE !== "instruction-skill") {
      await page.goto(`${BASE_URL}/tasks?task=${firstTaskId}`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="tasks-page"]');
      await page.waitForSelector('[data-testid="task-detail-pane"]');
      await page.waitForSelector('[data-testid="task-proposal-lesson"]');
      screenshots.taskLesson = await captureScreenshot(page, "improvement-task-lesson");
    }

    await page.goto(`${BASE_URL}/settings/improvements`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="settings-page"]');
    await page.waitForSelector('[data-testid="settings-improvements-filter-pending"]');
    await page.click('[data-testid="settings-improvements-filter-pending"]');
    await page.waitForTimeout(300);
    await page.waitForSelector(`[data-testid="settings-improvement-${skillProposal.proposalId}"]`);
    if (MODE !== "instruction-skill") {
      await page.waitForSelector(`[data-testid="settings-improvement-${lessonProposal.proposalId}"]`);
    }
    screenshots.settingsPending = await captureScreenshot(
      page,
      MODE === "instruction-skill" ? "instruction-skill-settings-pending" : "improvement-settings-pending",
    );

    if (MODE !== "instruction-skill") {
      await page.click(`[data-testid="settings-improvement-approve-${lessonProposal.proposalId}"]`);
      await waitFor(async () => {
        const proposal = await getProposal(lessonProposal.proposalId);
        return proposal.status === "APPROVED" ? proposal : null;
      }, {
        timeoutMs: 20_000,
        errorMessage: "Timed out waiting for lesson proposal approval.",
      });
    }

    await page.click(`[data-testid="settings-improvement-approve-${skillProposal.proposalId}"]`);
    await waitFor(async () => {
      const proposal = await getProposal(skillProposal.proposalId);
      return proposal.status === "APPROVED" ? proposal : null;
    }, {
      timeoutMs: 20_000,
      errorMessage: "Timed out waiting for instruction-skill proposal approval.",
    });

    await page.click('[data-testid="settings-improvements-filter-approved"]');
    await page.waitForTimeout(300);
    screenshots.settingsApproved = await captureScreenshot(
      page,
      MODE === "instruction-skill" ? "instruction-skill-settings-approved" : "improvement-settings-approved",
    );
  } finally {
    await browser.close();
  }

  const [archive, complexReport, memories, skills, approvedSkillProposal] = await Promise.all([
    listArchive(),
    getComplexReport(),
    listMemories(),
    listSkills(),
    getProposal(skillProposal.proposalId),
  ]);
  const approvedLessonProposal = MODE === "instruction-skill" || !lessonProposal
    ? null
    : await getProposal(lessonProposal.proposalId);

  const lessonMemory = MODE === "instruction-skill" || !lessonProposal
    ? null
    : memories.find((memory) => memory.metadata?.proposalId === lessonProposal.proposalId) ?? null;
  const generatedSkill = skills.find((entry) => entry.skill.id === skillProposal.proposalId) ?? null;

  if (MODE !== "instruction-skill") {
    assertCondition(Boolean(lessonMemory), "Approved lesson proposal did not materialize a lesson memory.");
    assertCondition(approvedLessonProposal?.status === "APPROVED", "Lesson proposal did not remain approved.");
  }
  assertCondition(Boolean(generatedSkill), "Approved instruction-skill proposal did not materialize a generated skill.");
  assertCondition(Boolean(approvedSkillProposal.instructionSkillProposal?.materializedRootDir), "Instruction-skill proposal did not record a materialized root.");
  assertCondition(Boolean(archive.find((entry) => entry.taskId === secondTaskId)), "Second task was not archived as a real task.");

  const report = {
    status: "achieved",
    mode: MODE,
    generatedAt: new Date().toISOString(),
    firstTaskId,
    secondTaskId,
    proposalIds: {
      lesson: lessonProposal?.proposalId ?? null,
      instructionSkill: skillProposal.proposalId,
    },
    archiveEntryIds: archive
      .filter((entry) => [firstTaskId, secondTaskId].includes(entry.taskId))
      .map((entry) => entry.archiveEntryId),
    checks: {
      firstTaskCompleted: firstTask.runtime.lifecycleStatus === "COMPLETED",
      taskCompleted: secondTask.runtime.lifecycleStatus === "COMPLETED",
      taskProposalCardVisible: true,
      settingsProposalVisible: true,
      lessonApproved: MODE === "instruction-skill" ? null : approvedLessonProposal?.status === "APPROVED",
      lessonMemoryCreated: MODE === "instruction-skill" ? null : Boolean(lessonMemory),
      instructionSkillApproved: approvedSkillProposal.status === "APPROVED",
      generatedSkillImported: Boolean(generatedSkill),
      archiveRetained: archive.some((entry) => entry.taskId === secondTaskId),
    },
    complexReport: {
      archive: complexReport.archive,
      truthCompleteness: complexReport.truthCompleteness,
      proposalGenerationQuality: complexReport.proposalGenerationQuality,
    },
    screenshots,
  };

  await writeReport(report);
}

main().catch(async (error) => {
  await writeReport({
    status: "failed",
    mode: MODE,
    generatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  }).catch(() => {});
  console.error(error.stack ?? error.message);
  process.exit(1);
});
