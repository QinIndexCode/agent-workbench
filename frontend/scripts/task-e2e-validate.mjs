import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5373";
const BACKEND_URL = process.env.FRONTEND_E2E_BACKEND_URL ?? "http://127.0.0.1:3411";
const MOCK_PROVIDER_URL = process.env.FRONTEND_E2E_MOCK_PROVIDER_URL ?? "http://127.0.0.1:4011";
const REPORT_PATH =
  process.env.FRONTEND_E2E_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-e2e-report.json");
const SCREENSHOT_DIR =
  process.env.FRONTEND_E2E_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-e2e");
const TASK_STATE_SCREENSHOT_DIR = path.join(SCREENSHOT_DIR, "states");
const TEST_RUN_ID = Date.now().toString(36);

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

async function collectConsoleMessages(page) {
  const consoleMessages = [];
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
  page.on("response", (response) => {
    if (response.status() === 404) {
      consoleMessages.push({
        type: "response404",
        text: `${response.status()} ${response.url()}`,
      });
    }
  });
  page.on("requestfailed", (request) => {
    consoleMessages.push({
      type: "requestfailed",
      text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`,
    });
  });
  return consoleMessages;
}

function filterConsoleFailures(messages) {
  const benignDeletedTask404 = messages.some((message) => {
    if (message.type !== "response404") {
      return false;
    }
    return /\/tasks\/[^/]+(?:\/(debug|events))?$/.test(message.text);
  });
  return messages.filter((message) => {
    const normalized = message.text.toLowerCase();
    return !normalized.includes("download the react devtools")
      && !normalized.includes("language detector")
      && !normalized.includes("translate.google.com")
      && normalized !== "failed to load resource: the server responded with a status of 500 (internal server error)"
      && !(message.type === "response404" && /\/tasks\/[^/]+(?:\/(debug|events))?$/.test(message.text))
      && !(benignDeletedTask404 && normalized === "failed to load resource: the server responded with a status of 404 (not found)");
  });
}

async function captureViewportContentRect(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    if (!(viewport instanceof HTMLElement)) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function assertOverlayLayout(page, {
  label,
  containerSelector,
  panelSelector,
  bodySelector,
  footerSelector,
  baselineRect = null,
  minWidth = 360,
}) {
  const metrics = await page.evaluate((config) => {
    function getRect(node) {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) {
        return null;
      }
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    }

    function isVisible(node) {
      return Boolean(getRect(node));
    }

    const container = document.querySelector(config.containerSelector);
    const panel = document.querySelector(config.panelSelector);
    const body = config.bodySelector ? document.querySelector(config.bodySelector) : panel;
    const footer = config.footerSelector ? document.querySelector(config.footerSelector) : null;
    const header = panel instanceof HTMLElement ? panel.querySelector("h1, h2, [data-testid$='-header']") : null;
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    const viewportRect = getRect(viewport);
    const panelRect = getRect(panel);
    const bodyBlocks = body instanceof HTMLElement
      ? Array.from(body.querySelectorAll("p, li")).filter((node) => isVisible(node))
      : [];
    const minTextWidth = window.innerWidth >= 1280 ? 260 : 220;
    const effectiveMinWidth = Math.min(config.minWidth, Math.max(280, window.innerWidth - 32));
    const maxBlockLines = window.innerWidth >= 1280 ? 9 : 12;
    const textReadable = bodyBlocks.every((node) => {
      const rect = node.getBoundingClientRect();
      const styles = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(styles.lineHeight || "0") || 20;
      return rect.width >= minTextWidth && rect.height / lineHeight <= maxBlockLines;
    });
    const centerDelta = panelRect ? Math.abs((panelRect.left + panelRect.width / 2) - window.innerWidth / 2) : null;
    const layoutStable = !config.baselineRect || !viewportRect
      ? true
      : Math.abs(viewportRect.top - config.baselineRect.top) <= 4
        && Math.abs(viewportRect.left - config.baselineRect.left) <= 4
        && Math.abs(viewportRect.width - config.baselineRect.width) <= 8
        && Math.abs(viewportRect.height - config.baselineRect.height) <= 8;

    return {
      panelRect,
      headerVisible: isVisible(header),
      bodyVisible: isVisible(body),
      footerVisible: footer ? isVisible(footer) : true,
      containerVisible: isVisible(container),
      textReadable,
      layoutStable,
      centered: centerDelta === null ? false : centerDelta <= 48,
      inViewport: Boolean(
        panelRect
          && panelRect.top >= 8
          && panelRect.left >= 8
          && panelRect.bottom <= window.innerHeight - 8
          && panelRect.right <= window.innerWidth - 8,
      ),
      passes: Boolean(
        isVisible(container)
          && panelRect
          && panelRect.width >= effectiveMinWidth
          && isVisible(body)
          && isVisible(header)
          && (footer ? isVisible(footer) : true)
          && textReadable
          && layoutStable
          && (centerDelta === null ? false : centerDelta <= 48)
          && panelRect.top >= 8
          && panelRect.left >= 8
          && panelRect.bottom <= window.innerHeight - 8
          && panelRect.right <= window.innerWidth - 8,
      ),
    };
  }, {
    containerSelector,
    panelSelector,
    bodySelector,
    footerSelector,
    baselineRect,
    minWidth,
  });

  assertCondition(Boolean(metrics.passes), `${label} overlay is visually unstable: ${JSON.stringify(metrics)}`);
  return metrics;
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

async function waitForTaskByTitle(title, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastTask = null;
  while (Date.now() - startedAt < timeoutMs) {
    const tasks = await requestJson(`${BACKEND_URL}/tasks`);
    const matched = Array.isArray(tasks)
      ? tasks
        .filter((task) => task.title === title)
        .sort((left, right) => {
          const leftTime = Number(left.updatedAt ?? left.createdAt ?? 0);
          const rightTime = Number(right.updatedAt ?? right.createdAt ?? 0);
          return rightTime - leftTime;
        })[0] ?? null
      : null;
    if (matched) {
      lastTask = matched;
      if (!predicate || predicate(matched)) {
        return matched;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for task "${title}" to satisfy backend predicate.${lastTask ? ` Last snapshot: ${JSON.stringify(lastTask)}` : ""}`);
}

async function getTaskDetail(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}`);
}

async function getTaskDebug(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`);
}

async function getTaskEvents(taskId) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/events`);
}

async function waitForTaskDetail(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastTask = null;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await getTaskDetail(taskId);
    lastTask = task;
    if (!predicate || predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for task "${taskId}" detail predicate.${lastTask ? ` Last snapshot: ${JSON.stringify({ lifecycleStatus: lastTask.runtime?.lifecycleStatus, pendingApprovals: lastTask.pendingApprovals?.length, toolStatuses: lastTask.toolInvocations?.map((invocation) => invocation.status) })}` : ""}`);
}

