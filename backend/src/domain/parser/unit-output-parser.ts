import {
  ExplicitOutputEnvelope,
  ParsedTurn,
  ProgressTracker,
  ToolCallEnvelope
} from '../contracts/types';

const SQUARE_OUTPUT_RE = /\[([A-Za-z0-9_-]+)_OUTPUT\]\s*([\s\S]*?)(?:\[\/\1_OUTPUT\]|$)/g;
const ANGLE_OUTPUT_RE = /<([A-Za-z0-9_-]+)_OUTPUT>\s*([\s\S]*?)(?:<\/\1_OUTPUT>|$)/gi;
const XML_OUTPUT_RE = /<output\s+unit=["']([A-Za-z0-9_-]+)["']>([\s\S]*?)<\/output>/gi;
const SQUARE_TOOL_RE = /\[TOOL_CALL\]\s*([\s\S]*?)(?:\[\/TOOL_CALL\]|\[\/tool_call\]|$)/gi;
const ALT_SQUARE_TOOL_RE = /\[TOOL\]\s*([\s\S]*?)(?:\[\/TOOL\]|\[\/tool\]|$)/gi;
const ASSIGNED_SQUARE_TOOL_RE = /\[TOOL=([A-Za-z0-9_-]+)\]\s*([\s\S]*?)(?:\[\/TOOL\]|\[\/tool\]|$)/gi;
const COLON_SQUARE_TOOL_RE = /\[TOOL:\s*([A-Za-z0-9_-]+)\]\s*([\s\S]*?)(?:\[\/TOOL\]|\[\/tool\]|$)/gi;
const XML_TOOL_RE = /<tool(?:\s+([^>]*?))?>([\s\S]*?)<\/tool>/gi;
const INVOKE_TOOL_RE = /<invoke(?:\s+([^>]*?))?>([\s\S]*?)<\/invoke>/gi;
const XML_TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const TOOL_INVOCATION_RE = /<tool_invocation(?:\s+([^>]*?))?>([\s\S]*?)<\/tool_invocation>/gi;
const BARE_TOOL_RE = /<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi;
const TOOL_CODE_RE = /<tool_code>([\s\S]*?)<\/tool_code>/gi;

function normalizeProviderToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase().replace(/-/g, '_');
  switch (normalized) {
    case 'run_shell':
    case 'execute_command':
      return 'run_command';
    case 'read':
      return 'read_file';
    case 'write':
      return 'write_file';
    case 'mkdir':
      return 'create_folder';
    case 'ls':
      return 'list_files';
    case 'grep':
      return 'search_files';
    default:
      return toolName.trim();
  }
}

function looksLikeKnownToolName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const normalized = normalizeProviderToolName(value).toLowerCase().replace(/-/g, '_');
  return new Set([
    'read_file',
    'write_file',
    'create_folder',
    'list_files',
    'search_files',
    'run_command',
    'delegate_subtask'
  ]).has(normalized);
}

function normalizeTrackerDecision(decision: string): ProgressTracker['decision'] {
  const normalized = decision
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  switch (normalized) {
    case 'WAIT':
    case 'COMPLETE':
    case 'COMPLETED':
    case 'DONE':
    case 'FINISH':
    case 'FINISHED':
    case 'STOP':
    case 'TERMINATE':
      return 'CONTINUE';
    case 'PRUNE':
      return 'PRUNE_REMAINING';
    default:
      return normalized as ProgressTracker['decision'];
  }
}

function normalizeTrackerStatus(status: string): ProgressTracker['status'] {
  const normalized = status
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  switch (normalized) {
    case 'RUNNING':
      return 'IN_PROGRESS';
    case 'BLOCKED':
    case 'WAITING':
    case 'WAITING_APPROVAL':
    case 'AWAITING_APPROVAL':
    case 'PENDING_APPROVAL':
    case 'WAITING_TOOL':
    case 'WAITING_FOR_TOOL':
    case 'AWAITING_TOOL':
    case 'AWAITING_TOOL_ACTION':
    case 'NEEDS_TOOL':
      return 'PARTIAL';
    case 'DONE':
      return 'COMPLETE';
    default:
      return normalized as ProgressTracker['status'];
  }
}

function extractJsonObjects(source: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function isLikelyStructuredJsonStart(source: string, index: number): boolean {
  return /^\{\s*"(?:tool|tool_name|function_name|function|action|type|command|current_unit)"/.test(source.slice(index));
}

function countUnclosedObjectBraces(source: string): number {
  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
    }
  }

  return depth;
}

