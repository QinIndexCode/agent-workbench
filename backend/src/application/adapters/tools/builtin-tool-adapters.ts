import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ExtensionRegistry } from '../../../foundation/extensions/registry';
import { AgentToolDefinition } from '../../../foundation/extensions/types';
import { BackendNewConfig } from '../../../foundation/config/types';
import { BackendNewFoundation } from '../../../foundation/bootstrap/types';
import { StorageLayout } from '../../../foundation/storage/layout';
import { ToolExecutorRegistry } from '../../../foundation/tools/executor-registry';
import { ToolExecutorRequest } from '../../../foundation/tools/executor-types';
import { createToolFailureResult, createToolSuccessResult } from '../../../foundation/tools/result-envelope';
import { DelegatedSubtaskService } from '../../tasks/delegation/delegated-subtask-service';

const BUILTIN_TOOLS: AgentToolDefinition[] = [
  {
    id: 'read-file',
    name: 'read_file',
    description: 'Read a UTF-8 text file from the task workspace. When the operator explicitly requests a local absolute path, that absolute local path is also allowed.',
    source: 'builtin',
    effect: 'READ',
    riskLevel: 'LOW',
    inputSchema: [
      { name: 'path', type: 'string', required: true, description: 'Relative file path inside the task workspace, or an explicit local absolute path.' },
      { name: 'start_line', type: 'number', description: 'Optional 1-based inclusive start line for segmented reads.' },
      { name: 'end_line', type: 'number', description: 'Optional 1-based inclusive end line for segmented reads.' },
      { name: 'max_chars', type: 'number', description: 'Optional maximum number of characters to return after line-range selection.' }
    ],
    tags: ['workspace', 'file']
  },
  {
    id: 'write-file',
    name: 'write_file',
    description: 'Write a UTF-8 text file into the task workspace. When the operator explicitly requests a local absolute path, that absolute local path is also allowed.',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [
      { name: 'path', type: 'string', required: true, description: 'Relative file path inside the task workspace, or an explicit local absolute path.' },
      { name: 'content', type: 'string', description: 'File content to write as a single string.' },
      { name: 'content_lines', type: 'array', description: 'Optional array of UTF-8 lines to join with newlines before writing. Prefer this for large markdown or code files.' },
      { name: 'content_json', type: 'object', description: 'Optional structured JSON object to pretty-print before writing. Prefer this for JSON manifests to avoid large escaped strings.' }
    ],
    tags: ['workspace', 'file']
  },
  {
    id: 'create-folder',
    name: 'create_folder',
    description: 'Create a folder inside the task workspace. When the operator explicitly requests a local absolute path, that absolute local path is also allowed.',
    source: 'builtin',
    effect: 'WRITE',
    riskLevel: 'MEDIUM',
    inputSchema: [
      { name: 'path', type: 'string', required: true, description: 'Relative folder path inside the task workspace, or an explicit local absolute path.' }
    ],
    tags: ['workspace', 'file']
  },
  {
    id: 'list-files',
    name: 'list_files',
    description: 'List files inside the task workspace. When the operator explicitly requests a local absolute path, that absolute local path is also allowed.',
    source: 'builtin',
    effect: 'READ',
    riskLevel: 'LOW',
    inputSchema: [
      { name: 'path', type: 'string', description: 'Relative directory path inside the task workspace, or an explicit local absolute path.' },
      { name: 'recursive', type: 'boolean', description: 'Whether to traverse subdirectories.' }
    ],
    tags: ['workspace', 'file']
  },
  {
    id: 'search-files',
    name: 'search_files',
    description: 'Search for a plain-text pattern inside workspace files. When the operator explicitly requests a local absolute path, that absolute local path is also allowed.',
    source: 'builtin',
    effect: 'READ',
    riskLevel: 'LOW',
    inputSchema: [
      { name: 'pattern', type: 'string', required: true, description: 'Pattern to search for.' },
      { name: 'path', type: 'string', description: 'Relative directory path inside the task workspace, or an explicit local absolute path.' },
      { name: 'case_sensitive', type: 'boolean', description: 'Whether the search is case sensitive.' }
    ],
    tags: ['workspace', 'search']
  },
  {
    id: 'run-command',
    name: 'run_command',
    description: 'Run a local shell command for real host or workspace verification. cwd defaults to the task workspace and may also be an absolute local path when explicit operator intent requires it. Commands must stay non-interactive; on Windows provide the raw PowerShell pipeline directly, such as Get-Process or Get-CimInstance, rather than wrapping it in powershell -Command.',
    source: 'builtin',
    effect: 'PROCESS',
    riskLevel: 'MEDIUM',
    inputSchema: [
      { name: 'command', type: 'string', required: true, description: 'Shell command to execute.' },
      { name: 'cwd', type: 'string', description: 'Optional working directory. Relative paths resolve inside the task workspace; absolute local paths are allowed when explicitly requested.' },
      { name: 'timeout_ms', type: 'number', description: 'Optional command timeout in milliseconds. Clamped for safety.' }
    ],
    tags: ['workspace', 'host', 'command']
  },
  {
    id: 'delegate-subtask',
    name: 'delegate_subtask',
    description: 'Create and run one controlled delegated child task within the parent thread boundary. When the prompt includes a required delegation contract, use that child contract before parent delivery continues.',
    source: 'builtin',
    effect: 'PROCESS',
    riskLevel: 'MEDIUM',
    inputSchema: [
      { name: 'title', type: 'string', description: 'Short delegated task title. Reuse the required child contract title when one is provided.' },
      { name: 'role', type: 'string', description: 'Delegated child role. Reuse the required child contract role when one is provided.' },
      { name: 'goal', type: 'string', description: 'What the child task must accomplish within the bounded scope.' },
      { name: 'taskScope', type: 'string', description: 'Bounded scope for the child task. Keep the child inside workspace-only execution.' },
      { name: 'outputContract', type: 'object', description: 'Structured output contract for the child task. Reuse the required contract if the prompt provides one.' },
      { name: 'allowedToolIds', type: 'array', description: 'Allowed tool ids inherited from the parent boundary. Must remain a strict child-safe subset.' },
      { name: 'successCriteria', type: 'string', description: 'Short done condition for the delegated child.' }
    ],
    tags: ['delegation', 'subtask']
  }
];

