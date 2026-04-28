import fs from 'node:fs';
import path from 'node:path';
import {
  ExecutionProfileId,
  QualityProfileId
} from '../contracts/types';
import {
  RuntimeEventRecord,
  ToolInvocationRecord
} from '../../foundation/repository/types';

export const QUALITY_EVIDENCE_FILES: Record<QualityProfileId, string> = {
  web_experience: 'quality/web-audit.json',
  docs_normalize: 'quality/docs-normalize-trace.json',
  docs_synthesize: 'quality/docs-synthesize-trace.json',
  system_audit: 'quality/system-audit.json',
  desktop_observation: 'quality/desktop-observation.json',
  database_near_mysql_design: 'quality/database-design.json',
  database_near_mysql_verify: 'quality/database-benchmark-result.json'
};

export interface TaskQualityEvaluationInput {
  taskId: string;
  title: string;
  intent: string;
  unitId: string | null;
  executionProfileId: ExecutionProfileId | 'analyze';
  qualityProfileId: QualityProfileId | null | undefined;
  workspaceDir: string;
  artifactPaths: string[];
  artifactDestinationPaths: string[];
  artifactDestinationDir: string | null;
  latestVisibleOutput?: {
    summary: string;
    details: string | null;
    issues: string[];
  } | null;
  completionSummary?: {
    summary: string | null;
    details: string | null;
    issues: string[];
  } | null;
  toolInvocations: Array<Pick<ToolInvocationRecord, 'invocationId' | 'toolId' | 'status' | 'unitId' | 'arguments' | 'startedAt' | 'endedAt' | 'result' | 'error' | 'metadata'>>;
  events?: Array<Pick<RuntimeEventRecord, 'type' | 'payload' | 'timestamp'>>;
}

export interface TaskQualityEvaluationResult {
  profileId: QualityProfileId | null;
  verdict: 'passed' | 'failed' | 'not_applicable';
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
  lastEvaluatedAt: number | null;
}

type PromptSpec = {
  label: string;
  requiredEvidenceFile: string;
  instructions: string[];
  jsonExample: Record<string, unknown>;
};

const PROMPT_SPECS: Record<QualityProfileId, PromptSpec> = {
  web_experience: {
    label: 'web_experience',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.web_experience,
    instructions: [
      'Produce a real user-facing web artifact, not placeholder copy.',
      'Before claiming completion, create or update quality/web-audit.json in the workspace.',
      'Write quality/web-audit.json with keys: profile, artifactKind, entryFiles, supportingFiles, interactionSelectors, brandingTitle.',
      'Every entry file listed in the audit must exist. Avoid mojibake, placeholder branding, lorem ipsum, and sample-only body text.',
      'At least one visible interaction must exist and be listed in interactionSelectors. Static pages still need real interactive behavior.',
      'JavaScript supporting files must be syntactically valid; do not claim completion with broken scripts.'
    ],
    jsonExample: {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['index.html'],
      supportingFiles: ['styles.css', 'script.js'],
      interactionSelectors: ['[data-theme-toggle]'],
      brandingTitle: 'Actual product title'
    }
  },
  docs_normalize: {
    label: 'docs_normalize',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.docs_normalize,
    instructions: [
      'Normalize documents without replacing real content with templates.',
      'Before claiming completion, write quality/docs-normalize-trace.json with concrete source-to-output mappings.',
      'Write quality/docs-normalize-trace.json with mappings[]. Each mapping must contain sourceFile, outputFile, and sourceSnippets[].',
      'Each sourceSnippet must appear in the source file, and at least one sourceSnippet from each mapping must still appear in the normalized output.',
      'When writing a normalized document set under normalized/, normalized/index.md must link to each sibling markdown file, and at least two normalized markdown files must contain real sibling markdown links.',
      'Do not output placeholder bullets like Feature 1, Requirement A, or generic filler.'
    ],
    jsonExample: {
      profile: 'docs_normalize',
      mappings: [
        {
          sourceFile: 'incoming/raw-product-notes.md',
          outputFile: 'normalized/product-notes.md',
          sourceSnippets: ['interactive elegance', 'add author spotlight']
        }
      ]
    }
  },
  docs_synthesize: {
    label: 'docs_synthesize',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.docs_synthesize,
    instructions: [
      'Synthesize documents with explicit source grounding.',
      'Before claiming completion, write quality/docs-synthesize-trace.json with claim-level grounding.',
      'Write quality/docs-synthesize-trace.json with claims[]. Each claim must contain outputFile, claimText, sourceFile, and sourceSnippets[].',
      'Every claimText must appear in the output file. The sourceSnippets must exist in the cited source file.',
      'Do not invent generic enterprise-language conclusions that are not lexically grounded in the source snippets.'
    ],
    jsonExample: {
      profile: 'docs_synthesize',
      claims: [
        {
          outputFile: 'handbook/summary.md',
          claimText: 'keep onboarding friction low',
          sourceFile: 'source/product-strategy.md',
          sourceSnippets: ['keep onboarding friction low']
        }
      ]
    }
  },
  system_audit: {
    label: 'system_audit',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.system_audit,
    instructions: [
      'System facts must come from real host evidence, not estimates.',
      'Before claiming completion, write quality/system-audit.json and the report file referenced inside it.',
      'Write quality/system-audit.json with reportFile and facts[]. Each fact must include name, reportedValue, sourceInvocationId, and either sourceRegex or sourceContains.',
      'The report file must quote or restate the same facts with matching values and units.',
      'Recommendations may be inferred, but fact statements must be directly traceable to successful tool results.'
    ],
    jsonExample: {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'free_memory_kb',
          reportedValue: 8051548,
          sourceInvocationId: 'tool_invocation_id',
          sourceRegex: 'FreePhysicalMemory\\s*:\\s*(\\d+)',
          sourceContains: ['FreePhysicalMemory']
        }
      ]
    }
  },
  desktop_observation: {
    label: 'desktop_observation',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.desktop_observation,
    instructions: [
      'Desktop and application observations must come from real host command evidence, not estimates.',
      'Before claiming completion, write quality/desktop-observation.json and the report file referenced inside it.',
      'Write quality/desktop-observation.json with reportFile and observations[]. Each observation must include name, reportedValue, sourceInvocationId, and either sourceRegex or sourceContains.',
      'At least one cited command must observe desktop-facing process or window state, such as Get-Process with ProcessName, Responding, or MainWindowTitle.',
      'The report file must quote or restate the same desktop/application observations with matching values.'
    ],
    jsonExample: {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [
        {
          name: 'desktop_process',
          reportedValue: 'explorer',
          sourceInvocationId: 'tool_invocation_id',
          sourceContains: ['ProcessName', 'explorer']
        }
      ]
    }
  },
  database_near_mysql_design: {
    label: 'database_near_mysql_design',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.database_near_mysql_design,
    instructions: [
      'Design a MySQL-like OLTP database with real module depth, not a README-only scaffold.',
      'Before claiming completion, write quality/database-design.json describing the actual delivered design files and prototype modules.',
      'Write quality/database-design.json with designFiles, prototypeFiles, implementedModules, and claimBoundaries.',
      'Before claiming completion, run a real benchmark dry-run from database-lab/prototype and keep the successful tool evidence.',
      'Implemented modules must point to real prototype source files. Do not claim MySQL-level performance as proven.',
      'The design corpus must cover storage layout, indexing, transactions or concurrency control, WAL or recovery, cache or buffer behavior, SQL compatibility, and benchmark planning.'
    ],
    jsonExample: {
      profile: 'database_near_mysql_design',
      designFiles: [
        'database-lab/design/README.md',
        'database-lab/design/architecture.md',
        'database-lab/design/storage-engine.md',
        'database-lab/design/sql-compatibility.md',
        'database-lab/design/benchmark-plan.md',
      ],
      prototypeFiles: [
        'database-lab/prototype/package.json',
        'database-lab/prototype/README.md',
        'database-lab/prototype/scripts/bench.js',
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/b-plus-tree-index.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/transaction-manager.js',
      ],
      implementedModules: [
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
        'database-lab/prototype/src/b-plus-tree-index.js',
        'database-lab/prototype/src/wal-manager.js',
        'database-lab/prototype/src/transaction-manager.js',
      ],
      claimBoundaries: [
        'Implemented: logical page layout, index and WAL skeletons, transaction flow, and benchmark scaffold',
        'Unproven: performance parity with MySQL'
      ]
    }
  },
  database_near_mysql_verify: {
    label: 'database_near_mysql_verify',
    requiredEvidenceFile: QUALITY_EVIDENCE_FILES.database_near_mysql_verify,
    instructions: [
      'Verify the database prototype with a real benchmark scaffold or dry-run command.',
      'Before claiming completion, write quality/database-benchmark-result.json and the referenced benchmark result file.',
      'Write quality/database-benchmark-result.json with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary.',
      'The benchmark command must actually run through a successful tool invocation, and the resultFile must exist.',
      'Updated docs must distinguish implemented prototype behavior from any MySQL-parity goal that is still unproven.'
    ],
    jsonExample: {
      profile: 'database_near_mysql_verify',
      benchmarkCommand: 'npm run bench -- --dry-run',
      sourceInvocationId: 'tool_invocation_id',
      resultFile: 'database-lab/prototype/results/bench-dry-run.json',
      updatedDocs: ['database-lab/design/benchmark-plan.md'],
      implementedModules: [
        'database-lab/prototype/src/storage-engine.js',
        'database-lab/prototype/src/buffer-pool.js',
      ],
      verificationSummary: 'Dry-run benchmark completed; MySQL-nearness remains unproven.'
    }
  }
};

