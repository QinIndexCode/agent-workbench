import { ToolErrorKind } from './types';

function normalizeMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'Unknown tool error');
}

export function classifyToolError(error: unknown): ToolErrorKind {
  const message = normalizeMessage(error).toLowerCase();
  if (/schema|invalid|required|argument|validation/.test(message)) {
    return 'VALIDATION';
  }
  if (/permission|forbidden|unauthori[sz]ed|denied/.test(message)) {
    return 'PERMISSION';
  }
  if (/not found|missing|enoent/.test(message)) {
    return 'NOT_FOUND';
  }
  if (/timeout|timed out|deadline/.test(message)) {
    return 'TIMEOUT';
  }
  if (/rate limit|too many requests|429/.test(message)) {
    return 'RATE_LIMIT';
  }
  if (/exec|spawn|command failed|runtime/.test(message)) {
    return 'EXECUTION';
  }
  return 'UNKNOWN';
}
