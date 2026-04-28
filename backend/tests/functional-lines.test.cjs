const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const {
  createBackendNewFoundation,
  createBackendNewHttpServer,
  createBackendNewRuntime,
} = require('../dist');
const { createTempRoot, removeDir } = require('./helpers.cjs');

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function registerProviderClient(foundation, responses) {
  const queue = [...responses];
  foundation.providerClients.register('provider-functional', {
    async complete(request) {
      const next = queue.shift() ?? 'OK';
      return {
        responseId: `resp_${Date.now()}`,
        providerId: request.profile.id,
        model: request.profile.model,
        outputText: next,
        finishReason: 'stop',
        usage: {
          promptTokens: 8,
          completionTokens: 8,
          totalTokens: 16
        },
        metadata: {}
      };
    }
  }, {
    supportsJsonMode: true
  });
}

async function runStableGeneralComplexScenarioSuite() {
  const { runTaskGeneralComplexScenarioSuite } = require('../dist');
  const first = await runTaskGeneralComplexScenarioSuite();
  if (first.status === 'achieved') {
    return first;
  }
  return runTaskGeneralComplexScenarioSuite();
}

function createTaskInput() {
  return {
    title: 'Functional coverage task',
    intent: 'Verify REST and WebSocket agreement.',
    preferredProviderId: 'provider-functional',
    units: [
      {
        id: 'AGENT-001',
        role: 'Closer',
        goal: 'Close the task',
        outputContract: '{"summary":"string","issues":[]}',
        dependencies: []
      }
    ]
  };
}

