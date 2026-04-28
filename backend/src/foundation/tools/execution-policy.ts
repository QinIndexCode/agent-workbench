import { BackendNewConfig } from '../config/types';
import { AgentToolDefinition } from '../extensions/types';

export type ToolPermissionDecision =
  | 'ALLOW'
  | 'REQUIRE_APPROVAL'
  | 'DENY';

export interface ToolExecutionPolicyResult {
  decision: ToolPermissionDecision;
  reason: string;
}

export function evaluateToolExecutionPolicy(params: {
  config: BackendNewConfig;
  tool: AgentToolDefinition;
}): ToolExecutionPolicyResult {
  const mode = params.config.tools.permissionMode;
  const { effect, riskLevel } = params.tool;

  if (mode === 'full') {
    return {
      decision: 'ALLOW',
      reason: 'Tool execution is allowed because permission mode is full.'
    };
  }

  if (mode === 'read-only') {
    if (effect === 'WRITE' || effect === 'NETWORK') {
      return {
        decision: 'DENY',
        reason: `Tool effect "${effect}" is not allowed in read-only mode.`
      };
    }
    return {
      decision: 'ALLOW',
      reason: `Tool effect "${effect}" is allowed in read-only mode.`
    };
  }

  if (effect === 'WRITE' || effect === 'NETWORK' || riskLevel === 'HIGH') {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `Tool requires approval in ask mode because effect="${effect}" and riskLevel="${riskLevel}".`
    };
  }

  return {
    decision: 'ALLOW',
    reason: `Tool is auto-allowed in ask mode because effect="${effect}" and riskLevel="${riskLevel}".`
  };
}
