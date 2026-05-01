import fs from 'node:fs';
import path from 'node:path';
import {
  ExecutionProfileId,
  QualityProfileId
} from '../../domain/contracts/types';
import {
  RuntimeEventRecord,
  ToolInvocationRecord
} from '../../foundation/repository/types';

export const QUALITY_EVIDENCE_FILES: Record<QualityProfileId, string> = {
  web_experience: 'quality/web-audit.json',
  docs_normalize: 'quality/docs-normalize-trace.json',
  docs_synthesize: 'quality/docs-synthesize-trace.json',
  system_audit: 'quality/system-audit.json',
  desktop_observation: 'quality/desktop-observation.json'
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
  }
};

const MOJIBAKE_PATTERN = /(?:\uFFFD|Ã.|Â.|â.|鈥|锟|�)/;
const PLACEHOLDER_COPY_PATTERN = /\b(?:lorem ipsum|sample copy|placeholder|my blog|feature\s+\d+|requirement\s+[A-Z])\b/i;
const MALFORMED_HTML_CONTROL_PATTERN = /(^|[^<])\b(?:input|textarea|select|option)\s+[^<>\n]*(?:id|name|class|placeholder)=/i;
const GENERIC_SYNTHESIS_PATTERN = /\b(?:user-centric design|scalable architecture|best-in-class|enterprise-grade|robust platform)\b/i;
const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'with', 'this', 'these', 'those', 'into', 'than', 'then'
]);

function extractVisibleWebText(filePath: string, content: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, ' ')
      .replace(/<input\b[^>]*>/gi, ' ')
      .replace(/\b(?:input|textarea|select|option)\b[^<>\n]*\bplaceholder\s*=\s*["'][^"']*["'][^<>\n]*>?/gi, ' ')
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