async function waitForTaskDebug(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastDebug = null;
  while (Date.now() - startedAt < timeoutMs) {
    const debug = await getTaskDebug(taskId);
    lastDebug = debug;
    if (!predicate || predicate(debug)) {
      return debug;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for task "${taskId}" debug predicate.${lastDebug ? ` Last snapshot: ${JSON.stringify({ continueAllowed: lastDebug.executionSummary?.turnContract?.continueAllowed, continueReason: lastDebug.executionSummary?.turnContract?.continueReason, issueCategory: lastDebug.executionSummary?.issueCategory })}` : ""}`);
}

async function waitForTaskEvents(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastEvents = [];
  while (Date.now() - startedAt < timeoutMs) {
    const events = await getTaskEvents(taskId);
    lastEvents = Array.isArray(events) ? events : [];
    if (!predicate || predicate(lastEvents)) {
      return lastEvents;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for task "${taskId}" events predicate.${lastEvents.length ? ` Last events: ${JSON.stringify(lastEvents.map((event) => event.type))}` : ""}`);
}

async function patchConfig(patch) {
  return requestJson(`${BACKEND_URL}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function pauseTask(taskId, reason = "Pause task for E2E stabilization.") {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/pause`, {
    method: "POST",
    body: JSON.stringify({ reason }),
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
      auth: {
        scheme: "none",
      },
      metadata: {
        variantId: "e2e",
      },
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
    report: `${artifact} ready`,
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

async function openTasksPage(page) {
  await page.goto(`${BASE_URL}/tasks`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="tasks-page"]');
  await page.waitForSelector('[data-testid="tasks-operator-summary"]');
}

async function assertNoMachineProtocolVisible(page) {
  const bodyText = await page.locator("body").innerText();
  assertCondition(!bodyText.includes("[AGENT-001_OUTPUT]"), "Visible timeline leaked raw explicit output.");
  assertCondition(!bodyText.includes('"current_unit"'), "Visible timeline leaked raw tracker JSON.");
  assertCondition(!bodyText.includes('"tool_name"'), "Visible timeline leaked raw tool call JSON.");
}

async function openAdvancedDetails(page) {
  let details = page.locator('[data-testid="task-advanced-summary"]');
  if ((await details.count()) === 0) {
    const contextToggle = page.locator('[data-testid="task-context-toggle"]');
    if (await contextToggle.isVisible().catch(() => false)) {
      await contextToggle.click();
      await page.waitForSelector('[data-testid="task-inspector-scroll"]', { timeout: 10_000 });
      details = page.locator('[data-testid="task-advanced-summary"]');
    }
  }
  if ((await details.count()) === 0) {
    throw new Error("Advanced details panel is missing.");
  }
  const isOpen = await details.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
  if (!isOpen) {
    await details.locator("summary").click();
  }
}

async function assertFollowUpComposer(page) {
  const openButton = page.locator('[data-testid="task-action-open-follow-up"]');
  if (await openButton.isVisible().catch(() => false)) {
    await openButton.click();
  } else {
    const expandButton = page.locator('[data-testid="task-action-expand-follow-up"]');
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
  }
  await page.waitForFunction(() => {
    const textarea = document.querySelector('[data-testid="task-continue-message"]');
    const button = document.querySelector('[data-testid="task-action-continue"]');
    const placeholder = textarea instanceof HTMLTextAreaElement ? textarea.placeholder.toLowerCase() : "";
    const buttonLabel = button instanceof HTMLButtonElement ? button.innerText.trim() : "";
    return placeholder.includes("follow-up") && buttonLabel === "Continue thread";
  }, undefined, { timeout: 10_000 });
  const state = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="task-continue-message"]');
    const button = document.querySelector('[data-testid="task-action-continue"]');
    return {
      placeholder: textarea instanceof HTMLTextAreaElement ? textarea.placeholder : null,
      buttonLabel: button instanceof HTMLButtonElement ? button.innerText.trim() : null,
    };
  });
  assertCondition(
    typeof state.placeholder === "string" && state.placeholder.toLowerCase().includes("follow-up"),
    `Completed composer did not switch to follow-up mode. Placeholder=${state.placeholder ?? "missing"}`,
  );
  assertCondition(
    state.buttonLabel === "Continue thread",
    `Completed composer button did not switch to follow-up mode. Button=${state.buttonLabel ?? "missing"}`,
  );
}

async function collectTaskVisualChecklist(page, options = {}) {
  return page.evaluate((config) => {
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    const bodyText = document.body.innerText;

    function isVisible(node) {
      if (!(node instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.getClientRects().length === 0) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return rect.bottom > viewportRect.top + 4 && rect.top < viewportRect.bottom - 4;
    }

    const detailsVisible = isVisible(document.querySelector('[data-testid="task-inspector-scroll"]'));
    const followUpPlaceholderNode = document.querySelector('[data-testid="task-continue-message"]');
    const followUpPlaceholder =
      followUpPlaceholderNode instanceof HTMLTextAreaElement ? followUpPlaceholderNode.placeholder : "";
    const resultVisible = isVisible(document.querySelector('[data-testid="task-result-card"]'));
    const resultMissingVisible = isVisible(document.querySelector('[data-testid="task-result-missing"]'));
    const assistantUpdateVisible = isVisible(document.querySelector('[data-testid="task-assistant-update"]'));
    const assistantNoteVisible = isVisible(document.querySelector('[data-testid="task-assistant-note"]'));
    const toolActivityVisible = isVisible(document.querySelector('[data-testid="task-tool-activity"]'));
    const toolEvidenceVisible = isVisible(document.querySelector('[data-testid="task-tool-activity-evidence"]'));
    const toolActivityCount = document.querySelectorAll('[data-testid="task-tool-activity"]').length;
    const resultDestinationVisible =
      isVisible(document.querySelector('[data-testid="task-result-destination-section"]'))
      || isVisible(document.querySelector('[data-testid="task-result-destination-folder"]'));
    const resultMissingDestinationVisible =
      isVisible(document.querySelector('[data-testid="task-result-missing-destination-section"]'))
      || isVisible(document.querySelector('[data-testid="task-result-missing-destination-folder"]'));
    const emptyStateVisible = isVisible(document.querySelector('[data-testid="task-empty-state"]'));
    const runtimeSummaryVisible = isVisible(document.querySelector('[data-testid="task-runtime-summary"]'));
    const threadRailVisible = isVisible(document.querySelector('[data-testid="tasks-explorer-scroll"]'));
    const operatorSummaryVisible = isVisible(document.querySelector('[data-testid="tasks-operator-summary"]'));
    const statusStripVisible = isVisible(document.querySelector('[data-testid="task-status-strip"]'));
    const statusStripText = (() => {
      const node = document.querySelector('[data-testid="task-status-strip"]');
      return node instanceof HTMLElement ? node.innerText.trim() : "";
    })();
    const timelineVisible =
      isVisible(document.querySelector('[data-testid="task-timeline-scroll"]'))
      || emptyStateVisible;
    const composerVisible = isVisible(document.querySelector('[data-testid="task-composer-card"]'));
    const actionVisible =
      isVisible(document.querySelector('[data-testid="task-action-continue"]'))
      || isVisible(document.querySelector('[data-testid="task-action-start"]'))
      || isVisible(document.querySelector('[data-testid="task-context-toggle"]'));
    const statusStripExpectation =
      config.expectStatusStrip === true
        ? statusStripVisible
        : config.expectStatusStrip === false
          ? !statusStripVisible
          : true;
    const actionExpectation =
      config.expectActionVisible === true
        ? actionVisible
        : config.expectActionVisible === false
          ? !actionVisible
          : true;
    const contextExpectation =
      typeof config.expectContextOpen === "boolean"
        ? config.expectContextOpen === detailsVisible
        : true;
    const resultExpectation =
      config.expectResultCard === true
        ? resultVisible
        : config.expectResultCard === false
          ? !resultVisible
          : true;
    const missingExpectation =
      config.expectResultMissing === true
        ? resultMissingVisible
        : config.expectResultMissing === false
          ? !resultMissingVisible
          : true;
    const followUpExpectation =
      config.expectFollowUp === true
        ? followUpPlaceholder.toLowerCase().includes("follow-up")
        : true;
    const updateExpectation =
      config.expectAssistantUpdate === true
        ? assistantUpdateVisible
        : true;
    const assistantNoteExpectation =
      config.expectAssistantNote === true
        ? assistantNoteVisible
        : true;
    const toolActivityExpectation =
      config.expectToolActivity === true
        ? toolActivityVisible
        : config.expectToolActivity === false
          ? !toolActivityVisible
          : true;
    const toolEvidenceExpectation =
      config.expectToolEvidence === true
        ? toolEvidenceVisible
        : true;
    const resultDestinationExpectation =
      config.expectResultDestination === true
        ? resultDestinationVisible
        : true;
    const resultMissingDestinationExpectation =
      config.expectMissingDestination === true
        ? resultMissingDestinationVisible
        : true;
    const bodyProtocolHidden =
      !bodyText.includes("[AGENT-001_OUTPUT]")
      && !bodyText.includes('"current_unit"')
      && !bodyText.includes('"tool_name"');

    return {
      threadRailVisible,
      operatorSummaryVisible,
      statusStripVisible,
      statusStripText,
      timelineVisible,
      composerVisible,
      actionVisible,
      runtimeSummaryVisible,
      assistantUpdateVisible,
      assistantNoteVisible,
      toolActivityVisible,
      toolEvidenceVisible,
      toolActivityCount,
      resultVisible,
      resultDestinationVisible,
      resultMissingVisible,
      resultMissingDestinationVisible,
      detailsVisible,
      bodyProtocolHidden,
      contextExpectation,
      resultExpectation,
      missingExpectation,
      followUpExpectation,
      updateExpectation,
      assistantNoteExpectation,
      toolActivityExpectation,
      toolEvidenceExpectation,
      resultDestinationExpectation,
      resultMissingDestinationExpectation,
      statusStripExpectation,
      actionExpectation,
      followUpPlaceholder,
      passes:
        threadRailVisible
        && operatorSummaryVisible
        && timelineVisible
        && composerVisible
        && statusStripExpectation
        && actionExpectation
        && bodyProtocolHidden
        && contextExpectation
        && resultExpectation
        && missingExpectation
        && followUpExpectation
        && updateExpectation
        && assistantNoteExpectation
        && toolActivityExpectation
        && toolEvidenceExpectation
        && resultDestinationExpectation
        && resultMissingDestinationExpectation,
    };
  }, options);
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

async function captureTaskState(page, stateScreenshots, state, options = {}) {
  if (typeof options.expectContextOpen === "boolean") {
    await setContextVisibility(page, options.expectContextOpen);
  }
  const fileName = `${state}${options.scenario ? `-${options.scenario}` : ""}.png`;
  const filePath = path.join(TASK_STATE_SCREENSHOT_DIR, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  const checklist = await collectTaskVisualChecklist(page, options);
  assertCondition(
    checklist.passes,
    `Task visual checklist failed for state "${state}"${options.scenario ? ` in ${options.scenario}` : ""}: ${JSON.stringify(checklist)}`,
  );
  stateScreenshots.push({
    state,
    scenario: options.scenario ?? null,
    screenshotPath: filePath,
    visualReviewChecklist: checklist,
  });
  return filePath;
}

async function openComposer(page) {
  await page.getByRole("button", { name: /create task/i }).click();
  await page.waitForSelector('[data-testid="task-composer-dialog"]');
  await verifyComposerIsGeneric(page);
}

async function verifyComposerIsGeneric(page) {
  const taskTypeVisible = await page.locator('[data-testid="task-composer-task-type"]').isVisible().catch(() => false);
  assertCondition(taskTypeVisible, "Add Task composer is missing the generic task type selector.");
  const qualityOptions = await page.locator('[data-testid="task-composer-quality-profile"] option').evaluateAll((options) =>
    options.map((option) => option.textContent ?? "")
  );
  assertCondition(
    !qualityOptions.some((label) => /database|mysql/i.test(label)),
    `Add Task default quality profiles must not expose database-specific presets. options=${qualityOptions.join(", ")}`
  );
}

async function createTaskViaUi(page, options) {
  await openComposer(page);
  await page.locator('[data-testid="task-composer-title"]').fill(options.title);
  await page.locator('[data-testid="task-composer-intent"]').fill(options.intent);
  await page.locator('[data-testid="task-composer-provider"]').fill(options.providerId);
  await page.locator('[data-testid="task-composer-path-policy"]').selectOption(options.pathPolicy);
  if (options.units) {
    const advancedContract = page.getByText("Advanced contract", { exact: true });
    if (await advancedContract.isVisible().catch(() => false)) {
      await advancedContract.click();
      await page.waitForTimeout(150);
    }
    await page.locator('[data-testid="task-composer-units"]').fill(JSON.stringify(options.units, null, 2));
  }
  if (options.outputDir) {
    await page.locator('[data-testid="task-composer-output-dir"]').fill(options.outputDir);
  } else {
    await page.locator('[data-testid="task-composer-output-dir"]').fill("");
  }
  await page.locator('[data-testid="task-composer-submit"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="task-composer-submit"]').click({ force: true });
  await page.waitForSelector('[data-testid="task-detail-pane"]');
  await page.waitForTimeout(400);
  await page.locator('[data-testid="task-detail-pane"]').getByText(options.title, { exact: true }).waitFor();
  const task = await waitForTaskByTitle(options.title);
  return task.taskId;
}

async function waitForStatusText(page, text) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout: 20_000 },
  );
}

async function clickTab(page, testId) {
  const tab = page.locator(`[data-testid="${testId}"]`);
  if (!(await tab.first().isVisible().catch(() => false))) {
    const contextToggle = page.locator('[data-testid="task-context-toggle"]');
    if (await contextToggle.isVisible().catch(() => false)) {
      await contextToggle.click();
      await page.waitForTimeout(150);
    }
  }
  if (!(await tab.first().isVisible().catch(() => false))) {
    await openAdvancedDetails(page);
  }
  await tab.first().waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(`[data-testid="${testId}"]`).click();
  await page.waitForTimeout(150);
}

async function verifyAcceptanceDetails(page) {
  await openAdvancedDetails(page);
  await clickTab(page, "task-tab-acceptance");
  await page.waitForSelector('[data-testid="task-acceptance-panel"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="task-acceptance-semantic-review"]', { timeout: 10_000 });
  const layerCount = await page.locator('[data-testid^="task-acceptance-layer-"]').count();
  assertCondition(layerCount >= 4, `Acceptance inspector is missing expected layers. count=${layerCount}`);
}

async function verifyToolActivityIcons(page) {
  const cardCount = await page.locator('[data-testid="task-tool-activity"]').count();
  assertCondition(cardCount > 0, "Expected at least one task tool activity card.");
  const iconCount = await page.locator('[data-testid="task-tool-activity-icon"]').count();
  assertCondition(iconCount >= cardCount, `Task tool activity icons are missing. cards=${cardCount} icons=${iconCount}`);
  return {
    checked: true,
    cardCount,
    iconCount,
  };
}

async function verifyToolExecutionDetailsIfPresent(page) {
  const summaries = page.locator('[data-testid="task-tool-activity-summary"]');
  const summaryCount = await summaries.count();
  for (let index = 0; index < summaryCount; index += 1) {
    await summaries.nth(index).click();
  }
  const executionCount = await page.locator('[data-testid="task-tool-activity-execution"]').count();
  if (executionCount === 0) {
    return {
      checked: true,
      executionCount,
    };
  }
  const text = await page.locator('[data-testid="task-tool-activity-execution"]').first().innerText();
  assertCondition(/exit\s+/.test(text), `Execution details should include an exit code. text=${text}`);
  assertCondition(/stdout/i.test(text) && /stderr/i.test(text), `Execution details should include stdout and stderr sections. text=${text}`);
  return {
    checked: true,
    executionCount,
  };
}

async function verifyComposerRefreshAnchor(page) {
  const textarea = page.locator('[data-testid="task-continue-message"]').first();
  if (!(await textarea.isVisible().catch(() => false))) {
    const expandFollowUp = page.locator('[data-testid="task-action-expand-follow-up"]').first();
    if (await expandFollowUp.isVisible().catch(() => false)) {
      await expandFollowUp.click();
      await page.waitForTimeout(200);
    }
  }
  assertCondition(await textarea.isVisible().catch(() => false), "Expected the follow-up textarea to be visible.");
  const draftValue = `e2e-anchor-${Date.now()}`;
  await textarea.fill(draftValue);
  const before = await page.evaluate(() => {
    const textareaNode = document.querySelector('[data-testid="task-continue-message"]');
    const composerNode = document.querySelector('[data-testid="task-composer-card"]');
    const draftNoticeNode = document.querySelector('[data-testid="task-composer-draft-lock-notice"]');
    const actionNode = document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]');
    if (!(textareaNode instanceof HTMLTextAreaElement) || !(composerNode instanceof HTMLElement)) {
      return null;
    }
    return {
      value: textareaNode.value,
      textareaTop: textareaNode.getBoundingClientRect().top,
      composerTop: composerNode.getBoundingClientRect().top,
      actionLabel: actionNode instanceof HTMLElement ? actionNode.innerText.trim() : null,
      draftNoticeVisible: draftNoticeNode instanceof HTMLElement && draftNoticeNode.getClientRects().length > 0,
    };
  });
  assertCondition(Boolean(before), "Could not capture the pre-refresh composer state.");
  await page.locator('[data-testid="task-action-refresh"]').click();
  await page.waitForTimeout(250);
  if (await clickVisibleContextToggle(page)) {
    await page.waitForTimeout(120);
    await clickVisibleContextToggle(page);
    await page.waitForTimeout(120);
  }
  await page.waitForSelector('[data-testid="task-composer-card"]', { timeout: 5_000 }).catch(() => null);
  await page.waitForSelector('[data-testid="task-continue-message"]', { timeout: 5_000 }).catch(() => null);
  const after = await page.evaluate(() => {
    const textareaNode = document.querySelector('[data-testid="task-continue-message"]');
    const composerNode = document.querySelector('[data-testid="task-composer-card"]');
    const draftNoticeNode = document.querySelector('[data-testid="task-composer-draft-lock-notice"]');
    const actionNode = document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]');
    if (!(textareaNode instanceof HTMLTextAreaElement) || !(composerNode instanceof HTMLElement)) {
      return null;
    }
    return {
      value: textareaNode.value,
      textareaTop: textareaNode.getBoundingClientRect().top,
      composerTop: composerNode.getBoundingClientRect().top,
      actionLabel: actionNode instanceof HTMLElement ? actionNode.innerText.trim() : null,
      draftNoticeVisible: draftNoticeNode instanceof HTMLElement && draftNoticeNode.getClientRects().length > 0,
    };
  });
  assertCondition(Boolean(after), "Composer disappeared after refresh/details toggles.");
  const actionStable = after.actionLabel === before.actionLabel || after.draftNoticeVisible;
  const unexpectedRestart = before.actionLabel !== "Restart task" && after.actionLabel === "Restart task" && !after.draftNoticeVisible;
  assertCondition(after.value === draftValue, `Composer draft was lost after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  assertCondition(actionStable && !unexpectedRestart, `Composer action changed unexpectedly after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  assertCondition(
    Math.abs(after.textareaTop - before.textareaTop) <= 24 && Math.abs(after.composerTop - before.composerTop) <= 24,
    `Composer shifted unexpectedly after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  return {
    checked: true,
    before,
    after,
  };
}

async function clickVisibleContextToggle(page) {
  const toggles = page.locator('[data-testid="task-context-toggle"]');
  const count = await toggles.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const toggle = toggles.nth(index);
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      return true;
    }
  }
  return false;
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

async function waitForEnabledSelectorOrTerminalTask(page, taskId, selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const terminalStatuses = new Set(options.terminalStatuses ?? ["COMPLETED", "FAILED", "CANCELLED"]);
  const startedAt = Date.now();
  let lastLifecycle = null;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await getTaskDetail(taskId);
    lastLifecycle = task.runtime?.lifecycleStatus ?? null;
    if (terminalStatuses.has(lastLifecycle)) {
      return {
        kind: "terminal",
        task,
      };
    }
    const enabled = await page.evaluate((targetSelector) => {
      const node = document.querySelector(targetSelector);
      return node instanceof HTMLButtonElement && !node.disabled;
    }, selector);
    if (enabled) {
      return {
        kind: "enabled",
        task,
      };
    }
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`Timed out waiting for ${selector} to become enabled or task "${taskId}" to reach a terminal state. Last lifecycle=${lastLifecycle ?? "missing"}.`);
}

async function reopenTaskFromList(page, title) {
  const item = page.locator('[data-testid="task-list-item"]').filter({
    has: page.getByText(title, { exact: true }),
  }).first();
  await item.click();
  await page.waitForTimeout(300);
}

async function waitForTaskListCount(page, title, expectedCount, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await page.locator('[data-testid="task-list-item"]').filter({
      has: page.getByText(title, { exact: true }),
    }).count();
    if (count === expectedCount) {
      return count;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for task list count for "${title}" to become ${expectedCount}.`);
}

