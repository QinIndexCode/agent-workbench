const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptStageTurn,
  acceptParsedTurn,
  evaluateBatchAdmission,
  orchestrateTurn,
  parseTurn,
  selectTaskMemoryForPrompt,
  selectValidatedOutputsForPrompt,
  validateStageSemanticContract,
  validateTaskDefinitionPreflight
} = require('../dist');
const {
  mapFallbackTurnOutcome
} = require('../dist/application/tasks/turns/turn-outcome-mapper.js');

test('acceptParsedTurn accepts valid explicit output and tracker for current unit', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[] }[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.failureCategory, null);
  assert.equal(result.acceptedOutput.unitId, 'AGENT-001');
  assert.equal(result.acceptedTracker.currentUnit, 'AGENT-001');
});

test('fallback turn outcome treats accepted tool responses that only miss tracker as in-progress tool steps', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"I will inspect the input before finalizing."}[/AGENT-001_OUTPUT]\n'
    + '{"tool":"read_file","arguments":{"path":"inputs/a.md"}}'
  );

  const outcome = mapFallbackTurnOutcome({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string"}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 0,
    },
    plannedTools: {
      acceptedInvocationIds: ['tool_1'],
      approvalInvocationIds: [],
      rejected: [],
    },
    runtime: {
      pendingToolBatches: [],
      consolidationState: {
        status: 'IDLE',
        stageIndex: null,
        lastCompletedAt: null,
        lastResult: null,
        lastIssueCodes: [],
      },
    },
  });

  assert.equal(outcome.orchestrated.acceptance.ok, true);
  assert.equal(outcome.orchestrated.acceptance.pendingCorrection, 'NONE');
  assert.equal(outcome.acceptedTrackers.length, 1);
  assert.equal(outcome.acceptedTrackers[0].status, 'IN_PROGRESS');
  assert.equal(outcome.acceptedTrackers[0].decision, 'CONTINUE');
});

test('parseTurn recovers the first explicit output JSON object when providers omit the closing output wrapper before tool calls', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]\n'
    + '{"summary":"brief files queued","details":"Read the grounded brief files; next turn writes the design docs.","producedFiles":[],"issues":[]}\n\n'
    + '{"tool":"read_file","arguments":{"path":"brief/workload-profile.md"}}\n'
    + '{"tool":"read_file","arguments":{"path":"brief/mysql-targets.md"}}\n'
    + '{"tool":"read_file","arguments":{"path":"brief/constraints.md"}}\n\n'
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":20,"decision":"CONTINUE","reason":"Read the grounded brief files; next turn will write the design docs.","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.explicitOutputs.length, 1);
  assert.deepEqual(parsed.explicitOutputs[0].parsedJson, {
    summary: 'brief files queued',
    details: 'Read the grounded brief files; next turn writes the design docs.',
    producedFiles: [],
    issues: []
  });
  assert.equal(parsed.toolCalls.length, 3);
  assert.equal(parsed.trackers.length, 1);

  const accepted = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 3
    }
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.pendingCorrection, 'NONE');
  assert.equal(accepted.acceptedTracker.currentUnit, 'AGENT-001');
});

test('acceptParsedTurn demands output correction when contract keys are missing', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok"}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
  assert.equal(result.failureCategory, 'output_contract_mismatch');
  assert.match(result.issues[0].message, /contract key "issues"/);
});

test('acceptParsedTurn demands output correction when contract value types are wrong', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","risks":"none"}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","risks":["string"]}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
  assert.equal(result.failureCategory, 'output_contract_mismatch');
  assert.match(result.issues[0].message, /must be array/);
});

test('acceptParsedTurn demands tracker correction when output is valid but tracker is missing', () => {
  const parsed = parseTurn(
    '<AGENT-001_OUTPUT>{"summary":"ok","issues":[]}</AGENT-001_OUTPUT>'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TRACKER');
  assert.equal(result.failureCategory, 'tracker_missing_after_valid_output');
  assert.match(result.issues[0].message, /Missing progress tracker/);
  assert.equal(result.acceptedOutput.unitId, 'AGENT-001');
});

test('acceptParsedTurn accepts tracker-only correction when a prior accepted output is available', () => {
  const parsed = parseTurn(
    '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":["scratch/live-review-handoff.md"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","artifact":"string","details":"string","issues":[]}',
    exitCondition: '{"artifact":"required"}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: ['scratch/live-review-handoff.md']
    },
    correctionContext: {
      pendingCorrection: 'AWAITING_TRACKER',
      priorAcceptedOutput: {
        unitId: 'AGENT-001',
        wrapper: 'square',
        raw: '[AGENT-001_OUTPUT]{"summary":"Created artifact","artifact":"scratch/live-review-handoff.md","details":"ready","issues":[]}[/AGENT-001_OUTPUT]',
        parsedJson: {
          summary: 'Created artifact',
          artifact: 'scratch/live-review-handoff.md',
          details: 'ready',
          issues: []
        }
      },
      priorContractKeys: ['summary', 'artifact', 'details', 'issues']
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.failureCategory, null);
  assert.equal(result.acceptedOutput.parsedJson.artifact, 'scratch/live-review-handoff.md');
  assert.equal(result.acceptedTracker.currentUnit, 'AGENT-001');
});

test('acceptParsedTurn normalizes common completion decision aliases', () => {
  for (const decision of ['COMPLETE', 'COMPLETED', 'DONE', 'FINISH', 'FINISHED', 'STOP', 'TERMINATE']) {
    const parsed = parseTurn(
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
      + `{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"${decision}","reason":"done","next_unit":null,"files_created":[]}`
    );

    const result = acceptParsedTurn({
      currentUnitId: 'AGENT-001',
      parsed,
      outputContract: '{"summary":"string","issues":[]}'
    });

    assert.equal(result.ok, true, `expected decision alias ${decision} to be accepted`);
    assert.equal(result.pendingCorrection, 'NONE');
    assert.equal(result.acceptedTracker.decision, 'CONTINUE');
  }
});

test('acceptParsedTurn enforces structured exit conditions before accepting completion', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}',
    exitCondition: '{"report":"required"}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
  assert.equal(result.failureCategory, 'exit_condition_mismatch');
  assert.match(result.issues[0].message, /exit condition/i);
  assert.deepEqual(result.exitCondition.requiredOutputKeys, ['report']);
  assert.equal(result.exitCondition.failureCategory, 'OUTPUT');
});

