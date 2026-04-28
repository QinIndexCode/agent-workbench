import { ExtensionRegistry } from '../extensions/registry';
import { AgentToolDefinition } from '../extensions/types';
import {
  ToolInvocationRequest,
  ToolInvocationValidationResult
} from './types';

function matchesType(value: unknown, type: AgentToolDefinition['inputSchema'][number]['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function validateWriteFileArguments(argumentsRecord: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const directContent = argumentsRecord.content;
  const contentLines = argumentsRecord.content_lines;
  const contentJson = argumentsRecord.content_json;

  const hasDirectContent = typeof directContent === 'string';
  const hasContentLines = Array.isArray(contentLines);
  const hasContentJson = !!contentJson && typeof contentJson === 'object' && !Array.isArray(contentJson);
  const providedCount = [hasDirectContent, hasContentLines, hasContentJson].filter(Boolean).length;

  if (providedCount === 0) {
    errors.push('write_file requires exactly one of "content", "content_lines", or "content_json".');
  } else if (providedCount > 1) {
    errors.push('write_file accepts only one content source at a time: "content", "content_lines", or "content_json".');
  }

  if (contentLines !== undefined) {
    if (!Array.isArray(contentLines)) {
      errors.push('Argument "content_lines" must be of type "array".');
    } else if (!contentLines.every((entry) => typeof entry === 'string')) {
      errors.push('Argument "content_lines" must contain only strings.');
    }
  }

  if (contentJson !== undefined && (!contentJson || typeof contentJson !== 'object' || Array.isArray(contentJson))) {
    errors.push('Argument "content_json" must be of type "object".');
  }

  if (directContent !== undefined && typeof directContent !== 'string') {
    errors.push('Argument "content" must be of type "string".');
  }

  return errors;
}

export function validateToolInvocationRequest(
  registry: ExtensionRegistry,
  request: ToolInvocationRequest
): ToolInvocationValidationResult {
  const errors: string[] = [];

  if (!request.taskId.trim()) {
    errors.push('taskId is required.');
  }
  if (!request.unitId.trim()) {
    errors.push('unitId is required.');
  }
  if (!request.toolName.trim()) {
    errors.push('toolName is required.');
  }

  const tool = registry.findTool(request.toolName);
  if (!tool) {
    errors.push(`Unknown tool "${request.toolName}".`);
  }

  if (tool) {
    for (const field of tool.inputSchema) {
      const value = request.arguments[field.name];
      if (field.required && value === undefined) {
        errors.push(`Missing required argument "${field.name}".`);
        continue;
      }
      if (value !== undefined && !matchesType(value, field.type)) {
        errors.push(`Argument "${field.name}" must be of type "${field.type}".`);
      }
    }
    if (tool.name === 'write_file') {
      errors.push(...validateWriteFileArguments(request.arguments));
    }
  }

  if (errors.length > 0 || !tool) {
    return {
      ok: false,
      errors
    };
  }

  return {
    ok: true,
    tool,
    normalizedArguments: { ...request.arguments }
  };
}
