import fsSync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { builtinModules as NODE_BUILTIN_MODULES } from 'node:module';
import {
  canonicalizeDatabasePrototypeModulePath,
  getDatabasePrototypePathsMentionedInText,
  DATABASE_LAB_RULES,
} from './real-task-scenario-packs.mjs';

const DATABASE_LAB_DESIGN_DIR = DATABASE_LAB_RULES.designDir;
const DATABASE_LAB_PROTOTYPE_DIR = DATABASE_LAB_RULES.prototypeDir;
const DATABASE_LAB_REQUIRED_DESIGN_FILES = DATABASE_LAB_RULES.requiredDesignFiles;
const DATABASE_LAB_REQUIRED_PROTOTYPE_FILES = DATABASE_LAB_RULES.requiredPrototypeFiles;
const DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES = DATABASE_LAB_RULES.benchRequiredModuleFiles;
const DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES = DATABASE_LAB_RULES.defaultPrototypeSrcFiles;
const DATABASE_LAB_DESIGN_QUALITY_FILE = DATABASE_LAB_RULES.designQualityFile;
const DATABASE_LAB_VERIFY_QUALITY_FILE = DATABASE_LAB_RULES.verifyQualityFile;
const NODE_BUILTIN_MODULE_SET = new Set([
  ...NODE_BUILTIN_MODULES,
  ...NODE_BUILTIN_MODULES
    .filter((moduleName) => typeof moduleName === 'string' && !moduleName.startsWith('node:'))
    .map((moduleName) => `node:${moduleName}`),
]);

function normalizeSlashes(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function getVisibleToolActivities(scenarioState) {
  return Array.isArray(scenarioState?.summary?.visibleToolActivities) ? scenarioState.summary.visibleToolActivities : [];
}

function getScenarioWorkspaceFiles(scenarioState) {
  return Array.isArray(scenarioState?.workspaceRelativeFiles) ? scenarioState.workspaceRelativeFiles : [];
}

function getToolActivitiesMatching(scenarioState, predicate) {
  return getVisibleToolActivities(scenarioState).filter((activity) => {
    try {
      return predicate(activity);
    } catch {
      return false;
    }
  });
}

function getSuccessfulToolActivitiesById(scenarioState, toolId) {
  return getToolActivitiesMatching(
    scenarioState,
    (activity) => activity?.toolId === toolId && activity?.status === 'SUCCEEDED',
  );
}

function getSuccessfulToolInvocationsById(scenarioState, toolId) {
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  const normalizedToolId = String(toolId ?? '').trim().toLowerCase();
  return [...taskInvocations, ...debugInvocations].filter((entry) => (
    entry?.status === 'SUCCEEDED'
    && String(entry?.toolId ?? '').trim().toLowerCase() === normalizedToolId
  ));
}

function getToolInvocationsById(scenarioState, toolId) {
  const taskInvocations = Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : [];
  const debugInvocations = Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : [];
  const normalizedToolId = String(toolId ?? '').trim().toLowerCase();
  return [...taskInvocations, ...debugInvocations].filter(
    (entry) => String(entry?.toolId ?? '').trim().toLowerCase() === normalizedToolId,
  );
}

function getFailedToolActivitiesById(scenarioState, toolId) {
  return getToolActivitiesMatching(
    scenarioState,
    (activity) => activity?.toolId === toolId && activity?.status === 'FAILED',
  );
}

function getScenarioToolInvocation(scenarioState, activityId) {
  const invocations = [
    ...(Array.isArray(scenarioState?.task?.toolInvocations) ? scenarioState.task.toolInvocations : []),
    ...(Array.isArray(scenarioState?.debug?.task?.toolInvocations) ? scenarioState.debug.task.toolInvocations : []),
  ];
  return invocations.find((invocation) => (
    invocation?.invocationId === activityId
    || invocation?.id === activityId
    || invocation?.activityId === activityId
  )) ?? null;
}

function readScenarioWorkspaceText(scenarioState, relativePath) {
  if (!scenarioState?.workspaceDir || typeof relativePath !== 'string') {
    return '';
  }
  const filePath = path.join(scenarioState.workspaceDir, ...relativePath.split('/'));
  try {
    return fsSync.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractFirstBalancedJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const source = text.trim();
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (character === '\\') {
        escapeNext = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function hasDatabaseLabRequiredDesignFiles(scenarioState) {
  const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
  return DATABASE_LAB_REQUIRED_DESIGN_FILES.every((relativePath) => workspaceFiles.includes(relativePath));
}

function hasDatabaseLabRequiredPrototypeFiles(scenarioState) {
  const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
  if (!DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.every((relativePath) => workspaceFiles.includes(relativePath))) {
    return false;
  }
  return workspaceFiles.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
}

function hasDatabaseLabRequiredWorkspaceShape(scenarioState) {
  return hasDatabaseLabRequiredDesignFiles(scenarioState) && hasDatabaseLabRequiredPrototypeFiles(scenarioState);
}

function hasDatabaseLabArtifactEvidence(scenarioState) {
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'write_file' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity.argumentsSummary ?? '',
      activity.resultSummary ?? '',
      activity.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/](design|prototype)[\\/].+\.(md|js|json))/i.test(text);
  });
}

function hasDatabaseLabVerificationEvidence(scenarioState, options = {}) {
  const allowFailed = options.allowFailed === true;
  return getVisibleToolActivities(scenarioState).some((activity) => {
    if (!allowFailed && activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity?.toolId ?? '',
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    if (activity?.toolId === 'read_file' && /database-lab[\\/](design|prototype)[\\/].+\.(md|js|json)/i.test(text)) {
      return true;
    }
    if (
      activity?.toolId === 'run_command'
      && /(database-lab[\\/]prototype|bench\.js|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|synthetic benchmark|throughput|latency)/i.test(text)
    ) {
      return true;
    }
    return false;
  });
}

function hasSuccessfulDatabaseBenchRunEvidence(scenarioState) {
  const activityEvidence = getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'run_command' || activity?.status !== 'SUCCEEDED') {
      return false;
    }
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    if (!/(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text)) {
      return false;
    }
    const invocation = getScenarioToolInvocation(scenarioState, activity?.activityId);
    const stdout = typeof invocation?.result?.stdout === 'string'
      ? invocation.result.stdout
      : (typeof invocation?.metadata?.stdout === 'string'
        ? invocation.metadata.stdout
        : (typeof activity?.resultSummary === 'string'
          ? activity.resultSummary
          : (typeof activity?.detail === 'string' ? activity.detail : '')));
    const stderr = typeof invocation?.result?.stderr === 'string'
      ? invocation.result.stderr
      : (typeof invocation?.metadata?.stderr === 'string'
        ? invocation.metadata.stderr
        : '');
    const exitCode = Number.isFinite(invocation?.result?.exitCode)
      ? invocation.result.exitCode
      : (Number.isFinite(invocation?.metadata?.exitCode) ? invocation.metadata.exitCode : 0);
    const verificationAudit = {
      command: 'run_command',
      args: [activity?.argumentsSummary ?? ''],
      exitCode,
      stdout,
      stderr,
    };
    return evaluateDatabaseBenchmarkSelfCheck(verificationAudit).passed;
  });
  if (activityEvidence) {
    return true;
  }
  return getSuccessfulToolInvocationsById(scenarioState, 'run_command').some((invocation) => {
    const commandText = [
      invocation?.arguments?.command ?? '',
      invocation?.arguments?.cwd ?? '',
      invocation?.arguments?.workingDirectory ?? '',
      invocation?.metadata?.command ?? '',
      invocation?.metadata?.cwd ?? '',
    ].join(' ');
    if (!/(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(commandText)) {
      return false;
    }
    const stdout = typeof invocation?.result?.stdout === 'string'
      ? invocation.result.stdout
      : (typeof invocation?.metadata?.stdout === 'string' ? invocation.metadata.stdout : '');
    const stderr = typeof invocation?.result?.stderr === 'string'
      ? invocation.result.stderr
      : (typeof invocation?.metadata?.stderr === 'string' ? invocation.metadata.stderr : '');
    const exitCode = Number.isFinite(invocation?.result?.exitCode)
      ? invocation.result.exitCode
      : (Number.isFinite(invocation?.metadata?.exitCode) ? invocation.metadata.exitCode : 0);
    return evaluateDatabaseBenchmarkSelfCheck({
      command: 'run_command',
      args: [commandText],
      exitCode,
      stdout,
      stderr,
    }).passed;
  });
}

function hasObservedDatabaseBenchRunAttempt(scenarioState) {
  const activityObserved = getVisibleToolActivities(scenarioState).some((activity) => {
    if (activity?.toolId !== 'run_command') {
      return false;
    }
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
  });
  if (activityObserved) {
    return true;
  }
  return getToolInvocationsById(scenarioState, 'run_command').some((invocation) => {
    const text = [
      invocation?.arguments?.command ?? '',
      invocation?.arguments?.cwd ?? '',
      invocation?.arguments?.workingDirectory ?? '',
      invocation?.metadata?.command ?? '',
      invocation?.metadata?.cwd ?? '',
      invocation?.result?.stdout ?? '',
      invocation?.metadata?.stdout ?? '',
    ].join(' ');
    return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
  });
}

function getLatestDatabaseBenchRunFailure(scenarioState) {
  const activityFailures = getFailedToolActivitiesById(scenarioState, 'run_command').filter((activity) => {
    const text = [
      activity?.argumentsSummary ?? '',
      activity?.resultSummary ?? '',
      activity?.detail ?? '',
      ...(Array.isArray(activity?.evidencePaths) ? activity.evidencePaths : []),
    ].join(' ');
    return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
  });
  const invocationFailures = getToolInvocationsById(scenarioState, 'run_command')
    .filter((invocation) => invocation?.status === 'FAILED')
    .map((invocation) => ({
      ...invocation,
      activityId: invocation?.invocationId ?? invocation?.id ?? invocation?.activityId,
      argumentsSummary: invocation?.arguments?.command ?? invocation?.metadata?.command ?? '',
      resultSummary: [
        invocation?.result?.stdout ?? invocation?.metadata?.stdout ?? '',
        invocation?.result?.stderr ?? invocation?.metadata?.stderr ?? '',
        invocation?.error ?? invocation?.metadata?.error ?? '',
      ].filter(Boolean).join('\n'),
    }))
    .filter((activity) => {
      const text = [
        activity?.argumentsSummary ?? '',
        activity?.resultSummary ?? '',
      ].join(' ');
      return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|synthetic benchmark|throughput|latency)/i.test(text);
    });
  const failures = [...activityFailures, ...invocationFailures];
  return failures.at(-1) ?? null;
}

function extractDatabaseLabBenchRequiredModuleFiles(benchScriptContent) {
  if (typeof benchScriptContent !== 'string' || benchScriptContent.trim().length === 0) {
    return [];
  }
  const dependencies = [];
  const patterns = [
    /require\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
    /from\s+['"`](\.\.?\/[^'"`]+)['"`]/g,
    /import\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(benchScriptContent)) !== null) {
      const specifier = String(match[1] ?? '').trim();
      if (!specifier) {
        continue;
      }
      let normalizedPath = path.posix.normalize(path.posix.join(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts`, specifier.replace(/\\/g, '/')));
      if (!normalizedPath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)) {
        continue;
      }
      if (!path.posix.extname(normalizedPath)) {
        normalizedPath = `${normalizedPath}.js`;
      }
      normalizedPath = canonicalizeDatabasePrototypeModulePath(normalizedPath);
      if (!dependencies.includes(normalizedPath)) {
        dependencies.push(normalizedPath);
      }
    }
  }
  return dependencies;
}

