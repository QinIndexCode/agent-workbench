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
const VIEWPORT_WIDTH = Number.parseInt(process.env.FRONTEND_MAINLINE_REVIEW_VIEWPORT_WIDTH ?? "1586", 10);
const VIEWPORT_HEIGHT = Number.parseInt(process.env.FRONTEND_MAINLINE_REVIEW_VIEWPORT_HEIGHT ?? "992", 10);

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
  await page.waitForSelector('[data-testid="tasks-agent-shell"]');
  await page.waitForSelector('[data-testid="task-conversation"]');
  await page.waitForSelector('[data-testid="task-composer"]');
  await page.waitForTimeout(300);
}

async function captureScreenshot(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="task-loading-shell"]'),
    undefined,
    { timeout: 5_000 },
  ).catch(() => null);
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
  const expandedComposer = page.locator('[data-testid="task-continue-message"]');
  if (await expandedComposer.isVisible().catch(() => false)) {
    return;
  }
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
    function rect(selector) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) {
        return null;
      }
      const value = node.getBoundingClientRect();
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height,
      };
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
    const brandLogoVisible =
      isVisible('[data-testid="app-brand-logo"]')
      || isVisible('[data-testid="app-brand-logo-mobile"]');
    const threadRailRect = rect('[data-testid="task-thread-rail"]');
    const footerRect = rect('[data-testid="task-global-footer"]');
    const composerRect = rect('[data-testid="task-composer-card"]');
    const visibleTimelineGlyphs = Array.from(document.querySelectorAll('[data-testid^="task-timeline-glyph-"]'))
      .filter((node) => node instanceof HTMLElement && window.getComputedStyle(node).display !== "none" && node.getClientRects().length > 0);
    const firstTimelineNode = document.querySelector('[data-testid^="task-timeline-node-"]');
    const timelineBeforeContent = firstTimelineNode instanceof HTMLElement
      ? window.getComputedStyle(firstTimelineNode, "::before").content
      : "none";
    const desktopConceptLayout = window.innerWidth >= 1100
      ? Boolean(
        threadRailRect
        && threadRailRect.top <= 2
        && threadRailRect.left <= 2
        && threadRailRect.width >= 280
        && footerRect
        && footerRect.height >= 36
        && composerRect
        && composerRect.bottom <= footerRect.top + 2
      )
      : true;

    const checklist = {
      brandLogoVisible,
      agentShellVisible: isVisible('[data-testid="tasks-agent-shell"]'),
      threadRailVisible: isVisible('[data-testid="task-thread-rail"]') || Boolean(document.querySelector('[data-testid="task-thread-rail"]')),
      conversationVisible: isVisible('[data-testid="task-conversation"]'),
      truthInspectorReady: Boolean(document.querySelector('[data-testid="task-truth-inspector"]')),
      conceptShellGeometry: desktopConceptLayout,
      runtimeChipStripVisible: window.innerWidth >= 1100 ? isVisible('[data-testid="app-runtime-chip-strip"]') : true,
      footerVisible: window.innerWidth >= 1100 ? isVisible('[data-testid="task-global-footer"]') : true,
      typedTimelineGlyphsVisible: visibleTimelineGlyphs.length >= (config.minTimelineGlyphs ?? 1),
      timelineNotPseudoOnly: visibleTimelineGlyphs.length > 0 && (timelineBeforeContent === "none" || timelineBeforeContent === "normal"),
      agentTimelineIconVisible: isVisible('[data-testid="task-timeline-agent-icon"]'),
      toolTimelineIconVisible: isVisible('[data-testid="task-timeline-tool-icon"]'),
      artifactTimelineGlyphVisible: isVisible('[data-testid="task-timeline-glyph-artifact"]'),
      decisionTimelineGlyphVisible: isVisible('[data-testid="task-timeline-glyph-decision"]'),
      delegationTimelineGlyphVisible: isVisible('[data-testid="task-timeline-glyph-delegation"]'),
      inspectorTabsVisible: bodyText.includes("Task truth") && bodyText.includes("Events"),
      userIntentVisible: isVisible('[data-testid="task-timeline-entry-user"]'),
      composerVisible: isVisible('[data-testid="task-composer"]'),
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
      && checklist.brandLogoVisible
      && checklist.agentShellVisible
      && checklist.threadRailVisible
      && checklist.conversationVisible
      && checklist.truthInspectorReady
      && checklist.conceptShellGeometry
      && checklist.runtimeChipStripVisible
      && checklist.footerVisible
      && (config.expectTimelineGlyphs === false ? true : checklist.typedTimelineGlyphsVisible)
      && (config.expectTimelineGlyphs === false ? true : checklist.timelineNotPseudoOnly)
      && (config.expectAgentGlyph ? checklist.agentTimelineIconVisible : true)
      && (config.expectToolGlyph ? checklist.toolTimelineIconVisible : true)
      && (config.expectArtifactGlyph ? checklist.artifactTimelineGlyphVisible : true)
      && (config.expectDecisionGlyph ? checklist.decisionTimelineGlyphVisible : true)
      && (config.expectDelegationGlyph ? checklist.delegationTimelineGlyphVisible : true)
      && checklist.inspectorTabsVisible
      && checklist.userIntentVisible
      && checklist.composerVisible
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
  if ((await page.locator('[data-testid="task-truth-inspector"]').count().catch(() => 0)) === 0) {
    await setContextVisibility(page, true).catch(() => null);
  }
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
  await page.locator('[data-testid="task-result-card"]').scrollIntoViewIfNeeded();
  const checklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectToolActivity: true,
    expectFollowUpEntry: true,
    expectAgentGlyph: true,
    expectToolGlyph: true,
    expectArtifactGlyph: true,
    minTimelineGlyphs: 4,
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
  const selectedDestination = "backend/docs/mainline-artifacts";
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
    intent: "Create an artifact, wait for the operator, then finish after the selected destination is applied.",
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
  assertCondition(recommendedDestination === null, `Core artifact routing should not infer a scenario destination. recommended=${recommendedDestination}`);

  await openTask(page, taskId);
  await page.waitForSelector('[data-testid="task-action-choose-custom-path"]', { timeout: 20_000 });
  await waitForVisibleText(page, "Artifact ready");
  await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 20_000 });
  const unresolvedChecklist = await assertChecklist(page, {
    expectResultCard: false,
    expectSummary: false,
    expectArtifacts: false,
    expectRecommendedPath: false,
    expectCustomPath: true,
    expectToolActivity: true,
    expectAssistantNote: true,
    expectToolGlyph: true,
    expectArtifactGlyph: true,
    expectDecisionGlyph: true,
    minTimelineGlyphs: 4,
  }, "artifact-routing-default-path:unresolved");
  const unresolvedScreenshot = await captureScreenshot(page, "artifact-routing-default-path-unresolved");

  await page.locator('[data-testid="task-action-choose-custom-path"]').click();
  await page.locator('[data-testid="task-artifact-dir"]').fill(selectedDestination);
  await page.locator('[data-testid="task-action-apply-artifacts"]').click();
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
    appliedDebug.executionSummary?.lastArtifactApplyResult?.destinationDir === selectedDestination,
    `Artifact apply did not use the selected destination. selected=${selectedDestination} actual=${appliedDebug.executionSummary?.lastArtifactApplyResult?.destinationDir ?? "missing"}`,
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
  await page.locator('[data-testid="task-result-card"]').scrollIntoViewIfNeeded();
  await setContextVisibility(page, true);
  const completedChecklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectDestination: true,
    expectFollowUpEntry: true,
    expectToolActivity: true,
    expectAgentGlyph: true,
    expectToolGlyph: true,
    expectArtifactGlyph: true,
    minTimelineGlyphs: 4,
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
  await page.locator('[data-testid="task-result-card"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="task-action-continue"]');
      return !(node instanceof HTMLElement) || !/continuing/i.test(node.textContent ?? "");
    },
    undefined,
    { timeout: 10_000 },
  ).catch(() => undefined);
  const checklist = await assertChecklist(page, {
    expectArtifacts: true,
    expectFollowUpEntry: true,
    expectToolActivity: true,
    expectAgentGlyph: true,
    expectToolGlyph: true,
    expectArtifactGlyph: true,
    minTimelineGlyphs: 4,
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

async function runVisualProofScenario(browser, desktopPage, completedTaskId, attachConsoleCapture) {
  await desktopPage.goto(`${BASE_URL}/tasks?task=none`, { waitUntil: "networkidle" });
  await desktopPage.waitForSelector('[data-testid="tasks-page"]');
  await desktopPage.waitForSelector('[data-testid="task-empty-agent-state"]', { timeout: 20_000 });
  const emptyChecklist = await desktopPage.evaluate(() => {
    function visible(selector) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
    }
    return {
      emptyStateVisible: visible('[data-testid="task-empty-agent-state"]'),
      logoVisible: visible('[data-testid="task-empty-agent-state"] img'),
      glyphRowVisible: visible('[data-testid="task-empty-glyph-row"]'),
      agentGlyphVisible: visible('[data-testid="task-empty-glyph-agent"]'),
      runtimeGlyphVisible: visible('[data-testid="task-empty-glyph-runtime"]'),
      artifactGlyphVisible: visible('[data-testid="task-empty-glyph-artifact"]'),
      createActionVisible: visible('[data-testid="task-empty-create"]'),
      connectionsActionVisible: visible('[data-testid="task-empty-connections"]'),
      ecosystemActionVisible: visible('[data-testid="task-empty-ecosystem"]'),
    };
  });
  assertCondition(
    Object.values(emptyChecklist).every(Boolean),
    `Empty/new task state is missing flagship proof selectors: ${JSON.stringify(emptyChecklist)}`,
  );
  const emptyScreenshot = await captureScreenshot(desktopPage, "empty-new-task-state");

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  attachConsoleCapture(mobilePage);
  try {
    await openTask(mobilePage, completedTaskId);
    await mobilePage.waitForSelector('[data-testid="task-result-card"]', { timeout: 20_000 });
    await mobilePage.locator('[data-testid="task-result-card"]').scrollIntoViewIfNeeded();
    const mobileChecklist = await mobilePage.evaluate(() => {
      function visible(selector) {
        const nodes = Array.from(document.querySelectorAll(selector));
        return nodes.some((node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const style = window.getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
        });
      }
      return {
        mobileBrandVisible: visible('[data-testid="app-brand-logo-mobile"]') || visible('[data-testid="app-brand-logo"]'),
        shellVisible: visible('[data-testid="tasks-agent-shell"]'),
        conversationVisible: visible('[data-testid="task-conversation"]'),
        composerVisible: visible('[data-testid="task-composer"]'),
        inlineTimelineGlyphVisible: visible('[data-testid^="task-timeline-glyph-"]'),
        agentGlyphVisible: visible('[data-testid="task-timeline-agent-icon"]'),
        artifactGlyphVisible: visible('[data-testid="task-timeline-glyph-artifact"]'),
        contextToggleVisible: visible('[data-testid="task-context-toggle"]'),
      };
    });
    assertCondition(
      Object.values(mobileChecklist).every(Boolean),
      `Mobile task detail proof is missing required selectors: ${JSON.stringify(mobileChecklist)}`,
    );
    const mobileScreenshot = await captureScreenshot(mobilePage, "mobile-completed-thread");
    return {
      name: "visual-proof-mobile-empty",
      status: "achieved",
      screenshots: {
        empty: emptyScreenshot,
        mobile: mobileScreenshot,
      },
      checklists: {
        empty: emptyChecklist,
        mobile: mobileChecklist,
      },
    };
  } finally {
    await mobilePage.close().catch(() => null);
  }
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
    viewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    },
    status: "open_gap",
    scenarios,
    screenshots: [],
    consoleFailures: [],
    error: null,
  };

  try {
    const attachConsoleCapture = (targetPage) => {
      targetPage.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          consoleMessages.push({
            type: message.type(),
            text: message.text(),
          });
        }
      });
      targetPage.on("pageerror", (error) => {
        consoleMessages.push({
          type: "pageerror",
          text: error.message,
        });
      });
    };

    page = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
    consoleMessages = [];
    attachConsoleCapture(page);

    scenarios.push(await runDeliverableOnlyScenario(page));
    scenarios.push(await runArtifactRoutingDefaultPathScenario(page));
    const completedThreadScenario = await runCompletedThreadContinueScenario(page);
    scenarios.push(completedThreadScenario);
    scenarios.push(await runVisualProofScenario(browser, page, completedThreadScenario.taskId, attachConsoleCapture));

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
