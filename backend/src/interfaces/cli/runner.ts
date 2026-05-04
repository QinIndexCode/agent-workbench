import { WebSocket } from 'ws';
import { chatCommandModule } from './commands/chat';
import { coreCommandModule } from './commands/core';
import { platformCommandModule } from './commands/platform';
import { queueCommandModule } from './commands/queue';
import { tasksCommandModule } from './commands/tasks';
import {
  CliCommandModule,
  CreateWebSocket,
  CliIo,
  getServerUrl,
  parseCliArgs,
  RunBackendNewCliOptions,
  writeError
} from './shared';

const COMMAND_MODULES: CliCommandModule[] = [
  chatCommandModule,
  tasksCommandModule,
  queueCommandModule,
  platformCommandModule,
  coreCommandModule
];

function usage(): string {
  const lines = ['backend_new CLI', '', 'Usage:'];
  for (const module of COMMAND_MODULES) {
    for (const entry of module.usage) {
      lines.push(`  ${entry}`);
    }
  }
  return lines.join('\n');
}

export async function runBackendNewCli(options: RunBackendNewCliOptions): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const io: CliIo = options.io ?? process;
  const stdin = options.stdin ?? process.stdin;
  const createWebSocket: CreateWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const args = parseCliArgs(options.argv);
  const [group, action, ...rest] = args.command;

  try {
    if (!group) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (group === 'health' || group === 'ready') {
      return coreCommandModule.handle(group, [], {
        args,
        fetchImpl,
        io,
        stdin,
        createWebSocket,
        sleep,
        serverUrl: getServerUrl(args)
      }) as Promise<number>;
    }

    if (group === 'memory' && action === 'profile') {
      return coreCommandModule.handle('memory', ['profile'], {
        args,
        fetchImpl,
        io,
        stdin,
        createWebSocket,
        sleep,
        serverUrl: getServerUrl(args)
      }) as Promise<number>;
    }

    const module = COMMAND_MODULES.find((entry) => entry.group === group || entry.aliases?.includes(group));
    if (!module) {
      io.stderr.write(`${usage()}\n`);
      return 1;
    }

    const isAliasDispatch = module.group !== group;
    const result = await module.handle(
      isAliasDispatch ? group : action,
      isAliasDispatch ? [action, ...rest].filter((value): value is string => typeof value === 'string') : rest,
      {
      args,
      fetchImpl,
      io,
      stdin,
      createWebSocket,
      sleep,
      serverUrl: getServerUrl(args)
      }
    );

    if (result !== null) {
      return result;
    }

    io.stderr.write(`${usage()}\n`);
    return 1;
  } catch (error) {
    writeError(io, error);
    return 1;
  }
}
