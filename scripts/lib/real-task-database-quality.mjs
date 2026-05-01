import fs from 'node:fs';
import path from 'node:path';
import { DATABASE_LAB_RULES } from './real-task-scenario-packs.mjs';

export const DATABASE_SCENARIO_QUALITY_GATES = [
  'database_near_mysql_design',
  'database_near_mysql_verify',
];

const STUB_CODE_PATTERN = /\b(?:todo|stub|not implemented|placeholder implementation|throw new Error\(['"`]not implemented)/i;
const BENCH_STACK_RISK_PATTERN = /push\(\s*\.\.\.[^)]*latenc|Math\.(?:min|max)\(\s*\.\.\.[^)]+\)/i;
const DATABASE_LAB_CORE_IMPLEMENTED_MODULES = DATABASE_LAB_RULES.defaultPrototypeSrcFiles;

function addUnique(target, values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim();
    if (normalized && !target.includes(normalized)) {
      target.push(normalized);
    }
  }
}

function normalizeRelativePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

function normalizeRelativeToolPath(value) {
  return normalizeRelativePath(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function resolveFilePath(workspaceDir, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return path.resolve(workspaceDir);
  }
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceDir, filePath);
}

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonEvidence(filePath) {
  const text = readTextIfExists(filePath);
  if (!text) {
    return { status: 'missing', value: null, parseError: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: 'valid', value: parsed, parseError: null };
    }
    return { status: 'invalid', value: null, parseError: 'Expected a JSON object.' };
  } catch (error) {
    return {
      status: 'invalid',
      value: null,
      parseError: error instanceof Error ? error.message : 'Unknown JSON parse failure.',
    };
  }
}

function listFilesRecursive(rootDir) {
  try {
    if (!fs.existsSync(rootDir)) {
      return [];
    }
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const resolved = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(resolved));
      } else if (entry.isFile()) {
        files.push(normalizeRelativePath(resolved));
      }
    }
    return files;
  } catch {
    return [];
  }
}

function getStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : [];
}

function stripJavaScriptComments(sourceText) {
  let result = '';
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateLiteral = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (index < sourceText.length) {
    const current = sourceText[index];
    const next = sourceText[index + 1] ?? '';
    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        result += current;
      }
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }
      if (current === '\n') {
        result += '\n';
      }
      index += 1;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && !inTemplateLiteral && current === '/' && next === '/') {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && !inTemplateLiteral && current === '/' && next === '*') {
      inBlockComment = true;
      index += 2;
      continue;
    }
    result += current;
    if (current === '\\') {
      if (index + 1 < sourceText.length) {
        result += sourceText[index + 1];
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (!inDoubleQuote && !inTemplateLiteral && current === "'") {
      inSingleQuote = !inSingleQuote;
    } else if (!inSingleQuote && !inTemplateLiteral && current === '"') {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote && current === '`') {
      inTemplateLiteral = !inTemplateLiteral;
    }
    index += 1;
  }
  return result;
}

function getImplementationCodeForQualityChecks(content) {
  return stripJavaScriptComments(String(content ?? '')).trim();
}

function hasStubLikeImplementation(content) {
  const codeOnly = getImplementationCodeForQualityChecks(content);
  if (STUB_CODE_PATTERN.test(codeOnly)) {
    return true;
  }
  return codeOnly.length === 0 && STUB_CODE_PATTERN.test(String(content ?? ''));
}

function isShallowImplementation(content, minimumLength = 180) {
  return getImplementationCodeForQualityChecks(content).length < minimumLength;
}

