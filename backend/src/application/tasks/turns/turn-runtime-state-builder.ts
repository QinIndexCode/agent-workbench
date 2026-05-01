import path from 'node:path';
import {
  AcceptanceFailureCategory,
  CorrectionPromptMode,
  LlmContextMessage,
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile
} from '../../../domain/contracts/types';
import { createContextCompressionPolicy } from '../../../domain/runtime/context-compression-policy';
import {
  appendAndCompressLlmContext,
  createContextSnapshotRef,
  createLlmContextMessage
} from '../../../domain/runtime/context-manager';
import { evolveTaskMemory, evolveUserPreferenceProfile } from '../../../domain/runtime/memory';
import {
  applyCorrectionState,
  applyTrackerState,
  applyTrackerStates
} from '../../../domain/runtime/state-transition-applier';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { ToolInvocationRecord } from '../../../foundation/repository/types';
import { evaluateTaskQuality } from '../../../domain/quality/task-quality';
import { collectTaskArtifactPaths } from '../artifact-routing';
import { TaskPlannerService } from '../planning/task-planner-service';
import { TurnContextAssemblyResult } from './turn-context-assembly';
import { TurnPhaseOutcome } from './turn-phase-types';

export interface TurnRuntimeStateBuildResult {
  nextRuntime: TaskRuntimeState;
  updatedUserProfile: UserPreferenceProfile;
}

function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function stringifyContextValue(value: unknown, maxChars: number): string {
  const rendered = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? null);
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(0, maxChars - 3))}...`;
}

function stringifyContextMetadataValue(value: unknown, maxChars: number): string {
  if (typeof value === 'string') {
    return stringifyContextValue(value, maxChars);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return stringifyContextValue(value, maxChars);
}

function formatPathList(paths: string[], limit: number): string {
  const normalized = Array.from(new Set(paths.map(normalizeWorkspaceRelativePath).filter((value): value is string => !!value)));
  if (normalized.length === 0) {
    return '(none)';
  }
  const shown = normalized.slice(0, limit);
  const suffix = normalized.length > shown.length ? `; +${normalized.length - shown.length} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

function isAbsoluteArtifactEvidencePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('/');
}

function getWriteFileContentFromArguments(argumentsRecord: Record<string, unknown>): string | null {
  const directContent = argumentsRecord.content;
  if (typeof directContent === 'string') {
    return directContent;
  }
  const contentLines = argumentsRecord.content_lines;
  if (Array.isArray(contentLines) && contentLines.every((entry) => typeof entry === 'string')) {
    return contentLines.join('\n');
  }
  const contentJson = argumentsRecord.content_json;
  if (contentJson && typeof contentJson === 'object' && !Array.isArray(contentJson)) {
    return `${JSON.stringify(contentJson, null, 2)}\n`;
  }
  return null;
}

function formatLineNumberedExcerpt(content: string, startLine: number): string {
  const safeStartLine = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
  return content
    .split(/\r?\n/)
    .map((line, index) => `${String(safeStartLine + index).padStart(4, ' ')}: ${line}`)
    .join('\n');
}

function normalizePythonRelativeModuleSpecifier(specifier: string): string | null {
  const match = specifier.match(/^(\.+)([A-Za-z_][\w.]*)$/);
  if (!match) {
    return null;
  }
  const [, dots, modulePath] = match;
  const parentPrefix = dots.length > 1 ? '../'.repeat(dots.length - 1) : './';
  return `${parentPrefix}${modulePath.replace(/\./g, '/')}`;
}

function extractCommonRelativeCodeReferences(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /^\s*#\s*include\s+["](\.{0,2}\/?[^">]+)[">]/gm,
    /^\s*require_relative\s+['"]([^'"]+)['"]/gm,
    /^\s*mod\s+([A-Za-z_][\w]*)\s*;/gm
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (typeof match[1] === 'string' && match[1].trim()) {
        const rawSpecifier = match[1].trim();
        specifiers.add(rawSpecifier.startsWith('.') ? rawSpecifier : `./${rawSpecifier}`);
      }
    }
  }
  const pythonPatterns = [
    /^\s*from\s+(\.+[A-Za-z_][\w.]*)\s+import\s+/gm,
    /^\s*import\s+(\.+[A-Za-z_][\w.]*)\s*$/gm
  ];
  for (const pattern of pythonPatterns) {
    for (const match of content.matchAll(pattern)) {
      if (typeof match[1] !== 'string') {
        continue;
      }
      const normalized = normalizePythonRelativeModuleSpecifier(match[1].trim());
      if (normalized) {
        specifiers.add(normalized);
      }
    }
  }
  return [...specifiers];
}

