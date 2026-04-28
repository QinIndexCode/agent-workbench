import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5673";
const BACKEND_URL = process.env.FRONTEND_MAINLINE_REVIEW_BACKEND_URL ?? "http://127.0.0.1:3711";
const MOCK_PROVIDER_URL = process.env.FRONTEND_MAINLINE_REVIEW_MOCK_PROVIDER_URL ?? "http://127.0.0.1:4111";
const REPORT_PATH =
  process.env.FRONTEND_MAINLINE_REVIEW_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-mainline-review.json");
const SCREENSHOT_DIR =
  process.env.FRONTEND_MAINLINE_REVIEW_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-mainline-review");

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

async function waitForTaskDetail(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastTask = null;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await requestJson(`${BACKEND_URL}/tasks/${taskId}`);
    lastTask = task;
    if (!predicate || predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for task "${taskId}".${
      lastTask ? ` Last lifecycle=${lastTask.runtime?.lifecycleStatus ?? "missing"}` : ""
    }`,
  );
}

async function waitForTaskDebug(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastDebug = null;
  while (Date.now() - startedAt < timeoutMs) {
    const debug = await requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`);
    lastDebug = debug;
    if (!predicate || predicate(debug)) {
      return debug;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for debug on "${taskId}".${
      lastDebug ? ` Last artifactPathState=${lastDebug.executionSummary?.artifactPathState ?? "missing"}` : ""
    }`,
  );
}

async function getTaskDebug(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`);
}

async function getTaskEvents(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/events`);
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
      metadata: { variantId: "mainline-review" },
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

function createOutput(unitId, artifact, extra = {}) {
  return `[${unitId}_OUTPUT]${JSON.stringify({
    summary: `${unitId}-${artifact}`,
    artifact,
    details: `${artifact} ready`,
    issues: [],
    ...extra,
  })}[/${unitId}_OUTPUT]`;
}

function createTracker(unitId, status, extra = {}) {
  return JSON.stringify({
    current_unit: unitId,
    status,
    progress_percent: status === "COMPLETE" ? 100 : 40,
    decision: "CONTINUE",
    reason: status === "COMPLETE" ? "done" : "needs operator step",
    next_unit: status === "COMPLETE" ? null : unitId,
    files_created: [],
    ...extra,
  });
}

function createToolCall(unitId, toolName, args) {
  return JSON.stringify({
    current_unit: unitId,
    tool_name: toolName,
    arguments: args,
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

async function openTask(page, taskId) {
  await page.goto(`${BASE_URL}/tasks?task=${taskId}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="tasks-page"]');
  await page.waitForSelector('[data-testid="task-detail-pane"]');
  await page.waitForTimeout(300);
}

async function captureScreenshot(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
}

async function waitForVisibleText(page, text, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout },
  );
}

async function waitForEnabledSelector(page, selector, timeout = 20_000) {
  await page.waitForFunction(
    (targetSelector) => {
      const node = document.querySelector(targetSelector);
      return node instanceof HTMLButtonElement && !node.disabled;
    },
    selector,
    { timeout },
  );
}

async function openFollowUpComposer(page) {
  const primaryButton = page.locator('[data-testid="task-action-open-follow-up"]');
  if (await primaryButton.isVisible().catch(() => false)) {
    await primaryButton.click();
    return;
  }
  const composerButton = page.locator('[data-testid="task-action-expand-follow-up"]');
  if (await composerButton.isVisible().catch(() => false)) {
    await composerButton.click();
    return;
  }
  throw new Error("Follow-up entry point is not visible for the completed thread.");
}

async function setContextVisibility(page, open) {
  const isOpen = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="task-inspector-scroll"]');
    return node instanceof HTMLElement && node.getClientRects().length > 0;
  });
  if (isOpen === open) {
    return;
  }
  await page.locator('[data-testid="task-context-toggle"]').click();
  if (open) {
    await page.waitForSelector('[data-testid="task-inspector-scroll"]', { timeout: 10_000 });
  } else {
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="task-inspector-scroll"]');
        return !(node instanceof HTMLElement) || node.getClientRects().length === 0;
      },
      undefined,
      { timeout: 10_000 },
    );
  }
}

