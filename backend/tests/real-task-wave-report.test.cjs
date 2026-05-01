const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadWaveModule() {
  const runnerPath = path.resolve(__dirname, '..', '..', 'scripts', 'run-real-task-wave.mjs');
  const hookPath = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'real-task-scenario-pack-hooks.mjs');
  const [runner, hooks] = await Promise.all([
    import(pathToFileURL(runnerPath).href),
    import(pathToFileURL(hookPath).href),
  ]);
  return {
    ...hooks,
    ...runner,
  };
}

test('continue suppression treats list and search as inspection-only when explicitly allowed', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    workspaceRelativeFiles: [
      'quality/web-audit.json',
    ],
  };

  const suppressed = shouldSuppressDuplicateContinueInstruction(
    {
      message: 'write the external blog updates',
      metadata: {
        uniqueKey: 'path-blog-followup:path-blog-delivery',
      },
    },
    scenarioState,
    [
      {
        lifecycleStatus: 'RUNNING',
        workspaceFingerprint: 'quality/web-audit.json',
        observedWriteCount: 0,
        observedReadCount: 0,
        observedToolIds: ['list_files', 'search_files'],
        metadata: {
          allowTargetedReadInspection: true,
          uniqueKey: 'path-blog-followup:path-blog-delivery',
        },
      },
    ],
  );

  assert.equal(suppressed, false);
});

test('real task wave verification mode defaults to automated and supports submit-only manual review', async () => {
  const { resolveRealTaskWaveVerificationMode } = await loadWaveModule();

  assert.equal(resolveRealTaskWaveVerificationMode({}), 'automated_wave');
  assert.equal(resolveRealTaskWaveVerificationMode({ REAL_TASK_WAVE_MODE: 'manual_review' }), 'submit_only_manual_review');
  assert.equal(resolveRealTaskWaveVerificationMode({ REAL_TASK_WAVE_MODE: 'submit-only' }), 'submit_only_manual_review');
  assert.equal(resolveRealTaskWaveVerificationMode({ REAL_TASK_WAVE_SUBMIT_ONLY: '1' }), 'submit_only_manual_review');
  assert.equal(resolveRealTaskWaveVerificationMode({ REAL_TASK_WAVE_MANUAL_REVIEW: 'true' }), 'submit_only_manual_review');
});

test('continue suppression allows one retry after a failed tool result without workspace progress', async () => {
  const { shouldSuppressDuplicateContinueInstruction } = await loadWaveModule();
  const uniqueKey = 'generic:verify-command:npm-run-check';
  const workspaceFingerprint = 'package.json|src/index.js';
  const instruction = {
    message: 'rerun or repair the failed verification command',
    metadata: { uniqueKey },
  };
  const attempt = {
    issuedAt: 1000,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint,
    metadata: { uniqueKey },
  };
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      toolInvocations: [
        {
          invocationId: 'tool_failed_check',
          toolId: 'run_command',
          status: 'FAILED',
          startedAt: 1200,
          endedAt: 1300,
          result: {
            exitCode: 1,
            stdout: 'before failure',
            stderr: 'command failed',
          },
        },
      ],
    },
    workspaceRelativeFiles: ['package.json', 'src/index.js'],
  };

  assert.equal(shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [attempt]), false);
  assert.equal(
    shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [
      attempt,
      { ...attempt, issuedAt: 1400 },
    ]),
    true,
  );
});

