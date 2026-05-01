import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:5173";
const BACKEND_URL = process.env.FRONTEND_SMOKE_BACKEND_URL ?? "http://127.0.0.1:3011";
const REPORT_PATH =
  process.env.FRONTEND_SMOKE_REPORT ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-smoke-report.json");
const SCREENSHOT_DIR =
  process.env.FRONTEND_SMOKE_SCREENSHOTS ??
  path.resolve(process.cwd(), "..", ".codex-run", "logs", "frontend-smoke-snapshots");

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
  { name: "desktop_short", width: 1280, height: 518 },
  { name: "wide", width: 1600, height: 960 },
];

const HIDDEN_TEXT_SNIPPETS = ['[AGENT-001_OUTPUT]', '"current_unit"', '"tool_name"'];
const MULTI_SECTION_PAGES = new Set([
  "dashboard",
  "queue",
  "settings-general",
  "settings-connections",
  "settings-capabilities",
  "settings-skills",
  "settings-state",
  "settings-improvements",
]);
const SCROLL_ANCHORS = ["top", "mid", "bottom"];

const SETTINGS_PAGES = [
  { page: "settings-general", route: "/settings/general", navTestId: "settings-general-page" },
  { page: "settings-connections", route: "/settings/connections", navTestId: "settings-connections-page" },
  { page: "settings-capabilities", route: "/settings/capabilities", navTestId: "settings-capabilities-page" },
  { page: "settings-skills", route: "/settings/skills", navTestId: "settings-skills-page" },
  { page: "settings-state", route: "/settings/state", navTestId: "settings-state-page" },
  { page: "settings-improvements", route: "/settings/improvements", navTestId: "settings-improvements-page" },
];

const TEXT_PROVIDER_CAPABILITY = {
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsVision: false,
  supportsFiles: false,
  supportedFileExtensions: [],
};

const VISION_PROVIDER_CAPABILITY = {
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportsVision: true,
  supportsFiles: false,
  supportedFileExtensions: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
};

const PROVIDER_PRESET_FIXTURES = [
  {
    id: "openai",
    label: "OpenAI Provider With A Very Long Environment Variable Hint",
    vendor: "openai",
    transport: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    requiresApiKey: true,
    supportsQuickAdd: true,
    category: "api-key",
    envVarNames: ["OPENAI_API_KEY", "OPENAI_ORGANIZATION_WITH_EXTRA_LONG_NAME"],
    requiredConfigFields: [],
    implementationStatus: "runnable",
    capabilities: VISION_PROVIDER_CAPABILITY,
    notes: null,
  },
  {
    id: "cohere",
    label: "Cohere Profile Only",
    vendor: "cohere",
    transport: "native-cohere",
    baseUrl: "https://api.cohere.com/v2",
    defaultModel: "command-a-03-2025",
    requiresApiKey: true,
    supportsQuickAdd: false,
    category: "api-key",
    envVarNames: ["COHERE_API_KEY"],
    requiredConfigFields: [],
    implementationStatus: "profile-only",
    capabilities: TEXT_PROVIDER_CAPABILITY,
    notes: "Native Cohere adapter is not registered in this release.",
  },
  {
    id: "azure_openai",
    label: "Azure OpenAI Enterprise Cloud",
    vendor: "azure_openai",
    transport: "enterprise-cloud",
    baseUrl: null,
    defaultModel: "deployment-name",
    requiresApiKey: true,
    supportsQuickAdd: false,
    category: "enterprise-cloud",
    envVarNames: ["AZURE_OPENAI_API_KEY"],
    requiredConfigFields: ["resource", "deployment", "api_version"],
    implementationStatus: "external-auth-required",
    capabilities: VISION_PROVIDER_CAPABILITY,
    notes: "Requires Azure resource, deployment, and API version.",
  },
  {
    id: "ollama",
    label: "Ollama Local Service",
    vendor: "ollama",
    transport: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    requiresApiKey: false,
    supportsQuickAdd: true,
    category: "local",
    envVarNames: [],
    requiredConfigFields: [],
    implementationStatus: "runnable",
    capabilities: TEXT_PROVIDER_CAPABILITY,
    notes: null,
  },
];

function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return Boolean(candidate && fsSync.existsSync(candidate));
    } catch {
      return false;
    }
  });
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createBackendMatcher(apiPath) {
  return new RegExp(`^${escapeRegExp(`${BACKEND_URL}${apiPath}`)}(?:\\?.*)?$`);
}

function createTaskSummary({
  taskId,
  title,
  intent,
  lifecycleStatus = "SUBMITTED",
  minutesAgo = 0,
  queueState = null,
  pendingApprovalCount = 0,
  lastError = null,
  isDelegatedChild = false,
  statusSummary = null,
  primaryAction = null,
  nextActionSummary = null,
  completionSummary = null,
  delegationSummary = null,
  latestVisibleOutput = undefined,
  visibleToolActivities = undefined,
}) {
  return {
    taskId,
    title,
    intent,
    lifecycleStatus,
    currentUnitId: lifecycleStatus === "COMPLETED" ? null : "AGENT-001",
    updatedAt: Date.now() - minutesAgo * 60_000,
    queueState,
    pendingApprovalCount,
    lastError,
    isDelegatedChild,
    statusSummary,
    primaryAction,
    nextActionSummary,
    completionSummary,
    delegationSummary,
    latestVisibleOutput,
    visibleToolActivities,
  };
}

function buildDashboardTasks(state) {
  switch (state) {
    case "quiet":
      return [];
    case "attention_non_empty":
      return [
        createTaskSummary({
          taskId: "dash-attention-01",
          title: "Publish weekly release note",
          intent: "Finish the release note after a quick operator approval.",
          lifecycleStatus: "PAUSED",
          pendingApprovalCount: 1,
          minutesAgo: 4,
        }),
        createTaskSummary({
          taskId: "dash-attention-02",
          title: "Investigate flaky build",
          intent: "Collect the latest build evidence and explain the failure.",
          lifecycleStatus: "FAILED",
          lastError: "Build verification failed on the final replay step.",
          minutesAgo: 12,
        }),
      ];
    case "running_recent_mixed":
      return [
        createTaskSummary({
          taskId: "dash-run-01",
          title: "Prepare migration checklist",
          intent: "Draft the migration checklist and call out rollout risks.",
          lifecycleStatus: "RUNNING",
          minutesAgo: 2,
        }),
        createTaskSummary({
          taskId: "dash-run-02",
          title: "Audit queue retry posture",
          intent: "Review queue retry handling and note drift risks.",
          lifecycleStatus: "RUNNING",
          minutesAgo: 9,
        }),
        createTaskSummary({
          taskId: "dash-run-03",
          title: "Summarize the last outage",
          intent: "Write the operator summary for the outage review.",
          lifecycleStatus: "COMPLETED",
          minutesAgo: 24,
        }),
      ];
    default:
      return [];
  }
}

function buildQueueTasks(state) {
  switch (state) {
    case "clean_empty":
      return [];
    case "waiting_non_empty":
      return [
        createTaskSummary({
          taskId: "queue-wait-01",
          title: "Approve artifact handoff",
          intent: "Apply the generated artifact after operator confirmation.",
          lifecycleStatus: "PAUSED",
          pendingApprovalCount: 1,
          minutesAgo: 3,
        }),
        createTaskSummary({
          taskId: "queue-wait-02",
          title: "Resume paused refactor",
          intent: "Continue the refactor once an operator confirms the path.",
          lifecycleStatus: "PAUSED",
          minutesAgo: 17,
        }),
      ];
    case "recovery_non_empty":
      return [
        createTaskSummary({
          taskId: "queue-recovery-01",
          title: "Repair provider fallback",
          intent: "Recover the fallback chain and explain the last failure.",
          lifecycleStatus: "FAILED",
          lastError: "Provider timeout while replaying the last step.",
          minutesAgo: 6,
        }),
      ];
    case "backlog_non_empty":
      return [
        createTaskSummary({
          taskId: "queue-backlog-01",
          title: "Backfill capability index",
          intent: "Rebuild the capability index in the background.",
          lifecycleStatus: "SUBMITTED",
          queueState: "QUEUED",
          minutesAgo: 10,
        }),
        createTaskSummary({
          taskId: "queue-backlog-02",
          title: "Verify runtime lease",
          intent: "Inspect the in-flight lease and confirm it can continue.",
          lifecycleStatus: "RUNNING",
          queueState: "LEASED",
          minutesAgo: 14,
        }),
      ];
    default:
      return [];
  }
}

function buildImprovementFixtureState(now, warningPresent) {
  const lessonProposalId = "proposal_fixture_lesson_delivery";
  const instructionSkillProposalId = "proposal_fixture_instruction_skill";
  const duplicateProposalId = "proposal_fixture_duplicate_delivery";
  const conflictProposalId = "proposal_fixture_conflict_delivery";

  const successExperience = {
    reportId: "experience_fixture_success",
    taskId: "archive-task-01",
    lifecycleStatus: "COMPLETED",
    summary: "Delivered a repeatable artifact handoff.",
    outcome: "success",
    artifactQuality: "delivered",
    truthCompleteness: "complete",
    failureTaxonomy: [],
    keyFacts: ["Artifact delivered to backend/docs", "Summary retained in task truth"],
    createdAt: now - 180_000,
    complexitySignals: ["multi_turn", "tool_activity", "artifact_delivery"],
  };

  const failureExperience = {
    reportId: "experience_fixture_failure",
    taskId: "archive-task-03",
    lifecycleStatus: "FAILED",
    summary: "Conflicting lesson retained for governance review.",
    outcome: "failed",
    artifactQuality: "artifact_only",
    truthCompleteness: "complete",
    failureTaxonomy: ["delivery_conflict"],
    keyFacts: ["Conflicting delivery lesson held for manual review"],
    createdAt: now - 150_000,
    complexitySignals: ["multi_turn", "correction_or_recovery", "artifact_delivery"],
  };

  const improvements = [
    {
      proposalId: lessonProposalId,
      kind: "lesson",
      status: "APPROVED",
      taskId: "archive-task-01",
      title: "Reuse the delivered-path handoff pattern",
      summary: "Stable delivery tasks should surface the final path in both the result and the archive truth.",
      evidenceTaskIds: ["archive-task-01", "archive-task-02"],
      createdAt: now - 180_000,
      updatedAt: now - 120_000,
      archivedAt: now - 120_000,
      patternKey: "delivery:final-path",
      dedupeKey: "lesson:delivery:final-path",
      qualityScore: 0.94,
      archiveEligible: true,
      duplicateOfProposalId: null,
      conflictsWithProposalIds: warningPresent ? [conflictProposalId] : [],
      supersededByProposalId: null,
      experienceReport: successExperience,
      lessonProposal: {
        title: "Reuse the delivered-path handoff pattern",
        lessonSummary: "Keep delivery summaries explicit and retain the final destination in operator-facing truth.",
        triggerPattern: "Repeated artifact delivery tasks with explicit destination truth",
        recommendedUseScope: "Artifact-delivery tasks on the default file-backed mainline",
        confidence: 0.94,
      },
      instructionSkillProposal: null,
      optimizationRecommendation: null,
      metadata: {},
    },
    {
      proposalId: instructionSkillProposalId,
      kind: "instruction_skill",
      status: "PENDING",
      taskId: "archive-task-02",
      title: "Instruction skill for delivery summaries",
      summary: "Package the stable delivery-summary pattern into an instruction skill candidate.",
      evidenceTaskIds: ["archive-task-01", "archive-task-02"],
      createdAt: now - 140_000,
      updatedAt: now - 110_000,
      archivedAt: now - 110_000,
      patternKey: "delivery:final-path",
      dedupeKey: "instruction-skill:delivery:final-path",
      qualityScore: 0.88,
      archiveEligible: true,
      duplicateOfProposalId: null,
      conflictsWithProposalIds: [],
      supersededByProposalId: null,
      experienceReport: successExperience,
      lessonProposal: null,
      instructionSkillProposal: {
        title: "Instruction skill for delivery summaries",
        applicableScenarios: ["Default-path artifact delivery", "Operator-visible handoff summaries"],
        inputBoundaries: ["Task already has delivery truth", "No raw protocol exposure"],
        prohibitions: ["Do not infer paths not present in task truth"],
        validationSummary: "Two archived delivery tasks produced the same stable handoff shape.",
        confidence: 0.88,
        draftSkillMarkdown: "# Delivery summary skill",
        materializedRootDir: warningPresent ? null : "backend/data/generated-skills/proposal_fixture_instruction_skill",
        importedSkillId: warningPresent ? null : "generated-delivery-summary-skill",
      },
      optimizationRecommendation: null,
      metadata: {},
    },
    {
      proposalId: duplicateProposalId,
      kind: "lesson",
      status: "PENDING",
      taskId: "archive-task-02",
      title: "Duplicate delivery lesson",
      summary: "This duplicate stays visible only to validate governance handling.",
      evidenceTaskIds: ["archive-task-02"],
      createdAt: now - 100_000,
      updatedAt: now - 100_000,
      archivedAt: now - 100_000,
      patternKey: "delivery:final-path",
      dedupeKey: "lesson:delivery:final-path",
      qualityScore: 0.61,
      archiveEligible: true,
      duplicateOfProposalId: lessonProposalId,
      conflictsWithProposalIds: [],
      supersededByProposalId: null,
      experienceReport: successExperience,
      lessonProposal: {
        title: "Duplicate delivery lesson",
        lessonSummary: "Held only to verify duplicate governance flags in Settings.",
        triggerPattern: "Synthetic duplicate for smoke validation",
        recommendedUseScope: "Governance checks only",
        confidence: 0.61,
      },
      instructionSkillProposal: null,
      optimizationRecommendation: null,
      metadata: {},
    },
    {
      proposalId: conflictProposalId,
      kind: "lesson",
      status: "PENDING",
      taskId: "archive-task-03",
      title: "Conflicting delivery lesson",
      summary: "This conflicting lesson remains pending so the governance surface can expose conflict flags.",
      evidenceTaskIds: ["archive-task-03"],
      createdAt: now - 90_000,
      updatedAt: now - 90_000,
      archivedAt: now - 90_000,
      patternKey: "delivery:final-path",
      dedupeKey: "lesson:delivery:conflict",
      qualityScore: 0.58,
      archiveEligible: true,
      duplicateOfProposalId: null,
      conflictsWithProposalIds: [lessonProposalId],
      supersededByProposalId: null,
      experienceReport: failureExperience,
      lessonProposal: {
        title: "Conflicting delivery lesson",
        lessonSummary: "Held only to surface conflict resolution in the governance UI.",
        triggerPattern: "Synthetic conflicting lesson for smoke validation",
        recommendedUseScope: "Governance checks only",
        confidence: 0.58,
      },
      instructionSkillProposal: null,
      optimizationRecommendation: null,
      metadata: {},
    },
  ];

  const archive = [
    {
      archiveEntryId: "archive-entry-01",
      taskId: "archive-task-01",
      taskTitle: "Deliver operator handoff note",
      taskIntent: "Produce a delivery note and preserve the final path in task truth.",
      lifecycleStatus: "COMPLETED",
      archivedAt: now - 180_000,
      complexitySignals: ["multi_turn", "tool_activity", "artifact_delivery"],
      archiveEligibility: {
        eligible: true,
        reason: "complex_enough",
        complexitySignals: ["multi_turn", "tool_activity", "artifact_delivery"],
      },
      qualityScore: 0.94,
      patternKey: "delivery:final-path",
      truthSummary: {
        statusSummary: "Delivered to backend/docs/fixture-delivery-note.md",
        primaryAction: "Continue current thread",
        nextAction: "Continue current thread if more operator work is needed.",
        completionSummary: "Delivery note created and final destination retained.",
        truthCompleteness: "complete",
      },
      finalDelivery: {
        summary: "Fixture delivery note created",
        deliveredTo: ["backend/docs/fixture-delivery-note.md"],
        destinationDir: "backend/docs",
      },
      artifactPaths: ["reports/fixture-delivery-note.md"],
      blockerSummary: null,
      proposalIds: [lessonProposalId, instructionSkillProposalId],
      experienceReport: successExperience,
      metadata: {},
    },
    {
      archiveEntryId: "archive-entry-02",
      taskId: "archive-task-02",
      taskTitle: "Promote delivery summary pattern",
      taskIntent: "Re-run the delivery pattern so the system can propose a reusable instruction skill.",
      lifecycleStatus: "COMPLETED",
      archivedAt: now - 140_000,
      complexitySignals: ["multi_turn", "tool_activity", "artifact_delivery", "delegation"],
      archiveEligibility: {
        eligible: true,
        reason: "complex_enough",
        complexitySignals: ["multi_turn", "tool_activity", "artifact_delivery", "delegation"],
      },
      qualityScore: 0.88,
      patternKey: "delivery:final-path",
      truthSummary: {
        statusSummary: "Delivered to backend/docs/fixture-delegated-handoff.md",
        primaryAction: "Continue current thread",
        nextAction: "Continue current thread whenever you want to extend the delivery.",
        completionSummary: "Delegated child work was absorbed and the parent retained the final delivery.",
        truthCompleteness: "complete",
      },
      finalDelivery: {
        summary: "Delegated handoff summary created",
        deliveredTo: ["backend/docs/fixture-delegated-handoff.md"],
        destinationDir: "backend/docs",
      },
      artifactPaths: ["reports/fixture-delegated-handoff.md"],
      blockerSummary: null,
      proposalIds: [instructionSkillProposalId, duplicateProposalId],
      experienceReport: successExperience,
      metadata: {},
    },
  ];

  const complexReport = {
    generatedAt: now,
    curatedSuite: {
      total: 3,
      passed: 3,
      failed: 0,
    },
    archive: {
      total: 2,
      completed: 2,
      failed: 0,
      cancelled: 0,
      delivered: 2,
      artifactOnly: 0,
      proposalGenerated: improvements.length,
    },
    archiveEligibleCount: 2,
    archiveSkippedCount: 1,
    skipReasons: [{ reason: "not_complex_enough", count: 1 }],
    duplicateProposalCount: 1,
    conflictedProposalCount: warningPresent ? 2 : 1,
    supersededProposalCount: 0,
    lessonMemoryCount: 1,
    generatedInstructionSkillCount: warningPresent ? 0 : 1,
    failureTaxonomy: warningPresent ? ["delivery_conflict"] : [],
    truthCompleteness: {
      complete: 2,
      partial: 0,
    },
    proposalGenerationQuality: {
      lesson: 3,
      instructionSkill: 1,
      optimization: 0,
    },
  };

  return {
    improvements,
    archive,
    complexReport,
  };
}

