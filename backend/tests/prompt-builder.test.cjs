const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTurnPrompt,
  loadBackendNewConfig
} = require('../dist');
const { buildStageTurnPrompt } = require('../dist/domain/runtime/stage-prompt-builder.js');
const {
  createStageMemoryVirtualization,
  selectStageRelevantValidatedOutputs
} = require('../dist/domain/runtime/stage-context-virtualization.js');

function createRuntime(overrides = {}) {
  return {
    taskId: 'task_prompt',
    lifecycleStatus: 'RUNNING',
    engineStatus: 'RUNNING',
    currentUnitId: 'AGENT-001',
    pendingCorrection: 'NONE',
    schedulerUnits: {},
    invalidOutputUnits: {},
    awaitingToolDispatch: [],
    awaitingApprovalInvocations: [],
    completedUnits: [],
    failedUnits: [],
    skippedUnits: [],
    progressHistory: [],
    latestSessionId: 'sess_1',
    latestCorrelationId: 'corr_1',
    latestTurnId: 'turn_1',
    latestCheckpointId: 'ckpt_1',
    selectedProviderId: 'provider-main',
    llmContextMessages: [],
    llmContextSnapshotRef: {
      kind: 'llm',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      checkpointId: 'ckpt_1',
      messageCount: 3
    },
    conversationSnapshotRef: {
      kind: 'conversation',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      checkpointId: 'ckpt_1',
      messageCount: 8
    },
    memory: {
      latestUserIntent: 'Keep the result concise and backend-focused.',
      lastUserMessageAt: 1,
      keyMilestones: ['AGENT-000: bootstrap completed'],
      importantDecisions: ['active provider: provider-main'],
      userPreferenceSnapshot: ['preferred language: zh-CN', 'response style: concise']
    },
    promptBudget: {
      maxContextMessages: 12,
      retainedContextMessages: 4,
      sectionCharacterLimit: 1800,
      maxSummaryItems: 6,
      lastTruncatedItemCount: 0,
      lastCapabilityItemCount: 0,
      lastValidatedOutputCount: 0,
      estimatedPromptCharacters: 0,
      estimatedPromptTokens: 0,
      estimatedBaselineCharacters: 0,
      estimatedBaselineTokens: 0,
      estimatedReductionRatio: 0,
      rawContextCharacters: 0,
      gatedContextCharacters: 0,
      rawContextTokens: 0,
      gatedContextTokens: 0,
      estimatedHistoryReductionRatio: 0,
      estimatedSectionReductionRatio: 0,
      cacheablePrefixChars: 0,
      stablePrefixChars: 0,
      volatileSuffixChars: 0,
      stablePrefixRatio: 0,
      retrievedContextCount: 0,
      policyFilteredOutputCount: 0,
      operatorInputCount: 0,
      sectionPromptChars: {
        taskMemoryChars: 0,
        preferenceChars: 0,
        validatedOutputChars: 0,
        toolPolicyChars: 0,
        capabilityChars: 0,
        stageRuntimeChars: 0,
        responsePolicyChars: 0
      },
      sectionPromptRatios: {
        taskMemoryChars: 0,
        preferenceChars: 0,
        validatedOutputChars: 0,
        toolPolicyChars: 0,
        capabilityChars: 0,
        stageRuntimeChars: 0,
        responsePolicyChars: 0
      }
    },
    contextCompressionCount: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function createInput(overrides = {}) {
  const config = loadBackendNewConfig({
    runtime: {
      maxContextMessages: 6,
      retainedContextMessages: 2,
      promptSectionCharacterLimit: 120,
      promptMaxSummaryItems: 2
    },
    tools: {
      permissionMode: 'ask'
    }
  }, { cwd: process.cwd(), env: {} });

  return {
    config,
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify prompt structure.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Planner',
          goal: 'Produce a structured result',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    },
    runtime: createRuntime(),
    currentUnit: {
      id: 'AGENT-001',
      role: 'Planner',
      goal: 'Produce a structured result',
      outputContract: '{"summary":"string","issues":[]}',
      dependencies: []
    },
    validatedOutputs: [],
    pendingInvocations: [],
    pendingApprovals: [],
    provider: {
      id: 'provider-main',
      vendor: 'deepseek',
      transport: 'deepseek-compatible',
      model: 'deepseek-v3.1',
      label: 'DeepSeek Main'
    },
    capabilities: {
      tools: [
        {
          name: 'write_file',
          effect: 'WRITE',
          riskLevel: 'MEDIUM',
          supportsApprovalResume: true,
          maxExecutionMs: 3000
        },
        {
          name: 'search_files',
          effect: 'READ',
          riskLevel: 'LOW',
          supportsApprovalResume: true,
          maxExecutionMs: 2000
        },
        {
          name: 'create_folder',
          effect: 'WRITE',
          riskLevel: 'LOW',
          supportsApprovalResume: true,
          maxExecutionMs: 2000
        }
      ],
      skills: [
        {
          name: 'research-skill',
          supportsStreaming: false,
          supportsWorkspaceWrite: false,
          supportsNetworkAccess: true
        }
      ],
      mcpServers: [
        {
          name: 'doc-server',
          transport: 'stdio',
          supportsTools: true,
          supportsPrompts: false,
          supportsResources: false
        }
      ]
    },
    userProfile: {
      profileId: 'default',
      preferredLanguage: 'zh-CN',
      responseStyle: 'concise',
      modelPreference: 'cloud',
      workflowPreferences: ['cli-first'],
      notableHabits: ['expects end-to-end verification after changes'],
      lastUpdatedAt: 1
    },
    ...overrides
  };
}

test('buildTurnPrompt includes vendor policy, correction directive, and tool approval guardrails', () => {
  const result = buildTurnPrompt(createInput({
    runtime: createRuntime({
      pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
      contractDiagnostics: {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: ['AGENT-001'],
          stageCount: 1,
          currentStageIndex: 0,
          issueCount: 0,
          batchGroupingHint: 'SERIAL_READY',
          entryUnitIds: ['AGENT-001'],
          exitUnitIds: ['AGENT-001']
        },
        currentUnit: {
          unitId: 'AGENT-001',
          permissionLevel: 'DEPENDENCY',
          scopedUnitIds: null
        },
        lastExitCondition: null,
        lastAcceptanceFailureCategory: 'output_contract_mismatch',
        lastPendingCorrectionKind: 'AWAITING_OUTPUT_CORRECTION',
        lastCorrectionPromptMode: 'TARGETED_OUTPUT',
        correctionLoopNonConvergent: false
      }
    }),
    pendingInvocations: [
      { invocationId: 'inv_1', toolId: 'write_file', status: 'WAITING_APPROVAL' },
      { invocationId: 'inv_2', toolId: 'search_files', status: 'PLANNED' }
    ],
    pendingApprovals: [
      { approvalId: 'appr_1', toolId: 'write_file', status: 'PENDING' }
    ]
  }));

  assert.match(result.prompt, /Provider prompt policy: DeepSeek-compatible/);
  assert.match(result.prompt, /Pending correction: AWAITING_OUTPUT_CORRECTION/);
  assert.match(result.prompt, /Correction mode: TARGETED_OUTPUT/);
  assert.match(result.prompt, /Start with exactly one corrected explicit output block/i);
  assert.match(result.prompt, /Do not respond with tool blocks alone/i);
  assert.match(result.prompt, /Tool permission mode: ask/);
  assert.match(result.prompt, /do not return only a tracker/i);
  assert.match(result.prompt, /Only use EARLY_TERMINATE when all required work is already complete/i);
  assert.match(result.prompt, /Never claim files_created unless they come from actual tool results/i);
  assert.equal(result.policy.vendorLabel, 'DeepSeek-compatible');
});

