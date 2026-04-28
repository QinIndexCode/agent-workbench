import {
  ExplicitOutputEnvelope,
  ProgressTracker,
  RuntimeTaskMemoryState,
  UserPreferenceProfile
} from '../contracts/types';

const DEFAULT_PROFILE_ID = 'default';
const MAX_MEMORY_ITEMS = 6;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function isSystemGeneratedCorrectionPrompt(value: string): boolean {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (
    normalized.startsWith('Return machine-readable JSON tool call objects first.')
    || normalized.startsWith('Return only one valid tracker JSON block')
    || normalized.startsWith('Emit the required tool action evidence in this turn')
    || normalized.startsWith('Return one corrected explicit output block')
    || normalized.startsWith('Resolve the pending correction for the current unit now')
  ) {
    return true;
  }
  return normalized.includes('If the runtime requires a tracker')
    && normalized.includes('Do not emit')
    && (
      normalized.includes('write_file')
      || normalized.includes('run_command')
      || normalized.includes('output contract')
    );
}

function dedupeAndCap(values: string[], limit = MAX_MEMORY_ITEMS): string[] {
  return Array.from(new Set(values.map(value => compactWhitespace(value)).filter(Boolean))).slice(0, limit);
}

function mostlyChinese(text: string): boolean {
  const chineseChars = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return chineseChars >= Math.max(4, Math.ceil(text.length * 0.15));
}

function detectLanguage(text: string): string | null {
  if (!text.trim()) {
    return null;
  }
  if (mostlyChinese(text) || /中文|汉语|普通话/.test(text)) {
    return 'zh-CN';
  }
  if (/[A-Za-z]/.test(text)) {
    return 'en';
  }
  return null;
}

function detectResponseStyle(text: string): string | null {
  if (/简洁|简短|精简|简明|少废话|concise|brief/i.test(text)) {
    return 'concise';
  }
  if (/详细|展开|完整|深入|细一点|detailed|verbose/i.test(text)) {
    return 'detailed';
  }
  return null;
}

function extractWorkflowPreferences(text: string): string[] {
  const preferences: string[] = [];
  if (/(?:cli|命令行)/i.test(text)) {
    preferences.push('cli-first');
  }
  if (/前端我来|不用管前端|front[- ]?end.*我来/i.test(text)) {
    preferences.push('frontend-user-owned');
  }
  if (/后端|backend/i.test(text)) {
    preferences.push('backend-focused');
  }
  if (/自动记忆|memory|长期记忆/i.test(text)) {
    preferences.push('persistent-memory');
  }
  return preferences;
}

function extractHabits(text: string): string[] {
  const habits: string[] = [];
  if (/云端模型|cloud model|remote model/i.test(text)) {
    habits.push('prefers cloud-hosted models over local models');
  }
  if (/127\.0\.0\.1/.test(text)) {
    habits.push('expects local proxy endpoints to bridge remote services');
  }
  if (/测试|验证|smoke/i.test(text)) {
    habits.push('expects end-to-end verification after changes');
  }
  return habits;
}

function summarizeOutput(output: ExplicitOutputEnvelope): string | null {
  if (!output.parsedJson || typeof output.parsedJson !== 'object') {
    return null;
  }
  const parsedRecord = output.parsedJson as Record<string, unknown>;
  const summary = typeof parsedRecord.summary === 'string'
    ? truncate(compactWhitespace(parsedRecord.summary), 140)
    : null;
  if (summary) {
    return `${output.unitId}: ${summary}`;
  }
  const keys = Object.keys(parsedRecord).slice(0, 5);
  if (keys.length === 0) {
    return null;
  }
  return `${output.unitId}: output keys ${keys.join(', ')}`;
}

export function createEmptyUserPreferenceProfile(now = Date.now()): UserPreferenceProfile {
  return {
    profileId: DEFAULT_PROFILE_ID,
    preferredLanguage: null,
    responseStyle: null,
    modelPreference: null,
    workflowPreferences: [],
    notableHabits: [],
    lastUpdatedAt: now
  };
}

