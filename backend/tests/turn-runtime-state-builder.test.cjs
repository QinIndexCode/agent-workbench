const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      taskId: 'task_docs_normalize',
      title: 'Normalize Documentation Batch',
      intent: 'Normalize incoming source notes into grounded markdown documents.',
      preferredProviderId: 'test-provider',
      createdAt: Date.now(),
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'DocumentationNormalizer',
          goal: 'Produce grounded normalized documents from incoming source notes.',
          taskScope: 'Read incoming/ and write normalized markdown plus trace evidence.',
          outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
          dependencies: [],
          executionProfileId: 'implement',
          qualityProfileId: 'docs_normalize'
        }
      ]
    };
    const previousRuntime = createTaskRuntimeState(definition, 10);
    const acceptedOutput = {
      unitId: 'AGENT-001',
      wrapper: 'square',
      raw: '{"summary":"Read brief files","details":"Grounded design write phase is next.","producedFiles":[],"issues":[]}',
      parsedJson: {
        summary: 'Read source files',
        details: 'Grounded normalization write phase is next.',
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
      reason: 'Read the grounded source files; next turn will write normalized docs.',
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
        selectedProvider: { id: 'test-provider' },
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
        '{"tool":"read_file","arguments":{"path":"incoming/source-notes.md"}}',
        '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":20,"decision":"CONTINUE","reason":"Read the grounded source files; next turn will write normalized docs.","next_unit":null,"files_created":[]}'
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
      /quality_gate_failed:generic_quality_contract_missing_runtime_evidence/
    );
  } finally {
    removeDir(root);
  }
});

test('buildTurnRuntimeState feeds delivered artifact paths into quality evaluation', () => {
  const root = createTempRoot();
  try {
    const config = loadBackendNewConfig({}, { cwd: root, env: {} });
    const layout = new StorageLayout(config);
    const foundation = { config, layout };
    const plannerService = new TaskPlannerService();
    const taskId = 'task_web_external_artifacts';
    const workspaceDir = layout.forTask(taskId).workspaceDir;
    const externalDir = path.join(root, 'AAA');
    fs.mkdirSync(path.join(workspaceDir, 'quality'), { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalDir, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><button data-theme-toggle>Theme</button><script src="script.js"></script></body></html>',
      'utf8'
    );
    fs.writeFileSync(path.join(externalDir, 'styles.css'), 'button { color: #222; }', 'utf8');
    fs.writeFileSync(path.join(externalDir, 'script.js'), 'document.querySelector("[data-theme-toggle]").addEventListener("click", () => document.body.classList.toggle("light"));', 'utf8');
    fs.writeFileSync(
      path.join(workspaceDir, 'quality', 'web-audit.json'),
      JSON.stringify({
        profile: 'web_experience',
        artifactKind: 'static_site',
        entryFiles: ['index.html'],
        supportingFiles: ['styles.css', 'script.js'],
        interactionSelectors: ['[data-theme-toggle]'],
        brandingTitle: 'External Artifact Site'
      }),
      'utf8'
    );

    const definition = {
      taskId,
      title: 'External web artifact',
      intent: 'Create a web artifact outside the task workspace.',
      preferredProviderId: 'test-provider',
      createdAt: Date.now(),
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'WebBuilder',
          goal: 'Build external web files.',
          taskScope: 'Write the site to an explicit local destination and keep quality evidence in the workspace.',
          outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
          dependencies: [],
          executionProfileId: 'implement',
          qualityProfileId: 'web_experience'
        }
      ]
    };
    const previousRuntime = createTaskRuntimeState(definition, 10);
    const acceptedOutput = {
      unitId: 'AGENT-001',
      wrapper: 'square',
      raw: '{"summary":"Delivered site","details":"External files were written.","artifactDestination":"external","issues":[]}',
      parsedJson: {
        summary: 'Delivered site',
        details: 'External files were written.',
        artifactDestination: externalDir,
        issues: []
      },
      contractKeys: ['summary', 'details', 'artifactDestination', 'issues']
    };
    const acceptedTracker = {
      currentUnit: 'AGENT-001',
      status: 'COMPLETE',
      progressPercent: 100,
      decision: 'CONTINUE',
      reason: 'External files and quality evidence were written.',
      nextUnit: null,
      filesCreated: [
        path.join(externalDir, 'index.html'),
        path.join(externalDir, 'styles.css'),
        path.join(externalDir, 'script.js'),
        'quality/web-audit.json'
      ]
    };
    const latestToolInvocations = [
      path.join(externalDir, 'index.html'),
      path.join(externalDir, 'styles.css'),
      path.join(externalDir, 'script.js'),
      'quality/web-audit.json'
    ].map((filePath, index) => ({
      invocationId: `tool_${index + 1}`,
      toolId: 'write_file',
      status: 'SUCCEEDED',
      unitId: 'AGENT-001',
      arguments: { path: filePath },
      startedAt: 20 + index,
      endedAt: 21 + index,
      result: { path: filePath },
      error: null,
      metadata: {}
    }));

    const { nextRuntime } = buildTurnRuntimeState({
      foundation,
      plannerService,
      definition,
      previousRuntime,
      assembled: {
        userProfile: createEmptyUserPreferenceProfile(10),
        selectedProvider: { id: 'test-provider' },
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
      providerResponseText: 'response',
      plannerPreferred: true,
      phaseOutcome: {
        plannedTools: {
          accepted: latestToolInvocations.length,
          approvalRequired: 0,
          rejected: [],
          acceptedInvocationIds: latestToolInvocations.map((invocation) => invocation.invocationId),
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
            acceptedInvocationIds: latestToolInvocations.map((invocation) => invocation.invocationId),
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
        correctionUnitId: null,
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
      latestToolInvocations
    });

    assert.equal(nextRuntime.pendingCorrection, 'NONE');
    assert.equal(nextRuntime.schedulerUnits['AGENT-001'].status, 'COMPLETE');
    assert.equal(nextRuntime.invalidOutputUnits['AGENT-001'], undefined);
  } finally {
    removeDir(root);
  }
});