test('acceptParsedTurn rejects early terminate when downstream required work remains', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"EARLY_TERMINATE","reason":"analysis done","next_unit":null,"files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}',
    trackerPolicy: {
      allowEarlyTerminate: false
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TRACKER');
  assert.equal(result.failureCategory, 'provider_style_incompatibility');
  assert.equal(result.acceptedOutput.unitId, 'AGENT-001');
  assert.match(result.issues[0].message, /EARLY_TERMINATE/i);
});

test('acceptParsedTurn rejects COMPLETE tracker when progress is not full', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"partial work","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":80,"decision":"CONTINUE","reason":"still need the remaining module batch next turn","next_unit":null,"files_created":["workspace-demo/prototype/src/processor.js"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TRACKER');
  assert.match(result.issues.map((issue) => issue.code).join(','), /tracker_complete_requires_full_progress|tracker_complete_reason_conflict/);
});

test('acceptParsedTurn rejects tracker with blank reason', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":40,"decision":"CONTINUE","reason":"","next_unit":null,"files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TRACKER');
  assert.match(result.issues[0].message, /non-empty reason/i);
});

test('parseTurn normalizes natural terminate tracker aliases as ordinary completion', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"TERMINATE","reason":"done","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].decision, 'CONTINUE');
});

test('parseTurn keeps explicit EARLY_TERMINATE for pruning semantics', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"EARLY_TERMINATE","reason":"intentionally stop downstream work","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].decision, 'EARLY_TERMINATE');
});

test('parseTurn normalizes waiting-style tracker aliases into supported statuses', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"pending tool evidence","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"WAITING_FOR_TOOL","progress_percent":15,"decision":"CONTINUE","reason":"need tool","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].status, 'PARTIAL');
});

test('parseTurn normalizes WAITING_TOOL trackers into supported statuses', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"pending tool evidence","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"WAITING_TOOL","progress_percent":15,"decision":"CONTINUE","reason":"need tool","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].status, 'PARTIAL');
});

test('parseTurn normalizes waiting approval tracker aliases into supported statuses', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"waiting for operator approval","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"WAITING_APPROVAL","progress_percent":50,"decision":"CONTINUE","reason":"awaiting approval","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].status, 'PARTIAL');
});

test('parseTurn normalizes blocked tracker aliases from live providers into supported values', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"blocked on approval","artifact":"release-checklist.md","details":"waiting for gated write approval","issues":["approval pending"]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"BLOCKED","progress_percent":90,"decision":"WAIT","reason":"write_file approval pending","next_unit":null,"files_created":[]}'
  );

  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].status, 'PARTIAL');
  assert.equal(parsed.trackers[0].decision, 'CONTINUE');
});

test('parseTurn recognizes paired tool_invocation xml envelopes with attribute arguments', () => {
  const parsed = parseTurn(
    '<tool_invocation name="write_file" arguments={"path":"release_checklist.md","content":"# Release Checklist\\n"}></tool_invocation>\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"write completed","next_unit":null,"files_created":["release_checklist.md"]}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.deepEqual(parsed.toolCalls[0].parameters, {
    path: 'release_checklist.md',
    content: '# Release Checklist\n'
  });
  assert.equal(parsed.toolCalls[0].source, 'xml');
});

test('acceptParsedTurn rejects implement completion when tool evidence is required but missing', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 0
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'tool_action_required_but_not_emitted');
  assert.equal(result.acceptedOutput.unitId, 'AGENT-002');
  assert.match(result.issues[0].message, /must emit at least one real tool action/i);
});

test('acceptParsedTurn rejects verify completion when explicit output appears before same-turn verification tool results', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"brief inspected","details":"Found the requested constraint.","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"tool":"read_file","arguments":{"path":"briefing/live-provider-brief.md"}}\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","issues":[]}',
    trackerPolicy: {
      profileId: 'verify',
      requireToolEvidence: true,
      requireVerificationEvidence: true,
      emittedToolEvidenceCount: 1,
      emittedVerificationEvidenceCount: 1
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
  assert.equal(result.failureCategory, 'response_shape_mismatch');
  assert.match(result.issues[0].message, /same turn/i);
});

test('acceptParsedTurn reuses the prior accepted output for tool-action corrections when the new turn emits tool calls and a tracker only', () => {
  const parsed = parseTurn(
    '{"tool":"write_file","arguments":{"path":"workspace-demo/prototype/package.json","content_json":{"name":"workspace-demo-prototype","private":true}}}\n'
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":45,"decision":"CONTINUE","reason":"package manifest written","next_unit":null,"files_created":["workspace-demo/prototype/package.json"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
    correctionContext: {
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      priorAcceptedOutput: {
        unitId: 'AGENT-001',
        wrapper: 'square',
        raw: '{"summary":"prototype scaffold in progress","details":"design docs finished","producedFiles":["workspace-demo/design/README.md"],"issues":[]}',
        parsedJson: {
          summary: 'prototype scaffold in progress',
          details: 'design docs finished',
          producedFiles: ['workspace-demo/design/README.md'],
          issues: []
        }
      },
      priorContractKeys: ['summary', 'details', 'producedFiles', 'issues']
    },
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.acceptedOutput.unitId, 'AGENT-001');
  assert.equal(result.acceptedTracker.status, 'IN_PROGRESS');
});