function buildPlatformFixtureState(state) {
  const warningPresent = state === "warning_present";
  const now = Date.now();
  const improvementFixtures = buildImprovementFixtureState(now, warningPresent);
  return {
    capabilities: {
      warnings: warningPresent
        ? [
            { code: "missing-provider-secret", message: "One provider profile is missing a secret." },
            { code: "workflow-doc-drift", message: "A workflow import needs review." },
          ]
        : [],
    },
    workflow: {
      workspaceRoot: "D:/workspace",
      sccDir: "D:/workspace/.scc",
      projectInstructionsPresent: true,
      projectInstructionsSummary: "Keep the default file-backed workflow portable.",
      rules: [{ name: "rule-1", summary: "Apply docs defaults.", paths: ["backend/docs"] }, { name: "rule-2", summary: "Watch runtime drift.", paths: [] }],
      commands: [{ name: "ship", description: "Prepare release notes.", args: "--draft", when: "manual" }],
      hooks: [{ event: "task.completed", command: "echo done", description: "Test hook", timeoutMs: 5000 }],
      agents: [{ name: "reviewer", description: "Checks deliverables." }],
      docsSources: [{ path: "docs/README.md", title: "README", tags: ["docs"] }],
      docsImportSummary: {
        trackedSourceCount: 1,
        importedMemoryCount: warningPresent ? 1 : 2,
        imported: warningPresent ? 0 : 1,
        updated: warningPresent ? 1 : 0,
        skipped: 0,
        importedMemoryIds: ["workspace_doc_demo"],
        lastImportedAt: now - 60_000,
      },
    },
    providers: [
      {
        profile: {
          id: "xiaomi-mimo-v2-flash",
          label: "Xiaomi Mimo V2.5",
          transport: "openai-compatible",
          vendor: "custom",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          model: "mimo-v2.5",
          apiKeySecretId: warningPresent ? "" : "xiaomi-mimo-live-provider",
        },
        isDefault: !warningPresent,
        isSavedDefault: true,
        isRuntimeDefault: !warningPresent,
        hasRegisteredClient: true,
        hasSecret: !warningPresent,
        readiness: warningPresent ? "missing-secret" : "ready",
        authSource: warningPresent ? "missing-secret" : "secret-store",
        implementationStatus: "runnable",
        capabilities: VISION_PROVIDER_CAPABILITY,
        adapter: {
          providerId: "xiaomi-mimo-v2-flash",
          transport: "openai-compatible",
          vendor: "custom",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          timeoutMs: 30000,
        },
        model: {
          providerId: "xiaomi-mimo-v2-flash",
          modelId: "mimo-v2.5",
          label: "mimo-v2.5",
          reasoning: null,
          verbosity: null,
          thinkingBudget: null,
        },
        variant: {
          providerId: "xiaomi-mimo-v2-flash",
          variantId: "default",
          label: "default",
          isDefault: true,
          isSmallModel: false,
          taskPreference: null,
        },
      },
      {
        profile: {
          id: "local-file",
          label: "Local File",
          transport: "local-stdio",
          vendor: "custom",
          baseUrl: "",
          model: "local-runner",
          apiKeySecretId: "",
        },
        isDefault: false,
        isSavedDefault: false,
        isRuntimeDefault: false,
        hasRegisteredClient: true,
        hasSecret: true,
        readiness: "ready",
        authSource: "none",
        implementationStatus: "runnable",
        capabilities: TEXT_PROVIDER_CAPABILITY,
        adapter: {
          providerId: "local-file",
          transport: "local-stdio",
          vendor: "custom",
          baseUrl: null,
          timeoutMs: 30000,
        },
        model: {
          providerId: "local-file",
          modelId: "local-runner",
          label: "local-runner",
          reasoning: null,
          verbosity: null,
          thinkingBudget: null,
        },
        variant: {
          providerId: "local-file",
          variantId: "default",
          label: "default",
          isDefault: true,
          isSmallModel: true,
          taskPreference: "offline",
        },
      },
    ],
    providerSecrets: warningPresent
      ? []
      : [{
          id: "xiaomi-mimo-live-provider",
          provider: "xiaomi-mimo-v2-flash",
          label: "Xiaomi live key",
          createdAt: now - 600_000,
          updatedAt: now - 300_000,
          hasValue: true,
          metadata: {},
      }],
    providerPresets: PROVIDER_PRESET_FIXTURES,
    improvements: improvementFixtures.improvements,
    archive: improvementFixtures.archive,
    complexReport: improvementFixtures.complexReport,
    skills: [
      {
        skill: {
          id: "skills-1",
          name: "analysis",
          rootDir: "D:/skills/analysis",
          description: "Analysis skill",
          kind: "instruction-skill",
        },
        runtimeRegistered: true,
        capability: null,
        kind: "instruction-skill",
        readiness: "ready",
        assetSummary: null,
        instructionSource: null,
        declaredDependencies: { mcpServers: [] },
      },
      {
        skill: {
          id: "skills-2",
          name: "delivery",
          rootDir: "D:/skills/delivery",
          description: "Delivery skill",
          kind: "runtime-skill",
        },
        runtimeRegistered: true,
        capability: null,
        kind: "runtime-skill",
        readiness: warningPresent ? "partial" : "ready",
        assetSummary: null,
        instructionSource: null,
        declaredDependencies: { mcpServers: [] },
      },
    ],
    mcpServers: warningPresent
      ? []
      : [{
          server: {
            id: "mcp-1",
            name: "Docs MCP",
            transport: "stdio",
            command: "node",
            args: ["mcp.js"],
            url: "",
          },
          clientRegistered: true,
          capability: null,
          readiness: "ready",
          declaredTools: ["search"],
          declaredResources: [],
          declaredPrompts: [],
          availableTools: ["search"],
          availableResources: [],
          availablePrompts: [],
          lastTestSummary: { ok: true, message: "MCP server reachable." },
        }],
    configHealth: warningPresent
      ? { issues: [{ code: "provider-warning", message: "A provider override needs review." }] }
      : { issues: [] },
    configState: {
      current: {
        tools: { permissionMode: warningPresent ? "ask" : "full" },
        server: { enableSseFallback: true },
        providers: {
          defaultProviderId: "xiaomi-mimo-v2-flash",
        },
        runtime: {
          delegation: {
            enabled: !warningPresent,
          },
        },
      },
      savedDefaultProviderId: "xiaomi-mimo-v2-flash",
      activeSnapshot: {
        version: "snapshot-1",
        fingerprint: "fixture-fingerprint",
        createdAt: now - 60_000,
      },
      activeSnapshotVersion: "snapshot-1",
      reloadApplied: !warningPresent,
      restartRequired: warningPresent,
      effectiveFingerprint: "fixture-fingerprint",
    },
  };
}

function buildFixtureVisibleOutput(task) {
  if (task.latestVisibleOutput) {
    return task.latestVisibleOutput;
  }
  if (task.lifecycleStatus !== "COMPLETED") {
    return null;
  }

  return {
    source: "validated_output",
    unitId: "AGENT-001",
    validatedAt: task.updatedAt,
    summary: `${task.title} is ready to review.`,
    details: task.intent,
    issues: [],
    artifactPaths: [],
    artifactDestinationPaths: [],
    artifactDestinationDir: null,
    artifactApplyStatus: null,
  };
}

function buildFixtureDelegationSummary(task) {
  if (task.delegationSummary) {
    return task.delegationSummary;
  }
  return {
    depth: task.isDelegatedChild ? 1 : 0,
    delegationEnabled: false,
    canDelegate: false,
    required: false,
    missingRequiredDelegation: false,
    reason: task.isDelegatedChild ? "Delegated child tasks cannot delegate further." : "Delegation is disabled in smoke fixtures.",
    activeChildTask: null,
    recentChildren: [],
  };
}

function buildFixturePrimaryAction(task, delegationSummary) {
  if (task.primaryAction) {
    return task.primaryAction;
  }
  if (task.pendingApprovalCount > 0) {
    return {
      kind: "approve",
      label: "Resolve approvals",
      description: "Approve or reject the blocked tool invocation before the thread can continue.",
      destinationDir: null,
    };
  }
  if (delegationSummary.missingRequiredDelegation) {
    return {
      kind: "continue_thread",
      label: "Continue current thread",
      description: "Delegation is required before parent delivery can continue.",
      destinationDir: null,
    };
  }
  if (delegationSummary.activeChildTask) {
    return {
      kind: "wait",
      label: "Wait",
      description: `Waiting on delegated subtask "${delegationSummary.activeChildTask.title}".`,
      destinationDir: null,
    };
  }
  switch (task.lifecycleStatus) {
    case "SUBMITTED":
      return {
        kind: "start_task",
        label: "Start task",
        description: "Launch the first turn for this thread when you are ready.",
        destinationDir: null,
      };
    case "PAUSED":
      return {
        kind: "resume_task",
        label: "Resume task",
        description: "Resume the paused thread from its current state.",
        destinationDir: null,
      };
    case "FAILED":
      return {
        kind: "restart_task",
        label: "Restart task",
        description: "Repair the failure and rebuild execution from the current thread definition.",
        destinationDir: null,
      };
    case "COMPLETED":
      return {
        kind: "continue_thread",
        label: "Continue current thread",
        description: "Keep working from the completed result in this same thread.",
        destinationDir: null,
      };
    default:
      return {
        kind: "continue_thread",
        label: "Continue current thread",
        description: "Continue the current thread when you have additional guidance.",
        destinationDir: null,
      };
  }
}

function buildFixtureNextActionSummary(task, primaryAction) {
  if (task.nextActionSummary) {
    return task.nextActionSummary;
  }
  return {
    label: primaryAction.label,
    reason: primaryAction.description,
  };
}

function buildFixtureStatusSummary(task, primaryAction, delegationSummary) {
  if (task.statusSummary) {
    return task.statusSummary;
  }
  if (task.pendingApprovalCount > 0) {
    return {
      label: "Approval required",
      detail: `${task.pendingApprovalCount} tool approval(s) are blocking runtime progress.`,
      tone: "action_required",
    };
  }
  if (delegationSummary.missingRequiredDelegation) {
    return {
      label: "Delegation required before parent delivery",
      detail: "The runtime must create a delegated child task before the parent thread can continue.",
      tone: "blocked",
    };
  }
  if (delegationSummary.activeChildTask) {
    return {
      label: "Waiting on delegated subtask",
      detail: `The delegated child "${delegationSummary.activeChildTask.title}" is still running within the parent thread boundary.`,
      tone: "waiting",
    };
  }
  if (primaryAction.kind === "use_recommended_path" || primaryAction.kind === "choose_custom_path") {
    return {
      label: "Use recommended path",
      detail: primaryAction.description,
      tone: "action_required",
    };
  }
  if (task.lifecycleStatus === "COMPLETED") {
    return {
      label: "Completed",
      detail: "The task is complete and the next message can continue this same thread.",
      tone: "completed",
    };
  }
  if (task.lifecycleStatus === "FAILED") {
    return {
      label: "Failed",
      detail: task.lastError ?? "The thread failed and needs recovery guidance.",
      tone: "blocked",
    };
  }
  if (task.lifecycleStatus === "PAUSED") {
    return {
      label: "Paused",
      detail: primaryAction.description,
      tone: "waiting",
    };
  }
  if (task.lifecycleStatus === "SUBMITTED") {
    return {
      label: "Ready to start",
      detail: primaryAction.description,
      tone: "waiting",
    };
  }
  return {
    label: "Running",
    detail: primaryAction.description,
    tone: "running",
  };
}

function buildFixtureCompletionSummary(task, latestVisibleOutput) {
  if (task.completionSummary) {
    return task.completionSummary;
  }
  if (!latestVisibleOutput || task.lifecycleStatus !== "COMPLETED") {
    return null;
  }
  return {
    summary: latestVisibleOutput.summary,
    details: latestVisibleOutput.details ?? null,
    issues: latestVisibleOutput.issues ?? [],
    artifactPaths: latestVisibleOutput.artifactPaths ?? [],
    artifactDestinationPaths: latestVisibleOutput.artifactDestinationPaths ?? [],
    artifactDestinationDir: latestVisibleOutput.artifactDestinationDir ?? null,
    artifactApplyStatus: latestVisibleOutput.artifactApplyStatus ?? null,
    continueAllowed: true,
  };
}