function createLayout(config: BackendNewConfig): StorageLayout {
  return new StorageLayout(config);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

async function walkFiles(rootDir: string, recursive: boolean): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const resolved = path.join(rootDir, entry.name);
    if (entry.isFile()) {
      files.push(resolved);
      continue;
    }
    if (recursive && entry.isDirectory()) {
      files.push(...await walkFiles(resolved, true));
    }
  }

  return files;
}

function getWorkspacePath(request: ToolExecutorRequest, relativePath: string | undefined): {
  layout: StorageLayout;
  workspaceRoot: string;
  resolvedPath: string;
} {
  const layout = createLayout(request.context.config);
  const workspaceRoot = layout.forTask(request.invocation.taskId).workspaceDir;
  const resolvedPath = layout.resolveWorkspacePath(request.invocation.taskId, relativePath?.trim() || '.');
  return {
    layout,
    workspaceRoot,
    resolvedPath
  };
}

function normalizePathForToolOutput(baseDir: string, resolvedPath: string, params?: { absolute?: boolean }): string {
  if (params?.absolute) {
    return normalizeRelativePath(path.resolve(resolvedPath));
  }
  const relativePath = path.relative(baseDir, resolvedPath);
  return normalizeRelativePath(relativePath || '.');
}

function getAccessiblePath(request: ToolExecutorRequest, targetPath: string | undefined): {
  layout: StorageLayout;
  workspaceRoot: string;
  resolvedPath: string;
  absolutePathRequested: boolean;
} {
  const layout = createLayout(request.context.config);
  const workspaceRoot = layout.forTask(request.invocation.taskId).workspaceDir;
  const trimmedPath = targetPath?.trim() || '.';
  if (path.isAbsolute(trimmedPath)) {
    return {
      layout,
      workspaceRoot,
      resolvedPath: path.resolve(trimmedPath),
      absolutePathRequested: true
    };
  }
  return {
    layout,
    workspaceRoot,
    resolvedPath: layout.resolveWorkspacePath(request.invocation.taskId, trimmedPath),
    absolutePathRequested: false
  };
}

function isQualityJsonEvidencePath(filePath: string): boolean {
  const normalized = normalizeRelativePath(path.resolve(filePath)).toLowerCase();
  return /(?:^|\/)quality\/[^/]+\.json$/.test(normalized);
}