function collectParsedJsonObjects(source: string): Array<{ raw: string; parsed: Record<string, unknown> }> {
  const records: Array<{ raw: string; parsed: Record<string, unknown> }> = [];
  const seen = new Set<string>();

  const pushParsedRecord = (rawCandidate: string, parsedCandidate: unknown) => {
    if (!parsedCandidate || typeof parsedCandidate !== 'object' || Array.isArray(parsedCandidate)) {
      return;
    }
    const raw = rawCandidate.trim();
    if (!raw || seen.has(raw)) {
      return;
    }
    seen.add(raw);
    records.push({
      raw,
      parsed: parsedCandidate as Record<string, unknown>
    });
  };

  for (const candidate of extractJsonObjects(source)) {
    pushParsedRecord(candidate, tryParseJson(candidate));
  }

  const relaxedStarts: number[] = [];
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === '{' && isLikelyStructuredJsonStart(source, index)) {
      relaxedStarts.push(index);
    }
  }

  for (let index = 0; index < relaxedStarts.length; index += 1) {
    const start = relaxedStarts[index];
    const next = relaxedStarts[index + 1] ?? source.length;
    const candidate = source.slice(start, next).trim().replace(/,+$/g, '').trim();
    if (!candidate) {
      continue;
    }

    const parsed = tryParseJson(candidate);
    if (parsed) {
      pushParsedRecord(candidate, parsed);
      continue;
    }

    const missingClosingBraces = countUnclosedObjectBraces(candidate);
    if (missingClosingBraces <= 0 || missingClosingBraces > 4) {
      continue;
    }

    const repairedCandidate = `${candidate}${'}'.repeat(missingClosingBraces)}`;
    pushParsedRecord(repairedCandidate, tryParseJson(repairedCandidate));
  }

  return records;
}

function unwrapRunCommandParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...parameters };
  const command = typeof normalized.command === 'string' ? normalized.command.trim().toLowerCase() : '';
  const argList = Array.isArray(normalized.args)
    ? normalized.args.map((value) => String(value))
    : null;
  if (!command || !argList || argList.length === 0) {
    return normalized;
  }

  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(command)) {
    const commandFlagIndex = argList.findIndex((value) => /^-(?:c|command)$/i.test(value.trim()));
    const embeddedCommand = commandFlagIndex >= 0 ? argList[commandFlagIndex + 1] : null;
    if (typeof embeddedCommand === 'string' && embeddedCommand.trim()) {
      normalized.command = embeddedCommand.trim();
      delete normalized.args;
    }
    return normalized;
  }

  if (['cmd', 'cmd.exe'].includes(command)) {
    const commandFlagIndex = argList.findIndex((value) => /^\/c$/i.test(value.trim()));
    const embeddedCommand = commandFlagIndex >= 0
      ? argList.slice(commandFlagIndex + 1).join(' ').trim()
      : '';
    if (embeddedCommand) {
      normalized.command = embeddedCommand;
      delete normalized.args;
    }
  }

  return normalized;
}

function parseToolCallObject(parsed: Record<string, unknown>, fallbackUnitId = 'UNKNOWN'): ToolCallEnvelope | null {
  const explicitParameters = parsed.arguments
    ?? parsed.parameters
    ?? parsed.args
    ?? parsed.tool_arguments
    ?? parsed.tool_input
    ?? parsed.input;
  const toolNameValue = parsed.tool_name
    ?? parsed.function_name
    ?? parsed.tool
    ?? parsed.function
    ?? parsed.type
    ?? parsed.action
    ?? (
      explicitParameters && typeof explicitParameters === 'object' && !Array.isArray(explicitParameters) && looksLikeKnownToolName(parsed.command)
        ? parsed.command
        : undefined
    )
    ?? (
      explicitParameters && typeof explicitParameters === 'object' && !Array.isArray(explicitParameters)
        ? parsed.name
        : undefined
    );
  const inferredToolName = typeof toolNameValue === 'string' && toolNameValue.trim()
    ? toolNameValue
    : looksLikeBareRunCommand(parsed)
      ? 'run_command'
      : null;
  if (!inferredToolName) {
    return null;
  }

  let parameters: Record<string, unknown>;
  if (explicitParameters && typeof explicitParameters === 'object' && !Array.isArray(explicitParameters)) {
    parameters = { ...(explicitParameters as Record<string, unknown>) };
  } else {
    const derived: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ([
        'tool_name',
        'function_name',
        'tool',
        'function',
        'name',
        'type',
        'action',
        'current_unit',
        'unit_id',
        'unit',
        'arguments',
        'parameters',
        'tool_arguments'
      ].includes(key)) {
        continue;
      }
      derived[key] = value;
    }
    parameters = derived;
  }
  if (typeof parameters.file === 'string' && parameters.path === undefined) {
    parameters.path = parameters.file;
  }
  if (typeof parameters.file_path === 'string' && parameters.path === undefined) {
    parameters.path = parameters.file_path;
  }
  if (parameters.args && typeof parameters.args === 'object' && !Array.isArray(parameters.args)) {
    for (const [key, value] of Object.entries(parameters.args as Record<string, unknown>)) {
      if (parameters[key] === undefined) {
        parameters[key] = value;
      }
    }
  }

  const unitIdValue = parsed.current_unit ?? parsed.unit_id ?? parsed.unit;
  const normalizedToolName = normalizeProviderToolName(inferredToolName);
  const normalizedParameters = normalizeToolParameters(parameters);
  return {
    unitId: typeof unitIdValue === 'string' && unitIdValue.trim() ? unitIdValue : fallbackUnitId,
    toolName: normalizedToolName,
    parameters: normalizedToolName === 'run_command'
      ? unwrapRunCommandParameters(normalizedParameters)
      : normalizedParameters,
    source: 'json'
  };
}