function buildFixtureConversation(task) {
  const items = [
    {
      messageId: `${task.taskId}-user`,
      role: "user",
      content: task.intent,
      createdAt: task.updatedAt - 2_000,
      visibility: "public",
      metadata: null,
    },
  ];

  if (task.lifecycleStatus === "PAUSED" || task.pendingApprovalCount > 0) {
    items.push({
      messageId: `${task.taskId}-assistant-waiting`,
      role: "assistant",
      content: "This thread is waiting on an operator decision before it can continue.",
      createdAt: task.updatedAt - 1_000,
      visibility: "public",
      metadata: {
        source: "assistant_summary",
        displayKind: task.pendingApprovalCount > 0 ? "approval_waiting" : "progress",
        unitId: "AGENT-001",
        turnId: `${task.taskId}-turn`,
      },
    });
  } else if (task.lifecycleStatus === "FAILED" || task.lastError) {
    items.push({
      messageId: `${task.taskId}-assistant-recovery`,
      role: "assistant",
      content: "Recovery is required before this thread can safely continue.",
      createdAt: task.updatedAt - 1_000,
      visibility: "public",
      metadata: {
        source: "assistant_summary",
        displayKind: "recovery",
        unitId: "AGENT-001",
        turnId: `${task.taskId}-turn`,
      },
    });
  } else if (task.lifecycleStatus === "RUNNING") {
    items.push({
      messageId: `${task.taskId}-assistant-progress`,
      role: "assistant",
      content: "The runtime is still working through the current step.",
      createdAt: task.updatedAt - 1_000,
      visibility: "public",
      metadata: {
        source: "assistant_summary",
        displayKind: "progress",
        unitId: "AGENT-001",
        turnId: `${task.taskId}-turn`,
      },
    });
  }

  if (task.delegationSummary?.activeChildTask) {
    items.push({
      messageId: `${task.taskId}-assistant-delegation`,
      role: "assistant",
      content: `Delegated "${task.delegationSummary.activeChildTask.title}" to a SubSccAgent. Waiting for the child task to finish and return its scoped result.`,
      createdAt: task.updatedAt - 750,
      visibility: "public",
      metadata: {
        source: "assistant_summary",
        displayKind: "progress",
        unitId: "AGENT-001",
        turnId: `${task.taskId}-delegation-turn`,
      },
    });
  }

  return items;
}

function buildFixtureTaskDetail(task) {
  const latestVisibleOutput = buildFixtureVisibleOutput(task);
  const delegationSummary = buildFixtureDelegationSummary(task);
  const primaryAction = buildFixturePrimaryAction(task, delegationSummary);
  const nextActionSummary = buildFixtureNextActionSummary(task, primaryAction);
  const statusSummary = buildFixtureStatusSummary(task, primaryAction, delegationSummary);
  const completionSummary = buildFixtureCompletionSummary(task, latestVisibleOutput);
  const visibleToolActivities = Array.isArray(task.visibleToolActivities)
    ? task.visibleToolActivities
    : task.pendingApprovalCount > 0
      ? [{
          activityId: `${task.taskId}-activity`,
          toolId: "write_file",
          status: "WAITING_APPROVAL",
          summary: "write file is waiting for approval.",
          detail: "Review the pending request before the thread can continue.",
          argumentsSummary: "backend/docs/example.md",
          resultSummary: null,
          evidencePaths: [],
          approvalStatus: "PENDING",
          startedAt: task.updatedAt - 400,
          endedAt: null,
          unitId: "AGENT-001",
        }]
      : [];
  return {
    definition: {
      taskId: task.taskId,
      title: task.title,
      intent: task.intent,
      units: [
        {
          id: "AGENT-001",
          role: "Fixture operator",
          goal: "Expose a stable thread view for frontend smoke validation.",
          dependencies: [],
          outputContract: "{\"summary\":\"string\",\"details\":\"string\"}",
        },
      ],
      preferredProviderId: "fixture-provider",
      metadata: {
        pathPolicy: "task_workspace",
        preferredArtifactDir: null,
      },
    },
    runtime: {
      lifecycleStatus: task.lifecycleStatus,
      updatedAt: task.updatedAt,
      engineStatus: task.lifecycleStatus === "RUNNING" ? "RUNNING" : "IDLE",
      currentUnitId: task.lifecycleStatus === "COMPLETED" ? null : "AGENT-001",
      executionLease: null,
      planner: {
        blockingReason: null,
      },
    },
    projection: null,
    queue: task.queueState ? { state: task.queueState, lastError: task.lastError } : null,
    conversations: buildFixtureConversation(task),
    latestVisibleOutput,
    statusSummary,
    primaryAction,
    nextActionSummary,
    completionSummary,
    delegationSummary,
    commands: [],
    operatorMessages: [],
    interrupts: [],
    pendingApprovals: task.pendingApprovalCount > 0 ? [{
      invocationId: `${task.taskId}-approval`,
      toolId: "tool-write-file",
      toolName: "write_file",
      arguments: { path: "backend/docs/example.md" },
      status: "PENDING",
      createdAt: task.updatedAt - 500,
    }] : [],
    pendingApprovalItems: task.pendingApprovalCount > 0 ? [{
      invocationId: `${task.taskId}-approval`,
      toolName: "write_file",
      requestedAt: task.updatedAt - 500,
      argumentsSummary: "backend/docs/example.md",
      status: "PENDING",
      availableActions: ["APPROVED", "REJECTED"],
    }] : [],
    toolInvocations: [],
    visibleToolActivities,
    events: [],
    diagnostics: {
      lastError: task.lastError,
      providerFailure: null,
    },
    isArchived: false,
    canArchive: ["COMPLETED", "FAILED", "CANCELLED", "PAUSED"].includes(task.lifecycleStatus),
    canDelete: ["COMPLETED", "FAILED", "CANCELLED", "PAUSED"].includes(task.lifecycleStatus),
    improvementProposals: [],
    realTaskArchiveStatus: null,
  };
}

function buildFixtureTaskDebug(task, detail) {
  const hasActiveChild = Boolean(task.delegationSummary?.activeChildTask);
  const continueAllowed = !hasActiveChild && (task.lifecycleStatus === "SUBMITTED" || task.lifecycleStatus === "RUNNING");
  return {
    task: detail,
    metadata: null,
    runtimeRecord: null,
    queue: detail.queue,
    executionSummary: {
      issueCategory: task.lastError ? "runtime_failure" : null,
      issueSummary: task.lastError,
      providerSummary: {
        providerId: "fixture-provider",
        modelId: "fixture-model",
        variantId: "default",
        recentStatus: "ready",
        lastMessage: null,
      },
      permissionSummary: {
        mode: "ask",
        approvalRequiredCount: task.pendingApprovalCount,
        deniedCount: 0,
      },
      artifactPathState: "sandbox_only",
      pendingArtifactCount: 0,
      selectedArtifactDir: null,
      recommendedArtifactDir: null,
      artifactPaths: [],
      artifactDestinationPaths: [],
      lastArtifactApplyAt: null,
      lastArtifactApplyResult: null,
      capabilityWarnings: [],
      recovery: {
        recoveredAfterRestart: false,
        recoveryReason: null,
      },
      turnContract: {
        continueAllowed,
        continueReason: continueAllowed
          ? "Runtime can continue."
          : hasActiveChild
            ? `The child task "${task.delegationSummary.activeChildTask.title}" is still running and will return scoped results to this thread.`
          : task.pendingApprovalCount > 0
            ? "Waiting for approval."
            : task.lifecycleStatus === "FAILED"
              ? "Recovery is required before continuing."
              : "This thread is not ready to continue.",
        conservativeMode: false,
      },
    },
  };
}

function buildTaskThreadFixtures(tasks) {
  const fixtures = {
    "/tasks": tasks,
  };

  for (const task of tasks) {
    const detail = buildFixtureTaskDetail(task);
    fixtures[`/tasks/${task.taskId}`] = detail;
    fixtures[`/tasks/${task.taskId}/events`] = detail.events;
    fixtures[`/tasks/${task.taskId}/debug`] = buildFixtureTaskDebug(task, detail);
  }

  return fixtures;
}

async function captureViewportScreenshot(page, viewportName, fileName) {
  const filePath = path.join(SCREENSHOT_DIR, viewportName, `${fileName}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
}

function getViewportHeightVariant(viewport) {
  return viewport.name === "desktop_short" ? "short" : "standard";
}

function getScenarioScrollAnchors(scenario) {
  if (Array.isArray(scenario.scrollAnchors) && scenario.scrollAnchors.length > 0) {
    return scenario.scrollAnchors;
  }
  return MULTI_SECTION_PAGES.has(scenario.page) ? SCROLL_ANCHORS : ["top"];
}

function scenarioMatchesViewport(scenario, viewport) {
  if (Array.isArray(scenario.viewports) && scenario.viewports.length > 0) {
    return scenario.viewports.includes(viewport.name);
  }
  return true;
}

async function scrollScenarioToAnchor(page, pageTestId, anchor) {
  await page.evaluate(({ testId, targetAnchor }) => {
    const pageNode = document.querySelector(`[data-testid="${testId}"]`);
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    if (!(pageNode instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      return;
    }

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    let nextScrollTop = 0;

    if (targetAnchor === "mid") {
      nextScrollTop = Math.min(
        maxScroll,
        Math.max(0, pageNode.offsetTop + pageNode.scrollHeight * 0.5 - viewport.clientHeight * 0.5),
      );
    } else if (targetAnchor === "bottom") {
      nextScrollTop = maxScroll;
    }

    viewport.scrollTo({ top: nextScrollTop, behavior: "auto" });
  }, { testId: pageTestId, targetAnchor: anchor });
  await page.waitForTimeout(80);
}

async function collectConsoleMessages(page) {
  const consoleMessages = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({ type: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "request failed";
    const normalizedError = errorText.toLowerCase();
    const requestUrl = request.url();
    const isKnownAbort =
      normalizedError.includes("err_aborted")
      && (requestUrl.startsWith(BACKEND_URL) || requestUrl.startsWith(BASE_URL));
    if (isKnownAbort) {
      return;
    }
    consoleMessages.push({
      type: "requestfailed",
      text: `${request.method()} ${requestUrl} ${errorText}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      consoleMessages.push({
        type: "response",
        text: `${response.status()} ${response.url()}`,
      });
    }
  });
  return consoleMessages;
}

async function openRoute(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  const overlay = await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count();
  assertCondition(overlay === 0, `Error overlay detected on ${route}`);
  const bodyTextLength = await page.evaluate(() => document.body.innerText.trim().length);
  assertCondition(bodyTextLength > 0, `Blank page detected on ${route}`);
}