test('continue no-progress guard trips after repeated failed tool results without workspace progress', async () => {
  const { hasDuplicateContinueNoProgress } = await loadWaveModule();
  const uniqueKey = 'generic:verify-command:npm-run-check';
  const workspaceFingerprint = 'package.json|src/index.js';
  const instruction = {
    message: 'rerun or repair the failed verification command',
    metadata: { uniqueKey },
  };
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      toolInvocations: [
        {
          invocationId: 'tool_failed_check_1',
          toolId: 'run_command',
          status: 'FAILED',
          startedAt: 1200,
          endedAt: 1300,
          result: {
            exitCode: 1,
            stdout: 'before failure',
            stderr: 'command failed',
          },
        },
        {
          invocationId: 'tool_failed_check_2',
          toolId: 'run_command',
          status: 'FAILED',
          startedAt: 2200,
          endedAt: 2300,
          result: {
            exitCode: 1,
            stdout: 'before failure',
            stderr: 'command failed again',
          },
        },
      ],
    },
    workspaceRelativeFiles: ['package.json', 'src/index.js'],
  };
  const firstAttempt = {
    issuedAt: 1000,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint,
    metadata: { uniqueKey },
  };

  assert.equal(
    hasDuplicateContinueNoProgress(instruction, scenarioState, [
      firstAttempt,
      { ...firstAttempt, issuedAt: 2000 },
    ]),
    true,
  );
});

test('continue no-progress guard does not trip when a failed tool is followed by workspace progress', async () => {
  const { hasDuplicateContinueNoProgress } = await loadWaveModule();
  const uniqueKey = 'generic:verify-command:npm-run-check';
  const instruction = {
    message: 'rerun or repair the failed verification command',
    metadata: { uniqueKey },
  };
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      toolInvocations: [
        {
          invocationId: 'tool_failed_check',
          toolId: 'run_command',
          status: 'FAILED',
          startedAt: 2200,
          endedAt: 2300,
          result: {
            exitCode: 1,
            stderr: 'command failed',
          },
        },
      ],
    },
    workspaceRelativeFiles: ['package.json', 'src/index.js', 'src/fix.js'],
  };
  const firstAttempt = {
    issuedAt: 1000,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint: 'package.json|src/index.js',
    metadata: { uniqueKey },
  };

  assert.equal(
    hasDuplicateContinueNoProgress(instruction, scenarioState, [
      firstAttempt,
      { ...firstAttempt, issuedAt: 2000 },
    ]),
    false,
  );
});

test('continue no-progress guard trips after repeated inspection-only repair turns', async () => {
  const { shouldSuppressDuplicateContinueInstruction, hasDuplicateContinueNoProgress } = await loadWaveModule();
  const uniqueKey = 'generic:write-repair:src/fix.js';
  const workspaceFingerprint = 'package.json|src/index.js';
  const instruction = {
    message: 'write the requested repair file',
    metadata: {
      uniqueKey,
      allowTargetedReadInspection: true,
    },
  };
  const firstAttempt = {
    issuedAt: 1000,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint,
    observedWriteCount: 0,
    observedReadCount: 2,
    observedToolIds: ['read_file', 'read_file'],
    metadata: {
      uniqueKey,
      allowTargetedReadInspection: true,
    },
  };
  const secondAttempt = {
    ...firstAttempt,
    issuedAt: 2000,
  };
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      toolInvocations: [
        {
          invocationId: 'tool_read_1',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          startedAt: 2100,
          endedAt: 2110,
          arguments: { path: 'src/index.js' },
        },
        {
          invocationId: 'tool_read_2',
          toolId: 'read_file',
          status: 'SUCCEEDED',
          startedAt: 2120,
          endedAt: 2130,
          arguments: { path: 'src/helper.js' },
        },
      ],
    },
    workspaceRelativeFiles: ['package.json', 'src/index.js'],
  };

  assert.equal(shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [firstAttempt]), false);
  assert.equal(
    shouldSuppressDuplicateContinueInstruction(instruction, scenarioState, [firstAttempt, secondAttempt]),
    true,
  );
  assert.equal(hasDuplicateContinueNoProgress(instruction, scenarioState, [firstAttempt, secondAttempt]), true);
});