function extractBenchPrototypeModuleDependencies(benchScript) {
  const dependencies = [];
  const scriptsDir = `${DATABASE_LAB_RULES.prototypeDir}/scripts`;
  const patterns = [
    /require\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
    /from\s+['"`](\.\.?\/[^'"`]+)['"`]/g,
    /import\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(benchScript)) !== null) {
      const specifier = match[1]?.trim();
      if (!specifier) {
        continue;
      }
      let normalizedPath = normalizeRelativePath(path.posix.normalize(path.posix.join(scriptsDir, specifier)));
      if (!normalizedPath.startsWith(`${DATABASE_LAB_RULES.prototypeDir}/src/`)) {
        continue;
      }
      if (!path.posix.extname(normalizedPath)) {
        normalizedPath = `${normalizedPath}.js`;
      }
      addUnique(dependencies, [normalizedPath]);
    }
  }
  return dependencies;
}

function extractToolText(invocation) {
  const chunks = [];
  if (typeof invocation?.error === 'string') {
    chunks.push(invocation.error);
  }
  const result = invocation?.result;
  if (!result || typeof result !== 'object') {
    return chunks.join('\n');
  }
  const stack = [result];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      chunks.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') {
      continue;
    }
    stack.push(...Object.values(current));
  }
  return chunks.join('\n');
}

function isDatabaseLabBenchmarkInvocation(invocation) {
  if (invocation?.toolId !== 'run_command') {
    return false;
  }
  const metadataText = invocation.metadata && typeof invocation.metadata === 'object'
    ? JSON.stringify(invocation.metadata)
    : '';
  const combined = `${extractToolText(invocation)}\n${metadataText}`.toLowerCase();
  return /(database-lab[\\/]prototype|npm(?:\.cmd)? run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|dry-run benchmark|dry run benchmark)/i.test(combined);
}

function getInvocationCompletedAt(invocation) {
  if (typeof invocation?.endedAt === 'number' && Number.isFinite(invocation.endedAt)) {
    return invocation.endedAt;
  }
  if (typeof invocation?.startedAt === 'number' && Number.isFinite(invocation.startedAt)) {
    return invocation.startedAt;
  }
  return 0;
}

function tryParseJsonFromCommandStdout(stdoutText) {
  const trimmed = typeof stdoutText === 'string' ? stdoutText.trim() : '';
  if (!trimmed) {
    return { parsed: null, parseError: 'stdout_empty' };
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
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { parsed, parseError: null };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { parsed: null, parseError: 'stdout_json_parse_failed' };
}

function evaluateSuccessfulBenchmarkInvocation(invocation) {
  const result = invocation?.result && typeof invocation.result === 'object' ? invocation.result : null;
  const stdout = typeof result?.stdout === 'string' ? result.stdout : null;
  const stderr = typeof result?.stderr === 'string' ? result.stderr : null;
  const { parsed, parseError } = tryParseJsonFromCommandStdout(stdout);
  const metrics = parsed && typeof parsed.metrics === 'object' && parsed.metrics ? parsed.metrics : null;
  const hasRequiredMetrics =
    !!metrics
    && ['pagesWritten', 'pagesRead', 'writeDurationMs', 'readDurationMs', 'totalDurationMs']
      .every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]));
  const status = typeof parsed?.status === 'string' ? parsed.status.trim().toLowerCase() : null;
  const statusAcceptable =
    status === null
    || status === 'ok'
    || status === 'passed'
    || status === 'success'
    || status === 'completed';
  const stderrLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stderr ?? '');
  const stdoutLooksFatal = /(?:^|\b)(TypeError|SyntaxError|ReferenceError|RangeError|Error:)/i.test(stdout ?? '');
  return {
    passed: invocation?.status === 'SUCCEEDED' && !stderrLooksFatal && !stdoutLooksFatal && statusAcceptable && hasRequiredMetrics,
    parseError,
    hasRequiredMetrics,
  };
}

function findSuccessfulInvocation(input, invocationId) {
  return Array.isArray(input?.toolInvocations)
    ? input.toolInvocations.find((invocation) => invocation.invocationId === invocationId && invocation.status === 'SUCCEEDED') ?? null
    : null;
}

function getWriteFileTargetPath(invocation) {
  if (invocation?.toolId !== 'write_file' || invocation.status !== 'SUCCEEDED') {
    return null;
  }
  const resultPath = typeof invocation.result?.path === 'string' ? invocation.result.path : null;
  const argumentPath = typeof invocation.arguments?.path === 'string' ? invocation.arguments.path : null;
  const resolved = resultPath ?? argumentPath;
  return resolved ? normalizeRelativeToolPath(resolved) : null;
}

function getLatestSuccessfulWriteCompletedAt(input, relativePaths) {
  const pathSet = new Set(relativePaths.map((entry) => normalizeRelativeToolPath(entry)));
  let latest = null;
  for (const invocation of Array.isArray(input?.toolInvocations) ? input.toolInvocations : []) {
    const targetPath = getWriteFileTargetPath(invocation);
    if (!targetPath || !pathSet.has(targetPath)) {
      continue;
    }
    const completedAt = getInvocationCompletedAt(invocation);
    if (latest === null || completedAt > latest) {
      latest = completedAt;
    }
  }
  return latest;
}

function createNotApplicableResult() {
  return {
    profileId: null,
    verdict: 'not_applicable',
    passedChecks: [],
    failedChecks: [],
    requiredNextEvidence: [],
    lastEvaluatedAt: null,
  };
}

function createResult({ profileId, passedChecks, failedChecks, requiredNextEvidence }) {
  return {
    profileId,
    verdict: failedChecks.length === 0 ? 'passed' : 'failed',
    passedChecks: [...passedChecks],
    failedChecks: [...failedChecks],
    requiredNextEvidence: [...requiredNextEvidence],
    lastEvaluatedAt: Date.now(),
  };
}

function evaluateDatabaseDesign(input) {
  const passedChecks = [];
  const failedChecks = [];
  const requiredNextEvidence = [];
  const auditPath = resolveFilePath(input.workspaceDir, DATABASE_LAB_RULES.designQualityFile);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    return createResult({
      profileId: 'database_near_mysql_design',
      passedChecks,
      failedChecks: ['missing_database_design_manifest'],
      requiredNextEvidence: ['write quality/database-design.json with designFiles and implementedModules'],
    });
  }
  if (auditRead.status === 'invalid') {
    return createResult({
      profileId: 'database_near_mysql_design',
      passedChecks,
      failedChecks: ['invalid_database_design_manifest_json'],
      requiredNextEvidence: [`repair quality/database-design.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`],
    });
  }
  const audit = auditRead.value;
  const designFiles = getStringArray(audit.designFiles);
  const prototypeFiles = getStringArray(audit.prototypeFiles);
  const implementedModules = getStringArray(audit.implementedModules);
  const prototypeSrcFiles = listFilesRecursive(resolveFilePath(input.workspaceDir, `${DATABASE_LAB_RULES.prototypeDir}/src`));
  const requiredFiles = [
    ...DATABASE_LAB_RULES.requiredDesignFiles,
    ...DATABASE_LAB_RULES.requiredPrototypeFiles,
  ];
  const manifestFileRefs = [...new Set([...designFiles, ...prototypeFiles])];
  for (const relativePath of requiredFiles) {
    if (!readTextIfExists(resolveFilePath(input.workspaceDir, relativePath))) {
      addUnique(failedChecks, [`missing_required_file:${relativePath}`]);
      addUnique(requiredNextEvidence, [`write required database lab file ${relativePath}`]);
    }
  }
  for (const relativePath of manifestFileRefs) {
    if (requiredFiles.includes(relativePath)) {
      continue;
    }
    if (!readTextIfExists(resolveFilePath(input.workspaceDir, relativePath))) {
      addUnique(failedChecks, [`manifest_references_missing_file:${relativePath}`]);
      addUnique(requiredNextEvidence, [`repair quality/database-design.json so it stops claiming missing file ${relativePath}, or write that file if it is truly required`]);
    }
  }
  const designCorpus = [...new Set([...DATABASE_LAB_RULES.requiredDesignFiles, ...designFiles])]
    .map((relativePath) => readTextIfExists(resolveFilePath(input.workspaceDir, relativePath)) ?? '')
    .join('\n');
  for (const [index, group] of Object.values(DATABASE_LAB_RULES.designTopicGroups).map((entry) => entry.label.split('/')).entries()) {
    if (!group.some((token) => designCorpus.toLowerCase().includes(token))) {
      failedChecks.push(`design_coverage_gap:${index + 1}`);
      requiredNextEvidence.push(`cover database design topic group ${index + 1}: ${group.join('/')}`);
    }
  }
  const benchScriptPath = `${DATABASE_LAB_RULES.prototypeDir}/scripts/bench.js`;
  const benchScript = readTextIfExists(resolveFilePath(input.workspaceDir, benchScriptPath)) ?? '';
  const requiredBenchMetricKeys = ['pagesWritten', 'pagesRead', 'writeDurationMs', 'readDurationMs', 'totalDurationMs'];
  const benchRequiredModules = extractBenchPrototypeModuleDependencies(benchScript);
  for (const modulePath of DATABASE_LAB_CORE_IMPLEMENTED_MODULES) {
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      failedChecks.push(`missing_core_module:${modulePath}`);
      requiredNextEvidence.push(`write the required database prototype core module ${modulePath}`);
      continue;
    }
    if (!implementedModules.includes(modulePath)) {
      failedChecks.push(`core_module_untracked:${modulePath}`);
      requiredNextEvidence.push(`list ${modulePath} in quality/database-design.json implementedModules`);
    }
  }
  if (implementedModules.length > 0 && benchRequiredModules.length === 0) {
    failedChecks.push('benchmark_not_wired_to_prototype_modules');
    requiredNextEvidence.push(`${benchScriptPath} must import real modules under ${DATABASE_LAB_RULES.prototypeDir}/src/ instead of placeholder-only logic`);
  }
  if (implementedModules.length < DATABASE_LAB_CORE_IMPLEMENTED_MODULES.length) {
    failedChecks.push('insufficient_implemented_modules');
    requiredNextEvidence.push(`ship the full core prototype module set and list it in implementedModules: ${DATABASE_LAB_CORE_IMPLEMENTED_MODULES.join(', ')}`);
  }
  if (prototypeSrcFiles.length === 0) {
    failedChecks.push('missing_prototype_src_modules');
    requiredNextEvidence.push(`write real implementation files under ${DATABASE_LAB_RULES.prototypeDir}/src/`);
  } else {
    passedChecks.push('prototype_src_modules_present');
  }
  const implementedModuleSet = new Set(implementedModules);
  for (const modulePath of benchRequiredModules) {
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      failedChecks.push(`benchmark_dependency_missing:${modulePath}`);
      requiredNextEvidence.push(`implement benchmark dependency module ${modulePath}`);
      continue;
    }
    if (!implementedModuleSet.has(modulePath)) {
      failedChecks.push(`benchmark_dependency_untracked:${modulePath}`);
      requiredNextEvidence.push(`list ${modulePath} in quality/database-design.json implementedModules`);
      continue;
    }
    if (hasStubLikeImplementation(content)) {
      failedChecks.push(`stub_module:${modulePath}`);
      requiredNextEvidence.push(`replace stub implementation in ${modulePath} with runnable logic`);
      continue;
    }
    if (isShallowImplementation(content)) {
      failedChecks.push(`module_too_shallow:${modulePath}`);
      requiredNextEvidence.push(`expand ${modulePath} beyond a shallow placeholder`);
      continue;
    }
    passedChecks.push(`benchmark_dependency_ready:${modulePath}`);
  }
  for (const modulePath of implementedModules) {
    if (!modulePath.startsWith(`${DATABASE_LAB_RULES.prototypeDir}/src/`)) {
      failedChecks.push(`implemented_module_outside_prototype_src:${modulePath}`);
      requiredNextEvidence.push(`move or rewrite ${modulePath} under ${DATABASE_LAB_RULES.prototypeDir}/src/`);
      continue;
    }
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      addUnique(failedChecks, [`manifest_references_missing_implemented_module:${modulePath}`]);
      addUnique(requiredNextEvidence, [`repair quality/database-design.json implementedModules so it matches real files under ${DATABASE_LAB_RULES.prototypeDir}/src/, or write ${modulePath} if it is truly implemented`]);
      continue;
    }
    if (hasStubLikeImplementation(content)) {
      failedChecks.push(`stub_module:${modulePath}`);
      requiredNextEvidence.push(`replace stub implementation in ${modulePath} with runnable logic`);
      continue;
    }
    if (isShallowImplementation(content)) {
      failedChecks.push(`module_too_shallow:${modulePath}`);
      requiredNextEvidence.push(`expand ${modulePath} beyond a shallow placeholder`);
      continue;
    }
    passedChecks.push(`implemented_module:${modulePath}`);
  }
  const prototypeReadme = readTextIfExists(resolveFilePath(input.workspaceDir, `${DATABASE_LAB_RULES.prototypeDir}/README.md`)) ?? '';
  if (/no actual database functionality is implemented/i.test(prototypeReadme)) {
    failedChecks.push('prototype_self_declares_stub_only');
    requiredNextEvidence.push('update prototype README after implementing runnable database behavior');
  }
  if (!/result|metric|latency|throughput|benchmark/i.test(benchScript)) {
    failedChecks.push('benchmark_scaffold_missing_metrics');
    requiredNextEvidence.push(`implement benchmark metrics in ${benchScriptPath}`);
  } else {
    passedChecks.push('benchmark_scaffold_present');
  }
  const missingRequiredBenchMetricKeys = requiredBenchMetricKeys.filter((token) => !benchScript.includes(token));
  if (benchScript && missingRequiredBenchMetricKeys.length > 0) {
    failedChecks.push('benchmark_scaffold_missing_required_metric_keys');
    requiredNextEvidence.push(`ensure ${benchScriptPath} emits metrics keys ${missingRequiredBenchMetricKeys.join(', ')}`);
  }
  if (/(new\s+Worker|worker_threads)/i.test(benchScript) && BENCH_STACK_RISK_PATTERN.test(benchScript)) {
    failedChecks.push('benchmark_scaffold_stack_risk');
    requiredNextEvidence.push(`repair ${benchScriptPath} so worker latency results are aggregated without spread-pushing large arrays`);
  }
  const benchmarkInvocations = (Array.isArray(input.toolInvocations) ? input.toolInvocations : [])
    .filter((invocation) => isDatabaseLabBenchmarkInvocation(invocation))
    .sort((left, right) => getInvocationCompletedAt(right) - getInvocationCompletedAt(left));
  const latestBenchmarkInvocation = benchmarkInvocations[0] ?? null;
  const latestBenchmarkSensitiveWriteAt = getLatestSuccessfulWriteCompletedAt(input, [
    `${DATABASE_LAB_RULES.prototypeDir}/package.json`,
    benchScriptPath,
    ...benchRequiredModules,
    ...implementedModules,
  ]);
  const benchmarkSelfCheckGrounded =
    prototypeSrcFiles.length >= 2
    && benchRequiredModules.length > 0
    && !failedChecks.includes('benchmark_not_wired_to_prototype_modules')
    && !failedChecks.includes('missing_prototype_src_modules')
    && !failedChecks.some((entry) => entry.startsWith('benchmark_dependency_missing:'))
    && !failedChecks.some((entry) => entry.startsWith('benchmark_dependency_untracked:'))
    && !failedChecks.some((entry) => entry.startsWith('implemented_module_outside_prototype_src:'))
    && !failedChecks.some((entry) => entry.startsWith('stub_module:'))
    && !failedChecks.some((entry) => entry.startsWith('module_too_shallow:'));
  if (!latestBenchmarkInvocation) {
    failedChecks.push('missing_benchmark_self_check');
    requiredNextEvidence.push(`run a successful dry-run benchmark command from ${DATABASE_LAB_RULES.prototypeDir} and keep its tool evidence`);
  } else if (!benchmarkSelfCheckGrounded) {
    failedChecks.push('benchmark_self_check_not_grounded');
    requiredNextEvidence.push(`rerun the dry-run benchmark only after ${DATABASE_LAB_RULES.prototypeDir}/src contains real modules and ${benchScriptPath} imports them directly`);
  } else if (latestBenchmarkSensitiveWriteAt !== null && getInvocationCompletedAt(latestBenchmarkInvocation) < latestBenchmarkSensitiveWriteAt) {
    failedChecks.push('benchmark_self_check_stale');
    requiredNextEvidence.push(`rerun a successful dry-run benchmark command from ${DATABASE_LAB_RULES.prototypeDir} after the latest bench.js or prototype/src changes`);
  } else if (latestBenchmarkInvocation.status === 'SUCCEEDED') {
    const benchmarkEvaluation = evaluateSuccessfulBenchmarkInvocation(latestBenchmarkInvocation);
    if (benchmarkEvaluation.passed) {
      passedChecks.push('benchmark_self_check_evidence_present');
    } else if (!benchmarkEvaluation.hasRequiredMetrics) {
      failedChecks.push('benchmark_self_check_missing_required_metrics');
      requiredNextEvidence.push(`repair ${benchScriptPath} so the successful dry-run stdout includes metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, totalDurationMs, then rerun the benchmark`);
    } else {
      failedChecks.push('benchmark_self_check_output_invalid');
      requiredNextEvidence.push(`repair ${benchScriptPath} so the successful dry-run stdout is one parseable JSON object with top-level status, summary, and metrics keys, then rerun the benchmark (${benchmarkEvaluation.parseError ?? 'stdout parse failure'})`);
    }
  } else {
    failedChecks.push('benchmark_self_check_failed');
    requiredNextEvidence.push(`repair the benchmark scaffold and rerun a successful dry-run benchmark command from ${DATABASE_LAB_RULES.prototypeDir}`);
  }
  return createResult({
    profileId: 'database_near_mysql_design',
    passedChecks,
    failedChecks,
    requiredNextEvidence,
  });
}

function evaluateDatabaseVerify(input) {
  const passedChecks = [];
  const failedChecks = [];
  const requiredNextEvidence = [];
  const baseDesign = evaluateDatabaseDesign(input);
  if (baseDesign.verdict === 'failed') {
    addUnique(failedChecks, baseDesign.failedChecks);
    addUnique(requiredNextEvidence, baseDesign.requiredNextEvidence);
  } else {
    addUnique(passedChecks, baseDesign.passedChecks);
  }
  const auditPath = resolveFilePath(input.workspaceDir, DATABASE_LAB_RULES.verifyQualityFile);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    addUnique(failedChecks, ['missing_database_benchmark_result']);
    addUnique(requiredNextEvidence, ['write quality/database-benchmark-result.json with resultFile and sourceInvocationId']);
    return createResult({ profileId: 'database_near_mysql_verify', passedChecks, failedChecks, requiredNextEvidence });
  }
  if (auditRead.status === 'invalid') {
    addUnique(failedChecks, ['invalid_database_benchmark_result_json']);
    addUnique(requiredNextEvidence, [`repair quality/database-benchmark-result.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]);
    return createResult({ profileId: 'database_near_mysql_verify', passedChecks, failedChecks, requiredNextEvidence });
  }
  const audit = auditRead.value;
  const resultFile = typeof audit.resultFile === 'string' ? audit.resultFile : '';
  const benchmarkCommand = typeof audit.benchmarkCommand === 'string' ? audit.benchmarkCommand : '';
  const sourceInvocationId = typeof audit.sourceInvocationId === 'string' ? audit.sourceInvocationId : '';
  const updatedDocs = getStringArray(audit.updatedDocs);
  const implementedModules = getStringArray(audit.implementedModules);
  const invocation = sourceInvocationId ? findSuccessfulInvocation(input, sourceInvocationId) : null;
  if (!invocation) {
    addUnique(failedChecks, ['missing_benchmark_tool_evidence']);
    addUnique(requiredNextEvidence, ['run a successful benchmark or dry-run command and cite its invocation id']);
  } else {
    const toolText = extractToolText(invocation).toLowerCase();
    if (!toolText.includes('bench') && !benchmarkCommand.toLowerCase().includes('bench')) {
      addUnique(failedChecks, ['benchmark_command_not_observed']);
    } else {
      addUnique(passedChecks, ['benchmark_command_observed']);
    }
  }
  const resultRead = resultFile ? readJsonEvidence(resolveFilePath(input.workspaceDir, resultFile)) : null;
  if (!resultRead || resultRead.status === 'missing') {
    addUnique(failedChecks, ['missing_benchmark_result_file']);
    addUnique(requiredNextEvidence, ['write a parseable benchmark result file and reference it in quality/database-benchmark-result.json']);
  } else if (resultRead.status === 'invalid') {
    addUnique(failedChecks, ['invalid_benchmark_result_json']);
    addUnique(requiredNextEvidence, [`repair ${resultFile} so it is valid JSON (${resultRead.parseError ?? 'parse failure'})`]);
  } else {
    const resultJson = resultRead.value ?? {};
    if (!('metrics' in resultJson) && !('summary' in resultJson) && !('status' in resultJson)) {
      addUnique(failedChecks, ['benchmark_result_missing_metrics']);
    } else {
      addUnique(passedChecks, ['benchmark_result_present']);
    }
  }
  if (implementedModules.length === 0) {
    addUnique(failedChecks, ['missing_verified_implemented_modules']);
    addUnique(requiredNextEvidence, ['list the real prototype/src implementation modules in quality/database-benchmark-result.json']);
  }
  for (const modulePath of DATABASE_LAB_CORE_IMPLEMENTED_MODULES) {
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      addUnique(failedChecks, [`missing_verified_core_module:${modulePath}`]);
      addUnique(requiredNextEvidence, [`write the required verified core module ${modulePath}`]);
      continue;
    }
    if (!implementedModules.includes(modulePath)) {
      addUnique(failedChecks, [`verified_core_module_untracked:${modulePath}`]);
      addUnique(requiredNextEvidence, [`list ${modulePath} in quality/database-benchmark-result.json implementedModules`]);
    }
  }
  for (const modulePath of implementedModules) {
    if (!modulePath.startsWith(`${DATABASE_LAB_RULES.prototypeDir}/src/`)) {
      addUnique(failedChecks, [`verified_module_outside_prototype_src:${modulePath}`]);
      continue;
    }
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      addUnique(failedChecks, [`missing_verified_module:${modulePath}`]);
      continue;
    }
    if (hasStubLikeImplementation(content) || isShallowImplementation(content)) {
      addUnique(failedChecks, [`verified_module_too_shallow:${modulePath}`]);
      continue;
    }
    addUnique(passedChecks, [`verified_module:${modulePath}`]);
  }
  for (const docPath of updatedDocs) {
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, docPath));
    if (!content) {
      addUnique(failedChecks, [`missing_updated_doc:${docPath}`]);
      continue;
    }
    if (!/unproven|validated|measured|result/i.test(content)) {
      addUnique(failedChecks, [`doc_not_updated_with_benchmark:${docPath}`]);
      continue;
    }
    addUnique(passedChecks, [`updated_doc:${docPath}`]);
  }
  if (updatedDocs.length === 0) {
    addUnique(failedChecks, ['missing_updated_docs_reference']);
    addUnique(requiredNextEvidence, ['list the updated benchmark/design docs in quality/database-benchmark-result.json']);
  }
  return createResult({
    profileId: 'database_near_mysql_verify',
    passedChecks,
    failedChecks,
    requiredNextEvidence,
  });
}

export function evaluateDatabaseScenarioQuality(input) {
  const gateId = input?.qualityGateId ?? input?.qualityProfileId ?? null;
  if (gateId === 'database_near_mysql_design') {
    return evaluateDatabaseDesign(input);
  }
  if (gateId === 'database_near_mysql_verify') {
    return evaluateDatabaseVerify(input);
  }
  return createNotApplicableResult();
}
