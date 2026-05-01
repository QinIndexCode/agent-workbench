const test = require('node:test');
const assert = require('node:assert/strict');

const {
  protectOperatorGuidanceForCorrection
} = require('../dist/application/tasks/turns/operator-guidance');

test('operator guidance cannot weaken output-correction requirements', () => {
  const protectedMessage = protectOperatorGuidanceForCorrection(
    'Return only one valid tracker JSON block for the current unit.',
    'AWAITING_OUTPUT_CORRECTION'
  );

  assert.match(protectedMessage, /Pending runtime correction: AWAITING_OUTPUT_CORRECTION/);
  assert.match(protectedMessage, /cannot remove or weaken the runtime correction contract/);
  assert.match(protectedMessage, /ignore that narrowing/i);
  assert.match(protectedMessage, /corrected explicit output block followed by one tracker JSON block/i);
  assert.match(protectedMessage, /Return only one valid tracker JSON block/);
});

test('operator guidance remains plain when no correction is pending', () => {
  assert.equal(
    protectOperatorGuidanceForCorrection('  Continue normally.  ', 'NONE'),
    'Continue normally.'
  );
});