function getSameTurnReferenceCandidates(fromPath: string, specifier: string): string[] {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier.replace(/\\/g, '/')))
    .replace(/^\.\//, '');
  const extension = path.posix.extname(joined);
  if (extension) {
    return [joined];
  }
  const fallbackCandidates = [
    `${joined}.js`,
    `${joined}.cjs`,
    `${joined}.mjs`,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.jsx`,
    `${joined}.mts`,
    `${joined}.cts`,
    `${joined}.py`,
    `${joined}/__init__.py`,
    `${joined}.rs`,
    `${joined}/mod.rs`,
    `${joined}.rb`,
    `${joined}.php`,
    `${joined}.go`,
    `${joined}.java`,
    `${joined}.kt`,
    `${joined}.cs`,
    `${joined}.h`,
    `${joined}.hpp`,
    `${joined}.c`,
    `${joined}.cpp`,
    `${joined}.json`,
    `${joined}/index.js`,
    `${joined}/index.ts`
  ];
  const sourceExtension = path.posix.extname(fromPath).toLowerCase();
  const prioritizedCandidates =
    sourceExtension === '.py'
      ? [`${joined}.py`, `${joined}/__init__.py`]
      : sourceExtension === '.rs'
        ? [`${joined}.rs`, `${joined}/mod.rs`]
        : sourceExtension === '.rb'
          ? [`${joined}.rb`]
          : ['.c', '.cc', '.cpp', '.h', '.hpp'].includes(sourceExtension)
            ? [`${joined}.h`, `${joined}.hpp`, `${joined}.c`, `${joined}.cpp`]
            : sourceExtension === '.go'
              ? [`${joined}.go`]
              : sourceExtension === '.java'
                ? [`${joined}.java`]
                : sourceExtension === '.kt'
                  ? [`${joined}.kt`]
                  : sourceExtension === '.cs'
                    ? [`${joined}.cs`]
                    : [];
  return Array.from(new Set([...prioritizedCandidates, ...fallbackCandidates]));
}

interface JavaScriptModuleImportFact {
  specifier: string;
  localName: string;
  kind: 'commonjs_default' | 'commonjs_named';
}

interface JavaScriptModuleExportFacts {
  commonJsDefault: string | null;
  commonJsNamedObject: string[];
  namedExports: string[];
}

function extractJavaScriptModuleImports(content: string): JavaScriptModuleImportFact[] {
  const imports: JavaScriptModuleImportFact[] = [];
  const defaultRequirePattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(defaultRequirePattern)) {
    imports.push({
      kind: 'commonjs_default',
      localName: match[1],
      specifier: match[2]
    });
  }
  const namedRequirePattern = /\b(?:const|let|var)\s*\{\s*([^}]+?)\s*\}\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(namedRequirePattern)) {
    const specifier = match[2];
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim())
      .map((entry) => entry.split(':')[0]?.trim())
      .filter((entry): entry is string => Boolean(entry));
    for (const localName of names) {
      imports.push({
        kind: 'commonjs_named',
        localName,
        specifier
      });
    }
  }
  return imports;
}

function parseSimpleExportNames(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => {
      const aliasMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        return aliasMatch[2];
      }
      const propertyMatch = entry.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (propertyMatch) {
        return propertyMatch[1];
      }
      const directMatch = entry.match(/^([A-Za-z_$][\w$]*)$/);
      return directMatch?.[1] ?? null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function extractJavaScriptModuleExports(content: string): JavaScriptModuleExportFacts {
  const commonJsNamedObject = new Set<string>();
  const namedExports = new Set<string>();
  const objectExportMatch = content.match(/\bmodule\.exports\s*=\s*\{([\s\S]*?)\}\s*;?/m);
  if (objectExportMatch) {
    for (const name of parseSimpleExportNames(objectExportMatch[1])) {
      commonJsNamedObject.add(name);
      namedExports.add(name);
    }
  }
  let commonJsDefault: string | null = null;
  const defaultExportMatch = content.match(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/);
  if (defaultExportMatch && !objectExportMatch) {
    commonJsDefault = defaultExportMatch[1];
  }
  for (const match of content.matchAll(/\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g)) {
    commonJsNamedObject.add(match[1]);
    namedExports.add(match[1]);
  }
  for (const match of content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    namedExports.add(match[1]);
  }
  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of parseSimpleExportNames(match[1])) {
      namedExports.add(name);
    }
  }
  return {
    commonJsDefault,
    commonJsNamedObject: [...commonJsNamedObject],
    namedExports: [...namedExports]
  };
}

function buildCurrentTurnReadFileModuleFactSummary(params: {
  invocations: ToolInvocationRecord[];
  currentUnitId: string;
  turnId: string;
}): LlmContextMessage | null {
  const latestWriteByPath = new Map<string, number>();
  for (const invocation of params.invocations) {
    if (
      invocation.unitId !== params.currentUnitId
      || invocation.status !== 'SUCCEEDED'
      || normalizeToolId(invocation.toolId) !== 'write_file'
    ) {
      continue;
    }
    const filePath = normalizeWorkspaceRelativePath((invocation.result as Record<string, unknown> | null)?.path)
      ?? normalizeWorkspaceRelativePath(invocation.arguments.path);
    if (!filePath) {
      continue;
    }
    latestWriteByPath.set(filePath, Math.max(latestWriteByPath.get(filePath) ?? 0, invocation.endedAt ?? invocation.startedAt ?? 0));
  }
  const readFiles = params.invocations
    .filter((invocation) => (
      invocation.unitId === params.currentUnitId
      && invocation.status === 'SUCCEEDED'
      && normalizeToolId(invocation.toolId) === 'read_file'
    ))
    .sort((left, right) => {
      const leftTimestamp = left.endedAt ?? left.startedAt ?? 0;
      const rightTimestamp = right.endedAt ?? right.startedAt ?? 0;
      return leftTimestamp - rightTimestamp;
    })
    .map((invocation) => {
      const output = invocation.result && typeof invocation.result === 'object' && !Array.isArray(invocation.result)
        ? invocation.result as Record<string, unknown>
        : null;
      const content = typeof output?.content === 'string' ? output.content : null;
      const filePath = normalizeWorkspaceRelativePath(output?.path)
        ?? normalizeWorkspaceRelativePath(invocation.arguments.path);
      if (!content || !filePath) {
        return null;
      }
      const readAt = invocation.endedAt ?? invocation.startedAt ?? 0;
      const laterWriteAt = latestWriteByPath.get(filePath) ?? 0;
      if (laterWriteAt > readAt) {
        return null;
      }
      return { path: filePath, content };
    })
    .filter((entry): entry is { path: string; content: string } => Boolean(entry))
    .slice(-16);
  if (readFiles.length < 2) {
    return null;
  }
  const readFileByPath = new Map(readFiles.map((entry) => [entry.path, entry]));
  const exportFactsByPath = new Map(readFiles.map((entry) => [entry.path, extractJavaScriptModuleExports(entry.content)]));
  const mismatchFacts: string[] = [];
  for (const source of readFiles) {
    for (const importFact of extractJavaScriptModuleImports(source.content)) {
      const targetPath = getSameTurnReferenceCandidates(source.path, importFact.specifier)
        .find((candidate) => readFileByPath.has(candidate));
      if (!targetPath) {
        continue;
      }
      const exportFacts = exportFactsByPath.get(targetPath);
      if (!exportFacts) {
        continue;
      }
      if (
        importFact.kind === 'commonjs_default'
        && exportFacts.commonJsNamedObject.includes(importFact.localName)
        && !exportFacts.commonJsDefault
      ) {
        mismatchFacts.push(
          `${source.path} imports ${importFact.specifier} as default CommonJS value "${importFact.localName}", `
          + `but ${targetPath} exports named CommonJS object { ${exportFacts.commonJsNamedObject.join(', ')} }. `
          + `Use destructuring require or change the module default export before constructing/calling "${importFact.localName}".`
        );
      }
      if (
        importFact.kind === 'commonjs_named'
        && exportFacts.commonJsDefault === importFact.localName
        && !exportFacts.commonJsNamedObject.includes(importFact.localName)
      ) {
        mismatchFacts.push(
          `${source.path} destructures "${importFact.localName}" from ${importFact.specifier}, `
          + `but ${targetPath} assigns module.exports directly to ${exportFacts.commonJsDefault}. `
          + 'Use default require or export a named object consistently.'
        );
      }
      if (importFact.kind === 'commonjs_named') {
        const exportedNames = Array.from(new Set([
          ...exportFacts.commonJsNamedObject,
          ...exportFacts.namedExports,
          ...(exportFacts.commonJsDefault ? [exportFacts.commonJsDefault] : [])
        ]));
        if (exportedNames.length > 0 && !exportedNames.includes(importFact.localName)) {
          const caseOnlyMatch = exportedNames.find((name) => name.toLowerCase() === importFact.localName.toLowerCase());
          mismatchFacts.push(
            `${source.path} imports named CommonJS export "${importFact.localName}" from ${importFact.specifier}, `
            + `but ${targetPath} exports { ${exportedNames.join(', ')} }. `
            + `${caseOnlyMatch ? `The closest export is "${caseOnlyMatch}"; CommonJS property names are case-sensitive. ` : ''}`
            + 'Align the destructured import name with the exported name, or export the requested name explicitly.'
          );
        }
      }
    }
  }
  if (mismatchFacts.length === 0) {
    return null;
  }
  return createLlmContextMessage({
    role: 'tool',
    content: [
      'Recent read_file module contract facts.',
      `Potential local import/export mismatches (${mismatchFacts.length}): ${mismatchFacts.slice(0, 6).join('; ')}`,
      'These facts are derived only from read_file results that have not been superseded by later same-path writes. Verify the fix with a real compile/test/run command.'
    ].join('\n'),
    metadata: {
      unitId: params.currentUnitId,
      source: 'tool_result_module_facts',
      turnId: params.turnId
    }
  });
}

function buildCurrentTurnWriteFactSummary(params: {
  invocations: ToolInvocationRecord[];
  currentUnitId: string;
  turnId: string;
  maxContentChars: number;
}): LlmContextMessage | null {
  const currentTurnInvocations = params.invocations
    .filter((invocation) => (
      invocation.unitId === params.currentUnitId
      && invocation.turnId === params.turnId
      && (invocation.status === 'SUCCEEDED' || invocation.status === 'FAILED' || invocation.status === 'DENIED')
    ))
    .sort((left, right) => {
      const leftTimestamp = left.endedAt ?? left.startedAt ?? 0;
      const rightTimestamp = right.endedAt ?? right.startedAt ?? 0;
      return leftTimestamp - rightTimestamp;
    });
  const writeInvocations = currentTurnInvocations.filter((invocation) => normalizeToolId(invocation.toolId) === 'write_file');
  if (writeInvocations.length === 0) {
    return null;
  }
  const successfulWritePaths = writeInvocations
    .filter((invocation) => invocation.status === 'SUCCEEDED')
    .map((invocation) =>
      normalizeWorkspaceRelativePath((invocation.result as Record<string, unknown> | null)?.path)
        ?? normalizeWorkspaceRelativePath(invocation.arguments.path)
    )
    .filter((value): value is string => !!value);
  const successfulWriteSet = new Set(successfulWritePaths);
  const failedWritePaths = writeInvocations
    .filter((invocation) => invocation.status !== 'SUCCEEDED')
    .map((invocation) => normalizeWorkspaceRelativePath(invocation.arguments.path) ?? 'unknown')
    .filter(Boolean);
  const unconfirmedReferences: string[] = [];
  for (const invocation of writeInvocations) {
    if (invocation.status !== 'SUCCEEDED') {
      continue;
    }
    const writePath = normalizeWorkspaceRelativePath((invocation.result as Record<string, unknown> | null)?.path)
      ?? normalizeWorkspaceRelativePath(invocation.arguments.path);
    if (!writePath) {
      continue;
    }
    const content = getWriteFileContentFromArguments(invocation.arguments);
    if (!content) {
      continue;
    }
    for (const specifier of extractCommonRelativeCodeReferences(content)) {
      const candidates = getSameTurnReferenceCandidates(writePath, specifier);
      if (!candidates.some((candidate) => successfulWriteSet.has(candidate))) {
        unconfirmedReferences.push(`${writePath} -> ${specifier} (candidates: ${candidates.slice(0, 3).join(', ')})`);
      }
    }
  }
  const lines = [
    'Current turn workspace facts from executed tools.',
    `Successful write_file paths (${successfulWritePaths.length}): ${formatPathList(successfulWritePaths, 20)}.`,
    ...(failedWritePaths.length > 0 ? [`Failed write_file paths (${failedWritePaths.length}): ${formatPathList(failedWritePaths, 12)}.`] : []),
    ...(unconfirmedReferences.length > 0
      ? [
        `Common relative code references not confirmed by same-turn writes (${unconfirmedReferences.length}): ${unconfirmedReferences.slice(0, 8).join('; ')}.`,
        'This is a file-existence hint, not a language semantic check. It does not prove import resolution, exported names, function signatures, or package-specific module rules.',
        'Before relying on an unconfirmed local reference or exported API, verify it with inspect_file/read_file/list_files and a real compile/test/run command, or write the referenced file in a later tool turn.'
      ]
      : []),
    'Treat planned paths, examples, and prior prose as unconfirmed until they appear in successful tool evidence.'
  ];
  return createLlmContextMessage({
    role: 'tool',
    content: stringifyContextValue(lines.join('\n'), params.maxContentChars),
    metadata: {
      unitId: params.currentUnitId,
      source: 'tool_result_summary',
      toolId: 'write_file',
      status: 'SUCCEEDED',
      turnId: params.turnId
    }
  });
}

function mergedInvocationResultAndMetadata(invocation: ToolInvocationRecord): Record<string, unknown> {
  const result = invocation.result && typeof invocation.result === 'object' && !Array.isArray(invocation.result)
    ? invocation.result
    : {};
  const metadata = invocation.metadata && typeof invocation.metadata === 'object'
    ? invocation.metadata
    : {};
  return { ...metadata, ...result };
}

function derivePendingInvocationIds(params: {
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
  latestToolInvocations: ToolInvocationRecord[];
}): {
  awaitingToolDispatch: string[];
  awaitingApprovalInvocations: string[];
} {
  const latestById = new Map(params.latestToolInvocations.map((invocation) => [invocation.invocationId, invocation]));
  return {
    awaitingToolDispatch: params.acceptedInvocationIds.filter((invocationId) => {
      const invocation = latestById.get(invocationId);
      return !invocation || invocation.status === 'PLANNED' || invocation.status === 'RUNNING';
    }),
    awaitingApprovalInvocations: params.approvalInvocationIds.filter((invocationId) => {
      const invocation = latestById.get(invocationId);
      return !invocation || invocation.status === 'WAITING_APPROVAL';
    })
  };
}

function buildRunCommandResultContext(invocation: ToolInvocationRecord, maxContentChars: number): string {
  const metadata = mergedInvocationResultAndMetadata(invocation);
  const command = stringifyContextMetadataValue(
    metadata.effectiveCommand ?? metadata.command ?? invocation.arguments.command ?? invocation.arguments.cmd,
    800
  );
  const originalCommand = stringifyContextMetadataValue(
    metadata.originalCommand ?? metadata.requestedCommand ?? invocation.arguments.command ?? invocation.arguments.cmd,
    800
  );
  const cwd = stringifyContextMetadataValue(metadata.cwd, 600);
  const exitCode = metadata.exitCode === undefined ? 'unknown' : String(metadata.exitCode);
  const timeoutMs = metadata.timeoutMs === undefined ? null : String(metadata.timeoutMs);
  const durationMs = metadata.durationMs === undefined ? null : String(metadata.durationMs);
  const stdout = stringifyContextMetadataValue(metadata.stdout, Math.max(400, Math.floor(maxContentChars / 2)));
  const stderr = stringifyContextMetadataValue(metadata.stderr, Math.max(400, Math.floor(maxContentChars / 2)));
  const didSucceed = invocation.status === 'SUCCEEDED';
  const lines = [
    didSucceed
      ? `Tool run_command succeeded with exit code ${exitCode}.`
      : `Tool run_command failed: ${invocation.error ?? 'unknown error'}`,
    `Exit code: ${exitCode}.`,
    ...(metadata.timedOut === true ? [`Timed out: true${timeoutMs ? ` after ${timeoutMs}ms` : ''}.`] : []),
    ...(durationMs ? [`DurationMs: ${durationMs}.`] : []),
    ...(originalCommand ? [`Requested command: ${originalCommand}`] : []),
    ...(command && command !== originalCommand ? [`Executed command: ${command}`] : []),
    ...(cwd ? [`cwd: ${cwd}`] : []),
    'stdout:',
    stdout || '(empty)',
    'stderr:',
    stderr || '(empty)'
  ];
  return lines.join('\n');
}

function buildToolContextMessageContent(invocation: ToolInvocationRecord, maxContentChars: number): string {
  const normalizedToolId = normalizeToolId(invocation.toolId);
  if (invocation.status === 'SUCCEEDED' && normalizedToolId === 'read_file') {
    const output = invocation.result && typeof invocation.result === 'object' && !Array.isArray(invocation.result)
      ? invocation.result as Record<string, unknown>
      : null;
    const content = typeof output?.content === 'string' ? output.content : '';
    const path = normalizeWorkspaceRelativePath(output?.path)
      ?? normalizeWorkspaceRelativePath(invocation.arguments.path)
      ?? invocation.toolId;
    const selection = output?.selection && typeof output.selection === 'object' && !Array.isArray(output.selection)
      ? output.selection as Record<string, unknown>
      : null;
    const startLine = typeof selection?.startLine === 'number' ? selection.startLine : 1;
    const endLine = typeof selection?.endLine === 'number' ? selection.endLine : null;
    const totalLines = typeof selection?.totalLines === 'number' ? selection.totalLines : null;
    const selectedChars = typeof output?.selectedChars === 'number' ? output.selectedChars : content.length;
    const totalChars = typeof output?.totalChars === 'number' ? output.totalChars : content.length;
    const truncated = output?.truncated === true;
    const excerpt = stringifyContextValue(formatLineNumberedExcerpt(content, startLine), maxContentChars);
    return [
      `Tool read_file succeeded for ${path}.`,
      `Selection: lines ${startLine}-${endLine ?? startLine}${totalLines ? ` of ${totalLines}` : ''}; chars ${selectedChars}/${totalChars}${truncated ? ' (truncated)' : ''}.`,
      'Selected file content:',
      excerpt
    ].join('\n');
  }
  if (invocation.status === 'SUCCEEDED' && normalizedToolId === 'run_command') {
    return buildRunCommandResultContext(invocation, maxContentChars);
  }
  if (invocation.status === 'SUCCEEDED') {
    return [
      `Tool ${normalizedToolId} succeeded.`,
      `Result: ${stringifyContextValue(invocation.result ?? null, maxContentChars)}`
    ].join('\n');
  }
  if (invocation.status === 'FAILED' && normalizedToolId === 'run_command') {
    return buildRunCommandResultContext(invocation, maxContentChars);
  }
  return [
    `Tool ${normalizedToolId} ${invocation.status.toLowerCase()}: ${invocation.error ?? 'unknown error'}`,
    `Arguments: ${stringifyContextValue(invocation.arguments ?? null, Math.max(400, Math.floor(maxContentChars / 2)))}`,
    `Metadata: ${stringifyContextValue(invocation.metadata ?? null, Math.max(400, Math.floor(maxContentChars / 2)))}`
  ].join('\n');
}

export function buildCurrentTurnToolContextMessages(params: {
  invocations: ToolInvocationRecord[];
  currentUnitId: string;
  turnId: string;
  maxContentChars: number;
  maxMessages?: number;
}): LlmContextMessage[] {
  const selectedInvocations = params.invocations
    .filter((invocation) => (
      invocation.unitId === params.currentUnitId
      && invocation.turnId === params.turnId
      && (invocation.status === 'SUCCEEDED' || invocation.status === 'FAILED' || invocation.status === 'DENIED')
    ))
    .sort((left, right) => {
      const leftTimestamp = left.endedAt ?? left.startedAt ?? 0;
      const rightTimestamp = right.endedAt ?? right.startedAt ?? 0;
      return leftTimestamp - rightTimestamp;
    })
    .slice(-(params.maxMessages ?? 4));
  const summaryMessage = buildCurrentTurnWriteFactSummary(params);
  const moduleFactSummaryMessage = buildCurrentTurnReadFileModuleFactSummary(params);
  const invocationMessages = selectedInvocations.map((invocation) => createLlmContextMessage({
    role: 'tool',
    content: buildToolContextMessageContent(invocation, params.maxContentChars),
    metadata: {
      unitId: invocation.unitId,
      source: 'tool_result',
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      status: invocation.status,
      turnId: invocation.turnId
    }
  }));
  return [
    ...(summaryMessage ? [summaryMessage] : []),
    ...(moduleFactSummaryMessage ? [moduleFactSummaryMessage] : []),
    ...invocationMessages
  ];
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isMaterializingWriteTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'run_command';
}

function isVerificationEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'read_file'
    || normalized === 'inspect_file'
    || normalized === 'search_files'
    || normalized === 'list_files'
    || normalized === 'run_command';
}

function isFailedInspectionEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'read_file'
    || normalized === 'inspect_file'
    || normalized === 'search_files'
    || normalized === 'list_files';
}

function collectInvocationEvidencePaths(invocation: Pick<ToolInvocationRecord, 'arguments' | 'result'>): string[] {
  const candidates = [
    invocation.result?.path,
    invocation.result?.file,
    invocation.result?.output_path,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).path
      : undefined,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).file
      : undefined,
    invocation.arguments.path,
    invocation.arguments.file,
    invocation.arguments.file_path,
    invocation.arguments.output
  ];
  return candidates
    .map((value) => normalizeWorkspaceRelativePath(value))
    .filter((value): value is string => !!value);
}

function collectTrackerArtifactPaths(trackers: Array<{ filesCreated?: string[] }>): string[] {
  const evidence = new Set<string>();
  for (const tracker of trackers) {
    for (const filePath of tracker.filesCreated ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath);
      if (normalized) {
        evidence.add(normalized);
      }
    }
  }
  return [...evidence];
}

function summarizeUnitToolEvidence(invocations: ToolInvocationRecord[], unitId: string) {
  let successfulMaterializingToolCount = 0;
  let successfulVerificationToolCount = 0;
  const successfulWriteEvidencePaths = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.unitId !== unitId || (invocation.status !== 'SUCCEEDED' && invocation.status !== 'FAILED')) {
      continue;
    }
    if (invocation.status === 'SUCCEEDED' && isMaterializingWriteTool(invocation.toolId)) {
      successfulMaterializingToolCount += 1;
      for (const path of collectInvocationEvidencePaths(invocation)) {
        successfulWriteEvidencePaths.add(path);
      }
    }
    if (
      (invocation.status === 'SUCCEEDED' && isVerificationEvidenceTool(invocation.toolId))
      || (invocation.status === 'FAILED' && isFailedInspectionEvidenceTool(invocation.toolId))
    ) {
      successfulVerificationToolCount += 1;
    }
  }
  return {
    successfulMaterializingToolCount,
    successfulVerificationToolCount,
    successfulWriteEvidencePaths: [...successfulWriteEvidencePaths]
  };
}

function deriveEffectiveAcceptanceState(params: {
  currentUnit: TaskDefinition['units'][number] | null;
  diagnosticsAcceptance: TurnPhaseOutcome['orchestrated']['acceptance'];
  latestToolInvocations: ToolInvocationRecord[];
  acceptedTrackers: TurnPhaseOutcome['acceptedTrackers'];
  qualityGateFailed: boolean;
}) {
  if (!params.currentUnit || params.qualityGateFailed) {
    return {
      pendingCorrection: params.diagnosticsAcceptance.ok ? 'NONE' as const : params.diagnosticsAcceptance.pendingCorrection,
      failureCategory: params.diagnosticsAcceptance.ok
        ? null
        : (
          params.diagnosticsAcceptance.failureCategory
          ?? (params.diagnosticsAcceptance.pendingCorrection === 'AWAITING_TOOL_ACTION'
            ? 'tool_action_required_but_not_emitted'
            : null)
        ),
      issueCodes: params.diagnosticsAcceptance.issues.map((issue) => issue.code),
      issueMessages: params.diagnosticsAcceptance.issues.map((issue) => issue.message)
    };
  }

  const issueCodes = params.diagnosticsAcceptance.issues.map((issue) => issue.code);
  const issueMessages = params.diagnosticsAcceptance.issues.map((issue) => issue.message);
  const executionProfileId = params.currentUnit.executionProfileId ?? 'analyze';
  const unitEvidence = summarizeUnitToolEvidence(params.latestToolInvocations, params.currentUnit.id);
  const declaredArtifactPaths = collectTrackerArtifactPaths(params.acceptedTrackers.filter((tracker) => tracker.currentUnit === params.currentUnit?.id));
  const hasMatchingArtifactWrite = declaredArtifactPaths.length > 0
    && declaredArtifactPaths.some((artifactPath) => unitEvidence.successfulWriteEvidencePaths.includes(artifactPath));

  if (executionProfileId === 'implement' && unitEvidence.successfulMaterializingToolCount === 0) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'artifact_write_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_persistent_write_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" did not produce a persistent write for implement completion.`
      ]
    };
  }

  if (
    executionProfileId === 'implement'
    && (issueCodes.includes('missing_persistent_effect_evidence') || (declaredArtifactPaths.length > 0 && !hasMatchingArtifactWrite))
  ) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'artifact_write_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_persistent_write_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" still lacks persistent write evidence for required artifact delivery.`
      ]
    };
  }

  if (
    executionProfileId === 'verify'
    && (unitEvidence.successfulVerificationToolCount === 0 || issueCodes.includes('missing_verification_evidence'))
  ) {
    return {
      pendingCorrection: 'AWAITING_TOOL_ACTION' as const,
      failureCategory: 'tool_action_required_but_not_emitted' as const,
      issueCodes: [...issueCodes, 'runtime_missing_verification_evidence'],
      issueMessages: [
        ...issueMessages,
        `Unit "${params.currentUnit.id}" still lacks successful verification evidence.`
      ]
    };
  }

  return {
    pendingCorrection: params.diagnosticsAcceptance.pendingCorrection,
    failureCategory: params.diagnosticsAcceptance.failureCategory
      ?? (params.diagnosticsAcceptance.pendingCorrection === 'AWAITING_TOOL_ACTION'
        ? 'tool_action_required_but_not_emitted'
        : null),
    issueCodes,
    issueMessages
  };
}