const MOJIBAKE_PATTERN = /(?:\uFFFD|Ã.|Â.|â.|鈥|锟|�)/;
const PLACEHOLDER_COPY_PATTERN = /\b(?:lorem ipsum|sample copy|placeholder|my blog|feature\s+\d+|requirement\s+[A-Z])\b/i;
const STUB_CODE_PATTERN = /\b(?:todo|stub|not implemented|placeholder implementation|throw new Error\(['"`]not implemented)/i;
const GENERIC_SYNTHESIS_PATTERN = /\b(?:user-centric design|scalable architecture|best-in-class|enterprise-grade|robust platform)\b/i;
const BENCH_STACK_RISK_PATTERN = /push\(\s*\.\.\.[^)]*latenc|Math\.(?:min|max)\(\s*\.\.\.[^)]+\)/i;
const DATABASE_LAB_CORE_IMPLEMENTED_MODULES = [
  'database-lab/prototype/src/storage-engine.js',
  'database-lab/prototype/src/buffer-pool.js',
  'database-lab/prototype/src/b-plus-tree-index.js',
  'database-lab/prototype/src/wal-manager.js',
  'database-lab/prototype/src/transaction-manager.js',
];
const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'with', 'this', 'these', 'those', 'into', 'than', 'then'
]);

function stripJavaScriptComments(sourceText: string): string {
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

    if (!inDoubleQuote && !inTemplateLiteral && current === '\'') {
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

function extractVisibleWebText(filePath: string, content: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  if (extension === '.md' || extension === '.markdown' || extension === '.txt') {
    return content;
  }
  return '';
}

function getJavaScriptSyntaxError(content: string): string | null {
  try {
    // Parse only. The Function constructor validates syntax without executing the artifact.
    // eslint-disable-next-line no-new-func
    new Function(content);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function getImplementationCodeForQualityChecks(content: string): string {
  return stripJavaScriptComments(content).trim();
}

function hasStubLikeImplementation(content: string): boolean {
  const codeOnly = getImplementationCodeForQualityChecks(content);
  if (STUB_CODE_PATTERN.test(codeOnly)) {
    return true;
  }
  return codeOnly.length === 0 && STUB_CODE_PATTERN.test(content);
}

function isShallowImplementation(content: string, minimumLength = 180): boolean {
  return getImplementationCodeForQualityChecks(content).length < minimumLength;
}

function addUnique(target: string[], values: Array<string | null | undefined>): void {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || target.includes(normalized)) {
      continue;
    }
    target.push(normalized);
  }
}

function readTextIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

interface JsonEvidenceReadResult {
  status: 'missing' | 'invalid' | 'valid';
  value: Record<string, unknown> | null;
  parseError: string | null;
}

function readJsonEvidence(filePath: string): JsonEvidenceReadResult {
  const text = readTextIfExists(filePath);
  if (!text) {
    return {
      status: 'missing',
      value: null,
      parseError: null
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        status: 'valid',
        value: parsed as Record<string, unknown>,
        parseError: null
      };
    }
    return {
      status: 'invalid',
      value: null,
      parseError: 'Expected a JSON object.'
    };
  } catch (error) {
    return {
      status: 'invalid',
      value: null,
      parseError: error instanceof Error ? error.message : 'Unknown JSON parse failure.'
    };
  }
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function resolveFilePath(workspaceDir: string, filePath: string): string {
  if (!filePath.trim()) {
    return path.resolve(workspaceDir);
  }
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceDir, filePath);
}

function listFilesRecursive(rootDir: string): string[] {
  try {
    if (!fs.existsSync(rootDir)) {
      return [];
    }
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const files: string[] = [];
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

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function extractBenchPrototypeModuleDependencies(benchScript: string): string[] {
  const dependencies: string[] = [];
  const scriptsDir = 'database-lab/prototype/scripts';
  const patterns = [
    /require\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
    /from\s+['"`](\.\.?\/[^'"`]+)['"`]/g,
    /import\(\s*['"`](\.\.?\/[^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(benchScript)) !== null) {
      const specifier = match[1]?.trim();
      if (!specifier) {
        continue;
      }
      let normalizedPath = normalizeRelativePath(path.posix.normalize(path.posix.join(scriptsDir, specifier)));
      if (!normalizedPath.startsWith('database-lab/prototype/src/')) {
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

function extractToolText(invocation: Pick<ToolInvocationRecord, 'result' | 'error'>): string {
  const chunks: string[] = [];
  if (invocation.error) {
    chunks.push(invocation.error);
  }
  const result = invocation.result;
  if (!result || typeof result !== 'object') {
    return chunks.join('\n');
  }
  const stack: unknown[] = [result];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      chunks.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (!current || typeof current !== 'object') {
      continue;
    }
    for (const value of Object.values(current)) {
      stack.push(value);
    }
  }
  return chunks.join('\n');
}

function normalizeAuditEvidenceText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractAuditGroundingTokens(value: unknown): string[] {
  const text = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number').join(' ')
        : '';
  const normalized = normalizeAuditEvidenceText(text);
  const tokens = normalized.match(/[a-z0-9]+(?:[._:-][a-z0-9]+)*/g) ?? [];
  const weakTokens = new Set(['build', 'version', 'caption', 'status', 'system', 'memory', 'total', 'free']);
  return [...new Set(tokens.filter((token) => {
    if (token.length < 3 && !/\d/.test(token)) {
      return false;
    }
    if (weakTokens.has(token)) {
      return false;
    }
    return true;
  }))];
}

function isReportedValueGroundedInToolText(reportedValue: unknown, toolText: string): boolean {
  const normalizedToolText = normalizeAuditEvidenceText(toolText);
  const tokens = extractAuditGroundingTokens(reportedValue);
  if (tokens.length === 0) {
    return false;
  }
  const numericTokens = tokens.filter((token) => /\d/.test(token));
  if (numericTokens.length > 0) {
    return numericTokens.every((token) => normalizedToolText.includes(token));
  }
  const matchingTextTokens = tokens.filter((token) => normalizedToolText.includes(token));
  return matchingTextTokens.length >= 2 || matchingTextTokens.some((token) => token.length >= 8);
}

function isDatabaseLabBenchmarkInvocation(
  invocation: Pick<ToolInvocationRecord, 'toolId' | 'metadata' | 'result' | 'error'>
): boolean {
  if (invocation.toolId !== 'run_command') {
    return false;
  }
  const metadataText = invocation.metadata && typeof invocation.metadata === 'object'
    ? JSON.stringify(invocation.metadata)
    : '';
  const combined = `${extractToolText(invocation)}\n${metadataText}`.toLowerCase();
  return /(database-lab[\\/]prototype|npm run (bench|dry-run|build)|node scripts[\\/]bench\.js|bench\.js --dry-run|dry-run benchmark|dry run benchmark)/i.test(combined);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token));
}

function computeLexicalOverlap(sourceText: string, targetText: string): number {
  const sourceTokens = new Set(tokenize(sourceText));
  const targetTokens = new Set(tokenize(targetText));
  if (sourceTokens.size === 0 || targetTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of targetTokens) {
    if (sourceTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(targetTokens.size, 1);
}

function normalizeMarkdownTextForEvidence(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeEvidenceToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) {
    return token.slice(0, -3);
  }
  if (token.length > 4 && token.endsWith('ed')) {
    return token.slice(0, -2);
  }
  return token;
}

function evidenceTextContainsClaim(outputContent: string, claimText: string): boolean {
  const normalizedOutput = normalizeMarkdownTextForEvidence(outputContent);
  const normalizedClaim = normalizeMarkdownTextForEvidence(claimText);
  if (!normalizedClaim) {
    return false;
  }
  if (normalizedOutput.includes(normalizedClaim)) {
    return true;
  }
  const outputTokens = new Set(
    normalizedOutput
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeEvidenceToken)
  );
  const claimTokens = normalizedClaim
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeEvidenceToken);
  return claimTokens.length > 0 && claimTokens.every((token) => outputTokens.has(token));
}

function findSuccessfulInvocation(
  input: TaskQualityEvaluationInput,
  invocationId: string
): Pick<ToolInvocationRecord, 'invocationId' | 'toolId' | 'status' | 'unitId' | 'arguments' | 'startedAt' | 'endedAt' | 'result' | 'error' | 'metadata'> | null {
  return input.toolInvocations.find((invocation) => invocation.invocationId === invocationId && invocation.status === 'SUCCEEDED') ?? null;
}

function getInvocationCompletedAt(
  invocation: TaskQualityEvaluationInput['toolInvocations'][number]
): number {
  if (typeof invocation.endedAt === 'number' && Number.isFinite(invocation.endedAt)) {
    return invocation.endedAt;
  }
  if (typeof invocation.startedAt === 'number' && Number.isFinite(invocation.startedAt)) {
    return invocation.startedAt;
  }
  return 0;
}

function tryParseJsonFromCommandStdout(stdoutText: string | null | undefined): {
  parsed: Record<string, unknown> | null;
  parseError: string | null;
} {
  const trimmed = typeof stdoutText === 'string' ? stdoutText.trim() : '';
  if (!trimmed) {
    return { parsed: null, parseError: 'stdout_empty' };
  }
  const braceIndexes: number[] = [];
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
        return {
          parsed: parsed as Record<string, unknown>,
          parseError: null,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { parsed: null, parseError: 'stdout_json_parse_failed' };
}

function evaluateSuccessfulBenchmarkInvocation(
  invocation: TaskQualityEvaluationInput['toolInvocations'][number]
): {
  passed: boolean;
  parseError: string | null;
  hasRequiredMetrics: boolean;
} {
  const result = invocation.result && typeof invocation.result === 'object'
    ? invocation.result as Record<string, unknown>
    : null;
  const stdout = typeof result?.stdout === 'string' ? result.stdout : null;
  const stderr = typeof result?.stderr === 'string' ? result.stderr : null;
  const { parsed, parseError } = tryParseJsonFromCommandStdout(stdout);
  const metrics = parsed && typeof parsed.metrics === 'object' && parsed.metrics
    ? parsed.metrics as Record<string, unknown>
    : null;
  const hasRequiredMetrics =
    !!metrics
    && ['pagesWritten', 'pagesRead', 'writeDurationMs', 'readDurationMs', 'totalDurationMs']
      .every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key] as number));
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
    passed: invocation.status === 'SUCCEEDED' && !stderrLooksFatal && !stdoutLooksFatal && statusAcceptable && hasRequiredMetrics,
    parseError,
    hasRequiredMetrics,
  };
}

function normalizeRelativeToolPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function getWriteFileTargetPath(
  invocation: TaskQualityEvaluationInput['toolInvocations'][number]
): string | null {
  if (invocation.toolId !== 'write_file' || invocation.status !== 'SUCCEEDED') {
    return null;
  }
  const resultPath = invocation.result && typeof invocation.result.path === 'string'
    ? invocation.result.path
    : null;
  const argumentPath = invocation.arguments && typeof invocation.arguments.path === 'string'
    ? invocation.arguments.path
    : null;
  const resolved = resultPath ?? argumentPath;
  return resolved ? normalizeRelativeToolPath(resolved) : null;
}

function getLatestSuccessfulWriteCompletedAt(
  input: TaskQualityEvaluationInput,
  relativePaths: string[]
): number | null {
  const pathSet = new Set(relativePaths.map((entry) => normalizeRelativeToolPath(entry)));
  let latest: number | null = null;
  for (const invocation of input.toolInvocations) {
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

function createNotApplicableResult(): TaskQualityEvaluationResult {
  return {
    profileId: null,
    verdict: 'not_applicable',
    passedChecks: [],
    failedChecks: [],
    requiredNextEvidence: [],
    lastEvaluatedAt: null
  };
}

function createResult(params: {
  profileId: QualityProfileId;
  passedChecks: string[];
  failedChecks: string[];
  requiredNextEvidence: string[];
}): TaskQualityEvaluationResult {
  return {
    profileId: params.profileId,
    verdict: params.failedChecks.length === 0 ? 'passed' : 'failed',
    passedChecks: [...params.passedChecks],
    failedChecks: [...params.failedChecks],
    requiredNextEvidence: [...params.requiredNextEvidence],
    lastEvaluatedAt: Date.now()
  };
}

function evaluateWebExperience(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const auditPath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.web_experience);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    return createResult({
      profileId: 'web_experience',
      passedChecks,
      failedChecks: ['missing_web_audit'],
      requiredNextEvidence: ['write quality/web-audit.json']
    });
  }
  if (auditRead.status === 'invalid') {
    return createResult({
      profileId: 'web_experience',
      passedChecks,
      failedChecks: ['invalid_web_audit_json'],
      requiredNextEvidence: [`repair quality/web-audit.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]
    });
  }
  const audit = auditRead.value!;
  passedChecks.push('web_audit_present');
  const entryFiles = getStringArray(audit.entryFiles);
  const supportingFiles = getStringArray(audit.supportingFiles);
  const interactionSelectors = getStringArray(audit.interactionSelectors);
  const artifactKind = typeof audit.artifactKind === 'string' ? audit.artifactKind : 'static_site';
  if (entryFiles.length === 0) {
    failedChecks.push('missing_entry_files');
    requiredNextEvidence.push('list entryFiles in quality/web-audit.json');
  }
  if (interactionSelectors.length === 0) {
    failedChecks.push('missing_interaction_selectors');
    requiredNextEvidence.push('record at least one visible interaction in quality/web-audit.json');
  }
  const filesToInspect = [...entryFiles, ...supportingFiles].map((filePath) => resolveFilePath(input.workspaceDir, filePath));
  let hasInteractiveCode = false;
  for (const filePath of filesToInspect) {
    const content = readTextIfExists(filePath);
    if (!content) {
      failedChecks.push(`missing_artifact:${normalizeRelativePath(filePath)}`);
      continue;
    }
    if (MOJIBAKE_PATTERN.test(content)) {
      failedChecks.push(`encoding_issue:${normalizeRelativePath(filePath)}`);
    }
    const visibleCopy = extractVisibleWebText(filePath, content);
    if (visibleCopy && PLACEHOLDER_COPY_PATTERN.test(visibleCopy)) {
      failedChecks.push(`placeholder_copy:${normalizeRelativePath(filePath)}`);
    }
    if (/\.(?:cjs|mjs|js)$/i.test(filePath)) {
      const syntaxError = getJavaScriptSyntaxError(content);
      if (syntaxError) {
        failedChecks.push(`javascript_syntax_error:${normalizeRelativePath(filePath)}`);
        requiredNextEvidence.push(`repair JavaScript syntax in ${normalizeRelativePath(filePath)} (${syntaxError})`);
      }
    }
    if (/<button|<input|addEventListener|onclick=|onchange=/i.test(content)) {
      hasInteractiveCode = true;
    }
  }
  if (hasInteractiveCode) {
    passedChecks.push('visible_interaction_detected');
  } else {
    failedChecks.push('missing_visible_interaction');
    requiredNextEvidence.push('ship a real interaction and list it in interactionSelectors');
  }
  if (artifactKind === 'node_project') {
    const packagePath = filesToInspect.find((filePath) => filePath.endsWith('package.json'));
    const packageJsonRead = packagePath ? readJsonEvidence(packagePath) : null;
    const packageJson = packageJsonRead?.status === 'valid' ? packageJsonRead.value : null;
    const scripts = packageJson && packageJson.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts as Record<string, unknown>
      : null;
    if (!packageJson || !scripts || (!scripts.build && !scripts.dev && !scripts.preview)) {
      failedChecks.push('node_project_missing_scripts');
      requiredNextEvidence.push('include package.json scripts for build/dev/preview');
    } else {
      passedChecks.push('node_project_scripts_present');
    }
  }
  return createResult({
    profileId: 'web_experience',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateDocsNormalize(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const tracePath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.docs_normalize);
  const traceRead = readJsonEvidence(tracePath);
  if (traceRead.status === 'missing') {
    return createResult({
      profileId: 'docs_normalize',
      passedChecks,
      failedChecks: ['missing_docs_normalize_trace'],
      requiredNextEvidence: ['write quality/docs-normalize-trace.json with source/output mappings']
    });
  }
  if (traceRead.status === 'invalid') {
    return createResult({
      profileId: 'docs_normalize',
      passedChecks,
      failedChecks: ['invalid_docs_normalize_trace_json'],
      requiredNextEvidence: [`repair quality/docs-normalize-trace.json so it is valid JSON (${traceRead.parseError ?? 'parse failure'})`]
    });
  }
  const trace = traceRead.value!;
  const mappings = Array.isArray(trace.mappings) ? trace.mappings as Array<Record<string, unknown>> : [];
  if (mappings.length === 0) {
    failedChecks.push('empty_docs_normalize_trace');
    requiredNextEvidence.push('add mappings[] to quality/docs-normalize-trace.json');
  }
  for (const mapping of mappings) {
    const sourceFile = typeof mapping.sourceFile === 'string' ? mapping.sourceFile : '';
    const outputFile = typeof mapping.outputFile === 'string' ? mapping.outputFile : '';
    const snippets = getStringArray(mapping.sourceSnippets);
    const sourceContent = sourceFile ? readTextIfExists(resolveFilePath(input.workspaceDir, sourceFile)) : null;
    const outputContent = outputFile ? readTextIfExists(resolveFilePath(input.workspaceDir, outputFile)) : null;
    if (!sourceContent) {
      failedChecks.push(`missing_source:${sourceFile || 'unknown'}`);
      continue;
    }
    if (!outputContent) {
      failedChecks.push(`missing_output:${outputFile || 'unknown'}`);
      continue;
    }
    if (PLACEHOLDER_COPY_PATTERN.test(outputContent)) {
      failedChecks.push(`template_placeholder_detected:${outputFile}`);
    }
    const validSourceSnippets = snippets.filter((snippet) => sourceContent.includes(snippet));
    if (validSourceSnippets.length === 0) {
      failedChecks.push(`trace_not_grounded:${outputFile}`);
      requiredNextEvidence.push(`repair sourceSnippets for ${outputFile} so they are copied from ${sourceFile}`);
      continue;
    }
    if (!validSourceSnippets.some((snippet) => outputContent.includes(snippet))) {
      failedChecks.push(`output_lost_source_phrasing:${outputFile}`);
      requiredNextEvidence.push(`preserve concrete source wording in ${outputFile}`);
      continue;
    }
    passedChecks.push(`grounded:${outputFile}`);
  }
  const normalizedOutputFiles = Array.from(new Set(
    mappings
      .map((mapping) => (typeof mapping.outputFile === 'string' ? mapping.outputFile : ''))
      .filter((outputFile) => outputFile.startsWith('normalized/') && outputFile.endsWith('.md') && outputFile !== 'normalized/index.md'),
  ));
  const normalizedIndexPath = 'normalized/index.md';
  const normalizedIndexContent = readTextIfExists(resolveFilePath(input.workspaceDir, normalizedIndexPath));
  if (normalizedIndexContent || normalizedOutputFiles.length >= 3) {
    if (!normalizedIndexContent) {
      failedChecks.push('missing_docs_normalize_index');
      requiredNextEvidence.push('write normalized/index.md with links to every normalized markdown file');
    } else {
      const missingIndexLinks = normalizedOutputFiles.filter((outputFile) => !normalizedIndexContent.includes(path.basename(outputFile)));
      if (missingIndexLinks.length > 0) {
        failedChecks.push('docs_normalize_index_missing_links');
        requiredNextEvidence.push(`update normalized/index.md to link to: ${missingIndexLinks.join(', ')}`);
      } else {
        passedChecks.push('docs_normalize_index_links_complete');
      }
    }
    const crossReferenceCount = normalizedOutputFiles.reduce((count, outputFile) => {
      const outputContent = readTextIfExists(resolveFilePath(input.workspaceDir, outputFile));
      if (!outputContent) {
        return count;
      }
      return count + (/\[[^\]]+\]\([^)\n]+\.md\)/i.test(outputContent) ? 1 : 0);
    }, 0);
    if (crossReferenceCount < Math.min(2, normalizedOutputFiles.length)) {
      failedChecks.push('docs_normalize_missing_markdown_cross_references');
      requiredNextEvidence.push('add real markdown cross-links between at least two normalized/*.md files');
    } else {
      passedChecks.push(`docs_normalize_markdown_cross_references:${crossReferenceCount}`);
    }
  }
  return createResult({
    profileId: 'docs_normalize',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateDocsSynthesize(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const tracePath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.docs_synthesize);
  const traceRead = readJsonEvidence(tracePath);
  if (traceRead.status === 'missing') {
    return createResult({
      profileId: 'docs_synthesize',
      passedChecks,
      failedChecks: ['missing_docs_synthesis_trace'],
      requiredNextEvidence: ['write quality/docs-synthesize-trace.json with claim-level grounding']
    });
  }
  if (traceRead.status === 'invalid') {
    return createResult({
      profileId: 'docs_synthesize',
      passedChecks,
      failedChecks: ['invalid_docs_synthesis_trace_json'],
      requiredNextEvidence: [`repair quality/docs-synthesize-trace.json so it is valid JSON (${traceRead.parseError ?? 'parse failure'})`]
    });
  }
  const trace = traceRead.value!;
  const claims = Array.isArray(trace.claims) ? trace.claims as Array<Record<string, unknown>> : [];
  if (claims.length === 0) {
    failedChecks.push('empty_docs_synthesis_trace');
    requiredNextEvidence.push('add claims[] to quality/docs-synthesize-trace.json');
  }
  for (const claim of claims) {
    const outputFile = typeof claim.outputFile === 'string' ? claim.outputFile : '';
    const sourceFile = typeof claim.sourceFile === 'string' ? claim.sourceFile : '';
    const claimText = typeof claim.claimText === 'string' ? claim.claimText.trim() : '';
    const sourceSnippets = getStringArray(claim.sourceSnippets);
    const outputContent = outputFile ? readTextIfExists(resolveFilePath(input.workspaceDir, outputFile)) : null;
    const sourceContent = sourceFile ? readTextIfExists(resolveFilePath(input.workspaceDir, sourceFile)) : null;
    if (!outputContent || !sourceContent || !claimText) {
      failedChecks.push(`invalid_claim_mapping:${outputFile || sourceFile || 'unknown'}`);
      continue;
    }
    if (!evidenceTextContainsClaim(outputContent, claimText)) {
      failedChecks.push(`claim_missing_from_output:${outputFile}`);
      continue;
    }
    const groundedSnippets = sourceSnippets.filter((snippet) => sourceContent.includes(snippet));
    if (groundedSnippets.length === 0) {
      failedChecks.push(`claim_missing_source_grounding:${outputFile}`);
      requiredNextEvidence.push(`add grounded sourceSnippets for ${claimText || outputFile}`);
      continue;
    }
    const overlap = computeLexicalOverlap(groundedSnippets.join(' '), claimText);
    if (overlap < 0.2 || GENERIC_SYNTHESIS_PATTERN.test(claimText)) {
      failedChecks.push(`claim_not_lexically_grounded:${outputFile}`);
      requiredNextEvidence.push(`tighten synthesized claim wording in ${outputFile} to match cited source language`);
      continue;
    }
    passedChecks.push(`claim_grounded:${outputFile}`);
  }
  return createResult({
    profileId: 'docs_synthesize',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateSystemAudit(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const auditPath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.system_audit);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    return createResult({
      profileId: 'system_audit',
      passedChecks,
      failedChecks: ['missing_system_audit_report'],
      requiredNextEvidence: ['write quality/system-audit.json with fact-to-tool mappings']
    });
  }
  if (auditRead.status === 'invalid') {
    return createResult({
      profileId: 'system_audit',
      passedChecks,
      failedChecks: ['invalid_system_audit_json'],
      requiredNextEvidence: [`repair quality/system-audit.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]
    });
  }
  const audit = auditRead.value!;
  const reportFile = typeof audit.reportFile === 'string' ? audit.reportFile : '';
  const reportContent = reportFile ? readTextIfExists(resolveFilePath(input.workspaceDir, reportFile)) : null;
  if (!reportContent) {
    failedChecks.push('missing_system_audit_report_file');
    requiredNextEvidence.push('write the referenced reportFile for the system audit');
  } else {
    passedChecks.push('system_audit_report_present');
  }
  const facts = Array.isArray(audit.facts) ? audit.facts as Array<Record<string, unknown>> : [];
  if (facts.length === 0) {
    failedChecks.push('missing_system_audit_facts');
    requiredNextEvidence.push('add facts[] to quality/system-audit.json');
  }
  for (const fact of facts) {
    const factName = typeof fact.name === 'string' ? fact.name : 'unknown_fact';
    const sourceInvocationId = typeof fact.sourceInvocationId === 'string' ? fact.sourceInvocationId : '';
    const invocation = sourceInvocationId ? findSuccessfulInvocation(input, sourceInvocationId) : null;
    if (!invocation) {
      failedChecks.push(`missing_tool_evidence:${factName}`);
      requiredNextEvidence.push(`cite a successful run_command invocation id for ${factName} in quality/system-audit.json`);
      continue;
    }
    const invocationCommand = typeof invocation.arguments?.command === 'string' ? invocation.arguments.command : '';
    if (
      /^(total_physical_memory_mb|free_physical_memory_mb)$/i.test(factName)
      && /(?:TotalVisibleMemorySize|FreePhysicalMemory)\s*\/\s*1MB/i.test(invocationCommand)
    ) {
      failedChecks.push(`memory_unit_mismatch_command:${factName}`);
      requiredNextEvidence.push(`rerun ${factName} with Win32_OperatingSystem values converted from KB to MB using /1024, not /1MB`);
      continue;
    }
    const toolText = extractToolText(invocation);
    const sourceContains = getStringArray(fact.sourceContains);
    const normalizedToolText = normalizeAuditEvidenceText(toolText);
    const sourceContainsMatched = sourceContains.length === 0
      || sourceContains.every((needle) => normalizedToolText.includes(normalizeAuditEvidenceText(needle)));
    if (!sourceContainsMatched && !isReportedValueGroundedInToolText(fact.reportedValue, toolText)) {
      failedChecks.push(`tool_output_mismatch:${factName}`);
      requiredNextEvidence.push(`repair quality/system-audit.json fact ${factName} so sourceInvocationId points to a successful run_command output containing: ${sourceContains.join(', ')}`);
      continue;
    } else if (!sourceContainsMatched) {
      passedChecks.push(`source_contains_value_grounded:${factName}`);
    }
    const regexSource = typeof fact.sourceRegex === 'string' ? fact.sourceRegex : '';
    if (regexSource) {
      try {
        const match = new RegExp(regexSource, 'm').exec(toolText);
        if (!match || !match[1]) {
          failedChecks.push(`tool_regex_unmatched:${factName}`);
          requiredNextEvidence.push(`repair sourceRegex or sourceInvocationId for ${factName} so the regex matches the cited successful tool output`);
          continue;
        }
        const reportedValue = fact.reportedValue;
        if (typeof reportedValue === 'number') {
          const observed = Number.parseFloat(match[1]);
          if (!Number.isFinite(observed)) {
            failedChecks.push(`tool_value_invalid:${factName}`);
            requiredNextEvidence.push(`repair sourceRegex for ${factName} so it captures a numeric value from the cited tool output`);
            continue;
          }
          const tolerance = Math.max(Math.abs(reportedValue) * 0.05, 1);
          if (Math.abs(observed - reportedValue) > tolerance) {
            failedChecks.push(`fact_value_mismatch:${factName}`);
            requiredNextEvidence.push(`repair reportedValue for ${factName} to equal the observed value captured from the cited tool output`);
            continue;
          }
        } else if (typeof reportedValue === 'string' && match[1].trim() !== reportedValue.trim()) {
          failedChecks.push(`fact_value_mismatch:${factName}`);
          requiredNextEvidence.push(`repair reportedValue for ${factName} to equal the observed value captured from the cited tool output`);
          continue;
        }
      } catch {
        failedChecks.push(`invalid_fact_regex:${factName}`);
        requiredNextEvidence.push(`repair sourceRegex for ${factName} so it is valid JavaScript regex syntax`);
        continue;
      }
    }
    if (reportContent) {
      const reportNeedles = Array.isArray(fact.reportedValue)
        ? fact.reportedValue.filter((entry): entry is string => typeof entry === 'string')
        : [String(fact.reportedValue ?? factName)];
      if (!reportNeedles.every((needle) => reportContent.includes(needle))) {
        failedChecks.push(`report_missing_fact:${factName}`);
        requiredNextEvidence.push(`update the system audit report so it includes the reported value for ${factName}`);
        continue;
      }
    }
    passedChecks.push(`fact_grounded:${factName}`);
  }
  return createResult({
    profileId: 'system_audit',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateDesktopObservation(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const auditPath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.desktop_observation);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    return createResult({
      profileId: 'desktop_observation',
      passedChecks,
      failedChecks: ['missing_desktop_observation_report'],
      requiredNextEvidence: ['write quality/desktop-observation.json with observation-to-tool mappings']
    });
  }
  if (auditRead.status === 'invalid') {
    return createResult({
      profileId: 'desktop_observation',
      passedChecks,
      failedChecks: ['invalid_desktop_observation_json'],
      requiredNextEvidence: [`repair quality/desktop-observation.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]
    });
  }

  const audit = auditRead.value!;
  const reportFile = typeof audit.reportFile === 'string' ? audit.reportFile : '';
  const reportContent = reportFile ? readTextIfExists(resolveFilePath(input.workspaceDir, reportFile)) : null;
  if (!reportContent) {
    failedChecks.push('missing_desktop_observation_report_file');
    requiredNextEvidence.push('write the referenced reportFile for the desktop observation');
  } else {
    passedChecks.push('desktop_observation_report_present');
  }

  const observationsSource = Array.isArray(audit.observations)
    ? audit.observations
    : (Array.isArray(audit.facts) ? audit.facts : []);
  const observations = observationsSource as Array<Record<string, unknown>>;
  if (observations.length === 0) {
    failedChecks.push('missing_desktop_observations');
    requiredNextEvidence.push('add observations[] to quality/desktop-observation.json');
  }

  let desktopEvidenceCount = 0;
  const desktopEvidencePattern = /\b(Get-Process|MainWindowTitle|ProcessName|Responding|explorer|Code|msedge|chrome|window|application)\b/i;
  for (const observation of observations) {
    const observationName = typeof observation.name === 'string' ? observation.name : 'unknown_observation';
    const sourceInvocationId = typeof observation.sourceInvocationId === 'string' ? observation.sourceInvocationId : '';
    const invocation = sourceInvocationId ? findSuccessfulInvocation(input, sourceInvocationId) : null;
    if (!invocation) {
      failedChecks.push(`missing_tool_evidence:${observationName}`);
      requiredNextEvidence.push(`cite a successful run_command invocation id for ${observationName} in quality/desktop-observation.json`);
      continue;
    }
    if (invocation.toolId !== 'run_command') {
      failedChecks.push(`wrong_tool_type:${observationName}`);
      requiredNextEvidence.push(`cite a successful run_command invocation id for ${observationName}, not ${invocation.toolId}`);
      continue;
    }
    const invocationCommand = typeof invocation.arguments?.command === 'string' ? invocation.arguments.command : '';
    const toolText = extractToolText(invocation);
    const combinedToolText = `${invocationCommand}\n${toolText}`;
    if (!desktopEvidencePattern.test(combinedToolText)) {
      failedChecks.push(`not_desktop_observation:${observationName}`);
      requiredNextEvidence.push(`cite a run_command output for ${observationName} that observes desktop or application state such as ProcessName, Responding, MainWindowTitle, explorer, Code, msedge, or chrome`);
      continue;
    }
    desktopEvidenceCount += 1;

    const sourceContains = getStringArray(observation.sourceContains);
    const normalizedToolText = normalizeAuditEvidenceText(combinedToolText);
    const sourceContainsMatched = sourceContains.length === 0
      || sourceContains.every((needle) => normalizedToolText.includes(normalizeAuditEvidenceText(needle)));
    if (!sourceContainsMatched && !isReportedValueGroundedInToolText(observation.reportedValue, combinedToolText)) {
      failedChecks.push(`tool_output_mismatch:${observationName}`);
      requiredNextEvidence.push(`repair quality/desktop-observation.json observation ${observationName} so sourceInvocationId points to a successful run_command output containing: ${sourceContains.join(', ')}`);
      continue;
    } else if (!sourceContainsMatched) {
      passedChecks.push(`source_contains_value_grounded:${observationName}`);
    }

    const regexSource = typeof observation.sourceRegex === 'string' ? observation.sourceRegex : '';
    if (regexSource) {
      try {
        const match = new RegExp(regexSource, 'm').exec(combinedToolText);
        if (!match || !match[1]) {
          failedChecks.push(`tool_regex_unmatched:${observationName}`);
          requiredNextEvidence.push(`repair sourceRegex or sourceInvocationId for ${observationName} so the regex matches the cited successful tool output`);
          continue;
        }
        const reportedValue = observation.reportedValue;
        if (typeof reportedValue === 'number') {
          const observed = Number.parseFloat(match[1]);
          if (!Number.isFinite(observed)) {
            failedChecks.push(`tool_value_invalid:${observationName}`);
            requiredNextEvidence.push(`repair sourceRegex for ${observationName} so it captures a numeric value from the cited tool output`);
            continue;
          }
          const tolerance = Math.max(Math.abs(reportedValue) * 0.05, 1);
          if (Math.abs(observed - reportedValue) > tolerance) {
            failedChecks.push(`fact_value_mismatch:${observationName}`);
            requiredNextEvidence.push(`repair reportedValue for ${observationName} to equal the observed value captured from the cited tool output`);
            continue;
          }
        } else if (typeof reportedValue === 'string' && match[1].trim() !== reportedValue.trim()) {
          failedChecks.push(`fact_value_mismatch:${observationName}`);
          requiredNextEvidence.push(`repair reportedValue for ${observationName} to equal the observed value captured from the cited tool output`);
          continue;
        }
      } catch {
        failedChecks.push(`invalid_observation_regex:${observationName}`);
        requiredNextEvidence.push(`repair sourceRegex for ${observationName} so it is valid JavaScript regex syntax`);
        continue;
      }
    }

    if (reportContent) {
      const reportNeedles = Array.isArray(observation.reportedValue)
        ? observation.reportedValue.filter((entry): entry is string => typeof entry === 'string')
        : [String(observation.reportedValue ?? observationName)];
      if (!reportNeedles.every((needle) => reportContent.includes(needle))) {
        failedChecks.push(`report_missing_observation:${observationName}`);
        requiredNextEvidence.push(`update the desktop observation report so it includes the reported value for ${observationName}`);
        continue;
      }
    }
    passedChecks.push(`desktop_observation_grounded:${observationName}`);
  }

  if (desktopEvidenceCount === 0 && observations.length > 0) {
    failedChecks.push('missing_desktop_process_or_window_evidence');
    requiredNextEvidence.push('run a desktop/application observation command such as Get-Process selecting ProcessName, Responding, and MainWindowTitle');
  }

  return createResult({
    profileId: 'desktop_observation',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateDatabaseDesign(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const auditPath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.database_near_mysql_design);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    return createResult({
      profileId: 'database_near_mysql_design',
      passedChecks,
      failedChecks: ['missing_database_design_manifest'],
      requiredNextEvidence: ['write quality/database-design.json with designFiles and implementedModules']
    });
  }
  if (auditRead.status === 'invalid') {
    return createResult({
      profileId: 'database_near_mysql_design',
      passedChecks,
      failedChecks: ['invalid_database_design_manifest_json'],
      requiredNextEvidence: [`repair quality/database-design.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]
    });
  }
  const audit = auditRead.value!;
  const designFiles = getStringArray(audit.designFiles);
  const prototypeFiles = getStringArray(audit.prototypeFiles);
  const implementedModules = getStringArray(audit.implementedModules);
  const prototypeSrcFiles = listFilesRecursive(resolveFilePath(input.workspaceDir, 'database-lab/prototype/src'));
  const requiredFiles = [
    'database-lab/design/README.md',
    'database-lab/design/architecture.md',
    'database-lab/design/storage-engine.md',
    'database-lab/design/sql-compatibility.md',
    'database-lab/design/benchmark-plan.md',
    'database-lab/prototype/package.json',
    'database-lab/prototype/README.md',
    'database-lab/prototype/scripts/bench.js'
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
  const designCorpus = [...new Set([...requiredFiles.filter((item) => item.startsWith('database-lab/design/')), ...designFiles])]
    .map((relativePath) => readTextIfExists(resolveFilePath(input.workspaceDir, relativePath)) ?? '')
    .join('\n');
  const keywordGroups = [
    ['storage', 'page', 'segment'],
    ['index', 'btree', 'hash'],
    ['transaction', 'concurrency', 'lock', 'mvcc'],
    ['wal', 'recovery', 'checkpoint'],
    ['buffer', 'cache'],
    ['sql', 'parser', 'planner'],
    ['benchmark', 'latency', 'throughput', 'tps']
  ];
  for (const [index, group] of keywordGroups.entries()) {
    if (!group.some((token) => designCorpus.toLowerCase().includes(token))) {
      failedChecks.push(`design_coverage_gap:${index + 1}`);
      requiredNextEvidence.push(`cover database design topic group ${index + 1}: ${group.join('/')}`);
    }
  }
  const benchScript = readTextIfExists(resolveFilePath(input.workspaceDir, 'database-lab/prototype/scripts/bench.js')) ?? '';
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
    requiredNextEvidence.push('wire database-lab/prototype/scripts/bench.js to real modules under database-lab/prototype/src/ instead of placeholder-only logic');
  }
  if (implementedModules.length < DATABASE_LAB_CORE_IMPLEMENTED_MODULES.length) {
    failedChecks.push('insufficient_implemented_modules');
    requiredNextEvidence.push(`ship the full core prototype module set and list it in implementedModules: ${DATABASE_LAB_CORE_IMPLEMENTED_MODULES.join(', ')}`);
  }
  if (prototypeSrcFiles.length === 0) {
    failedChecks.push('missing_prototype_src_modules');
    requiredNextEvidence.push('write real implementation files under database-lab/prototype/src/');
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
    if (!modulePath.startsWith('database-lab/prototype/src/')) {
      failedChecks.push(`implemented_module_outside_prototype_src:${modulePath}`);
      requiredNextEvidence.push(`move or rewrite ${modulePath} under database-lab/prototype/src/`);
      continue;
    }
    const content = readTextIfExists(resolveFilePath(input.workspaceDir, modulePath));
    if (!content) {
      addUnique(failedChecks, [`manifest_references_missing_implemented_module:${modulePath}`]);
      addUnique(requiredNextEvidence, [`repair quality/database-design.json implementedModules so it matches real files under database-lab/prototype/src/, or write ${modulePath} if it is truly implemented`]);
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
  const prototypeReadme = readTextIfExists(resolveFilePath(input.workspaceDir, 'database-lab/prototype/README.md')) ?? '';
  if (/no actual database functionality is implemented/i.test(prototypeReadme)) {
    failedChecks.push('prototype_self_declares_stub_only');
    requiredNextEvidence.push('update prototype README after implementing runnable database behavior');
  }
  if (!/result|metric|latency|throughput|benchmark/i.test(benchScript)) {
    failedChecks.push('benchmark_scaffold_missing_metrics');
    requiredNextEvidence.push('implement benchmark metrics in database-lab/prototype/scripts/bench.js');
  } else {
    passedChecks.push('benchmark_scaffold_present');
  }
  const missingRequiredBenchMetricKeys = requiredBenchMetricKeys.filter((token) => !benchScript.includes(token));
  if (benchScript && missingRequiredBenchMetricKeys.length > 0) {
    failedChecks.push('benchmark_scaffold_missing_required_metric_keys');
    requiredNextEvidence.push(`ensure database-lab/prototype/scripts/bench.js emits metrics keys ${missingRequiredBenchMetricKeys.join(', ')}`);
  }
  if (/(new\s+Worker|worker_threads)/i.test(benchScript) && BENCH_STACK_RISK_PATTERN.test(benchScript)) {
    failedChecks.push('benchmark_scaffold_stack_risk');
    requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so worker latency results are aggregated without spread-pushing large arrays');
  }
  const benchmarkInvocations = input.toolInvocations
    .filter((invocation) => isDatabaseLabBenchmarkInvocation(invocation))
    .sort((left, right) => getInvocationCompletedAt(right) - getInvocationCompletedAt(left));
  const latestBenchmarkInvocation = benchmarkInvocations[0] ?? null;
  const latestBenchmarkSensitiveWriteAt = getLatestSuccessfulWriteCompletedAt(input, [
    'database-lab/prototype/package.json',
    'database-lab/prototype/scripts/bench.js',
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
    requiredNextEvidence.push('run a successful dry-run benchmark command from database-lab/prototype and keep its tool evidence');
  } else if (!benchmarkSelfCheckGrounded) {
    failedChecks.push('benchmark_self_check_not_grounded');
    requiredNextEvidence.push('rerun the dry-run benchmark only after database-lab/prototype/src contains real modules and database-lab/prototype/scripts/bench.js imports them directly');
  } else if (
    latestBenchmarkSensitiveWriteAt !== null
    && getInvocationCompletedAt(latestBenchmarkInvocation) < latestBenchmarkSensitiveWriteAt
  ) {
    failedChecks.push('benchmark_self_check_stale');
    requiredNextEvidence.push('rerun a successful dry-run benchmark command from database-lab/prototype after the latest bench.js or prototype/src changes');
  } else if (latestBenchmarkInvocation.status === 'SUCCEEDED') {
    const benchmarkEvaluation = evaluateSuccessfulBenchmarkInvocation(latestBenchmarkInvocation);
    if (benchmarkEvaluation.passed) {
      passedChecks.push('benchmark_self_check_evidence_present');
    } else if (!benchmarkEvaluation.hasRequiredMetrics) {
      failedChecks.push('benchmark_self_check_missing_required_metrics');
      requiredNextEvidence.push('repair database-lab/prototype/scripts/bench.js so the successful dry-run stdout includes metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, totalDurationMs, then rerun the benchmark');
    } else {
      failedChecks.push('benchmark_self_check_output_invalid');
      requiredNextEvidence.push(`repair database-lab/prototype/scripts/bench.js so the successful dry-run stdout is one parseable JSON object with top-level status, summary, and metrics keys, then rerun the benchmark (${benchmarkEvaluation.parseError ?? 'stdout parse failure'})`);
    }
  } else {
    failedChecks.push('benchmark_self_check_failed');
    requiredNextEvidence.push('repair the benchmark scaffold and rerun a successful dry-run benchmark command from database-lab/prototype');
  }
  return createResult({
    profileId: 'database_near_mysql_design',
    passedChecks,
    failedChecks,
    requiredNextEvidence
  });
}

function evaluateDatabaseVerify(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const requiredNextEvidence: string[] = [];
  const baseDesign = evaluateDatabaseDesign({
    ...input,
    qualityProfileId: 'database_near_mysql_design'
  });
  if (baseDesign.verdict === 'failed') {
    addUnique(failedChecks, baseDesign.failedChecks);
    addUnique(requiredNextEvidence, baseDesign.requiredNextEvidence);
  } else {
    addUnique(passedChecks, baseDesign.passedChecks);
  }
  const auditPath = resolveFilePath(input.workspaceDir, QUALITY_EVIDENCE_FILES.database_near_mysql_verify);
  const auditRead = readJsonEvidence(auditPath);
  if (auditRead.status === 'missing') {
    addUnique(failedChecks, ['missing_database_benchmark_result']);
    addUnique(requiredNextEvidence, ['write quality/database-benchmark-result.json with resultFile and sourceInvocationId']);
    return createResult({
      profileId: 'database_near_mysql_verify',
      passedChecks,
      failedChecks,
      requiredNextEvidence
    });
  }
  if (auditRead.status === 'invalid') {
    addUnique(failedChecks, ['invalid_database_benchmark_result_json']);
    addUnique(requiredNextEvidence, [`repair quality/database-benchmark-result.json so it is valid JSON (${auditRead.parseError ?? 'parse failure'})`]);
    return createResult({
      profileId: 'database_near_mysql_verify',
      passedChecks,
      failedChecks,
      requiredNextEvidence
    });
  }
  const audit = auditRead.value!;
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
    if (!modulePath.startsWith('database-lab/prototype/src/')) {
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
    requiredNextEvidence
  });
}

export function evaluateTaskQuality(input: TaskQualityEvaluationInput): TaskQualityEvaluationResult {
  switch (input.qualityProfileId ?? null) {
    case null:
    case undefined:
      return createNotApplicableResult();
    case 'web_experience':
      return evaluateWebExperience(input);
    case 'docs_normalize':
      return evaluateDocsNormalize(input);
    case 'docs_synthesize':
      return evaluateDocsSynthesize(input);
    case 'system_audit':
      return evaluateSystemAudit(input);
    case 'desktop_observation':
      return evaluateDesktopObservation(input);
    case 'database_near_mysql_design':
      return evaluateDatabaseDesign(input);
    case 'database_near_mysql_verify':
      return evaluateDatabaseVerify(input);
    default:
      return createNotApplicableResult();
  }
}

export function getQualityProfilePromptSection(profileId: QualityProfileId | null | undefined): string[] {
  if (!profileId) {
    return [];
  }
  const spec = PROMPT_SPECS[profileId];
  return [
    'QUALITY_GATE',
    `Quality profile: ${spec.label}`,
    `Required evidence file: ${spec.requiredEvidenceFile}`,
    'Completion is blocked until this quality profile passes.',
    'If the evidence file or any referenced artifacts are missing, emit the required tool calls before returning COMPLETE.',
    ...spec.instructions.map((instruction) => `- ${instruction}`),
    'Required evidence JSON example:',
    JSON.stringify(spec.jsonExample)
  ];
}