function getDatabaseLabBenchRequiredModuleFilesFromWorkspace(workspaceDir, workspaceRelativeFiles = []) {
  if (!workspaceDir) {
    return [];
  }
  const benchScriptRelativePath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  if (Array.isArray(workspaceRelativeFiles) && !workspaceRelativeFiles.includes(benchScriptRelativePath)) {
    return [];
  }
  const benchScriptPath = path.join(workspaceDir, ...benchScriptRelativePath.split('/'));
  if (!fsSync.existsSync(benchScriptPath)) {
    return [];
  }
  try {
    return extractDatabaseLabBenchRequiredModuleFiles(fsSync.readFileSync(benchScriptPath, 'utf8'));
  } catch {
    return [];
  }
}

function mergeDatabaseBenchRequiredModuleFiles(modulePaths, options = {}) {
  const includeCoreModuleBaseline = options?.includeCoreModuleBaseline === true;
  const merged = [
    ...(includeCoreModuleBaseline ? DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES : []),
    ...(Array.isArray(modulePaths) ? modulePaths : []),
  ]
    .map((relativePath) => canonicalizeDatabasePrototypeModulePath(relativePath))
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
  return Array.from(new Set(merged));
}

function getScenarioBenchRequiredModuleFiles(scenarioState, options = {}) {
  const workspaceRelativeFiles = getScenarioWorkspaceFiles(scenarioState);
  const extracted = getDatabaseLabBenchRequiredModuleFilesFromWorkspace(
    scenarioState?.workspaceDir ?? null,
    workspaceRelativeFiles,
  );
  const merged = mergeDatabaseBenchRequiredModuleFiles(extracted, {
    includeCoreModuleBaseline: options.includeCoreModuleBaseline === true,
  });
  if (merged.length > 0) {
    return merged;
  }
  if (options.fallbackToDefaultWhenEmpty === true) {
    return [...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES];
  }
  return [];
}

