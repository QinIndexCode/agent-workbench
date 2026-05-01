import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5573";
const BACKEND_URL = process.env.FRONTEND_LIVE_REVIEW_BACKEND_URL ?? "http://127.0.0.1:3611";
const REPORT_PATH =
  process.env.FRONTEND_E2E_REPORT ??
  process.env.FRONTEND_LIVE_REVIEW_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-live-task-review.json");
const SCREENSHOT_DIR =
  process.env.FRONTEND_E2E_SCREENSHOTS ??
  process.env.FRONTEND_LIVE_REVIEW_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-live-review");
const PROVIDER_ID = process.env.BACKEND_NEW_LIVE_PROVIDER_ID ?? null;
const LIVE_PROVIDER_ENABLED = /^(1|true|yes)$/i.test(process.env.BACKEND_NEW_LIVE_PROVIDER_ENABLED ?? "");
const LIVE_PROVIDER_API_KEY = process.env.BACKEND_NEW_LIVE_PROVIDER_API_KEY ?? null;

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
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 1_000;
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
    `Timed out waiting for task "${taskId}".${lastTask ? ` Last lifecycle=${lastTask.runtime?.lifecycleStatus ?? "missing"}` : ""}`,
  );
}

async function waitForTaskDebug(taskId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 1_000;
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
    `Timed out waiting for debug state on "${taskId}".${lastDebug ? ` Last artifactPathState=${lastDebug.executionSummary?.artifactPathState ?? "missing"}` : ""}`,
  );
}

