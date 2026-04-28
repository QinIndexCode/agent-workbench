function collectVerificationCommandText(argumentsRecord: Record<string, unknown>): string {
  const candidates = [
    argumentsRecord.command,
    argumentsRecord.cmd
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return candidates.join('\n').toLowerCase();
}

export function shouldMarkInvocationAsVerification(input: {
  toolName: string;
  argumentsRecord: Record<string, unknown>;
}): boolean {
  const normalizedToolName = input.toolName.trim().toLowerCase().replace(/-/g, '_');
  if ((/^(?:read|search|list|grep|query|inspect|verify|test|check|fetch|diff|stat|ls|find|cat)(?:_|$)/.test(normalizedToolName)
    || /(?:_|^)(?:read|search|list|grep|query|inspect|verify|test|check|fetch|diff|stat|ls|find|cat)$/.test(normalizedToolName)
    || /(^|_)(read|search|list|grep|query|inspect|verify|test|check|fetch|diff|stat|ls|find|cat)(_|$)/.test(normalizedToolName))) {
    return true;
  }
  if (normalizedToolName !== 'run_command') {
    return false;
  }

  const commandText = collectVerificationCommandText(input.argumentsRecord);
  return [
    /\b(get-process|get-service|get-ciminstance|test-connection|tasklist|systeminfo|wmic)\b/i,
    /\b(mysql(?:\.exe)?|mysqladmin)\b/i,
    /\b(?:npm|pnpm|yarn|bun)\s+test\b/i,
    /\b(?:pytest|jest|vitest|go test|cargo test|mvn test|gradle test)\b/i,
    /--version\b/i,
    /\bverify\b/i,
    /\bvalidation\b/i,
    /\bcheck\b/i,
    /\binspect\b/i,
    /\bhealth\b/i
  ].some((pattern) => pattern.test(commandText));
}
