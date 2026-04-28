import fs from 'node:fs/promises';
import path from 'node:path';

export function resolveLiveCostProbeReportPath(rootDir = process.cwd()) {
  return path.resolve(rootDir, '.codex-run', 'logs', 'live-cost-probe.json');
}

function resolveExpectedProviderTruth(env = process.env) {
  return {
    providerId: 'xiaomi-mimo-v2-flash',
    model: env.XIAOMI_MIMO_LIVE_MODEL?.trim() || 'mimo-v2.5',
  };
}

export function resolveLiveCostGuardConfig(env = process.env) {
  const readPositiveInteger = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    maxApiCalls: readPositiveInteger(env.LIVE_COST_MAX_API_CALLS),
    maxTotalTokens: readPositiveInteger(env.LIVE_COST_MAX_TOTAL_TOKENS)
  };
}

export async function readLiveCostProbeReport(rootDir = process.cwd()) {
  const reportPath = resolveLiveCostProbeReportPath(rootDir);
  const raw = await fs.readFile(reportPath, 'utf8');
  return {
    reportPath,
    report: JSON.parse(raw)
  };
}

function validateProbeReportShape(report) {
  return Boolean(
    report
    && typeof report === 'object'
    && typeof report.generatedAt === 'string'
    && report.provider
    && typeof report.provider === 'object'
    && typeof report.provider.providerId === 'string'
    && typeof report.provider.model === 'string'
    && report.promptBudget
    && typeof report.promptBudget === 'object'
    && typeof report.promptBudget.stablePrefixChars === 'number'
    && typeof report.promptBudget.volatileSuffixChars === 'number'
    && typeof report.promptBudget.stablePrefixRatio === 'number'
    && report.usage
    && typeof report.usage === 'object'
    && typeof report.usage.apiCalls === 'number'
    && typeof report.usage.totalTokens === 'number'
    && typeof report.cacheTelemetryStatus === 'string'
  );
}

function classifyProbeFailure(report) {
  const issueText = Array.isArray(report?.issues) ? report.issues.join(' ; ') : '';
  const errorText = report?.error && typeof report.error === 'object'
    ? `${report.error.message ?? ''} ${report.error.cause?.message ?? ''}`
    : '';
  const combined = `${issueText} ${errorText}`.toLowerCase();
  if (
    report?.dns?.hasReservedAddress === true
    && Number(report?.usage?.apiCalls ?? 0) <= 0
  ) {
    return 'provider_endpoint_resolves_to_reserved_address';
  }

  if (!combined.trim()) {
    return null;
  }
  if (/ssl\/tls|handshake failure|tls alert|eproto|illegal_message/.test(combined)) {
    return 'provider_tls_handshake_failed';
  }
  if (/certificate|unable to verify the first certificate|self signed/.test(combined)) {
    return 'provider_certificate_verification_failed';
  }
  if (/timed out|timeout|408/.test(combined)) {
    return 'provider_timeout';
  }
  return null;
}

export async function evaluateLiveCostGuard(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const label = params.label ?? 'live-command';
  const env = params.env ?? process.env;
  const maxReportAgeMs = params.maxReportAgeMs ?? (6 * 60 * 60 * 1000);
  const config = resolveLiveCostGuardConfig(env);

  if (config.maxApiCalls === null && config.maxTotalTokens === null) {
    return {
      status: 'disabled',
      blocked: false,
      label,
      reason: 'limits_not_configured'
    };
  }

  let probe;
  let reportPath = resolveLiveCostProbeReportPath(rootDir);
  try {
    probe = await readLiveCostProbeReport(rootDir);
    reportPath = probe.reportPath;
  } catch (error) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: `missing_probe_report:${error instanceof Error ? error.message : String(error)}`
    };
  }

  const report = probe.report;
  if (!validateProbeReportShape(report)) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: 'report_contract_drift'
    };
  }

  const generatedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedAt) || (Date.now() - generatedAt) > maxReportAgeMs) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: 'probe_report_stale'
    };
  }

  const expectedProvider = resolveExpectedProviderTruth(env);
  if (report.provider.providerId !== expectedProvider.providerId || report.provider.model !== expectedProvider.model) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: 'provider_truth_mismatch'
    };
  }

  const probeFailure = classifyProbeFailure(report);
  if (probeFailure) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: `environment_blocker:${probeFailure}`
    };
  }

  if (report.usage.apiCalls <= 0 || report.usage.totalTokens <= 0) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: 'usage_accounting_missing'
    };
  }

  if (report.promptBudget.stablePrefixChars <= 0 || report.promptBudget.stablePrefixRatio <= 0) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: 'stable_prefix_metrics_missing'
    };
  }

  if (report.cacheTelemetryStatus !== 'reported' && report.cacheTelemetryStatus !== 'provider_cache_telemetry_unavailable') {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: `cache_telemetry_invalid:${report.cacheTelemetryStatus}`
    };
  }

  if (config.maxApiCalls !== null && report.usage.apiCalls > config.maxApiCalls) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: `api_call_budget_exceeded:${report.usage.apiCalls}>${config.maxApiCalls}`
    };
  }

  if (config.maxTotalTokens !== null && report.usage.totalTokens > config.maxTotalTokens) {
    return {
      status: 'cost_guard_blocked',
      blocked: true,
      label,
      reportPath,
      reason: `token_budget_exceeded:${report.usage.totalTokens}>${config.maxTotalTokens}`
    };
  }

  return {
    status: 'ok',
    blocked: false,
    label,
    reportPath,
    reason: 'probe_valid',
    limits: config,
    usage: report.usage,
    cacheTelemetryStatus: report.cacheTelemetryStatus
  };
}

export async function assertLiveCostGuard(params = {}) {
  const evaluation = await evaluateLiveCostGuard(params);
  if (evaluation.blocked) {
    throw new Error(`cost_guard_blocked:${evaluation.reason}${evaluation.reportPath ? ` (${evaluation.reportPath})` : ''}`);
  }
  return evaluation;
}