function parsePositiveIntegerArgument(args: Record<string, unknown>, key: string): { value: number | null; error: string | null } {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') {
    return { value: null, error: null };
  }
  if (!Number.isInteger(raw) || Number(raw) <= 0) {
    return {
      value: null,
      error: `"${key}" must be a positive integer when provided.`
    };
  }
  return { value: Number(raw), error: null };
}

export function buildReadFileToolOutput(params: {
  path: string;
  content: string;
  argumentsRecord: Record<string, unknown>;
}) {
  const startLineResult = parsePositiveIntegerArgument(params.argumentsRecord, 'start_line');
  if (startLineResult.error) {
    throw new Error(startLineResult.error);
  }
  const endLineResult = parsePositiveIntegerArgument(params.argumentsRecord, 'end_line');
  if (endLineResult.error) {
    throw new Error(endLineResult.error);
  }
  const maxCharsResult = parsePositiveIntegerArgument(params.argumentsRecord, 'max_chars');
  if (maxCharsResult.error) {
    throw new Error(maxCharsResult.error);
  }

  const lines = params.content.split(/\r?\n/);
  const totalLines = lines.length;
  const totalChars = params.content.length;
  const startLine = startLineResult.value ?? 1;
  const endLine = endLineResult.value ?? totalLines;
  if (startLine > endLine) {
    throw new Error('"start_line" must be less than or equal to "end_line".');
  }
  if (startLine > totalLines) {
    throw new Error(`"start_line" (${startLine}) exceeds the file length (${totalLines} line(s)).`);
  }

  const normalizedEndLine = Math.min(endLine, totalLines);
  let selectedContent = lines.slice(startLine - 1, normalizedEndLine).join('\n');
  let truncated = normalizedEndLine < totalLines;
  const maxChars = maxCharsResult.value;
  if (maxChars !== null && selectedContent.length > maxChars) {
    selectedContent = selectedContent.slice(0, maxChars);
    truncated = true;
  }

  return {
    path: params.path,
    content: selectedContent,
    totalChars,
    selectedChars: selectedContent.length,
    truncated,
    selection: {
      startLine,
      endLine: normalizedEndLine,
      totalLines,
      maxChars
    }
  };
}

export function validateBuiltinWriteFileContent(filePath: string, content: string): string | null {
  if (!isQualityJsonEvidencePath(filePath)) {
    return null;
  }
  try {
    JSON.parse(content);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown JSON parse failure.';
    return `Invalid JSON for quality evidence file "${normalizeRelativePath(path.resolve(filePath))}": ${reason}`;
  }
}

export function resolveBuiltinWriteFileContent(argumentsRecord: Record<string, unknown>): {
  content: string | null;
  error: string | null;
} {
  const directContent = argumentsRecord.content;
  const contentLines = argumentsRecord.content_lines;
  const contentJson = argumentsRecord.content_json;

  const hasDirectContent = typeof directContent === 'string';
  const hasContentLines = Array.isArray(contentLines);
  const hasContentJson = !!contentJson && typeof contentJson === 'object' && !Array.isArray(contentJson);

  const providedCount = [hasDirectContent, hasContentLines, hasContentJson].filter(Boolean).length;
  if (providedCount === 0) {
    return {
      content: null,
      error: 'write_file requires exactly one of "content", "content_lines", or "content_json".'
    };
  }
  if (providedCount > 1) {
    return {
      content: null,
      error: 'write_file accepts only one content source at a time: "content", "content_lines", or "content_json".'
    };
  }

  if (hasDirectContent) {
    return {
      content: directContent,
      error: null
    };
  }

  if (hasContentLines) {
    if (!contentLines.every((entry) => typeof entry === 'string')) {
      return {
        content: null,
        error: '"content_lines" must be an array of strings.'
      };
    }
    return {
      content: contentLines.join('\n'),
      error: null
    };
  }

  return {
    content: `${JSON.stringify(contentJson, null, 2)}\n`,
    error: null
  };
}

export function validateBuiltinRunCommandSafety(command: string): string | null {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) {
    return 'Command must not be empty.';
  }
  if (isDestructiveCommand(trimmed)) {
    return `Command is blocked by the builtin run_command safety policy: ${trimmed}`;
  }
  return getInteractiveCommandBlockReason(trimmed);
}