function looksLikeBareRunCommand(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.command !== 'string' || !parsed.command.trim()) {
    return false;
  }
  const allowedKeys = new Set([
    'command',
    'cwd',
    'args',
    'env',
    'shell',
    'timeout',
    'timeout_ms',
    'timeoutMs',
    'description',
    'working_directory',
    'workingDirectory'
  ]);
  const disallowedKeys = new Set([
    'summary',
    'details',
    'issues',
    'current_unit',
    'status',
    'decision',
    'progress_percent',
    'next_unit',
    'files_created'
  ]);
  for (const key of Object.keys(parsed)) {
    if (disallowedKeys.has(key)) {
      return false;
    }
    if (!allowedKeys.has(key)) {
      return false;
    }
  }
  return true;
}

function parseToolAttrs(source: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  const input = source ?? '';
  let index = 0;

  const skipWhitespace = () => {
    while (index < input.length && /\s/.test(input[index])) {
      index += 1;
    }
  };

  const readBalancedValue = (opening: '{' | '['): string => {
    const closing = opening === '{' ? '}' : ']';
    const start = index;
    let depth = 0;
    let inString = false;
    let quoteChar = '';
    let escaped = false;

    while (index < input.length) {
      const char = input[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quoteChar) {
          inString = false;
          quoteChar = '';
        }
        index += 1;
        continue;
      }

      if (char === '"' || char === '\'') {
        inString = true;
        quoteChar = char;
        index += 1;
        continue;
      }

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
      index += 1;
    }

    return input.slice(start, index);
  };

  while (index < input.length) {
    skipWhitespace();
    if (index >= input.length) {
      break;
    }

    if (input[index] === '/') {
      index += 1;
      continue;
    }

    const keyStart = index;
    while (index < input.length && /[A-Za-z0-9_-]/.test(input[index])) {
      index += 1;
    }
    if (keyStart === index) {
      index += 1;
      continue;
    }
    const key = input.slice(keyStart, index);
    skipWhitespace();
    if (input[index] !== '=') {
      attrs[key] = '';
      continue;
    }
    index += 1;
    skipWhitespace();
    if (index >= input.length) {
      attrs[key] = '';
      break;
    }

    let value = '';
    const marker = input[index];
    if (marker === '"' || marker === '\'') {
      index += 1;
      const valueStart = index;
      while (index < input.length && input[index] !== marker) {
        index += 1;
      }
      value = input.slice(valueStart, index);
      if (index < input.length && input[index] === marker) {
        index += 1;
      }
    } else if (marker === '{' || marker === '[') {
      value = readBalancedValue(marker as '{' | '[');
    } else {
      const valueStart = index;
      while (index < input.length && !/\s/.test(input[index]) && input[index] !== '>') {
        index += 1;
      }
      value = input.slice(valueStart, index);
    }

    attrs[key] = value;
  }
  return attrs;
}

function collectSelfClosingToolInvocationAttrSources(source: string): string[] {
  const attrs: string[] = [];
  const openTag = '<tool_invocation';
  let searchIndex = 0;

  while (searchIndex < source.length) {
    const start = source.indexOf(openTag, searchIndex);
    if (start < 0) {
      break;
    }

    let index = start + openTag.length;
    let inString = false;
    let quoteChar = '';
    let escaped = false;
    let braceDepth = 0;
    let bracketDepth = 0;
    let closed = false;

    while (index < source.length) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quoteChar) {
          inString = false;
          quoteChar = '';
        }
        index += 1;
        continue;
      }

      if (char === '"' || char === '\'') {
        inString = true;
        quoteChar = char;
        index += 1;
        continue;
      }

      if (char === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        continue;
      }
      if (char === '[') {
        bracketDepth += 1;
        index += 1;
        continue;
      }
      if (char === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        index += 1;
        continue;
      }

      if (
        char === '/'
        && source[index + 1] === '>'
        && braceDepth === 0
        && bracketDepth === 0
      ) {
        attrs.push(source.slice(start + openTag.length, index));
        searchIndex = index + 2;
        closed = true;
        break;
      }

      if (char === '>' && braceDepth === 0 && bracketDepth === 0) {
        let nextIndex = index + 1;
        while (nextIndex < source.length && /\s/.test(source[nextIndex])) {
          nextIndex += 1;
        }
        if (source[nextIndex] !== '<') {
          attrs.push(source.slice(start + openTag.length, index));
          searchIndex = index + 1;
          closed = true;
          break;
        }
      }

      index += 1;
    }

    if (!closed) {
      if (index >= source.length && braceDepth === 0 && bracketDepth === 0) {
        attrs.push(source.slice(start + openTag.length, index));
        searchIndex = source.length;
        continue;
      }
      searchIndex = start + openTag.length;
    }
  }

  return attrs;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractLeadingJsonObject(source: string): { raw: string; parsed: unknown } | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  const objects = extractJsonObjects(trimmed);
  if (objects.length === 0) {
    return null;
  }
  const leading = objects[0];
  const parsed = tryParseJson(leading);
  if (parsed === null) {
    return null;
  }
  return {
    raw: leading,
    parsed
  };
}

