import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import {
  readXiaomiMimoFlashProviderSource,
  XIAOMI_MIMO_STRONG_MODEL,
} from './lib/xiaomi-mimo-live-provider.mjs';
import { resolveLiveCostProbeReportPath } from './lib/live-cost-guard.mjs';

const rootDir = process.cwd();
const require = createRequire(import.meta.url);
const { buildTurnPrompt, loadBackendNewConfig } = require(path.resolve(rootDir, 'backend', 'dist', 'index.js'));
const { OpenAiCompatibleProviderClient } = require(path.resolve(
  rootDir,
  'backend',
  'dist',
  'application',
  'adapters',
  'providers',
  'openai-compatible-client.js'
));

function createRuntime(overrides = {}, options = {}) {
  const providerModel = options.providerModel ?? 'mimo-v2.5';
  return {
    taskId: 'task_live_cost_probe',
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
    latestSessionId: 'sess_probe',
    latestCorrelationId: 'corr_probe',
    latestTurnId: 'turn_probe',
    latestCheckpointId: 'ckpt_probe',
    selectedProviderId: 'xiaomi-mimo-v2-flash',
    llmContextMessages: [],
    llmContextSnapshotRef: null,
    conversationSnapshotRef: null,
    pendingOperatorInputs: [],
    interrupt: {
      pauseRequested: false,
      interruptRequested: false,
      cancelRequested: false,
      requestedAt: null,
      reason: null
    },
    executionLease: {
      active: false,
      phase: 'IDLE',
      leaseId: null,
      startedAt: null,
      replayable: true
    },
    safePoint: {
      stage: 'IDLE',
      reachedAt: null,
      interruptible: true
    },
    memory: {
      latestUserIntent: 'Keep the response concise and structured.',
      lastUserMessageAt: 1,
      keyMilestones: ['AGENT-000: probe bootstrapped'],
      importantDecisions: [`provider: ${providerModel}`],
      userPreferenceSnapshot: ['response style: concise']
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
    contextCompressionCount: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function createPromptInput(runtimeOverrides = {}, options = {}) {
  const providerModel = options.providerModel ?? 'mimo-v2.5';
  const providerLabel = options.providerLabel ?? `Xiaomi Mimo ${providerModel}`;
  const config = loadBackendNewConfig({
    runtime: {
      maxContextMessages: 6,
      retainedContextMessages: 2,
      promptSectionCharacterLimit: 240,
      promptMaxSummaryItems: 2
    },
    tools: {
      permissionMode: 'ask'
    }
  }, { cwd: rootDir, env: {} });

  return {
    config,
    definition: {
      taskId: 'task_live_cost_probe',
      title: 'Live Cost Probe',
      intent: 'Verify canonical provider truth and prompt prefix stability.',
      preferredProviderId: 'xiaomi-mimo-v2-flash',
      createdAt: 1,
      metadata: {},
      units: [
        {
          id: 'AGENT-001',
          role: 'Generalist',
          goal: 'Return a short grounded acknowledgement.',
          outputContract: '{"summary":"string","issues":[]}',
          executionProfileId: 'analyze',
          dependencies: []
        }
      ]
    },
    runtime: createRuntime(runtimeOverrides, options),
    currentUnit: {
      id: 'AGENT-001',
      role: 'Generalist',
      goal: 'Return a short grounded acknowledgement.',
      outputContract: '{"summary":"string","issues":[]}',
      executionProfileId: 'analyze',
      dependencies: []
    },
    validatedOutputs: [],
    pendingInvocations: [],
    pendingApprovals: [],
    provider: {
      id: 'xiaomi-mimo-v2-flash',
      vendor: 'openai',
      transport: 'openai-compatible',
      model: providerModel,
      label: providerLabel
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
          name: 'read_file',
          effect: 'READ',
          riskLevel: 'LOW',
          supportsApprovalResume: true,
          maxExecutionMs: 2000
        }
      ],
      skills: [
        {
          name: 'probe-skill',
          supportsStreaming: false,
          supportsWorkspaceWrite: false,
          supportsNetworkAccess: false
        }
      ],
      mcpServers: []
    },
    userProfile: {
      profileId: 'default',
      preferredLanguage: 'en',
      responseStyle: 'concise',
      modelPreference: 'cloud',
      workflowPreferences: ['verification-first'],
      notableHabits: ['expects explicit evidence'],
      lastUpdatedAt: 1
    },
    workspaceProjectInstructions: 'Keep responses short and structured.',
    workspaceRuleInstructions: 'Do not fabricate file writes or tool evidence.',
    workspaceApprovedExperienceInstructions: 'Summarize only the stable contract, not volatile runtime chatter.',
    workspaceCommandInstructions: 'command=probe; description=cost and cache probe',
    importedWorkspaceDocs: [
      {
        title: 'Probe Note',
        sourcePath: 'docs/probe-note.md',
        content: 'This probe measures stable prompt prefix and provider usage telemetry.'
      }
    ]
  };
}

function normalizeUsageValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNestedUsageValue(record, pathSegments) {
  let current = record;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = current[segment];
  }
  return normalizeUsageValue(current);
}

