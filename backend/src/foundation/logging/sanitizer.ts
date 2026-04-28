import { BackendNewLoggingConfig } from '../config/types';

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[truncated]`;
}

function sanitizeValue(
  value: unknown,
  config: BackendNewLoggingConfig,
  keyHint = ''
): unknown {
  if (typeof value === 'string') {
    const limit = /prompt|response|history|content/i.test(keyHint)
      ? config.longTextLimit
      : config.shortTextLimit;
    return truncate(value, limit);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, config.maxObjectEntries)
      .map(item => sanitizeValue(item, config, keyHint));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record).slice(0, config.maxObjectEntries)) {
      sanitized[key] = sanitizeValue(nestedValue, config, key);
    }
    return sanitized;
  }

  return value;
}

export function sanitizeLogDetails(
  details: Record<string, unknown>,
  config: BackendNewLoggingConfig
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = sanitizeValue(value, config, key);
  }
  return sanitized;
}