test('buildTurnPrompt includes an explicit delegation contract when the unit requires a child task', () => {
  const result = buildTurnPrompt(createInput({
    currentUnit: {
      id: 'AGENT-001',
      role: 'Implementer',
      goal: 'Delegate one bounded child before parent delivery.',
      outputContract: '{"summary":"string","issues":[]}',
      executionProfileId: 'implement',
      delegationContract: {
        title: 'Delegated note draft',
        role: 'SubSccAgent',
        goal: 'Draft a short scoped note for the parent thread.',
        taskScope: 'Return only the scoped note and stay within the child boundary.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        allowedToolIds: ['write-file'],
        successCriteria: 'Return the scoped note.'
      },
      dependencies: []
    },
    delegationRequirement: {
      required: true,
      satisfied: false,
      reason: 'Delegate one bounded child and wait for its scoped result before parent delivery.',
      contract: {
        title: 'Delegated note draft',
        role: 'SubSccAgent',
        goal: 'Draft a short scoped note for the parent thread.',
        taskScope: 'Return only the scoped note and stay within the child boundary.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        allowedToolIds: ['write-file'],
        successCriteria: 'Return the scoped note.'
      }
    }
  }));

  assert.match(result.prompt, /DELEGATION_CONTRACT/);
  assert.match(result.prompt, /must call delegate_subtask/i);
  assert.match(result.prompt, /before parent delivery can continue/i);
  assert.match(result.prompt, /Delegated note draft/);
  assert.match(result.prompt, /allowedToolIds: write-file/i);
  assert.match(result.prompt, /Call delegate_subtask exactly once/i);
});

test('buildTurnPrompt includes workspace project instructions and command context before runtime sections', () => {
  const result = buildTurnPrompt(createInput({
    workspaceProjectInstructions: 'Prefer workspace commands, keep operator docs updated, and treat imported docs as project truth.',
    workspaceRuleInstructions: 'backend: keep changes additive and avoid rewriting runtime seams',
    workspaceInstructionSkillInstructions: 'release-skill [metadata]; assets=SKILL.md,templates/checklist.md: Follow the staged release checklist and use the provided templates.',
    workspaceCommandInstructions: 'command=release-check; description=prepare a release verification task',
    workspaceAgentInstructions: 'agent=review; description=Focus on regressions; prompt=Check tests, risks, and missing validations.',
    importedWorkspaceDocs: [
      {
        title: 'Runbook',
        sourcePath: 'docs/runbook.md',
        content: 'Runbook requires cache verification before deploy.'
      }
    ]
  }));

  assert.match(result.prompt, /WORKSPACE_WORKFLOW/);
  assert.match(result.prompt, /Project instructions: Prefer workspace commands/i);
  assert.match(result.prompt, /Workspace rules: backend: keep changes additive/i);
  assert.match(result.prompt, /Instruction skills: release-skill \[metadata\]/i);
  assert.match(result.prompt, /Task\/command instructions: command=release-check/i);
  assert.match(result.prompt, /Workspace agent: agent=review; description=Focus on regressions/i);
  assert.match(result.prompt, /docs\/runbook\.md: "?Runbook Runbook requires cache verification before deploy\."?/i);
  assert.ok(result.prompt.indexOf('WORKSPACE_WORKFLOW') < result.prompt.indexOf('TASK'));
  assert.ok(result.prompt.indexOf('Workspace rules:') < result.prompt.indexOf('Instruction skills:'));
  assert.ok(result.prompt.indexOf('Instruction skills:') < result.prompt.indexOf('Task/command instructions:'));
});