async function collectChecklist(page, options = {}) {
  return page.evaluate((config) => {
    function isVisible(selector) {
      const node = document.querySelector(selector);
      return node instanceof HTMLElement && node.getClientRects().length > 0;
    }

    const bodyText = document.body.innerText;
    const resultCardText = (() => {
      const node = document.querySelector('[data-testid="task-result-card"]');
      return node instanceof HTMLElement ? node.innerText : "";
    })();
    const contextText = (() => {
      const node = document.querySelector('[data-testid="task-inspector-scroll"]');
      return node instanceof HTMLElement ? node.innerText : "";
    })();
    const followUpEntryVisible =
      isVisible('[data-testid="task-action-open-follow-up"]')
      || isVisible('[data-testid="task-action-expand-follow-up"]')
      || isVisible('[data-testid="task-action-continue"]');

    const checklist = {
      resultCardVisible: isVisible('[data-testid="task-result-card"]'),
      summaryVisible: resultCardText.trim().length > 0,
      assistantNoteVisible: isVisible('[data-testid="task-assistant-note"]'),
      deliveredVisible:
        isVisible('[data-testid="task-result-destination-section"]')
        || isVisible('[data-testid="task-result-destination-folder"]'),
      artifactVisible: isVisible('[data-testid="task-result-artifact-path"]'),
      followUpEntryVisible,
      recommendedPathVisible: isVisible('[data-testid="task-action-use-recommended-path"]'),
      customPathVisible: isVisible('[data-testid="task-action-choose-custom-path"]'),
      toolActivityVisible: isVisible('[data-testid="task-tool-activity"]'),
      contextDeliveredVisible: contextText.includes("Delivered to"),
      statusStripText: (() => {
        const node = document.querySelector('[data-testid="task-status-strip"]');
        return node instanceof HTMLElement ? node.innerText.trim() : "";
      })(),
      rawProtocolHidden:
        !bodyText.includes("[AGENT-001_OUTPUT]")
        && !bodyText.includes('"current_unit"')
        && !bodyText.includes('"tool_name"'),
    };

    const requireResultCard = config.expectResultCard !== false;
    const requireSummary = config.expectSummary !== false;
    const passes =
      checklist.rawProtocolHidden
      && (requireResultCard ? checklist.resultCardVisible : true)
      && (requireSummary ? checklist.summaryVisible : true)
      && (config.expectArtifacts ? checklist.artifactVisible : true)
      && (config.expectDestination ? checklist.deliveredVisible : true)
      && (config.expectRecommendedPath ? checklist.recommendedPathVisible : true)
      && (config.expectCustomPath ? checklist.customPathVisible : true)
      && (config.expectFollowUpEntry ? checklist.followUpEntryVisible : true)
      && (config.expectToolActivity ? checklist.toolActivityVisible : true)
      && (config.expectAssistantNote ? checklist.assistantNoteVisible : true)
      && (config.expectContextDelivered ? checklist.contextDeliveredVisible : true);

    return {
      ...checklist,
      passes,
    };
  }, options);
}

async function assertChecklist(page, options, label) {
  const checklist = await collectChecklist(page, options);
  assertCondition(checklist.passes, `${label} checklist failed: ${JSON.stringify(checklist)}`);
  return checklist;
}

async function runDeliverableOnlyScenario(page) {
  await patchConfig({
    tools: { permissionMode: "full" },
  });
  await resetMockProvider([
    [
      '[AGENT-001_OUTPUT]{"summary":"Draft brief delivered","issues":[]}' + '[/AGENT-001_OUTPUT]',
      createToolCall("AGENT-001", "write_file", {
        path: "reports/draft-brief.md",
        content: "# Draft brief\n",
      }),
      createTracker("AGENT-001", "COMPLETE", {
        files_created: ["reports/draft-brief.md"],
      }),
    ].join("\n"),
  ]);

  const taskId = await submitTask({
    title: "Mainline deliverable only",
    intent: "Generate one deliverable and finish with a clear result summary.",
    preferredProviderId: "mock-e2e",
    pathPolicy: "task_workspace",
    units: [{
      id: "AGENT-001",
      role: "Writer",
      goal: "Ship a single deliverable artifact.",
      outputContract: "{\"summary\":\"string\",\"issues\":[]}",
      dependencies: [],
    }],
  });

  assertCondition(taskId, "Deliverable-only scenario did not return a task id.");
  await startTask(taskId);
  const task = await waitForTaskDetail(taskId, (nextTask) => nextTask.runtime?.lifecycleStatus === "COMPLETED");
  await openTask(page, taskId);
  await page.waitForSelector('[data-testid="task-result-card"]', { timeout: 20_000 });
  await waitForVisibleText(page, "Draft brief delivered");
  const checklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectToolActivity: true,
    expectFollowUpEntry: true,
  }, "deliverable-only");
  const screenshotPath = await captureScreenshot(page, "deliverable-only");

  return {
    name: "deliverable-only",
    status: "achieved",
    taskId,
    summary: task.latestVisibleOutput?.summary ?? null,
    artifactPaths: task.latestVisibleOutput?.artifactPaths ?? [],
    screenshotPath,
    checklist,
  };
}

