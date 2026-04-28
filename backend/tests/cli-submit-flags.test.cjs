const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTaskPayloadFromFlags } = require('../dist/interfaces/cli/shared.js');

test('buildTaskPayloadFromFlags preserves execution profile from CLI flags', () => {
  const payload = buildTaskPayloadFromFlags({
    positionals: [],
    flags: {
      title: 'Flag-based task',
      intent: 'Check CLI submit flag wiring.',
      role: 'Operator',
      goal: 'Check CLI submit flag wiring.',
      'execution-profile': 'implement',
      'output-contract': '{"summary":"string","artifact":"string"}'
    }
  });

  assert.equal(payload.units[0].executionProfileId, 'implement');
});
