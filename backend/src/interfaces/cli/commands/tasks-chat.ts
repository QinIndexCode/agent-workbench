import { CliRuntimeContext, ParsedCliArgs } from '../shared';
import { runCliChatSession } from '../chat/session/session-runner';

export async function runTaskChatSession(
  context: CliRuntimeContext,
  args: ParsedCliArgs,
  rest: string[],
  stdin: NodeJS.ReadableStream
): Promise<number> {
  return runCliChatSession({
    mode: 'task',
    context,
    args,
    rest,
    stdin
  });
}
