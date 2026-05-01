import {
  getScenarioQualityGateId,
  getScenarioIdsForPack,
  getDatabasePrototypePathsMentionedInText,
  runScenarioPackArtifactAudit,
  scenarioBelongsToAnyPack,
  scenarioBelongsToPack,
} from './real-task-scenario-packs.mjs';
import { createRealTaskContinuePolicy } from './real-task-continue-policy.mjs';
import { auditDatabaseScenarioArtifacts } from './real-task-database-artifact-audit.mjs';
import {
  DATABASE_LAB_RULES,
} from './real-task-scenario-packs.mjs';
import {
  evaluateDatabaseBenchmarkSelfCheck,
  extractDatabaseLabBenchRequiredModuleFiles,
  getBlockingDatabasePackageEntryRefs,
  getDatabaseBenchRepairAllowedOptionalPaths,
  buildDatabaseArtifactProgress,
  getDatabaseLabExistingDesignFiles,
  getDatabaseLabNextDesignDocTargets,
  getDatabaseLabNextPrototypeModuleTargets,
  getDatabaseLabNextPrototypeTopLevelTargets,
  getDatabaseLabPackageEntryDiagnostics,
  getDatabaseLabPrototypeCodeDiagnostics,
  getPrioritizedDatabasePrototypeRepairTargets,
  getDatabasePrototypePathFromPackageEntryRef,
  getLatestDatabaseBenchRunFailure,
  getScenarioBenchRequiredModuleFiles,
  hasDatabaseLabArtifactEvidence,
  hasDatabaseLabRequiredWorkspaceShape,
  hasDatabaseLabVerificationEvidence,
  hasObservedDatabaseBenchRunAttempt,
  hasSuccessfulDatabaseBenchRunEvidence,
  mergeDatabaseBenchRequiredModuleFiles,
  summarizeDatabaseArtifactProgress,
} from './real-task-database-evidence.mjs';
import { evaluateDatabaseScenarioQuality } from './real-task-database-quality.mjs';

function getScenarioId(specOrId) {
  return typeof specOrId === 'string' ? specOrId : specOrId?.id;
}

function isDatabaseDesignScenario(specOrId) {
  return scenarioBelongsToPack(getScenarioId(specOrId), 'database-design');
}

function isDatabaseVerifyScenario(specOrId) {
  return scenarioBelongsToPack(getScenarioId(specOrId), 'database-verify');
}

function isDatabaseScenario(specOrId) {
  return scenarioBelongsToAnyPack(getScenarioId(specOrId), ['database-design', 'database-verify']);
}

function countContinueAttemptsByPhase(continueAttempts, phase) {
  if (!Array.isArray(continueAttempts) || typeof phase !== 'string' || phase.trim().length === 0) {
    return 0;
  }
  return continueAttempts.filter((attempt) => attempt?.metadata?.phase === phase).length;
}

export function createScenarioPackContinuePolicy(deps) {
  const policy = createRealTaskContinuePolicy({
    ...deps,
    DATABASE_LAB_ROOT: DATABASE_LAB_RULES.root,
    DATABASE_LAB_DESIGN_DIR: DATABASE_LAB_RULES.designDir,
    DATABASE_LAB_PROTOTYPE_DIR: DATABASE_LAB_RULES.prototypeDir,
    DATABASE_LAB_REQUIRED_DESIGN_FILES: DATABASE_LAB_RULES.requiredDesignFiles,
    DATABASE_LAB_REQUIRED_PROTOTYPE_FILES: DATABASE_LAB_RULES.requiredPrototypeFiles,
    DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES: DATABASE_LAB_RULES.benchRequiredModuleFiles,
    DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES: DATABASE_LAB_RULES.defaultPrototypeSrcFiles,
    DATABASE_LAB_DESIGN_TOPIC_GROUPS: DATABASE_LAB_RULES.designTopicGroups,
    DATABASE_LAB_DESIGN_QUALITY_FILE: DATABASE_LAB_RULES.designQualityFile,
    DATABASE_LAB_VERIFY_QUALITY_FILE: DATABASE_LAB_RULES.verifyQualityFile,
    DATABASE_LAB_BENCH_RESULT_FILE: DATABASE_LAB_RULES.benchResultFile,
    hasDatabaseLabArtifactEvidence,
    hasSuccessfulDatabaseBenchRunEvidence,
    hasDatabaseLabVerificationEvidence,
    hasObservedDatabaseBenchRunAttempt,
    getDatabaseLabNextDesignDocTargets,
    getDatabaseLabNextPrototypeTopLevelTargets,
    getScenarioBenchRequiredModuleFiles,
    getDatabaseLabNextPrototypeModuleTargets,
    getDatabaseLabPackageEntryDiagnostics,
    getLatestDatabaseBenchRunFailure,
    getDatabaseLabPrototypeCodeDiagnostics,
    getDatabaseLabExistingDesignFiles,
    buildDatabaseArtifactProgress,
    getBlockingDatabasePackageEntryRefs,
    getDatabasePrototypePathFromPackageEntryRef,
    getDatabaseBenchRepairAllowedOptionalPaths,
    getDatabasePrototypePathsMentionedInText,
    getPrioritizedDatabasePrototypeRepairTargets,
    hasDatabaseLabRequiredWorkspaceShape,
    isDatabaseDesignScenario,
    isDatabaseVerifyScenario,
    isDatabaseScenario,
  });
  return {
    ...policy,
    buildScenarioPackBenchmarkSelfCheckInstruction: policy.buildDatabaseBenchmarkSelfCheckInstruction,
  };
}