async function registerJsonFixtures(page, fixtures) {
  const registrations = [];
  for (const [apiPath, payload] of Object.entries(fixtures)) {
    const matcher = createBackendMatcher(apiPath);
    const handler = async (route, request) => {
      if (request.method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    };
    await page.route(matcher, handler);
    registrations.push([matcher, handler]);
  }
  return async () => {
    if (page.isClosed()) {
      return;
    }
    await Promise.all(registrations.map(async ([matcher, handler]) => {
      try {
        await page.unroute(matcher, handler);
      } catch (error) {
        if (!String(error?.message ?? error).includes("Target page, context or browser has been closed")) {
          throw error;
        }
      }
    }));
  };
}

function createPlatformAction(resourceType, resourceId, action, resource) {
  return {
    resourceType,
    resourceId,
    action,
    commandId: `${action.toLowerCase()}_${resourceId}`,
    auditId: `audit_${resourceId}`,
    appliedAt: Date.now(),
    resource,
  };
}

function mergeDeep(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return target;
  }
  const next = { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = mergeDeep(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

async function registerPlatformFixtureRoutes(page, stateName) {
  const state = buildPlatformFixtureState(stateName);
  const matcher = new RegExp(`^${escapeRegExp(BACKEND_URL)}(?:/.*)?$`);
  const handler = async (route, request) => {
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;

    const fulfill = async (payload, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });

    if (pathname === "/health") {
      await fulfill({ ok: true });
      return;
    }
    if (pathname === "/capabilities" && method === "GET") {
      await fulfill(state.capabilities);
      return;
    }
    if (pathname === "/workspace/workflow" && method === "GET") {
      await fulfill(state.workflow);
      return;
    }
    if (pathname === "/workspace/workflow/init" && method === "POST") {
      state.workflow.workspaceRoot = "D:/workspace";
      state.workflow.sccDir = "D:/workspace/.scc";
      state.workflow.projectInstructionsPresent = true;
      if (state.workflow.rules.length === 0) {
        state.workflow.rules.push({ name: "new-rule", summary: "Fresh workflow rule.", paths: [] });
      }
      await fulfill(createPlatformAction("WORKSPACE", "workspace", "UPSERT", state.workflow));
      return;
    }
    if (pathname === "/workspace/workflow/docs/import" && method === "POST") {
      state.workflow.docsImportSummary = {
        ...state.workflow.docsImportSummary,
        imported: state.workflow.docsImportSummary.imported + 1,
        importedMemoryCount: state.workflow.docsImportSummary.importedMemoryCount + 1,
        lastImportedAt: Date.now(),
      };
      await fulfill(createPlatformAction("WORKSPACE", "workspace", "IMPORT", state.workflow.docsImportSummary));
      return;
    }
    if (pathname === "/providers" && method === "GET") {
      await fulfill(state.providers);
      return;
    }
    if (pathname === "/providers/presets" && method === "GET") {
      await fulfill(state.providerPresets);
      return;
    }
    if (pathname === "/providers/secrets" && method === "GET") {
      await fulfill(state.providerSecrets);
      return;
    }
    if (pathname === "/providers/secrets" && method === "POST") {
      const nextSecret = {
        id: body?.secretId ?? `secret_${Date.now()}`,
        provider: body?.provider ?? state.providers[0]?.profile.id ?? "fixture-provider",
        label: body?.label ?? "Fixture secret",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hasValue: true,
        metadata: body?.metadata ?? {},
      };
      const existingIndex = state.providerSecrets.findIndex((entry) => entry.id === nextSecret.id);
      if (existingIndex >= 0) {
        state.providerSecrets[existingIndex] = nextSecret;
      } else {
        state.providerSecrets.push(nextSecret);
      }
      state.providers = state.providers.map((provider) => provider.profile.id === nextSecret.provider
        ? {
            ...provider,
            hasSecret: true,
            readiness: provider.implementationStatus === "external-auth-required"
              ? "external-auth-required"
              : provider.implementationStatus === "profile-only"
                ? "profile-only"
                : "ready",
            authSource: "secret-store",
            profile: {
              ...provider.profile,
              apiKeySecretId: nextSecret.id,
            },
          }
        : provider);
      state.capabilities.warnings = state.capabilities.warnings.filter((warning) => warning.code !== "missing-provider-secret");
      state.configHealth.issues = [];
      await fulfill(createPlatformAction("PROVIDER", nextSecret.provider, "SET_SECRET", nextSecret));
      return;
    }
    if (pathname.startsWith("/providers/")) {
      const segments = pathname.split("/").filter(Boolean);
      const providerId = segments[1];
      const index = state.providers.findIndex((entry) => entry.profile.id === providerId);
      const currentProvider = index >= 0 ? state.providers[index] : null;

      if (segments.length === 2 && method === "GET") {
        await fulfill(currentProvider);
        return;
      }
      if (segments.length === 2 && method === "PUT") {
        const nextProfile = {
          ...(currentProvider?.profile ?? {}),
          ...(body ?? {}),
          id: providerId,
        };
        const metadata = nextProfile.metadata && typeof nextProfile.metadata === "object" ? nextProfile.metadata : {};
        const preset = state.providerPresets.find((entry) => entry.id === metadata.presetId || entry.vendor === nextProfile.vendor) ?? null;
        const implementationStatus =
          metadata.implementationStatus ?? preset?.implementationStatus ?? currentProvider?.implementationStatus ?? "runnable";
        const capabilities =
          metadata.capabilities ?? preset?.capabilities ?? currentProvider?.capabilities ?? TEXT_PROVIDER_CAPABILITY;
        const authSource = nextProfile.apiKeySecretId ? (currentProvider?.hasSecret ? "secret-store" : "missing-secret") : "none";
        const readiness = implementationStatus === "external-auth-required"
          ? "external-auth-required"
          : implementationStatus === "profile-only"
            ? "profile-only"
            : authSource === "missing-secret"
              ? "missing-secret"
              : "ready";
        const nextProvider = {
          ...(currentProvider ?? {}),
          isDefault: currentProvider?.isDefault ?? false,
          isSavedDefault: currentProvider?.isSavedDefault ?? false,
          isRuntimeDefault: currentProvider?.isRuntimeDefault ?? false,
          profile: nextProfile,
          hasRegisteredClient: implementationStatus === "runnable",
          hasSecret: currentProvider?.hasSecret ?? false,
          readiness,
          authSource,
          implementationStatus,
          capabilities,
          adapter: {
            providerId,
            transport: nextProfile.transport ?? preset?.transport ?? "openai-compatible",
            vendor: nextProfile.vendor ?? preset?.vendor ?? "custom",
            baseUrl: nextProfile.baseUrl ?? preset?.baseUrl ?? null,
            timeoutMs: 30000,
          },
          model: {
            providerId,
            modelId: nextProfile.model,
            label: nextProfile.model,
            reasoning: null,
            verbosity: null,
            thinkingBudget: null,
          },
          variant: {
            providerId,
            variantId: "default",
            label: "default",
            isDefault: true,
            isSmallModel: false,
            taskPreference: null,
          },
        };
        if (index >= 0) {
          state.providers[index] = nextProvider;
        } else {
          state.providers.push(nextProvider);
        }
        await fulfill(createPlatformAction("PROVIDER", providerId, "UPSERT", nextProfile));
        return;
      }
      if (segments[2] === "test" && method === "POST") {
        if (currentProvider?.implementationStatus === "external-auth-required") {
          await fulfill({
            ok: false,
            providerId,
            message: "Provider preset requires external cloud authentication/configuration and has no runnable adapter registered.",
            capability: {},
          });
          return;
        }
        if (currentProvider?.implementationStatus === "profile-only") {
          await fulfill({
            ok: false,
            providerId,
            message: "Provider preset is cataloged as profile-only; no runnable adapter is registered in this release.",
            capability: {},
          });
          return;
        }
        const result = {
          ok: true,
          providerId,
          message: "Provider test succeeded.",
        };
        await fulfill(result);
        return;
      }
      if (segments[2] === "default" && method === "POST") {
        state.providers = state.providers.map((provider) => ({
          ...provider,
          isDefault: provider.profile.id === providerId,
          isSavedDefault: provider.profile.id === providerId,
          isRuntimeDefault: provider.profile.id === providerId,
        }));
        state.configState.current = mergeDeep(state.configState.current, {
          providers: {
            defaultProviderId: providerId,
          },
        });
        state.configState.savedDefaultProviderId = providerId;
        state.configState.reloadApplied = true;
        state.configState.restartRequired = false;
        const updatedProvider = state.providers.find((provider) => provider.profile.id === providerId) ?? null;
        await fulfill(createPlatformAction("PROVIDER", providerId, "SET_DEFAULT", updatedProvider));
        return;
      }
    }
    if (pathname === "/improvements/proposals" && method === "GET") {
      await fulfill(state.improvements);
      return;
    }
    if (pathname.startsWith("/improvements/proposals/")) {
      const segments = pathname.split("/").filter(Boolean);
      const proposalId = segments[2];
      const proposal = state.improvements.find((entry) => entry.proposalId === proposalId) ?? null;

      if (segments.length === 3 && method === "GET") {
        await fulfill(proposal);
        return;
      }

      if (segments[3] === "approve" && method === "POST" && proposal) {
        state.improvements = state.improvements.map((entry) => entry.proposalId === proposalId
          ? { ...entry, status: "APPROVED", updatedAt: Date.now() }
          : entry);
        await fulfill({ ok: true, proposalId, status: "APPROVED" });
        return;
      }

      if (segments[3] === "reject" && method === "POST" && proposal) {
        state.improvements = state.improvements.map((entry) => entry.proposalId === proposalId
          ? { ...entry, status: "REJECTED", updatedAt: Date.now() }
          : entry);
        await fulfill({ ok: true, proposalId, status: "REJECTED" });
        return;
      }
    }
    if (pathname === "/improvements/archive" && method === "GET") {
      await fulfill(state.archive);
      return;
    }
    if (pathname === "/improvements/report" && method === "GET") {
      await fulfill(state.complexReport);
      return;
    }
    if (pathname === "/config" && method === "GET") {
      await fulfill(state.configState);
      return;
    }
    if (pathname === "/config" && method === "PATCH") {
      state.configState.current = mergeDeep(state.configState.current, body ?? {});
      state.configState.savedDefaultProviderId = state.configState.current?.providers?.defaultProviderId ?? state.configState.savedDefaultProviderId ?? null;
      state.configState.reloadApplied = true;
      state.configState.restartRequired = false;
      await fulfill(createPlatformAction("CONFIG", "active", "UPDATE", state.configState));
      return;
    }
    if (pathname === "/config/reload" && method === "POST") {
      state.configState.reloadApplied = true;
      state.configState.restartRequired = false;
      await fulfill(createPlatformAction("CONFIG", "active", "RELOAD", state.configState));
      return;
    }
    if (pathname === "/config/health" && method === "GET") {
      await fulfill(state.configHealth);
      return;
    }
    if (pathname === "/skills" && method === "GET") {
      await fulfill(state.skills);
      return;
    }
    if (pathname === "/skills/refresh" && method === "POST") {
      await fulfill(createPlatformAction("SKILL", "catalog", "REFRESH", state.skills));
      return;
    }
    if (pathname === "/skills/import" && method === "POST") {
      const skill = {
        id: body?.id ?? body?.rootDir ?? `skill_${Date.now()}`,
        name: body?.name ?? "Imported skill",
        rootDir: body?.rootDir ?? "D:/skills/imported",
        description: body?.description,
        kind: body?.kind ?? "instruction-skill",
      };
      state.skills.push({
        skill,
        runtimeRegistered: true,
        capability: null,
        kind: skill.kind,
        readiness: "ready",
        assetSummary: null,
        instructionSource: null,
        declaredDependencies: { mcpServers: [] },
      });
      await fulfill(createPlatformAction("SKILL", skill.id, "IMPORT", skill));
      return;
    }
    if (pathname === "/skills/import-marketplace" && method === "POST") {
      const skill = {
        id: body?.skillPath ?? `marketplace_${Date.now()}`,
        name: body?.pluginName ?? "Marketplace skill",
        rootDir: body?.skillPath ?? "D:/skills/marketplace",
        description: "Imported from marketplace",
        kind: "instruction-skill",
      };
      state.skills.push({
        skill,
        runtimeRegistered: true,
        capability: null,
        kind: "instruction-skill",
        readiness: "ready",
        assetSummary: null,
        instructionSource: null,
        declaredDependencies: { mcpServers: [] },
      });
      await fulfill(createPlatformAction("SKILL", skill.id, "IMPORT", [skill]));
      return;
    }
    if (pathname === "/mcp" && method === "GET") {
      await fulfill(state.mcpServers);
      return;
    }
    if (pathname.startsWith("/mcp/")) {
      const serverId = pathname.split("/")[2];
      if (method === "PUT") {
        const server = {
          id: serverId,
          name: body?.name ?? serverId,
          transport: body?.transport ?? "stdio",
          command: body?.command,
          args: body?.args ?? [],
          url: body?.url,
        };
        const nextEntry = {
          server,
          clientRegistered: true,
          capability: null,
          readiness: "ready",
          declaredTools: [],
          declaredResources: [],
          declaredPrompts: [],
          availableTools: [],
          availableResources: [],
          availablePrompts: [],
          lastTestSummary: null,
        };
        const index = state.mcpServers.findIndex((entry) => entry.server.id === serverId);
        if (index >= 0) {
          state.mcpServers[index] = nextEntry;
        } else {
          state.mcpServers.push(nextEntry);
        }
        await fulfill(createPlatformAction("MCP", serverId, "UPSERT", server));
        return;
      }
      if (method === "DELETE") {
        state.mcpServers = state.mcpServers.filter((entry) => entry.server.id !== serverId);
        await fulfill(createPlatformAction("MCP", serverId, "DELETE", { ok: true, serverId }));
        return;
      }
      if (method === "POST" && pathname.endsWith("/test")) {
        const result = {
          ok: true,
          serverId,
          message: "MCP server is reachable.",
          capability: null,
        };
        const index = state.mcpServers.findIndex((entry) => entry.server.id === serverId);
        if (index >= 0) {
          state.mcpServers[index] = {
            ...state.mcpServers[index],
            lastTestSummary: { ok: true, message: result.message },
          };
        }
        await fulfill(result);
        return;
      }
    }

    await route.continue();
  };

  await page.route(matcher, handler);
  return async () => {
    if (!page.isClosed()) {
      await page.unroute(matcher, handler);
    }
  };
}

async function seedSmokeTask() {
  const response = await fetch(`${BACKEND_URL}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Frontend smoke seeded task",
      intent: "Render a populated task detail state for smoke validation.",
      preferredProviderId: null,
      units: [
        {
          id: "AGENT-001",
          role: "Smoke Validator",
          goal: "Expose a task detail record for the frontend smoke suite.",
          outputContract: "{\"summary\":\"string\",\"details\":\"string\"}",
          dependencies: [],
        },
      ],
    }),
  });
  assertCondition(response.ok, `Failed to create smoke task via ${BACKEND_URL}/tasks`);
}

async function collectVisualReviewChecklist(page, options) {
  return page.evaluate((config) => {
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    const pageNode = document.querySelector(`[data-testid="${config.pageTestId}"]`);

    function isVisible(node) {
      if (!(node instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.getClientRects().length === 0) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return rect.bottom > viewportRect.top + 4 && rect.top < viewportRect.bottom - 4;
    }

    const titleVisible =
      Array.isArray(config.titleSelectors) && config.titleSelectors.length > 0
        ? config.titleSelectors.some((selector) => isVisible(document.querySelector(selector)))
        : isVisible(((pageNode instanceof HTMLElement ? pageNode.querySelector("h1") : null) ?? document.querySelector("h1")));
    const primaryActionVisible =
      !Array.isArray(config.primaryActionSelectors)
      || config.primaryActionSelectors.length === 0
      || config.primaryActionSelectors.some((selector) => isVisible(document.querySelector(selector)));
    const keyElementsVisible =
      !Array.isArray(config.keySelectors)
      || config.keySelectors.every((selector) => isVisible(document.querySelector(selector)));
    const collapsedPanelsHidden =
      !Array.isArray(config.collapsedSelectors)
      || config.collapsedSelectors.every((selector) => !isVisible(document.querySelector(selector)));
    const visibleText = (() => {
      const root = pageNode instanceof HTMLElement ? pageNode : document.body;
      const fragments = Array.from(root.querySelectorAll("*"))
        .filter((node) => node instanceof HTMLElement && node.childElementCount === 0 && isVisible(node))
        .map((node) => node.innerText?.trim() ?? "")
        .filter(Boolean);
      return fragments.join("\n");
    })();
    const hiddenTextAbsent =
      !Array.isArray(config.hiddenTextSnippets)
      || config.hiddenTextSnippets.every((snippet) => !visibleText.includes(snippet));
    const descriptionNode = document.querySelector('[data-testid="page-header-description"]');
    const descriptionVisible = isVisible(descriptionNode);
    const headerReadable = (() => {
      if (config.requireDescription === false) {
        return true;
      }
      if (!(descriptionNode instanceof HTMLElement) || !descriptionVisible) {
        return window.innerWidth < 768;
      }
      const rect = descriptionNode.getBoundingClientRect();
      const styles = window.getComputedStyle(descriptionNode);
      const lineHeight = Number.parseFloat(styles.lineHeight || "0") || 20;
      const lineCount = rect.height / lineHeight;
      const minWidth = window.innerWidth >= 1280 ? 340 : window.innerWidth >= 768 ? 280 : 0;
      const maxLines = window.innerWidth >= 1280 ? 2.4 : 3.2;
      return rect.width >= minWidth && lineCount <= maxLines;
    })();
    const descriptionReadable = headerReadable;
    const emptyStateReadable = (() => {
      const visibleEmptyState = Array.from(
        document.querySelectorAll('[data-testid="empty-state"], [data-testid="empty-state-compact"]'),
      ).find((node) => isVisible(node));

      if (!(visibleEmptyState instanceof HTMLElement)) {
        return true;
      }

      const description = visibleEmptyState.querySelector("p");
      if (!(description instanceof HTMLElement)) {
        return true;
      }

      const rect = description.getBoundingClientRect();
      const styles = window.getComputedStyle(description);
      const lineHeight = Number.parseFloat(styles.lineHeight || "0") || 20;
      const lineCount = rect.height / lineHeight;
      const minWidth = window.innerWidth >= 1280 ? 220 : 170;
      return rect.width >= minWidth && lineCount <= 7;
    })();

    const viewportRect = viewport instanceof HTMLElement ? viewport.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const pageRect = pageNode instanceof HTMLElement ? pageNode.getBoundingClientRect() : { top: 0, bottom: 0 };
    const scrollContainerPresent = viewport instanceof HTMLElement && viewport.scrollHeight >= viewport.clientHeight;
    const noClipping =
      pageNode instanceof HTMLElement
      && viewport instanceof HTMLElement
      && (pageRect.bottom <= viewportRect.bottom + 2 || viewport.scrollHeight > viewport.clientHeight);

    return {
      titleVisible,
      primaryActionVisible,
      keyElementsVisible,
      collapsedPanelsHidden,
      hiddenTextAbsent,
      descriptionVisible,
      headerReadable,
      descriptionReadable,
      emptyStateReadable,
      scrollContainerPresent,
      noClipping,
      viewportHeight: viewport instanceof HTMLElement ? viewport.clientHeight : null,
      viewportScrollHeight: viewport instanceof HTMLElement ? viewport.scrollHeight : null,
      passes:
        titleVisible
        && primaryActionVisible
        && keyElementsVisible
        && collapsedPanelsHidden
        && hiddenTextAbsent
        && headerReadable
        && emptyStateReadable
        && scrollContainerPresent
        && noClipping,
    };
  }, options);
}

async function verifyPageVerticalScroll(page, pageTestId) {
  const metrics = await page.evaluate((testId) => {
    const pageNode = document.querySelector(`[data-testid="${testId}"]`);
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    if (!(pageNode instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      return { ok: false, reason: "missing_page_node" };
    }
    const pageRect = pageNode.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return {
      ok: pageRect.bottom <= viewportRect.bottom || viewport.scrollHeight > viewport.clientHeight,
      pageBottom: pageRect.bottom,
      viewportBottom: viewportRect.bottom,
      viewportScrollHeight: viewport.scrollHeight,
      viewportClientHeight: viewport.clientHeight,
    };
  }, pageTestId);
  assertCondition(Boolean(metrics.ok), `Page content may be clipped for ${pageTestId}: ${JSON.stringify(metrics)}`);
  return metrics;
}

async function ensureContextClosed(page) {
  const visible = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="task-inspector-scroll"]');
    return node instanceof HTMLElement && node.getClientRects().length > 0;
  });
  if (!visible) {
    return;
  }
  const toggle = page.getByRole("button", { name: /show details|hide details|show inspector|hide inspector|show context|hide context/i }).last();
  await toggle.click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="task-inspector-scroll"]');
    return !(node instanceof HTMLElement) || node.getClientRects().length === 0;
  });
}

async function ensureTaskSelected(page, viewport) {
  const taskItems = page.locator('[data-testid="task-list-item"]');
  if ((await taskItems.count()) === 0 && viewport.width < 1100) {
    const openThreadsButton = page.locator('[data-testid="task-open-threads"]').first();
    if ((await openThreadsButton.count()) > 0) {
      await openThreadsButton.evaluate((node) => {
        if (node instanceof HTMLElement) {
          node.scrollIntoView({ block: "center", inline: "nearest" });
        }
      });
      try {
        await openThreadsButton.click({ force: true });
      } catch {
        await openThreadsButton.evaluate((node) => {
          if (node instanceof HTMLElement) {
            node.click();
          }
        });
      }
      await page.waitForSelector('[data-testid="task-list-item"]');
    }
  }
  const availableTaskItems = page.locator('[data-testid="task-list-item"]');
  if ((await availableTaskItems.count()) === 0) {
    return { selected: false, reason: "no_task_items" };
  }
  await ensureContextClosed(page);
  const firstItem = availableTaskItems.first();
  await firstItem.evaluate((node) => {
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ block: "center", inline: "nearest" });
    }
  });
  try {
    await firstItem.click({ force: true });
  } catch {
    await firstItem.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
  }
  await page.waitForTimeout(350);
  return { selected: true };
}

async function verifyExplorerScroll(page) {
  const items = page.locator('[data-testid="task-list-item"]');
  if ((await items.count()) === 0) {
    return { checked: false, reason: "no_task_items" };
  }
  await page.locator('[data-testid="tasks-explorer-viewport"]').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const ok = await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="tasks-explorer-viewport"]');
    const items = Array.from(document.querySelectorAll('[data-testid="task-list-item"]'));
    const last = items.at(-1);
    if (!(viewport instanceof HTMLElement) || !(last instanceof HTMLElement)) {
      return false;
    }
    return last.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 2;
  });
  assertCondition(ok, "Last task item is clipped in the thread rail.");
  return { checked: true };
}

async function verifyTimelineScroll(page) {
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="task-detail-pane"]');
    if (node instanceof HTMLElement) {
      node.scrollTop = node.scrollHeight;
    }
  });
  const ok = await page.evaluate(() => {
    const detailPane = document.querySelector('[data-testid="task-detail-pane"]');
    const composer = document.querySelector('[data-testid="task-composer-card"]');
    return detailPane instanceof HTMLElement
      && composer instanceof HTMLElement
      && composer.getBoundingClientRect().bottom <= window.innerHeight + 2;
  });
  assertCondition(ok, "Timeline scroll did not keep the composer accessible.");
  return { checked: true };
}

async function verifyTaskShortViewportLayout(page) {
  const metrics = await page.evaluate(() => {
    function rectFor(selector) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) {
        return null;
      }
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    }

    function overlaps(left, right) {
      return Boolean(
        left
        && right
        && left.left < right.right
        && left.right > right.left
        && left.top < right.bottom
        && left.bottom > right.top
      );
    }

    const collapseButton = rectFor('[data-testid="task-threads-collapse-toggle"]');
    const createButton = rectFor('[data-testid="task-create-thread-inline"]');
    const detailPane = rectFor('[data-testid="task-detail-pane"]');
    const summary = rectFor('[data-testid="tasks-operator-summary"]');
    const timeline = rectFor('[data-testid="task-timeline-scroll"]');
    const actionBar = rectFor('[data-testid="task-bottom-action-bar"]');
    const summaryRatio = summary && detailPane ? summary.height / detailPane.height : null;

    return {
      collapseButton,
      createButton,
      overlap: overlaps(collapseButton, createButton),
      summary,
      timeline,
      actionBar,
      detailPane,
      summaryRatio,
      passes: Boolean(
        collapseButton
        && createButton
        && !overlaps(collapseButton, createButton)
        && summary
        && timeline
        && actionBar
        && detailPane
        && summaryRatio !== null
        && summaryRatio <= 0.34
        && timeline.height >= 150
      ),
    };
  });
  assertCondition(
    Boolean(metrics.passes),
    `Tasks short viewport layout is too crowded or overlapping: ${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function verifyTimelineSanitized(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  assertCondition(!bodyText.includes("[AGENT-001_OUTPUT]"), "Tasks page leaked raw explicit output.");
  assertCondition(!bodyText.includes('"current_unit"'), "Tasks page leaked raw tracker JSON.");
  assertCondition(!bodyText.includes('"tool_name"'), "Tasks page leaked raw tool JSON.");
  return { checked: true };
}

async function verifyTimelineEmptyCopyReadable(page) {
  const metrics = await page.evaluate(() => {
    const copy = document.querySelector('[data-testid="task-empty-timeline-copy"]');
    if (!(copy instanceof HTMLElement) || copy.getClientRects().length === 0) {
      return { ok: true, reason: "copy_not_visible" };
    }
    const rect = copy.getBoundingClientRect();
    const styles = window.getComputedStyle(copy);
    const lineHeight = Number.parseFloat(styles.lineHeight || "0") || 24;
    const lineCount = rect.height / lineHeight;
    return {
      ok: rect.width >= 240 && lineCount <= 3.2,
      width: rect.width,
      lineCount,
      text: copy.innerText,
    };
  });
  assertCondition(Boolean(metrics.ok), `Timeline empty copy is visually cramped: ${JSON.stringify(metrics)}`);
  return metrics;
}

async function verifyInspectorScroll(page) {
  if ((await page.locator('[data-testid="task-inspector-scroll"]').count()) === 0) {
    const explicitToggle = page.locator('[data-testid="task-context-toggle"]').last();
    const legacyToggle = page.getByRole("button", { name: /show details|hide details|show inspector|hide inspector|show context|hide context/i }).last();
    const toggle = (await explicitToggle.count()) > 0 ? explicitToggle : legacyToggle;
    await toggle.click();
    await page.waitForSelector('[data-testid="task-inspector-scroll"]');
  }
  await page.locator('[data-testid="task-inspector-scroll"]').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const ok = await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="task-inspector-scroll"]');
    const panels = Array.from(document.querySelectorAll('[data-testid="task-inspector"] .workbench-panel'));
    const last = panels.at(-1);
    return viewport instanceof HTMLElement
      && last instanceof HTMLElement
      && last.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 2;
  });
  assertCondition(ok, "Inspector content is clipped.");
  return { checked: true };
}

async function verifyAcceptanceInspector(page) {
  if ((await page.locator('[data-testid="task-inspector-scroll"]').count()) === 0) {
    const explicitToggle = page.locator('[data-testid="task-context-toggle"]').last();
    const legacyToggle = page.getByRole("button", { name: /show details|hide details|show inspector|hide inspector|show context|hide context/i }).last();
    const toggle = (await explicitToggle.count()) > 0 ? explicitToggle : legacyToggle;
    await toggle.click();
    await page.waitForSelector('[data-testid="task-inspector-scroll"]');
  }
  await page.locator('[data-testid="task-advanced-summary"]').evaluate((node) => {
    if (node instanceof HTMLDetailsElement && !node.open) {
      node.open = true;
    }
  });
  await page.locator('[data-testid="task-tab-acceptance"]').click();
  await page.waitForSelector('[data-testid="task-acceptance-panel"]');
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="task-acceptance-panel"]');
    const semantic = document.querySelector('[data-testid="task-acceptance-semantic-review"]');
    const layers = Array.from(document.querySelectorAll('[data-testid^="task-acceptance-layer-"]'));
    return {
      panelVisible: panel instanceof HTMLElement && panel.getClientRects().length > 0,
      semanticVisible: semantic instanceof HTMLElement && semantic.getClientRects().length > 0,
      layerCount: layers.filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0).length,
    };
  });
  assertCondition(metrics.panelVisible, "Acceptance panel is not visible.");
  assertCondition(metrics.semanticVisible, "Semantic review section is not visible.");
  assertCondition(metrics.layerCount >= 4, `Acceptance panel is missing expected layers: ${JSON.stringify(metrics)}`);
  return {
    checked: true,
    layerCount: metrics.layerCount,
  };
}