function stripQuotedToken(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractNodeEntryPath(command) {
  if (typeof command !== 'string') {
    return null;
  }
  const match = command.match(/^\s*node(?:\.exe)?\s+("[^"]+"|'[^']+'|[^\s]+)/i);
  if (!match) {
    return null;
  }
  const candidate = stripQuotedToken(match[1]);
  if (!candidate || candidate.startsWith('-')) {
    return null;
  }
  return normalizeSlashes(candidate.replace(/^\.\//, ''));
}

function getDatabaseLabPackageEntryDiagnostics(workspaceDir) {
  const prototypeRoot = path.join(workspaceDir, DATABASE_LAB_PROTOTYPE_DIR);
  const packageJsonPath = path.join(prototypeRoot, 'package.json');
  if (!fsSync.existsSync(packageJsonPath)) {
    return {
      packageJsonFound: false,
      invalidPackageJson: false,
      parseError: null,
      checkedEntries: [],
      missingEntryRefs: [],
      missingRequiredEntries: [],
    };
  }

  try {
    const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
    const checkedEntries = [];
    const missingEntryRefs = [];
    const missingRequiredEntries = [];

    const mainTarget = typeof packageJson.main === 'string'
      ? normalizeSlashes(stripQuotedToken(packageJson.main).replace(/^\.\//, ''))
      : null;
    if (mainTarget) {
      const present = fsSync.existsSync(path.join(prototypeRoot, ...mainTarget.split('/')));
      checkedEntries.push({ entry: 'main', target: mainTarget, present });
      if (!present) {
        missingEntryRefs.push(`main:${mainTarget}`);
      }
    }

    for (const scriptName of ['build', 'dry-run', 'bench']) {
      const scriptCommand = packageJson?.scripts?.[scriptName];
      const scriptTarget = extractNodeEntryPath(scriptCommand);
      if (!scriptTarget) {
        continue;
      }
      const present = fsSync.existsSync(path.join(prototypeRoot, ...scriptTarget.split('/')));
      checkedEntries.push({ entry: `scripts.${scriptName}`, target: scriptTarget, present });
      if (!present) {
        missingEntryRefs.push(`scripts.${scriptName}:${scriptTarget}`);
      }
    }

    if (typeof packageJson?.scripts?.bench !== 'string' && typeof packageJson?.scripts?.['dry-run'] !== 'string') {
      missingRequiredEntries.push('scripts.bench_or_dry-run');
    }

    return {
      packageJsonFound: true,
      invalidPackageJson: false,
      parseError: null,
      checkedEntries,
      missingEntryRefs,
      missingRequiredEntries,
    };
  } catch (error) {
    return {
      packageJsonFound: true,
      invalidPackageJson: true,
      parseError: error instanceof Error ? error.message : String(error),
      checkedEntries: [],
      missingEntryRefs: [],
      missingRequiredEntries: [],
    };
  }
}

function getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, options = {}) {
  const missingEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
    ? packageEntryDiagnostics.missingEntryRefs
    : [];
  const plannedPrototypeEntryPaths = new Set([
    ...DATABASE_LAB_REQUIRED_PROTOTYPE_FILES,
    ...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES,
    ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
  ]);
  return missingEntryRefs.filter((entryRef) => {
    const relativePath = getDatabasePrototypePathFromPackageEntryRef(entryRef);
    if (!relativePath) {
      return true;
    }
    if (plannedPrototypeEntryPaths.has(relativePath)) {
      return false;
    }
    return true;
  });
}

function getDatabasePrototypePathFromPackageEntryRef(entryRef) {
  if (typeof entryRef !== 'string' || !entryRef.includes(':')) {
    return null;
  }
  const [, rawTarget] = entryRef.split(/:(.+)/);
  const normalizedTarget = typeof rawTarget === 'string'
    ? normalizeSlashes(stripQuotedToken(rawTarget).replace(/^\.\//, ''))
    : '';
  if (!normalizedTarget) {
    return null;
  }
  return `${DATABASE_LAB_PROTOTYPE_DIR}/${normalizedTarget}`;
}

function getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, options = {}) {
  const targetPathSet = new Set(Array.isArray(repairTargets) ? repairTargets.filter(Boolean) : []);
  const packageEntryDiagnostics = options?.packageEntryDiagnostics ?? null;
  const companionPrototypePaths = Array.isArray(options?.companionPrototypePaths)
    ? options.companionPrototypePaths.filter((relativePath) =>
      typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)
    )
    : [];
  const benchmarkCompanionPaths = options?.includeBenchmarkCompanions === true
    ? [
      `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
      `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
      ...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES,
      ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
      ...companionPrototypePaths,
    ]
    : companionPrototypePaths;
  const blockingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
    scenarioId: typeof options?.scenarioId === 'string' ? options.scenarioId : '',
  });
  const optionalEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
    ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingEntryRefs.includes(entryRef))
    : (Array.isArray(options?.artifactProgress?.packageEntryRefs?.missingOptional)
      ? options.artifactProgress.packageEntryRefs.missingOptional
      : []);
  const optionalEntryPaths = optionalEntryRefs
    .map((entryRef) => getDatabasePrototypePathFromPackageEntryRef(entryRef))
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`));
  const optionalPaths = [
    repairTargets?.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
      ? DATABASE_LAB_DESIGN_QUALITY_FILE
      : null,
    `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`,
    ...optionalEntryPaths,
    ...benchmarkCompanionPaths,
  ]
    .filter((relativePath) => typeof relativePath === 'string' && relativePath.length > 0)
    .filter((relativePath) => !targetPathSet.has(relativePath));
  return Array.from(new Set(optionalPaths));
}

function getDatabaseLabPrototypeCodeDiagnostics(scenarioState) {
  const packageJsonPath = `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`;
  const storageEnginePath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`;
  const bufferPoolPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`;
  const bPlusTreeIndexPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`;
  const walManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`;
  const transactionManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`;
  const queryExecutorPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`;
  const benchScriptPath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  const packageJsonContent = readScenarioWorkspaceText(scenarioState, packageJsonPath);
  const storageEngineContent = readScenarioWorkspaceText(scenarioState, storageEnginePath);
  const bufferPoolContent = readScenarioWorkspaceText(scenarioState, bufferPoolPath);
  const bPlusTreeIndexContent = readScenarioWorkspaceText(scenarioState, bPlusTreeIndexPath);
  const walManagerContent = readScenarioWorkspaceText(scenarioState, walManagerPath);
  const transactionManagerContent = readScenarioWorkspaceText(scenarioState, transactionManagerPath);
  const queryExecutorContent = readScenarioWorkspaceText(scenarioState, queryExecutorPath);
  const benchScriptContent = readScenarioWorkspaceText(scenarioState, benchScriptPath);
  const failedChecks = [];
  const requiredNextEvidence = [];
  const workspacePrototypeModulePaths = getScenarioWorkspaceFiles(scenarioState)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`) && relativePath.endsWith('.js'))
    .sort((left, right) => left.localeCompare(right));
  const extractDeclaredMethods = (sourceText) => {
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g));
    return new Set(
      matches
        .map((match) => match[1])
        .filter((name) => !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name))
    );
  };
  const splitTopLevelArguments = (argumentText) => {
    if (typeof argumentText !== 'string' || argumentText.trim().length === 0) {
      return [];
    }
    const args = [];
    let current = '';
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (const char of argumentText) {
      if (quote) {
        current += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === '\'' || char === '`') {
        quote = char;
        current += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        current += char;
        continue;
      }
      if (char === ')' || char === ']' || char === '}') {
        depth = Math.max(0, depth - 1);
        current += char;
        continue;
      }
      if (char === ',' && depth === 0) {
        if (current.trim()) {
          args.push(current.trim());
        }
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) {
      args.push(current.trim());
    }
    return args;
  };
  const readBalancedCallArguments = (sourceText, openParenIndex) => {
    let depth = 1;
    let quote = null;
    let escaped = false;
    let text = '';
    for (let index = openParenIndex + 1; index < sourceText.length; index += 1) {
      const char = sourceText[index];
      if (quote) {
        text += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === '\'' || char === '`') {
        quote = char;
        text += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        text += char;
        continue;
      }
      if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          return text;
        }
        text += char;
        continue;
      }
      text += char;
    }
    return null;
  };
  const extractDeclaredMethodRequiredArgCounts = (sourceText) => {
    const counts = new Map();
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g));
    for (const match of matches) {
      const methodName = match[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(methodName)) {
        continue;
      }
      const requiredCount = splitTopLevelArguments(match[2] ?? '')
        .filter((argument) => argument && !argument.startsWith('...') && !argument.includes('='))
        .length;
      counts.set(methodName, requiredCount);
    }
    return counts;
  };
  const extractDeclaredMethodParamNames = (sourceText) => {
    const paramsByMethod = new Map();
    const matches = Array.from(sourceText.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g));
    for (const match of matches) {
      const methodName = match[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(methodName)) {
        continue;
      }
      const params = splitTopLevelArguments(match[2] ?? '')
        .map((argument) => argument.replace(/\s*=.*$/s, '').replace(/^\.{3}/, '').trim())
        .map((argument) => argument.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? '')
        .filter(Boolean);
      paramsByMethod.set(methodName, params);
    }
    return paramsByMethod;
  };
  const extractNumericConstNames = (sourceText) => new Set(
    Array.from((sourceText ?? '').matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*-?\d+(?:\.\d+)?\s*;?/g))
      .map((match) => match[1]),
  );
  const storageFirstParamRequiresNamedTable = (paramName) =>
    /^(?:tableName|tableKey|tablePath|tablespace|relationName|relation|table)$/i.test(String(paramName ?? '').trim());
  const argumentLooksLikeNumericTableId = (argumentText, numericConstNames) => {
    const normalized = String(argumentText ?? '').trim().replace(/;$/, '');
    if (!normalized) {
      return false;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
      return true;
    }
    if (numericConstNames.has(normalized)) {
      return true;
    }
    return /\b(?:DEFAULT_TABLE_ID|TABLE_ID|tableId|fileId|pageId|recordId|rowId)\b/.test(normalized);
  };
  const extractObjectMethodCallDetails = (sourceText, objectName) => {
    const escaped = escapeForRegExp(objectName);
    const pattern = new RegExp(`${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    const details = [];
    for (const match of sourceText.matchAll(pattern)) {
      const openParenIndex = (match.index ?? 0) + match[0].length - 1;
      const argumentText = readBalancedCallArguments(sourceText, openParenIndex);
      details.push({
        methodName: match[1],
        args: argumentText === null ? [] : splitTopLevelArguments(argumentText),
      });
    }
    return details;
  };
  const hasNodeBuiltinBinding = (sourceText, bindingName) => {
    const escaped = escapeForRegExp(bindingName);
    return new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*require\\s*\\(\\s*['"\`](?:node:)?${escaped}['"\`]\\s*\\)`, 'm').test(sourceText)
      || new RegExp(`\\bimport\\s+\\*\\s+as\\s+${escaped}\\s+from\\s+['"\`](?:node:)?${escaped}['"\`]`, 'm').test(sourceText)
      || new RegExp(`\\bimport\\s+${escaped}\\s+from\\s+['"\`](?:node:)?${escaped}['"\`]`, 'm').test(sourceText);
  };
  const extractObjectMethodCalls = (sourceText, objectName) => {
    const pattern = new RegExp(`${objectName}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    return Array.from(sourceText.matchAll(pattern)).map((match) => match[1]);
  };
  const extractIndexLikeMethodCalls = (sourceText) => {
    const mapMethodNames = new Set(['clear', 'delete', 'entries', 'forEach', 'get', 'has', 'keys', 'set', 'size', 'values']);
    const calls = [];
    for (const match of (sourceText ?? '').matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const objectName = match[1];
      const methodName = match[2];
      if (!/index/i.test(objectName)) {
        continue;
      }
      if (/^(?:indexes|indices|indexMap|indexRegistry)$/i.test(objectName) && mapMethodNames.has(methodName)) {
        continue;
      }
      calls.push(methodName);
    }
    return calls;
  };
  const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extractMemberMethodCalls = (sourceText, objectExpression) => {
    const escaped = escapeForRegExp(objectExpression);
    const pattern = new RegExp(`${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
    return Array.from(sourceText.matchAll(pattern)).map((match) => match[1]);
  };
  const sliceClassSource = (sourceText, className) => {
    if (typeof sourceText !== 'string' || typeof className !== 'string' || className.trim().length === 0) {
      return sourceText;
    }
    const classMatch = new RegExp(`\\bclass\\s+${escapeForRegExp(className)}\\b`).exec(sourceText);
    if (!classMatch) {
      return sourceText;
    }
    const rest = sourceText.slice(classMatch.index);
    const nextClassMatch = /\n\s*class\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.exec(rest.slice(classMatch[0].length));
    if (!nextClassMatch) {
      return rest;
    }
    return rest.slice(0, classMatch[0].length + nextClassMatch.index);
  };
  const extractConstructorParamText = (sourceText, className = null) => {
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const match = sourceScope.match(/constructor\s*\(([^)]*)\)/m);
    return match?.[1]?.trim() ?? '';
  };
  const extractConstructorOptionKeys = (sourceText, className = null) => {
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const objectMatch = constructorParamText.match(/^\{\s*([^}]*)\}/);
    if (!objectMatch?.[1]) {
      return new Set();
    }
    return new Set(
      objectMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(/\s*=\s*/)[0]?.trim())
        .map((entry) => entry.replace(/^\.{3}/, '').trim())
        .map((entry) => entry.split(/\s*:\s*/)[0]?.trim())
        .filter(Boolean)
    );
  };
  const extractConstructorConsumedOptionKeys = (sourceText, className = null) => {
    const keys = new Set(extractConstructorOptionKeys(sourceText, className));
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    const optionParamName = firstConstructorParam
      .replace(/\s*=.*$/s, '')
      .trim();
    if (!optionParamName || !/^(?:options|opts|config|params)$/i.test(optionParamName)) {
      return keys;
    }
    const escapedOptionParamName = escapeForRegExp(optionParamName);
    for (const match of sourceScope.matchAll(new RegExp(`\\b${escapedOptionParamName}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, 'g'))) {
      if (match[1]) {
        keys.add(match[1]);
      }
    }
    return keys;
  };
  const classConstructorTakesOptionsObject = (sourceText, className = null) => {
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    return /^\{/.test(constructorParamText) || /\b(?:options|opts|config|params)\b/i.test(firstConstructorParam);
  };
  const classConstructorUsesFirstParamAsPathRoot = (sourceText, className = null) => {
    const sourceScope = className ? sliceClassSource(sourceText, className) : sourceText;
    const constructorParamText = extractConstructorParamText(sourceText, className);
    const firstConstructorParam = constructorParamText.split(',')[0]?.trim() ?? '';
    if (!firstConstructorParam || classConstructorTakesOptionsObject(sourceText, className)) {
      return false;
    }
    const escapedParam = firstConstructorParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`path\\.join\\(\\s*${escapedParam}\\s*,`).test(sourceScope)) {
      return true;
    }
    const assignedProperties = Array.from(
      sourceScope.matchAll(new RegExp(`this\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escapedParam}\\b`, 'g')),
    ).map((match) => match[1]);
    return assignedProperties.some((propertyName) => {
      const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`path\\.join\\(\\s*this\\.${escapedProperty}\\b`, 'm').test(sourceScope)
        || new RegExp(`fs\\.(?:mkdirSync|readdirSync|statSync|openSync)\\(\\s*this\\.${escapedProperty}\\b`, 'm').test(sourceScope);
    });
  };
  const benchConstructsWithOptionsObject = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return false;
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`new\\s+${escaped}\\s*\\(\\s*\\{`, 'm').test(sourceText);
  };
  const benchConstructsWithoutArguments = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return false;
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`new\\s+${escaped}\\s*\\(\\s*(?:undefined|null)?\\s*\\)`, 'm').test(sourceText);
  };
  const extractBenchConstructorOptionKeys = (sourceText, constructorName) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return new Set();
    }
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sourceText.match(new RegExp(`new\\s+${escaped}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, 'm'));
    if (!match?.[1]) {
      return new Set();
    }
    return new Set(
      match[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(/\s*:\s*/)[0]?.trim())
        .filter(Boolean)
    );
  };
  const detectModuleExportStyle = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return 'unknown';
    }
    if (/module\.exports\s*=\s*\{[\s\S]*?\}/m.test(sourceText) || /exports\.[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(sourceText)) {
      return 'named';
    }
    if (/module\.exports\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*;?/m.test(sourceText)) {
      return 'default';
    }
    return 'unknown';
  };
  const detectJavaScriptModuleSystem = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return {
        usesCommonJs: false,
        usesEsm: false,
      };
    }
    return {
      usesCommonJs: /\brequire\s*\(|module\.exports\b|\bexports\.[A-Za-z_][A-Za-z0-9_]*\b/.test(sourceText),
      usesEsm: /(?:^|\n)\s*import\s.+from\s+['"`]|(?:^|\n)\s*export\s+(?:default|const|class|function|\{)/m.test(sourceText),
    };
  };
  const extractNamedCommonJsExports = (sourceText) => {
    const exportedNames = new Set();
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return exportedNames;
    }
    for (const match of sourceText.matchAll(/(?:module\.exports|exports)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
      exportedNames.add(match[1]);
    }
    const objectExportMatch = sourceText.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?/m);
    if (objectExportMatch) {
      const entries = objectExportMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      for (const entry of entries) {
        const aliasMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_]*$/);
        if (aliasMatch) {
          exportedNames.add(aliasMatch[1]);
          continue;
        }
        const shorthandMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (shorthandMatch) {
          exportedNames.add(shorthandMatch[1]);
        }
      }
    }
    return exportedNames;
  };
  const extractBenchRequireBindings = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return [];
    }
    const bindings = [];
    const requirePattern = /const\s+(\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
    for (const match of sourceText.matchAll(requirePattern)) {
      const bindingSource = match[1].trim();
      const rawModulePath = match[2].trim();
      const normalizedModulePath = rawModulePath.endsWith('.js')
        ? rawModulePath
        : `${rawModulePath}.js`;
      if (bindingSource.startsWith('{')) {
        const names = bindingSource
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [importedName, localName] = entry.split(/\s*:\s*/);
            return {
              importedName: importedName.trim(),
              localName: (localName ?? importedName).trim(),
            };
          });
        bindings.push({
          source: 'named',
          modulePath: normalizedModulePath,
          names,
        });
        continue;
      }
      bindings.push({
        source: 'default',
        modulePath: normalizedModulePath,
        names: [{ importedName: 'default', localName: bindingSource }],
      });
    }
    return bindings;
  };
  const normalizePackageSpecifierRoot = (specifier) => {
    if (typeof specifier !== 'string') {
      return null;
    }
    const normalized = specifier.trim();
    if (!normalized || normalized.startsWith('.') || normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalized)) {
      return null;
    }
    if (normalized.startsWith('node:')) {
      return normalized;
    }
    if (normalized.startsWith('@')) {
      const [scope, name] = normalized.split('/');
      return scope && name ? `${scope}/${name}` : normalized;
    }
    return normalized.split('/')[0] ?? normalized;
  };
  const extractBareModuleSpecifiers = (sourceText) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return [];
    }
    const specifiers = [];
    const patterns = [
      /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
      /from\s+['"`]([^'"`]+)['"`]/g,
      /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    ];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(sourceText)) !== null) {
        const packageRoot = normalizePackageSpecifierRoot(String(match[1] ?? '').trim());
        if (!packageRoot || NODE_BUILTIN_MODULE_SET.has(packageRoot)) {
          continue;
        }
        specifiers.push(packageRoot);
      }
    }
    return Array.from(new Set(specifiers));
  };
  const toPrototypeRelativePath = (modulePath) => {
    if (typeof modulePath !== 'string' || !modulePath.startsWith('../src/')) {
      return null;
    }
    return `${DATABASE_LAB_PROTOTYPE_DIR}/src/${modulePath.slice('../src/'.length)}`;
  };
  const benchRequireBindings = extractBenchRequireBindings(benchScriptContent);
  const benchImportedModuleFiles = Array.from(new Set(
    benchRequireBindings
      .map((binding) => toPrototypeRelativePath(binding.modulePath))
      .filter(Boolean),
  ));
  const prototypeModulePaths = Array.from(new Set([
    ...DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES,
    ...workspacePrototypeModulePaths,
    ...benchImportedModuleFiles,
  ])).sort((left, right) => left.localeCompare(right));
  const prototypeModuleSources = new Map(
    prototypeModulePaths.map((relativePath) => [relativePath, readScenarioWorkspaceText(scenarioState, relativePath)]),
  );
  const extractBenchObjectBindings = (sourceText, requireBindings) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return new Map();
    }
    const constructorSourceByLocalName = new Map();
    for (const binding of requireBindings) {
      const relativePath = toPrototypeRelativePath(binding.modulePath);
      if (!relativePath) {
        continue;
      }
      for (const name of binding.names) {
        constructorSourceByLocalName.set(name.localName, relativePath);
      }
    }
    const objectBindings = new Map();
    for (const match of sourceText.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const objectName = match[1];
      const constructorName = match[2];
      const relativePath = constructorSourceByLocalName.get(constructorName);
      if (relativePath) {
        objectBindings.set(objectName, { constructorName, relativePath });
      }
    }
    return objectBindings;
  };
  const benchObjectBindings = extractBenchObjectBindings(benchScriptContent, benchRequireBindings);
  const storageBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === storageEnginePath)
    .map(([objectName]) => objectName);
  const bufferPoolBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === bufferPoolPath)
    .map(([objectName]) => objectName);
  const walManagerBenchObjectNames = Array.from(benchObjectBindings.entries())
    .filter(([, binding]) => binding.relativePath === walManagerPath)
    .map(([objectName]) => objectName);
  const registerSyntaxDiagnostic = (sourceText, relativePath) => {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return;
    }
    try {
      new vm.Script(sourceText, { filename: relativePath });
    } catch (error) {
      failedChecks.push(`javascript_syntax_error:${relativePath}`);
      requiredNextEvidence.push(`repair ${relativePath} so it parses as valid CommonJS JavaScript before rerunning the benchmark scaffold`);
    }
  };

  for (const [relativePath, sourceText] of prototypeModuleSources.entries()) {
    registerSyntaxDiagnostic(sourceText, relativePath);
  }
  registerSyntaxDiagnostic(benchScriptContent, benchScriptPath);
  for (const [relativePath, sourceText] of [...prototypeModuleSources.entries(), [benchScriptPath, benchScriptContent]]) {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      continue;
    }
    for (const builtinName of ['path', 'fs', 'os']) {
      const usesBinding = new RegExp(`\\b${builtinName}\\.`, 'm').test(sourceText);
      if (usesBinding && !hasNodeBuiltinBinding(sourceText, builtinName)) {
        failedChecks.push(`undeclared_node_builtin:${relativePath}:${builtinName}`);
        requiredNextEvidence.push(`repair ${relativePath} so it declares ${builtinName} before using ${builtinName}.*; add a CommonJS require such as const ${builtinName} = require('${builtinName}') or remove the ${builtinName}.* usage`);
      }
    }
  }

  let packageJsonType = null;
  let declaredPackageDependencies = new Set();
  if (typeof packageJsonContent === 'string' && packageJsonContent.trim().length > 0) {
    try {
      const packageJson = JSON.parse(packageJsonContent);
      packageJsonType = typeof packageJson?.type === 'string' ? packageJson.type.trim().toLowerCase() : null;
      declaredPackageDependencies = new Set([
        ...Object.keys(packageJson?.dependencies ?? {}),
        ...Object.keys(packageJson?.devDependencies ?? {}),
      ]);
    } catch {
      packageJsonType = null;
      declaredPackageDependencies = new Set();
    }
  }

  const prototypeDependencySources = new Map();
  for (const [relativePath, sourceText] of [...prototypeModuleSources.entries(), [benchScriptPath, benchScriptContent]]) {
    const undeclaredSpecifiers = extractBareModuleSpecifiers(sourceText)
      .filter((specifier) => !declaredPackageDependencies.has(specifier));
    if (undeclaredSpecifiers.length === 0) {
      continue;
    }
    prototypeDependencySources.set(relativePath, undeclaredSpecifiers);
  }
  for (const [relativePath, undeclaredSpecifiers] of prototypeDependencySources.entries()) {
    for (const specifier of undeclaredSpecifiers) {
      failedChecks.push(`prototype_undeclared_external_dependency_source:${relativePath}:${specifier}`);
      requiredNextEvidence.push(
        `repair ${relativePath} and/or ${packageJsonPath} so the prototype no longer requires undeclared external module "${specifier}". Prefer a built-in Node API such as node:crypto when possible, or declare the dependency explicitly in package.json before rerunning the benchmark scaffold`,
      );
    }
  }

  if (packageJsonType) {
    const moduleSystemViolations = [];
    for (const [relativePath, sourceText] of prototypeModuleSources.entries()) {
      const syntax = detectJavaScriptModuleSystem(sourceText);
      if (packageJsonType === 'module' && syntax.usesCommonJs) {
        moduleSystemViolations.push(relativePath);
      }
      if (packageJsonType !== 'module' && syntax.usesEsm) {
        moduleSystemViolations.push(relativePath);
      }
    }
    {
      const syntax = detectJavaScriptModuleSystem(benchScriptContent);
      if (packageJsonType === 'module' && syntax.usesCommonJs) {
        moduleSystemViolations.push(benchScriptPath);
      }
      if (packageJsonType !== 'module' && syntax.usesEsm) {
        moduleSystemViolations.push(benchScriptPath);
      }
    }
    if (moduleSystemViolations.length > 0) {
      failedChecks.push('prototype_module_system_mismatch');
      const uniqueViolations = Array.from(new Set(moduleSystemViolations));
      if (packageJsonType === 'module') {
        requiredNextEvidence.push(`repair ${packageJsonPath} and/or these prototype files so the module system is consistent: ${uniqueViolations.join(', ')}. package.json currently declares type=module, but those files still use CommonJS require/module.exports. Either remove "type": "module" or convert the cited files to real ESM import/export syntax before rerunning the benchmark scaffold`);
      } else {
        requiredNextEvidence.push(`repair ${packageJsonPath} and/or these prototype files so the module system is consistent: ${uniqueViolations.join(', ')}. The current package runtime is CommonJS, but those files use ESM import/export syntax. Either keep CommonJS everywhere or move the package to a coherent ESM contract before rerunning the benchmark scaffold`);
      }
    }
  }

  if (benchScriptContent) {
    for (const binding of benchRequireBindings) {
      const relativePath = toPrototypeRelativePath(binding.modulePath);
      if (!relativePath) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(relativePath);
      if (typeof moduleSource !== 'string' || moduleSource.trim().length === 0) {
        continue;
      }
      const exportStyle = detectModuleExportStyle(moduleSource);
      const exportedNames = extractNamedCommonJsExports(moduleSource);
      if (binding.source === 'named' && exportStyle === 'default') {
        failedChecks.push(`bench_module_export_mismatch:${relativePath}`);
        const namedImports = binding.names.map((entry) => entry.importedName).join(', ');
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so CommonJS import/export shape agrees; bench.js is destructuring { ${namedImports} } from ${binding.modulePath}, but ${relativePath} currently exports a default class via module.exports = ClassName`);
      }
      if (binding.source === 'default' && exportStyle === 'named') {
        failedChecks.push(`bench_module_export_mismatch:${relativePath}`);
        const localName = binding.names[0]?.localName ?? 'Module';
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so CommonJS import/export shape agrees; bench.js is default-importing ${binding.modulePath} as ${localName}, but ${relativePath} currently exports named bindings via module.exports = { ... }`);
      }
      if (binding.source === 'named' && exportStyle === 'named' && exportedNames.size > 0) {
        for (const name of binding.names) {
          if (!exportedNames.has(name.importedName)) {
            failedChecks.push(`bench_module_export_name_mismatch:${relativePath}:${name.importedName}`);
            requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so the named CommonJS export exists; bench.js imports { ${name.importedName} } from ${binding.modulePath}, but ${relativePath} currently exports { ${Array.from(exportedNames).join(', ')} }`);
          }
        }
      }
    }
    const dynamicLoadedBindings = [
      ['storageEngine', storageEnginePath, 'StorageEngine'],
      ['bufferPool', bufferPoolPath, 'BufferPool'],
      ['bPlusTreeIndex', bPlusTreeIndexPath, 'BPlusTreeIndex'],
      ['walManager', walManagerPath, 'WALManager'],
      ['transactionManager', transactionManagerPath, 'TransactionManager'],
    ];
    const usesDynamicModuleRegistry =
      /\bMODULE_DEFS\b/.test(benchScriptContent)
      && /\bloadModules\s*\(/.test(benchScriptContent)
      && /\bloaded\.[A-Za-z_][A-Za-z0-9_]*\b/.test(benchScriptContent);
    if (usesDynamicModuleRegistry) {
      failedChecks.push('bench_dynamic_module_loader_contract_mismatch');
      requiredNextEvidence.push(`repair ${benchScriptPath} so it imports benchmark-critical modules with direct named CommonJS destructuring instead of a dynamic MODULE_DEFS/loadModules registry. Static quality and runtime repair need explicit imports such as const { StorageEngine } = require('../src/storage-engine.js').`);
    }
    for (const [loadedKey, relativePath, expectedExport] of dynamicLoadedBindings) {
      if (
        !new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${escapeForRegExp(expectedExport)}\\b[^}]*\\}\\s*=\\s*loaded\\.${escapeForRegExp(loadedKey)}\\b`).test(benchScriptContent)
        && !new RegExp(`loaded\\.${escapeForRegExp(loadedKey)}\\.${escapeForRegExp(expectedExport)}\\b`).test(benchScriptContent)
      ) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(relativePath);
      const exportedNames = extractNamedCommonJsExports(moduleSource);
      if (exportedNames.size > 0 && !exportedNames.has(expectedExport)) {
        failedChecks.push(`bench_module_export_name_mismatch:${relativePath}:${expectedExport}`);
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${relativePath} so the named CommonJS export exists; bench.js expects ${expectedExport} through loaded.${loadedKey}, but ${relativePath} currently exports { ${Array.from(exportedNames).join(', ')} }`);
      }
    }

    for (const [objectName, binding] of benchObjectBindings.entries()) {
      if (binding.relativePath === storageEnginePath || binding.relativePath === bufferPoolPath) {
        continue;
      }
      const moduleSource = prototypeModuleSources.get(binding.relativePath);
      if (typeof moduleSource !== 'string' || moduleSource.trim().length === 0) {
        continue;
      }
      const declaredMethods = extractDeclaredMethods(moduleSource);
      const calledMethods = Array.from(new Set(extractObjectMethodCalls(benchScriptContent, objectName)));
      const missingMethods = calledMethods.filter((methodName) => !declaredMethods.has(methodName));
      if (missingMethods.length > 0) {
        failedChecks.push(`bench_module_api_mismatch:${binding.relativePath}`);
        requiredNextEvidence.push(`repair ${benchScriptPath} and/or ${binding.relativePath} so ${binding.constructorName} exposes the methods bench.js is calling on ${objectName}: ${missingMethods.join(', ')}`);
      }
    }
  }

  if (storageEngineContent) {
    const hasStringLengthPrefix = /writeUInt16BE\s*\(\s*str\.length\s*,\s*offset\s*\)/i.test(storageEngineContent);
    const writesVariableStringBytes = /buf\.write\s*\(\s*str\s*,\s*offset\s*\+\s*2\s*,\s*['"`]utf8['"`]\s*\)/i.test(storageEngineContent);
    const readsEveryColumnAsDouble = /readDoubleBE\s*\(\s*off\s*\)/i.test(storageEngineContent);
    const fixedEightByteSlots =
      /offset\s*\+=\s*8\b/.test(storageEngineContent)
      && /return\s+4\s*\+\s*columns\.length\s*\*\s*8/i.test(storageEngineContent);
    if (hasStringLengthPrefix && writesVariableStringBytes && readsEveryColumnAsDouble && fixedEightByteSlots) {
      failedChecks.push('storage_engine_row_format_mismatch');
      requiredNextEvidence.push('repair storage-engine row serialization so insertRow, readRow, and scanTable share one explicit row format with consistent length bookkeeping');
    }
    const uint32WritesWithSignedBitwiseCoercion = Array.from(
      storageEngineContent.matchAll(/writeUInt32BE\s*\(\s*([^,\n]+?)\s*,/g),
    )
      .map((match) => match[1]?.trim() ?? '')
      .filter((expression) =>
        /&\s*0x(?:f{8}|F{8})\b/.test(expression)
        && !/>>>\s*0\b/.test(expression)
      );
    if (uint32WritesWithSignedBitwiseCoercion.length > 0) {
      failedChecks.push('storage_engine_uint32_signed_bitwise_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so every Buffer.writeUInt32BE value is constrained to an unsigned 32-bit integer. Current expression(s) can become negative through JavaScript signed bitwise coercion: ${uint32WritesWithSignedBitwiseCoercion.join('; ')}. Use >>> 0 or an explicit unsigned clamp before writeUInt32BE.`);
    }

    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const benchStorageMethodCalls = benchScriptContent
      ? Array.from(new Set(
        storageBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
      ))
      : [];
    const missingBenchStorageMethods = benchStorageMethodCalls
      .filter((methodName) => !declaredStorageMethods.has(methodName));
    for (const methodName of missingBenchStorageMethods) {
      if (!declaredStorageMethods.has(methodName)) {
        failedChecks.push(`storage_engine_missing_method:${methodName}`);
        if (!failedChecks.includes(`bench_storage_engine_missing_method:${methodName}`)) {
          failedChecks.push(`bench_storage_engine_missing_method:${methodName}`);
        }
        requiredNextEvidence.push(`repair database-lab/prototype/src/storage-engine.js and/or database-lab/prototype/scripts/bench.js so StorageEngine.${methodName} matches the benchmark scaffold contract`);
      }
    }
    if (bPlusTreeIndexContent && /\bBPlusTreeIndex\b/.test(storageEngineContent)) {
      const declaredIndexMethods = extractDeclaredMethods(bPlusTreeIndexContent);
      const storageIndexMethodCalls = Array.from(new Set(extractIndexLikeMethodCalls(storageEngineContent)));
      const missingStorageIndexMethods = storageIndexMethodCalls
        .filter((methodName) => !declaredIndexMethods.has(methodName));
      if (missingStorageIndexMethods.length > 0) {
        failedChecks.push('storage_engine_index_contract_mismatch');
        for (const methodName of missingStorageIndexMethods) {
          failedChecks.push(`storage_engine_index_missing_method:${methodName}`);
        }
        requiredNextEvidence.push(`repair ${storageEnginePath} and/or ${bPlusTreeIndexPath} so StorageEngine only calls methods BPlusTreeIndex actually exposes. storage-engine.js currently calls ${missingStorageIndexMethods.join(', ')}, while b-plus-tree-index.js exposes ${Array.from(declaredIndexMethods).join(', ') || 'no class methods'}. Align aliases such as search versus lookup before rerunning the benchmark.`);
      }
    }
    const declaredStorageRequiredArgCounts = extractDeclaredMethodRequiredArgCounts(storageEngineContent);
    const declaredStorageParamNames = extractDeclaredMethodParamNames(storageEngineContent);
    const numericBenchConstNames = extractNumericConstNames(benchScriptContent ?? '');
    for (const objectName of storageBenchObjectNames) {
      for (const call of extractObjectMethodCallDetails(benchScriptContent ?? '', objectName)) {
        const requiredArgCount = declaredStorageRequiredArgCounts.get(call.methodName);
        if (typeof requiredArgCount === 'number' && requiredArgCount > 0 && call.args.length < requiredArgCount) {
          const failedCheck = `bench_storage_engine_arg_mismatch:${call.methodName}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so ${objectName}.${call.methodName} is called with ${requiredArgCount} required argument(s); bench.js currently supplies ${call.args.length}`);
        }
        const paramNames = declaredStorageParamNames.get(call.methodName) ?? [];
        const firstParamName = paramNames[0] ?? '';
        const firstArg = call.args[0] ?? '';
        if (
          storageFirstParamRequiresNamedTable(firstParamName)
          && argumentLooksLikeNumericTableId(firstArg, numericBenchConstNames)
        ) {
          const failedCheck = `bench_storage_engine_table_name_mismatch:${call.methodName}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so ${objectName}.${call.methodName} passes the named table identifier expected by StorageEngine.${call.methodName}(${paramNames.join(', ')}); bench.js currently passes ${firstArg || 'no first argument'}, which resolves to a numeric table id and can produce runtime failures such as "Table 0 not found"`);
        }
      }
    }
    if (benchScriptContent) {
      const benchPassesOptionsObject = benchConstructsWithOptionsObject(benchScriptContent, 'StorageEngine');
      const benchPassesNoArgument = benchConstructsWithoutArguments(benchScriptContent, 'StorageEngine');
      const constructorUsesPathString = classConstructorUsesFirstParamAsPathRoot(storageEngineContent, 'StorageEngine');
      if (benchPassesOptionsObject && constructorUsesPathString) {
        failedChecks.push('storage_engine_constructor_arg_mismatch');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so StorageEngine is constructed consistently; bench.js is passing an options object, but storage-engine.js still treats the constructor argument as a base directory string for path.join(...)`);
      }
      if (benchPassesNoArgument && constructorUsesPathString) {
        failedChecks.push('storage_engine_constructor_data_root_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so StorageEngine is constructed with a real dataRoot path; bench.js is currently calling new StorageEngine() without the base directory string that storage-engine.js passes into path.join(...)`);
      }
      const storageRequiresLoadedTables =
        (/not\s+loaded/i.test(storageEngineContent) && /\b(?:createTable|loadTable)\s*\(/.test(storageEngineContent));
      const benchUsesTablePageIo =
        /\.(?:readPage|writePage)\s*\(\s*(?:['"`][A-Za-z0-9_$-]+['"`]|[A-Z_]*(?:TABLE|TABLE_NAME|TABLE_ID)[A-Z_]*|[A-Za-z_$][A-Za-z0-9_$]*)/i.test(benchScriptContent);
      const benchCreatesOrLoadsTables =
        /\.(?:createTable|loadTable|openTable|ensureTable)\s*\(/i.test(benchScriptContent);
      if (storageRequiresLoadedTables && benchUsesTablePageIo && !benchCreatesOrLoadsTables) {
        failedChecks.push('bench_storage_table_lifecycle_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so the benchmark creates or loads the benchmark table before page I/O. StorageEngine throws "Table ... not loaded" unless createTable/loadTable has populated table metadata, but bench.js currently writes pages without that lifecycle step.`);
      }
    }
    const promiseReturningStorageMethods = ['open', 'initialize', 'close', 'readPage', 'writePage']
      .filter((methodName) =>
        new RegExp(`async\\s+${methodName}\\s*\\(`, 'm').test(storageEngineContent)
        || new RegExp(`${methodName}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?return\\s+new\\s+Promise\\s*\\(`, 'm').test(storageEngineContent)
      );
    for (const objectName of storageBenchObjectNames) {
      for (const methodName of promiseReturningStorageMethods) {
        const methodCalled = new RegExp(`${objectName}\\.${methodName}\\s*\\(`, 'm').test(benchScriptContent);
        const methodAwaited = new RegExp(`await\\s+${objectName}\\.${methodName}\\s*\\(`, 'm').test(benchScriptContent);
        if (methodCalled && !methodAwaited) {
          failedChecks.push(`bench_storage_engine_async_usage_mismatch:${methodName}`);
          requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so ${objectName}.${methodName} is awaited consistently before the benchmark reports success; ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js currently implements ${methodName} as Promise-based I/O`);
        }
      }
      const usesFileDescriptorBackedPages = /this\.fd\b/.test(storageEngineContent)
        && /(?:readPage|writePage)\s*\([^)]*\)\s*\{[\s\S]*?fs\.(?:read|write)\s*\(\s*this\.fd\b/m.test(storageEngineContent);
      const storageInitializeCreatesDataDir =
        /async\s+(?:init|initialize)\s*\([^)]*\)\s*\{[\s\S]*?mkdirSync\s*\([^)]*recursive:\s*true/i.test(storageEngineContent)
        || /async\s+(?:init|initialize)\s*\([^)]*\)\s*\{[\s\S]*?mkdirSync\s*\(/i.test(storageEngineContent);
      const benchCallsReadOrWrite = benchStorageMethodCalls.includes('readPage') || benchStorageMethodCalls.includes('writePage');
      const benchOpensStorage = new RegExp(`await\\s+${objectName}\\.(?:open|init|initialize)\\s*\\(`, 'm').test(benchScriptContent);
      if (storageInitializeCreatesDataDir && benchCallsReadOrWrite && !benchOpensStorage) {
        failedChecks.push('bench_storage_engine_initialize_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it awaits ${objectName}.init() or ${objectName}.initialize() before the first readPage/writePage call, or repair storage-engine.js so writePage ensures its data directory exists before writing; storage-engine.js currently creates its data directory during setup and benchmark I/O must not run against an uninitialized data path`);
      }
      if ((usesFileDescriptorBackedPages || storageInitializeCreatesDataDir) && benchCallsReadOrWrite && !benchOpensStorage) {
        failedChecks.push('bench_storage_engine_open_missing');
        requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it opens or initializes the real StorageEngine before calling readPage/writePage; the current storage engine uses fd-backed I/O and cannot safely benchmark unopened pages`);
      }
      const enforcesExactPageSize = /data\.length\s*!==\s*this\.pageSize/.test(storageEngineContent);
      const writesFixedPageLength =
        /fs\.write(?:Sync)?\s*\(\s*[^,]+,\s*[^,]+,\s*0\s*,\s*this\.pageSize\b/m.test(storageEngineContent);
      const benchWritesBufferFromStrings =
        new RegExp(`${objectName}\\.writePage\\s*\\([^)]*Buffer\\.from\\s*\\(`, 'm').test(benchScriptContent)
        || (/Buffer\.from\s*\(/.test(benchScriptContent) && new RegExp(`${objectName}\\.writePage\\s*\\(`, 'm').test(benchScriptContent) && !/Buffer\.alloc\s*\([^)]*pageSize/i.test(benchScriptContent));
      if ((enforcesExactPageSize || writesFixedPageLength) && benchWritesBufferFromStrings) {
        if (!failedChecks.includes('bench_storage_page_size_mismatch')) {
          failedChecks.push('bench_storage_page_size_mismatch');
        }
        const evidence = `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so benchmark page writes respect the StorageEngine pageSize contract; do not pass short Buffer.from(...) payloads into writePage when storage-engine.js requires fixed-size pages`;
        if (!requiredNextEvidence.includes(evidence)) {
          requiredNextEvidence.push(evidence);
        }
      }
    }
  }

  if (bufferPoolContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const delegatedStorageMethods = Array.from(new Set(extractMemberMethodCalls(bufferPoolContent, 'this.storage')));
    const missingDelegatedMethods = delegatedStorageMethods.filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingDelegatedMethods.length > 0) {
      failedChecks.push('buffer_pool_storage_engine_contract_mismatch');
      for (const methodName of missingDelegatedMethods) {
        failedChecks.push(`buffer_pool_storage_engine_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so BufferPool only calls storage methods the StorageEngine actually implements. buffer-pool.js currently calls ${missingDelegatedMethods.join(', ')}, but storage-engine.js currently exposes ${Array.from(declaredStorageMethods).sort().join(', ') || 'no usable storage methods'}`,
      );
    }
  }

  if (benchScriptContent && !/createEngine|new\s+StorageEngine/i.test(benchScriptContent)) {
    failedChecks.push('bench_scaffold_missing_storage_engine_entrypoint');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so it imports the real storage engine entrypoint instead of placeholder logic');
  }

  if (benchScriptContent && bufferPoolContent) {
    const declaredBufferMethods = extractDeclaredMethods(bufferPoolContent);
    const benchBufferMethodCalls = Array.from(new Set(
      bufferPoolBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    if (benchConstructsWithOptionsObject(benchScriptContent, 'BufferPool') && !classConstructorTakesOptionsObject(bufferPoolContent, 'BufferPool')) {
      failedChecks.push('buffer_pool_constructor_arg_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool is constructed consistently; bench.js is passing an options object, but buffer-pool.js still expects positional arguments like (storageEngine, poolSize)`);
    }
    const bufferPoolRequiresStorageEngineOption =
      /constructor\s*\(\s*(?:options|opts|config)\s*=?\s*[^)]*\)\s*\{[\s\S]{0,700}!(?:options|opts|config)\.storageEngine/i.test(bufferPoolContent)
      || /constructor\s*\(\s*(?:options|opts|config)\s*=?\s*[^)]*\)\s*\{[\s\S]{0,700}(?:options|opts|config)\.storageEngine/i.test(bufferPoolContent);
    if (benchConstructsWithoutArguments(benchScriptContent, 'BufferPool') && bufferPoolRequiresStorageEngineOption) {
      failedChecks.push('buffer_pool_constructor_dependency_missing');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool is constructed with the storage dependency expected by ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js; bench.js currently calls new BufferPool() without options.storageEngine`);
    }
    const bufferPoolHasWritePage = declaredBufferMethods.has('writePage');
    const bufferPoolHasReadPage = declaredBufferMethods.has('readPage');
    const bufferPoolHasPutPage = declaredBufferMethods.has('putPage');
    const bufferPoolHasGetPage = declaredBufferMethods.has('getPage');
    const missingBenchBufferMethods = benchBufferMethodCalls.filter((methodName) => !declaredBufferMethods.has(methodName));
    if (missingBenchBufferMethods.includes('initialize')) {
      failedChecks.push('bench_buffer_pool_missing_initialize');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so bench.js does not call pool.initialize() unless BufferPool actually implements initialize(). Prefer removing the call when BufferPool has no setup phase, or implement an async initialize method that prepares the same storage dependency used by getPage/writePage.`);
    }
    for (const methodName of missingBenchBufferMethods) {
      if (!failedChecks.includes(`bench_buffer_pool_missing_method:${methodName}`)) {
        failedChecks.push(`bench_buffer_pool_missing_method:${methodName}`);
      }
    }
    const genericMismatch = missingBenchBufferMethods.length > 0;
    if (
      genericMismatch
      || ((benchBufferMethodCalls.includes('writePage') && !bufferPoolHasWritePage && bufferPoolHasPutPage)
      || (benchBufferMethodCalls.includes('readPage') && !bufferPoolHasReadPage && bufferPoolHasGetPage))
    ) {
      failedChecks.push('bench_buffer_pool_api_mismatch');
      requiredNextEvidence.push(`repair database-lab/prototype/scripts/bench.js and/or database-lab/prototype/src/buffer-pool.js so they share one coherent API. Bench currently calls buffer-pool methods not implemented by BufferPool: ${missingBenchBufferMethods.join(', ') || 'writePage/readPage vs putPage/getPage drift'}. Remove stale calls such as pool.initialize() or implement those methods before rerunning the benchmark.`);
    }
  }

  if (benchScriptContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const benchStorageMethodCalls = Array.from(new Set(
      storageBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingBenchStorageMethods = benchStorageMethodCalls
      .filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingBenchStorageMethods.length > 0) {
      failedChecks.push('bench_storage_engine_api_mismatch');
      for (const methodName of missingBenchStorageMethods) {
        if (!failedChecks.includes(`bench_storage_engine_missing_method:${methodName}`)) {
          failedChecks.push(`bench_storage_engine_missing_method:${methodName}`);
        }
      }
      requiredNextEvidence.push(`repair database-lab/prototype/scripts/bench.js and/or database-lab/prototype/src/storage-engine.js so these missing benchmark-called engine methods line up: ${missingBenchStorageMethods.join(', ')}. Either implement the methods in StorageEngine or stop bench.js from calling them.`);
    }
  }

  if (benchScriptContent && walManagerContent) {
    const walConstructorUsesPathString = classConstructorUsesFirstParamAsPathRoot(walManagerContent, 'WALManager');
    if (benchConstructsWithOptionsObject(benchScriptContent, 'WALManager') && walConstructorUsesPathString) {
      failedChecks.push('wal_manager_constructor_arg_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so WALManager is constructed consistently; bench.js is passing an options object, but wal-manager.js still treats the constructor argument as a base directory string for path.join(...)`);
    }
    if (
      /(?:\.timestamp\s*=\s*|timestamp\s*:)\s*Date\.now\s*\(/.test(walManagerContent)
      && /\.writeUInt32LE\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?timestamp\b/.test(walManagerContent)
    ) {
      failedChecks.push('wal_timestamp_uint32_overflow_risk');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WAL record timestamps are not written with writeUInt32LE(Date.now()). Date.now() exceeds uint32 range; use BigUInt64LE, a bounded relative timestamp, or omit timestamp from the fixed 32-bit WAL header before rerunning the benchmark.`);
    }
    const declaredWalMethods = extractDeclaredMethods(walManagerContent);
    const benchWalMethodCalls = Array.from(new Set(
      walManagerBenchObjectNames.flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingBenchWalMethods = benchWalMethodCalls.filter((methodName) => !declaredWalMethods.has(methodName));
    if (missingBenchWalMethods.length > 0) {
      failedChecks.push('bench_wal_manager_api_mismatch');
      for (const methodName of missingBenchWalMethods) {
        if (!failedChecks.includes(`bench_wal_manager_missing_method:${methodName}`)) {
          failedChecks.push(`bench_wal_manager_missing_method:${methodName}`);
        }
      }
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WALManager exposes the methods bench.js is calling directly: ${missingBenchWalMethods.join(', ')}. Either implement those methods or change bench.js to use the actual WALManager API before rerunning the benchmark.`);
    }
  }

  if (benchScriptContent && transactionManagerContent) {
    const constructorOptionKeys = extractConstructorConsumedOptionKeys(transactionManagerContent, 'TransactionManager');
    const benchOptionKeys = extractBenchConstructorOptionKeys(benchScriptContent, 'TransactionManager');
    if (constructorOptionKeys.size > 0 && benchOptionKeys.size > 0) {
      const overlappingKeys = Array.from(benchOptionKeys).filter((key) => constructorOptionKeys.has(key));
      if (overlappingKeys.length === 0) {
        failedChecks.push('transaction_manager_constructor_arg_mismatch');
        requiredNextEvidence.push(
          `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager is constructed with the real option keys. bench.js currently passes { ${Array.from(benchOptionKeys).join(', ')} }, but transaction-manager.js expects { ${Array.from(constructorOptionKeys).join(', ')} }.`
        );
      }
      const constructorAliasPairs = [
        ['walManager', ['wal', 'walLog', 'logManager']],
        ['storageEngine', ['storage', 'engine']],
        ['indexManager', ['index', 'bTreeIndex', 'tree']],
        ['lockManager', ['locks']],
      ];
      for (const [expectedKey, aliasKeys] of constructorAliasPairs) {
        const matchingAlias = aliasKeys.find((aliasKey) => benchOptionKeys.has(aliasKey));
        if (constructorOptionKeys.has(expectedKey) && matchingAlias && !benchOptionKeys.has(expectedKey)) {
          const failedCheck = `transaction_manager_constructor_option_alias_mismatch:${expectedKey}:${matchingAlias}`;
          if (!failedChecks.includes(failedCheck)) {
            failedChecks.push(failedCheck);
          }
          if (!failedChecks.includes('transaction_manager_constructor_arg_mismatch')) {
            failedChecks.push('transaction_manager_constructor_arg_mismatch');
          }
          requiredNextEvidence.push(
            `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager receives option key ${expectedKey}; bench.js currently passes alias key ${matchingAlias}, leaving transaction-manager.js with an undefined dependency during begin/commit`,
          );
        }
      }
    }

    const declaredTransactionMethods = extractDeclaredMethods(transactionManagerContent);
    const transactionManagerObjectNames = Array.from(benchObjectBindings.entries())
      .filter(([, binding]) => binding.relativePath === transactionManagerPath)
      .map(([objectName]) => objectName);
    const transactionAliasNames = new Set();
    for (const objectName of transactionManagerObjectNames) {
      const aliasPattern = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?${escapeForRegExp(objectName)}\\.begin\\s*\\(`,
        'g',
      );
      for (const match of benchScriptContent.matchAll(aliasPattern)) {
        if (match[1]) {
          transactionAliasNames.add(match[1]);
        }
      }
    }
    const transactionAliasCalls = Array.from(new Set(
      Array.from(transactionAliasNames).flatMap((objectName) => extractObjectMethodCalls(benchScriptContent, objectName)),
    ));
    const missingTransactionMethods = transactionAliasCalls.filter((methodName) => !declaredTransactionMethods.has(methodName));
    if (missingTransactionMethods.length > 0) {
      failedChecks.push('bench_transaction_api_mismatch');
      for (const methodName of missingTransactionMethods) {
        failedChecks.push(`bench_transaction_missing_method:${methodName}`);
      }
      const aliasList = Array.from(transactionAliasNames);
      const aliasSummary = aliasList.length > 0 ? aliasList.join(', ') : 'transaction instances';
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so the transaction object returned by begin() exposes the methods bench.js is calling on ${aliasSummary}: ${missingTransactionMethods.join(', ')}. If the real transaction API is read/write/delete, then bench.js must stop calling insert/lookup and use the coherent method names instead.`,
      );
    }
    const transactionAliasList = Array.from(transactionAliasNames);
    const declaredTransactionParamNames = extractDeclaredMethodParamNames(transactionManagerContent);
    for (const objectName of transactionManagerObjectNames) {
      for (const call of extractObjectMethodCallDetails(benchScriptContent, objectName)) {
        if (!/^(?:commit|rollback|abort)$/i.test(call.methodName)) {
          continue;
        }
        const paramNames = declaredTransactionParamNames.get(call.methodName) ?? [];
        const firstParam = paramNames[0] ?? '';
        if (!firstParam) {
          continue;
        }
        const methodBodyUsesIdLookup = new RegExp(`${escapeForRegExp(call.methodName)}\\s*\\([^)]*${escapeForRegExp(firstParam)}[^)]*\\)\\s*\\{[\\s\\S]{0,500}\\.(?:get|has|delete)\\s*\\(\\s*${escapeForRegExp(firstParam)}\\s*\\)`, 'm').test(transactionManagerContent);
        const methodExpectsId = /(?:txn|tx|transaction).{0,8}id|id$/i.test(firstParam) || methodBodyUsesIdLookup;
        if (!methodExpectsId) {
          continue;
        }
        if (call.args.length === 0) {
          failedChecks.push('bench_transaction_manager_argument_mismatch');
          failedChecks.push(`bench_transaction_manager_argument_mismatch:${call.methodName}`);
          requiredNextEvidence.push(
            `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so ${objectName}.${call.methodName} receives the value expected by transaction-manager.js. bench.js currently calls ${objectName}.${call.methodName}() without the required id parameter (${firstParam || 'transaction id'}). Capture the transaction returned by begin() and pass txn.id, or change commit/rollback to accept the omitted/default transaction consistently before rerunning the benchmark.`,
          );
          continue;
        }
        const firstArg = String(call.args[0] ?? '').trim();
        if (!transactionAliasList.includes(firstArg)) {
          continue;
        }
        failedChecks.push('bench_transaction_manager_argument_mismatch');
        failedChecks.push(`bench_transaction_manager_argument_mismatch:${call.methodName}`);
        requiredNextEvidence.push(
          `repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so ${objectName}.${call.methodName} receives the value expected by transaction-manager.js. bench.js currently passes transaction object ${firstArg}, but ${call.methodName} appears to expect an id parameter (${firstParam || 'transaction id'}). Pass ${firstArg}.id, change commit/rollback to accept the transaction object, or make begin() return the id consistently before rerunning the benchmark.`,
        );
      }
    }
  }

  if (transactionManagerContent && walManagerContent) {
    const declaredWalMethods = extractDeclaredMethods(walManagerContent);
    const transactionWalCalls = Array.from(new Set([
      ...extractMemberMethodCalls(transactionManagerContent, 'this._wal'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.wal'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.walManager'),
    ]));
    const missingWalMethods = transactionWalCalls.filter((methodName) => !declaredWalMethods.has(methodName));
    if (missingWalMethods.length > 0) {
      failedChecks.push('transaction_manager_wal_contract_mismatch');
      for (const methodName of missingWalMethods) {
        failedChecks.push(`transaction_manager_wal_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so TransactionManager only calls WALManager methods that really exist. transaction-manager.js currently calls ${missingWalMethods.join(', ')}, but wal-manager.js currently exposes ${Array.from(declaredWalMethods).sort().join(', ') || 'no usable wal methods'}`,
      );
    }
  }

  if (transactionManagerContent && storageEngineContent) {
    const declaredStorageMethods = extractDeclaredMethods(storageEngineContent);
    const transactionStorageCalls = Array.from(new Set([
      ...extractMemberMethodCalls(transactionManagerContent, 'this._engine'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.storage'),
      ...extractMemberMethodCalls(transactionManagerContent, 'this.storageEngine'),
    ]));
    const missingStorageMethods = transactionStorageCalls.filter((methodName) => !declaredStorageMethods.has(methodName));
    if (missingStorageMethods.length > 0) {
      failedChecks.push('transaction_manager_storage_contract_mismatch');
      for (const methodName of missingStorageMethods) {
        failedChecks.push(`transaction_manager_storage_missing_method:${methodName}`);
      }
      requiredNextEvidence.push(
        `repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so TransactionManager only calls StorageEngine methods that really exist. transaction-manager.js currently calls ${missingStorageMethods.join(', ')}, but storage-engine.js currently exposes ${Array.from(declaredStorageMethods).sort().join(', ') || 'no usable storage methods'}`,
      );
    }
  }

  if (benchScriptContent && queryExecutorContent) {
    const queryExecutorAssumesDatabaseFacade =
      /this\.database\.getTable\s*\(/.test(queryExecutorContent)
      || /this\.database\.insertRow\s*\(/.test(queryExecutorContent)
      || /this\.database\.beginTransaction\s*\(/.test(queryExecutorContent);
    if (benchConstructsWithOptionsObject(benchScriptContent, 'QueryExecutor') && queryExecutorAssumesDatabaseFacade) {
      failedChecks.push('query_executor_database_contract_mismatch');
      requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js so QueryExecutor receives a real database facade with getTable/insertRow/beginTransaction behavior instead of a loose object literal with partial fields only`);
    }
  }

  if (benchScriptContent && !/(?:console\.log|process\.stdout\.write)\s*\(\s*JSON\.stringify\s*\(/.test(benchScriptContent)) {
    failedChecks.push('bench_output_not_machine_readable');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so npm run bench -- --dry-run prints one machine-readable JSON object with top-level status, summary, and metrics keys instead of prose-only console logs');
  }
  const extraStdoutLogLines = typeof benchScriptContent === 'string'
    ? benchScriptContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /^console\.log\s*\(/.test(line)
        && !/JSON\.stringify\s*\(/.test(line)
      )
    : [];
  if (extraStdoutLogLines.length > 0) {
    failedChecks.push('bench_output_extra_stdout_logs');
    requiredNextEvidence.push(`repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so dry-run stdout contains exactly one JSON.stringify(result) payload and no banner or phase console.log lines before or after it. Remove or redirect these stdout logs: ${extraStdoutLogLines.slice(0, 3).join(' | ')}`);
  }
  if (benchScriptContent && !/\bstatus\s*:\s*['"`]/.test(benchScriptContent) && !/\bstatus\b[\s\S]{0,120}\bsummary\b[\s\S]{0,200}\bmetrics\b/.test(benchScriptContent)) {
    failedChecks.push('bench_output_missing_result_envelope');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so dryRun returns and prints a top-level object with status, summary, and metrics keys instead of emitting raw metrics only');
  }

  return {
    storageEnginePath,
    bufferPoolPath,
    benchScriptPath,
    benchImportedModuleFiles,
    prototypeModulePaths,
    failedChecks,
    requiredNextEvidence,
  };
}


function getDatabaseLabNextPrototypeModuleTargets(scenarioState, limit = 2, preferredModuleFiles = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES) {
  const existing = new Set(
    getScenarioWorkspaceFiles(scenarioState)
      .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
  );
  const prioritizedFiles = Array.isArray(preferredModuleFiles) && preferredModuleFiles.length > 0
    ? preferredModuleFiles
    : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES;
  const missing = prioritizedFiles.filter((relativePath) => !existing.has(relativePath));
  const defaultMissing = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !existing.has(relativePath));
  const targets =
    missing.length > 0
      ? missing
      : defaultMissing.length > 0
        ? defaultMissing
        : prioritizedFiles;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabNextPrototypeTopLevelTargets(scenarioState, limit = 2) {
  const existing = new Set(getScenarioWorkspaceFiles(scenarioState));
  const orderedTargets = [
    `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,
    `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
  ];
  const missing = orderedTargets.filter((relativePath) => !existing.has(relativePath));
  const targets = missing.length > 0 ? missing : orderedTargets;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabNextDesignDocTargets(scenarioState, limit = 2) {
  const existing = new Set(getScenarioWorkspaceFiles(scenarioState));
  const missing = DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => !existing.has(relativePath));
  const targets = missing.length > 0 ? missing : DATABASE_LAB_REQUIRED_DESIGN_FILES;
  return targets.slice(0, Math.max(1, limit));
}

function getDatabaseLabExistingDesignFiles(scenarioState) {
  return getScenarioWorkspaceFiles(scenarioState)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_DESIGN_DIR}/`) && relativePath.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
}


function buildDatabaseArtifactProgress(workspaceRelativeFiles, notes = {}) {
  const workspaceSet = new Set(Array.isArray(workspaceRelativeFiles) ? workspaceRelativeFiles : []);
  const designFilesPresent = DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => workspaceSet.has(relativePath));
  const prototypeTopLevelFilesPresent = DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.filter((relativePath) => workspaceSet.has(relativePath));
  const prototypeSrcFiles = Array.from(workspaceSet)
    .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))
    .sort((left, right) => left.localeCompare(right));
  const benchRequiredModuleFiles = Array.isArray(notes?.benchRequiredModuleFiles)
    ? notes.benchRequiredModuleFiles
    : DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES;
  const missingCoreModules = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !workspaceSet.has(relativePath));
  const missingBenchDependencyModules = benchRequiredModuleFiles.filter((relativePath) => !workspaceSet.has(relativePath));
  const includeVerifyQualityEvidence = notes?.includeVerifyQualityEvidence === true;
  const expectedQualityFiles = [
    DATABASE_LAB_DESIGN_QUALITY_FILE,
    ...(includeVerifyQualityEvidence ? [DATABASE_LAB_VERIFY_QUALITY_FILE] : []),
  ];
  const qualityFilesPresent = expectedQualityFiles.filter((relativePath) => workspaceSet.has(relativePath));
  const verificationAudit = notes?.verificationScriptAudit ?? null;
  const packageEntryDiagnostics = notes?.packageEntryDiagnostics ?? null;
  const derivedBlockingMissingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
    scenarioId: typeof notes?.scenarioId === 'string' ? notes.scenarioId : '',
  });
  const blockingMissingEntryRefs = Array.isArray(notes?.blockingMissingEntryRefs)
    ? notes.blockingMissingEntryRefs
    : derivedBlockingMissingEntryRefs;
  const optionalMissingEntryRefs = Array.isArray(notes?.optionalMissingEntryRefs)
    ? notes.optionalMissingEntryRefs
    : (Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
      ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingMissingEntryRefs.includes(entryRef))
      : []);
  const benchmarkSelfCheck = evaluateDatabaseBenchmarkSelfCheck(verificationAudit);
  const progress = {
    designDocs: {
      completed: designFilesPresent.length === DATABASE_LAB_REQUIRED_DESIGN_FILES.length,
      present: designFilesPresent,
      missing: DATABASE_LAB_REQUIRED_DESIGN_FILES.filter((relativePath) => !workspaceSet.has(relativePath)),
    },
    prototypeTopLevel: {
      completed:
        prototypeTopLevelFilesPresent.length === DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.length
        && (packageEntryDiagnostics?.missingRequiredEntries?.length ?? 0) === 0
        && blockingMissingEntryRefs.length === 0,
      present: prototypeTopLevelFilesPresent,
      missing: [
        ...DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.filter((relativePath) => !workspaceSet.has(relativePath)),
        ...(blockingMissingEntryRefs.length > 0 ? blockingMissingEntryRefs.map((entry) => `package-entry-ref:${entry}`) : []),
        ...((packageEntryDiagnostics?.missingRequiredEntries ?? []).map((entry) => `package-entry:${entry}`)),
      ],
    },
    prototypeModules: {
      completed: missingCoreModules.length === 0 && missingBenchDependencyModules.length === 0,
      count: prototypeSrcFiles.length,
      present: prototypeSrcFiles,
      nextSuggestedTargets: DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.filter((relativePath) => !workspaceSet.has(relativePath)).slice(0, 2),
      missingCoreModules,
      missingBenchDependencyModules,
    },
    benchDependencies: {
      wiredToPrototypeModules: benchRequiredModuleFiles.length > 0,
      required: benchRequiredModuleFiles,
      missing: missingBenchDependencyModules,
    },
    qualityEvidence: {
      present: qualityFilesPresent,
      missing: expectedQualityFiles.filter((relativePath) => !workspaceSet.has(relativePath)),
    },
    benchmarkSelfCheck,
    packageEntryRefs: {
      packageJsonFound: packageEntryDiagnostics?.packageJsonFound === true,
      invalidPackageJson: packageEntryDiagnostics?.invalidPackageJson === true,
      parseError: packageEntryDiagnostics?.parseError ?? null,
      checked: Array.isArray(packageEntryDiagnostics?.checkedEntries) ? packageEntryDiagnostics.checkedEntries : [],
      missing: Array.isArray(packageEntryDiagnostics?.missingEntryRefs) ? packageEntryDiagnostics.missingEntryRefs : [],
      missingBlocking: blockingMissingEntryRefs,
      missingOptional: optionalMissingEntryRefs,
      missingRequired: Array.isArray(packageEntryDiagnostics?.missingRequiredEntries) ? packageEntryDiagnostics.missingRequiredEntries : [],
    },
  };
  if (!progress.designDocs.completed) {
    progress.nextStage = 'design_docs';
  } else if (!progress.prototypeTopLevel.completed) {
    progress.nextStage = 'prototype_top_level';
  } else if (!progress.prototypeModules.completed) {
    progress.nextStage = 'prototype_modules';
  } else if (!progress.benchmarkSelfCheck.passed) {
    progress.nextStage = 'benchmark_self_check';
  } else if (progress.qualityEvidence.missing.includes(DATABASE_LAB_DESIGN_QUALITY_FILE)) {
    progress.nextStage = 'design_manifest';
  } else {
    progress.nextStage = 'complete';
  }
  return progress;
}


function getPrioritizedDatabasePrototypeRepairTargets(prototypeCodeDiagnostics, allTargets) {
  const failedChecks = Array.isArray(prototypeCodeDiagnostics?.failedChecks)
    ? prototypeCodeDiagnostics.failedChecks
    : [];
  const targetSet = new Set(Array.isArray(allTargets) ? allTargets : []);
  const criticalTargets = [];
  const secondaryTargets = [];
  const fallbackTargets = [];
  const pushUnique = (bucket, relativePath) => {
    if (targetSet.has(relativePath) && !criticalTargets.includes(relativePath) && !secondaryTargets.includes(relativePath) && !fallbackTargets.includes(relativePath)) {
      bucket.push(relativePath);
    }
  };
  const pushCritical = (relativePath) => pushUnique(criticalTargets, relativePath);
  const pushSecondary = (relativePath) => pushUnique(secondaryTargets, relativePath);
  const pushFallback = (relativePath) => pushUnique(fallbackTargets, relativePath);
  const benchPath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
  const storagePath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`;
  const bufferPoolPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`;
  const bPlusTreeIndexPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`;
  const walManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`;
  const transactionManagerPath = `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`;
  const packageJsonPath = `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`;
  const benchModuleExportTargets = Array.from(new Set(
    failedChecks
      .filter((entry) =>
        entry.startsWith('bench_module_export_mismatch:')
        || entry.startsWith('bench_module_export_name_mismatch:')
      )
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),
  ));
  const benchModuleApiTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('bench_module_api_mismatch:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),
  ));
  const undeclaredExternalDependencyTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
  ));
  const undeclaredNodeBuiltinTargets = Array.from(new Set(
    failedChecks
      .filter((entry) => entry.startsWith('undeclared_node_builtin:'))
      .map((entry) => entry.split(':').slice(1, 2).join(':'))
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),
  ));

  if (failedChecks.includes('prototype_module_system_mismatch')) {
    pushCritical(packageJsonPath);
    pushCritical(benchPath);
  }
  if (benchModuleExportTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleExportTargets) {
      pushCritical(relativePath);
    }
  }
  if (benchModuleApiTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleApiTargets) {
      pushCritical(relativePath);
    }
  }
  if (undeclaredExternalDependencyTargets.length > 0) {
    pushCritical(packageJsonPath);
    for (const relativePath of undeclaredExternalDependencyTargets) {
      pushCritical(relativePath);
    }
  }
  if (undeclaredNodeBuiltinTargets.length > 0) {
    for (const relativePath of undeclaredNodeBuiltinTargets) {
      pushCritical(relativePath);
    }
  }
  if (
    failedChecks.includes('bench_transaction_api_mismatch')
    || failedChecks.includes('bench_transaction_manager_argument_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
  ) {
    pushCritical(benchPath);
    pushCritical(transactionManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_constructor_arg_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
  ) {
    pushCritical(benchPath);
    pushCritical(transactionManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
  ) {
    pushSecondary(transactionManagerPath);
    pushSecondary(walManagerPath);
  }
  if (
    failedChecks.includes('transaction_manager_storage_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))
  ) {
    pushSecondary(transactionManagerPath);
    pushSecondary(storagePath);
  }
  if (
    failedChecks.includes('storage_engine_index_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
  ) {
    pushCritical(storagePath);
    pushCritical(bPlusTreeIndexPath);
  }
  if (
    failedChecks.includes('bench_storage_engine_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_storage_engine_'))
    || failedChecks.some((entry) => entry.startsWith('storage_engine_'))
    || failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(storagePath);
  }
  if (
    failedChecks.includes('bench_buffer_pool_api_mismatch')
    || failedChecks.includes('buffer_pool_constructor_arg_mismatch')
    || failedChecks.includes('buffer_pool_constructor_dependency_missing')
    || failedChecks.includes('bench_buffer_pool_missing_initialize')
    || failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(bufferPoolPath);
  }
  if (failedChecks.includes('wal_manager_constructor_arg_mismatch')) {
    pushSecondary(benchPath);
    pushSecondary(walManagerPath);
  }
  if (failedChecks.includes('wal_timestamp_uint32_overflow_risk')) {
    pushSecondary(walManagerPath);
  }
  if (
    failedChecks.includes('bench_wal_manager_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
  ) {
    pushSecondary(benchPath);
    pushSecondary(walManagerPath);
  }
  const benchModuleContractTargets = Array.from(new Set([
    ...benchModuleExportTargets,
    ...benchModuleApiTargets,
  ]));
  if (benchModuleContractTargets.length > 0) {
    pushCritical(benchPath);
    for (const relativePath of benchModuleContractTargets) {
      pushCritical(relativePath);
    }
  }
  if (
    failedChecks.includes('bench_output_not_machine_readable')
    || failedChecks.includes('bench_output_extra_stdout_logs')
    || failedChecks.includes('bench_output_missing_result_envelope')
    || failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
  ) {
    pushCritical(benchPath);
  }

  for (const relativePath of targetSet) {
    pushFallback(relativePath);
  }
  const prioritized = [...criticalTargets, ...secondaryTargets, ...fallbackTargets];
  const hasTransactionApiDrift =
    failedChecks.includes('bench_transaction_api_mismatch')
    || failedChecks.includes('bench_transaction_manager_argument_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'));
  const hasStorageDrift =
    failedChecks.includes('bench_storage_engine_api_mismatch')
    || failedChecks.some((entry) => entry.startsWith('bench_storage_engine_'))
    || failedChecks.some((entry) => entry.startsWith('storage_engine_'));
  const hasStorageIndexDrift =
    failedChecks.includes('storage_engine_index_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'));
  const hasBufferDrift =
    failedChecks.includes('bench_buffer_pool_api_mismatch')
    || failedChecks.includes('buffer_pool_constructor_arg_mismatch')
    || failedChecks.includes('buffer_pool_constructor_dependency_missing')
    || failedChecks.includes('bench_buffer_pool_missing_initialize')
    || failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
    || failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'));
  const hasWalDrift =
    failedChecks.includes('wal_manager_constructor_arg_mismatch')
    || failedChecks.includes('wal_timestamp_uint32_overflow_risk')
    || failedChecks.some((entry) => entry.startsWith('bench_module_export_name_mismatch:') && entry.includes('/wal-manager.js:'))
    || failedChecks.some((entry) => entry.startsWith('bench_module_api_mismatch:') && entry.includes('/wal-manager.js'))
    || failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'));
  const hasTransactionContractDrift =
    failedChecks.includes('transaction_manager_constructor_arg_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
    || failedChecks.includes('transaction_manager_wal_contract_mismatch')
    || failedChecks.includes('transaction_manager_storage_contract_mismatch')
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
    || failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'));
  const hasQueryExecutorDrift = failedChecks.includes('query_executor_database_contract_mismatch');
  const driftCategoryCount = [
    benchModuleContractTargets.length > 0 || failedChecks.includes('prototype_module_system_mismatch'),
    hasStorageDrift,
    hasBufferDrift,
    hasWalDrift,
    hasTransactionApiDrift || hasTransactionContractDrift,
    hasQueryExecutorDrift,
  ].filter(Boolean).length;
  let maxTargets = hasTransactionApiDrift && hasStorageDrift ? 3 : 2;
  if (driftCategoryCount >= 4) {
    maxTargets = Math.max(maxTargets, 6);
  } else if (driftCategoryCount === 3) {
    maxTargets = Math.max(maxTargets, 5);
  } else if (driftCategoryCount === 2) {
    maxTargets = Math.max(maxTargets, 4);
  }
  if (hasStorageIndexDrift) {
    maxTargets = Math.max(maxTargets, 3);
  }
  return prioritized.slice(0, maxTargets);
}


function tryParseJsonFromCommandStdout(stdoutText) {
  const trimmed = typeof stdoutText === 'string' ? stdoutText.trim() : '';
  if (!trimmed) {
    return { parsed: null, parseError: 'stdout_empty' };
  }
  const balancedJson = extractFirstBalancedJsonObject(trimmed);
  if (balancedJson) {
    try {
      return { parsed: JSON.parse(balancedJson), parseError: null };
    } catch {
      // Fall through to legacy candidate scanning.
    }
  }
  const braceIndexes = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === '{') {
      braceIndexes.push(index);
    }
  }
  for (const index of braceIndexes) {
    const candidate = trimmed.slice(index);
    try {
      return { parsed: JSON.parse(candidate), parseError: null };
    } catch {
      // Try the next candidate.
    }
  }
  return { parsed: null, parseError: 'stdout_json_parse_failed' };
}

function evaluateDatabaseBenchmarkSelfCheck(verificationAudit) {
  const stderr = typeof verificationAudit?.stderr === 'string' ? verificationAudit.stderr.trim() : '';
  const stdout = typeof verificationAudit?.stdout === 'string' ? verificationAudit.stdout.trim() : '';
  const { parsed, parseError } = tryParseJsonFromCommandStdout(stdout);
  const metrics = parsed && typeof parsed === 'object' ? parsed.metrics : null;
  const hasRequiredMetrics =
    !!metrics
    && ['pagesWritten', 'pagesRead', 'writeDurationMs', 'readDurationMs', 'totalDurationMs']
      .every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]));
  const status = parsed && typeof parsed === 'object' && typeof parsed.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : null;
  const statusAcceptable =
    status === null
    || status === 'ok'
    || status === 'passed'
    || status === 'success'
    || status === 'completed'
    || status === 'dry-run'
    || status === 'dry_run'
    || status === 'dryrun';
  const stderrLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stderr);
  const stdoutLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stdout);
  const passed =
    !!verificationAudit
    && verificationAudit.exitCode === 0
    && !stderrLooksFatal
    && !stdoutLooksFatal
    && hasRequiredMetrics
    && statusAcceptable;

  return {
    attempted: Boolean(verificationAudit),
    passed,
    command: verificationAudit ? `${verificationAudit.command} ${Array.isArray(verificationAudit.args) ? verificationAudit.args.join(' ') : ''}`.trim() : null,
    exitCode: verificationAudit?.exitCode ?? null,
    stderr: stderr || null,
    stdout: stdout || null,
    parsedStatus: status,
    parseError,
    hasRequiredMetrics,
  };
}

function summarizeDatabaseArtifactProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return 'artifact progress unavailable';
  }
  const completed = [];
  const remaining = [];
  if (progress.designDocs?.completed) {
    completed.push('design docs complete');
  } else if (Array.isArray(progress.designDocs?.missing) && progress.designDocs.missing.length > 0) {
    remaining.push(`design docs missing: ${progress.designDocs.missing.join(', ')}`);
  }
  if (progress.prototypeTopLevel?.completed) {
    completed.push('prototype top-level files complete');
  } else if (Array.isArray(progress.prototypeTopLevel?.missing) && progress.prototypeTopLevel.missing.length > 0) {
    remaining.push(`prototype top-level files missing: ${progress.prototypeTopLevel.missing.join(', ')}`);
  }
  if (progress.prototypeModules?.completed) {
    completed.push(`prototype src depth reached (${progress.prototypeModules.count} files)`);
  } else {
    remaining.push(`prototype src depth incomplete (${progress.prototypeModules?.count ?? 0} files present)`);
  }
  if (Array.isArray(progress.prototypeModules?.missingCoreModules) && progress.prototypeModules.missingCoreModules.length > 0) {
    remaining.push(`core prototype modules missing: ${progress.prototypeModules.missingCoreModules.join(', ')}`);
  }
  if (progress.benchDependencies?.wiredToPrototypeModules === false) {
    remaining.push('benchmark scaffold not wired to prototype src modules');
  }
  if (Array.isArray(progress.prototypeModules?.missingBenchDependencyModules) && progress.prototypeModules.missingBenchDependencyModules.length > 0) {
    remaining.push(`benchmark module prerequisites missing: ${progress.prototypeModules.missingBenchDependencyModules.join(', ')}`);
  }
  if (Array.isArray(progress.qualityEvidence?.present) && progress.qualityEvidence.present.length > 0) {
    completed.push(`quality evidence present: ${progress.qualityEvidence.present.join(', ')}`);
  }
  if (Array.isArray(progress.qualityEvidence?.missing) && progress.qualityEvidence.missing.length > 0) {
    remaining.push(`quality evidence missing: ${progress.qualityEvidence.missing.join(', ')}`);
  }
  if (Array.isArray(progress.packageEntryRefs?.missingRequired) && progress.packageEntryRefs.missingRequired.length > 0) {
    remaining.push(`package entry requirements missing: ${progress.packageEntryRefs.missingRequired.join(', ')}`);
  }
  if (progress.benchmarkSelfCheck?.attempted) {
    completed.push(progress.benchmarkSelfCheck.passed ? 'benchmark self-check passed' : 'benchmark self-check failed');
  } else {
    remaining.push('benchmark self-check not yet observed');
  }
  if (progress.packageEntryRefs?.invalidPackageJson) {
    remaining.push(`prototype package.json invalid (${progress.packageEntryRefs.parseError ?? 'parse failure'})`);
  } else if (Array.isArray(progress.packageEntryRefs?.missingBlocking) && progress.packageEntryRefs.missingBlocking.length > 0) {
    remaining.push(`prototype package entry refs broken: ${progress.packageEntryRefs.missingBlocking.join(', ')}`);
  }
  if (Array.isArray(progress.packageEntryRefs?.missingOptional) && progress.packageEntryRefs.missingOptional.length > 0) {
    remaining.push(`prototype package entry refs optional/missing: ${progress.packageEntryRefs.missingOptional.join(', ')}`);
  }
  return [completed.join('; '), remaining.join('; ')].filter(Boolean).join(' | ');
}

export {
  evaluateDatabaseBenchmarkSelfCheck,
  extractDatabaseLabBenchRequiredModuleFiles,
  getBlockingDatabasePackageEntryRefs,
  getDatabaseBenchRepairAllowedOptionalPaths,
  getDatabaseLabBenchRequiredModuleFilesFromWorkspace,
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
  hasDatabaseLabRequiredDesignFiles,
  hasDatabaseLabRequiredPrototypeFiles,
  hasDatabaseLabRequiredWorkspaceShape,
  hasDatabaseLabVerificationEvidence,
  hasObservedDatabaseBenchRunAttempt,
  hasSuccessfulDatabaseBenchRunEvidence,
  mergeDatabaseBenchRequiredModuleFiles,
  summarizeDatabaseArtifactProgress,
  tryParseJsonFromCommandStdout,
};