export async function runScenarioPackBoundaryArtifactAudit(spec, context) {
  const packArtifactAudit = await runScenarioPackArtifactAudit(spec.id, context);
  if (packArtifactAudit) {
    return packArtifactAudit;
  }
  return auditDatabaseScenarioArtifacts({
    scenarioId: spec.id,
    ...context,
  });
}

export function evaluateScenarioPackQuality(spec, input) {
  const qualityGateId = input?.qualityGateId ?? getScenarioQualityGateId(spec?.id);
  if (qualityGateId === 'database_near_mysql_design' || qualityGateId === 'database_near_mysql_verify') {
    return evaluateDatabaseScenarioQuality({
      ...input,
      qualityGateId,
    });
  }
  return null;
}

export function scenarioPackHasSufficientEvidence(spec, scenarioState) {
  if (isDatabaseDesignScenario(spec)) {
    return hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
  }
  if (isDatabaseVerifyScenario(spec)) {
    return hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      && hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  if (isDatabaseScenario(spec)) {
    return hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  return null;
}

export function scenarioPackNeedsMoreEvidence(spec, scenarioState) {
  if (isDatabaseDesignScenario(spec)) {
    return !hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      || !hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
  }
  if (isDatabaseVerifyScenario(spec)) {
    return !hasDatabaseLabRequiredWorkspaceShape(scenarioState)
      || !hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  }
  return null;
}

export function scenarioPackAllowsContinueAfterBudget(spec, normalizedInstruction, continueAttempts) {
  if (
    isDatabaseDesignScenario(spec)
    && normalizedInstruction?.metadata?.phase === 'benchmark_self_check'
    && countContinueAttemptsByPhase(continueAttempts, 'benchmark_self_check') < 2
  ) {
    return true;
  }
  return null;
}

export function shouldForceScenarioPackBenchmarkSelfCheck(spec, scenarioState, continueAttempts) {
  if (!isDatabaseDesignScenario(spec)) {
    return false;
  }
  const quality = scenarioState?.debug?.executionSummary?.acceptance?.quality ?? null;
  const failedChecks = Array.isArray(quality?.failedChecks) ? quality.failedChecks : [];
  const requiredNextEvidence = Array.isArray(quality?.requiredNextEvidence) ? quality.requiredNextEvidence : [];
  const benchmarkStale =
    failedChecks.includes('benchmark_self_check_stale')
    || requiredNextEvidence.some((entry) => /rerun .*benchmark|benchmark.*after .*change|dry-run.*after/i.test(String(entry)));
  const benchmarkAttemptCount = countContinueAttemptsByPhase(continueAttempts, 'benchmark_self_check');
  if (benchmarkAttemptCount > 0 && !benchmarkStale) {
    return false;
  }
  if (benchmarkAttemptCount >= 2) {
    return false;
  }
  if (!benchmarkStale && (hasObservedDatabaseBenchRunAttempt(scenarioState) || hasSuccessfulDatabaseBenchRunEvidence(scenarioState))) {
    return false;
  }
  const needsBenchmarkEvidence =
    benchmarkStale
    || failedChecks.includes('missing_benchmark_self_check')
    || requiredNextEvidence.some((entry) => /benchmark|dry-run/i.test(String(entry)));
  if (!needsBenchmarkEvidence) {
    return false;
  }
  const workspaceFiles = Array.isArray(scenarioState?.workspaceRelativeFiles) ? scenarioState.workspaceRelativeFiles : [];
  return hasDatabaseLabRequiredWorkspaceShape(scenarioState)
    && workspaceFiles.some((relativePath) =>
      relativePath.startsWith(`${DATABASE_LAB_RULES.prototypeDir}/src/`) && relativePath.endsWith('.js')
    );
}

export function getScenarioPackClassificationFacts(spec, scenarioState, artifactAudit) {
  if (!isDatabaseScenario(spec)) {
    return {};
  }
  return {
    runtimeVerificationEvidence: hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true }),
    requiresRuntimeVerificationEvidence: isDatabaseVerifyScenario(spec),
    artifactProgressSummary: summarizeDatabaseArtifactProgress(artifactAudit?.notes?.artifactProgress),
  };
}