async function verifyToolActivityIcons(page) {
  const cardCount = await page.locator('[data-testid="task-tool-activity"]').count();
  assertCondition(cardCount > 0, "Expected at least one tool activity card for icon verification.");
  const iconCount = await page.locator('[data-testid="task-tool-activity-icon"]').count();
  assertCondition(iconCount >= cardCount, `Tool activity cards are missing icon nodes. cards=${cardCount} icons=${iconCount}`);
  return {
    checked: true,
    cardCount,
    iconCount,
  };
}

async function verifyToolExecutionDetails(page) {
  const summaries = page.locator('[data-testid="task-tool-activity-summary"]');
  const summaryCount = await summaries.count();
  for (let index = 0; index < summaryCount; index += 1) {
    await summaries.nth(index).click();
  }
  const execution = page.locator('[data-testid="task-tool-activity-execution"]');
  const executionCount = await execution.count();
  assertCondition(executionCount > 0, "Expected at least one tool activity to expose command execution details.");
  const text = await execution.first().innerText();
  assertCondition(/exit\s+1/i.test(text), `Execution details should include the exit code. text=${text}`);
  assertCondition(/stdout/i.test(text) && /stderr/i.test(text), `Execution details should include stdout and stderr sections. text=${text}`);
  assertCondition(/boom/i.test(text), `Execution stderr should include the real failure output. text=${text}`);
  return {
    checked: true,
    executionCount,
  };
}