function getQualityEvidencePaths(input: TaskQualityEvaluationInput): string[] {
  const paths = [
    ...(Array.isArray(input.artifactPaths) ? input.artifactPaths : []),
    ...(Array.isArray(input.artifactDestinationPaths) ? input.artifactDestinationPaths : []),
  ];
  return paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function evidencePathMatchesReferencedFile(referencedPath: string, evidencePath: string): boolean {
  const normalizedReference = normalizeRelativePath(referencedPath).replace(/^\.\//, '');
  const normalizedEvidence = normalizeRelativePath(evidencePath);
  if (!normalizedReference || !normalizedEvidence) {
    return false;
  }
  if (normalizedEvidence === normalizedReference || normalizedEvidence.endsWith(`/${normalizedReference}`)) {
    return true;
  }
  return !normalizedReference.includes('/')
    && path.basename(normalizedEvidence).toLowerCase() === normalizedReference.toLowerCase();
}

function resolveQualityArtifactPath(input: TaskQualityEvaluationInput, filePath: string): string {
  const candidates = [resolveFilePath(input.workspaceDir, filePath)];
  if (!path.isAbsolute(filePath)) {
    if (typeof input.artifactDestinationDir === 'string' && input.artifactDestinationDir.trim()) {
      candidates.push(resolveFilePath(input.artifactDestinationDir, filePath));
    }
    for (const evidencePath of getQualityEvidencePaths(input)) {
      if (evidencePathMatchesReferencedFile(filePath, evidencePath)) {
        candidates.push(path.resolve(evidencePath));
      }
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
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

function isFullRegexMatchGrounded(
  reportedValue: unknown,
  matchedText: string,
  sourceContains: string[],
  sourceContainsMatched: boolean
): boolean {
  if (isReportedValueGroundedInToolText(reportedValue, matchedText)) {
    return true;
  }
  if (sourceContains.length === 0 || !sourceContainsMatched) {
    return false;
  }
  const reportedText = Array.isArray(reportedValue)
    ? reportedValue.filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number').join(' ')
    : typeof reportedValue === 'string' || typeof reportedValue === 'number' || typeof reportedValue === 'boolean'
      ? String(reportedValue)
      : '';
  const normalizedReportedText = normalizeAuditEvidenceText(reportedText);
  return normalizedReportedText.length > 0
    && normalizeAuditEvidenceText(matchedText).includes(normalizedReportedText);
}

function regexMatchSupportsReportedValue(
  regexSource: string,
  reportedValue: unknown,
  toolText: string,
  sourceContains: string[],
  sourceContainsMatched: boolean
): boolean {
  try {
    const match = new RegExp(regexSource, 'm').exec(toolText);
    if (!match) {
      return false;
    }
    const capturedValue = match[1];
    if (typeof capturedValue !== 'string') {
      return isFullRegexMatchGrounded(reportedValue, match[0], sourceContains, sourceContainsMatched);
    }
    if (typeof reportedValue === 'number') {
      const observed = Number.parseFloat(capturedValue);
      const tolerance = Math.max(Math.abs(reportedValue) * 0.05, 1);
      return Number.isFinite(observed) && Math.abs(observed - reportedValue) <= tolerance;
    }
    if (typeof reportedValue === 'string') {
      return capturedValue.trim() === reportedValue.trim();
    }
    return true;
  } catch {
    return false;
  }
}

function findCandidateSourceInvocationIds(
  input: TaskQualityEvaluationInput,
  params: {
    currentInvocationId: string;
    sourceRegex?: string;
    sourceContains: string[];
    reportedValue: unknown;
    textForInvocation?: (invocation: TaskQualityEvaluationInput['toolInvocations'][number]) => string;
  }
): string[] {
  const candidates: string[] = [];
  for (const invocation of input.toolInvocations) {
    if (
      invocation.invocationId === params.currentInvocationId
      || invocation.toolId !== 'run_command'
      || invocation.status !== 'SUCCEEDED'
    ) {
      continue;
    }
    const toolText = params.textForInvocation ? params.textForInvocation(invocation) : extractToolText(invocation);
    const normalizedToolText = normalizeAuditEvidenceText(toolText);
    const sourceContainsMatched = params.sourceContains.length === 0
      || params.sourceContains.every((needle) => normalizedToolText.includes(normalizeAuditEvidenceText(needle)));
    const regexMatched = params.sourceRegex
      ? regexMatchSupportsReportedValue(
        params.sourceRegex,
        params.reportedValue,
        toolText,
        params.sourceContains,
        sourceContainsMatched
      )
      : false;
    if (
      regexMatched
      || (params.sourceContains.length > 0 && sourceContainsMatched)
      || isReportedValueGroundedInToolText(params.reportedValue, toolText)
    ) {
      candidates.push(invocation.invocationId);
    }
    if (candidates.length >= 3) {
      break;
    }
  }
  return candidates;
}

function formatCandidateSourceInvocationHint(candidateIds: string[]): string {
  return candidateIds.length > 0
    ? ` Candidate sourceInvocationId values with matching evidence: ${candidateIds.join(', ')}.`
    : '';
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
  const filesToInspect = [...entryFiles, ...supportingFiles].map((filePath) => resolveQualityArtifactPath(input, filePath));
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
    if (/\.(?:html|htm)$/i.test(filePath) && MALFORMED_HTML_CONTROL_PATTERN.test(content)) {
      failedChecks.push(`html_malformed_tag_fragment:${normalizeRelativePath(filePath)}`);
      requiredNextEvidence.push(`repair malformed HTML form/control tag syntax in ${normalizeRelativePath(filePath)}`);
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
      const candidateIds = findCandidateSourceInvocationIds(input, {
        currentInvocationId: sourceInvocationId,
        sourceContains,
        reportedValue: fact.reportedValue
      });
      failedChecks.push(`tool_output_mismatch:${factName}`);
      requiredNextEvidence.push(`repair quality/system-audit.json fact ${factName} so sourceInvocationId points to a successful run_command output containing: ${sourceContains.join(', ')}.${formatCandidateSourceInvocationHint(candidateIds)}`);
      continue;
    } else if (!sourceContainsMatched) {
      passedChecks.push(`source_contains_value_grounded:${factName}`);
    }
    const regexSource = typeof fact.sourceRegex === 'string' ? fact.sourceRegex : '';
    if (regexSource) {
      try {
        const match = new RegExp(regexSource, 'm').exec(toolText);
        if (!match) {
          const candidateIds = findCandidateSourceInvocationIds(input, {
            currentInvocationId: sourceInvocationId,
            sourceRegex: regexSource,
            sourceContains,
            reportedValue: fact.reportedValue
          });
          failedChecks.push(`tool_regex_unmatched:${factName}`);
          requiredNextEvidence.push(`repair sourceRegex or sourceInvocationId for ${factName} so the regex matches the cited successful tool output.${formatCandidateSourceInvocationHint(candidateIds)}`);
          continue;
        }
        const reportedValue = fact.reportedValue;
        const capturedValue = match[1];
        if (typeof capturedValue !== 'string') {
          if (!isFullRegexMatchGrounded(reportedValue, match[0], sourceContains, sourceContainsMatched)) {
            failedChecks.push(`tool_regex_missing_capture:${factName}`);
            requiredNextEvidence.push(`repair sourceRegex for ${factName} so it captures or fully matches the reported value from the cited tool output`);
            continue;
          }
          passedChecks.push(`source_regex_full_match_grounded:${factName}`);
        } else if (typeof reportedValue === 'number') {
          const observed = Number.parseFloat(capturedValue);
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
        } else if (typeof reportedValue === 'string' && capturedValue.trim() !== reportedValue.trim()) {
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
      const candidateIds = findCandidateSourceInvocationIds(input, {
        currentInvocationId: sourceInvocationId,
        sourceContains,
        reportedValue: observation.reportedValue,
        textForInvocation: (candidate) => {
          const candidateCommand = typeof candidate.arguments?.command === 'string' ? candidate.arguments.command : '';
          return `${candidateCommand}\n${extractToolText(candidate)}`;
        }
      });
      failedChecks.push(`tool_output_mismatch:${observationName}`);
      requiredNextEvidence.push(`repair quality/desktop-observation.json observation ${observationName} so sourceInvocationId points to a successful run_command output containing: ${sourceContains.join(', ')}.${formatCandidateSourceInvocationHint(candidateIds)}`);
      continue;
    } else if (!sourceContainsMatched) {
      passedChecks.push(`source_contains_value_grounded:${observationName}`);
    }

    const regexSource = typeof observation.sourceRegex === 'string' ? observation.sourceRegex : '';
    if (regexSource) {
      try {
        const match = new RegExp(regexSource, 'm').exec(combinedToolText);
        if (!match) {
          const candidateIds = findCandidateSourceInvocationIds(input, {
            currentInvocationId: sourceInvocationId,
            sourceRegex: regexSource,
            sourceContains,
            reportedValue: observation.reportedValue,
            textForInvocation: (candidate) => {
              const candidateCommand = typeof candidate.arguments?.command === 'string' ? candidate.arguments.command : '';
              return `${candidateCommand}\n${extractToolText(candidate)}`;
            }
          });
          failedChecks.push(`tool_regex_unmatched:${observationName}`);
          requiredNextEvidence.push(`repair sourceRegex or sourceInvocationId for ${observationName} so the regex matches the cited successful tool output.${formatCandidateSourceInvocationHint(candidateIds)}`);
          continue;
        }
        const reportedValue = observation.reportedValue;
        const capturedValue = match[1];
        if (typeof capturedValue !== 'string') {
          if (!isFullRegexMatchGrounded(reportedValue, match[0], sourceContains, sourceContainsMatched)) {
            failedChecks.push(`tool_regex_missing_capture:${observationName}`);
            requiredNextEvidence.push(`repair sourceRegex for ${observationName} so it captures or fully matches the reported value from the cited tool output`);
            continue;
          }
          passedChecks.push(`source_regex_full_match_grounded:${observationName}`);
        } else if (typeof reportedValue === 'number') {
          const observed = Number.parseFloat(capturedValue);
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
        } else if (typeof reportedValue === 'string' && capturedValue.trim() !== reportedValue.trim()) {
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
