import { CliCommandModule } from '../shared';
import { runCliChatSession } from '../chat/session/session-runner';

export const chatCommandModule: CliCommandModule = {
  group: 'chat',
  usage: [
    'chat [--format human|ndjson] [--task <taskId>] [<taskId>|<jsonFile>]',
    'chat [--title <title>] [--intent <intent>] [--provider <providerId>]'
  ],
  async handle(action, rest, context) {
    const seedRest = action ? [action, ...rest] : rest;
    return runCliChatSession({
      mode: 'workspace',
      context,
      args: context.args,
      rest: seedRest,
      stdin: context.stdin
    });
  }
};