function parseSimpleXmlFields(source: string): Record<string, unknown> | null {
  const fieldRe = /<([A-Za-z0-9_-]+)>([\s\S]*?)<\/\1>/g;
  const values: Record<string, unknown> = {};
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(source)) !== null) {
    const rawValue = match[2].trim();
    const parsedJson = tryParseJson(rawValue);
    if (parsedJson !== null) {
      values[match[1]] = parsedJson;
      continue;
    }
    const nested = parseSimpleXmlFields(rawValue);
    values[match[1]] = nested ?? rawValue;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function parseAssignedInvokeArgs(source: string): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  const argRe = /<(arg|parameter)\s*=\s*["']?([A-Za-z0-9_.-]+)["']?\s*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = argRe.exec(source)) !== null) {
    const argName = match[2]?.trim();
    if (!argName) {
      continue;
    }
    const rawValue = match[3].trim();
    const parsedJson = tryParseJson(rawValue);
    if (parsedJson !== null) {
      values[argName] = parsedJson;
      continue;
    }
    if (shouldPreserveInvokeArgRawValue(argName, rawValue)) {
      values[argName] = rawValue;
      continue;
    }
    const nested = parseSimpleXmlFields(rawValue);
    values[argName] = nested ?? rawValue;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function parseAssignedXmlToolCallEnvelope(source: string, fallbackUnitId = 'UNKNOWN'): ToolCallEnvelope | null {
  const match = source.match(/^\s*<(function|tool)\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*>([\s\S]*?)<\/\1>\s*$/i);
  if (!match) {
    return null;
  }
  const toolName = match[2]?.trim();
  const rawBody = match[3]?.trim() ?? '';
  if (!toolName) {
    return null;
  }
  const parameters = parseAssignedInvokeArgs(rawBody)
    ?? parseInvokeArgs(rawBody)
    ?? parseSimpleXmlFields(rawBody);
  if (!parameters) {
    return null;
  }
  return {
    unitId: fallbackUnitId,
    toolName: normalizeProviderToolName(toolName),
    parameters: normalizeToolParameters(parameters),
    source: 'xml'
  };
}

function parseXmlToolCallEnvelope(source: string, fallbackUnitId = 'UNKNOWN'): ToolCallEnvelope | null {
  const assignedEnvelope = parseAssignedXmlToolCallEnvelope(source, fallbackUnitId);
  if (assignedEnvelope) {
    return assignedEnvelope;
  }
  const parsedFields = parseSimpleXmlFields(source) ?? {};
  const toolNameValue = parsedFields.function_name
    ?? parsedFields.tool_name
    ?? parsedFields.function
    ?? parsedFields.tool
    ?? parsedFields.name;
  if (typeof toolNameValue !== 'string' || !toolNameValue.trim()) {
    return null;
  }

  const parameterMap = parseInvokeArgs(source)
    ?? (
      parsedFields.parameters && typeof parsedFields.parameters === 'object' && !Array.isArray(parsedFields.parameters)
        ? parsedFields.parameters as Record<string, unknown>
        : null
    )
    ?? (
      parsedFields.tool_arguments && typeof parsedFields.tool_arguments === 'object' && !Array.isArray(parsedFields.tool_arguments)
        ? parsedFields.tool_arguments as Record<string, unknown>
        : null
    )
    ?? (
      parsedFields.tool_input && typeof parsedFields.tool_input === 'object' && !Array.isArray(parsedFields.tool_input)
        ? parsedFields.tool_input as Record<string, unknown>
        : null
    );
  if (!parameterMap) {
    return null;
  }

  const unitIdValue = parsedFields.current_unit ?? parsedFields.unit_id ?? parsedFields.unit;
  return {
    unitId: typeof unitIdValue === 'string' && unitIdValue.trim() ? unitIdValue : fallbackUnitId,
    toolName: normalizeProviderToolName(toolNameValue),
    parameters: normalizeToolParameters({ ...parameterMap }),
    source: 'xml'
  };
}

function shouldPreserveInvokeArgRawValue(argName: string, rawValue: string): boolean {
  if (!/<[A-Za-z!/][^>]*>/.test(rawValue)) {
    return false;
  }
  return new Set(['content', 'text', 'body', 'html', 'markdown', 'md', 'template']).has(argName.toLowerCase());
}

function normalizeToolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...parameters };
  if (typeof normalized.tool_arguments === 'string') {
    const parsedToolArguments = tryParseJson(normalized.tool_arguments);
    if (parsedToolArguments && typeof parsedToolArguments === 'object' && !Array.isArray(parsedToolArguments)) {
      normalized.args = parsedToolArguments as Record<string, unknown>;
    }
  } else if (normalized.tool_arguments && typeof normalized.tool_arguments === 'object' && !Array.isArray(normalized.tool_arguments)) {
    normalized.args = normalized.tool_arguments as Record<string, unknown>;
  }
  if (typeof normalized.tool_args === 'string') {
    const parsedToolArgs = tryParseJson(normalized.tool_args);
    if (parsedToolArgs && typeof parsedToolArgs === 'object' && !Array.isArray(parsedToolArgs)) {
      normalized.args = parsedToolArgs as Record<string, unknown>;
    }
  } else if (normalized.tool_args && typeof normalized.tool_args === 'object' && !Array.isArray(normalized.tool_args)) {
    normalized.args = normalized.tool_args as Record<string, unknown>;
  }
  if (typeof normalized.file === 'string' && normalized.path === undefined) {
    normalized.path = normalized.file;
  }
  if (typeof normalized.file_path === 'string' && normalized.path === undefined) {
    normalized.path = normalized.file_path;
  }
  if (typeof normalized.file_content === 'string' && normalized.content === undefined) {
    normalized.content = normalized.file_content;
  }
  if (typeof normalized.fileContent === 'string' && normalized.content === undefined) {
    normalized.content = normalized.fileContent;
  }
  if (typeof normalized.cmd === 'string' && normalized.command === undefined) {
    normalized.command = normalized.cmd;
  }
  if (typeof normalized.working_directory === 'string' && normalized.cwd === undefined) {
    normalized.cwd = normalized.working_directory;
  }
  if (typeof normalized.workingDirectory === 'string' && normalized.cwd === undefined) {
    normalized.cwd = normalized.workingDirectory;
  }
  if (normalized.args && typeof normalized.args === 'object' && !Array.isArray(normalized.args)) {
    for (const [key, value] of Object.entries(normalized.args as Record<string, unknown>)) {
      if (normalized[key] === undefined) {
        normalized[key] = value;
      }
    }
  }
  delete normalized.tool_arguments;
  delete normalized.file_content;
  delete normalized.fileContent;
  return normalized;
}

