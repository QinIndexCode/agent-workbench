import { AgentToolDefinition } from '../extensions/types';
import { ToolApprovalRecord } from '../repository';

export type ToolRiskCategory =
  | 'host_observation'
  | 'workspace_read'
  | 'workspace_write'
  | 'shell_command'
  | 'network'
  | 'destructive';

function getCommandText(argumentsRecord: Record<string, unknown> | null | undefined): string {
  const raw = argumentsRecord?.command ?? argumentsRecord?.cmd ?? argumentsRecord?.script;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function isHostObservationCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return /^(?:Get-Process|Get-CimInstance|Get-Service|tasklist\b|systeminfo\b|wmic\b|ps\s+aux\b|top\b|free\b|df\b|uname\b|uptime\b|nproc\b|cat\s+\/proc\/(?:cpuinfo|loadavg|meminfo)\b)/i.test(normalized)
    || /\b(?:Get-Process|Get-CimInstance|Get-Service|tasklist|systeminfo)\b/i.test(normalized);
}

export function classifyToolRiskCategory(params: {
  tool: Pick<AgentToolDefinition, 'id' | 'name' | 'effect' | 'riskLevel'>;
  argumentsRecord?: Record<string, unknown> | null;
}): ToolRiskCategory {
  const toolId = params.tool.id.trim().toLowerCase().replace(/_/g, '-');
  const toolName = params.tool.name.trim().toLowerCase().replace(/_/g, '-');
  if (toolId === 'run-command' || toolName === 'run-command') {
    return isHostObservationCommand(getCommandText(params.argumentsRecord))
      ? 'host_observation'
      : 'shell_command';
  }
  if (params.tool.effect === 'NETWORK') {
    return 'network';
  }
  if (params.tool.effect === 'WRITE') {
    return params.tool.riskLevel === 'HIGH' ? 'destructive' : 'workspace_write';
  }
  if (params.tool.effect === 'PROCESS') {
    return 'shell_command';
  }
  return 'workspace_read';
}

export function hasApprovedTaskRiskGrant(params: {
  approvals: ToolApprovalRecord[];
  riskCategory: ToolRiskCategory;
}): boolean {
  return params.approvals.some((approval) => (
    approval.status === 'APPROVED'
    && approval.metadata?.riskCategory === params.riskCategory
    && approval.metadata?.grantScope === 'task_risk_category'
  ));
}

export function getDefaultApprovalGrantMetadata(params: {
  approval: ToolApprovalRecord;
  resolutionMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | undefined {
  const riskCategory = params.approval.metadata?.riskCategory;
  const provided = params.resolutionMetadata ?? {};
  if (provided.grantScope === 'single_invocation') {
    return { ...provided };
  }
  if (typeof riskCategory !== 'string' || !riskCategory) {
    return Object.keys(provided).length > 0 ? { ...provided } : undefined;
  }
  return {
    grantScope: 'task_risk_category',
    riskCategory,
    ...provided
  };
}
