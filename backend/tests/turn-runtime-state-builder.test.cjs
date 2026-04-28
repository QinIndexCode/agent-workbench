const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadBackendNewConfig,
  StorageLayout
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');
const {
  createTaskRuntimeState
} = require('../dist/domain/runtime/state-transition-applier.js');
const {
  TaskPlannerService
} = require('../dist/application/tasks/planning/task-planner-service.js');
const {
  buildTurnRuntimeState
} = require('../dist/application/tasks/turns/turn-runtime-state-builder.js');
const {
  createEmptyUserPreferenceProfile
} = require('../dist/domain/runtime/memory.js');

function createPromptBudget() {
  const sectionPromptChars = {
    taskMemoryChars: 0,
    preferenceChars: 0,
    validatedOutputChars: 0,
    toolPolicyChars: 0,
    capabilityChars: 0,
    stageRuntimeChars: 0,
    responsePolicyChars: 0
  };
  return {
    maxContextMessages: 12,
    retainedContextMessages: 4,
    sectionCharacterLimit: 1800,
    maxSummaryItems: 6,
    lastTruncatedItemCount: 0,
    lastCapabilityItemCount: 0,
    lastValidatedOutputCount: 0,
    estimatedPromptCharacters: 512,
    estimatedPromptTokens: 128,
    estimatedBaselineCharacters: 512,
    estimatedBaselineTokens: 128,
    estimatedReductionRatio: 0,
    rawContextCharacters: 0,
    gatedContextCharacters: 0,
    rawContextTokens: 0,
    gatedContextTokens: 0,
    estimatedHistoryReductionRatio: 0,
    estimatedSectionReductionRatio: 0,
    cacheablePrefixChars: 128,
    stablePrefixChars: 128,
    volatileSuffixChars: 384,
    stablePrefixRatio: 0.25,
    retrievedContextCount: 0,
    policyFilteredOutputCount: 0,
    operatorInputCount: 0,
    sectionPromptChars,
    sectionPromptRatios: { ...sectionPromptChars }
  };
}