async function runArtifactRoutingDefaultPathScenario(page) {
  const artifactFileName = `mainline-artifact-default-path-${Date.now()}.md`;
  const artifactPath = `docs/${artifactFileName}`;
  await patchConfig({
    tools: { permissionMode: "full" },
  });
  await resetMockProvider([
    [
      createOutput("AGENT-001", artifactPath, {
        summary: "Artifact ready for delivery",
        details: "The artifact is ready in the task workspace and needs a destination.",
      }),
      createToolCall("AGENT-001", "write_file", {
        path: artifactPath,
        content: "# Release Notes\n",
      }),
      createTracker("AGENT-001", "PARTIAL", {
        files_created: [artifactPath],
      }),
    ].join("\n"),
  ]);

  const taskId = await submitTask({
    title: "Mainline artifact default path",
    intent: "Create an artifact, wait for the operator, then finish after the recommended destination is applied.",
    preferredProviderId: "mock-e2e",
    pathPolicy: "ask_if_unclear",
    units: [{
      id: "AGENT-001",
      role: "Writer",
      goal: "Generate a deliverable artifact and wait for a destination.",
      outputContract: "{\"summary\":\"string\",\"artifact\":\"string\",\"details\":\"string\",\"issues\":[]}",
      dependencies: [],
      executionProfileId: "implement",
      taskScope: `Use write_file to create ${artifactPath}. Do not claim completion until the operator applies the artifact to a project-relative destination.`,
      exitCondition: "{\"artifact\":\"required\"}",
    }],
  });

  assertCondition(taskId, "Artifact default-path scenario did not return a task id.");
  await startTask(taskId);
  const unresolvedDebug = await waitForTaskDebug(
    taskId,
    (debug) => debug.executionSummary?.artifactPathState === "unresolved",
  );
  const recommendedDestination = unresolvedDebug.executionSummary?.recommendedArtifactDir ?? null;
  assertCondition(recommendedDestination, "Artifact default-path scenario did not expose a recommended destination.");

  await openTask(page, taskId);
  await page.waitForSelector('[data-testid="task-action-use-recommended-path"]', { timeout: 20_000 });
  await waitForVisibleText(page, "Artifact ready");
  await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 20_000 });
  const unresolvedChecklist = await assertChecklist(page, {
    expectResultCard: false,
    expectSummary: false,
    expectArtifacts: false,
    expectRecommendedPath: true,
    expectCustomPath: true,
    expectToolActivity: true,
    expectAssistantNote: true,
  }, "artifact-routing-default-path:unresolved");
  const unresolvedScreenshot = await captureScreenshot(page, "artifact-routing-default-path-unresolved");

  await page.locator('[data-testid="task-action-use-recommended-path"]').click();
  const completedTask = await waitForTaskDetail(
    taskId,
    (nextTask) =>
      nextTask.runtime?.lifecycleStatus === "COMPLETED"
      && (nextTask.completionSummary?.summary ?? "").toLowerCase().includes("delivered"),
    { timeoutMs: 30_000 },
  );
  const appliedDebug = await waitForTaskDebug(
    taskId,
    (debug) => debug.executionSummary?.artifactPathState === "applied",
  );
  assertCondition(
    appliedDebug.executionSummary?.lastArtifactApplyResult?.destinationDir === recommendedDestination,
    `Artifact apply did not use the recommended destination. Recommended=${recommendedDestination} actual=${appliedDebug.executionSummary?.lastArtifactApplyResult?.destinationDir ?? "missing"}`,
  );
  const completedDebug = await getTaskDebug(taskId);
  const destinationPath = completedDebug.executionSummary?.artifactDestinationPaths?.[0] ?? null;
  assertCondition(destinationPath, "Completed artifact-routing scenario did not expose a final destination path.");
  assertCondition(
    (completedTask.completionSummary?.summary ?? "").toLowerCase().includes("delivered"),
    `Auto-finished artifact-routing scenario did not synthesize a delivered summary. Summary=${completedTask.completionSummary?.summary ?? "missing"}`,
  );

  await openTask(page, taskId);
  await page.waitForSelector('[data-testid="task-result-destination-section"]', { timeout: 20_000 });
  await waitForVisibleText(page, destinationPath);
  await setContextVisibility(page, true);
  const completedChecklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectDestination: true,
    expectFollowUpEntry: true,
    expectToolActivity: true,
  }, "artifact-routing-default-path:completed");
  const completedScreenshot = await captureScreenshot(page, "artifact-routing-default-path-completed");
  await setContextVisibility(page, false);

  return {
    name: "artifact-routing-default-path",
    status: "achieved",
    taskId,
    recommendedDestination,
    destinationPaths: completedTask.latestVisibleOutput?.artifactDestinationPaths ?? completedDebug.executionSummary?.artifactDestinationPaths ?? [],
    screenshots: {
      unresolved: unresolvedScreenshot,
      completed: completedScreenshot,
    },
    checklists: {
      unresolved: unresolvedChecklist,
      completed: completedChecklist,
    },
  };
}