test('buildTurnPrompt narrows tracker-only correction prompts when explicit output was already accepted', () => {
  const result = buildTurnPrompt(createInput({
    runtime: createRuntime({
      pendingCorrection: 'AWAITING_TRACKER',
      contractDiagnostics: {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: ['AGENT-001'],
          stageCount: 1,
          currentStageIndex: 0,
          issueCount: 0,
          batchGroupingHint: 'SERIAL_READY',
          entryUnitIds: ['AGENT-001'],
          exitUnitIds: ['AGENT-001']
        },
        currentUnit: {
          unitId: 'AGENT-001',
          permissionLevel: 'DEPENDENCY',
          scopedUnitIds: null
        },
        lastExitCondition: null,
        lastAcceptanceFailureCategory: 'tracker_missing_after_valid_output',
        lastPendingCorrectionKind: 'AWAITING_TRACKER',
        lastCorrectionPromptMode: 'TARGETED_TRACKER',
        correctionLoopNonConvergent: false
      }
    })
  }));

  assert.match(result.prompt, /Correction mode: TARGETED_TRACKER/);
  assert.match(result.prompt, /already supplied a valid explicit output/i);
  assert.match(result.prompt, /Return one valid tracker JSON block/i);
  assert.match(result.prompt, /Do not emit any new tool blocks in this correction/i);
  assert.match(result.prompt, /This correction is tracker-only\./i);
  assert.match(result.prompt, /Do not repeat explicit output, do not emit tool blocks/i);
  assert.doesNotMatch(result.prompt, /Start with exactly one corrected explicit output block/i);
  assert.doesNotMatch(result.prompt, /Use this exact explicit output wrapper pattern:/i);
  assert.doesNotMatch(result.prompt, /Return explicit output first, then any needed tool blocks/i);
});

test('buildTurnPrompt requires tool evidence for implement units and narrows tool-action corrections', () => {
  const result = buildTurnPrompt(createInput({
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify implement prompt structure.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Analyzer',
          goal: 'Prepare the fix plan',
          outputContract: '{"summary":"string","issues":[],"report":"string"}',
          executionProfileId: 'analyze',
          dependencies: []
        },
        {
          id: 'AGENT-002',
          role: 'Implementer',
          goal: 'Apply the fix in the workspace',
          outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
          executionProfileId: 'implement',
          dependencies: ['AGENT-001']
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-002',
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      contractDiagnostics: {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: ['AGENT-002'],
          stageCount: 1,
          currentStageIndex: 0,
          issueCount: 0,
          batchGroupingHint: 'SERIAL_READY',
          entryUnitIds: ['AGENT-002'],
          exitUnitIds: ['AGENT-002']
        },
        currentUnit: {
          unitId: 'AGENT-002',
          permissionLevel: 'DEPENDENCY',
          requiresToolEvidence: true,
          scopedUnitIds: ['AGENT-001']
        },
        lastExitCondition: null,
        lastAcceptanceFailureCategory: 'tool_action_required_but_not_emitted',
        lastPendingCorrectionKind: 'AWAITING_TOOL_ACTION',
        lastCorrectionPromptMode: 'TARGETED_TOOL_ACTION',
        correctionLoopNonConvergent: false
      }
    }),
    currentUnit: {
      id: 'AGENT-002',
      role: 'Implementer',
      goal: 'Apply the fix in the workspace',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      executionProfileId: 'implement',
      dependencies: ['AGENT-001']
    }
  }));

  assert.match(result.prompt, /This unit requires real tool evidence before COMPLETE can be accepted\./i);
  assert.match(result.prompt, /Correction mode: TARGETED_TOOL_ACTION/);
  assert.match(result.prompt, /missing required tool action/i);
  assert.match(result.prompt, /start with the machine-readable tool block that directly addresses the missing artifact or verification evidence/i);
  assert.match(result.prompt, /After the tool block, emit exactly one final tracker JSON block/i);
  assert.match(result.prompt, /Return COMPLETE only after the tool evidence for this unit is real/i);
  assert.match(result.prompt, /This correction is tool-action-first\./i);
  assert.match(result.prompt, /"status":"IN_PROGRESS"/i);
  assert.match(result.prompt, /do not use status COMPLETE in this turn/i);
  assert.doesNotMatch(result.prompt, /Return explicit output first, then any needed tool blocks/i);
  assert.doesNotMatch(result.prompt, /Keep explicit output, tool calls, and tracker as separate machine-readable blocks in this order: explicit output, any needed tool blocks, then one final tracker JSON\./i);
  assert.doesNotMatch(result.prompt, /Use this exact explicit output wrapper pattern:/i);
});

