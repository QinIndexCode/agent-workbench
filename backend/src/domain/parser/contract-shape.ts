const KEY_PATTERNS = [
  /["']([A-Za-z_][\w-]*)["']\s*:/g,
  /(?:^|[{,]\s*)([A-Za-z_][\w-]*)\s*:/g
];

export function parseContractObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
  }

  try {
    const relaxed = input
      .replace(/'/g, '"')
      .replace(/(\w+):/g, '"$1":');
    const parsed = JSON.parse(relaxed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
  }

  return null;
}

export function extractContractKeys(contract: string): string[] {
  const direct = parseContractObject(contract);
  if (direct) {
    return Object.keys(direct);
  }

  const keys = new Set<string>();
  for (const pattern of KEY_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(contract)) !== null) {
      const key = match[1]?.trim();
      if (key) {
        keys.add(key);
      }
    }
  }

  return Array.from(keys);
}
