import { ExecutionProfileId } from '../../domain/contracts/types';

export interface ExecutionProfile {
  id: ExecutionProfileId;
  label: string;
  description: string;
  allowedToolIds: string[];
  contextMode: 'dependency_scope' | 'workspace_focus' | 'validated_outputs_first';
  historyScope: 'stage_chain' | 'workspace_recent' | 'validated_output_focus';
  retainRecentToolTurns: boolean;
  retainDependencyMessages: boolean;
  preferValidatedOutputs: boolean;
}

export const EXECUTION_PROFILES: Record<ExecutionProfileId, ExecutionProfile> = {
  analyze: {
    id: 'analyze',
    label: 'Analyze',
    description: 'Read-heavy profile for requirements, discovery, planning, and safe host observation.',
    allowedToolIds: ['read-file', 'list-files', 'search-files', 'request-working-directory', 'run-command'],
    contextMode: 'dependency_scope',
    historyScope: 'stage_chain',
    retainRecentToolTurns: false,
    retainDependencyMessages: true,
    preferValidatedOutputs: false
  },
  implement: {
    id: 'implement',
    label: 'Implement',
    description: 'Write-capable profile for workspace mutations and command-style actions.',
    allowedToolIds: ['read-file', 'list-files', 'search-files', 'request-working-directory', 'create-folder', 'write-file', 'run-command', 'delegate-subtask'],
    contextMode: 'workspace_focus',
    historyScope: 'workspace_recent',
    retainRecentToolTurns: true,
    retainDependencyMessages: true,
    preferValidatedOutputs: false
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    description: 'Validation-focused profile for checking outputs, writing grounded reports, and confirming final state.',
    allowedToolIds: ['read-file', 'list-files', 'search-files', 'request-working-directory', 'create-folder', 'write-file', 'run-command'],
    contextMode: 'validated_outputs_first',
    historyScope: 'validated_output_focus',
    retainRecentToolTurns: true,
    retainDependencyMessages: false,
    preferValidatedOutputs: true
  }
};

export function getExecutionProfile(profileId: ExecutionProfileId | null | undefined): ExecutionProfile | null {
  if (!profileId) {
    return null;
  }
  return EXECUTION_PROFILES[profileId] ?? null;
}