test('buildTurnPrompt requires explicit output after tool action when correction still lacks validated output', () => {
  const result = buildTurnPrompt(createInput({
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify implement prompt structure when explicit output is still missing.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Implementer',
          goal: 'Create the requested artifact and report it back',
          outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
          executionProfileId: 'implement',
          dependencies: []
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-001',
      pendingCorrection: 'AWAITING_TOOL_ACTION',
      invalidOutputUnits: {
        'AGENT-001': ['Missing explicit output for unit "AGENT-001".']
      },
      contractDiagnostics: {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: ['AGENT-001'],
          stageCount: 1,
          currentStageIndex: 0,
          issueCount: 0,
          batchGroupingHint: 'SERIAL_READY',
          entryUnitIds: ['AGENT-001'],
          exitUnitIds: ['AGENT-001']
        },
        currentUnit: {
          unitId: 'AGENT-001',
          permissionLevel: 'DEPENDENCY',
          requiresToolEvidence: true,
          scopedUnitIds: []
        },
        lastExitCondition: null,
        lastAcceptanceFailureCategory: 'artifact_write_required_but_not_emitted',
        lastAcceptanceIssueCodes: ['missing_explicit_output', 'runtime_missing_persistent_write_evidence'],
        lastAcceptanceIssueMessages: [
          'Missing explicit output for unit "AGENT-001".',
          'Unit "AGENT-001" did not produce a persistent write for implement completion.'
        ],
        lastPendingCorrectionKind: 'AWAITING_TOOL_ACTION',
        lastCorrectionPromptMode: 'TARGETED_TOOL_ACTION',
        correctionLoopNonConvergent: false
      }
    }),
    currentUnit: {
      id: 'AGENT-001',
      role: 'Implementer',
      goal: 'Create the requested artifact and report it back',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      executionProfileId: 'implement',
      dependencies: []
    }
  }));

  assert.match(result.prompt, /This correction is tool-action-first and still requires a valid explicit output\./i);
  assert.match(result.prompt, /After the tool block\(s\), return exactly one explicit output block for AGENT-001\./i);
  assert.match(result.prompt, /Finish with exactly one valid tracker JSON block for AGENT-001\./i);
  assert.match(result.prompt, /"status":"IN_PROGRESS"/i);
  assert.match(result.prompt, /do not use status COMPLETE in this turn/i);
  assert.doesNotMatch(result.prompt, /Keep explicit output, tool calls, and tracker as separate machine-readable blocks in this order: explicit output, any needed tool blocks, then one final tracker JSON\./i);
  assert.match(result.prompt, /Use this exact explicit output wrapper pattern:/i);
  assert.match(result.prompt, /That explicit output must satisfy these keys: summary, issues, artifact, report\./i);
});

test('buildTurnPrompt narrows output correction when tools already ran and only explicit output is missing', () => {
  const result = buildTurnPrompt(createInput({
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify targeted output correction structure.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Analyzer',
          goal: 'Prepare the implementation context',
          outputContract: '{"summary":"string","issues":[],"report":"string"}',
          executionProfileId: 'analyze',
          dependencies: []
        },
        {
          id: 'AGENT-002',
          role: 'Implementer',
          goal: 'Apply the fix in the workspace',
          outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
          executionProfileId: 'implement',
          dependencies: ['AGENT-001']
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-002',
      pendingCorrection: 'AWAITING_OUTPUT_CORRECTION',
      contractDiagnostics: {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: ['AGENT-002'],
          stageCount: 1,
          currentStageIndex: 0,
          issueCount: 0,
          batchGroupingHint: 'SERIAL_READY',
          entryUnitIds: ['AGENT-002'],
          exitUnitIds: ['AGENT-002']
        },
        currentUnit: {
          unitId: 'AGENT-002',
          permissionLevel: 'DEPENDENCY',
          requiresToolEvidence: true,
          scopedUnitIds: ['AGENT-001']
        },
        lastExitCondition: null,
        lastAcceptanceFailureCategory: 'response_shape_mismatch',
        lastPendingCorrectionKind: 'AWAITING_OUTPUT_CORRECTION',
        lastCorrectionPromptMode: 'TARGETED_OUTPUT',
        correctionLoopNonConvergent: false
      }
    }),
    currentUnit: {
      id: 'AGENT-002',
      role: 'Implementer',
      goal: 'Apply the fix in the workspace',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      executionProfileId: 'implement',
      dependencies: ['AGENT-001']
    }
  }));

  assert.match(result.prompt, /Do not respond with tool blocks alone/i);
  assert.match(result.prompt, /If your previous turn already executed the needed tools, do not re-run them here/i);
  assert.match(result.prompt, /Only repair the explicit output and tracker/i);
  assert.match(result.prompt, /Assume prior accepted tool evidence remains valid/i);
  assert.match(result.prompt, /do not emit any new tool blocks unless the system explicitly says the required tool evidence is still missing/i);
  assert.match(result.prompt, /This correction is explicit-output-first\./i);
  assert.doesNotMatch(result.prompt, /If tool calls are needed, emit them as separate machine-readable blocks\./i);
});