function collectToolCodeCalls(source: string): ToolCallEnvelope[] {
  const calls: ToolCallEnvelope[] = [];
  TOOL_CODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CODE_RE.exec(source)) !== null) {
    const values = parseSimpleXmlFields(match[1].trim());
    if (!values) {
      continue;
    }
    const toolNameValue = values.tool_name ?? values.tool ?? values.name;
    if (typeof toolNameValue !== 'string' || !toolNameValue.trim()) {
      continue;
    }
    const parametersSource = values.tool_args ?? values.args ?? values.parameters;
    const parameters = parametersSource && typeof parametersSource === 'object' && !Array.isArray(parametersSource)
      ? { ...(parametersSource as Record<string, unknown>) }
      : normalizeToolParameters(values);
    delete parameters.tool_name;
    delete parameters.tool;
    delete parameters.name;
    delete parameters.tool_args;
    delete parameters.args;
    delete parameters.parameters;
    const unitIdValue = values.current_unit ?? values.unit_id ?? values.unit;
    calls.push({
      unitId: typeof unitIdValue === 'string' && unitIdValue.trim() ? unitIdValue : 'UNKNOWN',
      toolName: normalizeProviderToolName(toolNameValue),
      parameters: normalizeToolParameters(parameters),
      source: 'xml'
    });
  }
  return calls;
}

