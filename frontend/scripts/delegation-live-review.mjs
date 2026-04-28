import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5773";
const BACKEND_URL = process.env.FRONTEND_DELEGATION_LIVE_REVIEW_BACKEND_URL ?? "http://127.0.0.1:3811";
const REPORT_PATH =
  process.env.FRONTEND_DELEGATION_LIVE_REVIEW_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-delegation-live-review.json");
const SCREENSHOT_DIR =
  process.env.FRONTEND_DELEGATION_LIVE_REVIEW_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-delegation-live-review");
const PROVIDER_ID = process.env.BACKEND_NEW_LIVE_PROVIDER_ID ?? null;
const LIVE_PROVIDER_ENABLED = /^(1|true|yes)$/i.test(process.env.BACKEND_NEW_LIVE_PROVIDER_ENABLED ?? "");
const LIVE_PROVIDER_API_KEY = process.env.BACKEND_NEW_LIVE_PROVIDER_API_KEY ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function api(pathname, init) {
  return requestJson(`${BACKEND_URL}${pathname}`, init);
}

async function patchConfig(patch) {
  return api("/config", { method: "PATCH", body: JSON.stringify(patch) });
}

async function ensureDelegationReviewConfig() {
  await patchConfig({
    tools: { permissionMode: "full" },
    runtime: { delegation: { enabled: true, maxDepth: 1, maxActiveChildrenPerTask: 1 } },
  });
  let configState = await api("/config");
  const hasExpectedConfig = () =>
    configState?.current?.runtime?.delegation?.enabled === true
    && configState?.current?.tools?.permissionMode === "full";

  if (!hasExpectedConfig()) {
    await api("/config/reload", { method: "POST", body: JSON.stringify({}) });
    configState = await api("/config");
  }
  if (!hasExpectedConfig()) {
    await patchConfig({
      tools: { permissionMode: "full" },
      runtime: { delegation: { enabled: true, maxDepth: 1, maxActiveChildrenPerTask: 1 } },
    });
    configState = await api("/config");
  }

  return configState;
}

async function submitTask(input) {
  const response = await api("/tasks", { method: "POST", body: JSON.stringify(input) });
  return response.command?.taskId ?? response.task?.definition?.taskId ?? null;
}

async function startTask(taskId, userMessage = "") {
  return api(`/tasks/${taskId}/start`, { method: "POST", body: JSON.stringify({ userMessage }) });
}

async function continueTask(taskId, userMessage = "") {
  return api(`/tasks/${taskId}/continue`, { method: "POST", body: JSON.stringify({ userMessage }) });
}

async function resolveAllPendingApprovals(taskId, approvals, reason) {
  for (const approval of approvals ?? []) {
    await api(`/tasks/${taskId}/approvals/resolve`, {
      method: "POST",
      body: JSON.stringify({
        invocationId: approval.invocationId,
        status: "APPROVED",
        reason,
      }),
    });
  }
}

async function pollTask(taskId) {
  const [task, debug] = await Promise.all([
    api(`/tasks/${taskId}`),
    api(`/tasks/${taskId}/debug`),
  ]);
  return { task, debug };
}