test('acceptParsedTurn prefers artifact-write correction over generic tool-action correction for implement artifacts', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":["src/math.cjs"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 0,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: []
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'artifact_write_required_but_not_emitted');
  assert.match(result.issues[0].message, /matching write evidence/i);
});

test('acceptParsedTurn allows analyze-style completion when tool evidence is not required', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"analysis complete","issues":[],"report":"ready"}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-002","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[],"report":"string"}',
    trackerPolicy: {
      requireToolEvidence: false,
      emittedToolEvidenceCount: 0
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.failureCategory, null);
});

test('acceptParsedTurn allows implement completion when the unit already has historical tool evidence', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.failureCategory, null);
});

test('acceptParsedTurn rejects parent-only progress when required delegation evidence is missing', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"parent drafted work","details":"still working","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":35,"decision":"CONTINUE","reason":"parent started writing without delegation","next_unit":"AGENT-001","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","issues":[]}',
    trackerPolicy: {
      requireDelegationEvidence: true,
      emittedDelegationEvidenceCount: 0
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'required_delegation_missing');
  assert.match(result.issues[0].message, /delegate_subtask/i);
});

test('acceptParsedTurn allows progress once required delegation evidence exists', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"child launched","details":"waiting on child","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"PARTIAL","progress_percent":45,"decision":"CONTINUE","reason":"delegated child launched","next_unit":"AGENT-001","files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","issues":[]}',
    trackerPolicy: {
      requireDelegationEvidence: true,
      emittedDelegationEvidenceCount: 1
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
  assert.equal(result.failureCategory, null);
});

test('acceptParsedTurn rejects implement completion when declared artifact lacks matching write evidence', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":["src/math.cjs"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      profileId: 'implement',
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: []
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'artifact_write_required_but_not_emitted');
  assert.match(result.issues[0].message, /src\/math\.cjs/);
});

test('acceptParsedTurn demands output correction when explicit artifact claim mismatches write evidence', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":["src/other-file.cjs"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      profileId: 'implement',
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: ['src/other-file.cjs']
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_OUTPUT_CORRECTION');
  assert.equal(result.failureCategory, 'response_shape_mismatch');
  assert.equal(result.issues[0].code, 'declared_artifact_path_mismatch');
  assert.match(result.issues[0].message, /src\/math\.cjs/);
  assert.match(result.issues[0].message, /src\/other-file\.cjs/);
});

test('acceptParsedTurn demands tool action when only a parent directory was created for declared artifacts', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"deliverables/launch-plan.md, deliverables/launch-faq.md","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":["deliverables/launch-plan.md","deliverables/launch-faq.md"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      profileId: 'implement',
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: ['deliverables']
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'artifact_write_required_but_not_emitted');
  assert.equal(result.issues[0].code, 'artifact_write_required_but_not_emitted');
  assert.match(result.issues[0].message, /deliverables\/launch-plan\.md/);
  assert.match(result.issues[0].message, /deliverables\/launch-faq\.md/);
});

test('acceptParsedTurn accepts implement completion when declared artifact has matching write evidence', () => {
  const parsed = parseTurn(
    '[AGENT-002_OUTPUT]{"summary":"implemented","issues":[],"artifact":"src/math.cjs","report":"updated"}[/AGENT-002_OUTPUT]\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":["src/math.cjs"]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-002',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      profileId: 'implement',
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireArtifactWriteEvidence: true,
      emittedWriteEvidencePaths: ['src/math.cjs']
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pendingCorrection, 'NONE');
});

