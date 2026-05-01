const test = require('node:test');
const assert = require('node:assert/strict');
const { evolveTaskMemory } = require('../dist/domain/runtime/memory');

test('evolveTaskMemory keeps real user intent when later correction prompt is machine-generated', () => {
  const first = evolveTaskMemory({
    current: null,
    userMessage: 'Design a grounded project scaffold and keep the result honest.',
    selectedProviderId: 'test-openai-compatible-provider',
    userProfile: null,
    now: 100,
  });

  const second = evolveTaskMemory({
    current: first,
    userMessage: 'Return machine-readable JSON tool call objects first. No explicit output and no prose. Emit write_file calls for these exact paths in this turn: workspace-demo/design/README.md.',
    selectedProviderId: 'test-openai-compatible-provider',
    userProfile: null,
    now: 200,
  });

  assert.equal(second.latestUserIntent, first.latestUserIntent);
  assert.equal(second.lastUserMessageAt, first.lastUserMessageAt);
});

test('evolveTaskMemory still records ordinary user follow-up messages', () => {
  const first = evolveTaskMemory({
    current: null,
    userMessage: 'Review the current system audit and fix the report drift.',
    selectedProviderId: 'test-openai-compatible-provider',
    userProfile: null,
    now: 100,
  });

  const second = evolveTaskMemory({
    current: first,
    userMessage: 'Continue, but focus on the artifact audit mismatch.',
    selectedProviderId: 'test-openai-compatible-provider',
    userProfile: null,
    now: 200,
  });

  assert.equal(second.latestUserIntent, 'Continue, but focus on the artifact audit mismatch.');
  assert.equal(second.lastUserMessageAt, 200);
});