async function verifyComposerRefreshAnchor(page) {
  const textarea = page.locator('[data-testid="task-continue-message"]').first();
  if (!(await textarea.isVisible().catch(() => false))) {
    const expandFollowUp = page.locator('[data-testid="task-action-expand-follow-up"]').first();
    if (await expandFollowUp.isVisible().catch(() => false)) {
      await expandFollowUp.click();
      await page.waitForTimeout(200);
    }
  }
  assertCondition(await textarea.isVisible().catch(() => false), "Expected the operator guidance textarea to be visible.");
  const draftValue = `smoke-anchor-${Date.now()}`;
  await textarea.fill(draftValue);
  const before = await page.evaluate(() => {
    const textareaNode = document.querySelector('[data-testid="task-continue-message"]');
    const composerNode = document.querySelector('[data-testid="task-composer-card"]');
    const draftNoticeNode = document.querySelector('[data-testid="task-composer-draft-lock-notice"]');
    const actionNode = document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]');
    if (!(textareaNode instanceof HTMLTextAreaElement) || !(composerNode instanceof HTMLElement)) {
      return null;
    }
    return {
      value: textareaNode.value,
      textareaTop: textareaNode.getBoundingClientRect().top,
      composerTop: composerNode.getBoundingClientRect().top,
      actionLabel: actionNode instanceof HTMLElement ? actionNode.innerText.trim() : null,
      draftNoticeVisible: draftNoticeNode instanceof HTMLElement && draftNoticeNode.getClientRects().length > 0,
    };
  });
  assertCondition(Boolean(before), "Could not capture the pre-refresh composer state.");
  await page.locator('[data-testid="task-action-refresh"]').click();
  await page.waitForTimeout(250);
  if (await clickVisibleContextToggle(page)) {
    await page.waitForTimeout(120);
    await clickVisibleContextToggle(page);
    await page.waitForTimeout(120);
  }
  await page.waitForSelector('[data-testid="task-composer-card"]', { timeout: 5_000 }).catch(() => null);
  await page.waitForSelector('[data-testid="task-continue-message"]', { timeout: 5_000 }).catch(() => null);
  const after = await page.evaluate(() => {
    const textareaNode = document.querySelector('[data-testid="task-continue-message"]');
    const composerNode = document.querySelector('[data-testid="task-composer-card"]');
    const draftNoticeNode = document.querySelector('[data-testid="task-composer-draft-lock-notice"]');
    const actionNode = document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]');
    if (!(textareaNode instanceof HTMLTextAreaElement) || !(composerNode instanceof HTMLElement)) {
      return null;
    }
    return {
      value: textareaNode.value,
      textareaTop: textareaNode.getBoundingClientRect().top,
      composerTop: composerNode.getBoundingClientRect().top,
      actionLabel: actionNode instanceof HTMLElement ? actionNode.innerText.trim() : null,
      draftNoticeVisible: draftNoticeNode instanceof HTMLElement && draftNoticeNode.getClientRects().length > 0,
    };
  });
  const afterDebug = after ?? await page.evaluate(() => ({
    composerCount: document.querySelectorAll('[data-testid="task-composer-card"]').length,
    textareaCount: document.querySelectorAll('[data-testid="task-continue-message"]').length,
    contextToggleCount: document.querySelectorAll('[data-testid="task-context-toggle"]').length,
    actionText: (document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]') instanceof HTMLElement
      ? document.querySelector('[data-testid="task-action-continue"], [data-testid="task-action-start"], [data-testid="task-action-resume"], [data-testid="task-action-restart"]')?.textContent?.trim()
      : null),
    composerText: document.querySelector('[data-testid="task-composer-card"]')?.textContent?.slice(0, 240) ?? null,
    bodyExcerpt: document.body.innerText.slice(0, 500),
  }));
  assertCondition(Boolean(after), `Composer disappeared after refresh and details toggles. debug=${JSON.stringify(afterDebug)}`);
  const actionStable = after.actionLabel === before.actionLabel || after.draftNoticeVisible;
  const unexpectedRestart = before.actionLabel !== "Restart task" && after.actionLabel === "Restart task" && !after.draftNoticeVisible;
  assertCondition(after.value === draftValue, `Composer draft was lost after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  assertCondition(actionStable && !unexpectedRestart, `Composer action changed unexpectedly after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  assertCondition(
    Math.abs(after.textareaTop - before.textareaTop) <= 24 && Math.abs(after.composerTop - before.composerTop) <= 24,
    `Composer shifted unexpectedly after refresh. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  return {
    checked: true,
    before,
    after,
  };
}

async function clickVisibleContextToggle(page) {
  const toggles = page.locator('[data-testid="task-context-toggle"]');
  const count = await toggles.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const toggle = toggles.nth(index);
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      return true;
    }
  }
  return false;
}

async function verifyNavigationButton(page, selector, expectedPathname, expectedSearch = null) {
  const button = page.locator(selector).first();
  assertCondition(await button.count(), `Missing navigation control: ${selector}`);
  await button.click({ force: true });
  await page.waitForURL((url) => {
    if (url.pathname !== expectedPathname) {
      return false;
    }
    if (expectedSearch === null) {
      return true;
    }
    return url.search === expectedSearch;
  });
  return {
    selector,
    pathname: expectedPathname,
    search: expectedSearch,
  };
}

async function verifyThreadNavigation(page, selector, expectedTaskId, expectedTitle) {
  const button = page.locator(selector).first();
  assertCondition(await button.count(), `Missing thread action: ${selector}`);
  await button.click({ force: true });
  await page.waitForURL((url) => url.pathname === "/tasks" && url.searchParams.get("task") === expectedTaskId);
  await page.waitForSelector('[data-testid="task-detail-pane"]');
  const titleSelector = '[data-testid="tasks-operator-summary"] h2';
  let observedTitle = '';
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    observedTitle = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      return node instanceof HTMLElement ? node.innerText.trim() : '';
    }, titleSelector);
    if (observedTitle && observedTitle !== 'Select a thread' && observedTitle === expectedTitle) {
      break;
    }
    await page.waitForTimeout(300);
  }
  if (observedTitle) {
    assertCondition(
      observedTitle === expectedTitle,
      `Opened /tasks?task=${expectedTaskId} but summary title was "${observedTitle}" instead of "${expectedTitle}".`
    );
  }
  await page.waitForLoadState("networkidle");
  return {
    taskId: expectedTaskId,
    title: observedTitle,
  };
}

async function verifySettingsRefresh(page, navTestId) {
  const button = page.locator('[data-testid="settings-refresh-status"]');
  assertCondition(await button.count(), "Missing settings refresh action.");
  await button.click({ force: true });
  await page.waitForSelector(`[data-testid="${navTestId}"]`);
  await page.waitForSelector('[data-testid="settings-page"]');
  return {
    refreshed: true,
    navTestId,
  };
}

async function verifySettingsTabs(page) {
  const tabs = [
    { key: "general", route: "/settings/general", nav: "settings-general-page" },
    { key: "connections", route: "/settings/connections", nav: "settings-connections-page" },
    { key: "capabilities", route: "/settings/capabilities", nav: "settings-capabilities-page" },
    { key: "skills", route: "/settings/skills", nav: "settings-skills-page" },
    { key: "state", route: "/settings/state", nav: "settings-state-page" },
    { key: "improvements", route: "/settings/improvements", nav: "settings-improvements-page" },
  ];

  for (const tab of tabs) {
    await page.locator(`[data-testid="settings-tab-${tab.key}"]`).click({ force: true });
    await page.waitForURL((url) => url.pathname === tab.route);
    await page.waitForSelector(`[data-testid="${tab.nav}"]`);
    const settingsNavActive = await page.locator('[data-testid="app-nav-settings"]').getAttribute('data-active');
    assertCondition(
      settingsNavActive === 'true',
      `Top navigation lost the Settings active state after opening ${tab.key}.`,
    );
  }
  await page.locator('[data-testid="settings-tab-general"]').click({ force: true });
  await page.waitForURL((url) => url.pathname === "/settings/general");
  await page.waitForSelector('[data-testid="settings-general-page"]');

  return {
    visitedTabs: tabs.map((tab) => tab.key),
  };
}

async function waitForSettingsNotice(page, pattern) {
  await page.waitForSelector('[data-testid="settings-toast"]');
  await page.waitForFunction(
    ({ selector, source, flags }) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const text = node instanceof HTMLElement ? node.innerText : "";
        return new RegExp(source, flags).test(text);
      });
    },
    {
      selector: '[data-testid="settings-toast"]',
      source: pattern.source,
      flags: pattern.flags,
    },
    { timeout: 10_000 },
  );
  return page.evaluate(
    ({ selector, source, flags }) => {
      const pattern = new RegExp(source, flags);
      const node = Array.from(document.querySelectorAll(selector)).find((entry) => {
        const text = entry instanceof HTMLElement ? entry.innerText : "";
        return pattern.test(text);
      });
      return node instanceof HTMLElement ? node.innerText : "";
    },
    {
      selector: '[data-testid="settings-toast"]',
      source: pattern.source,
      flags: pattern.flags,
    },
  );
}

async function captureViewportContentRect(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    if (!(viewport instanceof HTMLElement)) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function verifyOverlayLayout(page, {
  label,
  containerSelector,
  panelSelector,
  bodySelector,
  footerSelector,
  baselineRect = null,
  minWidth = 360,
}) {
  const metrics = await page.evaluate((config) => {
    function getRect(node) {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) {
        return null;
      }
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    }

    function isVisible(node) {
      return Boolean(getRect(node));
    }

    const container = document.querySelector(config.containerSelector);
    const panel = document.querySelector(config.panelSelector);
    const body = config.bodySelector ? document.querySelector(config.bodySelector) : panel;
    const footer = config.footerSelector ? document.querySelector(config.footerSelector) : null;
    const header = panel instanceof HTMLElement ? panel.querySelector("h1, h2, [data-testid$='-header']") : null;
    const viewport = document.querySelector('[data-testid="app-content"]') ?? document.querySelector("main");
    const viewportRect = getRect(viewport);
    const panelRect = getRect(panel);
    const bodyRect = getRect(body);
    const footerRect = footer ? getRect(footer) : null;
    const headerRect = getRect(header);
    const bodyBlocks = body instanceof HTMLElement
      ? Array.from(body.querySelectorAll("p, li")).filter((node) => isVisible(node))
      : [];

    const textMetrics = bodyBlocks.map((node) => {
      const rect = node.getBoundingClientRect();
      const styles = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(styles.lineHeight || "0") || 20;
      return {
        width: rect.width,
        lineCount: rect.height / lineHeight,
        text: node.textContent?.trim() ?? "",
      };
    });

    const minTextWidth = window.innerWidth >= 1280 ? 260 : window.innerWidth >= 768 ? 220 : 150;
    const effectiveMinWidth = Math.min(config.minWidth, Math.max(280, window.innerWidth - 32));
    const maxBlockLines = window.innerWidth >= 1280 ? 9 : 12;
    const textReadable = textMetrics.every((metric) => metric.width >= minTextWidth && metric.lineCount <= maxBlockLines);
    const centerDelta = panelRect ? Math.abs((panelRect.left + panelRect.width / 2) - window.innerWidth / 2) : null;
    const layoutStable = !config.baselineRect || !viewportRect
      ? true
      : Math.abs(viewportRect.top - config.baselineRect.top) <= 4
        && Math.abs(viewportRect.left - config.baselineRect.left) <= 4
        && Math.abs(viewportRect.width - config.baselineRect.width) <= 8
        && Math.abs(viewportRect.height - config.baselineRect.height) <= 8;

    return {
      panelRect,
      headerVisible: isVisible(header),
      bodyVisible: isVisible(body),
      footerVisible: footer ? isVisible(footer) : true,
      containerVisible: isVisible(container),
      bodyTextMetrics: textMetrics,
      minTextWidth,
      effectiveMinWidth,
      maxBlockLines,
      textReadable,
      centered: centerDelta === null ? false : centerDelta <= 48,
      inViewport: Boolean(
        panelRect
          && panelRect.top >= 8
          && panelRect.left >= 8
          && panelRect.bottom <= window.innerHeight - 8
          && panelRect.right <= window.innerWidth - 8,
      ),
      layoutStable,
      passes: Boolean(
        isVisible(container)
          && panelRect
          && panelRect.width >= effectiveMinWidth
          && isVisible(body)
          && (footer ? isVisible(footer) : true)
          && isVisible(header)
          && textReadable
          && layoutStable
          && (centerDelta === null ? false : centerDelta <= 48)
          && panelRect.top >= 8
          && panelRect.left >= 8
          && panelRect.bottom <= window.innerHeight - 8
          && panelRect.right <= window.innerWidth - 8,
      ),
    };
  }, {
    containerSelector,
    panelSelector,
    bodySelector,
    footerSelector,
    baselineRect,
    minWidth,
  });

  assertCondition(
    Boolean(metrics.passes),
    `${label} overlay is visually unstable: ${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function verifySettingsGeneralForm(page) {
  await page.waitForSelector('[data-testid="settings-general-permission-mode"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-general-permission-mode"]').selectOption("ask");
  const sseToggle = page.locator('[data-testid="settings-general-sse-fallback"]');
  const delegationToggle = page.locator('[data-testid="settings-general-delegation-enabled"]');
  const initial = await sseToggle.isChecked();
  const initialDelegation = await delegationToggle.isChecked();
  await sseToggle.click({ force: true });
  await delegationToggle.click({ force: true });
  await page.locator('[data-testid="settings-general-save"]').click();
  const notice = await waitForSettingsNotice(page, /saved/i);
  return {
    saved: true,
    notice,
    sseToggled: initial !== (await sseToggle.isChecked()),
    delegationToggled: initialDelegation !== (await delegationToggle.isChecked()),
  };
}

async function verifyDelegationCard(page, childTitle) {
  await page.waitForSelector('[data-testid="task-delegation-card"]', { timeout: 10_000 });
  const summary = await page.locator('[data-testid="task-delegation-summary"]').first().innerText();
  const taskTitles = await page.locator('[data-testid="task-list-item"]').allInnerTexts();
  assertCondition(
    taskTitles.every((title) => !title.includes(childTitle)),
    `Delegated child "${childTitle}" leaked into the top-level task rail.`,
  );
  assertCondition(
    summary.toLowerCase().includes("scoped result") || summary.toLowerCase().includes("subtask"),
    `Delegation card summary did not explain the child status. Summary=${summary}`,
  );
  return {
    summary,
    childHiddenFromRail: true,
  };
}

async function verifySettingsConnectionsForm(page) {
  const initialTruth = await page.evaluate(() => {
    const switches = Array.from(document.querySelectorAll('[data-testid^="settings-connections-provider-default-"]'));
    const checkedCount = switches.filter((node) => node.getAttribute('aria-checked') === 'true').length;
    const hasRuntimePending = Boolean(document.querySelector('[data-testid="settings-connections-runtime-pending"]'));
    const hasNoEnabledProvider = Boolean(document.querySelector('[data-testid="settings-connections-no-enabled-provider"]'));
    return {
      checkedCount,
      hasRuntimePending,
      hasNoEnabledProvider,
    };
  });
  assertCondition(
    initialTruth.checkedCount > 0 || initialTruth.hasRuntimePending || initialTruth.hasNoEnabledProvider,
    `Connections roster rendered without a saved enabled switch or an explanatory truth banner: ${JSON.stringify(initialTruth)}`,
  );

  const createBaseline = await captureViewportContentRect(page);
  await page.locator('[data-testid="settings-connections-create"]').click();
  await page.waitForSelector('[data-testid="settings-connections-provider-modal"]', { timeout: 10_000 });
  const createModalLayout = await verifyOverlayLayout(page, {
    label: "settings-connections-create-modal",
    containerSelector: '[data-testid="settings-connections-provider-modal"]',
    panelSelector: '[data-testid="settings-connections-provider-modal-panel"]',
    bodySelector: '[data-testid="settings-connections-provider-modal-body"]',
    footerSelector: '[data-testid="settings-connections-provider-modal-footer"]',
    baselineRect: createBaseline,
    minWidth: 520,
  });
  const modalHeader = page.locator('[data-testid="settings-connections-provider-modal-header"]');
  const headerBefore = await modalHeader.boundingBox();
  assertCondition(Boolean(headerBefore?.height), 'Connections modal header is missing a measurable height.');
  const presetSelect = page.locator('[data-testid="settings-connections-provider-template"]');
  const presetOptions = await presetSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => ({
    value: node.value,
    label: node.textContent?.trim() ?? '',
  })));
  assertCondition(
    presetOptions.some((option) => option.value === "openai" && /runnable/i.test(option.label)),
    `Connections preset list is missing runnable API key preset details: ${JSON.stringify(presetOptions)}`,
  );
  assertCondition(
    presetOptions.some((option) => option.value === "azure_openai" && /external-auth-required/i.test(option.label)),
    `Connections preset list is missing enterprise non-runnable preset details: ${JSON.stringify(presetOptions)}`,
  );
  assertCondition(
    presetOptions.some((option) => option.value === "ollama" && /runnable/i.test(option.label)),
    `Connections preset list is missing local runnable preset details: ${JSON.stringify(presetOptions)}`,
  );
  assertCondition(
    presetOptions.some((option) => option.value === "cohere" && /profile-only/i.test(option.label)),
    `Connections preset list is missing profile-only preset details: ${JSON.stringify(presetOptions)}`,
  );
  await presetSelect.selectOption("azure_openai");
  const enterpriseNotice = await waitForSettingsNotice(page, /loaded /i);
  await page.waitForSelector('[data-testid="settings-connections-provider-non-runnable"]', { timeout: 10_000 });
  const nonRunnableText = await page.locator('[data-testid="settings-connections-provider-non-runnable"]').innerText();
  assertCondition(/external cloud authentication/i.test(nonRunnableText), `Enterprise preset did not explain external auth: ${nonRunnableText}`);
  await page.locator('[data-testid="settings-connections-provider-config-field-resource"]').fill("resource-name");
  await page.locator('[data-testid="settings-connections-provider-config-field-deployment"]').fill("deployment-name");
  await page.locator('[data-testid="settings-connections-provider-config-field-api_version"]').fill("2024-10-21");
  await presetSelect.selectOption("ollama");
  const templateNotice = await waitForSettingsNotice(page, /loaded /i);
  const headerAfter = await modalHeader.boundingBox();
  assertCondition(Boolean(headerAfter?.height), 'Connections modal header lost its measurable height after switching templates.');
  assertCondition(
    Math.abs((headerAfter?.height ?? 0) - (headerBefore?.height ?? 0)) <= 2,
    `Connections modal header height shifted while switching templates. Before=${headerBefore?.height ?? 0} After=${headerAfter?.height ?? 0}`,
  );
  await page.locator('[data-testid="settings-connections-provider-secret-value-new"]').fill("");
  await page.locator('[data-testid="settings-connections-provider-create-submit"]').click();
  const createNotice = await waitForSettingsNotice(page, /created provider/i);
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-connections-provider-modal"]'));
  const editButton = page.locator('[data-testid^="settings-connections-provider-edit-"]').first();
  await editButton.waitFor({ timeout: 10_000 });
  const editBaseline = await captureViewportContentRect(page);
  await editButton.click();
  await page.waitForSelector('[data-testid="settings-connections-provider-modal"]', { timeout: 10_000 });
  const editModalLayout = await verifyOverlayLayout(page, {
    label: "settings-connections-edit-modal",
    containerSelector: '[data-testid="settings-connections-provider-modal"]',
    panelSelector: '[data-testid="settings-connections-provider-modal-panel"]',
    bodySelector: '[data-testid="settings-connections-provider-modal-body"]',
    footerSelector: '[data-testid="settings-connections-provider-modal-footer"]',
    baselineRect: editBaseline,
    minWidth: 520,
  });
  await page.waitForSelector('[data-testid^="settings-connections-provider-label-"]', { timeout: 10_000 });
  const label = page.locator('[data-testid^="settings-connections-provider-label-"]').first();
  const labelTestId = await label.getAttribute('data-testid');
  const providerId = labelTestId?.replace('settings-connections-provider-label-', '') ?? null;
  assertCondition(Boolean(providerId), 'Could not resolve a provider row for Settings > Connections.');
  await label.fill("Xiaomi Live Updated");
  await page.locator('[data-testid^="settings-connections-provider-secret-value-"]').first().fill("demo-key");
  await page.locator(`[data-testid="settings-connections-provider-save-${providerId}"]`).click();
  const saveNotice = await waitForSettingsNotice(page, /saved provider/i);
  await page.locator(`[data-testid="settings-connections-provider-test-${providerId}"]`).click();
  const testNotice = await waitForSettingsNotice(page, /tested provider/i);
  const defaultButton = page.locator('[data-testid^="settings-connections-provider-default-"]:not([disabled])').first();
  let defaultNotice = 'Already enabled provider.';
  let enabledProviderPersisted = 'No enabled provider change detected.';
  if (await defaultButton.count()) {
    const enabledTestId = await defaultButton.getAttribute('data-testid');
    await defaultButton.click();
    defaultNotice = await waitForSettingsNotice(page, /(enabled provider|default provider)/i);
    await page.locator('[data-testid="settings-refresh-status"]').click();
    await page.waitForTimeout(500);
    if (enabledTestId) {
      const enabledAfterRefresh = await page.locator(`[data-testid="${enabledTestId}"]`).getAttribute('aria-checked');
      assertCondition(
        enabledAfterRefresh === 'true',
        `Enabled provider toggle did not remain selected after refresh for ${enabledTestId}.`,
      );
      enabledProviderPersisted = enabledTestId;
    }
  }
  const persistedTruth = await page.evaluate(() => {
    const switches = Array.from(document.querySelectorAll('[data-testid^="settings-connections-provider-default-"]'));
    return {
      checkedCount: switches.filter((node) => node.getAttribute('aria-checked') === 'true').length,
      hasRuntimePending: Boolean(document.querySelector('[data-testid="settings-connections-runtime-pending"]')),
    };
  });
  assertCondition(
    persistedTruth.checkedCount > 0 || persistedTruth.hasRuntimePending,
    `Connections refresh lost the saved enabled provider truth: ${JSON.stringify(persistedTruth)}`,
  );
  const deleteButton = page.locator('[data-testid^="settings-connections-provider-delete-"]').first();
  await deleteButton.waitFor({ timeout: 10_000 });
  const deleteBaseline = await captureViewportContentRect(page);
  await deleteButton.click();
  await page.waitForSelector('[data-testid="settings-connections-delete-dialog"]', { timeout: 10_000 });
  const deleteDialogLayout = await verifyOverlayLayout(page, {
    label: "settings-connections-delete-dialog",
    containerSelector: '[data-testid="settings-connections-delete-dialog"]',
    panelSelector: '[data-testid="settings-connections-delete-dialog-panel"]',
    bodySelector: '[data-testid="settings-connections-delete-dialog-body"]',
    footerSelector: '[data-testid="settings-connections-delete-dialog-footer"]',
    baselineRect: deleteBaseline,
    minWidth: 360,
  });
  await page.locator('[data-testid="settings-connections-delete-cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-connections-delete-dialog"]'));
  return {
    enterprisePreset: enterpriseNotice,
    templated: templateNotice,
    createdLocal: createNotice,
    saved: saveNotice,
    tested: testNotice,
    defaulted: defaultNotice,
    secretSaved: saveNotice,
    initialTruth,
    persistedTruth,
    enabledProviderPersisted,
    overlays: {
      createModalLayout,
      editModalLayout,
      deleteDialogLayout,
    },
  };
}