test('buildTurnPrompt summarizes validated outputs and capabilities within prompt budget', () => {
  const result = buildTurnPrompt(createInput({
    validatedOutputs: Array.from({ length: 12 }, (_, index) => ({
      unitId: `AGENT-${String(index + 1).padStart(3, '0')}`,
      parsed: {
        summary: `summary-${index + 1} `.repeat(120),
        issues: Array.from({ length: 6 }, () => 'issue '.repeat(20))
      }
    })),
    capabilities: {
      tools: Array.from({ length: 10 }, (_, index) => ({
        name: `tool_${index + 1}`,
        effect: index % 2 === 0 ? 'WRITE' : 'READ',
        riskLevel: index % 2 === 0 ? 'MEDIUM' : 'LOW',
        supportsApprovalResume: true,
        maxExecutionMs: 3000
      })),
      skills: Array.from({ length: 6 }, (_, index) => ({
        name: `skill_${index + 1}`,
        supportsStreaming: index % 2 === 0,
        supportsWorkspaceWrite: index % 3 === 0,
        supportsNetworkAccess: true
      })),
      mcpServers: Array.from({ length: 4 }, (_, index) => ({
        name: `mcp_${index + 1}`,
        transport: 'stdio',
        supportsTools: true,
        supportsPrompts: false,
        supportsResources: index % 2 === 0
      }))
    }
  }));

  assert.match(result.prompt, /additional item\(s\) omitted for prompt budget/);
  assert.equal(result.budget.lastValidatedOutputCount, 12);
  assert.equal(result.budget.lastTruncatedItemCount > 0, true);
  assert.equal(result.budget.lastCapabilityItemCount > 0, true);
  assert.equal(result.budget.estimatedReductionRatio > 0.7, true);
  assert.equal(result.budget.cacheablePrefixChars, result.budget.stablePrefixChars);
  assert.equal(result.budget.stablePrefixChars > 0, true);
  assert.equal(result.budget.volatileSuffixChars > 0, true);
  assert.equal(result.budget.stablePrefixRatio > 0, true);
  assert.match(result.prompt, /USER_PREFERENCES/);
  assert.match(result.prompt, /TASK_MEMORY/);
  assert.match(result.prompt, /full profile not included in this provider-facing context/i);
});

test('buildTurnPrompt varies provider guidance for anthropic and keeps explicit wrapper instructions', () => {
  const result = buildTurnPrompt(createInput({
    provider: {
      id: 'provider-main',
      vendor: 'anthropic',
      transport: 'anthropic-compatible',
      model: 'claude-3.7',
      label: 'Claude'
    }
  }));

  assert.match(result.prompt, /Provider prompt policy: Anthropic-compatible/);
  assert.match(result.prompt, /Preferred explicit output wrappers: xml, square, angle/);
  assert.match(result.prompt, /tracker JSON standalone on its own line/i);
});

test('buildTurnPrompt uses JSON-only tool guidance for custom openai-compatible providers', () => {
  const result = buildTurnPrompt(createInput({
    provider: {
      id: 'provider-main',
      vendor: 'custom',
      transport: 'openai-compatible',
      model: 'mimo-v2.5',
      label: 'Xiaomi MiMo'
    }
  }));

  assert.match(result.prompt, /Provider prompt policy: OpenAI-compatible/);
  assert.match(result.prompt, /Tool call format: json/);
  assert.match(result.prompt, /Tool calls must be JSON objects only\./i);
  assert.match(result.prompt, /Accepted canonical tool names: read_file, inspect_file, write_file, create_folder, list_files, search_files, run_command, request_working_directory, delegate_subtask\./i);
  assert.match(result.prompt, /Do not use XML wrappers such as <tool>, <tool_call>, <tool_invocation>, or <invoke>\./i);
  assert.match(result.prompt, /\{"tool":"write_file","arguments":\{"path":"relative\/path\.txt","content":"file content"\}\}/);
});

test('buildTurnPrompt preserves direct dependency outputs in raw form when compression is downgraded', () => {
  const result = buildTurnPrompt(createInput({
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify prompt structure.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Planner',
          goal: 'Produce a structured result',
          outputContract: '{"summary":"string","issues":[],"report":"string"}',
          dependencies: []
        },
        {
          id: 'AGENT-002',
          role: 'Verifier',
          goal: 'Verify structured result',
          outputContract: '{"summary":"string","issues":[],"report":"string"}',
          dependencies: ['AGENT-001']
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-002',
      consolidationState: {
        status: 'CORRECTION_REQUIRED',
        stageIndex: 1,
        lastCompletedAt: 1,
        lastResult: 'CORRECTION_REQUIRED',
        lastIssueCodes: ['missing_report']
      },
      activeStage: {
        stageIndex: 1,
        unitIds: ['AGENT-002'],
        entryUnitIds: ['AGENT-002'],
        exitUnitIds: ['AGENT-002'],
        batchGroupingHint: 'SERIAL_READY'
      },
      pendingToolBatches: []
    }),
    currentUnit: {
      id: 'AGENT-002',
      role: 'Verifier',
      goal: 'Verify structured result',
      outputContract: '{"summary":"string","issues":[],"report":"string"}',
      dependencies: ['AGENT-001']
    },
    validatedOutputs: [
      {
        unitId: 'AGENT-001',
        contractKeys: ['summary', 'issues', 'report'],
        parsed: {
          summary: 'kept raw',
          issues: [],
          report: 'full-report'
        }
      }
    ]
  }));

  assert.match(result.prompt, /Preserved raw validated outputs:/);
  assert.match(result.prompt, /AGENT-001/);
  assert.match(result.prompt, /full-report/);
});