async function waitForTaskTitleMissing(title, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const includeArchived = options.includeArchived ?? true;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tasks = await requestJson(includeArchived ? `${BACKEND_URL}/tasks?includeArchived=true` : `${BACKEND_URL}/tasks`);
      const exists = Array.isArray(tasks) && tasks.some((task) => task.title === title);
      if (!exists) {
        return;
      }
    } catch (error) {
      if (error instanceof Error && /(ENOENT|not found)/i.test(error.message)) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for task "${title}" to disappear from ${includeArchived ? "the archived-inclusive list" : "the default task list"}.`);
}

async function ensureTimelineSelectorVisible(page, selector) {
  const target = page.locator(selector).first();
  if (await target.count() === 0) {
    return false;
  }
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  return true;
}

async function continueTaskUntilCompleted(page, taskId, options = {}) {
  const task = await getTaskDetail(taskId);
  if (task.runtime?.lifecycleStatus === "COMPLETED") {
    return task;
  }
  if (Array.isArray(task.pendingApprovals) && task.pendingApprovals.length > 0) {
    throw new Error(`Task "${taskId}" still has pending approvals while attempting to continue it.`);
  }
  const debug = await getTaskDebug(taskId);
  if (debug.executionSummary?.turnContract?.continueAllowed !== true) {
    throw new Error(`Task "${taskId}" is not ready for continue. Reason=${debug.executionSummary?.turnContract?.continueReason ?? "n/a"}`);
  }
  await clickTab(page, "task-tab-summary");
  const continueButton = page.locator('[data-testid="task-action-continue"]');
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="task-action-continue"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.locator('[data-testid="task-continue-message"]').fill(options.message ?? "Operator recovery");
  await continueButton.click();
  const completedTask = await waitForTaskDetail(
    taskId,
    (nextTask) => nextTask.runtime?.lifecycleStatus === "COMPLETED" || nextTask.runtime?.lifecycleStatus === "FAILED",
    { timeoutMs: 20_000, intervalMs: 300 },
  );
  if (completedTask.runtime?.lifecycleStatus === "COMPLETED") {
    return completedTask;
  }
  const finalTask = await getTaskDetail(taskId);
  const finalDebug = await getTaskDebug(taskId).catch(() => null);
  throw new Error(`Task "${taskId}" did not complete after operator continue. Last lifecycle=${finalTask.runtime?.lifecycleStatus}. Issue=${finalDebug?.executionSummary?.issueCategory ?? "unknown"} reason=${finalDebug?.executionSummary?.issueSummary ?? "n/a"}`);
}

async function captureScenario(page, name) {
  const fileName = `${name}.png`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({
    path: filePath,
  });
  return filePath;
}

async function captureNoSelectionState(page, stateScreenshots) {
  await page.goto(`${BASE_URL}/tasks?task=none`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="tasks-page"]');
  await page.waitForSelector('[data-testid="task-empty-state"]');
  await captureTaskState(page, stateScreenshots, "empty-no-selection", {
    expectContextOpen: false,
    expectResultCard: false,
    expectStatusStrip: false,
    expectActionVisible: true,
  });
  await openTasksPage(page);
}

async function captureResultSummaryMissingState(page, stateScreenshots, taskId) {
  const matcher = `**/tasks/${taskId}`;
  const handler = async (route) => {
    try {
      const response = await route.fetch();
      const payload = await response.json();
      payload.latestVisibleOutput = null;
      const headers = {
        ...response.headers(),
        "content-type": "application/json",
      };
      return await route.fulfill({
        status: response.status(),
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof Error && /(already handled|disposed|closed)/i.test(error.message)) {
        return;
      }
      throw error;
    }
  };
  await page.unroute(matcher);
  await page.route(matcher, handler);
  try {
    await page.getByRole("button", { name: /refresh/i }).click();
    await page.waitForFunction(() => {
      const resultMissing = document.querySelector('[data-testid="task-result-missing"]');
      const resultCard = document.querySelector('[data-testid="task-result-card"]');
      return Boolean(
        (resultMissing instanceof HTMLElement && resultMissing.getClientRects().length > 0)
        || (resultCard instanceof HTMLElement && resultCard.getClientRects().length > 0)
      );
    }, undefined, { timeout: 20_000 });
    await page.waitForFunction(() => {
      const selectors = [
        '[data-testid="task-result-missing-destination-section"]',
        '[data-testid="task-result-missing-destination-folder"]',
        '[data-testid="task-result-destination-section"]',
        '[data-testid="task-result-destination-folder"]',
      ];
      return selectors.some((selector) => {
        const node = document.querySelector(selector);
        return node instanceof HTMLElement && node.getClientRects().length > 0;
      });
    }, undefined, { timeout: 20_000 });
    const resultMissingVisible = await page.locator('[data-testid="task-result-missing"]').isVisible().catch(() => false);
    await assertNoMachineProtocolVisible(page);
    await assertFollowUpComposer(page);
    await captureTaskState(page, stateScreenshots, "result-summary-missing", {
      scenario: "result-summary-missing",
      expectContextOpen: false,
      expectResultCard: !resultMissingVisible,
      expectResultMissing: resultMissingVisible,
      expectResultDestination: !resultMissingVisible,
      expectMissingDestination: resultMissingVisible,
      expectFollowUp: true,
    });
  } finally {
    await page.unroute(matcher);
    await page.getByRole("button", { name: /refresh/i }).click();
  }
}

async function capturePublicAssistantDiscussionState(page, stateScreenshots, taskId) {
  const matcher = `**/tasks/${taskId}`;
  let latestSummary = "done";
  const handler = async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const summary = typeof payload.latestVisibleOutput?.summary === "string" ? payload.latestVisibleOutput.summary : "done";
    latestSummary = summary;
    const baseTimestamp = payload.runtime?.updatedAt ?? Date.now();
    payload.conversations = [
      ...(Array.isArray(payload.conversations) ? payload.conversations : []),
      {
        messageId: `assistant_note_${baseTimestamp}`,
        role: "assistant",
        visibility: "public",
        createdAt: baseTimestamp - 2,
        content: "I drafted the artifact and left a short note so the operator can see what changed before the final result card.",
        metadata: {
          source: "assistant_summary",
          displayKind: "artifact_ready",
          unitId: "AGENT-001",
          turnId: "turn_mock_public_note",
        },
      },
      {
        messageId: `assistant_duplicate_${baseTimestamp}`,
        role: "assistant",
        visibility: "public",
        createdAt: baseTimestamp - 1,
        content: summary,
        metadata: {
          source: "assistant_summary",
          displayKind: "progress",
          unitId: "AGENT-001",
          turnId: "turn_mock_duplicate_note",
        },
      },
    ];
    const headers = {
      ...response.headers(),
      "content-type": "application/json",
    };
    try {
      return await route.fulfill({
        status: response.status(),
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof Error && /already handled/i.test(error.message)) {
        return;
      }
      throw error;
    }
  };
  await page.unroute(matcher);
  await page.route(matcher, handler);
  try {
    await page.getByRole("button", { name: /refresh/i }).click();
    await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 20_000 });
    const assistantNotes = await page.locator('[data-testid="task-assistant-note"]').allInnerTexts();
    assertCondition(assistantNotes.length >= 1, "Expected at least one visible assistant note after refresh.");
    const normalizeTimelineText = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedSummary = normalizeTimelineText(latestSummary);
    assertCondition(
      assistantNotes.some((note) => normalizeTimelineText(note).length > 0),
      `Expected the operator-facing assistant note to remain visible. Notes=${JSON.stringify(assistantNotes)}`,
    );
    assertCondition(
      assistantNotes.every((note) => normalizeTimelineText(note) !== normalizedSummary),
      `Assistant note dedupe failed to remove the duplicate final summary. Notes=${JSON.stringify(assistantNotes)} summary=${latestSummary}`,
    );
    await ensureTimelineSelectorVisible(page, '[data-testid="task-assistant-note"]');
    await assertNoMachineProtocolVisible(page);
    await captureTaskState(page, stateScreenshots, "public-assistant-discussion", {
      scenario: "web-artifact-routing-apply",
      expectContextOpen: false,
      expectResultCard: true,
      expectAssistantNote: true,
      expectResultDestination: true,
    });
  } finally {
    await page.unroute(matcher);
    await page.getByRole("button", { name: /refresh/i }).click();
  }
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
}

async function runPauseResumeScenario(page, stateScreenshots) {
  const title = `E2E Pause Resume Task ${TEST_RUN_ID}`;
  const completionArtifactPath = `reports/pause-resume-complete-${Date.now()}.md`;
  const followUpArtifactPath = `reports/pause-resume-follow-up-${Date.now()}.md`;
  await patchConfig({
    tools: {
      permissionMode: "full",
    },
  });
  await resetMockProvider([
    [
      createOutput("AGENT-001", "pause-resume-phase-1"),
      createTracker("AGENT-001", "PARTIAL"),
    ].join("\n"),
    [
      createOutput("AGENT-001", "pause-resume-complete"),
      createToolCall("AGENT-001", "write_file", {
        path: completionArtifactPath,
        content: "# Pause resume complete\n",
      }),
      createTracker("AGENT-001", "COMPLETE", {
        files_created: [completionArtifactPath],
      }),
    ].join("\n"),
    [
      createOutput("AGENT-001", "pause-resume-follow-up", {
        summary: "pause-resume-follow-up",
        details: "The same thread completed a follow-up change.",
      }),
      createToolCall("AGENT-001", "write_file", {
        path: followUpArtifactPath,
        content: "# Pause resume follow up\n",
      }),
      createTracker("AGENT-001", "COMPLETE", {
        files_created: [followUpArtifactPath],
      }),
    ].join("\n"),
  ]);
  const taskId = await createTaskViaUi(page, {
    title,
    intent: "Exercise start, pause, resume, and completion through the browser operator flow.",
    providerId: "mock-e2e",
    pathPolicy: "task_workspace",
    units: [
      {
        id: "AGENT-001",
        role: "Solo",
        goal: "Do work",
        outputContract: "{\"summary\":\"string\",\"issues\":[]}",
        dependencies: [],
      },
    ],
  });
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-start"]');
  await page.locator('[data-testid="task-action-start"]').click();
  const startedTask = await waitForTaskDetail(
    taskId,
    (task) => task.runtime?.lifecycleStatus === "RUNNING" || task.runtime?.lifecycleStatus === "COMPLETED",
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  assertCondition(
    startedTask.runtime?.lifecycleStatus === "RUNNING",
    `Pause/resume scenario never entered RUNNING. Last lifecycle=${startedTask.runtime?.lifecycleStatus ?? "missing"}`,
  );
  await captureTaskState(page, stateScreenshots, "running", {
    scenario: "web-pause-resume-complete",
  });
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-pause"]');
  await page.locator('[data-testid="task-action-pause"]').click();
  await waitForTaskDetail(
    taskId,
    (task) => task.runtime?.lifecycleStatus === "PAUSED",
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  await captureTaskState(page, stateScreenshots, "paused", {
    scenario: "web-pause-resume-complete",
  });
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  const resumeState = await waitForEnabledSelectorOrTerminalTask(page, taskId, '[data-testid="task-action-resume"]', {
    timeoutMs: 20_000,
    terminalStatuses: ["COMPLETED", "FAILED", "CANCELLED"],
  });
  if (resumeState.kind === "terminal") {
    throw new Error(`Pause/resume scenario reached ${resumeState.task.runtime?.lifecycleStatus ?? "missing"} before resume became available.`);
  }
  await page.locator('[data-testid="task-action-resume"]').click();
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  const continueState = await waitForEnabledSelectorOrTerminalTask(page, taskId, '[data-testid="task-action-continue"]', {
    timeoutMs: 8_000,
    terminalStatuses: ["COMPLETED", "FAILED", "CANCELLED"],
  });
  if (continueState.kind !== "terminal") {
    await continueTaskUntilCompleted(page, taskId, { message: "Continue after resume." });
  }
  await waitForTaskEvents(
    taskId,
    (events) =>
      Array.isArray(events)
      && events.some((event) => event.type === "TASK_RESUMED")
      && events.some((event) => event.type === "TASK_COMPLETED"),
    { timeoutMs: 20_000 },
  );
  await assertNoMachineProtocolVisible(page);
  await page.waitForSelector('[data-testid="task-result-card"]', { timeout: 20_000 });
  await assertFollowUpComposer(page);
  await captureTaskState(page, stateScreenshots, "completed-with-follow-up", {
    scenario: "web-pause-resume-complete",
    expectContextOpen: false,
    expectResultCard: true,
    expectAssistantNote: true,
    expectFollowUp: true,
  });
  const composerRefreshAnchor = await verifyComposerRefreshAnchor(page);
  const toolIcons = await verifyToolActivityIcons(page);
  const toolExecution = await verifyToolExecutionDetailsIfPresent(page);
  await page.locator('[data-testid="task-continue-message"]').fill("Keep going in this same thread and tighten the delivery note.");
  await waitForEnabledSelector(page, '[data-testid="task-action-continue"]');
  await page.locator('[data-testid="task-action-continue"]').click();
  const continuedTask = await waitForTaskDetail(
    taskId,
    (nextTask) => (
      nextTask.runtime?.lifecycleStatus === "COMPLETED"
      && nextTask.latestVisibleOutput?.summary === "pause-resume-follow-up"
    ),
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  const resumedEvents = await getTaskEvents(taskId);
  assertCondition(
    page.url().includes(`task=${taskId}`),
    `Completed thread continuation should stay on the same task. Url=${page.url()}`,
  );
  assertCondition(
    continuedTask.definition?.taskId === taskId,
    `Completed thread continuation created a new task instead of reusing ${taskId}.`,
  );
  assertCondition(
    Array.isArray(resumedEvents)
      && resumedEvents.some((event) => (
        event.type === "TASK_RESUMED"
        && event.payload?.continuationMode === "same_thread"
      )),
    `Completed thread continuation did not record a same_thread resume event. Events=${JSON.stringify(resumedEvents.map((event) => ({ type: event.type, payload: event.payload })))}`,
  );
  await captureTaskState(page, stateScreenshots, "completed-thread-continue", {
    scenario: "web-pause-resume-complete",
    expectContextOpen: false,
    expectAssistantNote: false,
    expectStatusStrip: false,
  });
  await clickTab(page, "task-tab-events");
  await openAdvancedDetails(page);
  await waitForStatusText(page, "TASK_RESUMED");
  await verifyAcceptanceDetails(page);
  return {
    name: "web-pause-resume-complete",
    passed: true,
    taskId,
    composerRefreshAnchor,
    toolIcons,
    toolExecution,
    screenshotPath: await captureScenario(page, "web-pause-resume-complete"),
  };
}

async function runApprovalScenario(page, status, stateScreenshots) {
  await patchConfig({
    tools: {
      permissionMode: "ask",
    },
  });
  await page.waitForTimeout(300);
  await resetMockProvider([
    [
      createOutput("AGENT-001", `approval-${status.toLowerCase()}-draft`),
      createToolCall("AGENT-001", "write_file", {
        path: `reports/${status.toLowerCase()}-artifact.md`,
        content: `# ${status}\n`,
      }),
      createTracker("AGENT-001", "PARTIAL", {
        files_created: [`reports/${status.toLowerCase()}-artifact.md`],
      }),
    ].join("\n"),
    [
      createOutput("AGENT-001", `approval-${status.toLowerCase()}-complete`),
      createTracker("AGENT-001", "COMPLETE"),
    ].join("\n"),
  ]);
  const title = `E2E Approval ${status} ${TEST_RUN_ID}`;
  const taskId = await createTaskViaUi(page, {
    title,
    intent: `Exercise ${status.toLowerCase()} approval handling and recovery through the browser operator flow.`,
    providerId: "mock-e2e",
    pathPolicy: "task_workspace",
    units: [
      {
        id: "AGENT-001",
        role: "Implementer",
        goal: "Create a report artifact that requires a workspace write.",
        outputContract: "{\"summary\":\"string\",\"details\":\"string\"}",
        executionProfileId: "implement",
        dependencies: [],
      },
    ],
  });
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-start"]');
  await page.locator('[data-testid="task-action-start"]').click();
  await waitForTaskDetail(
    taskId,
    (task) =>
      (Array.isArray(task.pendingApprovals) && task.pendingApprovals.length > 0)
      || task.toolInvocations.some((invocation) => invocation.status === "WAITING_APPROVAL"),
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  const approvalTask = await getTaskDetail(taskId);
  assertCondition(
    Array.isArray(approvalTask.pendingApprovals) && approvalTask.pendingApprovals.length > 0,
    `Backend did not expose pending approvals for ${title}. Tool statuses=${approvalTask.toolInvocations.map((invocation) => invocation.status).join(",")}.`,
  );
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(400);
  await reopenTaskFromList(page, title);
  await clickTab(page, "task-tab-approvals");
  try {
    await page.waitForSelector('[data-testid="task-approval-card"]', { timeout: 10_000 });
  } catch (error) {
    const diagnostics = await getTaskDetail(taskId);
    await captureScenario(page, `web-approval-${status.toLowerCase()}-missing-card`);
    throw new Error(
      `Approval card did not render for ${title}. Pending approvals=${diagnostics.pendingApprovals.length}; tool statuses=${diagnostics.toolInvocations.map((invocation) => invocation.status).join(",")}; lifecycle=${diagnostics.runtime.lifecycleStatus}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await page.waitForFunction(
    () => Boolean(
      document.querySelector('[data-testid="task-assistant-note"]')
      || document.querySelector('[data-testid="task-assistant-update"]')
    ),
    { timeout: 20_000 },
  );
  const approvalSummarySelector = await page.evaluate(() => (
    document.querySelector('[data-testid="task-assistant-note"]')
      ? '[data-testid="task-assistant-note"]'
      : '[data-testid="task-assistant-update"]'
  ));
  await ensureTimelineSelectorVisible(page, approvalSummarySelector);
  await captureTaskState(page, stateScreenshots, "approval-pending", {
    scenario: `web-approval-${status.toLowerCase()}`,
    expectContextOpen: true,
    expectResultCard: false,
    expectResultMissing: false,
    expectFollowUp: false,
    expectToolActivity: true,
    expectResultDestination: false,
    expectResultMissingDestination: false,
  });
  const toolIcons = await verifyToolActivityIcons(page);
  await page.locator(status === "APPROVED" ? '[data-testid="task-approval-approve"]' : '[data-testid="task-approval-reject"]').click();
  await waitForTaskDetail(
    taskId,
    (task) =>
      Array.isArray(task.pendingApprovals)
      && task.pendingApprovals.length === 0
      && task.toolInvocations.some((invocation) => invocation.status === (status === "APPROVED" ? "SUCCEEDED" : "DENIED")),
    { timeoutMs: 20_000 },
  );
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await captureTaskState(page, stateScreenshots, `approval-${status.toLowerCase()}-resolved`, {
    scenario: `web-approval-${status.toLowerCase()}`,
    expectContextOpen: false,
    expectStatusStrip: false,
  });
  await assertNoMachineProtocolVisible(page);
  await clickTab(page, "task-tab-diagnostics");
  await openAdvancedDetails(page);
  const screenshotPath = await captureScenario(page, `web-approval-${status.toLowerCase()}`);
  const settledTask = await getTaskDetail(taskId);
  if (settledTask.runtime?.lifecycleStatus === "RUNNING") {
    await pauseTask(taskId, `Pause ${title} so the next E2E scenario gets a clean provider queue.`);
    await waitForTaskDetail(
      taskId,
      (task) => task.runtime?.lifecycleStatus === "PAUSED" || task.runtime?.lifecycleStatus === "COMPLETED",
      { timeoutMs: 20_000, intervalMs: 250 },
    );
  }
  return {
    name: `web-approval-${status.toLowerCase()}`,
    passed: true,
    taskId,
    toolIcons,
    toolExecution: await verifyToolExecutionDetailsIfPresent(page),
    screenshotPath,
  };
}

async function runArtifactRoutingScenario(page, stateScreenshots) {
  const artifactFileName = `e2e-artifact-routing-${Date.now()}.md`;
  const artifactPath = `docs/${artifactFileName}`;
  const title = `E2E Artifact Apply Task ${TEST_RUN_ID}`;
  await patchConfig({
    tools: {
      permissionMode: "full",
    },
  });
  await resetMockProvider([
    '[AGENT-001_OUTPUT]{"summary":"report created","issues":[]}[/AGENT-001_OUTPUT]\n'
      + `{"current_unit":"AGENT-001","tool_name":"write_file","arguments":{"path":"${artifactPath}","content":"# Release Notes\\n"}}\n`
      + `{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":50,"decision":"CONTINUE","reason":"artifact created","next_unit":"AGENT-001","files_created":["${artifactPath}"]}`,
  ]);
  const taskId = await createTaskViaUi(page, {
    title,
    intent: "Create a file, wait for an operator-selected destination, then finish.",
    providerId: "mock-e2e",
    pathPolicy: "ask_if_unclear",
    units: [
      {
        id: "AGENT-001",
        role: "Writer",
        goal: "Generate a project artifact",
        outputContract: "{\"summary\":\"string\",\"issues\":[]}",
        dependencies: [],
      },
    ],
  });
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-start"]');
  await page.locator('[data-testid="task-action-start"]').click();
  await waitForTaskDebug(
    taskId,
    (debug) => debug.executionSummary?.artifactPathState === "unresolved",
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  const unresolvedDebug = await getTaskDebug(taskId);
  const recommendedDestination = unresolvedDebug.executionSummary?.recommendedArtifactDir;
  assertCondition(
    typeof recommendedDestination === "string" && recommendedDestination.length > 0,
    `Artifact routing scenario did not produce a recommended destination. Debug=${JSON.stringify(unresolvedDebug.executionSummary)}`,
  );
  await waitForStatusText(page, "Use recommended path");
  await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="task-action-use-recommended-path"]', { timeout: 20_000 });
  await ensureTimelineSelectorVisible(page, '[data-testid="task-assistant-note"]');
  await captureTaskState(page, stateScreenshots, "artifact-destination-unresolved", {
    scenario: "web-artifact-routing-apply",
    expectContextOpen: true,
    expectAssistantNote: true,
    expectToolActivity: true,
    expectToolEvidence: false,
  });
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-use-recommended-path"]');
  await page.locator('[data-testid="task-action-use-recommended-path"]').click();
  const completedTask = await waitForTaskDetail(
    taskId,
    (task) => task.runtime?.lifecycleStatus === "COMPLETED",
    { timeoutMs: 20_000 },
  );
  await waitForTaskDebug(
    taskId,
    (debug) => debug.executionSummary?.artifactPathState === "applied",
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await captureTaskState(page, stateScreenshots, "artifact-applied", {
    scenario: "web-artifact-routing-apply",
    expectContextOpen: false,
    expectResultCard: true,
    expectResultDestination: true,
    expectToolActivity: true,
  });
  const debug = await getTaskDebug(taskId);
  assertCondition(
    debug.executionSummary?.lastArtifactApplyResult?.status === "APPLIED",
    `Artifact apply result did not settle to APPLIED. Last result=${debug.executionSummary?.lastArtifactApplyResult?.status ?? "missing"}`,
  );
  assertCondition(
    debug.executionSummary?.lastArtifactApplyResult?.destinationDir === recommendedDestination,
    `Artifact apply destination did not match the recommended directory. Recommended=${recommendedDestination ?? "missing"} Last destination=${debug.executionSummary?.lastArtifactApplyResult?.destinationDir ?? "missing"}`,
  );
  assertCondition(
    debug.executionSummary?.artifactPathState === "applied",
    `Artifact path state did not settle to applied. Last state=${debug.executionSummary?.artifactPathState ?? "missing"}`,
  );
  const events = await waitForTaskEvents(
    taskId,
    (nextEvents) => Array.isArray(nextEvents) && nextEvents.some((event) => event.type === "TASK_COMPLETED"),
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  assertCondition(
    Array.isArray(events) && events.some((event) => event.type === "TASK_COMPLETED"),
    "Backend task event log did not include TASK_COMPLETED for artifact routing scenario.",
  );
  assertCondition(
    completedTask.runtime?.lifecycleStatus === "COMPLETED",
    `Artifact routing task did not reach COMPLETED. Last lifecycle=${completedTask.runtime?.lifecycleStatus ?? "missing"}`,
  );
  const destinationPath = debug.executionSummary?.artifactDestinationPaths?.[0];
  assertCondition(
    typeof destinationPath === "string" && destinationPath.length > 0,
    `Artifact routing scenario did not report a final destination path. Paths=${JSON.stringify(debug.executionSummary?.artifactDestinationPaths ?? [])}`,
  );
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await page.waitForSelector('[data-testid="task-result-card"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="task-result-destination-section"]', { timeout: 20_000 });
  await waitForStatusText(page, destinationPath);
  const normalizeTimelineText = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const terminalAssistantNotes = await page.locator('[data-testid="task-assistant-note"]').allInnerTexts();
  const completedSummary = typeof completedTask.completionSummary?.summary === "string"
    ? normalizeTimelineText(completedTask.completionSummary.summary)
    : "";
  assertCondition(
    terminalAssistantNotes.every((note) => normalizeTimelineText(note) !== completedSummary),
    `Completed artifact routing rendered an assistant note that duplicated the final result summary. Notes=${JSON.stringify(terminalAssistantNotes)} summary=${completedTask.completionSummary?.summary ?? "missing"}`,
  );
  const completedChecklist = await collectTaskVisualChecklist(page, {
    expectContextOpen: false,
    expectResultCard: true,
    expectResultDestination: true,
    expectFollowUp: true,
  });
  assertCondition(
    completedChecklist.resultVisible
      && completedChecklist.resultDestinationVisible
      && (
        !completedChecklist.statusStripVisible
        || (
          completedChecklist.statusStripText.toLowerCase().includes("delivered")
          && !completedChecklist.statusStripText.toLowerCase().includes("attention needed")
        )
      ),
    `Artifact routing completion should surface a delivered result without a stale blocker. Checklist=${JSON.stringify(completedChecklist)}`,
  );
  await assertNoMachineProtocolVisible(page);
  await assertFollowUpComposer(page);
  await captureTaskState(page, stateScreenshots, "completed-with-follow-up", {
    scenario: "web-artifact-routing-apply",
    expectContextOpen: false,
    expectResultCard: true,
    expectResultDestination: true,
    expectFollowUp: true,
  });
  await capturePublicAssistantDiscussionState(page, stateScreenshots, taskId);
  await setContextVisibility(page, true);
  await page.waitForSelector('[data-testid="task-artifact-delivered"]', { timeout: 10_000 });
  await waitForStatusText(page, destinationPath);
  await setContextVisibility(page, false);
  await clickTab(page, "task-tab-events");
  await openAdvancedDetails(page);
  await waitForStatusText(page, "TASK_COMPLETED");
  await verifyAcceptanceDetails(page);
  await clickTab(page, "task-tab-artifacts");
  await waitForStatusText(page, "\"artifactPathState\": \"applied\"");
  await waitForStatusText(page, "\"pendingArtifactCount\": 0");
  await waitForStatusText(page, destinationPath);
  return {
    name: "web-artifact-routing-apply",
    passed: true,
    taskId,
    screenshotPath: await captureScenario(page, "web-artifact-routing-apply"),
  };
}

async function runArchiveLifecycleScenario(page, stateScreenshots) {
  const title = `E2E Archive Lifecycle ${TEST_RUN_ID}`;
  await patchConfig({
    tools: {
      permissionMode: "full",
    },
  });
  await resetMockProvider([
    [
      createOutput("AGENT-001", "archive-lifecycle-complete", {
        summary: "archive-lifecycle-complete",
        details: "Archive lifecycle task finished cleanly and is ready to be archived or deleted.",
      }),
      createTracker("AGENT-001", "COMPLETE"),
    ].join("\n"),
  ]);
  const taskId = await createTaskViaUi(page, {
    title,
    intent: "Create a terminal thread so the browser operator flow can archive, restore, and delete it.",
    providerId: "mock-e2e",
    pathPolicy: "task_workspace",
    units: [
      {
        id: "AGENT-001",
        role: "Analyst",
        goal: "Finish a simple terminal task without approvals, tool calls, or artifact routing blockers.",
        outputContract: "{\"summary\":\"string\",\"details\":\"string\"}",
        executionProfileId: "analyze",
        dependencies: [],
      },
    ],
  });
  await reopenTaskFromList(page, title);
  await waitForEnabledSelector(page, '[data-testid="task-action-start"]');
  await page.locator('[data-testid="task-action-start"]').click();
  await waitForTaskDetail(
    taskId,
    (task) => task.runtime?.lifecycleStatus === "COMPLETED" && task.canArchive === true && task.canDelete === true,
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  await page.getByRole("button", { name: /refresh/i }).click();
  await page.waitForTimeout(300);
  await reopenTaskFromList(page, title);
  await page.waitForSelector('[data-testid="task-action-archive"]', { timeout: 20_000 });
  await captureTaskState(page, stateScreenshots, "archive-ready-terminal", {
    scenario: "web-task-archive-lifecycle",
    expectResultCard: true,
  });

  await page.locator('[data-testid="task-action-archive"]').click();
  await waitForTaskDetail(
    taskId,
    (task) => task.isArchived === true,
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  await page.waitForSelector('[data-testid="task-action-unarchive"]', { timeout: 10_000 });
  await page.waitForSelector('text=This thread is archived and hidden from the default work queue.', { timeout: 10_000 });
  await waitForTaskListCount(page, title, 0);

  await page.locator('[data-testid="task-toggle-show-archived"]').click();
  await waitForTaskListCount(page, title, 1);
  await reopenTaskFromList(page, title);
  await captureTaskState(page, stateScreenshots, "archived-visible-filtered", {
    scenario: "web-task-archive-lifecycle",
    expectResultCard: true,
  });

  await page.locator('[data-testid="task-action-unarchive"]').click();
  await waitForTaskDetail(
    taskId,
    (task) => task.isArchived === false,
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  await page.locator('[data-testid="task-toggle-show-archived"]').click();
  await waitForTaskListCount(page, title, 1);
  await reopenTaskFromList(page, title);
  await page.waitForSelector('[data-testid="task-action-delete"]', { timeout: 10_000 });
  const deleteDialogBaseline = await captureViewportContentRect(page);
  await page.locator('[data-testid="task-action-delete"]').click();
  await page.waitForSelector('[data-testid="task-delete-dialog"]', { timeout: 10_000 });
  const deleteDialogLayout = await assertOverlayLayout(page, {
    label: "task-delete-dialog",
    containerSelector: '[data-testid="task-delete-dialog"]',
    panelSelector: '[data-testid="task-delete-dialog-panel"]',
    bodySelector: '[data-testid="task-delete-dialog-body"]',
    footerSelector: '[data-testid="task-delete-dialog-footer"]',
    baselineRect: deleteDialogBaseline,
    minWidth: 360,
  });
  await page.locator('[data-testid="task-delete-confirm"]').evaluate((button) => {
    button.click();
  });
  await waitForTaskTitleMissing(title, { includeArchived: true, timeoutMs: 20_000, intervalMs: 250 });
  await waitForTaskListCount(page, title, 0);

  return {
    name: "web-task-archive-lifecycle",
    passed: true,
    taskId,
    deleteDialogLayout,
    screenshotPath: await captureScenario(page, "web-task-archive-lifecycle"),
  };
}

async function main() {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable was not found. Set CHROME_EXECUTABLE to run frontend E2E validation.");
  }

  await ensureMockProvider();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  let page = null;
  const scenarios = [];
  const stateScreenshots = [];
  let currentScenario = null;
  let consoleMessages = [];
  const baseReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    backendUrl: BACKEND_URL,
    mockProviderUrl: MOCK_PROVIDER_URL,
    executablePath,
    passes: false,
    scenarios,
    taskStateScreenshots: stateScreenshots,
    consoleFailures: [],
    failedScenario: null,
    error: null,
    screenshots: [],
  };

  try {
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    consoleMessages = await collectConsoleMessages(page);

    await openTasksPage(page);
    await captureNoSelectionState(page, stateScreenshots);
    currentScenario = "web-pause-resume-complete";
    scenarios.push(await runPauseResumeScenario(page, stateScreenshots));
    currentScenario = "web-approval-approved";
    scenarios.push(await runApprovalScenario(page, "APPROVED", stateScreenshots));
    currentScenario = "web-approval-rejected";
    scenarios.push(await runApprovalScenario(page, "REJECTED", stateScreenshots));
    currentScenario = "web-artifact-routing-apply";
    const artifactScenario = await runArtifactRoutingScenario(page, stateScreenshots);
    scenarios.push(artifactScenario);
    currentScenario = "web-task-archive-lifecycle";
    scenarios.push(await runArchiveLifecycleScenario(page, stateScreenshots));
    currentScenario = "result-summary-missing";
    await captureResultSummaryMissingState(page, stateScreenshots, artifactScenario.taskId);
    currentScenario = null;

    const consoleFailures = filterConsoleFailures(consoleMessages);

    const report = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      passes: scenarios.every((scenario) => scenario.passed) && consoleFailures.length === 0,
      consoleFailures,
      screenshots: [
        ...scenarios.flatMap((scenario) => scenario.screenshotPath ? [scenario.screenshotPath] : []),
        ...stateScreenshots.map((entry) => entry.screenshotPath),
      ],
    };

    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));

    if (!report.passes) {
      process.exitCode = 1;
    }
  } catch (error) {
    const consoleFailures = filterConsoleFailures(consoleMessages);
    const failedScenario = currentScenario;
    let screenshotPath = null;
    if (page) {
      try {
        screenshotPath = await captureScenario(page, failedScenario ? `${failedScenario}-failure` : "frontend-e2e-failure");
      } catch {
        screenshotPath = null;
      }
    }
    const failureReport = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      failedScenario,
      consoleFailures,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
      screenshots: [
        ...stateScreenshots.map((entry) => entry.screenshotPath),
        ...(screenshotPath ? [screenshotPath] : []),
      ],
    };
    await writeReport(failureReport);
    console.error(failureReport.error.stack ?? failureReport.error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