function normalizeUsage(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedPromptTokens: null,
      cacheWritePromptTokens: null,
      providerReportedUsage: null
    };
  }
  return {
    promptTokens: normalizeUsageValue(record.prompt_tokens ?? record.promptTokens),
    completionTokens: normalizeUsageValue(record.completion_tokens ?? record.completionTokens),
    totalTokens: normalizeUsageValue(record.total_tokens ?? record.totalTokens),
    cachedPromptTokens:
      readNestedUsageValue(record, ['prompt_tokens_details', 'cached_tokens'])
      ?? readNestedUsageValue(record, ['input_tokens_details', 'cached_tokens'])
      ?? normalizeUsageValue(record.cache_read_input_tokens)
      ?? normalizeUsageValue(record.cachedPromptTokens),
    cacheWritePromptTokens:
      readNestedUsageValue(record, ['prompt_tokens_details', 'cache_write_tokens'])
      ?? readNestedUsageValue(record, ['input_tokens_details', 'cache_write_tokens'])
      ?? normalizeUsageValue(record.cache_creation_input_tokens)
      ?? normalizeUsageValue(record.cacheWritePromptTokens),
    providerReportedUsage: record
  };
}

function createProviderRequest(source, promptText, turnIndex) {
  return {
    profile: {
      id: source.providerId,
      label: source.label,
      transport: 'openai-compatible',
      vendor: 'openai',
      baseUrl: source.baseUrl,
      model: source.model,
      apiKey: source.apiKey,
      auth: {
        scheme: 'bearer',
        headerName: 'authorization',
        prefix: 'Bearer'
      },
      endpoints: {
        chatCompletionsPath: '/chat/completions'
      },
      apiVersion: null,
      organization: null,
      project: null,
      headers: {}
    },
    context: {
      taskId: 'task_live_cost_probe',
      unitId: 'AGENT-001',
      sessionId: `sess_probe_${turnIndex}`,
      correlationId: `corr_probe_${turnIndex}`,
      turnId: `turn_probe_${turnIndex}`,
      checkpointId: `ckpt_probe_${turnIndex}`
    },
    messages: [
      { role: 'system', content: promptText },
      { role: 'user', content: 'Return a short acknowledgement sentence.' }
    ],
    temperature: 0,
    maxTokens: 48,
    metadata: {
      timeoutMs: 45000,
      maxRetries: 2,
      retryBackoffMs: 1000
    }
  };
}

async function callProvider(source, promptText, client, turnIndex) {
  const response = await client.complete(createProviderRequest(source, promptText, turnIndex));
  return {
    usage: normalizeUsage(response.usage ?? null),
    responseId: response.responseId ?? null
  };
}

