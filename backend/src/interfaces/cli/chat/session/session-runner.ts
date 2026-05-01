import readline from 'node:readline';
import {
  CliIo,
  CliRuntimeContext,
  ParsedCliArgs,
  formatTaskDiagnosticsHuman,
  formatTaskSummaryHuman,
  writeJsonLine
} from '../../shared';
import {
  ChatOutputFormat,
  WorkspaceChatEnvelope
} from '../protocol/chat-envelopes';
import { CliChatSessionController, normalizeSeedArg, resolveChatFormat } from './session-controller';
import { runBlessedWorkspaceChatUi } from '../tui/blessed-chat-ui';

function getRecordString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getRecordBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getRecordValue(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getStringArrayValue(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function getRecordArrayValue(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function formatHumanTaskSummary(task: Record<string, unknown>): string {
  return formatTaskSummaryHuman(task, { source: 'chat' });
}

function formatHumanDiagnostics(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return `[diagnostics] ${JSON.stringify(data, null, 2)}\n`;
  }
  return formatTaskDiagnosticsHuman(data as Record<string, unknown>);
}

function writeHumanEnvelope(io: CliIo, payload: WorkspaceChatEnvelope): void {
  switch (payload.type) {
    case 'session':
      io.stdout.write(`[session] ${payload.message}${payload.taskId ? ` (${payload.taskId})` : ''}\n`);
      break;
    case 'task':
      io.stdout.write(formatHumanTaskSummary(payload.task));
      break;
    case 'event':
      io.stdout.write(`[event] ${payload.record.type} ${payload.record.taskId}\n`);
      break;
    case 'info':
      io.stdout.write(`${payload.message}\n`);
      break;
    case 'prompt':
      io.stdout.write(payload.prompt);
      break;
    case 'diagnostics':
      io.stdout.write(formatHumanDiagnostics(payload.data));
      break;
    case 'approvals':
      if (payload.count > 0) {
        const approvals = Array.isArray(payload.approvals) ? payload.approvals as Array<Record<string, unknown>> : [];
        const lines = [`[approvals] pending=${payload.count}`];
        for (const approval of approvals) {
          const invocationId = getRecordString(approval, 'invocationId', 'unknown');
          const toolName = getRecordString(approval, 'toolName', getRecordString(approval, 'toolId', 'tool'));
          lines.push(`- ${toolName} (${invocationId})`);
          lines.push(`  resolve with /approve ${invocationId} or /reject ${invocationId}`);
        }
        io.stdout.write(`${lines.join('\n')}\n`);
      }
      break;
    case 'view':
      io.stdout.write(`[view:${payload.view}] ${JSON.stringify(payload.data, null, 2)}\n`);
      break;
  }
}

function emitEnvelope(io: CliIo, format: ChatOutputFormat, payload: WorkspaceChatEnvelope): void {
  if (format === 'ndjson') {
    writeJsonLine(io, payload);
    return;
  }
  writeHumanEnvelope(io, payload);
}

function shouldUseBlessedUi(stdin: NodeJS.ReadableStream, format: ChatOutputFormat, mode: 'workspace' | 'task'): boolean {
  return format === 'human' && mode === 'workspace' && Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) && Boolean(process.stdout.isTTY);
}

export async function runCliChatSession(options: {
  mode: 'workspace' | 'task';
  context: CliRuntimeContext;
  args: ParsedCliArgs;
  rest: string[];
  stdin: NodeJS.ReadableStream;
}): Promise<number> {
  const format = resolveChatFormat(options.args, options.stdin, options.mode);
  const useTui = shouldUseBlessedUi(options.stdin, format, options.mode);
  const seed = normalizeSeedArg(options.rest[0]);
  let tuiEnvelopeHandler: ((payload: WorkspaceChatEnvelope) => void) | null = null;
  const controller = new CliChatSessionController({
    mode: options.mode,
    context: options.context,
    args: options.args,
    outputFormat: format,
    onEnvelope: (payload) => {
      if (useTui) {
        tuiEnvelopeHandler?.(payload);
        return;
      }
      emitEnvelope(options.context.io, format, payload);
    }
  });

  if (useTui) {
    return runBlessedWorkspaceChatUi({
      controller,
      initialize: () => controller.initialize({
        taskId: seed?.kind === 'taskId' ? seed.value : null,
        filePath: seed?.kind === 'file' ? seed.value : null
      }),
      registerEnvelopeHandler: (handler) => {
        tuiEnvelopeHandler = handler;
      }
    });
  }

  await controller.initialize({
    taskId: seed?.kind === 'taskId' ? seed.value : null,
    filePath: seed?.kind === 'file' ? seed.value : null
  });

  const lineReader = readline.createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });

  for await (const rawLine of lineReader) {
    const line = rawLine.trim();
    controller.state.inputDraft = line;
    if (!line) {
      if (format === 'human') {
        emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });
      }
      continue;
    }
    const result = await controller.handleInput(line);
    if (result === 'exit') {
      lineReader.close();
      return 0;
    }
    if (format === 'human') {
      emitEnvelope(options.context.io, format, { type: 'prompt', prompt: controller.getPrompt() });
    }
  }

  emitEnvelope(options.context.io, format, {
    type: 'session',
    action: 'closed',
    taskId: controller.state.activeTaskId,
    message: 'Interactive session closed'
  });
  return 0;
}