async function verifySettingsCapabilitiesForm(page) {
  await page.waitForSelector('[data-testid="settings-capabilities-workflow-init"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-capabilities-workflow-init"]').click();
  const initNotice = await waitForSettingsNotice(page, /workflow initialized/i);
  await page.locator('[data-testid="settings-capabilities-workflow-import-docs"]').click();
  const importNotice = await waitForSettingsNotice(page, /docs import completed/i);
  await page.locator('[data-testid="settings-capabilities-mcp-create"]').click();
  await page.waitForSelector('[data-testid="settings-capabilities-mcp-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-capabilities-mcp-new-id"]').fill("mcp-new");
  await page.locator('[data-testid="settings-capabilities-mcp-new-name"]').fill("New MCP");
  await page.locator('[data-testid="settings-capabilities-mcp-create-submit"]').click();
  const createNotice = await waitForSettingsNotice(page, /created mcp server/i);
  await page.locator('[data-testid="settings-capabilities-mcp-test-mcp-new"]').click();
  const testNotice = await waitForSettingsNotice(page, /tested mcp server/i);
  await page.locator('[data-testid="settings-capabilities-mcp-delete-mcp-new"]').click();
  await page.waitForSelector('[data-testid="settings-capabilities-mcp-delete-dialog"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-capabilities-mcp-delete-confirm"]').click();
  const deleteNotice = await waitForSettingsNotice(page, /removed mcp server/i);
  return {
    workflowInit: initNotice,
    workflowImport: importNotice,
    createNotice,
    testNotice,
    deleteNotice,
  };
}

async function verifySettingsSkillsForm(page) {
  await page.waitForSelector('[data-testid="settings-skills-refresh"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-skills-refresh"]').click();
  const refreshNotice = await waitForSettingsNotice(page, /skill catalog refreshed/i);
  await page.locator('[data-testid="settings-skills-open-local-import"]').click();
  await page.waitForSelector('[data-testid="settings-skills-import-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-skills-import-root"]').fill("D:/skills/local-skill");
  await page.locator('[data-testid="settings-skills-import-name"]').fill("Local Skill");
  await page.locator('[data-testid="settings-skills-import-local"]').click();
  const localNotice = await waitForSettingsNotice(page, /local skill imported/i);
  await page.locator('[data-testid="settings-skills-open-marketplace-import"]').click();
  await page.waitForSelector('[data-testid="settings-skills-marketplace-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-skills-marketplace-file"]').fill("D:/marketplace.json");
  await page.locator('[data-testid="settings-skills-marketplace-plugin"]').fill("demo-plugin");
  await page.locator('[data-testid="settings-skills-import-marketplace"]').click();
  const marketplaceNotice = await waitForSettingsNotice(page, /marketplace skill import completed/i);
  const viewButton = page.locator('[data-testid^="settings-skills-view-"]').first();
  await viewButton.waitFor({ timeout: 10_000 });
  const readOnlyBaseline = await captureViewportContentRect(page);
  await viewButton.click();
  await page.waitForSelector('[data-testid="settings-skills-modal"]', { timeout: 10_000 });
  const readOnlyModalLayout = await verifyOverlayLayout(page, {
    label: "settings-skills-read-only-modal",
    containerSelector: '[data-testid="settings-skills-modal"]',
    panelSelector: '[data-testid="settings-skills-modal-panel"]',
    bodySelector: '[data-testid="settings-skills-modal-body"]',
    footerSelector: '[data-testid="settings-skills-modal-footer"]',
    baselineRect: readOnlyBaseline,
    minWidth: 640,
  });
  const readOnlyName = page.locator('[data-testid="settings-skills-editor-name"]');
  const readOnlyContent = page.locator('[data-testid="settings-skills-editor-content"]');
  assertCondition(
    !(await readOnlyName.isEditable()),
    'Read-only skill view left the name field editable.',
  );
  assertCondition(
    !(await readOnlyContent.isEditable()),
    'Read-only skill view left the content field editable.',
  );
  assertCondition(
    (await page.locator('[data-testid^="settings-skills-save-"]').count()) === 0
      && (await page.locator('[data-testid="settings-skills-create-submit"]').count()) === 0
      && (await page.locator('[data-testid^="settings-skills-duplicate-submit-"]').count()) === 0,
    'Read-only skill modal still rendered a mutable submit action.',
  );
  await page.locator('[data-testid="settings-skills-modal-footer"]').getByRole('button', { name: 'Close' }).click();
  return {
    refreshNotice,
    localNotice,
    marketplaceNotice,
    readOnlyViewVerified: true,
    overlays: {
      readOnlyModalLayout,
    },
  };
}

async function verifySettingsStatePanel(page) {
  await page.waitForSelector('[data-testid="settings-state-refresh-status"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-state-refresh-status"]').click();
  const refreshNotice = await waitForSettingsNotice(page, /status refreshed/i);
  await page.locator('[data-testid="settings-state-config-reload"]').click();
  const reloadNotice = await waitForSettingsNotice(page, /reload requested/i);
  return {
    refreshNotice,
    reloadNotice,
  };
}

async function verifySettingsImprovementsPanel(page) {
  await page.waitForSelector('[data-testid^="settings-improvement-"]', { timeout: 10_000 });
  await page.locator('[data-testid="settings-improvements-filter-conflicted"]').click();
  await page.waitForSelector('[data-testid^="settings-improvement-proposal_fixture_conflict_delivery"]');
  await page.locator('[data-testid="settings-improvements-filter-duplicates"]').click();
  await page.waitForSelector('[data-testid^="settings-improvement-proposal_fixture_duplicate_delivery"]');
  await page.locator('[data-testid="settings-improvements-filter-archive-eligible"]').click();
  await page.waitForSelector('[data-testid^="settings-archive-archive-entry-01"]');
  await page.locator('[data-testid="settings-improvements-filter-all"]').click();
  const proposalCount = await page.locator('[data-testid^="settings-improvement-"]').count();
  const archiveCount = await page.locator('[data-testid^="settings-archive-"]').count();
  return {
    proposalCount,
    archiveCount,
    filtersChecked: ["conflicted", "duplicates", "archive-eligible", "all"],
  };
}

async function verifyTaskDeleteDialog(page) {
  const baselineRect = await captureViewportContentRect(page);
  await page.locator('[data-testid="task-action-delete"]').click();
  await page.waitForSelector('[data-testid="task-delete-dialog"]', { timeout: 10_000 });
  const dialogLayout = await verifyOverlayLayout(page, {
    label: "task-delete-dialog",
    containerSelector: '[data-testid="task-delete-dialog"]',
    panelSelector: '[data-testid="task-delete-dialog-panel"]',
    bodySelector: '[data-testid="task-delete-dialog-body"]',
    footerSelector: '[data-testid="task-delete-dialog-footer"]',
    baselineRect,
    minWidth: 360,
  });
  await page.locator('[data-testid="task-delete-cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="task-delete-dialog"]'));
  return dialogLayout;
}

async function verifyEmptyStateCopy(page, text) {
  await page.getByText(text, { exact: true }).waitFor();
  return {
    emptyState: text,
  };
}

async function createPageWithConsole(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const consoleMessages = await collectConsoleMessages(page);
  return { page, consoleMessages };
}

async function captureScenario(browser, viewport, scenario) {
  const { page, consoleMessages } = await createPageWithConsole(browser, viewport);
  let cleanup = async () => {};
  try {
    if (typeof scenario.registerRoutes === "function") {
      cleanup = await scenario.registerRoutes(page, viewport);
    } else if (scenario.fixtures) {
      cleanup = await registerJsonFixtures(page, scenario.fixtures);
    }
    await openRoute(page, scenario.route);
    if (Array.isArray(scenario.waitForSelectors)) {
      for (const selector of scenario.waitForSelectors) {
        await page.waitForSelector(selector, { timeout: 10_000 });
      }
    }
    if (typeof scenario.afterOpen === "function") {
      await scenario.afterOpen(page, viewport);
    }
    const functionalChecks = typeof scenario.functionalChecks === "function"
      ? await scenario.functionalChecks(page, viewport)
      : null;
    assertCondition(
      functionalChecks === null || functionalChecks.passes !== false,
      `${scenario.page} (${scenario.state}) functional checks failed for ${viewport.name}: ${JSON.stringify(functionalChecks)}`,
    );
    await openRoute(page, scenario.route);
    if (Array.isArray(scenario.waitForSelectors)) {
      for (const selector of scenario.waitForSelectors) {
        await page.waitForSelector(selector, { timeout: 10_000 });
      }
    }
    await scrollScenarioToAnchor(page, scenario.pageTestId, "top");
    const metrics = await verifyPageVerticalScroll(page, scenario.pageTestId);
    const anchorCaptures = [];

    for (const scrollAnchor of getScenarioScrollAnchors(scenario)) {
      await scrollScenarioToAnchor(page, scenario.pageTestId, scrollAnchor);
      const visualReviewChecklist = await collectVisualReviewChecklist(page, scenario.checklist);
      assertCondition(
        visualReviewChecklist.passes,
        `${scenario.page} (${scenario.state}) visual checklist failed for ${viewport.name} @ ${scrollAnchor}: ${JSON.stringify(visualReviewChecklist)}`,
      );
      const screenshotPath = await captureViewportScreenshot(page, viewport.name, `${scenario.screenshotName}--${scrollAnchor}`);
      anchorCaptures.push({
        scrollAnchor,
        viewportHeightVariant: getViewportHeightVariant(viewport),
        screenshotPath,
        visualReviewChecklist,
      });
    }

    const extras = typeof scenario.extraChecks === "function" ? await scenario.extraChecks(page, viewport) : null;
    const topCapture = anchorCaptures[0];
    return {
      entries: anchorCaptures.map((capture) => ({
        page: scenario.page,
        state: scenario.state,
        viewport: viewport.name,
        viewportHeightVariant: capture.viewportHeightVariant,
        scrollAnchor: capture.scrollAnchor,
        screenshotPath: capture.screenshotPath,
        visualReviewChecklist: capture.visualReviewChecklist,
        functionalChecks,
      })),
      result: {
        page: scenario.page,
        state: scenario.state,
        route: scenario.route,
        metrics,
        screenshotPath: topCapture.screenshotPath,
        visualReviewChecklist: topCapture.visualReviewChecklist,
        anchorCaptures,
        functionalChecks,
        extras,
      },
      consoleMessages,
    };
  } finally {
    await page.close();
    await cleanup();
  }
}

