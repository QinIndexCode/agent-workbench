const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBackendNewFoundation,
  createBackendNewRuntime
} = require('../dist');

function createTempRoot(prefix = 'backend-new-profile-inference-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('task submission infers execution profiles and preserves explicit profile ids', async () => {
  const rootDir = createTempRoot();
  const foundation = createBackendNewFoundation({
    config: {
      paths: {
        rootDir
      }
    }
  });
  const runtime = createBackendNewRuntime({ foundation });

  try {
    const submitted = await runtime.tasks.submitTask({
      title: 'profile inference smoke test',
      intent: 'Verify default execution profiles on ordinary task submission.',
      preferredProviderId: null,
      units: [
        {
          id: 'AGENT-001',
          role: 'Requirements Analyst',
          goal: 'Capture requirements and constraints',
          dependencies: []
        },
        {
          id: 'AGENT-002',
          role: 'Implementation Worker',
          goal: 'Write and apply the requested artifact changes',
          dependencies: ['AGENT-001']
        },
        {
          id: 'AGENT-003',
          role: 'Final Verifier',
          goal: 'Validate the produced artifact and confirm completion',
          dependencies: ['AGENT-002']
        },
        {
          id: 'AGENT-004',
          role: 'Manual override',
          goal: 'Keep the explicit profile unchanged',
          executionProfileId: 'analyze',
          dependencies: ['AGENT-002']
        }
      ]
    });

    const byId = Object.fromEntries(submitted.task.definition.units.map((unit) => [unit.id, unit.executionProfileId]));

    assert.equal(byId['AGENT-001'], 'analyze');
    assert.equal(byId['AGENT-002'], 'implement');
    assert.equal(byId['AGENT-003'], 'verify');
    assert.equal(byId['AGENT-004'], 'analyze');
  } finally {
    await runtime.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