function truncateCommandText(value: string, limit = 4000): string {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function getCommandArgument(argumentsRecord: Record<string, unknown>): string {
  const direct = argumentsRecord.command;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const legacy = argumentsRecord.cmd;
  if (typeof legacy === 'string' && legacy.trim()) {
    return legacy.trim();
  }
  return '';
}

function getCommandCwdArgument(argumentsRecord: Record<string, unknown>): unknown {
  return argumentsRecord.cwd
    ?? argumentsRecord.working_directory
    ?? argumentsRecord.workingDirectory
    ?? null;
}

function unquoteShellValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractInlineCwd(command: string): { command: string; cwdOverride: string | null } {
  const trimmed = command.trim();
  const matchers = [
    /^cd\s+\/d\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]+)$/i,
    /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]+)$/i,
    /^Set-Location\s+("[^"]+"|'[^']+'|\S+)\s*;\s*([\s\S]+)$/i
  ];
  for (const matcher of matchers) {
    const match = trimmed.match(matcher);
    if (!match) {
      continue;
    }
    return {
      cwdOverride: unquoteShellValue(match[1]),
      command: match[2].trim()
    };
  }
  return {
    cwdOverride: null,
    command: trimmed
  };
}

function resolveCommandCwd(request: ToolExecutorRequest, cwdValue: unknown): string {
  if (typeof cwdValue !== 'string' || !cwdValue.trim()) {
    return getWorkspacePath(request, '.').workspaceRoot;
  }
  const trimmed = cwdValue.trim();
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return getWorkspacePath(request, trimmed).resolvedPath;
}

function getCommandTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60_000;
  }
  return Math.min(Math.max(parsed, 1_000), 180_000);
}

function isDestructiveCommand(command: string): boolean {
  if (/\b(?:rm|rmdir|del|erase|mkfs|shutdown|restart-computer|stop-computer|remove-item|clear-disk|diskpart|reg\s+delete)\b/i.test(command)) {
    return true;
  }
  return /(^|[\s;|&])format(?:\s|$)/i.test(command);
}

