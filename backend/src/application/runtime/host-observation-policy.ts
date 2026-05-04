import { isHostObservationCommand } from '../../foundation/tools/risk-approval-policy';

function getCommandText(argumentsRecord: Record<string, unknown>): string {
  const raw = argumentsRecord.command ?? argumentsRecord.cmd ?? argumentsRecord.script;
  return typeof raw === 'string' ? raw.trim() : '';
}

export { isHostObservationCommand };

export function isHostObservationOnlyToolBoundary(allowedToolIds: string[] | null | undefined): boolean {
  if (!allowedToolIds?.includes('run-command')) {
    return false;
  }
  return !allowedToolIds.includes('write-file')
    && !allowedToolIds.includes('create-folder')
    && !allowedToolIds.includes('delegate-subtask');
}

export function validateHostObservationRunCommandBoundary(params: {
  allowedToolIds: string[] | null | undefined;
  toolId: string;
  argumentsRecord: Record<string, unknown>;
}): string | null {
  if (
    params.toolId !== 'run-command'
    || !isHostObservationOnlyToolBoundary(params.allowedToolIds)
  ) {
    return null;
  }
  const command = getCommandText(params.argumentsRecord);
  return isHostObservationCommand(command)
    ? null
    : 'run_command is limited to safe host observation commands in analyze mode.';
}