export function evolveUserPreferenceProfile(params: {
  current: UserPreferenceProfile | null;
  userMessage?: string;
  selectedProviderId?: string | null;
  now?: number;
}): UserPreferenceProfile {
  const now = params.now ?? Date.now();
  const current = params.current ?? createEmptyUserPreferenceProfile(now);
  const userMessage = params.userMessage?.trim() ?? '';
  const preferredLanguage = detectLanguage(userMessage) ?? current.preferredLanguage;
  const responseStyle = detectResponseStyle(userMessage) ?? current.responseStyle;
  const modelPreference = /cloud/i.test(params.selectedProviderId ?? '') || /云端/.test(userMessage)
    ? 'cloud'
    : (current.modelPreference ?? null);

  return {
    profileId: current.profileId || DEFAULT_PROFILE_ID,
    preferredLanguage,
    responseStyle,
    modelPreference,
    workflowPreferences: dedupeAndCap([
      ...current.workflowPreferences,
      ...extractWorkflowPreferences(userMessage)
    ]),
    notableHabits: dedupeAndCap([
      ...current.notableHabits,
      ...extractHabits(userMessage)
    ]),
    lastUpdatedAt: now
  };
}

export function createPreferenceSnapshot(profile: UserPreferenceProfile | null): string[] {
  if (!profile) {
    return [];
  }
  const lines: string[] = [];
  if (profile.preferredLanguage) {
    lines.push(`preferred language: ${profile.preferredLanguage}`);
  }
  if (profile.responseStyle) {
    lines.push(`response style: ${profile.responseStyle}`);
  }
  if (profile.modelPreference) {
    lines.push(`model preference: ${profile.modelPreference}`);
  }
  for (const workflow of profile.workflowPreferences) {
    lines.push(`workflow preference: ${workflow}`);
  }
  for (const habit of profile.notableHabits) {
    lines.push(`habit: ${habit}`);
  }
  return dedupeAndCap(lines);
}

export function evolveTaskMemory(params: {
  current: RuntimeTaskMemoryState | null;
  userMessage?: string;
  acceptedTracker?: ProgressTracker | null;
  acceptedOutput?: ExplicitOutputEnvelope | null;
  selectedProviderId?: string | null;
  userProfile: UserPreferenceProfile | null;
  now?: number;
}): RuntimeTaskMemoryState {
  const now = params.now ?? Date.now();
  const current = params.current ?? {
    latestUserIntent: null,
    lastUserMessageAt: null,
    keyMilestones: [],
    importantDecisions: [],
    userPreferenceSnapshot: []
  };
  const normalizedUserMessage = params.userMessage?.trim() ?? '';
  const trackUserIntent = normalizedUserMessage && !isSystemGeneratedCorrectionPrompt(normalizedUserMessage);
  const latestUserIntent = trackUserIntent
    ? truncate(compactWhitespace(normalizedUserMessage), 180)
    : current.latestUserIntent;
  const trackerMilestone = params.acceptedTracker
    ? `${params.acceptedTracker.currentUnit}: ${params.acceptedTracker.status} (${truncate(compactWhitespace(params.acceptedTracker.reason), 100)})`
    : null;
  const outputMilestone = params.acceptedOutput ? summarizeOutput(params.acceptedOutput) : null;
  const decision = params.acceptedTracker
    ? `${params.acceptedTracker.currentUnit}: ${params.acceptedTracker.decision}${params.acceptedTracker.nextUnit ? ` -> ${params.acceptedTracker.nextUnit}` : ''}`
    : null;
  const providerDecision = params.selectedProviderId
    ? `active provider: ${params.selectedProviderId}`
    : null;

  return {
    latestUserIntent,
    lastUserMessageAt: trackUserIntent ? now : current.lastUserMessageAt,
    keyMilestones: dedupeAndCap([
      ...(outputMilestone ? [outputMilestone] : []),
      ...(trackerMilestone ? [trackerMilestone] : []),
      ...current.keyMilestones
    ]),
    importantDecisions: dedupeAndCap([
      ...(decision ? [decision] : []),
      ...(providerDecision ? [providerDecision] : []),
      ...current.importantDecisions
    ]),
    userPreferenceSnapshot: createPreferenceSnapshot(params.userProfile)
  };
}