function parseInvokeArgs(source: string): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  const argRe = /<(arg|parameter)\s+([^>]*?)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = argRe.exec(source)) !== null) {
    const attrs = parseToolAttrs(match[2]);
    const argName = attrs.name?.trim();
    if (!argName) {
      continue;
    }
    const rawValue = match[3].trim();
    const parsedJson = tryParseJson(rawValue);
    if (parsedJson !== null) {
      values[argName] = parsedJson;
      continue;
    }
    if (shouldPreserveInvokeArgRawValue(argName, rawValue)) {
      values[argName] = rawValue;
      continue;
    }
    const nested = parseSimpleXmlFields(rawValue);
    values[argName] = nested ?? rawValue;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function parseToolInvocationRecord(attrs: Record<string, string>, rawBody = ''): ToolCallEnvelope | null {
  const toolName = attrs.name ?? attrs.tool ?? attrs.tool_name ?? '';
  if (!toolName.trim()) {
    return null;
  }

  const rawParameters = attrs.arguments ?? attrs.parameters ?? attrs.args;
  let parameters: Record<string, unknown> = {};
  if (typeof rawParameters === 'string' && rawParameters.trim()) {
    const parsedParameters = tryParseJson(rawParameters.trim());
    if (parsedParameters && typeof parsedParameters === 'object' && !Array.isArray(parsedParameters)) {
      parameters = { ...(parsedParameters as Record<string, unknown>) };
    }
  }

  if (Object.keys(parameters).length === 0 && rawBody.trim()) {
    const parsedBody = tryParseJson(rawBody.trim());
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      parameters = { ...(parsedBody as Record<string, unknown>) };
    } else {
      const parsedFields = parseSimpleXmlFields(rawBody.trim());
      if (parsedFields) {
        parameters = parsedFields;
      }
    }
  }

  if (Object.keys(parameters).length === 0) {
    for (const [key, value] of Object.entries(attrs)) {
      if (['name', 'tool', 'tool_name', 'arguments', 'parameters', 'args', 'unit', 'unit_id', 'current_unit'].includes(key)) {
        continue;
      }
      const parsedValue = tryParseJson(value);
      parameters[key] = parsedValue ?? value;
    }
  }

  const call = parseToolCallObject({
    tool: toolName,
    unit: attrs.unit ?? attrs.unit_id ?? attrs.current_unit ?? 'UNKNOWN',
    arguments: parameters
  });
  return call ? { ...call, source: 'xml' } : null;
}

function collectXmlToolCallsFromSource(source: string): ToolCallEnvelope[] {
  const calls: ToolCallEnvelope[] = [];
  XML_TOOL_RE.lastIndex = 0;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = XML_TOOL_RE.exec(source)) !== null) {
    const attrs = parseToolAttrs(xmlMatch[1]);
    const rawBody = xmlMatch[2].trim();
    const parsedBody = tryParseJson(rawBody);
    const parameters = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? { ...(parsedBody as Record<string, unknown>) }
      : parseSimpleXmlFields(rawBody);
    const toolName = attrs.name
      ?? attrs.tool
      ?? (parameters && typeof parameters.name === 'string' ? parameters.name : '')
      ?? '';
    if (!toolName.trim() || !parameters) {
      continue;
    }
    delete parameters.name;
    delete parameters.tool;
    calls.push({
      unitId: attrs.unit?.trim() ? attrs.unit : 'UNKNOWN',
      toolName: normalizeProviderToolName(toolName),
      parameters: normalizeToolParameters(parameters),
      source: 'xml'
    });
  }

  INVOKE_TOOL_RE.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = INVOKE_TOOL_RE.exec(source)) !== null) {
    const attrs = parseToolAttrs(invokeMatch[1]);
    const toolName = attrs.name ?? attrs.tool ?? '';
    const parameters = parseInvokeArgs(invokeMatch[2].trim());
    if (!toolName.trim() || !parameters) {
      continue;
    }
    calls.push({
      unitId: attrs.unit?.trim() ? attrs.unit : 'UNKNOWN',
      toolName: normalizeProviderToolName(toolName),
      parameters: normalizeToolParameters(parameters),
      source: 'xml'
    });
  }

  TOOL_INVOCATION_RE.lastIndex = 0;
  let toolInvocationMatch: RegExpExecArray | null;
  while ((toolInvocationMatch = TOOL_INVOCATION_RE.exec(source)) !== null) {
    const attrs = parseToolAttrs(toolInvocationMatch[1]);
    const call = parseToolInvocationRecord(attrs, toolInvocationMatch[2]);
    if (call) {
      calls.push(call);
    }
  }

  for (const rawAttrSource of collectSelfClosingToolInvocationAttrSources(source)) {
    const attrs = parseToolAttrs(rawAttrSource);
    const call = parseToolInvocationRecord(attrs);
    if (call) {
      calls.push(call);
    }
  }

  return calls;
}

function collectBareXmlToolCalls(source: string): ToolCallEnvelope[] {
  const calls: ToolCallEnvelope[] = [];
  BARE_TOOL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_TOOL_RE.exec(source)) !== null) {
    const tagName = match[1];
    if (
      tagName.toLowerCase() === 'tool'
      || tagName.toLowerCase() === 'output'
      || tagName.toLowerCase() === 'tool_code'
      || tagName.toLowerCase() === 'tool_name'
      || tagName.toLowerCase() === 'tool_args'
      || tagName.toLowerCase() === 'parameter'
      || tagName.toLowerCase() === 'arg'
      || /_output$/i.test(tagName)
    ) {
      continue;
    }
    if (!looksLikeKnownToolName(tagName)) {
      continue;
    }
    const rawBody = match[2].trim();
    const parsedBody = tryParseJson(rawBody);
    const parameters = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? { ...(parsedBody as Record<string, unknown>) }
      : parseSimpleXmlFields(rawBody);
    if (!parameters) {
      continue;
    }
    calls.push({
      unitId: 'UNKNOWN',
      toolName: normalizeProviderToolName(tagName),
      parameters: normalizeToolParameters(parameters),
      source: 'xml'
    });
  }
  return calls;
}

