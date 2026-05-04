import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanHistoricalTestArtifacts } from './clean-test-artifacts.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';

const rootDir = process.cwd();
const scorecardProfile = process.env.SCORECARD_PROFILE?.trim() || 'default';
const reportFileName = scorecardProfile === 'default'
  ? 'release-scorecard.json'
  : `release-scorecard.${scorecardProfile}.json`;
const reportPath = path.resolve(rootDir, '.codex-run', 'logs', reportFileName);
const publicCapabilityParityReportFileName = scorecardProfile === 'default'
  ? 'public-capability-parity.json'
  : `public-capability-parity.${scorecardProfile}.json`;
const publicCapabilityParityReportPath = path.resolve(rootDir, '.codex-run', 'logs', publicCapabilityParityReportFileName);
const manualArtifactAuditReportFileName = scorecardProfile === 'default'
  ? 'manual-artifact-audit.json'
  : `manual-artifact-audit.${scorecardProfile}.json`;
const manualArtifactAuditReportPath = path.resolve(rootDir, '.codex-run', 'logs', manualArtifactAuditReportFileName);
const practicalTaskAcceptanceReportFileName = scorecardProfile === 'default'
  ? 'practical-task-acceptance.json'
  : `practical-task-acceptance.${scorecardProfile}.json`;
const practicalTaskAcceptanceReportPath = path.resolve(rootDir, '.codex-run', 'logs', practicalTaskAcceptanceReportFileName);
const practicalManualAuditReportFileName = scorecardProfile === 'default'
  ? 'practical-manual-audit.json'
  : `practical-manual-audit.${scorecardProfile}.json`;
const practicalManualAuditReportPath = path.resolve(rootDir, '.codex-run', 'logs', practicalManualAuditReportFileName);
const practicalLiveTaskAcceptanceReportFileName = scorecardProfile === 'default'
  ? 'practical-live-task-acceptance.json'
  : `practical-live-task-acceptance.${scorecardProfile}.json`;
const practicalLiveTaskAcceptanceReportPath = path.resolve(rootDir, '.codex-run', 'logs', practicalLiveTaskAcceptanceReportFileName);
const practicalLiveManualAuditReportFileName = scorecardProfile === 'default'
  ? 'practical-live-manual-audit.json'
  : `practical-live-manual-audit.${scorecardProfile}.json`;
const practicalLiveManualAuditReportPath = path.resolve(rootDir, '.codex-run', 'logs', practicalLiveManualAuditReportFileName);
const liveProviderReportFileName = scorecardProfile === 'default'
  ? 'live-provider-scenarios.json'
  : `live-provider-scenarios.${scorecardProfile}.json`;
const liveProviderReportPath = path.resolve(rootDir, '.codex-run', 'logs', liveProviderReportFileName);
const benchmarkReportFileName = scorecardProfile === 'default'
  ? 'benchmark.json'
  : `benchmark.${scorecardProfile}.json`;
const benchmarkReportPath = path.resolve(rootDir, '.codex-run', 'logs', benchmarkReportFileName);
const ecommerceDeliveryReportFileName = scorecardProfile === 'default'
  ? 'ecommerce-delivery.json'
  : `ecommerce-delivery.${scorecardProfile}.json`;
const ecommerceDeliveryReportPath = path.resolve(rootDir, '.codex-run', 'logs', ecommerceDeliveryReportFileName);
const ecommerceReadinessReportFileName = scorecardProfile === 'default'
  ? 'ecommerce-readiness.json'
  : `ecommerce-readiness.${scorecardProfile}.json`;
const ecommerceReadinessReportPath = path.resolve(rootDir, '.codex-run', 'logs', ecommerceReadinessReportFileName);
const frontendSmokeReportPath = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-smoke-report.json');
const frontendE2EReportPath = path.resolve(rootDir, '.codex-run', 'logs', 'frontend-e2e-report.json');
const cliInteractionTranscriptReportFileName = scorecardProfile === 'default'
  ? 'cli-interaction-transcript.json'
  : `cli-interaction-transcript.${scorecardProfile}.json`;
const cliInteractionTranscriptReportPath = path.resolve(rootDir, '.codex-run', 'logs', cliInteractionTranscriptReportFileName);
const runtimeStressValidationReportFileName = scorecardProfile === 'default'
  ? 'runtime-stress-validation.json'
  : `runtime-stress-validation.${scorecardProfile}.json`;
const runtimeStressValidationReportPath = path.resolve(rootDir, '.codex-run', 'logs', runtimeStressValidationReportFileName);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? 'http://127.0.0.1:5273';
const windowsNodeDir = process.platform === 'win32' ? path.dirname(process.execPath) : null;
const preferredWindowsNpm = windowsNodeDir ? path.join(windowsNodeDir, 'npm.cmd') : null;
const scorecardStartedAt = Date.now();
const scorecardForceRerun = /^(1|true|yes|on)$/i.test(process.env.SCORECARD_FORCE_RERUN ?? '');
const reusableLiveReportMaxAgeMs = 12 * 60 * 60 * 1000;

function runCommand(label, command, args, options = {}) {
  const isWindowsNpm = process.platform === 'win32' && command === 'npm';
  const executable = isWindowsNpm && preferredWindowsNpm ? preferredWindowsNpm : command;
  const finalResult = isWindowsNpm
    ? spawnSync('powershell.exe', ['-Command', `& '${executable.replace(/'/g, "''")}' ${args.map((value) => `'${value.replace(/'/g, "''")}'`).join(' ')}`], {
      cwd: options.cwd ?? rootDir,
      encoding: 'utf8',
      shell: false,
      env: options.env ?? process.env,
      maxBuffer: 16 * 1024 * 1024
    })
    : spawnSync(executable, args, {
      cwd: options.cwd ?? rootDir,
      encoding: 'utf8',
      shell: false,
      env: options.env ?? process.env,
      maxBuffer: 16 * 1024 * 1024
    });
  return {
    label,
    command: [executable, ...args].join(' '),
    status: finalResult.status ?? (finalResult.error ? 1 : 1),
    stdout: finalResult.stdout ?? '',
    stderr: finalResult.stderr ?? ''
  };
}

function createNeutralScorecardEnv(sourceEnv = process.env) {
  const nextEnv = { ...sourceEnv };
  delete nextEnv.SCORECARD_PROFILE;
  nextEnv.BACKEND_NEW_LIVE_PROVIDER_ENABLED = '0';
  return nextEnv;
}

function parseFirstJsonBlock(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('No JSON payload found in command output.');
  }

  const extractBalancedJson = (source, start) => {
    const opener = source[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) {
        depth += 1;
        continue;
      }
      if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
    return null;
  };

  for (let start = 0; start < trimmed.length; start += 1) {
    const char = trimmed[start];
    if (char !== '{' && char !== '[') {
      continue;
    }
    const candidate = extractBalancedJson(trimmed, start);
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return JSON.parse(trimmed);
}

function parseCommandPayload(result, options = {}) {
  const label = options.label ?? result.label;
  const nestedKey = options.nestedKey ?? null;
  const validator = options.validator ?? (() => true);
  const issues = [];

  if ((result.stdout ?? '').trim().length === 0) {
    issues.push(`${label}: empty stdout`);
    return { payload: null, issues };
  }

  let payload = null;
  try {
    payload = parseFirstJsonBlock(result.stdout);
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return { payload: null, issues };
  }

  const normalized = nestedKey && payload && typeof payload === 'object'
    ? payload[nestedKey]
    : payload;

  if (!normalized || typeof normalized !== 'object') {
    issues.push(`${label}: parsed payload missing expected object${nestedKey ? ` at key "${nestedKey}"` : ''}`);
    return { payload: null, issues };
  }

  if (!validator(normalized, payload)) {
    issues.push(`${label}: parsed payload shape mismatch`);
    return { payload: null, issues };
  }

  return { payload: normalized, issues };
}

async function parseReportFile(reportPath, options = {}) {
  const label = options.label ?? path.basename(reportPath);
  const validator = options.validator ?? (() => true);
  const issues = [];

  let stats;
  try {
    stats = await fs.stat(reportPath);
  } catch {
    issues.push(`${label}: reusable report missing at ${reportPath}`);
    return { payload: null, issues, reportIsFresh: false };
  }

  const reportIsFresh = (Date.now() - stats.mtimeMs) <= reusableLiveReportMaxAgeMs;
  if (!reportIsFresh) {
    issues.push(`${label}: reusable report is stale at ${reportPath}`);
  }

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (error) {
    issues.push(`${label}: failed to read reusable report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { payload: null, issues, reportIsFresh };
  }

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    issues.push(`${label}: report_contract_drift at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { payload: null, issues, reportIsFresh };
  }

  if (!validator(payload)) {
    issues.push(`${label}: report_contract_drift at ${reportPath}`);
    return { payload: null, issues, reportIsFresh };
  }

  return {
    payload: reportIsFresh ? payload : null,
    issues,
    reportIsFresh
  };
}

async function loadSuiteFromCommandOrReport(params) {
  if (params.forceRerun !== true && params.reportPath) {
    const reportParse = await parseReportFile(params.reportPath, {
      label: params.label,
      validator: params.validator
    });
    const payload = reportParse.payload;
    if (payload || params.runCommandWhenReportUnavailable !== true) {
      return {
        command: {
          label: params.label,
          command: `reuse-report ${params.reportPath}`,
          status: payload ? 0 : 1,
          stdout: payload ? JSON.stringify(payload, null, 2) : '',
          stderr: reportParse.issues.join('; ')
        },
        parse: {
          payload,
          issues: reportParse.issues
        },
        source: 'report'
      };
    }
  }

  const command = runCommand(params.label, params.command, params.args, params.options);
  return {
    command,
    parse: parseCommandPayload(command, {
      label: params.label,
      nestedKey: params.nestedKey,
      validator: params.validator
    }),
    source: 'command'
  };
}

function getSuitePassedCount(report) {
  return typeof report?.totals?.passed === 'number'
    ? report.totals.passed
    : Array.isArray(report?.scenarios)
    ? report.scenarios.filter((scenario) => scenario?.passed).length
    : 0;
}

function getSuiteTotalCount(report) {
  if (typeof report?.totals?.total === 'number') {
    return report.totals.total;
  }
  if (typeof report?.totals?.passed === 'number' && typeof report?.totals?.failed === 'number') {
    return report.totals.passed + report.totals.failed;
  }
  return Array.isArray(report?.scenarios) ? report.scenarios.length : 0;
}

function isAchievedSuiteReport(report) {
  if (!report || typeof report !== 'object') {
    return false;
  }
  const passed = getSuitePassedCount(report);
  const total = getSuiteTotalCount(report);
  return report.status === 'achieved'
    && total > 0
    && passed === total;
}

function shouldRetrySuiteParse(parseResult) {
  return !parseResult.payload || !isAchievedSuiteReport(parseResult.payload);
}

function isBetterSuiteParse(candidate, baseline) {
  if (candidate.payload && !baseline.payload) {
    return true;
  }
  if (!candidate.payload) {
    return false;
  }
  if (!baseline.payload) {
    return true;
  }
  if (isAchievedSuiteReport(candidate.payload) && !isAchievedSuiteReport(baseline.payload)) {
    return true;
  }
  const candidatePassed = getSuitePassedCount(candidate.payload);
  const baselinePassed = getSuitePassedCount(baseline.payload);
  if (candidatePassed !== baselinePassed) {
    return candidatePassed > baselinePassed;
  }
  const candidateTotal = getSuiteTotalCount(candidate.payload);
  const baselineTotal = getSuiteTotalCount(baseline.payload);
  return candidateTotal > baselineTotal;
}

function unwrapScenarioResult(payload, key) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  if (payload[key] && typeof payload[key] === 'object') {
    return payload[key];
  }
  return payload;
}

function formatPassRate(result) {
  const totals = result?.totals ?? {};
  const passed = totals.passed ?? result?.scenarios?.filter((scenario) => scenario.passed).length ?? 0;
  const total =
    totals.total ??
    (typeof totals.passed === 'number' && typeof totals.failed === 'number'
      ? totals.passed + totals.failed
      : result?.scenarios?.length ?? 0);
  return `${passed}/${total}`;
}