function deriveCorrectionPromptMode(params: {
  pendingCorrection: TaskRuntimeState['pendingCorrection'];
  failureCategory: AcceptanceFailureCategory | null;
}): CorrectionPromptMode {
  if (params.pendingCorrection === 'AWAITING_TRACKER') {
    return 'TARGETED_TRACKER';
  }
  if (
    params.pendingCorrection === 'AWAITING_TOOL_ACTION'
    || params.failureCategory === 'tool_action_required_but_not_emitted'
    || params.failureCategory === 'artifact_write_required_but_not_emitted'
    || params.failureCategory === 'required_delegation_missing'
  ) {
    return 'TARGETED_TOOL_ACTION';
  }
  if (params.pendingCorrection === 'AWAITING_BLOCKER_EXPLANATION') {
    return 'TARGETED_BLOCKER_EXPLANATION';
  }
  if (params.pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    return 'TARGETED_OUTPUT';
  }
  return 'FULL_PROTOCOL';
}

function computeGuardrails(params: {
  previousRuntime: TaskRuntimeState;
  fallbackTurn: boolean;
  phaseOutcome: TurnPhaseOutcome;
}): NonNullable<TaskRuntimeState['guardrails']> {
  const previous = params.previousRuntime.guardrails;
  const correctionTurn = params.phaseOutcome.consolidationState.status === 'CORRECTION_REQUIRED';
  const approvalBlockedTurn = params.phaseOutcome.pendingToolBatches.some((batch) => batch.status === 'PARTIAL_APPROVAL_BLOCKED');
  const correctionStreak = correctionTurn ? ((previous?.correctionStreak ?? 0) + 1) : 0;
  const fallbackStreak = params.fallbackTurn ? ((previous?.fallbackStreak ?? 0) + 1) : 0;
  const approvalBlockedBatchStreak = approvalBlockedTurn ? ((previous?.approvalBlockedBatchStreak ?? 0) + 1) : 0;
  const compressionDowngraded = correctionStreak >= 1 || fallbackStreak >= 1 || approvalBlockedBatchStreak >= 1;
  const batchAdmissionRestricted = !!params.phaseOutcome.batchGuardrail?.batchAdmissionRestricted || fallbackStreak >= 2 || approvalBlockedBatchStreak >= 1;
  return {
    correctionStreak,
    fallbackStreak,
    approvalBlockedBatchStreak,
    compressionDowngraded,
    batchAdmissionRestricted,
    plannerFallbackRate: Number((params.fallbackTurn ? 1 : 0).toFixed(4))
  };
}