test('buildTurnPrompt renders non-preserved validated outputs as compact structured summaries', () => {
  const result = buildTurnPrompt(createInput({
    config: loadBackendNewConfig({
      runtime: {
        maxContextMessages: 6,
        retainedContextMessages: 2,
        promptSectionCharacterLimit: 240,
        promptMaxSummaryItems: 2
      },
      tools: {
        permissionMode: 'ask'
      }
    }, { cwd: process.cwd(), env: {} }),
    definition: {
      taskId: 'task_prompt',
      title: 'Prompt Builder Test',
      intent: 'Verify prompt structure.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-010',
          role: 'Summarizer',
          goal: 'Summarize distant outputs',
          outputContract: '{"summary":"string","issues":[]}',
          dependencies: []
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-010'
    }),
    currentUnit: {
      id: 'AGENT-010',
      role: 'Summarizer',
      goal: 'Summarize distant outputs',
      outputContract: '{"summary":"string","issues":[]}',
      dependencies: []
    },
    validatedOutputs: [
      {
        unitId: 'AGENT-001',
        contractKeys: ['summary', 'issues', 'artifact', 'report'],
        parsed: {
          summary: 'summary-segment '.repeat(80),
          report: 'report-segment '.repeat(80),
          artifact: 'artifact.md',
          issues: ['alpha', 'beta'],
          confidence: 'high'
        }
      }
    ]
  }));

  assert.match(result.prompt, /summary="summary-segment/);
  assert.match(result.prompt, /report="report-segment/);
  assert.match(result.prompt, /len=/);
  assert.match(result.prompt, /artifact="artifact.md"/);
  assert.match(result.prompt, /issues=2/);
  assert.match(result.prompt, /confidence="high"/);
  assert.doesNotMatch(result.prompt, /summary-segment summary-segment summary-segment summary-segment summary-segment summary-segment/);
});

test('buildTurnPrompt compacts single-unit verify prompts while preserving a full baseline for budget accounting', () => {
  const result = buildTurnPrompt(createInput({
    definition: {
      taskId: 'task_prompt',
      title: 'Verify Final Output',
      intent: 'Confirm final integrated result against prior validated outputs and runtime state.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-005',
          role: 'Consolidator',
          goal: 'Consolidate final result',
          taskScope: 'Merge validated stage outputs into a final answer.',
          inputContract: '{"units":["AGENT-003","AGENT-004"],"outputKeys":{"AGENT-003":["summary","report"],"AGENT-004":["summary","artifact","report"]},"includeGlobalMemory":true}',
          outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
          exitCondition: '{"report":"required"}',
          executionProfileId: 'verify',
          dependencies: ['AGENT-003', 'AGENT-004']
        }
      ]
    },
    runtime: createRuntime({
      currentUnitId: 'AGENT-005',
      memory: {
        latestUserIntent: 'Keep the final report concise, accurate, and directly grounded in prior validated outputs.',
        lastUserMessageAt: 1,
        keyMilestones: [
          'AGENT-003: implementation plan validated and accepted by downstream units.',
          'AGENT-004: execution artifacts created and staged for final verification.'
        ],
        importantDecisions: [
          'AGENT-003: use dependency summaries instead of replaying full raw history.',
          'AGENT-004: artifact path finalized for final report assembly.'
        ],
        userPreferenceSnapshot: ['preferred language: zh-CN', 'response style: concise']
      }
    }),
    currentUnit: {
      id: 'AGENT-005',
      role: 'Consolidator',
      goal: 'Consolidate final result',
      taskScope: 'Merge validated stage outputs into a final answer.',
      inputContract: '{"units":["AGENT-003","AGENT-004"],"outputKeys":{"AGENT-003":["summary","report"],"AGENT-004":["summary","artifact","report"]},"includeGlobalMemory":true}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"report":"required"}',
      executionProfileId: 'verify',
      dependencies: ['AGENT-003', 'AGENT-004']
    },
    validatedOutputs: [
      {
        unitId: 'AGENT-003',
        contractKeys: ['summary', 'report'],
        parsed: {
          summary: 'implementation plan validated and ready for consolidation '.repeat(8),
          report: 'implementation planning report '.repeat(8)
        }
      },
      {
        unitId: 'AGENT-004',
        contractKeys: ['summary', 'artifact', 'report'],
        parsed: {
          summary: 'execution artifacts prepared for final verification '.repeat(8),
          artifact: 'final-artifact.md',
          report: 'execution validation report '.repeat(8)
        }
      }
    ]
  }));

  assert.match(result.prompt, /Contracts=input:declared; output:declared; exit:declared/);
  assert.doesNotMatch(result.prompt, /\nINPUT_CONTRACT\n/);
  assert.doesNotMatch(result.prompt, /\nOUTPUT_CONTRACT\n/);
  assert.match(result.prompt, /Selection status: validation-focused compact cards only\./);
  assert.equal(result.budget.estimatedBaselineCharacters > result.budget.estimatedPromptCharacters, true);
});