async function waitFor(taskId, predicate, { timeoutMs = 300000, intervalMs = 1000 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const next = await pollTask(taskId);
    last = next;
    const matched = await predicate(next);
    if (matched) {
      return matched === true ? next : matched;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for task "${taskId}". Last lifecycle=${last?.task?.runtime?.lifecycleStatus ?? "missing"} last artifactPathState=${last?.debug?.executionSummary?.artifactPathState ?? "missing"}`,
  );
}

async function ensureLiveProviderSecret() {
  assertCondition(PROVIDER_ID, "Delegation live review provider id is missing.");
  assertCondition(LIVE_PROVIDER_API_KEY?.trim(), "Delegation live review provider api key is missing.");
  const providers = await api("/providers");
  const providerView = Array.isArray(providers) ? providers.find((entry) => entry?.profile?.id === PROVIDER_ID) : null;
  assertCondition(providerView, `Configured live provider "${PROVIDER_ID}" is not registered by the backend.`);
  const secretId = providerView.profile?.apiKeySecretId ?? `${PROVIDER_ID}-secret`;
  if (!providerView.hasSecret) {
    await api("/providers/secrets", {
      method: "POST",
      body: JSON.stringify({
        secretId,
        provider: PROVIDER_ID,
        label: `delegation-live-review:${PROVIDER_ID}`,
        apiKey: LIVE_PROVIDER_API_KEY,
        metadata: { source: "frontend-delegation-live-review", ephemeral: true },
      }),
    });
  }
  const testResult = await api(`/providers/${PROVIDER_ID}/test`, { method: "POST", body: JSON.stringify({}) });
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
    await page.waitForSelector('[data-testid="task-inspector-scroll"]', { timeout: 15000 });
  } else {
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="task-inspector-scroll"]');
      return !(node instanceof HTMLElement) || node.getClientRects().length === 0;
    }, undefined, { timeout: 15000 });
  }
}

async function ensureVisible(page, selector) {
  const target = page.locator(selector).first();
  if (await target.count() === 0) {
    return false;
  }
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  return true;
}

async function collectChecklist(page, options = {}) {
  return page.evaluate((config) => {
    const bodyText = document.body.innerText;
    const query = (selector) => document.querySelector(selector);
    const visible = (selector) => query(selector) instanceof HTMLElement;
    const resultCard = query('[data-testid="task-result-card"]');
    const statusStrip = query('[data-testid="task-status-strip"]');
    return {
      delegationCardVisible: visible('[data-testid="task-delegation-card"]'),
      resultCardVisible: resultCard instanceof HTMLElement,
      destinationVisible:
        visible('[data-testid="task-result-destination-section"]')
        || visible('[data-testid="task-result-destination-folder"]'),
      contextDestinationVisible: visible('[data-testid="task-artifact-delivered"]'),
      toolActivityVisible: document.querySelectorAll('[data-testid="task-tool-activity"]').length > 0,
      recommendedPathVisible: visible('[data-testid="task-action-use-recommended-path"]'),
      resultText: resultCard instanceof HTMLElement ? resultCard.innerText.trim() : "",
      statusText: statusStrip instanceof HTMLElement ? statusStrip.innerText.trim() : "",
      rawProtocolHidden:
        !bodyText.includes("[AGENT-001_OUTPUT]")
        && !bodyText.includes('"current_unit"')
        && !bodyText.includes('"tool_name"'),
      passes:
        !bodyText.includes("[AGENT-001_OUTPUT]")
        && !bodyText.includes('"current_unit"')
        && !bodyText.includes('"tool_name"')
        && (!config.expectDelegationCard || visible('[data-testid="task-delegation-card"]'))
        && (!config.expectResultCard || (resultCard instanceof HTMLElement && resultCard.innerText.trim().length > 0))
        && (!config.expectDestination || (visible('[data-testid="task-result-destination-section"]') || visible('[data-testid="task-result-destination-folder"]')))
        && (!config.expectContextDestination || visible('[data-testid="task-artifact-delivered"]'))
        && (!config.expectToolActivity || document.querySelectorAll('[data-testid="task-tool-activity"]').length > 0)
        && (!config.expectRecommendedPath || visible('[data-testid="task-action-use-recommended-path"]')),
    };
  }, options);
}

function uniqueArtifactPath(prefix) {
  return `scratch/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
}

function isDelegationActivity(activity) {
  const toolId = typeof activity?.toolId === "string" ? activity.toolId : "";
  const summary = typeof activity?.summary === "string" ? activity.summary : "";
  return toolId === "delegate_subtask"
    || toolId === "delegate-subtask"
    || /\bdelegated\b.+\bchild task\b/i.test(summary)
    || /\bdelegated\b.+\bsubtask\b/i.test(summary);
}

function summarizeExecution(debug, unresolvedDebug = null) {
  return {
    artifactPathState: debug?.executionSummary?.artifactPathState ?? null,
    artifactPaths: debug?.executionSummary?.artifactPaths ?? [],
    artifactDestinationPaths: debug?.executionSummary?.artifactDestinationPaths ?? [],
    selectedArtifactDir: debug?.executionSummary?.selectedArtifactDir ?? null,
    recommendedArtifactDir:
      debug?.executionSummary?.recommendedArtifactDir
      ?? unresolvedDebug?.executionSummary?.recommendedArtifactDir
      ?? null,
    lastArtifactApplyResult: debug?.executionSummary?.lastArtifactApplyResult ?? null,
  };
}

function buildScenarioRecord({
  status,
  taskId,
  childTaskId = null,
  title,
  task,
  debug,
  unresolvedDebug = null,
  screenshots = [],
  checklist = {},
  notes = {},
  error = null,
}) {
  return {
    name: "delegated-subtask-success",
    status,
    parentTaskId: taskId,
    childTaskId,
    title,
    lifecycleStatus: task?.runtime?.lifecycleStatus ?? null,
    delegationSummary: task?.delegationSummary ?? null,
    latestVisibleOutput: task?.latestVisibleOutput ?? null,
    executionSummary: summarizeExecution(debug, unresolvedDebug),
    screenshots,
    checklist,
    notes,
    error,
  };
}

function buildConfigNotEnabledReport(reason, configState = null) {
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    backendUrl: BACKEND_URL,
    providerId: PROVIDER_ID,
    status: "config_not_enabled",
    reason,
    configState,
    scenarios: [],
    screenshots: [],
  };
}

function deriveReviewStatus(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return "boundary_violation";
  }
  if (scenarios.every((item) => item.status === "achieved")) {
    return "achieved";
  }
  return scenarios[0]?.status ?? "boundary_violation";
}

function classifyUnexpectedFailure(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("could not enable runtime delegation") || message.includes("config_not_enabled")) {
    return "config_not_enabled";
  }
  if (
    message.includes("delegate_subtask")
    || message.includes("delegation_never_visible")
    || message.includes("required delegated child task")
    || message.includes("provider skipped")
    || message.includes("required delegation")
  ) {
    return "provider_skipped_required_delegation";
  }
  if (
    message.includes("cannot delegate again")
    || message.includes("unexpectedly reports delegation available")
    || message.includes("leaked into the top-level task list")
    || message.includes("boundary")
    || message.includes("nested delegation")
  ) {
    return "boundary_violation";
  }
  return "boundary_violation";
}

