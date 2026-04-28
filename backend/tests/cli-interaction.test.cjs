const test = require('node:test');
const assert = require('node:assert/strict');
const { CliChatSessionController } = require('../dist/interfaces/cli/chat/session/session-controller.js');

function createResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

test('interactive chat help and capability commands expose summary-first operator guidance', async () => {
  const envelopes = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/workspace/workflow') {
      return createResponse({
        workspaceRoot: 'D:/workspace',
        projectInstructionsPresent: true,
        projectInstructionsSummary: 'Follow workspace constraints.',
        commands: [],
        rules: [],
        hooks: [],
        agents: [{ name: 'review', description: 'Review changes' }],
        docsSources: [],
        docsImportSummary: {
          trackedSourceCount: 0,
          importedMemoryCount: 0,
        },
      });
    }
    if (parsed.pathname === '/providers') {
      return createResponse([
        {
          profile: { id: 'provider-main', label: 'Provider Main' },
          readiness: 'ready',
          authSource: 'secret-store',
          adapter: { vendor: 'openai-compatible', transport: 'openai-compatible' },
          model: { modelId: 'gpt-5.4' },
          variant: { variantId: 'reasoning' },
        },
      ]);
    }
    if (parsed.pathname === '/skills') {
      return createResponse([
        {
          skill: { id: 'review-skill', name: 'Review Skill' },
          kind: 'instruction-skill',
          readiness: 'metadata-only',
        },
      ]);
    }
    if (parsed.pathname === '/mcp') {
      return createResponse([
        {
          server: { id: 'docs', name: 'Docs MCP' },
          readiness: 'ready',
          availableTools: ['search_docs'],
          availableResources: ['docs://runbook'],
          availablePrompts: ['triage'],
        },
      ]);
    }
    if (parsed.pathname === '/statistics') {
      return createResponse({
        taskCounts: { RUNNING: 1, COMPLETED: 3 },
        providers: 1,
        skills: 1,
      });
    }
    if (parsed.pathname === '/capabilities') {
      return createResponse({
        summary: { total: 4, ready: 3, partial: 1, blocked: 0 },
        warnings: [],
        entries: [],
        workspace: { commands: [], agents: [], rules: [], hooks: [] },
      });
    }
    if (parsed.pathname === '/tasks/task-1/debug') {
      return createResponse({
        task: {
          definition: { taskId: 'task-1', title: 'Task 1', intent: 'Inspect' },
          runtime: { lifecycleStatus: 'RUNNING', engineStatus: 'RUNNING', currentUnitId: 'AGENT-001' },
          queue: null,
          pendingApprovals: [],
          diagnostics: { lastError: null, providerFailure: null },
          events: [],
        },
        executionSummary: {
          issueSummary: null,
          correctionDepth: 0,
          providerFailureStreak: 0,
          skillFailureStreak: 0,
          mcpFailureStreak: 0,
          lastSafeCheckpointAt: null,
          lastRecoverySource: null,
          conservativeModeReason: null,
          queueRuntimeAlignment: { consistent: true, summary: 'aligned' },
          turnContract: { pendingCorrection: 'NONE', continueReason: null, correctionLoopNonConvergent: false },
          providerSummary: { providerId: 'provider-main', modelId: 'gpt-5.4', variantId: 'reasoning', selectedBy: 'config_default', readiness: 'ready', authSource: 'secret-store', recentStatus: 'selected' },
          instructionSkillSummary: { configuredCount: 1, selectedCount: 1, selected: [] },
          skillSummary: { configuredCount: 1, availableCount: 0, invokedCount: 0, recent: [] },
          mcpSummary: { configuredCount: 1, availableCount: 1, invokedCount: 0, selectedServerIds: ['docs'], selectedTools: ['search_docs'], selectedResources: ['docs://runbook'], selectedPrompts: ['triage'], readinessSummary: { ready: ['docs'], missingClient: [], metadataOnly: [] }, recent: [] },
          permissionSummary: { mode: 'ask', approvalRequiredCount: 1, deniedCount: 0, recent: [] },
          agentSummary: { configuredCount: 1, selectedAgent: 'review', selectedBy: 'workspace_agent' },
          hookSummary: { configuredCount: 1, executedCount: 0, failedCount: 0, recent: [] },
          capabilityWarnings: [],
        },
      });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const controller = new CliChatSessionController({
    mode: 'workspace',
    context: {
      args: { command: [], flags: {} },
      fetchImpl,
      io: { stdout: { write() {} }, stderr: { write() {} } },
      stdin: process.stdin,
      createWebSocket: () => {
        throw new Error('websocket not needed');
      },
      sleep: async () => {},
      serverUrl: 'http://127.0.0.1:3011',
    },
    args: { command: [], flags: {} },
    outputFormat: 'human',
    onEnvelope: (envelope) => envelopes.push(envelope),
  });

  controller.state.activeTaskId = null;
  controller.state.latestTaskSummary = {
    taskId: 'task-1',
    title: 'Task 1',
    lifecycleStatus: 'RUNNING',
    progressState: 'running',
    stageLabel: 'Stage 1 of 2',
    blockingReason: 'Runtime is actively progressing through the current unit.',
    nextAction: 'Monitor runtime',
    nextActionReason: 'No blocker is active.',
    providerSummary: {
      providerId: 'provider-main',
      modelId: 'gpt-5.4',
      variantId: 'reasoning',
      selectedBy: 'config_default',
      readiness: 'ready',
      authSource: 'secret-store',
      recentStatus: 'selected',
    },
    skillSummary: { configuredCount: 1, availableCount: 0, invokedCount: 0 },
    instructionSkillSummary: { configuredCount: 1, selectedCount: 1 },
    mcpSummary: {
      selectedServerIds: ['docs'],
      selectedTools: ['search_docs'],
      selectedResources: ['docs://runbook'],
      selectedPrompts: ['triage'],
      readinessSummary: { ready: ['docs'], missingClient: [], metadataOnly: [] },
    },
    permissionSummary: { mode: 'ask', approvalRequiredCount: 1, deniedCount: 0 },
    agentSummary: { selectedAgent: 'review', selectedBy: 'workspace_agent' },
    hookSummary: { executedCount: 0, failedCount: 0 },
    capabilityWarnings: [],
  };

  await controller.handleInput('/help');
  await controller.handleInput('/provider');
  await controller.handleInput('/skills');
  await controller.handleInput('/mcp');
  await controller.handleInput('/agent');
  await controller.handleInput('/permissions');
  await controller.handleInput('/cost');
  await controller.setViewMode('capabilities');

  const infoMessages = envelopes
    .filter((envelope) => envelope.type === 'info')
    .map((envelope) => envelope.message)
    .join('\n\n');
  const capabilityView = envelopes.find((envelope) => envelope.type === 'view' && envelope.view === 'capabilities');

  assert.match(infoMessages, /\/provider/);
  assert.match(infoMessages, /\/model/);
  assert.match(infoMessages, /\/permissions/);
  assert.match(infoMessages, /Current provider: provider-main/);
  assert.match(infoMessages, /Skill catalog:/);
  assert.match(infoMessages, /Configured MCP servers:/);
  assert.match(infoMessages, /Selected agent: review/);
  assert.match(infoMessages, /Permission mode: ask/);
  assert.match(infoMessages, /Provider billing: unavailable in local default runtime/);
  assert.ok(capabilityView);
});