test('buildTurnRuntimeState preserves accepted tracker history when quality gate fails', () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const layout = new StorageLayout(config);
    const foundation = { config, layout };
    const plannerService = new TaskPlannerService();
    const definition = {
      taskId: 'task_database_design',
      title: 'Database Near MySQL Design',
      intent: 'Design a MySQL-like OLTP database and prototype scaffold.',
      preferredProviderId: 'xiaomi-mimo-v2-flash',
      createdAt: Date.now(),
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'DatabaseArchitect',
          goal: 'Produce a grounded design package and prototype.',
          taskScope: 'Write the design package into database-lab/.',
          outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
          dependencies: [],
          executionProfileId: 'implement',
          qualityProfileId: 'database_near_mysql_design'
        }
      ]
    };
    const previousRuntime = createTaskRuntimeState(definition, 10);
    const acceptedOutput = {
      unitId: 'AGENT-001',
      wrapper: 'square',
      raw: '{"summary":"Read brief files","details":"Grounded design write phase is next.","producedFiles":[],"issues":[]}',
      parsedJson: {
        summary: 'Read brief files',
        details: 'Grounded design write phase is next.',
        producedFiles: [],
        issues: []
      },
      contractKeys: ['summary', 'details', 'producedFiles', 'issues']
    };
    const acceptedTracker = {
      currentUnit: 'AGENT-001',
      status: 'IN_PROGRESS',
      progressPercent: 20,
      decision: 'CONTINUE',
      reason: 'Read the grounded brief files; next turn will write the design docs.',
      nextUnit: null,
      filesCreated: []
    };

    const { nextRuntime } = buildTurnRuntimeState({
      foundation,
      plannerService,
      definition,
      previousRuntime,
      assembled: {
        userProfile: createEmptyUserPreferenceProfile(10),
        selectedProvider: { id: 'xiaomi-mimo-v2-flash' },
        prompt: 'prompt',
        promptResult: { budget: createPromptBudget() },
        contextMessages: { messages: [], compressed: false, truncatedCount: 0 },
        contextGatingSummary: {
          mode: 'STANDARD',
          rawContextMessageCount: 0,
          retainedContextMessageCount: 0,
          summarizedContextMessageCount: 0,
          filteredContextMessageCount: 0,
          rawContextCharacters: 0,
          gatedContextCharacters: 0,
          estimatedContextReductionRatio: 0,
          reasons: []
        },
        existingConversations: [],
        estimatedPromptCharacters: 512,
        estimatedBaselineCharacters: 512,
        estimatedReductionRatio: 0,
        selectedValidatedOutputs: {
          records: [],
          retrievedContextCount: 0,
          policyFilteredOutputCount: 0
        },
        pendingOperatorInputs: [],
        stageMemorySummary: previousRuntime.stageMemorySummary,
        capabilitySelectionSummary: previousRuntime.capabilitySelectionSummary,
        retrievalSelectionSummary: previousRuntime.retrievalSelectionSummary
      },
      userMessage: undefined,
      currentUnitId: 'AGENT-001',
      checkpointId: 'chk_1',
      correlationId: 'corr_1',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      providerResponseText: [
        '{"tool":"read_file","arguments":{"path":"brief/workload-profile.md"}}',
        '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":20,"decision":"CONTINUE","reason":"Read the grounded brief files; next turn will write the design docs.","next_unit":null,"files_created":[]}'
      ].join('\n'),
      plannerPreferred: true,
      phaseOutcome: {
        plannedTools: {
          accepted: 1,
          approvalRequired: 0,
          rejected: [],
          acceptedInvocationIds: ['tool_1'],
          approvalInvocationIds: []
        },
        orchestrated: {
          parsed: {
            rawText: '',
            explicitOutputs: [],
            trackers: [],
            toolCalls: [],
            warnings: []
          },
          acceptance: {
            ok: true,
            pendingCorrection: 'NONE',
            failureCategory: null,
            acceptedOutput,
            acceptedTracker,
            issues: [],
            contractKeys: acceptedOutput.contractKeys,
            exitCondition: {
              ok: true,
              issueCodes: [],
              requiredOutputKeys: [],
              failureCategory: null
            }
          },
          plannedTools: {
            acceptedInvocationIds: ['tool_1'],
            approvalInvocationIds: [],
            rejectedToolCalls: []
          }
        },
        diagnosticsAcceptance: {
          ok: true,
          pendingCorrection: 'NONE',
          failureCategory: null,
          acceptedOutput,
          acceptedTracker,
          issues: [],
          contractKeys: acceptedOutput.contractKeys,
          exitCondition: {
            ok: true,
            issueCodes: [],
            requiredOutputKeys: [],
            failureCategory: null
          }
        },
        acceptedOutputs: [acceptedOutput],
        acceptedTrackers: [acceptedTracker],
        correctionUnitId: 'AGENT-001',
        pendingToolBatches: [],
        batchAdmissionDecisions: [],
        batchGuardrail: {
          batchAdmissionRestricted: false,
          reasons: []
        },
        consolidationState: {
          status: 'COMPLETED',
          stageIndex: 0,
          lastCompletedAt: 11,
          lastResult: 'COMPLETED',
          lastIssueCodes: []
        }
      },
      latestRuntimeAfterProvider: previousRuntime,
      latestToolInvocations: []
    });

    assert.equal(nextRuntime.pendingCorrection, 'AWAITING_TOOL_ACTION');
    assert.equal(nextRuntime.currentUnitId, 'AGENT-001');
    assert.equal(nextRuntime.schedulerUnits['AGENT-001'].status, 'PARTIAL');
    assert.equal(nextRuntime.progressHistory.length, 1);
    assert.equal(nextRuntime.progressHistory[0].currentUnit, 'AGENT-001');
    assert.equal(nextRuntime.progressHistory[0].status, 'IN_PROGRESS');
    assert.match(
      nextRuntime.invalidOutputUnits['AGENT-001'].join(' '),
      /quality_gate_failed:missing_database_design_manifest/
    );
  } finally {
    removeDir(root);
  }
});