test('runtime correction no-progress guard trips when no continue instruction is available', async () => {
  const { hasRuntimeCorrectionNoProgress } = await loadWaveModule();
  const updatedAt = 1000;
  const scenarioState = {
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        updatedAt,
        executionLease: { active: false },
        safePoint: { stage: 'AFTER_PROVIDER' },
      },
      pendingApprovalItems: [],
    },
  };
  const activeProviderState = {
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        updatedAt,
        executionLease: { active: true },
        safePoint: { stage: 'AFTER_PROVIDER' },
      },
      pendingApprovalItems: [],
    },
  };

  assert.equal(hasRuntimeCorrectionNoProgress(scenarioState, updatedAt + 89_000), false);
  assert.equal(hasRuntimeCorrectionNoProgress(scenarioState, updatedAt + 91_000), true);
  assert.equal(hasRuntimeCorrectionNoProgress(activeProviderState, updatedAt + 120_000), false);
});

test('stale continue no-progress guard still applies after drift checking', async () => {
  const { hasStaleContinueNoProgress } = await loadWaveModule();
  const attempt = {
    issuedAt: 1000,
    driftChecked: true,
    lifecycleStatus: 'RUNNING',
    workspaceFingerprint: 'workspace-demo/design/README.md',
    metadata: {
      uniqueKey: 'generic:write-artifact',
    },
  };
  const scenarioState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        executionLease: { active: false },
      },
      toolInvocations: [],
    },
    workspaceRelativeFiles: ['workspace-demo/design/README.md'],
  };

  assert.equal(hasStaleContinueNoProgress(attempt, scenarioState, 90_000), false);
  assert.equal(hasStaleContinueNoProgress(attempt, scenarioState, 92_000), true);
});

test('runtime correction no-progress guard treats stale BEFORE_PROVIDER safe point as finished turn when lease is inactive', async () => {
  const { hasRuntimeCorrectionNoProgress } = await loadWaveModule();
  const updatedAt = 1000;
  const staleSafePointState = {
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        updatedAt,
        executionLease: { active: false },
        safePoint: { stage: 'BEFORE_PROVIDER' },
      },
      pendingApprovalItems: [],
    },
  };
  const activeProviderState = {
    task: {
      runtime: {
        pendingCorrection: 'AWAITING_TOOL_ACTION',
        updatedAt,
        executionLease: { active: true },
        safePoint: { stage: 'BEFORE_PROVIDER' },
      },
      pendingApprovalItems: [],
    },
  };

  assert.equal(hasRuntimeCorrectionNoProgress(staleSafePointState, updatedAt + 91_000), true);
  assert.equal(hasRuntimeCorrectionNoProgress(activeProviderState, updatedAt + 120_000), false);
});

test('inactive running no-progress guard trips when no runtime work is pending', async () => {
  const { hasInactiveRunningNoProgress } = await loadWaveModule();
  const latestActivityAt = 2000;
  const idleRunningState = {
    summary: {
      lifecycleStatus: 'RUNNING',
    },
    task: {
      runtime: {
        lifecycleStatus: 'RUNNING',
        engineStatus: 'RUNNING',
        pendingCorrection: 'NONE',
        executionLease: { active: false },
        safePoint: { stage: 'AFTER_PROVIDER', reachedAt: latestActivityAt },
        awaitingToolDispatch: [],
        pendingToolBatches: [],
      },
      pendingApprovalItems: [],
      toolInvocations: [],
      events: [
        { type: 'SAFE_POINT_REACHED', timestamp: latestActivityAt - 10 },
        { type: 'TURN_ANALYZED', timestamp: latestActivityAt },
      ],
    },
    debug: {
      executionSummary: {
        acceptance: {
          deterministic: {
            verdict: 'failed',
            outcome: {
              verdict: 'failed',
              failedChecks: ['tracker_not_complete:in_progress'],
            },
          },
        },
      },
    },
  };
  const activeLeaseState = {
    ...idleRunningState,
    task: {
      ...idleRunningState.task,
      runtime: {
        ...idleRunningState.task.runtime,
        executionLease: { active: true },
      },
    },
  };
  const pendingToolState = {
    ...idleRunningState,
    task: {
      ...idleRunningState.task,
      runtime: {
        ...idleRunningState.task.runtime,
        awaitingToolDispatch: [{ invocationId: 'tool_pending' }],
      },
    },
  };
  const completedBatchState = {
    ...idleRunningState,
    task: {
      ...idleRunningState.task,
      runtime: {
        ...idleRunningState.task.runtime,
        pendingToolBatches: [{ batchId: 'batch_1', status: 'SUCCEEDED' }],
      },
    },
  };
  const activeBatchState = {
    ...idleRunningState,
    task: {
      ...idleRunningState.task,
      runtime: {
        ...idleRunningState.task.runtime,
        pendingToolBatches: [{ batchId: 'batch_1', status: 'RUNNING' }],
      },
    },
  };

  assert.equal(hasInactiveRunningNoProgress(idleRunningState, latestActivityAt + 89_000), false);
  assert.equal(hasInactiveRunningNoProgress(idleRunningState, latestActivityAt + 91_000), true);
  assert.equal(hasInactiveRunningNoProgress(completedBatchState, latestActivityAt + 91_000), true);
  assert.equal(hasInactiveRunningNoProgress(activeLeaseState, latestActivityAt + 120_000), false);
  assert.equal(hasInactiveRunningNoProgress(pendingToolState, latestActivityAt + 120_000), false);
  assert.equal(hasInactiveRunningNoProgress(activeBatchState, latestActivityAt + 120_000), false);
});

