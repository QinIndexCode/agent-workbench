import { TaskDefinition } from '../../domain/contracts/types';

const TASK_PATTERN_STOPWORDS = new Set([
  'task',
  'tasks',
  'agent',
  'operator',
  'assistant',
  'generalist',
  'workflow',
  'create',
  'build',
  'make',
  'use',
  'using',
  'with',
  'from',
  'into',
  'that',
  'this',
  'same',
  'another',
  'more',
  'your',
  'their',
  'will',
  'just',
  'then',
  'than'
]);

function normalizeTaskPatternKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))];
}

function tokenizeTaskPatternText(value: string | null | undefined): string[] {
  return Array.from(new Set(
    (value ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 3 && !TASK_PATTERN_STOPWORDS.has(entry))
  ));
}

function extractOutputContractKeysFromDefinition(definition: TaskDefinition): string[] {
  const outputContract = definition.units[0]?.outputContract;
  if (!outputContract || typeof outputContract !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(outputContract);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return Object.keys(parsed)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .slice(0, 6);
  } catch {
    return [];
  }
}

function extractStableTaskPatternTokensFromDefinition(definition: TaskDefinition): string[] {
  const unit = definition.units[0];
  return dedupeStrings([
    ...tokenizeTaskPatternText(unit?.goal),
    definition.units.length > 1 ? `units-${definition.units.length}` : null
  ])
    .sort()
    .slice(0, 6);
}

export function getTaskPatternKeyFromDefinition(definition: TaskDefinition): string {
  const unit = definition.units[0];
  const unitRole = unit?.role ?? 'task';
  const executionProfileId = unit?.executionProfileId ?? 'analyze';
  const outputContractKeys = extractOutputContractKeysFromDefinition(definition);
  const artifactExpectation = outputContractKeys.includes('artifact') ? 'artifact' : 'no-artifact';
  const semanticTokens = extractStableTaskPatternTokensFromDefinition(definition);
  return normalizeTaskPatternKey([
    unitRole,
    executionProfileId,
    artifactExpectation,
    ...semanticTokens
  ].join('-'));
}