function normalizeUnixProbeFallback(command: string): string {
  return command
    .trim()
    .replace(/\s+2>\/dev\/null\b/gi, '')
    .replace(/\s+\|\|\s+echo\s+(?:"[^"]*"|'[^']*'|\S+)\s*$/i, '')
    .replace(/\s+\|\|\s+uname(?:\s+-[a-z]+)*\s*$/i, '')
    .trim();
}

function translateWindowsCommand(command: string): { command: string; usePowerShell: boolean } {
  const unwrappedPowerShell = unwrapNestedPowerShellCommand(command);
  if (unwrappedPowerShell) {
    return {
      command: unwrappedPowerShell,
      usePowerShell: true
    };
  }

  const portableProbe = normalizeUnixProbeFallback(command);
  if (/^uname(?:\s+-[a-z]+)*\s*$/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | Format-List',
      usePowerShell: true
    };
  }
  if (/^free(?:\s+-[a-z0-9]+)*\s*$/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | Format-List',
      usePowerShell: true
    };
  }
  if (/^systeminfo(?:\s+.*)?$/i.test(portableProbe)) {
    return {
      command: '$os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; [pscustomobject]@{ CSName = $os.CSName; Caption = $os.Caption; Version = $os.Version; BuildNumber = $os.BuildNumber; OSArchitecture = $os.OSArchitecture; Manufacturer = $cs.Manufacturer; Model = $cs.Model; TotalPhysicalMemoryMb = [math]::Round($cs.TotalPhysicalMemory / 1MB, 2); FreePhysicalMemoryMb = [math]::Round($os.FreePhysicalMemory / 1024, 2); LastBootUpTime = $os.LastBootUpTime } | Format-List',
      usePowerShell: true
    };
  }
  if (/^df(?:\s+-[a-z0-9]+)*(?:\s+(?:\/|[A-Za-z]:\\?)?)?\s*$/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,FreeSpace,Size | Format-Table -AutoSize',
      usePowerShell: true
    };
  }
  if (/^nproc\b/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum | Select-Object -ExpandProperty Sum',
      usePowerShell: true
    };
  }
  if (/^uptime\b/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime | Format-List',
      usePowerShell: true
    };
  }
  if (/^cat\s+\/proc\/loadavg\b/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_Processor | Select-Object -First 1 LoadPercentage | Format-List',
      usePowerShell: true
    };
  }
  if (/^cat\s+\/proc\/cpuinfo\b/i.test(portableProbe)) {
    return {
      command: 'Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List',
      usePowerShell: true
    };
  }
  if (/^top\b/i.test(portableProbe)) {
    return {
      command: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 ProcessName,Id,CPU,WS',
      usePowerShell: true
    };
  }
  if (/^ps\s+aux\b/i.test(portableProbe)) {
    return {
      command: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 10 ProcessName,Id,CPU,WS',
      usePowerShell: true
    };
  }

  const lsMatch = command.match(/^ls(?:\s+-[A-Za-z]+)*\s*(.+)?$/i);
  if (lsMatch) {
    const target = (lsMatch[1] ?? '.').trim() || '.';
    const escapedTarget = target.replace(/'/g, "''");
    return {
      command: `Get-ChildItem -Force -LiteralPath '${escapedTarget}' | Select-Object Mode,Length,LastWriteTime,Name`,
      usePowerShell: true
    };
  }

  if (/^pwd\s*$/i.test(command)) {
    return {
      command: 'Get-Location | Select-Object -ExpandProperty Path',
      usePowerShell: true
    };
  }

  const catMatch = command.match(/^cat\s+(.+)$/i);
  if (catMatch) {
    const target = catMatch[1].trim();
    const escapedTarget = target.replace(/'/g, "''");
    return {
      command: `Get-Content -Raw -LiteralPath '${escapedTarget}'`,
      usePowerShell: true
    };
  }

  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/i);
  if (mkdirMatch) {
    const target = mkdirMatch[1].trim();
    const escapedTarget = target.replace(/'/g, "''");
    return {
      command: `New-Item -ItemType Directory -Force -Path '${escapedTarget}' | Out-Null`,
      usePowerShell: true
    };
  }

  const processSnapshotMatch = command.match(/^ps\s+aux(?:\s*\|\s*head\s*-?(\d+))?\s*$/i);
  if (processSnapshotMatch) {
    const count = Number.parseInt(processSnapshotMatch[1] ?? '20', 10);
    return {
      command: `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${Number.isFinite(count) && count > 0 ? count : 20} ProcessName,Id,CPU,WS`,
      usePowerShell: true
    };
  }
  return {
    command,
    usePowerShell: false
  };
}

function unwrapNestedPowerShellCommand(command: string): string | null {
  const trimmed = command.trim();
  const shellMatch = trimmed.match(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b\s+([\s\S]+)$/i);
  if (!shellMatch) {
    return null;
  }

  const commandArgument = extractPowerShellCommandArgument(shellMatch[1]);
  return commandArgument && commandArgument.trim() ? commandArgument.trim() : null;
}

function extractPowerShellCommandArgument(argumentsText: string): string | null {
  const commandFlagMatch = argumentsText.match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i);
  if (!commandFlagMatch) {
    return null;
  }

  const candidate = commandFlagMatch[1].trim();
  if (!candidate) {
    return null;
  }

  return unwrapShellQuotedArgument(candidate);
}