test('real-task-wave live model defaults to the canonical text-agent model unless explicitly overridden', async () => {
  const { resolveRealTaskWaveLiveModel } = await loadWaveModule();
  const original = process.env.REAL_TASK_WAVE_LIVE_MODEL;
  delete process.env.REAL_TASK_WAVE_LIVE_MODEL;
  try {
    assert.equal(resolveRealTaskWaveLiveModel([{ id: 'docs-normalize-batch' }]), 'mimo-v2.5');
    assert.equal(resolveRealTaskWaveLiveModel([{ id: 'path-blog-greenfield' }]), 'mimo-v2.5');
  } finally {
    if (typeof original === 'string') {
      process.env.REAL_TASK_WAVE_LIVE_MODEL = original;
    } else {
      delete process.env.REAL_TASK_WAVE_LIVE_MODEL;
    }
  }
});

test('desktop observation mismatch asks for fresh narrow evidence when latest write is newer than latest run', async () => {
  const { deriveContinueMessage, normalizeContinueInstruction } = await loadWaveModule();
  const instruction = normalizeContinueInstruction(deriveContinueMessage(
    {
      id: 'desktop-ops-followup',
      unit: {
        qualityProfileId: 'desktop_observation',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            activityId: 'tool_run_old',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1000,
            endedAt: 1100,
            argumentsSummary: 'Get-Process | Select-Object ProcessName,Responding,MainWindowTitle',
            resultSummary: 'ProcessName ApplicationFrameHost MainWindowTitle 设置 Responding true',
          },
          {
            activityId: 'tool_write_report',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 1200,
            endedAt: 1300,
            argumentsSummary: 'quality/desktop-observation.json',
            resultSummary: 'quality/desktop-observation.json',
          },
        ],
      },
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: [
                'quality_gate_failed:tool_output_mismatch:desktop_process_settings',
                'quality_required_evidence:repair quality/desktop-observation.json observation desktop_process_settings so sourceInvocationId points to a successful run_command output containing: ProcessName, Settings.',
              ],
            },
          },
        },
      },
      workspaceRelativeFiles: ['reports/desktop-observation.md', 'quality/desktop-observation.json'],
    },
  ));

  assert.equal(instruction.metadata.phase, 'desktop_observation_refresh_evidence');
  assert.deepEqual(instruction.metadata.allowedTools, ['run_command']);
  assert.match(instruction.message, /fresh, narrow Windows run_command/i);
  assert.match(instruction.message, /untruncated output/i);
  assert.match(instruction.message, /Do not translate window titles/i);
  assert.doesNotMatch(instruction.message, /Emit write_file calls for these exact paths/i);
});