function summarizeAreaGroupStatus(entries) {
  if (entries.every((entry) => entry.status === 'achieved')) {
    return 'achieved';
  }
  if (entries.some((entry) => entry.status === 'open_gap')) {
    return 'open_gap';
  }
  if (entries.some((entry) => entry.status === 'external_blocker')) {
    return 'external_blocker';
  }
  return 'open_gap';
}

function summarizeWorkspaceWorkflow(generalComplex, backendTestsOk) {
  const requiredFamilies = [
    'workspace-bootstrap',
    'workspace-docs-import',
    'workspace-command-driven-task',
    'decision-doc-from-imported-sources'
  ];
  const byFamily = generalComplex?.totals?.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (!backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so workspace workflow coverage is not trusted',
      byFamily
    };
  }
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing workspace workflow families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizeInteractionConsistency(params) {
  const backendTestsOk = params.backendTestsOk;
  const frontendSmokeOk = params.frontendSmokeOk;
  const workflowOk = params.workflowPassRate === '5/5';
  const breadthOk = params.breadthPassRate === '10/10';
  if (!backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend interaction regressions are not green'
    };
  }
  if (!frontendSmokeOk) {
    return {
      status: 'open_gap',
      detail: 'frontend smoke is not green, so cross-surface interaction parity is not trusted'
    };
  }
  if (!workflowOk || !breadthOk) {
    return {
      status: 'open_gap',
      detail: 'workflow or breadth scenarios regressed, so shared interaction summaries are not trusted'
    };
  }
  return {
    status: 'achieved',
    detail: 'web, human CLI, and agent CLI summary flows are covered by backend regressions and frontend smoke'
  };
}

function summarizeCliWebInteraction(params) {
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend CLI interaction regressions are not green'
    };
  }
  if (!params.frontendSmokeOk) {
    return {
      status: 'open_gap',
      detail: 'frontend smoke is not green, so operator rails are not trusted'
    };
  }
  if (!params.frontendSmokeReport || params.frontendSmokeReport.passes !== true) {
    return {
      status: 'open_gap',
      detail: 'frontend smoke report is missing or malformed'
    };
  }
  const runs = Array.isArray(params.frontendSmokeReport.runs) ? params.frontendSmokeReport.runs : [];
  const actualRuns = runs.flatMap((run) => (
    Array.isArray(run?.actualRuns)
      ? run.actualRuns.map((actualRun) => ({
        ...actualRun,
        viewport: run.viewport ?? actualRun?.viewport ?? null
      }))
      : [run]
  ));
  const taskRuns = actualRuns.filter((run) => run?.page === 'tasks' && run?.state === 'actual');
  if (taskRuns.length === 0) {
    return {
      status: 'open_gap',
      detail: 'frontend smoke report does not include the actual tasks route'
    };
  }
  const inspectorGap = taskRuns.find((run) => (
    run?.routes?.tasksInspector?.checked !== true
    && run?.extras?.inspector?.checked !== true
  ));
  const capabilityWorkspaceVisited = actualRuns.some((run) => (
    run?.routes?.settingsCapabilities?.ok === true
    || (run?.page === 'settings-capabilities' && run?.functionalChecks?.passes === true)
  ));
  if (inspectorGap) {
    return {
      status: 'open_gap',
      detail: `task inspector populated-state validation did not pass for ${inspectorGap.viewport?.name ?? inspectorGap.viewport ?? 'unknown viewport'}`
    };
  }
  if (!capabilityWorkspaceVisited) {
    return {
      status: 'open_gap',
      detail: 'settings capability workspace was not exercised by frontend smoke'
    };
  }
  if (params.interactionConsistency.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'cross-surface interaction consistency is not green'
    };
  }
  return {
    status: 'achieved',
    detail: 'CLI summary-first commands and populated web operator rails are verified across responsive smoke and backend interaction regressions'
  };
}

function summarizeInteractionE2E(params) {
  const legacyRequiredScenarios = [
    'web-pause-resume-complete',
    'web-approval-approved',
    'web-approval-rejected',
    'web-artifact-routing-apply'
  ];
  const liveRequiredScenarios = [
    'live-clarification-led-task',
    'live-artifact-delivery-task'
  ];
  if (params.commandStatus !== 0) {
    return {
      status: 'open_gap',
      detail: 'frontend E2E command did not complete successfully in this scorecard run'
    };
  }
  if (!params.report) {
    return {
      status: 'open_gap',
      detail: params.commandStatus === 0
        ? `frontend E2E command passed but report path/output contract drifted at ${params.reportPath}`
        : 'frontend E2E report is missing'
    };
  }
  if (!params.reportIsFresh) {
    return {
      status: 'open_gap',
      detail: `frontend E2E report is stale or predates this scorecard run at ${params.reportPath}`
    };
  }
  const reportPasses = params.report.passes === true || params.report.status === 'achieved';
  if (!reportPasses) {
    return {
      status: 'open_gap',
      detail: `frontend E2E failed with ${params.report.consoleFailures?.length ?? 0} console or request failure(s)`
    };
  }
  const executed = Array.isArray(params.report.scenarios) ? params.report.scenarios.map((scenario) => scenario?.name) : [];
  const requiredScenarios = liveRequiredScenarios.every((name) => executed.includes(name))
    ? liveRequiredScenarios
    : legacyRequiredScenarios;
  const missing = requiredScenarios.filter((name) => !executed.includes(name));
  if (missing.length > 0) {
    return {
      status: 'open_gap',
      detail: `frontend E2E is missing required scenarios: ${missing.join(', ')}`
    };
  }
  return {
    status: 'achieved',
    detail: `scenarios=${requiredScenarios.join(', ')}`
  };
}

function parseReportTimestamp(report) {
  if (!report || typeof report !== 'object') {
    return null;
  }
  const raw = report.generatedAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFreshReport(report, startedAt) {
  const timestamp = parseReportTimestamp(report);
  return timestamp !== null && timestamp >= startedAt;
}

function hasCanonicalLiveProviderTruth(provider) {
  return provider?.providerId === 'xiaomi-mimo-v2-flash'
    && provider?.model === 'mimo-v2.5';
}

function scenarioRuntimeCompletionGatePassed(scenario) {
  const summary = scenario?.executionSummary;
  const deterministicVerdict = summary?.acceptance?.deterministic?.verdict ?? null;
  return scenario?.finalLifecycleStatus === 'COMPLETED'
    && deterministicVerdict === 'passed';
}

function collectRuntimeGateMismatchScenarios(report) {
  if (!Array.isArray(report?.scenarios)) {
    return [];
  }
  return report.scenarios
    .filter((scenario) => scenario?.passed === true && !scenarioRuntimeCompletionGatePassed(scenario))
    .map((scenario) => scenario?.scenario ?? scenario?.family ?? 'unknown');
}

function collectScenarioProviderTruthMismatches(report) {
  if (!Array.isArray(report?.scenarios)) {
    return [];
  }
  return report.scenarios
    .filter((scenario) => {
      const providerSummary = scenario?.executionSummary?.providerSummary;
      if (!providerSummary) {
        return false;
      }
      return providerSummary.providerId !== 'xiaomi-mimo-v2-flash'
        || providerSummary.modelId !== 'mimo-v2.5';
    })
    .map((scenario) => scenario?.scenario ?? scenario?.family ?? 'unknown');
}

function summarizeCliInteractionTranscript(params) {
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so CLI transcript coverage is not trusted'
    };
  }
  if (!params.report) {
    return {
      status: 'open_gap',
      detail: 'CLI transcript report is missing'
    };
  }
  if (!isAchievedSuiteReport(params.report)) {
    return {
      status: 'open_gap',
      detail: `CLI transcript passRate=${formatPassRate(params.report)}, artifactQualityPassRate=${params.report?.totals?.artifactQualityPassRate ?? 0}`
    };
  }
  return {
    status: 'achieved',
    detail: `passRate=${formatPassRate(params.report)}, artifactQualityPassRate=${params.report.totals?.artifactQualityPassRate ?? 0}`
  };
}

function summarizeRuntimeStressValidation(params) {
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so runtime stress coverage is not trusted'
    };
  }
  if (!params.report) {
    return {
      status: 'open_gap',
      detail: 'runtime stress report is missing'
    };
  }
  if (!isAchievedSuiteReport(params.report)) {
    return {
      status: 'open_gap',
      detail: `runtime stress passRate=${formatPassRate(params.report)}, artifactQualityPassRate=${params.report?.totals?.artifactQualityPassRate ?? 0}`
    };
  }
  return {
    status: 'achieved',
    detail: `passRate=${formatPassRate(params.report)}, artifactQualityPassRate=${params.report.totals?.artifactQualityPassRate ?? 0}`
  };
}

function summarizeArtifactPathRouting(params) {
  const requiredTitles = [
    'artifact path routing blocks continue when destination is unresolved and reports stable guidance'
  ];
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so artifact path routing coverage is not trusted'
    };
  }
  if (!backendOutputIncludesAll(params.backendTestStdout, requiredTitles)) {
    return {
      status: 'open_gap',
      detail: 'artifact path routing regression marker is missing from backend test output'
    };
  }
  if (params.longRunningReliability.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'long-running reliability is not green, so destination-path blockers are not trusted'
    };
  }
  return {
    status: 'achieved',
    detail: 'tasks that produce files now surface unresolved project-relative destinations as stable operator blockers'
  };
}

function summarizeArtifactApplyFlow(params) {
  const requiredTitles = [
    'artifact apply flow copies sandbox outputs into project destination and records apply evidence'
  ];
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so artifact apply flow coverage is not trusted'
    };
  }
  if (!backendOutputIncludesAll(params.backendTestStdout, requiredTitles)) {
    return {
      status: 'open_gap',
      detail: 'artifact apply regression marker is missing from backend test output'
    };
  }
  return {
    status: 'achieved',
    detail: 'sandbox outputs can be explicitly applied into project-relative destinations with recorded apply evidence'
  };
}