test('buildStageTurnPrompt uses shared stage templates instead of repeating full per-unit wrappers and contracts', () => {
  const config = loadBackendNewConfig({
    runtime: {
      maxContextMessages: 6,
      retainedContextMessages: 2,
      promptSectionCharacterLimit: 160,
      promptMaxSummaryItems: 3
    },
    tools: {
      permissionMode: 'ask'
    }
  }, { cwd: process.cwd(), env: {} });

  const result = buildStageTurnPrompt({
    config,
    definition: {
      taskId: 'task_stage_prompt',
      title: 'Stage Prompt Test',
      intent: 'Verify stage prompt compactness.',
      preferredProviderId: 'provider-main',
      createdAt: 1,
      metadata: {},
      units: []
    },
    runtime: createRuntime({
      activeStage: {
        stageIndex: 1,
        unitIds: ['AGENT-001', 'AGENT-002'],
        entryUnitIds: ['AGENT-001', 'AGENT-002'],
        exitUnitIds: ['AGENT-001', 'AGENT-002'],
        batchGroupingHint: 'PARALLEL_READY'
      },
      pendingOperatorInputs: [],
      executionLease: {
        active: false,
        phase: 'IDLE',
        leaseId: null,
        startedAt: null,
        replayable: true
      }
    }),
    stageUnits: [
      {
        unitId: 'AGENT-001',
        role: 'Requirements Analyst',
        goal: 'Extract requirements',
        taskScope: 'Capture requirements and constraints for downstream stages.',
        inputContract: '{"includeGlobalMemory":true}',
        outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
        exitCondition: '{"report":"required"}',
        permissionLevel: 'DEPENDENCY',
        dependencies: [],
        status: 'READY'
      },
      {
        unitId: 'AGENT-002',
        role: 'Risk Analyst',
        goal: 'Identify implementation risks',
        taskScope: 'Summarize risks and boundaries.',
        inputContract: '{"units":["AGENT-001"],"outputKeys":{"AGENT-001":["summary","report"]},"memoryUnits":["AGENT-001"],"memoryKinds":["DECISION"],"includeGlobalMemory":false}',
        outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
        exitCondition: '{"report":"required"}',
        permissionLevel: 'DEPENDENCY',
        dependencies: ['AGENT-001'],
        status: 'READY'
      }
    ],
    validatedOutputs: [],
    pendingInvocations: [],
    pendingApprovals: [],
    provider: {
      id: 'provider-main',
      vendor: 'custom',
      transport: 'openai-compatible',
      model: 'stage-json-model',
      label: 'Stage JSON Provider'
    },
    capabilities: {
      tools: [],
      skills: [],
      mcpServers: []
    },
    userProfile: null,
    stageMemory: null
  });

  assert.match(result.prompt, /contracts: input=includeGlobalMemory=true; output=keys=summary,issues,artifact,report; exit=requires=report/);
  assert.match(result.prompt, /contracts: input=units=AGENT-001; outputKeys=AGENT-001; memoryUnits=AGENT-001; memoryKinds=DECISION; includeGlobalMemory=false/);
  assert.match(result.prompt, /Use this exact output\/tracker template for each completed stage unit U:/);
  assert.match(result.prompt, /Accepted canonical tool names: read_file, inspect_file, write_file, create_folder, list_files, search_files, run_command, request_working_directory, delegate_subtask\./i);
  assert.match(result.prompt, /Replace U with one of the valid stage unit ids\./);
  assert.match(result.prompt, /Preference status: minimal stable preference card included; full profile not included in this provider-facing context\./);
  assert.match(result.prompt, /Selection mode: full capability snapshot included\./i);
  assert.doesNotMatch(result.prompt, /\[AGENT-001_OUTPUT\][\s\S]*\[AGENT-002_OUTPUT\]/);
});