async function runCompletedThreadContinueScenario(page) {
  await patchConfig({
    tools: { permissionMode: "full" },
  });
  await resetMockProvider([
    [
      createOutput("AGENT-001", "reports/initial-thread-delivery.md", {
        summary: "Initial thread delivery",
        details: "The thread produced the first deliverable and is ready for a follow-up.",
      }),
      createToolCall("AGENT-001", "write_file", {
        path: "reports/initial-thread-delivery.md",
        content: "# Initial thread delivery\n",
      }),
      createTracker("AGENT-001", "COMPLETE", {
        files_created: ["reports/initial-thread-delivery.md"],
      }),
    ].join("\n"),
    [
      createOutput("AGENT-001", "reports/continued-thread-delivery.md", {
        summary: "Continued thread delivery",
        details: "The same thread completed a follow-up change with a second deliverable.",
      }),
      createToolCall("AGENT-001", "write_file", {
        path: "reports/continued-thread-delivery.md",
        content: "# Continued thread delivery\n",
      }),
      createTracker("AGENT-001", "COMPLETE", {
        files_created: ["reports/continued-thread-delivery.md"],
      }),
    ].join("\n"),
  ]);

  const taskId = await submitTask({
    title: "Mainline completed thread continue",
    intent: "Finish once, then continue deeper in the same thread with another user message.",
    preferredProviderId: "mock-e2e",
    pathPolicy: "task_workspace",
    units: [{
      id: "AGENT-001",
      role: "Writer",
      goal: "Complete the thread, then continue it with a second delivery.",
      outputContract: "{\"summary\":\"string\",\"artifact\":\"string\",\"details\":\"string\",\"issues\":[]}",
      dependencies: [],
      executionProfileId: "implement",
      taskScope: "Use write_file to create the requested report artifact on each turn and keep follow-up work in the same thread.",
      exitCondition: "{\"artifact\":\"required\"}",
    }],
  });

  assertCondition(taskId, "Completed-thread-continue scenario did not return a task id.");
  const firstPass = await startTask(taskId);
  assertCondition(
    firstPass.task?.runtime?.lifecycleStatus === "COMPLETED",
    `Completed-thread-continue first pass did not complete. Lifecycle=${firstPass.task?.runtime?.lifecycleStatus ?? "missing"}`,
  );

  await openTask(page, taskId);
  await page.waitForSelector('[data-testid="task-result-card"]', { timeout: 20_000 });
  await waitForVisibleText(page, "Initial thread delivery");
  await openFollowUpComposer(page);
  await page.waitForSelector('[data-testid="task-continue-message"]', { timeout: 10_000 });
  await page.locator('[data-testid="task-continue-message"]').fill("Keep going in this same thread and add a second deliverable.");
  await waitForEnabledSelector(page, '[data-testid="task-action-continue"]');
  await page.locator('[data-testid="task-action-continue"]').click();

  const continuedTask = await waitForTaskDetail(
    taskId,
    (nextTask) => (
      nextTask.runtime?.lifecycleStatus === "COMPLETED"
      && nextTask.latestVisibleOutput?.summary === "Continued thread delivery"
    ),
  );
  const events = await getTaskEvents(taskId);
  assertCondition(
    page.url().includes(`task=${taskId}`),
    `Completed thread continuation should stay on the same task id. Url=${page.url()}`,
  );
  assertCondition(
    continuedTask.definition?.taskId === taskId,
    `Completed thread continuation unexpectedly changed the task id. Expected=${taskId} actual=${continuedTask.definition?.taskId ?? "missing"}`,
  );
  assertCondition(
    Array.isArray(events)
      && events.some((event) => (
        event.type === "TASK_RESUMED"
        && event.payload?.continuationMode === "same_thread"
      )),
    `Completed thread continuation did not record a same_thread resume event. Events=${JSON.stringify(events.map((event) => ({ type: event.type, payload: event.payload })))}`,
  );
  await waitForVisibleText(page, "Continued thread delivery");
  const checklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectFollowUpEntry: true,
    expectToolActivity: true,
  }, "completed-thread-continue");
  const screenshotPath = await captureScreenshot(page, "completed-thread-continue");

  return {
    name: "completed-thread-continue",
    status: "achieved",
    taskId,
    firstSummary: firstPass.task?.latestVisibleOutput?.summary ?? null,
    secondSummary: continuedTask.latestVisibleOutput?.summary ?? null,
    artifactPaths: continuedTask.latestVisibleOutput?.artifactPaths ?? [],
    screenshotPath,
    checklist,
  };
}