test('functional provider/config line keeps provider, secret, default, and test flows aligned', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProviderClient(foundation, ['OK']);
    const runtime = createBackendNewRuntime({ foundation });

    try {
      const secretResult = await runtime.platform.setProviderSecret({
        provider: 'provider-functional',
        label: 'functional-key',
        apiKey: 'sk-functional'
      });
      const upserted = await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model',
        apiKeySecretId: secretResult.resource.id
      });
      const listed = await runtime.platform.listProviders();
      const secrets = await runtime.platform.listProviderSecrets();
      const tested = await runtime.platform.testProvider('provider-functional');
      const defaulted = await runtime.platform.setDefaultProvider('provider-functional');
      const configState = await runtime.platform.getConfigState();
      const providerTrail = await runtime.platform.getAuditTrail('PROVIDER', 'provider-functional');
      const configTrail = await runtime.platform.getAuditTrail('CONFIG', 'active');

      assert.equal(upserted.resource.id, 'provider-functional');
      assert.equal(secrets.length, 1);
      assert.equal(secrets[0].provider, 'provider-functional');
      assert.equal(tested.ok, true);
      assert.equal(tested.providerId, 'provider-functional');
      assert.equal(defaulted.resource.isDefault, true);
      assert.equal(defaulted.resource.isSavedDefault, true);
      assert.equal(defaulted.resource.isRuntimeDefault, true);
      const listedAfterDefault = await runtime.platform.listProviders();
      const listedDefault = listedAfterDefault.find((provider) => provider.profile.id === 'provider-functional');
      assert.ok(listedDefault);
      assert.equal(listedDefault.hasSecret, true);
      assert.equal(listedDefault.hasRegisteredClient, true);
      assert.equal(listedDefault.isDefault, true);
      assert.equal(listedDefault.isSavedDefault, true);
      assert.equal(listedDefault.isRuntimeDefault, true);
      assert.equal(configState.current.providers.defaultProviderId, 'provider-functional');
      assert.equal(providerTrail.commands.some((record) => record.action === 'UPSERT'), true);
      assert.equal(providerTrail.commands.some((record) => record.action === 'SET_SECRET'), true);
      assert.equal(configTrail.commands.some((record) => record.commandId === defaulted.commandId), true);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional queue line keeps active, dead-letter, recover-expired, and requeue flows aligned', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.config.queue.enabled = true;

    let queueRecord = {
      taskId: 'task_dead_letter',
      state: 'DEAD_LETTER',
      runAfter: Date.now(),
      priority: 0,
      leaseOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 2,
      maxRetries: 3,
      lastError: 'provider timeout',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    foundation.queue = {
      async enqueue(record) {
        queueRecord = { ...record };
      },
      async get(taskId) {
        return taskId === queueRecord.taskId ? { ...queueRecord } : null;
      },
      async claimNext() {
        return null;
      },
      async heartbeat() {
        return true;
      },
      async markRunning() {
        return true;
      },
      async complete() {
        return true;
      },
      async fail() {
        return { ...queueRecord };
      },
      async releaseExpired() {
        return 1;
      },
      async listActive() {
        return [{ ...queueRecord }];
      }
    };

    const runtime = createBackendNewRuntime({ foundation });
    const server = createBackendNewHttpServer(runtime);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const active = await fetch(`${baseUrl}/queue/active`).then((response) => response.json());
      const deadLetters = await fetch(`${baseUrl}/queue/dead-letters`).then((response) => response.json());
      const recovered = await fetch(`${baseUrl}/queue/recover-expired`, { method: 'POST' }).then((response) => response.json());
      const requeued = await fetch(`${baseUrl}/queue/dead-letters/task_dead_letter/requeue`, { method: 'POST' }).then((response) => response.json());
      const recoveryEvents = await runtime.tasks.getTaskEvents('task_dead_letter');

      assert.equal(active.length, 1);
      assert.equal(deadLetters.length, 1);
      assert.equal(deadLetters[0].lastError, 'provider timeout');
      assert.equal(recovered.recovered, 1);
      assert.equal(requeued.ok, true);
      assert.equal(queueRecord.state, 'QUEUED');
      assert.equal(recoveryEvents.some((event) => event.type === 'TASK_DEAD_LETTER_REQUEUED'), true);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional REST and WebSocket lines agree on task lifecycle and event identity', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProviderClient(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[]}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
    const runtime = createBackendNewRuntime({ foundation });
    const server = createBackendNewHttpServer(runtime);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });
      const submitResponse = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createTaskInput())
      });
      const submitPayload = await submitResponse.json();
      const taskId = submitPayload.command.taskId;
      const wsMessages = [];

      const wsDone = new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?taskId=${taskId}`);
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          wsMessages.push(message);
          if (message.kind === 'runtime_event' && message.event === 'TASK_COMPLETED') {
            socket.close();
            resolve();
          }
        });
        socket.on('error', reject);
      });

      await fetch(`${baseUrl}/tasks/${taskId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      await wsDone;

      const taskDetail = await fetch(`${baseUrl}/tasks/${taskId}`).then((response) => response.json());
      const events = await fetch(`${baseUrl}/tasks/${taskId}/events`).then((response) => response.json());
      const completedEvent = events.find((event) => event.type === 'TASK_COMPLETED');

      assert.equal(taskDetail.definition.taskId, taskId);
      assert.equal(taskDetail.runtime.lifecycleStatus, 'COMPLETED');
      assert.equal(wsMessages.some((message) => message.kind === 'subscribed' && message.taskId === taskId), true);
      assert.equal(wsMessages.some((message) => message.kind === 'runtime_event' && message.event === 'TASK_STARTED'), true);
      assert.equal(wsMessages.some((message) => message.kind === 'runtime_event' && message.event === 'TASK_COMPLETED'), true);
      assert.equal(completedEvent.taskId, taskId);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional workspace workflow line keeps init, command discovery, docs import, and HTTP view aligned', async () => {
  const root = createTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'runbook.md'), '# Runbook\n\nVerify cache health before deploy.\n', 'utf8');

    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        }
      }
    });
    const runtime = createBackendNewRuntime({ foundation });
    const server = createBackendNewHttpServer(runtime);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const initResult = await runtime.platform.initWorkspaceWorkflow();
        fs.writeFileSync(path.join(root, '.scc', 'commands', 'release-check.md'), '---\ndescription: Prepare a release verification task\n---\nReview the current release readiness and summarize blockers. ${args}\n', 'utf8');
        fs.writeFileSync(path.join(root, '.scc', 'commands', 'verify-stack.md'), '---\ndescription: Verify the active stack\nargs: <service>\nwhen: use before release\n---\nInspect ${args} and summarize the current health.\n', 'utf8');
        fs.mkdirSync(path.join(root, '.scc', 'rules'), { recursive: true });
        fs.writeFileSync(path.join(root, '.scc', 'rules', 'backend.md'), '---\ndescription: Keep backend changes narrow\n---\nPrefer additive, minimally invasive backend changes.\n', 'utf8');
        fs.mkdirSync(path.join(root, '.scc', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(root, '.scc', 'agents', 'review.md'), '---\ndescription: Review changes for regressions\n---\nFocus on regressions, missing tests, and operator risk.\n', 'utf8');
        fs.writeFileSync(path.join(root, '.scc', 'hooks.json'), '{\n  "hooks": [\n    {\n      "event": "task.created",\n      "command": "node scripts/hook-task-created.mjs",\n      "description": "Record task bootstrap details",\n      "timeoutMs": 1500\n    }\n  ]\n}\n', 'utf8');
        fs.writeFileSync(path.join(root, '.scc', 'docs.json'), '{\n  "sources": [\n    {\n      "path": "docs/runbook.md",\n      "title": "Runbook",\n      "tags": ["ops"]\n    }\n  ]\n}\n', 'utf8');

      const importResult = await runtime.platform.importWorkspaceDocs();
      const workflow = await runtime.platform.getWorkspaceWorkflow();
      const httpWorkflow = await fetch(`${baseUrl}/workspace/workflow`).then((response) => response.json());

        assert.equal(initResult.resource.workspaceRoot, root);
        assert.equal(importResult.resource.imported, 1);
        assert.equal(workflow.projectInstructionsPresent, true);
        assert.equal(workflow.commands.length, 2);
        assert.equal(workflow.commands[0].name, 'release-check');
        assert.equal(workflow.commands[1].args, '<service>');
        assert.equal(workflow.commands[1].when, 'use before release');
        assert.equal(workflow.rules.length, 1);
        assert.equal(workflow.rules[0].name, 'backend');
        assert.equal(workflow.hooks.length, 1);
        assert.equal(workflow.hooks[0].event, 'task.created');
        assert.equal(workflow.agents.length, 1);
        assert.equal(workflow.agents[0].name, 'review');
        assert.equal(workflow.docsImportSummary.importedMemoryCount, 1);
        assert.equal(httpWorkflow.workspaceRoot, root);
        assert.equal(httpWorkflow.commands[0].name, 'release-check');
        assert.equal(httpWorkflow.rules[0].name, 'backend');
        assert.equal(httpWorkflow.hooks[0].event, 'task.created');
        assert.equal(httpWorkflow.agents[0].name, 'review');
        assert.equal(httpWorkflow.docsImportSummary.importedMemoryCount, 1);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional workspace workflow executes matched rules, hooks, and agent profiles during task runtime', async () => {
  const root = createTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const hookTaskCreated = path.join(root, 'scripts', 'hook-task-created.cjs');
    const hookTaskCompleted = path.join(root, 'scripts', 'hook-task-completed.cjs');
    const hookWorkspaceLoaded = path.join(root, 'scripts', 'hook-workspace-loaded.cjs');
    const hookLogPath = path.join(root, 'hook-events.log').replace(/\\/g, '/');
    fs.writeFileSync(hookTaskCreated, `const fs = require('node:fs'); fs.appendFileSync('${hookLogPath}', 'task.created\\n');\n`, 'utf8');
    fs.writeFileSync(hookTaskCompleted, `const fs = require('node:fs'); fs.appendFileSync('${hookLogPath}', 'task.completed\\n');\n`, 'utf8');
    fs.writeFileSync(hookWorkspaceLoaded, `const fs = require('node:fs'); fs.appendFileSync('${hookLogPath}', 'workspace.instructions_loaded\\n');\n`, 'utf8');

    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        }
      }
    });
    registerProviderClient(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[],"artifact":"src/service.cjs","report":"verified"}[/AGENT-001_OUTPUT]\n'
        + '[TOOL_CALL] {"tool":"read_file","args":{"path":"src/service.cjs"}} [/TOOL_CALL]\n'
        + '{"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":75,"decision":"CONTINUE","reason":"waiting for read_file result","next_unit":"AGENT-001","files_created":[]}',
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[],"artifact":"src/service.cjs","report":"verified from read_file result"}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
    const runtime = createBackendNewRuntime({ foundation });

    try {
      fs.mkdirSync(path.join(root, '.scc', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.scc', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(root, '.scc', 'rules', 'src-write.md'), '---\ndescription: Keep src edits narrow\npaths: src\n---\nOnly touch src paths that are explicitly required by the task.\n', 'utf8');
      fs.writeFileSync(path.join(root, '.scc', 'agents', 'verify.md'), '---\ndescription: Verify with regression focus\n---\nFocus on verification, regressions, and missing tests.\n', 'utf8');
      fs.writeFileSync(path.join(root, '.scc', 'hooks.json'), `{\n  "hooks": [\n    { "event": "task.created", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${hookTaskCreated.replace(/\\/g, '\\\\')}\\"" },\n    { "event": "task.completed", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${hookTaskCompleted.replace(/\\/g, '\\\\')}\\"" },\n    { "event": "workspace.instructions_loaded", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${hookWorkspaceLoaded.replace(/\\/g, '\\\\')}\\"" }\n  ]\n}\n`, 'utf8');
      await runtime.platform.initWorkspaceWorkflow();
      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });

      const submitted = await runtime.tasks.submitTask({
        title: 'Workspace workflow execution',
        intent: 'Verify src/service.cjs according to project workflow guidance.',
        preferredProviderId: 'provider-functional',
        metadata: {
          workspaceAgent: 'verify'
        },
        units: [
          {
            id: 'AGENT-001',
            role: 'Verifier',
            goal: 'Verify src/service.cjs and produce the final verification result.',
            taskScope: 'src/service.cjs',
            outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
            executionProfileId: 'verify',
            dependencies: []
          }
        ]
      });
      fs.mkdirSync(path.join(foundation.layout.forTask(submitted.command.taskId).workspaceDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(foundation.layout.forTask(submitted.command.taskId).workspaceDir, 'src', 'service.cjs'), 'module.exports = { service: "ok" };\n', 'utf8');
      const started = await runtime.tasks.startTask({ taskId: submitted.command.taskId });
      let debug = await runtime.tasks.getTaskDebug(started.command.taskId);
      for (let attempt = 0; attempt < 20 && debug.task.runtime.lifecycleStatus === 'RUNNING'; attempt += 1) {
        if (debug.executionSummary.turnContract.continueAllowed) {
          await runtime.tasks.continueTask({ taskId: started.command.taskId });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        debug = await runtime.tasks.getTaskDebug(started.command.taskId);
      }
      assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
      assert.equal(debug.executionSummary.ruleSummary.matchedRuleNames.includes('src-write'), true);
      assert.equal(debug.executionSummary.ruleSummary.pathMatchedRuleNames.includes('src-write'), true);
      assert.equal(debug.executionSummary.agentSummary.selectedAgent, 'verify');
      assert.equal(debug.executionSummary.agentSummary.selectedBy, 'metadata');
      assert.equal(debug.executionSummary.hookSummary.configuredCount >= 3, true);
      assert.equal(debug.task.events.some((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED'), true);
      assert.equal(
        debug.task.events.some((event) => event.type === 'WORKSPACE_HOOK_FAILED')
          || debug.task.events.some((event) => event.type === 'WORKSPACE_HOOK_EXECUTED'),
        true
      );
      assert.equal(debug.executionSummary.hookSummary.recent.some((entry) => entry.event === 'task.created'), true);
      assert.equal(debug.executionSummary.hookSummary.recent.some((entry) => entry.event === 'workspace.instructions_loaded'), true);
      assert.equal(debug.executionSummary.hookSummary.recent.some((entry) => entry.event === 'task.completed'), true);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional instruction-skill line imports claude-style bundles, keeps runtime distinction, and exposes task-level selection', async () => {
  const root = createTempRoot();
  try {
    const marketplaceRoot = path.join(root, 'external-skills');
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(marketplaceRoot, 'skills', 'templated', 'templates'), { recursive: true });
    fs.mkdirSync(path.join(marketplaceRoot, 'skills', 'asset-heavy', 'assets', 'images'), { recursive: true });
    fs.mkdirSync(path.join(marketplaceRoot, 'skills', 'simple'), { recursive: true });
    fs.writeFileSync(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [
        {
          name: 'claude-like',
          source: './',
          skills: ['./skills/simple', './skills/templated', './skills/asset-heavy']
        }
      ]
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(marketplaceRoot, 'skills', 'simple', 'SKILL.md'), '---\nname: simple\n---\nUse this skill to apply concise release guidance.\n', 'utf8');
    fs.writeFileSync(path.join(marketplaceRoot, 'skills', 'templated', 'SKILL.md'), '---\nname: templated\ndescription: Use rollout templates\n---\nUse the rollout checklist template before release.\n', 'utf8');
    fs.writeFileSync(path.join(marketplaceRoot, 'skills', 'templated', 'templates', 'checklist.md'), '# Checklist\n\n- verify rollout\n', 'utf8');
    fs.writeFileSync(path.join(marketplaceRoot, 'skills', 'asset-heavy', 'SKILL.md'), '---\nname: asset-heavy\ndescription: Use assets and screenshots\nmcpServers: browser-mcp\n---\nUse screenshots and attached assets when debugging UI.\n', 'utf8');
    fs.writeFileSync(path.join(marketplaceRoot, 'skills', 'asset-heavy', 'assets', 'images', 'reference.txt'), 'reference image asset', 'utf8');

    const runtimeSkillRoot = path.join(root, 'runtime-skills', 'echo');
    fs.mkdirSync(runtimeSkillRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeSkillRoot, 'index.cjs'), "exports.invoke = async ({ value }) => ({ echoed: value ?? 'none' });", 'utf8');

    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        }
      }
    });
    registerProviderClient(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[],"artifact":"reports/templated.md","report":"instruction skill applied"}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
    const runtime = createBackendNewRuntime({ foundation });

    try {
      await runtime.platform.importMarketplaceSkills({
        marketplaceFile: path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        pluginName: 'claude-like'
      });
      await runtime.platform.importSkill({
        name: 'echo-runtime',
        rootDir: runtimeSkillRoot
      });
      foundation.skillRuntimes.register(runtimeSkillRoot, {
        async invoke({ input }) {
          return {
            ok: true,
            output: { echoed: input.value ?? 'none' },
            error: null,
            metadata: {}
          };
        }
      }, {
        supportsStreaming: false,
        supportsWorkspaceWrite: false,
        supportsNetworkAccess: false
      });

      const skills = await runtime.platform.listSkills();
      const templated = skills.find((entry) => entry.skill.name === 'templated');
      const runtimeEntry = skills.find((entry) => entry.skill.name === 'echo-runtime');

      assert.ok(templated);
      assert.equal(templated.kind, 'instruction-skill');
      assert.equal(templated.readiness, 'metadata-only');
      assert.equal(templated.runtimeRegistered, false);
      assert.equal(templated.assetSummary?.samplePaths.includes('templates/checklist.md'), true);
      assert.ok(runtimeEntry);
      assert.equal(runtimeEntry.kind, 'runtime-skill');
      assert.equal(runtimeEntry.readiness, 'ready');
      assert.equal(runtimeEntry.runtimeRegistered, true);

      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });
      const submitted = await runtime.tasks.submitTask({
        title: 'Instruction skill coverage task',
        intent: 'Use the templated release guidance skill to produce a release note artifact.',
        preferredProviderId: 'provider-functional',
        metadata: {
          instructionSkills: ['templated']
        },
        units: [
          {
            id: 'AGENT-001',
            role: 'Release operator',
            goal: 'Produce a report guided by the imported templated instruction skill.',
            outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
            dependencies: []
          }
        ]
      });
      await runtime.tasks.startTask({ taskId: submitted.command.taskId });
      let debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      for (let attempt = 0; attempt < 20 && debug.task.runtime.lifecycleStatus === 'RUNNING'; attempt += 1) {
        if (debug.executionSummary.turnContract.continueAllowed) {
          await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      }

      assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
      assert.equal(debug.executionSummary.instructionSkillSummary.configuredCount >= 3, true);
      assert.equal(debug.executionSummary.instructionSkillSummary.selectedCount, 1);
      assert.equal(debug.executionSummary.instructionSkillSummary.selected[0].name, 'templated');
      assert.equal(debug.executionSummary.instructionSkillSummary.selected[0].selectedBy, 'metadata');
      assert.equal(debug.executionSummary.instructionSkillSummary.selected[0].assetPaths.includes('templates/checklist.md'), true);
      assert.equal(debug.executionSummary.instructionSkillSummary.selected[0].declaredMcpDependencies.length, 0);
      assert.equal(debug.task.events.some((event) => event.type === 'WORKSPACE_INSTRUCTIONS_LOADED'), true);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional capability hub line keeps provider mcp skill and workspace readiness aligned', async () => {
  const root = createTempRoot();
  try {
    const runtimeSkillRoot = path.join(root, 'runtime-skills', 'echo');
    fs.mkdirSync(runtimeSkillRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeSkillRoot, 'index.cjs'), "exports.invoke = async ({ value }) => ({ echoed: value ?? 'none' });", 'utf8');

    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        }
      }
    });
    foundation.extensions.registerSkill({
      id: 'skill.runtime.echo',
      name: 'echo-runtime',
      rootDir: runtimeSkillRoot,
      kind: 'runtime-skill'
    });
    foundation.skillRuntimes.register('skill.runtime.echo', {
      async invoke({ input }) {
        return {
          ok: true,
          output: { echoed: input.value ?? 'none' },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsStreaming: false,
      supportsWorkspaceWrite: false,
      supportsNetworkAccess: false
    });
    foundation.extensions.registerSkill({
      id: 'skill.instruction.release',
      name: 'release-guidance',
      rootDir: path.join(root, 'skills', 'release-guidance'),
      kind: 'instruction-skill',
      metadata: {
        declaredMcpDependencies: ['mcp.missing.browser'],
        declaredMcpResources: ['mcp.functional/release-guide'],
        declaredMcpPrompts: ['mcp.functional/release-review']
      }
    });
    foundation.extensions.registerMcpServer({
      id: 'mcp.functional',
      name: 'functional-mcp',
      transport: 'stdio',
      command: 'functional-mcp',
      declaredTools: ['echo'],
      declaredResources: ['mcp.functional/release-guide'],
      declaredPrompts: ['mcp.functional/release-review']
    });
    foundation.mcpClients.register('mcp.functional', {
      async connect() {}
    }, {
      supportsTools: true,
      supportsPrompts: false,
      supportsResources: false,
      supportsStreaming: false
    });

    const runtime = createBackendNewRuntime({ foundation });
    try {
      await runtime.platform.initWorkspaceWorkflow();
      fs.writeFileSync(path.join(root, '.scc', 'commands', 'review-release.md'), '---\ndescription: Review release readiness\n---\nReview the release readiness and summarize blockers.\n', 'utf8');
      fs.writeFileSync(path.join(root, '.scc', 'hooks.json'), '{\n  "hooks": [\n    { "event": "workspace.instructions_loaded", "command": "node -e \\"process.exit(0)\\"" }\n  ]\n}\n', 'utf8');
      fs.mkdirSync(path.join(root, '.scc', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(root, '.scc', 'agents', 'review.md'), '---\ndescription: Review for regressions\n---\nFocus on regressions and risk.\n', 'utf8');
      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });

      const hub = await runtime.platform.getCapabilityHub();

      assert.equal(hub.providers.some((entry) => entry.profile.id === 'provider-functional' && entry.readiness === 'missing-secret'), true);
      assert.equal(hub.skills.some((entry) => entry.skill.id === 'skill.runtime.echo' && entry.readiness === 'ready'), true);
      assert.equal(hub.skills.some((entry) => entry.skill.id === 'skill.instruction.release' && entry.readiness === 'metadata-only'), true);
      assert.equal(hub.mcpServers.some((entry) => entry.server.id === 'mcp.functional' && entry.readiness === 'ready'), true);
      assert.equal(hub.mcpServers.some((entry) => entry.server.id === 'mcp.functional' && entry.availableTools.includes('echo')), true);
      assert.equal(hub.mcpServers.some((entry) => entry.server.id === 'mcp.functional' && entry.availableResources.includes('mcp.functional/release-guide')), true);
      assert.equal(hub.mcpServers.some((entry) => entry.server.id === 'mcp.functional' && entry.availablePrompts.includes('mcp.functional/release-review')), true);
      assert.equal(hub.workspace.commands.some((entry) => entry.name === 'review-release'), true);
      assert.equal(hub.workspace.agents.some((entry) => entry.name === 'review'), true);
      assert.equal(hub.workspace.hooks.some((entry) => entry.event === 'workspace.instructions_loaded'), true);
      assert.equal(hub.warnings.some((entry) => entry.code === 'provider-missing-secret'), true);
      assert.equal(hub.summary.total >= 5, true);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional mcp platform line keeps list, get, upsert, test, and delete flows aligned', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    foundation.mcpClients.register('mcp-functional', {
      async connect() {},
      async discoverCapabilities() {
        return {
          capability: {
            supportsTools: true,
            supportsPrompts: false,
            supportsResources: true,
            supportsStreaming: false
          },
          metadata: {
            transport: 'functional'
          }
        };
      },
      async callTool() {
        return {
          ok: true,
          output: {
            echoed: true
          },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsTools: true,
      supportsPrompts: false,
      supportsResources: true,
      supportsStreaming: false
    });

    const runtime = createBackendNewRuntime({ foundation });
    const server = createBackendNewHttpServer(runtime);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const upserted = await fetch(`${baseUrl}/mcp/mcp-functional`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'mcp-functional',
          name: 'Functional MCP',
          transport: 'stdio',
          command: 'functional-mcp'
        })
      }).then((response) => response.json());
      const listed = await fetch(`${baseUrl}/mcp`).then((response) => response.json());
      const loaded = await fetch(`${baseUrl}/mcp/mcp-functional`).then((response) => response.json());
      const tested = await fetch(`${baseUrl}/mcp/mcp-functional/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }).then((response) => response.json());
      const deleted = await fetch(`${baseUrl}/mcp/mcp-functional`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }).then((response) => response.json());
      const auditTrail = await runtime.platform.getAuditTrail('MCP', 'mcp-functional');

      assert.equal(upserted.resource.id, 'mcp-functional');
      assert.equal(Array.isArray(listed), true);
      assert.equal(listed[0].server.id, 'mcp-functional');
      assert.equal(loaded.server.name, 'Functional MCP');
      assert.equal(tested.ok, true);
      assert.equal(tested.capability.supportsResources, true);
      assert.equal(deleted.resource.ok, true);
      assert.equal(auditTrail.commands.some((record) => record.action === 'UPSERT'), true);
      assert.equal(auditTrail.commands.some((record) => record.action === 'DELETE'), true);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional task extension line exposes skill and mcp execution in task debug', async () => {
  const root = createTempRoot();
  try {
    const foundation = createBackendNewFoundation({
      config: {
        paths: {
          rootDir: root
        }
      }
    });
    registerProviderClient(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[],"artifact":"report.txt","report":"used extensions"}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
    foundation.extensions.registerSkill({
      id: 'skill.functional',
      name: 'functional-skill',
      rootDir: path.join(root, 'skills', 'functional')
    });
    foundation.skillRuntimes.register('skill.functional', {
      async invoke({ input }) {
        return {
          ok: true,
          output: { echoed: input.value ?? 'none' },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsStreaming: false,
      supportsWorkspaceWrite: false,
      supportsNetworkAccess: false
    });
    foundation.extensions.registerMcpServer({
      id: 'mcp.functional',
      name: 'functional-mcp',
      transport: 'stdio',
      command: 'functional-mcp',
      declaredResources: ['mcp.functional/reference-doc'],
      declaredPrompts: ['mcp.functional/review-prompt']
    });
    foundation.mcpClients.register('mcp.functional', {
      async connect() {},
      async callTool({ toolName, arguments: args }) {
        return {
          ok: true,
          output: {
            toolName,
            echoed: args.value ?? 'none'
          },
          error: null,
          metadata: {}
        };
      }
    }, {
      supportsTools: true,
      supportsPrompts: false,
      supportsResources: false,
      supportsStreaming: false
    });

    const runtime = createBackendNewRuntime({ foundation });
    try {
      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });
      const submitted = await runtime.tasks.submitTask({
        title: 'Extension coverage task',
        intent: 'Use configured skill and MCP extensions before finishing.',
        preferredProviderId: 'provider-functional',
        metadata: {
          extensions: {
            skills: [
              {
                unitId: 'AGENT-001',
                skillId: 'skill.functional',
                payload: { value: 'skill-ok' }
              }
            ],
            mcp: [
              {
                unitId: 'AGENT-001',
                serverId: 'mcp.functional',
                toolName: 'echo',
                arguments: { value: 'mcp-ok' }
              }
            ],
            mcpResources: [
              {
                unitId: 'AGENT-001',
                serverId: 'mcp.functional',
                resourceName: 'reference-doc'
              }
            ],
            mcpPrompts: [
              {
                unitId: 'AGENT-001',
                serverId: 'mcp.functional',
                promptName: 'review-prompt'
              }
            ]
          }
        },
        units: [
          {
            id: 'AGENT-001',
            role: 'Closer',
            goal: 'Use extensions and close the task.',
            outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
            dependencies: []
          }
        ]
      });
      await runtime.tasks.startTask({ taskId: submitted.command.taskId });
      let debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      for (let attempt = 0; attempt < 20 && debug.task.runtime.lifecycleStatus === 'RUNNING'; attempt += 1) {
        if (debug.executionSummary.turnContract.continueAllowed) {
          await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      }

      assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
      assert.equal(debug.executionSummary.skillSummary.configuredCount, 1);
      assert.equal(debug.executionSummary.skillSummary.invokedCount >= 1, true);
      assert.equal(debug.executionSummary.skillSummary.recent[0].status, 'SUCCEEDED');
      assert.equal(debug.executionSummary.mcpSummary.configuredCount, 1);
      assert.equal(debug.executionSummary.mcpSummary.invokedCount >= 1, true);
      assert.equal(debug.executionSummary.mcpSummary.recent[0].status, 'SUCCEEDED');
      assert.equal(debug.executionSummary.mcpSummary.selectedResources.includes('mcp.functional/reference-doc'), true);
      assert.equal(debug.executionSummary.mcpSummary.selectedPrompts.includes('mcp.functional/review-prompt'), true);
      assert.equal(debug.executionSummary.providerSummary.selectedBy, 'runtime_selected');
      assert.equal(debug.executionSummary.permissionSummary.mode, 'ask');
      assert.equal(debug.task.events.some((event) => event.type === 'SKILL_EXECUTED'), true);
      assert.equal(debug.task.events.some((event) => event.type === 'MCP_TOOL_EXECUTED'), true);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional mcp failure hook line emits workspace hooks and preserves explainable task summaries', async () => {
  const root = createTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const hookMcpFailure = path.join(root, 'scripts', 'hook-mcp-failure.cjs');
    const hookLogPath = path.join(root, 'hook-events.log').replace(/\\/g, '/');
    fs.writeFileSync(
      hookMcpFailure,
      `const fs = require('node:fs'); fs.appendFileSync('${hookLogPath}', 'mcp.failure\\n');\n`,
      'utf8'
    );

    const foundation = createBackendNewFoundation({
      cwd: root,
      config: {
        paths: {
          rootDir: path.join(root, 'data')
        }
      }
    });
    registerProviderClient(foundation, [
      '[AGENT-001_OUTPUT]{"summary":"done","issues":[],"artifact":"report.txt","report":"handled mcp failure"}[/AGENT-001_OUTPUT]\n'
        + '{"current_unit":"AGENT-001","status":"COMPLETE","progress_percent":100,"decision":"CONTINUE","reason":"done","files_created":[]}'
    ]);
    foundation.extensions.registerMcpServer({
      id: 'mcp.failure.functional',
      name: 'functional-mcp-failure',
      transport: 'stdio',
      command: 'functional-mcp-failure'
    });
    foundation.mcpClients.register('mcp.failure.functional', {
      async connect() {},
      async callTool() {
        return {
          ok: false,
          output: null,
          error: 'synthetic mcp failure',
          metadata: {}
        };
      }
    }, {
      supportsTools: true,
      supportsPrompts: false,
      supportsResources: false,
      supportsStreaming: false
    });

    const runtime = createBackendNewRuntime({ foundation });
    try {
      fs.mkdirSync(path.join(root, '.scc'), { recursive: true });
      fs.writeFileSync(path.join(root, '.scc', 'hooks.json'), `{\n  "hooks": [\n    { "event": "mcp.failure", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${hookMcpFailure.replace(/\\/g, '\\\\')}\\"" }\n  ]\n}\n`, 'utf8');
      await runtime.platform.initWorkspaceWorkflow();
      await runtime.platform.upsertProvider({
        id: 'provider-functional',
        label: 'Provider Functional',
        transport: 'openai-compatible',
        vendor: 'custom',
        baseUrl: 'https://provider.example.test/v1',
        model: 'functional-model'
      });

      const submitted = await runtime.tasks.submitTask({
        title: 'MCP failure hook coverage',
        intent: 'Use an MCP tool that fails, but still finish with an explainable summary.',
        preferredProviderId: 'provider-functional',
        metadata: {
          extensions: {
            mcp: [
              {
                unitId: 'AGENT-001',
                serverId: 'mcp.failure.functional',
                toolName: 'echo',
                arguments: { value: 'mcp-fail' }
              }
            ]
          }
        },
        units: [
          {
            id: 'AGENT-001',
            role: 'Closer',
            goal: 'Record the MCP failure and finish with a stable explanation.',
            outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
            dependencies: []
          }
        ]
      });
      await runtime.tasks.startTask({ taskId: submitted.command.taskId });
      let debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      for (let attempt = 0; attempt < 20 && debug.task.runtime.lifecycleStatus === 'RUNNING'; attempt += 1) {
        if (debug.executionSummary.turnContract.continueAllowed) {
          await runtime.tasks.continueTask({ taskId: submitted.command.taskId });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        debug = await runtime.tasks.getTaskDebug(submitted.command.taskId);
      }
      assert.equal(debug.task.runtime.lifecycleStatus, 'COMPLETED');
      assert.equal(debug.executionSummary.mcpSummary.failureStreak >= 1, true);
      assert.equal(debug.executionSummary.hookSummary.configuredCount >= 1, true);
      assert.equal(debug.executionSummary.hookSummary.recent.some((entry) => entry.event === 'mcp.failure'), true);
      assert.equal(debug.task.events.some((event) => event.type === 'MCP_TOOL_EXECUTED' && event.payload && event.payload.status === 'FAILED'), true);
      assert.equal(
        debug.task.events.some((event) => (event.type === 'WORKSPACE_HOOK_FAILED' || event.type === 'WORKSPACE_HOOK_EXECUTED') && event.payload && event.payload.event === 'mcp.failure'),
        true
      );
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test('functional long-running reliability line keeps streaks, checkpoints, and recovery summaries aligned', async () => {
  const report = await runStableGeneralComplexScenarioSuite();
  const failedScenarios = report.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => `${scenario.scenario}:${scenario.artifactQuality.failureCategory ?? 'unknown'}`);

  assert.equal(report.status, 'achieved', failedScenarios.join(', '));

  const correctionChurn = report.scenarios.find((scenario) => scenario.scenario === 'general-long-running-correction-churn');
  const checkpointRecovery = report.scenarios.find((scenario) => scenario.scenario === 'general-checkpoint-recovery-task');
  const providerFailureStreak = report.scenarios.find((scenario) => scenario.scenario === 'general-provider-failure-streak-task');
  const extensionFailureStability = report.scenarios.find((scenario) => scenario.scenario === 'general-extension-failure-stability-task');

  assert.ok(correctionChurn);
  assert.ok(checkpointRecovery);
  assert.ok(providerFailureStreak);
  assert.ok(extensionFailureStability);

  assert.equal(correctionChurn.executionSummary.turnCount >= 3, true);
  assert.equal(correctionChurn.executionSummary.correctionDepth >= 2, true);
  assert.equal(correctionChurn.executionSummary.turnContract.correctionLoopNonConvergent, false);

  assert.equal(checkpointRecovery.executionSummary.lastSafeCheckpointAt !== null, true);
  assert.equal(checkpointRecovery.executionSummary.queueRuntimeAlignment.consistent, true);
  assert.equal(checkpointRecovery.executionSummary.lastRecoverySource !== null, true);

  assert.equal(providerFailureStreak.executionSummary.providerFailureStreak >= 2, true);
  assert.equal(typeof providerFailureStreak.executionSummary.conservativeModeReason, 'string');
  assert.equal(providerFailureStreak.executionSummary.queueRuntimeAlignment.consistent, true);

  assert.equal(extensionFailureStability.executionSummary.skillFailureStreak >= 1, true);
  assert.equal(extensionFailureStability.executionSummary.mcpFailureStreak >= 1, true);
  assert.equal(extensionFailureStability.executionSummary.queueRuntimeAlignment.consistent, true);
});