function unwrapShellQuotedArgument(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if ((quote !== '"' && quote !== '\'') || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }

  const unquoted = trimmed.slice(1, -1);
  if (quote === '"') {
    return unquoted
      .replace(/\\"/g, '"')
      .replace(/`"/g, '"');
  }
  return unquoted.replace(/''/g, '\'');
}

function shouldUsePowerShellOnWindows(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(?:"[A-Za-z]:\\[^"]+\.exe"|'[A-Za-z]:\\[^']+\.exe'|[A-Za-z]:\\\S+\.exe)\b/i.test(trimmed)) {
    return true;
  }
  if (/\bnode(?:\.exe)?\b[\s\S]*\s-e\s/i.test(trimmed)) {
    return true;
  }
  if (/^(Get-|Set-|New-Item|Out-Null|Set-Location|Test-Path|Start-Process|Stop-Process|Get-CimInstance|Get-Service|Get-ChildItem|Get-Content|Get-Location|Select-String)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(Write-Output|Write-Error|Write-Host)\b/i.test(trimmed)) {
    return true;
  }
  return /\b(Get-Process|Get-Content|Get-Location|Set-Content|Sort-Object|Where-Object|Select-Object|Format-Table|Out-String|Get-CimInstance|Get-Service|New-Item|Write-Output|Write-Error|Write-Host)\b/i.test(trimmed);
}

function normalizePowerShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^&\s+/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:"[A-Za-z]:\\[^"]+\.exe"|'[A-Za-z]:\\[^']+\.exe'|[A-Za-z]:\\\S+\.exe)\b/i.test(trimmed)) {
    return `& ${trimmed}`;
  }
  return trimmed;
}

function resolveWindowsShellExecutable(kind: 'powershell' | 'cmd'): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  if (kind === 'cmd') {
    return process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe');
  }
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function getInteractiveCommandBlockReason(command: string): string | null {
  if (/\bmysql\b/i.test(command) && (/(^|\s)-p(\s|$|")/.test(command) || /--password(?:(?:\s|=)("|')?\s*("|')?)?(\s|$)/i.test(command))) {
    return 'MySQL commands must stay non-interactive. Do not use standalone -p or --password without a value; use a non-interactive verification command instead.';
  }
  return null;
}

async function executeReadFile(request: ToolExecutorRequest) {
  try {
    const filePath = String(request.invocation.arguments.path ?? '');
    const { workspaceRoot, resolvedPath, absolutePathRequested } = getAccessiblePath(request, filePath);
    const content = await fs.readFile(resolvedPath, request.context.config.storage.encoding);
    const normalizedPath = normalizePathForToolOutput(workspaceRoot, resolvedPath, { absolute: absolutePathRequested });
    return createToolSuccessResult({
      output: buildReadFileToolOutput({
        path: normalizedPath,
        content,
        argumentsRecord: request.invocation.arguments
      })
    });
  } catch (error) {
    return createToolFailureResult({
      kind: error instanceof Error && /start_line|end_line|max_chars/i.test(error.message)
        ? 'EXECUTION'
        : 'NOT_FOUND',
      message: error instanceof Error ? error.message : 'Unable to read file.'
    });
  }
}

async function executeWriteFile(request: ToolExecutorRequest) {
  try {
    const filePath = String(request.invocation.arguments.path ?? '');
    const contentResolution = resolveBuiltinWriteFileContent(request.invocation.arguments);
    if (contentResolution.error) {
      return createToolFailureResult({
        kind: 'EXECUTION',
        message: contentResolution.error
      });
    }
    const content = contentResolution.content ?? '';
    const { workspaceRoot, resolvedPath, absolutePathRequested } = getAccessiblePath(request, filePath);
    const validationError = validateBuiltinWriteFileContent(resolvedPath, content);
    if (validationError) {
      return createToolFailureResult({
        kind: 'EXECUTION',
        message: validationError,
        metadata: {
          path: normalizePathForToolOutput(workspaceRoot, resolvedPath, { absolute: absolutePathRequested })
        }
      });
    }
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, content, request.context.config.storage.encoding);
    return createToolSuccessResult({
      output: {
        path: normalizePathForToolOutput(workspaceRoot, resolvedPath, { absolute: absolutePathRequested }),
        bytesWritten: Buffer.byteLength(content, request.context.config.storage.encoding)
      }
    });
  } catch (error) {
    return createToolFailureResult({
      kind: 'EXECUTION',
      message: error instanceof Error ? error.message : 'Unable to write file.'
    });
  }
}

async function executeCreateFolder(request: ToolExecutorRequest) {
  try {
    const folderPath = String(request.invocation.arguments.path ?? '');
    const { workspaceRoot, resolvedPath, absolutePathRequested } = getAccessiblePath(request, folderPath);
    await fs.mkdir(resolvedPath, { recursive: true });
    return createToolSuccessResult({
      output: {
        path: normalizePathForToolOutput(workspaceRoot, resolvedPath, { absolute: absolutePathRequested }),
        created: true
      }
    });
  } catch (error) {
    return createToolFailureResult({
      kind: 'EXECUTION',
      message: error instanceof Error ? error.message : 'Unable to create folder.'
    });
  }
}

async function executeListFiles(request: ToolExecutorRequest) {
  try {
    const basePath = typeof request.invocation.arguments.path === 'string'
      ? request.invocation.arguments.path
      : '.';
    const recursive = request.invocation.arguments.recursive === true;
    const { workspaceRoot, resolvedPath, absolutePathRequested } = getAccessiblePath(request, basePath);
    const files = await walkFiles(resolvedPath, recursive);
    const responseRoot = absolutePathRequested ? resolvedPath : workspaceRoot;
    return createToolSuccessResult({
      output: {
        path: normalizePathForToolOutput(responseRoot, resolvedPath, { absolute: absolutePathRequested }),
        files: files.map(filePath => normalizePathForToolOutput(responseRoot, filePath, { absolute: absolutePathRequested }))
      }
    });
  } catch (error) {
    return createToolFailureResult({
      kind: 'NOT_FOUND',
      message: error instanceof Error ? error.message : 'Unable to list files.'
    });
  }
}

async function executeSearchFiles(request: ToolExecutorRequest) {
  try {
    const basePath = typeof request.invocation.arguments.path === 'string'
      ? request.invocation.arguments.path
      : '.';
    const pattern = String(request.invocation.arguments.pattern ?? '');
    const caseSensitive = request.invocation.arguments.case_sensitive === true;
    const { workspaceRoot, resolvedPath, absolutePathRequested } = getAccessiblePath(request, basePath);
    const files = await walkFiles(resolvedPath, true);
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
    const responseRoot = absolutePathRequested ? resolvedPath : workspaceRoot;

    for (const filePath of files) {
      if (matches.length >= 200) {
        break;
      }
      const content = await fs.readFile(filePath, request.context.config.storage.encoding).catch(() => null);
      if (typeof content !== 'string') {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push({
            path: normalizePathForToolOutput(responseRoot, filePath, { absolute: absolutePathRequested }),
            lineNumber: index + 1,
            line
          });
          if (matches.length >= 200) {
            break;
          }
        }
      }
    }

    return createToolSuccessResult({
      output: {
        pattern,
        matches
      }
    });
  } catch (error) {
    return createToolFailureResult({
      kind: 'EXECUTION',
      message: error instanceof Error ? error.message : 'Unable to search files.'
    });
  }
}

async function executeRunCommand(request: ToolExecutorRequest) {
  const invocationArgs = request.invocation.arguments as Record<string, unknown>;
  const initialCommand = getCommandArgument(invocationArgs);
  const safetyError = validateBuiltinRunCommandSafety(initialCommand);
  if (safetyError) {
    return createToolFailureResult({
      kind: /builtin run_command safety policy/i.test(safetyError) ? 'PERMISSION' : 'EXECUTION',
      message: safetyError,
      metadata: {
        originalCommand: initialCommand,
        command: initialCommand,
        effectiveCommand: initialCommand,
        exitCode: null,
        stdout: '',
        stderr: safetyError,
        durationMs: 0,
        timedOut: false
      }
    });
  }
  const extractedInlineCwd = extractInlineCwd(initialCommand);
  const command = extractedInlineCwd.command;

  try {
    const cwd = resolveCommandCwd(request, getCommandCwdArgument(invocationArgs) ?? extractedInlineCwd.cwdOverride);
    const workspaceRoot = getWorkspacePath(request, '.').workspaceRoot;
    if (path.resolve(cwd).startsWith(path.resolve(workspaceRoot))) {
      await fs.mkdir(cwd, { recursive: true });
    }
    const timeoutMs = getCommandTimeoutMs(request.invocation.arguments.timeout_ms);
    const startedAt = Date.now();
    const translatedWindowsCommand = process.platform === 'win32'
      ? translateWindowsCommand(command)
      : { command, usePowerShell: false };
    const effectiveCommand = translatedWindowsCommand.command;
    const usePowerShell = process.platform === 'win32'
      ? translatedWindowsCommand.usePowerShell || shouldUsePowerShellOnWindows(effectiveCommand)
      : false;
    const shellKind = process.platform === 'win32'
      ? (usePowerShell ? 'powershell' : 'cmd')
      : 'sh';

    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      durationMs: number;
    }>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      let child;
      try {
        if (process.platform === 'win32') {
          const shellCommand = usePowerShell ? normalizePowerShellCommand(effectiveCommand) : effectiveCommand;
          child = spawn(
            resolveWindowsShellExecutable(usePowerShell ? 'powershell' : 'cmd'),
            usePowerShell
              ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', shellCommand]
              : ['/d', '/s', '/c', shellCommand],
            {
              cwd,
              shell: false,
              windowsHide: true,
              env: {
                ...process.env,
                SCC_TASK_ID: request.invocation.taskId,
                SCC_UNIT_ID: request.invocation.unitId,
                SCC_TASK_WORKSPACE: getWorkspacePath(request, '.').workspaceRoot
              }
            }
          );
        } else {
          child = spawn('/bin/sh', ['-lc', effectiveCommand], {
            cwd,
            shell: false,
            windowsHide: true,
            env: {
              ...process.env,
              SCC_TASK_ID: request.invocation.taskId,
              SCC_UNIT_ID: request.invocation.unitId,
              SCC_TASK_WORKSPACE: getWorkspacePath(request, '.').workspaceRoot
            }
          });
        }
      } catch (error) {
        resolve({
          exitCode: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
          durationMs: Date.now() - startedAt
        });
        return;
      }

      const finish = (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt
        });
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        stderr += `${stderr ? '\n' : ''}${error.message}`;
        finish(null);
      });
      child.on('close', (code) => {
        finish(typeof code === 'number' ? code : null);
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        stderr += `${stderr ? '\n' : ''}Command timed out after ${timeoutMs}ms.`;
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore'
          });
          return;
        }
        try {
          child.kill();
        } catch {
          finish(null);
        }
      }, timeoutMs);
    });

    if (result.exitCode !== 0 || result.timedOut) {
      return createToolFailureResult({
        kind: result.timedOut ? 'TIMEOUT' : 'EXECUTION',
        message: result.timedOut
          ? `Command timed out after ${timeoutMs}ms.`
          : `Command failed with exit code ${result.exitCode ?? 'unknown'}.`,
        metadata: {
          originalCommand: initialCommand,
          requestedCommand: command,
          command: effectiveCommand,
          effectiveCommand,
          cwd,
          timeoutMs,
          exitCode: result.exitCode,
          stdout: truncateCommandText(result.stdout),
          stderr: truncateCommandText(result.stderr),
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          shell: shellKind,
          translatedCommand: effectiveCommand !== command,
          translatedFromCommand: effectiveCommand !== command ? command : null
        }
      });
    }

    return createToolSuccessResult({
      output: {
        originalCommand: initialCommand,
        requestedCommand: command,
        command: effectiveCommand,
        effectiveCommand,
        cwd,
        exitCode: result.exitCode ?? 0,
        stdout: truncateCommandText(result.stdout),
        stderr: truncateCommandText(result.stderr),
        durationMs: result.durationMs,
        timedOut: false,
        shell: shellKind,
        translatedCommand: effectiveCommand !== command,
        translatedFromCommand: effectiveCommand !== command ? command : null
      }
    });
  } catch (error) {
    return createToolFailureResult({
      kind: 'EXECUTION',
      message: error instanceof Error ? error.message : 'Unable to run command.',
      metadata: {
        originalCommand: initialCommand,
        requestedCommand: command,
        command,
        effectiveCommand: command,
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: null,
        timedOut: false
      }
    });
  }
}

export function registerBuiltinToolAdapters(
  foundation: BackendNewFoundation,
  extensions: ExtensionRegistry,
  toolExecutors: ToolExecutorRegistry
): void {
  for (const tool of BUILTIN_TOOLS) {
    if (!extensions.findTool(tool.id) && !extensions.findTool(tool.name)) {
      extensions.registerTool(tool);
    }
  }

  if (!toolExecutors.has('read-file')) {
    toolExecutors.register('read-file', { execute: executeReadFile });
  }
  if (!toolExecutors.has('write-file')) {
    toolExecutors.register('write-file', { execute: executeWriteFile });
  }
  if (!toolExecutors.has('create-folder')) {
    toolExecutors.register('create-folder', { execute: executeCreateFolder });
  }
  if (!toolExecutors.has('list-files')) {
    toolExecutors.register('list-files', { execute: executeListFiles });
  }
  if (!toolExecutors.has('search-files')) {
    toolExecutors.register('search-files', { execute: executeSearchFiles });
  }
  if (!toolExecutors.has('run-command')) {
    toolExecutors.register('run-command', { execute: executeRunCommand });
  }
  if (!toolExecutors.has('delegate-subtask')) {
    const delegation = new DelegatedSubtaskService(foundation);
    toolExecutors.register('delegate-subtask', {
      execute: (request: ToolExecutorRequest) => delegation.execute({
        parentTaskId: request.invocation.taskId,
        parentUnitId: request.invocation.unitId,
        arguments: request.invocation.arguments
      })
    });
  }
}

export function listBuiltinTools(): AgentToolDefinition[] {
  return BUILTIN_TOOLS.map(tool => ({
    ...tool,
    inputSchema: tool.inputSchema.map(field => ({ ...field })),
    tags: tool.tags ? [...tool.tags] : undefined
  }));
}