async function waitForApprovalOrArtifactSelection(taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastTask = null;
  let lastDebug = null;

  while (Date.now() - startedAt < timeoutMs) {
    const [task, debug] = await Promise.all([
      requestJson(`${BACKEND_URL}/tasks/${taskId}`),
      requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`),
    ]);
    lastTask = task;
    lastDebug = debug;

    const pendingApprovals = Array.isArray(task?.pendingApprovals) ? task.pendingApprovals : [];
    if (pendingApprovals.length > 0) {
      return {
        state: "approval_pending",
        task,
        debug,
        pendingApprovals,
      };
    }

    if (debug?.executionSummary?.artifactPathState === "unresolved") {
      return {
        state: "artifact_unresolved",
        task,
        debug,
        pendingApprovals,
      };
    }

    const visibleArtifactPaths = Array.isArray(task?.latestVisibleOutput?.artifactPaths)
      ? task.latestVisibleOutput.artifactPaths
      : [];
    if (
      task?.runtime?.lifecycleStatus === "RUNNING"
      && visibleArtifactPaths.length > 0
      && debug?.executionSummary?.artifactPathState === "sandbox_only"
    ) {
      return {
        state: "artifact_ready_waiting",
        task,
        debug,
        pendingApprovals,
      };
    }

    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
      return {
        state: "terminal",
        task,
        debug,
        pendingApprovals,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for approval or artifact selection on "${taskId}".${
      lastDebug ? ` Last artifactPathState=${lastDebug.executionSummary?.artifactPathState ?? "missing"}` : ""
    }${lastTask ? ` Last lifecycle=${lastTask.runtime?.lifecycleStatus ?? "missing"}` : ""}`,
  );
}

async function waitForTaskCompletionOrApproval(taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastTask = null;
  let lastDebug = null;

  while (Date.now() - startedAt < timeoutMs) {
    const [task, debug] = await Promise.all([
      requestJson(`${BACKEND_URL}/tasks/${taskId}`),
      requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`),
    ]);
    lastTask = task;
    lastDebug = debug;

    const pendingApprovals = Array.isArray(task?.pendingApprovals) ? task.pendingApprovals : [];
    if (pendingApprovals.length > 0) {
      return {
        state: "approval_pending",
        task,
        debug,
        pendingApprovals,
      };
    }

    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
      return {
        state: "terminal",
        task,
        debug,
        pendingApprovals,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for task "${taskId}".${
      lastTask ? ` Last lifecycle=${lastTask.runtime?.lifecycleStatus ?? "missing"}` : ""
    }${lastDebug ? ` Last artifactPathState=${lastDebug.executionSummary?.artifactPathState ?? "missing"}` : ""}`,
  );
}

async function waitForArtifactSelectionStateSettlement(taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    const state = await waitForApprovalOrArtifactSelection(taskId, {
      timeoutMs: Math.min(intervalMs, 2_000),
      intervalMs: Math.min(intervalMs, 500),
    }).catch(() => null);
    if (!state) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    lastState = state;
    if (state.state !== "artifact_ready_waiting") {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return lastState;
}

function buildUnits(role, goal, outputContract, extra = {}) {
  return [
    {
      id: "AGENT-001",
      role,
      goal,
      outputContract,
      dependencies: [],
      ...extra,
    },
  ];
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

async function continueTask(taskId, userMessage = "") {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/continue`, {
    method: "POST",
    body: JSON.stringify({ userMessage }),
  });
}

async function resolveApproval(taskId, invocationId, status = "APPROVED", reason = null) {
  return requestJson(`${BACKEND_URL}/tasks/${taskId}/approvals/resolve`, {
    method: "POST",
    body: JSON.stringify({
      invocationId,
      status,
      reason,
    }),
  });
}

async function resolveAllPendingApprovals(taskId, approvals, reason) {
  const pendingApprovals = Array.isArray(approvals) ? approvals : [];
  for (const approval of pendingApprovals) {
    await resolveApproval(taskId, approval.invocationId, "APPROVED", reason);
  }
  return pendingApprovals.length;
}

async function patchConfig(patch) {
  return requestJson(`${BACKEND_URL}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function ensureLiveProviderSecret() {
  assertCondition(PROVIDER_ID, "Live review provider id is missing.");
  assertCondition(LIVE_PROVIDER_API_KEY?.trim(), "Live review provider api key is missing.");

  const providers = await requestJson(`${BACKEND_URL}/providers`);
  const providerView = Array.isArray(providers)
    ? providers.find((entry) => entry?.profile?.id === PROVIDER_ID)
    : null;
  assertCondition(providerView, `Configured live provider "${PROVIDER_ID}" is not registered by the backend.`);

  const secretId = providerView.profile?.apiKeySecretId ?? `${PROVIDER_ID}-secret`;
  if (!providerView.hasSecret) {
    await requestJson(`${BACKEND_URL}/providers/secrets`, {
      method: "POST",
      body: JSON.stringify({
        secretId,
        provider: PROVIDER_ID,
        label: `live-review:${PROVIDER_ID}`,
        apiKey: LIVE_PROVIDER_API_KEY,
        metadata: {
          source: "frontend-live-task-review",
          ephemeral: true,
        },
      }),
    });
  }

  const testResult = await requestJson(`${BACKEND_URL}/providers/${PROVIDER_ID}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assertCondition(testResult?.ok === true, testResult?.message ?? `Live provider "${PROVIDER_ID}" test failed.`);

  return {
    secretId,
    providerLabel: providerView.profile?.label ?? PROVIDER_ID,
    testMessage: testResult.message ?? "Provider test succeeded.",
  };
}

async function openTask(page, taskId) {
  await page.goto(`${BASE_URL}/tasks?task=${taskId}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="tasks-page"]');
  await page.waitForSelector('[data-testid="task-detail-pane"]');
}

async function captureScreenshot(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
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
    await page.waitForSelector('[data-testid="task-inspector-scroll"]', { timeout: 15_000 });
  } else {
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="task-inspector-scroll"]');
        return !(node instanceof HTMLElement) || node.getClientRects().length === 0;
      },
      undefined,
      { timeout: 15_000 },
    );
  }
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

async function collectReviewChecklist(page, options = {}) {
  return page.evaluate((config) => {
    const bodyText = document.body.innerText;
    const resultCard = document.querySelector('[data-testid="task-result-card"]');
    const assistantUpdate = document.querySelector('[data-testid="task-assistant-update"]');
    const resultMissing = document.querySelector('[data-testid="task-result-missing"]');
    const assistantNotes = document.querySelectorAll('[data-testid="task-assistant-note"]');
    const destinationSection =
      document.querySelector('[data-testid="task-result-destination-section"]')
      ?? document.querySelector('[data-testid="task-result-destination-folder"]');
    const contextDestination = document.querySelector('[data-testid="task-artifact-delivered"]');
    const toolActivities = document.querySelectorAll('[data-testid="task-tool-activity"]');
    const toolEvidence = document.querySelectorAll('[data-testid="task-tool-activity-evidence"]');
    const composer = document.querySelector('[data-testid="task-composer-card"]');
    const taskStatus = document.querySelector('[data-testid="task-status-strip"]');
    const statusText = taskStatus instanceof HTMLElement ? taskStatus.innerText.trim() : "";
    const resultText = resultCard instanceof HTMLElement ? resultCard.innerText.trim() : "";
    const assistantUpdateText = assistantUpdate instanceof HTMLElement ? assistantUpdate.innerText.trim() : "";

    const resultMissingText = resultMissing instanceof HTMLElement ? resultMissing.innerText.trim() : "";

    const summaryVisible =
      (
        (resultCard instanceof HTMLElement && resultText.length > 0)
        || (assistantUpdate instanceof HTMLElement && assistantUpdateText.length > 0)
      );
    const missingSummaryVisible =
      resultMissing instanceof HTMLElement
      && /completed/i.test(resultMissingText)
      && resultMissingText.length > 0;

    return {
      resultCardVisible: resultCard instanceof HTMLElement,
      assistantUpdateVisible: assistantUpdate instanceof HTMLElement,
      resultMissingVisible: resultMissing instanceof HTMLElement,
      summaryVisible,
      missingSummaryVisible,
      assistantNoteCount: assistantNotes.length,
      toolActivityCount: toolActivities.length,
      toolEvidenceCount: toolEvidence.length,
      toolActivityVisible: toolActivities.length > 0,
      destinationVisible: destinationSection instanceof HTMLElement,
      contextDestinationVisible: contextDestination instanceof HTMLElement,
      composerVisible: composer instanceof HTMLElement,
      statusVisible: taskStatus instanceof HTMLElement,
      statusText,
      resultText,
      rawProtocolHidden:
        !bodyText.includes("[AGENT-001_OUTPUT]")
        && !bodyText.includes('"current_unit"')
        && !bodyText.includes('"tool_name"'),
      bodyTextLength: bodyText.trim().length,
      passes:
        (summaryVisible || missingSummaryVisible)
        && composer instanceof HTMLElement
        && !bodyText.includes("[AGENT-001_OUTPUT]")
        && !bodyText.includes('"current_unit"')
        && !bodyText.includes('"tool_name"')
        && (config.expectAssistantNote ? assistantNotes.length > 0 : true)
        && (config.expectToolActivity ? toolActivities.length > 0 : true)
        && (config.expectToolEvidence ? toolEvidence.length > 0 : true)
        && (config.expectDestination ? destinationSection instanceof HTMLElement : true)
        && (config.expectContextDestination ? contextDestination instanceof HTMLElement : true),
    };
  }, options);
}

async function verifyToolActivityIcons(page) {
  const cardCount = await page.locator('[data-testid="task-tool-activity"]').count();
  assertCondition(cardCount > 0, "Expected at least one visible tool activity card.");
  const iconCount = await page.locator('[data-testid="task-tool-activity-icon"]').count();
  assertCondition(iconCount >= cardCount, `Tool activity cards are missing icon nodes. cards=${cardCount} icons=${iconCount}`);
  return {
    checked: true,
    cardCount,
    iconCount,
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
  if (!(await textarea.isVisible().catch(() => false))) {
    return {
      checked: true,
      skipped: true,
      reason: "no_visible_textarea_after_follow_up_expand",
    };
  }
  const draftValue = `live-review-anchor-${Date.now()}`;
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
  await page.waitForTimeout(300);
  await setContextVisibility(page, true);
  await page.waitForTimeout(120);
  await setContextVisibility(page, false);
  await page.waitForTimeout(120);
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

function buildScenarioRecord(params) {
  const publicAssistantMessages = Array.isArray(params.task?.conversations)
    ? params.task.conversations.filter(
      (message) => message.role === "assistant" && message.metadata?.source === "assistant_summary",
    )
    : [];
  return {
    name: params.name,
    status: params.status,
    taskId: params.taskId,
    title: params.title,
    lifecycleStatus: params.task?.runtime?.lifecycleStatus ?? null,
    publicConversationCount: Array.isArray(params.task?.conversations) ? params.task.conversations.length : 0,
    publicAssistantConversationCount: publicAssistantMessages.length,
    publicAssistantDisplayKinds: publicAssistantMessages
      .map((message) => (typeof message.metadata?.displayKind === "string" ? message.metadata.displayKind : null))
      .filter(Boolean),
    visibleToolActivityCount: Array.isArray(params.task?.visibleToolActivities) ? params.task.visibleToolActivities.length : 0,
    visibleToolActivityStatuses: Array.isArray(params.task?.visibleToolActivities)
      ? params.task.visibleToolActivities.map((activity) => activity.status)
      : [],
    latestVisibleOutput: params.task?.latestVisibleOutput
      ? {
          source: params.task.latestVisibleOutput.source,
          summary: params.task.latestVisibleOutput.summary,
          details: params.task.latestVisibleOutput.details,
          artifactPaths: params.task.latestVisibleOutput.artifactPaths,
          artifactDestinationPaths: params.task.latestVisibleOutput.artifactDestinationPaths,
          artifactDestinationDir: params.task.latestVisibleOutput.artifactDestinationDir,
          artifactApplyStatus: params.task.latestVisibleOutput.artifactApplyStatus,
        }
      : null,
    executionSummary: params.debug?.executionSummary
      ? {
          artifactPathState: params.debug.executionSummary.artifactPathState,
          artifactPaths: params.debug.executionSummary.artifactPaths,
          artifactDestinationPaths: params.debug.executionSummary.artifactDestinationPaths,
          selectedArtifactDir: params.debug.executionSummary.selectedArtifactDir,
          recommendedArtifactDir: params.debug.executionSummary.recommendedArtifactDir,
          lastArtifactApplyResult: params.debug.executionSummary.lastArtifactApplyResult,
          issueSummary: params.debug.executionSummary.issueSummary,
          providerSummary: params.debug.executionSummary.providerSummary,
        }
      : null,
    screenshots: params.screenshots,
    checklist: params.checklist,
    notes: params.notes,
    error: params.error ?? null,
  };
}

function collectAssistantSummaryKinds(task) {
  return Array.isArray(task?.conversations)
    ? task.conversations
      .filter((message) => message.role === "assistant" && message.metadata?.source === "assistant_summary")
      .map((message) => (typeof message.metadata?.displayKind === "string" ? message.metadata.displayKind : null))
      .filter(Boolean)
    : [];
}

function createUniqueArtifactPath(prefix = "live-review-handoff") {
  const runToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `scratch/${prefix}-${runToken}.md`;
}

async function runClarificationScenario(page) {
  const title = `Live clarification review ${Date.now()}`;
  const taskId = await submitTask({
    title,
    intent: "The request is intentionally vague. Produce a concise operator-facing clarification note that explains what information is missing, why it matters, and the safest next step. Do not invent specifics or create files.",
    preferredProviderId: PROVIDER_ID,
    pathPolicy: "task_workspace",
    units: buildUnits(
      "Clarifier",
      "Produce a short clarification note without inventing missing facts.",
      '{"summary":"string","details":"string","issues":[]}',
    ),
  });
  assertCondition(taskId, "Clarification review task was not created.");

  await startTask(taskId, "Review the vague request and return a short clarification note for the operator.");
  const task = await waitForTaskDetail(
    taskId,
    (entry) => ["COMPLETED", "FAILED", "CANCELLED"].includes(entry.runtime?.lifecycleStatus),
    { timeoutMs: 300_000 },
  );
  const debug = await requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`);

  await openTask(page, taskId);
  await setContextVisibility(page, false);
  await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 30_000 });
  await ensureTimelineSelectorVisible(page, '[data-testid="task-assistant-note"]');
  const screenshotPath = await captureScreenshot(page, "live-clarification");
  const checklist = await collectReviewChecklist(page, {
    expectAssistantNote: true,
  });
  const publicAssistantConversationCount = task.conversations.filter(
    (message) => message.role === "assistant" && message.metadata?.source === "assistant_summary",
  ).length;
  const discussionMode =
    publicAssistantConversationCount > 0
      ? "assistant_discussion_visible"
      : task.latestVisibleOutput
        ? "result_card_only"
        : "no_visible_assistant_response";

  return buildScenarioRecord({
    name: "live-clarification-led-task",
    status:
      task.runtime?.lifecycleStatus === "COMPLETED"
      && checklist.passes
      && Boolean(task.latestVisibleOutput?.summary)
      && checklist.assistantNoteCount >= 1
      && publicAssistantConversationCount >= 1
        ? "passed"
        : "failed",
    taskId,
    title,
    task,
    debug,
    screenshots: [screenshotPath],
    checklist,
    notes: {
      discussionMode,
      publicAssistantConversationCount,
      toolActivityCount: checklist.toolActivityCount,
      visibleSummary: task.latestVisibleOutput?.summary ?? null,
    },
    error:
      task.runtime?.lifecycleStatus === "COMPLETED"
      && checklist.passes
      && Boolean(task.latestVisibleOutput?.summary)
      && checklist.assistantNoteCount >= 1
      && publicAssistantConversationCount >= 1
        ? null
        : `Clarification task did not render a visible assistant note plus summary. lifecycle=${task.runtime?.lifecycleStatus ?? "missing"}`,
  });
}

async function runArtifactDeliveryScenario(page) {
  const title = `Live artifact delivery review ${Date.now()}`;
  const artifactRelativePath = createUniqueArtifactPath();
  const taskId = await submitTask({
    title,
    intent: [
      "Create a short markdown handoff note as a project artifact.",
      `You must use a real write tool to create ${artifactRelativePath}.`,
      "Do not claim completion until the artifact exists and the operator selects a destination.",
      "Wait for the operator-selected destination before finishing."
    ].join(" "),
    preferredProviderId: PROVIDER_ID,
    pathPolicy: "ask_if_unclear",
    units: buildUnits(
      "Writer",
      "Create a markdown artifact, wait for an operator-selected destination, then confirm delivery.",
      '{"summary":"string","artifact":"string","details":"string","issues":[]}',
      {
        executionProfileId: "implement",
        taskScope: `Use the write_file tool to create ${artifactRelativePath}. Do not invent a destination or claim completion before the operator applies the artifact to a project-relative directory.`,
        exitCondition: '{"artifact":"required"}'
      }
    ),
  });
  assertCondition(taskId, "Artifact delivery review task was not created.");

  await startTask(
    taskId,
    `Create a short markdown handoff note at ${artifactRelativePath} and wait for the operator to choose the destination before finishing.`,
  );

  try {
    const intermediateScreenshots = [];
    const approvalResolutions = [];
    const continueNudges = [];
    let waitState = await waitForApprovalOrArtifactSelection(taskId, { timeoutMs: 300_000 });

    while (waitState.state === "approval_pending" || waitState.state === "artifact_ready_waiting") {
      await openTask(page, taskId);

      if (waitState.state === "approval_pending") {
        await setContextVisibility(page, true);
        const approvalScreenshot = await captureScreenshot(
          page,
          `live-artifact-delivery-approval-pending-${approvalResolutions.length + 1}`,
        );
        intermediateScreenshots.push(approvalScreenshot);
        const resolvedCount = await resolveAllPendingApprovals(
          taskId,
          waitState.pendingApprovals,
          "Approved during frontend live review to continue artifact delivery.",
        );
        approvalResolutions.push({
          resolvedCount,
          invocationIds: waitState.pendingApprovals.map((approval) => approval.invocationId),
        });
      } else {
        const settledState = await waitForArtifactSelectionStateSettlement(taskId, {
          timeoutMs: 15_000,
          intervalMs: 1_000,
        });
        if (settledState && settledState.state !== "artifact_ready_waiting") {
          waitState = settledState;
          continue;
        }
        assertCondition(
          continueNudges.length < 2,
          "Artifact delivery stayed in the waiting state after repeated continue nudges.",
        );
        await setContextVisibility(page, false);
        const waitingScreenshot = await captureScreenshot(
          page,
          `live-artifact-delivery-awaiting-selection-${continueNudges.length + 1}`,
        );
        intermediateScreenshots.push(waitingScreenshot);
        await continueTask(
          taskId,
          `If the artifact file has not been created yet, use the write tool now to create ${artifactRelativePath}. If it already exists, pause and wait for the operator-selected destination before finishing the thread.`,
        );
        continueNudges.push({
          afterLifecycle: waitState.task?.runtime?.lifecycleStatus ?? null,
          artifactPaths: waitState.task?.latestVisibleOutput?.artifactPaths ?? [],
          issueSummary: waitState.debug?.executionSummary?.issueSummary ?? null,
        });
      }

      waitState = await waitForApprovalOrArtifactSelection(taskId, { timeoutMs: 300_000 });
    }

    assertCondition(
      waitState.state === "artifact_unresolved",
      `Expected artifact selection state before apply, received ${waitState.state}.`,
    );

    const unresolvedTask = waitState.task;
    const unresolvedDebug = waitState.debug;
    const unresolvedAssistantDisplayKinds = collectAssistantSummaryKinds(unresolvedTask);
    assertCondition(
      unresolvedAssistantDisplayKinds.includes("artifact_ready"),
      `Artifact delivery unresolved state did not expose an artifact_ready assistant summary. Kinds=${JSON.stringify(unresolvedAssistantDisplayKinds)}`,
    );

    await openTask(page, taskId);
    await setContextVisibility(page, true);
    await page.waitForSelector('[data-testid="task-action-choose-custom-path"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="task-assistant-note"]', { timeout: 30_000 });
    await ensureTimelineSelectorVisible(page, '[data-testid="task-assistant-note"]');
    const unresolvedScreenshot = await captureScreenshot(page, "live-artifact-delivery-unresolved");
    const unresolvedChecklist = await collectReviewChecklist(page, {
      expectAssistantNote: true,
      expectToolActivity: true,
      expectToolEvidence: true,
    });
    const unresolvedToolIcons = await verifyToolActivityIcons(page);
    assertCondition(
      unresolvedChecklist.assistantNoteCount >= 1,
      "Artifact delivery unresolved state did not render an assistant note.",
    );
    assertCondition(
      unresolvedChecklist.toolActivityCount >= 1,
      "Artifact delivery unresolved state did not render a visible tool activity card.",
    );
    const selectedDestinationDir = "backend/docs/live-review-artifacts";
    await page.locator('[data-testid="task-action-choose-custom-path"]').click();
    await page.locator('[data-testid="task-artifact-dir"]').fill(selectedDestinationDir);
    await page.waitForFunction(
      () => {
        const button = document.querySelector('[data-testid="task-action-apply-artifacts"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.locator('[data-testid="task-action-apply-artifacts"]').click();
    const appliedDebug = await waitForTaskDebug(
      taskId,
      (entry) => entry.executionSummary?.artifactPathState === "applied",
      { timeoutMs: 120_000 },
    );
    let continuedAfterApply = false;
    let task = await requestJson(`${BACKEND_URL}/tasks/${taskId}`);
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.runtime?.lifecycleStatus) && !(task.pendingApprovals?.length > 0)) {
      await continueTask(
        taskId,
        `The selected destination ${selectedDestinationDir} has already been applied. Do not create or rewrite scratch artifacts again. Confirm the delivered location and finish the delivery.`,
      );
      continuedAfterApply = true;
    }

    let finalState = await waitForTaskCompletionOrApproval(taskId, { timeoutMs: 300_000 });
    while (finalState.state === "approval_pending") {
      await openTask(page, taskId);
      await setContextVisibility(page, true);
      const approvalScreenshot = await captureScreenshot(
        page,
        `live-artifact-delivery-post-apply-approval-${approvalResolutions.length + 1}`,
      );
      intermediateScreenshots.push(approvalScreenshot);
      const resolvedCount = await resolveAllPendingApprovals(
        taskId,
        finalState.pendingApprovals,
        "Approved during frontend live review to finish artifact delivery.",
      );
      approvalResolutions.push({
        resolvedCount,
        invocationIds: finalState.pendingApprovals.map((approval) => approval.invocationId),
        phase: "post_apply",
      });
      finalState = await waitForTaskCompletionOrApproval(taskId, { timeoutMs: 300_000 });
    }

    assertCondition(finalState.state === "terminal", `Expected terminal state after apply, received ${finalState.state}.`);
    task = finalState.task;
    const debug = finalState.debug;
    await openTask(page, taskId);
    await setContextVisibility(page, false);
    const completedScreenshot = await captureScreenshot(page, "live-artifact-delivery-completed");
    const composerRefreshAnchor = await verifyComposerRefreshAnchor(page);
    await setContextVisibility(page, true);
    const contextScreenshot = await captureScreenshot(page, "live-artifact-delivery-context");
    const checklist = await collectReviewChecklist(page, {
      expectDestination: true,
      expectToolActivity: true,
    });

    return buildScenarioRecord({
      name: "live-artifact-delivery-task",
      status:
        task.runtime?.lifecycleStatus === "COMPLETED"
        && checklist.passes
        && (
          (typeof task.latestVisibleOutput?.summary === "string" && task.latestVisibleOutput.summary.toLowerCase().includes("delivered"))
          || (typeof checklist.resultText === "string" && checklist.resultText.toLowerCase().includes("delivered"))
        )
        && Array.isArray(debug.executionSummary?.artifactDestinationPaths)
        && debug.executionSummary.artifactDestinationPaths.length > 0
        && unresolvedChecklist.assistantNoteCount >= 1
        && unresolvedAssistantDisplayKinds.includes("artifact_ready")
          ? "passed"
          : "failed",
      taskId,
      title,
      task,
      debug,
      screenshots: [...intermediateScreenshots, unresolvedScreenshot, completedScreenshot, contextScreenshot],
      checklist,
      notes: {
        recommendedDestinationDir: unresolvedDebug.executionSummary?.recommendedArtifactDir ?? null,
        artifactRelativePath,
        selectedDestinationDir: appliedDebug.executionSummary?.selectedArtifactDir ?? null,
        unresolvedAssistantNoteCount: unresolvedChecklist.assistantNoteCount,
        unresolvedToolActivityCount: unresolvedChecklist.toolActivityCount,
        unresolvedPublicAssistantDisplayKinds: unresolvedAssistantDisplayKinds,
        finalToolActivityCount: checklist.toolActivityCount,
        finalDestinationPaths: debug.executionSummary?.artifactDestinationPaths ?? [],
        unresolvedState: unresolvedDebug.executionSummary?.artifactPathState ?? null,
        appliedState: appliedDebug.executionSummary?.artifactPathState ?? null,
        unresolvedToolIcons,
        composerRefreshAnchor,
        continuedAfterApply,
        approvalResolutions,
        continueNudges,
      },
      error:
        task.runtime?.lifecycleStatus === "COMPLETED"
        && checklist.passes
        && (
          (typeof task.latestVisibleOutput?.summary === "string" && task.latestVisibleOutput.summary.toLowerCase().includes("delivered"))
          || (typeof checklist.resultText === "string" && checklist.resultText.toLowerCase().includes("delivered"))
        )
        && Array.isArray(debug.executionSummary?.artifactDestinationPaths)
        && debug.executionSummary.artifactDestinationPaths.length > 0
        && unresolvedChecklist.assistantNoteCount >= 1
        && unresolvedAssistantDisplayKinds.includes("artifact_ready")
          ? null
        : `Artifact delivery task did not expose a completed delivery destination. lifecycle=${task.runtime?.lifecycleStatus ?? "missing"}`,
    });
  } catch (error) {
    const task = await requestJson(`${BACKEND_URL}/tasks/${taskId}`).catch(() => null);
    const debug = await requestJson(`${BACKEND_URL}/tasks/${taskId}/debug`).catch(() => null);
    await openTask(page, taskId);
    await setContextVisibility(page, false);
    const failureScreenshot = await captureScreenshot(page, "live-artifact-delivery-failure");
    return buildScenarioRecord({
      name: "live-artifact-delivery-task",
      status: "failed",
      taskId,
      title,
      task,
      debug,
      screenshots: [failureScreenshot],
      checklist: await collectReviewChecklist(page),
      notes: {
        recommendedDestinationDir: debug?.executionSummary?.recommendedArtifactDir ?? null,
        artifactRelativePath,
        selectedDestinationDir: debug?.executionSummary?.selectedArtifactDir ?? null,
        finalDestinationPaths: debug?.executionSummary?.artifactDestinationPaths ?? [],
        artifactPathState: debug?.executionSummary?.artifactPathState ?? null,
        pendingApprovalCount: Array.isArray(task?.pendingApprovals) ? task.pendingApprovals.length : 0,
      },
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable was not found. Set CHROME_EXECUTABLE to run frontend live task review.");
  }

  if (!LIVE_PROVIDER_ENABLED || !PROVIDER_ID) {
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: "external_blocker",
      passes: false,
      reason: "Live provider env is missing or disabled.",
      scenarios: [],
      screenshots: [],
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!LIVE_PROVIDER_API_KEY?.trim()) {
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: "external_blocker",
      passes: false,
      reason: "Live provider api key env is missing.",
      scenarios: [],
      screenshots: [],
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await patchConfig({
    tools: {
      permissionMode: "full",
    },
  });

  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });

  const scenarios = [];
  const screenshots = [];
  let page = null;

  try {
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    const providerSetup = await ensureLiveProviderSecret();
    await openTask(page, "none");

    const clarificationScenario = await runClarificationScenario(page);
    clarificationScenario.notes = {
      ...clarificationScenario.notes,
      providerSetup,
    };
    scenarios.push(clarificationScenario);
    screenshots.push(...clarificationScenario.screenshots);

    const artifactScenario = await runArtifactDeliveryScenario(page);
    artifactScenario.notes = {
      ...artifactScenario.notes,
      providerSetup,
    };
    scenarios.push(artifactScenario);
    screenshots.push(...artifactScenario.screenshots);

    const status = scenarios.every((scenario) => scenario.status === "passed") ? "achieved" : "open_gap";
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status,
      passes: status === "achieved",
      scenarios,
      screenshots,
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "achieved") {
      process.exitCode = 1;
    }
  } catch (error) {
    let failureScreenshot = null;
    if (page) {
      try {
        failureScreenshot = await captureScreenshot(page, "live-task-review-failure");
      } catch {
        failureScreenshot = null;
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: "open_gap",
      passes: false,
      scenarios,
      screenshots: failureScreenshot ? [...screenshots, failureScreenshot] : screenshots,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    };
    await writeReport(report);
    console.error(report.error.stack ?? report.error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