test('desktop observation mismatch switches back to write-only after fresh evidence arrives', async () => {
  const { deriveContinueMessage, normalizeContinueInstruction } = await loadWaveModule();
  const instruction = normalizeContinueInstruction(deriveContinueMessage(
    {
      id: 'desktop-ops-followup',
      unit: {
        qualityProfileId: 'desktop_observation',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            activityId: 'tool_write_report',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 1200,
            endedAt: 1300,
            argumentsSummary: 'quality/desktop-observation.json',
            resultSummary: 'quality/desktop-observation.json',
          },
          {
            activityId: 'tool_run_fresh',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1400,
            endedAt: 1500,
            argumentsSummary: 'Get-Process | Where-Object { $_.MainWindowTitle }',
            resultSummary: 'ProcessName ApplicationFrameHost MainWindowTitle 设置 Responding true',
          },
        ],
      },
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: [
                'quality_gate_failed:tool_output_mismatch:desktop_process_settings',
              ],
            },
          },
        },
      },
      workspaceRelativeFiles: ['reports/desktop-observation.md', 'quality/desktop-observation.json'],
    },
  ));

  assert.equal(instruction.metadata, null);
  assert.match(instruction.message, /Emit write_file calls for these exact paths/i);
  assert.match(instruction.message, /Do not emit create_folder, read_file, list_files, search_files, or run_command/i);
  assert.match(instruction.message, /Use the fresh evidence that already exists/i);
});

test('system audit mismatch switches to quality-json repair after fresh host evidence arrives', async () => {
  const { deriveContinueMessage, normalizeContinueInstruction } = await loadWaveModule();
  const instruction = normalizeContinueInstruction(deriveContinueMessage(
    {
      id: 'system-health-audit',
      unit: {
        qualityProfileId: 'system_audit',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          {
            activityId: 'tool_write_quality',
            toolId: 'write_file',
            status: 'SUCCEEDED',
            startedAt: 1000,
            endedAt: 1100,
            argumentsSummary: 'quality/system-audit.json',
            resultSummary: 'quality/system-audit.json',
          },
          {
            activityId: 'tool_memory',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1200,
            endedAt: 1300,
            argumentsSummary: 'Get-CimInstance Win32_OperatingSystem',
            resultSummary: 'TotalPhysicalMemoryMb : 32499 FreePhysicalMemoryMb : 6884',
          },
          {
            activityId: 'tool_cpu',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1400,
            endedAt: 1500,
            argumentsSummary: 'Get-CimInstance Win32_Processor',
            resultSummary: 'NumberOfCores : 16 NumberOfLogicalProcessors : 24 MaxClockSpeed : 2000',
          },
          {
            activityId: 'tool_disk',
            toolId: 'run_command',
            status: 'SUCCEEDED',
            startedAt: 1600,
            endedAt: 1700,
            argumentsSummary: 'Get-CimInstance Win32_LogicalDisk',
            resultSummary: 'DeviceID : C: FreeSpaceGb : 79.88 SizeGb : 351.93',
          },
        ],
      },
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
          schedulerUnits: {
            'AGENT-001': {
              invalidOutputErrors: [
                'quality_gate_failed:tool_output_mismatch:total_memory_kb',
                'quality_required_evidence:repair quality/system-audit.json fact total_memory_kb so sourceInvocationId points to a successful run_command output containing: TotalVisibleMemorySize. Candidate sourceInvocationId values with matching evidence: tool_memory.',
              ],
            },
          },
        },
      },
      workspaceRelativeFiles: ['reports/system-health.md', 'quality/system-audit.json'],
      debug: {
        executionSummary: {
          acceptance: {
            quality: {
              profileId: 'system_audit',
              verdict: 'failed',
              failedChecks: ['tool_output_mismatch:total_memory_kb'],
            },
          },
        },
      },
    },
  ));

  assert.equal(instruction.metadata, null);
  assert.match(instruction.message, /Emit write_file calls for these exact paths/i);
  assert.match(instruction.message, /Do not emit more run_command calls/i);
  assert.match(instruction.message, /remaining failure is evidence mapping/i);
});