async function main() {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable was not found. Set CHROME_EXECUTABLE to run frontend mainline review.");
  }

  await ensureMockProvider();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });

  let page = null;
  const scenarios = [];
  let consoleMessages = [];

  const baseReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    backendUrl: BACKEND_URL,
    mockProviderUrl: MOCK_PROVIDER_URL,
    executablePath,
    status: "open_gap",
    scenarios,
    screenshots: [],
    consoleFailures: [],
    error: null,
  };

  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    consoleMessages = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleMessages.push({
          type: message.type(),
          text: message.text(),
        });
      }
    });
    page.on("pageerror", (error) => {
      consoleMessages.push({
        type: "pageerror",
        text: error.message,
      });
    });

    scenarios.push(await runDeliverableOnlyScenario(page));
    scenarios.push(await runArtifactRoutingDefaultPathScenario(page));
    scenarios.push(await runCompletedThreadContinueScenario(page));

    const consoleFailures = consoleMessages.filter((message) => {
      const normalized = message.text.toLowerCase();
      return !normalized.includes("download the react devtools")
        && !normalized.includes("language detector")
        && !normalized.includes("translate.google.com");
    });

    const report = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      status: consoleFailures.length === 0 && scenarios.every((scenario) => scenario.status === "achieved")
        ? "achieved"
        : "open_gap",
      screenshots: scenarios.flatMap((scenario) => {
        if (typeof scenario.screenshotPath === "string") {
          return [scenario.screenshotPath];
        }
        if (scenario.screenshots && typeof scenario.screenshots === "object") {
          return Object.values(scenario.screenshots).filter(Boolean);
        }
        return [];
      }),
      consoleFailures,
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "achieved") {
      process.exitCode = 1;
    }
  } catch (error) {
    let screenshotPath = null;
    if (page) {
      try {
        screenshotPath = await captureScreenshot(page, "frontend-mainline-review-failure");
      } catch {
        screenshotPath = null;
      }
    }
    const failureReport = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      screenshots: screenshotPath ? [screenshotPath] : [],
      consoleFailures: consoleMessages,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    await writeReport(failureReport);
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