function summarizeExtensionsWorkflow(generalComplex, backendTestsOk) {
  const requiredFamilies = [
    'skill-driven-task',
    'mcp-tool-assisted-task',
    'skill-failure-diagnostics',
    'mcp-failure-recovery'
  ];
  const byFamily = generalComplex?.totals?.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (!backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so extension workflow coverage is not trusted',
      byFamily
    };
  }
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing extension workflow families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizeSkillCompatibility(generalComplex, backendTestsOk) {
  const requiredFamilies = [
    'instruction-skill-guided-task',
    'instruction-skill-with-assets',
    'mixed-runtime-and-instruction-skill-task'
  ];
  const byFamily = generalComplex?.totals?.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (!backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so dual-track skill compatibility is not trusted',
      byFamily
    };
  }
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing instruction-skill families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizeLongRunningReliability(generalComplex, backendTestsOk) {
  const requiredFamilies = [
    'long-running-correction-churn',
    'checkpoint-recovery-task',
    'provider-failure-streak-task',
    'extension-failure-stability-task'
  ];
  const byFamily = generalComplex?.totals?.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  const reliabilityScenarios = Array.isArray(generalComplex?.scenarios)
    ? generalComplex.scenarios.filter((scenario) => requiredFamilies.includes(scenario.family))
    : [];
  const summaryShapeMismatch = reliabilityScenarios.some((scenario) => {
    const executionSummary = scenario?.executionSummary;
    return !executionSummary
      || typeof executionSummary.turnCount !== 'number'
      || typeof executionSummary.correctionDepth !== 'number'
      || typeof executionSummary.providerFailureStreak !== 'number'
      || typeof executionSummary.skillFailureStreak !== 'number'
      || typeof executionSummary.mcpFailureStreak !== 'number';
  });
  const inconsistentScenario = reliabilityScenarios.find((scenario) => (
    scenario?.executionSummary?.queueRuntimeAlignment?.consistent === false
  ));

  if (!backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so long-running reliability coverage is not trusted',
      byFamily
    };
  }
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing long-running reliability families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (summaryShapeMismatch) {
    return {
      status: 'open_gap',
      detail: 'long-running scenarios did not emit the required reliability summary fields',
      byFamily
    };
  }
  if (inconsistentScenario) {
    return {
      status: 'open_gap',
      detail: `queue/runtime alignment drifted in ${inconsistentScenario.family}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizeCapabilityHub(params) {
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so capability hub coverage is not trusted'
    };
  }
  if (params.workspaceWorkflow.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'workspace workflow is not green, so workspace-side capability aggregation is not trusted'
    };
  }
  if (params.extensionsWorkflow.status !== 'achieved' || params.skillCompatibility.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'skill or MCP workflow coverage regressed, so capability hub aggregation is not trusted'
    };
  }
  return {
    status: 'achieved',
    detail: 'provider, MCP, skill, and workspace readiness share the same capability vocabulary across platform, CLI, and web surfaces'
  };
}

function backendOutputIncludesAll(stdout, titles) {
  const text = `${stdout ?? ''}`;
  return titles.every((title) => text.includes(title));
}

function summarizeProviderCore(params) {
  const requiredTitles = [
    'functional provider/config line keeps provider, secret, default, and test flows aligned',
    'provider selection policy respects preferred, default, and local preference',
    'provider presets cover mainstream vendor defaults',
    'default openai-compatible provider client resolves by transport and executes a turn',
    'anthropic-compatible provider uses anthropic headers and messages endpoint'
  ];
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so provider core coverage is not trusted'
    };
  }
  if (!backendOutputIncludesAll(params.backendTestStdout, requiredTitles)) {
    return {
      status: 'open_gap',
      detail: 'provider core regression markers are missing from backend test output'
    };
  }
  if (params.capabilityHub.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'capability hub is not green, so provider readiness projection is not trusted'
    };
  }
  return {
    status: 'achieved',
    detail: 'provider registry, selection policy, presets, and adapter paths stay aligned with shared readiness vocabulary'
  };
}

function summarizePermissionsHooks(params) {
  const requiredTitles = [
    'functional workspace workflow executes matched rules, hooks, and agent profiles during task runtime',
    'create-runtime marks risky tools as waiting approval in ask mode and denies writes in read-only mode',
    'tool execution policy respects full ask and read-only permission modes'
  ];
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so permissions and hooks coverage is not trusted'
    };
  }
  if (!backendOutputIncludesAll(params.backendTestStdout, requiredTitles)) {
    return {
      status: 'open_gap',
      detail: 'permission or hook regression markers are missing from backend test output'
    };
  }
  if (params.longRunningReliability.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'long-running reliability is not green, so blocked or recovered hook/permission summaries are not trusted'
    };
  }
  return {
    status: 'achieved',
    detail: 'tool-level permission policy and workspace hooks remain visible, classified, and recoverable across runtime surfaces'
  };
}

function summarizeSubagentRouting(params) {
  const requiredTitles = [
    'functional workspace workflow executes matched rules, hooks, and agent profiles during task runtime',
    'planner summary is exposed and planner-first runtime advances by stage without skipping prerequisites',
    'planner-first runtime executes multi-unit stage without falling back to single-active mode'
  ];
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so subagent routing coverage is not trusted'
    };
  }
  if (!backendOutputIncludesAll(params.backendTestStdout, requiredTitles)) {
    return {
      status: 'open_gap',
      detail: 'subagent or planner routing regression markers are missing from backend test output'
    };
  }
  if (params.interactionConsistency.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'interaction consistency is not green, so subagent selection summaries are not trusted across surfaces'
    };
  }
  return {
    status: 'achieved',
    detail: 'workspace agent profiles and planner-style routing stay aligned with tri-surface summaries'
  };
}

function summarizeRealTaskCompletion(params) {
  const requiredFamilies = [
    'plan-build-split-task',
    'provider-variant-task',
    'mcp-readiness-gated-task',
    'runtime-skill-integration-task',
    'instruction-skill-guided-review',
    'workspace-rule-review-task',
    'permission-blocked-task',
    'hook-observable-recovery-task',
    'swebench-issue-resolution-task',
    'subagent-specialized-review-task'
  ];
  const report = params.report;
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so repo-real task completion is not trusted',
      byFamily: report?.totals?.byFamily ?? {}
    };
  }
  if (!report || !Array.isArray(report.scenarios) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'repo-real task completion report is missing or malformed',
      byFamily: {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing repo-real task families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1) {
    return {
      status: 'open_gap',
      detail: `repo-real task completion passRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`,
      byFamily
    };
  }
  const inconsistentScenario = report.scenarios.find((scenario) => scenario?.executionSummary?.queueRuntimeAlignment?.consistent === false);
  if (inconsistentScenario) {
    return {
      status: 'open_gap',
      detail: `queue/runtime alignment drifted in ${inconsistentScenario.family}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizePublicCapabilityParity(params) {
  const requiredFamilies = [
    'claude-project-instructions-task',
    'claude-custom-command-task',
    'claude-subagent-review-task',
    'claude-hook-recovery-task',
    'claude-mcp-managed-selection-task',
    'anthropic-swebench-issue-resolution-task',
    'opencode-build-plan-split-task',
    'opencode-provider-variant-task',
    'opencode-permission-gated-task',
    'opencode-runtime-skill-task',
    'opencode-mcp-capability-task',
    'opencode-provider-readiness-task'
  ];
  const report = params.report;
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so public capability parity is not trusted',
      byFamily: report?.totals?.byFamily ?? {}
    };
  }
  if (!report || !Array.isArray(report.scenarios) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'public capability parity report is missing or malformed',
      byFamily: {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing public capability parity families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1) {
    return {
      status: 'open_gap',
      detail: `public capability parity passRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`,
      byFamily
    };
  }
  const inconsistentScenario = report.scenarios.find((scenario) => scenario?.executionSummary?.queueRuntimeAlignment?.consistent === false);
  const unknownFailure = Object.prototype.hasOwnProperty.call(report.totals.byFailureCategory ?? {}, 'unknown');
  if (inconsistentScenario) {
    return {
      status: 'open_gap',
      detail: `queue/runtime alignment drifted in ${inconsistentScenario.scenario}`,
      byFamily
    };
  }
  if (unknownFailure) {
    return {
      status: 'open_gap',
      detail: 'public capability parity report contains unknown failure categories',
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}`,
    byFamily
  };
}

function summarizeManualArtifactAudit(params) {
  const report = params.report;
  if (!report || !Array.isArray(report.entries) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'manual artifact audit report is missing or malformed'
    };
  }
  if (params.publicCapabilityParity.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'public capability parity is not green, so manual artifact audit cannot be trusted yet'
    };
  }
  if (report.status !== 'achieved' || report.totals.failed > 0) {
    return {
      status: 'open_gap',
      detail: `manual artifact audit passRate=${report.totals.passed}/${report.totals.total}`
    };
  }
  return {
    status: 'achieved',
    detail: `entries=${report.totals.passed}/${report.totals.total}, reportPath=${params.reportPath}`
  };
}

function summarizePracticalTaskAcceptance(params) {
  const requiredFamilies = [
    'vague-blog-request',
    'explicit-blog-request',
    'vague-summary-request',
    'explicit-doc-request',
    'operator-report-task',
    'analysis-brief-task',
    'practical-engineering-change-task',
    'practical-review-task',
    'vague-landing-page-brief',
    'explicit-multi-artifact-doc-bundle',
    'engineering-decision-record-task',
    'repo-grounded-review-followup-task'
  ];
  const report = params.report;
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so practical task acceptance is not trusted',
      byFamily: report?.totals?.byFamily ?? {}
    };
  }
  if (!report || !Array.isArray(report.scenarios) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'practical task acceptance report is missing or malformed',
      byFamily: {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing practical task families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1) {
    return {
      status: 'open_gap',
      detail: `practical task passRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`,
      byFamily
    };
  }
  const inconsistentScenario = report.scenarios.find((scenario) => scenario?.executionSummary?.queueRuntimeAlignment?.consistent === false);
  const unknownFailure = Object.prototype.hasOwnProperty.call(report.totals.byFailureCategory ?? {}, 'unknown');
  const missingClarificationSemantics = report.scenarios.find((scenario) =>
    scenario?.scenario === 'vague-summary-request'
      ? scenario?.clarificationMode !== 'required'
      : scenario?.scenario === 'vague-blog-request'
      ? scenario?.clarificationMode !== 'assumption-led' || scenario?.assumptionDisclosure?.status !== 'declared'
      : false
  );
  if (inconsistentScenario) {
    return {
      status: 'open_gap',
      detail: `queue/runtime alignment drifted in ${inconsistentScenario.scenario}`,
      byFamily
    };
  }
  if (unknownFailure) {
    return {
      status: 'open_gap',
      detail: 'practical task acceptance report contains unknown failure categories',
      byFamily
    };
  }
  if (missingClarificationSemantics) {
    return {
      status: 'open_gap',
      detail: `hybrid clarify semantics regressed in ${missingClarificationSemantics.scenario}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}, reportPath=${params.reportPath}`,
    byFamily
  };
}

function summarizePracticalManualAudit(params) {
  const report = params.report;
  if (!report || !Array.isArray(report.entries) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'practical manual audit report is missing or malformed'
    };
  }
  if (params.practicalTaskAcceptance.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'practical task acceptance is not green, so practical manual audit cannot be trusted yet'
    };
  }
  if (report.status !== 'achieved' || report.totals.failed > 0) {
    return {
      status: 'open_gap',
      detail: `practical manual audit passRate=${report.totals.passed}/${report.totals.total}`
    };
  }
  return {
    status: 'achieved',
    detail: `entries=${report.totals.passed}/${report.totals.total}, reportPath=${params.reportPath}`
  };
}

function summarizeLivePracticalTaskAcceptance(params) {
  const requiredFamilies = [
    'vague-blog-request',
    'explicit-blog-request',
    'vague-summary-request',
    'explicit-doc-request',
    'operator-report-task',
    'analysis-brief-task',
    'practical-engineering-change-task',
    'practical-review-task',
    'vague-landing-page-brief',
    'explicit-multi-artifact-doc-bundle',
    'engineering-decision-record-task',
    'repo-grounded-review-followup-task'
  ];
  const report = params.report;
  if (!report || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'live practical task acceptance report is missing or malformed',
      byFamily: {}
    };
  }
  if (report.status === 'external_blocker') {
    return {
      status: 'external_blocker',
      detail: report.externalBlocker ?? 'live practical task acceptance is externally blocked',
      byFamily: report.totals?.byFamily ?? {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const runtimeGateMismatches = collectRuntimeGateMismatchScenarios(report);
  const providerTruthMismatches = collectScenarioProviderTruthMismatches(report);
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing live practical task families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (runtimeGateMismatches.length > 0) {
    return {
      status: 'open_gap',
      detail: `live practical scenarios bypassed runtime completion gate: ${runtimeGateMismatches.join(', ')}`,
      byFamily
    };
  }
  if (!hasCanonicalLiveProviderTruth(report.provider)) {
    return {
      status: 'open_gap',
      detail: `live practical provider truth drifted to ${report.provider?.providerId ?? 'unknown'} / ${report.provider?.model ?? 'unknown'}`,
      byFamily
    };
  }
  if (providerTruthMismatches.length > 0) {
    return {
      status: 'open_gap',
      detail: `live practical execution summaries drifted from canonical provider/model truth: ${providerTruthMismatches.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1 || report.totals.liveProviderPassRate !== 1) {
    return {
      status: 'open_gap',
      detail: `live practical passRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}, liveProviderPassRate=${report.totals.liveProviderPassRate}`,
      byFamily
    };
  }
  if (Number(report.totals.criticalGapsCount ?? 0) > 0) {
    return {
      status: 'open_gap',
      detail: `live practical critical gaps remain (${report.totals.criticalGapsCount})`,
      byFamily
    };
  }
  const inconsistentScenario = report.scenarios.find((scenario) => scenario?.executionSummary?.queueRuntimeAlignment?.consistent === false);
  const unknownFailure = Object.prototype.hasOwnProperty.call(report.totals.byFailureCategory ?? {}, 'unknown');
  const missingClarificationSemantics = report.scenarios.find((scenario) =>
    scenario?.scenario === 'vague-summary-request'
      ? scenario?.clarificationMode !== 'required'
      : scenario?.scenario === 'vague-blog-request'
      ? scenario?.clarificationMode !== 'assumption-led' || scenario?.assumptionDisclosure?.status !== 'declared'
      : false
  );
  if (inconsistentScenario) {
    return {
      status: 'open_gap',
      detail: `queue/runtime alignment drifted in ${inconsistentScenario.scenario}`,
      byFamily
    };
  }
  if (unknownFailure) {
    return {
      status: 'open_gap',
      detail: 'live practical task acceptance report contains unknown failure categories',
      byFamily
    };
  }
  if (missingClarificationSemantics) {
    return {
      status: 'open_gap',
      detail: `hybrid clarify semantics regressed in ${missingClarificationSemantics.scenario}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}, reportPath=${params.reportPath}`,
    byFamily
  };
}

function summarizeLivePracticalManualAudit(params) {
  const report = params.report;
  if (!report) {
    return {
      status: 'open_gap',
      detail: 'live practical manual audit report is missing or malformed'
    };
  }
  if (report.status === 'external_blocker') {
    return {
      status: 'external_blocker',
      detail: report.externalBlocker ?? 'live practical manual audit is externally blocked'
    };
  }
  if (params.livePracticalTaskAcceptance.status !== 'achieved') {
    return {
      status: 'open_gap',
      detail: 'live practical task acceptance is not green, so live practical manual audit cannot be trusted yet'
    };
  }
  if (report.status !== 'achieved' || report.totals?.failed > 0) {
    return {
      status: 'open_gap',
      detail: `live practical manual audit passRate=${report.totals?.passed ?? 0}/${report.totals?.total ?? 0}`
    };
  }
  if (Number(report.totals?.criticalGapsCount ?? 0) > 0) {
    return {
      status: 'open_gap',
      detail: `live practical manual audit still has critical gaps (${report.totals?.criticalGapsCount ?? 0})`
    };
  }
  return {
    status: 'achieved',
    detail: `entries=${report.totals.passed}/${report.totals.total}, shipReadyPassRate=${report.totals?.shipReadyPassRate ?? 0}, reportPath=${params.reportPath}`
  };
}

function summarizeLiveProviderUsageAccounting(params) {
  const liveProviderReport = params.liveProviderReport;
  const livePracticalReport = params.livePracticalReport;
  if (!liveProviderReport || !livePracticalReport) {
    return {
      status: 'open_gap',
      detail: 'live provider usage reports are missing'
    };
  }
  if (liveProviderReport.status === 'external_blocker' || livePracticalReport.status === 'external_blocker') {
    return {
      status: 'external_blocker',
      detail: livePracticalReport.externalBlocker ?? liveProviderReport.externalBlocker ?? 'live provider usage accounting is externally blocked'
    };
  }
  const liveScenarioTokens = Number(liveProviderReport.totals?.totalTokens ?? 0);
  const livePracticalTokens = Number(livePracticalReport.totals?.totalTokens ?? 0);
  const liveScenarioCalls = Number(liveProviderReport.totals?.totalApiCalls ?? 0);
  const livePracticalCalls = Number(livePracticalReport.totals?.totalApiCalls ?? 0);
  const liveScenarioBreakdown = liveProviderReport.totals?.usageBreakdown ?? {};
  const livePracticalBreakdown = livePracticalReport.totals?.usageBreakdown ?? {};
  const missingUsageCalls = Number(liveScenarioBreakdown.missingCalls ?? 0)
    + Number(livePracticalBreakdown.missingCalls ?? 0);
  const estimatedUsageCalls = Number(liveScenarioBreakdown.estimatedCalls ?? 0)
    + Number(livePracticalBreakdown.estimatedCalls ?? 0);
  const returnedUsageCalls = Number(liveScenarioBreakdown.returnedCalls ?? 0)
    + Number(livePracticalBreakdown.returnedCalls ?? 0);
  if (liveScenarioCalls <= 0 || livePracticalCalls <= 0) {
    return {
      status: 'open_gap',
      detail: `apiCallCount did not register correctly (engineering=${liveScenarioCalls}, practical=${livePracticalCalls})`
    };
  }
  if (liveScenarioTokens <= 0 || livePracticalTokens <= 0) {
    return {
      status: 'open_gap',
      detail: `token accounting did not register correctly (engineering=${liveScenarioTokens}, practical=${livePracticalTokens})`
    };
  }
  if (missingUsageCalls > 0) {
    return {
      status: 'open_gap',
      detail: `live usage accounting still has missing provider usage calls (returned=${returnedUsageCalls}, estimated=${estimatedUsageCalls}, missing=${missingUsageCalls})`
    };
  }
  return {
    status: 'achieved',
    detail: `engineeringTokens=${liveScenarioTokens}, practicalTokens=${livePracticalTokens}, engineeringCalls=${liveScenarioCalls}, practicalCalls=${livePracticalCalls}, returnedCalls=${returnedUsageCalls}, estimatedCalls=${estimatedUsageCalls}, missingCalls=${missingUsageCalls}`
  };
}

function summarizeEcommerceDelivery(params) {
  const requiredFamilies = [
    'domain-modeling-task',
    'checkout-state-machine-task',
    'payment-webhook-idempotency-task',
    'inventory-reservation-task',
    'promotion-rule-evaluation-task',
    'refund-compensation-task',
    'search-indexing-task',
    'analytics-pipeline-task',
    'admin-operator-workflow-task',
    'customer-service-case-task',
    'observability-hardening-task',
    'deployment-readiness-task'
  ];
  const report = params.report;
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so ecommerce delivery is not trusted',
      byFamily: report?.totals?.byFamily ?? {}
    };
  }
  if (!report || !Array.isArray(report.scenarios) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'ecommerce delivery report is missing or malformed',
      byFamily: {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing ecommerce delivery families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1) {
    return {
      status: 'open_gap',
      detail: `ecommerce delivery passRate=${report.totals.successRate}, artifactQualityPassRate=${report.totals.artifactQualityPassRate}`,
      byFamily
    };
  }
  const manualAudit = report.manualAudit ?? null;
  if (!manualAudit || manualAudit.status !== 'achieved' || manualAudit.failed !== 0) {
    return {
      status: 'open_gap',
      detail: `ecommerce manual audit passRate=${manualAudit?.passed ?? 0}/${manualAudit?.total ?? report.scenarios.length}`,
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}, reportPath=${params.reportPath}`,
    byFamily
  };
}

function summarizeEcommerceReadiness(params) {
  const requiredFamilies = [
    'idempotency',
    'compensation-retry-design',
    'audit-event-completeness',
    'cache-read-model-boundary',
    'deployment-template-completeness',
    'observability-alert-surface',
    'migration-boundaries'
  ];
  const report = params.report;
  if (!params.backendTestsOk) {
    return {
      status: 'open_gap',
      detail: 'backend tests are not green, so ecommerce readiness is not trusted',
      byFamily: report?.totals?.byFamily ?? {}
    };
  }
  if (!report || !Array.isArray(report.scenarios) || !report.totals) {
    return {
      status: 'open_gap',
      detail: 'ecommerce readiness report is missing or malformed',
      byFamily: {}
    };
  }
  const byFamily = report.totals.byFamily ?? {};
  const missingFamilies = requiredFamilies.filter((family) => Number(byFamily[family] ?? 0) < 1);
  if (missingFamilies.length > 0) {
    return {
      status: 'open_gap',
      detail: `missing ecommerce readiness families: ${missingFamilies.join(', ')}`,
      byFamily
    };
  }
  if (report.totals.successRate !== 1) {
    return {
      status: 'open_gap',
      detail: `ecommerce readiness passRate=${report.totals.successRate}`,
      byFamily
    };
  }
  const unknownFailure = Object.prototype.hasOwnProperty.call(report.totals.byFailureCategory ?? {}, 'unknown');
  if (unknownFailure) {
    return {
      status: 'open_gap',
      detail: 'ecommerce readiness report contains unknown failure categories',
      byFamily
    };
  }
  return {
    status: 'achieved',
    detail: `families=${requiredFamilies.map((family) => `${family}:${byFamily[family] ?? 0}`).join(', ')}, reportPath=${params.reportPath}`,
    byFamily
  };
}

function parseBackendTestCounts(output) {
  const pass = output.match(/ℹ pass (\d+)/)?.[1] ?? output.match(/pass (\d+)/)?.[1] ?? null;
  const skipped = output.match(/ℹ skipped (\d+)/)?.[1] ?? output.match(/skipped (\d+)/)?.[1] ?? null;
  const fail = output.match(/ℹ fail (\d+)/)?.[1] ?? output.match(/fail (\d+)/)?.[1] ?? null;
  return {
    pass: pass ? Number(pass) : null,
    skipped: skipped ? Number(skipped) : null,
    fail: fail ? Number(fail) : null
  };
}

function summarizeProviderHardening(params) {
  const liveProvider = params.liveProvider;
  const benchmark = params.benchmark;
  const liveProviderProfile = params.liveProviderProfile;
  const providerSummary = liveProvider?.provider ?? null;
  const runtimeGateMismatches = collectRuntimeGateMismatchScenarios(liveProvider);
  const providerTruthMismatches = collectScenarioProviderTruthMismatches(liveProvider);
  const scenarioFailures = Array.isArray(liveProvider?.scenarios)
    ? liveProvider.scenarios
      .filter((scenario) => scenario?.artifactQuality?.failureCategory)
      .map((scenario) => scenario.artifactQuality.failureCategory)
    : [];
  const uniqueFailureCategories = [...new Set(scenarioFailures)];

  if (liveProviderProfile.mode === 'disabled') {
    return {
      status: 'external_blocker',
      mode: liveProviderProfile.mode,
      reason: liveProviderProfile.reason,
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      failureCategories: uniqueFailureCategories
    };
  }

  if (liveProviderProfile.mode === 'enabled-but-failed') {
    return {
      status: 'open_gap',
      mode: liveProviderProfile.mode,
      reason: runtimeGateMismatches.length > 0
        ? `live provider suite bypassed runtime completion gate: ${runtimeGateMismatches.join(', ')}`
        : providerTruthMismatches.length > 0
        ? `live provider execution summaries drifted from canonical provider/model truth: ${providerTruthMismatches.join(', ')}`
        : !hasCanonicalLiveProviderTruth(providerSummary)
        ? `live provider truth drifted to ${providerSummary?.providerId ?? 'unknown'} / ${providerSummary?.model ?? 'unknown'}`
        : uniqueFailureCategories.length > 0
        ? `live provider artifact evidence still reports gaps: ${uniqueFailureCategories.join(', ')}`
        : liveProviderProfile.reason,
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      failureCategories: uniqueFailureCategories
    };
  }

  if (runtimeGateMismatches.length > 0) {
    return {
      status: 'open_gap',
      mode: liveProviderProfile.mode,
      reason: `live provider suite bypassed runtime completion gate: ${runtimeGateMismatches.join(', ')}`,
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      failureCategories: uniqueFailureCategories
    };
  }

  if (!hasCanonicalLiveProviderTruth(providerSummary) || providerTruthMismatches.length > 0) {
    return {
      status: 'open_gap',
      mode: liveProviderProfile.mode,
      reason: !hasCanonicalLiveProviderTruth(providerSummary)
        ? `live provider truth drifted to ${providerSummary?.providerId ?? 'unknown'} / ${providerSummary?.model ?? 'unknown'}`
        : `live provider execution summaries drifted from canonical provider/model truth: ${providerTruthMismatches.join(', ')}`,
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      failureCategories: uniqueFailureCategories
    };
  }

  return {
    status: 'achieved',
    mode: liveProviderProfile.mode,
    reason: benchmark?.realisticComplexDag?.objectives?.tokenReductionTargetSatisfied
      ? 'live provider execution and benchmark guardrails are both green'
      : 'live provider execution is green and provider failures are categorized consistently',
    providerId: providerSummary?.providerId ?? null,
    model: providerSummary?.model ?? null,
    failureCategories: uniqueFailureCategories
  };
}

function summarizeLiveProviderProfile(params) {
  const liveProvider = params.liveProvider;
  const providerSummary = liveProvider?.provider ?? null;
  const blocker = `${liveProvider?.externalBlocker ?? ''}`.trim();

  if (!liveProvider || (liveProvider.status === 'external_blocker' && /disabled/i.test(blocker))) {
    return {
      mode: 'disabled',
      reason: blocker || 'live provider execution is disabled in the current profile',
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      profile: params.scorecardProfile,
      reportPath: params.reportPath
    };
  }

  if (liveProvider.status === 'achieved') {
    return {
      mode: 'achieved',
      reason: 'live provider execution is enabled and passing',
      providerId: providerSummary?.providerId ?? null,
      model: providerSummary?.model ?? null,
      profile: params.scorecardProfile,
      reportPath: params.reportPath
    };
  }

  return {
    mode: 'enabled-but-failed',
    reason: blocker || 'live provider execution is enabled but validation did not pass',
    providerId: providerSummary?.providerId ?? null,
    model: providerSummary?.model ?? null,
    profile: params.scorecardProfile,
    reportPath: params.reportPath
  };
}

function liveProviderModeToStatus(mode) {
  if (mode === 'disabled') {
    return 'external_blocker';
  }
  if (mode === 'achieved') {
    return 'achieved';
  }
  return 'open_gap';
}

function summarizeRecoveryChurn(params) {
  const scenarioSuites = [
    ...(Array.isArray(params.workflow?.scenarios) ? params.workflow.scenarios : []),
    ...(Array.isArray(params.breadth?.scenarios) ? params.breadth.scenarios : []),
    ...(Array.isArray(params.flagship?.scenarios) ? params.flagship.scenarios : [])
  ];
  const recoveredScenarios = scenarioSuites.filter((scenario) => scenario?.executionSummary?.recovery?.recoveredAfterRestart);
  const inconsistentScenarios = scenarioSuites.filter((scenario) => scenario?.issueCategory === 'recovery_inconsistency');
  const totalRecoveryCount = scenarioSuites.reduce(
    (total, scenario) => total + Number(scenario?.metrics?.recoveryCount ?? 0),
    0
  );

  if (inconsistentScenarios.length > 0) {
    return {
      status: 'open_gap',
      reason: `recovery inconsistency detected in ${inconsistentScenarios.length} scenario(s)`,
      recoveredScenarioCount: recoveredScenarios.length,
      totalRecoveryCount
    };
  }

  return {
    status: 'achieved',
    reason: recoveredScenarios.length > 0
      ? `restart and churn paths stayed aligned across ${recoveredScenarios.length} recovery scenario(s)`
      : 'no recovery scenarios were exercised',
    recoveredScenarioCount: recoveredScenarios.length,
    totalRecoveryCount
  };
}

function summarizePostgresStatus(result) {
  if (!result) {
    return {
      status: 'external_blocker',
      reason: 'postgres validation was not executed',
      category: 'missing_execution'
    };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  const combinedLower = combined.toLowerCase();
  if (result.status === 0) {
    return {
      status: 'achieved',
      reason: 'postgres integration tests passed',
      category: 'passed'
    };
  }
  if (/BACKEND_NEW_PG_TEST_URL|BACKEND_NEW_DATABASE_URL/.test(combined)) {
    return {
      status: 'external_blocker',
      reason: 'postgres environment variables are missing',
      category: 'env_missing'
    };
  }
  if (/econnrefused|could not connect|connect econn|password authentication failed|no pg_hba|database .* does not exist|connection terminated|connection refused/.test(combinedLower)) {
    return {
      status: 'open_gap',
      reason: 'postgres connection failed',
      category: 'connection_failed'
    };
  }
  if (/migration|migrate|schema|relation .* does not exist|column .* does not exist/.test(combinedLower)) {
    return {
      status: 'open_gap',
      reason: 'postgres migration failed',
      category: 'migration_failed'
    };
  }
  return {
    status: 'open_gap',
    reason: 'postgres integration tests failed',
    category: 'test_failed'
  };
}

function isBlockingScorecardCommandFailure(result) {
  if (!result || result.status === 0) {
    return false;
  }
  if (result.label === 'postgres-test') {
    return summarizePostgresStatus(result).status === 'open_gap';
  }
  return true;
}

async function main() {
  if (scorecardForceRerun) {
    await assertLiveCostGuard({
      rootDir,
      env: process.env,
      label: 'release:scorecard'
    });
  }
  const cleanup = await cleanHistoricalTestArtifacts({ cwd: rootDir });
  const commands = [];
  const neutralEnv = createNeutralScorecardEnv();
  const liveEnv = process.env;

  commands.push(runCommand('build', 'npm', ['run', 'build'], { env: neutralEnv }));
  commands.push(runCommand('backend-test', 'npm', ['test', '-w', 'backend'], { env: neutralEnv }));
  commands.push(runCommand('repo-hygiene', 'npm', ['run', 'repo-hygiene'], { env: neutralEnv }));
  commands.push(runCommand('repo-delivery', 'npm', ['run', 'repo-delivery'], { env: neutralEnv }));
  commands.push(runCommand('workflow', 'npm', ['run', 'workflow-scenarios', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('breadth', 'npm', ['run', 'breadth-scenarios', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('flagship', 'npm', ['run', 'flagship-scenarios', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('general-complex', 'npm', ['run', 'general-complex-scenarios', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('real-task-completion', 'npm', ['run', 'real-task-completion', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('public-capability-parity', 'npm', ['run', 'public-capability-parity', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('manual-artifact-audit', 'npm', ['run', 'manual-artifact-audit', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('practical-task-acceptance', 'npm', ['run', 'practical-task-acceptance', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('practical-manual-audit', 'npm', ['run', 'practical-manual-audit', '--', '--json'], { env: neutralEnv }));
  const practicalLiveTaskAcceptanceSource = await loadSuiteFromCommandOrReport({
    label: 'practical-live-task-acceptance',
    command: 'npm',
    args: ['run', 'practical-live-task-acceptance', '--', '--json'],
    options: { env: liveEnv },
    reportPath: practicalLiveTaskAcceptanceReportPath,
    forceRerun: scorecardForceRerun,
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  commands.push(practicalLiveTaskAcceptanceSource.command);
  const practicalLiveManualAuditSource = await loadSuiteFromCommandOrReport({
    label: 'practical-live-manual-audit',
    command: 'npm',
    args: ['run', 'practical-live-manual-audit', '--', '--json'],
    options: { env: liveEnv },
    reportPath: practicalLiveManualAuditReportPath,
    forceRerun: scorecardForceRerun,
    validator: (payload) => Array.isArray(payload?.entries) || payload?.status === 'external_blocker'
  });
  commands.push(practicalLiveManualAuditSource.command);
  commands.push(runCommand('ecommerce-delivery', 'npm', ['run', 'ecommerce-delivery', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('ecommerce-readiness', 'npm', ['run', 'ecommerce-readiness', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('cli-interaction-transcript', 'npm', ['run', 'cli-interaction-transcript', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('runtime-stress-validation', 'npm', ['run', 'runtime-stress-validation', '--', '--json'], { env: neutralEnv }));
  commands.push(runCommand('frontend-e2e', 'npm', ['run', 'e2e:frontend'], { env: neutralEnv }));
  const liveProviderSource = await loadSuiteFromCommandOrReport({
    label: 'live-provider',
    command: 'npm',
    args: ['run', 'live-provider-scenarios', '--', '--json'],
    options: { env: liveEnv },
    reportPath: liveProviderReportPath,
    forceRerun: scorecardForceRerun,
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  commands.push(liveProviderSource.command);
  const benchmarkSource = await loadSuiteFromCommandOrReport({
    label: 'benchmark',
    command: 'npm',
    args: ['run', 'benchmark', '-w', 'backend', '--', '--json'],
    options: { env: liveEnv },
    reportPath: benchmarkReportPath,
    forceRerun: scorecardForceRerun,
    runCommandWhenReportUnavailable: true,
    validator: (payload) => Boolean(payload?.syntheticBaseline || payload?.realisticComplexDag)
  });
  commands.push(benchmarkSource.command);
  const postgres = runCommand('postgres-test', 'npm', ['run', 'test:postgres', '-w', 'backend'], { env: neutralEnv });
  commands.push(postgres);
  const smoke = runCommand('frontend-smoke', 'npm', ['run', 'smoke:frontend'], { env: neutralEnv });

  const failed =
    commands.find(isBlockingScorecardCommandFailure)
    ?? ((smoke && smoke.status !== 0) ? smoke : null)
    ?? (postgres.status !== 0 && summarizePostgresStatus(postgres).status === 'open_gap' ? postgres : null);
  const backendTests = parseBackendTestCounts(commands.find((result) => result.label === 'backend-test')?.stdout ?? '');
  const parsingIssues = [];
  const workflowParse = parseCommandPayload(commands.find((result) => result.label === 'workflow') ?? { label: 'workflow', stdout: '' }, {
    label: 'workflow',
    nestedKey: 'workflow',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const breadthParse = parseCommandPayload(commands.find((result) => result.label === 'breadth') ?? { label: 'breadth', stdout: '' }, {
    label: 'breadth',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const flagshipParse = parseCommandPayload(commands.find((result) => result.label === 'flagship') ?? { label: 'flagship', stdout: '' }, {
    label: 'flagship',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const generalComplexParse = parseCommandPayload(commands.find((result) => result.label === 'general-complex') ?? { label: 'general-complex', stdout: '' }, {
    label: 'general-complex',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  let realTaskCompletionCommand = commands.find((result) => result.label === 'real-task-completion') ?? { label: 'real-task-completion', stdout: '' };
  let realTaskCompletionParse = parseCommandPayload(realTaskCompletionCommand, {
    label: 'real-task-completion',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  if (shouldRetrySuiteParse(realTaskCompletionParse)) {
    const retryCommand = runCommand('real-task-completion', 'npm', ['run', 'real-task-completion', '--', '--json'], { env: neutralEnv });
    const retryParse = parseCommandPayload(retryCommand, {
      label: 'real-task-completion',
      validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
    });
    if (isBetterSuiteParse(retryParse, realTaskCompletionParse)) {
      const commandIndex = commands.findIndex((result) => result.label === 'real-task-completion');
      if (commandIndex >= 0) {
        commands[commandIndex] = retryCommand;
      } else {
        commands.push(retryCommand);
      }
      realTaskCompletionCommand = retryCommand;
      realTaskCompletionParse = retryParse;
    }
  }
  const publicCapabilityParityParse = parseCommandPayload(commands.find((result) => result.label === 'public-capability-parity') ?? { label: 'public-capability-parity', stdout: '' }, {
    label: 'public-capability-parity',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const manualArtifactAuditParse = parseCommandPayload(commands.find((result) => result.label === 'manual-artifact-audit') ?? { label: 'manual-artifact-audit', stdout: '' }, {
    label: 'manual-artifact-audit',
    validator: (payload) => Array.isArray(payload?.entries) && payload?.totals
  });
  const practicalTaskAcceptanceParse = parseCommandPayload(commands.find((result) => result.label === 'practical-task-acceptance') ?? { label: 'practical-task-acceptance', stdout: '' }, {
    label: 'practical-task-acceptance',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const practicalManualAuditParse = parseCommandPayload(commands.find((result) => result.label === 'practical-manual-audit') ?? { label: 'practical-manual-audit', stdout: '' }, {
    label: 'practical-manual-audit',
    validator: (payload) => Array.isArray(payload?.entries) && payload?.totals
  });
  const practicalLiveTaskAcceptanceParse = practicalLiveTaskAcceptanceSource.parse;
  const practicalLiveManualAuditParse = practicalLiveManualAuditSource.parse;
  const livePracticalReport = practicalLiveTaskAcceptanceParse.payload ?? null;
  const livePracticalAuditReport = practicalLiveManualAuditParse.payload ?? null;
  const ecommerceDeliveryParse = parseCommandPayload(commands.find((result) => result.label === 'ecommerce-delivery') ?? { label: 'ecommerce-delivery', stdout: '' }, {
    label: 'ecommerce-delivery',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals && payload?.manualAudit
  });
  const ecommerceReadinessParse = parseCommandPayload(commands.find((result) => result.label === 'ecommerce-readiness') ?? { label: 'ecommerce-readiness', stdout: '' }, {
    label: 'ecommerce-readiness',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const cliInteractionTranscriptParse = parseCommandPayload(commands.find((result) => result.label === 'cli-interaction-transcript') ?? { label: 'cli-interaction-transcript', stdout: '' }, {
    label: 'cli-interaction-transcript',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const runtimeStressValidationParse = parseCommandPayload(commands.find((result) => result.label === 'runtime-stress-validation') ?? { label: 'runtime-stress-validation', stdout: '' }, {
    label: 'runtime-stress-validation',
    validator: (payload) => Array.isArray(payload?.scenarios) && payload?.totals
  });
  const liveProviderParse = liveProviderSource.parse;
  const benchmarkParse = benchmarkSource.parse;
  const repoHygieneParse = parseCommandPayload(commands.find((result) => result.label === 'repo-hygiene') ?? { label: 'repo-hygiene', stdout: '' }, {
    label: 'repo-hygiene',
    validator: (payload) => Array.isArray(payload?.issues) && typeof payload?.status === 'string'
  });
  const repoDeliveryParse = parseCommandPayload(commands.find((result) => result.label === 'repo-delivery') ?? { label: 'repo-delivery', stdout: '' }, {
    label: 'repo-delivery',
    validator: (payload) => Array.isArray(payload?.issues) && typeof payload?.status === 'string'
  });
  parsingIssues.push(
    ...repoHygieneParse.issues,
    ...repoDeliveryParse.issues,
    ...workflowParse.issues,
    ...breadthParse.issues,
    ...flagshipParse.issues,
    ...generalComplexParse.issues,
    ...realTaskCompletionParse.issues,
    ...publicCapabilityParityParse.issues,
    ...manualArtifactAuditParse.issues,
    ...practicalTaskAcceptanceParse.issues,
    ...practicalManualAuditParse.issues,
    ...practicalLiveTaskAcceptanceParse.issues,
    ...practicalLiveManualAuditParse.issues,
    ...ecommerceDeliveryParse.issues,
    ...ecommerceReadinessParse.issues,
    ...cliInteractionTranscriptParse.issues,
    ...runtimeStressValidationParse.issues,
    ...liveProviderParse.issues,
    ...benchmarkParse.issues
  );
  const workflow = workflowParse.payload ?? {};
  const breadth = breadthParse.payload ?? {};
  const flagship = flagshipParse.payload ?? {};
  const generalComplex = generalComplexParse.payload ?? {};
  const realTaskCompletionReport = realTaskCompletionParse.payload ?? {};
  const publicCapabilityParityReport = publicCapabilityParityParse.payload ?? {};
  const manualArtifactAuditReport = manualArtifactAuditParse.payload ?? {};
  const practicalTaskAcceptanceReport = practicalTaskAcceptanceParse.payload ?? {};
  const practicalManualAuditReport = practicalManualAuditParse.payload ?? {};
  const practicalLiveTaskAcceptanceReport = practicalLiveTaskAcceptanceParse.payload ?? {};
  const practicalLiveManualAuditReport = practicalLiveManualAuditParse.payload ?? {};
  const ecommerceDeliveryReport = ecommerceDeliveryParse.payload ?? {};
  const ecommerceReadinessReport = ecommerceReadinessParse.payload ?? {};
  const cliInteractionTranscriptReport = cliInteractionTranscriptParse.payload ?? {};
  const runtimeStressValidationReport = runtimeStressValidationParse.payload ?? {};
  const liveProvider = liveProviderParse.payload ?? {};
  const benchmark = benchmarkParse.payload ?? {};
  const repoHygiene = repoHygieneParse.payload ?? {};
  const repoDelivery = repoDeliveryParse.payload ?? {};
  let frontendSmokeReport = null;
  try {
    frontendSmokeReport = JSON.parse(await fs.readFile(frontendSmokeReportPath, 'utf8'));
  } catch {
    frontendSmokeReport = null;
  }
  let frontendE2EReport = null;
  try {
    frontendE2EReport = JSON.parse(await fs.readFile(frontendE2EReportPath, 'utf8'));
  } catch {
    frontendE2EReport = null;
  }
  const liveProviderProfile = summarizeLiveProviderProfile({
    liveProvider: liveProviderParse.payload ? liveProvider : null,
    scorecardProfile,
    reportPath
  });
  const backendTestResult = commands.find((result) => result.label === 'backend-test') ?? null;
  const backendTestsOk = backendTestResult?.status === 0;
  const backendTestStdout = backendTestResult?.stdout ?? '';
  const workspaceWorkflow = summarizeWorkspaceWorkflow(generalComplex, backendTestsOk);
  const extensionsWorkflow = summarizeExtensionsWorkflow(generalComplex, backendTestsOk);
  const skillCompatibility = summarizeSkillCompatibility(generalComplex, backendTestsOk);
  const longRunningReliability = summarizeLongRunningReliability(generalComplex, backendTestsOk);
  const capabilityHub = summarizeCapabilityHub({
    backendTestsOk,
    workspaceWorkflow,
    extensionsWorkflow,
    skillCompatibility
  });
  const interactionConsistency = summarizeInteractionConsistency({
    backendTestsOk,
    frontendSmokeOk: smoke ? smoke.status === 0 : false,
    workflowPassRate: workflowParse.payload ? formatPassRate(workflow) : 'parse_error',
    breadthPassRate: breadthParse.payload ? formatPassRate(breadth) : 'parse_error'
  });
  const cliWebInteraction = summarizeCliWebInteraction({
    backendTestsOk,
    frontendSmokeOk: smoke ? smoke.status === 0 : false,
    frontendSmokeReport,
    interactionConsistency
  });
  const frontendE2ECommand = commands.find((result) => result.label === 'frontend-e2e') ?? null;
  const frontendE2EReportFresh = isFreshReport(frontendE2EReport, scorecardStartedAt);
  const interactionE2E = summarizeInteractionE2E({
    report: frontendE2EReport,
    commandStatus: frontendE2ECommand?.status ?? null,
    reportIsFresh: frontendE2EReportFresh,
    reportPath: frontendE2EReportPath
  });
  const cliInteractionTranscript = summarizeCliInteractionTranscript({
    backendTestsOk,
    report: cliInteractionTranscriptParse.payload ? cliInteractionTranscriptReport : null
  });
  const runtimeStressValidation = summarizeRuntimeStressValidation({
    backendTestsOk,
    report: runtimeStressValidationParse.payload ? runtimeStressValidationReport : null
  });
  const providerCore = summarizeProviderCore({
    backendTestsOk,
    backendTestStdout,
    capabilityHub
  });
  const artifactPathRouting = summarizeArtifactPathRouting({
    backendTestsOk,
    backendTestStdout,
    longRunningReliability
  });
  const artifactApplyFlow = summarizeArtifactApplyFlow({
    backendTestsOk,
    backendTestStdout
  });
  const permissionsHooks = summarizePermissionsHooks({
    backendTestsOk,
    backendTestStdout,
    longRunningReliability
  });
  const subagentRouting = summarizeSubagentRouting({
    backendTestsOk,
    backendTestStdout,
    interactionConsistency
  });
  const realTaskCompletion = summarizeRealTaskCompletion({
    backendTestsOk,
    report: realTaskCompletionParse.payload ? realTaskCompletionReport : null
  });
  const publicCapabilityParity = summarizePublicCapabilityParity({
    backendTestsOk,
    report: publicCapabilityParityParse.payload ? publicCapabilityParityReport : null
  });
  const manualArtifactAudit = summarizeManualArtifactAudit({
    publicCapabilityParity,
    report: manualArtifactAuditParse.payload ? manualArtifactAuditReport : null,
    reportPath: manualArtifactAuditReportPath
  });
  const practicalTaskAcceptance = summarizePracticalTaskAcceptance({
    backendTestsOk,
    report: practicalTaskAcceptanceParse.payload ? practicalTaskAcceptanceReport : null,
    reportPath: practicalTaskAcceptanceReportPath
  });
  const practicalManualAudit = summarizePracticalManualAudit({
    practicalTaskAcceptance,
    report: practicalManualAuditParse.payload ? practicalManualAuditReport : null,
    reportPath: practicalManualAuditReportPath
  });
  const livePracticalTaskAcceptance = summarizeLivePracticalTaskAcceptance({
    report: practicalLiveTaskAcceptanceParse.payload ? practicalLiveTaskAcceptanceReport : null,
    reportPath: practicalLiveTaskAcceptanceReportPath
  });
  const livePracticalManualAudit = summarizeLivePracticalManualAudit({
    livePracticalTaskAcceptance,
    report: practicalLiveManualAuditParse.payload ? practicalLiveManualAuditReport : null,
    reportPath: practicalLiveManualAuditReportPath
  });
  const ecommerceDelivery = summarizeEcommerceDelivery({
    backendTestsOk,
    report: ecommerceDeliveryParse.payload ? ecommerceDeliveryReport : null,
    reportPath: ecommerceDeliveryReportPath
  });
  const ecommerceReadiness = summarizeEcommerceReadiness({
    backendTestsOk,
    report: ecommerceReadinessParse.payload ? ecommerceReadinessReport : null,
    reportPath: ecommerceReadinessReportPath
  });
  const postgresStatus = summarizePostgresStatus(postgres);
  const providerHardening = summarizeProviderHardening({ liveProvider, benchmark, liveProviderProfile });
  const liveProviderUsageAccounting = summarizeLiveProviderUsageAccounting({
    liveProviderReport: liveProviderParse.payload ? liveProvider : null,
    livePracticalReport: practicalLiveTaskAcceptanceParse.payload ? practicalLiveTaskAcceptanceReport : null
  });
  const recoveryChurn = summarizeRecoveryChurn({ workflow, breadth, flagship });
  const realisticBenchmark = benchmark.realisticComplexDag
    ? {
      apiCallReductionRatio: benchmark.realisticComplexDag.deltas?.apiCallReductionRatio ?? null,
      tokenReductionRatio: benchmark.realisticComplexDag.deltas?.tokenReductionRatio ?? null,
      tokenReductionTargetSatisfied: benchmark.realisticComplexDag.objectives?.tokenReductionTargetSatisfied ?? null,
      reductionGap: benchmark.realisticComplexDag.tokenAnalysis?.reductionGap ?? null,
      likelyBottleneck: benchmark.realisticComplexDag.tokenAnalysis?.likelyBottleneck ?? null
    }
    : null;
  const frontendSmokeStatus = smoke
    ? (smoke.status === 0 ? 'achieved' : 'open_gap')
    : 'external_blocker';
  const engineeringFloor = [
    {
      area: 'build',
      status: commands.find((result) => result.label === 'build')?.status === 0 ? 'achieved' : 'open_gap',
      detail: 'root build'
    },
    {
      area: 'backend-tests',
      status: commands.find((result) => result.label === 'backend-test')?.status === 0 ? 'achieved' : 'open_gap',
      detail: `${backendTests.pass ?? '?'} pass / ${backendTests.skipped ?? '?'} skip / ${backendTests.fail ?? '?'} fail`
    },
    {
      area: 'repo-hygiene',
      status: repoHygieneParse.payload && repoHygiene.status === 'achieved' ? 'achieved' : 'open_gap',
      detail: repoHygieneParse.payload
        ? `checkedFiles=${repoHygiene.checkedFileCount}, issues=${repoHygiene.issues?.length ?? 0}`
        : repoHygieneParse.issues.join('; ')
    },
    {
      area: 'repo-delivery',
      status: repoDeliveryParse.payload && repoDelivery.status === 'achieved' ? 'achieved' : 'open_gap',
      detail: repoDeliveryParse.payload
        ? `runtimeTracked=${repoDelivery.checked?.trackedRuntimeFiles ?? '?'}, issues=${repoDelivery.issues?.length ?? 0}`
        : repoDeliveryParse.issues.join('; ')
    },
    {
      area: 'workflow',
      status: workflowParse.payload && formatPassRate(workflow) === '5/5' ? 'achieved' : 'open_gap',
      detail: workflowParse.payload ? formatPassRate(workflow) : workflowParse.issues.join('; ')
    },
    {
      area: 'breadth',
      status: breadthParse.payload && formatPassRate(breadth) === '10/10' ? 'achieved' : 'open_gap',
      detail: breadthParse.payload ? formatPassRate(breadth) : breadthParse.issues.join('; ')
    },
    {
      area: 'flagship',
      status: flagshipParse.payload && formatPassRate(flagship) === '5/5' ? 'achieved' : 'open_gap',
      detail: flagshipParse.payload ? formatPassRate(flagship) : flagshipParse.issues.join('; ')
    },
      {
        area: 'general-complex',
        status: generalComplexParse.payload && generalComplex.status === 'achieved' ? 'achieved' : 'open_gap',
        detail: generalComplexParse.payload ? formatPassRate(generalComplex) : generalComplexParse.issues.join('; ')
      },
    {
      area: 'workspace-workflow',
      status: workspaceWorkflow.status,
      detail: workspaceWorkflow.detail
    },
    {
      area: 'extensions-workflow',
      status: extensionsWorkflow.status,
      detail: extensionsWorkflow.detail
    },
    {
      area: 'skill-compatibility',
      status: skillCompatibility.status,
      detail: skillCompatibility.detail
    },
    {
      area: 'capability-hub',
      status: capabilityHub.status,
      detail: capabilityHub.detail
    },
    {
      area: 'provider-core',
      status: providerCore.status,
      detail: providerCore.detail
    },
    {
      area: 'permissions-hooks',
      status: permissionsHooks.status,
      detail: permissionsHooks.detail
    },
    {
      area: 'subagent-routing',
      status: subagentRouting.status,
      detail: subagentRouting.detail
    },
    {
      area: 'artifact_path_routing',
      status: artifactPathRouting.status,
      detail: artifactPathRouting.detail
    },
    {
      area: 'artifact_apply_flow',
      status: artifactApplyFlow.status,
      detail: artifactApplyFlow.detail
    },
    {
      area: 'real-task-completion',
      status: realTaskCompletion.status,
      detail: realTaskCompletion.detail
    },
    {
      area: 'public_capability_parity',
      status: publicCapabilityParity.status,
      detail: publicCapabilityParity.detail
    },
    {
      area: 'manual_artifact_audit',
      status: manualArtifactAudit.status,
      detail: manualArtifactAudit.detail
    },
    {
      area: 'practical_task_acceptance',
      status: practicalTaskAcceptance.status,
      detail: practicalTaskAcceptance.detail
    },
    {
      area: 'practical_manual_audit',
      status: practicalManualAudit.status,
      detail: practicalManualAudit.detail
    },
    {
      area: 'live_practical_task_acceptance',
      status: livePracticalTaskAcceptance.status,
      detail: livePracticalTaskAcceptance.detail
    },
    {
      area: 'live_practical_manual_audit',
      status: livePracticalManualAudit.status,
      detail: livePracticalManualAudit.detail
    },
    {
      area: 'live_provider_usage_accounting',
      status: liveProviderUsageAccounting.status,
      detail: liveProviderUsageAccounting.detail
    },
    {
      area: 'cli_web_interaction',
      status: cliWebInteraction.status,
      detail: cliWebInteraction.detail
    },
    {
      area: 'interaction_e2e',
      status: interactionE2E.status,
      detail: interactionE2E.detail
    },
    {
      area: 'cli_interaction_transcript',
      status: cliInteractionTranscript.status,
      detail: cliInteractionTranscript.detail
    },
    {
      area: 'runtime_stress_validation',
      status: runtimeStressValidation.status,
      detail: runtimeStressValidation.detail
    },
    {
      area: 'ecommerce_delivery',
      status: ecommerceDelivery.status,
      detail: ecommerceDelivery.detail
    },
    {
      area: 'ecommerce_readiness',
      status: ecommerceReadiness.status,
      detail: ecommerceReadiness.detail
    },
    {
      area: 'long-running-reliability',
      status: longRunningReliability.status,
      detail: longRunningReliability.detail
    },
    {
      area: 'interaction-consistency',
      status: interactionConsistency.status,
      detail: interactionConsistency.detail
    },
    {
      area: 'frontend-smoke',
      status: frontendSmokeStatus,
      detail: 'frontend smoke run completed against an isolated local stack'
    }
  ];
  const enhancedValidation = [
    {
      area: 'realistic-benchmark',
      status: benchmarkParse.payload && realisticBenchmark?.tokenReductionTargetSatisfied ? 'achieved' : 'open_gap',
      detail: realisticBenchmark
        ? `tokenReductionRatio=${realisticBenchmark.tokenReductionRatio}, likelyBottleneck=${realisticBenchmark.likelyBottleneck}`
        : (benchmarkParse.issues.join('; ') || 'missing benchmark result')
    },
    {
      area: 'postgres-validation',
      status: postgresStatus.status,
      detail: `category=${postgresStatus.category}, ${postgresStatus.reason}`
    },
    {
      area: 'provider-hardening',
      status: providerHardening.status,
      detail: `mode=${providerHardening.mode}, ${providerHardening.reason}`
    },
    {
      area: 'recovery-churn',
      status: recoveryChurn.status,
      detail: recoveryChurn.reason
    },
    {
      area: 'live-provider-scenarios',
      status: liveProviderParse.payload ? liveProviderModeToStatus(liveProviderProfile.mode) : 'open_gap',
      detail: !liveProviderParse.payload
        ? liveProviderParse.issues.join('; ')
        : `mode=${liveProviderProfile.mode}, reason=${liveProviderProfile.reason}, passRate=${liveProvider.totals?.passed ?? 0}/${liveProvider.totals?.total ?? 0}, artifactQualityPassRate=${liveProvider.totals?.artifactQualityPassRate ?? 0}`
    },
    {
      area: 'artifact-evidence',
      status: !liveProviderParse.payload
        ? 'open_gap'
        : liveProviderProfile.mode === 'disabled'
        ? 'external_blocker'
        : liveProviderProfile.mode === 'enabled-but-failed'
        ? 'open_gap'
        : 'advisory',
      detail: !liveProviderParse.payload
        ? liveProviderParse.issues.join('; ')
        : `mode=${liveProviderProfile.mode}, artifactQualityPassRate=${liveProvider.totals?.artifactQualityPassRate ?? 0}, byFamily=${JSON.stringify(liveProvider.totals?.byFamily ?? {})}`
    }
  ];
  const flagshipEvidenceBar = [
    ...enhancedValidation.filter((entry) =>
      entry.area === 'live-provider-scenarios' || entry.area === 'artifact-evidence')
  ];
  const verdicts = [...engineeringFloor, ...enhancedValidation];

  const report = {
    generatedAt: new Date().toISOString(),
    profile: scorecardProfile,
    reportPath,
    passes: !failed,
    frontendBaseUrl,
    summary: {
      build: commands.find((result) => result.label === 'build')?.status === 0 ? 'passed' : 'failed',
      backendTests,
      repoHygiene,
      repoDelivery,
      workflowPassRate: workflowParse.payload ? formatPassRate(workflow) : 'parse_error',
      breadthPassRate: breadthParse.payload ? formatPassRate(breadth) : 'parse_error',
      flagshipPassRate: flagshipParse.payload ? formatPassRate(flagship) : 'parse_error',
      generalComplexPassRate: generalComplexParse.payload && generalComplex.totals ? `${generalComplex.totals.passed}/${generalComplex.totals.total}` : 'parse_error',
      realTaskCompletionPassRate: realTaskCompletionParse.payload && realTaskCompletionReport.totals ? `${realTaskCompletionReport.totals.passed}/${realTaskCompletionReport.totals.total}` : 'parse_error',
      publicCapabilityParityPassRate: publicCapabilityParityParse.payload && publicCapabilityParityReport.totals ? `${publicCapabilityParityReport.totals.passed}/${publicCapabilityParityReport.totals.total}` : 'parse_error',
      publicCapabilityParityReportPath,
      practicalTaskAcceptancePassRate: practicalTaskAcceptanceParse.payload && practicalTaskAcceptanceReport.totals ? `${practicalTaskAcceptanceReport.totals.passed}/${practicalTaskAcceptanceReport.totals.total}` : 'parse_error',
      practicalTaskAcceptanceReportPath,
      practicalManualAudit: practicalManualAuditParse.payload ? (practicalManualAuditReport.status ?? 'open_gap') : 'open_gap',
      practicalManualAuditReportPath,
      livePracticalTaskAcceptancePassRate: practicalLiveTaskAcceptanceParse.payload && practicalLiveTaskAcceptanceReport.totals ? `${practicalLiveTaskAcceptanceReport.totals.passed}/${practicalLiveTaskAcceptanceReport.totals.total}` : 'parse_error',
      livePracticalShipReadyPassRate: practicalLiveTaskAcceptanceParse.payload && practicalLiveTaskAcceptanceReport.totals ? practicalLiveTaskAcceptanceReport.totals.shipReadyPassRate : 0,
      practicalLiveTaskAcceptanceReportPath,
      livePracticalManualAudit: practicalLiveManualAuditParse.payload ? (practicalLiveManualAuditReport.status ?? 'open_gap') : 'open_gap',
      practicalLiveManualAuditReportPath,
      liveProviderUsageAccounting: liveProviderUsageAccounting.status,
      ecommerceDeliveryPassRate: ecommerceDeliveryParse.payload && ecommerceDeliveryReport.totals ? `${ecommerceDeliveryReport.totals.passed}/${ecommerceDeliveryReport.totals.total}` : 'parse_error',
      ecommerceDeliveryReportPath,
      ecommerceReadinessPassRate: ecommerceReadinessParse.payload && ecommerceReadinessReport.totals ? `${ecommerceReadinessReport.totals.passed}/${ecommerceReadinessReport.totals.total}` : 'parse_error',
      ecommerceReadinessReportPath,
      liveProviderPassRate: liveProviderParse.payload && liveProvider.totals ? `${liveProvider.totals.passed}/${liveProvider.totals.total}` : 'parse_error',
      realisticBenchmark: benchmarkParse.payload ? realisticBenchmark : null,
      frontendSmoke: smoke
        ? (smoke.status === 0 ? 'passed' : 'failed')
        : 'skipped_frontend_unreachable',
      frontendSmokeReportPath,
      frontendE2E:
        frontendE2ECommand?.status === 0 && frontendE2EReport?.passes === true && frontendE2EReportFresh
          ? 'passed'
          : 'failed',
      frontendE2EReportPath,
      postgresValidation: postgresStatus,
      postgresProfile: {
        profile: scorecardProfile,
        category: postgresStatus.category,
        reportPath
      },
      liveProviderProfile,
      providerHardening,
      recoveryChurn,
      flagshipEvidenceBar: {
        status: liveProviderModeToStatus(liveProviderProfile.mode),
        profileMode: liveProviderProfile.mode,
        artifactQualityPassRate: liveProvider.totals?.artifactQualityPassRate ?? 0,
        externalBlocker: liveProvider.externalBlocker ?? null,
        byFamily: liveProvider.totals?.byFamily ?? {}
      },
      generalComplex: {
        status: generalComplexParse.payload ? (generalComplex.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: generalComplex.totals?.artifactQualityPassRate ?? 0,
        byFamily: generalComplex.totals?.byFamily ?? {},
        byFailureCategory: generalComplex.totals?.byFailureCategory ?? {},
        parsingIssues: generalComplexParse.issues
      },
      realTaskCompletion: {
        status: realTaskCompletionParse.payload ? (realTaskCompletionReport.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: realTaskCompletionReport.totals?.artifactQualityPassRate ?? 0,
        byFamily: realTaskCompletionReport.totals?.byFamily ?? {},
        byFailureCategory: realTaskCompletionReport.totals?.byFailureCategory ?? {},
        parsingIssues: realTaskCompletionParse.issues
      },
      publicCapabilityParity: {
        status: publicCapabilityParityParse.payload ? (publicCapabilityParityReport.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: publicCapabilityParityReport.totals?.artifactQualityPassRate ?? 0,
        byBaseline: publicCapabilityParityReport.totals?.byBaseline ?? {},
        byFamily: publicCapabilityParityReport.totals?.byFamily ?? {},
        byFailureCategory: publicCapabilityParityReport.totals?.byFailureCategory ?? {},
        parsingIssues: publicCapabilityParityParse.issues
      },
      manualArtifactAudit: {
        status: manualArtifactAuditParse.payload ? (manualArtifactAuditReport.status ?? 'open_gap') : 'open_gap',
        passRate: manualArtifactAuditParse.payload && manualArtifactAuditReport.totals ? `${manualArtifactAuditReport.totals.passed}/${manualArtifactAuditReport.totals.total}` : 'parse_error',
        reportPath: manualArtifactAuditReportPath,
        parsingIssues: manualArtifactAuditParse.issues
      },
      practicalTaskAcceptance: {
        status: practicalTaskAcceptanceParse.payload ? (practicalTaskAcceptanceReport.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: practicalTaskAcceptanceReport.totals?.artifactQualityPassRate ?? 0,
        passRate: practicalTaskAcceptanceParse.payload && practicalTaskAcceptanceReport.totals ? `${practicalTaskAcceptanceReport.totals.passed}/${practicalTaskAcceptanceReport.totals.total}` : 'parse_error',
        reportPath: practicalTaskAcceptanceReportPath,
        byFamily: practicalTaskAcceptanceReport.totals?.byFamily ?? {},
        byFailureCategory: practicalTaskAcceptanceReport.totals?.byFailureCategory ?? {},
        parsingIssues: practicalTaskAcceptanceParse.issues
      },
      practicalManualAudit: {
        status: practicalManualAuditParse.payload ? (practicalManualAuditReport.status ?? 'open_gap') : 'open_gap',
        passRate: practicalManualAuditParse.payload && practicalManualAuditReport.totals ? `${practicalManualAuditReport.totals.passed}/${practicalManualAuditReport.totals.total}` : 'parse_error',
        reportPath: practicalManualAuditReportPath,
        parsingIssues: practicalManualAuditParse.issues
      },
      livePracticalTaskAcceptance: {
        status: practicalLiveTaskAcceptanceParse.payload ? (practicalLiveTaskAcceptanceReport.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: practicalLiveTaskAcceptanceReport.totals?.artifactQualityPassRate ?? 0,
        liveProviderPassRate: practicalLiveTaskAcceptanceReport.totals?.liveProviderPassRate ?? 0,
        shipReadyPassRate: practicalLiveTaskAcceptanceReport.totals?.shipReadyPassRate ?? 0,
        minorEditsNeededCount: practicalLiveTaskAcceptanceReport.totals?.minorEditsNeededCount ?? 0,
        criticalGapsCount: practicalLiveTaskAcceptanceReport.totals?.criticalGapsCount ?? 0,
        passRate: practicalLiveTaskAcceptanceParse.payload && practicalLiveTaskAcceptanceReport.totals ? `${practicalLiveTaskAcceptanceReport.totals.passed}/${practicalLiveTaskAcceptanceReport.totals.total}` : 'parse_error',
        reportPath: practicalLiveTaskAcceptanceReportPath,
        byFamily: practicalLiveTaskAcceptanceReport.totals?.byFamily ?? {},
        byFailureCategory: practicalLiveTaskAcceptanceReport.totals?.byFailureCategory ?? {},
        usageSourceCounts: practicalLiveTaskAcceptanceReport.totals?.usageSourceCounts ?? {},
        usageBreakdown: practicalLiveTaskAcceptanceReport.totals?.usageBreakdown ?? {},
        totalTokens: practicalLiveTaskAcceptanceReport.totals?.totalTokens ?? 0,
        parsingIssues: practicalLiveTaskAcceptanceParse.issues
      },
      livePracticalManualAudit: {
        status: practicalLiveManualAuditParse.payload ? (practicalLiveManualAuditReport.status ?? 'open_gap') : 'open_gap',
        passRate: practicalLiveManualAuditParse.payload && practicalLiveManualAuditReport.totals ? `${practicalLiveManualAuditReport.totals.passed}/${practicalLiveManualAuditReport.totals.total}` : 'parse_error',
        shipReadyPassRate: practicalLiveManualAuditReport.totals?.shipReadyPassRate ?? 0,
        minorEditsNeededCount: practicalLiveManualAuditReport.totals?.minorEditsNeededCount ?? 0,
        criticalGapsCount: practicalLiveManualAuditReport.totals?.criticalGapsCount ?? 0,
        reportPath: practicalLiveManualAuditReportPath,
        parsingIssues: practicalLiveManualAuditParse.issues
      },
      cliInteractionTranscript: {
        status: cliInteractionTranscriptParse.payload ? (cliInteractionTranscriptReport.status ?? 'open_gap') : 'open_gap',
        passRate: cliInteractionTranscriptParse.payload && cliInteractionTranscriptReport.totals ? `${cliInteractionTranscriptReport.totals.passed}/${cliInteractionTranscriptReport.totals.total}` : 'parse_error',
        reportPath: cliInteractionTranscriptReportPath,
        parsingIssues: cliInteractionTranscriptParse.issues
      },
      runtimeStressValidation: {
        status: runtimeStressValidationParse.payload ? (runtimeStressValidationReport.status ?? 'open_gap') : 'open_gap',
        passRate: runtimeStressValidationParse.payload && runtimeStressValidationReport.totals ? `${runtimeStressValidationReport.totals.passed}/${runtimeStressValidationReport.totals.total}` : 'parse_error',
        reportPath: runtimeStressValidationReportPath,
        parsingIssues: runtimeStressValidationParse.issues
      },
      ecommerceDelivery: {
        status: ecommerceDeliveryParse.payload ? (ecommerceDeliveryReport.status ?? 'open_gap') : 'open_gap',
        artifactQualityPassRate: ecommerceDeliveryReport.totals?.artifactQualityPassRate ?? 0,
        passRate: ecommerceDeliveryParse.payload && ecommerceDeliveryReport.totals ? `${ecommerceDeliveryReport.totals.passed}/${ecommerceDeliveryReport.totals.total}` : 'parse_error',
        reportPath: ecommerceDeliveryReportPath,
        byFamily: ecommerceDeliveryReport.totals?.byFamily ?? {},
        byFailureCategory: ecommerceDeliveryReport.totals?.byFailureCategory ?? {},
        parsingIssues: ecommerceDeliveryParse.issues
      },
      ecommerceReadiness: {
        status: ecommerceReadinessParse.payload ? (ecommerceReadinessReport.status ?? 'open_gap') : 'open_gap',
        passRate: ecommerceReadinessParse.payload && ecommerceReadinessReport.totals ? `${ecommerceReadinessReport.totals.passed}/${ecommerceReadinessReport.totals.total}` : 'parse_error',
        reportPath: ecommerceReadinessReportPath,
        byFamily: ecommerceReadinessReport.totals?.byFamily ?? {},
        byFailureCategory: ecommerceReadinessReport.totals?.byFailureCategory ?? {},
        parsingIssues: ecommerceReadinessParse.issues
      },
      manualAuditReportPath: manualArtifactAuditReportPath,
      practicalManualAuditReportPath,
      practicalTaskAcceptance,
      practicalManualAudit,
      livePracticalTaskAcceptance,
      livePracticalManualAudit,
      liveProviderUsageAccounting,
      workspaceWorkflow,
      extensionsWorkflow,
      skillCompatibility,
      providerCore,
      artifactPathRouting,
      artifactApplyFlow,
      permissionsHooks,
      subagentRouting,
      cliWebInteraction,
      interactionE2E,
      cliInteractionTranscript,
      runtimeStressValidation,
      realTaskCompletion,
      publicCapabilityParity,
      manualArtifactAudit,
      ecommerceDelivery,
      ecommerceReadiness,
      longRunningReliability,
      interactionConsistency,
      parsingIssues,
      engineering_floor: {
        status: summarizeAreaGroupStatus(engineeringFloor),
        areas: engineeringFloor
      },
      enhanced_validation: {
        status: summarizeAreaGroupStatus(enhancedValidation),
        areas: enhancedValidation
      }
    },
    engineering_floor: engineeringFloor,
    enhanced_validation: enhancedValidation,
    engineeringFloor,
    flagshipEvidenceBar,
    verdicts,
    commands: commands.map((result) => ({
      label: result.label,
      command: result.command,
      status: result.status
    })),
    parsingIssues,
    cleanup,
    postgres: {
      status: postgres.status,
      command: postgres.command,
      summary: postgresStatus,
      profile: {
        profile: scorecardProfile,
        reportPath
      }
    },
    liveProviderProfile,
    providerHardening,
    recoveryChurn,
    smoke: smoke
      ? {
        status: smoke.status,
        command: smoke.command
      }
      : {
        status: 'skipped',
        reason: `frontend not reachable at ${frontendBaseUrl}`
      },
    details: {
      workflow,
      breadth,
      flagship,
      generalComplex,
      realTaskCompletion: realTaskCompletionReport,
      publicCapabilityParity: publicCapabilityParityReport,
      manualArtifactAudit: manualArtifactAuditReport,
      practicalTaskAcceptance: practicalTaskAcceptanceReport,
      practicalManualAudit: practicalManualAuditReport,
      livePracticalTaskAcceptance: practicalLiveTaskAcceptanceReport,
      livePracticalManualAudit: practicalLiveManualAuditReport,
      ecommerceDelivery: ecommerceDeliveryReport,
      ecommerceReadiness: ecommerceReadinessReport,
      workspaceWorkflow,
      extensionsWorkflow,
      skillCompatibility,
      providerCore,
      permissionsHooks,
      subagentRouting,
      cliWebInteraction,
      interactionE2E,
      cliInteractionTranscript: cliInteractionTranscriptReport,
      runtimeStressValidation: runtimeStressValidationReport,
      realTaskCompletionSummary: realTaskCompletion,
      publicCapabilityParitySummary: publicCapabilityParity,
      manualArtifactAuditSummary: manualArtifactAudit,
      practicalTaskAcceptanceSummary: practicalTaskAcceptance,
      practicalManualAuditSummary: practicalManualAudit,
      livePracticalTaskAcceptanceSummary: livePracticalTaskAcceptance,
      livePracticalManualAuditSummary: livePracticalManualAudit,
      liveProviderUsageAccounting,
      ecommerceDeliverySummary: ecommerceDelivery,
      ecommerceReadinessSummary: ecommerceReadiness,
      longRunningReliability,
      interactionConsistency,
      frontendE2EReport,
      liveProviderProfile,
      liveProvider,
      benchmark,
      frontendSmokeReport,
      repoHygiene,
      repoDelivery
    }
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  if (publicCapabilityParityParse.payload) {
    await fs.writeFile(publicCapabilityParityReportPath, JSON.stringify(publicCapabilityParityReport, null, 2));
  }
  if (manualArtifactAuditParse.payload) {
    await fs.writeFile(manualArtifactAuditReportPath, JSON.stringify(manualArtifactAuditReport, null, 2));
  }
  if (practicalTaskAcceptanceParse.payload) {
    await fs.writeFile(practicalTaskAcceptanceReportPath, JSON.stringify(practicalTaskAcceptanceReport, null, 2));
  }
  if (practicalManualAuditParse.payload) {
    await fs.writeFile(practicalManualAuditReportPath, JSON.stringify(practicalManualAuditReport, null, 2));
  }
  if (practicalLiveTaskAcceptanceParse.payload) {
    await fs.writeFile(practicalLiveTaskAcceptanceReportPath, JSON.stringify(practicalLiveTaskAcceptanceReport, null, 2));
  }
  if (practicalLiveManualAuditParse.payload) {
    await fs.writeFile(practicalLiveManualAuditReportPath, JSON.stringify(practicalLiveManualAuditReport, null, 2));
  }
  if (benchmarkParse.payload) {
    await fs.writeFile(benchmarkReportPath, JSON.stringify(benchmark, null, 2));
  }
  if (cliInteractionTranscriptParse.payload) {
    await fs.writeFile(cliInteractionTranscriptReportPath, JSON.stringify(cliInteractionTranscriptReport, null, 2));
  }
  if (runtimeStressValidationParse.payload) {
    await fs.writeFile(runtimeStressValidationReportPath, JSON.stringify(runtimeStressValidationReport, null, 2));
  }
  if (ecommerceDeliveryParse.payload) {
    await fs.writeFile(ecommerceDeliveryReportPath, JSON.stringify(ecommerceDeliveryReport, null, 2));
  }
  if (ecommerceReadinessParse.payload) {
    await fs.writeFile(ecommerceReadinessReportPath, JSON.stringify(ecommerceReadinessReport, null, 2));
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (failed) {
    process.exit(failed.status || 1);
  }
  if (smoke && smoke.status !== 0) {
    process.exit(smoke.status || 1);
  }
  process.exit(report.passes ? 0 : 1);
}

const currentScriptPath = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(currentScriptPath)
  : false;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}

export {
  isBlockingScorecardCommandFailure,
  isFreshReport,
  loadSuiteFromCommandOrReport,
  parseReportFile,
  parseReportTimestamp,
  summarizeAreaGroupStatus,
  summarizeCliWebInteraction,
  summarizeInteractionE2E,
  summarizeLiveProviderUsageAccounting
};