export function buildTurnRuntimeState(params: {
  foundation: BackendNewFoundation;
  plannerService: TaskPlannerService;
  definition: TaskDefinition;
  previousRuntime: TaskRuntimeState;
  assembled: Pick<
    TurnContextAssemblyResult,
    | 'userProfile'
    | 'selectedProvider'
    | 'prompt'
    | 'promptResult'
    | 'contextMessages'
    | 'contextGatingSummary'
    | 'existingConversations'
    | 'estimatedPromptCharacters'
    | 'estimatedBaselineCharacters'
    | 'estimatedReductionRatio'
    | 'selectedValidatedOutputs'
    | 'pendingOperatorInputs'
    | 'stageMemorySummary'
    | 'capabilitySelectionSummary'
    | 'retrievalSelectionSummary'
  >;
  userMessage: string | undefined;
  currentUnitId: string;
  checkpointId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  providerResponseText: string;
  plannerPreferred: boolean;
  phaseOutcome: TurnPhaseOutcome;
  latestRuntimeAfterProvider: TaskRuntimeState;
  latestToolInvocations: ToolInvocationRecord[];
}): TurnRuntimeStateBuildResult {
  const currentUnit = params.definition.units.find((unit) => unit.id === params.currentUnitId) ?? null;
  const latestAcceptedOutput = params.phaseOutcome.acceptedOutputs?.at(-1);
  const qualityArtifactPaths = collectTaskArtifactPaths(params.latestToolInvocations);
  const qualityArtifactDestinationPaths = qualityArtifactPaths.filter(isAbsoluteArtifactEvidencePath);
  const qualityEvaluation = currentUnit
    ? evaluateTaskQuality({
      taskId: params.definition.taskId,
      title: params.definition.title,
      intent: params.definition.intent,
      unitId: currentUnit.id,
      executionProfileId: currentUnit.executionProfileId ?? 'analyze',
      qualityProfileId: currentUnit.qualityProfileId ?? null,
      workspaceDir: params.foundation.layout.forTask(params.definition.taskId).workspaceDir,
      artifactPaths: qualityArtifactPaths,
      artifactDestinationPaths: qualityArtifactDestinationPaths,
      artifactDestinationDir: null,
      latestVisibleOutput: latestAcceptedOutput
        ? {
          summary: typeof latestAcceptedOutput.parsedJson === 'object' && latestAcceptedOutput.parsedJson && 'summary' in latestAcceptedOutput.parsedJson
            ? String((latestAcceptedOutput.parsedJson as Record<string, unknown>).summary ?? '')
            : '',
          details: typeof latestAcceptedOutput.parsedJson === 'object' && latestAcceptedOutput.parsedJson && 'details' in latestAcceptedOutput.parsedJson
            ? String((latestAcceptedOutput.parsedJson as Record<string, unknown>).details ?? '')
            : null,
          issues: Array.isArray((latestAcceptedOutput.parsedJson as Record<string, unknown> | null)?.issues)
            ? ((latestAcceptedOutput.parsedJson as Record<string, unknown>).issues as unknown[])
              .filter((issue): issue is string => typeof issue === 'string')
            : []
        }
        : null,
      completionSummary: null,
      toolInvocations: params.latestToolInvocations
    })
    : {
      profileId: null,
      verdict: 'not_applicable' as const,
      passedChecks: [],
      failedChecks: [],
      requiredNextEvidence: [],
      lastEvaluatedAt: null
    };
  const qualityGateFailed = qualityEvaluation.profileId !== null && qualityEvaluation.verdict === 'failed';
  const qualityFailureMessages = qualityEvaluation.failedChecks.map((issue) => `quality_gate_failed:${issue}`);
  const qualityRequiredEvidenceMessages = qualityEvaluation.requiredNextEvidence.map((item) => `quality_required_evidence:${item}`);
  const qualityCorrectionKind = qualityGateFailed
    ? (qualityEvaluation.requiredNextEvidence.length > 0 ? 'AWAITING_TOOL_ACTION' : 'AWAITING_OUTPUT_CORRECTION')
    : params.phaseOutcome.orchestrated.acceptance.pendingCorrection;
  const diagnosticsAcceptance = params.phaseOutcome.diagnosticsAcceptance ?? params.phaseOutcome.orchestrated.acceptance;
  const effectiveAcceptance = deriveEffectiveAcceptanceState({
    currentUnit,
    diagnosticsAcceptance,
    latestToolInvocations: params.latestToolInvocations,
    acceptedTrackers: params.phaseOutcome.acceptedTrackers,
    qualityGateFailed
  });
  const effectivePendingCorrection = qualityGateFailed
    ? qualityCorrectionKind
    : effectiveAcceptance.pendingCorrection;
  const pendingInvocationIds = derivePendingInvocationIds({
    acceptedInvocationIds: params.phaseOutcome.plannedTools.acceptedInvocationIds,
    approvalInvocationIds: params.phaseOutcome.plannedTools.approvalInvocationIds,
    latestToolInvocations: params.latestToolInvocations
  });
  const runtimeWithAcceptedTrackers = params.phaseOutcome.acceptedTrackers.length === 0
    ? params.previousRuntime
    : (params.phaseOutcome.acceptedTrackers.length === 1
      ? applyTrackerState({
        definition: params.definition,
        runtime: params.previousRuntime,
        tracker: params.phaseOutcome.acceptedTrackers[0],
        acceptedInvocationIds: pendingInvocationIds.awaitingToolDispatch,
        approvalInvocationIds: pendingInvocationIds.awaitingApprovalInvocations,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        providerId: params.assembled.selectedProvider.id
      })
      : applyTrackerStates({
        definition: params.definition,
        runtime: params.previousRuntime,
        trackers: params.phaseOutcome.acceptedTrackers,
        acceptedInvocationIds: pendingInvocationIds.awaitingToolDispatch,
        approvalInvocationIds: pendingInvocationIds.awaitingApprovalInvocations,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        providerId: params.assembled.selectedProvider.id
      }));
  const nextRuntimeBase = params.phaseOutcome.orchestrated.acceptance.ok
    && params.phaseOutcome.acceptedTrackers.length > 0
    && !qualityGateFailed
    ? runtimeWithAcceptedTrackers
    : applyCorrectionState({
      definition: params.definition,
      runtime: runtimeWithAcceptedTrackers,
      currentUnitId: params.phaseOutcome.correctionUnitId,
      kind: effectivePendingCorrection,
      errors: qualityGateFailed
        ? [...qualityFailureMessages, ...qualityRequiredEvidenceMessages]
        : effectiveAcceptance.issueMessages,
      acceptedInvocationIds: pendingInvocationIds.awaitingToolDispatch,
      approvalInvocationIds: pendingInvocationIds.awaitingApprovalInvocations,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      providerId: params.assembled.selectedProvider.id
    });

  const updatedUserProfile = evolveUserPreferenceProfile({
    current: params.assembled.userProfile,
    userMessage: params.userMessage,
    selectedProviderId: params.assembled.selectedProvider.id
  });
  const updatedTaskMemory = evolveTaskMemory({
    current: params.previousRuntime.memory ?? null,
    userMessage: params.userMessage,
    acceptedTracker: params.phaseOutcome.acceptedTrackers.at(-1) ?? null,
    acceptedOutput: latestAcceptedOutput
      ? {
        unitId: latestAcceptedOutput.unitId,
        wrapper: latestAcceptedOutput.wrapper,
        raw: latestAcceptedOutput.raw,
        parsedJson: latestAcceptedOutput.parsedJson
      }
      : params.phaseOutcome.orchestrated.acceptance.acceptedOutput,
    selectedProviderId: params.assembled.selectedProvider.id,
    userProfile: updatedUserProfile
  });
  const nextPlannerDiagnostics = params.plannerService.summarizeTurn(params.definition, nextRuntimeBase);
  const acceptanceFailureCategory = qualityGateFailed
    ? 'quality_gate_failed'
    : effectiveAcceptance.failureCategory;
  const fallbackTurn = !params.plannerPreferred;
  const nextGuardrails = computeGuardrails({
    previousRuntime: params.previousRuntime,
    fallbackTurn,
    phaseOutcome: params.phaseOutcome
  });
  const currentTurnToolContextMessages = buildCurrentTurnToolContextMessages({
    invocations: params.latestToolInvocations,
    currentUnitId: params.currentUnitId,
    turnId: params.turnId,
    maxContentChars: Math.max(1200, Math.floor(params.foundation.config.runtime.promptSectionCharacterLimit * 2.5))
  });
  const nextContext = appendAndCompressLlmContext({
    config: params.foundation.config,
    current: params.assembled.contextMessages.messages,
    conservative: nextGuardrails.compressionDowngraded,
    additions: [
      createLlmContextMessage({
        role: 'assistant',
        content: params.providerResponseText,
        metadata: {
          unitId: params.currentUnitId
        }
      }),
      ...currentTurnToolContextMessages
    ]
  });
  const compressionPolicy = createContextCompressionPolicy({
    definition: params.definition,
    runtime: {
      ...nextRuntimeBase,
      activeStage: nextPlannerDiagnostics.activeStage,
      pendingToolBatches: params.phaseOutcome.pendingToolBatches,
      consolidationState: params.phaseOutcome.consolidationState,
      planner: {
        ...nextPlannerDiagnostics.planner,
        executionPhase: params.plannerPreferred ? 'CONSOLIDATING' : 'FALLBACK_SINGLE_ACTIVE'
      }
    },
    currentUnit: params.definition.units.find((unit) => unit.id === params.currentUnitId) ?? params.definition.units[0],
    validatedOutputs: params.assembled.selectedValidatedOutputs.records,
    memory: updatedTaskMemory
  });
  const nextRuntime: TaskRuntimeState = {
    ...nextRuntimeBase,
    planner: {
      ...nextPlannerDiagnostics.planner,
      executionPhase: params.plannerPreferred
        ? (params.phaseOutcome.consolidationState.status === 'COMPLETED' ? 'IDLE' : 'CONSOLIDATING')
        : 'FALLBACK_SINGLE_ACTIVE',
      fallbackReasons: params.plannerPreferred
        ? [...nextPlannerDiagnostics.planner.fallbackReasons]
        : [
          ...(params.latestRuntimeAfterProvider.planner?.fallbackReasons ?? []),
          'single_active_runtime_path'
        ],
      blockingReason: params.plannerPreferred && params.phaseOutcome.consolidationState.status === 'CORRECTION_REQUIRED'
        ? (params.phaseOutcome.pendingToolBatches.some((batch) => batch.status === 'FAILED' || batch.status === 'PARTIAL_APPROVAL_BLOCKED' || batch.status === 'DENIED')
          ? 'BATCH_BLOCKED'
          : 'CONSOLIDATION_BLOCKED')
        : nextPlannerDiagnostics.planner.blockingReason
    },
    activeStage: nextPlannerDiagnostics.activeStage,
    pendingToolBatches: params.phaseOutcome.pendingToolBatches,
    consolidationState: params.phaseOutcome.consolidationState,
    compressionPolicy: {
      mode: compressionPolicy.mode,
      preservedValidatedOutputUnitIds: [...compressionPolicy.preservedValidatedOutputUnitIds],
      preservedMemoryUnitIds: compressionPolicy.preservedMemoryUnitIds ? [...compressionPolicy.preservedMemoryUnitIds] : null,
      reasons: [...compressionPolicy.reasons]
    },
    contextGating: {
      ...params.assembled.contextGatingSummary,
      reasons: [...params.assembled.contextGatingSummary.reasons]
    },
    compressionDowngraded: nextGuardrails.compressionDowngraded,
    batchAdmissionDecisions: [...(params.phaseOutcome.batchAdmissionDecisions ?? [])].map((decision) => ({
      batchId: decision.batchId,
      stageIndex: decision.stageIndex,
      status: decision.status,
      admittedInvocationCount: decision.admittedInvocationKeys.length,
      rejectedInvocationCount: decision.rejectedInvocationKeys.length,
      rejectionReasons: [...decision.rejectionReasons]
    })),
    unsafeBatchRejectedCount:
      (params.previousRuntime.unsafeBatchRejectedCount ?? 0)
      + (params.phaseOutcome.batchAdmissionDecisions ?? []).reduce((total, decision) => total + decision.rejectedInvocationKeys.length, 0),
    guardrails: nextGuardrails,
    plannerFallbackRate: nextGuardrails.plannerFallbackRate,
    llmContextMessages: nextContext.messages,
    llmContextSnapshotRef: createContextSnapshotRef({
      kind: 'llm',
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      messageCount: nextContext.messages.length
    }),
    conversationSnapshotRef: createContextSnapshotRef({
      kind: 'conversation',
      sessionId: params.sessionId,
      turnId: params.turnId,
      checkpointId: params.checkpointId,
      messageCount: params.assembled.existingConversations.length + (params.userMessage?.trim() ? 3 : 2)
    }),
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
      phase: nextRuntimeBase.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'IDLE',
      leaseId: null,
      startedAt: params.previousRuntime.executionLease?.startedAt ?? null,
      replayable: true
    },
    safePoint: {
      stage: 'AFTER_PROVIDER',
      reachedAt: Date.now(),
      interruptible: true
    },
    memory: updatedTaskMemory,
    promptBudget: params.assembled.promptResult.budget,
    promptSectionAttribution: params.assembled.promptResult.budget.sectionPromptChars,
    stageMemorySummary: params.assembled.stageMemorySummary,
    capabilitySelectionSummary: params.assembled.capabilitySelectionSummary,
    retrievalSelectionSummary: params.assembled.retrievalSelectionSummary,
    contractDiagnostics: {
      ...(nextRuntimeBase.contractDiagnostics ?? {
        compatibilityFallbackCount: 0,
        topology: {
          rootUnitIds: [],
          issueCount: 0,
          stageCount: 0,
          currentStageIndex: null,
          batchGroupingHint: null,
          entryUnitIds: [],
          exitUnitIds: []
        },
        currentUnit: {
          unitId: nextRuntimeBase.currentUnitId,
          permissionLevel: null,
          requiresToolEvidence: false,
          contractSource: undefined,
          usedCompatibilityFallback: undefined,
          scopedUnitIds: null,
          memorySelectionSource: undefined,
          retrievalScopeSummary: undefined
          },
          lastExitCondition: null,
          lastAcceptanceFailureCategory: null,
          lastAcceptanceIssueCodes: [],
          lastAcceptanceIssueMessages: [],
          lastPendingCorrectionKind: null,
          lastCorrectionPromptMode: 'FULL_PROTOCOL',
          correctionLoopNonConvergent: false
        }),
      compatibilityFallbackCount: (params.previousRuntime.contractDiagnostics?.compatibilityFallbackCount ?? 0)
        + ((nextRuntimeBase.contractDiagnostics?.currentUnit.usedCompatibilityFallback ?? false) ? 1 : 0),
        lastExitCondition: {
          unitId: params.phaseOutcome.correctionUnitId,
          ok: diagnosticsAcceptance.exitCondition.ok,
          issueCodes: [...diagnosticsAcceptance.exitCondition.issueCodes],
          evaluatedAt: Date.now(),
          failureCategory: diagnosticsAcceptance.exitCondition.failureCategory
        },
        lastAcceptanceFailureCategory: acceptanceFailureCategory,
        lastAcceptanceIssueCodes: qualityGateFailed
          ? [
            ...qualityEvaluation.failedChecks.map((issue) => `quality:${issue}`),
            ...qualityEvaluation.requiredNextEvidence.map((item) => `quality_required:${item}`)
          ]
          : effectiveAcceptance.issueCodes,
        lastAcceptanceIssueMessages: qualityGateFailed
          ? [...qualityFailureMessages, ...qualityRequiredEvidenceMessages]
          : effectiveAcceptance.issueMessages,
        lastPendingCorrectionKind: qualityGateFailed ? qualityCorrectionKind : diagnosticsAcceptance.ok ? null : effectiveAcceptance.pendingCorrection,
        lastCorrectionPromptMode: deriveCorrectionPromptMode({
          pendingCorrection: qualityGateFailed ? qualityCorrectionKind : diagnosticsAcceptance.ok ? 'NONE' : effectiveAcceptance.pendingCorrection,
          failureCategory: acceptanceFailureCategory
      }),
      correctionLoopNonConvergent:
        (qualityGateFailed || !diagnosticsAcceptance.ok)
        && (nextGuardrails.correctionStreak >= 3)
        && (params.previousRuntime.contractDiagnostics?.lastPendingCorrectionKind === (qualityGateFailed ? qualityCorrectionKind : effectiveAcceptance.pendingCorrection))
        && (params.previousRuntime.contractDiagnostics?.lastAcceptanceFailureCategory === acceptanceFailureCategory)
    },
    contextCompressionCount: params.previousRuntime.contextCompressionCount
      + (params.assembled.contextMessages.compressed ? 1 : 0)
      + (nextContext.compressed ? 1 : 0)
  };
  if (
    !qualityGateFailed
    && effectiveAcceptance.pendingCorrection !== 'NONE'
    && nextRuntime.pendingCorrection === 'NONE'
    && nextRuntime.lifecycleStatus === 'RUNNING'
    && nextRuntime.currentUnitId === params.phaseOutcome.correctionUnitId
  ) {
    nextRuntime.pendingCorrection = effectiveAcceptance.pendingCorrection;
    const unit = nextRuntime.schedulerUnits[params.phaseOutcome.correctionUnitId];
    if (unit) {
      unit.invalidOutputErrors = effectiveAcceptance.issueMessages.length > 0
        ? [...effectiveAcceptance.issueMessages]
        : [...unit.invalidOutputErrors];
      nextRuntime.invalidOutputUnits[params.phaseOutcome.correctionUnitId] = [...unit.invalidOutputErrors];
    }
    if (nextRuntime.contractDiagnostics) {
      nextRuntime.contractDiagnostics.lastAcceptanceFailureCategory = acceptanceFailureCategory;
      nextRuntime.contractDiagnostics.lastAcceptanceIssueCodes = [...effectiveAcceptance.issueCodes];
      nextRuntime.contractDiagnostics.lastAcceptanceIssueMessages = [...effectiveAcceptance.issueMessages];
      nextRuntime.contractDiagnostics.lastPendingCorrectionKind = effectiveAcceptance.pendingCorrection;
      nextRuntime.contractDiagnostics.lastCorrectionPromptMode = deriveCorrectionPromptMode({
        pendingCorrection: effectiveAcceptance.pendingCorrection,
        failureCategory: acceptanceFailureCategory
      });
    }
  }
  nextRuntime.promptBudget = {
    ...nextRuntime.promptBudget,
    estimatedPromptCharacters: params.assembled.estimatedPromptCharacters,
    estimatedPromptTokens: Math.ceil(params.assembled.estimatedPromptCharacters / 4),
    estimatedBaselineCharacters: params.assembled.estimatedBaselineCharacters,
    estimatedBaselineTokens: Math.ceil(params.assembled.estimatedBaselineCharacters / 4),
    estimatedReductionRatio: params.assembled.estimatedReductionRatio,
    rawContextCharacters: params.assembled.contextGatingSummary.rawContextCharacters,
    gatedContextCharacters: params.assembled.contextGatingSummary.gatedContextCharacters,
    rawContextTokens: Math.ceil(params.assembled.contextGatingSummary.rawContextCharacters / 4),
    gatedContextTokens: Math.ceil(params.assembled.contextGatingSummary.gatedContextCharacters / 4),
    estimatedHistoryReductionRatio: params.assembled.contextGatingSummary.estimatedContextReductionRatio,
    estimatedSectionReductionRatio: params.assembled.promptResult.budget.estimatedSectionReductionRatio,
    cacheablePrefixChars: params.assembled.promptResult.budget.cacheablePrefixChars,
    stablePrefixChars: params.assembled.promptResult.budget.stablePrefixChars,
    volatileSuffixChars: params.assembled.promptResult.budget.volatileSuffixChars,
    stablePrefixRatio: params.assembled.promptResult.budget.stablePrefixRatio,
    retrievedContextCount: params.assembled.selectedValidatedOutputs.retrievedContextCount,
    policyFilteredOutputCount: params.assembled.selectedValidatedOutputs.policyFilteredOutputCount,
    operatorInputCount: params.assembled.pendingOperatorInputs.length
  };

  if (
    params.latestRuntimeAfterProvider.interrupt.cancelRequested
    || params.latestRuntimeAfterProvider.interrupt.interruptRequested
    || params.latestRuntimeAfterProvider.interrupt.pauseRequested
  ) {
    if (!nextRuntime.executionLease) {
      nextRuntime.executionLease = {
        active: false,
        phase: 'IDLE',
        leaseId: null,
        startedAt: null,
        replayable: true
      };
    }
    
    if (params.latestRuntimeAfterProvider.interrupt.cancelRequested) {
      nextRuntime.lifecycleStatus = 'CANCELLED';
      nextRuntime.engineStatus = 'FAILED';
      nextRuntime.currentUnitId = null;
      nextRuntime.executionLease.phase = 'INTERRUPTED';
    } else {
      nextRuntime.lifecycleStatus = 'PAUSED';
      nextRuntime.engineStatus = 'PAUSED';
      nextRuntime.executionLease.phase = 'PAUSED';
    }
    nextRuntime.executionLease.active = false;
    nextRuntime.interrupt = {
      pauseRequested: false,
      interruptRequested: false,
      cancelRequested: false,
      requestedAt: null,
      reason: params.latestRuntimeAfterProvider.interrupt.reason
    };
  }

  return {
    nextRuntime,
    updatedUserProfile
  };
}