async function runDelegationScenario(page) {
  const title = `Live delegation review ${Date.now()}`;
  const parentArtifactPath = uniqueArtifactPath("delegated-parent-handoff");
  const childArtifactPath = uniqueArtifactPath("delegated-child-note");
  const taskId = await submitTask({
    title,
    intent: [
      "Use one controlled delegated child task, then finish a parent-owned delivery.",
      "Call delegate_subtask exactly once.",
      'Child title must be "Delegated note draft".',
      'Child role must be "SubSccAgent".',
      `Child must use write_file to create ${childArtifactPath} in the child workspace.`,
      "Child must stay inside the child boundary, must not ask for a destination, and must not delegate again.",
      `After the child returns, the parent must use write_file to create ${parentArtifactPath} in the parent workspace.`,
      "The parent owns final delivery and must wait for the operator-selected destination before finishing.",
      "Do not claim completion before the artifact is applied.",
    ].join(" "),
    preferredProviderId: PROVIDER_ID,
    pathPolicy: "ask_if_unclear",
    units: [
      {
        id: "AGENT-001",
        role: "Implementer",
        goal: "Delegate one bounded child, integrate its scoped result, and finish parent-owned delivery.",
        outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
        dependencies: [],
        executionProfileId: "implement",
        delegationRequired: true,
        delegationContract: {
          title: "Delegated note draft",
          role: "SubSccAgent",
          goal: `Draft a short scoped note and create ${childArtifactPath} in the child workspace.`,
          taskScope: [
            `Create only ${childArtifactPath} inside the child workspace.`,
            "Do not ask for a project delivery destination.",
            "Do not delegate again.",
          ].join(" "),
          outputContract: '{"summary":"string","details":"string","issues":[]}',
          allowedToolIds: ["write-file"],
          successCriteria: "Return the scoped note and child artifact path.",
        },
        taskScope: [
          "Delegate one child inside the controlled SubSccAgent boundary.",
          `The child may only write ${childArtifactPath} inside its own workspace.`,
          `The parent must write ${parentArtifactPath} after the child returns.`,
          "The parent owns final delivery and must wait for the operator-selected destination.",
        ].join(" "),
        exitCondition: '{"artifact":"required"}',
      },
    ],
  });
  assertCondition(taskId, "Delegation live review task was not created.");

  const scenarioNotes = {
    continueNudges: [],
    delegationRecoveryMessages: [],
    delegationRecoveryAttempts: 0,
    artifactRecoveryAttempts: 0,
    childLifecycleStatus: null,
    childCanDelegate: null,
    childDelegationReason: null,
    topLevelChildHidden: null,
    topLevelChildHiddenCheckRan: false,
    recentChildCount: 0,
    delegationActivity: null,
    visibleDelegationActivityCount: 0,
    noDelegationDetected: false,
    noDelegationReason: null,
  };
  const scenarioScreenshots = [];
  const scenarioChecklist = {};

  await startTask(
    taskId,
    `Delegate one bounded child task, use its scoped result to create ${parentArtifactPath}, then wait for the operator-selected destination.`,
  );

  let delegationState = await waitFor(taskId, ({ task, debug }) => {
    const pendingApprovals = task.pendingApprovals ?? [];
    if (pendingApprovals.length > 0) {
      return { state: "approval_pending", task, debug, pendingApprovals, child: null };
    }
    if (task?.delegationSummary?.missingRequiredDelegation) {
      return { state: "required_delegation_missing", task, debug, pendingApprovals, child: null };
    }
    const activeChild = task?.delegationSummary?.activeChildTask ?? null;
    const recentChild = activeChild ? null : (task?.delegationSummary?.recentChildren?.[0] ?? null);
    if (activeChild || recentChild) {
      return { state: activeChild ? "delegation_active" : "delegation_recent", task, debug, pendingApprovals, child: activeChild ?? recentChild };
    }
    const artifactPaths = task?.latestVisibleOutput?.artifactPaths ?? [];
    if (task?.runtime?.lifecycleStatus === "RUNNING" && artifactPaths.length > 0 && debug?.executionSummary?.artifactPathState === "sandbox_only") {
      return { state: "artifact_ready_without_delegation", task, debug, pendingApprovals, child: null };
    }
    if (debug?.executionSummary?.artifactPathState === "unresolved") {
      return { state: "artifact_unresolved_without_delegation", task, debug, pendingApprovals, child: null };
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
      return { state: "terminal", task, debug, pendingApprovals, child: null };
    }
    return false;
  }, { timeoutMs: 360000 });

  let delegationRecoveryAttempts = 0;
  while (
    delegationState.state === "approval_pending"
    || delegationState.state === "required_delegation_missing"
    || delegationState.state === "terminal"
    || delegationState.state === "artifact_ready_without_delegation"
    || delegationState.state === "artifact_unresolved_without_delegation"
  ) {
    if (delegationState.state === "approval_pending") {
      await resolveAllPendingApprovals(taskId, delegationState.pendingApprovals, "Approved during delegation live review.");
    } else if (delegationState.state === "required_delegation_missing") {
      if (delegationRecoveryAttempts >= 2) {
        break;
      }
      delegationRecoveryAttempts += 1;
      const recoveryMessage = [
        "The runtime still requires a delegated child task before the parent can continue.",
        'Continue this same thread and correct it now.',
        'You must call delegate_subtask exactly once to create a bounded child titled "Delegated note draft".',
        "Do not produce parent-owned delivery output before the child exists.",
      ].join(" ");
      scenarioNotes.delegationRecoveryMessages.push(recoveryMessage);
      await continueTask(taskId, recoveryMessage);
    } else if (delegationState.state === "artifact_unresolved_without_delegation") {
      break;
    } else if (delegationState.state === "artifact_ready_without_delegation") {
      if (delegationRecoveryAttempts >= 2) {
        break;
      }
      delegationRecoveryAttempts += 1;
      const recoveryMessage = [
        "The previous pass still has not created the delegated child task.",
        'Continue this same thread and correct it now.',
        'You must call delegate_subtask exactly once to create a bounded child titled "Delegated note draft".',
        "If the parent artifact is already prepared, advance to the operator-selected destination state instead of staying in sandbox_only.",
      ].join(" ");
      scenarioNotes.delegationRecoveryMessages.push(recoveryMessage);
      await continueTask(taskId, recoveryMessage);
    } else {
      if (delegationRecoveryAttempts >= 2) {
        break;
      }
      delegationRecoveryAttempts += 1;
      const recoveryMessage = [
        "The previous pass did not satisfy the contract because no delegated child task was created.",
        'Continue this same thread and correct it now.',
        'You must call delegate_subtask exactly once to create a bounded child titled "Delegated note draft".',
        "Let the child finish, then write the parent artifact and wait for the operator-selected destination before finishing.",
      ].join(" ");
      scenarioNotes.delegationRecoveryMessages.push(recoveryMessage);
      await continueTask(taskId, recoveryMessage);
    }
    delegationState = await waitFor(taskId, ({ task, debug }) => {
      const pendingApprovals = task.pendingApprovals ?? [];
      if (pendingApprovals.length > 0) {
        return { state: "approval_pending", task, debug, pendingApprovals, child: null };
      }
      if (task?.delegationSummary?.missingRequiredDelegation) {
        return { state: "required_delegation_missing", task, debug, pendingApprovals, child: null };
      }
      const activeChild = task?.delegationSummary?.activeChildTask ?? null;
      const recentChild = activeChild ? null : (task?.delegationSummary?.recentChildren?.[0] ?? null);
      if (activeChild || recentChild) {
        return { state: activeChild ? "delegation_active" : "delegation_recent", task, debug, pendingApprovals, child: activeChild ?? recentChild };
      }
      const artifactPaths = task?.latestVisibleOutput?.artifactPaths ?? [];
      if (task?.runtime?.lifecycleStatus === "RUNNING" && artifactPaths.length > 0 && debug?.executionSummary?.artifactPathState === "sandbox_only") {
        return { state: "artifact_ready_without_delegation", task, debug, pendingApprovals, child: null };
      }
      if (debug?.executionSummary?.artifactPathState === "unresolved") {
        return { state: "artifact_unresolved_without_delegation", task, debug, pendingApprovals, child: null };
      }
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
        return { state: "terminal", task, debug, pendingApprovals, child: null };
      }
      return false;
    }, { timeoutMs: 360000 });
  }

  scenarioNotes.delegationRecoveryAttempts = delegationRecoveryAttempts;

  if (delegationState.state === "required_delegation_missing") {
    scenarioNotes.noDelegationDetected = true;
    scenarioNotes.noDelegationReason = "provider_skipped_required_delegation";
    await openTask(page, taskId);
    await setContextVisibility(page, false);
    scenarioChecklist.requiredDelegationMissing = await collectChecklist(page, {
      expectToolActivity: false,
    });
    const missingDelegationScreenshot = await captureScreenshot(page, "delegated-subtask-required-delegation-missing");
    scenarioScreenshots.push(missingDelegationScreenshot);
    return buildScenarioRecord({
      status: "provider_skipped_required_delegation",
      taskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: scenarioNotes,
      error: "Live provider skipped delegate_subtask even though this thread explicitly required a delegated child task before parent delivery.",
    });
  }

  if (delegationState.state === "artifact_ready_without_delegation") {
    scenarioNotes.noDelegationDetected = true;
    scenarioNotes.noDelegationReason = "provider_skipped_delegation_and_stayed_sandbox_only";
    await openTask(page, taskId);
    await setContextVisibility(page, false);
    scenarioChecklist.sandboxOnlyWithoutDelegation = await collectChecklist(page, {
      expectToolActivity: true,
    });
    const sandboxOnlyScreenshot = await captureScreenshot(page, "delegated-subtask-no-delegation-sandbox-only");
    scenarioScreenshots.push(sandboxOnlyScreenshot);
    return buildScenarioRecord({
      status: "provider_skipped_required_delegation",
      taskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: scenarioNotes,
      error: "Live provider created a parent-owned sandbox artifact but never surfaced delegation or destination selection.",
    });
  }

  if (delegationState.state === "artifact_unresolved_without_delegation") {
    scenarioNotes.noDelegationDetected = true;
    scenarioNotes.noDelegationReason = "provider_skipped_delegation_and_reached_artifact_routing";
    const unresolvedTask = delegationState.task;
    const unresolvedDebug = delegationState.debug;
    await openTask(page, taskId);
    await setContextVisibility(page, true);
    await page.waitForSelector('[data-testid="task-action-use-recommended-path"]', { timeout: 30000 });
    scenarioChecklist.unresolvedWithoutDelegation = await collectChecklist(page, {
      expectRecommendedPath: true,
      expectToolActivity: true,
    });
    const unresolvedWithoutDelegationScreenshot = await captureScreenshot(page, "delegated-subtask-no-delegation-unresolved");
    scenarioScreenshots.push(unresolvedWithoutDelegationScreenshot);

    await page.locator('[data-testid="task-action-use-recommended-path"]').click();
    await waitFor(taskId, ({ debug }) => debug?.executionSummary?.artifactPathState === "applied", { timeoutMs: 120000 });

    let postApplyState = await waitFor(taskId, ({ task, debug }) => {
      const pendingApprovals = task.pendingApprovals ?? [];
      if (pendingApprovals.length > 0) {
        return { state: "approval_pending", task, debug, pendingApprovals };
      }
      if (task?.delegationSummary?.activeChildTask || task?.delegationSummary?.recentChildren?.length) {
        return { state: "delegation_visible", task, debug, pendingApprovals };
      }
      if (task?.runtime?.lifecycleStatus === "RUNNING" && debug?.executionSummary?.artifactPathState === "applied") {
        return { state: "applied_waiting", task, debug, pendingApprovals };
      }
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
        return { state: "terminal", task, debug, pendingApprovals };
      }
      return false;
    }, { timeoutMs: 300000 });

    let postApplyContinueAttempts = 0;
    while (postApplyState.state === "approval_pending" || postApplyState.state === "applied_waiting") {
      if (postApplyState.state === "approval_pending") {
        await resolveAllPendingApprovals(taskId, postApplyState.pendingApprovals, "Approved during delegation live review after default-path apply.");
      } else {
        if (postApplyContinueAttempts >= 2) {
          return buildScenarioRecord({
            status: "provider_skipped_required_delegation",
            taskId,
            title,
            task: postApplyState.task,
            debug: postApplyState.debug,
            unresolvedDebug,
            screenshots: scenarioScreenshots,
            checklist: scenarioChecklist,
            notes: {
              ...scenarioNotes,
              noDelegationDetected: true,
              noDelegationReason: "provider_skipped_delegation_and_remained_applied_waiting",
              postApplyContinueAttempts,
            },
            error: "Live provider applied the parent-owned delivery path but never surfaced delegation and never finalized the parent thread.",
          });
        }
        postApplyContinueAttempts += 1;
        await continueTask(
          taskId,
          `The recommended destination has already been applied. Confirm the parent-owned delivery for ${parentArtifactPath} and finish this parent thread without creating extra child tasks.`,
        );
      }
      postApplyState = await waitFor(taskId, ({ task, debug }) => {
        const pendingApprovals = task.pendingApprovals ?? [];
        if (pendingApprovals.length > 0) {
          return { state: "approval_pending", task, debug, pendingApprovals };
        }
        if (task?.delegationSummary?.activeChildTask || task?.delegationSummary?.recentChildren?.length) {
          return { state: "delegation_visible", task, debug, pendingApprovals };
        }
        if (task?.runtime?.lifecycleStatus === "RUNNING" && debug?.executionSummary?.artifactPathState === "applied") {
          return { state: "applied_waiting", task, debug, pendingApprovals };
        }
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
          return { state: "terminal", task, debug, pendingApprovals };
        }
        return false;
      }, { timeoutMs: 300000 });
    }

    if (postApplyState.state === "delegation_visible") {
      delegationState = {
        state: postApplyState.task?.delegationSummary?.activeChildTask ? "delegation_active" : "delegation_recent",
        task: postApplyState.task,
        debug: postApplyState.debug,
        pendingApprovals: [],
        child: postApplyState.task?.delegationSummary?.activeChildTask ?? postApplyState.task?.delegationSummary?.recentChildren?.[0] ?? null,
      };
    } else {
      if (postApplyState.task.runtime?.lifecycleStatus !== "COMPLETED") {
        await continueTask(
          taskId,
          `The recommended destination has already been applied. Confirm the parent-owned delivery for ${parentArtifactPath} and finish without creating extra child tasks.`,
        );
        postApplyState = await waitFor(taskId, ({ task, debug }) => {
          const pendingApprovals = task.pendingApprovals ?? [];
          if (pendingApprovals.length > 0) {
            return { state: "approval_pending", task, debug, pendingApprovals };
          }
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
            return { state: "terminal", task, debug, pendingApprovals };
          }
          return false;
        }, { timeoutMs: 300000 });
        while (postApplyState.state === "approval_pending") {
          await resolveAllPendingApprovals(taskId, postApplyState.pendingApprovals, "Approved during delegation live review after no-delegation continue.");
          postApplyState = await waitFor(taskId, ({ task, debug }) => {
            const pendingApprovals = task.pendingApprovals ?? [];
            if (pendingApprovals.length > 0) {
              return { state: "approval_pending", task, debug, pendingApprovals };
            }
            if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
              return { state: "terminal", task, debug, pendingApprovals };
            }
            return false;
          }, { timeoutMs: 300000 });
        }
      }

      const finalTask = postApplyState.task;
      const finalDebug = postApplyState.debug;
      await openTask(page, taskId);
      await setContextVisibility(page, false);
      if (await ensureVisible(page, '[data-testid="task-result-card"]')) {
        scenarioChecklist.completedWithoutDelegation = await collectChecklist(page, {
          expectResultCard: true,
          expectDestination: true,
          expectToolActivity: true,
        });
        const completedWithoutDelegationScreenshot = await captureScreenshot(page, "delegated-subtask-no-delegation-completed");
        scenarioScreenshots.push(completedWithoutDelegationScreenshot);
      }

      const visibleDelegationActivities = Array.isArray(finalTask?.visibleToolActivities)
        ? finalTask.visibleToolActivities.filter((activity) => isDelegationActivity(activity))
        : [];
      scenarioNotes.visibleDelegationActivityCount = visibleDelegationActivities.length;
      scenarioNotes.delegationActivity = visibleDelegationActivities[0] ?? null;
      scenarioNotes.recentChildCount = finalTask?.delegationSummary?.recentChildren?.length ?? 0;

      return buildScenarioRecord({
        status: "provider_skipped_required_delegation",
        taskId,
        title,
        task: finalTask,
        debug: finalDebug,
        unresolvedDebug,
        screenshots: scenarioScreenshots,
        checklist: scenarioChecklist,
        notes: scenarioNotes,
        error: "Live provider completed the parent-owned artifact flow without surfacing the required delegated child task.",
      });
    }
  }

  if (!(delegationState.state === "delegation_active" || delegationState.state === "delegation_recent")) {
    return buildScenarioRecord({
      status: "provider_skipped_required_delegation",
      taskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: {
        ...scenarioNotes,
        noDelegationDetected: true,
        noDelegationReason: `delegation_never_visible:${delegationState.state}`,
      },
      error: `Expected delegated child visibility before terminal completion, received ${delegationState.state}.`,
    });
  }

  const childTaskId = delegationState.child?.taskId ?? null;
  assertCondition(childTaskId, "Delegation review did not expose a child task id.");
  const childTask = await api(`/tasks/${childTaskId}`);
  if (childTask.delegationSummary?.canDelegate !== false) {
    return buildScenarioRecord({
      status: "boundary_violation",
      taskId,
      childTaskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: {
        ...scenarioNotes,
        childLifecycleStatus: childTask.runtime?.lifecycleStatus ?? null,
        childCanDelegate: childTask.delegationSummary?.canDelegate ?? null,
        childDelegationReason: childTask.delegationSummary?.reason ?? null,
      },
      error: "Delegated child task unexpectedly reported delegation available, which would allow nested SubSccAgent fan-out.",
    });
  }
  if (!/cannot delegate again/i.test(childTask.delegationSummary?.reason ?? "")) {
    return buildScenarioRecord({
      status: "boundary_violation",
      taskId,
      childTaskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: {
        ...scenarioNotes,
        childLifecycleStatus: childTask.runtime?.lifecycleStatus ?? null,
        childCanDelegate: childTask.delegationSummary?.canDelegate ?? null,
        childDelegationReason: childTask.delegationSummary?.reason ?? null,
      },
      error: "Delegated child task did not expose the required no-nested-delegation guardrail.",
    });
  }
  const topLevelTasks = await api("/tasks");
  if (!(Array.isArray(topLevelTasks) && !topLevelTasks.some((task) => task.taskId === childTaskId))) {
    return buildScenarioRecord({
      status: "boundary_violation",
      taskId,
      childTaskId,
      title,
      task: delegationState.task,
      debug: delegationState.debug,
      screenshots: scenarioScreenshots,
      checklist: scenarioChecklist,
      notes: {
        ...scenarioNotes,
        childLifecycleStatus: childTask.runtime?.lifecycleStatus ?? null,
        childCanDelegate: childTask.delegationSummary?.canDelegate ?? null,
        childDelegationReason: childTask.delegationSummary?.reason ?? null,
        topLevelChildHidden: false,
        topLevelChildHiddenCheckRan: true,
      },
      error: "Delegated child task leaked into the top-level task list instead of staying hidden inside the parent thread.",
    });
  }
  scenarioNotes.childLifecycleStatus = childTask.runtime?.lifecycleStatus ?? null;
  scenarioNotes.childCanDelegate = childTask.delegationSummary?.canDelegate ?? null;
  scenarioNotes.childDelegationReason = childTask.delegationSummary?.reason ?? null;
  scenarioNotes.topLevelChildHidden = true;
  scenarioNotes.topLevelChildHiddenCheckRan = true;

  await openTask(page, taskId);
  await setContextVisibility(page, false);
  await page.waitForSelector('[data-testid="task-delegation-card"]', { timeout: 30000 });
  await ensureVisible(page, '[data-testid="task-delegation-card"]');
  const delegationScreenshot = await captureScreenshot(page, "delegated-subtask-visible");
  scenarioScreenshots.push(delegationScreenshot);
  const delegationChecklist = await collectChecklist(page, { expectDelegationCard: true, expectToolActivity: true });
  scenarioChecklist.delegation = delegationChecklist;

  let artifactState = await waitFor(taskId, ({ task, debug }) => {
    const pendingApprovals = task.pendingApprovals ?? [];
    if (pendingApprovals.length > 0) {
      return { state: "approval_pending", task, debug, pendingApprovals };
    }
    if (debug?.executionSummary?.artifactPathState === "unresolved") {
      return { state: "artifact_unresolved", task, debug, pendingApprovals };
    }
    const artifactPaths = task?.latestVisibleOutput?.artifactPaths ?? [];
    if (task?.runtime?.lifecycleStatus === "RUNNING" && artifactPaths.length > 0 && debug?.executionSummary?.artifactPathState === "sandbox_only") {
      return { state: "artifact_ready_waiting", task, debug, pendingApprovals };
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
      return { state: "terminal", task, debug, pendingApprovals };
    }
    return false;
  }, { timeoutMs: 360000 });

  let artifactRecoveryAttempts = 0;
  while (
    artifactState.state === "approval_pending"
    || artifactState.state === "artifact_ready_waiting"
    || artifactState.state === "terminal"
  ) {
    if (artifactState.state === "approval_pending") {
      await resolveAllPendingApprovals(taskId, artifactState.pendingApprovals, "Approved during delegation delivery review.");
    } else if (artifactState.state === "artifact_ready_waiting") {
      assertCondition(
        scenarioNotes.continueNudges.length < 3,
        "Delegated parent task stayed in artifact_ready_waiting after repeated continue nudges.",
      );
      await continueTask(
        taskId,
        `The delegated child has already returned. Use the child result to write ${parentArtifactPath} in the parent workspace, then wait for the operator-selected destination.`,
      );
      scenarioNotes.continueNudges.push({
        artifactPaths: artifactState.task?.latestVisibleOutput?.artifactPaths ?? [],
        issueSummary: artifactState.debug?.executionSummary?.issueSummary ?? null,
      });
    } else {
      assertCondition(
        artifactRecoveryAttempts < 2,
        `Expected unresolved artifact selection after delegation, received ${artifactState.state}.`,
      );
      artifactRecoveryAttempts += 1;
      await continueTask(
        taskId,
        `The thread still needs a parent-owned artifact delivery. Use the delegated child result to create ${parentArtifactPath} in the parent workspace, then wait for the operator-selected destination before finishing.`,
      );
    }
    artifactState = await waitFor(taskId, ({ task, debug }) => {
      const pendingApprovals = task.pendingApprovals ?? [];
      if (pendingApprovals.length > 0) {
        return { state: "approval_pending", task, debug, pendingApprovals };
      }
      if (debug?.executionSummary?.artifactPathState === "unresolved") {
        return { state: "artifact_unresolved", task, debug, pendingApprovals };
      }
      const artifactPaths = task?.latestVisibleOutput?.artifactPaths ?? [];
      if (task?.runtime?.lifecycleStatus === "RUNNING" && artifactPaths.length > 0 && debug?.executionSummary?.artifactPathState === "sandbox_only") {
        return { state: "artifact_ready_waiting", task, debug, pendingApprovals };
      }
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
        return { state: "terminal", task, debug, pendingApprovals };
      }
      return false;
    }, { timeoutMs: 360000 });
  }
  scenarioNotes.artifactRecoveryAttempts = artifactRecoveryAttempts;

  assertCondition(artifactState.state === "artifact_unresolved", `Expected unresolved artifact selection after delegation, received ${artifactState.state}.`);
  const unresolvedTask = artifactState.task;
  const unresolvedDebug = artifactState.debug;

  await openTask(page, taskId);
  await setContextVisibility(page, true);
  await page.waitForSelector('[data-testid="task-action-use-recommended-path"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="task-delegation-card"]', { timeout: 30000 });
  await ensureVisible(page, '[data-testid="task-delegation-card"]');
  const unresolvedScreenshot = await captureScreenshot(page, "delegated-subtask-unresolved");
  scenarioScreenshots.push(unresolvedScreenshot);
  const unresolvedChecklist = await collectChecklist(page, {
    expectDelegationCard: true,
    expectToolActivity: true,
    expectRecommendedPath: true,
  });
  scenarioChecklist.unresolved = unresolvedChecklist;

  await page.locator('[data-testid="task-action-use-recommended-path"]').click();
  const appliedDebug = await waitFor(taskId, ({ debug }) => debug?.executionSummary?.artifactPathState === "applied", { timeoutMs: 120000 });

  let finalState = await waitFor(taskId, ({ task, debug }) => {
    const pendingApprovals = task.pendingApprovals ?? [];
    if (pendingApprovals.length > 0) {
      return { state: "approval_pending", task, debug, pendingApprovals };
    }
    if (task?.runtime?.lifecycleStatus === "RUNNING" && debug?.executionSummary?.artifactPathState === "applied") {
      return { state: "applied_waiting", task, debug, pendingApprovals };
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
      return { state: "terminal", task, debug, pendingApprovals };
    }
    return false;
  }, { timeoutMs: 300000 });

  let appliedContinueAttempts = 0;
  while (finalState.state === "approval_pending" || finalState.state === "applied_waiting") {
    if (finalState.state === "approval_pending") {
      await resolveAllPendingApprovals(taskId, finalState.pendingApprovals, "Approved during delegation live review after artifact apply.");
    } else {
      assertCondition(
        appliedContinueAttempts < 2,
        "Delegated parent task stayed in applied_waiting after repeated completion nudges.",
      );
      appliedContinueAttempts += 1;
      await continueTask(
        taskId,
        `The recommended destination has already been applied. Confirm the final delivery for ${parentArtifactPath} in this parent thread and finish without creating extra child tasks.`,
      );
    }
    finalState = await waitFor(taskId, ({ task, debug }) => {
      const pendingApprovals = task.pendingApprovals ?? [];
      if (pendingApprovals.length > 0) {
        return { state: "approval_pending", task, debug, pendingApprovals };
      }
      if (task?.runtime?.lifecycleStatus === "RUNNING" && debug?.executionSummary?.artifactPathState === "applied") {
        return { state: "applied_waiting", task, debug, pendingApprovals };
      }
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(task?.runtime?.lifecycleStatus)) {
        return { state: "terminal", task, debug, pendingApprovals };
      }
      return false;
    }, { timeoutMs: 300000 });
  }

  const task = finalState.task;
  const debug = finalState.debug;
  const destinationPaths = debug?.executionSummary?.artifactDestinationPaths ?? [];
  assertCondition(task.runtime?.lifecycleStatus === "COMPLETED", `Delegated parent task did not complete. Lifecycle=${task.runtime?.lifecycleStatus ?? "missing"}`);
  assertCondition(destinationPaths.length > 0, "Delegated parent task completed without final destination paths.");
  assertCondition(
    appliedDebug.debug?.executionSummary?.selectedArtifactDir === unresolvedDebug.executionSummary?.recommendedArtifactDir
      || appliedDebug.task?.completionSummary?.artifactDestinationDir,
    "Delegated parent did not retain the selected destination after apply.",
  );

  await openTask(page, taskId);
  await setContextVisibility(page, false);
  await page.waitForSelector('[data-testid="task-result-card"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="task-result-destination-section"]', { timeout: 30000 });
  await ensureVisible(page, '[data-testid="task-result-card"]');
  const completedScreenshot = await captureScreenshot(page, "delegated-subtask-completed");
  scenarioScreenshots.push(completedScreenshot);
  await setContextVisibility(page, true);
  const contextScreenshot = await captureScreenshot(page, "delegated-subtask-context");
  scenarioScreenshots.push(contextScreenshot);
  const completedChecklist = await collectChecklist(page, {
    expectDelegationCard: true,
    expectResultCard: true,
    expectDestination: true,
    expectContextDestination: true,
    expectToolActivity: true,
  });
  scenarioChecklist.completed = completedChecklist;

  const delegationActivity = Array.isArray(task.visibleToolActivities)
    ? task.visibleToolActivities.find((activity) => isDelegationActivity(activity))
    : null;
  scenarioNotes.recentChildCount = task.delegationSummary?.recentChildren?.length ?? 0;
  scenarioNotes.delegationActivity = delegationActivity;
  scenarioNotes.visibleDelegationActivityCount = delegationActivity ? 1 : 0;

  const passed =
    delegationChecklist.passes
    && unresolvedChecklist.passes
    && completedChecklist.passes
    && task.runtime?.lifecycleStatus === "COMPLETED"
    && destinationPaths.length > 0
    && Boolean(task.delegationSummary?.recentChildren?.length)
    && Boolean(delegationActivity);

  return buildScenarioRecord({
    status: passed ? "achieved" : "boundary_violation",
    taskId,
    childTaskId,
    title,
    task,
    debug,
    unresolvedDebug,
    screenshots: scenarioScreenshots,
    checklist: scenarioChecklist,
    notes: scenarioNotes,
    error: passed ? null : "Delegated parent task did not surface a complete child-to-parent delivery chain.",
  });
}