test('path blog finalization switches to output and complete tracker when only tracker remains incomplete', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'quality/web-audit.json', resultSummary: 'quality/web-audit.json' },
        ],
      },
      task: {
        latestVisibleOutput: {
          summary: 'Created the blog website in D:/AAA.',
          details: 'index.html, styles.css, and script.js were written and quality/web-audit.json passed.',
          artifactPaths: ['D:/AAA/index.html', 'D:/AAA/styles.css', 'D:/AAA/script.js', 'quality/web-audit.json'],
        },
      },
      workspaceRelativeFiles: ['quality/web-audit.json'],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'passed', requiredNextEvidence: [] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: {
                verdict: 'failed',
                failedChecks: ['tracker_not_complete:in_progress'],
                requiredNextEvidence: [],
              },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'passed',
              requiredNextEvidence: [],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'tracker_only_finalization');
  assert.equal(instruction.metadata.phase, 'finalize');
  assert.deepEqual(instruction.metadata.allowedTools, []);
  assert.match(instruction.message, /status to COMPLETE/i);
  assert.match(instruction.message, /reason to a non-empty completion sentence/i);
  assert.doesNotMatch(instruction.message, /write_file/i);
});

test('path blog finalization uses existing write evidence instead of rewriting delivered files', async () => {
  const { deriveContinueMessage, normalizeContinueInstruction } = await loadWaveModule();
  const instruction = normalizeContinueInstruction(deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'create_folder', status: 'SUCCEEDED', argumentsSummary: 'D:\\AAA', resultSummary: 'D:/AAA' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:\\AAA\\index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:\\AAA\\styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:\\AAA\\script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'quality\\web-audit.json', resultSummary: 'quality/web-audit.json' },
        ],
      },
      task: {
        runtime: {
          pendingCorrection: 'NONE',
          currentUnitId: 'AGENT-001',
        },
      },
      workspaceRelativeFiles: ['quality/web-audit.json'],
    },
  ));

  assert.equal(instruction.metadata.phase, 'finalize');
  assert.deepEqual(instruction.metadata.allowedTools, []);
  assert.match(instruction.message, /successful write_file evidence already in this thread/i);
  assert.match(instruction.message, /artifactDestination to "D:\/AAA"/i);
  assert.doesNotMatch(instruction.message, /Emit one create_folder/i);
  assert.doesNotMatch(instruction.message, /Then emit one write_file/i);
});

test('path blog repair writes missing web audit to workspace instead of delivery folder', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
        ],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'passed', requiredNextEvidence: [] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_web_audit'],
              requiredNextEvidence: ['write quality/web-audit.json'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_quality_evidence');
  assert.equal(instruction.metadata.phase, 'web_audit_repair');
  assert.equal(instruction.metadata.allowTargetedReadInspection, true);
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'read_file']);
  assert.deepEqual(instruction.metadata.allowedWritePaths, ['quality/web-audit.json']);
  assert.match(instruction.message, /arguments\.path set to the relative task-workspace path "quality\/web-audit\.json"/i);
  assert.match(instruction.message, /Do not create or write D:\/AAA\/quality\/web-audit\.json/i);
});

test('path blog delivery repair uses one write at a time instead of broad runtime evidence prompt', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
        },
      },
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'failed', requiredNextEvidence: ['emit_progress_tracker'] },
              execution: { verdict: 'failed', requiredNextEvidence: ['emit_real_tool_or_verification_evidence'] },
              evidence: { verdict: 'failed', requiredNextEvidence: ['record_persistent_artifact_or_write_evidence'] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_web_audit'],
              requiredNextEvidence: ['write quality/web-audit.json'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_delivery');
  assert.equal(instruction.metadata.phase, 'path_blog_delivery');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file']);
  assert.deepEqual(instruction.metadata.allowedWritePaths, ['D:/AAA/index.html']);
  assert.match(instruction.message, /Emit exactly one write_file JSON object/i);
  assert.match(instruction.message, /write_file automatically creates missing parent directories/i);
  assert.doesNotMatch(instruction.message, /Address only these currently required evidence gaps/i);
});

