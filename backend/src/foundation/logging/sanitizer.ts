import { BackendNewLoggingConfig } from '../config/types';

const MAX_SANITIZER_DEPTH = 8;
const SENSITIVE_KEY_PATTERN = /api[-_ ]?key|authorization|bearer|secret|token|password|credential|connection[-_ ]?string/i;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[truncated]`;
}

function sanitizeValue(
  value: unknown,
  config: BackendNewLoggingConfig,
  keyHint = '',
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return '[redacted]';
  }

  if (typeof value === 'string') {
    const limit = /prompt|response|history|content/i.test(keyHint)
      ? config.longTextLimit
      : config.shortTextLimit;
    return truncate(value, limit);
  }

  if (depth >= MAX_SANITIZER_DEPTH) {
    return '[max_depth]';
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, config.maxObjectEntries)
      .map(item => sanitizeValue(item, config, keyHint, seen, depth + 1));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record).slice(0, config.maxObjectEntries)) {
      sanitized[key] = sanitizeValue(nestedValue, config, key, seen, depth + 1);
    }
    seen.delete(value);
    return sanitized;
  }

  return value;
}

export function sanitizeLogDetails(
  details: Record<string, unknown>,
  config: BackendNewLoggingConfig
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  seen.add(details);
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = sanitizeValue(value, config, key, seen);
  }
  return sanitized;
}