function parseToolCallObjects(parsed: Record<string, unknown>, fallbackUnitId = 'UNKNOWN'): ToolCallEnvelope[] {
  const wrappedCalls = parsed.tool_calls ?? parsed.toolCalls ?? parsed.calls;
  if (!Array.isArray(wrappedCalls)) {
    const singleCall = parseToolCallObject(parsed, fallbackUnitId);
    return singleCall ? [singleCall] : [];
  }

  const unitIdValue = parsed.current_unit ?? parsed.unit_id ?? parsed.unit;
  const effectiveFallbackUnitId = typeof unitIdValue === 'string' && unitIdValue.trim()
    ? unitIdValue
    : fallbackUnitId;
  const calls: ToolCallEnvelope[] = [];
  for (const entry of wrappedCalls) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const call = parseToolCallObject(entry as Record<string, unknown>, effectiveFallbackUnitId);
    if (call) {
      calls.push(call);
    }
  }
  return calls;
}

function collectExplicitOutputs(source: string): ExplicitOutputEnvelope[] {
  const outputs: ExplicitOutputEnvelope[] = [];
  const patterns: Array<{
    regex: RegExp;
    wrapper: ExplicitOutputEnvelope['wrapper'];
  }> = [
    { regex: SQUARE_OUTPUT_RE, wrapper: 'square' },
    { regex: ANGLE_OUTPUT_RE, wrapper: 'angle' },
    { regex: XML_OUTPUT_RE, wrapper: 'xml' }
  ];

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(source)) !== null) {
      const raw = match[2].trim();
      const parsedJson = tryParseJson(raw);
      const recoveredLeadingJson = parsedJson === null
        ? extractLeadingJsonObject(raw)
        : null;
      outputs.push({
        unitId: match[1],
        raw: recoveredLeadingJson?.raw ?? raw,
        parsedJson: recoveredLeadingJson?.parsed ?? parsedJson,
        wrapper: pattern.wrapper
      });
    }
  }

  return outputs;
}

function collectTrackers(source: string): ProgressTracker[] {
  const trackers: ProgressTracker[] = [];
  const objects = collectParsedJsonObjects(source);

  for (const candidate of objects) {
    const record = candidate.parsed;
    if (
      typeof record.current_unit !== 'string'
      || typeof record.status !== 'string'
      || typeof record.decision !== 'string'
    ) {
      continue;
    }

    trackers.push({
      currentUnit: record.current_unit,
      status: normalizeTrackerStatus(String(record.status)),
      progressPercent: Number(record.progress_percent || 0),
      decision: normalizeTrackerDecision(String(record.decision)),
      reason: String(record.reason || ''),
      nextUnit: typeof record.next_unit === 'string' ? record.next_unit : null,
      filesCreated: Array.isArray(record.files_created)
        ? record.files_created.map(item => String(item))
        : []
    });
  }

  return trackers;
}