test('path blog delivery finishes required files before workspace quality evidence', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_TOOL_ACTION',
        },
      },
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
        ],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'failed', requiredNextEvidence: ['emit_real_tool_or_verification_evidence'] },
              evidence: { verdict: 'failed', requiredNextEvidence: ['record_persistent_artifact_or_write_evidence'] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_artifact:D:/AAA/styles.css', 'missing_artifact:D:/AAA/script.js'],
              requiredNextEvidence: ['write missing required external files before quality evidence'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_delivery');
  assert.deepEqual(instruction.metadata.allowedWritePaths, ['D:/AAA/styles.css']);
  assert.match(instruction.message, /stylesheet/i);
  assert.doesNotMatch(instruction.message, /quality\/web-audit\.json/i);
});

test('workspace artifact scenarios finalize after required files and quality pass', async () => {
  const { deriveContinueMessage, normalizeContinueInstruction } = await loadWaveModule();
  const instruction = normalizeContinueInstruction(deriveContinueMessage(
    {
      id: 'docs-normalize-batch',
      unit: {
        qualityProfileId: 'docs_normalize',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
      },
      task: {
        runtime: {
          pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
        },
        latestVisibleOutput: {
          summary: 'Normalized the source documents.',
          details: 'The normalized markdown files and trace passed quality review.',
          artifactPaths: [
            'normalized/index.md',
            'normalized/product-notes.md',
            'normalized/content-roadmap.md',
            'normalized/launch-retro.md',
            'quality/docs-normalize-trace.json',
          ],
        },
      },
      workspaceRelativeFiles: [
        'incoming/raw-product-notes.md',
        'incoming/content-roadmap draft.md',
        'incoming/launch-retro.MD',
        'normalized/index.md',
        'normalized/product-notes.md',
        'normalized/content-roadmap.md',
        'normalized/launch-retro.md',
        'quality/docs-normalize-trace.json',
      ],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              verdict: 'failed',
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'passed', requiredNextEvidence: [] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: {
                verdict: 'failed',
                failedChecks: ['tracker_not_complete:in_progress'],
                requiredNextEvidence: [],
              },
            },
            quality: {
              profileId: 'docs_normalize',
              verdict: 'passed',
              failedChecks: [],
              requiredNextEvidence: [],
            },
          },
        },
      },
    },
  ));

  assert.equal(instruction.metadata.strategy, 'tracker_only_finalization');
  assert.equal(instruction.metadata.phase, 'finalize');
  assert.deepEqual(instruction.metadata.allowedTools, []);
  assert.match(instruction.message, /status to COMPLETE/i);
  assert.match(instruction.message, /reason to a non-empty completion sentence/i);
  assert.match(instruction.message, /normalized\/index\.md/);
  assert.doesNotMatch(instruction.message, /incoming\/raw-product-notes\.md/);
  assert.doesNotMatch(instruction.message, /Emit write_file calls/i);
});

test('path blog web audit repair becomes write-only after targeted inspection', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
        ],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: { verdict: 'failed', requiredNextEvidence: ['emit_real_tool_or_verification_evidence'] },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: { verdict: 'failed', failedChecks: ['tracker_not_complete:in_progress'], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_web_audit'],
              requiredNextEvidence: ['write quality/web-audit.json'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_quality_evidence_after_inspection');
  assert.equal(instruction.metadata.phase, 'web_audit_repair_after_inspection');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file']);
  assert.deepEqual(instruction.metadata.allowedWritePaths, ['quality/web-audit.json']);
  assert.match(instruction.message, /First emit exactly one write_file JSON object/i);
  assert.match(instruction.message, /After the write_file block, emit exactly one \[AGENT-001_OUTPUT\]/i);
});