async function writeProbeReport(report) {
  const reportPath = resolveLiveCostProbeReportPath(rootDir);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function isReservedOrPrivateIpv4(address) {
  const parts = `${address}`.split('.').map((segment) => Number.parseInt(segment, 10));
  if (parts.length !== 4 || parts.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10
    || (a === 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
  );
}

async function resolveDnsDiagnostics(hostname) {
  try {
    const resolved = await dns.lookup(hostname, { all: true, family: 4 });
    const addresses = resolved.map((entry) => entry.address);
    return {
      hostname,
      addresses,
      hasReservedAddress: addresses.some((address) => isReservedOrPrivateIpv4(address))
    };
  } catch (error) {
    return {
      hostname,
      addresses: [],
      hasReservedAddress: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  const probeModel = process.env.XIAOMI_MIMO_LIVE_MODEL?.trim() || XIAOMI_MIMO_STRONG_MODEL;
  const source = await readXiaomiMimoFlashProviderSource(rootDir, {
    model: probeModel,
    requireTextAgentModel: true,
  });
  const client = new OpenAiCompatibleProviderClient();
  const dnsDiagnostics = await resolveDnsDiagnostics(new URL(source.baseUrl).hostname);
  const firstPrompt = buildTurnPrompt(createPromptInput({}, {
    providerModel: source.model,
    providerLabel: source.label,
  }));
  const secondPrompt = buildTurnPrompt(createPromptInput({
    pendingOperatorInputs: [
      {
        messageId: 'op_1',
        commandId: null,
        content: 'Need a short follow-up confirmation.',
        createdAt: 2
      }
    ]
  }, {
    providerModel: source.model,
    providerLabel: source.label,
  }));

  const stablePrefixChars = firstPrompt.budget.stablePrefixChars;
  const secondStablePrefixChars = secondPrompt.budget.stablePrefixChars;
  const identicalStablePrefix =
    stablePrefixChars > 0
    && stablePrefixChars === secondStablePrefixChars
    && firstPrompt.prompt.slice(0, stablePrefixChars) === secondPrompt.prompt.slice(0, stablePrefixChars);

  const issues = [];
  if (!identicalStablePrefix) {
    issues.push('stable_prefix_mismatch');
  }
  if (firstPrompt.budget.volatileSuffixChars <= 0 || secondPrompt.budget.volatileSuffixChars <= 0) {
    issues.push('volatile_suffix_missing');
  }

  const aggregatedUsage = {
    apiCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheWritePromptTokens: 0
  };
  const responses = [];
  let providerError = null;

  for (const [index, prompt] of [firstPrompt, secondPrompt].entries()) {
    try {
      const response = await callProvider(source, prompt.prompt, client, index + 1);
      responses.push(response);
      aggregatedUsage.apiCalls += 1;
      aggregatedUsage.promptTokens += response.usage.promptTokens ?? 0;
      aggregatedUsage.completionTokens += response.usage.completionTokens ?? 0;
      aggregatedUsage.totalTokens += response.usage.totalTokens ?? 0;
      aggregatedUsage.cachedPromptTokens += response.usage.cachedPromptTokens ?? 0;
      aggregatedUsage.cacheWritePromptTokens += response.usage.cacheWritePromptTokens ?? 0;
    } catch (error) {
      providerError = error;
      break;
    }
  }

  if (aggregatedUsage.apiCalls <= 0 || aggregatedUsage.totalTokens <= 0) {
    issues.push('usage_accounting_missing');
  }
  if (dnsDiagnostics.hasReservedAddress && aggregatedUsage.apiCalls <= 0) {
    issues.push(`provider_endpoint_resolves_to_reserved_address:${dnsDiagnostics.addresses.join(',')}`);
  }

  const cacheTelemetryStatus =
    responses.some((response) => (
      response.usage.cachedPromptTokens !== null
      || response.usage.cacheWritePromptTokens !== null
    ))
      ? 'reported'
      : 'provider_cache_telemetry_unavailable';

  if (providerError) {
    const failureReport = {
      generatedAt: new Date().toISOString(),
      provider: {
      providerId: source.providerId,
      model: source.model,
      baseUrl: source.baseUrl,
      chatCompletionsUrl: source.chatCompletionsUrl
      },
      dns: dnsDiagnostics,
      promptBudget: {
        cacheablePrefixChars: firstPrompt.budget.cacheablePrefixChars,
        stablePrefixChars,
        volatileSuffixChars: firstPrompt.budget.volatileSuffixChars,
        stablePrefixRatio: firstPrompt.budget.stablePrefixRatio,
        secondStablePrefixChars,
        secondVolatileSuffixChars: secondPrompt.budget.volatileSuffixChars,
        identicalStablePrefix
      },
      usage: aggregatedUsage,
      cacheTelemetryStatus,
      responseIds: responses.map((response) => response.responseId).filter(Boolean),
      passes: false,
      issues: [
        ...issues,
        `provider_probe_failed:${providerError instanceof Error ? providerError.message : String(providerError)}`
      ],
      error: providerError instanceof Error
        ? {
          name: providerError.name,
          message: providerError.message,
          stack: providerError.stack ?? null,
          cause: providerError.cause instanceof Error
            ? {
              name: providerError.cause.name,
              message: providerError.cause.message,
              stack: providerError.cause.stack ?? null
            }
            : providerError.cause ?? null
        }
        : {
          name: 'UnknownError',
          message: String(providerError)
        }
    };
    await writeProbeReport(failureReport);
    process.exit(1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    provider: {
      providerId: source.providerId,
      model: source.model,
      baseUrl: source.baseUrl,
      chatCompletionsUrl: source.chatCompletionsUrl
    },
    dns: dnsDiagnostics,
    promptBudget: {
      cacheablePrefixChars: firstPrompt.budget.cacheablePrefixChars,
      stablePrefixChars,
      volatileSuffixChars: firstPrompt.budget.volatileSuffixChars,
      stablePrefixRatio: firstPrompt.budget.stablePrefixRatio,
      secondStablePrefixChars,
      secondVolatileSuffixChars: secondPrompt.budget.volatileSuffixChars,
      identicalStablePrefix
    },
    usage: aggregatedUsage,
    cacheTelemetryStatus,
    responseIds: responses.map((response) => response.responseId).filter(Boolean),
    passes: issues.length === 0,
    issues
  };
  await writeProbeReport(report);

  if (issues.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