test('createStageMemoryVirtualization summarizes singly-selected items but preserves protected context', () => {
  const stageUnits = [
    {
      unitId: 'AGENT-010',
      role: 'Verifier',
      goal: 'Verify',
      taskScope: undefined,
      inputContract: undefined,
      outputContract: undefined,
      exitCondition: undefined,
      permissionLevel: 'DEPENDENCY',
      contract: {
        unitId: 'AGENT-010',
        permissionLevel: 'DEPENDENCY',
        inputScope: {
          unitIds: [],
          outputKeysByUnitId: {},
          memoryUnitIds: [],
          memoryKinds: [],
          includeGlobalMemory: true,
          structured: false,
          usedCompatibilityFallback: false,
          source: 'NORMALIZED'
        },
        contractSource: 'NORMALIZED',
        referencedInputUnitIds: [],
        outputContractKeys: [],
        exitContractKeys: []
      },
      contextPolicy: {
        permissionLevel: 'DEPENDENCY',
        includeDependencyOutputs: true,
        includeRetrievedContext: true,
        scopedUnitIds: null
      },
      dependencies: [],
      status: 'READY',
      invalidOutputErrors: []
    }
  ];

  const normal = createStageMemoryVirtualization({
    memories: [
      {
        latestUserIntent: 'keep concise',
        lastUserMessageAt: 1,
        keyMilestones: ['AGENT-001: milestone '.repeat(12), 'global milestone '.repeat(12)],
        importantDecisions: ['AGENT-002: decision '.repeat(12)],
        userPreferenceSnapshot: ['preferred language: zh-CN', 'response style: concise']
      }
    ],
    stageUnits,
    runtime: {
      consolidationState: { status: 'IDLE' },
      planner: { fallbackReasons: [] },
      pendingToolBatches: []
    }
  });

  assert.equal(normal.summary.summarizedMilestoneCount > 0, true);
  assert.equal(normal.summary.privateItemCount > 0, true);
  assert.equal(normal.summary.reasons.includes('single_unit_memory_summarized'), true);
  assert.match(normal.memory.keyMilestones[0], /\.\.\./);

  const protectedResult = createStageMemoryVirtualization({
    memories: [
      {
        latestUserIntent: 'keep concise',
        lastUserMessageAt: 1,
        keyMilestones: ['AGENT-001: milestone '.repeat(12)],
        importantDecisions: [],
        userPreferenceSnapshot: []
      }
    ],
    stageUnits,
    runtime: {
      consolidationState: { status: 'CORRECTION_REQUIRED' },
      planner: { fallbackReasons: [] },
      pendingToolBatches: []
    }
  });

  assert.equal(protectedResult.summary.protectedItemCount > 0, true);
  assert.equal(protectedResult.summary.reasons.includes('protected_context_preserved_raw'), true);
  assert.doesNotMatch(protectedResult.memory.keyMilestones[0], /\.\.\./);
});

test('selectStageRelevantValidatedOutputs drops stage-irrelevant visible records', () => {
  const records = [
    { unitId: 'AGENT-001', parsed: { summary: 'needed' } },
    { unitId: 'AGENT-099', parsed: { summary: 'not needed' } }
  ];
  const result = selectStageRelevantValidatedOutputs({
    selectedRecords: records,
    stageUnits: [
      {
        unitId: 'AGENT-010',
        role: 'Verifier',
        goal: 'Verify',
        taskScope: undefined,
        inputContract: undefined,
        outputContract: undefined,
        exitCondition: undefined,
        permissionLevel: 'DEPENDENCY',
        contract: {
          unitId: 'AGENT-010',
          permissionLevel: 'DEPENDENCY',
          inputScope: {
            unitIds: ['AGENT-001'],
            outputKeysByUnitId: { 'AGENT-001': ['summary'] },
            memoryUnitIds: [],
            memoryKinds: [],
            includeGlobalMemory: true,
            structured: true,
            usedCompatibilityFallback: false,
            source: 'STRUCTURED'
          },
          contractSource: 'STRUCTURED',
          referencedInputUnitIds: ['AGENT-001'],
          outputContractKeys: [],
          exitContractKeys: []
        },
        contextPolicy: {
          permissionLevel: 'DEPENDENCY',
          includeDependencyOutputs: true,
          includeRetrievedContext: true,
          scopedUnitIds: ['AGENT-001']
        },
        dependencies: ['AGENT-001'],
        status: 'READY',
        invalidOutputErrors: []
      }
    ],
    runtime: {
      consolidationState: { status: 'IDLE' },
      planner: { fallbackReasons: [] },
      pendingToolBatches: []
    }
  });

  assert.deepEqual(result.records.map((record) => record.unitId), ['AGENT-001']);
  assert.equal(result.summary.filteredOutCount, 1);
  assert.equal(result.summary.rawRecordCount, 1);
  assert.equal(result.summary.reasons.includes('direct_dependencies_prioritized'), true);
});

test('buildTurnPrompt includes applied artifact routing facts for delivery follow-up turns', () => {
  const result = buildTurnPrompt(createInput({
    artifactRouting: {
      artifactPathState: 'applied',
      artifactPaths: ['scratch/live-review-handoff.md'],
      artifactDestinationPaths: ['backend/docs/live-review/scratch/live-review-handoff.md'],
      selectedArtifactDir: 'backend/docs/live-review',
      recommendedArtifactDir: 'backend/docs',
      lastArtifactApplyStatus: 'APPLIED',
      lastArtifactApplyMessage: 'Applied 1 artifact(s) to backend/docs/live-review.'
    }
  }));

  assert.match(result.prompt, /ARTIFACT_ROUTING/);
  assert.match(result.prompt, /Artifact path state: applied/);
  assert.match(result.prompt, /Selected destination: backend\/docs\/live-review/);
  assert.match(result.prompt, /Applied destination paths: .*backend\/docs\/live-review\/scratch\/live-review-handoff\.md/);
  assert.match(result.prompt, /Last artifact apply: APPLIED/);
});
