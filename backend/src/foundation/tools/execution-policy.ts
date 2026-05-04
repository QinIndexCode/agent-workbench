import { BackendNewConfig } from '../config/types';
import { AgentToolDefinition } from '../extensions/types';
import { ToolApprovalRecord } from '../repository';
import {
  classifyToolRiskCategory,
  hasApprovedTaskRiskGrant,
  type ToolRiskCategory
} from './risk-approval-policy';

export type ToolPermissionDecision =
  | 'ALLOW'
  | 'REQUIRE_APPROVAL'
  | 'DENY';

export interface ToolExecutionPolicyResult {
  decision: ToolPermissionDecision;
  reason: string;
  riskCategory: ToolRiskCategory;
  grantMatched: boolean;
}

export function evaluateToolExecutionPolicy(params: {
  config: BackendNewConfig;
  tool: AgentToolDefinition;
  argumentsRecord?: Record<string, unknown>;
  taskApprovals?: ToolApprovalRecord[];
}): ToolExecutionPolicyResult {
  const mode = params.config.tools.permissionMode;
  const { effect, riskLevel } = params.tool;
  const riskCategory = classifyToolRiskCategory({
    tool: params.tool,
    argumentsRecord: params.argumentsRecord
  });
  const grantMatched = hasApprovedTaskRiskGrant({
    approvals: params.taskApprovals ?? [],
    riskCategory
  });

  if (mode === 'full') {
    return {
      decision: 'ALLOW',
      reason: 'Tool execution is allowed because permission mode is full.',
      riskCategory,
      grantMatched: false
    };
  }

  if (mode === 'read-only') {
    if (effect === 'WRITE' || effect === 'NETWORK' || (effect === 'PROCESS' && riskCategory !== 'host_observation')) {
      return {
        decision: 'DENY',
        reason: `Tool risk category "${riskCategory}" is not allowed in read-only mode.`,
        riskCategory,
        grantMatched: false
      };
    }
    return {
      decision: 'ALLOW',
      reason: `Tool risk category "${riskCategory}" is allowed in read-only mode.`,
      riskCategory,
      grantMatched: false
    };
  }

  if (grantMatched) {
    return {
      decision: 'ALLOW',
      reason: `Tool risk category "${riskCategory}" was already approved for this task.`,
      riskCategory,
      grantMatched: true
    };
  }

  if (riskCategory !== 'workspace_read' || effect === 'WRITE' || effect === 'NETWORK' || effect === 'PROCESS' || riskLevel === 'HIGH') {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `Tool requires approval in ask mode because riskCategory="${riskCategory}", effect="${effect}", and riskLevel="${riskLevel}".`,
      riskCategory,
      grantMatched: false
    };
  }

  return {
    decision: 'ALLOW',
    reason: `Tool is auto-allowed in ask mode because riskCategory="${riskCategory}", effect="${effect}", and riskLevel="${riskLevel}".`,
    riskCategory,
    grantMatched: false
  };
}