async function main() {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable was not found. Set CHROME_EXECUTABLE to run frontend delegation live review.");
  }
  if (!LIVE_PROVIDER_ENABLED || !PROVIDER_ID) {
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: "external_blocker",
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
      reason: "Live provider api key env is missing.",
      scenarios: [],
      screenshots: [],
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const configState = await ensureDelegationReviewConfig();
  if (
    configState?.current?.runtime?.delegation?.enabled !== true
    || configState?.current?.tools?.permissionMode !== "full"
  ) {
    const report = buildConfigNotEnabledReport(
      `Delegation live review could not reach the required config state. Current runtime=${JSON.stringify(configState?.current?.runtime?.delegation ?? null)} tools=${JSON.stringify(configState?.current?.tools ?? null)}`,
      {
        runtime: configState?.current?.runtime?.delegation ?? null,
        tools: configState?.current?.tools ?? null,
      },
    );
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  const scenarios = [];
  const screenshots = [];
  let page = null;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const providerSetup = await ensureLiveProviderSecret();
    await openTask(page, "none");
    const scenario = await runDelegationScenario(page);
    scenario.notes = { ...scenario.notes, providerSetup };
    scenarios.push(scenario);
    screenshots.push(...scenario.screenshots);
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: deriveReviewStatus(scenarios),
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
        failureScreenshot = await captureScreenshot(page, "delegation-live-review-failure");
      } catch {}
    }
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      backendUrl: BACKEND_URL,
      providerId: PROVIDER_ID,
      status: classifyUnexpectedFailure(error),
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
