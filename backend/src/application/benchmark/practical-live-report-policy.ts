import { PracticalLiveTaskAcceptanceSuiteResult } from './practical-task-acceptance';

export interface PracticalLiveReportReuseOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  maxAgeMs?: number;
}

export function isReusablePracticalLiveReport(
  report: PracticalLiveTaskAcceptanceSuiteResult | undefined,
  options: PracticalLiveReportReuseOptions = {}
): boolean {
  if (!report || !Array.isArray(report.scenarios)) {
    return false;
  }

  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  const generatedAt = typeof report.generatedAt === 'number'
    ? report.generatedAt
    : typeof report.generatedAt === 'string'
      ? Date.parse(report.generatedAt)
      : NaN;

  if (!Number.isFinite(generatedAt) || generatedAt < now - maxAgeMs) {
    return false;
  }

  const expectedProfile = env.SCORECARD_PROFILE?.trim() || 'default';
  if ((report.profile ?? 'default') !== expectedProfile) {
    return false;
  }

  const expectedProviderId = env.BACKEND_NEW_LIVE_PROVIDER_ID?.trim();
  if (expectedProviderId && report.provider?.providerId !== expectedProviderId) {
    return false;
  }

  const expectedModel = env.BACKEND_NEW_LIVE_PROVIDER_MODEL?.trim();
  if (expectedModel && report.provider?.model !== expectedModel) {
    return false;
  }

  const liveProviderEnabled = env.BACKEND_NEW_LIVE_PROVIDER_ENABLED?.trim();
  if (liveProviderEnabled === '1' && !report.provider && report.status !== 'external_blocker') {
    return false;
  }

  return true;
}