export function summarizeScenarioPackConfirmedIssues(report) {
  const scenarioById = new Map((report?.scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  const databaseScenarios = [
    ...getScenarioIdsForPack('database-design'),
    ...getScenarioIdsForPack('database-verify'),
  ]
    .map((id) => scenarioById.get(id))
    .filter(Boolean);
  if (!databaseScenarios.some((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')) {
    return [];
  }
  return [{
    issue: 'mysql_like_database_design_incomplete',
    evidence: 'The database design scenarios did not prove a complete design package and benchmark-capable prototype through the default live runtime.',
    scenarios: databaseScenarios
      .filter((scenario) => scenario.classification === 'product_gap' || scenario.classification === 'artifact_failure')
      .map((scenario) => scenario.id),
  }];
}

export function formatScenarioPackArtifactProgress(artifactProgress) {
  return artifactProgress ? summarizeDatabaseArtifactProgress(artifactProgress) : null;
}

export function isScenarioPackBenignDriftInvocation({
  attempt,
  entry,
  requiredWritePathsSatisfied,
  benchmarkSelfCheckRunObserved,
}) {
  if (!attempt?.metadata) {
    return false;
  }
  if (
    benchmarkSelfCheckRunObserved
    && ['read_file', 'list_files', 'search_files'].includes(entry?.toolId)
  ) {
    return true;
  }
  const benchmarkAfterWriteAllowedPhases = new Set([
    'prototype_modules',
    'prototype_contract_repair',
    'bench_scaffold_repair',
    'bench_module_system_repair',
    'bench_runtime_io_repair',
    'bench_api_repair',
    'storage_engine_repair',
  ]);
  if (
    entry?.toolId === 'run_command'
    && requiredWritePathsSatisfied
    && benchmarkAfterWriteAllowedPhases.has(attempt.metadata.phase)
  ) {
    const serializedArgs = JSON.stringify(entry.arguments ?? {});
    if (/\bbench\b|dry-run|--dry-run/i.test(serializedArgs)) {
      return true;
    }
  }
  return attempt.metadata.phase === 'design_docs'
    && entry?.toolId === 'write_file'
    && requiredWritePathsSatisfied
    && entry.arguments?.path === DATABASE_LAB_RULES.designQualityFile;
}

export {
  DATABASE_LAB_RULES,
  evaluateDatabaseBenchmarkSelfCheck,
  extractDatabaseLabBenchRequiredModuleFiles,
  getBlockingDatabasePackageEntryRefs,
  getDatabaseBenchRepairAllowedOptionalPaths,
  buildDatabaseArtifactProgress,
  getDatabaseLabExistingDesignFiles,
  getDatabaseLabNextDesignDocTargets,
  getDatabaseLabNextPrototypeModuleTargets,
  getDatabaseLabNextPrototypeTopLevelTargets,
  getDatabaseLabPackageEntryDiagnostics,
  getDatabaseLabPrototypeCodeDiagnostics,
  getPrioritizedDatabasePrototypeRepairTargets,
  getDatabasePrototypePathFromPackageEntryRef,
  getLatestDatabaseBenchRunFailure,
  getScenarioBenchRequiredModuleFiles,
  hasDatabaseLabArtifactEvidence,
  hasDatabaseLabRequiredWorkspaceShape,
  hasDatabaseLabVerificationEvidence,
  hasObservedDatabaseBenchRunAttempt,
  hasSuccessfulDatabaseBenchRunEvidence,
  mergeDatabaseBenchRequiredModuleFiles,
  summarizeDatabaseArtifactProgress,
};