function collectToolCalls(source: string): ToolCallEnvelope[] {
  const calls: ToolCallEnvelope[] = [];
  calls.push(...collectToolCodeCalls(source));

  SQUARE_TOOL_RE.lastIndex = 0;
  let squareToolMatch: RegExpExecArray | null;
  while ((squareToolMatch = SQUARE_TOOL_RE.exec(source)) !== null) {
    const rawBody = squareToolMatch[1].trim();
    const parsedBody = tryParseJson(rawBody);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      calls.push(...parseToolCallObjects(parsedBody as Record<string, unknown>));
      continue;
    }
    calls.push(...collectXmlToolCallsFromSource(rawBody));
  }

  ALT_SQUARE_TOOL_RE.lastIndex = 0;
  let altSquareToolMatch: RegExpExecArray | null;
  while ((altSquareToolMatch = ALT_SQUARE_TOOL_RE.exec(source)) !== null) {
    const rawBody = altSquareToolMatch[1].trim();
    const parsedBody = tryParseJson(rawBody);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      calls.push(...parseToolCallObjects(parsedBody as Record<string, unknown>));
      continue;
    }
    calls.push(...collectXmlToolCallsFromSource(rawBody));
    calls.push(...collectBareXmlToolCalls(rawBody));
  }

  XML_TOOL_CALL_RE.lastIndex = 0;
  let xmlToolCallMatch: RegExpExecArray | null;
  while ((xmlToolCallMatch = XML_TOOL_CALL_RE.exec(source)) !== null) {
    const rawBody = xmlToolCallMatch[1].trim();
    const parsedBody = tryParseJson(rawBody);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      calls.push(...parseToolCallObjects(parsedBody as Record<string, unknown>));
      continue;
    }
    const shouldPreferStructuredXmlEnvelope = /<(function_name|tool_name|function|tool|name)>/i.test(rawBody)
      && /<(parameter|arg)\b/i.test(rawBody);
    const parsedFields = parseSimpleXmlFields(rawBody);
    if (parsedFields && !shouldPreferStructuredXmlEnvelope) {
      calls.push(...parseToolCallObjects(parsedFields));
    }
    const xmlEnvelopeCall = parseXmlToolCallEnvelope(rawBody);
    if (xmlEnvelopeCall) {
      calls.push(xmlEnvelopeCall);
    }
    calls.push(...collectXmlToolCallsFromSource(rawBody));
    calls.push(...collectBareXmlToolCalls(rawBody));
  }

  ASSIGNED_SQUARE_TOOL_RE.lastIndex = 0;
  let assignedSquareToolMatch: RegExpExecArray | null;
  while ((assignedSquareToolMatch = ASSIGNED_SQUARE_TOOL_RE.exec(source)) !== null) {
    const toolName = normalizeProviderToolName(assignedSquareToolMatch[1]);
    const rawBody = assignedSquareToolMatch[2].trim();
    const parsedBody = tryParseJson(rawBody);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      const call = parseToolCallObject({
        tool: toolName,
        arguments: parsedBody as Record<string, unknown>
      });
      if (call) {
        calls.push(call);
      }
      continue;
    }
    calls.push({
      unitId: 'UNKNOWN',
      toolName,
      parameters: normalizeToolParameters(parseSimpleXmlFields(rawBody) ?? {}),
      source: 'json'
    });
  }

  COLON_SQUARE_TOOL_RE.lastIndex = 0;
  let colonSquareToolMatch: RegExpExecArray | null;
  while ((colonSquareToolMatch = COLON_SQUARE_TOOL_RE.exec(source)) !== null) {
    const toolName = normalizeProviderToolName(colonSquareToolMatch[1]);
    const rawBody = colonSquareToolMatch[2].trim();
    const parsedBody = tryParseJson(rawBody);
    calls.push({
      unitId: 'UNKNOWN',
      toolName,
      parameters: normalizeToolParameters(
        parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
          ? { ...(parsedBody as Record<string, unknown>) }
          : (parseSimpleXmlFields(rawBody) ?? {})
      ),
      source: 'json'
    });
  }

  calls.push(...collectXmlToolCallsFromSource(source));
  calls.push(...collectBareXmlToolCalls(source));

  const objects = extractJsonObjects(source);
  for (const candidate of collectParsedJsonObjects(source)) {
    calls.push(...parseToolCallObjects(candidate.parsed));
  }

  const seen = new Set<string>();
  return calls.filter((call) => {
    const parameterCount = Object.keys(call.parameters ?? {}).length;
    if (parameterCount === 0) {
      const hasRicherSibling = calls.some((candidate) => (
        candidate !== call
        && candidate.unitId === call.unitId
        && candidate.toolName === call.toolName
        && Object.keys(candidate.parameters ?? {}).length > 0
      ));
      if (hasRicherSibling) {
        return false;
      }
    }
    const key = JSON.stringify([call.unitId, call.toolName, call.parameters]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((left, right) => estimateToolCallPosition(source, left) - estimateToolCallPosition(source, right));
}

function estimateToolCallPosition(source: string, call: ToolCallEnvelope): number {
  const parameterRecord = call.parameters ?? {};
  const specificCandidates = [
    typeof parameterRecord.path === 'string' ? parameterRecord.path : null,
    typeof parameterRecord.command === 'string' ? parameterRecord.command : null,
    typeof parameterRecord.pattern === 'string' ? parameterRecord.pattern : null,
    typeof parameterRecord.file_path === 'string' ? parameterRecord.file_path : null,
    typeof parameterRecord.file === 'string' ? parameterRecord.file : null
  ].filter((value): value is string => Boolean(value && value.trim()));
  const fallbackCandidates = [
    call.toolName,
    call.toolName.replace(/_/g, '-')
  ].filter((value): value is string => Boolean(value && value.trim()));

  const candidateGroups = specificCandidates.length > 0 ? [specificCandidates, fallbackCandidates] : [fallbackCandidates];
  for (const candidates of candidateGroups) {
    let bestIndex = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const index = source.indexOf(candidate);
      if (index >= 0 && index < bestIndex) {
        bestIndex = index;
      }
    }
    if (Number.isFinite(bestIndex)) {
      return bestIndex;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

export function parseTurn(rawText: string): ParsedTurn {
  return {
    rawText,
    explicitOutputs: collectExplicitOutputs(rawText),
    trackers: collectTrackers(rawText),
    toolCalls: collectToolCalls(rawText),
    warnings: []
  };
}