function buildActualScenarios(viewport) {
  return [
    {
      page: "dashboard",
      route: "/dashboard",
      state: "actual",
      pageTestId: "dashboard-page",
      screenshotName: "dashboard",
      waitForSelectors: ['[data-testid="dashboard-page"]'],
      checklist: {
        pageTestId: "dashboard-page",
        primaryActionSelectors: ['[data-testid="dashboard-open-tasks"]'],
        keySelectors: ['[data-testid="dashboard-page"] h1'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page) => ({
        passes: true,
        actions: [
          await verifyNavigationButton(page, '[data-testid="dashboard-open-tasks"]', "/tasks"),
        ],
      }),
    },
    {
      page: "queue",
      route: "/queue",
      state: "actual",
      pageTestId: "queue-page",
      screenshotName: "queue",
      waitForSelectors: ['[data-testid="queue-page"]', '[data-testid="queue-recovery-summary"]'],
      checklist: {
        pageTestId: "queue-page",
        primaryActionSelectors: ['[data-testid="queue-return-tasks"]', '[data-testid="queue-open-state"]'],
        keySelectors: ['[data-testid="queue-page"] h1'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page) => ({
        passes: true,
        actions: [
          await verifyNavigationButton(page, '[data-testid="queue-return-tasks"]', "/tasks"),
        ],
      }),
    },
    ...SETTINGS_PAGES.map((pageConfig) => ({
      page: pageConfig.page,
      route: pageConfig.route,
      state: "actual",
      pageTestId: "settings-page",
      screenshotName: pageConfig.page,
      waitForSelectors: [`[data-testid="${pageConfig.navTestId}"]`],
      checklist: {
        pageTestId: "settings-page",
        primaryActionSelectors: ['[data-testid="settings-refresh-status"]'],
        keySelectors: ['[data-testid="settings-page"] h1', `[data-testid="${pageConfig.navTestId}"]`],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      afterOpen: pageConfig.page === "settings-connections"
        ? async (page) => {
            for (const subRoute of ["/settings/providers", "/settings/secrets"]) {
              await openRoute(page, subRoute);
              await page.waitForSelector('[data-testid="settings-connections-page"]');
            }
            await openRoute(page, "/settings/connections");
            await page.waitForSelector('[data-testid="settings-connections-page"]');
          }
        : undefined,
      functionalChecks: async (page) => {
        const refresh = await verifySettingsRefresh(page, pageConfig.navTestId);
        const tabs = pageConfig.page === "settings-general"
          ? await verifySettingsTabs(page)
          : null;
        return {
          passes: true,
          refresh,
          tabs,
        };
      },
    })),
    {
      page: "tasks",
      route: "/tasks",
      state: "actual",
      pageTestId: "tasks-page",
      screenshotName: "tasks",
      waitForSelectors: ['[data-testid="tasks-page"]', '[data-testid="tasks-operator-summary"]', '[data-testid="task-detail-pane"]'],
      checklist: {
        pageTestId: "tasks-page",
        requireDescription: false,
        titleSelectors: ['[data-testid="tasks-operator-summary"] h2'],
        primaryActionSelectors: [],
        keySelectors: viewport.width >= 1100
          ? ['[data-testid="task-detail-pane"]', '[data-testid="task-timeline-scroll"]', '[data-testid="tasks-explorer-scroll"]']
          : ['[data-testid="task-detail-pane"]', '[data-testid="task-timeline-scroll"]', '[data-testid="tasks-operator-summary"]'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      afterOpen: async (page) => {
        await ensureTaskSelected(page, viewport);
        await ensureContextClosed(page);
      },
      extraChecks: async (page) => {
        const extras = {
          timeline: await verifyTimelineScroll(page),
          sanitized: await verifyTimelineSanitized(page),
          emptyCopy: await verifyTimelineEmptyCopyReadable(page),
          inspector: await verifyInspectorScroll(page),
          acceptance: await verifyAcceptanceInspector(page),
          explorer: null,
          shortViewport: null,
        };
        if (viewport.width >= 1100) {
          extras.explorer = await verifyExplorerScroll(page);
        }
        if (viewport.name === "desktop_short") {
          extras.shortViewport = await verifyTaskShortViewportLayout(page);
        }
        return extras;
      },
    },
  ];
}

function buildDynamicScenarios() {
  const dashboardViewports = ["mobile", "desktop", "wide"];
  const queueViewports = ["desktop", "desktop_short", "wide"];
  const settingsViewports = ["desktop", "desktop_short", "wide"];
  const taskFocusedViewports = ["desktop", "desktop_short"];
  const dashboardScenarios = ["quiet", "attention_non_empty", "running_recent_mixed"].map((state) => {
    const tasks = buildDashboardTasks(state);
    const fixtures = buildTaskThreadFixtures(tasks);
    return {
      page: "dashboard",
      route: "/dashboard",
      state,
      pageTestId: "dashboard-page",
      screenshotName: `dashboard--${state.replaceAll("_", "-")}`,
      fixtures,
      viewports: dashboardViewports,
      scrollAnchors: ["top"],
      waitForSelectors: ['[data-testid="dashboard-page"]'],
      checklist: {
        pageTestId: "dashboard-page",
        primaryActionSelectors: ['[data-testid="dashboard-open-tasks"]'],
        keySelectors: ['[data-testid="dashboard-page"] h1'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page) => {
        if (state === "quiet") {
          const emptyState = await verifyEmptyStateCopy(page, "Nothing urgent right now");
          return { passes: true, emptyState };
        }

        const preferredTask = state === "attention_non_empty" ? tasks[0] : tasks.find((task) => task.lifecycleStatus === "RUNNING") ?? tasks[0];
        const selector = state === "attention_non_empty"
          ? '[data-testid="dashboard-attention-thread-open-0"]'
          : '[data-testid="dashboard-live-thread-open-0"]';

        return {
          passes: true,
          threadNavigation: await verifyThreadNavigation(page, selector, preferredTask.taskId, preferredTask.title),
        };
      },
    };
  });

  const queueScenarios = ["clean_empty", "waiting_non_empty", "recovery_non_empty", "backlog_non_empty"].map((state) => {
    const tasks = buildQueueTasks(state);
    const fixtures = buildTaskThreadFixtures(tasks);
    return {
      page: "queue",
      route: "/queue",
      state,
      pageTestId: "queue-page",
      screenshotName: `queue--${state.replaceAll("_", "-")}`,
      fixtures,
      viewports: queueViewports,
      scrollAnchors: ["top"],
      waitForSelectors: ['[data-testid="queue-page"]', '[data-testid="queue-recovery-summary"]'],
      checklist: {
        pageTestId: "queue-page",
        primaryActionSelectors: ['[data-testid="queue-return-tasks"]', '[data-testid="queue-open-state"]'],
        keySelectors: ['[data-testid="queue-page"] h1'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page) => {
        if (state === "clean_empty") {
          const emptyState = await verifyEmptyStateCopy(page, "No recovery work");
          return { passes: true, emptyState };
        }

        if (state === "recovery_non_empty") {
          return {
            passes: true,
            openState: await verifyNavigationButton(page, '[data-testid="queue-open-state"]', "/settings/state"),
          };
        }

        const preferredTask = tasks[0];
        const selector = state === "waiting_non_empty"
          ? '[data-testid="queue-waiting-thread-open-0"]'
          : '[data-testid="queue-backlog-thread-open-0"]';

        return {
          passes: true,
          threadNavigation: await verifyThreadNavigation(page, selector, preferredTask.taskId, preferredTask.title),
        };
      },
    };
  });

  const settingsScenarios = SETTINGS_PAGES.flatMap((pageConfig) => ([
    {
      page: pageConfig.page,
      route: pageConfig.route,
      state: "healthy",
      pageTestId: "settings-page",
      screenshotName: `${pageConfig.page}--healthy`,
      viewports: settingsViewports,
      scrollAnchors: ["top"],
      registerRoutes: (page) => registerPlatformFixtureRoutes(page, "healthy"),
      waitForSelectors: [`[data-testid="${pageConfig.navTestId}"]`],
      checklist: {
        pageTestId: "settings-page",
        primaryActionSelectors: ['[data-testid="settings-refresh-status"]'],
        keySelectors: ['[data-testid="settings-page"] h1', `[data-testid="${pageConfig.navTestId}"]`],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page, viewport) => {
        const refresh = await verifySettingsRefresh(page, pageConfig.navTestId);
        const tabs = pageConfig.page === "settings-general" ? await verifySettingsTabs(page) : null;
        const interaction = (viewport.name === "desktop" || viewport.name === "desktop_short")
          ? pageConfig.page === "settings-general"
            ? await verifySettingsGeneralForm(page)
            : pageConfig.page === "settings-connections"
              ? await verifySettingsConnectionsForm(page)
              : pageConfig.page === "settings-capabilities"
                ? await verifySettingsCapabilitiesForm(page)
                : pageConfig.page === "settings-skills"
                  ? await verifySettingsSkillsForm(page)
                  : pageConfig.page === "settings-state"
                    ? await verifySettingsStatePanel(page)
                    : pageConfig.page === "settings-improvements"
                      ? await verifySettingsImprovementsPanel(page)
                      : null
          : null;
        return {
          passes: true,
          refresh,
          tabs,
          interaction,
        };
      },
    },
    {
      page: pageConfig.page,
      route: pageConfig.route,
      state: "warning_present",
      pageTestId: "settings-page",
      screenshotName: `${pageConfig.page}--warning-present`,
      viewports: settingsViewports,
      scrollAnchors: ["top"],
      registerRoutes: (page) => registerPlatformFixtureRoutes(page, "warning_present"),
      waitForSelectors: [`[data-testid="${pageConfig.navTestId}"]`],
      checklist: {
        pageTestId: "settings-page",
        primaryActionSelectors: ['[data-testid="settings-refresh-status"]'],
        keySelectors: ['[data-testid="settings-page"] h1', `[data-testid="${pageConfig.navTestId}"]`],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      functionalChecks: async (page) => {
        const refresh = await verifySettingsRefresh(page, pageConfig.navTestId);
        const tabs = pageConfig.page === "settings-general" ? await verifySettingsTabs(page) : null;
        return {
          passes: true,
          refresh,
          tabs,
        };
      },
    },
  ]));

  const delegatedChildUpdatedAt = Date.now() - 60_000;
  const tasksScenarios = [
    {
      page: "tasks",
      route: "/tasks?task=task-delegation-parent",
      state: "delegation_active",
      pageTestId: "tasks-page",
      screenshotName: "tasks--delegation-active",
      fixtures: buildTaskThreadFixtures([
        createTaskSummary({
          taskId: "task-delegation-parent",
          title: "Parent delivery with delegated child",
          intent: "Delegate one bounded note draft and wait for it to return.",
          lifecycleStatus: "RUNNING",
          minutesAgo: 1,
          primaryAction: {
            kind: "wait",
            label: "Wait",
            description: 'SubSccAgent is still working on "Delegated note draft" within the parent thread boundary.',
            destinationDir: null,
          },
          nextActionSummary: {
            label: "Wait",
            reason: 'SubSccAgent is still working on "Delegated note draft" within the parent thread boundary.',
          },
          delegationSummary: {
            depth: 0,
            delegationEnabled: true,
            canDelegate: false,
            reason: "An active delegated child task is already running for this thread.",
            activeChildTask: {
              taskId: "task-delegation-child",
              title: "Delegated note draft",
              lifecycleStatus: "RUNNING",
              summary: "SubSccAgent is returning the scoped result.",
              updatedAt: delegatedChildUpdatedAt,
              goal: "Draft a short scoped note only.",
            },
            recentChildren: [],
          },
          visibleToolActivities: [{
            activityId: "task-delegation-parent-delegate",
            toolId: "delegate_subtask",
            status: "SUCCEEDED",
            summary: "Delegated a bounded child task.",
            detail: "The parent thread is waiting for the child to finish and return its scoped result.",
            argumentsSummary: "Delegated note draft",
            resultSummary: "Child task is running.",
            evidencePaths: [],
            approvalStatus: null,
            startedAt: delegatedChildUpdatedAt - 2_000,
            endedAt: delegatedChildUpdatedAt - 1_500,
            unitId: "AGENT-001",
          }],
        }),
      ]),
      viewports: taskFocusedViewports,
      scrollAnchors: ["top"],
      waitForSelectors: ['[data-testid="tasks-page"]', '[data-testid="task-detail-pane"]', '[data-testid="task-delegation-card"]'],
      checklist: {
        pageTestId: "tasks-page",
        requireDescription: false,
        titleSelectors: ['[data-testid="tasks-operator-summary"] h2'],
        primaryActionSelectors: ['[data-testid="task-context-toggle"]'],
        keySelectors: ['[data-testid="task-detail-pane"]', '[data-testid="task-timeline-scroll"]'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      extraChecks: async (page) => ({
        delegation: await verifyDelegationCard(page, "Delegated note draft"),
      }),
    },
    {
      page: "tasks",
      route: "/tasks?task=task-composer-anchor",
      state: "composer_anchor",
      pageTestId: "tasks-page",
      screenshotName: "tasks--composer-anchor",
      fixtures: buildTaskThreadFixtures([
        createTaskSummary({
          taskId: "task-composer-anchor",
          title: "Operator guidance refresh anchor",
          intent: "Keep the operator guidance textarea stable while refreshes and details toggles happen.",
          lifecycleStatus: "RUNNING",
          minutesAgo: 1,
          primaryAction: {
            kind: "continue_thread",
            label: "Continue current thread",
            description: "Send the next message to keep this thread moving.",
            destinationDir: null,
          },
          nextActionSummary: {
            label: "Continue current thread",
            reason: "Send the next message to keep this thread moving.",
          },
          visibleToolActivities: [{
            activityId: "task-composer-anchor-read-file",
            toolId: "read_file",
            status: "FAILED",
            summary: "read file failed.",
            detail: "read file failed.",
            argumentsSummary: "store/db.js",
            resultSummary: "FAILED read file",
            evidencePaths: [],
            approvalStatus: null,
            startedAt: Date.now() - 90_000,
            endedAt: Date.now() - 88_000,
            unitId: "AGENT-001",
            execution: null,
          }, {
            activityId: "task-composer-anchor-run-command",
            toolId: "run_command",
            status: "FAILED",
            summary: "command failed with exit code 1.",
            detail: "Command failed with exit code 1: boom",
            argumentsSummary: "npm.cmd test",
            resultSummary: "exit 1: boom",
            evidencePaths: [],
            approvalStatus: null,
            startedAt: Date.now() - 87_000,
            endedAt: Date.now() - 86_880,
            unitId: "AGENT-001",
            execution: {
              command: "npm.cmd test",
              effectiveCommand: "npm.cmd test",
              cwd: "D:\\workspace",
              exitCode: 1,
              stdout: "running tests",
              stderr: "boom",
              durationMs: 120,
              timedOut: false,
              shell: "powershell",
            },
          }],
        }),
      ]),
      viewports: taskFocusedViewports,
      scrollAnchors: ["top"],
      waitForSelectors: ['[data-testid="tasks-page"]', '[data-testid="task-detail-pane"]', '[data-testid="task-composer-card"]', '[data-testid="task-tool-activity"]'],
      checklist: {
        pageTestId: "tasks-page",
        requireDescription: false,
        titleSelectors: ['[data-testid="tasks-operator-summary"] h2'],
        primaryActionSelectors: ['[data-testid="task-action-continue"]', '[data-testid="task-context-toggle"]'],
        keySelectors: ['[data-testid="task-detail-pane"]', '[data-testid="task-timeline-scroll"]', '[data-testid="task-composer-card"]'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      extraChecks: async (page) => ({
        toolIcons: await verifyToolActivityIcons(page),
        toolExecution: await verifyToolExecutionDetails(page),
        composerAnchor: await verifyComposerRefreshAnchor(page),
      }),
    },
    {
      page: "tasks",
      route: "/tasks?task=task-delete-ready",
      state: "delete-dialog",
      pageTestId: "tasks-page",
      screenshotName: "tasks--delete-dialog",
      fixtures: buildTaskThreadFixtures([
        createTaskSummary({
          taskId: "task-delete-ready",
          title: "Completed delivery ready for deletion",
          intent: "Keep a completed fixture thread around so overlay safety checks can validate the delete confirmation flow.",
          lifecycleStatus: "COMPLETED",
          minutesAgo: 2,
          primaryAction: {
            kind: "continue_thread",
            label: "Continue current thread",
            description: "Keep working from the completed result in this same thread.",
            destinationDir: null,
          },
          nextActionSummary: {
            label: "Continue current thread",
            reason: "The delivered result remains available for follow-up work in this same thread.",
          },
          completionSummary: {
            summary: "Fixture artifact delivered cleanly.",
            details: "This completed thread exists so the delete confirmation dialog can be checked without touching live data.",
            issues: [],
            artifactPaths: ["reports/fixture-delete-dialog.md"],
            artifactDestinationPaths: ["backend/docs/fixture-delete-dialog.md"],
            artifactDestinationDir: "backend/docs",
            artifactApplyStatus: "applied",
            continueAllowed: true,
          },
          latestVisibleOutput: {
            summary: "Fixture artifact delivered cleanly.",
            details: "This completed thread exists so the delete confirmation dialog can be checked without touching live data.",
            issues: [],
            artifactPaths: ["reports/fixture-delete-dialog.md"],
            artifactDestinationPaths: ["backend/docs/fixture-delete-dialog.md"],
            artifactDestinationDir: "backend/docs",
            artifactApplyStatus: "applied",
          },
        }),
      ]),
      viewports: ["desktop", "wide"],
      scrollAnchors: ["top"],
      waitForSelectors: ['[data-testid="tasks-page"]', '[data-testid="task-detail-pane"]', '[data-testid="task-action-delete"]'],
      checklist: {
        pageTestId: "tasks-page",
        requireDescription: false,
        titleSelectors: ['[data-testid="tasks-operator-summary"] h2'],
        primaryActionSelectors: ['[data-testid="task-action-continue"]', '[data-testid="task-action-delete"]'],
        keySelectors: ['[data-testid="task-detail-pane"]', '[data-testid="task-result-card"]'],
        hiddenTextSnippets: HIDDEN_TEXT_SNIPPETS,
      },
      extraChecks: async (page) => ({
        deleteDialog: await verifyTaskDeleteDialog(page),
      }),
    },
  ];

  return [...dashboardScenarios, ...queueScenarios, ...settingsScenarios, ...tasksScenarios];
}

async function runViewport(browser, viewport) {
  const actualRuns = [];
  const dynamicRuns = [];
  const screenshotEntries = [];
  const consoleMessages = [];

  for (const scenario of buildActualScenarios(viewport)) {
    const run = await captureScenario(browser, viewport, scenario);
    actualRuns.push(run.result);
    screenshotEntries.push(...run.entries);
    consoleMessages.push(...run.consoleMessages);
  }

  for (const scenario of buildDynamicScenarios()) {
    if (!scenarioMatchesViewport(scenario, viewport)) {
      continue;
    }
    const run = await captureScenario(browser, viewport, scenario);
    dynamicRuns.push(run.result);
    screenshotEntries.push(...run.entries);
    consoleMessages.push(...run.consoleMessages);
  }

  return { viewport, actualRuns, dynamicRuns, screenshotEntries, consoleMessages };
}

async function closeBrowserSafely(browser) {
  await Promise.race([
    browser.close(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function main() {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable was not found. Set CHROME_EXECUTABLE to run frontend smoke validation.");
  }

  const browser = await chromium.launch({ headless: true, executablePath });
  let exitCode = 0;

  try {
    await seedSmokeTask();
    const runs = [];
    for (const viewport of VIEWPORTS) {
      runs.push(await runViewport(browser, viewport));
    }

    const consoleFailures = runs
      .flatMap((run) => run.consoleMessages)
      .filter((message) => {
        const normalized = message.text.toLowerCase();
        return !normalized.includes("download the react devtools")
          && !normalized.includes("language detector")
          && !normalized.includes("translate.google.com");
      });

    const screenshotMatrix = runs.flatMap((run) => run.screenshotEntries);
    const visualFailures = screenshotMatrix.filter((entry) => !entry.visualReviewChecklist?.passes);
    const functionalFailures = screenshotMatrix.filter((entry) => entry.functionalChecks?.passes === false);

    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      executablePath,
      passes: consoleFailures.length === 0 && visualFailures.length === 0 && functionalFailures.length === 0,
      runs,
      screenshotMatrix,
      consoleFailures,
      visualFailures,
      functionalFailures,
    };

    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      generatedAt: report.generatedAt,
      baseUrl: report.baseUrl,
      passes: report.passes,
      reportPath: REPORT_PATH,
      viewportCount: runs.length,
      screenshotCount: screenshotMatrix.length,
      consoleFailureCount: consoleFailures.length,
      visualFailureCount: visualFailures.length,
      functionalFailureCount: functionalFailures.length,
    }, null, 2));

    if (consoleFailures.length > 0 || visualFailures.length > 0 || functionalFailures.length > 0) {
      exitCode = 1;
    }
  } catch (error) {
    console.error(error.stack ?? error.message);
    exitCode = 1;
  } finally {
    await closeBrowserSafely(browser);
  }
  process.exit(exitCode);
}

main();