test('path blog follow-up switches from repeated inspection to write-only repair', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-followup',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'read_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
        ],
      },
      workspaceRelativeFiles: [],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'failed', requiredNextEvidence: ['emit_validated_explicit_output'] },
              execution: { verdict: 'failed', requiredNextEvidence: ['emit_progress_tracker'] },
              evidence: { verdict: 'failed', requiredNextEvidence: ['record_persistent_artifact_or_write_evidence'] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['missing_web_audit'],
              requiredNextEvidence: ['write quality/web-audit.json'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_followup_write_after_inspection');
  assert.equal(instruction.metadata.phase, 'path_blog_followup_write_after_inspection');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file']);
  assert.deepEqual(instruction.metadata.allowedWritePaths, [
    'D:/AAA/index.html',
  ]);
  assert.match(instruction.message, /already been inspected/i);
  assert.match(instruction.message, /Do not emit create_folder, read_file, list_files, search_files, run_command, or delegate_subtask/i);
  assert.match(instruction.message, /Apply one clearly visible feature or interaction improvement/i);
  assert.match(instruction.message, /Emit exactly one write_file JSON object/i);
  assert.doesNotMatch(instruction.message, /After the four write_file blocks/i);
  assert.ok(instruction.metadata.forbiddenWritePaths.includes('D:/AAA/quality/web-audit.json'));
});

test('path blog repair narrows JavaScript syntax failures to script rewrite and syntax check', async () => {
  const { deriveContinueMessage } = await loadWaveModule();
  const instruction = deriveContinueMessage(
    {
      id: 'path-blog-greenfield',
      unit: {
        qualityProfileId: 'web_experience',
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
      },
    },
    {
      summary: {
        lifecycleStatus: 'RUNNING',
        visibleToolActivities: [
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/index.html', resultSummary: 'D:/AAA/index.html' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/styles.css', resultSummary: 'D:/AAA/styles.css' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'D:/AAA/script.js', resultSummary: 'D:/AAA/script.js' },
          { toolId: 'write_file', status: 'SUCCEEDED', argumentsSummary: 'quality/web-audit.json', resultSummary: 'quality/web-audit.json' },
        ],
      },
      workspaceRelativeFiles: ['quality/web-audit.json'],
      debug: {
        executionSummary: {
          acceptance: {
            deterministic: {
              contract: { verdict: 'passed', requiredNextEvidence: [] },
              execution: {
                verdict: 'failed',
                failedChecks: [
                  'pending_correction:awaiting_tool_action',
                  'issue:quality:javascript_syntax_error:D:/AAA/script.js',
                ],
                requiredNextEvidence: ['emit_real_tool_or_verification_evidence'],
              },
              evidence: { verdict: 'passed', requiredNextEvidence: [] },
              outcome: { verdict: 'failed', failedChecks: [], requiredNextEvidence: [] },
            },
            quality: {
              profileId: 'web_experience',
              verdict: 'failed',
              failedChecks: ['javascript_syntax_error:D:/AAA/script.js'],
              requiredNextEvidence: ['repair JavaScript syntax in D:/AAA/script.js (Invalid or unexpected token)'],
            },
          },
        },
      },
    },
  );

  assert.equal(instruction.metadata.strategy, 'path_blog_script_syntax_repair');
  assert.equal(instruction.metadata.phase, 'web_script_syntax_repair');
  assert.deepEqual(instruction.metadata.allowedTools, ['write_file', 'run_command']);
  assert.match(instruction.message, /Do not rewrite index\.html, styles\.css, or any quality JSON/i);
  assert.match(instruction.message, /node --check D:\/AAA\/script\.js/i);
  assert.doesNotMatch(instruction.message, /\\"D:\\AAA\\script\.js\\"/i);
  assert.ok(instruction.metadata.forbiddenWritePaths.includes('quality/web-audit.json'));
});