test('acceptParsedTurn rejects verify completion when verification evidence is missing', () => {
  const parsed = parseTurn(
    '[AGENT-003_OUTPUT]{"summary":"verified","issues":[],"artifact":"src/math.cjs","report":"checked"}[/AGENT-003_OUTPUT]\n'
    + '{"current_unit":"AGENT-003","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":[]}'
  );

  const result = acceptParsedTurn({
    currentUnitId: 'AGENT-003',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    trackerPolicy: {
      profileId: 'verify',
      requireToolEvidence: true,
      emittedToolEvidenceCount: 1,
      requireVerificationEvidence: true,
      emittedVerificationEvidenceCount: 0
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.failureCategory, 'tool_action_required_but_not_emitted');
  assert.match(result.issues[0].message, /verification action/i);
});

test('parseTurn recognizes provider-style tool_code envelopes', () => {
  const parsed = parseTurn(
    '<tool_code><tool_name>write_file</tool_name><tool_args>{"path":"src/math.cjs","content":"module.exports = { add };"}<\/tool_args><\/tool_code>\n'
    + '<tool_code><tool_name>run_command</tool_name><tool_args>{"command":"npm test"}<\/tool_args><\/tool_code>\n'
    + '{"current_unit":"AGENT-002","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":"AGENT-003","files_created":["src/math.cjs"]}'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.toolCalls.map((call) => call.toolName), ['write_file', 'run_command']);
  assert.equal(parsed.toolCalls[0].parameters.path, 'src/math.cjs');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
});

test('parseTurn recognizes xml tool_call envelopes that use file_path and file_content aliases', () => {
  const parsed = parseTurn(
    '<tool_call>\n'
      + '<tool_name>write_file</tool_name>\n'
      + '<tool_input>\n'
      + '<file_path>docs/checklist.md</file_path>\n'
      + '<file_content># Checklist</file_content>\n'
      + '</tool_input>\n'
      + '</tool_call>\n'
      + '<tool_call>\n'
      + '<tool_name>read_file</tool_name>\n'
      + '<tool_input>\n'
      + '<file_path>docs/checklist.md</file_path>\n'
      + '</tool_input>\n'
      + '</tool_call>'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.toolCalls.map((call) => call.toolName), ['write_file', 'read_file']);
  assert.equal(parsed.toolCalls[0].parameters.path, 'docs/checklist.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Checklist');
  assert.equal(parsed.toolCalls[1].parameters.path, 'docs/checklist.md');
});

test('parseTurn recognizes colon-style square tool envelopes', () => {
  const parsed = parseTurn(
    '[TOOL: write_file] {"file_path":"tests/number.test.cjs","content":"fixed"} [/TOOL]\n'
    + '[TOOL: run_command] {"command":"npm test"} [/TOOL]'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.toolCalls.map((call) => call.toolName), ['write_file', 'run_command']);
  assert.equal(parsed.toolCalls[0].parameters.path, 'tests/number.test.cjs');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
});

test('parseTurn recognizes provider json tool calls that use command plus args aliases', () => {
  const parsed = parseTurn(
    '{"command":"run_command","args":{"cmd":"Get-Process","working_directory":"store"}}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'Get-Process');
  assert.equal(parsed.toolCalls[0].parameters.cwd, 'store');
});

test('parseTurn expands top-level tool_calls arrays and unwraps PowerShell command wrappers', () => {
  const parsed = parseTurn(
    '```json\n'
    + '{\n'
    + '  "tool_calls": [\n'
    + '    {\n'
    + '      "tool": "run_command",\n'
    + '      "args": {\n'
    + '        "command": "powershell",\n'
    + '        "args": ["-Command", "Get-Process | Select-Object -First 5 ProcessName,CPU"]\n'
    + '      }\n'
    + '    },\n'
    + '    {\n'
    + '      "tool": "read_file",\n'
    + '      "args": {\n'
    + '        "path": "store/db.js"\n'
    + '      }\n'
    + '    }\n'
    + '  ]\n'
    + '}\n'
    + '```'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'Get-Process | Select-Object -First 5 ProcessName,CPU');
  assert.equal(parsed.toolCalls[1].toolName, 'read_file');
  assert.equal(parsed.toolCalls[1].parameters.path, 'store/db.js');
});

test('validateTaskDefinitionPreflight rejects cyclic dependencies', () => {
  const result = validateTaskDefinitionPreflight({
    taskId: 'task_cycle',
    title: 'Cycle',
    intent: 'Detect cycle',
    preferredProviderId: null,
    createdAt: 1,
    metadata: {},
    units: [
      { id: 'AGENT-001', role: 'A', goal: 'A', dependencies: ['AGENT-002'] },
      { id: 'AGENT-002', role: 'B', goal: 'B', dependencies: ['AGENT-001'] }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === 'cyclic_dependency'), true);
});

test('selectValidatedOutputsForPrompt narrows visible outputs using inputContract within allowed scope', () => {
  const result = selectValidatedOutputsForPrompt({
    definition: {
      taskId: 'task_scope',
      title: 'Scope',
      intent: 'Scope outputs',
      preferredProviderId: null,
      createdAt: 1,
      metadata: {},
      units: [
        { id: 'AGENT-001', role: 'A', goal: 'A', dependencies: [] },
        { id: 'AGENT-002', role: 'B', goal: 'B', dependencies: [] },
        {
          id: 'AGENT-003',
          role: 'C',
          goal: 'C',
          permissionLevel: 'GLOBAL',
          inputContract: 'Only use AGENT-001 output.',
          dependencies: []
        }
      ]
    },
    currentUnit: {
      id: 'AGENT-003',
      role: 'C',
      goal: 'C',
      permissionLevel: 'GLOBAL',
      inputContract: 'Only use AGENT-001 output.',
      dependencies: []
    },
    records: [
      { taskId: 'task_scope', unitId: 'AGENT-001', turnId: 'turn_1', parsed: { summary: 'alpha' } },
      { taskId: 'task_scope', unitId: 'AGENT-002', turnId: 'turn_2', parsed: { summary: 'beta' } }
    ]
  });

  assert.deepEqual(result.records.map((record) => record.unitId), ['AGENT-001']);
  assert.equal(result.policyFilteredOutputCount, 1);
});

test('selectValidatedOutputsForPrompt applies structured key selectors from inputContract', () => {
  const result = selectValidatedOutputsForPrompt({
    definition: {
      taskId: 'task_scope_keys',
      title: 'Scope Keys',
      intent: 'Scope output keys',
      preferredProviderId: null,
      createdAt: 1,
      metadata: {},
      units: [
        { id: 'AGENT-001', role: 'A', goal: 'A', dependencies: [] },
        {
          id: 'AGENT-002',
          role: 'B',
          goal: 'B',
          permissionLevel: 'GLOBAL',
          inputContract: '{"units":["AGENT-001"],"outputKeys":{"AGENT-001":["summary"]}}',
          dependencies: []
        }
      ]
    },
    currentUnit: {
      id: 'AGENT-002',
      role: 'B',
      goal: 'B',
      permissionLevel: 'GLOBAL',
      inputContract: '{"units":["AGENT-001"],"outputKeys":{"AGENT-001":["summary"]}}',
      dependencies: []
    },
    records: [
      {
        taskId: 'task_scope_keys',
        unitId: 'AGENT-001',
        turnId: 'turn_1',
        parsed: { summary: 'alpha', issues: ['warn'], details: 'verbose' }
      }
    ]
  });

  assert.deepEqual(result.records[0].parsed, { summary: 'alpha' });
});

test('validateTaskDefinitionPreflight rejects structured inputContract references to unknown units', () => {
  const result = validateTaskDefinitionPreflight({
    taskId: 'task_unknown_input_ref',
    title: 'Unknown Input Ref',
    intent: 'Detect unknown unit references',
    preferredProviderId: null,
    createdAt: 1,
    metadata: {},
    units: [
      {
        id: 'AGENT-001',
        role: 'A',
        goal: 'A',
        inputContract: '{"units":["AGENT-404"]}',
        dependencies: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === 'input_contract_unknown_unit'), true);
});

test('validateTaskDefinitionPreflight rejects invalid structured memory kind selectors', () => {
  const result = validateTaskDefinitionPreflight({
    taskId: 'task_invalid_memory_kind',
    title: 'Invalid Memory Kind',
    intent: 'Detect invalid memory selectors',
    preferredProviderId: null,
    createdAt: 1,
    metadata: {},
    units: [
      {
        id: 'AGENT-001',
        role: 'A',
        goal: 'A',
        inputContract: '{"memoryKinds":["MILESTONE","NOT_A_KIND"]}',
        dependencies: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === 'input_contract_invalid_memory_kind'), true);
});

test('selectTaskMemoryForPrompt applies structured memory selectors and global memory switch', () => {
  const result = selectTaskMemoryForPrompt({
    definition: {
      taskId: 'task_memory_scope',
      title: 'Memory Scope',
      intent: 'Scope memory',
      preferredProviderId: null,
      createdAt: 1,
      metadata: {},
      units: [
        { id: 'AGENT-001', role: 'A', goal: 'A', dependencies: [] },
        { id: 'AGENT-002', role: 'B', goal: 'B', dependencies: [] },
        {
          id: 'AGENT-003',
          role: 'C',
          goal: 'C',
          permissionLevel: 'GLOBAL',
          inputContract: '{"memoryUnits":["AGENT-001"],"memoryKinds":["MILESTONE"],"includeGlobalMemory":false}',
          dependencies: []
        }
      ]
    },
    currentUnit: {
      id: 'AGENT-003',
      role: 'C',
      goal: 'C',
      permissionLevel: 'GLOBAL',
      inputContract: '{"memoryUnits":["AGENT-001"],"memoryKinds":["MILESTONE"],"includeGlobalMemory":false}',
      dependencies: []
    },
    memory: {
      latestUserIntent: 'Scope memory',
      lastUserMessageAt: null,
      keyMilestones: ['AGENT-001:alpha', 'AGENT-002:beta', 'global milestone'],
      importantDecisions: ['AGENT-001:choose-a', 'global decision'],
      userPreferenceSnapshot: []
    }
  });

  assert.deepEqual(result.keyMilestones, ['AGENT-001:alpha']);
  assert.deepEqual(result.importantDecisions, []);
});

test('parseTurn extracts json and xml tool calls without confusing them with outputs', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","name":"report","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","tool_name":"search_files","arguments":{"pattern":"TODO","limit":3}}\n'
    + '<tool unit="AGENT-002" name="write_file">{"path":"report.md","content":"hello"}</tool>'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].unitId, 'AGENT-001');
  assert.equal(parsed.toolCalls[0].toolName, 'search_files');
  assert.equal(parsed.toolCalls[0].parameters.pattern, 'TODO');
  assert.equal(parsed.toolCalls[0].source, 'json');
  assert.equal(parsed.toolCalls[1].unitId, 'AGENT-002');
  assert.equal(parsed.toolCalls[1].toolName, 'write_file');
  assert.equal(parsed.toolCalls[1].parameters.path, 'report.md');
  assert.equal(parsed.toolCalls[1].source, 'xml');
});

test('parseTurn accepts live-provider tool-call wrappers and argument aliases', () => {
  const parsed = parseTurn(
    '[TOOL_CALL] {"tool":"write_file","args":{"file":"report.md","content":"hello"}} [/TOOL_CALL]\n'
    + '[TOOL_CALL] <tool name="run_command"><command>npm test</command></tool> [/TOOL_CALL]'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'report.md');
  assert.equal(parsed.toolCalls[0].parameters.content, 'hello');
  assert.equal(parsed.toolCalls[1].toolName, 'run_command');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
});

test('parseTurn accepts alternate provider tool wrappers and nested xml args', () => {
  const parsed = parseTurn(
    '[TOOL] {"tool":"read_file","file_path":"reports/diagnosis.md"} [/TOOL]\n'
    + '[TOOL_CALL] <tool><name>run_command</name><args><command>npm test</command></args></tool> [/TOOL_CALL]\n'
    + '<read_file><path>tests/number.test.cjs</path></read_file>'
  );

  assert.equal(parsed.toolCalls.length, 3);
  assert.equal(parsed.toolCalls[0].toolName, 'read_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'reports/diagnosis.md');
  assert.equal(parsed.toolCalls[1].toolName, 'run_command');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
  assert.equal(parsed.toolCalls[2].toolName, 'read_file');
  assert.equal(parsed.toolCalls[2].parameters.path, 'tests/number.test.cjs');
});

test('parseTurn accepts bare xml tool tags with json bodies from live providers', () => {
  const parsed = parseTurn(
    '<delegate_subtask>{"title":"Delegated note draft","role":"SubSccAgent","goal":"Draft a scoped note.","allowedToolIds":["write-file"]}</delegate_subtask>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'delegate_subtask');
  assert.equal(parsed.toolCalls[0].parameters.title, 'Delegated note draft');
  assert.equal(parsed.toolCalls[0].parameters.role, 'SubSccAgent');
  assert.deepEqual(parsed.toolCalls[0].parameters.allowedToolIds, ['write-file']);
  assert.equal(parsed.toolCalls[0].source, 'xml');
});

test('parseTurn accepts invoke-style xml tool wrappers with named args', () => {
  const parsed = parseTurn(
    '[TOOL_CALL] <invoke name="write_file"><arg name="path">src/slugify.cjs</arg><arg name="content">module.exports = { slugify };</arg></invoke> [/TOOL_CALL]\n'
    + '[TOOL_CALL] <invoke name="run_command"><arg name="command">npm test</arg></invoke> [/TOOL_CALL]'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'src/slugify.cjs');
  assert.equal(parsed.toolCalls[0].parameters.content, 'module.exports = { slugify };');
  assert.equal(parsed.toolCalls[1].toolName, 'run_command');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
});

test('parseTurn accepts self-closing tool_invocation wrappers with json arguments', () => {
  const parsed = parseTurn(
    '<tool_invocation name="read_file" arguments={"path":"briefing/live-provider-brief.md"} />\n'
    + '<tool_invocation name="run_command" arguments={"command":"npm test","cwd":"backend"} />'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].toolName, 'read_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'briefing/live-provider-brief.md');
  assert.equal(parsed.toolCalls[1].toolName, 'run_command');
  assert.equal(parsed.toolCalls[1].parameters.command, 'npm test');
  assert.equal(parsed.toolCalls[1].parameters.cwd, 'backend');
});

test('parseTurn accepts bare tool_invocation open tags when providers omit the closing wrapper', () => {
  const parsed = parseTurn(
    '<tool_invocation name="write_file" arguments={"path":"release_checklist.md","content":"# Release Checklist\\n"}>\n'
    + '[AGENT-001_OUTPUT]{"summary":"done","artifact":"release_checklist.md","details":"saved","issues":[]}[/AGENT-001_OUTPUT]'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Release Checklist\n');
});

test('parseTurn accepts eof-terminated tool_invocation tags when providers omit the final angle bracket', () => {
  const parsed = parseTurn(
    '<tool_invocation name="write_file" arguments={"path":"release_checklist_v2.md","content":"# Release Checklist v2\\n\\n> Reusable template\\n"}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist_v2.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Release Checklist v2\n\n> Reusable template\n');
});

test('parseTurn accepts self-closing tool_invocation wrappers when json arguments contain markdown blockquotes', () => {
  const parsed = parseTurn(
    '<tool_invocation name="write_file" arguments={"path":"release_checklist.md","content":"# Release Checklist\\n\\n> Reusable checklist\\n\\n- [ ] Ship it"} />'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.match(parsed.toolCalls[0].parameters.content, /> Reusable checklist/);
});

test('parseTurn accepts xml tool_call wrappers that use tool_name and tool_arguments json payloads', () => {
  const parsed = parseTurn(
    '<tool_call><tool_name>write_file</tool_name><tool_arguments>{"path":"release_checklist.md","content":"# Release Checklist\\n\\n> Reusable checklist\\n\\n- [ ] Ship it"}</tool_arguments></tool_call>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.match(parsed.toolCalls[0].parameters.content, /> Reusable checklist/);
});

test('parseTurn accepts xml tool_call wrappers that use tool_name and tool_input fields', () => {
  const parsed = parseTurn(
    '<tool_call><tool_name>write_file</tool_name><tool_input><path>release_checklist.md</path><content># Release Checklist</content></tool_input></tool_call>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Release Checklist');
});

test('parseTurn accepts xml tool_call wrappers that use function_name and parameter tags', () => {
  const parsed = parseTurn(
    '<tool_call>\n'
    + '<function_name>write_file</function_name>\n'
    + '<parameters>\n'
    + '<parameter name="path">release_checklist.md</parameter>\n'
    + '<parameter name="content"># Release Checklist</parameter>\n'
    + '</function>\n'
    + '</tool_call>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Release Checklist');
});

test('parseTurn accepts xml tool_call wrappers that use function= and parameter= shorthand tags', () => {
  const parsed = parseTurn(
    '<tool_call>\n'
    + '<function=write_file>\n'
    + '<parameter=path>release_checklist.md</parameter>\n'
    + '<parameter=content># Release Checklist</parameter>\n'
    + '</function>\n'
    + '</tool_call>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'release_checklist.md');
  assert.equal(parsed.toolCalls[0].parameters.content, '# Release Checklist');
});

test('parseTurn preserves invoke content with embedded html as a string instead of nested fake tool calls', () => {
  const parsed = parseTurn(
    '<invoke name="write_file"><arg name="path">D:\\AAA\\index.html</arg><arg name="content"><!DOCTYPE html><html lang="en"><head><title>Blog</title></head><body><main><h1>Hello</h1></main></body></html></arg></invoke>'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'D:\\AAA\\index.html');
  assert.equal(typeof parsed.toolCalls[0].parameters.content, 'string');
  assert.match(parsed.toolCalls[0].parameters.content, /<!DOCTYPE html>/);
  assert.match(parsed.toolCalls[0].parameters.content, /<body>/);
});

test('parseTurn normalizes provider tool aliases such as run_shell into registered tool names', () => {
  const parsed = parseTurn(
    '[TOOL] <run_shell><command>npm test</command></run_shell> [/TOOL]'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'npm test');
});

test('parseTurn normalizes execute_command aliases into the canonical run_command tool name', () => {
  const parsed = parseTurn(
    '[TOOL_CALL] {"tool":"execute_command","arguments":{"command":"npm test","cwd":"backend"}} [/TOOL_CALL]'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'npm test');
  assert.equal(parsed.toolCalls[0].parameters.cwd, 'backend');
});

test('orchestrateTurn blocks completion when any tool call was rejected during validation', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"implemented","issues":[],"artifact":"reports/checklist.md","report":"done"}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":["reports/checklist.md"]}'
  );

  const result = orchestrateTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
    plannedTools: {
      acceptedInvocationIds: ['tool_1'],
      approvalInvocationIds: [],
      rejectedToolCalls: ['write_file: XML tool wrappers are not allowed for the current JSON-only provider policy. Emit a canonical JSON tool object instead.']
    }
  });

  assert.equal(result.acceptance.ok, false);
  assert.equal(result.acceptance.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.acceptance.failureCategory, 'tool_action_required_but_not_emitted');
  assert.equal(result.acceptance.issues[0].code, 'invalid_tool_protocol');
});

test('parseTurn flags malformed JSON tool objects instead of silently accepting later tools only', () => {
  const parsed = parseTurn(
    'Creating files now.\n'
    + '{"tool":"write_file","arguments":{"path":"D:\\\\AAA\\\\index.html","content":"<span class="broken">bad</span>"}}\n'
    + '{"tool":"write_file","arguments":{"path":"reports/web-audit.json","content_json":{"profile":"web_experience"}}}\n'
    + '[AGENT-001_OUTPUT]{"summary":"done","details":"claimed","artifactDestination":"D:\\\\AAA","issues":[]}[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","next_unit":null,"files_created":["D:\\\\AAA\\\\index.html"]}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].parameters.path, 'reports/web-audit.json');
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /invalid_tool_json/);

  const result = orchestrateTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
    plannedTools: {
      acceptedInvocationIds: [],
      approvalInvocationIds: [],
      rejectedToolCalls: parsed.warnings
    }
  });

  assert.equal(result.acceptance.ok, false);
  assert.equal(result.acceptance.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.acceptance.issues.some((issue) => issue.code === 'invalid_tool_request'), true);

  const noTrackerResult = orchestrateTurn({
    currentUnitId: 'AGENT-001',
    parsed: parseTurn(
      '{"tool":"write_file","arguments":{"path":"docs/a.md","content":"# A"}}\n'
      + '{"tool":"write_file","arguments":{"path":"docs/b.md","content":"bad "quote"}}'
    ),
    outputContract: '{"summary":"string","details":"string","issues":[]}',
    plannedTools: {
      acceptedInvocationIds: [],
      approvalInvocationIds: [],
      rejectedToolCalls: ['invalid_tool_json: detected malformed write_file JSON']
    }
  });
  assert.equal(noTrackerResult.acceptance.ok, false);
  assert.equal(noTrackerResult.acceptance.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(noTrackerResult.acceptance.failureCategory, 'tool_action_required_but_not_emitted');
  assert.equal(noTrackerResult.acceptance.issues[0].code, 'invalid_tool_request');
});

test('parseTurn repairs markdown bullet leakage inside write_file content_lines arrays', () => {
  const parsed = parseTurn(
    '{"tool":"write_file","arguments":{"path":"notes/plan.md","content_lines":["# Plan","",- "Overview","",- "Next step"]}}\n'
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":60,"decision":"CONTINUE","reason":"wrote plan","next_unit":null,"files_created":["notes/plan.md"]}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'notes/plan.md');
  assert.deepEqual(parsed.toolCalls[0].parameters.content_lines, ['# Plan', '', 'Overview', '', 'Next step']);
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.trackers.length, 1);
});

test('parseTurn repairs quoted comma separator leakage inside write_file content_lines arrays', () => {
  const parsed = parseTurn(
    '{"tool":"write_file","arguments":{"path":"notes/plan.md","content_lines":["# Plan","Intro.",","## Next","done"]}}\n'
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":60,"decision":"CONTINUE","reason":"wrote plan","next_unit":null,"files_created":["notes/plan.md"]}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'write_file');
  assert.equal(parsed.toolCalls[0].parameters.path, 'notes/plan.md');
  assert.deepEqual(parsed.toolCalls[0].parameters.content_lines, ['# Plan', 'Intro.', '## Next', 'done']);
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.trackers.length, 1);
});

test('parseTurn infers bare command JSON blocks as run_command tool calls', () => {
  const parsed = parseTurn(
    '{"command":"powershell.exe -NoProfile -Command \\"Get-Process | Select-Object -First 3\\"","description":"Inspect top processes"}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'powershell.exe -NoProfile -Command "Get-Process | Select-Object -First 3"');
});

test('parseTurn infers bare command JSON blocks with timeout aliases as run_command tool calls', () => {
  const parsed = parseTurn(
    '{"command":"Get-ChildItem -Force store | Select-Object Mode,Length,LastWriteTime,Name","cwd":"store","timeout":30000}'
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].toolName, 'run_command');
  assert.equal(parsed.toolCalls[0].parameters.command, 'Get-ChildItem -Force store | Select-Object Mode,Length,LastWriteTime,Name');
  assert.equal(parsed.toolCalls[0].parameters.cwd, 'store');
  assert.equal(parsed.toolCalls[0].parameters.timeout, 30000);
});

test('parseTurn recovers concatenated tool objects that are missing the outer closing brace before the next tool block', () => {
  const parsed = parseTurn(
    '{"tool":"write_file","arguments":{"path":"workspace-demo/prototype/package.json","content":"{\\n  \\"name\\": \\"workspace-demo-prototype\\"\\n}"}}'.replace('}}', '}')
    + ',{"tool":"write_file","arguments":{"path":"workspace-demo/prototype/README.md","content":"# Prototype\\n\\nThis file is grounded in the real scaffold."}}'.replace('}}', '}')
    + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":70,"decision":"CONTINUE","reason":"prototype top-level files were written","next_unit":null,"files_created":["workspace-demo/prototype/package.json","workspace-demo/prototype/README.md"]}'
  );

  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.toolCalls.map((call) => call.toolName), ['write_file', 'write_file']);
  assert.equal(parsed.toolCalls[0].parameters.path, 'workspace-demo/prototype/package.json');
  assert.match(parsed.toolCalls[0].parameters.content, /workspace-demo-prototype/);
  assert.equal(parsed.toolCalls[1].parameters.path, 'workspace-demo/prototype/README.md');
  assert.match(parsed.toolCalls[1].parameters.content, /# Prototype/);
  assert.equal(parsed.trackers.length, 1);
  assert.equal(parsed.trackers[0].currentUnit, 'AGENT-001');
  assert.equal(parsed.trackers[0].status, 'IN_PROGRESS');
});

test('validateStageSemanticContract reports batch blocking when tool batch fails', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[] }[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  );
  const acceptance = acceptParsedTurn({
    currentUnitId: 'AGENT-001',
    parsed,
    outputContract: '{"summary":"string","issues":[]}'
  });

  const result = validateStageSemanticContract({
    acceptance,
    batchExecutionResults: [{
      batchId: 'batch_1',
      stageIndex: 0,
      status: 'FAILED',
      dispatchedInvocationIds: [],
      approvalBlockedInvocationIds: [],
      deniedInvocationIds: [],
      failedInvocationIds: ['inv_1']
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockingReason, 'BATCH_BLOCKED');
  assert.equal(result.pendingCorrection, 'AWAITING_TOOL_ACTION');
  assert.equal(result.batchIssueCodes.includes('tool_batch_failed'), true);
});

test('validateStageSemanticContract reports consolidation blocking for invalid stage acceptance', () => {
  const parsed = parseTurn(
    '[AGENT-001_OUTPUT]{"summary":"ok","issues":[] }[/AGENT-001_OUTPUT]\n'
    + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
  );
  const stageAcceptance = acceptStageTurn({
    parsed,
    units: [
      { unitId: 'AGENT-001', outputContract: '{"summary":"string","issues":[]}' },
      { unitId: 'AGENT-002', outputContract: '{"summary":"string","issues":[]}' }
    ]
  });

  const result = validateStageSemanticContract({
    acceptance: stageAcceptance.unitResults[0].acceptance,
    stageAcceptance,
    batchExecutionResults: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockingReason, 'CONSOLIDATION_BLOCKED');
  assert.equal(result.contractIssueCodes.length > 0, true);
});

test('evaluateBatchAdmission rejects unsafe shared side effects instead of forcing a batch', () => {
  const result = evaluateBatchAdmission({
    runtime: {
      pendingToolBatches: [],
      planner: {
        fallbackReasons: []
      }
    },
    candidates: [
      {
        invocationKey: 'batch-1:a',
        batchId: 'batch-1',
        stageIndex: 1,
        unitId: 'AGENT-003',
        unitIdsInBatch: ['AGENT-003', 'AGENT-004'],
        toolName: 'write_file',
        sideEffectKey: 'write_file:shared.md',
        argumentText: '{"path":"shared.md"}'
      },
      {
        invocationKey: 'batch-1:b',
        batchId: 'batch-1',
        stageIndex: 1,
        unitId: 'AGENT-004',
        unitIdsInBatch: ['AGENT-003', 'AGENT-004'],
        toolName: 'write_file',
        sideEffectKey: 'write_file:shared.md',
        argumentText: '{"path":"shared.md"}'
      }
    ]
  });

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].status, 'PARTIAL');
  assert.equal(result.decisions[0].rejectionReasons.includes('BATCH_REJECTED_SIDE_EFFECT_RISK'), true);
});

test('evaluateBatchAdmission rejects multi-unit batching when approval backlog guardrail is active', () => {
  const result = evaluateBatchAdmission({
    runtime: {
      pendingToolBatches: [{
        batchId: 'batch-prev',
        stageIndex: 0,
        unitIds: ['AGENT-001'],
        invocationIds: ['inv-prev'],
        status: 'PARTIAL_APPROVAL_BLOCKED',
        createdAt: 1,
        executedAt: null,
        approvalBlockedCount: 1,
        failedCount: 0
      }],
      planner: {
        fallbackReasons: []
      }
    },
    candidates: [
      {
        invocationKey: 'batch-2:a',
        batchId: 'batch-2',
        stageIndex: 1,
        unitId: 'AGENT-003',
        unitIdsInBatch: ['AGENT-003', 'AGENT-004'],
        toolName: 'write_file',
        sideEffectKey: null,
        argumentText: '{"path":"stage.md"}'
      }
    ]
  });

  assert.equal(result.guardrail.batchAdmissionRestricted, true);
  assert.equal(result.decisions[0].status, 'REJECTED');
  assert.equal(result.decisions[0].rejectionReasons.includes('BATCH_REJECTED_APPROVAL_BACKLOG_RISK'), true);
});
